import type { ReactElement } from 'react';

/**
 * Abstract, brand-tinted "anonymous candidate cards" mock for the hero.
 * Pure CSS — no images. The first card is "revealed" (named), the rest are
 * blurred/anonymised to dramatise the reveal mechanic. Decorative only.
 */
export function HeroVisual({
  revealedLabel,
  matchLabel,
  lockedLabel,
}: {
  readonly revealedLabel: string;
  readonly matchLabel: string;
  readonly lockedLabel: string;
}): ReactElement {
  return (
    <div aria-hidden className="relative isolate">
      {/* soft gradient mesh behind the cards */}
      <div
        className="pointer-events-none absolute -inset-8 -z-10 rounded-[2.5rem] opacity-70 blur-2xl"
        style={{
          background:
            'radial-gradient(60% 60% at 25% 20%, var(--ft-accent-soft), transparent 70%), radial-gradient(55% 55% at 90% 90%, var(--ft-accent-line), transparent 65%)',
        }}
      />
      <div
        className="rounded-3xl border p-5 shadow-[0_24px_60px_-30px_rgba(20,24,29,0.45)] backdrop-blur"
        style={{
          background: 'color-mix(in srgb, var(--ft-surface) 88%, transparent)',
          borderColor: 'var(--ft-border)',
        }}
      >
        <div className="flex flex-col gap-3">
          {/* revealed card */}
          <article
            className="flex items-center gap-3 rounded-2xl border p-3.5"
            style={{ borderColor: 'var(--ft-accent-line)', background: 'var(--ft-surface)' }}
          >
            <span
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
              style={{ background: 'var(--ft-accent)', color: 'var(--ft-accent-fg)' }}
            >
              SD
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold" style={{ color: 'var(--ft-ink)' }}>
                  Sara D.
                </span>
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide"
                  style={{ background: 'var(--ft-accent-soft)', color: 'var(--ft-accent-strong)' }}
                >
                  {revealedLabel}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px]" style={{ color: 'var(--ft-muted)' }}>
                <span>{matchLabel}</span>
                <span className="ft-meter">
                  <i data-on="1" />
                  <i data-on="1" />
                  <i data-on="1" />
                  <i data-on="1" />
                  <i />
                </span>
              </div>
            </div>
            <span className="text-sm font-semibold tabular-nums" style={{ color: 'var(--ft-accent-strong)' }}>
              94%
            </span>
          </article>

          {/* anonymised cards */}
          {[
            { initials: '••', score: '91%', bars: 4 },
            { initials: '••', score: '88%', bars: 3 },
          ].map((row, i) => (
            <article
              key={i}
              className="flex items-center gap-3 rounded-2xl border p-3.5"
              style={{ borderColor: 'var(--ft-border)', background: 'var(--ft-surface-2)' }}
            >
              <span
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xs font-semibold blur-[1px]"
                style={{ background: 'var(--ft-border-strong)', color: 'var(--ft-muted)' }}
              >
                {row.initials}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className="h-3 w-24 rounded-full"
                    style={{ background: 'var(--ft-border-strong)' }}
                  />
                  <span
                    className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{ background: 'var(--ft-bg)', color: 'var(--ft-muted)' }}
                  >
                    <LockGlyph />
                    {lockedLabel}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="ft-meter is-muted">
                    {Array.from({ length: 5 }).map((_, b) => (
                      <i key={b} data-on={b < row.bars ? '1' : undefined} />
                    ))}
                  </span>
                </div>
              </div>
              <span className="text-sm font-semibold tabular-nums" style={{ color: 'var(--ft-muted)' }}>
                {row.score}
              </span>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

function LockGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
