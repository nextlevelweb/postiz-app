import {
  isPlainData,
  utf8ByteLength,
} from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';
import {
  ContentStudioDesignDocumentError,
  ContentStudioDesignDocumentV1,
  ContentStudioDesignPage,
  DESIGN_PAGES_MAX,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';

// Page Set v1: a reusable page structure, copied into a design when it is
// used and never linked to it. A page set is the pages of a design, in
// order, each with only its name, its size and, when it has one, a literal
// solid background; no page id, layer, Media, Brand Kit token, guidance,
// template, pattern, platform or campaign. Every page is checked by the
// Design Document v1 parser itself, so a page set can name no size or name
// a design could not have. Using one makes blank pages under new ids. Like
// the other content parsers this file uses no Node-only module

export const DESIGN_PAGE_SET_SCHEMA_VERSION = 1;
// UTF-8 bytes of the normalized page set as JSON
export const DESIGN_PAGE_SET_MAX_BYTES = 65_536;
export const DESIGN_PAGE_SET_NAME_MAX = 100;
export const DESIGN_PAGE_SET_DESCRIPTION_MAX = 500;

// The fixed canvas sizes Creative Studio offers, for a new design, a size
// variant (P4-16) and the built-in page sets: the one list of them
export const DESIGN_CANVAS_PRESETS = [
  { id: 'square', label: 'Square', width: 1080, height: 1080 },
  { id: 'portrait', label: 'Portrait', width: 1080, height: 1350 },
  { id: 'story', label: 'Story', width: 1080, height: 1920 },
  { id: 'landscape', label: 'Landscape', width: 1200, height: 628 },
] as const;

export type ContentStudioDesignCanvasPreset =
  (typeof DESIGN_CANVAS_PRESETS)[number];

export interface ContentStudioDesignPageSetPage {
  name: string;
  width: number;
  height: number;
  // a literal color only; left out, a page starts white
  background?: {
    type: 'solid';
    color: { type: 'literal'; value: string };
  };
}

export interface ContentStudioDesignPageSetContentV1 {
  schemaVersion: 1;
  pages: ContentStudioDesignPageSetPage[];
}

// INVALID: not Page Set v1. TOO_LARGE: valid, but larger than allowed
export class ContentStudioDesignPageSetError extends Error {
  constructor(readonly code: 'INVALID' | 'TOO_LARGE' = 'INVALID') {
    super(
      code === 'TOO_LARGE'
        ? 'The page set is larger than allowed'
        : 'The page set does not match schema version 1'
    );
    this.name = 'ContentStudioDesignPageSetError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const WHITE = { type: 'literal' as const, value: '#ffffff' };
const PAGE_KEYS = ['name', 'width', 'height', 'background'];

// The pages, each given a probe id and no layers, parsed as a document: the
// Design Document v1 rules decide every name, size and background
const parsePages = (pages: Record<string, unknown>[]) => {
  try {
    return parseContentStudioDesignDocument({
      schemaVersion: 1,
      brandKit: null,
      pages: pages.map((page, index) => ({
        id: `probe_${index}`,
        name: page.name,
        width: page.width,
        height: page.height,
        background: page.background ?? { type: 'solid', color: WHITE },
        layers: [],
      })),
    }).pages;
  } catch (err) {
    if (err instanceof ContentStudioDesignDocumentError) {
      throw new ContentStudioDesignPageSetError();
    }
    throw err;
  }
};

// Validates and normalizes Page Set v1 content (from a request, a built-in
// or the database) into a new object, as the Design Document v1 parser
// normalizes pages (names trimmed, colors lowercased). The input is never
// changed. A page with any other key (an id, layers) or a Brand Kit color
// as its background is refused
export function parseContentStudioDesignPageSetContent(
  input: unknown
): ContentStudioDesignPageSetContentV1 {
  if (
    !isPlainData(input) ||
    !isRecord(input) ||
    Object.keys(input).sort().join(',') !== 'pages,schemaVersion' ||
    input.schemaVersion !== DESIGN_PAGE_SET_SCHEMA_VERSION ||
    !Array.isArray(input.pages) ||
    !input.pages.length ||
    input.pages.length > DESIGN_PAGES_MAX ||
    !input.pages.every(
      (page) =>
        isRecord(page) &&
        Object.keys(page).every((key) => PAGE_KEYS.includes(key)) &&
        ['name', 'width', 'height'].every((key) =>
          Object.prototype.hasOwnProperty.call(page, key)
        )
    )
  ) {
    throw new ContentStudioDesignPageSetError();
  }
  const pages = input.pages as Record<string, unknown>[];
  const parsed = parsePages(pages);
  const content: ContentStudioDesignPageSetContentV1 = {
    schemaVersion: 1,
    pages: parsed.map((page, index) => {
      const color = page.background.color;
      if (color.type !== 'literal') {
        throw new ContentStudioDesignPageSetError();
      }
      return {
        name: page.name,
        width: page.width,
        height: page.height,
        ...(pages[index].background === undefined
          ? {}
          : {
              background: {
                type: 'solid' as const,
                color: { type: 'literal' as const, value: color.value },
              },
            }),
      };
    }),
  };
  if (utf8ByteLength(JSON.stringify(content)) > DESIGN_PAGE_SET_MAX_BYTES) {
    throw new ContentStudioDesignPageSetError('TOO_LARGE');
  }
  return content;
}

// The page structure of a design, in page order: each page's name, size
// and its background when that is a literal color (a Brand Kit color is
// left out, so the page starts white). Page ids, layers, the Brand Kit and
// everything else of the design are not taken. The document is not changed
export function extractContentStudioDesignPageSet(
  document: ContentStudioDesignDocumentV1
): ContentStudioDesignPageSetContentV1 {
  return {
    schemaVersion: 1,
    pages: document.pages.map((page) => ({
      name: page.name,
      width: page.width,
      height: page.height,
      ...(page.background.color.type === 'literal'
        ? {
            background: {
              type: 'solid' as const,
              color: {
                type: 'literal' as const,
                value: page.background.color.value,
              },
            },
          }
        : {}),
    })),
  };
}

// One blank Design Document v1 page per page of the set, in its order, each
// with the id it is given, its name and size, its background (white when
// the set has none) and no layers. The page set is not changed; the caller
// checks ids and limits
export function instantiateContentStudioDesignPageSet(
  content: ContentStudioDesignPageSetContentV1,
  newId: () => string
): ContentStudioDesignPage[] {
  return content.pages.map((page) => ({
    id: newId(),
    name: page.name,
    width: page.width,
    height: page.height,
    background: {
      type: 'solid',
      color: { ...(page.background?.color ?? WHITE) },
    },
    layers: [],
  }));
}
