'use client';

/**
 * PUBLIC self-onboard form. No auth and no 8vance reference-data autocomplete
 * (those endpoints require an authed API user). It works from the recruiter's
 * pre-seeded profile: the candidate confirms basics, tunes skill proficiency /
 * must-haves, sets location (free text) and preferences, then submits.
 *
 * Submit calls `submitPortalOnboardingAction(token, input)`, which resolves the
 * candidate strictly by token, updates it, syncs to 8vance and runs the match.
 */

import { useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

import {
  submitPortalOnboardingAction,
  submitPortalCvOnboardingAction,
  deletePortalCandidateAction,
} from '@/app/app/candidates/actions';
import {
  ContractTypePicker,
  PreferenceControls,
  SkillList,
  ExtraQuestionsSection,
  EXTRA_PREFS_EMPTY,
  extraPrefsToPreferences,
  buildOnboardingInput,
  type ContractType,
  type ExtraPrefsValue,
  type LanguageRow,
  type LocationValue,
  type SkillRow,
} from '@/app/app/candidates/new/shared-form';

export interface SeedProfile {
  name: string;
  email: string;
  phone: string;
  skills: SkillRow[];
  languages: LanguageRow[];
  location: LocationValue | null;
  contractTypes: ContractType[];
  /** Recruiter-set radius; 0 = not set (server applies the edu heuristic). */
  radiusKm: number;
  remote: boolean;
  /**
   * Education-derived travel default the MATCH will use when no explicit
   * radius is set (35/65/85 per tier, else the global default). Shown as the
   * slider fallback so the portal displays what actually happens.
   */
  travelHintKm?: number;
}

/**
 * GDPR Art.13/14 data-processing notice + required consent checkbox. Shared by
 * both portal sub-forms. Links /privacy; the candidate must tick it to submit.
 */
function ConsentNotice({
  checked,
  onChange,
  t,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
      <p className="text-xs text-zinc-600">
        {t('consentNotice')}{' '}
        <a
          href="/privacy"
          target="_blank"
          rel="noreferrer"
          className="font-medium text-zinc-900 underline"
        >
          {t('consentPrivacyLink')}
        </a>
        {t('consentRetention')}
      </p>
      <label className="mt-3 flex items-start gap-2 text-sm text-zinc-700">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-zinc-300"
        />
        <span>
          {t('consentCandidateLabel')}
          <span className="ml-1 text-red-500">*</span>
        </span>
      </label>
    </div>
  );
}

/**
 * GDPR Art.17 self-erasure (token-scoped). Lets the invited candidate delete
 * their own record from the portal. Confirm-gated; on success it swaps to a
 * "deleted" notice. The link is consumed by the delete itself.
 */
function PortalSelfDelete({ token }: { token: string }) {
  const t = useTranslations('candidates');
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (deleted) {
    return (
      <div className="mt-8 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-center">
        <p className="text-sm text-zinc-700">{t('portalDeletedBody')}</p>
      </div>
    );
  }

  return (
    <div className="mt-8 border-t border-zinc-200 pt-6">
      <p className="text-xs text-zinc-500">{t('portalDeleteHint')}</p>
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="mt-2 text-xs font-medium text-red-600 underline hover:text-red-700"
        >
          {t('portalDeleteButton')}
        </button>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="text-xs text-zinc-700">{t('portalDeleteConfirm')}</span>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const res = await deletePortalCandidateAction(token);
                if (res.ok) setDeleted(true);
                else setError(t('portalDeleteError'));
              })
            }
            className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
          >
            {pending ? t('portalDeleteWorking') : t('portalDeleteConfirmYes')}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirming(false)}
            className="text-xs text-zinc-500 hover:text-zinc-700"
          >
            {t('portalDeleteCancel')}
          </button>
        </div>
      )}
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}

export function PortalForm({
  token,
  seed,
  fromScratch = false,
}: {
  token: string;
  seed: SeedProfile;
  /** True when the recruiter minted the link with no profile (CV-only path). */
  fromScratch?: boolean;
}) {
  if (fromScratch) {
    return <PortalCvForm token={token} travelHintKm={seed.travelHintKm} />;
  }
  return <PortalSeededForm token={token} seed={seed} />;
}

/**
 * FROM-SCRATCH path: name + email + phone + a CV paste textarea (+ optional
 * preferences). On submit the SERVER extracts + resolves skills from the CV.
 */
function PortalCvForm({ token, travelHintKm }: { token: string; travelHintKm?: number }) {
  const t = useTranslations('candidates');
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [cvText, setCvText] = useState('');
  const [contractTypes, setContractTypes] = useState<ContractType[]>([]);
  const [extra, setExtra] = useState<ExtraPrefsValue>(EXTRA_PREFS_EMPTY);
  // GDPR Art.13/14 — the candidate consents to processing + sync to 8vance.
  const [consent, setConsent] = useState(false);

  const canSubmit = useMemo(
    () =>
      name.trim().length >= 2 &&
      /.+@.+\..+/.test(email.trim()) &&
      phone.trim().length >= 5 &&
      cvText.trim().length >= 20 &&
      consent,
    [name, email, phone, cvText, consent],
  );

  function submit() {
    setError(null);
    setWarning(null);
    startTransition(async () => {
      const res = await submitPortalCvOnboardingAction(token, {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        cvText: cvText.trim(),
        consent,
        preferences: {
          // The pool is fixed at link-generation time and match sources default
          // to that pool's own source server-side, so the candidate no longer
          // chooses sources here.
          contractTypes,
          // 0 when untouched → the server applies the education-level heuristic.
          radiusKm: extra.maxTravelKm ?? 0,
          remote: extra.workMode === 'remote',
          ...extraPrefsToPreferences(extra),
        },
      });
      if (!res.ok) {
        setError(res.reason === 'token' ? t('portalExpiredBody') : t(`error_${res.reason}`));
        return;
      }
      // Keep the raw warning so the done screen can map each distinct kind to
      // its own message (few_skills / sync_failed / match_failed / generic).
      if (res.warning) setWarning(res.warning);
      setDone(true);
    });
  }

  if (done) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center">
        <h2 className="text-base font-semibold text-emerald-800">{t('portalDoneTitle')}</h2>
        <p className="mt-2 text-sm text-emerald-700">{t('portalCvDoneBody')}</p>
        {warning === 'few_skills' || warning === 'auth_failed' ? (
          <p className="mt-3 text-xs text-emerald-700/80">{t('portalCvFewSkills')}</p>
        ) : warning === 'sync_failed' ? (
          <p className="mt-3 text-xs text-emerald-700/80">{t('portalWarningSyncFailed')}</p>
        ) : warning === 'match_failed' ? (
          <p className="mt-3 text-xs text-emerald-700/80">{t('portalWarningMatchFailed')}</p>
        ) : warning ? (
          <p className="mt-3 text-xs text-emerald-700/80">{t('portalDoneWarning')}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div>
          <label htmlFor="cv-name" className="block text-sm font-medium text-zinc-700">
            {t('nameLabel')}<span className="ml-1 text-red-500">*</span>
          </label>
          <input
            id="cv-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('namePlaceholder')}
            className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="cv-email" className="block text-sm font-medium text-zinc-700">
              {t('emailLabel')}<span className="ml-1 text-red-500">*</span>
            </label>
            <input
              id="cv-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('emailPlaceholder')}
              className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="cv-phone" className="block text-sm font-medium text-zinc-700">
              {t('phoneLabel')}<span className="ml-1 text-red-500">*</span>
            </label>
            <input
              id="cv-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
            />
          </div>
        </div>
      </div>

      <div>
        <label htmlFor="cv-text" className="block text-sm font-medium text-zinc-900">
          {t('portalCvLabel')}<span className="ml-1 text-red-500">*</span>
        </label>
        <p className="mt-1 text-xs text-zinc-500">{t('portalCvHint')}</p>
        <textarea
          id="cv-text"
          rows={12}
          value={cvText}
          onChange={(e) => setCvText(e.target.value)}
          placeholder={t('cvPlaceholder')}
          className="mt-2 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
        />
      </div>

      <PreferenceControls>
        <ContractTypePicker value={contractTypes} onChange={setContractTypes} />
        <ExtraQuestionsSection
          value={extra}
          onChange={(patch) => setExtra((v) => ({ ...v, ...patch }))}
          // Show the education-derived default the match will actually use
          // (35/65/85 per tier) rather than a flat 30 km.
          {...(travelHintKm != null ? { travelFallback: travelHintKm } : {})}
        />
      </PreferenceControls>

      <ConsentNotice checked={consent} onChange={setConsent} t={t} />

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit || pending}
        className="w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
      >
        {pending ? t('portalCvProcessing') : t('portalSubmit')}
      </button>
      {pending ? (
        <p className="text-center text-xs text-zinc-500">{t('portalCvProcessingHint')}</p>
      ) : null}

      <PortalSelfDelete token={token} />
    </div>
  );
}

/**
 * PRE-SEEDED path (unchanged): the recruiter already captured a profile; the
 * candidate confirms basics, tunes skills/location/preferences, then submits.
 */
function PortalSeededForm({
  token,
  seed,
}: {
  token: string;
  seed: SeedProfile;
}) {
  const t = useTranslations('candidates');
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const [name, setName] = useState(seed.name);
  const [email, setEmail] = useState(seed.email);
  const [phone, setPhone] = useState(seed.phone);
  const [skills, setSkills] = useState<SkillRow[]>(seed.skills);
  const [city, setCity] = useState(seed.location?.city ?? '');
  const [country, setCountry] = useState(seed.location?.country ?? '');
  const [contractTypes, setContractTypes] = useState<ContractType[]>(seed.contractTypes);
  const [extra, setExtra] = useState<ExtraPrefsValue>({
    ...EXTRA_PREFS_EMPTY,
    maxTravelKm: seed.radiusKm || undefined,
    workMode: seed.remote ? 'remote' : undefined,
  });
  // GDPR Art.13/14 — the candidate consents to processing + sync to 8vance.
  const [consent, setConsent] = useState(false);

  const canSubmit = useMemo(
    () => name.trim().length >= 2 && skills.length >= 3 && consent,
    [name, skills, consent],
  );

  function submit() {
    setError(null);
    setWarning(null);
    const location: LocationValue | null =
      city.trim() && country.trim()
        ? {
            city: city.trim(),
            country: country.trim(),
            latitude: seed.location?.latitude,
            longitude: seed.location?.longitude,
          }
        : null;
    const input = buildOnboardingInput({
      name,
      email,
      phone,
      cvText: '',
      skills,
      languages: seed.languages,
      location,
      contractTypes,
      radiusKm: extra.maxTravelKm ?? seed.radiusKm,
      remote: extra.workMode === 'remote',
      maxTravelKm: extra.maxTravelKm,
      workRegions: extra.workRegions,
      salaryMin: extra.salaryMin,
      salaryMax: extra.salaryMax,
      salaryPeriod: extra.salaryPeriod,
      hoursPerWeek: extra.hoursPerWeek,
      workMode: extra.workMode,
      availability: extra.availability,
      willingToRelocate: extra.willingToRelocate,
    });
    startTransition(async () => {
      const res = await submitPortalOnboardingAction(token, { ...input, consent });
      if (!res.ok) {
        setError(res.reason === 'token' ? t('portalExpiredBody') : t(`error_${res.reason}`));
        return;
      }
      if (res.warning) setWarning(res.warning);
      setDone(true);
    });
  }

  if (done) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center">
        <h2 className="text-base font-semibold text-emerald-800">{t('portalDoneTitle')}</h2>
        <p className="mt-2 text-sm text-emerald-700">{t('portalDoneBody')}</p>
        {warning === 'sync_failed' ? (
          <p className="mt-3 text-xs text-emerald-700/80">{t('portalWarningSyncFailed')}</p>
        ) : warning === 'match_failed' ? (
          <p className="mt-3 text-xs text-emerald-700/80">{t('portalWarningMatchFailed')}</p>
        ) : warning ? (
          <p className="mt-3 text-xs text-emerald-700/80">{t('portalDoneWarning')}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div>
          <label htmlFor="p-name" className="block text-sm font-medium text-zinc-700">
            {t('nameLabel')}<span className="ml-1 text-red-500">*</span>
          </label>
          <input
            id="p-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="p-email" className="block text-sm font-medium text-zinc-700">
              {t('emailLabel')}
            </label>
            <input
              id="p-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="p-phone" className="block text-sm font-medium text-zinc-700">
              {t('phoneLabel')}
            </label>
            <input
              id="p-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
            />
          </div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-medium text-zinc-900">{t('skillsLabel')}</h3>
        <p className="mt-1 text-xs text-zinc-500">{t('portalSkillsHint')}</p>
        <div className="mt-2">
          <SkillList
            skills={skills}
            onRemove={(id) => setSkills((p) => p.filter((s) => s.id !== id))}
            onUpdate={(id, patch) =>
              setSkills((p) => p.map((s) => (s.id === id ? { ...s, ...patch } : s)))
            }
          />
        </div>
        {skills.length < 3 ? (
          <p className="mt-1 text-xs text-amber-600">{t('portalNeedMoreSkills')}</p>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="p-city" className="block text-sm font-medium text-zinc-700">
            {t('cityLabel')}
          </label>
          <input
            id="p-city"
            type="text"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="p-country" className="block text-sm font-medium text-zinc-700">
            {t('countryLabel')}
          </label>
          <input
            id="p-country"
            type="text"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
          />
        </div>
      </div>

      <PreferenceControls>
        <ContractTypePicker value={contractTypes} onChange={setContractTypes} />
        <ExtraQuestionsSection
          value={extra}
          onChange={(patch) => setExtra((v) => ({ ...v, ...patch }))}
          // Show the education-derived default the match will actually use
          // (35/65/85 per tier) rather than a flat 30 km.
          {...(seed.travelHintKm != null ? { travelFallback: seed.travelHintKm } : {})}
        />
      </PreferenceControls>

      <ConsentNotice checked={consent} onChange={setConsent} t={t} />

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit || pending}
        className="w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
      >
        {pending ? t('submitting') : t('portalSubmit')}
      </button>

      <PortalSelfDelete token={token} />
    </div>
  );
}
