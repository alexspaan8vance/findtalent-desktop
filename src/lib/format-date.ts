/**
 * Locale-aware date formatting helpers.
 *
 * `Date.prototype.toLocaleDateString()` / `toLocaleString()` WITHOUT an explicit
 * locale format in the RUNTIME's locale — on the server that's usually en-US
 * ("7/3/2026", "1:25:38 PM") regardless of the user's UI language. These
 * helpers mirror the pattern the match view uses (`Intl.DateTimeFormat` keyed
 * on the next-intl app locale) so NL users see "3 jul 2026".
 *
 * Server components: `formatDate(await getLocale(), d)`.
 * Client components: `formatDate(useLocale(), d)`.
 */

export function formatDate(
  locale: string,
  date: Date | string | number,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  return new Intl.DateTimeFormat(locale, options).format(new Date(date));
}

/** Date + time (e.g. "3 jul 2026, 13:25") in the app locale. */
export function formatDateTime(locale: string, date: Date | string | number): string {
  return formatDate(locale, date, { dateStyle: 'medium', timeStyle: 'short' });
}
