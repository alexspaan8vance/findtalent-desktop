import { ImageResponse } from 'next/og';

import { getBrandInitials, getBrandTheme } from '@/lib/brand/config';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

/** Raster data URLs that satori/ImageResponse can decode for the favicon. */
const RASTER_LOGO_RE = /^data:image\/(png|jpeg|webp);base64,/;

export default async function Icon(): Promise<ImageResponse> {
  const theme = await getBrandTheme();

  // Use the uploaded logo for the favicon only when it's a raster data URL.
  // (SVG/remote URLs aren't reliably decodable here, so fall back to initials.)
  if (theme.logo && RASTER_LOGO_RE.test(theme.logo)) {
    return new ImageResponse(
      (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: theme.primaryColor,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={theme.logo}
            alt={theme.name}
            width={32}
            height={32}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        </div>
      ),
      { ...size },
    );
  }

  const initials = getBrandInitials(theme.name);

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: theme.primaryColor,
          color: '#ffffff',
          fontSize: 18,
          fontWeight: 700,
          letterSpacing: -0.5,
          borderRadius: 7,
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        {initials}
      </div>
    ),
    { ...size },
  );
}
