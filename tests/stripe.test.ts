/**
 * Stripe webhook route tests.
 *
 * These tests mock the Stripe client and exercise the route handler at
 * `src/app/api/webhooks/stripe/route.ts` directly. The mock surfaces a
 * `constructEvent` we can drive with handcrafted events, and a noop set of
 * other API methods so the route handler imports cleanly.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type Stripe from 'stripe';

// `vi.mock` calls are hoisted to the very top of the file. The route handler
// (and the libraries it imports) reads `DATABASE_URL` at module-load time,
// so we must use `vi.hoisted` to set env vars before the mocks are evaluated.
const { TEST_DB } = await vi.hoisted(async () => {
  // Resolve relative to cwd because __dirname isn't reliably available in
  // a hoisted block depending on the loader. The test runner's cwd is the
  // project root, so we put the file in `tests/`. Static imports (like `path`
  // above) aren't initialized yet when hoisted code runs, so use a dynamic
  // import — vitest awaits the async factory before evaluating the mocks and
  // the module's own imports, preserving the env-before-import ordering.
  const nodePath = await import('node:path');
  const file = nodePath.resolve(process.cwd(), 'tests/stripe.test.db');
  process.env.DATABASE_URL = `file:${file}`;
  if (!process.env.STRIPE_SECRET_KEY) {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  }
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';
  return { TEST_DB: file };
});

// ---------------------------------------------------------------------------
// Stripe client mock
// ---------------------------------------------------------------------------
//
// constructEvent is the only Stripe method actually invoked by the route
// handler; everything else exists so any incidental imports succeed.
//
// We expose `setConstructEventImpl` so individual tests can replace the
// signature-verification behaviour.

let constructEventImpl: (
  body: string,
  sig: string,
  secret: string,
) => Stripe.Event = () => {
  throw new Error('constructEventImpl not set in this test');
};

function setConstructEventImpl(
  fn: (body: string, sig: string, secret: string) => Stripe.Event,
): void {
  constructEventImpl = fn;
}

vi.mock('@/lib/stripe/client', () => ({
  stripe: {
    webhooks: {
      constructEvent: (body: string, sig: string, secret: string) =>
        constructEventImpl(body, sig, secret),
    },
  },
}));

// Spy on grantCredits so we can assert credit-pack handling.
type GrantCreditsFn = typeof import('@/lib/credits').grantCredits;
const grantCreditsSpy = vi.fn<GrantCreditsFn>();
vi.mock('@/lib/credits', async (orig) => {
  const actual = (await orig()) as typeof import('@/lib/credits');
  return {
    ...actual,
    grantCredits: (...args: Parameters<GrantCreditsFn>) => {
      grantCreditsSpy(...args);
      return actual.grantCredits(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function createUser(opts: {
  email: string;
  stripeCustomerId?: string;
  creditsBalance?: number;
  purchasedCredits?: number;
}) {
  return prisma.user.create({
    data: {
      email: opts.email,
      stripeCustomerId: opts.stripeCustomerId,
      creditsBalance: opts.creditsBalance ?? 0,
      purchasedCredits: opts.purchasedCredits ?? 0,
    },
  });
}

async function createPlan(stripePriceId: string, creditsPerPeriod: number) {
  return prisma.plan.create({
    data: {
      stripePriceId,
      name: `Plan ${stripePriceId}`,
      priceEur: 100,
      creditsPerPeriod,
      periodMonths: 2,
      featuresJson: {},
      active: true,
    },
  });
}

beforeAll(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB}` },
    stdio: 'inherit',
    shell: process.platform === 'win32' ? 'cmd.exe' : undefined,
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  try {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  } catch {
    // Windows holds the SQLite file briefly after disconnect — ignore.
  }
});

beforeEach(async () => {
  grantCreditsSpy.mockClear();
  await prisma.webhookEvent.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.creditTransaction.deleteMany();
  await prisma.user.deleteMany();
  await prisma.plan.deleteMany();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { POST } from '@/app/api/webhooks/stripe/route';

function makeRequest(body: string, sig: string | null): Request {
  const headers = new Headers();
  if (sig) headers.set('stripe-signature', sig);
  return new Request('https://example.com/api/webhooks/stripe', {
    method: 'POST',
    headers,
    body,
  });
}

function checkoutSessionEvent(opts: {
  id: string;
  sessionId: string;
  userId: string;
  credits: number;
  customerId?: string;
}): Stripe.Event {
  return {
    id: opts.id,
    object: 'event',
    api_version: '2026-05-27.dahlia',
    created: 1_700_000_000,
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: opts.sessionId,
        object: 'checkout.session',
        customer: opts.customerId ?? null,
        metadata: {
          kind: 'credit_pack',
          userId: opts.userId,
          credits: String(opts.credits),
        },
      } as unknown as Stripe.Checkout.Session,
    },
  } as unknown as Stripe.Event;
}

function invoicePaidEvent(opts: {
  id: string;
  invoiceId: string;
  customerId: string;
  priceId: string;
  periodEnd: number;
  billingReason: Stripe.Invoice.BillingReason;
}): Stripe.Event {
  return {
    id: opts.id,
    object: 'event',
    api_version: '2026-05-27.dahlia',
    created: 1_700_000_000,
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type: 'invoice.paid',
    data: {
      object: {
        id: opts.invoiceId,
        object: 'invoice',
        customer: opts.customerId,
        billing_reason: opts.billingReason,
        amount_due: 24900,
        lines: {
          data: [
            {
              id: 'il_test',
              object: 'line_item',
              period: { start: opts.periodEnd - 60 * 24 * 60 * 60, end: opts.periodEnd },
              pricing: {
                type: 'price_details',
                unit_amount_decimal: null,
                price_details: { price: opts.priceId, product: 'prod_test' },
              },
            },
          ],
          has_more: false,
          object: 'list',
          url: '',
        },
      } as unknown as Stripe.Invoice,
    },
  } as unknown as Stripe.Event;
}

function paymentFailedEvent(opts: {
  id: string;
  invoiceId: string;
  customerId: string;
}): Stripe.Event {
  return {
    id: opts.id,
    object: 'event',
    api_version: '2026-05-27.dahlia',
    created: 1_700_000_000,
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type: 'invoice.payment_failed',
    data: {
      object: {
        id: opts.invoiceId,
        object: 'invoice',
        customer: opts.customerId,
        amount_due: 24900,
        currency: 'eur',
      } as unknown as Stripe.Invoice,
    },
  } as unknown as Stripe.Event;
}

function subscriptionDeletedEvent(opts: {
  id: string;
  subscriptionId: string;
  customerId: string;
}): Stripe.Event {
  return {
    id: opts.id,
    object: 'event',
    api_version: '2026-05-27.dahlia',
    created: 1_700_000_000,
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type: 'customer.subscription.deleted',
    data: {
      object: {
        id: opts.subscriptionId,
        object: 'subscription',
        customer: opts.customerId,
      } as unknown as Stripe.Subscription,
    },
  } as unknown as Stripe.Event;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stripe webhook route', () => {
  it('returns 400 when stripe signature is invalid', async () => {
    setConstructEventImpl(() => {
      throw new Error('No signatures found matching the expected signature');
    });
    const res = await POST(makeRequest('{}', 't=1,v1=bogus'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when stripe-signature header is missing', async () => {
    const res = await POST(makeRequest('{}', null));
    expect(res.status).toBe(400);
  });

  it('grants credits on checkout.session.completed for a credit_pack', async () => {
    const user = await createUser({ email: 'a@test.local', creditsBalance: 0 });
    const event = checkoutSessionEvent({
      id: 'evt_credit_pack_1',
      sessionId: 'cs_credit_1',
      userId: user.id,
      credits: 3,
    });
    setConstructEventImpl(() => event);

    const res = await POST(makeRequest(JSON.stringify(event), 'sig_ok'));
    expect(res.status).toBe(200);
    expect(grantCreditsSpy).toHaveBeenCalledTimes(1);
    expect(grantCreditsSpy).toHaveBeenCalledWith(
      user.id,
      3,
      'cs_credit_1',
      'PURCHASE',
      'purchased',
      // Idempotency key derived from the session id (P1: blocks a double grant
      // when a still-'processing' claim is re-run).
      'purchase:cs_credit_1',
    );

    // Pack credits land in `purchasedCredits`, NOT the subscription balance.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.creditsBalance).toBe(0);
    expect(after.purchasedCredits).toBe(3);
  });

  it('grants subscription credits on invoice.paid via a transaction', async () => {
    const customerId = 'cus_test_sub';
    const user = await createUser({
      email: 'b@test.local',
      stripeCustomerId: customerId,
      creditsBalance: 0,
    });
    const plan = await createPlan('price_test_basic', 2);
    const event = invoicePaidEvent({
      id: 'evt_invoice_paid_1',
      invoiceId: 'in_test_1',
      customerId,
      priceId: plan.stripePriceId,
      periodEnd: 1_800_000_000,
      billingReason: 'subscription_create',
    });
    setConstructEventImpl(() => event);

    const res = await POST(makeRequest(JSON.stringify(event), 'sig_ok'));
    expect(res.status).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.creditsBalance).toBe(2);
    expect(after.currentPlanId).toBe(plan.id);
    expect(after.creditsPeriodEnd?.toISOString()).toBe(
      new Date(1_800_000_000 * 1000).toISOString(),
    );

    const ledger = await prisma.creditTransaction.findMany({
      where: { userId: user.id },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].delta).toBe(2);
    expect(ledger[0].reason).toBe('SUBSCRIPTION_GRANT');
    expect(ledger[0].refId).toBe('in_test_1');
  });

  it('is idempotent: a second delivery of the same event id is a no-op', async () => {
    const user = await createUser({ email: 'c@test.local', creditsBalance: 0 });
    const event = checkoutSessionEvent({
      id: 'evt_idempotent_1',
      sessionId: 'cs_idem_1',
      userId: user.id,
      credits: 5,
    });
    setConstructEventImpl(() => event);

    const first = await POST(makeRequest(JSON.stringify(event), 'sig_ok'));
    expect(first.status).toBe(200);

    const second = await POST(makeRequest(JSON.stringify(event), 'sig_ok'));
    expect(second.status).toBe(200);
    const body = (await second.json()) as { ok: boolean; idempotent?: boolean };
    expect(body.idempotent).toBe(true);

    // Credits granted exactly once.
    expect(grantCreditsSpy).toHaveBeenCalledTimes(1);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.purchasedCredits).toBe(5);
    const ledger = await prisma.creditTransaction.findMany({
      where: { userId: user.id },
    });
    expect(ledger).toHaveLength(1);
  });

  it('renewal resets subscription credits but leaves purchased pack credits intact', async () => {
    const customerId = 'cus_renewal_pack';
    // User has 1 leftover subscription credit + a 5-pack they bought.
    const user = await createUser({
      email: 'renew@test.local',
      stripeCustomerId: customerId,
      creditsBalance: 1,
      purchasedCredits: 5,
    });
    const plan = await createPlan('price_renewal_basic', 2);
    const event = invoicePaidEvent({
      id: 'evt_renewal_pack_1',
      invoiceId: 'in_renewal_1',
      customerId,
      priceId: plan.stripePriceId,
      periodEnd: 1_900_000_000,
      billingReason: 'subscription_cycle',
    });
    setConstructEventImpl(() => event);

    const res = await POST(makeRequest(JSON.stringify(event), 'sig_ok'));
    expect(res.status).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    // Subscription credits reset to the plan's per-period amount...
    expect(after.creditsBalance).toBe(2);
    // ...but the purchased 5-pack survives the renewal (the revenue bug).
    expect(after.purchasedCredits).toBe(5);
  });

  it('records a WebhookEvent row keyed by event id when processing', async () => {
    const user = await createUser({ email: 'we@test.local' });
    const event = checkoutSessionEvent({
      id: 'evt_webhookevent_1',
      sessionId: 'cs_we_1',
      userId: user.id,
      credits: 1,
    });
    setConstructEventImpl(() => event);

    await POST(makeRequest(JSON.stringify(event), 'sig_ok'));

    const row = await prisma.webhookEvent.findUnique({
      where: { eventId: 'evt_webhookevent_1' },
    });
    expect(row).not.toBeNull();
    expect(row?.type).toBe('checkout.session.completed');
  });

  it('idempotency now uses WebhookEvent, not the Notification table', async () => {
    const user = await createUser({ email: 'we2@test.local' });
    const event = checkoutSessionEvent({
      id: 'evt_no_notif_idem',
      sessionId: 'cs_we2',
      userId: user.id,
      credits: 2,
    });
    setConstructEventImpl(() => event);

    await POST(makeRequest(JSON.stringify(event), 'sig_ok'));

    // No synthetic system user, and no stripe_event: bookkeeping notification.
    const system = await prisma.user.findUnique({
      where: { email: 'system@findtalent.local' },
    });
    expect(system).toBeNull();
    const bookkeeping = await prisma.notification.findFirst({
      where: { type: { startsWith: 'stripe_event:' } },
    });
    expect(bookkeeping).toBeNull();
  });

  it('dunning: payment_failed creates a payment_failed notification', async () => {
    const customerId = 'cus_dunning';
    const user = await createUser({
      email: 'dun@test.local',
      stripeCustomerId: customerId,
    });
    const event = paymentFailedEvent({
      id: 'evt_payment_failed_1',
      invoiceId: 'in_failed_1',
      customerId,
    });
    setConstructEventImpl(() => event);

    const res = await POST(makeRequest(JSON.stringify(event), 'sig_ok'));
    expect(res.status).toBe(200);

    const notif = await prisma.notification.findFirst({
      where: { userId: user.id, type: 'payment_failed' },
    });
    expect(notif).not.toBeNull();
    const payload = notif?.payloadJson as { status?: string; invoiceId?: string };
    expect(payload.status).toBe('past_due');
    expect(payload.invoiceId).toBe('in_failed_1');
  });

  it('an ignored event type still records a claim and is idempotent on retry', async () => {
    const event = {
      id: 'evt_ignored_1',
      object: 'event',
      api_version: '2026-05-27.dahlia',
      created: 1_700_000_000,
      livemode: false,
      pending_webhooks: 0,
      request: null,
      type: 'customer.created',
      data: { object: { id: 'cus_x', object: 'customer' } },
    } as unknown as Stripe.Event;
    setConstructEventImpl(() => event);

    const first = await POST(makeRequest(JSON.stringify(event), 'sig_ok'));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { ignored?: boolean };
    expect(firstBody.ignored).toBe(true);

    // Claim row recorded so retries short-circuit.
    const claim = await prisma.webhookEvent.findUnique({
      where: { eventId: 'evt_ignored_1' },
    });
    expect(claim).not.toBeNull();

    const second = await POST(makeRequest(JSON.stringify(event), 'sig_ok'));
    const secondBody = (await second.json()) as { idempotent?: boolean };
    expect(secondBody.idempotent).toBe(true);
  });

  it('marks the WebhookEvent completed after a successful handle', async () => {
    const user = await createUser({ email: 'done@test.local' });
    const event = checkoutSessionEvent({
      id: 'evt_status_completed',
      sessionId: 'cs_status_1',
      userId: user.id,
      credits: 1,
    });
    setConstructEventImpl(() => event);

    await POST(makeRequest(JSON.stringify(event), 'sig_ok'));

    const row = await prisma.webhookEvent.findUnique({
      where: { eventId: 'evt_status_completed' },
    });
    expect(row?.status).toBe('completed');
  });

  it('P1: re-runs a still-processing claim (crash BEFORE grant) and grants once', async () => {
    // Simulate a prior delivery that claimed the event but crashed before the
    // grant + before marking completed: a 'processing' row, no credits yet.
    const user = await createUser({ email: 'crash1@test.local', purchasedCredits: 0 });
    await prisma.webhookEvent.create({
      data: {
        eventId: 'evt_rerun_nogrant',
        type: 'checkout.session.completed',
        status: 'processing',
      },
    });
    const event = checkoutSessionEvent({
      id: 'evt_rerun_nogrant',
      sessionId: 'cs_rerun_1',
      userId: user.id,
      credits: 4,
    });
    setConstructEventImpl(() => event);

    const res = await POST(makeRequest(JSON.stringify(event), 'sig_ok'));
    expect(res.status).toBe(200);

    // The re-run performed the grant that the crashed attempt never did.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.purchasedCredits).toBe(4);
    const ledger = await prisma.creditTransaction.findMany({ where: { userId: user.id } });
    expect(ledger).toHaveLength(1);
    // And the claim is now completed so further retries short-circuit.
    const row = await prisma.webhookEvent.findUnique({
      where: { eventId: 'evt_rerun_nogrant' },
    });
    expect(row?.status).toBe('completed');
  });

  it('P1: re-runs a still-processing claim (crash AFTER grant) without double-granting', async () => {
    // Simulate a prior delivery that granted the credits (idempotencyKey row
    // written, balance incremented) but crashed before marking completed.
    const user = await createUser({ email: 'crash2@test.local', purchasedCredits: 4 });
    await prisma.webhookEvent.create({
      data: {
        eventId: 'evt_rerun_granted',
        type: 'checkout.session.completed',
        status: 'processing',
      },
    });
    await prisma.creditTransaction.create({
      data: {
        userId: user.id,
        delta: 4,
        reason: 'PURCHASE',
        refId: 'cs_rerun_2',
        idempotencyKey: 'purchase:cs_rerun_2',
      },
    });
    const event = checkoutSessionEvent({
      id: 'evt_rerun_granted',
      sessionId: 'cs_rerun_2',
      userId: user.id,
      credits: 4,
    });
    setConstructEventImpl(() => event);

    const res = await POST(makeRequest(JSON.stringify(event), 'sig_ok'));
    expect(res.status).toBe(200);

    // The idempotencyKey collision makes the re-run's grant a no-op — no double.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.purchasedCredits).toBe(4);
    const ledger = await prisma.creditTransaction.findMany({ where: { userId: user.id } });
    expect(ledger).toHaveLength(1);
    const row = await prisma.webhookEvent.findUnique({
      where: { eventId: 'evt_rerun_granted' },
    });
    expect(row?.status).toBe('completed');
  });

  it('P2: invoice.paid throws 500 when the price has no seeded Plan (misconfig)', async () => {
    const customerId = 'cus_no_plan';
    await createUser({ email: 'noplan@test.local', stripeCustomerId: customerId });
    // No Plan row created for this price id.
    const event = invoicePaidEvent({
      id: 'evt_invoice_no_plan',
      invoiceId: 'in_no_plan',
      customerId,
      priceId: 'price_unseeded',
      periodEnd: 1_800_000_000,
      billingReason: 'subscription_create',
    });
    setConstructEventImpl(() => event);

    const res = await POST(makeRequest(JSON.stringify(event), 'sig_ok'));
    // 500 → Stripe retries instead of silently dropping the paid grant.
    expect(res.status).toBe(500);
    // Claim left at 'processing' so the retry re-runs the handler.
    const row = await prisma.webhookEvent.findUnique({
      where: { eventId: 'evt_invoice_no_plan' },
    });
    expect(row?.status).toBe('processing');
  });

  it('P2: invoice.paid throws 500 when no user maps to the customer (misconfig)', async () => {
    const customerId = 'cus_orphan';
    // Plan exists for the price, but NO user carries this customer id.
    const plan = await createPlan('price_orphan_basic', 2);
    const event = invoicePaidEvent({
      id: 'evt_invoice_orphan',
      invoiceId: 'in_orphan',
      customerId,
      priceId: plan.stripePriceId,
      periodEnd: 1_800_000_000,
      billingReason: 'subscription_create',
    });
    setConstructEventImpl(() => event);

    const res = await POST(makeRequest(JSON.stringify(event), 'sig_ok'));
    expect(res.status).toBe(500);
    const row = await prisma.webhookEvent.findUnique({
      where: { eventId: 'evt_invoice_orphan' },
    });
    expect(row?.status).toBe('processing');
  });

  it('P2: subscription.deleted zeroes the balance and records the exact wipe in the ledger', async () => {
    const customerId = 'cus_cancel';
    const user = await createUser({
      email: 'cancel@test.local',
      stripeCustomerId: customerId,
      creditsBalance: 3,
      purchasedCredits: 5,
    });
    const event = subscriptionDeletedEvent({
      id: 'evt_sub_deleted',
      subscriptionId: 'sub_cancel_1',
      customerId,
    });
    setConstructEventImpl(() => event);

    const res = await POST(makeRequest(JSON.stringify(event), 'sig_ok'));
    expect(res.status).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    // Subscription credits wiped; purchased pack credits untouched.
    expect(after.creditsBalance).toBe(0);
    expect(after.purchasedCredits).toBe(5);
    expect(after.currentPlanId).toBeNull();
    expect(after.subscriptionStatus).toBe('canceled');

    const ledger = await prisma.creditTransaction.findMany({ where: { userId: user.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].delta).toBe(-3);
    expect(ledger[0].refId).toBe('subscription-canceled:sub_cancel_1');
  });
});
