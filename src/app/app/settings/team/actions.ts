'use server';

/**
 * Team-seats server actions.
 *
 * - Anyone authed can view their org's members (see page.tsx).
 * - Only the org OWNER can invite or remove members.
 *
 * Invite-by-email flow:
 *   1. If a User with that email already belongs to ANOTHER org, refuse
 *      (we never silently move someone between teams).
 *   2. If a User exists with no org (or this org), attach them as a MEMBER.
 *   3. If no User exists, create a minimal pending User row + membership so
 *      that when they sign up they land directly in this org (the signup hook
 *      keeps their existing organizationId).
 *
 * Credits/reveals stay per-user; this only grants shared PROJECT visibility.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { OrgRole } from '@prisma/client';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { getOrCreateUserOrg } from '@/lib/org';
import { sendEmail } from '@/lib/email';
import { renderOrgTemplate } from '@/lib/email/templates';
import { getBrandConfig } from '@/lib/brand/config';
import { buildInviteLink } from './invite-link';

export type TeamActionResult =
  | {
      ok: true;
      kind: 'attached' | 'pending' | 'removed' | 'resent';
      emailSent?: boolean;
      /** Copy-paste invite link (set for attached/pending/resent). */
      link?: string;
    }
  | {
      ok: false;
      reason:
        | 'invalid_email'
        | 'not_owner'
        | 'already_member'
        | 'in_other_org'
        | 'self'
        | 'not_found'
        | 'last_owner'
        | 'internal';
    };

/**
 * Best-effort: render the org's `team_invite` template and email the invitee.
 *
 * The membership already works without an email (the signup hook keeps the
 * pre-assigned org), so an email failure must NOT fail the invite — every
 * error here is swallowed and reported only as `emailSent: false`. We never
 * log the recipient address (no PII).
 *
 * - `brand` defaults from the brand config (env/whitelabel).
 * - `inviterName` is the acting owner's name || email.
 * - `link` points at /signup pre-filled with the invitee's email.
 */
async function sendTeamInvite(args: {
  orgId: string;
  invitedEmail: string;
  inviterName: string;
}): Promise<boolean> {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: args.orgId },
      select: { name: true },
    });
    const link = buildInviteLink(args.invitedEmail);
    const rendered = await renderOrgTemplate(args.orgId, 'team_invite', {
      brand: getBrandConfig().name,
      inviterName: args.inviterName,
      orgName: org?.name ?? getBrandConfig().name,
      link,
    });
    if (!rendered) return false;
    return await sendEmail({
      to: args.invitedEmail,
      subject: rendered.subject,
      html: rendered.html,
    });
  } catch {
    // Email is non-fatal — the invite/membership stands regardless.
    return false;
  }
}

const emailSchema = z.string().email();

/** Resolve the acting user's org and assert they are its OWNER. */
async function requireOwnerOrg(userId: string): Promise<string | null> {
  const orgId = await getOrCreateUserOrg(userId);
  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId } },
    select: { role: true },
  });
  if (!membership || membership.role !== OrgRole.OWNER) return null;
  return orgId;
}

export async function inviteMemberAction(formData: FormData): Promise<TeamActionResult> {
  const session = await requireUser();

  const rawEmail = String(formData.get('email') ?? '').trim().toLowerCase();
  const parsed = emailSchema.safeParse(rawEmail);
  if (!parsed.success) return { ok: false, reason: 'invalid_email' };
  const email = parsed.data;

  const orgId = await requireOwnerOrg(session.id);
  if (!orgId) return { ok: false, reason: 'not_owner' };

  if (email === session.email.toLowerCase()) return { ok: false, reason: 'self' };

  try {
    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true, organizationId: true },
    });

    if (existing) {
      if (existing.organizationId && existing.organizationId !== orgId) {
        return { ok: false, reason: 'in_other_org' };
      }
      const already = await prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: orgId, userId: existing.id } },
        select: { id: true },
      });
      if (already) return { ok: false, reason: 'already_member' };

      await prisma.$transaction([
        prisma.user.update({
          where: { id: existing.id },
          data: { organizationId: orgId },
        }),
        prisma.organizationMember.create({
          data: { organizationId: orgId, userId: existing.id, role: OrgRole.MEMBER },
        }),
      ]);
      const emailSent = await sendTeamInvite({
        orgId,
        invitedEmail: email,
        inviterName: session.name?.trim() || session.email,
      });
      revalidatePath('/app/settings/team');
      return { ok: true, kind: 'attached', emailSent, link: buildInviteLink(email) };
    }

    // No such user yet — create a minimal pending row + membership. They have
    // no passwordHash, so they cannot log in until they sign up; the signup
    // hook keeps this organizationId, dropping them straight into the team.
    await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email, role: 'CUSTOMER', organizationId: orgId },
        select: { id: true },
      });
      await tx.organizationMember.create({
        data: { organizationId: orgId, userId: created.id, role: OrgRole.MEMBER },
      });
    });
    const emailSent = await sendTeamInvite({
      orgId,
      invitedEmail: email,
      inviterName: session.name?.trim() || session.email,
    });
    revalidatePath('/app/settings/team');
    return { ok: true, kind: 'pending', emailSent, link: buildInviteLink(email) };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}

/**
 * Re-send the `team_invite` email to an existing member of the owner's org.
 * Owner-gated exactly like {@link inviteMemberAction}. Identifies the target
 * by userId (the page already has it). Never moves/creates membership — this
 * only re-sends the same invite email, so it's safe to call repeatedly.
 */
export async function resendInviteAction(formData: FormData): Promise<TeamActionResult> {
  const session = await requireUser();

  const targetUserId = String(formData.get('userId') ?? '').trim();
  if (!targetUserId) return { ok: false, reason: 'not_found' };

  const orgId = await requireOwnerOrg(session.id);
  if (!orgId) return { ok: false, reason: 'not_owner' };

  try {
    // Target must be a member of THIS org (no cross-tenant resends).
    const membership = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: orgId, userId: targetUserId } },
      select: { user: { select: { email: true } } },
    });
    if (!membership?.user.email) return { ok: false, reason: 'not_found' };

    const emailSent = await sendTeamInvite({
      orgId,
      invitedEmail: membership.user.email,
      inviterName: session.name?.trim() || session.email,
    });
    return {
      ok: true,
      kind: 'resent',
      emailSent,
      link: buildInviteLink(membership.user.email),
    };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}

export async function removeMemberAction(formData: FormData): Promise<TeamActionResult> {
  const session = await requireUser();

  const targetUserId = String(formData.get('userId') ?? '').trim();
  if (!targetUserId) return { ok: false, reason: 'not_found' };

  const orgId = await requireOwnerOrg(session.id);
  if (!orgId) return { ok: false, reason: 'not_owner' };

  try {
    const membership = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: orgId, userId: targetUserId } },
      select: { id: true, role: true },
    });
    if (!membership) return { ok: false, reason: 'not_found' };

    // Never remove the last OWNER — the org would become unmanageable.
    if (membership.role === OrgRole.OWNER) {
      const ownerCount = await prisma.organizationMember.count({
        where: { organizationId: orgId, role: OrgRole.OWNER },
      });
      if (ownerCount <= 1) return { ok: false, reason: 'last_owner' };
    }

    await prisma.$transaction(async (tx) => {
      await tx.organizationMember.delete({ where: { id: membership.id } });
      // If this org was the user's primary org, detach it so they fall back to
      // a fresh personal org on next request (their own projects stay theirs).
      await tx.user.updateMany({
        where: { id: targetUserId, organizationId: orgId },
        data: { organizationId: null },
      });
    });
    revalidatePath('/app/settings/team');
    return { ok: true, kind: 'removed' };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}
