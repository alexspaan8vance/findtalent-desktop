import { describe, it, expect } from 'vitest';

import {
  buildSuggestions,
  decideSuggestionsStatus,
  type CvProfileLike,
  type EightvanceParseLike,
} from '../src/lib/candidate/cv-suggestions';

describe('decideSuggestionsStatus', () => {
  it('ready when there are suggestions (regardless of parse content)', () => {
    expect(decideSuggestionsStatus(3, 0)).toBe('ready');
    expect(decideSuggestionsStatus(1, 12)).toBe('ready');
  });
  it('none when the parse returned content but produced no diff (complete profile)', () => {
    expect(decideSuggestionsStatus(0, 9)).toBe('none');
  });
  it('pending when the parse surfaced nothing yet (reparse still settling)', () => {
    expect(decideSuggestionsStatus(0, 0)).toBe('pending');
  });
});

/** Empty local profile baseline. */
const emptyLocal: CvProfileLike = {
  hardSkills: [],
  softSkills: [],
  knowledge: [],
  languages: [],
  education: [],
  employment: [],
};

const emptyEv: EightvanceParseLike = {
  skills: [],
  languages: [],
  education: [],
  employment: [],
};

describe('buildSuggestions — skills union', () => {
  it('adds only skills missing from local (case-insensitive over all buckets)', () => {
    const local: CvProfileLike = {
      ...emptyLocal,
      hardSkills: ['Python'],
      softSkills: ['Communicatie'],
      knowledge: ['Scrum'],
    };
    const ev: EightvanceParseLike = {
      ...emptyEv,
      skills: ['python', 'SQL', 'scrum', 'Docker', 'SQL'], // dupes + already-present
    };
    const s = buildSuggestions(local, ev);
    const skillAdds = s.filter((x) => x.kind === 'skill');
    expect(skillAdds.map((x) => x.proposed)).toEqual(['SQL', 'Docker']);
    expect(skillAdds.every((x) => x.action === 'add')).toBe(true);
    expect(skillAdds[0].id).toBe('skill:sql');
    expect(skillAdds[0].status).toBe('pending');
    expect(skillAdds[0].source).toBe('8vance');
  });
});

describe('buildSuggestions — languages (locale-aware dedup)', () => {
  it('does NOT re-propose a language the local profile already has under a different locale name', () => {
    // Local CV parsed the language as the Dutch name "Nederlands"; the 8vance
    // readback returns the English "Dutch". Must be treated as the SAME language
    // (the recurring false "Add language: Dutch" on ~every NL CV).
    const local: CvProfileLike = { ...emptyLocal, languages: [{ name: 'Nederlands' }] };
    const ev: EightvanceParseLike = { ...emptyEv, languages: ['Dutch'] };
    expect(buildSuggestions(local, ev).filter((x) => x.kind === 'language')).toEqual([]);
  });

  it('still proposes a genuinely-new language', () => {
    const local: CvProfileLike = { ...emptyLocal, languages: [{ name: 'Nederlands' }] };
    const ev: EightvanceParseLike = { ...emptyEv, languages: ['Dutch', 'Frans'] };
    const langs = buildSuggestions(local, ev).filter((x) => x.kind === 'language');
    expect(langs.map((x) => (x.proposed as { name: string }).name)).toEqual(['Frans']);
  });

  it('dedups across EN/DE/NL variants of the same language', () => {
    const local: CvProfileLike = { ...emptyLocal, languages: [{ name: 'Duits' }, { name: 'English' }] };
    const ev: EightvanceParseLike = { ...emptyEv, languages: ['German', 'Engels'] };
    expect(buildSuggestions(local, ev).filter((x) => x.kind === 'language')).toEqual([]);
  });
});

describe('buildSuggestions — education', () => {
  it('replaces an HTS-only local entry with the richer 8vance one (with reason)', () => {
    const local: CvProfileLike = {
      ...emptyLocal,
      education: [{ degree: 'HTS' }],
    };
    const ev: EightvanceParseLike = {
      ...emptyEv,
      education: [
        {
          degree: 'HTS',
          field: 'Werktuigbouwkunde',
          institution: 'Hogeschool',
          startYear: '2010',
          endYear: '2014',
        },
      ],
    };
    const s = buildSuggestions(local, ev);
    const edu = s.filter((x) => x.kind === 'education');
    expect(edu).toHaveLength(1);
    expect(edu[0].action).toBe('replace');
    expect(edu[0].original).toEqual({ degree: 'HTS' });
    expect(edu[0].reason).toContain('+field');
    expect(edu[0].reason).toContain('+institution');
    expect(edu[0].reason).toContain('+startYear');
    expect(edu[0].label).toContain('Hogeschool');
  });

  it('adds a brand-new education entry when there is no local match', () => {
    const local: CvProfileLike = {
      ...emptyLocal,
      education: [{ institution: 'TU Delft', degree: 'MSc' }],
    };
    const ev: EightvanceParseLike = {
      ...emptyEv,
      education: [{ institution: 'ROC Amsterdam', degree: 'MBO', field: 'ICT' }],
    };
    const s = buildSuggestions(local, ev);
    const edu = s.filter((x) => x.kind === 'education');
    expect(edu).toHaveLength(1);
    expect(edu[0].action).toBe('add');
    expect(edu[0].original).toBeNull();
  });

  it('emits nothing when the local education entry is equal-or-richer', () => {
    const local: CvProfileLike = {
      ...emptyLocal,
      education: [
        { degree: 'HTS', field: 'Werktuigbouwkunde', institution: 'Hogeschool', startYear: '2010', endYear: '2014' },
      ],
    };
    const ev: EightvanceParseLike = {
      ...emptyEv,
      education: [{ degree: 'HTS', institution: 'Hogeschool' }],
    };
    const s = buildSuggestions(local, ev);
    expect(s.filter((x) => x.kind === 'education')).toHaveLength(0);
  });
});

describe('buildSuggestions — employment fuzzy match', () => {
  it('matches on company + overlapping years (tolerant) and dedups instead of adding', () => {
    const local: CvProfileLike = {
      ...emptyLocal,
      employment: [{ company: 'Acme BV', title: 'Engineer', startYear: '2018' }],
    };
    const ev: EightvanceParseLike = {
      ...emptyEv,
      employment: [
        {
          company: 'acme bv',
          title: 'Engineer',
          startYear: '2019', // within ±1 tolerance
          endYear: '2022',
          description: 'Built things',
        },
      ],
    };
    const s = buildSuggestions(local, ev);
    const emp = s.filter((x) => x.kind === 'employment');
    expect(emp).toHaveLength(1);
    expect(emp[0].action).toBe('replace'); // matched + richer (endYear + description)
    expect(emp[0].reason).toContain('+endYear');
    expect(emp[0].reason).toContain('+description');
  });

  it('adds a new employment entry when the company does not match', () => {
    const local: CvProfileLike = {
      ...emptyLocal,
      employment: [{ company: 'Acme BV', title: 'Engineer' }],
    };
    const ev: EightvanceParseLike = {
      ...emptyEv,
      employment: [{ company: 'Globex', title: 'Manager' }],
    };
    const s = buildSuggestions(local, ev);
    const emp = s.filter((x) => x.kind === 'employment');
    expect(emp).toHaveLength(1);
    expect(emp[0].action).toBe('add');
  });
});

describe('buildSuggestions — about', () => {
  it('fills when local about is empty', () => {
    const ev: EightvanceParseLike = { ...emptyEv, about: 'Ervaren werktuigbouwkundige.' };
    const s = buildSuggestions(emptyLocal, ev);
    const about = s.filter((x) => x.kind === 'about');
    expect(about).toHaveLength(1);
    expect(about[0].action).toBe('fill');
  });

  it('replaces when 8vance about is meaningfully longer', () => {
    const local: CvProfileLike = { ...emptyLocal, about: 'Engineer.' };
    const ev: EightvanceParseLike = {
      ...emptyEv,
      about: 'Senior werktuigbouwkundige met 12 jaar ervaring in machinebouw en teamleiding.',
    };
    const s = buildSuggestions(local, ev);
    const about = s.filter((x) => x.kind === 'about');
    expect(about).toHaveLength(1);
    expect(about[0].action).toBe('replace');
    expect(about[0].original).toBe('Engineer.');
  });

  it('does not replace when 8vance about is not meaningfully longer', () => {
    const local: CvProfileLike = { ...emptyLocal, about: 'Senior engineer with a decade of experience.' };
    const ev: EightvanceParseLike = { ...emptyEv, about: 'Senior engineer, ten years.' };
    const s = buildSuggestions(local, ev);
    expect(s.filter((x) => x.kind === 'about')).toHaveLength(0);
  });
});

describe('buildSuggestions — email', () => {
  it('fills only when local email is empty and 8vance email is valid', () => {
    const ev: EightvanceParseLike = { ...emptyEv, email: 'jan@company.org' };
    const s = buildSuggestions(emptyLocal, ev);
    const email = s.filter((x) => x.kind === 'email');
    expect(email).toHaveLength(1);
    expect(email[0].action).toBe('fill');
    expect(email[0].proposed).toBe('jan@company.org');
  });

  it('does not fill when local already has a valid email', () => {
    const local: CvProfileLike = { ...emptyLocal, email: 'real@company.com' };
    const ev: EightvanceParseLike = { ...emptyEv, email: 'other@company.com' };
    const s = buildSuggestions(local, ev);
    expect(s.filter((x) => x.kind === 'email')).toHaveLength(0);
  });

  it('replaces when local email is present but invalid', () => {
    const local: CvProfileLike = { ...emptyLocal, email: 'not-an-email' };
    const ev: EightvanceParseLike = { ...emptyEv, email: 'valid@company.com' };
    const s = buildSuggestions(local, ev);
    const email = s.filter((x) => x.kind === 'email');
    expect(email).toHaveLength(1);
    expect(email[0].action).toBe('replace');
  });

  it('does not suggest when the 8vance email itself is invalid', () => {
    const ev: EightvanceParseLike = { ...emptyEv, email: 'garbage' };
    const s = buildSuggestions(emptyLocal, ev);
    expect(s.filter((x) => x.kind === 'email')).toHaveLength(0);
  });
});

describe('buildSuggestions — recruiterLockedFields', () => {
  it('excludes locked scalar fields (about/email/phone)', () => {
    const ev: EightvanceParseLike = {
      ...emptyEv,
      about: 'A summary',
      email: 'jan@example.org',
      phone: '+31 6 12345678',
      skills: ['Python'], // not locked → still suggested
    };
    const s = buildSuggestions(emptyLocal, ev, new Set(['about', 'email', 'phone']));
    expect(s.some((x) => x.kind === 'about')).toBe(false);
    expect(s.some((x) => x.kind === 'email')).toBe(false);
    expect(s.some((x) => x.kind === 'phone')).toBe(false);
    expect(s.some((x) => x.kind === 'skill')).toBe(true);
  });
});

describe('buildSuggestions — ordering + phone', () => {
  it('orders replaces/fills before adds and fills phone when valid', () => {
    const local: CvProfileLike = {
      ...emptyLocal,
      education: [{ degree: 'HTS' }],
    };
    const ev: EightvanceParseLike = {
      ...emptyEv,
      skills: ['SQL'], // add
      phone: '0612345678', // fill
      education: [{ degree: 'HTS', institution: 'Hogeschool', field: 'WTB' }], // replace
    };
    const s = buildSuggestions(local, ev);
    const actions = s.map((x) => x.action);
    // replace + fill must all come before any add
    const firstAdd = actions.indexOf('add');
    const lastNonAdd = actions.lastIndexOf('fill') > actions.lastIndexOf('replace')
      ? actions.lastIndexOf('fill')
      : actions.lastIndexOf('replace');
    expect(lastNonAdd).toBeLessThan(firstAdd);
    expect(s.some((x) => x.kind === 'phone' && x.action === 'fill')).toBe(true);
  });
});

describe('buildSuggestions — empty inputs', () => {
  it('returns [] when both parses are empty', () => {
    expect(buildSuggestions(emptyLocal, emptyEv)).toEqual([]);
  });
});
