/**
 * Function normalizer (v2match) tests.
 * Run with `npx vitest run tests/normalize-fn.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeFunction } from '../src/lib/match/normalize';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.V2MATCH_URL;
});

describe('normalizeFunction', () => {
  it('returns null when V2MATCH_URL is unset', async () => {
    delete process.env.V2MATCH_URL;
    expect(await normalizeFunction('kokkin')).toBeNull();
  });

  it('fails closed (null) on error', async () => {
    process.env.V2MATCH_URL = 'http://127.0.0.1:8802';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await normalizeFunction('kokkin')).toBeNull();
  });

  it('maps a gendered Dutch term to canonical function(s)', async () => {
    process.env.V2MATCH_URL = 'http://127.0.0.1:8802';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      input: 'kokkin',
      canonical: 'Chef cook',
      functions: [
        { label: 'Chef cook', weight: 0.5 },
        { label: '', weight: 0.3 },          // dropped
        { label: 'Cookery assistant', weight: 0.2 },
      ],
    }), { status: 200 })));

    const r = await normalizeFunction('kokkin', 3);
    expect(r).not.toBeNull();
    expect(r!.canonical).toBe('Chef cook');
    expect(r!.functions.map((f) => f.label)).toEqual(['Chef cook', 'Cookery assistant']);
  });

  it('returns null when the service yields no usable functions', async () => {
    process.env.V2MATCH_URL = 'http://127.0.0.1:8802';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      input: 'zzz', canonical: null, functions: [],
    }), { status: 200 })));
    expect(await normalizeFunction('zzz')).toBeNull();
  });
});
