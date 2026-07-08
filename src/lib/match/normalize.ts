/**
 * Function normalizer (v2match).
 *
 * Maps any raw job title / CV term — Dutch or English, gendered or neutral —
 * to the canonical 8vance HANDSOME function(s) via the soft cluster-DNA
 * lookup. Language- and gender-invariant by construction (leraar ≡ lerares ≡
 * teacher). Intended for intake normalization: CV onboarding, JobDigger
 * import, job2000 enrichment — anywhere a free-text occupation must become a
 * stable taxonomy anchor.
 *
 * Flag-gated on `V2MATCH_URL`; returns null when disabled or on any error.
 */

function baseUrl(): string {
  return process.env.V2MATCH_URL?.replace(/\/+$/, '') || '';
}
function timeoutMs(): number {
  return Number.parseInt(process.env.V2MATCH_TIMEOUT_MS ?? '4000', 10);
}

export interface FunctionMatch {
  label: string;
  weight: number;
}

export interface NormalizeResult {
  input: string;
  /** best canonical function (highest-weight blend member), or null */
  canonical: string | null;
  /** the soft top-k blend the input mapped to */
  functions: FunctionMatch[];
}

/**
 * Normalize a raw occupation string to canonical 8vance function(s).
 * Returns null when disabled or on any error/timeout.
 */
export async function normalizeFunction(text: string, topk = 5): Promise<NormalizeResult | null> {
  const url = baseUrl();
  if (!url) return null;
  const t = text.trim();
  if (!t) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs());
  try {
    const res = await fetch(`${url}/normalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: t, topk }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      input?: unknown;
      canonical?: unknown;
      functions?: Array<{ label?: unknown; weight?: unknown }>;
    };
    const functions: FunctionMatch[] = Array.isArray(j.functions)
      ? j.functions
          .map((f) => ({
            label: typeof f.label === 'string' ? f.label : '',
            weight: typeof f.weight === 'number' && Number.isFinite(f.weight) ? f.weight : 0,
          }))
          .filter((f) => f.label)
      : [];
    if (functions.length === 0) return null;
    return {
      input: typeof j.input === 'string' ? j.input : t,
      canonical: typeof j.canonical === 'string' ? j.canonical : functions[0].label,
      functions,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
