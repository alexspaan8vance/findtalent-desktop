import { prisma } from '@/lib/db';

export default async function AdminAuditPage() {
  const logs = await prisma.adminAuditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-zinc-900">Audit log</h1>
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Admin</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Target</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {logs.map((l) => (
              <tr key={l.id}>
                <td className="px-4 py-3 text-zinc-700">
                  {new Date(l.createdAt).toLocaleString()}
                </td>
                <td className="px-4 py-3 text-zinc-700">{l.adminUserId.slice(0, 12)}…</td>
                <td className="px-4 py-3 font-mono text-zinc-900">{l.action}</td>
                <td className="px-4 py-3 text-zinc-500">
                  {l.targetType}#{l.targetId?.slice(0, 12) ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {logs.length === 0 && (
          <p className="px-4 py-6 text-sm text-zinc-500">No audit entries yet.</p>
        )}
      </div>
    </div>
  );
}
