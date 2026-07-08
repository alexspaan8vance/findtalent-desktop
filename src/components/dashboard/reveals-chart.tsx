'use client';

import { useTranslations } from 'next-intl';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface RevealWeekPoint {
  /** Short week label, e.g. "12 May". */
  label: string;
  /** Number of reveals in that week. */
  reveals: number;
}

/**
 * Reveals-per-week area chart in the brand accent. Server passes a plain
 * array of ~8 weekly buckets; this client component renders them inside a
 * ResponsiveContainer so it scales from 390px to desktop.
 */
export function RevealsChart({ data }: { data: RevealWeekPoint[] }): React.ReactElement {
  const t = useTranslations('dashboard');
  const hasAny = data.some((d) => d.reveals > 0);
  const total = data.reduce((sum, d) => sum + d.reveals, 0);

  return (
    <div
      // Guaranteed min size (inline, so no class purge/order surprises): the
      // ResponsiveContainer measures this box on mount; a 0×0 first paint made
      // Recharts warn "width(-1) and height(-1) of chart should be greater
      // than 0". `minWidth: 0` keeps the grid column shrinkable.
      className="h-56 w-full sm:h-64"
      style={{ minHeight: 224, minWidth: 0 }}
      role="img"
      aria-label={t('chartAria', { count: total, weeks: data.length })}
    >
      {hasAny ? (
        <ResponsiveContainer
          width="100%"
          height="100%"
          // First-paint dimensions BEFORE the ResizeObserver fires — prevents
          // the initial -1×-1 render pass entirely (recharts >= 2.1).
          initialDimension={{ width: 520, height: 224 }}
        >
          <AreaChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <defs>
              <linearGradient id="ft-reveals-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--ft-accent)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--ft-accent)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--ft-border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: 'var(--ft-muted)' }}
              tickLine={false}
              axisLine={{ stroke: 'var(--ft-border)' }}
            />
            <YAxis
              allowDecimals={false}
              width={32}
              tick={{ fontSize: 11, fill: 'var(--ft-muted)' }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              cursor={{ stroke: 'var(--ft-accent-line)' }}
              contentStyle={{
                borderRadius: 12,
                border: '1px solid var(--ft-border)',
                background: 'var(--ft-surface)',
                color: 'var(--ft-ink)',
                fontSize: 12,
              }}
              labelStyle={{ color: 'var(--ft-muted)' }}
              formatter={(value) => [value as number, t('chartReveals')]}
            />
            <Area
              type="monotone"
              dataKey="reveals"
              stroke="var(--ft-accent)"
              strokeWidth={2}
              fill="url(#ft-reveals-fill)"
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-[var(--ft-border)] text-sm text-[var(--ft-muted)]">
          {t('chartEmpty')}
        </div>
      )}
    </div>
  );
}
