import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';

import { defaultVanceCredentials, parseEnv, validateEnv } from '../src/lib/env';

const KEY32 = randomBytes(32).toString('base64');

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'file:./test.db',
    AUTH_SECRET: randomBytes(24).toString('base64'),
    ENCRYPTION_KEY: KEY32,
    NEXTAUTH_URL: 'https://app.example.com',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('env schema', () => {
  it('accepts a fully valid minimal env', () => {
    const r = parseEnv(baseEnv());
    expect(r.ok).toBe(true);
    expect(r.problems).toHaveLength(0);
  });

  it('treats EMPTY optional integration vars as not-configured (no boot crash)', () => {
    // Deploy .env files routinely ship `RESEND_API_KEY=` etc. as empty
    // placeholders. These must validate as "absent", not crash boot.
    const r = parseEnv(
      baseEnv({
        RESEND_API_KEY: '',
        MAIL_FROM: '',
        OPENAI_API_KEY: '',
        EIGHTVANCE_CV_PARSER_TOKEN: '',
        SENTRY_DSN: '',
        CRON_SECRET: '',
        SIGNUP_ALLOWED_DOMAINS: '',
        EIGHTVANCE_CLIENT_ID: '',
        EIGHTVANCE_CLIENT_SECRET: '',
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.problems).toHaveLength(0);
    expect(r.env?.RESEND_API_KEY).toBeUndefined();
  });

  it('rejects a missing DATABASE_URL', () => {
    const r = parseEnv(baseEnv({ DATABASE_URL: undefined }));
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.startsWith('DATABASE_URL'))).toBe(true);
  });

  it('rejects a short AUTH_SECRET', () => {
    const r = parseEnv(baseEnv({ AUTH_SECRET: 'short' }));
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.startsWith('AUTH_SECRET'))).toBe(true);
  });

  it('rejects an ENCRYPTION_KEY that is not 32 bytes', () => {
    const r = parseEnv(baseEnv({ ENCRYPTION_KEY: Buffer.from('tooshort').toString('base64') }));
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.startsWith('ENCRYPTION_KEY'))).toBe(true);
  });

  it('rejects an invalid NEXTAUTH_URL', () => {
    const r = parseEnv(baseEnv({ NEXTAUTH_URL: 'not-a-url' }));
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.startsWith('NEXTAUTH_URL'))).toBe(true);
  });

  it('accepts both Stripe keys together', () => {
    const r = parseEnv(
      baseEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' }),
    );
    expect(r.ok).toBe(true);
  });

  it('rejects a half-configured Stripe', () => {
    const r = parseEnv(baseEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }));
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => /Stripe/.test(p))).toBe(true);
  });

  it('rejects a half-configured Upstash', () => {
    const r = parseEnv(baseEnv({ UPSTASH_REDIS_REST_URL: 'https://x.upstash.io' }));
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => /Upstash/.test(p))).toBe(true);
  });

  it('accepts both Upstash vars together', () => {
    const r = parseEnv(
      baseEnv({
        UPSTASH_REDIS_REST_URL: 'https://x.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'tok',
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('never echoes the offending value in problem strings', () => {
    const secret = 'super-secret-value-should-not-leak';
    const r = parseEnv(baseEnv({ NEXTAUTH_URL: secret }));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).not.toContain(secret);
  });
});

describe('defaultVanceCredentials (VANCE_PROD_* ↔ EIGHTVANCE_* reconciliation)', () => {
  const credsEnv = (vars: Record<string, string>): NodeJS.ProcessEnv =>
    ({ NODE_ENV: 'test', ...vars }) as NodeJS.ProcessEnv;

  it('VANCE_PROD_* wins when both spellings are set', () => {
    const r = defaultVanceCredentials(
      credsEnv({
        VANCE_PROD_CLIENT_ID: 'vance-id',
        VANCE_PROD_CLIENT_SECRET: 'vance-secret',
        EIGHTVANCE_CLIENT_ID: 'eight-id',
        EIGHTVANCE_CLIENT_SECRET: 'eight-secret',
      }),
    );
    expect(r).toEqual({ clientId: 'vance-id', clientSecret: 'vance-secret' });
  });

  it('falls back to EIGHTVANCE_* (the Docker deploy names) when VANCE_PROD_* is unset', () => {
    const r = defaultVanceCredentials(
      credsEnv({
        EIGHTVANCE_CLIENT_ID: 'eight-id',
        EIGHTVANCE_CLIENT_SECRET: 'eight-secret',
      }),
    );
    expect(r).toEqual({ clientId: 'eight-id', clientSecret: 'eight-secret' });
  });

  it('treats EMPTY strings as unset (falls through per field)', () => {
    const r = defaultVanceCredentials(
      credsEnv({
        VANCE_PROD_CLIENT_ID: '',
        VANCE_PROD_CLIENT_SECRET: 'vance-secret',
        EIGHTVANCE_CLIENT_ID: 'eight-id',
        EIGHTVANCE_CLIENT_SECRET: '',
      }),
    );
    expect(r).toEqual({ clientId: 'eight-id', clientSecret: 'vance-secret' });
  });

  it('neither spelling set → both undefined (probe reports unconfigured)', () => {
    const r = defaultVanceCredentials(credsEnv({}));
    expect(r.clientId).toBeUndefined();
    expect(r.clientSecret).toBeUndefined();
  });
});

describe('validateEnv behaviour', () => {
  it('throws in production on an invalid env', () => {
    expect(() => validateEnv(baseEnv({ DATABASE_URL: undefined }))).toThrow(/env/i);
  });

  it('does not throw in development (warn-only)', () => {
    const env = baseEnv({ NODE_ENV: 'development', DATABASE_URL: undefined });
    expect(() => validateEnv(env)).not.toThrow();
  });

  it('is a silent no-op under NODE_ENV=test even with a broken env', () => {
    const env = baseEnv({ NODE_ENV: 'test', DATABASE_URL: undefined, ENCRYPTION_KEY: 'x' });
    const r = validateEnv(env);
    expect(r.ok).toBe(true);
  });
});
