/**
 * Pipeline settings — manage the org's configurable Kanban stages.
 *
 * Any authed org member may add / rename / recolor / reorder / remove stages
 * (org-scoped). The board template applies to every project. Stages are seeded
 * with a sensible default set on first load.
 */

import { getTranslations } from 'next-intl/server';

import { OrgRole } from '@prisma/client';

import { requireUser } from '@/lib/auth-helpers';
import { prisma } from '@/lib/db';
import { getOrCreateUserOrg } from '@/lib/org';
import { getOrCreateStages } from '@/lib/pipeline';

import { StageManager } from './stage-manager';
import { ConfirmMovesToggle } from './confirm-moves-toggle';

export default async function PipelineSettingsPage(): Promise<React.ReactElement> {
  const session = await requireUser();
  const t = await getTranslations('pipeline');

  const orgId = await getOrCreateUserOrg(session.id);
  const stages = await getOrCreateStages(orgId);

  const [org, membership] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { confirmStageMoves: true },
    }),
    prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: orgId, userId: session.id } },
      select: { role: true },
    }),
  ]);
  const isOwner = membership?.role === OrgRole.OWNER;
  const confirmStageMoves = org?.confirmStageMoves ?? true;

  const labels = {
    title: t('settingsTitle'),
    subtitle: t('settingsSubtitle'),
    addTitle: t('addStage'),
    namePlaceholder: t('namePlaceholder'),
    terminal: t('terminal'),
    terminalHint: t('terminalHint'),
    add: t('add'),
    save: t('save'),
    moveUp: t('moveUp'),
    moveDown: t('moveDown'),
    remove: t('remove'),
    color: t('color'),
    errInvalid: t('errInvalid'),
    errLastStage: t('errLastStage'),
    errInternal: t('errInternal'),
    saved: t('saved'),
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--ft-ink)' }}>
          {labels.title}
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--ft-ink)', opacity: 0.65 }}>
          {labels.subtitle}
        </p>
      </div>

      <ConfirmMovesToggle
        enabled={confirmStageMoves}
        canEdit={isOwner}
        labels={{
          title: t('confirmMovesTitle'),
          hint: t('confirmMovesHint'),
          ownerOnly: t('confirmMovesOwnerOnly'),
          on: t('confirmMovesOn'),
          off: t('confirmMovesOff'),
          saved: labels.saved,
          errInternal: labels.errInternal,
        }}
      />

      <StageManager
        stages={stages.map((s) => ({
          id: s.id,
          name: s.name,
          color: s.color,
          isTerminal: s.isTerminal,
        }))}
        labels={labels}
      />
    </div>
  );
}
