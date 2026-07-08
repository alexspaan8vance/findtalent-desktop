'use server';

/**
 * Email-template settings server actions.
 *
 * - Save: update one template's subject + body for the acting user's org.
 * - Reset: restore one template to its seeded default copy.
 *
 * Security: authed (`requireUser`) + org-scoped (the `[organizationId, key]`
 * unique constraint + an explicit `organizationId` filter on every write).
 * Only OWNERs may edit. The `key` is validated against the known set, so a
 * forged form value can never touch an arbitrary row. Bodies are authored by
 * trusted org admins; dynamic placeholder values are escaped at render time
 * (see `renderTemplate`), not here.
 */

import { revalidatePath } from 'next/cache';
import { OrgRole } from '@prisma/client';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { getOrCreateUserOrg } from '@/lib/org';
import {
  defaultTemplate,
  isTemplateKey,
  seedOrgTemplates,
} from '@/lib/email/templates';

export type TemplateActionResult =
  | { ok: true; kind: 'saved' | 'reset' }
  | { ok: false; reason: 'not_owner' | 'invalid_key' | 'invalid_input' };

const MAX_SUBJECT = 300;
const MAX_BODY = 20000;

async function requireOwnerOrg(userId: string): Promise<string | null> {
  const orgId = await getOrCreateUserOrg(userId);
  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId } },
    select: { role: true },
  });
  if (!membership || membership.role !== OrgRole.OWNER) return null;
  return orgId;
}

export async function saveTemplateAction(
  formData: FormData,
): Promise<TemplateActionResult> {
  const session = await requireUser();

  const key = String(formData.get('key') ?? '');
  if (!isTemplateKey(key)) return { ok: false, reason: 'invalid_key' };

  const subject = String(formData.get('subject') ?? '').trim();
  const body = String(formData.get('body') ?? '').trim();
  if (
    subject.length === 0 ||
    subject.length > MAX_SUBJECT ||
    body.length === 0 ||
    body.length > MAX_BODY
  ) {
    return { ok: false, reason: 'invalid_input' };
  }

  const orgId = await requireOwnerOrg(session.id);
  if (!orgId) return { ok: false, reason: 'not_owner' };

  // Ensure the row exists (lazy seed) before updating.
  await seedOrgTemplates(orgId);
  await prisma.emailTemplate.update({
    where: { organizationId_key: { organizationId: orgId, key } },
    data: { subject, body },
  });

  revalidatePath('/app/settings/email-templates');
  return { ok: true, kind: 'saved' };
}

export async function resetTemplateAction(
  formData: FormData,
): Promise<TemplateActionResult> {
  const session = await requireUser();

  const key = String(formData.get('key') ?? '');
  if (!isTemplateKey(key)) return { ok: false, reason: 'invalid_key' };

  const orgId = await requireOwnerOrg(session.id);
  if (!orgId) return { ok: false, reason: 'not_owner' };

  await seedOrgTemplates(orgId);
  const def = defaultTemplate(key);
  await prisma.emailTemplate.update({
    where: { organizationId_key: { organizationId: orgId, key } },
    data: { name: def.name, subject: def.subject, body: def.body },
  });

  revalidatePath('/app/settings/email-templates');
  return { ok: true, kind: 'reset' };
}
