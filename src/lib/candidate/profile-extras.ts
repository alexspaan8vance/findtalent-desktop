/**
 * Server-side enrichment for the OWNER's candidate-detail (match) page.
 *
 * The match page already renders a CV-profiel panel from the stored
 * `profileJson.cv`. This helper adds two things the owner needs to trust that
 * a candidate "came over well" into 8vance:
 *
 *   1. A best-effort snapshot of the LIVE synced talent (profile + skills +
 *      education + experience + languages + location) read through the tenant
 *      8vance client (`vanceClientForTenant`). Each sub-read is independently
 *      try/caught so a single 8vance hiccup never blocks the page — the page
 *      falls back to the stored profileJson.
 *   2. A small data-quality verdict (synced? · has name? · matchable? · #skills)
 *      derived from that snapshot.
 *
 * Server-only: imports the 8vance tenant client. Never throws — every public
 * function resolves to a safe, partial result on any failure.
 */
import 'server-only';

import { vanceClientForTenant } from '@/lib/eightvance/tenant-client';
import type {
  TalentProfile,
  TalentSkill,
  TalentEducation,
  TalentExperience,
  TalentLanguage,
  TalentLocation,
} from '@/lib/eightvance/types';

/** A resolved live skill row, normalized for the UI (name + 1..5 star label). */
export interface LiveSkill {
  /** Best-effort resolved skill name (live `skill_name` extra, else "#<id>"). */
  name: string;
  /** Star string for the ProficiencyMeter, e.g. "⭐⭐⭐" (0..5 stars). */
  proficiencyLabel: string;
  /** Bucket hint derived from the live `extra_data` boolean flags, when present. */
  bucket: 'hard' | 'soft' | 'knowledge' | null;
}

/** A normalized live education row. */
export interface LiveEducation {
  degree: string | null;
  field: string | null;
  school: string | null;
  startYear: string | null;
  endYear: string | null;
}

/** A normalized live work-experience row. */
export interface LiveExperience {
  title: string | null;
  company: string | null;
  startYear: string | null;
  endYear: string | null;
  current: boolean;
  description: string | null;
}

/** A normalized live language row. */
export interface LiveLanguage {
  name: string;
  /** 1..5 spoken level when known, else null. */
  level: number | null;
}

/** A normalized live location row. */
export interface LiveLocation {
  city: string | null;
  region: string | null;
  country: string | null;
}

/** The owner-only "did this come over well?" data-quality verdict. */
export interface DataQuality {
  synced: boolean;
  hasName: boolean;
  /** participate_in_matching on the live talent (null = unknown / not fetched). */
  matchable: boolean | null;
  skillCount: number;
}

/** Best-effort live snapshot of the synced 8vance talent. */
export interface LiveTalent {
  profile: TalentProfile | null;
  skills: LiveSkill[];
  education: LiveEducation[];
  experience: LiveExperience[];
  languages: LiveLanguage[];
  location: LiveLocation | null;
  sources: string[];
  /** True when at least one live read returned data (drives the synced ✓ badge). */
  reachable: boolean;
}

/**
 * 8vance proficiency id table (23..27 → 1..5). Mirrors the public table; kept
 * local so this owner-only enrichment never imports the anonymize layer.
 */
function proficiencyStars(id: number | null | undefined): string {
  switch (id) {
    case 23:
      return '⭐';
    case 24:
      return '⭐⭐';
    case 25:
      return '⭐⭐⭐';
    case 26:
      return '⭐⭐⭐⭐';
    case 27:
      return '⭐⭐⭐⭐⭐';
    default:
      // Unknown / non-canonical proficiency → empty meter, never a fake mid ⭐⭐⭐.
      return '';
  }
}

function toYear(date: string | null | undefined): string | null {
  if (!date) return null;
  const m = String(date).match(/(\d{4})/);
  return m ? m[1] : null;
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

/**
 * Bucket a live talent skill from its 8vance `extra_data` boolean flags,
 * mirroring `classifySkill` in eightvance/client.ts. The live talent-skill
 * shape has NO `extra_data.category` string — it carries `soft_transferrable`
 * / `domain_specific` booleans, so the old category read mislabeled every live
 * skill 'hard'. Returns null only when there's no extra_data to classify from.
 *   - soft_transferrable → 'soft'   (transferable / soft skill)
 *   - domain_specific    → 'hard'   (domain-specific competency)
 *   - neither            → 'knowledge'
 */
function bucketOf(s: TalentSkill): LiveSkill['bucket'] {
  const extra = s.extra_data as
    | { soft_transferrable?: boolean; domain_specific?: boolean }
    | null
    | undefined;
  if (!extra) return null;
  if (extra.soft_transferrable) return 'soft';
  if (extra.domain_specific) return 'hard';
  return 'knowledge';
}

function normalizeSkills(rows: TalentSkill[]): LiveSkill[] {
  return rows.map((s) => {
    const name =
      str((s as Record<string, unknown>).skill_name) ??
      str((s as Record<string, unknown>).name) ??
      (typeof s.skill === 'number' ? `#${s.skill}` : 'Skill');
    return {
      name,
      proficiencyLabel: proficiencyStars(s.proficiency_id ?? s.proficiency ?? null),
      bucket: bucketOf(s),
    };
  });
}

function normalizeEducation(rows: TalentEducation[]): LiveEducation[] {
  return rows.map((e) => ({
    degree: str(e.degree?.phrase) ?? null,
    field: str(e.education_type),
    school: str(e.school) ?? str(e.institution),
    startYear: toYear(e.start_date),
    endYear: toYear(e.end_date),
  }));
}

function normalizeExperience(rows: TalentExperience[]): LiveExperience[] {
  return rows.map((x) => ({
    title: str(x.function_title) ?? str(x.title),
    company: str(x.company_name),
    startYear: toYear(x.start_date),
    endYear: toYear(x.end_date),
    current: x.current_job === true,
    description: str(x.description),
  }));
}

function normalizeLanguages(rows: TalentLanguage[]): LiveLanguage[] {
  return rows.map((l) => {
    const lvl = l.speak_level ?? l.read_level ?? l.write_level ?? null;
    return {
      name: str(l.language_name) ?? (l.language != null ? `#${l.language}` : 'Language'),
      level: typeof lvl === 'number' && lvl >= 1 && lvl <= 5 ? lvl : null,
    };
  });
}

function normalizeLocation(loc: TalentLocation | null): LiveLocation | null {
  if (!loc) return null;
  const out = {
    city: str(loc.city),
    region: str(loc.region),
    country: str(loc.country),
  };
  return out.city || out.region || out.country ? out : null;
}

/**
 * Read a best-effort live snapshot of the synced 8vance talent. Every sub-read
 * is independent + try/caught: a partial 8vance outage degrades to fewer
 * sections, never an error. Returns an all-empty snapshot when the candidate
 * isn't synced or the tenant client can't be built.
 */
export async function fetchLiveTalent(
  tenantId: string | null,
  talentId: number | null,
): Promise<LiveTalent> {
  const empty: LiveTalent = {
    profile: null,
    skills: [],
    education: [],
    experience: [],
    languages: [],
    location: null,
    sources: [],
    reachable: false,
  };
  if (!tenantId || talentId == null) return empty;

  let client: Awaited<ReturnType<typeof vanceClientForTenant>>;
  try {
    client = await vanceClientForTenant(tenantId);
  } catch {
    return empty;
  }

  const [profile, skills, education, experience, languages, location, sources] =
    await Promise.all([
      client.talent.getProfile(talentId).catch(() => null),
      client.talent.getSkills(talentId).catch(() => [] as TalentSkill[]),
      client.talent.getEducation(talentId).catch(() => [] as TalentEducation[]),
      client.talent.getExperience(talentId).catch(() => [] as TalentExperience[]),
      client.talent.getLanguages(talentId).catch(() => [] as TalentLanguage[]),
      client.talent.getLocation(talentId).catch(() => null),
      client.talent.getSources(talentId).catch(() => [] as string[]),
    ]);

  const reachable =
    profile != null ||
    skills.length > 0 ||
    education.length > 0 ||
    experience.length > 0 ||
    languages.length > 0;

  return {
    profile,
    skills: normalizeSkills(skills),
    education: normalizeEducation(education),
    experience: normalizeExperience(experience),
    languages: normalizeLanguages(languages),
    location: normalizeLocation(location),
    sources,
    reachable,
  };
}

/** Derive the owner data-quality verdict from a live snapshot (best-effort). */
export function dataQualityFrom(
  talentId: number | null,
  live: LiveTalent,
  fallbackSkillCount: number,
): DataQuality {
  const synced = talentId != null;
  // 8vance stores the name split, so a read echoes first_name/last_name and
  // leaves full_name empty — check all three or a synced talent that DOES have
  // a name (created via the split-name path) wrongly shows "Name missing".
  const p = live.profile as
    | { full_name?: unknown; first_name?: unknown; last_name?: unknown }
    | null
    | undefined;
  const hasName = !!(str(p?.full_name) || str(p?.first_name) || str(p?.last_name));
  const matchable =
    live.profile && typeof live.profile.participate_in_matching === 'boolean'
      ? live.profile.participate_in_matching
      : null;
  const skillCount = live.skills.length > 0 ? live.skills.length : fallbackSkillCount;
  return { synced, hasName, matchable, skillCount };
}
