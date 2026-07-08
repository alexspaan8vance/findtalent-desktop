/**
 * Per-identity request rate-limiter for the paid CV endpoints
 * (`/api/candidates/extract-skills` + `/api/candidates/parse-cv`).
 *
 * Both endpoints fan out to paid OpenAI / 8vance calls, so we bound how often a
 * single identity can hit them. This is a SLIDING-WINDOW REQUEST counter (count
 * every attempt, not just failures) — distinct from `login-ratelimit.ts`, which
 * counts FAILED password attempts. Same in-memory + optional Upstash Redis
 * graceful-degradation pattern as `login-ratelimit.ts` / `eightvance/ratelimit.ts`:
 * any Redis error is swallowed and we fall back to in-memory-only. Never throws.
 *
 * Identity: a per-user key when authed, else a per-IP key for the unauthed
 * self-onboard / portal path. Build it with `cvRateKey(...)`.
 */

import { getRedis } from '@/lib/eightvance/redis';

/** Requests tolerated per identity inside one sliding window. */
export const CV_RATE_MAX = 10;
/** Sliding window over which requests are counted. */
export const CV_RATE_WINDOW_MS = 60_000; // 10 req / min / identity

interface Window {
  /** Epoch-ms timestamps of recent requests (pruned to the sliding window). */
  hits: number[];
}

const windows = new Map<string, Window>();

function getOrCreate(key: string): Window {
  let w = windows.get(key);
  if (!w) {
    w = { hits: [] };
    windows.set(key, w);
  }
  return w;
}

function prune(w: Window, now: number): void {
  const cutoff = now - CV_RATE_WINDOW_MS;
  if (w.hits.length && w.hits[0] < cutoff) {
    w.hits = w.hits.filter((t) => t >= cutoff);
  }
}

const RL_PREFIX = 'rl:cv:';

/** INCR a fixed-window counter; set TTL on first hit. Null on error/no-redis. */
async function redisIncrWindow(key: string): Promise<number | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const full = `${RL_PREFIX}${key}`;
    const n = await redis.incr(full);
    if (n === 1) await redis.pexpire(full, CV_RATE_WINDOW_MS);
    return n;
  } catch {
    return null;
  }
}

/**
 * Build the limiter key. Authed callers get a per-user key; unauthed (portal /
 * self-onboard) callers fall back to a per-IP key so the public path is still
 * bounded.
 */
export function cvRateKey(identity: { userId?: string | null; ip?: string | null }): string {
  if (identity.userId) return `u:${identity.userId}`;
  const ip = (identity.ip ?? '').trim();
  return `ip:${ip || 'unknown'}`;
}

export interface CvRateResult {
  /** True when the request is within budget and may proceed. */
  allowed: boolean;
  /** Suggested Retry-After in seconds (whole-window backoff) when blocked. */
  retryAfterSec: number;
}

/**
 * Consume one request slot for `key`. Returns `{ allowed }`; when false the
 * caller MUST return 429 with the `retryAfterSec` hint and NOT do the paid work.
 */
export async function consumeCvRate(key: string): Promise<CvRateResult> {
  const now = Date.now();
  const w = getOrCreate(key);
  prune(w, now);
  w.hits.push(now);

  const distCount = await redisIncrWindow(key);
  const localCount = w.hits.length;
  const count = distCount !== null ? Math.max(distCount, localCount) : localCount;

  if (count > CV_RATE_MAX) {
    return { allowed: false, retryAfterSec: Math.ceil(CV_RATE_WINDOW_MS / 1000) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

/** Test/teardown helper — drop all in-memory window state. */
export function _resetCvRate(): void {
  windows.clear();
}
