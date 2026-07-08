import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
}
if (!process.env.AUTH_SECRET) {
  process.env.AUTH_SECRET = randomBytes(32).toString('base64');
}
if (!process.env.STRIPE_SECRET_KEY) {
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
}
if (!process.env.STRIPE_WEBHOOK_SECRET) {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
}

// Shared per-worker test DB. Each vitest worker has its own VITEST_POOL_ID.
const workerId = process.env.VITEST_POOL_ID ?? '0';
const testDir = path.resolve(__dirname);
const dbDir = path.join(testDir, '.dbs');
mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, `worker-${workerId}.db`);
process.env.DATABASE_URL = `file:${dbPath}`;

if (!existsSync(dbPath)) {
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdio: 'pipe',
    shell: process.platform === 'win32' ? 'cmd.exe' : undefined,
  });
}
