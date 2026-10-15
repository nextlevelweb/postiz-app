import fs from 'fs';
import path from 'path';
import {
  contentStudioSourceMediaType,
  ContentStudioSourceExtractionError,
  extractContentStudioSource,
  SOURCE_EXTRACT_MEDIA_TYPES,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.extract';
import { parseContentStudioSourceContent } from '@gitroom/nestjs-libraries/content-studio/sources/source.content';

const MARKER = 'SOURCE_FETCH_BODY_SECRET_456';
const bytes = (text: string) => new TextEncoder().encode(text);
const html = (body: string, head = '<title>Page</title>') =>
  extractContentStudioSource({
    contentType: 'text/html; charset=utf-8',
    body: bytes(
      `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
    ),
  });
const plain = (text: string) =>
  extractContentStudioSource({ contentType: 'text/plain', body: bytes(text) });
const blocks = (result: ReturnType<typeof html>) =>
  result.content.blocks.map(({ type, text, level }) => [type, text, level]);
const refused = (
  contentType: string | undefined | null,
  code = 'UNSUPPORTED_MEDIA_TYPE'
) => {
  let error: unknown;
  try {
    extractContentStudioSource({
      contentType,
      body: bytes(`<p>${MARKER}</p>`),
    });
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ContentStudioSourceExtractionError);
  expect((error as ContentStudioSourceExtractionError).code).toBe(code);
  expect(String(error)).not.toContain(MARKER);
};

describe('extractContentStudioSource: HTML', () => {
  it('EX1 reads the document title, decoded and with collapsed whitespace', () => {
    expect(
      html('<p>x</p>', '<title>\n  News &amp; views\t– today  </title>').title
    ).toBe('News & views – today');
    expect(html('<p>x</p>', '').title).toBeNull();
    expect(html('<p>x</p>', '<title>   </title>').title).toBeNull();
    // an svg title is not the document title
    expect(html('<svg><title>Icon</title></svg><p>x</p>', '').title).toBeNull();
  });

  it('EX2-EX6 maps h1-h6, p, li and blockquote to their block types', () => {
    expect(
      blocks(
        html(
          '<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>' +
            '<p>Para</p><ul><li>Item</li><li>Item 2<ul><li>Sub</li></ul></li></ul>' +
            '<ol><li>First</li></ol><blockquote>Quoted</blockquote>' +
            '<blockquote><p>Quoted para</p></blockquote>'
        )
      )
    ).toEqual([
      ['heading', 'One', 1],
      ['heading', 'Two', 2],
      ['heading', 'Three', 3],
      ['heading', 'Four', 4],
      ['heading', 'Five', 5],
      ['heading', 'Six', 6],
      ['paragraph', 'Para', null],
      ['list_item', 'Item', 0],
      ['list_item', 'Item 2', 0],
      ['list_item', 'Sub', 1],
      ['list_item', 'First', 0],
      ['quote', 'Quoted', null],
      ['quote', 'Quoted para', null],
    ]);
  });

  it('caps list nesting at depth 8 and keeps a paragraph inside a list item as the item', () => {
    const nested =
      '<ul>'.repeat(11) +
      '<li>Deep</li>' +
      '</ul>'.repeat(11) +
      '<ul><li><p>In item</p></li></ul>';
    expect(blocks(html(nested))).toEqual([
      ['list_item', 'Deep', 8],
      ['list_item', 'In item', 0],
    ]);
  });

  it('EX7-EX11 ignores script, style, noscript, template, svg, canvas, iframes and embedded objects', () => {
    const result = html(
      `<p>Visible</p><script>var leak = "${MARKER}";</script>` +
        `<style>.x{content:"${MARKER}"}</style>` +
        `<noscript><p>${MARKER}</p></noscript>` +
        `<template><p>${MARKER}</p></template>` +
        `<svg><text>${MARKER}</text></svg>` +
        `<canvas>${MARKER}</canvas>` +
        `<iframe><p>${MARKER}</p></iframe>` +
        `<object>${MARKER}</object><math><mi>${MARKER}</mi></math>` +
        `<xmp><p>${MARKER}</p></xmp><noembed>${MARKER}</noembed>`,
      `<title>T</title><script>${MARKER}</script><style>${MARKER}</style>`
    );
    expect(blocks(result)).toEqual([['paragraph', 'Visible', null]]);
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it('EX12 decodes named and numeric entities', () => {
    expect(
      blocks(
        html(
          '<p>A &amp; B &quot;c&quot; &#39;d&#39; &#x263A; &eacute; &nbsp;x</p>'
        )
      )
    ).toEqual([['paragraph', 'A & B "c" \'d\' ☺ é  x', null]]);
  });

  it('EX13 joins the text of inline elements and keeps line breaks', () => {
    expect(
      blocks(
        html(
          '<p>Some <b>bold</b>, <a href="https://x.example">a link</a> and <em><span>nested</span></em> text.</p>' +
            '<p>Line one<br>Line two</p>'
        )
      )
    ).toEqual([
      ['paragraph', 'Some bold, a link and nested text.', null],
      ['paragraph', 'Line one\nLine two', null],
    ]);
  });

  it('turns loose text into paragraphs at block boundaries, in page order', () => {
    expect(
      blocks(
        html(
          'Intro text<div>Div text <span>more</span></div><section><h2>Head</h2>After head</section>' +
            '<table><tr><td>Cell 1</td><td>Cell 2</td></tr></table>Tail'
        )
      )
    ).toEqual([
      ['paragraph', 'Intro text', null],
      ['paragraph', 'Div text more', null],
      ['heading', 'Head', 2],
      ['paragraph', 'After head', null],
      ['paragraph', 'Cell 1', null],
      ['paragraph', 'Cell 2', null],
      ['paragraph', 'Tail', null],
    ]);
  });

  it('collapses HTML whitespace but keeps the lines of preformatted text', () => {
    expect(
      blocks(
        html(
          '<p>\n  Spread\n   over\tlines  </p><pre>line 1\n  line 2\n\n\n\nline 3</pre>'
        )
      )
    ).toEqual([
      ['paragraph', 'Spread over lines', null],
      ['paragraph', 'line 1\nline 2\n\nline 3', null],
    ]);
  });

  it('EX14/EX15 drops blank blocks and numbers the rest b1..bN', () => {
    const result = html(
      '<p> </p><h1>A</h1><p>\n\t</p><div></div><p>B</p><li> </li><p>C</p>'
    );
    expect(result.content.blocks).toEqual([
      { id: 'b1', type: 'heading', text: 'A', level: 1 },
      { id: 'b2', type: 'paragraph', text: 'B', level: null },
      { id: 'b3', type: 'paragraph', text: 'C', level: null },
    ]);
  });

  it('EX16 gives the same output for the same input', () => {
    const page = '<h1>T</h1><p>One &amp; two</p><ul><li>x</li></ul>';
    expect(html(page)).toEqual(html(page));
    expect(JSON.stringify(html(page))).toBe(JSON.stringify(html(page)));
  });

  it('EX17/EX19 produces text blocks only: no markup, attributes or other block types', () => {
    const result = html(
      '<article class="a"><p style="x" onclick="y()">Text <img src="z.png" alt="Alt"></p>' +
        '<figure><img src="i.png"><figcaption>Caption</figcaption></figure>' +
        '<custom-element>Custom</custom-element><video>Video text</video><code>code()</code></article>'
    );
    expect(blocks(result)).toEqual([
      ['paragraph', 'Text', null],
      ['paragraph', 'Caption', null],
      ['paragraph', 'Custom', null],
      ['paragraph', 'Video text', null],
      ['paragraph', 'code()', null],
    ]);
    for (const block of result.content.blocks) {
      expect(Object.keys(block).sort()).toEqual([
        'id',
        'level',
        'text',
        'type',
      ]);
      expect(['heading', 'paragraph', 'list_item', 'quote']).toContain(
        block.type
      );
    }
    expect(JSON.stringify(result)).not.toMatch(/<[a-z]|onclick|class=|src=/);
    // and Source Content v1 takes it as it is
    expect(parseContentStudioSourceContent(result.content)).toEqual(
      result.content
    );
  });

  it('EX18 keeps encoded markup as inert text', () => {
    const result = html('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(blocks(result)).toEqual([
      ['paragraph', '<script>alert(1)</script>', null],
    ]);
    expect(typeof result.content.blocks[0].text).toBe('string');
  });

  it('EX20 returns the title separately and never as a block or a source name', () => {
    const result = html('<p>Body</p>', '<title>Page title</title>');
    expect(result.title).toBe('Page title');
    expect(blocks(result)).toEqual([['paragraph', 'Body', null]]);
    expect(Object.keys(result).sort()).toEqual([
      'content',
      'mediaType',
      'title',
    ]);
  });

  it('reads application/xhtml+xml with the same HTML parser', () => {
    const result = extractContentStudioSource({
      contentType: 'application/xhtml+xml',
      body: bytes(
        '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>X</title></head><body><h1>Head</h1><p>Body</p></body></html>'
      ),
    });
    expect(result.mediaType).toBe('application/xhtml+xml');
    expect(result.title).toBe('X');
    expect(blocks(result)).toEqual([
      ['heading', 'Head', 1],
      ['paragraph', 'Body', null],
    ]);
  });

  it('decodes UTF-8 only, replaces invalid bytes and NUL, and drops a byte order mark', () => {
    const body = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...bytes('<p>café '),
      0xff,
      0x00,
      ...bytes('</p>'),
    ]);
    const result = extractContentStudioSource({
      contentType: 'text/html',
      body,
    });
    expect(blocks(result)).toEqual([['paragraph', 'café \uFFFD\uFFFD', null]]);
    expect(
      blocks(
        extractContentStudioSource({
          contentType: 'text/plain; charset="UTF-8"',
          body: bytes('a\u0000b'),
        })
      )
    ).toEqual([['paragraph', 'a�b', null]]);
    for (const charset of [
      'iso-8859-1',
      'windows-1252',
      'utf-16',
      'shift_jis',
    ]) {
      refused(`text/html; charset=${charset}`, 'UNSUPPORTED_CHARSET');
    }
  });

  it('leaves size limits to Source Content v1: nothing is cut', () => {
    const long = 'x'.repeat(10_001);
    expect(html(`<p>${long}</p>`).content.blocks[0].text).toHaveLength(10_001);
    const many = '<p>x</p>'.repeat(2001);
    expect(html(many).content.blocks).toHaveLength(2001);
  });
});

describe('extractContentStudioSource: text/plain', () => {
  it('ET1/ET2/ET6 splits on blank lines into paragraphs, without a title', () => {
    const result = plain(
      'First line\nsame paragraph\n\nSecond\n   \n\n\nThird'
    );
    expect(result.title).toBeNull();
    expect(result.mediaType).toBe('text/plain');
    expect(blocks(result)).toEqual([
      ['paragraph', 'First line\nsame paragraph', null],
      ['paragraph', 'Second', null],
      ['paragraph', 'Third', null],
    ]);
  });

  it('ET3 normalizes CRLF and CR', () => {
    expect(blocks(plain('a\r\nb\r\n\r\nc\rd'))).toEqual([
      ['paragraph', 'a\nb', null],
      ['paragraph', 'c\nd', null],
    ]);
  });

  it('ET4 gives no blocks for an empty or blank body', () => {
    expect(plain('').content).toEqual({ schemaVersion: 1, blocks: [] });
    expect(plain(' \n\n \t').content).toEqual({ schemaVersion: 1, blocks: [] });
  });

  it('ET5 numbers paragraphs b1..bN', () => {
    expect(plain('a\n\nb\n\nc').content.blocks.map((b) => b.id)).toEqual([
      'b1',
      'b2',
      'b3',
    ]);
  });

  it('keeps markup in plain text as text', () => {
    expect(blocks(plain('<p>not html</p>'))).toEqual([
      ['paragraph', '<p>not html</p>', null],
    ]);
  });

  it('ET7 leaves a paragraph over its limit to the Source Content parser', () => {
    const result = plain('y'.repeat(10_001));
    expect(result.content.blocks[0].text).toHaveLength(10_001);
    expect(() => parseContentStudioSourceContent(result.content)).toThrow();
  });
});

describe('extractContentStudioSource: content types', () => {
  it('EC1-EC3 supports exactly text/html, application/xhtml+xml and text/plain, without parameters', () => {
    expect(SOURCE_EXTRACT_MEDIA_TYPES).toEqual([
      'text/html',
      'application/xhtml+xml',
      'text/plain',
    ]);
    expect(contentStudioSourceMediaType('Text/HTML; charset=UTF-8')).toBe(
      'text/html'
    );
    expect(contentStudioSourceMediaType(' application/xhtml+xml ')).toBe(
      'application/xhtml+xml'
    );
    expect(contentStudioSourceMediaType('text/plain;format=flowed')).toBe(
      'text/plain'
    );
  });

  it.each([
    ['EC4 application/pdf', 'application/pdf'],
    ['EC5 application/octet-stream', 'application/octet-stream'],
    ['EC6 image/png', 'image/png'],
    ['application/msword', 'application/msword'],
    ['application/json', 'application/json'],
    ['text/csv', 'text/csv'],
    ['EC7 a missing content type', undefined],
    ['an empty content type', ''],
    ['null', null],
    ['a parameter only', '; charset=utf-8'],
  ])('refuses %s, without sniffing the body', (_name, type) => {
    refused(type);
  });
});

describe('source.extract.ts source', () => {
  const text = fs
    .readFileSync(path.join(__dirname, 'source.extract.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('parses with parse5 only: no DOM, scripts, resources, network, clock or logging', () => {
    expect(text.match(/^import .* from '([^']+)';$/gm)).toEqual([
      "import { ChildNode, Element, parse } from 'parse5';",
    ]);
    expect(text).not.toMatch(
      /jsdom|JSDOM|runScripts|resources|DOMParser|innerHTML|eval\(|new Function|fetch\(|safeFetch|Date|Math\.random|randomUUID|console\.|Logger|process\.env/
    );
  });
});
