/**
 * @jest-environment <rootDir>/jest.unit.jsdom.environment.js
 */
// isomorphic-dompurify only loads in a DOM environment under Jest, so this
// spec switches to the same jsdom environment the frontend specs use

import * as sanitizer from '@gitroom/helpers/utils/sanitize.post.content';
import { contentStudioTextToComposerHtml } from '@gitroom/nestjs-libraries/content-studio/handoff.html';

const render = (html: string) => {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
};

const FIXTURES = [
  '',
  'hello',
  'a\n\nb',
  '\nleading and trailing\n',
  'Tom & "Jerry" it\'s',
  'a < b && c > d',
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)></svg>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '</p><p onclick="alert(1)">breakout',
  'x" onmouseover="alert(1)',
  '&lt;img onerror=x&gt;',
  'no\u00a0break',
  'Launch 🎉 👩‍💻 שלום',
  'tab\there',
];

describe('contentStudioTextToComposerHtml with the real sanitizer', () => {
  it.each(FIXTURES.map((text) => [text]))(
    'keeps %p as paragraphs of text only',
    (text) => {
      const container = render(contentStudioTextToComposerHtml(text));
      const elements = Array.from(container.querySelectorAll('*'));

      expect(elements.map((element) => element.tagName)).toEqual(
        text.split('\n').map(() => 'P')
      );
      expect(elements.every((element) => element.attributes.length === 0)).toBe(
        true
      );
      expect(Array.from(container.children).map((p) => p.textContent)).toEqual(
        text.split('\n')
      );
    }
  );

  it('leaves the serializer output unchanged', () => {
    const spy = jest.spyOn(sanitizer, 'sanitizePostContent');

    for (const text of FIXTURES) {
      const html = contentStudioTextToComposerHtml(text);
      // what went into the sanitizer is what came out
      expect(spy).toHaveBeenLastCalledWith(html);
      expect(sanitizer.sanitizePostContent(html)).toBe(html);
    }
    expect(spy).toHaveBeenCalledTimes(FIXTURES.length * 2);
  });

  it('turns typed markup into visible text, never elements', () => {
    const container = render(
      contentStudioTextToComposerHtml(
        '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n<svg onload=alert(1)>'
      )
    );

    expect(container.querySelector('script, img, svg, iframe')).toBeNull();
    expect(container.textContent).toBe(
      '<script>alert(1)</script><img src=x onerror=alert(1)><svg onload=alert(1)>'
    );
  });

  it('shows a typed entity as the characters typed', () => {
    const container = render(
      contentStudioTextToComposerHtml('&lt;img onerror=x&gt;')
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('&lt;img onerror=x&gt;');
  });

  it('keeps blank lines as empty paragraphs', () => {
    expect(contentStudioTextToComposerHtml('a\n\nb')).toBe(
      '<p>a</p><p></p><p>b</p>'
    );
    expect(contentStudioTextToComposerHtml('')).toBe('<p></p>');
  });
});
