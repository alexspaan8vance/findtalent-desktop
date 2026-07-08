'use client';

/**
 * Owner-only switch for the org-wide "confirm before moving a candidate to
 * another pipeline stage" guard. Posts to `setConfirmStageMoves` and refreshes.
 * Non-owners see the current state read-only (disabled switch + a note).
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { setConfirmStageMoves } from './actions';

interface Labels {
  title: string;
  hint: string;
  ownerOnly: string;
  on: string;
  off: string;
  saved: string;
  errInternal: string;
}

export function ConfirmMovesToggle({
  enabled,
  canEdit,
  labels,
}: {
  enabled: boolean;
  canEdit: boolean;
  labels: Labels;
}): React.ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useState(enabled);
  const [note, setNote] = useState('');

  function toggle(): void {
    if (!canEdit || pending) return;
    const next = !optimistic;
    setOptimistic(next);
    setNote('');
    const fd = new FormData();
    if (next) fd.set('enabled', 'on');
    startTransition(async () => {
      const res = await setConfirmStageMoves(fd);
      if (!res.ok) {
        setOptimistic(!next); // roll back
        setNote(labels.errInternal);
      } else {
        setNote(labels.saved);
      }
      router.refresh();
    });
  }

  return (
    <section className="rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface)] p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--ft-ink)' }}>
            {labels.title}
          </h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--ft-ink)', opacity: 0.65 }}>
            {labels.hint}
          </p>
          {!canEdit && (
            <p className="mt-1 text-xs" style={{ color: 'var(--ft-muted)' }}>
              {labels.ownerOnly}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            type="button"
            role="switch"
            aria-checked={optimistic}
            aria-label={labels.title}
            disabled={!canEdit || pending}
            onClick={toggle}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-60 ${
              optimistic ? 'bg-[var(--ft-accent)]' : 'bg-[var(--ft-border-strong)]'
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                optimistic ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
          <span className="text-[11px] font-medium tabular-nums" style={{ color: 'var(--ft-muted)' }}>
            {optimistic ? labels.on : labels.off}
          </span>
        </div>
      </div>
      {note && (
        <p className="mt-2 text-xs" style={{ color: 'var(--ft-muted)' }} role="status">
          {note}
        </p>
      )}
    </section>
  );
}
