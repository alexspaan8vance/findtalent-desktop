/**
 * Pure coarsening helpers used by the anonymization pipeline.
 *
 * All functions are deterministic and free of side-effects so they can be
 * fuzz-tested cheaply.
 */

import type {
  DurationBucket,
  ExperienceYearsBucket,
  HoursBucket,
  LanguageLevelLabel,
  ProficiencyLabel,
  StartBucket,
} from './types';

// ---------------------------------------------------------------------------
// Years / months → bucket
// ---------------------------------------------------------------------------

export function experienceYearsBucket(years: number): ExperienceYearsBucket {
  if (!Number.isFinite(years) || years < 3) return '0-3';
  if (years < 5) return '3-5';
  if (years < 10) return '5-10';
  return '10+';
}

export function durationBucket(months: number): DurationBucket {
  if (!Number.isFinite(months) || months < 12) return '<1y';
  if (months < 36) return '1-3y';
  if (months < 60) return '3-5y';
  if (months < 120) return '5-10y';
  return '10+y';
}

// ---------------------------------------------------------------------------
// Geo coarsening (NL focus, EU fallback to country)
// ---------------------------------------------------------------------------

const NL_CITY_TO_PROVINCE: Readonly<Record<string, string>> = {
  // Noord-Holland
  amsterdam: 'Noord-Holland',
  haarlem: 'Noord-Holland',
  alkmaar: 'Noord-Holland',
  hilversum: 'Noord-Holland',
  zaandam: 'Noord-Holland',
  // Zuid-Holland
  rotterdam: 'Zuid-Holland',
  'den haag': 'Zuid-Holland',
  'the hague': 'Zuid-Holland',
  leiden: 'Zuid-Holland',
  delft: 'Zuid-Holland',
  dordrecht: 'Zuid-Holland',
  gouda: 'Zuid-Holland',
  // Utrecht
  utrecht: 'Utrecht',
  amersfoort: 'Utrecht',
  // Noord-Brabant
  eindhoven: 'Noord-Brabant',
  tilburg: 'Noord-Brabant',
  breda: 'Noord-Brabant',
  'den bosch': 'Noord-Brabant',
  "'s-hertogenbosch": 'Noord-Brabant',
  helmond: 'Noord-Brabant',
  // Limburg
  maastricht: 'Limburg',
  venlo: 'Limburg',
  heerlen: 'Limburg',
  sittard: 'Limburg',
  roermond: 'Limburg',
  // Gelderland
  nijmegen: 'Gelderland',
  arnhem: 'Gelderland',
  apeldoorn: 'Gelderland',
  ede: 'Gelderland',
  // Overijssel
  enschede: 'Overijssel',
  zwolle: 'Overijssel',
  hengelo: 'Overijssel',
  deventer: 'Overijssel',
  // Groningen
  groningen: 'Groningen',
  // Friesland
  leeuwarden: 'Friesland',
  // Drenthe
  assen: 'Drenthe',
  emmen: 'Drenthe',
  // Flevoland
  almere: 'Flevoland',
  lelystad: 'Flevoland',
  // Zeeland
  middelburg: 'Zeeland',
  vlissingen: 'Zeeland',
};

// Canonical country labels so the same place never renders two ways
// ("NL" vs "Nederland" vs "Netherlands"). Keyed by lowercased input.
const COUNTRY_CANON: Record<string, string> = {
  nl: 'Nederland',
  nld: 'Nederland',
  netherlands: 'Nederland',
  nederland: 'Nederland',
  'the netherlands': 'Nederland',
  be: 'België',
  bel: 'België',
  belgium: 'België',
  belgië: 'België',
  belgie: 'België',
  de: 'Duitsland',
  deu: 'Duitsland',
  germany: 'Duitsland',
  duitsland: 'Duitsland',
  deutschland: 'Duitsland',
  fr: 'Frankrijk',
  fra: 'Frankrijk',
  france: 'Frankrijk',
  frankrijk: 'Frankrijk',
  gb: 'Verenigd Koninkrijk',
  uk: 'Verenigd Koninkrijk',
  'united kingdom': 'Verenigd Koninkrijk',
  us: 'Verenigde Staten',
  usa: 'Verenigde Staten',
  'united states': 'Verenigde Staten',
};

/** Normalise a country name/code to a single canonical label. */
export function canonicalCountry(country: string): string {
  const c = (country || '').trim();
  if (!c) return '';
  return COUNTRY_CANON[c.toLowerCase()] ?? c;
}

/**
 * The 12 canonical NL provinces. Used to validate any 8vance-supplied `region`
 * before exposing it — a raw `region` may be a municipality/town name (a
 * re-identification vector), so we only pass it through when it's an actual
 * province; otherwise the caller derives the province from the city table.
 */
const NL_PROVINCES: ReadonlySet<string> = new Set([
  'drenthe', 'flevoland', 'friesland', 'fryslân', 'gelderland', 'groningen',
  'limburg', 'noord-brabant', 'noord-holland', 'overijssel', 'utrecht',
  'zeeland', 'zuid-holland',
]);

/** True only when `s` is one of the 12 canonical NL provinces (case-insensitive). */
export function isKnownProvinceNL(s: string): boolean {
  return NL_PROVINCES.has((s || '').trim().toLowerCase());
}

export function cityToProvinceNL(
  city: string,
  country: string,
): { province: string; country: string } {
  const c = (country || '').trim();
  const isNL =
    /^(nl|nld|netherlands|nederland|the netherlands)$/i.test(c) || c === '';
  const normalizedCity = (city || '').trim().toLowerCase();
  if (isNL && normalizedCity in NL_CITY_TO_PROVINCE) {
    return {
      province: NL_CITY_TO_PROVINCE[normalizedCity],
      country: 'Nederland',
    };
  }
  return {
    province: '',
    country: canonicalCountry(c) || 'Unknown',
  };
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export function startWithinDaysBucket(date: Date | null): StartBucket {
  if (date === null) return 'unknown';
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'unknown';
  const now = Date.now();
  const diffMs = date.getTime() - now;
  const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'now';
  if (days < 30) return '<30d';
  if (days <= 90) return '30-90d';
  return '>90d';
}

export function hoursBucket(h: number): HoursBucket {
  if (!Number.isFinite(h) || h < 32) return 'PT';
  return 'FT';
}

// ---------------------------------------------------------------------------
// Proficiency / language labels
// ---------------------------------------------------------------------------

/**
 * 8vance proficiency id table:
 *   23 = Beginner, 24 = Basic, 25 = Intermediate, 26 = Advanced, 27 = Expert.
 *   (28 exists in the registry but is unused in PROD.)
 * Map → 1..5 stars. A missing / unknown / non-canonical id renders EMPTY ('')
 * rather than a fake mid-tier ⭐⭐⭐ — "unknown" must not masquerade as
 * "intermediate". The downstream `ProficiencyMeter` renders '' as an empty meter.
 */
export function proficiencyLabel(id: number | null | undefined): ProficiencyLabel {
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
      // Unknown / missing id → empty (no rating); never leak the raw id.
      return '';
  }
}

export function languageLevelLabel(level: string): LanguageLevelLabel {
  const l = (level || '').trim().toLowerCase();
  if (l === 'native' || l === 'c2' || l === 'mothertongue' || l === 'mother tongue') {
    return 'native';
  }
  if (l === 'b2' || l === 'c1' || l === 'business' || l === 'fluent') {
    return 'business';
  }
  return 'basic';
}

// ---------------------------------------------------------------------------
// Sector heuristic
// ---------------------------------------------------------------------------

type Sector =
  | 'tech'
  | 'finance'
  | 'healthcare'
  | 'logistics'
  | 'manufacturing'
  | 'public'
  | 'retail'
  | 'consulting'
  | 'other';

const SECTOR_KEYWORDS: ReadonlyArray<readonly [Sector, readonly string[]]> = [
  ['tech', ['software', 'it', 'tech', 'digital', 'data', 'cloud', 'cyber', 'saas', 'platform']],
  ['finance', ['bank', 'finance', 'insur', 'fintech', 'asset', 'capital', 'fund', 'invest']],
  ['healthcare', ['hospital', 'health', 'pharma', 'medic', 'clinic', 'zorg', 'umc']],
  ['logistics', ['logist', 'transport', 'shipping', 'freight', 'warehouse', 'supply']],
  ['manufacturing', ['manufactur', 'factory', 'industr', 'production', 'plant', 'machin']],
  ['public', ['gemeente', 'ministerie', 'government', 'public', 'rijks', 'provincie']],
  ['retail', ['retail', 'shop', 'store', 'ecommerce', 'e-commerce', 'consumer']],
  ['consulting', ['consult', 'advisory', 'advies', 'strategy']],
];

export function sectorFromCompanyName(name?: string): Sector {
  if (!name) return 'other';
  const n = name.toLowerCase();
  for (const [sector, keywords] of SECTOR_KEYWORDS) {
    for (const kw of keywords) {
      if (n.includes(kw)) return sector;
    }
  }
  return 'other';
}
