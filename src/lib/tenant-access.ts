/**
 * Authorization source of truth for "which talent pools (Tenant rows) may this
 * user/org target?". Mirrors the org-ownership scoping used by the candidate
 * pool routes (src/app/app/candidates/page.tsx, api/candidates/pool/route.ts):
 *
 *   - ADMIN (platform operator) — every pool, incl. freshly-added ones with no
 *     owner-org/candidates yet.
 *   - everyone else — pools their primary org OWNS (Tenant.ownerOrganizationId)
 *     OR pools their org already has at least one Candidate in (the same loose
 *     scope the candidate list uses).
 *
 * Used to close an IDOR: project create/edit and refdata previously accepted any
 * existing tenant id, letting a caller drive an arbitrary tenant's 8vance creds.
 * Returns the set of tenant ids the caller is authorized to use.
 *
 * NB: lives in a NEUTRAL lib module (prisma + org only) — NOT in the
 * `/api/refdata/_shared` route module, which pulls in NextAuth/`next/server`
 * and would drag those into every server-action (and break vitest's node env)
 * if the helper were imported from there.
 */

import { prisma } from '@/lib/db';
import { getOrCreateUserOrg } from '@/lib/org';

export async function getAllowedTenantIds(
  userId: string,
  role: string,
): Promise<Set<string>> {
  if (role === 'ADMIN') {
    const all = await prisma.tenant.findMany({ select: { id: true } });
    return new Set(all.map((t) => t.id));
  }
  const orgId = await getOrCreateUserOrg(userId);
  const localTenantIds = (
    await prisma.candidate.findMany({
      where: { organizationId: orgId, tenantId: { not: null } },
      select: { tenantId: true },
      distinct: ['tenantId'],
    })
  )
    .map((c) => c.tenantId)
    .filter((id): id is string => !!id);
  const rows = await prisma.tenant.findMany({
    where: {
      OR: [
        { ownerOrganizationId: orgId },
        ...(localTenantIds.length > 0 ? [{ id: { in: localTenantIds } }] : []),
      ],
    },
    select: { id: true },
  });
  return new Set(rows.map((t) => t.id));
}
