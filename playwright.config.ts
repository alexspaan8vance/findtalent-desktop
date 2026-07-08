import { defineConfig, devices } from '@playwright/test';

/**
 * E2E suite for findtalent.
 *
 * Runs against the dev server (auto-started). Uses a dedicated SQLite DB
 * (e2e.db) so it never clobbers your dev data. Seed happens in
 * e2e/global-setup.ts (admin user + IVTA tenant + plans + a funded
 * customer account).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false, // shared DB — keep serial
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'nl-NL',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npx next dev --port 3100',
    url: 'http://localhost:3100/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: 'file:./e2e.db',
      PORT: '3100',
      NEXTAUTH_URL: 'http://localhost:3100',
      // Scan more of the pool in the fallback ranker so the e2e flow has a
      // good chance of surfacing real anonymized candidates.
      MATCH_FALLBACK_SCAN: '60',
      // Shared secret for the /api/cron/* bearer guard (see cron-auth.ts):
      // set → unauthed requests get 401, correct bearer gets 200.
      CRON_SECRET: 'e2e-cron-secret',
    },
  },
});
