import { describe, it, expect, vi } from "vitest";

// `server-only` is a Next.js build marker with no runtime in vitest — stub it
// so importing service.ts (which is server-only) doesn't throw.
vi.mock("server-only", () => ({}));

import { prioritizeFeedSources } from "@/lib/candidate/service";

describe("prioritizeFeedSources", () => {
  it("moves open-market feeds ahead of own/ecosystem sources so the source cap never drops them", () => {
    // Real Tjellens ordering (9 sources) — OnlineVacaturesNL is the JobDigger feed.
    const tjellens = [
      "c_level_executives",
      "OnlineVacaturesNL",
      "tjellensde",
      "cooll_sustainable_energy_solutions",
      "tjellens_drenthe",
      "tjellens_ecosysteem",
      "vernay_europa",
      "default",
      "suzlon_blade_technology",
    ];
    const out = prioritizeFeedSources(tjellens);
    // The JobDigger feed must land in the first 8 (the MAX_SOURCES cap).
    expect(out.slice(0, 8)).toContain("OnlineVacaturesNL");
    // Feed sorts to the very front here (it's the only feed).
    expect(out[0]).toBe("OnlineVacaturesNL");
  });

  it("keeps the JobDigger feed even in the adversarial case where the API lists it LAST", () => {
    const sources = [
      "a_pool",
      "b_pool",
      "c_pool",
      "d_pool",
      "e_pool",
      "f_pool",
      "g_pool",
      "h_pool",
      "OnlineVacaturesNL", // 9th — would be dropped by an 8-source cap without prioritization
    ];
    const out = prioritizeFeedSources(sources);
    expect(out[0]).toBe("OnlineVacaturesNL");
    expect(out.slice(0, 8)).toContain("OnlineVacaturesNL");
  });

  it("puts ALL external feeds first and preserves relative order within each group", () => {
    const sources = [
      "own_pool",
      "public_vacancies_de",
      "ecosystem_partner",
      "OnlineVacaturesNL",
      "some_company",
    ];
    // isExternalFeedSource matches public_vacancies_* and OnlineVacatures* (not
    // ecosystem/own/company), so feeds come first in original order.
    expect(prioritizeFeedSources(sources)).toEqual([
      "public_vacancies_de",
      "OnlineVacaturesNL",
      "own_pool",
      "ecosystem_partner",
      "some_company",
    ]);
  });

  it("is a no-op ordering when there are no feeds", () => {
    const sources = ["own_pool", "ecosystem_partner", "company_713886"];
    expect(prioritizeFeedSources(sources)).toEqual(sources);
  });
});
