'use server';

/**
 * Recruiter-pipeline server actions for the shortlist.
 *
 * Each action is authed via `requireUser` and verifies the targeted Match
 * belongs to a Project owned by the current user before writing — see memory
 * `feedback_security_critical`. Pipeline state lives in `ShortlistEntry`,
 * upserted on the (userId, matchId) unique key; absence of a row means the
 * candidate is at the default (not favorite, NEW stage, no note).
 */

import { revalidatePath } from 'next/cache';
import { ShortlistStage } from '@prisma/client';

import { requireUser } from '@/lib/auth-helpers';
import { prisma } from '@/lib/db';
import { userCanAccessProject } from '@/lib/org';

export type ShortlistActionResult =
  | { ok: true; favorite: boolean; stage: ShortlistStage; note: string }
  | { ok: false; reason: 'not_found' | 'invalid' | 'internal' };

const VALID_STAGES: ReadonlySet<string> = new Set<string>(
  Object.values(ShortlistStage),
);

const MAX_NOTE_LEN = 2000;

/**
 * Resolve the Match and assert it belongs to a project owned by the user.
 * Returns the matchId on success or null when the match is not owned/found.
 */
async function assertOwnedMatch(
  matchId: string,
  userId: string,
): Promise<string | null> {
  if (typeof matchId !== 'string' || matchId.length === 0) return null;
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, project: { select: { userId: true, organizationId: true } } },
  });
  if (!match || !(await userCanAccessProject(userId, match.project))) return null;
  return match.id;
}

/** Read the current entry (or defaults) so callers can echo state back. */
async function currentState(
  userId: string,
  matchId: string,
): Promise<{ favorite: boolean; stage: ShortlistStage; note: string }> {
  const entry = await prisma.shortlistEntry.findUnique({
    where: { userId_matchId: { userId, matchId } },
    select: { favorite: true, stage: true, note: true },
  });
  return {
    favorite: entry?.favorite ?? false,
    stage: entry?.stage ?? ShortlistStage.NEW,
    note: entry?.note ?? '',
  };
}

export async function toggleFavorite(matchId: string): Promise<ShortlistActionResult> {
  const session = await requireUser();
  const ownedId = await assertOwnedMatch(matchId, session.id);
  if (!ownedId) return { ok: false, reason: 'not_found' };

  try {
    const prev = await currentState(session.id, ownedId);
    const next = !prev.favorite;
    const entry = await prisma.shortlistEntry.upsert({
      where: { userId_matchId: { userId: session.id, matchId: ownedId } },
      create: { userId: session.id, matchId: ownedId, favorite: next },
      update: { favorite: next },
      select: { favorite: true, stage: true, note: true },
    });
    revalidatePath('/app/projects/[id]/shortlist', 'page');
    return {
      ok: true,
      favorite: entry.favorite,
      stage: entry.stage,
      note: entry.note ?? '',
    };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}

export async function setStage(
  matchId: string,
  stage: string,
): Promise<ShortlistActionResult> {
  const session = await requireUser();
  if (!VALID_STAGES.has(stage)) return { ok: false, reason: 'invalid' };
  const ownedId = await assertOwnedMatch(matchId, session.id);
  if (!ownedId) return { ok: false, reason: 'not_found' };

  const nextStage = stage as ShortlistStage;
  try {
    const entry = await prisma.shortlistEntry.upsert({
      where: { userId_matchId: { userId: session.id, matchId: ownedId } },
      create: { userId: session.id, matchId: ownedId, stage: nextStage },
      update: { stage: nextStage },
      select: { favorite: true, stage: true, note: true },
    });
    revalidatePath('/app/projects/[id]/shortlist', 'page');
    return {
      ok: true,
      favorite: entry.favorite,
      stage: entry.stage,
      note: entry.note ?? '',
    };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}

export async function saveNote(
  matchId: string,
  note: string,
): Promise<ShortlistActionResult> {
  const session = await requireUser();
  if (typeof note !== 'string') return { ok: false, reason: 'invalid' };
  const ownedId = await assertOwnedMatch(matchId, session.id);
  if (!ownedId) return { ok: false, reason: 'not_found' };

  // Trim + clamp; an empty note is stored as null (= default "no note").
  const trimmed = note.slice(0, MAX_NOTE_LEN);
  const value = trimmed.trim().length === 0 ? null : trimmed;
  try {
    const entry = await prisma.shortlistEntry.upsert({
      where: { userId_matchId: { userId: session.id, matchId: ownedId } },
      create: { userId: session.id, matchId: ownedId, note: value },
      update: { note: value },
      select: { favorite: true, stage: true, note: true },
    });
    revalidatePath('/app/projects/[id]/shortlist', 'page');
    return {
      ok: true,
      favorite: entry.favorite,
      stage: entry.stage,
      note: entry.note ?? '',
    };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}
