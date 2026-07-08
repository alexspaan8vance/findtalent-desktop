'use client';

/**
 * Import a pool-only 8vance talent into a local Candidate, then jump to its
 * /match screen (where it can be noted/edited/tracked). Renders on the
 * read-through pool profile page. NEVER writes to 8vance — the server action
 * only mirrors a local row (org-guarded, dedupes by 8vance talentId).
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { importPoolTalentAction } from '../../actions';

export function ImportPoolTalentButton({
  tenantId,
  talentId,
}: {
  tenantId: string;
  talentId: number;
}) {
  const t = useTranslations('candidates');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(false);

  function onClick() {
    setError(false);
    startTransition(async () => {
      const res = await importPoolTalentAction({ tenantId, talentId });
      if (!res.ok) {
        setError(true);
        return;
      }
      router.push(`/app/candidates/${res.candidateId}/match`);
    });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="rounded-lg bg-[var(--ft-ink)] px-3 py-1.5 text-sm font-medium text-[var(--ft-surface)] hover:opacity-90 disabled:opacity-50"
      title={t('poolImportHint')}
    >
      {error ? t('poolImportError') : pending ? t('poolImportWorking') : t('poolImport')}
    </button>
  );
}
