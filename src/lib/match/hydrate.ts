/**
 * Multi-pool match-result hydration.
 *
 * For each `ProjectPool` whose status is MATCHING, poll the 8vance async-
 * match task. If it's still queued/processing we leave it. If completed
 * we paginate the results, fetch each talent's sub-resources, anonymize,
 * and cache them as `Match` rows tagged with `pool.tenantId`.
 *
 * Project.status is rolled up:
 *   - READY    — every pool is READY
 *   - MATCHING — at least one pool still in progress
 *   - PARTIAL  — every pool finished, but at least one FAILED
 *   - FAILED   — every pool FAILED
 *
 * Idempotent: existing Match rows are skipped via the unique key
 * `(projectId, tenantId, eightvanceTalentId)`.
 */

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { vanceClientForTenant } from '@/lib/eightvance/tenant-client';
import type {
  MatchResult,
  TalentEducation as VanceTalentEducation,
  TalentExperience as VanceTalentExperience,
  TalentLanguage as VanceTalentLanguage,
  TalentLocation as VanceTalentLocation,
  TalentProfile as VanceTalentProfile,
  TalentSkill as VanceTalentSkill,
} from '@/lib/eightvance/types';
import { anonymize } from '@/lib/anonymize/talent';
import { reportError } from '@/lib/observability/report';
import { notify } from '@/lib/notifications/deliver';
import { assertNoPII } from '@/lib/anonymize/blocklist';
import type {
  AnonymizedTalent,
  RawTalent,
  RawTalentEducation,
  RawTalentExperience,
  RawTalentLanguage,
  RawTalentSkill,
} from '@/lib/anonymize/types';

import { pLimit } from './concurrency';
import { cached, getSkillName, setSkillName } from './skill-cache';
import { getCachedTalent, setCachedTalent } from './talent-cache';
import { SYNC_TASK_SENTINEL, FALLBACK_TASK_SENTINEL } from '@/lib/eightvance/job-sync';
import { fallbackMatch, type JobMatchContext } from './fallback';
import type { ScoreSource } from '@/lib/anonymize/types';
import { canonicalCountry, cityToProvinceNL, isKnownProvinceNL } from '@/lib/anonymize/buckets';
import { computeTravelBucketsMatrix, isOvConfigured } from '@/lib/travel';
import type { LatLng, TravelMode } from '@/lib/travel/haversine';

const MATCH_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_PAGES = 100;
const PAGE_SIZE = 25;
// Per-talent hydration (profile+skills+location = 3 GETs each) is the dominant
// wall-clock cost of a project match once 8vance returns results, and the pool
// stays MATCHING until it's done. These 3 hit DIFFERENT endpoint buckets and a
// 25-result match = ~25 calls/endpoint. A burst at concurrency 10 tripped the
// 8vance public 60/min limit during a live re-match (the "N matches gevonden"
// count crawled up one-by-one as each enrichment backed off). 5 keeps us under
// the cap with backoff margin while the minimal-insert (below) still streams
// all cards immediately.
const FETCH_CONCURRENCY = 5;

export type HydrateStatus = 'matching' | 'ready' | 'partial' | 'failed';
export type PoolHydrateStatus = 'matching' | 'ready' | 'failed';

export interface PoolHydrateResult {
  tenantId: string;
  status: PoolHydrateStatus;
  count: number;
}

export interface HydrateResult {
  status: HydrateStatus;
  total: number;
  perPool: PoolHydrateResult[];
}

interface JobSkillEntry {
  id: number;
  name: string;
  must_have: boolean;
}

type VanceClient = Awaited<ReturnType<typeof vanceClientForTenant>>;

// Coalesce concurrent hydrate calls for the same project (e.g. repeated
// page reloads each remounting the poller) so we never run overlapping
// fallback scans that would hammer 8vance into a 429.
const inflight = new Map<string, Promise<HydrateResult>>();

export function hydrateMatchesForProject(projectId: string): Promise<HydrateResult> {
  const existing = inflight.get(projectId);
  if (existing) return existing;
  const p = runHydrate(projectId).finally(() => inflight.delete(projectId));
  inflight.set(projectId, p);
  return p;
}

/**
 * Drive the match-task forward for every pool of a project. Returns the
 * aggregated status + per-pool details.
 */
async function runHydrate(projectId: string): Promise<HydrateResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      userId: true,
      title: true,
      status: true,
      skillsJson: true,
      languagesJson: true,
      educationLevel: true,
      locationCountry: true,
      // Origin coords for travel-time computation (transient; never returned
      // raw). Stored as strings in the schema — parsed to numbers below.
      locationLat: true,
      locationLng: true,
      pools: {
        select: {
          id: true,
          tenantId: true,
          eightvanceJobId: true,
          eightvanceTaskId: true,
          status: true,
          // Own source slug — the sync re-match MUST pass it as `sources`
          // (empty/numeric → 401 "invalid sources"; the slug → 200).
          tenant: { select: { ownSourceSlug: true } },
        },
      },
    },
  });
  if (!project) {
    throw new Error(`hydrateMatchesForProject: project ${projectId} not found`);
  }

  const totalCount = await prisma.match.count({ where: { projectId } });

  if (project.pools.length === 0) {
    return { status: 'failed', total: totalCount, perPool: [] };
  }

  const jobSkills = parseJobSkills(project.skillsJson);
  const jobContext = buildJobContext(project);
  const origin = parseOrigin(project.locationLat, project.locationLng);
  const perPool: PoolHydrateResult[] = [];

  for (const pool of project.pools) {
    const cached = await prisma.match.count({
      where: { projectId, tenantId: pool.tenantId },
    });

    if (pool.status === 'READY') {
      perPool.push({ tenantId: pool.tenantId, status: 'ready', count: cached });
      continue;
    }
    if (pool.status === 'FAILED') {
      perPool.push({ tenantId: pool.tenantId, status: 'failed', count: cached });
      continue;
    }
    if (pool.status !== 'MATCHING' || !pool.eightvanceTaskId || !pool.eightvanceJobId) {
      perPool.push({ tenantId: pool.tenantId, status: 'matching', count: cached });
      continue;
    }

    // Sync-match + local-fallback pools: produce results inline (no poll).
    if (
      pool.eightvanceTaskId === SYNC_TASK_SENTINEL ||
      pool.eightvanceTaskId === FALLBACK_TASK_SENTINEL
    ) {
      try {
        const client = await vanceClientForTenant(pool.tenantId);
        const isFallback = pool.eightvanceTaskId === FALLBACK_TASK_SENTINEL;
        // Pass the own source SLUG (string) — empty/numeric sources → 401.
        const matchSources = pool.tenant?.ownSourceSlug ? [pool.tenant.ownSourceSlug] : [];
        let inserted = 0;
        if (isFallback) {
          // STREAMING FALLBACK: the local pool scan is the long pole (per-talent
          // GETs under the 55/min cap). Instead of waiting for the entire scan
          // to return one big array (the old "0 kandidaten for minutes, then it
          // finishes" behaviour), persist each scored BATCH the moment the
          // ranker emits it — so the first card lands within seconds and the
          // rest stream in best-first. hydrateResultRows is idempotent (skips
          // talents already inserted), so per-batch calls never double-insert.
          const seen = new Set<number>();
          await fallbackMatch(client, jobSkills, 25, {
            ctx: jobContext,
            tenantId: pool.tenantId,
            onPartial: async (batch) => {
              const fresh = batch.filter((r) => !seen.has(r.talent_id));
              for (const r of fresh) seen.add(r.talent_id);
              if (fresh.length === 0) return;
              inserted += await hydrateResultRows(fresh, {
                projectId: project.id,
                tenantId: pool.tenantId,
                jobSkills,
                client,
                scoreSource: 'fallback',
                origin,
              });
            },
          });
        } else {
          const results = await client.match.matchSync(pool.eightvanceJobId, matchSources);
          inserted = await hydrateResultRows(results, {
            projectId: project.id,
            tenantId: pool.tenantId,
            jobSkills,
            client,
            scoreSource: 'sync',
            origin,
          });
        }
        await prisma.projectPool.update({
          where: { id: pool.id },
          data: { status: 'READY', lastMatchedAt: new Date() },
        });
        perPool.push({ tenantId: pool.tenantId, status: 'ready', count: cached + inserted });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[hydrate] sync pool ${pool.tenantId} failed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
        reportError(err, { area: 'match.hydrate', phase: 'sync', tenantId: pool.tenantId });
        await prisma.projectPool
          .update({ where: { id: pool.id }, data: { status: 'FAILED' } })
          .catch(() => {});
        perPool.push({ tenantId: pool.tenantId, status: 'failed', count: cached });
      }
      continue;
    }

    try {
      const client = await vanceClientForTenant(pool.tenantId);
      const status = await client.match.pollStatus(pool.eightvanceTaskId);

      if (status.status === 'queued' || status.status === 'processing') {
        perPool.push({ tenantId: pool.tenantId, status: 'matching', count: cached });
        continue;
      }
      if (status.status === 'failed') {
        // 8vance's ASYNC match task can fail server-side even when the SYNC
        // match of the same job works perfectly (verified live on IVTA: the
        // async task reports FAILURE while POST /match/talent/ with the pool's
        // own source slug returns 50 talents). So before giving up, RETRY via
        // the synchronous match — recovering real results instead of a dead
        // "Match task failed".
        try {
          const sources = pool.tenant?.ownSourceSlug ? [pool.tenant.ownSourceSlug] : [];
          const results = await client.match.matchSync(pool.eightvanceJobId, sources);
          // A successful sync match that returns ZERO rows is a legitimate
          // "no candidates match this role" — NOT a failure. Mark the pool
          // READY (count 0) so the shortlist shows the empty-state ("0
          // kandidaten, verruim je filter") instead of the scary
          // "Matchtaak mislukt". Only a thrown error (the catch below) is a
          // real failure.
          const inserted =
            results.length > 0
              ? await hydrateResultRows(results, {
                  projectId: project.id,
                  tenantId: pool.tenantId,
                  jobSkills,
                  client,
                  scoreSource: 'sync',
                  origin,
                })
              : 0;
          await prisma.projectPool.update({
            where: { id: pool.id },
            data: { status: 'READY', lastMatchedAt: new Date() },
          });
          perPool.push({ tenantId: pool.tenantId, status: 'ready', count: cached + inserted });
          continue;
        } catch (err) {
          reportError(err, {
            area: 'match.hydrate',
            phase: 'async-failed-sync-retry',
            tenantId: pool.tenantId,
          });
          await prisma.projectPool.update({
            where: { id: pool.id },
            data: { status: 'FAILED' },
          });
          perPool.push({ tenantId: pool.tenantId, status: 'failed', count: cached });
          continue;
        }
      }

      // Completed → paginate + hydrate.
      const inserted = await hydratePool({
        projectId: project.id,
        tenantId: pool.tenantId,
        eightvanceTaskId: pool.eightvanceTaskId,
        eightvanceJobId: pool.eightvanceJobId,
        jobSkills,
        client,
        scoreSource: 'native',
        origin,
      });

      await prisma.projectPool.update({
        where: { id: pool.id },
        data: { status: 'READY', lastMatchedAt: new Date() },
      });
      perPool.push({
        tenantId: pool.tenantId,
        status: 'ready',
        count: cached + inserted,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[hydrate] pool ${pool.tenantId} failed: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
      reportError(err, { area: 'match.hydrate', phase: 'native', tenantId: pool.tenantId });
      await prisma.projectPool
        .update({ where: { id: pool.id }, data: { status: 'FAILED' } })
        .catch(() => {});
      perPool.push({ tenantId: pool.tenantId, status: 'failed', count: cached });
    }
  }

  const rollup = rollupStatus(perPool);

  // Mirror to Project.status so existing reads keep working.
  const projectStatus: 'READY' | 'MATCHING' | 'FAILED' =
    rollup === 'ready'
      ? 'READY'
      : rollup === 'matching'
        ? 'MATCHING'
        : rollup === 'failed'
          ? 'FAILED'
          : 'READY'; // partial → mark READY so user can see the available pools.
  await prisma.project.update({
    where: { id: project.id },
    data: {
      status: projectStatus,
      ...(rollup === 'ready' || rollup === 'partial'
        ? { lastMatchedAt: new Date() }
        : {}),
    },
  });

  const newTotal = await prisma.match.count({ where: { projectId } });

  // Notify the project owner ONCE, on the transition into a settled/ready state
  // (READY incl. partial). `project.status` is the pre-update value, so a later
  // poll that re-runs hydrate on an already-READY project won't re-notify.
  // SUPPRESS when no NEW candidates actually landed this run (count == 0) — a
  // re-match that finds nothing new must not spam a "0 nieuwe kandidaten" row.
  // The payload carries projectId + projectTitle + count so the notifications
  // page can render the title and link straight to the shortlist.
  const newCount = Math.max(0, newTotal - totalCount);
  if (
    project.status !== 'READY' &&
    projectStatus === 'READY' &&
    project.userId &&
    newCount > 0
  ) {
    void notify({
      userId: project.userId,
      type: 'new_match',
      payload: {
        kind: 'project',
        projectId: project.id,
        projectTitle: project.title,
        count: newCount,
      },
    });
  }

  return { status: rollup, total: newTotal, perPool };
}

function rollupStatus(rows: PoolHydrateResult[]): HydrateStatus {
  if (rows.length === 0) return 'failed';
  const anyMatching = rows.some((r) => r.status === 'matching');
  if (anyMatching) return 'matching';
  const anyFailed = rows.some((r) => r.status === 'failed');
  const anyReady = rows.some((r) => r.status === 'ready');
  if (anyReady && anyFailed) return 'partial';
  if (anyFailed) return 'failed';
  return 'ready';
}

interface HydratePoolOpts {
  projectId: string;
  tenantId: string;
  eightvanceTaskId: string;
  eightvanceJobId: number;
  jobSkills: JobSkillEntry[];
  client: VanceClient;
  scoreSource: ScoreSource;
  /** Project origin coords for travel buckets; null when project has none. */
  origin: LatLng | null;
}

async function hydratePool(opts: HydratePoolOpts): Promise<number> {
  let inserted = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const resp = await opts.client.match.getResults(
      opts.eightvanceTaskId,
      opts.eightvanceJobId,
      page,
      PAGE_SIZE,
    );
    if (resp.results.length === 0) break;
    inserted += await hydrateResultRows(resp.results, {
      projectId: opts.projectId,
      tenantId: opts.tenantId,
      jobSkills: opts.jobSkills,
      client: opts.client,
      scoreSource: opts.scoreSource,
      origin: opts.origin,
    });
    if (!resp.next) break;
  }
  return inserted;
}

interface HydrateRowsOpts {
  projectId: string;
  tenantId: string;
  jobSkills: JobSkillEntry[];
  client: VanceClient;
  scoreSource: ScoreSource;
  /** Project origin coords for travel buckets; null when project has none. */
  origin: LatLng | null;
}

/** Anonymize + persist a batch of match-result rows. Skips already-cached. */
async function hydrateResultRows(
  results: MatchResult[],
  opts: HydrateRowsOpts,
): Promise<number> {
  if (results.length === 0) return 0;
  const limit = pLimit(FETCH_CONCURRENCY);
  let inserted = 0;

  const incomingIds = results
    .map((r) => r.talent_id)
    .filter((id): id is number => Number.isFinite(id));
  const existing = await prisma.match.findMany({
    where: {
      projectId: opts.projectId,
      tenantId: opts.tenantId,
      eightvanceTalentId: { in: incomingIds },
    },
    select: { eightvanceTalentId: true },
  });
  const existingIds = new Set<number>(existing.map((e) => e.eightvanceTalentId));

  const todo = results
    .filter((r) => !existingIds.has(r.talent_id))
    .filter((r) => Number.isFinite(r.talent_id));

  // INSTANT/LAZY CARDS: before any per-talent 8vance enrichment, insert a
  // MINIMAL anonymized row per result, built ONLY from the match-result row
  // (score + top_skill names + coarse location). These go through the SAME
  // anonymize()/assertNoPII path as the full payload (see minimalRawFromResult).
  // The /status poller refreshes the route on match-count growth, so these
  // cards appear in ~1-2s; the heavy enrichment below then UPDATES each row
  // in-place. Score-desc input order makes the stream best-first.
  // matchId per talentId so the enrichment pass can update the right row.
  const matchIdByTalent = new Map<number, string>();
  for (const row of todo) {
    try {
      const data = anonymizeRowData(
        minimalRawFromResult(row),
        row,
        opts.projectId,
        opts.tenantId,
        opts.jobSkills,
        opts.scoreSource,
      );
      const m = await prisma.match.create({ data, select: { id: true } });
      matchIdByTalent.set(row.talent_id, m.id);
    } catch (err) {
      if (!isUniqueViolation(err)) {
        // A minimal-insert failure must not abort the match — log and let the
        // enrichment pass try a fresh create for this talent below.
        reportError(err, { area: 'match.hydrate', phase: 'minimal-insert', tenantId: opts.tenantId });
      }
    }
  }
  inserted = matchIdByTalent.size;

  // PROGRESSIVE ENRICHMENT: hydrate each talent (cache-first; see loadRawTalent)
  // and UPDATE its minimal row in-place with the full payload. Runs concurrently
  // (FETCH_CONCURRENCY) but each row is independent. The pool only flips READY
  // once this whole pass resolves.
  // Rows we successfully enriched THIS pass, with the talent's transient real
  // coords — used for the travel post-pass below (coords never persisted).
  const created: Array<{ matchId: string; coords: LatLng | null }> = [];
  await Promise.all(
    todo.map((row) =>
      limit(async (): Promise<void> => {
        const h = await hydrateOne(
          row,
          opts.projectId,
          opts.tenantId,
          opts.jobSkills,
          opts.client,
          opts.scoreSource,
        );
        if (!h) return;
        const existingMatchId = matchIdByTalent.get(row.talent_id);
        try {
          if (existingMatchId) {
            // Update the minimal row in place with the full payload.
            await prisma.match.update({
              where: { id: existingMatchId },
              data: {
                opaqueId: h.data.opaqueId,
                score: h.data.score,
                anonymizedPayloadJson: h.data.anonymizedPayloadJson,
                skillGapJson: h.data.skillGapJson,
                fetchedAt: h.data.fetchedAt,
                expiresAt: h.data.expiresAt,
              },
            });
            created.push({ matchId: existingMatchId, coords: h.coords });
          } else {
            // Minimal insert failed earlier — create the full row now.
            const m = await prisma.match.create({ data: h.data, select: { id: true } });
            created.push({ matchId: m.id, coords: h.coords });
            inserted += 1;
          }
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
      }),
    ),
  );

  // POST-PASS: attach coarse travel buckets. Rows were inserted PROGRESSIVELY
  // above (streaming, score-desc) — this runs AFTER they're persisted and only
  // UPDATES `travel` onto each payload, so it never blocks the streaming insert.
  // Best-effort: any failure here must NEVER fail the match (try/catch +
  // reportError). Skipped entirely when the project has no origin coords.
  await attachTravelBuckets(opts.origin, created);

  return inserted;
}

/**
 * Compute travel buckets for a freshly-inserted batch and UPDATE each Match
 * row's anonymized payload to add `travel`. 1–2 ORS matrix calls (car+bike)
 * for the whole batch, Haversine fallback per entry. Coords are used transiently
 * only — they are never written back. Never throws.
 */
async function attachTravelBuckets(
  origin: LatLng | null,
  created: Array<{ matchId: string; coords: LatLng | null }>,
): Promise<void> {
  if (!origin || created.length === 0) return;
  try {
    // car/bike always; add 'ov' ONLY when an OV source (Google/OTP) is
    // configured — otherwise keep exactly ['car','bike'] (no extra calls, no
    // behaviour change: the OV chip stays hidden because no row gets ov data).
    const modes: TravelMode[] = isOvConfigured()
      ? ['car', 'bike', 'ov']
      : ['car', 'bike'];
    const buckets = await computeTravelBucketsMatrix(
      origin,
      created.map((c) => c.coords),
      modes,
    );
    await Promise.all(
      created.map(async (c, i) => {
        const travel = buckets[i];
        if (!travel) return;
        try {
          const m = await prisma.match.findUnique({
            where: { id: c.matchId },
            select: { anonymizedPayloadJson: true },
          });
          if (!m) return;
          const payload = {
            ...(m.anonymizedPayloadJson as unknown as AnonymizedTalent),
            travel,
          };
          // Defense-in-depth: the travel field carries only bucket strings +
          // car/bike/ov keys, none of them blocked — assert before persist.
          assertNoPII(payload);
          await prisma.match.update({
            where: { id: c.matchId },
            data: { anonymizedPayloadJson: payload as unknown as Prisma.InputJsonValue },
          });
        } catch (err) {
          reportError(err, { area: 'match.hydrate', phase: 'travel-row' });
        }
      }),
    );
  } catch (err) {
    // Travel is a best-effort enrichment — never let it fail the match.
    reportError(err, { area: 'match.hydrate', phase: 'travel' });
  }
}

interface HydratedRow {
  data: Prisma.MatchUncheckedCreateInput;
  /**
   * The talent's REAL coordinates (transient). Used ONLY by the in-memory
   * travel post-pass; NEVER written into `data`/the payload. null when the
   * talent has no usable coords.
   */
  coords: LatLng | null;
}

/**
 * Fetch (or reuse) the talent-intrinsic `RawTalent` for a match row.
 *
 * Two cache layers:
 *  - The PERSISTENT talent-enrichment cache (`talent-cache.ts`, ~24h, keyed by
 *    (tenant, talentId)) stores the fully-assembled RawTalent so a rematch /
 *    cross-project reuse of the SAME talent skips ALL 8vance GETs. It holds only
 *    talent-intrinsic data (profile/skills/location) — never job-specific bits.
 *  - On a miss we fetch profile+skills+location (the 3 fields a shortlist card
 *    needs; experience/education/languages are enriched lazily on the detail
 *    page via `enrichMatch`), still going through the short-TTL sub-resource
 *    cache so a fallback scan moments earlier is reused, then populate the
 *    persistent cache.
 *
 * The job-specific `anonymize()` step is ALWAYS run fresh by the caller against
 * the current project's job skills, so a cache hit never carries another
 * project's must_have/gap/score view.
 */
async function loadRawTalent(
  talentId: number,
  row: MatchResult,
  tenantId: string,
  client: VanceClient,
): Promise<RawTalent> {
  const hit = getCachedTalent(tenantId, talentId);
  if (hit) {
    // Reuse intrinsic data, but adopt THIS match's score (per-match, not cached).
    return typeof row.score === 'number' ? { ...hit, score: row.score } : hit;
  }

  // Bulk hydrate fetches only what the shortlist card needs (profile +
  // skills + location). Experience/education/languages are enriched lazily
  // per-talent on the detail page (see enrichMatch) — fetching all six for
  // every one of ~25 matches at once trips 8vance's server-side throttle
  // and leaves cards with gaps.
  // Reuse the short-TTL sub-resource cache the fallback ranker populated for
  // this same talent moments earlier (same tenant, same talentId) — so the
  // top-25 hydrate after a fallback scan is largely cache hits, not a second
  // round of rate-limited fetches. `profile` here is the full talent profile,
  // identical to the 'profile' resource the ranker caches.
  const [profile, location] = await Promise.all([
    cached(tenantId, talentId, 'profile', () => client.talent.getProfile(talentId)).catch(() => null),
    cached(tenantId, talentId, 'location', () => client.talent.getLocation(talentId)).catch(() => null),
  ]);

  // Skills get their OWN retry loop. A single 8vance throttle (429) or timeout
  // during the concurrent hydration burst used to zero a talent's skills
  // (`.catch(() => [])`), and that empty was then cached AND persisted into the
  // Match row — so the card showed "No skill data" while the talent actually
  // had a full skill set (verified live: a top match had 3 gap-only skills
  // stored vs 14 real skills). Retry with backoff; only if it STILL fails do we
  // mark the talent skillsUnavailable and skip caching, so "Refresh matches"
  // re-fetches instead of freezing the empty for the cache TTL.
  let skills: VanceTalentSkill[] = [];
  let skillsFailed = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      skills = await cached(tenantId, talentId, 'skill', () =>
        client.talent.getSkills(talentId),
      );
      skillsFailed = false;
      break;
    } catch {
      skillsFailed = true;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
  }

  // Fill any missing skill names (a row without `skill_name` would otherwise
  // anonymize to a raw `skill_<id>` label). Resolve via 24h-cached reference
  // data. Best-effort: unresolved ids stay nameless and fall back downstream.
  const resolvedSkills = await resolveMissingSkillNames(skills ?? [], client);

  const raw = toRawTalent(talentId, row, profile, resolvedSkills, [], [], [], location, skillsFailed);
  // Cache the talent-intrinsic data (NOT job-specific) ONLY when the skill fetch
  // SUCCEEDED — caching a failed (empty) skill set would freeze "No skill data"
  // for the whole cache TTL even after 8vance recovers. The score on `raw` is
  // per-match; strip it so the cached entry is purely intrinsic.
  if (!skillsFailed) setCachedTalent(tenantId, { ...raw, score: null });
  return raw;
}

/**
 * Patch `skill_name` onto any talent-skill row that arrived without one, by
 * reverse-resolving its taxonomy id against 8vance reference data (24h-cached).
 *
 * Why: a missing name flows through hydrate as `name: undefined` and the
 * anonymize layer then falls back to a raw `skill_<id>` label — leaking the
 * taxonomy id into the anonymized UI. Resolving here keeps the leak from ever
 * being produced; the anonymize-side generic-label fallback is the last resort
 * for ids that still don't resolve.
 *
 * Best-effort + cheap: cache hits cost nothing; only genuinely-unknown ids hit
 * the network, and a lookup failure leaves the row nameless (handled downstream).
 */
async function resolveMissingSkillNames(
  skills: VanceTalentSkill[],
  client: VanceClient,
): Promise<VanceTalentSkill[]> {
  // A name is "real" only when it's a non-blank string that is NOT itself a raw
  // `skill_<id>` token (8vance sometimes returns the bare id as skill_name, and
  // top_skills can carry them too). Raw-id names are treated as missing so we
  // try to resolve them to a real name (and strip them otherwise).
  const hasRealName = (n: unknown): n is string =>
    typeof n === 'string' && n.trim().length > 0 && !/^skill_\d+$/i.test(n.trim());
  const missing = skills.filter((s) => !hasRealName(s.skill_name));
  if (missing.length === 0) return skills;

  // Resolve from cache first; collect the still-unknown ids for one batch call.
  const toFetch: number[] = [];
  for (const s of missing) {
    const id = Number(s.skill);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (getSkillName(id) === null) toFetch.push(id);
  }
  if (toFetch.length > 0) {
    try {
      const resolved = await client.resources.resolveSkillNamesByIds(toFetch);
      for (const [id, name] of resolved) setSkillName(id, name);
    } catch {
      // Reference-data unavailable — leave names unresolved (generic fallback).
    }
  }

  return skills.map((s) => {
    if (hasRealName(s.skill_name)) return s;
    const id = Number(s.skill);
    const name = Number.isFinite(id) ? getSkillName(id) : null;
    // Resolved → real name. Unresolved → strip the raw id (skill_name=undefined)
    // so anonymize emits the generic label instead of leaking `skill_<id>`.
    return name ? { ...s, skill_name: name } : { ...s, skill_name: undefined };
  });
}

async function hydrateOne(
  row: MatchResult,
  projectId: string,
  tenantId: string,
  jobSkills: JobSkillEntry[],
  client: VanceClient,
  scoreSource: ScoreSource,
): Promise<HydratedRow | null> {
  const talentId = row.talent_id;
  if (!Number.isFinite(talentId)) return null;

  const raw = await loadRawTalent(talentId, row, tenantId, client);

  // Capture the talent's real coords transiently for the travel post-pass.
  // These never enter the anonymized payload or the DB row.
  const coords: LatLng | null =
    raw.location &&
    typeof raw.location.latitude === 'number' &&
    typeof raw.location.longitude === 'number' &&
    Number.isFinite(raw.location.latitude) &&
    Number.isFinite(raw.location.longitude)
      ? { lat: raw.location.latitude, lng: raw.location.longitude }
      : null;

  // anonymize() is run FRESH here (job-specific must_have/gap derive from THIS
  // project's jobSkills) — never read from the talent cache.
  const data = anonymizeRowData(raw, row, projectId, tenantId, jobSkills, scoreSource);
  return { data, coords };
}

/**
 * Run the job-specific anonymize step on a RawTalent and shape the Prisma
 * Match row. Shared by the full hydrate and the minimal/instant insert so both
 * go through the SAME `anonymize()` + `assertNoPII` path. `anonymize()` already
 * asserts internally; we leave its guarantee intact (no second copy needed).
 */
function anonymizeRowData(
  raw: RawTalent,
  row: MatchResult,
  projectId: string,
  tenantId: string,
  jobSkills: JobSkillEntry[],
  scoreSource: ScoreSource,
): Prisma.MatchUncheckedCreateInput {
  const hashSecret = process.env.ENCRYPTION_KEY;
  if (!hashSecret) {
    throw new Error('hydrateOne: ENCRYPTION_KEY env var is required');
  }

  const anonymized: AnonymizedTalent = anonymize(raw, {
    tenantId,
    hashSecret,
    jobSkills,
  });
  // Tag score provenance so the UI can distinguish native/sync/fallback.
  anonymized.score_source = scoreSource;

  // Defense-in-depth (anonymize() already asserts; assert again on the tagged
  // object so the score_source mutation can't slip a leak through).
  assertNoPII(anonymized);

  const skillGap = anonymized.skills.filter((s) => s.gap).map((s) => s.name);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + MATCH_TTL_MS);

  return {
    projectId,
    tenantId,
    eightvanceTalentId: raw.id,
    opaqueId: anonymized.opaque_id,
    score: anonymized.score ?? (typeof row.score === 'number' ? row.score : 0),
    anonymizedPayloadJson: anonymized as unknown as Prisma.InputJsonValue,
    skillGapJson: skillGap as unknown as Prisma.InputJsonValue,
    fetchedAt: now,
    expiresAt,
  };
}

/**
 * Build a MINIMAL talent-intrinsic `RawTalent` from ONLY the match-result row
 * (no 8vance round-trip). Used for the instant/lazy card insert: we know the
 * score, the top skill NAMES, and a coarse location label up front, so we can
 * render a card immediately and fill in the rest when full hydration lands.
 *
 * ANONYMITY: every field here is fed through the SAME `anonymize()` pipeline as
 * the full hydrate, so the produced payload is held to the identical contract:
 *  - top_skills are skill names with no proficiency id → render as empty meters,
 *    and each name is scrubbed by `anonymize()` (scrubFreeText) before exposure.
 *  - `location_label` is a free-text label (often a CITY → PII). We never pass
 *    it raw into anonymize's `country`/`city` slots, because anonymize echoes an
 *    UNRECOGNISED country/city label straight back into the payload. Instead we
 *    POSITIVELY resolve it to a province/country up front (see
 *    `safeLocationFromLabel`): only a known NL city/province or a recognised
 *    country survives; anything else (an address, an unknown town) coarsens to
 *    null and the card simply shows no location until full hydration lands. No
 *    city, no coords, no name ever enter the payload.
 */
export function minimalRawFromResult(row: MatchResult): RawTalent {
  const talentId = row.talent_id;
  const skills: RawTalentSkill[] = (row.top_skills ?? [])
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((name, i) => ({ skill_id: -1 - i, name, proficiency_id: null }));

  return {
    id: talentId,
    first_name: null,
    last_name: null,
    email: null,
    phone: null,
    function_name: null,
    function_level: null,
    total_years_experience: null,
    hours_per_week: null,
    start_date: null,
    score: typeof row.score === 'number' ? row.score : null,
    location: safeLocationFromLabel(row.location_label),
    skills,
    experience: [],
    education: [],
    languages: [],
  };
}

/**
 * Coarsen a free-text `location_label` to a province/country WITHOUT ever
 * letting an unrecognised value (city / address / unknown town) survive.
 *
 * We split on commas and test each token against the SAME positive tables the
 * anonymize layer uses:
 *   - a known NL city → its province (+ Nederland),
 *   - a known NL province → that province,
 *   - a recognised country (canonical map) → that country.
 * The result is fed into anonymize's `province`/`country` slots, both of which
 * it re-validates. Anything we can't positively resolve yields `null`, so the
 * minimal card just omits the location (filled in later by full hydration).
 */
function safeLocationFromLabel(
  label: string | null | undefined,
): RawTalent['location'] {
  if (typeof label !== 'string' || !label.trim()) return null;
  const tokens = label.split(',').map((t) => t.trim()).filter(Boolean);

  let province = '';
  let country = '';
  for (const tok of tokens) {
    // Known NL city → province.
    const derived = cityToProvinceNL(tok, '');
    if (derived.province) {
      province = province || derived.province;
      country = country || 'Nederland';
      continue;
    }
    // Already a known NL province.
    if (isKnownProvinceNL(tok)) {
      province = province || tok;
      country = country || 'Nederland';
      continue;
    }
    // A recognised country (only mapped keys count — an unknown echo is ignored).
    const c = canonicalCountry(tok);
    if (c && c.toLowerCase() !== tok.toLowerCase()) {
      // canonicalCountry mapped it (e.g. "NL" → "Nederland"): definitely a country.
      country = country || c;
    } else if (c && KNOWN_CANONICAL_COUNTRIES.has(c)) {
      // Token was already the canonical label (e.g. "Nederland").
      country = country || c;
    }
  }

  if (!province && !country) return null;
  // Pass the resolved province as `region` so anonymize's province-validation
  // (isKnownProvinceNL) accepts it, and the resolved country as `country`.
  return { city: null, country: country || null, province: province || null };
}

/** The canonical country labels `canonicalCountry` can emit — used to accept a
 *  token that is ALREADY canonical (vs an unknown echo). */
const KNOWN_CANONICAL_COUNTRIES: ReadonlySet<string> = new Set([
  'Nederland',
  'België',
  'Duitsland',
  'Frankrijk',
  'Verenigd Koninkrijk',
  'Verenigde Staten',
]);

/**
 * Lazily enrich a single match with experience/education/languages (which
 * bulk hydrate skips to avoid throttling). Fetches the talent's full
 * sub-resources once, re-anonymizes, and persists onto the Match. Returns
 * the enriched payload. Cheap + safe: one talent, no concurrency.
 */
export async function enrichMatch(matchId: string): Promise<AnonymizedTalent | null> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      eightvanceTalentId: true,
      tenantId: true,
      anonymizedPayloadJson: true,
      project: { select: { skillsJson: true } },
    },
  });
  if (!match) return null;

  const current = match.anonymizedPayloadJson as unknown as AnonymizedTalent;
  // Already enriched? skip the round-trip.
  if (
    current &&
    (current.experience.length > 0 ||
      current.education.length > 0 ||
      current.languages.length > 0)
  ) {
    return current;
  }

  const hashSecret = process.env.ENCRYPTION_KEY;
  if (!hashSecret) return current ?? null;

  const client = await vanceClientForTenant(match.tenantId);
  const talentId = match.eightvanceTalentId;
  const [profile, skills, experience, education, languages, location] = await Promise.all([
    client.talent.getProfile(talentId).catch(() => null),
    client.talent.getSkills(talentId).catch(() => [] as VanceTalentSkill[]),
    client.talent.getExperience(talentId).catch(() => [] as VanceTalentExperience[]),
    client.talent.getEducation(talentId).catch(() => [] as VanceTalentEducation[]),
    client.talent.getLanguages(talentId).catch(() => [] as VanceTalentLanguage[]),
    client.talent.getLocation(talentId).catch(() => null),
  ]);

  const jobSkills = parseJobSkills(match.project.skillsJson);
  const raw = toRawTalent(
    talentId,
    { talent_id: talentId, score: current?.score ?? null },
    profile,
    skills,
    experience,
    education,
    languages,
    location,
  );
  const enriched = anonymize(raw, { tenantId: match.tenantId, hashSecret, jobSkills });
  assertNoPII(enriched);

  await prisma.match.update({
    where: { id: match.id },
    data: { anonymizedPayloadJson: enriched as unknown as Prisma.InputJsonValue },
  });
  return enriched;
}

/**
 * WORKAROUND helper for the reverse-match index lag: build a single
 * project-scoped `Match` row for one talent from the talent→jobs (forward)
 * result, so a freshly-onboarded candidate appears in matching project
 * shortlists immediately (before 8vance's job→talent reverse index catches up).
 *
 * Fetches the talent's full sub-resources the EXACT same way `enrichMatch` does
 * (profile + skills + experience + education + languages + location, each with a
 * `.catch(()=>[])`/null default), builds a `MatchResult`-shaped row carrying the
 * forward score, reshapes via `toRawTalent`, then runs the SAME
 * `anonymizeRowData` (anonymize + assertNoPII) pipeline as every other match
 * row. Tagged `score_source: 'sync'`. Returns the Prisma create input — the
 * caller decides whether to create or upsert.
 */
export async function buildMatchDataForTalent(
  client: VanceClient,
  talentId: number,
  projectId: string,
  tenantId: string,
  jobSkills: JobSkillEntry[],
  score: number | null,
): Promise<Prisma.MatchUncheckedCreateInput> {
  const [profile, skills, experience, education, languages, location] = await Promise.all([
    client.talent.getProfile(talentId).catch(() => null),
    client.talent.getSkills(talentId).catch(() => [] as VanceTalentSkill[]),
    client.talent.getExperience(talentId).catch(() => [] as VanceTalentExperience[]),
    client.talent.getEducation(talentId).catch(() => [] as VanceTalentEducation[]),
    client.talent.getLanguages(talentId).catch(() => [] as VanceTalentLanguage[]),
    client.talent.getLocation(talentId).catch(() => null),
  ]);

  const row: MatchResult = { talent_id: talentId, score };
  const raw = toRawTalent(
    talentId,
    row,
    profile,
    skills,
    experience,
    education,
    languages,
    location,
  );
  return anonymizeRowData(raw, row, projectId, tenantId, jobSkills, 'sync');
}

/**
 * Reshape disparate 8vance sub-resource responses into the
 * `RawTalent` contract consumed by `anonymize()`.
 */
function toRawTalent(
  talentId: number,
  row: MatchResult,
  profile: VanceTalentProfile | null,
  skills: VanceTalentSkill[],
  experience: VanceTalentExperience[],
  education: VanceTalentEducation[],
  languages: VanceTalentLanguage[],
  location: VanceTalentLocation | null,
  skillsUnavailable = false,
): RawTalent {
  const profSkills: RawTalentSkill[] = (skills ?? []).map((s) => ({
    skill_id: s.skill,
    name: typeof s.skill_name === 'string' ? s.skill_name : undefined,
    proficiency_id: s.proficiency_id ?? s.proficiency ?? null,
  }));
  const profExp: RawTalentExperience[] = (experience ?? []).map((e) => {
    const fn = e.function_name;
    const fnStr = typeof fn === 'string' ? fn : null;
    return {
      function_title: e.function_title ?? e.title ?? fnStr ?? null,
      company_name: e.company_name ?? null,
      start_date: e.start_date ?? null,
      end_date: e.end_date ?? null,
      is_current: e.current_job === true || e.end_date == null,
    };
  });
  const profEdu: RawTalentEducation[] = (education ?? []).map((e) => ({
    level: e.degree?.phrase ?? (e.education_degree != null ? String(e.education_degree) : null),
    field_of_study_category:
      e.education_type ?? (e.education_subject != null ? String(e.education_subject) : null),
    school_name: e.school ?? e.institution ?? null,
    end_year: yearFrom(e.end_date),
  }));
  const profLang: RawTalentLanguage[] = (languages ?? [])
    .map((l) => ({
      language:
        typeof l.language_name === 'string' && l.language_name.trim()
          ? l.language_name
          : l.language != null
            ? String(l.language)
            : '',
      level: speakLevelToString(l.speak_level ?? l.proficiency_id ?? null),
    }))
    .filter((l) => l.language.length > 0 && !/^\d+$/.test(l.language));
  const profileScore =
    typeof row.score === 'number'
      ? row.score
      : typeof profile?.score === 'number'
        ? profile.score
        : null;

  return {
    id: talentId,
    first_name: stringOrNull(profile?.first_name),
    last_name: stringOrNull(profile?.last_name),
    email: profile?.email ?? null,
    phone: profile?.phone ?? null,
    function_name: stringOrNull(profile?.function_name),
    function_level: numberOrNull(profile?.function_level),
    total_years_experience: numberOrNull(profile?.total_years_experience),
    hours_per_week: numberOrNull(profile?.hours_per_week),
    start_date: stringOrNull(profile?.start_date),
    score: profileScore,
    location: location
      ? {
          city: location.city ?? null,
          country: location.country ?? null,
          province: location.region ?? null,
          latitude: location.latitude != null ? Number(location.latitude) : null,
          longitude: location.longitude != null ? Number(location.longitude) : null,
        }
      : null,
    skills: profSkills,
    experience: profExp,
    education: profEdu,
    languages: profLang,
    skillsUnavailable,
  };
}

/** Map 8vance numeric speak/proficiency level → the label bucket's input. */
function speakLevelToString(level: number | null): string {
  if (level == null) return 'basic';
  if (level >= 4) return 'native';
  if (level >= 2) return 'business';
  return 'basic';
}

function stringOrNull(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v;
  if (typeof v === 'number') return String(v);
  return null;
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function yearFrom(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).getUTCFullYear();
}

export function parseJobSkills(blob: unknown): JobSkillEntry[] {
  if (!Array.isArray(blob)) return [];
  const out: JobSkillEntry[] = [];
  for (const row of blob) {
    if (!row || typeof row !== 'object') continue;
    const obj = row as Record<string, unknown>;
    const id = typeof obj.id === 'number' ? obj.id : Number(obj.skill ?? obj.skill_id);
    if (!Number.isFinite(id)) continue;
    out.push({
      id,
      name: typeof obj.name === 'string' ? obj.name : '',
      must_have: obj.must_have === true,
    });
  }
  return out;
}

/**
 * Parse the project's origin coords (stored as nullable strings) into a numeric
 * {lat,lng}. Returns null when either is missing/unparseable, so the travel
 * post-pass is skipped entirely. Coords are used transiently in memory only.
 */
function parseOrigin(
  lat: string | null | undefined,
  lng: string | null | undefined,
): LatLng | null {
  if (lat == null || lng == null) return null;
  const latN = Number(lat);
  const lngN = Number(lng);
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) return null;
  return { lat: latN, lng: lngN };
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'P2002';
}

/**
 * Derive the optional job-side matching context (location/language/education/
 * experience) the fallback ranker blends in. Every field degrades gracefully:
 * a missing/garbled value simply omits that signal. The job's required years
 * of experience is not collected by the wizard today, so it is left undefined
 * (threaded through for forward-compat).
 */
function buildJobContext(project: {
  languagesJson?: unknown;
  educationLevel?: string | null;
  locationCountry?: string | null;
}): JobMatchContext {
  const languages: string[] = [];
  if (Array.isArray(project.languagesJson)) {
    for (const row of project.languagesJson) {
      if (row && typeof row === 'object') {
        const name = (row as Record<string, unknown>).name;
        if (typeof name === 'string' && name.trim()) languages.push(name.trim());
      }
    }
  }
  return {
    // The wizard only stores city + country (no province); pass country.
    location: project.locationCountry ? { country: project.locationCountry } : null,
    languages,
    educationLevel: project.educationLevel ?? null,
    minYearsExperience: null,
  };
}

// ---------------------------------------------------------------------------
// Cross-pool dedup (read/aggregation time)
// ---------------------------------------------------------------------------

/**
 * One shortlist row as stored per pool. `eightvanceTalentId` is 8vance's
 * GLOBAL talent id — stable across pools/tenants that share the same 8vance
 * backend — which makes it a reliable cross-pool identity key.
 */
export interface ShortlistMatchRow {
  id: string;
  eightvanceTalentId: number;
  score: number;
  tenantSlug: string;
  payload: AnonymizedTalent;
}

/**
 * Collapse the same underlying talent appearing in multiple pools into a
 * single best-score card.
 *
 * Why this is safe:
 *  - We dedup by `eightvanceTalentId` SCOPED TO A PROJECT only. We never touch
 *    the persisted per-pool `Match` rows or their unique key
 *    `(projectId, tenantId, eightvanceTalentId)` — the collapse happens purely
 *    at read time on already-fetched rows.
 *  - The opaque_id is tenant-salted, so the same person legitimately has a
 *    different opaque_id per pool; collapsing on opaque_id is impossible.
 *    `eightvanceTalentId` is the only reliable identity, and it is the 8vance
 *    global id, so equal ids ⇒ same person.
 *  - We keep the highest-scoring entry (ties: first seen, i.e. the input
 *    order, which callers pass score-desc) and merge every source pool's slug
 *    into `payload.source_pools` so the UI can show "found in pool A + B".
 *
 * Input order is preserved for the surviving rows.
 */
export function dedupAcrossPools(rows: ShortlistMatchRow[]): ShortlistMatchRow[] {
  const best = new Map<number, ShortlistMatchRow>();
  const pools = new Map<number, Set<string>>();
  const order: number[] = [];

  for (const row of rows) {
    const key = row.eightvanceTalentId;
    if (!pools.has(key)) {
      pools.set(key, new Set<string>());
      order.push(key);
    }
    if (row.tenantSlug) pools.get(key)!.add(row.tenantSlug);

    const current = best.get(key);
    if (!current || row.score > current.score) {
      best.set(key, row);
    }
  }

  return order.map((key) => {
    const row = best.get(key)!;
    const slugs = [...pools.get(key)!];
    if (slugs.length <= 1) {
      // Single-pool cards stay clean — payload already passed assertNoPII when
      // it was produced by anonymize(); no re-spread, so nothing new to check.
      return row;
    }
    // Multi-pool: we build a NEW payload object via spread. Re-run the PII
    // guard on the final object (defense-in-depth) so any future field added
    // to this spread can never bypass the anonymization contract.
    const payload: AnonymizedTalent = { ...row.payload, source_pools: slugs };
    assertNoPII(payload);
    return { ...row, payload };
  });
}
