import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { parseFragment } from 'parse5';
import { CONTENT_STUDIO_SOURCE_NAME_MAX } from '@gitroom/nestjs-libraries/content-studio/sources/source.types';
import {
  canonicalContentStudioSourceUrl,
  ContentStudioSourceUrlError,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.url';
import {
  contentStudioSourceCharset,
  ContentStudioSourceCharset,
  ContentStudioSourceExtractionError,
  decodeContentStudioSourceBody,
  parseContentStudioSourceMediaType,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.extract';

// The reader of Content Studio feed sources (P8-01): it turns the bytes of an
// RSS 2.0, RSS 1.0 (RDF) or Atom feed into the web pages its entries link
// to. Pure and deterministic: no network, database, clock or randomness. The
// bytes come from SafeFetch; nothing here is given a URL to load, and the XML
// parser (fast-xml-parser, already a dependency) only ever reads a string.
//
// XML safety: a document type declaration is refused before parsing, so no
// entity can be declared and only the five XML entities and character
// references are expanded; nothing external (DTD, entity, schema) is ever
// read, since the parser has no network or file access at all. The document
// must be well-formed, and names such as __proto__ fail it closed.
//
// A feed is a way to find pages, not content: an entry gives the page URL,
// its id, title and date as metadata only. The page itself is captured as an
// ordinary `url` source. An entry is used only with an absolute https link
// (what source capture fetches), canonicalized like every source URL; a guid
// or an id is never turned into a link. Entries are read in the feed's own
// order, the first SOURCE_FEED_MAX_ENTRIES only; within those the first
// entry of a page wins. Bytes are decoded from the Content-Type charset, else
// the XML declaration, else UTF-8, and only UTF-8 and windows-1252 are read

export const SOURCE_FEED_MEDIA_TYPES = [
  'application/rss+xml',
  'application/atom+xml',
  'application/rdf+xml',
  'application/xml',
  'text/xml',
] as const;

export type ContentStudioSourceFeedMediaType =
  (typeof SOURCE_FEED_MEDIA_TYPES)[number];

// The entries of one capture: each one is at most one page fetch
export const SOURCE_FEED_MAX_ENTRIES = 25;
// An entry title is a label, like a source name
export const SOURCE_FEED_ENTRY_TITLE_MAX = CONTENT_STUDIO_SOURCE_NAME_MAX;
export const SOURCE_FEED_ENTRY_ID_MAX = 2048;
// Element nesting read at most; deeper documents are refused
export const SOURCE_FEED_MAX_DEPTH = 100;
// Dates outside these years are no dates
const YEAR_MIN = 1970;
const YEAR_MAX = 9999;

export type ContentStudioSourceFeedFormat = 'rss' | 'rdf' | 'atom';

export type ContentStudioSourceFeedErrorCode =
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'UNSUPPORTED_CHARSET'
  | 'INVALID_ENCODING'
  | 'DOCTYPE_REFUSED'
  | 'INVALID_XML'
  | 'NOT_A_FEED';

const ERROR_MESSAGES: Record<ContentStudioSourceFeedErrorCode, string> = {
  UNSUPPORTED_MEDIA_TYPE: 'The feed media type is not supported',
  UNSUPPORTED_CHARSET: 'The feed charset is not supported',
  INVALID_ENCODING: 'The feed bytes do not match their charset',
  DOCTYPE_REFUSED: 'The feed declares a document type',
  INVALID_XML: 'The feed is not well-formed XML',
  NOT_A_FEED: 'The document is not an RSS or Atom feed',
};

// Fixed messages: never a byte of the feed or of its headers
export class ContentStudioSourceFeedError extends Error {
  constructor(readonly code: ContentStudioSourceFeedErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ContentStudioSourceFeedError';
  }
}

// One page an entry links to, with the entry's own metadata
export interface ContentStudioSourceFeedEntry {
  // canonical, absolute https
  url: string;
  // the guid, Atom id or rdf:about as given: metadata, never a link
  entryId: string | null;
  // plain text, whitespace collapsed, at most SOURCE_FEED_ENTRY_TITLE_MAX
  title: string | null;
  // published, else (Atom) updated; null when missing or not a date
  publishedAt: Date | null;
}

export interface ContentStudioSourceFeed {
  format: ContentStudioSourceFeedFormat;
  mediaType: ContentStudioSourceFeedMediaType;
  // every entry of the document
  entriesSeen: number;
  // the first maxEntries of them that link to a page, once per page
  entries: ContentStudioSourceFeedEntry[];
  // of the first maxEntries: no usable link, or a page listed before
  entriesSkipped: number;
  // entries after the first maxEntries, not read
  entriesIgnored: number;
}

// fast-xml-parser's ordered tree: an element is { name: children, ':@':
// attributes }, a text node { '#text': text }. Document order is kept, so
// mixed content reads in order
type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // values stay text: a title "2026" is not a number
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  // the five XML entities and character references (&#233;), plus the
  // common HTML names feeds use (&nbsp;): text only. No document type is
  // ever read, so no entity can be declared
  processEntities: true,
  htmlEntities: true,
  maxNestedTags: SOURCE_FEED_MAX_DEPTH,
});

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// <?xml ... encoding="..."?> at the very start, read byte for byte
const XML_ENCODING =
  /^<\?xml\s[^>]{0,256}?\bencoding\s*=\s*(["'])([A-Za-z0-9._-]{1,40})\1/;

// The charset to decode with: a UTF-8 byte order mark, else the Content-Type
// charset, else the XML declaration, else UTF-8
const feedCharset = (
  body: Uint8Array,
  declared: string | null
): ContentStudioSourceCharset => {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    return 'utf-8';
  }
  const label =
    declared ??
    XML_ENCODING.exec(
      new TextDecoder('windows-1252').decode(body.subarray(0, 512))
    )?.[2] ??
    'utf-8';
  return contentStudioSourceCharset(label);
};

// Everything before the root element: the XML declaration, processing
// instructions, comments and whitespace only. A document type declaration
// (or anything else starting with <!) is refused, so no entity is declared
const assertNoDoctype = (xml: string) => {
  let i = 0;
  while (i < xml.length) {
    const char = xml[i];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      i += 1;
      continue;
    }
    if (xml.startsWith('<?', i)) {
      const end = xml.indexOf('?>', i + 2);
      if (end < 0) {
        throw new ContentStudioSourceFeedError('INVALID_XML');
      }
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      if (end < 0) {
        throw new ContentStudioSourceFeedError('INVALID_XML');
      }
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!', i)) {
      throw new ContentStudioSourceFeedError('DOCTYPE_REFUSED');
    }
    return;
  }
};

const isNode = (value: unknown): value is XmlNode =>
  !!value && typeof value === 'object' && !Array.isArray(value);

// The element name of a node ('#text' for text)
const nameOf = (node: XmlNode) => Object.keys(node).find((key) => key !== ':@');

const childrenOf = (node: XmlNode | undefined): XmlNode[] => {
  const name = node && nameOf(node);
  const children = name ? node[name] : undefined;
  return Array.isArray(children) ? children.filter(isNode) : [];
};

const elements = (nodes: XmlNode[], name: string) =>
  nodes.filter((node) => nameOf(node) === name);

const attribute = (node: XmlNode | undefined, name: string) => {
  const attributes = node?.[':@'];
  const value = isNode(attributes) ? attributes[name] : undefined;
  return typeof value === 'string' ? value : undefined;
};

// The text of nodes in document order, descendants included, markup left out
const textOf = (nodes: XmlNode[]): string =>
  nodes
    .map((node) =>
      nameOf(node) === '#text'
        ? String(node['#text'] ?? '')
        : textOf(childrenOf(node))
    )
    .join('');

// The text of the first child element `name`
const childText = (nodes: XmlNode[], name: string) =>
  textOf(childrenOf(elements(nodes, name)[0]));

// Text as a label: controls and lone surrogates removed, whitespace collapsed,
// at most `max` UTF-16 code units (never half a character); blank is none
const label = (text: string, max: number) => {
  const clean = text
    .replace(CONTROL, '')
    .replace(UNPAIRED_SURROGATE, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= max) {
    return clean || null;
  }
  const cut = clean.slice(0, max);
  // a pair cut in half loses its first half too
  return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut).trim() || null;
};

// The text of an HTML fragment, the way the source extractor reads HTML
// (parse5, nothing executed or loaded)
const htmlText = (markup: string) => {
  const parts: string[] = [];
  const walk = (node: {
    nodeName: string;
    value?: string;
    childNodes?: unknown[];
  }) => {
    if (node.nodeName === '#text' && typeof node.value === 'string') {
      parts.push(node.value);
    }
    for (const child of (node.childNodes ?? []) as Array<typeof node>) {
      if (child.nodeName !== 'script' && child.nodeName !== 'style') {
        walk(child);
      }
    }
  };
  walk(parseFragment(markup) as unknown as Parameters<typeof walk>[0]);
  return parts.join(' ');
};

// An entry title: RSS and plain Atom titles are text; an Atom title of type
// html is markup in text, read as HTML; xhtml is read as its text
const entryTitle = (nodes: XmlNode[]) => {
  const title = elements(nodes, 'title')[0];
  const text = textOf(childrenOf(title));
  return label(
    attribute(title, 'type') === 'html' ? htmlText(text) : text,
    SOURCE_FEED_ENTRY_TITLE_MAX
  );
};

const entryId = (text: string | undefined) => {
  const id = (text ?? '').trim();
  return id &&
    id.length <= SOURCE_FEED_ENTRY_ID_MAX &&
    !/[\u0000-\u001F\u007F]/.test(id)
    ? id
    : null;
};

// A date the feed gives, or null: never an error
const entryDate = (...texts: string[]) => {
  for (const raw of texts) {
    const text = raw.trim();
    if (!text) {
      continue;
    }
    const time = Date.parse(text);
    if (!Number.isFinite(time)) {
      continue;
    }
    const date = new Date(time);
    const year = date.getUTCFullYear();
    if (year >= YEAR_MIN && year <= YEAR_MAX) {
      return date;
    }
  }
  return null;
};

// An absolute https page URL in canonical form, or null: relative links,
// other schemes, credentials and malformed URLs are no page
const pageUrl = (raw: unknown) => {
  if (typeof raw !== 'string' || !/^https:\/\//i.test(raw.trim())) {
    return null;
  }
  try {
    const url = canonicalContentStudioSourceUrl(raw.trim());
    return url.startsWith('https://') ? url : null;
  } catch (err) {
    if (err instanceof ContentStudioSourceUrlError) {
      return null;
    }
    throw err;
  }
};

// Atom: the first link with rel="alternate" or no rel
const atomLink = (nodes: XmlNode[]) => {
  const alternate = elements(nodes, 'link').find((link) => {
    const rel = attribute(link, 'rel');
    return rel === undefined || rel === 'alternate';
  });
  return pageUrl(attribute(alternate, 'href'));
};

const toEntry = (
  format: ContentStudioSourceFeedFormat,
  node: XmlNode
): ContentStudioSourceFeedEntry | null => {
  const nodes = childrenOf(node);
  if (format === 'atom') {
    const url = atomLink(nodes);
    return url
      ? {
          url,
          entryId: entryId(childText(nodes, 'id')),
          title: entryTitle(nodes),
          publishedAt: entryDate(
            childText(nodes, 'published'),
            childText(nodes, 'updated')
          ),
        }
      : null;
  }
  // RSS 2.0 and RSS 1.0: the <link> text. Never the guid
  const url = pageUrl(childText(nodes, 'link'));
  return url
    ? {
        url,
        entryId: entryId(
          format === 'rss'
            ? childText(nodes, 'guid')
            : attribute(node, 'rdf:about')
        ),
        title: entryTitle(nodes),
        publishedAt: entryDate(
          childText(nodes, 'pubDate'),
          childText(nodes, 'dc:date')
        ),
      }
    : null;
};

// The format and the entries of a parsed document: RSS 2.0 (and 0.9x) items
// in its channel, RSS 1.0 items next to its channel, Atom entries
const feedEntries = (
  document: XmlNode[]
): { format: ContentStudioSourceFeedFormat; entries: XmlNode[] } => {
  // the root element: declarations and processing instructions aside
  const root = document.find((node) => !nameOf(node)?.startsWith('?'));
  const name = root && nameOf(root);
  const children = childrenOf(root);
  if (name === 'rss') {
    const channel = elements(children, 'channel')[0];
    if (channel) {
      return { format: 'rss', entries: elements(childrenOf(channel), 'item') };
    }
  }
  if (name === 'rdf:RDF' && elements(children, 'channel').length) {
    return { format: 'rdf', entries: elements(children, 'item') };
  }
  if (name === 'feed') {
    return { format: 'atom', entries: elements(children, 'entry') };
  }
  throw new ContentStudioSourceFeedError('NOT_A_FEED');
};

export function parseContentStudioSourceFeed(input: {
  contentType: unknown;
  body: Uint8Array;
  maxEntries?: number;
}): ContentStudioSourceFeed {
  const maxEntries = input.maxEntries ?? SOURCE_FEED_MAX_ENTRIES;
  let mediaType: ContentStudioSourceFeedMediaType;
  let xml: string;
  try {
    const parsedType = parseContentStudioSourceMediaType(
      input.contentType,
      SOURCE_FEED_MEDIA_TYPES
    );
    mediaType = parsedType.mediaType;
    xml = decodeContentStudioSourceBody(
      input.body,
      feedCharset(input.body, parsedType.charset)
    );
  } catch (err) {
    if (err instanceof ContentStudioSourceExtractionError) {
      throw new ContentStudioSourceFeedError(
        err.code === 'UNSUPPORTED_MEDIA_TYPE' ||
        err.code === 'UNSUPPORTED_CHARSET' ||
        err.code === 'INVALID_ENCODING'
          ? err.code
          : 'INVALID_XML'
      );
    }
    throw err;
  }

  assertNoDoctype(xml);
  if (XMLValidator.validate(xml) !== true) {
    throw new ContentStudioSourceFeedError('INVALID_XML');
  }
  let document: unknown;
  try {
    document = parser.parse(xml);
  } catch {
    // nesting too deep, a dangerous name, anything the parser refuses
    throw new ContentStudioSourceFeedError('INVALID_XML');
  }
  if (!Array.isArray(document)) {
    throw new ContentStudioSourceFeedError('NOT_A_FEED');
  }

  const { format, entries } = feedEntries(document.filter(isNode));
  const read = entries.slice(0, maxEntries);
  const seen = new Set<string>();
  const accepted: ContentStudioSourceFeedEntry[] = [];
  for (const node of read) {
    const entry = toEntry(format, node);
    if (entry && !seen.has(entry.url)) {
      seen.add(entry.url);
      accepted.push(entry);
    }
  }
  return {
    format,
    mediaType,
    entriesSeen: entries.length,
    entries: accepted,
    entriesSkipped: read.length - accepted.length,
    entriesIgnored: entries.length - read.length,
  };
}
