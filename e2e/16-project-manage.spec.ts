import { test, expect } from '@playwright/test';

import { CUSTOMER, login, e2ePrisma } from './helpers';

/**
 * Project management: archive / unarchive / filter tabs / rerun button.
 *
 * Drives the seeded DRAFT project "E2E Seeded Project" (see e2e/seed.ts —
 * owned by CUSTOMER, no pools, no matches). Serial because the tests share
 * project state (archive in one, unarchive in the next). The project is left
 * in its ORIGINAL state (active / DRAFT) at the end so it cannot leak into
 * other specs.
 *
 * UI under test:
 *   - src/app/app/projects/page.tsx (Active/Archived filter tabs, ?filter=archived)
 *   - src/app/app/projects/[id]/shortlist/project-actions.tsx (Archive / Unarchive / Refresh matches)
 *   - src/app/app/projects/[id]/actions.ts (server actions)
 * i18n (messages/nl.json projects.*): archive="Archiveren",
 *   unarchive="Dearchiveren", filterActive="Actief",
 *   filterArchived="Gearchiveerd", rerunMatch="Matches verversen".
 */

const PROJECT_TITLE = 'E2E Seeded Project';

/** Resolve the seeded project's id straight from the e2e DB. */
async function seededProjectId(): Promise<string> {
  const db = e2ePrisma();
  try {
    const p = await db.project.findFirst({
      where: { title: PROJECT_TITLE },
      select: { id: true },
    });
    if (!p) throw new Error(`seeded project "${PROJECT_TITLE}" not found — check e2e/seed.ts`);
    return p.id;
  } finally {
    await db.$disconnect();
  }
}

test.describe.serial('Project management (archive / unarchive / filter / rerun)', () => {
  test('Active list shows the seeded project', async ({ page }) => {
    await login(page, CUSTOMER);
    await page.goto('/app/projects');
    // Default (Active) view: status != ARCHIVED, so the DRAFT project shows.
    await expect(page.getByText(PROJECT_TITLE).first()).toBeVisible({ timeout: 20_000 });
  });

  test('Archive removes it from Active and lists it under Archived', async ({ page }) => {
    test.setTimeout(60_000);
    await login(page, CUSTOMER);

    const id = await seededProjectId();
    await page.goto(`/app/projects/${id}/shortlist`);
    // Header renders even with no pools/matches (empty shortlist).
    await expect(page.getByRole('heading', { name: PROJECT_TITLE })).toBeVisible({
      timeout: 30_000,
    });

    // Archive control lives in project-actions.tsx (button, label "Archiveren").
    const archiveBtn = page.getByRole('button', { name: /archiveren/i }).first();
    await expect(archiveBtn).toBeVisible({ timeout: 10_000 });
    await archiveBtn.click();

    // Active view: should no longer list the project.
    await page.goto('/app/projects');
    await expect(page.getByText(PROJECT_TITLE)).toHaveCount(0, { timeout: 15_000 });

    // Switch to the Archived filter tab (link → ?filter=archived).
    await page.getByRole('link', { name: /gearchiveerd/i }).click();
    await page.waitForURL(/filter=archived/, { timeout: 15_000 });
    await expect(page.getByText(PROJECT_TITLE).first()).toBeVisible({ timeout: 15_000 });
  });

  test('Unarchive returns it to the Active list', async ({ page }) => {
    test.setTimeout(60_000);
    await login(page, CUSTOMER);

    const id = await seededProjectId();
    // Open the detail of the (now archived) project to find the Unarchive control.
    await page.goto(`/app/projects/${id}/shortlist`);
    await expect(page.getByRole('heading', { name: PROJECT_TITLE })).toBeVisible({
      timeout: 30_000,
    });

    const unarchiveBtn = page.getByRole('button', { name: /dearchiveren/i }).first();
    await expect(unarchiveBtn).toBeVisible({ timeout: 10_000 });
    await unarchiveBtn.click();
    // Wait for the action + revalidate to land: the detail re-renders with the
    // Archive button instead, so the Unarchive button detaches. Navigating
    // before this races the server action (the project would still read
    // ARCHIVED and wouldn't appear under Active).
    await expect(unarchiveBtn).toBeHidden({ timeout: 20_000 });

    // Unarchive of a never-matched project → DRAFT, so it's back under Active.
    await page.goto('/app/projects');
    await expect(page.getByText(PROJECT_TITLE).first()).toBeVisible({ timeout: 15_000 });

    // And it should NOT appear under Archived anymore.
    await page.goto('/app/projects?filter=archived');
    await expect(page.getByText(PROJECT_TITLE)).toHaveCount(0, { timeout: 15_000 });
  });

  test('Rerun ("Refresh matches") button is present on an active project', async ({ page }) => {
    test.setTimeout(60_000);
    await login(page, CUSTOMER);

    const id = await seededProjectId();
    await page.goto(`/app/projects/${id}/shortlist`);
    await expect(page.getByRole('heading', { name: PROJECT_TITLE })).toBeVisible({
      timeout: 30_000,
    });

    // The rerun button (rerunMatch="Matches verversen") only renders when the
    // project is NOT archived. Presence is enough — clicking it would start a
    // real (pool-less) match, which has nothing to do here.
    await expect(page.getByRole('button', { name: /matches verversen/i }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test.afterAll(async () => {
    // Defensive: ensure the seeded project is left in its ORIGINAL state
    // (active / DRAFT) so it never leaks an ARCHIVED status into other specs,
    // even if a test above failed mid-way.
    const db = e2ePrisma();
    try {
      await db.project.updateMany({
        where: { title: PROJECT_TITLE },
        data: { status: 'DRAFT' },
      });
    } finally {
      await db.$disconnect();
    }
  });
});
