/**
 * requireAdmin re-validates the role against the DB (F6).
 *
 * The JWT `role` claim is fixed at sign-in and can be stale for up to the
 * session maxAge, so a demoted admin would keep admin power until their token
 * expires. requireAdmin now does a fresh DB read and fails closed. This test
 * asserts a stale ADMIN token is rejected once the DB role is CUSTOMER.
 *
 * Mirrors tests/candidates-access-guard.test.ts (mock @/auth with a controllable
 * session; use a real per-worker DB user for the authoritative role).
 *
 * Run with `npx vitest run tests/require-admin.test.ts`.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';

import { PrismaClient } from '@prisma/client';

// @/auth pulls Auth.js + Next server internals that don't resolve under vitest's
// node env — stub it with a controllable session (the "JWT" the user presents).
const authMock = vi.hoisted(() => vi.fn<() => Promise<unknown>>(async () => null));
vi.mock('@/auth', () => ({
  auth: authMock,
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

// requireUser calls redirect('/login') when there is no session. We always
// supply one, but stub next/navigation so an unexpected redirect throws loudly
// instead of dragging in Next server internals.
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

import { requireAdmin } from '../src/lib/auth-helpers';

const prisma = new PrismaClient();

const runTag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
let seq = 0;
async function makeUser(role: 'ADMIN' | 'CUSTOMER'): Promise<string> {
  const u = await prisma.user.create({
    data: { email: `reqadmin-${runTag}-${seq++}@test.local`, role },
    select: { id: true },
  });
  return u.id;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('requireAdmin (DB re-validation of role)', () => {
  it('REJECTS a demoted user despite a stale ADMIN token', async () => {
    const id = await makeUser('CUSTOMER'); // authoritative (current) role
    // Stale JWT still claims ADMIN:
    authMock.mockImplementation(async () => ({ user: { id, role: 'ADMIN' } }));
    await expect(requireAdmin()).rejects.toThrow(/admin role required/i);
  });

  it('allows a user who is ADMIN in the DB', async () => {
    const id = await makeUser('ADMIN');
    authMock.mockImplementation(async () => ({ user: { id, role: 'ADMIN' } }));
    const u = await requireAdmin();
    expect(u.id).toBe(id);
    expect(u.role).toBe('ADMIN');
  });

  it('fails closed when the token says ADMIN but the user was deleted', async () => {
    authMock.mockImplementation(async () => ({
      user: { id: 'no-such-user-id', role: 'ADMIN' },
    }));
    await expect(requireAdmin()).rejects.toThrow(/admin role required/i);
  });
});
