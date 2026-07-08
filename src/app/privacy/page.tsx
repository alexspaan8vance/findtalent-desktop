const BRAND_NAME = process.env.BRAND_NAME ?? 'FindTalent';
const SUPPORT_EMAIL = process.env.BRAND_SUPPORT_EMAIL ?? 'privacy@findtalent.local';

export const metadata = { title: 'Privacy policy' };

export default function PrivacyPage() {
  return (
    <article className="mx-auto max-w-3xl px-6 py-16 prose prose-zinc">
      <h1>Privacy policy</h1>
      <p>
        This page summarises how {BRAND_NAME} processes personal data.
      </p>

      <h2>Data we process</h2>
      <ul>
        <li>Account: email, name, password hash, login timestamps.</li>
        <li>
          Billing: Stripe customer id and invoice metadata. Card data is held by Stripe,
          never by us.
        </li>
        <li>
          Talent data: skills, anonymized work history, location (province/country),
          retrieved from 8vance under your subscription. Full PII is only loaded into the
          encrypted reveal cache when you spend a credit to unlock a candidate.
        </li>
      </ul>

      <h2>How we store it</h2>
      <p>
        Tenant 8vance API secrets and reveal payloads are encrypted at rest with
        AES-256-GCM. Passwords are hashed with bcrypt.
      </p>

      <h2>Your rights</h2>
      <p>
        You can export your account data, request deletion of your profile, or correct
        any field by contacting{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>

      <h2>Sub-processors</h2>
      <ul>
        <li>Stripe (billing)</li>
        <li>Resend (transactional email)</li>
        <li>8vance (talent pool source)</li>
      </ul>
    </article>
  );
}
