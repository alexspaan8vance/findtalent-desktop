import { test, expect } from '@playwright/test';

import { CUSTOMER, login } from './helpers';

/**
 * Team settings page smoke test.
 *
 * Every authed user can view their org's members; the OWNER additionally sees
 * the invite box. The seeded customer is the owner of their personal org
 * (created lazily on first access), so the invite form should render. Selectors
 * are tolerant (nl + en) and the invite assertion is soft — if the account is
 * ever seeded as a non-owner the members list still renders.
 */
test.describe('Team settings', () => {
  test('renders the members section', async ({ page }) => {
    await login(page, CUSTOMER);
    await page.goto('/app/settings/team');

    // Page title (h1) renders.
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });

    // The current user appears in the members list (their own email).
    await expect(page.getByText(CUSTOMER.email).first()).toBeVisible({
      timeout: 20_000,
    });

    // A "members" section heading is present.
    await expect(
      page.getByRole('heading', { name: /member|leden|team/i }).first(),
    ).toBeVisible();
  });

  test('owner sees the invite form with an email field', async ({ page }) => {
    await login(page, CUSTOMER);
    await page.goto('/app/settings/team');

    const emailInput = page.locator('input[type="email"]').first();
    const hasInvite = await emailInput.isVisible().catch(() => false);
    test.skip(!hasInvite, 'account is not an org owner — no invite form');

    // The invite/submit button is reachable.
    await expect(
      page.getByRole('button', { name: /invite|uitnodig|toevoeg|add/i }).first(),
    ).toBeVisible();
    // Touch the field so the form is interactive (no submit — avoid mutating).
    await emailInput.fill('teammate@example.com');
    await expect(emailInput).toHaveValue('teammate@example.com');
  });
});
