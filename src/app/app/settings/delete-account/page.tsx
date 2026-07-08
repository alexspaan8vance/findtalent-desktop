import { deleteAccountAction, exportAccountAction } from './actions';

export const metadata = { title: 'Delete account' };

export default function DeleteAccountPage() {
  return (
    <div className="mx-auto max-w-xl space-y-8">
      <h1 className="text-2xl font-semibold text-zinc-900">Account export &amp; deletion</h1>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Export
        </h2>
        <p className="mt-2 text-sm text-zinc-600">
          Download a JSON file containing your profile, projects, credit history, and
          reveal records. Reveal payloads remain encrypted in your download.
        </p>
        <form action={exportAccountAction} className="mt-4">
          <button
            type="submit"
            className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
          >
            Download my data
          </button>
        </form>
      </section>

      <section className="rounded-2xl border border-rose-200 bg-rose-50 p-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-rose-700">
          Delete account
        </h2>
        <p className="mt-2 text-sm text-rose-800">
          Permanently delete your account, projects, and reveal records. This cannot be
          undone. Audit log entries are retained in anonymized form.
        </p>
        <form action={deleteAccountAction} className="mt-4">
          <label className="block text-xs text-rose-800">
            Type DELETE to confirm
            <input
              name="confirm"
              required
              className="mt-1 block w-full rounded-md border border-rose-300 px-2 py-1.5 text-sm"
            />
          </label>
          <button
            type="submit"
            className="mt-3 rounded-lg bg-rose-700 px-4 py-2 text-sm font-medium text-white hover:bg-rose-800"
          >
            Delete my account
          </button>
        </form>
      </section>
    </div>
  );
}
