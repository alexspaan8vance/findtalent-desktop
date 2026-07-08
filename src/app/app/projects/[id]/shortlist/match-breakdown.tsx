'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';

import type { AnonymizedTalent } from '@/lib/anonymize/types';

/**
 * Per-card "Why this match?" breakdown — an inline, collapsed-by-default
 * expansion that mirrors 8vance's match-insight panel. ANON-ONLY: every value
 * comes straight off the `AnonymizedTalent` payload (no PII, no name/employer).
 *
 * Dimensions:
 *  - Skills    : skills[] as chips. Accent when matched (must_have_match OR
 *                simply present-and-not-gap), muted/gap when `gap` is true.
 *                Shows "X of Y must-haves matched" when must-have data exists.
 *  - Experience: total_years_experience_bucket + ≤3 experience[] roles
 *                (function_title · sector · duration bucket).
 *  - Education : highest education[].level (+ field_of_study_category).
 *  - Languages : languages[] as chips (language + speak_level).
 */

/** Education levels ascending; used to pick the talent's highest level. */
const EDU_RANK_ORDER = [
  'vmbo',
  'mbo',
  'havo',
  'vwo',
  'hbo',
  'bachelor',
  'wo',
  'master',
  'phd',
  'doctorate',
];

function highestEducation(
  edu: AnonymizedTalent['education'],
): AnonymizedTalent['education'][number] | null {
  if (edu.length === 0) return null;
  let best = edu[0];
  let bestRank = EDU_RANK_ORDER.indexOf((best.level ?? '').trim().toLowerCase());
  for (const e of edu.slice(1)) {
    const r = EDU_RANK_ORDER.indexOf((e.level ?? '').trim().toLowerCase());
    if (r > bestRank) {
      best = e;
      bestRank = r;
    }
  }
  return best;
}

export function MatchBreakdown({
  talent,
}: {
  talent: AnonymizedTalent;
}): React.ReactElement {
  const t = useTranslations('shortlist');
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const skills = talent.skills;
  // X = matched must-haves; Y = matched + gaps (gaps are the missing must-haves
  // surfaced in anon data). Only show the line when we can observe either.
  const mustMatched = skills.filter((s) => s.must_have_match).length;
  const gapCount = skills.filter((s) => s.gap).length;
  const mustTotal = mustMatched + gapCount;
  const hasMustHaveData = mustTotal > 0;

  const topRoles = talent.experience.slice(0, 3);
  const yearsBucket = talent.total_years_experience_bucket;
  const topEdu = highestEducation(talent.education);

  return (
    <div className="mt-4 border-t border-[var(--ft-border)] pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--ft-accent-strong)] hover:underline"
      >
        <span
          aria-hidden="true"
          className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}
        >
          ▸
        </span>
        {t('whyMatch')}
      </button>

      {open && (
        <div id={panelId} className="mt-3 space-y-3">
          {/* Skills */}
          <BreakdownRow label={t('breakdownSkills')}>
            {skills.length === 0 ? (
              <span className="text-[11px] text-zinc-500">{t('noSkillData')}</span>
            ) : (
              <>
                {hasMustHaveData && (
                  <p className="mb-1.5 text-[11px] font-medium text-zinc-600">
                    {t('mustHaveMatched', { matched: mustMatched, total: mustTotal })}
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {skills.map((s) => (
                    <span
                      key={s.name}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                        s.gap
                          ? 'border-[var(--ft-gap-line)] bg-[var(--ft-gap-soft)] text-[var(--ft-gap)]'
                          : 'border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]'
                      }`}
                      title={s.must_have_match ? t('mustHave') : undefined}
                    >
                      {s.name}
                      {s.must_have_match && (
                        <span aria-hidden="true" className="text-[9px] opacity-80">
                          ★
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              </>
            )}
          </BreakdownRow>

          {/* Experience */}
          <BreakdownRow label={t('breakdownExperience')}>
            {yearsBucket && (
              <p className="text-[11px] font-medium text-zinc-700">
                {t('yearsExperience', { years: yearsBucket })}
              </p>
            )}
            {topRoles.length > 0 ? (
              <ul className="mt-1 space-y-0.5">
                {topRoles.map((e, i) => (
                  <li key={`${e.function_title}-${i}`} className="text-[11px] text-zinc-600">
                    {[e.function_title, e.sector, e.duration_bucket]
                      .filter((v) => v && String(v).trim() !== '')
                      .join(' · ')}
                    {e.is_current && (
                      <span className="ml-1 rounded-full bg-[var(--ft-accent-soft)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--ft-accent-strong)]">
                        {t('currentRole')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              !yearsBucket && (
                <span className="text-[11px] text-zinc-500">{t('breakdownNoData')}</span>
              )
            )}
          </BreakdownRow>

          {/* Education */}
          <BreakdownRow label={t('breakdownEducation')}>
            {topEdu ? (
              <p className="text-[11px] text-zinc-700">
                <span className="font-medium">{topEdu.level}</span>
                {topEdu.field_of_study_category &&
                  topEdu.field_of_study_category.trim() !== '' && (
                    <span className="text-zinc-600"> · {topEdu.field_of_study_category}</span>
                  )}
              </p>
            ) : (
              <span className="text-[11px] text-zinc-500">{t('breakdownNoData')}</span>
            )}
          </BreakdownRow>

          {/* Languages */}
          <BreakdownRow label={t('breakdownLanguages')}>
            {talent.languages.length === 0 ? (
              <span className="text-[11px] text-zinc-500">{t('breakdownNoData')}</span>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {talent.languages.map((l) => (
                  <span
                    key={l.language}
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--ft-border)] bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700"
                  >
                    {l.language}
                    <span className="text-[10px] text-zinc-400">{l.speak_level}</span>
                  </span>
                ))}
              </div>
            )}
          </BreakdownRow>
        </div>
      )}
    </div>
  );
}

function BreakdownRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-3">
      <div className="pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
