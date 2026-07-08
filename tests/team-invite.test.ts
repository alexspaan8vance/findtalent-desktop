/**
 * Team-invite email wiring tests.
 *
 * `inviteMemberAction` (and `resendInviteAction`) send the org's `team_invite`
 * email best-effort: the membership is created either way, and an email failure
 * must NOT fail the invite. We mock `requireUser` (the acting owner) and
 * `sendEmail`, and use the real DB.
 *
 * Run with `npx vitest run tests/team-invite.test.ts`.
 */

import { describe, it, expect, afterAll, beforeEach, vi, type Mock } from 'vitest';

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Acting user (the owner) — mutated per test before calling the action.
const actingUser = { id: '', email: '', name: null as string | null, role: 'CUSTOMER' as const };

vi.mock('../src/lib/auth-helpers', () => ({
  requireUser: vi.fn(async () => actingUser),
}));

// revalidatePath() requires a Next request/render scope; no-op it in unit tests.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// Mock the low-level email sender; default: "sent".
vi.mock('../src/lib/email', () => ({
  sendEmail: vi.fn(async () => true),
  isEmailConfigured: () => true,
}));

import { inviteMemberAction, resendInviteAction } from '../src/app/app/settings/team/actions';
import { sendEmail } from '../src/lib/email';

const mockSend = sendEmail as unknown as Mock;

async function createOwner(name: string | null = 'Alex Owner'): Promise<string> {
  const u = await prisma.user.create({
    data: {
      email: `owner-${Math.random().toString(36).slice(2, 10)}@test.local`,
      name,
      passwordHash: 'x',
    },
    select: { id: true, email: true },
  });
  // Make them an OWNER of a fresh org.
  const org = await prisma.organization.create({
    data: { name: 'Acme', members: { create: { userId: u.id, role: 'OWNER' } } },
    select: { id: true },
  });
  await prisma.user.update({ where: { id: u.id }, data: { organizationId: org.id } });
  actingUser.id = u.id;
  actingUser.email = u.email;
  actingUser.name = name;
  return u.id;
}

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  mockSend.mockReset();
  mockSend.mockResolvedValue(true);
  await prisma.organizationMember.deleteMany();
  await prisma.emailTemplate.deleteMany();
  await prisma.user.updateMany({ data: { organizationId: null } });
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
});

describe('inviteMemberAction email send', () => {
  it('creates a pending member AND sends the team_invite email', async () => {
    await createOwner();
    const invited = 'newhire@test.local';

    const fd = new FormData();
    fd.set('email', invited);
    const res = await inviteMemberAction(fd);

    expect(res).toMatchObject({ ok: true, kind: 'pending', emailSent: true });
    // A copy-paste invite link is surfaced (email only, no secret).
    expect(res.ok && res.link).toContain('/signup?email=');
    expect(res.ok && res.link).toContain(encodeURIComponent(invited));

    // The membership exists (pending user, no passwordHash).
    const u = await prisma.user.findUnique({
      where: { email: invited },
      select: { passwordHash: true },
    });
    expect(u).not.toBeNull();
    expect(u!.passwordHash).toBeNull();

    // The email was sent with the rendered template (subject + branded html).
    expect(mockSend).toHaveBeenCalledTimes(1);
    const arg = mockSend.mock.calls[0]![0] as { to: string; subject: string; html: string };
    expect(arg.to).toBe(invited);
    expect(arg.subject).toContain('Acme'); // {{orgName}} substituted
    expect(arg.html).toContain('/signup?email=');
    expect(arg.html).toContain(encodeURIComponent(invited));
  });

  it('attaches an existing org-less user AND sends the email', async () => {
    await createOwner();
    const existing = await prisma.user.create({
      data: { email: 'existing@test.local', passwordHash: 'y' },
      select: { id: true },
    });

    const fd = new FormData();
    fd.set('email', 'existing@test.local');
    const res = await inviteMemberAction(fd);

    expect(res).toMatchObject({ ok: true, kind: 'attached', emailSent: true });
    expect(mockSend).toHaveBeenCalledTimes(1);

    const membership = await prisma.organizationMember.findFirst({
      where: { userId: existing.id },
    });
    expect(membership).not.toBeNull();
  });

  it('still returns ok (membership created) when the email send FAILS', async () => {
    await createOwner();
    mockSend.mockRejectedValue(new Error('resend down'));
    const invited = 'fails@test.local';

    const fd = new FormData();
    fd.set('email', invited);
    const res = await inviteMemberAction(fd);

    expect(res).toMatchObject({ ok: true, kind: 'pending', emailSent: false });

    // Membership still created despite the email failure.
    const u = await prisma.user.findUnique({ where: { email: invited }, select: { id: true } });
    expect(u).not.toBeNull();
  });

  it('reports emailSent: false when sendEmail returns false (email not configured)', async () => {
    await createOwner();
    mockSend.mockResolvedValue(false);

    const fd = new FormData();
    fd.set('email', 'unconfigured@test.local');
    const res = await inviteMemberAction(fd);

    expect(res).toMatchObject({ ok: true, kind: 'pending', emailSent: false });
  });
});

describe('resendInviteAction', () => {
  it('re-sends the team_invite email to an existing member, owner-gated', async () => {
    await createOwner();
    // Seed a pending member via the invite action first.
    const invited = 'resend-me@test.local';
    const fd = new FormData();
    fd.set('email', invited);
    await inviteMemberAction(fd);
    mockSend.mockClear();

    const target = await prisma.user.findUniqueOrThrow({
      where: { email: invited },
      select: { id: true },
    });

    const rfd = new FormData();
    rfd.set('userId', target.id);
    const res = await resendInviteAction(rfd);

    expect(res).toMatchObject({ ok: true, kind: 'resent', emailSent: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const arg = mockSend.mock.calls[0]![0] as { to: string };
    expect(arg.to).toBe(invited);
  });

  it('refuses to resend for a user who is not a member of the owner org', async () => {
    await createOwner();
    const stranger = await prisma.user.create({
      data: { email: 'stranger@test.local' },
      select: { id: true },
    });

    const rfd = new FormData();
    rfd.set('userId', stranger.id);
    const res = await resendInviteAction(rfd);

    expect(res).toEqual({ ok: false, reason: 'not_found' });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
