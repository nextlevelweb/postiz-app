import { parseFragment, serialize } from 'parse5';
import { sanitizePostContent } from '@gitroom/helpers/utils/sanitize.post.content';

// Runs in the jsdom project: that is the browser build of isomorphic-dompurify
// the Reddit preview uses (its Node build loads ESM-only code Jest can't run)

// Well-formed output parses and serializes back to itself
const expectWellFormed = (html: string) =>
  expect(serialize(parseFragment(html))).toBe(html);

describe('sanitizePostContent', () => {
  it.each([
    ['<p>paragraph</p>'],
    ['<p>line<br>break</p>'],
    ['<p><strong>bold</strong> and <u>underline</u></p>'],
    ['<p><a href="https://example.com/path?a=1">link</a></p>'],
    ['<ul><li><p>one</p></li><li><p>two</p></li></ul>'],
    ['<h1>one</h1><h2>two</h2><h3>three</h3>'],
    [
      '<p><span class="mention" data-mention-id="u1" data-mention-label="Ann">@Ann</span></p>',
    ],
  ])('keeps the editor formatting %s', (html) => {
    expect(sanitizePostContent(html)).toBe(html);
  });

  // ALLOWED_ATTR lists target and rel, but DOMPurify 3.4 drops both; the save
  // path stores the same result, so the preview matches what gets published
  it('drops target and rel like the save path does', () => {
    expect(
      sanitizePostContent(
        '<a href="https://example.com" target="_blank" rel="noopener">a</a>'
      )
    ).toBe('<a href="https://example.com">a</a>');
  });

  it.each([
    ['script', '<p>a<script>alert(1)</script>b</p>', '<p>ab</p>'],
    ['img onerror', '<p>a<img src="x" onerror="alert(1)">b</p>', '<p>ab</p>'],
    [
      'svg onload',
      '<p>a<svg onload="alert(1)"><circle></circle></svg>b</p>',
      '<p>ab</p>',
    ],
    [
      'iframe',
      '<p>a<iframe src="https://example.com"></iframe>b</p>',
      '<p>ab</p>',
    ],
    ['event handler', '<p onclick="alert(1)">a</p>', '<p>a</p>'],
    [
      'style attribute',
      '<p style="background:url(javascript:alert(1))">a</p>',
      '<p>a</p>',
    ],
    ['javascript: href', '<a href="javascript:alert(1)">a</a>', '<a>a</a>'],
    [
      'encoded javascript: href',
      '<a href="jav&#x09;ascript:alert(1)">a</a>',
      '<a>a</a>',
    ],
    [
      'data: href',
      '<a href="data:text/html,<script>alert(1)</script>">a</a>',
      '<a>a</a>',
    ],
  ])('removes %s', (_name, html, expected) => {
    expect(sanitizePostContent(html)).toBe(expected);
  });

  // Reddit's preview cuts the raw editor HTML at 280 characters
  describe('truncated markup', () => {
    it.each([
      ['inside nested elements', '<ul><li><p>one</p></li><li><p><strong>tw'],
      ['unclosed tag', '<p><strong>bold <u>under'],
      ['inside an attribute', '<p>Read <a href="https://example.com/very/lo'],
      ['inside a tag name', '<p>text</p><stro'],
      ['inside a handler', '<p>hi</p><img src=x onerror=alert(1'],
      ['after a javascript: href', '<p><a href="javascript:alert(1)">cl'],
    ])('repairs a cut %s', (_name, html) => {
      const sanitized = sanitizePostContent(html);

      expectWellFormed(sanitized);
      expect(sanitized).not.toMatch(/<(img|script|svg)|onerror|javascript:/i);
      expect(sanitizePostContent(sanitized)).toBe(sanitized);
    });

    it('keeps the formatting before the cut', () => {
      const html =
        `<p>Hello <strong>@team</strong>, see <a href="https://example.com/x">this</a> ${'x'.repeat(
          300
        )}</p>`.slice(0, 280);
      const sanitized = sanitizePostContent(html);

      expect(sanitized).toContain('<strong>@team</strong>');
      expect(sanitized).toContain('<a href="https://example.com/x">this</a>');
      expectWellFormed(sanitized);
    });
  });

  it.each([[undefined], [null], [''], [42]])('returns "" for %p', (value) => {
    expect(sanitizePostContent(value)).toBe('');
  });
});
