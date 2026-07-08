'use client';

/**
 * Leaflet map for the candidate→jobs match view. Plots the candidate's home
 * (origin) plus every job that has coordinates, colouring each job marker by
 * its travel-time bucket for the selected mode (green = close … red = far,
 * grey = unknown) and drawing a radius ring for the active distance filter.
 *
 * Leaflet touches `window`, so this module is dynamic-imported with `ssr:false`
 * by the match client (mirrors components/location-picker-map).
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  Circle,
  CircleMarker,
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import type { TravelBucket } from '@/lib/anonymize/types';
import type { TravelMode } from '@/lib/travel/haversine';

// Marker assets served from /public (copied from leaflet/dist/images) — no
// third-party CDN request (mirrors components/location-picker-map).
const ORIGIN_ICON = L.icon({
  iconUrl: '/leaflet/marker-icon.png',
  iconRetinaUrl: '/leaflet/marker-icon-2x.png',
  shadowUrl: '/leaflet/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

export interface JobsMapJob {
  id: string;
  title: string;
  city: string | null;
  score: number; // 0..100 percent, already normalized
  lat: number;
  lng: number;
  /** Travel-time bucket for the currently-selected mode (drives the colour). */
  bucket: TravelBucket;
}

export interface JobsMapProps {
  origin: { lat: number; lng: number; city: string | null } | null;
  jobs: JobsMapJob[];
  /** Active distance-filter radius (km); 0 = no ring. */
  radiusKm?: number;
  /**
   * Selected travel mode. When set, each job popup shows its travel-time
   * bucket for that mode (the buckets on the rows are mode-specific).
   */
  travelMode?: TravelMode | null;
  originLabel: string;
}

const NL_BOUNDS: L.LatLngBoundsExpression = [
  [50.75, 3.36],
  [53.55, 7.23],
];

/** Marker colour per travel-time bucket (green → red, grey = unknown). */
function bucketColor(b: TravelBucket): string {
  switch (b) {
    case 'lt15':
      return '#16a34a';
    case 'lt30':
      return '#65a30d';
    case 'lt45':
      return '#ca8a04';
    case 'lt60':
      return '#ea580c';
    case 'gt60':
      return '#dc2626';
    default:
      return '#9ca3af';
  }
}

/** i18n key (candidateMatch ns) for a known travel bucket, null for unknown. */
function bucketLabelKey(
  b: TravelBucket,
): 'travelBucket_lt15' | 'travelBucket_lt30' | 'travelBucket_lt45' | 'travelBucket_lt60' | 'travelBucket_gt60' | null {
  switch (b) {
    case 'lt15':
      return 'travelBucket_lt15';
    case 'lt30':
      return 'travelBucket_lt30';
    case 'lt45':
      return 'travelBucket_lt45';
    case 'lt60':
      return 'travelBucket_lt60';
    case 'gt60':
      return 'travelBucket_gt60';
    default:
      return null;
  }
}

/** i18n key (candidateMatch ns) for a travel mode's display name. */
function modeLabelKey(m: TravelMode): 'travelCar' | 'travelBike' | 'travelOv' {
  return m === 'car' ? 'travelCar' : m === 'bike' ? 'travelBike' : 'travelOv';
}

/** One colored legend dot + label. */
function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: color, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.12)' }}
      />
      {label}
    </span>
  );
}

/**
 * Travel-time legend for the jobs map: one dot per bucket in the EXACT marker
 * colours (`bucketColor`), so five distinct hues render distinctly — unlike
 * the old emoji legend (🟢🟢🟠🟠) which collapsed adjacent buckets into the
 * same glyph. Render it directly under <JobsMap />.
 */
export function JobsMapLegend({ className }: { className?: string }) {
  const t = useTranslations('candidateMatch');
  const buckets: Array<NonNullable<TravelBucket>> = ['lt15', 'lt30', 'lt45', 'lt60', 'gt60'];
  return (
    <div
      className={
        className ?? 'mt-2 flex flex-wrap items-center gap-3 text-[11px] text-[var(--ft-muted)]'
      }
    >
      {buckets.map((b) => (
        <LegendDot key={b} color={bucketColor(b)} label={t(bucketLabelKey(b)!)} />
      ))}
      <LegendDot color={bucketColor(null)} label={t('mapUnknownTravel')} />
    </div>
  );
}

/** Fit the view to all plotted points (origin + jobs) once they're known. */
function FitBounds({ points }: { points: Array<[number, number]> }) {
  const map = useMap();
  useMemo(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView(points[0], 11);
      return;
    }
    map.fitBounds(L.latLngBounds(points), { padding: [30, 30], maxZoom: 12 });
  }, [map, points]);
  return null;
}

export default function JobsMap({
  origin,
  jobs,
  radiusKm = 0,
  travelMode = null,
  originLabel,
}: JobsMapProps) {
  const t = useTranslations('candidateMatch');
  const points = useMemo<Array<[number, number]>>(() => {
    const p: Array<[number, number]> = jobs.map((j) => [j.lat, j.lng]);
    if (origin) p.push([origin.lat, origin.lng]);
    return p;
  }, [jobs, origin]);

  const center: [number, number] = origin
    ? [origin.lat, origin.lng]
    : points[0] ?? [52.13, 5.29];

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--ft-border)]">
      <MapContainer
        center={center}
        zoom={9}
        bounds={points.length === 0 ? NL_BOUNDS : undefined}
        scrollWheelZoom={false}
        style={{ height: 420, width: '100%' }}
      >
        <TileLayer
          attribution='&copy; OpenStreetMap'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds points={points} />

        {origin && radiusKm > 0 && (
          <Circle
            center={[origin.lat, origin.lng]}
            radius={radiusKm * 1000}
            pathOptions={{ color: '#1f6f5c', fillOpacity: 0.06, weight: 1 }}
          />
        )}

        {origin && (
          <Marker position={[origin.lat, origin.lng]} icon={ORIGIN_ICON}>
            <Popup>{originLabel}{origin.city ? ` — ${origin.city}` : ''}</Popup>
          </Marker>
        )}

        {jobs.map((j) => (
          <CircleMarker
            key={j.id}
            center={[j.lat, j.lng]}
            radius={7}
            pathOptions={{
              color: '#ffffff',
              weight: 1.5,
              fillColor: bucketColor(j.bucket),
              fillOpacity: 0.9,
            }}
          >
            <Tooltip direction="top" offset={[0, -6]}>
              {j.title}
            </Tooltip>
            <Popup>
              <div style={{ minWidth: 140 }}>
                <div style={{ fontWeight: 600 }}>{j.title}</div>
                {j.city ? <div style={{ color: '#6b7280' }}>{j.city}</div> : null}
                <div style={{ marginTop: 2 }}>{Math.round(j.score)} / 100</div>
                {/* Travel-time bucket for the selected mode (mode-specific). */}
                {travelMode && bucketLabelKey(j.bucket) ? (
                  <div style={{ marginTop: 2, color: bucketColor(j.bucket), fontWeight: 500 }}>
                    {t(bucketLabelKey(j.bucket)!)} · {t(modeLabelKey(travelMode))}
                  </div>
                ) : null}
              </div>
            </Popup>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  );
}
