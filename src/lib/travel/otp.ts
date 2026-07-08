/**
 * OpenTripPlanner 2 (self-hosted, FREE) — TRANSIT / OV provider.
 *
 * Self-host OTP2 against a GTFS feed + OSM extract; point this adapter at its
 * GraphQL endpoint via `OTP_GRAPHQL_URL` (e.g.
 * `http://localhost:8080/otp/gtfs/v1`). Absent URL → all-null (OV stays dark,
 * no calls). No cost beyond running your own server.
 *
 * OTP has NO matrix endpoint, so `matrix` fans out one GraphQL `planConnection`
 * query per destination (origin→dest, modes WALK + TRANSIT), bounded by a small
 * concurrency pool, and reads the FASTEST itinerary's duration (seconds). A
 * per-dest failure (network/parse/no-itinerary) yields null for THAT dest only;
 * the call never throws.
 *
 * DIALECT AUTO-DETECT: OTP2 has two GraphQL shapes across versions —
 *   - modern (≥2.4): `planConnection(origin,destination,dateTime,modes,first)`
 *                     → `edges { node { duration } }`
 *   - legacy:        `plan(from,to,date,time,transportModes,numItineraries)`
 *                     → `itineraries { duration }`
 * We try the modern query first; if the server replies with a GraphQL `errors`
 * array (unsupported field), we retry the legacy query and REMEMBER whichever
 * dialect worked for the rest of the process. `duration` is SECONDS in both.
 * Verified end-to-end against a self-hosted OTP2 (NL graph) — 32 min
 * Amsterdam→Utrecht.
 *
 * Notes:
 *   - Depart time defaults to a "now-ish" upcoming weekday 09:00 (configurable
 *     via OTP_DEPART_AT) so transit schedules are populated; a garbled override
 *     falls back to the computed default.
 *   - The transit mode whitelist is broad (BUS/RAIL/TRAM/SUBWAY/FERRY) so any
 *     feed's modes are covered.
 *
 * Failure policy: missing url, non-2xx, error, non-'ov' mode, or > MAX_DESTS
 * → all-null. Each dest independently degrades to null. Never throws.
 */

import type { LatLng, TravelMode } from './haversine';
import { type TravelProvider, nullMatrix } from './provider';

// Out-of-coverage (e.g. non-NL) destinations get short-circuited by the bbox
// guard in travel/index.ts and never reach this provider, so a stuck request
// here is only ever a real NL route that's slow. Keep the ceiling tight (4s)
// so one wedged dest can't dominate a re-hydrate.
const TIMEOUT_MS = 4000;
const CONCURRENCY = 5;
// Cap to avoid hammering a self-hosted instance (one HTTP round-trip per dest).
const MAX_DESTS = 50;

const TRANSIT_MODES = ['BUS', 'RAIL', 'TRAM', 'SUBWAY', 'FERRY'];

// Modern OTP2 (≥2.4) GraphQL: `planConnection` with the typed scalar inputs.
const QUERY_MODERN = `
query Plan($fromLat: CoordinateValue!, $fromLng: CoordinateValue!, $toLat: CoordinateValue!, $toLng: CoordinateValue!, $when: OffsetDateTime!, $modes: [TransitModePreferenceInput!]!) {
  planConnection(
    origin: { location: { coordinate: { latitude: $fromLat, longitude: $fromLng } } }
    destination: { location: { coordinate: { latitude: $toLat, longitude: $toLng } } }
    dateTime: { earliestDeparture: $when }
    modes: { direct: [WALK], transit: { transit: $modes } }
    first: 1
  ) {
    edges { node { duration } }
  }
}`.trim();

// Legacy OTP2 GraphQL: the older `plan(from,to,date,time,transportModes)` field,
// still served by many self-hosted builds. `date` = YYYY-MM-DD, `time` = HH:mm:ss.
const QUERY_LEGACY = `
query PlanLegacy($fromLat: Float!, $fromLng: Float!, $toLat: Float!, $toLng: Float!, $date: String!, $time: String!) {
  plan(
    from: { lat: $fromLat, lon: $fromLng }
    to: { lat: $toLat, lon: $toLng }
    date: $date
    time: $time
    transportModes: [{ mode: WALK }, { mode: TRANSIT }]
    numItineraries: 1
  ) {
    itineraries { duration }
  }
}`.trim();

// Which GraphQL dialect this OTP instance speaks, learned on first success so we
// stop paying the modern→legacy retry on every subsequent destination.
type Dialect = 'modern' | 'legacy';
let learnedDialect: Dialect | null = null;

/** Test-only: forget the learned GraphQL dialect between cases. */
export function _resetOtpDialect(): void {
  learnedDialect = null;
}

/**
 * Resolve the departure instant: `OTP_DEPART_AT` (ISO) if valid, else the next
 * upcoming weekday at 09:00 local — a sane "now-ish" time when transit runs.
 */
function departAt(): Date {
  const override = process.env.OTP_DEPART_AT;
  if (override) {
    const t = Date.parse(override);
    if (Number.isFinite(t)) return new Date(t);
  }
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  // If it's already past 09:00 today, roll to tomorrow.
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  // Skip Sat(6)/Sun(0) → next Monday.
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

const MIN = (a: number | null, dur: number): number =>
  a === null ? dur : Math.min(a, dur);

/** Smallest finite `duration` (seconds) under either response shape. */
function fastestDuration(json: unknown, dialect: Dialect): number | null {
  const data = (json as { data?: Record<string, unknown> })?.data;
  const items =
    dialect === 'modern'
      ? (data as { planConnection?: { edges?: unknown } } | undefined)?.planConnection
          ?.edges
      : (data as { plan?: { itineraries?: unknown } } | undefined)?.plan?.itineraries;
  if (!Array.isArray(items)) return null;
  let best: number | null = null;
  for (const it of items) {
    // modern: edge.node.duration ; legacy: itinerary.duration
    const dur =
      dialect === 'modern'
        ? (it as { node?: { duration?: unknown } })?.node?.duration
        : (it as { duration?: unknown })?.duration;
    if (typeof dur === 'number' && Number.isFinite(dur)) best = MIN(best, dur);
  }
  return best;
}

/** True when a GraphQL response carries a top-level `errors` array. */
function hasGraphQLError(json: unknown): boolean {
  const errs = (json as { errors?: unknown })?.errors;
  return Array.isArray(errs) && errs.length > 0;
}

/** One POST in a specific dialect → fastest duration, or null on any failure. */
async function planDialect(
  url: string,
  origin: LatLng,
  dest: LatLng,
  when: Date,
  dialect: Dialect,
): Promise<{ ok: boolean; duration: number | null }> {
  const variables =
    dialect === 'modern'
      ? {
          fromLat: origin.lat,
          fromLng: origin.lng,
          toLat: dest.lat,
          toLng: dest.lng,
          when: when.toISOString(),
          modes: TRANSIT_MODES.map((mode) => ({ mode })),
        }
      : {
          fromLat: origin.lat,
          fromLng: origin.lng,
          toLat: dest.lat,
          toLng: dest.lng,
          date: when.toISOString().slice(0, 10), // YYYY-MM-DD
          time: when.toISOString().slice(11, 19), // HH:mm:ss (UTC)
        };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query: dialect === 'modern' ? QUERY_MODERN : QUERY_LEGACY,
        variables,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, duration: null };
    const json: unknown = await res.json();
    // A 200 with a GraphQL error means this dialect's query is unsupported —
    // signal "not ok" so the caller can try the other dialect.
    if (hasGraphQLError(json)) return { ok: false, duration: null };
    return { ok: true, duration: fastestDuration(json, dialect) };
  } catch {
    return { ok: false, duration: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve one origin→dest transit duration, auto-detecting which GraphQL dialect
 * this OTP speaks. Tries the learned dialect first; on an unsupported-query
 * signal it tries the other and remembers whichever works for the process.
 */
async function planOne(
  url: string,
  origin: LatLng,
  dest: LatLng,
  when: Date,
): Promise<number | null> {
  const order: Dialect[] =
    learnedDialect === 'legacy' ? ['legacy', 'modern'] : ['modern', 'legacy'];
  for (const dialect of order) {
    const { ok, duration } = await planDialect(url, origin, dest, when, dialect);
    if (ok) {
      learnedDialect = dialect;
      return duration;
    }
  }
  return null;
}

export const otpProvider: TravelProvider = {
  async matrix(
    origin: LatLng,
    dests: LatLng[],
    mode: TravelMode,
  ): Promise<(number | null)[]> {
    const n = dests.length;
    if (n === 0) return [];

    const url = process.env.OTP_GRAPHQL_URL;
    if (!url || mode !== 'ov' || n > MAX_DESTS) return nullMatrix(n);

    const when = departAt();
    const out = nullMatrix(n);

    // Bounded fan-out: process dests in chunks of CONCURRENCY.
    let cursor = 0;
    async function worker(): Promise<void> {
      for (;;) {
        const i = cursor++;
        if (i >= n) return;
        out[i] = await planOne(url!, origin, dests[i], when);
      }
    }
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, n) },
      () => worker(),
    );
    try {
      await Promise.all(workers);
    } catch {
      // planOne never throws, but stay defensive: whatever resolved stays,
      // unresolved entries remain null.
    }
    return out;
  },
};
