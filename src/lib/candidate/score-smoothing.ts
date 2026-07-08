/**
 * Match-score smoothing — present findtalent scores on the SAME scale the 8vance
 * PLATFORM shows, not the raw API number.
 *
 * Per 8vance research support (Rehan Fazal, #research_support 2026-07-08): the
 * `/match/specific/` API returns a RAW score in 0..1. The 8vance platform does
 * NOT show `raw × 100` — it runs the raw value through a fixed **smoothing
 * table** (0..100) that spreads out the middle of the range so matches are
 * easier to compare on screen. So `platform ≠ API × 100`.
 *
 * Worked anchors he gave (raw% → shown): 62 → 81, 65 → 82.5, 66 → 83, and a raw
 * ~0.6 shows as ~81. findtalent was displaying raw×100 (~66), which reads far
 * lower than what a recruiter sees in the 8vance UI for the SAME match — a trust
 * problem. We apply the same smoothing so our numbers line up.
 *
 * The EXACT platform table (from the 8vance smoothing screenshot, Slack file
 * F0BFY90MW9G) is transcribed into CALIBRATION below. Note the shape: it EXPANDS
 * the low/mid range (30→40, 50→66.7, 60→80) and COMPRESSES the top HARD — a raw
 * 100% shows as only 92, and 80→90 / 90→91 / 100→92 barely move. So a good-but-
 * not-perfect match reads high (80s), while the very top is capped ~92.
 */

/**
 * Calibration points (rawPercent → shownPercent), ascending by raw, transcribed
 * verbatim from the 8vance platform smoothing table. `[0,0]` is added below the
 * table's first row (30→40) so sub-30 raw interpolates down to 0 on the same
 * slope. Interpolate linearly between neighbours; clamp outside the range.
 */
const CALIBRATION: ReadonlyArray<readonly [raw: number, shown: number]> = [
  [0, 0],
  [30, 40],
  [45, 60],
  [50, 66.7],
  [60, 80],
  [61, 80.5],
  [62, 81],
  [63, 81.5],
  [64, 82],
  [65, 82.5],
  [66, 83],
  [80, 90],
  [90, 91],
  [100, 92],
];

/**
 * Map a RAW match percentage (0..100) to the platform's SMOOTHED display
 * percentage (0..100). Monotonic, clamped, rounded. `smoothScore(66) ≈ 83`.
 */
export function smoothScore(rawPercent: number): number {
  if (!Number.isFinite(rawPercent)) return 0;
  const x = Math.max(0, Math.min(100, rawPercent));
  // Below the first / above the last calibration point → clamp to the endpoint.
  if (x <= CALIBRATION[0][0]) return Math.round(CALIBRATION[0][1]);
  const last = CALIBRATION[CALIBRATION.length - 1];
  if (x >= last[0]) return Math.round(last[1]);
  // Find the bracketing segment and linearly interpolate.
  for (let i = 1; i < CALIBRATION.length; i++) {
    const [x1, y1] = CALIBRATION[i];
    if (x <= x1) {
      const [x0, y0] = CALIBRATION[i - 1];
      const frac = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return Math.round(y0 + frac * (y1 - y0));
    }
  }
  return Math.round(last[1]);
}

/**
 * Accepts a raw score in EITHER 0..1 or 0..100 (findtalent stores both shapes
 * across code paths — see match-client `toPercent`), normalizes to a 0..100 raw
 * percent, then smooths. Convenience wrapper for display call sites.
 */
export function smoothScoreFromRaw(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  const rawPercent = raw <= 1 ? raw * 100 : raw;
  return smoothScore(rawPercent);
}
