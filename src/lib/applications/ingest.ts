/**
 * Inbound applications ingest.
 *
 * A talent with an 8vance career-portal account who LIKES/APPLIES to one of OUR
 * published jobs surfaces on `GET /feedback/?job_id=&direction=1`. We read that
 * signal per project pool and auto-add the applicant to the project's pipeline:
 *
 *   - IDENTITY IS FREE. The talent self-applied, so consent is implicit. We
 *     create a 0-credit Reveal (`source: 'application'`) holding the encrypted
 *     PII payload. The existing Phase-2 project-shared reveal READ path then
 *     renders the identity — no RevealLock is claimed (no exclusivity for a free
 *     application reveal) and the credit ledger is NEVER touched.
 *   - The applicant lands AUTO in the project pipeline at the INFLOW stage with
 *     `ShortlistEntry.appliedAt` set (drives the "Gesolliciteerd" badge).
 *   - OWN-POOL ONLY: a cross-tenant talent (not part of our source / not
 *     fetchable with the tenant creds) is dropped — we never fetch or show a
 *     talent that doesn't belong to our pool.
 *
 * Idempotent + best-effort per applicant: a second run adds nothing, and one
 * applicant failing must not sink the batch. CLOSED/ARCHIVED projects ingest
 * nothing. Respects the 8vance rate limit via bounded per-applicant concurrency.
 */

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import { vanceClientForTenant } from '@/lib/eightvance/tenant-client';
import { anonymize, assertNoPII } from '@/lib/anonymize/talent';
import { buildRevealed } from '@/lib/anonymize/reveal';
import { notify } from '@/lib/notifications/deliver';
import { reportError } from '@/lib/observability/report';
import { getOrCreateStages, resolveEntryStageId } from '@/lib/pipeline';
import { getOrCreateUserOrg } from '@/lib/org';
import { ShortlistStage } from '@prisma/client';
import { pLimit } from '@/lib/match/concurrency';
import type {
  RawTalent,
  RawTalentEducation,
  RawTalentExperience,
  RawTalentLanguage,
  RawTalentSkill,
} from '@/lib/anonymize/types';

type VanceClient = Awaited<ReturnType<typeof vanceClientForTenant>>;

interface JobSkillEntry {
  id: number;
  name: string;
  must_have: boolean;
}

/** Reveal TTL for a free application reveal: effectively permanent (10y). */
const APPLICATION_REVEAL_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;
/** Match-cache TTL, mirrors hydrate's MATCH_TTL_MS (24h). */
const MATCH_TTL_MS = 24 * 60 * 60 * 1000;
/** Bounded per-applicant fetch concurrency — same posture as hydrate (5). */
const FETCH_CONCURRENCY = 5;

export interface IngestResult {
  /** Newly-added applicants this run (created Match + ShortlistEntry). */
  added: number;
  /** Applicants seen on the feed but skipped (already present / not own-pool). */
  skipped: number;
  /** Per-pool errors (best-effort; the batch keeps going). */
  errors: number;
}

/**
 * Ingest inbound applications for a single project. Iterates the project's
 * pools, lists `direction=1` feedback for each pool's 8vance job, and for every
 * NEW own-pool applicant creates the anonymized Match + the free application
 * reveal + an Inflow ShortlistEntry, then notifies the owner once.
 */
export async function ingestApplicationsForProject(
  projectId: string,
): Promise<IngestResult> {
  const result: IngestResult = { added: 0, skipped: 0, errors: 0 };

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      title: true,
      status: true,
      skillsJson: true,
      pools: {
        select: {
          id: true,
          tenantId: true,
          eightvanceJobId: true,
          tenant: { select: { ownSourceSlug: true } },
        },
      },
    },
  });
  if (!project) return result;

  // CLOSED/ARCHIVED projects ingest nothing (no new candidates, no PII).
  if (project.status === 'CLOSED' || project.status === 'ARCHIVED') {
    return result;
  }
  if (project.pools.length === 0) return result;

  const jobSkills = parseJobSkills(project.skillsJson);
  const hashSecret = process.env.ENCRYPTION_KEY;
  if (!hashSecret) {
    reportError(new Error('ingestApplications: ENCRYPTION_KEY required'), {
      area: 'applications.ingest',
    });
    return result;
  }

  // The Inflow stage id for this org (seeded if absent), resolved once.
  const orgId = project.organizationId ?? (await getOrCreateUserOrg(project.userId));
  const stages = await getOrCreateStages(orgId);
  const inflowStageId =
    resolveEntryStageId(stages, null, ShortlistStage.NEW) ?? stages[0]?.id ?? null;

  let addedThisRun = 0;

  for (const pool of project.pools) {
    if (!pool.eightvanceJobId) {
      continue;
    }
    try {
      const client = await vanceClientForTenant(pool.tenantId);
      const applicants = await client.feedback.listApplicants(pool.eightvanceJobId);
      if (applicants.length === 0) continue;

      // Which applicants already have a Match for this (project,tenant)? Those
      // are candidates for an idempotent ShortlistEntry/Reveal top-up; brand-new
      // ones need the full enrich.
      const incomingIds = applicants.map((a) => a.talentId);
      const existingMatches = await prisma.match.findMany({
        where: {
          projectId: project.id,
          tenantId: pool.tenantId,
          eightvanceTalentId: { in: incomingIds },
        },
        select: { id: true, eightvanceTalentId: true },
      });
      const matchIdByTalent = new Map<number, string>(
        existingMatches.map((m) => [m.eightvanceTalentId, m.id]),
      );

      const limit = pLimit(FETCH_CONCURRENCY);
      await Promise.all(
        applicants.map((applicant) =>
          limit(async () => {
            try {
              const outcome = await ingestApplicant({
                applicant,
                client,
                project: {
                  id: project.id,
                  userId: project.userId,
                  title: project.title,
                },
                tenantId: pool.tenantId,
                ownSourceSlug: pool.tenant?.ownSourceSlug ?? null,
                jobSkills,
                hashSecret,
                inflowStageId,
                existingMatchId: matchIdByTalent.get(applicant.talentId) ?? null,
              });
              if (outcome === 'added') {
                result.added += 1;
                addedThisRun += 1;
              } else {
                result.skipped += 1;
              }
            } catch (err) {
              result.errors += 1;
              reportError(err, {
                area: 'applications.ingest',
                phase: 'applicant',
                tenantId: pool.tenantId,
              });
            }
          }),
        ),
      );
    } catch (err) {
      result.errors += 1;
      reportError(err, {
        area: 'applications.ingest',
        phase: 'pool',
        tenantId: pool.tenantId,
      });
    }
  }

  // Notify the project owner ONCE per run when at least one new applicant landed.
  // Payload carries only ids/counts — never PII.
  if (addedThisRun > 0 && project.userId) {
    await notify({
      userId: project.userId,
      type: 'new_match',
      payload: {
        kind: 'application',
        projectId: project.id,
        projectTitle: project.title,
        count: addedThisRun,
      },
    }).catch(() => {});
  }

  return result;
}

/**
 * On-demand, THROTTLED ingest for the render path (recruiter opens the
 * shortlist/pipeline). Coalesces repeated calls per project and runs the real
 * ingest at most once per {@link ON_DEMAND_THROTTLE_MS} so a page reload / a
 * remounting poller never hammers the 8vance `/feedback/` endpoint. Fire-and-
 * forget + never throws: the caller awaits nothing and the page render is never
 * blocked or broken by an ingest failure.
 */
const ON_DEMAND_THROTTLE_MS = 60_000;
const lastRunAt = new Map<string, number>();
const inflight = new Map<string, Promise<IngestResult>>();

export function ingestApplicationsOnOpen(projectId: string): void {
  const now = Date.now();
  const last = lastRunAt.get(projectId) ?? 0;
  if (now - last < ON_DEMAND_THROTTLE_MS) return;
  if (inflight.has(projectId)) return;
  lastRunAt.set(projectId, now);
  const p = ingestApplicationsForProject(projectId)
    .catch((err) => {
      reportError(err, { area: 'applications.ingest', phase: 'on-demand', projectId });
      return { added: 0, skipped: 0, errors: 1 } as IngestResult;
    })
    .finally(() => inflight.delete(projectId));
  inflight.set(projectId, p);
}

type ApplicantOutcome = 'added' | 'skipped';

interface IngestApplicantOpts {
  applicant: { talentId: number; appliedAt: string | null; applied: boolean };
  client: VanceClient;
  project: { id: string; userId: string; title: string };
  tenantId: string;
  ownSourceSlug: string | null;
  jobSkills: JobSkillEntry[];
  hashSecret: string;
  inflowStageId: string | null;
  /** An existing Match id for this talent (idempotent top-up path), if any. */
  existingMatchId: string | null;
}

/**
 * Ingest one applicant: own-pool gate → enrich → upsert Match → free Reveal →
 * Inflow ShortlistEntry(appliedAt). Returns 'added' only when a NEW pipeline
 * entry was created (so the owner notification count is accurate); 'skipped'
 * when the entry already existed or the talent is not own-pool.
 */
async function ingestApplicant(opts: IngestApplicantOpts): Promise<ApplicantOutcome> {
  const { applicant, client, project, tenantId, jobSkills, hashSecret } = opts;
  const talentId = applicant.talentId;

  // Fast skip: an application ShortlistEntry already exists for this talent on
  // this project → idempotent no-op (covers the "second run adds nothing" case
  // without any 8vance round-trip).
  if (opts.existingMatchId) {
    const existingEntry = await prisma.shortlistEntry.findFirst({
      where: { matchId: opts.existingMatchId, appliedAt: { not: null } },
      select: { id: true },
    });
    if (existingEntry) return 'skipped';
  }

  // OWN-POOL FILTER. Fetch the talent's profile + sub-resources with the tenant
  // creds. A cross-tenant talent isn't fetchable (404/empty profile) → drop. We
  // additionally require the talent's source slugs to include the pool's own
  // source when that slug is configured, so an external-feed talent that somehow
  // appears on the feed never gets pulled in.
  const profile = await client.talent.getProfile(talentId).catch(() => null);
  if (!profile || !isOwnPoolProfile(profile, talentId)) {
    return 'skipped';
  }
  if (opts.ownSourceSlug) {
    const sources = await client.talent.getSources(talentId).catch(() => [] as string[]);
    if (!sources.includes(opts.ownSourceSlug)) {
      return 'skipped';
    }
  }

  const [skills, experience, education, languages, location] = await Promise.all([
    client.talent.getSkills(talentId).catch(() => []),
    client.talent.getExperience(talentId).catch(() => []),
    client.talent.getEducation(talentId).catch(() => []),
    client.talent.getLanguages(talentId).catch(() => []),
    client.talent.getLocation(talentId).catch(() => null),
  ]);

  const raw = buildRawTalent(talentId, profile, skills, experience, education, languages, location);

  // Anonymized Match payload — same anonymize()/assertNoPII contract as hydrate.
  const anonymized = anonymize(raw, { tenantId, hashSecret, jobSkills });
  assertNoPII(anonymized);
  const skillGap = anonymized.skills.filter((s) => s.gap).map((s) => s.name);
  const now = new Date();

  // Upsert the Match (idempotent on the unique key). Keep the score from the
  // anonymized payload (an application has no native match score).
  const match = await prisma.match.upsert({
    where: {
      projectId_tenantId_eightvanceTalentId: {
        projectId: project.id,
        tenantId,
        eightvanceTalentId: talentId,
      },
    },
    create: {
      projectId: project.id,
      tenantId,
      eightvanceTalentId: talentId,
      opaqueId: anonymized.opaque_id,
      score: anonymized.score ?? 0,
      anonymizedPayloadJson: anonymized as unknown as Prisma.InputJsonValue,
      skillGapJson: skillGap as unknown as Prisma.InputJsonValue,
      fetchedAt: now,
      expiresAt: new Date(now.getTime() + MATCH_TTL_MS),
    },
    update: {},
    select: { id: true },
  });

  // FREE application reveal: identity shown at 0 credit, NO lock, NO ledger.
  // Idempotent — only create when no application reveal exists yet for this
  // (project, tenant, talent). The Phase-2 read path renders any non-expired
  // reveal for (projectId, talentId), so this is all that's needed to show PII.
  const existingReveal = await prisma.reveal.findFirst({
    where: {
      projectId: project.id,
      tenantId,
      eightvanceTalentId: talentId,
      source: 'application',
    },
    select: { id: true },
  });
  if (!existingReveal) {
    const revealed = buildRevealed(raw);
    await prisma.reveal.create({
      data: {
        projectId: project.id,
        // The reveal is OWNED by the project owner for audit purposes, but it is
        // a shared, free, lock-less reveal (creditCost 0). No CreditTransaction
        // is written — the ledger is untouched.
        userId: project.userId,
        tenantId,
        eightvanceTalentId: talentId,
        creditCost: 0,
        source: 'application',
        expiresAt: new Date(now.getTime() + APPLICATION_REVEAL_TTL_MS),
        piiPayloadEnc: encrypt(JSON.stringify(revealed)),
      },
    });
  }

  // Inflow ShortlistEntry with appliedAt → drives the "Gesolliciteerd" badge.
  // Owned by the project owner (the pipeline is org-shared). Idempotent on the
  // (userId, matchId) unique key; on a pre-existing entry we only STAMP
  // appliedAt (never downgrade the recruiter's stage choice).
  const appliedAt = parseDate(applicant.appliedAt) ?? now;
  const existingEntry = await prisma.shortlistEntry.findUnique({
    where: { userId_matchId: { userId: project.userId, matchId: match.id } },
    select: { id: true, appliedAt: true },
  });
  if (existingEntry) {
    if (existingEntry.appliedAt == null) {
      await prisma.shortlistEntry.update({
        where: { id: existingEntry.id },
        data: { appliedAt },
      });
      return 'added';
    }
    return 'skipped';
  }

  await prisma.shortlistEntry.create({
    data: {
      userId: project.userId,
      matchId: match.id,
      stage: ShortlistStage.NEW,
      ...(opts.inflowStageId ? { stageId: opts.inflowStageId } : {}),
      appliedAt,
    },
  });
  return 'added';
}

/**
 * Own-pool confidence check on a fetched profile. A successful, non-empty
 * profile whose id matches the requested talent is treated as own-pool (the
 * tenant creds + CompanyIdGate already refuse foreign-company responses; a
 * cross-tenant talent simply 404s and never reaches here).
 */
function isOwnPoolProfile(profile: unknown, talentId: number): boolean {
  if (!profile || typeof profile !== 'object') return false;
  const rec = profile as Record<string, unknown>;
  const id = Number(rec.id ?? rec.talent_id);
  if (Number.isFinite(id) && id > 0) return id === talentId;
  // No id on the row — accept (the gate already vetted the company); the fetch
  // succeeding at all is the own-pool signal.
  return true;
}

function buildRawTalent(
  talentId: number,
  profile: Record<string, unknown> | null,
  skills: Array<Record<string, unknown>>,
  experience: Array<Record<string, unknown>>,
  education: Array<Record<string, unknown>>,
  languages: Array<Record<string, unknown>>,
  location: Record<string, unknown> | null,
): RawTalent {
  const p = profile ?? {};
  return {
    id: talentId,
    first_name: stringOrNull(p.first_name),
    last_name: stringOrNull(p.last_name),
    email: stringOrNull(p.email),
    phone: stringOrNull(p.phone),
    function_name: stringOrNull(p.function_name),
    function_level: numberOrNull(p.function_level),
    total_years_experience: numberOrNull(p.total_years_experience),
    hours_per_week: numberOrNull(p.hours_per_week),
    start_date: stringOrNull(p.start_date),
    score: numberOrNull(p.score),
    location: location
      ? {
          city: stringOrNull(location.city),
          country: stringOrNull(location.country),
          province: stringOrNull(location.region) ?? stringOrNull(location.province),
          latitude: location.latitude != null ? Number(location.latitude) : null,
          longitude: location.longitude != null ? Number(location.longitude) : null,
        }
      : null,
    skills: skills.map((s): RawTalentSkill => ({
      skill_id: Number(s.skill ?? s.skill_id),
      name: typeof s.skill_name === 'string' ? s.skill_name : undefined,
      proficiency_id: numberOrNull(s.proficiency_id ?? s.proficiency),
    })),
    experience: experience.map((e): RawTalentExperience => {
      const fn = e.function_name;
      const fnStr = typeof fn === 'string' ? fn : null;
      return {
        function_title:
          stringOrNull(e.function_title) ?? stringOrNull(e.title) ?? fnStr ?? null,
        company_name: stringOrNull(e.company_name),
        start_date: stringOrNull(e.start_date),
        end_date: stringOrNull(e.end_date),
        is_current: e.current_job === true || e.end_date == null,
      };
    }),
    education: education.map((e): RawTalentEducation => {
      const degree = e.degree as { phrase?: unknown } | undefined;
      return {
        level:
          (degree && typeof degree.phrase === 'string' ? degree.phrase : null) ??
          (e.education_degree != null ? String(e.education_degree) : null),
        field_of_study_category:
          stringOrNull(e.education_type) ??
          (e.education_subject != null ? String(e.education_subject) : null),
        school_name: stringOrNull(e.school) ?? stringOrNull(e.institution),
        end_year: yearFrom(stringOrNull(e.end_date)),
      };
    }),
    languages: languages
      .map((l): RawTalentLanguage => ({
        language:
          typeof l.language_name === 'string' && l.language_name.trim()
            ? l.language_name
            : l.language != null
              ? String(l.language)
              : '',
        level: String(l.speak_level ?? l.proficiency_id ?? ''),
      }))
      .filter((l) => l.language.length > 0 && !/^\d+$/.test(l.language)),
  };
}

function parseJobSkills(blob: unknown): JobSkillEntry[] {
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

function parseDate(iso: string | null): Date | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t);
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

function yearFrom(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).getUTCFullYear();
}
