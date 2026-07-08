/**
 * Reveal history + spend page — /app/reveals
 *
 * Server component. Shows the signed-in user's reveals (newest first) with
 * project title, revealed date, lock expiry (active vs expired), and the
 * source pool/tenant. A spend summary card sums REVEAL credit transactions,
 * available credits and reveals this period.
 *
 * Each reveal links to its anonymous talent detail page. The detail route is
 * keyed by `Match.opaqueId`, so we resolve the opaque id per reveal by
 * (projectId, tenantId, eightvanceTalentId) — the Match unique key.
 */

import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { requireUser } from '@/lib/auth-helpers';
import { prisma } from '@/lib/db';
import { availableCredits } from '@/lib/credits';

export const dynamic = 'force-dynamic';

function StatCard({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div
      className="rounded-2xl border p-5"
      style={{ borderColor: 'var(--ft-border)', background: 'var(--ft-surface)' }}
    >
      <div className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--ft-muted)' }}>
        {label}
      </div>
      <div className="mt-2 text-3xl font-semibold" style={{ color: 'var(--ft-ink)' }}>
        {value}
      </div>
      {hint ? (
        <div className="mt-1 text-xs" style={{ color: 'var(--ft-muted)' }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export default async function RevealsPage(): Promise<React.ReactElement> {
  const session = await requireUser();
  const t = await getTranslations('reveals');
  const locale = await getLocale();

  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [user, reveals, spendAgg, revealsThisPeriod] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: session.id },
      select: { creditsBalance: true, purchasedCredits: true },
    }),
    prisma.reveal.findMany({
      where: { userId: session.id },
      orderBy: { revealedAt: 'desc' },
      take: 200,
      select: {
        id: true,
        revealedAt: true,
        expiresAt: true,
        creditCost: true,
        projectId: true,
        tenantId: true,
        eightvanceTalentId: true,
        project: { select: { title: true } },
        tenant: { select: { slug: true, name: true } },
      },
    }),
    // Spend ledger: REVEAL rows store delta = -1 each. Sum the magnitude.
    prisma.creditTransaction.aggregate({
      where: { userId: session.id, reason: 'REVEAL' },
      _sum: { delta: true },
      _count: true,
    }),
    prisma.reveal.count({ where: { userId: session.id, revealedAt: { gte: periodStart } } }),
  ]);

  // Resolve opaqueId per reveal via the Match unique key
  // (projectId, tenantId, eightvanceTalentId). One batched query.
  const matchKeys = reveals.map((r) => ({
    projectId: r.projectId,
    tenantId: r.tenantId,
    eightvanceTalentId: r.eightvanceTalentId,
  }));
  const matches =
    matchKeys.length > 0
      ? await prisma.match.findMany({
          where: { OR: matchKeys },
          select: { projectId: true, tenantId: true, eightvanceTalentId: true, opaqueId: true },
        })
      : [];
  const opaqueByKey = new Map(
    matches.map((m) => [`${m.projectId}:${m.tenantId}:${m.eightvanceTalentId}`, m.opaqueId]),
  );

  const credits = availableCredits(user);
  const spentTotal = Math.abs(spendAgg._sum.delta ?? 0);
  const spendCount = spendAgg._count;

  // App locale (not the server's default) so NL shows "3 jul 2026".
  const dateFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--ft-ink)' }}>
          {t('title')}
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--ft-muted)' }}>
          {t('subtitle')}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t('statCredits')} value={credits} hint={t('statCreditsHint')} />
        <StatCard label={t('statSpent')} value={spentTotal} hint={t('statSpentHint')} />
        <StatCard label={t('statTotal')} value={spendCount} />
        <StatCard label={t('statPeriod')} value={revealsThisPeriod} hint={t('statPeriodHint')} />
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

        {reveals.length === 0 ? (
          <p className="px-5 py-8 text-sm" style={{ color: 'var(--ft-muted)' }}>
            {t('empty')}
          </p>
        ) : (
          <>
            {/* Table on >=sm, stacked cards on mobile. */}
            <div className="hidden sm:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left" style={{ color: 'var(--ft-muted)' }}>
                    <th className="px-5 py-3 font-medium">{t('colRevealed')}</th>
                    <th className="px-5 py-3 font-medium">{t('colProject')}</th>
                    <th className="px-5 py-3 font-medium">{t('colPool')}</th>
                    <th className="px-5 py-3 font-medium">{t('colExpiry')}</th>
                    <th className="px-5 py-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {reveals.map((r) => {
                    const active = r.expiresAt.getTime() > now.getTime();
                    const opaqueId = opaqueByKey.get(
                      `${r.projectId}:${r.tenantId}:${r.eightvanceTalentId}`,
                    );
                    return (
                      <tr key={r.id} className="border-t" style={{ borderColor: 'var(--ft-border)' }}>
                        <td className="px-5 py-3" style={{ color: 'var(--ft-ink)' }}>
                          {dateFmt.format(r.revealedAt)}
                        </td>
                        <td className="px-5 py-3" style={{ color: 'var(--ft-ink)' }}>
                          {r.project?.title ?? t('unknownProject')}
                        </td>
                        <td className="px-5 py-3" style={{ color: 'var(--ft-muted)' }}>
                          {r.tenant?.name ?? r.tenant?.slug ?? '—'}
                        </td>
                        <td className="px-5 py-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              active ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-100 text-zinc-600'
                            }`}
                          >
                            {active ? t('badgeActive') : t('badgeExpired')} · {dateFmt.format(r.expiresAt)}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-right">
                          {opaqueId ? (
                            <Link
                              href={`/app/projects/${r.projectId}/talent/${opaqueId}`}
                              className="text-xs font-medium hover:underline"
                              style={{ color: 'var(--ft-accent)' }}
                            >
                              {t('viewCandidate')}
                            </Link>
                          ) : (
                            <span className="text-xs" style={{ color: 'var(--ft-muted)' }}>
                              {t('candidateUnavailable')}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <ul className="divide-y sm:hidden" style={{ borderColor: 'var(--ft-border)' }}>
              {reveals.map((r) => {
                const active = r.expiresAt.getTime() > now.getTime();
                const opaqueId = opaqueByKey.get(
                  `${r.projectId}:${r.tenantId}:${r.eightvanceTalentId}`,
                );
                const body = (
                  <div className="px-5 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-medium" style={{ color: 'var(--ft-ink)' }}>
                        {r.project?.title ?? t('unknownProject')}
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                          active ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-100 text-zinc-600'
                        }`}
                      >
                        {active ? t('badgeActive') : t('badgeExpired')}
                      </span>
                    </div>
                    <div className="mt-1 text-xs" style={{ color: 'var(--ft-muted)' }}>
                      {dateFmt.format(r.revealedAt)} · {r.tenant?.name ?? r.tenant?.slug ?? '—'} ·{' '}
                      {t('expiresShort', { date: dateFmt.format(r.expiresAt) })}
                    </div>
                  </div>
                );
                return (
                  <li key={r.id} style={{ borderColor: 'var(--ft-border)' }}>
                    {opaqueId ? (
                      <Link
                        href={`/app/projects/${r.projectId}/talent/${opaqueId}`}
                        className="block hover:bg-[var(--ft-accent-soft)]"
                      >
                        {body}
                      </Link>
                    ) : (
                      body
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
