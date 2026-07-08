'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth-helpers';
import { stripe } from '@/lib/stripe/client';
import { FINDTALENT_TIER_METADATA_KEY } from '@/lib/stripe/types';

/**
 * Admin plan management. Every mutation is gated behind `requireAdmin` and
 * written to `AdminAuditLog`. Stripe failures are logged server-side and
 * surfaced to the caller only as a generic, non-sensitive error.
 */

class PlanActionError extends Error {}

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  priceEur: z.coerce.number().int().min(0).max(100_000),
  creditsPerPeriod: z.coerce.number().int().min(0).max(10_000),
  periodMonths: z.coerce.number().int().min(1).max(36),
});

const editSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  creditsPerPeriod: z.coerce.number().int().min(0).max(10_000),
  periodMonths: z.coerce.number().int().min(1).max(36),
  active: z
    .union([z.literal('on'), z.literal('true'), z.literal('false'), z.null()])
    .transform((v) => v === 'on' || v === 'true'),
});

const idSchema = z.object({ id: z.string().min(1) });

/**
 * Create a new subscription plan: provisions a Stripe product + recurring
 * price, then persists a local `Plan` row keyed by the new price id.
 */
export async function createPlanAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const data = createSchema.parse({
    name: formData.get('name'),
    priceEur: formData.get('priceEur'),
    creditsPerPeriod: formData.get('creditsPerPeriod'),
    periodMonths: formData.get('periodMonths'),
  });

  let priceId: string;
  let productId: string;
  try {
    const product = await stripe.products.create({
      name: data.name,
      metadata: { [FINDTALENT_TIER_METADATA_KEY]: 'custom' },
    });
    productId = product.id;
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: data.priceEur * 100,
      currency: 'eur',
      recurring: { interval: 'month', interval_count: data.periodMonths },
      metadata: { [FINDTALENT_TIER_METADATA_KEY]: 'custom' },
    });
    priceId = price.id;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      '[admin-plans] stripe create failed:',
      err instanceof Error ? err.message : 'unknown',
    );
    throw new PlanActionError('Could not create the plan in Stripe.');
  }

  const plan = await prisma.plan.create({
    data: {
      stripePriceId: priceId,
      name: data.name,
      priceEur: data.priceEur,
      creditsPerPeriod: data.creditsPerPeriod,
      periodMonths: data.periodMonths,
      featuresJson: { tierKey: 'custom', stripeProductId: productId },
      active: true,
    },
  });

  await prisma.adminAuditLog.create({
    data: {
      adminUserId: admin.id,
      action: 'plan.create',
      targetType: 'Plan',
      targetId: plan.id,
      payloadJson: {
        name: data.name,
        priceEur: data.priceEur,
        creditsPerPeriod: data.creditsPerPeriod,
        periodMonths: data.periodMonths,
        stripePriceId: priceId,
      },
    },
  });

  revalidatePath('/admin/plans');
}

/**
 * Edit a plan's local metadata (name, credits, period, active). The Stripe
 * PRICE is immutable, so the euro amount can't be edited here — create a new
 * plan instead.
 */
export async function editPlanAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const data = editSchema.parse({
    id: formData.get('id'),
    name: formData.get('name'),
    creditsPerPeriod: formData.get('creditsPerPeriod'),
    periodMonths: formData.get('periodMonths'),
    active: formData.get('active'),
  });

  const existing = await prisma.plan.findUnique({ where: { id: data.id } });
  if (!existing) throw new PlanActionError('Plan not found.');

  await prisma.plan.update({
    where: { id: data.id },
    data: {
      name: data.name,
      creditsPerPeriod: data.creditsPerPeriod,
      periodMonths: data.periodMonths,
      active: data.active,
    },
  });

  await prisma.adminAuditLog.create({
    data: {
      adminUserId: admin.id,
      action: 'plan.edit',
      targetType: 'Plan',
      targetId: data.id,
      payloadJson: {
        name: data.name,
        creditsPerPeriod: data.creditsPerPeriod,
        periodMonths: data.periodMonths,
        active: data.active,
      },
    },
  });

  revalidatePath('/admin/plans');
}

/**
 * Deactivate a plan: hides it from checkout (active=false) and best-effort
 * archives the backing Stripe price so it can't be subscribed to.
 */
export async function deactivatePlanAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const { id } = idSchema.parse({ id: formData.get('id') });

  const plan = await prisma.plan.findUnique({ where: { id } });
  if (!plan) throw new PlanActionError('Plan not found.');

  await prisma.plan.update({ where: { id }, data: { active: false } });

  // Best-effort: archive the Stripe price. A failure here must not block the
  // local deactivation (which is what actually gates checkout).
  try {
    await stripe.prices.update(plan.stripePriceId, { active: false });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[admin-plans] could not archive stripe price:',
      err instanceof Error ? err.message : 'unknown',
    );
  }

  await prisma.adminAuditLog.create({
    data: {
      adminUserId: admin.id,
      action: 'plan.deactivate',
      targetType: 'Plan',
      targetId: id,
      payloadJson: { stripePriceId: plan.stripePriceId },
    },
  });

  revalidatePath('/admin/plans');
}
