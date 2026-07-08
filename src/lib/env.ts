/**
 * Boot-time environment validation.
 *
 * A single Zod schema describes every env var the server actually reads
 * (see `grep process.env src/`). `validateEnv()` is invoked once from
 * `src/instrumentation.ts` (Next's `register` hook) so a misconfigured
 * PRODUCTION deploy fails fast instead of 500-ing on the first request.
 *
 * Behaviour:
 *   - production: a missing/invalid REQUIRED var throws (fail-fast).
 *   - development: the same problems only warn (keeps `next dev` usable).
 *   - test: never throws and never warns — vitest seeds dummy secrets in
 *     `tests/setup.ts`, and we must not pollute test output or abort runs.
 *
 * Security: this module NEVER logs the value of any secret. Error/warn
 * output references variable NAMES only.
 */

import { z } from "zod";

/** base64 string that decodes to exactly 32 bytes (AES-256 key). */
const base64Key32 = z
  .string()
  .min(1, "must be set")
  .refine(
    (raw) => {
      try {
        return Buffer.from(raw, "base64").length === 32;
      } catch {
        return false;
      }
    },
    { message: "must be base64 that decodes to exactly 32 bytes" },
  );

const optionalUrl = z
  .string()
  .url("must be a valid URL")
  .optional()
  .or(z.literal("").transform(() => undefined));

/**
 * An optional non-empty string that treats an EMPTY value as "not configured".
 * Deploy `.env` files routinely ship keys with empty values (e.g. `RESEND_API_KEY=`)
 * as placeholders; a bare `.min(1).optional()` only skips `undefined`, so an empty
 * string would fail `.min(1)` and crash boot validation for an integration that is
 * meant to be optional. Mapping "" → undefined keeps those integrations truly
 * optional (they degrade gracefully at their use sites).
 */
const optionalStr = z
  .string()
  .min(1)
  .optional()
  .or(z.literal("").transform(() => undefined));

/**
 * The schema. Required vars use plain validators; optional integrations
 * (Stripe / Resend / Upstash) are `.optional()` but, where they come in
 * pairs, a `.superRefine` enforces all-or-nothing so we never half-wire an
 * integration.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    // --- required core ---
    DATABASE_URL: z.string().min(1, "must be set"),
    AUTH_SECRET: z.string().min(16, "must be at least 16 chars"),
    ENCRYPTION_KEY: base64Key32,
    NEXTAUTH_URL: z.string().url("must be a valid URL"),

    // --- optional: Stripe (billing) ---
    STRIPE_SECRET_KEY: optionalStr,
    STRIPE_WEBHOOK_SECRET: optionalStr,

    // --- optional: Resend (transactional email) ---
    RESEND_API_KEY: optionalStr,
    MAIL_FROM: optionalStr,

    // --- optional: Upstash (multi-instance rate-limit + token cache) ---
    UPSTASH_REDIS_REST_URL: optionalUrl,
    UPSTASH_REDIS_REST_TOKEN: optionalStr,

    // --- optional: 8vance default credentials ---
    // Two historical spellings exist: code reads VANCE_PROD_*, while the
    // Docker deploy (docker-compose.yml / scripts/bootstrap-admin.ts) ships
    // EIGHTVANCE_CLIENT_ID/SECRET. Both are declared here and reconciled by
    // {@link defaultVanceCredentials} (VANCE_PROD_* wins, EIGHTVANCE_* is the
    // fallback) so a compose-configured deploy is not reported 'unconfigured'.
    VANCE_PROD_CLIENT_ID: optionalStr,
    VANCE_PROD_CLIENT_SECRET: optionalStr,
    EIGHTVANCE_CLIENT_ID: optionalStr,
    EIGHTVANCE_CLIENT_SECRET: optionalStr,
    // Default taxonomy locale for 8vance reference-data reads (skill /
    // function-name / education-degree names). 8vance stores one row per
    // (concept × locale); the talent sub-resource GETs return the talent's
    // stored locale (often German), so we RESOLVE taxonomy ids → names via the
    // /resources/*/ endpoints which honour `?lang`. Defaults to 'en' so names
    // render in English regardless of the talent's stored locale. Read with a
    // default at the use site (client.ts), so absence never fails boot.
    EIGHTVANCE_LANG: optionalStr,

    // --- optional: CV parsing / AI extraction (candidate onboarding) ---
    // ANTHROPIC_API_KEY preferred, OPENAI_API_KEY fallback (see cv-ai.ts).
    // EIGHTVANCE_CV_PARSER_TOKEN drives the 8vance CV parser (cv-parser-8vance.ts).
    // All optional: absent → the relevant extraction path degrades gracefully,
    // so a prod deploy without them must not fail boot validation.
    ANTHROPIC_API_KEY: optionalStr,
    OPENAI_API_KEY: optionalStr,
    EIGHTVANCE_CV_PARSER_TOKEN: optionalStr,
    // Tuning knobs (read with defaults at their use sites).
    CV_PARSER_TIMEOUT_MS: optionalStr,
    CANDIDATE_MATCH_ENRICH_LIMIT: optionalStr,
    // Feature flag: the human-in-the-loop CV-suggestions review panel on the
    // candidate match screen (see match/suggestions-panel.tsx). Default OFF —
    // only `CV_SUGGESTIONS=true` renders the panel. Read at the use site
    // (page.tsx) so a runtime env change is honoured without a boot re-validate.
    CV_SUGGESTIONS: optionalStr,

    // --- optional: observability + scheduled crons ---
    // SENTRY_DSN: when set AND `@sentry/nextjs` is installed, reportError()
    // forwards events (dynamic import — package is an optional peer, never a
    // hard dependency). Absent → reportError() still logs structured to stderr.
    // CRON_SECRET: shared bearer token guarding /api/cron/* routes (host cron /
    // systemd timer hits them over HTTP). Unset → cron routes refuse with 503,
    // so they are never open by default.
    SENTRY_DSN: optionalStr,
    CRON_SECRET: optionalStr,

    // --- optional: signup gating ---
    // Comma-separated email domains allowed to self-register (e.g.
    // "8vance.com"). Unset in production → signup is DISABLED (fail-closed;
    // the app fronts a public Funnel URL). Unset outside production → open
    // (local dev). See src/lib/signup-policy.ts — read at the use site so a
    // runtime change is honoured without a boot re-validate.
    SIGNUP_ALLOWED_DOMAINS: optionalStr,

    // --- optional branding / misc (read with sane defaults elsewhere) ---
    BRAND_NAME: z.string().optional(),
    BRAND_SUPPORT_EMAIL: z.string().optional(),
    TENANT_SLUG: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // Stripe is all-or-nothing.
    const stripeKeys = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const;
    const stripeSet = stripeKeys.filter((k) => !!env[k]);
    if (stripeSet.length === 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Stripe is half-configured: set BOTH STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, or neither.",
        path: ["STRIPE_SECRET_KEY"],
      });
    }
    // Upstash REST url+token must be set together.
    const upstashKeys = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] as const;
    const upstashSet = upstashKeys.filter((k) => !!env[k]);
    if (upstashSet.length === 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Upstash is half-configured: set BOTH UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, or neither.",
        path: ["UPSTASH_REDIS_REST_URL"],
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface ValidateResult {
  ok: boolean;
  /** Variable-name-only problem descriptions (never includes values). */
  problems: string[];
  env?: Env;
}

/**
 * Parse `source` (defaults to `process.env`) against {@link envSchema}.
 * Pure — never throws, never logs. Callers decide how to react.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): ValidateResult {
  const result = envSchema.safeParse(source);
  if (result.success) {
    return { ok: true, problems: [], env: result.data };
  }
  // Map issues to "VAR_NAME: message" — never echo the offending value.
  const problems = result.error.issues.map((issue) => {
    const name = issue.path.length > 0 ? String(issue.path[0]) : "(root)";
    return `${name}: ${issue.message}`;
  });
  return { ok: false, problems };
}

/**
 * Validate `process.env` and react per-environment:
 *   - production: throw on any problem (fail-fast).
 *   - development: console.warn the problems, continue.
 *   - test: silent no-op (return success-ish without touching output).
 *
 * Idempotent and cheap; safe to call from the instrumentation hook.
 */
export function validateEnv(source: NodeJS.ProcessEnv = process.env): ValidateResult {
  const nodeEnv = source.NODE_ENV ?? "development";
  if (nodeEnv === "test") {
    // Don't crash or spam tests; the harness seeds its own dummy secrets.
    return { ok: true, problems: [] };
  }

  const result = parseEnv(source);
  if (result.ok) return result;

  const header = "[env] invalid environment configuration:";
  if (nodeEnv === "production") {
    throw new Error(`${header}\n  - ${result.problems.join("\n  - ")}`);
  }
  // development → warn only.
  // eslint-disable-next-line no-console
  console.warn(`${header}\n  - ${result.problems.join("\n  - ")}`);
  return result;
}

/**
 * Resolve the deploy-default 8vance client credentials, reconciling the two
 * env spellings: `VANCE_PROD_CLIENT_ID/SECRET` (canonical in code) with
 * `EIGHTVANCE_CLIENT_ID/SECRET` (what the Docker compose deploy sets) as a
 * fallback per field. Empty strings count as unset. Every consumer of the
 * default credentials should go through this helper rather than reading
 * `process.env.VANCE_PROD_*` directly.
 */
export function defaultVanceCredentials(
  source: NodeJS.ProcessEnv = process.env,
): { clientId?: string; clientSecret?: string } {
  const pick = (...vals: Array<string | undefined>): string | undefined => {
    for (const v of vals) {
      if (typeof v === "string" && v.length > 0) return v;
    }
    return undefined;
  };
  return {
    clientId: pick(source.VANCE_PROD_CLIENT_ID, source.EIGHTVANCE_CLIENT_ID),
    clientSecret: pick(
      source.VANCE_PROD_CLIENT_SECRET,
      source.EIGHTVANCE_CLIENT_SECRET,
    ),
  };
}
