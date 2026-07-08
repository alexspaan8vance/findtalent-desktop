import 'server-only';

import { prisma } from '@/lib/db';

/**
 * Resolve the pool (Tenant) a NEW candidate should default into.
 *
 * Source/pool selection was removed from candidate onboarding — a candidate is
 * created in ONE pool, decided by the admin (or implicitly when there's only
 * one pool). Precedence:
 *   1. the tenant the admin flagged `isDefaultCandidatePool` (exactly one), else
 *   2. the only tenant, when a single pool exists, else
 *   3. null — multiple pools and no default set, so the caller must require an
 *      explicit pool (e.g. the recruiter picks one when generating the link).
 *
 * Returns the tenant id (+ its ownSourceSlug, handy for defaulting match
 * sources to the pool's own source) or null.
 */
export async function resolveDefaultCandidateTenant(): Promise<
  { id: string; ownSourceSlug: string | null } | null
> {
  const flagged = await prisma.tenant.findFirst({
    where: { isDefaultCandidatePool: true },
    select: { id: true, ownSourceSlug: true },
  });
  if (flagged) return flagged;

  const all = await prisma.tenant.findMany({
    select: { id: true, ownSourceSlug: true },
    take: 2,
  });
  return all.length === 1 ? all[0] : null;
}

/**
 * The default match sources for a candidate.
 *
 * Returns [] = "no explicit restriction" → executeMatchRun matches against the
 * talent's FULL set of available sources (own pool + enabled job feeds like
 * JobDigger / open-market + ecosystem) for that ONE pool's company.
 *
 * IMPORTANT: do NOT restrict to the pool's own source slug. The own source is
 * the company's TALENT pool — it holds candidates, not vacancies — so matching
 * a candidate against only that source yields ZERO jobs. Jobs live in the feeds.
 * The candidate is still scoped to one pool/company via tenantId (its 8vance
 * client), so matching all available sources stays within that company.
 *
 * `ownSourceSlug` is kept as a param for call-site clarity but intentionally
 * unused — the own slug is still used elsewhere (talent.create label, own-pool
 * job badge), just not to gate which job sources a candidate matches against.
 */
export function defaultSourcesForPool(_ownSourceSlug?: string | null): string[] {
  return [];
}
