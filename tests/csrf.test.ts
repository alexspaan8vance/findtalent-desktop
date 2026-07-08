import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { csrfCheck } from '../src/lib/csrf';

const APP = 'https://app.example.com';

/** Build a minimal CsrfRequest with the given headers + serving URL. */
function req(headers: Record<string, string>, url = `${APP}/api/reveals`) {
  return { headers: new Headers(headers), url };
}

describe('csrfCheck', () => {
  const origApp = process.env.APP_ORIGIN;
  const origNextAuth = process.env.NEXTAUTH_URL;
  beforeEach(() => {
    process.env.APP_ORIGIN = APP;
    delete process.env.NEXTAUTH_URL;
  });
  afterEach(() => {
    if (origApp === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = origApp;
    if (origNextAuth === undefined) delete process.env.NEXTAUTH_URL;
    else process.env.NEXTAUTH_URL = origNextAuth;
  });

  it('allows a same-origin request (Origin matches serving/app origin)', () => {
    expect(csrfCheck(req({ origin: APP }))).toBeNull();
  });

  it('allows when NEITHER Origin nor Referer is present (server-to-server)', () => {
    expect(csrfCheck(req({}))).toBeNull();
  });

  it('rejects a cross-site Origin with 403', () => {
    const r = csrfCheck(req({ origin: 'https://evil.example.com' }));
    expect(r).not.toBeNull();
    expect(r?.status).toBe(403);
  });

  it('rejects Origin: null (sandboxed iframe / privacy shim) with 403', () => {
    expect(csrfCheck(req({ origin: 'null' }))?.status).toBe(403);
  });

  it('allows the configured app origin even when req.url host differs (proxy)', () => {
    // Behind the Funnel the browser Origin is the public one while req.url
    // carries the internal host — the env allowlist entry must still match.
    const r = csrfCheck(req({ origin: APP }, 'http://127.0.0.1:3000/api/reveals'));
    expect(r).toBeNull();
  });

  it('falls back to NEXTAUTH_URL when APP_ORIGIN is unset', () => {
    delete process.env.APP_ORIGIN;
    process.env.NEXTAUTH_URL = APP;
    expect(csrfCheck(req({ origin: APP }, 'http://127.0.0.1:3000/api/x'))).toBeNull();
    expect(csrfCheck(req({ origin: 'https://evil.example.com' }, 'http://127.0.0.1:3000/api/x'))?.status).toBe(403);
  });

  it('uses the Referer origin when Origin is absent', () => {
    expect(csrfCheck(req({ referer: `${APP}/app/projects` }))).toBeNull();
    expect(csrfCheck(req({ referer: 'https://evil.example.com/x' }))?.status).toBe(403);
  });

  it('allows same-serving-origin even without env configured', () => {
    delete process.env.APP_ORIGIN;
    delete process.env.NEXTAUTH_URL;
    // req.url origin is in the allowlist, so a matching Origin passes.
    expect(csrfCheck(req({ origin: APP }, `${APP}/api/reveals`))).toBeNull();
  });
});
