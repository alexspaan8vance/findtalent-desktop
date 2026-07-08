import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { prisma } from '@/lib/db';
import { ResetForm } from './reset-form';

type SearchParams = Promise<{ token?: string }>;

/**
 * A usable reset row is reset-namespaced and unexpired. Checked at request
 * time (module helper, not in the component body, so render stays pure).
 */
function isUsableResetRow(row: { identifier: string; expires: Date } | null): boolean {
  return !!row && row.identifier.startsWith('reset:') && row.expires.getTime() >= Date.now();
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { token } = await searchParams;
  const t = await getTranslations('auth');

  // Peek (do NOT consume) the token to decide whether to show the form. The
  // action re-validates and consumes it on submit, so this is purely UX — a
  // token that expires between page load and submit is still rejected server
  // side. We only accept reset-namespaced tokens here.
  const valid =
    token != null &&
    token.length > 0 &&
    (await prisma.verificationToken
      .findUnique({ where: { token } })
      .then(isUsableResetRow));

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-gray-900">{t('resetTitle')}</h1>

        {valid && token ? (
          <>
            <p className="mt-1 text-sm text-gray-500">{t('resetSubtitle')}</p>
            <ResetForm token={token} />
          </>
        ) : (
          <>
            <p className="mt-3 text-sm text-gray-600">{t('resetInvalidLink')}</p>
            <Link
              href="/forgot-password"
              className="mt-6 inline-block rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              {t('forgotTitle')}
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
