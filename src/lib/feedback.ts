/**
 * Feedback delivery.
 *
 * Every submission is stored locally (see the Feedback model). If a
 * FEEDBACK_WEBHOOK_URL is configured (set in the desktop app's config.json, or
 * as an env var on a hosted deploy) the full payload is ALSO POSTed there so it
 * reaches us — point it at an n8n webhook that files a Jira ticket. When no URL
 * is set, feedback still lives in the local DB and the admin Feedback page.
 */

export interface FeedbackPayload {
  id: string;
  category: string;
  message: string;
  pageUrl?: string | null;
  appVersion?: string | null;
  userAgent?: string | null;
  userEmail?: string | null;
  targetText?: string | null;
  targetHref?: string | null;
  targetSelector?: string | null;
  screenshot?: string | null;
  createdAt: string;
}

function webhookUrl(): string {
  return (process.env.FEEDBACK_WEBHOOK_URL || '').trim().replace(/\/+$/, '');
}

function timeoutMs(): number {
  return Number.parseInt(process.env.FEEDBACK_TIMEOUT_MS ?? '8000', 10);
}

/** Forward to the configured webhook. Returns {delivered, error}; never throws. */
export async function forwardFeedback(
  payload: FeedbackPayload,
): Promise<{ delivered: boolean; error?: string }> {
  const url = webhookUrl();
  if (!url) return { delivered: false, error: 'no FEEDBACK_WEBHOOK_URL configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'findtalent-desktop', ...payload }),
      signal: controller.signal,
    });
    if (!res.ok) return { delivered: false, error: `webhook ${res.status}` };
    return { delivered: true };
  } catch (err) {
    return { delivered: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
