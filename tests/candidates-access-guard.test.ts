/**
 * candidatesEnabled enforcement at the API layer (FIX 3).
 *
 * The edge middleware's /api/candidates gate reads the JWT claim (stale-able);
 * the authoritative check is server-side against the DB:
 *   - userMayAccessCandidates(userId)          — shared helper (pool /
 *     match-status / run-match routes).
 *   - requireApiUser(req, { candidates: true }) — shared guard (parse-cv /
 *     extract-skills / sources routes) → 403 for flag-off users.
 *
 * Mirrors the guard-level style of tests/cron-auth.test.ts (assert on the
 * guard's response) and tests/access.test.ts (flag semantics).
 *
 * Run with `npx vitest run tests/candidates-access-guard.test.ts`.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';

import { PrismaClient } from '@prisma/client';

// The shared API guard imports '@/auth' (Auth.js), which pulls Next server
// internals that don't resolve under vitest's node env — stub it with a
// controllable session.
const authMock = vi.hoisted(() => vi.fn<() => Promise<unknown>>(async () => null));
vi.mock('@/auth', () => ({
  auth: authMock,
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

import { NextRequest } from 'next/server';

import { userMayAccessCandidates } from '../src/lib/candidate/access';
import { requireApiUser } from '../src/app/api/refdata/_shared';

const prisma = new PrismaClient();

/** Unique per-run email so this file never collides with sibling files. */
const runTag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
let seq = 0;
async function makeUser(opts: {
  role?: 'ADMIN' | 'CUSTOMER';
  candidatesEnabled: boolean;
}): Promise<string> {
  const u = await prisma.user.create({
    data: {
      email: `guard-${runTag}-${seq++}@test.local`,
      role: opts.role ?? 'CUSTOMER',
      candidatesEnabled: opts.candidatesEnabled,
    },
    select: { id: true },
  });
  return u.id;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('userMayAccessCandidates (DB-backed helper)', () => {
  it('CUSTOMER with candidatesEnabled=false may NOT (the fixed bypass)', async () => {
    const id = await makeUser({ candidatesEnabled: false });
    expect(await userMayAccessCandidates(id)).toBe(false);
  });

  it('CUSTOMER with candidatesEnabled=true may', async () => {
    const id = await makeUser({ candidatesEnabled: true });
    expect(await userMayAccessCandidates(id)).toBe(true);
  });

  it('ADMIN may even with the flag false', async () => {
    const id = await makeUser({ role: 'ADMIN', candidatesEnabled: false });
    expect(await userMayAccessCandidates(id)).toBe(true);
  });

  it('unknown / empty user id → false (fail-closed)', async () => {
    expect(await userMayAccessCandidates('no-such-user')).toBe(false);
    expect(await userMayAccessCandidates('')).toBe(false);
  });
});

describe('requireApiUser({ candidates: true }) — shared candidates API guard', () => {
  const req = (path: string) => new NextRequest(`http://localhost${path}`);

  it('flag-off user gets 403 on a candidates API guard', async () => {
    const id = await makeUser({ candidatesEnabled: false });
    authMock.mockImplementation(async () => ({ user: { id } }));

    const r = await requireApiUser(req('/api/candidates/sources?tenantId=whatever'), {
      candidates: true,
    });
    expect(r.kind).toBe('response');
    if (r.kind === 'response') expect(r.response.status).toBe(403);
  });

  it('flag-on user passes the candidates gate (fails later on tenant, not 403)', async () => {
    const id = await makeUser({ candidatesEnabled: true });
    authMock.mockImplementation(async () => ({ user: { id } }));

    // No tenantId param → 400 proves the 403 gate was cleared.
    const r = await requireApiUser(req('/api/candidates/sources'), { candidates: true });
    expect(r.kind).toBe('response');
    if (r.kind === 'response') expect(r.response.status).toBe(400);
  });

  it('without the candidates option the flag is NOT enforced (refdata unaffected)', async () => {
    const id = await makeUser({ candidatesEnabled: false });
    authMock.mockImplementation(async () => ({ user: { id } }));

    // Same flag-off user, plain requireApiUser (as /api/refdata/* calls it):
    // proceeds past the flag to the tenantId validation (400, not 403).
    const r = await requireApiUser(req('/api/refdata/skill'));
    expect(r.kind).toBe('response');
    if (r.kind === 'response') expect(r.response.status).toBe(400);
  });

  it('unauthenticated → 401 regardless of the option', async () => {
    authMock.mockImplementation(async () => null);
    const r = await requireApiUser(req('/api/candidates/sources?tenantId=x'), {
      candidates: true,
    });
    expect(r.kind).toBe('response');
    if (r.kind === 'response') expect(r.response.status).toBe(401);
  });
});
