import { NextResponse } from 'next/server';

import { prisma } from '@/lib/db';
import { defaultVanceCredentials } from '@/lib/env';
import { getToken } from '@/lib/eightvance/auth';
import { reportError } from '@/lib/observability/report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_BASE_URL = 'https://app.8vance.com/public/v1';
const TOKEN_PROBE_TIMEOUT_MS = 2_500;

/** Resolve a promise to `null` if it doesn't settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * Best-effort 8vance auth probe. Reports only a coarse status — never the
 * token, client id, or secret. Returns:
 *   - 'ok'           token obtained
 *   - 'unconfigured' no default client credentials in env
 *   - 'unreachable'  configured but token could not be obtained (down / bad creds / timeout)
 */
type EightvanceStatus = 'ok' | 'unconfigured' | 'unreachable';

async function probeEightvance(): Promise<EightvanceStatus> {
  // Reconciled default creds: VANCE_PROD_* with EIGHTVANCE_* (the names the
  // Docker deploy sets) as fallback — see defaultVanceCredentials in env.ts.
  const { clientId, clientSecret } = defaultVanceCredentials();
  if (!clientId || !clientSecret) return 'unconfigured';
  const baseUrl = process.env.VANCE_BASE_URL ?? DEFAULT_BASE_URL;
  try {
    const token = await withTimeout(
      getToken(clientId, clientSecret, baseUrl),
      TOKEN_PROBE_TIMEOUT_MS,
    );
    return typeof token === 'string' && token.length > 0 ? 'ok' : 'unreachable';
  } catch {
    // Swallow the underlying error (may carry a redacted upstream payload) —
    // never surface auth internals on a public health endpoint.
    return 'unreachable';
  }
}

// /api/health is PUBLIC and hit by the Docker healthcheck (and anyone else). The
// 8vance probe fires a token request upstream, so an unauthenticated flood of
// health calls would otherwise hammer the 8vance token endpoint. Memoize the
// probe result in-module for a short TTL, and coalesce concurrent misses onto a
// single in-flight probe, so N health calls cause at most 1 upstream probe per
// TTL window. The DB check stays live per request — it's the liveness signal.
const EIGHTVANCE_PROBE_TTL_MS = 30_000;
let eightvanceCache: { at: number; value: EightvanceStatus } | null = null;
let eightvanceInflight: Promise<EightvanceStatus> | null = null;

async function cachedProbeEightvance(): Promise<EightvanceStatus> {
  const now = Date.now();
  if (eightvanceCache && now - eightvanceCache.at < EIGHTVANCE_PROBE_TTL_MS) {
    return eightvanceCache.value;
  }
  // Coalesce a concurrent flood onto one probe rather than firing one per call.
  if (eightvanceInflight) return eightvanceInflight;
  eightvanceInflight = (async () => {
    try {
      const value = await probeEightvance();
      eightvanceCache = { at: Date.now(), value };
      return value;
    } finally {
      eightvanceInflight = null;
    }
  })();
  return eightvanceInflight;
}

export async function GET() {
  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (err) {
    // PUBLIC endpoint (Docker healthcheck) — never surface the raw driver
    // error (may carry file paths / connection strings). Log it server-side.
    reportError(err, { area: 'health', check: 'db' });
  }

  const eightvance = await cachedProbeEightvance();

  // Overall liveness hinges on the DB (the app cannot serve without it).
  // A degraded 8vance is reported but does not, on its own, fail the check —
  // it's an upstream dependency the app can partially operate without.
  const ok = dbOk;

  // Minimal, unauthenticated-safe body: coarse statuses only. No version /
  // commit sha (fingerprinting aid) and no error detail on a public route.
  const body = {
    ok,
    time: new Date().toISOString(),
    checks: {
      db: dbOk ? 'ok' : 'error',
      eightvance,
    },
  };

  return NextResponse.json(body, { status: ok ? 200 : 503 });
}
