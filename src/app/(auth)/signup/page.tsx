import { getTranslations } from 'next-intl/server';

import { getSignupPolicy } from '@/lib/signup-policy';

import SignupFormShell from './signup-form';

// The policy reads env at request time (SIGNUP_ALLOWED_DOMAINS may change
// between deploys of the same build) — never prerender a stale gate.
export const dynamic = 'force-dynamic';

/**
 * Server wrapper around the signup form. When the signup policy resolves to
 * 'closed' (SIGNUP_ALLOWED_DOMAINS unset in production — fail-closed for an
 * internal tool on a public Funnel URL) we render a disabled notice instead of
 * the form. The server action re-validates regardless, so this is UX, not the
 * security boundary.
 */
export default async function SignupPage() {
  const policy = getSignupPolicy();

  if (policy.mode === 'closed') {
    const t = await getTranslations('auth');
    return (
      <main className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
          <h1 className="text-2xl font-semibold text-gray-900">{t('signupClosedTitle')}</h1>
          <p className="mt-2 text-sm text-gray-600">{t('signupClosedBody')}</p>
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

  return (
    <SignupFormShell
      allowedDomains={policy.mode === 'domains' ? policy.domains : []}
    />
  );
}
