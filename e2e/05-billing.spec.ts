import { test, expect } from '@playwright/test';

import { CUSTOMER, login } from './helpers';

test.describe('Billing UI', () => {
  test('choose-plan shows 3 tiers + extra credits', async ({ page }) => {
    await login(page, CUSTOMER);
    await page.goto('/billing/choose-plan');
    await expect(page.getByText('€99')).toBeVisible();
    await expect(page.getByText('€249')).toBeVisible();
    await expect(page.getByText('€499')).toBeVisible();
    await expect(page.getByText('€125')).toBeVisible();
    // Subscribe buttons enabled (plans seeded). NL label = "Abonneren".
    const subscribeButtons = page.getByRole('button', { name: /subscribe|abonneren/i });
    expect(await subscribeButtons.count()).toBeGreaterThanOrEqual(3);
  });

  test('settings shows credit balance and plan section', async ({ page }) => {
    await login(page, CUSTOMER);
    await page.goto('/app/settings');
    await expect(page.getByText(/credits/i).first()).toBeVisible();
    await expect(page.getByText(/plan/i).first()).toBeVisible();
  });

  test('account export endpoint returns JSON dump', async ({ page }) => {
    await login(page, CUSTOMER);
    const res = await page.request.get('/api/account/export');
    expect(res.status()).toBe(200);
    const json = (await res.json()) as { email?: string };
    expect(json.email).toBe(CUSTOMER.email);
  });
});
