/**
 * Read-through profile for a POOL-ONLY 8vance talent (FULL pool browse).
 *
 * This is the "View profile" target for a pool talent that has NO local
 * Candidate yet. It reads a best-effort LIVE snapshot from 8vance
 * (`fetchLiveTalent`) and renders it with the same owner-only `CandidateProfile`
 * component the local match screen uses — so the owner sees the full talent
 * before deciding to import it. An "Import / manage" action mirrors it into a
 * local Candidate (so it can be noted/tracked/edited + matched here).
 *
 * OWNER screen, org-guarded: the caller must own (or have a candidate in) the
 * pool. NOT the anonymized customer shortlist — full data is intentional here.
 *
 * The pool talent is identified by the route `talentId` + a `?tenantId=` query
 * (which pool it belongs to). If a local Candidate already exists for this
 * talent we redirect to its richer /match screen instead of the read-through.
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { requireUser } from '@/lib/auth-helpers';
import { prisma } from '@/lib/db';
import { getOrCreateUserOrg } from '@/lib/org';
import { fetchLiveTalent, dataQualityFrom } from '@/lib/candidate/profile-extras';
import {
  CandidateProfile,
  DataQualityStrip,
  SyncBadge,
  type StoredProfile,
  type ProfileLabels,
} from '@/components/candidate/candidate-profile';

import { ImportPoolTalentButton } from './import-button';

interface PageProps {
  params: Promise<{ talentId: string }>;
  searchParams: Promise<{ tenantId?: string }>;
}

export const dynamic = 'force-dynamic';

export default async function PoolTalentProfilePage({
  params,
  searchParams,
}: PageProps): Promise<React.ReactElement> {
  const user = await requireUser();
  const t = await getTranslations('candidateMatch');
  const tc = await getTranslations('candidates');

  const { talentId: talentIdRaw } = await params;
  const { tenantId } = await searchParams;
  const talentId = Number(talentIdRaw);
  const cleanTenantId = String(tenantId ?? '').trim();
  if (!Number.isFinite(talentId) || talentId <= 0 || !cleanTenantId) notFound();

  const tenant = await prisma.tenant.findUnique({
    where: { id: cleanTenantId },
    select: { id: true, talentScope: true, ownerOrganizationId: true },
  });
  if (!tenant) notFound();

  // Org guard: owning org, or an org with a candidate already in the pool.
  const orgId = await getOrCreateUserOrg(user.id);
  if (tenant.ownerOrganizationId && tenant.ownerOrganizationId !== orgId) {
    const own = await prisma.candidate.findFirst({
      where: { tenantId: tenant.id, organizationId: orgId },
      select: { id: true },
    });
    if (!own) notFound();
  }

  // If a local Candidate already exists for this talent, the richer match
  // screen is the right place — redirect there.
  const existing = await prisma.candidate.findFirst({
    where: {
      tenantId: tenant.id,
      organizationId: orgId,
      eightvanceTalentId: talentId,
      status: { not: 'ARCHIVED' },
    },
    select: { id: true },
  });
  if (existing) redirect(`/app/candidates/${existing.id}/match`);

  // Best-effort LIVE 8vance snapshot. Never throws (each sub-read try/caught).
  const live = await fetchLiveTalent(tenant.id, talentId);
  const quality = dataQualityFrom(talentId, live, 0);

  // Resolve a display name from the live profile (split-name aware).
  const p = live.profile as
    | { full_name?: unknown; first_name?: unknown; last_name?: unknown }
    | null;
  const full = typeof p?.full_name === 'string' ? p.full_name.trim() : '';
  const first = typeof p?.first_name === 'string' ? p.first_name.trim() : '';
  const last = typeof p?.last_name === 'string' ? p.last_name.trim() : '';
  const name = full || `${first} ${last}`.trim() || tc('poolTalentRef', { id: talentId });

  const stored: StoredProfile = {
    about: null,
    hardSkills: [],
    softSkills: [],
    knowledge: [],
    education: [],
    employment: [],
    languages: [],
    certifications: [],
    location: null,
    email: typeof live.profile?.email === 'string' ? live.profile.email : null,
    phone: typeof live.profile?.phone === 'string' ? live.profile.phone : null,
  };

  const profileLabels: ProfileLabels = {
    about: t('cvProfile.about'),
    skills: t('cvProfile.skills'),
    hardSkills: t('cvProfile.hardSkills'),
    softSkills: t('cvProfile.softSkills'),
    knowledge: t('cvProfile.knowledge'),
    education: t('cvProfile.education'),
    employment: t('cvProfile.employment'),
    languages: t('cvProfile.languages'),
    certifications: t('cvProfile.certifications'),
    location: t('profile.location'),
    contact: t('profile.contact'),
    email: t('profile.email'),
    phone: t('profile.phone'),
    current: t('cvProfile.current'),
    level: (level: number) => t('cvProfile.level', { level }),
    liveBadge: t('profile.liveBadge'),
    storedBadge: t('profile.storedBadge'),
    dqTitle: t('dataQuality.title'),
    dqSynced: t('dataQuality.synced'),
    dqNotSynced: t('dataQuality.notSynced'),
    dqHasName: t('dataQuality.hasName'),
    dqNoName: t('dataQuality.noName'),
    dqMatchable: t('dataQuality.matchable'),
    dqNotMatchable: t('dataQuality.notMatchable'),
    dqMatchableUnknown: t('dataQuality.matchableUnknown'),
    dqSkills: (count: number) => t('dataQuality.skills', { count }),
    syncedBadge: (id: number) => t('syncBadge.synced', { id }),
    notSyncedBadge: t('syncBadge.notSynced'),
  };

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ft-muted)]">
            {tc('poolProfileEyebrow')}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-[var(--ft-ink)]">
              {name}
            </h1>
            <SyncBadge talentId={talentId} labels={profileLabels} />
          </div>
          <div className="mt-3">
            <DataQualityStrip quality={quality} labels={profileLabels} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/app/candidates"
            className="rounded-lg border border-[var(--ft-border)] px-3 py-1.5 text-sm text-[var(--ft-ink)] hover:bg-[var(--ft-surface-2)]"
          >
            {tc('poolBack')}
          </Link>
          <ImportPoolTalentButton tenantId={tenant.id} talentId={talentId} />
        </div>
      </header>

      <section className="mt-6 rounded-xl border border-[var(--ft-border)] bg-[var(--ft-surface)] p-5">
        <h2 className="mb-4 text-sm font-semibold text-[var(--ft-ink)]">{t('profile.title')}</h2>
        {live.reachable ? (
          <CandidateProfile
            stored={stored}
            live={{
              skills: live.skills,
              education: live.education,
              experience: live.experience,
              languages: live.languages,
              location: live.location,
              reachable: live.reachable,
            }}
            labels={profileLabels}
          />
        ) : (
          <p className="text-sm text-[var(--ft-muted)]">{tc('poolProfileUnreachable')}</p>
        )}
      </section>
    </main>
  );
}
