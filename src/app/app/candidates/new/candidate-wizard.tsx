'use client';

/**
 * Candidate onboarding wizard (recruiter-driven). Reuses the same field
 * patterns as the project-create wizard: the `Autocomplete` primitive, the
 * refdata fetchers (skill/language/location, scoped by tenant query), and a
 * tenant ("pool") picker.
 *
 * Steps:
 *   0 basics      — name, email, optional CV paste, pick pool tenant
 *   1 skills      — >= 3, reuse Autocomplete + /api/refdata/skill
 *   2 langs+loc   — languages + home location
 *   3 preferences — contract types, radius, remote
 *
 * The candidate is created in exactly ONE pool (the tenant picked in step 0).
 * Match sources are no longer chosen here — the server defaults them to the
 * pool's own source — so onboarding never collects a sources list.
 *
 * On submit it calls the typed `createCandidateAction` and routes to the match
 * screen for the new candidate.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';

import { createCandidateAction } from '../actions';
import {
  Autocomplete,
  CONTRACT_TYPES,
  ContractTypePicker,
  jsonGet,
  LocationField,
  PreferenceControls,
  RadiusSlider,
  SkillList,
  WorkModePicker,
  AvailabilityPicker,
  SalaryRange,
  HoursPerWeekField,
  WorkRegionsField,
  DataCheckPanel,
  type ContractType,
  type LanguageRow,
  type LocationValue,
  type SkillRow,
  type TenantOption,
  type LanguageOption,
  type WorkMode,
  type Availability,
  type SalaryPeriod,
  buildOnboardingInput,
} from './shared-form';
import { highestEduTier, travelDefaultForTier } from '@/lib/candidate/preferences';

const STEP_KEYS = ['stepBasics', 'stepSkills', 'stepLangLoc', 'stepPrefs'] as const;
const STEP_COUNT = STEP_KEYS.length;

export function CandidateWizard() {
  const t = useTranslations('candidates');
  const router = useRouter();
  const uiLocale = useLocale();
  const [pending, startTransition] = useTransition();

  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // Step 0
  const [tenantOptions, setTenantOptions] = useState<TenantOption[]>([]);
  const [tenantId, setTenantId] = useState<string>('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [cvText, setCvText] = useState('');
  // Optional recruiter free-text note / extra context about the candidate.
  // Stored on profileJson.note and synced to the talent's about_me.
  const [note, setNote] = useState('');
  // CV file upload (parsed to text server-side, feeds the same cvText flow).
  const [cvUploading, setCvUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [cvUploadName, setCvUploadName] = useState<string | null>(null);
  const [cvUploadError, setCvUploadError] = useState<string | null>(null);
  // True when the upload had no text layer and was read via OCR (scanned PDF /
  // image) — the data lands in skills/profile, not the CV-text box.
  const [cvUploadOcr, setCvUploadOcr] = useState(false);
  // Stage-2 (background 8vance) parse handle. parse-cv mints this token and
  // kicks the slower 8vance parser into a server-side cache. We NO LONGER poll
  // + auto-merge it into the form (that would silently mutate what the recruiter
  // sees). Instead we carry the token to the create action, which turns the
  // 8vance parse into PENDING suggestions the recruiter approves later. Re-armed
  // per upload; cleared when a fresh upload starts.
  const [enrichToken, setEnrichToken] = useState<string | null>(null);

  // Step 1
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [cvExtracting, setCvExtracting] = useState(false);
  const [cvExtractMsg, setCvExtractMsg] = useState<string | null>(null);
  // Step 2
  const [languages, setLanguages] = useState<LanguageRow[]>([]);
  const [location, setLocation] = useState<LocationValue | null>(null);
  // Mirror of `location` so the CV auto-extract path can check "already set?"
  // without adding `location` to its callback deps (keeps the one-shot guard).
  const locationRef = useRef<LocationValue | null>(null);
  useEffect(() => {
    locationRef.current = location;
  }, [location]);
  // Full extracted CV profile (about/education/employment/certifications/
  // languages) — stored on the candidate so the profile is "super volledig".
  // Declared BEFORE the callbacks/effects that write it, so the lint's ref
  // analysis recognises the writes as ref mutations.
  const richProfileRef = useRef<unknown>(null);
  // Content-key of the CV text that auto-extraction already ran for (the
  // one-shot guard of the auto-extract effect further down). Same
  // declare-before-use note as richProfileRef.
  const autoExtractedFor = useRef<string | null>(null);
  // Step 3
  const [contractTypes, setContractTypes] = useState<ContractType[]>([]);
  // 0 = "recruiter hasn't set a travel radius" → the server applies the
  // education-level heuristic. Only a deliberate slider drag sets a value.
  const [radiusKm, setRadiusKm] = useState(0);
  // Suggested radius from the parsed education tier — shown on the slider until
  // the recruiter overrides it (the "won't drive an hour" heuristic, visualized).
  const [travelHintKm, setTravelHintKm] = useState<number | undefined>(undefined);
  // Legacy `remote` is now derived from workMode; the builder prefers workMode.
  const remote = false;
  // Step 3 — v2 "recruiter's head" fields (the info only the recruiter knows).
  const [maxTravelKm, setMaxTravelKm] = useState<number | undefined>(undefined);
  const [workRegions, setWorkRegions] = useState<string[]>([]);
  const [salaryMin, setSalaryMin] = useState<number | undefined>(undefined);
  const [salaryMax, setSalaryMax] = useState<number | undefined>(undefined);
  const [salaryPeriod, setSalaryPeriod] = useState<SalaryPeriod>('month');
  const [hoursPerWeek, setHoursPerWeek] = useState<number | undefined>(undefined);
  const [workMode, setWorkMode] = useState<WorkMode | undefined>(undefined);
  const [availability, setAvailability] = useState<Availability | undefined>(undefined);
  const [willingToRelocate, setWillingToRelocate] = useState(false);
  // Parsed education (from the CV extract) — drives the travel-radius default
  // hint (higher-educated candidates commute further) + the data-check.
  const [hasEducation, setHasEducation] = useState(false);
  // GDPR Art.13/14 — recruiter confirms they have the candidate's consent for
  // processing + sync to 8vance. Required before submit.
  const [consent, setConsent] = useState(false);

  // Load pools once, and pre-select a pool ONLY when the choice is unambiguous:
  //   - a pool marked isDefault → pre-select that one
  //   - exactly one pool        → auto-select it
  //   - multiple, none default  → leave the picker EMPTY so the recruiter must
  //                               choose explicitly. Never guess the company —
  //                               an auto-pick of the alphabetically-first pool
  //                               could create the candidate in the WRONG live
  //                               company. The required select + canSubmit
  //                               (tenantId !== '') block submit until chosen.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await jsonGet<{ results: TenantOption[] }>('/api/tenants/list');
        if (cancelled) return;
        const pools = list.results ?? [];
        setTenantOptions(pools);
        const preselect =
          pools.find((p) => p.isDefault) ?? (pools.length === 1 ? pools[0] : undefined);
        if (preselect) setTenantId(preselect.id);
      } catch {
        if (!cancelled) setTenantOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Default the candidate's language to Dutch (the common case for this market),
  // once, on load — mirroring the pool pre-select. Non-blocking + REMOVABLE: it
  // is pre-added like any other language, so the recruiter can delete it. We
  // skip if the languages list is already non-empty (e.g. a CV-derived language
  // such as Dutch was added first) so we never duplicate Dutch.
  const dutchDefaulted = useRef(false);
  useEffect(() => {
    // /api/refdata/language requires a tenant, so wait until a pool is selected.
    // Only arm the one-shot guard AFTER a successful fetch (not before), so a
    // pre-tenant render can't permanently disable the default.
    if (dutchDefaulted.current || !tenantId) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await jsonGet<{ results: LanguageOption[] }>(
          `/api/refdata/language?tenantId=${encodeURIComponent(tenantId)}`,
        );
        if (cancelled) return;
        dutchDefaulted.current = true;
        // Prefer the EXACT "Dutch"/"Nederlands" row. The 8vance language list
        // also contains variants ("Dutch Low Saxon", "Dutch, Middle …") that a
        // bare /dutch/ contains-match would grab first — we want plain Dutch.
        const rows = r.results ?? [];
        const norm = (s: string) => s.trim().toLowerCase();
        const dutch =
          rows.find((l) => norm(l.name) === 'dutch' || norm(l.name) === 'nederlands') ??
          rows.find((l) => /^(nederlands|dutch)\b/i.test(l.name.trim())) ??
          rows.find((l) => /nederlands|dutch/i.test(l.name));
        if (!dutch) return;
        setLanguages((prev) =>
          prev.length === 0 ? [{ id: dutch.id, name: dutch.name }] : prev,
        );
      } catch {
        /* non-fatal: skip the default (will retry on next tenant change) */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const searchLocale = (['nl', 'en', 'de'] as const).includes(uiLocale as never)
    ? uiLocale
    : 'en';
  const refQuery = tenantId
    ? `tenantId=${encodeURIComponent(tenantId)}&locale=${encodeURIComponent(searchLocale)}`
    : `locale=${encodeURIComponent(searchLocale)}`;

  const fetchSkill = useCallback(
    async (q: string) => {
      if (!tenantId) return [];
      const typed = q.trim();
      if (typed.length < 2) return [];
      const r = await jsonGet<{ results: { id: number; name: string }[] }>(
        `/api/refdata/skill?${refQuery}&q=${encodeURIComponent(typed)}`,
      );
      return r.results ?? [];
    },
    [tenantId, refQuery],
  );

  const fetchLanguage = useCallback(
    async (q: string) => {
      if (!tenantId) return [];
      const r = await jsonGet<{ results: LanguageOption[] }>(
        `/api/refdata/language?${refQuery}`,
      );
      const rows = r.results ?? [];
      return q.length === 0
        ? rows
        : rows.filter((row) => row.name.toLowerCase().includes(q.toLowerCase()));
    },
    [tenantId, refQuery],
  );

  const fetchLocation = useCallback(
    async (q: string) => {
      if (!tenantId) return [];
      const r = await jsonGet<{ results: LocationValue[] }>(
        `/api/refdata/location?${refQuery}&q=${encodeURIComponent(q)}`,
      );
      return r.results ?? [];
    },
    [tenantId, refQuery],
  );

  // Upload a CV file (PDF/Word/txt); parse it to text server-side and drop the
  // result into `cvText` so the existing extract-skills + contact flow works
  // unchanged. Gated on `tenantId`, mirroring the skill-extract button.
  const uploadCv = useCallback(
    async (file: File) => {
      if (!tenantId) return;
      // Fresh upload: always allow re-extraction even if the new file's text is
      // byte-identical to the previous upload's. Without this, the cvText
      // auto-extract effect's content-keyed guard would skip, leaving the
      // freshly-cleared name/email/phone unfilled. (Fix #2 below re-arms the
      // guard for ocr/parsed uploads that already resolved skills here.)
      autoExtractedFor.current = null;
      setCvUploading(true);
      setCvUploadError(null);
      setCvUploadOcr(false);
      setEnrichToken(null);
      setCvUploadName(file.name);
      // Indeterminate "creeping" progress bar: server-side parse (esp. scanned-
      // PDF OCR) can take a while, so show steady visible progress to ~92% so
      // impatient users keep waiting. Snaps to 100% on completion.
      setUploadProgress(6);
      const progressTimer = setInterval(() => {
        setUploadProgress((p) => (p < 92 ? p + Math.max(1, Math.round((92 - p) / 14)) : p));
      }, 450);
      progressInterval.current = progressTimer;
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch(
          `/api/candidates/parse-cv?tenantId=${encodeURIComponent(tenantId)}`,
          { method: 'POST', body: fd },
        );
        if (!res.ok) {
          setCvUploadError(t('cvUploadError'));
          return;
        }
        const data = (await res.json()) as {
          text?: string;
          // Stage-2 token: poll /parse-cv/enrich to merge the slower 8vance data.
          enrichToken?: string;
          parsed?: {
            skills?: string[];
            email?: string;
            phone?: string;
            fullName?: string;
          } | null;
          // OCR fallback (scanned/unreadable PDF or image) → full rich profile.
          profile?: {
            hardSkills?: string[];
            softSkills?: string[];
            knowledge?: string[];
            email?: string;
            phone?: string;
            fullName?: string;
            about?: string;
            languages?: { name: string; level?: number }[];
            education?: unknown[];
            employment?: unknown[];
            certifications?: unknown[];
            location?: { city?: string; region?: string; country?: string } | null;
          } | null;
        };
        const text = (data.text ?? '').trim();
        const parsed = data.parsed ?? null;
        const ocr = data.profile ?? null;
        const ocrSkillNames = ocr
          ? [...(ocr.hardSkills ?? []), ...(ocr.softSkills ?? []), ...(ocr.knowledge ?? [])]
          : [];
        if (
          text.length === 0 &&
          !(parsed && parsed.skills && parsed.skills.length) &&
          ocrSkillNames.length === 0
        ) {
          setCvUploadError(t('cvUploadError'));
          return;
        }
        // A fresh CV upload REPLACES any prior CV-derived data (uploading a new
        // file is an explicit "use this CV" action). Clear skills + rich profile
        // AND name/email/phone first: for a text CV the fields are filled by the
        // cvText auto-extract effect (which is fill-if-empty), so they must be
        // empty here for the NEW CV's values to take — otherwise a second upload
        // keeps the first CV's name/skills.
        setSkills([]);
        richProfileRef.current = null;
        setName('');
        setEmail('');
        setPhone('');
        // Also clear the prior CV's location + CV text so a 2nd CV can't inherit
        // them. The location prefills guard on `!locationRef.current` (the REF,
        // not state), so the ref MUST be nulled too or they never overwrite.
        // An OCR/image CV (no text layer) would otherwise keep the 1st CV's
        // cvText. (`languages` is intentionally NOT cleared — this path doesn't
        // auto-fill languages state, and the Dutch default should survive.)
        setLocation(null);
        locationRef.current = null;
        setCvText('');
        // True when the ocr/parsed branch below will resolve skills itself, so the
        // cvText auto-extract effect must NOT run a second /extract-skills on the
        // same text. For a plain-text doc (no parsed/ocr skills) this stays false
        // and the effect runs the (only) extraction.
        const extractionHandled =
          !!(parsed && parsed.skills && parsed.skills.length > 0) || ocrSkillNames.length > 0;
        // Arm the content-keyed guard BEFORE setCvText so the effect (which may
        // commit during an upcoming await) already sees the text as handled. Use
        // the same trimmed text the effect compares against (`text` is trimmed).
        // Only when there IS text (otherwise the effect never fires anyway).
        if (extractionHandled && text.length > 0) {
          autoExtractedFor.current = text;
        }
        if (text.length > 0) setCvText(text);
        if (text.length === 0 && ocr) setCvUploadOcr(true);
        // OCR profile (no text layer): prefill contact, store the rich profile,
        // and resolve its skill names to taxonomy ids.
        if (ocr) {
          if (ocr.email) setEmail(ocr.email);
          if (ocr.phone) setPhone(ocr.phone);
          if (ocr.fullName) setName(ocr.fullName);
          richProfileRef.current = {
            about: ocr.about,
            languages: ocr.languages ?? [],
            education: ocr.education ?? [],
            employment: ocr.employment ?? [],
            certifications: ocr.certifications ?? [],
            location: ocr.location ?? undefined,
          };
          if ((ocr.education ?? []).length > 0) {
            setHasEducation(true);
            setTravelHintKm(
              travelDefaultForTier(
                highestEduTier((ocr.education ?? []) as Array<{ degree?: string | null }>),
              ),
            );
          }
          // Pre-fill the home location from the OCR'd city when still empty.
          const ocrCity = ocr.location?.city?.trim();
          if (ocrCity && ocrCity.length >= 2 && !locationRef.current) {
            try {
              const lr = await jsonGet<{ results: LocationValue[] }>(
                `/api/refdata/location?${refQuery}&q=${encodeURIComponent(ocrCity)}`,
              );
              const first = lr.results?.[0];
              if (first && !locationRef.current) {
                locationRef.current = first;
                setLocation(first);
              }
            } catch {
              /* non-fatal */
            }
          }
          if (ocrSkillNames.length > 0) {
            try {
              const r = await fetch(`/api/candidates/extract-skills?${refQuery}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ skills: ocrSkillNames }),
              });
              const sd = (await r.json()) as {
                results?: { id: number; name: string; level?: number }[];
              };
              const hits = sd.results ?? [];
              setSkills((prev) => {
                const have = new Set(prev.map((s) => s.id));
                const add = hits
                  .filter((h) => !have.has(h.id))
                  // Use the CV-inferred proficiency level when present; else 0 =
                  // UNKNOWN (renders an empty meter, not a fake mid-tier 3).
                  .map((h) => ({ id: h.id, name: h.name, level: h.level ?? 0, must_have: false }));
                return [...prev, ...add].slice(0, 40);
              });
            } catch {
              /* non-fatal */
            }
          }
        }
        // 8vance parser delivered structured data → prefill contact + resolve
        // its skill names to taxonomy ids directly (skips the LLM/regex path).
        if (parsed) {
          if (parsed.email) setEmail(parsed.email);
          if (parsed.phone) setPhone(parsed.phone);
          if (parsed.fullName) setName(parsed.fullName);
          if (parsed.skills && parsed.skills.length > 0) {
            try {
              const r = await fetch(`/api/candidates/extract-skills?${refQuery}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ skills: parsed.skills }),
              });
              const sd = (await r.json()) as {
                results?: { id: number; name: string; level?: number }[];
              };
              const hits = sd.results ?? [];
              setSkills((prev) => {
                const have = new Set(prev.map((s) => s.id));
                const add = hits
                  .filter((h) => !have.has(h.id))
                  // 8vance-parser skills carry no CV signal → level 0 (unknown).
                  .map((h) => ({ id: h.id, name: h.name, level: h.level ?? 0, must_have: false }));
                return [...prev, ...add].slice(0, 40);
              });
            } catch {
              /* fall back to the text-based extract button */
            }
          }
        }
        // Stage 2: the slower 8vance parse runs server-side in the background.
        // We DON'T merge it into the form — carry the token to create, which
        // turns the 8vance parse into PENDING suggestions the recruiter reviews.
        if (data.enrichToken) setEnrichToken(data.enrichToken);
      } catch {
        setCvUploadError(t('cvUploadError'));
      } finally {
        clearInterval(progressTimer);
        if (isMounted.current) {
          setUploadProgress(100);
          const resetId = setTimeout(() => {
            if (isMounted.current) setUploadProgress(0);
          }, 800);
          pendingTimers.current.push(resetId);
          setCvUploading(false);
        }
      }
    },
    [tenantId, refQuery, email, phone, name, t],
  );

  // Pending timers (the progress-bar reset setTimeout + the creeping interval)
  // tracked so we can clear them if the component unmounts mid-upload — avoids
  // "state update on unmounted component" warnings + leaks.
  const pendingTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const progressInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      for (const id of pendingTimers.current) clearTimeout(id);
      pendingTimers.current = [];
      // Clear the upload progress interval too, in case we unmount mid-parse
      // (the finally that normally clears it hasn't run yet).
      if (progressInterval.current) clearInterval(progressInterval.current);
    };
  }, []);

  // Resolve a CV-extracted city against the location refdata and pre-fill the
  // home location — but only when the field is still empty (never overwrite a
  // recruiter's choice). Best-effort + non-blocking: no match / any error → skip.
  const prefillLocationFromCity = useCallback(
    async (rawCity: string) => {
      const city = rawCity.trim();
      if (!tenantId || city.length < 2) return;
      if (locationRef.current) return; // recruiter / earlier CV already set it
      try {
        const r = await jsonGet<{ results: LocationValue[] }>(
          `/api/refdata/location?${refQuery}&q=${encodeURIComponent(city)}`,
        );
        const first = r.results?.[0];
        // Re-check emptiness after the await (avoid clobbering a meanwhile-set value).
        if (first && !locationRef.current) {
          locationRef.current = first;
          setLocation(first);
        }
      } catch {
        /* non-fatal: leave the location empty */
      }
    },
    [tenantId, refQuery],
  );

  // Pull candidate skills out of the pasted CV and merge them into the list.
  // Resolves a CATEGORIZED profile (hard/soft/knowledge) — all groups are added
  // to the flat skills list; the small note reports the hard/soft split.
  const extractFromCv = useCallback(async () => {
    if (!tenantId || cvText.trim().length < 10) return;
    setCvExtracting(true);
    setCvExtractMsg(null);
    try {
      const res = await fetch(`/api/candidates/extract-skills?${refQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cvText }),
      });
      type SkillHit = { id: number; name: string; level?: number };
      const data = (await res.json()) as {
        results?: SkillHit[];
        grouped?: { hard?: SkillHit[]; soft?: SkillHit[]; knowledge?: SkillHit[] };
        fullName?: string;
        email?: string;
        phone?: string;
        city?: string;
        profile?: unknown;
        unresolved?: string[];
        authFailed?: boolean;
        error?: string;
      };
      // 429 rate-limit or broken tenant creds: show a precise message instead of
      // the misleading "no skills" path.
      if (res.status === 429) {
        setCvExtractMsg(t('cvRateLimited'));
        return;
      }
      if (data.authFailed) {
        setCvExtractMsg(t('cvAuthFailed'));
        return;
      }
      // Prefill mandatory fields from the CV when still empty.
      if (data.fullName && !name.trim()) setName(data.fullName);
      if (data.email && !email.trim()) setEmail(data.email);
      if (data.phone && !phone.trim()) setPhone(data.phone);
      if (data.profile) {
        richProfileRef.current = data.profile;
        const edu = (data.profile as { education?: Array<{ degree?: string | null }> })
          .education;
        if (Array.isArray(edu) && edu.length > 0) {
          setHasEducation(true);
          setTravelHintKm(travelDefaultForTier(highestEduTier(edu)));
        }
      }
      // Pre-fill the home location from the CV's city when it's still empty.
      if (data.city) void prefillLocationFromCity(data.city);

      const grouped = data.grouped;
      const hardCount = grouped?.hard?.length ?? 0;
      const softCount = grouped?.soft?.length ?? 0;
      // Add every group's skills (flat list); fall back to `results` if no
      // grouping is present (e.g. older response shape).
      const hits: SkillHit[] = grouped
        ? [...(grouped.hard ?? []), ...(grouped.soft ?? []), ...(grouped.knowledge ?? [])]
        : (data.results ?? []);

      // Compute the added count outside the state updater (the updater may run
      // async, so reading a mutated closure var afterwards would show 0).
      const existing = new Set(skills.map((s) => s.id));
      const fresh = hits
        .filter((h) => !existing.has(h.id))
        .slice(0, Math.max(0, 40 - skills.length));
      if (fresh.length > 0) {
        setSkills((prev) => {
          const have = new Set(prev.map((s) => s.id));
          const seen = new Set<number>();
          const add = fresh
            .filter((h) => {
              if (have.has(h.id) || seen.has(h.id)) return false;
              seen.add(h.id);
              return true;
            })
            // CV-inferred proficiency when the CV had a signal; else 0 = UNKNOWN
            // (empty meter), never a fabricated mid-tier 3.
            .map((h) => ({ id: h.id, name: h.name, level: h.level ?? 0, must_have: false }));
          return [...prev, ...add].slice(0, 40);
        });
      }
      const doneMsg = grouped
        ? t('cvExtractDoneGrouped', { hard: hardCount, soft: softCount })
        : t('cvExtractDone', { count: fresh.length });
      const unresolved = data.unresolved ?? [];
      setCvExtractMsg(
        unresolved.length > 0
          ? `${doneMsg} ${t('cvExtractUnresolved', {
              count: unresolved.length,
              names: unresolved.slice(0, 8).join(', '),
            })}`
          : doneMsg,
      );
    } catch {
      setCvExtractMsg(t('cvExtractError'));
    } finally {
      setCvExtracting(false);
    }
  }, [tenantId, cvText, refQuery, name, email, phone, skills, t, prefillLocationFromCity]);

  // Auto-run extraction once when CV text first becomes available (after a
  // paste-blur or after the parse-cv upload sets cvText). The manual button
  // stays available for re-runs / edits. Keyed on the CV text (the
  // `autoExtractedFor` ref declared near the top) so a different CV
  // re-triggers; guarded so we don't loop while extracting.
  useEffect(() => {
    if (!tenantId) return;
    const trimmed = cvText.trim();
    if (trimmed.length < 10) return;
    if (cvExtracting) return;
    if (autoExtractedFor.current === trimmed) return;
    autoExtractedFor.current = trimmed;
    void extractFromCv();
    // extractFromCv is stable enough for this guarded one-shot; deps kept tight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cvText, tenantId]);

  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const phoneValid = phone.trim().length >= 5;

  const canAdvance = useMemo(() => {
    if (step === 0)
      // Block Continue while a CV is still being parsed/extracted — name/email/
      // phone get auto-filled from it, so let the upload finish first.
      return (
        !cvUploading &&
        !cvExtracting &&
        name.trim().length >= 2 &&
        tenantId !== '' &&
        emailValid &&
        phoneValid
      );
    if (step === 1) return skills.length >= 3;
    if (step === 2) return true; // languages + location optional
    if (step === 3) return true; // contract/radius/remote all optional
    return false;
  }, [step, name, tenantId, emailValid, phoneValid, skills, cvUploading, cvExtracting]);

  const canSubmit =
    name.trim().length >= 2 &&
    tenantId !== '' &&
    emailValid &&
    phoneValid &&
    skills.length >= 3 &&
    consent;

  function submit() {
    setError(null);
    setWarning(null);
    const input = buildOnboardingInput({
      name,
      email,
      phone,
      cvText,
      skills,
      languages,
      location,
      contractTypes,
      radiusKm,
      remote,
      maxTravelKm,
      workRegions,
      salaryMin,
      salaryMax,
      salaryPeriod,
      hoursPerWeek,
      workMode,
      availability,
      willingToRelocate,
    });
    startTransition(async () => {
      const res = await createCandidateAction({
        ...input,
        consent,
        tenantId,
        richProfile: richProfileRef.current ?? undefined,
        note: note.trim() || undefined,
        // Carry the stage-2 8vance parse handle so the server can generate
        // PENDING CV-suggestions off the response path (no form mutation here).
        enrichToken: enrichToken ?? undefined,
      });
      if (!res.ok) {
        setError(t(`error_${res.reason}`));
        return;
      }
      if (res.warning) {
        // Saved, but sync/match needs a retry — still go to the match screen.
        router.push(`/app/candidates/${res.candidateId}/match`);
        return;
      }
      router.push(`/app/candidates/${res.candidateId}/match`);
    });
  }

  return (
    <div className="space-y-6">
      <ol className="flex flex-wrap items-center gap-3 text-sm">
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

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        {step === 0 ? (
          <div className="space-y-5">
            <div>
              <label htmlFor="cand-name" className="block text-sm font-medium text-zinc-700">
                {t('nameLabel')}<span className="ml-1 text-red-500">*</span>
              </label>
              <input
                id="cand-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('namePlaceholder')}
                className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="cand-email" className="block text-sm font-medium text-zinc-700">
                  {t('emailLabel')}<span className="ml-1 text-red-500">*</span>
                </label>
                <input
                  id="cand-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('emailPlaceholder')}
                  className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="cand-phone" className="block text-sm font-medium text-zinc-700">
                  {t('phoneLabel')}<span className="ml-1 text-red-500">*</span>
                </label>
                <input
                  id="cand-phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
                />
              </div>
            </div>
            <div>
              <label htmlFor="cand-pool" className="block text-sm font-medium text-zinc-700">
                {t('poolLabel')}<span className="ml-1 text-red-500">*</span>
              </label>
              <select
                id="cand-pool"
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
              >
                <option value="">{t('poolPlaceholder')}</option>
                {tenantOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-zinc-500">{t('poolHint')}</p>
            </div>
            <div>
              <label htmlFor="cand-cv" className="block text-sm font-medium text-zinc-700">
                {t('cvLabel')}
              </label>
              <textarea
                id="cand-cv"
                value={cvText}
                onChange={(e) => setCvText(e.target.value)}
                rows={6}
                placeholder={t('cvPlaceholder')}
                className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
              />
              <p className="mt-1 text-xs text-zinc-500">{t('cvHint')}</p>
            </div>
            <div>
              <label htmlFor="cand-note" className="block text-sm font-medium text-zinc-700">
                {t('notesLabel')}
              </label>
              <textarea
                id="cand-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder={t('notesPlaceholder')}
                className="mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none"
              />
              <p className="mt-1 text-xs text-zinc-500">{t('notesHint')}</p>
            </div>
            <div>
              <label htmlFor="cand-cv-file" className="block text-sm font-medium text-zinc-700">
                {t('cvUploadLabel')}
              </label>
              <input
                id="cand-cv-file"
                type="file"
                accept=".pdf,.doc,.docx,.rtf,.txt"
                disabled={!tenantId || cvUploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadCv(f);
                  // Reset so re-selecting the same file fires onChange again.
                  e.target.value = '';
                }}
                className="mt-1 block w-full text-sm text-zinc-700 file:mr-3 file:rounded-lg file:border file:border-zinc-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-800 hover:file:bg-zinc-100 disabled:opacity-50"
              />
              <p className="mt-1 text-xs text-zinc-500">{t('cvUploadHint')}</p>
              {!tenantId ? (
                <p className="mt-1 text-xs text-amber-600">{t('pickPoolFirst')}</p>
              ) : null}
              {cvUploading ? (
                <div className="mt-2" role="status" aria-live="polite">
                  <p className="text-xs text-zinc-600">
                    {t('cvUploading', { name: cvUploadName ?? '' })}
                  </p>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200">
                    <div
                      className="h-full rounded-full bg-zinc-900 transition-[width] duration-500 ease-out"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                  <p className="mt-1 text-[11px] text-zinc-400">{t('cvUploadingHint')}</p>
                </div>
              ) : null}
              {!cvUploading && cvUploadName && !cvUploadError ? (
                <p className="mt-1 text-xs text-emerald-700" role="status">
                  {t(cvUploadOcr ? 'cvUploadDoneOcr' : 'cvUploadDone', { name: cvUploadName })}
                </p>
              ) : null}
              {cvUploadError ? (
                <p className="mt-1 text-xs text-red-600" role="alert">
                  {cvUploadError}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="space-y-5">
            {cvText.trim().length >= 10 ? (
              <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-zinc-600">{t('cvExtractHint')}</p>
                  <button
                    type="button"
                    onClick={extractFromCv}
                    disabled={cvExtracting || !tenantId}
                    className="shrink-0 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-50"
                  >
                    {cvExtracting ? t('cvExtractWorking') : t('cvExtractButton')}
                  </button>
                </div>
                {cvExtractMsg ? (
                  <p className="mt-2 text-xs text-emerald-700" role="status">
                    {cvExtractMsg}
                  </p>
                ) : null}
              </div>
            ) : null}
            <div>
              <Autocomplete<{ id: number; name: string }>
                label={t('addSkillLabel')}
                placeholder={t('skillPlaceholder')}
                selectedLabel=""
                onSelect={(opt) => {
                  if (!opt) return;
                  setSkills((prev) =>
                    prev.some((s) => s.id === opt.id) || prev.length >= 40
                      ? prev
                      // Manually-added skill starts UNKNOWN (level 0) — the
                      // recruiter sets proficiency via the slider; no fake 3.
                      : [...prev, { id: opt.id, name: opt.name, level: 0, must_have: false }],
                  );
                }}
                fetcher={fetchSkill}
                renderItem={(i) => i.name}
                itemKey={(i) => String(i.id)}
                hint={t('skillHint', { count: skills.length })}
                disabled={!tenantId}
                clearOnSelect
              />
              {!tenantId ? (
                <p className="mt-1 text-xs text-amber-600">{t('pickPoolFirst')}</p>
              ) : null}
            </div>
            <SkillList
              skills={skills}
              onRemove={(id) => setSkills((p) => p.filter((s) => s.id !== id))}
              onUpdate={(id, patch) =>
                setSkills((p) => p.map((s) => (s.id === id ? { ...s, ...patch } : s)))
              }
            />
          </div>
        ) : null}

        {step === 2 ? (
          <div className="space-y-5">
            <Autocomplete<LanguageOption>
              label={t('languagesLabel')}
              placeholder={t('languagesPlaceholder')}
              selectedLabel=""
              onSelect={(opt) => {
                if (!opt) return;
                setLanguages((prev) =>
                  prev.some((l) => l.id === opt.id) || prev.length >= 10
                    ? prev
                    : [...prev, { id: opt.id, name: opt.name }],
                );
              }}
              fetcher={fetchLanguage}
              renderItem={(i) => i.name}
              itemKey={(i) => String(i.id)}
              hint={t('languagesHint')}
              disabled={!tenantId}
            />
            {languages.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {languages.map((l) => (
                  <button
                    type="button"
                    key={l.id}
                    onClick={() => setLanguages((p) => p.filter((x) => x.id !== l.id))}
                    className="rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
                  >
                    {l.name} ×
                  </button>
                ))}
              </div>
            ) : null}
            <LocationField
              label={t('locationLabel')}
              placeholder={t('locationPlaceholder')}
              value={location}
              onSelect={setLocation}
              fetcher={fetchLocation}
              disabled={!tenantId}
            />
          </div>
        ) : null}

        {step === 3 ? (
          <PreferenceControls>
            {/* Upload data-check — flags parsed gaps + un-captured tacit info. */}
            <DataCheckPanel
              check={{
                name,
                skillCount: skills.length,
                hasLocation: !!location,
                hasEducation,
                hasWorkPreference:
                  typeof maxTravelKm === 'number' || !!workMode || !!availability,
                hasRegion: workRegions.length > 0,
                hasSalary: salaryMin != null || salaryMax != null,
              }}
            />

            <ContractTypePicker value={contractTypes} onChange={setContractTypes} />

            {/* Max travel — pre-filled by the education-level default hint. */}
            <div>
              <RadiusSlider
                value={maxTravelKm ?? travelHintKm ?? 30}
                onChange={(v) => {
                  // 0 = "no explicit radius": store UNSET so the server keeps
                  // applying the education-level heuristic (never explicit 0).
                  setMaxTravelKm(v === 0 ? undefined : v);
                  setRadiusKm(v);
                }}
              />
              <p className="mt-1 text-xs text-zinc-500">{t('travelHint')}</p>
            </div>

            <WorkModePicker value={workMode} onChange={setWorkMode} />
            <AvailabilityPicker value={availability} onChange={setAvailability} />
            <WorkRegionsField value={workRegions} onChange={setWorkRegions} />
            <SalaryRange
              min={salaryMin}
              max={salaryMax}
              period={salaryPeriod}
              onChange={(patch) => {
                if ('min' in patch) setSalaryMin(patch.min);
                if ('max' in patch) setSalaryMax(patch.max);
                if (patch.period) setSalaryPeriod(patch.period);
              }}
            />
            <HoursPerWeekField value={hoursPerWeek} onChange={setHoursPerWeek} />
            <label className="flex items-center gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={willingToRelocate}
                onChange={(e) => setWillingToRelocate(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-300"
              />
              {t('relocateLabel')}
            </label>

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
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-zinc-300"
                />
                <span>
                  {t('consentRecruiterLabel')}
                  <span className="ml-1 text-red-500">*</span>
                </span>
              </label>
            </div>
          </PreferenceControls>
        ) : null}
      </section>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}
      {warning ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {warning}
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0 || pending}
          className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
        >
          {t('back')}
        </button>
        {step < STEP_COUNT - 1 ? (
          <button
            type="button"
            onClick={() => setStep((s) => s + 1)}
            disabled={!canAdvance || pending}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
          >
            {t('continue')}
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit || pending}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
          >
            {pending ? t('submitting') : t('submit')}
          </button>
        )}
      </div>
    </div>
  );
}

// Keep the constant array referenced so it isn't tree-shaken unexpectedly and
// remains a single source of truth shared with the portal form.
void CONTRACT_TYPES;
