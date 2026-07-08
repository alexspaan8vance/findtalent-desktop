import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { authorizeCron } from '../src/lib/observability/cron-auth';
import { redact, reportError, reportMessage } from '../src/lib/observability/report';

function reqWith(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader != null) headers.set('authorization', authHeader);
  return new Request('http://localhost/api/cron/cleanup', { headers });
}

describe('authorizeCron', () => {
  const original = process.env.CRON_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it('refuses with 503 when CRON_SECRET is unset (never open by default)', () => {
    delete process.env.CRON_SECRET;
    const r = authorizeCron(reqWith('Bearer anything'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(503);
  });

  it('rejects with 401 when the bearer token is missing', () => {
    process.env.CRON_SECRET = 'super-secret';
    const r = authorizeCron(reqWith());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it('rejects with 401 when the bearer token is wrong', () => {
    process.env.CRON_SECRET = 'super-secret';
    const r = authorizeCron(reqWith('Bearer nope'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it('rejects a token that shares a prefix but differs in length', () => {
    process.env.CRON_SECRET = 'super-secret';
    const r = authorizeCron(reqWith('Bearer super-secret-extra'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it('accepts the correct bearer token', () => {
    process.env.CRON_SECRET = 'super-secret';
    const r = authorizeCron(reqWith('Bearer super-secret'));
    expect(r.ok).toBe(true);
  });
});

describe('observability report', () => {
  const originalDsn = process.env.SENTRY_DSN;
  afterEach(() => {
    if (originalDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalDsn;
    vi.restoreAllMocks();
  });

  it('reportError logs structured to stderr and never throws when Sentry absent', () => {
    delete process.env.SENTRY_DSN; // no DSN → no Sentry forward attempted
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => reportError(new Error('boom'), { area: 'test' })).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    const [tag, payload] = spy.mock.calls[0] as [string, Record<string, unknown>];
    expect(tag).toBe('[report]');
    expect(payload.message).toBe('boom');
    expect((payload.context as Record<string, unknown>).area).toBe('test');
  });

  it('reportMessage logs and does not throw', () => {
    delete process.env.SENTRY_DSN;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => reportMessage('degraded', { detail: 1 }, 'warning')).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('redact strips sensitive keys and keeps safe ones', () => {
    const out = redact({
      area: 'eightvance',
      clientSecret: 'shhh',
      authorization: 'Bearer x',
      email: 'a@b.com',
      nested: { token: 'abc', count: 3 },
    }) as Record<string, unknown>;
    expect(out.area).toBe('eightvance');
    expect(out.clientSecret).toBe('[redacted]');
    expect(out.authorization).toBe('[redacted]');
    expect(out.email).toBe('[redacted]');
    const nested = out.nested as Record<string, unknown>;
    expect(nested.token).toBe('[redacted]');
    expect(nested.count).toBe(3);
  });

  it('redact bounds depth + cycles without throwing', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a; // cycle
    expect(() => redact(a)).not.toThrow();
  });
});
