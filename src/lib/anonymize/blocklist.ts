/**
 * Defense-in-depth PII blocklist.
 *
 * Types prevent leaks at compile time; this module catches accidents at
 * runtime by walking the produced JSON and throwing on any blocklisted key.
 */

export class PIILeakError extends Error {
  public readonly leakedPath: string;
  public readonly leakedKey: string;

  constructor(path: string, key: string) {
    super(`PII leak detected: blocked key "${key}" at path "${path}"`);
    this.name = 'PIILeakError';
    this.leakedPath = path;
    this.leakedKey = key;
  }
}

/** Keys that MUST NEVER appear anywhere in an `AnonymizedTalent` payload. */
export const BLOCKED_KEYS: ReadonlySet<string> = new Set<string>([
  // names
  'first_name',
  'last_name',
  'full_name',
  'name_first',
  'name_last',
  'firstname',
  'lastname',
  'fullname',
  // contact
  'email',
  'e_mail',
  'phone',
  'mobile',
  'telephone',
  // address
  'address',
  'street',
  'postal_code',
  'postcode',
  'zip',
  'zipcode',
  // geo
  'latitude',
  'longitude',
  'lat',
  'lng',
  'lon',
  'city',
  // birth
  'date_of_birth',
  'birth_date',
  'birthdate',
  'dob',
  // media
  'cv_url',
  'photo_url',
  'picture',
  'avatar',
  'profile_picture',
  // socials
  'linkedin_url',
  'linkedin',
  'twitter',
  'github',
  // employers / schools
  'employer',
  'company_name',
  'employer_name',
  'school',
  'school_name',
  'institution',
  'university',
  'hbo_naam',
  // dates
  'start_date',
  'end_date',
  'graduation_date',
  'end_year',
  'start_year',
  // raw 8vance id
  'talent_id',
]);

/**
 * Special-case: the literal key `"id"` is allowed only on the root of the
 * payload IF it equals the opaque hash. We keep this simple by using
 * `opaque_id` everywhere and treating `id` as blocked too.
 */
const RAW_ID_KEY = 'id';

/**
 * Walk an arbitrary JSON value and throw `PIILeakError` on the first blocked
 * key encountered. Also runs a heuristic value scan: any string that looks
 * like an email address triggers a leak regardless of its key name.
 */
export function assertNoPII(obj: unknown, path = '$'): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string') {
    // Defense-in-depth value scan: a clean key name must not smuggle a
    // contact handle through. These shapes never legitimately appear in an
    // anonymized payload (role words, country labels, star strings, etc.).
    if (looksLikeEmail(obj)) {
      throw new PIILeakError(path, '<email-in-string>');
    }
    if (looksLikeUrl(obj)) {
      throw new PIILeakError(path, '<url-in-string>');
    }
    if (looksLikePhone(obj)) {
      throw new PIILeakError(path, '<phone-in-string>');
    }
    return;
  }
  if (typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      assertNoPII(obj[i], `${path}[${i}]`);
    }
    return;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lc = key.toLowerCase();
    if (BLOCKED_KEYS.has(lc) || lc === RAW_ID_KEY) {
      throw new PIILeakError(`${path}.${key}`, key);
    }
    assertNoPII(value, `${path}.${key}`);
  }
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function looksLikeEmail(s: string): boolean {
  return EMAIL_RE.test(s);
}

/** Explicit web URL or social handle. Requires a scheme or www. to avoid
 *  flagging incidental dotted text (which legitimate anon values never have). */
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/i;

function looksLikeUrl(s: string): boolean {
  return URL_RE.test(s);
}

/**
 * Phone-shaped run. Requires phone punctuation (space / dash / dot / parens)
 * OR a leading "+" so a bare alphanumeric token (e.g. the opaque hash id, which
 * is hex and can contain long digit runs) does NOT trip the guard. Needs 7+
 * digits total — anon payload numbers (years, buckets, ⭐ strings) never match.
 */
const PHONE_RE =
  /(?:\+\d[\d\s().-]{5,}\d|\(?\d{2,}\)?[\s.-]\d[\d\s().-]{3,}\d)/;

function looksLikePhone(s: string): boolean {
  if (!PHONE_RE.test(s)) return false;
  // Count digits — guard against short matches that slipped the shape.
  const digits = (s.match(/\d/g) ?? []).length;
  return digits >= 7;
}
