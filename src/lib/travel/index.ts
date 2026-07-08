/**
 * Travel-time buckets: provider (ORS) with a never-fails Haversine fallback,
 * fronted by an in-memory LRU cache.
 *
 * Public surface:
 *   - `computeTravelBuckets(origin, dest, modes)` — single dest convenience.
 *   - `computeTravelBucketsMatrix(origin, dests, modes)` — BATCH; one provider
 *     call per mode for the whole batch, Haversine for any null entry.
 *
 * Anonymity: coordinates flow through here transiently (provider call + cache
 * key) and are NEVER persisted or returned. The output is bucket labels only.
 */

import type { TravelBucket, TravelBuckets } from '@/lib/anonymize/types';
import { createLru } from '@/lib/cache/lru';

import { secondsToBucket } from './bucketize';
import { estimateSeconds, haversineKm, type LatLng } from './haversine';
import { orsProvider } from './ors';
import { googleProvider } from './google';
import { otpProvider } from './otp';
import { type TravelProvider, nullMatrix } from './provider';

export type TravelMode = 'car' | 'bike' | 'ov';

// 24h TTL; 50k entries (~projects × talents × modes overlap). Keyed by mode +
// 3-decimal-rounded coords so re-runs and overlapping projects share hits.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 50_000;
const cache = createLru<TravelBucket>({ max: CACHE_MAX, ttlMs: CACHE_TTL_MS });

// A provider that always returns all-null — the universal "no OV configured"
// stand-in so the 'ov' mode stays dark (null buckets) until an env is set.
const nullProvider: TravelProvider = {
  async matrix(_origin, dests) {
    return nullMatrix(dests.length);
  },
};

/**
 * Is an OV (public-transport) source configured? OV is OFF until the operator
 * sets one of:
 *   - `GOOGLE_MAPS_API_KEY`  — Google Routes transit (PAID, see google.ts), or
 *   - `OTP_GRAPHQL_URL`      — a self-hosted OpenTripPlanner 2 (free, see otp.ts).
 * When neither is set, OV travel times are never computed (chip stays hidden).
 */
export function isOvConfigured(): boolean {
  return !!process.env.GOOGLE_MAPS_API_KEY || !!process.env.OTP_GRAPHQL_URL;
}

/**
 * Pick the OV provider by env (Google preferred when both are set), else a
 * null provider so 'ov' resolves to null buckets. Re-evaluated per call so a
 * test or runtime env change is reflected without a module reload.
 */
export function ovProvider(): TravelProvider {
  if (process.env.GOOGLE_MAPS_API_KEY) return googleProvider;
  if (process.env.OTP_GRAPHQL_URL) return otpProvider;
  return nullProvider;
}

/** Resolve the provider for a given mode: ORS for car/bike, OV provider for ov. */
function providerFor(mode: TravelMode): TravelProvider {
  return mode === 'ov' ? ovProvider() : orsProvider;
}

/**
 * OV coverage bounding box: `[minLat, minLng, maxLat, maxLng]`.
 *
 * Our self-hosted OpenTripPlanner graph only covers the Netherlands, so an OV
 * query for a talent outside it (e.g. Essen/Cologne) returns no route — but
 * still burns the full OTP timeout per dest. We short-circuit any out-of-box
 * dest (and origin) to a null OV bucket WITHOUT a provider call.
 *
 * Read from env `OTP_BBOX` ("minLat,minLng,maxLat,maxLng"); fall back to the NL
 * default on a missing/garbled value. ONLY applied to the 'ov' mode — car/bike
 * (ORS + Haversine) are global and untouched.
 */
type Bbox = readonly [number, number, number, number];
const NL_BBOX: Bbox = [50.7, 3.3, 53.6, 7.3];

function parseBbox(raw: string | undefined): Bbox {
  if (!raw) return NL_BBOX;
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return NL_BBOX;
  const [minLat, minLng, maxLat, maxLng] = parts;
  // Reject a transposed/garbled box (min must be ≤ max on both axes).
  if (minLat > maxLat || minLng > maxLng) return NL_BBOX;
  return [minLat, minLng, maxLat, maxLng] as Bbox;
}

/** True when (lat,lng) falls inside (inclusive) the bounding box. */
export function inBbox(lat: number, lng: number, bbox: Bbox): boolean {
  return lat >= bbox[0] && lat <= bbox[2] && lng >= bbox[1] && lng <= bbox[3];
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function cacheKey(mode: string, origin: LatLng, dest: LatLng): string {
  return `${mode}:${round3(origin.lat)},${round3(origin.lng)}:${round3(dest.lat)},${round3(dest.lng)}`;
}

function validCoord(p: LatLng | null | undefined): p is LatLng {
  return (
    !!p &&
    typeof p.lat === 'number' &&
    typeof p.lng === 'number' &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng)
  );
}

/** Haversine-estimated bucket for one dest+mode (the never-fails floor). */
function haversineBucket(origin: LatLng, dest: LatLng, mode: TravelMode): TravelBucket {
  return secondsToBucket(estimateSeconds(haversineKm(origin, dest), mode));
}

/**
 * BATCH compute: returns `TravelBuckets[]` aligned to `dests`.
 *
 * Per mode (1 provider call for the whole batch):
 *   1. Serve any cached dest from the LRU.
 *   2. Ask the provider for the uncached dests in one matrix call.
 *   3. For each provider entry: bucketize; if null (no key / failure /
 *      unreachable) fall back to the Haversine estimate.
 *   4. Cache the resulting bucket.
 *
 * `ov` is computed ONLY when the caller passes 'ov' AND an OV source is
 * configured (see `isOvConfigured`/`ovProvider`). Unlike car/bike, OV has NO
 * Haversine fallback (transit has no straight-line estimate) — an unknown
 * stays a null bucket. When no OV source is set, the null provider yields all
 * null, so 'ov' is harmless even if accidentally requested.
 */
export async function computeTravelBucketsMatrix(
  origin: LatLng,
  dests: Array<LatLng | null | undefined>,
  modes: TravelMode[],
): Promise<TravelBuckets[]> {
  const out: TravelBuckets[] = dests.map(() => ({}));
  if (!validCoord(origin) || dests.length === 0 || modes.length === 0) {
    return out;
  }

  // OV coverage box (parsed once). Only the 'ov' mode consults it.
  const ovBbox = parseBbox(process.env.OTP_BBOX);
  // Origin outside the OV graph → no OV route is computable for ANY dest, so
  // every 'ov' bucket is null without a single provider call.
  const ovOriginOutside = !inBbox(origin.lat, origin.lng, ovBbox);

  for (const mode of modes) {
    // Indices of dests that have valid coords and aren't cache hits.
    const needIdx: number[] = [];
    const needDest: LatLng[] = [];

    for (let i = 0; i < dests.length; i++) {
      const d = dests[i];
      if (!validCoord(d)) {
        out[i][mode] = null;
        continue;
      }
      // OV bbox guard: a dest (or origin) outside the OV graph can never yield
      // a transit route — short-circuit to a null bucket with NO provider call
      // (avoids burning the OTP timeout per out-of-coverage talent). car/bike
      // are global and ignore the box entirely.
      if (mode === 'ov' && (ovOriginOutside || !inBbox(d.lat, d.lng, ovBbox))) {
        out[i][mode] = null;
        continue;
      }
      const key = cacheKey(mode, origin, d);
      const hit = cache.get(key);
      if (hit !== undefined) {
        out[i][mode] = hit;
        continue;
      }
      needIdx.push(i);
      needDest.push(d);
    }

    if (needDest.length === 0) continue;

    // One provider matrix call for the whole batch of uncached dests.
    let durations: (number | null)[];
    try {
      durations = await providerFor(mode).matrix(origin, needDest, mode);
    } catch {
      // Defensive: provider contract says never throw, but never trust it.
      durations = needDest.map(() => null);
    }

    for (let j = 0; j < needIdx.length; j++) {
      const i = needIdx[j];
      const dest = needDest[j];
      const provided = durations[j];
      // car/bike: a null from the provider falls back to a Haversine estimate.
      // OV (transit) has NO meaningful straight-line estimate, so an unknown
      // stays a null bucket — the filter treats null as "unknown" and hides
      // the OV chip until real data lands. Never invent OV times.
      const bucket =
        provided !== null && provided !== undefined
          ? secondsToBucket(provided)
          : mode === 'ov'
            ? null
            : haversineBucket(origin, dest, mode);
      out[i][mode] = bucket;
      cache.set(cacheKey(mode, origin, dest), bucket);
    }
  }

  return out;
}

/** Single-destination convenience wrapper around the batch path. */
export async function computeTravelBuckets(
  origin: LatLng,
  dest: LatLng,
  modes: TravelMode[],
): Promise<TravelBuckets> {
  const [res] = await computeTravelBucketsMatrix(origin, [dest], modes);
  return res ?? {};
}

/** Test/maintenance helper — clears the in-memory cache. */
export function _clearTravelCache(): void {
  cache.clear();
}
