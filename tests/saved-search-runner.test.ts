import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { encrypt } from '../src/lib/crypto';

// --- Mock the three side-effecting collaborators -------------------------
// We drive the new-match DIFF + notify routing purely, without touching
// 8vance or the real matcher. `syncProjectToVance` is a no-op; the test-owned
// `hydrateImpl` inserts the "after" Match rows so the runner sees the diff.

const notifyMock = vi.fn(
  async (_input: unknown) => ({ inAppCreated: true, emailSent: false }),
);
let hydrateImpl: (projectId: string) => Promise<unknown> = async () => ({});

vi.mock('../src/lib/eightvance/job-sync', () => ({
  syncProjectToVance: vi.fn(async () => ({})),
}));
vi.mock('../src/lib/match/hydrate', () => ({
  hydrateMatchesForProject: vi.fn((projectId: string) => hydrateImpl(projectId)),
}));
vi.mock('../src/lib/notifications/deliver', () => ({
  notify: (input: unknown) => notifyMock(input),
}));

import { runSavedSearch } from '../src/lib/saved-search/runner';

const prisma = new PrismaClient();

let tenantId = '';

async function seedTenant(): Promise<string> {
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
  return tenant.id;
}

async function seedSavedSearch(opts: {
  notifyEmail: boolean;
  existingTalentIds: number[];
}): Promise<{ savedSearchId: string; projectId: string }> {
  const user = await prisma.user.create({
    data: { email: `u-${Math.random().toString(36).slice(2, 8)}@test.local` },
  });
  const project = await prisma.project.create({
    data: {
      userId: user.id,
      title: 'Senior backend engineer',
      locationCity: 'Amsterdam',
      locationCountry: 'NL',
      skillsJson: [],
      languagesJson: [],
    },
  });
  await prisma.projectPool.create({
    data: { projectId: project.id, tenantId, status: 'READY', eightvanceTaskId: 'old' },
  });
  for (const tid of opts.existingTalentIds) {
    await prisma.match.create({
      data: {
        projectId: project.id,
        tenantId,
        eightvanceTalentId: tid,
        opaqueId: `op-${tid}`,
        score: 0.9,
        anonymizedPayloadJson: {},
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
  }
  const saved = await prisma.savedSearch.create({
    data: {
      userId: user.id,
      projectId: project.id,
      name: 'my search',
      notifyEmail: opts.notifyEmail,
    },
  });
  return { savedSearchId: saved.id, projectId: project.id };
}

/** Build a hydrate impl that inserts the given talent ids as new Match rows. */
function hydrateInsertingTalents(projectId: string, talentIds: number[]) {
  return async () => {
    for (const tid of talentIds) {
      await prisma.match.upsert({
        where: {
          projectId_tenantId_eightvanceTalentId: {
            projectId,
            tenantId,
            eightvanceTalentId: tid,
          },
        },
        update: {},
        create: {
          projectId,
          tenantId,
          eightvanceTalentId: tid,
          opaqueId: `op-${tid}`,
          score: 0.8,
          anonymizedPayloadJson: {},
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
    }
    return {};
  };
}

describe('runSavedSearch', () => {
  beforeEach(async () => {
    notifyMock.mockClear();
    hydrateImpl = async () => ({});
    // Clean slate so cross-test Match rows don't leak into diffs.
    await prisma.match.deleteMany({});
    await prisma.savedSearch.deleteMany({});
    await prisma.projectPool.deleteMany({});
    await prisma.project.deleteMany({});
    await prisma.tenant.deleteMany({});
    await prisma.user.deleteMany({});
    tenantId = await seedTenant();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('detects new matches and notifies (in-app + email when notifyEmail on)', async () => {
    const { savedSearchId, projectId } = await seedSavedSearch({
      notifyEmail: true,
      existingTalentIds: [1, 2],
    });
    // Hydrate adds talent 3 (new) on top of the existing 1,2.
    hydrateImpl = hydrateInsertingTalents(projectId, [3]);

    const res = await runSavedSearch(savedSearchId);

    expect(res.newMatchCount).toBe(1);
    expect(res.notified).toBe(true);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const call = notifyMock.mock.calls[0][0] as unknown as {
      type: string;
      email?: unknown;
      payload: Record<string, unknown>;
    };
    expect(call.type).toBe('new_match');
    // notifyEmail on → an email payload is passed through.
    expect(call.email).toBeTruthy();
    // Payload carries the projectId + title + count so the notifications page
    // can render the title and link to the shortlist (no blank "voor <BLANK>").
    expect(call.payload.projectId).toBe(projectId);
    expect(call.payload.projectTitle).toBe('Senior backend engineer');
    expect(call.payload.count).toBe(1);
  });

  it('does not notify when there are no new matches', async () => {
    const { savedSearchId, projectId } = await seedSavedSearch({
      notifyEmail: true,
      existingTalentIds: [1, 2],
    });
    // Hydrate re-finds only the same talents → no diff.
    hydrateImpl = hydrateInsertingTalents(projectId, [1, 2]);

    const res = await runSavedSearch(savedSearchId);

    expect(res.newMatchCount).toBe(0);
    expect(res.notified).toBe(false);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('omits the email payload when notifyEmail is off (in-app only)', async () => {
    const { savedSearchId, projectId } = await seedSavedSearch({
      notifyEmail: false,
      existingTalentIds: [],
    });
    hydrateImpl = hydrateInsertingTalents(projectId, [10, 11]);

    const res = await runSavedSearch(savedSearchId);

    expect(res.newMatchCount).toBe(2);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const call = notifyMock.mock.calls[0][0] as unknown as { email?: unknown };
    expect(call.email).toBeUndefined();
  });

  it('updates lastRunAt on every run', async () => {
    const { savedSearchId, projectId } = await seedSavedSearch({
      notifyEmail: true,
      existingTalentIds: [],
    });
    hydrateImpl = hydrateInsertingTalents(projectId, [42]);

    await runSavedSearch(savedSearchId);

    const after = await prisma.savedSearch.findUnique({ where: { id: savedSearchId } });
    expect(after?.lastRunAt).toBeTruthy();
  });

  it('throws for an unknown saved search id', async () => {
    await expect(runSavedSearch('does-not-exist')).rejects.toThrow(/not found/);
  });
});
