import { describe, it, expect, beforeEach } from 'vitest';

import {
  loginKey,
  loginKeys,
  isAllowed,
  isAllowedFor,
  recordFailure,
  recordFailureFor,
  recordSuccess,
  recordSuccessFor,
  _resetLoginAttempts,
  MAX_FAILURES,
} from '../src/lib/login-ratelimit';

// Upstash UNSET (default) — getRedis() returns null, so these tests exercise
// the in-memory sliding-window + cooldown path only.

describe('login-ratelimit (in-memory)', () => {
  beforeEach(() => {
    _resetLoginAttempts();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it('allows attempts while under the failure threshold', async () => {
    const key = loginKey('under@example.com');
    // MAX_FAILURES - 1 failures must NOT trip the cooldown.
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      const tripped = await recordFailure(key);
      expect(tripped).toBe(false);
      expect(await isAllowed(key)).toBe(true);
    }
  });

  it('blocks once failures reach the threshold (cooldown engaged)', async () => {
    const key = loginKey('over@example.com');
    let tripped = false;
    for (let i = 0; i < MAX_FAILURES; i++) {
      tripped = await recordFailure(key);
    }
    expect(tripped).toBe(true);
    // The Nth failure engaged the cooldown — further attempts are rejected.
    expect(await isAllowed(key)).toBe(false);
  });

  it('resets the counter on a successful login', async () => {
    const key = loginKey('reset@example.com');
    for (let i = 0; i < MAX_FAILURES; i++) {
      await recordFailure(key);
    }
    expect(await isAllowed(key)).toBe(false);

    await recordSuccess(key);

    // Counter cleared — the user is allowed again and not in cooldown.
    expect(await isAllowed(key)).toBe(true);
    // And a fresh single failure does not immediately re-block.
    const tripped = await recordFailure(key);
    expect(tripped).toBe(false);
    expect(await isAllowed(key)).toBe(true);
  });

  it('keys are case-insensitive on email and isolated per key', async () => {
    const a = loginKey('Mixed@Example.com');
    const b = loginKey('mixed@example.com');
    expect(a).toBe(b);

    const other = loginKey('other@example.com');
    for (let i = 0; i < MAX_FAILURES; i++) {
      await recordFailure(a);
    }
    // The matching (case-insensitive) key is blocked…
    expect(await isAllowed(b)).toBe(false);
    // …but an unrelated identity is unaffected.
    expect(await isAllowed(other)).toBe(true);
  });

  it('an IP discriminator narrows the throttle key', () => {
    expect(loginKey('a@b.com', '1.2.3.4')).toBe('a@b.com|1.2.3.4');
    expect(loginKey('a@b.com')).toBe('a@b.com');
  });
});

// F1: the composite API must ALWAYS enforce an email-only counter so a rotating
// client IP cannot manufacture fresh throttle buckets.
describe('login-ratelimit composite API (email-always, rotation-proof)', () => {
  beforeEach(() => {
    _resetLoginAttempts();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it('loginKeys always includes the email-only key first, then email+IP', () => {
    expect(loginKeys('A@B.com')).toEqual(['a@b.com']);
    expect(loginKeys('A@B.com', '1.2.3.4')).toEqual(['a@b.com', 'a@b.com|1.2.3.4']);
    // Email-only key is first so callers short-circuit on the security floor.
    expect(loginKeys('A@B.com', '9.9.9.9')[0]).toBe('a@b.com');
  });

  it('email-only lockout HOLDS even as the attacker rotates the IP', async () => {
    const email = 'victim@example.com';
    // Each failure comes from a DIFFERENT IP — the pre-fix `email|ip` key would
    // give the attacker a fresh bucket every time. The email-only floor must
    // still trip after MAX_FAILURES.
    let tripped = false;
    for (let i = 0; i < MAX_FAILURES; i++) {
      tripped = await recordFailureFor(email, `10.0.0.${i}`);
    }
    expect(tripped).toBe(true);

    // A brand-new IP is now blocked (email-only cooldown), and so is no-IP.
    expect(await isAllowedFor(email, '203.0.113.77')).toBe(false);
    expect(await isAllowedFor(email, '198.51.100.5')).toBe(false);
    expect(await isAllowedFor(email)).toBe(false);
  });

  it('under-threshold failures across rotating IPs accrue on the email-only floor', async () => {
    const email = 'shared@example.com';
    // Under-threshold failures spread across rotating IPs: email-only counter
    // accrues them but stays just under the limit → still allowed.
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      await recordFailureFor(email, `172.16.0.${i}`);
    }
    expect(await isAllowedFor(email, 'any-new-ip')).toBe(true);
    // One more failure (any IP) trips the email-only floor.
    expect(await recordFailureFor(email, 'yet-another-ip')).toBe(true);
    expect(await isAllowedFor(email, 'fresh-ip')).toBe(false);
  });

  it('a different identity is unaffected by another email lockout', async () => {
    const victim = 'target@example.com';
    for (let i = 0; i < MAX_FAILURES; i++) await recordFailureFor(victim, `10.1.0.${i}`);
    expect(await isAllowedFor(victim, 'x')).toBe(false);
    expect(await isAllowedFor('bystander@example.com', 'x')).toBe(true);
  });

  it('recordSuccessFor clears both the email-only and email+IP counters', async () => {
    const email = 'recover@example.com';
    for (let i = 0; i < MAX_FAILURES; i++) await recordFailureFor(email, `10.2.0.${i}`);
    expect(await isAllowedFor(email, 'z')).toBe(false);

    await recordSuccessFor(email, '10.2.0.0');

    // Email-only floor cleared → allowed again from any IP, and a single fresh
    // failure does not immediately re-block.
    expect(await isAllowedFor(email, 'brand-new')).toBe(true);
    expect(await recordFailureFor(email, 'brand-new')).toBe(false);
    expect(await isAllowedFor(email, 'brand-new')).toBe(true);
  });
});
