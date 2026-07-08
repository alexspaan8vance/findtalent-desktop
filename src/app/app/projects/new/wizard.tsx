'use client';

import {
  useActionState,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocale, useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { z } from 'zod';

import { createProjectAction, type CreateProjectState } from './actions';
import {
  PoolSelect,
  type PoolTenantOption,
} from '@/components/project/pool-select';

// Leaflet touches `window`, so the map is client-only — dynamic-import it with
// SSR disabled (allowed here because this wizard is itself a Client Component).
const LocationPickerMap = dynamic(
  () => import('@/components/location-picker-map'),
  { ssr: false },
);

const initialCreateProjectState: CreateProjectState = { ok: false };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TenantOption = PoolTenantOption;

/** Search languages offered in the wizard (8vance-indexed reference locales). */
const SEARCH_LOCALES = ['nl', 'en', 'de'] as const;
type SearchLocale = (typeof SEARCH_LOCALES)[number];
const SEARCH_LOCALE_LABELS: Record<SearchLocale, string> = {
  nl: 'Nederlands',
  en: 'English',
  de: 'Deutsch',
};

interface FunctionNameOption {
  id: number;
  name: string;
}

interface FunctionLevelOption {
  id: number;
  name: string;
}

interface LocationOption {
  id?: number;
  city: string;
  country: string;
  province?: string;
  language_code?: string;
  latitude?: string;
  longitude?: string;
}

interface SkillOption {
  id: number;
  name: string;
}

interface SkillSuggestions {
  soft: SkillOption[];
  hard: SkillOption[];
  knowledge: SkillOption[];
}

type SkillCategoryKey = keyof SkillSuggestions;

/** Stable "nothing exhausted" flags for the keyed `exhausted` derivation. */
const NONE_EXHAUSTED: Readonly<Record<SkillCategoryKey, boolean>> = {
  soft: false,
  hard: false,
  knowledge: false,
};

interface SkillRow {
  id: number;
  name: string;
  proficiency_id: number;
  must_have: boolean;
}

interface LanguageOption {
  id: number;
  name: string;
}

interface EducationDegreeOption {
  id: number;
  name: string;
}

// Proficiency slider 1..5 → reference ids 23..27.
const PROFICIENCY_MIN_ID = 23;
const PROFICIENCY_MAX_ID = 27;
function levelToProficiencyId(level: number): number {
  const clamped = Math.max(1, Math.min(5, Math.round(level)));
  return PROFICIENCY_MIN_ID + (clamped - 1);
}
function proficiencyIdToLevel(id: number): number {
  return Math.max(1, Math.min(5, id - PROFICIENCY_MIN_ID + 1));
}

// ---------------------------------------------------------------------------
// Step schemas (used to enable/disable "Next")
// ---------------------------------------------------------------------------

const step0Schema = z.object({
  pools: z.array(z.string().min(1)).min(1),
});

const step1Schema = z.object({
  title: z.string().min(2),
  functionNameId: z.number().int().positive(),
  functionNameLabel: z.string().min(1),
});

const step2Schema = z.object({
  functionLevel: z.number().int().min(1),
  locationCity: z.string().min(1),
  locationCountry: z.string().min(1),
});

// Optional "minimum years of experience" presets offered on the role/level
// step. 0 = "no minimum"; "10+" maps to 10. Stored as a number and threaded
// into the immediate match only (no schema column — see actions.ts).
const MIN_YEARS_OPTIONS = [0, 1, 2, 3, 5, 8, 10] as const;

const step3Schema = z.object({
  skills: z
    .array(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1),
        proficiency_id: z.number().int().min(23).max(27),
        must_have: z.boolean(),
      }),
    )
    .min(3)
    .max(20),
});

const step4Schema = z.object({
  languages: z.array(z.object({ id: z.number().int(), name: z.string() })),
  educationLevel: z.string().optional().nullable(),
});

// Keep the PROFICIENCY_MAX_ID export honest (used for slider end). Avoid an
// unused-var lint by referencing it explicitly.
void PROFICIENCY_MAX_ID;

// ---------------------------------------------------------------------------
// Autocomplete primitive
// ---------------------------------------------------------------------------

interface AutocompleteProps<T> {
  label: string;
  placeholder?: string;
  selectedLabel: string;
  onSelect: (item: T | null) => void;
  fetcher: (q: string) => Promise<T[]>;
  renderItem: (item: T) => string;
  itemKey: (item: T) => string;
  required?: boolean;
  hint?: string;
  /**
   * When true, focusing the (empty) field fetches a default list of platform
   * suggestions and opens the dropdown — no typing required. Typing still
   * narrows. Used for skills.
   */
  suggestOnFocus?: boolean;
  /**
   * Multi-add fields (skills) clear the input after each pick so the user can
   * immediately search/add the next one without manually deleting the query.
   */
  clearOnSelect?: boolean;
}

function Autocomplete<T>({
  label,
  placeholder,
  selectedLabel,
  onSelect,
  fetcher,
  renderItem,
  itemKey,
  required,
  hint,
  suggestOnFocus = false,
  clearOnSelect = false,
}: AutocompleteProps<T>) {
  const id = useId();
  const [input, setInput] = useState<string>(selectedLabel);
  const [items, setItems] = useState<T[]>([]);
  const [open, setOpen] = useState<boolean>(false);
  // Flips on first focus so empty-query suggestions only fire after the user
  // interacts (not on mount).
  const [touched, setTouched] = useState<boolean>(false);
  // Bumped on each focus so empty-query suggestions re-fetch even after a pick
  // cleared the list.
  const [focusNonce, setFocusNonce] = useState<number>(0);
  // Label of the last picked item — a re-echo of it in the field is a completed
  // selection, not a search draft (see `loading` below).
  const [lastPicked, setLastPicked] = useState<string>('');
  // What the debounced fetch last resolved (query + fetcher + focus round).
  // `loading` is DERIVED from it instead of a setLoading(true) in the fetch
  // effect: a searchable draft the current fetcher hasn't resolved yet is, by
  // definition, loading — covering the debounce window exactly like the old
  // flag did.
  const [resolved, setResolved] = useState<{
    q: string;
    fetcher: (q: string) => Promise<T[]>;
    nonce: number;
  } | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  // After a selection (or a programmatic label restore) the input value
  // changes — suppress the next fetch so the dropdown doesn't re-open.
  const skipFetch = useRef<boolean>(false);

  const trimmedInput = input.trim();
  const settled =
    (selectedLabel !== '' && input === selectedLabel) ||
    (lastPicked !== '' && input === lastPicked);
  // Empty-query suggest round (suggestOnFocus): loading until the CURRENT
  // focus round resolved. Typed query: loading until (q, fetcher) resolved.
  const emptySuggest = suggestOnFocus && touched && trimmedInput === '';
  const loading =
    !settled &&
    (emptySuggest
      ? resolved === null || resolved.nonce !== focusNonce || resolved.fetcher !== fetcher
      : trimmedInput.length >= 2 &&
        !(resolved !== null && resolved.q === trimmedInput && resolved.fetcher === fetcher));

  // Reflect a real label (pick / draft restore) into the field — adjusted
  // during render (React's "adjust state when props change" pattern, not an
  // effect) so the stale text never paints. The empty case is skipped so
  // deselecting (onSelect(null) while the user edits to re-search) doesn't
  // wipe the text they're typing. The fetch effect below treats
  // input === selectedLabel as a completed selection, not a search.
  const [prevSelectedLabel, setPrevSelectedLabel] = useState<string>(selectedLabel);
  if (selectedLabel !== prevSelectedLabel) {
    setPrevSelectedLabel(selectedLabel);
    if (selectedLabel !== '') setInput(selectedLabel);
  }

  useEffect(() => {
    // A programmatic input change — a pick (skipFetch) or a label restore
    // (input === selectedLabel) — is not a search: close the dropdown instead
    // of fetching for it.
    if (skipFetch.current || (selectedLabel !== '' && input === selectedLabel)) {
      skipFetch.current = false;
      setItems([]);
      setOpen(false);
      return;
    }
    const q = input.trim();
    // suggestOnFocus: once focused, an empty query is allowed (default list).
    const minLen = suggestOnFocus && touched ? 0 : 2;
    if (q.length < minLen || q.length === 1) return; // cleared in onChange, not here
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    const handle = setTimeout(async () => {
      try {
        const next = await fetcher(q);
        if (!ctrl.signal.aborted) {
          setItems(next);
          setOpen(true);
        }
      } catch {
        if (!ctrl.signal.aborted) setItems([]);
      } finally {
        if (!ctrl.signal.aborted) setResolved({ q, fetcher, nonce: focusNonce });
      }
    }, 220);
    return () => {
      clearTimeout(handle);
      ctrl.abort();
    };
  }, [input, fetcher, touched, suggestOnFocus, focusNonce, selectedLabel]);

  return (
    <div className="relative">
      <label htmlFor={id} className="block text-sm font-medium text-zinc-700">
        {label}
        {required ? <span className="ml-1 text-red-500">*</span> : null}
      </label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        placeholder={placeholder}
        value={input}
        onChange={(e) => {
          const v = e.target.value;
          setInput(v);
          // Too short to search: drop stale results here (in the handler, not
          // the fetch effect) so the dropdown never shows them.
          const minLen = suggestOnFocus && touched ? 0 : 2;
          if (v.trim().length < minLen || v.trim().length === 1) setItems([]);
          onSelect(null);
        }}
        onFocus={() => {
          if (suggestOnFocus) {
            if (!touched) setTouched(true);
            if (input.trim() === '') setFocusNonce((n) => n + 1);
          }
          if (items.length > 0) setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
      />
      {open && items.length > 0 ? (
        <ul className="absolute left-0 right-0 z-20 mt-1 max-h-72 overflow-auto rounded-lg border border-zinc-300 bg-white shadow-lg"
            style={{ top: 'calc(100% - 4px)' }}>
          {items.map((item) => (
            <li
              key={itemKey(item)}
              className="cursor-pointer px-3 py-2 text-sm hover:bg-zinc-100"
              onMouseDown={(e) => {
                e.preventDefault();
                skipFetch.current = true;
                onSelect(item);
                setInput(clearOnSelect ? '' : renderItem(item));
                setLastPicked(clearOnSelect ? '' : renderItem(item));
                setItems([]);
                setOpen(false);
              }}
            >
              {renderItem(item)}
            </li>
          ))}
        </ul>
      ) : null}
      {loading ? (
        <span className="pointer-events-none absolute right-3 top-9 text-xs text-zinc-500">
          ...
        </span>
      ) : null}
      {hint ? <p className="mt-1 text-xs text-zinc-500">{hint}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny typed fetch helper
// ---------------------------------------------------------------------------

async function jsonGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`refdata ${res.status}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

// Step label i18n keys (index === step). Length drives nav logic.
const STEP_KEYS = [
  'stepPools',
  'stepRole',
  'stepLocation',
  'stepSkills',
  'stepProfile',
] as const;
const STEP_COUNT = STEP_KEYS.length;

export function Wizard() {
  const t = useTranslations('wizard');
  const [state, formAction, pending] = useActionState<
    CreateProjectState,
    FormData
  >(createProjectAction, initialCreateProjectState);

  const [step, setStep] = useState<number>(0);

  // Step 0: pools
  const [tenantOptions, setTenantOptions] = useState<TenantOption[]>([]);
  const [selectedPoolIds, setSelectedPoolIds] = useState<string[]>([]);

  // Step 1: title + function name
  const [title, setTitle] = useState<string>('');
  const [functionName, setFunctionName] = useState<FunctionNameOption | null>(
    null,
  );

  // Step 2: function level + location
  const [functionLevels, setFunctionLevels] = useState<FunctionLevelOption[]>(
    [],
  );
  const [functionLevel, setFunctionLevel] = useState<number | null>(null);
  const [location, setLocation] = useState<LocationOption | null>(null);
  // Optional minimum years of experience (0 = no minimum). In-memory only —
  // threaded into the immediate match, not persisted (see actions.ts).
  const [minYearsExperience, setMinYearsExperience] = useState<number>(0);

  // Step 3: skills
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [skillSuggestions, setSkillSuggestions] = useState<SkillSuggestions>({
    soft: [],
    hard: [],
    knowledge: [],
  });
  // Resolution marker for the suggestions fetch — `suggestionsLoading` is
  // DERIVED from it further down (once the request key exists) instead of a
  // setState-at-fetch-start inside the effect.
  const [resolvedSuggestionsKey, setResolvedSuggestionsKey] = useState<string>('');
  // Per-category "+ 5 more" in-flight flags (independent of the initial load).
  const [moreLoading, setMoreLoading] = useState<Record<SkillCategoryKey, boolean>>({
    soft: false,
    hard: false,
    knowledge: false,
  });
  // Per-category "no more suggestions" — set when a "+5 more" fetch comes back
  // empty so we hide the button instead of leaving a dead one. Keyed on the
  // suggestions request so a NEW seed/locale starts un-exhausted without an
  // effect having to reset it.
  const [exhaustedFor, setExhaustedFor] = useState<{
    key: string;
    flags: Readonly<Record<SkillCategoryKey, boolean>>;
  }>({ key: '', flags: NONE_EXHAUSTED });
  // Rolling prefetch buffer: the NEXT round per category is fetched eagerly so a
  // "+5 more" click can append instantly (no spinner) instead of waiting on the
  // network. Lives in a ref (mutated by background prefetch) AND mirrored into
  // state (`stagedReady`) so the on-click handler can decide instant-vs-fallback
  // without re-rendering on every prefetch. Per-category in-flight guards stop
  // duplicate prefetches.
  const stagedBufferRef = useRef<Record<SkillCategoryKey, SkillOption[]>>({
    soft: [],
    hard: [],
    knowledge: [],
  });
  const stagePrefetchingRef = useRef<Record<SkillCategoryKey, boolean>>({
    soft: false,
    hard: false,
    knowledge: false,
  });
  const [stagedReady, setStagedReady] = useState<Record<SkillCategoryKey, boolean>>({
    soft: false,
    hard: false,
    knowledge: false,
  });
  // Min-reveal gate: stays true until BOTH the data resolved AND a ~900ms floor
  // elapsed, so the skeleton is always shown long enough to read as "working".
  const [revealReady, setRevealReady] = useState<boolean>(false);
  // Bumps each time the Skills step is (re)entered so the stagger animation
  // replays and effect timers reset cleanly.
  const revealNonceRef = useRef<number>(0);

  // Step 4: languages + education
  const [languages, setLanguages] = useState<LanguageOption[]>([]);
  const [educationDegrees, setEducationDegrees] = useState<
    EducationDegreeOption[]
  >([]);
  const [educationLevel, setEducationLevel] = useState<string>('');

  // ------------------------------------------------------------------------
  // Draft persistence — survive an accidental reload mid-wizard.
  // ------------------------------------------------------------------------
  const DRAFT_KEY = 'ft-wizard-draft';
  const restored = useRef(false);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as Partial<{
        step: number;
        selectedPoolIds: string[];
        title: string;
        functionName: FunctionNameOption | null;
        functionLevel: number | null;
        minYearsExperience: number;
        location: LocationOption | null;
        skills: SkillRow[];
        languages: LanguageOption[];
        educationLevel: string;
      }>;
      // Intentional external-store hydration: the sessionStorage draft can only
      // be read post-mount (reading it in initializers would mismatch SSR).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (Array.isArray(d.selectedPoolIds)) setSelectedPoolIds(d.selectedPoolIds);
      if (typeof d.title === 'string') setTitle(d.title);
      if (d.functionName) setFunctionName(d.functionName);
      if (typeof d.functionLevel === 'number') setFunctionLevel(d.functionLevel);
      if (typeof d.minYearsExperience === 'number') setMinYearsExperience(d.minYearsExperience);
      if (d.location) setLocation(d.location);
      if (Array.isArray(d.skills)) setSkills(d.skills);
      if (Array.isArray(d.languages)) setLanguages(d.languages);
      if (typeof d.educationLevel === 'string') setEducationLevel(d.educationLevel);
      if (typeof d.step === 'number') setStep(d.step);
    } catch {
      /* ignore corrupt draft */
    }
  }, []);

  useEffect(() => {
    if (!restored.current) return;
    try {
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          step,
          selectedPoolIds,
          title,
          functionName,
          functionLevel,
          minYearsExperience,
          location,
          skills,
          languages,
          educationLevel,
        }),
      );
    } catch {
      /* sessionStorage unavailable — non-fatal */
    }
  }, [step, selectedPoolIds, title, functionName, functionLevel, minYearsExperience, location, skills, languages, educationLevel]);

  const writeDraft = useCallback((): void => {
    try {
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          step,
          selectedPoolIds,
          title,
          functionName,
          functionLevel,
          minYearsExperience,
          location,
          skills,
          languages,
          educationLevel,
        }),
      );
    } catch {
      /* sessionStorage unavailable — non-fatal */
    }
  }, [step, selectedPoolIds, title, functionName, functionLevel, minYearsExperience, location, skills, languages, educationLevel]);

  // Tracks that THIS component instance fired a submit, so the draft-restore
  // effect below only reacts to an error result produced by our own submit.
  const submitted = useRef(false);

  // Clear the draft optimistically at submit time. On success the server action
  // redirect()s away (it never returns `ok: true`), so the draft stays cleared
  // — no stale wizard state lingers for the next visit. On error the result
  // watcher below RE-WRITES the draft so the user keeps all wizard state and can
  // fix + retry. Clearing + restore are paired around the action result, which
  // is why we no longer clear unconditionally on `onSubmit` like before.
  const onSubmitClear = useCallback((): void => {
    submitted.current = true;
    clearDraftStorage();
  }, []);

  function clearDraftStorage(): void {
    try {
      sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
  }

  // Result watcher: a returned error state means the redirect did NOT happen,
  // so restore the draft we cleared on submit. A success (`ok`) keeps it clear.
  useEffect(() => {
    if (!submitted.current) return;
    if (state.error) {
      writeDraft();
    } else if (state.ok) {
      clearDraftStorage();
    }
  }, [state.error, state.ok, writeDraft]);

  // ------------------------------------------------------------------------
  // Pool list + the "primary" tenant used to scope ref-data autocomplete
  // ------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await jsonGet<{ results: TenantOption[] }>(
          '/api/tenants/list',
        );
        if (!cancelled) setTenantOptions(list.results ?? []);
      } catch {
        if (!cancelled) setTenantOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Reference data is largely shared between 8vance companies, so use the
  // first selected pool's tenant for autocomplete calls.
  const primaryTenantId = selectedPoolIds[0] ?? '';
  const uiLocale = useLocale();

  // Search language for the wizard's reference dropdowns. Defaults to the
  // selected pool's admin-configured language; the customer may override it.
  // (Upload happens as-typed — no translation.)
  const initialLocale: SearchLocale = (SEARCH_LOCALES as readonly string[]).includes(uiLocale)
    ? (uiLocale as SearchLocale)
    : 'en';
  const [searchLocale, setSearchLocale] = useState<SearchLocale>(initialLocale);
  // State (not a ref): read during the render-phase adjustment below.
  const [localeTouched, setLocaleTouched] = useState(false);

  // When the primary pool changes, snap the search language to that pool's
  // default — unless the customer already picked one manually. Adjusted during
  // render (prev-value comparison — React's "adjust state when props change"
  // pattern) instead of a setState-in-effect.
  const primaryPool = tenantOptions.find((tp) => tp.id === primaryTenantId);
  const poolDefaultLocale = primaryPool?.defaultLocale;
  const [prevPoolDefaultLocale, setPrevPoolDefaultLocale] = useState(poolDefaultLocale);
  if (poolDefaultLocale !== prevPoolDefaultLocale) {
    setPrevPoolDefaultLocale(poolDefaultLocale);
    if (
      !localeTouched &&
      poolDefaultLocale &&
      (SEARCH_LOCALES as readonly string[]).includes(poolDefaultLocale)
    ) {
      setSearchLocale(poolDefaultLocale as SearchLocale);
    }
  }

  const refQuery = primaryTenantId
    ? `tenantId=${encodeURIComponent(primaryTenantId)}&locale=${encodeURIComponent(searchLocale)}`
    : `locale=${encodeURIComponent(searchLocale)}`;

  // Default the required-languages to Dutch (the common case for this market),
  // once, after a primary pool is picked — mirroring the candidate wizard. It's
  // pre-added like any other language so the recruiter can delete it; we only
  // add it when the list is still empty (never clobber a restored draft or a
  // manually-picked language). /api/refdata/language needs a tenant, so we wait.
  const dutchDefaulted = useRef(false);
  useEffect(() => {
    if (dutchDefaulted.current || !primaryTenantId) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await jsonGet<{ results: LanguageOption[] }>(
          `/api/refdata/language?tenantId=${encodeURIComponent(primaryTenantId)}`,
        );
        if (cancelled) return;
        dutchDefaulted.current = true;
        // Prefer the EXACT "Dutch"/"Nederlands" row — the 8vance list also has
        // variants ("Dutch Low Saxon", "Dutch, Middle …") a bare contains-match
        // would grab first.
        const rows = r.results ?? [];
        const norm = (s: string) => s.trim().toLowerCase();
        const dutch =
          rows.find((l) => norm(l.name) === 'dutch' || norm(l.name) === 'nederlands') ??
          rows.find((l) => /^(nederlands|dutch)\b/i.test(l.name.trim())) ??
          rows.find((l) => /nederlands|dutch/i.test(l.name));
        if (!dutch) return;
        setLanguages((prev) => (prev.length === 0 ? [{ id: dutch.id, name: dutch.name }] : prev));
      } catch {
        /* non-fatal: skip the default (retries on next tenant change) */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [primaryTenantId]);

  // ------------------------------------------------------------------------
  // Initial loads for reference dropdowns (depend on primary tenant)
  // ------------------------------------------------------------------------

  // (When the LAST pool is deselected these lists are cleared in togglePool —
  // the handler where that transition happens — so the effects below never set
  // state synchronously.)
  useEffect(() => {
    if (!primaryTenantId) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await jsonGet<{ results: FunctionLevelOption[] }>(
          `/api/refdata/function-level?${refQuery}`,
        );
        if (!cancelled) setFunctionLevels(list.results ?? []);
      } catch {
        if (!cancelled) setFunctionLevels([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [primaryTenantId, refQuery]);

  useEffect(() => {
    if (!primaryTenantId) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await jsonGet<{ results: EducationDegreeOption[] }>(
          `/api/refdata/education-degree?${refQuery}`,
        );
        if (!cancelled) setEducationDegrees(list.results ?? []);
      } catch {
        if (!cancelled) setEducationDegrees([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [primaryTenantId, refQuery]);

  // ------------------------------------------------------------------------
  // Autocomplete fetchers (memoised so Autocomplete effect deps are stable)
  // ------------------------------------------------------------------------

  const fetchFunctionName = useCallback(
    async (q: string) => {
      if (!primaryTenantId) return [];
      const r = await jsonGet<{ results: FunctionNameOption[] }>(
        `/api/refdata/function-name?${refQuery}&q=${encodeURIComponent(q)}`,
      );
      return r.results ?? [];
    },
    [primaryTenantId, refQuery],
  );

  const fetchLocation = useCallback(
    async (q: string) => {
      if (!primaryTenantId) return [];
      const r = await jsonGet<{ results: LocationOption[] }>(
        `/api/refdata/location?${refQuery}&q=${encodeURIComponent(q)}`,
      );
      return r.results ?? [];
    },
    [primaryTenantId, refQuery],
  );

  // Skill search field (type-to-search for anything not in the tile grid).
  const fetchSkill = useCallback(
    async (q: string) => {
      if (!primaryTenantId) return [];
      const typed = q.trim();
      if (typed.length < 2) return [];
      const r = await jsonGet<{ results: SkillOption[] }>(
        `/api/refdata/skill?${refQuery}&q=${encodeURIComponent(typed)}`,
      );
      return r.results ?? [];
    },
    [primaryTenantId, refQuery],
  );

  // Role-relevant skill suggestions (tile grid), seeded from the chosen role
  // AND the project title so we catch more relevant hard skills/knowledge.
  const skillSeed = [functionName?.name, title]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ');
  // Request key (tenant/locale/seed) for the suggestions fetch. Loading is
  // DERIVED — a wanted request the effect below hasn't resolved yet is loading
  // — instead of a setState at fetch start.
  const suggestionsKey =
    primaryTenantId && skillSeed ? `${refQuery}|${skillSeed}` : '';
  const suggestionsLoading =
    step >= 2 && suggestionsKey !== '' && resolvedSuggestionsKey !== suggestionsKey;
  // The exhausted flags only apply to the request they were computed for.
  const exhausted =
    exhaustedFor.key === suggestionsKey ? exhaustedFor.flags : NONE_EXHAUSTED;
  useEffect(() => {
    // Prefetch from step 2 (Location) onward: by step 2 the role + title are
    // locked, so we warm the skill-suggestions (server LRU-cached) while the
    // user fills location/level — they're ready (instant) by the Skills step.
    if (step < 2 || !primaryTenantId || !skillSeed) return;
    let cancelled = false;
    // A fresh request invalidates any staged round — clear the buffer + guards
    // (refs) so we don't append stale tiles from a previous role. `exhausted`
    // is keyed on the request instead of being reset here; `moreLoading` is a
    // transient per-click flag whose own finally always clears it.
    stagedBufferRef.current = { soft: [], hard: [], knowledge: [] };
    stagePrefetchingRef.current = { soft: false, hard: false, knowledge: false };
    void (async () => {
      try {
        const r = await jsonGet<{ results: SkillSuggestions }>(
          `/api/refdata/skill-suggestions?${refQuery}&seed=${encodeURIComponent(skillSeed)}`,
        );
        if (!cancelled) {
          setSkillSuggestions(
            r.results ?? { soft: [], hard: [], knowledge: [] },
          );
          setResolvedSuggestionsKey(suggestionsKey);
        }
      } catch {
        if (!cancelled) {
          setSkillSuggestions({ soft: [], hard: [], knowledge: [] });
          setResolvedSuggestionsKey(suggestionsKey);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, primaryTenantId, refQuery, skillSeed, suggestionsKey]);

  // Low-level: fetch the NEXT distinct batch for one bucket. `extraExclude`
  // lets a rolling prefetch also exclude the round it's staging-after so two
  // rounds never overlap. Returns [] on any error (non-fatal).
  const fetchNextBatch = useCallback(
    async (
      category: SkillCategoryKey,
      shownIds: number[],
      extraExclude: number[] = [],
    ): Promise<SkillOption[]> => {
      if (!primaryTenantId || !skillSeed) return [];
      const added = skills.map((s) => s.id);
      const exclude = Array.from(
        new Set([...shownIds, ...added, ...extraExclude]),
      ).join(',');
      try {
        const r = await jsonGet<{ results: SkillSuggestions }>(
          `/api/refdata/skill-suggestions?${refQuery}` +
            `&seed=${encodeURIComponent(skillSeed)}` +
            `&category=${encodeURIComponent(category)}` +
            `&exclude=${encodeURIComponent(exclude)}`,
        );
        return r.results?.[category] ?? [];
      } catch {
        return [];
      }
    },
    [primaryTenantId, refQuery, skillSeed, skills],
  );

  // Rolling prefetch: stage the round AFTER what's currently shown for a
  // category, so the next "+5 more" click can append instantly. Guarded so we
  // never run two prefetches for the same bucket. `shownIds` is the set already
  // visible; the staged batch excludes both the shown ids and anything already
  // sitting in the buffer.
  const prefetchNextRound = useCallback(
    async (category: SkillCategoryKey, shownIds: number[]) => {
      if (!primaryTenantId || !skillSeed) return;
      if (stagePrefetchingRef.current[category]) return;
      if (stagedBufferRef.current[category].length > 0) return;
      stagePrefetchingRef.current[category] = true;
      try {
        const fresh = await fetchNextBatch(category, shownIds);
        const seen = new Set(shownIds);
        const staged: SkillOption[] = [];
        for (const opt of fresh) {
          if (!seen.has(opt.id)) {
            seen.add(opt.id);
            staged.push(opt);
          }
        }
        stagedBufferRef.current[category] = staged;
        setStagedReady((s) => ({ ...s, [category]: staged.length > 0 }));
      } finally {
        stagePrefetchingRef.current[category] = false;
      }
    },
    [primaryTenantId, skillSeed, fetchNextBatch],
  );

  // Append a batch to a bucket (de-duped) and return the merged ids so the
  // caller can stage the following round against them.
  const appendBatch = useCallback(
    (category: SkillCategoryKey, batch: SkillOption[]): number[] => {
      let mergedIds: number[] = [];
      setSkillSuggestions((prev) => {
        const seen = new Set(prev[category].map((s) => s.id));
        const merged = [...prev[category]];
        for (const opt of batch) {
          if (!seen.has(opt.id)) {
            seen.add(opt.id);
            merged.push(opt);
          }
        }
        mergedIds = merged.map((s) => s.id);
        return { ...prev, [category]: merged };
      });
      return mergedIds;
    },
    [],
  );

  // "+ 5 more": serve the STAGED batch instantly when ready (no spinner), then
  // immediately stage the following round. If nothing is staged yet (click beat
  // the prefetch), fall back to an on-click fetch with the `moreLoading`
  // spinner — and stage the next round once that lands.
  const loadMoreSuggestions = useCallback(
    async (category: SkillCategoryKey) => {
      if (!primaryTenantId) return;
      const staged = stagedBufferRef.current[category];
      if (staged.length > 0) {
        // Instant path — consume the buffer, then refill it (round N+1).
        stagedBufferRef.current[category] = [];
        setStagedReady((s) => ({ ...s, [category]: false }));
        const mergedIds = appendBatch(category, staged);
        void prefetchNextRound(category, mergedIds);
        return;
      }
      // Fallback path — fetch synchronously with the spinner.
      setMoreLoading((m) => ({ ...m, [category]: true }));
      try {
        const shown = skillSuggestions[category].map((s) => s.id);
        const fresh = await fetchNextBatch(category, shown);
        if (fresh.length > 0) {
          const mergedIds = appendBatch(category, fresh);
          void prefetchNextRound(category, mergedIds);
        } else {
          // No further distinct suggestions for this bucket — hide the button.
          // Keyed on the current request; flags for an older seed are ignored.
          setExhaustedFor((prev) => ({
            key: suggestionsKey,
            flags: {
              ...(prev.key === suggestionsKey ? prev.flags : NONE_EXHAUSTED),
              [category]: true,
            },
          }));
        }
      } finally {
        setMoreLoading((m) => ({ ...m, [category]: false }));
      }
    },
    [
      primaryTenantId,
      skillSuggestions,
      fetchNextBatch,
      appendBatch,
      prefetchNextRound,
      suggestionsKey,
    ],
  );

  // ------------------------------------------------------------------------
  // Skills step: staged reveal (min skeleton floor) + initial rolling prefetch
  // ------------------------------------------------------------------------

  // Minimum staged reveal. Even when the data is prefetched/LRU-cached, hold the
  // skeleton for a ~900ms floor so the step never "pops in" fully formed — it
  // visibly works, then streams the tiles in. We gate `revealReady` on BOTH the
  // data being resolved (`!suggestionsLoading`) AND the floor having elapsed; we
  // do NOT delay real data beyond the floor.
  const MIN_REVEAL_MS = 900;
  // `revealReady` is reset to false in the EVENT HANDLERS where a reveal round
  // starts over (the Back/Continue buttons and the search-language switch), so
  // this effect only arms the floor timer — no synchronous setState.
  useEffect(() => {
    if (step !== 3) return;
    // (Re)entering the Skills step or new data landing: replay the stagger.
    revealNonceRef.current += 1;
    // While the data is still loading there is nothing to reveal yet — the
    // re-run on `suggestionsLoading` flipping false starts the full floor.
    if (suggestionsLoading) return;
    const timer = setTimeout(() => setRevealReady(true), MIN_REVEAL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [step, suggestionsLoading]);

  // Once tiles are revealed on the Skills step, eagerly stage round 2 per
  // category so the first "+5 more" per bucket is instant.
  useEffect(() => {
    if (step !== 3 || !revealReady) return;
    (['soft', 'hard', 'knowledge'] as SkillCategoryKey[]).forEach((cat) => {
      const shown = skillSuggestions[cat].map((s) => s.id);
      if (shown.length > 0) void prefetchNextRound(cat, shown);
    });
  }, [step, revealReady, skillSuggestions, prefetchNextRound]);

  const fetchLanguage = useCallback(
    async (q: string) => {
      if (!primaryTenantId) return [];
      const r = await jsonGet<{ results: LanguageOption[] }>(
        `/api/refdata/language?${refQuery}`,
      );
      const rows = r.results ?? [];
      return q.length === 0
        ? rows
        : rows.filter((row) =>
            row.name.toLowerCase().includes(q.toLowerCase()),
          );
    },
    [primaryTenantId, refQuery],
  );

  // ------------------------------------------------------------------------
  // Validation per step
  // ------------------------------------------------------------------------

  const canAdvance = useMemo(() => {
    if (step === 0) {
      return step0Schema.safeParse({ pools: selectedPoolIds }).success;
    }
    if (step === 1) {
      return step1Schema.safeParse({
        title,
        functionNameId: functionName?.id ?? -1,
        functionNameLabel: functionName?.name ?? '',
      }).success;
    }
    if (step === 2) {
      return step2Schema.safeParse({
        functionLevel: functionLevel ?? -1,
        locationCity: location?.city ?? '',
        locationCountry: location?.country ?? '',
      }).success;
    }
    if (step === 3) {
      return step3Schema.safeParse({ skills }).success;
    }
    if (step === 4) {
      return step4Schema.safeParse({ languages, educationLevel }).success;
    }
    return false;
  }, [step, selectedPoolIds, title, functionName, functionLevel, location, skills, languages, educationLevel]);

  // ------------------------------------------------------------------------
  // Pool helpers
  // ------------------------------------------------------------------------

  function togglePool(id: string) {
    const next = selectedPoolIds.includes(id)
      ? selectedPoolIds.filter((p) => p !== id)
      : [...selectedPoolIds, id];
    setSelectedPoolIds(next);
    // No pool left → no tenant to fetch refdata for. Drop the stale lists here
    // (the handler where the transition happens) instead of in the fetch
    // effects, which must not set state synchronously.
    if (next.length === 0) {
      setFunctionLevels([]);
      setEducationDegrees([]);
    }
  }

  // ------------------------------------------------------------------------
  // Skill helpers
  // ------------------------------------------------------------------------

  function addSkill(opt: SkillOption | null) {
    if (!opt) return;
    setSkills((prev) => {
      if (prev.some((s) => s.id === opt.id)) return prev;
      if (prev.length >= 20) return prev;
      return [
        ...prev,
        {
          id: opt.id,
          name: opt.name,
          proficiency_id: levelToProficiencyId(3),
          must_have: false,
        },
      ];
    });
  }

  function removeSkill(id: number) {
    setSkills((prev) => prev.filter((s) => s.id !== id));
  }

  function updateSkill(id: number, patch: Partial<SkillRow>) {
    setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function toggleLanguage(opt: LanguageOption | null) {
    if (!opt) return;
    setLanguages((prev) => {
      const exists = prev.some((l) => l.id === opt.id);
      if (exists) return prev.filter((l) => l.id !== opt.id);
      if (prev.length >= 10) return prev;
      return [...prev, { id: opt.id, name: opt.name }];
    });
  }

  // ------------------------------------------------------------------------
  // Submit
  // ------------------------------------------------------------------------

  const canSubmit =
    !!functionName &&
    !!location &&
    functionLevel !== null &&
    selectedPoolIds.length > 0 &&
    canAdvance;

  // ------------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      <StepIndicator step={step} />

      {step >= 1 && step <= 3 ? (
        <div className="flex items-center justify-end gap-2 text-sm">
          <label htmlFor="ft-search-locale" className="text-zinc-500">
            {t('searchLanguage')}
          </label>
          <select
            id="ft-search-locale"
            value={searchLocale}
            onChange={(e) => {
              setLocaleTouched(true);
              setSearchLocale(e.target.value as SearchLocale);
              // A new search language refetches the suggestions — restart the
              // skeleton floor for the fresh reveal round (on the Skills step).
              setRevealReady(false);
            }}
            className="rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-900"
          >
            {SEARCH_LOCALES.map((l) => (
              <option key={l} value={l}>
                {SEARCH_LOCALE_LABELS[l]}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        {step === 0 ? (
          <PoolSelect
            tenantOptions={tenantOptions}
            selectedPoolIds={selectedPoolIds}
            onToggle={togglePool}
          />
        ) : null}
        {step === 1 ? (
          <Step1
            title={title}
            onTitle={setTitle}
            functionName={functionName}
            onFunctionName={setFunctionName}
            fetcher={fetchFunctionName}
          />
        ) : null}
        {step === 2 ? (
          <Step2
            functionLevels={functionLevels}
            functionLevel={functionLevel}
            onFunctionLevel={setFunctionLevel}
            minYearsExperience={minYearsExperience}
            onMinYearsExperience={setMinYearsExperience}
            location={location}
            onLocation={setLocation}
            fetcher={fetchLocation}
          />
        ) : null}
        {step === 3 ? (
          <Step3
            skills={skills}
            onAdd={addSkill}
            onRemove={removeSkill}
            onUpdate={updateSkill}
            fetcher={fetchSkill}
            suggestions={skillSuggestions}
            suggestionsLoading={suggestionsLoading}
            revealReady={revealReady}
            revealNonce={revealNonceRef.current}
            moreLoading={moreLoading}
            exhausted={exhausted}
            onLoadMore={loadMoreSuggestions}
          />
        ) : null}
        {step === 4 ? (
          <Step4
            languages={languages}
            onToggleLanguage={toggleLanguage}
            languageFetcher={fetchLanguage}
            educationDegrees={educationDegrees}
            educationLevel={educationLevel}
            onEducationLevel={setEducationLevel}
          />
        ) : null}
      </section>

      {state.error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.error}
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            // Any step change starts a fresh reveal round on the Skills step.
            setRevealReady(false);
            setStep((s) => Math.max(0, s - 1));
          }}
          disabled={step === 0 || pending}
          className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
        >
          {t('back')}
        </button>

        {step < STEP_COUNT - 1 ? (
          <button
            type="button"
            onClick={() => {
              // Any step change starts a fresh reveal round on the Skills step.
              setRevealReady(false);
              setStep((s) => s + 1);
            }}
            disabled={!canAdvance || pending}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
          >
            {t('continue')}
          </button>
        ) : (
          // Real form so React 19 manages the action transition + pending.
          <form action={formAction} onSubmit={onSubmitClear}>
            <input type="hidden" name="title" value={title} />
            <input type="hidden" name="functionNameId" value={functionName?.id ?? ''} />
            <input type="hidden" name="functionNameLabel" value={functionName?.name ?? ''} />
            <input type="hidden" name="functionLevel" value={functionLevel ?? ''} />
            <input type="hidden" name="minYearsExperience" value={minYearsExperience} />
            <input type="hidden" name="locationCity" value={location?.city ?? ''} />
            <input type="hidden" name="locationCountry" value={location?.country ?? ''} />
            <input type="hidden" name="locationProvince" value={location?.province ?? ''} />
            <input type="hidden" name="locationLat" value={location?.latitude ?? ''} />
            <input type="hidden" name="locationLng" value={location?.longitude ?? ''} />
            <input type="hidden" name="skills" value={JSON.stringify(skills)} />
            <input type="hidden" name="languages" value={JSON.stringify(languages)} />
            <input type="hidden" name="educationLevel" value={educationLevel} />
            <input type="hidden" name="pools" value={JSON.stringify(selectedPoolIds)} />
            <button
              type="submit"
              disabled={!canSubmit || pending}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
            >
              {pending ? t('startingMatch') : t('startMatching')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

function StepIndicator({ step }: { step: number }) {
  const t = useTranslations('wizard');
  return (
    <ol className="flex items-center gap-3 text-sm">
      {STEP_KEYS.map((key, idx) => {
        const active = idx === step;
        const done = idx < step;
        return (
          <li
            key={key}
            className={`flex items-center gap-2 rounded-full px-3 py-1 ${
              active
                ? 'bg-zinc-900 text-white'
                : done
                  ? 'bg-zinc-100 text-zinc-900'
                  : 'text-zinc-400'
            }`}
          >
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                active
                  ? 'bg-white text-zinc-900'
                  : done
                    ? 'bg-zinc-900 text-white'
                    : 'bg-zinc-200 text-zinc-500'
              }`}
            >
              {idx + 1}
            </span>
            {t(key)}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Step bodies
// ---------------------------------------------------------------------------

interface Step1Props {
  title: string;
  onTitle: (v: string) => void;
  functionName: FunctionNameOption | null;
  onFunctionName: (v: FunctionNameOption | null) => void;
  fetcher: (q: string) => Promise<FunctionNameOption[]>;
}

function Step1({
  title,
  onTitle,
  functionName,
  onFunctionName,
  fetcher,
}: Step1Props) {
  const t = useTranslations('wizard');
  return (
    <div className="space-y-5">
      <div>
        <label
          htmlFor="title"
          className="block text-sm font-medium text-zinc-700"
        >
          {t('projectTitleLabel')}<span className="ml-1 text-red-500">*</span>
        </label>
        <input
          id="title"
          name="title"
          type="text"
          required
          value={title}
          onChange={(e) => onTitle(e.target.value)}
          placeholder={t('projectTitlePlaceholder')}
          className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
        />
      </div>
      <Autocomplete<FunctionNameOption>
        label={t('functionNameLabel')}
        required
        placeholder={t('functionNamePlaceholder')}
        selectedLabel={functionName?.name ?? ''}
        onSelect={onFunctionName}
        fetcher={fetcher}
        renderItem={(i) => i.name}
        itemKey={(i) => String(i.id)}
        hint={t('functionNameHint')}
      />
      {functionName && (
        <p className="-mt-1 text-xs font-medium text-[var(--ft-accent-strong)]">
          {t('functionNameResolved', { name: functionName.name })}
        </p>
      )}
    </div>
  );
}

interface Step2Props {
  functionLevels: FunctionLevelOption[];
  functionLevel: number | null;
  onFunctionLevel: (v: number) => void;
  minYearsExperience: number;
  onMinYearsExperience: (v: number) => void;
  location: LocationOption | null;
  onLocation: (v: LocationOption | null) => void;
  fetcher: (q: string) => Promise<LocationOption[]>;
}

function Step2({
  functionLevels,
  functionLevel,
  onFunctionLevel,
  minYearsExperience,
  onMinYearsExperience,
  location,
  onLocation,
  fetcher,
}: Step2Props) {
  const t = useTranslations('wizard');
  return (
    <div className="space-y-5">
      <div>
        <label
          htmlFor="functionLevel"
          className="block text-sm font-medium text-zinc-700"
        >
          {t('seniorityLabel')}<span className="ml-1 text-red-500">*</span>
        </label>
        <select
          id="functionLevel"
          value={functionLevel ?? ''}
          onChange={(e) => onFunctionLevel(Number(e.target.value))}
          className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
        >
          <option value="">{t('seniorityPlaceholder')}</option>
          {functionLevels.map((lvl) => (
            <option key={lvl.id} value={lvl.id}>
              {lvl.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label
          htmlFor="minYearsExperience"
          className="block text-sm font-medium text-zinc-700"
        >
          {t('minExperienceLabel')}
        </label>
        <select
          id="minYearsExperience"
          value={minYearsExperience}
          onChange={(e) => onMinYearsExperience(Number(e.target.value))}
          className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
        >
          {MIN_YEARS_OPTIONS.map((y) => (
            <option key={y} value={y}>
              {y === 0
                ? t('minExperienceNone')
                : y === 10
                  ? t('minExperienceTenPlus')
                  : t('minExperienceYears', { count: y })}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-zinc-500">{t('minExperienceHint')}</p>
      </div>
      <div>
        <Autocomplete<LocationOption>
          label={t('locationLabel')}
          required
          placeholder={t('locationPlaceholder')}
          selectedLabel={
            // Join only the parts that exist so a partial place can never
            // render as a bare ", " in the input.
            location ? [location.city, location.country].filter(Boolean).join(', ') : ''
          }
          onSelect={onLocation}
          fetcher={fetcher}
          renderItem={(i) => `${i.city}, ${i.country}`}
          itemKey={(i) =>
            `${i.id ?? ''}-${i.city}-${i.country}-${i.latitude ?? ''}-${i.longitude ?? ''}`
          }
        />
        <LocationPickerMap
          value={location}
          onChange={onLocation}
          hint={t('mapDragHint')}
          resolveErrorHint={t('mapResolveError')}
        />
      </div>
    </div>
  );
}

interface Step3Props {
  skills: SkillRow[];
  onAdd: (opt: SkillOption | null) => void;
  onRemove: (id: number) => void;
  onUpdate: (id: number, patch: Partial<SkillRow>) => void;
  fetcher: (q: string) => Promise<SkillOption[]>;
  suggestions: SkillSuggestions;
  suggestionsLoading: boolean;
  /** Min-reveal gate: skeleton until both data + ~900ms floor are satisfied. */
  revealReady: boolean;
  /** Bumps per Skills-step entry so the stagger animation replays. */
  revealNonce: number;
  moreLoading: Record<SkillCategoryKey, boolean>;
  exhausted: Record<SkillCategoryKey, boolean>;
  onLoadMore: (category: SkillCategoryKey) => void;
}

/** Shimmering placeholder pills shown while suggestions load. */
function SkillTileSkeleton({ count = 5 }: { count?: number }) {
  // Varied widths so the skeleton reads as "tiles", not a progress bar.
  const widths = ['5rem', '7rem', '4.5rem', '6.5rem', '5.5rem', '4rem'];
  return (
    <div className="mt-2 flex flex-wrap gap-2" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <span
          key={i}
          className="h-8 animate-pulse rounded-full"
          style={{
            width: widths[i % widths.length],
            backgroundColor: 'var(--ft-accent-soft)',
            border: '1px solid var(--ft-accent-line)',
          }}
        />
      ))}
    </div>
  );
}

/** Full skeleton for the three categories (initial load). */
function SuggestionsSkeleton({ labels }: { labels: string[] }) {
  return (
    <div className="mt-3 space-y-4">
      {labels.map((label) => (
        <div key={label}>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
            {label}
          </h3>
          <SkillTileSkeleton />
        </div>
      ))}
    </div>
  );
}

function SkillTileGroup({
  title,
  category,
  items,
  added,
  onAdd,
  onLoadMore,
  loadingMore,
  exhausted = false,
  moreLabel,
  loadingMoreLabel,
  staggerBase = 0,
  staggerNonce = 0,
}: {
  title: string;
  category: SkillCategoryKey;
  items: SkillOption[];
  added: Set<number>;
  onAdd: (opt: SkillOption) => void;
  onLoadMore: (category: SkillCategoryKey) => void;
  loadingMore: boolean;
  exhausted?: boolean;
  moreLabel: string;
  loadingMoreLabel: string;
  /** Cumulative tile index from earlier groups so the stagger reads continuous. */
  staggerBase?: number;
  /** Replays the entrance animation each time the step is (re)entered. */
  staggerNonce?: number;
}) {
  const open = items.filter((i) => !added.has(i.id));
  // Keep the group visible while a "load more" is in flight even if every
  // current tile happens to be added, so the spinner/skeleton has a home.
  if (open.length === 0 && !loadingMore) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {title}
      </h3>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {open.map((i, idx) => (
          <button
            // Nonce in the key forces a remount on step (re)entry so the
            // entrance animation replays from the start.
            key={`${staggerNonce}-${i.id}`}
            type="button"
            onClick={() => onAdd(i)}
            className="ft-tile-in rounded-full border px-3 py-1.5 text-sm text-zinc-800 transition hover:text-white"
            style={{
              borderColor: 'var(--ft-border)',
              backgroundColor: 'var(--ft-surface)',
              // ~40ms apart, continuous across all three groups.
              animationDelay: `${(staggerBase + idx) * 40}ms`,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--ft-accent-strong)';
              e.currentTarget.style.borderColor = 'var(--ft-accent-strong)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--ft-surface)';
              e.currentTarget.style.borderColor = 'var(--ft-border)';
            }}
          >
            + {i.name}
          </button>
        ))}
        {!exhausted && (
          <button
            type="button"
            onClick={() => onLoadMore(category)}
            disabled={loadingMore}
            className="rounded-full border border-dashed px-3 py-1.5 text-sm transition disabled:opacity-50"
            style={{
              borderColor: 'var(--ft-accent-line)',
              color: 'var(--ft-accent-strong)',
              backgroundColor: 'var(--ft-accent-soft)',
            }}
          >
            {loadingMore ? loadingMoreLabel : moreLabel}
          </button>
        )}
      </div>
      {loadingMore ? <SkillTileSkeleton count={3} /> : null}
    </div>
  );
}

function Step3({
  skills,
  onAdd,
  onRemove,
  onUpdate,
  fetcher,
  suggestions,
  suggestionsLoading,
  revealReady,
  revealNonce,
  moreLoading,
  exhausted,
  onLoadMore,
}: Step3Props) {
  const t = useTranslations('wizard');
  const added = new Set(skills.map((s) => s.id));
  const total =
    suggestions.soft.length + suggestions.hard.length + suggestions.knowledge.length;
  const hasOpenSuggestions =
    [...suggestions.soft, ...suggestions.hard, ...suggestions.knowledge].some(
      (i) => !added.has(i.id),
    );
  const anyMoreLoading =
    moreLoading.soft || moreLoading.hard || moreLoading.knowledge;
  // Skeleton shows while loading OR until the min-reveal floor elapses.
  const showSkeleton = suggestionsLoading || !revealReady;
  // Continuous stagger across the three groups: each group's base is the count
  // of open tiles in the groups before it.
  const openCount = (cat: SkillCategoryKey) =>
    suggestions[cat].filter((i) => !added.has(i.id)).length;
  const softBase = 0;
  const hardBase = softBase + openCount('soft');
  const knowledgeBase = hardBase + openCount('hard');
  return (
    <div className="space-y-5">
      {/* Click-to-add suggestion tiles, relevant to the chosen role. */}
      <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-4">
        <p className="text-sm font-medium text-zinc-900">{t('suggestionsHeading')}</p>
        {showSkeleton ? (
          <SuggestionsSkeleton
            labels={[t('softSkills'), t('hardSkills'), t('knowledgeAreas')]}
          />
        ) : (total === 0 || !hasOpenSuggestions) && !anyMoreLoading ? (
          <p className="mt-2 text-xs text-zinc-500">{t('suggestionsEmpty')}</p>
        ) : (
          <div className="mt-3 space-y-4">
            <SkillTileGroup
              title={t('softSkills')}
              category="soft"
              items={suggestions.soft}
              added={added}
              onAdd={onAdd}
              onLoadMore={onLoadMore}
              loadingMore={moreLoading.soft}
              exhausted={exhausted.soft}
              moreLabel={t('loadMore')}
              loadingMoreLabel={t('loadingMore')}
              staggerBase={softBase}
              staggerNonce={revealNonce}
            />
            <SkillTileGroup
              title={t('hardSkills')}
              category="hard"
              items={suggestions.hard}
              added={added}
              onAdd={onAdd}
              onLoadMore={onLoadMore}
              loadingMore={moreLoading.hard}
              exhausted={exhausted.hard}
              moreLabel={t('loadMore')}
              loadingMoreLabel={t('loadingMore')}
              staggerBase={hardBase}
              staggerNonce={revealNonce}
            />
            <SkillTileGroup
              title={t('knowledgeAreas')}
              category="knowledge"
              items={suggestions.knowledge}
              added={added}
              onAdd={onAdd}
              onLoadMore={onLoadMore}
              loadingMore={moreLoading.knowledge}
              exhausted={exhausted.knowledge}
              moreLabel={t('loadMore')}
              loadingMoreLabel={t('loadingMore')}
              staggerBase={knowledgeBase}
              staggerNonce={revealNonce}
            />
          </div>
        )}
      </div>

      <div>
        <Autocomplete<SkillOption>
          label={t('addSkillLabel')}
          placeholder={t('skillPlaceholder')}
          selectedLabel=""
          onSelect={(opt) => onAdd(opt)}
          fetcher={fetcher}
          renderItem={(i) => i.name}
          itemKey={(i) => String(i.id)}
          hint={t('skillHint', { count: skills.length })}
          clearOnSelect
        />
      </div>
      <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
        {skills.length === 0 ? (
          <li className="p-4 text-sm text-zinc-500">{t('noSkillsYet')}</li>
        ) : null}
        {skills.map((s) => {
          const level = proficiencyIdToLevel(s.proficiency_id);
          return (
            <li key={s.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-zinc-900">
                  {s.name}
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <input
                    type="range"
                    min={1}
                    max={5}
                    value={level}
                    onChange={(e) =>
                      onUpdate(s.id, {
                        proficiency_id: levelToProficiencyId(
                          Number(e.target.value),
                        ),
                      })
                    }
                    className="w-40"
                    aria-label={t('proficiencyAria', { skill: s.name })}
                  />
                  <span className="text-xs text-zinc-500">{t('skillLevel', { level })}</span>
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-zinc-700">
                <input
                  type="checkbox"
                  checked={s.must_have}
                  onChange={(e) =>
                    onUpdate(s.id, { must_have: e.target.checked })
                  }
                />
                {t('mustHave')}
              </label>
              <button
                type="button"
                onClick={() => onRemove(s.id)}
                className="text-xs text-red-600 hover:underline"
              >
                {t('remove')}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface Step4Props {
  languages: LanguageOption[];
  onToggleLanguage: (opt: LanguageOption | null) => void;
  languageFetcher: (q: string) => Promise<LanguageOption[]>;
  educationDegrees: EducationDegreeOption[];
  educationLevel: string;
  onEducationLevel: (v: string) => void;
}

function Step4({
  languages,
  onToggleLanguage,
  languageFetcher,
  educationDegrees,
  educationLevel,
  onEducationLevel,
}: Step4Props) {
  const t = useTranslations('wizard');
  return (
    <div className="space-y-5">
      <Autocomplete<LanguageOption>
        label={t('languagesLabel')}
        placeholder={t('languagesPlaceholder')}
        selectedLabel=""
        onSelect={(opt) => onToggleLanguage(opt)}
        fetcher={languageFetcher}
        renderItem={(i) => i.name}
        itemKey={(i) => String(i.id)}
        hint={t('languagesHint')}
      />
      {languages.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {languages.map((l) => (
            <button
              type="button"
              key={l.id}
              onClick={() => onToggleLanguage(l)}
              className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
            >
              {l.name} ×
            </button>
          ))}
        </div>
      ) : null}
      <div>
        <label
          htmlFor="educationLevel"
          className="block text-sm font-medium text-zinc-700"
        >
          {t('educationLabel')}
        </label>
        <select
          id="educationLevel"
          value={educationLevel}
          onChange={(e) => onEducationLevel(e.target.value)}
          className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
        >
          <option value="">{t('educationNoPreference')}</option>
          {educationDegrees.map((d) => (
            <option key={d.id} value={String(d.id)}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
