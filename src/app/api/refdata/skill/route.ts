import type { NextRequest } from 'next/server';
import {
  cachedFetch,
  createLru,
  jsonError,
  jsonOk,
  requireApiUser,
} from '../_shared';

interface SkillRow {
  id: number;
  name: string;
}

const cache = createLru<SkillRow[]>({ max: 500, ttlMs: 5 * 60 * 1000 });

export async function GET(req: NextRequest) {
  const auth = await requireApiUser(req);
  if (auth.kind === 'response') return auth.response;

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  // A single typed char is too noisy to search, but an EMPTY query is allowed:
  // it returns a default page of platform skills as focus-time suggestions.
  if (q.length === 1) return jsonOk({ results: [] });

  try {
    const locale = (req.nextUrl.searchParams.get('locale') ?? 'en').toLowerCase();
    // Always aim for 10 clean suggestions (searchSkills pages to fill it).
    const limit = 10;
    const key = `${auth.tenantId}:${q.toLowerCase()}:${locale}:${limit}`;
    const results = await cachedFetch<SkillRow[]>({
      cache,
      key,
      tenantId: auth.tenantId,
      compute: async (client) => {
        return client.resources.searchSkills(q, limit, locale);
      },
    });
    return jsonOk({ results });
  } catch {
    return jsonError('lookup_failed');
  }
}
