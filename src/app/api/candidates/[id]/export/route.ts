import { NextResponse, type NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { getOrCreateUserOrg } from '@/lib/org';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/candidates/{id}/export — GDPR Art.20 data portability.
 *
 * Org-guarded (same shape as run-match / the match page): the acting user must
 * have created the candidate OR share its organization. Returns the candidate's
 * full data as a downloadable JSON file with PII DECRYPTED + human-readable —
 * Prisma's $extends transparently decrypts email/phone/cvText/profileJson on
 * read, so the dump already holds plaintext. Includes a summary of every match
 * run (status + timestamps + job count) for completeness.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const user = await requireUser();

  const candidate = await prisma.candidate.findUnique({
    where: { id },
    select: {
      id: true,
      organizationId: true,
      createdByUserId: true,
      tenantId: true,
      name: true,
      email: true,
      phone: true,
      locale: true,
      consentGivenAt: true,
      cvText: true,
      profileJson: true,
      preferencesJson: true,
      eightvanceTalentId: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      matchRuns: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          sourcesJson: true,
          filtersJson: true,
          createdAt: true,
          completedAt: true,
          jobs: {
            orderBy: { score: 'desc' },
            select: {
              eightvanceJobId: true,
              score: true,
              title: true,
              employerName: true,
              source: true,
              contractType: true,
              locationCity: true,
              locationLabel: true,
              isStaffingAgency: true,
            },
          },
        },
      },
    },
  });

  if (!candidate) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Org guard: creator or member of the owning org.
  let allowed = candidate.createdByUserId === user.id;
  if (!allowed && candidate.organizationId) {
    const orgId = await getOrCreateUserOrg(user.id);
    allowed = candidate.organizationId === orgId;
  }
  if (!allowed) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Human-readable dump. PII is already decrypted by the Prisma extension.
  const dump = {
    exportedAt: new Date().toISOString(),
    exportType: 'gdpr-article-20-data-portability',
    candidate: {
      id: candidate.id,
      name: candidate.name,
      email: candidate.email,
      phone: candidate.phone,
      locale: candidate.locale,
      status: candidate.status,
      consentGivenAt: candidate.consentGivenAt,
      cvText: candidate.cvText,
      profile: candidate.profileJson,
      preferences: candidate.preferencesJson,
      eightvanceTalentId: candidate.eightvanceTalentId,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
    },
    matchRuns: candidate.matchRuns.map((run) => ({
      id: run.id,
      status: run.status,
      sources: run.sourcesJson,
      filters: run.filtersJson,
      createdAt: run.createdAt,
      completedAt: run.completedAt,
      jobCount: run.jobs.length,
      jobs: run.jobs,
    })),
  };

  const filename = `candidate-export-${candidate.id}-${new Date()
    .toISOString()
    .slice(0, 10)}.json`;
  return new NextResponse(JSON.stringify(dump, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
