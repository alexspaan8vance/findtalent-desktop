/**
 * Saved-search re-runner.
 *
 * Per `SavedSearch`, re-runs the project's match by triggering a fresh
 * 8vance async-match job and comparing new `eightvanceTalentId`s against
 * the previous `Match` set. New talents → fire a `new_matches` email and
 * write a `Notification` row.
 *
 * Designed to be called from a cron (`scripts/saved-search-tick.ts`) or a
 * background queue; safe to invoke multiple times — the underlying
 * `syncProjectToVance` + `hydrateMatchesForProject` are idempotent.
 */

import { prisma } from '@/lib/db';
import { hydrateMatchesForProject } from '@/lib/match/hydrate';
import { syncProjectToVance } from '@/lib/eightvance/job-sync';
import { notify } from '@/lib/notifications/deliver';
import type { AnonymizedTalent } from '@/lib/anonymize/types';

const BRAND_NAME = process.env.BRAND_NAME ?? 'FindTalent';
const BRAND_COLOR = process.env.BRAND_PRIMARY_COLOR ?? '#0f172a';
const BASE_URL = process.env.NEXTAUTH_URL ?? 'http://localhost:3000';

export interface RunResult {
  savedSearchId: string;
  projectId: string;
  newMatchCount: number;
  notified: boolean;
}

export async function runSavedSearch(savedSearchId: string): Promise<RunResult> {
  const saved = await prisma.savedSearch.findUnique({
    where: { id: savedSearchId },
    include: {
      project: { select: { id: true, title: true, status: true } },
      user: { select: { id: true, email: true } },
    },
  });
  if (!saved) {
    throw new Error(`saved search ${savedSearchId} not found`);
  }

  // A CLOSED ("afgerond") project's reveals are ended and its shortlist hidden —
  // never resurrect it with a fresh match. Skip without notifying.
  if (saved.project.status === 'CLOSED') {
    return { savedSearchId, projectId: saved.projectId, newMatchCount: 0, notified: false };
  }

  const before = await prisma.match.findMany({
    where: { projectId: saved.projectId },
    select: { eightvanceTalentId: true },
  });
  const beforeIds = new Set(before.map((m) => m.eightvanceTalentId));

  // Force a re-run: clear the cached taskId on every pool so
  // syncProjectToVance starts a fresh match per pool.
  await prisma.projectPool.updateMany({
    where: { projectId: saved.projectId },
    data: { eightvanceTaskId: null, status: 'DRAFT' },
  });

  await syncProjectToVance(saved.projectId);
  await hydrateMatchesForProject(saved.projectId);

  const after = await prisma.match.findMany({
    where: { projectId: saved.projectId },
    select: {
      eightvanceTalentId: true,
      opaqueId: true,
      score: true,
      anonymizedPayloadJson: true,
    },
  });

  const newOnes = after.filter((m) => !beforeIds.has(m.eightvanceTalentId));
  const newMatchCount = newOnes.length;

  // Anonymized, PII-free summary of the new candidates for the email body:
  // opaque id + top skills + score. Capped to the first few so the email stays
  // short; "and N more" covers the rest.
  const SUMMARY_CAP = 5;
  const summaries: NewCandidateSummary[] = newOnes
    .slice(0, SUMMARY_CAP)
    .map((m) => {
      const anon = m.anonymizedPayloadJson as unknown as AnonymizedTalent | null;
      const skills = (anon?.skills ?? [])
        .filter((s) => s.must_have_match || !s.gap)
        .slice(0, 3)
        .map((s) => s.name);
      return {
        opaqueId: m.opaqueId,
        topSkills: skills,
        score: typeof m.score === 'number' ? Math.round(m.score) : null,
      };
    });

  await prisma.savedSearch.update({
    where: { id: savedSearchId },
    data: { lastRunAt: new Date() },
  });

  let notified = false;
  if (newMatchCount > 0) {
    const shortlistUrl = `${BASE_URL}/app/projects/${saved.projectId}/shortlist`;
    // `saved.notifyEmail` is the per-search email opt-out. When it's off we
    // still deliver in-app (subject to the user's `new_match` prefs); when on,
    // `notify` additionally checks the user's email pref before sending.
    const email = saved.notifyEmail
      ? {
          subject: `${newMatchCount} new match${newMatchCount === 1 ? '' : 'es'} for ${saved.project.title}`,
          html: renderNewMatchesEmail({
            brand: BRAND_NAME,
            brandColor: BRAND_COLOR,
            projectTitle: saved.project.title,
            newMatchCount,
            shortlistUrl,
            summaries,
          }),
        }
      : undefined;

    const res = await notify({
      userId: saved.user.id,
      type: 'new_match',
      payload: {
        savedSearchId,
        projectId: saved.projectId,
        projectTitle: saved.project.title,
        // `count` is the canonical key both notify call sites share (hydrate +
        // runner); `newMatchCount` is kept for backward-compat with old rows.
        count: newMatchCount,
        newMatchCount,
      },
      email,
    });
    notified = res.inAppCreated || res.emailSent;
  }

  return {
    savedSearchId,
    projectId: saved.projectId,
    newMatchCount,
    notified,
  };
}

/**
 * Anonymized, PII-free summary of a single new candidate for the diff email.
 * Carries only the opaque handle, broad top skills, and the rounded score —
 * never name/contact/employer.
 */
export interface NewCandidateSummary {
  opaqueId: string;
  topSkills: string[];
  score: number | null;
}

function renderNewMatchesEmail(opts: {
  brand: string;
  brandColor: string;
  projectTitle: string;
  newMatchCount: number;
  shortlistUrl: string;
  summaries: NewCandidateSummary[];
}): string {
  const remainder = opts.newMatchCount - opts.summaries.length;
  // One readable, ANONYMOUS card per new candidate: a generic label ("Candidate
  // 1") — never the raw opaque id (meaningless to the recruiter) and never PII —
  // plus skill chips + the match score. Reveal stays gated by a credit.
  const cards = opts.summaries
    .map((s, i) => {
      const chips = s.topSkills.length
        ? s.topSkills
            .map(
              (sk) =>
                `<span style="display:inline-block;background:#f1f5f9;color:#334155;border-radius:9999px;padding:2px 9px;margin:2px 4px 2px 0;font-size:12px">${escapeHtml(
                  sk,
                )}</span>`,
            )
            .join('')
        : '<span style="color:#94a3b8;font-size:12px">—</span>';
      const score =
        s.score != null
          ? `<span style="float:right;font-weight:600;color:${escapeHtml(opts.brandColor)}">${s.score} match</span>`
          : '';
      return `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;margin:8px 0">
        <div style="font-weight:600;color:#0f172a">Candidate ${i + 1}${score}</div>
        <div style="margin-top:6px">${chips}</div>
      </div>`;
    })
    .join('\n');
  const moreLine =
    remainder > 0
      ? `<p style="color:#64748b;font-size:13px">…and ${remainder} more in your shortlist.</p>`
      : '';

  return `
    <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 520px; margin: 0 auto; color:#0f172a;">
      <h2 style="margin:0 0 4px;color:#0f172a">${opts.newMatchCount} new match${opts.newMatchCount === 1 ? '' : 'es'} for ${escapeHtml(opts.projectTitle)}</h2>
      <p style="color:#475569;margin:0 0 12px">
        New anonymous candidates matched your saved search. Review the shortlist and
        reveal anyone with a credit when you want to reach out.
      </p>
      ${cards}
      ${moreLine}
      <p style="margin:16px 0">
        <a href="${escapeHtml(opts.shortlistUrl)}" style="display:inline-block;background:${escapeHtml(opts.brandColor)};color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600">
          View shortlist
        </a>
      </p>
      <p style="color:#94a3b8;font-size:12px">
        Sent by ${escapeHtml(opts.brand)} — manage or turn off these alerts in your saved searches.
      </p>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Default cadence: re-check a saved search if it hasn't run in the last 8h,
// i.e. up to ~3×/day when the cron tick fires at least that often. Emails go
// out only when NEW candidates appear (see runSavedSearch).
export async function runAllDueSavedSearches(maxAgeHours = 8): Promise<RunResult[]> {
  const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
  const due = await prisma.savedSearch.findMany({
    where: {
      OR: [{ lastRunAt: null }, { lastRunAt: { lt: cutoff } }],
    },
    select: { id: true },
    take: 50,
  });
  const results: RunResult[] = [];
  for (const s of due) {
    try {
      results.push(await runSavedSearch(s.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      // eslint-disable-next-line no-console
      console.error(`[saved-search] ${s.id} failed: ${msg}`);
    }
  }
  return results;
}
