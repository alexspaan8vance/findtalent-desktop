/**
 * Project shortlist page.
 *
 * Triggers a best-effort hydration of the match-task results into the
 * Match cache, then renders the anonymized candidate cards (max 25 per
 * page, sorted by score desc). Each match carries a `tenant` badge so
 * the user knows which pool the candidate came from.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { ShortlistStage } from '@prisma/client';

import { requireUser } from '@/lib/auth-helpers';
import { prisma } from '@/lib/db';
import { getOrCreateUserOrg, userCanAccessProject } from '@/lib/org';
import { getOrCreateStages, resolveEntryStageId } from '@/lib/pipeline';
import { decrypt } from '@/lib/crypto';
import type { AnonymizedTalent, RevealedTalent } from '@/lib/anonymize/types';
import { displaySkillName, isGenericSkillName } from '@/lib/anonymize/talent';

import { dedupAcrossPools, type ShortlistMatchRow } from '@/lib/match/hydrate';
import { MATCH_LONGLIST_ORDER_BY } from '@/lib/match/longlist-order';
import { ingestApplicationsOnOpen } from '@/lib/applications/ingest';

import {
  archiveProject,
  rerunMatch,
  unarchiveProject,
  closeProject,
  reopenProject,
} from '../actions';

import { ShortlistGrid } from './shortlist-grid';
import { SavedSearchSection } from './saved-search-section';
import { MatchPoller } from './match-poller';
import { ProjectActions } from './project-actions';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Window used when `highlight=new` is present without a parseable `since`:
 *  treat any candidate that landed in the last 30 min as "new". */
const HIGHLIGHT_FALLBACK_MS = 30 * 60 * 1000;

/** A `new_matches` notification is created RIGHT AFTER its run inserts the
 *  matches, so the notification's timestamp (`since`) is a hair LATER than those
 *  matches' `fetchedAt`. Comparing `fetchedAt > since` would then exclude the very
 *  candidates the notification is about. Backdate the threshold by this window so
 *  the triggering run's batch (a run completes well within it) is highlighted. */
const HIGHLIGHT_SINCE_BACKDATE_MS = 10 * 60 * 1000;

/**
 * Resolve the "new since" highlight threshold at request time: the parsed
 * `since` param (backdated, see above) when valid, else the recent fallback
 * window. Module helper (not in the component body) so render stays pure.
 */
function resolveHighlightThreshold(sinceRaw: string | undefined): number {
  const parsed = sinceRaw ? Date.parse(sinceRaw) : NaN;
  return Number.isFinite(parsed)
    ? parsed - HIGHLIGHT_SINCE_BACKDATE_MS
    : Date.now() - HIGHLIGHT_FALLBACK_MS;
}

export default async function ShortlistPage({
  params,
  searchParams,
}: PageProps): Promise<React.ReactElement> {
  const { id } = await params;
  const sp = await searchParams;
  const session = await requireUser();
  const t = await getTranslations('shortlist');

  const project = await prisma.project.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      title: true,
      status: true,
      locationCity: true,
      locationCountry: true,
    },
  });
  if (!project) notFound();
  if (!(await userCanAccessProject(session.id, project))) notFound();

  // CLOSED ("afgerond"): hide the shortlist + suppress the match poller (no
  // re-match on a closed project). Matches stay in the DB — reopening restores
  // them. We render a calm state with the Reopen affordance instead of the grid.
  if (project.status === 'CLOSED') {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
              {project.title}
            </h1>
            <p className="mt-1 text-sm text-zinc-600">
              {project.locationCity}, {project.locationCountry}
            </p>
          </div>
          <div className="flex flex-col items-end gap-3 text-sm">
            <Link href="/app/projects" className="text-zinc-600 hover:text-zinc-900">
              {t('allProjects')}
            </Link>
            <ProjectActions
              projectId={project.id}
              isArchived={false}
              isClosed
              rerun={rerunMatch}
              archive={archiveProject}
              unarchive={unarchiveProject}
              close={closeProject}
              reopen={reopenProject}
            />
          </div>
        </header>
        <div className="mt-10 rounded-2xl border border-zinc-200 bg-zinc-50 p-8 text-center">
          <div className="text-sm font-medium text-zinc-700">{t('closedTitle')}</div>
          <p className="mt-1 text-xs text-zinc-500">{t('closedBody')}</p>
        </div>
      </main>
    );
  }

  // On-demand inbound-applications ingest (throttled, fire-and-forget): pulls
  // any new own-pool applicants into the pipeline when the recruiter opens the
  // shortlist. Never blocks/breaks the render; CLOSED projects already returned.
  ingestApplicationsOnOpen(id);

  // Derive status from cached pool state — never run the (possibly slow)
  // hydrate on the render path. A client poller drives hydration via the
  // /hydrate API and refreshes the route when matches land.
  const pools = await prisma.projectPool.findMany({
    where: { projectId: id },
    select: { status: true, eightvanceTaskId: true },
  });
  // Fetch a wider window (score-desc), collapse the same underlying talent
  // across pools to its single best-score card, then keep up to SHORTLIST_CAP.
  // The client-side filters/preferences in <ShortlistGrid> only ever see the
  // rows we hand them, so we deliberately keep a generous (but bounded) window
  // of deduped talents instead of the old 25 — wide enough for filtering to be
  // useful, capped so we never stream thousands of cards to the browser. We
  // over-fetch (300 raw) so cross-pool duplicates don't push distinct talents
  // out of the post-dedup window.
  const SHORTLIST_CAP = 100;
  const rawMatches = await prisma.match.findMany({
    where: { projectId: id },
    // Deterministic order (score desc + id tiebreaker): without it, equal-score
    // rows reshuffle between loads AND the take(300) window can admit a
    // different set at the score boundary, changing the deduped shortlist.
    orderBy: MATCH_LONGLIST_ORDER_BY,
    take: 300,
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
  ).slice(0, SHORTLIST_CAP);
  // Re-join the surviving (deduped) rows to their full Prisma record, keeping
  // the dedup-merged payload (which carries source_pools when multi-pool).
  const matchById = new Map(rawMatches.map((m) => [m.id, m]));
  const matches = deduped.map((d) => ({
    row: matchById.get(d.id)!,
    payload: d.payload,
  }));

  const poolStatuses = pools.map((p) => p.status);
  // "Actively matching" = MATCHING, OR DRAFT that has a kicked-off task. A
  // DRAFT pool with NO eightvanceTaskId never started (sync crashed before
  // assigning one) — counting it as matching froze the poller forever (the
  // /status route already treats taskless-DRAFT as settled, so the poller
  // stopped while this page showed the progress panel indefinitely). Mirror
  // /status: taskless-DRAFT is NOT matching.
  const anyMatching = pools.some(
    (p) => p.status === 'MATCHING' || (p.status === 'DRAFT' && p.eightvanceTaskId != null),
  );
  const anyReady = poolStatuses.includes('READY');
  const allFailed = poolStatuses.length > 0 && poolStatuses.every((s) => s === 'FAILED');
  const hydrateStatus: 'matching' | 'ready' | 'partial' | 'failed' = anyMatching
    ? 'matching'
    : allFailed
      ? 'failed'
      : anyReady && poolStatuses.includes('FAILED')
        ? 'partial'
        : 'ready';

  // Candidates the current user has already revealed (active 14-day lock) are
  // surfaced de-anonymized and pinned to the top of the list.
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
      // Key by talentId ALONE (8vance ids are global = one person). The shortlist
      // dedups the same person across pools to one card whose surviving row may
      // be a DIFFERENT pool/tenant than the one the reveal was paid under — so a
      // tenant-scoped key would drop the name off the merged card. talentId alone
      // de-anonymizes that person's card regardless of which pool survived.
      if (name) revealedNameByKey.set(String(r.eightvanceTalentId), name);
    } catch {
      /* skip undecryptable */
    }
  }

  // Load this user's pipeline state for the visible matches in one query.
  // Absence of a row = default (not favorite, NEW, no note).
  const entries = await prisma.shortlistEntry.findMany({
    where: { userId: session.id, matchId: { in: matches.map((m) => m.row.id) } },
    select: { matchId: true, favorite: true, stage: true, stageId: true, note: true, appliedAt: true },
  });
  const entryByMatch = new Map(entries.map((e) => [e.matchId, e]));

  // The org's configurable stages drive the board + the stage filter/selector.
  const orgId = await getOrCreateUserOrg(session.id);
  const stages = await getOrCreateStages(orgId);

  // READ-TIME skill-name sanitizer. The stored payload's `skills[].name` is
  // normally clean (anonymize() strips raw `skill_<id>`), but OLD rows persisted
  // before that fix (or a preserve-on-fail re-match) can still carry a raw
  // `skill_<id>`. A nameless skill (blank / raw id / the baked-in generic
  // "Vaardigheid" label) carries no information, so it is DROPPED here rather
  // than rendered as a literal "Vaardigheid" chip — one spot that covers the
  // card chips, the pref-score, the filters and the match-breakdown, since
  // they all read these same passed rows.
  const skillUnknownLabel = t('skillUnknown');
  const sanitizePayloadSkills = (payload: AnonymizedTalent): AnonymizedTalent => {
    if (!Array.isArray(payload.skills) || payload.skills.length === 0) return payload;
    let changed = false;
    const skills: typeof payload.skills = [];
    for (const s of payload.skills) {
      const clean = displaySkillName(s.name, skillUnknownLabel);
      if (isGenericSkillName(clean, skillUnknownLabel)) {
        changed = true; // hide the uninformative chip entirely
        continue;
      }
      if (clean === s.name) skills.push(s);
      else {
        changed = true;
        skills.push({ ...s, name: clean });
      }
    }
    return changed ? { ...payload, skills } : payload;
  };

  // "Highlight new matches" — when the user arrives via a notification link
  // (`?highlight=new&since=<iso>`), flag every candidate that landed AFTER the
  // notification was created so the grid can badge them. We derive this purely
  // from the existing `fetchedAt` column (no schema change, no PII): a card is
  // "new" iff its insert time is newer than the `since` threshold. With
  // `highlight=new` but no/garbled `since`, fall back to a recent-window so the
  // feature still works for older notifications.
  const wantHighlight =
    (Array.isArray(sp.highlight) ? sp.highlight[0] : sp.highlight) === 'new';
  let highlightThreshold: number | null = null;
  if (wantHighlight) {
    const sinceRaw = Array.isArray(sp.since) ? sp.since[0] : sp.since;
    highlightThreshold = resolveHighlightThreshold(sinceRaw);
  }

  const rows = matches.map(({ row: m, payload }) => {
    const entry = entryByMatch.get(m.id);
    return {
      id: m.id,
      opaqueId: m.opaqueId,
      score: m.score,
      payload: sanitizePayloadSkills(payload),
      tenantSlug: m.tenant.slug,
      tenantName: m.tenant.name,
      // ISO timestamp of when this match landed in the cache — drives the
      // "most recent" sort in the grid.
      fetchedAt: m.fetchedAt.toISOString(),
      // True when this card arrived after the notification's timestamp — the
      // grid renders a "Nieuw" badge on these. Computed server-side from
      // fetchedAt vs the threshold; purely a visual marker (anonymity-safe).
      isNew: highlightThreshold !== null && m.fetchedAt.getTime() > highlightThreshold,
      revealedName: revealedNameByKey.get(String(m.eightvanceTalentId)) ?? null,
      // True when this candidate self-applied to our published job (inbound
      // application) — drives the "Gesolliciteerd" badge on the card.
      applied: Boolean(entry?.appliedAt),
      favorite: entry?.favorite ?? false,
      stage: entry?.stage ?? ShortlistStage.NEW,
      stageId:
        resolveEntryStageId(stages, entry?.stageId ?? null, entry?.stage ?? ShortlistStage.NEW) ??
        (stages[0]?.id ?? null),
      note: entry?.note ?? '',
    };
  });

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
            {project.title}
          </h1>
          <p className="mt-1 text-sm text-zinc-600">
            {project.locationCity}, {project.locationCountry}
          </p>
        </div>
        <div className="flex flex-col items-end gap-3 text-sm">
          <div className="flex items-center gap-3">
            <Link
              href={`/app/projects/${project.id}/pipeline`}
              className="rounded-lg border border-[var(--ft-border)] bg-white px-3 py-1.5 font-medium text-zinc-700 transition hover:border-[var(--ft-border-strong)]"
            >
              {t('pipelineView')}
            </Link>
            <Link
              href="/app/projects"
              className="text-zinc-600 hover:text-zinc-900"
            >
              {t('allProjects')}
            </Link>
          </div>
          <ProjectActions
            projectId={project.id}
            isArchived={project.status === 'ARCHIVED'}
            isClosed={false}
            rerun={rerunMatch}
            archive={archiveProject}
            unarchive={unarchiveProject}
            close={closeProject}
            reopen={reopenProject}
          />
        </div>
      </header>

      {/*
        While matching we always show the live progress panel (the poller owns
        the determinate bar, the "found N" count and the elapsed timer). When
        partial matches have already landed (rows > 0) the grid below renders
        them too, so results stream in above/with the progress panel instead of
        hiding every candidate until the pools fully settle. The
        `shortlist-matching` testid is kept on the wrapper for e2e.
      */}
      {hydrateStatus === 'matching' && (
        <div data-testid="shortlist-matching">
          <MatchPoller projectId={project.id} hasRows={rows.length > 0} />
        </div>
      )}

      {hydrateStatus === 'failed' && (
        <div className="mt-10 rounded-2xl border border-red-200 bg-red-50 p-8 text-center">
          <div className="text-sm font-medium text-red-700">{t('failedTitle')}</div>
          <p className="mt-1 text-xs text-red-600">{t('failedBody')}</p>
        </div>
      )}

      {hydrateStatus === 'partial' && (
        <div className="mt-10 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-center text-xs text-amber-800">
          {t('partialBanner')}
        </div>
      )}

      {(hydrateStatus === 'ready' || hydrateStatus === 'partial') &&
        rows.length === 0 && (
          <div
            data-testid="shortlist-empty"
            className="mt-10 rounded-2xl border border-zinc-200 bg-zinc-50 p-8 text-center"
          >
            <div className="text-sm font-medium text-zinc-700">
              {t('emptyTitle')}
            </div>
            <p className="mt-1 text-xs text-zinc-500">{t('emptyBody')}</p>
          </div>
        )}

      <SavedSearchSection projectId={project.id} userId={session.id} />

      <ShortlistGrid
        projectId={project.id}
        rows={rows}
        stages={stages.map((s) => ({ id: s.id, name: s.name, color: s.color }))}
      />
    </main>
  );
}
