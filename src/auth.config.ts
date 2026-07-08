import type { NextAuthConfig } from 'next-auth';

/**
 * Edge-safe auth config used by `middleware.ts` for session reads.
 * Must not import Node-only modules (no Prisma, no bcrypt, no `node:*`).
 *
 * Strategy is JWT because Credentials provider in Auth.js v5 requires it,
 * and JWT decoding works in Edge runtime without a DB adapter.
 */
export const authConfig: NextAuthConfig = {
  session: {
    strategy: 'jwt',
    // Cap token lifetime at 8h (~one working session) so a stolen/leaked JWT
    // ages out instead of living for the NextAuth default of 30 days. An active
    // user's cookie is refreshed on use; an idle/stolen token expires. This is
    // defense in depth only — authorization changes (role demotion, candidate-
    // access revocation) are ALSO enforced server-side on each request against
    // the DB (see requireAdmin's role recheck + userMayAccessCandidates), which
    // is the authoritative gate; do not rely on maxAge alone for revocation.
    maxAge: 60 * 60 * 8, // 8 hours (seconds)
  },
  trustHost:
    Boolean(process.env.NEXTAUTH_URL) || process.env.NODE_ENV !== 'production',
  pages: {
    signIn: '/login',
    verifyRequest: '/verify-email',
    error: '/login',
  },
  providers: [],
  callbacks: {
    authorized({ auth: session }) {
      return Boolean(session?.user);
    },
    jwt({ token, user }) {
      if (user) {
        const u = user as unknown as {
          id?: string;
          role?: 'ADMIN' | 'CUSTOMER';
          email?: string | null;
          name?: string | null;
          candidatesEnabled?: boolean;
        };
        if (u.id) token.sub = u.id;
        if (u.role) token.role = u.role;
        if (u.email !== undefined) token.email = u.email;
        if (u.name !== undefined) token.name = u.name;
        if (u.candidatesEnabled !== undefined) {
          (token as { candidatesEnabled?: boolean }).candidatesEnabled =
            u.candidatesEnabled;
        }
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && token) {
        const t = token as unknown as {
          sub?: string;
          role?: 'ADMIN' | 'CUSTOMER';
          email?: string | null;
          name?: string | null;
          candidatesEnabled?: boolean;
        };
        if (t.sub) session.user.id = t.sub;
        if (t.role) session.user.role = t.role;
        if (t.email !== undefined && t.email !== null) session.user.email = t.email;
        if (t.name !== undefined) session.user.name = t.name ?? null;
        if (t.candidatesEnabled !== undefined) {
          session.user.candidatesEnabled = t.candidatesEnabled;
        }
      }
      return session;
    },
  },
};
