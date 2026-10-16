import type {
  BRAND_FONT_STYLES,
  BRAND_FONT_WEIGHTS,
  ContentStudioBrandKitContentV1,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import type {
  ContentStudioDesignBrandKitRef,
  ContentStudioDesignDocumentV1,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';

// The contract of the design layout engine: what it reads, what it returns
// and how it fails. The engine is the one place where a Design Document v1
// becomes geometry; the server renderer and a later editor preview draw its
// output and never lay text out or crop images themselves.
//
// Coordinates are design units in page space: x grows to the right, y grows
// down, (0, 0) is the top left of the page. Every box is the unrotated layer
// box. A renderer rotates an item (and its clip) by `rotation` degrees
// around `transformOrigin`, the center of that box; a positive angle turns
// clockwise on the page. Nothing is precomputed for rotation: no matrix and
// no rotated bounds.
//
// The output is plain JSON data: no class, function, Buffer, CSS, HTML, SVG
// or editor object. It is built for one render and is never stored

export const DESIGN_LAYOUT_SCHEMA_VERSION = 1;

// how close a measured length may come to its limit and still fit
export const DESIGN_LAYOUT_EPSILON = 1e-9;
// a tab is laid out as four spaces, not as a tab stop
export const DESIGN_LAYOUT_TAB = '    ';
// shrink-to-fit looks for the largest fitting size in hundredths, from the
// requested size down to the smallest document font size
export const DESIGN_LAYOUT_SHRINK_STEPS_PER_UNIT = 100;
export const DESIGN_LAYOUT_SHRINK_MIN_FONT_SIZE = 1;
// a font key is printable ASCII: no NUL, control character or surrogate
export const DESIGN_LAYOUT_FONT_KEY = /^[\x20-\x7e]{1,256}$/;
export const DESIGN_LAYOUT_IMAGE_SIZE_MAX = 32_768;
// 256 Mi pixels
export const DESIGN_LAYOUT_IMAGE_PIXELS_MAX = 268_435_456;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

// The font a text layer asks for after Brand Kit tokens are resolved. It is a
// request: the font provider decides whether it has exactly this font
export interface ContentStudioDesignFontSpec {
  family: string;
  weight: (typeof BRAND_FONT_WEIGHTS)[number];
  style: (typeof BRAND_FONT_STYLES)[number];
}

// One shaped glyph, in font units. Generic shaping values, not the classes
// of a font library:
// - id: the glyph index in the font, a non-negative integer;
// - cluster: the UTF-16 offset in the shaped text of the first character
//   this glyph stands for;
// - xAdvance: how far the pen moves after the glyph (kerning included);
// - yAdvance: must be 0, only horizontal text is laid out;
// - xOffset, yOffset: where the glyph is drawn from the pen, +y up as in
//   font coordinates
export interface ContentStudioDesignShapedGlyph {
  id: number;
  cluster: number;
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
}

// A resolved font. `key` names it within one layout (and the render that
// uses the layout); the renderer finds its glyph outlines by it. ascent and
// descent are font units (descent is usually negative). `shape` shapes one
// line of text in font units; the line width is the sum of the advances, so
// the font decides kerning and ligatures
export interface ContentStudioDesignFontMetrics {
  key: string;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  shape(text: string): { glyphs: ContentStudioDesignShapedGlyph[] };
}

// Returns the font or null when it does not have exactly this one. There is
// no fallback: an unavailable font fails the layout
export interface ContentStudioDesignFontProvider {
  resolveFont(
    font: ContentStudioDesignFontSpec
  ): ContentStudioDesignFontMetrics | null;
}

// The intrinsic size of one image, looked up by the Media id and the
// SHA-256 together, so another file under the same id is never used.
// Returns null when the image is not available
export interface ContentStudioDesignImageProvider {
  getImageMetadata(image: {
    mediaId: string;
    sha256: string;
  }): { width: number; height: number } | null;
}

// The exact Brand Kit revision the document names: its reference and its
// parsed content. Null exactly when the document names no Brand Kit
export interface ContentStudioDesignLayoutBrandContext {
  ref: ContentStudioDesignBrandKitRef;
  content: ContentStudioBrandKitContentV1;
}

export interface ContentStudioDesignLayoutInput {
  document: ContentStudioDesignDocumentV1;
  brandKit: ContentStudioDesignLayoutBrandContext | null;
  fonts: ContentStudioDesignFontProvider;
  images: ContentStudioDesignImageProvider;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface ContentStudioDesignLayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ContentStudioDesignLayoutPoint {
  x: number;
  y: number;
}

// What every item has. box is the layer box as stored; colors are #rrggbb
interface ContentStudioDesignLayoutItemBase {
  layerId: string;
  box: ContentStudioDesignLayoutRect;
  rotation: number;
  transformOrigin: ContentStudioDesignLayoutPoint;
  opacity: number;
}

export interface ContentStudioDesignLayoutRectangleItem
  extends ContentStudioDesignLayoutItemBase {
  type: 'rectangle';
  fill: string;
  // the stored radius limited to half the width and half the height
  cornerRadius: number;
}

export interface ContentStudioDesignLayoutEllipseItem
  extends ContentStudioDesignLayoutItemBase {
  type: 'ellipse';
  fill: string;
}

// sourceRect is in intrinsic image pixels and may be fractional;
// destinationRect is in page coordinates. The renderer draws sourceRect
// scaled into destinationRect, then rotates
export interface ContentStudioDesignLayoutImageItem
  extends ContentStudioDesignLayoutItemBase {
  type: 'image';
  imageRef: { mediaId: string; sha256: string };
  intrinsic: { width: number; height: number };
  fit: 'cover' | 'contain';
  sourceRect: ContentStudioDesignLayoutRect;
  destinationRect: ContentStudioDesignLayoutRect;
}

// A glyph placed on the page before rotation: x and y are where its origin
// goes (offsets applied), advance is its scaled advance
export interface ContentStudioDesignLayoutGlyph {
  id: number;
  cluster: number;
  x: number;
  y: number;
  advance: number;
}

// One line as laid out: its text (tabs expanded, wrap spaces left out), its
// left edge, its baseline and its width with letter spacing
export interface ContentStudioDesignLayoutLine {
  text: string;
  x: number;
  baselineY: number;
  width: number;
  glyphs: ContentStudioDesignLayoutGlyph[];
}

// Every line is laid out, also the ones outside the box; clipRect (the layer
// box) decides what is visible
export interface ContentStudioDesignLayoutTextItem
  extends ContentStudioDesignLayoutItemBase {
  type: 'text';
  clipRect: ContentStudioDesignLayoutRect;
  font: ContentStudioDesignFontSpec;
  fontKey: string;
  color: string;
  requestedFontSize: number;
  resolvedFontSize: number;
  lineHeight: number;
  letterSpacing: number;
  align: 'left' | 'center' | 'right';
  verticalAlign: 'top' | 'middle' | 'bottom';
  overflow: 'clip' | 'shrink';
  // every line inside the box, in both directions
  fits: boolean;
  lines: ContentStudioDesignLayoutLine[];
}

export type ContentStudioDesignLayoutItem =
  | ContentStudioDesignLayoutTextItem
  | ContentStudioDesignLayoutRectangleItem
  | ContentStudioDesignLayoutEllipseItem
  | ContentStudioDesignLayoutImageItem;

// A page in document order. items are its visible layers in z-order (first
// is at the back); hidden layers are not part of the render. clipRect is the
// page itself
export interface ContentStudioDesignLayoutPage {
  id: string;
  width: number;
  height: number;
  background: { type: 'solid'; color: string };
  clipRect: ContentStudioDesignLayoutRect;
  items: ContentStudioDesignLayoutItem[];
}

export interface ContentStudioDesignLayoutV1 {
  schemaVersion: 1;
  pages: ContentStudioDesignLayoutPage[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ContentStudioDesignLayoutErrorCode =
  | 'INVALID_INPUT'
  | 'BRAND_CONTEXT_MISSING'
  | 'BRAND_CONTEXT_MISMATCH'
  | 'BRAND_TOKEN_MISSING'
  | 'FONT_UNAVAILABLE'
  | 'FONT_METRICS_INVALID'
  | 'FONT_SHAPING_UNSUPPORTED'
  | 'IMAGE_UNAVAILABLE'
  | 'IMAGE_METADATA_INVALID';

const ERROR_MESSAGES: Record<ContentStudioDesignLayoutErrorCode, string> = {
  INVALID_INPUT: 'The design layout input is invalid.',
  BRAND_CONTEXT_MISSING: 'The design Brand Kit context is missing.',
  BRAND_CONTEXT_MISMATCH:
    'The design Brand Kit context does not match the design.',
  BRAND_TOKEN_MISSING: 'A design Brand Kit token is unavailable.',
  FONT_UNAVAILABLE: 'A design font is unavailable.',
  FONT_METRICS_INVALID: 'A design font returned invalid metrics.',
  FONT_SHAPING_UNSUPPORTED: 'A design font shaped text in an unsupported way.',
  IMAGE_UNAVAILABLE: 'A design image is unavailable.',
  IMAGE_METADATA_INVALID: 'A design image has invalid metadata.',
};

// Fixed messages and a code only: no text, token, Media id, font name or
// provider message ever ends up in an error
export class ContentStudioDesignLayoutError extends Error {
  constructor(readonly code: ContentStudioDesignLayoutErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ContentStudioDesignLayoutError';
  }
}

// A derived number for the output: -0 becomes 0
export const layoutNumber = (value: number) => (value === 0 ? 0 : value);

export const layoutRect = (
  x: number,
  y: number,
  width: number,
  height: number
): ContentStudioDesignLayoutRect => ({
  x: layoutNumber(x),
  y: layoutNumber(y),
  width: layoutNumber(width),
  height: layoutNumber(height),
});

// a <= limit, allowing for floating point
export const layoutFits = (value: number, limit: number) =>
  value <= limit + DESIGN_LAYOUT_EPSILON;

// The box, rotation origin and opacity every item copies from its layer
export const layoutItemGeometry = (layer: {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
}) => ({
  box: layoutRect(layer.x, layer.y, layer.width, layer.height),
  rotation: layoutNumber(layer.rotation),
  transformOrigin: {
    x: layoutNumber(layer.x + layer.width / 2),
    y: layoutNumber(layer.y + layer.height / 2),
  },
  opacity: layoutNumber(layer.opacity),
});

// Runs a font or image provider. Whatever it throws becomes the fixed error
// for that provider: its own message (a path, a file name, a font name)
// never passes. A layout error it throws is kept
export function callLayoutProvider<T>(
  call: () => T,
  code: ContentStudioDesignLayoutErrorCode
): T {
  try {
    return call();
  } catch (error) {
    if (error instanceof ContentStudioDesignLayoutError) {
      throw error;
    }
    throw new ContentStudioDesignLayoutError(code);
  }
}
