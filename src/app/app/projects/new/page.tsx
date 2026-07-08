import { getTranslations } from 'next-intl/server';

import { requireUser } from '@/lib/auth-helpers';
import { Wizard } from './wizard';

export const dynamic = 'force-dynamic';

export default async function NewProjectPage() {
  await requireUser();
  const t = await getTranslations('wizard');

  return (
    <main className="min-h-screen bg-zinc-50 py-10">
      <div className="mx-auto max-w-3xl px-4">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold text-zinc-900">{t('pageTitle')}</h1>
          <p className="mt-1 text-sm text-zinc-500">{t('pageSubtitle')}</p>
        </header>
        <Wizard />
      </div>
    </main>
  );
}
