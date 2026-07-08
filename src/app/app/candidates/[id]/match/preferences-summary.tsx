'use client';

/**
 * Read-only summary of the candidate's captured work-preferences — the
 * "recruiter's head" data (travel, regions, salary, hours, work setting,
 * availability, relocation). Rendered on the match page so the tacit info the
 * recruiter entered at onboarding is visible (and drives the match), not
 * write-only. Purely presentational.
 */
import { useLocale, useTranslations } from 'next-intl';

import {
  effectiveTravelKm,
  educationTravelStatement,
  highestEduTier,
  type CandidatePreferences,
} from '@/lib/candidate/preferences';

export interface PreferencesSummaryProps {
  preferences: Partial<CandidatePreferences> | null;
  /** Parsed education (for the education-level travel default). */
  education?: Array<{ degree?: string | null }> | null;
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--ft-border)] bg-[var(--ft-surface)] px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-[var(--ft-muted)]">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-[var(--ft-ink)]">{value}</div>
    </div>
  );
}

export function PreferencesSummary({ preferences, education }: PreferencesSummaryProps) {
  const t = useTranslations('candidates');
  const locale = useLocale();
  const p = preferences ?? {};
  const tier = highestEduTier(education);
  const travel = effectiveTravelKm(p, tier);
  const travelExplicit =
    (typeof p.maxTravelKm === 'number' && p.maxTravelKm > 0) ||
    (typeof p.radiusKm === 'number' && p.radiusKm > 0);

  const chips: Array<{ label: string; value: string }> = [];
  const eduStmt = educationTravelStatement(tier);
  chips.push({
    label: t('summaryTravel'),
    value: travelExplicit
      ? t('radiusValue', { km: travel })
      : eduStmt
        ? t('summaryTravelEdu', { km: eduStmt.km, min: eduStmt.minutes, mode: t(`travelMode_${eduStmt.mode}`) })
        : t('summaryTravelHeuristic', { km: travel }),
  });
  if (p.workRegions && p.workRegions.length > 0) {
    chips.push({ label: t('workRegionsLabel'), value: p.workRegions.map((r) => r.label).join(', ') });
  }
  if (p.salary && (p.salary.min != null || p.salary.max != null)) {
    // Locale-aware amounts (nl: "€ 3.000–4.500") instead of raw "€3000–4500".
    const nf = new Intl.NumberFormat(locale);
    const range =
      p.salary.min != null && p.salary.max != null
        ? `${nf.format(p.salary.min)}–${nf.format(p.salary.max)}`
        : p.salary.min != null
          ? `${nf.format(p.salary.min)}+`
          : `≤${nf.format(p.salary.max as number)}`;
    chips.push({ label: t('salaryLabel'), value: `€ ${range} ${t(`salaryPeriod_${p.salary.period}`)}` });
  }
  if (typeof p.hoursPerWeek === 'number') {
    chips.push({ label: t('hoursLabel'), value: `${p.hoursPerWeek} ${t('summaryHoursUnit')}` });
  }
  if (p.workMode) chips.push({ label: t('workModeLabel'), value: t(`workMode_${p.workMode}`) });
  if (p.availability) {
    chips.push({ label: t('availabilityLabel'), value: t(`availability_${p.availability}`) });
  }
  if (p.willingToRelocate) chips.push({ label: t('relocateLabel'), value: t('summaryYes') });

  if (chips.length === 0) return null;

  return (
    <section className="rounded-xl border border-[var(--ft-border)] bg-[var(--ft-surface-2)] p-4">
      <h3 className="text-sm font-semibold text-[var(--ft-ink)]">{t('summaryTitle')}</h3>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {chips.map((c) => (
          <Chip key={c.label} label={c.label} value={c.value} />
        ))}
      </div>
    </section>
  );
}
