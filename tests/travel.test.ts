/**
 * Travel-time backend tests.
 *
 *  - `secondsToBucket` boundary behaviour (≥15-min granularity, null cases).
 *  - `haversine.estimateSeconds` distance→duration + edge cases.
 *  - `assertNoPII` PASSES on an AnonymizedTalent carrying a `travel` field of
 *    bucket strings, but THROWS if a raw `latitude` is smuggled under it.
 *
 * Run with `npx vitest run tests/travel.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { assertNoPII, PIILeakError } from '../src/lib/anonymize/blocklist';
import type { AnonymizedTalent } from '../src/lib/anonymize/types';
import { BUCKET_RANK, bucketRank, secondsToBucket } from '../src/lib/travel/bucketize';
import { estimateSeconds, haversineKm } from '../src/lib/travel/haversine';

// ---------------------------------------------------------------------------
// secondsToBucket
// ---------------------------------------------------------------------------

describe('secondsToBucket', () => {
  it('maps below each 15-min boundary into the correct bucket', () => {
    expect(secondsToBucket(0)).toBe('lt15');
    expect(secondsToBucket(899)).toBe('lt15'); // < 900
    expect(secondsToBucket(900)).toBe('lt30'); // boundary is exclusive at lt15
    expect(secondsToBucket(1799)).toBe('lt30');
    expect(secondsToBucket(1800)).toBe('lt45');
    expect(secondsToBucket(2699)).toBe('lt45');
    expect(secondsToBucket(2700)).toBe('lt60');
    expect(secondsToBucket(3599)).toBe('lt60');
    expect(secondsToBucket(3600)).toBe('gt60');
    expect(secondsToBucket(99999)).toBe('gt60');
  });

  it('returns null for null/NaN/non-finite', () => {
    expect(secondsToBucket(null)).toBeNull();
    expect(secondsToBucket(NaN)).toBeNull();
    expect(secondsToBucket(Infinity)).toBeNull();
    // @ts-expect-error guard against runtime undefined slipping in
    expect(secondsToBucket(undefined)).toBeNull();
  });

  it('clamps negatives into lt15', () => {
    expect(secondsToBucket(-10)).toBe('lt15');
  });

  it('BUCKET_RANK orders ascending with null last', () => {
    expect(BUCKET_RANK.lt15).toBeLessThan(BUCKET_RANK.lt30);
    expect(BUCKET_RANK.lt30).toBeLessThan(BUCKET_RANK.lt45);
    expect(BUCKET_RANK.lt45).toBeLessThan(BUCKET_RANK.lt60);
    expect(BUCKET_RANK.lt60).toBeLessThan(BUCKET_RANK.gt60);
    expect(BUCKET_RANK.gt60).toBeLessThan(BUCKET_RANK.null);
    expect(bucketRank(null)).toBe(BUCKET_RANK.null);
    expect(bucketRank('lt15')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// haversine.estimateSeconds + haversineKm
// ---------------------------------------------------------------------------

describe('haversine', () => {
  it('haversineKm returns ~0 for identical points', () => {
    expect(haversineKm({ lat: 52.0, lng: 5.0 }, { lat: 52.0, lng: 5.0 })).toBeCloseTo(0, 5);
  });

  it('haversineKm is roughly correct (Amsterdam→Rotterdam ≈ 57km)', () => {
    const km = haversineKm({ lat: 52.3676, lng: 4.9041 }, { lat: 51.9244, lng: 4.4777 });
    expect(km).toBeGreaterThan(50);
    expect(km).toBeLessThan(65);
  });

  it('haversineKm returns NaN on non-finite coords', () => {
    expect(Number.isNaN(haversineKm({ lat: NaN, lng: 5 }, { lat: 52, lng: 5 }))).toBe(true);
  });

  it('estimateSeconds: car ~50km/h → 1 hour for 50km', () => {
    const s = estimateSeconds(50, 'car');
    expect(s).not.toBeNull();
    expect(s!).toBeCloseTo(3600, 0);
    // 50km by car bucketizes to exactly gt60? 3600 → gt60 boundary.
    expect(secondsToBucket(s)).toBe('gt60');
  });

  it('estimateSeconds: bike ~15km/h → 12 min for 3km (lt15)', () => {
    const s = estimateSeconds(3, 'bike');
    expect(s).not.toBeNull();
    expect(s!).toBeCloseTo((3 / 15) * 3600, 0); // 720s
    expect(secondsToBucket(s)).toBe('lt15');
  });

  it('estimateSeconds returns null for NaN/negative distance', () => {
    expect(estimateSeconds(NaN, 'car')).toBeNull();
    expect(estimateSeconds(-5, 'car')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// assertNoPII safety for the travel field
// ---------------------------------------------------------------------------

function makeAnon(travel: unknown): AnonymizedTalent {
  return {
    opaque_id: 'anon_deadbeefdeadbeef',
    score: 88,
    function_level: 3,
    total_years_experience_bucket: '5-10',
    hours_per_week_bucket: 'FT',
    start_within_days: 'now',
    location: { province: 'Utrecht', country: 'NL' },
    skills: [],
    experience: [],
    education: [],
    languages: [],
    travel: travel as AnonymizedTalent['travel'],
  };
}

describe('assertNoPII + travel field', () => {
  it('PASSES when travel carries only bucket strings under car/bike/ov keys', () => {
    const ok = makeAnon({ car: 'lt30', bike: 'lt60', ov: null });
    expect(() => assertNoPII(ok)).not.toThrow();
  });

  it('PASSES with a single mode', () => {
    expect(() => assertNoPII(makeAnon({ car: 'lt30' }))).not.toThrow();
  });

  it('THROWS if someone smuggles a raw latitude under travel', () => {
    const leak = makeAnon({ car: 'lt30', latitude: 52.0901 });
    expect(() => assertNoPII(leak)).toThrow(PIILeakError);
  });

  it('THROWS on lng/lon/longitude too', () => {
    expect(() => assertNoPII(makeAnon({ lng: 5.1 }))).toThrow(PIILeakError);
    expect(() => assertNoPII(makeAnon({ lon: 5.1 }))).toThrow(PIILeakError);
    expect(() => assertNoPII(makeAnon({ longitude: 5.1 }))).toThrow(PIILeakError);
  });
});
