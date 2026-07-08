/**
 * Zero-dependency, never-fails travel-time fallback.
 *
 * Great-circle (haversine) distance + a flat average-speed model. This is the
 * floor: when no routing provider is configured (no `ORS_API_KEY`) or the
 * provider call fails/times out, the caller estimates duration from straight-
 * line distance so the feature degrades gracefully instead of going dark.
 *
 * Coordinates are consumed transiently in memory only — never persisted or
 * returned in any anonymized payload.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export type TravelMode = 'car' | 'bike' | 'ov';

const EARTH_RADIUS_KM = 6371;

/** Rough average door-to-door speeds (km/h). Deliberately conservative so the
 *  Haversine fallback does not over-promise vs real routed time. */
const SPEED_KMH: Record<TravelMode, number> = {
  car: 50,
  bike: 15,
  // OV has no real provider yet; the value is unused (ov returns null), but we
  // keep the map mode-complete so the type stays exhaustive.
  ov: 25,
};

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two coordinates, in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  if (
    !Number.isFinite(a.lat) ||
    !Number.isFinite(a.lng) ||
    !Number.isFinite(b.lat) ||
    !Number.isFinite(b.lng)
  ) {
    return NaN;
  }
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_KM * c;
}

/**
 * Estimate travel duration in SECONDS for a straight-line distance and mode,
 * using the flat speed model. Returns null for non-finite input so the result
 * bucketizes to `null` (unknown). Real road/path distance is longer than the
 * great-circle line, but for coarse ≥15-min buckets this is good enough as a
 * provider-less fallback.
 */
export function estimateSeconds(km: number, mode: TravelMode): number | null {
  if (!Number.isFinite(km) || km < 0) return null;
  const speed = SPEED_KMH[mode];
  if (!speed || speed <= 0) return null;
  const hours = km / speed;
  return hours * 3600;
}
