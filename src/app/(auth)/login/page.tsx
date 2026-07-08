import { getTranslations } from 'next-intl/server';

import { LoginForm } from './login-form';

type Props = {
  searchParams?: Promise<{ from?: string; verified?: string; reset?: string }>;
};

export default async function LoginPage({ searchParams }: Props) {
  const sp = searchParams ? await searchParams : undefined;
  const from = sp?.from ?? '';
  const verified = sp?.verified === '1';
  const reset = sp?.reset === '1';
  const t = await getTranslations('auth');

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-gray-900">{t('loginTitle')}</h1>
        <p className="mt-1 text-sm text-gray-500">{t('loginSubtitle')}</p>
        <LoginForm from={from} verified={verified} reset={reset} />
        <p className="mt-4 text-center text-sm text-gray-500">
          <a href="/forgot-password" className="font-medium text-gray-900 hover:underline">
            {t('forgotLink')}
          </a>
        </p>
        <p className="mt-2 text-center text-sm text-gray-500">
          {t('loginNoAccount')}{' '}
          <a href="/signup" className="font-medium text-gray-900 hover:underline">
            {t('loginCreateAccount')}
          </a>
        </p>
      </div>
    </main>
  );
}
