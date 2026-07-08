'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';

import { requireUser } from '@/lib/auth-helpers';
import {
  createSubscriptionCheckout,
  createCreditPackCheckout,
  createPortalSession,
  hasActiveSubscription,
} from '@/lib/stripe/checkout';
import { PLAN_KEYS } from '@/lib/stripe/types';

const planKeySchema = z.object({ planKey: z.enum(PLAN_KEYS) });
const qtySchema = z.object({ quantity: z.coerce.number().int().min(1).max(50) });

function returnUrl(): string {
  const base = process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
  return `${base}/app/projects?billing=success`;
}

const ERROR_URL = '/billing/choose-plan?error=unavailable';

export async function startCheckoutAction(formData: FormData) {
  const user = await requireUser();
  const { planKey } = planKeySchema.parse({ planKey: formData.get('planKey') });
  let url: string | null = null;
  try {
    // Guard against a SECOND parallel subscription: if the user already has a
    // live subscription, a fresh subscription-mode Checkout would create a new
    // one ALONGSIDE it (double billing + credit clobbering). Send them to the
    // billing portal's plan-switch flow, which PRORATES the existing
    // subscription instead of starting a parallel one.
    if (await hasActiveSubscription(user.id)) {
      url = (
        await createPortalSession(user.id, returnUrl(), {
          flow: 'subscription_update',
        })
      ).url;
    } else {
      url = (await createSubscriptionCheckout(user.id, planKey, returnUrl())).url;
    }
  } catch (err) {
    // Never surface the raw Stripe error (it can include the API key) to the
    // client. Log server-side, send the user back with a friendly notice.
    // eslint-disable-next-line no-console
    console.error('[checkout] subscription failed:', err instanceof Error ? err.message : 'unknown');
  }
  redirect(url ?? ERROR_URL);
}

export async function startCreditPackAction(formData: FormData) {
  const user = await requireUser();
  const { quantity } = qtySchema.parse({ quantity: formData.get('quantity') });
  let url: string | null = null;
  try {
    url = (await createCreditPackCheckout(user.id, quantity, returnUrl())).url;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[checkout] credit pack failed:', err instanceof Error ? err.message : 'unknown');
  }
  redirect(url ?? ERROR_URL);
}
