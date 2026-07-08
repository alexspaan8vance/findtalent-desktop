'use server';

/**
 * Server actions for the CV-suggestions review panel (Phase 3).
 *
 * A candidate's `cvSuggestionsJson` holds the "richer-wins" diff the engine
 * produced from the 8vance server-side CV parse (see cv-suggestions.ts). These
 * actions let a recruiter LIST the pending suggestions, DISMISS one, or APPROVE
 * one — on approve the change is applied to the LOCAL `profileJson.cv` (the
 * source of truth) and the delta is pushed to the candidate's 8vance talent
 * (best-effort; a failed push never fails the approve).
 *
 * Every action is org-guarded INSIDE the action (Server Actions are reachable
 * via direct POST) using the exact created-by-OR-same-org check from
 * `updateTalentAction` in ./match/actions.ts. Nothing throws to the client —
 * every outcome is a typed result.
 */

import { revalidatePath } from 'next/cache';
import type { Prisma } from '@prisma/client';

import { requireUser } from '@/lib/auth-helpers';
import { prisma } from '@/lib/db';
import { getOrCreateUserOrg } from '@/lib/org';
import { reportError } from '@/lib/observability/report';
import { vanceClientForTenant } from '@/lib/eightvance/tenant-client';
import { generateSuggestionsFromTalent } from '@/lib/candidate/service';
import type { CvSuggestion } from '@/lib/candidate/cv-suggestions';

/** Lifecycle of the 8vance CV-reparse suggestion pass, surfaced to the panel. */
export type SuggestionsStatus = 'pending' | 'ready' | 'none' | 'error';

/** Pending suggestions for the review panel, or a typed failure. */
export type ListSuggestionsResult =
  | { ok: true; suggestions: CvSuggestion[] }
  | { ok: false; reason: 'forbidden' | 'not_found' | 'failed' };

/** Poll result: current pending suggestions + the pass status. */
export type RefreshSuggestionsResult =
  | { ok: true; suggestions: CvSuggestion[]; status: SuggestionsStatus }
  | { ok: false; reason: 'forbidden' | 'not_found' | 'failed' };

/** Outcome of dismiss/approve of a single suggestion. */
export type SuggestionActionResult =
  | { ok: true }
  | { ok: false; reason: 'forbidden' | 'not_found' | 'not_pending' | 'failed' };

/** Outcome of approving every pending suggestion in one shot. */
export type ApproveAllResult =
  | { ok: true; approved: number; failed: number }
  | { ok: false; reason: 'forbidden' | 'not_found' | 'failed' };

/** Candidate columns every suggestion action needs. */
interface CandidateForSuggestions {
  id: string;
  tenantId: string | null;
  eightvanceTalentId: number | null;
  profileJson: unknown;
  cvSuggestionsJson: unknown;
  email: string | null;
  phone: string | null;
}

/**
 * Load the candidate + enforce the org guard (created-by OR same org), IDENTICAL
 * to `updateTalentAction`. Returns the row on success, else a typed reason.
 */
async function loadOwned(
  candidateId: string,
  userId: string,
): Promise<
  | { ok: true; candidate: CandidateForSuggestions }
  | { ok: false; reason: 'forbidden' | 'not_found' }
> {
  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: {
      id: true,
      organizationId: true,
      createdByUserId: true,
      tenantId: true,
      eightvanceTalentId: true,
      profileJson: true,
      cvSuggestionsJson: true,
      email: true,
      phone: true,
    },
  });
  if (!candidate) return { ok: false, reason: 'not_found' };

  let allowed = candidate.createdByUserId === userId;
  if (!allowed && candidate.organizationId) {
    const orgId = await getOrCreateUserOrg(userId);
    allowed = candidate.organizationId === orgId;
  }
  if (!allowed) return { ok: false, reason: 'forbidden' };

  return {
    ok: true,
    candidate: {
      id: candidate.id,
      tenantId: candidate.tenantId,
      eightvanceTalentId: candidate.eightvanceTalentId,
      profileJson: candidate.profileJson,
      cvSuggestionsJson: candidate.cvSuggestionsJson,
      email: candidate.email,
      phone: candidate.phone,
    },
  };
}

/** Coerce the stored JSON into a CvSuggestion[] (empty when absent/malformed). */
function readSuggestions(raw: unknown): CvSuggestion[] {
  return Array.isArray(raw) ? (raw as CvSuggestion[]) : [];
}

const norm = (s: unknown): string => (typeof s === 'string' ? s.trim().toLowerCase() : '');

// ---------------------------------------------------------------------------
// 1. listSuggestions — pending suggestions for the review panel
// ---------------------------------------------------------------------------

export async function listSuggestions(candidateId: string): Promise<ListSuggestionsResult> {
  const session = await requireUser();
  const loaded = await loadOwned(candidateId, session.id);
  if (!loaded.ok) return loaded;
  try {
    const pending = readSuggestions(loaded.candidate.cvSuggestionsJson).filter(
      (s) => s?.status === 'pending',
    );
    return { ok: true, suggestions: pending };
  } catch (err) {
    void reportError(err, { area: 'candidate.suggestions.list', candidateId });
    return { ok: false, reason: 'failed' };
  }
}

// ---------------------------------------------------------------------------
// 1b. refreshSuggestions — re-run the generator, then return pending + status
// ---------------------------------------------------------------------------

/**
 * The panel's poll target. Unlike `listSuggestions` (a pure read), this first
 * RE-RUNS the generator server-side: the 8vance CV reparse is async, so a poll
 * that only re-reads the DB would never surface suggestions the reparse produced
 * AFTER the page's initial `after()` pass. `generateSuggestionsFromTalent` is
 * itself guarded (no-op once a diff exists), so repeated polls are cheap/safe.
 * Returns the pending set + the pass status so the client can stop polling on a
 * definitive end-state ("ready"/"none"/"error") instead of a fixed try budget.
 */
export async function refreshSuggestionsAction(
  candidateId: string,
): Promise<RefreshSuggestionsResult> {
  const session = await requireUser();
  const loaded = await loadOwned(candidateId, session.id);
  if (!loaded.ok) return loaded;
  try {
    // Best-effort regenerate (never throws). Reads 8vance sub-resources + diffs.
    await generateSuggestionsFromTalent(candidateId);
    const fresh = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { cvSuggestionsJson: true, cvSuggestionsStatus: true },
    });
    const pending = readSuggestions(fresh?.cvSuggestionsJson).filter(
      (s) => s?.status === 'pending',
    );
    const raw = fresh?.cvSuggestionsStatus;
    const status: SuggestionsStatus =
      raw === 'ready' || raw === 'none' || raw === 'error' || raw === 'pending'
        ? raw
        : pending.length > 0
          ? 'ready'
          : 'pending';
    return { ok: true, suggestions: pending, status };
  } catch (err) {
    void reportError(err, { area: 'candidate.suggestions.refresh', candidateId });
    return { ok: false, reason: 'failed' };
  }
}

// ---------------------------------------------------------------------------
// 2. dismissSuggestion — mark one suggestion dismissed
// ---------------------------------------------------------------------------

export async function dismissSuggestion(
  candidateId: string,
  suggestionId: string,
): Promise<SuggestionActionResult> {
  const session = await requireUser();
  const loaded = await loadOwned(candidateId, session.id);
  if (!loaded.ok) return loaded;

  const suggestions = readSuggestions(loaded.candidate.cvSuggestionsJson);
  const idx = suggestions.findIndex((s) => s?.id === suggestionId);
  if (idx < 0) return { ok: false, reason: 'not_found' };

  suggestions[idx] = { ...suggestions[idx], status: 'dismissed' };

  try {
    await prisma.candidate.update({
      where: { id: candidateId },
      data: { cvSuggestionsJson: suggestions as unknown as Prisma.InputJsonValue },
    });
  } catch (err) {
    void reportError(err, { area: 'candidate.suggestions.dismiss', candidateId });
    return { ok: false, reason: 'failed' };
  }

  revalidatePath(`/app/candidates/${candidateId}/match`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 3. approveSuggestion — apply to local profile + push delta to 8vance
// ---------------------------------------------------------------------------

/**
 * Apply a single approved suggestion to the mutable local `cv` object (the
 * source of truth). Returns the top-level candidate email/phone to mirror when
 * the suggestion touches contact info (so the profile display, which reads
 * candidate.email/phone, stays in sync), else `{}`.
 */
function applyToLocalCv(
  cv: Record<string, unknown>,
  suggestion: CvSuggestion,
): { email?: string; phone?: string } {
  const { kind, action, proposed, original } = suggestion;

  switch (kind) {
    case 'skill': {
      const name = typeof proposed === 'string' ? proposed.trim() : '';
      if (!name) break;
      const hard = Array.isArray(cv.hardSkills) ? (cv.hardSkills as string[]) : [];
      if (!hard.some((s) => norm(s) === norm(name))) hard.push(name);
      cv.hardSkills = hard;
      break;
    }
    case 'language': {
      const name =
        proposed && typeof proposed === 'object'
          ? String((proposed as { name?: unknown }).name ?? '').trim()
          : typeof proposed === 'string'
            ? proposed.trim()
            : '';
      if (!name) break;
      const langs = Array.isArray(cv.languages)
        ? (cv.languages as Array<{ name?: string }>)
        : [];
      if (!langs.some((l) => norm(l?.name) === norm(name))) langs.push({ name });
      cv.languages = langs;
      break;
    }
    case 'education': {
      if (!proposed || typeof proposed !== 'object') break;
      const list = Array.isArray(cv.education) ? (cv.education as unknown[]) : [];
      if (action === 'replace' && original != null) {
        const key = JSON.stringify(original);
        const i = list.findIndex((e) => JSON.stringify(e) === key);
        if (i >= 0) list[i] = proposed;
        else list.push(proposed);
      } else {
        list.push(proposed);
      }
      cv.education = list;
      break;
    }
    case 'employment': {
      if (!proposed || typeof proposed !== 'object') break;
      const list = Array.isArray(cv.employment) ? (cv.employment as unknown[]) : [];
      if (action === 'replace' && original != null) {
        const key = JSON.stringify(original);
        const i = list.findIndex((e) => JSON.stringify(e) === key);
        if (i >= 0) list[i] = proposed;
        else list.push(proposed);
      } else {
        list.push(proposed);
      }
      cv.employment = list;
      break;
    }
    case 'about': {
      if (typeof proposed === 'string') cv.about = proposed;
      break;
    }
    case 'email': {
      if (typeof proposed === 'string' && proposed.trim()) {
        const v = proposed.trim();
        cv.email = v;
        return { email: v };
      }
      break;
    }
    case 'phone': {
      if (typeof proposed === 'string' && proposed.trim()) {
        const v = proposed.trim();
        cv.phone = v;
        return { phone: v };
      }
      break;
    }
  }
  return {};
}

/**
 * Push the approved suggestion's delta to the candidate's 8vance talent. Every
 * write is wrapped so a failure is reported + swallowed — the local profile was
 * already updated, so a 8vance push failure must NOT fail the approve. No-op
 * when the candidate isn't synced (no talentId/tenantId).
 */
async function pushToVance(
  candidate: CandidateForSuggestions,
  suggestion: CvSuggestion,
): Promise<void> {
  const talentId = candidate.eightvanceTalentId;
  if (talentId == null || !candidate.tenantId) return;

  let client: Awaited<ReturnType<typeof vanceClientForTenant>>;
  try {
    client = await vanceClientForTenant(candidate.tenantId);
  } catch (err) {
    void reportError(err, {
      area: 'candidate.suggestions.approve.client',
      candidateId: candidate.id,
    });
    return;
  }

  const { kind, proposed } = suggestion;
  const area = `candidate.suggestions.approve.${kind}`;

  try {
    switch (kind) {
      case 'skill': {
        const name = typeof proposed === 'string' ? proposed.trim() : '';
        if (!name) break;
        const resolved = await client.resources.resolveSkills([name]);
        const hit = resolved[0];
        if (hit) await client.talent.addSkill(talentId, { skill_id: hit.id });
        break;
      }
      case 'language': {
        const name =
          proposed && typeof proposed === 'object'
            ? String((proposed as { name?: unknown }).name ?? '').trim()
            : typeof proposed === 'string'
              ? proposed.trim()
              : '';
        if (!name) break;
        const lang = await client.resources.resolveLanguage(name);
        if (lang) await client.talent.addLanguage(talentId, { language: lang.id });
        break;
      }
      case 'education': {
        if (!proposed || typeof proposed !== 'object') break;
        const e = proposed as {
          institution?: string | null;
          startYear?: string | null;
          endYear?: string | null;
        };
        // School + dates only — degree/field are read-only API gaps (see client).
        await client.talent.addEducation(talentId, {
          institution: e.institution ?? null,
          startYear: e.startYear ?? null,
          endYear: e.endYear ?? null,
        });
        break;
      }
      case 'employment': {
        if (!proposed || typeof proposed !== 'object') break;
        const e = proposed as {
          title?: string | null;
          company?: string | null;
          startYear?: string | null;
          endYear?: string | null;
          current?: boolean | null;
          description?: string | null;
        };
        await client.talent.addExperience(talentId, {
          title: e.title ?? null,
          company: e.company ?? null,
          startYear: e.startYear ?? null,
          endYear: e.endYear ?? null,
          current: e.current ?? null,
          description: e.description ?? null,
        });
        // Best-effort: link the role's function_name so the talent stays visible
        // to reverse matching. Separately wrapped — a resolve/link failure must
        // not undo the experience POST that already landed.
        if (e.title && e.title.trim()) {
          try {
            const fn = await client.resources.resolveFunctionName(e.title.trim());
            if (fn) await client.talent.linkFunctionName(talentId, fn.id);
          } catch (err) {
            void reportError(err, {
              area: 'candidate.suggestions.approve.employment.function',
              candidateId: candidate.id,
            });
          }
        }
        break;
      }
      case 'about': {
        if (typeof proposed === 'string') {
          await client.talent.update(talentId, { about_me: proposed });
        }
        break;
      }
      case 'email': {
        if (typeof proposed === 'string' && proposed.trim()) {
          await client.talent.update(talentId, { email: proposed.trim() });
        }
        break;
      }
      case 'phone': {
        if (typeof proposed === 'string' && proposed.trim()) {
          await client.talent.update(talentId, { phone: proposed.trim() });
        }
        break;
      }
    }
  } catch (err) {
    // Best-effort: the local profile is already the source of truth.
    void reportError(err, { area, candidateId: candidate.id });
  }
}

export async function approveSuggestion(
  candidateId: string,
  suggestionId: string,
): Promise<SuggestionActionResult> {
  const session = await requireUser();
  const loaded = await loadOwned(candidateId, session.id);
  if (!loaded.ok) return loaded;
  const { candidate } = loaded;

  const suggestions = readSuggestions(candidate.cvSuggestionsJson);
  const idx = suggestions.findIndex((s) => s?.id === suggestionId);
  if (idx < 0) return { ok: false, reason: 'not_found' };
  const suggestion = suggestions[idx];
  if (suggestion.status !== 'pending') return { ok: false, reason: 'not_pending' };

  // 1. Apply to the LOCAL profileJson.cv (source of truth), preserving siblings
  //    like top-level `note` — same preserve posture as updateTalentAction.
  const existing =
    candidate.profileJson && typeof candidate.profileJson === 'object'
      ? (candidate.profileJson as Record<string, unknown>)
      : {};
  const cv =
    existing.cv && typeof existing.cv === 'object'
      ? { ...(existing.cv as Record<string, unknown>) }
      : {};

  let contact: { email?: string; phone?: string } = {};
  try {
    contact = applyToLocalCv(cv, suggestion);
  } catch (err) {
    void reportError(err, { area: 'candidate.suggestions.approve.apply', candidateId });
    return { ok: false, reason: 'failed' };
  }

  // 2. Push the delta to 8vance (best-effort — never fails the approve).
  await pushToVance(candidate, suggestion);

  // 3. Mark the suggestion approved + persist the local profile (and mirror
  //    contact onto the top-level candidate.email/phone the profile reads).
  suggestions[idx] = { ...suggestion, status: 'approved' };
  const nextProfile: Record<string, unknown> = { ...existing, cv };
  const data: Prisma.CandidateUpdateInput = {
    profileJson: nextProfile as Prisma.InputJsonValue,
    cvSuggestionsJson: suggestions as unknown as Prisma.InputJsonValue,
  };
  if (contact.email) data.email = contact.email;
  if (contact.phone) data.phone = contact.phone;

  try {
    await prisma.candidate.update({ where: { id: candidateId }, data });
  } catch (err) {
    void reportError(err, { area: 'candidate.suggestions.approve.persist', candidateId });
    return { ok: false, reason: 'failed' };
  }

  revalidatePath(`/app/candidates/${candidateId}/match`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 4. approveAllSuggestions — approve every pending suggestion
// ---------------------------------------------------------------------------

/**
 * Approve every currently-pending suggestion, SEQUENTIALLY (each approve is a
 * read-modify-write on cvSuggestionsJson, so serial execution avoids lost
 * updates). Each approve is independently org-guarded + best-effort; a single
 * failure is counted, not fatal. Returns how many landed vs failed.
 */
export async function approveAllSuggestions(candidateId: string): Promise<ApproveAllResult> {
  const session = await requireUser();
  const loaded = await loadOwned(candidateId, session.id);
  if (!loaded.ok) return loaded;

  const pendingIds = readSuggestions(loaded.candidate.cvSuggestionsJson)
    .filter((s) => s?.status === 'pending')
    .map((s) => s.id);

  let approved = 0;
  let failed = 0;
  for (const id of pendingIds) {
    const res = await approveSuggestion(candidateId, id);
    if (res.ok) approved += 1;
    else failed += 1;
  }

  return { ok: true, approved, failed };
}
