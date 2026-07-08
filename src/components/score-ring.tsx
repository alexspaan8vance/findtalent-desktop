/**
 * Match-score ring: a conic-gradient donut filled to `score` (0–100) in the
 * brand accent. Score is clamped + rounded so a stray out-of-range or NaN
 * value can never produce an invalid `conic-gradient`.
 */
export function ScoreRing({
  score,
  size = 'md',
  unknown = false,
  unknownTitle,
}: {
  score: number;
  size?: 'sm' | 'md' | 'lg';
  /**
   * Render a neutral placeholder ring with "–" instead of a number, for when
   * the score isn't trustworthy to show yet (e.g. a cross-company match whose
   * real score is computed only on detail-open). Keeps the layout stable.
   */
  unknown?: boolean;
  /** Tooltip for the `unknown` placeholder (e.g. "See details for score"). */
  unknownTitle?: string;
}): React.ReactElement {
  const v = Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0;
  const dims =
    size === 'lg'
      ? { outer: 'h-16 w-16 text-base', inner: 'h-12 w-12' }
      : size === 'sm'
        ? { outer: 'h-10 w-10 text-xs', inner: 'h-7 w-7' }
        : { outer: 'h-12 w-12 text-sm', inner: 'h-9 w-9' };
  if (unknown) {
    return (
      <div
        className={`grid shrink-0 place-items-center rounded-full font-semibold text-[var(--ft-muted)] ${dims.outer}`}
        style={{ background: 'var(--ft-accent-soft)' }}
        title={unknownTitle ?? '—'}
      >
        <span className={`grid place-items-center rounded-full bg-[var(--ft-surface)] ${dims.inner}`}>
          –
        </span>
      </div>
    );
  }
  return (
    <div
      className={`grid shrink-0 place-items-center rounded-full font-semibold text-[var(--ft-accent-strong)] ${dims.outer}`}
      style={{
        background: `conic-gradient(var(--ft-accent) ${v * 3.6}deg, var(--ft-accent-soft) 0deg)`,
      }}
      title={`${v} / 100`}
    >
      <span className={`grid place-items-center rounded-full bg-[var(--ft-surface)] ${dims.inner}`}>
        {v}
      </span>
    </div>
  );
}
