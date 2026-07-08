import { prisma } from '@/lib/db';
import {
  createPlanAction,
  editPlanAction,
  deactivatePlanAction,
} from './actions';

export default async function AdminPlansPage() {
  const plans = await prisma.plan.findMany({ orderBy: { priceEur: 'asc' } });
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-zinc-900">Plans</h1>

      {plans.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-center">
          <p className="text-sm text-zinc-600">
            No plans seeded. Run{' '}
            <code className="rounded bg-zinc-100 px-1.5 py-0.5">npm run stripe:seed</code>{' '}
            on the server, or create one below.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Price (€)</th>
                <th className="px-4 py-3">Credits / period</th>
                <th className="px-4 py-3">Period (months)</th>
                <th className="px-4 py-3">Active</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {plans.map((p) => (
                <tr key={p.id} className="align-top">
                  <td className="px-4 py-3">
                    <form
                      action={editPlanAction}
                      className="flex flex-col gap-2"
                      id={`edit-${p.id}`}
                    >
                      <input type="hidden" name="id" value={p.id} />
                      <input
                        name="name"
                        defaultValue={p.name}
                        className="w-32 rounded-md border border-zinc-300 px-2 py-1 text-sm"
                      />
                      <span className="font-mono text-[10px] text-zinc-400">
                        {p.stripePriceId}
                      </span>
                    </form>
                  </td>
                  <td className="px-4 py-3 text-zinc-700">€{p.priceEur}</td>
                  <td className="px-4 py-3">
                    <input
                      form={`edit-${p.id}`}
                      name="creditsPerPeriod"
                      type="number"
                      min={0}
                      defaultValue={p.creditsPerPeriod}
                      className="w-20 rounded-md border border-zinc-300 px-2 py-1 text-sm"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <input
                      form={`edit-${p.id}`}
                      name="periodMonths"
                      type="number"
                      min={1}
                      defaultValue={p.periodMonths}
                      className="w-20 rounded-md border border-zinc-300 px-2 py-1 text-sm"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <label className="flex items-center gap-1 text-sm text-zinc-700">
                      <input
                        form={`edit-${p.id}`}
                        type="checkbox"
                        name="active"
                        defaultChecked={p.active}
                      />
                      active
                    </label>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button
                        type="submit"
                        form={`edit-${p.id}`}
                        className="rounded-md bg-zinc-900 px-3 py-1 text-xs font-medium text-white hover:bg-zinc-800"
                      >
                        Save
                      </button>
                      {p.active && (
                        <form action={deactivatePlanAction}>
                          <input type="hidden" name="id" value={p.id} />
                          <button
                            type="submit"
                            className="rounded-md border border-rose-300 px-3 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50"
                          >
                            Deactivate
                          </button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="text-lg font-medium text-zinc-900">Create plan</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Provisions a Stripe product + recurring price, then a local plan row.
        </p>
        <form
          action={createPlanAction}
          className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4"
        >
          <label className="flex flex-col gap-1 text-xs text-zinc-600">
            Name
            <input
              name="name"
              required
              className="rounded-md border border-zinc-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-600">
            Price (€)
            <input
              name="priceEur"
              type="number"
              min={0}
              defaultValue={0}
              required
              className="rounded-md border border-zinc-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-600">
            Credits / period
            <input
              name="creditsPerPeriod"
              type="number"
              min={0}
              defaultValue={1}
              required
              className="rounded-md border border-zinc-300 px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-600">
            Period (months)
            <input
              name="periodMonths"
              type="number"
              min={1}
              defaultValue={2}
              required
              className="rounded-md border border-zinc-300 px-2 py-1 text-sm"
            />
          </label>
          <div className="col-span-2 sm:col-span-4">
            <button
              type="submit"
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
            >
              Create plan
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
