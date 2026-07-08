/**
 * Reveal-lock tests.
 *
 * Run with `npx vitest run tests/lock.test.ts`.
 */

import { describe, it, expect, afterAll, beforeEach } from 'vitest';

import { PrismaClient } from '@prisma/client';
import {
  acquireReveal,
  hasActiveLock,
  InsufficientCreditsError,
  LockExistsError,
} from '../src/lib/reveal/lock';

const prisma = new PrismaClient();

const TALENT_ID = 9999;

interface Ctx {
  tenantA: string;
  tenantB: string;
  userA1: string;
  userA2: string;
  userB1: string;
  projectA1: string;
  projectA2: string;
  projectB1: string;
}

async function seed(): Promise<Ctx> {
  const slugA = 't-a-' + Math.random().toString(36).slice(2, 8);
  const slugB = 't-b-' + Math.random().toString(36).slice(2, 8);
  const tenantA = await prisma.tenant.create({
    data: {
      slug: slugA,
      name: 'Tenant A',
      eightvanceClientId: 'x',
      eightvanceClientSecretEnc: 'x',
      eightvanceCompanyId: 1,
      brandConfigJson: {},
    },
  });
  const tenantB = await prisma.tenant.create({
    data: {
      slug: slugB,
      name: 'Tenant B',
      eightvanceClientId: 'x',
      eightvanceClientSecretEnc: 'x',
      eightvanceCompanyId: 2,
      brandConfigJson: {},
    },
  });
  const userA1 = await prisma.user.create({
    data: {
      email: `a1-${Math.random().toString(36).slice(2, 8)}@t.local`,
      creditsBalance: 5,
    },
  });
  const userA2 = await prisma.user.create({
    data: {
      email: `a2-${Math.random().toString(36).slice(2, 8)}@t.local`,
      creditsBalance: 5,
    },
  });
  const userB1 = await prisma.user.create({
    data: {
      email: `b1-${Math.random().toString(36).slice(2, 8)}@t.local`,
      creditsBalance: 5,
    },
  });
  const projectA1 = await prisma.project.create({
    data: {
      userId: userA1.id,
      title: 'P-A1',
      locationCity: 'Eindhoven',
      locationCountry: 'NL',
      skillsJson: [],
      languagesJson: [],
    },
  });
  const projectA2 = await prisma.project.create({
    data: {
      userId: userA2.id,
      title: 'P-A2',
      locationCity: 'Eindhoven',
      locationCountry: 'NL',
      skillsJson: [],
      languagesJson: [],
    },
  });
  const projectB1 = await prisma.project.create({
    data: {
      userId: userB1.id,
      title: 'P-B1',
      locationCity: 'Eindhoven',
      locationCountry: 'NL',
      skillsJson: [],
      languagesJson: [],
    },
  });
  return {
    tenantA: tenantA.id,
    tenantB: tenantB.id,
    userA1: userA1.id,
    userA2: userA2.id,
    userB1: userB1.id,
    projectA1: projectA1.id,
    projectA2: projectA2.id,
    projectB1: projectB1.id,
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
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('hasActiveLock', () => {
  it('returns locked when an unexpired Reveal exists in the same tenant', async () => {
    const ctx = await seed();
    const expiresAt = new Date(Date.now() + 14 * 86400_000);
    await prisma.revealLock.create({
      data: {
        tenantId: ctx.tenantA,
        eightvanceTalentId: TALENT_ID,
        userId: ctx.userA1,
        expiresAt,
      },
    });
    const r = await hasActiveLock(TALENT_ID, ctx.tenantA, ctx.userA2);
    expect(r.locked).toBe(true);
    expect(r.ownedByCurrentUser).toBe(false);
    expect(r.userId).toBe(ctx.userA1);
  });

  it('treats expired Reveal as unlocked', async () => {
    const ctx = await seed();
    await prisma.revealLock.create({
      data: {
        tenantId: ctx.tenantA,
        eightvanceTalentId: TALENT_ID,
        userId: ctx.userA1,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const r = await hasActiveLock(TALENT_ID, ctx.tenantA, ctx.userA2);
    expect(r.locked).toBe(false);
  });

  it('scopes lock to tenant — other tenant sees no lock', async () => {
    const ctx = await seed();
    await prisma.revealLock.create({
      data: {
        tenantId: ctx.tenantA,
        eightvanceTalentId: TALENT_ID,
        userId: ctx.userA1,
        expiresAt: new Date(Date.now() + 14 * 86400_000),
      },
    });
    const r = await hasActiveLock(TALENT_ID, ctx.tenantB, ctx.userB1);
    expect(r.locked).toBe(false);
  });
});

describe('acquireReveal', () => {
  it('happy path inserts Reveal + decrements credits', async () => {
    const ctx = await seed();
    const row = await acquireReveal({
      userId: ctx.userA1,
      projectId: ctx.projectA1,
      tenantId: ctx.tenantA,
      eightvanceTalentId: TALENT_ID,
      rawProfileEncrypted: 'enc-blob',
    });
    expect(row.eightvanceTalentId).toBe(TALENT_ID);
    expect(row.piiPayloadEnc).toBe('enc-blob');
    expect(row.tenantId).toBe(ctx.tenantA);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userA1 } });
    expect(user.creditsBalance).toBe(4);

    const ledger = await prisma.creditTransaction.findMany({
      where: { userId: ctx.userA1 },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].delta).toBe(-1);
    expect(ledger[0].reason).toBe('REVEAL');
  });

  it('blocks when another user in the same tenant holds an active lock', async () => {
    const ctx = await seed();
    await acquireReveal({
      userId: ctx.userA1,
      projectId: ctx.projectA1,
      tenantId: ctx.tenantA,
      eightvanceTalentId: TALENT_ID,
      rawProfileEncrypted: 'enc',
    });

    await expect(
      acquireReveal({
        userId: ctx.userA2,
        projectId: ctx.projectA2,
        tenantId: ctx.tenantA,
        eightvanceTalentId: TALENT_ID,
        rawProfileEncrypted: 'enc',
      }),
    ).rejects.toBeInstanceOf(LockExistsError);

    const userA2 = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userA2 } });
    expect(userA2.creditsBalance).toBe(5);
  });

  it('blocks when the user has 0 credits', async () => {
    const ctx = await seed();
    await prisma.user.update({
      where: { id: ctx.userA1 },
      data: { creditsBalance: 0 },
    });
    await expect(
      acquireReveal({
        userId: ctx.userA1,
        projectId: ctx.projectA1,
        tenantId: ctx.tenantA,
        eightvanceTalentId: TALENT_ID,
        rawProfileEncrypted: 'enc',
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    const reveals = await prisma.reveal.findMany();
    expect(reveals).toHaveLength(0);
  });

  it('spends purchased pack credits when subscription balance is exhausted', async () => {
    const ctx = await seed();
    // No subscription credits, but a purchased pack credit available.
    await prisma.user.update({
      where: { id: ctx.userA1 },
      data: { creditsBalance: 0, purchasedCredits: 1 },
    });
    const row = await acquireReveal({
      userId: ctx.userA1,
      projectId: ctx.projectA1,
      tenantId: ctx.tenantA,
      eightvanceTalentId: TALENT_ID,
      rawProfileEncrypted: 'enc',
    });
    expect(row.eightvanceTalentId).toBe(TALENT_ID);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userA1 } });
    expect(user.creditsBalance).toBe(0);
    expect(user.purchasedCredits).toBe(0);
  });

  it('blocks when BOTH subscription and purchased credits are 0', async () => {
    const ctx = await seed();
    await prisma.user.update({
      where: { id: ctx.userA1 },
      data: { creditsBalance: 0, purchasedCredits: 0 },
    });
    await expect(
      acquireReveal({
        userId: ctx.userA1,
        projectId: ctx.projectA1,
        tenantId: ctx.tenantA,
        eightvanceTalentId: TALENT_ID,
        rawProfileEncrypted: 'enc',
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
    const reveals = await prisma.reveal.findMany();
    expect(reveals).toHaveLength(0);
  });

  it('returns existing reveal when current user already owns the lock', async () => {
    const ctx = await seed();
    const first = await acquireReveal({
      userId: ctx.userA1,
      projectId: ctx.projectA1,
      tenantId: ctx.tenantA,
      eightvanceTalentId: TALENT_ID,
      rawProfileEncrypted: 'enc-1',
    });
    const again = await acquireReveal({
      userId: ctx.userA1,
      projectId: ctx.projectA1,
      tenantId: ctx.tenantA,
      eightvanceTalentId: TALENT_ID,
      rawProfileEncrypted: 'enc-2',
    });
    expect(again.id).toBe(first.id);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userA1 } });
    expect(user.creditsBalance).toBe(4);
  });

  it('charges again when the user holds the lock but the linked Reveal is gone (no free duplicate)', async () => {
    const ctx = await seed();
    const first = await acquireReveal({
      userId: ctx.userA1,
      projectId: ctx.projectA1,
      tenantId: ctx.tenantA,
      eightvanceTalentId: TALENT_ID,
      rawProfileEncrypted: 'enc-1',
    });
    // Simulate the orphan: delete the Reveal while the lock survives (the FK is
    // SetNull, so revealId becomes null). Previously this path created a new
    // Reveal WITHOUT spending a credit — the free-duplicate bug.
    await prisma.reveal.delete({ where: { id: first.id } });

    const again = await acquireReveal({
      userId: ctx.userA1,
      projectId: ctx.projectA1,
      tenantId: ctx.tenantA,
      eightvanceTalentId: TALENT_ID,
      rawProfileEncrypted: 'enc-2',
    });
    // A fresh Reveal was created...
    expect(again.id).not.toBe(first.id);
    expect(again.piiPayloadEnc).toBe('enc-2');
    // ...and it COST a second credit (5 → 4 → 3), not a free reveal.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userA1 } });
    expect(user.creditsBalance).toBe(3);
    const ledger = await prisma.creditTransaction.findMany({ where: { userId: ctx.userA1 } });
    expect(ledger).toHaveLength(2);
  });
});
