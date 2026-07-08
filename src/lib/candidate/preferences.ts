/**
 * Candidate work-preferences — the "recruiter's head" data that a CV does NOT
 * contain but that decides whether a match is actually relevant: how far the
 * candidate will travel, in which regions they want to work, what they want to
 * earn, how many hours, when they can start, office vs remote, and whether
 * they'd relocate.
 *
 * These are captured at onboarding (recruiter wizard + self-onboard portal) and
 * persisted on `Candidate.preferencesJson`. Everything here is OPTIONAL and
 * additive — the legacy `{sources, contractTypes, radiusKm, remote}` shape stays
 * valid, so old rows and old clients keep working. New readers use the derived
 * helpers (`effectiveTravelKm`, `normalizePreferences`) rather than the raw
 * fields so the legacy → v2 fallback lives in exactly one place.
 */
import { z } from 'zod';

export const CONTRACT_TYPES = ['permanent', 'temporary', 'uitzend', 'interim'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const WORK_MODES = ['office', 'hybrid', 'remote'] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const SALARY_PERIODS = ['hour', 'month', 'year'] as const;
export type SalaryPeriod = (typeof SALARY_PERIODS)[number];

export const AVAILABILITIES = ['immediate', 'two_weeks', 'one_month', 'two_months', 'three_plus'] as const;
export type Availability = (typeof AVAILABILITIES)[number];

/** A desired work region (province / area), optionally geocoded to a centre. */
export interface WorkRegion {
  label: string;
  latitude?: number;
  longitude?: number;
}

export interface SalaryExpectation {
  min?: number;
  max?: number;
  period: SalaryPeriod;
}

export interface CandidatePreferences {
  /** Match source slugs (own pool + feeds). Empty = server default. */
  sources: string[];
  contractTypes: ContractType[];
  /** Legacy travel radius. Kept for back-compat; superseded by maxTravelKm. */
  radiusKm: number;
  /** Legacy remote flag. Kept for back-compat; superseded by workMode. */
  remote: boolean;
  locationCity?: string;

  // ---- v2 "recruiter's head" fields (all optional) ----
  /** How far the candidate will travel to work, in km. Drives the match radius. */
  maxTravelKm?: number;
  /** Regions the candidate WANTS to work in (may differ from home location). */
  workRegions?: WorkRegion[];
  salary?: SalaryExpectation;
  /** Desired hours per week (e.g. 32, 40). */
  hoursPerWeek?: number;
  workMode?: WorkMode;
  availability?: Availability;
  willingToRelocate?: boolean;
  /** Free-text recruiter context / dealbreakers that don't fit a field. */
  recruiterNotes?: string;
}

// ---------------------------------------------------------------------------
// Education-level → travel-willingness heuristic
// ---------------------------------------------------------------------------

/**
 * Coarse education tiers, highest wins. Higher-educated candidates are (per the
 * recruiter's rule of thumb) willing to commute further: an MBO candidate rarely
 * drives an hour, an HBO/WO candidate usually will.
 */
export type EduTier = 'basic' | 'secondary' | 'mbo' | 'hbo' | 'wo';

const TIER_RANK: Record<EduTier, number> = { basic: 0, secondary: 1, mbo: 2, hbo: 3, wo: 4 };

/** Default max travel (km) per tier — the "won't drive an hour" heuristic. */
const TIER_TRAVEL_KM: Record<EduTier, number> = {
  basic: 25,
  secondary: 30,
  mbo: 35,
  hbo: 65,
  wo: 85,
};

/** Fallback radius when neither a preference nor an education signal exists. */
export const DEFAULT_TRAVEL_KM = 50;
/** ES-safety clamp: never bound a large open-market feed beyond this. */
export const MIN_TRAVEL_KM = 10;
export const MAX_TRAVEL_KM = 100;

/** Classify a degree phrase (NL/EN, taxonomy or free text) into a tier. */
export function eduTierFromDegree(degree: string | null | undefined): EduTier | null {
  const d = (degree ?? '').toLowerCase().trim();
  if (!d) return null;
  if (/(phd|doctor|wo\b|master of|bachelor of|universit|\bwo master\b|\bwo bachelor\b|master's|msc|\bma\b|\bmsc\b|\bbsc\b)/.test(d)) {
    // "Master of Science" / "WO Master" / university → wo. But an HBO Master is HBO.
    if (/hbo/.test(d)) return 'hbo';
    return 'wo';
  }
  if (/hbo|hogeschool|associate degree|post hbo/.test(d)) return 'hbo';
  if (/mbo|post mbo/.test(d)) return 'mbo';
  if (/havo|vwo|vmbo|mavo|vbo|lts|middelbare/.test(d)) return 'secondary';
  if (/basis|praktijk|speciaal onderwijs/.test(d)) return 'basic';
  return null;
}

/** Highest tier across a list of parsed education entries. */
export function highestEduTier(
  education: Array<{ degree?: string | null }> | null | undefined,
): EduTier | null {
  let best: EduTier | null = null;
  for (const e of education ?? []) {
    const tier = eduTierFromDegree(e?.degree);
    if (tier && (best === null || TIER_RANK[tier] > TIER_RANK[best])) best = tier;
  }
  return best;
}

/** Default travel km for an education tier (null → global default). */
export function travelDefaultForTier(tier: EduTier | null): number {
  return tier ? TIER_TRAVEL_KM[tier] : DEFAULT_TRAVEL_KM;
}

/**
 * The match-view travel-time FACET default per tier (the recruiter's rule of
 * thumb "an HBO/WO candidate will drive an hour; an MBO/lower candidate won't —
 * think a 15-min bike ride"). `mode` is the travel mode to pre-select and `max`
 * is the max-time bucket. Null tier → no default (facet stays off).
 */
export type TravelFacetDefault = { mode: 'car' | 'bike'; max: 'lt15' | 'lt30' | 'lt45' | 'lt60' };
export function travelFacetDefaultForTier(tier: EduTier | null): TravelFacetDefault | null {
  if (tier === 'hbo' || tier === 'wo') return { mode: 'car', max: 'lt60' };
  if (tier === 'mbo' || tier === 'secondary' || tier === 'basic') return { mode: 'bike', max: 'lt15' };
  return null;
}

const BUCKET_MINUTES: Record<TravelFacetDefault['max'], number> = {
  lt15: 15,
  lt30: 30,
  lt45: 45,
  lt60: 60,
};

/**
 * The two education heuristics as ONE statement for the UI, so the recruiter
 * sees why the radius + travel facet are pre-set (e.g. "up to 65 km / ~60 min by
 * car"). Combines `travelDefaultForTier` (km bound) with the travel-time facet
 * default. Null when the tier carries no default.
 */
export function educationTravelStatement(
  tier: EduTier | null,
): { km: number; minutes: number; mode: 'car' | 'bike' } | null {
  const facet = travelFacetDefaultForTier(tier);
  if (!tier || !facet) return null;
  return { km: travelDefaultForTier(tier), minutes: BUCKET_MINUTES[facet.max], mode: facet.mode };
}

/** Clamp a travel radius into the ES-safe range. */
export function clampTravelKm(km: number): number {
  if (!Number.isFinite(km) || km <= 0) return DEFAULT_TRAVEL_KM;
  return Math.max(MIN_TRAVEL_KM, Math.min(MAX_TRAVEL_KM, Math.round(km)));
}

/**
 * The radius the MATCH should actually use, resolving the precedence:
 *   1. explicit `maxTravelKm` preference
 *   2. legacy non-zero `radiusKm` preference
 *   3. education-level default (the recruiter heuristic)
 *   4. global default (50)
 * …then clamped into [MIN, MAX] so a large feed is never bounded unsafely.
 */
export function effectiveTravelKm(
  prefs: Partial<CandidatePreferences> | null | undefined,
  eduTier: EduTier | null = null,
): number {
  const explicit = prefs?.maxTravelKm;
  if (typeof explicit === 'number' && explicit > 0) return clampTravelKm(explicit);
  const legacy = prefs?.radiusKm;
  if (typeof legacy === 'number' && legacy > 0) return clampTravelKm(legacy);
  return clampTravelKm(travelDefaultForTier(eduTier));
}

// ---------------------------------------------------------------------------
// Zod schema (server-side validation) + normalization
// ---------------------------------------------------------------------------

export const workRegionSchema = z.object({
  label: z.string().min(1).max(120),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

export const salarySchema = z.object({
  min: z.number().int().min(0).max(10_000_000).optional(),
  max: z.number().int().min(0).max(10_000_000).optional(),
  period: z.enum(SALARY_PERIODS),
});

/**
 * Full preferences schema — legacy fields required (defaults supplied by the
 * form), v2 fields optional. Use this in place of the old inline schema.
 */
export const candidatePreferencesSchema = z.object({
  sources: z.array(z.string().min(1).max(120)).optional().default([]),
  contractTypes: z.array(z.enum(CONTRACT_TYPES)),
  radiusKm: z.number().int().min(0).max(500),
  remote: z.boolean(),
  locationCity: z.string().max(120).optional(),
  // v2
  maxTravelKm: z.number().int().min(0).max(500).optional(),
  workRegions: z.array(workRegionSchema).max(12).optional(),
  salary: salarySchema.optional(),
  hoursPerWeek: z.number().int().min(1).max(80).optional(),
  workMode: z.enum(WORK_MODES).optional(),
  availability: z.enum(AVAILABILITIES).optional(),
  willingToRelocate: z.boolean().optional(),
  recruiterNotes: z.string().max(2000).optional(),
});

export type CandidatePreferencesInput = z.infer<typeof candidatePreferencesSchema>;

/**
 * Fill in derived defaults at persist time: when the recruiter didn't set a
 * travel radius, seed `maxTravelKm` from the candidate's highest education tier
 * so the match immediately honours the heuristic. Idempotent.
 */
export function withTravelDefault(
  prefs: CandidatePreferencesInput,
  education: Array<{ degree?: string | null }> | null | undefined,
): CandidatePreferencesInput {
  const hasExplicit =
    (typeof prefs.maxTravelKm === 'number' && prefs.maxTravelKm > 0) ||
    (typeof prefs.radiusKm === 'number' && prefs.radiusKm > 0);
  if (hasExplicit) return prefs;
  const tier = highestEduTier(education);
  if (!tier) return prefs;
  return { ...prefs, maxTravelKm: travelDefaultForTier(tier) };
}
