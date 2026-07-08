/**
 * Owner-only candidate profile — the full, polished talent profile rendered on
 * the recruiter's own candidate-detail (match) screen.
 *
 * This is the OWNER path only (the page org-guards: created-by OR same-org).
 * It deliberately shows FULL data (name already in the header; contact, live
 * 8vance snapshot, etc.). It is NOT the anonymized employer shortlist and must
 * never be reused there.
 *
 * Purely presentational + server-safe (no client hooks): it receives already-
 * resolved data + pre-translated labels, so it renders inside the server
 * component and stays trivially testable. Live 8vance data is preferred where
 * present; the page falls back to the stored profileJson values it passes in.
 */
import { ProficiencyMeter } from '@/components/proficiency-meter';
import type {
  LiveSkill,
  LiveEducation,
  LiveExperience,
  LiveLanguage,
  LiveLocation,
  DataQuality,
} from '@/lib/candidate/profile-extras';

/** Stored profileJson fallbacks (used when the live read is empty). */
export interface StoredProfile {
  about: string | null;
  hardSkills: string[];
  softSkills: string[];
  knowledge: string[];
  education: {
    degree?: string;
    field?: string;
    institution?: string;
    startYear?: string;
    endYear?: string;
  }[];
  employment: {
    title?: string;
    company?: string;
    startYear?: string;
    endYear?: string;
    current?: boolean;
    description?: string;
  }[];
  languages: { name: string; level?: number }[];
  certifications: { name?: string; issuer?: string; year?: string }[];
  location: { city?: string; region?: string; country?: string } | null;
  email: string | null;
  phone: string | null;
}

/** Live snapshot subset the component renders (already normalized). */
export interface LiveProfile {
  skills: LiveSkill[];
  education: LiveEducation[];
  experience: LiveExperience[];
  languages: LiveLanguage[];
  location: LiveLocation | null;
  reachable: boolean;
}

/** All visible strings, pre-translated by the page (next-intl t()). */
export interface ProfileLabels {
  about: string;
  skills: string;
  hardSkills: string;
  softSkills: string;
  knowledge: string;
  education: string;
  employment: string;
  languages: string;
  certifications: string;
  location: string;
  contact: string;
  email: string;
  phone: string;
  current: string;
  level: (level: number) => string;
  liveBadge: string;
  storedBadge: string;
  // Data-quality strip
  dqTitle: string;
  dqSynced: string;
  dqNotSynced: string;
  dqHasName: string;
  dqNoName: string;
  dqMatchable: string;
  dqNotMatchable: string;
  dqMatchableUnknown: string;
  dqSkills: (count: number) => string;
  syncedBadge: (talentId: number) => string;
  notSyncedBadge: string;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--ft-muted)]">
        {title}
      </h2>
      <div className="mt-2 text-[var(--ft-ink)]">{children}</div>
    </section>
  );
}

function yearRange(
  start: string | null | undefined,
  end: string | null | undefined,
  current: boolean | undefined,
  currentLabel: string,
): string | null {
  const tail = current ? currentLabel : (end ?? '');
  if (start && tail) return `${start} – ${tail}`;
  return start || tail || null;
}

/** Live-or-stored sync badge for the header. */
export function SyncBadge({
  talentId,
  labels,
}: {
  talentId: number | null;
  labels: Pick<ProfileLabels, 'syncedBadge' | 'notSyncedBadge'>;
}): React.ReactElement {
  if (talentId == null) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--ft-border)] bg-[var(--ft-surface-2)] px-2.5 py-1 text-[11px] font-medium text-[var(--ft-muted)]">
        {labels.notSyncedBadge}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ft-accent-strong)]">
      <span aria-hidden="true">✓</span>
      {labels.syncedBadge(talentId)}
    </span>
  );
}

/** Compact data-quality strip: synced? · has name? · matchable? · #skills. */
export function DataQualityStrip({
  quality,
  labels,
}: {
  quality: DataQuality;
  labels: ProfileLabels;
}): React.ReactElement {
  const items: { ok: boolean | null; text: string }[] = [
    { ok: quality.synced, text: quality.synced ? labels.dqSynced : labels.dqNotSynced },
    { ok: quality.hasName, text: quality.hasName ? labels.dqHasName : labels.dqNoName },
    {
      ok: quality.matchable,
      text:
        quality.matchable === null
          ? labels.dqMatchableUnknown
          : quality.matchable
            ? labels.dqMatchable
            : labels.dqNotMatchable,
    },
    { ok: quality.skillCount > 0, text: labels.dqSkills(quality.skillCount) },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ft-muted)]">
        {labels.dqTitle}
      </span>
      {items.map((it, i) => {
        const tone =
          it.ok === null
            ? 'border-[var(--ft-border)] text-[var(--ft-muted)]'
            : it.ok
              ? 'border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] text-[var(--ft-accent-strong)]'
              : 'border-[var(--ft-gap-line)] bg-[var(--ft-gap-soft)] text-[var(--ft-gap)]';
        return (
          <span
            key={i}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${tone}`}
          >
            <span aria-hidden="true">{it.ok === null ? '·' : it.ok ? '✓' : '!'}</span>
            {it.text}
          </span>
        );
      })}
    </div>
  );
}

function SkillBucket({
  label,
  live,
  stored,
}: {
  label: string;
  live: LiveSkill[];
  stored: string[];
}): React.ReactElement | null {
  if (live.length === 0 && stored.length === 0) return null;
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium text-[var(--ft-muted)]">{label}</p>
      {live.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {live.map((s, i) => (
            <li
              key={`${s.name}-${i}`}
              className="flex items-center justify-between gap-3 rounded-lg border border-[var(--ft-border)] bg-[var(--ft-surface)] px-2.5 py-1.5"
            >
              <span className="truncate text-xs font-medium text-[var(--ft-ink)]">
                {s.name}
              </span>
              {s.proficiencyLabel && <ProficiencyMeter label={s.proficiencyLabel} />}
            </li>
          ))}
        </ul>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {stored.map((s, i) => (
            <li
              key={`${s}-${i}`}
              className="rounded-full border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-2.5 py-1 text-xs font-medium text-[var(--ft-accent-strong)]"
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The full owner profile body. Renders About, Skills (live-resolved when
 * available, else stored buckets), Education, Work experience, Languages,
 * Certifications, Location and Contact.
 */
export function CandidateProfile({
  stored,
  live,
  labels,
}: {
  stored: StoredProfile;
  live: LiveProfile;
  labels: ProfileLabels;
}): React.ReactElement {
  // Group live skills by their bucket hint; unbucketed live skills fall under
  // "hard" so they always surface.
  const liveHard = live.skills.filter((s) => s.bucket === 'hard' || s.bucket === null);
  const liveSoft = live.skills.filter((s) => s.bucket === 'soft');
  const liveKnowledge = live.skills.filter((s) => s.bucket === 'knowledge');
  const hasSkills =
    live.skills.length > 0 ||
    stored.hardSkills.length > 0 ||
    stored.softSkills.length > 0 ||
    stored.knowledge.length > 0;

  const education = live.education.length > 0 ? live.education : null;
  const experience = live.experience.length > 0 ? live.experience : null;
  const languages = live.languages.length > 0 ? live.languages : null;
  const location = live.location ?? (stored.location
    ? {
        city: stored.location.city ?? null,
        region: stored.location.region ?? null,
        country: stored.location.country ?? null,
      }
    : null);
  const locationLabel = location
    ? [location.city, location.region, location.country].filter(Boolean).join(', ')
    : null;
  const hasContact = !!stored.email || !!stored.phone;

  return (
    <div className="space-y-6 text-sm">
      {stored.about && <Section title={labels.about}>
        <p className="leading-relaxed">{stored.about}</p>
      </Section>}

      {hasSkills && (
        <Section title={labels.skills}>
          {live.skills.length > 0 && (
            <span className="mb-2 inline-block rounded-full border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ft-accent-strong)]">
              {labels.liveBadge}
            </span>
          )}
          <div className="space-y-3">
            <SkillBucket label={labels.hardSkills} live={liveHard} stored={stored.hardSkills} />
            <SkillBucket label={labels.softSkills} live={liveSoft} stored={stored.softSkills} />
            <SkillBucket
              label={labels.knowledge}
              live={liveKnowledge}
              stored={stored.knowledge}
            />
          </div>
        </Section>
      )}

      {(experience || stored.employment.length > 0) && (
        <Section title={labels.employment}>
          <ul className="space-y-3">
            {(experience ?? stored.employment.map((e) => ({
              title: e.title ?? null,
              company: e.company ?? null,
              startYear: e.startYear ?? null,
              endYear: e.endYear ?? null,
              current: e.current === true,
              description: e.description ?? null,
            }))).map((e, i) => {
              const range = yearRange(e.startYear, e.endYear, e.current, labels.current);
              return (
                <li key={i} className="border-l-2 border-[var(--ft-border)] pl-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {[e.title, e.company].filter(Boolean).join(' · ') || '—'}
                    </span>
                    {range && <span className="text-xs text-[var(--ft-muted)]">{range}</span>}
                  </div>
                  {e.description && (
                    <p className="mt-1 text-[var(--ft-muted)]">{e.description}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {(education || stored.education.length > 0) && (
        <Section title={labels.education}>
          <ul className="space-y-2">
            {(education ?? stored.education.map((e) => ({
              degree: e.degree ?? null,
              field: e.field ?? null,
              school: e.institution ?? null,
              startYear: e.startYear ?? null,
              endYear: e.endYear ?? null,
            }))).map((e, i) => {
              const range = yearRange(e.startYear, e.endYear, false, labels.current);
              return (
                <li key={i} className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    {[e.degree, e.field].filter(Boolean).join(' — ') || e.school || '—'}
                    {e.school && (e.degree || e.field) && (
                      <span className="text-[var(--ft-muted)]"> · {e.school}</span>
                    )}
                  </span>
                  {range && <span className="text-xs text-[var(--ft-muted)]">{range}</span>}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {(languages || stored.languages.length > 0) && (
        <Section title={labels.languages}>
          <ul className="flex flex-wrap gap-2">
            {(languages ?? stored.languages.map((l) => ({
              name: l.name,
              level: typeof l.level === 'number' ? l.level : null,
            }))).map((l, i) => (
              <li
                key={`${l.name}-${i}`}
                className="rounded-full border border-[var(--ft-border)] px-3 py-1 text-xs"
              >
                {l.name}
                {typeof l.level === 'number' && (
                  <span className="text-[var(--ft-muted)]"> · {labels.level(l.level)}</span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {stored.certifications.length > 0 && (
        <Section title={labels.certifications}>
          <ul className="space-y-1">
            {stored.certifications.map((c, i) => (
              <li key={i} className="flex flex-wrap items-baseline justify-between gap-2">
                <span>{[c.name, c.issuer].filter(Boolean).join(' · ')}</span>
                {c.year && <span className="text-xs text-[var(--ft-muted)]">{c.year}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {locationLabel && (
        <Section title={labels.location}>
          <p>{locationLabel}</p>
        </Section>
      )}

      {hasContact && (
        <Section title={labels.contact}>
          <dl className="grid gap-1">
            {stored.email && (
              <div className="flex gap-2">
                <dt className="text-[var(--ft-muted)]">{labels.email}:</dt>
                <dd>
                  <a
                    className="text-[var(--ft-accent-strong)] underline-offset-2 hover:underline"
                    href={`mailto:${stored.email}`}
                  >
                    {stored.email}
                  </a>
                </dd>
              </div>
            )}
            {stored.phone && (
              <div className="flex gap-2">
                <dt className="text-[var(--ft-muted)]">{labels.phone}:</dt>
                <dd>
                  <a
                    className="text-[var(--ft-accent-strong)] underline-offset-2 hover:underline"
                    href={`tel:${stored.phone}`}
                  >
                    {stored.phone}
                  </a>
                </dd>
              </div>
            )}
          </dl>
        </Section>
      )}
    </div>
  );
}
