/**
 * Local multi-signal fallback ranking.
 *
 * 8vance's native matcher requires a licensed account with valid talent
 * `sources` and async-match scope. When those aren't available (e.g. a
 * pool whose credentials only expose read access), we still want to show
 * the customer relevant, anonymized candidates. This module ranks the
 * tenant's talent pool locally by combining several signals against the
 * project: skill overlap (primary), location proximity, language match,
 * education level, and years-of-experience.
 *
 * Bounded by `MATCH_FALLBACK_SCAN` (default 80) talents so a single match
 * stays within the 55/min rate budget and finishes in ~1-2 min as a
 * background hydrate step. Talent sub-resources are fetched with limited
 * concurrency and cached implicitly by the rate limiter.
 *
 * ---------------------------------------------------------------------------
 * Scoring weights (deterministic, documented)
 * ---------------------------------------------------------------------------
 * The final score is `round(earned / maxPossible * 100)` where each signal
 * contributes a fixed maximum. Only signals the job actually specifies count
 * toward `maxPossible`, so a skills-only job still scores 0..100 on skills
 * alone (graceful degradation — absent job signals never penalise a talent).
 *
 *   Skill must-have   : 2 per matched must-have skill   (W_SKILL_MUST)
 *   Skill nice-to-have : 1 per matched nice skill        (W_SKILL_NICE)
 *   Location           : up to 3                          (W_LOCATION)
 *                          same province → 3, same country → 1.5, else 0
 *   Language           : up to 3                          (W_LANGUAGE)
 *                          fraction of required languages the talent speaks × 3
 *   Education          : up to 2                          (W_EDUCATION)
 *                          talent holds the required degree level → 2
 *   Experience-years   : up to 2                          (W_EXPERIENCE)
 *                          meets/exceeds required years → 2, within 1y → 1
 *
 * Skill overlap stays dominant: a job's skill weight scales with the number
 * of skills (typically ≫ the 3+3+2+2 = 10 ceiling of the other signals),
 * matching the previous behaviour where skills alone determined the order.
 */

import type {
  TalentEducation,
  TalentLanguage,
  TalentLocation,
  TalentProfile,
  TalentSkill,
  MatchResult,
} from '@/lib/eightvance/types';
import { pLimit } from './concurrency';
import { cached } from './skill-cache';

type VanceClient = {
  talent: {
    getSkills: (id: number) => Promise<TalentSkill[]>;
    getProfile?: (id: number) => Promise<TalentProfile | null>;
    getLocation?: (id: number) => Promise<TalentLocation | null>;
    getLanguages?: (id: number) => Promise<TalentLanguage[]>;
    getEducation?: (id: number) => Promise<TalentEducation[]>;
  };
  listTalentIds: (limit: number) => Promise<number[]>;
};

export interface JobSkillRef {
  id: number;
  name: string;
  must_have: boolean;
}

/**
 * Optional job-side context threaded from the project (location, language,
 * education, experience). Every field is optional: when absent the matching
 * signal is simply not weighed (graceful degradation).
 */
export interface JobMatchContext {
  /** Job location — used for province/country proximity. */
  location?: { province?: string | null; country?: string | null } | null;
  /** Required language labels (e.g. "Dutch", "English"). */
  languages?: string[];
  /** Required education level label (e.g. "HBO", "WO", "Bachelor"). */
  educationLevel?: string | null;
  /** Minimum years of experience the role expects. */
  minYearsExperience?: number | null;
}

// Signal weights (see module doc).
const W_SKILL_MUST = 2;
const W_SKILL_NICE = 1;
const W_LOCATION = 3;
const W_LANGUAGE = 3;
const W_EDUCATION = 2;
const W_EXPERIENCE = 2;

const STOPWORDS = new Set([
  'and', 'or', 'of', 'the', 'a', 'an', 'in', 'for', 'to', 'with', 'en', 'de',
  'het', 'van', 'op', 'skills', 'skill', 'management', // 'management' too common
]);

/** Split a skill name into meaningful lowercase tokens (≥3 chars, no stopwords). */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * A job skill "matches" a talent skill when either name contains the other
 * (substring) or they share a meaningful token. This is deliberately fuzzy:
 * a recruiter asking for "Project management" should match a talent whose
 * skill is "International project management".
 */
function skillMatches(jobName: string, talentTokenSet: Set<string>, talentNames: string[]): boolean {
  const jn = jobName.toLowerCase().trim();
  if (!jn) return false;
  for (const tn of talentNames) {
    if (tn.includes(jn) || jn.includes(tn)) return true;
  }
  const jobTokens = tokenize(jobName);
  return jobTokens.some((t) => talentTokenSet.has(t));
}

function norm(s: string | null | undefined): string {
  return (s ?? '').toString().trim().toLowerCase();
}

/**
 * Location proximity score (0..W_LOCATION). Same province (region) is the
 * strongest signal; same country a weaker one. Comparison is case-insensitive
 * substring-tolerant (8vance region labels vary). Returns 0 when the job has
 * no location at all.
 */
function locationScore(
  job: JobMatchContext['location'],
  loc: TalentLocation | null,
): number {
  if (!job || !loc) return 0;
  const jProv = norm(job.province);
  const jCountry = norm(job.country);
  const tProv = norm(loc.region);
  const tCountry = norm(loc.country);
  if (jProv && tProv && (jProv === tProv || tProv.includes(jProv) || jProv.includes(tProv))) {
    return W_LOCATION;
  }
  if (jCountry && tCountry && (jCountry === tCountry || tCountry.includes(jCountry) || jCountry.includes(tCountry))) {
    return W_LOCATION * 0.5;
  }
  return 0;
}

/**
 * Language score (0..W_LANGUAGE): fraction of required languages the talent
 * speaks, scaled to the weight. Matching is by case-insensitive name; numeric
 * language ids (unresolved) are ignored on the talent side.
 */
function languageScore(required: string[] | undefined, langs: TalentLanguage[]): number {
  const req = (required ?? []).map(norm).filter((l) => l.length > 0);
  if (req.length === 0) return 0;
  const have = new Set(
    langs
      .map((l) => norm(typeof l.language_name === 'string' ? l.language_name : ''))
      .filter((l) => l.length > 0 && !/^\d+$/.test(l)),
  );
  if (have.size === 0) return 0;
  let hit = 0;
  for (const r of req) {
    for (const h of have) {
      if (h === r || h.includes(r) || r.includes(h)) {
        hit += 1;
        break;
      }
    }
  }
  return (hit / req.length) * W_LANGUAGE;
}

/**
 * Education score (0..W_EDUCATION): the talent holds an education entry whose
 * level label matches the required level (substring-tolerant — "HBO Bachelor"
 * satisfies "HBO"). Returns 0 when the job specifies no education preference.
 */
function educationScore(required: string | null | undefined, edu: TalentEducation[]): number {
  const req = norm(required);
  if (!req) return 0;
  for (const e of edu) {
    const level = norm(e.degree?.phrase ?? (e.education_degree != null ? String(e.education_degree) : ''));
    if (level && (level === req || level.includes(req) || req.includes(level))) {
      return W_EDUCATION;
    }
  }
  return 0;
}

/**
 * Years-of-experience score (0..W_EXPERIENCE): full weight when the talent
 * meets/exceeds the required years, half when within 1 year, else 0. Returns 0
 * when the job specifies no minimum.
 */
function experienceScore(minYears: number | null | undefined, talentYears: number | null): number {
  if (minYears == null || !Number.isFinite(minYears) || minYears <= 0) return 0;
  if (talentYears == null || !Number.isFinite(talentYears)) return 0;
  if (talentYears >= minYears) return W_EXPERIENCE;
  if (talentYears >= minYears - 1) return W_EXPERIENCE * 0.5;
  return 0;
}

const SCAN_LIMIT = Number.parseInt(process.env.MATCH_FALLBACK_SCAN ?? '80', 10);

// Bounded fan-out for per-talent sub-resource fetches.
//
// The 8vance rate-limiter (client.ts → ratelimit.ts) is the hard throughput
// cap: it SERIALISES acquires per (clientId, endpointKey) bucket at 55/min, so
// concurrency above the bucket's burst just queues — it never produces 429s.
// We pick 8 (was 3) to (a) drain the initial 55-token burst ~8-wide instead of
// 3-wide and (b) overlap network round-trip latency across the four optional
// sub-resource buckets (skill/location/language/education/profile each have
// their OWN bucket, so they run truly in parallel). 8 maximises throughput
// without risking the rate cap. Override via MATCH_FALLBACK_CONCURRENCY.
function readConcurrency(): number {
  const raw = process.env.MATCH_FALLBACK_CONCURRENCY;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 1) return n;
  }
  return 8;
}
const CONCURRENCY = readConcurrency();

/**
 * Optional streaming hook. Invoked with each freshly-scored batch of results
 * (already score-desc within the batch) AS the scan progresses, so the caller
 * can persist + render partial cards within seconds instead of waiting for the
 * whole pool scan to finish. Best-effort: a throwing callback must never sink
 * the scan, so the caller is expected to guard it (we also await it defensively).
 */
export type FallbackPartial = (batch: MatchResult[]) => void | Promise<void>;

export interface FallbackOptions {
  /** Job-side context (location/language/education/experience). */
  ctx?: JobMatchContext;
  /** Tenant id for per-tenant sub-resource cache scoping. */
  tenantId?: string;
  /**
   * Streaming sink: called with each scored batch (score-desc) as it lands so
   * partial cards can be rendered immediately. The final return value still
   * contains the full ranked top-N (so existing callers keep working).
   */
  onPartial?: FallbackPartial;
  /**
   * Stop the scan EARLY once at least this many scoring (>0) candidates have
   * been found — bounds the wall-clock for the common case where the role has
   * plenty of matches near the top of the pool. Defaults to `topN`. Set to 0/
   * undefined to scan the whole bounded pool.
   */
  earlyExitAfter?: number;
}

/**
 * Rank up to `topN` talents from the pool by a weighted blend of skill
 * overlap, location proximity, language, education, and experience.
 *
 * Skills are matched by NAME (token/substring), not taxonomy id: 8vance has
 * many duplicate ids for the same concept, so id-equality misses most real
 * overlaps. Returns MatchResult rows so hydrate treats them like native
 * matches.
 *
 * `ctx` is optional; absent job signals are not weighed (graceful
 * degradation). Sub-resources for the extra signals are only fetched when the
 * job actually specifies that signal AND the client exposes the getter — so a
 * pure skills-only job makes exactly the same calls as before.
 *
 * STREAMING + EARLY-EXIT: when `opts.onPartial` is supplied, scored results are
 * emitted in batches (score-desc within each batch) AS they are computed — the
 * caller persists them so cards appear within seconds instead of after the
 * whole pool scan. `opts.earlyExitAfter` stops the scan once enough scoring
 * candidates are found, killing the "scan all 80 then return" wall-clock for
 * roles that have plenty of matches near the top of the pool.
 *
 * Back-compat: the legacy positional signature `(client, jobSkills, topN, ctx,
 * tenantId)` still works — the 4th arg may be a `JobMatchContext` (old) or a
 * `FallbackOptions` (new), and the 5th positional `tenantId` is honoured.
 */
export async function fallbackMatch(
  client: VanceClient,
  jobSkills: JobSkillRef[],
  topN = 25,
  ctxOrOpts: JobMatchContext | FallbackOptions = {},
  tenantIdArg?: string,
): Promise<MatchResult[]> {
  // Disambiguate the overloaded 4th arg: a FallbackOptions carries one of the
  // option-only keys; otherwise treat it as the legacy JobMatchContext.
  const isOpts =
    'ctx' in ctxOrOpts ||
    'onPartial' in ctxOrOpts ||
    'earlyExitAfter' in ctxOrOpts ||
    'tenantId' in ctxOrOpts;
  const opts: FallbackOptions = isOpts ? (ctxOrOpts as FallbackOptions) : {};
  const ctx: JobMatchContext = isOpts
    ? (opts.ctx ?? {})
    : (ctxOrOpts as JobMatchContext);
  const tenantId = opts.tenantId ?? tenantIdArg;
  const onPartial = opts.onPartial;
  const earlyExitAfter =
    typeof opts.earlyExitAfter === 'number' && opts.earlyExitAfter > 0
      ? opts.earlyExitAfter
      : topN;
  const mustHave = jobSkills.filter((s) => s.must_have && s.name).map((s) => s.name);
  const niceToHave = jobSkills.filter((s) => !s.must_have && s.name).map((s) => s.name);

  // Which extra signals does the job actually specify? Only these count
  // toward the denominator (so they can't penalise when absent) and only
  // these trigger the corresponding sub-resource fetch.
  const wantLocation =
    !!ctx.location && (!!norm(ctx.location.province) || !!norm(ctx.location.country)) && !!client.talent.getLocation;
  const wantLanguage = (ctx.languages?.some((l) => norm(l)) ?? false) && !!client.talent.getLanguages;
  const wantEducation = !!norm(ctx.educationLevel) && !!client.talent.getEducation;
  const wantExperience =
    ctx.minYearsExperience != null &&
    Number.isFinite(ctx.minYearsExperience) &&
    ctx.minYearsExperience > 0 &&
    !!client.talent.getProfile;

  // Denominator: only signals present for THIS job.
  const skillMax = mustHave.length * W_SKILL_MUST + niceToHave.length * W_SKILL_NICE;
  const maxPossible =
    (skillMax || (wantLocation || wantLanguage || wantEducation || wantExperience ? 0 : 1)) +
    (wantLocation ? W_LOCATION : 0) +
    (wantLanguage ? W_LANGUAGE : 0) +
    (wantEducation ? W_EDUCATION : 0) +
    (wantExperience ? W_EXPERIENCE : 0) || 1;

  const scanLimit = Number.isFinite(SCAN_LIMIT) && SCAN_LIMIT > 0 ? SCAN_LIMIT : 80;
  const talentIds = await client.listTalentIds(scanLimit);

  // Memoise each sub-resource fetch per (tenant, talentId, resource) for a
  // short TTL so re-runs / re-matches / poller remounts don't re-pay the full
  // rate-limited scan. When `tenantId` is absent (e.g. unit tests) the helper
  // falls back to a process-wide key — still safe, just less precisely scoped.
  const cacheTenant = tenantId ?? '_';
  const fetchSkills = (id: number) => cached(cacheTenant, id, 'skill', () => client.talent.getSkills(id));
  const fetchLocation = (id: number) =>
    cached(cacheTenant, id, 'location', () => client.talent.getLocation!(id)).catch(() => null);
  const fetchLanguages = (id: number) =>
    cached(cacheTenant, id, 'language', () => client.talent.getLanguages!(id)).catch(() => [] as TalentLanguage[]);
  const fetchEducation = (id: number) =>
    cached(cacheTenant, id, 'education', () => client.talent.getEducation!(id)).catch(() => [] as TalentEducation[]);
  const fetchProfile = (id: number) =>
    cached(cacheTenant, id, 'profile', () => client.talent.getProfile!(id)).catch(() => null);

  const limit = pLimit(CONCURRENCY);

  // Score one talent → a MatchResult (or null when it has no positive signal).
  const scoreOne = async (talentId: number): Promise<MatchResult | null> => {
    try {
      const [skills, location, languages, education, profile] = await Promise.all([
        fetchSkills(talentId),
        wantLocation ? fetchLocation(talentId) : Promise.resolve(null),
        wantLanguage ? fetchLanguages(talentId) : Promise.resolve([] as TalentLanguage[]),
        wantEducation ? fetchEducation(talentId) : Promise.resolve([] as TalentEducation[]),
        wantExperience ? fetchProfile(talentId) : Promise.resolve(null),
      ]);

      const talentNames = skills
        .map((s) => (typeof s.skill_name === 'string' ? s.skill_name.toLowerCase().trim() : ''))
        .filter((n) => n.length > 0);
      const talentTokens = new Set(talentNames.flatMap((n) => tokenize(n)));

      let earned = 0;
      for (const jn of mustHave) if (skillMatches(jn, talentTokens, talentNames)) earned += W_SKILL_MUST;
      for (const jn of niceToHave) if (skillMatches(jn, talentTokens, talentNames)) earned += W_SKILL_NICE;

      if (wantLocation) earned += locationScore(ctx.location, location);
      if (wantLanguage) earned += languageScore(ctx.languages, languages);
      if (wantEducation) earned += educationScore(ctx.educationLevel, education);
      if (wantExperience) {
        const ty =
          typeof profile?.total_years_experience === 'number'
            ? profile.total_years_experience
            : typeof profile?.total_years_experience === 'string'
              ? Number(profile.total_years_experience)
              : null;
        earned += experienceScore(ctx.minYearsExperience, ty);
      }

      if (earned <= 0) return null;
      const score = Math.round((earned / maxPossible) * 100);
      return { talent_id: talentId, score: Math.min(100, Math.max(0, score)) };
    } catch {
      return null;
    }
  };

  // Process the pool in CHUNKS (one chunk = `CONCURRENCY` talents). After each
  // chunk we (a) emit any newly-scored rows to `onPartial` so the caller can
  // persist + render partial cards within seconds, and (b) check the early-exit
  // budget. This kills the old "fan everything out, return only at the end"
  // wall-clock: the FIRST card now lands after the first chunk resolves (a
  // couple of seconds) instead of after the entire bounded scan.
  const all: MatchResult[] = [];
  let foundScoring = 0;
  for (let i = 0; i < talentIds.length; i += CONCURRENCY) {
    const chunk = talentIds.slice(i, i + CONCURRENCY);
    const chunkScored = (await Promise.all(chunk.map((id) => limit(() => scoreOne(id)))))
      .filter((r): r is MatchResult => r !== null)
      // Score-desc WITHIN the batch so the stream is best-first per chunk.
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    if (chunkScored.length > 0) {
      all.push(...chunkScored);
      foundScoring += chunkScored.length;
      if (onPartial) {
        try {
          await onPartial(chunkScored);
        } catch {
          // A failing sink must never sink the scan.
        }
      }
    }

    // Early-exit: once we have enough scoring candidates, stop paying for the
    // rest of the bounded pool. The final sort+slice below still returns the
    // best topN of everything gathered so far.
    if (foundScoring >= earlyExitAfter) break;
  }

  return all
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, topN);
}
