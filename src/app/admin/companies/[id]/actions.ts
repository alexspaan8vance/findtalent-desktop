'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import { requireAdmin } from '@/lib/auth-helpers';

// Used internally by updateTenantCredsAction to re-validate a rotated secret.
// NOT re-exported: a 'use server' module's `export { x } from '...'` re-export
// breaks the whole module (it ends up with no exports). The edit form imports
// detectVanceCredentialsAction + the DetectResult type straight from
// '../new/actions' instead.
import { detectVanceCredentialsAction } from '../new/actions';

const schema = z.object({
  id: z.string().min(1),
  defaultLocale: z.enum(['nl', 'en', 'de']),
});

const defaultPoolSchema = z.object({
  id: z.string().min(1),
});

const talentScopeSchema = z.object({
  id: z.string().min(1),
  // FULL = complete 8vance pool (all sources, historical default).
  // LOCAL = only talents registered through findtalent (this pool's own source).
  talentScope: z.enum(['FULL', 'LOCAL']),
});

const credsSchema = z.object({
  id: z.string().min(1),
  eightvanceClientId: z.string().min(1),
  // Blank = keep the existing secret.
  eightvanceClientSecret: z.string().optional(),
  // Optional re-detected values (only sent after a successful "Test" on the
  // edit form). Blank/absent = leave the stored value untouched.
  eightvanceCompanyId: z.coerce.number().int().positive().optional(),
  ownSourceSlug: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .optional(),
});

export type UpdateCredsResult = { ok: true } | { ok: false; error: string };

/**
 * Update a pool's 8vance client ID and (optionally) rotate its secret, plus
 * optionally apply a re-detected company id / own-source slug.
 *
 * Guard rails:
 *  - When a NEW secret is supplied, we RE-AUTHENTICATE it (no-gate detection
 *    client) before persisting — a bad rotation is rejected and nothing is
 *    written, so a working pool is never wiped by a typo.
 *  - When the secret field is blank, the existing (working) secret is kept and
 *    we only update the client id / detected fields. Branding edits go through
 *    their own forms and never touch creds.
 */
export async function updateTenantCredsAction(
  formData: FormData,
): Promise<UpdateCredsResult> {
  const admin = await requireAdmin();
  const parsed = credsSchema.safeParse({
    id: formData.get('id'),
    eightvanceClientId: formData.get('eightvanceClientId'),
    eightvanceClientSecret: formData.get('eightvanceClientSecret') ?? undefined,
    eightvanceCompanyId: formData.get('eightvanceCompanyId') || undefined,
    ownSourceSlug: formData.get('ownSourceSlug') || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: 'Please correct the credential fields and try again.' };
  }
  const input = parsed.data;

  const existing = await prisma.tenant.findUnique({
    where: { id: input.id },
    select: { eightvanceClientSecretEnc: true, eightvanceBaseUrl: true },
  });
  if (!existing) return { ok: false, error: 'Pool not found.' };

  const secret = (input.eightvanceClientSecret ?? '').trim();

  // If the secret is being rotated, validate it before persisting so a typo
  // can't break a live pool.
  if (secret.length > 0) {
    const res = await detectVanceCredentialsAction({
      eightvanceClientId: input.eightvanceClientId.trim(),
      eightvanceClientSecret: secret,
      eightvanceBaseUrl: existing.eightvanceBaseUrl ?? undefined,
    });
    if (!res.ok) return { ok: false, error: res.error };
  }

  const data: {
    eightvanceClientId: string;
    eightvanceClientSecretEnc?: string;
    eightvanceCompanyId?: number;
    ownSourceSlug?: string;
  } = {
    eightvanceClientId: input.eightvanceClientId.trim(),
  };
  if (secret.length > 0) data.eightvanceClientSecretEnc = encrypt(secret);
  if (input.eightvanceCompanyId !== undefined) data.eightvanceCompanyId = input.eightvanceCompanyId;
  if (input.ownSourceSlug !== undefined) data.ownSourceSlug = input.ownSourceSlug;

  await prisma.tenant.update({ where: { id: input.id }, data });

  await prisma.adminAuditLog.create({
    data: {
      adminUserId: admin.id,
      action: 'tenant.update.creds',
      targetType: 'Tenant',
      targetId: input.id,
      // Never log the secret; only whether it was rotated / re-detected.
      payloadJson: {
        clientIdChanged: true,
        secretRotated: secret.length > 0,
        companyIdUpdated: input.eightvanceCompanyId !== undefined,
        ownSourceUpdated: input.ownSourceSlug !== undefined,
      },
    },
  });

  revalidatePath(`/admin/companies/${input.id}`);
  return { ok: true };
}

/**
 * Make this pool the default for new candidates: set `isDefaultCandidatePool`
 * true on the given tenant and false on every other tenant, so exactly one pool
 * is ever the default. Done in a transaction to avoid a window with zero or two
 * defaults.
 */
export async function setDefaultCandidatePool(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = defaultPoolSchema.parse({ id: formData.get('id') });

  await prisma.$transaction([
    prisma.tenant.updateMany({
      where: { id: { not: parsed.id }, isDefaultCandidatePool: true },
      data: { isDefaultCandidatePool: false },
    }),
    prisma.tenant.update({
      where: { id: parsed.id },
      data: { isDefaultCandidatePool: true },
    }),
    prisma.adminAuditLog.create({
      data: {
        adminUserId: admin.id,
        action: 'tenant.setDefaultCandidatePool',
        targetType: 'Tenant',
        targetId: parsed.id,
        payloadJson: { isDefaultCandidatePool: true },
      },
    }),
  ]);

  revalidatePath('/admin/companies');
  revalidatePath(`/admin/companies/${parsed.id}`);
}

/**
 * Update a pool's project→talent matching scope. FULL draws from the complete
 * 8vance talent pool (all sources); LOCAL restricts matching to talents
 * registered through findtalent (the pool's own source). See job-sync.ts for
 * how LOCAL is enforced (and its slug→id limitation).
 */
export async function updateTenantTalentScopeAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = talentScopeSchema.parse({
    id: formData.get('id'),
    talentScope: formData.get('talentScope'),
  });

  await prisma.tenant.update({
    where: { id: parsed.id },
    data: { talentScope: parsed.talentScope },
  });

  await prisma.adminAuditLog.create({
    data: {
      adminUserId: admin.id,
      action: 'tenant.update.talentScope',
      targetType: 'Tenant',
      targetId: parsed.id,
      payloadJson: { talentScope: parsed.talentScope },
    },
  });

  revalidatePath(`/admin/companies/${parsed.id}`);
}

/** Update a pool's default wizard search language. */
export async function updateTenantLocaleAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = schema.parse({
    id: formData.get('id'),
    defaultLocale: formData.get('defaultLocale'),
  });

  await prisma.tenant.update({
    where: { id: parsed.id },
    data: { defaultLocale: parsed.defaultLocale },
  });

  await prisma.adminAuditLog.create({
    data: {
      adminUserId: admin.id,
      action: 'tenant.update.defaultLocale',
      targetType: 'Tenant',
      targetId: parsed.id,
      payloadJson: { defaultLocale: parsed.defaultLocale },
    },
  });

  revalidatePath(`/admin/companies/${parsed.id}`);
}
