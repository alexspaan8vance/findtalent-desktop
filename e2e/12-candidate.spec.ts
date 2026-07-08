import { test, expect } from '@playwright/test';

import { CUSTOMER, SEEDED_CANDIDATE_EMAIL, login, seededCandidateId } from './helpers';

/**
 * Candidate match screen + CV-profiel preview + GDPR export/delete, all as the
 * CUSTOMER who owns the seeded "E2E Candidate Klaas" (see e2e/seed.ts). The
 * candidate lives on the DEMO pool (bogus 8vance creds), is NOT synced, has
 * consent + 3 skills — so a sync attempt is expected to FAIL with a clear
 * reason, never hang.
 *
 * Serial: the final test hard-deletes the seeded candidate (GDPR Art.17), so
 * test order matters — keep the delete test LAST. Match assertions are kept
 * resilient (no real job results asserted) because the demo-pool match is
 * non-deterministic / fails by design.
 */
test.describe.serial('Candidate match + CV preview + GDPR', () => {
  test('candidate list shows the seeded candidate and links to its match screen', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await login(page, CUSTOMER);
    await page.goto('/app/candidates');

    // The seeded candidate is rendered by name in the list.
    await expect(page.getByText('E2E Candidate Klaas').first()).toBeVisible({
      timeout: 30_000,
    });

    // Navigate to the match screen (list row links to /match for any status;
    // go directly by id to stay robust against the list layout).
    const id = await seededCandidateId();
    await page.goto(`/app/candidates/${id}/match`);

    // Header eyebrow + candidate name confirm we are on the match screen.
    await expect(
      page.getByRole('heading', { name: 'E2E Candidate Klaas' }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('CV-profiel preview renders the parsed skills + employment depth', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await login(page, CUSTOMER);
    const id = await seededCandidateId();
    await page.goto(`/app/candidates/${id}/match`);

    // The full talent-profile renders an always-expanded profile (replaced the
    // old collapsed CV-profiel <details>). For the seeded demo-pool candidate the
    // live 8vance fetch fails, so it falls back to the stored profileJson.cv —
    // skills + employment must still render. Generous timeout covers the
    // live-fetch attempt + fallback.
    await expect(page.getByText('Python', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('SQL', { exact: true })).toBeVisible();
    await expect(page.getByText('Docker', { exact: true })).toBeVisible();

    // Parsed employment line: "Backend Engineer · Acme" (title · company).
    // Scope to the exact employment-line span — bare /Acme/ also matches the
    // full-CV-text <pre> block (that block existing IS the CV-preview fix), so
    // assert the structured line specifically to avoid a strict-mode match.
    await expect(page.getByText(/Backend Engineer\s*·\s*Acme/)).toBeVisible();
  });

  test('not-synced match state shows a clear sync control and surfaces a failure reason', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await login(page, CUSTOMER);
    const id = await seededCandidateId();
    await page.goto(`/app/candidates/${id}/match`);

    // Unsynced + no run → the not-synced empty state, NOT a silent blank.
    await expect(
      page.getByText('Kandidaat nog niet gesynchroniseerd'),
    ).toBeVisible({ timeout: 30_000 });

    // The control reads "Synchroniseren & matchen" (sync-and-match wording for
    // an unsynced candidate).
    const syncBtn = page.getByRole('button', {
      name: /synchroniseren & matchen/i,
    });
    await expect(syncBtn).toBeVisible();
    await syncBtn.click();

    // Demo-pool has bogus 8vance creds → sync fails. A clear reason surfaces
    // in the red error paragraph; the page does NOT hang silently on a blank
    // screen. Scope to the visible error copy (the bare role="alert" also
    // matches Next's empty route-announcer div). errSyncFailed copy expected,
    // but stay resilient to any sync/8vance failure wording.
    const alert = page
      .getByText(/8vance|synchroniseren|sync|mislukt|toestemming|credentials|verbinding/i)
      .filter({ hasText: /mislukt|8vance|sync|credentials/i })
      .first();
    await expect(alert).toBeVisible({ timeout: 60_000 });

    // Sanity: the button is interactive again (transition resolved, no hang).
    await expect(syncBtn).toBeEnabled({ timeout: 30_000 });
  });

  test('GDPR export returns authed JSON containing the candidate name + email', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await login(page, CUSTOMER);
    const id = await seededCandidateId();

    // Authed via the logged-in page context's cookies.
    const res = await page.request.get(`/api/candidates/${id}/export`);
    expect(res.ok()).toBe(true);

    const body = await res.json();
    expect(body.candidate?.name).toBe('E2E Candidate Klaas');
    expect(body.candidate?.email).toBe(SEEDED_CANDIDATE_EMAIL);
    // Export carries the portability marker + a matchRuns summary array.
    expect(body.exportType).toContain('gdpr');
    expect(Array.isArray(body.matchRuns)).toBe(true);
  });

  // LAST: hard-deletes the seeded candidate (GDPR Art.17). Keep final.
  test('GDPR delete erases the candidate from the list and 404s the detail', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await login(page, CUSTOMER);
    const id = await seededCandidateId();
    await page.goto(`/app/candidates/${id}/match`);

    // Trigger the confirm-gated delete in the GDPR controls.
    await page.getByRole('button', { name: 'Kandidaat verwijderen' }).click();
    const confirmBtn = page.getByRole('button', { name: 'Ja, verwijderen' });
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    // Routes back to the candidates list; the deleted candidate is gone.
    await page.waitForURL(/\/app\/candidates(\?|$)/, { timeout: 30_000 });
    await expect(page.getByText('E2E Candidate Klaas')).toHaveCount(0, {
      timeout: 30_000,
    });

    // The detail/export route now 404s (row physically gone, PII erased).
    const res = await page.request.get(`/api/candidates/${id}/export`);
    expect(res.status()).toBe(404);
  });
});
