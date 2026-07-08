/**
 * Phase 2 — project-scoped SHARED reveals.
 *
 * When recruiter A reveals a candidate on project X (1 credit), a colleague B
 * in the same org with access to project X may read the SAME candidate's PII at
 * 0 credit — but ONLY on the same project. The 14-day exclusivity lock stays
 * with A. A reveal on a DIFFERENT project must NOT satisfy the share.
 *
 * Run with `npx vitest run tests/reveal-share.test.ts`.
 */

import { describe, it, expect, afterAll, beforeEach } from 'vitest';

import { PrismaClient } from '@prisma/client';
import { acquireReveal } from '../src/lib/reveal/lock';
import { encrypt, decrypt } from '../src/lib/crypto';

const prisma = new PrismaClient();

const TALENT_ID = 7777;

interface Ctx {
  orgId: string;
  tenantId: string;
  userA: string;
  userB: string;
  projectX: string;
  projectY: string;
}

async function seed(): Promise<Ctx> {
  const org = await prisma.organization.create({
    data: { name: 'Org ' + Math.random().toString(36).slice(2, 8) },
  });
  const tenant = await prisma.tenant.create({
    data: {
      slug: 't-' + Math.random().toString(36).slice(2, 8),
      name: 'Tenant',
      eightvanceClientId: 'x',
      eightvanceClientSecretEnc: 'x',
      eightvanceCompanyId: 1,
      brandConfigJson: {},
    },
  });
  const userA = await prisma.user.create({
    data: {
      email: `a-${Math.random().toString(36).slice(2, 8)}@t.local`,
      creditsBalance: 5,
      organizationId: org.id,
      memberships: { create: { organizationId: org.id, role: 'OWNER' } },
    },
  });
  const userB = await prisma.user.create({
    data: {
      email: `b-${Math.random().toString(36).slice(2, 8)}@t.local`,
      creditsBalance: 5,
      organizationId: org.id,
      memberships: { create: { organizationId: org.id, role: 'MEMBER' } },
    },
  });
  // Project X belongs to the org (shared); A is the owner.
  const projectX = await prisma.project.create({
    data: {
      userId: userA.id,
      organizationId: org.id,
      title: 'Project X',
      locationCity: 'Eindhoven',
      locationCountry: 'NL',
      skillsJson: [],
      languagesJson: [],
    },
  });
  const projectY = await prisma.project.create({
    data: {
      userId: userA.id,
      organizationId: org.id,
      title: 'Project Y',
      locationCity: 'Eindhoven',
      locationCountry: 'NL',
      skillsJson: [],
      languagesJson: [],
    },
  });
  return {
    orgId: org.id,
    tenantId: tenant.id,
    userA: userA.id,
    userB: userB.id,
    projectX: projectX.id,
    projectY: projectY.id,
  };
}

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.revealLock.deleteMany();
  await prisma.reveal.deleteMany();
  await prisma.match.deleteMany();
  await prisma.creditTransaction.deleteMany();
  await prisma.projectPool.deleteMany();
  await prisma.project.deleteMany();
  await prisma.organizationMember.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.tenant.deleteMany();
});

/**
 * Mirrors the read-path query in page.tsx: the project-scoped shared-reveal
 * lookup, pinned to (projectId, talentId) and non-expired.
 */
async function findProjectSharedReveal(
  projectId: string,
  eightvanceTalentId: number,
): Promise<string | null> {
  const r = await prisma.reveal.findFirst({
    where: { projectId, eightvanceTalentId, expiresAt: { gt: new Date() } },
    orderBy: { revealedAt: 'desc' },
    select: { piiPayloadEnc: true },
  });
  if (!r) return null;
  return decrypt(r.piiPayloadEnc);
}

describe('project-scoped shared reveals', () => {
  it('(a) colleague reads decrypted PII on the same project at 0 credit', async () => {
    const ctx = await seed();
    const pii = { first_name: 'Jane', last_name: 'Doe', email: 'jane@x.io' };

    // A reveals on project X (spends 1 credit).
    await acquireReveal({
      userId: ctx.userA,
      projectId: ctx.projectX,
      tenantId: ctx.tenantId,
      eightvanceTalentId: TALENT_ID,
      rawProfileEncrypted: encrypt(JSON.stringify(pii)),
    });
    const userA = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userA } });
    expect(userA.creditsBalance).toBe(4);

    // B (same org, project X is org-shared) reads the SAME reveal — no spend.
    const shared = await findProjectSharedReveal(ctx.projectX, TALENT_ID);
    expect(shared).not.toBeNull();
    expect(JSON.parse(shared!)).toMatchObject({ email: 'jane@x.io' });

    // B's balance untouched; only one credit ever spent (by A).
    const userB = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userB } });
    expect(userB.creditsBalance).toBe(5);
    const ledger = await prisma.creditTransaction.findMany();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].userId).toBe(ctx.userA);
  });

  it('(b) a different project does NOT satisfy the share (no cross-project leak)', async () => {
    const ctx = await seed();
    await acquireReveal({
      userId: ctx.userA,
      projectId: ctx.projectX,
      tenantId: ctx.tenantId,
      eightvanceTalentId: TALENT_ID,
      rawProfileEncrypted: encrypt(JSON.stringify({ email: 'jane@x.io' })),
    });

    // Same talent, but viewed from project Y → no shared reveal visible.
    const shared = await findProjectSharedReveal(ctx.projectY, TALENT_ID);
    expect(shared).toBeNull();
  });

  it('(c) an expired reveal does NOT satisfy the share', async () => {
    const ctx = await seed();
    // Manually craft an expired Reveal on project X.
    await prisma.reveal.create({
      data: {
        projectId: ctx.projectX,
        userId: ctx.userA,
        tenantId: ctx.tenantId,
        eightvanceTalentId: TALENT_ID,
        expiresAt: new Date(Date.now() - 1000),
        piiPayloadEnc: encrypt(JSON.stringify({ email: 'old@x.io' })),
      },
    });
    const shared = await findProjectSharedReveal(ctx.projectX, TALENT_ID);
    expect(shared).toBeNull();
  });

  it('14-day exclusivity lock stays with the first revealer', async () => {
    const ctx = await seed();
    const first = await acquireReveal({
      userId: ctx.userA,
      projectId: ctx.projectX,
      tenantId: ctx.tenantId,
      eightvanceTalentId: TALENT_ID,
      rawProfileEncrypted: encrypt(JSON.stringify({ email: 'jane@x.io' })),
    });
    const lockRow = await prisma.revealLock.findUniqueOrThrow({
      where: {
        tenantId_eightvanceTalentId: {
          tenantId: ctx.tenantId,
          eightvanceTalentId: TALENT_ID,
        },
      },
    });
    expect(lockRow.userId).toBe(ctx.userA);
    expect(lockRow.revealId).toBe(first.id);
  });
});
