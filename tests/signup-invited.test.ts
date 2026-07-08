/**
 * Signup completion for a PRE-INVITED (pending) user.
 *
 * A team invite creates a User row with no passwordHash, an organizationId
 * (the inviter's org), and an OrganizationMember row. When that person later
 * signs up with the SAME email, `signupAction` must UPDATE the existing row
 * (set passwordHash + consent), PRESERVE their organizationId + membership,
 * and NOT crash when email is unconfigured (auto-verify + redirect to login).
 *
 * `redirect()` throws a NEXT_REDIRECT control-flow error; we assert on it
 * rather than treating it as a failure.
 *
 * Run with `npx vitest run tests/signup-invited.test.ts`.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// signupAction → auth-helpers → '@/auth' (Auth.js) pulls Next.js server
// internals that don't resolve under vitest's node env. The action only uses
// hashPassword/createSignupToken from auth-helpers (no runtime auth), so stub
// just the Auth.js module to break the import chain.
vi.mock('@/auth', () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

// Email unconfigured on this deploy: sendEmail no-ops and returns false.
vi.mock('../src/lib/email', () => ({
  sendEmail: vi.fn(async () => false),
  isEmailConfigured: () => false,
}));

import { signupAction, type SignupState } from '../src/app/(auth)/signup/actions';

/** Extract the redirect target from a thrown NEXT_REDIRECT error, if any. */
function redirectTarget(err: unknown): string | null {
  if (err && typeof err === 'object' && 'digest' in err) {
    const digest = String((err as { digest: unknown }).digest);
    if (digest.startsWith('NEXT_REDIRECT')) {
      // digest format: "NEXT_REDIRECT;replace;/login?verified=1;307;"
      const parts = digest.split(';');
      return parts[2] ?? '';
    }
  }
  return null;
}

function form(email: string, password: string): FormData {
  const fd = new FormData();
  fd.set('email', email);
  fd.set('password', password);
  fd.set('consent', 'on');
  return fd;
}

const initial: SignupState = { ok: false };

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.verificationToken.deleteMany();
  await prisma.organizationMember.deleteMany();
  await prisma.user.updateMany({ data: { organizationId: null } });
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
});

describe('signupAction — pre-invited (pending) user', () => {
  it('completes signup: updates passwordHash + consent, KEEPS organizationId + membership, auto-verifies (email off), no crash', async () => {
    // Inviter's org with a pending invited user (no passwordHash).
    const org = await prisma.organization.create({
      data: { name: 'Acme' },
      select: { id: true },
    });
    const invited = 'invitee@test.local';
    const pending = await prisma.user.create({
      data: {
        email: invited,
        role: 'CUSTOMER',
        organizationId: org.id,
        memberships: { create: { organizationId: org.id, role: 'MEMBER' } },
      },
      select: { id: true },
    });

    let target: string | null = null;
    try {
      await signupAction(initial, form(invited, 'sup3rsecret!'));
      throw new Error('expected signupAction to redirect');
    } catch (err) {
      target = redirectTarget(err);
      if (target === null) throw err; // a real crash, not a redirect
    }

    // Email is unconfigured → auto-verify + send to login.
    expect(target).toBe('/login?verified=1');

    // Same row updated (not a duplicate create).
    const rows = await prisma.user.findMany({ where: { email: invited } });
    expect(rows).toHaveLength(1);
    const u = rows[0]!;
    expect(u.id).toBe(pending.id); // SAME row
    expect(u.passwordHash).toBeTruthy(); // password set
    expect(u.consentGivenAt).not.toBeNull(); // consent recorded
    expect(u.emailVerifiedAt).not.toBeNull(); // auto-verified
    expect(u.organizationId).toBe(org.id); // org PRESERVED

    // Membership preserved.
    const membership = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: org.id, userId: pending.id } },
      select: { role: true },
    });
    expect(membership).not.toBeNull();
  });

  it('a fresh (non-invited) signup still works and gets a personal org', async () => {
    const email = 'fresh@test.local';
    let target: string | null = null;
    try {
      await signupAction(initial, form(email, 'sup3rsecret!'));
      throw new Error('expected redirect');
    } catch (err) {
      target = redirectTarget(err);
      if (target === null) throw err;
    }
    expect(target).toBe('/login?verified=1');

    const u = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(u.passwordHash).toBeTruthy();
    expect(u.organizationId).toBeTruthy(); // personal org created
  });

  it('an ACTIVE (verified) existing account gets the friendly "exists" path, not a crash', async () => {
    const email = 'active@test.local';
    await prisma.user.create({
      data: {
        email,
        passwordHash: 'existinghash',
        emailVerifiedAt: new Date(),
      },
    });

    const res = await signupAction(initial, form(email, 'sup3rsecret!'));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Account exists');

    // The existing hash must NOT have been overwritten (no silent takeover).
    const u = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(u.passwordHash).toBe('existinghash');
  });
});
