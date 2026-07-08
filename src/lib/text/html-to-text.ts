/**
 * Convert an HTML fragment into clean, readable PLAIN TEXT.
 *
 * 8vance vacancy descriptions (`/job/{id}/extended/`.description) arrive as HTML
 * — `<p>`, `<ul><li>`, `<br>`, and entities like `&euml; &nbsp; &amp; &#39;`.
 * Printed verbatim in a `whitespace-pre-line` block they show tags + entities
 * ("ziet er niet uit"). This turns that into readable text: block elements
 * become line breaks, list items become bullets, entities are decoded, and the
 * remaining tags are stripped.
 *
 * NOT a sanitizer: the output is plain text rendered AS text (never injected as
 * HTML via dangerouslySetInnerHTML), so there is no XSS surface — which is why
 * we don't pull in a DOMPurify-style dependency. Deterministic + pure.
 */

/** Named HTML entities we decode (the set that actually shows up in NL/DE/EN
 * vacancy copy). Anything unlisted is left as-is. */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  euro: "€",
  pound: "£",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  middot: "·",
  bull: "•",
  // Accented letters common in Dutch/German/French copy (lower + upper).
  eacute: "é", Eacute: "É",
  egrave: "è", Egrave: "È",
  euml: "ë", Euml: "Ë",
  ecirc: "ê", Ecirc: "Ê",
  agrave: "à", Agrave: "À",
  aacute: "á", Aacute: "Á",
  auml: "ä", Auml: "Ä",
  acirc: "â", Acirc: "Â",
  iuml: "ï", Iuml: "Ï",
  iacute: "í", Iacute: "Í",
  ouml: "ö", Ouml: "Ö",
  oacute: "ó", Oacute: "Ó",
  ocirc: "ô", Ocirc: "Ô",
  uuml: "ü", Uuml: "Ü",
  uacute: "ú", Uacute: "Ú",
  ucirc: "û", Ucirc: "Û",
  ccedil: "ç", Ccedil: "Ç",
  ntilde: "ñ", Ntilde: "Ñ",
  szlig: "ß",
};

/** Turn a numeric code point into a string, dropping anything invalid. */
function fromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

/** Decode numeric (`&#39;` / `&#x2019;`) and known named entities. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name: string) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)
        ? NAMED_ENTITIES[name]
        : m,
    );
}

export function htmlToText(html: string): string {
  if (!html || typeof html !== "string") return "";
  let s = html;

  // <br> → newline; each <li> starts a bullet line.
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\s*li[^>]*>/gi, "\n• ");
  // Block-level boundaries (open + close) → newline so paragraphs/headings/rows
  // don't run together.
  s = s.replace(
    /<\/?\s*(p|div|ul|ol|h[1-6]|tr|table|thead|tbody|section|article|header|footer)[^>]*>/gi,
    "\n",
  );
  // Strip every remaining tag.
  s = s.replace(/<[^>]+>/g, "");

  s = decodeEntities(s);

  // Whitespace cleanup: collapse runs of spaces/tabs/NBSP, trim each line, then
  // collapse 3+ blank lines to a single blank line.
  s = s.replace(/[ \t ]+/g, " ");
  s = s
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

/** Whether `s` is a safe http(s) URL to render as an external link (rejects
 * `javascript:`, `data:`, relative, and malformed values). */
export function isHttpUrl(s: unknown): s is string {
  if (typeof s !== "string" || s.length === 0) return false;
  try {
    const u = new URL(s.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
