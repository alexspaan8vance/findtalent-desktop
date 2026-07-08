/**
 * Owner-gate tests for the pipeline "confirm stage changes" toggle.
 *
 * `setConfirmStageMoves` flips an org-wide guard and is OWNER-only — a MEMBER
 * must not be able to change it. We mock `requireUser` and use the real DB.
 *
 * Run with `npx vitest run tests/pipeline-confirm-moves.test.ts`.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const actingUser = { id: '', email: '', name: null as string | null, role: 'CUSTOMER' as const };

vi.mock('../src/lib/auth-helpers', () => ({
  requireUser: vi.fn(async () => actingUser),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { setConfirmStageMoves } from '../src/app/app/settings/pipeline/actions';

/** Create a user as OWNER (default) or MEMBER of a fresh org; act as them. */
async function seatUser(role: 'OWNER' | 'MEMBER'): Promise<string> {
  const u = await prisma.user.create({
    data: {
      email: `u-${Math.random().toString(36).slice(2, 10)}@test.local`,
      passwordHash: 'x',
    },
    select: { id: true, email: true },
  });
  const org = await prisma.organization.create({
    data: { name: 'Acme', members: { create: { userId: u.id, role } } },
    select: { id: true },
  });
  await prisma.user.update({ where: { id: u.id }, data: { organizationId: org.id } });
  actingUser.id = u.id;
  actingUser.email = u.email;
  return org.id;
}

function fd(enabled: boolean): FormData {
  const f = new FormData();
  if (enabled) f.set('enabled', 'on');
  return f;
}

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.organizationMember.deleteMany();
  await prisma.user.updateMany({ data: { organizationId: null } });
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
});

describe('setConfirmStageMoves', () => {
  it('defaults to enabled for a fresh org', async () => {
    const orgId = await seatUser('OWNER');
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { confirmStageMoves: true },
    });
    expect(org?.confirmStageMoves).toBe(true);
  });

  it('owner can turn it off and back on', async () => {
    const orgId = await seatUser('OWNER');

    const off = await setConfirmStageMoves(fd(false));
    expect(off.ok).toBe(true);
    expect(
      (await prisma.organization.findUnique({ where: { id: orgId }, select: { confirmStageMoves: true } }))
        ?.confirmStageMoves,
    ).toBe(false);

    const on = await setConfirmStageMoves(fd(true));
    expect(on.ok).toBe(true);
    expect(
      (await prisma.organization.findUnique({ where: { id: orgId }, select: { confirmStageMoves: true } }))
        ?.confirmStageMoves,
    ).toBe(true);
  });

  it('a non-owner member cannot change it', async () => {
    const orgId = await seatUser('MEMBER');
    const res = await setConfirmStageMoves(fd(false));
    expect(res).toEqual({ ok: false, reason: 'not_owner' });
    // Unchanged (still the default on).
    expect(
      (await prisma.organization.findUnique({ where: { id: orgId }, select: { confirmStageMoves: true } }))
        ?.confirmStageMoves,
    ).toBe(true);
  });
});
