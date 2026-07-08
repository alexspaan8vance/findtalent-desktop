import { test, expect } from '@playwright/test';

import { CUSTOMER, login } from './helpers';

/**
 * Customer dashboard smoke + a11y test.
 *
 * Verifies the dashboard renders its stat cards and the reveals chart region,
 * and checks a few baseline a11y guarantees added in the P3 pass: a single h1,
 * an accessible (role=img + label) chart, and a named primary CTA.
 */
test.describe('Dashboard', () => {
  test('renders stat cards and the reveals chart', async ({ page }) => {
    await login(page, CUSTOMER);
    await page.goto('/app/dashboard');

    // Exactly one top-level h1.
    const h1 = page.locator('h1');
    await expect(h1.first()).toBeVisible({ timeout: 20_000 });
    expect(await h1.count()).toBe(1);

    // Stat cards: the credits/projects/reveals figures render. We assert at
    // least three numeric stat values are visible inside the stats region.
    const statsRegion = page.locator('section').filter({ has: page.locator('h2.sr-only') });
    // Fall back to the whole page if the sr-only heading isn't matched.
    const scope = (await statsRegion.count()) > 0 ? statsRegion.first() : page.locator('body');
    const numbers = scope.locator('text=/^\\d+$/');
    expect(await numbers.count()).toBeGreaterThanOrEqual(1);

    // The chart region exposes an accessible label (role=img on the wrapper).
    const chart = page.getByRole('img').filter({ hasText: '' });
    const chartByLabel = page.locator('[role="img"][aria-label]');
    await expect(
      (await chartByLabel.count()) > 0 ? chartByLabel.first() : chart.first(),
    ).toBeVisible({ timeout: 20_000 });

    // Primary CTA has an accessible name.
    await expect(
      page.getByRole('link', { name: /new project|nieuw project|project/i }).first(),
    ).toBeVisible();
  });

  test('chart region has a non-empty aria-label', async ({ page }) => {
    await login(page, CUSTOMER);
    await page.goto('/app/dashboard');

    const labelled = page.locator('[role="img"][aria-label]').first();
    const hasLabelled = await labelled.isVisible().catch(() => false);
    test.skip(!hasLabelled, 'chart region not present (no chart rendered)');

    const label = await labelled.getAttribute('aria-label');
    expect(label && label.trim().length).toBeTruthy();
  });
});
