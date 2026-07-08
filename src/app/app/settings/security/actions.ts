'use server';

import { z } from 'zod';

import { prisma } from '@/lib/db';
import {
  requireUser,
  verifyPassword,
  hashPassword,
  createEmailChangeToken,
} from '@/lib/auth-helpers';
import { sendEmail } from '@/lib/email';

const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .refine((v) => /[0-9]|[^A-Za-z0-9]/.test(v), {
    message: 'Password must contain at least one number or symbol',
  });

// ---------------------------------------------------------------------------
// Password change (logged in): verify current password, set a new hash.
// ---------------------------------------------------------------------------

const changePasswordSchema = z
  .object({
    current: z.string().min(1),
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((d) => d.password === d.confirm, {
    path: ['confirm'],
    message: 'Passwords do not match',
  });

export type PasswordState = {
  ok: boolean;
  error?: string;
  fieldErrors?: { current?: string; password?: string; confirm?: string };
};

export async function changePasswordAction(
  _prev: PasswordState,
  formData: FormData,
): Promise<PasswordState> {
  const user = await requireUser();

  const raw = {
    current: String(formData.get('current') ?? ''),
    password: String(formData.get('password') ?? ''),
    confirm: String(formData.get('confirm') ?? ''),
  };
  const parsed = changePasswordSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: PasswordState['fieldErrors'] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (key === 'current') fieldErrors.current = issue.message;
      if (key === 'password') fieldErrors.password = issue.message;
      if (key === 'confirm') fieldErrors.confirm = issue.message;
    }
    return { ok: false, fieldErrors };
  }

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true },
  });
  if (!row?.passwordHash) {
    return { ok: false, error: 'no_password' };
  }

  const valid = await verifyPassword(parsed.data.current, row.passwordHash);
  if (!valid) {
    return { ok: false, fieldErrors: { current: 'wrong' } };
  }

  const passwordHash = await hashPassword(parsed.data.password);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Email change (logged in): re-auth with current password, email a confirm
// link to the NEW address. Uniqueness is checked both here and at confirm time.
// ---------------------------------------------------------------------------

const changeEmailSchema = z.object({
  current: z.string().min(1),
  newEmail: z.string().email(),
});

export type EmailState = {
  ok: boolean;
  error?: string;
  fieldErrors?: { current?: string; newEmail?: string };
};

export async function changeEmailAction(
  _prev: EmailState,
  formData: FormData,
): Promise<EmailState> {
  const user = await requireUser();

  const raw = {
    current: String(formData.get('current') ?? ''),
    newEmail: String(formData.get('newEmail') ?? '').trim().toLowerCase(),
  };
  const parsed = changeEmailSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: EmailState['fieldErrors'] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (key === 'current') fieldErrors.current = issue.message;
      if (key === 'newEmail') fieldErrors.newEmail = issue.message;
    }
    return { ok: false, fieldErrors };
  }

  const { current, newEmail } = parsed.data;

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true, email: true },
  });
  if (!row?.passwordHash) {
    return { ok: false, error: 'no_password' };
  }

  const valid = await verifyPassword(current, row.passwordHash);
  if (!valid) {
    return { ok: false, fieldErrors: { current: 'wrong' } };
  }

  if (newEmail === row.email) {
    return { ok: false, fieldErrors: { newEmail: 'same' } };
  }

  const taken = await prisma.user.findUnique({ where: { email: newEmail } });
  if (taken) {
    return { ok: false, fieldErrors: { newEmail: 'taken' } };
  }

  const token = await createEmailChangeToken(user.id, newEmail);
  const base = process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
  const url = `${base}/app/settings/security/confirm-email?token=${encodeURIComponent(token)}`;

  await sendEmail({
    to: newEmail,
    subject: 'Confirm your new findtalent email address',
    html: `
      <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Confirm your new email</h2>
        <p>Click the link below to confirm this address as the new email for your findtalent account. It expires in 1 hour.</p>
        <p><a href="${url}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Confirm email</a></p>
        <p style="color:#666;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });

  return { ok: true };
}
