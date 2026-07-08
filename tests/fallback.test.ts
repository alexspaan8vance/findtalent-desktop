/**
 * Local multi-signal fallback ranker tests.
 *
 * Run with `npx vitest run tests/fallback.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { fallbackMatch, type JobMatchContext, type JobSkillRef } from '../src/lib/match/fallback';
import { _resetSkillCache } from '../src/lib/match/skill-cache';
import { seedTermsFromTitle } from '../src/lib/eightvance/client';
import type {
  TalentEducation,
  TalentLanguage,
  TalentLocation,
  TalentProfile,
  TalentSkill,
} from '../src/lib/eightvance/types';

// ---------------------------------------------------------------------------
// Fake VanceClient
// ---------------------------------------------------------------------------

interface FakeTalent {
  id: number;
  skills: string[];
  location?: TalentLocation | null;
  languages?: string[];
  education?: string[];
  years?: number | null;
}

function skillRows(names: string[]): TalentSkill[] {
  return names.map((name, i) => ({ id: i + 1, skill: 1000 + i, skill_name: name }) as TalentSkill);
}

function makeClient(talents: FakeTalent[]) {
  const byId = new Map(talents.map((t) => [t.id, t]));
  return {
    listTalentIds: async (_limit: number) => talents.map((t) => t.id),
    talent: {
      getSkills: async (id: number) => skillRows(byId.get(id)?.skills ?? []),
      getLocation: async (id: number): Promise<TalentLocation | null> =>
        byId.get(id)?.location ?? null,
      getLanguages: async (id: number): Promise<TalentLanguage[]> =>
        (byId.get(id)?.languages ?? []).map(
          (language_name, i) => ({ id: i + 1, language_name }) as TalentLanguage,
        ),
      getEducation: async (id: number): Promise<TalentEducation[]> =>
        (byId.get(id)?.education ?? []).map(
          (phrase, i) => ({ id: i + 1, degree: { phrase } }) as TalentEducation,
        ),
      getProfile: async (id: number): Promise<TalentProfile | null> => {
        const y = byId.get(id)?.years;
        return y == null ? null : ({ id, total_years_experience: y } as TalentProfile);
      },
    },
  };
}

// The fallback ranker memoises sub-resource fetches per (tenant, talentId).
// These tests reuse talent id 1 with DIFFERENT skills across cases, so the
// cache must be cleared between tests to avoid cross-test bleed. (In prod the
// key includes the real tenantId + a 10-min TTL, so distinct pools/runs stay
// isolated and a re-run within the window is a deliberate cache hit.)
afterEach(() => {
  _resetSkillCache();
});

const SKILLS: JobSkillRef[] = [
  { id: 1, name: 'Python', must_have: true },
  { id: 2, name: 'Kubernetes', must_have: true },
  { id: 3, name: 'PostgreSQL', must_have: false },
];

describe('fallbackMatch — skill overlap', () => {
  it('ranks more skill overlap higher and drops zero-overlap talents', async () => {
    const client = makeClient([
      { id: 1, skills: ['Python', 'Kubernetes', 'PostgreSQL'] }, // all 3
      { id: 2, skills: ['Python'] }, // 1 must-have
      { id: 3, skills: ['Cooking', 'Gardening'] }, // none
    ]);
    const res = await fallbackMatch(client, SKILLS);
    expect(res.map((r) => r.talent_id)).toEqual([1, 2]); // #3 dropped (0)
    expect(res[0].score).toBeGreaterThan(res[1].score!);
  });

  it('is deterministic across runs', async () => {
    const client = makeClient([
      { id: 1, skills: ['Python', 'Kubernetes'] },
      { id: 2, skills: ['PostgreSQL'] },
    ]);
    const a = await fallbackMatch(client, SKILLS);
    const b = await fallbackMatch(client, SKILLS);
    expect(a).toEqual(b);
  });

  it('matches skills fuzzily by token/substring', async () => {
    const client = makeClient([
      { id: 1, skills: ['International project management'] },
    ]);
    const res = await fallbackMatch(client, [
      { id: 1, name: 'Project management', must_have: true },
    ]);
    expect(res).toHaveLength(1);
    expect(res[0].score).toBe(100);
  });
});

describe('fallbackMatch — extra signals', () => {
  it('rewards location proximity (province > country)', async () => {
    const client = makeClient([
      { id: 1, skills: ['Python'], location: { region: 'Noord-Brabant', country: 'Netherlands' } },
      { id: 2, skills: ['Python'], location: { region: 'Holland', country: 'Netherlands' } },
      { id: 3, skills: ['Python'], location: { region: 'Bavaria', country: 'Germany' } },
    ]);
    const ctx: JobMatchContext = {
      location: { province: 'Noord-Brabant', country: 'Netherlands' },
    };
    const res = await fallbackMatch(client, [{ id: 1, name: 'Python', must_have: true }], 25, ctx);
    // #1 (same province) > #2 (same country) > #3 (neither)
    expect(res.map((r) => r.talent_id)).toEqual([1, 2, 3]);
    expect(res[0].score!).toBeGreaterThan(res[1].score!);
    expect(res[1].score!).toBeGreaterThan(res[2].score!);
  });

  it('rewards language match', async () => {
    const client = makeClient([
      { id: 1, skills: ['Python'], languages: ['Dutch', 'English'] },
      { id: 2, skills: ['Python'], languages: ['French'] },
    ]);
    const ctx: JobMatchContext = { languages: ['Dutch', 'English'] };
    const res = await fallbackMatch(client, [{ id: 1, name: 'Python', must_have: true }], 25, ctx);
    const by = new Map(res.map((r) => [r.talent_id, r.score!]));
    expect(by.get(1)!).toBeGreaterThan(by.get(2)!);
  });

  it('rewards matching education level', async () => {
    const client = makeClient([
      { id: 1, skills: ['Python'], education: ['HBO Bachelor'] },
      { id: 2, skills: ['Python'], education: ['MBO'] },
    ]);
    const ctx: JobMatchContext = { educationLevel: 'HBO' };
    const res = await fallbackMatch(client, [{ id: 1, name: 'Python', must_have: true }], 25, ctx);
    const by = new Map(res.map((r) => [r.talent_id, r.score!]));
    expect(by.get(1)!).toBeGreaterThan(by.get(2)!);
  });

  it('rewards meeting the years-of-experience minimum', async () => {
    const client = makeClient([
      { id: 1, skills: ['Python'], years: 8 },
      { id: 2, skills: ['Python'], years: 1 },
    ]);
    const ctx: JobMatchContext = { minYearsExperience: 5 };
    const res = await fallbackMatch(client, [{ id: 1, name: 'Python', must_have: true }], 25, ctx);
    const by = new Map(res.map((r) => [r.talent_id, r.score!]));
    expect(by.get(1)!).toBeGreaterThan(by.get(2)!);
  });

  it('degrades gracefully: absent job signals do not penalise (skills-only == previous behaviour)', async () => {
    const client = makeClient([{ id: 1, skills: ['Python', 'Kubernetes', 'PostgreSQL'] }]);
    const res = await fallbackMatch(client, SKILLS, 25, {});
    expect(res[0].score).toBe(100); // full skill coverage → 100, nothing else weighed
  });

  it('keeps scores bounded to 0..100', async () => {
    const client = makeClient([
      {
        id: 1,
        skills: ['Python', 'Kubernetes', 'PostgreSQL'],
        location: { region: 'Noord-Brabant', country: 'Netherlands' },
        languages: ['Dutch'],
        education: ['WO'],
        years: 20,
      },
    ]);
    const ctx: JobMatchContext = {
      location: { province: 'Noord-Brabant', country: 'Netherlands' },
      languages: ['Dutch'],
      educationLevel: 'WO',
      minYearsExperience: 5,
    };
    const res = await fallbackMatch(client, SKILLS, 25, ctx);
    expect(res[0].score).toBe(100);
  });
});

describe('fallbackMatch — sub-resource caching', () => {
  function countingClient(talents: FakeTalent[]) {
    const byId = new Map(talents.map((t) => [t.id, t]));
    let skillCalls = 0;
    return {
      get skillCalls() {
        return skillCalls;
      },
      client: {
        listTalentIds: async (_limit: number) => talents.map((t) => t.id),
        talent: {
          getSkills: async (id: number) => {
            skillCalls += 1;
            return skillRows(byId.get(id)?.skills ?? []);
          },
        },
      },
    };
  }

  it('re-uses cached skills across re-runs for the same tenant (no re-fetch)', async () => {
    const c = countingClient([
      { id: 1, skills: ['Python', 'Kubernetes'] },
      { id: 2, skills: ['Python'] },
    ]);
    const first = await fallbackMatch(c.client, SKILLS, 25, {}, 'tenant-a');
    expect(c.skillCalls).toBe(2); // cold: one fetch per talent
    const second = await fallbackMatch(c.client, SKILLS, 25, {}, 'tenant-a');
    expect(c.skillCalls).toBe(2); // warm: zero additional fetches
    expect(second).toEqual(first); // identical, deterministic results
  });

  it('does not leak cached rows across tenants', async () => {
    const c = countingClient([{ id: 1, skills: ['Python', 'Kubernetes'] }]);
    await fallbackMatch(c.client, SKILLS, 25, {}, 'tenant-a');
    expect(c.skillCalls).toBe(1);
    await fallbackMatch(c.client, SKILLS, 25, {}, 'tenant-b');
    expect(c.skillCalls).toBe(2); // different tenant → fresh fetch
  });

  it('still produces the same ranking with caching as without', async () => {
    const talents: FakeTalent[] = [
      { id: 1, skills: ['Python', 'Kubernetes', 'PostgreSQL'] },
      { id: 2, skills: ['Python'] },
      { id: 3, skills: ['Cooking'] },
    ];
    const cached = await fallbackMatch(makeClient(talents), SKILLS, 25, {}, 'tenant-x');
    _resetSkillCache();
    const uncached = await fallbackMatch(makeClient(talents), SKILLS, 25, {});
    expect(cached).toEqual(uncached);
  });
});

describe('fallbackMatch — streaming + bounded scan', () => {
  function makeManyTalents(n: number, skills: string[]): FakeTalent[] {
    return Array.from({ length: n }, (_, i) => ({ id: i + 1, skills }));
  }

  it('streams scored batches via onPartial BEFORE returning the full set', async () => {
    const client = makeClient([
      { id: 1, skills: ['Python', 'Kubernetes', 'PostgreSQL'] },
      { id: 2, skills: ['Python'] },
      { id: 3, skills: ['Cooking'] }, // 0 → never streamed
    ]);
    const batches: number[][] = [];
    const final = await fallbackMatch(client, SKILLS, 25, {
      onPartial: (batch) => {
        batches.push(batch.map((r) => r.talent_id));
      },
    });
    // onPartial fired (streaming happened) and emitted only scoring talents.
    expect(batches.length).toBeGreaterThan(0);
    const streamed = batches.flat();
    expect(streamed).toContain(1);
    expect(streamed).toContain(2);
    expect(streamed).not.toContain(3); // zero-score never streamed
    // The streamed union equals the final returned set (minus ordering).
    expect(new Set(streamed)).toEqual(new Set(final.map((r) => r.talent_id)));
  });

  it('emits each batch best-first (score-desc within the batch)', async () => {
    // One chunk (CONCURRENCY=8) so all land in a single batch; #1 (3 skills)
    // must precede #2 (1 skill).
    const client = makeClient([
      { id: 1, skills: ['Python', 'Kubernetes', 'PostgreSQL'] },
      { id: 2, skills: ['Python'] },
    ]);
    const batches: Array<Array<{ id: number; score: number }>> = [];
    await fallbackMatch(client, SKILLS, 25, {
      onPartial: (batch) => {
        batches.push(batch.map((r) => ({ id: r.talent_id, score: r.score ?? 0 })));
      },
    });
    const first = batches[0];
    expect(first[0].score).toBeGreaterThanOrEqual(first[first.length - 1].score);
    expect(first[0].id).toBe(1);
  });

  it('early-exits once earlyExitAfter scoring candidates are found (bounded scan)', async () => {
    // 50 talents all match, but we only fetch skills until 8 have scored. Since
    // a chunk is CONCURRENCY-wide, the scan stops after the first chunk(s) that
    // cross the threshold — well short of all 50 — proving the bound.
    let skillCalls = 0;
    const talents = makeManyTalents(50, ['Python', 'Kubernetes']);
    const byId = new Map(talents.map((t) => [t.id, t]));
    const client = {
      listTalentIds: async (_limit: number) => talents.map((t) => t.id),
      talent: {
        getSkills: async (id: number) => {
          skillCalls += 1;
          return skillRows(byId.get(id)?.skills ?? []);
        },
      },
    };
    const res = await fallbackMatch(client, SKILLS, 25, {
      earlyExitAfter: 8,
      tenantId: 'early-exit-tenant',
    });
    // Found at least the early-exit budget, but did NOT scan all 50.
    expect(res.length).toBeGreaterThanOrEqual(8);
    expect(skillCalls).toBeLessThan(50);
  });

  it('legacy positional (ctx, tenantId) signature still works', async () => {
    const client = makeClient([
      { id: 1, skills: ['Python'], languages: ['Dutch', 'English'] },
      { id: 2, skills: ['Python'], languages: ['French'] },
    ]);
    const ctx: JobMatchContext = { languages: ['Dutch', 'English'] };
    const res = await fallbackMatch(
      client,
      [{ id: 1, name: 'Python', must_have: true }],
      25,
      ctx,
      'legacy-tenant',
    );
    const by = new Map(res.map((r) => [r.talent_id, r.score!]));
    expect(by.get(1)!).toBeGreaterThan(by.get(2)!);
  });
});

describe('seedTermsFromTitle — skill-seed tokenizer', () => {
  it('preserves .NET verbatim instead of mangling to "net"', () => {
    const terms = seedTermsFromTitle('.NET Developer');
    expect(terms).toContain('.NET');
    expect(terms).not.toContain('net');
  });

  it('keeps C# and C++ which the old length filter dropped', () => {
    expect(seedTermsFromTitle('C# Engineer')).toContain('C#');
    expect(seedTermsFromTitle('C++ Programmer')).toContain('C++');
  });

  it('drops generic role/seniority stopwords', () => {
    const terms = seedTermsFromTitle('Senior Backend Engineer');
    expect(terms).not.toContain('Senior');
    expect(terms).not.toContain('senior');
    expect(terms.map((t) => t.toLowerCase())).toContain('backend');
  });

  it('does not blind-truncate long tokens', () => {
    expect(seedTermsFromTitle('JavaScript Developer')).toContain('JavaScript');
  });

  it('surfaces tech tokens first', () => {
    const terms = seedTermsFromTitle('Node.js Backend Developer');
    expect(terms[0]).toBe('Node.js');
  });
});
