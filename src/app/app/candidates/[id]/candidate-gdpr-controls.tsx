'use client';

/**
 * Recruiter-facing GDPR controls for a single candidate:
 *   - Export data (GDPR Art.20): downloads the org-guarded JSON dump.
 *   - Delete candidate (GDPR Art.17): confirm-gated hard delete, then routes
 *     back to the candidates list.
 *
 * Both hit the org-guarded API routes under /api/candidates/[id]/. Mirrors the
 * existing zinc button styling used across the candidate UI.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

export function CandidateGdprControls({ candidateId }: { candidateId: string }) {
  const t = useTranslations('candidates');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function exportData() {
    // Anchor-style download; the route sets content-disposition: attachment.
    window.location.href = `/api/candidates/${candidateId}/export`;
  }

  function doDelete() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/candidates/${candidateId}/delete`, {
        method: 'POST',
      });
      if (res.ok) {
        router.push('/app/candidates');
        router.refresh();
        return;
      }
      setError(t('deleteError'));
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={exportData}
          className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
        >
          {t('exportData')}
        </button>
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
          >
            {t('deleteCandidate')}
          </button>
        ) : (
          <span className="flex items-center gap-2">
            <span className="text-xs text-zinc-700">{t('deleteConfirm')}</span>
            <button
              type="button"
              disabled={pending}
              onClick={doDelete}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
            >
              {pending ? t('deleteWorking') : t('deleteConfirmYes')}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirming(false)}
              className="text-xs text-zinc-500 hover:text-zinc-700"
            >
              {t('deleteCancel')}
            </button>
          </span>
        )}
      </div>
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
