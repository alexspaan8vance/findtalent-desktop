import { NextResponse, type NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { csrfCheck } from '@/lib/csrf';
import { getOrCreateUserOrg } from '@/lib/org';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/candidates/{id}/delete — GDPR Art.17 right to erasure.
 *
 * Org-guarded (same shape as run-match): the acting user must have created the
 * candidate OR share its organization. HARD-deletes the Candidate row; the
 * CandidateMatchRun → CandidateJobMatch relations cascade (onDelete: Cascade in
 * the schema), so all stored data — including the encrypted PII columns — is
 * physically gone. If the candidate is synced (has an eightvanceTalentId) we also
 * purge the employer-side rows keyed by (tenantId, eightvanceTalentId) — Reveal,
 * Match, and ShortlistEntry — in the same transaction. We do NOT delete the 8vance
 * talent here (that lives in a separate system / tenant scope); this erases
 * findtalent's own copy.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // CSRF: destructive cookie-auth POST (GDPR erasure) — reject cross-site
  // Origin/Referer before any lookup or delete (F8).
  const csrf = csrfCheck(req);
  if (csrf) return csrf;

  const { id } = await ctx.params;
  const user = await requireUser();

  const candidate = await prisma.candidate.findUnique({
    where: { id },
    select: {
      id: true,
      organizationId: true,
      createdByUserId: true,
      tenantId: true,
      eightvanceTalentId: true,
    },
  });
  if (!candidate) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Resolve the caller's org up-front from the AUTHED userId (never client input):
  // it both authorizes the delete (creator OR same org as the candidate) and
  // scopes the employer-side purge below.
  const orgId = await getOrCreateUserOrg(user.id);
  let allowed = candidate.createdByUserId === user.id;
  if (!allowed && candidate.organizationId) {
    allowed = candidate.organizationId === orgId;
  }
  if (!allowed) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // True Art.17 erasure: the Candidate row + CandidateMatchRun → CandidateJobMatch
  // cascade away, but employer-side rows keyed by (tenantId, eightvanceTalentId)
  // — Reveal (decrypted PII payload!), Match, and ShortlistEntry (via its Match) —
  // are NOT linked to Candidate and would otherwise survive. Purge them in the same
  // transaction, but ONLY when this candidate is synced (has an eightvanceTalentId).
  //
  // CROSS-ORG SAFETY: a FULL pool is shared, so ANOTHER org may hold its own paid
  // Reveal / Match / ShortlistEntry for the same (tenantId, eightvanceTalentId).
  // Those belong to that org (their bought PII, their pipeline) and MUST survive.
  // Ownership runs through the project (Match.projectId, Reveal.projectId,
  // ShortlistEntry → Match.project), so we scope every delete to THIS caller's
  // org's projects — the same `userId OR organizationId` scope the projects list
  // uses. Rows hanging off another org's projects are never reached.
  const { tenantId, eightvanceTalentId } = candidate;
  await prisma.$transaction(async (tx) => {
    if (tenantId && eightvanceTalentId != null) {
      const orgProjects = await tx.project.findMany({
        where: { OR: [{ userId: user.id }, { organizationId: orgId }] },
        select: { id: true },
      });
      const orgProjectIds = orgProjects.map((p) => p.id);
      if (orgProjectIds.length > 0) {
        const scope = {
          tenantId,
          eightvanceTalentId,
          projectId: { in: orgProjectIds },
        };
        // ShortlistEntry has no tenant/talent/project columns; it hangs off Match.
        // Delete this org's entries for this tenant+talent's matches first, then
        // the matches, then the reveals — every delete project-scoped to the org.
        await tx.shortlistEntry.deleteMany({ where: { match: scope } });
        await tx.match.deleteMany({ where: scope });
        await tx.reveal.deleteMany({ where: scope });
      }
    }
    // Hard delete; match runs + job matches cascade. PII columns are gone.
    await tx.candidate.delete({ where: { id } });
  });

  // GDPR audit trail (no PII in the log line — only ids + actor).
  console.warn(
    `[gdpr-erasure] candidate ${id} hard-deleted by user ${user.id} at ${new Date().toISOString()}`,
  );

  return NextResponse.json({ ok: true });
}
