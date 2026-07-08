/**
 * 8vance public REST API type definitions.
 *
 * Ported from `allesio-dashboard/bff/app/clients/vance_pipeline.py`. Shapes
 * reflect real PROD responses documented in `docs/8vance-api-prod.md` and
 * gap callouts in `docs/8vance-api-gaps.md` (#2 import shell, #4 skill vs
 * skill_id, #6 sources required, #9 paginated vs flat array, #18 feedback
 * scope drift).
 *
 * Conventions:
 *   - All ids are integers on the wire.
 *   - `function_name` is INT on write, may come back as INT or string label
 *     on read (quirk #1).
 *   - location lat/lon are STRINGS on write (quirk #4).
 *   - Job-skill payload uses `skill` (singular), talent-skill uses
 *     `skill_id` (quirk #2 / gap #4).
 */

/** OAuth2 client_credentials response. */
export interface TokenResponse {
  access: string;
  refresh?: string;
}

/** Minimal job reference (list/snapshot views). */
export interface JobRef {
  id: number;
  title?: string | null;
  company?: number | null;
  status?: number | null;
  /** Quirk #1: int on write, int OR string label on read. */
  function_name?: number | string | null;
}

/** Detail view of a job — superset of JobRef, additional optional fields. */
export interface JobDetail extends JobRef {
  function_level?: number | null;
  description?: string | null;
  contract_type?: number | null;
  detailed_location?: DetailedLocation | null;
  [extra: string]: unknown;
}

/** Detailed-location object embedded in job create. */
export interface DetailedLocation {
  city: string;
  country: string;
  language_code: string;
  /** Quirk #4: serializer rejects floats — both must be strings. */
  latitude: string;
  longitude: string;
  [extra: string]: unknown;
}

/** Skill row attached to a job create body. */
export interface JobSkillInput {
  /** Quirk #2: field is `skill` (singular) on JOB sub-resource. */
  skill: number;
  proficiency_id: number;
  must_have: boolean;
  experience?: number;
}

/**
 * Row from paginated `GET /job/{id}/skill/` (the job's REQUIRED skills).
 * Mirrors the talent-skill read shape: `skill` is the taxonomy id, and the
 * backend serializer usually folds the resolved name in as `skill_name`/`name`
 * (best-effort — we fall back to id-based matching when it's absent).
 */
export interface JobSkill {
  /** Junction-record id. */
  id?: number;
  /** Taxonomy id (matched against a talent skill's `skill`). Gap #4. */
  skill: number;
  /** Inline resolved name when the serializer provides it. */
  skill_name?: string | null;
  name?: string | null;
  proficiency_id?: number | null;
  must_have?: boolean | null;
  experience?: number | null;
  [extra: string]: unknown;
}

/** Payload for `POST /job/`. */
export interface JobCreatePayload {
  company: number;
  title: string;
  function_level: number;
  /** Quirk #1: int on write. */
  function_name: number;
  source?: number;
  status: number;
  detailed_location: DetailedLocation;
  /** Validated >= 3 in client.job.create. */
  skills: JobSkillInput[];
  description?: string;
  contract_type?: number;
  seniority?: number;
  /**
   * Language requirements. Attached as `/job/{id}/language/` sub-resources
   * (FLAT-array endpoint). Wire body is `{ language, read_level, write_level,
   * speak_level }` — see {@link JobLanguageInput}. `proficiency_id` is the
   * wizard-side level (1..5); the client maps it onto read/write/speak.
   */
  languages?: JobLanguageInput[];
  /**
   * Education-degree requirements. Attached as `/job/{id}/education_degree/`
   * sub-resources (underscore endpoint, FLAT array). Wire body keys on
   * `degree_id` — see {@link JobEducationDegreeInput}.
   */
  education_degrees?: JobEducationDegreeInput[];
  experience_functions?: Array<{ experience_function: number; years?: number }>;
}

/**
 * Job language requirement (input side). The `/job/{id}/language/` endpoint
 * wants `language` (taxonomy id) plus per-skill levels 0..5. We keep an
 * optional `proficiency_id` (1..5 wizard scale) the client expands into the
 * three level fields when explicit levels are not supplied.
 */
export interface JobLanguageInput {
  /** Language taxonomy id from `/resources/language/`. */
  language: number;
  /** Wizard proficiency scale (1..5); expanded to read/write/speak levels. */
  proficiency_id?: number;
  read_level?: number;
  write_level?: number;
  speak_level?: number;
}

/**
 * `GET /match/specific/?job_id=&talent_id=&lead=&gap_analysis=true` — the
 * per-pair gap analysis. VERIFIED live: this works CROSS-COMPANY (a job owned
 * by another 8vance company, matched under our client_credentials via the
 * talent) where `/job/{id}/skill/` 403s — the match/gap path is gated
 * separately from direct job ownership. It also returns the REAL graded score
 * (`match_result.score`, 0..1), unlike the coarse `score:1` the `/match/job/`
 * list can hand back for cross-company feed jobs.
 */
export interface SpecificMatchSkillCluster {
  /** Skill-cluster / field-of-work label (e.g. "Construction, Tile Work"). */
  cluster?: string | null;
  /** 0..1 cluster overlap score. */
  score?: number | null;
  /** The job's skills in this cluster that overlap the talent (named). */
  overlapping_skills?: Array<{ term_id?: number; name?: string | null }> | null;
}
export interface SpecificMatchSplitScore {
  hard_skill?: number | null;
  soft_skill?: number | null;
  experience?: number | null;
  education?: number | null;
  ambition?: number | null;
}
export interface SpecificMatch {
  job_id?: number;
  talent_id?: number;
  lead?: string;
  match_result?: {
    score?: number | null;
    split_score?: SpecificMatchSplitScore | null;
  } | null;
  gap_score?: {
    skills?: SpecificMatchSkillCluster[] | null;
    function?: unknown;
    ambition?: unknown;
    education?: unknown;
  } | null;
}

/**
 * Job education-degree requirement (input side). Live API keys on `degree_id`
 * (see `8vance-api-prod.md` §20); `degree_country_id` is optional.
 */
export interface JobEducationDegreeInput {
  /** Education-degree taxonomy id from `/resources/education-degree/`. */
  degree_id: number;
  degree_country_id?: number;
}

/** Handle returned by `POST /async/talent/match/`. */
export interface MatchTaskHandle {
  task_id: string;
}

/** Status snapshot from `GET /async/task-status/`. */
export interface MatchStatus {
  status: "queued" | "processing" | "completed" | "failed" | string;
  state?: string;
  [extra: string]: unknown;
}

/** One row of `GET /async/talent/results/`. */
export interface MatchResult {
  talent_id: number;
  score?: number | null;
  rank?: number | null;
  full_name?: string | null;
  location_label?: string | null;
  top_skills?: string[];
  [extra: string]: unknown;
}

/**
 * One row of `GET /async/job/results/` (inverse match: jobs for a talent).
 * Field names vary by source; we read defensively and normalize downstream.
 */
export interface JobMatchResult {
  job_id?: number;
  id?: number;
  score?: number | null;
  rank?: number | null;
  title?: string | null;
  /** Employer/company can arrive as a string or a nested object. */
  company?: string | { id?: number; name?: string | null; is_intermediary?: boolean | null } | null;
  company_name?: string | null;
  employer_name?: string | null;
  /** Source can be a string or nested {name, display_name}. */
  source?: string | { id?: number; name?: string | null; display_name?: string | null } | null;
  /** In `/match/job/` results this is a small int enum; in extended it's a taxonomy id. */
  contract_type?: string | number | null;
  description?: string | null;
  /** JobDigger/8vance intermediary flag, when exposed. */
  is_intermediary?: boolean | null;
  location?: { city?: string | null; label?: string | null; [k: string]: unknown } | null;
  location_label?: string | null;
  [extra: string]: unknown;
}

/**
 * One row of `GET /feedback/?job_id=&direction=1` — an Applicant-to-project
 * signal (the talent liked/applied to our published job). `applied:true` is a
 * real application; `applied:false` is a like. The talent id can arrive on a
 * couple of differently-named fields depending on the deploy, so we read it
 * defensively in {@link VanceClient.feedback.listApplicants}.
 */
export interface FeedbackRow {
  id?: number | string;
  talent_id?: number | string | null;
  talent?: number | string | null;
  job?: number | string | null;
  job_title?: string | null;
  added_at?: string | null;
  updated_at?: string | null;
  applied?: boolean | null;
  direction?: number | null;
  company?: number | string | null;
  [extra: string]: unknown;
}

/** Normalized inbound-application row returned by `feedback.listApplicants`. */
export interface FeedbackApplicant {
  talentId: number;
  /** When the applicant applied/liked, as an ISO string when 8vance provides it. */
  appliedAt: string | null;
  /** true = a real application; false = a like. */
  applied: boolean;
}

/**
 * `GET /job/{id}/extended/` — verified shape (subset). `company` is the
 * posting employer; when `hiring_company_id` is present and differs, the
 * posting company is acting as an intermediary for that hiring company.
 */
export interface JobExtended {
  id?: number;
  title?: string | null;
  description?: string | null;
  source?: string | null;
  contract_type?: number | null;
  company?: { id?: number; name?: string | null; [k: string]: unknown } | null;
  hiring_company_id?: number | null;
  hiring_company_label?: string | null;
  display_hiring_company_information?: boolean | null;
  location?: { city?: string | null; [k: string]: unknown } | null;
  detailed_location?: { city?: string | null; [k: string]: unknown } | null;
  [extra: string]: unknown;
}

/**
 * Payload to create a talent (`POST /talent/`) for the candidate-match module.
 * Mirrors JobCreatePayload conventions: pre-resolved skill ids, source label.
 */
export interface TalentCreatePayload {
  full_name: string;
  source: string;
  company?: number;
  email?: string | null;
  phone?: string | null;
  /**
   * Free-text "about me" summary (recruiter note or CV-extracted profile blurb).
   * Writable on `POST /talent/` (verified live on ACC — PATCH/POST accepts +
   * persists it). Included in the create wire body when present.
   */
  about_me?: string | null;
  skills: { skill: number; proficiency_id?: number; must_have?: boolean; experience?: number }[];
  languages?: { language: number; read_level?: number; write_level?: number; speak_level?: number; proficiency_id?: number }[];
  detailed_location?: { city?: string; country?: string; latitude?: string | number; longitude?: string | number } | null;
  /**
   * Education history (best-effort sub-resource, see {@link TalentEducationInput}).
   * Attached as `/talent/{id}/education/` rows; each is wrapped in try/catch so
   * an unknown-field 500 never fails the whole talent sync.
   */
  education?: TalentEducationInput[];
  /**
   * Work history (best-effort sub-resource, see {@link TalentExperienceInput}).
   * Attached as `/talent/{id}/job-experience/` rows; same defensive posture.
   */
  experience?: TalentExperienceInput[];
  /**
   * Resolved primary function_name taxonomy id (resolve the candidate's role
   * title via `resources.resolveFunctionName`). When set, talent.create links it
   * onto a functional-area so the talent appears in reverse (job→talent) match —
   * a talent with no linked function_name is invisible to project shortlists.
   */
  functionNameId?: number;
}

/**
 * Single talent-skill add (`POST /talent/{id}/skill/`). Talent-skill rows key on
 * `skill_id` (NOT `skill` — that's the JOB side, quirk #2 / gap #4) and accept
 * only `{skill_id, proficiency_id}` (adding job-skill fields like must_have /
 * experience 500s — verified live on ACC, see talent.create skill loop).
 */
export interface TalentSkillAddInput {
  /** Resolved skill taxonomy id (resolved via `resources.resolveSkills`). */
  skill_id: number;
  /** Proficiency taxonomy id (23..27 → 1..5); defaults to the client's mid value. */
  proficiency_id?: number;
}

/**
 * Editable main-record talent fields (`PATCH /talent/{id}/`). `about_me` is a
 * verified-writable free-text field (see {@link TalentCreatePayload.about_me});
 * `email` / `phone` are the same main-record contact fields the create POST
 * accepts on the wire (see the create() `wire.email` / `wire.phone` mapping).
 * Kept as a partial so the same shape can grow without forcing all fields on
 * every caller — only present keys are sent.
 */
export interface TalentUpdateInput {
  about_me?: string | null;
  email?: string | null;
  phone?: string | null;
}

/**
 * Talent education sub-resource (input side) — best-effort field mapping from the
 * CV parser (degree / field / institution / years). The live `/talent/{id}/education/`
 * write contract is NOT verified end-to-end here; the client only sends the fields
 * below and swallows a 500 on unknown fields. NEEDS LIVE VERIFICATION.
 */
export interface TalentEducationInput {
  /** Free-text degree label (e.g. "BSc"). Sent as `degree` when present. */
  degree?: string | null;
  /** Field of study (e.g. "Electrical engineering"). Sent as `education_type`. */
  field?: string | null;
  /** School / institution name. Sent as `school`. */
  institution?: string | null;
  /** 4-digit start year (string). Mapped to `start_date` = "{year}-01-01". */
  startYear?: string | null;
  /** 4-digit end year (string). Mapped to `end_date` = "{year}-01-01". */
  endYear?: string | null;
}

/**
 * Talent work-experience sub-resource (input side) — best-effort field mapping
 * from the CV parser (title / company / years / current). Posted to
 * `/talent/{id}/job-experience/`. Field names below are a best guess derived from
 * the READ shape ({@link TalentExperience}); the WRITE contract is NOT verified.
 * Each row is wrapped in try/catch. NEEDS LIVE VERIFICATION.
 */
export interface TalentExperienceInput {
  /** Job title (e.g. "Backend Engineer"). Sent as `function_title`. */
  title?: string | null;
  /** Employer name. Sent as `company_name`. */
  company?: string | null;
  /** 4-digit start year (string). Mapped to `start_date` = "{year}-01-01". */
  startYear?: string | null;
  /** 4-digit end year (string). Mapped to `end_date` = "{year}-01-01". */
  endYear?: string | null;
  /** Whether this is the candidate's current role. Sent as `current_job`. */
  current?: boolean | null;
  /** Free-text role summary. Sent as `description`. */
  description?: string | null;
}

/** Canonical talent record from `GET /talent/{id}/`. */
export interface TalentProfile {
  id?: number;
  talent_id?: number | string;
  full_name?: string | null;
  // 8vance stores the name SPLIT (full_name is not a persisted field), so reads
  // echo first_name/last_name — the data-quality check must look at these too.
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  participate_in_matching?: boolean;
  [extra: string]: unknown;
}

/** Row from paginated `GET /talent/{id}/skill/`. */
export interface TalentSkill {
  /** Junction-record id (PATCH/DELETE target). */
  id: number;
  /** Taxonomy id (use as `skill_id` when (re)posting). Gap #4. */
  skill: number;
  proficiency?: number | null;
  proficiency_id?: number | null;
  must_have?: boolean | null;
  experience?: number | null;
  extra_data?: { category?: string; [k: string]: unknown } | null;
  [extra: string]: unknown;
}

/** Row from paginated `GET /talent/{id}/job-experience/`. */
export interface TalentExperience {
  id: number;
  function_name?: number | string | null;
  function_title?: string | null;
  title?: string | null;
  company_name?: string | null;
  industry_type?: string | null;
  current_job?: boolean | null;
  start_date?: string | null;
  end_date?: string | null;
  description?: string | null;
  [extra: string]: unknown;
}

/** Row from paginated `GET /talent/{id}/education/`. */
export interface TalentEducation {
  id: number;
  education_degree?: number | null;
  education_subject?: number | null;
  /** Live data nests the degree label: { id, phrase }. */
  degree?: { id?: number; phrase?: string | null } | null;
  /** Live data field-of-study label, e.g. "Electrical engineering". */
  education_type?: string | null;
  school?: string | null;
  institution?: string | null;
  /** Gap #12: enum semantics conflict between schema and live data. */
  education_status?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  [extra: string]: unknown;
}

/** Row from paginated `GET /talent/{id}/language/`. */
export interface TalentLanguage {
  id: number;
  language?: number | null;
  /** Resolved language label from live data, e.g. "Dutch". */
  language_name?: string | null;
  proficiency_id?: number | null;
  read_level?: number | null;
  write_level?: number | null;
  speak_level?: number | null;
  [extra: string]: unknown;
}

/** Single-object response from `GET /talent/{id}/location/`. */
export interface TalentLocation {
  id?: number;
  city?: string | null;
  country?: string | null;
  region?: string | null;
  language_code?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  [extra: string]: unknown;
}

/** Generic reference-data item (function-level, language, etc.). */
export interface ReferenceItem {
  id: number;
  name?: string | null;
  display_name?: string | null;
  [extra: string]: unknown;
}

/** `/resources/location/?q=` row. */
export interface LocationResult {
  id?: number;
  city?: string;
  country?: string;
  country_name?: string;
  language_code?: string;
  latitude?: string | number;
  longitude?: string | number;
  [extra: string]: unknown;
}

/** DRF-style paginated envelope (`{count, next, previous, results}`). */
export interface PaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}
