'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import { requireAdmin } from '@/lib/auth-helpers';
import { getOrCreateUserOrg } from '@/lib/org';
import { VanceClient, VanceAuthError, VanceError } from '@/lib/eightvance';

/** Result of a credential validation / context-detection attempt. */
export type DetectResult =
  | {
      ok: true;
      /** Numeric company id, or null when the pool has zero talents. */
      companyId: number | null;
      /** Real 8vance source slugs (own pool + external feeds). */
      sources: string[];
      /** Most-likely "own" source slug (first non-feed), or null. */
      suggestedOwnSource: string | null;
    }
  | { ok: false; error: string };

const detectSchema = z.object({
  eightvanceClientId: z.string().min(1),
  eightvanceClientSecret: z.string().min(1),
  eightvanceBaseUrl: z
    .string()
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

/**
 * Authenticate the submitted creds against 8vance and detect the pool's
 * company id + source slugs. Makes REAL calls (auth + `GET /talent/` +
 * `GET /talent/{id}/sources/`) via a NO-GATE detection client (the company id
 * is unknown at detect time). Admin-only. NEVER logs/echoes the client secret.
 */
export async function detectVanceCredentialsAction(input: {
  eightvanceClientId: string;
  eightvanceClientSecret: string;
  eightvanceBaseUrl?: string;
}): Promise<DetectResult> {
  await requireAdmin();

  const parsed = detectSchema.safeParse({
    eightvanceClientId: input.eightvanceClientId,
    eightvanceClientSecret: input.eightvanceClientSecret,
    eightvanceBaseUrl: input.eightvanceBaseUrl ?? '',
  });
  if (!parsed.success) {
    return { ok: false, error: 'Client ID and client secret are required.' };
  }

  try {
    const client = VanceClient.forDetection({
      clientId: parsed.data.eightvanceClientId.trim(),
      clientSecret: parsed.data.eightvanceClientSecret,
      baseUrl: parsed.data.eightvanceBaseUrl,
    });
    const { companyId, sources } = await client.detectContext();
    return {
      ok: true,
      companyId,
      sources,
      suggestedOwnSource: VanceClient.pickOwnSource(sources),
    };
  } catch (err) {
    return { ok: false, error: describeVanceError(err) };
  }
}

/** Map a thrown error to a clear, secret-free inline message. */
function describeVanceError(err: unknown): string {
  if (err instanceof VanceAuthError) {
    return 'Invalid 8vance credentials (authentication failed).';
  }
  if (err instanceof VanceError) {
    if (err.status === 0) {
      return '8vance is unreachable. Check the base URL and try again.';
    }
    if (err.status === 401 || err.status === 403) {
      return 'Invalid 8vance credentials (authentication failed).';
    }
    return `8vance returned an error (HTTP ${err.status}).`;
  }
  return 'Could not reach 8vance with these credentials.';
}

const createSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  eightvanceClientId: z.string().min(1),
  eightvanceClientSecret: z.string().min(1),
  // Auto-detected, but allowed as a manual fallback for zero-talent pools.
  eightvanceCompanyId: z.coerce.number().int().positive(),
  // Optional API host: blank = deploy default (PROD app.8vance.com/public/v1).
  // Set to https://acc.8vance.com/public/v1 for ACC pools (KNSV, 2D Tax test).
  eightvanceBaseUrl: z
    .string()
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  // Source slug this company's own talents/jobs carry (own-pool labelling +
  // own vs open-market split). Detected from 8vance; manual fallback allowed.
  ownSourceSlug: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  brandPrimaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#0f172a'),
  defaultLocale: z.enum(['nl', 'en', 'de']).default('en'),
});

export type CreateTenantResult = { ok: false; error: string };

/**
 * Create a new pool (Tenant). Server-side enforcement: we do NOT trust the
 * client's "validated" flag — before persisting we RE-AUTHENTICATE with the
 * submitted creds and re-run detection to confirm they work and (when the
 * pool has talents) to confirm the company id. On any auth failure we return
 * an error and create nothing. The client secret stays encrypted at rest.
 *
 * Returns an error object on failure; on success it `redirect()`s (which
 * throws internally, so the function never returns on the happy path).
 */
export async function createTenantAction(
  formData: FormData,
): Promise<CreateTenantResult> {
  const admin = await requireAdmin();
  const parsed = createSchema.safeParse({
    slug: formData.get('slug'),
    name: formData.get('name'),
    eightvanceClientId: formData.get('eightvanceClientId'),
    eightvanceClientSecret: formData.get('eightvanceClientSecret'),
    eightvanceCompanyId: formData.get('eightvanceCompanyId'),
    eightvanceBaseUrl: formData.get('eightvanceBaseUrl') ?? '',
    ownSourceSlug: formData.get('ownSourceSlug') ?? '',
    brandPrimaryColor: formData.get('brandPrimaryColor') ?? '#0f172a',
    defaultLocale: formData.get('defaultLocale') ?? 'en',
  });
  if (!parsed.success) {
    // Name the offending field + the concrete reason (the form shows this
    // string verbatim, so a generic "highlighted fields" was useless — nothing
    // is highlighted). The slug regex (lowercase only) is the usual trip-up.
    const issue = parsed.error.issues[0];
    const field = String(issue?.path[0] ?? '');
    const FIELD_MSG: Record<string, string> = {
      slug: 'Slug must be lowercase letters, numbers and hyphens only — no capitals or spaces (e.g. "bluecircle").',
      name: 'Display name is required.',
      eightvanceClientId: '8vance client ID is required.',
      eightvanceClientSecret: '8vance client secret is required.',
      eightvanceCompanyId: 'Company ID must be a positive number.',
      eightvanceBaseUrl: '8vance API base URL must be a valid URL, or left blank for PROD.',
      ownSourceSlug: 'Own source slug must be lowercase letters, numbers and underscores.',
      brandPrimaryColor: 'Brand color must be a hex value like #0f172a.',
    };
    return {
      ok: false,
      error: FIELD_MSG[field] ?? `Invalid ${field || 'input'}: ${issue?.message ?? 'please check the form.'}`,
    };
  }
  const data = parsed.data;

  // SERVER-SIDE GATE: re-authenticate + re-detect with the submitted creds.
  // A direct POST that skipped the client-side "Test credentials" step is
  // rejected here.
  let detectedCompanyId: number | null = null;
  try {
    const client = VanceClient.forDetection({
      clientId: data.eightvanceClientId.trim(),
      clientSecret: data.eightvanceClientSecret,
      baseUrl: data.eightvanceBaseUrl,
    });
    const detected = await client.detectContext();
    detectedCompanyId = detected.companyId;
  } catch (err) {
    return { ok: false, error: describeVanceError(err) };
  }

  // Prefer the freshly-detected company id; fall back to the submitted value
  // only when the pool has zero talents (detection can't derive it). The
  // submitted value is required by the schema so there is always a number.
  const companyId = detectedCompanyId ?? data.eightvanceCompanyId;

  // Claim the pool's intake org for the operator who creates it, so public
  // /apply applicants route here and the pool is owned from the start (the
  // candidates list shows owned pools for non-admins; admins see all anyway).
  const ownerOrganizationId = await getOrCreateUserOrg(admin.id);

  const tenant = await prisma.tenant.create({
    data: {
      slug: data.slug,
      name: data.name,
      eightvanceClientId: data.eightvanceClientId.trim(),
      eightvanceClientSecretEnc: encrypt(data.eightvanceClientSecret),
      eightvanceCompanyId: companyId,
      eightvanceBaseUrl: data.eightvanceBaseUrl ?? null,
      ownSourceSlug: data.ownSourceSlug ?? null,
      ownerOrganizationId,
      brandConfigJson: { name: data.name, primaryColor: data.brandPrimaryColor },
      defaultLocale: data.defaultLocale,
    },
  });

  await prisma.adminAuditLog.create({
    data: {
      adminUserId: admin.id,
      action: 'tenant.create',
      targetType: 'Tenant',
      targetId: tenant.id,
      // Never log the secret; record the (non-secret) detected context.
      payloadJson: {
        slug: tenant.slug,
        name: tenant.name,
        companyIdDetected: detectedCompanyId !== null,
      },
    },
  });

  redirect(`/admin/companies/${tenant.id}`);
}
