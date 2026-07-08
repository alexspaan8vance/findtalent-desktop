// Standalone visual walkthrough against the running dev server (:3000).
// Screenshots every major page (public, admin, user flow) for a human eyeball.
// Run: node scripts/visual-check.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.VISUAL_BASE ?? 'http://localhost:3000';
const ADMIN = { email: process.env.VISUAL_EMAIL, password: process.env.VISUAL_PASSWORD };
if (!ADMIN.email || !ADMIN.password) {
  console.error('Set VISUAL_EMAIL and VISUAL_PASSWORD env vars (never hardcode credentials).');
  process.exit(1);
}
const OUT = 'visual-shots';
mkdirSync(OUT, { recursive: true });

const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log('shot', name, '·', page.url());
};

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(30_000);

  // --- Public ---
  await page.goto(`${BASE}/`);
  await page.waitForLoadState('networkidle');
  await shot(page, '01-landing');
  await page.goto(`${BASE}/login`);
  await shot(page, '02-login');

  // --- Login as admin ---
  await page.getByLabel(/e-?mail/i).fill(ADMIN.email);
  await page.getByLabel(/wachtwoord|password/i).fill(ADMIN.password);
  await page.getByRole('button', { name: /log in|inloggen|sign in/i }).click();
  await page.waitForURL(/\/app\/projects/, { timeout: 30_000 });
  await shot(page, '03-projects-list');

  // --- Admin pages ---
  for (const [name, path] of [
    ['04-admin-overview', '/admin'],
    ['05-admin-pools', '/admin/companies'],
    ['06-admin-pool-new', '/admin/companies/new'],
    ['07-admin-users', '/admin/users'],
    ['08-admin-plans', '/admin/plans'],
    ['09-admin-audit', '/admin/audit'],
  ]) {
    await page.goto(`${BASE}${path}`);
    await page.waitForLoadState('networkidle');
    await shot(page, name);
  }

  // --- Billing ---
  await page.goto(`${BASE}/billing/choose-plan`);
  await page.waitForLoadState('networkidle');
  await shot(page, '10-choose-plan');

  // --- Project wizard ---
  await page.goto(`${BASE}/app/projects/new`);
  await page.waitForLoadState('networkidle');
  await shot(page, '11-wizard-pools');
  // Pool select
  const ivta = page.getByRole('checkbox', { name: /ivta|findtalent/i }).first();
  await ivta.check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  // Role
  await page.getByLabel(/project title|titel/i).fill('Visual check — Operations Lead');
  const fn = page.getByPlaceholder(/search for a role|zoek/i).first();
  await fn.fill('manager');
  await page.locator('ul.absolute li').first().click();
  await shot(page, '12-wizard-role');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  // Location + level
  await page.locator('#functionLevel').selectOption({ index: 4 });
  const loc = page.getByPlaceholder(/city|stad|locat/i).first();
  await loc.fill('Eindhoven');
  await page.locator('ul.absolute li').first().click();
  await shot(page, '13-wizard-location');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  // Skills
  const sk = page.getByPlaceholder(/skill/i).first();
  for (const s of ['Project management', 'Communication', 'Lean management']) {
    await sk.fill(s);
    await page.locator('ul.absolute li').first().click();
  }
  await shot(page, '14-wizard-skills');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await shot(page, '15-wizard-profile');
  await page.getByRole('button', { name: 'Start matching' }).click();
  await page.waitForURL(/\/shortlist/, { timeout: 60_000 });
  await shot(page, '16-shortlist-matching');

  // Wait for candidates (poller + fallback)
  for (let i = 0; i < 18; i++) {
    if ((await page.locator('a[href*="/talent/"]').count()) > 0) break;
    await page.waitForTimeout(8000);
    await page.reload();
  }
  await page.waitForLoadState('networkidle');
  await shot(page, '17-shortlist-candidates');

  // Talent detail
  const card = page.locator('a[href*="/talent/"]').first();
  if (await card.isVisible().catch(() => false)) {
    await card.click();
    await page.waitForURL(/\/talent\//, { timeout: 30_000 });
    await page.waitForLoadState('networkidle');
    await shot(page, '18-talent-detail-anon');
    // Reveal
    const reveal = page.getByRole('button', { name: /onthul kandidaat|reveal/i }).first();
    if (await reveal.isVisible().catch(() => false)) {
      await reveal.click();
      await page.waitForTimeout(6000);
      await shot(page, '19-talent-revealed');
    }
  }

  // Settings
  await page.goto(`${BASE}/app/settings`);
  await page.waitForLoadState('networkidle');
  await shot(page, '20-settings');

  await browser.close();
  console.log('DONE — screenshots in', OUT);
};

run().catch((e) => {
  console.error('VISUAL FAIL', e.message);
  process.exit(1);
});
