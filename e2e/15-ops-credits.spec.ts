import { test, expect } from '@playwright/test';

import { CUSTOMER, login, e2ePrisma } from './helpers';

/**
 * Ops + credits E2E.
 *
 *  1. Cron guard — the host-cron `/api/cron/*` routes are protected by the
 *     shared `CRON_SECRET` bearer (set to `e2e-cron-secret` in the webServer
 *     env, see playwright.config.ts). No header → 401; correct bearer → 200.
 *  2. Credit ledger page — the customer (seeded with 5 credits + an INITIAL
 *     +5 ledger row) sees their balance and a transactions table.
 *  3. Low-credit banner — flip the customer to 1 available credit and assert
 *     the low-credit banner renders, then RESTORE the balance so other specs
 *     (which assume the seeded 5 credits) are unaffected. Runs LAST.
 */

const CRON_BEARER = { Authorization: 'Bearer e2e-cron-secret' };

test.describe('Ops + credits', () => {
  test('cron routes refuse without bearer and accept the correct secret', async ({ page }) => {
    for (const path of ['/api/cron/cleanup', '/api/cron/saved-search']) {
      // No auth header → 401 (CRON_SECRET IS set in e2e, so it's 401 not 503).
      const unauth = await page.request.get(path);
      expect(unauth.status(), `${path} without bearer should be 401`).toBe(401);

      // Correct bearer → 200 + JSON { ok: true }.
      const authed = await page.request.get(path, { headers: CRON_BEARER });
      expect(authed.status(), `${path} with bearer should be 200`).toBe(200);
      const body = await authed.json();
      expect(body, `${path} body`).toMatchObject({ ok: true });
    }
  });

  test('credit ledger page shows balance and the seeded INITIAL grant', async ({ page }) => {
    await login(page, CUSTOMER);
    await page.goto('/app/billing/credits');

    // Page heading ("Creditgeschiedenis") + current-balance card.
    await expect(
      page.getByRole('heading', { name: /creditgeschiedenis|credit history/i }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/huidig saldo|current balance/i).first()).toBeVisible();

    // Transactions table with a header row.
    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 15_000 });
    await expect(table.getByRole('columnheader', { name: /reden|reason/i })).toBeVisible();

    // The seeded INITIAL grant: reason label "Startsaldo"/"Initial" and a +5 delta.
    await expect(table.getByText(/startsaldo|initial/i).first()).toBeVisible();
    await expect(table.getByText(/\+\s?5\b/).first()).toBeVisible();
  });

  // LAST: mutates the customer's balance, then restores it in a finally block.
  test('low-credit banner appears when the customer is nearly out of credits', async ({ page }) => {
    const db = e2ePrisma();
    try {
      // Drop to exactly the low-credits threshold (availableCredits = 1).
      await db.user.update({
        where: { email: CUSTOMER.email },
        data: { creditsBalance: 1, purchasedCredits: 0 },
      });

      await login(page, CUSTOMER);
      await page.goto('/app/projects');

      // The banner (role="alert") carries lowCreditsTitle + lowCreditsBody and
      // a top-up CTA linking to billing.
      const banner = page
        .getByRole('alert')
        .filter({ hasText: /bijna geen credits|low on credits|credit/i })
        .first();
      await expect(banner).toBeVisible({ timeout: 30_000 });
      await expect(
        banner.getByRole('link', { name: /credits bijkopen|buy credits|top.?up|bijkopen/i }),
      ).toBeVisible();
    } finally {
      // Restore the seeded balance so downstream specs see 5 credits again.
      await db.user.update({
        where: { email: CUSTOMER.email },
        data: { creditsBalance: 5, purchasedCredits: 0 },
      });
      await db.$disconnect();
    }
  });
});
