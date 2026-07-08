/**
 * Inbound applications ingest.
 *
 * A talent who self-applies to our published job (8vance `/feedback/?direction=1`)
 * is auto-added to the project pipeline at the Inflow stage with a "Gesolliciteerd"
 * badge, and their identity is shown FREE via a 0-credit `source:'application'`
 * Reveal — never touching the credit ledger. Own-pool only; CLOSED projects
 * ingest nothing; the ingest is idempotent.
 *
 * Run with `npx vitest run tests/applications.test.ts`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '@prisma/client';

import { VanceClient } from '@/lib/eightvance/client';
import { invalidateToken } from '@/lib/eightvance/auth';
import { _resetBuckets } from '@/lib/eightvance/ratelimit';
import { _resetTenantClientCache } from '@/lib/eightvance/tenant-client';
import { encrypt } from '@/lib/crypto';
import { decrypt } from '@/lib/crypto';
import { ingestApplicationsForProject } from '@/lib/applications/ingest';

const prisma = new PrismaClient();
const BASE = 'https://example.test/public/v1';
const TOKEN_URL = `${BASE}/auth/token/client/`;
const OWN_SOURCE = 'own_pool_source';
const COMPANY_ID = 34231;

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Stub 8vance for the ingest: a feedback feed (direction=1) plus per-talent
 * sub-resources. `applicantIds` get full own-pool profiles + sources including
 * OWN_SOURCE; `crossTenantIds` 404 on the profile (not own-pool).
 */
function stubVance(opts: {
  jobId: number;
  applicantIds: number[];
  crossTenantIds?: number[];
}): ReturnType<typeof vi.fn> {
  const cross = new Set(opts.crossTenantIds ?? []);
  const fetchMock = vi.fn(async (url: string) => {
    if (url === TOKEN_URL) return json({ access: 'tok', refresh: 'r' });
    const u = new URL(url);
    const path = u.pathname.replace('/public/v1', '');

    if (path === '/feedback/') {
      const rows = [...opts.applicantIds, ...(opts.crossTenantIds ?? [])].map((id, i) => ({
        id: 1000 + i,
        talent_id: id,
        job: opts.jobId,
        job_title: 'Job',
        added_at: '2026-06-20T10:00:00Z',
        applied: true,
        direction: 1,
        company: COMPANY_ID,
      }));
      return json({ count: rows.length, next: null, results: rows });
    }

    // /talent/{id}/ profile (note: GETs end with a trailing slash)
    const profileMatch = path.match(/^\/talent\/(\d+)\/$/);
    if (profileMatch) {
      const id = Number(profileMatch[1]);
      if (cross.has(id)) {
        return new Response(JSON.stringify({ detail: 'not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return json({
        id,
        first_name: 'Ada',
        last_name: `Lovelace${id}`,
        email: `ada${id}@x.io`,
        function_name: 'Engineer',
        total_years_experience: 7,
        company_id: COMPANY_ID,
      });
    }
    const subMatch = path.match(/^\/talent\/(\d+)\/(\w[\w-]*)\/$/);
    if (subMatch) {
      const sub = subMatch[2];
      if (sub === 'sources') return json([{ name: OWN_SOURCE }]);
      if (sub === 'skill')
        return json([
          { skill: 1, skill_name: 'TypeScript', proficiency_id: 25 },
          { skill: 2, skill_name: 'React', proficiency_id: 25 },
          { skill: 3, skill_name: 'Node', proficiency_id: 25 },
        ]);
      if (sub === 'location') return json({ city: 'Eindhoven', country: 'Nederland', region: 'Noord-Brabant' });
      // job-experience / education / language → empty
      return json([]);
    }
    return json({ count: 0, results: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

interface Ctx {
  orgId: string;
  tenantId: string;
  userId: string;
  projectId: string;
  jobId: number;
}

async function seed(opts: { status?: string } = {}): Promise<Ctx> {
  const org = await prisma.organization.create({
    data: { name: 'Org ' + Math.random().toString(36).slice(2, 8) },
  });
  const tenant = await prisma.tenant.create({
    data: {
      slug: 't-' + Math.random().toString(36).slice(2, 8),
      name: 'Tenant',
      eightvanceClientId: 'cid',
      eightvanceClientSecretEnc: encrypt('secret'),
      eightvanceCompanyId: COMPANY_ID,
      eightvanceBaseUrl: BASE,
      ownSourceSlug: OWN_SOURCE,
      brandConfigJson: {},
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `u-${Math.random().toString(36).slice(2, 8)}@t.local`,
      creditsBalance: 10,
      organizationId: org.id,
      memberships: { create: { organizationId: org.id, role: 'OWNER' } },
    },
  });
  const jobId = 5000 + Math.floor(Math.random() * 1000);
  const project = await prisma.project.create({
    data: {
      userId: user.id,
      organizationId: org.id,
      title: 'Backend role',
      locationCity: 'Eindhoven',
      locationCountry: 'NL',
      skillsJson: [{ id: 1, name: 'TypeScript', must_have: true }],
      languagesJson: [],
      status: (opts.status ?? 'READY') as never,
      pools: {
        create: {
          tenantId: tenant.id,
          eightvanceJobId: jobId,
          status: 'READY',
        },
      },
    },
  });
  return { orgId: org.id, tenantId: tenant.id, userId: user.id, projectId: project.id, jobId };
}

beforeEach(async () => {
  invalidateToken();
  _resetBuckets();
  _resetTenantClientCache();
  await prisma.revealLock.deleteMany();
  await prisma.reveal.deleteMany();
  await prisma.shortlistEntry.deleteMany();
  await prisma.match.deleteMany();
  await prisma.creditTransaction.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.pipelineStage.deleteMany();
  await prisma.projectPool.deleteMany();
  await prisma.project.deleteMany();
  await prisma.organizationMember.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.tenant.deleteMany();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('feedback.listApplicants', () => {
  it('parses direction=1 feedback rows into normalized applicants', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === TOKEN_URL) return json({ access: 'tok' });
        return json({
          count: 2,
          next: null,
          results: [
            { id: 1, talent_id: 11, applied: true, direction: 1, added_at: '2026-06-20T10:00:00Z' },
            { id: 2, talent: 22, applied: false, direction: 1 },
            { id: 3, applied: true, direction: 1 }, // no talent id → dropped
          ],
        });
      }),
    );
    const client = new VanceClient({
      clientId: 'c',
      clientSecret: 's',
      companyId: COMPANY_ID,
      baseUrl: BASE,
      allowedCompanyIds: [COMPANY_ID],
    });
    const applicants = await client.feedback.listApplicants(999);
    expect(applicants).toHaveLength(2);
    expect(applicants[0]).toEqual({ talentId: 11, appliedAt: '2026-06-20T10:00:00Z', applied: true });
    expect(applicants[1]).toEqual({ talentId: 22, appliedAt: null, applied: false });
  });
});

describe('ingestApplicationsForProject', () => {
  it('creates Match + Inflow ShortlistEntry(appliedAt) + a 0-credit application Reveal, no credit spent', async () => {
    const ctx = await seed();
    stubVance({ jobId: ctx.jobId, applicantIds: [101] });

    const res = await ingestApplicationsForProject(ctx.projectId);
    expect(res.added).toBe(1);

    const match = await prisma.match.findFirst({
      where: { projectId: ctx.projectId, eightvanceTalentId: 101 },
    });
    expect(match).not.toBeNull();

    const entry = await prisma.shortlistEntry.findFirst({ where: { matchId: match!.id } });
    expect(entry).not.toBeNull();
    expect(entry!.appliedAt).not.toBeNull();
    // Inflow = revealRequired:false stage.
    const stage = await prisma.pipelineStage.findUnique({ where: { id: entry!.stageId! } });
    expect(stage?.revealRequired).toBe(false);

    const reveal = await prisma.reveal.findFirst({
      where: { projectId: ctx.projectId, eightvanceTalentId: 101 },
    });
    expect(reveal).not.toBeNull();
    expect(reveal!.creditCost).toBe(0);
    expect(reveal!.source).toBe('application');
    // PII is decryptable from the reveal payload (identity shown free).
    const pii = JSON.parse(decrypt(reveal!.piiPayloadEnc)) as { email?: string };
    expect(pii.email).toBe('ada101@x.io');

    // Ledger untouched — no credit transaction, balance unchanged.
    expect(await prisma.creditTransaction.count()).toBe(0);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    expect(user.creditsBalance).toBe(10);
    // No exclusivity lock for a free application reveal.
    expect(await prisma.revealLock.count()).toBe(0);
  });

  it('drops a cross-tenant applicant (own-pool filter)', async () => {
    const ctx = await seed();
    // 101 is own-pool; 202 404s its profile → not own-pool.
    stubVance({ jobId: ctx.jobId, applicantIds: [101], crossTenantIds: [202] });

    const res = await ingestApplicationsForProject(ctx.projectId);
    expect(res.added).toBe(1);
    expect(await prisma.match.count({ where: { eightvanceTalentId: 202 } })).toBe(0);
    expect(await prisma.match.count({ where: { eightvanceTalentId: 101 } })).toBe(1);
  });

  it('ingests nothing for a CLOSED project', async () => {
    const ctx = await seed({ status: 'CLOSED' });
    const fetchMock = stubVance({ jobId: ctx.jobId, applicantIds: [101] });

    const res = await ingestApplicationsForProject(ctx.projectId);
    expect(res.added).toBe(0);
    expect(await prisma.match.count()).toBe(0);
    expect(await prisma.reveal.count()).toBe(0);
    // No 8vance calls at all (returned before touching the client).
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is idempotent: a second run adds nothing', async () => {
    const ctx = await seed();
    stubVance({ jobId: ctx.jobId, applicantIds: [101] });

    const first = await ingestApplicationsForProject(ctx.projectId);
    expect(first.added).toBe(1);

    const second = await ingestApplicationsForProject(ctx.projectId);
    expect(second.added).toBe(0);

    expect(await prisma.match.count({ where: { eightvanceTalentId: 101 } })).toBe(1);
    expect(await prisma.shortlistEntry.count()).toBe(1);
    expect(await prisma.reveal.count()).toBe(1);
    expect(await prisma.creditTransaction.count()).toBe(0);
  });
});
