import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';

import { PrismaClient } from '@prisma/client';
import { encrypt } from '../src/lib/crypto';

// --- Mocks -----------------------------------------------------------------
const h = vi.hoisted(() => ({
  currentUserId: { value: '' },
}));
function setCurrentUser(id: string) {
  h.currentUserId.value = id;
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('../src/lib/auth-helpers', () => ({
  requireUser: vi.fn(async () => ({ id: h.currentUserId.value })),
}));

// closeProject / reopenProject don't touch 8vance — stub the sync defensively.
vi.mock('../src/lib/eightvance/job-sync', () => ({
  syncProjectToVance: vi.fn(async () => ({ projectId: '', pools: [] })),
  MatchPreconditionError: class MatchPreconditionError extends Error {},
}));

import { closeProject, reopenProject } from '../src/app/app/projects/[id]/actions';

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

const VALID_SKILLS = [{ id: 1, name: 's', proficiency_id: 25, must_have: false }];

async function mkProject(
  userId: string,
  tenantId: string,
  opts: { lastMatchedAt?: Date | null } = {},
) {
  return prisma.project.create({
    data: {
      userId,
      title: 'P',
      locationCity: 'Amsterdam',
      locationCountry: 'Netherlands',
      skillsJson: VALID_SKILLS,
      languagesJson: [],
      status: 'READY',
      lastMatchedAt: 'lastMatchedAt' in opts ? opts.lastMatchedAt : new Date(),
      pools: { create: [{ tenantId, eightvanceJobId: 1, status: 'READY' }] },
    },
  });
}

/** A reveal + its active exclusive lock on (tenant, talent). */
async function mkRevealWithLock(
  projectId: string,
  userId: string,
  tenantId: string,
  talentId: number,
) {
  const future = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const reveal = await prisma.reveal.create({
    data: {
      projectId,
      userId,
      tenantId,
      eightvanceTalentId: talentId,
      expiresAt: future,
      piiPayloadEnc: encrypt(JSON.stringify({ first_name: 'A', last_name: 'B' })),
    },
  });
  await prisma.revealLock.create({
    data: { tenantId, eightvanceTalentId: talentId, userId, revealId: reveal.id, expiresAt: future },
  });
  return reveal;
}

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.revealLock.deleteMany();
  await prisma.reveal.deleteMany();
  await prisma.match.deleteMany();
  await prisma.projectPool.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('closeProject', () => {
  it('sets CLOSED and expires the project’s reveal locks (lock becomes dead)', async () => {
    const user = await prisma.user.create({ data: { email: `u-${Math.random()}@t.local` } });
    setCurrentUser(user.id);
    const tA = await mkTenant('A');
    const project = await mkProject(user.id, tA.id);
    await mkRevealWithLock(project.id, user.id, tA.id, 101);

    const res = await closeProject(project.id);
    expect(res.ok).toBe(true);

    const updated = await prisma.project.findUnique({ where: { id: project.id } });
    expect(updated?.status).toBe('CLOSED');

    // The lock's expiresAt is pushed to "now" (set inside the action), so it is
    // already in the past relative to the current clock → findActiveLock treats
    // it dead and the talent is released.
    const lock = await prisma.revealLock.findUnique({
      where: { tenantId_eightvanceTalentId: { tenantId: tA.id, eightvanceTalentId: 101 } },
    });
    expect(lock).toBeTruthy();
    expect(lock!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());

    // Reveal row is PRESERVED (no PII deletion) — only the lock was expired.
    const reveals = await prisma.reveal.findMany({ where: { projectId: project.id } });
    expect(reveals).toHaveLength(1);
  });

  it('does not expire locks belonging to OTHER projects', async () => {
    const user = await prisma.user.create({ data: { email: `u-${Math.random()}@t.local` } });
    setCurrentUser(user.id);
    const tA = await mkTenant('A');
    const tB = await mkTenant('B');
    const projectToClose = await mkProject(user.id, tA.id);
    const otherProject = await mkProject(user.id, tB.id);
    await mkRevealWithLock(otherProject.id, user.id, tB.id, 202);

    const res = await closeProject(projectToClose.id);
    expect(res.ok).toBe(true);

    const otherLock = await prisma.revealLock.findUnique({
      where: { tenantId_eightvanceTalentId: { tenantId: tB.id, eightvanceTalentId: 202 } },
    });
    expect(otherLock!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a project the user cannot access', async () => {
    const owner = await prisma.user.create({ data: { email: `o-${Math.random()}@t.local` } });
    const stranger = await prisma.user.create({ data: { email: `s-${Math.random()}@t.local` } });
    const tA = await mkTenant('A');
    const project = await mkProject(owner.id, tA.id);

    setCurrentUser(stranger.id);
    const res = await closeProject(project.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not_found');

    const updated = await prisma.project.findUnique({ where: { id: project.id } });
    expect(updated?.status).toBe('READY');
  });
});

describe('reopenProject', () => {
  it('restores READY (lastMatchedAt set) and does NOT un-expire reveals', async () => {
    const user = await prisma.user.create({ data: { email: `u-${Math.random()}@t.local` } });
    setCurrentUser(user.id);
    const tA = await mkTenant('A');
    const project = await mkProject(user.id, tA.id, { lastMatchedAt: new Date() });
    await mkRevealWithLock(project.id, user.id, tA.id, 303);

    await closeProject(project.id);
    const res = await reopenProject(project.id);
    expect(res.ok).toBe(true);

    const updated = await prisma.project.findUnique({ where: { id: project.id } });
    expect(updated?.status).toBe('READY');

    // Reveal lock stays ended after reopen (re-reveal would cost a new credit).
    const lock = await prisma.revealLock.findUnique({
      where: { tenantId_eightvanceTalentId: { tenantId: tA.id, eightvanceTalentId: 303 } },
    });
    expect(lock!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('restores DRAFT when the project never matched', async () => {
    const user = await prisma.user.create({ data: { email: `u-${Math.random()}@t.local` } });
    setCurrentUser(user.id);
    const tA = await mkTenant('A');
    const project = await mkProject(user.id, tA.id, { lastMatchedAt: null });

    await closeProject(project.id);
    const res = await reopenProject(project.id);
    expect(res.ok).toBe(true);

    const updated = await prisma.project.findUnique({ where: { id: project.id } });
    expect(updated?.status).toBe('DRAFT');
  });
});

describe('active project list query', () => {
  it('excludes CLOSED (and ARCHIVED) projects; the inactive view includes both', async () => {
    const user = await prisma.user.create({ data: { email: `u-${Math.random()}@t.local` } });
    const tA = await mkTenant('A');
    const active = await mkProject(user.id, tA.id);
    const closed = await mkProject(user.id, tA.id);
    const archived = await mkProject(user.id, tA.id);
    await prisma.project.update({ where: { id: closed.id }, data: { status: 'CLOSED' } });
    await prisma.project.update({ where: { id: archived.id }, data: { status: 'ARCHIVED' } });

    const INACTIVE = ['ARCHIVED', 'CLOSED'] as const;
    const activeRows = await prisma.project.findMany({
      where: { userId: user.id, status: { notIn: [...INACTIVE] } },
      select: { id: true },
    });
    expect(activeRows.map((r) => r.id)).toEqual([active.id]);

    const inactiveRows = await prisma.project.findMany({
      where: { userId: user.id, status: { in: [...INACTIVE] } },
      select: { id: true },
    });
    expect(new Set(inactiveRows.map((r) => r.id))).toEqual(new Set([closed.id, archived.id]));
  });
});
