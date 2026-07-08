import { Prisma } from "@prisma/client";

import { prisma } from "./db";
import { notify } from "./notifications/deliver";
import type { CreditReason } from "@prisma/client";

const BASE_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
/** Where the low-credit email + banner send users to top up. */
const BUY_CREDITS_URL = `${BASE_URL.replace(/\/$/, "")}/billing/choose-plan`;

/** At-or-below this many available credits we consider the user "low". */
export const LOW_CREDITS_THRESHOLD = 1;
/** Don't re-notify about low credits more than once per this window. */
const LOW_CREDITS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export class InsufficientCreditsError extends Error {
  constructor(message = "Insufficient credits") {
    super(message);
    this.name = "InsufficientCreditsError";
  }
}

/**
 * Anything that can run a query: the (extended) base client or the transaction
 * client it hands to `$transaction`. Derived from the extended client so the
 * `tx` callback arg — whose model methods carry the extension's arg types —
 * stays assignable after `prisma.$extends(candidatePiiExtension)`.
 */
type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type Executor = TxClient | typeof prisma;

/** Which credit bucket a grant lands in. */
export type GrantTarget = "subscription" | "purchased";

/**
 * Total spendable credits for a user. Subscription credits
 * (`creditsBalance`, use-it-or-lose-it) plus purchased pack credits
 * (`purchasedCredits`, roll-over).
 */
export function availableCredits(user: {
  creditsBalance: number;
  purchasedCredits: number;
}): number {
  return user.creditsBalance + user.purchasedCredits;
}

/**
 * Spend a single credit on the given executor. Draws from subscription
 * credits (`creditsBalance`) FIRST, then purchased pack credits
 * (`purchasedCredits`).
 *
 * Each decrement is a CONDITIONAL update (`>= 1`) so it's atomic without
 * relying on isolation level — two concurrent spends can't both pass a stale
 * read and overspend (the TOCTOU a read-then-write has on Postgres). Writes
 * the ledger entry too. Throws InsufficientCreditsError only when BOTH
 * buckets are exhausted.
 *
 * Pass a `tx` to spend as part of a larger transaction (e.g. credit + reveal
 * lock together), so a failure rolls back the spend automatically.
 */
export async function spendCreditOn(
  db: Executor,
  userId: string,
  refId: string,
  reason: CreditReason = "REVEAL"
): Promise<void> {
  // Try subscription credits first (use-it-or-lose-it, so spend these before
  // they're reset at renewal).
  const sub = await db.user.updateMany({
    where: { id: userId, creditsBalance: { gte: 1 } },
    data: { creditsBalance: { decrement: 1 } },
  });
  if (sub.count === 0) {
    // Fall back to purchased pack credits (roll-over).
    const pack = await db.user.updateMany({
      where: { id: userId, purchasedCredits: { gte: 1 } },
      data: { purchasedCredits: { decrement: 1 } },
    });
    if (pack.count === 0) {
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!user) throw new Error(`User ${userId} not found`);
      throw new InsufficientCreditsError();
    }
  }
  await db.creditTransaction.create({
    data: { userId, delta: -1, reason, refId },
  });
}

/** Spend a single credit in its own transaction. */
export async function spendCredit(
  userId: string,
  refId: string,
  reason: CreditReason = "REVEAL"
): Promise<void> {
  await prisma.$transaction((tx) => spendCreditOn(tx, userId, refId, reason));
  // Post-commit: warn the user if this spend dropped them to a low balance.
  // Guarded so a notification failure can never undo or surface from the spend.
  await maybeNotifyLowCredits(userId);
}

/**
 * Grant credits and append a ledger entry, atomically.
 *
 * `target` decides the bucket:
 *   - "subscription" (default): `creditsBalance` — reset each period.
 *   - "purchased": `purchasedCredits` — never reset, rolls over.
 *
 * `idempotencyKey` (optional) makes the grant at-most-once across retries /
 * webhook re-runs: it's stored on the ledger row under a UNIQUE constraint, so a
 * duplicate grant collides (P2002) and is swallowed as a no-op. Pass a stable,
 * per-operation key (e.g. `purchase:<stripe_session_id>`) for anything a webhook
 * or Stripe retry could re-deliver.
 *
 * Returns `true` when the grant was applied, `false` when it was skipped because
 * the `idempotencyKey` was already used (already-applied — no double count).
 */
export async function grantCredits(
  userId: string,
  amount: number,
  refId: string | null,
  reason: CreditReason,
  target: GrantTarget = "subscription",
  idempotencyKey?: string | null
): Promise<boolean> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("grantCredits: amount must be a positive integer");
  }
  try {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!user) {
        throw new Error(`User ${userId} not found`);
      }
      // Write the ledger row FIRST so a duplicate `idempotencyKey` aborts the
      // whole transaction (P2002) BEFORE the balance is touched — a re-run is
      // then a clean no-op instead of a double count.
      await tx.creditTransaction.create({
        data: {
          userId,
          delta: amount,
          reason,
          refId: refId ?? undefined,
          idempotencyKey: idempotencyKey ?? undefined,
        },
      });
      await tx.user.update({
        where: { id: userId },
        data:
          target === "purchased"
            ? { purchasedCredits: { increment: amount } }
            : { creditsBalance: { increment: amount } },
      });
    });
    return true;
  } catch (err) {
    // A unique-constraint hit on a provided idempotencyKey means this exact
    // grant already landed (a webhook re-run / Stripe retry). Swallow it so the
    // operation stays at-most-once; anything else propagates.
    if (
      idempotencyKey &&
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return false;
    }
    throw err;
  }
}

/**
 * Fire a `low_credits` notification (in-app + email) when the user is at or
 * below {@link LOW_CREDITS_THRESHOLD} available credits AND we haven't already
 * sent one in the last 7 days (anti-spam). Safe to call after any spend: it
 * never throws — a notification problem must not break the credit operation
 * that triggered it.
 */
export async function maybeNotifyLowCredits(userId: string): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { creditsBalance: true, purchasedCredits: true, name: true },
    });
    if (!user) return;

    const credits = availableCredits(user);
    if (credits > LOW_CREDITS_THRESHOLD) return;

    // Anti-spam: skip if a low_credits notification went out recently.
    const since = new Date(Date.now() - LOW_CREDITS_COOLDOWN_MS);
    const recent = await prisma.notification.findFirst({
      where: { userId, type: "low_credits", createdAt: { gte: since } },
      select: { id: true },
    });
    if (recent) return;

    // org name is best-effort metadata for the email; never block on it.
    let orgName = "";
    try {
      const member = await prisma.organizationMember.findFirst({
        where: { userId },
        select: { organization: { select: { name: true } } },
      });
      orgName = member?.organization?.name ?? "";
    } catch {
      /* ignore — orgName is optional copy */
    }

    await notify({
      userId,
      type: "low_credits",
      payload: { credits },
      email: {
        templateKey: "low_credits",
        vars: {
          userName: user.name ?? "",
          orgName,
          credits,
          link: BUY_CREDITS_URL,
        },
      },
    });
  } catch {
    // Swallow: low-credit notification is advisory and must never break a spend.
  }
}

/** A single ledger row for display (delta with running balance applied). */
export interface LedgerEntry {
  id: string;
  createdAt: Date;
  delta: number;
  reason: CreditReason;
  refId: string | null;
  /** Running available-credit balance AFTER this entry (oldest-to-newest). */
  balance: number;
}

/**
 * Return the user's credit ledger, newest first, capped at `limit` (default
 * 100). A running balance is computed across the returned window: the most
 * recent entry's running balance equals the user's current available credits,
 * and each older entry shows the balance as of that point in the window.
 */
export async function getCreditLedger(
  userId: string,
  limit = 100
): Promise<{ entries: LedgerEntry[]; currentBalance: number }> {
  const [user, rows] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { creditsBalance: true, purchasedCredits: true },
    }),
    prisma.creditTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: Math.max(1, Math.min(limit, 500)),
      select: { id: true, createdAt: true, delta: true, reason: true, refId: true },
    }),
  ]);

  const currentBalance = user ? availableCredits(user) : 0;

  // Walk newest -> oldest. The newest row's post-balance is the current
  // balance; each step back subtracts that row's delta to get the prior state.
  let running = currentBalance;
  const entries: LedgerEntry[] = rows.map((r) => {
    const balance = running;
    running -= r.delta;
    return { ...r, balance };
  });

  return { entries, currentBalance };
}
