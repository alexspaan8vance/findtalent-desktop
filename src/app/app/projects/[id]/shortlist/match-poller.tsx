'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

interface Props {
  projectId: string;
  /** True once the page is already rendering some matches (partial stream). */
  hasRows: boolean;
}

interface StatusResponse {
  settled: boolean;
  matchCount: number;
  progress: number;
}

/**
 * Drives matching off the render path and shows a live, "alive" progress
 * panel (8vance-style): POSTs /hydrate once, then polls /status — fast early
 * (2s) for responsiveness, easing to 4s — surfacing a determinate progress
 * bar, a live "found N matches" count and an elapsed timer. Whenever new
 * matches land (matchCount climbs) it refreshes the route so the server
 * component streams the partial results in above this panel.
 */
export function MatchPoller({ projectId, hasRows }: Props) {
  const router = useRouter();
  const t = useTranslations('shortlist');
  const [note, setNote] = useState<string>('');
  const [elapsed, setElapsed] = useState<number>(0);
  // Server-derived progress (how many pools have settled). The DISPLAYED bar is
  // blended with a time-based "fake" ease (see `pct` below) so it feels fast.
  const [progress, setProgress] = useState<number>(8);
  // Flips true on settle → the bar jumps straight to 100%.
  const [done, setDone] = useState<boolean>(false);
  const [count, setCount] = useState<number>(0);
  // Once the overall cap is hit we stop polling and surface an actionable
  // "still working — reload" control instead of silently dead-ending.
  const [capped, setCapped] = useState<boolean>(false);
  const started = useRef(false);
  // Track the last count we refreshed on so we only re-render the route when
  // genuinely new matches arrive (avoids refresh storms while polling).
  const lastRefreshCount = useRef(0);

  // Live elapsed counter so the user sees the match is actively working. STOPS
  // once the match is done OR the poller gave up (capped / session lost) — so a
  // stale/abandoned tab never sits there counting "Matching… 1242s" forever.
  useEffect(() => {
    if (done || capped) return;
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [done, capped]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let cancelled = false;
    let polls = 0;

    async function tick() {
      try {
        const res = await fetch(`/api/projects/${projectId}/status`, {
          cache: 'no-store',
        });
        // Session expired / access lost (401/403) or the project is gone (404):
        // /status will never return `settled`, so polling would spin forever and
        // the panel would read "Matching… <N>s" indefinitely. Stop immediately
        // and surface the reload control instead.
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          if (!cancelled) setCapped(true);
          return;
        }
        if (res.ok) {
          const data = (await res.json()) as StatusResponse;
          if (!cancelled) {
            setProgress((p) => Math.max(p, data.progress ?? p));
            setCount(data.matchCount);
            // Stream partials in as soon as the count grows; refresh once on
            // settle to bring in any final stragglers.
            if (data.matchCount > lastRefreshCount.current) {
              lastRefreshCount.current = data.matchCount;
              router.refresh();
            }
            if (data.settled) {
              setDone(true);
              setProgress(100);
              router.refresh();
              return;
            }
          }
        }
      } catch {
        // transient — keep polling
      }
      polls += 1;
      if (cancelled) return;
      // Cadence:
      //  - fast early window (polls < 8): 2s for snappy first results
      //  - fast window (8..60, ~3s each → ≈3m total): 3s
      //  - slow window (60..SLOW_CAP_POLLS, 5s each): keep polling a slow
      //    match instead of dead-ending — a finished 8vance task now renders
      //    within 5s (was 15s) without hammering the endpoint
      // Once SLOW_CAP_POLLS is reached we stop and show a reload control.
      const FAST_POLLS = 60;
      // 60 fast polls + 60 slow polls @5s ≈ 5 more minutes of background polling.
      const SLOW_CAP_POLLS = 120;
      if (polls < FAST_POLLS) {
        setTimeout(tick, polls < 8 ? 2000 : 3000);
      } else if (polls < SLOW_CAP_POLLS) {
        // Past the fast window: surface a soft note but keep polling slowly.
        setNote(t('matchingSlow'));
        setTimeout(tick, 5000);
      } else {
        // Generous overall cap reached — stop polling and let the user act.
        setNote(t('matchingSlow'));
        setCapped(true);
      }
    }

    // Kick hydration (long-running), then start polling status.
    void fetch(`/api/projects/${projectId}/hydrate`, {
      method: 'POST',
      cache: 'no-store',
    })
      .then(() => {
        if (!cancelled) router.refresh();
      })
      .catch(() => {});
    // Fire the first poll quickly so the earliest results surface fast.
    setTimeout(tick, 900);

    return () => {
      cancelled = true;
    };
  }, [projectId, router, t]);

  // "Fake" psychological easing: the bar shoots up toward the middle quickly,
  // then parks just past it — which reads as SHORTER than a bar that crawls
  // near the start. We ease toward a ~62% asymptote with a fast time constant
  // (≈38% @6s, ≈53% @12s, ≈59% @18s, creeping after). The real server progress
  // can overtake the fake curve (we take the max), and the whole thing is
  // capped at 92% until the match actually settles — then `done` snaps to 100.
  const FAKE_ASYMPTOTE = 62;
  const FAKE_TAU = 6; // seconds
  const eased = FAKE_ASYMPTOTE * (1 - Math.exp(-elapsed / FAKE_TAU));
  const pct = done
    ? 100
    : Math.min(92, Math.max(0, Math.round(Math.max(progress, eased))));

  // REAL count only. Matching now streams candidate rows as they're found (the
  // fallback ranker emits scored batches incrementally; the sync match inserts
  // a minimal card per result before enrichment), so the count climbs for real
  // within seconds — no fabricated creeping number. While it's genuinely still
  // 0 we simply show 0; the always-animated bar + elapsed timer carry the
  // "still working" signal instead of a misleading fake count.
  const displayCount = count;

  return (
    <div className="mt-6 rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface-2)] p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-700">
          <span className="ft-sparkle" aria-hidden="true">
            ✦
          </span>
          <span>
            {capped
              ? t('matchingSlow')
              : hasRows
                ? t('matchingStillSearching')
                : t('matchingLooking', { pct })}
          </span>
        </div>
        {!capped && (
          <div className="text-xs font-medium tabular-nums text-[var(--ft-accent-strong)]">
            {t('matchingFoundCount', { count: displayCount })}
          </div>
        )}
      </div>

      <div className="mt-3">
        <div
          className="ft-progress-determinate"
          role="progressbar"
          aria-label={t('matchingTitle')}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>

      {capped ? (
        <div className="mt-2 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => router.refresh()}
            className="rounded-lg border border-[var(--ft-border)] bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:border-[var(--ft-border-strong)]"
          >
            {t('matchingSlow')}
          </button>
        </div>
      ) : (
        <p className="mt-2 text-center text-xs text-zinc-500">
          {note || t('matchingElapsed', { seconds: elapsed })}
        </p>
      )}
    </div>
  );
}
