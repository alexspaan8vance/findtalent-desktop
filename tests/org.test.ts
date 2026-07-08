/**
 * Team-seats (org) helper tests.
 *
 * Run with `npx vitest run tests/org.test.ts`.
 */

import { describe, it, expect, afterAll, beforeEach } from 'vitest';

import { PrismaClient } from '@prisma/client';
import {
  getOrCreateUserOrg,
  getOrgMemberIds,
  userCanAccessProject,
  assertProjectAccess,
  ProjectAccessError,
} from '../src/lib/org';

const prisma = new PrismaClient();

async function createUser(): Promise<string> {
  const u = await prisma.user.create({
    data: { email: `org-${Math.random().toString(36).slice(2, 10)}@test.local` },
    select: { id: true },
  });
  return u.id;
}

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.organizationMember.deleteMany();
  await prisma.project.deleteMany();
  // Detach users from orgs before deleting orgs (FK).
  await prisma.user.updateMany({ data: { organizationId: null } });
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
});

describe('getOrCreateUserOrg', () => {
  it('creates a personal org with an OWNER membership and is idempotent', async () => {
    const userId = await createUser();

    const orgId = await getOrCreateUserOrg(userId);
    expect(orgId).toBeTruthy();

    const again = await getOrCreateUserOrg(userId);
    expect(again).toBe(orgId);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { organizationId: true },
    });
    expect(user.organizationId).toBe(orgId);

    const members = await prisma.organizationMember.findMany({
      where: { organizationId: orgId },
    });
    expect(members).toHaveLength(1);
    expect(members[0].userId).toBe(userId);
    expect(members[0].role).toBe('OWNER');
  });

  it('getOrgMemberIds returns all members', async () => {
    const owner = await createUser();
    const orgId = await getOrCreateUserOrg(owner);

    const colleague = await createUser();
    await prisma.user.update({ where: { id: colleague }, data: { organizationId: orgId } });
    await prisma.organizationMember.create({
      data: { organizationId: orgId, userId: colleague, role: 'MEMBER' },
    });

    const ids = await getOrgMemberIds(orgId);
    expect(ids.sort()).toEqual([owner, colleague].sort());
  });
});

describe('userCanAccessProject / assertProjectAccess', () => {
  it('owner can access their own project', async () => {
    const userId = await createUser();
    const orgId = await getOrCreateUserOrg(userId);
    expect(await userCanAccessProject(userId, { userId, organizationId: orgId })).toBe(true);
  });

  it('teammate can access a project shared via the same org', async () => {
    const owner = await createUser();
    const orgId = await getOrCreateUserOrg(owner);

    const colleague = await createUser();
    await prisma.user.update({ where: { id: colleague }, data: { organizationId: orgId } });
    await prisma.organizationMember.create({
      data: { organizationId: orgId, userId: colleague, role: 'MEMBER' },
    });

    // Project owned by `owner`, scoped to the shared org.
    const access = await userCanAccessProject(colleague, {
      userId: owner,
      organizationId: orgId,
    });
    expect(access).toBe(true);
  });

  it('a stranger in a different org cannot access the project', async () => {
    const owner = await createUser();
    const ownerOrg = await getOrCreateUserOrg(owner);

    const stranger = await createUser();
    await getOrCreateUserOrg(stranger); // their own separate org

    expect(
      await userCanAccessProject(stranger, { userId: owner, organizationId: ownerOrg }),
    ).toBe(false);

    await expect(
      assertProjectAccess(stranger, { userId: owner, organizationId: ownerOrg }),
    ).rejects.toBeInstanceOf(ProjectAccessError);
  });

  it('a project with no org is private to its userId', async () => {
    const owner = await createUser();
    const other = await createUser();
    await getOrCreateUserOrg(other);

    expect(await userCanAccessProject(other, { userId: owner, organizationId: null })).toBe(false);
    expect(await userCanAccessProject(owner, { userId: owner, organizationId: null })).toBe(true);
  });
});
