/**
 * Pluggable error-reporting seam.
 *
 * Today errors only reach `console.*`. This module centralizes them behind
 * `reportError()` / `reportMessage()` so we get one structured, secret-safe
 * sink that can ALSO forward to Sentry — without making `@sentry/nextjs` a
 * hard dependency.
 *
 * Behaviour:
 *   - ALWAYS logs a single structured line to stderr (tag + safe context).
 *     Never logs secrets / PII — context is redacted (see `redact`).
 *   - When `SENTRY_DSN` is set AND `@sentry/nextjs` is importable, the event is
 *     ALSO forwarded via a DYNAMIC import. The package is treated as an
 *     OPTIONAL peer: it is NOT in package.json, and this file compiles + runs
 *     fine without it (the import is wrapped in `.catch(() => null)`).
 *
 * Security: callers pass arbitrary `context`; we redact obviously-sensitive
 * keys and truncate/strip values so nothing leaks into logs or Sentry.
 */

const TAG = "[report]";

/** Free-form structured context attached to a report. */
export type ReportContext = Record<string, unknown>;

/**
 * Key fragments that mark a value as sensitive. Matched case-insensitively as
 * substrings, so `clientSecret`, `api_key`, `authToken`, `password`,
 * `set-cookie` etc. are all caught.
 */
const SENSITIVE_KEY_PATTERNS = [
  "secret",
  "token",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "authorization",
  "auth",
  "cookie",
  "credential",
  "client_secret",
  "clientsecret",
  "key",
  "dsn",
  "ssn",
  "email", // PII — never log raw addresses
  "phone",
];

const REDACTED = "[redacted]";
const MAX_STRING = 500;
const MAX_DEPTH = 4;

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => k.includes(p));
}

/**
 * Recursively produce a log-safe copy of `value`:
 *   - sensitive-named keys → `[redacted]`
 *   - long strings truncated
 *   - depth/cycles bounded
 * Returns plain JSON-serializable data.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;

  if (depth >= MAX_DEPTH) return "[…]";

  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return value.slice(0, 50).map((v) => redact(v, depth + 1, seen));
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return "[circular]";
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1, seen);
    }
    return out;
  }
  return undefined;
}

/** Normalize an unknown thrown value into a name/message/stack triple. */
function describeError(err: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: "NonError", message: typeof err === "string" ? err : safeStringify(err) };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Forward to Sentry when configured + installed. Best-effort and fully
 * optional: the dynamic import resolves to `null` if the package is absent, so
 * nothing here can crash the caller or require the dependency.
 */
async function forwardToSentry(
  fn: (sentry: SentryLike) => void,
): Promise<void> {
  if (!process.env.SENTRY_DSN) return;
  // Dynamic, optional-peer import. `@sentry/nextjs` is intentionally NOT a
  // declared dependency — if it's not installed this resolves to null. The
  // specifier is held in a variable so `tsc` doesn't try to resolve the
  // (absent) module's types; runtime resolution is what matters here.
  const SENTRY_MODULE = "@sentry/nextjs";
  const mod = await import(/* webpackIgnore: true */ SENTRY_MODULE).catch(() => null);
  if (!mod) return;
  try {
    fn(mod as unknown as SentryLike);
  } catch {
    // Never let the reporter itself throw.
  }
}

/** Minimal surface of `@sentry/nextjs` we use (kept local to avoid the dep). */
interface SentryLike {
  captureException(err: unknown, hint?: { extra?: Record<string, unknown> }): void;
  captureMessage(
    message: string,
    hint?: { level?: string; extra?: Record<string, unknown> },
  ): void;
}

/**
 * Report an error. ALWAYS logs structured to stderr; ALSO forwards to Sentry
 * when configured. Fire-and-forget — never throws, never awaited by callers.
 */
export function reportError(err: unknown, context?: ReportContext): void {
  const info = describeError(err);
  const safeContext = context ? (redact(context) as Record<string, unknown>) : undefined;

  // eslint-disable-next-line no-console
  console.error(TAG, {
    level: "error",
    name: info.name,
    message: info.message,
    ...(safeContext ? { context: safeContext } : {}),
    ...(info.stack ? { stack: info.stack } : {}),
  });

  // Best-effort async forward; intentionally not awaited.
  void forwardToSentry((sentry) => {
    sentry.captureException(err, safeContext ? { extra: safeContext } : undefined);
  });
}

/**
 * Report a non-error message (e.g. a recovered/degraded condition worth
 * tracking). Same structured-log + optional-Sentry behaviour as reportError.
 */
export function reportMessage(
  message: string,
  context?: ReportContext,
  level: "info" | "warning" | "error" = "info",
): void {
  const safeContext = context ? (redact(context) as Record<string, unknown>) : undefined;

  // eslint-disable-next-line no-console
  console.error(TAG, {
    level,
    message,
    ...(safeContext ? { context: safeContext } : {}),
  });

  void forwardToSentry((sentry) => {
    sentry.captureMessage(message, {
      level,
      ...(safeContext ? { extra: safeContext } : {}),
    });
  });
}
