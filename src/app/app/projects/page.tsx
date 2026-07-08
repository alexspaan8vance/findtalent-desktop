import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { getOrCreateUserOrg } from '@/lib/org';
import { formatDate } from '@/lib/format-date';

// Display status is the project status, except when a READY project has at
// least one FAILED pool — then it's surfaced as a distinct 'PARTIAL' state so
// the list doesn't show a plain green success while a pool silently failed.
type DisplayStatus = 'READY' | 'MATCHING' | 'FAILED' | 'PARTIAL' | 'PENDING' | 'ARCHIVED' | 'CLOSED';

function StatusBadge({ status, label }: { status: DisplayStatus; label: string }) {
  const color =
    status === 'READY'
      ? 'bg-emerald-100 text-emerald-700'
      : status === 'MATCHING'
        ? 'bg-amber-100 text-amber-700'
        : status === 'PARTIAL'
          ? 'bg-amber-100 text-amber-800'
          : status === 'FAILED'
            ? 'bg-rose-100 text-rose-700'
            : 'bg-zinc-100 text-zinc-700';
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {label}
    </span>
  );
}

function statusLabelKey(
  status: DisplayStatus,
):
  | 'statusReady'
  | 'statusMatching'
  | 'statusFailed'
  | 'statusPartial'
  | 'statusPending'
  | 'statusArchived'
  | 'statusClosed' {
  switch (status) {
    case 'READY':
      return 'statusReady';
    case 'MATCHING':
      return 'statusMatching';
    case 'FAILED':
      return 'statusFailed';
    case 'PARTIAL':
      return 'statusPartial';
    case 'ARCHIVED':
      return 'statusArchived';
    case 'CLOSED':
      return 'statusClosed';
    default:
      return 'statusPending';
  }
}

async function FirstRunPanel() {
  const t = await getTranslations('dashboard');
  const steps = [t('onboardStep1'), t('onboardStep2'), t('onboardStep3')];
  return (
    <section
      className="rounded-2xl border p-6 sm:p-8"
      style={{ borderColor: 'var(--ft-accent-line)', background: 'var(--ft-accent-soft)' }}
    >
      <h2 className="text-lg font-semibold" style={{ color: 'var(--ft-ink)' }}>
        {t('onboardTitle')}
      </h2>
      <p className="mt-2 max-w-2xl text-sm" style={{ color: 'var(--ft-muted)' }}>
        {t('onboardBody')}
      </p>
      <ol className="mt-5 grid gap-3 sm:grid-cols-3">
        {steps.map((step, i) => (
          <li
            key={i}
            className="rounded-xl border p-4"
            style={{ borderColor: 'var(--ft-border)', background: 'var(--ft-surface)' }}
          >
            <div
              className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold"
              style={{ background: 'var(--ft-accent)', color: 'var(--ft-accent-fg)' }}
            >
              {i + 1}
            </div>
            <div className="mt-2 text-xs uppercase tracking-wide" style={{ color: 'var(--ft-muted)' }}>
              {t('onboardStepsLabel')} {i + 1}
            </div>
            <div className="mt-1 text-sm" style={{ color: 'var(--ft-ink)' }}>
              {step}
            </div>
          </li>
        ))}
      </ol>
      <Link
        href="/app/projects/new"
        className="mt-6 inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium"
        style={{ background: 'var(--ft-accent)', color: 'var(--ft-accent-fg)' }}
      >
        {t('onboardCta')}
      </Link>
    </section>
  );
}

interface ProjectsPageProps {
  searchParams: Promise<{ filter?: string }>;
}

export default async function ProjectsPage({ searchParams }: ProjectsPageProps) {
  const user = await requireUser();
  const t = await getTranslations('projects');
  const locale = await getLocale();
  const orgId = await getOrCreateUserOrg(user.id);

  const { filter } = await searchParams;
  // The non-active tab shows both opbergde (ARCHIVED) and afgeronde (CLOSED)
  // projects; the active tab excludes both.
  const showArchived = filter === 'archived';

  const owner = { OR: [{ userId: user.id }, { organizationId: orgId }] };
  const INACTIVE_STATUSES = ['ARCHIVED', 'CLOSED'] as const;
  const projects = await prisma.project.findMany({
    where: showArchived
      ? { AND: [owner, { status: { in: [...INACTIVE_STATUSES] } }] }
      : { AND: [owner, { status: { notIn: [...INACTIVE_STATUSES] } }] },
    orderBy: { createdAt: 'desc' },
    // Pull each project's pool statuses in the SAME query (single findMany, no
    // N+1) so we can detect a partial-failure state (some pools FAILED while
    // the project rolled up to READY) and surface it distinctly in the list.
    include: {
      _count: { select: { matches: true } },
      pools: { select: { status: true, tenant: { select: { name: true } } } },
    },
  });

  // Show per-project pool badge(s) only when the org actually spans >1 pool —
  // with a single pool it's noise. Distinct pool names across the listed set.
  const distinctPoolNames = new Set(
    projects.flatMap((p) => p.pools.map((pool) => pool.tenant?.name).filter(Boolean)),
  );
  const showPoolBadges = distinctPoolNames.size > 1;

  // A project is "partial" when it's READY overall but at least one of its
  // pools FAILED — i.e. some talent pools matched, some didn't.
  function displayStatus(p: (typeof projects)[number]): DisplayStatus {
    if (p.status === 'READY' && p.pools.some((pool) => pool.status === 'FAILED')) {
      return 'PARTIAL';
    }
    switch (p.status) {
      case 'READY':
        return 'READY';
      case 'MATCHING':
        return 'MATCHING';
      case 'FAILED':
        return 'FAILED';
      case 'ARCHIVED':
        return 'ARCHIVED';
      case 'CLOSED':
        return 'CLOSED';
      default:
        return 'PENDING';
    }
  }

  const tabClass = (active: boolean): string =>
    `rounded-lg px-3 py-1.5 text-sm font-medium transition ${
      active
        ? 'bg-zinc-900 text-white'
        : 'border border-[var(--ft-border)] bg-white text-zinc-700 hover:border-[var(--ft-border-strong)]'
    }`;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-900">{t('title')}</h1>
        <Link
          href="/app/projects/new"
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          {t('newProject')}
        </Link>
      </div>

      <div className="mb-5 flex items-center gap-2">
        <Link href="/app/projects" className={tabClass(!showArchived)}>
          {t('filterActive')}
        </Link>
        <Link href="/app/projects?filter=archived" className={tabClass(showArchived)}>
          {t('filterArchived')}
        </Link>
      </div>

      {projects.length === 0 ? (
        showArchived ? (
          <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-8 text-center text-sm text-zinc-600">
            {t('noArchived')}
          </div>
        ) : (
          <FirstRunPanel />
        )
      ) : (
        <ul className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/app/projects/${p.id}/shortlist`}
                className="flex items-center justify-between px-5 py-4 hover:bg-zinc-50"
              >
                <div className="min-w-0">
                  <div className="font-medium text-zinc-900">{p.title}</div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    {p.locationCity}, {p.locationCountry} ·{' '}
                    {formatDate(locale, p.createdAt)}
                  </div>
                  {/* Which pool(s) this project targets — only when the org
                      spans more than one pool (otherwise it's noise). */}
                  {showPoolBadges && p.pools.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {Array.from(
                        new Set(
                          p.pools.map((pool) => pool.tenant?.name).filter((n): n is string => !!n),
                        ),
                      ).map((poolName) => (
                        <span
                          key={poolName}
                          className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600"
                        >
                          {poolName}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  {(() => {
                    const ds = displayStatus(p);
                    // While a project is still MATCHING, show an animated
                    // "Aan het matchen…" indicator instead of a static count so
                    // navigating to the list never looks stopped/frozen. The
                    // count still streams (matches land live), so we show it too
                    // once any have landed. CSS-only animation → RSC-safe.
                    if (ds === 'MATCHING') {
                      return (
                        <span
                          className="flex items-center gap-1.5 text-sm font-medium text-amber-700"
                          role="status"
                          aria-live="polite"
                        >
                          <span
                            className="ft-sparkle inline-block h-2 w-2 rounded-full bg-amber-500"
                            aria-hidden="true"
                          />
                          {t('matchingInProgress')}
                          {p._count.matches > 0 ? (
                            <span className="text-zinc-500">
                              · {p._count.matches}
                            </span>
                          ) : null}
                        </span>
                      );
                    }
                    return (
                      <>
                        <span className="text-sm text-zinc-600">
                          {t('matches', { count: p._count.matches })}
                        </span>
                        <StatusBadge status={ds} label={t(statusLabelKey(ds))} />
                      </>
                    );
                  })()}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
