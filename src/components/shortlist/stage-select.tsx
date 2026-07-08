'use client';

/**
 * Compact pipeline-stage selector with a subtle per-stage tint. Used on the
 * shortlist cards and the talent detail page.
 *
 * Two modes:
 *  - **custom stages** (preferred): pass the org's configurable stages via
 *    `stages` + the current `stageId` + an `onChangeStageId` callback. Options
 *    render the stage names with a swatch in each stage's own color.
 *  - **legacy fallback**: when no `stages` are provided it falls back to the
 *    fixed `ShortlistStage` enum so the control keeps working if stages load
 *    lazily / are unavailable.
 *
 * Stateless — the parent owns the value and persists changes.
 */
import { useTranslations } from 'next-intl';
import { ShortlistStage } from '@prisma/client';

import { stageDisplayName } from '@/lib/pipeline-stage-label';

export interface SelectableStage {
  id: string;
  name: string;
  color: string;
}

const LEGACY_STAGES: readonly ShortlistStage[] = [
  ShortlistStage.NEW,
  ShortlistStage.SHORTLISTED,
  ShortlistStage.CONTACTED,
  ShortlistStage.REJECTED,
];

// Calm, low-saturation tints aligned with the evergreen theme (legacy mode).
const LEGACY_STYLE: Readonly<Record<ShortlistStage, string>> = {
  NEW: 'border-[var(--ft-border)] bg-[var(--ft-surface-2)] text-zinc-600',
  SHORTLISTED:
    'border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]',
  CONTACTED: 'border-amber-200 bg-amber-50 text-amber-800',
  REJECTED: 'border-[var(--ft-gap-line)] bg-[var(--ft-gap-soft)] text-[var(--ft-gap)]',
};

export function StageSelect(props: {
  // Legacy enum mode
  value?: ShortlistStage;
  onChange?: (stage: ShortlistStage) => void;
  // Custom-stage mode
  stages?: readonly SelectableStage[];
  stageId?: string | null;
  onChangeStageId?: (stageId: string) => void;
  disabled?: boolean;
}): React.ReactElement {
  const t = useTranslations('shortlist');
  // Seeded default-stage names ("Inflow", "Hired", …) are canonical English in
  // the DB; localize them at render. Custom names render verbatim.
  const tStages = useTranslations('pipeline');
  const { stages, stageId, onChangeStageId, value, onChange, disabled = false } = props;

  // Custom-stage mode when an org stage set is supplied.
  if (stages && stages.length > 0) {
    const current = stages.find((s) => s.id === stageId) ?? stages[0];
    return (
      <label className="flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          {t('stageLabel')}
        </span>
        <select
          value={current?.id ?? ''}
          disabled={disabled}
          onChange={(e) => onChangeStageId?.(e.target.value)}
          aria-label={t('stageLabel')}
          className="rounded-md border px-2 py-1 text-xs font-medium transition disabled:opacity-50"
          style={{
            borderColor: current?.color ?? 'var(--ft-border)',
            color: current?.color ?? 'var(--ft-ink)',
          }}
        >
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {stageDisplayName(s.name, tStages)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  // Legacy enum fallback.
  const legacyValue = value ?? ShortlistStage.NEW;
  return (
    <label className="flex items-center gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {t('stageLabel')}
      </span>
      <select
        value={legacyValue}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.value as ShortlistStage)}
        aria-label={t('stageLabel')}
        className={`rounded-md border px-2 py-1 text-xs font-medium transition disabled:opacity-50 ${LEGACY_STYLE[legacyValue]}`}
      >
        {LEGACY_STAGES.map((s) => (
          <option key={s} value={s}>
            {t(`stage_${s}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
