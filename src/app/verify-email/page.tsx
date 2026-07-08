import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { prisma } from '@/lib/db';
import { consumeSignupToken } from '@/lib/auth-helpers';

type SearchParams = Promise<{ token?: string; from?: string }>;

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { token, from } = await searchParams;
  const t = await getTranslations('auth');

  if (!token) {
    return (
      <Layout title={t('verifyCheckTitle')}>
        <p className="text-sm text-zinc-600">{t('verifyCheckBody')}</p>
        <p className="mt-6 text-xs text-zinc-500">
          Wrong account?{' '}
          <Link href="/signup" className="underline">
            Start over
          </Link>
          .
        </p>
      </Layout>
    );
  }

  const result = await consumeSignupToken(token);
  if (!result.ok) {
    return (
      <Layout title="Verification link invalid">
        <p className="text-sm text-zinc-600">
          {result.reason === 'expired'
            ? 'This link has expired. Sign up again to get a fresh one.'
            : 'This link is not valid. It may have been used already.'}
        </p>
        <Link
          href="/signup"
          className="mt-6 inline-block rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white"
        >
          Sign up
        </Link>
      </Layout>
    );
  }

  await prisma.user.update({
    where: { email: result.email },
    data: { emailVerifiedAt: new Date() },
  });

  const next = from === 'signup' ? '/billing/choose-plan' : '/login';
  return (
    <Layout title={t('verifyDoneTitle')}>
      <p className="text-sm text-zinc-600">
        {next === '/billing/choose-plan' ? t('verifyDonePickPlan') : t('verifyDoneSignIn')}
      </p>
      <Link
        href={next}
        className="mt-6 inline-block rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white"
      >
        {t('verifyContinue')}
      </Link>
    </Layout>
  );
}

function Layout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center px-6">
      <h1 className="mb-4 text-2xl font-semibold text-zinc-900">{title}</h1>
      {children}
    </div>
  );
}
