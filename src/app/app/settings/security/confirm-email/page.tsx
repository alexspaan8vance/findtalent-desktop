import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { prisma } from '@/lib/db';
import { requireUser, consumeEmailChangeToken } from '@/lib/auth-helpers';

type SearchParams = Promise<{ token?: string }>;

export default async function ConfirmEmailPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  // Must be the logged-in account-holder confirming their own change.
  const user = await requireUser();
  const { token } = await searchParams;
  const t = await getTranslations('security');

  if (!token) {
    return <Layout title={t('confirmInvalidTitle')} body={t('confirmInvalidBody')} />;
  }

  const result = await consumeEmailChangeToken(token);
  if (!result.ok) {
    return (
      <Layout
        title={t('confirmInvalidTitle')}
        body={result.reason === 'expired' ? t('confirmExpiredBody') : t('confirmInvalidBody')}
      />
    );
  }

  // The link must belong to the signed-in user — never let one account confirm
  // another's email change.
  if (result.userId !== user.id) {
    return <Layout title={t('confirmInvalidTitle')} body={t('confirmWrongUser')} />;
  }

  // Re-check uniqueness at confirm time: the address may have been claimed by
  // someone else between request and confirmation.
  const taken = await prisma.user.findUnique({ where: { email: result.newEmail } });
  if (taken && taken.id !== user.id) {
    return <Layout title={t('confirmTakenTitle')} body={t('confirmTakenBody')} />;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { email: result.newEmail, emailVerifiedAt: new Date() },
  });

  return (
    <Layout title={t('confirmDoneTitle')} body={t('confirmDoneBody', { email: result.newEmail })}>
      <Link
        href="/app/settings/security"
        className="mt-6 inline-block rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white"
      >
        {t('confirmBack')}
      </Link>
    </Layout>
  );
}

function Layout({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col justify-center px-6">
      <h1 className="mb-4 text-2xl font-semibold text-zinc-900">{title}</h1>
      <p className="text-sm text-zinc-600">{body}</p>
      {children}
    </div>
  );
}
