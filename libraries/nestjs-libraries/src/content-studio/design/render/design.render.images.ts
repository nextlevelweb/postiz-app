import sharp from 'sharp';
import type { OutputInfo } from 'sharp';
import {
  DESIGN_LAYOUT_IMAGE_PIXELS_MAX,
  DESIGN_LAYOUT_IMAGE_SIZE_MAX,
} from '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout.types';
import {
  ContentStudioDesignRenderError,
  ContentStudioDesignRenderErrorCode,
  ContentStudioRenderImageResolver,
  DESIGN_RENDER_IMAGE_MAX_BYTES,
  designRenderAssetBytes,
  designRenderSha256,
} from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.types';

// Images for one render. Each image is resolved once by Media id and
// SHA-256, its original bytes must hash to the Design's SHA-256, and only a
// single-frame PNG, JPEG or WebP is decoded (no SVG, GIF, TIFF, HEIF or
// PDF, nothing animated). It is then normalized once: EXIF orientation
// applied, converted to sRGB, re-encoded as PNG with alpha kept. The
// intrinsic size the layout engine receives is the size of that normalized
// image (after orientation), and the SVG embeds exactly those pixels, so
// the layout and the drawing use the same image by construction

export const DESIGN_RENDER_IMAGE_FORMATS = ['png', 'jpeg', 'webp'] as const;

// fixed PNG settings for the internal normalized image and the page
export const DESIGN_RENDER_PNG_OPTIONS = {
  compressionLevel: 9,
  adaptiveFiltering: false,
  palette: false,
} as const;

export interface ContentStudioDesignRenderImage {
  mediaId: string;
  sha256: string;
  width: number;
  height: number;
  // the normalized image: sRGB PNG, never stored
  png: Buffer;
}

// The layout engine asks for sizes synchronously while Sharp decodes
// asynchronously. An image the registry has not loaded yet gets this
// placeholder size and is recorded as pending; the renderer loads the
// pending images and lays the document out again, so a finished layout only
// ever uses real sizes
const PLACEHOLDER = { width: 1, height: 1 };

const lookupOf = (image: { mediaId: string; sha256: string }) =>
  JSON.stringify([image.mediaId, image.sha256]);

export function contentStudioDesignRenderImages(
  resolver: ContentStudioRenderImageResolver
) {
  const images = new Map<
    string,
    ContentStudioDesignRenderImage | ContentStudioDesignRenderErrorCode
  >();
  let pending: Array<{ mediaId: string; sha256: string }> = [];

  const decode = async (ref: { mediaId: string; sha256: string }) => {
    let asset: unknown;
    try {
      asset = await resolver.resolveImage({
        mediaId: ref.mediaId,
        sha256: ref.sha256,
      });
    } catch {
      throw new ContentStudioDesignRenderError('IMAGE_ASSET_UNAVAILABLE');
    }
    if (asset === null || asset === undefined) {
      throw new ContentStudioDesignRenderError('IMAGE_ASSET_UNAVAILABLE');
    }
    const { bytes, sha256 } = designRenderAssetBytes(
      asset,
      DESIGN_RENDER_IMAGE_MAX_BYTES,
      'IMAGE_ASSET_INVALID'
    );
    // the bytes are the ones the Design names, and the resolver agrees
    if (sha256 !== ref.sha256 || designRenderSha256(bytes) !== ref.sha256) {
      throw new ContentStudioDesignRenderError('IMAGE_ASSET_INTEGRITY_ERROR');
    }
    let format: string | undefined;
    let pages: number | undefined;
    try {
      ({ format, pages } = await sharp(bytes).metadata());
    } catch {
      throw new ContentStudioDesignRenderError('IMAGE_ASSET_INVALID');
    }
    if (
      !(DESIGN_RENDER_IMAGE_FORMATS as readonly string[]).includes(
        format as string
      ) ||
      (pages ?? 1) !== 1
    ) {
      throw new ContentStudioDesignRenderError('IMAGE_ASSET_UNSUPPORTED');
    }
    let normalized: { data: Buffer; info: OutputInfo };
    try {
      normalized = await sharp(bytes)
        .rotate()
        .toColourspace('srgb')
        .png(DESIGN_RENDER_PNG_OPTIONS)
        .toBuffer({ resolveWithObject: true });
    } catch {
      throw new ContentStudioDesignRenderError('IMAGE_ASSET_INVALID');
    }
    const { width, height } = normalized.info;
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > DESIGN_LAYOUT_IMAGE_SIZE_MAX ||
      height > DESIGN_LAYOUT_IMAGE_SIZE_MAX ||
      width * height > DESIGN_LAYOUT_IMAGE_PIXELS_MAX
    ) {
      throw new ContentStudioDesignRenderError('IMAGE_ASSET_INVALID');
    }
    return {
      mediaId: ref.mediaId,
      sha256: ref.sha256,
      width,
      height,
      png: normalized.data,
    };
  };

  return {
    // the layout engine's image provider
    provider: {
      getImageMetadata(image: { mediaId: string; sha256: string }) {
        const known = images.get(lookupOf(image));
        if (typeof known === 'string') {
          throw new ContentStudioDesignRenderError(known);
        }
        if (known) {
          return { width: known.width, height: known.height };
        }
        pending.push({ mediaId: image.mediaId, sha256: image.sha256 });
        return { ...PLACEHOLDER };
      },
    },
    // the images the last layout asked for and that are not loaded yet
    takePending() {
      const taken = pending;
      pending = [];
      return taken;
    },
    async load(ref: { mediaId: string; sha256: string }) {
      const lookup = lookupOf(ref);
      if (images.has(lookup)) {
        return;
      }
      try {
        images.set(lookup, await decode(ref));
      } catch (error) {
        const code =
          error instanceof ContentStudioDesignRenderError
            ? error.code
            : 'IMAGE_ASSET_INVALID';
        images.set(lookup, code);
        throw new ContentStudioDesignRenderError(code);
      }
    },
    image(ref: { mediaId: string; sha256: string }) {
      const image = images.get(lookupOf(ref));
      if (!image || typeof image === 'string') {
        throw new ContentStudioDesignRenderError('RENDER_FAILED');
      }
      return image;
    },
  };
}
