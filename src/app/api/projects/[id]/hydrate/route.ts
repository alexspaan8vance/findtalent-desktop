import { NextResponse, type NextRequest } from 'next/server';

import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { csrfCheck } from '@/lib/csrf';
import { hydrateMatchesForProject } from '@/lib/match/hydrate';
import { userCanAccessProject } from '@/lib/org';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Fallback ranking can fetch many talent profiles — allow a long budget.
export const maxDuration = 300;

/**
 * POST /api/projects/{id}/hydrate — drive matching forward for a project
 * (poll async tasks or run the sync/fallback ranker). Kept OFF the page
 * render path so navigation to the shortlist is instant; the client calls
 * this and polls /status.
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
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const project = await prisma.project.findUnique({
    where: { id },
    select: { userId: true, organizationId: true },
  });
  if (!project || !(await userCanAccessProject(userId, project))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  try {
    const result = await hydrateMatchesForProject(id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    // Return a real 5xx so monitors / the health probe can distinguish a
    // failed hydrate from a successful one. The client poller already tolerates
    // non-200 responses by retrying (it polls /status separately), so this is
    // safe for the UI while making failures observable to infra.
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
