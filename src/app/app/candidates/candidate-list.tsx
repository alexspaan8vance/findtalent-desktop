'use client';

/**
 * Scope-aware candidate list + filter bar.
 *
 * Two row kinds are merged into one list:
 *   - LOCAL rows: every here-registered Candidate (passed from the server). They
 *     keep today's actions — "View profile" → /app/candidates/{id}/match plus
 *     the muted self-onboard link.
 *   - POOL rows: 8vance talents read through for the owner's FULL-scope pools.
 *     Fetched PAGINATED from /api/candidates/pool (25/page, 8vance's own
 *     pagination) so a ~1000-talent pool never loads at once. A pool row that
 *     already has a local Candidate is shown as the local row instead (dedupe by
 *     8vance talentId); a pool-only row gets a read-through "View profile" + an
 *     "Import / manage" action that creates a local Candidate from it.
 *
 * Filter panel (extensible foundation, 8vance-style): a name/email text search
 * + a source filter (All / Registered here / Pool-only) + a pool picker, PLUS
 * "rich" filters that narrow LOCAL rows on their projected profile data:
 *   - status (All / Ready / Onboarding / Matching / Draft)
 *   - location (city/region substring)
 *   - skills (one or more tokens, match-ALL, case-insensitive)
 *   - contract type (permanent / temporary / uitzend / interim)
 *   - work type (remote)
 * Pool-only rows (read through from 8vance, 25/page) only carry name/email/
 * talentId, so the rich filters CANNOT apply to them — when any rich filter is
 * active we hide the pool browse for those rows and show a small note that rich
 * filters only narrow registered candidates (rather than silently mismatching).
 * The text search filters local rows client-side and is passed through to
 * 8vance (`?q=`) for pool rows; the API tells us whether 8vance honoured it
 * (`searchPassedThrough`) and we surface a note when we fell back to client
 * filtering. A "Clear filters" affordance + a live result count are shown.
 * Adding a new filter = add state + one narrowing clause + one control.
 *
 * This is the OWNER screen (org-guarded upstream): full talent data is fine
 * here. It is NOT the anonymized customer shortlist.
 */

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';

import { InviteLinkButton } from './invite-link-button';
import { importPoolTalentAction, bulkImportPoolTalentsAction } from './actions';
import { formatDate } from '@/lib/format-date';
import type { PoolPayload, PoolTalentRow } from '@/app/api/candidates/pool/route';

/**
 * A pool-only row tagged with its source pool. In single-pool mode every row
 * shares the active pool; in "All pools" mode rows come from several pools and
 * each carries its own `tenantId` + `poolName` so the badge + per-row import
 * target the right 8vance company.
 */
type TaggedPoolRow = PoolTalentRow & { tenantId: string; poolName: string };

/**
 * Merge of one current-page fetch across one or more pools. `total` is the
 * SUMMED pool size across all fetched pools (null if any pool's total is
 * unknown); `hasNext` is true if ANY pool has a next page; `searchPassedThrough`
 * is true only if EVERY fetched pool honoured `?q=` (else we note the fallback).
 */
interface MergedPoolData {
  rows: TaggedPoolRow[];
  total: number | null;
  hasNext: boolean;
  searchPassedThrough: boolean;
  /** How many pools were combined (1 for single-pool mode). */
  poolCount: number;
}

/** Page-size options for the pool browse (capped at 100 server-side). */
const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

/**
 * Sentinel picker value for the "All pools" combined browse. Real pool tenant
 * ids are 8vance company ids (numeric strings), so this can never collide.
 * When active, the list fetches the SAME current page from every FULL pool in
 * parallel, tags each row with its pool, and merges them into one browse.
 */
const ALL_POOLS = '__all__';

/**
 * Query-based selection model (Gmail/Linear pattern) for POOL-ONLY rows. We
 * never enumerate 20k ids in the browser:
 *   - 'some' — the user picked individual rows; `included` holds those ids.
 *   - 'all'  — the ENTIRE pool for the active tenant + current `q` is selected,
 *     MINUS `excluded`. Effective count = total - excluded.size. Unchecking a
 *     row adds it to `excluded`; the server re-derives membership by paging the
 *     pool itself, so we keep only the small exclusion set client-side.
 */
type Selection =
  | { mode: 'some'; included: Set<number> }
  | { mode: 'all'; excluded: Set<number> };

const EMPTY_SELECTION: Selection = { mode: 'some', included: new Set() };

export interface LocalRow {
  id: string;
  name: string;
  email: string | null;
  status: string;
  createdAt: string;
  eightvanceTalentId: number | null;
  // --- Rich fields backing the super-specific filters (projected server-side
  // from profileJson / preferencesJson; may be empty when no CV/prefs). -----
  skills: string[];
  location: string | null;
  contractTypes: string[];
  remote: boolean;
}

/** A FULL-scope pool the owner can browse the 8vance talents of. */
export interface FullPool {
  tenantId: string;
  name: string;
}

type SourceFilter = 'all' | 'local' | 'pool';

/** Status filter options (rich — local rows only). 'all' = no narrowing. */
const STATUS_OPTIONS = ['all', 'READY', 'MATCHING', 'ONBOARDING', 'DRAFT'] as const;
type StatusFilter = (typeof STATUS_OPTIONS)[number];

/** Contract-type tokens (mirror the onboarding enum + i18n contract_* keys). */
const CONTRACT_OPTIONS = ['permanent', 'temporary', 'uitzend', 'interim'] as const;
type ContractFilter = 'all' | (typeof CONTRACT_OPTIONS)[number];

/** Work-type filter. 'all' = no narrowing; 'remote' = prefers remote work. */
type WorkTypeFilter = 'all' | 'remote';

/** Split a free-text skills input into trimmed, lowercased tokens. */
function parseSkillTokens(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
}

function statusLabelKey(
  status: string,
): 'statusReady' | 'statusMatching' | 'statusOnboarding' | 'statusArchived' | 'statusDraft' {
  switch (status) {
    case 'READY':
      return 'statusReady';
    case 'MATCHING':
      return 'statusMatching';
    case 'ONBOARDING':
      return 'statusOnboarding';
    case 'ARCHIVED':
      return 'statusArchived';
    default:
      return 'statusDraft';
  }
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  const color =
    status === 'READY'
      ? 'bg-emerald-100 text-emerald-700'
      : status === 'MATCHING'
        ? 'bg-amber-100 text-amber-700'
        : status === 'ONBOARDING'
          ? 'bg-sky-100 text-sky-700'
          : status === 'ARCHIVED'
            ? 'bg-zinc-100 text-zinc-500'
            : 'bg-zinc-100 text-zinc-700';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{label}</span>;
}

/** Provenance badge: registered-here (local) vs pool-only (8vance). */
function ScopeBadge({ kind, label }: { kind: 'local' | 'pool'; label: string }) {
  const color =
    kind === 'local'
      ? 'bg-indigo-100 text-indigo-700'
      : 'bg-zinc-100 text-zinc-600';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{label}</span>;
}

/** Debounce a fast-changing value (the search box) for the pool fetch. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function CandidateList({
  localRows,
  fullPools,
}: {
  localRows: LocalRow[];
  fullPools: FullPool[];
}) {
  const t = useTranslations('candidates');
  const locale = useLocale();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  // Active pool to browse. With >1 FULL pool we default to ALL_POOLS (the
  // combined browse — the user clearly wants every pool at once); with exactly
  // one pool there is nothing to combine so we pin to that pool.
  const [activePool, setActivePool] = useState(
    fullPools.length > 1 ? ALL_POOLS : (fullPools[0]?.tenantId ?? ''),
  );

  // Is the combined "All pools" browse active? (Only meaningful with >1 pool.)
  const allPoolsMode = activePool === ALL_POOLS && fullPools.length > 1;
  // The pool(s) we actually fetch this render: every pool in all-mode, else the
  // single picked pool. Memoised so the fetch effect has a stable dep.
  const activeTenants = useMemo<string[]>(
    () => (allPoolsMode ? fullPools.map((p) => p.tenantId) : activePool ? [activePool] : []),
    [allPoolsMode, fullPools, activePool],
  );
  // Pool name lookup for the per-row "van <pool>" badge in combined mode.
  const poolNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of fullPools) m.set(p.tenantId, p.name);
    return m;
  }, [fullPools]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(25);

  // Query-based selection over POOL-ONLY rows (see Selection).
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);

  // --- Rich filters (narrow LOCAL rows only). ------------------------------
  const [status, setStatus] = useState<StatusFilter>('all');
  const [locationQuery, setLocationQuery] = useState('');
  const [skillsQuery, setSkillsQuery] = useState('');
  const [contract, setContract] = useState<ContractFilter>('all');
  const [workType, setWorkType] = useState<WorkTypeFilter>('all');

  const debouncedQuery = useDebounced(query, 350);
  const debouncedLocation = useDebounced(locationQuery, 300);
  const debouncedSkills = useDebounced(skillsQuery, 300);
  const hasPool = fullPools.length > 0;

  const skillTokens = useMemo(() => parseSkillTokens(debouncedSkills), [debouncedSkills]);

  // Any rich (local-only) filter active? Pool rows can't satisfy these, so we
  // hide the pool browse + surface a note while one is active.
  const richFiltersActive =
    status !== 'all' ||
    contract !== 'all' ||
    workType !== 'all' ||
    debouncedLocation.trim() !== '' ||
    skillTokens.length > 0;

  const anyFilterActive =
    richFiltersActive || debouncedQuery.trim() !== '' || source !== 'all';

  function clearFilters() {
    setQuery('');
    setSource('all');
    setStatus('all');
    setLocationQuery('');
    setSkillsQuery('');
    setContract('all');
    setWorkType('all');
  }

  // Reset to page 1 whenever any filter (or the page size) changes — adjusted
  // during render (prev-key comparison; React's "adjust state when props
  // change" pattern) so the stale page never paints or gets fetched.
  const pageResetKey = JSON.stringify([
    debouncedQuery,
    activePool,
    pageSize,
    source,
    status,
    debouncedLocation,
    skillTokens,
    contract,
    workType,
  ]);
  const [prevPageResetKey, setPrevPageResetKey] = useState(pageResetKey);
  if (pageResetKey !== prevPageResetKey) {
    setPrevPageResetKey(pageResetKey);
    setPage(1);
  }

  // Reset the selection whenever the tenant or the pool query changes — a
  // selection is only meaningful for ONE (tenant, q) pool snapshot. (Paging or
  // changing page size keeps the selection: in all-mode the server re-derives
  // membership, and in some-mode the included ids are still the user's picks.)
  // Same render-phase prev-key pattern as the page reset above.
  const selectionResetKey = JSON.stringify([activePool, debouncedQuery]);
  const [prevSelectionResetKey, setPrevSelectionResetKey] = useState(selectionResetKey);
  if (selectionResetKey !== prevSelectionResetKey) {
    setPrevSelectionResetKey(selectionResetKey);
    setSelection(EMPTY_SELECTION);
  }

  // --- Local rows: filter client-side (text + source + rich filters). ------
  const filteredLocal = useMemo(() => {
    const needle = debouncedQuery.trim().toLowerCase();
    const locNeedle = debouncedLocation.trim().toLowerCase();
    return localRows.filter((r) => {
      if (source === 'pool') return false;
      // Name / email text search.
      if (needle) {
        const hit =
          r.name.toLowerCase().includes(needle) ||
          (r.email ? r.email.toLowerCase().includes(needle) : false);
        if (!hit) return false;
      }
      // Status.
      if (status !== 'all' && r.status !== status) return false;
      // Location substring (city/region/country label).
      if (locNeedle && !(r.location ?? '').toLowerCase().includes(locNeedle)) return false;
      // Skills — match ALL tokens (each token must substring-match some skill).
      if (skillTokens.length > 0) {
        const haystack = r.skills.map((s) => s.toLowerCase());
        const allMatch = skillTokens.every((tok) => haystack.some((s) => s.includes(tok)));
        if (!allMatch) return false;
      }
      // Contract type.
      if (contract !== 'all' && !r.contractTypes.includes(contract)) return false;
      // Work type (remote).
      if (workType === 'remote' && !r.remote) return false;
      return true;
    });
  }, [
    localRows,
    debouncedQuery,
    source,
    status,
    debouncedLocation,
    skillTokens,
    contract,
    workType,
  ]);

  // --- Pool rows: fetch the active FULL pool(s), one page at a time. -------
  // In all-pools mode we fetch the SAME current page from every pool in
  // parallel (reusing the per-tenant route) and merge; the merged payload looks
  // identical to the single-pool case downstream.
  //
  // The fetch is KEYED: `poolKey` describes the wanted page, `poolFetch` holds
  // the last RESOLVED request, and loading/error/data are DERIVED from the
  // pair — so the fetch effect never sets state synchronously (the old
  // setPoolLoading(true)/setPoolError(false) at fetch start).
  const [poolRefreshNonce, setPoolRefreshNonce] = useState(0);
  const [poolFetch, setPoolFetch] = useState<{
    key: string;
    data: MergedPoolData | null;
    error: boolean;
  } | null>(null);

  // Rich filters can't apply to pool-only rows (they lack the data), so we
  // suppress the read-through browse while any is active and show a note.
  const showPool =
    hasPool && source !== 'local' && activeTenants.length > 0 && !richFiltersActive;
  // null = pool hidden → nothing to fetch.
  const poolKey = showPool
    ? JSON.stringify([activeTenants, page, pageSize, debouncedQuery.trim(), poolRefreshNonce])
    : null;
  // Pool hidden → drop the stale payload during render (prev-comparison
  // pattern), so re-showing it starts from a clean fetch — exactly like the
  // old setPoolData(null) on the hidden path did.
  if (poolKey === null && poolFetch !== null) setPoolFetch(null);
  const poolData = poolFetch?.data ?? null;
  // Loading while the wanted page hasn't resolved (the previous page's rows
  // stay visible during a refetch, same as before). An error only surfaces
  // from the resolved fetch — a newer fetch starting hides it, mirroring the
  // old setPoolError(false)-at-start.
  const poolLoading = poolKey !== null && poolFetch?.key !== poolKey;
  const poolError = !poolLoading && poolFetch !== null && poolFetch.error;

  useEffect(() => {
    if (poolKey === null) return;
    let superseded = false;

    const fetchOne = async (tenantId: string): Promise<(PoolPayload & { tenantId: string })> => {
      const params = new URLSearchParams({
        tenantId,
        page: String(page),
        page_size: String(pageSize),
      });
      if (debouncedQuery.trim()) params.set('q', debouncedQuery.trim());
      const res = await fetch(`/api/candidates/pool?${params.toString()}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`pool ${tenantId} read failed`);
      const data = (await res.json()) as PoolPayload;
      return { ...data, tenantId };
    };

    void (async () => {
      try {
        // Page N from EVERY active pool, in parallel.
        const results = await Promise.all(activeTenants.map(fetchOne));
        if (superseded) return; // a newer request superseded this

        // Merge + tag with pool identity. Dedupe defensively by (tenantId,
        // talentId) — different pools are different 8vance companies so ids won't
        // collide across pools, but a duplicate within one page is dropped.
        const seen = new Set<string>();
        const rows: TaggedPoolRow[] = [];
        for (const r of results) {
          const poolName = poolNameById.get(r.tenantId) ?? r.tenantId;
          for (const row of r.rows) {
            const key = `${r.tenantId}:${row.talentId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            rows.push({ ...row, tenantId: r.tenantId, poolName });
          }
        }
        // Summed total across pools (null if ANY pool's total is unknown — we
        // can't claim an exact combined count then). hasNext = ANY pool hasNext.
        const total = results.some((r) => r.total == null)
          ? null
          : results.reduce((sum, r) => sum + (r.total ?? 0), 0);
        const hasNext = results.some((r) => r.hasNext);
        const searchPassedThrough = results.every((r) => r.searchPassedThrough);

        setPoolFetch({
          key: poolKey,
          data: { rows, total, hasNext, searchPassedThrough, poolCount: results.length },
          error: false,
        });
      } catch {
        if (!superseded) setPoolFetch({ key: poolKey, data: null, error: true });
      }
    })();
    return () => {
      superseded = true;
    };
  }, [poolKey, activeTenants, page, pageSize, debouncedQuery, poolNameById]);

  // Pool-only rows = pool talents WITHOUT a local Candidate (the deduped set).
  // A pool row that already has a local Candidate is represented by its local
  // row above, so we drop it here to avoid showing the talent twice.
  const poolOnlyRows: TaggedPoolRow[] = useMemo(
    () => (poolData?.rows ?? []).filter((r) => r.localCandidateId === null),
    [poolData],
  );

  const totalLabel =
    poolData?.total != null
      ? allPoolsMode
        ? t('poolTotalAcross', {
            count: poolData.total,
            pools: poolData.poolCount ?? activeTenants.length,
          })
        : t('poolTotal', { count: poolData.total })
      : null;

  const showingEmpty = filteredLocal.length === 0 && (!showPool || poolOnlyRows.length === 0);

  // Live result count. Local rows are exact; pool rows we count the visible
  // (deduped) page only (we deliberately don't fetch the whole pool to total).
  const visibleCount = filteredLocal.length + (showPool ? poolOnlyRows.length : 0);

  // --- Pagination math. Y is known only when 8vance gave us a total. -------
  const total = poolData?.total ?? null;
  const totalPages = total != null ? Math.max(1, Math.ceil(total / pageSize)) : null;

  // --- Selection helpers (query-based; never enumerate the pool). ----------
  /** Is a single pool talent currently selected? */
  const isSelected = useCallback(
    (talentId: number): boolean =>
      selection.mode === 'all'
        ? !selection.excluded.has(talentId)
        : selection.included.has(talentId),
    [selection],
  );

  /** Toggle one row in/out of the selection (in either mode). */
  const toggleOne = useCallback((talentId: number, checked: boolean) => {
    setSelection((prev) => {
      if (prev.mode === 'all') {
        const excluded = new Set(prev.excluded);
        if (checked) excluded.delete(talentId);
        else excluded.add(talentId);
        return { mode: 'all', excluded };
      }
      const included = new Set(prev.included);
      if (checked) included.add(talentId);
      else included.delete(talentId);
      return { mode: 'some', included };
    });
  }, []);

  // Pool-only ids on the CURRENT page (already-local rows are managed, not
  // selectable). The header checkbox + page-selected math operate on these.
  const pageIds = useMemo(() => poolOnlyRows.map((r) => r.talentId), [poolOnlyRows]);
  const pageSelectedCount = useMemo(
    () => pageIds.filter((id) => isSelected(id)).length,
    [pageIds, isSelected],
  );
  const allPageSelected = pageIds.length > 0 && pageSelectedCount === pageIds.length;

  /** Header "select all on this page" — selects/clears just this page's ids. */
  const togglePage = useCallback(
    (checked: boolean) => {
      setSelection((prev) => {
        if (prev.mode === 'all') {
          const excluded = new Set(prev.excluded);
          for (const id of pageIds) {
            if (checked) excluded.delete(id);
            else excluded.add(id);
          }
          return { mode: 'all', excluded };
        }
        const included = new Set(prev.included);
        for (const id of pageIds) {
          if (checked) included.add(id);
          else included.delete(id);
        }
        return { mode: 'some', included };
      });
    },
    [pageIds],
  );

  /** Flip into all-mode: the whole pool (current tenant + q) minus none. */
  const selectAllInPool = useCallback(() => {
    setSelection({ mode: 'all', excluded: new Set() });
  }, []);

  const clearSelection = useCallback(() => setSelection(EMPTY_SELECTION), []);

  // Effective selected count WITHOUT enumerating the pool:
  //   all-mode  → total - excluded.size (needs the 8vance total).
  //   some-mode → included.size.
  const selectedCount =
    selection.mode === 'all'
      ? total != null
        ? Math.max(0, total - selection.excluded.size)
        : null // total unknown → can't show an exact all-mode count
      : selection.included.size;
  const hasSelection =
    selection.mode === 'all' ? true : selection.included.size > 0;

  // After any import, refresh server data (local rows) + re-fetch the pool page
  // (nonce bump → new pool key) so imported talents flip to "registered here",
  // and drop the selection.
  const refreshAfterImport = useCallback(() => {
    router.refresh();
    setPoolRefreshNonce((n) => n + 1);
    setSelection(EMPTY_SELECTION);
  }, [router]);

  return (
    <div>
      {/* Filter panel */}
      <div className="mb-4 rounded-xl border border-zinc-200 bg-zinc-50/60 p-3">
        {/* Row 1: text search + source segmented + pool picker. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('filterSearchPlaceholder')}
              aria-label={t('filterSearchLabel')}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none sm:max-w-xs"
            />
            <div className="flex shrink-0 items-center gap-1 rounded-lg border border-zinc-200 bg-white p-1">
              {(['all', 'local', 'pool'] as const).map((opt) => {
                // The pool option is only meaningful when a FULL pool exists.
                if (opt === 'pool' && !hasPool) return null;
                const active = source === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setSource(opt)}
                    aria-pressed={active}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                      active
                        ? 'bg-zinc-900 text-white shadow-sm'
                        : 'text-zinc-500 hover:text-zinc-700'
                    }`}
                  >
                    {opt === 'all'
                      ? t('filterSourceAll')
                      : opt === 'local'
                        ? t('filterSourceLocal')
                        : t('filterSourcePool')}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Pool picker (only when more than one FULL pool). Defaults to the
              combined "All pools" option; picking one pool browses just it. */}
          {hasPool && fullPools.length > 1 && source !== 'local' && (
            <select
              value={activePool}
              onChange={(e) => setActivePool(e.target.value)}
              aria-label={t('poolPickerLabel')}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
            >
              <option value={ALL_POOLS}>{t('poolPickerAll', { count: fullPools.length })}</option>
              {fullPools.map((p) => (
                <option key={p.tenantId} value={p.tenantId}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Row 2: rich filters (narrow registered candidates only). */}
        <div className="mt-3 grid grid-cols-1 gap-3 border-t border-zinc-200 pt-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
            {t('filterStatusLabel')}
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm font-normal text-zinc-900 focus:border-zinc-500 focus:outline-none"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt === 'all' ? t('filterStatusAll') : t(statusLabelKey(opt))}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
            {t('filterLocationLabel')}
            <input
              type="text"
              value={locationQuery}
              onChange={(e) => setLocationQuery(e.target.value)}
              placeholder={t('filterLocationPlaceholder')}
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm font-normal text-zinc-900 focus:border-zinc-500 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
            {t('filterSkillsLabel')}
            <input
              type="text"
              value={skillsQuery}
              onChange={(e) => setSkillsQuery(e.target.value)}
              placeholder={t('filterSkillsPlaceholder')}
              title={t('filterSkillsHint')}
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm font-normal text-zinc-900 focus:border-zinc-500 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
            {t('filterContractLabel')}
            <select
              value={contract}
              onChange={(e) => setContract(e.target.value as ContractFilter)}
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm font-normal text-zinc-900 focus:border-zinc-500 focus:outline-none"
            >
              <option value="all">{t('filterContractAll')}</option>
              {CONTRACT_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {t(`contract_${opt}`)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
            {t('filterWorkTypeLabel')}
            <select
              value={workType}
              onChange={(e) => setWorkType(e.target.value as WorkTypeFilter)}
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm font-normal text-zinc-900 focus:border-zinc-500 focus:outline-none"
            >
              <option value="all">{t('filterWorkTypeAll')}</option>
              <option value="remote">{t('filterWorkTypeRemote')}</option>
            </select>
          </label>
        </div>

        {/* Row 3: result count + clear. */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
          <span>
            {showPool
              ? t('filterResultCountWithPool', { count: visibleCount })
              : t('filterResultCount', { count: visibleCount })}
            {showPool && poolData?.total != null ? (
              <span className="ml-2 font-medium text-zinc-600">
                ·{' '}
                {allPoolsMode
                  ? t('poolTotalAcross', {
                      count: poolData.total,
                      pools: poolData.poolCount ?? activeTenants.length,
                    })
                  : t('poolTotal', { count: poolData.total })}
              </span>
            ) : null}
            {richFiltersActive && hasPool ? (
              <span className="ml-2 italic text-zinc-400">{t('filterRichPoolNote')}</span>
            ) : null}
          </span>
          {anyFilterActive ? (
            <button
              type="button"
              onClick={clearFilters}
              className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 font-medium text-zinc-600 hover:bg-zinc-50"
            >
              {t('filterClear')}
            </button>
          ) : null}
        </div>
      </div>

      {showingEmpty && !poolLoading ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-6 text-center text-sm text-zinc-500">
          {t('filterNoResults')}
        </div>
      ) : (
        <ul className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white">
          {/* Header: select-all-on-this-page (pool-only rows are selectable).
              Bulk select/import targets ONE 8vance company, so it is hidden in
              the combined "All pools" browse (per-row import still works). */}
          {showPool && !allPoolsMode && pageIds.length > 0 ? (
            <li className="flex items-center gap-3 bg-zinc-50/80 px-5 py-2.5 text-xs font-medium text-zinc-500">
              <input
                type="checkbox"
                checked={allPageSelected}
                ref={(el) => {
                  // Indeterminate when SOME but not all of the page is selected.
                  if (el) el.indeterminate = pageSelectedCount > 0 && !allPageSelected;
                }}
                onChange={(e) => togglePage(e.target.checked)}
                aria-label={t('bulkSelectPage')}
                className="h-4 w-4 rounded border-zinc-300"
              />
              <span>
                {pageSelectedCount > 0
                  ? t('bulkPageSelected', { count: pageSelectedCount })
                  : t('bulkSelectPage')}
              </span>
            </li>
          ) : null}

          {/* Local rows */}
          {filteredLocal.map((c) => {
            const matchable = c.status === 'READY' || c.status === 'MATCHING';
            return (
              <li key={`local-${c.id}`} className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <div className="truncate font-medium text-zinc-900">{c.name}</div>
                  <div className="mt-0.5 truncate text-xs text-zinc-500">
                    {c.email ? `${c.email} · ` : ''}
                    {formatDate(locale, c.createdAt)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <ScopeBadge kind="local" label={t('scopeLocal')} />
                  <StatusBadge status={c.status} label={t(statusLabelKey(c.status))} />
                  <InviteLinkButton candidateId={c.id} label={t('inviteLink')} variant="muted" />
                  <Link
                    href={`/app/candidates/${c.id}/match`}
                    className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
                  >
                    {matchable ? t('viewProfile') : t('continueOnboarding')}
                  </Link>
                </div>
              </li>
            );
          })}

          {/* Pool-only rows. Each row imports against ITS OWN pool (r.tenantId),
              so combined mode mixes pools safely. Checkboxes/bulk select only
              appear in single-pool mode (the bulk bar is single-tenant); in
              combined mode each row shows a "van <pool>" badge instead. */}
          {showPool &&
            poolOnlyRows.map((r) => (
              <PoolRowItem
                key={`pool-${r.tenantId}-${r.talentId}`}
                row={r}
                tenantId={r.tenantId}
                poolName={allPoolsMode ? r.poolName : null}
                selectable={!allPoolsMode}
                selected={isSelected(r.talentId)}
                onToggle={(checked) => toggleOne(r.talentId, checked)}
                onImported={refreshAfterImport}
              />
            ))}
        </ul>
      )}

      {/* "Select all {total}" promotion bar — shown once the whole CURRENT
          page is selected in some-mode, so the user can escalate to the entire
          pool WITHOUT us ever enumerating the ids in the browser. In all-mode
          it shows the effective count + a clear affordance. */}
      {showPool && !allPoolsMode && hasSelection ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-xs text-indigo-800">
          {selection.mode === 'all' ? (
            <>
              <span className="font-medium">
                {selectedCount != null
                  ? t('bulkAllSelected', { count: selectedCount })
                  : t('bulkAllSelectedUnknown')}
              </span>
              <button
                type="button"
                onClick={clearSelection}
                className="font-semibold underline underline-offset-2 hover:text-indigo-950"
              >
                {t('bulkClearSelection')}
              </button>
            </>
          ) : (
            <>
              <span>{t('bulkPageSelected', { count: selection.included.size })}</span>
              {allPageSelected && total != null && total > selection.included.size ? (
                <button
                  type="button"
                  onClick={selectAllInPool}
                  className="font-semibold underline underline-offset-2 hover:text-indigo-950"
                >
                  {t('bulkSelectAllInPool', { count: total })}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={clearSelection}
                  className="font-semibold underline underline-offset-2 hover:text-indigo-950"
                >
                  {t('bulkClearSelection')}
                </button>
              )}
            </>
          )}
        </div>
      ) : null}

      {/* Pool status + pagination */}
      {showPool && (
        <div className="mt-4 flex flex-col gap-2 text-xs text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <span>
              {poolLoading
                ? t('poolLoading')
                : poolError
                  ? t('poolError')
                  : totalLabel ?? null}
            </span>
            {poolData && debouncedQuery.trim() && !poolData.searchPassedThrough ? (
              <span className="italic">{t('poolSearchLocalNote')}</span>
            ) : null}
            {/* Page-size selector (25 / 50 / 100). */}
            <label className="ml-1 inline-flex items-center gap-1">
              <span>{t('poolPageSizeLabel')}</span>
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value) as PageSize)}
                aria-label={t('poolPageSizeLabel')}
                className="rounded-md border border-zinc-300 bg-white px-1.5 py-0.5 text-xs text-zinc-700 focus:border-zinc-500 focus:outline-none"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage(1)}
              disabled={page <= 1 || poolLoading}
              className="rounded-md border border-zinc-300 px-2.5 py-1 font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
            >
              {t('poolFirst')}
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || poolLoading}
              className="rounded-md border border-zinc-300 px-2.5 py-1 font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
            >
              {t('poolPrev')}
            </button>
            <span>
              {totalPages != null
                ? t('poolPageOf', { page, total: totalPages })
                : t('poolPage', { page })}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={!poolData?.hasNext || poolLoading}
              className="rounded-md border border-zinc-300 px-2.5 py-1 font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
            >
              {t('poolNext')}
            </button>
            <button
              type="button"
              onClick={() => {
                if (totalPages != null) setPage(totalPages);
              }}
              disabled={totalPages == null || page >= totalPages || poolLoading}
              className="rounded-md border border-zinc-300 px-2.5 py-1 font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
            >
              {t('poolLast')}
            </button>
          </div>
        </div>
      )}

      {/* Sticky bulk-action bar — single-pool only (it imports against ONE
          8vance company). Combined "All pools" uses per-row import instead. */}
      {showPool && !allPoolsMode && hasSelection ? (
        <BulkActionBar
          tenantId={activePool}
          q={debouncedQuery.trim()}
          selection={selection}
          selectedCount={selectedCount}
          total={total}
          onDone={refreshAfterImport}
        />
      ) : null}
    </div>
  );
}

/**
 * Sticky bottom bar that runs the bulk import server-side over the active
 * selection. For an explicit ('some') selection we send the included ids
 * (`mode: 'ids'`, capped server-side) and import synchronously. For an
 * all-mode selection we send ONLY the small `excluded` set (`mode: 'all'`); the
 * SERVER pages the whole pool itself and imports in the background — a large
 * all-mode import asks for an explicit confirmation first.
 */
function BulkActionBar({
  tenantId,
  q,
  selection,
  selectedCount,
  total,
  onDone,
}: {
  tenantId: string;
  q: string;
  selection: Selection;
  selectedCount: number | null;
  total: number | null;
  onDone: () => void;
}) {
  const t = useTranslations('candidates');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // A "large" all-mode import (the 20k case) needs an explicit confirm.
  const isAllMode = selection.mode === 'all';
  const needsConfirm = isAllMode;

  // With an unknown total in all-mode there's no number to interpolate —
  // render the standalone "entire pool selected" label instead of stuffing it
  // into `bulkSelectedCount` (which produced "Hele pool geselecteerd
  // geselecteerd").
  const countLabel = selectedCount != null ? String(selectedCount) : isAllMode ? null : '0';

  function runImport() {
    setError(false);
    startTransition(async () => {
      const res = await bulkImportPoolTalentsAction(
        isAllMode
          ? {
              tenantId,
              q: q || undefined,
              mode: 'all',
              excluded: Array.from((selection as { excluded: Set<number> }).excluded),
            }
          : {
              tenantId,
              q: q || undefined,
              mode: 'ids',
              ids: Array.from((selection as { included: Set<number> }).included),
            },
      );
      setConfirming(false);
      if (!res.ok) {
        setError(true);
        return;
      }
      onDone();
    });
  }

  function onClick() {
    if (needsConfirm && !confirming) {
      setConfirming(true);
      return;
    }
    runImport();
  }

  return (
    <div className="sticky bottom-4 z-10 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-300 bg-white px-4 py-3 shadow-lg">
      <div className="text-sm text-zinc-700">
        {confirming && isAllMode && total != null ? (
          <span className="font-medium text-zinc-900">{t('bulkConfirmAll', { count: total })}</span>
        ) : countLabel != null ? (
          <span>{t('bulkSelectedCount', { count: countLabel })}</span>
        ) : (
          <span>{t('bulkAllSelectedUnknown')}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={pending}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50"
          >
            {t('bulkCancel')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClick}
          disabled={pending}
          className="rounded-lg bg-zinc-900 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {error
            ? t('bulkImportError')
            : pending
              ? t('bulkImportWorking')
              : confirming && isAllMode
                ? t('bulkConfirmYes')
                : t('bulkImportSelected')}
        </button>
      </div>
    </div>
  );
}

/** One pool-only talent row with read-through profile + import action. */
function PoolRowItem({
  row,
  tenantId,
  poolName,
  selectable,
  selected,
  onToggle,
  onImported,
}: {
  row: PoolTalentRow;
  tenantId: string;
  /** Source pool name to badge in combined mode; null hides it (single pool). */
  poolName: string | null;
  /** When false (combined "All pools" mode) the bulk-select checkbox is hidden. */
  selectable: boolean;
  selected: boolean;
  onToggle: (checked: boolean) => void;
  onImported: () => void;
}) {
  const t = useTranslations('candidates');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(false);

  function onImport() {
    setError(false);
    startTransition(async () => {
      const res = await importPoolTalentAction({ tenantId, talentId: row.talentId });
      if (!res.ok) {
        setError(true);
        return;
      }
      onImported();
    });
  }

  return (
    <li className="flex items-center justify-between gap-4 px-5 py-4">
      {selectable ? (
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onToggle(e.target.checked)}
          aria-label={t('bulkSelectRow', { name: row.name })}
          className="h-4 w-4 shrink-0 rounded border-zinc-300"
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-zinc-900">{row.name}</div>
        <div className="mt-0.5 truncate text-xs text-zinc-500">
          {row.email ? `${row.email} · ` : ''}
          {t('poolTalentRef', { id: row.talentId })}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <ScopeBadge kind="pool" label={t('scopePool')} />
        {poolName ? (
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600">
            {t('poolBadgeFrom', { pool: poolName })}
          </span>
        ) : null}
        <Link
          href={`/app/candidates/pool/${row.talentId}?tenantId=${tenantId}`}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
        >
          {t('viewProfile')}
        </Link>
        <button
          type="button"
          onClick={onImport}
          disabled={pending}
          className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          title={t('poolImportHint')}
        >
          {error ? t('poolImportError') : pending ? t('poolImportWorking') : t('poolImport')}
        </button>
      </div>
    </li>
  );
}
