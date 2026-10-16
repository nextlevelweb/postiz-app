import { createHash } from 'crypto';
import type { ContentStudioDesignDocumentV1 } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import type {
  ContentStudioDesignFontSpec,
  ContentStudioDesignLayoutBrandContext,
} from '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout.types';

// The contract of the server design renderer: one page of a Design Document
// v1 becomes one PNG. Geometry comes only from the layout engine
// (design/layout); the renderer draws its display list. Fonts and images
// come only as bytes from trusted resolvers that the caller injects: the
// renderer opens no file, URL or system font. Output is deterministic for
// the same document, Brand Kit revision, font bytes and image bytes on the
// same Node, Sharp/libvips and fontkit versions

// the generated SVG, embedded images included, before rasterizing
export const DESIGN_RENDER_SVG_MAX_BYTES = 16_777_216;
export const DESIGN_RENDER_PNG_MAX_BYTES = 33_554_432;
export const DESIGN_RENDER_FONT_MAX_BYTES = 33_554_432;
export const DESIGN_RENDER_IMAGE_MAX_BYTES = 67_108_864;
export const DESIGN_RENDER_GLYPH_PATH_MAX = 1_048_576;
export const DESIGN_RENDER_SHA256 = /^[0-9a-f]{64}$/;

// A font file for exactly the requested family, weight and style. key names
// it within this render (printable ASCII, see the layout contract); sha256
// is the SHA-256 of the bytes. Only single TrueType or OpenType (CFF) fonts
export interface ContentStudioRenderFontAsset {
  key: string;
  bytes: Uint8Array;
  sha256: string;
}

// Returns null when it has no font for exactly this request: there is no
// fallback
export interface ContentStudioRenderFontResolver {
  resolveFont(
    font: ContentStudioDesignFontSpec
  ): ContentStudioRenderFontAsset | null;
}

// The original bytes of one image; sha256 must be the Design reference's
export interface ContentStudioRenderImageAsset {
  bytes: Uint8Array;
  sha256: string;
}

// Looked up by Media id and SHA-256 together. May answer asynchronously
export interface ContentStudioRenderImageResolver {
  resolveImage(image: {
    mediaId: string;
    sha256: string;
  }):
    | ContentStudioRenderImageAsset
    | null
    | Promise<ContentStudioRenderImageAsset | null>;
}

export interface ContentStudioDesignRenderInput {
  document: ContentStudioDesignDocumentV1;
  brandKit: ContentStudioDesignLayoutBrandContext | null;
  // the id of the page to render, exactly as in the document
  pageId: string;
  fonts: ContentStudioRenderFontResolver;
  images: ContentStudioRenderImageResolver;
}

// The assets this page was drawn with, in first-use order: the fonts by
// key and the SHA-256 of their bytes, the images by Media id and the
// SHA-256 of their original bytes. Fonts are not part of Design v1, so this
// is the only record of which font files a render used
export interface ContentStudioDesignRenderAssets {
  fonts: Array<{ key: string; sha256: string }>;
  images: Array<{ mediaId: string; sha256: string }>;
}

export interface ContentStudioDesignRenderResult {
  pageId: string;
  width: number;
  height: number;
  mimeType: 'image/png';
  bytes: Buffer;
  sha256: string;
  assets: ContentStudioDesignRenderAssets;
}

export type ContentStudioDesignRenderErrorCode =
  | 'INVALID_INPUT'
  | 'PAGE_NOT_FOUND'
  | 'BRAND_CONTEXT_ERROR'
  | 'FONT_ASSET_UNAVAILABLE'
  | 'FONT_ASSET_INVALID'
  | 'FONT_ASSET_INTEGRITY_ERROR'
  | 'FONT_ASSET_UNSUPPORTED'
  | 'FONT_SHAPING_UNSUPPORTED'
  | 'GLYPH_UNAVAILABLE'
  | 'IMAGE_ASSET_UNAVAILABLE'
  | 'IMAGE_ASSET_INVALID'
  | 'IMAGE_ASSET_INTEGRITY_ERROR'
  | 'IMAGE_ASSET_UNSUPPORTED'
  | 'LAYOUT_FAILED'
  | 'RENDER_OUTPUT_TOO_LARGE'
  | 'RENDER_FAILED';

const ERROR_MESSAGES: Record<ContentStudioDesignRenderErrorCode, string> = {
  INVALID_INPUT: 'The design render input is invalid.',
  PAGE_NOT_FOUND: 'The design page is not available.',
  BRAND_CONTEXT_ERROR: 'The design Brand Kit context could not be rendered.',
  FONT_ASSET_UNAVAILABLE: 'A design font is unavailable.',
  FONT_ASSET_INVALID: 'A design font file is invalid.',
  FONT_ASSET_INTEGRITY_ERROR: 'A design font file failed its integrity check.',
  FONT_ASSET_UNSUPPORTED: 'A design font file is not supported.',
  FONT_SHAPING_UNSUPPORTED: 'A design text could not be shaped.',
  GLYPH_UNAVAILABLE: 'A design glyph is unavailable.',
  IMAGE_ASSET_UNAVAILABLE: 'A design image is unavailable.',
  IMAGE_ASSET_INVALID: 'A design image file is invalid.',
  IMAGE_ASSET_INTEGRITY_ERROR: 'A design image failed its integrity check.',
  IMAGE_ASSET_UNSUPPORTED: 'A design image format is not supported.',
  LAYOUT_FAILED: 'The design could not be laid out.',
  RENDER_OUTPUT_TOO_LARGE: 'The rendered design is larger than allowed.',
  RENDER_FAILED: 'The design could not be rendered.',
};

// Fixed messages and a code only: no Media id, font name, key, hash, path or
// message from fontkit, Sharp or a resolver ever ends up in an error
export class ContentStudioDesignRenderError extends Error {
  constructor(readonly code: ContentStudioDesignRenderErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ContentStudioDesignRenderError';
  }
}

// The SHA-256 of exact bytes, lowercase hex
export const designRenderSha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

// Font and image files: a non-empty Uint8Array (a Buffer is one) within the
// limit, with a lowercase SHA-256. The bytes are copied, so the caller's
// array is neither kept nor changed
export function designRenderAssetBytes(
  asset: unknown,
  max: number,
  invalid: ContentStudioDesignRenderErrorCode
) {
  let bytes: unknown;
  let sha256: unknown;
  try {
    if (typeof asset !== 'object' || asset === null) {
      throw new Error();
    }
    ({ bytes, sha256 } = asset as Record<string, unknown>);
  } catch {
    throw new ContentStudioDesignRenderError(invalid);
  }
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length === 0 ||
    bytes.length > max ||
    typeof sha256 !== 'string' ||
    !DESIGN_RENDER_SHA256.test(sha256)
  ) {
    throw new ContentStudioDesignRenderError(invalid);
  }
  return { bytes: Buffer.from(bytes), sha256 };
}
