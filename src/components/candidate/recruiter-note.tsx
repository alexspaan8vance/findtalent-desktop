'use client';

/**
 * Inline-editable recruiter note for the OWNER's candidate-detail page.
 *
 * Shows the stored `profileJson.note`; clicking "Edit" reveals a textarea that
 * saves via the `updateCandidateNote` server action (org-guarded server-side).
 * On success the route is revalidated by the action, so the persisted value is
 * what re-renders. The note syncs to 8vance `about_me` on the next sync — this
 * editor never forces a re-sync.
 */
import { useState, useTransition } from 'react';

import type { UpdateNoteResult } from '@/app/app/candidates/[id]/match/actions';

const MAX_NOTE_LEN = 2000;

export interface RecruiterNoteLabels {
  title: string;
  empty: string;
  edit: string;
  save: string;
  saving: string;
  cancel: string;
  errTooLong: string;
  errFailed: string;
  hint: string;
}

export function RecruiterNote({
  candidateId,
  initialNote,
  labels,
  save,
}: {
  candidateId: string;
  initialNote: string;
  labels: RecruiterNoteLabels;
  /** Bound server action (kept in the page's actions.ts). */
  save: (candidateId: string, note: string) => Promise<UpdateNoteResult>;
}): React.ReactElement {
  const [note, setNote] = useState(initialNote);
  const [draft, setDraft] = useState(initialNote);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSave(): void {
    setError(null);
    startTransition(async () => {
      const result = await save(candidateId, draft);
      if (result.ok) {
        setNote(draft.trim());
        setEditing(false);
      } else {
        setError(result.reason === 'too_long' ? labels.errTooLong : labels.errFailed);
      }
    });
  }

  function onCancel(): void {
    setDraft(note);
    setError(null);
    setEditing(false);
  }

  return (
    <section className="rounded-xl border border-[var(--ft-border)] bg-[var(--ft-surface)] p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--ft-muted)]">
          {labels.title}
        </h2>
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setDraft(note);
              setEditing(true);
            }}
            className="rounded-md border border-[var(--ft-border)] px-2 py-0.5 text-[11px] font-medium text-[var(--ft-muted)] transition hover:border-[var(--ft-border-strong)]"
          >
            {labels.edit}
          </button>
        )}
      </div>

      {editing ? (
        <div className="mt-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={MAX_NOTE_LEN}
            rows={4}
            placeholder={labels.hint}
            className="w-full resize-y rounded-lg border border-[var(--ft-border)] bg-[var(--ft-surface-2)] px-3 py-2 text-sm text-[var(--ft-ink)] outline-none focus:border-[var(--ft-accent)]"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11px] text-[var(--ft-muted)] tabular-nums">
              {draft.length}/{MAX_NOTE_LEN}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onCancel}
                disabled={pending}
                className="rounded-md border border-[var(--ft-border)] px-3 py-1 text-xs font-medium text-[var(--ft-muted)] transition hover:border-[var(--ft-border-strong)] disabled:opacity-60"
              >
                {labels.cancel}
              </button>
              <button
                type="button"
                onClick={onSave}
                disabled={pending}
                className="rounded-md border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-3 py-1 text-xs font-semibold text-[var(--ft-accent-strong)] transition disabled:opacity-60"
              >
                {pending ? labels.saving : labels.save}
              </button>
            </div>
          </div>
          {error && (
            <p role="alert" className="mt-1 text-xs font-medium text-red-600">
              {error}
            </p>
          )}
        </div>
      ) : (
        <p className="mt-1 whitespace-pre-wrap leading-relaxed text-[var(--ft-ink)]">
          {note || <span className="text-[var(--ft-muted)]">{labels.empty}</span>}
        </p>
      )}
    </section>
  );
}
