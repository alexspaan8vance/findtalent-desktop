/**
 * Unit guards for the match-view preference→filter seeding (the "N gevonden,
 * 0 getoond" prod bug): a captured preference may only pre-select filter
 * values that actually occur on the loaded rows — otherwise it becomes an
 * invisible, un-clearable filter (the facets render row-derived chips only,
 * the remote checkbox renders only when a remote row exists) that zeroes the
 * whole list while the header still counts results.
 */
import { describe, expect, it, vi } from 'vitest';

// match-client imports the server-actions module, whose import graph pulls
// `server-only` (a poison pill outside the Next server bundle) — mock it away.
// The helpers under test are pure and never touch the actions.
vi.mock('@/app/app/candidates/[id]/match/actions', () => ({
  getJobGapAction: vi.fn(),
  rematchAction: vi.fn(),
}));

import {
  seedContractSelection,
  seedRemoteOnly,
} from '@/app/app/candidates/[id]/match/match-client';

describe('seedContractSelection', () => {
  const rows = [
    { contractType: 'Vast' },
    { contractType: 'Tijdelijk' },
    { contractType: null },
  ];

  it('drops preference slugs that match no row value (never an invisible filter)', () => {
    // The wizard stores vocabulary slugs; feeds carry raw strings. No overlap
    // → seed nothing, so every row stays visible.
    expect(seedContractSelection(['permanent', 'temporary'], rows).size).toBe(0);
  });

  it('keeps a matching preference, mapped to the ROW casing so Set.has() hits', () => {
    const out = seedContractSelection(['vast'], rows);
    expect(Array.from(out)).toEqual(['Vast']);
  });

  it('is empty for empty/absent preferences', () => {
    expect(seedContractSelection([], rows).size).toBe(0);
    expect(seedContractSelection(undefined, rows).size).toBe(0);
    expect(seedContractSelection(null, rows).size).toBe(0);
  });

  it('never seeds anything when rows carry no contract data at all', () => {
    // A non-empty contract selection drops null-contract rows too — seeding
    // here would have zeroed the list with the facet not even rendered.
    expect(
      seedContractSelection(['permanent'], [{ contractType: null }]).size,
    ).toBe(0);
  });
});

describe('seedRemoteOnly', () => {
  it('stays off when no row is remote (the clearing checkbox would be hidden)', () => {
    expect(seedRemoteOnly('remote', [{ remote: false }, { remote: null }])).toBe(
      false,
    );
    expect(seedRemoteOnly('remote', [])).toBe(false);
  });

  it('engages only for workMode remote AND an actually-remote row', () => {
    const rows = [{ remote: true }, { remote: false }];
    expect(seedRemoteOnly('remote', rows)).toBe(true);
    expect(seedRemoteOnly('hybrid', rows)).toBe(false);
    expect(seedRemoteOnly('office', rows)).toBe(false);
    expect(seedRemoteOnly(undefined, rows)).toBe(false);
    expect(seedRemoteOnly(null, rows)).toBe(false);
  });
});
