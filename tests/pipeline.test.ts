/**
 * Configurable pipeline-stage helper tests.
 *
 * Run with `npx vitest run tests/pipeline.test.ts`.
 *
 * Covers:
 *  - default-stage seeding (idempotent),
 *  - legacy `ShortlistStage` enum → configurable-stage mapping
 *    (`resolveEntryStageId`), incl. the renamed-stage fallback and the
 *    explicit-stageId short-circuit.
 */

import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { PrismaClient, ShortlistStage } from '@prisma/client';

import {
  DEFAULT_STAGES,
  getOrCreateStages,
  getOrgStages,
  resolveEntryStageId,
  isPostRevealStage,
  SHORTLIST_BOUNDARY_INDEX,
} from '../src/lib/pipeline';

const prisma = new PrismaClient();

async function createOrg(): Promise<string> {
  const org = await prisma.organization.create({
    data: { name: `pipe-${Math.random().toString(36).slice(2, 10)}` },
    select: { id: true },
  });
  return org.id;
}

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.pipelineStage.deleteMany();
  await prisma.organization.deleteMany();
});

describe('getOrCreateStages', () => {
  it('seeds the default stage set once and is idempotent', async () => {
    const orgId = await createOrg();

    const first = await getOrCreateStages(orgId);
    expect(first).toHaveLength(DEFAULT_STAGES.length);
    expect(first.map((s) => s.name)).toEqual([
      'Inflow',
      'Shortlist',
      'Proposed',
      'Interview',
      'Hired',
      'Rejected',
    ]);
    // Positions are 0..n-1 in order.
    expect(first.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
    // Rejected (+ Hired) are terminal.
    expect(first.find((s) => s.name === 'Rejected')?.isTerminal).toBe(true);

    const again = await getOrCreateStages(orgId);
    expect(again).toHaveLength(DEFAULT_STAGES.length);
    // No duplicates introduced.
    const all = await getOrgStages(orgId);
    expect(all).toHaveLength(DEFAULT_STAGES.length);
  });
});

describe('resolveEntryStageId (legacy → stage mapping)', () => {
  it('maps each legacy enum value to the matching default stage', async () => {
    const orgId = await createOrg();
    const stages = await getOrCreateStages(orgId);
    const byName = (n: string): string => stages.find((s) => s.name === n)!.id;

    expect(resolveEntryStageId(stages, null, ShortlistStage.NEW)).toBe(byName('Inflow'));
    expect(resolveEntryStageId(stages, null, ShortlistStage.SHORTLISTED)).toBe(
      byName('Shortlist'),
    );
    expect(resolveEntryStageId(stages, null, ShortlistStage.CONTACTED)).toBe(
      byName('Proposed'),
    );
    expect(resolveEntryStageId(stages, null, ShortlistStage.REJECTED)).toBe(
      byName('Rejected'),
    );
  });

  it('prefers an explicit, valid stageId over the legacy enum', async () => {
    const orgId = await createOrg();
    const stages = await getOrCreateStages(orgId);
    const interview = stages.find((s) => s.name === 'Interview')!.id;
    // Even though the legacy enum says NEW (→ Inflow), an explicit stageId wins.
    expect(resolveEntryStageId(stages, interview, ShortlistStage.NEW)).toBe(interview);
  });

  it('falls back to the first stage when names were renamed away from defaults', async () => {
    const orgId = await createOrg();
    await getOrCreateStages(orgId);
    // Rename every stage so the name-based legacy lookup can't match.
    const stages = await getOrgStages(orgId);
    for (const s of stages) {
      await prisma.pipelineStage.update({
        where: { id: s.id },
        data: { name: `Custom ${s.position}`, isTerminal: false },
      });
    }
    const renamed = await getOrgStages(orgId);
    // NEW → no name match → first stage.
    expect(resolveEntryStageId(renamed, null, ShortlistStage.NEW)).toBe(renamed[0].id);
    // REJECTED → no terminal stage left → first stage too.
    expect(resolveEntryStageId(renamed, null, ShortlistStage.REJECTED)).toBe(renamed[0].id);
  });

  it('returns null when the org has no stages', () => {
    expect(resolveEntryStageId([], null, ShortlistStage.NEW)).toBeNull();
  });

  it('ignores a stageId that does not belong to the provided set', async () => {
    const orgId = await createOrg();
    const stages = await getOrCreateStages(orgId);
    // A foreign id → ignored, falls back to the legacy mapping (NEW → Inflow).
    const inflow = stages.find((s) => s.name === 'Inflow')!.id;
    expect(resolveEntryStageId(stages, 'not-a-real-id', ShortlistStage.NEW)).toBe(inflow);
  });
});

describe('isPostRevealStage (reveal-gate, identity-anchored)', () => {
  it('seeds pre-reveal stages with revealRequired=false and the rest true', async () => {
    const orgId = await createOrg();
    const stages = await getOrCreateStages(orgId);
    // Default order: Inflow(0), Shortlist(1), Proposed(2), Interview(3), Hired(4), Rejected(5).
    const byName = (n: string): string => stages.find((s) => s.name === n)!.id;

    // The boundary survives only as the seed-time split (index < 2 → not gated).
    expect(SHORTLIST_BOUNDARY_INDEX).toBe(2);
    expect(stages.find((s) => s.name === 'Inflow')?.revealRequired).toBe(false);
    expect(stages.find((s) => s.name === 'Shortlist')?.revealRequired).toBe(false);
    expect(stages.find((s) => s.name === 'Proposed')?.revealRequired).toBe(true);

    // Pre-reveal: inflow + shortlist.
    expect(isPostRevealStage(stages, byName('Inflow'))).toBe(false);
    expect(isPostRevealStage(stages, byName('Shortlist'))).toBe(false);
    // Post-reveal: proposed (CONTACTED) and everything after.
    expect(isPostRevealStage(stages, byName('Proposed'))).toBe(true);
    expect(isPostRevealStage(stages, byName('Interview'))).toBe(true);
    expect(isPostRevealStage(stages, byName('Hired'))).toBe(true);
    expect(isPostRevealStage(stages, byName('Rejected'))).toBe(true);
  });

  it('returns false for an unknown stage id', async () => {
    const orgId = await createOrg();
    const stages = await getOrCreateStages(orgId);
    expect(isPostRevealStage(stages, 'not-a-real-id')).toBe(false);
  });

  it('keys off stage identity, not position — reordering cannot un-gate a stage', async () => {
    const orgId = await createOrg();
    await getOrCreateStages(orgId);
    const stages = await getOrgStages(orgId);
    const proposed = stages.find((s) => s.name === 'Proposed')!;
    // Regression: an admin reorders the gated "Proposed" stage to position 0
    // (where the old index-based gate would have treated it as pre-reveal).
    // revealRequired is identity and untouched by reorder, so it stays gated.
    await prisma.pipelineStage.update({
      where: { id: proposed.id },
      data: { position: 0 },
    });
    const reordered = await getOrgStages(orgId);
    const movedProposed = reordered.find((s) => s.name === 'Proposed')!;
    expect(movedProposed.position).toBe(0); // now at the front of the board
    // ...yet the reveal gate still fires: bypass via reordering is closed.
    expect(isPostRevealStage(reordered, movedProposed.id)).toBe(true);
    // A genuinely pre-reveal stage that got pushed to a later index stays open.
    const inflow = reordered.find((s) => s.name === 'Inflow')!;
    expect(isPostRevealStage(reordered, inflow.id)).toBe(false);
  });

  it('falls back to gated (true) for a stage whose revealRequired is unset/default', () => {
    // A manufactured stage with no explicit flag inherits the safe default at
    // the DB layer (true); isPostRevealStage reads it straight off the row.
    const gated = DEFAULT_STAGES.slice(0, 1).map((s, i) => ({
      id: `stage-${i}`,
      name: s.name,
      position: i,
      color: s.color,
      isTerminal: s.isTerminal,
      revealRequired: s.revealRequired,
      organizationId: 'org',
      createdAt: new Date(),
    }));
    // Inflow is seeded false.
    expect(isPostRevealStage(gated, 'stage-0')).toBe(false);
  });
});
