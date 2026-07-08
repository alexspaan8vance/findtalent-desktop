'use client';

/**
 * Edit-project form.
 *
 * Single-page editor for an existing project's criteria. It mirrors the create
 * wizard's field UX (the same autocomplete primitive, the same skill-row /
 * language-chip / education-select / min-years controls, the same ref-data
 * endpoints scoped to the project's primary tenant) but as one flat form rather
 * than a stepped wizard — the recruiter already created the project, they just
 * want to change a few criteria.
 *
 * Validation is the create wizard's `createProjectSchema` (minus `pools`),
 * imported read-only so the rules never drift. On submit it calls the
 * org-guarded `updateProjectAction`, which re-validates server-side, clears the
 * pools' 8vance job ids (forcing a fresh job with the new criteria), re-syncs,
 * and we then route to the shortlist where the poller re-matches.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';

import { createProjectSchema } from '../../new/schema';
import { updateProjectAction } from '../actions';
import {
  PoolSelect,
  type PoolTenantOption,
} from '@/components/project/pool-select';

// Leaflet touches `window`, so the map is client-only — dynamic-import it with
// SSR disabled (allowed here because this form is itself a Client Component).
const LocationPickerMap = dynamic(
  () => import('@/components/location-picker-map'),
  { ssr: false },
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export interface EditProjectInitial {
  projectId: string;
  primaryTenantId: string;
  /** All available pools (create-wizard's list) so edit can add/remove. */
  tenantOptions: PoolTenantOption[];
  /** Tenant ids of the project's CURRENT pools (pre-selected). */
  currentPoolIds: string[];
  title: string;
  functionNameId: number | null;
  functionNameLabel: string | null;
  functionLevel: number | null;
  locationCity: string;
  locationCountry: string;
  locationProvince: string | null;
  locationLat: string | null;
  locationLng: string | null;
  skills: SkillRow[];
  languages: LanguageOption[];
  educationLevel: string | null;
}

// Proficiency slider 1..5 → reference ids 23..27 (mirrors the create wizard).
const PROFICIENCY_MIN_ID = 23;
function levelToProficiencyId(level: number): number {
  const clamped = Math.max(1, Math.min(5, Math.round(level)));
  return PROFICIENCY_MIN_ID + (clamped - 1);
}
function proficiencyIdToLevel(id: number): number {
  return Math.max(1, Math.min(5, id - PROFICIENCY_MIN_ID + 1));
}

const MIN_YEARS_OPTIONS = [0, 1, 2, 3, 5, 8, 10] as const;

// ---------------------------------------------------------------------------
// Autocomplete primitive (same behaviour as the create wizard's)
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
  clearOnSelect = false,
}: AutocompleteProps<T>) {
  const id = useId();
  const [input, setInput] = useState<string>(selectedLabel);
  const [items, setItems] = useState<T[]>([]);
  const [open, setOpen] = useState<boolean>(false);
  // Label of the last picked item — a re-echo of it in the field is a completed
  // selection, not a search draft (see `loading` below).
  const [lastPicked, setLastPicked] = useState<string>('');
  // What the debounced fetch last resolved (query + the fetcher it ran
  // against). `loading` is DERIVED from it instead of a setLoading(true) in
  // the fetch effect: a searchable draft the current fetcher hasn't resolved
  // yet is, by definition, loading — covering the debounce window exactly like
  // the old flag did.
  const [resolved, setResolved] = useState<{
    q: string;
    fetcher: (q: string) => Promise<T[]>;
  } | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const skipFetch = useRef<boolean>(false);

  const trimmedInput = input.trim();
  const settled =
    (selectedLabel !== '' && input === selectedLabel) ||
    (lastPicked !== '' && input === lastPicked);
  const loading =
    !settled &&
    trimmedInput.length >= 2 &&
    !(resolved !== null && resolved.q === trimmedInput && resolved.fetcher === fetcher);

  // Reflect a real label (pick / restore) into the field — adjusted during
  // render (React's "adjust state when props change" pattern, not an effect)
  // so the stale text never paints. The empty case is skipped so deselecting
  // (onSelect(null) while the user edits to re-search) doesn't wipe the text
  // they're typing. The fetch effect below treats input === selectedLabel as
  // a completed selection, not a search.
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
    if (q.length < 2) return; // cleared in the input's onChange, not here
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
        if (!ctrl.signal.aborted) setResolved({ q, fetcher });
      }
    }, 220);
    return () => {
      clearTimeout(handle);
      ctrl.abort();
    };
  }, [input, fetcher, selectedLabel]);

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
          if (v.trim().length < 2) setItems([]);
          onSelect(null);
        }}
        onFocus={() => {
          if (items.length > 0) setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
      />
      {open && items.length > 0 ? (
        <ul
          className="absolute left-0 right-0 z-20 mt-1 max-h-72 overflow-auto rounded-lg border border-zinc-300 bg-white shadow-lg"
          style={{ top: 'calc(100% - 4px)' }}
        >
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

async function jsonGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`refdata ${res.status}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Edit form
// ---------------------------------------------------------------------------

export function EditProjectForm({
  initial,
}: {
  initial: EditProjectInitial;
}): React.ReactElement {
  const t = useTranslations('wizard');
  const te = useTranslations('projectEdit');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const primaryTenantId = initial.primaryTenantId;
  const uiLocale = useLocale();
  const initialLocale: SearchLocale = (
    SEARCH_LOCALES as readonly string[]
  ).includes(uiLocale)
    ? (uiLocale as SearchLocale)
    : 'en';
  const [searchLocale, setSearchLocale] = useState<SearchLocale>(initialLocale);

  const refQuery = primaryTenantId
    ? `tenantId=${encodeURIComponent(primaryTenantId)}&locale=${encodeURIComponent(searchLocale)}`
    : `locale=${encodeURIComponent(searchLocale)}`;

  // ------ field state, prefilled from the project ------
  // Pools: pre-selected with the project's current tenants; add/remove (min 1).
  const [selectedPoolIds, setSelectedPoolIds] = useState<string[]>(
    initial.currentPoolIds,
  );
  function togglePool(id: string) {
    setSelectedPoolIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  }
  const [title, setTitle] = useState<string>(initial.title);
  const [functionName, setFunctionName] = useState<FunctionNameOption | null>(
    initial.functionNameId !== null
      ? { id: initial.functionNameId, name: initial.functionNameLabel ?? '' }
      : null,
  );
  const [functionLevels, setFunctionLevels] = useState<FunctionLevelOption[]>(
    [],
  );
  const [functionLevel, setFunctionLevel] = useState<number | null>(
    initial.functionLevel,
  );
  const [minYearsExperience, setMinYearsExperience] = useState<number>(0);
  const [location, setLocation] = useState<LocationOption | null>(
    initial.locationCity
      ? {
          city: initial.locationCity,
          country: initial.locationCountry,
          province: initial.locationProvince ?? undefined,
          latitude: initial.locationLat ?? undefined,
          longitude: initial.locationLng ?? undefined,
        }
      : null,
  );
  const [skills, setSkills] = useState<SkillRow[]>(initial.skills);
  const [languages, setLanguages] = useState<LanguageOption[]>(
    initial.languages,
  );
  const [educationDegrees, setEducationDegrees] = useState<
    EducationDegreeOption[]
  >([]);
  const [educationLevel, setEducationLevel] = useState<string>(
    initial.educationLevel ?? '',
  );

  // ------ ref-data dropdown loads (depend on primary tenant) ------
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

  // ------ autocomplete fetchers ------
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

  const fetchLanguage = useCallback(
    async (q: string) => {
      if (!primaryTenantId) return [];
      const r = await jsonGet<{ results: LanguageOption[] }>(
        `/api/refdata/language?${refQuery}`,
      );
      const rows = r.results ?? [];
      return q.length === 0
        ? rows
        : rows.filter((row) => row.name.toLowerCase().includes(q.toLowerCase()));
    },
    [primaryTenantId, refQuery],
  );

  // ------ skill / language helpers ------
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

  // ------ build the payload + validate (create schema, minus pools) ------
  const payload = useMemo(
    () => ({
      title: title.trim(),
      functionNameId: functionName?.id ?? NaN,
      functionNameLabel: functionName?.name ?? '',
      functionLevel: functionLevel ?? NaN,
      minYearsExperience,
      locationCity: location?.city ?? '',
      locationCountry: location?.country ?? '',
      locationProvince: location?.province || undefined,
      locationLat: location?.latitude || undefined,
      locationLng: location?.longitude || undefined,
      skills,
      languages,
      educationLevel: educationLevel || undefined,
      pools: selectedPoolIds,
    }),
    [
      title,
      functionName,
      functionLevel,
      minYearsExperience,
      location,
      skills,
      languages,
      educationLevel,
      selectedPoolIds,
    ],
  );

  const canSubmit = useMemo(
    () => createProjectSchema.safeParse(payload).success,
    [payload],
  );

  const onSave = useCallback(() => {
    setError(null);
    startTransition(async () => {
      const res = await updateProjectAction(initial.projectId, payload);
      if (res.ok) {
        router.push(`/app/projects/${initial.projectId}/shortlist`);
        router.refresh();
      } else {
        switch (res.reason) {
          case 'precondition':
            setError(res.message ?? te('errorPrecondition'));
            break;
          case 'unavailable':
            setError(te('errorUnavailable'));
            break;
          case 'not_found':
            setError(te('errorNotFound'));
            break;
          default:
            setError(te('errorInternal'));
        }
      }
    });
  }, [initial.projectId, payload, router, te]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end gap-2 text-sm">
        <label htmlFor="ft-edit-search-locale" className="text-zinc-500">
          {t('searchLanguage')}
        </label>
        <select
          id="ft-edit-search-locale"
          value={searchLocale}
          onChange={(e) => setSearchLocale(e.target.value as SearchLocale)}
          className="rounded-md border border-zinc-300 px-2 py-1 text-sm text-zinc-900"
        >
          {SEARCH_LOCALES.map((l) => (
            <option key={l} value={l}>
              {SEARCH_LOCALE_LABELS[l]}
            </option>
          ))}
        </select>
      </div>

      {/* Talent pools (cross-pool matching) */}
      <section className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <PoolSelect
          tenantOptions={initial.tenantOptions}
          selectedPoolIds={selectedPoolIds}
          onToggle={togglePool}
        />
      </section>

      {/* Role */}
      <section className="space-y-5 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div>
          <label
            htmlFor="edit-title"
            className="block text-sm font-medium text-zinc-700"
          >
            {t('projectTitleLabel')}
            <span className="ml-1 text-red-500">*</span>
          </label>
          <input
            id="edit-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('projectTitlePlaceholder')}
            className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
          />
        </div>
        <Autocomplete<FunctionNameOption>
          label={t('functionNameLabel')}
          required
          placeholder={t('functionNamePlaceholder')}
          selectedLabel={functionName?.name ?? ''}
          onSelect={setFunctionName}
          fetcher={fetchFunctionName}
          renderItem={(i) => i.name}
          itemKey={(i) => String(i.id)}
          hint={t('functionNameHint')}
        />
      </section>

      {/* Level + min-years + location */}
      <section className="space-y-5 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div>
          <label
            htmlFor="edit-functionLevel"
            className="block text-sm font-medium text-zinc-700"
          >
            {t('seniorityLabel')}
            <span className="ml-1 text-red-500">*</span>
          </label>
          <select
            id="edit-functionLevel"
            value={functionLevel ?? ''}
            onChange={(e) => setFunctionLevel(Number(e.target.value))}
            className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
          >
            <option value="">{t('seniorityPlaceholder')}</option>
            {/* Keep the current level selectable even before the ref list loads. */}
            {functionLevel !== null &&
            !functionLevels.some((l) => l.id === functionLevel) ? (
              <option value={functionLevel}>{`#${functionLevel}`}</option>
            ) : null}
            {functionLevels.map((lvl) => (
              <option key={lvl.id} value={lvl.id}>
                {lvl.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="edit-minYears"
            className="block text-sm font-medium text-zinc-700"
          >
            {t('minExperienceLabel')}
          </label>
          <select
            id="edit-minYears"
            value={minYearsExperience}
            onChange={(e) => setMinYearsExperience(Number(e.target.value))}
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
            onSelect={setLocation}
            fetcher={fetchLocation}
            renderItem={(i) => `${i.city}, ${i.country}`}
            itemKey={(i) =>
              `${i.id ?? ''}-${i.city}-${i.country}-${i.latitude ?? ''}-${i.longitude ?? ''}`
            }
          />
          <LocationPickerMap
            value={location}
            onChange={setLocation}
            hint={t('mapDragHint')}
            resolveErrorHint={t('mapResolveError')}
          />
        </div>
      </section>

      {/* Skills */}
      <section className="space-y-5 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <Autocomplete<SkillOption>
          label={t('addSkillLabel')}
          placeholder={t('skillPlaceholder')}
          selectedLabel=""
          onSelect={(opt) => addSkill(opt)}
          fetcher={fetchSkill}
          renderItem={(i) => i.name}
          itemKey={(i) => String(i.id)}
          hint={t('skillHint', { count: skills.length })}
          clearOnSelect
        />
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
          {skills.length === 0 ? (
            <li className="p-4 text-sm text-zinc-500">{t('noSkillsYet')}</li>
          ) : null}
          {skills.map((s) => {
            const level = proficiencyIdToLevel(s.proficiency_id);
            return (
              <li
                key={s.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center"
              >
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
                        updateSkill(s.id, {
                          proficiency_id: levelToProficiencyId(
                            Number(e.target.value),
                          ),
                        })
                      }
                      className="w-40"
                      aria-label={t('proficiencyAria', { skill: s.name })}
                    />
                    <span className="text-xs text-zinc-500">
                      {t('skillLevel', { level })}
                    </span>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs text-zinc-700">
                  <input
                    type="checkbox"
                    checked={s.must_have}
                    onChange={(e) =>
                      updateSkill(s.id, { must_have: e.target.checked })
                    }
                  />
                  {t('mustHave')}
                </label>
                <button
                  type="button"
                  onClick={() => removeSkill(s.id)}
                  className="text-xs text-red-600 hover:underline"
                >
                  {t('remove')}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Languages + education */}
      <section className="space-y-5 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <Autocomplete<LanguageOption>
          label={t('languagesLabel')}
          placeholder={t('languagesPlaceholder')}
          selectedLabel=""
          onSelect={(opt) => toggleLanguage(opt)}
          fetcher={fetchLanguage}
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
                onClick={() => toggleLanguage(l)}
                className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
              >
                {l.name} ×
              </button>
            ))}
          </div>
        ) : null}
        <div>
          <label
            htmlFor="edit-educationLevel"
            className="block text-sm font-medium text-zinc-700"
          >
            {t('educationLabel')}
          </label>
          <select
            id="edit-educationLevel"
            value={educationLevel}
            onChange={(e) => setEducationLevel(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
          >
            <option value="">{t('educationNoPreference')}</option>
            {/* Keep the stored degree selectable even before the ref list loads. */}
            {educationLevel &&
            !educationDegrees.some((d) => String(d.id) === educationLevel) ? (
              <option value={educationLevel}>{`#${educationLevel}`}</option>
            ) : null}
            {educationDegrees.map((d) => (
              <option key={d.id} value={String(d.id)}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      </section>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() =>
            router.push(`/app/projects/${initial.projectId}/shortlist`)
          }
          disabled={pending}
          className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
        >
          {te('cancel')}
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!canSubmit || pending}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
        >
          {pending ? te('saving') : te('saveAndRematch')}
        </button>
      </div>
    </div>
  );
}
