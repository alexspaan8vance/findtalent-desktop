'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

import type { RevealActionResult, RevealReason } from './actions';

interface Props {
  matchId: string;
  action: (matchId: string) => Promise<RevealActionResult>;
}

export function RevealButton({ matchId, action }: Props): React.ReactElement {
  const router = useRouter();
  const t = useTranslations('reveal');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [needCredits, setNeedCredits] = useState(false);

  const messageFor = (reason: RevealReason, expiresAt?: string): string => {
    switch (reason) {
      case 'insufficient_credits':
        return t('errInsufficientCredits');
      case 'locked':
        return expiresAt
          ? t('errLockedUntil', { date: new Date(expiresAt).toLocaleDateString() })
          : t('errLocked');
      case 'not_found':
        return t('errNotFound');
      case 'past_due':
        return t('errPastDue');
      default:
        return t('errInternal');
    }
  };

  const onClick = (): void => {
    setError(null);
    setNeedCredits(false);
    startTransition(async () => {
      const res = await action(matchId);
      if (res.ok) {
        router.refresh();
      } else {
        setNeedCredits(res.reason === 'insufficient_credits');
        setError(messageFor(res.reason, res.expiresAt));
      }
    });
  };

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
      >
        {pending ? t('ctaPending') : t('cta')}
      </button>
      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
          {needCredits && (
            <>
              {' '}
              <Link href="/billing/choose-plan" className="font-medium underline">
                {t('buyCredits')}
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}
