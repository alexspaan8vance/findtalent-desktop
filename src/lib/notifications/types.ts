/**
 * Notification types for the per-type preferences + delivery feature.
 *
 * Each type has a stable string `key` (persisted in `Notification.type` and
 * `NotificationPreference.type`). Human-readable labels are NOT defined here —
 * the UI resolves them via the `notifications` i18n namespace
 * (`notifications.type.<key>`), so they stay localized (NL/EN).
 */

export const NOTIFICATION_TYPES = [
  'new_match',
  'reveal_confirmation',
  'low_credits',
  'payment_failed',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export function isNotificationType(v: string): v is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(v);
}

export interface DeliveryPref {
  email: boolean;
  inApp: boolean;
}

/** Sensible defaults when no preference row exists. */
export const DEFAULT_PREF: DeliveryPref = { email: true, inApp: true };
