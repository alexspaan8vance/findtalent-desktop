/**
 * Async token-bucket rate limiter for the 8vance public API.
 *
 * 8vance public bucket is documented at 60/min; we default to 55/min to
 * leave headroom for the n8n workflows that share the same client_id on
 * PROD (see `vance_pipeline.py` rate-limit section).
 *
 * Buckets are partitioned by an arbitrary string key — usage here is
 * `${clientId}:${companyId}:${endpointKey}` (see client.ts) so (a) independent
 * endpoints don't starve each other, (b) a single client_id still respects the
 * global cap, and (c) two white-label tenants that share a clientId but differ
 * by companyId get SEPARATE buckets — one tenant's 429 penalty / counter can't
 * starve another (cross-tenant DoS). The Redis counter (`rl:8vance:{key}`) and
 * penalty (`rlpen:8vance:{key}`) inherit the same tenant-scoped key.
 */

import { getRedis } from "./redis";

interface BucketConfig {
  /** Capacity = tokens issued per `windowMs`. Default 55. */
  capacity: number;
  /** Refill window in ms. Default 60_000 (= 60s). */
  windowMs: number;
}

interface Bucket extends BucketConfig {
  tokens: number;
  /** monotonic-ish epoch ms of the last refill. */
  last: number;
  /** Wall-clock ms until which all acquires must wait (used by 429 penalty). */
  waitUntil: number;
  /** Serial queue: each acquire chains on the previous via this promise. */
  queue: Promise<void>;
}

const DEFAULTS: BucketConfig = { capacity: 55, windowMs: 60_000 };

const buckets = new Map<string, Bucket>();

function getOrCreate(key: string, override?: Partial<BucketConfig>): Bucket {
  let b = buckets.get(key);
  if (b) return b;
  const cfg: BucketConfig = {
    capacity: override?.capacity ?? DEFAULTS.capacity,
    windowMs: override?.windowMs ?? DEFAULTS.windowMs,
  };
  b = {
    ...cfg,
    tokens: cfg.capacity,
    last: Date.now(),
    waitUntil: 0,
    queue: Promise.resolve(),
  };
  buckets.set(key, b);
  return b;
}

function refill(b: Bucket): void {
  const now = Date.now();
  const elapsed = now - b.last;
  if (elapsed <= 0) return;
  const rate = b.capacity / b.windowMs; // tokens per ms
  b.tokens = Math.min(b.capacity, b.tokens + elapsed * rate);
  b.last = now;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// --------------------------------------------------------------------------
// Optional distributed gate (Upstash Redis)
// --------------------------------------------------------------------------
//
// When UPSTASH_REDIS_REST_URL/TOKEN are configured, every acquire ALSO clears
// a fixed-window counter in Redis so that the global cap is honoured across
// ALL server instances sharing a tenant key (clientId:companyId) — not just
// within one process; co-located tenants stay isolated by that key. The
// in-memory token bucket above still runs as the local pacing/serialisation
// layer; Redis is layered on top as a cross-instance backstop.
//
// Degrades gracefully: any Redis error (misconfig, outage, network) is
// swallowed and we fall back to in-memory-only behaviour. Never throws.

const RL_PREFIX = "rl:8vance:";
const PEN_PREFIX = "rlpen:8vance:";

/** Atomic INCR + first-hit EXPIRE; returns the post-incr counter (or null on error). */
async function redisIncrWindow(key: string, windowMs: number): Promise<number | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const full = `${RL_PREFIX}${key}`;
    const n = await redis.incr(full);
    if (n === 1) {
      // First hit in this window — set the TTL so the counter resets.
      await redis.pexpire(full, windowMs);
    }
    return n;
  } catch {
    return null;
  }
}

/** Read the cross-instance penalty deadline (epoch ms), or 0 if none/error. */
async function redisPenaltyUntil(key: string): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const v = await redis.get<string | number>(`${PEN_PREFIX}${key}`);
    if (v === null || v === undefined) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Acquire one token from the bucket identified by `key`. Awaits until a
 * token is available. Acquires within a single bucket are serialised so
 * the token count stays consistent under concurrency.
 */
export async function acquire(
  key: string,
  budget?: Partial<BucketConfig>,
): Promise<void> {
  const b = getOrCreate(key, budget);
  // Chain onto the bucket's serial queue.
  const prev = b.queue;
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  b.queue = prev.then(() => next);
  await prev;
  try {
    // Loop until we can claim a whole token.
    // Reasonable max iterations to avoid runaway.
    for (let i = 0; i < 1000; i++) {
      const now = Date.now();
      // Honour a cross-instance penalty (set by another instance's 429).
      const distPenalty = await redisPenaltyUntil(key);
      if (distPenalty > b.waitUntil) b.waitUntil = distPenalty;
      if (now < b.waitUntil) {
        await sleep(Math.min(b.waitUntil - now, 5_000));
        continue;
      }
      refill(b);
      if (b.tokens >= 1) {
        // Local token available — confirm the GLOBAL window still has room.
        const count = await redisIncrWindow(key, b.windowMs);
        if (count !== null && count > b.capacity) {
          // Global cap hit elsewhere: back off ~one window's worth and retry.
          await sleep(Math.min(b.windowMs / b.capacity, 5_000));
          continue;
        }
        b.tokens -= 1;
        return;
      }
      const rate = b.capacity / b.windowMs;
      const need = 1 - b.tokens;
      const waitMs = Math.max(need / rate, 50);
      await sleep(Math.min(waitMs, 5_000));
    }
  } finally {
    release();
  }
}

/**
 * Push the bucket's `waitUntil` forward — used by callers that hit a 429
 * and want to honour `Retry-After`. Idempotent (never moves backward).
 */
export function penalize(key: string, ms: number): void {
  const b = getOrCreate(key);
  const until = Date.now() + Math.max(0, ms);
  b.waitUntil = Math.max(b.waitUntil, until);
  // Propagate to other instances (best-effort, fire-and-forget).
  const redis = getRedis();
  if (redis) {
    const full = `${PEN_PREFIX}${key}`;
    void redis
      .set(full, String(until), { px: Math.max(1, ms) })
      .catch(() => {
        /* swallow — in-memory penalty already applied */
      });
  }
}

/** Test/teardown helper — drop all bucket state. */
export function _resetBuckets(): void {
  buckets.clear();
}
