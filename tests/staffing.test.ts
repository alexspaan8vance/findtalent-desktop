import { describe, it, expect } from "vitest";
import {
  classifyJob,
  resolveRules,
  DEFAULT_AGENCY_NAME_PATTERNS,
  DEFAULT_AGENCY_DESCRIPTION_PATTERNS,
} from "../src/lib/match/staffing";

describe("staffing-agency classifier", () => {
  it("flags a known agency by employer name", () => {
    const v = classifyJob({ employerName: "Randstad Nederland B.V." });
    expect(v.isAgency).toBe(true);
    expect(v.reasons.some((r) => r.signal === "employer_name")).toBe(true);
  });

  it("flags via the is_intermediary flag alone", () => {
    const v = classifyJob({ employerName: "Acme Direct", isIntermediary: true });
    expect(v.isAgency).toBe(true);
    expect(v.reasons[0].signal).toBe("is_intermediary");
  });

  it("flags the 'voor onze opdrachtgever' description tell", () => {
    const v = classifyJob({
      employerName: "Onbekend",
      description: "Voor onze opdrachtgever in Amsterdam zoeken wij een monteur.",
    });
    expect(v.isAgency).toBe(true);
    expect(v.reasons.some((r) => r.signal === "description")).toBe(true);
  });

  it("flags the English 'on behalf of our client' tell", () => {
    const v = classifyJob({
      description: "On behalf of our client we are hiring a developer.",
    });
    expect(v.isAgency).toBe(true);
  });

  it("flags an uitzend contract type", () => {
    const v = classifyJob({ employerName: "Direct BV", contractType: "Uitzendkracht" });
    expect(v.isAgency).toBe(true);
    expect(v.reasons.some((r) => r.signal === "contract_type")).toBe(true);
  });

  it("does NOT flag a normal direct employer", () => {
    const v = classifyJob({
      employerName: "Gemeente Utrecht",
      description: "Wij zoeken een beleidsmedewerker voor onze afdeling.",
      contractType: "Vast",
      isIntermediary: false,
    });
    expect(v.isAgency).toBe(false);
    expect(v.reasons).toHaveLength(0);
    expect(v.score).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(classifyJob({ employerName: "TEMPO-TEAM" }).isAgency).toBe(true);
    expect(classifyJob({ employerName: "tempo-team" }).isAgency).toBe(true);
  });

  it("respects a stricter threshold (needs 2 distinct signals)", () => {
    // Only one signal (name) → not enough at threshold 2.
    const one = classifyJob({ employerName: "Randstad" }, { threshold: 2 });
    expect(one.isAgency).toBe(false);
    // Two signals (name + description) → flagged.
    const two = classifyJob(
      { employerName: "Randstad", description: "voor onze opdrachtgever" },
      { threshold: 2 },
    );
    expect(two.isAgency).toBe(true);
  });

  it("merges admin rules with the built-in defaults", () => {
    const v = classifyJob(
      { employerName: "Flexkonijn XYZ" },
      { rules: [{ kind: "name", pattern: "flexkonijn" }] },
    );
    expect(v.isAgency).toBe(true);
    expect(v.reasons[0].matched).toBe("flexkonijn");
  });

  it("ignores disabled admin rules", () => {
    const { names } = resolveRules([
      { kind: "name", pattern: "nope-co", enabled: false },
    ]);
    expect(names).not.toContain("nope-co");
  });

  it("score is normalized to /4 distinct signals", () => {
    const v = classifyJob({
      employerName: "Randstad",
      description: "voor onze opdrachtgever",
      contractType: "uitzend",
      isIntermediary: true,
    });
    expect(v.score).toBe(1); // all 4 signals
    expect(new Set(v.reasons.map((r) => r.signal)).size).toBe(4);
  });

  it("does NOT false-positive on short brand tokens embedded mid-word", () => {
    // "yer" is a brand token but must not match inside "Bayer".
    expect(classifyJob({ employerName: "Bayer AG" }).isAgency).toBe(false);
    // "actief" must not match inside "Tractief".
    expect(classifyJob({ employerName: "Tractief Onderhoud BV" }).isAgency).toBe(false);
  });

  it("still matches an agency stem as a word prefix (Dutch compounds)", () => {
    // "uitzend" is a prefix of "uitzendorganisatie" → should still flag.
    expect(classifyJob({ employerName: "Uitzendorganisatie Noord" }).isAgency).toBe(true);
  });

  it("does NOT flag a plain interim contract type (common for direct employers)", () => {
    expect(classifyJob({ employerName: "ASML", contractType: "Interim" }).isAgency).toBe(false);
  });

  it("exposes non-empty built-in default lists", () => {
    expect(DEFAULT_AGENCY_NAME_PATTERNS.length).toBeGreaterThan(10);
    expect(DEFAULT_AGENCY_DESCRIPTION_PATTERNS).toContain("voor onze opdrachtgever");
  });
});
