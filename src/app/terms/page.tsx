const BRAND_NAME = process.env.BRAND_NAME ?? 'FindTalent';

export const metadata = { title: 'Terms of service' };

export default function TermsPage() {
  return (
    <article className="mx-auto max-w-3xl px-6 py-16 prose prose-zinc">
      <h1>Terms of service</h1>
      <p>
        These terms govern your use of {BRAND_NAME}.
      </p>
      <h2>What {BRAND_NAME} provides</h2>
      <p>
        Access to an anonymized talent shortlist matched on the criteria of the project
        you create. Personal data of candidates is only disclosed when you spend a
        credit to reveal a single candidate.
      </p>
      <h2>Reveals and exclusivity</h2>
      <p>
        Each revealed candidate is held in 14-day exclusive access within the same
        talent pool — other paying users of the same pool cannot reveal the same
        candidate during that window.
      </p>
      <h2>Refunds</h2>
      <p>
        Credits are non-refundable once spent. Subscription periods are pro-rated upon
        cancellation per Stripe policy.
      </p>
      <h2>Acceptable use</h2>
      <p>
        Do not attempt to bypass the anonymization, re-identify candidates by external
        means, or share reveal payloads outside your hiring organisation.
      </p>
    </article>
  );
}
