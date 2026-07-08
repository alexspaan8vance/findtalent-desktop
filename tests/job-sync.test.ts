import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';

import { PrismaClient } from '@prisma/client';
import { encrypt } from '../src/lib/crypto';

// Mock the tenant client factory so we don't need real 8vance creds.
type CreateMock = ReturnType<typeof vi.fn>;
type StartAsyncMock = ReturnType<typeof vi.fn>;

const jobCreateMock: CreateMock = vi.fn();
const matchStartMock: StartAsyncMock = vi.fn();

vi.mock('../src/lib/eightvance/tenant-client', () => ({
  vanceClientForTenant: vi.fn(async () => ({
    job: { create: jobCreateMock },
    match: { start: matchStartMock },
  })),
  TenantNotConfiguredError: class TenantNotConfiguredError extends Error {},
}));

import {
  syncProjectToVance,
  sweepStaleProjectPools,
  MatchPreconditionError,
} from '../src/lib/eightvance/job-sync';

const prisma = new PrismaClient();

async function createProject(opts: {
  skillCount: number;
  eightvanceJobId?: number | null;
}) {
  const tenant = await prisma.tenant.create({
    data: {
      slug: `t-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Test',
      eightvanceClientId: 'cid',
      eightvanceClientSecretEnc: encrypt('sekret'),
      eightvanceCompanyId: 34231,
      ownSourceSlug: 'test_source',
      brandConfigJson: {},
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `u-${Math.random().toString(36).slice(2, 8)}@test.local`,
    },
  });
  const skills = Array.from({ length: opts.skillCount }, (_, i) => ({
    id: 100 + i,
    name: `skill-${i}`,
    proficiency_id: 25,
    must_have: false,
  }));
  return prisma.project.create({
    data: {
      userId: user.id,
      title: 'Senior backend engineer',
      functionNameId: 1234,
      functionNameLabel: 'Backend Engineer',
      functionLevel: 4,
      locationCity: 'Amsterdam',
      locationCountry: 'Netherlands',
      locationLat: '52.37',
      locationLng: '4.89',
      skillsJson: skills,
      languagesJson: [],
      status: 'DRAFT',
      pools: {
        create: [
          {
            tenantId: tenant.id,
            eightvanceJobId: opts.eightvanceJobId ?? null,
            status: 'DRAFT',
          },
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
  jobCreateMock.mockReset();
  matchStartMock.mockReset();
  await prisma.match.deleteMany();
  await prisma.reveal.deleteMany();
  await prisma.projectPool.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('syncProjectToVance', () => {
  it('throws MatchPreconditionError when fewer than 3 skills', async () => {
    const project = await createProject({ skillCount: 2 });
    await expect(syncProjectToVance(project.id)).rejects.toBeInstanceOf(
      MatchPreconditionError,
    );
    expect(jobCreateMock).not.toHaveBeenCalled();
    expect(matchStartMock).not.toHaveBeenCalled();
  });

  it('creates job, starts match, and persists ids + status', async () => {
    jobCreateMock.mockResolvedValueOnce({ id: 9999, title: 't' });
    matchStartMock.mockResolvedValueOnce({ mode: 'async', taskId: 'task-abc' });
    const project = await createProject({ skillCount: 4 });

    const result = await syncProjectToVance(project.id);

    expect(result.pools).toHaveLength(1);
    expect(result.pools[0].jobId).toBe(9999);
    expect(result.pools[0].taskId).toBe('task-abc');
    expect(result.pools[0].status).toBe('MATCHING');
    expect(jobCreateMock).toHaveBeenCalledTimes(1);
    expect(matchStartMock).toHaveBeenCalledWith(9999, ['test_source']);

    const after = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      include: { pools: true },
    });
    expect(after.status).toBe('MATCHING');
    expect(after.pools[0].eightvanceJobId).toBe(9999);
    expect(after.pools[0].eightvanceTaskId).toBe('task-abc');
    expect(after.pools[0].status).toBe('MATCHING');
  });

  it('stamps minYearsExperience onto every skill in the job payload', async () => {
    jobCreateMock.mockResolvedValueOnce({ id: 7777, title: 't' });
    matchStartMock.mockResolvedValueOnce({ mode: 'async', taskId: 'task-yoe' });
    const project = await createProject({ skillCount: 4 });

    await syncProjectToVance(project.id, { minYearsExperience: 5 });

    expect(jobCreateMock).toHaveBeenCalledTimes(1);
    const payload = jobCreateMock.mock.calls[0][0] as {
      skills: Array<{ skill: number; experience?: number }>;
    };
    expect(payload.skills).toHaveLength(4);
    for (const s of payload.skills) {
      expect(s.experience).toBe(5);
    }
  });

  it('omits skill experience when no minYearsExperience is given', async () => {
    jobCreateMock.mockResolvedValueOnce({ id: 7778, title: 't' });
    matchStartMock.mockResolvedValueOnce({ mode: 'async', taskId: 'task-noyoe' });
    const project = await createProject({ skillCount: 3 });

    // Default call (no options) and explicit 0 both mean "no minimum".
    await syncProjectToVance(project.id, { minYearsExperience: 0 });

    const payload = jobCreateMock.mock.calls[0][0] as {
      skills: Array<{ skill: number; experience?: number }>;
    };
    for (const s of payload.skills) {
      expect(s.experience).toBeUndefined();
    }
  });

  it('promotes ONLY the first skill to must_have when the user marked none', async () => {
    jobCreateMock.mockResolvedValueOnce({ id: 7779, title: 't' });
    matchStartMock.mockResolvedValueOnce({ mode: 'async', taskId: 'task-mh' });
    // Fixture skills are all must_have:false → gate needs >=1, so the first is
    // promoted and the rest stay nice-to-have (no over-constraining).
    const project = await createProject({ skillCount: 4 });

    await syncProjectToVance(project.id);

    const payload = jobCreateMock.mock.calls[0][0] as {
      skills: Array<{ must_have: boolean }>;
    };
    expect(payload.skills).toHaveLength(4);
    expect(payload.skills.filter((s) => s.must_have)).toHaveLength(1);
    expect(payload.skills[0].must_have).toBe(true);
    expect(payload.skills.slice(1).every((s) => s.must_have === false)).toBe(true);
  });

  it('skips job.create when pool already has an eightvanceJobId', async () => {
    matchStartMock.mockResolvedValueOnce({ mode: 'async', taskId: 'task-rerun' });
    const project = await createProject({
      skillCount: 4,
      eightvanceJobId: 4242,
    });

    const result = await syncProjectToVance(project.id);

    expect(result.pools).toHaveLength(1);
    expect(result.pools[0].jobId).toBe(4242);
    expect(result.pools[0].taskId).toBe('task-rerun');
    expect(jobCreateMock).not.toHaveBeenCalled();
    expect(matchStartMock).toHaveBeenCalledWith(4242, ['test_source']);

    const after = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      include: { pools: true },
    });
    expect(after.status).toBe('MATCHING');
    expect(after.pools[0].eightvanceJobId).toBe(4242);
    expect(after.pools[0].eightvanceTaskId).toBe('task-rerun');
    expect(after.pools[0].status).toBe('MATCHING');
  });

  it('stamps matchStartedAt when a pool enters MATCHING', async () => {
    jobCreateMock.mockResolvedValueOnce({ id: 5555, title: 't' });
    matchStartMock.mockResolvedValueOnce({ mode: 'async', taskId: 'task-x' });
    const project = await createProject({ skillCount: 4 });
    await syncProjectToVance(project.id);
    const pool = await prisma.projectPool.findFirstOrThrow({
      where: { projectId: project.id },
    });
    expect(pool.matchStartedAt).not.toBeNull();
  });
});

describe('sweepStaleProjectPools', () => {
  const OLD = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago (> 10 min bound)

  async function poolInState(matchStartedAt: Date | null) {
    const project = await createProject({ skillCount: 4, eightvanceJobId: 42 });
    const pool = project.pools[0];
    await prisma.project.update({
      where: { id: project.id },
      data: { status: 'MATCHING' },
    });
    await prisma.projectPool.update({
      where: { id: pool.id },
      data: { status: 'MATCHING', eightvanceTaskId: 'task-y', matchStartedAt },
    });
    return { projectId: project.id, poolId: pool.id, tenantId: pool.tenantId };
  }

  it('fails a wedged pool (old matchStartedAt, no cached matches) and settles the project', async () => {
    const { projectId, poolId } = await poolInState(OLD);
    const swept = await sweepStaleProjectPools(projectId);
    expect(swept).toBe(1);
    const pool = await prisma.projectPool.findUniqueOrThrow({ where: { id: poolId } });
    expect(pool.status).toBe('FAILED');
    const proj = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(proj.status).toBe('FAILED');
  });

  it('preserves a wedged pool that has cached matches (→ READY, not FAILED)', async () => {
    const { projectId, poolId, tenantId } = await poolInState(OLD);
    await prisma.match.create({
      data: {
        projectId,
        tenantId,
        eightvanceTalentId: 777,
        opaqueId: 'op-1',
        score: 0.8,
        anonymizedPayloadJson: {},
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const swept = await sweepStaleProjectPools(projectId);
    expect(swept).toBe(1);
    const pool = await prisma.projectPool.findUniqueOrThrow({ where: { id: poolId } });
    expect(pool.status).toBe('READY');
    const proj = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(proj.status).toBe('READY');
  });

  it('treats a legacy MATCHING pool with null matchStartedAt as stale', async () => {
    const { projectId, poolId } = await poolInState(null);
    const swept = await sweepStaleProjectPools(projectId);
    expect(swept).toBe(1);
    const pool = await prisma.projectPool.findUniqueOrThrow({ where: { id: poolId } });
    expect(pool.status).toBe('FAILED');
  });

  it('does NOT sweep a freshly-matching pool (recent matchStartedAt)', async () => {
    const { projectId, poolId } = await poolInState(new Date());
    const swept = await sweepStaleProjectPools(projectId);
    expect(swept).toBe(0);
    const pool = await prisma.projectPool.findUniqueOrThrow({ where: { id: poolId } });
    expect(pool.status).toBe('MATCHING');
  });
});
