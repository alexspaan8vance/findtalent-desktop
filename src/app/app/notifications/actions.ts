'use server';

import { revalidatePath } from 'next/cache';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';

/** Mark every unread notification for the current user as read. */
export async function markAllNotificationsReadAction(): Promise<void> {
  const user = await requireUser();
  await prisma.notification.updateMany({
    where: { userId: user.id, readAt: null },
    data: { readAt: new Date() },
  });
  revalidatePath('/app/notifications');
  revalidatePath('/app', 'layout');
}

/**
 * Mark a single notification as read (scoped to the current user). Used when a
 * user clicks through a notification to its target — best-effort, never throws
 * for an unknown/foreign id (the `userId` scope makes a mismatch a 0-row no-op).
 */
export async function markNotificationReadAction(id: string): Promise<void> {
  const user = await requireUser();
  await prisma.notification.updateMany({
    where: { id, userId: user.id, readAt: null },
    data: { readAt: new Date() },
  });
  revalidatePath('/app/notifications');
  revalidatePath('/app', 'layout');
}
