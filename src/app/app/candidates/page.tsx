import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { prisma } from '@/lib/db';
import { requireCandidatesAccess } from '@/lib/auth-helpers';
import { getOrCreateUserOrg } from '@/lib/org';
import { sweepStaleRuns } from '@/lib/candidate/service';
import { DraftInviteControl } from '@/lib/candidate/draft-invite-control';
import { CandidateList, type LocalRow, type FullPool } from './candidate-list';

export const dynamic = 'force-dynamic';

// --- Defensive projectors for the free-form Json columns -------------------
// profileJson / preferencesJson are `Json?` (may be null, a primitive, or a
// partial object). Everything below narrows carefully and never throws.

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/**
 * Skill NAMES for filtering. profileJson.skills holds 8vance taxonomy ids
 * (numbers), useless for a text token filter — so we read the human-readable
 * skill buckets the CV parser/edit flow maintain under profileJson.cv
 * (hardSkills / softSkills / knowledge). Missing CV block ⇒ no skill tokens.
 */
function projectSkills(profileJson: unknown): string[] {
  const profile = asRecord(profileJson);
  const cv = asRecord(profile?.cv);
  if (!cv) return [];
  const all = [
    ...asStringArray(cv.hardSkills),
    ...asStringArray(cv.softSkills),
    ...asStringArray(cv.knowledge),
  ];
  // Dedupe case-insensitively, keep first-seen casing.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of all) {
    const k = s.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

/** Home location label from profileJson.detailed_location → preferences.locationCity. */
function projectLocation(profileJson: unknown, preferencesJson: unknown): string | null {
  const profile = asRecord(profileJson);
  const loc = asRecord(profile?.detailed_location);
  const parts = [loc?.city, loc?.region, loc?.country].filter(
    (p): p is string => typeof p === 'string' && p.trim() !== '',
  );
  if (parts.length > 0) return parts.join(', ');
  const prefs = asRecord(preferencesJson);
  return typeof prefs?.locationCity === 'string' && prefs.locationCity.trim() !== ''
    ? prefs.locationCity
    : null;
}

/** Contract types from preferencesJson (validated enum on write). */
function projectContractTypes(preferencesJson: unknown): string[] {
  const prefs = asRecord(preferencesJson);
  return asStringArray(prefs?.contractTypes);
}

/** Remote preference from preferencesJson. */
function projectRemote(preferencesJson: unknown): boolean {
  const prefs = asRecord(preferencesJson);
  return prefs?.remote === true;
}

export default async function CandidatesPage() {
  const user = await requireCandidatesAccess();
  const t = await getTranslations('candidates');
  const orgId = await getOrCreateUserOrg(user.id);

  // Catch-up safety net: a self-onboard candidate's match runs via after()
  // off-response. If the process died before that ran, the run would sit
  // MATCHING forever (the candidate never opens the match screen that sweeps).
  // Sweep stale runs whenever a recruiter opens the dashboard — fire-and-forget
  // so it never slows the page. (Full auto-recovery wants a cron — see P2.)
  void sweepStaleRuns().catch(() => {});

  const candidates = await prisma.candidate.findMany({
    where: {
      status: { not: 'ARCHIVED' },
      OR: [{ createdByUserId: user.id }, { organizationId: orgId }],
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      email: true,
      status: true,
      createdAt: true,
      eightvanceTalentId: true,
      // Rich fields backing the super-specific filters. profileJson +
      // preferencesJson are free-form Json (may be null / partial), so every
      // read below is defensive.
      profileJson: true,
      preferencesJson: true,
    },
  });

  // Resolve the owner's pool(s) + their talentScope. A pool is "the owner's"
  // when their org owns its intake (ownerOrganizationId) OR they already have a
  // candidate in it. For FULL-scope pools we ALSO surface the 8vance talents
  // (read through, paginated, client-side) — for LOCAL pools the list keeps
  // today's behaviour (local Candidate rows only).
  const localTenantIds = Array.from(
    new Set(
      (
        await prisma.candidate.findMany({
          where: { organizationId: orgId, tenantId: { not: null } },
          select: { tenantId: true },
          distinct: ['tenantId'],
        })
      )
        .map((c) => c.tenantId)
        .filter((id): id is string => !!id),
    ),
  );

  // ADMIN = the platform operator: they manage every pool, so show them all
  // (a freshly-added pool has no owner-org / candidates yet — it must still
  // appear). Non-admins (customers) only see pools their org owns or already
  // has a candidate in. `undefined` where = no filter = all tenants.
  const pools = await prisma.tenant.findMany({
    where:
      user.role === 'ADMIN'
        ? undefined
        : {
            OR: [
              { ownerOrganizationId: orgId },
              ...(localTenantIds.length > 0 ? [{ id: { in: localTenantIds } }] : []),
            ],
          },
    select: { id: true, name: true, talentScope: true },
    orderBy: { name: 'asc' },
  });

  // Only FULL pools drive the read-through browse. LOCAL pools surface nothing
  // beyond their local Candidate rows (already in `candidates`).
  const fullPools: FullPool[] = pools
    .filter((p) => String(p.talentScope).toUpperCase() === 'FULL')
    .map((p) => ({ tenantId: p.id, name: p.name }));

  const localRows: LocalRow[] = candidates.map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
    eightvanceTalentId: c.eightvanceTalentId,
    // Projected rich fields backing the super-specific filters (defensive).
    skills: projectSkills(c.profileJson),
    location: projectLocation(c.profileJson, c.preferencesJson),
    contractTypes: projectContractTypes(c.preferencesJson),
    remote: projectRemote(c.preferencesJson),
  }));

  const hasAnything = localRows.length > 0 || fullPools.length > 0;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-900">{t('title')}</h1>
        <Link
          href="/app/candidates/new"
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
        >
          {t('newCandidate')}
        </Link>
      </div>

      {hasAnything ? (
        <div className="mb-6">
          <DraftInviteControl />
        </div>
      ) : null}

      {!hasAnything ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 p-8 text-center">
          <h2 className="text-lg font-semibold text-zinc-900">{t('emptyTitle')}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-zinc-500">{t('emptyBody')}</p>
          <div className="mt-5 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/app/candidates/new"
              className="inline-flex items-center justify-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
            >
              {t('newCandidate')}
            </Link>
          </div>
          <DraftInviteControl />
          <p className="mx-auto mt-3 max-w-md text-xs text-zinc-400">{t('emptyInviteHint')}</p>
        </div>
      ) : (
        <CandidateList localRows={localRows} fullPools={fullPools} />
      )}
    </div>
  );
}
