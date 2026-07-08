import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { prisma } from '@/lib/db';

export default async function AdminCompaniesPage() {
  const tx = await getTranslations('adminCompanies');
  const tenants = await prisma.tenant.findMany({
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { projectPools: true, matches: true } } },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-900">Talent pools</h1>
        <Link
          href="/admin/companies/new"
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          Add pool
        </Link>
      </div>
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-700">
        <strong>This is a single-tenant whitelabel deploy.</strong> Each row
        below is one 8vance company whose talent pool can be matched against.
        Most deploys configure just one — your own company. Add another only
        when you want this instance to also expose a second 8vance pool. See{' '}
        <code className="rounded bg-white px-1.5 py-0.5">DEPLOYMENT.md</code>{' '}
        for whitelabel install on another server.
      </div>

      {tenants.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-12 text-center">
          <h2 className="text-lg font-medium text-zinc-900">No companies yet</h2>
          <p className="mt-2 text-sm text-zinc-600">
            Add a company to start matching candidates from their 8vance talent pool.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white">
          {tenants.map((t) => (
            <li key={t.id}>
              <Link
                href={`/admin/companies/${t.id}`}
                className="flex items-center justify-between px-5 py-4 hover:bg-zinc-50"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-zinc-900">{t.name}</span>
                    {t.isDefaultCandidatePool && (
                      <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                        {tx('defaultPool.badge')}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    slug: {t.slug} · 8vance company {t.eightvanceCompanyId}
                  </div>
                </div>
                <div className="text-sm text-zinc-600">
                  {t._count.projectPools} project{t._count.projectPools === 1 ? '' : 's'} · {t._count.matches} matches cached
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
