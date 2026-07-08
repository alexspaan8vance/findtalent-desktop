/**
 * Seed for the E2E database. Run with DATABASE_URL=file:./e2e.db.
 */
import bcrypt from 'bcryptjs';

import { prisma } from '../src/lib/db';
import { encrypt, assertCryptoReady } from '../src/lib/crypto';
import { PLAN_TIERS, EXTRA_CREDIT_PRICE_EUR } from '../src/lib/stripe/plans';

export const E2E_ADMIN = { email: 'admin@e2e.local', password: 'E2eAdminPass123!' };
export const E2E_CUSTOMER = { email: 'customer@e2e.local', password: 'E2eCustomerPass123!' };

async function main() {
  assertCryptoReady();

  const clientId = process.env.EIGHTVANCE_CLIENT_ID;
  const clientSecret = process.env.EIGHTVANCE_CLIENT_SECRET;
  const companyIdRaw = process.env.EIGHTVANCE_COMPANY_ID;
  if (!clientId || !clientSecret || !companyIdRaw) {
    throw new Error('EIGHTVANCE_* env vars required for e2e seed');
  }

  // Wipe prior state — the e2e.db file can survive between runs on Windows
  // (file lock prevents global-setup deleting it), and a lingering 14-day
  // reveal lock would otherwise contaminate the next run's anon-detail test.
  await prisma.reveal.deleteMany();
  await prisma.match.deleteMany();
  await prisma.creditTransaction.deleteMany();
  await prisma.savedSearch.deleteMany();
  await prisma.notification.deleteMany();
  // Candidates carry a loose createdByUserId (no FK); wipe them BEFORE users so
  // re-seeding doesn't leave orphaned rows with a stale owner id (which the
  // candidate list filters out → they'd silently vanish across runs).
  await prisma.candidateMatchRun.deleteMany();
  await prisma.candidate.deleteMany();
  await prisma.projectPool.deleteMany();
  await prisma.project.deleteMany();
  await prisma.user.deleteMany();
  await prisma.plan.deleteMany();
  await prisma.tenant.deleteMany();

  const tenant = await prisma.tenant.upsert({
    where: { slug: 'ivta' },
    create: {
      slug: 'ivta',
      name: 'IVTA Talent Pool',
      eightvanceClientId: clientId,
      eightvanceClientSecretEnc: encrypt(clientSecret),
      eightvanceCompanyId: Number.parseInt(companyIdRaw, 10),
      brandConfigJson: { name: 'IVTA', primaryColor: '#0f172a' },
    },
    update: {},
  });
  console.log(`[e2e-seed] tenant ${tenant.slug} (${tenant.id})`);

  // Second pool with intentionally bogus creds — used to verify partial-pool
  // failure handling + pool badges in the UI.
  const tenant2 = await prisma.tenant.upsert({
    where: { slug: 'demo-pool' },
    create: {
      slug: 'demo-pool',
      name: 'Demo Pool (no creds)',
      eightvanceClientId: 'bogus-client-id',
      eightvanceClientSecretEnc: encrypt('bogus-secret'),
      eightvanceCompanyId: 99999,
      brandConfigJson: { name: 'Demo', primaryColor: '#334155' },
    },
    update: {},
  });
  console.log(`[e2e-seed] tenant ${tenant2.slug} (${tenant2.id})`);

  const adminHash = await bcrypt.hash(E2E_ADMIN.password, 12);
  const admin = await prisma.user.upsert({
    where: { email: E2E_ADMIN.email },
    create: {
      email: E2E_ADMIN.email,
      passwordHash: adminHash,
      role: 'ADMIN',
      emailVerifiedAt: new Date(),
    },
    update: { passwordHash: adminHash, role: 'ADMIN', emailVerifiedAt: new Date() },
  });
  console.log(`[e2e-seed] admin ${admin.email}`);

  const customerHash = await bcrypt.hash(E2E_CUSTOMER.password, 12);
  const customer = await prisma.user.upsert({
    where: { email: E2E_CUSTOMER.email },
    create: {
      email: E2E_CUSTOMER.email,
      passwordHash: customerHash,
      role: 'CUSTOMER',
      emailVerifiedAt: new Date(),
      creditsBalance: 5,
      // The candidates surface is per-user opt-in (schema default false since
      // the fail-closed security pass). Without it the middleware bounces the
      // seeded customer off /app/candidates — specs 12 + 17 need access.
      candidatesEnabled: true,
    },
    update: {
      passwordHash: customerHash,
      emailVerifiedAt: new Date(),
      creditsBalance: 5,
      candidatesEnabled: true,
    },
  });
  await prisma.creditTransaction.create({
    data: { userId: customer.id, delta: 5, reason: 'INITIAL', refId: 'e2e-seed' },
  });
  console.log(`[e2e-seed] customer ${customer.email} (5 credits)`);

  // A seeded candidate on the DEMO pool (bogus creds by design) so candidate
  // specs can exercise the match screen + GDPR export/delete WITHOUT ever
  // writing a test talent into the real IVTA PROD pool. Intentionally NOT
  // synced (eightvanceTalentId null) + has consent, so a rematch attempt
  // surfaces the "sync failed" reason (demo-pool 8vance auth fails) — exactly
  // the not-synced/failed UI we want to assert. PII auto-encrypts on write.
  const candidate = await prisma.candidate.create({
    data: {
      createdByUserId: customer.id,
      tenantId: tenant2.id, // demo-pool — bogus creds, never reaches real 8vance
      name: 'E2E Candidate Klaas',
      email: 'e2e.candidate@example.com',
      phone: '+31612345678',
      locale: 'nl',
      cvText: 'E2E Candidate — Software Engineer at Acme. Skills: Python, SQL, Docker.',
      status: 'ONBOARDING',
      consentGivenAt: new Date(),
      profileJson: {
        full_name: 'E2E Candidate Klaas',
        source: 'findtalent',
        skills: [{ skill: 1 }, { skill: 2 }, { skill: 3 }],
        cv: {
          about: 'Backend engineer, 8 years.',
          hardSkills: ['Python', 'SQL', 'Docker'],
          softSkills: ['Communication'],
          knowledge: ['REST APIs'],
          languages: [{ name: 'Dutch', level: 5 }],
          education: [{ degree: 'BSc', field: 'Computer Science', institution: 'TU Delft' }],
          employment: [{ title: 'Backend Engineer', company: 'Acme', current: true }],
          certifications: [],
        },
      },
      preferencesJson: { sources: [], contractTypes: [], radiusKm: 30, remote: false },
    },
    select: { id: true },
  });
  console.log(`[e2e-seed] candidate ${candidate.id} (demo-pool, unsynced)`);

  // A SECOND seeded candidate — "E2E Match Klaas" — used by the candidate→jobs
  // match UI spec (e2e/17-candidate-match-ui.spec.ts). It is SYNCED
  // (eightvanceTalentId set, so the UI renders the "synced" state) and carries a
  // READY CandidateMatchRun with a handful of CandidateJobMatch rows whose
  // payloadJson is hand-built to exercise the two new visual facets:
  //   * the category-coloured SOURCE-PROVENANCE chips (own pool / demo / external)
  //   * the TRAVEL-TIME filter (car/bike toggle + max-bucket select + include-unknown)
  // There is no real 8vance here (demo creds), so a live match can't produce
  // these rows — we seed them deterministically. The own-pool job is detected by
  // employerCompanyId === the tenant's eightvanceCompanyId (demo-pool == 99999),
  // NOT by the source string. Lives on the demo pool so it never touches PROD.
  // Kept ALIVE (the match spec does not delete it), separate from "E2E Candidate
  // Klaas" which the serial GDPR spec hard-deletes.
  const ownCompanyId = tenant2.eightvanceCompanyId; // demo-pool company == own pool
  const publishedAt = new Date().toISOString();
  const matchCandidate = await prisma.candidate.create({
    data: {
      createdByUserId: customer.id,
      tenantId: tenant2.id, // demo-pool — bogus creds, never reaches real 8vance
      name: 'E2E Match Klaas',
      email: 'e2e.match@example.com',
      phone: '+31698765432',
      locale: 'nl',
      cvText: 'E2E Match Klaas — Backend Engineer. Skills: Go, Kubernetes, Postgres.',
      status: 'ONBOARDING',
      consentGivenAt: new Date(),
      // Synced: a non-null talent id flips the UI into the "synced" state so the
      // results (not the not-synced empty state) render.
      eightvanceTalentId: 999001,
      profileJson: {
        full_name: 'E2E Match Klaas',
        source: 'findtalent',
        skills: [{ skill: 4 }, { skill: 5 }, { skill: 6 }],
        cv: {
          about: 'Platform engineer, 10 years.',
          hardSkills: ['Go', 'Kubernetes', 'Postgres'],
          softSkills: ['Leadership'],
          knowledge: ['Distributed systems'],
          languages: [{ name: 'Dutch', level: 5 }],
          education: [{ degree: 'MSc', field: 'Computer Science', institution: 'TU Eindhoven' }],
          employment: [{ title: 'Platform Engineer', company: 'Globex', current: true }],
          certifications: [],
        },
      },
      // Captured work-preferences whose vocabulary deliberately matches NO
      // seeded row: contractTypes carries the wizard SLUG ('permanent') while
      // rows carry raw feed strings ('Vast'/'Tijdelijk'), and workMode is
      // 'remote' while no seeded row is remote. These used to seed INVISIBLE,
      // un-clearable client-side filters that zeroed the whole job list (the
      // "N gevonden, 0 getoond" prod bug) — spec 17 asserts all 4 cards still
      // render, which regression-guards the seed-intersection fix.
      preferencesJson: {
        sources: [],
        contractTypes: ['permanent'],
        radiusKm: 30,
        remote: false,
        workMode: 'remote',
      },
    },
    select: { id: true },
  });

  // READY run + 4 deterministic job rows. payloadJson mirrors NormalizedJobMatch
  // (the shape page.tsx folds in): keys source, travel, employerName,
  // locationCity, remote, publishedAt. The dedicated columns (source,
  // employerCompanyId, score, title, …) are set too — page.tsx prefers the
  // column, falling back to payload.
  //   A  own pool  (company == 99999)      travel car ≤30 min  → "Eigen vacature" chip
  //   B  demo      (source 'Job Explore')  travel car ≤30 min  → "Job Explore" chip (violet)
  //   C  external  (source 'OnlineVacaturesNL') travel car ≤60 min → "OnlineVacatures.nl" chip (amber)
  //   D  demo      (source 'Job Explore')  NO travel (unknown bucket)
  // Filter math (bucketRank lt30=1 < lt60=3): selecting car + max ≤30 hides C;
  // unchecking "include unknown" then hides D — both deterministic.
  await prisma.candidateMatchRun.create({
    data: {
      candidateId: matchCandidate.id,
      sourcesJson: ['ownpool', 'jobdigger'],
      filtersJson: {},
      status: 'READY',
      completedAt: new Date(),
      jobs: {
        create: [
          {
            eightvanceJobId: 900001,
            score: 0.91,
            title: 'Alpha Backend Engineer',
            employerName: 'IVTA Talent Pool',
            employerCompanyId: ownCompanyId, // == own pool → "Eigen vacature" chip
            source: 'ownpool',
            contractType: 'Vast',
            locationCity: 'Amsterdam',
            locationLabel: 'Amsterdam, NL',
            isStaffingAgency: false,
            agencyScore: 0,
            agencyReasonsJson: [],
            payloadJson: {
              source: 'ownpool',
              employerName: 'IVTA Talent Pool',
              locationCity: 'Amsterdam',
              remote: false,
              publishedAt,
              travel: { car: 'lt30' },
            },
          },
          {
            eightvanceJobId: 900002,
            score: 0.82,
            title: 'Bravo Frontend Engineer',
            employerName: 'Demo Corp',
            employerCompanyId: 55555, // open market (≠ own pool)
            source: 'Job Explore', // demo category (violet)
            contractType: 'Vast',
            locationCity: 'Rotterdam',
            locationLabel: 'Rotterdam, NL',
            isStaffingAgency: false,
            agencyScore: 0,
            agencyReasonsJson: [],
            payloadJson: {
              source: 'Job Explore',
              employerName: 'Demo Corp',
              locationCity: 'Rotterdam',
              remote: false,
              publishedAt,
              travel: { car: 'lt30' },
            },
          },
          {
            eightvanceJobId: 900003,
            score: 0.74,
            title: 'Charlie Data Engineer',
            employerName: 'External BV',
            employerCompanyId: 44444, // open market
            source: 'OnlineVacaturesNL', // external category (amber) → "OnlineVacatures.nl"
            contractType: 'Tijdelijk',
            locationCity: 'Den Haag',
            locationLabel: 'Den Haag, NL',
            isStaffingAgency: false,
            agencyScore: 0,
            agencyReasonsJson: [],
            payloadJson: {
              source: 'OnlineVacaturesNL',
              employerName: 'External BV',
              locationCity: 'Den Haag',
              remote: false,
              publishedAt,
              travel: { car: 'lt60' }, // farther → excluded by a ≤30 car filter
            },
          },
          {
            eightvanceJobId: 900004,
            score: 0.66,
            title: 'Delta Platform Engineer',
            employerName: 'Faraway Inc',
            employerCompanyId: 33333, // open market
            source: 'Job Explore',
            contractType: 'Vast',
            locationCity: 'Groningen',
            locationLabel: 'Groningen, NL',
            isStaffingAgency: false,
            agencyScore: 0,
            agencyReasonsJson: [],
            payloadJson: {
              source: 'Job Explore',
              employerName: 'Faraway Inc',
              locationCity: 'Groningen',
              remote: false,
              publishedAt,
              // NO travel key → unknown bucket (toggled by "include unknown").
            },
          },
        ],
      },
    },
  });
  console.log(`[e2e-seed] match candidate ${matchCandidate.id} (demo-pool, synced, READY run + 4 jobs)`);

  // A seeded DRAFT project owned by the customer — lets project-management
  // specs (archive / unarchive / filter / rerun-button) run without driving
  // the slow real-8vance create wizard.
  const project = await prisma.project.create({
    data: {
      userId: customer.id,
      title: 'E2E Seeded Project',
      locationCity: 'Amsterdam',
      locationCountry: 'Netherlands',
      skillsJson: [{ id: 1, name: 'Project management' }],
      languagesJson: [],
      status: 'DRAFT',
    },
    select: { id: true },
  });
  console.log(`[e2e-seed] project ${project.id} (draft)`);

  for (const tier of PLAN_TIERS) {
    await prisma.plan.upsert({
      where: { stripePriceId: `price_dev_${tier.key}` },
      create: {
        stripePriceId: `price_dev_${tier.key}`,
        name: tier.name,
        priceEur: tier.priceEur,
        creditsPerPeriod: tier.creditsPerPeriod,
        periodMonths: tier.periodMonths,
        featuresJson: { tierKey: tier.key, devSeed: true },
        active: true,
      },
      update: { active: true },
    });
  }
  await prisma.plan.upsert({
    where: { stripePriceId: 'price_dev_extra-credit' },
    create: {
      stripePriceId: 'price_dev_extra-credit',
      name: 'Extra credit',
      priceEur: EXTRA_CREDIT_PRICE_EUR,
      creditsPerPeriod: 1,
      periodMonths: 0,
      featuresJson: { tierKey: 'extra-credit', devSeed: true },
      active: true,
    },
    update: { active: true },
  });
  console.log('[e2e-seed] plans seeded');

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
