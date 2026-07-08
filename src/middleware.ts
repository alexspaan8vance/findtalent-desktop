import NextAuth from 'next-auth';
import { NextResponse, type NextResponse as NextResponseType } from 'next/server';

import { authConfig } from '@/auth.config';
import { canAccessCandidates } from '@/lib/access';

const { auth } = NextAuth(authConfig);

// Auth is required only under these prefixes. Everything else is public —
// including unknown paths, which then fall through to Next's 404 page
// instead of being bounced to /login. '/api/candidates' is listed so the
// candidatesEnabled gate below actually fires for API calls (defense in
// depth — every /api/candidates route ALSO re-checks the flag against the
// DB itself; other /api routes keep their own route-level auth and are
// deliberately not listed here).
const PROTECTED_PREFIXES: readonly string[] = [
  '/app',
  '/admin',
  '/billing',
  '/api/candidates',
];

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/**
 * The `from` param we attach to /login must be a safe same-site relative
 * path: a single leading '/', not '//' (protocol-relative) or '/\', and no
 * whitespace/backslash that could be normalised into a scheme or host. The
 * login action re-validates this, but we keep the forwarded value clean too.
 */
function safeFrom(pathname: string): string | null {
  if (pathname[0] !== '/') return null;
  if (pathname[1] === '/' || pathname[1] === '\\') return null;
  if (/[\\\s]/.test(pathname)) return null;
  return pathname;
}

/**
 * Build a per-request CSP.
 *
 * Script policy is nonce-based: each request gets a fresh random nonce which
 * we (a) embed in the `script-src` directive and (b) set on the *request*
 * header `x-nonce`. Next.js parses the CSP header off the request and
 * automatically stamps the same nonce onto all framework + page-bundle script
 * tags (see node_modules/next/dist/docs/.../content-security-policy.md), so we
 * can drop BOTH `'unsafe-inline'` and `'unsafe-eval'` for scripts in
 * production — closing the main XSS hole that the old static CSP left open.
 *
 *  - `'strict-dynamic'`: trust scripts loaded by an already-trusted (nonced)
 *    script, so Next's runtime can pull in chunk bundles without each needing
 *    its own nonce. Modern browsers ignore host allow-lists when this is set,
 *    so we keep https://js.stripe.com only as a fallback for older engines.
 *  - dev: React injects `eval`-based dev tooling, so `'unsafe-eval'` is
 *    required locally (and only locally) — see the Next docs note.
 *  - styles: still `'unsafe-inline'`. Next/Tailwind emit inline <style> tags
 *    without a nonce hook here; nonce-ing styles would require app-layer
 *    changes outside this file's ownership. Documented as a known gap.
 */
function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV !== 'production';
  const scriptSrc = isDev
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval' https://js.stripe.com`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com`;
  return [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'", // see note above (known gap)
    scriptSrc,
    'frame-src https://js.stripe.com https://hooks.stripe.com',
    "connect-src 'self' https://api.stripe.com",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ') + ';';
}

function applySecurityHeaders(res: NextResponseType, nonce: string): NextResponseType {
  res.headers.set('Content-Security-Policy', buildCsp(nonce));
  if (process.env.NODE_ENV === 'production') {
    res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  return res;
}

/**
 * Build a NextResponse.next() that (1) forwards a fresh nonce to Next's
 * renderer via the request `x-nonce` header and embeds it in the request CSP
 * (so Next adopts it), and (2) carries the response security headers.
 */
function passThrough(req: { headers: Headers }, nonce: string): NextResponseType {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', buildCsp(nonce));
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  return applySecurityHeaders(res, nonce);
}

function genNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString('base64');
}

export default auth((req) => {
  const { nextUrl } = req;
  const pathname = nextUrl.pathname;
  const nonce = genNonce();

  // Public + unknown routes pass through (unknown → Next 404).
  if (!isProtected(pathname)) {
    return passThrough(req, nonce);
  }

  const session = req.auth;
  const user = session?.user;

  if (!user) {
    // API calls get a JSON 401 (matching the route handlers' own contract) —
    // redirecting a fetch() to the login HTML page would just confuse clients.
    if (pathname.startsWith('/api/')) {
      return applySecurityHeaders(
        NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
        nonce,
      );
    }
    const url = nextUrl.clone();
    url.pathname = '/login';
    const from = safeFrom(pathname);
    if (from) url.searchParams.set('from', from);
    return applySecurityHeaders(NextResponse.redirect(url), nonce);
  }

  // Fast JWT-claim gate for redirect UX only. This is NOT authoritative: the
  // token role is fixed at sign-in and can be stale (a demoted admin still
  // carries role=ADMIN until the token expires). Every admin server action /
  // route re-checks the role against the DB via requireAdmin — that fresh read
  // is the authoritative gate. Keep this branch for a snappy redirect.
  if (pathname.startsWith('/admin') && user.role !== 'ADMIN') {
    const url = nextUrl.clone();
    url.pathname = '/login';
    const from = safeFrom(pathname);
    if (from) url.searchParams.set('from', from);
    return applySecurityHeaders(NextResponse.redirect(url), nonce);
  }

  // Candidates surface is gated: only ADMIN or accounts explicitly granted
  // `candidatesEnabled` may browse/contact talent (prevents a random account
  // bypassing the reveal-credit economics). Legacy tokens (undefined) are
  // allowed — only an explicit `false` blocks — so existing sessions aren't
  // kicked out before their next login refreshes the flag. NB: this JWT-claim
  // check is defense in depth; the /api/candidates routes each re-check the
  // flag against the DB (userMayAccessCandidates / requireApiUser
  // {candidates:true}), which is the authoritative gate.
  const isCandidateArea =
    pathname === '/app/candidates' ||
    pathname.startsWith('/app/candidates/') ||
    pathname === '/api/candidates' ||
    pathname.startsWith('/api/candidates/');
  const candidatesEnabled = (user as { candidatesEnabled?: boolean }).candidatesEnabled;
  if (isCandidateArea && !canAccessCandidates({ role: user.role, candidatesEnabled })) {
    if (pathname.startsWith('/api/')) {
      return applySecurityHeaders(
        NextResponse.json({ error: 'forbidden' }, { status: 403 }),
        nonce,
      );
    }
    const url = nextUrl.clone();
    url.pathname = '/app/projects';
    url.search = '';
    return applySecurityHeaders(NextResponse.redirect(url), nonce);
  }

  return passThrough(req, nonce);
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
