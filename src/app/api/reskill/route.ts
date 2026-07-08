import { NextResponse, type NextRequest } from 'next/server';

import { requireApiUser } from '../refdata/_shared';
import { consumeCvRate, cvRateKey } from '@/lib/candidate/cv-ratelimit';
import { trustedClientIp } from '@/lib/client-ip';
import { csrfCheck } from '@/lib/csrf';
import { reskillPaths } from '@/lib/match/reskill';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/reskill — career-path / reskill suggestions for a candidate's
 * current role or skill text. Body: { text: string, k?: number }.
 * Returns nearest jobs on the cluster-DNA + skill-gap per job. Auth + rate
 * limited (fans out to a paid OpenAI embed via v2match); returns
 * { neighbors: [] } when the service is disabled/unreachable.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // CSRF: cookie-auth POST that fans out to a paid embed — reject cross-site (F8).
  const csrf = csrfCheck(req);
  if (csrf) return csrf;

  const auth = await requireApiUser(req);
  if (auth.kind === 'response') return auth.response;

  const rl = await consumeCvRate(cvRateKey({ userId: auth.userId, ip: trustedClientIp(req.headers) }));
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
    );
  }

  let body: { text?: unknown; k?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return NextResponse.json({ error: 'text_required' }, { status: 400 });
  const k = typeof body.k === 'number' && Number.isFinite(body.k) ? Math.min(50, Math.max(1, body.k)) : 12;

  const result = await reskillPaths(text, k);
  return NextResponse.json(result ?? { from: text, neighbors: [] });
}
