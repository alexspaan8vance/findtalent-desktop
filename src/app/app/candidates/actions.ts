'use server';

/**
 * Candidate-onboarding server actions (talent → jobs, the inverse of the
 * employer project→talent flow).
 *
 * Two entry points create/refresh a candidate:
 *   - createCandidateAction — recruiter-driven, requires an authed user + org.
 *   - submitPortalOnboardingAction — PUBLIC self-onboard via a magic-link token;
 *     NO auth, the candidate is resolved by its (valid, unexpired) portalToken.
 *
 * Both build a `profileJson` matching `TalentCreatePayload`, a free-form
 * `preferencesJson`, then sync the candidate to 8vance and kick off an inverse
 * match. Sync/match are wrapped so a downstream 8vance hiccup never loses the
 * saved candidate — we surface a warning and the match screen can retry.
 */

import crypto from 'node:crypto';
import { after } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { getOrCreateUserOrg } from '@/lib/org';
import { SELF_ONBOARD_PLACEHOLDER_NAME } from '@/lib/candidate/self-onboard-name';
import { consumeCvRate, cvRateKey } from '@/lib/candidate/cv-ratelimit';
import { trustedClientIp } from '@/lib/client-ip';
import {
  createMatchRun,
  executeMatchRun,
  injectForwardMatchesIntoProjects,
  syncCandidateToVance,
} from '@/lib/candidate/service';
import { resolveCvSkillsForTenant } from '@/lib/candidate/resolve-skills';
import { reportError } from '@/lib/observability/report';
import { vanceClientForTenant } from '@/lib/eightvance/tenant-client';
import {
  resolveDefaultCandidateTenant,
  defaultSourcesForPool,
} from '@/lib/candidate/default-pool';
import type { TalentCreatePayload } from '@/lib/eightvance/types';
import {
  candidatePreferencesSchema,
  withTravelDefault,
  type CandidatePreferencesInput,
} from '@/lib/candidate/preferences';
import type { CvProfile } from '@/lib/candidate/cv-ai';
import { geocodePlace } from '@/lib/geo/geocode';

/**
 * Best-effort forward-geocode each desired work region so the match can bound
 * open-market feeds around WHERE the candidate wants to work (not only their
 * home). Regions that already carry coords, or that don't resolve, are left as
 * plain labels. Never throws — a geocoder hiccup must not fail onboarding.
 */
async function geocodeWorkRegions(
  prefs: CandidatePreferencesInput,
): Promise<CandidatePreferencesInput> {
  const regions = prefs.workRegions;
  if (!regions || regions.length === 0) return prefs;
  const resolved = await Promise.all(
    regions.map(async (r) => {
      if (r.latitude != null && r.longitude != null) return r;
      const g = await geocodePlace(r.label).catch(() => null);
      const lat = g?.latitude != null ? Number(g.latitude) : undefined;
      const lng = g?.longitude != null ? Number(g.longitude) : undefined;
      return Number.isFinite(lat) && Number.isFinite(lng)
        ? { ...r, latitude: lat, longitude: lng }
        : r;
    }),
  );
  return { ...prefs, workRegions: resolved };
}

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

const PORTAL_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days


const skillSchema = z.object({
  // 8vance numeric taxonomy id (from /api/refdata/skill).
  skill: z.number().int().positive(),
  proficiency_id: z.number().int().min(23).max(27).optional(),
  must_have: z.boolean().optional(),
  experience: z.number().int().min(0).max(50).optional(),
});

const languageSchema = z.object({
  language: z.number().int().positive(),
  proficiency_id: z.number().int().min(23).max(27).optional(),
});

const locationSchema = z
  .object({
    city: z.string().min(1).max(120),
    country: z.string().min(1).max(120),
    // Richer home-location input: province/region + postcode, not just a city
    // pick. Both optional so a bare city still validates.
    region: z.string().max(120).optional(),
    postcode: z.string().max(16).optional(),
    latitude: z.string().max(40).optional(),
    longitude: z.string().max(40).optional(),
  })
  .optional()
  .nullable();

// The preferences shape (legacy {sources,contractTypes,radiusKm,remote} + the
// v2 "recruiter's head" fields: workRegions, salary, hoursPerWeek, workMode,
// availability, maxTravelKm, willingToRelocate) lives in lib/candidate/
// preferences so the server action, the match reader, and the client form share
// one source of truth.
const preferencesSchema = candidatePreferencesSchema;

/**
 * Shared shape for both the recruiter wizard and the public portal. `tenantId`
 * is only collected in the recruiter flow; the portal candidate already has one.
 */
const onboardingSchema = z.object({
  name: z.string().min(2).max(160),
  // Email + phone are mandatory for a fully-managed candidate (8vance also
  // requires a non-null email on talent create).
  email: z.string().email().max(200),
  phone: z.string().min(5).max(40),
  cvText: z.string().max(50000).optional().nullable(),
  source: z.string().min(1).max(60).default('findtalent'),
  skills: z.array(skillSchema).min(3).max(40),
  languages: z.array(languageSchema).max(10).optional(),
  location: locationSchema,
  preferences: preferencesSchema,
  // GDPR Art.13/14 — the data-processing notice was acknowledged. In the
  // recruiter flow the recruiter confirms they have the candidate's consent;
  // in the self-onboard portal the candidate ticks it themselves. Required:
  // syncCandidateToVance refuses to push PII to 8vance without consentGivenAt.
  // Accept the real boolean and refine to true so a false/missing value fails
  // validation (returned as the existing invalid/fieldErrors shape) — never
  // hardcode-trust a literal the client sends.
  consent: z.boolean().refine((v) => v === true, { message: 'consent_required' }),
  // Stage-2 CV-parse handle (recruiter wizard only). Opaque token minted by
  // POST /api/candidates/parse-cv. Harmless plumbing kept for wizard
  // compatibility — it is no longer consumed here: CV-review suggestions are now
  // generated from 8vance's own server-side parse of the synced talent (see
  // generateSuggestionsFromTalent), not from this token's in-process cache.
  // Lenient (max-length) so a stale/malformed token never fails onboarding.
  enrichToken: z.string().trim().max(100).optional(),
});

export type OnboardingInput = z.input<typeof onboardingSchema>;

export type CreateCandidateResult =
  | { ok: true; candidateId: string; warning?: string }
  | { ok: false; reason: 'invalid' | 'no_tenant' | 'internal'; fieldErrors?: Record<string, string> };

export type PortalSubmitResult =
  | { ok: true; candidateId: string; warning?: string }
  | { ok: false; reason: 'invalid' | 'token' | 'internal'; fieldErrors?: Record<string, string> };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map validated onboarding data → 8vance TalentCreatePayload (profileJson). */
function buildProfileJson(
  data: z.infer<typeof onboardingSchema>,
): TalentCreatePayload {
  return {
    full_name: data.name,
    source: data.source,
    email: data.email ?? null,
    phone: data.phone ?? null,
    skills: data.skills.map((s) => ({
      skill: s.skill,
      proficiency_id: s.proficiency_id,
      must_have: s.must_have ?? false,
      experience: s.experience,
    })),
    languages: data.languages?.map((l) => ({
      language: l.language,
      proficiency_id: l.proficiency_id,
    })),
    detailed_location: data.location
      ? {
          city: data.location.city,
          country: data.location.country,
          latitude: data.location.latitude,
          longitude: data.location.longitude,
        }
      : null,
  };
}

function fieldErrorsFromZod(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/**
 * Sync the candidate to 8vance (fast) and CREATE a MATCHING run, then EXECUTE
 * that run in the background — off the response path — via Next's `after()`.
 *
 * Why `after()`: matching is slow (per-source inverse match over big external
 * feeds + enrichment), so we must not block the onboarding response on it. But
 * we also can't leave it to the recruiter match screen's poller alone: a
 * SELF-ONBOARD candidate never opens that screen, so without a server-side
 * trigger the run would sit MATCHING until `sweepStaleRuns` FAILs it. `after()`
 * schedules the work to run after the response flushes (same invocation), so
 * every onboarding path now actually runs its match.
 *
 * `executeMatchRun` atomically CLAIMS the run, so the match screen's poller
 * (POST /api/candidates/[id]/run-match) calling it too is safe — whoever wins
 * the claim runs it, the loser no-ops. The poller therefore stays as a backup.
 *
 * NEVER throws: a downstream failure must not discard the candidate, and the
 * backgrounded execution swallows its own errors (the run is flipped to
 * FAILED/READY inside `executeMatchRun`).
 */
async function syncAndMatch(
  candidateId: string,
  sources: string[],
): Promise<string | undefined> {
  try {
    await syncCandidateToVance(candidateId);
  } catch {
    return 'sync_failed';
  }
  let runId: string;
  try {
    runId = await createMatchRun(candidateId, { sources });
  } catch {
    return 'match_failed';
  }
  // Execute the run off the response path. `after` runs the callback after the
  // response is sent (same serverless invocation); errors are swallowed so a
  // failed match never surfaces as a server-action error.
  after(async () => {
    try {
      await executeMatchRun(runId);
    } catch (err) {
      // executeMatchRun flips the run to FAILED on most errors, but it can
      // throw "run not found" (e.g. candidate deleted) BEFORE setting FAILED,
      // leaving a stuck MATCHING run with no trace. Report so it's observable.
      // Stay non-throwing — a failed background match must never surface as an
      // error here.
      reportError(err, { area: 'candidate.match.after', runId });
    }
    // WORKAROUND for 8vance's lagging reverse (job→talent) index: now that the
    // forward (talent→jobs) run completed, inject anonymized Match rows so this
    // candidate shows up immediately in matching project shortlists. Wrapped so
    // it can never break the (already-flushed) response.
    try {
      await injectForwardMatchesIntoProjects(candidateId);
    } catch (err) {
      reportError(err, { area: 'candidate.forwardInject', candidateId });
    }
  });
  return undefined;
}

// ---------------------------------------------------------------------------
// Recruiter-driven create
// ---------------------------------------------------------------------------

export async function createCandidateAction(
  input: OnboardingInput & { tenantId: string; richProfile?: unknown; note?: string },
): Promise<CreateCandidateResult> {
  const user = await requireUser();

  const parsed = onboardingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid', fieldErrors: fieldErrorsFromZod(parsed.error) };
  }
  // Resolve the pool: an explicit tenantId wins; otherwise fall back to the
  // admin-flagged default pool (or the sole pool). Only no_tenant when there's
  // genuinely no resolvable pool (multiple pools + no admin default).
  let tenantId = String(input.tenantId ?? '').trim();
  if (!tenantId) {
    const fallback = await resolveDefaultCandidateTenant();
    if (!fallback) return { ok: false, reason: 'no_tenant' };
    tenantId = fallback.id;
  }

  const data = parsed.data;
  const organizationId = await getOrCreateUserOrg(user.id);

  // Validate the chosen pool exists (and is a real tenant). Load ownSourceSlug
  // so we can default match-sources to the pool's own source.
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, ownSourceSlug: true, ownerOrganizationId: true },
  });
  if (!tenant) return { ok: false, reason: 'no_tenant' };

  // Claim the pool's intake org for the first recruiter who creates a candidate
  // here, so public /apply applicants land in this org's dashboard. Guarded on
  // ownerOrganizationId:null → set-once, race-safe; never overwrites a claim.
  if (!tenant.ownerOrganizationId) {
    await prisma.tenant
      .updateMany({
        where: { id: tenant.id, ownerOrganizationId: null },
        data: { ownerOrganizationId: organizationId },
      })
      .catch(() => {});
  }

  // Onboarding no longer picks sources — default to the pool's own source so
  // the candidate matches against its ONE pool by default.
  // Seed maxTravelKm from the parsed education tier (the "won't drive an hour"
  // heuristic) when the recruiter didn't set a radius, so the match honours it
  // immediately. Uses the rich CV profile's education when present.
  const richEdu = (input.richProfile as CvProfile | undefined)?.education;
  const preferences: CandidatePreferencesInput = await geocodeWorkRegions(
    withTravelDefault(
      {
        ...data.preferences,
        sources:
          data.preferences.sources.length > 0
            ? data.preferences.sources
            : defaultSourcesForPool(tenant.ownSourceSlug),
      },
      richEdu,
    ),
  );
  // Optional recruiter "Notes / extra info" free-text. Trim + cap (~2000) so a
  // pasted essay can't bloat the row; nested on profileJson alongside `cv` and
  // synced to the talent's about_me (see syncCandidateToVance).
  const note = String(input.note ?? '').trim().slice(0, 2000);

  // profileJson = the 8vance TalentCreatePayload (skills/languages/location for
  // sync) PLUS a nested `cv` block holding the full extracted profile
  // (about/education/employment/certifications/languages with levels) for the
  // candidate-profile display, PLUS the recruiter `note`. Nested so neither
  // clobbers the sync fields.
  const profileJson = {
    ...buildProfileJson(data),
    ...(input.richProfile ? { cv: input.richProfile } : {}),
    ...(note ? { note } : {}),
  };

  let candidateId: string;
  try {
    const created = await prisma.candidate.create({
      data: {
        organizationId,
        createdByUserId: user.id,
        tenantId,
        name: data.name,
        email: data.email ?? null,
        phone: data.phone ?? null,
        cvText: data.cvText ?? null,
        status: 'ONBOARDING',
        profileJson: profileJson as object,
        preferencesJson: preferences as object,
        // GDPR consent captured at onboarding (recruiter confirms on the
        // candidate's behalf). Gate in syncCandidateToVance reads this. Tie the
        // audit timestamp to the validated consent field so it only records
        // VERIFIED consent (the refine already guarantees true here).
        consentGivenAt: data.consent === true ? new Date() : null,
      },
      select: { id: true },
    });
    candidateId = created.id;
  } catch {
    return { ok: false, reason: 'internal' };
  }

  const warning = await syncAndMatch(candidateId, preferences.sources);
  // CV-review suggestions are now generated from 8vance's OWN server-side parse
  // of the uploaded CV (reparse=true in syncCandidateToVance), read back off the
  // synced talent on the match page's after() — see generateSuggestionsFromTalent.
  // The old enrichToken/in-process-cache path fed the unreachable parseCv8vance
  // WebSocket and never produced suggestions from the deploy, so it's removed.
  return { ok: true, candidateId, warning };
}

// ---------------------------------------------------------------------------
// Import a POOL talent → local Candidate (FULL-pool browse → manage)
// ---------------------------------------------------------------------------

export type ImportPoolTalentResult =
  | { ok: true; candidateId: string; alreadyExisted: boolean }
  | { ok: false; reason: 'no_tenant' | 'forbidden' | 'not_found' | 'internal' };

/**
 * Create a LOCAL Candidate from an existing 8vance pool talent so the owner can
 * note/track/edit it here. Used by the FULL-pool browse list ("Import / manage"
 * on a pool-only row). Org-guarded against the pool's owning org.
 *
 * NEVER writes to 8vance — the talent already exists there; we only mirror a
 * local row carrying eightvanceTalentId + tenantId + name, status READY (it is
 * already synced + matchable in 8vance). The eightvanceTalentId makes it dedupe
 * against future pool reads (so it then shows as "registered here").
 *
 * Idempotent: if a non-archived local Candidate already exists for this
 * (tenant, org, talentId) we return it instead of creating a duplicate.
 */
export async function importPoolTalentAction(input: {
  tenantId: string;
  talentId: number;
}): Promise<ImportPoolTalentResult> {
  const user = await requireUser();
  const tenantId = String(input.tenantId ?? '').trim();
  const talentId = Number(input.talentId);
  if (!tenantId) return { ok: false, reason: 'no_tenant' };
  if (!Number.isFinite(talentId) || talentId <= 0) return { ok: false, reason: 'not_found' };

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, ownerOrganizationId: true },
  });
  if (!tenant) return { ok: false, reason: 'no_tenant' };

  const organizationId = await getOrCreateUserOrg(user.id);
  // Org guard: only the pool's owning org (or an org with a candidate already
  // in the pool) may import. Mirrors the pool read-through route.
  if (tenant.ownerOrganizationId && tenant.ownerOrganizationId !== organizationId) {
    const own = await prisma.candidate.findFirst({
      where: { tenantId, organizationId },
      select: { id: true },
    });
    if (!own) return { ok: false, reason: 'forbidden' };
  }

  // Already imported? Return it (idempotent — never duplicate a talent).
  const existing = await prisma.candidate.findFirst({
    where: {
      tenantId,
      organizationId,
      eightvanceTalentId: talentId,
      status: { not: 'ARCHIVED' },
    },
    select: { id: true },
  });
  if (existing) return { ok: true, candidateId: existing.id, alreadyExisted: true };

  // Resolve the talent's name/email from 8vance SERVER-SIDE (never trust the
  // client for it). Best-effort: a name is required for the local row, so on a
  // read failure fall back to a stable placeholder rather than aborting.
  let name = `Talent #${talentId}`;
  let email: string | null = null;
  try {
    const client = await vanceClientForTenant(tenantId);
    const profile = await client.talent.getProfile(talentId);
    const rec = profile as Record<string, unknown>;
    const full = (typeof rec.full_name === 'string' && rec.full_name.trim()) || '';
    const first = (typeof rec.first_name === 'string' && rec.first_name.trim()) || '';
    const last = (typeof rec.last_name === 'string' && rec.last_name.trim()) || '';
    const resolved = (full || `${first} ${last}`.trim()).trim();
    if (resolved) name = resolved;
    if (typeof rec.email === 'string' && rec.email.trim()) email = rec.email.trim();
  } catch {
    // Keep the placeholder name; the talent still imports + dedupes by id.
  }

  try {
    const created = await prisma.candidate.create({
      data: {
        organizationId,
        createdByUserId: user.id,
        tenantId,
        name,
        email,
        // Already synced + matchable in 8vance — no onboarding needed.
        status: 'READY',
        eightvanceTalentId: talentId,
      },
      select: { id: true },
    });
    return { ok: true, candidateId: created.id, alreadyExisted: false };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}

// ---------------------------------------------------------------------------
// BULK import POOL talents → local Candidates (multi-select / select-all)
// ---------------------------------------------------------------------------

export type BulkImportPoolResult =
  | { ok: true; mode: 'ids'; imported: number; skipped: number }
  | { ok: true; mode: 'all'; estimated: number | null; background: true }
  | { ok: false; reason: 'no_tenant' | 'forbidden' | 'not_full' | 'bad_input' | 'internal' };

/** Batch size for createMany inserts (keeps each SQLite write bounded). */
const BULK_INSERT_BATCH = 500;
/** Hard cap on explicit ids accepted from the client in 'ids' mode. */
const BULK_IDS_MAX = 500;
/** Hard cap on the excluded-id set in 'all' mode (DoS / payload guard). */
const BULK_EXCLUDED_MAX = 5000;

/**
 * Resolve + guard the tenant for a bulk pool operation. Mirrors the pool route
 * (`/api/candidates/pool`) + importPoolTalentAction guards: authed owner, org
 * guard against the pool's owning org, and FULL talentScope required (a LOCAL
 * pool has no read-through to bulk-import from). Returns the resolved org id on
 * success, or a result-shaped failure to relay.
 */
async function resolveBulkPoolTenant(
  userId: string,
  tenantId: string,
): Promise<
  | { ok: true; organizationId: string }
  | { ok: false; reason: 'no_tenant' | 'forbidden' | 'not_full' }
> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, talentScope: true, ownerOrganizationId: true },
  });
  if (!tenant) return { ok: false, reason: 'no_tenant' };

  const organizationId = await getOrCreateUserOrg(userId);
  if (tenant.ownerOrganizationId && tenant.ownerOrganizationId !== organizationId) {
    const own = await prisma.candidate.findFirst({
      where: { tenantId, organizationId },
      select: { id: true },
    });
    if (!own) return { ok: false, reason: 'forbidden' };
  }
  if (String(tenant.talentScope).toUpperCase() !== 'FULL') {
    return { ok: false, reason: 'not_full' };
  }
  return { ok: true, organizationId };
}

/**
 * BULK "Import / manage selected" over a query-based selection of POOL talents.
 *
 * Two modes mirroring the Gmail/Linear selection model:
 *   - 'ids'  — an explicit, SMALL selection (`included` set, capped at 500). We
 *     import exactly those talent ids SYNCHRONOUSLY: skip ones already local for
 *     this org (idempotent), then create the rest with one batched createMany
 *     using the NAMES the client already saw in the list rows (NO per-talent
 *     getProfile — that would blow the 55/min rate limit). Returns imported +
 *     skipped counts immediately.
 *   - 'all'  — the 20k case. We do NOT accept ids from the client. The SERVER
 *     pages the WHOLE `/talent/` pool for this tenant+q itself
 *     (`talent.iterateAllPagesNames`, page_size 100), skips `excluded` +
 *     already-local ids (explicit per-page filter — eightvanceTalentId isn't a
 *     unique column), and inserts in createMany batches of 500. Because that
 *     walk is long + rate-limited we run it in
 *     the BACKGROUND via `after()` (off the response) and return an estimated
 *     count straightaway. Progress + a final count are logged so the background
 *     run is observable.
 *
 * SECURITY: owner-authed + org-guarded + FULL-pool only (see
 * resolveBulkPoolTenant). 8vance creds terminate server-side. Never writes to
 * 8vance — the talents already exist there; we only mirror local Candidate rows
 * (status READY, carrying eightvanceTalentId so future pool reads dedupe them).
 */
export async function bulkImportPoolTalentsAction(input: {
  tenantId: string;
  q?: string;
  mode: 'ids' | 'all';
  ids?: number[];
  excluded?: number[];
}): Promise<BulkImportPoolResult> {
  const user = await requireUser();
  const tenantId = String(input.tenantId ?? '').trim();
  if (!tenantId) return { ok: false, reason: 'no_tenant' };
  if (input.mode !== 'ids' && input.mode !== 'all') {
    return { ok: false, reason: 'bad_input' };
  }

  const guard = await resolveBulkPoolTenant(user.id, tenantId);
  if (!guard.ok) return guard;
  const { organizationId } = guard;
  const q = String(input.q ?? '').trim().slice(0, 120);

  // -- 'ids' mode: explicit small selection, imported synchronously. --------
  if (input.mode === 'ids') {
    const ids = Array.from(
      new Set(
        (Array.isArray(input.ids) ? input.ids : [])
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    ).slice(0, BULK_IDS_MAX);
    if (ids.length === 0) return { ok: false, reason: 'bad_input' };

    // Names: server-side from the list rows (NO per-talent getProfile). We page
    // the pool only as far as needed to resolve the selected ids' names; a name
    // we can't resolve falls back to a stable placeholder.
    const nameById = new Map<number, string>();
    try {
      const client = await vanceClientForTenant(tenantId);
      const wanted = new Set(ids);
      for await (const rows of client.talent.iterateAllPagesNames({ pageSize: 100, q })) {
        for (const r of rows) {
          if (wanted.has(r.id) && !nameById.has(r.id)) nameById.set(r.id, r.name);
        }
        if (nameById.size >= wanted.size) break;
      }
    } catch {
      // Name resolution is best-effort; placeholders below keep the import working.
    }

    // Skip ids already local (non-archived) for this org — idempotent.
    let skipped = 0;
    const existing = await prisma.candidate.findMany({
      where: {
        tenantId,
        organizationId,
        eightvanceTalentId: { in: ids },
        status: { not: 'ARCHIVED' },
      },
      select: { eightvanceTalentId: true },
    });
    const already = new Set(
      existing.map((e) => e.eightvanceTalentId).filter((n): n is number => n != null),
    );
    skipped += already.size;
    const toCreate = ids.filter((id) => !already.has(id));

    let imported = 0;
    for (let i = 0; i < toCreate.length; i += BULK_INSERT_BATCH) {
      const batch = toCreate.slice(i, i + BULK_INSERT_BATCH);
      try {
        const res = await prisma.candidate.createMany({
          data: batch.map((id) => ({
            organizationId,
            createdByUserId: user.id,
            tenantId,
            name: nameById.get(id) ?? `Talent #${id}`,
            status: 'READY' as const,
            eightvanceTalentId: id,
          })),
        });
        imported += res.count;
      } catch {
        return { ok: false, reason: 'internal' };
      }
    }
    return { ok: true, mode: 'ids', imported, skipped };
  }

  // -- 'all' mode: whole pool minus excluded, paged + imported in background. -
  const excluded = new Set(
    (Array.isArray(input.excluded) ? input.excluded : [])
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, BULK_EXCLUDED_MAX),
  );

  // Estimate the count up front (total - excluded) for an immediate UI number,
  // without enumerating the pool. Best-effort: null when 8vance gives no count.
  let estimated: number | null = null;
  try {
    const client = await vanceClientForTenant(tenantId);
    const first = await client.talent.listPage({ page: 1, pageSize: 1, q });
    if (first.total != null) estimated = Math.max(0, first.total - excluded.size);
  } catch {
    // Leave estimated null; the background run still proceeds + logs the truth.
  }

  // Run the heavy pool walk + batched inserts OFF the response path. It's long
  // (20k rows) + rate-limited, so we must not block the action's return.
  after(async () => {
    const startedAt = Date.now();
    let scanned = 0;
    let imported = 0;
    let buffer: Array<{ id: number; name: string }> = [];

    const flush = async () => {
      if (buffer.length === 0) return;
      const batch = buffer;
      buffer = [];
      try {
        const res = await prisma.candidate.createMany({
          data: batch.map((b) => ({
            organizationId,
            createdByUserId: user.id,
            tenantId,
            name: b.name,
            status: 'READY' as const,
            eightvanceTalentId: b.id,
          })),
        });
        imported += res.count;
      } catch (err) {
        reportError(err, { area: 'candidate.pool.bulkImport.flush', tenantId });
      }
    };

    try {
      const client = await vanceClientForTenant(tenantId);
      for await (const rows of client.talent.iterateAllPagesNames({ pageSize: 100, q })) {
        scanned += rows.length;
        const pageIds = rows.map((r) => r.id).filter((id) => !excluded.has(id));
        if (pageIds.length > 0) {
          // Skip ids already local for this org so we don't re-insert them.
          // eightvanceTalentId is NOT a unique column (SQLite createMany has no
          // skipDuplicates either), so idempotency is enforced by this explicit
          // filter, not by the DB.
          const locals = await prisma.candidate.findMany({
            where: {
              tenantId,
              organizationId,
              eightvanceTalentId: { in: pageIds },
              status: { not: 'ARCHIVED' },
            },
            select: { eightvanceTalentId: true },
          });
          const have = new Set(
            locals.map((l) => l.eightvanceTalentId).filter((n): n is number => n != null),
          );
          for (const r of rows) {
            if (excluded.has(r.id) || have.has(r.id)) continue;
            buffer.push({ id: r.id, name: r.name });
          }
        }
        if (buffer.length >= BULK_INSERT_BATCH) await flush();
      }
      await flush();
      console.warn(
        `[pool-bulk-import] tenant=${tenantId} org=${organizationId} scanned=${scanned} imported=${imported} excluded=${excluded.size} took=${Date.now() - startedAt}ms`,
      );
    } catch (err) {
      // Flush whatever we buffered before the failure so partial progress sticks.
      await flush();
      reportError(err, {
        area: 'candidate.pool.bulkImport.all',
        tenantId,
        scanned,
        imported,
      });
    }
  });

  return { ok: true, mode: 'all', estimated, background: true };
}

// ---------------------------------------------------------------------------
// Magic-link portal invite (recruiter creates a self-onboard link)
// ---------------------------------------------------------------------------

export type PortalInviteResult =
  | { ok: true; token: string; url: string; expiresAt: string }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'internal' };

/**
 * Issue (or rotate) a self-onboard magic link for an existing candidate the
 * acting user can see (own org). Returns the token + a relative portal URL.
 */
export async function createPortalInviteAction(
  candidateId: string,
): Promise<PortalInviteResult> {
  const user = await requireUser();
  const organizationId = await getOrCreateUserOrg(user.id);

  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: { id: true, organizationId: true, createdByUserId: true },
  });
  if (!candidate) return { ok: false, reason: 'not_found' };
  // Scope: only the creator or a member of the owning org may invite.
  const owns =
    candidate.createdByUserId === user.id ||
    (candidate.organizationId && candidate.organizationId === organizationId);
  if (!owns) return { ok: false, reason: 'forbidden' };

  const token = crypto.randomUUID();
  const expires = new Date(Date.now() + PORTAL_TOKEN_TTL_MS);
  try {
    await prisma.candidate.update({
      where: { id: candidateId },
      data: { portalToken: token, portalTokenExpires: expires },
    });
  } catch {
    return { ok: false, reason: 'internal' };
  }

  return {
    ok: true,
    token,
    url: `/candidate/${token}`,
    expiresAt: expires.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Draft + invite from scratch (recruiter mints a link with ZERO data)
// ---------------------------------------------------------------------------

export type DraftInviteResult =
  | { ok: true; candidateId: string; token: string; url: string; expiresAt: string }
  | { ok: false; reason: 'no_tenant' | 'internal' };

/**
 * Create an EMPTY draft candidate and mint a self-onboard magic link in one
 * step — the from-scratch self-onboard entry point. The recruiter only picks a
 * pool; the candidate fills everything (name/email/phone + CV) on the public
 * portal, where the server extracts skills. Requires an authed user + org.
 */
export async function createDraftInviteAction(input: {
  tenantId: string;
  name?: string;
}): Promise<DraftInviteResult> {
  const user = await requireUser();

  // Resolve the pool: explicit tenantId wins; otherwise fall back to the
  // admin-flagged default pool (or the sole pool). Only fail when none.
  let tenantId = String(input.tenantId ?? '').trim();
  if (!tenantId) {
    const fallback = await resolveDefaultCandidateTenant();
    if (!fallback) return { ok: false, reason: 'no_tenant' };
    tenantId = fallback.id;
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true },
  });
  if (!tenant) return { ok: false, reason: 'no_tenant' };

  const organizationId = await getOrCreateUserOrg(user.id);
  const name = String(input.name ?? '').trim() || SELF_ONBOARD_PLACEHOLDER_NAME;
  const token = crypto.randomUUID();
  const expires = new Date(Date.now() + PORTAL_TOKEN_TTL_MS);

  let candidateId: string;
  try {
    const created = await prisma.candidate.create({
      data: {
        organizationId,
        createdByUserId: user.id,
        tenantId,
        name,
        status: 'DRAFT',
        portalToken: token,
        portalTokenExpires: expires,
      },
      select: { id: true },
    });
    candidateId = created.id;
  } catch {
    return { ok: false, reason: 'internal' };
  }

  return {
    ok: true,
    candidateId,
    token,
    url: `/candidate/${token}`,
    expiresAt: expires.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public self-onboard submit (NO auth — resolved by portal token)
// ---------------------------------------------------------------------------

export async function submitPortalOnboardingAction(
  token: string,
  input: OnboardingInput,
): Promise<PortalSubmitResult> {
  const cleanToken = String(token ?? '').trim();
  if (!cleanToken) return { ok: false, reason: 'token' };

  const parsed = onboardingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid', fieldErrors: fieldErrorsFromZod(parsed.error) };
  }
  const data = parsed.data;

  // Resolve by token; never trust the client for which candidate this is.
  const candidate = await prisma.candidate.findUnique({
    where: { portalToken: cleanToken },
    select: {
      id: true,
      tenantId: true,
      portalTokenExpires: true,
      eightvanceTalentId: true,
    },
  });
  if (
    !candidate ||
    !candidate.portalTokenExpires ||
    candidate.portalTokenExpires.getTime() < Date.now()
  ) {
    return { ok: false, reason: 'token' };
  }
  // Already submitted (synced) — refuse a second sync via the same link.
  if (candidate.eightvanceTalentId) {
    return { ok: false, reason: 'token' };
  }
  // A candidate without a tenant has no pool to sync to or match against:
  // syncCandidateToVance would throw "no tenant" (swallowed into a sync_failed
  // warning) yet the action would still return ok:true (silent failure), and
  // empty sources would default to [] → match ALL sources instead of the pool.
  // Mirror submitPortalCvOnboardingAction's tenant guard and fail loudly. We
  // reuse `token` (no distinct reason exists in PortalSubmitResult, and this is
  // an un-actionable link state for the candidate, same as the CV path).
  if (!candidate.tenantId) {
    return { ok: false, reason: 'token' };
  }

  // Onboarding no longer picks sources — default to the candidate pool's own
  // source so the inverse match has a target (its ONE pool).
  let ownSourceSlug: string | null = null;
  if (candidate.tenantId) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: candidate.tenantId },
      select: { ownSourceSlug: true },
    });
    ownSourceSlug = tenant?.ownSourceSlug ?? null;
  }
  const preferences = await geocodeWorkRegions({
    ...data.preferences,
    sources:
      data.preferences.sources.length > 0
        ? data.preferences.sources
        : defaultSourcesForPool(ownSourceSlug),
  });
  const profileJson = buildProfileJson(data);

  // Atomically CLAIM the link: only one concurrent submit can win, because the
  // updateMany is guarded by (token still set + not expired + not yet synced)
  // and clears the token in the same statement. A second racing submit sees
  // count 0 and bails — preventing duplicate 8vance talent creation.
  let claimed = 0;
  try {
    const res = await prisma.candidate.updateMany({
      where: {
        id: candidate.id,
        portalToken: cleanToken,
        portalTokenExpires: { gt: new Date() },
        eightvanceTalentId: null,
      },
      data: {
        name: data.name,
        email: data.email ?? null,
        phone: data.phone ?? null,
        cvText: data.cvText ?? null,
        status: 'ONBOARDING',
        profileJson: profileJson as object,
        preferencesJson: preferences as object,
        // GDPR consent ticked by the candidate on the self-onboard portal.
        // Tie the audit timestamp to the validated consent field so it only
        // records VERIFIED consent (the refine already guarantees true here).
        consentGivenAt: data.consent === true ? new Date() : null,
        // Consume the link so it can't be replayed.
        portalToken: null,
        portalTokenExpires: null,
      },
    });
    claimed = res.count;
  } catch {
    return { ok: false, reason: 'internal' };
  }
  if (claimed !== 1) {
    // Lost the race (or already consumed between read and write).
    return { ok: false, reason: 'token' };
  }

  const warning = await syncAndMatch(candidate.id, preferences.sources);
  return { ok: true, candidateId: candidate.id, warning };
}

// ---------------------------------------------------------------------------
// Public self-onboard erasure (GDPR Art.17 — token-scoped, NO auth)
// ---------------------------------------------------------------------------

export type PortalDeleteResult =
  | { ok: true }
  | { ok: false; reason: 'token' | 'internal' };

/**
 * PUBLIC self-erasure from the portal. The candidate is resolved STRICTLY by an
 * unexpired portalToken (never trust the client for which row this is). Hard-
 * deletes the Candidate row; match runs + job matches cascade (schema
 * onDelete: Cascade), so all stored PII is physically gone. An audit line is
 * logged with ids only (no PII). A consumed/expired link can't delete anything.
 */
export async function deletePortalCandidateAction(
  token: string,
): Promise<PortalDeleteResult> {
  const cleanToken = String(token ?? '').trim();
  if (!cleanToken) return { ok: false, reason: 'token' };

  const candidate = await prisma.candidate.findUnique({
    where: { portalToken: cleanToken },
    select: { id: true, portalTokenExpires: true },
  });
  if (
    !candidate ||
    !candidate.portalTokenExpires ||
    candidate.portalTokenExpires.getTime() < Date.now()
  ) {
    return { ok: false, reason: 'token' };
  }

  try {
    // Guard the delete on the token still being valid so a racing submit/expiry
    // can't let this erase the wrong (or an already-consumed) row.
    const res = await prisma.candidate.deleteMany({
      where: {
        id: candidate.id,
        portalToken: cleanToken,
        portalTokenExpires: { gt: new Date() },
      },
    });
    if (res.count !== 1) return { ok: false, reason: 'token' };
  } catch {
    return { ok: false, reason: 'internal' };
  }

  console.warn(
    `[gdpr-erasure] candidate ${candidate.id} self-deleted via portal token at ${new Date().toISOString()}`,
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Public self-onboard submit — FROM SCRATCH (CV-only, server extracts skills)
// ---------------------------------------------------------------------------

/**
 * Portal CV submit schema. Unlike `onboardingSchema` this does NOT require
 * client-provided skills (the public portal can't reach the authed skill
 * search). The server extracts + resolves skills from the CV. Preferences are
 * optional; we fall back to the candidate's own pool + sane defaults.
 */
const portalCvSchema = z.object({
  name: z.string().min(2).max(160),
  email: z.string().email().max(200),
  phone: z.string().min(5).max(40),
  cvText: z.string().min(20).max(50000),
  preferences: preferencesSchema.partial().optional().nullable(),
  // GDPR Art.13/14 — the candidate ticked the data-processing notice.
  // Accept the real boolean and refine to true so a false/missing value fails
  // validation (returned as the existing invalid/fieldErrors shape).
  consent: z.boolean().refine((v) => v === true, { message: 'consent_required' }),
});

export type PortalCvInput = z.input<typeof portalCvSchema>;

export type PortalCvSubmitResult =
  | { ok: true; candidateId: string; skillCount: number; warning?: string }
  | {
      ok: false;
      reason: 'invalid' | 'token' | 'rate_limited' | 'internal';
      fieldErrors?: Record<string, string>;
      retryAfterSec?: number;
    };

/**
 * PUBLIC from-scratch self-onboard. The candidate provides name/email/phone +
 * pasted CV text; the SERVER extracts categorized skills (`extractCvProfile`)
 * and resolves the names → 8vance taxonomy ids via the tenant client
 * (`resolveCvSkillsForTenant`). No client-supplied skills are trusted.
 *
 * Resolved >=1 skill → build profileJson, save, sync + create a (background)
 * match run. Resolved 0 skills → STILL save the candidate (so the recruiter
 * doesn't lose the lead) but skip sync (8vance needs >=3 skills) and return a
 * warning. The link is atomically claimed exactly like the existing portal
 * submit so it can't be replayed.
 */
export async function submitPortalCvOnboardingAction(
  token: string,
  input: PortalCvInput,
): Promise<PortalCvSubmitResult> {
  const cleanToken = String(token ?? '').trim();
  if (!cleanToken) return { ok: false, reason: 'token' };

  // Rate-limit BEFORE the paid LLM skill resolver runs. This token-gated public
  // portal path is unauthed, so bound it like the sibling public action:
  // by IP, and additionally by the (stable, per-candidate) portal token so a
  // single link can't be hammered behind a rotating IP. Either bucket tripping
  // refuses the request before any paid work. Token/IP are never logged.
  const ip = await publicClientIp();
  const ipRate = await consumeCvRate(cvRateKey({ ip }));
  if (!ipRate.allowed) {
    return { ok: false, reason: 'rate_limited', retryAfterSec: ipRate.retryAfterSec };
  }
  const tokenRate = await consumeCvRate(cvRateKey({ userId: `portal:${cleanToken}` }));
  if (!tokenRate.allowed) {
    return { ok: false, reason: 'rate_limited', retryAfterSec: tokenRate.retryAfterSec };
  }

  const parsed = portalCvSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid', fieldErrors: fieldErrorsFromZod(parsed.error) };
  }
  const data = parsed.data;

  // Resolve by token; never trust the client for which candidate this is.
  const candidate = await prisma.candidate.findUnique({
    where: { portalToken: cleanToken },
    select: {
      id: true,
      tenantId: true,
      locale: true,
      portalTokenExpires: true,
      eightvanceTalentId: true,
    },
  });
  if (
    !candidate ||
    !candidate.tenantId ||
    !candidate.portalTokenExpires ||
    candidate.portalTokenExpires.getTime() < Date.now() ||
    candidate.eightvanceTalentId
  ) {
    return { ok: false, reason: 'token' };
  }

  // Resolve the tenant's locale to steer the skill search (NL/EN/DE).
  const tenant = await prisma.tenant.findUnique({
    where: { id: candidate.tenantId },
    select: { defaultLocale: true, ownSourceSlug: true },
  });
  const locale = (candidate.locale || tenant?.defaultLocale || 'nl').toLowerCase();

  // SERVER-SIDE skill extraction + taxonomy resolution (bounded concurrency).
  let resolved;
  try {
    resolved = await resolveCvSkillsForTenant(candidate.tenantId, data.cvText, locale);
  } catch {
    return { ok: false, reason: 'internal' };
  }

  // Build preferences: candidate-supplied (partial) merged over sane defaults.
  // Sources default to the pool's own source (via the shared helper) so an
  // inverse match has a target — consistent with the other onboarding paths.
  const prefIn = data.preferences ?? {};
  const preferencesBase = {
    // Preserve any v2 "recruiter's head" fields the client supplied (workMode,
    // salary, hoursPerWeek, availability, workRegions, maxTravelKm, …) …
    ...prefIn,
    // … then pin the legacy required fields to sane defaults.
    sources:
      Array.isArray(prefIn.sources) && prefIn.sources.length > 0
        ? prefIn.sources
        : defaultSourcesForPool(tenant?.ownSourceSlug),
    contractTypes: Array.isArray(prefIn.contractTypes) ? prefIn.contractTypes : [],
    radiusKm: typeof prefIn.radiusKm === 'number' ? prefIn.radiusKm : 30,
    remote: typeof prefIn.remote === 'boolean' ? prefIn.remote : false,
    ...(prefIn.locationCity ? { locationCity: prefIn.locationCity } : {}),
  };
  const preferences = await geocodeWorkRegions(preferencesBase);

  // Same shape as the recruiter flow: the TalentCreatePayload PLUS a nested `cv`
  // block holding the full extracted profile (education/employment/languages/
  // certifications). Without `cv`, syncCandidateToVance reads an empty object and
  // the education/work-experience sub-resources are never created — silent loss.
  const profileJson: TalentCreatePayload & { cv?: unknown } = {
    full_name: data.name,
    source: 'findtalent',
    email: data.email,
    phone: data.phone,
    skills: resolved.skills.map((s) => ({
      skill: s.id,
      must_have: false,
    })),
    detailed_location: null,
    cv: resolved.profile,
  };

  // Atomically CLAIM the link (same guard as submitPortalOnboardingAction):
  // only one concurrent submit wins; a second racing submit sees count 0.
  // Status: ONBOARDING when we have skills to sync, else DRAFT (kept for the
  // recruiter to finish).
  //
  // Token lifecycle: ONLY consume the token on the SUCCESS path (>=3 skills,
  // ready to sync) so it can't be replayed. On the DRAFT/few_skills path we
  // KEEP the token valid so the candidate can re-upload a better CV via the
  // SAME link — otherwise a thin CV would permanently burn the link and force
  // the recruiter to re-mint. We still write the partial profile so the lead
  // isn't lost; the unchanged token just stays usable until they succeed.
  const hasSkills = resolved.skills.length >= 3;
  let claimed = 0;
  try {
    const res = await prisma.candidate.updateMany({
      where: {
        id: candidate.id,
        portalToken: cleanToken,
        portalTokenExpires: { gt: new Date() },
        eightvanceTalentId: null,
      },
      data: {
        name: data.name,
        email: data.email,
        phone: data.phone,
        cvText: data.cvText,
        status: hasSkills ? 'ONBOARDING' : 'DRAFT',
        profileJson: profileJson as object,
        preferencesJson: preferences as object,
        // GDPR consent ticked by the candidate on the self-onboard portal.
        // Tie the audit timestamp to the validated consent field so it only
        // records VERIFIED consent (the refine already guarantees true here).
        consentGivenAt: data.consent === true ? new Date() : null,
        // Consume the link ONLY on the successful (synced) path. On the DRAFT
        // path leave the token untouched so the candidate can retry the link.
        ...(hasSkills ? { portalToken: null, portalTokenExpires: null } : {}),
      },
    });
    claimed = res.count;
  } catch {
    return { ok: false, reason: 'internal' };
  }
  if (claimed !== 1) {
    // Lost the race (or already consumed between read and write).
    return { ok: false, reason: 'token' };
  }

  // 8vance requires >=3 skills to create a talent. If we resolved fewer, save
  // the candidate but skip sync and surface a warning — the recruiter can
  // finish the profile from the dashboard.
  if (!hasSkills) {
    return {
      ok: true,
      candidateId: candidate.id,
      skillCount: resolved.skills.length,
      // Distinguish "broken tenant creds → couldn't resolve" from "CV had too
      // few recognizable skills" so the UI shows the right message.
      warning: resolved.authFailed ? 'auth_failed' : 'few_skills',
    };
  }

  const warning = await syncAndMatch(candidate.id, preferences.sources);
  return {
    ok: true,
    candidateId: candidate.id,
    skillCount: resolved.skills.length,
    warning,
  };
}

// ---------------------------------------------------------------------------
// PUBLIC website registration (NO auth — one stable link per pool)
// ---------------------------------------------------------------------------

/**
 * Sentinel `createdByUserId` for candidates that register themselves through
 * the public, unauthenticated website link. `Candidate.createdByUserId` is a
 * NON-NULL loose scalar (no FK to User — see schema), so we can stamp a stable
 * marker string here without needing a real User row. We deliberately do NOT
 * invent a User: an anonymous web applicant has no account.
 *
 * Visibility to recruiters: the candidate list is scoped by
 * `createdByUserId === me OR organizationId === myOrg`. So we resolve the
 * owning organization of the pool (derived from the org of the recruiter who
 * already owns candidates in that tenant) and stamp it on the row. When no such
 * org can be derived (a brand-new pool with no prior candidates), the row is
 * still saved with the sentinel + tenantId so it is recoverable, but it won't
 * surface in the dashboard until the pool has a known owning org — surfaced as
 * an internal note rather than a silent loss.
 */
const PUBLIC_APPLY_SENTINEL_USER = '__public_apply__';

/**
 * Public website-registration schema. Unauthenticated: the visitor can't reach
 * the authed 8vance skill search, so skills are NOT collected here (the
 * recruiter resolves them later when reviewing/syncing). CV paste is optional.
 * All string lengths are capped. Consent is REQUIRED (refine → true).
 */
const publicApplySchema = z.object({
  name: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(200),
  // Phone optional on the public form. Empty string → undefined via transform.
  phone: z
    .string()
    .trim()
    .max(40)
    .optional()
    .transform((v) => (v && v.length >= 5 ? v : undefined)),
  cvText: z.string().trim().max(50000).optional(),
  // GDPR Art.13/14 — visitor consents to processing. Required.
  consent: z.boolean().refine((v) => v === true, { message: 'consent_required' }),
});

export type PublicApplyInput = z.input<typeof publicApplySchema>;

export type PublicApplyResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'invalid' | 'no_tenant' | 'rate_limited' | 'internal';
      fieldErrors?: Record<string, string>;
      retryAfterSec?: number;
    };

/**
 * Best-effort client IP from common proxy headers (server-action context). Used
 * ONLY to key the per-IP rate-limiter; never logged, never stored. Falls back
 * to 'unknown' so the limiter still bounds an IP-less caller as a single bucket.
 */
async function publicClientIp(): Promise<string> {
  try {
    // Resolve the TRUSTED (rightmost) XFF hop, not the attacker-controllable
    // leftmost token — a rotating XFF must not mint fresh rate-limit buckets.
    return trustedClientIp(await headers()) || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * PUBLIC, unauthenticated self-registration via a STABLE per-pool link
 * (`/apply/[slug]`). Anyone can submit; we:
 *   1. Rate-limit per IP (reuses the CV sliding-window limiter) — 'rate_limited'.
 *   2. Validate every field with zod (lengths capped, consent required).
 *   3. Resolve the pool by tenant slug — 'no_tenant' if unknown.
 *   4. Create a LOCAL Candidate (status ONBOARDING) in that pool.
 *
 * SECURITY: this NEVER calls any 8vance write (no sync, no match) — anonymous
 * input must not auto-write to a live PROD pool. The recruiter reviews + syncs
 * later from the dashboard. consentGivenAt is set only when consent === true.
 */
export async function submitPublicApplicationAction(
  slug: string,
  input: PublicApplyInput,
): Promise<PublicApplyResult> {
  // 1. Rate-limit per IP BEFORE doing any work (the public path is unauthed).
  const ip = await publicClientIp();
  const rate = await consumeCvRate(cvRateKey({ ip }));
  if (!rate.allowed) {
    return { ok: false, reason: 'rate_limited', retryAfterSec: rate.retryAfterSec };
  }

  // 2. Validate input. Reject anything malformed before touching the DB.
  const parsed = publicApplySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid', fieldErrors: fieldErrorsFromZod(parsed.error) };
  }
  const data = parsed.data;

  // 3. Resolve the pool strictly by slug — never trust a client-supplied id.
  const cleanSlug = String(slug ?? '').trim().toLowerCase().slice(0, 120);
  if (!cleanSlug) return { ok: false, reason: 'no_tenant' };
  const tenant = await prisma.tenant.findUnique({
    where: { slug: cleanSlug },
    select: { id: true, ownerOrganizationId: true },
  });
  if (!tenant) return { ok: false, reason: 'no_tenant' };

  // Owning organization of this pool so the new applicant shows up in the
  // managing recruiter's dashboard (list is scoped by org/creator). Prefer the
  // explicit Tenant.ownerOrganizationId (auto-claimed by the first recruiter who
  // creates a candidate in the pool). Fall back to the most-recent candidate's
  // org for pools claimed before this column existed. If still none, the row is
  // saved (recoverable by tenant) with a null org until a recruiter claims it.
  let organizationId: string | null = tenant.ownerOrganizationId ?? null;
  if (!organizationId) {
    try {
      const owner = await prisma.candidate.findFirst({
        where: { tenantId: tenant.id, organizationId: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { organizationId: true },
      });
      organizationId = owner?.organizationId ?? null;
    } catch {
      organizationId = null;
    }
  }

  // profileJson: a minimal TalentCreatePayload (name/email/phone) PLUS the raw
  // CV text nested under `cv.rawText` so the recruiter can parse it later. No
  // skills are resolved here (no authed taxonomy access on the public path).
  const profileJson: TalentCreatePayload & { cv?: { rawText: string } } = {
    full_name: data.name,
    source: 'findtalent_public',
    email: data.email,
    phone: data.phone ?? null,
    skills: [],
    detailed_location: null,
    ...(data.cvText ? { cv: { rawText: data.cvText } } : {}),
  };

  try {
    await prisma.candidate.create({
      data: {
        organizationId,
        createdByUserId: PUBLIC_APPLY_SENTINEL_USER,
        tenantId: tenant.id,
        name: data.name,
        email: data.email,
        phone: data.phone ?? null,
        cvText: data.cvText ?? null,
        status: 'ONBOARDING',
        profileJson: profileJson as object,
        // GDPR consent ticked by the applicant on the public form. Tie the audit
        // timestamp to the validated consent field (refine guarantees true).
        consentGivenAt: data.consent === true ? new Date() : null,
      },
      select: { id: true },
    });
  } catch {
    return { ok: false, reason: 'internal' };
  }

  // NB: intentionally NO syncCandidateToVance / match here — anonymous input
  // must never auto-write to a live 8vance pool. Recruiter reviews + syncs.
  return { ok: true };
}
