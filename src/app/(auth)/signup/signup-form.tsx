'use client';

import { Suspense, useActionState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { signupAction, type SignupState } from './actions';

const initialState: SignupState = { ok: false };

export default function SignupFormShell({
  allowedDomains,
}: {
  /** Domains allowed to register (empty = no domain restriction). Hint only — the server action re-validates. */
  allowedDomains: string[];
}) {
  // useSearchParams() needs a Suspense boundary to avoid a CSR bailout at build.
  return (
    <Suspense>
      <SignupForm allowedDomains={allowedDomains} />
    </Suspense>
  );
}

function SignupForm({ allowedDomains }: { allowedDomains: string[] }) {
  const [state, formAction, pending] = useActionState(signupAction, initialState);
  const t = useTranslations('auth');
  // Pre-fill from a team invite link (?email=...). Read-only convenience —
  // signupAction still validates + lowercases the submitted value.
  const searchParams = useSearchParams();
  const invitedEmail = searchParams.get('email') ?? '';

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-gray-900">{t('signupTitle')}</h1>
        <p className="mt-1 text-sm text-gray-500">{t('signupSubtitle')}</p>

        <form action={formAction} className="mt-6 space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700">
              E-mailadres
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              defaultValue={invitedEmail}
              autoComplete="email"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
            />
            {allowedDomains.length > 0 && (
              <p className="mt-1 text-xs text-gray-500">
                Alleen {allowedDomains.map((d) => `@${d}`).join(', ')} e-mailadressen.
              </p>
            )}
            {state.fieldErrors?.email && (
              <p className="mt-1 text-xs text-red-600">{state.fieldErrors.email}</p>
            )}
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700">
              Wachtwoord
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
            />
            <p className="mt-1 text-xs text-gray-500">
              Minstens 10 tekens, met één cijfer of symbool.
            </p>
            {state.fieldErrors?.password && (
              <p className="mt-1 text-xs text-red-600">{state.fieldErrors.password}</p>
            )}
          </div>

          <div>
            <label htmlFor="consent" className="flex items-start gap-2 text-sm text-gray-700">
              <input
                id="consent"
                name="consent"
                type="checkbox"
                required
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900"
              />
              <span>
                {t('consentPrefix')}{' '}
                <a
                  href="/terms"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-gray-900 underline"
                >
                  {t('consentTerms')}
                </a>{' '}
                {t('consentAnd')}{' '}
                <a
                  href="/privacy"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-gray-900 underline"
                >
                  {t('consentPrivacy')}
                </a>
                {t('consentSuffix')}
              </span>
            </label>
            {state.fieldErrors?.consent && (
              <p className="mt-1 text-xs text-red-600">{state.fieldErrors.consent}</p>
            )}
          </div>

          {state.error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {state.error}
            </div>
          )}

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {pending ? 'Account aanmaken…' : 'Account aanmaken'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-500">
          {t('signupExistingAccount')}{' '}
          <a href="/login" className="font-medium text-gray-900 hover:underline">
            {t('loginTitle')}
          </a>
        </p>
      </div>
    </main>
  );
}
