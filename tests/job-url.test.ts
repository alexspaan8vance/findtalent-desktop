import { describe, it, expect } from 'vitest';

import { slugify, readableVacancyUrl } from '../src/lib/job-url';

describe('slugify', () => {
  it('lowercases, strips accents, collapses non-alphanumerics', () => {
    expect(slugify('Field Service Engineer Raum Dresden')).toBe(
      'field-service-engineer-raum-dresden',
    );
    expect(slugify('CNC Draaier')).toBe('cnc-draaier');
    expect(slugify('Café / Über—test!')).toBe('cafe-uber-test');
  });
});

describe('readableVacancyUrl', () => {
  it('builds the tjellens career-page URL from jobId + title (verified live)', () => {
    expect(
      readableVacancyUrl(
        961661806,
        'Field Service Engineer Raum Dresden',
        'https://www.tjellens.nl',
      ),
    ).toBe('https://tjellens.nl/vacature/961661806-field-service-engineer-raum-dresden/');
  });
  it('accepts the directApply public_url as the host signal', () => {
    expect(
      readableVacancyUrl(485542625, 'CNC Draaier', 'http://www.tjellens.nl?vacancyId=93606'),
    ).toBe('https://tjellens.nl/vacature/485542625-cnc-draaier/');
  });
  it('returns null for an unsupported host', () => {
    expect(readableVacancyUrl(123, 'X', 'https://randstad.nl')).toBeNull();
  });
  it('returns null on missing title / bad jobId / bad website', () => {
    expect(readableVacancyUrl(0, 'X', 'https://tjellens.nl')).toBeNull();
    expect(readableVacancyUrl(123, '', 'https://tjellens.nl')).toBeNull();
    expect(readableVacancyUrl(123, 'X', 'not-a-url')).toBeNull();
    expect(readableVacancyUrl(123, 'X', null)).toBeNull();
  });
});
