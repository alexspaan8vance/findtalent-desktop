/**
 * Pure "richer-wins" CV diff-engine.
 *
 * Turns the 8vance server-side CV parse (`EightvanceParsedCv`) into a list of
 * human-approvable SUGGESTIONS over our LOCAL parse (`CvProfile`). The 8vance
 * parse is the authoritative parse on the real file, so where it carries MORE
 * information than our local one, it proposes to add/replace/fill — but nothing
 * is ever applied automatically: each suggestion starts `pending` and a human
 * approves or dismisses it later (apply-time taxonomy-id resolution + write
 * happen in a later phase, NOT here).
 *
 * No I/O, no side effects, deterministic — safe to unit-test in isolation. The
 * caller passes the CURRENT local profile (`profileJson.cv`) as `local`; an
 * optional `recruiterLockedFields` set lets the caller exclude scalar fields a
 * recruiter manually set (about/email/phone) so the engine never proposes
 * overwriting a hand-edited value.
 */

import type { CvEducation, CvEmployment } from './cv-ai';
import type { EightvanceEducation, EightvanceEmployment } from './cv-parser-8vance';

export type SuggestionKind =
  | 'skill'
  | 'education'
  | 'employment'
  | 'about'
  | 'email'
  | 'phone'
  | 'language';
export type SuggestionAction = 'add' | 'replace' | 'fill';
export type SuggestionStatus = 'pending' | 'approved' | 'dismissed';

export interface CvSuggestion {
  /** Stable, dedup-safe id: `${kind}:${key}`. */
  id: string;
  kind: SuggestionKind;
  action: SuggestionAction;
  /** Short human label for the row (e.g. "Add skill: Python"). */
  label: string;
  /** Current local value / the entry being replaced (null for add + fill). */
  original: unknown | null;
  /** The 8vance value to apply. */
  proposed: unknown;
  /** Why 8vance wins (e.g. "8vance adds +institution +startYear"). */
  reason: string;
  /** Starts 'pending'; the human flips it to approved/dismissed. */
  status: SuggestionStatus;
  source: '8vance';
  /** 0..1 sort/priority hint (skill-add high, replace lower). */
  confidence: number;
}

/**
 * Structural view of our LOCAL parse the engine reads. A narrow subset of
 * `CvProfile` (arrays optional so callers/tests can pass a partial profile).
 */
export interface CvProfileLike {
  about?: string;
  hardSkills?: string[];
  softSkills?: string[];
  knowledge?: string[];
  languages?: Array<{ name: string; level?: number }>;
  education?: CvEducation[];
  employment?: CvEmployment[];
  email?: string;
  phone?: string;
}

/** Structural view of the 8vance parse the engine reads (subset of `EightvanceParsedCv`). */
export interface EightvanceParseLike {
  about?: string;
  email?: string;
  phone?: string;
  skills?: string[];
  languages?: string[];
  education?: EightvanceEducation[];
  employment?: EightvanceEmployment[];
}

// --- small helpers ---------------------------------------------------------

const norm = (s?: string | null): string => (s ?? '').trim().toLowerCase();

/**
 * Canonical language key across locales. Our LOCAL parse stores a CV-native
 * language name ("Nederlands"), while the 8vance readback returns the English
 * name ("Dutch") — a plain string diff then falsely re-proposes an
 * already-present language (reported repeatedly for Dutch, which ~every NL CV
 * has). Map the common NL/EN/DE/FR/ES variants to one key so the dedup matches.
 * Unknown languages fall through to their normalized name (no false merges).
 */
const LANG_ALIASES: Record<string, string> = {
  nederlands: 'nl', dutch: 'nl', niederländisch: 'nl', niederlaendisch: 'nl', néerlandais: 'nl', neerlandais: 'nl', holandés: 'nl', nl: 'nl',
  engels: 'en', english: 'en', englisch: 'en', anglais: 'en', inglés: 'en', ingles: 'en', en: 'en',
  duits: 'de', german: 'de', deutsch: 'de', allemand: 'de', alemán: 'de', aleman: 'de', de: 'de',
  frans: 'fr', french: 'fr', französisch: 'fr', franzoesisch: 'fr', français: 'fr', francais: 'fr', francés: 'fr', fr: 'fr',
  spaans: 'es', spanish: 'es', spanisch: 'es', espagnol: 'es', español: 'es', espanol: 'es', es: 'es',
};
const canonLang = (s?: string | null): string => {
  const n = norm(s);
  return LANG_ALIASES[n] ?? n;
};
const nonEmpty = (s?: string | null): boolean => norm(s).length > 0;
const eq = (a?: string | null, b?: string | null): boolean =>
  nonEmpty(a) && nonEmpty(b) && norm(a) === norm(b);

/** Pull the first 4-digit year out of a loose year/date string. */
function parseYear(v?: string | null): number | null {
  const m = (v ?? '').match(/\b(\d{4})\b/);
  if (!m) return null;
  const y = Number(m[1]);
  return Number.isFinite(y) ? y : null;
}

/**
 * Tolerant year-range overlap. Missing years never disqualify a match (we can't
 * prove non-overlap without both starts), and a ±1 year slack absorbs the
 * common "started 2010" vs "2011" parse drift between the two extractors.
 */
function yearsOverlap(
  aStart?: string | null,
  aEnd?: string | null,
  bStart?: string | null,
  bEnd?: string | null,
): boolean {
  const as = parseYear(aStart);
  const bs = parseYear(bStart);
  if (as === null || bs === null) return true; // tolerant: unknown → don't block
  const aLo = as;
  const aHi = parseYear(aEnd) ?? as;
  const bLo = bs;
  const bHi = parseYear(bEnd) ?? bs;
  const TOL = 1;
  return aLo - TOL <= bHi && bLo - TOL <= aHi;
}

/** Count non-empty string fields among the given keys of an entry. */
function countFields(entry: Record<string, unknown>, keys: readonly string[]): number {
  let n = 0;
  for (const k of keys) {
    if (nonEmpty(entry[k] as string | undefined)) n += 1;
  }
  return n;
}

/** Fields present (non-empty) in `richer` but missing (empty) in `poorer`, as "+field" tokens. */
function addedFields(
  poorer: Record<string, unknown>,
  richer: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  const out: string[] = [];
  for (const k of keys) {
    if (!nonEmpty(poorer[k] as string | undefined) && nonEmpty(richer[k] as string | undefined)) {
      out.push(`+${k}`);
    }
  }
  return out;
}

const EDU_FIELDS = ['degree', 'field', 'institution', 'startYear', 'endYear'] as const;
// `current` is local-only + boolean, so it's excluded from the string-field
// richness comparison against the 8vance entry.
const EMP_FIELDS = ['title', 'company', 'startYear', 'endYear', 'description'] as const;

function describeEdu(e: EightvanceEducation | CvEducation): string {
  const head = [e.degree, e.field].filter(nonEmpty).join(' ').trim();
  const inst = nonEmpty(e.institution) ? ` @ ${e.institution!.trim()}` : '';
  const years =
    nonEmpty(e.startYear) || nonEmpty(e.endYear)
      ? ` (${(e.startYear ?? '').trim()}–${(e.endYear ?? '').trim()})`
      : '';
  return `${head || 'Opleiding'}${inst}${years}`;
}

function describeEmp(e: EightvanceEmployment | CvEmployment): string {
  const head = e.title?.trim() || 'Functie';
  const co = nonEmpty(e.company) ? ` @ ${e.company!.trim()}` : '';
  const years =
    nonEmpty(e.startYear) || nonEmpty(e.endYear)
      ? ` (${(e.startYear ?? '').trim()}–${(e.endYear ?? '').trim()})`
      : '';
  return `${head}${co}${years}`;
}

/** Slug a free-text label into a stable, dedup-safe id key segment. */
function keySlug(...parts: Array<string | undefined | null>): string {
  return (
    parts
      .map((p) => norm(p))
      .filter((p) => p.length > 0)
      .join('|')
      .replace(/\s+/g, '-') || 'x'
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Placeholder / junk local email values we treat as "empty enough to fill". */
function isPlaceholderEmail(v?: string): boolean {
  const s = norm(v);
  if (!s) return true;
  return /^(n\/?a|none|unknown|example|noreply|no-reply|test)@|@example\./.test(s);
}
function isValidEmail(v?: string): boolean {
  const s = (v ?? '').trim();
  return EMAIL_RE.test(s) && !isPlaceholderEmail(s);
}
function phoneDigits(v?: string): number {
  return (v ?? '').replace(/\D/g, '').length;
}
const isValidPhone = (v?: string): boolean => phoneDigits(v) >= 7;

/** Deterministic priority: replaces/fills (higher-impact) before adds. */
const ACTION_RANK: Record<SuggestionAction, number> = { replace: 0, fill: 1, add: 2 };

/**
 * Which kinds matter most for a matchable profile. Skills / work experience /
 * education are the signal a recruiter actually approves (and what 8vance's
 * parser reliably returns); language and bare contact fields are low-value, so
 * they sort to the bottom of the list. Lower number = higher up.
 */
const KIND_RANK: Record<SuggestionKind, number> = {
  skill: 0,
  employment: 0,
  education: 0,
  about: 1,
  email: 2,
  phone: 2,
  language: 3,
};

/** Lifecycle of the 8vance CV-reparse suggestion pass. */
export type SuggestionsStatus = 'pending' | 'ready' | 'none' | 'error';

/**
 * Decide the pass status from the diff size and whether 8vance's parse returned
 * ANY sub-resource content. `ready` = there are suggestions; `none` = the parse
 * landed but the profile is already complete (definitive end-state); `pending` =
 * the async reparse hasn't surfaced anything yet, so keep polling.
 */
export function decideSuggestionsStatus(
  diffCount: number,
  evItemCount: number,
): SuggestionsStatus {
  if (diffCount > 0) return 'ready';
  return evItemCount > 0 ? 'none' : 'pending';
}

/**
 * Build the "richer-wins" suggestion list. Deterministic + pure: same inputs →
 * same output (stable order). `recruiterLockedFields` (default none) excludes
 * scalar fields the recruiter set by hand (about/email/phone) so the engine
 * never proposes overwriting a manual edit.
 */
export function buildSuggestions(
  local: CvProfileLike,
  ev: EightvanceParseLike,
  recruiterLockedFields: Set<string> = new Set(),
): CvSuggestion[] {
  const locked = recruiterLockedFields;
  const out: CvSuggestion[] = [];

  // --- Skills: union (add 8vance skills not already present locally) --------
  const localSkillSet = new Set(
    [
      ...(local.hardSkills ?? []),
      ...(local.softSkills ?? []),
      ...(local.knowledge ?? []),
    ].map(norm),
  );
  const seenSkill = new Set<string>();
  for (const raw of ev.skills ?? []) {
    const name = (raw ?? '').trim();
    const key = norm(name);
    if (!key || seenSkill.has(key)) continue;
    seenSkill.add(key);
    if (localSkillSet.has(key)) continue;
    out.push({
      id: `skill:${key}`,
      kind: 'skill',
      action: 'add',
      label: `Add skill: ${name}`,
      original: null,
      proposed: name,
      reason: 'Skill found by the 8vance parse but missing from your local profile',
      status: 'pending',
      source: '8vance',
      confidence: 0.9,
    });
  }

  // --- Languages: add 8vance languages not present locally -------------------
  const localLangSet = new Set((local.languages ?? []).map((l) => canonLang(l?.name)));
  const seenLang = new Set<string>();
  for (const raw of ev.languages ?? []) {
    const name = (raw ?? '').trim();
    const key = canonLang(name);
    if (!key || seenLang.has(key)) continue;
    seenLang.add(key);
    if (localLangSet.has(key)) continue;
    out.push({
      id: `language:${key}`,
      kind: 'language',
      action: 'add',
      label: `Add language: ${name}`,
      original: null,
      proposed: { name },
      reason: 'Language found by the 8vance parse but missing from your local profile',
      status: 'pending',
      source: '8vance',
      confidence: 0.85,
    });
  }

  // --- Education: fuzzy-match, then replace-if-richer / add-if-new -----------
  const localEdu = local.education ?? [];
  for (const evE of ev.education ?? []) {
    const evRec = evE as unknown as Record<string, unknown>;
    if (countFields(evRec, EDU_FIELDS) === 0) continue;
    const key = `education:${keySlug(evE.institution, evE.degree, evE.field, evE.startYear)}`;
    const match = localEdu.find(
      (l) =>
        eq(l.institution, evE.institution) ||
        (eq(l.degree, evE.degree) &&
          yearsOverlap(l.startYear, l.endYear, evE.startYear, evE.endYear)),
    );
    if (match) {
      const localRec = match as unknown as Record<string, unknown>;
      if (countFields(evRec, EDU_FIELDS) > countFields(localRec, EDU_FIELDS)) {
        const added = addedFields(localRec, evRec, EDU_FIELDS);
        out.push({
          id: key,
          kind: 'education',
          action: 'replace',
          label: `Richer: ${describeEdu(evE)}`,
          original: match,
          proposed: evE,
          reason: `8vance adds ${added.join(' ')}`,
          status: 'pending',
          source: '8vance',
          confidence: 0.6,
        });
      }
      // else local is equal-or-richer → no suggestion.
    } else {
      out.push({
        id: key,
        kind: 'education',
        action: 'add',
        label: `Add education: ${describeEdu(evE)}`,
        original: null,
        proposed: evE,
        reason: 'Education entry found by the 8vance parse but missing locally',
        status: 'pending',
        source: '8vance',
        confidence: 0.7,
      });
    }
  }

  // --- Employment: fuzzy-match, then replace-if-richer / add-if-new ----------
  const localEmp = local.employment ?? [];
  for (const evE of ev.employment ?? []) {
    const evRec = evE as unknown as Record<string, unknown>;
    if (countFields(evRec, EMP_FIELDS) === 0) continue;
    const key = `employment:${keySlug(evE.company, evE.title, evE.startYear)}`;
    const match = localEmp.find(
      (l) => eq(l.company, evE.company) && yearsOverlap(l.startYear, l.endYear, evE.startYear, evE.endYear),
    );
    if (match) {
      const localRec = match as unknown as Record<string, unknown>;
      if (countFields(evRec, EMP_FIELDS) > countFields(localRec, EMP_FIELDS)) {
        const added = addedFields(localRec, evRec, EMP_FIELDS);
        out.push({
          id: key,
          kind: 'employment',
          action: 'replace',
          label: `Richer: ${describeEmp(evE)}`,
          original: match,
          proposed: evE,
          reason: `8vance adds ${added.join(' ')}`,
          status: 'pending',
          source: '8vance',
          confidence: 0.6,
        });
      }
      // else local is equal-or-richer → no suggestion.
    } else {
      out.push({
        id: key,
        kind: 'employment',
        action: 'add',
        label: `Add experience: ${describeEmp(evE)}`,
        original: null,
        proposed: evE,
        reason: 'Employment entry found by the 8vance parse but missing locally',
        status: 'pending',
        source: '8vance',
        confidence: 0.7,
      });
    }
  }

  // --- about: fill (local empty) or replace (8vance meaningfully richer) -----
  if (!locked.has('about') && nonEmpty(ev.about)) {
    const evAbout = ev.about!.trim();
    if (!nonEmpty(local.about)) {
      out.push({
        id: 'about:main',
        kind: 'about',
        action: 'fill',
        label: 'Fill in profile summary from 8vance',
        original: null,
        proposed: evAbout,
        reason: 'Your local profile has no summary; the 8vance parse extracted one',
        status: 'pending',
        source: '8vance',
        confidence: 0.8,
      });
    } else {
      const localAbout = local.about!.trim();
      // "meaningfully longer/more-complete": clearly longer both proportionally
      // and absolutely, so a couple of extra words never triggers a replace.
      const meaningfullyLonger =
        evAbout.length >= localAbout.length * 1.2 && evAbout.length - localAbout.length >= 30;
      if (meaningfullyLonger && norm(evAbout) !== norm(localAbout)) {
        out.push({
          id: 'about:main',
          kind: 'about',
          action: 'replace',
          label: 'Replace profile summary with the richer 8vance version',
          original: localAbout,
          proposed: evAbout,
          reason: '8vance summary is longer / more complete than your local one',
          status: 'pending',
          source: '8vance',
          confidence: 0.6,
        });
      }
    }
  }

  // --- email: fill (local empty/placeholder) or replace (local invalid) ------
  if (!locked.has('email') && isValidEmail(ev.email)) {
    const evEmail = ev.email!.trim();
    if (!nonEmpty(local.email) || isPlaceholderEmail(local.email)) {
      out.push({
        id: 'email:main',
        kind: 'email',
        action: 'fill',
        label: `Fill in email: ${evEmail}`,
        original: null,
        proposed: evEmail,
        reason: 'Your local profile has no valid email; the 8vance parse found one',
        status: 'pending',
        source: '8vance',
        confidence: 0.85,
      });
    } else if (!isValidEmail(local.email) && norm(evEmail) !== norm(local.email)) {
      out.push({
        id: 'email:main',
        kind: 'email',
        action: 'replace',
        label: `Replace invalid email with: ${evEmail}`,
        original: local.email!.trim(),
        proposed: evEmail,
        reason: 'Your local email looks invalid; the 8vance one passes a validity check',
        status: 'pending',
        source: '8vance',
        confidence: 0.7,
      });
    }
  }

  // --- phone: fill (local empty) or replace (local invalid) ------------------
  if (!locked.has('phone') && isValidPhone(ev.phone)) {
    const evPhone = ev.phone!.trim();
    if (!nonEmpty(local.phone)) {
      out.push({
        id: 'phone:main',
        kind: 'phone',
        action: 'fill',
        label: `Fill in phone: ${evPhone}`,
        original: null,
        proposed: evPhone,
        reason: 'Your local profile has no phone; the 8vance parse found one',
        status: 'pending',
        source: '8vance',
        confidence: 0.85,
      });
    } else if (!isValidPhone(local.phone) && norm(evPhone) !== norm(local.phone)) {
      out.push({
        id: 'phone:main',
        kind: 'phone',
        action: 'replace',
        label: `Replace invalid phone with: ${evPhone}`,
        original: local.phone!.trim(),
        proposed: evPhone,
        reason: 'Your local phone looks invalid (<7 digits); the 8vance one is valid',
        status: 'pending',
        source: '8vance',
        confidence: 0.7,
      });
    }
  }

  // Deterministic order: high-impact actions (replace/fill) first, then within
  // the same action the high-value kinds (skills/experience/education) before
  // low-value ones (language/contact), then stable by insertion index.
  return out
    .map((s, i) => ({ s, i }))
    .sort(
      (a, b) =>
        ACTION_RANK[a.s.action] - ACTION_RANK[b.s.action] ||
        KIND_RANK[a.s.kind] - KIND_RANK[b.s.kind] ||
        a.i - b.i,
    )
    .map(({ s }) => s);
}
