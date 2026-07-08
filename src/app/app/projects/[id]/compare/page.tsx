/**
 * Candidate compare view.
 *
 * Renders 2–4 selected, anonymized candidates side-by-side so a recruiter can
 * decide who to reveal. Candidates are addressed by their opaque id via the
 * `?ids=` query param; every match is re-verified to belong to a project owned
 * by the current user. Only the anonymized payload is rendered — no PII is ever
 * surfaced here, identical to the pre-reveal shortlist contract.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { requireUser } from '@/lib/auth-helpers';
import { prisma } from '@/lib/db';
import { userCanAccessProject } from '@/lib/org';
import { enrichMatch } from '@/lib/match/hydrate';
import { ProficiencyMeter } from '@/components/proficiency-meter';
import { ScoreRing } from '@/components/score-ring';
import type { AnonymizedTalent } from '@/lib/anonymize/types';
import { displaySkillName } from '@/lib/anonymize/talent';
import { hasActiveLock } from '@/lib/reveal/lock';

import { revealAction } from '../talent/[opaqueId]/actions';
import { BulkReveal, type BulkRevealResult } from './bulk-reveal';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ids?: string }>;
}

const MIN_COMPARE = 2;
const MAX_COMPARE = 4;

interface CompareColumn {
  matchId: string;
  opaqueId: string;
  score: number;
  tenantSlug: string;
  tenantName: string;
  anon: AnonymizedTalent;
  /** Whether the current user already holds the reveal lock for this talent. */
  revealed: boolean;
}

export default async function ComparePage({
  params,
  searchParams,
}: PageProps): Promise<React.ReactElement> {
  const { id: projectId } = await params;
  const { ids } = await searchParams;
  const session = await requireUser();
  const t = await getTranslations('compare');
  const ts = await getTranslations('shortlist');

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true, organizationId: true, title: true },
  });
  if (!project) notFound();
  if (!(await userCanAccessProject(session.id, project))) notFound();

  // Parse + dedupe the requested opaque ids, capped at MAX_COMPARE.
  const opaqueIds = [
    ...new Set(
      (ids ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].slice(0, MAX_COMPARE);

  // Fetch only matches that belong to THIS project (ownership already checked).
  const matches =
    opaqueIds.length > 0
      ? await prisma.match.findMany({
          where: { projectId, opaqueId: { in: opaqueIds } },
          select: {
            id: true,
            opaqueId: true,
            score: true,
            tenantId: true,
            eightvanceTalentId: true,
            anonymizedPayloadJson: true,
            tenant: { select: { slug: true, name: true } },
          },
        })
      : [];

  // Preserve the user-selected order from the query string.
  const byOpaque = new Map(matches.map((m) => [m.opaqueId, m]));
  const ordered = opaqueIds
    .map((oid) => byOpaque.get(oid))
    .filter((m): m is (typeof matches)[number] => Boolean(m));

  const columns: CompareColumn[] = await Promise.all(
    ordered.map(async (m) => {
      let anon = m.anonymizedPayloadJson as unknown as AnonymizedTalent;
      if (
        anon &&
        (anon.experience?.length ?? 0) === 0 &&
        (anon.education?.length ?? 0) === 0 &&
        (anon.languages?.length ?? 0) === 0
      ) {
        const enriched = await enrichMatch(m.id).catch(() => null);
        if (enriched) anon = enriched;
      }
      // READ-TIME skill sanitizer: a stored payload from before the
      // anonymize-side fix can still carry a raw `skill_<id>`. Map any such
      // name to the localized generic label so the compare columns (must/
      // other/gap skill lists) never render a raw taxonomy id.
      if (anon && Array.isArray(anon.skills)) {
        const label = ts('skillUnknown');
        anon = {
          ...anon,
          skills: anon.skills.map((s) =>
            displaySkillName(s.name, label) === s.name
              ? s
              : { ...s, name: displaySkillName(s.name, label) },
          ),
        };
      }
      const lock = await hasActiveLock(m.eightvanceTalentId, m.tenantId, session.id);
      return {
        matchId: m.id,
        opaqueId: m.opaqueId,
        score: m.score,
        tenantSlug: m.tenant.slug,
        tenantName: m.tenant.name,
        anon,
        revealed: Boolean(lock.locked && lock.ownedByCurrentUser),
      };
    }),
  );

  const enough = columns.length >= MIN_COMPARE;
  const unrevealed = columns.filter((c) => !c.revealed);

  // Bulk-reveal server action: reveal the still-anonymous, selected candidates
  // sequentially, stopping cleanly on the first insufficient-credits result so
  // we never spend a credit the user doesn't have. Each result is reported
  // per-candidate. Reuses the single-candidate `revealAction` (no duplicated
  // credit/lock logic). Ownership is re-checked inside `revealAction`.
  async function bulkRevealAction(matchIds: string[]): Promise<BulkRevealResult[]> {
    'use server';
    await requireUser();
    const results: BulkRevealResult[] = [];
    let stop = false;
    for (const matchId of matchIds) {
      if (stop) {
        results.push({ matchId, status: 'skipped' });
        continue;
      }
      const res = await revealAction(matchId);
      if (res.ok) {
        results.push({ matchId, status: 'revealed' });
      } else if (res.reason === 'insufficient_credits') {
        results.push({ matchId, status: 'insufficient_credits' });
        stop = true; // Halt: no point attempting the rest.
      } else if (res.reason === 'past_due') {
        results.push({ matchId, status: 'past_due' });
        stop = true; // Billing inactive — every further attempt fails too.
      } else if (res.reason === 'locked') {
        results.push({ matchId, status: 'locked' });
      } else {
        results.push({ matchId, status: 'error' });
      }
    }
    return results;
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-[var(--ft-accent-strong)]">
            {t('eyebrow')}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--ft-ink)]">
            {project.title}
          </h1>
        </div>
        <div className="flex items-center gap-4">
          {enough && unrevealed.length > 0 && (
            <BulkReveal
              items={unrevealed.map((c) => ({
                matchId: c.matchId,
                opaqueId: c.opaqueId,
              }))}
              action={bulkRevealAction}
            />
          )}
          <Link
            href={`/app/projects/${projectId}/shortlist`}
            className="text-sm text-zinc-600 hover:text-zinc-900"
          >
            {t('backToShortlist')}
          </Link>
        </div>
      </header>

      {!enough ? (
        <div className="mt-10 rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface)] p-8 text-center text-sm text-zinc-600">
          {t('tooFew', { min: MIN_COMPARE, max: MAX_COMPARE })}
        </div>
      ) : (
        <div className="mt-8 overflow-x-auto pb-2">
          <div
            className="grid gap-4"
            style={{
              gridTemplateColumns: `repeat(${columns.length}, minmax(15rem, 1fr))`,
            }}
          >
            {columns.map((c) => (
              <CompareCard key={c.matchId} projectId={projectId} col={c} t={t} ts={ts} />
            ))}
          </div>
        </div>
      )}
    </main>
  );
}

type CompareTranslations = Awaited<ReturnType<typeof getTranslations<'compare'>>>;
type ShortlistTranslations = Awaited<ReturnType<typeof getTranslations<'shortlist'>>>;

function CompareCard({
  projectId,
  col,
  t,
  ts,
}: {
  projectId: string;
  col: CompareColumn;
  t: CompareTranslations;
  ts: ShortlistTranslations;
}): React.ReactElement {
  const anon = col.anon;
  const must = anon.skills.filter((s) => s.must_have_match);
  const other = anon.skills.filter((s) => !s.must_have_match && !s.gap);
  const gap = anon.skills.filter((s) => s.gap);
  const location =
    [anon.location.province, anon.location.country]
      .map((s) => (s ?? '').trim())
      .filter((s) => s && s.toLowerCase() !== 'unknown')
      .join(', ') || ts('locationUnknown');
  const yearsLabel = anon.total_years_experience_bucket
    ? ts('yearsExperience', { years: anon.total_years_experience_bucket })
    : '—';

  return (
    <div className="flex flex-col rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-zinc-500">
            {ts('anonymousCandidate')}
          </div>
          <div className="mt-1 text-sm text-zinc-700">{location}</div>
          <span
            className="mt-2 inline-flex items-center rounded-full border border-[var(--ft-border)] px-2 py-0.5 text-[10px] font-medium text-zinc-600"
            title={col.tenantName}
          >
            {ts('fromPool', { name: col.tenantName })}
          </span>
        </div>
        <ScoreRing score={col.score} />
      </div>

      <CompareSection label={t('experience')}>
        <div className="text-sm text-zinc-700">{yearsLabel}</div>
        <ul className="mt-2 space-y-1.5">
          {anon.experience.map((e, i) => (
            <li key={i} className="text-xs text-zinc-600">
              <span className="font-medium text-[var(--ft-ink)]">{e.function_title}</span>
              {' · '}
              {e.sector} · {e.duration_bucket}
              {e.is_current && ` · ${t('current')}`}
            </li>
          ))}
          {anon.experience.length === 0 && (
            <li className="text-xs text-zinc-400">{t('none')}</li>
          )}
        </ul>
      </CompareSection>

      <CompareSection label={t('mustHaveSkills')}>
        <SkillList skills={must} variant="accent" emptyLabel={t('none')} />
      </CompareSection>

      <CompareSection label={t('otherSkills')}>
        <SkillList skills={other} variant="muted" emptyLabel={t('none')} />
      </CompareSection>

      <CompareSection label={t('gapSkills')}>
        {gap.length === 0 ? (
          <div className="text-xs text-zinc-400">{t('none')}</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {gap.map((s) => (
              <span
                key={s.name}
                className="rounded-full border border-[var(--ft-gap-line)] bg-[var(--ft-gap-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--ft-gap)]"
              >
                {s.name}
              </span>
            ))}
          </div>
        )}
      </CompareSection>

      <CompareSection label={t('education')}>
        <ul className="space-y-1 text-xs text-zinc-700">
          {anon.education.map((e, i) => (
            <li key={i}>
              {[e.level, e.field_of_study_category]
                .map((s) => (s ?? '').trim())
                .filter(Boolean)
                .join(' · ') || '—'}
            </li>
          ))}
          {anon.education.length === 0 && (
            <li className="text-xs text-zinc-400">{t('none')}</li>
          )}
        </ul>
      </CompareSection>

      <CompareSection label={t('languages')}>
        <ul className="space-y-1 text-xs text-zinc-700">
          {anon.languages.map((l, i) => (
            <li key={i} className="flex items-center justify-between gap-2">
              <span>{l.language}</span>
              <span className="text-zinc-500">{l.speak_level}</span>
            </li>
          ))}
          {anon.languages.length === 0 && (
            <li className="text-xs text-zinc-400">{t('none')}</li>
          )}
        </ul>
      </CompareSection>

      <div className="mt-auto pt-4">
        <Link
          href={`/app/projects/${projectId}/talent/${col.opaqueId}#reveal`}
          className="block rounded-lg bg-[var(--ft-accent)] px-3 py-1.5 text-center text-xs font-medium text-[var(--ft-accent-fg)] transition hover:bg-[var(--ft-accent-strong)]"
        >
          {t('revealCta')}
        </Link>
      </div>
    </div>
  );
}

function CompareSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="mt-4 border-t border-[var(--ft-border)] pt-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </h3>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function SkillList({
  skills,
  variant,
  emptyLabel,
}: {
  skills: AnonymizedTalent['skills'];
  variant: 'accent' | 'muted';
  emptyLabel: string;
}): React.ReactElement {
  if (skills.length === 0) {
    return <div className="text-xs text-zinc-400">{emptyLabel}</div>;
  }
  return (
    <ul className="space-y-1.5">
      {skills.map((s) => (
        <li key={s.name} className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate text-zinc-700">{s.name}</span>
          <ProficiencyMeter label={s.proficiency_label} variant={variant} />
        </li>
      ))}
    </ul>
  );
}
