/**
 * Edit-project page.
 *
 * Org-guarded (same `userCanAccessProject` check as the shortlist + the
 * project actions). Loads the project's current criteria and the tenant of its
 * first pool (used to scope the ref-data autocompletes, exactly like the create
 * wizard's "primary tenant"), then hands plain serializable props to the
 * `<EditProjectForm>` client component.
 *
 * Pool selection IS editable here (cross-pool matching): we pass the same
 * available-tenant list the create wizard uses (id/slug/name/defaultLocale —
 * no 8vance credentials) plus the project's current pools, so the recruiter can
 * add/remove pools and `updateProjectAction` diffs them.
 */

import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { requireUser } from '@/lib/auth-helpers';
import { prisma } from '@/lib/db';
import { userCanAccessProject } from '@/lib/org';
import type {
  ProjectLanguageRow,
  ProjectSkillRow,
} from '@/lib/eightvance/job-sync';

import { EditProjectForm, type EditProjectInitial } from './edit-form';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

function asSkillRows(raw: unknown): ProjectSkillRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is ProjectSkillRow =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as { id?: unknown }).id === 'number',
  );
}

function asLanguageRows(raw: unknown): ProjectLanguageRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is ProjectLanguageRow =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as { id?: unknown }).id === 'number',
  );
}

export default async function EditProjectPage({
  params,
}: PageProps): Promise<React.ReactElement> {
  const { id } = await params;
  const session = await requireUser();
  const t = await getTranslations('projectEdit');

  const project = await prisma.project.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      title: true,
      functionNameId: true,
      functionNameLabel: true,
      functionLevel: true,
      locationCity: true,
      locationCountry: true,
      locationProvince: true,
      locationLat: true,
      locationLng: true,
      skillsJson: true,
      languagesJson: true,
      educationLevel: true,
      pools: {
        select: { tenantId: true },
        orderBy: { id: 'asc' },
      },
    },
  });
  if (!project) notFound();
  if (!(await userCanAccessProject(session.id, project))) notFound();

  const primaryTenantId = project.pools[0]?.tenantId ?? '';

  // Same source the create wizard's pool step uses (/api/tenants/list), but
  // resolved server-side here. Public-safe fields only — never the 8vance creds.
  const tenantRows = await prisma.tenant.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, slug: true, name: true, defaultLocale: true },
  });
  const currentPoolIds = project.pools.map((p) => p.tenantId);

  const initial: EditProjectInitial = {
    projectId: project.id,
    primaryTenantId,
    tenantOptions: tenantRows,
    currentPoolIds,
    title: project.title,
    functionNameId: project.functionNameId,
    functionNameLabel: project.functionNameLabel,
    functionLevel: project.functionLevel,
    locationCity: project.locationCity,
    locationCountry: project.locationCountry,
    locationProvince: project.locationProvince,
    locationLat: project.locationLat,
    locationLng: project.locationLng,
    skills: asSkillRows(project.skillsJson).map((s) => ({
      id: s.id,
      name: s.name ?? '',
      proficiency_id:
        typeof s.proficiency_id === 'number' ? s.proficiency_id : 25,
      must_have: s.must_have === true,
    })),
    languages: asLanguageRows(project.languagesJson).map((l) => ({
      id: l.id,
      name: l.name ?? '',
    })),
    educationLevel: project.educationLevel,
  };

  return (
    <main className="min-h-screen bg-zinc-50 py-10">
      <div className="mx-auto max-w-3xl px-4">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold text-zinc-900">
            {t('pageTitle')}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">{t('pageSubtitle')}</p>
        </header>
        <EditProjectForm initial={initial} />
      </div>
    </main>
  );
}
