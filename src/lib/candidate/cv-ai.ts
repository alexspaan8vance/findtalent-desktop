/**
 * Pluggable LLM CV → categorized-profile extraction.
 *
 * Replaces the shallow regex-only extraction with an LLM pass that classifies
 * skills into hard / soft / knowledge buckets and pulls a FULL candidate
 * profile (name, summary, languages-with-level, education, employment history,
 * certifications, contact). The extractor is PLUGGABLE and degrades gracefully:
 *
 *   1. ANTHROPIC_API_KEY set → Claude (claude-sonnet-4-6, low effort, JSON).
 *   2. else OPENAI_API_KEY set → OpenAI (gpt-4o-mini, JSON mode).
 *   3. else → the existing deterministic regex extractor (cv-extract.ts).
 *
 * Any LLM failure (network, bad JSON, missing block) falls back to regex, so
 * `extractCvProfile` never throws. The caller resolves the returned skill
 * NAMES against the 8vance taxonomy; this module returns names, not ids.
 *
 * For scanned / image-only PDFs (where text extraction yields almost nothing)
 * use `extractCvProfileFromFile` — it sends the raw PDF/image bytes to OpenAI
 * vision (Responses API `input_file` / `input_image`) which OCRs + parses in
 * one shot, then falls back to the text path on failure.
 *
 * Node runtime only — the SDKs use Node APIs and the keys must stay server-side.
 */

import { createHash } from 'node:crypto';

import { extractSkillCandidates, extractContact } from './cv-extract';
import { createLru } from '@/lib/cache/lru';
import { reportError } from '@/lib/observability/report';

/** A spoken/written human language with an optional CEFR-ish 1–5 proficiency. */
export interface CvLanguage {
  name: string;
  /** 1 (basic) … 5 (native/fluent). Optional — omitted when unknown. */
  level?: number;
}

export interface CvEducation {
  degree?: string;
  field?: string;
  institution?: string;
  startYear?: string;
  endYear?: string;
}

export interface CvEmployment {
  title?: string;
  company?: string;
  startYear?: string;
  endYear?: string;
  current?: boolean;
  description?: string;
}

export interface CvCertification {
  name?: string;
  issuer?: string;
  year?: string;
}

/** Candidate's place of residence (NOT employer / school locations). */
export interface CvLocation {
  city?: string;
  region?: string;
  country?: string;
}

export interface CvProfile {
  fullName?: string;
  about?: string;
  hardSkills: string[];
  softSkills: string[];
  knowledge: string[];
  languages: CvLanguage[];
  education: CvEducation[];
  employment: CvEmployment[];
  certifications: CvCertification[];
  /** Candidate's home location / place of residence, when stated on the CV. */
  location?: CvLocation;
  email?: string;
  phone?: string;
  /**
   * Inferred per-skill proficiency LEVEL (1–5) keyed by the LOWERCASED skill
   * name, derived from CV signals (seniority words / years of experience).
   * CONSERVATIVE by design: a skill is present here ONLY when the CV carries a
   * real signal for it; a skill with no signal is OMITTED (→ stays UNKNOWN in
   * the wizard, rendering an empty proficiency meter rather than a fake mid 3).
   */
  skillLevels?: Record<string, number>;
  source: 'claude' | 'openai' | 'regex';
}

/**
 * The shape persisted into `candidate.profileJson` (consumed by the 8vance sync
 * stream + the read-only "CV-profiel" display panel). It is a subset of
 * `CvProfile` minus the throwaway `source` discriminator and the flat skill
 * arrays (those resolve to taxonomy ids elsewhere):
 *
 *   {
 *     about?: string,
 *     languages: { name: string; level?: number }[],
 *     education: { degree?, field?, institution?, startYear?, endYear? }[],
 *     employment: { title?, company?, startYear?, endYear?, current?, description? }[],
 *     certifications: { name?, issuer?, year? }[],
 *   }
 */
export type CandidateProfileJson = Pick<
  CvProfile,
  'about' | 'languages' | 'education' | 'employment' | 'certifications'
>;

/** Cap CV text fed to the LLM — keeps cost/latency bounded, well under context. */
const MAX_INPUT_CHARS = 12_000;

/**
 * Hard cap on ANY CV text we process. The regex fallback splits the whole
 * string, so an unbounded input (e.g. a 100 MB upload) would allocate a huge
 * fragment array before bailing. Bound it for both the LLM and regex paths.
 */
const MAX_CV_CHARS = 200_000;

/** Model ids. Override-free; documented in the task return. */
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const OPENAI_MODEL = 'gpt-4o-mini';

const SYSTEM_INSTRUCTION = [
  'You extract a FULL structured candidate profile from a CV / resume.',
  'The CV may be written in Dutch, English or German — handle all three.',
  'Return skill NAMES (short canonical phrases), never ids or sentences.',
  'Classify every skill into exactly one bucket:',
  '- hardSkills: concrete technical / tool / domain abilities (e.g. "Python", "SQL", "Lassen", "Boekhouden").',
  '- softSkills: interpersonal / behavioural traits (e.g. "Communicatie", "Leadership", "Teamwork").',
  '- knowledge: knowledge areas, methodologies, fields of study (e.g. "Scrum", "GDPR", "Machine Learning").',
  'SKILL RELEVANCE — THIS MATTERS MOST. Infer skills from what the candidate ACTUALLY DID and their SENIORITY/role, not from literal keywords in the text.',
  '- A "manager who built and ran 3 restaurants" → leadership, operations management, P&L / financial management, team / staff management, entrepreneurship, hospitality management — NOT "cooking". Someone running a business is not necessarily hands-on in the craft.',
  '- A "head of engineering" is about leadership / architecture / stakeholder management, not necessarily day-to-day coding, unless the CV shows they personally did it.',
  '- Only assign a hands-on craft/technical skill when the CV shows the person actually performed it (responsibilities, projects, achievements), not merely because the word appears or the industry implies it.',
  '- Prefer skills that fit the candidate level and role; drop generic/irrelevant tags that do not match the profile. Quality over quantity — a tight, role-appropriate list beats a long noisy one.',
  'Also extract, when present:',
  '- fullName: the candidate full name.',
  '- about: a 1–3 sentence profile summary / personal statement (verbatim or lightly condensed).',
  '- languages: spoken/written human languages, each as {name, level} where level is 1–5 (1 basic … 5 native/fluent); omit level if not stated.',
  '- education: each entry {degree, field, institution, startYear, endYear} (years as 4-digit strings; leave endYear empty if ongoing).',
  '- employment: each job {title, company, startYear, endYear, current, description}; set current=true for the present role and leave its endYear empty.',
  '- certifications: each {name, issuer, year}.',
  '- location: the candidate\'s OWN place of residence (home city/town), e.g. from an "Adres:" / "Woonplaats:" line or a Dutch postcode line like "9727 AJ Groningen". Return {city, region, country}. This is the candidate\'s home address — NEVER an employer\'s, client\'s or school\'s location. Omit if not clearly the candidate\'s residence.',
  '- email and phone if present.',
  'Use empty arrays / omit fields you cannot find. Do NOT invent data.',
  'Keep each skill list deduplicated, max ~25 entries, short phrases (1–4 words).',
  'Respond with a single JSON object and nothing else.',
].join('\n');

const JSON_SHAPE_HINT =
  'JSON shape: {' +
  '"fullName":string|null,' +
  '"about":string|null,' +
  '"hardSkills":string[],"softSkills":string[],"knowledge":string[],' +
  '"languages":[{"name":string,"level":number|null}],' +
  '"education":[{"degree":string|null,"field":string|null,"institution":string|null,"startYear":string|null,"endYear":string|null}],' +
  '"employment":[{"title":string|null,"company":string|null,"startYear":string|null,"endYear":string|null,"current":boolean|null,"description":string|null}],' +
  '"certifications":[{"name":string|null,"issuer":string|null,"year":string|null}],' +
  '"location":{"city":string|null,"region":string|null,"country":string|null}|null,' +
  '"email":string|null,"phone":string|null}';

// ---------------------------------------------------------------------------
// Per-skill proficiency inference (1..5) from CV signals.
//
// Conservative by design: we derive a single per-CANDIDATE baseline level from
// seniority words + total years of experience, then assign it to a skill ONLY
// when that skill is actually corroborated by a signal in the CV (the skill
// name appears in the text, OR the CV carries an explicit seniority signal).
// Skills with no signal are OMITTED from the returned map → they stay UNKNOWN
// downstream (empty proficiency meter) instead of being faked to a mid-tier 3.
// ---------------------------------------------------------------------------

/** Seniority phrases → a baseline level (1..5). Higher (stronger) wins. */
const SENIORITY_LEVEL: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(principal|staff|expert|architect|head of|chief|vp of|director of)\b/i, 5],
  [/\b(senior|sr\.?|lead|teamlead|team lead|manager|specialist)\b/i, 4],
  [/\b(medior|mid[- ]?level|professional|ervaren|experienced)\b/i, 3],
  [/\b(junior|jr\.?|trainee|intern|stagiair|starter|entry[- ]?level|basis|basic|beginner)\b/i, 2],
];

/** Map total years of experience → a baseline level (1..5). */
function yearsToLevel(years: number): number {
  if (!Number.isFinite(years) || years <= 0) return 0;
  if (years < 1) return 2;
  if (years < 3) return 3;
  if (years < 7) return 4;
  return 5;
}

/** Pull the largest "<n> years/jaar" experience claim from the CV text. */
function maxYearsClaim(text: string): number {
  let max = 0;
  const re = /(\d{1,2})\s*\+?\s*(?:years?|jaar|jahre|jr\.?|yrs?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max && n <= 50) max = n;
  }
  return max;
}

/**
 * Derive a candidate-wide baseline proficiency level (1..5) from CV signals,
 * or 0 when there is NO signal at all (→ leave skills unknown). Combines the
 * strongest seniority phrase with the years-of-experience signal (max of both).
 */
function baselineLevelFromCv(cvText: string): number {
  const text = cvText ?? '';
  if (!text) return 0;
  let level = 0;
  for (const [re, lvl] of SENIORITY_LEVEL) {
    if (re.test(text) && lvl > level) level = lvl;
  }
  const yrs = yearsToLevel(maxYearsClaim(text));
  if (yrs > level) level = yrs;
  return Math.max(0, Math.min(5, level));
}

/**
 * Infer a per-skill proficiency map (lowercased name → 1..5) for the given
 * skill names from the CV text. Only emits an entry when a real signal exists:
 *   - the candidate baseline (seniority/years) is non-zero  → apply it, AND
 *   - the skill name actually appears in the CV text        → corroborated.
 * A skill with no signal is omitted (stays unknown). Returns {} when there's
 * no baseline signal at all, so a signal-free CV never fakes proficiency.
 */
export function inferSkillLevels(
  cvText: string,
  skillNames: readonly string[],
): Record<string, number> {
  const baseline = baselineLevelFromCv(cvText);
  if (baseline <= 0) return {};
  const haystack = (cvText ?? '').toLowerCase();
  const out: Record<string, number> = {};
  for (const raw of skillNames) {
    const name = (raw ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (key in out) continue;
    // Corroboration: the skill must be mentioned in the CV body to inherit the
    // candidate baseline. Skills the LLM inferred but the CV never names stay
    // unknown — we don't fabricate a level for them.
    if (haystack.includes(key)) out[key] = baseline;
  }
  return out;
}

/** Build the regex fallback profile (all skills → hardSkills; rich arrays empty). */
function regexProfile(cvText: string): CvProfile {
  const contact = extractContact(cvText);
  // Best-effort name without an LLM: an explicit "Naam:/Name:" label, else the
  // first short line that looks like a person name (2–4 words, no @/digits).
  let fullName: string | undefined;
  const labelled = (cvText ?? '').match(/(?:^|\n)\s*(?:naam|name)\s*[:：]\s*([^\n]{2,60})/i);
  if (labelled) {
    fullName = labelled[1].trim();
  } else {
    for (const raw of (cvText ?? '').split(/\r?\n/).slice(0, 6)) {
      const line = raw.trim();
      if (!line || /[@\d]/.test(line)) continue;
      const words = line.split(/\s+/);
      if (words.length >= 2 && words.length <= 4 && line.length <= 60 && /^[\p{Lu}]/u.test(line)) {
        fullName = line;
        break;
      }
    }
  }
  const location = extractLocationFromText(cvText);
  const hardSkills = extractSkillCandidates(cvText, 40);
  const skillLevels = inferSkillLevels(cvText, hardSkills);
  return compact<CvProfile>({
    fullName,
    hardSkills,
    softSkills: [],
    knowledge: [],
    languages: [],
    education: [],
    employment: [],
    certifications: [],
    location,
    email: contact.email,
    phone: contact.phone,
    ...(Object.keys(skillLevels).length > 0 ? { skillLevels } : {}),
    source: 'regex',
  });
}

/**
 * Light, defensive home-location guess without an LLM. Looks for, in order:
 *   1. an explicit "Adres:" / "Woonplaats:" / "Address:" line → trailing city,
 *   2. a Dutch postcode pattern "1234 AB City" → the city after the postcode.
 * Returns { city } when found, else undefined. Never throws.
 */
function extractLocationFromText(cvText: string): CvLocation | undefined {
  const text = cvText ?? '';
  if (!text) return undefined;

  // 1. Labelled address / residence line: "Woonplaats: Groningen",
  //    "Adres: Peizerweg 45, 9727 AJ Groningen".
  const labelled = text.match(
    /(?:^|\n)\s*(?:woonplaats|adres|address|residence|city)\s*[:：]\s*([^\n]{2,120})/i,
  );
  if (labelled) {
    const value = labelled[1].trim();
    // Prefer the city after a Dutch postcode inside the labelled value.
    const pc = value.match(/\b\d{4}\s?[A-Za-z]{2}\b\s+([\p{L}][\p{L}\s'’.-]{1,48})/u);
    if (pc) {
      const city = pc[1].trim().replace(/[.,;]+$/, '');
      if (city) return { city };
    }
    // Else take the last comma-separated segment, stripped of street numbers.
    const seg = value.split(',').pop()?.trim() ?? '';
    const city = seg.replace(/\b\d{4}\s?[A-Za-z]{2}\b/, '').replace(/\d/g, '').trim();
    if (city.length >= 2 && city.length <= 50) return { city };
  }

  // 2. Bare Dutch postcode line anywhere: "9727 AJ Groningen".
  const postcode = text.match(/\b\d{4}\s?[A-Za-z]{2}\b\s+([\p{L}][\p{L}\s'’.-]{1,48})/u);
  if (postcode) {
    const city = postcode[1].trim().replace(/[.,;]+$/, '');
    if (city.length >= 2) return { city };
  }

  return undefined;
}

/** Coerce a parsed value into a clean CvLocation (or undefined). */
function toLocation(v: unknown): CvLocation | undefined {
  if (typeof v === 'string') {
    const city = toOptionalString(v, 80);
    return city ? { city } : undefined;
  }
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const loc = compact<CvLocation>({
    city: toOptionalString(o.city, 80),
    region: toOptionalString(o.region ?? o.province ?? o.state, 80),
    country: toOptionalString(o.country, 80),
  });
  return Object.keys(loc).length > 0 ? loc : undefined;
}

/** Coerce an unknown parsed value into a clean string[] (deduped, trimmed). */
function toStringArray(v: unknown, limit = 25): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (!s || s.length > 60) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

function toOptionalString(v: unknown, maxLen = 120): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s.length > 0 ? s.slice(0, maxLen) : undefined;
}

function toOptionalYear(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(Math.trunc(v));
  return toOptionalString(v, 12);
}

function toOptionalBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function toOptionalLevel(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const r = Math.round(n);
  if (r < 1 || r > 5) return undefined;
  return r;
}

/** Strip an object down to defined keys only (keeps profileJson lean). */
function compact<T extends object>(obj: T): T {
  const out = {} as T;
  for (const [k, val] of Object.entries(obj)) {
    if (val !== undefined) (out as Record<string, unknown>)[k] = val;
  }
  return out;
}

function toLanguages(v: unknown, limit = 20): CvLanguage[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: CvLanguage[] = [];
  for (const item of v) {
    let name: string | undefined;
    let level: number | undefined;
    if (typeof item === 'string') {
      name = toOptionalString(item, 40);
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      name = toOptionalString(o.name, 40);
      level = toOptionalLevel(o.level);
    }
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(compact({ name, level }));
    if (out.length >= limit) break;
  }
  return out;
}

function toEducation(v: unknown, limit = 12): CvEducation[] {
  if (!Array.isArray(v)) return [];
  const out: CvEducation[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const e = compact<CvEducation>({
      degree: toOptionalString(o.degree, 120),
      field: toOptionalString(o.field, 120),
      institution: toOptionalString(o.institution, 160),
      startYear: toOptionalYear(o.startYear),
      endYear: toOptionalYear(o.endYear),
    });
    if (Object.keys(e).length === 0) continue;
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

function toEmployment(v: unknown, limit = 20): CvEmployment[] {
  if (!Array.isArray(v)) return [];
  const out: CvEmployment[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const e = compact<CvEmployment>({
      title: toOptionalString(o.title, 160),
      company: toOptionalString(o.company, 160),
      startYear: toOptionalYear(o.startYear),
      endYear: toOptionalYear(o.endYear),
      current: toOptionalBool(o.current),
      description: toOptionalString(o.description, 600),
    });
    if (Object.keys(e).length === 0) continue;
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

function toCertifications(v: unknown, limit = 20): CvCertification[] {
  if (!Array.isArray(v)) return [];
  const out: CvCertification[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const c = compact<CvCertification>({
      name: toOptionalString(o.name, 160),
      issuer: toOptionalString(o.issuer, 160),
      year: toOptionalYear(o.year),
    });
    if (Object.keys(c).length === 0) continue;
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

/** Map a parsed LLM JSON object onto a CvProfile (validates/cleans every field). */
function profileFromParsed(parsed: unknown, source: 'claude' | 'openai'): CvProfile {
  const obj = (parsed ?? {}) as Record<string, unknown>;
  return compact<CvProfile>({
    fullName: toOptionalString(obj.fullName, 120),
    about: toOptionalString(obj.about, 800),
    hardSkills: toStringArray(obj.hardSkills),
    softSkills: toStringArray(obj.softSkills),
    knowledge: toStringArray(obj.knowledge),
    languages: toLanguages(obj.languages),
    education: toEducation(obj.education),
    employment: toEmployment(obj.employment),
    certifications: toCertifications(obj.certifications),
    location: toLocation(obj.location),
    email: toOptionalString(obj.email, 200),
    phone: toOptionalString(obj.phone, 40),
    source,
  });
}

/** Best-effort JSON parse that tolerates ```json fences / leading prose. */
function parseLooseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Pull the first {...} block out of any wrapping text/fences.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error('no_json');
  }
}

async function extractWithClaude(cvText: string): Promise<CvProfile> {
  // Dynamic import so the SDK is only loaded when the key is present.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    output_config: { effort: 'low' },
    system: SYSTEM_INSTRUCTION,
    messages: [
      {
        role: 'user',
        content: `${JSON_SHAPE_HINT}\n\nCV TEXT:\n${cvText}`,
      },
    ],
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') throw new Error('no_text_block');
  return profileFromParsed(parseLooseJson(textBlock.text), 'claude');
}

async function extractWithOpenAI(cvText: string): Promise<CvProfile> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI();
  const completion = await client.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `${SYSTEM_INSTRUCTION}\n\n${JSON_SHAPE_HINT}` },
      { role: 'user', content: `CV TEXT:\n${cvText}` },
    ],
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error('no_content');
  return profileFromParsed(parseLooseJson(content), 'openai');
}

// --- Extraction cache + in-flight coalescing -------------------------------
//
// `extractCvProfile` hits a paid LLM on every call. Re-uploading the same CV
// (or two wizard steps re-running on identical text) would pay twice. We cache
// the resolved profile in-process keyed by a hash of the (truncated) CV text +
// the active model, with a 30-minute TTL, and coalesce identical IN-FLIGHT
// calls so concurrent requests for the same CV share one LLM round-trip.
//
// Only LLM results are cached (regex is free + deterministic). The cache holds
// at most 200 profiles; the LRU evicts the oldest beyond that.

const CV_CACHE_TTL_MS = 30 * 60_000; // 30 min
const CV_CACHE_MAX = 200;
const profileCache = createLru<CvProfile>({ max: CV_CACHE_MAX, ttlMs: CV_CACHE_TTL_MS });
const inflight = new Map<string, Promise<CvProfile>>();

/** Which LLM model the cache key must be scoped to (affects the output). */
function activeModel(): string {
  if (process.env.ANTHROPIC_API_KEY) return `claude:${CLAUDE_MODEL}`;
  if (process.env.OPENAI_API_KEY) return `openai:${OPENAI_MODEL}`;
  return 'regex';
}

/** Cache key = sha256 of (model + truncated CV text). */
function cacheKey(fullText: string): string {
  return createHash('sha256').update(`${activeModel()} ${fullText}`).digest('hex');
}

/**
 * Attach a conservatively-inferred per-skill proficiency map (1..5) derived
 * from the FULL CV text + this profile's extracted skill names. Skills with no
 * CV signal are omitted (stay unknown). Idempotent: re-running over the regex
 * profile (which already set `skillLevels`) yields the same map.
 */
function withInferredLevels(profile: CvProfile, fullText: string): CvProfile {
  const names = [...profile.hardSkills, ...profile.softSkills, ...profile.knowledge];
  const skillLevels = inferSkillLevels(fullText, names);
  if (Object.keys(skillLevels).length === 0) return profile;
  return { ...profile, skillLevels };
}

/** The actual provider dispatch (Claude → OpenAI → regex). Never throws. */
async function runExtraction(input: string, fullText: string): Promise<CvProfile> {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return withInferredLevels(await extractWithClaude(input), fullText);
    } catch (err) {
      // Log before silently degrading to the regex fallback so the Claude
      // failure (network / bad JSON / missing block) is observable instead of
      // invisibly downgrading extraction quality. Fallback behaviour unchanged.
      reportError(err, { area: 'cv-ai.extract-fallback', provider: 'claude' });
      return regexProfile(fullText);
    }
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      return withInferredLevels(await extractWithOpenAI(input), fullText);
    } catch {
      return regexProfile(fullText);
    }
  }
  return regexProfile(fullText);
}

/**
 * Extract a categorized candidate profile from CV text. Never throws: any
 * LLM failure falls back to the deterministic regex extractor.
 *
 * Cached (30-min TTL, keyed by model + CV-text hash) with in-flight coalescing
 * so repeat / concurrent extractions of the same CV don't re-pay the LLM.
 */
export async function extractCvProfile(cvText: string): Promise<CvProfile> {
  if (!cvText || typeof cvText !== 'string' || cvText.trim().length < 10) {
    return regexProfile(cvText ?? '');
  }
  // Hard-cap the text we ever process so an oversized upload can't blow up the
  // regex fallback's split() — applies to BOTH the LLM input and the fallback.
  const safeText = cvText.length > MAX_CV_CHARS ? cvText.slice(0, MAX_CV_CHARS) : cvText;
  const input = safeText.slice(0, MAX_INPUT_CHARS);

  // No paid provider → cheap deterministic path, no need to cache.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return regexProfile(safeText);
  }

  // Key on the full (capped) text, not the truncated LLM input, to avoid
  // cross-candidate cache collisions.
  const key = cacheKey(safeText);
  const cached = profileCache.get(key);
  if (cached) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = runExtraction(input, safeText)
    .then((profile) => {
      // Only cache real LLM results; the regex fallback is free to recompute and
      // we don't want a transient LLM outage to pin a degraded result for 30 min.
      if (profile.source !== 'regex') profileCache.set(key, profile);
      return profile;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

/** Test/teardown helper — drop the in-process extraction cache. */
export function _resetCvProfileCache(): void {
  profileCache.clear();
  inflight.clear();
}

/** Whether a mime/base64 pair is an image OpenAI vision can read directly. */
function isImageMime(mime: string): boolean {
  return /^image\/(png|jpe?g|webp|gif)$/i.test(mime);
}

/**
 * OCR + extraction path for scanned / image-only documents. Sends the raw
 * file bytes (base64) to OpenAI vision via the Responses API and parses the
 * same JSON schema. PDFs go in as `input_file` (data URL in `file_data`,
 * which gpt-4o-mini reads incl. scanned pages); images go in as `input_image`
 * (base64 data URL in `image_url`).
 *
 * Never throws: on any failure (no key, bad bytes, bad JSON) it falls back to
 * `extractCvProfile(filenameText ?? '')` — which itself falls back to regex.
 */
export async function extractCvProfileFromFile(
  base64: string,
  mime: string,
  filenameText?: string,
): Promise<CvProfile> {
  if (!process.env.OPENAI_API_KEY || !base64) {
    return extractCvProfile(filenameText ?? '');
  }

  const effectiveMime = mime || 'application/pdf';
  const dataUrl = `data:${effectiveMime};base64,${base64}`;

  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI();

    const fileContent = isImageMime(effectiveMime)
      ? ({ type: 'input_image', image_url: dataUrl, detail: 'high' } as const)
      : ({
          type: 'input_file',
          filename: 'cv.pdf',
          file_data: dataUrl,
        } as const);

    const response = await client.responses.create({
      model: OPENAI_MODEL,
      temperature: 0,
      text: { format: { type: 'json_object' } },
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: `${SYSTEM_INSTRUCTION}\n\n${JSON_SHAPE_HINT}` }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Read this CV document (it may be a scanned image) and return the JSON profile.',
            },
            fileContent,
          ],
        },
      ],
    });

    const out = response.output_text;
    if (!out) throw new Error('no_output');
    return profileFromParsed(parseLooseJson(out), 'openai');
  } catch {
    return extractCvProfile(filenameText ?? '');
  }
}

/** Convenience: just the language names (back-compat for callers wanting string[]). */
export function languageNames(languages: CvLanguage[]): string[] {
  return languages.map((l) => l.name);
}
