'use server';

import { revalidatePath } from 'next/cache';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth-helpers';
import { MAX_LOGO_BYTES, safeHexColor, safeLogo } from '@/lib/brand/config';

const schema = z.object({
  accent: z.string(),
  name: z.string().optional(),
});

const PRIMARY_SLUG = process.env.TENANT_SLUG ?? 'ivta';

/** File MIME → data-URL media type we accept for logos. */
const ALLOWED_LOGO_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'image/webp',
]);

/**
 * Persist the deploy's brand accent + display name + logo onto the primary
 * tenant's brand config. Defensive: a bad/oversized logo upload is rejected
 * and the existing logo is kept; the action never throws on user input.
 */
export async function updateBrandAccentAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = schema.parse({
    accent: formData.get('accent'),
    name: formData.get('name') ?? undefined,
  });
  const accent = safeHexColor(parsed.accent, '#1f6f5c');

  const tenant = await prisma.tenant.findUnique({
    where: { slug: PRIMARY_SLUG },
    select: { id: true, brandConfigJson: true },
  });
  if (!tenant) throw new Error(`primary tenant "${PRIMARY_SLUG}" not found`);

  const cfg = (tenant.brandConfigJson ?? {}) as Record<string, unknown>;

  // Brand display name (optional). Empty input clears it (falls back to default).
  const rawName = (parsed.name ?? '').trim().slice(0, 80);

  // Logo upload (optional). Validate type + size, then store as a data URL.
  // On any problem we keep whatever logo was already stored.
  let logo: string | undefined =
    typeof cfg.logo === 'string' ? (cfg.logo as string) : undefined;
  let logoChanged = false;

  const file = formData.get('logo');
  if (file instanceof File && file.size > 0) {
    if (ALLOWED_LOGO_MIME.has(file.type) && file.size <= MAX_LOGO_BYTES) {
      try {
        const bytes = Buffer.from(await file.arrayBuffer());
        const candidate = `data:${file.type};base64,${bytes.toString('base64')}`;
        const safe = safeLogo(candidate);
        if (safe) {
          logo = safe;
          logoChanged = true;
        }
      } catch {
        // ignore — keep existing logo
      }
    }
    // else: wrong type or too big → silently keep existing logo
  }

  const nextCfg: Record<string, unknown> = { ...cfg, accent };
  if (rawName.length > 0) nextCfg.name = rawName;
  else delete nextCfg.name;
  if (logo) nextCfg.logo = logo;
  else delete nextCfg.logo;

  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { brandConfigJson: nextCfg as unknown as Prisma.InputJsonValue },
  });

  await prisma.adminAuditLog.create({
    data: {
      adminUserId: admin.id,
      action: 'brand.update',
      targetType: 'Tenant',
      targetId: tenant.id,
      // Don't store the (large) logo data URL in the audit log — just a flag.
      payloadJson: {
        accent,
        name: rawName.length > 0 ? rawName : null,
        logoChanged,
        hasLogo: Boolean(logo),
      },
    },
  });

  revalidatePath('/', 'layout');
}
