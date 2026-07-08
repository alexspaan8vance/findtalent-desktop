'use server';

import { z } from 'zod';

import { prisma } from '@/lib/db';
import { createPasswordResetToken } from '@/lib/auth-helpers';
import { sendEmail } from '@/lib/email';

const forgotSchema = z.object({
  email: z.string().email(),
});

export type ForgotState = {
  // `done` is set once the request has been processed, regardless of whether
  // the email actually exists — the UI always shows the same neutral message
  // so an attacker can't probe which addresses have accounts.
  done: boolean;
};

export async function forgotPasswordAction(
  _prev: ForgotState,
  formData: FormData,
): Promise<ForgotState> {
  const raw = { email: String(formData.get('email') ?? '').trim().toLowerCase() };
  const parsed = forgotSchema.safeParse(raw);
  // Even on a malformed email we report success — no enumeration, no hints.
  if (!parsed.success) {
    return { done: true };
  }

  const { email } = parsed.data;
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true },
  });

  // Only mint + send a link when there's a real, password-based account. We do
  // this silently — the response is identical whether or not the account
  // exists.
  if (user && user.passwordHash) {
    const token = await createPasswordResetToken(email);
    const base = process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
    const url = `${base}/reset-password?token=${encodeURIComponent(token)}`;

    await sendEmail({
      to: email,
      subject: 'Reset your findtalent password',
      html: `
        <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
          <h2>Reset your password</h2>
          <p>We received a request to reset your findtalent password. Click the link below to choose a new one. It expires in 1 hour.</p>
          <p><a href="${url}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Reset password</a></p>
          <p style="color:#666;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    });
    // Note: when email isn't configured sendEmail no-ops and returns false. We
    // intentionally don't surface that to the user (same neutral response).
  }

  return { done: true };
}
