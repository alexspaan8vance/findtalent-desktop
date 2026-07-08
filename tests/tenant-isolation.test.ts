/**
 * Cross-tenant / cross-org isolation regressions.
 *
 *  F3 — candidate hard-delete (GDPR Art.17) must purge only the DELETING org's
 *       employer-side rows (Reveal / Match / ShortlistEntry). In a shared FULL
 *       pool another org's paid rows for the SAME 8vance talent must survive.
 *  F4 — the pool read-through org guard must FAIL CLOSED for a pool with no
 *       claimed owner (ownerOrganizationId null): a non-owning candidatesEnabled
 *       user gets 403, not the pool's name+email roster.
 *  F5 — /api/tenants/list must return only the caller's allowed tenants, never
 *       the full cross-tenant pool/customer roster.
 *
 * Run with `npx vitest run tests/tenant-isolation.test.ts`.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';

import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

import { encrypt } from '../src/lib/crypto';

// --- Mocks -----------------------------------------------------------------
// @/auth (pool + tenants/list routes) — controllable session.
const authMock = vi.hoisted(() => vi.fn<() => Promise<unknown>>(async () => null));
vi.mock('@/auth', () => ({ auth: authMock, signIn: vi.fn(), signOut: vi.fn() }));

// requireUser (delete route) — controllable authed user (id + role).
const h = vi.hoisted(() => ({ user: null as { id: string; role: string } | null }));
vi.mock('../src/lib/auth-helpers', () => ({
  requireUser: vi.fn(async () => {
    if (!h.user) throw new Error('no authed user set in test');
    return h.user;
  }),
}));

// 8vance client (pool route) — never hit the network; the 403 tests short-circuit
// before this, the positive control returns an empty page so we get a clean 200.
const poolMock = vi.hoisted(() => ({
  listPage: vi.fn(async () => ({
    rows: [] as Array<{ id: number; name: string; email: string | null }>,
    total: 0,
    hasNext: false,
  })),
}));
vi.mock('@/lib/eightvance/tenant-client', () => ({
  vanceClientForTenant: vi.fn(async () => ({ talent: poolMock })),
}));

import { POST as deleteCandidate } from '../src/app/api/candidates/[id]/delete/route';
import { GET as poolGet } from '../src/app/api/candidates/pool/route';
import { GET as tenantsList } from '../src/app/api/tenants/list/route';

const prisma = new PrismaClient();

// --- Fixtures --------------------------------------------------------------
const runTag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
let seq = 0;
const rand = () => `${runTag}-${seq++}`;
const future = () => new Date(Date.now() + 86_400_000);

async function mkOrgUser(
  opts: { candidatesEnabled?: boolean; role?: 'ADMIN' | 'CUSTOMER' } = {},
): Promise<{ orgId: string; userId: string }> {
  const org = await prisma.organization.create({ data: { name: `Org ${rand()}` } });
  const user = await prisma.user.create({
    data: {
      email: `u-${rand()}@t.local`,
      role: opts.role ?? 'CUSTOMER',
      candidatesEnabled: opts.candidatesEnabled ?? true,
      organizationId: org.id,
      memberships: { create: { organizationId: org.id, role: 'OWNER' } },
    },
  });
  return { orgId: org.id, userId: user.id };
}

async function mkTenant(
  opts: { ownerOrganizationId?: string | null; scope?: string; name?: string } = {},
) {
  return prisma.tenant.create({
    data: {
      slug: `t-${rand()}`,
      name: opts.name ?? `Pool ${rand()}`,
      eightvanceClientId: 'cid',
      eightvanceClientSecretEnc: encrypt('sekret'),
      eightvanceCompanyId: 34231,
      talentScope: opts.scope ?? 'FULL',
      ownerOrganizationId: opts.ownerOrganizationId ?? null,
      brandConfigJson: {},
    },
  });
}

async function mkProject(userId: string, organizationId: string) {
  return prisma.project.create({
    data: {
      userId,
      organizationId,
      title: 'P',
      locationCity: 'Eindhoven',
      locationCountry: 'NL',
      skillsJson: [],
      languagesJson: [],
    },
  });
}

async function mkMatch(projectId: string, tenantId: string, talentId: number) {
  return prisma.match.create({
    data: {
      projectId,
      tenantId,
      eightvanceTalentId: talentId,
      opaqueId: `op-${rand()}`,
      score: 0.9,
      anonymizedPayloadJson: {},
      expiresAt: future(),
    },
  });
}

async function mkReveal(
  projectId: string,
  userId: string,
  tenantId: string,
  talentId: number,
) {
  return prisma.reveal.create({
    data: {
      projectId,
      userId,
      tenantId,
      eightvanceTalentId: talentId,
      expiresAt: future(),
      piiPayloadEnc: encrypt(JSON.stringify({ email: `${rand()}@x.io` })),
    },
  });
}

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  poolMock.listPage.mockClear();
  authMock.mockImplementation(async () => null);
  h.user = null;
  await prisma.shortlistEntry.deleteMany();
  await prisma.revealLock.deleteMany();
  await prisma.reveal.deleteMany();
  await prisma.match.deleteMany();
  await prisma.candidate.deleteMany();
  await prisma.projectPool.deleteMany();
  await prisma.project.deleteMany();
  await prisma.pipelineStage.deleteMany();
  await prisma.organizationMember.deleteMany();
  await prisma.user.updateMany({ data: { organizationId: null } });
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.tenant.deleteMany();
});

// ---------------------------------------------------------------------------
// F3 — candidate hard-delete cross-org blast radius
// ---------------------------------------------------------------------------
describe('F3 — GDPR erasure is scoped to the deleting org', () => {
  it("org A's delete purges its own rows but leaves org B's Reveal/Match/ShortlistEntry", async () => {
    const TALENT = 987654; // same 8vance talent shared across both orgs' pools.
    const tenant = await mkTenant(); // shared FULL pool.

    const A = await mkOrgUser();
    const B = await mkOrgUser();
    const projectA = await mkProject(A.userId, A.orgId);
    const projectB = await mkProject(B.userId, B.orgId);

    // Org A: candidate + its bought employer-side rows.
    const candidateA = await prisma.candidate.create({
      data: {
        createdByUserId: A.userId,
        organizationId: A.orgId,
        tenantId: tenant.id,
        name: 'Jane A',
        eightvanceTalentId: TALENT,
      },
    });
    const matchA = await mkMatch(projectA.id, tenant.id, TALENT);
    const revealA = await mkReveal(projectA.id, A.userId, tenant.id, TALENT);
    const entryA = await prisma.shortlistEntry.create({
      data: { userId: A.userId, matchId: matchA.id },
    });

    // Org B: its OWN paid rows for the SAME talent in the SAME shared pool.
    const matchB = await mkMatch(projectB.id, tenant.id, TALENT);
    const revealB = await mkReveal(projectB.id, B.userId, tenant.id, TALENT);
    const entryB = await prisma.shortlistEntry.create({
      data: { userId: B.userId, matchId: matchB.id },
    });

    // Org A deletes THEIR candidate.
    h.user = { id: A.userId, role: 'CUSTOMER' };
    const res = await deleteCandidate(
      new NextRequest('http://localhost/api/candidates/x/delete', { method: 'POST' }),
      { params: Promise.resolve({ id: candidateA.id }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Org A's candidate + all its employer-side rows are gone.
    expect(await prisma.candidate.findUnique({ where: { id: candidateA.id } })).toBeNull();
    expect(await prisma.match.findUnique({ where: { id: matchA.id } })).toBeNull();
    expect(await prisma.reveal.findUnique({ where: { id: revealA.id } })).toBeNull();
    expect(await prisma.shortlistEntry.findUnique({ where: { id: entryA.id } })).toBeNull();

    // Org B's rows SURVIVE (their paid PII, their pipeline — not org A's to erase).
    expect(await prisma.match.findUnique({ where: { id: matchB.id } })).not.toBeNull();
    expect(await prisma.reveal.findUnique({ where: { id: revealB.id } })).not.toBeNull();
    expect(await prisma.shortlistEntry.findUnique({ where: { id: entryB.id } })).not.toBeNull();
  });

  it("erasure still removes the OWNER's own reveal/match/shortlist (right not broken)", async () => {
    const TALENT = 55501;
    const tenant = await mkTenant();
    const A = await mkOrgUser();
    const projectA = await mkProject(A.userId, A.orgId);
    const candidateA = await prisma.candidate.create({
      data: {
        createdByUserId: A.userId,
        organizationId: A.orgId,
        tenantId: tenant.id,
        name: 'Solo',
        eightvanceTalentId: TALENT,
      },
    });
    const matchA = await mkMatch(projectA.id, tenant.id, TALENT);
    await mkReveal(projectA.id, A.userId, tenant.id, TALENT);
    await prisma.shortlistEntry.create({ data: { userId: A.userId, matchId: matchA.id } });

    h.user = { id: A.userId, role: 'CUSTOMER' };
    const res = await deleteCandidate(
      new NextRequest('http://localhost/api/candidates/x/delete', { method: 'POST' }),
      { params: Promise.resolve({ id: candidateA.id }) },
    );
    expect(res.status).toBe(200);

    expect(await prisma.match.count({ where: { eightvanceTalentId: TALENT } })).toBe(0);
    expect(await prisma.reveal.count({ where: { eightvanceTalentId: TALENT } })).toBe(0);
    expect(await prisma.shortlistEntry.count()).toBe(0);
    expect(await prisma.candidate.findUnique({ where: { id: candidateA.id } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F4 — pool read-through must fail CLOSED for an unclaimed (null-owner) pool
// ---------------------------------------------------------------------------
describe('F4 — pool read-through org guard fails closed for null-owner pools', () => {
  it('null-owner pool → non-owning candidatesEnabled user gets 403 (no roster leak)', async () => {
    const tenant = await mkTenant({ ownerOrganizationId: null }); // freshly-added, unclaimed.
    const X = await mkOrgUser({ candidatesEnabled: true });
    authMock.mockImplementation(async () => ({ user: { id: X.userId } }));

    const res = await poolGet(
      new NextRequest(`http://localhost/api/candidates/pool?tenantId=${tenant.id}`),
    );
    expect(res.status).toBe(403);
    // The 8vance roster read is never reached.
    expect(poolMock.listPage).not.toHaveBeenCalled();
  });

  it('null-owner pool → a user WITH a candidate in it is still allowed (legit path kept)', async () => {
    const tenant = await mkTenant({ ownerOrganizationId: null });
    const X = await mkOrgUser({ candidatesEnabled: true });
    // The org already has a candidate in this pool (the loose own-pool scope).
    await prisma.candidate.create({
      data: {
        createdByUserId: X.userId,
        organizationId: X.orgId,
        tenantId: tenant.id,
        name: 'Registered here',
      },
    });
    authMock.mockImplementation(async () => ({ user: { id: X.userId } }));

    const res = await poolGet(
      new NextRequest(`http://localhost/api/candidates/pool?tenantId=${tenant.id}`),
    );
    expect(res.status).toBe(200);
    expect(poolMock.listPage).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// F5 — /api/tenants/list scoped to the caller's allowed tenants
// ---------------------------------------------------------------------------
describe('F5 — tenants/list returns only the caller allowed tenants', () => {
  async function idsFrom(res: Awaited<ReturnType<typeof tenantsList>>): Promise<string[]> {
    const body = (await res.json()) as { results: Array<{ id: string }> };
    return body.results.map((r) => r.id).sort();
  }

  it('a user who owns tenant X sees X but NOT another org tenant Y', async () => {
    const X = await mkOrgUser({ candidatesEnabled: false, role: 'CUSTOMER' });
    const other = await mkOrgUser();
    const tenantX = await mkTenant({ ownerOrganizationId: X.orgId, name: 'X' });
    const tenantY = await mkTenant({ ownerOrganizationId: other.orgId, name: 'Y' });
    authMock.mockImplementation(async () => ({ user: { id: X.userId } }));

    const ids = await idsFrom(await tenantsList());
    expect(ids).toEqual([tenantX.id]);
    expect(ids).not.toContain(tenantY.id);
  });

  it('an unrelated user who owns neither pool sees an empty list (fail-closed)', async () => {
    const stranger = await mkOrgUser({ candidatesEnabled: false });
    const ownerA = await mkOrgUser();
    const ownerB = await mkOrgUser();
    await mkTenant({ ownerOrganizationId: ownerA.orgId });
    await mkTenant({ ownerOrganizationId: ownerB.orgId });
    authMock.mockImplementation(async () => ({ user: { id: stranger.userId } }));

    const ids = await idsFrom(await tenantsList());
    expect(ids).toEqual([]);
  });

  it('ADMIN sees the full roster', async () => {
    const admin = await mkOrgUser({ role: 'ADMIN' });
    const ownerA = await mkOrgUser();
    const tenantX = await mkTenant({ ownerOrganizationId: ownerA.orgId });
    const tenantY = await mkTenant({ ownerOrganizationId: null });
    authMock.mockImplementation(async () => ({ user: { id: admin.userId } }));

    const ids = await idsFrom(await tenantsList());
    expect(ids).toEqual([tenantX.id, tenantY.id].sort());
  });
});
