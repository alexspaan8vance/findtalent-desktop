/**
 * Staffing-agency / intermediary detection for candidate→job matches.
 *
 * JobDigger (and other open-market sources) surface vacancies that are posted
 * by uitzendbureaus / detacheerders / werving-en-selectie agencies rather than
 * the actual employer. Candidates usually want to filter those out. 8vance has
 * no native "hide staffing agencies" flag, so we classify each matched vacancy
 * ourselves using several independent signals:
 *
 *   1. is_intermediary — the JobDigger/8vance organization flag, when present.
 *   2. employer-name match — a maintained blocklist of agency names
 *      (Randstad, Tempo-Team, YoungCapital, …) matched as a substring.
 *   3. contract-type — "uitzend"/"detachering"/"payroll"/"on-call" style types.
 *   4. description tells — phrases an agency uses when recruiting on behalf of
 *      a client ("voor onze opdrachtgever", "namens onze relatie",
 *      "detachering", "on behalf of our client", …).
 *
 * Each fired signal contributes to a score; any signal at/above the threshold
 * marks the vacancy as a staffing agency. Rules are config-driven so an admin
 * can extend the name/description lists per organization without code changes.
 */

export type AgencySignal =
  | "is_intermediary"
  | "employer_name"
  | "contract_type"
  | "description";

export interface AgencyReason {
  signal: AgencySignal;
  /** The matched pattern / value, for the "why was this hidden?" UI. */
  matched: string;
}

export interface AgencyVerdict {
  isAgency: boolean;
  /** 0..1 confidence — number of distinct signals that fired, normalized. */
  score: number;
  reasons: AgencyReason[];
}

/** A vacancy reduced to the fields the classifier looks at. */
export interface ClassifiableJob {
  employerName?: string | null;
  description?: string | null;
  contractType?: string | null;
  /** Raw is_intermediary flag from the source, if exposed. */
  isIntermediary?: boolean | null;
}

/** A single detection rule (built-in default or admin-supplied override). */
export interface AgencyRule {
  kind: "name" | "description";
  /** Lowercased substring to match. */
  pattern: string;
  enabled?: boolean;
  label?: string | null;
}

/**
 * Built-in employer-name fragments. Lowercased; matched as substrings against
 * the employer/company name. Covers the large NL/BE staffing & secondment
 * brands plus generic agency words. Admins extend this per-org.
 */
export const DEFAULT_AGENCY_NAME_PATTERNS: readonly string[] = [
  // Major NL/BE staffing brands
  "randstad",
  "tempo-team",
  "tempo team",
  "youngcapital",
  "young capital",
  "olympia",
  "manpower",
  "adecco",
  "start people",
  "startpeople",
  "unique uitzend",
  "luba",
  "timing",
  "dpa",
  "brunel",
  "yacht",
  "hays",
  "usg",
  "tence",
  "actief",
  "abiant",
  "driessen",
  "continu",
  "maandag",
  "yer",
  "magnit",
  "in person",
  "flexwerk",
  "jobboost",
  "trion",
  "covebo",
  "e&a",
  "personato",
  "vitae",
  "p-services",
  "otto work force",
  "ottoworkforce",
  // More NL/BE staffing, secondment & recruitment brands
  "tideman",
  "unique nederland",
  "page personnel",
  "michael page",
  "robert half",
  "robert walters",
  "manpowergroup",
  "experis",
  "hays recruitment",
  "flexcraft",
  "werkpool",
  "jobflow",
  "studentenwerk",
  "jam werkt",
  "asa student",
  "tposity",
  "tellus",
  "carriere uitzend",
  "rgf staffing",
  "house of skills",
  "independer werving",
  "weenig",
  "flexservice",
  "endeavour",
  "headfirst",
  "myler",
  "between",
  "harvey nash",
  "darwin recruitment",
  // Generic agency / intermediary words in the name itself
  "uitzend",
  "uitzendbureau",
  "detacheer",
  "detachering",
  "detachement",
  "secondment",
  "werving en selectie",
  "werving & selectie",
  "recruitment",
  "recruiting",
  "staffing",
  "payroll",
  "payrolling",
  "interim",
  "flexpool",
  "bemiddeling",
  "intermediair",
  // German agency terms (Public Vacancies DE / JobDigger DE feed)
  "personaldienstleister",
  "personalvermittlung",
  "personalberatung",
  "zeitarbeit",
  "arbeitnehmeruberlassung",
  "arbeitnehmerüberlassung",
  "zeitarbeitsfirma",
  "personalservice",
];

/**
 * Built-in vacancy-description tells. Lowercased; matched as substrings against
 * the description. These are phrases agencies use when posting on behalf of a
 * client they don't name — the strongest "this isn't the real employer" signal.
 */
export const DEFAULT_AGENCY_DESCRIPTION_PATTERNS: readonly string[] = [
  // Dutch — "on behalf of our client/relation"
  "voor onze opdrachtgever",
  "voor een van onze opdrachtgevers",
  "voor één van onze opdrachtgevers",
  "namens onze opdrachtgever",
  "namens een opdrachtgever",
  "voor onze relatie",
  "voor een van onze relaties",
  "namens onze relatie",
  "onze opdrachtgever is",
  "in opdracht van",
  "voor onze klant",
  "namens onze klant",
  // Dutch — agency self-description
  "via ons uitzendbureau",
  "uitzendbasis",
  "detacheringsbasis",
  "op detacheringsbasis",
  "werving en selectie",
  "ben jij op zoek naar een uitzend",
  "wij zijn een uitzendbureau",
  "als uitzendkracht",
  "payrollconstructie",
  "via payroll",
  "interim-opdracht",
  // More Dutch tells
  "voor een opdrachtgever",
  "voor een van onze klanten",
  "voor onze opdrachtgevers",
  "een van onze opdrachtgevers",
  "detacheringsbureau",
  "werving- en selectiebureau",
  "werving & selectiebureau",
  "wij detacheren",
  "wij zoeken voor onze opdrachtgever",
  "zzp-bemiddeling",
  "ben jij toe aan een nieuwe uitdaging via",
  "voor één van onze relaties",
  "interim professional",
  "interim-professional",
  // English equivalents
  "on behalf of our client",
  "on behalf of our customer",
  "on behalf of",
  "our client is looking",
  "for one of our clients",
  "for our client",
  "for a client of ours",
  "we are recruiting for",
  "recruiting on behalf",
  "recruitment agency",
  "staffing agency",
  "temporary employment",
  "via our agency",
  // German tells (DE feed)
  "im auftrag unseres kunden",
  "im auftrag unseres mandanten",
  "im kundenauftrag",
  "für unseren kunden",
  "für unseren mandanten",
  "personaldienstleister",
  "arbeitnehmeruberlassung",
  "arbeitnehmerüberlassung",
  "in der arbeitnehmeruberlassung",
  "im rahmen der zeitarbeit",
];

/**
 * Contract-type values that strongly correlate with agency placements.
 * Deliberately EXCLUDES "interim" / "temporary employment": direct employers
 * routinely post those, so they'd cause false positives as a sole signal.
 * (Both remain agency tells in the name/description lists, where surrounding
 * context disambiguates.)
 */
export const DEFAULT_AGENCY_CONTRACT_PATTERNS: readonly string[] = [
  "uitzend",
  "detach",
  "payroll",
  "on-call",
  "on call",
  "oproep",
  "uitzendkracht",
  "uitzendovereenkomst",
  "detacheringsovereenkomst",
  "zeitarbeit",
  "arbeitnehmeruberlassung",
];

export interface ClassifyOptions {
  /** Admin name/description overrides, merged with the built-in defaults. */
  rules?: AgencyRule[];
  /**
   * Minimum number of distinct signals required to mark as an agency.
   * Default 1 — any single signal flags it (candidates prefer over-filtering
   * agencies to missing them). Raise to 2 for a stricter "needs corroboration".
   */
  threshold?: number;
  /** Override the contract-type pattern list (defaults to the built-ins). */
  contractPatterns?: readonly string[];
}

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match `pattern` only when it STARTS at a token boundary in `haystack` (both
 * already lowercased). This catches Dutch compounds where the pattern is a
 * prefix of a longer word ("uitzend" in "uitzendorganisatie") while rejecting
 * spurious mid-word substrings ("yer" in "bayer", "actief" in "tractief").
 * The pattern need NOT end on a boundary, so stems still match compounds.
 */
function tokenStartIncludes(haystack: string, pattern: string): boolean {
  if (!haystack || !pattern) return false;
  const re = new RegExp("(^|[^a-z0-9])" + escapeRegex(pattern));
  return re.test(haystack);
}

/** First pattern in `patterns` that matches at a token boundary, or null. */
function firstTokenMatch(haystack: string, patterns: readonly string[]): string | null {
  for (const p of patterns) {
    if (tokenStartIncludes(haystack, p)) return p;
  }
  return null;
}

/**
 * Split admin rules into name + description lists and merge with defaults.
 * Disabled rules are dropped. Exposed so callers can build the effective lists
 * once and reuse them across a batch of jobs.
 */
export function resolveRules(rules: AgencyRule[] = []): {
  names: string[];
  descriptions: string[];
} {
  const names = [...DEFAULT_AGENCY_NAME_PATTERNS];
  const descriptions = [...DEFAULT_AGENCY_DESCRIPTION_PATTERNS];
  for (const r of rules) {
    if (r.enabled === false) continue;
    const p = norm(r.pattern).trim();
    if (!p) continue;
    if (r.kind === "name") names.push(p);
    else if (r.kind === "description") descriptions.push(p);
  }
  return { names, descriptions };
}

/**
 * Classify a single vacancy. Pure + deterministic — no I/O. Pass pre-resolved
 * rules via opts.rules (or let it fall back to the built-in defaults).
 */
export function classifyJob(
  job: ClassifiableJob,
  opts: ClassifyOptions = {},
): AgencyVerdict {
  const threshold = opts.threshold ?? 1;
  const { names, descriptions } = resolveRules(opts.rules);
  const contracts = opts.contractPatterns ?? DEFAULT_AGENCY_CONTRACT_PATTERNS;

  const reasons: AgencyReason[] = [];

  // Signal 1: explicit intermediary flag.
  if (job.isIntermediary === true) {
    reasons.push({ signal: "is_intermediary", matched: "is_intermediary" });
  }

  // Signal 2: employer name matches a known agency / agency word. Token-start
  // matching avoids false positives from short brand tokens embedded in
  // unrelated names (e.g. "yer" in "Bayer").
  const employer = norm(job.employerName);
  if (employer) {
    const hit = firstTokenMatch(employer, names);
    if (hit) reasons.push({ signal: "employer_name", matched: hit });
  }

  // Signal 3: contract type looks like an agency placement.
  const contract = norm(job.contractType);
  if (contract) {
    const hit = firstTokenMatch(contract, contracts);
    if (hit) reasons.push({ signal: "contract_type", matched: hit });
  }

  // Signal 4: description tells (recruiting on behalf of an unnamed client).
  const desc = norm(job.description);
  if (desc) {
    const hit = firstTokenMatch(desc, descriptions);
    if (hit) reasons.push({ signal: "description", matched: hit });
  }

  // Distinct signals only (a single signal type counts once).
  const distinct = new Set(reasons.map((r) => r.signal)).size;
  // Normalize against the 4 possible signal types.
  const score = distinct / 4;
  return {
    isAgency: distinct >= threshold,
    score,
    reasons,
  };
}
