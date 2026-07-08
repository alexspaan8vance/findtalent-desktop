/**
 * Pluggable travel-time provider contract.
 *
 * A provider answers ONE origin → MANY destinations in a single call (a "matrix"
 * row) and returns durations in SECONDS, with `null` where a destination is
 * unreachable / could not be routed. Implementations must NEVER throw to the
 * caller for an expected failure (no key, network error, timeout, bad response)
 * — they return an all-null array so the caller falls back to Haversine.
 *
 * The interface is mode-generic so a future `otp.ts` / Google provider can plug
 * in OV without changing callers.
 */

import type { LatLng, TravelMode } from './haversine';

export interface TravelProvider {
  /**
   * @param origin one origin point
   * @param dests  destination points (kept transient — never persisted)
   * @param mode   'car' | 'bike' | 'ov'
   * @returns durations in seconds aligned to `dests`; null per unreachable/
   *          unknown entry. On any failure: an all-null array of length
   *          `dests.length`.
   */
  matrix(
    origin: LatLng,
    dests: LatLng[],
    mode: TravelMode,
  ): Promise<(number | null)[]>;
}

/** Helper: an all-null result of the right length (the universal fallback). */
export function nullMatrix(n: number): (number | null)[] {
  return new Array<number | null>(n).fill(null);
}
