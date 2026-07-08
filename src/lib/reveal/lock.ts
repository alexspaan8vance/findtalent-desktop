/**
 * 14-day exclusive reveal lock.
 *
 * Once a Reveal row exists for `(eightvanceTalentId, tenant)` with
 * `expiresAt > now`, no other user may acquire a fresh reveal on the same
 * talent inside that tenant (talent pool). Reveals across tenants are
 * independent — the lock is scoped directly via `Reveal.tenantId`.
 *
 * Memory `feedback_security_critical`: lock + credit-spend happen in a
 * single Prisma transaction so a race can't double-charge a customer.
 */

import { Prisma } from '@prisma/client';
import type { Reveal } from '@prisma/client';

import { prisma } from '@/lib/db';
import { spendCreditOn, InsufficientCreditsError } from '@/lib/credits';

const REVEAL_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14d

export { InsufficientCreditsError };

export class LockExistsError extends Error {
  public readonly expiresAt: Date;
  public readonly userId: string;
  constructor(expiresAt: Date, userId: string) {
    super(`Talent already revealed in this tenant until ${expiresAt.toISOString()}`);
    this.name = 'LockExistsError';
    this.expiresAt = expiresAt;
    this.userId = userId;
  }
}

export interface LockStatus {
  locked: boolean;
  ownedByCurrentUser?: boolean;
  expiresAt?: Date;
  userId?: string;
  revealId?: string;
}

interface ActiveLockRow {
  userId: string;
  expiresAt: Date;
  revealId: string | null;
}

/**
 * The active lock is the `RevealLock` row for (tenant, talent) whose
 * `expiresAt` is still in the future. The unique constraint on
 * (tenantId, eightvanceTalentId) makes this the single source of truth.
 */
async function findActiveLock(
  tenantId: string,
  eightvanceTalentId: number,
): Promise<ActiveLockRow | null> {
  const row = await prisma.revealLock.findUnique({
    where: { tenantId_eightvanceTalentId: { tenantId, eightvanceTalentId } },
    select: { userId: true, expiresAt: true, revealId: true },
  });
  if (!row || row.expiresAt <= new Date()) return null;
  return row;
}

/**
 * Read-side lock check. Returns who currently owns the talent (if anyone)
 * inside the given tenant.
 */
export async function hasActiveLock(
  eightvanceTalentId: number,
  tenantId: string,
  currentUserId?: string,
): Promise<LockStatus> {
  const row = await findActiveLock(tenantId, eightvanceTalentId);
  if (!row) return { locked: false };
  return {
    locked: true,
    ownedByCurrentUser: currentUserId ? row.userId === currentUserId : false,
    expiresAt: row.expiresAt,
    userId: row.userId,
    revealId: row.revealId ?? undefined,
  };
}

export interface AcquireRevealOpts {
  userId: string;
  projectId: string;
  tenantId: string;
  eightvanceTalentId: number;
  /** AES-GCM ciphertext of the JSON revealed-talent payload. */
  rawProfileEncrypted: string;
}

/**
 * Atomic credit-spend + lock acquire. Throws:
 *   - `LockExistsError` if another user in the same tenant holds the lock.
 *   - `InsufficientCreditsError` if the user has 0 credits.
 */
export async function acquireReveal(opts: AcquireRevealOpts): Promise<Reveal> {
  const { tenantId, eightvanceTalentId, userId, projectId } = opts;
  const key = { tenantId_eightvanceTalentId: { tenantId, eightvanceTalentId } };

  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + REVEAL_TTL_MS);

    // --- Claim the exclusive lock (race-safe via the unique constraint). ---
    let claimed = false;
    try {
      await tx.revealLock.create({
        data: { tenantId, eightvanceTalentId, userId, expiresAt },
      });
      claimed = true; // No prior lock — we hold it.
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) {
        throw e;
      }
      // A lock row already exists.
      const cur = await tx.revealLock.findUnique({ where: key });
      if (cur && cur.expiresAt > now) {
        if (cur.userId !== userId) {
          throw new LockExistsError(cur.expiresAt, cur.userId);
        }
        // Current user already holds the active lock. If a valid Reveal is
        // linked, return it WITHOUT charging again (we already paid for it).
        if (cur.revealId) {
          const r = await tx.reveal.findUnique({ where: { id: cur.revealId } });
          if (r) return r;
        }
        // Held by me but no VALID reveal exists (revealId null, or the linked
        // Reveal row is gone). We're about to create a fresh Reveal below, so
        // this is effectively a new reveal and MUST spend a credit — same as a
        // freshly-claimed lock. Mark it claimed so the spend gate fires.
        claimed = true;
      } else {
        // Expired lock → take it over, but only if it's still expired (a
        // concurrent winner would have bumped expiresAt). count===0 ⇒ lost.
        const upd = await tx.revealLock.updateMany({
          where: { tenantId, eightvanceTalentId, expiresAt: { lte: now } },
          data: { userId, expiresAt, revealId: null },
        });
        if (upd.count === 0) {
          const w = await tx.revealLock.findUnique({ where: key });
          if (w) throw new LockExistsError(w.expiresAt, w.userId);
          throw new Error('reveal lock takeover failed');
        }
        claimed = true;
      }
    }

    // --- Spend a credit whenever we're about to create a NEW Reveal row:
    // a freshly-claimed lock, an expired-lock takeover, or a lock we hold but
    // with no valid linked Reveal. The only no-spend path is returning an
    // existing valid Reveal, which already returned above. ---
    if (claimed) {
      await spendCreditOn(tx, userId, `reveal:${projectId}:${eightvanceTalentId}`, 'REVEAL');
    }

    // --- Create the reveal (append-only history; the active lock above is the
    // exclusivity guard). ---
    const reveal = await tx.reveal.create({
      data: {
        projectId,
        userId,
        tenantId,
        eightvanceTalentId,
        revealedAt: now,
        expiresAt,
        creditCost: 1,
        piiPayloadEnc: opts.rawProfileEncrypted,
      },
    });

    await tx.revealLock.update({
      where: key,
      data: { revealId: reveal.id, expiresAt },
    });

    return reveal;
  });
}
