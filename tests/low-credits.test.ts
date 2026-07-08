import { describe, it, expect, afterAll, beforeEach } from 'vitest';

import { PrismaClient } from '@prisma/client';
import {
  spendCredit,
  grantCredits,
  maybeNotifyLowCredits,
  getCreditLedger,
} from '../src/lib/credits';

const prisma = new PrismaClient();

async function createUser(creditsBalance = 0, purchasedCredits = 0) {
  return prisma.user.create({
    data: {
      email: `lc-${Math.random().toString(36).slice(2, 8)}@test.local`,
      creditsBalance,
      purchasedCredits,
    },
  });
}

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.notification.deleteMany();
  await prisma.creditTransaction.deleteMany();
  await prisma.organizationMember.deleteMany();
  await prisma.user.deleteMany();
});

describe('maybeNotifyLowCredits', () => {
  it('creates a low_credits in-app notification when at/below threshold', async () => {
    const user = await createUser(1);
    await maybeNotifyLowCredits(user.id);
    const notifs = await prisma.notification.findMany({
      where: { userId: user.id, type: 'low_credits' },
    });
    expect(notifs).toHaveLength(1);
  });

  it('does NOT notify when the user has plenty of credits', async () => {
    const user = await createUser(10);
    await maybeNotifyLowCredits(user.id);
    const notifs = await prisma.notification.findMany({
      where: { userId: user.id, type: 'low_credits' },
    });
    expect(notifs).toHaveLength(0);
  });

  it('does not re-notify within the 7-day cooldown', async () => {
    const user = await createUser(0);
    await maybeNotifyLowCredits(user.id);
    await maybeNotifyLowCredits(user.id);
    const notifs = await prisma.notification.findMany({
      where: { userId: user.id, type: 'low_credits' },
    });
    expect(notifs).toHaveLength(1);
  });

  it('fires automatically from spendCredit when the spend drops to threshold', async () => {
    const user = await createUser(2);
    await spendCredit(user.id, 'reveal-a'); // 2 -> 1 (low)
    const notifs = await prisma.notification.findMany({
      where: { userId: user.id, type: 'low_credits' },
    });
    expect(notifs).toHaveLength(1);
  });

  it('never throws for an unknown user', async () => {
    await expect(maybeNotifyLowCredits('does-not-exist')).resolves.toBeUndefined();
  });
});

describe('getCreditLedger', () => {
  it('returns newest-first entries with a running balance ending at current balance', async () => {
    const user = await createUser(0);
    await grantCredits(user.id, 5, 'inv_1', 'SUBSCRIPTION_GRANT'); // +5 -> 5
    await spendCredit(user.id, 'reveal-1'); // -1 -> 4
    await spendCredit(user.id, 'reveal-2'); // -1 -> 3

    const { entries, currentBalance } = await getCreditLedger(user.id);
    expect(currentBalance).toBe(3);
    // 3 ledger rows (grant + 2 spends), newest first.
    expect(entries).toHaveLength(3);
    expect(entries[0].delta).toBe(-1);
    // Newest row's running balance equals current balance.
    expect(entries[0].balance).toBe(3);
    // Oldest (grant) row's running balance = its delta = 5.
    expect(entries[entries.length - 1].balance).toBe(5);
    expect(entries[entries.length - 1].delta).toBe(5);
  });

  it('caps results at the requested limit', async () => {
    const user = await createUser(0);
    await grantCredits(user.id, 10, 'inv_cap', 'SUBSCRIPTION_GRANT');
    for (let i = 0; i < 5; i++) await spendCredit(user.id, `r-${i}`);
    const { entries } = await getCreditLedger(user.id, 3);
    expect(entries).toHaveLength(3);
  });
});
