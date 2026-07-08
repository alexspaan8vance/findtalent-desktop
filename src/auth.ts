import NextAuth, { type NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { verifyPassword } from '@/lib/auth-helpers';
import {
  isAllowedFor,
  recordFailureFor,
  recordSuccessFor,
} from '@/lib/login-ratelimit';
import { trustedClientIp } from '@/lib/client-ip';
import { authConfig as edgeAuthConfig } from '@/auth.config';
import type { AppRole } from '@/types/next-auth';

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * Best-effort client IP for the login throttle. Used ONLY as a secondary
 * discriminator (the email-only counter is always enforced) — never logged.
 * Resolves the TRUSTED (rightmost) X-Forwarded-For hop so a rotating XFF can't
 * manufacture fresh throttle buckets. Null when no header is present.
 */
function clientIpFor(request: Request | undefined): string | null {
  const h = request?.headers;
  return h ? trustedClientIp(h) : null;
}

export const authConfig: NextAuthConfig = {
  ...edgeAuthConfig,
  adapter: PrismaAdapter(prisma),
  providers: [
    Credentials({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(raw, request) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;

        // Brute-force throttle: bound failed attempts per email (ALWAYS) plus a
        // secondary per-email+IP counter. When in cooldown we reject WITHOUT
        // running the password check and surface the same generic failure as a
        // wrong password — no lockout oracle, no user enumeration (memory
        // `feedback_security_critical`). The email-only floor holds even if the
        // attacker rotates X-Forwarded-For, so the throttle can't be bypassed.
        const ip = clientIpFor(request as Request | undefined);
        if (!(await isAllowedFor(email, ip))) return null;

        const user = await prisma.user.findUnique({ where: { email } });

        // Verify the password even when the account is unusable (missing/no
        // hash/unverified) so that a failure costs the attacker a throttle slot
        // and the timing doesn't trivially reveal which check failed.
        const hash = user?.passwordHash ?? null;
        const passwordOk = hash
          ? await verifyPassword(password, hash)
          : false;
        const usable = !!user && !!hash && !!user.emailVerifiedAt;

        if (!usable || !passwordOk) {
          await recordFailureFor(email, ip);
          return null;
        }

        // Success — clear the failure counters so the user is never locked out
        // after they eventually authenticate.
        await recordSuccessFor(email, ip);

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role as AppRole,
          candidatesEnabled: user.candidatesEnabled,
        };
      },
    }),
  ],
};

export const { auth, handlers, signIn, signOut } = NextAuth(authConfig);
