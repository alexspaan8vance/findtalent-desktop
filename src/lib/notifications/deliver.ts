/**
 * Central notification delivery helper.
 *
 * `notify()` resolves the recipient's per-type delivery preferences (falling
 * back to {@link DEFAULT_PREF} when no row exists), then:
 *   - writes an in-app `Notification` row when in-app delivery is enabled, and
 *   - sends the provided email when email delivery is enabled and an address
 *     is known.
 *
 * Security: callers pass a `userId` they have already authorized. We never log
 * PII or email bodies here. The `payload` is stored as `payloadJson` and must
 * not contain secrets/decrypted PII (store only ids + counts).
 */

import { prisma } from '@/lib/db';
import { sendEmail, isEmailConfigured } from '@/lib/email';
import { getOrCreateUserOrg } from '@/lib/org';
import { renderOrgTemplate } from '@/lib/email/templates';
import {
  DEFAULT_PREF,
  type DeliveryPref,
  type NotificationType,
} from './types';

export interface NotifyEmailContent {
  subject: string;
  html: string;
}

export interface NotifyEmailTemplate {
  /** A known email-template key (see `@/lib/email/templates`). */
  templateKey: string;
  /** Placeholder values; HTML-escaped during render. */
  vars?: Record<string, string | number | null | undefined>;
}

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  /** Non-sensitive metadata stored on the in-app Notification row. */
  payload: Record<string, unknown>;
  /**
   * Email content. Either pass explicit `{ subject, html }` (legacy callers)
   * or a `{ templateKey, vars }` to render the recipient's org template. Only
   * sent when the user's email pref is enabled.
   */
  email?: NotifyEmailContent | NotifyEmailTemplate;
}

function isTemplateEmail(
  e: NotifyEmailContent | NotifyEmailTemplate,
): e is NotifyEmailTemplate {
  return 'templateKey' in e;
}

export interface NotifyResult {
  inAppCreated: boolean;
  emailSent: boolean;
  notificationId: string | null;
}

/** Resolve a user's delivery preference for a single type (defaults applied). */
export async function getPreference(
  userId: string,
  type: NotificationType,
): Promise<DeliveryPref> {
  const row = await prisma.notificationPreference.findUnique({
    where: { userId_type: { userId, type } },
    select: { email: true, inApp: true },
  });
  return row ?? DEFAULT_PREF;
}

/** Attempt an email send with one inline retry on transient failure.
 * Returns true on success, false if both attempts threw. Never throws. */
async function sendWithRetry(content: NotifyEmailContent, to: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // sendEmail returns false only when email is intentionally not
      // configured (handled by the caller via isEmailConfigured), so a false
      // here is still a "no exception" outcome — treat as the loop result.
      return await sendEmail({ to, subject: content.subject, html: content.html });
    } catch {
      if (attempt === 0) {
        // Brief backoff before the single retry — covers a transient Resend
        // hiccup without blocking the caller for long.
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
    }
  }
  return false;
}

/**
 * Deliver a notification across the in-app + email channels. Resolves the
 * recipient's per-type preference, writes the in-app row, and attempts the
 * email (with one inline retry) — then records the real outcome on the row:
 *   - email enabled + sent (or email intentionally not configured) -> SENT
 *   - email enabled but send failed after retry -> FAILED, failureCount++
 *   - email not requested/disabled -> SENT (the in-app row IS the delivery)
 *
 * Never throws: callers depend on notify() not crashing their flow.
 */
export async function notify(input: NotifyInput): Promise<NotifyResult> {
  const result: NotifyResult = {
    inAppCreated: false,
    emailSent: false,
    notificationId: null,
  };

  try {
    const pref = await getPreference(input.userId, input.type);

    // Resolve the email content first (if the email channel is in play) so we
    // know whether an email send will be attempted before we set row status.
    let content: NotifyEmailContent | null = null;
    let recipient: string | null = null;
    const emailRequested = pref.email && !!input.email;
    if (emailRequested) {
      const user = await prisma.user.findUnique({
        where: { id: input.userId },
        select: { email: true },
      });
      if (user?.email) {
        recipient = user.email;
        if (isTemplateEmail(input.email!)) {
          // Resolve the recipient's org template, render with the given vars.
          // Unknown key (renderOrgTemplate -> null) => skip email, not an empty send.
          const orgId = await getOrCreateUserOrg(input.userId);
          const rendered = await renderOrgTemplate(
            orgId,
            input.email!.templateKey,
            input.email!.vars ?? {},
          );
          if (rendered) content = { subject: rendered.subject, html: rendered.html };
        } else {
          content = { subject: input.email!.subject, html: input.email!.html };
        }
      }
    }

    // Will we actually try to put bytes on the wire? Only when an email is
    // requested, resolved, AND email is configured. If RESEND isn't configured
    // we treat the email channel as a no-op success (don't spam FAILED).
    const willAttemptEmail = !!content && !!recipient && isEmailConfigured();

    let notificationId: string | null = null;
    if (pref.inApp) {
      // Create the in-app row PENDING when an email send will be attempted (its
      // final status reflects the email outcome); otherwise the in-app row IS
      // the delivery and is SENT immediately.
      const row = await prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          // Cast: payload is plain JSON-safe metadata (ids/counts), see contract.
          payloadJson: input.payload as object,
          status: willAttemptEmail ? 'PENDING' : 'SENT',
          sentAt: willAttemptEmail ? null : new Date(),
        },
        select: { id: true },
      });
      result.inAppCreated = true;
      result.notificationId = notificationId = row.id;
    }

    if (content && recipient) {
      if (!isEmailConfigured()) {
        // Email intentionally off — no-op success, don't mark FAILED.
        result.emailSent = false;
        if (notificationId) {
          await prisma.notification.update({
            where: { id: notificationId },
            data: { status: 'SENT', sentAt: new Date() },
          });
        }
      } else {
        const sent = await sendWithRetry(content, recipient);
        result.emailSent = sent;
        if (notificationId) {
          if (sent) {
            await prisma.notification.update({
              where: { id: notificationId },
              data: { status: 'SENT', sentAt: new Date() },
            });
          } else {
            // eslint-disable-next-line no-console
            console.error(
              `[notify] email delivery FAILED type=${input.type} notification=${notificationId} (no PII logged)`,
            );
            await prisma.notification.update({
              where: { id: notificationId },
              data: { status: 'FAILED', failureCount: { increment: 1 } },
            });
          }
        } else if (!sent) {
          // eslint-disable-next-line no-console
          console.error(
            `[notify] email delivery FAILED type=${input.type} (in-app disabled, no PII logged)`,
          );
        }
      }
    }
  } catch (err) {
    // Last-resort guard: notify() must never throw out to its callers.
    // eslint-disable-next-line no-console
    console.error(`[notify] unexpected error type=${input.type}:`, err);
  }

  return result;
}
