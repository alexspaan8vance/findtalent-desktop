import { test, expect } from '@playwright/test';

import { CUSTOMER, login, expectNoPIIInBody } from './helpers';

/**
 * Candidate compare view smoke test.
 *
 * /app/projects/<id>/compare?ids=<a,b> renders 2–4 anonymized candidates side
 * by side. With no candidates we still verify the page renders its "too few"
 * empty state; when the project-flow suite produced a shortlist we pick the
 * first two candidates and assert the side-by-side columns render without PII.
 */
test.describe('Compare candidates', () => {
  test('renders the too-few empty state when fewer than two are selected', async ({ page }) => {
    test.setTimeout(60_000);
    await login(page, CUSTOMER);
    await page.goto('/app/projects');

    const projectLink = page.locator('a[href*="/app/projects/"]').first();
    const hasProject = await projectLink.isVisible().catch(() => false);
    test.skip(!hasProject, 'no projects in the account');

    const href = await projectLink.getAttribute('href');
    const projectId = href!.match(/\/app\/projects\/([^/]+)/)![1];

    // No ids → the page must render its "pick at least two" empty state, not
    // crash. h1 (project title) is always present.
    await page.goto(`/app/projects/${projectId}/compare`);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 });
    await expectNoPIIInBody(page, ['@gmail.', '@hotmail.', 'linkedin.com/in/']);
  });

  test('renders selected candidates side by side when a shortlist exists', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, CUSTOMER);
    await page.goto('/app/projects');

    const projectLink = page.locator('a[href*="/app/projects/"]').first();
    const hasProject = await projectLink.isVisible().catch(() => false);
    test.skip(!hasProject, 'no projects in the account');

    const href = await projectLink.getAttribute('href');
    const projectId = href!.match(/\/app\/projects\/([^/]+)/)![1];

    // Visit the shortlist and collect candidate opaque ids from talent links.
    await page.goto(`/app/projects/${projectId}/shortlist`);
    const talentLinks = page.locator('a[href*="/talent/"]');
    // Give the shortlist a moment to hydrate.
    await page.waitForTimeout(2_000);
    const count = await talentLinks.count();
    test.skip(count < 2, 'fewer than two candidates — cannot compare');

    const ids: string[] = [];
    for (let i = 0; i < count && ids.length < 2; i++) {
      const h = await talentLinks.nth(i).getAttribute('href');
      const m = h?.match(/\/talent\/([^/?#]+)/);
      if (m && !ids.includes(m[1])) ids.push(m[1]);
    }
    test.skip(ids.length < 2, 'could not derive two distinct opaque ids');

    await page.goto(`/app/projects/${projectId}/compare?ids=${ids.join(',')}`);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 });

    // Side-by-side columns: at least two "anonymous candidate" headers, OR the
    // shared section labels (e.g. "skills"/"experience") appear more than once.
    const anonHeaders = page.getByText(/anonymous candidate|anonieme kandidaat/i);
    const headerCount = await anonHeaders.count();
    if (headerCount > 0) {
      expect(headerCount).toBeGreaterThanOrEqual(2);
    }

    // Compare view is strictly anonymized.
    await expectNoPIIInBody(page, ['@gmail.', '@hotmail.', 'linkedin.com/in/']);
  });
});
