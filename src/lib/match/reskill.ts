/**
 * Reskill / career-path suggestions (v2match).
 *
 * Given a candidate's current role or skill text, returns the nearest jobs on
 * the 8vance HANDSOME cluster-DNA and, per job, the skill-clusters the
 * candidate still needs to learn (the DNA delta). Powers "from role A → B you
 * still miss skill X, Y" in the candidate view.
 *
 * Flag-gated on `V2MATCH_URL` (shared with the DNA match signal). Fails closed
 * to an empty list — never throws into the caller.
 */

function baseUrl(): string {
  return process.env.V2MATCH_URL?.replace(/\/+$/, '') || '';
}
function timeoutMs(): number {
  return Number.parseInt(process.env.V2MATCH_TIMEOUT_MS ?? '4000', 10);
}

export interface ReskillGap {
  /** cluster label the candidate under-covers for this target job */
  cluster: string;
  /** how much DNA mass is still missing (0..1) */
  gap: number;
}

export interface ReskillNeighbor {
  /** target job label */
  label: string;
  /** cluster-DNA cosine to the candidate (0..1) */
  cosine: number;
  /** skills/clusters still to learn to reach this job */
  learn: ReskillGap[];
}

export interface ReskillResult {
  /** canonical function the input mapped to */
  from: string;
  neighbors: ReskillNeighbor[];
}

/**
 * Nearest jobs + skill-gap for a candidate's current role/skill text.
 * Returns null when disabled or on any error/timeout.
 */
export async function reskillPaths(text: string, k = 12): Promise<ReskillResult | null> {
  const url = baseUrl();
  if (!url) return null;
  const t = text.trim();
  if (!t) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs());
  try {
    const res = await fetch(`${url}/neighbors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: t, k }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      from?: unknown;
      neighbors?: Array<{ label?: unknown; cosine?: unknown; learn?: unknown }>;
    };
    if (!Array.isArray(j.neighbors)) return null;
    const neighbors: ReskillNeighbor[] = j.neighbors
      .map((n) => {
        const label = typeof n.label === 'string' ? n.label : '';
        const cosine = typeof n.cosine === 'number' && Number.isFinite(n.cosine) ? n.cosine : 0;
        const learn = Array.isArray(n.learn)
          ? (n.learn as Array<{ cluster?: unknown; gap?: unknown }>)
              .map((g) => ({
                cluster: typeof g.cluster === 'string' ? g.cluster : '',
                gap: typeof g.gap === 'number' && Number.isFinite(g.gap) ? g.gap : 0,
              }))
              .filter((g) => g.cluster)
          : [];
        return { label, cosine, learn };
      })
      .filter((n) => n.label);
    return { from: typeof j.from === 'string' ? j.from : t, neighbors };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
