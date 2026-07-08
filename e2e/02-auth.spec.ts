import { test, expect } from '@playwright/test';

import { ADMIN, CUSTOMER, login, logout } from './helpers';

test.describe('Auth', () => {
  test('admin can log in and reaches the app', async ({ page }) => {
    await login(page, ADMIN);
    await expect(page.getByText(ADMIN.email)).toBeVisible();
    await logout(page);
  });

  test('customer can log in', async ({ page }) => {
    await login(page, CUSTOMER);
    await expect(page.getByText(CUSTOMER.email)).toBeVisible();
  });

  test('wrong password is rejected', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/e-?mail/i).fill(ADMIN.email);
    await page.getByLabel(/wachtwoord|password/i).fill('definitely-wrong-password');
    await page.getByRole('button', { name: /log in|inloggen|sign in/i }).click();
    await page.waitForTimeout(1500);
    expect(page.url()).toContain('/login');
  });

  test('customer cannot open admin', async ({ page }) => {
    await login(page, CUSTOMER);
    await page.goto('/admin');
    await expect(page).not.toHaveURL(/\/admin$/);
  });

  test('signup form validates weak passwords', async ({ page }) => {
    await page.goto('/signup');
    await page.getByLabel(/e-?mail/i).fill('new-user@e2e.local');
    await page.getByLabel(/wachtwoord|password/i).fill('short');
    await page.getByRole('button', { name: /sign ?up|registreer|aanmelden|account/i }).click();
    await page.waitForTimeout(800);
    // Stay on signup with an inline error (action ran, validation rejected).
    expect(page.url()).toContain('/signup');
    await expect(page.getByText(/minstens 10|at least 10|tekens|characters/i).first()).toBeVisible();
  });

  test('a brand-new user can sign up and reach login (no 500)', async ({ page }) => {
    const errs: string[] = [];
    page.on('response', (r) => {
      if (r.status() >= 500) errs.push(`${r.status()} ${r.url()}`);
    });
    const email = `e2e-signup-${Date.now()}@test.local`;
    await page.goto('/signup');
    await page.getByLabel(/e-?mail/i).fill(email);
    await page.getByLabel(/wachtwoord|password/i).fill('E2eSignup2026!');
    // GDPR consent is now a required checkbox before signup can proceed.
    await page.getByRole('checkbox').first().check();
    await page.getByRole('button', { name: /sign ?up|registreer|aanmelden|account/i }).click();
    // Without email configured the account auto-verifies → back to login.
    await page.waitForURL(/\/(login|verify-email)/, { timeout: 20_000 });
    expect(errs, `unexpected 5xx during signup: ${errs.join(', ')}`).toHaveLength(0);

    // The auto-verified account can actually log in.
    if (page.url().includes('/login')) {
      await page.getByLabel(/e-?mail/i).fill(email);
      await page.getByLabel(/wachtwoord|password/i).fill('E2eSignup2026!');
      await page.getByRole('button', { name: /log in|inloggen|sign in/i }).click();
      await page.waitForURL(/\/app\/projects/, { timeout: 20_000 });
    }
  });
});
