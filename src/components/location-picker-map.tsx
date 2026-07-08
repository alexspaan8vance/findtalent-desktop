'use client';

/**
 * Editable city LOCATION PICKER map (mirrors 8vance's city+map+radius picker).
 *
 * Renders an OpenStreetMap (free, no API key) Leaflet map with a DRAGGABLE
 * marker + a visual radius circle. Dragging the marker reverse-geocodes the new
 * coordinates (via /api/refdata/location?lat=&lng=) and calls `onChange` with
 * the resolved {city, country, province, latitude, longitude} — the SAME shape
 * the forward-geocode autocomplete emits, so the wizard/edit-form location
 * setter can consume it unchanged.
 *
 * Leaflet touches `window`, so this component is dynamic-imported with
 * `{ ssr: false }` from the (client) wizard / edit forms — see those files. It
 * is itself a client component; the `onChange` callback is passed CLIENT→CLIENT
 * only (the server pages never render this directly), which is allowed.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Circle,
  MapContainer,
  Marker,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// ---------------------------------------------------------------------------
// Marker icon — Leaflet's default icon URLs break under bundlers (the images
// resolve relative to the CSS, which the bundler rewrites). Serve the marker
// assets from /public (copied from leaflet/dist/images) so the pin renders
// without a third-party CDN request.
// ---------------------------------------------------------------------------
const ICON = L.icon({
  iconUrl: '/leaflet/marker-icon.png',
  iconRetinaUrl: '/leaflet/marker-icon-2x.png',
  shadowUrl: '/leaflet/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

export interface PickedLocation {
  id?: number;
  city: string;
  country: string;
  province?: string;
  latitude?: string;
  longitude?: string;
}

interface LocationPickerMapProps {
  /** Current picked location (from the autocomplete / form state), or null. */
  value: { city?: string; latitude?: string; longitude?: string } | null;
  /** Visual radius of the circle, in km. Defaults to 30. */
  radiusKm?: number;
  /** Called after a marker drag resolves to a new place. CLIENT→CLIENT only. */
  onChange: (loc: PickedLocation) => void;
  /** Short instruction shown under the map (caller passes a translated string). */
  hint?: string;
  /**
   * Inline error shown under the map when a picked point cannot be
   * reverse-geocoded to a real place (caller passes a translated string).
   * In that case the previous location is KEPT — `onChange` is not called, so
   * an empty city can never render as ", " in the location input.
   */
  resolveErrorHint?: string;
}

// Netherlands bounding box, used as the default view when no point is picked.
const NL_BOUNDS: L.LatLngBoundsExpression = [
  [50.75, 3.36], // SW
  [53.55, 7.23], // NE
];

// 8vance rejects coords with >4 decimals; clamp like the geocode route does.
function clampCoord(n: number): string {
  return n.toFixed(4);
}

function parseLatLng(
  value: LocationPickerMapProps['value'],
): L.LatLngTuple | null {
  if (!value?.latitude || !value?.longitude) return null;
  const lat = Number.parseFloat(value.latitude);
  const lng = Number.parseFloat(value.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [lat, lng];
}

/**
 * Keeps the Leaflet view in sync with the picked point. When a point exists,
 * fly to it; otherwise frame the Netherlands. Lives inside <MapContainer> so it
 * can grab the map instance via `useMap()`.
 */
function ViewSync({ point }: { point: L.LatLngTuple | null }) {
  const map = useMap();

  // Leaflet measures its container ONCE at mount. When the map mounts inside a
  // not-yet-sized container (a wizard step that just became visible, an
  // animating panel), it renders only a thin strip ("mini randje") and the
  // marker/tiles don't lay out until something forces a redraw. Recalculate the
  // size after mount (and on a couple of rAF/timeout ticks to cover the reveal
  // animation) so the map fills its box and the picked marker shows immediately.
  useEffect(() => {
    const fix = () => map.invalidateSize();
    const raf = requestAnimationFrame(fix);
    const t1 = setTimeout(fix, 150);
    const t2 = setTimeout(fix, 600);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [map]);

  useEffect(() => {
    if (point) {
      map.invalidateSize();
      map.setView(point, Math.max(map.getZoom(), 11), { animate: true });
    } else {
      map.fitBounds(NL_BOUNDS as L.LatLngBoundsExpression);
    }
  }, [map, point]);
  return null;
}

/**
 * Click anywhere on the map to PLACE / MOVE the picked point (mirrors the
 * draggable marker). Lives inside <MapContainer> to access the map events.
 */
function ClickToPick({
  onPick,
}: {
  onPick: (lat: number, lng: number) => void;
}) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

export default function LocationPickerMap({
  value,
  radiusKm = 30,
  onChange,
  hint,
  resolveErrorHint,
}: LocationPickerMapProps): React.ReactElement {
  const point = useMemo(() => parseLatLng(value), [value]);
  const markerRef = useRef<L.Marker | null>(null);
  const [resolving, setResolving] = useState<boolean>(false);
  const [resolveFailed, setResolveFailed] = useState<boolean>(false);

  // Default map center when there's no picked point yet (NL centroid).
  const center: L.LatLngTuple = point ?? [52.1326, 5.2913];

  // Reverse-geocode a chosen point (drag or click) → emit the resolved place,
  // trusting the exact picked coords over the geocoder's snapped centre.
  // When the geocoder yields no usable place (or no city), the previous
  // location is KEPT (no onChange — the marker snaps back via `value`) and an
  // inline error shows, so an empty city never lands in the location input.
  async function resolvePoint(lat: number, lng: number) {
    const latStr = clampCoord(lat);
    const lngStr = clampCoord(lng);
    setResolving(true);
    setResolveFailed(false);
    try {
      const res = await fetch(
        `/api/refdata/location?lat=${encodeURIComponent(latStr)}&lng=${encodeURIComponent(lngStr)}`,
        { headers: { Accept: 'application/json' } },
      );
      if (res.ok) {
        const data = (await res.json()) as { results?: PickedLocation[] };
        const hit = data.results?.[0];
        if (hit && hit.city && hit.city.trim()) {
          onChange({ ...hit, latitude: latStr, longitude: lngStr });
          return;
        }
      }
      setResolveFailed(true);
    } catch {
      setResolveFailed(true);
    } finally {
      setResolving(false);
    }
  }

  function handleDragEnd() {
    const marker = markerRef.current;
    if (!marker) return;
    const { lat, lng } = marker.getLatLng();
    void resolvePoint(lat, lng);
  }

  return (
    <div className="mt-2">
      {/* `isolation: isolate` + z-0 confine Leaflet's internal high z-indexes
          (panes ~400, controls ~1000) to THIS stacking context, so the map can
          never paint over a location autocomplete dropdown rendered above it. */}
      <div
        className="overflow-hidden rounded-lg border border-zinc-300"
        style={{ height: 240, position: 'relative', zIndex: 0, isolation: 'isolate' }}
      >
        <MapContainer
          center={center}
          zoom={point ? 11 : 7}
          scrollWheelZoom
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <ViewSync point={point} />
          <ClickToPick onPick={(lat, lng) => void resolvePoint(lat, lng)} />
          {point ? (
            <>
              <Marker
                position={point}
                draggable
                icon={ICON}
                eventHandlers={{ dragend: handleDragEnd }}
                ref={(m) => {
                  markerRef.current = m;
                }}
              />
              <Circle
                center={point}
                radius={Math.max(0, radiusKm) * 1000}
                pathOptions={{
                  color: '#0f172a',
                  weight: 1,
                  fillColor: '#0f172a',
                  fillOpacity: 0.08,
                }}
              />
            </>
          ) : null}
        </MapContainer>
      </div>
      {resolveFailed && resolveErrorHint ? (
        <p role="alert" className="mt-1 text-xs font-medium text-red-600">
          {resolveErrorHint}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-zinc-500">
          {resolving ? '…' : hint}
        </p>
      ) : null}
    </div>
  );
}
