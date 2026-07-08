import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { prisma } from '@/lib/db';
import { getBrandTheme } from '@/lib/brand/config';
import { ApplyForm } from './apply-form';

export const dynamic = 'force-dynamic';

/**
 * PUBLIC, UNAUTHENTICATED website-registration page. One STABLE link per pool:
 * `/apply/[slug]` where `slug` is the Tenant.slug a recruiter embeds on their
 * site. Anyone visiting can register themselves → creates a NEW local Candidate
 * (status ONBOARDING) in that pool. We do NOT sync to 8vance on submit; the
 * recruiter reviews + syncs later.
 *
 * SECURITY: no auth. We resolve the pool by slug only and 404 on an unknown
 * slug (never leak whether a slug almost-matched). We expose nothing about the
 * pool beyond its display name. All input handling + rate-limiting lives in the
 * server action `submitPublicApplicationAction`.
 */
export default async function PublicApplyPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const cleanSlug = String(slug ?? '').trim().toLowerCase();

  const tenant = await prisma.tenant.findUnique({
    where: { slug: cleanSlug },
    select: { id: true, slug: true, name: true },
  });
  if (!tenant) notFound();

  const t = await getTranslations('apply');
  const theme = await getBrandTheme();

  return (
    <main className="min-h-screen py-10" style={{ background: 'var(--ft-bg)' }}>
      <div className="mx-auto max-w-2xl px-4">
        <header className="mb-6 flex items-center gap-3">
          {theme.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={theme.logo} alt={theme.name} className="h-8 w-auto" />
          ) : (
            <span className="text-lg font-semibold" style={{ color: 'var(--ft-ink)' }}>
              {theme.name}
            </span>
          )}
        </header>
        <div
          className="rounded-2xl border p-6 shadow-sm sm:p-8"
          style={{
            background: 'var(--ft-surface)',
            borderColor: 'var(--ft-border)',
          }}
        >
          <h1 className="text-xl font-semibold" style={{ color: 'var(--ft-ink)' }}>
            {t('heading', { pool: tenant.name })}
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--ft-muted)' }}>
            {t('intro')}
          </p>
          <div className="mt-6">
            <ApplyForm slug={tenant.slug} />
          </div>
        </div>
        <p className="mt-4 text-center text-xs" style={{ color: 'var(--ft-muted)' }}>
          {t('privacyNote')}
        </p>
      </div>
    </main>
  );
}
