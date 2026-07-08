import { NextResponse } from 'next/server';

import { requireUser } from '@/lib/auth-helpers';
import { createPortalSession } from '@/lib/stripe/checkout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const user = await requireUser();
  const base = process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
  // `?flow=change-plan` opens the portal directly on the plan-switch screen so
  // upgrades/downgrades prorate the existing subscription.
  const flow =
    new URL(req.url).searchParams.get('flow') === 'change-plan'
      ? ('subscription_update' as const)
      : undefined;
  try {
    const { url } = await createPortalSession(user.id, `${base}/app/settings`, {
      flow,
    });
    return NextResponse.redirect(url);
  } catch (err) {
    // Never surface raw Stripe errors (may contain config/keys) to the client.
    // eslint-disable-next-line no-console
    console.error(
      '[billing-portal] failed:',
      err instanceof Error ? err.message : 'unknown',
    );
    return NextResponse.redirect(`${base}/billing?error=portal_unavailable`);
  }
}
