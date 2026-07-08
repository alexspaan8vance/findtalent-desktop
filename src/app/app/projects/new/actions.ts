'use server';

import { redirect } from 'next/navigation';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { getOrCreateUserOrg } from '@/lib/org';
import {
  MatchPreconditionError,
  syncProjectToVance,
} from '@/lib/eightvance/job-sync';
import { TenantNotConfiguredError } from '@/lib/eightvance/tenant-client';
import { VanceError } from '@/lib/eightvance/errors';
import { getAllowedTenantIds } from '@/lib/tenant-access';
import { createProjectSchema } from './schema';

export type CreateProjectState = {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  projectId?: string;
};


function safeParseJson(raw: FormDataEntryValue | null): unknown {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function createProjectAction(
  _prev: CreateProjectState,
  formData: FormData,
): Promise<CreateProjectState> {
  const user = await requireUser();

  const payload = {
    title: String(formData.get('title') ?? '').trim(),
    functionNameId: Number(formData.get('functionNameId') ?? NaN),
    functionNameLabel: String(formData.get('functionNameLabel') ?? '').trim(),
    functionLevel: Number(formData.get('functionLevel') ?? NaN),
    minYearsExperience: Number(formData.get('minYearsExperience') ?? 0),
    locationCity: String(formData.get('locationCity') ?? '').trim(),
    locationCountry: String(formData.get('locationCountry') ?? '').trim(),
    locationProvince:
      String(formData.get('locationProvince') ?? '').trim() || undefined,
    locationLat: String(formData.get('locationLat') ?? '').trim() || undefined,
    locationLng: String(formData.get('locationLng') ?? '').trim() || undefined,
    skills: safeParseJson(formData.get('skills')) ?? [],
    languages: safeParseJson(formData.get('languages')) ?? [],
    educationLevel:
      String(formData.get('educationLevel') ?? '').trim() || undefined,
    pools: safeParseJson(formData.get('pools')) ?? [],
  };

  const parsed = createProjectSchema.safeParse(payload);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return {
      ok: false,
      error: 'Some fields look off — please review the highlighted steps.',
      fieldErrors,
    };
  }

  const data = parsed.data;

  // Validate all selected tenant ids exist (and dedupe).
  const tenantIds = Array.from(new Set(data.pools));
  const tenants = await prisma.tenant.findMany({
    where: { id: { in: tenantIds } },
    select: { id: true },
  });
  if (tenants.length !== tenantIds.length) {
    return { ok: false, error: 'One of the selected pools no longer exists.' };
  }

  // IDOR guard: existence is not authorization. Reject any requested pool the
  // acting user/org may not target (would otherwise drive an arbitrary tenant's
  // 8vance creds). Same org-ownership scope as the candidate pool routes.
  const allowedTenantIds = await getAllowedTenantIds(user.id, user.role);
  if (tenantIds.some((id) => !allowedTenantIds.has(id))) {
    return { ok: false, error: 'One of the selected pools is not available to you.' };
  }

  // Share new projects across the creator's team org (personal org by default).
  const organizationId = await getOrCreateUserOrg(user.id);

  let projectId: string;
  try {
    const created = await prisma.project.create({
      data: {
        userId: user.id,
        organizationId,
        title: data.title,
        functionNameId: data.functionNameId,
        functionNameLabel: data.functionNameLabel,
        functionLevel: data.functionLevel,
        locationCity: data.locationCity,
        locationCountry: data.locationCountry,
        locationProvince: data.locationProvince ?? null,
        locationLat: data.locationLat ?? null,
        locationLng: data.locationLng ?? null,
        skillsJson: data.skills,
        languagesJson: data.languages,
        educationLevel: data.educationLevel ?? null,
        status: 'DRAFT',
        pools: {
          create: tenantIds.map((tenantId) => ({ tenantId, status: 'DRAFT' as const })),
        },
      },
      select: { id: true },
    });
    projectId = created.id;
  } catch {
    return {
      ok: false,
      error: 'Could not save your project. Please try again.',
    };
  }

  try {
    // Min-years-experience is intentionally NOT persisted (no schema column;
    // no migration allowed). Thread the parsed value straight into the
    // immediate match so the created 8vance job carries the experience
    // requirement. A later re-match (hydrate) has no column to read it back,
    // which is acceptable for this opt-in, single-use signal.
    await syncProjectToVance(projectId, {
      minYearsExperience: data.minYearsExperience || undefined,
    });
  } catch (err) {
    await prisma.project
      .update({ where: { id: projectId }, data: { status: 'FAILED' } })
      .catch(() => {});

    if (err instanceof MatchPreconditionError) {
      return { ok: false, error: err.message, projectId };
    }
    if (err instanceof TenantNotConfiguredError) {
      return { ok: false, error: err.message, projectId };
    }
    if (err instanceof VanceError) {
      return {
        ok: false,
        error:
          'Matching service is currently unavailable. Please try again in a moment.',
        projectId,
      };
    }
    return {
      ok: false,
      error: 'Something went wrong while starting the match.',
      projectId,
    };
  }

  redirect(`/app/projects/${projectId}/shortlist`);
}
