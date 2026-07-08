'use server';

import { z } from 'zod';
import { AuthError } from 'next-auth';
import { signIn } from '@/auth';

const loginSchema = z.object({
  email: z.string().email('Ongeldig e-mailadres'),
  password: z.string().min(1, 'Wachtwoord is verplicht'),
  from: z.string().optional(),
});

export type LoginState = {
  ok: boolean;
  error?: string;
};

const DEFAULT_REDIRECT = '/app/projects';

/**
 * A safe post-login redirect target is a same-site relative path only:
 * it starts with a single '/', not '//' (protocol-relative) and not '/\'
 * (backslash trick browsers may normalise to '//'), and carries no scheme
 * or host. Anything else falls back to the default app path to prevent
 * open redirects.
 */
function safeRedirectPath(value: string | undefined): string {
  if (!value) return DEFAULT_REDIRECT;
  if (value[0] !== '/') return DEFAULT_REDIRECT;
  if (value[1] === '/' || value[1] === '\\') return DEFAULT_REDIRECT;
  // Reject backslashes (browsers may normalise '\' -> '/', re-enabling the
  // protocol-relative trick) and any whitespace/control chars that could
  // smuggle a scheme or host past us.
  if (/[\\\s]/.test(value)) return DEFAULT_REDIRECT;
  return value;
}

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const raw = {
    email: String(formData.get('email') ?? '').trim().toLowerCase(),
    password: String(formData.get('password') ?? ''),
    from: String(formData.get('from') ?? '') || undefined,
  };
  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'Ongeldig e-mailadres of wachtwoord' };
  }

  try {
    await signIn('credentials', {
      email: parsed.data.email,
      password: parsed.data.password,
      redirectTo: safeRedirectPath(parsed.data.from),
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthError) {
      return { ok: false, error: 'Ongeldige inloggegevens of e-mailadres nog niet geverifieerd.' };
    }
    throw err;
  }
}
