/**
 * Normalize a raw `JobMatchResult` (inverse match: jobs for a talent) into a
 * stable shape the candidate-match UI + staffing classifier consume.
 *
 * VERIFIED against the live IVTA (PROD) API:
 *  - `POST /match/job/?talent_id=` rows carry `company:{id,name}` + `score` +
 *    an int `contract_type`, but NO `source`/`description`/`is_intermediary`.
 *  - `GET /job/{id}/extended/` adds `description`, `source` (slug), and
 *    `hiring_company_*` (set when the posting company recruits on behalf of a
 *    different employer = the intermediary signal). The enrichment step folds
 *    those in via `mergeExtended`.
 */
import type { JobMatchResult, JobExtended } from "../eightvance/types";

export interface NormalizedJobMatch {
  jobId: number;
  score: number;
  title: string;
  employerName: string | null;
  /** Posting company id — own-pool jobs == the tenant company. */
  employerCompanyId: number | null;
  source: string | null;
  contractType: string | null;
  description: string | null;
  isIntermediary: boolean | null;
  locationCity: string | null;
  locationLabel: string | null;
  /** Filter facets folded in from /job/{id}/extended/. */
  remote: boolean | null;
  /** ISO publication timestamp, for the recency filter. */
  publishedAt: string | null;
  /**
   * Coarse server-computed travel-time buckets from the candidate's (transient,
   * never-persisted) origin to this job's location. Bucket labels only — never
   * coords or minutes. Absent on legacy rows / jobs without coords (= unknown).
   */
  travel?: import("@/lib/anonymize/types").TravelBuckets;
  /**
   * Job coordinates (from /job/{id}/extended/), persisted so the match view can
   * plot jobs on a map. Only the enriched top-N carry these; absent otherwise.
   */
  lat?: number;
  lng?: number;
  /**
   * Salary + working-hours range from `/job/{id}/extended/` (verified live: the
   * fields exist + read even for JobDigger feed jobs via `?context=`). Salary is
   * often null on aggregator feeds (JobDigger doesn't provide it); working hours
   * are usually populated. Absent when the row wasn't enriched.
   */
  salaryLow?: number | null;
  salaryHigh?: number | null;
  hoursMin?: number | null;
  hoursMax?: number | null;
}

function companyObj(v: JobMatchResult["company"]): { id: number | null; name: string | null } {
  if (v == null) return { id: null, name: null };
  if (typeof v === "string") return { id: null, name: v || null };
  return { id: typeof v.id === "number" ? v.id : null, name: v.name ?? null };
}

function pickSource(v: JobMatchResult["source"]): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v || null;
  return v.name ?? v.display_name ?? null;
}

/**
 * Whether a matched job's LIST score (from `/match/job/`) is trustworthy to show
 * as a percentage.
 *
 * The degenerate value is the SENTINEL `score:1` that `/match/job/` hands back
 * for cross-company jobs it can't grade (→ a candidate falsely shows 100% on
 * unrelated vacancies). Everything else — including the real fractional scores a
 * source-specific match returns for ecosystem jobs (e.g. 19.97) — is genuine and
 * MUST be shown immediately, not hidden behind a detail-open.
 *
 * So a score is reliable when it's an OWN-POOL job (always trustworthy, even a
 * true 100%) OR the score is a real number that isn't the `1` sentinel. Only an
 * exactly-`1` cross-company score is treated as degenerate (hidden → the real
 * graded score is computed on detail-open via `/match/specific/`).
 */
export function matchScoreReliable(
  employerCompanyId: number | null | undefined,
  ownCompanyId: number | null | undefined,
  score?: number | null,
): boolean {
  if (
    employerCompanyId != null &&
    ownCompanyId != null &&
    employerCompanyId === ownCompanyId
  ) {
    return true;
  }
  return typeof score === "number" && score !== 1;
}

export function normalizeJobMatch(raw: JobMatchResult): NormalizedJobMatch {
  const jobId = Number(raw.job_id ?? raw.id ?? 0);
  const company = companyObj(raw.company);
  const employerName =
    (typeof raw.employer_name === "string" && raw.employer_name) ||
    (typeof raw.company_name === "string" && raw.company_name) ||
    company.name ||
    null;
  const isIntermediary =
    typeof raw.is_intermediary === "boolean" ? raw.is_intermediary : null;
  const locationCity = raw.location?.city ?? null;
  const locationLabel = raw.location?.label ?? raw.location_label ?? null;

  return {
    jobId,
    score: typeof raw.score === "number" ? raw.score : 0,
    title: (typeof raw.title === "string" && raw.title) || "Untitled",
    employerName,
    employerCompanyId: company.id,
    source: pickSource(raw.source),
    // The match-result contract_type is an int enum with no agency-specific
    // value, so we don't surface it as a string signal here.
    contractType: typeof raw.contract_type === "string" ? raw.contract_type : null,
    description: typeof raw.description === "string" ? raw.description : null,
    isIntermediary,
    locationCity,
    locationLabel,
    remote: null,
    publishedAt: null,
  };
}

/**
 * Fold `/job/{id}/extended/` fields into an already-normalized row: adds the
 * description + source slug, and derives `isIntermediary` when the posting
 * company recruits on behalf of a different hiring company.
 */
export function mergeExtended(n: NormalizedJobMatch, ext: JobExtended): NormalizedJobMatch {
  const extCompanyId = ext.company?.id ?? null;
  const hiringId = typeof ext.hiring_company_id === "number" ? ext.hiring_company_id : null;
  // Intermediary when an explicit hiring company is shown that differs from the
  // posting company (the poster is placing on behalf of someone else).
  const intermediary =
    (ext.display_hiring_company_information === true && !!ext.hiring_company_label) ||
    (hiringId !== null && extCompanyId !== null && hiringId !== extCompanyId)
      ? true
      : n.isIntermediary;

  const remote =
    typeof ext.work_remotely === "boolean" ? ext.work_remotely : n.remote;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const published =
    (typeof ext.time_published === "string" && ext.time_published) ||
    (typeof ext.activated_at === "string" && ext.activated_at) ||
    n.publishedAt;

  return {
    ...n,
    description: ext.description ?? n.description,
    source: ext.source ?? n.source,
    employerName: ext.company?.name ?? n.employerName,
    employerCompanyId: n.employerCompanyId ?? extCompanyId,
    isIntermediary: intermediary,
    remote,
    publishedAt: published,
    locationCity: n.locationCity ?? ext.location?.city ?? ext.detailed_location?.city ?? null,
    salaryLow: num(ext.salary_low) ?? n.salaryLow ?? null,
    salaryHigh: num(ext.salary_high) ?? n.salaryHigh ?? null,
    hoursMin: num(ext.working_hours_minimum) ?? n.hoursMin ?? null,
    hoursMax: num(ext.working_hours_maximum) ?? n.hoursMax ?? null,
  };
}
