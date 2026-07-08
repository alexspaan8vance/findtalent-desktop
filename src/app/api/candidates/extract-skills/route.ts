import type { NextRequest } from 'next/server';

import { NextResponse } from 'next/server';

import { requireApiUser } from '../../refdata/_shared';
import { jsonOk, jsonError } from '../../refdata/_shared';
import { vanceClientForTenant } from '@/lib/eightvance/tenant-client';
import { nameMatchesTerm } from '@/lib/candidate/cv-extract';
import { skillNameCandidates } from '@/lib/eightvance/client';
import { extractCvProfile, type CvProfile } from '@/lib/candidate/cv-ai';
import { consumeCvRate, cvRateKey } from '@/lib/candidate/cv-ratelimit';
import { trustedClientIp } from '@/lib/client-ip';
import { csrfCheck } from '@/lib/csrf';

// Node runtime: the LLM SDKs and 8vance client run server-side.
export const runtime = 'nodejs';

interface SkillHit {
  id: number;
  name: string;
  /**
   * Inferred proficiency level (1..5) from CV signals, when the CV carried a
   * real signal for this skill. Omitted when unknown — the wizard then leaves
   * the skill's proficiency UNSET rather than faking a mid-tier 3.
   */
  level?: number;
}

type Bucket = 'hard' | 'soft' | 'knowledge';

/**
 * POST /api/candidates/extract-skills?tenantId=...&locale=nl
 * Body: { cvText: string }
 *
 * Pulls a CATEGORIZED candidate profile (hard/soft/knowledge skills + contact)
 * from CV text via the pluggable LLM extractor (Claude → OpenAI → regex), then
 * resolves each returned skill NAME against the 8vance skill taxonomy (scoped to
 * the tenant), preserving the bucket grouping.
 *
 * Returns:
 *   { results: SkillHit[]            // flat, back-compat with the old contract
 *   , grouped: { hard, soft, knowledge }  // same SkillHit objects, grouped
 *   , email?, phone? }
 *
 * Best-effort: a term that resolves to nothing relevant is simply dropped.
 */
export async function POST(req: NextRequest) {
  // CSRF: reject a cross-site Origin/Referer before doing any work (F8).
  const csrf = csrfCheck(req);
  if (csrf) return csrf;

  const auth = await requireApiUser(req, { candidates: true });
  if (auth.kind === 'response') return auth.response;

  // Rate-limit per user (this route fans out to paid OpenAI + 8vance).
  const rate = await consumeCvRate(cvRateKey({ userId: auth.userId, ip: trustedClientIp(req.headers) }));
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSec) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('invalid_body');
  }
  const b = (body ?? {}) as { cvText?: unknown; skills?: unknown };
  const cvText = b.cvText;
  // Optional pre-extracted skill NAMES (e.g. from the 8vance CV parser) — when
  // present we resolve those directly and skip the LLM/regex extraction.
  const presetSkills = Array.isArray(b.skills)
    ? b.skills.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : null;
  const emptyResult = {
    results: [],
    grouped: { hard: [], soft: [], knowledge: [] },
    unresolved: [] as string[],
  };
  if (!presetSkills && (typeof cvText !== 'string' || cvText.trim().length < 10)) {
    return jsonOk(emptyResult);
  }

  const locale = (req.nextUrl.searchParams.get('locale') ?? 'nl').toLowerCase();

  const profile = presetSkills
    ? {
        fullName: undefined as string | undefined,
        about: undefined as string | undefined,
        hardSkills: presetSkills,
        softSkills: [] as string[],
        knowledge: [] as string[],
        languages: [] as CvProfile['languages'],
        education: [] as CvProfile['education'],
        employment: [] as CvProfile['employment'],
        certifications: [] as CvProfile['certifications'],
        location: undefined as CvProfile['location'],
        email: undefined as string | undefined,
        phone: undefined as string | undefined,
        // Preset (8vance-parser) skills carry no CV text → no inferred levels.
        skillLevels: undefined as CvProfile['skillLevels'],
        source: '8vance' as const,
      }
    : await extractCvProfile(cvText as string);
  const contact: { email?: string; phone?: string } = {};
  if (profile.email) contact.email = profile.email;
  if (profile.phone) contact.phone = profile.phone;
  // Candidate's home city (place of residence) parsed from the CV, if any. The
  // wizard resolves this against the location refdata to pre-fill the location.
  const city = profile.location?.city?.trim() || undefined;

  // Flatten into (term, bucket) pairs, deduping terms across buckets (first
  // bucket wins) so we don't resolve the same name twice.
  const seenTerm = new Set<string>();
  const pairs: Array<{ term: string; bucket: Bucket }> = [];
  const pushBucket = (terms: string[], bucket: Bucket) => {
    for (const t of terms) {
      const key = t.toLowerCase().trim();
      if (!key || seenTerm.has(key)) continue;
      seenTerm.add(key);
      pairs.push({ term: t, bucket });
    }
  };
  pushBucket(profile.hardSkills, 'hard');
  pushBucket(profile.softSkills, 'soft');
  pushBucket(profile.knowledge, 'knowledge');

  if (pairs.length === 0) {
    // Still surface the parsed name/contact so the wizard prefills them even
    // when the CV yielded no resolvable skill terms.
    return jsonOk({
      ...emptyResult,
      ...(profile.fullName ? { fullName: profile.fullName } : {}),
      ...(city ? { city } : {}),
      ...contact,
    });
  }

  try {
    const client = await vanceClientForTenant(auth.tenantId);
    const byId = new Map<number, SkillHit>();
    const grouped: Record<Bucket, SkillHit[]> = { hard: [], soft: [], knowledge: [] };
    // Names that were searched but produced no taxonomy match — surfaced so the
    // recruiter/UI can see what got dropped instead of failing silently.
    const unresolved: string[] = [];
    // Tracks whether the taxonomy search failed on AUTH (broken tenant creds).
    // Lets the wizard show "8vance auth failed — check tenant credentials"
    // instead of the misleading "no skills recognized / minimum 3".
    let authError = false;
    const MAX_RESOLVED = 30;
    const CONC = 6;

    for (let i = 0; i < pairs.length && byId.size < MAX_RESOLVED; i += CONC) {
      const batch = pairs.slice(i, i + CONC);
      await Promise.all(
        batch.map(async ({ term, bucket }) => {
          try {
            // A CV skill is often a Dutch TASK phrase ("Elektrische installaties
            // aanleggen") that `/resources/skill/?q=` matches 0 rows for, so it
            // gets dropped. Try progressively-generic candidates (full phrase →
            // noun core → head tokens) until one yields a taxonomy hit that
            // actually relates (nameMatchesTerm against the candidate searched —
            // not the full phrase, so a sensible parent skill still passes the
            // length guard). Stops at the first candidate that resolves.
            let match: { id: number; name: string } | undefined;
            for (const candidate of skillNameCandidates(term)) {
              const hits = await client.resources.searchSkills(candidate, 3, locale);
              match = hits.find(
                (h) => typeof h.name === 'string' && nameMatchesTerm(candidate, h.name),
              );
              if (match) break;
            }
            if (match && typeof match.id === 'number' && !byId.has(match.id)) {
              // Carry the conservatively-inferred proficiency level for this CV
              // term (keyed by lowercased name); omitted when the CV had no
              // signal, so the wizard leaves it unknown rather than faking a 3.
              const inferred = profile.skillLevels?.[term.toLowerCase().trim()];
              const hit: SkillHit = {
                id: match.id,
                name: String(match.name),
                ...(typeof inferred === 'number' ? { level: inferred } : {}),
              };
              byId.set(match.id, hit);
              grouped[bucket].push(hit);
            } else if (!match) {
              // No taxonomy hit corresponded to this term — record it.
              unresolved.push(term);
            }
            // (a `match` that collides with an already-seen id is treated as
            // resolved, not unresolved — the skill is already in the list.)
          } catch (err) {
            // search failed for this term → treat as unresolved, not silent.
            unresolved.push(term);
            const status = (err as { status?: number })?.status;
            if (status === 401 || status === 403) authError = true;
          }
        }),
      );
    }

    // Carry the rich profile fields (about/education/employment/certifications/
    // languages) so the wizard can store the full "super volledig" profile.
    const rich = {
      about: profile.about,
      languages: profile.languages,
      education: profile.education,
      employment: profile.employment,
      certifications: profile.certifications,
    };
    return jsonOk({
      results: [...byId.values()],
      grouped,
      unresolved,
      // The parsed candidate name, so the wizard can prefill the Name field
      // from a pasted CV (email/phone already prefill via ...contact below).
      ...(profile.fullName ? { fullName: profile.fullName } : {}),
      // Candidate's home city, so the wizard can pre-fill the location field.
      ...(city ? { city } : {}),
      // Only flag auth failure when it actually blocked resolution (no hits).
      ...(byId.size === 0 && authError ? { authFailed: true } : {}),
      ...contact,
      profile: rich,
    });
  } catch {
    return jsonError('extract_failed');
  }
}
