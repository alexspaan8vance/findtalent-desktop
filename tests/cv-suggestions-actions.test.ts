import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';

import { encrypt } from '../src/lib/crypto';
import type { CvSuggestion } from '../src/lib/candidate/cv-suggestions';

// --- Mocks -----------------------------------------------------------------
// Hoisted so the vi.mock factories (run before module init) can see them.
const h = vi.hoisted(() => ({
  currentUserId: { value: '' },
  // Captured 8vance writes so we can assert the push delta per kind.
  calls: [] as Array<{ fn: string; args: unknown[] }>,
  clientThrows: { value: false },
}));

function rec(fn: string) {
  return (...args: unknown[]) => {
    h.calls.push({ fn, args });
    return Promise.resolve(undefined);
  };
}

// `server-only` is a Next.js build marker with no runtime in vitest — stub it so
// importing suggestions-actions (which now pulls in the server-only service.ts
// for generateSuggestionsFromTalent) doesn't throw.
vi.mock('server-only', () => ({}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('../src/lib/auth-helpers', () => ({
  requireUser: vi.fn(async () => ({ id: h.currentUserId.value, role: 'RECRUITER' })),
}));

// Fake 8vance client — records every write; resolvers echo a stable id.
vi.mock('../src/lib/eightvance/tenant-client', () => ({
  vanceClientForTenant: vi.fn(async () => {
    if (h.clientThrows.value) throw new Error('client boom');
    return {
      resources: {
        resolveSkills: async (names: string[]) => {
          h.calls.push({ fn: 'resolveSkills', args: [names] });
          return names.map((n, i) => ({ name: n, id: 500 + i }));
        },
        resolveLanguage: async (name: string) => {
          h.calls.push({ fn: 'resolveLanguage', args: [name] });
          return { id: 42, name };
        },
        resolveFunctionName: async (q: string) => {
          h.calls.push({ fn: 'resolveFunctionName', args: [q] });
          return { id: 99, name: q };
        },
      },
      talent: {
        addSkill: rec('addSkill'),
        addLanguage: rec('addLanguage'),
        addEducation: rec('addEducation'),
        addExperience: rec('addExperience'),
        linkFunctionName: rec('linkFunctionName'),
        update: rec('update'),
      },
    };
  }),
}));

import {
  listSuggestions,
  dismissSuggestion,
  approveSuggestion,
  approveAllSuggestions,
} from '../src/app/app/candidates/[id]/suggestions-actions';
// The app prisma transparently encrypts/decrypts Candidate PII (email/phone/
// profileJson); create + read back through it so those fields round-trip.
import { prisma } from '../src/lib/db';

async function mkTenant() {
  return prisma.tenant.create({
    data: {
      slug: `t-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Pool',
      eightvanceClientId: 'cid',
      eightvanceClientSecretEnc: encrypt('sekret'),
      eightvanceCompanyId: 34231,
      ownSourceSlug: 'src',
      brandConfigJson: {},
    },
  });
}

function sug(over: Partial<CvSuggestion>): CvSuggestion {
  return {
    id: 'skill:python',
    kind: 'skill',
    action: 'add',
    label: 'Add skill: Python',
    original: null,
    proposed: 'Python',
    reason: 'x',
    status: 'pending',
    source: '8vance',
    confidence: 0.9,
    ...over,
  };
}

async function mkCandidate(opts: {
  ownerId: string;
  tenantId: string | null;
  talentId: number | null;
  suggestions: CvSuggestion[];
  cv?: Record<string, unknown>;
}) {
  return prisma.candidate.create({
    data: {
      createdByUserId: opts.ownerId,
      tenantId: opts.tenantId,
      eightvanceTalentId: opts.talentId,
      name: 'Jane',
      email: 'old@example.com',
      profileJson: { cv: opts.cv ?? {} },
      cvSuggestionsJson: opts.suggestions as unknown as object,
    },
  });
}

beforeEach(() => {
  h.calls.length = 0;
  h.clientThrows.value = false;
});

afterAll(async () => {
  await prisma.candidate.deleteMany({});
  await prisma.tenant.deleteMany({});
  await prisma.$disconnect();
});

describe('cv-suggestions server actions', () => {
  it('listSuggestions returns only pending, org-guards non-owners', async () => {
    const t = await mkTenant();
    const c = await mkCandidate({
      ownerId: 'owner-1',
      tenantId: t.id,
      talentId: 1,
      suggestions: [
        sug({ id: 'a', status: 'pending' }),
        sug({ id: 'b', status: 'dismissed' }),
        sug({ id: 'c', status: 'approved' }),
      ],
    });

    h.currentUserId.value = 'owner-1';
    const ok = await listSuggestions(c.id);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.suggestions.map((s) => s.id)).toEqual(['a']);

    // A different user with no shared org is forbidden.
    h.currentUserId.value = 'stranger';
    const denied = await listSuggestions(c.id);
    expect(denied).toEqual({ ok: false, reason: 'forbidden' });

    // Unknown candidate → not_found.
    h.currentUserId.value = 'owner-1';
    expect(await listSuggestions('nope')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('dismissSuggestion flips status and no longer lists it', async () => {
    const t = await mkTenant();
    const c = await mkCandidate({
      ownerId: 'owner-2',
      tenantId: t.id,
      talentId: 1,
      suggestions: [sug({ id: 'a' }), sug({ id: 'b', proposed: 'SQL' })],
    });
    h.currentUserId.value = 'owner-2';

    expect(await dismissSuggestion(c.id, 'a')).toEqual({ ok: true });
    const after = await listSuggestions(c.id);
    if (after.ok) expect(after.suggestions.map((s) => s.id)).toEqual(['b']);

    expect(await dismissSuggestion(c.id, 'ghost')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('approveSuggestion (skill) applies to local hardSkills + pushes resolved skill', async () => {
    const t = await mkTenant();
    const c = await mkCandidate({
      ownerId: 'owner-3',
      tenantId: t.id,
      talentId: 7,
      suggestions: [sug({ id: 'a', proposed: 'Python' })],
      cv: { hardSkills: ['Java'] },
    });
    h.currentUserId.value = 'owner-3';

    const res = await approveSuggestion(c.id, 'a');
    expect(res).toEqual({ ok: true });

    const row = await prisma.candidate.findUnique({ where: { id: c.id } });
    const cv = (row!.profileJson as { cv: { hardSkills: string[] } }).cv;
    expect(cv.hardSkills).toContain('Python');
    const sugs = row!.cvSuggestionsJson as unknown as CvSuggestion[];
    expect(sugs[0].status).toBe('approved');

    expect(h.calls.find((c) => c.fn === 'resolveSkills')).toBeTruthy();
    expect(h.calls.find((c) => c.fn === 'addSkill')).toBeTruthy();

    // Re-approving an already-approved suggestion → not_pending.
    expect(await approveSuggestion(c.id, 'a')).toEqual({ ok: false, reason: 'not_pending' });
  });

  it('approveSuggestion (email) mirrors onto candidate.email + PATCHes 8vance', async () => {
    const t = await mkTenant();
    const c = await mkCandidate({
      ownerId: 'owner-4',
      tenantId: t.id,
      talentId: 8,
      suggestions: [
        sug({ id: 'e', kind: 'email', action: 'fill', proposed: 'jane@new.com' }),
      ],
    });
    h.currentUserId.value = 'owner-4';

    expect(await approveSuggestion(c.id, 'e')).toEqual({ ok: true });
    const row = await prisma.candidate.findUnique({ where: { id: c.id } });
    expect(row!.email).toBe('jane@new.com');
    expect((row!.profileJson as { cv: { email: string } }).cv.email).toBe('jane@new.com');
    const patch = h.calls.find((c) => c.fn === 'update');
    expect(patch?.args[1]).toEqual({ email: 'jane@new.com' });
  });

  it('approveSuggestion (employment) appends + links function_name best-effort', async () => {
    const t = await mkTenant();
    const c = await mkCandidate({
      ownerId: 'owner-5',
      tenantId: t.id,
      talentId: 9,
      suggestions: [
        sug({
          id: 'emp',
          kind: 'employment',
          action: 'add',
          proposed: { title: 'Backend Engineer', company: 'Acme', startYear: '2019' },
        }),
      ],
    });
    h.currentUserId.value = 'owner-5';

    expect(await approveSuggestion(c.id, 'emp')).toEqual({ ok: true });
    const row = await prisma.candidate.findUnique({ where: { id: c.id } });
    const emp = (row!.profileJson as { cv: { employment: unknown[] } }).cv.employment;
    expect(emp).toHaveLength(1);
    expect(h.calls.find((c) => c.fn === 'addExperience')).toBeTruthy();
    expect(h.calls.find((c) => c.fn === 'linkFunctionName')).toBeTruthy();
  });

  it('approveSuggestion succeeds locally even when the 8vance client is down', async () => {
    const t = await mkTenant();
    const c = await mkCandidate({
      ownerId: 'owner-6',
      tenantId: t.id,
      talentId: 10,
      suggestions: [sug({ id: 'a', proposed: 'Rust' })],
      cv: { hardSkills: [] },
    });
    h.currentUserId.value = 'owner-6';
    h.clientThrows.value = true;

    expect(await approveSuggestion(c.id, 'a')).toEqual({ ok: true });
    const row = await prisma.candidate.findUnique({ where: { id: c.id } });
    expect((row!.profileJson as { cv: { hardSkills: string[] } }).cv.hardSkills).toContain('Rust');
    expect((row!.cvSuggestionsJson as unknown as CvSuggestion[])[0].status).toBe('approved');
    // No writes landed (client construction threw).
    expect(h.calls.filter((c) => c.fn === 'addSkill')).toHaveLength(0);
  });

  it('approveSuggestion is a no-op push when candidate is not synced', async () => {
    const t = await mkTenant();
    const c = await mkCandidate({
      ownerId: 'owner-7',
      tenantId: t.id,
      talentId: null, // not synced
      suggestions: [sug({ id: 'a', proposed: 'Go' })],
      cv: { hardSkills: [] },
    });
    h.currentUserId.value = 'owner-7';

    expect(await approveSuggestion(c.id, 'a')).toEqual({ ok: true });
    expect(h.calls).toHaveLength(0);
  });

  it('approveAllSuggestions approves every pending one', async () => {
    const t = await mkTenant();
    const c = await mkCandidate({
      ownerId: 'owner-8',
      tenantId: t.id,
      talentId: 11,
      suggestions: [
        sug({ id: 'a', proposed: 'Python' }),
        sug({ id: 'b', proposed: 'SQL' }),
        sug({ id: 'c', status: 'dismissed', proposed: 'C' }),
      ],
      cv: { hardSkills: [] },
    });
    h.currentUserId.value = 'owner-8';

    const res = await approveAllSuggestions(c.id);
    expect(res).toEqual({ ok: true, approved: 2, failed: 0 });

    const row = await prisma.candidate.findUnique({ where: { id: c.id } });
    const cv = (row!.profileJson as { cv: { hardSkills: string[] } }).cv;
    expect(cv.hardSkills.sort()).toEqual(['Python', 'SQL']);
    const sugs = row!.cvSuggestionsJson as unknown as CvSuggestion[];
    expect(sugs.find((s) => s.id === 'a')!.status).toBe('approved');
    expect(sugs.find((s) => s.id === 'c')!.status).toBe('dismissed');
  });
});
