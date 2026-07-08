/**
 * Shared auth guard for the scheduled `/api/cron/*` route handlers.
 *
 * Deploy target is a single-instance Docker container (NOT Vercel): the crons
 * are invoked by a host cron job / systemd timer over HTTP, so they must be
 * protected by a shared secret rather than relying on platform-level auth.
 *
 * Contract:
 *   - `CRON_SECRET` UNSET  → 503 (refuse — never open by default).
 *   - `Authorization` header != `Bearer <CRON_SECRET>` → 401.
 *   - match → `{ ok: true }`.
 *
 * The comparison is constant-time to avoid leaking the secret via timing.
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/** Constant-time string compare that tolerates length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual requires equal-length buffers; hash-free length guard.
  if (ab.length !== bb.length) {
    // Still do a compare against self to keep timing roughly uniform.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export type CronAuthResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

/**
 * Authorize a cron request. Returns `{ ok: true }` on success, or a ready-made
 * JSON error response (401/503) to return directly.
 */
export function authorizeCron(req: Request): CronAuthResult {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "cron_disabled" },
        { status: 503 },
      ),
    };
  }

  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (!safeEqual(header, expected)) {
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }),
    };
  }

  return { ok: true };
}
