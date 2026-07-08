/**
 * Admin usage analytics.
 *
 * Per talent-pool (Tenant) and overall: number of projects targeting the pool,
 * matches cached, reveals, outreach attempts, and active reveal locks. Plus an
 * overall credits-spent figure (CreditTransaction REVEAL rows — these are not
 * tenant-scoped). Admin-only (the layout already calls requireAdmin; we
 * re-assert here so the page is safe in isolation).
 */

import { getTranslations } from 'next-intl/server';

import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth-helpers';

interface PoolRow {
  tenantId: string;
  slug: string;
  name: string;
  projects: number;
  matches: number;
  reveals: number;
  outreach: number;
  activeLocks: number;
}

export default async function AdminAnalyticsPage(): Promise<React.ReactElement> {
  await requireAdmin();
  const t = await getTranslations('adminAnalytics');
  const now = new Date();

  const tenants = await prisma.tenant.findMany({
    select: { id: true, slug: true, name: true },
    orderBy: { slug: 'asc' },
  });

  // Tenant-scoped aggregates in a few grouped queries (one round-trip each)
  // rather than N×tenants queries.
  const [
    matchesByTenant,
    revealsByTenant,
    outreachByTenant,
    activeLocksByTenant,
    projectPools,
    overallProjects,
    overallMatches,
    overallReveals,
    overallOutreach,
    overallActiveLocks,
    creditsSpentAgg,
  ] = await Promise.all([
    prisma.match.groupBy({ by: ['tenantId'], _count: { _all: true } }),
    prisma.reveal.groupBy({ by: ['tenantId'], _count: { _all: true } }),
    prisma.outreach.groupBy({ by: ['tenantId'], _count: { _all: true } }),
    prisma.revealLock.groupBy({
      by: ['tenantId'],
      where: { expiresAt: { gt: now } },
      _count: { _all: true },
    }),
    // Distinct projects per pool (a project can target several pools).
    prisma.projectPool.findMany({ select: { tenantId: true, projectId: true } }),
    prisma.project.count(),
    prisma.match.count(),
    prisma.reveal.count(),
    prisma.outreach.count(),
    prisma.revealLock.count({ where: { expiresAt: { gt: now } } }),
    // Credits spent on reveals = number of REVEAL ledger rows (each spends 1).
    prisma.creditTransaction.count({ where: { reason: 'REVEAL' } }),
  ]);

  const countOf = (
    rows: Array<{ tenantId: string; _count: { _all: number } }>,
    tenantId: string,
  ): number => rows.find((r) => r.tenantId === tenantId)?._count._all ?? 0;

  // Distinct project count per tenant.
  const projectsPerTenant = new Map<string, Set<string>>();
  for (const pp of projectPools) {
    let set = projectsPerTenant.get(pp.tenantId);
    if (!set) {
      set = new Set<string>();
      projectsPerTenant.set(pp.tenantId, set);
    }
    set.add(pp.projectId);
  }

  const rows: PoolRow[] = tenants.map((t) => ({
    tenantId: t.id,
    slug: t.slug,
    name: t.name,
    projects: projectsPerTenant.get(t.id)?.size ?? 0,
    matches: countOf(matchesByTenant, t.id),
    reveals: countOf(revealsByTenant, t.id),
    outreach: countOf(outreachByTenant, t.id),
    activeLocks: countOf(activeLocksByTenant, t.id),
  }));

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold text-zinc-900">{t('title')}</h1>

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label={t('projects')} value={overallProjects} />
        <Stat label={t('matches')} value={overallMatches} />
        <Stat label={t('reveals')} value={overallReveals} />
        <Stat label={t('creditsSpent')} value={creditsSpentAgg} />
        <Stat label={t('outreach')} value={overallOutreach} />
        <Stat label={t('activeLocks')} value={overallActiveLocks} />
      </div>

      <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
        <div className="border-b border-zinc-100 px-6 py-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            {t('perPool')}
          </h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="px-6 py-3">{t('pool')}</th>
              <th className="px-4 py-3 text-right">{t('projects')}</th>
              <th className="px-4 py-3 text-right">{t('matches')}</th>
              <th className="px-4 py-3 text-right">{t('reveals')}</th>
              <th className="px-4 py-3 text-right">{t('outreach')}</th>
              <th className="px-4 py-3 text-right">{t('activeLocks')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {rows.map((r) => (
              <tr key={r.tenantId} className="text-zinc-800">
                <td className="px-6 py-3">
                  <div className="font-medium text-zinc-900">{r.name}</div>
                  <div className="font-mono text-xs text-zinc-400">{r.slug}</div>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{r.projects}</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.matches}</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.reveals}</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.outreach}</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.activeLocks}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="px-6 py-6 text-sm text-zinc-500">{t('noPools')}</p>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }): React.ReactElement {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-3xl font-semibold text-zinc-900">{value}</div>
    </div>
  );
}
