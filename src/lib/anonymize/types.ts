/**
 * Talent anonymization type contracts.
 *
 * - `RawTalent`  : input shape, mirrors what we get from 8vance `get_talent`
 *                  + sub-resource calls (skills, experience, education,
 *                  languages, location).
 * - `AnonymizedTalent` : strictly-allowed, PII-stripped shape that is safe to
 *                       cache in `anonymized_payload_json` and ship to the
 *                       browser pre-reveal.
 * - `RevealedTalent` : full profile incl PII, cached server-side in
 *                     `Reveal.pii_payload_json` after credit-spend.
 *
 * See `C:\Users\AlexSpaan\.claude\plans\ik-wil-een-tool-shiny-parnas.md`
 * section "Anonimisering pipeline" for the field rationale.
 */

// ---------------------------------------------------------------------------
// Raw (input from 8vance)
// ---------------------------------------------------------------------------

export interface RawTalentSkill {
  /** 8vance reference-data skill id. */
  skill_id: number;
  /** Resolved skill name (read-side). */
  name?: string;
  /** 8vance proficiency id: 23..27 (Beginner..Expert). */
  proficiency_id?: number | null;
}

export interface RawTalentExperience {
  function_title?: string | null;
  /** Employer / company name — BLOCKED in anon output. */
  company_name?: string | null;
  start_date?: string | null; // ISO date string
  end_date?: string | null;   // ISO date string or null when current
  is_current?: boolean | null;
}

export interface RawTalentEducation {
  level?: string | null;           // 'MBO' | 'HBO' | 'WO' | etc.
  field_of_study_category?: string | null;
  /** School name — BLOCKED in anon output. */
  school_name?: string | null;
  /** Graduation year — BLOCKED in strong-mode anon output. */
  end_year?: number | null;
}

export interface RawTalentLanguage {
  language: string;
  /** 8vance level string (e.g. 'A1','B2','C2','native'). */
  level: string;
}

export interface RawTalentLocation {
  city?: string | null;
  country?: string | null;
  province?: string | null;
  postal_code?: string | null;
  street?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface RawTalent {
  /** 8vance talent id — NEVER passes through to anon output. */
  id: number;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  date_of_birth?: string | null;
  cv_url?: string | null;
  linkedin_url?: string | null;
  photo_url?: string | null;

  function_name?: string | null;     // resolved on read
  function_level?: number | null;
  total_years_experience?: number | null;
  hours_per_week?: number | null;
  /** ISO date when the talent can start, or null when unknown. */
  start_date?: string | null;
  /** Match score 0..100 returned by 8vance. */
  score?: number | null;

  location?: RawTalentLocation | null;
  skills: RawTalentSkill[];
  experience: RawTalentExperience[];
  education: RawTalentEducation[];
  languages: RawTalentLanguage[];
  /**
   * True when the talent's skill sub-resource FETCH FAILED (not "genuinely 0
   * skills"). Lets downstream distinguish "couldn't load — refresh" from "no
   * skills", so a transient 8vance throttle during bulk hydration doesn't bake a
   * misleading "No skill data" into the card. Absent/false = skills are trusted.
   */
  skillsUnavailable?: boolean;
}

// ---------------------------------------------------------------------------
// Anonymized (output to client / cache)
// ---------------------------------------------------------------------------

export type ExperienceYearsBucket = '0-3' | '3-5' | '5-10' | '10+';
export type DurationBucket = '<1y' | '1-3y' | '3-5y' | '5-10y' | '10+y';
export type StartBucket = 'now' | '<30d' | '30-90d' | '>90d' | 'unknown';
export type HoursBucket = 'PT' | 'FT';
export type ProficiencyLabel =
  | '' // unknown / missing / non-canonical proficiency → empty meter (NOT mid)
  | '⭐'
  | '⭐⭐'
  | '⭐⭐⭐'
  | '⭐⭐⭐⭐'
  | '⭐⭐⭐⭐⭐';
export type LanguageLevelLabel = 'basic' | 'business' | 'native';

export interface AnonSkill {
  name: string;
  proficiency_label: ProficiencyLabel;
  must_have_match: boolean;
  gap: boolean;
}

export interface AnonExperience {
  function_title: string;
  sector: string; // broad NACE-ish bucket
  duration_bucket: DurationBucket;
  is_current: boolean;
}

export interface AnonEducation {
  level: string;
  field_of_study_category: string;
}

export interface AnonLanguage {
  language: string;
  speak_level: LanguageLevelLabel;
}

export interface AnonLocation {
  province: string;
  country: string;
}

/**
 * Provenance of `score`:
 *  - 'native'   : 8vance async-match task (the licensed matcher)
 *  - 'sync'     : 8vance synchronous /match/talent/ endpoint
 *  - 'fallback' : our local multi-signal ranker (no 8vance match license)
 * The UI may surface this so a recruiter knows how a score was produced.
 */
export type ScoreSource = 'native' | 'sync' | 'fallback';

/**
 * Coarse travel-time bucket. ≥15-minute granularity by design — NEVER an exact
 * minute count and NEVER a coordinate. The key names here (`car`/`bike`/`ov`)
 * and these string labels carry none of the tokens in `blocklist.ts`, so a
 * `travel` field passes `assertNoPII`.
 *
 *   lt15 : < 15 min   |  lt30 : 15–30 min  |  lt45 : 30–45 min
 *   lt60 : 45–60 min  |  gt60 : > 60 min   |  null : unknown / unreachable
 */
export type TravelBucket = 'lt15' | 'lt30' | 'lt45' | 'lt60' | 'gt60' | null;

export interface TravelBuckets {
  car?: TravelBucket;
  bike?: TravelBucket;
  ov?: TravelBucket;
}

export interface AnonymizedTalent {
  opaque_id: string;
  score: number | null;
  /** Optional provenance tag for `score`; absent on legacy cached rows. */
  score_source?: ScoreSource;
  /**
   * When this talent was found in more than one pool (same underlying
   * 8vance talent id across tenants), the slugs/ids of every source pool.
   * Set at read/aggregation time; absent for single-pool entries.
   */
  source_pools?: string[];
  function_level: number | null;
  total_years_experience_bucket: ExperienceYearsBucket | null;
  hours_per_week_bucket: HoursBucket | null;
  start_within_days: StartBucket;
  location: AnonLocation;
  skills: AnonSkill[];
  /**
   * True when the skill fetch FAILED during hydration (vs the talent genuinely
   * having no skills). The card shows a "couldn't load skills — refresh" note
   * instead of a misleading "No skill data". Absent = skills are trusted.
   */
  skills_unavailable?: boolean;
  experience: AnonExperience[]; // ≤ 3, most recent first
  education: AnonEducation[];
  languages: AnonLanguage[];
  /**
   * Coarse server-computed travel-time buckets from the project's origin to
   * this talent's (transient, never-persisted) location. Bucket labels only —
   * no minutes, no coords. Absent on legacy rows / when the project has no
   * origin coords. `ov` is reserved for a future provider (currently null).
   */
  travel?: TravelBuckets;
}

// ---------------------------------------------------------------------------
// Revealed (after credit-spend)
// ---------------------------------------------------------------------------

export type RevealedTalent = RawTalent;
