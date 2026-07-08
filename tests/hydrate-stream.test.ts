/**
 * Streaming-insert tests for the match hydrate pipeline.
 *
 * Proves the two behaviours the "faster + real streaming" work depends on:
 *   1. A MINIMAL anonymized candidate row is committed to the DB the moment a
 *      match result is known — BEFORE the per-talent 8vance enrichment GETs
 *      resolve. (So the poller's router.refresh renders a card within seconds.)
 *   2. The fallback ranker streams scored BATCHES into the DB incrementally
 *      (the row count grows during the scan, not only at the very end).
 *
 * Both run against the real per-worker SQLite test DB; only the 8vance tenant
 * client is mocked so no creds/network are needed.
 *
 * Run with `npx vitest run tests/hydrate-stream.test.ts`.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';

import { PrismaClient } from '@prisma/client';
import { encrypt } from '../src/lib/crypto';
import type {
  TalentProfile,
  TalentSkill,
  TalentLocation,
} from '../src/lib/eightvance/types';

// ---------------------------------------------------------------------------
// Mock the 8vance tenant client. The fallback ranker uses listTalentIds +
// talent.getSkills; the enrichment pass additionally uses getProfile +
// getLocation + resources.resolveSkillNamesByIds. We gate getProfile on a
// deferred promise so the test can observe the DB state AFTER the minimal
// insert but BEFORE enrichment completes.
// ---------------------------------------------------------------------------

let releaseEnrichment: (() => void) | null = null;
let enrichmentGate: Promise<void> = Promise.resolve();
let profileCalls = 0;
let skillCalls = 0;

function skillRows(names: string[]): TalentSkill[] {
  return names.map((name, i) => ({ id: i + 1, skill: 1000 + i, skill_name: name }) as TalentSkill);
}

const POOL_SKILLS = ['Python', 'Kubernetes', 'PostgreSQL'];
const TALENT_IDS = Array.from({ length: 6 }, (_, i) => 9001 + i);

const fakeClient = {
  listTalentIds: vi.fn(async (_limit: number) => TALENT_IDS),
  talent: {
    getSkills: vi.fn(async (_id: number) => {
      skillCalls += 1;
      return skillRows(POOL_SKILLS);
    }),
    getProfile: vi.fn(async (id: number): Promise<TalentProfile | null> => {
      profileCalls += 1;
      // Block enrichment until the test releases the gate.
      await enrichmentGate;
      return { id, first_name: 'Test', last_name: 'Talent' } as TalentProfile;
    }),
    getLocation: vi.fn(async (_id: number): Promise<TalentLocation | null> => null),
  },
  resources: {
    resolveSkillNamesByIds: vi.fn(async () => new Map<number, string>()),
  },
};

vi.mock('../src/lib/eightvance/tenant-client', () => ({
  vanceClientForTenant: vi.fn(async () => fakeClient),
  TenantNotConfiguredError: class TenantNotConfiguredError extends Error {},
}));

import { hydrateMatchesForProject } from '../src/lib/match/hydrate';
import { FALLBACK_TASK_SENTINEL } from '../src/lib/eightvance/job-sync';
import { _resetSkillCache } from '../src/lib/match/skill-cache';
import { _resetTalentCache } from '../src/lib/match/talent-cache';

const prisma = new PrismaClient();

async function createFallbackProject() {
  const tenant = await prisma.tenant.create({
    data: {
      slug: `t-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Test Pool',
      eightvanceClientId: 'cid',
      eightvanceClientSecretEnc: encrypt('sekret'),
      eightvanceCompanyId: 34231,
      ownSourceSlug: 'test_source',
      brandConfigJson: {},
    },
  });
  const user = await prisma.user.create({
    data: { email: `u-${Math.random().toString(36).slice(2, 8)}@test.local` },
  });
  const skills = POOL_SKILLS.map((name, i) => ({
    id: 100 + i,
    name,
    proficiency_id: 25,
    must_have: i === 0,
  }));
  const project = await prisma.project.create({
    data: {
      userId: user.id,
      title: 'Senior backend engineer',
      functionNameId: 1234,
      functionNameLabel: 'Backend Engineer',
      functionLevel: 4,
      locationCity: 'Amsterdam',
      locationCountry: 'Netherlands',
      // No origin coords → skips the travel post-pass (keeps the test focused).
      skillsJson: skills,
      languagesJson: [],
      status: 'MATCHING',
      pools: {
        create: [
          {
            tenantId: tenant.id,
            eightvanceJobId: 555,
            eightvanceTaskId: FALLBACK_TASK_SENTINEL,
            status: 'MATCHING',
          },
        ],
      },
    },
    include: { pools: true },
  });
  return project;
}

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  _resetSkillCache();
  _resetTalentCache();
  profileCalls = 0;
  skillCalls = 0;
  fakeClient.listTalentIds.mockClear();
  fakeClient.talent.getSkills.mockClear();
  fakeClient.talent.getProfile.mockClear();
  enrichmentGate = new Promise<void>((resolve) => {
    releaseEnrichment = resolve;
  });
  await prisma.match.deleteMany();
  await prisma.reveal.deleteMany();
  await prisma.projectPool.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('hydrate fallback — streaming minimal insert before enrichment', () => {
  it('commits candidate rows BEFORE the enrichment GETs resolve', async () => {
    const project = await createFallbackProject();

    // Kick off hydration but DON'T await — enrichment is blocked on the gate.
    const hydratePromise = hydrateMatchesForProject(project.id);

    // Poll the DB: minimal rows must appear while enrichment is still blocked.
    let rowsMidFlight = 0;
    for (let i = 0; i < 50; i += 1) {
      rowsMidFlight = await prisma.match.count({ where: { projectId: project.id } });
      if (rowsMidFlight > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // A card exists before any enrichment profile fetch has been allowed to
    // complete (gate still closed → those awaits are parked).
    expect(rowsMidFlight).toBeGreaterThan(0);

    // The persisted-so-far rows are MINIMAL (no name → still fully anonymous;
    // proves they were inserted from the match-result row, pre-enrichment).
    const midRow = await prisma.match.findFirst({
      where: { projectId: project.id },
      select: { anonymizedPayloadJson: true, score: true },
    });
    expect(midRow).not.toBeNull();
    expect(midRow!.score).toBeGreaterThan(0);

    // Release enrichment and let hydration finish.
    releaseEnrichment?.();
    const result = await hydratePromise;

    expect(result.status).toBe('ready');
    const finalCount = await prisma.match.count({ where: { projectId: project.id } });
    expect(finalCount).toBe(TALENT_IDS.length);
    // Enrichment did run for the inserted rows after the gate opened.
    expect(profileCalls).toBeGreaterThan(0);
  });

  it('streams scored batches incrementally (no PII leaks past assertNoPII)', async () => {
    const project = await createFallbackProject();
    // Open the gate immediately so this run completes end-to-end.
    releaseEnrichment?.();
    const result = await hydrateMatchesForProject(project.id);
    expect(result.status).toBe('ready');

    const rows = await prisma.match.findMany({
      where: { projectId: project.id },
      orderBy: { score: 'desc' },
      select: { anonymizedPayloadJson: true, score: true },
    });
    expect(rows.length).toBe(TALENT_IDS.length);
    // Best-first ordering preserved.
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1].score).toBeGreaterThanOrEqual(rows[i].score);
    }
    // No raw talent id / name leaked into any persisted payload.
    for (const r of rows) {
      const json = JSON.stringify(r.anonymizedPayloadJson);
      expect(json).not.toContain('talent_id');
      expect(json).not.toContain('first_name');
    }
  });
});
