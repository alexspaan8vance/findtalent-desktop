import { describe, it, expect, beforeEach } from 'vitest';

import { acquire, penalize, _resetBuckets } from '../src/lib/eightvance/ratelimit';

// These tests run with Upstash UNSET (default), exercising the in-memory
// token-bucket behaviour. getRedis() returns null, so the distributed gate is
// a no-op and the limiter behaves exactly as the single-instance limiter.

describe('ratelimit in-memory bucket', () => {
  beforeEach(() => {
    _resetBuckets();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it('grants tokens up to capacity without blocking', async () => {
    const key = 'test:fast';
    const start = Date.now();
    // capacity 5, generous window — all 5 should be near-instant.
    for (let i = 0; i < 5; i++) {
      await acquire(key, { capacity: 5, windowMs: 60_000 });
    }
    const elapsed = Date.now() - start;
    // 5 immediate grants should be well under a refill interval.
    expect(elapsed).toBeLessThan(1_000);
  });

  it('throttles once the bucket is drained (6th acquire waits for a refill)', async () => {
    const key = 'test:drain';
    // capacity 2 over 200ms → ~10ms per token refill once drained.
    const cfg = { capacity: 2, windowMs: 200 };
    await acquire(key, cfg);
    await acquire(key, cfg);
    const t0 = Date.now();
    await acquire(key, cfg); // must wait for a partial refill
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(40); // refill of 1 token ≈ 100ms
  });

  it('penalize() forces subsequent acquires to wait until the deadline', async () => {
    const key = 'test:penalty';
    const cfg = { capacity: 100, windowMs: 60_000 }; // tokens never the bottleneck
    penalize(key, 120);
    const t0 = Date.now();
    await acquire(key, cfg);
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(80);
  });

  it('penalize() never moves the deadline backward (idempotent max)', async () => {
    const key = 'test:penalty2';
    penalize(key, 1_000);
    penalize(key, 10); // smaller — should NOT shorten the wait
    const cfg = { capacity: 100, windowMs: 60_000 };
    const t0 = Date.now();
    // Race the acquire against a 200ms timer: it must still be waiting on the
    // 1s penalty, so the timer wins.
    const winner = await Promise.race([
      acquire(key, cfg).then(() => 'acquired'),
      new Promise<string>((r) => setTimeout(() => r('timeout'), 200)),
    ]);
    expect(winner).toBe('timeout');
    void t0;
  });

  it('serialises concurrent acquires on the same key (count stays consistent)', async () => {
    const key = 'test:concurrent';
    const cfg = { capacity: 3, windowMs: 60_000 };
    // Fire 3 concurrent acquires; all should resolve (capacity == 3).
    await Promise.all([
      acquire(key, cfg),
      acquire(key, cfg),
      acquire(key, cfg),
    ]);
    // A 4th should now have to wait (bucket empty in this window).
    const winner = await Promise.race([
      acquire(key, cfg).then(() => 'acquired'),
      new Promise<string>((r) => setTimeout(() => r('timeout'), 150)),
    ]);
    expect(winner).toBe('timeout');
  });
});
