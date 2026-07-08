/**
 * Local CV → candidate-skill extraction.
 *
 * 8vance's server-side CV parser lives on the app API, not the public v1 client
 * findtalent uses, so we extract candidate skill PHRASES from the pasted CV
 * text here and resolve them against the live `/resources/skill/` taxonomy
 * (the caller does the resolve). This pre-fills the onboarding skills step from
 * a CV without depending on an unreachable parser endpoint. Pure + deterministic.
 */

// Common words that are never skills on their own — keeps the candidate list tight.
const STOPWORDS = new Set([
  // EN
  "and", "the", "with", "for", "from", "this", "that", "have", "has", "was",
  "are", "you", "your", "our", "their", "experience", "years", "year", "work",
  "worked", "working", "responsible", "team", "project", "projects", "company",
  "role", "skills", "skill", "summary", "profile", "education", "languages",
  "language", "references", "contact", "email", "phone", "address", "present",
  "current", "various", "including", "etc", "able", "using", "used", "use",
  // NL
  "en", "de", "het", "een", "van", "voor", "met", "bij", "aan", "ervaring",
  "jaar", "jaren", "werk", "gewerkt", "verantwoordelijk", "team", "project",
  "projecten", "bedrijf", "functie", "vaardigheden", "vaardigheid", "talen",
  "taal", "opleiding", "referenties", "heden", "diverse", "onder", "andere",
  "werkzaam", "zoals", "tot", "naar", "die", "dat", "ben", "was", "ook",
]);

function cleanToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9+#.\- ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPlausibleSkill(term: string): boolean {
  if (term.length < 2 || term.length > 40) return false;
  if (/^\d+$/.test(term)) return false; // pure numbers
  const words = term.split(" ");
  if (words.length > 4) return false; // skills are short phrases
  // Reject if every word is a stopword.
  if (words.every((w) => STOPWORDS.has(w))) return false;
  // A single-word candidate that's a stopword is out.
  if (words.length === 1 && STOPWORDS.has(words[0])) return false;
  return true;
}

/**
 * Extract up to `limit` distinct candidate skill phrases from CV text. Splits
 * on the delimiters CVs use for skill lists (commas, pipes, bullets, slashes,
 * newlines) and keeps short, plausible phrases. The result is a SHORTLIST to
 * resolve against the skill taxonomy — not a guarantee each is a real skill.
 */
export function extractSkillCandidates(cvText: string, limit = 40): string[] {
  if (!cvText || typeof cvText !== "string") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  // Split on list-ish delimiters; keep spaces inside multi-word skills.
  const fragments = cvText.split(/[\n\r,;:|/•·▪◦*\t]+|(?:\s-\s)/g);
  for (const frag of fragments) {
    const term = cleanToken(frag);
    if (!term || !isPlausibleSkill(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Pull contact details (email + phone) out of CV text. Email + phone are
 * mandatory at onboarding, so the wizard prefills these from the CV when found.
 * Phone matching favours NL/international formats; both are best-effort.
 */
export function extractContact(cvText: string): { email?: string; phone?: string } {
  if (!cvText || typeof cvText !== "string") return {};
  const out: { email?: string; phone?: string } = {};
  const email = cvText.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  if (email) out.email = email[0];
  // Phone: optional +CC, then 8-15 digits with spaces/dashes/parens/dots.
  const phone = cvText.match(/(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{1,4}\)?[\s.-]?){2,5}\d{2,4}/);
  if (phone) {
    const digits = phone[0].replace(/[^\d+]/g, "");
    if (digits.replace(/\D/g, "").length >= 8) out.phone = phone[0].trim();
  }
  return out;
}

/**
 * Normalize for matching: lower-case, strip diacritics, collapse whitespace.
 * Keeps the skill-significant chars (+ # . -) so "C++" / "Node.js" survive.
 */
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // drop combining diacritics
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `term` appears in `name` as a whole word/phrase. A boundary is the
 * start/end of the string or a separator char (space, slash, comma, pipe,
 * parens, dash). We keep [a-z0-9+#] as "inside a token" so "C++"/"C#" stay
 * intact and "Java" does NOT match inside "JavaScript". A "." after the term is
 * also a boundary so "React" matches "React.js"; a "." before is a boundary too.
 */
function containsAsPhrase(name: string, term: string): boolean {
  const re = new RegExp(`(^|[^a-z0-9+#])${escapeRe(term)}([^a-z0-9+#]|$)`);
  return re.test(name);
}

/** A single-token name that is `term` + a short tech suffix (".js", ".net"). */
function isTechVariant(name: string, term: string): boolean {
  if (!name.startsWith(term + '.')) return false;
  const suffix = name.slice(term.length + 1);
  return suffix.length > 0 && suffix.length <= 5 && !/[\s/,|()]/.test(suffix);
}

/**
 * Keep only resolver hits whose taxonomy name actually corresponds to the
 * searched term. The skill API returns fuzzy matches, so we must reject loose
 * superstrings ("SQL" → "DB2/SQL", "Java" → "JavaScript").
 *
 * Rule (case/diacritics-normalized):
 *   1. EXACT match → accept.
 *   2. A single-token tech variant ("React" → "React.js", "Node" → "Node.js")
 *      → accept.
 *   3. Otherwise accept a CONTAINED match ONLY when BOTH hold:
 *      a. the term occurs as a WHOLE WORD/PHRASE in the resolved name (so
 *         "Java" does NOT match "JavaScript" and "SQL" does NOT match "MSSQL");
 *      b. the resolved name is not far longer than the term (length ratio
 *         ≤ 1.6×), so the hit is a close variant — this rejects "SQL" →
 *         "DB2/SQL" and "SQL" → "SQL Server Administration & Tuning".
 *   4. We never accept "term contains resolvedName": the resolver searched the
 *      term, so a shorter resolved name is a broader/unrelated concept.
 *
 * Exposed for reuse + testing.
 */
export function nameMatchesTerm(term: string, resolvedName: string): boolean {
  const a = normalizeForMatch(term);
  const b = normalizeForMatch(resolvedName);
  if (!a || !b) return false;
  if (a === b) return true;

  // Single-token tech variant ("react" → "react.js") — accept regardless of ratio.
  if (isTechVariant(b, a)) return true;

  // Whole-word/phrase containment with a close length ratio.
  if (!containsAsPhrase(b, a)) return false;
  if (b.length > a.length * 1.6) return false;
  return true;
}
