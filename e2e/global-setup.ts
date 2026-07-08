/**
 * E2E global setup.
 *
 * Creates a fresh SQLite DB (prisma/e2e.db), applies migrations, and seeds:
 *   - admin user     admin@e2e.local    / E2eAdminPass123!
 *   - customer user  customer@e2e.local / E2eCustomerPass123! (5 credits)
 *   - IVTA tenant from .env 8vance credentials
 *   - dev plan rows (Try/Basic/Pro + extra credit)
 *
 * The webServer in playwright.config.ts points DATABASE_URL at the same
 * file, so app + seed share state.
 */
import { execSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'prisma', 'e2e.db');
const DB_URL = 'file:./e2e.db';

export default async function globalSetup(): Promise<void> {
  for (const f of [DB_PATH, `${DB_PATH}-journal`]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      // locked — fine, migrate deploy is idempotent
    }
  }

  const env = { ...process.env, DATABASE_URL: DB_URL };
  const shell = process.platform === 'win32' ? 'cmd.exe' : undefined;

  execSync('npx prisma migrate deploy', { cwd: ROOT, env, stdio: 'pipe', shell });
  execSync('npx tsx e2e/seed.ts', { cwd: ROOT, env, stdio: 'inherit', shell });
}
