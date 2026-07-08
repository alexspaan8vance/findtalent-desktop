'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

/** Minimal projection of a shortlist row the radar needs (anon-only). */
export interface RadarPoint {
  /** Stable, non-PII id used for the angle hash + scroll target. */
  opaqueId: string;
  /** Match score 0–100. */
  score: number;
  /** True when the candidate has been revealed (drawn slightly stronger). */
  revealed: boolean;
}

const SIZE = 280; // SVG viewBox (square)
const CENTRE = SIZE / 2;
const MAX_R = CENTRE - 24; // leave room for the outer label
const RINGS = 4;

/** Deterministic 0..1 hash of a string — spreads dots by angle. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // >>> 0 → unsigned; divide to [0,1).
  return (h >>> 0) / 4294967296;
}

/**
 * Match radar: concentric rings with each VISIBLE talent as a dot whose
 * distance from centre is inversely proportional to score (high score = near
 * centre). Angle is a deterministic hash of opaqueId so dots spread evenly and
 * stay put across re-renders. Clicking/hovering a dot scrolls to + highlights
 * its card (best-effort, via the card's `data-opaque-id` anchor) and shows a
 * tooltip with the score.
 *
 * Lightweight: pure SVG, memoised geometry, no animation loop.
 */
export function MatchRadar({ points }: { points: RadarPoint[] }): React.ReactElement {
  const t = useTranslations('shortlist');
  const [hover, setHover] = useState<string | null>(null);

  const dots = useMemo(() => {
    return points.map((p) => {
      const score = Math.max(0, Math.min(100, p.score));
      // Inverse: score 100 → r≈0 (centre), score 0 → r≈MAX_R (edge).
      const r = MAX_R * (1 - score / 100);
      const angle = hash01(p.opaqueId) * Math.PI * 2;
      return {
        ...p,
        cx: CENTRE + r * Math.cos(angle),
        cy: CENTRE + r * Math.sin(angle),
      };
    });
  }, [points]);

  const focusCard = (opaqueId: string): void => {
    if (typeof document === 'undefined') return;
    const el = document.querySelector<HTMLElement>(`[data-opaque-id="${CSS.escape(opaqueId)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Brief ring highlight without depending on a global CSS class.
    const prev = el.style.boxShadow;
    el.style.transition = 'box-shadow 0.3s ease';
    el.style.boxShadow = '0 0 0 3px var(--ft-accent)';
    window.setTimeout(() => {
      el.style.boxShadow = prev;
    }, 1400);
  };

  return (
    <div className="mt-6 rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface)] p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--ft-ink)]">{t('radarTitle')}</h2>
        <span className="text-[11px] text-zinc-500">{t('radarHint')}</span>
      </div>
      <div className="flex justify-center">
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          role="img"
          aria-label={t('radarTitle')}
          className="h-auto w-full max-w-[20rem]"
        >
          {/* Concentric rings (outer → inner) with score labels. */}
          {Array.from({ length: RINGS }, (_, i) => {
            const ringR = (MAX_R * (RINGS - i)) / RINGS;
            const ringScore = Math.round((i / RINGS) * 100);
            return (
              <g key={i}>
                <circle
                  cx={CENTRE}
                  cy={CENTRE}
                  r={ringR}
                  fill="none"
                  stroke="var(--ft-border)"
                  strokeWidth={1}
                />
                <text
                  x={CENTRE}
                  y={CENTRE - ringR - 2}
                  textAnchor="middle"
                  className="fill-zinc-400"
                  style={{ fontSize: 8 }}
                >
                  {ringScore}
                </text>
              </g>
            );
          })}
          {/* Centre marker. */}
          <circle cx={CENTRE} cy={CENTRE} r={2} fill="var(--ft-accent-strong)" />

          {/* Talent dots. */}
          {dots.map((d) => {
            const active = hover === d.opaqueId;
            return (
              <g
                key={d.opaqueId}
                transform={`translate(${d.cx} ${d.cy})`}
                onMouseEnter={() => setHover(d.opaqueId)}
                onMouseLeave={() => setHover((h) => (h === d.opaqueId ? null : h))}
                onClick={() => focusCard(d.opaqueId)}
                className="cursor-pointer"
              >
                <circle
                  r={active ? 7 : 5}
                  fill="var(--ft-accent)"
                  stroke="var(--ft-surface)"
                  strokeWidth={d.revealed ? 2 : 1}
                  opacity={active ? 1 : 0.8}
                />
                {active && (
                  <g transform="translate(0 -12)">
                    <rect
                      x={-16}
                      y={-12}
                      width={32}
                      height={14}
                      rx={3}
                      fill="var(--ft-accent-strong)"
                    />
                    <text
                      x={0}
                      y={-2}
                      textAnchor="middle"
                      className="fill-white"
                      style={{ fontSize: 9, fontWeight: 600 }}
                    >
                      {Math.round(d.score)}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
