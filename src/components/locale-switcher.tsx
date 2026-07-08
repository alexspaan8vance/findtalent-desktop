'use client';

import { useRouter } from 'next/navigation';
import { useTransition, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { locales, type Locale } from '@/i18n/config';

const LABELS: Readonly<Record<Locale, string>> = {
  en: 'EN',
  nl: 'NL',
  de: 'DE',
};

function setLocaleCookie(value: Locale): void {
  // 1 year, lax, path /. No domain — defaults to current host.
  const oneYearSeconds = 60 * 60 * 24 * 365;
  document.cookie = `NEXT_LOCALE=${value}; Path=/; Max-Age=${oneYearSeconds}; SameSite=Lax`;
}

export function LocaleSwitcher(): React.ReactElement {
  const active = useLocale() as Locale;
  const t = useTranslations('app');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Optimistic pick, DERIVED against `active` instead of an effect-synced copy:
  // the pick only wins while `active` still equals the locale it was made from,
  // so the moment `active` changes (our refresh landing, or an external switch)
  // the select snaps back to the real locale — same behaviour as the old
  // setState-in-effect sync, without the cascading render.
  const [pick, setPick] = useState<{ from: Locale; value: Locale } | null>(null);
  const current = pick !== null && pick.from === active ? pick.value : active;

  const onChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const next = event.target.value as Locale;
    setPick({ from: active, value: next });
    setLocaleCookie(next);
    startTransition(() => {
      router.refresh();
    });
  };

  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-zinc-600">
      <span className="sr-only">{t('language')}</span>
      <select
        value={current}
        onChange={onChange}
        disabled={pending}
        aria-label={t('language')}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 hover:border-zinc-400 focus:border-zinc-900 focus:outline-none disabled:opacity-50"
      >
        {locales.map((loc) => (
          <option key={loc} value={loc}>
            {LABELS[loc]}
          </option>
        ))}
      </select>
    </label>
  );
}
