/**
 * 8vance CV parser integration (primary CV → structured profile).
 *
 * Flow (reverse-engineered from the production n8n workflow + the ws-bridge):
 *   1. POST {id, filename, base64_data} to
 *      https://cv-parsing-api.8vance.com/events/incoming_events  (Bearer token)
 *   2. The parse result is delivered over a WebSocket:
 *      wss://cv-parsing-api.8vance.com/events/ws/{id}  (no extra auth — the id
 *      is the capability). 8vance pushes `{status:'completed', data:{person,
 *      profile}}` (a rich HR-XML-like profile: qualifications=skills, languages,
 *      education, employment, certifications, contact).
 *
 * The n8n flow needed a separate "bridge" only because n8n can't hold a WS open;
 * findtalent IS a Node server, so it does both the POST and the WS itself — no
 * bridge / public callback needed. Bounded by a timeout; on ANY failure returns
 * null so the caller falls back to the LLM extractor.
 *
 * Server-only. Requires EIGHTVANCE_CV_PARSER_TOKEN (the "8vance Parser" Bearer).
 */
import "server-only";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const INCOMING_URL = "https://cv-parsing-api.8vance.com/events/incoming_events";
const WS_BASE = "wss://cv-parsing-api.8vance.com/events/ws";
// Kept short on purpose: the 8vance parser is async + flaky + not always
// network-reachable. It runs in PARALLEL with local text extraction, and the
// LLM/regex backup covers the rest, so we cap the wait to keep onboarding snappy
// rather than block the upload on a slow/hung parse. Override via env if needed.
const DEFAULT_TIMEOUT_MS = Number(process.env.CV_PARSER_TIMEOUT_MS ?? 25_000);

/** A single education entry mapped from the 8vance profile (best-effort). */
export interface EightvanceEducation {
  institution?: string;
  degree?: string;
  field?: string;
  startYear?: string;
  endYear?: string;
}
/** A single employment entry mapped from the 8vance profile (best-effort). */
export interface EightvanceEmployment {
  title?: string;
  company?: string;
  startYear?: string;
  endYear?: string;
  description?: string;
}

export interface EightvanceParsedCv {
  fullName?: string;
  email?: string;
  phone?: string;
  about?: string;
  /** Flat skill names (8vance doesn't categorise hard/soft). */
  skills: string[];
  /** Language names. */
  languages: string[];
  /** Education history, when the 8vance payload carries it. Defaults to []. */
  education: EightvanceEducation[];
  /** Employment / work history, when present. Defaults to []. */
  employment: EightvanceEmployment[];
  /** Whether the parser actually returned data (vs a soft failure). */
  ok: boolean;
}

interface RawPerson {
  name?: { given?: string; family?: string; formattedName?: string };
  communication?: { email?: string; phone?: string };
}
// VERIFIED against a real 8vance parser webhook payload (2026-07-01):
//   education[]  = { title, program, educationalDegree,
//                    institution: [{ name, address }],
//                    attendancePeriod: { start, end, current } }
//   employment[] = { title, description, start, end, current,
//                    organization: { name, address } }
//   qualifications[] = { skills }   languages[] = { language, proficiency }
//   additional_information = the "about" summary.
// Flat aliases (institution/company as strings, start_date, etc.) are kept as
// fallbacks in case the shape varies across deploys.
interface RawOrg {
  name?: string;
}
interface RawEducation {
  title?: string;
  program?: string;
  educationalDegree?: string;
  institution?: string | RawOrg[];
  attendancePeriod?: { start?: string; end?: string };
  // flat fallbacks
  school?: string;
  degree?: string;
  field?: string;
  field_of_study?: string;
  start?: string;
  end?: string;
  start_date?: string;
  end_date?: string;
}
interface RawEmployment {
  title?: string;
  function?: string;
  position?: string;
  organization?: string | RawOrg;
  company?: string;
  employer?: string;
  start?: string;
  end?: string;
  start_date?: string;
  end_date?: string;
  description?: string;
}
interface RawProfile {
  qualifications?: Array<{ skills?: string }>;
  languages?: Array<{ language?: string }>;
  additional_information?: string;
  education?: RawEducation[];
  employment?: RawEmployment[];
  work_experience?: RawEmployment[];
}
interface RawMessage {
  status?: string;
  data?: { person?: RawPerson; profile?: RawProfile };
}

function mapProfile(msg: RawMessage): EightvanceParsedCv {
  const p = msg.data?.person ?? {};
  const prof = msg.data?.profile ?? {};
  const skills = Array.from(
    new Set(
      (prof.qualifications ?? [])
        .map((q) => (q.skills ?? "").trim())
        .filter((s) => s.length > 0),
    ),
  );
  const languages = Array.from(
    new Set(
      (prof.languages ?? [])
        .map((l) => (l.language ?? "").trim())
        .filter((s) => s.length > 0),
    ),
  );
  const fullName =
    p.name?.formattedName ||
    [p.name?.given, p.name?.family].filter(Boolean).join(" ") ||
    undefined;
  const clean = (s?: string): string | undefined => {
    const v = (s ?? "").trim();
    return v.length > 0 ? v : undefined;
  };
  // institution is an ARRAY of {name} in the real payload; fall back to a flat
  // string alias. organization is an OBJECT {name}; same flat fallback.
  const instName = (v: RawEducation["institution"]): string | undefined =>
    Array.isArray(v) ? clean(v[0]?.name) : clean(v as string | undefined);
  const orgName = (v: RawEmployment["organization"]): string | undefined =>
    typeof v === "object" && v !== null ? clean((v as RawOrg).name) : clean(v as string | undefined);
  const education: EightvanceEducation[] = (prof.education ?? [])
    .map((e) => ({
      institution: instName(e.institution) ?? clean(e.school),
      // real: educationalDegree; also accept the "title" line + flat degree.
      degree: clean(e.educationalDegree ?? e.degree ?? e.title),
      field: clean(e.program ?? e.field ?? e.field_of_study),
      startYear: clean(e.attendancePeriod?.start ?? e.start ?? e.start_date),
      endYear: clean(e.attendancePeriod?.end ?? e.end ?? e.end_date),
    }))
    .filter((e) => e.institution || e.degree || e.field);
  const employment: EightvanceEmployment[] = (prof.employment ?? prof.work_experience ?? [])
    .map((e) => ({
      title: clean(e.title ?? e.function ?? e.position),
      company: orgName(e.organization) ?? clean(e.company ?? e.employer),
      startYear: clean(e.start ?? e.start_date),
      endYear: clean(e.end ?? e.end_date),
      description: clean(e.description),
    }))
    // real payload uses "UNK" for an undetermined title — treat as empty so an
    // UNK-only row without a company doesn't create a junk entry.
    .map((e) => ({ ...e, title: e.title === "UNK" ? undefined : e.title }))
    .filter((e) => e.title || e.company || e.description);
  return {
    fullName,
    email: p.communication?.email || undefined,
    phone: p.communication?.phone || undefined,
    about: prof.additional_information || undefined,
    skills,
    languages,
    education,
    employment,
    ok:
      skills.length > 0 ||
      languages.length > 0 ||
      !!fullName ||
      education.length > 0 ||
      employment.length > 0,
  };
}

/**
 * Parse a CV file (base64) via the 8vance parser. Returns the structured
 * profile, or null on timeout / failure / when the token isn't configured.
 */
export async function parseCv8vance(
  filename: string,
  base64: string,
  opts: { timeoutMs?: number } = {},
): Promise<EightvanceParsedCv | null> {
  const token = process.env.EIGHTVANCE_CV_PARSER_TOKEN;
  if (!token) return null;

  const id = randomUUID();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Open the WS FIRST (so we don't miss a fast result), then submit the file.
  return new Promise<EightvanceParsedCv | null>((resolve) => {
    let settled = false;
    const ws = new WebSocket(`${WS_BASE}/${id}`);
    const done = (v: EightvanceParsedCv | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);

    ws.on("open", async () => {
      try {
        const res = await fetch(INCOMING_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ id, filename, base64_data: base64 }),
        });
        if (!res.ok) done(null);
      } catch {
        done(null);
      }
    });

    ws.on("message", (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as RawMessage;
        const status = String(msg.status ?? "").toLowerCase();
        if (status === "completed" || msg.data) {
          done(mapProfile(msg));
        } else if (status === "failed" || status === "error") {
          done(null);
        }
        // else: progress/intermediate — keep waiting.
      } catch {
        // ignore malformed frame
      }
    });

    ws.on("error", () => done(null));
    ws.on("close", () => done(null));
  });
}
