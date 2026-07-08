/**
 * OpenRouteService Matrix provider.
 *
 * One origin → many destinations in a SINGLE call via the ORS Matrix API:
 *   POST https://api.openrouteservice.org/v2/matrix/{profile}
 *   profile: 'driving-car' (car) | 'cycling-regular' (bike)
 *   body: { locations: [[lng,lat], ...], sources:[0], destinations:[1..N],
 *           metrics:['duration'] }
 *   header: Authorization: <ORS_API_KEY>
 *
 * ORS expects coordinates as [lng, lat] (GeoJSON order), NOT [lat, lng].
 *
 * Response shape (per ORS docs):
 *   { durations: number[][], ... }   // seconds; null entries = unreachable
 * We request a single source (index 0 = origin) so `durations` is a 1×N matrix:
 * `durations[0]` is the row of origin→dest durations aligned to `destinations`.
 *
 * ⚠ ASSUMPTION (cannot live-test without a key): `durations[0][i]` aligns to
 * `dests[i]`. We send `sources:[0]` and `destinations:[1..N]` over a `locations`
 * array of `[origin, ...dests]`, which by the ORS contract yields exactly one
 * source row whose columns follow `destinations` order. If ORS ever reordered
 * or omitted entries we coerce non-numbers to null (→ Haversine fallback), so a
 * shape surprise degrades safely rather than throwing.
 *
 * Failure policy: missing key, non-2xx, network error, or timeout → all-null
 * array (caller falls back to Haversine). Never throws to the caller.
 * OV has no free provider — handled upstream (returns all-null here too).
 */

import type { LatLng, TravelMode } from './haversine';
import { type TravelProvider, nullMatrix } from './provider';

const ORS_BASE = 'https://api.openrouteservice.org/v2/matrix';
const TIMEOUT_MS = 8000;

const PROFILE: Partial<Record<TravelMode, string>> = {
  car: 'driving-car',
  bike: 'cycling-regular',
  // ov: no free ORS profile — left undefined → all-null.
};

export const orsProvider: TravelProvider = {
  async matrix(
    origin: LatLng,
    dests: LatLng[],
    mode: TravelMode,
  ): Promise<(number | null)[]> {
    const n = dests.length;
    if (n === 0) return [];

    const apiKey = process.env.ORS_API_KEY;
    const profile = PROFILE[mode];
    if (!apiKey || !profile) return nullMatrix(n);

    // [lng, lat] order. Index 0 = origin (the single source).
    const locations: [number, number][] = [
      [origin.lng, origin.lat],
      ...dests.map((d) => [d.lng, d.lat] as [number, number]),
    ];
    const destinations = dests.map((_, i) => i + 1);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${ORS_BASE}/${profile}`, {
        method: 'POST',
        headers: {
          Authorization: apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          locations,
          sources: [0],
          destinations,
          metrics: ['duration'],
        }),
        signal: controller.signal,
      });
      if (!res.ok) return nullMatrix(n);
      const json: unknown = await res.json();
      const row = extractRow(json);
      if (!row) return nullMatrix(n);
      // Align to dests; coerce any non-finite/missing entry to null.
      return dests.map((_, i) => {
        const v = row[i];
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
      });
    } catch {
      // Network error / abort / JSON parse failure → fall back.
      return nullMatrix(n);
    } finally {
      clearTimeout(timer);
    }
  },
};

/** Pull the single source row out of the ORS `durations` matrix, defensively. */
function extractRow(json: unknown): (number | null)[] | null {
  if (!json || typeof json !== 'object') return null;
  const durations = (json as { durations?: unknown }).durations;
  if (!Array.isArray(durations) || durations.length === 0) return null;
  const first = durations[0];
  if (!Array.isArray(first)) return null;
  return first as (number | null)[];
}
