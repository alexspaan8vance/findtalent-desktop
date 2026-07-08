import { test, expect } from '@playwright/test';

import { ADMIN, login } from './helpers';

test.describe('Admin panel', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, ADMIN);
  });

  test('overview shows stat cards', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: /overview/i })).toBeVisible();
    await expect(page.getByText(/users/i).first()).toBeVisible();
  });

  test('talent pools list shows seeded pools', async ({ page }) => {
    await page.goto('/admin/companies');
    await expect(page.getByText(/ivta/i).first()).toBeVisible();
    await expect(page.getByText(/demo-pool/i).first()).toBeVisible();
  });

  test('add-pool form renders all fields', async ({ page }) => {
    await page.goto('/admin/companies/new');
    await expect(page.locator('input[name="slug"]')).toBeVisible();
    await expect(page.locator('input[name="name"]')).toBeVisible();
    await expect(page.locator('input[name="eightvanceClientId"]')).toBeVisible();
    await expect(page.locator('input[name="eightvanceClientSecret"]')).toBeVisible();
    await expect(page.locator('input[name="eightvanceBaseUrl"]')).toBeVisible();
    // Company ID + source are auto-detected, not hand-entered: a Test/detect
    // button must exist and Create is disabled until validation succeeds.
    await expect(
      page.getByRole('button', { name: /test \/ detect credentials/i }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /create company/i })).toBeDisabled();
  });

  test('pool create is gated on 8vance credential validation', async ({ page }) => {
    await page.goto('/admin/companies/new');
    await page.locator('input[name="slug"]').fill(`e2e-pool-${Date.now().toString(36)}`);
    await page.locator('input[name="name"]').fill('E2E Created Pool');
    await page.locator('input[name="eightvanceClientId"]').fill('e2e-client-id');
    await page.locator('input[name="eightvanceClientSecret"]').fill('e2e-client-secret');

    // Create stays disabled until the credentials are validated against 8vance.
    await expect(page.getByRole('button', { name: /create company/i })).toBeDisabled();

    // Bogus creds → detection fails at 8vance → inline error, Create still
    // disabled (no pool is created without valid, verified credentials).
    await page.getByRole('button', { name: /test \/ detect credentials/i }).click();
    await expect(
      page.getByText(/invalid|unreachable|could not|credential|8vance/i).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /create company/i })).toBeDisabled();
  });

  test('users page lists seeded accounts', async ({ page }) => {
    await page.goto('/admin/users');
    await expect(page.getByText(ADMIN.email)).toBeVisible();
    await expect(page.getByText('customer@e2e.local')).toBeVisible();
  });

  test('plans page shows seeded tiers', async ({ page }) => {
    await page.goto('/admin/plans');
    // Plan names render in inline edit inputs (admin can rename them).
    await expect(page.locator('input[name="name"][value="Try"]')).toBeVisible();
    await expect(page.locator('input[name="name"][value="Basic"]')).toBeVisible();
    await expect(page.locator('input[name="name"][value="Pro"]')).toBeVisible();
  });

  test('audit log page renders', async ({ page }) => {
    await page.goto('/admin/audit');
    await expect(page.getByRole('heading', { name: /audit/i })).toBeVisible();
  });
});
