import { prisma } from '@/lib/db';

export default async function AdminOverview() {
  const [tenants, users, projects, reveals, recentReveals] = await Promise.all([
    prisma.tenant.count(),
    prisma.user.count(),
    prisma.project.count(),
    prisma.reveal.count(),
    prisma.reveal.findMany({
      orderBy: { revealedAt: 'desc' },
      take: 10,
      select: {
        revealedAt: true,
        expiresAt: true,
        eightvanceTalentId: true,
        user: { select: { email: true } },
        project: { select: { title: true } },
      },
    }),
  ]);

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold text-zinc-900">Overview</h1>
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Companies" value={tenants} />
        <Stat label="Users" value={users} />
        <Stat label="Projects" value={projects} />
        <Stat label="Reveals (total)" value={reveals} />
      </div>

      <section className="rounded-xl border border-zinc-200 bg-white p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Recent reveals
        </h2>
        {recentReveals.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-600">No reveals yet.</p>
        ) : (
          <table className="mt-4 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="pb-2">When</th>
                <th>User</th>
                <th>Project</th>
                <th>Talent</th>
                <th>Locked until</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {recentReveals.map((r, i) => (
                <tr key={i} className="text-zinc-800">
                  <td className="py-2">
                    {new Date(r.revealedAt).toLocaleString()}
                  </td>
                  <td>{r.user.email}</td>
                  <td>{r.project.title}</td>
                  <td>#{r.eightvanceTalentId}</td>
                  <td>{new Date(r.expiresAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-3xl font-semibold text-zinc-900">{value}</div>
    </div>
  );
}
