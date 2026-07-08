'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';

import { resetPasswordAction, type ResetState } from './actions';

const initialState: ResetState = { ok: false };

export function ResetForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(resetPasswordAction, initialState);
  const t = useTranslations('auth');

  return (
    <form action={formAction} className="mt-6 space-y-4">
      <input type="hidden" name="token" value={token} />

      <div>
        <label htmlFor="password" className="block text-sm font-medium text-gray-700">
          {t('newPasswordLabel')}
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
        <p className="mt-1 text-xs text-gray-500">{t('passwordHint')}</p>
        {state.fieldErrors?.password && (
          <p className="mt-1 text-xs text-red-600">{state.fieldErrors.password}</p>
        )}
      </div>

      <div>
        <label htmlFor="confirm" className="block text-sm font-medium text-gray-700">
          {t('confirmPasswordLabel')}
        </label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          required
          autoComplete="new-password"
          className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
        />
        {state.fieldErrors?.confirm && (
          <p className="mt-1 text-xs text-red-600">{state.fieldErrors.confirm}</p>
        )}
      </div>

      {state.error === 'invalid_token' && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {t('resetInvalidToken')}
        </div>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
      >
        {pending ? t('resetSaving') : t('resetSubmit')}
      </button>
    </form>
  );
}
