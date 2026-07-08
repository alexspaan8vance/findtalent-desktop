/**
 * Main anonymization entry point.
 *
 * Builds a strict `AnonymizedTalent` from a raw 8vance talent + sub-resources.
 * The output is validated through `assertNoPII` before return so a coding
 * mistake (e.g. accidentally forwarding a raw field) crashes loudly instead
 * of silently leaking PII to the client.
 */

import { createHash } from 'node:crypto';

import {
  canonicalCountry,
  cityToProvinceNL,
  isKnownProvinceNL,
  durationBucket,
  experienceYearsBucket,
  hoursBucket,
  languageLevelLabel,
  proficiencyLabel,
  sectorFromCompanyName,
  startWithinDaysBucket,
} from './buckets';
import { assertNoPII } from './blocklist';
// Re-export so callers can treat talent.ts as the single anonymization entry
// point (the produced payload + its guard live together by contract).
export { assertNoPII } from './blocklist';
import { ROLE_WORDS, scrubFreeText } from './scrub';
import type {
  AnonEducation,
  AnonExperience,
  AnonLanguage,
  AnonSkill,
  AnonymizedTalent,
  RawTalent,
  RawTalentEducation,
  RawTalentExperience,
  RawTalentLanguage,
  RawTalentSkill,
} from './types';

export interface AnonymizeJobSkill {
  id: number;
  name?: string;
  must_have: boolean;
}

export interface AnonymizeOptions {
  tenantId: string;
  hashSecret: string;
  jobSkills?: ReadonlyArray<AnonymizeJobSkill>;
  /**
   * Label substituted for a skill whose taxonomy NAME couldn't be resolved
   * (talent-skill row missing `skill_name`, or a job gap-skill with no name).
   * Hydrate reverse-resolves most ids before anonymize runs; this is the LAST
   * resort so a raw `skill_<id>` never leaks into the anonymized payload.
   * Defaults to the nl primary-locale label; callers may pass a localized one.
   */
  skillUnknownLabel?: string;
}

/** Default generic skill label (nl primary locale) when no name resolves. */
const DEFAULT_SKILL_UNKNOWN = 'Vaardigheid';

export function anonymize(
  raw: RawTalent,
  opts: AnonymizeOptions,
): AnonymizedTalent {
  const opaque_id = buildOpaqueId(opts.tenantId, raw.id, opts.hashSecret);

  const skillUnknown = opts.skillUnknownLabel?.trim() || DEFAULT_SKILL_UNKNOWN;
  const skills = buildSkills(raw.skills, opts.jobSkills ?? [], skillUnknown);
  const experience = buildExperience(raw.experience);
  const education = buildEducation(raw.education);
  const languages = buildLanguages(raw.languages);

  const loc = raw.location ?? {};
  // Prefer 8vance's own region (province) when present; otherwise derive from
  // the NL city table. Coarsen to province + country only (never city).
  const derived = cityToProvinceNL(loc.city ?? '', loc.country ?? '');
  // Only trust a 8vance-supplied region when it's an actual province — a raw
  // region can be a municipality/town (re-identification risk). Otherwise fall
  // back to the city→province table, which only ever yields a province.
  const rawProvince = (loc.province ?? '').trim();
  const location = {
    province: isKnownProvinceNL(rawProvince) ? rawProvince : derived.province,
    country: canonicalCountry((loc.country ?? '').trim()) || derived.country,
  };

  const start = raw.start_date ? new Date(raw.start_date) : null;

  const out: AnonymizedTalent = {
    opaque_id,
    score: typeof raw.score === 'number' ? raw.score : null,
    function_level: typeof raw.function_level === 'number' ? raw.function_level : null,
    total_years_experience_bucket:
      typeof raw.total_years_experience === 'number'
        ? experienceYearsBucket(raw.total_years_experience)
        : null,
    hours_per_week_bucket:
      typeof raw.hours_per_week === 'number' ? hoursBucket(raw.hours_per_week) : null,
    start_within_days: startWithinDaysBucket(start),
    location,
    skills,
    // Flag "unavailable" when the skill fetch FAILED *and* it left the talent
    // with no OWN skills — i.e. every entry is a job-derived `gap` (missing
    // must-have), never a real skill the talent has. A partial success (any
    // non-gap skill) is still worth showing, so it stays trusted.
    ...(raw.skillsUnavailable && skills.every((s) => s.gap)
      ? { skills_unavailable: true }
      : {}),
    experience,
    education,
    languages,
  };

  // Defense-in-depth: blow up loudly if any blocked key sneaks through.
  assertNoPII(out);
  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

export function buildOpaqueId(
  tenantId: string,
  talentId: number,
  secret: string,
): string {
  const h = createHash('sha256');
  h.update(`${tenantId}|${talentId}|${secret}`);
  return `anon_${h.digest('hex').slice(0, 16)}`;
}

function normSkill(s: string): string {
  return s.toLowerCase().trim();
}

/** A skill name that is really just the raw 8vance taxonomy id, e.g.
 * "skill_957701" — these arrive from unresolved `top_skills` or `skill_name`
 * and must NEVER reach the UI. */
const RAW_SKILL_ID = /^skill_\d+$/i;

/** Return a usable display name, or undefined when the name is missing/blank or
 * is just a raw `skill_<id>` (so the caller falls back to the generic label). */
function cleanSkillName(name: string | undefined): string | undefined {
  const t = (name ?? '').trim();
  return t.length > 0 && !RAW_SKILL_ID.test(t) ? t : undefined;
}

/**
 * READ-TIME sanitizer for an already-stored skill name.
 *
 * `anonymize()` (write time) already strips raw `skill_<id>` names, but
 * payloads persisted BEFORE that fix (or by a preserve-on-fail re-match) can
 * still carry a raw `skill_<id>`. Any code that reads a stored
 * `Match.anonymizedPayloadJson` (shortlist cards, CSV/print export) MUST funnel
 * skill names through this so a stale raw id never reaches the UI, regardless of
 * how old the row is. Returns the generic `label` (defaults to the nl primary
 * label; callers pass the localized `shortlist.skillUnknown`) for a blank /
 * raw-id name; otherwise the trimmed name unchanged.
 */
export function displaySkillName(
  name: string | null | undefined,
  label: string = DEFAULT_SKILL_UNKNOWN,
): string {
  return cleanSkillName(name ?? undefined) ?? (label.trim() || DEFAULT_SKILL_UNKNOWN);
}

/**
 * The generic "couldn't resolve this skill" labels across UI locales
 * (`shortlist.skillUnknown` in nl/en/de) plus whatever localized label the
 * caller is using right now. Payloads persist the label of the locale ACTIVE
 * at match time, so a nl-stored payload can surface in an en UI and vice
 * versa — hence the cross-locale set rather than only the current label.
 */
const GENERIC_SKILL_LABELS: ReadonlySet<string> = new Set([
  'vaardigheid',
  'skill',
  'fähigkeit',
]);

/**
 * True when a stored skill name carries NO information for the user: blank, a
 * raw `skill_<id>`, or one of the generic unknown-skill labels. Card render
 * paths use this to HIDE such a chip entirely (a literal "Vaardigheid" chip
 * tells the recruiter nothing), while completeness-oriented paths (CSV export)
 * keep substituting the generic label instead.
 */
export function isGenericSkillName(
  name: string | null | undefined,
  localizedLabel?: string,
): boolean {
  const t = (name ?? '').trim();
  if (!t || RAW_SKILL_ID.test(t)) return true;
  const lower = t.toLowerCase();
  if (GENERIC_SKILL_LABELS.has(lower)) return true;
  return localizedLabel != null && lower === localizedLabel.trim().toLowerCase();
}

/** Fuzzy name match (substring either way) — 8vance has many duplicate ids
 * per concept, so id-equality is useless; names are stable. */
function skillNameMatches(a: string, b: string): boolean {
  const x = normSkill(a);
  const y = normSkill(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function buildSkills(
  rawSkills: ReadonlyArray<RawTalentSkill>,
  jobSkills: ReadonlyArray<{ id: number; name?: string; must_have: boolean }>,
  skillUnknown: string,
): AnonSkill[] {
  const talentNames = rawSkills
    .map((s) => s.name ?? '')
    .filter((n) => n.trim().length > 0);

  const out: AnonSkill[] = [];
  const seen = new Set<string>();

  // Talent-known skills first, flagged when they satisfy a job skill.
  // Dedupe by normalized name — 8vance can list the same skill twice, which
  // would otherwise collide as React keys downstream.
  for (const s of rawSkills) {
    // A nameless skill (id not resolvable upstream) becomes the generic label,
    // NEVER the raw `skill_<id>` (which would leak the taxonomy id to the UI).
    // cleanSkillName also collapses a name that is itself a raw `skill_<id>`
    // (unresolved top_skills / skill_name) to the label.
    const sName = cleanSkillName(s.name) ?? skillUnknown;
    const key = normSkill(sName);
    if (seen.has(key)) continue;
    seen.add(key);
    const matchedJob = jobSkills.find((js) => js.name && skillNameMatches(sName, js.name));
    out.push({
      // Scrub embedded names / contact handles before exposing pre-reveal
      // (skills are free-text; "Referral from Anne Bakker" must not leak).
      name: scrubFreeText(sName) || skillUnknown,
      // Pass the actual nullable so a missing proficiency renders EMPTY (no
      // rating) rather than collapsing to a fake mid-tier ⭐⭐⭐ (id 0 → mid).
      proficiency_label: proficiencyLabel(s.proficiency_id),
      must_have_match: matchedJob?.must_have === true,
      gap: false,
    });
  }

  // Then gap-skills: job skills no talent skill matches (by name).
  for (const js of jobSkills) {
    // Same rule as talent skills: a nameless (or raw-id) job skill uses the
    // generic label, never the raw `skill_<id>`.
    const label = cleanSkillName(js.name) ?? skillUnknown;
    const covered = talentNames.some((tn) => skillNameMatches(tn, label));
    if (covered) continue;
    const gKey = normSkill(label);
    if (seen.has(gKey)) continue;
    seen.add(gKey);
    out.push({
      name: scrubFreeText(label) || skillUnknown,
      proficiency_label: '⭐',
      must_have_match: false,
      gap: true,
    });
  }

  return out;
}

function buildExperience(rows: ReadonlyArray<RawTalentExperience>): AnonExperience[] {
  // Sort: currently-active first, then by end_date desc, then by start_date desc.
  const sorted = [...rows].sort((a, b) => {
    const aCur = a.is_current === true ? 1 : 0;
    const bCur = b.is_current === true ? 1 : 0;
    if (aCur !== bCur) return bCur - aCur;
    const aEnd = a.end_date ? Date.parse(a.end_date) : Number.NEGATIVE_INFINITY;
    const bEnd = b.end_date ? Date.parse(b.end_date) : Number.NEGATIVE_INFINITY;
    if (aEnd !== bEnd) return bEnd - aEnd;
    const aStart = a.start_date ? Date.parse(a.start_date) : Number.NEGATIVE_INFINITY;
    const bStart = b.start_date ? Date.parse(b.start_date) : Number.NEGATIVE_INFINITY;
    return bStart - aStart;
  });

  return sorted.slice(0, 3).map((e) => ({
    // Free-text the talent typed — scrub embedded names / contact handles /
    // ids before exposing pre-reveal. Falls back to 'Unknown' (same as the
    // empty-string handling already used here) if nothing safe survives.
    function_title: safeFunctionTitle(e.function_title),
    sector: sectorFromCompanyName(e.company_name ?? undefined),
    duration_bucket: durationBucket(monthsBetween(e.start_date, e.end_date)),
    is_current: e.is_current === true,
  }));
}

/**
 * Scrub a free-text function title, then defend against the lone-token name
 * leak: a single Capitalized word that is NOT a known role word (e.g.
 * "Verstappen", "Beatrix") survives the multi-word scrubber but is almost
 * certainly a surname / given name. Gate strictly so legit single-word generic
 * roles are preserved:
 *   (single token) AND (proper-name shape: initial-cap + lowercase tail)
 *   AND (not a ROLE_WORD) → 'Unknown'.
 * The lowercase-tail requirement keeps real all-caps acronym roles ("PA",
 * "IT", "QA", "CEO") intact — those are not name-shaped.
 */
function safeFunctionTitle(input: string | null | undefined): string {
  const scrubbed = scrubFreeText(input);
  if (!scrubbed) return 'Unknown';
  const tokens = scrubbed.split(/\s+/).filter(Boolean);
  if (
    tokens.length === 1 &&
    /^[A-ZÀ-Þ][a-zà-ÿ'-]+$/.test(tokens[0]) &&
    !ROLE_WORDS.has(tokens[0].toLowerCase())
  ) {
    return 'Unknown';
  }
  return scrubbed;
}

function monthsBetween(start: string | null | undefined, end: string | null | undefined): number {
  if (!start) return 0;
  const s = Date.parse(start);
  if (Number.isNaN(s)) return 0;
  const eMs = end ? Date.parse(end) : Date.now();
  const e = Number.isNaN(eMs) ? Date.now() : eMs;
  if (e <= s) return 0;
  return Math.floor((e - s) / (1000 * 60 * 60 * 24 * 30.4375));
}

function buildEducation(rows: ReadonlyArray<RawTalentEducation>): AnonEducation[] {
  // Defensive: degree level + field of study are normally controlled refdata,
  // but scrub them too in case a free-text value carries an embedded name or
  // contact detail (same guarantee as experience.function_title).
  return rows.map((e) => ({
    level: scrubFreeText(e.level ?? ''),
    field_of_study_category: scrubFreeText(e.field_of_study_category ?? ''),
  }));
}

function buildLanguages(rows: ReadonlyArray<RawTalentLanguage>): AnonLanguage[] {
  return rows.map((l) => ({
    language: l.language,
    speak_level: languageLevelLabel(l.level),
  }));
}
