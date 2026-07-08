/**
 * Candidate PII encryption at rest.
 *
 * A fully-managed candidate stores sensitive PII — email, phone, the raw CV
 * text, and the parsed profile snapshot (which contains the full CV: name,
 * employment history, education, contact). We encrypt those four fields at the
 * Prisma boundary so the SQLite/Postgres row never holds plaintext PII.
 *
 * This is wired as a Prisma `$extends` query extension (see db.ts) so EVERY
 * call site is covered transparently — seal on write, open on read — instead of
 * sprinkling encrypt/decrypt across ~19 read/write sites where one miss would
 * leak plaintext or crash on decrypt.
 *
 * Backward compatible + idempotent:
 *   - Encrypted values carry the `enc:v1:` marker. Reads of LEGACY plaintext
 *     rows (written before this change) pass through unchanged, so existing
 *     candidates keep working and re-encrypt lazily on their next write.
 *   - Sealing a value that already carries the marker is a no-op, so an update
 *     that round-trips an already-sealed value never double-encrypts.
 *
 * `name` is intentionally left plaintext: it's the recruiter-facing list label
 * and sort/search key, and the anonymisation that matters (employer side) strips
 * PII from match payloads separately. `preferencesJson` (region/radius/contract)
 * is not PII and stays plaintext.
 */

import { Prisma } from '@prisma/client';

import { encrypt, decrypt } from '@/lib/crypto';

const MARKER = 'enc:v1:';

/** String PII columns encrypted at rest. */
const STRING_FIELDS = ['email', 'phone', 'cvText'] as const;
/** Json PII columns encrypted at rest (stored as a marked JSON string). */
const JSON_FIELDS = ['profileJson'] as const;

function isSealed(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(MARKER);
}

function sealString(v: unknown): unknown {
  if (typeof v !== 'string' || v.length === 0) return v; // null/undefined/'' untouched
  if (isSealed(v)) return v; // already encrypted — idempotent
  return MARKER + encrypt(v);
}

function openString(v: unknown): unknown {
  if (!isSealed(v)) return v; // legacy plaintext / null passes through
  try {
    return decrypt(v.slice(MARKER.length));
  } catch (err) {
    // A throw here (rotated key without PREVIOUS / corrupt value) would crash a
    // whole list read. Degrade the single field to null + log loudly instead.
    console.error('[candidate-pii] string field decrypt failed — returning null', err);
    return null;
  }
}

function sealJson(v: unknown): unknown {
  // Only transform a real object/array; leave null/undefined and Prisma's
  // Json null sentinels alone so write semantics are unchanged.
  if (v == null || isSealed(v)) return v;
  if (typeof v !== 'object') return v;
  return MARKER + encrypt(JSON.stringify(v));
}

function openJson(v: unknown): unknown {
  if (!isSealed(v)) return v; // legacy object / null passes through
  try {
    return JSON.parse(decrypt(v.slice(MARKER.length)));
  } catch (err) {
    // Don't crash the read — but DON'T fail silently either. A decrypt failure
    // here almost always means a key was rotated without ENCRYPTION_KEY_PREVIOUS
    // (or a corrupt row), which would otherwise look like "candidate has no
    // profile". Surface it loudly so it's caught in logs/alerting.
    console.error('[candidate-pii] profileJson decrypt failed — returning null', err);
    return null;
  }
}

/** Encrypt PII fields on a single `data` object in place-safe fashion. */
function sealOne<T extends Record<string, unknown>>(data: T): T {
  if (!data || typeof data !== 'object') return data;
  const out: Record<string, unknown> = { ...data };
  for (const f of STRING_FIELDS) {
    if (f in out) out[f] = sealString(out[f]);
  }
  for (const f of JSON_FIELDS) {
    if (f in out) out[f] = sealJson(out[f]);
  }
  return out as T;
}

/** Seal a create/update `data` arg, which may be a single object or an array. */
function sealData(data: unknown): unknown {
  if (Array.isArray(data)) return data.map((d) => sealOne(d as Record<string, unknown>));
  return sealOne(data as Record<string, unknown>);
}

/** Decrypt PII fields on a row read back from the DB. */
function openRow<T>(row: T): T {
  if (row == null) return row;
  if (Array.isArray(row)) return row.map((r) => openRow(r)) as unknown as T;
  if (typeof row !== 'object') return row;
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const f of STRING_FIELDS) {
    if (f in out) out[f] = openString(out[f]);
  }
  for (const f of JSON_FIELDS) {
    if (f in out) out[f] = openJson(out[f]);
  }
  return out as T;
}

/**
 * Prisma query extension: transparently encrypt Candidate PII on write and
 * decrypt on read. `updateMany`/`createMany` return only `{ count }`, so those
 * seal the input but don't open a result.
 */
export const candidatePiiExtension = Prisma.defineExtension({
  name: 'candidate-pii',
  query: {
    candidate: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async create({ args, query }: any) {
        args.data = sealData(args.data);
        return openRow(await query(args));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async update({ args, query }: any) {
        args.data = sealData(args.data);
        return openRow(await query(args));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async upsert({ args, query }: any) {
        if (args.create) args.create = sealData(args.create);
        if (args.update) args.update = sealData(args.update);
        return openRow(await query(args));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async updateMany({ args, query }: any) {
        args.data = sealData(args.data);
        return query(args); // returns { count }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async createMany({ args, query }: any) {
        args.data = sealData(args.data);
        return query(args); // returns { count }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async findUnique({ args, query }: any) {
        return openRow(await query(args));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async findUniqueOrThrow({ args, query }: any) {
        return openRow(await query(args));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async findFirst({ args, query }: any) {
        return openRow(await query(args));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async findFirstOrThrow({ args, query }: any) {
        return openRow(await query(args));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async findMany({ args, query }: any) {
        return openRow(await query(args));
      },
    },
  },
});

// Exposed for tests.
export const _piiInternals = { sealString, openString, sealJson, openJson, MARKER };
