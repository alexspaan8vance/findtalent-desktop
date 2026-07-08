/**
 * Password-reset + email-change token helper tests.
 *
 * Run with `npx vitest run tests/auth-tokens.test.ts`.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

// auth-helpers transitively imports '@/auth' (Auth.js), which pulls Next.js
// server internals that don't resolve under vitest's node environment. The
// token helpers under test don't touch auth at runtime, so we stub the module.
vi.mock('@/auth', () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

import {
  createPasswordResetToken,
  consumePasswordResetToken,
  createEmailChangeToken,
  consumeEmailChangeToken,
  createSignupToken,
} from '../src/lib/auth-helpers';

const prisma = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.verificationToken.deleteMany();
});

describe('password reset tokens', () => {
  it('round-trips a reset token and consumes it once', async () => {
    const email = 'reset@test.local';
    const token = await createPasswordResetToken(email);

    const first = await consumePasswordResetToken(token);
    expect(first).toEqual({ ok: true, email });

    // Single-use: the row is deleted after consume.
    const second = await consumePasswordResetToken(token);
    expect(second).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects an expired reset token', async () => {
    const token = 'expired-reset-token';
    await prisma.verificationToken.create({
      data: {
        identifier: 'reset:old@test.local',
        token,
        expires: new Date(Date.now() - 1000),
      },
    });
    const res = await consumePasswordResetToken(token);
    expect(res).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a signup token presented to the reset consumer (namespacing)', async () => {
    const signup = await createSignupToken('victim@test.local');
    const res = await consumePasswordResetToken(signup);
    expect(res).toEqual({ ok: false, reason: 'not_found' });
    // Signup token must remain usable by its own consumer (not deleted).
    const row = await prisma.verificationToken.findUnique({ where: { token: signup } });
    expect(row).not.toBeNull();
  });
});

describe('email change tokens', () => {
  it('round-trips userId + newEmail', async () => {
    const token = await createEmailChangeToken('user_123', 'new@test.local');
    const res = await consumeEmailChangeToken(token);
    expect(res).toEqual({ ok: true, userId: 'user_123', newEmail: 'new@test.local' });
  });

  it('rejects a reset token presented to the email-change consumer', async () => {
    const reset = await createPasswordResetToken('a@test.local');
    const res = await consumeEmailChangeToken(reset);
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects an expired email-change token', async () => {
    const token = 'expired-email-token';
    await prisma.verificationToken.create({
      data: {
        identifier: 'emailchange:u1:x@test.local',
        token,
        expires: new Date(Date.now() - 1000),
      },
    });
    const res = await consumeEmailChangeToken(token);
    expect(res).toEqual({ ok: false, reason: 'expired' });
  });
});
