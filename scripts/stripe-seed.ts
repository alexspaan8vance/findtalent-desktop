/**
 * Stripe seed script.
 *
 * Run with: `npm run stripe:seed`
 *
 * Idempotent: re-runs detect existing products/prices via their
 * `findtalent_tier` metadata and only create what's missing.
 */
import { seedStripeProducts } from '../src/lib/stripe/plans';

async function main(): Promise<void> {
  const seeded = await seedStripeProducts();

  // Print a small table-ish summary so the operator can verify ids in
  // the Stripe dashboard.
  const rows = seeded.map((row) => ({
    tier: row.tier,
    productId: row.productId,
    priceId: row.priceId,
    planRowId: row.planRowId ?? '-',
  }));
  console.log('Seeded Stripe products + Plan rows:');
  console.table(rows);
}

main().catch((err: unknown) => {
  console.error('stripe:seed failed:', err);
  process.exit(1);
});
