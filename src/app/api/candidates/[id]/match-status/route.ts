import { NextResponse, type NextRequest } from 'next/server';

import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { getOrCreateUserOrg } from '@/lib/org';
import { userMayAccessCandidates } from '@/lib/candidate/access';
import { sweepStaleRuns } from '@/lib/candidate/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/candidates/{id}/match-status — lightweight poll for the candidate
 * match screen. Returns the latest CandidateMatchRun status plus job counts
 * (total / staffing-agency / visible) so the progressive loader can show a
 * live "found N" and switch to results once the run settles. No 8vance calls.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const session = (await auth()) as
    | { user?: { id?: string | null } | null }
    | null;
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Candidates-surface gate (fresh DB read, not the JWT claim).
  if (!(await userMayAccessCandidates(userId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const candidate = await prisma.candidate.findUnique({
    where: { id },
    select: { id: true, organizationId: true, createdByUserId: true },
  });
  if (!candidate) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Org guard: own creation, or shared via the caller's primary org.
  let allowed = candidate.createdByUserId === userId;
  if (!allowed && candidate.organizationId) {
    const orgId = await getOrCreateUserOrg(userId);
    allowed = candidate.organizationId === orgId;
  }
  if (!allowed) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Recover orphaned runs (a killed background job stuck at MATCHING) so the
  // poller never spins forever.
  await sweepStaleRuns(id);

  const run = await prisma.candidateMatchRun.findFirst({
    where: { candidateId: id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });

  if (!run) {
    return NextResponse.json({
      status: null,
      settled: true,
      total: 0,
      agencyCount: 0,
      visibleCount: 0,
    });
  }

  const [total, agencyCount] = await Promise.all([
    prisma.candidateJobMatch.count({ where: { runId: run.id } }),
    prisma.candidateJobMatch.count({
      where: { runId: run.id, isStaffingAgency: true },
    }),
  ]);
  const visibleCount = total - agencyCount;
  const settled = run.status !== 'MATCHING';

  return NextResponse.json({
    status: run.status,
    settled,
    total,
    agencyCount,
    visibleCount,
  });
}
