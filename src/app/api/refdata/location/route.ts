import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import { createLru } from '@/lib/cache/lru';

/**
 * Forward-geocode a free-text place query into {city, country, province,
 * lat, lon} options for the project wizard.
 *
 * Why not 8vance? `/resources/location/?q=` is a *reverse* geocoder — it
 * requires `latitude`+`longitude` and returns the nearest canonical place,
 * so it can't power a "type a city name" autocomplete. The job-create
 * payload only needs raw `city/country/lat/lon` strings, so we geocode
 * here with OpenStreetMap Nominatim (free, no API key) and feed the result
 * straight into the job. Province is used for anonymized display.
 *
 * Nominatim usage policy: <=1 req/s + a real User-Agent. We debounce on the
 * client (220ms) and cache results 1h here to stay well within limits.
 */

interface LocationRow {
  id?: number;
  city: string;
  country: string;
  province?: string;
  latitude?: string;
  longitude?: string;
}

const cache = createLru<LocationRow[]>({ max: 1000, ttlMs: 60 * 60 * 1000 });
const reverseCache = createLru<LocationRow[]>({
  max: 1000,
  ttlMs: 60 * 60 * 1000,
});

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
 * fields; forward callers fall back to the FIRST token of `display_name`
 * (the place's own label) — never the user's raw typed query, which may be
 * a partial like "hen". Reverse callers pass no displayName (a reverse
 * display_name starts with a house number/street) so an unresolvable hit
 * yields '' and is rejected.
 */
function pickCity(a: NominatimAddress, displayName?: string): string {
  const structured = (a.city ?? a.town ?? a.village ?? a.municipality ?? '').trim();
  if (structured) return structured;
  return (displayName ?? '').split(',')[0]?.trim() ?? '';
}

function pickProvince(a: NominatimAddress): string | undefined {
  return a.province ?? a.state ?? a.county ?? undefined;
}

// 8vance rejects coordinates with >4 decimal places / >8 total digits.
// Nominatim returns 7 decimals, so clamp to 4 (≈11m precision, plenty).
function clampCoord(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return undefined;
  return n.toFixed(4);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = (await auth()) as { user?: { id?: string | null } | null } | null;
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Reverse mode: `?lat=&lng=` resolves coordinates (e.g. a dragged map marker)
  // back to a canonical place. Same {city,country,province,lat,lon} shape as the
  // forward path so the wizard/edit-form location setter consumes it unchanged.
  const latRaw = req.nextUrl.searchParams.get('lat');
  const lngRaw = req.nextUrl.searchParams.get('lng');
  if (latRaw !== null || lngRaw !== null) {
    const lat = clampCoord(latRaw ?? undefined);
    const lng = clampCoord(lngRaw ?? undefined);
    if (!lat || !lng) return NextResponse.json({ results: [] });

    const rkey = `${lat},${lng}`;
    const rcached = reverseCache.get(rkey);
    if (rcached) return NextResponse.json({ results: rcached });

    try {
      const rows = await reverseGeocode(lat, lng);
      reverseCache.set(rkey, rows);
      return NextResponse.json({ results: rows });
    } catch {
      return NextResponse.json({ results: [] });
    }
  }

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (q.length < 2) return NextResponse.json({ results: [] });

  const key = q.toLowerCase();
  const cached = cache.get(key);
  if (cached) return NextResponse.json({ results: cached });

  try {
    // Prefer the local market: query Nominatim restricted to the default
    // country FIRST (so "hen" → Hengelo, not a far-away global match), and only
    // fall back to a worldwide search when there's no in-country hit. The
    // country is configurable (GEOCODER_COUNTRY, ISO-2; default "nl").
    const country = (process.env.GEOCODER_COUNTRY ?? 'nl').toLowerCase();
    let rows = await geocode(q, country);
    if (rows.length === 0) rows = await geocode(q, null); // worldwide fallback
    cache.set(key, rows);
    return NextResponse.json({ results: rows });
  } catch {
    return NextResponse.json({ results: [] });
  }
}

/** One Nominatim forward-geocode pass; `countryCode` (ISO-2) restricts results. */
async function geocode(q: string, countryCode: string | null): Promise<LocationRow[]> {
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
  const rows: LocationRow[] = [];
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
 * One Nominatim REVERSE-geocode pass: lat/lng → nearest canonical place, mapped
 * to the same LocationRow shape as the forward path. Returns [] when Nominatim
 * has no usable hit. Uses the dragged coords as the returned lat/lon fallback so
 * a missing Nominatim coord never strands the marker.
 */
async function reverseGeocode(lat: string, lng: string): Promise<LocationRow[]> {
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('lat', lat);
  url.searchParams.set('lon', lng);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', 'nl,en');

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) return [];
  const r = (await res.json()) as NominatimResult & { error?: string };
  if (r.error || !r.address) return [];
  const a = r.address;
  const city = pickCity(a);
  if (!city) return [];
  return [
    {
      city,
      country: a.country ?? '',
      province: pickProvince(a),
      latitude: clampCoord(r.lat) ?? lat,
      longitude: clampCoord(r.lon) ?? lng,
    },
  ];
}
