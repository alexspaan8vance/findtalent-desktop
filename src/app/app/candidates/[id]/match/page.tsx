/**
 * Candidate → jobs match screen (server component).
 *
 * Inverse of the job→talent shortlist: a single candidate is matched against
 * vacancies pulled from configured sources (own 8vance pool + open-market
 * JobDigger). Many open-market vacancies are posted by uitzendbureaus; the
 * headline UX is a "hide staffing agencies" toggle handled client-side.
 *
 * This component loads the candidate (org-guarded), the latest match run and
 * its jobs ordered by score desc, then hands everything to the client view.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { after } from 'next/server';
import { getTranslations, getLocale } from 'next-intl/server';

import { requireCandidatesAccess } from '@/lib/auth-helpers';
import { prisma } from '@/lib/db';
import { getOrCreateUserOrg } from '@/lib/org';
import type { AgencyReason } from '@/lib/match/staffing';
import type { NormalizedJobMatch } from '@/lib/candidate/normalize-job';

import type { CandidateProfileJson, CvProfile } from '@/lib/candidate/cv-ai';
import { fetchLiveTalent, dataQualityFrom } from '@/lib/candidate/profile-extras';
import {
  CandidateProfile,
  DataQualityStrip,
  SyncBadge,
  type StoredProfile,
  type ProfileLabels,
} from '@/components/candidate/candidate-profile';
import { RecruiterNote } from '@/components/candidate/recruiter-note';
import {
  CandidateEditor,
  type EditableSkill,
  type CandidateEditorLabels,
} from '@/components/candidate/candidate-editor';
import { vanceClientForTenant } from '@/lib/eightvance/tenant-client';
import {
  autoResyncIfEligible,
  generateSuggestionsFromTalent,
  reconcileTalentLink,
} from '@/lib/candidate/service';
import type { TalentSkill } from '@/lib/eightvance/types';

import type { CvSuggestion } from '@/lib/candidate/cv-suggestions';

import { MatchClient, type JobRow } from './match-client';
import { PreferencesSummary } from './preferences-summary';
import {
  highestEduTier,
  travelFacetDefaultForTier,
  type CandidatePreferences,
} from '@/lib/candidate/preferences';
import { SuggestionsPanel } from './suggestions-panel';
import { updateCandidateNote, updateTalentAction } from './actions';
import { CandidateGdprControls } from '../candidate-gdpr-controls';

/**
 * The CV-suggestions review panel is behind a feature flag (default OFF). The
 * app gates optional features on env vars (see src/lib/env.ts); the panel only
 * renders when `CV_SUGGESTIONS=true`. Read here (server-side) so the client
 * component never ships when the flag is off.
 */
const CV_SUGGESTIONS_ENABLED = process.env.CV_SUGGESTIONS === 'true';

/** A candidate created within this window may still be having its CV parsed. */
const RECENTLY_CREATED_MS = 2 * 60 * 1000;

/**
 * Request-time check for the recent-creation window (module helper, not in the
 * component body, so render stays pure).
 */
function isRecentlyCreated(createdAt: Date): boolean {
  return Date.now() - new Date(createdAt).getTime() < RECENTLY_CREATED_MS;
}

/** 8vance proficiency id (23..27) → star string for the meter. */
function proficiencyStars(id: number | null | undefined): string {
  switch (id) {
    case 23:
      return '⭐';
    case 24:
      return '⭐⭐';
    case 25:
      return '⭐⭐⭐';
    case 26:
      return '⭐⭐⭐⭐';
    case 27:
      return '⭐⭐⭐⭐⭐';
    default:
      // Unknown / non-canonical proficiency → empty meter, never a fake mid ⭐⭐⭐.
      return '';
  }
}

/** A resolved "candidate is in this project's pipeline" link. */
interface PipelineLink {
  projectId: string;
  projectTitle: string;
  stage: string;
}

/**
 * Whether an UNSYNCED candidate now qualifies for an automatic re-sync: consent
 * present AND >= 3 resolved skills (same `profileJson.skills` shape the sync
 * reads). Mirrors the guards in `syncCandidateToVance` so the after() retry only
 * fires when the sync would actually succeed. Caller already checked the
 * eightvanceTalentId == null half.
 */
function isResyncEligible(
  consentGivenAt: Date | null,
  profileJson: unknown,
): boolean {
  if (consentGivenAt == null) return false;
  const skills = (profileJson as { skills?: unknown[] } | null)?.skills;
  return Array.isArray(skills) && skills.length >= 3;
}

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function CandidateMatchPage({
  params,
}: PageProps): Promise<React.ReactElement> {
  const { id } = await params;
  const session = await requireCandidatesAccess();
  const t = await getTranslations('candidateMatch');
  const uiLocale = await getLocale();

  const candidate = await prisma.candidate.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      organizationId: true,
      createdByUserId: true,
      tenantId: true,
      profileJson: true,
      // Captured work-preferences (the "recruiter's head" data) — shown in a
      // read-only summary so the tacit info is visible, not write-only.
      preferencesJson: true,
      // Raw CV text (PII auto-decrypted by the Prisma extension on read) for the
      // "Full CV text" preview; eightvanceTalentId drives the "synced" UI state.
      cvText: true,
      eightvanceTalentId: true,
      // Drives the auto re-sync eligibility check (consent is a hard sync gate).
      consentGivenAt: true,
      // CV-suggestions review panel (Phase 4, behind the cv_suggestions flag):
      // the persisted "richer-wins" diff + createdAt for the "still generating"
      // poll hint.
      cvSuggestionsJson: true,
      cvSuggestionsStatus: true,
      createdAt: true,
    },
  });
  if (!candidate) notFound();

  // The own pool == this tenant's 8vance company; everything else is open market.
  const ownCompanyId = candidate.tenantId
    ? (await prisma.tenant.findUnique({
        where: { id: candidate.tenantId },
        select: { eightvanceCompanyId: true },
      }))?.eightvanceCompanyId ?? null
    : null;

  // Org guard: caller created the candidate, or it is shared via their org.
  let allowed = candidate.createdByUserId === session.id;
  if (!allowed && candidate.organizationId) {
    const orgId = await getOrCreateUserOrg(session.id);
    allowed = candidate.organizationId === orgId;
  }
  if (!allowed) notFound();

  // The owner's org — also used to scope the pipeline query (project.userId OR
  // project.organizationId). Computed once even if the guard already resolved
  // it, so the query below never N+1s per project.
  const orgId = await getOrCreateUserOrg(session.id);

  // Pipeline links: every Match within one of the OWNER's projects (own or
  // shared via org) whose eightvanceTalentId is this candidate's. One query
  // joins Project (for the owner filter + title) and the ShortlistEntry stage
  // (owner-authored, with its configurable stage label) — no N+1.
  const pipelineLinks: PipelineLink[] = [];
  if (candidate.eightvanceTalentId != null) {
    const matches = await prisma.match.findMany({
      where: {
        eightvanceTalentId: candidate.eightvanceTalentId,
        project: {
          OR: [{ userId: session.id }, { organizationId: orgId }],
        },
      },
      select: {
        project: { select: { id: true, title: true } },
        shortlistEntries: {
          where: { userId: session.id },
          select: {
            stage: true,
            stageRef: { select: { name: true } },
          },
          take: 1,
        },
      },
    });
    for (const m of matches) {
      const entry = m.shortlistEntries[0];
      const stage = entry?.stageRef?.name ?? entry?.stage ?? t('pipeline.stageNew');
      pipelineLinks.push({
        projectId: m.project.id,
        projectTitle: m.project.title,
        stage,
      });
    }
  }

  // Latest run + its jobs (best match first).
  const run = await prisma.candidateMatchRun.findFirst({
    where: { candidateId: id },
    orderBy: { createdAt: 'desc' },
    include: {
      jobs: {
        // Reliable (own-pool) scores first, then by score. Cross-company rows
        // (unreliable degenerate score) sink below real matches instead of
        // floating to the top on a fake 100%.
        orderBy: [{ scoreReliable: 'desc' }, { score: 'desc' }],
      },
    },
  });

  // Auto re-sync recovery: a candidate whose first sync was blocked (degraded
  // CV parse → <3 skills, or late consent) never retries on profile edit and
  // stays unsynced forever. When this page loads them still unsynced BUT now
  // eligible, schedule a best-effort sync OFF the response path. We don't await
  // it or change this render — the NEXT visit shows the synced state.
  // Also self-heal a DEAD link: if the linked 8vance talent was deleted (e.g. a
  // recruiter pruned duplicate pool talents), reconcileTalentLink unlinks it so
  // autoResyncIfEligible can re-create a fresh one. Reconcile runs first (only
  // does work when synced); autoResync then re-syncs if the row is now unlinked
  // + eligible. Scheduled OFF the response path — the NEXT visit shows the fix.
  if (
    candidate.eightvanceTalentId != null ||
    isResyncEligible(candidate.consentGivenAt, candidate.profileJson)
  ) {
    after(async () => {
      if (candidate.eightvanceTalentId != null) {
        await reconcileTalentLink(candidate.id);
      }
      await autoResyncIfEligible(candidate.id);
      // Populate CV-review suggestions from 8vance's own server-side parse of the
      // CV (read back off the synced talent's sub-resources). The reparse=true
      // upload in syncCandidateToVance is async, so we generate on each visit —
      // the first visit AFTER the parse finishes fills them. Only when already
      // synced + no suggestions yet (best-effort, never overwrites a review).
      if (
        candidate.eightvanceTalentId != null &&
        (!Array.isArray(candidate.cvSuggestionsJson) ||
          candidate.cvSuggestionsJson.length === 0)
      ) {
        await generateSuggestionsFromTalent(candidate.id);
      }
    });
  }

  const rows: JobRow[] = (run?.jobs ?? []).map((j) => {
    // payloadJson is the persisted NormalizedJobMatch; it carries the extra
    // facet fields (remote/publishedAt/locationCity) folded in from
    // /job/{id}/extended/. Prefer the dedicated column when present.
    const payload = (j.payloadJson ?? {}) as Partial<NormalizedJobMatch>;
    return {
      id: j.id,
      eightvanceJobId: j.eightvanceJobId,
      score: j.score,
      scoreReliable: j.scoreReliable,
      title: j.title,
      employerName: j.employerName ?? payload.employerName ?? null,
      source: j.source ?? payload.source ?? null,
      contractType: j.contractType ?? payload.contractType ?? null,
      locationCity: j.locationCity ?? payload.locationCity ?? null,
      locationLabel: j.locationLabel,
      remote: typeof payload.remote === 'boolean' ? payload.remote : null,
      publishedAt:
        typeof payload.publishedAt === 'string' ? payload.publishedAt : null,
      // Coarse travel buckets folded into the payload server-side (bucket labels
      // only — never coords/minutes). Absent for jobs without coords = unknown.
      travel: payload.travel ?? undefined,
      lat: typeof payload.lat === 'number' ? payload.lat : null,
      lng: typeof payload.lng === 'number' ? payload.lng : null,
      salaryLow: typeof payload.salaryLow === 'number' ? payload.salaryLow : null,
      salaryHigh: typeof payload.salaryHigh === 'number' ? payload.salaryHigh : null,
      hoursMin: typeof payload.hoursMin === 'number' ? payload.hoursMin : null,
      hoursMax: typeof payload.hoursMax === 'number' ? payload.hoursMax : null,
      isStaffingAgency: j.isStaffingAgency,
      agencyScore: j.agencyScore,
      isOwnPool: ownCompanyId !== null && j.employerCompanyId === ownCompanyId,
      agencyReasons: Array.isArray(j.agencyReasonsJson)
        ? (j.agencyReasonsJson as unknown as AgencyReason[])
        : [],
    };
  });

  // Candidate home location (from the CV) — seeds the city filter + the map's
  // origin marker. Coords come from profileJson.detailed_location (the 8vance
  // create payload) or the nested CV location; city drives the default filter.
  const pjLoc = (candidate.profileJson ?? {}) as {
    detailed_location?: { city?: string; latitude?: unknown; longitude?: unknown };
    cv?: { location?: { city?: string; region?: string } };
  };
  const dl = pjLoc.detailed_location;
  const oLat = dl?.latitude != null ? Number(dl.latitude) : NaN;
  const oLng = dl?.longitude != null ? Number(dl.longitude) : NaN;
  const matchOrigin = {
    city: dl?.city ?? pjLoc.cv?.location?.city ?? null,
    lat: Number.isFinite(oLat) && oLat !== 0 ? oLat : null,
    lng: Number.isFinite(oLng) && oLng !== 0 ? oLng : null,
  };
  // Education-level travel-facet default ("won't drive an hour"): compute the
  // highest tier from the parsed CV education.
  const eduForTravel =
    (candidate.profileJson as { education?: Array<{ degree?: string | null }> })?.education ??
    (candidate.profileJson as { cv?: { education?: Array<{ degree?: string | null }> } })?.cv
      ?.education ??
    null;
  const eduTravelDefault = travelFacetDefaultForTier(highestEduTier(eduForTravel));

  // Sources that couldn't be fully searched this run — a feed too large to match
  // synchronously (413), a per-source timeout, or dropped by the source cap. The
  // run persists them under sourcesJson.skipped; surface the count so the UI can
  // tell the recruiter to narrow the source selection for a complete match.
  const runSources = run?.sourcesJson as
    | {
        skipped?: Array<{ slug: string; reason: string }>;
        counts?: Array<{ slug: string; n: number; isOwnPool: boolean; bounded: boolean }>;
        centre?: {
          lat: number;
          lng: number;
          label: string | null;
          kind: 'relocation' | 'region' | 'home';
        } | null;
      }
    | null
    | undefined;
  const skippedSourceCount = Array.isArray(runSources?.skipped)
    ? runSources.skipped.length
    : 0;
  const sourceCounts = Array.isArray(runSources?.counts) ? runSources.counts : [];
  // The centre the match actually ran around (relocation city / work region /
  // home). Falls back to the candidate's CV home so the map/distance always have
  // an origin. The label + kind drive the "Matched around {city}" banner.
  const runCentre = runSources?.centre ?? null;
  const matchCentre =
    runCentre && Number.isFinite(runCentre.lat) && Number.isFinite(runCentre.lng)
      ? runCentre
      : matchOrigin.lat != null && matchOrigin.lng != null
        ? { lat: matchOrigin.lat, lng: matchOrigin.lng, label: matchOrigin.city, kind: 'home' as const }
        : null;
  // The distinct skip reasons (feed_too_large / filter_required / timeout / …),
  // so the UI can explain WHY — most importantly `filter_required`, which tells
  // the recruiter a large open-market feed (JobDigger) was skipped because the
  // candidate has no location to bound the search.
  const skippedReasons = Array.isArray(runSources?.skipped)
    ? Array.from(new Set(runSources.skipped.map((s) => s.reason)))
    : [];

  // Read-only "CV-profiel" — the extracted rich profile persisted by the
  // CV-parse + sync flow. Shape: CandidateProfileJson (about / languages /
  // education / employment / certifications). All fields are optional.
  // The rich profile is nested under profileJson.cv (kept separate from the
  // 8vance TalentCreatePayload sync fields at the top level).
  // The persisted `.cv` is the full extracted CvProfile (self-onboard path
  // writes `resolved.profile`), so it carries the skill buckets + about/etc.
  // CandidateProfileJson omits the skill arrays, so read as Partial<CvProfile>.
  const profile =
    ((candidate.profileJson as { cv?: Partial<CvProfile> } | null)?.cv ?? null) as
      | (Partial<CvProfile> & CandidateProfileJson)
      | null;
  const languages = Array.isArray(profile?.languages) ? profile.languages : [];
  const education = Array.isArray(profile?.education) ? profile.education : [];
  const employment = Array.isArray(profile?.employment) ? profile.employment : [];
  const certifications = Array.isArray(profile?.certifications) ? profile.certifications : [];
  const hardSkills = Array.isArray(profile?.hardSkills) ? profile.hardSkills : [];
  const softSkills = Array.isArray(profile?.softSkills) ? profile.softSkills : [];
  const knowledge = Array.isArray(profile?.knowledge) ? profile.knowledge : [];
  const cvText =
    typeof candidate.cvText === 'string' && candidate.cvText.trim().length > 0
      ? candidate.cvText
      : null;
  const hasProfile =
    !!profile?.about ||
    languages.length > 0 ||
    education.length > 0 ||
    employment.length > 0 ||
    certifications.length > 0 ||
    hardSkills.length > 0 ||
    softSkills.length > 0 ||
    knowledge.length > 0 ||
    cvText !== null;

  // Recruiter note (synced to 8vance about_me on the next sync). Top-level on
  // profileJson, sibling to `.cv`.
  const note =
    typeof (candidate.profileJson as { note?: unknown } | null)?.note === 'string'
      ? ((candidate.profileJson as { note: string }).note)
      : '';

  // Best-effort LIVE 8vance snapshot — never blocks the page (each sub-read is
  // try/caught inside fetchLiveTalent; the whole thing falls back to stored
  // profileJson on any failure). Drives the data-quality strip + live skills.
  const live = await fetchLiveTalent(
    candidate.tenantId,
    candidate.eightvanceTalentId,
  );
  const storedSkillCount = hardSkills.length + softSkills.length + knowledge.length;
  const quality = dataQualityFrom(
    candidate.eightvanceTalentId,
    live,
    storedSkillCount,
  );

  // Editable skill rows — the EDIT-mode UI needs each skill's JUNCTION-row id
  // (the DELETE target) which the normalized `live.skills` discards. Read the
  // raw `/talent/{id}/skill/` rows directly (owner path; best-effort: any
  // failure just disables per-skill removal). Stored hard/soft/knowledge skills
  // surface too, but without a row id (rowId null → removal unavailable).
  let editableSkills: EditableSkill[] = [];
  if (candidate.tenantId && candidate.eightvanceTalentId != null) {
    try {
      const client = await vanceClientForTenant(candidate.tenantId);
      const rows: TalentSkill[] = await client.talent.getSkills(
        candidate.eightvanceTalentId,
      );
      editableSkills = rows.map((s) => {
        const rec = s as Record<string, unknown>;
        const name =
          (typeof rec.skill_name === 'string' && rec.skill_name.trim()) ||
          (typeof rec.name === 'string' && rec.name.trim()) ||
          (typeof s.skill === 'number' ? `#${s.skill}` : 'Skill');
        const profId = s.proficiency_id ?? s.proficiency ?? null;
        return {
          rowId: typeof s.id === 'number' ? s.id : null,
          name,
          proficiencyLabel: proficiencyStars(profId),
          // 23..27 → 1..5 (0 when unknown so the control starts empty).
          proficiencyLevel:
            typeof profId === 'number' ? Math.max(0, Math.min(5, profId - 22)) : 0,
          skillId: typeof s.skill === 'number' ? s.skill : null,
        };
      });
    } catch {
      // best-effort — fall back to stored skills below
    }
  }
  if (editableSkills.length === 0) {
    editableSkills = [...hardSkills, ...softSkills, ...knowledge].map((name) => ({
      rowId: null,
      name,
      proficiencyLabel: '',
      proficiencyLevel: 0,
      skillId: null,
    }));
  }

  const editorLabels: CandidateEditorLabels = {
    title: t('edit.title'),
    edit: t('edit.edit'),
    cancel: t('edit.cancel'),
    save: t('edit.save'),
    saving: t('edit.saving'),
    saved: t('edit.saved'),
    errFailed: t('edit.errFailed'),
    errPartial: t('edit.errPartial'),
    skillsTitle: t('edit.skillsTitle'),
    skillAddPlaceholder: t('edit.skillAddPlaceholder'),
    skillAdd: t('edit.skillAdd'),
    skillSearching: t('edit.skillSearching'),
    skillNoResults: t('edit.skillNoResults'),
    skillRemove: t('edit.skillRemove'),
    skillRemoveUnavailable: t('edit.skillRemoveUnavailable'),
    pendingAdd: t('edit.pendingAdd'),
    pendingRemove: t('edit.pendingRemove'),
    // skillLevelAria / skillLevel are parameterized — the editor (a client
    // component) translates them itself; passing them as functions here would
    // crash the RSC server→client boundary (error digest 3046561624).
    expTitle: t('edit.expTitle'),
    expRole: t('edit.expRole'),
    expCompany: t('edit.expCompany'),
    expStart: t('edit.expStart'),
    expEnd: t('edit.expEnd'),
    expCurrent: t('edit.expCurrent'),
    expDescription: t('edit.expDescription'),
    expAdd: t('edit.expAdd'),
    eduTitle: t('edit.eduTitle'),
    eduSchool: t('edit.eduSchool'),
    eduStart: t('edit.eduStart'),
    eduEnd: t('edit.eduEnd'),
    eduAdd: t('edit.eduAdd'),
    eduApiNote: t('edit.eduApiNote'),
    aboutTitle: t('edit.aboutTitle'),
    aboutHint: t('edit.aboutHint'),
  };

  const stored: StoredProfile = {
    about: profile?.about ?? null,
    hardSkills,
    softSkills,
    knowledge,
    education,
    employment,
    languages,
    certifications,
    location: profile?.location ?? null,
    email: candidate.email ?? null,
    phone: candidate.phone ?? null,
  };

  const profileLabels: ProfileLabels = {
    about: t('cvProfile.about'),
    skills: t('cvProfile.skills'),
    hardSkills: t('cvProfile.hardSkills'),
    softSkills: t('cvProfile.softSkills'),
    knowledge: t('cvProfile.knowledge'),
    education: t('cvProfile.education'),
    employment: t('cvProfile.employment'),
    languages: t('cvProfile.languages'),
    certifications: t('cvProfile.certifications'),
    location: t('profile.location'),
    contact: t('profile.contact'),
    email: t('profile.email'),
    phone: t('profile.phone'),
    current: t('cvProfile.current'),
    level: (level: number) => t('cvProfile.level', { level }),
    liveBadge: t('profile.liveBadge'),
    storedBadge: t('profile.storedBadge'),
    dqTitle: t('dataQuality.title'),
    dqSynced: t('dataQuality.synced'),
    dqNotSynced: t('dataQuality.notSynced'),
    dqHasName: t('dataQuality.hasName'),
    dqNoName: t('dataQuality.noName'),
    dqMatchable: t('dataQuality.matchable'),
    dqNotMatchable: t('dataQuality.notMatchable'),
    dqMatchableUnknown: t('dataQuality.matchableUnknown'),
    dqSkills: (count: number) => t('dataQuality.skills', { count }),
    syncedBadge: (talentId: number) => t('syncBadge.synced', { id: talentId }),
    notSyncedBadge: t('syncBadge.notSynced'),
  };
  const hasFullProfile = hasProfile || candidate.email != null || candidate.phone != null;

  // CV-suggestions review panel data (flag-gated). Pending suggestions from the
  // persisted "richer-wins" diff + a "recently created" hint so the panel can
  // poll while the 8vance parse may still be generating them.
  const pendingSuggestions: CvSuggestion[] = CV_SUGGESTIONS_ENABLED
    ? (Array.isArray(candidate.cvSuggestionsJson)
        ? (candidate.cvSuggestionsJson as unknown as CvSuggestion[])
        : []
      ).filter((s) => s?.status === 'pending')
    : [];
  const recentlyCreated = isRecentlyCreated(candidate.createdAt);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ft-muted)]">
            {t('eyebrow')}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-[var(--ft-ink)]">
              {candidate.name}
            </h1>
            <SyncBadge talentId={candidate.eightvanceTalentId} labels={profileLabels} />
          </div>
          <div className="mt-3">
            <DataQualityStrip quality={quality} labels={profileLabels} />
          </div>
        </div>
        <CandidateGdprControls candidateId={candidate.id} />
      </header>

      {pipelineLinks.length > 0 && (
        <section className="mt-6 rounded-xl border border-[var(--ft-border)] bg-[var(--ft-surface-2)] p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--ft-muted)]">
            {t('pipeline.title')}
          </h2>
          <ul className="mt-2 flex flex-col gap-1.5">
            {pipelineLinks.map((p) => (
              <li key={p.projectId}>
                <Link
                  href={`/app/projects/${p.projectId}/pipeline`}
                  className="inline-flex items-center gap-2 text-sm font-medium text-[var(--ft-accent-strong)] underline-offset-2 hover:underline"
                >
                  <span className="truncate">{p.projectTitle}</span>
                  <span className="rounded-full border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-2 py-0.5 text-[11px] font-semibold">
                    {p.stage}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-6">
        <RecruiterNote
          candidateId={candidate.id}
          initialNote={note}
          save={updateCandidateNote}
          labels={{
            title: t('note.title'),
            empty: t('note.empty'),
            edit: t('note.edit'),
            save: t('note.save'),
            saving: t('note.saving'),
            cancel: t('note.cancel'),
            errTooLong: t('note.errTooLong'),
            errFailed: t('note.errFailed'),
            hint: t('note.hint'),
          }}
        />
      </div>

      {CV_SUGGESTIONS_ENABLED && (
        <SuggestionsPanel
          candidateId={candidate.id}
          suggestions={pendingSuggestions}
          recentlyCreated={recentlyCreated}
          initialStatus={
            candidate.cvSuggestionsStatus === 'ready' ||
            candidate.cvSuggestionsStatus === 'none' ||
            candidate.cvSuggestionsStatus === 'error' ||
            candidate.cvSuggestionsStatus === 'pending'
              ? candidate.cvSuggestionsStatus
              : null
          }
        />
      )}

      {(hasFullProfile || live.reachable) && (
        <section className="mt-6 rounded-xl border border-[var(--ft-border)] bg-[var(--ft-surface)] p-5">
          <h2 className="mb-4 text-sm font-semibold text-[var(--ft-ink)]">
            {t('profile.title')}
          </h2>
          <CandidateProfile
            stored={stored}
            live={{
              skills: live.skills,
              education: live.education,
              experience: live.experience,
              languages: live.languages,
              location: live.location,
              reachable: live.reachable,
            }}
            labels={profileLabels}
          />

          {candidate.eightvanceTalentId != null && (
            <CandidateEditor
              candidateId={candidate.id}
              initialAbout={profile?.about ?? ''}
              currentSkills={editableSkills}
              locale={uiLocale}
              labels={editorLabels}
              save={updateTalentAction}
            />
          )}

          {cvText && (
            <details className="mt-6 rounded-lg border border-[var(--ft-border)] bg-[var(--ft-surface-2)] open:shadow-sm">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--ft-muted)]">
                {t('cvProfile.fullText')}
              </summary>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-[var(--ft-border)] px-3 py-3 text-xs leading-relaxed text-[var(--ft-ink)]">
                {cvText}
              </pre>
            </details>
          )}
        </section>
      )}

      <div className="mt-8">
        <PreferencesSummary
          preferences={
            (candidate.preferencesJson ?? null) as Partial<CandidatePreferences> | null
          }
          education={
            (
              (candidate.profileJson ?? {}) as {
                education?: Array<{ degree?: string | null }>;
                cv?: { education?: Array<{ degree?: string | null }> };
              }
            ).education ??
            (
              (candidate.profileJson ?? {}) as {
                cv?: { education?: Array<{ degree?: string | null }> };
              }
            ).cv?.education ??
            null
          }
        />
      </div>
      <div className="mt-8">
      <MatchClient
        candidateId={candidate.id}
        runStatus={run?.status ?? null}
        rows={rows}
        synced={candidate.eightvanceTalentId != null}
        nowIso={new Date().toISOString()}
        skippedCount={skippedSourceCount}
        skippedReasons={skippedReasons}
        originCity={matchOrigin.city}
        originLat={matchOrigin.lat}
        originLng={matchOrigin.lng}
        matchCentre={matchCentre}
        sourceCounts={sourceCounts}
        homeCity={matchOrigin.city}
        preferences={
          (candidate.preferencesJson ?? null) as {
            contractTypes?: string[];
            workMode?: 'office' | 'hybrid' | 'remote';
            hoursPerWeek?: number;
            salary?: { min?: number; max?: number; period?: 'hour' | 'month' | 'year' };
          } | null
        }
        defaultTravelMode={eduTravelDefault?.mode ?? null}
        defaultTravelMax={eduTravelDefault?.max}
      />
      </div>
    </main>
  );
}
