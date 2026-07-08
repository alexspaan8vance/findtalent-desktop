/**
 * Segmented proficiency meter — a calm, refined replacement for ⭐ ratings.
 * Accepts the anonymized `proficiency_label` (1–5 stars) and renders that
 * many filled segments out of five.
 */
export function ProficiencyMeter({
  label,
  variant = 'accent',
}: {
  /** The anonymized stars string, e.g. "⭐⭐⭐". */
  label: string;
  variant?: 'accent' | 'muted';
}): React.ReactElement {
  const level = Math.max(0, Math.min(5, [...(label ?? '')].length));
  return (
    <span
      className={`ft-meter${variant === 'muted' ? ' is-muted' : ''}`}
      role="img"
      aria-label={`${level} / 5`}
      title={`${level} / 5`}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <i key={n} data-on={n <= level ? '1' : '0'} />
      ))}
    </span>
  );
}
