'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import { requireAdmin } from '@/lib/auth-helpers';

/**
 * Admin staffing-agency rule operations. All gated behind `requireAdmin` (same
 * guard the rest of /admin uses). Rules are stored as GLOBAL defaults
 * (organizationId = null) — the MVP scope. Patterns are always lowercased +
 * trimmed before saving because the classifier matches lowercased substrings.
 */

const PATH = '/admin/staffing-rules';

export type RuleActionResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'invalid' | 'empty' | 'duplicate' | 'not_found' | 'internal';
    };

const addSchema = z.object({
  kind: z.enum(['NAME', 'DESCRIPTION']),
  pattern: z.string(),
  label: z.string().trim().max(120).optional(),
});

/**
 * Add a global custom rule. Lowercases + trims the pattern, rejects empty, and
 * rejects a duplicate (same kind + pattern) among the global rows.
 */
export async function addRuleAction(input: {
  kind: string;
  pattern: string;
  label?: string;
}): Promise<RuleActionResult> {
  try {
    await requireAdmin();

    const parsed = addSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: 'invalid' };

    const pattern = parsed.data.pattern.toLowerCase().trim();
    if (!pattern) return { ok: false, reason: 'empty' };

    const label = parsed.data.label?.trim() || null;

    const existing = await prisma.staffingAgencyRule.findFirst({
      where: { organizationId: null, kind: parsed.data.kind, pattern },
      select: { id: true },
    });
    if (existing) return { ok: false, reason: 'duplicate' };

    await prisma.staffingAgencyRule.create({
      data: { organizationId: null, kind: parsed.data.kind, pattern, label },
    });

    revalidatePath(PATH);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}

/** Enable / disable a global rule. */
export async function toggleRuleAction(
  id: string,
  enabled: boolean,
): Promise<RuleActionResult> {
  try {
    await requireAdmin();
    if (!id) return { ok: false, reason: 'invalid' };

    const rule = await prisma.staffingAgencyRule.findFirst({
      where: { id, organizationId: null },
      select: { id: true },
    });
    if (!rule) return { ok: false, reason: 'not_found' };

    await prisma.staffingAgencyRule.update({
      where: { id },
      data: { enabled },
    });

    revalidatePath(PATH);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}

/** Delete a global rule. */
export async function deleteRuleAction(id: string): Promise<RuleActionResult> {
  try {
    await requireAdmin();
    if (!id) return { ok: false, reason: 'invalid' };

    const rule = await prisma.staffingAgencyRule.findFirst({
      where: { id, organizationId: null },
      select: { id: true },
    });
    if (!rule) return { ok: false, reason: 'not_found' };

    await prisma.staffingAgencyRule.delete({ where: { id } });

    revalidatePath(PATH);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}
