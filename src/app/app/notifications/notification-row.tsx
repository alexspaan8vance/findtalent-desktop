'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';

import { markNotificationReadAction } from './actions';

export interface NotificationRowData {
  id: string;
  label: string;
  /** Localized detail line (e.g. "3 new candidates for Project X"), or null. */
  detail: string | null;
  /** Navigation target — when set the whole row is a link to the shortlist. */
  href: string | null;
  isUnread: boolean;
  /** Pre-formatted creation timestamp (formatted server-side for stability). */
  createdAtLabel: string;
}

/**
 * A single notification row. When the notification points at a project
 * (`href` set) the whole row becomes a Link to the shortlist and clicking it
 * also marks the row read (best-effort, fire-and-forget — navigation is never
 * blocked on the mark-read round-trip). Non-navigable rows render as a plain
 * list item.
 *
 * RSC-safety: the server action is imported directly here (client module), so
 * the server page never passes a function prop across the boundary.
 */
export function NotificationRow({ data }: { data: NotificationRowData }): React.ReactElement {
  const t = useTranslations('notifications');
  const [, startTransition] = useTransition();

  const inner = (
    <>
      <span
        aria-hidden
        className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
        style={{
          background: data.isUnread ? 'var(--ft-accent)' : 'var(--ft-border-strong)',
        }}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium" style={{ color: 'var(--ft-ink)' }}>
          {data.label}
        </div>
        {data.detail && (
          <div className="text-xs" style={{ color: 'var(--ft-ink)', opacity: 0.7 }}>
            {data.detail}
          </div>
        )}
        <div className="mt-0.5 text-xs" style={{ color: 'var(--ft-ink)', opacity: 0.5 }}>
          {data.createdAtLabel}
        </div>
      </div>
      {data.isUnread && (
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase"
          style={{ background: 'var(--ft-accent)', color: 'var(--ft-accent-fg)' }}
        >
          {t('badgeNew')}
        </span>
      )}
    </>
  );

  const rowClass =
    'flex items-start gap-3 border-t px-5 py-4 first:border-t-0';
  const rowStyle = {
    borderColor: 'var(--ft-border)',
    background: data.isUnread ? 'var(--ft-accent-soft)' : 'transparent',
  } as const;

  if (data.href) {
    return (
      <li className="first:[&>a]:border-t-0">
        <Link
          href={data.href}
          onClick={() => {
            if (data.isUnread) {
              startTransition(() => {
                void markNotificationReadAction(data.id);
              });
            }
          }}
          className={`${rowClass} transition hover:bg-[var(--ft-accent-soft)]`}
          style={rowStyle}
        >
          {inner}
        </Link>
      </li>
    );
  }

  return (
    <li className={rowClass} style={rowStyle}>
      {inner}
    </li>
  );
}
