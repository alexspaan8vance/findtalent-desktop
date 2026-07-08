'use client';

/**
 * Recruiter-side self-onboard controls.
 *
 * PRIMARY: a STABLE "website registration link" per pool — `${origin}/apply/
 * ${tenant.slug}`. It's deterministic (no server mint), so the recruiter just
 * picks a pool and we display + copy the link to embed on their website. Anyone
 * visiting it registers themselves as a NEW local candidate (status ONBOARDING)
 * in that pool; the recruiter reviews + syncs later. The link never expires and
 * is reusable by many applicants.
 *
 * SECONDARY (advanced, behind a disclosure): the legacy per-candidate
 * "Genereer self-onboard link" (createDraftInviteAction) which mints an EMPTY
 * draft candidate + a single-use magic link valid 14 days.
 *
 * Lives under src/lib so it can be a client component without adding a new file
 * in the (server-component) candidates route. Tenants are fetched from the
 * authed /api/tenants/list on first open.
 */

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

import { createDraftInviteAction } from '@/app/app/candidates/actions';

interface TenantOption {
  id: string;
  slug: string;
  name: string;
  isDefault?: boolean;
}

/**
 * Collapsed-by-default wrapper. The website-registration link is only relevant
 * ~20% of the time, so the whole control hides behind a small, quiet text
 * toggle ("Website registration link" + chevron). Clicking expands the existing
 * card. Tenants aren't fetched until the panel is first opened.
 */
export function DraftInviteControl() {
  const t = useTranslations('candidates');
  const [open, setOpen] = useState(false);

  return (
    <div className="mx-auto mt-4 max-w-md text-left">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-700"
      >
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`}
        >
          <path
            fillRule="evenodd"
            d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z"
            clipRule="evenodd"
          />
        </svg>
        {t('publicLinkToggle')}
      </button>

      {open ? <DraftInvitePanel /> : null}
    </div>
  );
}

/** The expanded card (former DraftInviteControl body). */
function DraftInvitePanel() {
  const t = useTranslations('candidates');
  const [tenants, setTenants] = useState<TenantOption[] | null>(null);
  const [tenantId, setTenantId] = useState('');

  useEffect(() => {
    let alive = true;
    fetch('/api/tenants/list', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { results?: TenantOption[] }) => {
        if (!alive) return;
        const rows = Array.isArray(data.results) ? data.results : [];
        setTenants(rows);
        // Pre-select ONLY a sole pool or the admin-flagged default. With
        // multiple pools and no default set, leave it empty so the recruiter
        // must consciously pick the pool.
        const preferred = rows.length === 1 ? rows[0] : rows.find((tn) => tn.isDefault);
        if (preferred) setTenantId(preferred.id);
      })
      .catch(() => {
        if (alive) setTenants([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const selected = tenants?.find((tn) => tn.id === tenantId) ?? null;

  return (
    <div className="mt-2 rounded-xl border border-zinc-200 bg-white p-4 text-left">
      <p className="text-sm font-medium text-zinc-900">{t('publicLinkHeading')}</p>
      <p className="mt-1 text-xs text-zinc-500">{t('publicLinkHint')}</p>

      <div className="mt-3">
        <label htmlFor="apply-pool" className="sr-only">
          {t('poolLabel')}
        </label>
        <select
          id="apply-pool"
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          disabled={tenants === null}
          className="block w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none disabled:bg-zinc-100"
          aria-label={t('poolLabel')}
        >
          {tenants === null ? (
            <option value="">{t('sourcesLoading')}</option>
          ) : tenants.length === 0 ? (
            <option value="">{t('poolPlaceholder')}</option>
          ) : (
            <>
              <option value="">{t('poolPlaceholder')}</option>
              {tenants.map((tn) => (
                <option key={tn.id} value={tn.id}>
                  {tn.name}
                </option>
              ))}
            </>
          )}
        </select>
      </div>

      {selected ? <PublicLinkBox slug={selected.slug} /> : null}

      {/* SECONDARY / advanced: legacy per-candidate single-use magic link. */}
      <DraftInviteAdvanced tenantId={tenantId} />
    </div>
  );
}

/**
 * The PRIMARY affordance: shows the deterministic, reusable per-pool URL for
 * the selected pool and a copy button. No server round-trip — the URL is just
 * `${origin}/apply/${slug}`.
 */
function PublicLinkBox({ slug }: { slug: string }) {
  const t = useTranslations('candidates');
  const [copied, setCopied] = useState(false);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const url = `${origin}/apply/${slug}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard blocked — the URL stays visible for manual copy.
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
      <p className="text-xs font-medium text-emerald-800">{t('publicLinkReady')}</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="block flex-1 break-all text-xs text-emerald-700">{url}</code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700"
        >
          {copied ? t('inviteCopied') : t('publicLinkCopy')}
        </button>
      </div>
    </div>
  );
}

/**
 * SECONDARY / advanced disclosure: the legacy per-candidate single-use link.
 * Collapsed by default so the stable website link is the obvious primary path.
 */
function DraftInviteAdvanced({ tenantId }: { tenantId: string }) {
  const t = useTranslations('candidates');
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function generate() {
    setError(null);
    setUrl(null);
    setCopied(false);
    if (!tenantId) {
      setError(t('error_no_tenant'));
      return;
    }
    startTransition(async () => {
      const res = await createDraftInviteAction({ tenantId });
      if (!res.ok) {
        setError(res.reason === 'no_tenant' ? t('error_no_tenant') : t('error_internal'));
        return;
      }
      const abs =
        typeof window !== 'undefined' ? `${window.location.origin}${res.url}` : res.url;
      setUrl(abs);
      try {
        await navigator.clipboard.writeText(abs);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      } catch {
        // Clipboard blocked — the link stays visible below for manual copy.
      }
    });
  }

  return (
    <div className="mt-4 border-t border-zinc-200 pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-medium text-zinc-500 underline hover:text-zinc-700"
        aria-expanded={open}
      >
        {t('draftInviteToggle')}
      </button>

      {open ? (
        <div className="mt-2">
          <p className="text-xs text-zinc-500">{t('draftInviteHint')}</p>
          <button
            type="button"
            onClick={generate}
            disabled={pending || !tenantId}
            className="mt-2 rounded-lg bg-zinc-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-40"
          >
            {pending ? t('inviteWorking') : t('draftInviteGenerate')}
          </button>

          {error ? (
            <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </p>
          ) : null}

          {url ? (
            <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
              <p className="text-xs font-medium text-zinc-700">
                {copied ? t('inviteCopied') : t('draftInviteReady')}
              </p>
              <p className="mt-1 break-all text-xs text-zinc-600">{url}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
