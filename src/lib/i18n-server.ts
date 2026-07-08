/**
 * Server-only re-exports from `next-intl/server`.
 *
 * Use these in Server Components (and route handlers / server actions) so the
 * client-side `next-intl` bundle isn't pulled in unnecessarily.
 */

export { getTranslations, getLocale, getMessages, getFormatter } from 'next-intl/server';
