/**
 * Google Routes API (Compute Route Matrix) — TRANSIT / OV provider.
 *
 * ⚠ PAID API. Google's Routes API bills per element (origin × destination).
 *   Only used when the operator explicitly sets `GOOGLE_MAPS_API_KEY`; absent
 *   key → all-null (OV stays dark, no calls, no cost). Read the pricing before
 *   enabling: https://developers.google.com/maps/billing-and-pricing/pricing
 *
 * One origin → many destinations in a SINGLE call via:
 *   POST https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix
 *   header: X-Goog-Api-Key: <key>
 *   header: X-Goog-FieldMask: originIndex,destinationIndex,duration,condition
 *   body: {
 *     origins:      [{ waypoint:{ location:{ latLng:{ latitude, longitude }}}}],
 *     destinations: [{ waypoint:{ location:{ latLng:{ latitude, longitude }}}}],
 *     travelMode:   'TRANSIT',
 *   }
 *
 * Google coordinates are { latitude, longitude } (NOT [lng,lat] like ORS).
 *
 * Response shape (computeRouteMatrix streams a flat array of elements, one per
 * origin×destination pair):
 *   [ { originIndex, destinationIndex, duration: "1234s", condition: "ROUTE_EXISTS" }, ... ]
 * We send exactly ONE origin (index 0), so every element's `originIndex` is 0
 * and `destinationIndex` maps to `dests[i]`. `duration` is a string like
 * "1234s"; we parse the leading number → seconds. Missing element / non-finite
 * duration / condition !== ROUTE_EXISTS → null (→ unknown bucket).
 *
 * ⚠ ASSUMPTIONS (cannot live-test without a billed key):
 *   - The endpoint returns a flat array keyed by origin/destination indices,
 *     possibly out of order — so we scatter results back by `destinationIndex`
 *     rather than trusting array position.
 *   - `duration` is the ISO-8601-ish "<seconds>s" string Google uses for Routes
 *     v2. We parse defensively (parseFloat of the leading number) and coerce any
 *     non-finite result to null.
 *   - `condition` of "ROUTE_EXISTS" signals a routable pair; anything else
 *     (e.g. "ROUTE_NOT_FOUND") → null. If the field is absent we still accept a
 *     finite duration (degrade-open on the duration, not the condition).
 *
 * Failure policy: missing key, non-2xx, network error, timeout, parse failure,
 * or a non-'ov' mode → all-null array. Never throws to the caller.
 */

import type { LatLng, TravelMode } from './haversine';
import { type TravelProvider, nullMatrix } from './provider';

const GOOGLE_MATRIX_URL =
  'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const TIMEOUT_MS = 8000;
// Defensive cap — Google allows up to 625 elements per request; we never need
// near that for a single shortlist page, and a cap bounds the cost/latency.
const MAX_DESTS = 100;

interface GoogleWaypoint {
  waypoint: { location: { latLng: { latitude: number; longitude: number } } };
}

function waypoint(p: LatLng): GoogleWaypoint {
  return { waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } };
}

/** Parse Google's "<seconds>s" duration string (or number) → seconds | null. */
function parseDuration(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v); // "1234s" → 1234
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export const googleProvider: TravelProvider = {
  async matrix(
    origin: LatLng,
    dests: LatLng[],
    mode: TravelMode,
  ): Promise<(number | null)[]> {
    const n = dests.length;
    if (n === 0) return [];

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    // OV-only provider; car/bike are served by ORS upstream.
    if (!apiKey || mode !== 'ov' || n > MAX_DESTS) return nullMatrix(n);

    const body = {
      origins: [waypoint(origin)],
      destinations: dests.map(waypoint),
      travelMode: 'TRANSIT',
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(GOOGLE_MATRIX_URL, {
        method: 'POST',
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask':
            'originIndex,destinationIndex,duration,condition',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return nullMatrix(n);
      const json: unknown = await res.json();
      return scatter(json, n);
    } catch {
      // Network error / abort / JSON parse failure → fall back to null.
      return nullMatrix(n);
    } finally {
      clearTimeout(timer);
    }
  },
};

/**
 * Scatter a flat element array back into a dests-aligned row, defensively.
 * Each element: { destinationIndex, duration, condition }. Out-of-range or
 * malformed indices are ignored; unset entries stay null.
 */
function scatter(json: unknown, n: number): (number | null)[] {
  const out = nullMatrix(n);
  if (!Array.isArray(json)) return out;
  for (const el of json) {
    if (!el || typeof el !== 'object') continue;
    const rec = el as Record<string, unknown>;
    const di = rec.destinationIndex;
    if (typeof di !== 'number' || !Number.isInteger(di) || di < 0 || di >= n) {
      continue;
    }
    // Reject pairs Google explicitly marks unroutable; accept when absent.
    const cond = rec.condition;
    if (typeof cond === 'string' && cond !== 'ROUTE_EXISTS') continue;
    out[di] = parseDuration(rec.duration);
  }
  return out;
}
