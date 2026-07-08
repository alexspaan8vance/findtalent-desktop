import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { availableCredits } from '@/lib/credits';

export default async function SettingsPage() {
  const user = await requireUser();
  const t = await getTranslations('settings');
  const fresh = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: {
      email: true,
      name: true,
      role: true,
      creditsBalance: true,
      purchasedCredits: true,
      creditsPeriodEnd: true,
      currentPlanId: true,
      stripeCustomerId: true,
    },
  });

  const plan = fresh.currentPlanId
    ? await prisma.plan.findUnique({ where: { id: fresh.currentPlanId } })
    : null;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold text-zinc-900">{t('account')}</h1>

      <section className="rounded-xl border border-zinc-200 bg-white p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          {t('profile')}
        </h2>
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-zinc-500">{t('email')}</dt>
            <dd className="mt-1 text-zinc-900">{fresh.email}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">{t('role')}</dt>
            <dd className="mt-1 text-zinc-900">
              {fresh.role === 'ADMIN' ? t('roleAdmin') : t('roleCustomer')}
            </dd>
          </div>
        </dl>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          {t('billing')}
        </h2>
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-zinc-500">{t('currentPlan')}</div>
            <div className="mt-1 text-zinc-900">{plan?.name ?? t('noPlan')}</div>
          </div>
          <div>
            <div className="text-zinc-500">{t('creditsBalance')}</div>
            <div className="mt-1 text-zinc-900">{availableCredits(fresh)}</div>
          </div>
          <div>
            <div className="text-zinc-500">{t('periodEnds')}</div>
            <div className="mt-1 text-zinc-900">
              {fresh.creditsPeriodEnd
                ? new Date(fresh.creditsPeriodEnd).toLocaleDateString()
                : '—'}
            </div>
          </div>
        </div>
        <div className="mt-6 flex gap-3">
          <Link
            href="/billing/choose-plan"
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
          >
            {plan ? t('changePlan') : t('choosePlan')}
          </Link>
          {fresh.stripeCustomerId && (
            <Link
              href="/billing/portal"
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
            >
              {t('billingPortal')}
            </Link>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          {t('security')}
        </h2>
        <p className="mt-2 text-sm text-zinc-600">{t('securityBody')}</p>
        <Link
          href="/app/settings/security"
          className="mt-4 inline-block rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
        >
          {t('securityManage')}
        </Link>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          {t('notifications')}
        </h2>
        <p className="mt-2 text-sm text-zinc-600">{t('notificationsBody')}</p>
        <Link
          href="/app/settings/notifications"
          className="mt-4 inline-block rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
        >
          {t('notificationsManage')}
        </Link>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          {t('team')}
        </h2>
        <p className="mt-2 text-sm text-zinc-600">{t('teamBody')}</p>
        <Link
          href="/app/settings/team"
          className="mt-4 inline-block rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
        >
          {t('teamManage')}
        </Link>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          {t('pipeline')}
        </h2>
        <p className="mt-2 text-sm text-zinc-600">{t('pipelineBody')}</p>
        <Link
          href="/app/settings/pipeline"
          className="mt-4 inline-block rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
        >
          {t('pipelineManage')}
        </Link>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          {t('emailTemplates')}
        </h2>
        <p className="mt-2 text-sm text-zinc-600">{t('emailTemplatesBody')}</p>
        <Link
          href="/app/settings/email-templates"
          className="mt-4 inline-block rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
        >
          {t('emailTemplatesManage')}
        </Link>
      </section>

      <section className="rounded-xl border border-rose-200 bg-rose-50 p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-rose-700">
          {t('dataAccount')}
        </h2>
        <p className="mt-2 text-sm text-rose-800">{t('dataAccountBody')}</p>
        <Link
          href="/app/settings/delete-account"
          className="mt-4 inline-block rounded-lg border border-rose-300 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100"
        >
          {t('dataAccountManage')}
        </Link>
      </section>
    </div>
  );
}
