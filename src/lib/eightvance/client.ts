/**
 * 8vance public-API client (TypeScript port of `vance_pipeline.py`).
 *
 * Wraps native `fetch` with:
 *   - Token cache (`auth.ts`) — auto-refresh, 401 replay.
 *   - Rate limiter (`ratelimit.ts`) — 55/min per (clientId, endpointKey).
 *   - Retry policy: 401 → refresh+replay once; 429 → honour `Retry-After`
 *     + retry once (default 5s); 5xx → exp backoff 0.5/1/2s, 3 retries.
 *   - Pagination shape detection: `{count,results}` envelope OR flat array
 *     (gap #9).
 *   - Multi-tenant gate (`CompanyIdGate`) — refuses egress to
 *     non-allow-listed `company_id` (defence in depth vs prompt injection).
 *
 * Quirks ported verbatim from the Python client (see also
 * `docs/8vance-api-prod.md`, `docs/8vance-api-gaps.md`):
 *   #1 function_name int-on-write, may be string-on-read
 *   #2/#4 job-skill uses `skill`, talent-skill uses `skill_id`
 *   #4(loc) lat/lon must be strings on write
 *   #5 /resources/location/ REQUIRES a non-empty `q`
 *   #6 /match/ /search/ require `sources` body (use [] for default set)
 *   #9 pagination shape varies per endpoint
 *   #18 /feedback/ scope drift — not modelled here (caller handles)
 */

import { getToken, invalidateToken, secretTag } from "./auth";
import {
  CompanyIdGateError,
  VanceAuthError,
  VanceError,
  VanceRateLimitError,
} from "./errors";
import { acquire, penalize } from "./ratelimit";
import type {
  FeedbackApplicant,
  FeedbackRow,
  JobCreatePayload,
  JobDetail,
  JobExtended,
  SpecificMatch,
  JobMatchResult,
  JobRef,
  JobSkill,
  LocationResult,
  MatchResult,
  MatchStatus,
  MatchTaskHandle,
  PaginatedResponse,
  ReferenceItem,
  TalentCreatePayload,
  TalentEducation,
  TalentEducationInput,
  TalentExperience,
  TalentExperienceInput,
  TalentLanguage,
  TalentLocation,
  TalentProfile,
  TalentSkill,
  TalentSkillAddInput,
  TalentUpdateInput,
} from "./types";
import { isRecord, sleep } from "./util";
import { reportError } from "../observability/report";
import { pLimit } from "../match/concurrency";

const DEFAULT_BASE_URL = "https://app.8vance.com/public/v1";
const DEFAULT_PROFICIENCY_ID = 25;

/**
 * Default taxonomy locale for 8vance reference-data reads.
 *
 * 8vance stores one taxonomy row per (concept x locale). The talent
 * sub-resource GETs (profile.function_name, skill_name, experience
 * function_title, education field) return the TALENT'S stored locale (often
 * German for a German talent) and do NOT accept a lang/Accept-Language param
 * (only the /resources/ reference endpoints document ?lang=; see
 * docs/8vance-api-prod.md section 29). So to render names in a consistent app
 * locale we resolve taxonomy ids to names via /resources/...?lang=<this>.
 *
 * Defaults to "en". Override with EIGHTVANCE_LANG (en|nl|de|fr|it). Read here
 * (module load) so it costs nothing per request; absence/blank falls to "en".
 */
const EIGHTVANCE_DEFAULT_LANG =
  ((process.env.EIGHTVANCE_LANG ?? "").trim().toLowerCase()) || "en";

/**
 * Resolve the ?lang= value for a reference-data read: an explicit
 * preferredLocale (e.g. an NL/DE autocomplete request) wins so the
 * locale-parameterized callers keep working; otherwise fall back to the app
 * default (English). Never hardcoded-English so NL/DE app locales still work.
 */
function refLang(preferredLocale?: string): string {
  const p = (preferredLocale ?? "").trim().toLowerCase();
  return p || EIGHTVANCE_DEFAULT_LANG;
}

const MAX_5XX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
const RATE_LIMIT_DEFAULT_PENALTY_MS = 5_000;

// Poll the async match task every 1.2s (8vance frequently finishes in <2s, so
// a tighter interval surfaces results sooner). The first status poll fires
// IMMEDIATELY (before the first sleep) in both runToCompletion loops below, so
// a sub-1.2s task returns without waiting a full interval. Attempts bumped to
// 100 so the total wall budget stays ≈ the same (100 × 1.2s = 120s ≈ 60 × 2s).
const MATCH_POLL_INTERVAL_MS = 1_200;
const MATCH_POLL_MAX_ATTEMPTS = 100;

/** Page size for the synchronous match endpoints (job→talent + talent→job). */
const MATCH_PAGE_SIZE = 100;

/**
 * Optional bounded-match filters for `POST /match/job/`. Passing a `location`
 * (small radius) and/or `keywords` shrinks the ElasticSearch candidate set so a
 * match against a large open-market feed (JobDigger `OnlineVacaturesNL`,
 * `public_vacancies_*`) actually completes instead of timing out at the ~60s
 * gateway. An UNFILTERED match on such a feed processes 800k+ ES docs — it
 * times out and, verified live, can spike PROD ES to 100% CPU. Keep filters on.
 */
export interface MatchFilters {
  location?: { lat: number; lng: number; radius: number; radius_unit?: "km" | "mi" };
  keywords?: { include?: string[]; exclude?: string[] };
}

/** Build the `/match/job/` body: `sources` (required) plus any bounded filters. */
function buildMatchBody(sources: string[], filters?: MatchFilters): Record<string, unknown> {
  const body: Record<string, unknown> = { sources };
  if (filters?.location) {
    body.location = { radius_unit: "km", ...filters.location };
  }
  const inc = filters?.keywords?.include?.filter((s) => s && s.trim());
  const exc = filters?.keywords?.exclude?.filter((s) => s && s.trim());
  if ((inc && inc.length) || (exc && exc.length)) {
    body.keywords = { include: inc ?? [], exclude: exc ?? [] };
  }
  return body;
}
/** Delay before the single under-delivery retry (see `matchWithRetry`). */
const MATCH_UNDERDELIVERY_RETRY_MS = 1_500;
/**
 * A first-page row count at/under this is treated as SUSPICIOUSLY LOW and
 * retried once — even if 8vance's own `count` agrees with it. Verified live:
 * the endpoint sometimes returns a truncated `{count:2, results:[2]}` for a job
 * that otherwise matches 733, so a count-vs-rows check alone doesn't catch it.
 * A genuinely tiny result set just pays one extra 1.5s call (rare, acceptable).
 */
const MATCH_SUSPICIOUS_LOW_ROWS = 5;

/**
 * Pull the result rows + the reported total `count` out of a match response,
 * tolerating the array / `{results}` / `{matches}` shapes 8vance uses.
 */
function extractMatchRows<T>(payload: unknown): { rows: T[]; count: number } {
  if (Array.isArray(payload)) return { rows: payload as T[], count: payload.length };
  if (isRecord(payload)) {
    const rows = Array.isArray(payload.results)
      ? (payload.results as T[])
      : Array.isArray(payload.matches)
        ? (payload.matches as T[])
        : [];
    const count = typeof payload.count === "number" ? payload.count : rows.length;
    return { rows, count };
  }
  return { rows: [], count: 0 };
}

/**
 * Normalize reverse-match (job→talent) rows so every row carries `talent_id`.
 * The endpoint returns the talent id on `id` (the row IS the talent), NOT
 * `talent_id` — verified live: keys are [id, first_name, …, score]. Downstream
 * (hydrate) reads `talent_id`, so an un-normalized row is silently dropped and
 * the shortlist stays empty. Also tolerates `talent` (older deploy shape).
 */
function withTalentIds<T extends { talent_id?: number | null }>(rows: T[]): T[] {
  return rows.map((r) => {
    const rr = r as T & { id?: number; talent?: number };
    return rr.talent_id != null ? rr : { ...rr, talent_id: Number(rr.id ?? rr.talent) };
  });
}

/**
 * Mitigate 8vance match-endpoint UNDER-DELIVERY. Both /match/talent/ and
 * /match/job/ intermittently return a near-empty first page — verified live: the
 * same job swings between 2 and 733, a freshly-onboarded talent returns 0 then
 * 181 a moment later, and sometimes the truncated page even carries a matching
 * low `count` (e.g. {count:2, results:[2]}). So we retry ONCE when EITHER:
 *   - the page is short of what `count` promises (count > rows), OR
 *   - the row count is suspiciously low (≤ MATCH_SUSPICIOUS_LOW_ROWS) — catches
 *     the lie-count truncation a count-vs-rows check misses.
 * Keep whichever attempt returned more rows. A genuinely full page is trusted
 * immediately; a genuinely tiny result just pays one extra call.
 */
async function matchWithRetry<T>(
  fetchPage: () => Promise<{ rows: T[]; count: number }>,
): Promise<T[]> {
  const first = await fetchPage();
  const expected = Math.min(first.count, MATCH_PAGE_SIZE);
  const underDelivered = first.rows.length < expected;
  const suspiciouslyLow = first.rows.length <= MATCH_SUSPICIOUS_LOW_ROWS;
  if (!underDelivered && !suspiciouslyLow) return first.rows;
  await sleep(MATCH_UNDERDELIVERY_RETRY_MS);
  const second = await fetchPage();
  return second.rows.length >= first.rows.length ? second.rows : first.rows;
}

// Concurrency cap for the independent sub-resource attach POSTs on job/talent
// create (skills, languages, education, job-experience). Keeps create fast
// (N parallel round-trips instead of N sequential) while staying comfortably
// under the per-bucket rate limit.
const ATTACH_CONCURRENCY = 4;

export interface VanceClientOptions {
  clientId: string;
  clientSecret: string;
  companyId: number;
  baseUrl?: string;
  /** When non-empty, only these company ids may appear in requests/responses. */
  allowedCompanyIds?: Iterable<number>;
}

interface RequestOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /**
   * Raw multipart/form-data body (e.g. a file upload). When set, `body` is
   * ignored and the FormData is sent as-is — fetch adds the correct
   * `multipart/form-data; boundary=…` Content-Type, so we must NOT set our own.
   */
  formBody?: FormData;
  /** Bucket key suffix; defaults to `path`. */
  endpointKey?: string;
}

interface MatchRunToCompletionOpts {
  pollIntervalMs?: number;
  maxAttempts?: number;
  pageSize?: number;
  /** Source SLUG strings (e.g. the pool's ownSourceSlug) — never numeric ids. */
  sources?: string[];
}

/**
 * Build a URL with query params. Skips undefined/null. Booleans serialise
 * as "true"/"false". Numbers via `String()`.
 */
function buildUrl(
  base: string,
  path: string,
  query?: RequestOpts["query"],
): string {
  const root = base.replace(/\/$/, "");
  const url = new URL(`${root}/${path.replace(/^\//, "")}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Detect pagination shape (gap #9):
 *   - `{count, results: [...]}` → return `results` and `next`
 *   - flat array → return as-is, no `next`
 *   - anything else → empty list, no `next`
 */
function unwrapPaginated<T>(payload: unknown): {
  rows: T[];
  next: string | null;
} {
  if (Array.isArray(payload)) {
    return { rows: payload as T[], next: null };
  }
  if (isRecord(payload) && Array.isArray(payload.results)) {
    const next =
      typeof payload.next === "string" && payload.next.length > 0
        ? payload.next
        : null;
    return { rows: payload.results as T[], next };
  }
  return { rows: [], next: null };
}

/**
 * Clamp a job-language proficiency to the 8vance level scale (0..5, 5 = native).
 * Non-finite/missing input falls back to `fallback`. Used to expand the wizard's
 * single 1..5 proficiency onto read/write/speak levels.
 */
function clampLevel(raw: number | undefined | null, fallback: number): number {
  const n = typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(5, Math.round(n)));
}

/**
 * Coerce a CV "year" string (e.g. "2019") into an ISO-ish date string the
 * 8vance sub-resource date fields expect (`YYYY-01-01`). Returns undefined for
 * anything that isn't a plausible 4-digit year so we never post garbage dates.
 */
function yearToDate(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const m = raw.trim().match(/\b(19|20)\d{2}\b/);
  return m ? `${m[0]}-01-01` : undefined;
}

/**
 * Tech tokens that must survive verbatim — naive splitting/lowercasing/length
 * filters mangle them (".NET" → "net" → fuzzy "netwerk"; "C#"/"C++" dropped as
 * <4 chars). Matched case-insensitively against raw title tokens; the value is
 * the canonical query term we feed to `/resources/skill/?q=`.
 */
const TECH_TOKEN_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\.?net$/i, ".NET"],
  [/^c#$/i, "C#"],
  [/^c\+\+$/i, "C++"],
  [/^f#$/i, "F#"],
  [/^objective-?c$/i, "Objective-C"],
  [/^node\.?js$/i, "Node.js"],
  [/^vue\.?js$/i, "Vue.js"],
  [/^next\.?js$/i, "Next.js"],
  [/^ci\/cd$/i, "CI/CD"],
];

/**
 * Generic role/seniority words that carry no skill signal — searching them
 * pollutes the suggestion buckets with noise ("senior", "medewerker", etc.).
 */
const SEED_STOPWORDS: ReadonlySet<string> = new Set([
  "and", "or", "of", "the", "for", "with", "een", "the",
  "en", "de", "het", "van", "voor", "met", "bij",
  "senior", "junior", "medior", "lead", "principal", "staff", "head",
  "manager", "medewerker", "specialist", "officer", "assistant", "intern",
  "stagiair", "trainee", "freelance", "fulltime", "parttime",
]);

/**
 * Extract searchable seed terms from a role/job title.
 *  - Splits on whitespace, slashes, commas, parens (keeps `+`, `#`, `.` so
 *    tech tokens survive).
 *  - Canonicalises known tech tokens verbatim (`.NET`, `C#`, `C++`, …).
 *  - Drops generic role/seniority stopwords.
 *  - Keeps remaining tokens of length ≥ 3 (tech tokens bypass the floor).
 *  - Dedupes case-insensitively; orders specific (longer) first, but tech
 *    tokens are surfaced first since they're the strongest hard-skill signal.
 */
export function seedTermsFromTitle(title: string): string[] {
  const rawTokens = (title ?? "")
    .split(/[\s/,()|_]+/)
    .map((w) => w.trim().replace(/^[.\-]+|[.\-]+$/g, ""))
    .filter((w) => w.length > 0);

  const tech: string[] = [];
  const plain: string[] = [];
  const seen = new Set<string>();

  for (const tok of rawTokens) {
    const lc = tok.toLowerCase();
    const canon = TECH_TOKEN_MAP.find(([re]) => re.test(tok));
    if (canon) {
      const term = canon[1];
      if (!seen.has(term.toLowerCase())) {
        seen.add(term.toLowerCase());
        tech.push(term);
      }
      continue;
    }
    if (SEED_STOPWORDS.has(lc)) continue;
    if (tok.length < 3) continue;
    if (seen.has(lc)) continue;
    seen.add(lc);
    plain.push(tok);
  }

  plain.sort((a, b) => b.length - a.length);
  return [...tech, ...plain.slice(0, 4)];
}

/** Skill suggestion bucket, derived from 8vance `extra_data`. */
export type SkillCategory = "soft" | "hard" | "knowledge";

interface SkillExtraData {
  soft_transferrable?: boolean;
  domain_specific?: boolean;
}

/**
 * Bucket a skill from its 8vance `extra_data`:
 *  - soft     → transferable/soft skill (soft_transferrable)
 *  - hard     → domain-specific competency (domain_specific, not soft)
 *  - knowledge→ general knowledge area (neither)
 */
function classifySkill(extra: SkillExtraData | undefined): SkillCategory {
  if (extra?.soft_transferrable) return "soft";
  if (extra?.domain_specific) return "hard";
  return "knowledge";
}

/**
 * 8vance reference lists carry one row per (concept × locale). For autocomplete
 * we want clean options: keep ONLY the requested locale, and dedupe by id AND
 * by normalized name (so the same concept doesn't appear in four languages).
 *
 * Locale filtering is STRICT when the rows carry `language_code` metadata —
 * a Dutch search never leaks German/French results. Only when the rows have
 * no `language_code` at all (filtering impossible) do we return everything.
 */
function localeDedupe(
  rows: Array<{ id?: number | string; name?: string; language_code?: string }>,
  fallbackName: string,
  preferredLocale?: string,
  // When false, never fall back to other locales (used mid-pagination so a
  // later page's locale rows aren't pre-empted by an early all-locale page).
  allowFallback = true,
): Array<{ id: number; name: string }> {
  const locale = (preferredLocale ?? "").toLowerCase();
  const hasLocaleMeta = rows.some((r) => typeof r.language_code === "string");

  const collect = (onlyLocale: boolean): Array<{ id: number; name: string }> => {
    const out: Array<{ id: number; name: string }> = [];
    const seenId = new Set<number>();
    const seenName = new Set<string>();
    for (const r of rows) {
      if (onlyLocale) {
        const lc = r.language_code;
        if (typeof lc !== "string" || lc.toLowerCase() !== locale) continue;
      }
      if (r.id === undefined || r.id === null) continue;
      const id = Number(r.id);
      if (!Number.isFinite(id) || seenId.has(id)) continue;
      const name = String(r.name ?? fallbackName).trim();
      const nKey = name.toLowerCase();
      if (!name || seenName.has(nKey)) continue;
      seenId.add(id);
      seenName.add(nKey);
      out.push({ id, name });
    }
    return out;
  };

  // Strict locale when possible — a Dutch search stays Dutch. But if the
  // requested locale yields NOTHING (8vance has no rows in that language for
  // this query, e.g. English function titles), fall back to all locales so the
  // dropdown is never empty.
  if (locale.length > 0 && hasLocaleMeta) {
    const localed = collect(true);
    if (localed.length > 0 || !allowFallback) return localed;
  }
  return collect(false);
}

/**
 * Re-rank reference-data rows by RELEVANCE to the typed term. 8vance's
 * `/resources/*?q=` returns substring/fuzzy matches in an order that puts the
 * literal best match anywhere — so a "SQL" search surfaced "SQLite" first,
 * "Java" → "JavaScript", "engineer" → "Mining engineering". Picking row[0] (or
 * showing the API order in the wizard dropdown) then poisoned the job/talent
 * with the wrong taxonomy id and matching scored ~0.
 *
 * Score (lower = better): 0 exact (case-insensitive ==), 1 starts-with the term,
 * 2 contains the term as a whole word, 3 everything else. Tiebreak: shorter name
 * (the canonical concept — "SQL" beats "SQLite"/"SQL Server"), then original
 * order (stable). Pure string ranking; never drops rows.
 */
function rankByRelevance<T extends { name?: string }>(rows: T[], term: string): T[] {
  const t = (term ?? "").trim().toLowerCase();
  if (!t) return rows;
  const wordRe = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const score = (raw: string): number => {
    const n = (raw ?? "").trim().toLowerCase();
    if (!n) return 4;
    if (n === t) return 0;
    if (n.startsWith(t)) return 1;
    if (wordRe.test(n)) return 2;
    return 3;
  };
  return rows
    .map((r, i) => ({ r, i, s: score(String(r.name ?? "")) }))
    .sort(
      (a, b) =>
        a.s - b.s ||
        String(a.r.name ?? "").length - String(b.r.name ?? "").length ||
        a.i - b.i,
    )
    .map((x) => x.r);
}

/**
 * Progressive query candidates for resolving a free-text job/role TITLE to a
 * function-name id. A real CV title is often a COMPOUND ("Piping Engineer /
 * Plant 3D Engineer") or carries a seniority prefix ("Senior Backend
 * developer") — and `/resources/function-name/?q=` matches the WHOLE string, so
 * the full title frequently returns ZERO rows (verified live: the compound
 * title → 0, but "Piping Engineer" → 3). Without a fallback the talent gets NO
 * linked function_name and is invisible to reverse (job→talent) matching.
 *
 * So we derive a short list of increasingly-generic candidates, tried in order
 * until one returns rows: full → first segment (split on / | , & " en/and ") →
 * seniority-stripped → head two tokens. Deduped, each ≥2 chars.
 */
function functionNameCandidates(raw: string): string[] {
  const phrase = (raw ?? "").trim();
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string): void => {
    const v = (s ?? "").trim();
    if (v.length >= 2 && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  };
  add(phrase);
  // First segment, splitting on slash/pipe/comma/ampersand or " en/and/& ".
  const seg = phrase.split(/\s*[/|,&]\s*|\s+(?:en|and)\s+/i)[0] ?? phrase;
  add(seg);
  // Drop leading/standalone seniority + qualifier words.
  const stripped = seg
    .replace(
      /\b(senior|sr\.?|medior|mid[- ]?level|junior|jr\.?|lead|teamlead|team lead|principal|staff|hoofd|chief|aankomend|ervaren|allround|all[- ]?round|trainee|stagiair|aspirant)\b/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  add(stripped);
  // Head two tokens of the stripped segment (e.g. "Plant 3D Engineer" → "Plant 3D").
  const toks = stripped.split(/\s+/).filter(Boolean);
  if (toks.length > 2) add(toks.slice(0, 2).join(" "));
  return out;
}

/**
 * Trailing Dutch infinitives that turn a NOUN concept into a TASK phrase
 * ("installaties" → "installaties aanleggen"). `/resources/skill/?q=` matches
 * the WHOLE string, so the task phrase frequently returns 0 rows while the noun
 * core ("Elektrische installaties") resolves cleanly. Stripped to recover it.
 */
const SKILL_TRAILING_INFINITIVE_RE =
  /\s+(aanleggen|assembleren|monteren|demonteren|repareren|herstellen|uitvoeren|onderhouden|bedienen|installeren|configureren|programmeren|ontwerpen|analyseren|beheren|opstellen|aansturen|lassen|solderen|testen|inspecteren|kalibreren|afstellen)$/i;

/**
 * Leading "maintenance/repair" qualifier (+ optional van/aan) that prefixes the
 * real noun core: "Onderhoud elektrische apparatuur" → "elektrische apparatuur",
 * "Reparaties aan elektronica" → "elektronica".
 */
const SKILL_LEADING_TASK_RE =
  /^(onderhoud|reparaties|reparatie|installatie|montage|beheer|inspectie|reiniging)\s+(?:van\s+|aan\s+|op\s+)?/i;

/**
 * Progressive query candidates for resolving a free-text SKILL phrase to a
 * taxonomy id — the skill analogue of {@link functionNameCandidates}. A CV
 * skill is often a Dutch TASK phrase ("Elektrische installaties aanleggen",
 * "Onderhoud elektrische apparatuur") and `/resources/skill/?q=` matches the
 * whole string, so the full phrase returns ZERO rows and the skill is dropped
 * as "not recognized". We derive increasingly-generic candidates, tried in
 * order until one returns rows: full phrase → trailing-infinitive stripped (the
 * noun core) → leading-task-word stripped → head two tokens → head token.
 * Deduped, each ≥2 chars. Conservative: it only broadens the QUERY — the caller
 * keeps its relevance / nameMatchesTerm gate so a broadened candidate never
 * resolves to an unrelated skill.
 */
export function skillNameCandidates(raw: string): string[] {
  const phrase = (raw ?? "").trim();
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string): void => {
    const v = (s ?? "").trim();
    if (v.length >= 2 && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  };
  add(phrase);
  // Drop a trailing Dutch infinitive so the task phrase collapses to its noun
  // core: "Elektrische installaties aanleggen" → "Elektrische installaties".
  const noVerb = phrase.replace(SKILL_TRAILING_INFINITIVE_RE, "").trim();
  add(noVerb);
  // Drop a leading maintenance/repair qualifier (+ optional van/aan):
  // "Onderhoud elektrische apparatuur" → "elektrische apparatuur".
  const core = noVerb.replace(SKILL_LEADING_TASK_RE, "").trim();
  add(core);
  // Head one/two significant tokens of the noun core (≥2 chars each).
  const toks = core.split(/\s+/).filter((t) => t.length >= 2);
  if (toks.length > 2) add(toks.slice(0, 2).join(" "));
  if (toks.length > 1) add(toks[0]);
  return out;
}

/** Top-level client. */
export class VanceClient {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly companyId: number;
  private readonly clientSecret: string;
  private readonly allowedCompanyIds: ReadonlySet<number>;
  /**
   * Tenant discriminator for all cache/bucket keys (in addition to clientId).
   * The non-secret companyId when present; otherwise a non-reversible tag
   * derived from the clientSecret. NEVER the raw secret.
   */
  private readonly tenantKey: string;

  readonly resources: ReturnType<VanceClient["buildResources"]>;
  readonly job: ReturnType<VanceClient["buildJob"]>;
  readonly match: ReturnType<VanceClient["buildMatch"]>;
  readonly matchJobs: ReturnType<VanceClient["buildMatchJobs"]>;
  readonly talent: ReturnType<VanceClient["buildTalent"]>;
  readonly feedback: ReturnType<VanceClient["buildFeedback"]>;

  constructor(opts: VanceClientOptions) {
    if (!opts.clientId || !opts.clientSecret) {
      throw new VanceError("<init>", 0, "clientId + clientSecret are required");
    }
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.companyId = opts.companyId;
    const seeded = new Set<number>();
    if (opts.allowedCompanyIds) {
      for (const c of opts.allowedCompanyIds) seeded.add(c);
    }
    if (Number.isFinite(opts.companyId)) seeded.add(opts.companyId);
    this.allowedCompanyIds = seeded;
    // Prefer the non-secret companyId as the tenant discriminator; only when
    // it's absent/non-finite do we fall back to a one-way hash of the secret
    // (so two tenants that share a clientId but differ by secret still get
    // distinct cache/bucket keys). The raw secret never enters a key.
    this.tenantKey = Number.isFinite(opts.companyId)
      ? String(opts.companyId)
      : secretTag(this.clientSecret);

    // Each builder takes the client as an explicit `self` parameter (instead
    // of aliasing `this`, which @typescript-eslint/no-this-alias forbids):
    // the returned object-literal methods rebind `this`, so they reach the
    // client through the captured parameter.
    this.resources = this.buildResources(this);
    this.job = this.buildJob(this);
    this.match = this.buildMatch(this);
    this.matchJobs = this.buildMatchJobs(this);
    this.talent = this.buildTalent(this);
    this.feedback = this.buildFeedback(this);
  }

  // ------------------------------------------------------------------
  // Credential detection (admin pool setup)
  // ------------------------------------------------------------------

  /**
   * Build a client suitable for DETECTING which company a credential belongs
   * to, BEFORE the company id is known. The CompanyIdGate is the company
   * allow-list; an empty/absent allow-list = no gate (see `gateCompanyId` /
   * `gateResponseShape`, both no-op when `allowedCompanyIds.size === 0`). We
   * therefore pass NO `allowedCompanyIds` and a NON-finite `companyId` so the
   * constructor seeds nothing into the allow-set and the client can read
   * whatever company the creds own. The tenantKey then falls back to a one-way
   * hash of the secret (never the raw secret) for cache/bucket scoping.
   *
   * Reuses the exact same auth + request + endpointKey plumbing as a normal
   * client — only the gate is disabled.
   */
  static forDetection(opts: {
    clientId: string;
    clientSecret: string;
    baseUrl?: string;
  }): VanceClient {
    return new VanceClient({
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      // NaN is non-finite → constructor seeds nothing into the allow-set, so
      // the gate is off and detection can read any company the creds own.
      companyId: Number.NaN,
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    });
  }

  /**
   * Detect the company context for the configured credentials by making REAL
   * authed calls. Proves the creds work (any auth failure propagates as
   * `VanceAuthError`/`VanceError`) and derives:
   *
   *  - `companyId`: the numeric 8vance company id. Source of truth is the
   *    first row of `GET /talent/?page_size=1` (`company_id` on the row;
   *    `TalentProfile[extra]`). We OPTIONALLY try `GET /company/` first and use
   *    it only if it returns a sane numeric id, else fall back to the
   *    talent-derived id. `null` when the pool has zero talents (and `/company/`
   *    didn't yield one) — caller offers a manual-entry fallback for that edge.
   *  - `sources`: the real 8vance source slugs from the first talent's
   *    `GET /talent/{id}/sources/`. `[]` when there are no talents.
   *
   * MUST be called on a detection client (`VanceClient.forDetection`) — on a
   * gated client a foreign company_id in the response would throw the gate.
   */
  async detectContext(): Promise<{ companyId: number | null; sources: string[] }> {
    // (Optional) try a /company/ endpoint first; tolerate any shape/failure.
    let companyId: number | null = null;
    try {
      const payload = await this.request<unknown>("/company/", {
        query: { page_size: 1 },
        endpointKey: "/company/",
      });
      const { rows } = unwrapPaginated<{ id?: number | string; company_id?: number | string }>(payload);
      const first = isRecord(payload) && !Array.isArray(payload) && !("results" in payload)
        ? (payload as { id?: number | string })
        : rows[0];
      const raw = first?.id ?? (first as { company_id?: number | string } | undefined)?.company_id;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) companyId = n;
    } catch {
      // No /company/ endpoint (or not permitted) — fall back to talent-derived.
    }

    // Derive from the first talent row (reliable: every talent carries
    // company_id). Also grab the talent id for source detection.
    let firstTalentId: number | null = null;
    {
      const payload = await this.request<unknown>("/talent/", {
        query: { page_size: 1, page: 1 },
        endpointKey: "/talent/",
      });
      const { rows } = unwrapPaginated<TalentProfile>(payload);
      const first = rows[0] as Record<string, unknown> | undefined;
      if (first) {
        if (companyId === null) {
          const n = Number(first.company_id);
          if (Number.isFinite(n) && n > 0) companyId = n;
        }
        const tid = Number(first.id ?? first.talent_id);
        if (Number.isFinite(tid) && tid > 0) firstTalentId = tid;
      }
    }

    // Source slugs — canonical endpoint is `GET /company/{id}/sources/` (the
    // company's own source catalog). Needs the company id, hence resolved above.
    // Fall back to the first talent's /sources/ only if the company endpoint is
    // empty/unavailable, so detection still yields slugs on older deploys.
    let sources: string[] = [];
    if (companyId !== null) {
      try {
        const payload = await this.request<unknown>(`/company/${companyId}/sources/`, {
          endpointKey: "/company/{id}/sources/",
        });
        const rows = Array.isArray(payload)
          ? payload
          : isRecord(payload) && Array.isArray(payload.results)
            ? payload.results
            : [];
        for (const r of rows) {
          if (typeof r === "string") sources.push(r);
          else if (isRecord(r) && typeof r.name === "string") sources.push(r.name);
        }
      } catch {
        // company sources unavailable — fall through to talent-derived below
      }
    }
    if (sources.length === 0 && firstTalentId !== null) {
      try {
        sources = await this.talent.getSources(firstTalentId);
      } catch {
        // best-effort — detection still succeeds without sources
      }
    }

    return { companyId, sources };
  }

  /** External-feed source slug pattern (own-pool vs open-market split). */
  static readonly FEED_SOURCE_RE = /vacatures|vacancies|jobdigger|public_|onlinevacatures|ecosystem/i;

  /**
   * Pick the most-likely "own" source slug from a detected list: the first
   * slug that does NOT look like an external feed. Falls back to the first
   * slug overall, then `null`.
   */
  static pickOwnSource(sources: string[]): string | null {
    const clean = (sources ?? []).filter((s) => typeof s === "string" && s.trim().length > 0);
    return clean.find((s) => !VanceClient.FEED_SOURCE_RE.test(s)) ?? clean[0] ?? null;
  }

  // ------------------------------------------------------------------
  // CompanyIdGate
  // ------------------------------------------------------------------

  /**
   * Throws `CompanyIdGateError` if `value` references a company outside
   * `allowedCompanyIds`. No-op when the allow-set is empty (legacy
   * callers / fully unrestricted use).
   */
  private gateCompanyId(value: unknown, path = "<pre-flight>"): void {
    if (this.allowedCompanyIds.size === 0) return;
    if (value === undefined || value === null) return;
    const n =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
    if (!Number.isFinite(n)) return;
    if (!this.allowedCompanyIds.has(n)) {
      throw new CompanyIdGateError(n, this.allowedCompanyIds);
    }
    void path;
  }

  /**
   * Walk a response payload and throw if any `company` / `company_id`
   * field references a foreign tenant. Cheap O(n) scan, bounded depth.
   */
  private gateResponseShape(payload: unknown, path: string, depth = 0): void {
    if (this.allowedCompanyIds.size === 0) return;
    if (depth > 6 || payload === null || payload === undefined) return;
    if (Array.isArray(payload)) {
      for (const item of payload) this.gateResponseShape(item, path, depth + 1);
      return;
    }
    if (!isRecord(payload)) return;
    for (const key of ["company", "company_id"] as const) {
      if (key in payload) this.gateCompanyId(payload[key], path);
    }
    for (const v of Object.values(payload)) {
      if (typeof v === "object") this.gateResponseShape(v, path, depth + 1);
    }
  }

  // ------------------------------------------------------------------
  // Low-level request
  // ------------------------------------------------------------------

  /** One authenticated request with rate-limit + retry + gate. */
  private async request<T = unknown>(
    path: string,
    opts: RequestOpts = {},
  ): Promise<T> {
    const method = opts.method ?? "GET";
    const endpointKey = opts.endpointKey ?? path;
    // Scope the rate-limit bucket AND the token cache by a tenant discriminator
    // (the non-secret companyId) in addition to clientId. Two white-label
    // tenants can share a clientId with a different companyId/secret, so keying
    // by clientId alone would (a) let one tenant's 429 starve another and
    // (b) let one tenant's token be replayed by another. companyId is always
    // present on the request path (constructor seeds it).
    const tenantKey = this.tenantKey;
    const bucketKey = `${this.clientId}:${tenantKey}:${endpointKey}`;

    let authRetries = 1;
    let rateLimitRetries = 2;
    let netRetries = MAX_5XX_RETRIES;
    let backoffAttempt = 0;

    // Loop with bounded iterations as a paranoia stop.
    for (let i = 0; i < 16; i++) {
      await acquire(bucketKey);
      const token = await getToken(
        this.clientId,
        this.clientSecret,
        this.baseUrl,
        tenantKey,
      );
      const url = buildUrl(this.baseUrl, path, opts.query);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      };
      const init: RequestInit = { method, headers };
      if (opts.formBody !== undefined) {
        // Multipart upload: send FormData as-is; fetch sets the multipart
        // Content-Type + boundary. Never set Content-Type ourselves here.
        init.body = opts.formBody;
      } else if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(opts.body);
      }

      let resp: Response;
      // Bound EVERY 8vance call with an explicit timeout. Node's undici `fetch`
      // defaults to a ~300s headers/body timeout, so a connected-but-silent
      // endpoint (a busy /match/job/ feed, a slow /extended/, a hung
      // /talent/{id}/location/) would block the awaiting caller for ~5 min —
      // and with the 3× 5xx/network retry it compounds to ~20 min. During a
      // candidate match that keeps `executeMatchRun` pending so the run never
      // flips to READY/FAILED and the UI spinner hangs. An AbortController cap
      // turns a silent endpoint into a fast throw that flows through the retry/
      // VanceError path (classified per-source as `timeout`). Override via env.
      const reqTimeoutMs = Number(process.env.VANCE_REQUEST_TIMEOUT_MS) || 20_000;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), reqTimeoutMs);
      try {
        resp = await fetch(url, { ...init, signal: ac.signal });
      } catch (err) {
        if (netRetries > 0) {
          netRetries -= 1;
          await sleep(BACKOFF_BASE_MS * 2 ** backoffAttempt);
          backoffAttempt += 1;
          continue;
        }
        // Network-level failure (incl. a timeout abort) with retries exhausted —
        // report so a flaky/unreachable/slow 8vance is observable (path only,
        // never creds).
        reportError(err, { area: "eightvance.request", path });
        throw new VanceError(path, 0, String(err));
      } finally {
        clearTimeout(timer);
      }

      // 401 → refresh-once-and-replay
      if (resp.status === 401) {
        if (authRetries > 0) {
          authRetries -= 1;
          invalidateToken(this.clientId, tenantKey);
          await getToken(this.clientId, this.clientSecret, this.baseUrl, tenantKey, {
            force: true,
          });
          continue;
        }
        throw new VanceAuthError(path, 401, await safeJson(resp));
      }

      // 429 → honour Retry-After + bucket penalty
      if (resp.status === 429) {
        if (rateLimitRetries > 0) {
          rateLimitRetries -= 1;
          const ra = resp.headers.get("Retry-After");
          const parsed = ra ? Number(ra) : NaN;
          const waitMs = Number.isFinite(parsed) && parsed > 0
            ? parsed * 1_000
            : RATE_LIMIT_DEFAULT_PENALTY_MS;
          penalize(bucketKey, waitMs);
          await sleep(waitMs);
          continue;
        }
        throw new VanceRateLimitError(path, 429, await safeJson(resp));
      }

      // 5xx → exp backoff
      if (resp.status >= 500 && resp.status < 600) {
        if (netRetries > 0) {
          netRetries -= 1;
          await sleep(BACKOFF_BASE_MS * 2 ** backoffAttempt);
          backoffAttempt += 1;
          continue;
        }
        throw new VanceError(path, resp.status, await safeJson(resp));
      }

      const payload = await safeJson(resp);

      if (resp.status >= 400) {
        throw new VanceError(path, resp.status, payload);
      }

      this.gateResponseShape(payload, path);
      return payload as T;
    }

    throw new VanceError(path, 0, "request retry loop exhausted");
  }

  /**
   * Walk a paginated endpoint. Handles both `{count, next, results}` and
   * flat-array shapes (gap #9). Stops at `maxPages` (default 100).
   */
  private async paginated<T>(
    path: string,
    opts: {
      query?: RequestOpts["query"];
      pageSize?: number;
      maxPages?: number;
      endpointKey?: string;
    } = {},
  ): Promise<T[]> {
    const pageSize = opts.pageSize ?? 100;
    const maxPages = opts.maxPages ?? 100;
    const out: T[] = [];
    let page = 1;
    while (page <= maxPages) {
      const query = { ...(opts.query ?? {}), page_size: pageSize, page };
      const payload = await this.request<unknown>(path, {
        query,
        endpointKey: opts.endpointKey,
      });
      const { rows, next } = unwrapPaginated<T>(payload);
      out.push(...rows);
      if (Array.isArray(payload)) return out; // flat array → done
      if (!next) return out;
      page += 1;
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Sub-clients
  // ------------------------------------------------------------------

  private buildResources(self: VanceClient) {
    return {
      /** Batch-resolve skill names → ids via `/resources/skill/?q=`. */
      async resolveSkills(
        names: string[],
      ): Promise<Array<{ name: string; id: number }>> {
        const seen = new Set<number>();
        const out: Array<{ name: string; id: number }> = [];
        for (const raw of names ?? []) {
          const q = (raw ?? "").trim();
          if (!q) continue;
          // Try progressively-generic candidates (full phrase → noun core →
          // head tokens) until one returns rows: a Dutch TASK phrase like
          // "Elektrische installaties aanleggen" matches 0 rows for the whole
          // string, which would silently drop the skill. Mirrors
          // resolveFunctionName — stop at the first candidate that returns rows.
          for (const candidate of skillNameCandidates(q)) {
            const payload = await self.request<unknown>("/resources/skill/", {
              // NO lang filter: this resolves a typed/CV skill NAME -> id, and the
              // term can be in any language (a Dutch CV says "Lassen", a German one
              // "Schweißen"). Forcing lang=en made non-English terms resolve to 0
              // rows -> "no skills from the parser". The returned `name` is the
              // input `q` anyway, and the taxonomy id is locale-agnostic, so we
              // match across all locales and take the first hit.
              query: { q: candidate, page_size: 3 },
              endpointKey: "/resources/skill/",
            });
            const { rows } = unwrapPaginated<{ id?: number | string; name?: string }>(payload);
            if (rows.length === 0) continue;
            // Pick the most RELEVANT row, not the API's first — "SQL" must resolve
            // to SQL, not SQLite (rankByRelevance prefers exact/whole-word + the
            // shorter canonical name). Rank against the CANDIDATE actually queried.
            const first = rankByRelevance(rows, candidate)[0];
            if (first && first.id !== undefined && first.id !== null) {
              const id = Number(first.id);
              if (Number.isFinite(id) && !seen.has(id)) {
                seen.add(id);
                out.push({ name: q, id });
              }
            }
            break;
          }
        }
        return out;
      },

      /**
       * Reverse-resolve skill taxonomy IDS → names via `/resources/skill/`.
       *
       * Talent-skill rows occasionally arrive without a `skill_name`, which would
       * otherwise leak as a raw `skill_<id>` label in the anonymized UI. We look
       * each id up against the skill reference data and read its name back.
       *
       * Defensive by design: `/resources/skill/` is primarily a `?q=` (name)
       * search, so we pass the id as the `id` filter and ONLY accept a row whose
       * own id matches exactly (no name-search false positives). Any id that
       * doesn't resolve is simply omitted from the result map — the caller falls
       * back to a generic label, never to the raw id. Never throws per-id (a
       * lookup failure for one id must not sink the batch).
       */
      async resolveSkillNamesByIds(
        ids: number[],
      ): Promise<Map<number, string>> {
        const out = new Map<number, string>();
        const unique = Array.from(
          new Set((ids ?? []).filter((id) => Number.isFinite(id) && id > 0)),
        );
        for (const id of unique) {
          try {
            const payload = await self.request<unknown>("/resources/skill/", {
              // ?lang=en (default) so a reverse-resolved skill_name comes back in
              // the app locale, not the talent's stored (e.g. German) locale.
              query: { id, page_size: 5, lang: refLang() },
              endpointKey: "/resources/skill/",
            });
            const { rows } = unwrapPaginated<{ id?: number | string; name?: string }>(
              payload,
            );
            // Accept ONLY an exact-id match so a non-filtering backend (which
            // would echo an unrelated default page) can't mislabel the skill.
            const match = rows.find((r) => Number(r?.id) === id);
            const name =
              match && typeof match.name === "string" && match.name.trim()
                ? match.name.trim()
                : null;
            if (name) out.set(id, name);
          } catch {
            // Per-id best-effort: skip on failure, caller uses generic fallback.
          }
        }
        return out;
      },

      /** `/resources/function-name/?q=` — int id on write side (quirk #1). */
      async resolveFunctionName(q: string): Promise<{ id: number; name: string } | null> {
        const phrase = (q ?? "").trim();
        if (!phrase) return null;
        // Try progressively-generic candidates (full title → first segment →
        // seniority-stripped → head tokens): a compound/seniority-prefixed CV
        // title often returns ZERO rows for the whole string, which would leave
        // the talent without a function_name and INVISIBLE to reverse matching.
        for (const candidate of functionNameCandidates(phrase)) {
          const payload = await self.request<unknown>("/resources/function-name/", {
            // No lang filter: resolve the typed term in ANY language (id is
            // locale-agnostic). Forcing en breaks non-English function titles.
            query: { q: candidate, page_size: 5 },
            endpointKey: "/resources/function-name/",
          });
          const { rows } = unwrapPaginated<{ id?: number | string; name?: string }>(payload);
          if (rows.length === 0) continue;
          // Most-relevant row, not the API's first — "Backend developer" must
          // resolve to that, not "Mining engineering" for an "engineer" search.
          const first = rankByRelevance(rows, candidate)[0];
          if (!first || first.id === undefined || first.id === null) continue;
          const id = Number(first.id);
          if (!Number.isFinite(id)) continue;
          return { id, name: String(first.name ?? candidate) };
        }
        return null;
      },

      /** Multi-row search variant of {@link resolveFunctionName} for autocomplete UIs. */
      async searchFunctionNames(
        q: string,
        limit = 10,
        preferredLocale?: string,
      ): Promise<Array<{ id: number; name: string }>> {
        const phrase = (q ?? "").trim();
        if (!phrase) return [];
        // Fetch the max page so locale-filtering + name-dedupe still leaves
        // enough to fill `limit` (8vance returns one row per title × locale).
        const payload = await self.request<unknown>("/resources/function-name/", {
          // No API lang filter — localeDedupe(preferredLocale) below prefers the
          // locale with a fallback; sending lang= would defeat that fallback.
          query: { q: phrase, page_size: 25 },
          endpointKey: "/resources/function-name/",
        });
        const { rows } = unwrapPaginated<{
          id?: number | string;
          name?: string;
          language_code?: string;
        }>(payload);
        // Locale-dedupe, then relevance-rank so the autocomplete dropdown shows
        // the literal best match first (exact > prefix > whole-word > rest).
        return rankByRelevance(
          localeDedupe(rows, phrase, preferredLocale),
          phrase,
        ).slice(0, Math.max(limit, 1));
      },

      /** `/resources/location/?q=` (quirk #5: q REQUIRED, empty → 400). */
      async resolveLocation(q: string): Promise<LocationResult | null> {
        const phrase = (q ?? "").trim();
        if (!phrase) return null;
        const payload = await self.request<unknown>("/resources/location/", {
          query: { q: phrase, page_size: 10 },
          endpointKey: "/resources/location/",
        });
        const { rows } = unwrapPaginated<LocationResult>(payload);
        return rows[0] ?? null;
      },

      /** Multi-row search variant of {@link resolveLocation} for autocomplete UIs. */
      async searchLocations(q: string, limit = 10): Promise<LocationResult[]> {
        const phrase = (q ?? "").trim();
        if (!phrase) return [];
        const payload = await self.request<unknown>("/resources/location/", {
          query: { q: phrase, page_size: Math.min(Math.max(limit, 1), 25) },
          endpointKey: "/resources/location/",
        });
        const { rows } = unwrapPaginated<LocationResult>(payload);
        return rows;
      },

      /**
       * Multi-row skill search for autocomplete. With an empty `q` it returns
       * a default list of platform skills (suggestions shown on focus before
       * the user types).
       *
       * 8vance returns one row per (skill × locale), so to reliably surface
       * `limit` options IN the requested language we page through several
       * pages (page_size 25) and locale-filter + name-dedupe across all of
       * them. Strictly the requested locale — no other-language leakage.
       */
      async searchSkills(
        q: string,
        limit = 10,
        preferredLocale?: string,
      ): Promise<Array<{ id: number; name: string }>> {
        const phrase = (q ?? "").trim();
        const target = Math.max(limit, 1);
        const maxPages = 4;
        const acc: Array<{
          id?: number | string;
          name?: string;
          language_code?: string;
        }> = [];
        let result: Array<{ id: number; name: string }> = [];
        for (let page = 1; page <= maxPages; page += 1) {
          // NO API `lang` filter: it returns one row per (concept × locale) and
          // `localeDedupe(preferredLocale)` below picks the preferred locale WITH
          // a fallback to other locales. Sending lang= filters at the API and
          // defeats that fallback — a term in another language (a Dutch CV skill
          // while the UI locale is en) then resolves to 0 rows → "no skills from
          // the parser". Match all locales here, prefer client-side.
          const query: Record<string, string | number> = {
            page_size: 25,
            page,
          };
          if (phrase) query.q = phrase;
          const payload = await self.request<unknown>("/resources/skill/", {
            query,
            endpointKey: "/resources/skill/",
          });
          const { rows, next } = unwrapPaginated<{
            id?: number | string;
            name?: string;
            language_code?: string;
          }>(payload);
          acc.push(...rows);
          // Strict locale while paging: don't let an early all-locale page
          // pre-empt locale rows that may appear on a later page.
          result = localeDedupe(acc, phrase, preferredLocale, false);
          // Stop once we have enough clean options or 8vance has no more pages.
          if (result.length >= target || !next || Array.isArray(payload)) break;
        }
        // Only after exhausting pages do we fall back to other locales (so the
        // dropdown is never empty when the requested locale has no rows).
        if (result.length === 0) {
          result = localeDedupe(acc, phrase, preferredLocale, true);
        }
        // Relevance-rank so the dropdown's first option is the literal best match
        // ("SQL" before "SQLite", "Java" before "JavaScript") — the user picks
        // the top option, which then drives the job's skill taxonomy id.
        return rankByRelevance(result, phrase).slice(0, target);
      },

      /**
       * Role-relevant skill suggestions, grouped into soft / hard / knowledge
       * buckets for a clickable tile grid. Seeds the search from the role
       * being created (cascade: full title → cleaned seed terms → generic
       * platform list) and fills up to `perBucket` per group in the requested
       * locale (strict, name-deduped).
       *
       * Options:
       *  - `category`  — when set, only that bucket is filled (the other two
       *    are returned empty). Used by the per-category "+ 5 more" button so a
       *    single category can be extended without re-fetching the others.
       *  - `exclude`   — skill ids already shown/added. They are skipped so a
       *    "load more" request returns the NEXT distinct batch (no repeats).
       *
       * Cost: cascades candidate terms × paginates `/resources/skill/`. To stay
       * well under the 55/min bucket we (a) cap the candidate list, (b) bound
       * the total page count via MAX_TOTAL_PAGES, and (c) stop a term as soon
       * as the target bucket(s) are full — so the common "initial 5/bucket"
       * case resolves in ~1-3 calls. Each call uses a large page_size (100) so
       * a single request reaches deep into a term's ranking; that gives the
       * per-category "+5 more" (which carries a growing `exclude` set) a wide
       * distinct-result pool to draw from for several rounds — plus a set of
       * category-appropriate generic broadener terms appended only on load-more
       * — without increasing the request count.
       */
      async suggestSkills(
        seed: string,
        preferredLocale?: string,
        perBucket = 5,
        opts: {
          category?: SkillCategory;
          exclude?: Iterable<number>;
        } = {},
      ): Promise<Record<SkillCategory, Array<{ id: number; name: string }>>> {
        const locale = (preferredLocale ?? "").toLowerCase();
        const base = (seed ?? "").trim();
        // Tokenise the role/title into meaningful, searchable terms. The old
        // tokenizer split on whitespace/slash only and truncated to an 8-char
        // prefix, which mangled tech terms: ".Net" → "net" fuzzy-matched
        // "netwerk", "C#"/"C++" were dropped (<4 chars), and the prefix slice
        // turned "JavaScript" into "javascri". {@link seedTermsFromTitle}
        // preserves known tech tokens verbatim, keeps short abbreviations,
        // strips generic role stopwords, and never blind-truncates.
        const words = seedTermsFromTitle(base);

        const candidates: string[] = [];
        const pushTerm = (c: string) => {
          const term = c.trim();
          if (term.length >= 2 && !candidates.includes(term)) candidates.push(term);
        };
        // Full title first (most specific), then the cleaned terms.
        if (base.length >= 2) pushTerm(base);
        for (const w of words) pushTerm(w);
        // Cap the keyword terms, but ALWAYS end with the generic platform list
        // ("") — that's where soft/transversal skills live, so it must never be
        // sliced off (otherwise soft buckets come back near-empty).
        const MAX_KEYWORD_TERMS = 4;
        // Category-appropriate generic broadeners. The few title-derived
        // keyword terms overlap heavily (the role title and its sub-tokens
        // surface nearly the same top-ranked rows), so after a couple of
        // "+5 more" rounds the growing `exclude` set covers everything those
        // terms reach and the bucket runs dry. These extra generic terms open
        // a much wider distinct-result pool per bucket, keeping "+5 more"
        // productive for several rounds before genuine taxonomy exhaustion.
        // Only appended for "load more" (a single category with an exclude
        // set) so the cheap initial full-grid fetch is unaffected.
        const BROADEN_TERMS: Record<SkillCategory, string[]> = {
          soft: ["communicatie", "samenwerken", "leiderschap", "communication", "teamwork"],
          hard: ["software", "techniek", "analyse", "ontwikkeling", "engineering"],
          knowledge: ["management", "kennis", "proces", "wet", "knowledge"],
        };
        const cascade = [...candidates.slice(0, MAX_KEYWORD_TERMS), ""];
        if (opts.category) {
          // Append broadeners after the keyword terms + generic list (least
          // specific last), de-duped against terms already in the cascade.
          for (const t of BROADEN_TERMS[opts.category]) {
            if (!cascade.includes(t)) cascade.push(t);
          }
        }

        const wantCats: SkillCategory[] = opts.category
          ? [opts.category]
          : ["soft", "hard", "knowledge"];
        const wantSet = new Set<SkillCategory>(wantCats);

        const buckets: Record<SkillCategory, Array<{ id: number; name: string }>> = {
          soft: [],
          hard: [],
          knowledge: [],
        };
        const seenName = new Set<string>();
        const seenId = new Set<number>();
        // Pre-seed the exclude set so already-shown/added skills never reappear.
        for (const ex of opts.exclude ?? []) {
          const n = Number(ex);
          if (Number.isFinite(n)) seenId.add(n);
        }
        // "Full" = every WANTED bucket has reached perBucket. With a category
        // filter this is just that one bucket, which lets us stop far sooner.
        const full = () => wantCats.every((c) => buckets[c].length >= perBucket);
        // Global page budget so a profession with genuinely sparse rows in a
        // bucket (e.g. few domain-specific "hard" skills) can't page forever —
        // we return what the data has and let the UI's "+5 more" top it up.
        let totalPages = 0;
        // "Load more" (a single category + an exclude set) needs to reach the
        // rows BEYOND the first batch, which are deeper in the list, so give
        // that case a bigger budget. The initial full-grid fetch stays cheap.
        const isLoadMore = Boolean(opts.category) && (opts.exclude ? Array.from(opts.exclude).length > 0 : false);
        const MAX_TOTAL_PAGES = isLoadMore ? 24 : 12;
        for (const term of cascade) {
          if (full() || totalPages >= MAX_TOTAL_PAGES) break;
          // The generic list ("") is the main source of soft/transversal
          // skills and they're spread out, so page deeper there; keyword terms
          // converge fast. full() still short-circuits the common (full) case
          // to ~1-3 calls, so this only costs more when buckets are actually
          // under-filled — exactly when the extra rows are needed.
          const maxPagesForTerm = term === "" ? (isLoadMore ? 16 : 6) : 4;
          for (let page = 1; page <= maxPagesForTerm; page += 1) {
            if (totalPages >= MAX_TOTAL_PAGES) break;
            totalPages += 1;
            const query: Record<string, string | number> = {
              // A large page is the cheapest way to give "+5 more" headroom:
              // it surfaces ~4x more distinct rows per term per request, so the
              // growing `exclude` set has far more candidates to draw the next
              // batch from before a term genuinely runs dry — WITHOUT adding
              // any extra round-trips (request count is still bounded by
              // MAX_TOTAL_PAGES, so the 55/min bucket footprint is unchanged).
              page_size: 100,
              page,
              lang: refLang(preferredLocale),
            };
            if (term) query.q = term;
            const payload = await self.request<unknown>("/resources/skill/", {
              query,
              endpointKey: "/resources/skill/",
            });
            const { rows, next } = unwrapPaginated<{
              id?: number | string;
              name?: string;
              language_code?: string;
              extra_data?: SkillExtraData;
            }>(payload);
            for (const r of rows) {
              if (locale) {
                const lc = r.language_code;
                if (typeof lc === "string" && lc.toLowerCase() !== locale) continue;
              }
              if (r.id === undefined || r.id === null) continue;
              const id = Number(r.id);
              if (!Number.isFinite(id) || seenId.has(id)) continue;
              const name = String(r.name ?? "").trim();
              const nKey = name.toLowerCase();
              if (!name || seenName.has(nKey)) continue;
              const cat = classifySkill(r.extra_data);
              // Skip buckets we don't want (category filter) or that are full.
              if (!wantSet.has(cat) || buckets[cat].length >= perBucket) continue;
              seenId.add(id);
              seenName.add(nKey);
              buckets[cat].push({ id, name });
            }
            if (full() || !next || Array.isArray(payload)) break;
          }
        }
        return buckets;
      },

      listFunctionLevels(): Promise<ReferenceItem[]> {
        return self.paginated<ReferenceItem>("/resources/function-level/");
      },

      listEducationDegrees(): Promise<ReferenceItem[]> {
        return self.paginated<ReferenceItem>("/resources/education-degree/");
      },

      listLanguages(): Promise<ReferenceItem[]> {
        return self.paginated<ReferenceItem>("/resources/language/");
      },

      /**
       * Resolve a language NAME → taxonomy id via the language reference list.
       * `/resources/language/` has no `?q=` search on the write side, so we page
       * the full (small, ~200-row) list once and match case-insensitively:
       * exact first, then a prefix fallback ("Dutch" → "Dutch (Netherlands)").
       * Returns null when nothing matches — the caller degrades gracefully.
       */
      async resolveLanguage(name: string): Promise<{ id: number; name: string } | null> {
        const q = (name ?? "").trim().toLowerCase();
        if (!q) return null;
        // Call the paginated endpoint directly (not `self.resources.listLanguages`)
        // to avoid a circular type reference into buildResources' own return type.
        const rows = await self.paginated<ReferenceItem>("/resources/language/");
        const clean = rows
          .map((r) => ({ id: Number(r.id), name: String(r.name ?? "").trim() }))
          .filter((r) => Number.isFinite(r.id) && r.id > 0 && r.name.length > 0);
        const exact = clean.find((r) => r.name.toLowerCase() === q);
        if (exact) return exact;
        const prefix = clean.find(
          (r) => r.name.toLowerCase().startsWith(q) || q.startsWith(r.name.toLowerCase()),
        );
        return prefix ?? null;
      },

      /**
       * Resolve a free-text degree label ("HBO Bachelor", "MBO 4", "BSc") → an
       * `/resources/education-degree/` taxonomy id. Unlike languages, this
       * endpoint supports `?q=` search. Match: exact phrase (ci) → startsWith →
       * first result. Returns null when nothing matches (caller degrades).
       * VERIFIED live: sending the resolved id as `degree_id` on the education
       * POST persists (the nested `degree` object 500s; PATCH is 403 for
       * client_credentials — so degree can ONLY be set at create time via id).
       */
      async resolveEducationDegree(
        phrase: string,
        lang = "nl",
      ): Promise<{ id: number; phrase: string } | null> {
        return self.resolveTaxonomyByPhrase("/resources/education-degree/", phrase, lang);
      },

      /**
       * Resolve a field-of-study label ("Informatica", "Electrical engineering")
       * → an `/resources/education-type/` taxonomy id, sent as `education_type_id`
       * on the education POST (persists live; the free-text `education_type` is
       * read-only and returns "None").
       */
      async resolveEducationType(
        phrase: string,
        lang = "nl",
      ): Promise<{ id: number; phrase: string } | null> {
        return self.resolveTaxonomyByPhrase("/resources/education-type/", phrase, lang);
      },
    };
  }

  /**
   * Shared `?q=`-search resolver for `phrase`-keyed reference endpoints
   * (education-degree / education-type). Exact phrase (ci) wins, then a
   * startsWith either-way, then the first row. Best-effort: any failure → null.
   */
  private async resolveTaxonomyByPhrase(
    path: string,
    phrase: string,
    lang: string,
  ): Promise<{ id: number; phrase: string } | null> {
    const q = (phrase ?? "").trim();
    if (!q) return null;
    try {
      const payload = await this.request<unknown>(path, {
        query: { q, lang },
        endpointKey: path,
      });
      const rows: Array<Record<string, unknown>> = Array.isArray(payload)
        ? (payload as Array<Record<string, unknown>>)
        : Array.isArray((payload as { results?: unknown })?.results)
          ? ((payload as { results: Array<Record<string, unknown>> }).results)
          : [];
      const clean = rows
        .map((r) => ({ id: Number(r.id), phrase: String(r.phrase ?? r.name ?? "").trim() }))
        .filter((r) => Number.isFinite(r.id) && r.id > 0 && r.phrase.length > 0);
      if (clean.length === 0) return null;
      const ql = q.toLowerCase();
      const exact = clean.find((r) => r.phrase.toLowerCase() === ql);
      if (exact) return exact;
      const prefix = clean.find(
        (r) => r.phrase.toLowerCase().startsWith(ql) || ql.startsWith(r.phrase.toLowerCase()),
      );
      return prefix ?? clean[0];
    } catch {
      return null;
    }
  }

  private buildJob(self: VanceClient) {
    return {
      /**
       * `POST /job/` — see `JobCreatePayload`.
       *   - Caller MUST pre-resolve function_name to an INT id (quirk #1).
       *   - lat/lon in `detailed_location` MUST be strings (quirk #4).
       *   - Job-skill rows use `skill` (singular) not `skill_id` (quirk #2).
       *   - At least 3 skills required (8vance match-completeness gate).
       */
      async create(body: JobCreatePayload): Promise<JobRef> {
        if (!body || typeof body !== "object") {
          throw new VanceError("/job/", 0, "create: body required");
        }
        // Dedupe by skill id BEFORE the gate — duplicate rows pass a naive
        // length check but 8vance dedupes on insert, which can drop the job
        // back below the 3-skill completeness wall.
        const jobSkills = Array.isArray(body.skills)
          ? Array.from(new Map(body.skills.map((s) => [Number(s.skill), s])).values())
          : [];
        if (jobSkills.length < 3) {
          throw new VanceError(
            "/job/",
            0,
            `create: at least 3 distinct skills required (got ${jobSkills.length})`,
          );
        }
        self.gateCompanyId(body.company, "/job/");

        // Force lat/lon → string (quirk #4) without mutating caller's input.
        const loc = body.detailed_location;
        const dl = {
          ...loc,
          latitude: String(loc.latitude),
          longitude: String(loc.longitude),
        };
        // Job-create body: scalars + inline detailed_location. Skills are
        // NOT accepted inline — they must be attached as sub-resources
        // (verified: inline skills are dropped, leaving the match
        // completeness gate unsatisfied). See sub-resource loop below.
        const wire: Record<string, unknown> = {
          title: body.title,
          company: body.company,
          function_name: Number(body.function_name), // quirk #1
          function_level: body.function_level,
          status: body.status ?? 1,
          detailed_location: dl,
        };

        const payload = await self.request<JobRef>("/job/", {
          method: "POST",
          body: wire,
          endpointKey: "/job/",
        });
        if (!isRecord(payload) || typeof payload.id !== "number") {
          throw new VanceError("/job/", 0, `unexpected create response: ${JSON.stringify(payload)}`);
        }
        const jobId = payload.id;

        // Attach skills as sub-resources. The completeness gate clears only
        // when at least one skill has must_have=true + experience>0, so we
        // default those. These POSTs are INDEPENDENT, so we fan them out under
        // a small concurrency cap instead of one-by-one. STRICTER handling than
        // the best-effort rows below: a skill attach must NOT be swallowed (the
        // completeness gate depends on all skill rows landing), so we
        // `Promise.all` and let any rejection propagate — same all-or-nothing
        // semantics as the original sequential `await` loop, just parallel.
        const limit = pLimit(ATTACH_CONCURRENCY);
        await Promise.all(
          jobSkills.map((sk) =>
            limit(() =>
              self.request(`/job/${jobId}/skill/`, {
                method: "POST",
                body: {
                  skill: Number(sk.skill), // quirk #2: field is `skill` on jobs
                  proficiency_id: Number(sk.proficiency_id ?? DEFAULT_PROFICIENCY_ID),
                  must_have: sk.must_have ?? true,
                  experience: Number(sk.experience ?? 5),
                },
                endpointKey: "/job/{id}/skill/",
              }),
            ),
          ),
        );

        // Attach language requirements as `/job/{id}/language/` sub-resources
        // (FLAT-array endpoint). Wire body keys on `language` + per-skill
        // levels 0..5; we expand the wizard's 1..5 proficiency onto all three
        // when explicit levels are absent (default = moderate "professional"
        // requirement so we don't over-filter the pool). Best-effort: a single
        // bad row must never orphan an otherwise-complete job, so the per-row
        // try/catch keeps a failure from rejecting the whole batch. Run in
        // parallel (independent POSTs) under the same concurrency cap.
        await Promise.all(
          (body.languages ?? []).map((lang) =>
            limit(async () => {
              const languageId = Number(lang.language);
              if (!Number.isFinite(languageId) || languageId <= 0) return;
              const level = clampLevel(lang.proficiency_id, 4);
              try {
                await self.request(`/job/${jobId}/language/`, {
                  method: "POST",
                  body: {
                    language: languageId,
                    read_level: lang.read_level ?? level,
                    write_level: lang.write_level ?? level,
                    speak_level: lang.speak_level ?? level,
                  },
                  endpointKey: "/job/{id}/language/",
                });
              } catch {
                // Non-fatal: skip this language, keep the job matchable.
              }
            }),
          ),
        );

        // Attach education-degree requirements as `/job/{id}/education_degree/`
        // sub-resources. Quirk: this endpoint uses an UNDERSCORE (most job
        // sub-resources are hyphenated). Live API keys on `degree_id`;
        // `degree_country_id` is optional and omitted (the wizard collects no
        // country). Best-effort like languages above; parallel under the cap.
        await Promise.all(
          (body.education_degrees ?? []).map((ed) =>
            limit(async () => {
              const degreeId = Number(ed.degree_id);
              if (!Number.isFinite(degreeId) || degreeId <= 0) return;
              const edBody: Record<string, unknown> = { degree_id: degreeId };
              if (ed.degree_country_id !== undefined && ed.degree_country_id !== null) {
                edBody.degree_country_id = Number(ed.degree_country_id);
              }
              try {
                await self.request(`/job/${jobId}/education_degree/`, {
                  method: "POST",
                  body: edBody,
                  endpointKey: "/job/{id}/education_degree/",
                });
              } catch {
                // Non-fatal: skip this degree, keep the job matchable.
              }
            }),
          ),
        );

        // Put the job on the 8vance ECOSYSTEM so it's findable for talents (and
        // visible beyond the internal team). EMPIRICALLY verified against live
        // IVTA: the lever is `visibility` ("team" = internal only vs
        // "ecosystem" = shared/findable) — NOT `published` (which stays false
        // even on ecosystem jobs). New jobs default to visibility "team", so
        // without this a findtalent project is invisible to the wider pool.
        // Done AFTER the skill attaches (completeness gate). Best-effort:
        // matching still runs on a team-visibility job, so a failure here must
        // never sink the create (job + skills are already persisted).
        try {
          await self.request(`/job/${jobId}/`, {
            method: "PATCH",
            body: { visibility: "ecosystem" },
            endpointKey: "/job/{id}/",
          });
        } catch {
          // Non-fatal: the job stays team-visibility but is still matchable.
        }

        return payload as JobRef;
      },

      async get(id: number): Promise<JobDetail> {
        return self.request<JobDetail>(`/job/${id}/`, { endpointKey: "/job/{id}/" });
      },

      /**
       * `GET /job/{id}/extended/` — full job incl. `description`, `source`
       * (slug), and `hiring_company_*` (the real employer when a feed/agency
       * posts on someone's behalf = intermediary signal).
       *
       * CRITICAL for external-feed (JobDigger etc.) jobs: without `?context=`
       * this 404s ("No Job matches the given query") because the feed job
       * isn't owned by the API client's company. Passing `context=<talentId>`
       * (the talent the job was matched for) unlocks the full detail —
       * description + hiring_company + web_link — on the PUBLIC API. So the
       * candidate-match enrichment ALWAYS passes the candidate's talent id.
       */
      async getExtended(id: number, contextTalentId?: number): Promise<JobExtended> {
        return self.request<JobExtended>(`/job/${id}/extended/`, {
          query: contextTalentId ? { context: contextTalentId } : undefined,
          endpointKey: "/job/{id}/extended/",
        });
      },

      /**
       * `GET /job/{id}/skill/` — the job's REQUIRED skills (read-only). Paginated
       * `{count,results}` or flat array (gap #9). Each row carries the taxonomy id
       * on `skill`; the resolved name is usually folded in as `skill_name`/`name`.
       *
       * UNLIKE `getExtended`, `?context=` does NOT unlock this endpoint for an
       * open-market / feed job the API client's company doesn't own: VERIFIED
       * live against IVTA, `/job/{id}/skill/` returns 403 ("You do not have
       * permission to perform this action.") for a feed job WITH and WITHOUT
       * context, while own-pool jobs return their rows. Callers must therefore
       * tolerate a rejection here (the candidate-match gap analysis degrades to
       * a detail-only, skills-unavailable card). The `context` param is still
       * passed for parity / future server support, but is not relied upon.
       */
      async getSkills(id: number, contextTalentId?: number): Promise<JobSkill[]> {
        return self.paginated<JobSkill>(`/job/${id}/skill/`, {
          query: contextTalentId ? { context: contextTalentId } : undefined,
          endpointKey: "/job/{id}/skill/",
        });
      },

      /**
       * `GET /match/specific/?job_id=&talent_id=&lead=&gap_analysis=true` — the
       * per-pair gap analysis. CRUCIAL: this returns the job's required skills
       * (as `gap_score.skills[].overlapping_skills`) + the REAL graded score
       * (`match_result.score`, 0..1) EVEN FOR CROSS-COMPANY jobs the client
       * doesn't own — where `/job/{id}/skill/` 403s and the `/match/job/` list
       * hands back a degenerate `score:1`. VERIFIED live (IVTA creds, a job owned
       * by company 34395): 200 with real clusters + score 0.046. `lead` picks
       * which side is the "patient" (talent-lead = default recruiter view).
       */
      async getGapAnalysis(
        jobId: number,
        talentId: number,
        lead: "talent" | "job" = "talent",
      ): Promise<SpecificMatch> {
        return self.request<SpecificMatch>(`/match/specific/`, {
          query: { job_id: jobId, talent_id: talentId, lead, gap_analysis: "true" },
          endpointKey: "/match/specific/",
        });
      },
    };
  }

  private buildMatch(self: VanceClient) {
    return {
      /**
       * `POST /async/talent/match/?job_id=<id>` body `{sources: []}`.
       * Gap #6: `sources` is required; `[]` = "no filter, let backend
       * pick default source set".
       */
      async startAsync(
        jobId: number,
        // `sources` are SOURCE SLUG STRINGS (e.g. "instituut_voor_twijfelachtig_advies"),
        // NOT numeric ids and NOT empty. VERIFIED live: `{"sources":[]}` and numeric
        // ids both 401 "Found invalid sources or not enough privileges"; the own-source
        // SLUG returns 200 + talents. Pass the pool's ownSourceSlug.
        sources: string[] = [],
      ): Promise<MatchTaskHandle> {
        const payload = await self.request<unknown>("/async/talent/match/", {
          method: "POST",
          query: { job_id: jobId },
          body: { sources },
          endpointKey: "/async/talent/match/",
        });
        if (!isRecord(payload)) {
          throw new VanceError("/async/talent/match/", 0, `unexpected: ${JSON.stringify(payload)}`);
        }
        const taskId = payload.task_id ?? payload.id;
        if (taskId === undefined || taskId === null) {
          throw new VanceError("/async/talent/match/", 0, `no task_id in ${JSON.stringify(payload)}`);
        }
        return { task_id: String(taskId) };
      },

      /**
       * `POST /match/talent/?job_id=<id>` body `{sources: [<slug>]}` —
       * synchronous match. Returns the result rows inline (no task). This is the
       * working path for IVTA/BCC (their creds HAVE match scope; the async API
       * just isn't granted), and returns 200 with real 8vance match scores when
       * passed the pool's own-source slug.
       */
      async matchSync(
        jobId: number,
        // `sources` are SOURCE SLUG STRINGS (e.g. "instituut_voor_twijfelachtig_advies"),
        // NOT numeric ids and NOT empty. VERIFIED live: `{"sources":[]}` and numeric
        // ids both 401 "Found invalid sources or not enough privileges"; the own-source
        // SLUG returns 200 + talents. Pass the pool's ownSourceSlug.
        sources: string[] = [],
      ): Promise<MatchResult[]> {
        const fetchPage = async (): Promise<{ rows: MatchResult[]; count: number }> => {
          const payload = await self.request<unknown>("/match/talent/", {
            method: "POST",
            // Without page_size the API returns a small default page; request a
            // full window so the shortlist gets a useful candidate set (deduped +
            // capped downstream at SHORTLIST_CAP). 8vance returned 733 total for a
            // real IVTA job, so 100 is a sensible ceiling on rows we hydrate.
            query: { job_id: jobId, page_size: MATCH_PAGE_SIZE },
            body: { sources },
            endpointKey: "/match/talent/",
          });
          const { rows, count } = extractMatchRows<MatchResult>(payload);
          // CRITICAL: reverse-match rows carry the talent id on `id`, not
          // `talent_id` — normalize or hydrate drops every row (see withTalentIds).
          return { rows: withTalentIds(rows), count };
        };
        // UNDER-DELIVERY RETRY: 8vance's reverse-match intermittently returns a
        // near-empty page (e.g. 2 rows) while reporting count=733 — verified live:
        // the same job swings between 2 and 733. When the page is short of what
        // `count` promises, retry once after a short delay to ride out the blip.
        return matchWithRetry(fetchPage);
      },

      /**
       * Start matching with graceful degradation: try the async task API,
       * and on a 403 (credential without async scope) fall back to the
       * synchronous endpoint, returning the results inline.
       */
      async start(
        jobId: number,
        // `sources` are SOURCE SLUG STRINGS (e.g. "instituut_voor_twijfelachtig_advies"),
        // NOT numeric ids and NOT empty. VERIFIED live: `{"sources":[]}` and numeric
        // ids both 401 "Found invalid sources or not enough privileges"; the own-source
        // SLUG returns 200 + talents. Pass the pool's ownSourceSlug.
        sources: string[] = [],
      ): Promise<
        | { mode: "async"; taskId: string }
        | { mode: "sync"; results: MatchResult[] }
        | { mode: "fallback" }
      > {
        // SYNC-FIRST. The synchronous `/match/talent/` endpoint returns the full
        // ranked result set in ~2s and is reliable. The async task API, when the
        // credential DOES have async scope, frequently HANGS in "processing"
        // forever (no completion, no failure) — which left projects stuck
        // "matching" with 0 results indefinitely, even though the sync match
        // would have returned hundreds of talents in ~2s (verified live on IVTA:
        // sync → 200 + 733 talents in 1.8s while the async task never settled).
        // So sync is the primary path; we no longer wait on the async task.
        try {
          const results = await self.match.matchSync(jobId, sources);
          return { mode: "sync", results };
        } catch (err) {
          // Sync rejected (a pool whose ownSourceSlug is missing/wrong, or a
          // genuinely scope-less credential) → degrade to the local ranker so
          // the project gets a clearly-tagged 'fallback' shortlist instead of a
          // dead "Match task failed". Any non-auth error is surfaced loudly.
          if (
            err instanceof VanceError &&
            [401, 403, 404, 422, 400].includes(err.status)
          ) {
            return { mode: "fallback" };
          }
          throw err;
        }
      },

      async pollStatus(taskId: string): Promise<MatchStatus> {
        const payload = await self.request<unknown>("/async/task-status/", {
          query: { task_id: taskId },
          endpointKey: "/async/task-status/",
        });
        if (!isRecord(payload)) {
          return { status: "queued" };
        }
        const rawState = String(payload.status ?? payload.state ?? "").toLowerCase();
        const normalised: MatchStatus["status"] =
          rawState === "success" || rawState === "succeeded" || rawState === "done" || rawState === "completed"
            ? "completed"
            : rawState === "failure" || rawState === "failed" || rawState === "error"
            ? "failed"
            : rawState === "processing" || rawState === "running" || rawState === "started"
            ? "processing"
            : "queued";
        return { ...payload, status: normalised };
      },

      async getResults(
        taskId: string,
        jobId: number,
        page = 1,
        pageSize = 25,
      ): Promise<PaginatedResponse<MatchResult>> {
        const payload = await self.request<unknown>("/async/talent/results/", {
          query: { task_id: taskId, job_id: jobId, page, page_size: pageSize },
          endpointKey: "/async/talent/results/",
        });
        if (Array.isArray(payload)) {
          return {
            count: payload.length,
            next: null,
            previous: null,
            // Reverse-match rows carry the talent id on `id` — normalize (see withTalentIds).
            results: withTalentIds(payload as MatchResult[]),
          };
        }
        if (isRecord(payload)) {
          return {
            count: typeof payload.count === "number" ? payload.count : (Array.isArray(payload.results) ? payload.results.length : 0),
            next: typeof payload.next === "string" ? payload.next : null,
            previous: typeof payload.previous === "string" ? payload.previous : null,
            results: Array.isArray(payload.results) ? withTalentIds(payload.results as MatchResult[]) : [],
          };
        }
        return { count: 0, next: null, previous: null, results: [] };
      },

      /**
       * Convenience: submit, poll until `completed`/`failed` (default 60
       * attempts × 2s = 120s wall budget), then fetch all result pages.
       */
      async runToCompletion(
        jobId: number,
        opts: MatchRunToCompletionOpts = {},
      ): Promise<MatchResult[]> {
        const interval = opts.pollIntervalMs ?? MATCH_POLL_INTERVAL_MS;
        const maxAttempts = opts.maxAttempts ?? MATCH_POLL_MAX_ATTEMPTS;
        const pageSize = opts.pageSize ?? 25;
        const handle = await self.match.startAsync(jobId, opts.sources ?? []);
        let attempt = 0;
        while (attempt < maxAttempts) {
          const status = await self.match.pollStatus(handle.task_id);
          if (status.status === "completed") break;
          if (status.status === "failed") {
            throw new VanceError("/async/task-status/", 0, status, "match task failed");
          }
          await sleep(interval);
          attempt += 1;
        }
        if (attempt >= maxAttempts) {
          throw new VanceError(
            "/async/task-status/",
            0,
            `task ${handle.task_id} did not complete in ${(maxAttempts * interval) / 1000}s`,
          );
        }
        // Fetch all pages.
        const all: MatchResult[] = [];
        let page = 1;
        while (page <= 100) {
          const r = await self.match.getResults(handle.task_id, jobId, page, pageSize);
          all.push(...r.results);
          if (!r.next) break;
          page += 1;
        }
        return all;
      },
    };
  }

  /**
   * `/feedback/` — inbound interest signals on a job (gap #18: scope drift, so
   * we read the rows defensively). `direction = 1` is the Applicant-to-project
   * direction: the talent liked/applied to OUR published job via the 8vance
   * career portal. One of company_id/job_id/talent_id is required; `job_id`
   * works with our `feedback` client scope.
   */
  private buildFeedback(self: VanceClient) {
    return {
      /**
       * List the talents who applied to / liked the given job (`direction=1`).
       * Paginates the `{count,next,results}` envelope (or flat array, gap #9)
       * and returns one normalized row per applicant with a USABLE talent id —
       * rows without a numeric talent id are dropped. No lang param (this is a
       * relational read, not taxonomy). De-duped on talentId, keeping the first
       * (most-recent-first as 8vance returns) occurrence.
       */
      async listApplicants(jobId: number): Promise<FeedbackApplicant[]> {
        if (!Number.isFinite(jobId) || jobId <= 0) return [];
        const rows = await self.paginated<FeedbackRow>("/feedback/", {
          query: { job_id: jobId, direction: 1 },
          endpointKey: "/feedback/",
        });
        const out: FeedbackApplicant[] = [];
        const seen = new Set<number>();
        for (const r of rows) {
          if (!isRecord(r)) continue;
          // The talent id arrives on `talent_id` or `talent` depending on deploy.
          const rawId = r.talent_id ?? r.talent;
          const talentId = Number(rawId);
          if (!Number.isFinite(talentId) || talentId <= 0) continue;
          if (seen.has(talentId)) continue;
          seen.add(talentId);
          const appliedAt =
            typeof r.added_at === "string" && r.added_at.trim()
              ? r.added_at
              : typeof r.updated_at === "string" && r.updated_at.trim()
                ? r.updated_at
                : null;
          out.push({ talentId, appliedAt, applied: r.applied === true });
        }
        return out;
      },
    };
  }

  /**
   * Inverse match: jobs for a talent (candidate-match module).
   *   - async:  `POST /async/job/match/?talent_id=` → poll → `GET /async/job/results/`
   *   - sync:   `POST /match/job/?talent_id=` (fallback when no async scope)
   * `sources` here is a STRING list of source slugs (e.g. ["jobdigger"] or the
   * own-pool source label) — unlike talent-match which takes numeric ids.
   */
  private buildMatchJobs(self: VanceClient) {
    return {
      async startAsync(talentId: number, sources: string[] = []): Promise<MatchTaskHandle> {
        const payload = await self.request<unknown>("/async/job/match/", {
          method: "POST",
          query: { talent_id: talentId },
          body: { sources },
          endpointKey: "/async/job/match/",
        });
        if (!isRecord(payload)) {
          throw new VanceError("/async/job/match/", 0, `unexpected: ${JSON.stringify(payload)}`);
        }
        const taskId = payload.task_id ?? payload.id;
        if (taskId === undefined || taskId === null) {
          throw new VanceError("/async/job/match/", 0, `no task_id in ${JSON.stringify(payload)}`);
        }
        return { task_id: String(taskId) };
      },

      async matchSync(
        talentId: number,
        sources: string[] = [],
        filters?: MatchFilters,
      ): Promise<JobMatchResult[]> {
        const fetchPage = async (): Promise<{ rows: JobMatchResult[]; count: number }> => {
          const payload = await self.request<unknown>("/match/job/", {
            method: "POST",
            query: { talent_id: talentId, page_size: MATCH_PAGE_SIZE },
            body: buildMatchBody(sources, filters),
            endpointKey: "/match/job/",
          });
          return extractMatchRows<JobMatchResult>(payload);
        };
        // Same under-delivery retry as the reverse match (a freshly-onboarded
        // talent's forward match returns 0 then 181 a moment later).
        return matchWithRetry(fetchPage);
      },

      async getResults(
        taskId: string,
        talentId: number,
        page = 1,
        pageSize = 50,
      ): Promise<PaginatedResponse<JobMatchResult>> {
        const payload = await self.request<unknown>("/async/job/results/", {
          query: { task_id: taskId, talent_id: talentId, page, page_size: pageSize },
          endpointKey: "/async/job/results/",
        });
        if (Array.isArray(payload)) {
          return { count: payload.length, next: null, previous: null, results: payload as JobMatchResult[] };
        }
        if (isRecord(payload)) {
          return {
            count: typeof payload.count === "number" ? payload.count : (Array.isArray(payload.results) ? payload.results.length : 0),
            next: typeof payload.next === "string" ? payload.next : null,
            previous: typeof payload.previous === "string" ? payload.previous : null,
            results: Array.isArray(payload.results) ? (payload.results as JobMatchResult[]) : [],
          };
        }
        return { count: 0, next: null, previous: null, results: [] };
      },

      /**
       * Run the talent→jobs match for one source set and return the rows.
       *
       * ERRORS THROW — deliberately. This used to map 400/401/403/404/422 to
       * `[]` ("credential can't match this source → pretend no jobs"), which
       * made a source-level failure indistinguishable from a genuinely empty
       * feed. Verified live 2026-07-08: `/match/job/` rejected a talent's own
       * listed feed source with 401 "Found invalid sources or not enough
       * privileges" → every re-match silently "found" 0 open-market jobs, a
       * 106-job shortlist was superseded by 6 own-pool rows, and the run
       * recorded NO skip reason. The only caller (service.executeMatchRun)
       * catches PER SOURCE and records `{slug, reason}` onto the run, so
       * throwing turns a broken feed into an explainable "skipped (error)"
       * instead of an honest-looking zero.
       */
      async runToCompletion(
        talentId: number,
        sources: string[] = [],
        opts: { pollIntervalMs?: number; maxAttempts?: number; pageSize?: number; filters?: MatchFilters } = {},
      ): Promise<JobMatchResult[]> {
        const interval = opts.pollIntervalMs ?? MATCH_POLL_INTERVAL_MS;
        const maxAttempts = opts.maxAttempts ?? MATCH_POLL_MAX_ATTEMPTS;
        const pageSize = opts.pageSize ?? 50;
        // SYNC-FIRST (same reasoning as match.start): the synchronous
        // `/match/job/` endpoint returns ranked jobs in ~2s. The async job-match
        // task frequently HANGS in "processing" — the old code then polled to
        // maxAttempts and threw "did not complete in Ns", which is exactly the
        // "candidate match keeps searching forever" symptom. Prefer sync.
        void interval; void maxAttempts; void pageSize;
        return await self.matchJobs.matchSync(talentId, sources, opts.filters);
      },
    };
  }

  private buildTalent(self: VanceClient) {
    return {
      /**
       * `POST /talent/` + skill/language/location sub-resources, mirroring
       * `job.create`. Caller pre-resolves skill/language ids. ≥3 skills keeps
       * the match-completeness gate satisfied (same gate as jobs).
       */
      async create(body: TalentCreatePayload): Promise<{ id: number }> {
        if (!body || typeof body !== "object" || !body.full_name) {
          throw new VanceError("/talent/", 0, "create: full_name required");
        }
        const talentSkills = Array.isArray(body.skills)
          ? Array.from(new Map(body.skills.map((s) => [Number(s.skill), s])).values())
          : [];
        if (talentSkills.length < 3) {
          throw new VanceError("/talent/", 0, `create: at least 3 distinct skills required (got ${talentSkills.length})`);
        }
        if (body.company !== undefined) self.gateCompanyId(body.company, "/talent/");

        // 8vance stores the name as first_name/last_name — `full_name` alone is
        // NOT split server-side, so a talent created with only full_name ends up
        // NAMELESS (verified live on ACC). Split it so the name actually lands.
        const nameParts = body.full_name.trim().split(/\s+/);
        const firstName = nameParts[0] ?? body.full_name.trim();
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";

        const wire: Record<string, unknown> = {
          full_name: body.full_name,
          first_name: firstName,
          last_name: lastName,
          source: body.source,
          // Without this the talent is created with participate_in_matching=false
          // and is INVISIBLE to job→talent matching (verified live) — so a synced
          // candidate would never surface in any recruiter shortlist. The other
          // visibility/completeness flags (data_ownership/available/job_status/
          // availability_start_date) are set via a best-effort PATCH AFTER create
          // (see below) — kept off the POST so an unexpected field rejection can
          // never 400 the whole talent create.
          participate_in_matching: true,
        };
        if (body.company !== undefined) wire.company = body.company;
        if (body.email) wire.email = body.email;
        if (body.phone) wire.phone = body.phone;
        if (body.about_me) wire.about_me = body.about_me;

        // POST the talent. 8vance REQUIRES `source` to be a source that already
        // exists on the company (a non-existent slug → 400 "Object with name=X
        // does not exist"). A mis-/un-configured tenant.ownSourceSlug is the #1
        // cause of candidate sync failures, so on that specific 400 we discover
        // a real source for the company (from an existing talent's /sources/)
        // and retry ONCE — making sync robust to a bad pool source config.
        const postTalent = async (): Promise<unknown> =>
          self.request<unknown>("/talent/", { method: "POST", body: wire, endpointKey: "/talent/" });

        const isSourceError = (err: unknown): boolean => {
          if (!(err instanceof VanceError) || err.status !== 400) return false;
          // Must specifically implicate the `source` field — the 400 body is
          // `{"source":["Object with name=X does not exist."]}`. Requiring the
          // word "source" avoids retrying an unrelated 400 (e.g. another field
          // that also says "does not exist").
          const blob = `${err.message} ${JSON.stringify(err.body ?? "")}`.toLowerCase();
          return blob.includes("source");
        };

        let payload: unknown;
        try {
          payload = await postTalent();
        } catch (err) {
          if (!isSourceError(err)) throw err;
          // Discover a valid source from an existing talent of this company.
          // #12 fix: the old code took the FIRST non-empty slug, which on a
          // tenant with external feeds enabled (JobDigger / public_vacancies_*)
          // could be an open-market FEED slug — labelling our own talent with a
          // feed source corrupts pool ownership. Prefer the tenant's OWN talent
          // pool: (a) the originally-requested slug if it surfaces in the list,
          // else (b) the first slug that does NOT look like an external feed.
          // Only as a last resort fall back to any non-empty slug.
          const FEED_SLUG = /vacatures|vacancies|jobdigger|public_|onlinevacatures|ecosystem/i;
          const wanted = typeof wire.source === "string" ? wire.source : null;
          let recovered: string | null = null;
          try {
            const ids = await self.listTalentIds(1);
            if (ids[0] !== undefined) {
              const sources = (await self.talent.getSources(ids[0])).filter(
                (s) => typeof s === "string" && s.trim().length > 0,
              );
              const ownLike = sources.filter((s) => !FEED_SLUG.test(s));
              recovered =
                (wanted && sources.includes(wanted) ? wanted : null) ??
                ownLike[0] ??
                sources[0] ??
                null;
              // Substituting a source is a config-quality signal worth surfacing
              // (the tenant's ownSourceSlug didn't validate). Slugs are non-secret.
              if (recovered && recovered !== wanted) {
                reportError(
                  new VanceError("/talent/", 0, "source auto-recovery substituted slug"),
                  {
                    area: "eightvance.talent.create.source-recovery",
                    requested: wanted ?? null,
                    recovered,
                    candidates: sources,
                  },
                );
              }
            }
          } catch {
            /* discovery failed — fall through to rethrow the original error */
          }
          if (!recovered || recovered === wire.source) throw err;
          wire.source = recovered;
          payload = await postTalent();
        }
        if (!isRecord(payload) || typeof payload.id !== "number") {
          throw new VanceError("/talent/", 0, `unexpected create response: ${JSON.stringify(payload)}`);
        }
        const talentId = payload.id;

        // Completeness / visibility flags via a best-effort PATCH (kept OFF the
        // create POST so a field rejection can't 400 the whole talent). Without
        // these a synced talent stays data_ownership=0 (PRIVATE): 8vance filters
        // it out of public (client_credentials) GET-by-id once its index settles
        // — verified live, a fresh talent returned 200 then 404 ~15min later —
        // and it's under-discoverable in reverse matching. Set discoverable +
        // actively-looking + available-now. Non-fatal: the talent already exists,
        // so a PATCH failure just leaves the (pre-existing) defaults.
        try {
          await self.request(`/talent/${talentId}/`, {
            method: "PATCH",
            body: {
              participate_in_matching: true,
              data_ownership: 1,
              available: true,
              job_status: 1,
              availability_start_date: new Date().toISOString().slice(0, 10),
            },
            endpointKey: "/talent/{id}/",
          });
        } catch (err) {
          console.error(`[8vance] talent ${talentId} visibility PATCH failed`, err);
        }

        // Skills as sub-resources. Talent-skill rows accept ONLY
        // {skill_id, proficiency_id} — sending job-skill fields (must_have /
        // experience) makes the endpoint 500 (verified on ACC).
        //
        // Per-skill try/catch (same best-effort posture as languages/education):
        // the talent row is ALREADY created above, so letting one skill POST
        // throw would abort the function before `talentId` is returned/stored —
        // leaving an orphaned talent in 8vance and causing a duplicate on retry.
        // We instead keep the talent and surface a warning if too few skills land.
        // Sub-resource attaches are INDEPENDENT POSTs, so fan them out under a
        // small concurrency cap (skills + languages + location + education +
        // job-experience all share the same limiter) instead of one-by-one.
        // Each row keeps its own try/catch — a bad row must NOT reject the
        // batch and orphan the already-created talent. Skill count is tracked
        // for the <3 match-gate warning (Promise.all preserves all rows).
        const limit = pLimit(ATTACH_CONCURRENCY);
        let skillsCreated = 0;
        await Promise.all(
          talentSkills.map((sk) =>
            limit(async () => {
              try {
                await self.request(`/talent/${talentId}/skill/`, {
                  method: "POST",
                  body: {
                    skill_id: Number(sk.skill),
                    proficiency_id: Number(sk.proficiency_id ?? DEFAULT_PROFICIENCY_ID),
                  },
                  endpointKey: "/talent/{id}/skill/",
                });
                skillsCreated += 1;
              } catch (err) {
                console.error(`[8vance] talent ${talentId} skill ${sk.skill} create failed`, err);
              }
            }),
          ),
        );
        if (skillsCreated < 3) {
          console.error(
            `[8vance] talent ${talentId} created with only ${skillsCreated} skills (<3 match gate) — check skill ids/proficiency`,
          );
        }

        await Promise.all(
          (body.languages ?? []).map((lang) =>
            limit(async () => {
              const languageId = Number(lang.language);
              if (!Number.isFinite(languageId) || languageId <= 0) return;
              const level = clampLevel(lang.proficiency_id, 4);
              try {
                await self.request(`/talent/${talentId}/language/`, {
                  method: "POST",
                  body: {
                    language: languageId,
                    read_level: lang.read_level ?? level,
                    write_level: lang.write_level ?? level,
                    speak_level: lang.speak_level ?? level,
                  },
                  endpointKey: "/talent/{id}/language/",
                });
              } catch {
                // Non-fatal: keep the talent matchable.
              }
            }),
          ),
        );

        if (body.detailed_location && (body.detailed_location.city || body.detailed_location.latitude)) {
          const loc = body.detailed_location;
          try {
            await self.request(`/talent/${talentId}/location/`, {
              method: "POST",
              body: {
                ...loc,
                latitude: loc.latitude !== undefined ? String(loc.latitude) : undefined,
                longitude: loc.longitude !== undefined ? String(loc.longitude) : undefined,
              },
              endpointKey: "/talent/{id}/location/",
            });
          } catch {
            // Non-fatal.
          }
        }

        // Education sub-resources (`/talent/{id}/education/`). WRITE contract
        // (re-verified live 2026-07-01): `school` + `start_date` + `end_date`
        // persist, AND — crucially — the RESOLVED taxonomy ids `degree_id` +
        // `education_type_id` persist ON CREATE (readback shows the real degree
        // phrase + education_type). What does NOT work: the nested `degree`
        // object {phrase,...} → 500, and PATCHing the row later → 403 for
        // client_credentials. So degree/field can only be set here, at POST
        // time, via resolved ids — which is why earlier onboarded talents show
        // "None". Resolve the free-text degree/field to ids first (best-effort;
        // an unresolved label just omits that id, never blocks the row).
        await Promise.all(
          (body.education ?? []).map((ed) =>
            limit(async () => {
              const edBody: Record<string, unknown> = {};
              if (ed.institution) edBody.school = ed.institution;
              const eduStart = yearToDate(ed.startYear);
              const eduEnd = yearToDate(ed.endYear);
              if (eduStart) edBody.start_date = eduStart;
              if (eduEnd) edBody.end_date = eduEnd;
              if (ed.degree && ed.degree.trim()) {
                const d = await self.resources.resolveEducationDegree(ed.degree).catch(() => null);
                if (d) edBody.degree_id = d.id;
              }
              if (ed.field && ed.field.trim()) {
                const f = await self.resources.resolveEducationType(ed.field).catch(() => null);
                if (f) edBody.education_type_id = f.id;
              }
              // Skip an entirely empty row (nothing mappable the API accepts).
              if (Object.keys(edBody).length === 0) return;
              try {
                await self.request(`/talent/${talentId}/education/`, {
                  method: "POST",
                  body: edBody,
                  endpointKey: "/talent/{id}/education/",
                });
              } catch {
                // Non-fatal: skip this education row, keep the talent matchable.
              }
            }),
          ),
        );

        // Work-experience sub-resources (`/talent/{id}/job-experience/`). WRITE
        // contract VERIFIED LIVE on ACC (2026-06-17): `function_title`,
        // `company_name`, `current_job`, `description`, `start_date`/`end_date`
        // all persist (round-tripped via GET). Try-per-row, same posture as above.
        await Promise.all(
          (body.experience ?? []).map((ex) =>
            limit(async () => {
              const exBody: Record<string, unknown> = {};
              if (ex.title) exBody.function_title = ex.title;
              if (ex.company) exBody.company_name = ex.company;
              if (ex.current !== undefined && ex.current !== null) exBody.current_job = Boolean(ex.current);
              if (ex.description) exBody.description = ex.description;
              const exStart = yearToDate(ex.startYear);
              const exEnd = yearToDate(ex.endYear);
              if (exStart) exBody.start_date = exStart;
              if (exEnd) exBody.end_date = exEnd;
              if (Object.keys(exBody).length === 0) return;
              try {
                await self.request(`/talent/${talentId}/job-experience/`, {
                  method: "POST",
                  body: exBody,
                  endpointKey: "/talent/{id}/job-experience/",
                });
              } catch {
                // Non-fatal: skip this experience row, keep the talent matchable.
              }
            }),
          ),
        );

        // Link the talent's primary FUNCTION (function_name). 8vance hides a
        // talent from reverse (job→talent) matching entirely when it has no
        // linked function_name — so without this, every onboarded candidate is
        // invisible to project shortlists regardless of skill overlap. Posting
        // job-experience above auto-creates functional-area rows with a NULL
        // function_name_id; we PATCH one of those with the resolved id (POST a
        // fresh row only if none exist). VERIFIED live on PROD: PATCH
        // {function_name_id} → 200; POSTing a duplicate function → 400
        // "already registered". Best-effort: a failure never orphans the talent.
        if (body.functionNameId != null && Number.isFinite(body.functionNameId)) {
          try {
            const faPayload = await self.request<unknown>(
              `/talent/${talentId}/functional-area/`,
              { endpointKey: "/talent/{id}/functional-area/" },
            );
            const { rows: faRows } = unwrapPaginated<{
              id?: number | string;
              function_name_id?: number | null;
            }>(faPayload);
            const slot = faRows.find((r) => r.function_name_id == null && r.id != null);
            if (slot) {
              await self.request(
                `/talent/${talentId}/functional-area/${slot.id}/`,
                {
                  method: "PATCH",
                  body: { function_name_id: body.functionNameId },
                  endpointKey: "/talent/{id}/functional-area/{fa_id}/",
                },
              );
            } else {
              await self.request(`/talent/${talentId}/functional-area/`, {
                method: "POST",
                body: { function_name_id: body.functionNameId },
                endpointKey: "/talent/{id}/functional-area/",
              });
            }
          } catch {
            // Non-fatal: talent created; just not reverse-matchable until linked.
          }
        }

        return { id: talentId };
      },

      /**
       * `PATCH /talent/{id}/` — partial update of the talent's main record.
       * Used by the candidate-edit flow to write the recruiter-authored
       * `about_me` (verified-writable free-text field; see TalentCreatePayload).
       * Only sends keys that are present so we never clobber other fields.
       */
      async update(id: number, body: TalentUpdateInput): Promise<TalentProfile> {
        const wire: Record<string, unknown> = {};
        if (body.about_me !== undefined) wire.about_me = body.about_me;
        if (body.email !== undefined) wire.email = body.email;
        if (body.phone !== undefined) wire.phone = body.phone;
        if (Object.keys(wire).length === 0) {
          // Nothing to change — return the current record without a write.
          return self.talent.getProfile(id);
        }
        return self.request<TalentProfile>(`/talent/${id}/`, {
          method: "PATCH",
          body: wire,
          endpointKey: "/talent/{id}/",
        });
      },

      /**
       * `POST /talent/{id}/skill/` — attach ONE skill to an existing talent.
       * Talent-skill rows key on `skill_id` (gap #4) and accept only
       * `{skill_id, proficiency_id}` (job-skill fields like must_have/experience
       * 500 the endpoint — verified on ACC; mirrors the create() skill loop).
       * Caller pre-resolves the skill NAME→id via `resources.resolveSkills`.
       */
      async addSkill(id: number, skill: TalentSkillAddInput): Promise<void> {
        const skillId = Number(skill.skill_id);
        if (!Number.isFinite(skillId) || skillId <= 0) {
          throw new VanceError("/talent/{id}/skill/", 0, "addSkill: skill_id required");
        }
        await self.request(`/talent/${id}/skill/`, {
          method: "POST",
          body: {
            skill_id: skillId,
            proficiency_id: Number(skill.proficiency_id ?? DEFAULT_PROFICIENCY_ID),
          },
          endpointKey: "/talent/{id}/skill/",
        });
      },

      /**
       * `PATCH /talent/{id}/skill/{rowId}/` body `{proficiency_id}` — change an
       * EXISTING talent-skill row's proficiency level without touching the skill
       * itself. `rowId` is the JUNCTION-record id (the `id` on a GET
       * `/talent/{id}/skill/` row), NOT the skill taxonomy id. `proficiency_id`
       * is on the 23..27 scale (1..5 stars; see DEFAULT_PROFICIENCY_ID + the
       * wizard's levelToProficiencyId).
       *
       * 8vance ASSUMPTION (could not be live-tested): the talent-skill
       * sub-resource is a standard DRF nested route, so it accepts PATCH on the
       * row exactly like the POST that created it accepts `{skill_id,
       * proficiency_id}`. PATCH carries ONLY `proficiency_id` so we never
       * re-send `skill_id` (which on POST 500s when paired with job-skill
       * fields). If a deploy rejects PATCH on the row (405/404/400), the caller
       * (updateTalentSkillAction) falls back to remove-then-add: DELETE the row
       * via {@link removeSkill} + re-POST via {@link addSkill} with the new
       * proficiency — same net effect, new junction-row id.
       */
      async updateSkill(
        id: number,
        rowId: number,
        body: { proficiency_id: number },
      ): Promise<void> {
        const junctionId = Number(rowId);
        if (!Number.isFinite(junctionId) || junctionId <= 0) {
          throw new VanceError("/talent/{id}/skill/{rowId}/", 0, "updateSkill: rowId required");
        }
        const proficiencyId = Number(body?.proficiency_id);
        if (!Number.isFinite(proficiencyId) || proficiencyId <= 0) {
          throw new VanceError("/talent/{id}/skill/{rowId}/", 0, "updateSkill: proficiency_id required");
        }
        await self.request(`/talent/${id}/skill/${junctionId}/`, {
          method: "PATCH",
          body: { proficiency_id: proficiencyId },
          endpointKey: "/talent/{id}/skill/{rowId}/",
        });
      },

      /**
       * `DELETE /talent/{id}/skill/{rowId}/` — detach a skill from a talent.
       * `rowId` is the JUNCTION-record id (the `id` field on a GET
       * `/talent/{id}/skill/` row, documented as the DELETE target on
       * {@link TalentSkill}), NOT the skill taxonomy id. Standard DRF
       * sub-resource delete pattern (same shape as the POST above).
       */
      async removeSkill(id: number, rowId: number): Promise<void> {
        const junctionId = Number(rowId);
        if (!Number.isFinite(junctionId) || junctionId <= 0) {
          throw new VanceError("/talent/{id}/skill/{rowId}/", 0, "removeSkill: rowId required");
        }
        await self.request(`/talent/${id}/skill/${junctionId}/`, {
          method: "DELETE",
          endpointKey: "/talent/{id}/skill/{rowId}/",
        });
      },

      /**
       * `POST /talent/{id}/job-experience/` — attach ONE work-experience row.
       * FULL write contract is supported (verified live on ACC, see create()):
       * function_title / company_name / current_job / description / start_date /
       * end_date all persist. Years are coerced to `YYYY-01-01`.
       */
      async addExperience(id: number, ex: TalentExperienceInput): Promise<void> {
        const exBody: Record<string, unknown> = {};
        if (ex.title) exBody.function_title = ex.title;
        if (ex.company) exBody.company_name = ex.company;
        if (ex.current !== undefined && ex.current !== null) {
          exBody.current_job = Boolean(ex.current);
        }
        if (ex.description) exBody.description = ex.description;
        const exStart = yearToDate(ex.startYear);
        const exEnd = yearToDate(ex.endYear);
        if (exStart) exBody.start_date = exStart;
        if (exEnd) exBody.end_date = exEnd;
        if (Object.keys(exBody).length === 0) {
          throw new VanceError("/talent/{id}/job-experience/", 0, "addExperience: empty row");
        }
        await self.request(`/talent/${id}/job-experience/`, {
          method: "POST",
          body: exBody,
          endpointKey: "/talent/{id}/job-experience/",
        });
      },

      /**
       * `POST /talent/{id}/education/` — attach ONE education row. 8vance API
       * GAP (verified live on ACC 2026-06-17): only `school` + `start_date` +
       * `end_date` persist here. The free-text `degree`/`field` map onto a
       * nested degree object / read-only `education_type` that 500 on write, so
       * we send school + dates ONLY (sending degree would 400 the whole row).
       */
      async addEducation(id: number, ed: TalentEducationInput): Promise<void> {
        const edBody: Record<string, unknown> = {};
        if (ed.institution) edBody.school = ed.institution;
        const eduStart = yearToDate(ed.startYear);
        const eduEnd = yearToDate(ed.endYear);
        if (eduStart) edBody.start_date = eduStart;
        if (eduEnd) edBody.end_date = eduEnd;
        // degree / field-of-study DO persist when sent as RESOLVED taxonomy ids
        // (`degree_id` / `education_type_id`) at create time — the nested object
        // 500s and a later PATCH is 403, so this POST is the only window.
        if (ed.degree && ed.degree.trim()) {
          const d = await self.resources.resolveEducationDegree(ed.degree).catch(() => null);
          if (d) edBody.degree_id = d.id;
        }
        if (ed.field && ed.field.trim()) {
          const f = await self.resources.resolveEducationType(ed.field).catch(() => null);
          if (f) edBody.education_type_id = f.id;
        }
        if (Object.keys(edBody).length === 0) {
          throw new VanceError("/talent/{id}/education/", 0, "addEducation: school required");
        }
        await self.request(`/talent/${id}/education/`, {
          method: "POST",
          body: edBody,
          endpointKey: "/talent/{id}/education/",
        });
      },

      /**
       * `POST /talent/{id}/language/` — attach ONE spoken/written language to an
       * existing talent. Mirrors the create() language loop: the row keys on the
       * numeric `language` taxonomy id and carries read/write/speak levels (a
       * single 1..5 `level`, clamped, applied to all three when a per-skill
       * breakdown isn't known). Caller pre-resolves the language NAME→id via
       * `resources.resolveLanguage`.
       */
      async addLanguage(
        id: number,
        lang: { language: number; level?: number | null },
      ): Promise<void> {
        const languageId = Number(lang.language);
        if (!Number.isFinite(languageId) || languageId <= 0) {
          throw new VanceError("/talent/{id}/language/", 0, "addLanguage: language id required");
        }
        const level = clampLevel(lang.level ?? undefined, 4);
        await self.request(`/talent/${id}/language/`, {
          method: "POST",
          body: {
            language: languageId,
            read_level: level,
            write_level: level,
            speak_level: level,
          },
          endpointKey: "/talent/{id}/language/",
        });
      },

      /**
       * Link a resolved primary FUNCTION (`function_name_id`) onto the talent so
       * it stays visible to reverse (job→talent) matching — mirrors the create()
       * functional-area step. Posting a job-experience auto-creates a
       * functional-area row with a NULL `function_name_id`; we PATCH one of those
       * with the resolved id (POST a fresh row only if none exist). VERIFIED live
       * on PROD in create(): PATCH {function_name_id} → 200; POSTing a duplicate
       * function → 400 "already registered". Caller wraps best-effort.
       */
      async linkFunctionName(id: number, functionNameId: number): Promise<void> {
        const fnId = Number(functionNameId);
        if (!Number.isFinite(fnId) || fnId <= 0) {
          throw new VanceError(
            "/talent/{id}/functional-area/",
            0,
            "linkFunctionName: function_name_id required",
          );
        }
        const faPayload = await self.request<unknown>(
          `/talent/${id}/functional-area/`,
          { endpointKey: "/talent/{id}/functional-area/" },
        );
        const { rows: faRows } = unwrapPaginated<{
          id?: number | string;
          function_name_id?: number | null;
        }>(faPayload);
        const slot = faRows.find((r) => r.function_name_id == null && r.id != null);
        if (slot) {
          await self.request(`/talent/${id}/functional-area/${slot.id}/`, {
            method: "PATCH",
            body: { function_name_id: fnId },
            endpointKey: "/talent/{id}/functional-area/{fa_id}/",
          });
        } else {
          await self.request(`/talent/${id}/functional-area/`, {
            method: "POST",
            body: { function_name_id: fnId },
            endpointKey: "/talent/{id}/functional-area/",
          });
        }
      },

      getProfile(id: number): Promise<TalentProfile> {
        return self.request<TalentProfile>(`/talent/${id}/`, {
          endpointKey: "/talent/{id}/",
        });
      },

      /**
       * Upload a CV document to a talent via `POST /talent/{id}/cv-upload/`
       * (multipart, field `cv_file`; verified live → 202 with client_credentials).
       * `reparse=true` (8vance default) re-runs 8vance's own CV parser on the file
       * to enrich the talent server-side. Accepted extensions: doc/docx/txt/pdf/
       * rtf/odt — so we can attach the extracted CV TEXT as a `.txt` when the
       * original file bytes aren't retained. Returns nothing (202 Accepted; the
       * parse runs async — poll /cv-upload-status/ if needed). Throws VanceError
       * on a non-2xx so the caller can decide (sync treats it best-effort).
       */
      async uploadCv(
        id: number,
        bytes: Uint8Array,
        filename: string,
        opts: { reparse?: boolean; contentType?: string } = {},
      ): Promise<void> {
        const fd = new FormData();
        fd.append(
          "cv_file",
          new Blob([bytes as unknown as BlobPart], {
            type: opts.contentType ?? "application/octet-stream",
          }),
          filename,
        );
        fd.append("reparse", String(opts.reparse ?? true));
        await self.request(`/talent/${id}/cv-upload/`, {
          method: "POST",
          formBody: fd,
          endpointKey: "/talent/{id}/cv-upload/",
        });
      },

      /**
       * `GET /talent/?page=&page_size=[&q=]` — ONE page of the company's talent
       * pool, WITH names. The `/talent/` list row is shaped like
       * {@link TalentProfile} (id + first_name/last_name/full_name + email), so
       * we read the name straight off the row — no per-row getProfile fan-out
       * (that would burn the 55/min bucket on a ~1000-talent pool).
       *
       * Returns the page rows plus `total` (the envelope `count` when present)
       * and `hasNext` (true when 8vance returns a `next` cursor) so the caller
       * can drive server-side pagination without fetching the whole pool.
       *
       * Search: when `q` is set we pass it through as `?q=` (8vance's own talent
       * search). 8vance may or may not honour `q` on `/talent/` depending on the
       * deploy; the caller should treat the rows as best-effort and (if needed)
       * additionally name-filter client-side. We do NOT page past the requested
       * page here — one page per call, by design.
       */
      async listPage(opts: {
        page?: number;
        pageSize?: number;
        q?: string | null;
      } = {}): Promise<{
        rows: Array<{ id: number; name: string; email: string | null }>;
        total: number | null;
        hasNext: boolean;
      }> {
        const page = Math.max(1, Math.floor(opts.page ?? 1));
        const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? 25)));
        const q = (opts.q ?? "").trim();
        const query: Record<string, string | number> = { page, page_size: pageSize };
        if (q) query.q = q;
        const payload = await self.request<unknown>("/talent/", {
          query,
          endpointKey: "/talent/",
        });
        const { rows: rawRows, next } = unwrapPaginated<TalentProfile>(payload);
        // Total pool size: DRF `count`, with fallbacks for other envelope
        // shapes (`total`, `total_count`). null when the endpoint returns a
        // flat array / cursor with no count.
        const countField = (k: string): number | null =>
          isRecord(payload) && typeof payload[k] === "number" ? (payload[k] as number) : null;
        const total = countField("count") ?? countField("total") ?? countField("total_count");
        const rows = rawRows
          .map((r) => {
            const rec = r as Record<string, unknown>;
            const id = typeof rec.id === "number" ? rec.id : Number(rec.id);
            if (!Number.isFinite(id)) return null;
            const full =
              (typeof rec.full_name === "string" && rec.full_name.trim()) || "";
            const first =
              (typeof rec.first_name === "string" && rec.first_name.trim()) || "";
            const last =
              (typeof rec.last_name === "string" && rec.last_name.trim()) || "";
            const name = (full || `${first} ${last}`.trim() || `#${id}`).trim();
            const email =
              typeof rec.email === "string" && rec.email.trim().length > 0
                ? rec.email.trim()
                : null;
            return { id, name, email };
          })
          .filter((r): r is { id: number; name: string; email: string | null } => r !== null);
        // hasNext: prefer the explicit DRF `next` link; else derive from the
        // total when known; else fall back to "the page came back full" (a full
        // raw page ⇒ there's very likely another). This keeps Next working even
        // when 8vance returns a flat array / cursor with no `next` + no `count`
        // (otherwise the browser would be stuck on page 1 of a 20k pool).
        const hasNext = next
          ? true
          : total != null
            ? page * pageSize < total
            : rawRows.length >= pageSize;
        return { rows, total, hasNext };
      },

      /**
       * Async generator that walks the WHOLE `/talent/` pool one page at a time,
       * yielding each page's rows (id + name + email) WITHOUT a per-talent
       * getProfile fan-out — reuses {@link listPage}, so the names come straight
       * off the list rows. Backs server-side bulk operations (e.g. "import all
       * 20k") that must never enumerate the pool in the browser.
       *
       * Pages at `pageSize` (capped 1..100, default 100 — the biggest page the
       * API allows, to minimise round-trips against the 55/min bucket). Stops on
       * the first page that has no `hasNext`, or after `maxPages` (default 1000 =
       * up to 100k talents at pageSize 100) as a runaway guard. The shared rate
       * limiter in `request` already throttles each page, so callers don't add
       * their own sleeps.
       */
      async *iterateAllPagesNames(opts: {
        pageSize?: number;
        q?: string | null;
        maxPages?: number;
      } = {}): AsyncGenerator<
        Array<{ id: number; name: string; email: string | null }>,
        void,
        void
      > {
        const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? 100)));
        const maxPages = Math.max(1, Math.floor(opts.maxPages ?? 1000));
        let page = 1;
        while (page <= maxPages) {
          const res = await self.talent.listPage({ page, pageSize, q: opts.q });
          if (res.rows.length > 0) yield res.rows;
          if (!res.hasNext || res.rows.length === 0) return;
          page += 1;
        }
      },

      /**
       * `GET /talent/{id}/sources/` — the match sources this talent has access
       * to (own pool + enabled external feeds like OnlineVacaturesNL /
       * public_vacancies_de + ecosystem). Each row is `{name: slug}`. This is
       * the only reliable way to enumerate a company's real source slugs (the
       * public API has no source catalog). Returns the slug strings.
       */
      async getSources(id: number): Promise<string[]> {
        const payload = await self.request<unknown>(`/talent/${id}/sources/`, {
          endpointKey: "/talent/{id}/sources/",
        });
        const rows = Array.isArray(payload)
          ? payload
          : isRecord(payload) && Array.isArray(payload.results)
            ? payload.results
            : [];
        const out: string[] = [];
        for (const r of rows) {
          if (typeof r === "string") out.push(r);
          else if (isRecord(r) && typeof r.name === "string") out.push(r.name);
        }
        return out;
      },

      /**
       * `GET /talent/{id}/functional-area/` → the primary function name (e.g.
       * "Accountmanager"), used as a `keywords.include` term to further shrink the
       * ES candidate set on large feeds. Null when the talent has no function.
       */
      async getPrimaryFunction(id: number): Promise<string | null> {
        const payload = await self.request<unknown>(`/talent/${id}/functional-area/`, {
          endpointKey: "/talent/{id}/functional-area/",
        });
        const rows = Array.isArray(payload)
          ? payload
          : isRecord(payload) && Array.isArray(payload.results)
            ? payload.results
            : [];
        for (const r of rows) {
          if (isRecord(r) && typeof r.function_name === "string" && r.function_name.trim()) {
            return r.function_name.trim();
          }
        }
        return null;
      },

      getSkills(id: number): Promise<TalentSkill[]> {
        return self.paginated<TalentSkill>(`/talent/${id}/skill/`, {
          endpointKey: "/talent/{id}/skill/",
        });
      },

      getEducation(id: number): Promise<TalentEducation[]> {
        return self.paginated<TalentEducation>(`/talent/${id}/education/`, {
          endpointKey: "/talent/{id}/education/",
        });
      },

      getExperience(id: number): Promise<TalentExperience[]> {
        return self.paginated<TalentExperience>(`/talent/${id}/job-experience/`, {
          endpointKey: "/talent/{id}/job-experience/",
        });
      },

      getLanguages(id: number): Promise<TalentLanguage[]> {
        return self.paginated<TalentLanguage>(`/talent/${id}/language/`, {
          endpointKey: "/talent/{id}/language/",
        });
      },

      /**
       * `/talent/{id}/location/` returns a single object (not a list) —
       * gap #9 / quirk noted in `8vance-api-prod.md` section 6.
       */
      async getLocation(id: number): Promise<TalentLocation | null> {
        const payload = await self.request<unknown>(`/talent/${id}/location/`, {
          endpointKey: "/talent/{id}/location/",
        });
        if (Array.isArray(payload)) {
          return (payload[0] as TalentLocation) ?? null;
        }
        if (isRecord(payload)) return payload as TalentLocation;
        return null;
      },
    };
  }

  /**
   * Page `/talent/` and return up to `limit` talent ids from the pool.
   * Used by the local skill-overlap fallback ranker when the native
   * matcher is unavailable.
   */
  async listTalentIds(limit: number): Promise<number[]> {
    const out: number[] = [];
    const pageSize = Math.min(50, Math.max(1, limit));
    let page = 1;
    while (out.length < limit && page <= 100) {
      const payload = await this.request<unknown>("/talent/", {
        query: { page_size: pageSize, page },
        endpointKey: "/talent/",
      });
      const rows = Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload.results)
          ? payload.results
          : [];
      if (rows.length === 0) break;
      for (const r of rows) {
        if (isRecord(r) && typeof r.id === "number") out.push(r.id);
        if (out.length >= limit) break;
      }
      const hasNext = isRecord(payload) && typeof payload.next === "string";
      if (!hasNext) break;
      page += 1;
    }
    return out;
  }
}

/** Parse a Response body as JSON, falling back to text or null. */
async function safeJson(resp: Response): Promise<unknown> {
  const ctype = resp.headers.get("content-type") ?? "";
  try {
    if (ctype.includes("application/json")) return await resp.json();
    const text = await resp.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}
