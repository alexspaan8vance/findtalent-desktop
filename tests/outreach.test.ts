import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { encrypt } from '../src/lib/crypto';
import { recordOutreach, hasOutreach, listForProject } from '../src/lib/outreach';

const prisma = new PrismaClient();

async function seed(): Promise<{
  userId: string;
  projectId: string;
  tenantId: string;
}> {
  const tenant = await prisma.tenant.create({
    data: {
      slug: `t-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Test',
      eightvanceClientId: 'cid',
      eightvanceClientSecretEnc: encrypt('sekret'),
      eightvanceCompanyId: 34231,
      brandConfigJson: {},
    },
  });
  const user = await prisma.user.create({
    data: { email: `u-${Math.random().toString(36).slice(2, 8)}@test.local` },
  });
  const project = await prisma.project.create({
    data: {
      userId: user.id,
      title: 'Backend engineer',
      locationCity: 'Amsterdam',
      locationCountry: 'NL',
      skillsJson: [],
      languagesJson: [],
    },
  });
  return { userId: user.id, projectId: project.id, tenantId: tenant.id };
}

describe('outreach helpers', () => {
  beforeEach(async () => {
    await prisma.outreach.deleteMany({});
    await prisma.project.deleteMany({});
    await prisma.tenant.deleteMany({});
    await prisma.user.deleteMany({});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('records outreach with SENT status + template key and exposes it via hasOutreach', async () => {
    const { userId, projectId, tenantId } = await seed();

    const before = await hasOutreach({ userId, projectId, eightvanceTalentId: 42 });
    expect(before.contacted).toBe(false);
    expect(before.firstAt).toBeNull();

    const row = await recordOutreach({
      userId,
      projectId,
      tenantId,
      eightvanceTalentId: 42,
      templateKey: 'candidate_outreach',
    });
    expect(row.templateKey).toBe('candidate_outreach');
    expect(row.channel).toBe('email');

    const after = await hasOutreach({ userId, projectId, eightvanceTalentId: 42 });
    expect(after.contacted).toBe(true);
    expect(after.firstAt).toBeInstanceOf(Date);
  });

  it('hasOutreach returns the EARLIEST contact date across repeat outreach', async () => {
    const { userId, projectId, tenantId } = await seed();
    const first = await recordOutreach({
      userId,
      projectId,
      tenantId,
      eightvanceTalentId: 7,
    });
    await new Promise((r) => setTimeout(r, 5));
    await recordOutreach({ userId, projectId, tenantId, eightvanceTalentId: 7 });

    const status = await hasOutreach({ userId, projectId, eightvanceTalentId: 7 });
    expect(status.firstAt?.getTime()).toBe(first.createdAt.getTime());
  });

  it('scopes hasOutreach by user + project + talent', async () => {
    const { userId, projectId, tenantId } = await seed();
    await recordOutreach({ userId, projectId, tenantId, eightvanceTalentId: 1 });

    // Different talent → not contacted.
    expect((await hasOutreach({ userId, projectId, eightvanceTalentId: 2 })).contacted).toBe(
      false,
    );
  });

  it('listForProject returns rows newest-first', async () => {
    const { userId, projectId, tenantId } = await seed();
    await recordOutreach({ userId, projectId, tenantId, eightvanceTalentId: 1 });
    await new Promise((r) => setTimeout(r, 5));
    await recordOutreach({ userId, projectId, tenantId, eightvanceTalentId: 2 });

    const list = await listForProject(projectId);
    expect(list).toHaveLength(2);
    expect(list[0].eightvanceTalentId).toBe(2); // newest first
  });
});

// ---------------------------------------------------------------------------
// Bulk-reveal sequencing semantics (mirrors compare/page.tsx bulkRevealAction):
// reveal sequentially, stop on insufficient_credits, mark the rest skipped.
// ---------------------------------------------------------------------------

type RevealRes =
  | { ok: true }
  | { ok: false; reason: 'insufficient_credits' | 'locked' | 'internal' | 'not_found' };

type BulkStatus = 'revealed' | 'insufficient_credits' | 'locked' | 'error' | 'skipped';

async function bulkReveal(
  matchIds: string[],
  reveal: (id: string) => Promise<RevealRes>,
): Promise<Array<{ matchId: string; status: BulkStatus }>> {
  const results: Array<{ matchId: string; status: BulkStatus }> = [];
  let stop = false;
  for (const matchId of matchIds) {
    if (stop) {
      results.push({ matchId, status: 'skipped' });
      continue;
    }
    const res = await reveal(matchId);
    if (res.ok) results.push({ matchId, status: 'revealed' });
    else if (res.reason === 'insufficient_credits') {
      results.push({ matchId, status: 'insufficient_credits' });
      stop = true;
    } else if (res.reason === 'locked') results.push({ matchId, status: 'locked' });
    else results.push({ matchId, status: 'error' });
  }
  return results;
}

describe('bulk-reveal sequencing', () => {
  it('reveals all when credits suffice', async () => {
    const res = await bulkReveal(['a', 'b', 'c'], async () => ({ ok: true }));
    expect(res.map((r) => r.status)).toEqual(['revealed', 'revealed', 'revealed']);
  });

  it('stops on insufficient credits and skips the rest (no further reveal calls)', async () => {
    const seen: string[] = [];
    const res = await bulkReveal(['a', 'b', 'c', 'd'], async (id) => {
      seen.push(id);
      return id === 'b'
        ? { ok: false, reason: 'insufficient_credits' }
        : { ok: true };
    });
    expect(res.map((r) => r.status)).toEqual([
      'revealed',
      'insufficient_credits',
      'skipped',
      'skipped',
    ]);
    // c, d were never attempted.
    expect(seen).toEqual(['a', 'b']);
  });

  it('marks locked candidates locked but keeps going', async () => {
    const res = await bulkReveal(['a', 'b'], async (id) =>
      id === 'a' ? { ok: false, reason: 'locked' } : { ok: true },
    );
    expect(res.map((r) => r.status)).toEqual(['locked', 'revealed']);
  });
});
