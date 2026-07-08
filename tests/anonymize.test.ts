/**
 * Anonymization pipeline tests.
 *
 * Run with `npx vitest run tests/anonymize.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { assertNoPII, PIILeakError } from '../src/lib/anonymize/blocklist';
import {
  cityToProvinceNL,
  durationBucket,
  experienceYearsBucket,
  hoursBucket,
  languageLevelLabel,
  proficiencyLabel,
  sectorFromCompanyName,
  startWithinDaysBucket,
} from '../src/lib/anonymize/buckets';
import { buildRevealed } from '../src/lib/anonymize/reveal';
import { scrubFreeText } from '../src/lib/anonymize/scrub';
import { anonymize, buildOpaqueId, displaySkillName } from '../src/lib/anonymize/talent';
import type { RawTalent } from '../src/lib/anonymize/types';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeRaw(overrides: Partial<RawTalent> = {}): RawTalent {
  return {
    id: 42424242,
    first_name: 'Jan',
    last_name: 'de Vries',
    email: 'jan.devries@example.com',
    phone: '+31 6 12345678',
    date_of_birth: '1990-05-15',
    cv_url: 'https://8vance.example/cv/42424242.pdf',
    linkedin_url: 'https://linkedin.com/in/jandevries',
    photo_url: 'https://8vance.example/photo/42.jpg',
    function_name: 'Software Engineer',
    function_level: 4,
    total_years_experience: 7,
    hours_per_week: 40,
    start_date: new Date(Date.now() + 45 * 86400_000).toISOString(),
    score: 87,
    location: {
      city: 'Eindhoven',
      country: 'Netherlands',
      province: null,
      postal_code: '5611 AB',
      street: 'Hoofdstraat 1',
      latitude: 51.4416,
      longitude: 5.4697,
    },
    skills: [
      { skill_id: 101, name: 'Python', proficiency_id: 27 },
      { skill_id: 102, name: 'Kubernetes', proficiency_id: 25 },
      { skill_id: 103, name: 'PostgreSQL', proficiency_id: 26 },
    ],
    experience: [
      {
        function_title: 'Senior Engineer',
        company_name: 'ASML Manufacturing BV',
        start_date: '2022-01-01',
        end_date: null,
        is_current: true,
      },
      {
        function_title: 'Engineer',
        company_name: 'ING Bank',
        start_date: '2018-03-01',
        end_date: '2021-12-31',
        is_current: false,
      },
      {
        function_title: 'Junior Dev',
        company_name: 'Tech Consulting BV',
        start_date: '2015-06-01',
        end_date: '2018-02-28',
        is_current: false,
      },
      {
        function_title: 'Intern',
        company_name: 'Old Hospital',
        start_date: '2014-09-01',
        end_date: '2015-05-31',
        is_current: false,
      },
    ],
    education: [
      {
        level: 'WO',
        field_of_study_category: 'Computer Science',
        school_name: 'TU Eindhoven',
        end_year: 2014,
      },
    ],
    languages: [
      { language: 'Dutch', level: 'native' },
      { language: 'English', level: 'C1' },
      { language: 'German', level: 'A2' },
    ],
    ...overrides,
  };
}

const OPTS = { tenantId: 'tenant-ivta-34231', hashSecret: 'super-secret-xyz' };

// ---------------------------------------------------------------------------
// PII blocklist
// ---------------------------------------------------------------------------

describe('assertNoPII', () => {
  it('passes for clean object', () => {
    expect(() => assertNoPII({ a: 1, b: { c: ['x', 'y'] } })).not.toThrow();
  });

  it('throws on injected email at depth', () => {
    const evil = { skills: [{ name: 'Python', extra: { email: 'x@y.com' } }] };
    expect(() => assertNoPII(evil)).toThrow(PIILeakError);
  });

  it('throws on email-like value even with a clean key name', () => {
    const evil = { note: 'contact me: alex@example.com please' };
    expect(() => assertNoPII(evil)).toThrow(PIILeakError);
  });

  it('throws on raw "id" key', () => {
    expect(() => assertNoPII({ id: 42 })).toThrow(PIILeakError);
  });

  it('throws on company_name nested in experience', () => {
    const evil = { experience: [{ function_title: 'x', company_name: 'ASML' }] };
    expect(() => assertNoPII(evil)).toThrow(PIILeakError);
  });

  it('throws on a url-shaped value with a clean key name', () => {
    const evil = { title: 'see https://linkedin.com/in/jandevries' };
    expect(() => assertNoPII(evil)).toThrow(PIILeakError);
  });

  it('throws on a phone-shaped value with a clean key name', () => {
    const evil = { note: 'reach me +31 6 12345678 anytime' };
    expect(() => assertNoPII(evil)).toThrow(PIILeakError);
  });

  it('does not flag a normal role title or country label', () => {
    expect(() => assertNoPII({ function_title: 'Software Engineer' })).not.toThrow();
    expect(() => assertNoPII({ country: 'Nederland', year: '2014' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Free-text scrubber
// ---------------------------------------------------------------------------

describe('scrubFreeText', () => {
  it('strips "PA to <Name>" but keeps the role head', () => {
    expect(scrubFreeText('PA to John de Vries')).toBe('PA');
    expect(scrubFreeText('Assistant to Mr. Smith')).toBe('Assistant');
    expect(scrubFreeText('Secretary for Anne-Marie van der Berg')).toBe('Secretary');
  });

  it('preserves a normal generic title', () => {
    expect(scrubFreeText('Software Engineer')).toBe('Software Engineer');
    expect(scrubFreeText('Senior Project Manager')).toBe('Senior Project Manager');
    expect(scrubFreeText('Junior Dev')).toBe('Junior Dev');
  });

  it('strips a bare full-name run that is not role words', () => {
    expect(scrubFreeText('John de Vries')).toBe('');
    expect(scrubFreeText('Engineer (Jan Bakker)')).not.toContain('Jan');
  });

  it('strips embedded contact / id shapes', () => {
    expect(scrubFreeText('Engineer x@y.com')).toBe('Engineer');
    expect(scrubFreeText('Manager www.linkedin.com/in/foo')).toBe('Manager');
    expect(scrubFreeText('Operator badge 1234567')).not.toMatch(/\d/);
  });

  it('falls back to empty when nothing safe survives', () => {
    expect(scrubFreeText('John de Vries')).toBe('');
    expect(scrubFreeText('   ')).toBe('');
    expect(scrubFreeText(null)).toBe('');
  });

  it('scrubs a role-word + surname run (no surname leak)', () => {
    // Bug #4: first word is a role word but the surname must not survive.
    expect(scrubFreeText('Senior Jansen')).not.toContain('Jansen');
    expect(scrubFreeText('Manager Smit')).not.toContain('Smit');
    expect(scrubFreeText('Senior van der Berg')).not.toContain('Berg');
    // genuine all-role-word titles still preserved
    expect(scrubFreeText('Senior Engineer')).toBe('Senior Engineer');
    expect(scrubFreeText('Lead Software Architect')).toBe('Lead Software Architect');
  });
});

// ---------------------------------------------------------------------------
// Core anonymize()
// ---------------------------------------------------------------------------

describe('anonymize()', () => {
  it('produces a payload with NO blocked keys anywhere', () => {
    const raw = makeRaw();
    const anon = anonymize(raw, OPTS);
    expect(() => assertNoPII(anon)).not.toThrow();
  });

  it('opaque_id is deterministic per (tenant, talent, secret)', () => {
    const raw = makeRaw();
    const a = anonymize(raw, OPTS);
    const b = anonymize(raw, OPTS);
    expect(a.opaque_id).toBe(b.opaque_id);
    expect(a.opaque_id.startsWith('anon_')).toBe(true);
  });

  it('opaque_id differs across tenants for same talent', () => {
    const raw = makeRaw();
    const a = anonymize(raw, OPTS);
    const b = anonymize(raw, { ...OPTS, tenantId: 'tenant-other' });
    expect(a.opaque_id).not.toBe(b.opaque_id);
  });

  it('opaque_id differs across secrets', () => {
    const raw = makeRaw();
    const a = buildOpaqueId('t', 1, 's1');
    const b = buildOpaqueId('t', 1, 's2');
    expect(a).not.toBe(b);
  });

  it('truncates experience to 3 most-recent entries, current-first', () => {
    const raw = makeRaw();
    const anon = anonymize(raw, OPTS);
    expect(anon.experience).toHaveLength(3);
    expect(anon.experience[0].is_current).toBe(true);
    expect(anon.experience[0].function_title).toBe('Senior Engineer');
    // 'Intern' is the 4th and must be dropped.
    const titles = anon.experience.map((e) => e.function_title);
    expect(titles).not.toContain('Intern');
  });

  it('scrubs an embedded name out of a function_title', () => {
    const raw = makeRaw({
      experience: [
        {
          function_title: 'PA to John de Vries',
          company_name: 'ASML Manufacturing BV',
          start_date: '2022-01-01',
          end_date: null,
          is_current: true,
        },
      ],
    });
    const anon = anonymize(raw, OPTS);
    expect(anon.experience[0].function_title).toBe('PA');
    const json = JSON.stringify(anon);
    expect(json).not.toContain('John');
    expect(json).not.toContain('Vries');
  });

  it('preserves a normal function_title', () => {
    const raw = makeRaw({
      experience: [
        {
          function_title: 'Software Engineer',
          company_name: 'Some Co',
          start_date: '2022-01-01',
          end_date: null,
          is_current: true,
        },
      ],
    });
    const anon = anonymize(raw, OPTS);
    expect(anon.experience[0].function_title).toBe('Software Engineer');
  });

  it('falls back to Unknown when a title scrubs to nothing', () => {
    const raw = makeRaw({
      experience: [
        {
          function_title: 'Jan Bakker',
          company_name: 'Some Co',
          start_date: '2022-01-01',
          end_date: null,
          is_current: true,
        },
      ],
    });
    const anon = anonymize(raw, OPTS);
    expect(anon.experience[0].function_title).toBe('Unknown');
  });

  it('scrubs a role-word + surname function_title (no surname leak)', () => {
    // Bug #4 at the pipeline level.
    const raw = makeRaw({
      experience: [
        {
          function_title: 'Senior Jansen',
          company_name: 'Some Co',
          start_date: '2022-01-01',
          end_date: null,
          is_current: true,
        },
      ],
    });
    const anon = anonymize(raw, OPTS);
    expect(JSON.stringify(anon)).not.toContain('Jansen');
  });

  it('does not leak a "Manager Smit" surname', () => {
    const raw = makeRaw({
      experience: [
        {
          function_title: 'Manager Smit',
          company_name: 'Some Co',
          start_date: '2022-01-01',
          end_date: null,
          is_current: true,
        },
      ],
    });
    const anon = anonymize(raw, OPTS);
    expect(JSON.stringify(anon)).not.toContain('Smit');
  });

  it('Bug #5: a lone capitalized non-role token → Unknown', () => {
    const raw = makeRaw({
      experience: [
        {
          function_title: 'Verstappen',
          company_name: 'Some Co',
          start_date: '2022-01-01',
          end_date: null,
          is_current: true,
        },
      ],
    });
    const anon = anonymize(raw, OPTS);
    expect(anon.experience[0].function_title).toBe('Unknown');
    expect(JSON.stringify(anon)).not.toContain('Verstappen');
  });

  it('Bug #5: a lone capitalized generic role word is preserved', () => {
    const raw = makeRaw({
      experience: [
        {
          function_title: 'Engineer',
          company_name: 'Some Co',
          start_date: '2022-01-01',
          end_date: null,
          is_current: true,
        },
      ],
    });
    const anon = anonymize(raw, OPTS);
    expect(anon.experience[0].function_title).toBe('Engineer');
  });

  it('Bug #9: scrubs an embedded name out of a skill name', () => {
    const raw = makeRaw({
      skills: [{ skill_id: 555, name: 'Referral from Anne Bakker', proficiency_id: 25 }],
    });
    const anon = anonymize(raw, OPTS);
    const json = JSON.stringify(anon);
    expect(json).not.toContain('Anne');
    expect(json).not.toContain('Bakker');
  });

  it('never emits a raw skill_<id> for a nameless talent skill', () => {
    const raw = makeRaw({
      skills: [
        { skill_id: 777, name: undefined, proficiency_id: 25 },
        { skill_id: 778, name: '', proficiency_id: 25 },
      ],
    });
    const anon = anonymize(raw, OPTS);
    const json = JSON.stringify(anon);
    expect(json).not.toContain('skill_777');
    expect(json).not.toContain('skill_778');
    // Falls back to the generic label (default nl 'Vaardigheid').
    expect(anon.skills.some((s) => s.name === 'Vaardigheid')).toBe(true);
  });

  it('never emits a raw skill_<id> for a nameless job gap-skill', () => {
    const raw = makeRaw({ skills: [] });
    const anon = anonymize(raw, {
      ...OPTS,
      jobSkills: [{ id: 12321, name: undefined, must_have: true }],
    });
    const json = JSON.stringify(anon);
    expect(json).not.toContain('skill_12321');
    const gap = anon.skills.find((s) => s.gap === true);
    expect(gap?.name).toBe('Vaardigheid');
  });

  it('never emits a name that is itself a raw skill_<id> (unresolved top_skills)', () => {
    const raw = makeRaw({
      skills: [
        { skill_id: 957701, name: 'skill_957701', proficiency_id: null },
        { skill_id: 972787, name: 'skill_972787', proficiency_id: 25 },
        { skill_id: 101, name: 'Python', proficiency_id: 27 },
      ],
    });
    const anon = anonymize(raw, OPTS);
    const json = JSON.stringify(anon);
    expect(json).not.toContain('skill_957701');
    expect(json).not.toContain('skill_972787');
    // Real names still pass through; raw-id names collapse to the label.
    expect(anon.skills.some((s) => s.name === 'Python')).toBe(true);
    expect(anon.skills.some((s) => s.name === 'Vaardigheid')).toBe(true);
  });

  it('honours a custom skillUnknownLabel (localized fallback)', () => {
    const raw = makeRaw({
      skills: [{ skill_id: 888, name: undefined, proficiency_id: 25 }],
    });
    const anon = anonymize(raw, { ...OPTS, skillUnknownLabel: 'Skill' });
    expect(JSON.stringify(anon)).not.toContain('skill_888');
    expect(anon.skills.some((s) => s.name === 'Skill')).toBe(true);
  });

  it('displaySkillName sanitizes a stored raw skill_<id> at read time', () => {
    // Simulate reading an OLD stored anonymized payload whose skill name was
    // persisted before the anonymize-side fix (still a raw `skill_<id>`).
    const stored = { name: 'skill_957701' };
    const shown = displaySkillName(stored.name, 'Skill');
    expect(shown).toBe('Skill'); // localized generic label, never the raw id
    expect(shown).not.toContain('skill_957701');

    // Real names pass through unchanged.
    expect(displaySkillName('Python', 'Skill')).toBe('Python');
    // Blank / nullish → label.
    expect(displaySkillName('', 'Skill')).toBe('Skill');
    expect(displaySkillName(null, 'Skill')).toBe('Skill');
    expect(displaySkillName(undefined, 'Skill')).toBe('Skill');
    // Case-insensitive raw-id match.
    expect(displaySkillName('SKILL_42', 'Skill')).toBe('Skill');
    // Default label (nl primary) when none passed.
    expect(displaySkillName('skill_1')).toBe('Vaardigheid');
  });

  it('flags must-have skill gaps and matches', () => {
    const raw = makeRaw();
    const anon = anonymize(raw, {
      ...OPTS,
      // Name-based matching (8vance has duplicate ids per concept).
      jobSkills: [
        { id: 101, name: 'Python', must_have: true }, // talent has → match
        { id: 999, name: 'Rust', must_have: true }, // talent lacks → gap
        { id: 102, name: 'Kubernetes', must_have: false }, // talent has, optional
      ],
    });
    const py = anon.skills.find((s) => s.name === 'Python');
    expect(py?.must_have_match).toBe(true);
    expect(py?.gap).toBe(false);

    const gap = anon.skills.find((s) => s.gap === true);
    expect(gap).toBeDefined();
    expect(gap?.name).toBe('Rust');

    const k8s = anon.skills.find((s) => s.name === 'Kubernetes');
    expect(k8s?.must_have_match).toBe(false); // present but not must_have
  });

  it('maps NL cities to province', () => {
    expect(cityToProvinceNL('Amsterdam', 'Netherlands').province).toBe('Noord-Holland');
    expect(cityToProvinceNL('Rotterdam', 'Netherlands').province).toBe('Zuid-Holland');
    expect(cityToProvinceNL('Den Haag', 'Netherlands').province).toBe('Zuid-Holland');
    expect(cityToProvinceNL('Utrecht', 'Netherlands').province).toBe('Utrecht');
    expect(cityToProvinceNL('Eindhoven', 'Netherlands').province).toBe('Noord-Brabant');
    expect(cityToProvinceNL('Maastricht', 'Netherlands').province).toBe('Limburg');
  });

  it('foreign / unknown city → canonical country only', () => {
    const a = cityToProvinceNL('Berlin', 'Germany');
    expect(a.province).toBe('');
    expect(a.country).toBe('Duitsland'); // canonicalised

    const b = cityToProvinceNL('Tegelen', 'Netherlands'); // not in lookup
    expect(b.province).toBe('');
  });

  it('output location never contains city / lat / lon / postal_code', () => {
    const raw = makeRaw();
    const anon = anonymize(raw, OPTS);
    const json = JSON.stringify(anon);
    expect(json).not.toContain('Eindhoven');
    expect(json).not.toContain('51.4416');
    expect(json).not.toContain('5611');
    expect(json).not.toContain('Hoofdstraat');
  });

  it('output never contains the raw talent id, email, name, or LinkedIn URL', () => {
    const raw = makeRaw();
    const anon = anonymize(raw, OPTS);
    const json = JSON.stringify(anon);
    expect(json).not.toContain(String(raw.id));
    expect(json).not.toContain(raw.email!);
    expect(json).not.toContain(raw.first_name!);
    expect(json).not.toContain(raw.last_name!);
    expect(json).not.toContain('linkedin');
  });
});

// ---------------------------------------------------------------------------
// Bucket helpers
// ---------------------------------------------------------------------------

describe('bucket helpers', () => {
  it('experienceYearsBucket', () => {
    expect(experienceYearsBucket(0)).toBe('0-3');
    expect(experienceYearsBucket(2.9)).toBe('0-3');
    expect(experienceYearsBucket(3)).toBe('3-5');
    expect(experienceYearsBucket(5)).toBe('5-10');
    expect(experienceYearsBucket(10)).toBe('10+');
    expect(experienceYearsBucket(40)).toBe('10+');
  });

  it('durationBucket', () => {
    expect(durationBucket(0)).toBe('<1y');
    expect(durationBucket(11)).toBe('<1y');
    expect(durationBucket(12)).toBe('1-3y');
    expect(durationBucket(36)).toBe('3-5y');
    expect(durationBucket(60)).toBe('5-10y');
    expect(durationBucket(120)).toBe('10+y');
  });

  it('hoursBucket', () => {
    expect(hoursBucket(8)).toBe('PT');
    expect(hoursBucket(31.9)).toBe('PT');
    expect(hoursBucket(32)).toBe('FT');
    expect(hoursBucket(40)).toBe('FT');
  });

  it('startWithinDaysBucket', () => {
    expect(startWithinDaysBucket(null)).toBe('unknown');
    expect(startWithinDaysBucket(new Date(Date.now() - 5 * 86400_000))).toBe('now');
    expect(startWithinDaysBucket(new Date(Date.now() + 10 * 86400_000))).toBe('<30d');
    expect(startWithinDaysBucket(new Date(Date.now() + 60 * 86400_000))).toBe('30-90d');
    expect(startWithinDaysBucket(new Date(Date.now() + 200 * 86400_000))).toBe('>90d');
  });

  it('proficiencyLabel covers 23..27', () => {
    expect(proficiencyLabel(23)).toBe('⭐');
    expect(proficiencyLabel(24)).toBe('⭐⭐');
    expect(proficiencyLabel(25)).toBe('⭐⭐⭐');
    expect(proficiencyLabel(26)).toBe('⭐⭐⭐⭐');
    expect(proficiencyLabel(27)).toBe('⭐⭐⭐⭐⭐');
  });

  it('proficiencyLabel: unknown / missing renders EMPTY (not a fake mid ⭐⭐⭐)', () => {
    // A non-canonical id, 0, null and undefined must all be EMPTY so "unknown"
    // stops masquerading as "intermediate" (the 3/6-mid bug).
    expect(proficiencyLabel(999)).toBe('');
    expect(proficiencyLabel(0)).toBe('');
    expect(proficiencyLabel(null)).toBe('');
    expect(proficiencyLabel(undefined)).toBe('');
  });

  it('anonymize: a skill with no proficiency_id renders an EMPTY label', () => {
    const raw = makeRaw({
      skills: [{ skill_id: 700, name: 'Excel' }], // no proficiency_id
    });
    const anon = anonymize(raw, OPTS);
    const excel = anon.skills.find((s) => s.name === 'Excel');
    expect(excel?.proficiency_label).toBe('');
  });

  it('languageLevelLabel', () => {
    expect(languageLevelLabel('native')).toBe('native');
    expect(languageLevelLabel('C2')).toBe('native');
    expect(languageLevelLabel('B2')).toBe('business');
    expect(languageLevelLabel('A1')).toBe('basic');
  });

  it('sectorFromCompanyName', () => {
    expect(sectorFromCompanyName('ASML Manufacturing BV')).toBe('manufacturing');
    expect(sectorFromCompanyName('ING Bank')).toBe('finance');
    expect(sectorFromCompanyName('Some Software Co')).toBe('tech');
    expect(sectorFromCompanyName(undefined)).toBe('other');
    expect(sectorFromCompanyName('Random Holding')).toBe('other');
    expect(sectorFromCompanyName('Gemeente Eindhoven')).toBe('public');
  });
});

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------

describe('buildRevealed()', () => {
  it('preserves all fields including PII', () => {
    const raw = makeRaw();
    const rev = buildRevealed(raw);
    expect(rev.email).toBe(raw.email);
    expect(rev.first_name).toBe(raw.first_name);
    expect(rev.location?.city).toBe('Eindhoven');
  });

  it('does not share references with the input', () => {
    const raw = makeRaw();
    const rev = buildRevealed(raw);
    rev.skills[0].name = 'mutated';
    expect(raw.skills[0].name).toBe('Python');
  });
});

// ---------------------------------------------------------------------------
// Property / fuzz test
// ---------------------------------------------------------------------------

describe('property: 100 random raw talents → no PII leak', () => {
  it('fuzzes', () => {
    for (let i = 0; i < 100; i++) {
      const raw = randomRawTalent(i);
      const anon = anonymize(raw, OPTS);
      expect(() => assertNoPII(anon)).not.toThrow();
    }
  });
});

function randomRawTalent(seed: number): RawTalent {
  // Deterministic-ish PRNG so failures reproduce.
  let s = seed * 9301 + 49297;
  const rand = (): number => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const cities = ['Amsterdam', 'Rotterdam', 'Berlin', 'Mongo', 'Maastricht', ''];
  const countries = ['Netherlands', 'Germany', 'Belgium', ''];
  const skillCount = Math.floor(rand() * 8);
  const expCount = Math.floor(rand() * 6);
  return {
    id: Math.floor(rand() * 1_000_000) + 1,
    first_name: 'Fn' + seed,
    last_name: 'Ln' + seed,
    email: `u${seed}@example.com`,
    phone: '+31600000000',
    date_of_birth: '1985-01-01',
    cv_url: 'https://x/y',
    linkedin_url: 'https://linkedin.com/x',
    photo_url: 'https://x/p',
    function_name: 'Role ' + seed,
    function_level: Math.floor(rand() * 8) + 1,
    total_years_experience: Math.floor(rand() * 30),
    hours_per_week: Math.floor(rand() * 50),
    start_date: rand() > 0.5 ? new Date(Date.now() + rand() * 1e10).toISOString() : null,
    score: Math.floor(rand() * 100),
    location: {
      city: cities[Math.floor(rand() * cities.length)],
      country: countries[Math.floor(rand() * countries.length)],
      postal_code: '0000XX',
      street: 'Street',
      latitude: rand() * 60,
      longitude: rand() * 10,
    },
    skills: Array.from({ length: skillCount }, (_, k) => ({
      skill_id: 100 + k,
      name: 'Skill_' + k,
      proficiency_id: 23 + Math.floor(rand() * 5),
    })),
    experience: Array.from({ length: expCount }, (_, k) => ({
      function_title: 'Title_' + k,
      company_name: 'Company ' + k,
      start_date: '20' + (10 + k) + '-01-01',
      end_date: k === 0 ? null : '20' + (15 + k) + '-01-01',
      is_current: k === 0,
    })),
    education: [
      { level: 'HBO', field_of_study_category: 'CS', school_name: 'School', end_year: 2010 },
    ],
    languages: [{ language: 'Dutch', level: 'native' }],
  };
}
