/**
 * Persistent (process-lifetime) talent-enrichment cache.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * Hydrating a single match talent costs ~3 8vance GETs (profile + skills +
 * location). Those calls are gated by the per-(client, endpoint) rate-limiter
 * and are re-paid every time the SAME talent is hydrated again — a project
 * rematch, a saved-search re-run, two projects of the same tenant surfacing the
 * same person, or the poller remounting. Yet the talent's intrinsic data
 * (profile/skills/location) does not change between those runs within the match
 * TTL window.
 *
 * The short-TTL `skill-cache.ts` already memoises individual sub-resource
 * fetches for ~10 minutes, but it expires fast (to keep a single scan fresh) and
 * only covers the network leg. This cache is COARSER and LONGER-lived: it stores
 * the fully-assembled, talent-intrinsic {@link RawTalent} keyed by
 * `(tenantId, talentId)` for ~24h, so a rematch or cross-project reuse skips the
 * 8vance round-trip entirely.
 *
 * ---------------------------------------------------------------------------
 * What is and is NOT cached (CRITICAL)
 * ---------------------------------------------------------------------------
 * We cache ONLY the talent-intrinsic `RawTalent` — profile fields, the talent's
 * own skills, location, etc. — i.e. the data BEFORE any job-specific
 * anonymization. We DO NOT cache:
 *   - the anonymized payload,
 *   - must_have/gap flags (those depend on THIS project's job skills),
 *   - the score (per-match),
 *   - travel buckets (per-project origin).
 * The caller (`hydrateOne`) always re-runs `anonymize()` FRESH against the
 * current project's job skills, so a cache hit never bleeds one project's
 * job-specific view into another.
 *
 * ---------------------------------------------------------------------------
 * Safety / PII
 * ---------------------------------------------------------------------------
 * - Keyed by `tenantId` (1:1 with an 8vance client_id / company), so one pool
 *   never reads another pool's cached talent.
 * - In-process only. Nothing is persisted to disk and nothing is logged. The
 *   anonymization contract is unchanged: this only skips the network fetch; the
 *   downstream `anonymize()` + `assertNoPII` still run on every match.
 * - TTL-bounded (default = MATCH_TTL_MS, 24h) so a talent edited in 8vance is
 *   reflected on the next hydrate after the entry expires.
 *
 * Module-scoped (one LRU per process), mirroring `skill-cache.ts`.
 */

import { createLru, type Lru } from '@/lib/cache/lru';
import type { RawTalent } from '@/lib/anonymize/types';

const DAY_MS = 24 * 60 * 60 * 1000;

function readTtl(): number {
  const raw = process.env.TALENT_CACHE_TTL_MS;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DAY_MS;
}

function readMax(): number {
  const raw = process.env.TALENT_CACHE_MAX;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  // Large by design: a RawTalent is small (a few KB) and the win comes from
  // retaining many talents across projects/rematches.
  return 5000;
}

// Lazily built so a test that tweaks the env vars before first use is honoured,
// and so the module has no side-effects at import time.
let lru: Lru<RawTalent> | null = null;

function store(): Lru<RawTalent> {
  if (!lru) lru = createLru<RawTalent>({ max: readMax(), ttlMs: readTtl() });
  return lru;
}

/** Stable cache key. `talentId` is 8vance's global id; `tenantId` scopes it. */
export function talentCacheKey(tenantId: string, talentId: number): string {
  return `${tenantId}|${talentId}`;
}

/** Read the cached talent-intrinsic RawTalent, or undefined on miss/expiry. */
export function getCachedTalent(tenantId: string, talentId: number): RawTalent | undefined {
  if (!Number.isFinite(talentId)) return undefined;
  return store().get(talentCacheKey(tenantId, talentId));
}

/**
 * Cache a talent-intrinsic RawTalent. The value MUST be free of job-specific
 * derivation (no must_have/gap/score-vs-this-job state) — only the talent's own
 * profile/skills/location/etc., exactly as `toRawTalent` produces it from the
 * fetched sub-resources.
 */
export function setCachedTalent(tenantId: string, talent: RawTalent): void {
  if (!Number.isFinite(talent.id)) return;
  store().set(talentCacheKey(tenantId, talent.id), talent);
}

/** Test/teardown helper — drop all cached entries and reset config. */
export function _resetTalentCache(): void {
  lru = null;
}

/** Current entry count (diagnostics/tests). */
export function _talentCacheSize(): number {
  return lru ? lru.size : 0;
}
