'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { hashPassword, consumePasswordResetToken } from '@/lib/auth-helpers';

const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .refine((v) => /[0-9]|[^A-Za-z0-9]/.test(v), {
    message: 'Password must contain at least one number or symbol',
  });

const resetSchema = z
  .object({
    token: z.string().min(1),
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((d) => d.password === d.confirm, {
    path: ['confirm'],
    message: 'Passwords do not match',
  });

export type ResetState = {
  ok: boolean;
  error?: string;
  fieldErrors?: { password?: string; confirm?: string };
};

export async function resetPasswordAction(
  _prev: ResetState,
  formData: FormData,
): Promise<ResetState> {
  const raw = {
    token: String(formData.get('token') ?? ''),
    password: String(formData.get('password') ?? ''),
    confirm: String(formData.get('confirm') ?? ''),
  };
  const parsed = resetSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: ResetState['fieldErrors'] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (key === 'password') fieldErrors.password = issue.message;
      if (key === 'confirm') fieldErrors.confirm = issue.message;
    }
    return { ok: false, fieldErrors };
  }

  // Consume the token (deletes it) only after the password passes validation,
  // so a user can correct a weak/mismatched password without burning the link.
  const result = await consumePasswordResetToken(parsed.data.token);
  if (!result.ok) {
    return { ok: false, error: 'invalid_token' };
  }

  const passwordHash = await hashPassword(parsed.data.password);
  // The account may have been deleted between request and reset — updateMany is
  // a no-op rather than a throw in that case.
  await prisma.user.updateMany({
    where: { email: result.email },
    data: { passwordHash },
  });

  redirect('/login?reset=1');
}
