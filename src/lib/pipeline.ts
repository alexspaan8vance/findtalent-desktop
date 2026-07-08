/**
 * Configurable Kanban pipeline-stage helpers.
 *
 * Every Organization owns an ordered set of `PipelineStage` rows (its board
 * template, applied to all projects). On first use we seed a sensible default
 * set (Inflow → Shortlist → Proposed → Interview → Hired → Rejected). The
 * legacy fixed `ShortlistStage` enum is still mapped onto these defaults so
 * pre-existing `ShortlistEntry` rows (stageId == null) show up on the board.
 *
 * All reads/seeds are idempotent and org-scoped.
 */

import { ShortlistStage, type PipelineStage } from '@prisma/client';

import { prisma } from '@/lib/db';

/** A default stage definition (seeded once per org). */
export interface DefaultStageDef {
  name: string;
  /** Stable key used to map the legacy enum → the seeded stage. */
  key: 'inflow' | 'shortlist' | 'proposed' | 'interview' | 'hired' | 'rejected';
  color: string;
  isTerminal: boolean;
  /**
   * Reveal-gate flag for this stage (identity, not position). Pre-reveal stages
   * (inflow + shortlist) are `false`; everything from `proposed` onward is
   * `true` and may only hold revealed candidates. See {@link isPostRevealStage}.
   */
  revealRequired: boolean;
}

/**
 * The out-of-the-box stage set. Colors are drawn from / harmonized with the
 * evergreen theme accent (#1f6f5c) plus calm status hues. `Rejected` is the
 * only terminal stage by default.
 */
export const DEFAULT_STAGES: readonly DefaultStageDef[] = [
  { key: 'inflow', name: 'Inflow', color: '#64748b', isTerminal: false, revealRequired: false },
  { key: 'shortlist', name: 'Shortlist', color: '#1f6f5c', isTerminal: false, revealRequired: false },
  { key: 'proposed', name: 'Proposed', color: '#2563eb', isTerminal: false, revealRequired: true },
  { key: 'interview', name: 'Interview', color: '#b45309', isTerminal: false, revealRequired: true },
  { key: 'hired', name: 'Hired', color: '#15803d', isTerminal: true, revealRequired: true },
  { key: 'rejected', name: 'Rejected', color: '#b91c1c', isTerminal: true, revealRequired: true },
] as const;

/**
 * Legacy `ShortlistStage` enum → default-stage key. Used to place entries that
 * were written before the configurable board (stageId == null) into the right
 * column. New writes always set `stageId`, so this only matters for back-compat.
 */
const LEGACY_STAGE_TO_KEY: Readonly<Record<ShortlistStage, DefaultStageDef['key']>> = {
  [ShortlistStage.NEW]: 'inflow',
  [ShortlistStage.SHORTLISTED]: 'shortlist',
  [ShortlistStage.CONTACTED]: 'proposed',
  [ShortlistStage.REJECTED]: 'rejected',
};

/**
 * Seed the default stage set for `orgId` if (and only if) it has none. Safe to
 * call repeatedly / concurrently — a second caller that loses the race simply
 * finds the rows already present and returns them.
 */
export async function getOrCreateStages(orgId: string): Promise<PipelineStage[]> {
  const existing = await getOrgStages(orgId);
  if (existing.length > 0) return existing;

  try {
    await prisma.pipelineStage.createMany({
      data: DEFAULT_STAGES.map((s, i) => ({
        organizationId: orgId,
        name: s.name,
        position: i,
        color: s.color,
        isTerminal: s.isTerminal,
        revealRequired: s.revealRequired,
      })),
    });
  } catch {
    /* concurrent seed — ignore, we re-read below */
  }
  return getOrgStages(orgId);
}

/** Ordered stages for `orgId` (by position, then creation). Never seeds. */
export async function getOrgStages(orgId: string): Promise<PipelineStage[]> {
  return prisma.pipelineStage.findMany({
    where: { organizationId: orgId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
}

/**
 * Resolve the stage a `ShortlistEntry` belongs to. Prefers the explicit
 * `stageId`; falls back to mapping the legacy enum onto the matching default
 * stage by name/key; finally falls back to the first stage. Returns the
 * resolved stage id or null when the org has no stages at all.
 *
 * @param stages   The org's ordered stages (already loaded).
 * @param stageId  The entry's explicit stageId (may be null).
 * @param legacy   The entry's legacy enum value (default NEW).
 */
export function resolveEntryStageId(
  stages: readonly PipelineStage[],
  stageId: string | null,
  legacy: ShortlistStage = ShortlistStage.NEW,
): string | null {
  if (stages.length === 0) return null;
  if (stageId && stages.some((s) => s.id === stageId)) return stageId;

  // Map the legacy enum to a default-stage key, then find the stage whose name
  // matches that key's canonical default name (case-insensitive). Falls back to
  // position-based defaults when names were renamed away from the seed.
  const key = LEGACY_STAGE_TO_KEY[legacy] ?? 'inflow';
  const def = DEFAULT_STAGES.find((d) => d.key === key);
  if (def) {
    const byName = stages.find(
      (s) => s.name.trim().toLowerCase() === def.name.toLowerCase(),
    );
    if (byName) return byName.id;
  }

  // Rejected → last terminal stage if any; everything else → first stage.
  if (key === 'rejected') {
    const terminal = [...stages].reverse().find((s) => s.isTerminal);
    if (terminal) return terminal.id;
  }
  return stages[0].id;
}

/**
 * Reveal-gate boundary — seed-time DEFAULT only.
 *
 * Historically the gate compared a stage's mutable order *index* against this
 * boundary: index 0/1 (inflow + shortlist) were pre-reveal, index >= 2 (proposed
 * and later) were post-reveal. That was bypassable: an admin could `moveStage`
 * a post-reveal stage to index 0/1, dropping its index below the boundary, and
 * then drag a never-revealed candidate into it for a free reveal.
 *
 * The gate is now anchored to stage *identity* via the `revealRequired` column
 * (see {@link isPostRevealStage}), which reordering never touches. This constant
 * survives only as the seed-time split: `DEFAULT_STAGES` entries at order index
 * `< SHORTLIST_BOUNDARY_INDEX` are seeded with `revealRequired = false`, the rest
 * with `true`. It is NOT consulted at gate-check time.
 */
export const SHORTLIST_BOUNDARY_INDEX = 2 as const;

/**
 * Whether `stageId` is a post-reveal (gated) stage — keyed off the stage's own
 * `revealRequired` flag, NOT its position. A non-revealed candidate may never
 * be moved into such a stage. Because the flag is fixed at create time and
 * reordering never mutates it, moving a stage around the board cannot un-gate
 * it. Unknown ids → false (a stage not on this board can't be a valid drop
 * target anyway).
 */
export function isPostRevealStage(
  stages: readonly PipelineStage[],
  stageId: string,
): boolean {
  const stage = stages.find((s) => s.id === stageId);
  return stage?.revealRequired ?? false;
}
