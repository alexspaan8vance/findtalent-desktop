/**
 * Configurable Kanban pipeline board for a project.
 *
 * Server component: loads the project (org-access gated), the org's
 * configurable stages, and the project's deduped Match rows joined with the
 * current user's ShortlistEntry (favorite / stage / position). Candidates are
 * anonymized; if the user holds an active reveal lock we surface the revealed
 * name (same lookup pattern as the shortlist). Dragging a card across columns
 * persists via the `moveCandidate` server action.
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { ShortlistStage } from '@prisma/client';

import { requireUser } from '@/lib/auth-helpers';
import { prisma } from '@/lib/db';
import { getOrCreateUserOrg, userCanAccessProject } from '@/lib/org';
import { getOrCreateStages, resolveEntryStageId } from '@/lib/pipeline';
import { decrypt } from '@/lib/crypto';
import type { AnonymizedTalent, RevealedTalent } from '@/lib/anonymize/types';
import { displaySkillName } from '@/lib/anonymize/talent';
import { dedupAcrossPools, type ShortlistMatchRow } from '@/lib/match/hydrate';
import { MATCH_LONGLIST_ORDER_BY } from '@/lib/match/longlist-order';
import { ingestApplicationsOnOpen } from '@/lib/applications/ingest';

import { PipelineBoard, type BoardColumn, type BoardCard } from '@/components/pipeline/pipeline-board';
import { moveCandidate } from './actions';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function PipelinePage({ params }: PageProps): Promise<React.ReactElement> {
  const { id } = await params;
  const session = await requireUser();
  const t = await getTranslations('pipeline');
  const ts = await getTranslations('shortlist');

  const project = await prisma.project.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      title: true,
      locationCity: true,
      locationCountry: true,
      status: true,
    },
  });
  if (!project) notFound();
  if (!(await userCanAccessProject(session.id, project))) notFound();

  // CLOSED ("afgerond"): hide the board cards (no PII / anon detail). Bounce to
  // the shortlist's closed-state notice — matches stay in the DB for reopen.
  if (project.status === 'CLOSED') {
    redirect(`/app/projects/${id}/shortlist`);
  }

  // On-demand inbound-applications ingest (throttled, fire-and-forget): pulls
  // new own-pool applicants into the pipeline when the recruiter opens the
  // board. Never blocks/breaks the render; CLOSED projects already returned.
  ingestApplicationsOnOpen(id);

  // The org's configurable stages (seeded on first use).
  const orgId = await getOrCreateUserOrg(session.id);
  const stages = await getOrCreateStages(orgId);

  // Org-wide guard: confirm a candidate's stage change before committing it.
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { confirmStageMoves: true },
  });
  const confirmMoves = org?.confirmStageMoves ?? true;

  // Over-fetch + dedup the same way the shortlist does, so the board shows the
  // same distinct candidate set.
  const rawMatches = await prisma.match.findMany({
    where: { projectId: id },
    // Deterministic order (score desc + id tiebreaker) so the board shows the
    // same distinct candidate set — and same order — across reloads.
    orderBy: MATCH_LONGLIST_ORDER_BY,
    take: 100,
    include: { tenant: { select: { slug: true, name: true } } },
  });
  const deduped = dedupAcrossPools(
    rawMatches.map(
      (m): ShortlistMatchRow => ({
        id: m.id,
        eightvanceTalentId: m.eightvanceTalentId,
        score: m.score,
        tenantSlug: m.tenant.slug,
        payload: m.anonymizedPayloadJson as unknown as AnonymizedTalent,
      }),
    ),
  ).slice(0, 25);
  const matchById = new Map(rawMatches.map((m) => [m.id, m]));
  const matches = deduped.map((d) => ({ row: matchById.get(d.id)!, payload: d.payload }));

  // Revealed names (active locks) — same pattern as the shortlist page.
  const activeReveals = await prisma.reveal.findMany({
    where: {
      userId: session.id,
      expiresAt: { gt: new Date() },
      eightvanceTalentId: { in: matches.map((m) => m.row.eightvanceTalentId) },
    },
    select: { eightvanceTalentId: true, tenantId: true, piiPayloadEnc: true },
  });
  const revealedNameByKey = new Map<string, string>();
  for (const r of activeReveals) {
    try {
      const pii = JSON.parse(decrypt(r.piiPayloadEnc)) as RevealedTalent;
      const name = [pii.first_name, pii.last_name]
        .map((s) => (s ?? '').trim())
        .filter(Boolean)
        .join(' ');
      // talentId-only key (8vance ids are global) — see shortlist/page.tsx: the
      // cross-pool-deduped survivor may be a different tenant than the reveal.
      if (name) revealedNameByKey.set(String(r.eightvanceTalentId), name);
    } catch {
      /* skip undecryptable */
    }
  }

  // Per-user pipeline state for the visible matches.
  const entries = await prisma.shortlistEntry.findMany({
    where: { userId: session.id, matchId: { in: matches.map((m) => m.row.id) } },
    select: { matchId: true, favorite: true, stage: true, stageId: true, position: true, appliedAt: true },
  });
  const entryByMatch = new Map(entries.map((e) => [e.matchId, e]));

  // Build cards, resolving each entry to a (possibly legacy-mapped) stage id.
  const cards: BoardCard[] = matches.map(({ row: m, payload }) => {
    const entry = entryByMatch.get(m.id);
    const stageId =
      resolveEntryStageId(
        stages,
        entry?.stageId ?? null,
        entry?.stage ?? ShortlistStage.NEW,
      ) ?? (stages[0]?.id ?? '');
    // READ-TIME skill sanitizer: stale stored payloads can carry a raw
    // `skill_<id>` name; map to the localized generic label for the card chips.
    const skillUnknownLabel = ts('skillUnknown');
    const topSkills = payload.skills
      .filter((s) => !s.gap)
      .slice(0, 4)
      .map((s) => ({ name: displaySkillName(s.name, skillUnknownLabel), mustHave: s.must_have_match }));
    const location =
      [payload.location.province, payload.location.country]
        .map((s) => (s ?? '').trim())
        .filter((s) => s && s.toLowerCase() !== 'unknown')
        .join(', ') || null;
    return {
      matchId: m.id,
      opaqueId: m.opaqueId,
      score: m.score,
      stageId,
      position: entry?.position ?? 0,
      favorite: entry?.favorite ?? false,
      applied: Boolean(entry?.appliedAt),
      revealedName:
        revealedNameByKey.get(String(m.eightvanceTalentId)) ?? null,
      tenantSlug: m.tenant.slug,
      location,
      yearsBucket: payload.total_years_experience_bucket,
      topSkills,
    };
  });

  const columns: BoardColumn[] = stages.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    isTerminal: s.isTerminal,
  }));

  return (
    <main className="ft-board-page mx-auto flex h-[calc(100vh-1px)] max-w-[1600px] flex-col px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--ft-border)] pb-5">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-[var(--ft-ink)]">
            {project.title}
          </h1>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-[var(--ft-muted)]">
            <span aria-hidden="true" className="text-[var(--ft-border-strong)]">◍</span>
            {[project.locationCity, project.locationCountry].filter(Boolean).join(', ')}
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Link
            href={`/app/projects/${project.id}/shortlist`}
            className="rounded-lg border border-[var(--ft-border)] bg-[var(--ft-surface)] px-3 py-1.5 font-medium text-[var(--ft-ink)] transition hover:border-[var(--ft-border-strong)] hover:bg-[var(--ft-surface-2)]"
          >
            {t('shortlistView')}
          </Link>
          <Link
            href="/app/settings/pipeline"
            className="rounded-lg px-3 py-1.5 font-medium text-[var(--ft-muted)] transition hover:bg-[var(--ft-surface-2)] hover:text-[var(--ft-ink)]"
          >
            {t('configureStages')}
          </Link>
        </div>
      </header>

      {columns.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface)] p-8 text-center text-sm text-[var(--ft-muted)]">
          {t('noStages')}
        </div>
      ) : (
        <PipelineBoard
          projectId={project.id}
          columns={columns}
          cards={cards}
          moveAction={moveCandidate}
          confirmMoves={confirmMoves}
        />
      )}
    </main>
  );
}
