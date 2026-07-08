/**
 * Multi-pool job sync.
 *
 * A Project may match against one or more talent pools (Tenant rows) via
 * its `ProjectPool` join rows. For each pool we:
 *   1. POST /job/ (skipped if `pool.eightvanceJobId` already set).
 *   2. POST /async/talent/match/?job_id=… to start the async match task.
 *   3. Persist `pool.eightvanceJobId` + `pool.eightvanceTaskId` +
 *      status='MATCHING'.
 *
 * Memory `feedback_security_critical`: no PII or credentials in errors.
 * `MatchPreconditionError` is the friendly surface for "you need more
 * skills" / "missing function name" — actions.ts surfaces its `.message`
 * to the wizard.
 */

import type {
  JobSkillInput,
  JobCreatePayload,
  JobLanguageInput,
  JobEducationDegreeInput,
} from "./types";
import { prisma } from "@/lib/db";
import { vanceClientForTenant, TenantNotConfiguredError } from "./tenant-client";
import { VanceError } from "./errors";

const DEFAULT_PROFICIENCY_ID = 25;
// 8vance function-level ids are 29-36 ("Working under supervision" .. senior).
// 31 = "Working independently" — a sane mid default if somehow unset.
const DEFAULT_FUNCTION_LEVEL = 31;

/** Stored as ProjectPool.eightvanceTaskId when the match ran synchronously. */
export const SYNC_TASK_SENTINEL = "__SYNC__";
/** Stored when neither async nor sync matching is available → local ranking. */
export const FALLBACK_TASK_SENTINEL = "__FALLBACK__";

export class MatchPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchPreconditionError";
  }
}

/** Shape we expect inside `Project.skillsJson` (Prisma typed it `Json`). */
export interface ProjectSkillRow {
  id: number;
  name?: string;
  proficiency_id?: number;
  must_have?: boolean;
}

/**
 * Shape we expect inside `Project.languagesJson` (the wizard persists
 * `{ id, name }` per language — see projects/new/actions.ts `languageSchema`).
 * No proficiency is collected, so the client defaults the level on attach.
 */
export interface ProjectLanguageRow {
  id: number;
  name?: string;
}

export interface PoolSyncOutcome {
  tenantId: string;
  tenantSlug: string;
  jobId: number | null;
  taskId: string | null;
  /**
   * MATCHING — a fresh match was kicked off.
   * READY    — the kickoff failed BUT the pool already had cached matches, so
   *            we preserved them instead of wiping a working shortlist (a failed
   *            refresh must never destroy a project that previously matched).
   * FAILED   — the kickoff failed and there was nothing to fall back to.
   */
  status: "MATCHING" | "READY" | "FAILED";
  error?: string;
}

export interface SyncResult {
  pools: PoolSyncOutcome[];
}

/**
 * Optional, in-memory-only signals threaded into the immediate sync. These are
 * deliberately NOT persisted on the Project (no schema column) — they shape the
 * job that gets created right now. The wizard collects `minYearsExperience`
 * (0/1/2/3/5/8/10+) on the role step and passes it here.
 */
export interface SyncOptions {
  /** Minimum years of experience the role expects (0/undefined = no minimum). */
  minYearsExperience?: number;
}

function isProjectSkillRow(v: unknown): v is ProjectSkillRow {
  return (
    typeof v === "object" &&
    v !== null &&
    "id" in v &&
    typeof (v as { id: unknown }).id === "number" &&
    Number.isFinite((v as { id: number }).id)
  );
}

function parseSkills(raw: unknown): ProjectSkillRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isProjectSkillRow);
}

function isProjectLanguageRow(v: unknown): v is ProjectLanguageRow {
  return (
    typeof v === "object" &&
    v !== null &&
    "id" in v &&
    typeof (v as { id: unknown }).id === "number" &&
    Number.isFinite((v as { id: number }).id) &&
    (v as { id: number }).id > 0
  );
}

/**
 * Build the job-language sub-resource inputs from `Project.languagesJson`.
 * Defensive: a non-array or rows missing a numeric id are dropped (never
 * throws). The client expands the (absent) proficiency onto read/write/speak
 * levels.
 */
function parseLanguages(raw: unknown): JobLanguageInput[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: JobLanguageInput[] = [];
  for (const row of raw) {
    if (!isProjectLanguageRow(row)) continue;
    const id = Number(row.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ language: id });
  }
  return out;
}

/**
 * Build the job-education-degree sub-resource input from
 * `Project.educationLevel`. The wizard stores the education-degree id as a
 * STRING (e.g. "42") or "" for "no preference". Defensive: anything that does
 * not resolve to a positive integer yields no requirement (never throws).
 */
function parseEducationDegrees(raw: string | null | undefined): JobEducationDegreeInput[] {
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const id = Number(trimmed);
  if (!Number.isInteger(id) || id <= 0) return [];
  return [{ degree_id: id }];
}

// 8vance rejects coordinates with >4 decimal places. Clamp defensively so a
// stale/high-precision stored value can never 400 the job-create call.
function clampCoord(raw: string | null | undefined, fallback: string): string {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return n.toFixed(4);
}

/**
 * Push the given project to 8vance across every configured pool. Throws
 * `MatchPreconditionError` on validation gaps the user can fix in the
 * wizard. Per-pool credential/transport failures are caught and surfaced
 * inside the returned outcome (status='FAILED') instead of aborting the
 * whole sync.
 */
export async function syncProjectToVance(
  projectId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  if (!projectId) {
    throw new MatchPreconditionError("syncProjectToVance: projectId is required");
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      userId: true,
      title: true,
      functionNameId: true,
      functionLevel: true,
      locationCity: true,
      locationCountry: true,
      locationLat: true,
      locationLng: true,
      skillsJson: true,
      languagesJson: true,
      educationLevel: true,
      pools: {
        select: {
          id: true,
          tenantId: true,
          eightvanceJobId: true,
          eightvanceTaskId: true,
          status: true,
          tenant: {
            select: {
              slug: true,
              eightvanceCompanyId: true,
              // talentScope ('FULL' | 'LOCAL') is applied downstream in
              // hydrate.ts (results filtered to locally-registered talents),
              // not here — the match always kicks off against all sources.
              talentScope: true,
              ownSourceSlug: true,
            },
          },
        },
      },
    },
  });

  if (!project) {
    throw new MatchPreconditionError(`Project ${projectId} not found`);
  }
  if (project.pools.length === 0) {
    throw new MatchPreconditionError("Project has no talent pools configured.");
  }
  if (project.functionNameId === null || project.functionNameId === undefined) {
    throw new MatchPreconditionError(
      "Please pick a function name before starting matching.",
    );
  }
  if (!project.locationCity || !project.locationCountry) {
    throw new MatchPreconditionError(
      "Please add a city and country before starting matching.",
    );
  }

  const skillRows = parseSkills(project.skillsJson);
  if (skillRows.length < 3) {
    throw new MatchPreconditionError(
      `At least 3 skills are required to start matching (got ${skillRows.length}).`,
    );
  }

  // 8vance's match-completeness gate requires at least ONE must_have skill.
  // If the user marked none, promote ONLY THE FIRST to must_have — enough to
  // satisfy the gate while leaving the rest nice-to-have. (Previously we forced
  // ALL skills to must_have, which over-constrained the matcher: a 4-skill job
  // became 4 hard requirements at experience>=5, so even a ~20k-talent pool
  // returned 0 — a real bug, not "no suitable talent". One hard must-have keeps
  // the net wide while still running the matcher.)
  const anyMustHave = skillRows.some((s) => s.must_have === true);

  // Optional minimum years of experience (wizard role step, in-memory only).
  // When set (>0), stamp it onto each skill's `experience` so the created
  // 8vance job carries the requirement. When unset, leave `experience`
  // undefined — the client defaults it (5) on attach, preserving prior
  // behaviour exactly.
  const rawMinYears = options.minYearsExperience;
  const minYears =
    typeof rawMinYears === "number" && Number.isFinite(rawMinYears) && rawMinYears > 0
      ? Math.min(50, Math.round(rawMinYears))
      : undefined;

  const skills: JobSkillInput[] = skillRows.map((s, i) => ({
    skill: s.id,
    proficiency_id: s.proficiency_id ?? DEFAULT_PROFICIENCY_ID,
    // User-marked must-haves are honoured as-is. When the user marked NONE,
    // promote only the first skill (i === 0) so the gate has its one required
    // must_have without turning every skill into a hard filter.
    must_have: anyMustHave ? (s.must_have ?? false) : i === 0,
    ...(minYears !== undefined ? { experience: minYears } : {}),
  }));

  // Wizard step 4: language + education preferences. Both are optional —
  // parsed defensively so an empty/garbled value simply yields no extra
  // requirement and matching still runs (these never block job creation).
  const languages = parseLanguages(project.languagesJson);
  const educationDegrees = parseEducationDegrees(project.educationLevel);

  const outcomes: PoolSyncOutcome[] = [];

  for (const pool of project.pools) {
    try {
      const client = await vanceClientForTenant(pool.tenantId);

      let jobId = pool.eightvanceJobId ?? null;
      if (jobId === null) {
        const payload: JobCreatePayload = {
          company: pool.tenant.eightvanceCompanyId,
          title: project.title,
          function_level: project.functionLevel ?? DEFAULT_FUNCTION_LEVEL,
          function_name: project.functionNameId,
          status: 1,
          detailed_location: {
            city: project.locationCity,
            country: project.locationCountry,
            language_code: "en",
            latitude: clampCoord(project.locationLat, "0"),
            longitude: clampCoord(project.locationLng, "0"),
          },
          skills,
          // Empty arrays are harmless (client loops are no-ops), so we always
          // pass them — populated only when the wizard collected values.
          languages,
          education_degrees: educationDegrees,
        };
        const created = await client.job.create(payload);
        jobId = created.id;
        await prisma.projectPool.update({
          where: { id: pool.id },
          data: { eightvanceJobId: jobId },
        });
      }

      // Match `sources` MUST be the pool's own source SLUG (string) — NOT empty
      // and NOT a numeric id. VERIFIED live: `{"sources":[]}` / numeric ids both
      // 401 "Found invalid sources or not enough privileges", while the own
      // source slug returns 200 + talents. (The admin `talentScope` only drives
      // the /app/candidates LIST, never narrows matching.)
      // Try async; fall back to sync when the credential lacks async scope.
      // For sync we store a sentinel task id so hydrate knows to call the
      // synchronous results endpoint instead of polling.
      const matchSources = pool.tenant.ownSourceSlug ? [pool.tenant.ownSourceSlug] : [];
      const started = await client.match.start(jobId, matchSources);
      const taskId =
        started.mode === "async"
          ? started.taskId
          : started.mode === "sync"
            ? SYNC_TASK_SENTINEL
            : FALLBACK_TASK_SENTINEL;

      await prisma.projectPool.update({
        where: { id: pool.id },
        data: {
          eightvanceTaskId: taskId,
          status: "MATCHING",
          // Stamp the match-start so a wedged pool (async task never completes /
          // executor dies) can be swept back to a settled state. See
          // sweepStaleProjectPools.
          matchStartedAt: new Date(),
        },
      });

      outcomes.push({
        tenantId: pool.tenantId,
        tenantSlug: pool.tenant.slug,
        jobId,
        taskId,
        status: "MATCHING",
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[job-sync] pool ${pool.tenantId} (${pool.tenant.slug}) failed: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      // Non-destructive refresh: if this pool ALREADY has cached matches, a
      // failed re-kickoff (transient 8vance hiccup, or a creds/scope rejection)
      // must NOT wipe a working shortlist. Keep the existing matches by
      // reverting the pool to READY rather than FAILED. Only flip to FAILED
      // when there's nothing to preserve (first-ever match never succeeded).
      const cached = await prisma.match
        .count({ where: { projectId: project.id, tenantId: pool.tenantId } })
        .catch(() => 0);
      const preserved = cached > 0;
      const errLabel =
        err instanceof TenantNotConfiguredError
          ? "Tenant missing credentials"
          : err instanceof VanceError
            ? "8vance API error"
            : "internal";
      await prisma.projectPool
        .update({
          where: { id: pool.id },
          data: { status: preserved ? "READY" : "FAILED" },
        })
        .catch(() => {});
      outcomes.push({
        tenantId: pool.tenantId,
        tenantSlug: pool.tenant.slug,
        jobId: pool.eightvanceJobId ?? null,
        taskId: null,
        status: preserved ? "READY" : "FAILED",
        error: preserved
          ? `refresh failed (${errLabel}); kept ${cached} cached matches`
          : errLabel,
      });
    }
  }

  // Roll Project.status up: MATCHING if any pool started a fresh match; else
  // READY if any pool has (preserved) matches; FAILED only when every pool
  // failed with nothing cached.
  const anyMatching = outcomes.some((o) => o.status === "MATCHING");
  const anyReady = outcomes.some((o) => o.status === "READY");
  await prisma.project.update({
    where: { id: project.id },
    data: { status: anyMatching ? "MATCHING" : anyReady ? "READY" : "FAILED" },
  });

  return { pools: outcomes };
}

/**
 * Minutes a ProjectPool may sit in MATCHING before the stale-sweep gives up on
 * it. The status poller re-drives hydration for a live async task on every tick,
 * so a genuinely-processing task settles well within this; the bound only exists
 * to recover a pool whose 8vance async task never completes, or whose executor
 * died before flipping the pool to READY/FAILED. A touch higher than the
 * candidate-run 6-minute budget since project async matching can run longer.
 */
const PROJECT_POOL_STALE_MINUTES = 10;

/**
 * Recompute a Project's rolled-up status from its pools. ONLY touches a project
 * that is currently MATCHING — never clobbers a DRAFT/READY/ARCHIVED/CLOSED
 * project (those are user/lifecycle states the sweep must not overwrite).
 */
async function rollUpProjectStatus(projectId: string): Promise<void> {
  const proj = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true, pools: { select: { status: true } } },
  });
  if (!proj || proj.status !== "MATCHING") return;
  const anyMatching = proj.pools.some((p) => p.status === "MATCHING");
  const anyReady = proj.pools.some((p) => p.status === "READY");
  const next = anyMatching ? "MATCHING" : anyReady ? "READY" : "FAILED";
  if (next === "MATCHING") return; // still legitimately matching
  await prisma.project
    .update({ where: { id: projectId }, data: { status: next } })
    .catch(() => {});
}

/**
 * Recover ProjectPools wedged in MATCHING past PROJECT_POOL_STALE_MINUTES (or
 * legacy rows with no `matchStartedAt`). Mirrors `sweepStaleRuns` for the
 * candidate side: a project match whose async task never completed would
 * otherwise spin "Matching…" forever, with no recovery path. Preserves a pool's
 * cached shortlist (→ READY) when it has Match rows, else marks it FAILED, then
 * rolls up each affected project's status. Best-effort; never throws. Called
 * from the shortlist status poller (per-project) and the cleanup cron (global).
 * Returns the number of pools swept.
 */
export async function sweepStaleProjectPools(projectId?: string): Promise<number> {
  const cutoff = new Date(Date.now() - PROJECT_POOL_STALE_MINUTES * 60 * 1000);
  const stale = await prisma.projectPool
    .findMany({
      where: {
        status: "MATCHING",
        OR: [{ matchStartedAt: { lt: cutoff } }, { matchStartedAt: null }],
        ...(projectId ? { projectId } : {}),
      },
      select: { id: true, projectId: true, tenantId: true },
    })
    .catch(() => [] as { id: string; projectId: string; tenantId: string }[]);
  if (stale.length === 0) return 0;

  const affected = new Set<string>();
  for (const pool of stale) {
    // Preserve a working shortlist: a pool that already has cached matches goes
    // READY (not FAILED) so the recruiter keeps seeing them.
    const cached = await prisma.match
      .count({ where: { projectId: pool.projectId, tenantId: pool.tenantId } })
      .catch(() => 0);
    await prisma.projectPool
      .update({
        where: { id: pool.id },
        data: { status: cached > 0 ? "READY" : "FAILED" },
      })
      .catch(() => {});
    affected.add(pool.projectId);
  }
  for (const pid of affected) await rollUpProjectStatus(pid);
  return stale.length;
}
