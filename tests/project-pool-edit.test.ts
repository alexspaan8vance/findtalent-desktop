import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';

import { PrismaClient } from '@prisma/client';
import { encrypt } from '../src/lib/crypto';

// --- Mocks -----------------------------------------------------------------
// Hoisted so the vi.mock factories (which run before module init) can see them.
const h = vi.hoisted(() => ({
  currentUserId: { value: '' },
  syncMock: vi.fn(async () => ({ projectId: '', pools: [] })),
}));
const syncMock = h.syncMock;
function setCurrentUser(id: string) {
  h.currentUserId.value = id;
}

// revalidatePath needs a Next request store — stub it out in tests.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// requireUser → the project's owner (so userCanAccessProject short-circuits on
// project.userId === userId, no org needed).
// ADMIN so the IDOR pool-authorization guard (getAllowedTenantIds) admits any
// tenant — this suite exercises the pool add/remove DIFF, not authorization
// (the unknown/empty-pool rejections trip earlier checks regardless of role).
vi.mock('../src/lib/auth-helpers', () => ({
  requireUser: vi.fn(async () => ({ id: h.currentUserId.value, role: 'ADMIN' })),
}));

// syncProjectToVance → no-op (we test the DB pool-diff, not the 8vance sync).
vi.mock('../src/lib/eightvance/job-sync', () => ({
  syncProjectToVance: h.syncMock,
  MatchPreconditionError: class MatchPreconditionError extends Error {},
}));

import { updateProjectAction } from '../src/app/app/projects/[id]/actions';

const prisma = new PrismaClient();

async function mkTenant(label: string) {
  return prisma.tenant.create({
    data: {
      slug: `t-${label}-${Math.random().toString(36).slice(2, 8)}`,
      name: label,
      eightvanceClientId: 'cid',
      eightvanceClientSecretEnc: encrypt('sekret'),
      eightvanceCompanyId: 34231,
      ownSourceSlug: `src_${label}`,
      brandConfigJson: {},
    },
  });
}

const VALID_SKILLS = Array.from({ length: 3 }, (_, i) => ({
  id: 100 + i,
  name: `skill-${i}`,
  proficiency_id: 25,
  must_have: false,
}));

function basePayload(poolIds: string[]) {
  return {
    title: 'Senior backend engineer',
    functionNameId: 1234,
    functionNameLabel: 'Backend Engineer',
    functionLevel: 4,
    minYearsExperience: 0,
    locationCity: 'Amsterdam',
    locationCountry: 'Netherlands',
    skills: VALID_SKILLS,
    languages: [],
    pools: poolIds,
  };
}

async function mkProject(userId: string, tenantId: string) {
  return prisma.project.create({
    data: {
      userId,
      title: 'P',
      functionNameId: 1234,
      functionNameLabel: 'Backend Engineer',
      functionLevel: 4,
      locationCity: 'Amsterdam',
      locationCountry: 'Netherlands',
      skillsJson: VALID_SKILLS,
      languagesJson: [],
      status: 'READY',
      pools: {
        create: [
          { tenantId, eightvanceJobId: 555, eightvanceTaskId: 't1', status: 'READY' },
        ],
      },
    },
    include: { pools: true },
  });
}

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  syncMock.mockClear();
  await prisma.match.deleteMany();
  await prisma.reveal.deleteMany();
  await prisma.projectPool.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('updateProjectAction — pool add/remove diff', () => {
  it('ADD: creates a fresh ProjectPool (no job ids) for an added tenant', async () => {
    const user = await prisma.user.create({ data: { email: `u-${Math.random()}@t.local` } });
    setCurrentUser(user.id);
    const tA = await mkTenant('A');
    const tB = await mkTenant('B');
    const project = await mkProject(user.id, tA.id);

    const res = await updateProjectAction(project.id, basePayload([tA.id, tB.id]));
    expect(res.ok).toBe(true);

    const pools = await prisma.projectPool.findMany({
      where: { projectId: project.id },
    });
    expect(pools).toHaveLength(2);
    const added = pools.find((p) => p.tenantId === tB.id);
    expect(added).toBeTruthy();
    expect(added?.eightvanceJobId).toBeNull();
    expect(added?.eightvanceTaskId).toBeNull();
    // Kept pool's job id was cleared (forces fresh job).
    const kept = pools.find((p) => p.tenantId === tA.id);
    expect(kept?.eightvanceJobId).toBeNull();
    expect(syncMock).toHaveBeenCalledTimes(1);
  });

  it('REMOVE: deletes the pool AND its Match rows for that tenant', async () => {
    const user = await prisma.user.create({ data: { email: `u-${Math.random()}@t.local` } });
    setCurrentUser(user.id);
    const tA = await mkTenant('A');
    const tB = await mkTenant('B');
    // Project starts with two pools (A + B).
    const project = await prisma.project.create({
      data: {
        userId: user.id,
        title: 'P',
        functionNameId: 1234,
        functionNameLabel: 'Backend Engineer',
        functionLevel: 4,
        locationCity: 'Amsterdam',
        locationCountry: 'Netherlands',
        skillsJson: VALID_SKILLS,
        languagesJson: [],
        status: 'READY',
        pools: {
          create: [
            { tenantId: tA.id, eightvanceJobId: 1, status: 'READY' },
            { tenantId: tB.id, eightvanceJobId: 2, status: 'READY' },
          ],
        },
      },
    });
    // A match in each pool.
    const future = new Date(Date.now() + 86400000);
    await prisma.match.createMany({
      data: [
        { projectId: project.id, tenantId: tA.id, eightvanceTalentId: 11, opaqueId: 'oa', score: 0.9, anonymizedPayloadJson: {}, expiresAt: future },
        { projectId: project.id, tenantId: tB.id, eightvanceTalentId: 22, opaqueId: 'ob', score: 0.8, anonymizedPayloadJson: {}, expiresAt: future },
      ],
    });

    // Drop pool B.
    const res = await updateProjectAction(project.id, basePayload([tA.id]));
    expect(res.ok).toBe(true);

    const pools = await prisma.projectPool.findMany({ where: { projectId: project.id } });
    expect(pools).toHaveLength(1);
    expect(pools[0].tenantId).toBe(tA.id);

    const matches = await prisma.match.findMany({ where: { projectId: project.id } });
    expect(matches).toHaveLength(1);
    expect(matches[0].tenantId).toBe(tA.id);
  });

  it('rejects an empty pool selection (min 1 enforced)', async () => {
    const user = await prisma.user.create({ data: { email: `u-${Math.random()}@t.local` } });
    setCurrentUser(user.id);
    const tA = await mkTenant('A');
    const project = await mkProject(user.id, tA.id);

    const res = await updateProjectAction(project.id, basePayload([]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('precondition');
    // Pools untouched; sync never attempted.
    const pools = await prisma.projectPool.findMany({ where: { projectId: project.id } });
    expect(pools).toHaveLength(1);
    expect(syncMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown tenant id', async () => {
    const user = await prisma.user.create({ data: { email: `u-${Math.random()}@t.local` } });
    setCurrentUser(user.id);
    const tA = await mkTenant('A');
    const project = await mkProject(user.id, tA.id);

    const res = await updateProjectAction(project.id, basePayload([tA.id, 'does-not-exist']));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('precondition');
    expect(syncMock).not.toHaveBeenCalled();
  });
});
