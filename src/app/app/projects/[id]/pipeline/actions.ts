'use server';

/**
 * Kanban-board server actions: move a candidate to a stage / position.
 *
 * Authed via `requireUser`; every write re-verifies that the target Match
 * belongs to a project the user can access (org-scoped) AND that the target
 * stage belongs to the user's own org — so a candidate can never be dropped
 * into another team's column. Pipeline state lives in `ShortlistEntry`
 * (per-user, unique on (userId, matchId)); a drop sets both `stageId` and
 * `position` for manual within-column ordering.
 */

import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth-helpers';
import { prisma } from '@/lib/db';
import { getOrCreateUserOrg, userCanAccessProject } from '@/lib/org';
import { getOrgStages, isPostRevealStage } from '@/lib/pipeline';

export type MoveResult =
  | { ok: true; matchId: string; stageId: string; position: number }
  | { ok: false; reason: 'not_found' | 'invalid' | 'reveal_required' | 'internal' };

/**
 * Resolve the Match and assert the user can access its project. Returns the
 * match id plus the talent/tenant identity needed to check reveal status.
 */
async function assertOwnedMatch(
  matchId: string,
  userId: string,
): Promise<{ id: string; eightvanceTalentId: number; tenantId: string } | null> {
  if (typeof matchId !== 'string' || matchId.length === 0) return null;
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      eightvanceTalentId: true,
      tenantId: true,
      project: { select: { userId: true, organizationId: true } },
    },
  });
  if (!match || !(await userCanAccessProject(userId, match.project))) return null;
  return {
    id: match.id,
    eightvanceTalentId: match.eightvanceTalentId,
    tenantId: match.tenantId,
  };
}

/**
 * Whether the acting user currently holds an active reveal lock for the given
 * talent/tenant — derived the same way the pipeline page surfaces the revealed
 * name (an unexpired `Reveal` row). Authoritative reveal-gate input.
 */
async function hasActiveReveal(
  userId: string,
  eightvanceTalentId: number,
  tenantId: string,
): Promise<boolean> {
  const reveal = await prisma.reveal.findFirst({
    where: {
      userId,
      eightvanceTalentId,
      tenantId,
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  return reveal != null;
}

/**
 * Move `matchId` into `stageId` at `position`. Upserts the per-user
 * ShortlistEntry. The stage must belong to the acting user's org.
 */
export async function moveCandidate(
  matchId: string,
  stageId: string,
  position: number,
): Promise<MoveResult> {
  const session = await requireUser();

  if (typeof stageId !== 'string' || stageId.length === 0) {
    return { ok: false, reason: 'invalid' };
  }
  const pos = Number.isFinite(position) && position >= 0 ? Math.floor(position) : 0;

  const owned = await assertOwnedMatch(matchId, session.id);
  if (!owned) return { ok: false, reason: 'not_found' };

  // The target stage must belong to the acting user's org.
  const orgId = await getOrCreateUserOrg(session.id);
  const stages = await getOrgStages(orgId);
  const stage = stages.find((s) => s.id === stageId);
  if (!stage) return { ok: false, reason: 'invalid' };

  // Reveal-gate (authoritative): a candidate whose name has not been revealed
  // may never be moved past the shortlist boundary. Only check reveal status
  // for post-reveal target stages so pre-reveal moves stay a single query.
  if (isPostRevealStage(stages, stage.id)) {
    const revealed = await hasActiveReveal(
      session.id,
      owned.eightvanceTalentId,
      owned.tenantId,
    );
    if (!revealed) return { ok: false, reason: 'reveal_required' };
  }

  try {
    const entry = await prisma.shortlistEntry.upsert({
      where: { userId_matchId: { userId: session.id, matchId: owned.id } },
      create: {
        userId: session.id,
        matchId: owned.id,
        stageId: stage.id,
        position: pos,
      },
      update: { stageId: stage.id, position: pos },
      select: { stageId: true, position: true },
    });
    revalidatePath('/app/projects/[id]/pipeline', 'page');
    return {
      ok: true,
      matchId: owned.id,
      stageId: entry.stageId ?? stage.id,
      position: entry.position,
    };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}
