import { getTranslations } from 'next-intl/server';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { PLAN_TIERS, EXTRA_CREDIT_PRICE_EUR } from '@/lib/stripe/plans';
import { startCheckoutAction, startCreditPackAction } from './actions';

export default async function ChoosePlanPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  await requireUser();
  const sp = searchParams ? await searchParams : undefined;
  const showError = sp?.error === 'unavailable';
  const plans = await prisma.plan.findMany({ where: { active: true } });
  const t = await getTranslations('billing');
  const planByKey = new Map(
    PLAN_TIERS.map((tier) => {
      const row = plans.find((p) => p.name === tier.name);
      return [tier.key, row] as const;
    }),
  );

  const hasSeeded = plans.length > 0;
  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">{t('title')}</h1>
      <p className="mt-2 text-zinc-600">{t('subtitle')}</p>

      {showError && (
        <div className="mt-6 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {t('unavailable')}
        </div>
      )}

      {!hasSeeded && (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Plans are not seeded yet. Run <code>npm run stripe:seed</code> on the server to
          create the Stripe products + prices.
        </div>
      )}

      <div className="mt-10 grid gap-6 sm:grid-cols-3">
        {PLAN_TIERS.map((tier) => {
          const row = planByKey.get(tier.key);
          return (
            <div
              key={tier.key}
              className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
            >
              <div className="text-sm font-medium uppercase tracking-wide text-zinc-500">
                {tier.name}
              </div>
              <div className="mt-3 text-3xl font-semibold text-zinc-900">
                €{tier.priceEur}
                <span className="ml-1 text-sm font-normal text-zinc-500">{t('perPeriod')}</span>
              </div>
              <div className="mt-1 text-sm text-zinc-600">
                {tier.creditsPerPeriod === 1
                  ? t('revealsPerPeriodOne', { count: tier.creditsPerPeriod })
                  : t('revealsPerPeriodOther', { count: tier.creditsPerPeriod })}
              </div>
              <form action={startCheckoutAction} className="mt-6">
                <input type="hidden" name="planKey" value={tier.key} />
                <button
                  type="submit"
                  disabled={!row}
                  className="w-full rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {row ? t('subscribe') : t('notAvailable')}
                </button>
              </form>
            </div>
          );
        })}
      </div>

      <section className="mt-12 rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="text-lg font-medium text-zinc-900">{t('extraTitle')}</h2>
        <p className="mt-1 text-sm text-zinc-600">
          {t('extraBody', { price: EXTRA_CREDIT_PRICE_EUR })}
        </p>
        <form action={startCreditPackAction} className="mt-4 flex items-center gap-3">
          <label htmlFor="qty" className="text-sm text-zinc-600">
            {t('quantity')}
          </label>
          <input
            id="qty"
            name="quantity"
            type="number"
            min={1}
            max={50}
            defaultValue={1}
            className="w-20 rounded-md border border-zinc-300 px-2 py-1 text-sm"
          />
          <button
            type="submit"
            className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
          >
            {t('buyCredits')}
          </button>
        </form>
      </section>
    </div>
  );
}

export const metadata = { title: 'Choose plan' };
