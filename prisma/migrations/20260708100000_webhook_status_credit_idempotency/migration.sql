-- WebhookEvent.status: two-phase claim (processing -> completed) so a crash
-- between the idempotency claim and the credit grant can no longer swallow the
-- grant. Plain additive ALTER (NOT a table rebuild). Backfill every pre-existing
-- row to 'completed' — they were fully processed under the old one-phase claim,
-- so a re-delivery must short-circuit rather than re-run the handler.
ALTER TABLE "WebhookEvent" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'processing';
UPDATE "WebhookEvent" SET "status" = 'completed';

-- CreditTransaction.idempotencyKey: at-most-once grant key across webhook
-- re-runs / Stripe retries (e.g. "purchase:<session_id>", "refund:<session_id>").
-- Nullable; NULLs are distinct in SQLite so existing ledger rows never collide
-- on the unique index.
ALTER TABLE "CreditTransaction" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "CreditTransaction_idempotencyKey_key" ON "CreditTransaction"("idempotencyKey");

-- User.stripeCustomerId is now one-per-user (unique). NULLs stay distinct so
-- users without a Stripe customer are unaffected.
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");
