import type { NextRequest } from 'next/server';
import {
  cachedFetch,
  createLru,
  jsonError,
  jsonOk,
  requireApiUser,
} from '../_shared';

import { mapReferenceList } from '../_shared';

interface DegreeRow {
  id: number;
  name: string;
}

const cache = createLru<DegreeRow[]>({ max: 50, ttlMs: 24 * 60 * 60 * 1000 });

export async function GET(req: NextRequest) {
  const auth = await requireApiUser(req);
  if (auth.kind === 'response') return auth.response;

  try {
    const locale = (req.nextUrl.searchParams.get('locale') ?? 'en').toLowerCase();
    const key = `${auth.tenantId}:education-degree:${locale}`;
    const results = await cachedFetch<DegreeRow[]>({
      cache,
      key,
      tenantId: auth.tenantId,
      compute: async (client) => {
        const rows = await client.resources.listEducationDegrees();
        return mapReferenceList(rows as unknown as Array<Record<string, unknown>>, locale);
      },
    });
    return jsonOk({ results });
  } catch {
    return jsonError('lookup_failed');
  }
}
