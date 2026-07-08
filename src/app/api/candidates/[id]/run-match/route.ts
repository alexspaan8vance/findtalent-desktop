import { NextResponse, type NextRequest, after } from 'next/server';

import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { csrfCheck } from '@/lib/csrf';
import { getOrCreateUserOrg } from '@/lib/org';
import { userMayAccessCandidates } from '@/lib/candidate/access';
import { executeMatchRun } from '@/lib/candidate/service';
import { reportError } from '@/lib/observability/report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The actual matching (per-source inverse match over big external feeds +
// enrichment) is slow — give it a generous budget OFF the onboarding server
// action's request path. The match screen's poller triggers this once.
export const maxDuration = 300;

/**
 * POST /api/candidates/{id}/run-match — execute the latest MATCHING run for a
 * candidate, off the request path that created it. Org-guarded. `executeMatchRun`
 * atomically claims the run, so concurrent triggers (two poller mounts) are safe.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // CSRF: state-changing cookie-auth POST — reject cross-site Origin/Referer (F8).
  const csrf = csrfCheck(req);
  if (csrf) return csrf;

  const { id } = await ctx.params;
  const session = (await auth()) as { user?: { id?: string | null } | null } | null;
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Candidates-surface gate (fresh DB read, not the JWT claim).
  if (!(await userMayAccessCandidates(userId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const candidate = await prisma.candidate.findUnique({
    where: { id },
    select: { id: true, organizationId: true, createdByUserId: true },
  });
  if (!candidate) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let allowed = candidate.createdByUserId === userId;
  if (!allowed && candidate.organizationId) {
    const orgId = await getOrCreateUserOrg(userId);
    allowed = candidate.organizationId === orgId;
  }
  if (!allowed) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const run = await prisma.candidateMatchRun.findFirst({
    where: { candidateId: id, status: 'MATCHING' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!run) {
    // Nothing to run (already settled or never created) — not an error.
    return NextResponse.json({ ok: true, ran: false });
  }

  // Run the match in the BACKGROUND via after() and return immediately. This
  // decouples the (slow) match from the client connection entirely: the user
  // can navigate away / close the tab and the match still completes server-side
  // (the poller just reads match-status on whatever screen they're on next).
  // executeMatchRun atomically claims the run + flips it to READY/FAILED itself,
  // so a concurrent trigger is safe and errors never surface as an unhandled
  // rejection.
  after(() => {
    void executeMatchRun(run.id).catch((err) => {
      void reportError(err, { area: 'candidate.run-match', runId: run.id });
    });
  });
  return NextResponse.json({ ok: true, started: true });
}
