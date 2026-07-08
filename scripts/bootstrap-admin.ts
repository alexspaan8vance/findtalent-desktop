#!/usr/bin/env tsx
/**
 * Bootstrap the first super-admin + IVTA tenant.
 *
 * Reads the IVTA 8vance credentials + ENCRYPTION_KEY from .env and creates:
 *   - Tenant row `ivta` with encrypted creds
 *   - User row (ADMIN role) with given email + password (passed as CLI args)
 *
 * Idempotent: existing rows are left intact, missing pieces are added.
 *
 * Usage:
 *   npx tsx scripts/bootstrap-admin.ts admin@example.com 'StrongPassword!'
 */
import bcrypt from 'bcryptjs';

import { prisma } from '../src/lib/db';
import { encrypt, assertCryptoReady } from '../src/lib/crypto';

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: bootstrap-admin.ts <email> <password>');
    process.exit(1);
  }
  assertCryptoReady();

  const slug = process.env.TENANT_SLUG ?? 'ivta';
  const clientId = process.env.EIGHTVANCE_CLIENT_ID;
  const clientSecret = process.env.EIGHTVANCE_CLIENT_SECRET;
  const companyIdRaw = process.env.EIGHTVANCE_COMPANY_ID;
  if (!clientId || !clientSecret || !companyIdRaw) {
    console.error('EIGHTVANCE_CLIENT_ID / EIGHTVANCE_CLIENT_SECRET / EIGHTVANCE_COMPANY_ID must be set in .env');
    process.exit(1);
  }
  const companyId = Number.parseInt(companyIdRaw, 10);
  if (!Number.isFinite(companyId)) {
    console.error('EIGHTVANCE_COMPANY_ID must be numeric');
    process.exit(1);
  }

  const tenant = await prisma.tenant.upsert({
    where: { slug },
    create: {
      slug,
      name: process.env.BRAND_NAME ?? slug,
      eightvanceClientId: clientId,
      eightvanceClientSecretEnc: encrypt(clientSecret),
      eightvanceCompanyId: companyId,
      brandConfigJson: {
        name: process.env.BRAND_NAME ?? 'FindTalent',
        primaryColor: process.env.BRAND_PRIMARY_COLOR ?? '#0f172a',
      },
    },
    update: {},
  });
  console.log(`tenant: ${tenant.slug} (${tenant.id})`);

  const hash = await bcrypt.hash(password, 12);
  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash: hash,
      role: 'ADMIN',
      emailVerifiedAt: new Date(),
    },
    update: {
      passwordHash: hash,
      role: 'ADMIN',
      emailVerifiedAt: new Date(),
    },
  });
  console.log(`admin: ${user.email} (${user.id})`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
