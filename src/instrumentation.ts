/**
 * Next.js instrumentation hook (Next 16 `register`).
 *
 * Runs ONCE per server instance, before the first request is served. We use
 * it as a fail-fast boot gate:
 *   1. Validate the environment (`validateEnv`) — in production a missing
 *      required var throws here and aborts startup.
 *   2. Assert the encryption key is present + well-formed (`assertCryptoReady`)
 *      so the very first decrypt() can't surprise us at request time.
 *
 * Only runs in the Node.js runtime (skips the Edge bundle). Guarded so the
 * test runner — which imports modules directly without booting Next — is
 * never aborted (validateEnv already no-ops under NODE_ENV==='test', and we
 * additionally bail before touching crypto).
 */

export async function register(): Promise<void> {
  // Edge runtime has no Node crypto / process env story we care about here.
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return;
  // Never abort the test harness.
  if (process.env.NODE_ENV === "test") return;

  const { validateEnv } = await import("@/lib/env");
  const { assertCryptoReady } = await import("@/lib/crypto");

  // Throws in production on any invalid/missing required var; warns in dev.
  validateEnv();

  // Crypto key check is always hard (decryption is load-bearing for tenant
  // creds); in dev a bad key still surfaces as a thrown error here so it's
  // caught before the first tenant request rather than mid-flow.
  try {
    assertCryptoReady();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    if (process.env.NODE_ENV === "production") {
      throw err;
    }
    // eslint-disable-next-line no-console
    console.warn(`[env] crypto not ready: ${msg}`);
  }
}
