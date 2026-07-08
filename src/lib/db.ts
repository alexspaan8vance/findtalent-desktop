import { PrismaClient } from '@prisma/client';

import { candidatePiiExtension } from '@/lib/candidate/pii';

/**
 * The Prisma client is extended with `candidatePiiExtension`, which transparently
 * encrypts/decrypts Candidate PII (email/phone/cvText/profileJson) at the query
 * boundary. `$extends` returns a new client type, so we derive the exported type
 * from the factory rather than annotating it `PrismaClient`.
 */
function createPrisma() {
  return new PrismaClient().$extends(candidatePiiExtension);
}

type ExtendedPrisma = ReturnType<typeof createPrisma>;

declare global {
  // eslint-disable-next-line no-var
  var __prisma: ExtendedPrisma | undefined;
}

export const prisma: ExtendedPrisma = global.__prisma ?? createPrisma();

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}
