# Deployment guide — findtalent (whitelabel)

This is a self-host whitelabel deploy: one running instance is one
customer's brand at one domain. Each instance can be configured with
**one or more 8vance talent pools** — the bootstrap script seeds a
default pool from `.env`, and admins can add more from `/admin/companies`
at any time without restarting the app. Customers then choose which
pool(s) each project matches against during the create-project wizard.

Two deploy options below: **Docker (recommended)** or **bare Node**.

---

## 1. Prerequisites

- A domain you control (e.g. `findtalent.yourcompany.nl`) with TLS
  termination (Caddy, Nginx, Cloudflare, Vercel).
- 8vance API credentials for the company whose talent pool you want to
  expose. Get them from your 8vance contact:
  - `client_id`
  - `client_secret`
  - numeric `company_id`
- Stripe account (test mode is fine for the first dry-run) with:
  - secret key (`sk_test_...` or `sk_live_...`)
  - webhook signing secret (`whsec_...`)
- Resend account + verified sender domain for transactional email.
- A 32-byte random `ENCRYPTION_KEY` and a 32-byte `AUTH_SECRET`
  (instructions below).

## 2. Configure `.env`

Copy `.env.example` to `.env` and fill in. Minimum required keys:

```sh
# Generate fresh secrets
node -e "console.log('ENCRYPTION_KEY=\"' + require('crypto').randomBytes(32).toString('base64') + '\"\nAUTH_SECRET=\"' + require('crypto').randomBytes(32).toString('base64') + '\"')" >> .env
```

Then edit:

```sh
NEXTAUTH_URL="https://findtalent.yourcompany.nl"
TENANT_SLUG="yourcompany"
EIGHTVANCE_CLIENT_ID="..."
EIGHTVANCE_CLIENT_SECRET="..."
EIGHTVANCE_COMPANY_ID="34231"
STRIPE_SECRET_KEY="sk_live_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
RESEND_API_KEY="re_..."
MAIL_FROM="noreply@yourcompany.nl"
BRAND_NAME="YourCompany Talent"
BRAND_PRIMARY_COLOR="#0f172a"
BRAND_SUPPORT_EMAIL="support@yourcompany.nl"
```

## 3a. Deploy with Docker (recommended)

```sh
docker compose up -d --build
docker compose exec findtalent npx tsx scripts/stripe-seed.ts
docker compose exec findtalent npx tsx scripts/bootstrap-admin.ts \
  you@yourcompany.nl 'StrongAdminPassword!'
```

The container persists the SQLite DB in the named volume `findtalent-data`.
Backups: `docker run --rm -v findtalent-data:/data alpine tar czf - /data > backup.tgz`.

Put a reverse proxy in front for TLS:

```caddy
findtalent.yourcompany.nl {
  reverse_proxy 127.0.0.1:3000
}
```

Stripe webhook URL: `https://findtalent.yourcompany.nl/api/webhooks/stripe`
(copy the signing secret it gives you into `STRIPE_WEBHOOK_SECRET`).

## 3b. Deploy bare Node (no Docker)

Requires Node 24+.

```sh
npm install --omit=dev
npx prisma generate
npx prisma migrate deploy
npm run build
node .next/standalone/server.js
```

Configure your process manager (systemd, pm2) to:
- Start `node /opt/findtalent/.next/standalone/server.js`
- Load env from `/opt/findtalent/.env`
- Restart on crash

Same reverse-proxy step + `bootstrap-admin` + `stripe:seed` as above.

## 4. First login + smoke test

1. Open `https://findtalent.yourcompany.nl/login`
2. Sign in with the admin email + password from step 3.
3. Go to `/admin/companies` — your default talent pool is already
   configured from the bootstrap script (env credentials). To add a
   second pool (e.g. expose another 8vance company's talents through
   this same deploy), click "Add pool" — no env edit, no restart needed.
4. Customers sign up at `/signup`, verify their email (Resend), pick a
   plan at `/billing/choose-plan`, then create a project at
   `/app/projects/new`. The wizard's first step lets them pick one or
   more of the pools you configured above.

## 5. Background jobs (saved-search rerun)

The in-app copy promises customers we re-check "~3× a day". The runner
(`runAllDueSavedSearches`) has its own 8h freshness window, so a cron firing
**every 8 hours** is exactly 3×/day and stays idempotent if it fires more often.
Schedule it every 8h via cron (NOT once a day — that breaks the promise):

```sh
# /etc/cron.d/findtalent  — every 8h = 07:00, 15:00, 23:00 (≈3× a day)
0 7,15,23 * * * findtalent  cd /opt/findtalent && npx tsx scripts/saved-search-tick.ts >> /var/log/findtalent-saved-search.log 2>&1
```

Or with Docker (host crontab calling into the container, every 8h):

```sh
0 7,15,23 * * * root  docker compose -f /opt/findtalent/docker-compose.yml exec -T findtalent npx tsx scripts/saved-search-tick.ts >> /var/log/findtalent-saved-search.log 2>&1
```

Verify it actually runs: tail the log above, or hit the route directly with the
`CRON_SECRET` bearer — `curl -H "Authorization: Bearer $CRON_SECRET" https://findtalent.yourcompany.nl/api/cron/saved-search`
should return `{"ok":true,"ran":N,...}`.

## 6. Whitelabel branding

All branding comes from env. Change without rebuilding:

```sh
BRAND_NAME="Ukraine2Work Talent"
BRAND_PRIMARY_COLOR="#1f6feb"
BRAND_LOGO_URL="https://cdn.yourcompany.nl/logo.svg"
BRAND_SUPPORT_EMAIL="hello@ukraine2work.nl"
```

Then `docker compose restart findtalent` (or systemctl restart).

## 7. Upgrade path

```sh
git pull
docker compose build
docker compose up -d
# Migrations run automatically on container start (docker-entrypoint.sh).
```

## 8. Postgres instead of SQLite (production scale)

Change `DATABASE_URL` in `.env`:

```sh
DATABASE_URL="postgresql://user:pw@host:5432/findtalent?sslmode=require"
```

…and switch the Prisma provider in `prisma/schema.prisma` from `sqlite`
to `postgresql`, then `docker compose run findtalent npx prisma migrate dev --name init-postgres`
once, then `docker compose up -d`.

## 9. Security checklist (before going live)

- [ ] `AUTH_SECRET` + `ENCRYPTION_KEY` are unique per deploy, never
      shared/committed
- [ ] HTTPS only (reverse proxy with valid cert)
- [ ] Stripe webhook secret matches the live signing key
- [ ] `.env` permissions: `chmod 600 .env`
- [ ] Backup the SQLite volume (or Postgres) daily
- [ ] Test reveal lock + credit ledger with `STRIPE_SECRET_KEY=sk_test_...`
      before flipping to live
- [ ] Verify `/privacy` + `/terms` reflect your business name and
      processor list
