import { test, expect } from '@playwright/test';

test.describe('Public pages', () => {
  test('landing renders with branding, pricing and CTAs', async ({ page }) => {
    await page.goto('/');
    // Title is the deploy's (admin-configurable) brand name — just assert it's set.
    await expect(page).toHaveTitle(/\S/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // 3 pricing tiers
    await expect(page.getByText('€99').first()).toBeVisible();
    await expect(page.getByText('€249').first()).toBeVisible();
    await expect(page.getByText('€499').first()).toBeVisible();
    // CTAs
    await expect(page.getByRole('link', { name: /sign ?up|registreer|aanmelden|aan de slag|get started/i }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /log ?in|inloggen/i }).first()).toBeVisible();
  });

  test('locale switcher flips NL ↔ EN', async ({ page }) => {
    await page.goto('/');
    const body = page.locator('body');
    const before = await body.innerText();

    const switcher = page.locator('select, [data-testid="locale-switcher"], button:has-text("EN")').first();
    await expect(switcher).toBeVisible();

    const tag = await switcher.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'select') {
      await switcher.selectOption('en');
    } else {
      await switcher.click();
      await page.getByText(/^en$|english/i).first().click();
    }
    await page.waitForTimeout(800);
    const after = await body.innerText();
    expect(after).not.toBe(before);
  });

  test('privacy + terms are public', async ({ page }) => {
    for (const path of ['/privacy', '/terms']) {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
  });

  test('security headers are set', async ({ page }) => {
    const res = await page.goto('/');
    const headers = res?.headers() ?? {};
    expect(headers['content-security-policy']).toBeTruthy();
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  test('health endpoint green', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  test('protected routes redirect to login', async ({ page }) => {
    for (const path of ['/app/projects', '/admin', '/app/settings']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    }
  });
});
