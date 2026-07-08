/**
 * Anonymous talent detail page.
 *
 * Renders the full `AnonymizedTalent` payload with skill-gap markers,
 * sector/duration buckets, and a Reveal CTA. When the user already
 * holds an active Reveal lock for this talent we decrypt and render
 * the PII card inline instead.
 */

import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { ShortlistStage } from '@prisma/client';

import { requireUser } from '@/lib/auth-helpers';
import { prisma } from '@/lib/db';
import { getOrCreateUserOrg, userCanAccessProject } from '@/lib/org';
import { getOrCreateStages, resolveEntryStageId } from '@/lib/pipeline';
import { decrypt } from '@/lib/crypto';
import { hasActiveLock } from '@/lib/reveal/lock';
import { enrichMatch } from '@/lib/match/hydrate';
import { hasOutreach } from '@/lib/outreach';
import { ProficiencyMeter } from '@/components/proficiency-meter';
import { ScoreRing } from '@/components/score-ring';
import { PipelineControls } from '@/components/shortlist/pipeline-controls';
import type { AnonymizedTalent, RevealedTalent } from '@/lib/anonymize/types';

import { revealAction, recordOutreachAction } from './actions';
import { setStage, saveNote } from '../../shortlist/actions';
import { moveCandidate } from '../../pipeline/actions';
import { RevealButton } from './reveal-button';
import { RevealedCard } from './revealed-card';

interface PageProps {
  params: Promise<{ id: string; opaqueId: string }>;
}

export default async function TalentDetailPage({ params }: PageProps): Promise<React.ReactElement> {
  const { id: projectId, opaqueId } = await params;
  const session = await requireUser();
  const tReveal = await getTranslations('reveal');
  const t = await getTranslations('talent');

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true, organizationId: true, title: true, skillsJson: true, status: true },
  });
  if (!project) notFound();
  if (!(await userCanAccessProject(session.id, project))) notFound();

  // CLOSED ("afgerond"): no candidate PII/anon detail — the reveals are ended
  // and the shortlist is hidden. Bounce to the shortlist's closed-state notice
  // so no anonymized payload or reveal CTA is rendered.
  if (project.status === 'CLOSED') {
    redirect(`/app/projects/${projectId}/shortlist`);
  }

  const match = await prisma.match.findFirst({
    where: { projectId, opaqueId },
    select: {
      id: true,
      opaqueId: true,
      eightvanceTalentId: true,
      tenantId: true,
      score: true,
      anonymizedPayloadJson: true,
      skillGapJson: true,
      tenant: { select: { slug: true, name: true } },
    },
  });
  if (!match) notFound();

  let anon = match.anonymizedPayloadJson as unknown as AnonymizedTalent;
  // Lazy enrichment: bulk hydrate only caches skills/location, so on first
  // detail view fetch the talent's experience/education/languages and cache.
  if (
    anon &&
    anon.experience.length === 0 &&
    anon.education.length === 0 &&
    anon.languages.length === 0
  ) {
    const enriched = await enrichMatch(match.id).catch(() => null);
    if (enriched) anon = enriched;
  }

  const lock = await hasActiveLock(match.eightvanceTalentId, match.tenantId, session.id);
  let revealed: RevealedTalent | null = null;
  // `shared` = the PII shown comes from a colleague's reveal on THIS project,
  // not the viewer's own reveal. Drives the "revealed by a teammate" badge.
  let shared = false;

  // Precedence: (1) the viewer's own active-lock reveal; else (2) a
  // project-scoped shared reveal made by any teammate on THIS exact project.
  if (lock.locked && lock.ownedByCurrentUser && lock.revealId) {
    const row = await prisma.reveal.findUnique({
      where: { id: lock.revealId },
      select: { piiPayloadEnc: true },
    });
    if (row) {
      try {
        const json = decrypt(row.piiPayloadEnc);
        revealed = JSON.parse(json) as RevealedTalent;
      } catch {
        revealed = null;
      }
    }
  }

  if (!revealed) {
    // Project-scoped SHARED reveal. The page already verified the viewer can
    // access THIS project (userCanAccessProject above) — that is the team
    // gate. Pinned to (projectId, eightvanceTalentId): 8vance talent ids are
    // GLOBAL (one id == one person across all pools/tenants), so a reveal of
    // this person under ANY pool of this project is the same person and is
    // correctly shared here — deliberately NOT scoped by tenantId (that would
    // break cross-pool sharing of the same person + risk a double-charge).
    const sharedReveal = await prisma.reveal.findFirst({
      where: {
        projectId: project.id,
        eightvanceTalentId: match.eightvanceTalentId,
        expiresAt: { gt: new Date() },
      },
      orderBy: { revealedAt: 'desc' },
      select: { piiPayloadEnc: true },
    });
    if (sharedReveal) {
      try {
        const json = decrypt(sharedReveal.piiPayloadEnc);
        revealed = JSON.parse(json) as RevealedTalent;
        shared = true;
      } catch {
        revealed = null;
        shared = false;
      }
    }
  }

  // Outreach state: has the current user already contacted this candidate?
  const outreach =
    revealed != null
      ? await hasOutreach({
          userId: session.id,
          projectId,
          eightvanceTalentId: match.eightvanceTalentId,
        })
      : { contacted: false, firstAt: null };

  // Pipeline state for this match (favorite/stage/note). Absence = default.
  const entry = await prisma.shortlistEntry.findUnique({
    where: { userId_matchId: { userId: session.id, matchId: match.id } },
    select: { stage: true, stageId: true, note: true },
  });

  // The org's configurable stages + the stage this entry resolves to (legacy
  // enum is mapped onto a default stage when stageId is null).
  const orgId = await getOrCreateUserOrg(session.id);
  const stages = await getOrCreateStages(orgId);
  const resolvedStageId = resolveEntryStageId(
    stages,
    entry?.stageId ?? null,
    entry?.stage ?? ShortlistStage.NEW,
  );

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="flex items-start justify-between gap-6 rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface)] p-6">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-[var(--ft-accent-strong)]">
            {t('eyebrow')}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--ft-ink)]">
            {[anon.location.province, anon.location.country]
              .map((s) => (s ?? '').trim())
              .filter((s) => s && s.toLowerCase() !== 'unknown')
              .join(', ') || t('locationUnknown')}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span
              className="inline-flex items-center rounded-full border border-[var(--ft-border)] px-2 py-0.5 text-[10px] font-medium text-zinc-600"
              title={match.tenant.name}
            >
              {t('fromPool', { name: match.tenant.name })}
            </span>
            <span className="font-mono text-[10px] text-zinc-400">{anon.opaque_id}</span>
          </div>
        </div>
        <ScoreRing score={match.score} size="lg" />
      </header>

      <PipelineControls
        matchId={match.id}
        initialStage={entry?.stage ?? ShortlistStage.NEW}
        initialNote={entry?.note ?? ''}
        setStageAction={setStage}
        saveNoteAction={saveNote}
        stages={stages.map((s) => ({ id: s.id, name: s.name, color: s.color }))}
        initialStageId={resolvedStageId}
        moveAction={moveCandidate}
      />

      {revealed ? (
        <RevealedCard
          talent={revealed}
          matchId={match.id}
          shared={shared}
          contactedAt={outreach.firstAt ? outreach.firstAt.toISOString() : null}
          outreachAction={recordOutreachAction}
        />
      ) : (
        <>
          <AnonDetail anon={anon} t={t} />
          <section
            id="reveal"
            className="mt-10 overflow-hidden rounded-2xl border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)]"
          >
            <div className="p-6">
              {lock.locked && !lock.ownedByCurrentUser && lock.expiresAt ? (
                <div className="text-sm text-zinc-700">
                  {tReveal('lockedByOther')} {lock.expiresAt.toLocaleDateString()}.
                </div>
              ) : (
                <>
                  <div className="text-base font-semibold text-[var(--ft-ink)]">
                    {tReveal('confirmTitle')}
                  </div>
                  <p className="mt-1 max-w-prose text-sm text-zinc-700">
                    {tReveal('confirmBody')}
                  </p>
                  <RevealButton matchId={match.id} action={revealAction} />
                </>
              )}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

type TalentTranslations = Awaited<ReturnType<typeof getTranslations<'talent'>>>;

function AnonDetail({
  anon,
  t,
}: {
  anon: AnonymizedTalent;
  t: TalentTranslations;
}): React.ReactElement {
  const must = anon.skills.filter((s) => s.must_have_match);
  const matched = anon.skills.filter((s) => !s.must_have_match && !s.gap);
  const gap = anon.skills.filter((s) => s.gap);

  return (
    <div className="mt-6 space-y-6">
      <Card title={t('skills')}>
        {anon.skills.length === 0 ? (
          <p className="text-xs text-zinc-500">{t('noSkillData')}</p>
        ) : (
          <div className="space-y-4">
            {must.length > 0 && (
              <SkillRows
                heading={t('mustHaveHeading')}
                skills={must}
                variant="accent"
              />
            )}
            {matched.length > 0 && (
              <SkillRows heading={t('matchedHeading')} skills={matched} variant="muted" />
            )}
            {gap.length > 0 && (
              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                  {t('gapHeading')}
                </h3>
                <div className="mt-2 flex flex-wrap gap-2">
                  {gap.map((s) => (
                    <span
                      key={`g-${s.name}`}
                      className="rounded-full border border-[var(--ft-gap-line)] bg-[var(--ft-gap-soft)] px-3 py-1 text-xs font-medium text-[var(--ft-gap)]"
                    >
                      {s.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card title={t('experience')}>
        <ul className="space-y-2">
          {anon.experience.map((e, i) => (
            <li
              key={i}
              className="rounded-xl border border-[var(--ft-border)] bg-[var(--ft-surface-2)] p-3"
            >
              <div className="text-sm font-medium text-[var(--ft-ink)]">
                {e.function_title}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-600">
                <span>{e.sector}</span>
                <span className="text-zinc-300">·</span>
                <span>{e.duration_bucket}</span>
                {e.is_current && (
                  <span className="ml-1 rounded-full border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ft-accent-strong)]">
                    {t('current')}
                  </span>
                )}
              </div>
            </li>
          ))}
          {anon.experience.length === 0 && (
            <li className="text-xs text-zinc-500">{t('noExperienceData')}</li>
          )}
        </ul>
      </Card>

      <Card title={t('education')}>
        <ul className="space-y-1.5 text-sm text-zinc-700">
          {anon.education.map((e, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ft-accent)]" />
              <span>
                {[e.level, e.field_of_study_category]
                  .map((s) => (s ?? '').trim())
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </span>
            </li>
          ))}
          {anon.education.length === 0 && (
            <li className="text-xs text-zinc-500">{t('noEducationData')}</li>
          )}
        </ul>
      </Card>

      <Card title={t('languages')}>
        <ul className="space-y-2.5">
          {anon.languages.map((l, i) => (
            <li key={i} className="flex items-center gap-3 text-sm">
              <span className="w-28 shrink-0 text-zinc-700">{l.language}</span>
              <LanguageBar level={l.speak_level} />
              <span className="text-xs text-zinc-500">{l.speak_level}</span>
            </li>
          ))}
          {anon.languages.length === 0 && (
            <li className="text-xs text-zinc-500">{t('noLanguageData')}</li>
          )}
        </ul>
      </Card>
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface)] p-6">
      <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function SkillRows({
  heading,
  skills,
  variant,
}: {
  heading: string;
  skills: AnonymizedTalent['skills'];
  variant: 'accent' | 'muted';
}): React.ReactElement {
  return (
    <div>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
        {heading}
      </h3>
      <ul className="mt-2 space-y-2">
        {skills.map((s) => (
          <li
            key={`${heading}-${s.name}`}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span className="truncate text-zinc-800">{s.name}</span>
            <ProficiencyMeter label={s.proficiency_label} variant={variant} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function LanguageBar({ level }: { level: 'basic' | 'business' | 'native' }): React.ReactElement {
  const pct = level === 'native' ? 100 : level === 'business' ? 66 : 33;
  return (
    <div className="h-2 w-32 overflow-hidden rounded-full bg-[var(--ft-accent-soft)]">
      <div className="h-full rounded-full bg-[var(--ft-accent)]" style={{ width: `${pct}%` }} />
    </div>
  );
}
