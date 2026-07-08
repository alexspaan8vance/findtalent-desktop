/**
 * Free-text scrubber for the anonymization pipeline.
 *
 * The anonymized payload is shown to a buyer BEFORE they pay to reveal a
 * candidate. Some fields (notably `function_title` on experience entries) are
 * free-text the talent typed themselves. A job title like "PA to John de Vries"
 * or a hyper-specific one-of-a-kind title can carry an embedded person name,
 * an employee/badge id, or a contact handle — all strong re-identification
 * vectors (LinkedIn search, etc.).
 *
 * `scrubFreeText` is intentionally CONSERVATIVE: it removes the clearly-PII
 * fragments while keeping the generic role words. If scrubbing leaves nothing
 * meaningful behind, it returns '' so the caller can fall back to a safe
 * generic (the existing `|| 'Unknown'` pattern) instead of leaking.
 */

// ---------------------------------------------------------------------------
// Shape detectors (mirror the blocklist value-scan shapes; kept in sync there)
// ---------------------------------------------------------------------------

/** Email-shaped token anywhere in the string. */
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** URL / domain-ish token (http(s)://…, www.…, or bare foo.com/…). */
const URL_RE =
  /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?/gi;

/**
 * Phone-shaped token: 7+ digits possibly broken up by spaces / dashes / dots /
 * parens, optional leading +. Requires enough digits that it cannot be a year
 * or a small count.
 */
const PHONE_RE = /\+?\(?\d[\d\s().-]{6,}\d/g;

/**
 * Long digit run that looks like an employee / badge / staff id (5+ digits).
 * Years (4 digits) and small counts are left intact on purpose.
 */
const ID_NUMBER_RE = /\b\d{5,}\b/g;

// ---------------------------------------------------------------------------
// Personal-name patterns
// ---------------------------------------------------------------------------

/**
 * Dutch/English name infixes ("tussenvoegsels") that can sit inside a captured
 * name run — kept lowercase here so a "de"/"van"/"of" inside a name doesn't
 * break the capture but also isn't treated as a Capitalized name word.
 */
const NAME_INFIXES = new Set([
  'de', 'den', 'der', 'van', 'von', 'ter', 'te', 'het', "'t",
  'op', 'aan', 'in', 'bij', 'tot', 'of', 'the', 'al', 'el', 'da', 'di',
  'la', 'le', 'du', 'das', 'dos',
]);

/**
 * Alternation source for the infixes, sorted LONGEST-first so the regex engine
 * prefers "der" over "de" (ordered alternation would otherwise match "de" and
 * leave a stray "r"). Word-boundaried via the surrounding `\s+`.
 */
const INFIX_ALT = [...NAME_INFIXES]
  .sort((a, b) => b.length - a.length)
  .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

/**
 * "<connector> to/for/at/of <Proper Name>" — e.g.
 *   "PA to John de Vries", "Assistant to Mr. Smith",
 *   "Secretary for Anne-Marie van der Berg".
 * Captures everything from the connector through the trailing name run and
 * deletes it. We only delete the name + connector tail, never the role head.
 */
const PA_TO_NAME_RE = new RegExp(
  // connector words that typically precede a person's name in a title
  '\\s*\\b(?:to|for|of|van|aan)\\b\\s+' +
    // optional honorific (case-insensitive list inline; rest stays case-sensitive)
    '(?:(?:[Mm][Rr]|[Mm][Rr][Ss]|[Mm][Ss]|[Dd][Rr]|[Ii][Rr]|[Dd][Rr][Ss]|[Pp]rof|[Ss]ir|[Mm]adam|[Mm]evr|[Dd]hr|[Hh]r)\\.?\\s+)?' +
    // first capitalized name word
    '[A-Z][a-zA-Z' + "'" + 'À-ſ-]+' +
    // any number of following infixes / capitalized words (rest of full name)
    '(?:\\s+(?:' + INFIX_ALT +
    '|[A-Z][a-zA-Z' + "'" + 'À-ſ-]+))*',
  'g',
);

/**
 * Honorific directly followed by a capitalized word — "Mr. Smith", "Dr Jansen".
 * Catches a leading/standalone name that PA_TO_NAME_RE's connector misses.
 */
const HONORIFIC_NAME_RE =
  /\b(?:mr|mrs|ms|dr|ir|drs|prof|sir|madam|mevr|dhr|hr)\.?\s+[A-Z][a-zA-Z'À-ſ-]+(?:\s+[A-Z][a-zA-Z'À-ſ-]+)*/gi;

/**
 * A run of 2+ consecutive Capitalized words (optionally joined by name
 * infixes) that looks like a full personal name — e.g. "John de Vries",
 * "Anne-Marie Bakker". Single capitalized words are NOT touched here because
 * almost every legitimate role word is capitalized ("Software", "Engineer").
 * Requiring TWO name-shaped words keeps false positives low.
 */
const FULL_NAME_RE = new RegExp(
  '\\b[A-Z][a-z' + "'" + 'À-ſ-]+' +
    '(?:\\s+(?:' + INFIX_ALT + '))*' +
    '\\s+[A-Z][a-z' + "'" + 'À-ſ-]+\\b',
  'g',
);

/**
 * Common generic role words. If a candidate FULL_NAME_RE match is built only
 * from these, it's a legitimate title ("Project Manager", "Software Engineer")
 * and must be preserved — not scrubbed as a name.
 */
export const ROLE_WORDS = new Set([
  'software', 'engineer', 'developer', 'manager', 'project', 'product',
  'senior', 'junior', 'lead', 'principal', 'staff', 'chief', 'head',
  'director', 'officer', 'analyst', 'consultant', 'architect', 'designer',
  'administrator', 'administrateur', 'specialist', 'coordinator', 'assistant',
  'associate', 'executive', 'supervisor', 'technician', 'operator', 'agent',
  'representative', 'advisor', 'adviseur', 'scientist', 'researcher',
  'data', 'cloud', 'security', 'network', 'systems', 'system', 'business',
  'sales', 'marketing', 'finance', 'financial', 'human', 'resources',
  'operations', 'support', 'service', 'customer', 'account', 'quality',
  'test', 'qa', 'devops', 'frontend', 'backend', 'full', 'stack', 'fullstack',
  'team', 'general', 'managing', 'deputy', 'vice', 'president', 'partner',
  'recruiter', 'recruitment', 'controller', 'accountant', 'auditor', 'dev',
  'nurse', 'doctor', 'teacher', 'professor', 'intern', 'trainee',
  'medewerker', 'directeur', 'hoofd', 'manager', 'ontwikkelaar', 'beheerder',
  // common connector/scaffolding words that may sit between role words
  'the', 'and', 'of', 'to', 'for', 'in', 'at', 'on',
]);

/**
 * Decide whether a 2+ capitalized-word run is a legitimate role title (keep)
 * rather than a personal name (scrub). Heuristic: titles LEAD with a role word
 * ("Junior Dev", "Senior Engineer", "Project Manager"); personal names lead
 * with a given name ("John de Vries"). So we preserve the run when its first
 * word is a known role word. Conservative by design — it errs toward keeping a
 * title, but anything name-shaped that does not lead with a role word is cut.
 */
function looksLikeRoleTitle(s: string): boolean {
  const words = s.split(/[\s/&,-]+/).filter(Boolean);
  if (words.length === 0) return false;
  // Only a genuine title: EVERY word must be a known role word or a name
  // infix ("Senior Engineer", "Head of Operations"). A run like
  // "Senior Jansen" leaks a real surname under the old first-word-only check,
  // so it must NOT be preserved here.
  return words.every(
    (w) =>
      ROLE_WORDS.has(w.toLowerCase()) || NAME_INFIXES.has(w.toLowerCase()),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrub a free-text value down to something safe to expose pre-reveal.
 *
 * Order matters: remove structured PII shapes (email/url/phone/id) first, then
 * connector-bound names ("PA to <Name>"), then honorific names, then bare
 * full-name runs (skipping legitimate all-role-word titles), then tidy up.
 *
 * Returns '' when nothing meaningful survives, so callers fall back to a
 * generic label rather than leaking a partial fragment.
 */
export function scrubFreeText(input: string | null | undefined): string {
  let s = (input ?? '').trim();
  if (!s) return '';

  // 1. Structured contact / identifier shapes — always removed.
  s = s.replace(EMAIL_RE, ' ');
  s = s.replace(URL_RE, ' ');
  s = s.replace(PHONE_RE, ' ');
  s = s.replace(ID_NUMBER_RE, ' ');

  // 2. "<role> to/for/of <Proper Name>" — drop the connector + name tail,
  //    keep the role head ("PA to John de Vries" → "PA").
  s = s.replace(PA_TO_NAME_RE, ' ');

  // 3. Honorific-led names anywhere ("Dr. Jansen").
  s = s.replace(HONORIFIC_NAME_RE, ' ');

  // 4. Bare full-name runs ("John de Vries"), but preserve genuine titles made
  //    only of role words ("Project Manager").
  s = s.replace(FULL_NAME_RE, (m) => (looksLikeRoleTitle(m) ? m : ' '));

  // 5. Tidy: collapse whitespace and strip dangling separators left behind.
  s = s
    .replace(/[\s]+/g, ' ')
    .replace(/\s*[-/&,:]+\s*$/g, '')
    .replace(/^\s*[-/&,:]+\s*/g, '')
    .trim();

  // 6. If only punctuation/garbage remains, treat as empty.
  if (!/[a-z0-9À-ſ]/i.test(s)) return '';

  return s;
}
