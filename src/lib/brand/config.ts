/**
 * Whitelabel brand configuration.
 *
 * Reads BRAND_* env vars (set per tenant/domain at deploy time) and
 * returns a stable shape for the layout, icon route, and any UI that
 * needs to render brand-specific bits.
 */

import { cache } from 'react';

export interface BrandConfig {
  name: string;
  primaryColor: string;
  /** Brand accent — drives the UI theme (--ft-accent). Admin-editable. */
  accentColor: string;
  supportEmail: string;
  logoUrl?: string;
  faviconUrl?: string;
  /**
   * Resolved, validated logo for rendering: a `data:image/...;base64,...`
   * data URL or an https URL. Admin-editable; only set by getBrandTheme().
   */
  logo?: string;
}

/** Max accepted logo payload (~200KB). data: URLs grow ~33% over raw bytes. */
export const MAX_LOGO_BYTES = 200 * 1024;
const MAX_LOGO_DATA_URL_CHARS = Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 64;

const LOGO_DATA_URL_RE =
  /^data:image\/(png|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const DEFAULTS: BrandConfig = {
  name: 'FindTalent',
  primaryColor: '#18181b',
  accentColor: '#1f6f5c',
  supportEmail: 'support@findtalent.app',
};

/** Accept only safe `#rgb`/`#rrggbb` hex so a DB/env value can't inject CSS. */
export function safeHexColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(value.trim())
    ? value.trim()
    : fallback;
}

/**
 * Accept only a safe logo value to prevent CSS/script/SSRF injection:
 *  - a base64 `data:image/(png|jpeg|svg+xml|webp);base64,...` URL ≤ ~200KB, or
 *  - an `https://` URL.
 * Anything else (javascript:, data:text/html, http://, oversized, malformed)
 * is rejected and the fallback is returned. Never throws.
 */
export function safeLogo(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== 'string') return fallback;
  const v = value.trim();
  if (v.length === 0) return fallback;

  if (v.startsWith('data:')) {
    if (v.length > MAX_LOGO_DATA_URL_CHARS) return fallback;
    return LOGO_DATA_URL_RE.test(v) ? v : fallback;
  }

  // Only https remote URLs; reject http/ftp/relative/etc.
  try {
    const url = new URL(v);
    return url.protocol === 'https:' ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function envString(key: string): string | undefined {
  const raw = process.env[key];
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getBrandConfig(): BrandConfig {
  const name = envString('BRAND_NAME') ?? DEFAULTS.name;
  const primaryColor = envString('BRAND_PRIMARY_COLOR') ?? DEFAULTS.primaryColor;
  const accentColor = safeHexColor(envString('BRAND_ACCENT_COLOR'), DEFAULTS.accentColor);
  const supportEmail = envString('BRAND_SUPPORT_EMAIL') ?? DEFAULTS.supportEmail;
  const logoUrl = envString('BRAND_LOGO_URL');
  const faviconUrl = envString('BRAND_FAVICON_URL');

  const config: BrandConfig = { name, primaryColor, accentColor, supportEmail };
  if (logoUrl) config.logoUrl = logoUrl;
  if (faviconUrl) config.faviconUrl = faviconUrl;
  return config;
}

/**
 * Resolve the live brand theme: env/defaults overlaid with the admin-set
 * accent stored on the primary deploy tenant (TENANT_SLUG) `brandConfigJson`.
 * Safe to call from the root layout (one cached query per request).
 */
export const getBrandTheme = cache(async (): Promise<BrandConfig> => {
  const base = getBrandConfig();
  try {
    const { prisma } = await import('@/lib/db');
    const slug = envString('TENANT_SLUG') ?? 'ivta';
    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      select: { brandConfigJson: true, name: true },
    });
    const cfg = (tenant?.brandConfigJson ?? {}) as Record<string, unknown>;

    const name =
      typeof cfg.name === 'string' && cfg.name.trim().length > 0
        ? cfg.name.trim().slice(0, 80)
        : base.name;

    // DB logo overlays env BRAND_LOGO_URL; both validated by safeLogo.
    const logo = safeLogo(cfg.logo, safeLogo(base.logoUrl));

    const resolved: BrandConfig = {
      ...base,
      name,
      accentColor: safeHexColor(cfg.accent ?? cfg.accentColor, base.accentColor),
    };
    if (logo) resolved.logo = logo;
    return resolved;
  } catch {
    return base;
  }
});

export function getBrandInitials(name: string): string {
  const parts = name
    .split(/\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return '?';
  if (parts.length === 1) {
    const word = parts[0]!;
    return word.slice(0, 2).toUpperCase();
  }
  return ((parts[0]![0] ?? '') + (parts[1]![0] ?? '')).toUpperCase();
}
