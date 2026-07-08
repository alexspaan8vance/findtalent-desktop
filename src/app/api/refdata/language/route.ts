import type { NextRequest } from 'next/server';
import {
  cachedFetch,
  createLru,
  jsonError,
  jsonOk,
  requireApiUser,
} from '../_shared';

interface LanguageRow {
  id: number;
  name: string;
}

const cache = createLru<LanguageRow[]>({ max: 50, ttlMs: 24 * 60 * 60 * 1000 });

export async function GET(req: NextRequest) {
  const auth = await requireApiUser(req);
  if (auth.kind === 'response') return auth.response;

  try {
    const key = `${auth.tenantId}:language`;
    const results = await cachedFetch<LanguageRow[]>({
      cache,
      key,
      tenantId: auth.tenantId,
      compute: async (client) => {
        const rows = await client.resources.listLanguages();
        return rows.map((r) => ({
          id: r.id,
          name: r.display_name ?? r.name ?? String(r.id),
        }));
      },
    });
    return jsonOk({ results });
  } catch {
    return jsonError('lookup_failed');
  }
}
