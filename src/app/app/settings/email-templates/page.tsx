/**
 * Email-template settings — view and edit the org's standard email templates.
 *
 * Everyone authed can view; only the org OWNER can edit/reset (mirrors the
 * team-settings ownership model). Templates are lazily seeded from the
 * defaults on first access.
 */

import { getTranslations } from 'next-intl/server';
import { OrgRole } from '@prisma/client';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { getOrCreateUserOrg } from '@/lib/org';
import { listOrgTemplates, TEMPLATE_PLACEHOLDERS, type TemplateKey } from '@/lib/email/templates';

import { TemplateEditor, type TemplateEditorLabels } from './template-editor';

export default async function EmailTemplatesSettingsPage(): Promise<React.ReactElement> {
  const session = await requireUser();
  const t = await getTranslations('emailTemplates');

  const orgId = await getOrCreateUserOrg(session.id);

  const [templates, membership] = await Promise.all([
    listOrgTemplates(orgId),
    prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: orgId, userId: session.id } },
      select: { role: true },
    }),
  ]);
  const canEdit = membership?.role === OrgRole.OWNER;

  const labels: TemplateEditorLabels = {
    subjectLabel: t('subjectLabel'),
    bodyLabel: t('bodyLabel'),
    placeholdersLabel: t('placeholdersLabel'),
    save: t('save'),
    reset: t('reset'),
    saved: t('saved'),
    resetDone: t('resetDone'),
    errors: {
      not_owner: t('errNotOwner'),
      invalid_key: t('errInvalid'),
      invalid_input: t('errInvalid'),
      internal: t('errInternal'),
    },
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--ft-ink)' }}>
          {t('title')}
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--ft-ink)', opacity: 0.65 }}>
          {t('subtitle')}
        </p>
      </div>

      {!canEdit && (
        <p
          className="rounded-lg border px-4 py-3 text-sm"
          style={{ borderColor: 'var(--ft-border)', color: 'var(--ft-ink)', opacity: 0.7 }}
        >
          {t('readOnlyNote')}
        </p>
      )}

      <div className="space-y-5">
        {templates.map((tpl) => (
          <TemplateEditor
            key={tpl.key}
            tpl={{
              key: tpl.key,
              name: tpl.name,
              subject: tpl.subject,
              body: tpl.body,
              placeholders: TEMPLATE_PLACEHOLDERS[tpl.key as TemplateKey] ?? [],
            }}
            canEdit={canEdit}
            labels={labels}
          />
        ))}
      </div>
    </div>
  );
}
