import { describe, it, expect, afterEach } from 'vitest';

import { trustedClientIp } from '../src/lib/client-ip';

/** Build a Headers with optional XFF / X-Real-IP. */
function h(xff?: string, realIp?: string): Headers {
  const headers = new Headers();
  if (xff != null) headers.set('x-forwarded-for', xff);
  if (realIp != null) headers.set('x-real-ip', realIp);
  return headers;
}

describe('trustedClientIp', () => {
  const orig = process.env.TRUSTED_PROXY_HOP_COUNT;
  afterEach(() => {
    if (orig === undefined) delete process.env.TRUSTED_PROXY_HOP_COUNT;
    else process.env.TRUSTED_PROXY_HOP_COUNT = orig;
  });

  it('takes the RIGHTMOST XFF token by default (single trusted proxy)', () => {
    delete process.env.TRUSTED_PROXY_HOP_COUNT;
    expect(trustedClientIp(h('1.1.1.1, 2.2.2.2, 9.9.9.9'))).toBe('9.9.9.9');
    expect(trustedClientIp(h('9.9.9.9'))).toBe('9.9.9.9');
  });

  it('left-side rotation CANNOT change the resolved IP (the security property)', () => {
    delete process.env.TRUSTED_PROXY_HOP_COUNT;
    const real = '9.9.9.9';
    // Attacker injects/rotates arbitrary left-hand tokens; the rightmost
    // (proxy-appended) entry is invariant, so the throttle key is stable.
    expect(trustedClientIp(h(`evil-a, ${real}`))).toBe(real);
    expect(trustedClientIp(h(`evil-a, evil-b, ${real}`))).toBe(real);
    expect(trustedClientIp(h(`totally, different, junk, ${real}`))).toBe(real);
    // Every rotation resolves to the SAME IP → no fresh throttle bucket.
    const seen = new Set(
      ['a', 'b, c', 'd, e, f', 'x, y, z, w'].map((prefix) =>
        trustedClientIp(h(`${prefix}, ${real}`)),
      ),
    );
    expect([...seen]).toEqual([real]);
  });

  it('honours TRUSTED_PROXY_HOP_COUNT (Nth token from the right)', () => {
    process.env.TRUSTED_PROXY_HOP_COUNT = '2';
    // Two trusted hops on the right → real client is 2nd from the right.
    expect(trustedClientIp(h('evil, 5.5.5.5, 2.2.2.2'))).toBe('5.5.5.5');
  });

  it('clamps an over-large hop count to the leftmost entry', () => {
    process.env.TRUSTED_PROXY_HOP_COUNT = '9';
    expect(trustedClientIp(h('a, b, c'))).toBe('a');
  });

  it('falls back to 1 (rightmost) on an invalid/zero hop count', () => {
    process.env.TRUSTED_PROXY_HOP_COUNT = '0';
    expect(trustedClientIp(h('a, b, c'))).toBe('c');
    process.env.TRUSTED_PROXY_HOP_COUNT = 'abc';
    expect(trustedClientIp(h('a, b, c'))).toBe('c');
    process.env.TRUSTED_PROXY_HOP_COUNT = '-3';
    expect(trustedClientIp(h('a, b, c'))).toBe('c');
  });

  it('trims whitespace and skips empty tokens', () => {
    expect(trustedClientIp(h('  a ,  b ,  c  '))).toBe('c');
    expect(trustedClientIp(h('a, , '))).toBe('a'); // trailing empties dropped
  });

  it('falls back to X-Real-IP, then null', () => {
    expect(trustedClientIp(h(undefined, '4.4.4.4'))).toBe('4.4.4.4');
    expect(trustedClientIp(h('   ', '4.4.4.4'))).toBe('4.4.4.4'); // XFF all-empty → real-ip
    expect(trustedClientIp(h())).toBeNull();
  });
});
