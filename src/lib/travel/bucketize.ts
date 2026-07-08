/**
 * Travel-time bucketization.
 *
 * Converts a raw travel duration (seconds) into a COARSE ≥15-minute bucket.
 * The whole anonymity story rests on this: we never expose minutes or
 * coordinates downstream, only one of these five labels (or null).
 */

import type { TravelBucket } from '@/lib/anonymize/types';

const FIFTEEN_MIN = 15 * 60; // 900
const THIRTY_MIN = 30 * 60; // 1800
const FORTYFIVE_MIN = 45 * 60; // 2700
const SIXTY_MIN = 60 * 60; // 3600

/**
 * Map a duration in seconds to a coarse bucket.
 *
 *   < 900   → 'lt15'
 *   < 1800  → 'lt30'
 *   < 2700  → 'lt45'
 *   < 3600  → 'lt60'
 *   finite  → 'gt60'
 *   null / NaN / non-finite → null  (unknown / unreachable)
 *
 * Negative inputs are clamped into 'lt15' (treated as ~zero distance).
 */
export function secondsToBucket(s: number | null): TravelBucket {
  if (s === null || s === undefined) return null;
  if (typeof s !== 'number' || !Number.isFinite(s)) return null;
  if (s < FIFTEEN_MIN) return 'lt15';
  if (s < THIRTY_MIN) return 'lt30';
  if (s < FORTYFIVE_MIN) return 'lt45';
  if (s < SIXTY_MIN) return 'lt60';
  return 'gt60';
}

/**
 * Ordinal rank for each bucket, ascending by travel time. `null` (unknown)
 * sorts LAST so a "max 30 min" filter downstream can treat unknowns as
 * "does not satisfy". Use for `<=` comparisons, e.g.
 *   BUCKET_RANK[talent] <= BUCKET_RANK[maxAllowed]
 */
export const BUCKET_RANK: Record<NonNullable<TravelBucket>, number> & {
  null: number;
} = {
  lt15: 0,
  lt30: 1,
  lt45: 2,
  lt60: 3,
  gt60: 4,
  null: 5,
};

/** Safe rank lookup that treats `null` as the dedicated "unknown" rank. */
export function bucketRank(b: TravelBucket): number {
  return b === null ? BUCKET_RANK.null : BUCKET_RANK[b];
}
