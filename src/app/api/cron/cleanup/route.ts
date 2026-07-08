/**
 * Scheduled data-retention cleanup.
 *
 * Invoked by a host cron / systemd timer (single-instance Docker — NOT Vercel)
 * over HTTP, guarded by the shared `CRON_SECRET` bearer (see authorizeCron).
 *
 * RETENTION SCHEDULE
 * ------------------
 *   Match              expiresAt < now                  — cached, anonymized
 *                                                          match rows past their
 *                                                          TTL; safe to drop, get
 *                                                          re-hydrated on demand.
 *   Notification       readAt != null AND
 *                      createdAt < now - 90d            — already-read in-app
 *                                                          notifications older
 *                                                          than 90 days.
 *   RevealLock         expiresAt < now - 30d            — long-expired reveal
 *                                                          locks (kept 30d past
 *                                                          expiry as an audit
 *                                                          grace window).
 *   CandidateMatchRun  status MATCHING, stale           — orphaned async match
 *                                                          runs marked FAILED via
 *                                                          the existing sweep
 *                                                          (no delete: keeps the
 *                                                          run history visible).
 *
 * Returns JSON `{ ok, <counts> }`. Idempotent: re-running deletes nothing extra.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { authorizeCron } from "@/lib/observability/cron-auth";
import { reportError } from "@/lib/observability/report";
import { sweepStaleRuns } from "@/lib/candidate/service";
import { sweepStaleProjectPools } from "@/lib/eightvance/job-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOTIFICATION_RETENTION_DAYS = 90;
const REVEAL_LOCK_GRACE_DAYS = 30;

async function handle(req: Request): Promise<NextResponse> {
  const auth = authorizeCron(req);
  if (!auth.ok) return auth.response;

  const now = Date.now();
  const notificationCutoff = new Date(now - NOTIFICATION_RETENTION_DAYS * DAY_MS);
  const revealLockCutoff = new Date(now - REVEAL_LOCK_GRACE_DAYS * DAY_MS);

  try {
    // A Match row is "cache" — UNLESS the recruiter has built durable state on
    // top of it. `ShortlistEntry.match` is onDelete:Cascade, so deleting an
    // expired Match would silently destroy the recruiter's pipeline state
    // (stage/favorite/note/appliedAt). And an active Reveal (its decrypted PII)
    // is keyed by (projectId,tenantId,eightvanceTalentId) with no FK to Match,
    // so we must not drop the Match that backs a live reveal either. Protect
    // both: only delete expired Matches that have NO ShortlistEntry AND are not
    // referenced by a non-expired Reveal.
    const activeReveals = await prisma.reveal.findMany({
      where: { expiresAt: { gt: new Date(now) } },
      select: { projectId: true, tenantId: true, eightvanceTalentId: true },
    });
    const protectedMatchIds = activeReveals.length
      ? (
          await prisma.match.findMany({
            where: {
              OR: activeReveals.map((r) => ({
                projectId: r.projectId,
                tenantId: r.tenantId,
                eightvanceTalentId: r.eightvanceTalentId,
              })),
            },
            select: { id: true },
          })
        ).map((m) => m.id)
      : [];

    const [
      expiredMatches,
      oldNotifications,
      expiredRevealLocks,
      staleRuns,
      staleProjectPools,
    ] = await Promise.all([
        prisma.match.deleteMany({
          where: {
            expiresAt: { lt: new Date(now) },
            shortlistEntries: { none: {} },
            id: { notIn: protectedMatchIds },
          },
        }),
        prisma.notification.deleteMany({
          where: {
            readAt: { not: null },
            createdAt: { lt: notificationCutoff },
          },
        }),
        prisma.revealLock.deleteMany({
          where: { expiresAt: { lt: revealLockCutoff } },
        }),
        // Reuse the existing orphan-recovery sweep (marks stuck MATCHING runs
        // FAILED) rather than deleting — keeps run history intact.
        sweepStaleRuns(),
        // Same for wedged PROJECT pools (async task never completed) so a
        // project nobody has re-opened still settles instead of spinning forever.
        sweepStaleProjectPools(),
      ]);

    // TODO(billing-reconciliation): add a periodic ledger-vs-balance reconcile
    // here. For each user assert sum(CreditTransaction.delta) grouped by bucket
    // == { creditsBalance + purchasedCredits } (accounting for the
    // use-it-or-lose-it subscription reset), and reportError on any drift so a
    // silently-diverging ledger is caught. Also sweep WebhookEvent rows stuck in
    // status='processing' past Stripe's retry window (never reached
    // 'completed') for alerting. Out of scope for this pass — left as a marker.

    return NextResponse.json({
      ok: true,
      expiredMatches: expiredMatches.count,
      oldNotifications: oldNotifications.count,
      expiredRevealLocks: expiredRevealLocks.count,
      staleRunsFailed: staleRuns,
      staleProjectPoolsFailed: staleProjectPools,
    });
  } catch (err) {
    reportError(err, { area: "cron.cleanup" });
    return NextResponse.json({ ok: false, error: "cleanup_failed" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
