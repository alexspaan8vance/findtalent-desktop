/**
 * Team-seats (organizations) helper.
 *
 * Every user belongs to exactly one "primary" Organization (their personal org
 * by default). Projects are shared across an org's members; credits + reveals
 * stay per-user. These helpers are additive and idempotent — for a solo user
 * the org has a single member, so the OR-broadened project reads collapse back
 * to "their own projects only".
 */

import { OrgRole } from '@prisma/client';

import { prisma } from '@/lib/db';
import { getOrCreateStages } from '@/lib/pipeline';

/**
 * Ensure `userId` has a primary `organizationId`. If they already have one we
 * just return it. Otherwise we create a personal Organization (named after the
 * user/email), make them an OWNER member, and point `User.organizationId` at it.
 *
 * Idempotent and safe to call on every request. Returns the org id.
 */
export async function getOrCreateUserOrg(userId: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, email: true, name: true, organizationId: true },
  });

  if (user.organizationId) {
    // Defensive: make sure a membership row exists too (e.g. legacy rows that
    // were assigned an org without a membership). Cheap upsert, idempotent.
    await prisma.organizationMember
      .upsert({
        where: {
          organizationId_userId: {
            organizationId: user.organizationId,
            userId: user.id,
          },
        },
        create: {
          organizationId: user.organizationId,
          userId: user.id,
          role: OrgRole.OWNER,
        },
        update: {},
      })
      .catch(() => {
        /* membership already exists / race — ignore */
      });
    // Idempotent: seed the default Kanban stages if this org has none yet
    // (covers legacy orgs created before configurable pipelines existed).
    await getOrCreateStages(user.organizationId).catch(() => {
      /* seed race / transient — non-fatal */
    });
    return user.organizationId;
  }

  const orgName = (user.name?.trim() || user.email || 'My team').slice(0, 120);

  // Create org + owner membership, then bind it to the user. Done in a
  // transaction so a user is never left with a dangling org.
  const orgId = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: orgName,
        members: {
          create: { userId: user.id, role: OrgRole.OWNER },
        },
      },
      select: { id: true },
    });
    await tx.user.update({
      where: { id: user.id },
      data: { organizationId: org.id },
    });
    return org.id;
  });

  // Seed the default Kanban stage set for the brand-new org (idempotent).
  await getOrCreateStages(orgId).catch(() => {
    /* seed race / transient — non-fatal */
  });

  return orgId;
}

/** Return the user ids of every member of `orgId`. */
export async function getOrgMemberIds(orgId: string): Promise<string[]> {
  const members = await prisma.organizationMember.findMany({
    where: { organizationId: orgId },
    select: { userId: true },
  });
  return members.map((m) => m.userId);
}

export class ProjectAccessError extends Error {
  constructor(message = 'Project not found or not accessible') {
    super(message);
    this.name = 'ProjectAccessError';
  }
}

type ProjectAccessRow = {
  userId: string;
  organizationId: string | null;
};

/**
 * Org-aware project ownership check. A user may access a project when they own
 * it directly OR when it belongs to their primary org (i.e. a teammate created
 * it). Replaces the old `project.userId !== session.id` guards.
 *
 * Returns `true`/`false` — callers decide whether to `notFound()` / throw.
 */
export async function userCanAccessProject(
  userId: string,
  project: ProjectAccessRow,
): Promise<boolean> {
  if (project.userId === userId) return true;
  if (!project.organizationId) return false;
  const orgId = await getOrCreateUserOrg(userId);
  return project.organizationId === orgId;
}

/**
 * Like {@link userCanAccessProject} but throws {@link ProjectAccessError} when
 * the user has no access. Convenient for mutation server-actions.
 */
export async function assertProjectAccess(
  userId: string,
  project: ProjectAccessRow,
): Promise<void> {
  const ok = await userCanAccessProject(userId, project);
  if (!ok) throw new ProjectAccessError();
}
