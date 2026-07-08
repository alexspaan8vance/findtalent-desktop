'use client';

/**
 * Edit-pool credentials form. Lets an admin rotate the client id/secret and,
 * via "Test / re-detect", validate the (possibly new) credentials and re-detect
 * the company id + source slugs — e.g. after the pool's creds changed. Leaving
 * the secret blank keeps the existing one; re-detected company id / own source
 * are only sent when the admin explicitly re-detects, so a branding-only edit
 * never wipes a working pool. Server-side the action re-authenticates a rotated
 * secret before persisting.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { updateTenantCredsAction } from './actions';
// The detect ACTION + its TYPE come straight from the source module: a
// 'use server' file can't re-export them (re-export breaks the module).
import { detectVanceCredentialsAction, type DetectResult } from '../new/actions';

type Detected = {
  companyId: number | null;
  sources: string[];
  suggestedOwnSource: string | null;
};

export function EditCredsForm({
  tenantId,
  clientId: initialClientId,
  companyId: currentCompanyId,
  ownSourceSlug,
}: {
  tenantId: string;
  clientId: string;
  companyId: number;
  ownSourceSlug: string | null;
}): React.ReactElement {
  const router = useRouter();
  const [clientId, setClientId] = useState(initialClientId);
  const [secret, setSecret] = useState('');

  const [detecting, startDetect] = useTransition();
  const [saving, startSave] = useTransition();
  const [detectError, setDetectError] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [detected, setDetected] = useState<Detected | null>(null);
  const [ownSource, setOwnSource] = useState(ownSourceSlug ?? '');

  function onDetect(): void {
    setDetectError(null);
    setSaveMsg(null);
    startDetect(async () => {
      const res: DetectResult = await detectVanceCredentialsAction({
        eightvanceClientId: clientId,
        // Re-detect needs a secret; if the field is blank we can't re-auth here
        // (the stored secret is write-only), so require it for re-detection.
        eightvanceClientSecret: secret,
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
      if (res.suggestedOwnSource) setOwnSource(res.suggestedOwnSource);
    });
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    setSaveMsg(null);
    const fd = new FormData(e.currentTarget);
    fd.set('id', tenantId);
    // Only push re-detected values when a fresh detection happened this session.
    if (detected) {
      if (detected.companyId !== null) {
        fd.set('eightvanceCompanyId', String(detected.companyId));
      }
      const resolvedOwn = detected.sources.length > 0 ? ownSource : ownSource.trim();
      if (resolvedOwn) fd.set('ownSourceSlug', resolvedOwn);
    }
    startSave(async () => {
      const res = await updateTenantCredsAction(fd);
      if (res.ok) {
        setSaveMsg({ ok: true, text: 'Credentials saved.' });
        setSecret('');
        router.refresh();
      } else {
        setSaveMsg({ ok: false, text: res.error });
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 space-y-4">
      <label className="block">
        <span className="text-xs font-medium text-zinc-700">8vance client ID</span>
        <input
          name="eightvanceClientId"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          required
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm"
        />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-zinc-700">8vance client secret</span>
        <span className="ml-2 text-xs text-zinc-500">
          Leave blank to keep the current secret. Required to re-detect.
        </span>
        <input
          name="eightvanceClientSecret"
          type="password"
          placeholder="••••••••  (unchanged)"
          autoComplete="new-password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm"
        />
      </label>

      <div className="rounded-lg border border-zinc-200 bg-white p-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-zinc-600">
            Current company ID <span className="font-mono">{currentCompanyId}</span>
            {ownSourceSlug ? (
              <>
                {' · own source '}
                <span className="font-mono">{ownSourceSlug}</span>
              </>
            ) : null}
          </p>
          <button
            type="button"
            onClick={onDetect}
            disabled={secret.length === 0 || detecting}
            className="shrink-0 rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {detecting ? 'Testing…' : 'Test / re-detect'}
          </button>
        </div>

        {detectError && (
          <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
            {detectError}
          </p>
        )}

        {detected && (
          <div className="mt-2 space-y-2 text-xs">
            <p className="rounded-md bg-emerald-50 px-3 py-2 text-emerald-700">
              Credentials valid.
              {detected.companyId !== null
                ? ` Detected company ID ${detected.companyId} (will be applied on Save).`
                : ' No talents found — company ID left unchanged.'}
            </p>
            {detected.sources.length > 0 && (
              <label className="block">
                <span className="font-medium text-zinc-700">Own source</span>
                <select
                  value={ownSource}
                  onChange={(e) => setOwnSource(e.target.value)}
                  className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
                >
                  {detected.sources.map((s) => (
                    <option key={s} value={s}>
                      {s}
                      {s === detected.suggestedOwnSource ? '  (suggested)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
      </div>

      <p className="text-xs text-zinc-500">
        The secret is re-encrypted (AES-256-GCM) and never shown again. A rotated
        secret is validated against 8vance before saving.
      </p>

      {saveMsg && (
        <p
          className={`rounded-md px-3 py-2 text-sm ${
            saveMsg.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
          }`}
        >
          {saveMsg.text}
        </p>
      )}

      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save credentials'}
      </button>
    </form>
  );
}
