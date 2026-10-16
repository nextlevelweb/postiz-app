import { z } from 'zod';
import {
  isPlainData,
  trimmedText,
  utf8ByteLength,
} from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';
import { contentPackageItemText } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  BRAND_FONT_STYLES,
  BRAND_FONT_WEIGHTS,
  BRAND_TOKEN_ID,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';

// Design Document v1: what a design is, as semantic data that the shared
// layout engine and the server renderer read later. Pages in order, each with
// explicit dimensions, a solid background and a flat list of layers whose
// array order is the z-order (first is at the back). Geometry is in design
// units (one unit is one pixel at the nominal size) and may lie outside the
// page: the renderer clips. Styles are structured values only: no CSS, HTML,
// SVG, editor (Fabric) state, URL or encoded image. Colors and type styles are
// either literal or a token of the one Brand Kit revision the document names;
// whether that revision and its tokens exist is checked by the service when a
// design is saved. Images name a Media id and its SHA-256: the shape only,
// checked against Media in a later step. Nothing here is generated or random:
// every id and value is given. Like the other content parsers this file uses
// no Node-only module

export const DESIGN_DOCUMENT_SCHEMA_VERSION = 1;

// the name of a design project: metadata of the row, not of the document
export const DESIGN_PROJECT_NAME_MAX = 200;

export const DESIGN_PAGES_MIN = 1;
export const DESIGN_PAGES_MAX = 25;
export const DESIGN_PAGE_NAME_MAX = 100;
export const DESIGN_PAGE_SIZE_MIN = 64;
export const DESIGN_PAGE_SIZE_MAX = 8192;
// 32 Mi pixels: 8192 x 4096 is the largest page, 8192 x 8192 is not
export const DESIGN_PAGE_AREA_MAX = 33_554_432;
export const DESIGN_LAYERS_PER_PAGE_MAX = 200;
export const DESIGN_LAYERS_MAX = 1000;
export const DESIGN_LAYER_NAME_MAX = 100;
export const DESIGN_COORDINATE_MAX = 32_768;
export const DESIGN_ROTATION_MAX = 360;
export const DESIGN_TEXT_MAX = 10_000;
export const DESIGN_TOTAL_TEXT_MAX = 200_000;
export const DESIGN_FONT_FAMILY_MAX = 200;
export const DESIGN_FONT_SIZE_MIN = 1;
export const DESIGN_FONT_SIZE_MAX = 1024;
export const DESIGN_LINE_HEIGHT_MIN = 0.5;
export const DESIGN_LINE_HEIGHT_MAX = 10;
export const DESIGN_LETTER_SPACING_MAX = 100;
export const DESIGN_CORNER_RADIUS_MAX = 4096;
// UTF-8 bytes of the normalized document as JSON. The canonical form writes
// the same keys, strings and numbers in another key order only, so this is
// its size too
export const DESIGN_DOCUMENT_MAX_BYTES = 1_048_576;

// Ids are stable names chosen by the editor, not array positions or
// database ids. Page ids and layer ids are separate namespaces; both keep case
const PAGE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const LAYER_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// the safe token rule of Content Package media ids: no path, URL, dot,
// slash or space can pass
const MEDIA_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LOWER_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
// revision numbers are PostgreSQL integers
const INT4_MAX = 2_147_483_647;

// Every number is a finite JavaScript number: no numeric text, NaN or
// infinity
const finite = (min: number, max: number) =>
  z.number().finite().min(min).max(max);
const positive = (max: number) => z.number().finite().gt(0).max(max);
const integer = (min: number, max: number) =>
  z.number().int().min(min).max(max);

const brandToken = z.string().regex(BRAND_TOKEN_ID);

// A literal #rrggbb (stored lowercase) or a color token of the Brand Kit
// revision
const colorValue = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('literal'),
      value: z
        .string()
        .regex(HEX_COLOR)
        .transform((value) => value.toLowerCase()),
    })
    .strict(),
  z.object({ type: z.literal('brand'), tokenId: brandToken }).strict(),
]);

// A family name with weight and style, or a type style token of the Brand
// Kit revision. A family is a name, not a font the renderer can use yet
const fontRef = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('family'),
      family: trimmedText(DESIGN_FONT_FAMILY_MAX, 1),
      weight: z
        .number()
        .refine(
          (weight) =>
            (BRAND_FONT_WEIGHTS as readonly number[]).includes(weight),
          'Unsupported weight'
        ),
      style: z.enum(BRAND_FONT_STYLES),
    })
    .strict(),
  z.object({ type: z.literal('brand'), tokenId: brandToken }).strict(),
]);

// What every layer has. Visible false or opacity 0 still keep the layer
const layerBase = {
  id: z.string().regex(LAYER_ID),
  name: trimmedText(DESIGN_LAYER_NAME_MAX),
  x: finite(-DESIGN_COORDINATE_MAX, DESIGN_COORDINATE_MAX),
  y: finite(-DESIGN_COORDINATE_MAX, DESIGN_COORDINATE_MAX),
  width: positive(DESIGN_COORDINATE_MAX),
  height: positive(DESIGN_COORDINATE_MAX),
  // kept as given: 360 is not rewritten to 0
  rotation: finite(-DESIGN_ROTATION_MAX, DESIGN_ROTATION_MAX),
  opacity: finite(0, 1),
  visible: z.boolean(),
};

const textLayer = z
  .object({
    ...layerBase,
    type: z.literal('text'),
    // kept as written apart from line endings: outer spaces and newlines can
    // be design. Plain text, never HTML or Markdown
    text: contentPackageItemText,
    font: fontRef,
    fontSize: finite(DESIGN_FONT_SIZE_MIN, DESIGN_FONT_SIZE_MAX),
    // a multiple of the font size
    lineHeight: finite(DESIGN_LINE_HEIGHT_MIN, DESIGN_LINE_HEIGHT_MAX),
    // design units at the nominal size
    letterSpacing: finite(
      -DESIGN_LETTER_SPACING_MAX,
      DESIGN_LETTER_SPACING_MAX
    ),
    color: colorValue,
    align: z.enum(['left', 'center', 'right']),
    verticalAlign: z.enum(['top', 'middle', 'bottom']),
    overflow: z.enum(['clip', 'shrink']),
  })
  .strict();

const shapeLayer = z
  .object({
    ...layerBase,
    type: z.literal('shape'),
    shape: z.enum(['rectangle', 'ellipse']),
    fill: colorValue,
    // an ellipse has 0; the renderer limits a rectangle's visible radius
    cornerRadius: finite(0, DESIGN_CORNER_RADIUS_MAX),
  })
  .strict();

// The image reference only: a Media id with the SHA-256 of its bytes, for
// the Media bridge to verify later. No URL, path, file name or encoded data
const imageLayer = z
  .object({
    ...layerBase,
    type: z.literal('image'),
    imageRef: z
      .object({
        type: z.literal('media'),
        mediaId: z.string().regex(MEDIA_ID),
        sha256: z.string().regex(SHA256_HEX),
      })
      .strict(),
    fit: z.enum(['cover', 'contain']),
    // where cover cropping centers, 0..1 across and down the image
    focalPoint: z.object({ x: finite(0, 1), y: finite(0, 1) }).strict(),
  })
  .strict();

const layer = z.discriminatedUnion('type', [textLayer, shapeLayer, imageLayer]);

const page = z
  .object({
    id: z.string().regex(PAGE_ID),
    name: trimmedText(DESIGN_PAGE_NAME_MAX),
    width: integer(DESIGN_PAGE_SIZE_MIN, DESIGN_PAGE_SIZE_MAX),
    height: integer(DESIGN_PAGE_SIZE_MIN, DESIGN_PAGE_SIZE_MAX),
    background: z
      .object({ type: z.literal('solid'), color: colorValue })
      .strict(),
    layers: z.array(layer).max(DESIGN_LAYERS_PER_PAGE_MAX),
  })
  .strict();

// One exact, immutable Brand Kit revision: never "the current kit"
const brandKitRef = z
  .object({
    brandKitId: z.string().regex(LOWER_UUID),
    revisionId: z.string().regex(LOWER_UUID),
    revisionNumber: integer(1, INT4_MAX),
    contentHash: z.string().regex(SHA256_HEX),
  })
  .strict();

const documentSchema = z
  .object({
    schemaVersion: z.literal(DESIGN_DOCUMENT_SCHEMA_VERSION),
    brandKit: brandKitRef.nullable(),
    pages: z.array(page).min(DESIGN_PAGES_MIN).max(DESIGN_PAGES_MAX),
  })
  .strict()
  .superRefine((document, context) => {
    const issue = (path: Array<string | number>, message: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const pageIds = new Set<string>();
    const layerIds = new Set<string>();
    let layers = 0;
    let text = 0;
    document.pages.forEach((current, pageIndex) => {
      if (pageIds.has(current.id)) {
        issue(['pages', pageIndex, 'id'], 'Duplicate page id');
      }
      pageIds.add(current.id);
      // at most 8192 x 8192, far below the largest safe integer
      if (current.width * current.height > DESIGN_PAGE_AREA_MAX) {
        issue(['pages', pageIndex], 'Page too large');
      }
      current.layers.forEach((entry, layerIndex) => {
        const path = ['pages', pageIndex, 'layers', layerIndex];
        // unique across the whole document, not per page
        if (layerIds.has(entry.id)) {
          issue([...path, 'id'], 'Duplicate layer id');
        }
        layerIds.add(entry.id);
        layers += 1;
        if (entry.type === 'text') {
          text += entry.text.length;
        }
        if (
          entry.type === 'shape' &&
          entry.shape === 'ellipse' &&
          entry.cornerRadius !== 0
        ) {
          issue([...path, 'cornerRadius'], 'Ellipse with a corner radius');
        }
      });
    });
    if (layers > DESIGN_LAYERS_MAX) {
      issue(['pages'], 'Too many layers');
    }
    if (text > DESIGN_TOTAL_TEXT_MAX) {
      issue(['pages'], 'Too much text');
    }
  });

export type ContentStudioDesignColorValue =
  | { type: 'literal'; value: string }
  | { type: 'brand'; tokenId: string };

export type ContentStudioDesignFontRef =
  | {
      type: 'family';
      family: string;
      weight: (typeof BRAND_FONT_WEIGHTS)[number];
      style: (typeof BRAND_FONT_STYLES)[number];
    }
  | { type: 'brand'; tokenId: string };

interface ContentStudioDesignLayerBase {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  visible: boolean;
}

export interface ContentStudioDesignTextLayer
  extends ContentStudioDesignLayerBase {
  type: 'text';
  text: string;
  font: ContentStudioDesignFontRef;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  color: ContentStudioDesignColorValue;
  align: 'left' | 'center' | 'right';
  verticalAlign: 'top' | 'middle' | 'bottom';
  overflow: 'clip' | 'shrink';
}

export interface ContentStudioDesignShapeLayer
  extends ContentStudioDesignLayerBase {
  type: 'shape';
  shape: 'rectangle' | 'ellipse';
  fill: ContentStudioDesignColorValue;
  cornerRadius: number;
}

export interface ContentStudioDesignImageLayer
  extends ContentStudioDesignLayerBase {
  type: 'image';
  imageRef: { type: 'media'; mediaId: string; sha256: string };
  fit: 'cover' | 'contain';
  focalPoint: { x: number; y: number };
}

export type ContentStudioDesignLayer =
  | ContentStudioDesignTextLayer
  | ContentStudioDesignShapeLayer
  | ContentStudioDesignImageLayer;

export interface ContentStudioDesignPage {
  id: string;
  name: string;
  width: number;
  height: number;
  background: { type: 'solid'; color: ContentStudioDesignColorValue };
  layers: ContentStudioDesignLayer[];
}

export interface ContentStudioDesignBrandKitRef {
  brandKitId: string;
  revisionId: string;
  revisionNumber: number;
  contentHash: string;
}

export interface ContentStudioDesignDocumentV1 {
  schemaVersion: 1;
  brandKit: ContentStudioDesignBrandKitRef | null;
  pages: ContentStudioDesignPage[];
}

export type ContentStudioDesignDocumentErrorCode = 'INVALID' | 'TOO_LARGE';

export interface ContentStudioDesignDocumentIssue {
  path: Array<string | number>;
  code: string;
}

const ERROR_MESSAGES: Record<ContentStudioDesignDocumentErrorCode, string> = {
  INVALID: 'The design document does not match schema version 1',
  TOO_LARGE: 'The design document is larger than allowed',
};

// Fixed messages, and issues carry only the path and the kind of problem:
// zod messages can quote the rejected value
export class ContentStudioDesignDocumentError extends Error {
  readonly issues?: ContentStudioDesignDocumentIssue[];

  constructor(
    readonly code: ContentStudioDesignDocumentErrorCode,
    issues?: ContentStudioDesignDocumentIssue[]
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ContentStudioDesignDocumentError';
    this.issues = issues;
  }
}

// Validates and normalizes a design document (from a request or read back
// from the database) into a new object: line endings normalized, names and
// families trimmed, literal colors lowercased. Text layer text keeps its
// spaces. The input is never changed. The structure and its counts are
// checked first (INVALID), the serialized size last (TOO_LARGE). Anything else
// is refused, never repaired: nothing is dropped, merged, reordered or
// defaulted
export function parseContentStudioDesignDocument(
  input: unknown
): ContentStudioDesignDocumentV1 {
  if (!isPlainData(input)) {
    throw new ContentStudioDesignDocumentError('INVALID', [
      { path: [], code: 'not_plain_data' },
    ]);
  }
  const result = documentSchema.safeParse(input);
  if (!result.success) {
    throw new ContentStudioDesignDocumentError(
      'INVALID',
      result.error.issues.map(({ path, code }) => ({ path, code }))
    );
  }
  if (utf8ByteLength(JSON.stringify(result.data)) > DESIGN_DOCUMENT_MAX_BYTES) {
    throw new ContentStudioDesignDocumentError('TOO_LARGE');
  }
  return result.data as ContentStudioDesignDocumentV1;
}

// The Brand Kit tokens a document uses, each once, in first-use order: for
// checking them against the referenced revision, never stored
export function collectContentStudioDesignBrandTokenRefs(
  document: ContentStudioDesignDocumentV1
) {
  const colors = new Set<string>();
  const typography = new Set<string>();
  const color = (value: ContentStudioDesignColorValue) => {
    if (value.type === 'brand') {
      colors.add(value.tokenId);
    }
  };
  for (const current of document.pages) {
    color(current.background.color);
    for (const entry of current.layers) {
      if (entry.type === 'text') {
        color(entry.color);
        if (entry.font.type === 'brand') {
          typography.add(entry.font.tokenId);
        }
      } else if (entry.type === 'shape') {
        color(entry.fill);
      }
    }
  }
  return {
    colorTokenIds: Array.from(colors),
    typographyTokenIds: Array.from(typography),
  };
}

// One white 1080 x 1080 page without layers and without a Brand Kit. A
// helper for callers that want a starting point; nothing applies it
export const emptyContentStudioDesignDocument =
  (): ContentStudioDesignDocumentV1 =>
    parseContentStudioDesignDocument({
      schemaVersion: DESIGN_DOCUMENT_SCHEMA_VERSION,
      brandKit: null,
      pages: [
        {
          id: 'page-1',
          name: '',
          width: 1080,
          height: 1080,
          background: {
            type: 'solid',
            color: { type: 'literal', value: '#ffffff' },
          },
          layers: [],
        },
      ],
    });
