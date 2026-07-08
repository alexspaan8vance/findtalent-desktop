/**
 * Server-side skill-name → 8vance taxonomy-id resolution for the PUBLIC
 * self-onboard portal.
 *
 * The portal is unauthed, so it can NOT call the authed
 * /api/candidates/extract-skills route from the browser. But the portal SUBMIT
 * runs server-side (in `submitPortalCvOnboardingAction`), where a tenant 8vance
 * client IS available. This helper mirrors the resolution logic of that route:
 * it runs the pluggable CV extractor, then resolves each returned skill NAME
 * against `/resources/skill/` (scoped to the tenant) with bounded concurrency,
 * keeping only hits whose taxonomy name actually corresponds to the term
 * (`nameMatchesTerm`).
 *
 * Server-only: imports the 8vance client + the LLM extractor (Node runtime, the
 * keys must stay server-side). Never throws — a resolve failure simply yields
 * fewer (or zero) skills, and the caller decides what to do with an empty set.
 */
import 'server-only';

import { vanceClientForTenant } from '@/lib/eightvance/tenant-client';
import { extractCvProfile, type CvProfile } from '@/lib/candidate/cv-ai';
import { nameMatchesTerm } from '@/lib/candidate/cv-extract';
import { skillNameCandidates } from '@/lib/eightvance/client';

export interface ResolvedSkill {
  /** 8vance numeric taxonomy id (→ TalentCreatePayload.skills[].skill). */
  id: number;
  /** Canonical taxonomy name (for UI / logging). */
  name: string;
}

export interface ResolvedCvProfile {
  /** Resolved, deduped skills (across all buckets). */
  skills: ResolvedSkill[];
  /** Contact details the extractor found in the CV (best-effort). */
  email?: string;
  phone?: string;
  /** Which extractor produced the profile (claude | openai | regex). */
  source: CvProfile['source'];
  /**
   * The full extracted CV profile (education, employment, languages, certs,
   * about). The portal must persist this under profileJson.cv so the 8vance
   * sync can create education/work-experience sub-resources — otherwise that
   * rich data is silently dropped on the self-onboard path.
   */
  profile: CvProfile;
  /**
   * True when the tenant 8vance client could not authenticate (broken/placeholder
   * creds). Lets the caller distinguish "creds broken → 0 skills" from "CV had
   * no recognizable skills", and surface the right error.
   */
  authFailed?: boolean;
}

/** Max distinct skills resolved per submit (keeps cost + payload bounded). */
const MAX_RESOLVED = 30;
/** Concurrent skill searches against the 8vance taxonomy. */
const CONCURRENCY = 6;

/**
 * Extract a categorized profile from `cvText` and resolve its skill NAMES to
 * 8vance taxonomy ids, scoped to `tenantId`. `locale` steers the skill search
 * (NL/EN/DE). Returns the resolved skills plus any contact details found.
 */
export async function resolveCvSkillsForTenant(
  tenantId: string,
  cvText: string,
  locale = 'nl',
): Promise<ResolvedCvProfile> {
  const profile = await extractCvProfile(cvText);
  const contact: { email?: string; phone?: string } = {};
  if (profile.email) contact.email = profile.email;
  if (profile.phone) contact.phone = profile.phone;

  // Flatten all buckets into a deduped term list (the portal stores a single
  // skills array; bucket grouping isn't persisted in profileJson).
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const bucket of [profile.hardSkills, profile.knowledge, profile.softSkills]) {
    for (const raw of bucket) {
      const key = raw.toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      terms.push(raw);
    }
  }

  if (terms.length === 0) {
    return { skills: [], source: profile.source, profile, ...contact };
  }

  let client: Awaited<ReturnType<typeof vanceClientForTenant>>;
  try {
    client = await vanceClientForTenant(tenantId);
  } catch {
    // Tenant creds missing/broken → can't resolve. Flag it so the caller shows
    // a "8vance auth failed" message instead of a misleading "no skills".
    return { skills: [], source: profile.source, profile, authFailed: true, ...contact };
  }

  const byId = new Map<number, ResolvedSkill>();
  let authError = false;
  for (let i = 0; i < terms.length && byId.size < MAX_RESOLVED; i += CONCURRENCY) {
    const batch = terms.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (term) => {
        try {
          // A CV skill is often a Dutch TASK phrase ("Elektrische installaties
          // aanleggen") that `/resources/skill/?q=` matches 0 rows for. Try
          // progressively-generic candidates (full phrase → noun core → head
          // tokens) until one yields a taxonomy hit that actually relates
          // (nameMatchesTerm against the candidate searched). Stops at the first
          // candidate that resolves.
          let match: { id: number; name: string } | undefined;
          for (const candidate of skillNameCandidates(term)) {
            const hits = await client.resources.searchSkills(candidate, 3, locale);
            match = hits.find(
              (h) => typeof h.name === 'string' && nameMatchesTerm(candidate, h.name),
            );
            if (match) break;
          }
          if (match && typeof match.id === 'number' && !byId.has(match.id)) {
            byId.set(match.id, { id: match.id, name: String(match.name) });
          }
        } catch (err) {
          // skip this term — best-effort resolution. But if the call failed on
          // auth (broken tenant creds), remember it: an all-empty result then
          // means "creds broken", not "no skills in the CV".
          const status = (err as { status?: number })?.status;
          if (status === 401 || status === 403) authError = true;
        }
      }),
    );
  }

  const resolved = [...byId.values()];
  return {
    skills: resolved,
    source: profile.source,
    profile,
    authFailed: resolved.length === 0 && authError ? true : undefined,
    ...contact,
  };
}
