/**
 * Vacancy-URL helpers for the candidate→jobs detail.
 *
 * 8vance's /extended/ does NOT expose the readable career-page URL — only a
 * directApply `public_url` (which the source site can 404/redirect) and the
 * 8vance apply portal. But for recruitment sites on the 8vance career-WP the
 * readable URL is deterministic: `https://<host>/vacature/<jobId>-<title-slug>/`,
 * where the id segment is the 8vance JOB id and the slug is slugify(title).
 * VERIFIED live against tjellens.nl (job 961661806 "Field Service Engineer Raum
 * Dresden" → the exact live vacancy page). Pure + dependency-free (testable).
 */

/** URL-slug a title: lowercase, strip accents, non-alphanumerics → single dash. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Hosts known to use the `/vacature/<jobId>-<slug>/` career-WP permalink. */
const READABLE_VACANCY_HOSTS = new Set(['tjellens.nl', 'www.tjellens.nl']);

function trimOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Reconstruct the readable vacancy-page URL for a supported host, else null.
 * `website` is the employer's site (extended.company.website, or the directApply
 * public_url as a fallback signal for the host).
 */
export function readableVacancyUrl(
  jobId: number,
  title: unknown,
  website: unknown,
): string | null {
  const t = trimOrNull(title);
  const w = trimOrNull(website);
  if (!t || !w || !Number.isFinite(jobId) || jobId <= 0) return null;
  let host: string;
  try {
    host = new URL(w).host.toLowerCase();
  } catch {
    return null;
  }
  if (!READABLE_VACANCY_HOSTS.has(host)) return null;
  const bare = host.replace(/^www\./, '');
  const slug = slugify(t);
  if (!slug) return null;
  return `https://${bare}/vacature/${jobId}-${slug}/`;
}
