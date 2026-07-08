/**
 * OV (public-transport) travel provider — env-gated selection tests.
 *
 * We do NOT hit live Google / OTP here. We only verify the wiring:
 *   - `isOvConfigured()` reflects the two env vars.
 *   - `ovProvider()` returns a null-matrix provider when neither env is set
 *     (so OV stays null → chip hidden), and picks Google over OTP otherwise.
 *   - The null provider returns all-null of the right length.
 *
 * Run with `npx vitest run tests/travel-ov.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _clearTravelCache,
  computeTravelBucketsMatrix,
  isOvConfigured,
  ovProvider,
} from '../src/lib/travel';
import { googleProvider } from '../src/lib/travel/google';
import { otpProvider, _resetOtpDialect } from '../src/lib/travel/otp';

const ENV_KEYS = ['GOOGLE_MAPS_API_KEY', 'OTP_GRAPHQL_URL', 'OTP_BBOX'] as const;

function snapshot(): Record<string, string | undefined> {
  const s: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) s[k] = process.env[k];
  return s;
}
function restore(s: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (s[k] === undefined) delete process.env[k];
    else process.env[k] = s[k];
  }
}

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = snapshot();
  for (const k of ENV_KEYS) delete process.env[k];
  _clearTravelCache();
});
afterEach(() => {
  restore(saved);
  _clearTravelCache();
});

const ORIGIN = { lat: 52.0907, lng: 5.1214 }; // Utrecht
const DEST = { lat: 52.3676, lng: 4.9041 }; // Amsterdam

describe('isOvConfigured', () => {
  it('false when neither env is set', () => {
    expect(isOvConfigured()).toBe(false);
  });

  it('true when GOOGLE_MAPS_API_KEY is set', () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    expect(isOvConfigured()).toBe(true);
  });

  it('true when OTP_GRAPHQL_URL is set', () => {
    process.env.OTP_GRAPHQL_URL = 'http://localhost:8080/otp/gtfs/v1';
    expect(isOvConfigured()).toBe(true);
  });
});

describe('ovProvider selection', () => {
  it('returns a null-matrix provider when neither env is set', async () => {
    const p = ovProvider();
    const row = await p.matrix(ORIGIN, [DEST, DEST, DEST], 'ov');
    expect(row).toEqual([null, null, null]);
  });

  it('returns Google provider when GOOGLE_MAPS_API_KEY is set (preferred)', () => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    process.env.OTP_GRAPHQL_URL = 'http://localhost:8080/otp/gtfs/v1';
    // Identity check via module reference.
    expect(ovProvider()).toBe(googleProvider);
  });

  it('returns OTP provider when only OTP_GRAPHQL_URL is set', () => {
    process.env.OTP_GRAPHQL_URL = 'http://localhost:8080/otp/gtfs/v1';
    expect(ovProvider()).toBe(otpProvider);
  });
});

describe('otpProvider — GraphQL dialect auto-detection', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    _resetOtpDialect();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('falls back to the legacy `plan` query when modern `planConnection` errors', async () => {
    process.env.OTP_GRAPHQL_URL = 'http://otp:8080/otp/gtfs/v1';
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      const body = init?.body ?? '';
      bodies.push(body);
      // First call uses the modern planConnection query → reply with a GraphQL
      // error (as an OTP that doesn't support it would). Second call is legacy.
      if (body.includes('planConnection')) {
        return {
          ok: true,
          json: async () => ({ errors: [{ message: "Unknown field 'planConnection'" }] }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ data: { plan: { itineraries: [{ duration: 1920 }] } } }),
      } as Response;
    }) as typeof fetch;

    const row = await otpProvider.matrix(ORIGIN, [DEST], 'ov');
    expect(row).toEqual([1920]);
    // Proves it tried modern first, then legacy.
    expect(bodies.some((b) => b.includes('planConnection'))).toBe(true);
    expect(bodies.some((b) => b.includes('transportModes'))).toBe(true);
  });

  it('reads modern planConnection edges when supported', async () => {
    process.env.OTP_GRAPHQL_URL = 'http://otp:8080/otp/gtfs/v1';
    globalThis.fetch = (async () =>
      ({
        ok: true,
        json: async () => ({
          data: { planConnection: { edges: [{ node: { duration: 1920 } }] } },
        }),
      }) as Response) as typeof fetch;

    const row = await otpProvider.matrix(ORIGIN, [DEST], 'ov');
    expect(row).toEqual([1920]);
  });
});

describe('computeTravelBucketsMatrix — OV coverage bbox guard', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    _resetOtpDialect();
  });

  const NL_DEST = { lat: 52.3676, lng: 4.9041 }; // Amsterdam (inside NL bbox)
  // Frankfurt — lng 8.68 is east of the NL bbox max (7.30), so clearly outside.
  const DE_DEST = { lat: 50.1109, lng: 8.6821 };

  it('calls the OV provider for a dest INSIDE the NL bbox → non-null bucket', async () => {
    process.env.OTP_GRAPHQL_URL = 'http://otp:8080/otp/gtfs/v1';
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return {
        ok: true,
        json: async () => ({
          data: { planConnection: { edges: [{ node: { duration: 1800 } }] } },
        }),
      } as Response;
    }) as typeof fetch;

    const out = await computeTravelBucketsMatrix(ORIGIN, [NL_DEST], ['ov']);
    expect(called).toBeGreaterThan(0);
    expect(out[0].ov).not.toBeNull();
  });

  it('returns ov null for a dest OUTSIDE the bbox WITHOUT calling fetch', async () => {
    process.env.OTP_GRAPHQL_URL = 'http://otp:8080/otp/gtfs/v1';
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return { ok: true, json: async () => ({ data: {} }) } as Response;
    }) as typeof fetch;

    const out = await computeTravelBucketsMatrix(ORIGIN, [DE_DEST], ['ov']);
    expect(called).toBe(0);
    expect(out[0].ov).toBeNull();
  });

  it('skips only the out-of-box dest in a mixed batch (NL still hits provider)', async () => {
    process.env.OTP_GRAPHQL_URL = 'http://otp:8080/otp/gtfs/v1';
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return {
        ok: true,
        json: async () => ({
          data: { planConnection: { edges: [{ node: { duration: 1800 } }] } },
        }),
      } as Response;
    }) as typeof fetch;

    const out = await computeTravelBucketsMatrix(ORIGIN, [NL_DEST, DE_DEST], ['ov']);
    // Exactly one provider call (the NL dest); the DE dest never hit fetch.
    expect(called).toBe(1);
    expect(out[0].ov).not.toBeNull();
    expect(out[1].ov).toBeNull();
  });

  it('respects an OTP_BBOX env override', async () => {
    // Tight box around Amsterdam only — Utrecht ORIGIN now falls OUTSIDE it,
    // so origin-out-of-box short-circuits ALL ov to null with no fetch.
    process.env.OTP_GRAPHQL_URL = 'http://otp:8080/otp/gtfs/v1';
    process.env.OTP_BBOX = '52.30,4.85,52.42,4.95';
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return { ok: true, json: async () => ({ data: {} }) } as Response;
    }) as typeof fetch;

    const out = await computeTravelBucketsMatrix(ORIGIN, [NL_DEST], ['ov']);
    expect(called).toBe(0);
    expect(out[0].ov).toBeNull();
  });

  it('garbled OTP_BBOX falls back to the NL default (NL dest still computed)', async () => {
    process.env.OTP_GRAPHQL_URL = 'http://otp:8080/otp/gtfs/v1';
    process.env.OTP_BBOX = 'not,a,valid,box,x';
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return {
        ok: true,
        json: async () => ({
          data: { planConnection: { edges: [{ node: { duration: 1800 } }] } },
        }),
      } as Response;
    }) as typeof fetch;

    const out = await computeTravelBucketsMatrix(ORIGIN, [NL_DEST], ['ov']);
    expect(called).toBeGreaterThan(0);
    expect(out[0].ov).not.toBeNull();
  });
});

describe('computeTravelBucketsMatrix — ov stays null when unconfigured', () => {
  it('ov bucket is null (NOT a Haversine estimate) when no OV source is set', async () => {
    const out = await computeTravelBucketsMatrix(ORIGIN, [DEST], ['ov']);
    expect(out).toHaveLength(1);
    expect(out[0].ov).toBeNull();
  });

  it('omits ov entirely when only car/bike are requested', async () => {
    const out = await computeTravelBucketsMatrix(ORIGIN, [DEST], ['car', 'bike']);
    expect(out[0]).not.toHaveProperty('ov');
  });
});
