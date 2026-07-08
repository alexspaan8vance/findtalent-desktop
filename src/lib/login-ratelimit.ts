/**
 * Login throttling / brute-force lockout.
 *
 * Bounds the number of FAILED password attempts per identity inside a sliding
 * window. The authoritative counter is ALWAYS the email-only one; an optional
 * email+IP counter is layered on as defense in depth. After `MAX_FAILURES`
 * failures within `WINDOW_MS`, further attempts are rejected for a `COOLDOWN_MS`
 * cooldown — protecting against online password-guessing without permanently
 * locking out a legitimate user (the window slides and the cooldown expires).
 * Because the email-only counter is always enforced (see `isAllowedFor` /
 * `recordFailureFor`), an attacker rotating their X-Forwarded-For / source IP
 * cannot mint fresh buckets to bypass the per-email lockout.
 *
 * Store: in-memory by default; an optional Upstash Redis fixed-window counter
 * is layered on top when configured, so the limit is honoured across all server
 * instances behind a load balancer. Mirrors the graceful-degradation pattern of
 * `src/lib/eightvance/ratelimit.ts` — ANY Redis error is swallowed and we fall
 * back to in-memory-only behaviour. Never throws.
 *
 * Security note (memory `feedback_security_critical`): callers must surface a
 * GENERIC failure to the client (no "account locked" vs "wrong password"
 * distinction) so this does not become a user-enumeration / account-state
 * oracle. We also never log the attempted password or the bare email at info
 * level here.
 */

import { getRedis } from "./eightvance/redis";

// --- Policy ----------------------------------------------------------------

/** Failures tolerated inside one sliding window before the cooldown engages. */
export const MAX_FAILURES = 5;
/** Sliding window over which failures are counted. */
export const WINDOW_MS = 15 * 60_000; // 15 min
/** How long further attempts are blocked once the threshold is exceeded. */
export const COOLDOWN_MS = 15 * 60_000; // 15 min

interface Attempt {
  /** Epoch-ms timestamps of recent failures (pruned to the sliding window). */
  failures: number[];
  /** Epoch ms until which all attempts are blocked, or 0 if not in cooldown. */
  blockedUntil: number;
}

const attempts = new Map<string, Attempt>();

function getOrCreate(key: string): Attempt {
  let a = attempts.get(key);
  if (!a) {
    a = { failures: [], blockedUntil: 0 };
    attempts.set(key, a);
  }
  return a;
}

/** Drop failures that have aged out of the sliding window. */
function prune(a: Attempt, now: number): void {
  const cutoff = now - WINDOW_MS;
  if (a.failures.length && a.failures[0] < cutoff) {
    a.failures = a.failures.filter((t) => t >= cutoff);
  }
}

// --- Optional cross-instance gate (Upstash Redis) --------------------------
//
// We keep a fixed-window failure counter and a cooldown marker in Redis so the
// lockout holds across instances. Best-effort: on any error we return null and
// callers fall back to the in-memory decision. Never throws.

const FAIL_PREFIX = "login:fail:";
const BLOCK_PREFIX = "login:block:";

/** Read the cross-instance cooldown deadline (epoch ms), or 0 if none/error. */
async function redisBlockedUntil(key: string): Promise<number> {
  const redis = getRedis();
  if (!redis) return 0;
  try {
    const v = await redis.get<string | number>(`${BLOCK_PREFIX}${key}`);
    if (v === null || v === undefined) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** INCR the fixed-window failure counter; set TTL on first hit. Null on error. */
async function redisIncrFailure(key: string): Promise<number | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const full = `${FAIL_PREFIX}${key}`;
    const n = await redis.incr(full);
    if (n === 1) await redis.pexpire(full, WINDOW_MS);
    return n;
  } catch {
    return null;
  }
}

/** Engage the cross-instance cooldown and clear the failure counter. */
async function redisBlock(key: string, until: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(`${BLOCK_PREFIX}${key}`, String(until), {
      px: COOLDOWN_MS,
    });
    await redis.del(`${FAIL_PREFIX}${key}`);
  } catch {
    /* swallow — in-memory cooldown already applied */
  }
}

/** Clear cross-instance failure + cooldown state (on success). */
async function redisClear(key: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(`${FAIL_PREFIX}${key}`);
    await redis.del(`${BLOCK_PREFIX}${key}`);
  } catch {
    /* swallow */
  }
}

// --- Public API ------------------------------------------------------------

/**
 * Build a single throttle key. The email is lower-cased so case variants share a
 * counter; an optional IP narrows the key further. NOTE: the `email|ip` key on
 * its own is NOT rotation-proof — an attacker cycling the IP mints a fresh
 * bucket each time. The rotation-proof guarantee lives in {@link loginKeys} /
 * {@link isAllowedFor}, which ALWAYS also consult the email-only counter.
 */
export function loginKey(email: string, ip?: string | null): string {
  const e = email.trim().toLowerCase();
  return ip ? `${e}|${ip}` : e;
}

/**
 * The set of counters that MUST all be consulted/recorded for one login attempt:
 * the email-only counter (ALWAYS — the security floor a rotating IP can't lift)
 * plus, when an IP is known, the secondary email+IP counter. Returns the
 * email-only key first so callers can short-circuit on it cheaply.
 */
export function loginKeys(email: string, ip?: string | null): string[] {
  const base = loginKey(email); // email-only — always present
  return ip ? [base, loginKey(email, ip)] : [base];
}

/**
 * Return true if this key is currently allowed to attempt a login. When false,
 * the caller MUST reject WITHOUT performing the password check, and surface a
 * generic error (no lockout-specific messaging — see module note).
 */
export async function isAllowed(key: string): Promise<boolean> {
  const now = Date.now();
  const a = getOrCreate(key);

  // Cross-instance cooldown takes precedence if it is further in the future.
  const distBlock = await redisBlockedUntil(key);
  if (distBlock > a.blockedUntil) a.blockedUntil = distBlock;

  if (a.blockedUntil > now) return false;
  // Cooldown elapsed — reset so the next window starts clean.
  if (a.blockedUntil !== 0) {
    a.blockedUntil = 0;
    a.failures = [];
  }
  prune(a, now);
  return true;
}

/**
 * Record a failed attempt. Returns true if the key is NOW in cooldown (i.e.
 * this failure tripped or sustained the lockout). Idempotent under concurrency
 * to the extent the in-memory map allows.
 */
export async function recordFailure(key: string): Promise<boolean> {
  const now = Date.now();
  const a = getOrCreate(key);
  prune(a, now);
  a.failures.push(now);

  const distCount = await redisIncrFailure(key);
  const localCount = a.failures.length;
  const effective = distCount !== null ? Math.max(distCount, localCount) : localCount;

  if (effective >= MAX_FAILURES) {
    a.blockedUntil = now + COOLDOWN_MS;
    a.failures = [];
    await redisBlock(key, a.blockedUntil);
    return true;
  }
  return false;
}

/** Reset all state for a key after a SUCCESSFUL login. */
export async function recordSuccess(key: string): Promise<void> {
  attempts.delete(key);
  await redisClear(key);
}

// --- Rotation-proof composite API (email-always) ---------------------------
//
// These wrap the single-key primitives above to enforce the invariant that the
// EMAIL-ONLY counter is always part of the decision. An attacker rotating the
// client IP still advances (and is blocked by) the email-only counter, so the
// per-email lockout holds regardless of how many source IPs they cycle. The
// secondary email+IP counter is kept as defense in depth. Callers (auth.ts)
// should use these, not the raw single-key functions.

/**
 * True iff EVERY relevant counter (email-only, and email+IP when known) is
 * currently allowed. The email-only counter is always consulted, so a rotating
 * IP cannot escape an email-level cooldown. Short-circuits on the first block.
 */
export async function isAllowedFor(
  email: string,
  ip?: string | null,
): Promise<boolean> {
  for (const key of loginKeys(email, ip)) {
    if (!(await isAllowed(key))) return false;
  }
  return true;
}

/**
 * Record a failed attempt against EVERY relevant counter, so the email-only
 * floor always advances even as the IP rotates. Returns true if ANY counter is
 * now in cooldown.
 */
export async function recordFailureFor(
  email: string,
  ip?: string | null,
): Promise<boolean> {
  let tripped = false;
  for (const key of loginKeys(email, ip)) {
    // Record against all keys (no short-circuit) so each counter stays in sync.
    if (await recordFailure(key)) tripped = true;
  }
  return tripped;
}

/** Reset every relevant counter after a SUCCESSFUL login. */
export async function recordSuccessFor(
  email: string,
  ip?: string | null,
): Promise<void> {
  for (const key of loginKeys(email, ip)) {
    await recordSuccess(key);
  }
}

/** Test/teardown helper — drop all in-memory attempt state. */
export function _resetLoginAttempts(): void {
  attempts.clear();
}
