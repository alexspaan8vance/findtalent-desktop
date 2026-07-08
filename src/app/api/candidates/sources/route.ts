/**
 * GET /api/candidates/sources?tenantId=<id>
 *
 * Returns the match SOURCES available to a tenant's pool, so the candidate
 * onboarding wizard can show a dynamic multi-select.
 *
 * 8vance has no source-catalog endpoint, but `GET /talent/{id}/sources/` lists
 * the sources a talent can match against (own pool + enabled external feeds
 * like OnlineVacaturesNL / public_vacancies_de + ecosystem). We sample one of
 * the tenant's talents and read its sources — that's the authoritative slug
 * list (slugs are case-sensitive and NOT guessable, e.g. `OnlineVacaturesNL`).
 *
 * Cached per tenant ~10 min. Best-effort: on any error we return at least the
 * tenant's own-pool slug so the wizard always has something selectable.
 *
 * Security: 8vance creds terminate server-side (vanceClientForTenant); authed +
 * tenant-validated by requireApiUser.
 */

import type { NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import { createLru } from '@/lib/cache/lru';
import { vanceClientForTenant } from '@/lib/eightvance/tenant-client';

import { jsonOk, requireApiUser } from '../../refdata/_shared';

export interface SourceOption {
  /** Source slug as stored in preferencesJson.sources + passed to the matcher. */
  slug: string;
  /** i18n key suffix ('ownpool') OR a raw slug the client renders as-is. */
  label: string;
  /** True when this source is the tenant's own talent pool. */
  ownPool: boolean;
}

interface SourcesPayload {
  sources: SourceOption[];
  ownSourceSlug: string;
}

const OWNPOOL_FALLBACK_SLUG = 'ownpool';
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = createLru<SourcesPayload>({ max: 100, ttlMs: CACHE_TTL_MS });

export async function GET(req: NextRequest) {
  const auth = await requireApiUser(req, { candidates: true });
  if (auth.kind === 'response') return auth.response;

  const tenant = await prisma.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { ownSourceSlug: true },
  });
  const ownSourceSlug = tenant?.ownSourceSlug?.trim() || OWNPOOL_FALLBACK_SLUG;

  const cached = cache.get(auth.tenantId);
  if (cached) return jsonOk(cached);

  const baseline: SourcesPayload = {
    ownSourceSlug,
    sources: [{ slug: ownSourceSlug, label: 'ownpool', ownPool: true }],
  };

  let payload: SourcesPayload = baseline;
  try {
    const client = await vanceClientForTenant(auth.tenantId);
    // Sample one talent from the pool, then read its authoritative source list.
    const ids = await client.listTalentIds(1);
    if (ids.length > 0) {
      const slugs = await client.talent.getSources(ids[0]);
      const seen = new Set<string>();
      const sources: SourceOption[] = [];
      for (const slug of slugs) {
        const s = slug.trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        const ownPool = s === ownSourceSlug;
        sources.push({ slug: s, label: ownPool ? 'ownpool' : s, ownPool });
      }
      // Ensure the own pool is present + sorted first.
      if (!seen.has(ownSourceSlug)) {
        sources.unshift({ slug: ownSourceSlug, label: 'ownpool', ownPool: true });
      }
      sources.sort((a, b) =>
        a.ownPool === b.ownPool ? a.slug.localeCompare(b.slug) : a.ownPool ? -1 : 1,
      );
      if (sources.length > 0) payload = { ownSourceSlug, sources };
    }
  } catch {
    payload = baseline;
  }

  cache.set(auth.tenantId, payload);
  return jsonOk(payload);
}
