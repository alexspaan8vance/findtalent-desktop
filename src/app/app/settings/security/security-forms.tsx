'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';

import {
  changePasswordAction,
  changeEmailAction,
  type PasswordState,
  type EmailState,
} from './actions';

const inputCls =
  'mt-1 block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none';
const btnCls =
  'rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50';

const pwInitial: PasswordState = { ok: false };
const emailInitial: EmailState = { ok: false };

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(changePasswordAction, pwInitial);
  const t = useTranslations('security');

  return (
    <form action={formAction} className="mt-4 space-y-4">
      {state.ok && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {t('passwordSaved')}
        </div>
      )}
      {state.error === 'no_password' && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {t('noPassword')}
        </div>
      )}

      <div>
        <label htmlFor="pw-current" className="block text-sm font-medium text-zinc-700">
          {t('currentPasswordLabel')}
        </label>
        <input
          id="pw-current"
          name="current"
          type="password"
          required
          autoComplete="current-password"
          className={inputCls}
        />
        {state.fieldErrors?.current && (
          <p className="mt-1 text-xs text-red-600">
            {state.fieldErrors.current === 'wrong'
              ? t('currentPasswordWrong')
              : state.fieldErrors.current}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="pw-new" className="block text-sm font-medium text-zinc-700">
          {t('newPasswordLabel')}
        </label>
        <input
          id="pw-new"
          name="password"
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
          className={inputCls}
        />
        <p className="mt-1 text-xs text-zinc-500">{t('passwordHint')}</p>
        {state.fieldErrors?.password && (
          <p className="mt-1 text-xs text-red-600">{state.fieldErrors.password}</p>
        )}
      </div>

      <div>
        <label htmlFor="pw-confirm" className="block text-sm font-medium text-zinc-700">
          {t('confirmPasswordLabel')}
        </label>
        <input
          id="pw-confirm"
          name="confirm"
          type="password"
          required
          autoComplete="new-password"
          className={inputCls}
        />
        {state.fieldErrors?.confirm && (
          <p className="mt-1 text-xs text-red-600">{state.fieldErrors.confirm}</p>
        )}
      </div>

      <button type="submit" disabled={pending} className={btnCls}>
        {pending ? t('saving') : t('changePassword')}
      </button>
    </form>
  );
}

export function ChangeEmailForm({ currentEmail }: { currentEmail: string }) {
  const [state, formAction, pending] = useActionState(changeEmailAction, emailInitial);
  const t = useTranslations('security');

  return (
    <form action={formAction} className="mt-4 space-y-4">
      {state.ok && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {t('emailConfirmSent')}
        </div>
      )}
      {state.error === 'no_password' && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {t('noPassword')}
        </div>
      )}

      <p className="text-sm text-zinc-600">
        {t('currentEmail')}: <span className="font-medium text-zinc-900">{currentEmail}</span>
      </p>

      <div>
        <label htmlFor="em-new" className="block text-sm font-medium text-zinc-700">
          {t('newEmailLabel')}
        </label>
        <input
          id="em-new"
          name="newEmail"
          type="email"
          required
          autoComplete="email"
          className={inputCls}
        />
        {state.fieldErrors?.newEmail && (
          <p className="mt-1 text-xs text-red-600">
            {state.fieldErrors.newEmail === 'taken'
              ? t('emailTaken')
              : state.fieldErrors.newEmail === 'same'
                ? t('emailSame')
                : t('emailInvalid')}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="em-current" className="block text-sm font-medium text-zinc-700">
          {t('currentPasswordLabel')}
        </label>
        <input
          id="em-current"
          name="current"
          type="password"
          required
          autoComplete="current-password"
          className={inputCls}
        />
        {state.fieldErrors?.current && (
          <p className="mt-1 text-xs text-red-600">
            {state.fieldErrors.current === 'wrong'
              ? t('currentPasswordWrong')
              : state.fieldErrors.current}
          </p>
        )}
      </div>

      <button type="submit" disabled={pending} className={btnCls}>
        {pending ? t('saving') : t('changeEmail')}
      </button>
    </form>
  );
}
