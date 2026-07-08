'use client';

/**
 * Shared talent-pool multi-select.
 *
 * The checkbox list of available 8vance pools (Tenant rows) used in BOTH the
 * create wizard's "Talentbestanden" step and the edit form. Extracted so the
 * two flows can never drift on the pool-picking UX. Purely presentational +
 * controlled: the parent owns `selectedPoolIds` and toggles via `onToggle`.
 *
 * RSC note: this is a Client Component and `onToggle` is only ever passed from
 * other Client Components (the wizard + edit form) — never server→client.
 */

import { useTranslations } from 'next-intl';

export interface PoolTenantOption {
  id: string;
  slug: string;
  name: string;
  defaultLocale: string;
}

interface PoolSelectProps {
  tenantOptions: PoolTenantOption[];
  selectedPoolIds: string[];
  onToggle: (id: string) => void;
  /** Hide the heading/description (the wizard step already frames them). */
  hideHeader?: boolean;
}

export function PoolSelect({
  tenantOptions,
  selectedPoolIds,
  onToggle,
  hideHeader = false,
}: PoolSelectProps): React.ReactElement {
  const t = useTranslations('wizard');
  return (
    <div className="space-y-4">
      {!hideHeader ? (
        <div>
          <h2 className="text-sm font-medium text-zinc-900">{t('poolsTitle')}</h2>
          <p className="mt-1 text-xs text-zinc-500">{t('poolsDescription')}</p>
        </div>
      ) : null}
      {tenantOptions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-6 text-center text-sm text-zinc-500">
          {t('noPoolsConfigured')}{' '}
          <code className="rounded bg-white px-1.5 py-0.5">/admin/companies</code>.
        </div>
      ) : (
        <ul className="space-y-2">
          {tenantOptions.map((opt) => {
            const checked = selectedPoolIds.includes(opt.id);
            return (
              <li key={opt.id}>
                <label
                  className={`flex cursor-pointer items-center justify-between rounded-lg border px-4 py-3 ${
                    checked
                      ? 'border-zinc-900 bg-zinc-50'
                      : 'border-zinc-200 hover:bg-zinc-50'
                  }`}
                >
                  <div>
                    <div className="text-sm font-medium text-zinc-900">
                      {opt.name}
                    </div>
                    <div className="text-xs text-zinc-500">{opt.slug}</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(opt.id)}
                    className="h-4 w-4 rounded border-zinc-300"
                  />
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
