import Stripe from 'stripe';

const apiKey = process.env.STRIPE_SECRET_KEY;
if (!apiKey) {
  throw new Error(
    'STRIPE_SECRET_KEY is not set. Stripe client cannot be initialised.',
  );
}

declare global {
  // eslint-disable-next-line no-var
  var __stripe: Stripe | undefined;
}

export const stripe: Stripe =
  global.__stripe ??
  new Stripe(apiKey, {
    typescript: true,
    appInfo: { name: 'findtalent', version: '0.1.0' },
  });

if (process.env.NODE_ENV !== 'production') {
  global.__stripe = stripe;
}
