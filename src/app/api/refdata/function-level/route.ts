import type { NextRequest } from 'next/server';
import {
  cachedFetch,
  createLru,
  jsonOk,
  mapReferenceList,
  requireApiUser,
} from '../_shared';

interface LevelRow {
  id: number;
  name: string;
}

const cache = createLru<LevelRow[]>({ max: 50, ttlMs: 24 * 60 * 60 * 1000 });

export async function GET(req: NextRequest) {
  const auth = await requireApiUser(req);
  if (auth.kind === 'response') return auth.response;

  try {
    const locale = (req.nextUrl.searchParams.get('locale') ?? 'en').toLowerCase();
    const key = `${auth.tenantId}:function-level:${locale}`;
    const results = await cachedFetch<LevelRow[]>({
      cache,
      key,
      tenantId: auth.tenantId,
      compute: async (client) => {
        const rows = await client.resources.listFunctionLevels();
        // One row per (level × locale) — keep the requested locale, dedupe, sort.
        return mapReferenceList(rows as unknown as Array<Record<string, unknown>>, locale);
      },
    });
    return jsonOk({ results });
  } catch {
    return jsonOk({ results: [] });
  }
}
