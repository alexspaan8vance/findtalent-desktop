/**
 * Shortlist export — GET /app/projects/{id}/export?format=csv|print
 *
 * Exports the project's anonymized longlist (Match rows, score desc, max 200).
 *
 * - `format=csv` (default): a downloadable CSV with one row per candidate.
 * - `format=print`: a brand-styled, print-optimised HTML page (cards) so the
 *   browser's "Print to PDF" yields a clean PDF without any PDF dependency.
 *
 * SECURITY: authed via requireUser; only the owning user's project is served
 * (404 otherwise). ANONYMIZED ONLY — never PII. We read straight from the
 * cached `anonymizedPayloadJson` (no reveal/PII tables touched), so even a
 * revealed candidate is exported anonymously here.
 */

import { type NextRequest } from 'next/server';
import { getTranslations } from 'next-intl/server';

import { requireUser } from '@/lib/auth-helpers';
import { prisma } from '@/lib/db';
import { userCanAccessProject } from '@/lib/org';
import { getBrandConfig } from '@/lib/brand/config';
import type { AnonymizedTalent } from '@/lib/anonymize/types';
import { displaySkillName } from '@/lib/anonymize/talent';
import { MATCH_LONGLIST_ORDER_BY } from '@/lib/match/longlist-order';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ROWS = 200;

/** Quote a CSV field per RFC 4180 (wrap in quotes, double internal quotes). */
function csvField(value: unknown): string {
  let s: string;
  if (value === null || value === undefined) s = '';
  else if (typeof value === 'number') s = Number.isFinite(value) ? String(value) : '';
  else s = String(value);
  // Always quote: guards against commas, quotes, newlines and leading
  // characters (=,+,-,@) that spreadsheets interpret as formulas.
  return `"${s.replace(/"/g, '""')}"`;
}

/** Minimal HTML entity escape for the print template. */
function esc(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A safe-for-filename slug derived from the project title. */
function fileSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'shortlist';
}

type Match = {
  opaqueId: string;
  score: number;
  anonymizedPayloadJson: unknown;
};

/** Pull display-ready, anonymized fields out of one match row. */
function rowFields(m: Match, skillUnknownLabel: string) {
  const a = (m.anonymizedPayloadJson ?? {}) as Partial<AnonymizedTalent>;
  const loc = a.location ?? { province: '', country: '' };
  const skills = Array.isArray(a.skills) ? a.skills : [];
  // READ-TIME sanitizer: a stored payload from before the anonymize-side fix
  // (or a preserve-on-fail re-match) can still carry a raw `skill_<id>` name.
  // Funnel each name through displaySkillName so the export never leaks one.
  const topSkills = skills.slice(0, 8).map((s) => {
    const name = displaySkillName(s.name, skillUnknownLabel);
    return s.must_have_match ? `${name} *` : name;
  });
  const education =
    Array.isArray(a.education) && a.education.length > 0
      ? a.education
          .map((e) => e.level)
          .filter((l): l is string => typeof l === 'string' && l.length > 0)
          .join(' / ')
      : '';
  return {
    opaqueId: m.opaqueId,
    score: typeof m.score === 'number' ? Math.round(m.score) : '',
    province: loc.province ?? '',
    country: loc.country ?? '',
    yearsBucket: a.total_years_experience_bucket ?? '',
    availability: a.start_within_days ?? '',
    hours: a.hours_per_week_bucket ?? '',
    topSkills,
    education,
  };
}

async function loadProjectAndMatches(id: string, userId: string) {
  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true, userId: true, organizationId: true, title: true },
  });
  if (!project || !(await userCanAccessProject(userId, project))) return null;

  const matches = await prisma.match.findMany({
    where: { projectId: id },
    // Deterministic order (score desc + id tiebreaker) so the export is stable
    // across reloads and the bounded window is reproducible.
    orderBy: MATCH_LONGLIST_ORDER_BY,
    take: MAX_ROWS,
    select: { opaqueId: true, score: true, anonymizedPayloadJson: true },
  });
  return { project, matches };
}

function buildCsv(matches: Match[], headers: string[], skillUnknownLabel: string): string {
  const lines: string[] = [headers.map(csvField).join(',')];
  for (const m of matches) {
    const f = rowFields(m, skillUnknownLabel);
    lines.push(
      [
        f.opaqueId,
        f.score,
        f.province,
        f.country,
        f.yearsBucket,
        f.availability,
        f.hours,
        f.topSkills.join('; '),
        f.education,
      ]
        .map(csvField)
        .join(','),
    );
  }
  // CRLF line endings + UTF-8 BOM for Excel friendliness.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function buildPrintHtml(opts: {
  brandName: string;
  accent: string;
  title: string;
  generatedLabel: string;
  generatedAt: string;
  countLabel: string;
  count: number;
  matches: Match[];
  labels: {
    score: string;
    location: string;
    years: string;
    availability: string;
    hours: string;
    skills: string;
    education: string;
    mustHaveNote: string;
    anonymousNote: string;
    locale: string;
    skillUnknown: string;
  };
}): string {
  const { labels } = opts;
  const cards = opts.matches
    .map((m) => {
      const f = rowFields(m, labels.skillUnknown);
      const locParts = [f.province, f.country].filter((p) => p && String(p).length > 0);
      const skillChips =
        f.topSkills.length > 0
          ? f.topSkills
              .map((s) => `<span class="chip">${esc(s)}</span>`)
              .join('')
          : '<span class="muted">—</span>';
      return `
      <article class="card">
        <header class="card-head">
          <div class="opaque">${esc(f.opaqueId)}</div>
          <div class="score">${f.score === '' ? '—' : `${esc(f.score)}%`}<span class="score-label">${esc(labels.score)}</span></div>
        </header>
        <dl class="meta">
          <div><dt>${esc(labels.location)}</dt><dd>${locParts.length ? esc(locParts.join(', ')) : '<span class="muted">—</span>'}</dd></div>
          <div><dt>${esc(labels.years)}</dt><dd>${f.yearsBucket ? esc(f.yearsBucket) : '<span class="muted">—</span>'}</dd></div>
          <div><dt>${esc(labels.availability)}</dt><dd>${f.availability ? esc(f.availability) : '<span class="muted">—</span>'}</dd></div>
          <div><dt>${esc(labels.hours)}</dt><dd>${f.hours ? esc(f.hours) : '<span class="muted">—</span>'}</dd></div>
          <div><dt>${esc(labels.education)}</dt><dd>${f.education ? esc(f.education) : '<span class="muted">—</span>'}</dd></div>
        </dl>
        <div class="skills">
          <div class="skills-label">${esc(labels.skills)}</div>
          <div class="chips">${skillChips}</div>
        </div>
      </article>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="${esc(labels.locale)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${esc(opts.brandName)} — ${esc(opts.title)}</title>
<style>
  :root { --accent: ${esc(opts.accent)}; --ink: #16181d; --muted: #5a5f69; --border: #e6e3da; --bg: #f7f6f2; --surface: #ffffff; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); background: var(--bg); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { max-width: 920px; margin: 0 auto; padding: 32px 28px 48px; }
  .doc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; border-bottom: 3px solid var(--accent); padding-bottom: 16px; margin-bottom: 24px; }
  .brand { font-size: 18px; font-weight: 700; color: var(--accent); }
  .doc-title { margin: 4px 0 0; font-size: 26px; font-weight: 700; }
  .doc-sub { margin-top: 6px; font-size: 13px; color: var(--muted); }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
  .card { border: 1px solid var(--border); border-radius: 14px; background: var(--surface); padding: 16px 16px 14px; break-inside: avoid; page-break-inside: avoid; }
  .card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .opaque { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; font-size: 13px; font-weight: 600; color: var(--ink); }
  .score { font-size: 20px; font-weight: 700; color: var(--accent); display: flex; align-items: baseline; gap: 6px; }
  .score-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  dl.meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 14px; margin: 0 0 12px; }
  dl.meta dt { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  dl.meta dd { margin: 1px 0 0; font-size: 13px; }
  .skills-label { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-bottom: 6px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-block; font-size: 12px; padding: 3px 8px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 12%, #ffffff); border: 1px solid color-mix(in srgb, var(--accent) 28%, #ffffff); color: var(--ink); }
  .muted { color: var(--muted); }
  .footnote { margin-top: 22px; font-size: 11px; color: var(--muted); }
  @media print {
    body { background: #ffffff; }
    .page { padding: 0; max-width: none; }
    .no-print { display: none !important; }
    @page { margin: 16mm; }
  }
  @media (max-width: 640px) {
    .grid { grid-template-columns: 1fr; }
  }
  .toolbar { text-align: right; margin-bottom: 12px; }
  .toolbar button { font: inherit; cursor: pointer; border: 1px solid var(--accent); background: var(--accent); color: #fff; padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; }
</style>
</head>
<body>
  <div class="page">
    <div class="toolbar no-print"><button onclick="window.print()">Print / PDF</button></div>
    <div class="doc-head">
      <div>
        <div class="brand">${esc(opts.brandName)}</div>
        <h1 class="doc-title">${esc(opts.title)}</h1>
        <div class="doc-sub">${esc(opts.countLabel)}</div>
      </div>
      <div class="doc-sub" style="text-align:right">${esc(opts.generatedLabel)}<br/>${esc(opts.generatedAt)}</div>
    </div>
    ${opts.count === 0 ? `<p class="muted">—</p>` : `<div class="grid">${cards}</div>`}
    <p class="footnote">${esc(labels.anonymousNote)} · ${esc(labels.mustHaveNote)}</p>
  </div>
</body>
</html>`;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const user = await requireUser();

  const data = await loadProjectAndMatches(id, user.id);
  if (!data) return new Response('Not found', { status: 404 });
  const { project, matches } = data;

  const format = (req.nextUrl.searchParams.get('format') ?? 'csv').toLowerCase();
  const t = await getTranslations('reveals');
  const tShortlist = await getTranslations('shortlist');
  const skillUnknownLabel = tShortlist('skillUnknown');
  const brand = getBrandConfig();

  if (format === 'print') {
    const now = new Date();
    const generatedAt = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'long',
      timeStyle: 'short',
    }).format(now);
    const html = buildPrintHtml({
      brandName: brand.name,
      accent: brand.accentColor,
      title: project.title,
      generatedLabel: t('exportGenerated'),
      generatedAt,
      countLabel: t('exportCount', { count: matches.length }),
      count: matches.length,
      matches,
      labels: {
        score: t('colScore'),
        location: t('exportLocation'),
        years: t('colYears'),
        availability: t('colAvailability'),
        hours: t('exportHours'),
        skills: t('exportSkills'),
        education: t('exportEducation'),
        mustHaveNote: t('exportMustHaveNote'),
        anonymousNote: t('exportAnonymousNote'),
        locale: 'en',
        skillUnknown: skillUnknownLabel,
      },
    });
    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  // Default: CSV.
  const headers = [
    t('csvOpaqueId'),
    t('csvScore'),
    t('csvProvince'),
    t('csvCountry'),
    t('csvYears'),
    t('csvAvailability'),
    t('csvHours'),
    t('csvSkills'),
    t('csvEducation'),
  ];
  const csv = buildCsv(matches, headers, skillUnknownLabel);
  const filename = `${fileSlug(project.title)}-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
