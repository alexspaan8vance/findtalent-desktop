/**
 * In-memory OAuth2 client_credentials token cache for 8vance.
 *
 * Token endpoint: `POST {baseUrl}/auth/token/client/` with JSON body
 * `{client_id, client_secret}`. Response shape: `{access, refresh?}` —
 * JWT lifetime is 10min on PROD; we refresh at ~8min (TTL_MS) so a
 * request in-flight never sees an expiring token.
 *
 * Concurrent callers serialise on a per-client promise (double-checked
 * inside the awaited refresh) so we issue at most one refresh per expiry.
 */

import { createHash } from "node:crypto";

import { VanceAuthError } from "./errors";
import { getRedis } from "./redis";
import type { TokenResponse } from "./types";
import { redact } from "./util";

const TTL_MS = 8 * 60 * 1000; // 10min JWT - 2min margin

// --------------------------------------------------------------------------
// Tenant-scoped cache keys (multi-pool / white-label safety)
// --------------------------------------------------------------------------
//
// A clientId is NOT a tenant identity: the product is multi-pool/white-label
// and the schema does not enforce uniqueness on eightvanceClientId, so two
// tenants CAN share a clientId with a different companyId/secret. Keying the
// token cache by clientId alone would (a) let invalidateToken() on one tenant's
// 401 wipe every co-located tenant's token, and (b) let a token minted as
// tenant A be replayed by tenant B (cross-tenant pool access). So every cache
// key is scoped by a tenant discriminator in addition to clientId.
//
// The discriminator is the non-secret companyId where the caller has it
// (always true on the request path). When only the secret is in scope we derive
// a short, NON-REVERSIBLE tag from it — the raw clientSecret NEVER appears in a
// key, log, or Redis value.

/** Short non-reversible tag from the clientSecret (never the raw secret). */
export function secretTag(clientSecret: string): string {
  return createHash("sha256").update(clientSecret).digest("hex").slice(0, 16);
}

/**
 * Build the tenant-scoped cache key. `discriminator` is the companyId (preferred)
 * or a `secretTag(...)`; callers must pass a stable, non-secret value.
 */
function cacheKey(clientId: string, discriminator: string | number): string {
  return `${clientId}:${discriminator}`;
}

// --------------------------------------------------------------------------
// Optional cross-instance token sharing (Upstash Redis)
// --------------------------------------------------------------------------
//
// When Upstash is configured, a freshly-minted access token is mirrored into
// Redis (TTL = our refresh margin) so a cold instance can reuse a token that
// another instance already obtained, instead of issuing its own refresh. The
// in-memory cache stays the fast path; Redis is a best-effort backstop and any
// error degrades silently to per-instance behaviour. Refresh tokens are NOT
// stored in Redis (no need; we always re-mint via client_credentials).

const REDIS_TOKEN_PREFIX = "8vtok:";

interface RedisToken {
  access: string;
  expEpochMs: number;
}

// `cacheKey` below is the composite `${clientId}:${discriminator}` — so the
// Redis token key is `8vtok:{clientId}:{companyId}` (tenant-scoped), never just
// `8vtok:{clientId}`.
async function redisGetToken(cacheKey: string): Promise<RedisToken | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const v = await redis.get<RedisToken>(`${REDIS_TOKEN_PREFIX}${cacheKey}`);
    if (v && typeof v.access === "string" && typeof v.expEpochMs === "number") {
      return v;
    }
    return null;
  } catch {
    return null;
  }
}

function redisSetToken(cacheKey: string, tok: RedisToken): void {
  const redis = getRedis();
  if (!redis) return;
  const ttlMs = tok.expEpochMs - Date.now();
  if (ttlMs <= 0) return;
  void redis
    .set(`${REDIS_TOKEN_PREFIX}${cacheKey}`, tok, { px: ttlMs })
    .catch(() => {
      /* swallow — in-memory cache already holds the token */
    });
}

function redisDelToken(cacheKey?: string): void {
  const redis = getRedis();
  if (!redis || cacheKey === undefined) return; // can't pattern-delete cheaply
  void redis.del(`${REDIS_TOKEN_PREFIX}${cacheKey}`).catch(() => {
    /* swallow */
  });
}

interface CacheEntry {
  access: string;
  refresh?: string;
  expEpochMs: number;
  /** In-flight refresh promise (deduped across concurrent callers). */
  inflight?: Promise<string>;
}

const cache = new Map<string, CacheEntry>();

async function doRefresh(
  key: string,
  clientId: string,
  clientSecret: string,
  baseUrl: string,
): Promise<string> {
  if (!clientId || !clientSecret) {
    throw new VanceAuthError("/auth/token/client/", 0, "client_id/secret not configured");
  }
  const url = `${baseUrl.replace(/\/$/, "")}/auth/token/client/`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    });
  } catch (err) {
    throw new VanceAuthError("/auth/token/client/", 0, String(err));
  }
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch {
    payload = null;
  }
  if (!resp.ok) {
    throw new VanceAuthError("/auth/token/client/", resp.status, redact(payload));
  }
  const token = payload as Partial<TokenResponse>;
  if (!token || typeof token.access !== "string") {
    throw new VanceAuthError("/auth/token/client/", resp.status, redact(payload));
  }
  const entry: CacheEntry = {
    access: token.access,
    refresh: typeof token.refresh === "string" ? token.refresh : undefined,
    expEpochMs: Date.now() + TTL_MS,
  };
  cache.set(key, entry);
  redisSetToken(key, { access: entry.access, expEpochMs: entry.expEpochMs });
  return entry.access;
}

/**
 * Return a valid access token for `(clientId, discriminator)`, refreshing if
 * the cached value is missing or expired.
 *
 * `discriminator` should be a stable, non-secret tenant identity — the companyId
 * (preferred) — so two tenants sharing a clientId never share a token. When the
 * caller has no companyId in scope (e.g. the health probe), it may be omitted
 * and we derive a non-reversible tag from the secret instead. NEVER pass the
 * raw secret as the discriminator.
 */
export async function getToken(
  clientId: string,
  clientSecret: string,
  baseUrl: string,
  discriminator?: string | number,
  opts?: { force?: boolean },
): Promise<string> {
  const disc = discriminator ?? secretTag(clientSecret);
  const key = cacheKey(clientId, disc);
  const force = opts?.force === true;
  const existing = cache.get(key);
  if (!force && existing && existing.access && Date.now() < existing.expEpochMs) {
    return existing.access;
  }
  // Dedup concurrent refreshes per (clientId, discriminator) — genuinely-same
  // creds coalesce; different companies use different keys and don't.
  if (existing?.inflight) return existing.inflight;

  // Before minting a new token, check whether another instance already has a
  // live one in the shared cache (best-effort; null when Upstash is off).
  if (!force) {
    const shared = await redisGetToken(key);
    if (shared && shared.access && Date.now() < shared.expEpochMs) {
      cache.set(key, { access: shared.access, expEpochMs: shared.expEpochMs });
      return shared.access;
    }
  }

  const inflight = doRefresh(key, clientId, clientSecret, baseUrl).finally(() => {
    const cur = cache.get(key);
    if (cur) cur.inflight = undefined;
  });
  // Stash inflight onto a placeholder entry so concurrent callers find it.
  const placeholder: CacheEntry = existing ?? {
    access: "",
    expEpochMs: 0,
    inflight,
  };
  placeholder.inflight = inflight;
  cache.set(key, placeholder);
  return inflight;
}

/**
 * Drop the cached token for one tenant `(clientId, discriminator)`, or every
 * entry when called with no args. Scoped deletion is critical: a 401 for one
 * tenant must NOT evict tokens for co-located tenants sharing the clientId.
 */
export function invalidateToken(
  clientId?: string,
  discriminator?: string | number,
): void {
  if (clientId === undefined) {
    cache.clear();
    redisDelToken(undefined);
    return;
  }
  if (discriminator === undefined) {
    // Defensive: without a discriminator we can't target one tenant. Rather
    // than nuke every co-located tenant's token, do nothing — callers on the
    // request path always supply the companyId.
    return;
  }
  const key = cacheKey(clientId, discriminator);
  cache.delete(key);
  redisDelToken(key);
}

/** Test helper. */
export function _peekCache(
  clientId: string,
  discriminator: string | number,
): CacheEntry | undefined {
  return cache.get(cacheKey(clientId, discriminator));
}
