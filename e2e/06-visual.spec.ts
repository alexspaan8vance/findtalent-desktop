import { test, expect } from '@playwright/test';

import { ADMIN, CUSTOMER, login } from './helpers';

/**
 * Visual sweep — screenshots every major page for human review and
 * asserts basic layout sanity (no horizontal scrollbar, readable inputs).
 */
test.describe('Visual sweep', () => {
  test('public pages', async ({ page }) => {
    for (const [name, path] of [
      ['landing', '/'],
      ['login', '/login'],
      ['signup', '/signup'],
      ['privacy', '/privacy'],
    ] as const) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: `e2e-screenshots/public-${name}.png`, fullPage: true });

      const hasHScroll = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(hasHScroll, `${path} has horizontal overflow`).toBe(false);
    }
  });

  test('input text is dark on white (readability)', async ({ page }) => {
    await page.goto('/login');
    const input = page.getByLabel(/e-?mail/i);
    await input.fill('contrast-check@test.nl');
    const color = await input.evaluate((el) => getComputedStyle(el).color);
    // Expect near-black: rgb values all < 60
    const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    expect(m, `unexpected color format: ${color}`).toBeTruthy();
    const [r, g, b] = [Number(m![1]), Number(m![2]), Number(m![3])];
    expect(r, `input text too light: ${color}`).toBeLessThan(80);
    expect(g, `input text too light: ${color}`).toBeLessThan(80);
    expect(b, `input text too light: ${color}`).toBeLessThan(80);
  });

  test('customer pages', async ({ page }) => {
    await login(page, CUSTOMER);
    for (const [name, path] of [
      ['projects', '/app/projects'],
      ['project-new', '/app/projects/new'],
      ['settings', '/app/settings'],
      ['choose-plan', '/billing/choose-plan'],
    ] as const) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: `e2e-screenshots/customer-${name}.png`, fullPage: true });
    }
  });

  test('admin pages', async ({ page }) => {
    await login(page, ADMIN);
    for (const [name, path] of [
      ['overview', '/admin'],
      ['pools', '/admin/companies'],
      ['pool-new', '/admin/companies/new'],
      ['users', '/admin/users'],
      ['plans', '/admin/plans'],
      ['audit', '/admin/audit'],
    ] as const) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: `e2e-screenshots/admin-${name}.png`, fullPage: true });
    }
  });
});
