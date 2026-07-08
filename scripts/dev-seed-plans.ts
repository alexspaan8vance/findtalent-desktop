#!/usr/bin/env tsx
/**
 * Dev-only Plan seed.
 *
 * Inserts the 3 tier rows into the Plan table with placeholder Stripe
 * price IDs (`price_dev_<key>`). The choose-plan UI renders, but starting
 * a real checkout will fail until you swap in real Stripe price IDs via
 * `npm run stripe:seed`.
 *
 * Usage:  npx tsx scripts/dev-seed-plans.ts
 */
import { prisma } from '../src/lib/db';
import { PLAN_TIERS, EXTRA_CREDIT_PRICE_EUR } from '../src/lib/stripe/plans';

async function main() {
  for (const tier of PLAN_TIERS) {
    const stripePriceId = `price_dev_${tier.key}`;
    const row = await prisma.plan.upsert({
      where: { stripePriceId },
      create: {
        stripePriceId,
        name: tier.name,
        priceEur: tier.priceEur,
        creditsPerPeriod: tier.creditsPerPeriod,
        periodMonths: tier.periodMonths,
        featuresJson: { tierKey: tier.key, devSeed: true },
        active: true,
      },
      update: {
        name: tier.name,
        priceEur: tier.priceEur,
        creditsPerPeriod: tier.creditsPerPeriod,
        periodMonths: tier.periodMonths,
        active: true,
      },
    });
    console.log(`plan: ${row.name} €${row.priceEur} / ${row.creditsPerPeriod} credits  (id=${row.id})`);
  }

  const extra = await prisma.plan.upsert({
    where: { stripePriceId: 'price_dev_extra-credit' },
    create: {
      stripePriceId: 'price_dev_extra-credit',
      name: 'Extra credit',
      priceEur: EXTRA_CREDIT_PRICE_EUR,
      creditsPerPeriod: 1,
      periodMonths: 0,
      featuresJson: { tierKey: 'extra-credit', devSeed: true },
      active: true,
    },
    update: {
      priceEur: EXTRA_CREDIT_PRICE_EUR,
      active: true,
    },
  });
  console.log(`extra: ${extra.name} €${extra.priceEur}  (id=${extra.id})`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
