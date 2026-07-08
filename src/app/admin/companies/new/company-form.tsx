'use client';

/**
 * Interactive add-pool form. Credentials must be validated against 8vance
 * before the pool can be created: "Test / detect credentials" authenticates
 * the entered client id + secret, then auto-fills the detected numeric company
 * id and the source-slug dropdown (own-pool default = first non-feed slug).
 * The Create button stays disabled until a successful detection. A direct
 * submit without valid creds is also rejected server-side (createTenantAction
 * re-authenticates).
 */

import { useState, useTransition } from 'react';

import {
  createTenantAction,
  detectVanceCredentialsAction,
  type DetectResult,
} from './actions';

const DEFAULT_BASE_URL = 'https://app.8vance.com/public/v1';

type Detected = {
  companyId: number | null;
  sources: string[];
  suggestedOwnSource: string | null;
};

export function NewCompanyForm(): React.ReactElement {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [baseUrl, setBaseUrl] = useState('');

  const [detecting, startDetect] = useTransition();
  const [creating, startCreate] = useTransition();
  const [detectError, setDetectError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [detected, setDetected] = useState<Detected | null>(null);
  // Manual company-id fallback only used when detection found zero talents.
  const [manualCompanyId, setManualCompanyId] = useState('');
  const [ownSource, setOwnSource] = useState('');
  const [manualOwnSource, setManualOwnSource] = useState('');

  // Any change to the creds invalidates a prior detection → re-gate Create.
  function invalidate(): void {
    if (detected) setDetected(null);
    setDetectError(null);
    setCreateError(null);
  }

  function onDetect(): void {
    setDetectError(null);
    setCreateError(null);
    startDetect(async () => {
      const res: DetectResult = await detectVanceCredentialsAction({
        eightvanceClientId: clientId,
        eightvanceClientSecret: clientSecret,
        eightvanceBaseUrl: baseUrl,
      });
      if (!res.ok) {
        setDetected(null);
        setDetectError(res.error);
        return;
      }
      setDetected({
        companyId: res.companyId,
        sources: res.sources,
        suggestedOwnSource: res.suggestedOwnSource,
      });
      setManualCompanyId(res.companyId !== null ? String(res.companyId) : '');
      setOwnSource(res.suggestedOwnSource ?? '');
      setManualOwnSource('');
    });
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    setCreateError(null);
    if (!detected) {
      setCreateError('Test the 8vance credentials before creating the pool.');
      return;
    }
    const fd = new FormData(e.currentTarget);
    // The company id + own-source come from detected state, not raw inputs,
    // so set them explicitly (the company id field is read-only / hidden).
    const resolvedCompanyId =
      detected.companyId !== null ? String(detected.companyId) : manualCompanyId.trim();
    fd.set('eightvanceCompanyId', resolvedCompanyId);
    const resolvedOwnSource =
      detected.sources.length > 0 ? ownSource : manualOwnSource.trim();
    fd.set('ownSourceSlug', resolvedOwnSource);

    startCreate(async () => {
      const res = await createTenantAction(fd);
      // createTenantAction redirects on success (never returns); a returned
      // object always means an error.
      if (res && !res.ok) setCreateError(res.error);
    });
  }

  const credsReady =
    clientId.trim().length > 0 && clientSecret.length > 0;
  const noTalents = detected !== null && detected.sources.length === 0;
  const needsManualCompanyId = detected !== null && detected.companyId === null;
  const canCreate =
    detected !== null &&
    !creating &&
    (!needsManualCompanyId || manualCompanyId.trim().length > 0);

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-6"
    >
      <Field label="Slug" hint="Used in URLs — lowercase, e.g. bluecircle, ukraine2work">
        <input
          name="slug"
          required
          pattern="[a-z0-9-]+"
          // Normalise as the admin types so a capitalised/spaced name can't reach
          // the server and trip the lowercase-only slug rule.
          onChange={(e) => {
            e.currentTarget.value = e.currentTarget.value
              .toLowerCase()
              .replace(/[^a-z0-9-]+/g, '-')
              .replace(/^-+/, '');
          }}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
        />
      </Field>
      <Field label="Display name">
        <input
          name="name"
          required
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
        />
      </Field>

      <Field label="8vance client ID">
        <input
          name="eightvanceClientId"
          required
          value={clientId}
          onChange={(e) => {
            setClientId(e.target.value);
            invalidate();
          }}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm"
        />
      </Field>
      <Field label="8vance client secret" hint="Encrypted at rest. Cannot be retrieved later.">
        <input
          name="eightvanceClientSecret"
          type="password"
          required
          autoComplete="new-password"
          value={clientSecret}
          onChange={(e) => {
            setClientSecret(e.target.value);
            invalidate();
          }}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm"
        />
      </Field>
      <Field
        label="8vance API base URL"
        hint="Blank = PROD default. ACC pools: https://acc.8vance.com/public/v1"
      >
        <input
          name="eightvanceBaseUrl"
          placeholder={DEFAULT_BASE_URL}
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value);
            invalidate();
          }}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm"
        />
      </Field>

      {/* Test / detect ----------------------------------------------------- */}
      <div className="rounded-lg border border-zinc-200 bg-zinc-50/70 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-zinc-900">8vance connection</p>
            <p className="text-xs text-zinc-500">
              Validate the credentials and auto-detect the company ID + sources.
            </p>
          </div>
          <button
            type="button"
            onClick={onDetect}
            disabled={!credsReady || detecting}
            className="shrink-0 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {detecting ? 'Testing…' : 'Test / detect credentials'}
          </button>
        </div>

        {detectError && (
          <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {detectError}
          </p>
        )}

        {detected && (
          <div className="mt-3 space-y-3 text-sm">
            <p className="rounded-md bg-emerald-50 px-3 py-2 text-emerald-700">
              Credentials valid.
              {detected.companyId !== null
                ? ` Detected company ID ${detected.companyId}.`
                : ' No talents in this pool yet — enter the company ID manually below.'}
            </p>

            {needsManualCompanyId && (
              <label className="block">
                <span className="text-xs font-medium text-zinc-700">
                  8vance company ID
                </span>
                <span className="ml-2 text-xs text-zinc-500">
                  Numeric — required (pool has no talents to auto-detect from)
                </span>
                <input
                  type="number"
                  min={1}
                  value={manualCompanyId}
                  onChange={(e) => setManualCompanyId(e.target.value)}
                  className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
                />
              </label>
            )}

            <label className="block">
              <span className="text-xs font-medium text-zinc-700">Own source</span>
              <span className="ml-2 text-xs text-zinc-500">
                The 8vance source slug for this pool&apos;s own talents/jobs
              </span>
              {noTalents ? (
                <input
                  value={manualOwnSource}
                  onChange={(e) => setManualOwnSource(e.target.value)}
                  pattern="[a-z0-9_]+"
                  placeholder="e.g. instituut_voor_twijfelachtig_advies"
                  className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm"
                />
              ) : (
                <select
                  value={ownSource}
                  onChange={(e) => setOwnSource(e.target.value)}
                  className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm"
                >
                  {detected.sources.map((s) => (
                    <option key={s} value={s}>
                      {s}
                      {s === detected.suggestedOwnSource ? '  (suggested)' : ''}
                    </option>
                  ))}
                </select>
              )}
            </label>
          </div>
        )}
      </div>

      <Field label="Primary brand color" hint="Hex, e.g. #0f172a">
        <input
          name="brandPrimaryColor"
          defaultValue="#0f172a"
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
        />
      </Field>
      <Field
        label="Default search language"
        hint="Pre-selected in the project wizard for this pool. Projects upload as typed (no translation)."
      >
        <select
          name="defaultLocale"
          defaultValue="en"
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
        >
          <option value="en">English</option>
          <option value="nl">Nederlands</option>
          <option value="de">Deutsch</option>
        </select>
      </Field>

      {createError && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {createError}
        </p>
      )}

      <div className="flex items-center justify-end gap-3 pt-2">
        {!detected && (
          <span className="text-xs text-zinc-500">
            Test the 8vance credentials to enable Create.
          </span>
        )}
        <button
          type="submit"
          disabled={!canCreate}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating ? 'Creating…' : 'Create company'}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="block">
      <span className="text-sm font-medium text-zinc-900">{label}</span>
      {hint && <span className="ml-2 text-xs text-zinc-500">{hint}</span>}
      {children}
    </label>
  );
}
