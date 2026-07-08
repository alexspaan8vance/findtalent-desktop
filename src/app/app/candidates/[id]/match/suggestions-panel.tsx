'use client';

/**
 * CV-suggestions review panel — Phase 4 (human-in-the-loop).
 *
 * Renders the PENDING "richer-wins" suggestions the diff-engine produced from
 * the 8vance server-side CV parse (see cv-suggestions.ts) and lets a recruiter
 * approve or dismiss each one, or approve them all in one shot. Every action
 * calls the Phase-3 server actions (suggestions-actions.ts) inside a
 * useTransition; on success the row is removed optimistically + the route is
 * refreshed so the profile card above reflects the applied change.
 *
 * Read-only consumer of the server actions — it never mutates suggestion state
 * itself. Provenance is made explicit with an "origineel" chip on the current
 * value and an "8vance" chip on the proposed value (coloured like the source
 * chips in match-client.tsx).
 *
 * Poll indicator: right after a candidate is created the 8vance parse may still
 * be running (suggestions are generated OFF the response path). When there are
 * no pending suggestions yet BUT the candidate was created moments ago
 * (`recentlyCreated`), the panel shows an "analysing…" indicator and polls
 * `listSuggestions` a handful of times; when suggestions land it renders them,
 * and if none arrive it hides itself. When there are no suggestions and the
 * candidate is not recently created, the panel renders nothing.
 */

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import type { CvSuggestion, SuggestionKind } from '@/lib/candidate/cv-suggestions';

import {
  approveAllSuggestions,
  approveSuggestion,
  dismissSuggestion,
  refreshSuggestionsAction,
  type SuggestionsStatus,
} from '../suggestions-actions';

// The 8vance CV reparse is async (~tens of seconds to a couple of minutes). Poll
// long enough to catch it — but stop early the moment the server reports a
// definitive end-state ("ready"/"none"/"error"), so we don't spin for 2 min when
// the answer already landed. ~2 min budget at a 5s cadence.
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_TRIES = 24;

interface Props {
  candidateId: string;
  /** Server-filtered pending suggestions (status === 'pending'). */
  suggestions: CvSuggestion[];
  /** Candidate created within the last ~2 min → parse may still be running. */
  recentlyCreated: boolean;
  /** Server-side pass status at render time (null for legacy rows). */
  initialStatus?: SuggestionsStatus | null;
}

/** Collapse a loose year pair into a compact "(2018–2021)" / "(2018–)" range. */
function yearRange(startYear?: string | null, endYear?: string | null): string {
  const s = (startYear ?? '').trim();
  const e = (endYear ?? '').trim();
  if (!s && !e) return '';
  return ` (${s}–${e})`;
}

/** Truncate free text for the compact about-diff preview. */
function truncate(s: string, max = 160): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

/**
 * A one-line human description of a suggestion side, sensible per kind:
 *  - skill / language → the proposed name
 *  - education        → "degree field @ institution (years)"
 *  - employment       → "title @ company (years)"
 *  - about            → truncated text
 *  - email / phone    → the raw value
 * Returns '' for an absent/empty value (rendered as an em dash by the caller).
 */
function describeSide(kind: SuggestionKind, value: unknown): string {
  if (value == null) return '';
  switch (kind) {
    case 'skill':
      return typeof value === 'string' ? value.trim() : '';
    case 'language': {
      if (typeof value === 'string') return value.trim();
      if (typeof value === 'object') {
        const name = (value as { name?: unknown }).name;
        return typeof name === 'string' ? name.trim() : '';
      }
      return '';
    }
    case 'education': {
      if (typeof value !== 'object') return '';
      const e = value as {
        degree?: string | null;
        field?: string | null;
        institution?: string | null;
        startYear?: string | null;
        endYear?: string | null;
      };
      const head = [e.degree, e.field].map((x) => (x ?? '').trim()).filter(Boolean).join(' ');
      const inst = (e.institution ?? '').trim() ? ` @ ${(e.institution ?? '').trim()}` : '';
      return `${head || '—'}${inst}${yearRange(e.startYear, e.endYear)}`;
    }
    case 'employment': {
      if (typeof value !== 'object') return '';
      const e = value as {
        title?: string | null;
        company?: string | null;
        startYear?: string | null;
        endYear?: string | null;
      };
      const head = (e.title ?? '').trim() || '—';
      const co = (e.company ?? '').trim() ? ` @ ${(e.company ?? '').trim()}` : '';
      return `${head}${co}${yearRange(e.startYear, e.endYear)}`;
    }
    case 'about':
      return typeof value === 'string' ? truncate(value) : '';
    case 'email':
    case 'phone':
      return typeof value === 'string' ? value.trim() : '';
    default:
      return '';
  }
}

/** Small provenance chip: neutral for the original value, accent for 8vance. */
function ProvenanceChip({
  variant,
  children,
}: {
  variant: 'original' | 'vance';
  children: React.ReactNode;
}): React.ReactElement {
  const cls =
    variant === 'vance'
      ? 'border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]'
      : 'border-[var(--ft-border)] bg-[var(--ft-surface-2)] text-[var(--ft-muted)]';
  return (
    <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}>
      {children}
    </span>
  );
}

function SuggestionRow({
  suggestion,
  candidateId,
  onRemove,
}: {
  suggestion: CvSuggestion;
  candidateId: string;
  onRemove: (id: string) => void;
}): React.ReactElement {
  const t = useTranslations('candidateMatch');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(false);
  const router = useRouter();

  const proposedText = describeSide(suggestion.kind, suggestion.proposed);
  const originalText = describeSide(suggestion.kind, suggestion.original);
  // 'add' / 'fill' never have a meaningful original (it is null) → only the
  // proposed side carries a value; 'replace' shows both sides side-by-side.
  const showOriginal = originalText.length > 0;

  function run(
    action: (candidateId: string, suggestionId: string) => Promise<{ ok: boolean }>,
  ): void {
    setError(false);
    startTransition(async () => {
      const res = await action(candidateId, suggestion.id);
      if (res.ok) {
        onRemove(suggestion.id);
        router.refresh();
      } else {
        setError(true);
      }
    });
  }

  return (
    <li className="ft-card rounded-xl border border-[var(--ft-border)] bg-[var(--ft-surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border border-[var(--ft-border)] bg-[var(--ft-surface-2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ft-muted)]">
              {t(`suggestionKind_${suggestion.kind}`)}
            </span>
            <span className="truncate text-sm font-semibold text-[var(--ft-ink)]">
              {suggestion.label}
            </span>
          </div>

          {/* Origineel | Voorgesteld diff with provenance chips. */}
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {showOriginal && (
              <div className="min-w-0">
                <div className="mb-1 flex items-center gap-1.5">
                  <ProvenanceChip variant="original">{t('suggestionOrigin')}</ProvenanceChip>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ft-muted)]">
                    {t('suggestionOriginal')}
                  </span>
                </div>
                <p className="break-words text-xs leading-relaxed text-[var(--ft-muted)] line-through decoration-[var(--ft-border-strong)]">
                  {originalText}
                </p>
              </div>
            )}
            <div className={`min-w-0 ${showOriginal ? '' : 'sm:col-span-2'}`}>
              <div className="mb-1 flex items-center gap-1.5">
                <ProvenanceChip variant="vance">8vance</ProvenanceChip>
                <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--ft-muted)]">
                  {t('suggestionProposed')}
                </span>
              </div>
              <p className="break-words text-xs font-medium leading-relaxed text-[var(--ft-ink)]">
                {proposedText || '—'}
              </p>
            </div>
          </div>

          {suggestion.reason && (
            <p className="mt-2 text-[11px] leading-snug text-[var(--ft-muted)]">
              <span className="font-semibold text-[var(--ft-ink)]">
                {t('suggestionReason')}:
              </span>{' '}
              {suggestion.reason}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={pending}
              onClick={() => run(approveSuggestion)}
              className="rounded-lg border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--ft-accent-strong)] transition hover:border-[var(--ft-accent)] disabled:opacity-60"
            >
              {t('suggestionApprove')}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(dismissSuggestion)}
              className="rounded-lg border border-[var(--ft-border)] bg-[var(--ft-surface)] px-3 py-1.5 text-xs font-medium text-[var(--ft-muted)] transition hover:border-[var(--ft-border-strong)] disabled:opacity-60"
            >
              {t('suggestionDismiss')}
            </button>
          </div>
          {error && (
            <p role="alert" className="max-w-[10rem] text-right text-[11px] font-medium text-red-600">
              {t('suggestionError')}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

export function SuggestionsPanel({
  candidateId,
  suggestions,
  recentlyCreated,
  initialStatus = null,
}: Props): React.ReactElement | null {
  const t = useTranslations('candidateMatch');
  const router = useRouter();
  const [rows, setRows] = useState<CvSuggestion[]>(suggestions);
  // The pass status drives what we show when there are no rows: keep polling
  // while "pending", show a definitive note on "none"/"error". Seed from the
  // server; treat a just-created candidate with no status yet as "pending".
  const [status, setStatus] = useState<SuggestionsStatus>(
    initialStatus ??
      (suggestions.length > 0 ? 'ready' : recentlyCreated ? 'pending' : 'none'),
  );
  // Poll only when we start empty AND the pass isn't already in an end-state.
  const [polling, setPolling] = useState(
    suggestions.length === 0 && (initialStatus === 'pending' || (initialStatus == null && recentlyCreated)),
  );
  const [allPending, startAll] = useTransition();
  const [allError, setAllError] = useState(false);
  const [rescanning, startRescan] = useTransition();

  // Keep local rows in sync when the server re-renders with a new pending set
  // (e.g. after router.refresh following an approve/dismiss). Adjust during
  // render (React's recommended "state derived from props" pattern) rather than
  // in an effect, so there's no extra render pass.
  const [syncedFrom, setSyncedFrom] = useState(suggestions);
  if (syncedFrom !== suggestions) {
    setSyncedFrom(suggestions);
    setRows(suggestions);
  }

  // Client poll of refreshSuggestionsAction — which RE-RUNS the generator each
  // tick (the reparse is async, so a pure re-read would never surface a diff
  // produced after page load). Stops on the first non-empty result OR a
  // definitive server end-state ("none"/"error"), else after MAX_POLL_TRIES.
  useEffect(() => {
    if (!polling || rows.length > 0) return;
    let cancelled = false;
    let tries = 0;

    async function tick(): Promise<void> {
      tries += 1;
      try {
        const res = await refreshSuggestionsAction(candidateId);
        if (!cancelled && res.ok) {
          if (res.suggestions.length > 0) {
            setRows(res.suggestions);
            setStatus('ready');
            setPolling(false);
            return;
          }
          if (res.status === 'none' || res.status === 'error') {
            setStatus(res.status);
            setPolling(false);
            return;
          }
        }
      } catch {
        /* transient — keep polling */
      }
      if (!cancelled && tries < MAX_POLL_TRIES) {
        setTimeout(() => void tick(), POLL_INTERVAL_MS);
      } else if (!cancelled) {
        // Budget exhausted with no end-state: settle to "none" so the UI stops
        // implying work is still happening.
        setStatus((s) => (s === 'pending' ? 'none' : s));
        setPolling(false);
      }
    }

    const handle = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [candidateId, polling, rows.length]);

  function onRemove(id: string): void {
    setRows((prev) => prev.filter((s) => s.id !== id));
  }

  function onApproveAll(): void {
    setAllError(false);
    startAll(async () => {
      const res = await approveAllSuggestions(candidateId);
      if (res.ok) {
        setRows([]);
        router.refresh();
      } else {
        setAllError(true);
      }
    });
  }

  // Manual re-scan: force one immediate regenerate + resume polling. Lets a
  // recruiter re-trigger instead of waiting/refreshing when nothing showed up.
  function onRescan(): void {
    startRescan(async () => {
      const res = await refreshSuggestionsAction(candidateId);
      if (res.ok && res.suggestions.length > 0) {
        setRows(res.suggestions);
        setStatus('ready');
        return;
      }
      setStatus(res.ok ? res.status : 'error');
      // Keep watching in case the reparse lands right after this manual poke.
      setPolling(true);
    });
  }

  // Still waiting on the parse — poll indicator.
  if (rows.length === 0 && polling) {
    return (
      <section
        aria-live="polite"
        className="mt-6 rounded-2xl border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] p-4"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--ft-accent-strong)]">
          <span className="ft-sparkle" aria-hidden="true">
            ✦
          </span>
          <span>{t('suggestionsAnalyzing')}</span>
        </div>
      </section>
    );
  }

  // Definitive end-state with nothing to review: show a low-key confirmation
  // (profile already complete / a transient error) + a manual re-scan, instead
  // of silently rendering nothing (the "is it broken?" ambiguity).
  if (rows.length === 0) {
    return (
      <section
        aria-live="polite"
        className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface-2)] p-4"
      >
        <p className="text-sm text-[var(--ft-muted)]">
          {status === 'error' ? t('suggestionsScanError') : t('suggestionsNone')}
        </p>
        <button
          type="button"
          disabled={rescanning}
          onClick={onRescan}
          className="rounded-lg border border-[var(--ft-border)] px-3 py-1.5 text-xs font-semibold text-[var(--ft-ink)] transition hover:border-[var(--ft-border-strong)] disabled:opacity-60"
        >
          {rescanning ? t('suggestionsScanning') : t('suggestionsRescan')}
        </button>
      </section>
    );
  }

  return (
    <section className="mt-6 rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface-2)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--ft-ink)]">
          <span className="ft-sparkle" aria-hidden="true">
            ✦
          </span>
          {t('suggestionsTitle')}
          <span className="rounded-full border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--ft-accent-strong)]">
            {rows.length}
          </span>
        </h2>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            disabled={allPending}
            onClick={onApproveAll}
            className="rounded-lg border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--ft-accent-strong)] transition hover:border-[var(--ft-accent)] disabled:opacity-60"
          >
            {t('suggestionApproveAll')}
          </button>
          {allError && (
            <p role="alert" className="text-[11px] font-medium text-red-600">
              {t('suggestionError')}
            </p>
          )}
        </div>
      </div>

      <ul className="mt-4 flex flex-col gap-3">
        {rows.map((s) => (
          <SuggestionRow
            key={s.id}
            suggestion={s}
            candidateId={candidateId}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </section>
  );
}
