'use client';

/**
 * PUBLIC website-registration form. Unauthenticated: anyone with the stable
 * per-pool link can register. Collects name + email + optional phone + optional
 * CV paste + a REQUIRED consent checkbox, then calls the public server action.
 *
 * No 8vance reference-data autocomplete here (those endpoints need an authed
 * API user) and NO skills are collected — the recruiter resolves skills later
 * when reviewing. The action never writes to 8vance; it only creates a local
 * ONBOARDING candidate in the pool.
 */

import { useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

import {
  submitPublicApplicationAction,
  type PublicApplyResult,
} from '@/app/app/candidates/actions';

export function ApplyForm({ slug }: { slug: string }) {
  const t = useTranslations('apply');
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [cvText, setCvText] = useState('');
  // GDPR Art.13/14 — applicant consents to processing. Required to submit.
  const [consent, setConsent] = useState(false);

  const canSubmit = useMemo(
    () =>
      name.trim().length >= 2 &&
      /.+@.+\..+/.test(email.trim()) &&
      consent,
    [name, email, consent],
  );

  function reasonMessage(reason: Exclude<PublicApplyResult, { ok: true }>['reason']): string {
    switch (reason) {
      case 'rate_limited':
        return t('errorRateLimited');
      case 'no_tenant':
        return t('errorNoPool');
      case 'invalid':
        return t('errorInvalid');
      default:
        return t('errorInternal');
    }
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await submitPublicApplicationAction(slug, {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
        cvText: cvText.trim() || undefined,
        consent,
      });
      if (!res.ok) {
        setError(reasonMessage(res.reason));
        return;
      }
      setDone(true);
    });
  }

  if (done) {
    return (
      <div
        className="rounded-xl border p-6 text-center"
        style={{
          background: 'var(--ft-accent-soft)',
          borderColor: 'var(--ft-accent-line)',
        }}
      >
        <h2 className="text-base font-semibold" style={{ color: 'var(--ft-accent-strong)' }}>
          {t('successTitle')}
        </h2>
        <p className="mt-2 text-sm" style={{ color: 'var(--ft-ink)' }}>
          {t('successBody')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div>
          <label htmlFor="apply-name" className="block text-sm font-medium" style={{ color: 'var(--ft-ink)' }}>
            {t('nameLabel')}
            <span className="ml-1" style={{ color: 'var(--ft-gap)' }}>*</span>
          </label>
          <input
            id="apply-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('namePlaceholder')}
            maxLength={160}
            autoComplete="name"
            className="mt-1 block w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
            style={{ borderColor: 'var(--ft-border-strong)' }}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="apply-email" className="block text-sm font-medium" style={{ color: 'var(--ft-ink)' }}>
              {t('emailLabel')}
              <span className="ml-1" style={{ color: 'var(--ft-gap)' }}>*</span>
            </label>
            <input
              id="apply-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('emailPlaceholder')}
              maxLength={200}
              autoComplete="email"
              className="mt-1 block w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
              style={{ borderColor: 'var(--ft-border-strong)' }}
            />
          </div>
          <div>
            <label htmlFor="apply-phone" className="block text-sm font-medium" style={{ color: 'var(--ft-ink)' }}>
              {t('phoneLabel')}
            </label>
            <input
              id="apply-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={40}
              autoComplete="tel"
              className="mt-1 block w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
              style={{ borderColor: 'var(--ft-border-strong)' }}
            />
          </div>
        </div>
      </div>

      <div>
        <label htmlFor="apply-cv" className="block text-sm font-medium" style={{ color: 'var(--ft-ink)' }}>
          {t('cvLabel')}
        </label>
        <p className="mt-1 text-xs" style={{ color: 'var(--ft-muted)' }}>
          {t('cvHint')}
        </p>
        <textarea
          id="apply-cv"
          rows={10}
          value={cvText}
          onChange={(e) => setCvText(e.target.value)}
          maxLength={50000}
          placeholder={t('cvPlaceholder')}
          className="mt-2 block w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
          style={{ borderColor: 'var(--ft-border-strong)' }}
        />
      </div>

      <div
        className="rounded-lg border p-4"
        style={{ background: 'var(--ft-surface-2)', borderColor: 'var(--ft-border)' }}
      >
        <p className="text-xs" style={{ color: 'var(--ft-muted)' }}>
          {t('consentNotice')}{' '}
          <a
            href="/privacy"
            target="_blank"
            rel="noreferrer"
            className="font-medium underline"
            style={{ color: 'var(--ft-ink)' }}
          >
            {t('consentPrivacyLink')}
          </a>
          {t('consentRetention')}
        </p>
        <label className="mt-3 flex items-start gap-2 text-sm" style={{ color: 'var(--ft-ink)' }}>
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded"
          />
          <span>
            {t('consentLabel')}
            <span className="ml-1" style={{ color: 'var(--ft-gap)' }}>*</span>
          </span>
        </label>
      </div>

      {error ? (
        <div
          className="rounded-lg border px-4 py-3 text-sm"
          style={{
            background: 'var(--ft-gap-soft)',
            borderColor: 'var(--ft-gap-line)',
            color: 'var(--ft-gap)',
          }}
        >
          {error}
        </div>
      ) : null}

      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit || pending}
        className="w-full rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-40"
        style={{ background: 'var(--ft-accent)', color: 'var(--ft-accent-fg)' }}
      >
        {pending ? t('submitting') : t('submit')}
      </button>
    </div>
  );
}
