import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  extractCvProfile,
  extractCvProfileFromFile,
  inferSkillLevels,
  languageNames,
} from "../src/lib/candidate/cv-ai";

/**
 * Exercises the regex-fallback path of extractCvProfile (no LLM key set) and
 * the no-key short-circuit of extractCvProfileFromFile. Never hits network:
 * with both keys unset, the module degrades to the deterministic regex
 * extractor (cv-extract.ts) without loading any SDK.
 */

describe("cv-ai — regex fallback (no API keys)", () => {
  let prevAnthropic: string | undefined;
  let prevOpenAI: string | undefined;

  beforeEach(() => {
    prevAnthropic = process.env.ANTHROPIC_API_KEY;
    prevOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropic;
    if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAI;
  });

  it("returns source='regex' and skills-as-hardSkills with empty rich arrays", async () => {
    const cv = [
      "Jan Jansen",
      "Email: jan.jansen@example.com",
      "Tel: +31 6 12345678",
      "Skills: Python, JavaScript, React, Docker",
    ].join("\n");

    const profile = await extractCvProfile(cv);

    expect(profile.source).toBe("regex");
    // regex bucket dumps every candidate into hardSkills…
    expect(profile.hardSkills).toContain("python");
    expect(profile.hardSkills).toContain("react");
    // …and leaves the LLM-only categorized arrays empty.
    expect(profile.softSkills).toEqual([]);
    expect(profile.knowledge).toEqual([]);
    expect(profile.languages).toEqual([]);
    expect(profile.education).toEqual([]);
    expect(profile.employment).toEqual([]);
    expect(profile.certifications).toEqual([]);
    // contact pulled by the regex extractor.
    expect(profile.email).toBe("jan.jansen@example.com");
    expect(profile.phone && profile.phone.replace(/\D/g, "").length).toBeGreaterThanOrEqual(8);
  });

  it("short-circuits to a regex profile for empty/too-short input (no key needed)", async () => {
    const empty = await extractCvProfile("");
    expect(empty.source).toBe("regex");
    expect(empty.hardSkills).toEqual([]);
    expect(empty.email).toBeUndefined();

    // < 10 trimmed chars → short-circuits to the regex path (still source=regex);
    // the raw text is handed to the regex extractor as-is.
    const tiny = await extractCvProfile("   hi   ");
    expect(tiny.source).toBe("regex");
  });

  it("tolerates null/undefined input without throwing", async () => {
    const a = await extractCvProfile(null as unknown as string);
    expect(a.source).toBe("regex");
    expect(a.hardSkills).toEqual([]);
    const b = await extractCvProfile(undefined as unknown as string);
    expect(b.source).toBe("regex");
  });

  it("extractCvProfileFromFile with no OPENAI key falls back to text/regex path", async () => {
    const cv = "Skills: Java, Kotlin, Spring\nEmail: dev@corp.io";
    const profile = await extractCvProfileFromFile("aGVsbG8=", "application/pdf", cv);
    expect(profile.source).toBe("regex");
    expect(profile.hardSkills).toContain("java");
    expect(profile.email).toBe("dev@corp.io");
  });

  it("extractCvProfileFromFile with empty base64 falls back even if filenameText is short", async () => {
    const profile = await extractCvProfileFromFile("", "application/pdf", "");
    expect(profile.source).toBe("regex");
    expect(profile.hardSkills).toEqual([]);
  });
});

describe("cv-ai — languageNames helper", () => {
  it("projects CvLanguage[] to their names, preserving order", () => {
    expect(
      languageNames([
        { name: "Nederlands", level: 5 },
        { name: "Engels", level: 4 },
        { name: "Duits" },
      ]),
    ).toEqual(["Nederlands", "Engels", "Duits"]);
  });

  it("returns [] for an empty list", () => {
    expect(languageNames([])).toEqual([]);
  });
});

describe("cv-ai — inferSkillLevels (conservative proficiency inference)", () => {
  it("returns {} when the CV carries NO seniority / years signal (stays unknown)", () => {
    const cv = "I work with Python and SQL.";
    expect(inferSkillLevels(cv, ["Python", "SQL"])).toEqual({});
  });

  it("raises corroborated skills toward expert on a senior + many-years signal", () => {
    const cv = "Senior Engineer with 10 years of experience in Python and SQL.";
    const levels = inferSkillLevels(cv, ["Python", "SQL"]);
    expect(levels.python).toBe(5);
    expect(levels.sql).toBe(5);
  });

  it("lowers the baseline for a junior signal", () => {
    const cv = "Junior developer, recently started, learning Python.";
    const levels = inferSkillLevels(cv, ["Python"]);
    expect(levels.python).toBe(2);
  });

  it("only assigns a level to skills actually mentioned in the CV body", () => {
    // 'Kubernetes' is requested but never appears in the text → stays unknown,
    // even though the CV has a strong overall seniority signal.
    const cv = "Senior engineer, 8 years building Python services.";
    const levels = inferSkillLevels(cv, ["Python", "Kubernetes"]);
    expect(levels.python).toBe(5);
    expect(levels.kubernetes).toBeUndefined();
  });

  it("scales with years of experience when there is no seniority word", () => {
    const cv = "Worked with Java for 2 years.";
    expect(inferSkillLevels(cv, ["Java"]).java).toBe(3);
  });
});
