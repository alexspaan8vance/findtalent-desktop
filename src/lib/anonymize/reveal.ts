/**
 * Reveal payload builder.
 *
 * Server-side only: after a Reveal credit-spend we cache the full PII payload
 * for 14 days (the lock duration) so the client can re-open the card without
 * additional 8vance API calls.
 */

import type { RawTalent, RevealedTalent } from './types';

export function buildRevealed(raw: RawTalent): RevealedTalent {
  // Deep clone via structured serialization so callers cannot mutate
  // the original Raw object through the returned reference.
  return JSON.parse(JSON.stringify(raw)) as RevealedTalent;
}
