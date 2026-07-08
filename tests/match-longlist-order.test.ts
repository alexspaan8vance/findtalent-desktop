import { describe, it, expect } from 'vitest';

import { MATCH_LONGLIST_ORDER_BY } from '../src/lib/match/longlist-order';

/**
 * Guards the determinism fix: the project match longlist must order by score
 * desc AND carry a unique, stable tiebreaker so equal-score rows can't reshuffle
 * between reloads / exports. This asserts the shared orderBy spec that all three
 * longlist reads (shortlist page, pipeline board, export route) consume.
 */
describe('MATCH_LONGLIST_ORDER_BY', () => {
  it('sorts by score descending as the primary key', () => {
    expect(MATCH_LONGLIST_ORDER_BY[0]).toEqual({ score: 'desc' });
  });

  it('appends a unique, stable tiebreaker (id asc) so ordering is deterministic', () => {
    // Without a total tiebreaker on a unique column, equal-score rows come back
    // in an arbitrary, reload-dependent order.
    const last = MATCH_LONGLIST_ORDER_BY[MATCH_LONGLIST_ORDER_BY.length - 1];
    expect(last).toEqual({ id: 'asc' });
    expect(MATCH_LONGLIST_ORDER_BY).toContainEqual({ id: 'asc' });
  });

  it('produces a fully deterministic order for a synthetic tie', () => {
    // Simulate what SQLite does with this orderBy: sort by score desc, then id
    // asc. Two reversed inputs with tied scores must collapse to one order.
    const sortByOrderBy = <T extends { score: number; id: string }>(rows: T[]): T[] =>
      [...rows].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const a = { id: 'a', score: 90 };
    const b = { id: 'b', score: 90 };
    const c = { id: 'c', score: 80 };
    const forward = sortByOrderBy([a, b, c]).map((r) => r.id);
    const reversed = sortByOrderBy([c, b, a]).map((r) => r.id);

    expect(forward).toEqual(['a', 'b', 'c']);
    expect(reversed).toEqual(forward);
  });
});
