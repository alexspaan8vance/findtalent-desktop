# findtalent

Anonymous talent matching SaaS on top of the 8vance API. Whitelabel B2B —
deployed per customer (e.g. `findtalent.ukraine2work.nl`). Behind one
deploy you can configure **one or more 8vance talent pools** (multi-pool):
when a customer creates a project they pick the pool(s) to match against,
each pool runs its own 8vance job + async-match task, and candidates from
every pool flow into the same shortlist tagged with their source pool.
Access is gated behind Stripe billing. Candidates appear anonymized;
spending a credit reveals a single candidate with 14-day exclusive access
(lock is per-pool).

Built as a Next.js 16 fullstack app: App Router, TypeScript strict, Prisma 6
(SQLite for dev, swap to Postgres for prod), Auth.js v5 (credentials),
Stripe (subscriptions + extra-credits packs), Resend (transactional email),
next-intl (NL/EN).

## Quick start

```bash
# 1. Install deps
npm install

# 2. Generate secrets
cp .env.example .env
node -e "console.log('ENCRYPTION_KEY=\"' + require('crypto').randomBytes(32).toString('base64') + '\"\nAUTH_SECRET=\"' + require('crypto').randomBytes(32).toString('base64') + '\"')" >> .env

# Then edit .env and set:
#   EIGHTVANCE_CLIENT_ID, EIGHTVANCE_CLIENT_SECRET, EIGHTVANCE_COMPANY_ID
#   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
#   RESEND_API_KEY, MAIL_FROM
#   TENANT_SLUG (e.g. "ivta")

# 3. Apply DB migrations
npx prisma migrate deploy
# Or for development:
npx prisma migrate dev

# 4. Seed Stripe products + Plan rows (requires live STRIPE_SECRET_KEY)
npm run stripe:seed

# 5. Bootstrap your first admin user + tenant
npx tsx scripts/bootstrap-admin.ts admin@example.com 'StrongPassword!'

# 6. Run
npm run dev
```

Open <http://localhost:3000>. Log in with the admin email/password you just
created. Customers can sign up at `/signup`.

## Scripts

- `npm run dev` — Next.js dev server (Turbopack).
- `npm run build` — production build.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run test` — vitest run (58 tests).
- `npm run prisma:migrate` / `prisma:studio` — DB helpers.
- `npm run stripe:seed` — create Stripe products + prices + Plan rows.
- `npx tsx scripts/saved-search-tick.ts` — periodic saved-search runner
  (wire to a host cron).

## Architecture

Multi-pool model: a `Project` has many `ProjectPool` rows (one per
selected `Tenant`). Each pool stores its own `eightvanceJobId` +
`eightvanceTaskId` and runs its match task independently. `Match` and
`Reveal` rows carry `tenantId` so locks and pool labels stay scoped.

```
src/
  app/
    page.tsx                      — public landing
    (auth)/                       — login + signup
    (app)/                        — authenticated customer surface
      projects/                   — project list + create wizard (multi-pool) + shortlist + reveal
      settings/                   — account, billing, delete account
    admin/                        — super-admin (companies = pools, users, plans, audit)
    billing/                      — choose-plan + Stripe portal redirect
    api/
      auth/[...nextauth]/         — Auth.js handler
      webhooks/stripe/            — webhook (signature-verified)
      refdata/{skill,location,…}/ — auth-gated 8vance reference-data proxies (tenantId-scoped)
      tenants/list/               — list available pools for the wizard
      reveals/                    — POST a reveal (credit-spend)
      account/export/             — AVG data export
      health/                     — DB ping
  lib/
    eightvance/                   — 8vance API client port (token bucket, gate, types)
    anonymize/                    — PII strip + assertNoPII runtime check
    match/                        — match-task poller + hydrate
    reveal/                       — 14-day exclusive lock + credit-spend
    stripe/                       — checkout + webhook helpers + plans
    saved-search/                 — cron job for new-match notifications
    brand/                        — whitelabel branding (env-driven)
    crypto.ts                     — AES-256-GCM for tenant secrets + PII payloads
    credits.ts                    — credit ledger
    db.ts                         — Prisma singleton
    auth-helpers.ts               — requireUser / requireAdmin / hashPassword
    email.ts                      — Resend wrapper
  auth.ts                         — Auth.js full config (node)
  auth.config.ts                  — Auth.js edge-safe config (middleware)
  middleware.ts                   — route gating + security headers
  i18n/                           — next-intl config (cookie-based locale)
prisma/
  schema.prisma                   — Tenant, User, Project, Match, Reveal, Plan, …
  migrations/                     — versioned schema
messages/
  en.json, nl.json                — i18n strings
tests/                            — vitest (anonymize, crypto, credits, lock, job-sync, eightvance, stripe)
docs/                             — (in repo root, plus 8vance contract refs)
```

## Security model

- 8vance client secrets per tenant stored in `Tenant.eightvanceClientSecretEnc`,
  encrypted with AES-256-GCM via `ENCRYPTION_KEY`. Never logged.
- Reveal PII payloads stored encrypted in `Reveal.piiPayloadEnc`. Decrypted
  on demand only when displaying to the owning customer.
- `CompanyIdGate` in the 8vance client refuses any response that would
  egress data for a non-allow-listed `company_id` — defense in depth vs
  prompt injection or misconfiguration.
- All API routes go through Auth.js middleware; admin routes additionally
  require `role === 'ADMIN'`.
- CSP, HSTS (prod), Referrer-Policy, X-Frame-Options, X-Content-Type-Options
  and Permissions-Policy set on every response in `src/middleware.ts`.
- Stripe webhook signature is verified with `STRIPE_WEBHOOK_SECRET` before
  any DB write; events are idempotent via a `Notification` row keyed by
  event id.

## Anonymization

Strong mode (default). For each talent we cache an `AnonymizedTalent` that
contains:

- Skills with proficiency stars + `must_have_match` / `gap` flags vs the
  project requirements.
- Up to 3 most-recent work experience entries: `function_title` + broad
  `sector` (NACE-ish bucket) + `duration_bucket` (`<1y`, `1-3y`, `3-5y`,
  `5-10y`, `10+y`) + `is_current`. No employer names.
- Education: only `level` (MBO/HBO/WO/...) + `field_of_study_category`. No
  school names, no graduation years.
- Languages with speak level (`basic` / `business` / `native`).
- Location: only `province` + `country`. No city, no postal code, no
  lat/lon.
- Bucketed totals: `total_years_experience_bucket`, `hours_per_week_bucket`,
  `start_within_days`.
- A stable `opaque_id` (sha256 of tenant + talent + secret) so the frontend
  can re-open a card without leaking 8vance ids.

A runtime `assertNoPII()` walks the JSON of every Match payload as a
defense-in-depth check against future regressions.

## Tests

```
npm run test       # unit (vitest)
npm run e2e        # end-to-end (Playwright, real 8vance match)
npm run e2e:report # open the HTML report
```

The E2E suite (`e2e/`) seeds its own SQLite DB (`prisma/e2e.db`) with an
admin, a funded customer, the IVTA pool (from your `.env` 8vance creds)
and a bogus second pool, then walks: public pages → auth → admin CRUD →
project wizard → REAL async match against the IVTA pool → anonymized
shortlist (PII leak assertions) → reveal with credit spend → lock
enforcement → billing UI → visual screenshot sweep (`e2e-screenshots/`).

Tests cover the 8vance client (token cache, retry, gate), anonymizer
(snapshot + property test for PII leakage), AES crypto (roundtrip + tamper
detection), credit ledger (transactional spend + insufficient + grant),
reveal lock (cross-tenant isolation, race refund, idempotent re-acquire),
Stripe webhook (signature, credit-pack grant, invoice.paid grant,
idempotency), and the job-sync precondition gate.

## Plan

The implementation plan and design notes live at
`~/.claude/plans/ik-wil-een-tool-shiny-parnas.md`.
