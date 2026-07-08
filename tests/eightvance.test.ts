import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VanceClient, skillNameCandidates } from '@/lib/eightvance/client';
import { CompanyIdGateError, VanceAuthError, VanceError } from '@/lib/eightvance/errors';
import { invalidateToken } from '@/lib/eightvance/auth';
import { _resetBuckets, acquire } from '@/lib/eightvance/ratelimit';

const BASE = 'https://example.test/public/v1';
const TOKEN_URL = `${BASE}/auth/token/client/`;

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function makeClient(opts: Partial<ConstructorParameters<typeof VanceClient>[0]> = {}) {
  return new VanceClient({
    clientId: 'test-client',
    clientSecret: 'test-secret',
    companyId: 34231,
    baseUrl: BASE,
    allowedCompanyIds: [34231],
    ...opts,
  });
}

beforeEach(() => {
  invalidateToken();
  _resetBuckets();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VanceClient auth + token cache', () => {
  it('caches token across requests for the same client', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) {
        return jsonResponse({ access: 'token-1', refresh: 'r1' });
      }
      return jsonResponse({ id: 1, phrase: 'lvl-1' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const c = makeClient();

    await c.resources.listFunctionLevels();
    await c.resources.listFunctionLevels();

    const tokenCalls = fetchMock.mock.calls.filter((args) => args[0] === TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
  });

  it('refreshes token + retries once on a 401', async () => {
    let tokenCount = 0;
    let dataCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) {
        tokenCount += 1;
        return jsonResponse({ access: `tok-${tokenCount}` });
      }
      dataCount += 1;
      if (dataCount === 1) {
        return new Response(JSON.stringify({ detail: 'unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return jsonResponse({ count: 0, results: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const c = makeClient();

    const res = await c.resources.resolveLocation('Amsterdam');
    expect(res).toBeNull();
    expect(tokenCount).toBe(2);
    expect(dataCount).toBe(2);
  });

  it('throws VanceAuthError on a second 401 after refresh', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) return jsonResponse({ access: 'tok' });
      return new Response(JSON.stringify({ detail: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const c = makeClient();
    await expect(c.resources.resolveLocation('X')).rejects.toBeInstanceOf(VanceAuthError);
  });
});

describe('CompanyIdGate', () => {
  it('blocks responses whose company id is not allow-listed', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) return jsonResponse({ access: 'tok' });
      return jsonResponse({ id: 7, company: 99999, title: 'foreign' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const c = makeClient();
    await expect(c.job.get(7)).rejects.toBeInstanceOf(CompanyIdGateError);
  });

  it('allows configured company ids', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) return jsonResponse({ access: 'tok' });
      return jsonResponse({ id: 1, company: 34231, title: 'ok' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const c = makeClient();
    const job = await c.job.get(1);
    expect(job.company).toBe(34231);
  });

  it('always allows the configured companyId even when allowedCompanyIds is empty', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) return jsonResponse({ access: 'tok' });
      return jsonResponse({ id: 1, company: 34231 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const c = makeClient({ allowedCompanyIds: [] });
    const job = await c.job.get(1);
    expect(job.company).toBe(34231);
  });
});

describe('Retry on 5xx', () => {
  it('retries up to 3 times on 5xx then succeeds', async () => {
    let count = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) return jsonResponse({ access: 'tok' });
      count += 1;
      if (count < 3) {
        return new Response('boom', { status: 502 });
      }
      return jsonResponse({ id: 1, phrase: 'level-1' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const c = makeClient();
    const levels = await c.resources.listFunctionLevels();
    expect(Array.isArray(levels)).toBe(true);
    expect(count).toBe(3);
  });
});

describe('Rate limiter', () => {
  it('serialises acquisitions within a bucket', async () => {
    const order: number[] = [];
    const k = 'test:bucket:fast';
    async function tick(n: number) {
      await acquire(k, { capacity: 10, windowMs: 1_000 });
      order.push(n);
    }
    await Promise.all([tick(1), tick(2), tick(3)]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('skillNameCandidates — broaden a Dutch task phrase to its noun core', () => {
  it('strips a trailing Dutch infinitive to the noun core', () => {
    const c = skillNameCandidates('Elektrische installaties aanleggen');
    expect(c[0]).toBe('Elektrische installaties aanleggen'); // full first
    expect(c).toContain('Elektrische installaties'); // noun core
  });

  it('strips a leading maintenance/repair qualifier (+ van/aan)', () => {
    expect(skillNameCandidates('Onderhoud elektrische apparatuur')).toContain(
      'elektrische apparatuur',
    );
    expect(skillNameCandidates('Reparaties aan elektronica')).toContain('elektronica');
  });

  it('strips the verb on "<noun> assembleren"', () => {
    expect(skillNameCandidates('Elektrische componenten assembleren')).toContain(
      'Elektrische componenten',
    );
  });

  it('keeps a single-word skill as a lone candidate', () => {
    expect(skillNameCandidates('Brazing')).toEqual(['Brazing']);
  });

  it('dedupes and drops <2-char fragments', () => {
    const c = skillNameCandidates('Elektrische testmethodieken');
    expect(new Set(c).size).toBe(c.length);
    expect(c.every((s) => s.length >= 2)).toBe(true);
  });
});

describe('Reference-data locale (?lang=) — FIX B', () => {
  /** Capture every non-token request URL the client makes. */
  function captureUrls(payload: unknown): { urls: string[]; fetchMock: ReturnType<typeof vi.fn> } {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) return jsonResponse({ access: 'tok' });
      urls.push(url);
      return jsonResponse(payload);
    });
    vi.stubGlobal('fetch', fetchMock);
    return { urls, fetchMock };
  }

  it('resolveSkillNamesByIds requests the default app locale (en)', async () => {
    const { urls } = captureUrls({ count: 1, results: [{ id: 101, name: 'Python' }] });
    const c = makeClient();
    const map = await c.resources.resolveSkillNamesByIds([101]);
    expect(map.get(101)).toBe('Python');
    const skillUrl = urls.find((u) => u.includes('/resources/skill/'));
    expect(skillUrl).toBeDefined();
    expect(skillUrl!).toContain('lang=en');
  });

  it('searchSkills sends NO API lang filter (localeDedupe prefers locale, with fallback)', async () => {
    const { urls } = captureUrls({
      count: 1,
      results: [{ id: 5, name: 'Lassen', language_code: 'nl' }],
    });
    const c = makeClient();
    const res = await c.resources.searchSkills('lassen', 5, 'nl');
    const skillUrl = urls.find((u) => u.includes('/resources/skill/'));
    expect(skillUrl).toBeDefined();
    // A name-search must match ALL locales so a Dutch CV term resolves even when
    // the UI locale is en; the API lang filter would defeat localeDedupe's
    // fallback and return 0. Locale preference is applied client-side instead.
    expect(skillUrl!).not.toContain('lang=');
    expect(res[0]?.id).toBe(5);
  });

  it('searchFunctionNames sends NO API lang filter', async () => {
    const { urls } = captureUrls({
      count: 1,
      results: [{ id: 9, name: 'Software Engineer', language_code: 'en' }],
    });
    const c = makeClient();
    await c.resources.searchFunctionNames('engineer', 5);
    const fnUrl = urls.find((u) => u.includes('/resources/function-name/'));
    expect(fnUrl).toBeDefined();
    expect(fnUrl!).not.toContain('lang=');
  });
});

describe('suggestSkills — "+5 more" stays productive with a large exclude set', () => {
  // A deep pool of distinct soft-bucket skills, paginated like the real API.
  // soft_transferrable => classified as the "soft" bucket.
  const POOL = Array.from({ length: 80 }, (_, i) => ({
    id: 1000 + i,
    name: `Soft Skill ${i}`,
    language_code: 'nl',
    extra_data: { soft_transferrable: true },
  }));

  function servePool(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === TOKEN_URL) return jsonResponse({ access: 'tok' });
      const u = new URL(url);
      const pageSize = Number(u.searchParams.get('page_size') ?? '25');
      const page = Number(u.searchParams.get('page') ?? '1');
      const start = (page - 1) * pageSize;
      const slice = POOL.slice(start, start + pageSize);
      const next = start + pageSize < POOL.length ? `${url}&__next` : null;
      return jsonResponse({ count: POOL.length, next, results: slice });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('returns fresh distinct rows for several "+5 more" rounds (large exclude)', async () => {
    servePool();
    const c = makeClient();

    const exclude: number[] = [];
    let rounds = 0;
    // Simulate the wizard: each round excludes everything shown so far and
    // must still get a non-empty distinct batch.
    for (let i = 0; i < 5; i += 1) {
      const g = await c.resources.suggestSkills('Verpleegkundige', 'nl', 5, {
        category: 'soft',
        exclude,
      });
      const batch = g.soft;
      if (batch.length === 0) break;
      // Every returned id must be distinct and NOT already excluded.
      for (const opt of batch) {
        expect(exclude).not.toContain(opt.id);
        exclude.push(opt.id);
      }
      rounds += 1;
    }

    // The button must keep yielding for at least 4 rounds before exhaustion.
    expect(rounds).toBeGreaterThanOrEqual(4);
    // And all collected ids across rounds are unique.
    expect(new Set(exclude).size).toBe(exclude.length);
  });

  it('uses page_size=100 so excluded ids have headroom', async () => {
    const fetchMock = servePool();
    const c = makeClient();
    await c.resources.suggestSkills('Verpleegkundige', 'nl', 5, {
      category: 'soft',
      exclude: [1000, 1001, 1002],
    });
    const skillCall = fetchMock.mock.calls
      .map((a) => String(a[0]))
      .find((u) => u.includes('/resources/skill/'));
    expect(skillCall).toBeDefined();
    expect(skillCall!).toContain('page_size=100');
    expect(skillCall!).toContain('lang=nl');
  });
});

describe('matchJobs.runToCompletion — source failures THROW instead of faking an empty feed', () => {
  // Live incident 2026-07-08: /match/job/ rejected a talent's own listed feed
  // source with 401 "Found invalid sources or not enough privileges". The old
  // code mapped 400/401/403/404/422 to [] — so the run recorded no skip, the
  // per-source count said "0 results", and a 106-job open-market shortlist was
  // silently superseded. These errors must reach executeMatchRun's per-source
  // catch, which records {slug, reason} onto the run.
  it('rejects with VanceAuthError on a persistent 401 (privilege rejection)', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u === TOKEN_URL) return jsonResponse({ access: 'tok' });
      if (u.includes('/match/job/')) {
        return new Response(
          JSON.stringify({ detail: 'Found invalid sources or not enough privileges.' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }
      return jsonResponse({ count: 0, results: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const c = makeClient();

    await expect(
      c.matchJobs.runToCompletion(640701254, ['OnlineVacaturesNL'], {
        filters: { location: { lat: 51.4416, lng: 5.4697, radius: 50, radius_unit: 'km' } },
      }),
    ).rejects.toBeInstanceOf(VanceAuthError);

    // The request layer refresh-replays a 401 exactly once before giving up.
    const matchCalls = fetchMock.mock.calls.filter((a) => String(a[0]).includes('/match/job/'));
    expect(matchCalls).toHaveLength(2);
  });

  it('rejects with VanceError on a 400 (invalid source/body) instead of returning []', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u === TOKEN_URL) return jsonResponse({ access: 'tok' });
      if (u.includes('/match/job/')) {
        return new Response(JSON.stringify({ detail: 'bad request' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return jsonResponse({ count: 0, results: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const c = makeClient();

    await expect(c.matchJobs.runToCompletion(640701254, ['some_source'])).rejects.toBeInstanceOf(
      VanceError,
    );
  });

  it('still resolves rows on success (sync-first path unchanged)', async () => {
    const rows = [
      { id: 1, score: 0.9, job: { id: 101, title: 'Fitter' } },
      { id: 2, score: 0.8, job: { id: 102, title: 'Lasser' } },
      { id: 3, score: 0.7, job: { id: 103, title: 'Monteur' } },
      { id: 4, score: 0.6, job: { id: 104, title: 'Draaier' } },
      { id: 5, score: 0.5, job: { id: 105, title: 'Frezer' } },
      { id: 6, score: 0.4, job: { id: 106, title: 'Bankwerker' } },
    ];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u === TOKEN_URL) return jsonResponse({ access: 'tok' });
      if (u.includes('/match/job/')) return jsonResponse({ count: rows.length, results: rows });
      return jsonResponse({ count: 0, results: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const c = makeClient();

    const out = await c.matchJobs.runToCompletion(640701254, ['OnlineVacaturesNL']);
    expect(out).toHaveLength(6);
  });
});
