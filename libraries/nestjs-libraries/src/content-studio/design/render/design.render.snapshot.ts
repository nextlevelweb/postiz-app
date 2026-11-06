import { z } from 'zod';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  isPlainData,
  trimmedText,
  utf8ByteLength,
} from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';
import {
  BRAND_FONT_STYLES,
  BRAND_FONT_WEIGHTS,
  ContentStudioBrandKitContentV1,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import {
  ContentStudioDesignDocumentV1,
  DESIGN_FONT_FAMILY_MAX,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { ContentStudioDesignFontSpec } from '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout.types';
import { ContentStudioDesignRenderError } from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.types';
import {
  CONTENT_STUDIO_DEFAULT_RENDER_FONT_IDS,
  ContentStudioDefaultRenderFontId,
} from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.default.font';

// What a stored render records about its inputs, beside the exact design and
// Brand Kit revision: the renderer and layout contract it ran under and the
// asset snapshot, the exact fonts and images the rendered page was drawn
// with. Fonts are the immutable font assets the organization's mappings
// pointed to at that moment (the mapping id is kept for audit only: a later
// mapping change does not change what a render used), or the bundled default
// font that drew a family without an enabled mapping, images the Media ids
// and SHA-256s of the design. Ids, semantics and hashes only: never bytes,
// URLs, storage keys or file names. Stored as canonical JSON with its SHA-256

export const CONTENT_STUDIO_LAYOUT_VERSION = 'content-studio-layout-v1';
export const CONTENT_STUDIO_RENDERER_VERSION = 'content-studio-renderer-v1';

export const RENDER_ASSET_SNAPSHOT_SCHEMA_VERSION = 1;
export const RENDER_ASSET_SNAPSHOT_FONTS_MAX = 200;
export const RENDER_ASSET_SNAPSHOT_IMAGES_MAX = 200;
export const RENDER_ASSET_SNAPSHOT_MAX_BYTES = 65_536;

const LOWER_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// the Design Document image rule (the Content Package media id rule)
const MEDIA_ID = /^[A-Za-z0-9_-]{1,64}$/;

// the tuple the design asked for and the SHA-256 of the bytes that drew it
const fontRequest = {
  family: trimmedText(DESIGN_FONT_FAMILY_MAX, 1),
  weight: z
    .number()
    .refine(
      (weight) => (BRAND_FONT_WEIGHTS as readonly number[]).includes(weight),
      'Unsupported weight'
    ),
  style: z.enum(BRAND_FONT_STYLES),
  sha256: z.string().regex(SHA256_HEX),
};
const mappedFontEntry = z
  .object({
    mappingId: z.string().regex(LOWER_UUID),
    fontAssetId: z.string().regex(LOWER_UUID),
    ...fontRequest,
  })
  .strict();
const defaultFontEntry = z
  .object({
    defaultFontId: z.enum(
      CONTENT_STUDIO_DEFAULT_RENDER_FONT_IDS as [
        ContentStudioDefaultRenderFontId,
        ...ContentStudioDefaultRenderFontId[]
      ]
    ),
    ...fontRequest,
  })
  .strict();
const fontEntry = z.union([mappedFontEntry, defaultFontEntry]);

const imageEntry = z
  .object({
    mediaId: z.string().regex(MEDIA_ID),
    sha256: z.string().regex(SHA256_HEX),
  })
  .strict();

const snapshotSchema = z
  .object({
    schemaVersion: z.literal(RENDER_ASSET_SNAPSHOT_SCHEMA_VERSION),
    fonts: z.array(fontEntry).max(RENDER_ASSET_SNAPSHOT_FONTS_MAX),
    images: z.array(imageEntry).max(RENDER_ASSET_SNAPSHOT_IMAGES_MAX),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const issue = (path: Array<string | number>) =>
      context.addIssue({ code: z.ZodIssueCode.custom, path });
    const mappings = new Set<string>();
    const assets = new Set<string>();
    const tuples = new Set<string>();
    // a bundled default font may draw several tuples; a mapping and its
    // asset draw one
    snapshot.fonts.forEach((font, index) => {
      const tuple = JSON.stringify([font.family, font.weight, font.style]);
      if (
        tuples.has(tuple) ||
        ('mappingId' in font &&
          (mappings.has(font.mappingId) || assets.has(font.fontAssetId)))
      ) {
        issue(['fonts', index]);
      }
      if ('mappingId' in font) {
        mappings.add(font.mappingId);
        assets.add(font.fontAssetId);
      }
      tuples.add(tuple);
    });
    // the same Media id with another SHA-256 is another image
    const images = new Set<string>();
    snapshot.images.forEach((image, index) => {
      const pair = JSON.stringify([image.mediaId, image.sha256]);
      if (images.has(pair)) {
        issue(['images', index]);
      }
      images.add(pair);
    });
  });

interface ContentStudioRenderAssetSnapshotFontRequest {
  family: string;
  weight: (typeof BRAND_FONT_WEIGHTS)[number];
  style: (typeof BRAND_FONT_STYLES)[number];
  sha256: string;
}

export type ContentStudioRenderAssetSnapshotFont =
  | (ContentStudioRenderAssetSnapshotFontRequest & {
      mappingId: string;
      fontAssetId: string;
    })
  | (ContentStudioRenderAssetSnapshotFontRequest & {
      defaultFontId: ContentStudioDefaultRenderFontId;
    });

export interface ContentStudioRenderAssetSnapshotV1 {
  schemaVersion: 1;
  fonts: ContentStudioRenderAssetSnapshotFont[];
  images: Array<{ mediaId: string; sha256: string }>;
}

// Fixed messages only: never an id, family or hash
export class ContentStudioRenderAssetSnapshotError extends Error {
  constructor() {
    super('The render asset snapshot is invalid');
    this.name = 'ContentStudioRenderAssetSnapshotError';
  }
}

export class ContentStudioRenderSnapshotIntegrityError extends Error {
  constructor() {
    super('A stored render asset snapshot failed its integrity check');
    this.name = 'ContentStudioRenderSnapshotIntegrityError';
  }
}

// Validates an asset snapshot into a new object, as given: no entry is
// dropped, merged, sorted or repaired, and arrays keep their (first-use)
// order. The canonical JSON must fit 64 KiB
export function parseContentStudioRenderAssetSnapshot(
  input: unknown
): ContentStudioRenderAssetSnapshotV1 {
  if (!isPlainData(input)) {
    throw new ContentStudioRenderAssetSnapshotError();
  }
  const result = snapshotSchema.safeParse(input);
  if (!result.success) {
    throw new ContentStudioRenderAssetSnapshotError();
  }
  const snapshot = result.data as ContentStudioRenderAssetSnapshotV1;
  if (
    utf8ByteLength(canonicalJson(snapshot)) > RENDER_ASSET_SNAPSHOT_MAX_BYTES
  ) {
    throw new ContentStudioRenderAssetSnapshotError();
  }
  return snapshot;
}

// What a render stores: the canonical JSON text of a parsed snapshot and the
// SHA-256 of exactly that text. Keys are sorted, arrays are not: another
// order is another snapshot with another hash
export function storedContentStudioRenderAssetSnapshot(input: unknown) {
  const snapshot = parseContentStudioRenderAssetSnapshot(input);
  const text = canonicalJson(snapshot);
  return {
    snapshot,
    assetSnapshot: text,
    assetSnapshotHash: sha256Hex(text),
  };
}

// Reads a stored snapshot back and proves it is still exactly what was
// written: valid, canonical and matching its hash. Anything else throws;
// nothing is repaired
export function parseVerifiedContentStudioRenderAssetSnapshot(stored: {
  assetSnapshot: string;
  assetSnapshotHash: string;
}): ContentStudioRenderAssetSnapshotV1 {
  let snapshot: ContentStudioRenderAssetSnapshotV1;
  try {
    snapshot = parseContentStudioRenderAssetSnapshot(
      JSON.parse(stored.assetSnapshot)
    );
  } catch {
    throw new ContentStudioRenderSnapshotIntegrityError();
  }
  if (
    canonicalJson(snapshot) !== stored.assetSnapshot ||
    sha256Hex(stored.assetSnapshot) !== stored.assetSnapshotHash
  ) {
    throw new ContentStudioRenderSnapshotIntegrityError();
  }
  return snapshot;
}

// The fonts a render of this design asks its font resolver for, each once,
// in the order the layout engine asks: every visible text layer of every
// page (the renderer lays out the whole document), page by page and layer by
// layer, a family as written and a Brand Kit type style as that exact
// revision defines it. Hidden layers ask for nothing. This is dependency
// collection only (no layout): it lets the fonts be loaded before the
// synchronous render. A type style the Brand Kit revision does not have, or
// a token without a Brand Kit, is BRAND_CONTEXT_ERROR
export function collectContentStudioDesignRenderFontRequests(
  document: ContentStudioDesignDocumentV1,
  brandKit: ContentStudioBrandKitContentV1 | null
): ContentStudioDesignFontSpec[] {
  const typography = new Map(
    (brandKit?.typography ?? []).map((token) => [token.id, token])
  );
  const requests = new Map<string, ContentStudioDesignFontSpec>();
  for (const page of document.pages) {
    for (const layer of page.layers) {
      if (layer.type !== 'text' || !layer.visible) {
        continue;
      }
      let font: ContentStudioDesignFontSpec;
      if (layer.font.type === 'family') {
        font = layer.font;
      } else {
        const token = typography.get(layer.font.tokenId);
        if (!token) {
          throw new ContentStudioDesignRenderError('BRAND_CONTEXT_ERROR');
        }
        font = token;
      }
      const request = JSON.stringify([font.family, font.weight, font.style]);
      if (!requests.has(request)) {
        requests.set(request, {
          family: font.family,
          weight: font.weight,
          style: font.style,
        });
      }
    }
  }
  return Array.from(requests.values());
}

// The images a render of this design asks its image resolver for, each
// exact Media id and SHA-256 once, in the order the layout engine meets them:
// every visible image layer of every page, page by page and layer by layer.
// Hidden layers ask for nothing; the same Media id with another SHA-256 is
// another image. Dependency collection only (no layout): it lets a render of
// every page load each image once, before the first page
export function collectContentStudioDesignRenderImageRequests(
  document: ContentStudioDesignDocumentV1
): Array<{ mediaId: string; sha256: string }> {
  const requests = new Map<string, { mediaId: string; sha256: string }>();
  for (const page of document.pages) {
    for (const layer of page.layers) {
      if (layer.type !== 'image' || !layer.visible) {
        continue;
      }
      const request = JSON.stringify([
        layer.imageRef.mediaId,
        layer.imageRef.sha256,
      ]);
      if (!requests.has(request)) {
        requests.set(request, {
          mediaId: layer.imageRef.mediaId,
          sha256: layer.imageRef.sha256,
        });
      }
    }
  }
  return Array.from(requests.values());
}

// What a render of every page may hold in memory at once: the original
// bytes of every font and image it loads up front, 256 MiB in all
export const CONTENT_STUDIO_RENDER_BATCH_ASSET_MAX_BYTES = 268_435_456;

// Counts each asset once, by its identity (a font asset id, a Media id with
// its SHA-256): add() answers false as soon as the total is over the limit
export function contentStudioRenderBatchAssetBudget(
  max = CONTENT_STUDIO_RENDER_BATCH_ASSET_MAX_BYTES
) {
  const counted = new Set<string>();
  let total = 0;
  return {
    add(asset: string, byteSize: number) {
      if (!counted.has(asset)) {
        counted.add(asset);
        total += byteSize;
      }
      return total <= max;
    },
    total: () => total,
  };
}
