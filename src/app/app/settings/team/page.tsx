/**
 * Team settings — manage org members (team seats).
 *
 * Everyone authed can view their org's members. Only the OWNER sees the invite
 * box + remove buttons. Projects are shared across the org; credits/reveals
 * stay per-user.
 */

import { getTranslations } from 'next-intl/server';
import { OrgRole } from '@prisma/client';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { getOrCreateUserOrg } from '@/lib/org';

import { InviteForm, RemoveButton, ResendButton, CopyLinkButton } from './team-forms';
import { buildInviteLink } from './invite-link';

export default async function TeamSettingsPage(): Promise<React.ReactElement> {
  const session = await requireUser();
  const t = await getTranslations('team');

  const orgId = await getOrCreateUserOrg(session.id);

  const members = await prisma.organizationMember.findMany({
    where: { organizationId: orgId },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    select: {
      userId: true,
      role: true,
      user: { select: { email: true, name: true, passwordHash: true } },
    },
  });

  const isOwner = members.some(
    (m) => m.userId === session.id && m.role === OrgRole.OWNER,
  );

  const errorLabels: Record<string, string> = {
    invalid_email: t('errInvalidEmail'),
    not_owner: t('errNotOwner'),
    already_member: t('errAlreadyMember'),
    in_other_org: t('errInOtherOrg'),
    self: t('errSelf'),
    not_found: t('errNotFound'),
    last_owner: t('errLastOwner'),
    internal: t('errInternal'),
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

      {isOwner ? (
        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            {t('inviteTitle')}
          </h2>
          <p className="mb-4 mt-1 text-sm text-zinc-600">{t('inviteHint')}</p>
          <InviteForm
            labels={{
              emailPlaceholder: t('emailPlaceholder'),
              invite: t('invite'),
              attached: t('inviteAttached'),
              pending: t('invitePending'),
              emailSent: t('inviteEmailSent'),
              emailFailed: t('inviteEmailFailed'),
              copyLink: t('copyLink'),
              copied: t('copied'),
              errors: errorLabels,
            }}
          />
        </section>
      ) : null}

      <section className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          {t('membersTitle')}
        </h2>
        <ul className="mt-4 divide-y divide-zinc-100">
          {members.map((m) => {
            const isPending = !m.user.passwordHash;
            // Only pending members get a shareable signup link. Carries the
            // email only (no secret); see buildInviteLink. Computed server-side
            // and passed as a plain string (RSC-safe — no function props).
            const inviteLink = isPending ? buildInviteLink(m.user.email) : null;
            return (
              <li key={m.userId} className="flex flex-col gap-2 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-zinc-900">
                      {m.user.email}
                      {m.userId === session.id ? (
                        <span className="ml-2 text-xs text-zinc-400">{t('you')}</span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
                      <span>{m.role === OrgRole.OWNER ? t('roleOwner') : t('roleMember')}</span>
                      {isPending ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700">
                          {t('statusPending')}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {isOwner && m.userId !== session.id ? (
                    <div className="flex items-center gap-2">
                      {isPending ? (
                        <ResendButton
                          userId={m.userId}
                          label={t('resend')}
                          sentLabel={t('inviteEmailSent')}
                          failedLabel={t('inviteEmailFailed')}
                          errors={errorLabels}
                        />
                      ) : null}
                      <RemoveButton
                        userId={m.userId}
                        label={t('remove')}
                        errors={errorLabels}
                      />
                    </div>
                  ) : null}
                </div>
                {isOwner && inviteLink ? (
                  <div>
                    <p className="mb-1 text-xs text-zinc-500">{t('copyHint')}</p>
                    <CopyLinkButton
                      link={inviteLink}
                      copyLabel={t('copyLink')}
                      copiedLabel={t('copied')}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
