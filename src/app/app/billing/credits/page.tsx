/**
 * Credit ledger — /app/billing/credits
 *
 * Server component. Lists the signed-in user's CreditTransaction rows (newest
 * first, capped at the last 100) with date, reason, signed delta, running
 * balance and an optional reference. Each `reason` is localized via the
 * `credits` i18n namespace (`credits.reason.<REASON>`), falling back to the
 * raw enum value if a label is missing.
 */

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { requireUser } from '@/lib/auth-helpers';
import { getCreditLedger } from '@/lib/credits';

export const dynamic = 'force-dynamic';

const LEDGER_LIMIT = 100;

export default async function CreditLedgerPage(): Promise<React.ReactElement> {
  const session = await requireUser();
  const t = await getTranslations('credits');

  const { entries, currentBalance } = await getCreditLedger(session.id, LEDGER_LIMIT);

  const dateFmt = new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const reasonLabel = (reason: string): string => t(`reason.${reason}`) || reason;

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--ft-ink)' }}>
            {t('title')}
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--ft-muted)' }}>
            {t('subtitle')}
          </p>
        </div>
        <Link
          href="/billing/choose-plan"
          className="shrink-0 rounded-lg px-4 py-2 text-sm font-medium text-white"
          style={{ background: 'var(--ft-accent)' }}
        >
          {t('buyCredits')}
        </Link>
      </div>

      <div
        className="rounded-2xl border p-5"
        style={{ borderColor: 'var(--ft-border)', background: 'var(--ft-surface)' }}
      >
        <div className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--ft-muted)' }}>
          {t('currentBalance')}
        </div>
        <div className="mt-2 text-3xl font-semibold" style={{ color: 'var(--ft-ink)' }}>
          {currentBalance}
        </div>
      </div>

      <section
        className="rounded-2xl border"
        style={{ borderColor: 'var(--ft-border)', background: 'var(--ft-surface)' }}
      >
        <div className="border-b px-5 py-4" style={{ borderColor: 'var(--ft-border)' }}>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--ft-ink)' }}>
            {t('historyTitle')}
          </h2>
        </div>

        {entries.length === 0 ? (
          <p className="px-5 py-8 text-sm" style={{ color: 'var(--ft-muted)' }}>
            {t('empty')}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--ft-muted)' }}>
                <th className="px-5 py-3 font-medium">{t('colDate')}</th>
                <th className="px-5 py-3 font-medium">{t('colReason')}</th>
                <th className="px-5 py-3 font-medium">{t('colRef')}</th>
                <th className="px-5 py-3 text-right font-medium">{t('colDelta')}</th>
                <th className="px-5 py-3 text-right font-medium">{t('colBalance')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const positive = e.delta >= 0;
                return (
                  <tr key={e.id} className="border-t" style={{ borderColor: 'var(--ft-border)' }}>
                    <td className="px-5 py-3" style={{ color: 'var(--ft-ink)' }}>
                      {dateFmt.format(e.createdAt)}
                    </td>
                    <td className="px-5 py-3" style={{ color: 'var(--ft-ink)' }}>
                      {reasonLabel(e.reason)}
                    </td>
                    <td className="px-5 py-3" style={{ color: 'var(--ft-muted)' }}>
                      {e.refId ?? '—'}
                    </td>
                    <td
                      className="px-5 py-3 text-right font-medium tabular-nums"
                      style={{ color: positive ? '#047857' : '#b91c1c' }}
                    >
                      {positive ? `+${e.delta}` : e.delta}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums" style={{ color: 'var(--ft-ink)' }}>
                      {e.balance}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {entries.length >= LEDGER_LIMIT && (
          <p className="border-t px-5 py-3 text-xs" style={{ borderColor: 'var(--ft-border)', color: 'var(--ft-muted)' }}>
            {t('cappedNote', { limit: LEDGER_LIMIT })}
          </p>
        )}
      </section>
    </div>
  );
}
