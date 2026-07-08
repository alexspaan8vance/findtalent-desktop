/**
 * Candidate-match orchestration (talent → jobs). Ties together:
 *   sync candidate → 8vance talent → run inverse match → normalize results →
 *   classify staffing agencies → persist CandidateMatchRun + CandidateJobMatch.
 *
 * Kept server-only (imports prisma + the 8vance client). UI server-actions and
 * the self-onboard portal call into this.
 */
import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { vanceClientForTenant } from "@/lib/eightvance/tenant-client";
import type { MatchFilters } from "@/lib/eightvance/client";
import type {
  TalentCreatePayload,
  TalentEducation,
  TalentEducationInput,
  TalentExperience,
  TalentExperienceInput,
  TalentLanguage,
  TalentProfile,
  TalentSkill,
} from "@/lib/eightvance/types";
import type { CandidateProfileJson } from "@/lib/candidate/cv-ai";
import {
  buildSuggestions,
  decideSuggestionsStatus,
  type CvProfileLike,
  type EightvanceParseLike,
} from "@/lib/candidate/cv-suggestions";
import type {
  EightvanceEducation,
  EightvanceEmployment,
} from "@/lib/candidate/cv-parser-8vance";
import { VanceError, VanceAuthError, CompanyIdGateError } from "@/lib/eightvance/errors";
import { reportError } from "@/lib/observability/report";
import { notify } from "@/lib/notifications/deliver";
import { buildMatchDataForTalent, parseJobSkills } from "@/lib/match/hydrate";
import {
  normalizeJobMatch,
  mergeExtended,
  matchScoreReliable,
  type NormalizedJobMatch,
} from "./normalize-job";
import {
  effectiveTravelKm,
  highestEduTier,
  type CandidatePreferences,
  type WorkRegion,
} from "./preferences";
import { pLimit } from "@/lib/match/concurrency";
import { computeTravelBucketsMatrix, isOvConfigured, type TravelMode } from "@/lib/travel";
import type { LatLng } from "@/lib/travel/haversine";
import type { TravelBuckets } from "@/lib/anonymize/types";
import {
  classifyJob,
  type AgencyRule,
  type ClassifyOptions,
} from "@/lib/match/staffing";

/**
 * Defensively parse `{latitude, longitude}` (string|number, in any of the
 * 8vance location shapes) into a `LatLng`, or null when either is missing /
 * non-finite. Coords are used transiently for the travel-bucket post-pass and
 * are NEVER persisted (only the coarse bucket labels are).
 */
function parseLatLng(
  loc: Record<string, unknown> | null | undefined,
): LatLng | null {
  if (!loc) return null;
  const lat = Number(loc.latitude);
  const lng = Number(loc.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/**
 * Classify a per-source match failure into a UI-surfaceable reason.
 *  - 413 → feed too large to match synchronously (e.g. public_vacancies_de).
 *  - 403 → the async match variant isn't allowed on these client_credentials.
 *  - status 0 + "did not complete" message → poll budget (timeout) exhausted.
 *  - anything else → generic error.
 */
function classifySkipReason(err: unknown): SkippedSourceReason {
  // CompanyIdGateError extends VanceError with status=403, so it would
  // otherwise be mislabeled 'async_not_allowed' (sending ops to chase
  // credential scopes). It's a tenant allow-list rejection — classify as a
  // generic error (no dedicated 'company_gate' reason in the union). Check it
  // FIRST, before the VanceError status branches below.
  if (err instanceof CompanyIdGateError) return "error";
  if (err instanceof VanceError) {
    if (err.status === 413) return "feed_too_large";
    if (err.status === 403) return "async_not_allowed";
    // runToCompletion throws status 0 with a "did not complete in Ns" message
    // when the poll budget runs out.
    if (err.status === 0 && /did not complete/i.test(err.message)) return "timeout";
  }
  return "error";
}

/**
 * Load admin agency rules (global defaults + this org's overrides) and map to
 * the classifier's AgencyRule shape. Built-in defaults live in staffing.ts;
 * these rows EXTEND them.
 */
export async function loadAgencyRules(
  organizationId: string | null,
): Promise<AgencyRule[]> {
  const rows = await prisma.staffingAgencyRule.findMany({
    where: {
      enabled: true,
      OR: [{ organizationId: null }, { organizationId: organizationId ?? "__none__" }],
    },
    select: { kind: true, pattern: true, label: true, enabled: true },
  });
  return rows.map((r) => ({
    kind: r.kind === "NAME" ? ("name" as const) : ("description" as const),
    pattern: r.pattern,
    label: r.label,
    enabled: r.enabled,
  }));
}

/**
 * Open-market aggregator feeds whose jobs MAY legitimately be staffing-agency
 * postings (JobDigger / public vacancy feeds). A job from the tenant's OWN pool
 * or an ECOSYSTEM-partner source can NEVER be a staffing agency — flagging one
 * is a false positive (reported live: a `tjellens_ecosysteem` own-pool job shown
 * as "Staffing agency"). So agency classification is gated to external feeds
 * only; everything else (own company source + ecosystem feeds) is exempt.
 */
function isExternalFeedSource(source: string | null | undefined): boolean {
  if (!source) return false;
  return /jobdigger|online[_ ]?vacatures|public[_ ]?vacanc|public vacancies|werk\.?nl|indeed|monsterboard|nationale ?vacaturebank/i.test(
    source,
  );
}

/**
 * Order match sources so external OPEN-MARKET / aggregator feeds (JobDigger =
 * `OnlineVacaturesNL`, public_vacancies_*, werk.nl, …) come FIRST, before the
 * per-run source cap can truncate the list. `/talent/{id}/sources/` returns
 * slugs in an UNSTABLE order, so without this a pool with more sources than the
 * cap could silently drop its JobDigger feed depending on where the API listed
 * it (observed: Tjellens has 9 sources incl. `OnlineVacaturesNL`). Stable:
 * feeds before non-feeds, original relative order preserved within each group.
 * Pure + exported for unit-testing the invariant.
 */
export function prioritizeFeedSources(sources: string[]): string[] {
  return sources
    .map((slug, i) => ({ slug, i, feed: isExternalFeedSource(slug) }))
    .sort((a, b) => (a.feed === b.feed ? a.i - b.i : a.feed ? -1 : 1))
    .map((x) => x.slug);
}

export interface RunMatchOptions {
  /** Source slugs to match against, e.g. ["jobdigger"] + the pool source. */
  sources?: string[];
  /** Agency threshold (1 = any single signal flags it). */
  threshold?: number;
  /**
   * Ad-hoc location to centre the (open-market) match on, overriding the
   * candidate's home + desired regions. Set when the recruiter searches a
   * specific city from the match view (e.g. the candidate would relocate to
   * Eindhoven) so the feed match is bounded around THAT city and its jobs
   * surface — not just the home region.
   */
  locationOverride?: { lat: number; lng: number; label?: string };
}

/** Why a source was not matched synchronously. */
export type SkippedSourceReason =
  | "feed_too_large" // 413 — feed too big to match synchronously
  | "async_not_allowed" // 403 — async variant not permitted on these creds
  | "timeout" // match poll budget exhausted
  | "not_attempted" // dropped by the MAX_SOURCES cap (never tried)
  | "filter_required" // large open-market feed skipped: no location to bound the ES set
  | "error"; // any other per-source HTTP/transport failure

export interface SkippedSource {
  slug: string;
  reason: SkippedSourceReason;
}

export interface RunMatchSummary {
  runId: string;
  total: number;
  agencyCount: number;
  /**
   * Sources that were skipped (413/403/timeout) or not attempted (cap). Surfaced
   * so the UI can show "feed X too large to match synchronously". Also persisted
   * onto the run's `sourcesJson` (see executeMatchRun) so a later read can render
   * it without re-running the match.
   */
  skipped: SkippedSource[];
}

/**
 * THE centre a match run is bounded around and measured from — one source of
 * truth for the open-market location filter, the travel-time buckets and the
 * persisted `sourcesJson.centre` the UI reads.
 */
export interface MatchCentre {
  lat: number;
  lng: number;
  label: string | null;
  kind: "relocation" | "region" | "home";
}

/**
 * The candidate's LOCAL home coords: `profileJson.detailed_location` — the
 * EXACT field the match page reads for the map's home marker + city seed
 * (page.tsx `matchOrigin`), parsed with the SAME rules (string|number coords;
 * a 0 coordinate is the geocode-failed sentinel → treated as absent). Exported
 * pure so the "map and matcher agree on whether a home exists" invariant is
 * unit-testable.
 */
export function localHomeCentre(
  profileJson: unknown,
): { lat: number; lng: number; label: string | null } | null {
  const dl = (
    profileJson as {
      detailed_location?: { city?: unknown; latitude?: unknown; longitude?: unknown };
    } | null
  )?.detailed_location;
  if (!dl) return null;
  const lat = dl.latitude != null ? Number(dl.latitude) : NaN;
  const lng = dl.longitude != null ? Number(dl.longitude) : NaN;
  if (!Number.isFinite(lat) || lat === 0 || !Number.isFinite(lng) || lng === 0) return null;
  const label = typeof dl.city === "string" && dl.city.trim() ? dl.city.trim() : null;
  return { lat, lng, label };
}

/**
 * Resolve THE match centre with the honesty-commit precedence:
 *   1. ad-hoc locationOverride (recruiter searched a city — relocation)
 *   2. a geocoded desired work region
 *   3. home — the 8vance-stored talent location, else the LOCAL CV coords
 *      (`localHomeCentre`, the same `profileJson.detailed_location` field the
 *      match page's map marker uses)
 *
 * First PRESENT source wins and is validated in place: an invalid override or
 * region yields null rather than silently retargeting the run at home under a
 * wrong `kind` label. ONLY within the home step does the remote 8vance read
 * fall back to the local CV coords — that fallback is the fix for the live
 * divergence where the map rendered a home marker (local field) while the
 * matcher skipped JobDigger as "candidate has no location" (remote-only read).
 */
export function resolveMatchCentre(opts: {
  override?: { lat: number; lng: number; label?: string };
  regionCentre?: WorkRegion;
  remoteHome?: { latitude?: unknown; longitude?: unknown } | null;
  localHome?: { lat: number; lng: number; label: string | null } | null;
}): MatchCentre | null {
  const { override, regionCentre, remoteHome, localHome } = opts;
  const valid = (lat: number, lng: number) =>
    Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
  if (override) {
    const lat = Number(override.lat);
    const lng = Number(override.lng);
    return valid(lat, lng)
      ? { lat, lng, label: override.label ?? null, kind: "relocation" }
      : null;
  }
  if (regionCentre) {
    const lat = Number(regionCentre.latitude);
    const lng = Number(regionCentre.longitude);
    return valid(lat, lng)
      ? { lat, lng, label: regionCentre.label ?? null, kind: "region" }
      : null;
  }
  const rLat = Number(remoteHome?.latitude);
  const rLng = Number(remoteHome?.longitude);
  if (valid(rLat, rLng)) return { lat: rLat, lng: rLng, label: null, kind: "home" };
  // The 8vance talent has no usable stored location — fall back to the LOCAL
  // CV home (the map's field), so "map shows a home marker ⇒ matcher has a
  // centre" always holds. Label = the CV city (the page already builds
  // home-kind centres with a city label itself, so the shape is expected).
  if (localHome) {
    return { lat: localHome.lat, lng: localHome.lng, label: localHome.label, kind: "home" };
  }
  return null;
}

/**
 * One per-source entry persisted on the run (`sourcesJson.counts`) — the data
 * behind the honest "Open market: N · Own pool: M" line.
 */
export interface SourceCount {
  slug: string;
  n: number;
  isOwnPool: boolean;
  bounded: boolean;
  /**
   * Present when the source did NOT actually run to zero: it was skipped or
   * errored (privilege 401 / 413 too large / timeout / …). Distinguishes "feed
   * ran and found nothing" from "feed broke" — without this a source-level
   * failure renders as an honest-looking "Open market: 0" (live incident
   * 2026-07-08: a feed-privilege 401 silently overwrote a 106-job set).
   */
  skippedReason?: SkippedSourceReason;
}

/**
 * Data-only regression warning persisted on the run (`sourcesJson.warnings`):
 * an external feed that produced jobs on the PREVIOUS finished run but yielded
 * 0 on this one. `reason` tells whether it was skipped/errored (broken source)
 * or genuinely returned nothing (`zero_results`).
 */
export interface SourceRegressionWarning {
  slug: string;
  prevN: number;
  n: 0;
  reason: SkippedSourceReason | "zero_results";
}

/**
 * Build the per-source counts (+ regression warnings vs. the previous run's
 * counts) for a finished match run. Pure + exported for unit tests.
 *
 *  - Every source present on a persisted row is counted.
 *  - Every ATTEMPTED external feed that contributed no rows gets an explicit
 *    `n: 0` entry, tagged with its skip reason when it didn't genuinely run
 *    to zero (see `SourceCount.skippedReason`).
 *  - A feed with `prevN > 0` and `n === 0` now yields a warning so the UI can
 *    say "this source gave N results last time — its 0 is a breakage, not an
 *    empty market" BEFORE the recruiter trusts (or overwrites) the shortlist.
 */
export function buildSourceCounts(opts: {
  /** `source` of each persisted match row (null → own/unknown provenance). */
  rowSources: (string | null)[];
  /** Sources actually attempted this run (post-cap). */
  attempted: string[];
  /** Per-source skip/error records collected during the run. */
  skipped: SkippedSource[];
  hasLocationFilter: boolean;
  /** `sourcesJson.counts` of the previous READY run, when available. */
  prevCounts?: SourceCount[] | null;
}): { counts: SourceCount[]; warnings: SourceRegressionWarning[] } {
  const { rowSources, attempted, skipped, hasLocationFilter, prevCounts } = opts;
  const presentBySource = new Map<string, number>();
  for (const raw of rowSources) {
    const s = raw ?? "(unknown)";
    presentBySource.set(s, (presentBySource.get(s) ?? 0) + 1);
  }
  const counts: SourceCount[] = [...presentBySource.entries()].map(([slug, n]) => ({
    slug,
    n,
    isOwnPool: !isExternalFeedSource(slug),
    bounded: isExternalFeedSource(slug) && hasLocationFilter,
  }));
  const skipReason = new Map(skipped.map((s) => [s.slug.toLowerCase(), s.reason]));
  const presentLc = new Set([...presentBySource.keys()].map((s) => s.toLowerCase()));
  for (const s of attempted) {
    if (isExternalFeedSource(s) && !presentLc.has(s.toLowerCase())) {
      const reason = skipReason.get(s.toLowerCase());
      counts.push({
        slug: s,
        n: 0,
        isOwnPool: false,
        bounded: hasLocationFilter,
        ...(reason ? { skippedReason: reason } : {}),
      });
    }
  }
  // Previously-productive external feed → 0 now: persist the regression fact.
  const prevBySlug = new Map(
    (prevCounts ?? [])
      .filter((c) => c && typeof c.slug === "string" && typeof c.n === "number")
      .map((c) => [c.slug.toLowerCase(), c.n]),
  );
  const warnings: SourceRegressionWarning[] = [];
  for (const entry of counts) {
    if (entry.n !== 0 || entry.isOwnPool) continue;
    const prevN = prevBySlug.get(entry.slug.toLowerCase()) ?? 0;
    if (prevN > 0) {
      warnings.push({
        slug: entry.slug,
        prevN,
        n: 0,
        reason: entry.skippedReason ?? "zero_results",
      });
    }
  }
  return { counts, warnings };
}

/**
 * Why a candidate→8vance talent sync failed, classified from the 8vance error
 * shape so the UI can explain the SPECIFIC cause instead of a generic "sync
 * failed". Carried on `SyncError.reason`.
 *  - auth    — 401/403 (VanceAuthError): the pool's client_credentials are
 *              wrong/expired/lack scope.
 *  - source  — 400 whose body/message mentions the source slug / "does not
 *              exist": the tenant's ownSourceSlug isn't a valid source on the
 *              8vance company.
 *  - company — CompanyIdGateError: the pool's eightvanceCompanyId is outside
 *              this identity's allow-list.
 *  - sync    — any other failure (transport / 5xx / unclassified VanceError).
 */
export type SyncFailureReason = "auth" | "source" | "company" | "sync";

/**
 * Error thrown by `syncCandidateToVance` when `client.talent.create` fails,
 * carrying a classifiable `reason`. The consent / <3-skills guards throw a
 * plain Error (matched by message upstream) and are NOT wrapped here.
 */
export class SyncError extends Error {
  readonly reason: SyncFailureReason;
  constructor(reason: SyncFailureReason, message: string) {
    super(message);
    this.name = "SyncError";
    this.reason = reason;
  }
}

/**
 * Map a thrown 8vance error to a `SyncFailureReason`:
 *  - CompanyIdGateError                       → company
 *  - VanceAuthError / status 401|403          → auth
 *  - status 400 with source/"does not exist"  → source
 *  - everything else                          → sync
 */
function classifyVanceCreateError(err: unknown): SyncFailureReason {
  if (err instanceof CompanyIdGateError) return "company";
  if (err instanceof VanceAuthError) return "auth";
  if (err instanceof VanceError) {
    if (err.status === 401 || err.status === 403) return "auth";
    if (err.status === 400) {
      // The redacted body + message are safe to inspect (no secrets). A 400
      // "Object with name=X does not exist" means the source slug labelled on
      // the talent isn't a valid source on the company.
      const bodyStr =
        typeof err.body === "string" ? err.body : JSON.stringify(err.body ?? "");
      const haystack = `${err.message} ${bodyStr}`.toLowerCase();
      if (/source|does not exist/.test(haystack)) return "source";
    }
  }
  return "sync";
}

/**
 * Create a talent in 8vance from the candidate's stored profile and mark the
 * candidate READY. Idempotent-ish: skips if already synced.
 */
/**
 * Pick the candidate's PRIMARY role title from their work history for
 * function_name resolution: the current role wins, else the most recent (highest
 * startYear), else the first entry that has a title. Returns null when no entry
 * carries a usable title.
 */
function pickPrimaryRoleTitle(experience: TalentExperienceInput[]): string | null {
  const titled = experience.filter(
    (e) => typeof e.title === "string" && e.title.trim().length > 0,
  );
  if (titled.length === 0) return null;
  const current = titled.find((e) => e.current === true);
  if (current?.title) return current.title.trim();
  const byRecency = [...titled].sort(
    (a, b) => (Number(b.startYear) || 0) - (Number(a.startYear) || 0),
  );
  return byRecency[0].title!.trim();
}

/**
 * In-process coalescing for `syncCandidateToVance`: concurrent calls for the
 * SAME candidateId (e.g. the page's after() auto-retry racing the match poller)
 * share ONE in-flight promise so we never POST two 8vance talents for one
 * candidate. Mirrors the `inflight` pattern in cv-ai.ts — keyed by candidateId,
 * deleted in `.finally`. The throw semantics are preserved: the shared promise
 * rejects for every caller exactly as the unwrapped call would.
 */
const syncInflight = new Map<string, Promise<number>>();

export async function syncCandidateToVance(candidateId: string): Promise<number> {
  const pending = syncInflight.get(candidateId);
  if (pending) return pending;
  const promise = syncCandidateToVanceImpl(candidateId).finally(() => {
    syncInflight.delete(candidateId);
  });
  syncInflight.set(candidateId, promise);
  return promise;
}

async function syncCandidateToVanceImpl(candidateId: string): Promise<number> {
  const c = await prisma.candidate.findUnique({ where: { id: candidateId } });
  if (!c) throw new Error("candidate not found");
  if (c.eightvanceTalentId) return c.eightvanceTalentId;
  if (!c.tenantId) throw new Error("candidate has no tenant (pool) configured");

  // GDPR Art.13/14 consent gate: PII must never reach 8vance without the
  // candidate (or, for the recruiter flow, the recruiter on their behalf)
  // having consented to processing + sync. Only NEW syncs are gated — a row
  // that already has an eightvanceTalentId was synced before this gate existed
  // and is grandfathered (handled by the early-return above). This throw is
  // caught by the caller (syncAndMatch swallows it into a 'sync_failed'
  // warning), so a missing consent never crashes the onboarding action.
  if (!c.consentGivenAt) {
    throw new Error("candidate has not given data-processing consent — sync blocked");
  }

  const profile = (c.profileJson ?? {}) as Partial<TalentCreatePayload> & {
    skills?: TalentCreatePayload["skills"];
    // The CV parser stores the rich extracted profile (education + employment +
    // languages + about) under `profileJson.cv` (CandidateProfileJson). The
    // recruiter/portal flow populates this; older candidates may lack it.
    cv?: Partial<CandidateProfileJson>;
    // Recruiter-typed free-text note ("Notes / extra info" on the wizard).
    // Synced to the talent's `about_me` field (precedence over the CV summary).
    note?: string;
  };
  if (!profile.skills || profile.skills.length < 3) {
    throw new Error("candidate profile needs at least 3 skills before sync");
  }

  // ATOMIC single-flight claim (durable, across requests/processes). The
  // in-process coalescing Map only dedupes within ONE process; a SEQUENTIAL
  // second sync that lands after this one's talent.create but before its
  // eightvanceTalentId commit would still create a DUPLICATE 8vance talent
  // (reported live: one candidate → multiple pool talents). Claim the row; a
  // stale claim (>3 min, e.g. a crashed sync) is reclaimable. If we lose the
  // claim, return the id if it has since landed, else bail WITHOUT creating.
  const CLAIM_STALE_MS = 3 * 60 * 1000;
  const claim = await prisma.candidate.updateMany({
    where: {
      id: candidateId,
      eightvanceTalentId: null,
      OR: [{ syncStartedAt: null }, { syncStartedAt: { lt: new Date(Date.now() - CLAIM_STALE_MS) } }],
    },
    data: { syncStartedAt: new Date() },
  });
  if (claim.count !== 1) {
    const fresh = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { eightvanceTalentId: true },
    });
    if (fresh?.eightvanceTalentId) return fresh.eightvanceTalentId;
    throw new Error("candidate sync already in progress");
  }

  // Map the rich CV education/employment onto the talent sub-resource inputs.
  // Best-effort: only fields the CV parser extracts; the client wraps each row
  // in try/catch so an unknown-field 500 never fails the skills/languages sync.
  const cv = profile.cv ?? {};
  const education: TalentEducationInput[] = (cv.education ?? []).map((e) => ({
    degree: e.degree,
    field: e.field,
    institution: e.institution,
    startYear: e.startYear,
    endYear: e.endYear,
  }));
  const experience: TalentExperienceInput[] = (cv.employment ?? []).map((e) => ({
    title: e.title,
    company: e.company,
    startYear: e.startYear,
    endYear: e.endYear,
    current: e.current,
    description: e.description,
  }));

  // "About me" free-text for the talent: the recruiter note wins, else the
  // CV-extracted profile summary (`cv.about`), else omit. Trimmed + capped.
  const ABOUT_ME_MAX = 2000;
  const aboutSource =
    (typeof profile.note === "string" && profile.note.trim()) ||
    (typeof cv.about === "string" && cv.about.trim()) ||
    "";
  const aboutMe = aboutSource ? aboutSource.slice(0, ABOUT_ME_MAX) : undefined;

  const client = await vanceClientForTenant(c.tenantId);
  const tenant = await prisma.tenant.findUnique({
    where: { id: c.tenantId },
    select: { eightvanceCompanyId: true, ownSourceSlug: true },
  });

  // Resolve the candidate's PRIMARY role title → function_name id. A talent with
  // no linked function_name never appears in reverse (job→talent) matching, so
  // without this the candidate is invisible to every project shortlist. Pick the
  // current role, else most-recent, else first titled entry. Best-effort: an
  // unresolved/obscure title just skips the link (talent.create handles undefined).
  const primaryTitle = pickPrimaryRoleTitle(experience);
  let functionNameId: number | undefined;
  if (primaryTitle) {
    try {
      const fn = await client.resources.resolveFunctionName(primaryTitle);
      if (fn) functionNameId = fn.id;
    } catch {
      /* best-effort — talent still syncs, just without the function link */
    }
  }

  let created: { id: number };
  try {
    created = await client.talent.create({
      full_name: c.name,
      // Label the candidate with the pool's own source slug (verified: IVTA uses
      // "instituut_voor_twijfelachtig_advies") so they belong to the own pool.
      source: tenant?.ownSourceSlug ?? profile.source ?? "findtalent",
      company: tenant?.eightvanceCompanyId,
      // Email + phone are mandatory at onboarding (8vance requires a non-null
      // email on talent create), so they're always present here.
      email: c.email,
      phone: c.phone,
      // Recruiter note → talent about_me (falls back to the CV summary).
      about_me: aboutMe,
      skills: profile.skills,
      languages: profile.languages,
      detailed_location: profile.detailed_location ?? null,
      // Best-effort education + work-experience sub-resources (P1-6). Empty arrays
      // are a no-op in the client loop, so candidates without a parsed CV are safe.
      education,
      experience,
      // Links a functional-area so the talent is reverse-matchable (see above).
      functionNameId,
    });
  } catch (err) {
    // Classify the 8vance failure into a precise, UI-surfaceable cause so the
    // user knows WHERE to look (creds vs. source slug vs. company gate) instead
    // of a generic "syncing failed". Log the actual (already-redacted) 8vance
    // message server-side; never log secrets — VanceError.body is redacted.
    const reason = classifyVanceCreateError(err);
    const status = err instanceof VanceError ? err.status : undefined;
    reportError(err, {
      area: "candidate.sync",
      candidateId,
      tenantId: c.tenantId,
      reason,
      status,
      // Already-redacted by VanceError; safe to surface the real cause in logs.
      vanceMessage: err instanceof Error ? err.message : String(err),
    });
    // Release the single-flight claim so a later retry can re-claim (the create
    // failed → no talent exists → eightvanceTalentId is still null).
    await prisma.candidate
      .update({ where: { id: candidateId }, data: { syncStartedAt: null } })
      .catch(() => {});
    throw new SyncError(reason, `8vance talent create failed (${reason})`);
  }

  // Attach the CV to the 8vance talent via POST /talent/{id}/cv-upload/
  // (multipart cv_file; verified live → 202 with our client_credentials). The
  // original upload bytes aren't retained, but the extracted CV text is, so we
  // attach it as a `.txt` (an accepted cv_file extension). reparse=true: run
  // 8vance's OWN parser over the file SERVER-SIDE (async). This is now also the
  // CV-suggestion source — the (reachable) public API parses the CV and
  // populates the talent's sub-resources, which we later read back and diff
  // against the local parse (see generateSuggestionsFromTalent). The old
  // parseCv8vance WebSocket source was unreachable from the deploy (private VPC
  // host). Best-effort: the talent already exists, so a failed upload never
  // sinks sync.
  if (typeof c.cvText === "string" && c.cvText.trim().length > 0) {
    try {
      const safeName = (c.name || "candidate").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 60);
      await client.talent.uploadCv(
        created.id,
        new TextEncoder().encode(c.cvText),
        `${safeName}-cv.txt`,
        { reparse: true, contentType: "text/plain" },
      );
    } catch (err) {
      reportError(err, { area: "candidate.sync.cvUpload", candidateId, talentId: created.id });
    }
  }

  await prisma.candidate.update({
    where: { id: candidateId },
    data: { eightvanceTalentId: created.id, status: "READY" },
  });
  return created.id;
}

/**
 * Best-effort auto re-sync for candidates whose local profile became complete
 * AFTER an initial sync was blocked (e.g. a degraded first CV parse left <3
 * skills, or consent arrived later). Editing a profile does NOT retry the sync,
 * so such a candidate stays `eightvanceTalentId = null` forever; this closes
 * that gap by retrying the sync when — and only when — it would now succeed.
 *
 * NEVER throws (callers fire it off the response path via `after()`). Sync only:
 * no match is triggered here. Eligibility is intentionally STRICT, mirroring the
 * guards inside `syncCandidateToVanceImpl` so we never enter a guaranteed-throw:
 *   - not already synced  (eightvanceTalentId == null), AND
 *   - consent given       (consentGivenAt != null), AND
 *   - >= 3 resolved skills (profileJson.skills, same shape sync reads).
 * The real create still goes through the coalescing guard above, so racing an
 * already-running sync just shares its promise (duplicate-safe).
 */
export async function autoResyncIfEligible(candidateId: string): Promise<void> {
  try {
    const c = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { eightvanceTalentId: true, consentGivenAt: true, profileJson: true },
    });
    if (!c) return;
    if (c.eightvanceTalentId != null) return;
    if (c.consentGivenAt == null) return;
    const skills = (c.profileJson as { skills?: unknown[] } | null)?.skills;
    if (!Array.isArray(skills) || skills.length < 3) return;

    await syncCandidateToVance(candidateId);
  } catch (err) {
    // Best-effort: a still-failing sync (transient 8vance error, source/creds
    // issue) must never surface — the next eligible page visit retries.
    reportError(err, { area: "candidate.autoResync", candidateId });
  }
}

/** Pull the first 4-digit year out of a loose 8vance date string (`YYYY-MM-DD`). */
function yearOf(date: string | null | undefined): string | undefined {
  const m = String(date ?? "").match(/\b(\d{4})\b/);
  return m ? m[1] : undefined;
}

function strOr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}

/**
 * Generate CV-review SUGGESTIONS from 8vance's OWN server-side parse of the CV,
 * read back off the talent's sub-resources. This is the REACHABLE replacement
 * for the old parseCv8vance WebSocket source (`wss://cv-parsing-api.8vance.com`
 * resolves to a PRIVATE VPC IP from the deploy, so it never connected and no
 * suggestions were ever generated).
 *
 * How it works: `syncCandidateToVance` uploads the CV with `reparse=true`, which
 * triggers 8vance's parser SERVER-SIDE (async). Once that completes, the
 * talent's GET /skill/ /education/ /job-experience/ /language/ + profile reflect
 * 8vance's parse. We map those into an `EightvanceParseLike`, diff it against the
 * candidate's stored LOCAL parse (`profileJson.cv`) via the (unchanged)
 * `buildSuggestions` engine, and persist any non-empty result to
 * `cvSuggestionsJson`.
 *
 * Because the reparse is async (~tens of seconds to minutes), this is triggered
 * on each match-page visit (see the page's after()) rather than polled — the
 * first visit AFTER the parse finishes populates the suggestions.
 *
 * NEVER throws (best-effort). Skips when: the candidate isn't synced / has no
 * tenant, OR suggestions already exist (so a recruiter's in-progress review is
 * never regenerated / overwritten).
 */
export async function generateSuggestionsFromTalent(candidateId: string): Promise<void> {
  try {
    const c = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: {
        eightvanceTalentId: true,
        tenantId: true,
        profileJson: true,
        cvSuggestionsJson: true,
      },
    });
    if (!c?.eightvanceTalentId || !c.tenantId) return;
    // Don't regenerate/overwrite: a non-empty diff already exists (a recruiter
    // may be mid-review). Only the FIRST populate runs. Ensure status reflects
    // that suggestions are ready (legacy rows may have a null status).
    if (Array.isArray(c.cvSuggestionsJson) && c.cvSuggestionsJson.length > 0) {
      await prisma.candidate
        .update({ where: { id: candidateId }, data: { cvSuggestionsStatus: "ready" } })
        .catch(() => {});
      return;
    }

    const client = await vanceClientForTenant(c.tenantId);
    const talentId = c.eightvanceTalentId;
    const [skills, education, experience, languages, profile] = await Promise.all([
      client.talent.getSkills(talentId).catch(() => [] as TalentSkill[]),
      client.talent.getEducation(talentId).catch(() => [] as TalentEducation[]),
      client.talent.getExperience(talentId).catch(() => [] as TalentExperience[]),
      client.talent.getLanguages(talentId).catch(() => [] as TalentLanguage[]),
      client.talent.getProfile(talentId).catch(() => null as TalentProfile | null),
    ]);

    // Map the talent sub-resources → EightvanceParseLike (see profile-extras.ts
    // for the verified live field names).
    const evSkills = skills
      .map((s) => strOr((s as Record<string, unknown>).skill_name) ?? strOr((s as Record<string, unknown>).name))
      .filter((s): s is string => !!s);
    const evLanguages = languages
      .map((l) => strOr((l as Record<string, unknown>).language_name))
      .filter((s): s is string => !!s);
    const evEducation: EightvanceEducation[] = education.map((e) => ({
      institution: strOr(e.school) ?? strOr(e.institution),
      degree: strOr(e.degree?.phrase),
      field: strOr(e.education_type),
      startYear: yearOf(e.start_date),
      endYear: yearOf(e.end_date),
    }));
    const evEmployment: EightvanceEmployment[] = experience.map((x) => ({
      title: strOr(x.function_title) ?? strOr(x.title),
      company: strOr(x.company_name),
      startYear: yearOf(x.start_date),
      endYear: yearOf(x.end_date),
      description: strOr(x.description),
    }));
    const p = (profile ?? {}) as Record<string, unknown>;
    const mapped: EightvanceParseLike = {
      skills: evSkills,
      languages: evLanguages,
      education: evEducation,
      employment: evEmployment,
      about: strOr(p.about_me),
      email: strOr(p.email),
      phone: strOr(p.phone),
    };

    // Build the LOCAL baseline the diff compares against. `profileJson.cv` holds
    // the local parse, but on the paste/text path it carries about/education/
    // employment/languages WITHOUT skill-name arrays or phone/email (those live
    // only as taxonomy ids in `profileJson.skills` and as top-level scalars). If
    // we diffed the raw `.cv` alone, every skill we ALREADY synced — plus the
    // phone/email — would look "missing locally" and be proposed as a redundant
    // add/fill. So seed the baseline with what we already pushed:
    //  - skill NAMES for the taxonomy ids in profileJson.skills (resolved from
    //    the readback rows, which carry both `skill` id and `skill_name`), so
    //    only skills the 8vance reparse ADDED surface as suggestions;
    //  - language NAMES the same way (profileJson.languages holds only taxonomy
    //    ids; the local CV stores a localized name like "Nederlands" while the
    //    readback returns "Dutch", so a plain name-diff falsely re-proposes an
    //    already-synced language — match by id and seed the readback name);
    //  - phone/email from the top-level profile.
    const rawCv = ((c.profileJson as { cv?: CvProfileLike } | null)?.cv ?? {}) as CvProfileLike;
    const pjson = (c.profileJson ?? {}) as Record<string, unknown>;
    const syncedSkillIds = new Set(
      (Array.isArray(pjson.skills) ? pjson.skills : [])
        .map((s) => (s as { skill?: unknown }).skill)
        .filter((n): n is number => typeof n === "number"),
    );
    const alreadyLocalSkillNames = skills
      .filter((s) => syncedSkillIds.has(Number((s as Record<string, unknown>).skill)))
      .map((s) => strOr((s as Record<string, unknown>).skill_name) ?? strOr((s as Record<string, unknown>).name))
      .filter((s): s is string => !!s);
    const syncedLangIds = new Set(
      (Array.isArray(pjson.languages) ? pjson.languages : [])
        .map((l) => (l as { language?: unknown }).language)
        .filter((n): n is number => typeof n === "number"),
    );
    const alreadyLocalLangNames = languages
      .filter((l) => syncedLangIds.has(Number((l as Record<string, unknown>).language)))
      .map((l) => strOr((l as Record<string, unknown>).language_name))
      .filter((s): s is string => !!s)
      .map((name) => ({ name }));
    const local: CvProfileLike = {
      ...rawCv,
      knowledge: [...(rawCv.knowledge ?? []), ...alreadyLocalSkillNames],
      languages: [...(rawCv.languages ?? []), ...alreadyLocalLangNames],
      phone: rawCv.phone ?? strOr(pjson.phone),
      email: rawCv.email ?? strOr(pjson.email),
    };
    const suggestions = buildSuggestions(local, mapped);

    // Did 8vance's parse actually surface ANY sub-resource content? If every
    // read is empty the async reparse hasn't landed yet — stay "pending" so the
    // next visit/poll retries. If it DID return content but the diff is empty,
    // the profile is already complete → "none" (a definitive end-state the UI
    // can show, instead of an ambiguous vanishing banner).
    const evSkillN = mapped.skills?.length ?? 0;
    const evEduN = mapped.education?.length ?? 0;
    const evEmpN = mapped.employment?.length ?? 0;
    const evLangN = mapped.languages?.length ?? 0;
    const status = decideSuggestionsStatus(
      suggestions.length,
      evSkillN + evEduN + evEmpN + evLangN,
    );

    // Structured diagnostic: reveals whether the 8vance reparse enriches the
    // talent beyond what onboarding synced (evSkills vs local baseline vs diff).
    // If evSkills never exceeds the synced baseline across visits, the reparse
    // isn't adding sub-resources → a local-parse fallback source is needed.
    console.warn(
      `[cv-suggestions] candidate=${candidateId} talent=${talentId} ` +
        `evSkills=${evSkillN} evEdu=${evEduN} evEmp=${evEmpN} evLang=${evLangN} ` +
        `localSkills=${local.knowledge?.length ?? 0} diff=${suggestions.length} status=${status}`,
    );

    await prisma.candidate.update({
      where: { id: candidateId },
      data: {
        cvSuggestionsStatus: status,
        ...(suggestions.length > 0
          ? { cvSuggestionsJson: suggestions as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
  } catch (err) {
    reportError(err, { area: "candidate.cvSuggestions", candidateId });
    await prisma.candidate
      .update({ where: { id: candidateId }, data: { cvSuggestionsStatus: "error" } })
      .catch(() => {});
  }
}

/**
 * Self-heal a candidate whose linked 8vance talent was DELETED in 8vance (e.g. a
 * recruiter cleaning up duplicate pool talents). The stored `eightvanceTalentId`
 * then points at a dead id: the profile GET 404s so the UI shows "Name missing /
 * 0 skills / not matchable" and matching returns nothing, and — because the row
 * still LOOKS synced — nothing ever re-creates the talent. This unlinks it (clear
 * eightvanceTalentId + back to ONBOARDING) so a subsequent `autoResyncIfEligible`
 * creates a FRESH talent (now with the visibility flags + function-link).
 *
 * ONLY unlinks on a definitive 404 — a transient/auth error leaves the link
 * intact so a blip never nukes a healthy talent. Returns true when it unlinked.
 * Best-effort: never throws.
 */
export async function reconcileTalentLink(candidateId: string): Promise<boolean> {
  try {
    const c = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { eightvanceTalentId: true, tenantId: true },
    });
    if (!c?.eightvanceTalentId || !c.tenantId) return false;
    const client = await vanceClientForTenant(c.tenantId);
    try {
      await client.talent.getProfile(c.eightvanceTalentId);
      return false; // talent still exists — nothing to heal
    } catch (err) {
      if (err instanceof VanceError && err.status === 404) {
        await prisma.candidate.update({
          where: { id: candidateId },
          data: { eightvanceTalentId: null, status: "ONBOARDING", syncStartedAt: null },
        });
        reportError(
          new Error("linked 8vance talent 404 (deleted) — unlinked for re-sync"),
          { area: "candidate.reconcile", candidateId, talentId: c.eightvanceTalentId },
        );
        return true;
      }
      // Non-404 (auth/transient): keep the link; don't nuke on a blip.
      return false;
    }
  } catch (err) {
    reportError(err, { area: "candidate.reconcile", candidateId });
    return false;
  }
}

/**
 * Create a MATCHING run row WITHOUT doing the (slow) match work. Returns the
 * run id. The heavy lifting happens in `executeMatchRun`, off the request path
 * — matching big external feeds can take minutes and must never block the
 * onboarding server action (it would orphan the run when the request is killed).
 */
export async function createMatchRun(
  candidateId: string,
  opts: RunMatchOptions = {},
): Promise<string> {
  const c = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: { id: true, eightvanceTalentId: true, tenantId: true },
  });
  if (!c) throw new Error("candidate not found");
  if (!c.eightvanceTalentId) throw new Error("candidate not synced to 8vance yet");
  if (!c.tenantId) throw new Error("candidate has no tenant configured");

  const run = await prisma.candidateMatchRun.create({
    data: {
      candidateId,
      sourcesJson: opts.sources ?? [],
      filtersJson:
        opts.threshold !== undefined || opts.locationOverride
          ? ({
              ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
              ...(opts.locationOverride ? { locationOverride: opts.locationOverride } : {}),
            } as Prisma.InputJsonValue)
          : undefined,
      status: "MATCHING",
    },
    select: { id: true },
  });
  return run.id;
}

/**
 * Execute a previously-created MATCHING run: inverse-match per source, enrich +
 * classify, persist jobs, flip to READY/FAILED. Atomically CLAIMS the run
 * (taskId marker) so a double-trigger (e.g. two poller mounts) can't run it
 * twice. Safe to call from a background route with its own time budget.
 */
export async function executeMatchRun(runId: string): Promise<RunMatchSummary> {
  // Atomic claim: only proceed if the run is still MATCHING + unclaimed.
  const claim = await prisma.candidateMatchRun.updateMany({
    where: { id: runId, status: "MATCHING", taskId: null },
    data: { taskId: "running" },
  });
  if (claim.count !== 1) {
    return { runId, total: 0, agencyCount: 0, skipped: [] }; // already running/finished
  }

  const run = await prisma.candidateMatchRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error("run not found");
  const c = await prisma.candidate.findUnique({ where: { id: run.candidateId } });
  if (!c || !c.eightvanceTalentId || !c.tenantId) {
    await prisma.candidateMatchRun.update({
      where: { id: runId },
      data: { status: "FAILED", completedAt: new Date() },
    });
    throw new Error("candidate not matchable");
  }
  // sourcesJson is written as a plain string[] by createMatchRun, but on
  // completion we REWRITE it to `{sources, skipped}` (no new prisma column).
  // Tolerate both shapes on read so a re-execute of a finished run still works.
  const rawSources = run.sourcesJson;
  const sources: string[] = Array.isArray(rawSources)
    ? (rawSources as string[])
    : rawSources && typeof rawSources === "object" && Array.isArray((rawSources as { sources?: unknown }).sources)
      ? ((rawSources as { sources: string[] }).sources)
      : [];
  const filters = run.filtersJson as
    | { threshold?: number; locationOverride?: { lat: number; lng: number; label?: string } }
    | null;
  const threshold = filters?.threshold;
  const opts: RunMatchOptions = {
    sources,
    threshold,
    locationOverride: filters?.locationOverride,
  };

  try {
    const client = await vanceClientForTenant(c.tenantId);
    // The tenant's own 8vance company — own-pool jobs (same company) are exempt
    // from staffing-agency classification (see the row build below).
    const ownCompanyId = client.companyId;

    // Discover the talent's real match sources (own pool + enabled external
    // feeds like OnlineVacaturesNL / public_vacancies_de + ecosystem). The
    // public API has no source catalog and an unfiltered sources:[] match can
    // 413 on big feeds, so we match PER-SOURCE and merge.
    let available: string[] = [];
    try {
      available = await client.talent.getSources(c.eightvanceTalentId);
    } catch {
      // ignore — fall back to a single all-sources match below
    }
    // Which sources to actually match: the candidate's selected slugs that are
    // genuinely available; else everything available. If the catalog is empty
    // (older API / no scope), fall back to one sources:[] match.
    const requested = (opts.sources ?? []).filter((s) => available.includes(s));
    const rawTargets = requested.length > 0 ? requested : available;
    // Order the sources so external OPEN-MARKET / aggregator feeds (JobDigger =
    // `OnlineVacaturesNL`, public_vacancies_*, werk.nl, indeed, …) are matched
    // FIRST — before the MAX_SOURCES cap can truncate the list. `talent/{id}/
    // sources/` returns the slugs in an UNSTABLE order, so without this a pool
    // with >8 sources could silently drop its JobDigger feed depending on where
    // the API happened to list it (observed live: Tjellens has 9 sources incl.
    // `OnlineVacaturesNL` — a single ordering change would push it past the cap
    // and make all open-market vacancies vanish from the shortlist). Stable sort:
    // feeds before non-feeds, original order preserved within each group.
    const targets = prioritizeFeedSources(rawTargets);
    // Cap concurrent feeds matched to keep wall-clock + rate-limit sane. When
    // the cap truncates the list, the dropped slugs are NOT silently lost — they
    // are recorded as `not_attempted` so the UI/logs can surface the truncation.
    // With feeds sorted first, only lower-value own/ecosystem sources can be cut.
    const MAX_SOURCES = 8;
    const attempted = targets.slice(0, MAX_SOURCES);
    const notAttempted = targets.slice(MAX_SOURCES);

    const skipped: SkippedSource[] = notAttempted.map((slug) => ({
      slug,
      reason: "not_attempted" as const,
    }));
    if (notAttempted.length > 0) {
      console.warn(
        `[candidate-match] talent ${c.eightvanceTalentId}: source cap (${MAX_SOURCES}) reached — not attempted: ${notAttempted.join(", ")}`,
      );
    }

    // Build a BOUNDED match filter (location + function keyword). Large
    // open-market feeds (JobDigger `OnlineVacaturesNL`, `public_vacancies_*`,
    // ~25k jobs) MUST be matched with a location filter: an unfiltered match on
    // such a feed pushes 800k+ docs through ElasticSearch, times out at the 60s
    // gateway, and — verified live 2026-07-06 — spiked PROD ES to 100% CPU,
    // slowing the whole talent pool. A small radius + the talent's function term
    // shrinks the ES candidate set so the match returns in seconds. Best-effort:
    // both reads tolerate missing data (a talent with no location can't match
    // large feeds — those are skipped as `filter_required` below).
    // Travel radius: honour the candidate's captured preference, else fall back
    // to the education-level heuristic (higher-educated candidates commute
    // further), else the global default. Clamped into the ES-safe range so a
    // large open-market feed is never bounded unsafely (see preferences.ts).
    const cPrefs = (c.preferencesJson ?? null) as Partial<CandidatePreferences> | null;
    const cProfile = (c.profileJson ?? {}) as {
      education?: Array<{ degree?: string | null }>;
      cv?: { education?: Array<{ degree?: string | null }> };
    };
    const cEduTier = highestEduTier(cProfile.education ?? cProfile.cv?.education);
    const OPEN_MARKET_RADIUS_KM = effectiveTravelKm(cPrefs, cEduTier);
    // A geocoded desired WORK REGION overrides the home location as the match
    // centre — the candidate wants to work THERE, which may differ from where
    // they live. First region with coords wins; else we fall back to home.
    const regionCentre = (cPrefs?.workRegions ?? []).find(
      (r) =>
        typeof r?.latitude === "number" &&
        typeof r?.longitude === "number" &&
        Number.isFinite(r.latitude) &&
        Number.isFinite(r.longitude),
    );
    // Precedence for the open-market match centre (see resolveMatchCentre):
    //   1. ad-hoc locationOverride (recruiter searched a city — relocation)
    //   2. a geocoded desired work region
    //   3. home: the 8vance talent location, else the LOCAL CV coords
    //      (profileJson.detailed_location — the SAME field the match page uses
    //      for the map's home marker, so the matcher's "has a location" answer
    //      can never disagree with the map rendering one; live bug 2026-07-08:
    //      map showed Enschede while JobDigger was skipped "no location").
    // The SAME centre is the single source of truth for the location bound AND
    // the travel-time buckets below (so a relocation run's map/travel reflect the
    // searched city, not home) AND is persisted so the UI can show where it ran.
    const override = opts.locationOverride;
    const localHome = localHomeCentre(c.profileJson);
    let matchCentre: MatchCentre | null = null;
    let matchFilters: MatchFilters | undefined;
    try {
      // The remote 8vance location is only relevant on the HOME path, and a
      // missing/failing remote read must NOT abort centre resolution — the
      // local CV coords can still centre the match (.catch → null).
      const remoteHome =
        override || regionCentre
          ? null
          : await client.talent.getLocation(c.eightvanceTalentId).catch(() => null);
      matchCentre = resolveMatchCentre({ override, regionCentre, remoteHome, localHome });
      if (matchCentre) {
        // Bound large open-market feeds by LOCATION ONLY. We used to also add the
        // talent's primary function as a hard `keywords.include` term, but that
        // over-filters JobDigger to ZERO for any specific function whose exact
        // phrase isn't literally in the job titles (verified live: talent 640701254
        // "Ontwerper pijpleidingsystemen" → 0 WITH the keyword vs 140 WITHOUT, at
        // the same 50km bound). The location bound alone keeps the ES candidate
        // set small (≈140 rows in ~28s, under the 60s gateway — no spike), and
        // 8vance scores/ranks the results against the full talent profile anyway.
        matchFilters = {
          location: {
            lat: matchCentre.lat,
            lng: matchCentre.lng,
            radius: OPEN_MARKET_RADIUS_KM,
            radius_unit: "km",
          },
        };
      }
    } catch {
      // best-effort — without a filter, large feeds are guarded out below
    }
    const hasLocationFilter = !!matchFilters?.location;

    // Split the capped targets: large open-market feeds vs. everything else.
    const largeFeeds = attempted.filter((s) => isExternalFeedSource(s));
    const otherFeeds = attempted.filter((s) => !isExternalFeedSource(s));

    // Large feeds are only matched WITH a location filter; without one we must
    // NOT run them (that is the unbounded match that took down PROD ES) — record
    // them as `filter_required` so the UI can tell the recruiter to add a
    // location instead of showing a misleading empty result.
    const matchableLarge = hasLocationFilter ? largeFeeds : [];
    if (!hasLocationFilter) {
      for (const slug of largeFeeds) skipped.push({ slug, reason: "filter_required" });
    }

    // The unfiltered `[]` default pass matches the talent's FULL source set —
    // which INCLUDES any large open-market feed and is therefore unbounded. Only
    // use it when NO large feed is enabled on the talent (small pools whose own
    // source holds no jobs rely on `[]`). When a large feed IS present we match
    // each source explicitly: small feeds unfiltered, large feeds location-bound.
    const anyLargeAvailable = available.some((s) => isExternalFeedSource(s));
    const matchSlugs: (string | [])[] = [
      ...(anyLargeAvailable ? [] : [[] as []]),
      ...otherFeeds,
      ...matchableLarge,
    ];
    // Diagnostic: surface what the talent could match against (helps explain a
    // genuinely-empty result — e.g. a pool with no vacancy feeds at all).
    console.warn(
      `[candidate-match] talent ${c.eightvanceTalentId}: available sources=[${available.join(", ") || "(none)"}], location filter=${hasLocationFilter ? "yes" : "NO"}, matching=[${matchSlugs.map((s) => (Array.isArray(s) ? "(default)" : s)).join(", ") || "(none)"}]${matchableLarge.length ? ` (large feeds bounded to ${OPEN_MARKET_RADIUS_KM}km)` : ""}`,
    );

    // Match every source CONCURRENTLY (bounded) instead of sequentially: up to
    // 9 feeds × runToCompletion (each itself a poll loop) used to run one after
    // another for minutes of wall-clock. pLimit(3) keeps us well under the
    // 55/min/bucket rate-limit while collapsing the latency. Each task returns
    // its OWN normalized rows (no shared Map writes during the parallel phase),
    // and we merge them — highest score per jobId — AFTER all awaits, so the
    // dedup is single-threaded and identical to the old sequential behaviour.
    const limit = pLimit(3);
    const perSource = await Promise.all(
      matchSlugs.map((slug) =>
        limit(async (): Promise<ReturnType<typeof normalizeJobMatch>[]> => {
          const srcArg = Array.isArray(slug) ? [] : [slug];
          // Only large open-market feeds get the bounded location/keyword filter.
          // Own-pool + ecosystem feeds stay unfiltered so a talent's location
          // never wrongly excludes nearby own-company jobs.
          const useFilters =
            typeof slug === "string" && isExternalFeedSource(slug) ? matchFilters : undefined;
          try {
            const part = await client.matchJobs.runToCompletion(c.eightvanceTalentId!, srcArg, {
              filters: useFilters,
            });
            // The slug this batch was matched under — the FEED the job came from.
            const slugName = typeof slug === "string" ? slug : null;
            const rows: ReturnType<typeof normalizeJobMatch>[] = [];
            for (const r of part) {
              const n = normalizeJobMatch(r);
              if (!Number.isFinite(n.jobId) || n.jobId <= 0) continue;
              // Tag provenance: the basic match row almost never carries `source`,
              // and only the top-N get /extended/ enrichment — so the per-source
              // slug is the ONLY reliable feed attribution for the 85%+ of rows we
              // never enrich. The unfiltered `[]` default pass can't name a slug,
              // so it leaves `source` untouched (filled later via dedup/enrich).
              if (slugName && !n.source) n.source = slugName;
              rows.push(n);
            }
            return rows;
          } catch (err) {
            // Catch PER SOURCE so one bad feed never aborts the whole run. Classify
            // the failure so the UI can explain it (413 = feed too large to match
            // synchronously; 403 = async variant not allowed on these creds;
            // timeout = poll budget exhausted; else generic error). The unfiltered
            // `[]` sentinel can't be named as a slug, so we only record string slugs.
            if (typeof slug === "string") {
              skipped.push({ slug, reason: classifySkipReason(err) });
            }
            console.warn(
              `[candidate-match] talent ${c.eightvanceTalentId}: source "${
                typeof slug === "string" ? slug : "(default)"
              }" skipped (${classifySkipReason(err)})`,
            );
            return [];
          }
        }),
      ),
    );

    // Merge after the parallel phase: single-threaded, so no concurrent Map
    // writes. Keep the highest-scoring instance if a job appears in >1 source.
    const rawById = new Map<number, ReturnType<typeof normalizeJobMatch>>();
    for (const rows of perSource) {
      for (const n of rows) {
        const prev = rawById.get(n.jobId);
        if (!prev) {
          rawById.set(n.jobId, n);
          continue;
        }
        // Keep the highest score, but never drop a known feed: if the winning
        // instance came from the unnamed `[]` pass (source null) while the other
        // carries a slug, graft the source on so provenance survives the dedup.
        const winner = n.score > prev.score ? n : prev;
        const other = winner === n ? prev : n;
        if (!winner.source && other.source) winner.source = other.source;
        rawById.set(n.jobId, winner);
      }
    }

    const rules = await loadAgencyRules(c.organizationId);
    const classifyOpts: ClassifyOptions = { rules, threshold: opts.threshold };

    const normalized = [...rawById.values()];

    // Enrich the top-N by score via /job/{id}/extended/ to obtain description
    // + source + hiring-company (intermediary) — the basic match row lacks
    // those. Bounded to respect the per-endpoint rate limit; best-effort so a
    // failed enrichment never sinks the run (we still have employer-name).
    // Guard against a non-numeric env value (Number('x') → NaN → slice(0,NaN)
    // returns [] → zero enrichments silently).
    const enrichLimitRaw = Number(process.env.CANDIDATE_MATCH_ENRICH_LIMIT);
    const enrichLimit = Number.isFinite(enrichLimitRaw) && enrichLimitRaw > 0 ? enrichLimitRaw : 40;
    const byScore = [...normalized].sort((a, b) => b.score - a.score);
    const toEnrich = byScore.slice(0, enrichLimit);
    const enriched = new Map<number, NormalizedJobMatch>();

    // Real graded score (as a 0..100 PERCENT) fetched from `/match/specific/`
    // for the top-N rows whose LIST score is the degenerate cross-company `1`
    // sentinel (fake 100%). Without this the list keeps showing the fake score
    // until each card is expanded; here we resolve the true score up-front for a
    // BOUNDED head of the list so it re-sorts on real quality. Skipped for
    // own-pool / already-reliable rows (their list score is genuine) and capped
    // hard via CANDIDATE_MATCH_REALSCORE_TOPN (0 disables) so we never fan the
    // per-pair endpoint out over the whole result set (181 pairs = too heavy).
    const realScoreByJob = new Map<number, number>();
    const realScoreTopNRaw = Number(process.env.CANDIDATE_MATCH_REALSCORE_TOPN);
    const realScoreTopN = Number.isFinite(realScoreTopNRaw) && realScoreTopNRaw >= 0
      ? realScoreTopNRaw
      : 15;
    const realScoreTargets =
      realScoreTopN > 0 && c.eightvanceTalentId != null
        ? new Set(
            byScore
              .filter((n) => !matchScoreReliable(n.employerCompanyId, ownCompanyId, n.score))
              .slice(0, realScoreTopN)
              .map((n) => n.jobId),
          )
        : new Set<number>();
    // Transient job coords pulled from /extended/ (detailed_location/location),
    // keyed by jobId. Used ONLY for the travel-bucket post-pass below; never
    // persisted. Most external jobs have no coords → simply absent.
    const coordsByJob = new Map<number, LatLng>();
    const CONC = 6;
    for (let i = 0; i < toEnrich.length; i += CONC) {
      const batch = toEnrich.slice(i, i + CONC);
      await Promise.all(
        batch.map(async (n) => {
          try {
            // Pass the talent id as `context` — required to unlock detail for
            // external-feed (JobDigger) jobs (404s without it). This is what
            // makes the staffing-agency filter work on JobDigger vacancies.
            const ext = await client.job.getExtended(n.jobId, c.eightvanceTalentId ?? undefined);
            enriched.set(n.jobId, mergeExtended(n, ext));
            const coords = parseLatLng(ext.detailed_location) ?? parseLatLng(ext.location);
            if (coords) coordsByJob.set(n.jobId, coords);
          } catch {
            // keep the un-enriched row
          }
          // Resolve the REAL graded score for a degenerate top-N row via the
          // per-pair gap analysis (works cross-company where /match/job/ can't
          // grade). Separate try so it never affects the /extended/ enrichment.
          if (realScoreTargets.has(n.jobId) && c.eightvanceTalentId != null) {
            try {
              const gap = await client.job.getGapAnalysis(n.jobId, c.eightvanceTalentId);
              if (typeof gap.match_result?.score === 'number') {
                // `/match/specific/` returns 0..1 — persist as a 0..100 percent
                // so it sorts on the same scale as own-pool / ecosystem scores.
                realScoreByJob.set(n.jobId, gap.match_result.score * 100);
              }
            } catch {
              // Real score unavailable → the row keeps the degenerate list score
              // and stays flagged unreliable (resolved later on card-expand).
            }
          }
        }),
      );
    }

    // Coarse travel-time buckets from the candidate's origin to each enriched
    // job that has coords. Best-effort: any failure here must NEVER sink the run
    // (mirrors hydrate.ts's attachTravelBuckets). Coords flow transiently only;
    // we persist bucket labels (lt15/…/gt60/null) onto the row payload below.
    const travelByJob = new Map<number, TravelBuckets>();
    try {
      // Travel buckets are measured from the SAME centre the match ran around
      // (relocation city / work region / home) — never a plain home lookup —
      // so a relocation run's travel colours reflect the searched city.
      const origin = matchCentre
        ? { lat: matchCentre.lat, lng: matchCentre.lng }
        : parseLatLng(await client.talent.getLocation(c.eightvanceTalentId));
      // No origin coords → skip travel entirely (rows keep no `travel`).
      if (origin && coordsByJob.size > 0) {
        // car/bike always; add 'ov' ONLY when an OV source is configured —
        // otherwise the OV chip stays hidden (no row gets an ov bucket).
        const modes: TravelMode[] = isOvConfigured()
          ? ["car", "bike", "ov"]
          : ["car", "bike"];
        const withCoords = [...coordsByJob.entries()];
        const buckets = await computeTravelBucketsMatrix(
          origin,
          withCoords.map(([, ll]) => ll),
          modes,
        );
        withCoords.forEach(([jobId], i) => {
          const b = buckets[i];
          if (b) travelByJob.set(jobId, b);
        });
      }
    } catch (err) {
      // Travel is a best-effort enrichment — never let it fail the match.
      reportError(err, { area: "candidate.match", phase: "travel" });
    }

    let agencyCount = 0;
    const rows = normalized.map((base) => {
      const enrichedRow = enriched.get(base.jobId) ?? base;
      // Fold the coarse travel buckets into the persisted payload (bucket labels
      // only). Absent when the job had no coords / origin was unknown = unknown.
      const travel = travelByJob.get(enrichedRow.jobId);
      // Persist the job's coords (when /extended/ gave them) so the match view
      // can plot jobs on a map. Only the enriched top-N carry coords.
      const coords = coordsByJob.get(enrichedRow.jobId);
      const n = {
        ...enrichedRow,
        ...(travel ? { travel } : {}),
        ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
      };
      const verdict = classifyJob(
        {
          employerName: n.employerName,
          description: n.description,
          contractType: n.contractType,
          isIntermediary: n.isIntermediary,
        },
        classifyOpts,
      );
      // Own-pool + ecosystem jobs are NEVER staffing agencies — only EXTERNAL
      // open-market feeds (JobDigger etc.) can be. A job is own-origin when it
      // comes from the tenant's own 8vance company OR its source isn't an
      // external aggregator feed. Gate the agency verdict on that so an own-pool
      // vacancy is never hidden as an "agency" (reported live).
      const ownOrigin =
        (n.employerCompanyId != null && n.employerCompanyId === ownCompanyId) ||
        !isExternalFeedSource(n.source);
      const isAgency = verdict.isAgency && !ownOrigin;
      if (isAgency) agencyCount += 1;
      // Prefer the REAL graded score when we resolved it up-front for a
      // degenerate top-N row (percent scale); that row is then reliable and
      // sorts on its true quality instead of the fake 100%.
      const realScore = realScoreByJob.get(n.jobId);
      // Reliable when own-pool OR the score isn't the degenerate `1` sentinel —
      // so real source-match scores (ecosystem jobs, e.g. 19.97) show
      // immediately instead of being hidden as "–". See matchScoreReliable.
      const scoreReliable =
        realScore != null ||
        matchScoreReliable(n.employerCompanyId, ownCompanyId, n.score);
      return {
        runId: run.id,
        eightvanceJobId: n.jobId,
        score: realScore ?? n.score,
        scoreReliable,
        title: n.title,
        employerName: n.employerName,
        employerCompanyId: n.employerCompanyId,
        source: n.source,
        contractType: n.contractType,
        locationCity: n.locationCity,
        locationLabel: n.locationLabel,
        isStaffingAgency: isAgency,
        agencyScore: verdict.score,
        agencyReasonsJson: verdict.reasons as unknown as Prisma.InputJsonValue,
        // Default-hide agencies; the UI toggle can reveal them.
        hiddenByFilter: isAgency,
        payloadJson: n as unknown as Prisma.InputJsonValue,
      };
    });

    if (rows.length > 0) {
      await prisma.candidateJobMatch.createMany({ data: rows });
    }

    // Per-source result counts so the UI can be HONEST about where jobs came
    // from — e.g. "open market: 0 near Eindhoven · own pool: 6 (regardless of
    // location)". Own-pool/ecosystem sources are never location-bounded, so a
    // relocation run's own-pool jobs are NOT near the searched city. Attempted
    // external feeds that contributed no rows get an explicit `n: 0` entry,
    // tagged with a `skippedReason` when the feed didn't genuinely run to zero
    // (errored / privilege 401 / timeout) — see buildSourceCounts.
    //
    // Cheap source-regression guard (DATA only): compare against the PREVIOUS
    // finished run's counts. A feed that produced jobs last run but yields 0
    // now — live incident 2026-07-08: a /match/job/ feed-privilege 401 turned
    // a 106-job shortlist into "Open markt: 0" twice and the recruiter had no
    // way to tell breakage from an empty market — is persisted as a warning
    // BEFORE anyone trusts (or overwrites their read of) the new set.
    // Best-effort: a failed previous-run read just means no warnings.
    // TODO UI: match-client owns rendering — surface `sourcesJson.warnings`
    // ({slug, prevN, n, reason}) as a banner ("bron X gaf vorige keer N
    // resultaten, nu 0 — reden") on the match view.
    let prevCounts: SourceCount[] | null = null;
    try {
      const prevRun = await prisma.candidateMatchRun.findFirst({
        where: { candidateId: c.id, status: "READY", id: { not: run.id } },
        orderBy: { completedAt: "desc" },
        select: { sourcesJson: true },
      });
      const prevRaw = prevRun?.sourcesJson;
      prevCounts =
        prevRaw &&
        typeof prevRaw === "object" &&
        !Array.isArray(prevRaw) &&
        Array.isArray((prevRaw as { counts?: unknown }).counts)
          ? ((prevRaw as unknown as { counts: SourceCount[] }).counts)
          : null;
    } catch {
      // best-effort — the guard degrades to "no warnings", never fails the run
    }
    const { counts, warnings } = buildSourceCounts({
      rowSources: rows.map((r) => r.source),
      attempted,
      skipped,
      hasLocationFilter,
      prevCounts,
    });

    await prisma.candidateMatchRun.update({
      where: { id: run.id },
      data: {
        status: "READY",
        completedAt: new Date(),
        // Persist skipped/not-attempted sources + per-source counts + source-
        // regression warnings + the match CENTRE (relocation city / region /
        // home) onto the EXISTING sourcesJson column (no new prisma column /
        // migration). The read path tolerates both the plain-array and this
        // object shape.
        sourcesJson: {
          sources,
          skipped,
          counts,
          warnings,
          centre: matchCentre,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    // Notify the candidate's owner that the match finished (in-app; honours the
    // user's prefs). Best-effort — notify() never throws, and a public applicant
    // (sentinel creator) has no real user to notify.
    if (c.createdByUserId && c.createdByUserId !== "__public_apply__") {
      void notify({
        userId: c.createdByUserId,
        type: "new_match",
        payload: {
          kind: "candidate",
          candidateId: c.id,
          candidateName: c.name,
          total: rows.length,
        },
      });
    }

    return { runId: run.id, total: rows.length, agencyCount, skipped };
  } catch (err) {
    await prisma.candidateMatchRun.update({
      where: { id: run.id },
      data: { status: "FAILED", completedAt: new Date() },
    });
    throw err;
  }
}

/**
 * Convenience: create + execute in one call. Use ONLY where blocking is
 * acceptable (tests, scripts) — NOT in a request/server-action path (use
 * createMatchRun + a background route instead).
 */
export async function runCandidateMatch(
  candidateId: string,
  opts: RunMatchOptions = {},
): Promise<RunMatchSummary> {
  const runId = await createMatchRun(candidateId, opts);
  return executeMatchRun(runId);
}

/**
 * WORKAROUND for 8vance's lagging reverse (job→talent) match index: a
 * freshly-onboarded candidate won't show up in a matching project's shortlist
 * until that index catches up — but the forward (talent→jobs) match is LIVE. So
 * we take this candidate's LATEST completed forward run, map each matched job
 * back to any findtalent project (same org + same tenant) whose pool targets
 * that 8vance job, and inject an anonymized `Match` row for the candidate using
 * the live forward score. The candidate therefore appears in those shortlists
 * immediately; the next real reverse-match hydrate simply overwrites the row.
 *
 * STRICT SCOPING: only the candidate's OWN organization + OWN tenant pools are
 * touched (mirrors the shortlist page's access). Best-effort throughout — a
 * single project/talent failure is reported and skipped, never thrown. Returns
 * the number of Match rows upserted.
 */
export async function injectForwardMatchesIntoProjects(
  candidateId: string,
): Promise<number> {
  try {
    const candidate = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { eightvanceTalentId: true, tenantId: true, organizationId: true },
    });
    if (!candidate?.eightvanceTalentId || !candidate.tenantId) return 0;
    const talentId = candidate.eightvanceTalentId;
    const tenantId = candidate.tenantId;

    // Latest COMPLETED forward run for this candidate (ProjectStatus.READY).
    const run = await prisma.candidateMatchRun.findFirst({
      where: { candidateId, status: "READY" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!run) return 0;

    const jobMatches = await prisma.candidateJobMatch.findMany({
      where: { runId: run.id },
      select: { eightvanceJobId: true, score: true },
    });
    if (jobMatches.length === 0) return 0;

    // Best forward score per job id (a job can appear via >1 source).
    const scoreByJob = new Map<number, number>();
    for (const jm of jobMatches) {
      const prev = scoreByJob.get(jm.eightvanceJobId);
      if (prev === undefined || jm.score > prev) scoreByJob.set(jm.eightvanceJobId, jm.score);
    }
    const jobIds = [...scoreByJob.keys()];
    if (jobIds.length === 0) return 0;

    // Map matched job ids → findtalent projects, scoped to the candidate's OWN
    // org + OWN tenant (no cross-org/tenant leak).
    const pools = await prisma.projectPool.findMany({
      where: {
        eightvanceJobId: { in: jobIds },
        tenantId,
        project: { organizationId: candidate.organizationId },
      },
      select: {
        projectId: true,
        tenantId: true,
        eightvanceJobId: true,
        project: { select: { skillsJson: true } },
      },
    });
    if (pools.length === 0) return 0;

    const client = await vanceClientForTenant(tenantId).catch((err) => {
      reportError(err, { area: "candidate.forwardInject", candidateId });
      return null;
    });
    if (!client) return 0;

    let upserted = 0;
    for (const pool of pools) {
      try {
        if (pool.eightvanceJobId == null) continue;
        const score = scoreByJob.get(pool.eightvanceJobId) ?? null;
        const jobSkills = parseJobSkills(pool.project.skillsJson);
        const data = await buildMatchDataForTalent(
          client,
          talentId,
          pool.projectId,
          pool.tenantId,
          jobSkills,
          score,
        );
        await prisma.match.upsert({
          where: {
            projectId_tenantId_eightvanceTalentId: {
              projectId: pool.projectId,
              tenantId: pool.tenantId,
              eightvanceTalentId: talentId,
            },
          },
          create: data,
          update: {
            score: data.score,
            anonymizedPayloadJson: data.anonymizedPayloadJson,
            skillGapJson: data.skillGapJson,
            fetchedAt: data.fetchedAt,
            expiresAt: data.expiresAt,
          },
        });
        upserted += 1;
      } catch (err) {
        reportError(err, {
          area: "candidate.forwardInject",
          candidateId,
          projectId: pool.projectId,
        });
      }
    }
    return upserted;
  } catch (err) {
    reportError(err, { area: "candidate.forwardInject", candidateId });
    return 0;
  }
}

/**
 * Minutes after which a still-MATCHING run is considered orphaned and swept to
 * FAILED. Kept BELOW the match-client poller's total budget (~7.85 min: see
 * MatchPoller cadence) so a wedged run is flipped to FAILED while the poller is
 * STILL polling — the next tick then sees `settled:true` and refreshes, instead
 * of the poller giving up at its cap first and leaving the UI spinning forever
 * on a run that never settled.
 */
const STALE_RUN_MINUTES = 6;

/**
 * Recover orphaned runs: mark any run still MATCHING past the staleness window
 * as FAILED. Called on read (match-status route) so a killed background job
 * never leaves the UI polling forever.
 */
export async function sweepStaleRuns(candidateId?: string): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_RUN_MINUTES * 60 * 1000);
  const res = await prisma.candidateMatchRun.updateMany({
    where: {
      status: "MATCHING",
      createdAt: { lt: cutoff },
      ...(candidateId ? { candidateId } : {}),
    },
    data: { status: "FAILED", completedAt: new Date() },
  });
  return res.count;
}
