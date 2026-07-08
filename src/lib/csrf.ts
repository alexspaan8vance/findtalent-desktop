/**
 * Cheap CSRF defense for state-changing, cookie-authenticated `/api` routes.
 *
 * The session cookie is `SameSite=Lax`, which still permits top-level cross-site
 * POST/form navigations — so Lax alone is NOT sufficient CSRF protection for
 * state-changing endpoints. We layer an Origin/Referer allowlist on top.
 *
 * POLICY (deliberately lenient so legitimate same-origin + server-to-server
 * callers are never broken):
 *   - No Origin AND no Referer   → ALLOW. A browser cross-site fetch/form POST
 *     always carries an `Origin`; its absence is not the attack we bound. Non-
 *     browser callers (cron with a secret bearer, the Stripe webhook with a
 *     signature) send neither and carry their own strong auth — and are exempt
 *     from this check anyway (we simply don't invoke it there).
 *   - Origin present             → must equal the serving origin OR a configured
 *     app origin (APP_ORIGIN, falling back to NEXTAUTH_URL). Else REJECT (403).
 *     `Origin: null` (sandboxed iframe / privacy shims) is treated as cross-site
 *     and rejected.
 *   - Origin absent, Referer set  → the Referer's origin must match. Else REJECT.
 *
 * Behind the Funnel the browser's Origin is the PUBLIC origin while `req.url`
 * may carry the internal host, so the configured app origin (APP_ORIGIN /
 * NEXTAUTH_URL) is the authoritative allowlist entry — set it to the public URL.
 *
 * Returns `null` when the request is allowed, or a 403 `NextResponse` when it
 * must be rejected. Never throws.
 */

import { NextResponse } from 'next/server';

/** Origins we accept for a state-changing request: the serving origin + env. */
function allowedOrigins(reqUrl: string): Set<string> {
  const out = new Set<string>();
  const add = (raw: string | undefined | null) => {
    if (!raw) return;
    try {
      out.add(new URL(raw).origin);
    } catch {
      /* ignore malformed */
    }
  };
  add(reqUrl);
  add(process.env.APP_ORIGIN);
  add(process.env.NEXTAUTH_URL);
  return out;
}

/** Parse a Referer header down to its origin, or null when absent/malformed. */
function refererOrigin(referer: string | null): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

export interface CsrfRequest {
  headers: Pick<Headers, 'get'>;
  url: string;
}

/**
 * Enforce the Origin/Referer allowlist for a state-changing request. Call at the
 * top of a mutating (POST/DELETE/PUT/PATCH) cookie-auth `/api` handler:
 *
 *   const bad = csrfCheck(req);
 *   if (bad) return bad;
 */
export function csrfCheck(req: CsrfRequest): NextResponse | null {
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');

  // Neither header present → not a browser cross-site attack we can/need to bound.
  if (!origin && !referer) return null;

  const allowed = allowedOrigins(req.url);
  const candidate = origin ?? refererOrigin(referer);

  if (candidate && allowed.has(candidate)) return null;

  return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
}
