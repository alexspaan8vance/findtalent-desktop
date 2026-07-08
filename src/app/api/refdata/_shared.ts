/**
 * Shared scaffolding for `/api/refdata/*` proxy routes.
 *
 * - Authenticates the caller via NextAuth (`auth()`); 401 if no session.
 * - Caller must pass `?tenantId=<id>` so multi-pool deploys know which
 *   8vance company to query reference data from.
 * - Wraps the 8vance call in a tenant-scoped LRU keyed by `tenantId + q`.
 * - Normalises responses to `{ results: T[] }`.
 *
 * Never expose 8vance creds: server-side termination.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { canAccessCandidates } from '@/lib/access';
import { createLru, type Lru } from '@/lib/cache/lru';
import { vanceClientForTenant } from '@/lib/eightvance/tenant-client';
import type { VanceClient } from '@/lib/eightvance/client';
// (getOrCreateUserOrg moved out with getAllowedTenantIds into @/lib/tenant-access)
// Authorization helper lives in a neutral lib module (no NextAuth/next-server
// deps) so server-actions can import it without dragging this route module in.
import { getAllowedTenantIds } from '@/lib/tenant-access';
export { getAllowedTenantIds };

interface SessionLike {
  user?: { id?: string | null } | null;
}

export interface ApiUser {
  kind: 'user';
  userId: string;
  tenantId: string;
}

export type ApiAuthResult = ApiUser | { kind: 'response'; response: NextResponse };

export interface RequireApiUserOptions {
  /**
   * Gate on the candidates surface: only ADMIN or accounts with the
   * `candidatesEnabled` grant pass (403 otherwise). Checked against the DB
   * (fresh), not the JWT claim — the middleware's token-based check is only
   * defense in depth, this is the authoritative one. Set on /api/candidates/*
   * routes; refdata/normalize callers omit it and are unaffected.
   */
  candidates?: boolean;
}

export async function requireApiUser(
  req: NextRequest,
  opts?: RequireApiUserOptions,
): Promise<ApiAuthResult> {
  const session = (await auth()) as SessionLike | null;
  const userId = session?.user?.id;
  if (!userId) {
    return {
      kind: 'response',
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    };
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, candidatesEnabled: true },
  });
  if (!user) {
    return {
      kind: 'response',
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    };
  }
  if (
    opts?.candidates &&
    !canAccessCandidates({ role: user.role, candidatesEnabled: user.candidatesEnabled })
  ) {
    return {
      kind: 'response',
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    };
  }
  const tenantId = req.nextUrl.searchParams.get('tenantId')?.trim();
  if (!tenantId) {
    return {
      kind: 'response',
      response: NextResponse.json({ error: 'tenantId query param required' }, { status: 400 }),
    };
  }
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true },
  });
  if (!tenant) {
    return {
      kind: 'response',
      response: NextResponse.json({ error: 'unknown tenant' }, { status: 404 }),
    };
  }
  // IDOR guard: existence is not authorization — the caller must be allowed to
  // target THIS tenant (same org-ownership scope as the candidate pool routes).
  const allowed = await getAllowedTenantIds(user.id, user.role);
  if (!allowed.has(tenant.id)) {
    return {
      kind: 'response',
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    };
  }
  return { kind: 'user', userId: user.id, tenantId: tenant.id };
}

export function jsonOk<T>(payload: T): NextResponse {
  return NextResponse.json(payload);
}

export function jsonBadRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

export function jsonError(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 500 });
}

interface CachedRequestOptions<T> {
  cache: Lru<T>;
  key: string;
  compute: (client: VanceClient) => Promise<T>;
  tenantId: string;
}

export async function cachedFetch<T>(
  opts: CachedRequestOptions<T>,
): Promise<T> {
  const hit = opts.cache.get(opts.key);
  if (hit !== undefined) return hit;
  const client = await vanceClientForTenant(opts.tenantId);
  const value = await opts.compute(client);
  opts.cache.set(opts.key, value);
  return value;
}

export { createLru };

/** Human label for a reference-data row (phrase/display_name/name/...). */
export function refLabel(r: Record<string, unknown>): string {
  for (const k of ['phrase', 'display_name', 'name', 'label', 'title']) {
    const v = r[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return String(r.id ?? '');
}

/**
 * Normalise an 8vance reference list (function-level, education-degree, ...)
 * into clean `{id, name}[]`: prefer English rows, dedupe by id AND by label,
 * sort by id. 8vance returns one row per (concept × locale), which would
 * otherwise flood a dropdown with all four languages.
 */
export function mapReferenceList(
  rows: Array<Record<string, unknown>>,
  preferredLocale = 'en',
): Array<{ id: number; name: string }> {
  const build = (locale: string | null): Array<{ id: number; name: string }> => {
    const out: Array<{ id: number; name: string }> = [];
    const seenId = new Set<number>();
    const seenName = new Set<string>();
    for (const r of rows) {
      if (locale) {
        const lc = r.language_code;
        if (typeof lc === 'string' && lc.toLowerCase() !== locale) continue;
      }
      const id = typeof r.id === 'number' ? r.id : Number(r.id);
      if (!Number.isFinite(id) || seenId.has(id)) continue;
      const name = refLabel(r);
      const nKey = name.toLowerCase();
      if (seenName.has(nKey)) continue;
      seenId.add(id);
      seenName.add(nKey);
      out.push({ id, name });
    }
    return out.sort((a, b) => a.id - b.id);
  };
  // Prefer the requested locale, then English, then anything (deduped).
  const wanted = build(preferredLocale.toLowerCase());
  if (wanted.length > 0) return wanted;
  const en = build('en');
  return en.length > 0 ? en : build(null);
}
