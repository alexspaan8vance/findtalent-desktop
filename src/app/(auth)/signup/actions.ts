'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { hashPassword, createSignupToken } from '@/lib/auth-helpers';
import { getOrCreateUserOrg } from '@/lib/org';
import { sendEmail, isEmailConfigured } from '@/lib/email';
import { getSignupPolicy, isEmailAllowedBySignupPolicy } from '@/lib/signup-policy';

const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .refine((v) => /[0-9]|[^A-Za-z0-9]/.test(v), {
    message: 'Password must contain at least one number or symbol',
  });

// Not exported: a 'use server' module may only export async functions.
const signupSchema = z.object({
  email: z.string().email('Invalid email'),
  password: passwordSchema,
  // GDPR Art.7: affirmative consent is required. The checkbox posts 'on' when
  // ticked and is absent otherwise; we coerce to a literal so an unchecked box
  // is a validation error rather than a silent skip.
  consent: z.literal('on', {
    message: 'You must accept the Terms & Privacy Policy to continue',
  }),
});

export type SignupState = {
  ok: boolean;
  error?: string;
  fieldErrors?: { email?: string; password?: string; consent?: string };
};

// Users are no longer bound to a tenant — they pick pool(s) per project.

export async function signupAction(
  _prev: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const raw = {
    email: String(formData.get('email') ?? '').trim().toLowerCase(),
    password: String(formData.get('password') ?? ''),
    consent: String(formData.get('consent') ?? ''),
  };
  const parsed = signupSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: SignupState['fieldErrors'] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (key === 'email') fieldErrors.email = issue.message;
      if (key === 'password') fieldErrors.password = issue.message;
      if (key === 'consent') fieldErrors.consent = issue.message;
    }
    return { ok: false, fieldErrors };
  }

  const { email, password } = parsed.data;

  // Signup gating (fail-closed): internal tool behind a public Funnel URL.
  // SIGNUP_ALLOWED_DOMAINS drives who may self-register — see
  // src/lib/signup-policy.ts. Server-side and BEFORE any DB write, so a
  // hand-crafted POST can't bypass the page-level notice.
  const policy = getSignupPolicy();
  if (policy.mode === 'closed') {
    return {
      ok: false,
      error: 'Registratie is uitgeschakeld — vraag een beheerder om een account.',
    };
  }
  if (!isEmailAllowedBySignupPolicy(email, policy)) {
    const list =
      policy.mode === 'domains' ? policy.domains.map((d) => `@${d}`).join(', ') : '';
    return {
      ok: false,
      fieldErrors: {
        email: `Registratie is alleen mogelijk met ${list} e-mailadressen.`,
      },
    };
  }

  // Production requires working verification email BEFORE we create anything:
  // without it we'd either strand the user on an unsendable link or (worse)
  // auto-verify an unvetted account. Fail fast with a config error instead.
  if (process.env.NODE_ENV === 'production' && !isEmailConfigured()) {
    return {
      ok: false,
      error:
        'Registratie is tijdelijk niet beschikbaar: e-mailverificatie is niet ' +
        'geconfigureerd op deze server. Vraag een beheerder om een account.',
    };
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.emailVerifiedAt) {
      return { ok: false, error: 'Account exists — please log in instead.' };
    }
  }

  const passwordHash = await hashPassword(password);

  const consentGivenAt = new Date();

  let userId: string;
  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash, consentGivenAt },
    });
    userId = existing.id;
  } else {
    const created = await prisma.user.create({
      data: {
        email,
        passwordHash,
        role: 'CUSTOMER',
        consentGivenAt,
      },
      select: { id: true },
    });
    userId = created.id;
  }

  // Ensure every account has a team org. A pre-invited user already carries an
  // organizationId (set by the inviter) — getOrCreateUserOrg keeps it; everyone
  // else gets a personal org. Idempotent, so re-signups are safe.
  await getOrCreateUserOrg(userId);

  const token = await createSignupToken(email);
  const base = process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
  const url = `${base}/verify-email?token=${encodeURIComponent(token)}&from=signup`;

  const sent = await sendEmail({
    to: email,
    subject: 'Verify your findtalent account',
    html: `
      <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Welcome to findtalent</h2>
        <p>Please verify your email by clicking the link below. It expires in 24 hours.</p>
        <p><a href="${url}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Verify email</a></p>
      </div>
    `,
  });

  if (sent) {
    redirect('/verify-email-sent');
  }
  // Email didn't go out. In production this is a hard failure — NEVER
  // auto-verify there (that would mint a fully-usable account with zero email
  // ownership proof). The pre-flight isEmailConfigured() gate above makes this
  // branch near-unreachable in prod; if we still land here, surface a config
  // error. The row stays unverified (login requires emailVerifiedAt, and a
  // re-signup on an unverified row updates it in place), so nothing
  // half-usable is left behind.
  if (process.env.NODE_ENV === 'production') {
    return {
      ok: false,
      error:
        'Registratie is tijdelijk niet beschikbaar: verificatie-e-mail kon niet ' +
        'worden verzonden. Vraag een beheerder om een account.',
    };
  }
  // Non-production without email configured — auto-verify so local dev/test
  // accounts are usable immediately instead of stranding on an unsendable link.
  await prisma.user.update({
    where: { email },
    data: { emailVerifiedAt: new Date() },
  });
  await prisma.verificationToken.deleteMany({ where: { identifier: email } });
  redirect('/login?verified=1');
}
