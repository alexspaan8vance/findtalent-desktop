import { prisma } from '@/lib/db';
import { availableCredits } from '@/lib/credits';
import { adjustCreditsAction, refundCreditsAction } from './actions';

export default async function AdminUsersPage() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-zinc-900">Users</h1>
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Verified</th>
              <th className="px-4 py-3">Credits</th>
              <th className="px-4 py-3">Joined</th>
              <th className="px-4 py-3">Credit ops</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {users.map((u) => (
              <tr key={u.id} className="align-top">
                <td className="px-4 py-3 text-zinc-900">{u.email}</td>
                <td className="px-4 py-3 text-zinc-700">{u.role}</td>
                <td className="px-4 py-3 text-zinc-700">
                  {u.emailVerifiedAt ? 'yes' : 'no'}
                </td>
                <td className="px-4 py-3 text-zinc-700">
                  {availableCredits(u)}
                  <span className="ml-1 text-xs text-zinc-400">
                    ({u.creditsBalance}+{u.purchasedCredits})
                  </span>
                </td>
                <td className="px-4 py-3 text-zinc-500">
                  {new Date(u.createdAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-col gap-3">
                    {/* Adjust subscription credits (+ grant / − deduct). */}
                    <form action={adjustCreditsAction} className="flex flex-col gap-1">
                      <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                        Adjust subscription credits (+ or −)
                      </span>
                      <input type="hidden" name="userId" value={u.id} />
                      <div className="flex items-center gap-1.5">
                        <input
                          name="amount"
                          type="number"
                          placeholder="e.g. +5 or -2"
                          title="Positive to grant, negative to deduct"
                          className="w-28 rounded-md border border-zinc-300 px-2 py-1 text-xs"
                          required
                        />
                        <input
                          name="note"
                          placeholder="reason (optional)"
                          className="w-32 rounded-md border border-zinc-300 px-2 py-1 text-xs"
                        />
                        <button
                          type="submit"
                          className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-800"
                        >
                          Adjust
                        </button>
                      </div>
                    </form>
                    {/* Refund = add pack (purchased) credits back. */}
                    <form action={refundCreditsAction} className="flex flex-col gap-1">
                      <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                        Refund pack credits (+)
                      </span>
                      <input type="hidden" name="userId" value={u.id} />
                      <div className="flex items-center gap-1.5">
                        <input
                          name="amount"
                          type="number"
                          min={1}
                          placeholder="e.g. 1"
                          title="Number of pack credits to refund"
                          className="w-28 rounded-md border border-zinc-300 px-2 py-1 text-xs"
                          required
                        />
                        <input
                          name="note"
                          placeholder="reason (optional)"
                          className="w-32 rounded-md border border-zinc-300 px-2 py-1 text-xs"
                        />
                        <input
                          name="sessionId"
                          placeholder="purchase/session id (optional)"
                          title="Original Stripe purchase/session id — makes the refund idempotent (blocks a double refund of the same purchase)"
                          className="w-44 rounded-md border border-zinc-300 px-2 py-1 text-xs"
                        />
                        <button
                          type="submit"
                          className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-900 hover:bg-zinc-50"
                        >
                          Refund
                        </button>
                      </div>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
