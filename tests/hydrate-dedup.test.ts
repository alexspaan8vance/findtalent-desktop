/**
 * Cross-pool dedup tests for the shortlist read path.
 *
 * Run with `npx vitest run tests/hydrate-dedup.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { dedupAcrossPools, type ShortlistMatchRow } from '../src/lib/match/hydrate';
import type { AnonymizedTalent } from '../src/lib/anonymize/types';

function payload(overrides: Partial<AnonymizedTalent> = {}): AnonymizedTalent {
  return {
    opaque_id: 'anon_x',
    score: null,
    function_level: null,
    total_years_experience_bucket: null,
    hours_per_week_bucket: null,
    start_within_days: 'unknown',
    location: { province: '', country: '' },
    skills: [],
    experience: [],
    education: [],
    languages: [],
    ...overrides,
  };
}

function row(
  id: string,
  talentId: number,
  score: number,
  tenantSlug: string,
): ShortlistMatchRow {
  return {
    id,
    eightvanceTalentId: talentId,
    score,
    tenantSlug,
    payload: payload({ opaque_id: `anon_${tenantSlug}_${talentId}` }),
  };
}

describe('dedupAcrossPools', () => {
  it('collapses the same talent across pools to its best-score entry', () => {
    const rows = [
      row('m1', 100, 90, 'pool-a'),
      row('m2', 100, 75, 'pool-b'), // same talent, lower score
      row('m3', 200, 80, 'pool-a'),
    ];
    const out = dedupAcrossPools(rows);
    expect(out).toHaveLength(2);
    const t100 = out.find((r) => r.eightvanceTalentId === 100)!;
    expect(t100.id).toBe('m1'); // kept the higher score
    expect(t100.score).toBe(90);
  });

  it('tags surviving multi-pool rows with all source pools', () => {
    const rows = [
      row('m1', 100, 90, 'pool-a'),
      row('m2', 100, 75, 'pool-b'),
    ];
    const out = dedupAcrossPools(rows);
    expect(out).toHaveLength(1);
    expect(out[0].payload.source_pools?.sort()).toEqual(['pool-a', 'pool-b']);
  });

  it('leaves single-pool rows un-annotated', () => {
    const out = dedupAcrossPools([row('m1', 100, 90, 'pool-a')]);
    expect(out[0].payload.source_pools).toBeUndefined();
  });

  it('preserves first-seen order of surviving rows', () => {
    const rows = [
      row('m1', 300, 50, 'pool-a'),
      row('m2', 100, 90, 'pool-a'),
      row('m3', 100, 95, 'pool-b'), // same talent as m2, higher score
      row('m4', 200, 60, 'pool-a'),
    ];
    const out = dedupAcrossPools(rows);
    expect(out.map((r) => r.eightvanceTalentId)).toEqual([300, 100, 200]);
    // talent 100 collapsed to the higher-scoring m3
    expect(out.find((r) => r.eightvanceTalentId === 100)!.id).toBe('m3');
  });

  it('is a no-op on an empty list', () => {
    expect(dedupAcrossPools([])).toEqual([]);
  });
});
