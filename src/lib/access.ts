import type { AppRole } from '@/types/next-auth';

/**
 * Whether an account may access the Candidates surface (talent pool +
 * candidate→jobs match). ADMIN always may. Everyone else needs the explicit
 * `candidatesEnabled` grant; a legacy session where the flag is `undefined` is
 * grandfathered (allowed) so existing users aren't locked out before their
 * next login refreshes the token. Only an explicit `false` blocks.
 *
 * Pure + dependency-free so it's usable from the edge middleware, server
 * components, and tests alike.
 */
export function canAccessCandidates(user: {
  role: AppRole;
  candidatesEnabled?: boolean;
}): boolean {
  return user.role === 'ADMIN' || user.candidatesEnabled !== false;
}
