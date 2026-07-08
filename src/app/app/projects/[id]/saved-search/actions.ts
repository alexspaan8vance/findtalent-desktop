'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { userCanAccessProject } from '@/lib/org';

const createSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).max(100),
  notifyEmail: z.boolean().default(true),
});

export async function createSavedSearchAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const parsed = createSchema.parse({
    projectId: formData.get('projectId'),
    name: formData.get('name') ?? 'My saved search',
    notifyEmail: formData.get('notifyEmail') === 'on',
  });

  const project = await prisma.project.findUnique({
    where: { id: parsed.projectId },
    select: { userId: true, organizationId: true },
  });
  if (!project || !(await userCanAccessProject(user.id, project))) {
    throw new Error('Project not found or not yours');
  }

  await prisma.savedSearch.create({
    data: {
      userId: user.id,
      projectId: parsed.projectId,
      name: parsed.name,
      notifyEmail: parsed.notifyEmail,
    },
  });

  revalidatePath(`/app/projects/${parsed.projectId}/shortlist`);
}

const monitorSchema = z.object({
  projectId: z.string().min(1),
});

/**
 * One-click "Monitor this project" toggle. Idempotent:
 *  - if the user already monitors this project, removes ALL their saved searches
 *    for it (monitoring off);
 *  - otherwise creates one with a sensible default name + email notifications
 *    (monitoring on).
 * The named create form below stays for naming / notification-preference control.
 */
export async function toggleMonitorAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const { projectId } = monitorSchema.parse({
    projectId: formData.get('projectId'),
  });

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { title: true, locationCity: true, userId: true, organizationId: true },
  });
  if (!project || !(await userCanAccessProject(user.id, project))) {
    throw new Error('Project not found or not yours');
  }

  const existing = await prisma.savedSearch.count({
    where: { projectId, userId: user.id },
  });

  if (existing > 0) {
    await prisma.savedSearch.deleteMany({ where: { projectId, userId: user.id } });
  } else {
    const base = [project.title, project.locationCity]
      .map((s) => (s ?? '').trim())
      .filter(Boolean)
      .join(' ');
    const name = (base ? `${base} — update` : 'Project monitor').slice(0, 100);
    await prisma.savedSearch.create({
      data: { userId: user.id, projectId, name, notifyEmail: true },
    });
  }

  revalidatePath(`/app/projects/${projectId}/shortlist`);
}

const deleteSchema = z.object({
  savedSearchId: z.string().min(1),
  projectId: z.string().min(1),
});

export async function deleteSavedSearchAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const parsed = deleteSchema.parse({
    savedSearchId: formData.get('savedSearchId'),
    projectId: formData.get('projectId'),
  });

  const row = await prisma.savedSearch.findUnique({
    where: { id: parsed.savedSearchId },
    select: { userId: true },
  });
  if (!row || row.userId !== user.id) {
    throw new Error('Saved search not found or not yours');
  }

  await prisma.savedSearch.delete({ where: { id: parsed.savedSearchId } });
  revalidatePath(`/app/projects/${parsed.projectId}/shortlist`);
}
