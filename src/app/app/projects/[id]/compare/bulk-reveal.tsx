'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

export type BulkRevealStatus =
  | 'revealed'
  | 'insufficient_credits'
  | 'past_due'
  | 'locked'
  | 'error'
  | 'skipped';

export interface BulkRevealResult {
  matchId: string;
  status: BulkRevealStatus;
}

interface Item {
  matchId: string;
  /** Short anonymous handle shown in the per-candidate result list. */
  opaqueId: string;
}

interface Props {
  items: Item[];
  action: (matchIds: string[]) => Promise<BulkRevealResult[]>;
}

/**
 * "Reveal all (N credits)" control on the compare view. Confirms once, then
 * reveals every still-anonymous selected candidate server-side (sequential,
 * stops on insufficient credits) via the shared bulk action and shows a
 * per-candidate result. No PII is handled here — only opaque ids + statuses.
 */
export function BulkReveal({ items, action }: Props): React.ReactElement | null {
  const t = useTranslations('compare');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [results, setResults] = useState<BulkRevealResult[] | null>(null);

  if (items.length === 0) return null;

  const labelFor = (m: string): string => {
    const idx = items.findIndex((i) => i.matchId === m);
    return idx >= 0 ? items[idx].opaqueId : m.slice(0, 8);
  };

  const statusText = (s: BulkRevealStatus): string => {
    switch (s) {
      case 'revealed':
        return t('bulkRevealed');
      case 'insufficient_credits':
        return t('bulkInsufficient');
      case 'past_due':
        return t('bulkPastDue');
      case 'locked':
        return t('bulkLocked');
      case 'skipped':
        return t('bulkSkipped');
      default:
        return t('bulkError');
    }
  };

  const run = (): void => {
    startTransition(async () => {
      const res = await action(items.map((i) => i.matchId));
      setResults(res);
      setConfirming(false);
      router.refresh();
    });
  };

  return (
    <div className="relative">
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={pending}
          className="rounded-lg bg-[var(--ft-accent)] px-3 py-1.5 text-sm font-medium text-[var(--ft-accent-fg)] transition hover:bg-[var(--ft-accent-strong)] disabled:opacity-60"
        >
          {t('bulkRevealCta', { count: items.length })}
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-700">
            {t('bulkConfirm', { count: items.length })}
          </span>
          <button
            type="button"
            onClick={run}
            disabled={pending}
            className="rounded-lg bg-[var(--ft-accent-strong)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
          >
            {pending ? t('bulkPending') : t('bulkConfirmYes')}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={pending}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600"
          >
            {t('bulkConfirmNo')}
          </button>
        </div>
      )}

      {results && (
        <ul className="absolute right-0 z-10 mt-2 w-64 space-y-1 rounded-lg border border-[var(--ft-border)] bg-white p-3 text-xs shadow-lg">
          {results.map((r) => (
            <li key={r.matchId} className="flex items-center justify-between gap-2">
              <span className="font-mono text-zinc-500">{labelFor(r.matchId)}</span>
              <span
                className={
                  r.status === 'revealed'
                    ? 'font-medium text-emerald-700'
                    : r.status === 'skipped'
                      ? 'text-zinc-400'
                      : 'text-red-600'
                }
              >
                {statusText(r.status)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
