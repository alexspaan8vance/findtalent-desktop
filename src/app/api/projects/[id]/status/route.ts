import { NextResponse, type NextRequest, after } from 'next/server';

import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { userCanAccessProject } from '@/lib/org';
import { hydrateMatchesForProject } from '@/lib/match/hydrate';
import {
  SYNC_TASK_SENTINEL,
  FALLBACK_TASK_SENTINEL,
  sweepStaleProjectPools,
} from '@/lib/eightvance/job-sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/projects/{id}/status — lightweight poll for the shortlist page:
 * returns per-pool status + cached match count without touching 8vance.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const session = (await auth()) as { user?: { id?: string | null } | null } | null;
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const project = await prisma.project.findUnique({
    where: { id },
    select: {
      userId: true,
      organizationId: true,
      status: true,
      pools: { select: { status: true, eightvanceTaskId: true } },
    },
  });
  if (!project || !(await userCanAccessProject(userId, project))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Recover pools wedged in MATCHING (async task never completed / executor
  // died) BEFORE reading state — so a project settles here instead of spinning
  // "Matching…" forever. Then read the (possibly updated) status fresh.
  await sweepStaleProjectPools(id);
  const fresh = await prisma.project.findUnique({
    where: { id },
    select: {
      status: true,
      pools: { select: { status: true, eightvanceTaskId: true } },
    },
  });
  const pools = fresh?.pools ?? project.pools;
  const projectStatus = fresh?.status ?? project.status;

  const matchCount = await prisma.match.count({ where: { projectId: id } });

  const statuses = pools.map((p) => p.status);

  // A pool is genuinely "matching" (progress should keep ticking) only if it's
  // MATCHING, OR DRAFT but with a task id already assigned (about to flip to
  // MATCHING). A DRAFT pool with NO eightvanceTaskId means the sync crashed
  // before kicking off the match — it is stuck, NOT actively matching, so it
  // must not keep the poller spinning forever. Such pools count as "settled"
  // (effectively failed) so the project can settle when none are READY.
  const isActivelyMatching = (p: { status: string; eightvanceTaskId: string | null }): boolean =>
    p.status === 'MATCHING' || (p.status === 'DRAFT' && !!p.eightvanceTaskId);

  const anyMatching = pools.some(isActivelyMatching);
  const settled = !anyMatching;

  // Re-drive the async match off the response. The poller POSTs /hydrate ONCE
  // on mount; if a real async task was still 'processing' then, nothing would
  // re-poll it and the pool would sit MATCHING forever (until a manual reload
  // re-mounts the poller). So whenever a pool is actively matching against a
  // REAL async task id (not the SYNC/FALLBACK sentinels, which already settle
  // inline on the first hydrate), opportunistically re-drive hydration here.
  // hydrateMatchesForProject dedups concurrent calls via its inflight map, so
  // this never piles up across the 2–4s polls. Runs via after() so /status
  // stays a lightweight, instant DB read for the client.
  const hasLiveAsyncTask = pools.some(
    (p) =>
      isActivelyMatching(p) &&
      !!p.eightvanceTaskId &&
      p.eightvanceTaskId !== SYNC_TASK_SENTINEL &&
      p.eightvanceTaskId !== FALLBACK_TASK_SENTINEL,
  );
  if (hasLiveAsyncTask) {
    after(() => hydrateMatchesForProject(id).catch(() => {}));
  }

  // Progress 0..100 derived from how many pools have left the working state.
  // While still working we keep a soft floor (and never report 100) so the bar
  // reads as "alive" instead of stuck at 0; once settled we report 100.
  const total = statuses.length;
  const settledPools = pools.filter((p) => !isActivelyMatching(p)).length;
  let progress: number;
  if (settled) {
    progress = 100;
  } else if (total === 0) {
    progress = 10;
  } else {
    const ratio = Math.round((settledPools / total) * 100);
    // Floor at 8% so something is always visible; cap at 92% until fully settled.
    progress = Math.min(92, Math.max(8, ratio));
  }

  return NextResponse.json({
    projectStatus,
    matchCount,
    progress,
    settled,
    pools: statuses,
  });
}
