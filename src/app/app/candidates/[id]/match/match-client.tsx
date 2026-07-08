'use client';

/**
 * Candidate → jobs match client view.
 *
 * Responsibilities:
 *  - Progressive loader while the latest run is MATCHING (polls match-status,
 *    refreshes the route as jobs land — mirrors the shortlist MatchPoller).
 *  - Headline "Verberg uitzendbureaus" toggle (ON by default): hides rows whose
 *    isStaffingAgency is true. When OFF, agency rows show with an "Uitzendbureau"
 *    badge + a popover listing the reasons it was classified as an agency.
 *  - A client-side filters panel (sources, contract types, text search, min
 *    score) + sort (best match / newest) over the already-loaded rows.
 *  - Job cards reusing the .ft-card / score-ring visual language.
 *  - A "rematch" button calling the rematchAction server action.
 */

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';

import { ScoreRing } from '@/components/score-ring';
import type { AgencyReason } from '@/lib/match/staffing';
import dynamic from 'next/dynamic';
import { bucketRank } from '@/lib/travel/bucketize';
import { haversineKm } from '@/lib/travel/haversine';
import type { TravelMode } from '@/lib/travel/haversine';
import { smoothScoreFromRaw } from '@/lib/candidate/score-smoothing';

// Leaflet touches `window` → client-only, dynamic-imported with SSR disabled
// (this file is already a Client Component).
const JobsMap = dynamic(() => import('./jobs-map'), { ssr: false });
import type { TravelBucket, TravelBuckets } from '@/lib/anonymize/types';

import {
  getJobGapAction,
  rematchAction,
  type JobGapResult,
  type RematchResult,
} from './actions';
import { DetailLine, GapRow, GapSkills } from './job-gap';

/** Selectable max-time buckets for the travel-time facet, ascending. */
const TRAVEL_MAX_BUCKETS: readonly NonNullable<TravelBucket>[] = [
  'lt15',
  'lt30',
  'lt45',
  'lt60',
];

/** Pick the i18n key for a travel-time bucket label; null for the unknown bucket. */
function travelBucketKey(b: TravelBucket): string | null {
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

/** Emoji glyph per travel mode for the compact per-card travel badge. */
const TRAVEL_MODE_EMOJI: Record<TravelMode, string> = {
  car: '🚗',
  bike: '🚲',
  ov: '🚆',
};

export interface JobRow {
  id: string;
  eightvanceJobId: number;
  score: number;
  /**
   * Whether `score` is trustworthy to show as a %. False for cross-company jobs
   * whose `/match/job/` score is a degenerate 1 (fake 100%) — the UI hides the %
   * and the real score appears on detail-open via `/match/specific/`.
   */
  scoreReliable: boolean;
  title: string;
  employerName: string | null;
  source: string | null;
  contractType: string | null;
  locationCity: string | null;
  locationLabel: string | null;
  remote: boolean | null;
  publishedAt: string | null;
  /** Coarse travel-time buckets (labels only) from the candidate's origin. */
  travel?: TravelBuckets;
  /** Job coordinates for the map (enriched top-N only; null otherwise). */
  lat?: number | null;
  lng?: number | null;
  /** Salary + working-hours range from /extended/ (salary often null on feeds). */
  salaryLow?: number | null;
  salaryHigh?: number | null;
  hoursMin?: number | null;
  hoursMax?: number | null;
  isStaffingAgency: boolean;
  agencyScore: number;
  isOwnPool: boolean;
  agencyReasons: AgencyReason[];
}

type OriginKey = 'all' | 'ownpool' | 'open';

// Mirrors the ProjectStatus enum (CandidateMatchRun.status reuses it). CLOSED
// only ever applies to employer Projects, never a candidate match run, but the
// union must stay assignable from the full enum.
type RunStatus = 'DRAFT' | 'MATCHING' | 'READY' | 'FAILED' | 'ARCHIVED' | 'CLOSED' | null;

interface Props {
  candidateId: string;
  runStatus: RunStatus;
  rows: JobRow[];
  /** Whether the candidate has a linked 8vance talent (drives "Sync & match" wording). */
  synced: boolean;
  /** Server-rendered "now" (ISO) — used for recency filtering without hydration drift. */
  nowIso: string;
  /** How many sources couldn't be fully searched (feed too large / timeout / cap)
   * — drives an actionable "narrow your sources" notice. */
  skippedCount?: number;
  /** Distinct skip reasons this run, e.g. ['filter_required','feed_too_large'] —
   * rendered as specific, actionable messages (add a location, etc.). */
  skippedReasons?: string[];
  /** Candidate's home location (from the CV) — seeds the city filter + the map
   * origin marker so the view centres on where the candidate lives. */
  originCity?: string | null;
  originLat?: number | null;
  originLng?: number | null;
  /** Education-derived travel defaults ("won't drive an hour"): the travel
   * facet starts here (e.g. HBO+/car ≤60m, lower/bike ≤15m) until overridden. */
  defaultTravelMode?: TravelMode | null;
  defaultTravelMax?: TravelBucket;
  /** The centre this run actually matched around (relocation city / work region
   * / home). Drives the map origin, radius ring, distance base + the banner. */
  matchCentre?: {
    lat: number;
    lng: number;
    label: string | null;
    kind: 'relocation' | 'region' | 'home';
  } | null;
  /** Per-source result counts for the honest "open market: 0 · own pool: 6" line. */
  sourceCounts?: Array<{ slug: string; n: number; isOwnPool: boolean; bounded: boolean }>;
  /** The candidate's home city label, for the "reset to home" affordance. */
  homeCity?: string | null;
  /** Captured work-preferences — seed the contract + remote filters so the
   * recruiter's tacit input isn't re-entered by hand. */
  preferences?: {
    contractTypes?: string[];
    workMode?: 'office' | 'hybrid' | 'remote';
    hoursPerWeek?: number;
    salary?: { min?: number; max?: number; period?: 'hour' | 'month' | 'year' };
  } | null;
}

type SortKey = 'score' | 'newest';

type PublishedKey = 'all' | '7d' | '30d';

/**
 * Prettify a raw feed city string for display. Job-feed locations arrive in
 * inconsistent casing (e.g. "FARMSUM", "USQUERT", "'S-HERTOGENBOSCH"); title-case
 * each word so the filter chips + cards read like real place names. Filtering
 * still uses the raw value, so this only affects what the user sees.
 */
/**
 * Does the job's working-hours range fit the candidate's desired hours/week?
 * Null when either side has no data. ±2h tolerance so "40h" fits a "36–40" job.
 */
function hoursFit(
  row: { hoursMin?: number | null; hoursMax?: number | null },
  wish: number | undefined,
): boolean | null {
  if (wish == null) return null;
  const lo = row.hoursMin ?? row.hoursMax;
  const hi = row.hoursMax ?? row.hoursMin;
  if (lo == null || hi == null) return null;
  return wish >= lo - 2 && wish <= hi + 2;
}

/**
 * Do the job's + candidate's salary RANGES overlap? Null when either has no data
 * (JobDigger feeds carry no salary). Raw-number compare — a period mismatch is a
 * known caveat, so this is a soft signal.
 */
function salaryFit(
  row: { salaryLow?: number | null; salaryHigh?: number | null },
  wish: { min?: number; max?: number } | undefined,
): boolean | null {
  if (!wish || (wish.min == null && wish.max == null)) return null;
  const jl = row.salaryLow ?? row.salaryHigh;
  const jh = row.salaryHigh ?? row.salaryLow;
  if (jl == null || jh == null) return null;
  const cmin = wish.min ?? 0;
  const cmax = wish.max ?? Number.POSITIVE_INFINITY;
  return jh >= cmin && jl <= cmax;
}

function titleCaseCity(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/(^|[\s'\-/])([a-zà-ÿ])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/**
 * Seed the contract-type filter from the candidate's captured preference,
 * keeping ONLY values that actually occur on the loaded rows (case-insensitive,
 * mapped to the row's exact casing so `Set.has(row.contractType)` matches and
 * the facet chip renders as selected).
 *
 * WHY: preferences store wizard vocabulary SLUGS ('permanent', 'temporary',
 * 'uitzend', 'interim') while rows carry raw feed strings ('Vast', …) — and the
 * contract facet only renders row-derived values. Seeding the raw slugs used to
 * create an INVISIBLE, un-clearable active filter that zeroed the entire list:
 * every row fails a contract filter it can never match (including rows with no
 * contract data at all, which any non-empty contract selection drops).
 */
export function seedContractSelection(
  prefContracts: readonly string[] | null | undefined,
  rows: ReadonlyArray<Pick<JobRow, 'contractType'>>,
): Set<string> {
  const out = new Set<string>();
  if (!prefContracts || prefContracts.length === 0) return out;
  const byLower = new Map<string, string>();
  for (const r of rows) {
    if (r.contractType) byLower.set(r.contractType.toLowerCase(), r.contractType);
  }
  for (const p of prefContracts) {
    const hit = byLower.get(p.toLowerCase());
    if (hit !== undefined) out.add(hit);
  }
  return out;
}

/**
 * Seed the remote-only toggle from the captured work-mode preference — but only
 * when at least one loaded row is actually remote. The checkbox itself only
 * renders when a remote row exists (`hasRemote`), so seeding true without one
 * used to activate a HIDDEN filter that dropped every row (`remote !== true`)
 * with no way to see or clear it.
 */
export function seedRemoteOnly(
  workMode: string | null | undefined,
  rows: ReadonlyArray<Pick<JobRow, 'remote'>>,
): boolean {
  return workMode === 'remote' && rows.some((r) => r.remote === true);
}

/**
 * Normalize a raw 0..1 or 0..100 score to the SMOOTHED display percent the
 * 8vance platform shows — so a findtalent score reads the same as what the
 * recruiter sees in the 8vance UI for that match (raw 0.66 → 83, not 66). Used
 * everywhere the score surfaces (ring, min-match filter, sort, map) so all stay
 * on one consistent scale. See lib/candidate/score-smoothing.
 */
function toPercent(score: number): number {
  return smoothScoreFromRaw(score);
}

/**
 * A job's feed provenance, beyond the coarse own-pool/open-market split. Each
 * 8vance source slug maps to a readable label + a category that drives the chip
 * colour, so a recruiter sees AT A GLANCE whether a hit came from their own
 * pool, an external job feed, a demo source, or an ecosystem partner.
 *  - own       : the tenant's own company pool (detected by company, not source)
 *  - demo      : seeded demo data (Job Explore, demo_source)
 *  - ecosystem : partner/framework feeds within a customer's ecosystem
 *  - external  : open-market job aggregators (OnlineVacatures.nl, public feeds)
 */
type SourceCategory = 'own' | 'demo' | 'ecosystem' | 'external';

/** Known 8vance source slugs/names (lowercased) → friendly label + category. */
const KNOWN_SOURCES: Record<string, { label: string; cat: SourceCategory }> = {
  'job explore': { label: 'Job Explore', cat: 'demo' },
  job_explore: { label: 'Job Explore', cat: 'demo' },
  demo_source: { label: 'Demo data', cat: 'demo' },
  onlinevacaturesnl: { label: 'OnlineVacatures.nl', cat: 'external' },
  public_vacancies_de: { label: 'Publieke vacatures (DE)', cat: 'external' },
  public_vacancies_nl: { label: 'Publieke vacatures (NL)', cat: 'external' },
  the_talent_matching_platform: { label: 'Talent Matching Platform', cat: 'ecosystem' },
  bcc_function_framework: { label: 'Function Framework', cat: 'ecosystem' },
};

/** Slug → Title Case fallback when a source isn't in the known map. */
function prettifySource(s: string): string {
  return s.replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Resolve a non-own-pool source string to a label + category. */
function sourceMeta(source: string): { label: string; cat: SourceCategory } {
  return (
    KNOWN_SOURCES[source.toLowerCase()] ?? {
      label: prettifySource(source),
      cat: 'external',
    }
  );
}

/** Tailwind classes per source category, applied to the card's source chip. */
const SOURCE_CAT_CLASS: Record<SourceCategory, string> = {
  own: 'border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]',
  demo: 'border-violet-300 bg-violet-50 text-violet-700',
  ecosystem: 'border-sky-300 bg-sky-50 text-sky-700',
  external: 'border-amber-300 bg-amber-50 text-amber-700',
};

/**
 * The employer label for a row, respecting the JobDigger/own-pool/agency rules.
 * Open-market (JobDigger) vacancies come back from the PUBLIC 8vance API with an
 * anonymised placeholder employer like "Company-566364" (the real name is only
 * in 8vance's internal API). That code is meaningless to the user, so for a
 * non-own-pool job whose employer is such a placeholder, show "JobDigger".
 * Shared by the compact card and the detail panel so both label identically.
 */
function employerLabel(row: JobRow, t: ReturnType<typeof useTranslations>): string {
  const isPlaceholderEmployer = /^company[-_ ]?\d+$/i.test(
    (row.employerName ?? '').trim(),
  );
  if (row.isStaffingAgency) return t('employerViaAgency');
  if (!row.isOwnPool && (isPlaceholderEmployer || !row.employerName)) {
    return t('jobOpenMarket');
  }
  return row.employerName ?? t('employerUnknown');
}

/**
 * Feed-provenance chip showing WHERE a hit came from: own pool (accent), demo
 * data (violet), ecosystem partner (sky) or an external open-market feed
 * (amber). The named source is tagged server-side from the per-feed match slug,
 * so even un-enriched rows carry it; only the rare untagged row falls back to
 * "open market". Shared by the compact card and the detail panel.
 */
function SourceChip({ row }: { row: JobRow }): React.ReactElement {
  const t = useTranslations('candidateMatch');
  if (row.isOwnPool) {
    return (
      <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${SOURCE_CAT_CLASS.own}`}>
        {t('jobOwnPool')}
      </span>
    );
  }
  if (row.source) {
    const meta = sourceMeta(row.source);
    return (
      <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${SOURCE_CAT_CLASS[meta.cat]}`}>
        {meta.label}
      </span>
    );
  }
  return (
    <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${SOURCE_CAT_CLASS.external}`}>
      {t('jobOpenMarket')}
    </span>
  );
}

export function MatchClient({
  candidateId,
  runStatus,
  rows,
  synced,
  nowIso,
  skippedCount = 0,
  skippedReasons = [],
  originCity = null,
  originLat = null,
  originLng = null,
  defaultTravelMode = null,
  defaultTravelMax,
  matchCentre = null,
  sourceCounts = [],
  homeCity = null,
  preferences = null,
}: Props): React.ReactElement {
  const t = useTranslations('candidateMatch');
  const router = useRouter();
  const [rematchPending, startRematch] = useTransition();

  // Free city search → geocoded candidates (any city, not just result cities),
  // used to RE-MATCH around a chosen city (relocation). Separate from the
  // client-side result-city narrow below.
  const [cityGeo, setCityGeo] = useState<
    Array<{ label: string; lat: number; lng: number }>
  >([]);
  const [cityGeoOpen, setCityGeoOpen] = useState(false);

  // Headline toggle: hide staffing agencies (ON by default).
  const [hideAgencies, setHideAgencies] = useState(true);

  // Filters.
  const [query, setQuery] = useState('');
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  // Seed the contract filter from the candidate's captured preference so the
  // recruiter's tacit input drives the view instead of being re-entered.
  // INTERSECTED with the loaded rows' values (seedContractSelection) so the
  // seed can never become an invisible, un-clearable filter that zeroes the
  // list — the facet only renders row-derived chips.
  const [selectedContracts, setSelectedContracts] = useState<Set<string>>(
    () => seedContractSelection(preferences?.contractTypes, rows),
  );
  const [minScore, setMinScore] = useState(0);
  const [sort, setSort] = useState<SortKey>('score');
  const [origin, setOrigin] = useState<OriginKey>('all');
  // Remote preset only engages when a remote row exists — otherwise the
  // checkbox that clears it never renders (seedRemoteOnly).
  const [remoteOnly, setRemoteOnly] = useState(() =>
    seedRemoteOnly(preferences?.workMode, rows),
  );
  const [published, setPublished] = useState<PublishedKey>('all');
  // The city filter starts EMPTY. Auto-seeding it to the candidate's home city
  // silently hid every job in another city ("42 found, 0 shown") — the home city
  // is one quick-suggestion chip the recruiter can click, not a default filter.
  const [selectedCities, setSelectedCities] = useState<Set<string>>(new Set());
  // Type-to-filter the (long) city list instead of scanning checkboxes.
  const [cityQuery, setCityQuery] = useState('');
  // Travel-time filter starts OFF. The education default (car ≤60 / bike ≤15) is
  // offered as a one-click SUGGESTION (see the preset control) rather than an
  // active filter on first paint — a silent "Bike ≤15 min" default hid the whole
  // list. `travelMax` still seeds from education so applying the preset is right.
  const [travelMode, setTravelMode] = useState<TravelMode | null>(null);
  const [travelMax, setTravelMax] = useState<NonNullable<TravelBucket>>(
    (defaultTravelMax ?? 'lt30') as NonNullable<TravelBucket>,
  );
  const [travelIncludeUnknown, setTravelIncludeUnknown] = useState(true);
  // Toggle the map view (job markers + origin + travel-radius ring).
  const [showMap, setShowMap] = useState(false);
  // Fit-to-preference filters: only jobs that fit the candidate's captured hours
  // / salary ask (jobs without the data are kept — can't judge them).
  const [fitHoursOnly, setFitHoursOnly] = useState(false);
  const [fitSalaryOnly, setFitSalaryOnly] = useState(false);
  const prefHours = preferences?.hoursPerWeek;
  const prefSalary = preferences?.salary;
  const canFitHours =
    prefHours != null && rows.some((r) => r.hoursMin != null || r.hoursMax != null);
  const canFitSalary =
    !!prefSalary &&
    (prefSalary.min != null || prefSalary.max != null) &&
    rows.some((r) => r.salaryLow != null || r.salaryHigh != null);
  // Whether any own-pool / open-market jobs exist (to show the origin toggle).
  const hasOwnPool = useMemo(() => rows.some((r) => r.isOwnPool), [rows]);
  const hasOpenMarket = useMemo(() => rows.some((r) => !r.isOwnPool), [rows]);

  // Distinct facets derived from the loaded rows.
  const sources = useMemo(
    () =>
      Array.from(
        new Set(rows.map((r) => r.source).filter((s): s is string => !!s)),
      ).sort(),
    [rows],
  );
  const contractTypes = useMemo(
    () =>
      Array.from(
        new Set(
          rows.map((r) => r.contractType).filter((c): c is string => !!c),
        ),
      ).sort(),
    [rows],
  );

  const cities = useMemo(
    () =>
      Array.from(
        new Set(
          rows.map((r) => r.locationCity).filter((c): c is string => !!c),
        ),
      ).sort(),
    [rows],
  );
  // Free geocode of whatever the recruiter types — so ANY city is searchable
  // (e.g. a relocation target), not just the cities already in the results.
  // Debounced; hits the shared /api/refdata/location geocoder. A too-short
  // query is cleared in the input's onChange (and in rematchNearCity), not
  // here, so this effect never sets state synchronously.
  useEffect(() => {
    const q = cityQuery.trim();
    if (q.length < 2) return;
    const ctrl = new AbortController();
    const handle = setTimeout(async () => {
      try {
        const r = await fetch(`/api/refdata/location?q=${encodeURIComponent(q)}`, {
          signal: ctrl.signal,
          headers: { Accept: 'application/json' },
        });
        const data = (await r.json()) as {
          results?: Array<{ city: string; province?: string; latitude?: string; longitude?: string }>;
        };
        const geo = (data.results ?? [])
          .filter((x) => x.latitude && x.longitude)
          .slice(0, 5)
          .map((x) => ({
            label: x.province ? `${x.city}, ${x.province}` : x.city,
            lat: Number(x.latitude),
            lng: Number(x.longitude),
          }))
          .filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng));
        setCityGeo(geo);
        setCityGeoOpen(true);
      } catch {
        /* aborted / offline — ignore */
      }
    }, 300);
    return () => {
      clearTimeout(handle);
      ctrl.abort();
    };
  }, [cityQuery]);

  // Re-match the candidate centring the open-market feeds on a chosen city — the
  // relocation flow ("this candidate would move to Eindhoven"). Reloads to the
  // fresh run.
  function rematchNearCity(city: { label: string; lat: number; lng: number }) {
    setCityGeoOpen(false);
    setCityQuery('');
    setCityGeo([]); // the query is now empty — drop the stale suggestions too
    startRematch(async () => {
      const res = await rematchAction(candidateId, undefined, {
        lat: city.lat,
        lng: city.lng,
        label: city.label,
      });
      if (res.ok) router.refresh();
    });
  }

  // Straight-line distance (km) filter from the candidate's home — only usable
  // when we have an origin + jobs with coords. 0 = off.
  const [maxDistanceKm, setMaxDistanceKm] = useState(0);
  // Distance + map are anchored to the centre the match RAN around (relocation
  // city / region / home) — not the candidate's home — so a relocation view is
  // self-consistent. Falls back to the home coords the page passes.
  const centreLat = matchCentre?.lat ?? originLat;
  const centreLng = matchCentre?.lng ?? originLng;
  const hasOrigin = centreLat != null && centreLng != null;
  const isRelocated = matchCentre != null && matchCentre.kind !== 'home';
  const coordCount = useMemo(
    () => rows.filter((r) => r.lat != null && r.lng != null).length,
    [rows],
  );
  const hasJobCoords = coordCount > 0;

  const hasRemote = useMemo(() => rows.some((r) => r.remote === true), [rows]);
  const hasPublishedAt = useMemo(
    () => rows.some((r) => r.publishedAt != null),
    [rows],
  );

  // Only show the travel control when at least one row carries a non-null
  // bucket; the OV chip only when some row actually has an OV bucket.
  const hasTravel = useMemo(
    () =>
      rows.some(
        (r) =>
          r.travel &&
          (r.travel.car != null || r.travel.bike != null || r.travel.ov != null),
      ),
    [rows],
  );
  const travelOvAvailable = useMemo(
    () => rows.some((r) => r.travel?.ov != null),
    [rows],
  );

  const agencyCount = useMemo(
    () => rows.filter((r) => r.isStaffingAgency).length,
    [rows],
  );

  // Recency cutoff (ms) for the publication-date select, anchored to the
  // server-provided "now" so client/server render the same result.
  const publishedCutoffMs = useMemo(() => {
    if (published === 'all') return null;
    const now = Date.parse(nowIso);
    if (!Number.isFinite(now)) return null;
    const days = published === '7d' ? 7 : 30;
    return now - days * 24 * 60 * 60 * 1000;
  }, [published, nowIso]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (hideAgencies && r.isStaffingAgency) return false;
      if (origin === 'ownpool' && !r.isOwnPool) return false;
      if (origin === 'open' && r.isOwnPool) return false;
      if (remoteOnly && r.remote !== true) return false;
      if (publishedCutoffMs !== null) {
        const ts = r.publishedAt ? Date.parse(r.publishedAt) : NaN;
        if (!Number.isFinite(ts) || ts < publishedCutoffMs) return false;
      }
      if (
        selectedCities.size > 0 &&
        !(r.locationCity && selectedCities.has(r.locationCity))
      )
        return false;
      if (selectedSources.size > 0 && !(r.source && selectedSources.has(r.source)))
        return false;
      if (
        selectedContracts.size > 0 &&
        !(r.contractType && selectedContracts.has(r.contractType))
      )
        return false;
      if (toPercent(r.score) < minScore) return false;
      // Fit-to-preference: drop only rows we can JUDGE and that DON'T fit; rows
      // without the data are kept (unknown, not a mismatch).
      if (fitHoursOnly && hoursFit(r, prefHours) === false) return false;
      if (fitSalaryOnly && salaryFit(r, prefSalary) === false) return false;
      // Straight-line distance from the candidate's home (when both origin and
      // this job have coords). Jobs without coords are kept (unknown distance).
      if (maxDistanceKm > 0 && hasOrigin && r.lat != null && r.lng != null) {
        const km = haversineKm(
          { lat: centreLat as number, lng: centreLng as number },
          { lat: r.lat, lng: r.lng },
        );
        if (km > maxDistanceKm) return false;
      }
      // Travel time (+ include-unknown). Keep a row iff its bucket for the
      // selected mode is at or below the max; null/undefined buckets are kept
      // only when include-unknown is on (mirrors the shortlist filter).
      if (travelMode !== null) {
        const bucket = r.travel?.[travelMode] ?? null;
        if (bucket == null) {
          if (!travelIncludeUnknown) return false;
        } else if (bucketRank(bucket) > bucketRank(travelMax)) {
          return false;
        }
      }
      if (q) {
        const hay = `${r.title} ${r.employerName ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    // Rows already arrive reliable-first then score-desc. For "newest" we keep
    // the natural row order; for "score" we sort defensively — reliable (real)
    // scores first so cross-company rows with a hidden % never float to the top.
    if (sort === 'score') {
      out.sort((a, b) => {
        if (a.scoreReliable !== b.scoreReliable) return a.scoreReliable ? -1 : 1;
        return b.score - a.score;
      });
    }
    return out;
  }, [
    rows,
    hideAgencies,
    origin,
    remoteOnly,
    publishedCutoffMs,
    selectedCities,
    selectedSources,
    selectedContracts,
    minScore,
    travelMode,
    travelMax,
    travelIncludeUnknown,
    maxDistanceKm,
    hasOrigin,
    centreLat,
    centreLng,
    fitHoursOnly,
    fitSalaryOnly,
    prefHours,
    prefSalary,
    query,
    sort,
  ]);

  const isMatching = runStatus === 'MATCHING';

  // Jobs plottable on the map: the currently-visible rows that carry coords,
  // coloured by their travel bucket for the selected mode (car when none picked).
  const mapJobs = useMemo(
    () =>
      visible
        .filter((r) => r.lat != null && r.lng != null)
        .map((r) => ({
          id: r.id,
          title: r.title,
          city: r.locationCity ? titleCaseCity(r.locationCity) : null,
          score: toPercent(r.score),
          lat: r.lat as number,
          lng: r.lng as number,
          bucket: r.travel?.[travelMode ?? 'car'] ?? null,
        })),
    [visible, travelMode],
  );
  const canShowMap = hasOrigin || mapJobs.length > 0;

  // Human-readable names of every filter currently narrowing the list — the
  // filtered-to-zero empty state shows exactly WHICH filters hid the rows (an
  // on-load preset must never zero the list silently), never a hardcoded guess.
  // The travel facet is named only when it can actually drop rows: some row
  // carries a bucket, or unknown-travel rows are being excluded.
  const activeFilterLabels: string[] = [];
  if (hideAgencies && agencyCount > 0) {
    activeFilterLabels.push(`${t('hideAgencies')} (${agencyCount})`);
  }
  if (query.trim() !== '') {
    activeFilterLabels.push(`${t('search')}: “${query.trim()}”`);
  }
  if (origin !== 'all') {
    activeFilterLabels.push(`${t('origin')}: ${t(`origin_${origin}`)}`);
  }
  if (remoteOnly) activeFilterLabels.push(t('remoteOnly'));
  if (published !== 'all') {
    activeFilterLabels.push(`${t('publishedLabel')}: ${t(`published_${published}`)}`);
  }
  if (selectedCities.size > 0) {
    activeFilterLabels.push(
      `${t('cityLabel')}: ${Array.from(selectedCities).map(titleCaseCity).join(', ')}`,
    );
  }
  if (selectedSources.size > 0) {
    activeFilterLabels.push(`${t('sources')}: ${Array.from(selectedSources).join(', ')}`);
  }
  if (selectedContracts.size > 0) {
    activeFilterLabels.push(
      `${t('contractTypes')}: ${Array.from(selectedContracts).join(', ')}`,
    );
  }
  if (minScore > 0) activeFilterLabels.push(t('minScore', { value: minScore }));
  if (maxDistanceKm > 0) activeFilterLabels.push(t('distanceLabel', { km: maxDistanceKm }));
  if (fitHoursOnly) activeFilterLabels.push(t('fitHours', { h: prefHours ?? 0 }));
  if (fitSalaryOnly) activeFilterLabels.push(t('fitSalary'));
  if (travelMode !== null && (hasTravel || !travelIncludeUnknown)) {
    const modeLabel =
      travelMode === 'car' ? t('travelCar') : travelMode === 'bike' ? t('travelBike') : t('travelOv');
    activeFilterLabels.push(
      `${t('travelLabel')}: ${modeLabel} ${t(travelBucketKey(travelMax)!)}`,
    );
  }

  /**
   * One-click "toon alles": clear EVERY client-side narrowing, including the
   * default agency-hide and the education travel preset — the escape hatch the
   * filtered-to-zero empty state offers so the loaded rows are always reachable.
   */
  function showAllFilters(): void {
    setHideAgencies(false);
    setQuery('');
    setSelectedSources(new Set());
    setSelectedContracts(new Set());
    setSelectedCities(new Set());
    setMinScore(0);
    setOrigin('all');
    setRemoteOnly(false);
    setPublished('all');
    setTravelMode(null);
    setTravelIncludeUnknown(true);
    setMaxDistanceKm(0);
    setFitHoursOnly(false);
    setFitSalaryOnly(false);
  }

  // Honest per-source split: own-pool/ecosystem sources are never
  // location-bounded, so on a relocation run their jobs are NOT near the searched
  // city — call that out instead of presenting them as relocation hits.
  const ownPoolCount = sourceCounts.filter((c) => c.isOwnPool).reduce((a, c) => a + c.n, 0);
  const marketCount = sourceCounts.filter((c) => !c.isOwnPool).reduce((a, c) => a + c.n, 0);
  const hasMarketSources = sourceCounts.some((c) => !c.isOwnPool);
  const centreLabel = matchCentre?.label ?? homeCity ?? null;

  function resetToHome() {
    startRematch(async () => {
      const res = await rematchAction(candidateId);
      if (res.ok) router.refresh();
    });
  }

  // service.ts caps the matched set (MAX_SOURCES=8, enrichLimit=25) and silently
  // drops per-source 413s. When the persisted row count lands at/over a known
  // ceiling, surface an honest "results may be truncated" footer note.
  const TRUNCATION_HINT_THRESHOLD = 200;
  const maybeTruncated = rows.length >= TRUNCATION_HINT_THRESHOLD;

  function toggleIn(set: Set<string>, value: string): Set<string> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  return (
    <div className="mt-6">
      {isMatching && (
        <MatchPoller candidateId={candidateId} hasRows={rows.length > 0} />
      )}

      {runStatus === 'FAILED' && rows.length === 0 && (
        <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-8 text-center">
          <div className="text-sm font-medium text-red-700">
            {t('failedTitle')}
          </div>
          <p className="mt-1 text-xs text-red-600">
            {synced ? t('failedBody') : t('failedNotSyncedBody')}
          </p>
          <div className="mt-4 flex justify-center">
            <RematchButton candidateId={candidateId} synced={synced} />
          </div>
        </div>
      )}

      {runStatus === null && !isMatching && (
        <div className="mt-4 rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface-2)] p-8 text-center">
          <div className="text-sm font-medium text-[var(--ft-ink)]">
            {synced ? t('noRunTitle') : t('notSyncedTitle')}
          </div>
          <p className="mt-1 text-xs text-[var(--ft-muted)]">
            {synced ? t('noRunBody') : t('notSyncedBody')}
          </p>
          <div className="mt-4 flex justify-center">
            <RematchButton candidateId={candidateId} synced={synced} />
          </div>
        </div>
      )}

      {(rows.length > 0 || runStatus === 'READY') && (
        <>
          {/* Results header */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-[var(--ft-muted)]">
              <span className="font-semibold text-[var(--ft-ink)]">
                {t('totalJobs', { count: rows.length })}
              </span>
              {agencyCount > 0 && (
                <span className="ml-2">
                  · {t('agencyHidden', { count: agencyCount })}
                </span>
              )}
            </div>
            <RematchButton candidateId={candidateId} synced={synced} />
          </div>

          {/* Relocation banner — the run matched around a searched city / work
              region, not home. Make it explicit + offer a reset. */}
          {isRelocated && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-3 py-2 text-xs text-[var(--ft-accent-strong)]">
              <span>
                📍 {t('matchedAround', { city: centreLabel ?? t('mapUnknownTravel') })}
              </span>
              <button
                type="button"
                onClick={resetToHome}
                disabled={rematchPending}
                className="rounded-full border border-[var(--ft-accent-line)] px-2.5 py-1 font-medium hover:bg-[var(--ft-surface)] disabled:opacity-50"
              >
                {t('resetToHome')}
              </button>
            </div>
          )}

          {/* Honest per-source split (own-pool is location-agnostic). */}
          {sourceCounts.length > 0 && (
            <div className="mt-2 text-xs text-[var(--ft-muted)]">
              {hasMarketSources && (
                <span>
                  {isRelocated && centreLabel
                    ? t('openMarketNear', { count: marketCount, city: centreLabel })
                    : t('openMarketCount', { count: marketCount })}
                </span>
              )}
              {ownPoolCount > 0 && (
                <span className={hasMarketSources ? 'ml-2' : ''}>
                  · {t('ownPoolCount', { count: ownPoolCount })}
                </span>
              )}
            </div>
          )}

          {skippedCount > 0 && (
            <div
              role="status"
              className="mt-3 flex flex-col gap-1 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
            >
              <div className="flex items-start gap-2">
                <span aria-hidden="true">⚠</span>
                <span>{t('sourcesTruncated', { count: skippedCount })}</span>
              </div>
              {/* Specific, actionable reasons — most importantly filter_required,
                  which means a large open-market feed (JobDigger) was skipped
                  because the candidate has no location to bound the search. */}
              {skippedReasons.map((reason) => (
                <div key={reason} className="flex items-start gap-2 pl-6">
                  <span aria-hidden="true">·</span>
                  <span>{t(`skippedReasonHint_${reason}` as never)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Headline toggle */}
          <label className="mt-4 flex w-fit cursor-pointer items-center gap-3 rounded-xl border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-4 py-2.5">
            <input
              type="checkbox"
              checked={hideAgencies}
              onChange={(e) => setHideAgencies(e.target.checked)}
              className="h-4 w-4 accent-[var(--ft-accent)]"
            />
            <span className="text-sm font-semibold text-[var(--ft-accent-strong)]">
              {t('hideAgencies')}
            </span>
            <span
              className="text-[var(--ft-muted)]"
              title={t('hideAgenciesHelp')}
              aria-label={t('hideAgenciesHelp')}
            >
              <span aria-hidden="true" className="text-xs">
                ⓘ
              </span>
            </span>
          </label>

          {/* Filters panel */}
          <section className="mt-4 rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface-2)] p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-semibold text-[var(--ft-muted)]">
                  {t('search')}
                </label>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('searchPlaceholder')}
                  className="w-full rounded-lg border border-[var(--ft-border)] bg-[var(--ft-surface)] px-3 py-1.5 text-sm text-[var(--ft-ink)] outline-none focus:border-[var(--ft-accent)]"
                />
              </div>

              {hasOwnPool && hasOpenMarket && (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-[var(--ft-muted)]">
                    {t('origin')}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {(['all', 'ownpool', 'open'] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setOrigin(k)}
                        className={`rounded-full border px-2.5 py-1 text-xs transition ${
                          origin === k
                            ? 'border-[var(--ft-accent)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]'
                            : 'border-[var(--ft-border)] text-[var(--ft-muted)] hover:bg-[var(--ft-surface)]'
                        }`}
                      >
                        {t(`origin_${k}`)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {(hasRemote || hasPublishedAt || canFitHours || canFitSalary) && (
                <div className="flex flex-col gap-3">
                  {hasRemote && (
                    <label className="flex w-fit cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={remoteOnly}
                        onChange={(e) => setRemoteOnly(e.target.checked)}
                        className="h-4 w-4 accent-[var(--ft-accent)]"
                      />
                      <span className="text-xs font-semibold text-[var(--ft-muted)]">
                        {t('remoteOnly')}
                      </span>
                    </label>
                  )}

                  {/* Fit-to-preference: match a job's hours/salary against the
                      candidate's captured ask (8vance exposes the job fields).
                      Shown only when the wish + job data both exist. */}
                  {canFitHours && (
                    <label className="flex w-fit cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={fitHoursOnly}
                        onChange={(e) => setFitHoursOnly(e.target.checked)}
                        className="h-4 w-4 accent-[var(--ft-accent)]"
                      />
                      <span className="text-xs font-semibold text-[var(--ft-muted)]">
                        {t('fitHours', { h: prefHours ?? 0 })}
                      </span>
                    </label>
                  )}
                  {canFitSalary && (
                    <label className="flex w-fit cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={fitSalaryOnly}
                        onChange={(e) => setFitSalaryOnly(e.target.checked)}
                        className="h-4 w-4 accent-[var(--ft-accent)]"
                      />
                      <span className="text-xs font-semibold text-[var(--ft-muted)]">
                        {t('fitSalary')}
                      </span>
                    </label>
                  )}

                  {hasPublishedAt && (
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-[var(--ft-muted)]">
                        {t('publishedLabel')}
                      </label>
                      <select
                        value={published}
                        onChange={(e) =>
                          setPublished(e.target.value as PublishedKey)
                        }
                        className="w-full rounded-lg border border-[var(--ft-border)] bg-[var(--ft-surface)] px-3 py-1.5 text-sm text-[var(--ft-ink)] outline-none focus:border-[var(--ft-accent)]"
                      >
                        <option value="all">{t('published_all')}</option>
                        <option value="7d">{t('published_7d')}</option>
                        <option value="30d">{t('published_30d')}</option>
                      </select>
                    </div>
                  )}
                </div>
              )}

              <div className="relative">
                <p className="mb-1.5 text-xs font-semibold text-[var(--ft-muted)]">
                  {t('cityLabel')}
                </p>
                {/* Free city search — geocodes ANY city so a relocation target
                    (e.g. Eindhoven) is searchable, not just the result cities. */}
                <input
                  type="text"
                  value={cityQuery}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCityQuery(v);
                    // Too short to geocode: drop stale suggestions here (in the
                    // handler, not the fetch effect).
                    if (v.trim().length < 2) setCityGeo([]);
                  }}
                  onFocus={() => cityGeo.length > 0 && setCityGeoOpen(true)}
                  onBlur={() => setTimeout(() => setCityGeoOpen(false), 150)}
                  placeholder={t('citySearchPlaceholder')}
                  className="block w-full rounded-md border border-[var(--ft-border)] bg-[var(--ft-surface)] px-2.5 py-1.5 text-xs focus:border-[var(--ft-accent)] focus:outline-none"
                />
                {cityGeoOpen && cityGeo.length > 0 && (
                  <ul className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-auto rounded-md border border-[var(--ft-border)] bg-[var(--ft-surface)] shadow-lg">
                    {cityGeo.map((g) => (
                      <li key={`${g.label}-${g.lat}`}>
                        <button
                          type="button"
                          disabled={rematchPending}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            rematchNearCity(g);
                          }}
                          className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left text-xs hover:bg-[var(--ft-surface-2)] disabled:opacity-50"
                        >
                          <span>📍 {g.label}</span>
                          <span className="text-[10px] font-medium text-[var(--ft-accent-strong)]">
                            {t('matchNearCity')}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {rematchPending && (
                  <p className="mt-1 text-xs text-[var(--ft-muted)]">{t('rematchingNear')}</p>
                )}
                {/* Quick suggestions: up to 3 result cities (client-side narrow —
                    distinct from the geocode re-match above). */}
                {cities.length > 0 && (
                  <div className="mt-2">
                    <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--ft-muted)]">
                      {t('cityNarrowLabel')}
                    </p>
                    <FacetGroup
                      values={cities.slice(0, 3)}
                      selected={selectedCities}
                      formatValue={titleCaseCity}
                      onToggle={(v) => setSelectedCities((s) => toggleIn(s, v))}
                    />
                    {cities.length > 3 && (
                      <p className="mt-1 text-[10px] text-[var(--ft-muted)]">
                        {t('cityMoreHint', { n: cities.length - 3 })}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {hasOrigin && hasJobCoords && (
                <div>
                  <p className="mb-1 text-xs font-semibold text-[var(--ft-muted)]">
                    {maxDistanceKm > 0
                      ? t('distanceLabel', { km: maxDistanceKm })
                      : t('distanceLabelOff')}
                  </p>
                  <input
                    type="range"
                    min={0}
                    max={150}
                    step={5}
                    value={maxDistanceKm}
                    onChange={(e) => setMaxDistanceKm(Number(e.target.value))}
                    className="w-full"
                    aria-label={t('distanceLabelOff')}
                  />
                  <p className="mt-0.5 text-[10px] text-[var(--ft-muted)]">
                    {t('filterScopeHint', { n: coordCount })}
                  </p>
                </div>
              )}

              {sources.length > 0 && (
                <FacetGroup
                  label={t('sources')}
                  values={sources}
                  selected={selectedSources}
                  formatValue={(v) => v.replace(/[_-]+/g, ' ')}
                  onToggle={(v) =>
                    setSelectedSources((s) => toggleIn(s, v))
                  }
                />
              )}

              {contractTypes.length > 0 && (
                <FacetGroup
                  label={t('contractTypes')}
                  values={contractTypes}
                  selected={selectedContracts}
                  onToggle={(v) =>
                    setSelectedContracts((s) => toggleIn(s, v))
                  }
                />
              )}

              {hasTravel && (
                <div>
                  <p className="mb-1.5 text-xs font-semibold text-[var(--ft-muted)]">
                    {t('travelLabel')}
                  </p>
                  {/* The travel facet is OFF by default; the education heuristic
                      (won't-drive-an-hour) is offered as a one-click suggestion so
                      it never silently hides the whole list. */}
                  {travelMode === null && defaultTravelMode !== null && (
                    <p className="mb-1 text-[10px] text-[var(--ft-muted)]">
                      {t('travelPreset')}{' '}
                      <button
                        type="button"
                        onClick={() => {
                          setTravelMode(defaultTravelMode);
                          if (defaultTravelMax) setTravelMax(defaultTravelMax);
                        }}
                        className="font-medium text-[var(--ft-accent-strong)] hover:underline"
                      >
                        {t('travelPresetApply')}
                      </button>
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        setTravelMode((m) => (m === 'car' ? null : 'car'))
                      }
                      aria-pressed={travelMode === 'car'}
                      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                        travelMode === 'car'
                          ? 'border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]'
                          : 'border-[var(--ft-border)] text-[var(--ft-muted)] hover:border-[var(--ft-border-strong)]'
                      }`}
                    >
                      {t('travelCar')}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setTravelMode((m) => (m === 'bike' ? null : 'bike'))
                      }
                      aria-pressed={travelMode === 'bike'}
                      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                        travelMode === 'bike'
                          ? 'border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]'
                          : 'border-[var(--ft-border)] text-[var(--ft-muted)] hover:border-[var(--ft-border-strong)]'
                      }`}
                    >
                      {t('travelBike')}
                    </button>
                    {travelOvAvailable && (
                      <button
                        type="button"
                        onClick={() =>
                          setTravelMode((m) => (m === 'ov' ? null : 'ov'))
                        }
                        aria-pressed={travelMode === 'ov'}
                        className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                          travelMode === 'ov'
                            ? 'border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]'
                            : 'border-[var(--ft-border)] text-[var(--ft-muted)] hover:border-[var(--ft-border-strong)]'
                        }`}
                      >
                        {t('travelOv')}
                      </button>
                    )}
                  </div>
                  {travelMode !== null && (
                    <div className="mt-2 flex flex-col gap-2">
                      <select
                        aria-label={t('travelMax')}
                        value={travelMax}
                        onChange={(e) =>
                          setTravelMax(
                            e.target.value as NonNullable<TravelBucket>,
                          )
                        }
                        className="w-full rounded-lg border border-[var(--ft-border)] bg-[var(--ft-surface)] px-3 py-1.5 text-sm text-[var(--ft-ink)] outline-none focus:border-[var(--ft-accent)]"
                      >
                        {TRAVEL_MAX_BUCKETS.map((b) => (
                          <option key={b} value={b}>
                            {t(travelBucketKey(b)!)}
                          </option>
                        ))}
                      </select>
                      <label className="flex w-fit cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={travelIncludeUnknown}
                          onChange={(e) =>
                            setTravelIncludeUnknown(e.target.checked)
                          }
                          className="h-4 w-4 accent-[var(--ft-accent)]"
                        />
                        <span className="text-xs font-semibold text-[var(--ft-muted)]">
                          {t('travelIncludeUnknown')}
                        </span>
                      </label>
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs font-semibold text-[var(--ft-muted)]">
                  {t('minScore', { value: minScore })}
                </label>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={minScore}
                  onChange={(e) => setMinScore(Number(e.target.value))}
                  className="w-full accent-[var(--ft-accent)]"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-[var(--ft-muted)]">
                  {t('sortLabel')}
                </label>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  className="w-full rounded-lg border border-[var(--ft-border)] bg-[var(--ft-surface)] px-3 py-1.5 text-sm text-[var(--ft-ink)] outline-none focus:border-[var(--ft-accent)]"
                >
                  <option value="score">{t('sortScore')}</option>
                  <option value="newest">{t('sortNewest')}</option>
                </select>
              </div>
            </div>
          </section>

          {/* Map toggle + map (job locations coloured by travel time). */}
          {canShowMap && (
            <div className="mt-6">
              <button
                type="button"
                onClick={() => setShowMap((v) => !v)}
                aria-pressed={showMap}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                  showMap
                    ? 'border-[var(--ft-accent)] bg-[var(--ft-accent)] text-white'
                    : 'border-[var(--ft-border)] bg-[var(--ft-surface)] text-[var(--ft-ink)] hover:bg-[var(--ft-surface-2)]'
                }`}
              >
                {showMap ? t('mapHide') : t('mapShow', { count: mapJobs.length })}
              </button>
              {showMap && (
                <div className="mt-3">
                  <JobsMap
                    origin={
                      hasOrigin
                        ? {
                            lat: centreLat as number,
                            lng: centreLng as number,
                            city: matchCentre?.label ?? originCity,
                          }
                        : null
                    }
                    jobs={mapJobs}
                    radiusKm={maxDistanceKm}
                    travelMode={travelMode}
                    originLabel={isRelocated ? t('mapOriginRelocation') : t('mapOrigin')}
                  />
                  <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-[var(--ft-muted)]">
                    <span>🟢 {t('travelBucket_lt15')}</span>
                    <span>🟢 {t('travelBucket_lt30')}</span>
                    <span>🟠 {t('travelBucket_lt45')}</span>
                    <span>🟠 {t('travelBucket_lt60')}</span>
                    <span>🔴 {t('travelBucket_gt60')}</span>
                    <span>⚪ {t('mapUnknownTravel')}</span>
                    {mapJobs.length < visible.length && (
                      <span>{t('mapMissingCoords', { n: visible.length - mapJobs.length })}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Results. Two DISTINCT empty states:
              - rows exist but every one is filtered away → name the ACTUAL
                active filters + a one-click "toon alles" reset. This also
                covers presets that zero the list on load (contract/remote/
                travel seeds, agency-hide) — never a silent blank, never the
                old hardcoded "zet uitzendbureaus uit" guess.
              - the run genuinely returned nothing → relocation/search hint. */}
          {visible.length === 0 ? (
            rows.length > 0 ? (
              <div className="mt-6 rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface-2)] p-8 text-center">
                <div className="text-sm font-medium text-[var(--ft-ink)]">
                  {t('emptyFilteredTitle')}
                </div>
                {/* TODO i18n — hardcoded NL until the translations agent adds keys. */}
                <p className="mt-1 text-xs text-[var(--ft-muted)]">
                  Alle {rows.length} gevonden vacatures worden verborgen door de
                  actieve filters:
                </p>
                {activeFilterLabels.length > 0 && (
                  <ul className="mt-3 flex flex-wrap justify-center gap-1.5">
                    {activeFilterLabels.map((label) => (
                      <li
                        key={label}
                        className="rounded-full border border-[var(--ft-border)] bg-[var(--ft-surface)] px-2.5 py-1 text-xs text-[var(--ft-ink)]"
                      >
                        {label}
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  type="button"
                  onClick={showAllFilters}
                  className="mt-4 rounded-lg border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-3 py-1.5 text-sm font-semibold text-[var(--ft-accent-strong)] transition hover:border-[var(--ft-accent)]"
                >
                  {/* TODO i18n — hardcoded NL until the translations agent adds keys. */}
                  Toon alles ({rows.length})
                </button>
              </div>
            ) : (
              <div className="mt-6 rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface-2)] p-8 text-center">
                <div className="text-sm font-medium text-[var(--ft-ink)]">
                  {t('emptyTitle')}
                </div>
                <p className="mt-1 text-xs text-[var(--ft-muted)]">
                  {t('emptyRelocateBody')}
                </p>
              </div>
            )
          ) : (
            <ul className="mt-6 grid gap-3 sm:grid-cols-2">
              {visible.map((row) => (
                <JobCard
                  key={row.id}
                  row={row}
                  candidateId={candidateId}
                  travelMode={travelMode}
                  relocated={isRelocated}
                  prefHours={prefHours}
                  prefSalary={prefSalary}
                />
              ))}
            </ul>
          )}

          {maybeTruncated && (
            <p className="mt-4 text-center text-xs text-[var(--ft-muted)]">
              {t('truncationNote')}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function FacetGroup({
  label,
  values,
  selected,
  onToggle,
  formatValue,
}: {
  label?: string;
  values: string[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  /** Optional display transform; the underlying slug value is preserved. */
  formatValue?: (value: string) => string;
}): React.ReactElement {
  return (
    <div>
      {label ? (
        <span className="mb-1 block text-xs font-semibold text-[var(--ft-muted)]">
          {label}
        </span>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => {
          const on = selected.has(v);
          return (
            <button
              key={v}
              type="button"
              onClick={() => onToggle(v)}
              aria-pressed={on}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                on
                  ? 'border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]'
                  : 'border-[var(--ft-border)] text-[var(--ft-muted)] hover:border-[var(--ft-border-strong)]'
              }`}
            >
              {formatValue ? formatValue(v) : v}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Compact emoji label for the travel badge, or null when no mode/bucket. */
function travelBadgeLabel(
  row: JobRow,
  travelMode: TravelMode | null,
  t: ReturnType<typeof useTranslations>,
): string | null {
  const bucket = travelMode ? (row.travel?.[travelMode] ?? null) : null;
  return travelMode && bucket
    ? `${TRAVEL_MODE_EMOJI[travelMode]} ${t(travelBucketKey(bucket)!)}`
    : null;
}

function JobCard({
  row,
  candidateId,
  travelMode,
  relocated = false,
  prefHours,
  prefSalary,
}: {
  row: JobRow;
  candidateId: string;
  /** Active travel-filter mode (drives the per-card travel badge), or null. */
  travelMode: TravelMode | null;
  /** True when the run matched around a searched city (relocation). */
  relocated?: boolean;
  /** Candidate's captured hours/salary ask — drives the "fits" badge. */
  prefHours?: number;
  prefSalary?: { min?: number; max?: number };
}): React.ReactElement {
  const t = useTranslations('candidateMatch');
  const [open, setOpen] = useState(false);
  const pct = toPercent(row.score);
  const travelBadge = travelBadgeLabel(row, travelMode, t);
  const employer = employerLabel(row, t);
  const rawLocation = row.locationLabel ?? row.locationCity ?? null;
  const location = rawLocation ? titleCaseCity(rawLocation) : null;

  // Job hours + salary (from /extended/). Salary often null on JobDigger.
  const hoursLabel =
    row.hoursMin != null || row.hoursMax != null
      ? row.hoursMin != null && row.hoursMax != null && row.hoursMin !== row.hoursMax
        ? `${row.hoursMin}–${row.hoursMax} ${t('hoursUnit')}`
        : `${row.hoursMax ?? row.hoursMin} ${t('hoursUnit')}`
      : null;
  const salaryLabel =
    row.salaryLow != null || row.salaryHigh != null
      ? row.salaryLow != null && row.salaryHigh != null
        ? `€${row.salaryLow}–${row.salaryHigh}`
        : `€${row.salaryHigh ?? row.salaryLow}`
      : null;
  // Fit vs the candidate's captured ask — a green "fits" chip when we can judge
  // it and it does. null = no data → no claim.
  const fits = hoursFit(row, prefHours) === true || salaryFit(row, prefSalary) === true;

  return (
    <li className="ft-card group relative flex flex-col rounded-xl border border-[var(--ft-border)] bg-[var(--ft-surface)] p-4 transition hover:border-[var(--ft-border-strong)]">
      {/* A stretched overlay button makes the WHOLE card open the detail panel
          without nesting interactive elements inside a button. Inline controls
          that need their own click (the agency-reason popover) get `relative
          z-10` so they sit above the overlay and keep working. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('viewDetails')}
        className="absolute inset-0 z-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--ft-accent)]"
      />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold leading-snug text-[var(--ft-ink)]">
            {row.title}
          </h3>
          <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-[var(--ft-muted)]">
            <span aria-hidden="true" className="text-[var(--ft-border-strong)]">
              ◍
            </span>
            <span className="truncate">{employer}</span>
          </p>
        </div>
        <ScoreRing
          score={pct}
          size="sm"
          unknown={!row.scoreReliable}
          unknownTitle={t('scoreOnOpen')}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {/* On a relocation run, own-pool jobs are NOT near the searched city
            (own vacancies aren't re-centred) — say so, so they aren't mistaken
            for relocation hits. */}
        {relocated && row.isOwnPool && (
          <span className="relative z-10 rounded-md border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ft-accent-strong)]">
            {t('ownPoolRegardless')}
          </span>
        )}
        {fits && (
          <span className="rounded-md border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
            ✓ {t('fitsAsk')}
          </span>
        )}
        {hoursLabel && (
          <span className="rounded-md border border-[var(--ft-border)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ft-muted)]">
            🕑 {hoursLabel}
          </span>
        )}
        {salaryLabel && (
          <span className="rounded-md border border-[var(--ft-border)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ft-muted)]">
            {salaryLabel}
          </span>
        )}
        {location && (
          <span className="rounded-md border border-[var(--ft-border)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ft-muted)]">
            {location}
          </span>
        )}
        {row.contractType && (
          <span className="rounded-md border border-[var(--ft-border)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ft-muted)]">
            {row.contractType}
          </span>
        )}
        <SourceChip row={row} />
        {travelBadge && (
          <span className="rounded-md border border-[var(--ft-border)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ft-muted)]">
            {travelBadge}
          </span>
        )}
        {row.isStaffingAgency && (
          <span className="relative z-10">
            <AgencyBadge reasons={row.agencyReasons} />
          </span>
        )}
      </div>

      <span
        aria-hidden="true"
        className="pointer-events-none mt-3 inline-flex w-fit items-center gap-1 text-xs font-medium text-[var(--ft-accent-strong)]"
      >
        {t('viewDetails')} <span>→</span>
      </span>

      {open && (
        <JobDetailPanel
          row={row}
          candidateId={candidateId}
          travelMode={travelMode}
          onClose={() => setOpen(false)}
        />
      )}
    </li>
  );
}

/**
 * Slide-over DETAIL view for one matched job — reuses the right-side drawer
 * pattern of the shortlist FiltersPanel (backdrop button + max-w panel) and the
 * Esc/auto-focus posture of the pipeline ConfirmMoveDialog. On open it lazily
 * fetches the job's detail + skill gap via `getJobGapAction` (the same action
 * the card list relies on) and renders: title, employer (JobDigger/own-pool/
 * agency labelling), source chip, location, contract, publication date, remote,
 * travel badge, the FULL description, and the matched ✓ / missing gap. For
 * cross-company feed jobs whose required skills 403, the action degrades to the
 * detail + an empty/approximate skill list, surfaced via the GapSkills note.
 */
function JobDetailPanel({
  row,
  candidateId,
  travelMode,
  onClose,
}: {
  row: JobRow;
  candidateId: string;
  travelMode: TravelMode | null;
  onClose: () => void;
}): React.ReactElement {
  const t = useTranslations('candidateMatch');
  const locale = useLocale();
  const [result, setResult] = useState<JobGapResult | null>(null);
  const [pending, startTransition] = useTransition();
  const closeRef = useRef<HTMLButtonElement>(null);

  // Fetch the detail + gap once on open; auto-focus close; Esc closes. Mirrors
  // the lazy fetch the per-card disclosure used and the dialog Esc handling.
  useEffect(() => {
    closeRef.current?.focus();
    startTransition(async () => {
      const res = await getJobGapAction(
        candidateId,
        row.eightvanceJobId,
        !row.scoreReliable,
      );
      setResult(res);
    });
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateId, row.eightvanceJobId]);

  // Prefer the REAL graded score from the gap analysis (`/match/specific/`) once
  // it loads. Fall back to the list score only when it's reliable (own-pool);
  // for an unreliable row that hasn't resolved yet, show the neutral ring.
  const realPct =
    result?.ok && typeof result.score === 'number' ? toPercent(result.score) : null;
  const shownPct = realPct ?? (row.scoreReliable ? toPercent(row.score) : null);
  const employer = employerLabel(row, t);
  const location =
    row.locationLabel ??
    row.locationCity ??
    (result?.ok ? result.location : null) ??
    null;
  const travelBadge = travelBadgeLabel(row, travelMode, t);
  const publishedLabel = row.publishedAt
    ? formatPublished(row.publishedAt, locale)
    : null;

  // Portal to <body>: the panel is `position: fixed`, but it renders INSIDE the
  // job card <li>, which carries `will-change: transform` (the hover-lift). A
  // transform/will-change ancestor becomes the containing block for fixed
  // descendants, so without the portal the "full-screen" panel was clamped to
  // the ~134px card — the scrollable body collapsed to ~32px (the reported
  // "3mm scroll, you see nothing"). Rendering into document.body escapes that
  // containing block so `fixed inset-0` is viewport-relative again.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={row.title}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
    >
      <button
        type="button"
        aria-label={t('close')}
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      {/* Centered popup: roomy width, capped height, its OWN scroll — so the
          whole detail (description + full skill gap) is clearly readable. */}
      <div className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-[var(--ft-surface)] shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-[var(--ft-border)] px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-snug text-[var(--ft-ink)]">
              {row.title}
            </h2>
            <p className="mt-0.5 flex items-center gap-1 text-xs text-[var(--ft-muted)]">
              <span aria-hidden="true" className="text-[var(--ft-border-strong)]">
                ◍
              </span>
              <span className="truncate">{employer}</span>
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <SourceChip row={row} />
              {row.isStaffingAgency && <AgencyBadge reasons={row.agencyReasons} />}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ScoreRing
              score={shownPct ?? 0}
              size="sm"
              unknown={shownPct === null}
              unknownTitle={pending ? t('gap.loading') : t('scoreOnOpen')}
            />
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label={t('close')}
              className="grid h-8 w-8 place-items-center rounded-full text-zinc-500 outline-none transition hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-[var(--ft-accent)]"
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* Detail fields */}
          <GapRow label={t('gap.details')}>
            <dl className="space-y-1">
              <DetailLine label={t('gap.employer')} value={employer} />
              {result?.ok && result.hiringCompany && (
                <DetailLine label={t('gap.hiringCompany')} value={result.hiringCompany} />
              )}
              <DetailLine label={t('gap.location')} value={location} />
              <DetailLine label={t('gap.contract')} value={row.contractType} />
              <DetailLine
                label={t('publishedLabel')}
                value={publishedLabel}
              />
              {row.remote === true && (
                <DetailLine label={t('detailRemote')} value={t('detailRemoteYes')} />
              )}
              <DetailLine label={t('travelLabel')} value={travelBadge} />
            </dl>
          </GapRow>

          {/* Description (full) + skill gap */}
          {pending && !result ? (
            <p className="text-sm text-[var(--ft-muted)]">{t('gap.loading')}</p>
          ) : result && result.ok ? (
            <>
              {result.url && (
                <a
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex w-fit items-center gap-1 text-sm font-medium text-[var(--ft-accent-strong)] underline-offset-2 hover:underline"
                >
                  {t('detailOpenPosting')} <span aria-hidden="true">↗</span>
                </a>
              )}
              {result.contact && (
                <GapRow label={t('gap.contact')}>
                  <dl className="space-y-1">
                    {result.contact.name && (
                      <DetailLine label={t('gap.contactName')} value={result.contact.name} />
                    )}
                    {result.contact.email && (
                      <div className="flex justify-between gap-3 text-sm">
                        <dt className="shrink-0 text-[var(--ft-muted)]">{t('gap.contactEmail')}</dt>
                        <dd className="min-w-0 truncate text-right">
                          <a
                            href={`mailto:${result.contact.email}`}
                            className="text-[var(--ft-accent-strong)] underline-offset-2 hover:underline"
                          >
                            {result.contact.email}
                          </a>
                        </dd>
                      </div>
                    )}
                    {result.contact.phone && (
                      <div className="flex justify-between gap-3 text-sm">
                        <dt className="shrink-0 text-[var(--ft-muted)]">{t('gap.contactPhone')}</dt>
                        <dd className="min-w-0 truncate text-right">
                          <a
                            href={`tel:${result.contact.phone.replace(/[^\d+]/g, '')}`}
                            className="text-[var(--ft-accent-strong)] underline-offset-2 hover:underline"
                          >
                            {result.contact.phone}
                          </a>
                        </dd>
                      </div>
                    )}
                  </dl>
                </GapRow>
              )}
              {result.description && (
                <GapRow label={t('detailDescription')}>
                  <p className="whitespace-pre-line text-sm leading-relaxed text-[var(--ft-ink)]">
                    {result.description}
                  </p>
                </GapRow>
              )}
              <GapSkills result={result} />
            </>
          ) : (
            <p className="text-sm text-[var(--ft-gap)]">{t('gap.error')}</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Format an ISO publication date for display in the active UI locale. */
function formatPublished(iso: string, locale: string): string | null {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(ts);
  } catch {
    return new Date(ts).toLocaleDateString();
  }
}

function AgencyBadge({
  reasons,
}: {
  reasons: AgencyReason[];
}): React.ReactElement {
  const t = useTranslations('candidateMatch');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="rounded-md border border-[var(--ft-gap-line)] bg-[var(--ft-gap-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--ft-gap)]"
      >
        {t('agencyBadge')}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-60 rounded-xl border border-[var(--ft-border)] bg-[var(--ft-surface)] p-3 shadow-lg">
          <p className="mb-2 text-[11px] font-semibold text-[var(--ft-ink)]">
            {t('whyHidden')}
          </p>
          {reasons.length === 0 ? (
            <p className="text-[11px] text-[var(--ft-muted)]">
              {t('whyHiddenNone')}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {reasons.map((r, i) => (
                <li
                  key={`${r.signal}-${i}`}
                  className="text-[11px] leading-snug text-[var(--ft-muted)]"
                >
                  <span className="font-semibold text-[var(--ft-ink)]">
                    {t(`reason.${r.signal}`)}
                  </span>
                  {r.matched && (
                    <span className="ml-1 font-mono text-[10px] text-[var(--ft-border-strong)]">
                      “{r.matched}”
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Map a typed failure reason to its localized inline message. */
function rematchErrorKey(
  reason: Exclude<RematchResult, { ok: true }>['reason'],
): string {
  switch (reason) {
    case 'no_consent':
      return 'errNoConsent';
    case 'no_skills':
      return 'errNoSkills';
    case 'sync_auth':
      return 'errSyncAuth';
    case 'sync_source':
      return 'errSyncSource';
    case 'sync_company':
      return 'errSyncCompany';
    case 'sync_failed':
      return 'errSyncFailed';
    case 'forbidden':
      return 'errForbidden';
    case 'not_found':
      return 'errNotFound';
    default:
      return 'errFailed';
  }
}

function RematchButton({
  candidateId,
  synced,
}: {
  candidateId: string;
  /** When false the button reads "Sync & match" and explains sync failures inline. */
  synced: boolean;
}): React.ReactElement {
  const t = useTranslations('candidateMatch');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [errorKey, setErrorKey] = useState<string | null>(null);

  function onClick(): void {
    setErrorKey(null);
    startTransition(async () => {
      const result = await rematchAction(candidateId);
      if (result.ok) {
        // Re-render: MATCHING run now exists → MatchPoller shows progress.
        router.refresh();
      } else {
        setErrorKey(rematchErrorKey(result.reason));
      }
    });
  }

  const label = synced ? t('rematch') : t('syncAndMatch');

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-lg border border-[var(--ft-border)] bg-[var(--ft-surface)] px-3 py-1.5 text-sm font-medium text-[var(--ft-ink)] transition hover:border-[var(--ft-border-strong)] disabled:opacity-60"
      >
        {pending ? t('rematching') : label}
      </button>
      {errorKey && (
        <p
          role="alert"
          className="max-w-xs text-center text-xs font-medium text-red-600"
        >
          {t(errorKey)}
        </p>
      )}
    </div>
  );
}

/**
 * Progressive loader for an in-flight run — polls match-status (fast early,
 * easing to 4s) and refreshes the route as jobs land so partials stream in.
 * Mirrors the shortlist MatchPoller pattern.
 */
function MatchPoller({
  candidateId,
  hasRows,
}: {
  candidateId: string;
  hasRows: boolean;
}): React.ReactElement {
  const t = useTranslations('candidateMatch');
  const router = useRouter();
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState(8);
  const [count, setCount] = useState(0);
  const [note, setNote] = useState('');
  const lastRefreshCount = useRef(0);

  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Kick off the (slow) match execution off the request path. Fire-and-forget;
  // the route atomically claims the run, so a double-mount is harmless.
  useEffect(() => {
    void fetch(`/api/candidates/${candidateId}/run-match`, {
      method: 'POST',
      cache: 'no-store',
    }).catch(() => {});
  }, [candidateId]);

  useEffect(() => {
    let cancelled = false;
    let polls = 0;

    async function tick(): Promise<void> {
      try {
        const res = await fetch(
          `/api/candidates/${candidateId}/match-status`,
          { cache: 'no-store' },
        );
        if (res.ok) {
          const data = (await res.json()) as {
            settled: boolean;
            total: number;
          };
          if (!cancelled) {
            setCount(data.total);
            setProgress((p) => Math.min(92, Math.max(p, p + 6)));
            if (data.total > lastRefreshCount.current) {
              lastRefreshCount.current = data.total;
              router.refresh();
            }
            if (data.settled) {
              setProgress(100);
              router.refresh();
              return;
            }
          }
        }
      } catch {
        /* transient — keep polling */
      }
      polls += 1;
      // Cadence: snappy first results (2s), then a fast window (3s), then a
      // SLOW window (5s, was 15s) so a slow match still refreshes promptly
      // instead of dead-stopping. The "you can leave this page" reassurance is
      // shown on a 40s ELAPSED threshold in render (not poll-based), so it no
      // longer waits ~4min. Only at the final cap do we stop polling.
      if (!cancelled && polls < 120) {
        const delay = polls < 8 ? 2000 : polls < 60 ? 3000 : 5000;
        setTimeout(() => void tick(), delay);
      } else if (!cancelled) {
        // Poll budget exhausted. The stale-run sweep (STALE_RUN_MINUTES, kept
        // below this cap) has by now flipped a wedged run to FAILED, so force a
        // final refresh to pull that settled status in — otherwise the loader,
        // driven by the server `runStatus` prop, would spin forever on a run
        // that already resolved.
        setNote(t('matchingCapped'));
        router.refresh();
      }
    }

    const handle = setTimeout(() => void tick(), 900);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [candidateId, router, t]);

  const pct = Math.min(100, Math.max(0, Math.round(progress)));
  // REAL count only — no fabricated creeping number. Matched jobs are persisted
  // as they land and the poll reports the true total, so the count climbs for
  // real. The always-animated bar + elapsed timer carry the "still working"
  // signal while the count is genuinely still 0.
  const displayCount = count;

  return (
    <div className="mb-6 rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface-2)] p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--ft-ink)]">
          <span className="ft-sparkle" aria-hidden="true">
            ✦
          </span>
          <span>
            {hasRows ? t('matchingStillSearching') : t('matchingLooking', { pct })}
          </span>
        </div>
        <div className="text-xs font-medium tabular-nums text-[var(--ft-accent-strong)]">
          {t('matchingFoundCount', { count: displayCount })}
        </div>
      </div>
      <div className="mt-3">
        <div
          className="ft-progress-determinate"
          role="progressbar"
          aria-label={t('matchingTitle')}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
      <p className="mt-2 text-center text-xs text-[var(--ft-muted)]">
        {note ||
          (elapsed >= 40
            ? t('matchingBackground')
            : t('matchingElapsed', { seconds: elapsed }))}
      </p>
    </div>
  );
}
