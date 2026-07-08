/**
 * `GET /api/tenants/list` — return the list of available talent pools
 * (Tenant rows) so logged-in users can pick one or more when creating
 * a project. Exposes ONLY public-safe fields (id/slug/name): no 8vance
 * client credentials.
 *
 * Cached for 60s in-memory to avoid hammering the DB on every wizard
 * step. The list rarely changes (admin manages it via /admin/companies).
 */

import { NextResponse } from 'next/server';

import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { getAllowedTenantIds } from '@/lib/tenant-access';

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  defaultLocale: string;
  /**
   * Whether this pool is the default for NEW candidates — the admin-flagged
   * default, OR (when only one pool exists) that single pool. Lets the
   * onboarding wizard + link-gen pre-select the right pool without the
   * candidate/recruiter picking sources.
   */
  isDefault: boolean;
}

interface SessionLike {
  user?: { id?: string | null } | null;
}

export async function GET(): Promise<NextResponse> {
  const session = (await auth()) as SessionLike | null;
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Authorization: return ONLY pools the caller's org may actually target — the
  // ones it OWNS or already has a candidate in (ADMIN sees all). Same fail-closed
  // scope the pool read-through + project-create enforce (src/lib/tenant-access),
  // so we never leak the full cross-tenant pool/customer roster to an arbitrary
  // logged-in account (incl. CUSTOMER accounts with no candidate access).
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (!me) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const allowedTenantIds = await getAllowedTenantIds(userId, me.role);

  // No in-memory cache: the tenant list is a tiny query, and a stale cache made
  // the wizard pre-select the OLD default pool for up to 60s after an admin
  // changed it (revalidatePath can't clear a module-level JS var). Query live.
  const raw = await prisma.tenant.findMany({
    where: { id: { in: Array.from(allowedTenantIds) } },
    orderBy: { name: 'asc' },
    select: { id: true, slug: true, name: true, defaultLocale: true, isDefaultCandidatePool: true },
  });
  // A single pool is implicitly the default; otherwise the admin-flagged one is.
  const flaggedDefault = raw.some((r) => r.isDefaultCandidatePool);
  const rows: TenantRow[] = raw.map(({ isDefaultCandidatePool, ...r }) => ({
    ...r,
    isDefault: flaggedDefault ? isDefaultCandidatePool : raw.length === 1,
  }));

  return NextResponse.json({ results: rows });
}
