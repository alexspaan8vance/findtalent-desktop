'use client';

/**
 * Project-detail header controls: "Refresh matches" (re-run the async match)
 * and Archive / Unarchive. Both call org-guarded server actions and refresh
 * the route. Archive is reversible so no confirmation prompt is shown.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

import type { ProjectActionResult } from '../actions';

interface Props {
  projectId: string;
  isArchived: boolean;
  isClosed: boolean;
  rerun: (projectId: string) => Promise<ProjectActionResult>;
  archive: (projectId: string) => Promise<ProjectActionResult>;
  unarchive: (projectId: string) => Promise<ProjectActionResult>;
  close: (projectId: string) => Promise<ProjectActionResult>;
  reopen: (projectId: string) => Promise<ProjectActionResult>;
}

export function ProjectActions({
  projectId,
  isArchived,
  isClosed,
  rerun,
  archive,
  unarchive,
  close,
  reopen,
}: Props): React.ReactElement {
  const router = useRouter();
  const t = useTranslations('projects');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const messageFor = (res: Extract<ProjectActionResult, { ok: false }>): string => {
    switch (res.reason) {
      case 'precondition':
        return res.message ?? t('rerunPrecondition');
      case 'unavailable':
        return t('rerunUnavailable');
      case 'not_found':
        return t('actionNotFound');
      default:
        return t('actionInternal');
    }
  };

  const run = (action: (id: string) => Promise<ProjectActionResult>): void => {
    setError(null);
    startTransition(async () => {
      const res = await action(projectId);
      if (res.ok) {
        router.refresh();
      } else {
        setError(messageFor(res));
      }
    });
  };

  const confirmClose = (): void => {
    if (typeof window !== 'undefined' && !window.confirm(t('closeConfirm'))) return;
    run(close);
  };

  // A CLOSED project shows only a Reopen affordance — its shortlist + reveals
  // are hidden, so edit/rerun/archive are not offered until it's reopened.
  if (isClosed) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <button
          type="button"
          onClick={() => run(reopen)}
          disabled={pending}
          className="rounded-lg border border-[var(--ft-border)] bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:border-[var(--ft-border-strong)] disabled:opacity-60"
        >
          {t('reopenProject')}
        </button>
        {error && (
          <div className="max-w-xs rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700">
            {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        {!isArchived && (
          <Link
            href={`/app/projects/${projectId}/edit`}
            className="rounded-lg border border-[var(--ft-border)] bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:border-[var(--ft-border-strong)]"
          >
            {t('edit')}
          </Link>
        )}
        {!isArchived && (
          <button
            type="button"
            onClick={() => run(rerun)}
            disabled={pending}
            className="rounded-lg bg-[var(--ft-accent)] px-3 py-1.5 text-sm font-medium text-[var(--ft-accent-fg)] transition hover:opacity-90 disabled:opacity-60"
          >
            {pending ? t('rerunPending') : t('rerunMatch')}
          </button>
        )}
        {!isArchived && (
          <button
            type="button"
            onClick={confirmClose}
            disabled={pending}
            className="rounded-lg border border-[var(--ft-border)] bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:border-[var(--ft-border-strong)] disabled:opacity-60"
          >
            {t('closeProject')}
          </button>
        )}
        <button
          type="button"
          onClick={() => run(isArchived ? unarchive : archive)}
          disabled={pending}
          className="rounded-lg border border-[var(--ft-border)] bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:border-[var(--ft-border-strong)] disabled:opacity-60"
        >
          {isArchived ? t('unarchive') : t('archive')}
        </button>
      </div>
      {error && (
        <div className="max-w-xs rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
