/**
 * POST /api/reveals
 *
 * Body: { matchId: string }
 * Auth: cookie session.
 *
 * Delegates to the same revealAction used by the server component so the
 * UX is consistent. Returns 200 on success, 402 for insufficient credits,
 * 409 for lock contention, 404 for missing/foreign match, 401 unauth.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { auth } from '@/auth';
import { csrfCheck } from '@/lib/csrf';
import { revealAction } from '@/app/app/projects/[id]/talent/[opaqueId]/actions';

const Body = z.object({
  matchId: z.string().min(1),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  // CSRF: this is a state-changing cookie-auth POST (spends reveal credits) —
  // reject a cross-site Origin/Referer before touching the session (F8).
  const csrf = csrfCheck(req);
  if (csrf) return csrf;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: 'bad_request' }, { status: 400 });
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: 'bad_request' }, { status: 400 });
  }

  const res = await revealAction(parsed.data.matchId);
  if (res.ok) {
    return NextResponse.json(res, { status: 200 });
  }

  const status =
    res.reason === 'not_found'
      ? 404
      : res.reason === 'locked'
        ? 409
        : res.reason === 'insufficient_credits'
          ? 402
          : 500;
  return NextResponse.json(res, { status });
}
