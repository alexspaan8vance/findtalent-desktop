/**
 * Scheduled saved-search runner.
 *
 * Invoked by a host cron / systemd timer (single-instance Docker — NOT Vercel)
 * over HTTP, guarded by the shared `CRON_SECRET` bearer (see authorizeCron).
 *
 * Drives `runAllDueSavedSearches()` — re-runs every SavedSearch that hasn't run
 * within its cadence window, fires `new_matches` notifications/emails on new
 * candidates, and returns a per-search summary. Recommended cadence: a few
 * times per day (the runner's own 8h freshness window keeps it idempotent).
 *
 * Returns JSON `{ ok, ran, totalNewMatches, notified, results }`.
 */

import { NextResponse } from "next/server";

import { authorizeCron } from "@/lib/observability/cron-auth";
import { reportError } from "@/lib/observability/report";
import { runAllDueSavedSearches } from "@/lib/saved-search/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: Request): Promise<NextResponse> {
  const auth = authorizeCron(req);
  if (!auth.ok) return auth.response;

  try {
    const results = await runAllDueSavedSearches();
    const totalNewMatches = results.reduce((sum, r) => sum + r.newMatchCount, 0);
    const notified = results.filter((r) => r.notified).length;

    return NextResponse.json({
      ok: true,
      ran: results.length,
      totalNewMatches,
      notified,
      results,
    });
  } catch (err) {
    reportError(err, { area: "cron.saved-search" });
    return NextResponse.json({ ok: false, error: "saved_search_failed" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
