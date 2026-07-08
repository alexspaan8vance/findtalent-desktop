/**
 * Renders the brand: the uploaded/configured logo image when present,
 * otherwise the brand name as text. Server-renderable.
 *
 * The `logo` and `name` come from `getBrandTheme()` (validated there via
 * `safeLogo`), so this component just renders what it is given.
 */
import { getBrandTheme } from '@/lib/brand/config';

interface BrandLogoProps {
  /** Tailwind classes for the wrapper / text fallback. */
  className?: string;
  /** Max rendered height of the logo image (px). Defaults to 32. */
  height?: number;
}

export default async function BrandLogo({
  className,
  height = 32,
}: BrandLogoProps) {
  const theme = await getBrandTheme();

  if (theme.logo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- logo is a validated data/https URL, not an optimizable asset
      <img
        src={theme.logo}
        alt={theme.name}
        height={height}
        style={{ height, width: 'auto' }}
        className={className}
      />
    );
  }

  return <span className={className}>{theme.name}</span>;
}
