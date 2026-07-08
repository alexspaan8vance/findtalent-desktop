'use server';

/**
 * Server action: spend a credit, acquire the 14-day exclusive lock on a
 * talent, and cache the encrypted PII payload for reveal.
 *
 * Memory `feedback_security_critical`: ownership of the parent Project is
 * verified before any external API call or credit-spend. Decrypted PII is
 * never logged.
 */

import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth-helpers';
import { prisma } from '@/lib/db';
import { getOrCreateUserOrg, userCanAccessProject } from '@/lib/org';
import { encrypt, decrypt } from '@/lib/crypto';
import { recordOutreach, hasOutreach } from '@/lib/outreach';
import { renderOrgTemplate } from '@/lib/email/templates';
import {
  acquireReveal,
  hasActiveLock,
  InsufficientCreditsError,
  LockExistsError,
} from '@/lib/reveal/lock';
import { vanceClientForTenant } from '@/lib/eightvance/tenant-client';
import { notify } from '@/lib/notifications/deliver';
import { buildRevealed } from '@/lib/anonymize/reveal';
import type {
  RawTalent,
  RawTalentEducation,
  RawTalentExperience,
  RawTalentLanguage,
  RawTalentSkill,
} from '@/lib/anonymize/types';

export type RevealReason =
  | 'not_found'
  | 'locked'
  | 'insufficient_credits'
  | 'past_due'
  | 'internal';

export type RevealActionResult =
  | { ok: true; revealId: string; alreadyOwned: boolean; alreadyShared?: boolean }
  | {
      ok: false;
      reason: RevealReason;
      /**
       * Server-side log detail only. NOT for display — the UI renders a
       * localized string by `reason` (see reveal-button.tsx). Optional so
       * callers never accidentally surface a hardcoded-language string.
       */
      message?: string;
      expiresAt?: string;
    };

export async function revealAction(matchId: string): Promise<RevealActionResult> {
  const session = await requireUser();

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      opaqueId: true,
      projectId: true,
      tenantId: true,
      eightvanceTalentId: true,
      project: { select: { id: true, userId: true, organizationId: true } },
    },
  });
  if (!match || !(await userCanAccessProject(session.id, match.project))) {
    return { ok: false, reason: 'not_found', message: 'Match not found' };
  }

  // Soft gate: block NEW reveals while the account is past_due (failed billing).
  // Read access and existing reveals stay intact — we only refuse a fresh spend.
  // Checked before any external 8vance call or credit transaction.
  const billing = await prisma.user.findUnique({
    where: { id: session.id },
    select: { subscriptionStatus: true },
  });
  if (billing?.subscriptionStatus === 'past_due') {
    return {
      ok: false,
      reason: 'past_due',
      message: 'Subscription past due — update payment to reveal candidates.',
    };
  }

  // Same-tenant lock check.
  const lock = await hasActiveLock(
    match.eightvanceTalentId,
    match.tenantId,
    session.id,
  );
  if (lock.locked && lock.ownedByCurrentUser && lock.revealId) {
    return { ok: true, revealId: lock.revealId, alreadyOwned: true };
  }

  // Project-scoped SHARED reveal: if a teammate already revealed this talent on
  // THIS exact project (non-expired), a colleague reuses it for free — no
  // credit spend, no new lock claim. Access to the project was verified above
  // (userCanAccessProject). Pinned to (projectId, eightvanceTalentId): 8vance
  // talent ids are GLOBAL (one id == one person across all pools), so a reveal
  // under any pool of this project is the same person — NOT scoped by tenantId
  // (that would re-charge the same person when reached via a different pool).
  const sharedReveal = await prisma.reveal.findFirst({
    where: {
      projectId: match.projectId,
      eightvanceTalentId: match.eightvanceTalentId,
      expiresAt: { gt: new Date() },
    },
    orderBy: { revealedAt: 'desc' },
    select: { id: true },
  });
  if (sharedReveal) {
    return { ok: true, revealId: sharedReveal.id, alreadyOwned: false, alreadyShared: true };
  }

  if (lock.locked && !lock.ownedByCurrentUser) {
    return {
      ok: false,
      reason: 'locked',
      expiresAt: lock.expiresAt?.toISOString(),
    };
  }

  // Fetch full talent profile from 8vance (re-call all sub-resources).
  const client = await vanceClientForTenant(match.tenantId);
  const tid = match.eightvanceTalentId;
  const [profile, skills, experience, education, languages, location] = await Promise.all([
    client.talent.getProfile(tid),
    client.talent.getSkills(tid).catch(() => []),
    client.talent.getExperience(tid).catch(() => []),
    client.talent.getEducation(tid).catch(() => []),
    client.talent.getLanguages(tid).catch(() => []),
    client.talent.getLocation(tid).catch(() => null),
  ]);

  const raw: RawTalent = {
    id: tid,
    first_name: stringOrNull((profile as { first_name?: unknown }).first_name),
    last_name: stringOrNull((profile as { last_name?: unknown }).last_name),
    email: profile.email ?? null,
    phone: profile.phone ?? null,
    date_of_birth: stringOrNull((profile as { date_of_birth?: unknown }).date_of_birth),
    cv_url: stringOrNull((profile as { cv_url?: unknown }).cv_url),
    linkedin_url: stringOrNull((profile as { linkedin_url?: unknown }).linkedin_url),
    photo_url: stringOrNull((profile as { photo_url?: unknown }).photo_url),
    function_name: stringOrNull((profile as { function_name?: unknown }).function_name),
    function_level: numberOrNull((profile as { function_level?: unknown }).function_level),
    total_years_experience: numberOrNull(
      (profile as { total_years_experience?: unknown }).total_years_experience,
    ),
    hours_per_week: numberOrNull((profile as { hours_per_week?: unknown }).hours_per_week),
    start_date: stringOrNull((profile as { start_date?: unknown }).start_date),
    score: numberOrNull((profile as { score?: unknown }).score),
    location: location
      ? {
          city: location.city ?? null,
          country: location.country ?? null,
          latitude: location.latitude != null ? Number(location.latitude) : null,
          longitude: location.longitude != null ? Number(location.longitude) : null,
        }
      : null,
    skills: skills.map((s): RawTalentSkill => ({
      skill_id: s.skill,
      proficiency_id: s.proficiency_id ?? s.proficiency ?? null,
    })),
    experience: experience.map((e): RawTalentExperience => {
      const fn = e.function_name;
      const fnStr = typeof fn === 'string' ? fn : null;
      return {
        function_title: e.function_title ?? e.title ?? fnStr ?? null,
        company_name: e.company_name ?? null,
        start_date: e.start_date ?? null,
        end_date: e.end_date ?? null,
        is_current: e.current_job === true || e.end_date == null,
      };
    }),
    education: education.map((e): RawTalentEducation => ({
      level: e.degree?.phrase ?? (e.education_degree != null ? String(e.education_degree) : null),
      field_of_study_category:
        e.education_type ?? (e.education_subject != null ? String(e.education_subject) : null),
      school_name: e.school ?? e.institution ?? null,
      end_year: yearFrom(e.end_date),
    })),
    languages: languages
      .map((l): RawTalentLanguage => ({
        language:
          typeof l.language_name === 'string' && l.language_name.trim()
            ? l.language_name
            : l.language != null
              ? String(l.language)
              : '',
        level: String(l.speak_level ?? l.proficiency_id ?? ''),
      }))
      .filter((l) => l.language.length > 0),
  };

  const revealed = buildRevealed(raw);
  const ciphertext = encrypt(JSON.stringify(revealed));

  try {
    const row = await acquireReveal({
      userId: session.id,
      projectId: match.projectId,
      tenantId: match.tenantId,
      eightvanceTalentId: tid,
      rawProfileEncrypted: ciphertext,
    });
    // Revalidate the shortlist so the now-revealed candidate re-sorts to the
    // top with their name. (The detail page itself is refreshed client-side
    // via router.refresh after the action resolves.)
    revalidatePath(`/app/projects/${match.projectId}/shortlist`);

    // Fire a reveal-confirmation notification (subject to the user's prefs).
    // Payload carries only non-PII ids/counts — never the decrypted profile.
    const brand = process.env.BRAND_NAME ?? 'FindTalent';
    const baseUrl = process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
    // The talent detail route is segment [opaqueId] — link by opaqueId, NOT
    // match.id, or the emailed link 404s (page queries where:{projectId,opaqueId}).
    const talentUrl = `${baseUrl}/app/projects/${match.projectId}/talent/${match.opaqueId}`;
    await notify({
      userId: session.id,
      type: 'reveal_confirmation',
      payload: {
        revealId: row.id,
        projectId: match.projectId,
        matchId: match.id,
        creditCost: 1,
      },
      email: {
        subject: `${brand}: candidate revealed`,
        html: renderRevealEmail({ brand, talentUrl }),
      },
    }).catch(() => {
      // Delivery failures must not break the reveal itself.
    });

    return { ok: true, revealId: row.id, alreadyOwned: false };
  } catch (err) {
    if (err instanceof LockExistsError) {
      return {
        ok: false,
        reason: 'locked',
        expiresAt: err.expiresAt.toISOString(),
      };
    }
    if (err instanceof InsufficientCreditsError) {
      return {
        ok: false,
        reason: 'insufficient_credits',
      };
    }
    return {
      ok: false,
      reason: 'internal',
    };
  }
}

// ---------------------------------------------------------------------------
// Templated outreach (after reveal)
// ---------------------------------------------------------------------------

export type OutreachReason = 'not_found' | 'not_revealed' | 'internal';

export type OutreachActionResult =
  | {
      ok: true;
      /** ISO date of the first recorded outreach to this candidate. */
      contactedAt: string;
      /** Prefilled draft so the recruiter sends from their own mail client. */
      mailto: { to: string | null; subject: string; bodyText: string };
    }
  | { ok: false; reason: OutreachReason; message?: string };

/**
 * Record an outreach attempt to a candidate the current user has revealed.
 *
 * We do NOT email the candidate from the platform. Instead we (a) write an
 * `Outreach` row (the "Contacted" state), and (b) render the org's
 * `candidate_outreach` template into a prefilled `mailto:` (subject + plain
 * body + the revealed email) so the recruiter sends from their own client.
 *
 * Security: ownership of the parent project AND an active reveal lock owned by
 * the current user are both required before any PII (the revealed email) is
 * read — otherwise we'd leak the address of a candidate this user hasn't paid
 * to reveal. PII is never written to the Outreach row or logged.
 */
export async function recordOutreachAction(
  matchId: string,
): Promise<OutreachActionResult> {
  const session = await requireUser();

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      opaqueId: true,
      projectId: true,
      tenantId: true,
      eightvanceTalentId: true,
      project: {
        select: { id: true, userId: true, organizationId: true, title: true },
      },
    },
  });
  if (!match || !(await userCanAccessProject(session.id, match.project))) {
    return { ok: false, reason: 'not_found', message: 'Match not found' };
  }

  // The current user must hold the active reveal lock — only then may we read
  // the revealed PII to prefill the recruiter's mail draft.
  const lock = await hasActiveLock(
    match.eightvanceTalentId,
    match.tenantId,
    session.id,
  );
  if (!(lock.locked && lock.ownedByCurrentUser && lock.revealId)) {
    return { ok: false, reason: 'not_revealed' };
  }

  let revealedEmail: string | null = null;
  let candidateRef = '';
  const revealRow = await prisma.reveal.findUnique({
    where: { id: lock.revealId },
    select: { piiPayloadEnc: true },
  });
  if (revealRow) {
    try {
      const json = decrypt(revealRow.piiPayloadEnc);
      const profile = JSON.parse(json) as { email?: string | null; id?: number };
      revealedEmail = typeof profile.email === 'string' ? profile.email : null;
      candidateRef = profile.id != null ? `#${profile.id}` : '';
    } catch {
      // A corrupt payload must not block recording outreach.
    }
  }

  try {
    await recordOutreach({
      userId: session.id,
      projectId: match.projectId,
      tenantId: match.tenantId,
      eightvanceTalentId: match.eightvanceTalentId,
      templateKey: 'candidate_outreach',
    });

    // Render the org's candidate_outreach template for the prefilled mailto.
    const orgId = await getOrCreateUserOrg(session.id);
    const rendered = await renderOrgTemplate(orgId, 'candidate_outreach', {
      candidateRef: candidateRef || match.eightvanceTalentId.toString(),
      projectTitle: match.project.title,
      // Fall back to the brand name (never the recruiter's login email) when
      // the recruiter has no display name set — keep personal contact out of
      // the outreach signature unless they deliberately set a name. `.trim() ||`
      // so an empty/whitespace name also falls through (?? would keep '').
      recruiterName: session.name?.trim() || process.env.BRAND_NAME?.trim() || 'FindTalent',
      link: `${process.env.NEXTAUTH_URL ?? 'http://localhost:3000'}/app/projects/${match.projectId}/talent/${match.id}`,
    });
    const subject = rendered?.subject ?? `Opportunity: ${match.project.title}`;
    const bodyText = htmlToText(rendered?.html ?? '');

    // Notify the recruiter (in-app + their own email pref). Payload carries
    // only ids — never the candidate's contact details.
    await notify({
      userId: session.id,
      type: 'reveal_confirmation',
      payload: {
        kind: 'outreach_recorded',
        projectId: match.projectId,
        matchId: match.id,
      },
    }).catch(() => {});

    // Re-read the earliest contact date so the badge is stable across reloads.
    const status = await hasOutreach({
      userId: session.id,
      projectId: match.projectId,
      eightvanceTalentId: match.eightvanceTalentId,
    });

    revalidatePath(`/app/projects/${match.projectId}/talent/${match.opaqueId}`);

    return {
      ok: true,
      contactedAt: (status.firstAt ?? new Date()).toISOString(),
      mailto: { to: revealedEmail, subject, bodyText },
    };
  } catch {
    return { ok: false, reason: 'internal', message: 'Could not record outreach.' };
  }
}

/**
 * Best-effort HTML → plain text for a `mailto:` body. The template body is
 * authored by org admins (trusted) and only used to seed the recruiter's
 * draft, so a light strip (block tags → newlines, strip the rest, decode the
 * few entities our renderer emits) is sufficient.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function renderRevealEmail(opts: { brand: string; talentUrl: string }): string {
  const brand = opts.brand
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `
    <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#16181d">Candidate revealed</h2>
      <p style="color:#374151">
        You've used 1 credit to reveal a candidate. You now have 14 days of
        exclusive access to their contact details and CV.
      </p>
      <p>
        <a href="${opts.talentUrl}" style="display:inline-block;background:#1f6f5c;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">
          View candidate
        </a>
      </p>
      <p style="color:#6b7280;font-size:12px">
        Sent by ${brand} — manage notification preferences in your settings.
      </p>
    </div>
  `;
}

function stringOrNull(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v;
  if (typeof v === 'number') return String(v);
  return null;
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function yearFrom(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).getUTCFullYear();
}
