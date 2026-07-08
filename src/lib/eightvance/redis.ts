/**
 * Lazy, optional Upstash Redis singleton.
 *
 * Returns a `@upstash/redis` REST client ONLY when both
 * `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are configured;
 * otherwise returns `null` so callers transparently fall back to in-memory
 * state (single-instance behaviour).
 *
 * Used to make the 8vance rate-limiter (`ratelimit.ts`) and OAuth token cache
 * (`auth.ts`) coherent across multiple server instances behind a load
 * balancer. The REST client is HTTP-based (no socket pool), so a module-scope
 * singleton is safe in serverless and long-lived processes alike.
 *
 * Never throws on construction — a misconfigured client surfaces as a rejected
 * promise on first use, which every caller already swallows / degrades on.
 */

import { Redis } from "@upstash/redis";

let cached: Redis | null | undefined;

export function getRedis(): Redis | null {
  if (cached !== undefined) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    cached = null;
    return cached;
  }
  try {
    cached = new Redis({ url, token });
  } catch {
    cached = null;
  }
  return cached;
}

/** Test helper — drop the cached client so env changes are re-read. */
export function _resetRedis(): void {
  cached = undefined;
}
