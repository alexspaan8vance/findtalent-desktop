import { describe, it, expect } from 'vitest';
import {
  eduTierFromDegree,
  highestEduTier,
  travelDefaultForTier,
  effectiveTravelKm,
  clampTravelKm,
  withTravelDefault,
  MIN_TRAVEL_KM,
  MAX_TRAVEL_KM,
  DEFAULT_TRAVEL_KM,
  type CandidatePreferencesInput,
} from '../src/lib/candidate/preferences';

describe('eduTierFromDegree', () => {
  it('classifies NL taxonomy phrases', () => {
    expect(eduTierFromDegree('MBO 4')).toBe('mbo');
    expect(eduTierFromDegree('HBO Bachelor')).toBe('hbo');
    expect(eduTierFromDegree('HBO Associate degree')).toBe('hbo');
    expect(eduTierFromDegree('WO Master')).toBe('wo');
    expect(eduTierFromDegree('WO Bachelor')).toBe('wo');
    expect(eduTierFromDegree('HAVO')).toBe('secondary');
    expect(eduTierFromDegree('Basisonderwijs')).toBe('basic');
  });
  it('classifies free-text / English degrees', () => {
    expect(eduTierFromDegree('Master of Science')).toBe('wo');
    expect(eduTierFromDegree('Bachelor of Science')).toBe('wo');
    expect(eduTierFromDegree('HBO')).toBe('hbo');
    // An HBO Master stays HBO, not WO, even though "master" appears.
    expect(eduTierFromDegree('HBO Master')).toBe('hbo');
  });
  it('returns null for empty / unknown', () => {
    expect(eduTierFromDegree('')).toBeNull();
    expect(eduTierFromDegree(null)).toBeNull();
    expect(eduTierFromDegree('n/a garble')).toBeNull();
  });
});

describe('highestEduTier', () => {
  it('picks the highest tier across entries', () => {
    expect(
      highestEduTier([{ degree: 'MBO 4' }, { degree: 'WO Master' }, { degree: 'HAVO' }]),
    ).toBe('wo');
    expect(highestEduTier([{ degree: 'MBO 4' }, { degree: 'HBO Bachelor' }])).toBe('hbo');
  });
  it('null for no classifiable education', () => {
    expect(highestEduTier([])).toBeNull();
    expect(highestEduTier(null)).toBeNull();
    expect(highestEduTier([{ degree: 'garble' }])).toBeNull();
  });
});

describe('travel heuristic', () => {
  it('MBO commutes less than HBO/WO ("won\'t drive an hour")', () => {
    const mbo = travelDefaultForTier('mbo');
    const hbo = travelDefaultForTier('hbo');
    const wo = travelDefaultForTier('wo');
    expect(mbo).toBeLessThan(hbo);
    expect(hbo).toBeLessThanOrEqual(wo);
    expect(mbo).toBeLessThan(50); // sub-hour
    expect(hbo).toBeGreaterThan(50); // ~hour+
  });
  it('null tier → global default', () => {
    expect(travelDefaultForTier(null)).toBe(DEFAULT_TRAVEL_KM);
  });
});

describe('clampTravelKm', () => {
  it('clamps into the ES-safe range', () => {
    expect(clampTravelKm(5)).toBe(MIN_TRAVEL_KM);
    expect(clampTravelKm(9999)).toBe(MAX_TRAVEL_KM);
    expect(clampTravelKm(0)).toBe(DEFAULT_TRAVEL_KM);
    expect(clampTravelKm(60)).toBe(60);
  });
});

describe('effectiveTravelKm precedence', () => {
  it('explicit maxTravelKm wins', () => {
    expect(effectiveTravelKm({ maxTravelKm: 40, radiusKm: 200 }, 'wo')).toBe(40);
  });
  it('legacy non-zero radiusKm beats the tier default', () => {
    expect(effectiveTravelKm({ radiusKm: 25 }, 'wo')).toBe(25);
  });
  it('falls back to the education-tier default', () => {
    expect(effectiveTravelKm({ radiusKm: 0 }, 'mbo')).toBe(travelDefaultForTier('mbo'));
    expect(effectiveTravelKm(null, 'hbo')).toBe(travelDefaultForTier('hbo'));
  });
  it('global default when nothing known', () => {
    expect(effectiveTravelKm(null, null)).toBe(DEFAULT_TRAVEL_KM);
  });
});

describe('withTravelDefault', () => {
  const base: CandidatePreferencesInput = {
    sources: [],
    contractTypes: [],
    radiusKm: 0,
    remote: false,
  };
  it('seeds maxTravelKm from the education tier when no radius set', () => {
    const out = withTravelDefault(base, [{ degree: 'HBO Bachelor' }]);
    expect(out.maxTravelKm).toBe(travelDefaultForTier('hbo'));
  });
  it('leaves an explicit preference untouched', () => {
    const out = withTravelDefault({ ...base, maxTravelKm: 33 }, [{ degree: 'WO Master' }]);
    expect(out.maxTravelKm).toBe(33);
    const out2 = withTravelDefault({ ...base, radiusKm: 20 }, [{ degree: 'WO Master' }]);
    expect(out2.maxTravelKm).toBeUndefined();
  });
  it('no-op when education is unclassifiable', () => {
    expect(withTravelDefault(base, [{ degree: 'garble' }]).maxTravelKm).toBeUndefined();
  });
});

import { geocodePlace } from '../src/lib/geo/geocode';
describe('geocodePlace guard', () => {
  it('returns null for empty / too-short input without hitting the network', async () => {
    expect(await geocodePlace('')).toBeNull();
    expect(await geocodePlace(' a ')).toBeNull();
  });
});

import { travelFacetDefaultForTier } from '../src/lib/candidate/preferences';
describe('travelFacetDefaultForTier', () => {
  it('HBO/WO can drive ~an hour by car', () => {
    expect(travelFacetDefaultForTier('hbo')).toEqual({ mode: 'car', max: 'lt60' });
    expect(travelFacetDefaultForTier('wo')).toEqual({ mode: 'car', max: 'lt60' });
  });
  it('MBO / lower default to a short bike ride', () => {
    expect(travelFacetDefaultForTier('mbo')).toEqual({ mode: 'bike', max: 'lt15' });
    expect(travelFacetDefaultForTier('secondary')).toEqual({ mode: 'bike', max: 'lt15' });
  });
  it('null tier → no facet default', () => {
    expect(travelFacetDefaultForTier(null)).toBeNull();
  });
});

import { educationTravelStatement } from '../src/lib/candidate/preferences';
describe('educationTravelStatement', () => {
  it('HBO/WO → car, 60 min, 65/85 km', () => {
    expect(educationTravelStatement('hbo')).toEqual({ km: 65, minutes: 60, mode: 'car' });
    expect(educationTravelStatement('wo')).toEqual({ km: 85, minutes: 60, mode: 'car' });
  });
  it('MBO/lower → bike, 15 min', () => {
    expect(educationTravelStatement('mbo')).toEqual({ km: 35, minutes: 15, mode: 'bike' });
    expect(educationTravelStatement('secondary')).toEqual({ km: 30, minutes: 15, mode: 'bike' });
  });
  it('null tier → null', () => {
    expect(educationTravelStatement(null)).toBeNull();
  });
});
