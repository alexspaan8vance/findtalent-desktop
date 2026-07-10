import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

const CATEGORY_LABEL: Record<string, string> = {
  bug: '🐞 Werkt niet',
  idea: '💡 Idee',
  other: '💬 Anders',
};

export default async function AdminFeedbackPage() {
  await requireAdmin();
  const items = await prisma.feedback.findMany({
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-zinc-900">Feedback</h1>
      <p className="mb-4 text-sm text-zinc-500">
        In-app feedback van gebruikers. Wordt lokaal opgeslagen en — als{' '}
        <code className="rounded bg-zinc-100 px-1">FEEDBACK_WEBHOOK_URL</code> is ingesteld —
        doorgestuurd naar ons (n8n → Jira). {items.length} recent.
      </p>

      {items.length === 0 ? (
        <p className="rounded-lg border border-zinc-200 bg-white px-4 py-6 text-center text-sm text-zinc-500">
          Nog geen feedback ontvangen.
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((f) => (
            <li key={f.id} className="rounded-lg border border-zinc-200 bg-white p-4 text-sm">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                <span className="font-medium text-zinc-700">
                  {CATEGORY_LABEL[f.category] ?? f.category}
                </span>
                <span>·</span>
                <span>{f.userEmail ?? 'onbekend'}</span>
                <span>·</span>
                <span>{new Date(f.createdAt).toLocaleString('nl-NL')}</span>
                {f.appVersion && (
                  <>
                    <span>·</span>
                    <span>v{f.appVersion}</span>
                  </>
                )}
                <span
                  className={`ml-auto rounded-full px-2 py-0.5 ${
                    f.delivered
                      ? 'bg-green-50 text-green-700'
                      : 'bg-amber-50 text-amber-700'
                  }`}
                  title={f.deliveryError ?? ''}
                >
                  {f.delivered ? 'doorgestuurd' : 'alleen lokaal'}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-zinc-900">{f.message}</p>
              {(f.targetText || f.targetHref || f.pageUrl) && (
                <div className="mt-2 rounded-md bg-zinc-50 px-2.5 py-1.5 text-xs text-zinc-600">
                  {f.pageUrl && (
                    <div className="truncate">
                      <span className="text-zinc-400">Pagina:</span> {f.pageUrl}
                    </div>
                  )}
                  {f.targetText && (
                    <div className="truncate">
                      <span className="text-zinc-400">Element:</span> {f.targetText}
                    </div>
                  )}
                  {f.targetHref && (
                    <div className="truncate text-indigo-600">{f.targetHref}</div>
                  )}
                  {f.targetSelector && (
                    <div className="truncate font-mono text-[11px] text-zinc-400">
                      {f.targetSelector}
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
