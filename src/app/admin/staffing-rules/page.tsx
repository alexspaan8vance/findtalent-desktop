import { getTranslations } from 'next-intl/server';

import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth-helpers';
import {
  DEFAULT_AGENCY_NAME_PATTERNS,
  DEFAULT_AGENCY_DESCRIPTION_PATTERNS,
  DEFAULT_AGENCY_CONTRACT_PATTERNS,
} from '@/lib/match/staffing';

import { AddRuleForm, RuleRow } from './rules-forms';

/**
 * Admin editor for the staffing-agency / uitzendbureau detection rules used by
 * the candidate-match module. Shows the read-only built-in defaults and lets an
 * admin manage global custom rules (organizationId = null). Access is gated by
 * `requireAdmin` (also enforced by the /admin layout).
 */

function Chips({ items }: { items: readonly string[] }): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((p) => (
        <span
          key={p}
          className="rounded-full bg-zinc-100 px-2.5 py-1 font-mono text-xs text-zinc-700"
        >
          {p}
        </span>
      ))}
    </div>
  );
}

export default async function AdminStaffingRulesPage(): Promise<React.ReactElement> {
  await requireAdmin();
  const t = await getTranslations('staffingRules');

  const rules = await prisma.staffingAgencyRule.findMany({
    where: { organizationId: null },
    orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }],
  });

  const errors = {
    invalid: t('errors.invalid'),
    empty: t('errors.empty'),
    duplicate: t('errors.duplicate'),
    not_found: t('errors.notFound'),
    internal: t('errors.internal'),
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900">{t('title')}</h1>
        <p className="mt-1 text-sm text-zinc-500">{t('subtitle')}</p>
      </div>

      {/* Built-in defaults — read-only. */}
      <section className="space-y-4 rounded-xl border border-zinc-200 bg-white p-6">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">{t('defaults.title')}</h2>
          <p className="mt-1 text-sm text-zinc-500">{t('defaults.note')}</p>
        </div>
        <div className="space-y-4">
          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              {t('defaults.names')}
            </h3>
            <Chips items={DEFAULT_AGENCY_NAME_PATTERNS} />
          </div>
          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              {t('defaults.descriptions')}
            </h3>
            <Chips items={DEFAULT_AGENCY_DESCRIPTION_PATTERNS} />
          </div>
          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              {t('defaults.contracts')}
            </h3>
            <Chips items={DEFAULT_AGENCY_CONTRACT_PATTERNS} />
          </div>
        </div>
      </section>

      {/* Custom rules — editable. */}
      <section className="space-y-4 rounded-xl border border-zinc-200 bg-white p-6">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">{t('custom.title')}</h2>
          <p className="mt-1 text-sm text-zinc-500">{t('custom.note')}</p>
        </div>

        <AddRuleForm
          labels={{
            kindName: t('kind.name'),
            kindDescription: t('kind.description'),
            patternPlaceholder: t('custom.patternPlaceholder'),
            labelPlaceholder: t('custom.labelPlaceholder'),
            add: t('custom.add'),
            added: t('custom.added'),
            errors,
          }}
        />

        <div className="overflow-hidden rounded-xl border border-zinc-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-4 py-3">{t('table.kind')}</th>
                <th className="px-4 py-3">{t('table.pattern')}</th>
                <th className="px-4 py-3">{t('table.label')}</th>
                <th className="px-4 py-3">{t('table.status')}</th>
                <th className="px-4 py-3 text-right">{t('table.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-zinc-400">
                    {t('custom.empty')}
                  </td>
                </tr>
              ) : (
                rules.map((r) => (
                  <RuleRow
                    key={r.id}
                    id={r.id}
                    kind={r.kind === 'NAME' ? t('kind.name') : t('kind.description')}
                    pattern={r.pattern}
                    label={r.label}
                    enabled={r.enabled}
                    labels={{
                      enable: t('status.enabled'),
                      disable: t('status.disabled'),
                      delete: t('custom.delete'),
                      confirmDelete: t('custom.confirmDelete'),
                      errors,
                    }}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
