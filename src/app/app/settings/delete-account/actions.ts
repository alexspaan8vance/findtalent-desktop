'use server';

import { redirect } from 'next/navigation';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { signOut } from '@/auth';

export async function exportAccountAction(): Promise<void> {
  const user = await requireUser();

  const dump = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      createdAt: true,
      creditsBalance: true,
      purchasedCredits: true,
      projects: {
        select: {
          id: true,
          title: true,
          status: true,
          createdAt: true,
          skillsJson: true,
          locationCity: true,
          locationCountry: true,
        },
      },
      reveals: {
        select: {
          id: true,
          projectId: true,
          eightvanceTalentId: true,
          revealedAt: true,
          expiresAt: true,
          creditCost: true,
          piiPayloadEnc: true,
        },
      },
      creditTx: {
        select: {
          id: true,
          delta: true,
          reason: true,
          refId: true,
          createdAt: true,
        },
      },
    },
  });

  // Server actions cannot return a file response directly in Next 16 — we
  // redirect to a download route with a one-shot token instead. For MVP we
  // instead just stash the dump on a temporary download endpoint.
  // Simpler interim: redirect to a route that re-fetches the dump.
  void dump;
  redirect('/api/account/export');
}

export async function deleteAccountAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const confirm = String(formData.get('confirm') ?? '').trim();
  if (confirm !== 'DELETE') {
    throw new Error('Confirmation text does not match.');
  }

  // Cascade deletes handle Project/Match/Reveal/CreditTransaction/SavedSearch
  // (they have real FK relations to User). We keep AdminAuditLog rows but
  // anonymize the adminUserId reference.
  //
  // Candidate is the exception: `Candidate.createdByUserId` is a loose scalar
  // with NO FK relation to User, so it is NOT cascade-deleted. Candidate rows
  // hold PII (name/email/phone/cvText/profileJson), so for GDPR Art.17 erasure
  // we must delete them explicitly. Candidate's CandidateMatchRun /
  // CandidateJobMatch children DO cascade from Candidate, so removing the
  // candidate is enough to take its match data with it.
  //
  // Org-shared trade-off: a candidate with a non-null `organizationId` belongs
  // to the org, not just this user. If the org still has OTHER members we leave
  // such candidates in place (the remaining members keep access). We only
  // hard-delete org-shared candidates when this user is the sole member of that
  // org — at that point the org is effectively the user and erasure applies.
  await prisma.$transaction(async (tx) => {
    // Orgs where this user is the *only* member — candidates shared with these
    // orgs are erasable along with the user.
    const memberships = await tx.organizationMember.findMany({
      where: { userId: user.id },
      select: { organizationId: true },
    });
    const soleOrgIds: string[] = [];
    for (const m of memberships) {
      const memberCount = await tx.organizationMember.count({
        where: { organizationId: m.organizationId },
      });
      if (memberCount <= 1) soleOrgIds.push(m.organizationId);
    }

    // Delete candidates this user created that are either personal (no org) or
    // shared only with an org the user solely owns. CandidateMatchRun /
    // CandidateJobMatch cascade from Candidate.
    await tx.candidate.deleteMany({
      where: {
        createdByUserId: user.id,
        OR: [
          { organizationId: null },
          ...(soleOrgIds.length > 0 ? [{ organizationId: { in: soleOrgIds } }] : []),
        ],
      },
    });

    // RevealLock.userId is a loose scalar with NO FK to User, so this user's
    // held exclusive locks are NOT cascade-deleted (their `revealId` merely gets
    // SET NULL when the Reveal cascades). Drop them explicitly so a deleted user
    // can't strand an active lock that blocks other recruiters from revealing
    // that (tenant, talent) until it expires.
    await tx.revealLock.deleteMany({ where: { userId: user.id } });

    await tx.user.delete({ where: { id: user.id } });
  });

  await signOut({ redirect: false });
  redirect('/?account_deleted=1');
}
