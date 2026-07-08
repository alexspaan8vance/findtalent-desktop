import { grantCredits } from '../src/lib/credits';
import { prisma } from '../src/lib/db';

/**
 * Dev/admin utility: grant subscription credits to a user by email.
 *
 * Routes through the real `grantCredits()` engine so the ledger stays
 * consistent (sum(CreditTransaction.delta) == balance): it INCREMENTS the
 * bucket AND writes a matching ADMIN_ADJUST ledger row. The previous version
 * did `data:{ creditsBalance: amount }` — a raw SET with no ledger row, which
 * permanently desynced sum(deltas) from the balance. NOTE: semantics are now
 * "add N credits" (increment), not "set balance to N".
 */
async function main() {
  const email = process.argv[2];
  const amount = Number.parseInt(process.argv[3] ?? '5', 10);
  if (!email) {
    console.error('usage: grant-credits.ts <email> <amount>');
    process.exit(1);
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    console.error('amount must be a positive integer');
    process.exit(1);
  }
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) {
    console.error(`no user with email ${email}`);
    process.exit(1);
  }
  await grantCredits(user.id, amount, 'script:grant-credits', 'ADMIN_ADJUST', 'subscription');
  const after = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { email: true, creditsBalance: true, purchasedCredits: true },
  });
  console.log(
    `granted ${amount} to ${after.email}; creditsBalance=${after.creditsBalance} purchasedCredits=${after.purchasedCredits}`,
  );
  await prisma.$disconnect();
}
main();
