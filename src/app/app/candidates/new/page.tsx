import { getTranslations } from 'next-intl/server';

import { requireUser } from '@/lib/auth-helpers';
import { CandidateWizard } from './candidate-wizard';

export const dynamic = 'force-dynamic';

export default async function NewCandidatePage() {
  await requireUser();
  const t = await getTranslations('candidates');

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-900">{t('newPageTitle')}</h1>
        <p className="mt-1 text-sm text-zinc-500">{t('newPageSubtitle')}</p>
      </header>
      <div className="mx-auto max-w-3xl">
        <CandidateWizard />
      </div>
    </div>
  );
}
