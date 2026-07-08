/**
 * Customer dashboard home.
 *
 * Server component: fetches the signed-in user's real credit balance,
 * project counts, reveal stats and the last 8 weeks of REVEAL credit
 * transactions, then hands a plain array to the client chart. Shows a
 * friendly first-run onboarding panel when the user has no projects yet.
 */

import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

import { requireUser } from '@/lib/auth-helpers';
import { prisma } from '@/lib/db';
import { getOrCreateUserOrg } from '@/lib/org';
import { availableCredits } from '@/lib/credits';
import { formatDate } from '@/lib/format-date';
import { RevealsChart, type RevealWeekPoint } from '@/components/dashboard/reveals-chart';

const WEEKS = 8;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/** Start of the ISO-ish week (Monday 00:00 local) containing `d`. */
function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - day);
  return x;
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
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

function StatusBadge({ status, label }: { status: string; label: string }) {
  const color =
    status === 'READY'
      ? 'bg-emerald-100 text-emerald-700'
      : status === 'MATCHING'
        ? 'bg-amber-100 text-amber-700'
        : status === 'FAILED'
          ? 'bg-rose-100 text-rose-700'
          : 'bg-zinc-100 text-zinc-700';
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{label}</span>
  );
}

function statusLabelKey(
  status: string
): 'statusReady' | 'statusMatching' | 'statusFailed' | 'statusPending' {
  switch (status) {
    case 'READY':
      return 'statusReady';
    case 'MATCHING':
      return 'statusMatching';
    case 'FAILED':
      return 'statusFailed';
    default:
      return 'statusPending';
  }
}

export default async function DashboardPage(): Promise<React.ReactElement> {
  const session = await requireUser();
  const t = await getTranslations('dashboard');
  const tp = await getTranslations('projects');
  const locale = await getLocale();

  // Projects are shared across the user's team org; reveal/credit stats stay
  // strictly per-user. `projectWhere` collapses to userId for a solo org.
  const orgId = await getOrCreateUserOrg(session.id);
  const projectWhere = { OR: [{ userId: session.id }, { organizationId: orgId }] };

  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const chartFrom = startOfWeek(new Date(now.getTime() - (WEEKS - 1) * MS_PER_WEEK));

  const [user, activeProjects, totalReveals, revealsThisPeriod, revealTx, recentReveals, recentProjects] =
    await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: session.id },
        select: { creditsBalance: true, purchasedCredits: true },
      }),
      prisma.project.count({
        where: { ...projectWhere, status: { in: ['DRAFT', 'MATCHING', 'READY'] } },
      }),
      prisma.reveal.count({ where: { userId: session.id } }),
      prisma.reveal.count({ where: { userId: session.id, revealedAt: { gte: periodStart } } }),
      prisma.creditTransaction.findMany({
        where: { userId: session.id, reason: 'REVEAL', createdAt: { gte: chartFrom } },
        select: { createdAt: true },
      }),
      prisma.reveal.findMany({
        where: { userId: session.id },
        orderBy: { revealedAt: 'desc' },
        take: 5,
        select: {
          id: true,
          revealedAt: true,
          expiresAt: true,
          projectId: true,
          project: { select: { title: true } },
        },
      }),
      prisma.project.findMany({
        where: projectWhere,
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, title: true, status: true, locationCity: true, createdAt: true },
      }),
    ]);

  const totalProjects = await prisma.project.count({ where: projectWhere });

  // Bucket REVEAL transactions into the last WEEKS weekly buckets.
  const buckets: RevealWeekPoint[] = [];
  const counts = new Array<number>(WEEKS).fill(0);
  for (const tx of revealTx) {
    const idx = Math.floor((startOfWeek(tx.createdAt).getTime() - chartFrom.getTime()) / MS_PER_WEEK);
    if (idx >= 0 && idx < WEEKS) counts[idx] += 1;
  }
  const fmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
  for (let i = 0; i < WEEKS; i++) {
    const weekStart = new Date(chartFrom.getTime() + i * MS_PER_WEEK);
    buckets.push({ label: fmt.format(weekStart), reveals: counts[i] });
  }

  const credits = availableCredits(user);
  const isFirstRun = totalProjects === 0;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--ft-ink)' }}>
            {t('title')}
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--ft-muted)' }}>
            {t('subtitle')}
          </p>
        </div>
        <Link
          href="/app/projects/new"
          className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ft-accent-strong)] focus-visible:ring-offset-2"
          style={{ background: 'var(--ft-accent)', color: 'var(--ft-accent-fg)' }}
        >
          {t('newProject')}
        </Link>
      </div>

      {isFirstRun ? (
        <OnboardingPanel
          title={t('onboardTitle')}
          body={t('onboardBody')}
          steps={[t('onboardStep1'), t('onboardStep2'), t('onboardStep3')]}
          cta={t('onboardCta')}
          stepLabel={t('onboardStepsLabel')}
        />
      ) : null}

      <section aria-labelledby="ft-stats-heading">
        <h2 id="ft-stats-heading" className="sr-only">
          {t('statsHeading')}
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label={t('statCredits')} value={credits} hint={t('statCreditsHint')} />
          <StatCard label={t('statActiveProjects')} value={activeProjects} />
          <StatCard label={t('statTotalReveals')} value={totalReveals} />
          <StatCard label={t('statRevealsPeriod')} value={revealsThisPeriod} hint={t('statRevealsPeriodHint')} />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section
          className="rounded-2xl border p-5 lg:col-span-2"
          style={{ borderColor: 'var(--ft-border)', background: 'var(--ft-surface)' }}
        >
          <h2 className="text-sm font-semibold" style={{ color: 'var(--ft-ink)' }}>
            {t('chartTitle')}
          </h2>
          <p className="mb-4 text-xs" style={{ color: 'var(--ft-muted)' }}>
            {t('chartSubtitle')}
          </p>
          <RevealsChart data={buckets} />
        </section>

        <section
          className="rounded-2xl border p-5"
          style={{ borderColor: 'var(--ft-border)', background: 'var(--ft-surface)' }}
        >
          <h2 className="text-sm font-semibold" style={{ color: 'var(--ft-ink)' }}>
            {t('recentRevealsTitle')}
          </h2>
          {recentReveals.length === 0 ? (
            <p className="mt-3 text-sm" style={{ color: 'var(--ft-muted)' }}>
              {t('recentRevealsEmpty')}
            </p>
          ) : (
            <ul className="mt-3 space-y-1">
              {recentReveals.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/app/projects/${r.projectId}/shortlist`}
                    className="-mx-2 flex items-center justify-between rounded-lg px-2 py-2 hover:bg-[var(--ft-accent-soft)]"
                  >
                    <span className="truncate text-sm" style={{ color: 'var(--ft-ink)' }}>
                      {r.project?.title ?? t('recentRevealsUnknownProject')}
                    </span>
                    <span className="ml-3 shrink-0 text-xs" style={{ color: 'var(--ft-muted)' }}>
                      {formatDate(locale, r.revealedAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {recentProjects.length > 0 ? (
        <section
          className="rounded-2xl border p-5"
          style={{ borderColor: 'var(--ft-border)', background: 'var(--ft-surface)' }}
        >
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--ft-ink)' }}>
              {t('recentProjectsTitle')}
            </h2>
            <Link
              href="/app/projects"
              className="text-xs font-medium hover:underline"
              style={{ color: 'var(--ft-accent)' }}
            >
              {t('viewAllProjects')}
            </Link>
          </div>
          <ul className="divide-y" style={{ borderColor: 'var(--ft-border)' }}>
            {recentProjects.map((p) => (
              <li key={p.id} style={{ borderColor: 'var(--ft-border)' }}>
                <Link
                  href={`/app/projects/${p.id}/shortlist`}
                  className="-mx-2 flex items-center justify-between rounded-lg px-2 py-3 hover:bg-[var(--ft-accent-soft)]"
                >
                  <div>
                    <div className="text-sm font-medium" style={{ color: 'var(--ft-ink)' }}>
                      {p.title}
                    </div>
                    <div className="mt-0.5 text-xs" style={{ color: 'var(--ft-muted)' }}>
                      {p.locationCity} · {formatDate(locale, p.createdAt)}
                    </div>
                  </div>
                  <StatusBadge status={p.status} label={tp(statusLabelKey(p.status))} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function OnboardingPanel({
  title,
  body,
  steps,
  cta,
  stepLabel,
}: {
  title: string;
  body: string;
  steps: string[];
  cta: string;
  stepLabel: string;
}) {
  return (
    <section
      className="rounded-2xl border p-6 sm:p-8"
      style={{ borderColor: 'var(--ft-accent-line)', background: 'var(--ft-accent-soft)' }}
    >
      <h2 className="text-lg font-semibold" style={{ color: 'var(--ft-ink)' }}>
        {title}
      </h2>
      <p className="mt-2 max-w-2xl text-sm" style={{ color: 'var(--ft-muted)' }}>
        {body}
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
              {stepLabel} {i + 1}
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
        {cta}
      </Link>
    </section>
  );
}
