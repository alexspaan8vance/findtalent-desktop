# syntax=docker/dockerfile:1.6
# ----------------------------------------------------------------------------
# Multi-stage build for findtalent (Next.js 16 standalone + Prisma 6 + SQLite).
# Produces a slim runtime image (~250MB) with the standalone server bundle.
# ----------------------------------------------------------------------------

# ---- deps ------------------------------------------------------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app

# OpenSSL is needed by Prisma engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# ---- builder ---------------------------------------------------------------
FROM node:24-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time env defaults (overridable at runtime).
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# Prisma needs DATABASE_URL at generate time, but the actual value at runtime
# may differ — placeholder is fine for schema generation.
ENV DATABASE_URL="file:/data/findtalent.db"

# Stripe client throws at import if key missing; build only collects routes.
ENV STRIPE_SECRET_KEY="sk_test_placeholder_build_only"
RUN npx prisma generate
RUN npm run build

# ---- runner ----------------------------------------------------------------
FROM node:24-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && addgroup --system --gid 1001 nodejs \
  && adduser  --system --uid 1001 nextjs

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATABASE_URL="file:/data/findtalent.db"

# Standalone server bundle (next/standalone has minimal deps inlined).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Prisma assets (schema + generated client) + migrations + the seed scripts.
# scripts/* import from ../src (db.ts, crypto.ts, stripe/plans.ts, ...) via tsx
# at runtime, so src/ must ship too — without it every script in scripts/
# (bootstrap-admin, stripe-seed, saved-search-tick, add-pool, ...) crashes with
# MODULE_NOT_FOUND the moment it's run inside this image.
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=nextjs:nodejs /app/messages ./messages

# Entry point applies migrations + boots the server.
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

VOLUME ["/data"]
EXPOSE 3000

USER nextjs
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
