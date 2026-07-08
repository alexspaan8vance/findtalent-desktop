import { expect, type Page } from '@playwright/test';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

export const ADMIN = { email: 'admin@e2e.local', password: 'E2eAdminPass123!' };
export const CUSTOMER = { email: 'customer@e2e.local', password: 'E2eCustomerPass123!' };
/** The seeded unsynced candidate on the demo-pool (see e2e/seed.ts). */
export const SEEDED_CANDIDATE_EMAIL = 'e2e.candidate@example.com';

/**
 * A raw Prisma client bound to the E2E SQLite DB (prisma/e2e.db) — the same
 * file the webServer uses. Lets specs read server-generated artifacts the way
 * a real mailbox would (we own the DB, so no IMAP/Mailpit needed): the
 * email-verification / password-reset tokens (verificationToken) and the
 * magic-link portal token (Candidate.portalToken). Use + disconnect per call.
 */
export function e2ePrisma(): PrismaClient {
  const url = `file:${path.resolve(process.cwd(), 'prisma', 'e2e.db')}`;
  return new PrismaClient({ datasources: { db: { url } } });
}

/**
 * Latest non-expired verificationToken whose identifier starts with `prefix`
 * (e.g. 'reset:', 'emailchange:', or the bare email for signup-verify). Returns
 * the token string or null. This is how specs "click the link from the email"
 * without a mailbox.
 */
export async function latestToken(prefix: string): Promise<string | null> {
  const db = e2ePrisma();
  try {
    const rows = await db.verificationToken.findMany({ orderBy: { expires: 'desc' } });
    const row = rows.find((r) => r.identifier.startsWith(prefix) && r.expires > new Date());
    return row?.token ?? null;
  } finally {
    await db.$disconnect();
  }
}

/** The seeded candidate's id (for /api/candidates/[id]/... routes). */
export async function seededCandidateId(): Promise<string> {
  const db = e2ePrisma();
  try {
    const c = await db.candidate.findFirst({
      where: { name: 'E2E Candidate Klaas' },
      select: { id: true },
    });
    if (!c) throw new Error('seeded candidate not found — check e2e/seed.ts');
    return c.id;
  } finally {
    await db.$disconnect();
  }
}

/**
 * The seeded SYNCED match candidate's id ("E2E Match Klaas" — see e2e/seed.ts).
 * Carries a READY CandidateMatchRun with deterministic job rows for the
 * source-chip + travel-filter UI spec. Kept alive (never GDPR-deleted).
 */
export async function seededMatchCandidateId(): Promise<string> {
  const db = e2ePrisma();
  try {
    const c = await db.candidate.findFirst({
      where: { name: 'E2E Match Klaas' },
      select: { id: true },
    });
    if (!c) throw new Error('seeded match candidate not found — check e2e/seed.ts');
    return c.id;
  } finally {
    await db.$disconnect();
  }
}

export async function login(page: Page, creds: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel(/e-?mail/i).fill(creds.email);
  await page.getByLabel(/wachtwoord|password/i).fill(creds.password);
  await page.getByRole('button', { name: /log in|inloggen|sign in/i }).click();
  await page.waitForURL(/\/app\/projects/, { timeout: 20_000 });
}

export async function logout(page: Page) {
  const button = page.getByRole('button', { name: /sign out|uitloggen/i }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    await page.waitForURL(/\/($|\?)/, { timeout: 15_000 }).catch(() => {});
  }
}

export async function expectNoPIIInBody(page: Page, blocked: string[]) {
  const body = (await page.locator('body').innerText()).toLowerCase();
  for (const term of blocked) {
    expect(body, `PII leak: "${term}" visible on ${page.url()}`).not.toContain(
      term.toLowerCase(),
    );
  }
}
