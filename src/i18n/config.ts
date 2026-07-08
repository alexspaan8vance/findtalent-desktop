export const locales = ['en', 'nl', 'de'] as const;
export type Locale = typeof locales[number];
export const defaultLocale: Locale = 'nl';

export function isLocale(value: string | undefined | null): value is Locale {
  if (!value) return false;
  return (locales as readonly string[]).includes(value);
}
