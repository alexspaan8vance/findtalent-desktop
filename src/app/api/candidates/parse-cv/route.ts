import type { NextRequest } from 'next/server';

import { requireApiUser, jsonOk } from '../../refdata/_shared';
import { NextResponse } from 'next/server';
import { parseCv8vance } from '@/lib/candidate/cv-parser-8vance';
import {
  newEnrichToken,
  markEnrichPending,
  setEnrichResult,
} from '@/lib/candidate/cv-enrich-cache';
import { extractCvProfileFromFile, type CvProfile } from '@/lib/candidate/cv-ai';
import { consumeCvRate, cvRateKey } from '@/lib/candidate/cv-ratelimit';
import { trustedClientIp } from '@/lib/client-ip';
import { csrfCheck } from '@/lib/csrf';
import { reportError } from '@/lib/observability/report';

/** Below this many chars the local text extraction is treated as "empty" (scanned PDF). */
const MIN_TEXT_CHARS = 50;

// pdf-parse (v2) and mammoth pull in Node-only deps (pdfjs worker, zlib, etc.);
// keep this handler off the edge runtime.
export const runtime = 'nodejs';

/** Max accepted upload size (~5MB). */
const MAX_BYTES = 5 * 1024 * 1024;
/** Cap on returned text so we don't ship a huge payload back to the client. */
const MAX_CHARS = 50_000;

function isPdf(name: string, type: string): boolean {
  return type === 'application/pdf' || name.endsWith('.pdf');
}
function isDocx(name: string, type: string): boolean {
  return (
    type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.docx')
  );
}
/** Legacy binary Word (.doc, OLE2) — different lib than .docx. */
function isDoc(name: string, type: string): boolean {
  return (
    (type === 'application/msword' || name.endsWith('.doc')) && !name.endsWith('.docx')
  );
}
function isTxt(name: string, type: string): boolean {
  return type === 'text/plain' || name.endsWith('.txt');
}
function isRtf(name: string, type: string): boolean {
  return type === 'application/rtf' || type === 'text/rtf' || name.endsWith('.rtf');
}
/**
 * RTF magic bytes `{\rtf` — detected on the ACTUAL bytes because the extension
 * often lies (seen live: an exported CV named `.docx` was really RTF, so mammoth
 * threw and the upload failed with "Could not read this file"). Magic-byte
 * detection therefore wins over the filename/MIME.
 */
function isRtfBytes(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x7b && // {
    bytes[1] === 0x5c && // \
    bytes[2] === 0x72 && // r
    bytes[3] === 0x74 && // t
    bytes[4] === 0x66 //   f
  );
}
/**
 * Best-effort RTF → plain text for the LOCAL wizard prefill. RTF is ASCII/latin1
 * with `\'xx` hex + `\uN` unicode escapes and control words; we drop meta
 * destination groups (font/color/style tables), convert paragraph breaks, and
 * strip remaining control words. Not a full RTF reader — 8vance's own parser
 * (which accepts RTF on cv-upload) does the authoritative rich parse.
 */
function rtfToText(bytes: Uint8Array): string {
  let s = Buffer.from(bytes).toString('latin1');
  // Drop custom-destination groups ({\*\...}) and common binary/meta tables.
  s = s.replace(/\{\\\*[^{}]*\}/g, ' ');
  s = s.replace(
    /\{\\(?:fonttbl|colortbl|stylesheet|info|pict|object|header|footer|listtable|listoverridetable|generator)[^]*?\}/gi,
    ' ',
  );
  // \uN unicode escapes (optionally followed by a fallback char / space).
  s = s.replace(/\\u(-?\d+)\s?\??/g, (_m, n) => {
    const code = parseInt(n, 10);
    return code > 0 ? String.fromCharCode(code) : '';
  });
  // \'xx hex escapes (latin1 codepoint).
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  // Paragraph / line / tab / section breaks → whitespace.
  s = s.replace(/\\(?:par|line|tab|page|sect)\b/g, '\n');
  // Any remaining control word (\word optionally with a numeric arg + a space).
  s = s.replace(/\\[a-zA-Z]+-?\d* ?/g, '');
  // Escaped literals (\{ \} \\) and stray control symbols, then braces.
  s = s.replace(/\\([{}\\])/g, '$1').replace(/\\[^a-zA-Z]/g, '');
  s = s.replace(/[{}]/g, '');
  return s.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function isImageUpload(name: string, type: string): boolean {
  return /^image\/(png|jpe?g|webp|gif)$/.test(type) || /\.(png|jpe?g|webp|gif)$/.test(name);
}

/**
 * POST /api/candidates/parse-cv?tenantId=...
 * Body: multipart/form-data with a single `file` field (PDF / .docx / .txt).
 *
 * Extracts plain text from an uploaded CV server-side and returns
 * `{ text }` (trimmed, capped). The text feeds the existing extract-skills
 * + contact-extraction flow in the onboarding wizard. Never logs file bytes.
 *
 * Errors: 400 unsupported/missing/oversized, 422 parse_failed.
 */
export async function POST(req: NextRequest) {
  // CSRF: reject a cross-site Origin/Referer before doing any work (F8).
  const csrf = csrfCheck(req);
  if (csrf) return csrf;

  const auth = await requireApiUser(req, { candidates: true });
  if (auth.kind === 'response') return auth.response;

  // Rate-limit per user (this route fans out to paid OpenAI OCR + 8vance parse).
  const rate = await consumeCvRate(cvRateKey({ userId: auth.userId, ip: trustedClientIp(req.headers) }));
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSec) } },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file required' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'empty file' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'file too large' }, { status: 400 });
  }

  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();

  const pdf = isPdf(name, type);
  let docx = isDocx(name, type);
  const doc = isDoc(name, type);
  const txt = isTxt(name, type);
  const img = isImageUpload(name, type);
  let rtf = isRtf(name, type);
  if (!pdf && !docx && !doc && !txt && !img && !rtf) {
    return NextResponse.json({ error: 'unsupported file type' }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const base64 = Buffer.from(bytes).toString('base64');

  // The extension can lie (an RTF exported as `.docx`). Magic bytes win: if the
  // payload is really RTF, route it to the RTF extractor instead of mammoth
  // (which throws on RTF → the "Could not read this file" failure).
  if (isRtfBytes(bytes)) {
    rtf = true;
    docx = false;
  }

  // Two-stage CV parse. Stage 1 (below) is OUR fast local text extraction +
  // optional OCR, returned IMMEDIATELY so the wizard can prefill without waiting.
  // Stage 2 is the slower-but-richer 8vance parser: we mint an enrichToken, run
  // the parser in the BACKGROUND, and stash its mapped result under that token in
  // a short-lived in-process cache. The wizard polls
  // /api/candidates/parse-cv/enrich?token=… and merges the richer data in when it
  // lands. A background 8vance failure NEVER affects the already-sent response —
  // parseCv8vance resolves null on any failure/timeout and we record a 'none'.
  const enrichToken = newEnrichToken();
  markEnrichPending(enrichToken);
  void parseCv8vance(file.name || 'cv', base64)
    .then((parsed) => setEnrichResult(enrichToken, parsed))
    .catch(() => setEnrichResult(enrichToken, null));

  let text = '';
  let extractThrew = false;
  try {
    if (pdf) {
      // pdf-parse v2: class API. Import the package entry (proper ESM/types);
      // the old `pdf-parse/lib/pdf-parse.js` debug-index hack no longer applies.
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: bytes });
      try {
        const res = await parser.getText();
        text = res.text ?? '';
      } finally {
        await parser.destroy();
      }
    } else if (rtf) {
      // RTF (incl. files mislabeled .docx) — mammoth can't read these.
      text = rtfToText(bytes);
    } else if (docx) {
      const mammoth = await import('mammoth');
      // mammoth wants a Node Buffer for the in-memory path.
      const res = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      text = res.value ?? '';
    } else if (doc) {
      // Legacy binary .doc (OLE2) — mammoth can't read these; word-extractor can.
      const mod = await import('word-extractor');
      const WordExtractor = (mod.default ?? mod) as new () => {
        extract(buf: Buffer): Promise<{ getBody(): string }>;
      };
      const extracted = await new WordExtractor().extract(Buffer.from(bytes));
      text = extracted.getBody() ?? '';
    } else if (txt) {
      text = new TextDecoder('utf-8').decode(bytes);
    } else {
      // Image upload: no local text extraction — handled by the OCR path below.
      text = '';
    }
  } catch (err) {
    // pdf-parse/mammoth can choke on some files (odd encodings, scanned PDFs,
    // protected docs). Don't fail yet — fall through to the OCR path which can
    // often still read the file. Never surface parser internals / file bytes.
    text = '';
    extractThrew = true;
    // Report the local-extraction failure (file metadata only, never bytes/PII).
    reportError(err, {
      area: 'candidates.parse-cv',
      fileType: type || 'unknown',
      fileSize: file.size,
    });
  }

  const trimmed = text.trim().slice(0, MAX_CHARS);

  // Scanned / image-only / unreadable PDFs (and parse failures) yield little or
  // no text. When that happens, OCR + parse the raw bytes via OpenAI vision and
  // return the rich profile so the wizard can still prefill. When text is fine,
  // the existing extract-skills(cvText) path runs client-side; profile = null.
  let profile: CvProfile | null = null;
  if (trimmed.length < MIN_TEXT_CHARS && (pdf || img)) {
    profile = await extractCvProfileFromFile(base64, type || 'application/pdf', trimmed).catch(
      () => null,
    );
  }

  // Only now do we give up: nothing extractable locally AND no OCR profile.
  // (docx/txt that threw with no OCR coverage land here.)
  if (trimmed.length < MIN_TEXT_CHARS && !profile && extractThrew) {
    return NextResponse.json({ error: 'parse_failed' }, { status: 422 });
  }

  // Local-first: return the locally-extracted text + OCR profile NOW. The 8vance
  // parser result is no longer awaited here — it arrives via the enrich poll
  // keyed by enrichToken, so `parsed` stays null in this response.
  return jsonOk({ text: trimmed, parsed: null, profile, enrichToken });
}
