import type { NextRequest } from 'next/server';
import {
  cachedFetch,
  createLru,
  jsonError,
  jsonOk,
  requireApiUser,
} from '../_shared';
import type { SkillCategory } from '@/lib/eightvance/client';

interface SkillRow {
  id: number;
  name: string;
}
interface Grouped {
  soft: SkillRow[];
  hard: SkillRow[];
  knowledge: SkillRow[];
}

const cache = createLru<Grouped>({ max: 500, ttlMs: 5 * 60 * 1000 });

const VALID_CATEGORIES: ReadonlySet<SkillCategory> = new Set([
  'soft',
  'hard',
  'knowledge',
]);

/** Parse a comma-separated `exclude` list of skill ids into a number[]. */
function parseExclude(raw: string | null): number[] {
  if (!raw) return [];
  const out: number[] = [];
  for (const part of raw.split(',')) {
    const n = Number(part.trim());
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

/**
 * `GET /api/refdata/skill-suggestions?seed=<role>&locale=<nl|en|de>`
 * Role-relevant skill tiles grouped into soft / hard / knowledge buckets
 * (≈5 each) in the requested language, for the wizard's click-to-add grid.
 *
 * Per-category "load more":
 *   `&category=<soft|hard|knowledge>&exclude=<id,id,...>`
 *   Returns the NEXT distinct batch for that one bucket (the others empty),
 *   skipping every id in `exclude` (already shown/added tiles).
 */
export async function GET(req: NextRequest) {
  const auth = await requireApiUser(req);
  if (auth.kind === 'response') return auth.response;

  const seed = req.nextUrl.searchParams.get('seed')?.trim() ?? '';
  const locale = (req.nextUrl.searchParams.get('locale') ?? 'en').toLowerCase();
  const rawCategory = req.nextUrl.searchParams.get('category')?.trim().toLowerCase() ?? '';
  const category = VALID_CATEGORIES.has(rawCategory as SkillCategory)
    ? (rawCategory as SkillCategory)
    : undefined;
  const exclude = parseExclude(req.nextUrl.searchParams.get('exclude'));

  try {
    // Cache key folds in the category + exclude set so a "load more" never
    // collides with the initial fetch (or a different exclude window).
    const exKey = exclude.length > 0 ? [...exclude].sort((a, b) => a - b).join('.') : '';
    const key = `${auth.tenantId}:${seed.toLowerCase()}:${locale}:${category ?? 'all'}:${exKey}`;
    const results = await cachedFetch<Grouped>({
      cache,
      key,
      tenantId: auth.tenantId,
      compute: async (client) => {
        const g = await client.resources.suggestSkills(seed, locale, 5, {
          category,
          exclude,
        });
        return { soft: g.soft, hard: g.hard, knowledge: g.knowledge };
      },
    });
    return jsonOk({ results });
  } catch {
    return jsonError('lookup_failed');
  }
}
