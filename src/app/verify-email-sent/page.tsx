import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export default async function VerifyEmailSentPage() {
  const t = await getTranslations('auth');
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center px-6">
      <h1 className="mb-4 text-2xl font-semibold text-zinc-900">{t('verifySentTitle')}</h1>
      <p className="text-sm text-zinc-600">{t('verifySentBody')}</p>
      <p className="mt-6 text-xs text-zinc-500">
        {t('verifySentRetry')}{' '}
        <Link href="/signup" className="underline">
          {t('verifySentTryAgain')}
        </Link>
        .
      </p>
    </div>
  );
}
