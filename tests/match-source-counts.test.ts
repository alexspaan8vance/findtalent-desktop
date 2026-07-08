import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildSourceCounts } from "@/lib/candidate/service";

/**
 * Honesty of the per-source counts persisted on a match run
 * (`sourcesJson.counts` / `.warnings`).
 *
 * Live incident 2026-07-08: 8vance `/match/job/` rejected the JobDigger feed
 * source with a privilege 401; the run recorded NO skip and the UI showed
 * "Open markt: 0" — indistinguishable from an honestly empty market — and a
 * 106-job stored set was superseded by 6 own-pool rows. The data layer must
 * (a) tag a zero that came from a skip/error, and (b) warn when a previously
 * productive feed drops to 0.
 */
describe("buildSourceCounts — skipped feed is distinguishable from a genuine zero", () => {
  const FEED = "OnlineVacaturesNL";

  it("tags an attempted external feed that was skipped/errored with its skip reason", () => {
    const { counts } = buildSourceCounts({
      rowSources: ["tjellens_ecosysteem", "tjellens_ecosysteem", null],
      attempted: [FEED, "tjellens_ecosysteem"],
      skipped: [{ slug: FEED, reason: "error" }],
      hasLocationFilter: true,
    });
    const feed = counts.find((c) => c.slug === FEED);
    expect(feed).toEqual({
      slug: FEED,
      n: 0,
      isOwnPool: false,
      bounded: true,
      skippedReason: "error", // ← the zero did NOT come from an empty market
    });
  });

  it("a feed that RAN and found nothing carries no skippedReason (honest zero)", () => {
    const { counts } = buildSourceCounts({
      rowSources: ["own_pool"],
      attempted: [FEED, "own_pool"],
      skipped: [],
      hasLocationFilter: true,
    });
    const feed = counts.find((c) => c.slug === FEED);
    expect(feed).toMatchObject({ slug: FEED, n: 0 });
    expect(feed).not.toHaveProperty("skippedReason");
  });

  it("counts per-source rows and flags own-pool vs bounded external feeds", () => {
    const { counts } = buildSourceCounts({
      rowSources: [FEED, FEED, FEED, "own_pool", null],
      attempted: [FEED, "own_pool"],
      skipped: [],
      hasLocationFilter: true,
    });
    expect(counts.find((c) => c.slug === FEED)).toEqual({
      slug: FEED,
      n: 3,
      isOwnPool: false,
      bounded: true,
    });
    expect(counts.find((c) => c.slug === "own_pool")).toMatchObject({
      n: 1,
      isOwnPool: true,
      bounded: false,
    });
    // Rows without provenance are bucketed, not dropped.
    expect(counts.find((c) => c.slug === "(unknown)")).toMatchObject({ n: 1 });
  });

  it("filter_required skip (no location) is tagged too and bounded=false", () => {
    const { counts } = buildSourceCounts({
      rowSources: [],
      attempted: [FEED],
      skipped: [{ slug: FEED, reason: "filter_required" }],
      hasLocationFilter: false,
    });
    expect(counts.find((c) => c.slug === FEED)).toEqual({
      slug: FEED,
      n: 0,
      isOwnPool: false,
      bounded: false,
      skippedReason: "filter_required",
    });
  });
});

describe("buildSourceCounts — regression warnings vs the previous run", () => {
  const FEED = "OnlineVacaturesNL";
  const prevProductive = [
    { slug: FEED, n: 100, isOwnPool: false, bounded: true },
    { slug: "own_pool", n: 6, isOwnPool: true, bounded: false },
  ];

  it("warns when a previously-productive feed returns 0 because it was skipped/errored (the Henk shape)", () => {
    const { warnings } = buildSourceCounts({
      rowSources: ["own_pool", "own_pool"],
      attempted: [FEED, "own_pool"],
      skipped: [{ slug: FEED, reason: "error" }],
      hasLocationFilter: true,
      prevCounts: prevProductive,
    });
    expect(warnings).toEqual([{ slug: FEED, prevN: 100, n: 0, reason: "error" }]);
  });

  it("warns with reason zero_results when the feed genuinely ran to 0 after being productive", () => {
    const { warnings } = buildSourceCounts({
      rowSources: [],
      attempted: [FEED],
      skipped: [],
      hasLocationFilter: true,
      prevCounts: prevProductive,
    });
    expect(warnings).toEqual([{ slug: FEED, prevN: 100, n: 0, reason: "zero_results" }]);
  });

  it("does NOT warn when the feed was already 0 on the previous run", () => {
    const { warnings } = buildSourceCounts({
      rowSources: [],
      attempted: [FEED],
      skipped: [{ slug: FEED, reason: "error" }],
      hasLocationFilter: true,
      prevCounts: [{ slug: FEED, n: 0, isOwnPool: false, bounded: true }],
    });
    expect(warnings).toEqual([]);
  });

  it("does NOT warn without previous counts (first run / legacy sourcesJson)", () => {
    const { warnings } = buildSourceCounts({
      rowSources: [],
      attempted: [FEED],
      skipped: [{ slug: FEED, reason: "error" }],
      hasLocationFilter: true,
      prevCounts: null,
    });
    expect(warnings).toEqual([]);
  });

  it("never warns about own-pool sources and matches slugs case-insensitively", () => {
    const { warnings } = buildSourceCounts({
      rowSources: [],
      attempted: ["onlinevacaturesnl", "own_pool"],
      skipped: [{ slug: "onlinevacaturesnl", reason: "timeout" }],
      hasLocationFilter: true,
      prevCounts: prevProductive, // stored as "OnlineVacaturesNL"
    });
    expect(warnings).toEqual([
      { slug: "onlinevacaturesnl", prevN: 100, n: 0, reason: "timeout" },
    ]);
  });

  it("tolerates malformed previous counts entries", () => {
    const { warnings } = buildSourceCounts({
      rowSources: [],
      attempted: [FEED],
      skipped: [],
      hasLocationFilter: true,
      prevCounts: [
        // Malformed rows a legacy/foreign write could have left behind.
        { slug: 42, n: "x" } as never,
        null as never,
        { slug: FEED, n: 100, isOwnPool: false, bounded: true },
      ],
    });
    expect(warnings).toEqual([{ slug: FEED, prevN: 100, n: 0, reason: "zero_results" }]);
  });
});
