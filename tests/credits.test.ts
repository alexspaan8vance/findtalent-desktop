import { describe, it, expect, afterAll, beforeEach } from "vitest";

import { PrismaClient } from "@prisma/client";
import {
  spendCredit,
  grantCredits,
  availableCredits,
  InsufficientCreditsError,
} from "../src/lib/credits";

const prisma = new PrismaClient();

async function createUser(creditsBalance = 0, purchasedCredits = 0) {
  return prisma.user.create({
    data: {
      email: `u-${Math.random().toString(36).slice(2, 8)}@test.local`,
      creditsBalance,
      purchasedCredits,
    },
  });
}

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.creditTransaction.deleteMany();
  await prisma.user.deleteMany();
});

describe("credits ledger", () => {
  it("spendCredit decrements balance and writes ledger row", async () => {
    const user = await createUser(2);
    await spendCredit(user.id, "reveal-1");
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.creditsBalance).toBe(1);
    const tx = await prisma.creditTransaction.findMany({ where: { userId: user.id } });
    expect(tx).toHaveLength(1);
    expect(tx[0].delta).toBe(-1);
    expect(tx[0].reason).toBe("REVEAL");
    expect(tx[0].refId).toBe("reveal-1");
  });

  it("spendCredit throws InsufficientCreditsError at 0 balance and rolls back", async () => {
    const user = await createUser(0);
    await expect(spendCredit(user.id, "reveal-x")).rejects.toBeInstanceOf(
      InsufficientCreditsError
    );
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.creditsBalance).toBe(0);
    const tx = await prisma.creditTransaction.findMany({ where: { userId: user.id } });
    expect(tx).toHaveLength(0);
  });

  it("grantCredits increments balance and appends ledger entry", async () => {
    const user = await createUser(0);
    await grantCredits(user.id, 4, "inv_123", "SUBSCRIPTION_GRANT");
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.creditsBalance).toBe(4);
    const tx = await prisma.creditTransaction.findMany({ where: { userId: user.id } });
    expect(tx).toHaveLength(1);
    expect(tx[0].delta).toBe(4);
    expect(tx[0].reason).toBe("SUBSCRIPTION_GRANT");
  });

  it("grantCredits rejects non-positive amounts", async () => {
    const user = await createUser(0);
    await expect(grantCredits(user.id, 0, null, "INITIAL")).rejects.toThrow();
    await expect(grantCredits(user.id, -1, null, "INITIAL")).rejects.toThrow();
  });

  it("grantCredits target='purchased' increments purchasedCredits, not creditsBalance", async () => {
    const user = await createUser(2, 0);
    await grantCredits(user.id, 3, "cs_pack", "PURCHASE", "purchased");
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.creditsBalance).toBe(2);
    expect(after.purchasedCredits).toBe(3);
    expect(availableCredits(after)).toBe(5);
  });

  it("grantCredits with an idempotencyKey is at-most-once (second call is a no-op)", async () => {
    const user = await createUser(0, 0);
    const first = await grantCredits(
      user.id,
      3,
      "cs_dup",
      "PURCHASE",
      "purchased",
      "purchase:cs_dup"
    );
    expect(first).toBe(true);

    // Same key again → skipped: balance unchanged, no second ledger row.
    const second = await grantCredits(
      user.id,
      3,
      "cs_dup",
      "PURCHASE",
      "purchased",
      "purchase:cs_dup"
    );
    expect(second).toBe(false);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.purchasedCredits).toBe(3);
    const tx = await prisma.creditTransaction.findMany({ where: { userId: user.id } });
    expect(tx).toHaveLength(1);
  });

  it("grantCredits without an idempotencyKey still stacks (returns true each time)", async () => {
    const user = await createUser(0, 0);
    expect(await grantCredits(user.id, 2, "a", "ADMIN_ADJUST")).toBe(true);
    expect(await grantCredits(user.id, 2, "b", "ADMIN_ADJUST")).toBe(true);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.creditsBalance).toBe(4);
    const tx = await prisma.creditTransaction.findMany({ where: { userId: user.id } });
    expect(tx).toHaveLength(2);
  });

  it("spendCredit draws from subscription balance first, then purchased", async () => {
    const user = await createUser(1, 2);
    // First spend: subscription credit.
    await spendCredit(user.id, "reveal-1");
    let after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.creditsBalance).toBe(0);
    expect(after.purchasedCredits).toBe(2);

    // Subscription exhausted — next spend draws from purchased.
    await spendCredit(user.id, "reveal-2");
    after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.creditsBalance).toBe(0);
    expect(after.purchasedCredits).toBe(1);
  });

  it("spendCredit succeeds on purchased-only credits", async () => {
    const user = await createUser(0, 1);
    await spendCredit(user.id, "reveal-pack");
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.creditsBalance).toBe(0);
    expect(after.purchasedCredits).toBe(0);
  });

  it("spendCredit throws only when BOTH buckets are exhausted and never goes negative", async () => {
    const user = await createUser(0, 0);
    await expect(spendCredit(user.id, "reveal-x")).rejects.toBeInstanceOf(
      InsufficientCreditsError
    );
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.creditsBalance).toBe(0);
    expect(after.purchasedCredits).toBe(0);
    const tx = await prisma.creditTransaction.findMany({ where: { userId: user.id } });
    expect(tx).toHaveLength(0);
  });
});
