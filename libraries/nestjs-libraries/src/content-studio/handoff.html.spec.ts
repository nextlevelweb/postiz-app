import { sanitizePostContent } from '@gitroom/helpers/utils/sanitize.post.content';
import { contentStudioTextToComposerHtml } from '@gitroom/nestjs-libraries/content-studio/handoff.html';

// The real sanitizer can't load in the node project; it is replaced by a
// pass-through here so the escaping and paragraph structure are tested on
// their own. handoff.html.sanitize.spec.ts runs the real one
jest.mock('@gitroom/helpers/utils/sanitize.post.content', () => ({
  sanitizePostContent: jest.fn(),
}));
const sanitize = jest.mocked(sanitizePostContent);

// Only <p> and </p> may be markup; every other < or > must be escaped
const ONLY_PARAGRAPHS = /^(<p>[^<>]*<\/p>)+$/;

describe('contentStudioTextToComposerHtml', () => {
  beforeEach(() => {
    sanitize.mockImplementation((value) => value as string);
  });

  it.each([
    ['empty text', '', '<p></p>'],
    ['one line', 'hello', '<p>hello</p>'],
    ['two lines', 'a\nb', '<p>a</p><p>b</p>'],
    ['a blank line', 'a\n\nb', '<p>a</p><p></p><p>b</p>'],
    ['leading and trailing newlines', '\na\n', '<p></p><p>a</p><p></p>'],
    ['CRLF and CR', 'a\r\nb\rc\r\n', '<p>a</p><p>b</p><p>c</p><p></p>'],
    ['spaces', '  two  spaces  ', '<p>  two  spaces  </p>'],
    [
      'a script tag',
      '<script>alert(1)</script>',
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    ],
    [
      'an img with onerror',
      '<img src=x onerror=alert(1)>',
      '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
    ],
    [
      'a paragraph breakout',
      '</p><p onclick=x>',
      '<p>&lt;/p&gt;&lt;p onclick=x&gt;</p>',
    ],
    ['comparisons', 'a < b && c > d', '<p>a &lt; b &amp;&amp; c &gt; d</p>'],
    ['an ampersand', 'Tom & Jerry', '<p>Tom &amp; Jerry</p>'],
    ['double quotes', 'say "hi"', '<p>say "hi"</p>'],
    ['single quotes', "it's", "<p>it's</p>"],
    ['a literal entity', '&lt;', '<p>&amp;lt;</p>'],
    [
      'an encoded tag',
      '&lt;img onerror=x&gt;',
      '<p>&amp;lt;img onerror=x&amp;gt;</p>',
    ],
    ['a no-break space', 'no\u00a0break', '<p>no&nbsp;break</p>'],
    ['emoji', 'Launch 🎉🔥', '<p>Launch 🎉🔥</p>'],
    ['a ZWJ emoji', '👩‍💻', '<p>👩‍💻</p>'],
    ['right-to-left text', 'שלום עולם', '<p>שלום עולם</p>'],
  ])('converts %s', (_name, text, expected) => {
    expect(contentStudioTextToComposerHtml(text)).toBe(expected);
  });

  it('converts a 10,000 character line', () => {
    const html = contentStudioTextToComposerHtml('a<'.repeat(5000));
    expect(html).toBe(`<p>${'a&lt;'.repeat(5000)}</p>`);
  });

  it.each([
    [''],
    ['plain'],
    ['<script>alert(1)</script>\n<img src=x onerror=alert(1)>'],
    ['</p><p>injected</p><p>'],
    ['x" onclick="alert(1)'],
    ['<svg onload=alert(1)>\n\n<iframe src="javascript:alert(1)">'],
    ['&lt;b&gt;\n&amp;'],
  ])('only ever produces <p> markup for %p', (text) => {
    const html = contentStudioTextToComposerHtml(text);

    expect(html).toMatch(ONLY_PARAGRAPHS);
    expect(html).not.toMatch(/<(?!\/?p>)/);
    // one paragraph per line, typed <p> doesn't add any
    expect(html.match(/<p>/g)).toHaveLength(text.split('\n').length);
  });

  it('runs the result through the post sanitizer exactly once', () => {
    sanitize.mockImplementation(() => '<p>sanitized</p>');

    expect(contentStudioTextToComposerHtml('a <b>\nc')).toBe(
      '<p>sanitized</p>'
    );
    expect(sanitize).toHaveBeenCalledTimes(1);
    expect(sanitize).toHaveBeenCalledWith('<p>a &lt;b&gt;</p><p>c</p>');
  });
});
