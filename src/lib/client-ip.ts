/**
 * Trusted client-IP resolution behind a reverse proxy / Tailscale Funnel.
 *
 * DEPLOYMENT ASSUMPTION
 * ---------------------
 * findtalent runs behind a Tailscale Funnel and (optionally) a local reverse
 * proxy. Our own infra appends the REAL client IP as the RIGHTMOST hop of the
 * `X-Forwarded-For` chain; everything to the LEFT of that is client-supplied
 * and therefore ATTACKER-CONTROLLABLE (a client can send any `X-Forwarded-For`
 * value and the funnel forwards it, appending the real peer on the right).
 *
 * We therefore read XFF from the RIGHT, never the left. The old repo-wide
 * `fwd.split(',')[0]` (leftmost) returned exactly the attacker-controlled token
 * and must never key a throttle / rate-limiter: rotating that token mints
 * unlimited fresh buckets (see the login brute-force finding). Reading from the
 * right makes left-side rotation unable to change the resolved IP.
 *
 * TRUSTED_PROXY_HOP_COUNT (default 1) is how many trusted proxy hops sit to the
 * right of the real client IP — i.e. the real client is the Nth token counting
 * from the right. With the current single-proxy Funnel deploy the real client
 * IP is the rightmost entry (hop count 1). Raise it only if you place another
 * trusted proxy in front that ALSO appends to `X-Forwarded-For`.
 */

/** Minimal read surface — accepts both `Headers` and next/headers ReadonlyHeaders. */
type HeaderReader = Pick<Headers, 'get'>;

/** Trusted proxy hop count from env, clamped to a sane minimum of 1 (rightmost). */
function trustedProxyHopCount(): number {
  const raw = process.env.TRUSTED_PROXY_HOP_COUNT;
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Best-effort trusted client IP. Reads `X-Forwarded-For` from the RIGHT
 * (TRUSTED_PROXY_HOP_COUNT hops in), falling back to `X-Real-IP`, then null.
 *
 * The returned value is used ONLY to key throttles / rate-limiters — never
 * logged, never stored. Left-side XFF rotation cannot change the result.
 */
export function trustedClientIp(headers: HeaderReader): string | null {
  const fwd = headers.get('x-forwarded-for');
  if (fwd) {
    const parts = fwd
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      const hop = trustedProxyHopCount();
      // Count `hop` entries in from the RIGHT. Clamp to the leftmost entry so a
      // short/forged header can't index out of range; hop>=1 keeps this in
      // [0, len-1]. A rotating left side never shifts this index.
      const idx = Math.max(0, parts.length - hop);
      return parts[idx] ?? null;
    }
  }
  const real = headers.get('x-real-ip');
  return real?.trim() || null;
}
