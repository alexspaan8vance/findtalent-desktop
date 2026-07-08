/**
 * Scheduled inbound-applications ingest.
 *
 * Invoked by a host cron / systemd timer (single-instance Docker — NOT Vercel)
 * over HTTP, guarded by the shared `CRON_SECRET` bearer (see authorizeCron).
 *
 * Loops every ACTIVE project (not DRAFT/CLOSED/ARCHIVED) and runs
 * `ingestApplicationsForProject` — reading `direction=1` feedback for each
 * pool's 8vance job and auto-adding own-pool applicants to the pipeline at the
 * Inflow stage with a free (0-credit) application reveal. Best-effort per
 * project: one project's failure never sinks the sweep.
 *
 * Returns JSON `{ ok, projects, added, skipped, errors }`. Idempotent: a second
 * run adds nothing for applicants already in the pipeline.
 */

import { NextResponse } from 'next/server';

import { prisma } from '@/lib/db';
import { authorizeCron } from '@/lib/observability/cron-auth';
import { reportError } from '@/lib/observability/report';
import { ingestApplicationsForProject } from '@/lib/applications/ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(req: Request): Promise<NextResponse> {
  const auth = authorizeCron(req);
  if (!auth.ok) return auth.response;

  try {
    // Only ACTIVE projects: skip DRAFT (no published job yet) + CLOSED/ARCHIVED
    // (ingest is a no-op there anyway, but skipping saves the 8vance calls).
    const projects = await prisma.project.findMany({
      where: { status: { in: ['MATCHING', 'READY', 'FAILED'] } },
      select: { id: true },
    });

    let added = 0;
    let skipped = 0;
    let errors = 0;
    for (const p of projects) {
      try {
        const r = await ingestApplicationsForProject(p.id);
        added += r.added;
        skipped += r.skipped;
        errors += r.errors;
      } catch (err) {
        errors += 1;
        reportError(err, { area: 'cron.applications', projectId: p.id });
      }
    }

    return NextResponse.json({
      ok: true,
      projects: projects.length,
      added,
      skipped,
      errors,
    });
  } catch (err) {
    reportError(err, { area: 'cron.applications' });
    return NextResponse.json({ ok: false, error: 'applications_failed' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
