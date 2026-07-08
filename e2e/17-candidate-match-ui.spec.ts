import { test, expect } from '@playwright/test';

import { CUSTOMER, login, seededMatchCandidateId } from './helpers';

/**
 * Candidate → jobs match UI: the category-coloured SOURCE-PROVENANCE chips and
 * the TRAVEL-TIME filter, as the CUSTOMER who owns the seeded SYNCED candidate
 * "E2E Match Klaas" (see e2e/seed.ts). There is no real 8vance here (demo
 * creds), so the rendered rows come ENTIRELY from the deterministic
 * CandidateMatchRun + CandidateJobMatch.payloadJson we seed — every chip and
 * every travel-bucket below is fully under our control, never a live match.
 *
 * NOT serial / non-deleting: this candidate is kept alive across runs (the
 * GDPR-delete lives in the separate 12-candidate serial spec, on a different
 * candidate). Copy stays resilient via role/name + the nl-NL locale strings.
 *
 * Seeded rows (4, all non-agency so the default "hide agencies" toggle is inert):
 *   Alpha Backend Engineer   own pool (company==99999)  car ≤30 → "Eigen vacature"
 *   Bravo Frontend Engineer  source 'Job Explore'       car ≤30 → "Job Explore"
 *   Charlie Data Engineer    source 'OnlineVacaturesNL' car ≤60 → "OnlineVacatures.nl"
 *   Delta Platform Engineer  source 'Job Explore'       (no travel = unknown)
 *
 * On-load presets/preferences for this candidate (must never hide seeded rows):
 *   - education travel heuristic: MSc → tier wo → auto ≤60 min — offered as an
 *     opt-in SUGGESTION ("toepassen"), never active on first paint;
 *   - captured preferences whose vocabulary matches NO row: contractTypes
 *     ['permanent'] (rows carry 'Vast'/'Tijdelijk') and workMode 'remote'
 *     (no remote rows). These used to seed invisible, un-clearable filters
 *     that zeroed the entire list — the "N gevonden, 0 getoond" prod bug.
 */
test.describe('Candidate match UI — source chips + travel filter', () => {
  test('renders the seeded results, the source-provenance chips and the total count', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await login(page, CUSTOMER);
    const id = await seededMatchCandidateId();
    await page.goto(`/app/candidates/${id}/match`);

    // On the match screen for our synced candidate. Generous timeout: when
    // this spec runs FIRST on a fresh dev server, the route's cold compile
    // alone can exceed 30s on Windows.
    await expect(
      page.getByRole('heading', { name: 'E2E Match Klaas' }),
    ).toBeVisible({ timeout: 60_000 });

    // Total = the seeded row count (4). "{count} vacatures gevonden".
    await expect(page.getByText('4 vacatures gevonden')).toBeVisible({
      timeout: 30_000,
    });

    // All four seeded jobs render as cards.
    const cards = page.locator('li.ft-card');
    await expect(cards).toHaveCount(4);

    // Source-provenance chips. "Eigen vacature" (own-pool, jobOwnPool nl) and
    // "OnlineVacatures.nl" (external feed label) are unique to the card chip —
    // the facet buttons render the raw slug ("ownpool" / "OnlineVacaturesNL"),
    // so an exact match hits only the chip.
    await expect(page.getByText('Eigen vacature', { exact: true })).toBeVisible();
    await expect(
      page.getByText('OnlineVacatures.nl', { exact: true }),
    ).toBeVisible();

    // The demo-source "Job Explore" chip appears both as a card chip and as a
    // source-facet filter button; scope to the Bravo card (whose title shares
    // no text with the chip) so the assertion targets the chip only.
    const bravo = cards.filter({ hasText: 'Bravo Frontend Engineer' });
    await expect(bravo.getByText('Job Explore', { exact: true })).toBeVisible();
  });

  test('travel-time filter narrows the visible jobs and toggles the unknown row', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await login(page, CUSTOMER);
    const id = await seededMatchCandidateId();
    await page.goto(`/app/candidates/${id}/match`);

    await expect(
      page.getByRole('heading', { name: 'E2E Match Klaas' }),
    ).toBeVisible({ timeout: 30_000 });

    const cards = page.locator('li.ft-card');
    await expect(cards).toHaveCount(4);

    // The travel-time control only shows because seeded rows carry travel
    // buckets. Label + car/bike toggles (no OV — none of the rows has an OV
    // bucket).
    await expect(page.getByText('Reistijd', { exact: true })).toBeVisible();
    const carToggle = page.getByRole('button', { name: 'Auto' });
    await expect(carToggle).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fiets' })).toBeVisible();

    // The education heuristic (MSc → wo → auto ≤60) is offered as an opt-in
    // SUGGESTION — never an active filter on first paint, so the max-time
    // select stays hidden until a mode is chosen.
    await expect(
      page.getByText('Opleiding stelt een reistijd-filter voor.'),
    ).toBeVisible();
    await expect(
      page.getByRole('combobox', { name: 'Max. reistijd' }),
    ).toBeHidden();

    // Activate the car filter → the max-bucket select + include-unknown checkbox
    // appear.
    await carToggle.click();
    const maxSelect = page.getByRole('combobox', { name: 'Max. reistijd' });
    await expect(maxSelect).toBeVisible();

    const charlie = cards.filter({ hasText: 'Charlie Data Engineer' }); // car ≤60
    const delta = cards.filter({ hasText: 'Delta Platform Engineer' }); // no travel

    // Loosen to ≤60 min: every travel row qualifies and unknown is included
    // (default) → all 4 stay visible, incl. the ≤60-min Charlie.
    await maxSelect.selectOption('lt60');
    await expect(cards).toHaveCount(4);
    await expect(charlie).toHaveCount(1);

    // Tighten to ≤30 min: Charlie (car ≤60) now exceeds the cap and drops out;
    // the unknown-travel Delta is still kept (include-unknown on) → 3 visible.
    await maxSelect.selectOption('lt30');
    await expect(charlie).toHaveCount(0);
    await expect(delta).toHaveCount(1);
    await expect(cards).toHaveCount(3);

    // Turn OFF "include unknown" → the travel-less Delta row drops too → 2 left.
    const includeUnknown = page.getByRole('checkbox', {
      name: 'Onbekend meenemen',
    });
    await includeUnknown.uncheck();
    await expect(delta).toHaveCount(0);
    await expect(cards).toHaveCount(2);

    // The two survivors are the ≤30-min car rows (own pool + demo).
    await expect(cards.filter({ hasText: 'Alpha Backend Engineer' })).toHaveCount(1);
    await expect(cards.filter({ hasText: 'Bravo Frontend Engineer' })).toHaveCount(1);
  });

  test('on-load presets never silently zero the list; hydration stays clean', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    // Collect console errors from the very first document so a hydration
    // mismatch (React #418/#425 in prod, verbose in dev) cannot slip by.
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await login(page, CUSTOMER);
    const id = await seededMatchCandidateId();
    await page.goto(`/app/candidates/${id}/match`);

    await expect(
      page.getByRole('heading', { name: 'E2E Match Klaas' }),
    ).toBeVisible({ timeout: 30_000 });
    // The header total (all found rows) — the page has settled.
    await expect(page.getByText('4 vacatures gevonden')).toBeVisible({
      timeout: 30_000,
    });

    // INVARIANT (the "42 gevonden, 0 getoond" prod bug): with rows present and
    // the on-load presets active (education travel preset + captured
    // contract/remote preferences that match no row), the list is either
    // NON-EMPTY or the filtered-empty notice with its one-click reset shows.
    // The counter above may never claim results while the list renders 0 cards
    // with no visible way out.
    const cards = page.locator('li.ft-card');
    const resetBtn = page.getByRole('button', { name: /^Toon alles/ });
    const cardCount = await cards.count();
    if (cardCount === 0) {
      await expect(resetBtn).toBeVisible();
    } else {
      // Nothing silently hidden: the mismatching-vocabulary preferences must
      // not drop a single seeded row.
      expect(cardCount).toBe(4);
    }

    // Hydration must be clean on this page: server HTML == client render.
    const hydrationErrors = consoleErrors.filter((e) =>
      /hydrat|did not match|didn't match|#418|#425/i.test(e),
    );
    expect(hydrationErrors).toEqual([]);
  });

  test('filtering to zero names the active filters and "Toon alles" restores every card', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await login(page, CUSTOMER);
    const id = await seededMatchCandidateId();
    await page.goto(`/app/candidates/${id}/match`);

    await expect(
      page.getByRole('heading', { name: 'E2E Match Klaas' }),
    ).toBeVisible({ timeout: 30_000 });
    const cards = page.locator('li.ft-card');
    await expect(cards).toHaveCount(4);

    // Narrow to zero with a text search that matches nothing.
    await page.locator('input[type=search]').fill('xyzzy-geen-match');
    await expect(cards).toHaveCount(0);

    // The empty state names the ACTUAL active filter (the search term) — not a
    // hardcoded "zet uitzendbureaus uit" guess (that toggle hides nothing here:
    // no seeded row is an agency, so neither the old advice string nor an
    // agency filter-chip may render).
    await expect(page.getByText('Geen resultaten met deze filters')).toBeVisible();
    await expect(page.getByText(/Zoeken: .*xyzzy-geen-match/)).toBeVisible();
    await expect(page.getByText(/zet 'Verberg uitzendbureaus' uit/)).toHaveCount(0);
    await expect(page.getByText(/Verberg uitzendbureaus \(/)).toHaveCount(0);

    // Counter honesty: the total stays visible while 0 cards render, and the
    // one-click escape hatch is right there.
    await expect(page.getByText('4 vacatures gevonden')).toBeVisible();
    const resetBtn = page.getByRole('button', { name: 'Toon alles (4)' });
    await expect(resetBtn).toBeVisible();

    // One click restores every loaded row and clears the narrowing controls.
    await resetBtn.click();
    await expect(cards).toHaveCount(4);
    await expect(page.locator('input[type=search]')).toHaveValue('');
  });
});
