import type { NextRequest } from 'next/server';
import {
  cachedFetch,
  createLru,
  jsonError,
  jsonOk,
  requireApiUser,
} from '../_shared';

interface FunctionNameRow {
  id: number;
  name: string;
}

const cache = createLru<FunctionNameRow[]>({ max: 500, ttlMs: 5 * 60 * 1000 });

export async function GET(req: NextRequest) {
  const auth = await requireApiUser(req);
  if (auth.kind === 'response') return auth.response;

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (q.length < 2) return jsonOk({ results: [] });

  try {
    const locale = (req.nextUrl.searchParams.get('locale') ?? 'en').toLowerCase();
    const key = `${auth.tenantId}:${q.toLowerCase()}:${locale}`;
    const results = await cachedFetch<FunctionNameRow[]>({
      cache,
      key,
      tenantId: auth.tenantId,
      compute: async (client) => {
        return client.resources.searchFunctionNames(q, 10, locale);
      },
    });
    return jsonOk({ results });
  } catch {
    return jsonError('lookup_failed');
  }
}
