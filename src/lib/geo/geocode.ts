/**
 * Shared forward-geocoder (Nominatim / OpenStreetMap). Extracted from the
 * refdata/location route so both the autocomplete endpoint AND server actions
 * (e.g. geocoding a candidate's desired work regions at onboarding) resolve a
 * free-text place to {city, country, province, lat, lng} through one code path.
 *
 * Nominatim usage policy: <=1 req/s + a real User-Agent. The route caches +
 * debounces; callers doing a handful of one-shot lookups (a few regions per
 * onboarding) stay well within the limit.
 */

export interface GeoPlace {
  city: string;
  country: string;
  province?: string;
  latitude?: string;
  longitude?: string;
}

const USER_AGENT =
  process.env.GEOCODER_USER_AGENT ?? 'findtalent/1.0 (+https://findtalent.local)';

interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  state?: string;
  province?: string;
  county?: string;
  country?: string;
}

interface NominatimResult {
  lat?: string;
  lon?: string;
  display_name?: string;
  address?: NominatimAddress;
}

/**
 * Best display city for a Nominatim hit. Prefers the structured address
 * fields; otherwise falls back to the FIRST token of `display_name` (the
 * place's own label, e.g. "Hengelo, Overijssel, Nederland" → "Hengelo") —
 * never the user's raw typed query, which may be a partial like "hen".
 * Returns '' when nothing usable exists; callers must reject empty.
 */
function pickCity(a: NominatimAddress, displayName: string | undefined): string {
  const structured = (a.city ?? a.town ?? a.village ?? a.municipality ?? '').trim();
  if (structured) return structured;
  return (displayName ?? '').split(',')[0]?.trim() ?? '';
}

function pickProvince(a: NominatimAddress): string | undefined {
  return a.province ?? a.state ?? a.county ?? undefined;
}

// 8vance rejects coordinates with >4 decimal places / >8 total digits.
// Nominatim returns 7 decimals, so clamp to 4 (≈11m precision, plenty).
export function clampCoord(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return undefined;
  return n.toFixed(4);
}

/** One Nominatim forward-geocode pass; `countryCode` (ISO-2) restricts results. */
export async function geocode(
  q: string,
  countryCode: string | null,
): Promise<GeoPlace[]> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '6');
  url.searchParams.set('accept-language', 'nl,en');
  if (countryCode) url.searchParams.set('countrycodes', countryCode);

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) return [];
  const raw = (await res.json()) as NominatimResult[];
  const seen = new Set<string>();
  const rows: GeoPlace[] = [];
  for (const r of raw) {
    const a = r.address ?? {};
    const city = pickCity(a, r.display_name);
    if (!city) continue; // no resolvable place label → unusable row
    const country = a.country ?? '';
    if (!r.lat || !r.lon) continue;
    const dedupe = `${city}|${country}`.toLowerCase();
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    rows.push({
      city,
      country,
      province: pickProvince(a),
      latitude: clampCoord(r.lat),
      longitude: clampCoord(r.lon),
    });
  }
  return rows;
}

/**
 * Resolve ONE place label to its best coordinate, preferring the local market
 * (GEOCODER_COUNTRY, default "nl") then a worldwide fallback. Returns null when
 * nothing usable (with coords) comes back. Best-effort: any failure → null.
 */
export async function geocodePlace(q: string): Promise<GeoPlace | null> {
  const label = (q ?? '').trim();
  if (label.length < 2) return null;
  try {
    const country = (process.env.GEOCODER_COUNTRY ?? 'nl').toLowerCase();
    let rows = await geocode(label, country);
    if (rows.length === 0) rows = await geocode(label, null);
    const withCoords = rows.find((r) => r.latitude && r.longitude);
    return withCoords ?? rows[0] ?? null;
  } catch {
    return null;
  }
}
