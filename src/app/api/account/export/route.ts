import { NextResponse } from 'next/server';

import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/auth-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireUser();

  const dump = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      createdAt: true,
      creditsBalance: true,
      purchasedCredits: true,
      creditsPeriodEnd: true,
      projects: {
        select: {
          id: true,
          title: true,
          status: true,
          createdAt: true,
          skillsJson: true,
          languagesJson: true,
          locationCity: true,
          locationCountry: true,
          locationProvince: true,
        },
      },
      reveals: {
        select: {
          id: true,
          projectId: true,
          eightvanceTalentId: true,
          revealedAt: true,
          expiresAt: true,
          creditCost: true,
          piiPayloadEnc: true,
        },
      },
      creditTx: {
        select: {
          id: true,
          delta: true,
          reason: true,
          refId: true,
          createdAt: true,
        },
      },
      savedSearches: {
        select: {
          id: true,
          name: true,
          notifyEmail: true,
          lastRunAt: true,
          createdAt: true,
        },
      },
    },
  });

  if (!dump) {
    return new NextResponse('Not found', { status: 404 });
  }

  const filename = `findtalent-export-${user.id}-${new Date().toISOString().slice(0, 10)}.json`;
  return new NextResponse(JSON.stringify(dump, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
