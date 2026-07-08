import { getBrandTheme } from '@/lib/brand/config';
import { requireAdmin } from '@/lib/auth-helpers';

import { updateBrandAccentAction } from './actions';

const PRESETS = [
  { name: 'Evergreen', hex: '#1f6f5c' },
  { name: 'Slate blue', hex: '#3a5a8c' },
  { name: 'Indigo', hex: '#4f46a3' },
  { name: 'Terracotta', hex: '#b4533a' },
  { name: 'Plum', hex: '#7a4a73' },
  { name: 'Graphite', hex: '#2f3338' },
];

export default async function BrandingPage() {
  await requireAdmin();
  const theme = await getBrandTheme();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">Branding</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Set the brand name, logo and accent colour used across the whole
          product. Tints, borders and hovers are derived from the accent
          automatically, so one calm colour themes the entire app.
        </p>
      </div>

      <section className="rounded-2xl border border-[var(--ft-border)] bg-[var(--ft-surface)] p-6">
        <form
          action={updateBrandAccentAction}
          encType="multipart/form-data"
          className="space-y-6"
        >
          {/* Brand name */}
          <div>
            <label
              htmlFor="brand-name"
              className="text-sm font-medium text-zinc-900"
            >
              Brand name
            </label>
            <input
              id="brand-name"
              type="text"
              name="name"
              defaultValue={theme.name}
              maxLength={80}
              placeholder="FindTalent"
              className="mt-2 block w-full rounded-md border border-[var(--ft-border)] bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-[var(--ft-accent)]"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Shown in the browser tab title and wherever the brand is rendered.
              Leave blank to fall back to the deploy default.
            </p>
          </div>

          {/* Logo upload */}
          <div>
            <label
              htmlFor="brand-logo"
              className="text-sm font-medium text-zinc-900"
            >
              Logo
            </label>
            <input
              id="brand-logo"
              type="file"
              name="logo"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              className="mt-2 block w-full text-sm text-zinc-700 file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-[var(--ft-border)] file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium file:text-zinc-700 hover:file:border-[var(--ft-accent)]"
            />
            <p className="mt-1 text-xs text-zinc-500">
              PNG, JPEG, SVG or WebP, up to 200&nbsp;KB. The current logo is kept
              if you leave this empty (or if the upload is invalid).
            </p>
          </div>

          {/* Accent picker */}
          <div>
            <span className="text-sm font-medium text-zinc-900">Accent colour</span>
            <div className="mt-3 flex items-center gap-3">
              <input
                type="color"
                name="accent"
                defaultValue={theme.accentColor}
                className="h-11 w-16 cursor-pointer rounded-md border border-[var(--ft-border)] bg-white p-1"
                aria-label="Accent colour"
              />
              <span className="font-mono text-sm text-zinc-700">{theme.accentColor}</span>
            </div>
          </div>

          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Calm presets
            </span>
            <div className="mt-2 flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.hex}
                  type="submit"
                  name="accent"
                  value={p.hex}
                  className="flex items-center gap-2 rounded-full border border-[var(--ft-border)] bg-white px-3 py-1.5 text-xs text-zinc-700 transition hover:border-[var(--ft-accent)]"
                >
                  <span
                    className="h-3.5 w-3.5 rounded-full"
                    style={{ background: p.hex }}
                  />
                  {p.name}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Presets save the colour immediately (keeping the current name &amp;
              logo). Use “Save branding” below to apply name, logo and accent
              together.
            </p>
          </div>

          {/* Live preview of the derived theme + brand. */}
          <div
            className="rounded-xl border border-[var(--ft-border)] p-4"
            style={{ ['--ft-accent' as string]: theme.accentColor }}
          >
            <div className="text-xs uppercase tracking-wide text-zinc-500">Preview</div>
            <div className="mt-3 flex items-center gap-3">
              {theme.logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- validated data/https URL
                <img
                  src={theme.logo}
                  alt={theme.name}
                  style={{ height: 32, width: 'auto' }}
                />
              ) : null}
              <span className="text-base font-semibold text-zinc-900">
                {theme.name}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span className="rounded-full bg-[var(--ft-accent)] px-3 py-1.5 text-xs font-medium text-[var(--ft-accent-fg)]">
                Reveal candidate
              </span>
              <span className="rounded-full border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-3 py-1 text-xs text-[var(--ft-accent-strong)]">
                Must-have match
              </span>
              <span className="ft-meter">
                {[1, 2, 3, 4, 5].map((n) => (
                  <i key={n} data-on={n <= 4 ? '1' : '0'} />
                ))}
              </span>
            </div>
          </div>

          <button
            type="submit"
            className="rounded-lg bg-[var(--ft-accent)] px-4 py-2 text-sm font-medium text-[var(--ft-accent-fg)] transition hover:bg-[var(--ft-accent-strong)]"
          >
            Save branding
          </button>
        </form>
      </section>
    </div>
  );
}
