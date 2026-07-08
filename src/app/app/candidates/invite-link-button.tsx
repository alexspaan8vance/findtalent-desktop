'use client';

/**
 * Small client button that mints (or rotates) a self-onboard magic link for a
 * candidate and copies the absolute URL to the clipboard. Surfaced in the
 * candidates list so a recruiter can hand a link to the candidate.
 */

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

import { createPortalInviteAction } from './actions';

export function InviteLinkButton({
  candidateId,
  label,
  variant = 'default',
}: {
  candidateId: string;
  label: string;
  /** 'muted' renders a small, de-emphasized text link (tucked-away secondary). */
  variant?: 'default' | 'muted';
}) {
  const t = useTranslations('candidates');
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  function onClick() {
    setError(false);
    setCopied(false);
    startTransition(async () => {
      const res = await createPortalInviteAction(candidateId);
      if (!res.ok) {
        setError(true);
        return;
      }
      const abs =
        typeof window !== 'undefined' ? `${window.location.origin}${res.url}` : res.url;
      try {
        await navigator.clipboard.writeText(abs);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      } catch {
        // Clipboard blocked — show the URL via prompt as a fallback.
        if (typeof window !== 'undefined') window.prompt(t('inviteCopyFallback'), abs);
      }
    });
  }

  const className =
    variant === 'muted'
      ? 'rounded-md px-1.5 py-1 text-xs text-zinc-400 underline-offset-2 hover:text-zinc-600 hover:underline disabled:opacity-50'
      : 'rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:opacity-50';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className={className}
      title={t('inviteLinkHint')}
    >
      {error ? t('inviteError') : copied ? t('inviteCopied') : pending ? t('inviteWorking') : label}
    </button>
  );
}
