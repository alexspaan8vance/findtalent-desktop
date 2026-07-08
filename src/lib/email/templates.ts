/**
 * Standard email templates (8vance-style).
 *
 * Each org gets a seeded set of professional default templates keyed by
 * purpose. Admins can edit subject/body per template in
 * `/app/settings/email-templates`; delivery (`notify()` + outreach) renders
 * the org's (possibly edited) template, substituting `{{placeholders}}`.
 *
 * Security: template bodies are authored as PLAIN TEXT (no HTML). At render
 * time `renderTemplate` HTML-escapes the entire body *and* every substituted
 * value, then converts the escaped text to safe HTML (newlines -> <br>) and
 * wraps it in a branded shell. So neither the body copy nor a placeholder
 * value can ever inject markup/script into an email — authors edit plain text,
 * recipients receive clean, branded HTML.
 */

import { prisma } from '@/lib/db';
import { getBrandConfig } from '@/lib/brand/config';
import type { Locale } from '@/i18n/config';
import { defaultLocale } from '@/i18n/config';

/**
 * Stable template keys. These are decoupled from `NotificationType` on purpose
 * — some templates (candidate_outreach, team_invite) are not notification
 * types, and not every notification type has an email template.
 */
export const TEMPLATE_KEYS = [
  'candidate_outreach',
  'team_invite',
  'new_match',
  'payment_failed',
  'reveal_confirmation',
  'low_credits',
] as const;

export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export function isTemplateKey(v: string): v is TemplateKey {
  return (TEMPLATE_KEYS as readonly string[]).includes(v);
}

export interface TemplateDefinition {
  name: string;
  subject: string;
  /** Plain-text body authored with `{{placeholder}}` tokens (no HTML). */
  body: string;
}

/** Placeholder names each template understands, for the editor UI hints. */
export const TEMPLATE_PLACEHOLDERS: Record<TemplateKey, readonly string[]> = {
  candidate_outreach: ['brand', 'candidateRef', 'projectTitle', 'recruiterName', 'link'],
  team_invite: ['brand', 'inviterName', 'orgName', 'link'],
  new_match: ['brand', 'projectTitle', 'count', 'link'],
  payment_failed: ['brand', 'amount', 'link'],
  reveal_confirmation: ['brand', 'candidateRef', 'projectTitle', 'link'],
  low_credits: ['brand', 'userName', 'orgName', 'credits', 'link'],
};

/**
 * Resolve which locale to seed default copy in. Driven by `DEPLOY_LOCALE`
 * (e.g. a tenant deployed for an EN audience), else the app default locale.
 */
function seedLocale(): Locale {
  const raw = process.env.DEPLOY_LOCALE?.trim();
  if (raw === 'en' || raw === 'nl') return raw;
  return defaultLocale;
}

const FOOTER: Partial<Record<Locale, string>> = {
  nl: 'Verstuurd door {{brand}}. Beheer je voorkeuren in je instellingen.',
  en: 'Sent by {{brand}}. Manage your preferences in your settings.',
};
/** Footer copy for `locale`, falling back to English for locales without
 * dedicated email copy yet (e.g. de — templates are admin-editable per org). */
function footerFor(locale: Locale): string {
  return FOOTER[locale] ?? FOOTER.en!;
}

/** Localized default copy (PLAIN TEXT) for every template key. Locales without
 * dedicated email defaults (de) fall back to English at read time. */
const DEFAULTS: Partial<Record<Locale, Record<TemplateKey, TemplateDefinition>>> = {
  nl: {
    candidate_outreach: {
      name: 'Kandidaat-benadering',
      subject: 'Een kans bij {{brand}} — {{projectTitle}}',
      body:
        'Hallo,\n\n' +
        'We zoeken iemand zoals jij (referentie {{candidateRef}}) voor de rol {{projectTitle}}.\n\n' +
        'Lijkt dit interessant? Bekijk de details en reageer.\n\n' +
        'Bekijk de rol: {{link}}\n\n' +
        'Met vriendelijke groet,\n{{recruiterName}}',
    },
    team_invite: {
      name: 'Teamuitnodiging',
      subject: '{{inviterName}} nodigt je uit voor {{orgName}} op {{brand}}',
      body:
        'Je bent uitgenodigd.\n\n' +
        '{{inviterName}} heeft je uitgenodigd om lid te worden van {{orgName}} op {{brand}}.\n\n' +
        'Uitnodiging accepteren: {{link}}',
    },
    new_match: {
      name: 'Nieuwe match',
      subject: '{{count}} nieuwe kandida(a)t(en) voor {{projectTitle}}',
      body:
        'Nieuwe kandidaten voor {{projectTitle}}.\n\n' +
        '{{count}} nieuwe kandida(a)t(en) matchen met je opgeslagen zoekopdracht.\n\n' +
        'Bekijk de shortlist: {{link}}',
    },
    payment_failed: {
      name: 'Betaling mislukt',
      subject: 'Actie vereist: je betaling kon niet worden verwerkt',
      body:
        'Betaling mislukt.\n\n' +
        'We konden je recente betaling van {{amount}} niet verwerken.\n\n' +
        'Werk je betaalmethode bij om je account actief te houden.\n\n' +
        'Facturatie beheren: {{link}}',
    },
    reveal_confirmation: {
      name: 'Kandidaat onthuld',
      subject: '{{brand}}: kandidaat onthuld',
      body:
        'Kandidaat onthuld.\n\n' +
        'Je hebt 1 credit gebruikt om kandidaat {{candidateRef}} voor {{projectTitle}} te onthullen. ' +
        'Je hebt nu 14 dagen exclusieve toegang tot de contactgegevens en het cv.\n\n' +
        'Bekijk kandidaat: {{link}}',
    },
    low_credits: {
      name: 'Bijna geen credits',
      subject: 'Je credits bij {{brand}} raken op',
      body:
        'Hallo {{userName}},\n\n' +
        'Je hebt nog {{credits}} credit(s) over bij {{orgName}}. ' +
        'Je hebt credits nodig om kandidaten te onthullen.\n\n' +
        'Top je saldo aan zodat je zonder onderbreking verder kunt.\n\n' +
        'Credits kopen: {{link}}',
    },
  },
  en: {
    candidate_outreach: {
      name: 'Candidate outreach',
      subject: 'An opportunity at {{brand}} — {{projectTitle}}',
      body:
        'Hi,\n\n' +
        'We are looking for someone like you (reference {{candidateRef}}) for the role {{projectTitle}}.\n\n' +
        'Interested? Review the details and respond.\n\n' +
        'View the role: {{link}}\n\n' +
        'Kind regards,\n{{recruiterName}}',
    },
    team_invite: {
      name: 'Team invite',
      subject: '{{inviterName}} invited you to {{orgName}} on {{brand}}',
      body:
        'You have been invited.\n\n' +
        '{{inviterName}} invited you to join {{orgName}} on {{brand}}.\n\n' +
        'Accept invitation: {{link}}',
    },
    new_match: {
      name: 'New match',
      subject: '{{count}} new candidate(s) for {{projectTitle}}',
      body:
        'New candidates for {{projectTitle}}.\n\n' +
        '{{count}} new candidate(s) matched your saved search.\n\n' +
        'View shortlist: {{link}}',
    },
    payment_failed: {
      name: 'Payment failed',
      subject: 'Action needed: your payment could not be processed',
      body:
        'Payment failed.\n\n' +
        'We were unable to process your recent payment of {{amount}}.\n\n' +
        'Please update your payment method to keep your account active.\n\n' +
        'Manage billing: {{link}}',
    },
    reveal_confirmation: {
      name: 'Candidate revealed',
      subject: '{{brand}}: candidate revealed',
      body:
        'Candidate revealed.\n\n' +
        'You used 1 credit to reveal candidate {{candidateRef}} for {{projectTitle}}. ' +
        'You now have 14 days of exclusive access to their contact details and CV.\n\n' +
        'View candidate: {{link}}',
    },
    low_credits: {
      name: 'Low on credits',
      subject: 'You are running low on credits at {{brand}}',
      body:
        'Hi {{userName}},\n\n' +
        'You have {{credits}} credit(s) left at {{orgName}}. ' +
        'You need credits to reveal candidates.\n\n' +
        'Top up your balance so you can keep working without interruption.\n\n' +
        'Buy credits: {{link}}',
    },
  },
};

/** The default template definition for `key` in the active seed locale. */
export function defaultTemplate(key: TemplateKey): TemplateDefinition {
  return (DEFAULTS[seedLocale()] ?? DEFAULTS.en!)[key];
}

/** All default template definitions for the active seed locale (keyed). */
export function allDefaultTemplates(): Record<TemplateKey, TemplateDefinition> {
  return DEFAULTS[seedLocale()] ?? DEFAULTS.en!;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RenderableTemplate {
  subject: string;
  /** Plain-text body authored with `{{placeholder}}` tokens. */
  body: string;
}

export interface RenderedEmail {
  subject: string;
  /** Branded, escaped HTML ready to send. */
  html: string;
  /** Plain-text rendering of the same body (placeholders substituted). */
  text: string;
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Bare `{{link}}` token on its own line -> render as a button. */
const LINK_LINE_RE = /^\s*([^\n]*?)\s*\{\{\s*link\s*\}\}\s*$/;

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

/**
 * Resolve placeholder values once: coerce to string, HTML-escape, and default
 * `brand` from the brand config. Returned map is keyed by placeholder name.
 */
function resolveVars(
  vars: Record<string, string | number | null | undefined>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    resolved[k] = v == null ? '' : escapeHtml(String(v));
  }
  if (resolved.brand == null || resolved.brand === '') {
    resolved.brand = escapeHtml(getBrandConfig().name);
  }
  return resolved;
}

/** Substitute (pre-escaped) values into an already-escaped string. */
function substitute(escapedInput: string, resolved: Record<string, string>): string {
  return escapedInput.replace(PLACEHOLDER_RE, (_m, name: string) =>
    Object.prototype.hasOwnProperty.call(resolved, name) ? resolved[name]! : '',
  );
}

/** Branded HTML shell around the rendered body. `brandHtml` is pre-escaped. */
function shell(brandHtml: string, innerHtml: string, footerHtml: string): string {
  return [
    '<div style="font-family:-apple-system,system-ui,sans-serif;max-width:520px;margin:0 auto;color:#16181d">',
    `<div style="font-size:18px;font-weight:600;margin-bottom:16px;color:#16181d">${brandHtml}</div>`,
    innerHtml,
    `<p style="color:#6b7280;font-size:12px;margin-top:24px">${footerHtml}</p>`,
    '</div>',
  ].join('\n');
}

/** A styled call-to-action button linking to `href` (already trusted URL). */
function button(label: string, href: string): string {
  return `<p style="margin:20px 0"><a href="${href}" style="display:inline-block;background:#1f6f5c;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${label}</a></p>`;
}

/**
 * Convert a PLAIN-TEXT body (with `{{placeholder}}` tokens) into safe HTML:
 * the whole body is HTML-escaped first, then split into paragraphs on blank
 * lines (single newlines -> <br>). A line whose only dynamic content is the
 * `{{link}}` token is rendered as a button when the link resolves to an http(s)
 * URL; otherwise the URL is shown as a plain anchor. All other placeholders are
 * substituted with their pre-escaped values.
 */
function bodyToHtml(body: string, resolved: Record<string, string>): string {
  const linkRaw = resolved.link ?? '';
  const linkIsUrl = linkRaw !== '' && isHttpUrl(linkRaw);

  const paragraphs = body.split(/\n{2,}/);
  const blocks: string[] = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (trimmed === '') continue;

    const linkMatch = trimmed.match(LINK_LINE_RE);
    if (linkMatch && Object.prototype.hasOwnProperty.call(resolved, 'link')) {
      const label = linkMatch[1]!.replace(/:$/, '').trim() || 'Open';
      const escapedLabel = substitute(escapeHtml(label), resolved);
      if (linkIsUrl) {
        // linkRaw is already HTML-escaped (safe for attribute context); the
        // isHttpUrl guard blocks javascript:/data: schemes.
        blocks.push(button(escapedLabel, linkRaw));
        continue;
      }
    }

    const lines = para.split('\n').map((line) => substitute(escapeHtml(line), resolved));
    blocks.push(`<p style="color:#374151;margin:0 0 12px">${lines.join('<br/>')}</p>`);
  }

  return blocks.join('\n');
}

/**
 * Render a plain-text template into a ready-to-send email.
 *
 * `tpl.subject` and `tpl.body` are authored as plain text with
 * `{{placeholder}}` tokens. Every substituted value is HTML-escaped, and the
 * body text itself is HTML-escaped before newline/paragraph conversion, so
 * neither template copy nor a value can inject markup. Unknown/missing
 * placeholders become empty strings. The `brand` placeholder defaults to the
 * configured brand name. Returns `{ subject, html, text }`.
 */
export function renderTemplate(
  tpl: RenderableTemplate,
  vars: Record<string, string | number | null | undefined> = {},
): RenderedEmail {
  const resolved = resolveVars(vars);
  const locale = seedLocale();

  // Raw (unescaped) values, for plain-text contexts (subject header + text part).
  const rawVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) rawVars[k] = v == null ? '' : String(v);
  if (rawVars.brand == null || rawVars.brand === '') rawVars.brand = getBrandConfig().name;
  const subRaw = (input: string): string =>
    input.replace(PLACEHOLDER_RE, (_m, name: string) =>
      Object.prototype.hasOwnProperty.call(rawVars, name) ? rawVars[name]! : '',
    );

  // Subject is an email header (plain text, no HTML context) -> raw values.
  const subject = subRaw(tpl.subject);

  const innerHtml = bodyToHtml(tpl.body, resolved);
  const footerHtml = substitute(escapeHtml(footerFor(locale)), resolved);
  const html = shell(resolved.brand ?? '', innerHtml, footerHtml);

  const text = `${subRaw(tpl.body)}\n\n${subRaw(footerFor(locale))}`;

  return { subject, html, text };
}

/**
 * Lazily seed the org's full template set from defaults (idempotent) and
 * return the (possibly admin-edited) row for `key`.
 *
 * Seeding uses `createMany({ skipDuplicates })` against the
 * `[organizationId, key]` unique constraint, so concurrent callers and repeat
 * calls never duplicate or overwrite admin edits.
 */
export async function getOrgTemplate(
  orgId: string,
  key: TemplateKey,
): Promise<{ key: TemplateKey; subject: string; body: string; name: string }> {
  await seedOrgTemplates(orgId);
  const row = await prisma.emailTemplate.findUnique({
    where: { organizationId_key: { organizationId: orgId, key } },
    select: { key: true, subject: true, body: true, name: true },
  });
  if (row) {
    return { key: row.key as TemplateKey, subject: row.subject, body: row.body, name: row.name };
  }
  // Defensive fallback — should not happen after seeding.
  const def = defaultTemplate(key);
  return { key, subject: def.subject, body: def.body, name: def.name };
}

/**
 * Idempotently insert any missing default templates for the org.
 *
 * SQLite's `createMany` does not support `skipDuplicates`, so we insert only
 * the keys not already present. A lost race throws P2002 on the
 * `[organizationId, key]` unique constraint, which we swallow (the row exists
 * either way). Existing rows (admin edits) are never overwritten.
 */
export async function seedOrgTemplates(orgId: string): Promise<void> {
  const defs = allDefaultTemplates();
  const existing = await prisma.emailTemplate.findMany({
    where: { organizationId: orgId },
    select: { key: true },
  });
  const have = new Set(existing.map((r) => r.key));
  const missing = TEMPLATE_KEYS.filter((k) => !have.has(k));
  if (missing.length === 0) return;

  await Promise.all(
    missing.map((key) =>
      prisma.emailTemplate
        .create({
          data: {
            organizationId: orgId,
            key,
            name: defs[key].name,
            subject: defs[key].subject,
            body: defs[key].body,
          },
        })
        .catch(() => {
          /* unique-constraint race — row already exists, ignore */
        }),
    ),
  );
}

/**
 * Seed (if needed) and return every template row for the org, ordered to match
 * {@link TEMPLATE_KEYS}. Used by the settings page.
 */
export async function listOrgTemplates(orgId: string): Promise<
  Array<{ key: TemplateKey; name: string; subject: string; body: string }>
> {
  await seedOrgTemplates(orgId);
  const rows = await prisma.emailTemplate.findMany({
    where: { organizationId: orgId },
    select: { key: true, name: true, subject: true, body: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return TEMPLATE_KEYS.filter((k) => byKey.has(k)).map((k) => {
    const r = byKey.get(k)!;
    return { key: k, name: r.name, subject: r.subject, body: r.body };
  });
}

/**
 * Resolve + render an org template into a ready-to-send email. Returns
 * `null` if `key` is not a known template key (so callers can fall back).
 */
export async function renderOrgTemplate(
  orgId: string,
  key: string,
  vars: Record<string, string | number | null | undefined>,
): Promise<RenderedEmail | null> {
  if (!isTemplateKey(key)) return null;
  const tpl = await getOrgTemplate(orgId, key);
  return renderTemplate(tpl, vars);
}
