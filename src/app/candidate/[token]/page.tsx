import { getTranslations } from 'next-intl/server';

import { prisma } from '@/lib/db';
import { getBrandTheme } from '@/lib/brand/config';
import { highestEduTier, travelDefaultForTier } from '@/lib/candidate/preferences';
import { isSelfOnboardPlaceholderName } from '@/lib/candidate/self-onboard-name';
import type { TalentCreatePayload } from '@/lib/eightvance/types';
import { PortalForm, type SeedProfile } from './portal-form';

export const dynamic = 'force-dynamic';

/**
 * PUBLIC self-onboard portal. No auth: the candidate is resolved purely from a
 * valid, unexpired `portalToken`. We never expose any other candidate's data
 * and reveal nothing beyond what the invited candidate themselves provided.
 *
 * 8vance reference data lookups require an authed API user, so the portal does
 * NOT do live skill/language autocomplete. Instead it pre-seeds whatever the
 * recruiter already captured (profileJson) and lets the candidate confirm /
 * adjust proficiency, must-haves, location and preferences. At least 3 skills
 * must already be seeded for a self-submit to sync.
 */
/**
 * Portal-link liveness at request time: the token is unexpired and the profile
 * hasn't already been synced to 8vance. Module helper (not in the component
 * body) so render stays pure.
 */
function isPortalLinkUsable(candidate: {
  portalTokenExpires: Date | null;
  eightvanceTalentId: number | null;
}): boolean {
  return (
    !!candidate.portalTokenExpires &&
    candidate.portalTokenExpires.getTime() >= Date.now() &&
    candidate.eightvanceTalentId == null
  );
}

export default async function CandidatePortalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const t = await getTranslations('candidates');
  const theme = await getBrandTheme();

  const candidate = await prisma.candidate.findUnique({
    where: { portalToken: token },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      tenantId: true,
      profileJson: true,
      preferencesJson: true,
      portalTokenExpires: true,
      eightvanceTalentId: true,
    },
  });

  const expired = candidate == null || !isPortalLinkUsable(candidate);

  if (expired) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4">
        <div className="max-w-md rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-zinc-900">{t('portalExpiredTitle')}</h1>
          <p className="mt-2 text-sm text-zinc-500">{t('portalExpiredBody')}</p>
        </div>
      </main>
    );
  }

  // Build a safe seed for the client form (only this candidate's own data).
  const profile = (candidate.profileJson ?? {}) as Partial<TalentCreatePayload>;
  const prefs = (candidate.preferencesJson ?? {}) as {
    contractTypes?: string[];
    radiusKm?: number;
    remote?: boolean;
  };

  // From-scratch path: the recruiter minted the link with zero profile data, so
  // there are <3 seeded skills. The portal then collects name/email/phone + CV
  // and the SERVER extracts skills on submit (no client-side skill search).
  const seededSkillCount = (profile.skills ?? []).length;
  const fromScratch = seededSkillCount < 3;

  const seed: SeedProfile = {
    name: isSelfOnboardPlaceholderName(candidate.name) ? '' : candidate.name,
    email: candidate.email ?? '',
    phone: candidate.phone ?? '',
    skills: (profile.skills ?? []).map((s) => ({
      id: s.skill,
      // No taxonomy label available offline; show a generic id-tagged label.
      name: `#${s.skill}`,
      level: proficiencyIdToLevel(s.proficiency_id),
      must_have: s.must_have ?? false,
    })),
    languages: (profile.languages ?? []).map((l) => ({ id: l.language, name: `#${l.language}` })),
    location: profile.detailed_location
      ? {
          city: profile.detailed_location.city ?? '',
          country: profile.detailed_location.country ?? '',
          latitude:
            profile.detailed_location.latitude != null
              ? String(profile.detailed_location.latitude)
              : undefined,
          longitude:
            profile.detailed_location.longitude != null
              ? String(profile.detailed_location.longitude)
              : undefined,
        }
      : null,
    contractTypes: normalizeContracts(prefs.contractTypes),
    // 0 = "recruiter set no radius" → the form keeps it UNSET and the server
    // applies the education-level heuristic (never a fake explicit 30).
    radiusKm: typeof prefs.radiusKm === 'number' ? prefs.radiusKm : 0,
    remote: Boolean(prefs.remote),
    // What the MATCH will actually use when no explicit radius is set: the
    // education-derived default (35/65/85) or the global default. Drives the
    // slider's displayed fallback so the portal never shows a flat "30 km"
    // that the match doesn't use.
    travelHintKm: travelDefaultForTier(highestEduTier(profile.education ?? [])),
  };

  return (
    <main className="min-h-screen bg-zinc-50 py-10">
      <div className="mx-auto max-w-2xl px-4">
        <header className="mb-6 flex items-center gap-3">
          {theme.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={theme.logo} alt={theme.name} className="h-8 w-auto" />
          ) : (
            <span className="text-lg font-semibold text-zinc-900">{theme.name}</span>
          )}
        </header>
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
          <h1 className="text-xl font-semibold text-zinc-900">{t('portalTitle')}</h1>
          <p className="mt-1 text-sm text-zinc-500">{t('portalSubtitle')}</p>
          <div className="mt-6">
            <PortalForm token={token} seed={seed} fromScratch={fromScratch} />
          </div>
        </div>
        <p className="mt-4 text-center text-xs text-zinc-400">{t('portalPrivacyNote')}</p>
      </div>
    </main>
  );
}

const PROFICIENCY_MIN_ID = 23;
function proficiencyIdToLevel(id: number | undefined): number {
  if (typeof id !== 'number') return 3;
  return Math.max(1, Math.min(5, id - PROFICIENCY_MIN_ID + 1));
}

function normalizeContracts(
  v: string[] | undefined,
): ('permanent' | 'temporary' | 'uitzend' | 'interim')[] {
  const allowed = ['permanent', 'temporary', 'uitzend', 'interim'] as const;
  return (v ?? []).filter((c): c is (typeof allowed)[number] =>
    (allowed as readonly string[]).includes(c),
  );
}
