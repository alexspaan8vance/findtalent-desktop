'use client';

/**
 * Owner-only candidate EDIT mode for the match screen.
 *
 * Lets the recruiter adjust the candidate's EXISTING 8vance talent (the
 * candidate is already synced; eightvanceTalentId is set): add/remove skills,
 * add a work-experience row, add an education row (school + dates only — the
 * 8vance API can't persist degree/field yet), and edit the about/notes blurb.
 * Saving calls the org-guarded `updateTalentAction` server action; on success
 * the route is revalidated so the live snapshot re-renders.
 *
 * OWNER path only — this must never be reused in the anonymized employer
 * shortlist. Matches the read-only CandidateProfile design tokens (var(--ft-*))
 * and the ProficiencyMeter visual language.
 */
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

import { ProficiencyMeter } from '@/components/proficiency-meter';
import type {
  TalentEditPayload,
  UpdateTalentResult,
} from '@/app/app/candidates/[id]/match/actions';

const MAX_ABOUT_LEN = 2000;

/** A removable current skill (junction-row id + display name + stars). */
export interface EditableSkill {
  rowId: number | null;
  name: string;
  proficiencyLabel: string;
  /** Current proficiency on the 1..5 scale (0 when unknown). */
  proficiencyLevel: number;
  /** Skill taxonomy id (for the proficiency remove-then-add fallback). */
  skillId: number | null;
}

export interface CandidateEditorLabels {
  title: string;
  edit: string;
  cancel: string;
  save: string;
  saving: string;
  saved: string;
  errFailed: string;
  errPartial: string;
  // Skills
  skillsTitle: string;
  skillAddPlaceholder: string;
  skillAdd: string;
  skillSearching: string;
  skillNoResults: string;
  skillRemove: string;
  skillRemoveUnavailable: string;
  pendingAdd: string;
  pendingRemove: string;
  // NOTE: the parameterized proficiency labels (skillLevelAria/skillLevel) are
  // NOT passed as function props — functions can't cross the server→client RSC
  // boundary (caused error digest 3046561624). They're translated client-side
  // below via useTranslations('candidateMatch.edit').
  // Experience
  expTitle: string;
  expRole: string;
  expCompany: string;
  expStart: string;
  expEnd: string;
  expCurrent: string;
  expDescription: string;
  expAdd: string;
  // Education
  eduTitle: string;
  eduSchool: string;
  eduStart: string;
  eduEnd: string;
  eduAdd: string;
  eduApiNote: string;
  // About
  aboutTitle: string;
  aboutHint: string;
}

interface SkillSuggestion {
  id: number;
  name: string;
}

const fieldClass =
  'w-full rounded-lg border border-[var(--ft-border)] bg-[var(--ft-surface-2)] px-3 py-2 text-sm text-[var(--ft-ink)] outline-none focus:border-[var(--ft-accent)]';
const labelClass = 'mb-1 block text-[11px] font-medium text-[var(--ft-muted)]';
const primaryBtn =
  'rounded-md border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-3 py-1 text-xs font-semibold text-[var(--ft-accent-strong)] transition disabled:opacity-60';
const ghostBtn =
  'rounded-md border border-[var(--ft-border)] px-3 py-1 text-xs font-medium text-[var(--ft-muted)] transition hover:border-[var(--ft-border-strong)] disabled:opacity-60';

export function CandidateEditor({
  candidateId,
  initialAbout,
  currentSkills,
  locale,
  labels,
  save,
}: {
  candidateId: string;
  initialAbout: string;
  /** Live skills with junction-row ids (null rowId → removal unavailable). */
  currentSkills: EditableSkill[];
  /** Active locale for the skill autocomplete (e.g. "nl"). */
  locale: string;
  labels: CandidateEditorLabels;
  /** Bound server action (kept in the page's actions.ts). */
  save: (
    candidateId: string,
    payload: TalentEditPayload,
  ) => Promise<UpdateTalentResult>;
}): React.ReactElement {
  // Parameterized proficiency labels translated client-side (can't be passed as
  // function props across the RSC boundary — see CandidateEditorLabels note).
  const tEdit = useTranslations('candidateMatch.edit');
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<
    { kind: 'ok' } | { kind: 'error'; text: string } | null
  >(null);

  // Pending edits (not yet saved).
  const [about, setAbout] = useState(initialAbout);
  const [skillsToAdd, setSkillsToAdd] = useState<string[]>([]);
  const [skillRowIdsToRemove, setSkillRowIdsToRemove] = useState<number[]>([]);
  // Pending proficiency edits, keyed by junction-row id → new 1..5 level.
  const [skillLevels, setSkillLevels] = useState<Record<number, number>>({});

  // Skill autocomplete state.
  const [skillQuery, setSkillQuery] = useState('');
  const [suggestions, setSuggestions] = useState<SkillSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  // Experience draft.
  const [exp, setExp] = useState({
    title: '',
    company: '',
    startYear: '',
    endYear: '',
    current: false,
    description: '',
  });
  const [pendingExp, setPendingExp] = useState<typeof exp | null>(null);

  // Education draft.
  const [edu, setEdu] = useState({ institution: '', startYear: '', endYear: '' });
  const [pendingEdu, setPendingEdu] = useState<typeof edu | null>(null);

  function reset(): void {
    setAbout(initialAbout);
    setSkillsToAdd([]);
    setSkillRowIdsToRemove([]);
    setSkillLevels({});
    setSkillQuery('');
    setSuggestions([]);
    setSearched(false);
    setExp({ title: '', company: '', startYear: '', endYear: '', current: false, description: '' });
    setPendingExp(null);
    setEdu({ institution: '', startYear: '', endYear: '' });
    setPendingEdu(null);
    setStatus(null);
  }

  async function runSearch(): Promise<void> {
    const q = skillQuery.trim();
    if (q.length < 2) return;
    setSearching(true);
    setSearched(true);
    try {
      const res = await fetch(
        `/api/refdata/skill?q=${encodeURIComponent(q)}&locale=${encodeURIComponent(locale)}`,
      );
      const data = (await res.json()) as { results?: SkillSuggestion[] };
      setSuggestions(Array.isArray(data.results) ? data.results : []);
    } catch {
      setSuggestions([]);
    } finally {
      setSearching(false);
    }
  }

  function addSkillName(name: string): void {
    const n = name.trim();
    if (!n) return;
    setSkillsToAdd((prev) =>
      prev.some((s) => s.toLowerCase() === n.toLowerCase()) ? prev : [...prev, n],
    );
    setSkillQuery('');
    setSuggestions([]);
    setSearched(false);
  }

  function onSave(): void {
    setStatus(null);
    const payload: TalentEditPayload = {};
    if (skillsToAdd.length > 0) payload.addSkills = skillsToAdd;
    if (skillRowIdsToRemove.length > 0) payload.removeSkillRowIds = skillRowIdsToRemove;
    // Proficiency edits: only rows whose level actually changed AND that aren't
    // queued for removal. Level 1..5 → proficiency_id 23..27.
    const updateSkills = currentSkills
      .filter(
        (s) =>
          s.rowId != null &&
          skillLevels[s.rowId] !== undefined &&
          skillLevels[s.rowId] !== s.proficiencyLevel &&
          !skillRowIdsToRemove.includes(s.rowId),
      )
      .map((s) => ({
        rowId: s.rowId as number,
        proficiencyId: 22 + skillLevels[s.rowId as number],
        skillId: s.skillId,
        name: s.name,
      }));
    if (updateSkills.length > 0) payload.updateSkills = updateSkills;
    if (pendingExp) {
      payload.addExperience = [
        {
          title: pendingExp.title || null,
          company: pendingExp.company || null,
          startYear: pendingExp.startYear || null,
          endYear: pendingExp.endYear || null,
          current: pendingExp.current,
          description: pendingExp.description || null,
        },
      ];
    }
    if (pendingEdu) {
      payload.addEducation = [
        {
          institution: pendingEdu.institution || null,
          startYear: pendingEdu.startYear || null,
          endYear: pendingEdu.endYear || null,
        },
      ];
    }
    if (about.trim() !== initialAbout.trim()) payload.about = about.trim();

    if (Object.keys(payload).length === 0) {
      setEditing(false);
      return;
    }

    startTransition(async () => {
      const result = await save(candidateId, payload);
      if (result.ok) {
        setStatus({ kind: 'ok' });
        setEditing(false);
        reset();
      } else if (result.reason === 'sync_failed') {
        setStatus({ kind: 'error', text: labels.errPartial });
      } else {
        setStatus({ kind: 'error', text: labels.errFailed });
      }
    });
  }

  if (!editing) {
    return (
      <div className="mt-4 flex items-center gap-3">
        <button type="button" onClick={() => setEditing(true)} className={ghostBtn}>
          {labels.edit}
        </button>
        {status?.kind === 'ok' && (
          <span className="text-xs font-medium text-[var(--ft-accent-strong)]">
            {labels.saved}
          </span>
        )}
        {status?.kind === 'error' && (
          <span role="alert" className="text-xs font-medium text-red-600">
            {status.text}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-5 rounded-xl border border-[var(--ft-accent-line)] bg-[var(--ft-surface-2)] p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--ft-accent-strong)]">
        {labels.title}
      </h3>

      {/* Skills */}
      <section>
        <p className={labelClass}>{labels.skillsTitle}</p>
        <ul className="flex flex-col gap-1.5">
          {currentSkills.map((s, i) => {
            const marked = s.rowId != null && skillRowIdsToRemove.includes(s.rowId);
            // Editable level: pending override if set, else the current level.
            const level =
              s.rowId != null && skillLevels[s.rowId] !== undefined
                ? skillLevels[s.rowId]
                : s.proficiencyLevel;
            const canEditLevel = s.rowId != null && !marked;
            return (
              <li
                key={`${s.name}-${i}`}
                className={`flex items-center justify-between gap-3 rounded-lg border border-[var(--ft-border)] bg-[var(--ft-surface)] px-2.5 py-1.5 ${marked ? 'opacity-50 line-through' : ''}`}
              >
                <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-[var(--ft-ink)]">
                  <span className="truncate">{s.name}</span>
                  {canEditLevel ? (
                    <span className="flex items-center gap-1" aria-label={tEdit('skillLevelAria', { skill: s.name })}>
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          type="button"
                          aria-pressed={n <= level}
                          title={tEdit('skillLevel', { level: n })}
                          onClick={() =>
                            setSkillLevels((prev) => ({ ...prev, [s.rowId as number]: n }))
                          }
                          className={`h-3.5 w-3.5 rounded-full border transition ${
                            n <= level
                              ? 'border-[var(--ft-accent-line)] bg-[var(--ft-accent-strong)]'
                              : 'border-[var(--ft-border)] bg-[var(--ft-surface-2)] hover:border-[var(--ft-accent)]'
                          }`}
                        >
                          <span className="sr-only">{tEdit('skillLevel', { level: n })}</span>
                        </button>
                      ))}
                    </span>
                  ) : (
                    s.proficiencyLabel && <ProficiencyMeter label={s.proficiencyLabel} />
                  )}
                </span>
                {s.rowId != null ? (
                  <button
                    type="button"
                    onClick={() =>
                      setSkillRowIdsToRemove((prev) =>
                        prev.includes(s.rowId as number)
                          ? prev.filter((r) => r !== s.rowId)
                          : [...prev, s.rowId as number],
                      )
                    }
                    className="text-[11px] font-medium text-[var(--ft-muted)] underline-offset-2 hover:text-red-600 hover:underline"
                  >
                    {labels.skillRemove}
                  </button>
                ) : (
                  <span
                    className="text-[11px] text-[var(--ft-muted)]"
                    title={labels.skillRemoveUnavailable}
                  >
                    {labels.skillRemoveUnavailable}
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        {skillsToAdd.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {skillsToAdd.map((s) => (
              <li
                key={s}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-2.5 py-1 text-xs font-medium text-[var(--ft-accent-strong)]"
              >
                {s}
                <button
                  type="button"
                  aria-label={labels.skillRemove}
                  onClick={() => setSkillsToAdd((prev) => prev.filter((x) => x !== s))}
                  className="text-[var(--ft-accent-strong)]"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={skillQuery}
            onChange={(e) => setSkillQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void runSearch();
              }
            }}
            placeholder={labels.skillAddPlaceholder}
            className={fieldClass}
          />
          <button
            type="button"
            onClick={() => void runSearch()}
            disabled={skillQuery.trim().length < 2 || searching}
            className={ghostBtn}
          >
            {searching ? labels.skillSearching : labels.skillAdd}
          </button>
        </div>
        {searched && !searching && suggestions.length === 0 && (
          <p className="mt-1 text-[11px] text-[var(--ft-muted)]">{labels.skillNoResults}</p>
        )}
        {suggestions.length > 0 && (
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => addSkillName(s.name)}
                  className="rounded-full border border-[var(--ft-border)] px-2.5 py-1 text-xs text-[var(--ft-ink)] transition hover:border-[var(--ft-accent)]"
                >
                  + {s.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Work experience */}
      <section>
        <p className={labelClass}>{labels.expTitle}</p>
        {pendingExp ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-2.5 py-1.5 text-xs text-[var(--ft-accent-strong)]">
            <span className="truncate">
              {[pendingExp.title, pendingExp.company].filter(Boolean).join(' · ') || '—'}
            </span>
            <button type="button" onClick={() => setPendingExp(null)} className="font-medium">
              ×
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelClass}>{labels.expRole}</label>
                <input
                  type="text"
                  value={exp.title}
                  onChange={(e) => setExp({ ...exp, title: e.target.value })}
                  className={fieldClass}
                />
              </div>
              <div>
                <label className={labelClass}>{labels.expCompany}</label>
                <input
                  type="text"
                  value={exp.company}
                  onChange={(e) => setExp({ ...exp, company: e.target.value })}
                  className={fieldClass}
                />
              </div>
              <div>
                <label className={labelClass}>{labels.expStart}</label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="2019"
                  value={exp.startYear}
                  onChange={(e) => setExp({ ...exp, startYear: e.target.value })}
                  className={fieldClass}
                />
              </div>
              <div>
                <label className={labelClass}>{labels.expEnd}</label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="2023"
                  disabled={exp.current}
                  value={exp.endYear}
                  onChange={(e) => setExp({ ...exp, endYear: e.target.value })}
                  className={`${fieldClass} disabled:opacity-60`}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-[var(--ft-ink)]">
              <input
                type="checkbox"
                checked={exp.current}
                onChange={(e) => setExp({ ...exp, current: e.target.checked })}
              />
              {labels.expCurrent}
            </label>
            <div>
              <label className={labelClass}>{labels.expDescription}</label>
              <textarea
                rows={2}
                value={exp.description}
                onChange={(e) => setExp({ ...exp, description: e.target.value })}
                className={`${fieldClass} resize-y`}
              />
            </div>
            <button
              type="button"
              onClick={() => {
                if (exp.title.trim() || exp.company.trim()) setPendingExp(exp);
              }}
              disabled={!exp.title.trim() && !exp.company.trim()}
              className={ghostBtn}
            >
              {labels.expAdd}
            </button>
          </div>
        )}
      </section>

      {/* Education */}
      <section>
        <p className={labelClass}>{labels.eduTitle}</p>
        {pendingEdu ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--ft-accent-line)] bg-[var(--ft-accent-soft)] px-2.5 py-1.5 text-xs text-[var(--ft-accent-strong)]">
            <span className="truncate">{pendingEdu.institution || '—'}</span>
            <button type="button" onClick={() => setPendingEdu(null)} className="font-medium">
              ×
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <div>
              <label className={labelClass}>{labels.eduSchool}</label>
              <input
                type="text"
                value={edu.institution}
                onChange={(e) => setEdu({ ...edu, institution: e.target.value })}
                className={fieldClass}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelClass}>{labels.eduStart}</label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="2014"
                  value={edu.startYear}
                  onChange={(e) => setEdu({ ...edu, startYear: e.target.value })}
                  className={fieldClass}
                />
              </div>
              <div>
                <label className={labelClass}>{labels.eduEnd}</label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="2018"
                  value={edu.endYear}
                  onChange={(e) => setEdu({ ...edu, endYear: e.target.value })}
                  className={fieldClass}
                />
              </div>
            </div>
            <p className="text-[11px] text-[var(--ft-muted)]">{labels.eduApiNote}</p>
            <button
              type="button"
              onClick={() => {
                if (edu.institution.trim()) setPendingEdu(edu);
              }}
              disabled={!edu.institution.trim()}
              className={ghostBtn}
            >
              {labels.eduAdd}
            </button>
          </div>
        )}
      </section>

      {/* About */}
      <section>
        <p className={labelClass}>{labels.aboutTitle}</p>
        <textarea
          rows={4}
          maxLength={MAX_ABOUT_LEN}
          value={about}
          onChange={(e) => setAbout(e.target.value)}
          placeholder={labels.aboutHint}
          className={`${fieldClass} resize-y`}
        />
        <span className="mt-1 block text-right text-[11px] text-[var(--ft-muted)] tabular-nums">
          {about.length}/{MAX_ABOUT_LEN}
        </span>
      </section>

      <div className="flex items-center justify-between gap-2">
        {status?.kind === 'error' ? (
          <span role="alert" className="text-xs font-medium text-red-600">
            {status.text}
          </span>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              reset();
              setEditing(false);
            }}
            disabled={pending}
            className={ghostBtn}
          >
            {labels.cancel}
          </button>
          <button type="button" onClick={onSave} disabled={pending} className={primaryBtn}>
            {pending ? labels.saving : labels.save}
          </button>
        </div>
      </div>
    </div>
  );
}
