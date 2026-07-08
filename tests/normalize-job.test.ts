import { describe, it, expect } from "vitest";
import {
  normalizeJobMatch,
  mergeExtended,
  matchScoreReliable,
} from "../src/lib/candidate/normalize-job";
import type { JobMatchResult, JobExtended } from "../src/lib/eightvance/types";

describe("matchScoreReliable", () => {
  it("own-pool job (employer == tenant company) → reliable regardless of score", () => {
    expect(matchScoreReliable(34231, 34231, 1)).toBe(true);
    expect(matchScoreReliable(34231, 34231)).toBe(true);
  });
  it("cross-company with a REAL score (not the 1 sentinel) → reliable", () => {
    expect(matchScoreReliable(34395, 34231, 19.97)).toBe(true);
    expect(matchScoreReliable(34395, 34231, 0.16)).toBe(true);
    expect(matchScoreReliable(34395, 34231, 0)).toBe(true);
  });
  it("cross-company with the degenerate score:1 → unreliable", () => {
    expect(matchScoreReliable(34395, 34231, 1)).toBe(false);
  });
  it("cross-company with no numeric score → unreliable", () => {
    expect(matchScoreReliable(34395, 34231)).toBe(false);
    expect(matchScoreReliable(null, 34231, null)).toBe(false);
  });
});

describe("normalizeJobMatch", () => {
  it("reads a nested company object into employerCompanyId + employerName", () => {
    const raw: JobMatchResult = {
      job_id: 42,
      score: 0.87,
      title: "Backend engineer",
      company: { id: 100, name: "Acme BV" },
    };
    const n = normalizeJobMatch(raw);
    expect(n.jobId).toBe(42);
    expect(n.score).toBe(0.87);
    expect(n.title).toBe("Backend engineer");
    expect(n.employerCompanyId).toBe(100);
    expect(n.employerName).toBe("Acme BV");
  });

  it("treats a string company as a name with no id", () => {
    const n = normalizeJobMatch({ job_id: 1, company: "Globex" });
    expect(n.employerCompanyId).toBeNull();
    expect(n.employerName).toBe("Globex");
  });

  it("falls back to id when job_id is absent", () => {
    const n = normalizeJobMatch({ id: 7 });
    expect(n.jobId).toBe(7);
  });

  it("returns jobId 0 when neither job_id nor id is present", () => {
    const n = normalizeJobMatch({});
    expect(n.jobId).toBe(0);
  });

  it("prefers employer_name over company_name over nested company name", () => {
    const n = normalizeJobMatch({
      job_id: 1,
      employer_name: "Top Pick",
      company_name: "Second",
      company: { id: 5, name: "Nested" },
    });
    expect(n.employerName).toBe("Top Pick");
    // company id still comes from the nested object.
    expect(n.employerCompanyId).toBe(5);
  });

  it("falls through to company_name then nested name when employer_name missing", () => {
    expect(normalizeJobMatch({ company_name: "Second", company: { name: "Nested" } }).employerName).toBe("Second");
    expect(normalizeJobMatch({ company: { name: "Nested" } }).employerName).toBe("Nested");
  });

  it("reads source as a string", () => {
    expect(normalizeJobMatch({ source: "OnlineVacaturesNL" }).source).toBe("OnlineVacaturesNL");
  });

  it("reads source from a nested object (name, then display_name)", () => {
    expect(normalizeJobMatch({ source: { name: "feed-a" } }).source).toBe("feed-a");
    expect(normalizeJobMatch({ source: { display_name: "Feed B" } }).source).toBe("Feed B");
    expect(normalizeJobMatch({ source: null }).source).toBeNull();
  });

  it("keeps contract_type only when it is a string (ignores int enums)", () => {
    expect(normalizeJobMatch({ contract_type: "Vast" }).contractType).toBe("Vast");
    expect(normalizeJobMatch({ contract_type: 3 }).contractType).toBeNull();
  });

  it("surfaces an explicit boolean is_intermediary, else null", () => {
    expect(normalizeJobMatch({ is_intermediary: true }).isIntermediary).toBe(true);
    expect(normalizeJobMatch({ is_intermediary: false }).isIntermediary).toBe(false);
    expect(normalizeJobMatch({}).isIntermediary).toBeNull();
  });

  it("reads location city + label with location_label fallback", () => {
    const a = normalizeJobMatch({ location: { city: "Utrecht", label: "Utrecht, NL" } });
    expect(a.locationCity).toBe("Utrecht");
    expect(a.locationLabel).toBe("Utrecht, NL");
    const b = normalizeJobMatch({ location_label: "Amsterdam, NL" });
    expect(b.locationCity).toBeNull();
    expect(b.locationLabel).toBe("Amsterdam, NL");
  });

  it("defaults title, score, and the extended-only fields", () => {
    const n = normalizeJobMatch({ job_id: 1 });
    expect(n.title).toBe("Untitled");
    expect(n.score).toBe(0);
    expect(n.description).toBeNull();
    expect(n.remote).toBeNull();
    expect(n.publishedAt).toBeNull();
  });
});

describe("mergeExtended", () => {
  const base = (over: Partial<ReturnType<typeof normalizeJobMatch>> = {}) => ({
    ...normalizeJobMatch({ job_id: 1, title: "Dev", company: { id: 100, name: "Acme" } }),
    ...over,
  });

  it("folds in description and source slug", () => {
    const ext: JobExtended = { description: "Great role", source: "OnlineVacaturesNL" };
    const merged = mergeExtended(base(), ext);
    expect(merged.description).toBe("Great role");
    expect(merged.source).toBe("OnlineVacaturesNL");
  });

  it("keeps existing description/source when extended omits them", () => {
    const n = base({ description: "old", source: "old-src" });
    const merged = mergeExtended(n, {});
    expect(merged.description).toBe("old");
    expect(merged.source).toBe("old-src");
  });

  it("derives isIntermediary when hiring_company_id differs from company.id", () => {
    const ext: JobExtended = { company: { id: 100 }, hiring_company_id: 999 };
    expect(mergeExtended(base(), ext).isIntermediary).toBe(true);
  });

  it("does NOT flag intermediary when hiring_company_id equals company.id", () => {
    const ext: JobExtended = { company: { id: 100 }, hiring_company_id: 100 };
    // base() has isIntermediary null → stays null.
    expect(mergeExtended(base(), ext).isIntermediary).toBeNull();
  });

  it("flags intermediary via display_hiring_company_information + label", () => {
    const ext: JobExtended = {
      company: { id: 100 },
      display_hiring_company_information: true,
      hiring_company_label: "Real Employer NV",
    };
    expect(mergeExtended(base(), ext).isIntermediary).toBe(true);
  });

  it("preserves a prior isIntermediary when no extended signal", () => {
    const merged = mergeExtended(base({ isIntermediary: false }), { company: { id: 100 } });
    expect(merged.isIntermediary).toBe(false);
  });

  it("folds remote from work_remotely", () => {
    expect(mergeExtended(base(), { work_remotely: true } as JobExtended).remote).toBe(true);
    expect(mergeExtended(base(), { work_remotely: false } as JobExtended).remote).toBe(false);
    expect(mergeExtended(base(), {}).remote).toBeNull();
  });

  it("derives publishedAt from time_published, then activated_at", () => {
    expect(
      mergeExtended(base(), { time_published: "2026-01-01T00:00:00Z" } as JobExtended).publishedAt,
    ).toBe("2026-01-01T00:00:00Z");
    expect(
      mergeExtended(base(), { activated_at: "2026-02-02T00:00:00Z" } as JobExtended).publishedAt,
    ).toBe("2026-02-02T00:00:00Z");
  });

  it("updates employerName from extended company and keeps employerCompanyId when already set", () => {
    const ext: JobExtended = { company: { id: 200, name: "Renamed Co" } };
    const merged = mergeExtended(base(), ext);
    expect(merged.employerName).toBe("Renamed Co");
    // employerCompanyId was already 100 → kept (?? short-circuits).
    expect(merged.employerCompanyId).toBe(100);
  });

  it("fills employerCompanyId from extended when the normalized id was null", () => {
    const n = base({ employerCompanyId: null });
    const merged = mergeExtended(n, { company: { id: 321 } });
    expect(merged.employerCompanyId).toBe(321);
  });

  it("fills locationCity from extended (location, then detailed_location)", () => {
    const n = base({ locationCity: null });
    expect(mergeExtended(n, { location: { city: "Eindhoven" } }).locationCity).toBe("Eindhoven");
    expect(
      mergeExtended(n, { detailed_location: { city: "Rotterdam" } }).locationCity,
    ).toBe("Rotterdam");
  });
});
