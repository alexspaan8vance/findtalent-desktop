import type Stripe from 'stripe';

import { prisma } from '@/lib/db';
import { stripe } from './client';
import {
  EXTRA_CREDIT_TIER_KEY,
  FINDTALENT_TIER_METADATA_KEY,
  type CreditPackMetadata,
  type PlanKey,
  type SubscriptionMetadata,
} from './types';
import { PLAN_TIERS, type PlanTier } from './plans';

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Stripe Checkout's `success_url` supports a `{CHECKOUT_SESSION_ID}` literal
 * that is replaced at redirect-time. We append it as a query param so the
 * caller can read the session id after return.
 */
function buildSuccessUrl(returnUrl: string): string {
  const url = new URL(returnUrl);
  url.searchParams.set('checkout', 'success');
  url.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
  return url.toString();
}

function buildCancelUrl(returnUrl: string): string {
  const url = new URL(returnUrl);
  url.searchParams.set('checkout', 'canceled');
  return url.toString();
}

// ---------------------------------------------------------------------------
// Extra-credit price lookup with module-level cache
// ---------------------------------------------------------------------------

let cachedExtraCreditPriceId: string | null = null;

async function getExtraCreditPriceId(): Promise<string> {
  if (cachedExtraCreditPriceId) {
    return cachedExtraCreditPriceId;
  }
  // Stripe doesn't let us search prices by metadata directly, but we can
  // search products and then list their prices.
  const products = await stripe.products.search({
    query: `metadata['${FINDTALENT_TIER_METADATA_KEY}']:'${EXTRA_CREDIT_TIER_KEY}' AND active:'true'`,
    limit: 1,
  });
  const product = products.data[0];
  if (!product) {
    throw new Error(
      `No Stripe product with metadata.${FINDTALENT_TIER_METADATA_KEY}='${EXTRA_CREDIT_TIER_KEY}'. Run \`npm run stripe:seed\`.`,
    );
  }
  const prices = await stripe.prices.list({
    product: product.id,
    active: true,
    limit: 1,
  });
  const price = prices.data[0];
  if (!price) {
    throw new Error(
      `Extra-credit product ${product.id} has no active price. Run \`npm run stripe:seed\`.`,
    );
  }
  cachedExtraCreditPriceId = price.id;
  return price.id;
}

function planTierFor(key: PlanKey): PlanTier {
  const tier = PLAN_TIERS.find((t) => t.key === key);
  if (!tier) {
    throw new Error(`Unknown plan key: ${key}`);
  }
  return tier;
}

/**
 * Default free trial length (days) for subscription checkouts. Read from
 * `STRIPE_TRIAL_PERIOD_DAYS`; 0 / unset / invalid disables the trial.
 */
function defaultTrialPeriodDays(): number | undefined {
  const raw = process.env.STRIPE_TRIAL_PERIOD_DAYS;
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

// ---------------------------------------------------------------------------
// ensureStripeCustomer
// ---------------------------------------------------------------------------

/**
 * Look up the Stripe customer id for a user, creating one on Stripe and
 * persisting it if absent. Idempotent within a single user row.
 */
export async function ensureStripeCustomer(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      stripeCustomerId: true,
    },
  });
  if (!user) {
    throw new Error(`User ${userId} not found`);
  }
  if (user.stripeCustomerId) {
    return user.stripeCustomerId;
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name ?? undefined,
    metadata: { userId: user.id },
  });
  await prisma.user.update({
    where: { id: user.id },
    data: { stripeCustomerId: customer.id },
  });
  return customer.id;
}

// ---------------------------------------------------------------------------
// Checkout sessions
// ---------------------------------------------------------------------------

export interface CheckoutResult {
  url: string;
}

/**
 * Create a Stripe Checkout session for a recurring subscription.
 *
 * Looks up the local `Plan` row whose `name` matches the configured tier name
 * (e.g. "Try", "Basic", "Pro") and uses its `stripePriceId` as the line item.
 * The session metadata captures the user/plan link so the webhook can resolve
 * who paid without needing to wait for `customer.subscription.created`.
 */
export async function createSubscriptionCheckout(
  userId: string,
  planKey: PlanKey,
  returnUrl: string,
  opts: { trialPeriodDays?: number } = {},
): Promise<CheckoutResult> {
  const tier = planTierFor(planKey);
  const plan = await prisma.plan.findFirst({
    where: { name: tier.name, active: true },
    select: { stripePriceId: true },
  });
  if (!plan) {
    throw new Error(
      `No active Plan row for tier '${planKey}' (name='${tier.name}'). Run \`npm run stripe:seed\`.`,
    );
  }

  const customerId = await ensureStripeCustomer(userId);

  const metadata: SubscriptionMetadata = {
    kind: 'subscription',
    userId,
    planKey,
  };

  const trialPeriodDays = opts.trialPeriodDays ?? defaultTrialPeriodDays();

  const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData =
    {
      // Mirror metadata onto the resulting subscription so we can correlate
      // future invoice.* events back to the originating checkout.
      metadata: {
        kind: metadata.kind,
        userId: metadata.userId,
        planKey: metadata.planKey,
      },
    };
  if (trialPeriodDays) {
    subscriptionData.trial_period_days = trialPeriodDays;
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    success_url: buildSuccessUrl(returnUrl),
    cancel_url: buildCancelUrl(returnUrl),
    // EU VAT: let Stripe Tax compute VAT and let the buyer enter a VAT id;
    // collect a billing address (required for tax) and persist it back to the
    // customer so future invoices stay tax-correct.
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    billing_address_collection: 'required',
    customer_update: { address: 'auto', name: 'auto' },
    metadata: {
      kind: metadata.kind,
      userId: metadata.userId,
      planKey: metadata.planKey,
    },
    subscription_data: subscriptionData,
  });

  if (!session.url) {
    throw new Error('Stripe Checkout session returned no url');
  }
  return { url: session.url };
}

/**
 * Create a one-off Checkout session for buying `quantity` extra credits.
 */
export async function createCreditPackCheckout(
  userId: string,
  quantity: number,
  returnUrl: string,
): Promise<CheckoutResult> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('quantity must be a positive integer');
  }

  const priceId = await getExtraCreditPriceId();
  const customerId = await ensureStripeCustomer(userId);

  const metadata: CreditPackMetadata = {
    kind: 'credit_pack',
    userId,
    credits: quantity,
  };

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    line_items: [{ price: priceId, quantity }],
    success_url: buildSuccessUrl(returnUrl),
    cancel_url: buildCancelUrl(returnUrl),
    // VAT also applies to one-off credit-pack purchases.
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    billing_address_collection: 'required',
    customer_update: { address: 'auto', name: 'auto' },
    metadata: {
      kind: metadata.kind,
      userId: metadata.userId,
      // Stripe metadata is string-typed on the wire — coerce explicitly.
      credits: String(metadata.credits),
    },
  });

  if (!session.url) {
    throw new Error('Stripe Checkout session returned no url');
  }
  return { url: session.url };
}

export interface PortalOptions {
  /**
   * When 'subscription_update', deep-link the portal straight into the
   * plan-switch flow for the customer's active subscription. Stripe then
   * applies the change as a PRORATED update of the existing subscription
   * (no second subscription is created). Falls back to the normal portal
   * home page when the customer has no active subscription.
   */
  flow?: 'subscription_update';
}

/**
 * Find the customer's active (or trialing) subscription id, if any. Used to
 * target the portal's plan-switch flow at a concrete subscription.
 */
async function findActiveSubscriptionId(
  customerId: string,
): Promise<string | null> {
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 10,
  });
  const active = subs.data.find(
    (s) => s.status === 'active' || s.status === 'trialing' || s.status === 'past_due',
  );
  return active?.id ?? null;
}

/**
 * Whether the user already has a live (active / trialing / past_due)
 * subscription. Used to divert a would-be SECOND subscription checkout into the
 * portal's plan-switch flow — Checkout in subscription mode would otherwise
 * create a parallel subscription (double billing + one renewal clobbering the
 * other's credits). Cheap-exits without hitting Stripe when the user has no
 * customer id yet (and never creates one just to check).
 */
export async function hasActiveSubscription(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true },
  });
  if (!user?.stripeCustomerId) return false;
  const subscriptionId = await findActiveSubscriptionId(user.stripeCustomerId);
  return subscriptionId !== null;
}

/**
 * Create a Stripe Billing Portal session so the user can manage their
 * subscription, payment method, and invoices.
 *
 * Pass `{ flow: 'subscription_update' }` to open directly on the plan-switch
 * screen so an upgrade/downgrade PRORATES the existing subscription instead of
 * starting a parallel one (the revenue/billing bug we want to avoid).
 */
export async function createPortalSession(
  userId: string,
  returnUrl: string,
  opts: PortalOptions = {},
): Promise<CheckoutResult> {
  const customerId = await ensureStripeCustomer(userId);

  const params: Stripe.BillingPortal.SessionCreateParams = {
    customer: customerId,
    return_url: returnUrl,
  };

  if (opts.flow === 'subscription_update') {
    const subscriptionId = await findActiveSubscriptionId(customerId);
    // Only attach the flow when there's a subscription to update; otherwise
    // Stripe rejects the request. No subscription → plain portal home.
    if (subscriptionId) {
      params.flow_data = {
        type: 'subscription_update',
        subscription_update: { subscription: subscriptionId },
        after_completion: {
          type: 'redirect',
          redirect: { return_url: returnUrl },
        },
      };
    }
  }

  const portal: Stripe.BillingPortal.Session =
    await stripe.billingPortal.sessions.create(params);
  if (!portal.url) {
    throw new Error('Stripe billing portal session returned no url');
  }
  return { url: portal.url };
}
