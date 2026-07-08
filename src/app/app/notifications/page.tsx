import { getLocale, getTranslations } from 'next-intl/server';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';
import { isNotificationType } from '@/lib/notifications/types';
import { formatDateTime } from '@/lib/format-date';

import { markAllNotificationsReadAction } from './actions';
import { NotificationRow } from './notification-row';

/** Parsed `new_match` payload, tolerant of every historical shape. */
function parseNewMatchPayload(
  payload: unknown,
): { count: number | null; title: string; isCandidate: boolean } | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  // Project-kind emitters (saved-search runner + hydrate notify-on-READY +
  // applications ingest) send `count` + `projectTitle`; the candidate-match
  // emitter sends `total` + `candidateName`. Older rows used `newMatchCount`.
  const raw = Number(p.count ?? p.newMatchCount ?? p.total);
  const count = Number.isFinite(raw) ? raw : null;
  const isCandidate = p.kind === 'candidate' || (p.projectTitle == null && p.candidateName != null);
  const title = String(p.projectTitle ?? p.candidateName ?? '').trim();
  return { count, title, isCandidate };
}

export default async function NotificationsPage() {
  const user = await requireUser();
  const t = await getTranslations('notifications');
  const locale = await getLocale();

  const rows = await prisma.notification.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      type: true,
      payloadJson: true,
      readAt: true,
      createdAt: true,
    },
  });
  // Suppress empty results: a `new_match` row with an explicit count of 0
  // ("0 nieuwe vacatures voor …") tells the user nothing. Most emitters
  // already skip these; the candidate-match one doesn't, so filter at render.
  const items = rows.filter((n) => {
    if (n.type !== 'new_match') return true;
    const parsed = parseNewMatchPayload(n.payloadJson);
    return !(parsed && parsed.count !== null && parsed.count <= 0);
  });
  const unread = items.filter((n) => n.readAt === null).length;

  function labelFor(type: string): string {
    if (isNotificationType(type)) return t(`type.${type}.label`);
    // Legacy / unknown types fall back to a generic label.
    return t('genericLabel');
  }

  function detailFor(type: string, payload: unknown): string | null {
    if (type !== 'new_match') return null;
    const parsed = parseNewMatchPayload(payload);
    if (!parsed || parsed.count === null || parsed.title === '') return null;
    // Direction matters: a PROJECT gained candidates, a CANDIDATE gained
    // jobs/vacancies — "181 nieuwe kandidaten voor <kandidaat>" was wrong.
    return parsed.isCandidate
      ? t('newMatchDetailCandidate', { count: parsed.count, candidate: parsed.title })
      : t('newMatchDetail', { count: parsed.count, project: parsed.title });
  }

  /** The navigation target for a notification, when its payload carries one.
   *  - `new_match` → the project shortlist, highlighting candidates that
   *    arrived after this notification.
   *  - `reveal_confirmation` (reveal acquired or outreach recorded) → the
   *    project shortlist where the reveal happened. Its payload carries
   *    `projectId` + `matchId` (not `opaqueId`, which the talent detail route
   *    keys on), so we link to the shortlist rather than the talent page. */
  function hrefFor(type: string, payload: unknown, createdAt: Date): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;
    const projectId = typeof p.projectId === 'string' ? p.projectId : null;
    if (!projectId) return null;

    if (type === 'new_match') {
      const since = encodeURIComponent(createdAt.toISOString());
      return `/app/projects/${projectId}/shortlist?highlight=new&since=${since}`;
    }
    if (type === 'reveal_confirmation') {
      return `/app/projects/${projectId}/shortlist`;
    }
    return null;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--ft-ink)' }}>
            {t('centerTitle')}
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--ft-ink)', opacity: 0.65 }}>
            {t('centerSubtitle')}
          </p>
        </div>
        {unread > 0 && (
          <form action={markAllNotificationsReadAction}>
            <button
              type="submit"
              className="rounded-lg border px-3 py-1.5 text-sm font-medium"
              style={{ borderColor: 'var(--ft-border-strong)', color: 'var(--ft-ink)' }}
            >
              {t('markAllRead')}
            </button>
          </form>
        )}
      </div>

      {items.length === 0 ? (
        <div
          className="rounded-2xl border px-5 py-10 text-center text-sm"
          style={{
            borderColor: 'var(--ft-border)',
            background: 'var(--ft-surface)',
            color: 'var(--ft-ink)',
            opacity: 0.7,
          }}
        >
          {t('empty')}
        </div>
      ) : (
        <ul
          className="overflow-hidden rounded-2xl border"
          style={{ borderColor: 'var(--ft-border)', background: 'var(--ft-surface)' }}
        >
          {items.map((n) => {
            const createdAt = new Date(n.createdAt);
            return (
              <NotificationRow
                key={n.id}
                data={{
                  id: n.id,
                  label: labelFor(n.type),
                  detail: detailFor(n.type, n.payloadJson),
                  href: hrefFor(n.type, n.payloadJson, createdAt),
                  isUnread: n.readAt === null,
                  createdAtLabel: formatDateTime(locale, createdAt),
                }}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}
