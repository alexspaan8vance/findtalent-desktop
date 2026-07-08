import type { NextRequest } from 'next/server';

import { requireApiUser, jsonOk } from '../../../refdata/_shared';
import { NextResponse } from 'next/server';
import { getEnrich } from '@/lib/candidate/cv-enrich-cache';

// Reads the in-process enrich cache (Node-only); keep off the edge runtime.
export const runtime = 'nodejs';

/**
 * GET /api/candidates/parse-cv/enrich?tenantId=...&token=<enrichToken>
 *
 * Stage 2 of the two-stage CV parse: polled by the onboarding wizard after the
 * fast local parse, to pick up the slower 8vance result.
 *
 * Returns one of:
 *   { status: 'pending' }                       token known, 8vance still running
 *   { status: 'ready', parsed: {...} }           8vance returned usable data
 *   { status: 'none' }                           empty/failed parse OR unknown token
 *
 * Auth mirrors parse-cv (requireApiUser → 401/400/404/403). The token itself is
 * the unguessable capability for the result.
 */
export async function GET(req: NextRequest) {
  const auth = await requireApiUser(req, { candidates: true });
  if (auth.kind === 'response') return auth.response;

  const token = req.nextUrl.searchParams.get('token')?.trim();
  if (!token) {
    return NextResponse.json({ error: 'token query param required' }, { status: 400 });
  }

  const entry = getEnrich(token);
  // Unknown / expired token, or a resolved-but-empty/failed parse → 'none'.
  if (!entry || entry.status === 'none') {
    return jsonOk({ status: 'none' as const });
  }
  if (entry.status === 'pending') {
    return jsonOk({ status: 'pending' as const });
  }

  const p = entry.parsed;
  return jsonOk({
    status: 'ready' as const,
    parsed: {
      fullName: p.fullName,
      email: p.email,
      phone: p.phone,
      about: p.about,
      skills: p.skills,
      languages: p.languages,
      education: p.education,
      employment: p.employment,
    },
  });
}
