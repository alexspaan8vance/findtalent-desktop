import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { prisma } from '../src/lib/db';
import { _piiInternals } from '../src/lib/candidate/pii';

// Raw client = no extension, so it sees exactly what's stored on disk.
const raw = new PrismaClient();

const baseRow = {
  createdByUserId: 'u_pii_test',
  name: 'PII Test',
};

afterAll(async () => {
  await raw.candidate.deleteMany({ where: { createdByUserId: 'u_pii_test' } });
  await raw.$disconnect();
});

describe('candidate PII at rest', () => {
  it('stores email/phone/cvText/profileJson as ciphertext, reads them back plaintext', async () => {
    const created = await prisma.candidate.create({
      data: {
        ...baseRow,
        email: 'jan@example.com',
        phone: '+31612345678',
        cvText: 'Jan Jansen — Senior Developer',
        profileJson: { cv: { fullName: 'Jan Jansen' }, secret: 42 },
      },
    });

    // create() returns decrypted (callers expect plaintext back).
    expect(created.email).toBe('jan@example.com');

    // Raw row = ciphertext, never the plaintext.
    const stored = await raw.candidate.findUnique({ where: { id: created.id } });
    expect(stored?.email?.startsWith(_piiInternals.MARKER)).toBe(true);
    expect(stored?.email).not.toContain('jan@example.com');
    expect(stored?.phone?.startsWith(_piiInternals.MARKER)).toBe(true);
    expect(stored?.cvText?.startsWith(_piiInternals.MARKER)).toBe(true);
    // profileJson stored as a marked JSON string, not the object.
    expect(typeof stored?.profileJson).toBe('string');
    expect((stored?.profileJson as string).startsWith(_piiInternals.MARKER)).toBe(true);
    expect(stored?.profileJson as string).not.toContain('Jansen');

    // Extended read decrypts transparently.
    const read = await prisma.candidate.findUnique({ where: { id: created.id } });
    expect(read?.email).toBe('jan@example.com');
    expect(read?.phone).toBe('+31612345678');
    expect(read?.cvText).toBe('Jan Jansen — Senior Developer');
    expect((read?.profileJson as { cv?: { fullName?: string }; secret?: number })?.cv?.fullName).toBe(
      'Jan Jansen',
    );
    expect((read?.profileJson as { secret?: number })?.secret).toBe(42);
  });

  it('reads LEGACY plaintext rows unchanged (backward compatible)', async () => {
    // Write a row directly via the raw client = plaintext, as pre-encryption data.
    const legacy = await raw.candidate.create({
      data: {
        ...baseRow,
        email: 'legacy@example.com',
        cvText: 'plaintext cv',
        profileJson: { cv: { fullName: 'Legacy Person' } },
      },
    });

    const read = await prisma.candidate.findUnique({ where: { id: legacy.id } });
    expect(read?.email).toBe('legacy@example.com');
    expect(read?.cvText).toBe('plaintext cv');
    expect((read?.profileJson as { cv?: { fullName?: string } })?.cv?.fullName).toBe('Legacy Person');
  });

  it('updateMany seals PII on write', async () => {
    const c = await prisma.candidate.create({
      data: { ...baseRow, email: 'before@example.com' },
    });
    await prisma.candidate.updateMany({
      where: { id: c.id },
      data: { email: 'after@example.com' },
    });
    const stored = await raw.candidate.findUnique({ where: { id: c.id } });
    expect(stored?.email?.startsWith(_piiInternals.MARKER)).toBe(true);
    expect(stored?.email).not.toContain('after@example.com');
    const read = await prisma.candidate.findUnique({ where: { id: c.id } });
    expect(read?.email).toBe('after@example.com');
  });

  it('seal is idempotent — re-sealing an already-sealed value is a no-op', () => {
    const once = _piiInternals.sealString('hello');
    const twice = _piiInternals.sealString(once);
    expect(twice).toBe(once);
    expect(_piiInternals.openString(twice)).toBe('hello');
  });
});
