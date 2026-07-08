'use server';

/**
 * Server actions for the candidate→jobs match screen.
 *
 * `rematchAction` re-runs the inverse match for a candidate (own-pool +
 * open-market sources), then revalidates the match route so the freshly
 * created CandidateMatchRun + its jobs render. Every action verifies the
 * candidate belongs to the caller's org (or was created by them) before
 * touching anything — Server Actions are reachable via direct POST, so the
 * guard lives inside the action, not only in the page.
 */

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import type { Prisma } from '@prisma/client';

import { requireUser } from '@/lib/auth-helpers';
import { prisma } from '@/lib/db';
import { getOrCreateUserOrg } from '@/lib/org';
import { reportError } from '@/lib/observability/report';
import {
  createMatchRun,
  executeMatchRun,
  syncCandidateToVance,
  SyncError,
} from '@/lib/candidate/service';
import { vanceClientForTenant } from '@/lib/eightvance/tenant-client';
import { VanceError } from '@/lib/eightvance/errors';
import { htmlToText, isHttpUrl } from '@/lib/text/html-to-text';
import { readableVacancyUrl } from '@/lib/job-url';

/**
 * Why a rematch could not start (or finish kicking off):
 *  - forbidden   — caller doesn't own/share the candidate.
 *  - not_found   — candidate row vanished.
 *  - no_consent  — GDPR consent missing, 8vance sync blocked.
 *  - no_skills   — fewer than 3 resolved skills, sync blocked.
 *  - sync_auth   — 8vance auth failed (401/403): pool credentials wrong/expired.
 *  - sync_source — the pool's source slug isn't valid on the 8vance company.
 *  - sync_company— the pool's 8vance company is outside the allow-list.
 *  - sync_failed — sync to 8vance failed for any other reason (8vance down / 5xx).
 *  - failed      — run could not be created for some other reason.
 */
export type RematchResult =
  | { ok: true; runId: string }
  | {
      ok: false;
      reason:
        | 'forbidden'
        | 'not_found'
        | 'no_consent'
        | 'no_skills'
        | 'sync_auth'
        | 'sync_source'
        | 'sync_company'
        | 'sync_failed'
        | 'failed';
    };

interface OwnedCandidate {
  id: string;
  preferencesJson: unknown;
  eightvanceTalentId: number | null;
}

/** Throws-free org guard: returns the candidate row or null when inaccessible. */
async function loadOwnedCandidate(
  candidateId: string,
  userId: string,
): Promise<OwnedCandidate | null> {
  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: {
      id: true,
      organizationId: true,
      createdByUserId: true,
      preferencesJson: true,
      eightvanceTalentId: true,
    },
  });
  if (!candidate) return null;
  const row: OwnedCandidate = {
    id: candidate.id,
    preferencesJson: candidate.preferencesJson,
    eightvanceTalentId: candidate.eightvanceTalentId,
  };
  if (candidate.createdByUserId === userId) return row;
  if (candidate.organizationId) {
    const orgId = await getOrCreateUserOrg(userId);
    if (candidate.organizationId === orgId) return row;
  }
  return null;
}

/**
 * Classify a `syncCandidateToVance` failure into a typed rematch reason:
 *  - SyncError (thrown by the 8vance create wrapper) carries a precise
 *    `reason` (auth/source/company/sync) → map directly to the sync_* union.
 *  - The consent + <3-skills guards throw a plain Error matched by message:
 *      "…consent…"           → no_consent
 *      "…at least 3 skills…" → no_skills
 *  - anything else (no tenant / transport) → sync_failed.
 */
function classifySyncError(
  err: unknown,
): 'no_consent' | 'no_skills' | 'sync_auth' | 'sync_source' | 'sync_company' | 'sync_failed' {
  if (err instanceof SyncError) {
    switch (err.reason) {
      case 'auth':
        return 'sync_auth';
      case 'source':
        return 'sync_source';
      case 'company':
        return 'sync_company';
      default:
        return 'sync_failed';
    }
  }
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (msg.includes('consent')) return 'no_consent';
  if (msg.includes('at least 3 skills') || msg.includes('3 skills')) return 'no_skills';
  return 'sync_failed';
}

/** Sources to match: explicit non-empty slugs if passed, else the candidate's
 *  saved onboarding preferences. (Slugs are tenant-specific real source names;
 *  the service intersects them with the talent's actually-available sources.) */
function resolveSources(requested: string[] | undefined, _preferencesJson: unknown): string[] {
  // Only honour explicitly-requested slugs (none today — the source picker was
  // removed). We deliberately DO NOT fall back to the candidate's saved
  // preferences.sources: older candidates stored just the pool's own-talent
  // source there, which restricts the inverse match to the talent pool (no
  // vacancies) → 0 jobs. Returning [] makes executeMatchRun match the talent's
  // FULL set of available job sources (own pool + JobDigger/open-market feeds)
  // within its one company — which is where the jobs actually are.
  return (requested ?? []).filter((s) => typeof s === 'string' && s.trim().length > 0);
}

/** Result of an inline recruiter-note save. */
export type UpdateNoteResult =
  | { ok: true }
  | { ok: false; reason: 'forbidden' | 'not_found' | 'too_long' | 'failed' };

/** Hard cap on the recruiter note (synced to 8vance about_me on next sync). */
const MAX_NOTE_LEN = 2000;

/**
 * Persist the recruiter note (`profileJson.note`) for an owned candidate.
 *
 * Org-guarded inside the action (Server Actions are reachable via direct POST).
 * Reads the existing profileJson, replaces only the top-level `note` key, and
 * writes it back — the rich `cv` sub-object and any sync fields are preserved.
 * Does NOT trigger a re-sync; the note flows to 8vance `about_me` on the next
 * sync. Trims to MAX_NOTE_LEN; an empty string clears the note.
 */
export async function updateCandidateNote(
  candidateId: string,
  note: string,
): Promise<UpdateNoteResult> {
  const session = await requireUser();

  if (typeof note !== 'string') return { ok: false, reason: 'failed' };
  const trimmed = note.trim();
  if (trimmed.length > MAX_NOTE_LEN) return { ok: false, reason: 'too_long' };

  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: {
      id: true,
      organizationId: true,
      createdByUserId: true,
      profileJson: true,
    },
  });
  if (!candidate) return { ok: false, reason: 'not_found' };

  let allowed = candidate.createdByUserId === session.id;
  if (!allowed && candidate.organizationId) {
    const orgId = await getOrCreateUserOrg(session.id);
    allowed = candidate.organizationId === orgId;
  }
  if (!allowed) return { ok: false, reason: 'forbidden' };

  const existing =
    candidate.profileJson && typeof candidate.profileJson === 'object'
      ? (candidate.profileJson as Record<string, unknown>)
      : {};
  const next: Record<string, unknown> = { ...existing };
  if (trimmed.length === 0) delete next.note;
  else next.note = trimmed;

  try {
    await prisma.candidate.update({
      where: { id: candidateId },
      data: { profileJson: next as Prisma.InputJsonValue },
    });
  } catch (err) {
    void reportError(err, { area: 'candidate.match.update-note', candidateId });
    return { ok: false, reason: 'failed' };
  }

  revalidatePath(`/app/candidates/${candidateId}/match`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// updateTalentAction — owner edits a SYNCED candidate's 8vance talent
// ---------------------------------------------------------------------------

/** A skill to add (resolved name search) or remove (by junction-row id). */
export interface TalentEditPayload {
  /** Skill NAMES to add (resolved to ids via the resources resolver). */
  addSkills?: string[];
  /** Junction-record ids of skills to remove (the `id` on a /skill/ row). */
  removeSkillRowIds?: number[];
  /**
   * Proficiency-level changes for EXISTING skill rows.
   *  - `rowId`         — the junction-record id (`id` on a /skill/ row).
   *  - `proficiencyId` — new level on the 23..27 scale (1..5 stars).
   *  - `skillId`       — the skill taxonomy id (`skill` on the row), used only
   *                      for the remove-then-add fallback when a deploy rejects
   *                      PATCH on the row; omit and the fallback is skipped.
   *  - `name`          — display name, mirrored into profileJson when present.
   */
  updateSkills?: {
    rowId: number;
    proficiencyId: number;
    skillId?: number | null;
    name?: string | null;
  }[];
  /** Work-experience rows to add. Years are 4-digit strings. */
  addExperience?: {
    title?: string | null;
    company?: string | null;
    startYear?: string | null;
    endYear?: string | null;
    current?: boolean | null;
    description?: string | null;
  }[];
  /**
   * Education rows to add. ONLY school + dates persist via the 8vance API
   * (degree/field are read-only / 500 on write — known gap), so the UI may
   * collect degree/field but they are not synced.
   */
  addEducation?: {
    degree?: string | null;
    field?: string | null;
    institution?: string | null;
    startYear?: string | null;
    endYear?: string | null;
  }[];
  /** New `about_me` (recruiter-authored profile blurb). `''` clears it. */
  about?: string | null;
}

/**
 * Outcome of an owner edit applied to a synced talent.
 *  - forbidden    — caller doesn't own/share the candidate.
 *  - not_found    — candidate row vanished.
 *  - not_synced   — candidate has no eightvanceTalentId (nothing to edit yet).
 *  - sync_failed  — one or more 8vance writes failed (partial saves possible);
 *                   `failedParts` names which sections did not fully apply.
 *  - ok           — every requested change landed in 8vance.
 */
export type UpdateTalentResult =
  | { ok: true; addedSkills: number }
  | {
      ok: false;
      reason: 'forbidden' | 'not_found' | 'not_synced' | 'sync_failed';
      failedParts?: string[];
    };

const MAX_ABOUT_LEN = 2000;

/**
 * Apply recruiter edits (add/remove skills, add experience, add education, edit
 * about_me) to a candidate's EXISTING 8vance talent, then mirror the same edits
 * into the local `profileJson.cv` so the stored fallback view stays in sync.
 *
 * Org-guarded inside the action EXACTLY like `updateCandidateNote` (Server
 * Actions are reachable via direct POST). Owner path only — never reuse for the
 * anonymized employer shortlist. Each 8vance write is wrapped so a partial
 * failure returns a `sync_failed` reason with the failing sections named,
 * never an unhandled throw. The route is revalidated so the live snapshot +
 * stored profile re-render.
 */
export async function updateTalentAction(
  candidateId: string,
  payload: TalentEditPayload,
): Promise<UpdateTalentResult> {
  const session = await requireUser();
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'sync_failed', failedParts: ['payload'] };
  }

  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: {
      id: true,
      organizationId: true,
      createdByUserId: true,
      tenantId: true,
      eightvanceTalentId: true,
      profileJson: true,
    },
  });
  if (!candidate) return { ok: false, reason: 'not_found' };

  // Org guard (identical to updateCandidateNote): created-by OR same org.
  let allowed = candidate.createdByUserId === session.id;
  if (!allowed && candidate.organizationId) {
    const orgId = await getOrCreateUserOrg(session.id);
    allowed = candidate.organizationId === orgId;
  }
  if (!allowed) return { ok: false, reason: 'forbidden' };

  const talentId = candidate.eightvanceTalentId;
  if (talentId == null || !candidate.tenantId) {
    return { ok: false, reason: 'not_synced' };
  }

  // Normalize input.
  const addSkillNames = Array.isArray(payload.addSkills)
    ? payload.addSkills.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean)
    : [];
  const removeRowIds = Array.isArray(payload.removeSkillRowIds)
    ? payload.removeSkillRowIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  // Proficiency edits for existing rows. Clamp to the 23..27 scale and drop any
  // row that is also queued for removal (a removed row can't be re-leveled).
  const updateSkills = (Array.isArray(payload.updateSkills) ? payload.updateSkills : [])
    .map((u) => ({
      rowId: Number(u?.rowId),
      proficiencyId: Math.max(23, Math.min(27, Math.round(Number(u?.proficiencyId)))),
      skillId:
        u?.skillId != null && Number.isFinite(Number(u.skillId)) ? Number(u.skillId) : null,
      name: typeof u?.name === 'string' ? u.name.trim() : null,
    }))
    .filter(
      (u) =>
        Number.isFinite(u.rowId) &&
        u.rowId > 0 &&
        Number.isFinite(u.proficiencyId) &&
        !removeRowIds.includes(u.rowId),
    );
  const addExperience = Array.isArray(payload.addExperience) ? payload.addExperience : [];
  const addEducation = Array.isArray(payload.addEducation) ? payload.addEducation : [];
  const aboutRaw = typeof payload.about === 'string' ? payload.about.trim() : null;
  const about = aboutRaw == null ? null : aboutRaw.slice(0, MAX_ABOUT_LEN);

  const failedParts: string[] = [];
  let client: Awaited<ReturnType<typeof vanceClientForTenant>>;
  try {
    client = await vanceClientForTenant(candidate.tenantId);
  } catch (err) {
    void reportError(err, { area: 'candidate.match.update-talent.client', candidateId });
    return { ok: false, reason: 'sync_failed', failedParts: ['client'] };
  }

  // 1. Resolve + add skills. Resolution failures are folded into failedParts.
  const resolvedSkills: { name: string; id: number }[] = [];
  if (addSkillNames.length > 0) {
    try {
      const resolved = await client.resources.resolveSkills(addSkillNames);
      for (const r of resolved) {
        try {
          await client.talent.addSkill(talentId, { skill_id: r.id });
          resolvedSkills.push(r);
        } catch (err) {
          void reportError(err, { area: 'candidate.match.update-talent.add-skill', candidateId });
          failedParts.push('skill:' + r.name);
        }
      }
      // Names that didn't resolve to an id at all.
      const resolvedNames = new Set(resolved.map((r) => r.name.toLowerCase()));
      for (const n of addSkillNames) {
        if (!resolvedNames.has(n.toLowerCase())) failedParts.push('skill:' + n);
      }
    } catch (err) {
      void reportError(err, { area: 'candidate.match.update-talent.resolve-skills', candidateId });
      failedParts.push('skills');
    }
  }

  // 2. Remove skills by junction-row id.
  const removedRowIds: number[] = [];
  for (const rowId of removeRowIds) {
    try {
      await client.talent.removeSkill(talentId, rowId);
      removedRowIds.push(rowId);
    } catch (err) {
      void reportError(err, { area: 'candidate.match.update-talent.remove-skill', candidateId });
      failedParts.push('removeSkill:' + rowId);
    }
  }

  // 2.5 Update proficiency on existing skill rows. Try PATCH on the row; if the
  //     deploy rejects it (405/404/400/422) AND we know the skill taxonomy id,
  //     fall back to remove-then-add (DELETE row + re-POST with the new level).
  //     The new junction-row id is discovered on the next page load via
  //     getSkills, so we don't surface it here.
  const updatedSkills: { name: string | null; proficiencyId: number }[] = [];
  for (const u of updateSkills) {
    try {
      await client.talent.updateSkill(talentId, u.rowId, {
        proficiency_id: u.proficiencyId,
      });
      updatedSkills.push({ name: u.name, proficiencyId: u.proficiencyId });
    } catch (err) {
      const status = err instanceof VanceError ? err.status : 0;
      const patchUnsupported = [400, 404, 405, 422].includes(status);
      if (patchUnsupported && u.skillId != null) {
        // Remove-then-add fallback: same net effect, new junction-row id.
        try {
          await client.talent.removeSkill(talentId, u.rowId);
          await client.talent.addSkill(talentId, {
            skill_id: u.skillId,
            proficiency_id: u.proficiencyId,
          });
          updatedSkills.push({ name: u.name, proficiencyId: u.proficiencyId });
        } catch (err2) {
          void reportError(err2, {
            area: 'candidate.match.update-talent.update-skill-fallback',
            candidateId,
          });
          failedParts.push('updateSkill:' + u.rowId);
        }
      } else {
        void reportError(err, {
          area: 'candidate.match.update-talent.update-skill',
          candidateId,
        });
        failedParts.push('updateSkill:' + u.rowId);
      }
    }
  }

  // 3. Add work experience.
  const addedExperience: TalentEditPayload['addExperience'] = [];
  for (const ex of addExperience) {
    try {
      await client.talent.addExperience(talentId, {
        title: ex.title ?? null,
        company: ex.company ?? null,
        startYear: ex.startYear ?? null,
        endYear: ex.endYear ?? null,
        current: ex.current ?? null,
        description: ex.description ?? null,
      });
      addedExperience.push(ex);
    } catch (err) {
      void reportError(err, { area: 'candidate.match.update-talent.add-experience', candidateId });
      failedParts.push('experience');
    }
  }

  // 4. Add education (school + dates only — 8vance API gap on degree/field).
  const addedEducation: TalentEditPayload['addEducation'] = [];
  for (const ed of addEducation) {
    try {
      await client.talent.addEducation(talentId, {
        institution: ed.institution ?? null,
        startYear: ed.startYear ?? null,
        endYear: ed.endYear ?? null,
      });
      addedEducation.push(ed);
    } catch (err) {
      void reportError(err, { area: 'candidate.match.update-talent.add-education', candidateId });
      failedParts.push('education');
    }
  }

  // 5. About / notes (PATCH about_me). Only when the field was supplied.
  let aboutApplied = false;
  if (payload.about !== undefined) {
    try {
      await client.talent.update(talentId, { about_me: about });
      aboutApplied = true;
    } catch (err) {
      void reportError(err, { area: 'candidate.match.update-talent.about', candidateId });
      failedParts.push('about');
    }
  }

  // 6. Mirror the APPLIED changes into local profileJson.cv (preserve siblings
  //    like top-level `note`), matching updateCandidateNote's preserve posture.
  try {
    const existing =
      candidate.profileJson && typeof candidate.profileJson === 'object'
        ? (candidate.profileJson as Record<string, unknown>)
        : {};
    const cv =
      existing.cv && typeof existing.cv === 'object'
        ? (existing.cv as Record<string, unknown>)
        : {};

    // Skills: hardSkills array is the catch-all bucket the profile view reads.
    if (resolvedSkills.length > 0) {
      const hard = Array.isArray(cv.hardSkills) ? (cv.hardSkills as string[]) : [];
      const seen = new Set(hard.map((s) => s.toLowerCase()));
      for (const r of resolvedSkills) {
        if (!seen.has(r.name.toLowerCase())) {
          hard.push(r.name);
          seen.add(r.name.toLowerCase());
        }
      }
      cv.hardSkills = hard;
    }

    // Proficiency edits: profileJson.cv has no per-skill level field (the skill
    // arrays are plain names; live proficiency comes from the 8vance read on the
    // page). Mirror edited levels into an additive `cv.skillProficiency` map
    // (skill name → 1..5) so the stored fallback stays aware of the new levels.
    if (updatedSkills.length > 0) {
      const map =
        cv.skillProficiency && typeof cv.skillProficiency === 'object'
          ? (cv.skillProficiency as Record<string, number>)
          : {};
      for (const u of updatedSkills) {
        if (u.name) map[u.name] = u.proficiencyId - 22; // 23..27 → 1..5
      }
      cv.skillProficiency = map;
    }

    if (addedExperience.length > 0) {
      const employment = Array.isArray(cv.employment) ? (cv.employment as unknown[]) : [];
      for (const ex of addedExperience) {
        employment.push({
          title: ex.title ?? null,
          company: ex.company ?? null,
          startYear: ex.startYear ?? null,
          endYear: ex.endYear ?? null,
          current: ex.current ?? null,
          description: ex.description ?? null,
        });
      }
      cv.employment = employment;
    }

    if (addedEducation.length > 0) {
      const education = Array.isArray(cv.education) ? (cv.education as unknown[]) : [];
      for (const ed of addedEducation) {
        education.push({
          degree: ed.degree ?? null,
          field: ed.field ?? null,
          institution: ed.institution ?? null,
          startYear: ed.startYear ?? null,
          endYear: ed.endYear ?? null,
        });
      }
      cv.education = education;
    }

    if (aboutApplied) {
      if (about) cv.about = about;
      else delete cv.about;
    }

    const next: Record<string, unknown> = { ...existing, cv };
    await prisma.candidate.update({
      where: { id: candidateId },
      data: { profileJson: next as Prisma.InputJsonValue },
    });
  } catch (err) {
    // The 8vance writes already landed; a local-mirror failure is non-fatal but
    // worth surfacing so the stored fallback view can be reconciled later.
    void reportError(err, { area: 'candidate.match.update-talent.mirror', candidateId });
    failedParts.push('local_mirror');
  }

  revalidatePath(`/app/candidates/${candidateId}/match`);

  if (failedParts.length > 0) {
    return { ok: false, reason: 'sync_failed', failedParts };
  }
  return { ok: true, addedSkills: resolvedSkills.length };
}

// ---------------------------------------------------------------------------
// getJobGapAction — per-job gap analysis for the candidate→jobs match screen
// ---------------------------------------------------------------------------

/** A single job-required skill, flagged matched/missing against the candidate. */
export interface JobGapSkill {
  name: string;
  /** True when the candidate has this skill (name- or taxonomy-id match). */
  matched: boolean;
}

/**
 * Lazy per-job gap analysis (computed only when a match card is expanded):
 *  - skills      — the JOB's required skills, each flagged matched/missing.
 *  - matchedCount/totalCount — "X of Y job skills matched".
 *  - employer/contractType/location/description — detail fields for the card.
 *  - approximate — true when the job exposed no required-skill rows and we fell
 *    back to comparing nothing (skills empty); the UI labels the limitation.
 */
export type JobGapResult =
  | {
      ok: true;
      skills: JobGapSkill[];
      matchedCount: number;
      totalCount: number;
      employer: string | null;
      /** The actual hiring company when the poster recruits on its behalf
       * (8vance `hiring_company_label`, e.g. "Stork IMM" posted via Tjellens). */
      hiringCompany: string | null;
      contractType: string | null;
      location: string | null;
      /** Employer-side contact for the VACANCY (who to reach about this job).
       * Never candidate PII — comes straight off the job's /extended/ payload. */
      contact: { name: string | null; email: string | null; phone: string | null } | null;
      /** Job description as CLEAN PLAIN TEXT (8vance sends HTML → htmlToText). */
      description: string | null;
      /** Link to the original vacancy posting, when 8vance exposes one. */
      url: string | null;
      approximate: boolean;
      /**
       * REAL graded score (0..1) from `/match/specific/` when we computed it
       * (cross-company jobs). Absent for own-pool jobs, whose list score is
       * already reliable and shown directly.
       */
      score?: number;
    }
  | { ok: false; reason: 'forbidden' | 'not_found' | 'not_synced' | 'failed' };

/** Normalize a skill name for case-insensitive comparison. */
function normSkillName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/** Trimmed string or null. */
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Reconstruct the readable vacancy URL from a job's /extended/ payload. */
function extendedVacancyUrl(
  extended: Record<string, unknown> | null | undefined,
  jobId: number,
): string | null {
  if (!extended) return null;
  const company = extended.company as { website?: unknown } | null | undefined;
  const website = company?.website ?? extended.public_url;
  return readableVacancyUrl(jobId, extended.title, website);
}

/**
 * Pull the vacancy's EMPLOYER-side contact off a `/extended/` payload
 * (`primary_contact_person`, else `secondary_contact_person`). Returns null when
 * no name/email/phone is present. This is who to reach about the JOB — never
 * candidate PII.
 */
function jobContact(
  extended: Record<string, unknown> | null | undefined,
): { name: string | null; email: string | null; phone: string | null } | null {
  if (!extended) return null;
  const cp = (extended.primary_contact_person ??
    extended.secondary_contact_person ??
    null) as Record<string, unknown> | null;
  if (!cp) return null;
  const name = strOrNull(cp.name);
  const email = strOrNull(cp.email);
  const phone = strOrNull(cp.phone);
  if (!name && !email && !phone) return null;
  return { name, email, phone };
}

/**
 * Pull the first valid http(s) posting URL off a `/extended/` payload. Verified
 * live against 8vance `/job/{id}/extended/?context=`:
 *  - `web_link` = the ORIGINAL vacancy on the source site — for JobDigger /
 *    open-market feeds this is the real posting (e.g. bouwvacatures.nl/...).
 *    Preferred: the recruiter wants the actual vacancy, not a portal.
 *  - `public_url` = another source-site original (e.g. tjellens.nl); may redirect
 *    a stale deep-link to its homepage, so tjellens is rebuilt separately via
 *    readableVacancyUrl (extendedVacancyUrl runs BEFORE this).
 *  - `apply_url` = the 8vance career-portal redirect (career.8vance.com,
 *    register/apply wall). It resolves but does NOT show the original vacancy —
 *    last-resort fallback only.
 * So: original source posting first, then the 8vance portal as a fallback.
 * Returns null when none is present/valid. Logs the available key names (names
 * only, no PII) when a described job has no recognised URL key.
 */
function jobPostingUrl(extended: Record<string, unknown> | null | undefined): string | null {
  if (!extended) return null;
  const candidates = [
    extended.web_link, // ORIGINAL source posting (JobDigger → bouwvacatures.nl etc.)
    extended.public_url, // other source-site original posting
    extended.url,
    extended.vacancy_url,
    extended.source_url,
    extended.external_url,
    extended.link,
    extended.external_apply_url,
    extended.apply_url, // 8vance career portal — resolves but not the original vacancy
    extended.application_url,
    extended.redirect_url,
  ];
  for (const c of candidates) {
    if (isHttpUrl(c)) return c;
  }
  if (typeof extended.description === 'string' && extended.description) {
    console.warn(
      `[job-url] no posting URL on /extended/; keys=[${Object.keys(extended).join(', ')}]`,
    );
  }
  return null;
}

/**
 * Build the matched/missing skill breakdown for ONE matched job, scoped to the
 * candidate's tenant. Org-guarded inside the action (Server Actions are
 * reachable via direct POST). Read-only: fetches the job's required skills
 * (`/job/{id}/skill/`, with the candidate's talent id as `context` so
 * open-market feed jobs resolve), the candidate's live skills
 * (`/talent/{id}/skill/`), and the job detail (`/job/{id}/extended/`), then
 * compares by skill NAME (case-insensitive) with a taxonomy-id fallback so a
 * row without an inline name still matches. Never throws — any failure maps to
 * a typed reason.
 */
export async function getJobGapAction(
  candidateId: string,
  eightvanceJobId: number,
  // When the list score is unreliable (cross-company degenerate score), fetch
  // the REAL graded score via /match/specific/ even if the job's own skill rows
  // resolved — so the detail ring shows a real % instead of "–".
  scoreUnreliable = false,
): Promise<JobGapResult> {
  const session = await requireUser();

  const jobId = Number(eightvanceJobId);
  if (!Number.isFinite(jobId) || jobId <= 0) {
    return { ok: false, reason: 'not_found' };
  }

  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: {
      id: true,
      organizationId: true,
      createdByUserId: true,
      tenantId: true,
      eightvanceTalentId: true,
    },
  });
  if (!candidate) return { ok: false, reason: 'not_found' };

  // Org guard (identical to updateCandidateNote / updateTalentAction).
  let allowed = candidate.createdByUserId === session.id;
  if (!allowed && candidate.organizationId) {
    const orgId = await getOrCreateUserOrg(session.id);
    allowed = candidate.organizationId === orgId;
  }
  if (!allowed) return { ok: false, reason: 'forbidden' };

  const talentId = candidate.eightvanceTalentId;
  if (talentId == null || !candidate.tenantId) {
    return { ok: false, reason: 'not_synced' };
  }

  let client: Awaited<ReturnType<typeof vanceClientForTenant>>;
  try {
    client = await vanceClientForTenant(candidate.tenantId);
  } catch (err) {
    void reportError(err, { area: 'candidate.match.job-gap.client', candidateId });
    return { ok: false, reason: 'failed' };
  }

  // Fetch in parallel: job required-skills (context = talent so feed jobs
  // resolve), the candidate's live skills, and the job detail. Each is wrapped
  // so a single sub-read failure degrades gracefully instead of failing all.
  const [jobSkillsRes, talentSkillsRes, extendedRes] = await Promise.allSettled([
    client.job.getSkills(jobId, talentId),
    client.talent.getSkills(talentId),
    client.job.getExtended(jobId, talentId),
  ]);

  // A job's required-skill rows are FORBIDDEN (403) on open-market / feed jobs
  // the pool's company doesn't own — and `?context=` does NOT unlock them (it
  // unlocks /extended/, but NOT /skill/). VERIFIED live against IVTA: a feed job
  // 403s on /job/{id}/skill/ with AND without context, while own-pool jobs
  // return the rows. Since most candidate→job matches are feed jobs, a rejection
  // here is the COMMON case, not a hard error — degrade to an empty (approximate)
  // skill list and still render the job DETAIL from /extended/, which loads.
  const jobSkillRows = jobSkillsRes.status === 'fulfilled' ? jobSkillsRes.value : [];
  if (jobSkillsRes.status === 'rejected') {
    void reportError(jobSkillsRes.reason, {
      area: 'candidate.match.job-gap.job-skills',
      candidateId,
    });
  }
  const talentSkillRows =
    talentSkillsRes.status === 'fulfilled' ? talentSkillsRes.value : [];
  const extended =
    extendedRes.status === 'fulfilled' ? extendedRes.value : null;

  // Genuine total failure: neither the job's skills NOR its detail came back, so
  // there is nothing meaningful to render → surface the one typed error the UI
  // explains. (A feed job, where only /skill/ 403s, still shows its detail.)
  if (jobSkillsRes.status === 'rejected' && extendedRes.status === 'rejected') {
    return { ok: false, reason: 'failed' };
  }

  // Candidate skill index: by name (case-insensitive) AND by taxonomy id.
  const candNames = new Set<string>();
  const candIds = new Set<number>();
  for (const s of talentSkillRows) {
    const rec = s as Record<string, unknown>;
    const name =
      normSkillName(rec.skill_name) ||
      normSkillName(rec.name) ||
      '';
    if (name) candNames.add(name);
    if (typeof s.skill === 'number') candIds.add(s.skill);
  }

  // Build the job's required-skill list, de-duped, each flagged matched.
  const seen = new Set<string>();
  const skills: JobGapSkill[] = [];
  for (const row of jobSkillRows) {
    const rec = row as Record<string, unknown>;
    const rawName =
      (typeof rec.skill_name === 'string' && rec.skill_name.trim()) ||
      (typeof rec.name === 'string' && rec.name.trim()) ||
      '';
    const id = typeof row.skill === 'number' ? row.skill : null;
    const display = rawName || (id != null ? `#${id}` : 'Skill');
    const dedupeKey = (rawName ? rawName.toLowerCase() : `id:${id ?? display}`);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const matched =
      (!!rawName && candNames.has(rawName.toLowerCase())) ||
      (id != null && candIds.has(id));
    skills.push({ name: display, matched });
  }

  // Cross-company fallback: `/job/{id}/skill/` 403s for a job we don't own, so
  // `skills` is empty here. The `/match/specific/` gap analysis DOES return that
  // job's required skills (per cluster) under our creds — use it so the card
  // shows a real breakdown instead of "skills unavailable".
  let gapSkills = skills;
  let approximate = skills.length === 0;
  // REAL graded score (0..1) from `/match/specific/`, captured whenever we call
  // the gap analysis (the cross-company path). Used to show the true score in the
  // detail ring AND cached back onto the persisted match row so the list stops
  // showing the degenerate 100%.
  let realScore: number | null = null;
  if (skills.length === 0) {
    try {
      const gap = await client.job.getGapAnalysis(jobId, talentId);
      if (typeof gap.match_result?.score === 'number') {
        realScore = gap.match_result.score;
      }
      const seen2 = new Set<string>();
      const gs: JobGapSkill[] = [];
      for (const cluster of gap.gap_score?.skills ?? []) {
        for (const os of cluster?.overlapping_skills ?? []) {
          const nm = (os?.name ?? '').trim();
          const id = typeof os?.term_id === 'number' ? os.term_id : null;
          if (!nm && id == null) continue;
          const key = nm ? nm.toLowerCase() : `id:${id}`;
          if (seen2.has(key)) continue;
          seen2.add(key);
          const matched =
            (!!nm && candNames.has(nm.toLowerCase())) || (id != null && candIds.has(id));
          gs.push({ name: nm || `#${id}`, matched });
        }
      }
      if (gs.length > 0) {
        gapSkills = gs;
        approximate = false;
      }
    } catch {
      // Gap analysis unavailable too — leave the (empty, approximate) breakdown.
    }
  } else if (scoreUnreliable) {
    // The job's own skill rows resolved (so we skipped the gap analysis above),
    // but the list score is unreliable — a cross-company/ecosystem job whose
    // `/match/job/` score is degenerate. Fetch the REAL graded score alone so
    // the detail ring shows a real % instead of "–" (skills already resolved).
    try {
      const gap = await client.job.getGapAnalysis(jobId, talentId);
      if (typeof gap.match_result?.score === 'number') {
        realScore = gap.match_result.score;
      }
    } catch {
      // Best-effort: no real score → detail keeps the neutral placeholder.
    }
  }

  const matchedCount = gapSkills.filter((s) => s.matched).length;

  // Cache the real score back onto the persisted match row(s) for this candidate
  // + job so the LIST stops showing the degenerate 100% and can display/sort by
  // the true score on the next render. Best-effort: never fail the detail on it.
  if (realScore != null) {
    try {
      await prisma.candidateJobMatch.updateMany({
        where: { eightvanceJobId: jobId, run: { candidateId } },
        // Persist as a 0..100 PERCENT so the cached list score sorts on the same
        // scale as own-pool / ecosystem rows and the bounded post-run real-score
        // pass (see service.ts realScoreByJob) — not the raw 0..1.
        data: { score: realScore * 100, scoreReliable: true },
      });
    } catch (err) {
      void reportError(err, {
        area: 'candidate.match.job-gap.cacheScore',
        candidateId,
      });
    }
  }

  return {
    ok: true,
    skills: gapSkills,
    matchedCount,
    totalCount: gapSkills.length,
    employer: extended?.company?.name ?? null,
    // The real hiring company behind a JobDigger/open-market posting — but only
    // when 8vance AFFIRMATIVELY flags it displayable. Fail closed: an absent or
    // non-true `display_hiring_company_information` means we do NOT expose the
    // employer (the intermediary, e.g. Tjellens, hasn't cleared it), and the UI
    // falls back to the generic "JobDigger" label via employerLabel.
    hiringCompany:
      extended &&
      extended.display_hiring_company_information === true &&
      typeof extended.hiring_company_label === 'string'
        ? extended.hiring_company_label.trim() || null
        : null,
    contact: jobContact(extended),
    contractType:
      extended && typeof extended.contract_type === 'number'
        ? String(extended.contract_type)
        : null,
    location:
      extended?.location?.city ?? extended?.detailed_location?.city ?? null,
    // 8vance sends the description as HTML — convert to clean plain text so the
    // detail popup doesn't show raw tags/entities.
    description:
      typeof extended?.description === 'string'
        ? htmlToText(extended.description) || null
        : null,
    // Link to the vacancy. Prefer the reconstructed READABLE career-page URL
    // (tjellens.nl/vacature/<jobId>-<slug>/) when the host supports it; else the
    // best posting/apply URL 8vance gives.
    url: extendedVacancyUrl(extended, jobId) ?? jobPostingUrl(extended),
    // True only when NEITHER the direct skill rows NOR the gap-analysis fallback
    // yielded any skills → the breakdown can't show a real gap; UI labels it.
    approximate,
    score: realScore ?? undefined,
  };
}

export async function rematchAction(
  candidateId: string,
  sources?: string[],
  // Optional ad-hoc city to centre the match on (recruiter searched a location
  // from the match view — e.g. the candidate would relocate to Eindhoven). When
  // set, the open-market feeds are bounded around this point instead of home.
  locationOverride?: { lat: number; lng: number; label?: string },
): Promise<RematchResult> {
  const session = await requireUser();

  const owned = await loadOwnedCandidate(candidateId, session.id);
  if (!owned) return { ok: false, reason: 'forbidden' };

  const safeSources = resolveSources(sources, owned.preferencesJson);
  const safeLocation =
    locationOverride &&
    Number.isFinite(locationOverride.lat) &&
    Number.isFinite(locationOverride.lng)
      ? {
          lat: locationOverride.lat,
          lng: locationOverride.lng,
          label:
            typeof locationOverride.label === 'string'
              ? locationOverride.label.slice(0, 120)
              : undefined,
        }
      : undefined;

  // Sync-first: createMatchRun THROWS "candidate not synced to 8vance yet" when
  // the candidate has no eightvanceTalentId, which is exactly the case for a
  // candidate whose first sync failed (missing consent / <3 skills / 8vance
  // down). Re-attempt the sync here and map any failure to a typed reason the
  // UI can explain, so the user never gets stuck on a silent empty screen.
  if (owned.eightvanceTalentId == null) {
    try {
      await syncCandidateToVance(candidateId);
    } catch (err) {
      revalidatePath(`/app/candidates/${candidateId}/match`);
      return { ok: false, reason: classifySyncError(err) };
    }
  }

  try {
    // Create a fresh MATCHING run. The match screen's poller triggers the
    // (slow) execution off the request path via /run-match — but kick it off
    // here too via `after()` so the match still runs even if the client never
    // polls. executeMatchRun atomically claims the run, so the poller stays a
    // safe backup with no double-execution.
    const runId = await createMatchRun(candidateId, {
      ...(safeSources.length > 0 ? { sources: safeSources } : {}),
      ...(safeLocation ? { locationOverride: safeLocation } : {}),
    });
    after(() => {
      void executeMatchRun(runId).catch((err) => {
        // executeMatchRun flips the run to FAILED on its own errors, but it can
        // also throw BEFORE that (e.g. "run not found" if the candidate was
        // deleted) — log so an orphaned MATCHING run isn't silent.
        void reportError(err, { area: 'candidate.match.rematch-after', runId });
      });
    });
    revalidatePath(`/app/candidates/${candidateId}/match`);
    return { ok: true, runId };
  } catch {
    revalidatePath(`/app/candidates/${candidateId}/match`);
    return { ok: false, reason: 'failed' };
  }
}
