'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { RevealedTalent } from '@/lib/anonymize/types';
import type { OutreachActionResult } from './actions';

interface Props {
  talent: RevealedTalent;
  matchId: string;
  /**
   * True when this PII is visible because a TEAMMATE revealed the candidate on
   * this project (project-scoped shared reveal), not the viewer's own reveal.
   * Anonymity/GDPR: we never disclose which colleague revealed them.
   */
  shared?: boolean;
  /** ISO date of the first recorded outreach, or null if not contacted yet. */
  contactedAt: string | null;
  outreachAction: (matchId: string) => Promise<OutreachActionResult>;
}

/**
 * Client component shown when a Reveal is owned by the current user.
 * Receives the decrypted RevealedTalent payload directly from the server
 * page (never via network so it isn't cached in any client storage).
 */
export function RevealedCard({
  talent,
  matchId,
  shared = false,
  contactedAt,
  outreachAction,
}: Props): React.ReactElement {
  const t = useTranslations('talent');
  const tr = useTranslations('reveal');
  const format = useFormatter();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [contacted, setContacted] = useState<string | null>(contactedAt);
  const [error, setError] = useState<string | null>(null);

  const fullName =
    [talent.first_name, talent.last_name].filter(Boolean).join(' ').trim() ||
    t('unknownName');

  const onContact = (): void => {
    setError(null);
    startTransition(async () => {
      const res = await outreachAction(matchId);
      if (!res.ok) {
        setError(
          res.reason === 'not_revealed'
            ? tr('outreachNotRevealed')
            : tr('outreachError'),
        );
        return;
      }
      setContacted(res.contactedAt);
      // Open the recruiter's own mail client with a prefilled draft.
      const { to, subject, bodyText } = res.mailto;
      const params = new URLSearchParams();
      params.set('subject', subject);
      params.set('body', bodyText);
      const href = `mailto:${to ?? ''}?${params.toString()}`;
      if (typeof window !== 'undefined') {
        window.location.href = href;
      }
      router.refresh();
    });
  };

  return (
    <section className="mt-8 rounded-2xl border border-emerald-200 bg-emerald-50 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
          {t('revealedEyebrow')}
        </div>
        {contacted && (
          <span className="inline-flex items-center rounded-full border border-emerald-300 bg-white px-2.5 py-0.5 text-[11px] font-medium text-emerald-700">
            {tr('contactedOn', {
              date: format.dateTime(new Date(contacted), {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              }),
            })}
          </span>
        )}
      </div>
      <h2 className="mt-1 text-2xl font-semibold text-zinc-900">{fullName}</h2>
      {shared && (
        <p className="mt-1 text-xs font-medium text-emerald-700">{tr('revealedByTeam')}</p>
      )}

      <div className="mt-4">
        <button
          type="button"
          onClick={onContact}
          disabled={pending}
          className="inline-flex items-center rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
        >
          {pending
            ? tr('outreachPending')
            : contacted
              ? tr('contactAgain')
              : tr('contactCandidate')}
        </button>
        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('fieldEmail')} value={talent.email} kind="email" />
        <Field label={t('fieldPhone')} value={talent.phone} kind="phone" />
        <Field
          label={t('fieldLocation')}
          value={
            talent.location
              ? [talent.location.city, talent.location.country].filter(Boolean).join(', ')
              : null
          }
        />
        <Field
          label={t('fieldStartDate')}
          value={talent.start_date ? talent.start_date.slice(0, 10) : null}
        />
      </dl>

      {talent.cv_url && (
        <div className="mt-4">
          <a
            href={talent.cv_url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
          >
            {t('downloadCv')}
          </a>
        </div>
      )}

      <section className="mt-6">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          {t('workHistory')}
        </h3>
        <ul className="mt-2 space-y-2">
          {talent.experience.map((e, i) => (
            <li key={i} className="rounded-lg border border-emerald-100 bg-white p-3 text-sm">
              <div className="font-medium text-zinc-900">
                {e.function_title ?? t('unknownRole')}
              </div>
              <div className="text-xs text-zinc-600">
                {e.company_name ?? t('unknownEmployer')} ·{' '}
                {formatRange(e.start_date, e.end_date, e.is_current, t('present'))}
              </div>
            </li>
          ))}
          {talent.experience.length === 0 && (
            <li className="text-xs text-zinc-500">{t('noExperienceData')}</li>
          )}
        </ul>
      </section>

      <section className="mt-6">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          {t('education')}
        </h3>
        <ul className="mt-2 space-y-1 text-sm text-zinc-700">
          {talent.education.map((e, i) => (
            <li key={i}>
              {e.school_name ?? t('unknownEducation')} · {e.level ?? '—'}
              {e.end_year ? ` · ${e.end_year}` : ''}
            </li>
          ))}
          {talent.education.length === 0 && (
            <li className="text-xs text-zinc-500">{t('noEducationData')}</li>
          )}
        </ul>
      </section>
    </section>
  );
}

function Field({
  label,
  value,
  kind,
}: {
  label: string;
  value: string | null | undefined;
  kind?: 'email' | 'phone';
}): React.ReactElement {
  if (!value) {
    return (
      <div>
        <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
        <dd className="text-sm text-zinc-400">—</dd>
      </div>
    );
  }
  const href = kind === 'email' ? `mailto:${value}` : kind === 'phone' ? `tel:${value}` : undefined;
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="text-sm text-zinc-900">
        {href ? (
          <a href={href} className="underline-offset-2 hover:underline">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

function formatRange(
  start: string | null | undefined,
  end: string | null | undefined,
  isCurrent: boolean | null | undefined,
  presentLabel: string,
): string {
  const s = start ? start.slice(0, 7) : '—';
  const e = isCurrent ? presentLabel : end ? end.slice(0, 7) : '—';
  return `${s} → ${e}`;
}
