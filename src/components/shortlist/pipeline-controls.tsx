'use client';

/**
 * Note + stage control for the talent detail page. Persists via server actions
 * which re-verify project ownership. The note auto-saves on blur and exposes an
 * explicit Save button; both show a transient "saved" confirmation.
 *
 * Stage uses the org's configurable stages when supplied (`stages` +
 * `initialStageId` + `moveAction`); otherwise it falls back to the legacy enum
 * (`initialStage` + `setStageAction`).
 */
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { ShortlistStage } from '@prisma/client';

import { StageSelect, type SelectableStage } from './stage-select';

type SaveResult = { ok: boolean };
type MoveResult = { ok: boolean };

export function PipelineControls({
  matchId,
  initialStage,
  initialNote,
  setStageAction,
  saveNoteAction,
  stages,
  initialStageId,
  moveAction,
}: {
  matchId: string;
  initialStage: ShortlistStage;
  initialNote: string;
  setStageAction: (matchId: string, stage: string) => Promise<SaveResult>;
  saveNoteAction: (matchId: string, note: string) => Promise<SaveResult>;
  /** Org's configurable stages — enables custom-stage mode when present. */
  stages?: readonly SelectableStage[];
  initialStageId?: string | null;
  moveAction?: (matchId: string, stageId: string, position: number) => Promise<MoveResult>;
}): React.ReactElement {
  const t = useTranslations('shortlist');
  const useCustom = Boolean(stages && stages.length > 0 && moveAction);
  const [stage, setStage] = useState<ShortlistStage>(initialStage);
  const [stageId, setStageId] = useState<string>(
    initialStageId ?? (stages && stages.length > 0 ? stages[0].id : ''),
  );
  const [note, setNote] = useState<string>(initialNote);
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  // Last note the server accepted — state (not a ref) because it drives the
  // Save button's disabled prop during render.
  const [lastSaved, setLastSaved] = useState<string>(initialNote);

  const flash = (next: 'saved' | 'error'): void => {
    setStatus(next);
    window.setTimeout(() => setStatus('idle'), 2000);
  };

  const onStage = (next: ShortlistStage): void => {
    setStage(next);
    startTransition(async () => {
      const res = await setStageAction(matchId, next);
      flash(res.ok ? 'saved' : 'error');
    });
  };

  const onStageId = (next: string): void => {
    setStageId(next);
    startTransition(async () => {
      const res = await moveAction!(matchId, next, 0);
      flash(res.ok ? 'saved' : 'error');
    });
  };

  const persistNote = (): void => {
    if (note === lastSaved) return;
    startTransition(async () => {
      const res = await saveNoteAction(matchId, note);
      if (res.ok) setLastSaved(note);
      flash(res.ok ? 'saved' : 'error');
    });
  };

  return (
    <section className="mt-6 rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface)] p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">
          {t('pipelineHeading')}
        </h2>
        {useCustom ? (
          <StageSelect
            stages={stages}
            stageId={stageId}
            onChangeStageId={onStageId}
            disabled={pending}
          />
        ) : (
          <StageSelect value={stage} onChange={onStage} disabled={pending} />
        )}
      </div>

      <label className="mt-4 block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {t('noteLabel')}
      </label>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={persistNote}
        rows={4}
        maxLength={2000}
        placeholder={t('notePlaceholder')}
        className="mt-2 w-full resize-y rounded-xl border border-[var(--ft-border)] bg-[var(--ft-surface-2)] p-3 text-sm text-[var(--ft-ink)] outline-none focus:border-[var(--ft-accent-line)] focus:ring-1 focus:ring-[var(--ft-accent-line)]"
      />

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={persistNote}
          disabled={pending || note === lastSaved}
          className="rounded-lg bg-[var(--ft-accent)] px-3 py-1.5 text-xs font-medium text-[var(--ft-accent-fg)] transition hover:bg-[var(--ft-accent-strong)] disabled:opacity-50"
        >
          {pending ? t('noteSaving') : t('noteSave')}
        </button>
        {status === 'saved' && (
          <span className="text-xs text-[var(--ft-accent-strong)]">{t('noteSaved')}</span>
        )}
        {status === 'error' && (
          <span className="text-xs text-[var(--ft-gap)]">{t('noteError')}</span>
        )}
      </div>
    </section>
  );
}
