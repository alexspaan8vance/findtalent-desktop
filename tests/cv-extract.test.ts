import { describe, it, expect } from "vitest";
import {
  extractSkillCandidates,
  extractContact,
  nameMatchesTerm,
} from "../src/lib/candidate/cv-extract";

describe("cv-extract", () => {
  it("pulls comma/pipe/newline-separated skill phrases", () => {
    const cv = `Skills: Python, JavaScript | React\nNode.js; Docker`;
    const terms = extractSkillCandidates(cv);
    expect(terms).toContain("python");
    expect(terms).toContain("javascript");
    expect(terms).toContain("react");
    expect(terms).toContain("node.js");
    expect(terms).toContain("docker");
  });

  it("drops stopwords and overly long phrases", () => {
    const cv = "experience with the team and various projects over the years";
    const terms = extractSkillCandidates(cv);
    // No pure-stopword phrase survives.
    expect(terms).not.toContain("experience");
    expect(terms).not.toContain("the team and various projects over");
  });

  it("dedupes and respects the limit", () => {
    const cv = Array.from({ length: 100 }, (_, i) => `skill${i}`).join(", ") + ", skill0, skill0";
    const terms = extractSkillCandidates(cv, 10);
    expect(terms.length).toBe(10);
    expect(new Set(terms).size).toBe(terms.length);
  });

  it("returns empty for empty/short input", () => {
    expect(extractSkillCandidates("")).toEqual([]);
    expect(extractSkillCandidates(null as unknown as string)).toEqual([]);
  });

  it("extractContact pulls email + phone from CV text", () => {
    const cv = "Jan Jansen\nEmail: jan.jansen@example.com\nTel: +31 6 12345678\nSkills: Python";
    const c = extractContact(cv);
    expect(c.email).toBe("jan.jansen@example.com");
    expect(c.phone && c.phone.replace(/\D/g, "").length).toBeGreaterThanOrEqual(8);
  });

  it("extractContact returns empty when absent", () => {
    expect(extractContact("just some skills here")).toEqual({});
  });

  it("nameMatchesTerm matches equality + containment, not unrelated", () => {
    expect(nameMatchesTerm("python", "Python")).toBe(true);
    expect(nameMatchesTerm("react", "React.js")).toBe(true);
    expect(nameMatchesTerm("node", "Node.js")).toBe(true);
    expect(nameMatchesTerm("java", "Cobol")).toBe(false);
    expect(nameMatchesTerm("", "Python")).toBe(false);
  });

  it("nameMatchesTerm rejects loose superstrings", () => {
    // The dominant bug class: a short term pulling in an unrelated longer name.
    expect(nameMatchesTerm("SQL", "DB2/SQL")).toBe(false);
    expect(nameMatchesTerm("Java", "JavaScript")).toBe(false);
    expect(nameMatchesTerm("Script", "JavaScript")).toBe(false);
    // No whole-word boundary inside a single token.
    expect(nameMatchesTerm("SQL", "MSSQL")).toBe(false);
    // Term must not be longer/broader than (i.e. contain) the resolved name.
    expect(nameMatchesTerm("Project Management", "Project")).toBe(false);
  });

  it("nameMatchesTerm accepts exact + whole-word + close tech variants", () => {
    // Exact (case-insensitive + diacritics-normalized).
    expect(nameMatchesTerm("python", "Python")).toBe(true);
    expect(nameMatchesTerm("café", "Cafe")).toBe(true);
    // Whole-word token match within a close-length name (term is most of it).
    expect(nameMatchesTerm("machine learning", "Machine Learning (ML)")).toBe(true);
    // Short tech suffix is allowed on a single-token name.
    expect(nameMatchesTerm("React", "React.js")).toBe(true);
    expect(nameMatchesTerm("Node", "Node.js")).toBe(true);
    // But a long multi-skill superstring is still rejected even with a token hit.
    expect(nameMatchesTerm("SQL", "SQL Server Administration & Tuning")).toBe(false);
  });
});
