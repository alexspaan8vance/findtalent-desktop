/**
 * Outreach log helpers.
 *
 * An `Outreach` row records that a recruiter contacted a (revealed) candidate
 * via a template. We never email the candidate from the platform — the
 * recruiter sends from their own mail client (prefilled `mailto:`); this row is
 * the audit/"Contacted" state so the UI can show "Contacted on <date>".
 *
 * Security (memory `feedback_security_critical`): callers pass a `userId` they
 * have already authorized against the parent project. Rows store only ids +
 * the template key — never decrypted PII / contact details.
 */

import { prisma } from '@/lib/db';

export interface RecordOutreachInput {
  userId: string;
  projectId: string;
  tenantId: string;
  eightvanceTalentId: number;
  /** Email-template key used (e.g. `candidate_outreach`). */
  templateKey?: string | null;
  channel?: string;
}

export interface OutreachSummary {
  id: string;
  createdAt: Date;
  templateKey: string | null;
  channel: string;
  eightvanceTalentId: number;
  projectId: string;
}

/**
 * Record an outreach attempt. Idempotent-ish: a single candidate may be
 * contacted multiple times, so we always append a new row (the log is a
 * history). Use {@link hasOutreach} to decide whether to show the badge.
 */
export async function recordOutreach(
  input: RecordOutreachInput,
): Promise<OutreachSummary> {
  const row = await prisma.outreach.create({
    data: {
      userId: input.userId,
      projectId: input.projectId,
      tenantId: input.tenantId,
      eightvanceTalentId: input.eightvanceTalentId,
      channel: input.channel ?? 'email',
      templateKey: input.templateKey ?? null,
      status: 'SENT',
    },
    select: {
      id: true,
      createdAt: true,
      templateKey: true,
      channel: true,
      eightvanceTalentId: true,
      projectId: true,
    },
  });
  return row;
}

/**
 * Whether the given user has already recorded outreach to this talent inside
 * this project. Returns the earliest contact date (for "Contacted on <date>").
 */
export async function hasOutreach(opts: {
  userId: string;
  projectId: string;
  eightvanceTalentId: number;
}): Promise<{ contacted: boolean; firstAt: Date | null }> {
  const row = await prisma.outreach.findFirst({
    where: {
      userId: opts.userId,
      projectId: opts.projectId,
      eightvanceTalentId: opts.eightvanceTalentId,
    },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  return { contacted: Boolean(row), firstAt: row?.createdAt ?? null };
}

/** All outreach rows for a project (newest first). */
export async function listForProject(projectId: string): Promise<OutreachSummary[]> {
  return prisma.outreach.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      createdAt: true,
      templateKey: true,
      channel: true,
      eightvanceTalentId: true,
      projectId: true,
    },
  });
}
