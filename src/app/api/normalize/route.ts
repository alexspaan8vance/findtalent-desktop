import { NextResponse, type NextRequest } from 'next/server';

import { requireApiUser } from '../refdata/_shared';
import { consumeCvRate, cvRateKey } from '@/lib/candidate/cv-ratelimit';
import { trustedClientIp } from '@/lib/client-ip';
import { csrfCheck } from '@/lib/csrf';
import { normalizeFunction } from '@/lib/match/normalize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/normalize — map a raw job title / CV term to canonical 8vance
 * function(s), language + gender invariant. Body: { text: string, topk?: number }.
 * Auth + rate limited (fans out to a paid OpenAI embed via v2match); returns
 * { canonical: null, functions: [] } when the service is off.
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

  let body: { text?: unknown; topk?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return NextResponse.json({ error: 'text_required' }, { status: 400 });
  const topk = typeof body.topk === 'number' && Number.isFinite(body.topk) ? Math.min(10, Math.max(1, body.topk)) : 5;

  const result = await normalizeFunction(text, topk);
  return NextResponse.json(result ?? { input: text, canonical: null, functions: [] });
}
