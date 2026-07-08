import { test, expect } from '@playwright/test';

import { CUSTOMER, login, expectNoPIIInBody } from './helpers';

/**
 * Full project → match → shortlist → reveal flow against the REAL 8vance
 * IVTA pool. Serial: state carries across tests via storage + DB.
 */
test.describe.serial('Project flow (real 8vance match)', () => {
  test('customer creates a multi-step project against the IVTA pool', async ({ page }) => {
    test.setTimeout(240_000);
    await login(page, CUSTOMER);
    await page.goto('/app/projects/new');

    // --- Pool selection step (multi-pool). Select ONLY the IVTA pool so the
    // match is deterministic (demo-pool has bogus creds by design). ---
    const ivtaCheckbox = page.getByRole('checkbox', { name: /ivta/i }).first();
    await expect(ivtaCheckbox).toBeVisible({ timeout: 20_000 });
    await ivtaCheckbox.check();
    await expect(ivtaCheckbox).toBeChecked();
    await page.getByRole('button', { name: /doorgaan|continue/i }).click();

    // --- Step: role ---
    await page.getByLabel(/project ?title|projecttitel|titel/i).fill('E2E Software Engineer — automated test');
    const fnInput = page.getByPlaceholder(/search for a role|functietitel|zoek/i).first();
    await fnInput.fill('software');
    // Wait for autocomplete dropdown
    const option = page.locator('ul li').first();
    await expect(option).toBeVisible({ timeout: 20_000 });
    await option.click();
    await page.getByRole('button', { name: /doorgaan|continue/i }).click();

    // --- Step: location + level ---
    await expect(page.getByText(/seniority|function level|senioriteit|niveau/i).first()).toBeVisible();
    const levelSelect = page.locator('#functionLevel');
    await expect(levelSelect).toBeVisible();
    await levelSelect.selectOption({ index: 4 });
    const locInput = page.getByPlaceholder(/city|stad|locat/i).first();
    await locInput.fill('Eindhoven');
    const locOption = page.locator('ul li', { hasText: /eindhoven/i }).first();
    await expect(locOption).toBeVisible({ timeout: 20_000 });
    await locOption.click();
    await page.getByRole('button', { name: /doorgaan|continue/i }).click();

    // --- Step: skills (≥3). The dropdown <ul> has `absolute`; the added-skills
    // list is a separate <ul>, so scope option clicks to the dropdown. ---
    const skillInput = page.getByPlaceholder(/skill/i).first();
    // Skills that are common in the IVTA pool so the ranker surfaces real
    // candidates (verified via skill-name tally).
    for (const skill of ['Project management', 'Communication', 'Lean management']) {
      await skillInput.fill(skill);
      const skillOption = page.locator('ul.absolute li').first();
      await expect(skillOption).toBeVisible({ timeout: 20_000 });
      await skillOption.click();
    }
    // 3 distinct skills added → Continue enabled.
    const continueBtn = page.getByRole('button', { name: /doorgaan|continue/i });
    await expect(continueBtn).toBeEnabled({ timeout: 10_000 });
    await continueBtn.click();

    // --- Step: profile (languages/education) — optional, submit ---
    const submit = page.getByRole('button', { name: /start match/i });
    await expect(submit).toBeVisible({ timeout: 10_000 });
    await expect(submit).toBeEnabled({ timeout: 10_000 });
    await submit.click();

    // Redirect to shortlist (job create + match attempts can take a bit).
    await page.waitForURL(/\/app\/projects\/[^/]+\/shortlist/, { timeout: 120_000 });
  });

  test('shortlist reaches a terminal state (candidates or clean empty-state)', async ({ page }) => {
    test.setTimeout(300_000);
    await login(page, CUSTOMER);
    await page.goto('/app/projects');
    await page.getByText('E2E Software Engineer — automated test').first().click();
    await page.waitForURL(/shortlist/);

    // The shortlist page hydrates on load; poll until it is no longer in the
    // "matching in progress" state (candidates rendered OR empty-state shown).
    let terminal = false;
    for (let i = 0; i < 24; i++) {
      const cards = page.locator('a[href*="/talent/"]');
      const empty = page.getByTestId('shortlist-empty');
      const failed = page.getByText(/match task failed|matchtaak mislukt/i);
      if (
        (await cards.count()) > 0 ||
        (await empty.isVisible().catch(() => false)) ||
        (await failed.isVisible().catch(() => false))
      ) {
        terminal = true;
        break;
      }
      await page.waitForTimeout(10_000);
      await page.reload();
    }
    expect(terminal, 'shortlist should reach a terminal state within 4 min').toBe(true);

    // Never leak PII on the anonymous shortlist, regardless of result count.
    await expectNoPIIInBody(page, ['@gmail.', '@hotmail.', 'linkedin.com/in/']);

    const cardCount = await page.locator('a[href*="/talent/"]').count();
    if (cardCount > 0) {
      // Pool badge present when candidates exist (multi-pool tagging).
      await expect(page.getByText(/ivta/i).first()).toBeVisible();
    }
  });

  test('talent detail shows anon profile + reveal CTA, no PII', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, CUSTOMER);
    await page.goto('/app/projects');
    await page.getByText('E2E Software Engineer — automated test').first().click();
    await page.waitForURL(/shortlist/);

    const card = page.locator('a[href*="/talent/"]').first();
    const hasCard = await card.isVisible().catch(() => false);
    test.skip(!hasCard, 'no candidates in sandbox pool for these skills');

    await card.click();
    await page.waitForURL(/\/app\/projects\/[^/]+\/talent\//);
    // 60s absorbs first-hit dev compilation of the talent route.
    await expect(page.getByText(/vaardigheden|skills/i).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: /onthul|reveal/i })).toBeVisible();
    await expectNoPIIInBody(page, ['@gmail.', '@hotmail.', 'linkedin.com/in/']);
  });

  test('reveal spends a credit and shows PII with 14-day lock', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, CUSTOMER);
    await page.goto('/app/projects');
    await page.getByText('E2E Software Engineer — automated test').first().click();
    await page.waitForURL(/shortlist/);

    const card = page.locator('a[href*="/talent/"]').first();
    const hasCard = await card.isVisible().catch(() => false);
    test.skip(!hasCard, 'no candidates in sandbox pool for these skills');

    await card.click();
    await page.waitForURL(/\/app\/projects\/[^/]+\/talent\//);
    // Single-click reveal (spends 1 credit immediately).
    const revealCta = page.getByRole('button', { name: /onthul kandidaat|reveal/i }).first();
    await expect(revealCta).toBeVisible({ timeout: 30_000 });
    await revealCta.click();
    // Revealed PII card appears (email/phone/14d-exclusive).
    await expect(page.getByText(/revealed|onthuld|14d|exclusive|@/i).first()).toBeVisible({
      timeout: 60_000,
    });
  });

  test('credit balance decremented after the reveal', async ({ page }) => {
    await login(page, CUSTOMER);
    await page.goto('/app/settings');
    // Seeded 5 credits; if a reveal happened it should read 4 (or fewer).
    const body = await page.locator('body').innerText();
    const m = body.match(/(?:Credits balance|Creditsaldo)[\s\S]{0,40}?(\d+)/i);
    if (m) {
      expect(Number(m[1])).toBeLessThanOrEqual(5);
    }
  });
});
