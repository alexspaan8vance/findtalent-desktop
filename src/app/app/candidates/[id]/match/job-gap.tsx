'use client';

import { useTranslations } from 'next-intl';

import type { JobGapResult } from './actions';

/**
 * Presentational gap-analysis primitives shared by the matched-job DETAIL panel
 * (see JobDetailPanel in match-client). Given a resolved `getJobGapAction`
 * result, `GapSkills` renders the JOB's required skills color-coded matched
 * (accent) / missing (gap, var(--ft-gap-*)), with a "X of Y matched" header and
 * a clear note when the feed job exposed no required-skill rows. `GapRow` and
 * `DetailLine` are the small label/value layout helpers reused for the detail
 * fields. The fetch + the panel chrome (slide-over, focus, Esc) live in
 * match-client so the gap is folded INTO the detail view rather than a separate
 * per-card disclosure.
 */

export function GapSkills({
  result,
}: {
  result: Extract<JobGapResult, { ok: true }>;
}): React.ReactElement {
  const t = useTranslations('candidateMatch');

  return (
    <GapRow label={t('gap.skills')}>
      {result.skills.length === 0 ? (
        <span className="text-[11px] text-[var(--ft-muted)]">
          {result.approximate ? t('gap.noJobSkills') : t('gap.noSkillData')}
        </span>
      ) : (
        <>
          <p className="mb-1.5 text-[11px] font-medium text-[var(--ft-muted)]">
            {t('gap.matched', {
              matched: result.matchedCount,
              total: result.totalCount,
            })}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {result.skills.map((s, i) => (
              <span
                key={`${s.name}-${i}`}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                  s.matched
                    ? 'border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]'
                    : 'border-[var(--ft-gap-line)] bg-[var(--ft-gap-soft)] text-[var(--ft-gap)]'
                }`}
                title={s.matched ? t('gap.hasSkill') : t('gap.missingSkill')}
              >
                {s.name}
                <span aria-hidden="true" className="text-[9px] opacity-80">
                  {s.matched ? '✓' : '✕'}
                </span>
              </span>
            ))}
          </div>
        </>
      )}
    </GapRow>
  );
}

export function DetailLine({
  label,
  value,
}: {
  label: string;
  value: string | null;
}): React.ReactElement | null {
  if (!value) return null;
  return (
    <div className="flex gap-1.5 text-[11px]">
      <dt className="font-medium text-[var(--ft-muted)]">{label}</dt>
      <dd className="text-[var(--ft-ink)]">{value}</dd>
    </div>
  );
}

export function GapRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-3">
      <div className="pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ft-muted)]">
        {label}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
