'use client';

/**
 * Shared building blocks for candidate onboarding — used by both the
 * recruiter-driven wizard (`candidate-wizard.tsx`) and the public self-onboard
 * portal (`/candidate/[token]`). Kept in one module so the two flows stay in
 * lock-step on field shapes, the Autocomplete primitive, and the
 * UI → `TalentCreatePayload` mapping.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import type { OnboardingInput } from '../actions';

// ---------------------------------------------------------------------------
// Constants (single source of truth, mirrored by the server action's zod enums)
// ---------------------------------------------------------------------------

export const CONTRACT_TYPES = ['permanent', 'temporary', 'uitzend', 'interim'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

// Proficiency slider 1..5 → 8vance reference ids 23..27 (same mapping the
// project wizard uses). Level 0 = UNKNOWN (no CV signal / not set): on the
// TALENT side we OMIT proficiency_id entirely so 8vance applies its own default
// instead of us faking a mid-tier 3 — see `levelToProficiencyIdOrUndefined`.
const PROFICIENCY_MIN_ID = 23;
export function levelToProficiencyId(level: number): number {
  const clamped = Math.max(1, Math.min(5, Math.round(level)));
  return PROFICIENCY_MIN_ID + (clamped - 1);
}

/**
 * Like `levelToProficiencyId`, but returns `undefined` for an UNKNOWN level
 * (<= 0) so the candidate-create payload can OMIT proficiency_id (→ 8vance
 * default) rather than fabricate a value. 1..5 map to 23..27 as usual.
 */
export function levelToProficiencyIdOrUndefined(level: number): number | undefined {
  return level >= 1 ? levelToProficiencyId(level) : undefined;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TenantOption {
  id: string;
  slug: string;
  name: string;
  defaultLocale: string;
  /** True for the pool that should be pre-selected during onboarding. */
  isDefault?: boolean;
}

export interface SkillRow {
  id: number; // 8vance skill taxonomy id → maps to `skill`
  name: string;
  level: number; // 1..5
  must_have: boolean;
}

export interface LanguageOption {
  id: number;
  name: string;
}
export type LanguageRow = LanguageOption;

export interface LocationValue {
  id?: number;
  city: string;
  country: string;
  province?: string;
  latitude?: string;
  longitude?: string;
}

// ---------------------------------------------------------------------------
// Typed fetch helper
// ---------------------------------------------------------------------------

export async function jsonGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`refdata ${res.status}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Autocomplete primitive (mirrors the project wizard's behaviour)
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
  disabled?: boolean;
  clearOnSelect?: boolean;
}

export function Autocomplete<T>({
  label,
  placeholder,
  selectedLabel,
  onSelect,
  fetcher,
  renderItem,
  itemKey,
  required,
  hint,
  disabled = false,
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
        disabled={disabled}
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
        className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none disabled:bg-zinc-100 disabled:text-zinc-400"
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

// ---------------------------------------------------------------------------
// Reusable field clusters
// ---------------------------------------------------------------------------

export function SkillList({
  skills,
  onRemove,
  onUpdate,
}: {
  skills: SkillRow[];
  onRemove: (id: number) => void;
  onUpdate: (id: number, patch: Partial<SkillRow>) => void;
}) {
  const t = useTranslations('candidates');
  return (
    <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
      {skills.length === 0 ? (
        <li className="p-4 text-sm text-zinc-500">{t('noSkillsYet')}</li>
      ) : null}
      {skills.map((s) => (
        <li key={s.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-zinc-900">{s.name}</div>
            <div className="mt-2 flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={5}
                value={s.level}
                onChange={(e) => onUpdate(s.id, { level: Number(e.target.value) })}
                className="w-40"
                aria-label={t('proficiencyAria', { skill: s.name })}
              />
              {/* Level 0 = unknown / not set: show a neutral dash instead of a
                  fake "level 0". 1..5 use the existing localized label. */}
              <span className="text-xs text-zinc-500">
                {s.level >= 1 ? t('skillLevel', { level: s.level }) : '—'}
              </span>
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-zinc-700">
            <input
              type="checkbox"
              checked={s.must_have}
              onChange={(e) => onUpdate(s.id, { must_have: e.target.checked })}
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
      ))}
    </ul>
  );
}

export function LocationField({
  label,
  placeholder,
  value,
  onSelect,
  fetcher,
  disabled,
}: {
  label: string;
  placeholder: string;
  value: LocationValue | null;
  onSelect: (v: LocationValue | null) => void;
  fetcher: (q: string) => Promise<LocationValue[]>;
  disabled?: boolean;
}) {
  return (
    <Autocomplete<LocationValue>
      label={label}
      placeholder={placeholder}
      selectedLabel={value ? `${value.city}, ${value.country}` : ''}
      onSelect={onSelect}
      fetcher={fetcher}
      renderItem={(i) => `${i.city}, ${i.country}`}
      itemKey={(i) => `${i.id ?? ''}-${i.city}-${i.country}`}
      disabled={disabled}
    />
  );
}

export function PreferenceControls({ children }: { children: React.ReactNode }) {
  return <div className="space-y-6">{children}</div>;
}

export function ContractTypePicker({
  value,
  onChange,
}: {
  value: ContractType[];
  onChange: (v: ContractType[]) => void;
}) {
  const t = useTranslations('candidates');
  function toggle(c: ContractType) {
    onChange(value.includes(c) ? value.filter((x) => x !== c) : [...value, c]);
  }
  return (
    <fieldset>
      <legend className="text-sm font-medium text-zinc-900">{t('contractTypesLabel')}</legend>
      <div className="mt-3 flex flex-wrap gap-2">
        {CONTRACT_TYPES.map((c) => {
          const on = value.includes(c);
          return (
            <button
              key={c}
              type="button"
              onClick={() => toggle(c)}
              className={`rounded-full border px-3 py-1.5 text-sm ${
                on
                  ? 'border-zinc-900 bg-zinc-900 text-white'
                  : 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50'
              }`}
            >
              {t(`contract_${c}`)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function RadiusSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const t = useTranslations('candidates');
  return (
    <div>
      <label htmlFor="cand-radius" className="block text-sm font-medium text-zinc-900">
        {t('radiusLabel')}
      </label>
      <div className="mt-2 flex items-center gap-3">
        <input
          id="cand-radius"
          type="range"
          min={0}
          // Match honours at most MAX_TRAVEL_KM (100, see
          // lib/candidate/preferences.ts) — a 100..200 slider range would be
          // silently clamped away, so don't offer it.
          max={100}
          step={5}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-56"
        />
        <span className="text-sm text-zinc-600">{t('radiusValue', { km: value })}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Recruiter's head" extra-question controls
// ---------------------------------------------------------------------------

export const WORK_MODES = ['office', 'hybrid', 'remote'] as const;
export type WorkMode = (typeof WORK_MODES)[number];
export const SALARY_PERIODS = ['hour', 'month', 'year'] as const;
export type SalaryPeriod = (typeof SALARY_PERIODS)[number];
export const AVAILABILITIES = [
  'immediate',
  'two_weeks',
  'one_month',
  'two_months',
  'three_plus',
] as const;
export type Availability = (typeof AVAILABILITIES)[number];

/** Segmented single-choice control shared by workMode / availability. */
function Segmented<T extends string>({
  legend,
  options,
  value,
  onChange,
  labelFor,
}: {
  legend: string;
  options: readonly T[];
  value: T | undefined;
  onChange: (v: T | undefined) => void;
  labelFor: (v: T) => string;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-zinc-900">{legend}</legend>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((o) => {
          const on = value === o;
          return (
            <button
              key={o}
              type="button"
              onClick={() => onChange(on ? undefined : o)}
              className={`rounded-full border px-3 py-1.5 text-sm ${
                on
                  ? 'border-zinc-900 bg-zinc-900 text-white'
                  : 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50'
              }`}
            >
              {labelFor(o)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function WorkModePicker({
  value,
  onChange,
}: {
  value: WorkMode | undefined;
  onChange: (v: WorkMode | undefined) => void;
}) {
  const t = useTranslations('candidates');
  return (
    <Segmented
      legend={t('workModeLabel')}
      options={WORK_MODES}
      value={value}
      onChange={onChange}
      labelFor={(v) => t(`workMode_${v}`)}
    />
  );
}

export function AvailabilityPicker({
  value,
  onChange,
}: {
  value: Availability | undefined;
  onChange: (v: Availability | undefined) => void;
}) {
  const t = useTranslations('candidates');
  return (
    <Segmented
      legend={t('availabilityLabel')}
      options={AVAILABILITIES}
      value={value}
      onChange={onChange}
      labelFor={(v) => t(`availability_${v}`)}
    />
  );
}

export function SalaryRange({
  min,
  max,
  period,
  onChange,
}: {
  min: number | undefined;
  max: number | undefined;
  period: SalaryPeriod;
  onChange: (patch: { min?: number; max?: number; period?: SalaryPeriod }) => void;
}) {
  const t = useTranslations('candidates');
  const num = (v: string): number | undefined => {
    const n = Number(v.replace(/[^\d]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return (
    <div>
      <label className="block text-sm font-medium text-zinc-900">{t('salaryLabel')}</label>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="text"
          inputMode="numeric"
          placeholder={t('salaryMinPlaceholder')}
          value={min ?? ''}
          onChange={(e) => onChange({ min: num(e.target.value) })}
          className="w-28 rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
        />
        <span className="text-zinc-400">–</span>
        <input
          type="text"
          inputMode="numeric"
          placeholder={t('salaryMaxPlaceholder')}
          value={max ?? ''}
          onChange={(e) => onChange({ max: num(e.target.value) })}
          className="w-28 rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
        />
        <select
          value={period}
          onChange={(e) => onChange({ period: e.target.value as SalaryPeriod })}
          className="rounded-lg border border-zinc-300 px-2 py-2 text-sm focus:border-zinc-900 focus:outline-none"
        >
          {SALARY_PERIODS.map((p) => (
            <option key={p} value={p}>
              {t(`salaryPeriod_${p}`)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function HoursPerWeekField({
  value,
  onChange,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  const t = useTranslations('candidates');
  return (
    <div>
      <label htmlFor="cand-hours" className="block text-sm font-medium text-zinc-900">
        {t('hoursLabel')}
      </label>
      <input
        id="cand-hours"
        type="number"
        min={1}
        max={80}
        value={value ?? ''}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) && n > 0 ? Math.min(80, Math.round(n)) : undefined);
        }}
        placeholder="40"
        className="mt-1 block w-28 rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
      />
    </div>
  );
}

/** Free-text chip list of desired work regions (geocode is a later phase). */
export function WorkRegionsField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const t = useTranslations('candidates');
  const [input, setInput] = useState('');
  function add() {
    const v = input.trim();
    if (v && !value.includes(v) && value.length < 12) onChange([...value, v]);
    setInput('');
  }
  return (
    <div>
      <label htmlFor="cand-regions" className="block text-sm font-medium text-zinc-900">
        {t('workRegionsLabel')}
      </label>
      <div className="mt-2 flex gap-2">
        <input
          id="cand-regions"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={t('workRegionsPlaceholder')}
          className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
        />
        <button
          type="button"
          onClick={add}
          className="rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
        >
          {t('add')}
        </button>
      </div>
      {value.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {value.map((r) => (
            <span
              key={r}
              className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-3 py-1 text-sm text-zinc-700"
            >
              {r}
              <button
                type="button"
                onClick={() => onChange(value.filter((x) => x !== r))}
                className="text-zinc-400 hover:text-red-600"
                aria-label={t('remove')}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The v2 preference values as one bag, for the bundled section below. */
export interface ExtraPrefsValue {
  maxTravelKm?: number;
  workRegions: string[];
  salaryMin?: number;
  salaryMax?: number;
  salaryPeriod: SalaryPeriod;
  hoursPerWeek?: number;
  workMode?: WorkMode;
  availability?: Availability;
  willingToRelocate: boolean;
}

export const EXTRA_PREFS_EMPTY: ExtraPrefsValue = {
  workRegions: [],
  salaryPeriod: 'month',
  willingToRelocate: false,
};

/**
 * Map the UI's ExtraPrefsValue onto the sparse preferences-payload fields (only
 * set keys are emitted). Shared by the wizard + both portal forms so the three
 * flows serialize the "recruiter's head" data identically.
 */
export function extraPrefsToPreferences(e: ExtraPrefsValue) {
  return {
    ...(typeof e.maxTravelKm === 'number' ? { maxTravelKm: e.maxTravelKm } : {}),
    ...(e.workRegions.length > 0
      ? { workRegions: e.workRegions.map((label) => ({ label })) }
      : {}),
    ...(e.salaryMin != null || e.salaryMax != null
      ? {
          salary: {
            ...(e.salaryMin != null ? { min: e.salaryMin } : {}),
            ...(e.salaryMax != null ? { max: e.salaryMax } : {}),
            period: e.salaryPeriod,
          },
        }
      : {}),
    ...(typeof e.hoursPerWeek === 'number' ? { hoursPerWeek: e.hoursPerWeek } : {}),
    ...(e.workMode ? { workMode: e.workMode } : {}),
    ...(e.availability ? { availability: e.availability } : {}),
    ...(e.willingToRelocate ? { willingToRelocate: true } : {}),
  };
}

/**
 * The whole "recruiter's head" question block as one control. Both the recruiter
 * wizard and the self-onboard portal render this so the two flows stay in
 * lock-step. `travelFallback` seeds the slider when maxTravelKm isn't set yet.
 */
export function ExtraQuestionsSection({
  value,
  onChange,
  travelFallback = 30,
}: {
  value: ExtraPrefsValue;
  onChange: (patch: Partial<ExtraPrefsValue>) => void;
  travelFallback?: number;
}) {
  const t = useTranslations('candidates');
  return (
    <div className="space-y-6">
      <div>
        <RadiusSlider
          value={value.maxTravelKm ?? travelFallback}
          // Sliding to 0 means "no explicit radius" → store UNSET (never an
          // explicit 0) so the education-level default keeps driving the match.
          onChange={(v) => onChange({ maxTravelKm: v === 0 ? undefined : v })}
        />
        <p className="mt-1 text-xs text-zinc-500">{t('travelHint')}</p>
      </div>
      <WorkModePicker value={value.workMode} onChange={(v) => onChange({ workMode: v })} />
      <AvailabilityPicker
        value={value.availability}
        onChange={(v) => onChange({ availability: v })}
      />
      <WorkRegionsField
        value={value.workRegions}
        onChange={(v) => onChange({ workRegions: v })}
      />
      <SalaryRange
        min={value.salaryMin}
        max={value.salaryMax}
        period={value.salaryPeriod}
        onChange={(patch) => {
          const next: Partial<ExtraPrefsValue> = {};
          if ('min' in patch) next.salaryMin = patch.min;
          if ('max' in patch) next.salaryMax = patch.max;
          if (patch.period) next.salaryPeriod = patch.period;
          onChange(next);
        }}
      />
      <HoursPerWeekField
        value={value.hoursPerWeek}
        onChange={(v) => onChange({ hoursPerWeek: v })}
      />
      <label className="flex items-center gap-2 text-sm text-zinc-700">
        <input
          type="checkbox"
          checked={value.willingToRelocate}
          onChange={(e) => onChange({ willingToRelocate: e.target.checked })}
          className="h-4 w-4 rounded border-zinc-300"
        />
        {t('relocateLabel')}
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload data-check — "did the CV come over well, and what's still only in the
// recruiter's head?" A live checklist that flags parsed gaps + un-captured
// tacit fields so the recruiter fills them before syncing.
// ---------------------------------------------------------------------------

export interface DataCheckInput {
  name: string;
  skillCount: number;
  hasLocation: boolean;
  hasEducation: boolean;
  hasWorkPreference: boolean; // maxTravelKm / workMode / availability set
  hasRegion: boolean;
  hasSalary: boolean;
}

export function DataCheckPanel({ check }: { check: DataCheckInput }) {
  const t = useTranslations('candidates');
  const items: Array<{ ok: boolean; key: string; critical?: boolean }> = [
    { ok: check.name.trim().length >= 2, key: 'checkName', critical: true },
    { ok: check.skillCount >= 3, key: 'checkSkills', critical: true },
    { ok: check.hasLocation, key: 'checkLocation' },
    { ok: check.hasEducation, key: 'checkEducation' },
    { ok: check.hasWorkPreference, key: 'checkWorkPreference' },
    { ok: check.hasRegion, key: 'checkRegion' },
    { ok: check.hasSalary, key: 'checkSalary' },
  ];
  const missing = items.filter((i) => !i.ok).length;
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-900">{t('dataCheckTitle')}</h3>
        <span className="text-xs text-zinc-500">
          {t('dataCheckSummary', { done: items.length - missing, total: items.length })}
        </span>
      </div>
      <ul className="mt-3 space-y-1.5">
        {items.map((i) => (
          <li key={i.key} className="flex items-start gap-2 text-sm">
            <span
              className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white ${
                i.ok ? 'bg-emerald-500' : i.critical ? 'bg-red-400' : 'bg-amber-400'
              }`}
            >
              {i.ok ? '✓' : '!'}
            </span>
            <span className={i.ok ? 'text-zinc-500 line-through' : 'text-zinc-800'}>
              {t(i.key)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UI state → server action input
// ---------------------------------------------------------------------------

export interface OnboardingFormState {
  name: string;
  email: string;
  phone: string;
  cvText: string;
  skills: SkillRow[];
  languages: LanguageRow[];
  location: LocationValue | null;
  contractTypes: ContractType[];
  radiusKm: number;
  remote: boolean;
  // v2 "recruiter's head" fields (all optional so existing callers compile;
  // the builder fills sane defaults).
  maxTravelKm?: number;
  workRegions?: string[];
  salaryMin?: number;
  salaryMax?: number;
  salaryPeriod?: SalaryPeriod;
  hoursPerWeek?: number;
  workMode?: WorkMode;
  availability?: Availability;
  willingToRelocate?: boolean;
}

/** Sensible empty defaults for the v2 fields (spread into a form's initial state). */
export const EXTRA_PREFS_DEFAULTS = {
  workRegions: [] as string[],
  salaryPeriod: 'month' as SalaryPeriod,
  willingToRelocate: false,
} satisfies Partial<OnboardingFormState>;

// Returns everything EXCEPT the GDPR `consent` flag — callers add `consent:
// true` once the (required) consent checkbox is ticked, so consent is never
// silently fabricated by the form-builder.
export function buildOnboardingInput(
  s: OnboardingFormState,
): Omit<OnboardingInput, 'consent'> {
  return {
    name: s.name.trim(),
    email: s.email.trim(),
    phone: s.phone.trim(),
    cvText: s.cvText.trim() || null,
    source: 'findtalent',
    skills: s.skills.map((sk) => ({
      skill: sk.id,
      // Unknown level (0) → omit proficiency_id so 8vance applies its default;
      // 1..5 → 23..27. Never fabricate a mid-tier value for an unknown skill.
      proficiency_id: levelToProficiencyIdOrUndefined(sk.level),
      must_have: sk.must_have,
    })),
    languages: s.languages.map((l) => ({ language: l.id })),
    location: s.location
      ? {
          city: s.location.city,
          country: s.location.country,
          // Carry the province through as `region` so home location is richer
          // than a bare city (the location picker resolves it when available).
          ...(s.location.province ? { region: s.location.province } : {}),
          latitude: s.location.latitude,
          longitude: s.location.longitude,
        }
      : null,
    preferences: {
      // The candidate now lands in ONE pool; match sources default to that
      // pool's own source server-side (see lib/candidate/default-pool). The UI
      // no longer collects sources, so we always submit an empty list.
      sources: [],
      contractTypes: s.contractTypes,
      // radiusKm stays for back-compat; maxTravelKm is the authoritative field
      // the match reads (falls back to radiusKm, then the edu-level default).
      radiusKm: s.maxTravelKm ?? s.radiusKm,
      // remote is derived from the richer workMode for back-compat readers.
      remote: s.workMode ? s.workMode === 'remote' : s.remote,
      locationCity: s.location?.city,
      // v2 "recruiter's head" fields — only sent when set.
      ...(typeof s.maxTravelKm === 'number' ? { maxTravelKm: s.maxTravelKm } : {}),
      ...(s.workRegions && s.workRegions.length > 0
        ? { workRegions: s.workRegions.map((label) => ({ label })) }
        : {}),
      ...(s.salaryMin != null || s.salaryMax != null
        ? {
            salary: {
              ...(s.salaryMin != null ? { min: s.salaryMin } : {}),
              ...(s.salaryMax != null ? { max: s.salaryMax } : {}),
              period: s.salaryPeriod ?? 'month',
            },
          }
        : {}),
      ...(typeof s.hoursPerWeek === 'number' ? { hoursPerWeek: s.hoursPerWeek } : {}),
      ...(s.workMode ? { workMode: s.workMode } : {}),
      ...(s.availability ? { availability: s.availability } : {}),
      ...(s.willingToRelocate ? { willingToRelocate: true } : {}),
    },
  };
}
