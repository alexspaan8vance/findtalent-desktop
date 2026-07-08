/**
 * Small helpers shared across the 8vance client modules. Kept separate so
 * the auth + client modules can both pull in `redact` without circular
 * imports.
 */

const SECRET_KEYS = new Set([
  "client_secret",
  "clientSecret",
  "password",
  "refresh",
  "access",
  "authorization",
  "Authorization",
]);

/**
 * Redact secrets from arbitrary JSON-ish values for log/error output.
 *
 * Memory: `feedback_security_critical` — logs MUST NEVER contain
 * `client_secret` or full `Authorization` headers.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-capped]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // Mask bare bearer tokens / JWT-shaped strings on best-effort basis.
    if (/^Bearer\s+/i.test(value)) return "Bearer [redacted]";
    if (/^eyJ[A-Za-z0-9_-]{10,}\./.test(value)) return "[jwt-redacted]";
    return value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k)) {
      out[k] = "[redacted]";
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

/** Sleep helper (Promise-based setTimeout). */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/** Type-guard: is value a plain JSON object (not array, not null)? */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
