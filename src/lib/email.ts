import { Resend } from 'resend';

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
};

// Lazy singleton — constructing Resend with an empty key throws at import
// time, which would crash any route that transitively imports this module
// (e.g. signup) on a deploy without email configured. Build it on first use.
let client: Resend | null = null;
function getClient(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!client) client = new Resend(key);
  return client;
}

/**
 * Whether transactional email is configured (RESEND_API_KEY + MAIL_FROM).
 * When false, {@link sendEmail} no-ops by design — callers (e.g. the
 * notification deliver loop) use this to distinguish "email intentionally off"
 * (treat as success / skip) from a genuine send failure.
 */
export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

/**
 * Send a transactional email. When email isn't configured (no
 * RESEND_API_KEY / MAIL_FROM) we log and no-op instead of throwing, so
 * flows like signup still work on a minimally-configured deploy. Returns
 * whether the email was actually sent.
 */
export async function sendEmail({ to, subject, html }: SendEmailInput): Promise<boolean> {
  const from = process.env.MAIL_FROM;
  const resend = getClient();
  if (!resend || !from) {
    // eslint-disable-next-line no-console
    console.warn(
      `[email] not configured (RESEND_API_KEY/MAIL_FROM missing) — skipping "${subject}" to ${to}`,
    );
    return false;
  }
  const result = await resend.emails.send({ from, to, subject, html });
  if (result.error) {
    throw new Error(`Resend send failed: ${result.error.message}`);
  }
  return true;
}
