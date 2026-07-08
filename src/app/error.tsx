'use client'; // Error boundaries must be Client Components

/**
 * Root error boundary. Wraps every route segment below the root layout, so a
 * thrown error renders this branded fallback instead of Next's raw error page.
 * The root layout (html/body + NextIntlClientProvider) still renders around
 * this, so next-intl t() is available.
 */

import { useEffect } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  const t = useTranslations('errors');

  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-[60vh] flex-1 items-center justify-center px-6 py-16">
      <div
        className="w-full max-w-md rounded-2xl border p-8 text-center"
        style={{ borderColor: 'var(--ft-border)', background: 'var(--ft-surface)' }}
      >
        <div
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-full text-xl"
          style={{ background: 'var(--ft-accent-soft)', color: 'var(--ft-accent-strong)' }}
          aria-hidden="true"
        >
          ⚠
        </div>
        <h1 className="mt-4 text-lg font-semibold" style={{ color: 'var(--ft-ink)' }}>
          {t('title')}
        </h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--ft-muted)' }}>
          {t('body')}
        </p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-lg px-4 py-2 text-sm font-medium"
            style={{ background: 'var(--ft-accent)', color: 'var(--ft-accent-fg)' }}
          >
            {t('tryAgain')}
          </button>
          <Link
            href="/"
            className="rounded-lg border px-4 py-2 text-sm font-medium text-zinc-700 transition hover:border-[var(--ft-border-strong)]"
            style={{ borderColor: 'var(--ft-border)' }}
          >
            {t('goHome')}
          </Link>
        </div>
        {error.digest && (
          <p className="mt-4 text-xs" style={{ color: 'var(--ft-muted)' }}>
            {t('reference', { digest: error.digest })}
          </p>
        )}
      </div>
    </main>
  );
}
