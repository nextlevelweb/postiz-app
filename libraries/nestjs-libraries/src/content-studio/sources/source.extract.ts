import { ChildNode, Element, parse } from 'parse5';

// The first, deliberately small extractor of Content Studio sources
// (extraction version content-studio-source-v1): it turns a fetched page into
// a title and Source Content v1 blocks. Pure: no network, database or clock.
//
// HTML (and XHTML, read as HTML) is parsed by parse5, the spec-compliant
// parser the project already uses: entities are decoded, nothing is executed
// or loaded, and the result is only ever walked for text. h1-h6, p, li and
// blockquote become blocks; other text becomes paragraphs at block
// boundaries. It is no article extractor: navigation and footers are kept.
// text/plain becomes one paragraph per blank-line separated part.
//
// The body is decoded as UTF-8 only; a page that declares another charset in
// its Content-Type is refused rather than misread. <meta charset> is not read.
// Lengths and counts are not checked here: the Source Content parser refuses
// what is too large, and nothing is cut to fit

export const SOURCE_EXTRACT_MEDIA_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
] as const;

export type ContentStudioSourceMediaType =
  (typeof SOURCE_EXTRACT_MEDIA_TYPES)[number];

export type ContentStudioSourceExtractionErrorCode =
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'UNSUPPORTED_CHARSET';

// Fixed messages: never a byte of the page
export class ContentStudioSourceExtractionError extends Error {
  constructor(readonly code: ContentStudioSourceExtractionErrorCode) {
    super(
      code === 'UNSUPPORTED_CHARSET'
        ? 'The source charset is not supported'
        : 'The source media type is not supported'
    );
    this.name = 'ContentStudioSourceExtractionError';
  }
}

export interface ContentStudioSourceExtraction {
  mediaType: ContentStudioSourceMediaType;
  title: string | null;
  // Source Content v1 as extracted, not yet checked against its limits
  content: {
    schemaVersion: 1;
    blocks: Array<{
      id: string;
      type: 'heading' | 'paragraph' | 'list_item' | 'quote';
      text: string;
      level: number | null;
    }>;
  };
}

// Elements whose text is never page text: code, styling, embedded documents
// and graphics. noscript, iframe, noembed, noframes and xmp hold raw markup as
// text in parse5, so they are skipped too; template content is not in the
// tree at all
const SKIPPED = new Set([
  'head',
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'canvas',
  'iframe',
  'object',
  'embed',
  'noembed',
  'noframes',
  'xmp',
]);

// Elements that flow inside a line: their text joins the text around them.
// Every other element starts and ends a block
const INLINE = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'big',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'ins',
  'kbd',
  'label',
  'mark',
  'nobr',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'time',
  'tt',
  'u',
  'var',
  'wbr',
]);

const HEADING = /^h([1-6])$/;
const LIST_DEPTH_MAX = 8;
// HTML whitespace; a no-break space is text and stays
const HTML_SPACE = /[\t\n\f\r ]+/g;

type BlockType =
  ContentStudioSourceExtraction['content']['blocks'][number]['type'];

// What text found below an element becomes, set by its nearest h1-h6, li,
// blockquote or p
interface Context {
  type: BlockType;
  level: number | null;
  listDepth: number;
  preformatted: boolean;
}

// The media type of an approved Content-Type header, without parameters
export function contentStudioSourceMediaType(
  header: string | undefined | null
): ContentStudioSourceMediaType {
  const mediaType = (header || '').split(';')[0].trim().toLowerCase();
  const known = SOURCE_EXTRACT_MEDIA_TYPES.find((type) => type === mediaType);
  if (!known) {
    throw new ContentStudioSourceExtractionError('UNSUPPORTED_MEDIA_TYPE');
  }
  return known;
}

// UTF-8, the only charset read in this version. Invalid bytes become U+FFFD
// and a byte order mark is dropped, as the Encoding standard decodes them
function decodeBody(header: string | undefined | null, body: Uint8Array) {
  const charset = (header || '')
    .split(';')
    .slice(1)
    .map((parameter) => parameter.trim().split('='))
    .find(([name]) => name.trim().toLowerCase() === 'charset')?.[1];
  const label = (charset || 'utf-8').trim().replace(/^"|"$/g, '').toLowerCase();
  if (label !== 'utf-8' && label !== 'utf8') {
    throw new ContentStudioSourceExtractionError('UNSUPPORTED_CHARSET');
  }
  return new TextDecoder('utf-8').decode(body).replace(/\u0000/g, '�');
}

// Line endings to LF, spaces and tabs collapsed and trimmed per line, at most
// one empty line in a row, outer blank lines dropped
function normalizeText(text: string) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t\f ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const isElement = (node: ChildNode): node is Element => 'tagName' in node;

function extractMarkup(markup: string) {
  const document = parse(markup);
  const blocks: Array<{ type: BlockType; level: number | null; text: string }> =
    [];
  let title: string | null = null;
  let current: { context: Context; text: string } | null = null;

  const flush = () => {
    if (current) {
      const text = normalizeText(current.text);
      if (text) {
        blocks.push({
          type: current.context.type,
          level: current.context.level,
          text,
        });
      }
    }
    current = null;
  };
  const append = (context: Context, text: string) => {
    if (!current || current.context !== context) {
      flush();
      current = { context, text: '' };
    }
    current.text += text;
  };

  const textOf = (nodes: ChildNode[]): string =>
    nodes
      .map((node) =>
        node.nodeName === '#text'
          ? (node as { value: string }).value
          : isElement(node)
          ? textOf(node.childNodes)
          : ''
      )
      .join('');

  const childContext = (element: Element, context: Context): Context => {
    const tag = element.tagName;
    const heading = HEADING.exec(tag);
    if (heading) {
      return { ...context, type: 'heading', level: Number(heading[1]) };
    }
    if (tag === 'ul' || tag === 'ol') {
      return { ...context, listDepth: context.listDepth + 1 };
    }
    if (tag === 'li') {
      return {
        ...context,
        type: 'list_item',
        level: Math.min(Math.max(context.listDepth - 1, 0), LIST_DEPTH_MAX),
      };
    }
    if (tag === 'blockquote') {
      return { ...context, type: 'quote', level: null };
    }
    if (tag === 'pre') {
      return { ...context, preformatted: true };
    }
    // a paragraph inside a quote or list item stays part of it
    if (
      tag === 'p' &&
      context.type !== 'quote' &&
      context.type !== 'list_item'
    ) {
      return { ...context, type: 'paragraph', level: null };
    }
    return { ...context };
  };

  const walk = (nodes: ChildNode[], context: Context) => {
    for (const node of nodes) {
      if (node.nodeName === '#text') {
        const value = (node as { value: string }).value;
        append(
          context,
          context.preformatted ? value : value.replace(HTML_SPACE, ' ')
        );
        continue;
      }
      if (!isElement(node) || SKIPPED.has(node.tagName)) {
        continue;
      }
      if (node.tagName === 'br') {
        append(context, '\n');
        continue;
      }
      if (INLINE.has(node.tagName)) {
        walk(node.childNodes, context);
        continue;
      }
      flush();
      walk(node.childNodes, childContext(node, context));
      flush();
    }
  };

  const find = (nodes: ChildNode[], tag: string): Element | undefined => {
    for (const node of nodes) {
      if (isElement(node)) {
        if (node.tagName === tag) {
          return node;
        }
        if (node.tagName !== 'svg' && node.tagName !== 'math') {
          const found = find(node.childNodes, tag);
          if (found) {
            return found;
          }
        }
      }
    }
    return undefined;
  };

  const titleElement = find(document.childNodes, 'title');
  if (titleElement) {
    title =
      textOf(titleElement.childNodes).replace(HTML_SPACE, ' ').trim() || null;
  }
  const body = find(document.childNodes, 'body');
  walk(body ? body.childNodes : [], {
    type: 'paragraph',
    level: null,
    listDepth: 0,
    preformatted: false,
  });
  flush();
  return { title, blocks };
}

function extractPlainText(text: string) {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[\t\f ]*\n/)
    .map(normalizeText)
    .filter(Boolean)
    .map((paragraph) => ({
      type: 'paragraph' as const,
      level: null,
      text: paragraph,
    }));
}

// Same input, same output: blocks are numbered b1, b2, ... in page order
// after empty ones are dropped, so an unchanged page keeps its block ids
export function extractContentStudioSource(input: {
  contentType: string | undefined | null;
  body: Uint8Array;
}): ContentStudioSourceExtraction {
  const mediaType = contentStudioSourceMediaType(input.contentType);
  const text = decodeBody(input.contentType, input.body);
  const { title, blocks } =
    mediaType === 'text/plain'
      ? { title: null, blocks: extractPlainText(text) }
      : extractMarkup(text);
  return {
    mediaType,
    title,
    content: {
      schemaVersion: 1,
      blocks: blocks.map((block, index) => ({
        id: `b${index + 1}`,
        type: block.type,
        text: block.text,
        level: block.level,
      })),
    },
  };
}
