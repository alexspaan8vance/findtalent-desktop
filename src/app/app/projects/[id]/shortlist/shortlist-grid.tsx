'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { ShortlistStage } from '@prisma/client';

import type {
  AnonymizedTalent,
  AnonSkill,
  ExperienceYearsBucket,
  TravelBucket,
} from '@/lib/anonymize/types';
import { bucketRank } from '@/lib/travel/bucketize';
import { ProficiencyMeter } from '@/components/proficiency-meter';
import { ScoreRing } from '@/components/score-ring';
import { StageSelect, type SelectableStage } from '@/components/shortlist/stage-select';
import { stageDisplayName } from '@/lib/pipeline-stage-label';

import { MatchBreakdown } from './match-breakdown';
import { MatchRadar, type RadarPoint } from './match-radar';
import { toggleFavorite } from './actions';
import { rerunMatch } from '../actions';
import { moveCandidate } from '../pipeline/actions';

export interface ShortlistRow {
  id: string;
  opaqueId: string;
  score: number;
  payload: AnonymizedTalent;
  tenantSlug: string;
  tenantName: string;
  /** ISO timestamp of when the match landed (drives the "recent" sort). */
  fetchedAt: string;
  /** True when this candidate arrived since the notification the user clicked
   *  through (`?highlight=new&since=…`) — drives the "Nieuw" badge/ring. */
  isNew?: boolean;
  revealedName: string | null;
  /** True when the candidate self-applied (inbound application) — "Gesolliciteerd" badge. */
  applied?: boolean;
  favorite: boolean;
  stage: ShortlistStage;
  /** Resolved configurable-stage id (legacy enum mapped server-side). */
  stageId: string | null;
  note: string;
}

interface Props {
  projectId: string;
  rows: ShortlistRow[];
  /** Org's configurable stages — drives the stage filter + per-card selector. */
  stages: SelectableStage[];
}

type SortMode = 'score' | 'years' | 'availability' | 'recent';
type StageFilter = 'all' | string;
type SkillLogic = 'and' | 'or';
type TravelMode = 'car' | 'bike' | 'ov';

/** Selectable max-time buckets for the travel-time facet, ascending. */
const TRAVEL_MAX_BUCKETS: readonly NonNullable<TravelBucket>[] = [
  'lt15',
  'lt30',
  'lt45',
  'lt60',
];

/** Years-of-experience bucket order (also the range bounds). */
const YEARS_BUCKETS: readonly ExperienceYearsBucket[] = ['0-3', '3-5', '5-10', '10+'];

const YEARS_RANK: Readonly<Record<ExperienceYearsBucket, number>> = {
  '0-3': 0,
  '3-5': 1,
  '5-10': 2,
  '10+': 3,
};

const AVAIL_RANK: Readonly<Record<string, number>> = {
  now: 0,
  '<30d': 1,
  '30-90d': 2,
  '>90d': 3,
  unknown: 4,
};

const MIN_COMPARE = 2;
const MAX_COMPARE = 4;

// --- Preferences weight model ---------------------------------------------
// Each dimension gets a 0–5 weight (default 3). When any weight deviates from
// the default we RE-RANK the loaded rows by a weighted blend of normalized
// sub-signals. This is a LOCAL re-weighting of the already-loaded shortlist —
// NOT a re-run of 8vance's matcher (see the honesty note in the modal).
type PrefDim = 'skills' | 'experience' | 'education' | 'languages';
const PREF_DIMS: readonly PrefDim[] = ['skills', 'experience', 'education', 'languages'];
const PREF_DEFAULT = 3;
type Weights = Record<PrefDim, number>;
const DEFAULT_WEIGHTS: Weights = {
  skills: PREF_DEFAULT,
  experience: PREF_DEFAULT,
  education: PREF_DEFAULT,
  languages: PREF_DEFAULT,
};

/** Short label for a travel-time bucket, e.g. lt30 → "≤30 min", gt60 → ">60 min".
 *  Returns null for the unknown bucket. The labels are i18n'd by the caller's
 *  `t` function via the `travelBucket_*` keys; this helper only picks the key. */
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

/** Split a free-text skills input into trimmed, lowercased tokens. */
function parseSkillTokens(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
}

/** Ordered, lowercased education levels seen across the loaded rows. We rank by
 *  this discovered order; unknown levels keep rank 0. */
function levelRank(level: string | undefined, order: string[]): number {
  if (!level) return -1;
  const i = order.indexOf(level.trim().toLowerCase());
  return i < 0 ? -1 : i;
}

/** Build the full text haystack used by the keyword (include/exclude) filter:
 *  skill names + experience function_title/sector + education field. */
function keywordHaystack(p: AnonymizedTalent): string {
  const parts: string[] = [];
  for (const s of p.skills) parts.push(s.name);
  for (const e of p.experience) {
    parts.push(e.function_title);
    parts.push(e.sector);
  }
  for (const ed of p.education) parts.push(ed.field_of_study_category);
  return parts.join('  ').toLowerCase();
}

interface FilterState {
  sources: Set<string>; // tenantSlug values
  skillTokens: string[];
  skillLogic: SkillLogic;
  keywordsInclude: string[];
  keywordsExclude: string[];
  functions: Set<string>; // experience[].function_title (lowercased keys)
  sectors: Set<string>; // experience[].sector (lowercased keys)
  yearsMin: ExperienceYearsBucket;
  yearsMax: ExperienceYearsBucket;
  yearsIncludeUnknown: boolean;
  eduMin: number; // index into eduOrder
  eduMax: number;
  eduIncludeUnknown: boolean;
  mustHave: boolean;
  location: string;
  language: string;
  minScore: number;
  favoritesOnly: boolean;
  stage: StageFilter;
  /** null = travel filter off. */
  travelMode: TravelMode | null;
  travelMax: NonNullable<TravelBucket>;
  travelIncludeUnknown: boolean;
}

function emptyFilters(eduMax: number): FilterState {
  return {
    sources: new Set(),
    skillTokens: [],
    skillLogic: 'and',
    keywordsInclude: [],
    keywordsExclude: [],
    functions: new Set(),
    sectors: new Set(),
    yearsMin: '0-3',
    yearsMax: '10+',
    yearsIncludeUnknown: true,
    eduMin: 0,
    eduMax,
    eduIncludeUnknown: true,
    mustHave: false,
    location: '',
    language: '',
    minScore: 0,
    favoritesOnly: false,
    stage: 'all',
    travelMode: null,
    travelMax: 'lt30',
    travelIncludeUnknown: true,
  };
}

export function ShortlistGrid({ projectId, rows, stages }: Props): React.ReactElement {
  const t = useTranslations('shortlist');
  const [sort, setSort] = useState<SortMode>('score');
  const [compareMode, setCompareMode] = useState<boolean>(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Panel/modal visibility.
  const [filtersOpen, setFiltersOpen] = useState<boolean>(false);
  const [prefsOpen, setPrefsOpen] = useState<boolean>(false);
  const [radarOpen, setRadarOpen] = useState<boolean>(false);

  // --- Facet vocabularies derived from the loaded rows. --------------------
  const sourceOptions = useMemo(() => {
    const m = new Map<string, string>(); // slug -> name
    for (const r of rows) if (!m.has(r.tenantSlug)) m.set(r.tenantSlug, r.tenantName);
    return [...m.entries()].map(([slug, name]) => ({ slug, name }));
  }, [rows]);

  const functionOptions = useMemo(() => {
    const m = new Map<string, string>(); // lowercase key -> display
    for (const r of rows)
      for (const e of r.payload.experience) {
        const key = e.function_title.trim().toLowerCase();
        if (key && !m.has(key)) m.set(key, e.function_title.trim());
      }
    return [...m.entries()].map(([key, label]) => ({ key, label })).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }, [rows]);

  const sectorOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows)
      for (const e of r.payload.experience) {
        const key = e.sector.trim().toLowerCase();
        if (key && !m.has(key)) m.set(key, e.sector.trim());
      }
    return [...m.entries()].map(([key, label]) => ({ key, label })).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }, [rows]);

  // Education levels in ascending order of how "high" they are. We don't know
  // the canonical order from anon data, so derive a stable order: rank by the
  // best (max) years bucket of talents who hold each level, then alpha. Good
  // enough for a relative range slider; unknown levels are excluded via the
  // include-unknown checkbox.
  const eduOrder = useMemo(() => {
    const KNOWN_ORDER = ['vmbo', 'mbo', 'havo', 'vwo', 'hbo', 'bachelor', 'wo', 'master', 'phd', 'doctorate'];
    const seen = new Set<string>();
    for (const r of rows)
      for (const ed of r.payload.education) {
        const k = ed.level?.trim().toLowerCase();
        if (k) seen.add(k);
      }
    const known = KNOWN_ORDER.filter((k) => seen.has(k));
    const unknown = [...seen].filter((k) => !KNOWN_ORDER.includes(k)).sort();
    return [...known, ...unknown];
  }, [rows]);
  const eduLabels = useMemo(() => {
    // Display label = original casing of first occurrence.
    const m = new Map<string, string>();
    for (const r of rows)
      for (const ed of r.payload.education) {
        const k = ed.level?.trim().toLowerCase();
        if (k && !m.has(k)) m.set(k, ed.level!.trim());
      }
    return eduOrder.map((k) => m.get(k) ?? k);
  }, [rows, eduOrder]);
  const eduMaxIndex = Math.max(0, eduOrder.length - 1);

  // OV (public transit) is reserved for a future provider and is normally null,
  // so only offer the OV chip when at least one loaded row actually has it.
  const travelOvAvailable = useMemo(
    () => rows.some((r) => r.payload.travel?.ov != null),
    [rows],
  );

  // --- Filter state. --------------------------------------------------------
  const [filters, setFilters] = useState<FilterState>(() => emptyFilters(eduMaxIndex));
  // Keep eduMax in sync if rows (and thus the level order) change after mount.
  // Clamped during render (React's "adjust state when props change" pattern)
  // instead of an effect, so an out-of-range value never paints.
  if (filters.eduMax > eduMaxIndex) {
    setFilters({ ...filters, eduMax: eduMaxIndex });
  }

  const patch = (p: Partial<FilterState>): void => setFilters((f) => ({ ...f, ...p }));

  // --- Preferences (weight) state. -----------------------------------------
  const [weights, setWeights] = useState<Weights>(DEFAULT_WEIGHTS);

  const filtersActive =
    filters.sources.size > 0 ||
    filters.skillTokens.length > 0 ||
    filters.keywordsInclude.length > 0 ||
    filters.keywordsExclude.length > 0 ||
    filters.functions.size > 0 ||
    filters.sectors.size > 0 ||
    filters.yearsMin !== '0-3' ||
    filters.yearsMax !== '10+' ||
    !filters.yearsIncludeUnknown ||
    filters.eduMin !== 0 ||
    filters.eduMax !== eduMaxIndex ||
    !filters.eduIncludeUnknown ||
    filters.mustHave ||
    filters.location.trim() !== '' ||
    filters.language.trim() !== '' ||
    filters.minScore > 0 ||
    filters.favoritesOnly ||
    filters.stage !== 'all' ||
    filters.travelMode !== null;

  const preferencesActive = PREF_DIMS.some((d) => weights[d] !== PREF_DEFAULT);
  const anyActive = filtersActive || preferencesActive || sort !== 'score';

  const clearFilters = (): void => setFilters(emptyFilters(eduMaxIndex));
  const clearPrefs = (): void => setWeights(DEFAULT_WEIGHTS);
  const clearAll = (): void => {
    setSort('score');
    clearFilters();
    clearPrefs();
  };

  // Optimistic per-card pipeline overrides keyed by matchId.
  const [overrides, setOverrides] = useState<
    Record<string, { favorite?: boolean; stageId?: string | null }>
  >({});

  const effective = (row: ShortlistRow): { favorite: boolean; stageId: string | null } => {
    const o = overrides[row.id];
    return {
      favorite: o?.favorite ?? row.favorite,
      stageId: o && 'stageId' in o ? (o.stageId ?? null) : row.stageId,
    };
  };

  // --- Weighted preference score (normalized 0..1 blend). -------------------
  // Normalization constants derived so each sub-signal lands in [0,1]:
  //   skillScore = clamp(skillCount/8) blended with must-have hit-rate
  //   expScore   = yearsRank / 3
  //   eduScore   = eduRank / (levels-1)
  //   langScore  = clamp(languageCount/3)
  // weighted = Σ(w_i·sub_i) / Σ w_i   (zero-weight dims drop out entirely)
  const prefScore = (r: ShortlistRow): number => {
    const p = r.payload;
    const skillCount = p.skills.length;
    const mustTotal = p.skills.filter((s) => s.must_have_match).length;
    const skillScore = Math.min(
      1,
      0.5 * Math.min(1, skillCount / 8) + 0.5 * Math.min(1, mustTotal / 3),
    );
    const yr = YEARS_RANK[p.total_years_experience_bucket ?? '0-3'] ?? 0;
    const expScore = yr / 3;
    const er = levelRank(
      p.education[0]?.level,
      eduOrder,
    );
    const eduScore = eduMaxIndex > 0 && er >= 0 ? er / eduMaxIndex : 0;
    const langScore = Math.min(1, p.languages.length / 3);

    const sub: Record<PrefDim, number> = {
      skills: skillScore,
      experience: expScore,
      education: eduScore,
      languages: langScore,
    };
    let num = 0;
    let den = 0;
    for (const d of PREF_DIMS) {
      num += weights[d] * sub[d];
      den += weights[d];
    }
    return den > 0 ? num / den : 0;
  };

  const visible = useMemo<ShortlistRow[]>(() => {
    const locNeedle = filters.location.trim().toLowerCase();
    const langNeedle = filters.language.trim().toLowerCase();
    const yMin = YEARS_RANK[filters.yearsMin];
    const yMax = YEARS_RANK[filters.yearsMax];

    const filtered = rows.filter((r) => {
      const p = r.payload;

      // Sources (pools).
      if (filters.sources.size > 0) {
        const pools = p.source_pools && p.source_pools.length > 0 ? p.source_pools : [r.tenantSlug];
        if (!pools.some((s) => filters.sources.has(s))) return false;
      }

      // Must-have skills present.
      if (filters.mustHave && !p.skills.some((s) => s.must_have_match)) return false;

      // Favorites / stage.
      const eff = overrides[r.id];
      const fav = eff?.favorite ?? r.favorite;
      const st = eff && 'stageId' in eff ? (eff.stageId ?? null) : r.stageId;
      if (filters.favoritesOnly && !fav) return false;
      if (filters.stage !== 'all' && st !== filters.stage) return false;

      // Min score.
      if (filters.minScore > 0 && r.score < filters.minScore) return false;

      // Skills — AND/OR over tokens. Also honor must_have_match: a token that
      // names a must-have skill counts as a match regardless of casing.
      if (filters.skillTokens.length > 0) {
        const names = p.skills.map((s) => s.name.toLowerCase());
        const hit = (tok: string): boolean => names.some((s) => s.includes(tok));
        const ok =
          filters.skillLogic === 'and'
            ? filters.skillTokens.every(hit)
            : filters.skillTokens.some(hit);
        if (!ok) return false;
      }

      // Keywords — free-text include/exclude across skills + experience +
      // education. `-foo` excludes; bare word includes. Includes are AND.
      if (filters.keywordsInclude.length > 0 || filters.keywordsExclude.length > 0) {
        const hay = keywordHaystack(p);
        if (filters.keywordsExclude.some((k) => hay.includes(k))) return false;
        if (!filters.keywordsInclude.every((k) => hay.includes(k))) return false;
      }

      // Experiences / functions (any selected matches).
      if (filters.functions.size > 0) {
        const have = p.experience.some((e) =>
          filters.functions.has(e.function_title.trim().toLowerCase()),
        );
        if (!have) return false;
      }

      // Industries / sectors (any selected matches).
      if (filters.sectors.size > 0) {
        const have = p.experience.some((e) =>
          filters.sectors.has(e.sector.trim().toLowerCase()),
        );
        if (!have) return false;
      }

      // Years of experience range (+ include-unknown).
      {
        const bucket = p.total_years_experience_bucket;
        if (bucket == null) {
          if (!filters.yearsIncludeUnknown) return false;
        } else {
          const rank = YEARS_RANK[bucket];
          if (rank < yMin || rank > yMax) return false;
        }
      }

      // Education level range (+ include-unknown). Use the talent's highest
      // known level across all education rows.
      if (eduOrder.length > 0 && (filters.eduMin !== 0 || filters.eduMax !== eduMaxIndex || !filters.eduIncludeUnknown)) {
        let best = -1;
        for (const ed of p.education) {
          const rk = levelRank(ed.level, eduOrder);
          if (rk > best) best = rk;
        }
        if (best < 0) {
          if (!filters.eduIncludeUnknown) return false;
        } else if (best < filters.eduMin || best > filters.eduMax) {
          return false;
        }
      }

      // Location — substring on province/country (NO city; anon-safe).
      if (locNeedle) {
        const hay = [p.location.province, p.location.country]
          .map((s) => (s ?? '').toLowerCase())
          .join(' ');
        if (!hay.includes(locNeedle)) return false;
      }

      // Language — substring on any spoken language name.
      if (langNeedle) {
        const hit = p.languages.some((l) => l.language.toLowerCase().includes(langNeedle));
        if (!hit) return false;
      }

      // Travel time (+ include-unknown). Keep a row iff its bucket for the
      // selected mode is at or below the max; null/undefined buckets are kept
      // only when include-unknown is on (mirrors the years/edu range filters).
      if (filters.travelMode !== null) {
        const bucket = p.travel?.[filters.travelMode] ?? null;
        if (bucket == null) {
          if (!filters.travelIncludeUnknown) return false;
        } else if (bucketRank(bucket) > bucketRank(filters.travelMax)) {
          return false;
        }
      }

      return true;
    });

    const sorted = [...filtered].sort((a, b) => {
      // Revealed candidates always pinned to the top.
      const ar = a.revealedName ? 1 : 0;
      const br = b.revealedName ? 1 : 0;
      if (ar !== br) return br - ar;

      // Favorites float up right after revealed candidates.
      const af = (overrides[a.id]?.favorite ?? a.favorite) ? 1 : 0;
      const bf = (overrides[b.id]?.favorite ?? b.favorite) ? 1 : 0;
      if (af !== bf) return bf - af;

      // When preferences are active, the weighted blend is the primary order.
      if (preferencesActive) {
        const ap = prefScore(a);
        const bp = prefScore(b);
        if (ap !== bp) return bp - ap;
      }

      if (sort === 'years') {
        const ay = YEARS_RANK[a.payload.total_years_experience_bucket ?? '0-3'] ?? -1;
        const by = YEARS_RANK[b.payload.total_years_experience_bucket ?? '0-3'] ?? -1;
        if (ay !== by) return by - ay;
      } else if (sort === 'availability') {
        const aa = AVAIL_RANK[a.payload.start_within_days] ?? 99;
        const ba = AVAIL_RANK[b.payload.start_within_days] ?? 99;
        if (aa !== ba) return aa - ba;
      } else if (sort === 'recent') {
        const at = Date.parse(a.fetchedAt) || 0;
        const bt = Date.parse(b.fetchedAt) || 0;
        if (at !== bt) return bt - at;
      }
      return b.score - a.score;
    });

    return sorted;
    // prefScore is derived from `weights`+row data; listed deps cover it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort, filters, overrides, weights, preferencesActive, eduOrder, eduMaxIndex]);

  const toggleSelect = (opaqueId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(opaqueId)) {
        next.delete(opaqueId);
      } else if (next.size < MAX_COMPARE) {
        next.add(opaqueId);
      }
      return next;
    });
  };

  // Radar plots the currently VISIBLE rows only (anon: opaqueId + score).
  const radarPoints = useMemo<RadarPoint[]>(
    () =>
      visible.map((r) => ({
        opaqueId: r.opaqueId,
        score: r.score,
        revealed: Boolean(r.revealedName),
      })),
    [visible],
  );

  const compareHref =
    `/app/projects/${projectId}/compare?ids=` +
    encodeURIComponent([...selected].join(','));
  const canCompare = selected.size >= MIN_COMPARE && selected.size <= MAX_COMPARE;

  return (
    <div>
      {/* Toolbar: Sort + Filters + Preferences + result count. */}
      <div className="mt-6 flex flex-wrap items-center gap-3 border-b border-[var(--ft-border)] pb-4">
        <label className="text-xs font-medium text-zinc-600">{t('sort')}</label>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortMode)}
          className="rounded-md border border-[var(--ft-border)] bg-white px-2 py-1 text-sm"
        >
          <option value="score">{t('sortScore')}</option>
          <option value="recent">{t('sortRecent')}</option>
          <option value="years">{t('sortYears')}</option>
          <option value="availability">{t('sortAvailability')}</option>
        </select>

        <button
          type="button"
          onClick={() => setFiltersOpen(true)}
          aria-haspopup="dialog"
          className={`relative inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
            filtersActive
              ? 'border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]'
              : 'border-[var(--ft-border)] bg-white text-zinc-700 hover:border-[var(--ft-border-strong)]'
          }`}
        >
          {t('filtersButton')}
          {filtersActive && (
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-[var(--ft-accent)] ring-2 ring-white"
            />
          )}
        </button>

        <button
          type="button"
          onClick={() => setPrefsOpen(true)}
          aria-haspopup="dialog"
          className={`relative inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
            preferencesActive
              ? 'border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]'
              : 'border-[var(--ft-border)] bg-white text-zinc-700 hover:border-[var(--ft-border-strong)]'
          }`}
        >
          {t('preferencesButton')}
          {preferencesActive && (
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-[var(--ft-accent)] ring-2 ring-white"
            />
          )}
        </button>

        <button
          type="button"
          onClick={() => setRadarOpen((v) => !v)}
          aria-pressed={radarOpen}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
            radarOpen
              ? 'border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]'
              : 'border-[var(--ft-border)] bg-white text-zinc-700 hover:border-[var(--ft-border-strong)]'
          }`}
        >
          {radarOpen ? t('hideRadar') : t('showRadar')}
        </button>

        <div className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
          <span>{t('candidates', { count: visible.length })}</span>
          {anyActive ? (
            <button
              type="button"
              onClick={clearAll}
              className="rounded-md border border-[var(--ft-border)] bg-white px-2.5 py-1 font-medium text-zinc-600 hover:bg-zinc-50"
            >
              {t('clearAll')}
            </button>
          ) : null}
        </div>
      </div>

      {/* Compare / export toolbar */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            setCompareMode((v) => !v);
            if (compareMode) setSelected(new Set());
          }}
          aria-pressed={compareMode}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
            compareMode
              ? 'border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]'
              : 'border-[var(--ft-border)] bg-white text-zinc-700 hover:border-[var(--ft-border-strong)]'
          }`}
        >
          {compareMode ? t('compareCancel') : t('compareStart')}
        </button>

        {compareMode && (
          <>
            <span className="text-xs text-zinc-500">
              {t('compareSelected', { count: selected.size, max: MAX_COMPARE })}
            </span>
            {canCompare ? (
              <Link
                href={compareHref}
                className="rounded-lg bg-[var(--ft-accent)] px-3 py-1.5 text-xs font-medium text-[var(--ft-accent-fg)] transition hover:bg-[var(--ft-accent-strong)]"
              >
                {t('compareOpen')}
              </Link>
            ) : (
              <span
                aria-disabled="true"
                className="cursor-not-allowed rounded-lg bg-[var(--ft-accent-soft)] px-3 py-1.5 text-xs font-medium text-[var(--ft-accent-strong)] opacity-60"
              >
                {t('compareOpen')}
              </span>
            )}
          </>
        )}

        <Link
          href={`/app/projects/${projectId}/export?format=csv`}
          className="ml-auto rounded-lg border border-[var(--ft-border)] bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:border-[var(--ft-border-strong)]"
        >
          {t('exportCsv')}
        </Link>
      </div>

      {radarOpen && visible.length > 0 && <MatchRadar points={radarPoints} />}

      {visible.length === 0 ? (
        // Distinguish "filters narrowed to zero" (offer a reset) from a
        // genuinely empty shortlist — mirrors the match view's empty split.
        <div className="mt-10 rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface)] p-8 text-center text-sm text-zinc-600">
          {filtersActive ? (
            <>
              <p>{t('noCandidatesFiltered')}</p>
              <button
                type="button"
                onClick={clearFilters}
                className="mt-3 rounded-lg border border-[var(--ft-border)] bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:border-[var(--ft-border-strong)]"
              >
                {t('noCandidatesFilteredReset')}
              </button>
            </>
          ) : (
            t('noCandidatesYet')
          )}
        </div>
      ) : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2">
          {visible.map((row) => (
            <ShortlistCard
              key={row.id}
              projectId={projectId}
              row={row}
              stages={stages}
              prefActive={preferencesActive}
              travelMode={filters.travelMode}
              effective={effective(row)}
              setOverrides={setOverrides}
              compareMode={compareMode}
              selected={selected.has(row.opaqueId)}
              selectDisabled={!selected.has(row.opaqueId) && selected.size >= MAX_COMPARE}
              onToggleSelect={() => toggleSelect(row.opaqueId)}
            />
          ))}
        </ul>
      )}

      {filtersOpen && (
        <FiltersPanel
          filters={filters}
          patch={patch}
          onClose={() => setFiltersOpen(false)}
          onReset={clearFilters}
          sourceOptions={sourceOptions}
          functionOptions={functionOptions}
          sectorOptions={sectorOptions}
          eduLabels={eduLabels}
          eduMaxIndex={eduMaxIndex}
          stages={stages}
          travelOvAvailable={travelOvAvailable}
        />
      )}

      {prefsOpen && (
        <PreferencesModal
          projectId={projectId}
          weights={weights}
          setWeights={setWeights}
          onClose={() => setPrefsOpen(false)}
          onReset={clearPrefs}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filters slide-over panel
// ---------------------------------------------------------------------------

function FiltersPanel({
  filters,
  patch,
  onClose,
  onReset,
  sourceOptions,
  functionOptions,
  sectorOptions,
  eduLabels,
  eduMaxIndex,
  stages,
  travelOvAvailable,
}: {
  filters: FilterState;
  patch: (p: Partial<FilterState>) => void;
  onClose: () => void;
  onReset: () => void;
  sourceOptions: { slug: string; name: string }[];
  functionOptions: { key: string; label: string }[];
  sectorOptions: { key: string; label: string }[];
  eduLabels: string[];
  eduMaxIndex: number;
  stages: SelectableStage[];
  travelOvAvailable: boolean;
}): React.ReactElement {
  const t = useTranslations('shortlist');
  // Localizes the seeded default-stage names in the stage filter.
  const tStages = useTranslations('pipeline');

  // Local working copies for token/chip inputs.
  const [skillDraft, setSkillDraft] = useState('');
  const [keywordDraft, setKeywordDraft] = useState('');

  const toggleIn = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const addSkills = (): void => {
    const toks = parseSkillTokens(skillDraft);
    if (toks.length === 0) return;
    const merged = [...new Set([...filters.skillTokens, ...toks])];
    patch({ skillTokens: merged });
    setSkillDraft('');
  };

  const addKeyword = (): void => {
    const raw = keywordDraft.trim();
    if (!raw) return;
    if (raw.startsWith('-')) {
      const term = raw.slice(1).trim().toLowerCase();
      if (term && !filters.keywordsExclude.includes(term)) {
        patch({ keywordsExclude: [...filters.keywordsExclude, term] });
      }
    } else {
      const term = raw.toLowerCase();
      if (!filters.keywordsInclude.includes(term)) {
        patch({ keywordsInclude: [...filters.keywordsInclude, term] });
      }
    }
    setKeywordDraft('');
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('filtersButton')}
      className="fixed inset-0 z-50 flex"
    >
      <button
        type="button"
        aria-label={t('close')}
        onClick={onClose}
        className="flex-1 bg-black/30"
      />
      <div className="flex h-full w-full max-w-md flex-col bg-[var(--ft-surface)] shadow-xl sm:w-[26rem]">
        <div className="flex items-center justify-between border-b border-[var(--ft-border)] px-5 py-4">
          <h2 className="text-base font-semibold text-[var(--ft-ink)]">{t('filtersButton')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            className="grid h-8 w-8 place-items-center rounded-full text-zinc-500 hover:bg-zinc-100"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 text-sm">
          {/* Sources — only when >1 pool present. */}
          {sourceOptions.length > 1 && (
            <Facet label={t('facetSources')}>
              <div className="flex flex-wrap gap-1.5">
                {sourceOptions.map((s) => (
                  <Chip
                    key={s.slug}
                    active={filters.sources.has(s.slug)}
                    onClick={() => patch({ sources: toggleIn(filters.sources, s.slug) })}
                  >
                    {s.name}
                  </Chip>
                ))}
              </div>
            </Facet>
          )}

          {/* Skills tokens + AND/OR logic. */}
          <Facet label={t('filterSkillsLabel')}>
            <div className="flex gap-2">
              <input
                type="text"
                value={skillDraft}
                onChange={(e) => setSkillDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addSkills();
                  }
                }}
                placeholder={t('filterSkillsPlaceholder')}
                className="min-w-0 flex-1 rounded-lg border border-[var(--ft-border)] bg-white px-2.5 py-1.5 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={addSkills}
                className="rounded-lg border border-[var(--ft-border)] bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
              >
                {t('addToken')}
              </button>
            </div>
            {filters.skillTokens.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {filters.skillTokens.map((tok) => (
                  <RemovableChip
                    key={tok}
                    onRemove={() =>
                      patch({ skillTokens: filters.skillTokens.filter((x) => x !== tok) })
                    }
                  >
                    {tok}
                  </RemovableChip>
                ))}
              </div>
            )}
            <div className="mt-2 flex items-center gap-4 text-xs text-zinc-600">
              <span className="font-medium text-zinc-500">{t('skillLogicLabel')}</span>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="skill-logic"
                  checked={filters.skillLogic === 'and'}
                  onChange={() => patch({ skillLogic: 'and' })}
                  className="h-3.5 w-3.5"
                />
                {t('skillLogicAnd')}
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="skill-logic"
                  checked={filters.skillLogic === 'or'}
                  onChange={() => patch({ skillLogic: 'or' })}
                  className="h-3.5 w-3.5"
                />
                {t('skillLogicOr')}
              </label>
            </div>
          </Facet>

          {/* Keywords include/exclude. */}
          <Facet label={t('facetKeywords')}>
            <input
              type="text"
              value={keywordDraft}
              onChange={(e) => setKeywordDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addKeyword();
                }
              }}
              placeholder={t('keywordsPlaceholder')}
              title={t('keywordsHint')}
              className="w-full rounded-lg border border-[var(--ft-border)] bg-white px-2.5 py-1.5 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-zinc-500">{t('keywordsHint')}</p>
            {(filters.keywordsInclude.length > 0 || filters.keywordsExclude.length > 0) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {filters.keywordsInclude.map((k) => (
                  <RemovableChip
                    key={`in-${k}`}
                    onRemove={() =>
                      patch({ keywordsInclude: filters.keywordsInclude.filter((x) => x !== k) })
                    }
                  >
                    {k}
                  </RemovableChip>
                ))}
                {filters.keywordsExclude.map((k) => (
                  <RemovableChip
                    key={`ex-${k}`}
                    tone="exclude"
                    onRemove={() =>
                      patch({ keywordsExclude: filters.keywordsExclude.filter((x) => x !== k) })
                    }
                  >
                    −{k}
                  </RemovableChip>
                ))}
              </div>
            )}
          </Facet>

          {/* Experiences / functions. */}
          {functionOptions.length > 0 && (
            <Facet label={t('facetFunctions')}>
              <div className="flex flex-wrap gap-1.5">
                {functionOptions.map((f) => (
                  <Chip
                    key={f.key}
                    active={filters.functions.has(f.key)}
                    onClick={() => patch({ functions: toggleIn(filters.functions, f.key) })}
                  >
                    {f.label}
                  </Chip>
                ))}
              </div>
            </Facet>
          )}

          {/* Industries / sectors. */}
          {sectorOptions.length > 0 && (
            <Facet label={t('facetSectors')}>
              <div className="flex flex-wrap gap-1.5">
                {sectorOptions.map((s) => (
                  <Chip
                    key={s.key}
                    active={filters.sectors.has(s.key)}
                    onClick={() => patch({ sectors: toggleIn(filters.sectors, s.key) })}
                  >
                    {s.label}
                  </Chip>
                ))}
              </div>
            </Facet>
          )}

          {/* Years of experience range + include unknown. */}
          <Facet label={t('filterMinYearsLabel')}>
            <div className="flex items-center gap-2">
              <select
                value={filters.yearsMin}
                onChange={(e) => {
                  const v = e.target.value as ExperienceYearsBucket;
                  patch({
                    yearsMin: v,
                    yearsMax:
                      YEARS_RANK[v] > YEARS_RANK[filters.yearsMax] ? v : filters.yearsMax,
                  });
                }}
                className="flex-1 rounded-lg border border-[var(--ft-border)] bg-white px-2 py-1.5 text-sm"
              >
                {YEARS_BUCKETS.map((b) => (
                  <option key={b} value={b}>
                    {t('filterMinYearsOption', { years: b })}
                  </option>
                ))}
              </select>
              <span className="text-xs text-zinc-400">–</span>
              <select
                value={filters.yearsMax}
                onChange={(e) => {
                  const v = e.target.value as ExperienceYearsBucket;
                  patch({
                    yearsMax: v,
                    yearsMin:
                      YEARS_RANK[v] < YEARS_RANK[filters.yearsMin] ? v : filters.yearsMin,
                  });
                }}
                className="flex-1 rounded-lg border border-[var(--ft-border)] bg-white px-2 py-1.5 text-sm"
              >
                {YEARS_BUCKETS.map((b) => (
                  <option key={b} value={b}>
                    {t('filterMinYearsOption', { years: b })}
                  </option>
                ))}
              </select>
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs text-zinc-600">
              <input
                type="checkbox"
                checked={filters.yearsIncludeUnknown}
                onChange={(e) => patch({ yearsIncludeUnknown: e.target.checked })}
                className="h-3.5 w-3.5 rounded border-zinc-300"
              />
              {t('includeUnknown')}
            </label>
          </Facet>

          {/* Education level range + include unknown. */}
          {eduLabels.length > 0 && (
            <Facet label={t('facetEducation')}>
              <div className="flex items-center gap-2">
                <select
                  value={filters.eduMin}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    patch({ eduMin: v, eduMax: Math.max(v, filters.eduMax) });
                  }}
                  className="flex-1 rounded-lg border border-[var(--ft-border)] bg-white px-2 py-1.5 text-sm"
                >
                  {eduLabels.map((label, i) => (
                    <option key={i} value={i}>
                      {label}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-zinc-400">–</span>
                <select
                  value={filters.eduMax}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    patch({ eduMax: v, eduMin: Math.min(v, filters.eduMin) });
                  }}
                  className="flex-1 rounded-lg border border-[var(--ft-border)] bg-white px-2 py-1.5 text-sm"
                >
                  {eduLabels.map((label, i) => (
                    <option key={i} value={i}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <label className="mt-2 flex items-center gap-2 text-xs text-zinc-600">
                <input
                  type="checkbox"
                  checked={filters.eduIncludeUnknown}
                  onChange={(e) => patch({ eduIncludeUnknown: e.target.checked })}
                  className="h-3.5 w-3.5 rounded border-zinc-300"
                />
                {t('includeUnknown')}
              </label>
            </Facet>
          )}

          {/* Location. */}
          <Facet label={t('filterLocationLabel')}>
            <input
              type="text"
              value={filters.location}
              onChange={(e) => patch({ location: e.target.value })}
              placeholder={t('filterLocationPlaceholder')}
              className="w-full rounded-lg border border-[var(--ft-border)] bg-white px-2.5 py-1.5 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-zinc-500">{t('locationAnonHint')}</p>
          </Facet>

          {/* Language. */}
          <Facet label={t('filterLanguageLabel')}>
            <input
              type="text"
              value={filters.language}
              onChange={(e) => patch({ language: e.target.value })}
              placeholder={t('filterLanguagePlaceholder')}
              className="w-full rounded-lg border border-[var(--ft-border)] bg-white px-2.5 py-1.5 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none"
            />
          </Facet>

          {/* Travel time — mode toggle + max-time select + include unknown. */}
          <Facet label={t('facetTravel')}>
            <div className="flex flex-wrap gap-1.5">
              <Chip
                active={filters.travelMode === 'car'}
                onClick={() =>
                  patch({ travelMode: filters.travelMode === 'car' ? null : 'car' })
                }
              >
                {t('travelModeCar')}
              </Chip>
              <Chip
                active={filters.travelMode === 'bike'}
                onClick={() =>
                  patch({ travelMode: filters.travelMode === 'bike' ? null : 'bike' })
                }
              >
                {t('travelModeBike')}
              </Chip>
              {travelOvAvailable && (
                <Chip
                  active={filters.travelMode === 'ov'}
                  onClick={() =>
                    patch({ travelMode: filters.travelMode === 'ov' ? null : 'ov' })
                  }
                >
                  {t('travelModeOv')}
                </Chip>
              )}
            </div>
            {filters.travelMode !== null && (
              <>
                <div className="mt-2">
                  <select
                    value={filters.travelMax}
                    onChange={(e) =>
                      patch({ travelMax: e.target.value as NonNullable<TravelBucket> })
                    }
                    className="w-full rounded-lg border border-[var(--ft-border)] bg-white px-2 py-1.5 text-sm"
                  >
                    {TRAVEL_MAX_BUCKETS.map((b) => (
                      <option key={b} value={b}>
                        {t('travelMaxOption', { label: t(travelBucketKey(b)!) })}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="mt-2 flex items-center gap-2 text-xs text-zinc-600">
                  <input
                    type="checkbox"
                    checked={filters.travelIncludeUnknown}
                    onChange={(e) => patch({ travelIncludeUnknown: e.target.checked })}
                    className="h-3.5 w-3.5 rounded border-zinc-300"
                  />
                  {t('includeUnknown')}
                </label>
              </>
            )}
          </Facet>

          {/* Min score. */}
          <Facet label={t('filterMinScoreLabel', { score: filters.minScore })}>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={filters.minScore}
              onChange={(e) => patch({ minScore: Number(e.target.value) })}
              className="w-full accent-[var(--ft-accent)]"
            />
          </Facet>

          {/* Stage + favorites + must-have. */}
          <Facet label={t('stageFilter')}>
            <select
              value={filters.stage}
              onChange={(e) => patch({ stage: e.target.value })}
              className="w-full rounded-lg border border-[var(--ft-border)] bg-white px-2 py-1.5 text-sm"
            >
              <option value="all">{t('stageFilterAll')}</option>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {stageDisplayName(s.name, tStages)}
                </option>
              ))}
            </select>
            <label className="mt-2 flex items-center gap-2 text-xs text-zinc-700">
              <input
                type="checkbox"
                checked={filters.favoritesOnly}
                onChange={(e) => patch({ favoritesOnly: e.target.checked })}
                className="h-3.5 w-3.5 rounded border-zinc-300"
              />
              {t('favoritesOnly')}
            </label>
            <label className="mt-1 flex items-center gap-2 text-xs text-zinc-700">
              <input
                type="checkbox"
                checked={filters.mustHave}
                onChange={(e) => patch({ mustHave: e.target.checked })}
                className="h-3.5 w-3.5 rounded border-zinc-300"
              />
              {t('mustHaveOnly')}
            </label>
          </Facet>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--ft-border)] px-5 py-3">
          <button
            type="button"
            onClick={onReset}
            className="rounded-lg border border-[var(--ft-border)] bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            {t('reset')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-[var(--ft-accent)] px-4 py-1.5 text-sm font-medium text-[var(--ft-accent-fg)] hover:bg-[var(--ft-accent-strong)]"
          >
            {t('apply')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Facet({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
        active
          ? 'border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]'
          : 'border-[var(--ft-border)] bg-white text-zinc-700 hover:border-[var(--ft-border-strong)]'
      }`}
    >
      {children}
    </button>
  );
}

function RemovableChip({
  children,
  onRemove,
  tone = 'include',
}: {
  children: React.ReactNode;
  onRemove: () => void;
  tone?: 'include' | 'exclude';
}): React.ReactElement {
  const t = useTranslations('shortlist');
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
        tone === 'exclude'
          ? 'border-[var(--ft-gap-line)] bg-[var(--ft-gap-soft)] text-[var(--ft-gap)]'
          : 'border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]'
      }`}
    >
      {children}
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('remove')}
        className="leading-none opacity-70 hover:opacity-100"
      >
        ✕
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Preferences modal (weight sliders)
// ---------------------------------------------------------------------------

function PreferencesModal({
  projectId,
  weights,
  setWeights,
  onClose,
  onReset,
}: {
  projectId: string;
  weights: Weights;
  setWeights: React.Dispatch<React.SetStateAction<Weights>>;
  onClose: () => void;
  onReset: () => void;
}): React.ReactElement {
  const t = useTranslations('shortlist');
  const dimLabel: Record<PrefDim, string> = {
    skills: t('prefDimSkills'),
    experience: t('prefDimExperience'),
    education: t('prefDimEducation'),
    languages: t('prefDimLanguages'),
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('preferencesButton')}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label={t('close')}
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <div className="relative z-10 w-full max-w-md rounded-2xl bg-[var(--ft-surface)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--ft-border)] px-5 py-4">
          <h2 className="text-base font-semibold text-[var(--ft-ink)]">
            {t('preferencesButton')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('close')}
            className="grid h-8 w-8 place-items-center rounded-full text-zinc-500 hover:bg-zinc-100"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <div className="px-5 py-4">
          <p className="text-sm text-zinc-700">{t('preferencesPrompt')}</p>
          <div className="mt-4 space-y-4">
            {PREF_DIMS.map((d) => (
              <label key={d} className="block">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-zinc-700">{dimLabel[d]}</span>
                  <span className="tabular-nums text-xs text-zinc-500">{weights[d]}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={5}
                  step={1}
                  value={weights[d]}
                  onChange={(e) =>
                    setWeights((w) => ({ ...w, [d]: Number(e.target.value) }))
                  }
                  className="mt-1 w-full accent-[var(--ft-accent)]"
                />
              </label>
            ))}
          </div>
          <div className="mt-4 rounded-lg bg-[var(--ft-surface-2)] px-3 py-2 text-[11px] leading-relaxed text-zinc-500">
            <p>{t('preferencesNote')}</p>
            <Link
              href={`/app/projects/${projectId}/edit`}
              className="mt-1.5 inline-flex items-center gap-1 font-medium text-[var(--ft-accent)] hover:underline"
            >
              {t('preferencesRematchCta')} <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--ft-border)] px-5 py-3">
          <button
            type="button"
            onClick={onReset}
            className="rounded-lg border border-[var(--ft-border)] bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            {t('reset')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-[var(--ft-accent)] px-4 py-1.5 text-sm font-medium text-[var(--ft-accent-fg)] hover:bg-[var(--ft-accent-strong)]"
          >
            {t('apply')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function ShortlistCard({
  projectId,
  row,
  stages,
  prefActive,
  travelMode,
  effective,
  setOverrides,
  compareMode,
  selected,
  selectDisabled,
  onToggleSelect,
}: {
  projectId: string;
  row: ShortlistRow;
  stages: SelectableStage[];
  /** True when preference weights deviate from default (re-ranking is on). */
  prefActive: boolean;
  /** Active travel-filter mode (drives the per-card travel badge), or null. */
  travelMode: TravelMode | null;
  effective: { favorite: boolean; stageId: string | null };
  setOverrides: React.Dispatch<
    React.SetStateAction<Record<string, { favorite?: boolean; stageId?: string | null }>>
  >;
  compareMode: boolean;
  selected: boolean;
  selectDisabled: boolean;
  onToggleSelect: () => void;
}): React.ReactElement {
  const tr = useTranslations('shortlist');
  const [pending, startTransition] = useTransition();
  const [moveError, setMoveError] = useState<string | null>(null);
  const t = row.payload;
  const isRevealed = Boolean(row.revealedName);
  const isNew = Boolean(row.isNew);
  const isApplied = Boolean(row.applied);
  const topSkills = t.skills.filter((s) => !s.gap).slice(0, 5);
  const skillsUnavailable = Boolean(t.skills_unavailable);
  const yearsLabel = t.total_years_experience_bucket
    ? tr('yearsExperience', { years: t.total_years_experience_bucket })
    : null;
  const currentExp = t.experience.find((e) => e.is_current);
  const location =
    [t.location.province, t.location.country]
      .map((s) => (s ?? '').trim())
      .filter((s) => s && s.toLowerCase() !== 'unknown')
      .join(', ') || tr('locationUnknown');

  // Travel badge: only when a mode is selected and this row has that bucket.
  const travelBucket = travelMode ? (t.travel?.[travelMode] ?? null) : null;
  const travelBadge =
    travelMode && travelBucket
      ? tr('travelBadge', {
          time: tr(travelBucketKey(travelBucket)!),
          mode: tr(`travelModeBy_${travelMode}`),
        })
      : null;

  const experienceSummary = [
    yearsLabel,
    currentExp ? `${currentExp.function_title} · ${currentExp.sector}` : null,
  ]
    .filter((v): v is string => v !== null)
    .join(' · ');

  const onFavorite = (): void => {
    setOverrides((prev) => ({
      ...prev,
      [row.id]: { ...prev[row.id], favorite: !effective.favorite },
    }));
    startTransition(async () => {
      const res = await toggleFavorite(row.id);
      if (res.ok) {
        setOverrides((prev) => ({
          ...prev,
          [row.id]: { ...prev[row.id], favorite: res.favorite },
        }));
      }
    });
  };

  const onStageId = (stageId: string): void => {
    const prevStageId: string | null = effective.stageId;
    setMoveError(null);
    setOverrides((prev) => ({
      ...prev,
      [row.id]: { ...prev[row.id], stageId },
    }));
    startTransition(async () => {
      const res = await moveCandidate(row.id, stageId, 0);
      if (res.ok) {
        setOverrides((prev) => ({
          ...prev,
          [row.id]: { ...prev[row.id], stageId: res.stageId },
        }));
      } else {
        setOverrides((prev) => {
          if (prev[row.id]?.stageId !== stageId) return prev;
          return { ...prev, [row.id]: { ...prev[row.id], stageId: prevStageId } };
        });
        setMoveError(
          res.reason === 'reveal_required'
            ? tr('moveErrorRevealRequired')
            : tr('moveErrorGeneric'),
        );
      }
    });
  };

  return (
    <li
      data-opaque-id={row.opaqueId}
      className={`relative flex flex-col rounded-2xl border bg-[var(--ft-surface)] p-5 shadow-[0_1px_2px_rgba(16,18,22,0.04)] ${
        selected
          ? 'border-[var(--ft-accent)] ring-2 ring-[var(--ft-accent-line)]'
          : isNew
            ? 'border-[var(--ft-accent)] ring-2 ring-[var(--ft-accent)]'
            : isRevealed
              ? 'border-[var(--ft-accent-line)] ring-1 ring-[var(--ft-accent-line)]'
              : 'border-[var(--ft-border)]'
      }`}
    >
      {isNew && (
        <span className="absolute right-3 top-3 z-10 inline-flex items-center rounded-full bg-[var(--ft-accent)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ft-accent-fg)]">
          {tr('newBadge')}
        </span>
      )}
      {isApplied && (
        <span
          data-testid="applied-badge"
          className={`absolute z-10 inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white ${
            isNew ? 'right-3 top-9' : 'right-3 top-3'
          }`}
        >
          {tr('appliedBadge')}
        </span>
      )}
      {compareMode && (
        <label className="absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-md border border-[var(--ft-border)] bg-white/90 px-2 py-1 text-[11px] font-medium text-zinc-700 backdrop-blur">
          <input
            type="checkbox"
            checked={selected}
            disabled={selectDisabled}
            onChange={onToggleSelect}
            className="h-3.5 w-3.5 rounded border-zinc-300"
          />
          {tr('compareSelect')}
        </label>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {isRevealed ? (
            <>
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--ft-accent-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ft-accent-strong)]">
                {tr('revealedBadge')}
              </span>
              <h3 className="mt-1.5 truncate text-base font-semibold text-[var(--ft-ink)]">
                {row.revealedName}
              </h3>
            </>
          ) : (
            <div className="text-xs uppercase tracking-wide text-zinc-500">
              {tr('anonymousCandidate')}
            </div>
          )}
          <div className="mt-0.5 text-sm text-zinc-600">{location}</div>
          {travelBadge && (
            <span className="mt-1 inline-flex items-center rounded-full border border-[var(--ft-border)] bg-[var(--ft-surface-2)] px-2 py-0.5 text-[10px] font-medium text-zinc-600">
              {travelBadge}
            </span>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span
              className="inline-flex items-center rounded-full border border-[var(--ft-border)] px-2 py-0.5 text-[10px] font-medium text-zinc-600"
              title={row.tenantName}
            >
              {/* Proper tenant display name, not the lowercase slug alias. */}
              {tr('fromPool', { name: row.tenantName })}
            </span>
            {prefActive && (
              <span className="inline-flex items-center rounded-full border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ft-accent-strong)]">
                {tr('weightedPill')}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <ScoreRing score={row.score} />
          <button
            type="button"
            onClick={onFavorite}
            disabled={pending}
            aria-pressed={effective.favorite}
            aria-label={effective.favorite ? tr('unfavorite') : tr('favorite')}
            title={effective.favorite ? tr('unfavorite') : tr('favorite')}
            className={`grid h-8 w-8 place-items-center rounded-full border transition disabled:opacity-50 ${
              effective.favorite
                ? 'border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]'
                : 'border-[var(--ft-border)] text-zinc-400 hover:text-[var(--ft-accent)]'
            }`}
          >
            <span aria-hidden="true" className="text-sm leading-none">
              {effective.favorite ? '★' : '☆'}
            </span>
          </button>
        </div>
      </div>

      {experienceSummary && (
        <div className="mt-3 text-sm text-zinc-700">{experienceSummary}</div>
      )}

      <SkillSummary skills={topSkills} unavailable={skillsUnavailable} projectId={projectId} />

      <MatchBreakdown talent={t} />

      <div className="mt-4">
        <StageSelect
          stages={stages}
          stageId={effective.stageId}
          onChangeStageId={onStageId}
          disabled={pending}
        />
        {moveError && (
          <p
            role="alert"
            className="mt-1.5 rounded-md bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700"
          >
            {moveError}
          </p>
        )}
      </div>

      <div className="mt-5 flex items-center justify-between border-t border-[var(--ft-border)] pt-4">
        <Link
          href={`/app/projects/${projectId}/talent/${row.opaqueId}`}
          className="text-sm font-medium text-[var(--ft-ink)] underline-offset-4 hover:underline"
        >
          {tr('viewDetail')}
        </Link>
        {isRevealed ? (
          <Link
            href={`/app/projects/${projectId}/talent/${row.opaqueId}`}
            className="rounded-lg border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-3 py-1.5 text-xs font-medium text-[var(--ft-accent-strong)] hover:border-[var(--ft-accent)]"
          >
            {tr('viewContact')}
          </Link>
        ) : (
          <Link
            href={`/app/projects/${projectId}/talent/${row.opaqueId}#reveal`}
            className="rounded-lg bg-[var(--ft-accent)] px-3 py-1.5 text-xs font-medium text-[var(--ft-accent-fg)] transition hover:bg-[var(--ft-accent-strong)]"
          >
            {tr('revealCta')}
          </Link>
        )}
      </div>
    </li>
  );
}

/**
 * Inline recovery for a skill-fetch failure: re-runs the project-wide match
 * (the same server action the header "Refresh matches" uses) right from the
 * card, so a recruiter can retry a transient 8vance skill-load without leaving
 * the shortlist. Project-scoped, best-effort — errors surface a small note.
 */
function SkillsUnavailableNote({ projectId }: { projectId: string }): React.ReactElement {
  const tr = useTranslations('shortlist');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);

  function onRematch(): void {
    setFailed(false);
    start(async () => {
      const res = await rerunMatch(projectId);
      if (res.ok) router.refresh();
      else setFailed(true);
    });
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <p className="text-xs text-zinc-500">{tr('skillsUnavailable')}</p>
      <button
        type="button"
        onClick={onRematch}
        disabled={pending}
        className="rounded-md border border-[var(--ft-border)] px-2 py-0.5 text-[11px] font-semibold text-zinc-700 transition hover:border-[var(--ft-border-strong)] disabled:opacity-60"
      >
        {pending ? tr('rematchPending') : tr('rematchInline')}
      </button>
      {failed && (
        <span role="alert" className="text-[11px] font-medium text-red-600">
          {tr('rematchFailed')}
        </span>
      )}
    </div>
  );
}

function SkillSummary({
  skills,
  unavailable = false,
  projectId,
}: {
  skills: AnonSkill[];
  unavailable?: boolean;
  projectId: string;
}): React.ReactElement {
  const tr = useTranslations('shortlist');
  if (skills.length === 0) {
    // Distinguish a transient fetch failure (offer an inline Rematch) from a
    // talent that genuinely has no skills on file.
    if (unavailable) return <SkillsUnavailableNote projectId={projectId} />;
    return <p className="mt-4 text-xs text-zinc-500">{tr('noSkillData')}</p>;
  }
  return (
    <ul className="mt-4 space-y-2">
      {skills.map((s) => (
        <li key={s.name} className="flex items-center justify-between gap-3 text-xs">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-zinc-700">{s.name}</span>
            {s.must_have_match && (
              <span className="shrink-0 rounded-full border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--ft-accent-strong)]">
                {tr('mustHave')}
              </span>
            )}
          </span>
          <ProficiencyMeter
            label={s.proficiency_label}
            variant={s.must_have_match ? 'accent' : 'muted'}
          />
        </li>
      ))}
    </ul>
  );
}
