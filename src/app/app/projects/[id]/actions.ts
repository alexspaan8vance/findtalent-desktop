'use server';

/**
 * Project-level server actions: archive / unarchive a project and re-run its
 * match. All three are authed via `requireUser` and org-guarded — the acting
 * user must own the project directly OR share its organization (see
 * `userCanAccessProject`). Mirrors the guard pattern in
 * `pipeline/actions.ts` + `saved-search/actions.ts`.
 */

import { revalidatePath } from 'next/cache';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { userCanAccessProject } from '@/lib/org';
import {
  MatchPreconditionError,
  syncProjectToVance,
} from '@/lib/eightvance/job-sync';
import { TenantNotConfiguredError } from '@/lib/eightvance/tenant-client';
import { VanceError } from '@/lib/eightvance/errors';
import { getAllowedTenantIds } from '@/lib/tenant-access';
import { createProjectSchema } from '../new/schema';

export type ProjectActionResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'precondition' | 'unavailable' | 'internal'; message?: string };

/** Resolve a project the acting user can access, or null. */
async function loadOwnedProject(
  projectId: string,
  userId: string,
): Promise<{ id: string; lastMatchedAt: Date | null } | null> {
  if (typeof projectId !== 'string' || projectId.length === 0) return null;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true, organizationId: true, lastMatchedAt: true },
  });
  if (!project || !(await userCanAccessProject(userId, project))) return null;
  return { id: project.id, lastMatchedAt: project.lastMatchedAt };
}

/** Set Project.status = ARCHIVED. Reversible, so no confirmation required. */
export async function archiveProject(projectId: string): Promise<ProjectActionResult> {
  const user = await requireUser();
  const project = await loadOwnedProject(projectId, user.id);
  if (!project) return { ok: false, reason: 'not_found' };

  try {
    await prisma.project.update({
      where: { id: project.id },
      data: { status: 'ARCHIVED' },
    });
  } catch {
    return { ok: false, reason: 'internal' };
  }

  revalidatePath('/app/projects');
  revalidatePath(`/app/projects/${project.id}/shortlist`);
  return { ok: true };
}

/**
 * Un-archive: restore the project to READY if it has matched before
 * (`lastMatchedAt` set), otherwise back to DRAFT.
 */
export async function unarchiveProject(projectId: string): Promise<ProjectActionResult> {
  const user = await requireUser();
  const project = await loadOwnedProject(projectId, user.id);
  if (!project) return { ok: false, reason: 'not_found' };

  try {
    await prisma.project.update({
      where: { id: project.id },
      data: { status: project.lastMatchedAt ? 'READY' : 'DRAFT' },
    });
  } catch {
    return { ok: false, reason: 'internal' };
  }

  revalidatePath('/app/projects');
  revalidatePath(`/app/projects/${project.id}/shortlist`);
  return { ok: true };
}

/**
 * Close ("afrond") a project. Distinct from ARCHIVE (which only hides the
 * project): closing also ENDS the project's reveals so the revealed talents are
 * released back to the pool (re-matchable elsewhere) and the shortlist/PII is
 * hidden at the render layer. Matches + Reveal history are PRESERVED so a reopen
 * restores the shortlist; the ended reveals stay ended (re-reveal costs a new
 * credit).
 *
 * Done in ONE transaction:
 *   1. Project.status → CLOSED.
 *   2. Expire every RevealLock linked to a Reveal on this project (expiresAt =
 *      now). `findActiveLock` treats an expired lock as dead, so the talent's
 *      tenant lock is released. We do NOT touch Reveal rows (no PII deletion, no
 *      ledger change) — only the locks gate access.
 */
export async function closeProject(projectId: string): Promise<ProjectActionResult> {
  const user = await requireUser();
  const project = await loadOwnedProject(projectId, user.id);
  if (!project) return { ok: false, reason: 'not_found' };

  try {
    const now = new Date();
    await prisma.$transaction([
      prisma.project.update({
        where: { id: project.id },
        data: { status: 'CLOSED' },
      }),
      prisma.revealLock.updateMany({
        where: { reveal: { projectId: project.id } },
        data: { expiresAt: now },
      }),
    ]);
  } catch {
    return { ok: false, reason: 'internal' };
  }

  revalidatePath('/app/projects');
  revalidatePath(`/app/projects/${project.id}/shortlist`);
  return { ok: true };
}

/**
 * Reopen a CLOSED project: restore status to READY if it has matched before
 * (`lastMatchedAt` set), otherwise back to DRAFT (mirrors `unarchiveProject`).
 * We do NOT un-expire reveals — they stay ended, so re-revealing a candidate
 * costs a fresh credit. Matches are still in the DB, so the shortlist returns.
 */
export async function reopenProject(projectId: string): Promise<ProjectActionResult> {
  const user = await requireUser();
  const project = await loadOwnedProject(projectId, user.id);
  if (!project) return { ok: false, reason: 'not_found' };

  try {
    await prisma.project.update({
      where: { id: project.id },
      data: { status: project.lastMatchedAt ? 'READY' : 'DRAFT' },
    });
  } catch {
    return { ok: false, reason: 'internal' };
  }

  revalidatePath('/app/projects');
  revalidatePath(`/app/projects/${project.id}/shortlist`);
  return { ok: true };
}

/**
 * Re-run the match for an existing project. Re-uses the SAME orchestration
 * the create / saved-search flow uses — `syncProjectToVance`
 * (src/lib/eightvance/job-sync.ts). Because every pool already carries an
 * `eightvanceJobId`, that function skips job creation and simply re-issues
 * `match.start` per pool, stamping a fresh `eightvanceTaskId` + setting each
 * pool (and the project) back to MATCHING. The existing shortlist
 * `MatchPoller` then drives `/hydrate` exactly as on first match.
 *
 * Stuck-MATCHING safety: `syncProjectToVance` resets every pool to MATCHING
 * (clearing any prior READY short-circuit in `runHydrate`) and rolls the
 * project up to FAILED when ALL pools fail — so the project is never left
 * MATCHING with no task to poll. We don't duplicate any match logic here.
 */
export async function rerunMatch(projectId: string): Promise<ProjectActionResult> {
  const user = await requireUser();
  const project = await loadOwnedProject(projectId, user.id);
  if (!project) return { ok: false, reason: 'not_found' };

  try {
    await syncProjectToVance(project.id);
  } catch (err) {
    if (err instanceof MatchPreconditionError) {
      return { ok: false, reason: 'precondition', message: err.message };
    }
    if (err instanceof TenantNotConfiguredError) {
      return { ok: false, reason: 'precondition', message: err.message };
    }
    if (err instanceof VanceError) {
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: false, reason: 'internal' };
  }

  revalidatePath('/app/projects');
  revalidatePath(`/app/projects/${project.id}/shortlist`);
  return { ok: true };
}

/**
 * Edit an existing project's criteria (title, function, level, location,
 * skills, languages, education, min-years) AND its talent pools, then re-run
 * the match.
 *
 * Validation reuses the create wizard's full `createProjectSchema` (incl.
 * `pools`) so the edit form and the create wizard stay in lock-step on field
 * rules — edit can now ADD/REMOVE pools (min 1).
 *
 * Pool diff (cross-pool matching): we compare the requested tenant ids against
 * the project's existing `ProjectPool` rows in one transaction:
 *   - ADDED tenant   → create a fresh ProjectPool with no eightvanceJobId/
 *                      TaskId, so `syncProjectToVance` CREATES the job in that
 *                      company + matches its source (the proven-safe path — no
 *                      8vance cross-company call; the job is duplicated into the
 *                      added company).
 *   - REMOVED tenant → delete that ProjectPool. `Match` has NO FK to
 *                      `ProjectPool` (it references Project + Tenant directly),
 *                      so deleting the pool does NOT cascade its matches — we
 *                      delete the Match rows for (project, removed tenant)
 *                      explicitly so the shortlist shows no orphaned cards.
 *   - KEPT tenant    → clear eightvanceJobId/TaskId (+ status→DRAFT) so the
 *                      next sync CREATES A FRESH job carrying the new criteria,
 *                      exactly as before.
 *
 * Why a fresh job for kept pools: `syncProjectToVance` REUSES an existing job id
 * (skipping job.create) and just re-issues the match — which would re-match the
 * STALE 8vance job built from the old criteria. Clearing `eightvanceJobId`
 * forces a fresh job, cleaner than PATCH-diffing the job's skill sub-resources.
 *
 * Min-years is not persisted (no schema column) — it's threaded straight into
 * this immediate sync, exactly like create.
 */
export async function updateProjectAction(
  projectId: string,
  input: unknown,
): Promise<ProjectActionResult> {
  const user = await requireUser();
  const project = await loadOwnedProject(projectId, user.id);
  if (!project) return { ok: false, reason: 'not_found' };

  // Full create schema (pools included) — edit may now change pool selection.
  const parsed = createProjectSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      reason: 'precondition',
      message: first?.message ?? 'Some fields look off — please review.',
    };
  }
  const data = parsed.data;

  // Dedupe + validate the requested pools: at least one, and every tenant must
  // exist (only tenants the deploy exposes). The DB existence check also keeps
  // a client from injecting an arbitrary tenant id.
  const requestedTenantIds = Array.from(new Set(data.pools));
  if (requestedTenantIds.length === 0) {
    return { ok: false, reason: 'precondition', message: 'Select at least one talent pool.' };
  }
  const tenants = await prisma.tenant.findMany({
    where: { id: { in: requestedTenantIds } },
    select: { id: true },
  });
  if (tenants.length !== requestedTenantIds.length) {
    return { ok: false, reason: 'precondition', message: 'One of the selected pools no longer exists.' };
  }

  // IDOR guard: existence is not authorization. Reject any requested pool the
  // acting user/org may not target (would otherwise drive an arbitrary tenant's
  // 8vance creds). Same org-ownership scope as the candidate pool routes. Note:
  // we only authorize the REQUESTED set; REMOVED tenants need no check (the diff
  // below just deletes their pool rows).
  const allowedTenantIds = await getAllowedTenantIds(user.id, user.role);
  if (requestedTenantIds.some((id) => !allowedTenantIds.has(id))) {
    return { ok: false, reason: 'precondition', message: 'One of the selected pools is not available to you.' };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: project.id },
        data: {
          title: data.title,
          functionNameId: data.functionNameId,
          functionNameLabel: data.functionNameLabel,
          functionLevel: data.functionLevel,
          locationCity: data.locationCity,
          locationCountry: data.locationCountry,
          locationProvince: data.locationProvince ?? null,
          locationLat: data.locationLat ?? null,
          locationLng: data.locationLng ?? null,
          skillsJson: data.skills,
          languagesJson: data.languages,
          educationLevel: data.educationLevel ?? null,
          status: 'DRAFT',
        },
      });

      // ---- Pool diff: existing vs requested tenant ids ----
      const existingPools = await tx.projectPool.findMany({
        where: { projectId: project.id },
        select: { id: true, tenantId: true },
      });
      const existingTenantIds = new Set(existingPools.map((p) => p.tenantId));
      const requestedSet = new Set(requestedTenantIds);

      const addedTenantIds = requestedTenantIds.filter(
        (id) => !existingTenantIds.has(id),
      );
      const removedTenantIds = [...existingTenantIds].filter(
        (id) => !requestedSet.has(id),
      );

      // ADDED → fresh pool, no job ids → sync creates the job in that company.
      if (addedTenantIds.length > 0) {
        await tx.projectPool.createMany({
          data: addedTenantIds.map((tenantId) => ({
            projectId: project.id,
            tenantId,
            status: 'DRAFT' as const,
          })),
        });
      }

      // REMOVED → drop the pool AND its matches (Match has no FK to
      // ProjectPool, so no cascade does this for us).
      if (removedTenantIds.length > 0) {
        await tx.match.deleteMany({
          where: { projectId: project.id, tenantId: { in: removedTenantIds } },
        });
        await tx.projectPool.deleteMany({
          where: { projectId: project.id, tenantId: { in: removedTenantIds } },
        });
      }

      // KEPT → force a fresh 8vance job on the next sync (see doc comment).
      const keptTenantIds = requestedTenantIds.filter((id) =>
        existingTenantIds.has(id),
      );
      if (keptTenantIds.length > 0) {
        await tx.projectPool.updateMany({
          where: { projectId: project.id, tenantId: { in: keptTenantIds } },
          data: {
            eightvanceJobId: null,
            eightvanceTaskId: null,
            status: 'DRAFT',
          },
        });
      }
    });
  } catch {
    return { ok: false, reason: 'internal' };
  }

  try {
    await syncProjectToVance(project.id, {
      minYearsExperience: data.minYearsExperience || undefined,
    });
  } catch (err) {
    await prisma.project
      .update({ where: { id: project.id }, data: { status: 'FAILED' } })
      .catch(() => {});
    if (err instanceof MatchPreconditionError) {
      return { ok: false, reason: 'precondition', message: err.message };
    }
    if (err instanceof TenantNotConfiguredError) {
      return { ok: false, reason: 'precondition', message: err.message };
    }
    if (err instanceof VanceError) {
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: false, reason: 'internal' };
  }

  revalidatePath('/app/projects');
  revalidatePath(`/app/projects/${project.id}/shortlist`);
  return { ok: true };
}
