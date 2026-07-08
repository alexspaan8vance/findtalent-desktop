import type { Prisma } from '@prisma/client';

/**
 * Deterministic ordering for the project match longlist / shortlist wherever the
 * `Match` rows are read for DISPLAY or EXPORT (shortlist page, pipeline board,
 * CSV/print export).
 *
 * `{ score: 'desc' }` on its own is NOT deterministic: SQLite is free to return
 * equal-score rows in an arbitrary, storage-dependent order that shifts between
 * reloads, so the same longlist visibly reshuffles under the user — and, worse,
 * a bounded `take` window can admit a *different set* of rows at the score
 * boundary each time. Appending `{ id: 'asc' }` (the Match cuid primary key —
 * unique and stable) is a total tiebreaker, so both the order and the bounded
 * window are reproducible across reloads and exports.
 *
 * Single source of truth: every longlist read imports this so the sort can
 * never drift between the three surfaces.
 */
export const MATCH_LONGLIST_ORDER_BY: Prisma.MatchOrderByWithRelationInput[] = [
  { score: 'desc' },
  { id: 'asc' },
];
