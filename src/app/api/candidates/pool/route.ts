/**
 * GET /api/candidates/pool?tenantId=<id>&page=<n>&page_size=<25|50|100>&q=<text>
 *
 * Owner-authed, PAGINATED read-through of a FULL pool's 8vance talents. Backs
 * the scope-aware /app/candidates list: for a pool whose `talentScope` is FULL
 * the owner can browse the whole 8vance talent pool here (not just the local
 * Candidate rows).
 *
 * Each row carries: 8vance talentId, name + email, and `localCandidateId`
 * (non-null when a local Candidate already exists for that talent in this org)
 * so the list can dedupe pool-only vs registered-here talents and route the
 * right "View profile" / "Import" action.
 *
 * PERFORMANCE: ~1000 talents — we NEVER fetch them all. One 8vance page per
 * request (default 25) via `talent.listPage` using 8vance's own pagination.
 * `q` is passed through to 8vance's talent search; we also name-filter the page
 * client-side as a safety net (8vance honouring `?q=` on /talent/ varies per
 * deploy — `searchPassedThrough` tells the UI which happened). Cached per
 * (tenant, page, q) ~60s to soak repeat scrolls and respect the rate limit.
 *
 * SECURITY: 8vance creds terminate server-side (vanceClientForTenant). Authed +
 * org-guarded: the caller must own the pool's intake org (or be a member),
 * mirroring the candidate-list scope. We refuse a tenant the caller can't see
 * and refuse a non-FULL pool (LOCAL pools have no read-through to surface).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { getOrCreateUserOrg } from '@/lib/org';
import { getAllowedTenantIds } from '@/lib/tenant-access';
import { userMayAccessCandidates } from '@/lib/candidate/access';
import { createLru } from '@/lib/cache/lru';
import { vanceClientForTenant } from '@/lib/eightvance/tenant-client';

export const dynamic = 'force-dynamic';

export interface PoolTalentRow {
  /** 8vance talent id. */
  talentId: number;
  name: string;
  email: string | null;
  /** Local Candidate id when this talent is already registered here, else null. */
  localCandidateId: string | null;
}

export interface PoolPayload {
  rows: PoolTalentRow[];
  page: number;
  pageSize: number;
  /** Total pool size (8vance envelope count) when known, else null. */
  total: number | null;
  hasNext: boolean;
  /** True when 8vance appears to have honoured `?q=` (vs us filtering locally). */
  searchPassedThrough: boolean;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const CACHE_TTL_MS = 60 * 1000;

// Cache the RAW 8vance page (pre-dedupe) per (tenant, page, q). The local
// Candidate dedupe is cheap + must stay live (a just-imported talent flips to
// "registered here" immediately), so we re-run it on every request and only
// cache the upstream read.
interface RawPage {
  rows: Array<{ id: number; name: string; email: string | null }>;
  total: number | null;
  hasNext: boolean;
  searchPassedThrough: boolean;
}
const rawCache = createLru<RawPage>({ max: 200, ttlMs: CACHE_TTL_MS });

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return jsonError('unauthorized', 401);

  // Candidates-surface gate (fresh DB read, not the JWT claim): accounts
  // without the candidatesEnabled grant may not browse the talent pool.
  if (!(await userMayAccessCandidates(userId))) return jsonError('forbidden', 403);

  const tenantId = req.nextUrl.searchParams.get('tenantId')?.trim();
  if (!tenantId) return jsonError('tenantId query param required', 400);

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, talentScope: true },
  });
  if (!tenant) return jsonError('unknown tenant', 404);

  // Org guard (FAIL-CLOSED): the caller's org must actually be authorized to
  // target this pool. Reuse the canonical scope helper (src/lib/tenant-access) —
  // a pool the org OWNS (Tenant.ownerOrganizationId) OR already has a candidate
  // in. Crucially, a pool with NO claimed owner (ownerOrganizationId null — every
  // freshly-added pool until its first candidate is created) is NOT implicitly
  // public: getAllowedTenantIds omits it unless the org has a candidate there, so
  // we fail closed rather than leak its full name+email roster cross-org.
  const orgId = await getOrCreateUserOrg(userId);
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (!me) return jsonError('unauthorized', 401);
  const allowedTenantIds = await getAllowedTenantIds(userId, me.role);
  if (!allowedTenantIds.has(tenant.id)) return jsonError('forbidden', 403);

  // LOCAL pools have no read-through pool to surface (the local rows ARE the
  // pool). Refuse rather than silently returning an empty list.
  if (String(tenant.talentScope).toUpperCase() !== 'FULL') {
    return jsonError('pool is LOCAL scope', 409);
  }

  const pageRaw = Number(req.nextUrl.searchParams.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  // Page size: client-selectable (25 / 50 / 100), validated 1..100, default 25.
  // Cap hard at 100 so a hand-crafted request can't ask 8vance for a huge page.
  const pageSizeRaw = Number(req.nextUrl.searchParams.get('page_size') ?? '');
  const pageSize =
    Number.isFinite(pageSizeRaw) && pageSizeRaw > 0
      ? Math.min(MAX_PAGE_SIZE, Math.floor(pageSizeRaw))
      : DEFAULT_PAGE_SIZE;
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 120);

  const cacheKey = `${tenantId}:${pageSize}:${page}:${q.toLowerCase()}`;
  let raw = rawCache.get(cacheKey);
  if (!raw) {
    try {
      const client = await vanceClientForTenant(tenantId);
      const res = await client.talent.listPage({ page, pageSize, q });
      // Detect whether 8vance honoured the query: if a `q` was sent and EVERY
      // returned row matches it (name/email), assume server-side search worked;
      // otherwise we filter locally and flag it so the UI can say so.
      let rows = res.rows;
      let searchPassedThrough = true;
      if (q) {
        const needle = q.toLowerCase();
        const matches = (r: { name: string; email: string | null }) =>
          r.name.toLowerCase().includes(needle) ||
          (r.email ? r.email.toLowerCase().includes(needle) : false);
        const allMatch = rows.length > 0 && rows.every(matches);
        if (!allMatch) {
          rows = rows.filter(matches);
          searchPassedThrough = false;
        }
      }
      raw = {
        rows,
        total: res.total,
        hasNext: res.hasNext,
        searchPassedThrough,
      };
      rawCache.set(cacheKey, raw);
    } catch {
      return jsonError('pool read failed', 502);
    }
  }

  // Dedupe against local Candidate rows (live, not cached): map each pool talent
  // to its local Candidate id (this org) so the UI can show synced/local vs
  // pool-only and route the right action. Scoped to the org so we never leak
  // another org's local rows.
  const talentIds = raw.rows.map((r) => r.id);
  const localByTalentId = new Map<number, string>();
  if (talentIds.length > 0) {
    const locals = await prisma.candidate.findMany({
      where: {
        tenantId,
        organizationId: orgId,
        eightvanceTalentId: { in: talentIds },
        status: { not: 'ARCHIVED' },
      },
      select: { id: true, eightvanceTalentId: true },
    });
    for (const c of locals) {
      if (c.eightvanceTalentId != null && !localByTalentId.has(c.eightvanceTalentId)) {
        localByTalentId.set(c.eightvanceTalentId, c.id);
      }
    }
  }

  const payload: PoolPayload = {
    rows: raw.rows.map((r) => ({
      talentId: r.id,
      name: r.name,
      email: r.email,
      localCandidateId: localByTalentId.get(r.id) ?? null,
    })),
    page,
    pageSize,
    total: raw.total,
    hasNext: raw.hasNext,
    searchPassedThrough: raw.searchPassedThrough,
  };
  return NextResponse.json(payload);
}
