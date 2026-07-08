/**
 * Signup gating policy — who may self-register.
 *
 * Driven by `SIGNUP_ALLOWED_DOMAINS` (comma-separated email domains, e.g.
 * "8vance.com" or "8vance.com,example.org"; a leading '@' per entry is
 * tolerated). Resolution:
 *
 *   - set (non-empty)      → 'domains': only emails whose domain is in the
 *                            list (case-insensitive, trimmed) may register.
 *   - unset/empty, prod    → 'closed': self-signup is DISABLED (fail-closed —
 *                            this app fronts a public Tailscale Funnel URL).
 *   - unset/empty, non-prod→ 'open': keep local dev/test frictionless.
 *
 * Pure + dependency-free so the server action, the signup page (server
 * component) and tests can all share it. Reads env at CALL time (not import
 * time) so runtime env changes and test stubs are honoured.
 */

export type SignupPolicy =
  | { mode: 'open' }
  | { mode: 'closed' }
  | { mode: 'domains'; domains: string[] };

/** Parse the raw env value into a clean, lowercase domain list. */
export function parseAllowedDomains(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter((d) => d.length > 0);
}

export function getSignupPolicy(
  source: NodeJS.ProcessEnv = process.env,
): SignupPolicy {
  const domains = parseAllowedDomains(source.SIGNUP_ALLOWED_DOMAINS);
  if (domains.length > 0) return { mode: 'domains', domains };
  return (source.NODE_ENV ?? 'development') === 'production'
    ? { mode: 'closed' }
    : { mode: 'open' };
}

/**
 * Whether `email`'s domain passes `policy`. The caller normalises the email
 * (the signup action lowercases + trims before validation); we re-lowercase
 * defensively. 'closed' rejects everything — the caller should surface the
 * "registration disabled" message BEFORE the per-email check.
 */
export function isEmailAllowedBySignupPolicy(
  email: string,
  policy: SignupPolicy,
): boolean {
  if (policy.mode === 'open') return true;
  if (policy.mode === 'closed') return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return policy.domains.includes(domain);
}
