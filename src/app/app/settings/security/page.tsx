import { getTranslations } from 'next-intl/server';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { ChangePasswordForm, ChangeEmailForm } from './security-forms';

export default async function SecuritySettingsPage() {
  const user = await requireUser();
  const t = await getTranslations('security');
  const fresh = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { email: true },
  });

  return (
    <div className="mx-auto max-w-xl space-y-8">
      <h1 className="text-2xl font-semibold text-zinc-900">{t('title')}</h1>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          {t('passwordSection')}
        </h2>
        <p className="mt-2 text-sm text-zinc-600">{t('passwordBody')}</p>
        <ChangePasswordForm />
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          {t('emailSection')}
        </h2>
        <p className="mt-2 text-sm text-zinc-600">{t('emailBody')}</p>
        <ChangeEmailForm currentEmail={fresh.email} />
      </section>
    </div>
  );
}
