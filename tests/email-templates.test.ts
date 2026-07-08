/**
 * Unit tests for renderTemplate — plain-text body -> branded HTML.
 *
 * Templates are authored as PLAIN TEXT with `{{placeholder}}` tokens. The
 * renderer escapes the body + every value, converts newlines to <br>/paragraphs,
 * autolinks the `{{link}}` token as a button, and wraps the result in a branded
 * shell. The subject is a plain-text header (raw values, no HTML escaping).
 *
 * Run with `npx vitest run tests/email-templates.test.ts`.
 */

import { describe, it, expect } from 'vitest';

import { renderTemplate } from '../src/lib/email/templates';

describe('renderTemplate', () => {
  it('substitutes placeholders in subject and body', () => {
    const out = renderTemplate(
      { subject: 'Hi {{name}}', body: 'Role: {{projectTitle}}' },
      { name: 'Alex', projectTitle: 'Engineer' },
    );
    expect(out.subject).toBe('Hi Alex');
    expect(out.html).toContain('Role: Engineer');
    expect(out.text).toContain('Role: Engineer');
  });

  it('wraps the body in a branded HTML shell with the brand header', () => {
    const out = renderTemplate({ subject: 's', body: 'Hello there.' }, { brand: 'Acme' });
    // Branded header shows the brand name.
    expect(out.html).toContain('>Acme<');
    // Body becomes a styled paragraph.
    expect(out.html).toContain('<p style="color:#374151');
    expect(out.html).toContain('Hello there.');
    // Footer is present.
    expect(out.html.toLowerCase()).toContain('acme');
  });

  it('escapes HTML in the body text itself (no markup injection from copy)', () => {
    const out = renderTemplate(
      { subject: 's', body: 'A <script>alert(1)</script> & "tags"' },
      {},
    );
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).toContain('&amp;');
    expect(out.html).toContain('&quot;');
  });

  it('escapes HTML in substituted values to prevent injection', () => {
    const out = renderTemplate(
      { subject: 's {{x}}', body: 'Value: {{x}}' },
      { x: '<script>alert(1)</script>&"\'' },
    );
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;');
    expect(out.html).not.toContain('<script>');
    // Subject is a plain-text header — raw value, not escaped.
    expect(out.subject).toBe('s <script>alert(1)</script>&"\'');
  });

  it('converts single newlines to <br/> and blank lines to separate paragraphs', () => {
    const out = renderTemplate(
      { subject: 's', body: 'Line one\nLine two\n\nNew paragraph' },
      {},
    );
    expect(out.html).toContain('Line one<br/>Line two');
    // Two distinct body paragraphs.
    const paras = out.html.match(/<p style="color:#374151/g) ?? [];
    expect(paras.length).toBe(2);
    expect(out.html).toContain('New paragraph');
  });

  it('renders a {{link}} line as a button anchor when the link is an http(s) URL', () => {
    const out = renderTemplate(
      { subject: 's', body: 'Intro text.\n\nView the role: {{link}}' },
      { link: 'https://example.com/role/123' },
    );
    expect(out.html).toContain('<a href="https://example.com/role/123"');
    expect(out.html).toContain('display:inline-block');
    // Label is derived from the line text (without the trailing colon).
    expect(out.html).toContain('>View the role<');
    // The raw token must not leak.
    expect(out.html).not.toContain('{{link}}');
  });

  it('escapes the URL in the anchor href and rejects non-http(s) schemes', () => {
    const out = renderTemplate(
      { subject: 's', body: 'Open: {{link}}' },
      { link: 'javascript:alert(1)' },
    );
    // Not promoted to a button — the dangerous scheme is rendered as escaped text.
    expect(out.html).not.toContain('href="javascript:');
    expect(out.html).toContain('javascript:alert(1)');
  });

  it('coerces numbers to strings', () => {
    const out = renderTemplate({ subject: '{{count}} new', body: 'Count: {{count}}' }, { count: 3 });
    expect(out.subject).toBe('3 new');
    expect(out.html).toContain('Count: 3');
    expect(out.text).toContain('Count: 3');
  });

  it('replaces unknown / missing placeholders with empty string', () => {
    const out = renderTemplate({ subject: 'a{{missing}}b', body: 'x{{nope}}y' }, {});
    expect(out.subject).toBe('ab');
    expect(out.html).toContain('xy');
  });

  it('handles whitespace inside the braces', () => {
    const out = renderTemplate({ subject: '{{ name }}', body: 'Name: {{name}}' }, { name: 'X' });
    expect(out.subject).toBe('X');
    expect(out.html).toContain('Name: X');
  });

  it('defaults the brand placeholder from the brand config', () => {
    const prev = process.env.BRAND_NAME;
    process.env.BRAND_NAME = 'Acme';
    try {
      const out = renderTemplate({ subject: '{{brand}}', body: 'From {{brand}}' }, {});
      expect(out.subject).toBe('Acme');
      expect(out.html).toContain('From Acme');
    } finally {
      if (prev === undefined) delete process.env.BRAND_NAME;
      else process.env.BRAND_NAME = prev;
    }
  });

  it('treats null/undefined values as empty', () => {
    const out = renderTemplate(
      { subject: '[{{a}}][{{b}}]', body: 'x' },
      { a: null, b: undefined },
    );
    expect(out.subject).toBe('[][]');
  });

  it('provides a plain-text alternative with substituted values and no HTML', () => {
    const out = renderTemplate(
      { subject: 's', body: 'Hi {{name}}\n\nView: {{link}}' },
      { name: 'Alex', link: 'https://example.com', brand: 'Acme' },
    );
    expect(out.text).toContain('Hi Alex');
    expect(out.text).toContain('View: https://example.com');
    expect(out.text).not.toContain('<');
  });
});
