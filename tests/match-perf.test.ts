/**
 * Match performance optimisations:
 *  - OPT#2: persistent talent-enrichment cache (talent-cache.ts).
 *  - OPT#1: instant/lazy minimal card anonymity proof (minimalRawFromResult).
 *
 * Run with `npx vitest run tests/match-perf.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  getCachedTalent,
  setCachedTalent,
  _resetTalentCache,
  _talentCacheSize,
} from '../src/lib/match/talent-cache';
import { minimalRawFromResult } from '../src/lib/match/hydrate';
import { anonymize } from '../src/lib/anonymize/talent';
import { assertNoPII } from '../src/lib/anonymize/blocklist';
import type { RawTalent } from '../src/lib/anonymize/types';
import type { MatchResult } from '../src/lib/eightvance/types';

afterEach(() => {
  _resetTalentCache();
});

function rawTalent(overrides: Partial<RawTalent> = {}): RawTalent {
  return {
    id: 777,
    first_name: 'Jan',
    last_name: 'de Vries',
    email: 'jan@example.com',
    phone: '+31 6 12345678',
    function_name: 'Engineer',
    function_level: 4,
    total_years_experience: 7,
    hours_per_week: 40,
    start_date: null,
    score: null,
    location: { city: 'Eindhoven', country: 'Netherlands', province: null },
    skills: [{ skill_id: 1, name: 'Python', proficiency_id: 27 }],
    experience: [],
    education: [],
    languages: [],
    ...overrides,
  };
}

describe('talent-cache (OPT#2)', () => {
  it('round-trips a RawTalent keyed by (tenant, talentId)', () => {
    const t = rawTalent({ id: 101 });
    expect(getCachedTalent('tenant-a', 101)).toBeUndefined();
    setCachedTalent('tenant-a', t);
    expect(getCachedTalent('tenant-a', 101)).toEqual(t);
    expect(_talentCacheSize()).toBe(1);
  });

  it('scopes entries by tenant — one pool never reads another', () => {
    setCachedTalent('tenant-a', rawTalent({ id: 55 }));
    expect(getCachedTalent('tenant-a', 55)).toBeDefined();
    // Same talent id, different tenant → miss.
    expect(getCachedTalent('tenant-b', 55)).toBeUndefined();
  });

  it('does not cache non-finite talent ids', () => {
    setCachedTalent('tenant-a', rawTalent({ id: Number.NaN }));
    expect(_talentCacheSize()).toBe(0);
  });

  it('respects a custom TTL via env (expired entries miss)', () => {
    process.env.TALENT_CACHE_TTL_MS = '1';
    _resetTalentCache();
    try {
      setCachedTalent('tenant-a', rawTalent({ id: 9 }));
      // TTL of 1ms — busy-wait a hair past it, then expect a miss.
      const start = Date.now();
      while (Date.now() - start < 5) {
        /* spin */
      }
      expect(getCachedTalent('tenant-a', 9)).toBeUndefined();
    } finally {
      delete process.env.TALENT_CACHE_TTL_MS;
      _resetTalentCache();
    }
  });
});

describe('minimal/instant card (OPT#1)', () => {
  const HASH = 'test-secret';

  function anonMinimal(row: MatchResult) {
    const raw = minimalRawFromResult(row);
    const anon = anonymize(raw, { tenantId: 't', hashSecret: HASH, jobSkills: [] });
    return { raw, anon };
  }

  it('produces a PII-clean payload from a clean result row', () => {
    const { anon } = anonMinimal({
      talent_id: 1,
      score: 88,
      top_skills: ['Python', 'Kubernetes'],
      location_label: 'Netherlands',
    });
    expect(() => assertNoPII(anon)).not.toThrow();
    expect(anon.score).toBe(88);
    expect(anon.skills.map((s) => s.name)).toEqual(['Python', 'Kubernetes']);
    // proficiency unknown → empty meter, never a fake mid-tier.
    expect(anon.skills.every((s) => s.proficiency_label === '')).toBe(true);
    expect(anon.location.country).toBe('Nederland');
  });

  it('coarsens a street+city label to PROVINCE ONLY (street dropped)', () => {
    // The street part is never resolvable and is dropped; only the known city
    // coarsens to its province. No city/street/coords survive.
    const { raw, anon } = anonMinimal({
      talent_id: 2,
      score: 50,
      top_skills: [],
      location_label: 'Hoofdstraat 1, Eindhoven',
    });
    expect(raw.location?.city ?? null).toBeNull();
    expect(anon.location.province).toBe('Noord-Brabant');
    expect(anon.location.country).toBe('Nederland');
    const json = JSON.stringify(anon);
    expect(json.toLowerCase()).not.toContain('hoofdstraat');
    expect(json.toLowerCase()).not.toContain('eindhoven');
    expect(() => assertNoPII(anon)).not.toThrow();
  });

  it('omits the location entirely for an unrecognised label', () => {
    const { raw, anon } = anonMinimal({
      talent_id: 22,
      score: 50,
      top_skills: [],
      location_label: 'Somerandomvillage 12B',
    });
    expect(raw.location).toBeNull();
    expect(anon.location.province).toBe('');
    // No location → anonymize's missing-location default ('Unknown'), never the
    // raw label. The grid treats 'Unknown' as no-location.
    expect(anon.location.country).toBe('Unknown');
    const json = JSON.stringify(anon);
    expect(json.toLowerCase()).not.toContain('somerandomvillage');
    expect(() => assertNoPII(anon)).not.toThrow();
  });

  it('scrubs name/contact handles smuggled in a top_skill string', () => {
    const { anon } = anonMinimal({
      talent_id: 3,
      score: 10,
      top_skills: ['Referral from jan@example.com', 'React'],
      location_label: null,
    });
    // assertNoPII walks the produced payload and rejects any embedded email.
    expect(() => assertNoPII(anon)).not.toThrow();
  });

  it('omits name, coords and other PII keys entirely', () => {
    const { anon } = anonMinimal({
      talent_id: 4,
      score: 70,
      top_skills: ['SQL'],
      location_label: 'Amsterdam',
    });
    const json = JSON.stringify(anon);
    expect(json).not.toContain('talent_id');
    expect(json).not.toContain('first_name');
    expect(json).not.toContain('latitude');
    expect(() => assertNoPII(anon)).not.toThrow();
  });
});
