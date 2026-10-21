import { ChildNode, Element, parse } from 'parse5';

// The extractor of Content Studio sources (extraction version
// content-studio-source-v2): it turns fetched bytes into a title and Source
// Content v1 blocks. Pure and deterministic: no network, database, clock or
// randomness, and the given bytes are only read.
//
// HTML (and XHTML, read with the same HTML parsing rules) is parsed by parse5,
// the spec-compliant parser the project already uses: entities are decoded,
// nothing is executed or loaded, and the tree is only walked for text. It is
// no article-scoring engine; it removes chrome by structure only:
// - the content comes from the first visible <main>, else the first visible
//   <article>, else <body>
// - navigation, footers, asides, forms and their controls, code, styling,
//   graphics, embedded documents and anything marked hidden or aria-hidden are
//   left out with everything inside them
// - h1-h6, p, blockquote and pre are one block each with all their text; a
//   list item is one block with its own text, its nested lists become their
//   own items; other text becomes paragraphs between those blocks
// - an exact repeat of the block just before it is dropped
// text/plain becomes one paragraph per blank-line separated part.
//
// Bytes are decoded from the Content-Type charset, else (HTML only) the
// <meta> charset in the first 8 KiB, else UTF-8. Only UTF-8 and windows-1252
// (with its usual aliases) are read; invalid UTF-8 is refused, never repaired.
// Lengths and counts are not checked here: the Source Content parser refuses
// what is too large, and nothing is cut to fit

export const SOURCE_EXTRACT_MEDIA_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
] as const;

export type ContentStudioSourceMediaType =
  (typeof SOURCE_EXTRACT_MEDIA_TYPES)[number];

// How far into the body a <meta> charset is looked for
export const SOURCE_CHARSET_SNIFF_BYTES = 8192;
// Element nesting walked at most; deeper documents are refused, so a hostile
// page cannot exhaust the stack
export const SOURCE_EXTRACT_MAX_DEPTH = 512;

// The charset labels read, each mapped to its Encoding Standard decoder. As
// in browsers, us-ascii and iso-8859-1 are read as windows-1252, which
// decodes every byte; only UTF-8 can be invalid
const CHARSETS: Record<string, 'utf-8' | 'windows-1252'> = {
  'utf-8': 'utf-8',
  utf8: 'utf-8',
  'unicode-1-1-utf-8': 'utf-8',
  'us-ascii': 'windows-1252',
  'iso-8859-1': 'windows-1252',
  latin1: 'windows-1252',
  'windows-1252': 'windows-1252',
  cp1252: 'windows-1252',
};

export type ContentStudioSourceCharset = (typeof CHARSETS)[string];

export type ContentStudioSourceExtractionErrorCode =
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'UNSUPPORTED_CHARSET'
  | 'INVALID_ENCODING'
  | 'TOO_DEEP';

const ERROR_MESSAGES: Record<ContentStudioSourceExtractionErrorCode, string> = {
  UNSUPPORTED_MEDIA_TYPE: 'The source media type is not supported',
  UNSUPPORTED_CHARSET: 'The source charset is not supported',
  INVALID_ENCODING: 'The source bytes do not match their charset',
  TOO_DEEP: 'The source document is nested too deeply',
};

// Fixed messages: never a byte of the page or of its headers
export class ContentStudioSourceExtractionError extends Error {
  constructor(readonly code: ContentStudioSourceExtractionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ContentStudioSourceExtractionError';
  }
}

type BlockType = 'heading' | 'paragraph' | 'list_item' | 'quote';

export interface ContentStudioSourceExtraction {
  mediaType: ContentStudioSourceMediaType;
  charset: ContentStudioSourceCharset;
  title: string | null;
  // Source Content v1 as extracted, not yet checked against its limits
  content: {
    schemaVersion: 1;
    blocks: Array<{
      id: string;
      type: BlockType;
      text: string;
      level: number | null;
    }>;
  };
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// The media type and charset of an approved Content-Type header. Printable
// ASCII only; parameters other than charset are ignored, a charset given twice
// or with a broken quote is refused. The charset is only used to decode: what
// is stored is the media type
export function parseContentStudioSourceContentType(header: unknown): {
  mediaType: ContentStudioSourceMediaType;
  charset: string | null;
} {
  return parseContentStudioSourceMediaType(header, SOURCE_EXTRACT_MEDIA_TYPES);
}

// The same rules for another list of media types (feeds read XML types)
export function parseContentStudioSourceMediaType<T extends string>(
  header: unknown,
  mediaTypes: readonly T[]
): {
  mediaType: T;
  charset: string | null;
} {
  if (
    typeof header !== 'string' ||
    header.length > 1024 ||
    !/^[\t\x20-\x7E]*$/.test(header)
  ) {
    throw new ContentStudioSourceExtractionError('UNSUPPORTED_MEDIA_TYPE');
  }
  // split on the semicolons that are not inside a quoted value
  const parts: string[] = [''];
  let quoted = false;
  for (let i = 0; i < header.length; i += 1) {
    const char = header[i];
    if (char === '\\' && quoted) {
      parts[parts.length - 1] += char + (header[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
    }
    if (char === ';' && !quoted) {
      parts.push('');
      continue;
    }
    parts[parts.length - 1] += char;
  }

  const mediaType = parts[0].trim().toLowerCase();
  const known = mediaTypes.find((type) => type === mediaType);
  if (!known) {
    throw new ContentStudioSourceExtractionError('UNSUPPORTED_MEDIA_TYPE');
  }

  let charset: string | null = null;
  for (const parameter of parts.slice(1)) {
    const equals = parameter.indexOf('=');
    const name = parameter.slice(0, equals < 0 ? undefined : equals).trim();
    if (equals < 0 || name.toLowerCase() !== 'charset' || !TOKEN.test(name)) {
      continue;
    }
    let value = parameter.slice(equals + 1).trim();
    if (value.startsWith('"')) {
      if (value.length < 2 || !value.endsWith('"')) {
        throw new ContentStudioSourceExtractionError('UNSUPPORTED_CHARSET');
      }
      value = value.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    if (charset !== null || !value.trim()) {
      throw new ContentStudioSourceExtractionError('UNSUPPORTED_CHARSET');
    }
    charset = value.trim().toLowerCase();
  }
  return { mediaType: known, charset };
}

// The decoder of an allowed charset label, quotes and case aside
export function contentStudioSourceCharset(
  label: string
): ContentStudioSourceCharset {
  const key = label
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(CHARSETS, key)) {
    throw new ContentStudioSourceExtractionError('UNSUPPORTED_CHARSET');
  }
  return CHARSETS[key];
}

const unquote = (value: string) =>
  /^(["']).*\1$/s.test(value) ? value.slice(1, -1) : value;

// The charset an HTML page declares in a <meta charset> or a <meta
// http-equiv="content-type"> within its first SOURCE_CHARSET_SNIFF_BYTES. The
// window is read byte for byte (every byte maps to one character), comments
// are skipped, and the first declaring tag wins. No other byte sniffing
export function contentStudioSourceMetaCharset(
  body: Uint8Array
): string | null {
  const head = new TextDecoder('windows-1252')
    .decode(body.subarray(0, SOURCE_CHARSET_SNIFF_BYTES))
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  for (const [tag] of head.matchAll(/<meta\b[^>]{0,1024}>/gi)) {
    const attributes = new Map<string, string>();
    for (const [, name, value] of tag
      .slice(5, -1)
      .matchAll(/([^\s"'=<>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g)) {
      const key = name.toLowerCase();
      if (!attributes.has(key)) {
        attributes.set(key, unquote(value ?? '').trim());
      }
    }
    const charset = attributes.get('charset');
    if (charset) {
      return charset.toLowerCase();
    }
    if (attributes.get('http-equiv')?.toLowerCase() === 'content-type') {
      const declared = /charset\s*=\s*["']?([^"'\s;]+)/i.exec(
        attributes.get('content') || ''
      );
      if (declared) {
        return declared[1].toLowerCase();
      }
    }
  }
  return null;
}

// Strict decoding: bytes that are not valid in the charset are refused. NUL
// becomes U+FFFD, as HTML parsing does. A UTF-8 byte order mark is dropped
export function decodeContentStudioSourceBody(
  body: Uint8Array,
  charset: ContentStudioSourceCharset
) {
  let text: string;
  try {
    text = new TextDecoder(charset, { fatal: true }).decode(body);
  } catch {
    throw new ContentStudioSourceExtractionError('INVALID_ENCODING');
  }
  return text.replace(/\u0000/g, '�');
}

// Subtrees that are never page content
const EXCLUDED = new Set([
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
  'nav',
  'footer',
  'aside',
  'form',
  'button',
  'select',
  'option',
  'datalist',
  'textarea',
  'input',
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
  'img',
  'ins',
  'kbd',
  'label',
  'mark',
  'nobr',
  'picture',
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
// HTML whitespace plus the no-break space, which pages use as spacing
const SPACE = /[\t\n\f\r  ]+/g;

const isElement = (node: ChildNode): node is Element => 'tagName' in node;
const textValue = (node: ChildNode) =>
  node.nodeName === '#text' ? (node as { value: string }).value : null;

// The hidden attribute or aria-hidden="true": the only hiding visible in the
// markup itself (classes and styles are not interpreted)
const isHidden = (element: Element) =>
  element.attrs.some(
    ({ name, value }) =>
      name === 'hidden' ||
      (name === 'aria-hidden' && value.trim().toLowerCase() === 'true')
  );
const isLeftOut = (element: Element) =>
  EXCLUDED.has(element.tagName) || isHidden(element);

const tooDeep = (depth: number) => {
  if (depth > SOURCE_EXTRACT_MAX_DEPTH) {
    throw new ContentStudioSourceExtractionError('TOO_DEEP');
  }
};

// Line endings to LF, spaces collapsed and trimmed per line, at most one empty
// line in a row, outer blank lines dropped
const normalizeText = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t\f ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

// Preformatted text keeps its spacing; only line ends are normalized and
// trailing spaces and outer blank lines dropped
const normalizePreformatted = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');

// One line: every whitespace run, line breaks included, is one space
const normalizeTitle = (text: string) =>
  text.replace(/\s+/g, ' ').trim() || null;

// The first element with this tag in document order, outside left-out
// subtrees (a <main> inside <nav> or a hidden <article> is never the root)
function findVisible(
  nodes: ChildNode[],
  tag: string,
  depth: number
): Element | undefined {
  tooDeep(depth);
  for (const node of nodes) {
    if (!isElement(node) || isLeftOut(node)) {
      continue;
    }
    if (node.tagName === tag) {
      return node;
    }
    const found = findVisible(node.childNodes, tag, depth + 1);
    if (found) {
      return found;
    }
  }
  return undefined;
}

// The document <title>: the first one outside svg and math
function findTitle(nodes: ChildNode[], depth: number): Element | undefined {
  tooDeep(depth);
  for (const node of nodes) {
    if (!isElement(node) || node.tagName === 'svg' || node.tagName === 'math') {
      continue;
    }
    if (node.tagName === 'title') {
      return node;
    }
    const found = findTitle(node.childNodes, depth + 1);
    if (found) {
      return found;
    }
  }
  return undefined;
}

interface PendingBlock {
  type: BlockType;
  level: number | null;
  text: string;
  preformatted: boolean;
}

function extractMarkup(markup: string) {
  const document = parse(markup);
  const blocks: PendingBlock[] = [];
  let loose = '';

  // text not inside a block element becomes a paragraph between blocks
  const flushLoose = () => {
    if (loose) {
      blocks.push({
        type: 'paragraph',
        level: null,
        text: loose,
        preformatted: false,
      });
    }
    loose = '';
  };

  // All visible text below a block element, with line breaks between the
  // block-level elements inside it. A list item hands its nested lists to
  // onList instead, so their items become blocks of their own
  const collect = (
    nodes: ChildNode[],
    depth: number,
    preformatted: boolean,
    onList?: (list: Element, depth: number) => void
  ): string => {
    tooDeep(depth);
    let text = '';
    for (const node of nodes) {
      const value = textValue(node);
      if (value !== null) {
        text += preformatted ? value : value.replace(SPACE, ' ');
        continue;
      }
      if (!isElement(node) || isLeftOut(node)) {
        continue;
      }
      if (node.tagName === 'br') {
        text += '\n';
      } else if (onList && (node.tagName === 'ul' || node.tagName === 'ol')) {
        onList(node, depth + 1);
        text += '\n';
      } else if (INLINE.has(node.tagName)) {
        text += collect(node.childNodes, depth + 1, preformatted, onList);
      } else {
        const separator = node.tagName === 'p' ? '\n\n' : '\n';
        text +=
          separator +
          collect(
            node.childNodes,
            depth + 1,
            preformatted || node.tagName === 'pre',
            onList
          ) +
          separator;
      }
    }
    return text;
  };

  const walk = (nodes: ChildNode[], depth: number, listDepth: number) => {
    tooDeep(depth);
    for (const node of nodes) {
      const value = textValue(node);
      if (value !== null) {
        loose += value.replace(SPACE, ' ');
        continue;
      }
      if (!isElement(node) || isLeftOut(node)) {
        continue;
      }
      const tag = node.tagName;
      if (tag === 'br') {
        loose += '\n';
        continue;
      }
      if (INLINE.has(tag)) {
        walk(node.childNodes, depth + 1, listDepth);
        continue;
      }
      flushLoose();
      const heading = HEADING.exec(tag);
      if (heading || tag === 'p' || tag === 'blockquote' || tag === 'pre') {
        blocks.push({
          type: heading
            ? 'heading'
            : tag === 'blockquote'
            ? 'quote'
            : 'paragraph',
          level: heading ? Number(heading[1]) : null,
          text: collect(node.childNodes, depth + 1, tag === 'pre'),
          preformatted: tag === 'pre',
        });
      } else if (tag === 'li') {
        const item: PendingBlock = {
          type: 'list_item',
          level: Math.min(Math.max(listDepth - 1, 0), LIST_DEPTH_MAX),
          text: '',
          preformatted: false,
        };
        blocks.push(item);
        item.text = collect(node.childNodes, depth + 1, false, (list, at) => {
          walk(list.childNodes, at + 1, listDepth + 1);
          flushLoose();
        });
      } else if (tag === 'ul' || tag === 'ol') {
        walk(node.childNodes, depth + 1, listDepth + 1);
      } else {
        walk(node.childNodes, depth + 1, listDepth);
      }
      flushLoose();
    }
  };

  const root =
    findVisible(document.childNodes, 'main', 0) ||
    findVisible(document.childNodes, 'article', 0) ||
    findVisible(document.childNodes, 'body', 0);
  if (root) {
    walk(root.childNodes, 1, 0);
    flushLoose();
  }

  // the document title, else the first visible h1 of the content
  const titleElement = findTitle(document.childNodes, 0);
  let title = titleElement
    ? normalizeTitle(collect(titleElement.childNodes, 1, false))
    : null;
  if (!title && root) {
    const h1 = findVisible(root.childNodes, 'h1', 1);
    title = h1 ? normalizeTitle(collect(h1.childNodes, 1, false)) : null;
  }

  const normalized: Array<Omit<PendingBlock, 'preformatted'>> = [];
  for (const block of blocks) {
    const text = block.preformatted
      ? normalizePreformatted(block.text)
      : normalizeText(block.text);
    const previous = normalized[normalized.length - 1];
    if (
      !text.trim() ||
      (previous &&
        previous.type === block.type &&
        previous.level === block.level &&
        previous.text === text)
    ) {
      continue;
    }
    normalized.push({ type: block.type, level: block.level, text });
  }
  return { title, blocks: normalized };
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

// Same bytes and Content-Type, same output: blocks are numbered b1, b2, ...
// in document order after empty and repeated ones are dropped, so an
// unchanged page keeps its block ids
export function extractContentStudioSource(input: {
  contentType: string | undefined | null;
  body: Uint8Array;
}): ContentStudioSourceExtraction {
  const { mediaType, charset: declared } = parseContentStudioSourceContentType(
    input.contentType
  );
  // the header first, then (HTML only) a <meta> declaration, then UTF-8
  const label =
    declared ??
    (mediaType === 'text/plain'
      ? null
      : contentStudioSourceMetaCharset(input.body));
  const charset = label === null ? 'utf-8' : contentStudioSourceCharset(label);
  const text = decodeContentStudioSourceBody(input.body, charset);
  const { title, blocks } =
    mediaType === 'text/plain'
      ? { title: null, blocks: extractPlainText(text) }
      : extractMarkup(text);
  return {
    mediaType,
    charset,
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
