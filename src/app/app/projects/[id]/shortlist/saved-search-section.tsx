import { getTranslations } from 'next-intl/server';

import { prisma } from '@/lib/db';

import {
  createSavedSearchAction,
  deleteSavedSearchAction,
  toggleMonitorAction,
} from '../saved-search/actions';

interface Props {
  projectId: string;
  userId: string;
}

export async function SavedSearchSection({ projectId, userId }: Props) {
  const t = await getTranslations('shortlist');
  const [project, saved] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { title: true, locationCity: true },
    }),
    prisma.savedSearch.findMany({
      where: { projectId, userId },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  // Default the name to something recognizable, e.g.
  // "Senior backend engineer Eindhoven — update".
  const defaultName = [project?.title, project?.locationCity]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ');
  const suggestedName = (defaultName ? `${defaultName} — ${t('updateSuffix')}` : t('weeklyMonitor')).slice(0, 100);
  const monitoring = saved.length > 0;

  return (
    <section className="mt-8 rounded-2xl border border-zinc-200 bg-white p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            {t('savedSearches')}
          </h2>
          <p className="mt-1 text-xs text-zinc-500">{t('savedSearchesBody')}</p>
        </div>
        <form action={toggleMonitorAction}>
          <input type="hidden" name="projectId" value={projectId} />
          <button
            type="submit"
            className={
              monitoring
                ? 'inline-flex items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100'
                : 'inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800'
            }
          >
            <span
              className={
                monitoring
                  ? 'h-1.5 w-1.5 rounded-full bg-emerald-500'
                  : 'h-1.5 w-1.5 rounded-full bg-white/70'
              }
              aria-hidden
            />
            {monitoring ? t('monitoringOn') : t('monitorProject')}
          </button>
        </form>
      </div>

      {saved.length > 0 && (
        <ul className="mt-4 space-y-2">
          {saved.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2 text-sm"
            >
              <div>
                <div className="font-medium text-zinc-900">{s.name}</div>
                <div className="text-xs text-zinc-500">
                  {s.notifyEmail ? t('emailOnNewMatches') : t('noNotifications')} ·
                  {' '}{t('lastRun')}{' '}
                  {s.lastRunAt
                    ? new Date(s.lastRunAt).toLocaleDateString()
                    : t('never')}
                </div>
              </div>
              <form action={deleteSavedSearchAction}>
                <input type="hidden" name="savedSearchId" value={s.id} />
                <input type="hidden" name="projectId" value={projectId} />
                <button
                  type="submit"
                  className="text-xs text-rose-700 hover:underline"
                >
                  {t('remove')}
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <form action={createSavedSearchAction} className="mt-4 flex items-end gap-2">
        <input type="hidden" name="projectId" value={projectId} />
        <label className="flex-1">
          <span className="block text-xs text-zinc-600">{t('name')}</span>
          <input
            name="name"
            defaultValue={suggestedName}
            required
            className="mt-1 w-full rounded-md border border-zinc-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-zinc-700">
          <input
            type="checkbox"
            name="notifyEmail"
            defaultChecked
            className="h-4 w-4 rounded border-zinc-300"
          />
          {t('emailMe')}
        </label>
        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
        >
          {t('saveSearch')}
        </button>
      </form>
    </section>
  );
}
