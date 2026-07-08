import type Stripe from 'stripe';

import { prisma } from '@/lib/db';
import { stripe } from './client';
import {
  EXTRA_CREDIT_TIER_KEY,
  FINDTALENT_TIER_METADATA_KEY,
  type PlanKey,
} from './types';

/**
 * Subscription tier catalog. Single source of truth for the billing config —
 * Stripe products and our local `Plan` rows are seeded from this list.
 *
 * Pricing is in EUR cents on the Stripe side; we keep the `priceEur` value in
 * whole euros for readability and multiply at create-time.
 */
export const PLAN_TIERS = [
  { key: 'try', name: 'Try', priceEur: 99, creditsPerPeriod: 1, periodMonths: 2 },
  { key: 'basic', name: 'Basic', priceEur: 249, creditsPerPeriod: 2, periodMonths: 2 },
  { key: 'pro', name: 'Pro', priceEur: 499, creditsPerPeriod: 4, periodMonths: 2 },
] as const;

export type PlanTier = (typeof PLAN_TIERS)[number];

/**
 * One-off "Extra credit" price — sold as a credit pack outside the subscription
 * lifecycle.
 */
export const EXTRA_CREDIT_PRICE_EUR = 125;

export interface SeededPlan {
  tier: PlanKey | typeof EXTRA_CREDIT_TIER_KEY;
  productId: string;
  priceId: string;
  planRowId: string | null;
}

/**
 * Find a Stripe product by our `findtalent_tier` metadata key. Stripe's search
 * API supports `metadata['key']:'value'` syntax; we add a small guard for
 * pagination quirks by trusting the first match (tier keys are unique).
 */
async function findProductByTier(
  tier: string,
): Promise<Stripe.Product | null> {
  const search = await stripe.products.search({
    query: `metadata['${FINDTALENT_TIER_METADATA_KEY}']:'${tier}' AND active:'true'`,
    limit: 1,
  });
  return search.data[0] ?? null;
}

/**
 * Find an active price for a given product. We always create exactly one price
 * per product in this seeder, so picking the first active one is sufficient.
 */
async function findActivePriceForProduct(
  productId: string,
): Promise<Stripe.Price | null> {
  const prices = await stripe.prices.list({
    product: productId,
    active: true,
    limit: 1,
  });
  return prices.data[0] ?? null;
}

/**
 * Idempotently create the Stripe products + prices that back our subscription
 * tiers and the extra-credit pack, then upsert a matching `Plan` row keyed by
 * `stripePriceId`. Safe to run repeatedly — existing products/prices are
 * detected via `metadata.findtalent_tier` and re-used.
 */
export async function seedStripeProducts(): Promise<SeededPlan[]> {
  const result: SeededPlan[] = [];

  // Subscription tiers.
  for (const tier of PLAN_TIERS) {
    let product = await findProductByTier(tier.key);
    if (!product) {
      product = await stripe.products.create({
        name: tier.name,
        metadata: {
          [FINDTALENT_TIER_METADATA_KEY]: tier.key,
        },
      });
    }

    let price = await findActivePriceForProduct(product.id);
    if (!price) {
      price = await stripe.prices.create({
        product: product.id,
        unit_amount: tier.priceEur * 100,
        currency: 'eur',
        recurring: {
          interval: 'month',
          interval_count: tier.periodMonths,
        },
        metadata: {
          [FINDTALENT_TIER_METADATA_KEY]: tier.key,
        },
      });
    }

    const planRow = await prisma.plan.upsert({
      where: { stripePriceId: price.id },
      create: {
        stripePriceId: price.id,
        name: tier.name,
        priceEur: tier.priceEur,
        creditsPerPeriod: tier.creditsPerPeriod,
        periodMonths: tier.periodMonths,
        featuresJson: { tierKey: tier.key },
        active: true,
      },
      update: {
        name: tier.name,
        priceEur: tier.priceEur,
        creditsPerPeriod: tier.creditsPerPeriod,
        periodMonths: tier.periodMonths,
        featuresJson: { tierKey: tier.key },
        active: true,
      },
    });

    result.push({
      tier: tier.key,
      productId: product.id,
      priceId: price.id,
      planRowId: planRow.id,
    });
  }

  // Extra-credit one-off pack.
  let extraProduct = await findProductByTier(EXTRA_CREDIT_TIER_KEY);
  if (!extraProduct) {
    extraProduct = await stripe.products.create({
      name: 'Extra credit',
      metadata: {
        [FINDTALENT_TIER_METADATA_KEY]: EXTRA_CREDIT_TIER_KEY,
      },
    });
  }

  let extraPrice = await findActivePriceForProduct(extraProduct.id);
  if (!extraPrice) {
    extraPrice = await stripe.prices.create({
      product: extraProduct.id,
      unit_amount: EXTRA_CREDIT_PRICE_EUR * 100,
      currency: 'eur',
      // No `recurring` — one-off payment.
      metadata: {
        [FINDTALENT_TIER_METADATA_KEY]: EXTRA_CREDIT_TIER_KEY,
      },
    });
  }

  result.push({
    tier: EXTRA_CREDIT_TIER_KEY,
    productId: extraProduct.id,
    priceId: extraPrice.id,
    // The extra-credit pack isn't represented as a Plan row — it's a one-shot
    // SKU, not a subscription tier.
    planRowId: null,
  });

  return result;
}
