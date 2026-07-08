import type Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';

import { prisma } from '@/lib/db';
import { grantCredits } from '@/lib/credits';
import { notify } from '@/lib/notifications/deliver';
import { stripe } from '@/lib/stripe/client';
import { CheckoutMetadataSchema } from '@/lib/stripe/types';
import { reportError } from '@/lib/observability/report';

// Stripe SDK uses Node.js crypto for signature verification, so this route
// must run on the Node runtime (not Edge).
export const runtime = 'nodejs';

// Avoid caching — every delivery is a unique request.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort logger that strips signing material and any large session/body
 * payloads. We log only the event id, type, and a small set of safe fields.
 */
function logEvent(event: Stripe.Event, extra: Record<string, unknown> = {}): void {
  // eslint-disable-next-line no-console
  console.log('[stripe-webhook]', {
    id: event.id,
    type: event.type,
    livemode: event.livemode,
    created: event.created,
    ...extra,
  });
}

function getWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  }
  return secret;
}

/**
 * Resolve the `Stripe.Customer` id from a string/Customer/DeletedCustomer
 * union. Returns null if the field is null or a deleted customer.
 */
function customerIdOf(
  field: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
): string | null {
  if (!field) return null;
  if (typeof field === 'string') return field;
  if ('deleted' in field && field.deleted) return null;
  return field.id;
}

/**
 * Extract the first line item's `price.id` from a Subscription object.
 */
function firstSubscriptionPriceId(
  subscription: Stripe.Subscription,
): string | null {
  const item = subscription.items.data[0];
  if (!item) return null;
  return item.price?.id ?? null;
}

/**
 * Extract the first line item's price id from an Invoice object.
 * Stripe places the price under `pricing.price_details.price`.
 */
function firstInvoicePriceId(invoice: Stripe.Invoice): string | null {
  const line = invoice.lines.data[0];
  if (!line) return null;
  const priceDetails = line.pricing?.price_details;
  if (!priceDetails) return null;
  const price = priceDetails.price;
  return typeof price === 'string' ? price : price.id;
}

/**
 * Extract the first line item's period end timestamp from an Invoice (seconds
 * since epoch). Returns null when there are no line items.
 */
function firstInvoicePeriodEnd(invoice: Stripe.Invoice): number | null {
  const line = invoice.lines.data[0];
  if (!line) return null;
  return Number(line.period.end);
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/** Outcome of a two-phase claim on a Stripe event id. */
type ClaimOutcome =
  // Fresh insert — we own this delivery; run the handler.
  | 'claimed'
  // A prior delivery claimed but never reached 'completed' (crash / still
  // in-flight). Re-run the (idempotent) handler so a grant can't be swallowed.
  | 'rerun'
  // A prior delivery finished the side effects. Short-circuit with an
  // idempotent ack.
  | 'completed';

/**
 * Two-phase claim of a Stripe event id via the dedicated `WebhookEvent` table.
 *
 * Phase 1 (here): the FIRST delivery inserts the row with `status='processing'`
 * BEFORE any side effects run. A concurrent / later re-delivery hits the P2002
 * unique violation on `eventId` and we inspect the existing row's status:
 *   - `completed` → the grant already committed, so short-circuit ('completed').
 *   - `processing` → the prior attempt crashed (or is still running) BEFORE
 *     marking completion, so a naive "already seen, ack 200" would silently drop
 *     the grant. Re-run the handler instead ('rerun'). Handlers are idempotent
 *     (invoice period-guard + `grantCredits` idempotencyKey + zeroed-balance
 *     guard), so a re-run can't double-apply.
 *
 * Phase 2 is {@link markEventCompleted}, called AFTER the side effects commit.
 */
async function claimEvent(
  eventId: string,
  type: string,
): Promise<ClaimOutcome> {
  try {
    await prisma.webhookEvent.create({
      data: { eventId, type, status: 'processing' },
    });
    return 'claimed';
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      const existing = await prisma.webhookEvent.findUnique({
        where: { eventId },
        select: { status: true },
      });
      return existing?.status === 'completed' ? 'completed' : 'rerun';
    }
    throw err;
  }
}

/**
 * Phase 2 of the claim: mark the event fully processed AFTER its side effects
 * have committed, so any later re-delivery short-circuits (idempotent ack)
 * instead of re-running the handler.
 */
async function markEventCompleted(eventId: string): Promise<void> {
  await prisma.webhookEvent.update({
    where: { eventId },
    data: { status: 'completed' },
  });
}

// ---------------------------------------------------------------------------
// Handlers per event type
// ---------------------------------------------------------------------------

async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const parsed = CheckoutMetadataSchema.safeParse(session.metadata);
  if (!parsed.success) {
    // Unknown metadata shape — log and ignore. We don't want to throw on
    // legacy or test sessions that lack our `kind` field.
    // eslint-disable-next-line no-console
    console.warn('[stripe-webhook] session.metadata did not match schema', {
      sessionId: session.id,
      issues: parsed.error.issues,
    });
    return;
  }
  const meta = parsed.data;
  if (meta.kind === 'credit_pack') {
    // Pack credits roll over and are never reset at renewal — store them in
    // the dedicated `purchasedCredits` bucket. Key the grant on the Stripe
    // session id so a webhook re-run (status='processing' → 'rerun') can't
    // double-grant: the second insert collides on the idempotencyKey and is a
    // no-op.
    await grantCredits(
      meta.userId,
      meta.credits,
      session.id,
      'PURCHASE',
      'purchased',
      `purchase:${session.id}`,
    );
    return;
  }
  // Subscription mode: do nothing here — wait for `invoice.paid` to grant the
  // subscription credits. We still record the customer id so the user has
  // a Stripe-linked record before any invoice arrives.
  const customer = customerIdOf(session.customer);
  if (customer) {
    await prisma.user.update({
      where: { id: meta.userId },
      data: { stripeCustomerId: customer },
    });
  }
}

async function handleSubscriptionUpsert(
  subscription: Stripe.Subscription,
): Promise<void> {
  const priceId = firstSubscriptionPriceId(subscription);
  if (!priceId) return;
  const plan = await prisma.plan.findUnique({
    where: { stripePriceId: priceId },
    select: { id: true },
  });
  if (!plan) return;

  const customerId = customerIdOf(subscription.customer);
  if (!customerId) return;

  const user = await prisma.user.findFirst({
    where: { stripeCustomerId: customerId },
    select: { id: true },
  });
  if (!user) return;

  // Mirror Stripe's subscription status into our soft-gate flag. We map the
  // Stripe states we care about; an `active`/`trialing` subscription clears any
  // prior `past_due`, while `past_due`/`unpaid` engages the soft gate. Other
  // states (e.g. `incomplete`) leave the flag untouched.
  const data: { currentPlanId: string; stripeCustomerId: string; subscriptionStatus?: string } = {
    currentPlanId: plan.id,
    stripeCustomerId: customerId,
  };
  if (subscription.status === 'active' || subscription.status === 'trialing') {
    data.subscriptionStatus = 'active';
  } else if (
    subscription.status === 'past_due' ||
    subscription.status === 'unpaid'
  ) {
    data.subscriptionStatus = 'past_due';
  }

  await prisma.user.update({
    where: { id: user.id },
    data,
  });
}

async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
): Promise<void> {
  const customerId = customerIdOf(subscription.customer);
  if (!customerId) return;

  // Zero the subscription credit balance on cancel — but RECORD it in the
  // ledger. Without this row the CreditTransaction history can't reconcile to
  // past balances (the ledger view reconstructs running balances by walking
  // the deltas), so a silent set-to-0 left the ledger permanently off.
  //
  // Read the balance INSIDE the transaction (mirroring handleInvoicePaid): if a
  // reveal-spend commits between the read and the wipe, a balance read taken
  // OUTSIDE the tx would make the `-creditsBalance` ledger row overstate the
  // amount actually zeroed, drifting the ledger. Reading in-tx keeps the wipe
  // delta consistent with the value we set to 0.
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findFirst({
      where: { stripeCustomerId: customerId },
      select: { id: true, creditsBalance: true },
    });
    if (!user) return;

    await tx.user.update({
      where: { id: user.id },
      data: {
        currentPlanId: null,
        creditsBalance: 0,
        subscriptionStatus: 'canceled',
      },
    });
    if (user.creditsBalance > 0) {
      await tx.creditTransaction.create({
        data: {
          userId: user.id,
          delta: -user.creditsBalance,
          reason: 'ADMIN_ADJUST',
          refId: `subscription-canceled:${subscription.id}`,
        },
      });
    }
  });
}

async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  // Only act on the events that actually grant credits — initial purchase
  // and renewals. Other billing reasons (manual top-ups, prorations) are not
  // a subscription-period grant.
  const reason = invoice.billing_reason;
  if (reason !== 'subscription_create' && reason !== 'subscription_cycle') {
    return;
  }

  const customerId = customerIdOf(invoice.customer);
  if (!customerId) return;

  const priceId = firstInvoicePriceId(invoice);
  if (!priceId) return;

  const plan = await prisma.plan.findUnique({
    where: { stripePriceId: priceId },
    select: { id: true, creditsPerPeriod: true },
  });
  if (!plan) {
    // We recognise the price on the invoice but have no local Plan seeded for
    // it — a MISCONFIG, not an irrelevant event. Silently acking would drop
    // this paid period's credit grant forever, so report + throw → 500 → Stripe
    // retries (giving us a window to seed the Plan before the event expires).
    reportError(new Error(`invoice.paid: no Plan seeded for price ${priceId}`), {
      area: 'stripe.invoice_paid',
      reason: 'plan_not_seeded',
      priceId,
      customerId,
      invoiceId: invoice.id ?? null,
    });
    throw new Error(`invoice.paid: no Plan seeded for price ${priceId}`);
  }

  const periodEndEpoch = firstInvoicePeriodEnd(invoice);
  if (periodEndEpoch === null) return;
  const periodEnd = new Date(Number(periodEndEpoch) * 1000);

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findFirst({
      where: { stripeCustomerId: customerId },
      select: { id: true, creditsBalance: true, creditsPeriodEnd: true },
    });
    if (!user) {
      // A paid invoice for a Stripe customer we can't map to any user is a
      // MISCONFIG / data-drift, not an irrelevant event: throw (→500→retry)
      // rather than silently ack and lose the paid period's grant.
      reportError(new Error('invoice.paid: no user for stripe customer'), {
        area: 'stripe.invoice_paid',
        reason: 'user_not_found',
        customerId,
        invoiceId: invoice.id ?? null,
      });
      throw new Error('invoice.paid: no user for stripe customer');
    }

    // Idempotency for the period grant. `claimEvent` already dedupes on the
    // Stripe *event* id, but Stripe can deliver a second `invoice.paid` for the
    // SAME invoice/period under a DIFFERENT event id (e.g. a re-fired event), so
    // the event-id claim alone does not stop a double-grant. Guard on the
    // billing period: if we've already reset to this exact period end, the
    // grant for this period happened — skip it. A genuine renewal carries a NEW
    // period end, so the legitimate reset still runs.
    if (
      user.creditsPeriodEnd &&
      user.creditsPeriodEnd.getTime() === periodEnd.getTime()
    ) {
      // eslint-disable-next-line no-console
      console.log('[stripe-webhook] invoice.paid skipped (period already granted)', {
        invoiceId: invoice.id,
        userId: user.id,
        periodEnd: periodEnd.toISOString(),
      });
      return;
    }

    const oldBalance = user.creditsBalance;
    const newBalance = plan.creditsPerPeriod;
    const delta = newBalance - oldBalance;

    await tx.user.update({
      where: { id: user.id },
      data: {
        currentPlanId: plan.id,
        creditsBalance: newBalance,
        creditsPeriodEnd: periodEnd,
        // A paid invoice clears any prior dunning state.
        subscriptionStatus: 'active',
      },
    });

    // Always write a ledger row, even when delta is zero, so the invoice id
    // is traceable. `delta=0` documents a no-op reset (e.g. renewal of a
    // plan that was already at the period's credit amount).
    await tx.creditTransaction.create({
      data: {
        userId: user.id,
        delta,
        reason: 'SUBSCRIPTION_GRANT',
        refId: invoice.id ?? null,
      },
    });
  });
}

/**
 * Dunning: a subscription payment failed. We notify the customer (in-app +
 * email, honouring their preferences via `notify()`) so they can update their
 * payment method, and log a `past_due`-style flag for support. We deliberately
 * do NOT mutate credits or schema here — access stays governed by the existing
 * subscription lifecycle (a continued failure ultimately fires
 * `customer.subscription.deleted`, which zeroes the balance).
 */
async function handleInvoicePaymentFailed(
  invoice: Stripe.Invoice,
): Promise<void> {
  const customerId = customerIdOf(invoice.customer);
  if (!customerId) return;
  const user = await prisma.user.findFirst({
    where: { stripeCustomerId: customerId },
    select: { id: true },
  });
  if (!user) return;

  // Engage the soft gate: mark the account past_due so NEW reveals are blocked
  // (read access + existing reveals are unaffected — see lock.ts / actions.ts).
  await prisma.user.update({
    where: { id: user.id },
    data: { subscriptionStatus: 'past_due' },
  });

  // The Billing Portal link the user needs to fix their card. Use the
  // hosted-portal route on our own domain (it creates a session on click).
  const base = process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
  // Escape before interpolating into the email href: NEXTAUTH_URL is admin-set
  // but Zod .url() permits quotes, so escape defensively to prevent attribute
  // breakout / HTML injection in the outgoing email.
  const portalUrl = `${base}/billing/portal`
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // notify() handles per-user prefs + records the in-app row + sends email.
  // Payload stores only non-sensitive ids/amounts (no PII, no card data).
  await notify({
    userId: user.id,
    type: 'payment_failed',
    payload: {
      invoiceId: invoice.id ?? null,
      amountDue: invoice.amount_due,
      currency: invoice.currency,
      status: 'past_due',
    },
    email: {
      subject: 'Action needed: your payment could not be processed',
      html: `<p>We were unable to process your most recent subscription payment.</p>
<p>To keep your account active, please update your payment method:</p>
<p><a href="${portalUrl}">Manage billing</a></p>
<p>If you have already updated your card, you can ignore this message.</p>`,
    },
  });

  // eslint-disable-next-line no-console
  console.log('[stripe-webhook] dunning notice sent', {
    invoiceId: invoice.id,
    userId: user.id,
  });
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<Response> {
  const sig = req.headers.get('stripe-signature');
  if (!sig) {
    return new NextResponse('Missing stripe-signature header', { status: 400 });
  }

  // CRITICAL: read the *raw* body. Calling .text() on the standard `Request`
  // does not parse JSON, which is what `constructEvent` expects.
  const body = await req.text();

  let secret: string;
  try {
    secret = getWebhookSecret();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stripe-webhook] missing webhook secret', err);
    return new NextResponse('Server misconfigured', { status: 500 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid signature';
    // eslint-disable-next-line no-console
    console.warn('[stripe-webhook] signature verification failed', {
      message,
    });
    return new NextResponse(`Webhook Error: ${message}`, { status: 400 });
  }

  // ---- after this point the event is verified --------------------------

  // Idempotency: two-phase claim on the unique `WebhookEvent` row. A prior
  // delivery that already FINISHED short-circuits with an idempotent ack; one
  // that only claimed-but-crashed ('processing') is re-run so its grant can't be
  // lost. We flip the row to 'completed' only AFTER the side effects commit.
  const outcome = await claimEvent(event.id, event.type);
  if (outcome === 'completed') {
    logEvent(event, { idempotent: true });
    return NextResponse.json({ ok: true, idempotent: true });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        await handleCheckoutSessionCompleted(event.data.object);
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        await handleSubscriptionUpsert(event.data.object);
        break;
      }
      case 'customer.subscription.deleted': {
        await handleSubscriptionDeleted(event.data.object);
        break;
      }
      case 'invoice.paid': {
        await handleInvoicePaid(event.data.object);
        break;
      }
      case 'invoice.payment_failed': {
        await handleInvoicePaymentFailed(event.data.object);
        break;
      }
      default: {
        // Nothing to do for this type — mark it completed so a retry
        // short-circuits as an idempotent ack.
        await markEventCompleted(event.id);
        logEvent(event, { ignored: true });
        return NextResponse.json({ ok: true, ignored: true });
      }
    }
    // Side effects committed successfully — flip the claim to 'completed' so any
    // later re-delivery short-circuits instead of re-running.
    await markEventCompleted(event.id);
    logEvent(event, { handled: true });
    return NextResponse.json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stripe-webhook] handler threw', {
      id: event.id,
      type: event.type,
      message: err instanceof Error ? err.message : String(err),
    });
    reportError(err, { area: 'stripe.webhook', eventId: event.id, eventType: event.type });
    // Leave the claim at 'processing' (do NOT delete it): Stripe's retry sees
    // 'processing' → re-runs the idempotent handler until it succeeds and marks
    // 'completed'. Returning 500 triggers that retry. This removes the old
    // best-effort releaseClaim (a delete failure could otherwise strand a claim
    // and permanently block reprocessing).
    return new NextResponse('Webhook handler error', { status: 500 });
  }
}
