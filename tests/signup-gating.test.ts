/**
 * Signup gating (SIGNUP_ALLOWED_DOMAINS) + the production email requirement.
 *
 * FIX 1 — fail-closed self-registration:
 *   - SIGNUP_ALLOWED_DOMAINS set  → only listed domains may register.
 *   - unset in production         → signup DISABLED.
 *   - unset outside production    → open (local dev/test convenience).
 *
 * FIX 2 — auto-verify is a NON-PRODUCTION convenience only:
 *   - production + email unconfigured → signup fails BEFORE creating a row.
 *   - production + send failure       → error, row stays UNVERIFIED (never
 *     auto-verified — login requires emailVerifiedAt).
 *
 * Mirrors tests/signup-invited.test.ts style: '@/auth' stubbed to break the
 * Auth.js import chain, the email module mocked, redirect() asserted via its
 * NEXT_REDIRECT digest. Uses unique emails per run instead of blanket
 * deleteMany so it can't interfere with sibling test files on the same
 * worker DB.
 *
 * Run with `npx vitest run tests/signup-gating.test.ts`.
 */

import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';

import { PrismaClient } from '@prisma/client';

import {
  getSignupPolicy,
  isEmailAllowedBySignupPolicy,
  parseAllowedDomains,
  type SignupPolicy,
} from '../src/lib/signup-policy';

const prisma = new PrismaClient();

// signupAction → auth-helpers → '@/auth' (Auth.js) pulls Next.js server
// internals that don't resolve under vitest's node env — stub the module.
vi.mock('@/auth', () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

// Controllable email module: per-test toggles for configured/sent.
const emailMocks = vi.hoisted(() => ({
  sendEmail: vi.fn<() => Promise<boolean>>(async () => false),
  isEmailConfigured: vi.fn<() => boolean>(() => false),
}));
vi.mock('../src/lib/email', () => ({
  sendEmail: emailMocks.sendEmail,
  isEmailConfigured: emailMocks.isEmailConfigured,
}));

import { signupAction, type SignupState } from '../src/app/(auth)/signup/actions';

/** Extract the redirect target from a thrown NEXT_REDIRECT error, if any. */
function redirectTarget(err: unknown): string | null {
  if (err && typeof err === 'object' && 'digest' in err) {
    const digest = String((err as { digest: unknown }).digest);
    if (digest.startsWith('NEXT_REDIRECT')) {
      // digest format: "NEXT_REDIRECT;replace;/login?verified=1;307;"
      const parts = digest.split(';');
      return parts[2] ?? '';
    }
  }
  return null;
}

function form(email: string, password: string): FormData {
  const fd = new FormData();
  fd.set('email', email);
  fd.set('password', password);
  fd.set('consent', 'on');
  return fd;
}

/** Run signupAction, returning either its state or the redirect target. */
async function runSignup(
  email: string,
): Promise<{ state?: SignupState; redirect?: string }> {
  const initial: SignupState = { ok: false };
  try {
    const state = await signupAction(initial, form(email, 'sup3rsecret!'));
    return { state };
  } catch (err) {
    const target = redirectTarget(err);
    if (target === null) throw err; // a real crash, not a redirect
    return { redirect: target };
  }
}

/** Unique per-run email so assertions never collide with sibling files. */
const runTag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
let seq = 0;
function uniqueEmail(domain: string): string {
  return `gating-${runTag}-${seq++}@${domain}`;
}

beforeEach(() => {
  emailMocks.sendEmail.mockClear();
  emailMocks.isEmailConfigured.mockClear();
  emailMocks.sendEmail.mockImplementation(async () => false);
  emailMocks.isEmailConfigured.mockImplementation(() => false);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('signup policy (pure helpers)', () => {
  it('parseAllowedDomains trims, lowercases, strips leading @ and empties', () => {
    expect(parseAllowedDomains(' 8vance.com , @Example.ORG ,, ')).toEqual([
      '8vance.com',
      'example.org',
    ]);
    expect(parseAllowedDomains(undefined)).toEqual([]);
    expect(parseAllowedDomains('')).toEqual([]);
  });

  it('unset + production → closed (fail-closed)', () => {
    const p = getSignupPolicy({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(p.mode).toBe('closed');
  });

  it('unset + development/test → open (local dev stays usable)', () => {
    expect(getSignupPolicy({ NODE_ENV: 'development' } as NodeJS.ProcessEnv).mode).toBe('open');
    expect(getSignupPolicy({ NODE_ENV: 'test' } as NodeJS.ProcessEnv).mode).toBe('open');
    // No NODE_ENV at all defaults to development semantics.
    expect(getSignupPolicy({} as NodeJS.ProcessEnv).mode).toBe('open');
  });

  it('set → domains mode in EVERY env (also production)', () => {
    const prod = getSignupPolicy({
      NODE_ENV: 'production',
      SIGNUP_ALLOWED_DOMAINS: '8vance.com',
    } as NodeJS.ProcessEnv);
    expect(prod).toEqual({ mode: 'domains', domains: ['8vance.com'] });
  });

  it('isEmailAllowedBySignupPolicy matches domains case-insensitively', () => {
    const policy: SignupPolicy = { mode: 'domains', domains: ['8vance.com'] };
    expect(isEmailAllowedBySignupPolicy('alex@8vance.com', policy)).toBe(true);
    expect(isEmailAllowedBySignupPolicy('Alex@8VANCE.COM', policy)).toBe(true);
    expect(isEmailAllowedBySignupPolicy('mallory@evil.test', policy)).toBe(false);
    expect(isEmailAllowedBySignupPolicy('no-at-sign', policy)).toBe(false);
    expect(isEmailAllowedBySignupPolicy('a@sub.8vance.com', policy)).toBe(false);
  });

  it('closed rejects everything, open allows everything', () => {
    expect(isEmailAllowedBySignupPolicy('a@8vance.com', { mode: 'closed' })).toBe(false);
    expect(isEmailAllowedBySignupPolicy('a@anywhere.test', { mode: 'open' })).toBe(true);
  });
});

describe('signupAction — SIGNUP_ALLOWED_DOMAINS gating (FIX 1)', () => {
  it('allowed domain passes (email off → non-prod auto-verify → /login?verified=1)', async () => {
    vi.stubEnv('SIGNUP_ALLOWED_DOMAINS', '8vance.com');
    const email = uniqueEmail('8vance.com');

    const r = await runSignup(email);
    expect(r.redirect).toBe('/login?verified=1');

    const u = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(u.passwordHash).toBeTruthy();
    expect(u.emailVerifiedAt).not.toBeNull(); // non-prod auto-verify intact
  });

  it('wrong domain is rejected with the allowlist named, and NO row is created', async () => {
    vi.stubEnv('SIGNUP_ALLOWED_DOMAINS', '8vance.com');
    const email = uniqueEmail('evil.test');

    const r = await runSignup(email);
    expect(r.redirect).toBeUndefined();
    expect(r.state?.ok).toBe(false);
    expect(r.state?.fieldErrors?.email).toContain('@8vance.com');

    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it('unset + production → signup disabled, clear message, NO row', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const email = uniqueEmail('8vance.com');

    const r = await runSignup(email);
    expect(r.redirect).toBeUndefined();
    expect(r.state?.ok).toBe(false);
    expect(r.state?.error).toContain('Registratie is uitgeschakeld');

    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it('unset outside production → current open behavior is preserved', async () => {
    // NODE_ENV is 'test' here and SIGNUP_ALLOWED_DOMAINS is not stubbed.
    const email = uniqueEmail('anywhere.test');
    const r = await runSignup(email);
    expect(r.redirect).toBe('/login?verified=1');
    expect(await prisma.user.findUnique({ where: { email } })).not.toBeNull();
  });
});

describe('signupAction — production email requirement (FIX 2)', () => {
  it('production + email unconfigured → config error BEFORE any row is created', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SIGNUP_ALLOWED_DOMAINS', '8vance.com');
    emailMocks.isEmailConfigured.mockImplementation(() => false);
    const email = uniqueEmail('8vance.com');

    const r = await runSignup(email);
    expect(r.redirect).toBeUndefined();
    expect(r.state?.ok).toBe(false);
    expect(r.state?.error).toContain('e-mailverificatie');

    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    expect(emailMocks.sendEmail).not.toHaveBeenCalled();
  });

  it('production + email configured → verification mail path, NOT auto-verified', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SIGNUP_ALLOWED_DOMAINS', '8vance.com');
    emailMocks.isEmailConfigured.mockImplementation(() => true);
    emailMocks.sendEmail.mockImplementation(async () => true);
    const email = uniqueEmail('8vance.com');

    const r = await runSignup(email);
    expect(r.redirect).toBe('/verify-email-sent');

    const u = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(u.emailVerifiedAt).toBeNull(); // must verify via the mail link
  });

  it('production + send failure → error and the row is NEVER auto-verified', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SIGNUP_ALLOWED_DOMAINS', '8vance.com');
    emailMocks.isEmailConfigured.mockImplementation(() => true);
    emailMocks.sendEmail.mockImplementation(async () => false); // defensive tail
    const email = uniqueEmail('8vance.com');

    const r = await runSignup(email);
    expect(r.redirect).toBeUndefined();
    expect(r.state?.ok).toBe(false);
    expect(r.state?.error).toBeTruthy();

    // Row exists (created before the send attempt) but is unverified —
    // unusable for login and repairable by a later re-signup.
    const u = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(u.emailVerifiedAt).toBeNull();
  });

  it('outside production the email-off auto-verify convenience still works', async () => {
    emailMocks.isEmailConfigured.mockImplementation(() => false);
    emailMocks.sendEmail.mockImplementation(async () => false);
    const email = uniqueEmail('dev.local');

    const r = await runSignup(email);
    expect(r.redirect).toBe('/login?verified=1');
    const u = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(u.emailVerifiedAt).not.toBeNull();
  });
});
