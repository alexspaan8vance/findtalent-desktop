'use server';

import { revalidatePath } from 'next/cache';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { NOTIFICATION_TYPES, isNotificationType } from '@/lib/notifications/types';

/**
 * Persist the per-type delivery preferences for the current user.
 *
 * The form posts checkboxes named `email:<type>` and `inApp:<type>`. An
 * unchecked checkbox is simply absent from FormData, so we derive the boolean
 * from presence. We upsert one row per known notification type.
 */
export async function saveNotificationPrefsAction(formData: FormData): Promise<void> {
  const user = await requireUser();

  await prisma.$transaction(
    NOTIFICATION_TYPES.map((type) => {
      // Guard against any unexpected type value (defense in depth).
      if (!isNotificationType(type)) {
        throw new Error('Invalid notification type');
      }
      const email = formData.get(`email:${type}`) === 'on';
      const inApp = formData.get(`inApp:${type}`) === 'on';
      return prisma.notificationPreference.upsert({
        where: { userId_type: { userId: user.id, type } },
        create: { userId: user.id, type, email, inApp },
        update: { email, inApp },
      });
    }),
  );

  revalidatePath('/app/settings/notifications');
}
