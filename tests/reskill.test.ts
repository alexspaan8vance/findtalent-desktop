/**
 * Reskill / career-path (v2match) tests.
 * Run with `npx vitest run tests/reskill.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { reskillPaths } from '../src/lib/match/reskill';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.V2MATCH_URL;
});

describe('reskillPaths', () => {
  it('returns null when V2MATCH_URL is unset', async () => {
    delete process.env.V2MATCH_URL;
    expect(await reskillPaths('welder')).toBeNull();
  });

  it('fails closed (null) on error', async () => {
    process.env.V2MATCH_URL = 'http://127.0.0.1:8802';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await reskillPaths('welder')).toBeNull();
  });

  it('parses neighbors + skill-gap and drops malformed entries', async () => {
    process.env.V2MATCH_URL = 'http://127.0.0.1:8802';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      from: 'Welder-fabricator',
      neighbors: [
        { label: 'Welding foreman', cosine: 0.99, learn: [{ cluster: 'Construction, Mechanical', gap: 0.4 }] },
        { label: '', cosine: 0.5, learn: [] },               // dropped (no label)
        { label: 'Fabricator welder', cosine: 'x', learn: 'y' }, // cosine→0, learn→[]
      ],
    }), { status: 200 })));

    const r = await reskillPaths('lasser', 5);
    expect(r).not.toBeNull();
    expect(r!.from).toBe('Welder-fabricator');
    expect(r!.neighbors.map((n) => n.label)).toEqual(['Welding foreman', 'Fabricator welder']);
    expect(r!.neighbors[0].learn[0]).toEqual({ cluster: 'Construction, Mechanical', gap: 0.4 });
    expect(r!.neighbors[1].cosine).toBe(0);
    expect(r!.neighbors[1].learn).toEqual([]);
  });
});
