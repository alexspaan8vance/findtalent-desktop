'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth-helpers';
import { grantCredits } from '@/lib/credits';

/**
 * Admin user credit operations. All gated behind `requireAdmin` and written to
 * `AdminAuditLog`. Credit math is atomic and clamped so a balance can never go
 * negative.
 */

class UserActionError extends Error {}

const grantSchema = z.object({
  userId: z.string().min(1),
  amount: z.coerce.number().int().refine((n) => n !== 0, 'amount must be non-zero'),
  note: z.string().trim().max(200).optional(),
});

const refundSchema = z.object({
  userId: z.string().min(1),
  amount: z.coerce.number().int().positive(),
  note: z.string().trim().max(200).optional(),
  // Original Stripe purchase/checkout-session id being refunded. When provided,
  // it makes the refund idempotent: the same purchase can't be refunded twice
  // (the CreditTransaction.idempotencyKey unique constraint rejects a duplicate).
  sessionId: z.string().trim().max(200).optional(),
});

/**
 * Grant or adjust a user's SUBSCRIPTION credits.
 *  - amount > 0 → adds credits via `grantCredits` (reason ADMIN_ADJUST).
 *  - amount < 0 → removes credits atomically, clamped at 0 (never negative),
 *    with a matching negative ledger row.
 */
export async function adjustCreditsAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const { userId, amount, note } = grantSchema.parse({
    userId: formData.get('userId'),
    amount: formData.get('amount'),
    note: formData.get('note') ?? undefined,
  });

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!target) throw new UserActionError('User not found.');

  const refId = `admin:${admin.id}`;

  if (amount > 0) {
    await grantCredits(userId, amount, refId, 'ADMIN_ADJUST', 'subscription');
  } else {
    // Negative adjustment: conditional decrement so we never go below 0, then
    // record the ACTUAL amount removed in the ledger.
    const want = Math.abs(amount);
    await prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({
        where: { id: userId },
        select: { creditsBalance: true },
      });
      if (!u) throw new UserActionError('User not found.');
      const removed = Math.min(want, u.creditsBalance);
      if (removed > 0) {
        await tx.user.update({
          where: { id: userId },
          data: { creditsBalance: { decrement: removed } },
        });
        await tx.creditTransaction.create({
          data: { userId, delta: -removed, reason: 'ADMIN_ADJUST', refId },
        });
      }
    });
  }

  await prisma.adminAuditLog.create({
    data: {
      adminUserId: admin.id,
      action: 'user.credits.adjust',
      targetType: 'User',
      targetId: userId,
      payloadJson: { amount, note: note ?? null, bucket: 'subscription' },
    },
  });

  revalidatePath('/admin/users');
}

/**
 * Refund credits to a user's PURCHASED (roll-over) bucket. Used when reversing
 * a paid credit-pack purchase. Always positive; reason REFUND.
 */
export async function refundCreditsAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const { userId, amount, note, sessionId } = refundSchema.parse({
    userId: formData.get('userId'),
    amount: formData.get('amount'),
    note: formData.get('note') ?? undefined,
    sessionId: formData.get('sessionId') ?? undefined,
  });

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!target) throw new UserActionError('User not found.');

  // When the admin supplies the original purchase/session id, key the refund on
  // it so a double-click / repeat submission can't refund the same purchase
  // twice (grantCredits returns false when the idempotency key was already used).
  const idempotencyKey = sessionId ? `refund:${sessionId}` : undefined;
  const refId = sessionId ? `refund:${sessionId}` : `refund:${admin.id}`;
  const applied = await grantCredits(
    userId,
    amount,
    refId,
    'REFUND',
    'purchased',
    idempotencyKey,
  );
  if (!applied) {
    throw new UserActionError('This purchase has already been refunded.');
  }

  await prisma.adminAuditLog.create({
    data: {
      adminUserId: admin.id,
      action: 'user.credits.refund',
      targetType: 'User',
      targetId: userId,
      payloadJson: {
        amount,
        note: note ?? null,
        bucket: 'purchased',
        sessionId: sessionId ?? null,
      },
    },
  });

  revalidatePath('/admin/users');
}
