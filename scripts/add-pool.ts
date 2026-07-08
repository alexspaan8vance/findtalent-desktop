#!/usr/bin/env tsx
/**
 * Create an extra talent pool (Tenant) for local multi-pool testing.
 *
 * Defaults the 8vance credentials to the .env IVTA creds, so the second pool
 * resolves against a real company. Swap in another company's creds via CLI
 * args once available.
 *
 * Usage:
 *   npx tsx scripts/add-pool.ts <slug> <name> [locale] [clientId] [secret] [companyId]
 */
import { prisma } from '../src/lib/db';
import { encrypt, assertCryptoReady } from '../src/lib/crypto';

async function main() {
  const [slug, name, localeArg, clientIdArg, secretArg, companyIdArg] =
    process.argv.slice(2);
  if (!slug || !name) {
    console.error('Usage: add-pool.ts <slug> <name> [locale] [clientId] [secret] [companyId]');
    process.exit(1);
  }
  assertCryptoReady();

  const clientId = clientIdArg ?? process.env.EIGHTVANCE_CLIENT_ID;
  const clientSecret = secretArg ?? process.env.EIGHTVANCE_CLIENT_SECRET;
  const companyId = Number.parseInt(
    companyIdArg ?? process.env.EIGHTVANCE_COMPANY_ID ?? '',
    10,
  );
  const locale = (localeArg ?? 'en').toLowerCase();
  if (!clientId || !clientSecret || !Number.isFinite(companyId)) {
    console.error('Missing 8vance creds (env or args).');
    process.exit(1);
  }

  const tenant = await prisma.tenant.upsert({
    where: { slug },
    create: {
      slug,
      name,
      eightvanceClientId: clientId,
      eightvanceClientSecretEnc: encrypt(clientSecret),
      eightvanceCompanyId: companyId,
      brandConfigJson: { name, primaryColor: '#0f172a' },
      defaultLocale: locale,
    },
    update: { name, defaultLocale: locale },
  });
  console.log(`pool: ${tenant.slug} (${tenant.id}) company=${tenant.eightvanceCompanyId} locale=${tenant.defaultLocale}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
