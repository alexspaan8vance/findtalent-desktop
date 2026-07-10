import Link from 'next/link';

import { requireAdmin } from '@/lib/auth-helpers';

const NAV = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/companies', label: 'Companies' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/plans', label: 'Plans' },
  { href: '/admin/branding', label: 'Branding' },
  { href: '/admin/staffing-rules', label: 'Staffing rules' },
  { href: '/admin/analytics', label: 'Analytics' },
  { href: '/admin/audit', label: 'Audit log' },
  { href: '/admin/feedback', label: 'Feedback' },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="border-b border-zinc-900 bg-zinc-950 text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-6">
            <Link href="/admin" className="text-lg font-semibold">
              Admin
            </Link>
            <nav className="hidden gap-4 text-sm sm:flex">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="text-zinc-300 hover:text-white">
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/app/projects" className="text-zinc-300 hover:text-white">
              Exit admin
            </Link>
            {/* Stable URL POST (not a hashed Server Action) so sign-out works
                from a stale tab after a redeploy. */}
            <form action="/signout" method="post">
              <button
                type="submit"
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-zinc-200 hover:bg-zinc-800"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
