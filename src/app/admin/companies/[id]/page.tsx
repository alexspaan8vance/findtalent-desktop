import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { prisma } from '@/lib/db';

import {
  updateTenantLocaleAction,
  updateTenantTalentScopeAction,
  setDefaultCandidatePool,
} from './actions';
import { EditCredsForm } from './creds-form';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function TenantDetailPage({ params }: PageProps) {
  const { id } = await params;
  const t = await getTranslations('adminCompanies');
  const tenant = await prisma.tenant.findUnique({
    where: { id },
    include: { _count: { select: { projectPools: true, matches: true } } },
  });
  if (!tenant) notFound();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900">{tenant.name}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            slug: {tenant.slug} · created {new Date(tenant.createdAt).toLocaleDateString()}
          </p>
        </div>
        <Link
          href="/admin/companies"
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
        >
          Back
        </Link>
      </div>

      <section className="rounded-xl border border-zinc-200 bg-white p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          8vance integration
        </h2>
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-zinc-500">Client ID</dt>
            <dd className="mt-1 font-mono text-zinc-900">
              {tenant.eightvanceClientId.slice(0, 10)}…
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">Company ID</dt>
            <dd className="mt-1 text-zinc-900">{tenant.eightvanceCompanyId}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">Client secret</dt>
            <dd className="mt-1 text-zinc-500">encrypted · cannot be displayed</dd>
          </div>
        </dl>

        <details className="mt-5 rounded-lg border border-zinc-200 bg-zinc-50/60 p-4">
          <summary className="cursor-pointer text-sm font-medium text-zinc-800">
            Edit credentials
          </summary>
          <EditCredsForm
            tenantId={tenant.id}
            clientId={tenant.eightvanceClientId}
            companyId={tenant.eightvanceCompanyId}
            ownSourceSlug={tenant.ownSourceSlug}
          />
        </details>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Wizard default language
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Pre-selected language for this pool&apos;s project wizard search
          dropdowns (function name, skills). Customers can override per project;
          projects upload exactly as typed (no translation).
        </p>
        <form action={updateTenantLocaleAction} className="mt-4 flex items-end gap-3">
          <input type="hidden" name="id" value={tenant.id} />
          <label className="block">
            <span className="text-xs text-zinc-500">Default search language</span>
            <select
              name="defaultLocale"
              defaultValue={tenant.defaultLocale}
              className="mt-1 block rounded-md border border-zinc-300 px-3 py-2 text-sm"
            >
              <option value="en">English</option>
              <option value="nl">Nederlands</option>
              <option value="de">Deutsch</option>
            </select>
          </label>
          <button
            type="submit"
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
          >
            Save
          </button>
        </form>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Candidates list scope
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Which talents show up under <strong>Candidates</strong>: the complete
          8vance talent pool, or only the candidates registered through
          findtalent. This affects the list view only — projects always match
          against the complete talent pool.
        </p>
        <form
          action={updateTenantTalentScopeAction}
          className="mt-4 flex items-end gap-3"
        >
          <input type="hidden" name="id" value={tenant.id} />
          <label className="block">
            <span className="text-xs text-zinc-500">Show in Candidates</span>
            <select
              name="talentScope"
              defaultValue={tenant.talentScope}
              className="mt-1 block rounded-md border border-zinc-300 px-3 py-2 text-sm"
            >
              <option value="FULL">Complete pool (all sources)</option>
              <option value="LOCAL">Only candidates registered here</option>
            </select>
          </label>
          <button
            type="submit"
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
          >
            Save
          </button>
        </form>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          {t('defaultPool.heading')}
        </h2>
        <p className="mt-1 text-sm text-zinc-600">{t('defaultPool.help')}</p>
        <div className="mt-4 flex items-center gap-3">
          {tenant.isDefaultCandidatePool ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700">
              {t('defaultPool.current')}
            </span>
          ) : (
            <form action={setDefaultCandidatePool}>
              <input type="hidden" name="id" value={tenant.id} />
              <button
                type="submit"
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
              >
                {t('defaultPool.setButton')}
              </button>
            </form>
          )}
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <Card label="Project pools" value={tenant._count.projectPools} />
        <Card label="Matches cached" value={tenant._count.matches} />
      </section>
    </div>
  );
}

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-3xl font-semibold text-zinc-900">{value}</div>
    </div>
  );
}
