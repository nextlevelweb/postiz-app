import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import { textSlicer } from '@gitroom/helpers/utils/count.length';
import { previewHtml } from '@gitroom/frontend/components/launches/helpers/preview.content';

// The same steps every composer preview runs before rendering
const MENTION_SPAN =
  /<span.*?data-mention-id="([.\s\S]*?)"[.\s\S]*?>([.\s\S]*?)<\/span>/gi;
const plainText = (content: string) =>
  stripHtmlValidation(
    'normal',
    content.replace(MENTION_SPAN, (match, id, name) => `[[[${name}]]]`),
    true
  );

// The builder the previews used before this fix, kept to prove harmless
// content renders exactly as it did
const legacyHtml = (newContent: string, start: number, end: number) =>
  newContent
    .slice(start, end)
    .replace(/\[\[\[([.\s\S]*?)]]]/, (match, match1) => {
      return `<span class="font-bold font-[arial]" style="color: #ae8afc">${match1}</span>`;
    }) +
  `<mark class="bg-red-500" data-tooltip-id="tooltip" data-tooltip-content="This text will be cropped">` +
  newContent.slice(end).replace(/\[\[\[([.\s\S]*?)]]]/, (match, match1) => {
    return `<span class="font-bold font-[arial]" style="color: #ae8afc">${match1}</span>`;
  }) +
  `</mark>`;

const toElement = (html: string) => {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
};

const render = (content: string, max = 10000, identifier = 'linkedin') => {
  const text = plainText(content);
  const { start, end } = textSlicer(identifier, max, text);
  return {
    text,
    start,
    end,
    html: previewHtml(text, start, end),
    element: toElement(previewHtml(text, start, end)),
    legacy: toElement(legacyHtml(text, start, end)),
  };
};

const mention = (name: string) =>
  `<span data-type="mention" data-mention-id="u1" data-mention-label="u1">${name}</span>`;

// Only the hard-coded preview markup may exist, and nothing can carry a handler
const expectOnlyTrustedMarkup = (element: HTMLElement) => {
  for (const node of Array.from(element.querySelectorAll('*'))) {
    expect(['SPAN', 'MARK']).toContain(node.tagName);
    for (const { name } of Array.from(node.attributes)) {
      expect([
        'class',
        'style',
        'data-tooltip-id',
        'data-tooltip-content',
      ]).toContain(name);
    }
  }
};

describe('previewHtml', () => {
  describe('typed or pasted markup stays text', () => {
    it.each([
      [
        'typed script',
        '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
        '<script>alert(1)</script>',
      ],
      [
        'pasted script',
        '<p><script>alert(1)</script>after</p>',
        'alert(1)after',
      ],
      [
        'typed img onerror',
        '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
        '<img src=x onerror=alert(1)>',
      ],
      [
        'double-encoded img onerror',
        '<p>&amp;lt;img src=x onerror=alert(1)&amp;gt;</p>',
        '<img src=x onerror=alert(1)>',
      ],
      [
        'bold img onerror',
        '<p><strong>&lt;img src=x onerror=alert(1)&gt;</strong></p>',
        null,
      ],
      [
        'typed svg onload',
        '<p>&lt;svg onload=alert(1)&gt;&lt;/svg&gt;</p>',
        '<svg onload=alert(1)></svg>',
      ],
      [
        'iframe',
        '<p>&lt;iframe src="javascript:alert(1)"&gt;&lt;/iframe&gt;</p>',
        '<iframe src="javascript:alert(1)"></iframe>',
      ],
    ])('%s', (_name, content, visible) => {
      const { element, legacy } = render(content);

      expectOnlyTrustedMarkup(element);
      expect(element.querySelector('script, img, svg, iframe')).toBeNull();
      if (visible !== null) {
        expect(element.textContent).toBe(visible);
      }
      // what the unescaped builder used to inject, for the typed payloads
      if (/img|svg|iframe/.test(_name) && _name !== 'bold img onerror') {
        expect(legacy.querySelector('img, svg, iframe')).not.toBeNull();
      }
    });
  });

  describe('mention names', () => {
    it.each([
      ['&lt;img src=x onerror=alert(1)&gt;', '<img src=x onerror=alert(1)>'],
      [
        '"&gt;&lt;/span&gt;&lt;img src=x onerror=alert(1)&gt;',
        '"></span><img src=x onerror=alert(1)>',
      ],
      ['O\'Brien &amp; "Co"', 'O\'Brien & "Co"'],
    ])('keeps %p as the visible name only', (name, visible) => {
      const { element } = render(`<p>Hi ${mention(name)}!</p>`);
      const spans = element.querySelectorAll('span');

      expectOnlyTrustedMarkup(element);
      expect(spans).toHaveLength(1);
      expect(spans[0].textContent).toBe(visible);
      expect(element.textContent).toBe(`Hi ${visible}!`);
    });
  });

  describe('harmless content renders as before', () => {
    it.each([
      ['bold and underline', '<p><strong>Bold</strong> and <u>under</u></p>'],
      ['list', '<p>Intro</p><ul><li><p>one</p></li><li><p>two</p></li></ul>'],
      ['link', '<p>Visit <a href="https://example.com/a?b=c">site</a></p>'],
      ['emoji', '<p>Launch 🎉🔥 day</p>'],
      ['newlines', '<p>line one</p><p>line two</p><p></p><p>line four</p>'],
      ['mention', `<p>Hello ${mention('John Doe')} again</p>`],
      ['comparison', '<p>a &lt; b and 5 &gt; 3</p>'],
      ['heart', '<p>I &lt;3 you</p>'],
      ['ampersand', '<p>Tom &amp; Jerry</p>'],
      ['quotes', `<p>"double" and 'single'</p>`],
    ])('%s', (_name, content) => {
      const { element, legacy, text } = render(content);

      expect(element.textContent).toBe(legacy.textContent);
      expect(element.textContent).toBe(text.replace(/\[\[\[|]]]/g, ''));
      expect(element.querySelectorAll('span')).toHaveLength(
        legacy.querySelectorAll('span').length
      );
    });

    it.each([
      ['<p><strong>Bold</strong> and <u>under</u></p>'],
      ['<p>Launch 🎉🔥 day</p><p>second line</p>'],
      [`<p>Hello ${mention('John Doe')} again</p>`],
    ])(
      'produces the identical HTML when nothing needs escaping: %s',
      (content) => {
        const { text, start, end, html } = render(content);
        expect(html).toBe(legacyHtml(text, start, end));
      }
    );
  });

  describe('crop highlight', () => {
    it('marks the text past the limit', () => {
      const { element } = render('<p>Hello world, this is long</p>', 10);
      const mark = element.querySelector('mark')!;

      expect(element.firstChild!.textContent).toBe('Hello worl');
      expect(mark.textContent).toBe('d, this is long');
      expect(mark.className).toBe('bg-red-500');
      expect(mark.getAttribute('data-tooltip-id')).toBe('tooltip');
      expect(mark.getAttribute('data-tooltip-content')).toBe(
        'This text will be cropped'
      );
    });

    it('keeps an empty mark when nothing is cropped', () => {
      const { element } = render('<p>short</p>');
      expect(element.textContent).toBe('short');
      expect(element.querySelector('mark')!.textContent).toBe('');
    });

    it('uses the X weighted counter offsets unchanged', () => {
      const content = `<p>${'word '.repeat(80)}&lt;b&gt;end</p>`;
      const { element, legacy, end, text } = render(content, 280, 'x');

      expect(end).toBeLessThan(text.length);
      expect(element.querySelector('mark')!.textContent).toBe(text.slice(end));
      expect(element.textContent).toBe(text);
      // the old builder turned the cropped <b> into an element
      expect(legacy.querySelector('b')).not.toBeNull();
    });

    it('highlights a mention on either side of the crop', () => {
      const content = `<p>${mention('Ann')} ${'x'.repeat(20)} ${mention(
        'Bob'
      )}</p>`;
      const { element, legacy } = render(content, 10);
      const outside = element.querySelector(':scope > span')!;
      const inside = element.querySelector('mark > span')!;

      expect(outside.textContent).toBe('Ann');
      expect(inside.textContent).toBe('Bob');
      expect(element.innerHTML).toBe(legacy.innerHTML);
    });

    it('matches the old output when the crop splits a mention', () => {
      const content = `<p>ab ${mention('Johnny')} cd</p>`;
      const { element, legacy } = render(content, 7);

      expect(element.innerHTML).toBe(legacy.innerHTML);
    });

    it('escapes a payload split by the crop', () => {
      const content = '<p>12345&lt;img src=x onerror=alert(1)&gt;</p>';
      const { element } = render(content, 8);

      expectOnlyTrustedMarkup(element);
      expect(element.textContent).toBe('12345<img src=x onerror=alert(1)>');
    });
  });
});
