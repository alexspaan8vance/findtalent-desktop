import { getTranslations } from 'next-intl/server';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import {
  NOTIFICATION_TYPES,
  DEFAULT_PREF,
  type NotificationType,
} from '@/lib/notifications/types';

import { saveNotificationPrefsAction } from './actions';

export default async function NotificationSettingsPage() {
  const user = await requireUser();
  const t = await getTranslations('notifications');

  const rows = await prisma.notificationPreference.findMany({
    where: { userId: user.id },
    select: { type: true, email: true, inApp: true },
  });
  const byType = new Map(rows.map((r) => [r.type, r]));

  const prefFor = (type: NotificationType) => byType.get(type) ?? DEFAULT_PREF;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--ft-ink)' }}>
          {t('title')}
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--ft-ink)', opacity: 0.65 }}>
          {t('subtitle')}
        </p>
      </div>

      <form action={saveNotificationPrefsAction}>
        <section
          className="overflow-hidden rounded-2xl border"
          style={{ borderColor: 'var(--ft-border)', background: 'var(--ft-surface)' }}
        >
          <div
            className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6 px-5 py-3 text-xs font-medium uppercase tracking-wide"
            style={{
              color: 'var(--ft-ink)',
              opacity: 0.6,
              background: 'var(--ft-accent-soft)',
            }}
          >
            <span>{t('colType')}</span>
            <span className="w-16 text-center">{t('colEmail')}</span>
            <span className="w-16 text-center">{t('colInApp')}</span>
          </div>

          <ul>
            {NOTIFICATION_TYPES.map((type) => {
              const pref = prefFor(type);
              return (
                <li
                  key={type}
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6 border-t px-5 py-4"
                  style={{ borderColor: 'var(--ft-border)' }}
                >
                  <div>
                    <div className="text-sm font-medium" style={{ color: 'var(--ft-ink)' }}>
                      {t(`type.${type}.label`)}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--ft-ink)', opacity: 0.6 }}>
                      {t(`type.${type}.description`)}
                    </div>
                  </div>
                  <label className="flex w-16 justify-center">
                    <span className="sr-only">
                      {t('colEmail')} — {t(`type.${type}.label`)}
                    </span>
                    <input
                      type="checkbox"
                      name={`email:${type}`}
                      defaultChecked={pref.email}
                      className="h-4 w-4 rounded"
                      style={{ accentColor: 'var(--ft-accent)' }}
                    />
                  </label>
                  <label className="flex w-16 justify-center">
                    <span className="sr-only">
                      {t('colInApp')} — {t(`type.${type}.label`)}
                    </span>
                    <input
                      type="checkbox"
                      name={`inApp:${type}`}
                      defaultChecked={pref.inApp}
                      className="h-4 w-4 rounded"
                      style={{ accentColor: 'var(--ft-accent)' }}
                    />
                  </label>
                </li>
              );
            })}
          </ul>
        </section>

        <div className="mt-5 flex items-center gap-3">
          <button
            type="submit"
            className="rounded-lg px-4 py-2 text-sm font-medium"
            style={{ background: 'var(--ft-accent)', color: 'var(--ft-accent-fg)' }}
          >
            {t('save')}
          </button>
          <span className="text-xs" style={{ color: 'var(--ft-ink)', opacity: 0.6 }}>
            {t('defaultsNote')}
          </span>
        </div>
      </form>
    </div>
  );
}
