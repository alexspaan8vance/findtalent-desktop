import { redirect } from 'next/navigation';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { canAccessCandidates } from '@/lib/access';
import type { AppRole } from '@/types/next-auth';

export { canAccessCandidates };

const BCRYPT_COST = 12;
const SIGNUP_TOKEN_TTL_MS = 1000 * 60 * 60 * 24; // 24h
const RESET_TOKEN_TTL_MS = 1000 * 60 * 60; // 1h
const EMAILCHANGE_TOKEN_TTL_MS = 1000 * 60 * 60; // 1h

// Namespaced identifier prefixes for the shared verificationToken table. Each
// flow stores its own kind of token so consume helpers can refuse to honour a
// token minted for a different purpose (e.g. a signup token used to reset a
// password).
const RESET_PREFIX = 'reset:';
const EMAILCHANGE_PREFIX = 'emailchange:';

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  role: AppRole;
  candidatesEnabled?: boolean;
};

export async function requireUser(): Promise<SessionUser> {
  const session = await auth();
  const u = session?.user;
  if (!u?.id) {
    redirect('/login');
  }
  return {
    id: u.id,
    email: u.email ?? '',
    name: u.name ?? null,
    role: u.role,
    candidatesEnabled: u.candidatesEnabled,
  };
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  // Authoritative admin check: re-read the CURRENT role from the DB rather than
  // trusting the JWT `role` claim, which is fixed at sign-in and can be stale
  // for up to the session maxAge. Without this, a demoted admin keeps admin
  // power until their token expires. Mirrors the fresh-read pattern of
  // userMayAccessCandidates. Fail closed: missing/non-ADMIN → 403.
  const fresh = await prisma.user.findUnique({
    where: { id: user.id },
    select: { role: true },
  });
  if (fresh?.role !== 'ADMIN') {
    const err = new Error('Forbidden: admin role required');
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
  return { ...user, role: fresh.role as AppRole };
}

/**
 * Defense-in-depth guard for candidate pages/routes (the middleware is the
 * primary gate). Redirects a page request to /app/projects when the user lacks
 * candidate access. Use in a Server Component loader.
 */
export async function requireCandidatesAccess(): Promise<SessionUser> {
  const user = await requireUser();
  if (!canAccessCandidates(user)) {
    redirect('/app/projects');
  }
  return user;
}

export async function createSignupToken(email: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SIGNUP_TOKEN_TTL_MS);
  await prisma.verificationToken.create({
    data: { identifier: email, token, expires },
  });
  return token;
}

export type ConsumeResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'not_found' | 'expired' };

export async function consumeSignupToken(token: string): Promise<ConsumeResult> {
  const row = await prisma.verificationToken.findUnique({ where: { token } });
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.expires.getTime() < Date.now()) {
    await prisma.verificationToken.delete({ where: { token } }).catch(() => {});
    return { ok: false, reason: 'expired' };
  }
  await prisma.verificationToken.delete({ where: { token } });
  return { ok: true, email: row.identifier };
}

// ---------------------------------------------------------------------------
// Password reset tokens — identifier `reset:<email>`, 1h TTL.
// ---------------------------------------------------------------------------

export async function createPasswordResetToken(email: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await prisma.verificationToken.create({
    data: { identifier: `${RESET_PREFIX}${email}`, token, expires },
  });
  return token;
}

export type ConsumeResetResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'not_found' | 'expired' };

export async function consumePasswordResetToken(
  token: string,
): Promise<ConsumeResetResult> {
  const row = await prisma.verificationToken.findUnique({ where: { token } });
  // Only honour tokens minted by the reset flow — never a signup/email-change
  // token that happens to share the table.
  if (!row || !row.identifier.startsWith(RESET_PREFIX)) {
    return { ok: false, reason: 'not_found' };
  }
  if (row.expires.getTime() < Date.now()) {
    await prisma.verificationToken.delete({ where: { token } }).catch(() => {});
    return { ok: false, reason: 'expired' };
  }
  await prisma.verificationToken.delete({ where: { token } });
  return { ok: true, email: row.identifier.slice(RESET_PREFIX.length) };
}

// ---------------------------------------------------------------------------
// Email-change tokens — identifier `emailchange:<userId>:<newEmail>`, 1h TTL.
// The user id is bound into the token so a confirmation can only ever apply to
// the account that requested it.
// ---------------------------------------------------------------------------

export async function createEmailChangeToken(
  userId: string,
  newEmail: string,
): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + EMAILCHANGE_TOKEN_TTL_MS);
  await prisma.verificationToken.create({
    data: {
      identifier: `${EMAILCHANGE_PREFIX}${userId}:${newEmail}`,
      token,
      expires,
    },
  });
  return token;
}

export type ConsumeEmailChangeResult =
  | { ok: true; userId: string; newEmail: string }
  | { ok: false; reason: 'not_found' | 'expired' };

export async function consumeEmailChangeToken(
  token: string,
): Promise<ConsumeEmailChangeResult> {
  const row = await prisma.verificationToken.findUnique({ where: { token } });
  if (!row || !row.identifier.startsWith(EMAILCHANGE_PREFIX)) {
    return { ok: false, reason: 'not_found' };
  }
  if (row.expires.getTime() < Date.now()) {
    await prisma.verificationToken.delete({ where: { token } }).catch(() => {});
    return { ok: false, reason: 'expired' };
  }
  // Strip the prefix, then split on the FIRST ':' — emails never contain ':'
  // but user ids are opaque cuids without one, so the first segment is the id
  // and the remainder is the new email.
  const rest = row.identifier.slice(EMAILCHANGE_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep < 0) {
    await prisma.verificationToken.delete({ where: { token } }).catch(() => {});
    return { ok: false, reason: 'not_found' };
  }
  const userId = rest.slice(0, sep);
  const newEmail = rest.slice(sep + 1);
  await prisma.verificationToken.delete({ where: { token } });
  return { ok: true, userId, newEmail };
}
