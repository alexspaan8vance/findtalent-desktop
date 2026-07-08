'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';

import { forgotPasswordAction, type ForgotState } from './actions';

const initialState: ForgotState = { done: false };

export default function ForgotPasswordPage() {
  const [state, formAction, pending] = useActionState(
    forgotPasswordAction,
    initialState,
  );
  const t = useTranslations('auth');

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-gray-900">{t('forgotTitle')}</h1>
        <p className="mt-1 text-sm text-gray-500">{t('forgotSubtitle')}</p>

        {state.done ? (
          <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            {t('forgotSent')}
          </div>
        ) : (
          <form action={formAction} className="mt-6 space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                {t('emailLabel')}
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {pending ? t('forgotSending') : t('forgotSubmit')}
            </button>
          </form>
        )}

        <p className="mt-6 text-center text-sm text-gray-500">
          <a href="/login" className="font-medium text-gray-900 hover:underline">
            {t('backToLogin')}
          </a>
        </p>
      </div>
    </main>
  );
}
