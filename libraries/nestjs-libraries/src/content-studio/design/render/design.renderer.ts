import sharp from 'sharp';
import type { OutputInfo } from 'sharp';
import { layoutContentStudioDesign } from '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout';
import {
  ContentStudioDesignLayoutError,
  ContentStudioDesignLayoutPage,
  ContentStudioDesignLayoutV1,
} from '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout.types';
import { contentStudioDesignRenderFonts } from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.fonts';
import {
  contentStudioDesignRenderImages,
  DESIGN_RENDER_PNG_OPTIONS,
} from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.images';
import { buildContentStudioDesignPageSvg } from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.svg';
import {
  ContentStudioDesignRenderAssets,
  ContentStudioDesignRenderError,
  ContentStudioDesignRenderErrorCode,
  ContentStudioDesignRenderInput,
  ContentStudioDesignRenderResult,
  DESIGN_RENDER_PNG_MAX_BYTES,
  designRenderSha256,
} from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.types';

// The server design renderer: one page of a design to one PNG. The whole
// document is laid out by the layout engine (the only layout authority, with
// its own Brand Kit, token and document checks), the requested page is
// picked from that layout, drawn as SVG and rasterized by Sharp. Fonts and
// images come only from the injected resolvers, each resolved once per
// render; nothing is logged, cached across renders, fetched or read from
// disk. Not a Nest provider and not reachable over HTTP yet

const LAYOUT_ERRORS: Partial<
  Record<
    ContentStudioDesignLayoutError['code'],
    ContentStudioDesignRenderErrorCode
  >
> = {
  BRAND_CONTEXT_MISSING: 'BRAND_CONTEXT_ERROR',
  BRAND_CONTEXT_MISMATCH: 'BRAND_CONTEXT_ERROR',
  BRAND_TOKEN_MISSING: 'BRAND_CONTEXT_ERROR',
  FONT_UNAVAILABLE: 'FONT_ASSET_UNAVAILABLE',
  FONT_METRICS_INVALID: 'FONT_ASSET_INVALID',
  FONT_SHAPING_UNSUPPORTED: 'FONT_SHAPING_UNSUPPORTED',
  IMAGE_UNAVAILABLE: 'IMAGE_ASSET_UNAVAILABLE',
  IMAGE_METADATA_INVALID: 'IMAGE_ASSET_INVALID',
};

// The rendered page as an sRGB PNG of exactly the page size, without alpha
// or metadata. Whatever Sharp throws becomes RENDER_FAILED. The SVG is the
// renderer's own, already size-limited, so libxml's size guard is lifted
// for it (embedded images are long attributes)
export async function rasterizeContentStudioDesignSvg(
  svg: string,
  width: number,
  height: number
): Promise<Buffer> {
  let output: { data: Buffer; info: OutputInfo };
  try {
    output = await sharp(Buffer.from(svg, 'utf8'), {
      density: 72,
      unlimited: true,
    })
      .removeAlpha()
      .toColourspace('srgb')
      .png(DESIGN_RENDER_PNG_OPTIONS)
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new ContentStudioDesignRenderError('RENDER_FAILED');
  }
  if (
    output.info.format !== 'png' ||
    output.info.width !== width ||
    output.info.height !== height
  ) {
    throw new ContentStudioDesignRenderError('RENDER_FAILED');
  }
  return output.data;
}

export function assertContentStudioDesignRenderOutputSize(png: Buffer) {
  if (png.length > DESIGN_RENDER_PNG_MAX_BYTES) {
    throw new ContentStudioDesignRenderError('RENDER_OUTPUT_TOO_LARGE');
  }
}

// The fonts and images the page's items use, each once, in first-use order
function pageAssets(
  page: ContentStudioDesignLayoutPage,
  fontSha256: (key: string) => string
): ContentStudioDesignRenderAssets {
  const fonts = new Map<string, { key: string; sha256: string }>();
  const images = new Map<string, { mediaId: string; sha256: string }>();
  for (const item of page.items) {
    if (item.type === 'text' && !fonts.has(item.fontKey)) {
      fonts.set(item.fontKey, {
        key: item.fontKey,
        sha256: fontSha256(item.fontKey),
      });
    }
    if (item.type === 'image') {
      const lookup = JSON.stringify([
        item.imageRef.mediaId,
        item.imageRef.sha256,
      ]);
      if (!images.has(lookup)) {
        images.set(lookup, {
          mediaId: item.imageRef.mediaId,
          sha256: item.imageRef.sha256,
        });
      }
    }
  }
  return {
    fonts: Array.from(fonts.values()),
    images: Array.from(images.values()),
  };
}

// Lays the document out and builds the SVG of the requested page, with the
// assets it uses. A renderer intermediate, exported for tests: the SVG is
// never stored or returned by an API
export async function renderContentStudioDesignPageSvg(
  input: ContentStudioDesignRenderInput
): Promise<{
  page: ContentStudioDesignLayoutPage;
  svg: string;
  assets: ContentStudioDesignRenderAssets;
}> {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    typeof input.pageId !== 'string' ||
    typeof input.fonts?.resolveFont !== 'function' ||
    typeof input.images?.resolveImage !== 'function'
  ) {
    throw new ContentStudioDesignRenderError('INVALID_INPUT');
  }
  const fonts = contentStudioDesignRenderFonts(input.fonts);
  const images = contentStudioDesignRenderImages(input.images);

  // Laid out until every image the layout asks for is loaded (see the image
  // registry). Each pass asks for the same things in the same order, so a
  // failure is reported where the layout meets it: an image that fails to
  // load comes before anything the layout would have met after it
  let layout: ContentStudioDesignLayoutV1 | null = null;
  for (;;) {
    let failed: unknown = null;
    try {
      layout = layoutContentStudioDesign({
        document: input.document,
        brandKit: input.brandKit,
        fonts: fonts.provider,
        images: images.provider,
      });
    } catch (error) {
      failed = error ?? new Error();
    }
    const pending = images.takePending();
    if (pending.length === 0) {
      if (failed) {
        const recorded = fonts.failure();
        if (recorded) {
          throw new ContentStudioDesignRenderError(recorded);
        }
        if (failed instanceof ContentStudioDesignRenderError) {
          throw failed;
        }
        throw new ContentStudioDesignRenderError(
          (failed instanceof ContentStudioDesignLayoutError &&
            LAYOUT_ERRORS[failed.code]) ||
            'LAYOUT_FAILED'
        );
      }
      break;
    }
    for (const ref of pending) {
      await images.load(ref);
    }
  }

  const page = (layout as ContentStudioDesignLayoutV1).pages.find(
    (entry) => entry.id === input.pageId
  );
  if (!page) {
    throw new ContentStudioDesignRenderError('PAGE_NOT_FOUND');
  }
  const svg = buildContentStudioDesignPageSvg(page, {
    font: (key) => fonts.font(key),
    image: (ref) => images.image(ref),
  });
  return {
    page,
    svg,
    assets: pageAssets(page, (key) => fonts.font(key).sha256),
  };
}

export async function renderContentStudioDesignPage(
  input: ContentStudioDesignRenderInput
): Promise<ContentStudioDesignRenderResult> {
  const { page, svg, assets } = await renderContentStudioDesignPageSvg(input);
  const png = await rasterizeContentStudioDesignSvg(
    svg,
    page.width,
    page.height
  );
  assertContentStudioDesignRenderOutputSize(png);
  return {
    pageId: page.id,
    width: page.width,
    height: page.height,
    mimeType: 'image/png',
    bytes: png,
    sha256: designRenderSha256(png),
    assets,
  };
}
