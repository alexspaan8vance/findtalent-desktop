/**
 * Localized display labels for the DEFAULT pipeline stages.
 *
 * `PipelineStage` rows are org data seeded with canonical English names
 * ("Inflow", "Proposed", "Hired", …) — see `DEFAULT_STAGES` in
 * `src/lib/pipeline.ts`. Those names are also the back-compat anchor for
 * legacy-enum mapping, so they must NOT be translated in the database.
 * Instead, render-time callers map a default name onto an i18n key in the
 * `pipeline` namespace here; a stage the org RENAMED gets no key and renders
 * its custom name verbatim.
 *
 * Client-safe: no prisma import (unlike `src/lib/pipeline.ts`).
 */

export type DefaultStageLabelKey =
  | 'stageName_inflow'
  | 'stageName_shortlist'
  | 'stageName_proposed'
  | 'stageName_interview'
  | 'stageName_hired'
  | 'stageName_rejected';

const KEY_BY_DEFAULT_NAME: Readonly<Record<string, DefaultStageLabelKey>> = {
  inflow: 'stageName_inflow',
  shortlist: 'stageName_shortlist',
  proposed: 'stageName_proposed',
  interview: 'stageName_interview',
  hired: 'stageName_hired',
  rejected: 'stageName_rejected',
};

/**
 * The `pipeline` namespace key for a seeded default-stage name, or null when
 * the name is a custom (user-chosen) one that must render as-is.
 */
export function defaultStageLabelKey(name: string): DefaultStageLabelKey | null {
  return KEY_BY_DEFAULT_NAME[name.trim().toLowerCase()] ?? null;
}

/**
 * Resolve a stage's display label: seeded default names go through the
 * `pipeline`-namespace translator, custom names render verbatim.
 */
export function stageDisplayName(
  name: string,
  tPipeline: (key: DefaultStageLabelKey) => string,
): string {
  const key = defaultStageLabelKey(name);
  return key ? tPipeline(key) : name;
}
