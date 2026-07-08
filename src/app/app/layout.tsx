import Link from 'next/link';

import { requireUser } from '@/lib/auth-helpers';
import { canAccessCandidates } from '@/lib/access';
import { prisma } from '@/lib/db';
import { availableCredits, LOW_CREDITS_THRESHOLD } from '@/lib/credits';
import { getBrandConfig } from '@/lib/brand/config';
import { getTranslations } from 'next-intl/server';
import { LocaleSwitcher } from '@/components/locale-switcher';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const brand = getBrandConfig();
  const t = await getTranslations('app');
  const [unreadCount, billing] = await Promise.all([
    prisma.notification.count({
      where: { userId: user.id, readAt: null },
    }),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { subscriptionStatus: true, creditsBalance: true, purchasedCredits: true },
    }),
  ]);
  const isPastDue = billing?.subscriptionStatus === 'past_due';
  const credits = billing ? availableCredits(billing) : 0;
  const isLowCredits = !!billing && credits <= LOW_CREDITS_THRESHOLD;
  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-8">
            <Link href="/app/dashboard" className="text-lg font-semibold text-zinc-900">
              {brand.name}
            </Link>
            <nav className="hidden gap-5 text-sm text-zinc-700 sm:flex">
              <Link href="/app/dashboard" className="hover:text-zinc-950">
                {t('navDashboard')}
              </Link>
              <Link href="/app/projects" className="hover:text-zinc-950">
                {t('navProjects')}
              </Link>
              {canAccessCandidates(user) && (
                <Link href="/app/candidates" className="hover:text-zinc-950">
                  {t('navCandidates')}
                </Link>
              )}
              <Link href="/app/reveals" className="hover:text-zinc-950">
                {t('navReveals')}
              </Link>
              <Link
                href="/app/notifications"
                className="inline-flex items-center gap-1.5 hover:text-zinc-950"
              >
                {t('navNotifications')}
                {unreadCount > 0 && (
                  <span
                    className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none"
                    style={{ background: 'var(--ft-accent)', color: 'var(--ft-accent-fg)' }}
                  >
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </Link>
              <Link href="/app/settings" className="hover:text-zinc-950">
                {t('navSettings')}
              </Link>
              {user.role === 'ADMIN' && (
                <Link href="/admin" className="text-zinc-900 hover:underline">
                  {t('navAdmin')}
                </Link>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-zinc-500 sm:inline">{user.email}</span>
            <LocaleSwitcher />
            {/* Native POST to a stable URL (not a content-hashed Server Action)
                so sign-out survives redeploys even from a stale tab. */}
            <form action="/signout" method="post">
              <button
                type="submit"
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-zinc-700 hover:bg-zinc-100"
              >
                {t('signOut')}
              </button>
            </form>
          </div>
        </div>
      </header>
      {isPastDue && (
        // Dismissible past_due banner. Dismissal is CSS-only (peer checkbox) so
        // the layout stays a Server Component with no extra client bundle: the
        // hidden checkbox, once checked via its label, hides the sibling alert.
        <div className="mx-auto max-w-6xl px-6 pt-4">
          <input
            type="checkbox"
            id="ft-pastdue-dismiss"
            className="peer sr-only"
            aria-hidden="true"
          />
          <div
            role="alert"
            className="flex items-start justify-between gap-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 peer-checked:hidden"
          >
            <div>
              <span className="font-medium">{t('pastDueTitle')}</span>{' '}
              <span>{t('pastDueBody')}</span>{' '}
              <Link href="/billing/portal" className="font-medium underline">
                {t('pastDueCta')}
              </Link>
            </div>
            <label
              htmlFor="ft-pastdue-dismiss"
              className="-mr-1 shrink-0 cursor-pointer rounded px-2 py-0.5 text-amber-700 hover:bg-amber-100"
              aria-label={t('pastDueDismiss')}
            >
              ✕
            </label>
          </div>
        </div>
      )}
      {isLowCredits && (
        // Dismissible low-credit banner — same CSS-only (peer checkbox) pattern
        // as the past_due banner above, so the layout stays a Server Component.
        <div className="mx-auto max-w-6xl px-6 pt-4">
          <input
            type="checkbox"
            id="ft-lowcredits-dismiss"
            className="peer sr-only"
            aria-hidden="true"
          />
          <div
            role="alert"
            className="flex items-start justify-between gap-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 peer-checked:hidden"
          >
            <div>
              <span className="font-medium">{t('lowCreditsTitle')}</span>{' '}
              <span>{t('lowCreditsBody', { count: credits })}</span>{' '}
              <Link href="/billing/choose-plan" className="font-medium underline">
                {t('lowCreditsCta')}
              </Link>
            </div>
            <label
              htmlFor="ft-lowcredits-dismiss"
              className="-mr-1 shrink-0 cursor-pointer rounded px-2 py-0.5 text-amber-700 hover:bg-amber-100"
              aria-label={t('lowCreditsDismiss')}
            >
              ✕
            </label>
          </div>
        </div>
      )}
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
