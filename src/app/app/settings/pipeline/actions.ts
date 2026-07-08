'use server';

/**
 * Pipeline-stage CRUD (per organization). Any authed org member may manage the
 * board template (org-scoped via `getOrCreateUserOrg`). Guards:
 *  - removing the last remaining stage is blocked;
 *  - on remove, entries on that stage are reassigned to the first stage
 *    (by position) so no candidate is orphaned;
 *  - all writes verify the target stage belongs to the acting user's org.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { OrgRole } from '@prisma/client';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { getOrCreateUserOrg } from '@/lib/org';
import { getOrCreateStages } from '@/lib/pipeline';

export type StageActionResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'invalid' | 'not_found' | 'last_stage' | 'internal' | 'not_owner';
    };

const nameSchema = z.string().trim().min(1).max(60);
const colorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'hex color');

/** Assert a stage id belongs to the user's org; returns the orgId or null. */
async function ownedStageOrg(stageId: string, orgId: string): Promise<boolean> {
  if (typeof stageId !== 'string' || stageId.length === 0) return false;
  const stage = await prisma.pipelineStage.findFirst({
    where: { id: stageId, organizationId: orgId },
    select: { id: true },
  });
  return Boolean(stage);
}

/**
 * Toggle the org-wide "confirm before moving a candidate to another stage"
 * guard. Owner-only — it changes behaviour for the whole team (and matters
 * once stage-change automations are attached). Idempotent.
 */
export async function setConfirmStageMoves(formData: FormData): Promise<StageActionResult> {
  const session = await requireUser();
  const orgId = await getOrCreateUserOrg(session.id);

  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId: session.id } },
    select: { role: true },
  });
  if (!membership || membership.role !== OrgRole.OWNER) {
    return { ok: false, reason: 'not_owner' };
  }

  const enabled = String(formData.get('enabled') ?? '') === 'on';
  try {
    await prisma.organization.update({
      where: { id: orgId },
      data: { confirmStageMoves: enabled },
    });
    revalidatePath('/app/settings/pipeline');
    return { ok: true };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}

export async function addStage(formData: FormData): Promise<StageActionResult> {
  const session = await requireUser();
  const orgId = await getOrCreateUserOrg(session.id);

  const parsedName = nameSchema.safeParse(formData.get('name'));
  if (!parsedName.success) return { ok: false, reason: 'invalid' };
  const rawColor = String(formData.get('color') ?? '#1f6f5c');
  const color = colorSchema.safeParse(rawColor).success ? rawColor : '#1f6f5c';
  const isTerminal = String(formData.get('isTerminal') ?? '') === 'on';

  try {
    await getOrCreateStages(orgId);
    const agg = await prisma.pipelineStage.aggregate({
      where: { organizationId: orgId },
      _max: { position: true },
    });
    const nextPos = (agg._max.position ?? -1) + 1;
    await prisma.pipelineStage.create({
      data: {
        organizationId: orgId,
        name: parsedName.data,
        color,
        isTerminal,
        position: nextPos,
      },
    });
    revalidatePath('/app/settings/pipeline');
    return { ok: true };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}

export async function updateStage(formData: FormData): Promise<StageActionResult> {
  const session = await requireUser();
  const orgId = await getOrCreateUserOrg(session.id);

  const stageId = String(formData.get('stageId') ?? '');
  if (!(await ownedStageOrg(stageId, orgId))) return { ok: false, reason: 'not_found' };

  const parsedName = nameSchema.safeParse(formData.get('name'));
  if (!parsedName.success) return { ok: false, reason: 'invalid' };
  const rawColor = String(formData.get('color') ?? '');
  const color = colorSchema.safeParse(rawColor).success ? rawColor : undefined;
  const isTerminal = String(formData.get('isTerminal') ?? '') === 'on';

  try {
    await prisma.pipelineStage.update({
      where: { id: stageId },
      data: {
        name: parsedName.data,
        isTerminal,
        ...(color ? { color } : {}),
      },
    });
    revalidatePath('/app/settings/pipeline');
    return { ok: true };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}

/** Move a stage one slot up (-1) or down (+1) by swapping positions. */
export async function moveStage(formData: FormData): Promise<StageActionResult> {
  const session = await requireUser();
  const orgId = await getOrCreateUserOrg(session.id);

  const stageId = String(formData.get('stageId') ?? '');
  const dir = String(formData.get('direction') ?? '');
  if (dir !== 'up' && dir !== 'down') return { ok: false, reason: 'invalid' };
  if (!(await ownedStageOrg(stageId, orgId))) return { ok: false, reason: 'not_found' };

  try {
    const stages = await prisma.pipelineStage.findMany({
      where: { organizationId: orgId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, position: true },
    });
    const idx = stages.findIndex((s) => s.id === stageId);
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
    if (idx < 0 || swapIdx < 0 || swapIdx >= stages.length) {
      return { ok: true }; // already at an edge — no-op
    }
    const a = stages[idx];
    const b = stages[swapIdx];
    // Normalize positions to the array order to avoid duplicate-position drift,
    // then swap the two affected slots.
    const order = stages.map((s) => s.id);
    [order[idx], order[swapIdx]] = [order[swapIdx], order[idx]];
    await prisma.$transaction(
      order.map((sid, i) =>
        prisma.pipelineStage.update({ where: { id: sid }, data: { position: i } }),
      ),
    );
    void a;
    void b;
    revalidatePath('/app/settings/pipeline');
    return { ok: true };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}

export async function removeStage(formData: FormData): Promise<StageActionResult> {
  const session = await requireUser();
  const orgId = await getOrCreateUserOrg(session.id);

  const stageId = String(formData.get('stageId') ?? '');
  if (!(await ownedStageOrg(stageId, orgId))) return { ok: false, reason: 'not_found' };

  try {
    const stages = await prisma.pipelineStage.findMany({
      where: { organizationId: orgId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    if (stages.length <= 1) return { ok: false, reason: 'last_stage' };

    // Reassign any entries on the removed stage to the first remaining stage.
    const firstRemaining = stages.find((s) => s.id !== stageId)!;

    await prisma.$transaction(async (tx) => {
      await tx.shortlistEntry.updateMany({
        where: { stageId },
        data: { stageId: firstRemaining.id },
      });
      await tx.pipelineStage.delete({ where: { id: stageId } });
      // Re-normalize positions so they stay 0..n-1 contiguous.
      const remaining = await tx.pipelineStage.findMany({
        where: { organizationId: orgId },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: { id: true },
      });
      for (let i = 0; i < remaining.length; i++) {
        await tx.pipelineStage.update({
          where: { id: remaining[i].id },
          data: { position: i },
        });
      }
    });
    revalidatePath('/app/settings/pipeline');
    return { ok: true };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}
