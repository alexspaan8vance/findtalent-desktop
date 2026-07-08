import { describe, it, expect } from 'vitest';

import { htmlToText, isHttpUrl } from '../src/lib/text/html-to-text';

describe('htmlToText', () => {
  it('strips tags and keeps paragraph breaks', () => {
    const out = htmlToText('<p>Eerste alinea.</p><p>Tweede alinea.</p>');
    expect(out).toBe('Eerste alinea.\n\nTweede alinea.');
  });

  it('renders list items as bullets', () => {
    const out = htmlToText('<ul><li>Ervaring met CNC</li><li>Siemens 840D</li></ul>');
    expect(out).toContain('• Ervaring met CNC');
    expect(out).toContain('• Siemens 840D');
    expect(out).not.toMatch(/<\/?li>/);
  });

  it('turns <br> into a newline', () => {
    expect(htmlToText('a<br>b<br/>c')).toBe('a\nb\nc');
  });

  it('decodes named + numeric entities', () => {
    expect(htmlToText('effici&euml;ntie &amp; P&amp;ID&#39;s &nbsp;end')).toBe(
      "efficiëntie & P&ID's end",
    );
    expect(htmlToText('&#x2019;quote&#8217;')).toBe('’quote’');
  });

  it('collapses excessive blank lines and trims', () => {
    expect(htmlToText('<p>a</p><br><br><br><p>b</p>  ')).toBe('a\n\nb');
  });

  it('handles empty / non-string input', () => {
    expect(htmlToText('')).toBe('');
    // @ts-expect-error runtime guard
    expect(htmlToText(null)).toBe('');
  });

  it('leaves already-plain text intact', () => {
    expect(htmlToText('Just plain text.')).toBe('Just plain text.');
  });
});

describe('isHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isHttpUrl('https://example.com/vacature/123')).toBe(true);
    expect(isHttpUrl('http://jobs.local/x')).toBe(true);
  });
  it('rejects javascript:, data:, relative, empty, non-string', () => {
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,x')).toBe(false);
    expect(isHttpUrl('/relative/path')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl(42)).toBe(false);
  });
});
