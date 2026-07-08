/**
 * Placeholder name written on a draft self-onboard Candidate (link minted with
 * no data yet). It shows in the candidates list until the candidate fills in
 * their real name via the portal, so it must read as Dutch product copy.
 *
 * The portal prefill compares against ALL historical placeholder values so
 * legacy rows (created when the placeholder was English) keep hiding the
 * sentinel instead of pre-filling it as the candidate's "name".
 */

export const SELF_ONBOARD_PLACEHOLDER_NAME = 'Zelf-onboarding kandidaat';

const PLACEHOLDER_NAMES: ReadonlySet<string> = new Set([
  SELF_ONBOARD_PLACEHOLDER_NAME,
  // Legacy value written before the NL copy fix.
  'Self-onboard kandidaat',
]);

export function isSelfOnboardPlaceholderName(name: string | null | undefined): boolean {
  return PLACEHOLDER_NAMES.has((name ?? '').trim());
}
