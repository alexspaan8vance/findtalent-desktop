import { test, expect } from '@playwright/test';

import { CUSTOMER, login, latestToken } from './helpers';

/**
 * Account-security surface: signup consent (GDPR), neutral forgot-password
 * (no enumeration), the full DB-token reset chain, invalid-token handling, and
 * the settings/security forms.
 *
 * IMPORTANT — we NEVER mutate the shared CUSTOMER/ADMIN fixtures (other specs
 * depend on their password + email). The whole reset chain runs on a FRESH
 * throwaway user we sign up in-test (`reset-<ts>@e2e.local`), and on the
 * settings page we only ASSERT the CUSTOMER forms render (no submit that would
 * change anything).
 *
 * Mailbox: RESEND is unconfigured in e2e, so sendEmail() no-ops. The signup
 * action therefore auto-verifies the account and redirects to /login?verified=1
 * (see src/app/(auth)/signup/actions.ts). The reset token is read straight from
 * the e2e DB via latestToken('reset:').
 */
test.describe('Account security', () => {
  const strongPw = 'E2eFreshPass99!';

  test('signup requires explicit consent (GDPR)', async ({ page }) => {
    test.setTimeout(60_000);
    const email = `consent-${Date.now()}@e2e.local`;

    await page.goto('/signup');
    await expect(page.getByRole('heading', { name: /account/i })).toBeVisible({
      timeout: 20_000,
    });

    await page.getByLabel(/e-?mailadres/i).fill(email);
    await page.getByLabel(/^wachtwoord$/i).fill(strongPw);

    // Try to submit WITHOUT ticking consent. The checkbox is `required`, so the
    // browser blocks submission and we stay on /signup (no account created).
    const consent = page.getByRole('checkbox');
    await expect(consent).not.toBeChecked();
    await page.getByRole('button', { name: /account aanmaken/i }).click();

    // Either the native validity prompt blocks us (URL unchanged) or a server
    // validation error renders — assert we did NOT navigate away from /signup.
    await page.waitForTimeout(1_500);
    expect(page.url()).toContain('/signup');

    // Now tick consent + submit → account is created. With email unconfigured
    // the action auto-verifies and lands on /login (verified=1). Accept either
    // the verify-sent state or /login, and assert no 500.
    await consent.check();
    await expect(consent).toBeChecked();
    await page.getByRole('button', { name: /account aanmaken/i }).click();

    await page.waitForURL(/\/(login|verify-email-sent)/, { timeout: 30_000 });
    const body = (await page.locator('body').innerText()).toLowerCase();
    expect(body).not.toContain('internal server error');
    expect(body).not.toContain('500');
  });

  test('forgot-password gives a neutral, non-enumerating response', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/forgot-password');
    await expect(page.getByRole('heading', { name: /wachtwoord vergeten/i })).toBeVisible({
      timeout: 20_000,
    });

    // A random address that almost certainly has no account.
    await page.getByLabel(/e-?mailadres/i).fill(`nobody-${Date.now()}@nowhere.invalid`);
    await page.getByRole('button', { name: /stuur resetlink/i }).click();

    // Same neutral confirmation regardless of whether the account exists.
    await expect(
      page.getByText(/als er een account bij dit e-?mailadres hoort/i),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('reset chain works end-to-end via the DB token (throwaway user)', async ({ page }) => {
    test.setTimeout(120_000);
    const email = `reset-${Date.now()}@e2e.local`;

    // 1. Sign up a throwaway user (consent ticked) so the account exists.
    await page.goto('/signup');
    await page.getByLabel(/e-?mailadres/i).fill(email);
    await page.getByLabel(/^wachtwoord$/i).fill(strongPw);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: /account aanmaken/i }).click();
    await page.waitForURL(/\/(login|verify-email-sent)/, { timeout: 30_000 });

    // 2. Request a reset for that email.
    await page.goto('/forgot-password');
    await page.getByLabel(/e-?mailadres/i).fill(email);
    await page.getByRole('button', { name: /stuur resetlink/i }).click();
    await expect(
      page.getByText(/als er een account bij dit e-?mailadres hoort/i),
    ).toBeVisible({ timeout: 20_000 });

    // 3. Read the reset token from our "mailbox" (the e2e DB).
    const token = await latestToken('reset:');
    expect(token, 'a reset: verificationToken should be minted').toBeTruthy();

    // 4. Open the reset page with the token and set a NEW password.
    const newPw = 'E2eRotated123!';
    await page.goto(`/reset-password?token=${encodeURIComponent(token as string)}`);
    await expect(page.getByRole('heading', { name: /nieuw wachtwoord/i })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByLabel(/^nieuw wachtwoord$/i).fill(newPw);
    await page.getByLabel(/bevestig wachtwoord/i).fill(newPw);
    await page.getByRole('button', { name: /wachtwoord opslaan/i }).click();

    // Success: action redirects to /login?reset=1.
    await page.waitForURL(/\/login/, { timeout: 30_000 });

    // 5. The new password works at /login (no auth error). The throwaway user
    // may not be able to reach /app without onboarding, so we only assert that
    // login does not error out.
    await page.getByLabel(/e-?mail/i).fill(email);
    await page.getByLabel(/wachtwoord|password/i).fill(newPw);
    await page.getByRole('button', { name: /log in|inloggen|sign in/i }).click();
    await page.waitForLoadState('networkidle').catch(() => {});

    const loginBody = (await page.locator('body').innerText()).toLowerCase();
    expect(loginBody).not.toContain('ongeldige inloggegevens');
    expect(loginBody).not.toContain('invalid credentials');
    expect(loginBody).not.toContain('internal server error');
  });

  test('reset page rejects a bogus token without crashing', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/reset-password?token=definitely-not-a-real-token');
    await expect(page.getByRole('heading', { name: /nieuw wachtwoord/i })).toBeVisible({
      timeout: 20_000,
    });
    // Invalid/expired link message renders; the password form does NOT.
    await expect(page.getByText(/ongeldig of verlopen/i)).toBeVisible({ timeout: 20_000 });
  });

  test('settings/security renders both the password- and email-change forms', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await login(page, CUSTOMER);
    await page.goto('/app/settings/security');

    await expect(page.getByRole('heading', { name: /beveiliging/i })).toBeVisible({
      timeout: 30_000,
    });

    // Password-change form: current + new + confirm password fields.
    await expect(page.locator('#pw-current')).toBeVisible();
    await expect(page.locator('#pw-new')).toBeVisible();
    await expect(page.locator('#pw-confirm')).toBeVisible();
    await expect(
      page.getByRole('button', { name: /wachtwoord wijzigen/i }),
    ).toBeVisible();

    // Email-change form: new-email + current-password fields.
    await expect(page.locator('#em-new')).toBeVisible();
    await expect(page.locator('#em-current')).toBeVisible();
    await expect(
      page.getByRole('button', { name: /e-?mailadres wijzigen/i }),
    ).toBeVisible();

    // Wrong-current-password path: this is rejected server-side and changes
    // nothing (we deliberately use a bogus NEW password too so even a buggy
    // accept wouldn't land the real CUSTOMER password). Assert the error shows.
    await page.locator('#pw-current').fill('totally-wrong-current-pw');
    await page.locator('#pw-new').fill('E2eNeverApplied123!');
    await page.locator('#pw-confirm').fill('E2eNeverApplied123!');
    await page.getByRole('button', { name: /wachtwoord wijzigen/i }).click();

    await expect(page.getByText(/huidig wachtwoord onjuist/i)).toBeVisible({
      timeout: 20_000,
    });
    // Never see a success banner — CUSTOMER's password is untouched.
    await expect(page.getByText(/wachtwoord gewijzigd\./i)).toHaveCount(0);
  });
});
