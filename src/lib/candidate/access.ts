/**
 * DB-backed candidates-surface authorization for API routes.
 *
 * The edge middleware gates /app/candidates + /api/candidates off the JWT's
 * `candidatesEnabled` claim, but that claim can be STALE (it grandfathers
 * `undefined` so old sessions aren't kicked out) — and API routes must not
 * trust it as the only line. This helper reads the CURRENT flag from the DB,
 * so a just-revoked grant takes effect immediately at the API layer.
 *
 * Same semantics as {@link canAccessCandidates}: ADMIN always may; everyone
 * else needs `candidatesEnabled=true` (the column is non-null, default false).
 * Unknown user → false (fail-closed).
 *
 * Kept in a neutral lib module (prisma only — no NextAuth / next/server) so
 * route handlers, server actions, and vitest can all import it.
 */

import { prisma } from '@/lib/db';
import { canAccessCandidates } from '@/lib/access';

export async function userMayAccessCandidates(userId: string): Promise<boolean> {
  if (!userId) return false;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, candidatesEnabled: true },
  });
  if (!user) return false;
  return canAccessCandidates({
    role: user.role,
    candidatesEnabled: user.candidatesEnabled,
  });
}
