import { z } from 'zod';

/**
 * Metadata shapes attached to Stripe Checkout sessions. We always set
 * `kind` so the webhook handler can route safely without guessing.
 */

export const PLAN_KEYS = ['try', 'basic', 'pro'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export const SubscriptionMetadataSchema = z.object({
  kind: z.literal('subscription'),
  userId: z.string().min(1),
  planKey: z.enum(PLAN_KEYS),
});
export type SubscriptionMetadata = z.infer<typeof SubscriptionMetadataSchema>;

export const CreditPackMetadataSchema = z.object({
  kind: z.literal('credit_pack'),
  userId: z.string().min(1),
  // Stripe metadata values are always strings on the wire; coerce.
  credits: z.coerce.number().int().positive(),
});
export type CreditPackMetadata = z.infer<typeof CreditPackMetadataSchema>;

export const CheckoutMetadataSchema = z.discriminatedUnion('kind', [
  SubscriptionMetadataSchema,
  CreditPackMetadataSchema,
]);
export type CheckoutMetadata = z.infer<typeof CheckoutMetadataSchema>;

export const EXTRA_CREDIT_TIER_KEY = 'extra-credit';
export const FINDTALENT_TIER_METADATA_KEY = 'findtalent_tier';
