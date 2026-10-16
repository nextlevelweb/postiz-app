import {
  ContentStudioBrandKitContentV1,
  parseContentStudioBrandKitContent,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import {
  ContentStudioDesignBrandKitRef,
  ContentStudioDesignColorValue,
  ContentStudioDesignDocumentV1,
  ContentStudioDesignFontRef,
  ContentStudioDesignImageLayer,
  ContentStudioDesignLayer,
  ContentStudioDesignShapeLayer,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  callLayoutProvider,
  ContentStudioDesignFontSpec,
  ContentStudioDesignImageProvider,
  ContentStudioDesignLayoutError,
  ContentStudioDesignLayoutImageItem,
  ContentStudioDesignLayoutInput,
  ContentStudioDesignLayoutItem,
  ContentStudioDesignLayoutRect,
  ContentStudioDesignLayoutV1,
  ContentStudioDesignFontProvider,
  DESIGN_LAYOUT_IMAGE_PIXELS_MAX,
  DESIGN_LAYOUT_IMAGE_SIZE_MAX,
  DESIGN_LAYOUT_SCHEMA_VERSION,
  layoutItemGeometry,
  layoutNumber,
  layoutRect,
} from '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout.types';
import {
  ContentStudioDesignLayoutFont,
  contentStudioDesignLayoutFont,
  layoutContentStudioDesignText,
} from '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout.text';

// The design layout engine: one Design Document v1, the exact Brand Kit
// revision it names, and fonts and image sizes resolved by the caller become
// the display list a renderer draws (see design.layout.types). It is pure and
// synchronous: no database, network, file, clock, randomness or environment,
// and the providers are asked in page and layer order. Hidden layers are left
// out entirely, so their fonts, images and tokens are not needed. Nothing is
// a fallback: a missing token, font or image fails with a fixed error.
// The same input gives the same output, value for value

const BRAND_REF_KEYS: Array<keyof ContentStudioDesignBrandKitRef> = [
  'brandKitId',
  'revisionId',
  'revisionNumber',
  'contentHash',
];

const fail = (code: ContentStudioDesignLayoutError['code']) =>
  new ContentStudioDesignLayoutError(code);

// The Brand Kit content to resolve tokens from, for the revision the
// document names: the reference is the document's exactly (kit, revision,
// number and content hash) and the content is a valid Brand Kit v1. The
// tokens are read from the parsed copy, never from the caller's object.
// Whether the content is the stored revision's (its bytes against that
// hash) is proven by whoever read it from storage, before the layout: the
// server reads it with parseVerifiedContentStudioBrandKitRevision, a browser
// gets it from that server. The engine hashes nothing, so it needs no Node
// module and runs in a browser as well
function brandContent(
  ref: ContentStudioDesignBrandKitRef | null,
  context: unknown
): ContentStudioBrandKitContentV1 | null {
  if (ref === null) {
    if (context !== null) {
      throw fail('BRAND_CONTEXT_MISMATCH');
    }
    return null;
  }
  if (context === null) {
    throw fail('BRAND_CONTEXT_MISSING');
  }
  if (typeof context !== 'object') {
    throw fail('INVALID_INPUT');
  }
  const given = (context as { ref?: unknown }).ref;
  if (
    typeof given !== 'object' ||
    given === null ||
    Object.keys(given).length !== BRAND_REF_KEYS.length ||
    BRAND_REF_KEYS.some(
      (key) => (given as Record<string, unknown>)[key] !== ref[key]
    )
  ) {
    throw fail('BRAND_CONTEXT_MISMATCH');
  }
  try {
    return parseContentStudioBrandKitContent(
      (context as { content?: unknown }).content
    );
  } catch {
    throw fail('BRAND_CONTEXT_MISMATCH');
  }
}

// Each font is resolved once per layout, by family, weight and style. A font
// key names one font: two different requests resolving to the same key
// would let the renderer draw one with the other's outlines
function fontResolver(provider: ContentStudioDesignFontProvider) {
  const fonts = new Map<string, ContentStudioDesignLayoutFont>();
  const requests = new Map<string, string>();
  return (font: ContentStudioDesignFontSpec) => {
    const request = JSON.stringify([font.family, font.weight, font.style]);
    const known = fonts.get(request);
    if (known) {
      return known;
    }
    const metrics = callLayoutProvider(
      () =>
        provider.resolveFont({
          family: font.family,
          weight: font.weight,
          style: font.style,
        }),
      'FONT_UNAVAILABLE'
    );
    if (metrics === null || metrics === undefined) {
      throw fail('FONT_UNAVAILABLE');
    }
    const resolved = contentStudioDesignLayoutFont(metrics);
    const owner = requests.get(resolved.key);
    if (owner !== undefined && owner !== request) {
      throw fail('FONT_METRICS_INVALID');
    }
    requests.set(resolved.key, request);
    fonts.set(request, resolved);
    return resolved;
  };
}

const isImageSize = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 1 &&
  (value as number) <= DESIGN_LAYOUT_IMAGE_SIZE_MAX;

// Each image is looked up once per layout, by Media id and SHA-256 together
function imageResolver(provider: ContentStudioDesignImageProvider) {
  const images = new Map<string, { width: number; height: number }>();
  return (image: { mediaId: string; sha256: string }) => {
    const lookup = JSON.stringify([image.mediaId, image.sha256]);
    const known = images.get(lookup);
    if (known) {
      return known;
    }
    const metadata = callLayoutProvider(
      () =>
        provider.getImageMetadata({
          mediaId: image.mediaId,
          sha256: image.sha256,
        }),
      'IMAGE_UNAVAILABLE'
    );
    if (metadata === null || metadata === undefined) {
      throw fail('IMAGE_UNAVAILABLE');
    }
    const size = callLayoutProvider(() => {
      if (typeof metadata !== 'object') {
        return null;
      }
      const { width, height } = metadata as Record<string, unknown>;
      return { width, height };
    }, 'IMAGE_METADATA_INVALID');
    if (
      !size ||
      !isImageSize(size.width) ||
      !isImageSize(size.height) ||
      size.width * size.height > DESIGN_LAYOUT_IMAGE_PIXELS_MAX
    ) {
      throw fail('IMAGE_METADATA_INVALID');
    }
    const intrinsic = { width: size.width, height: size.height };
    images.set(lookup, intrinsic);
    return intrinsic;
  };
}

// The crop and placement of an image in its box, before rotation.
// contain: the whole image (sourceRect is all of it), as large as fits,
// centered; the rest of the box stays empty. The focal point plays no part.
// cover: the box is filled exactly; the image is cut to the box's aspect
// ratio, across when it is wider, down when it is taller, centered on the
// focal point as far as the image edges allow. Crops stay fractional: the
// renderer decides how to sample pixels
export function layoutContentStudioDesignImageGeometry(
  box: ContentStudioDesignLayoutRect,
  intrinsic: { width: number; height: number },
  fit: 'cover' | 'contain',
  focalPoint: { x: number; y: number }
) {
  const { width: imageWidth, height: imageHeight } = intrinsic;
  if (fit === 'contain') {
    // width-limited when box.width / imageWidth <= box.height / imageHeight
    const widthLimited = box.width * imageHeight <= box.height * imageWidth;
    const width = widthLimited
      ? box.width
      : (box.height * imageWidth) / imageHeight;
    const height = widthLimited
      ? (box.width * imageHeight) / imageWidth
      : box.height;
    return {
      sourceRect: layoutRect(0, 0, imageWidth, imageHeight),
      destinationRect: layoutRect(
        box.x + (box.width - width) / 2,
        box.y + (box.height - height) / 2,
        width,
        height
      ),
    };
  }
  const clamp = (value: number, max: number) =>
    Math.min(Math.max(value, 0), max);
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = imageWidth;
  let sourceHeight = imageHeight;
  if (imageWidth * box.height > box.width * imageHeight) {
    sourceWidth = Math.min(imageWidth, (imageHeight * box.width) / box.height);
    sourceX = clamp(
      focalPoint.x * imageWidth - sourceWidth / 2,
      imageWidth - sourceWidth
    );
  } else if (imageWidth * box.height < box.width * imageHeight) {
    sourceHeight = Math.min(imageHeight, (imageWidth * box.height) / box.width);
    sourceY = clamp(
      focalPoint.y * imageHeight - sourceHeight / 2,
      imageHeight - sourceHeight
    );
  }
  return {
    sourceRect: layoutRect(sourceX, sourceY, sourceWidth, sourceHeight),
    destinationRect: layoutRect(box.x, box.y, box.width, box.height),
  };
}

// The input is checked at this boundary: the document is parsed again (a
// new, normalized copy), the providers must be callable and the Brand Kit
// context must be given, null included
function checkedInput(input: ContentStudioDesignLayoutInput) {
  if (typeof input !== 'object' || input === null) {
    throw fail('INVALID_INPUT');
  }
  let document: ContentStudioDesignDocumentV1;
  try {
    document = parseContentStudioDesignDocument(input.document);
  } catch {
    throw fail('INVALID_INPUT');
  }
  if (
    typeof input.fonts?.resolveFont !== 'function' ||
    typeof input.images?.getImageMetadata !== 'function' ||
    input.brandKit === undefined
  ) {
    throw fail('INVALID_INPUT');
  }
  return {
    document,
    brand: brandContent(document.brandKit, input.brandKit),
  };
}

export function layoutContentStudioDesign(
  input: ContentStudioDesignLayoutInput
): ContentStudioDesignLayoutV1 {
  const { document, brand } = checkedInput(input);
  const colors = new Map(
    (brand?.colors ?? []).map((token) => [token.id, token.value])
  );
  const typography = new Map(
    (brand?.typography ?? []).map((token) => [
      token.id,
      { family: token.family, weight: token.weight, style: token.style },
    ])
  );
  const resolveFont = fontResolver(input.fonts);
  const resolveImage = imageResolver(input.images);

  const color = (value: ContentStudioDesignColorValue) => {
    if (value.type === 'literal') {
      return value.value;
    }
    const resolved = colors.get(value.tokenId);
    if (resolved === undefined) {
      throw fail('BRAND_TOKEN_MISSING');
    }
    return resolved;
  };
  const fontSpec = (
    font: ContentStudioDesignFontRef
  ): ContentStudioDesignFontSpec => {
    if (font.type === 'family') {
      return { family: font.family, weight: font.weight, style: font.style };
    }
    const resolved = typography.get(font.tokenId);
    if (resolved === undefined) {
      throw fail('BRAND_TOKEN_MISSING');
    }
    return resolved;
  };

  const shape = (layer: ContentStudioDesignShapeLayer) =>
    layer.shape === 'rectangle'
      ? {
          layerId: layer.id,
          type: 'rectangle' as const,
          ...layoutItemGeometry(layer),
          fill: color(layer.fill),
          cornerRadius: layoutNumber(
            Math.min(layer.cornerRadius, layer.width / 2, layer.height / 2)
          ),
        }
      : {
          layerId: layer.id,
          type: 'ellipse' as const,
          ...layoutItemGeometry(layer),
          fill: color(layer.fill),
        };

  const image = (
    layer: ContentStudioDesignImageLayer
  ): ContentStudioDesignLayoutImageItem => {
    const intrinsic = resolveImage(layer.imageRef);
    const geometry = layoutItemGeometry(layer);
    return {
      layerId: layer.id,
      type: 'image',
      ...geometry,
      imageRef: {
        mediaId: layer.imageRef.mediaId,
        sha256: layer.imageRef.sha256,
      },
      intrinsic: { width: intrinsic.width, height: intrinsic.height },
      fit: layer.fit,
      ...layoutContentStudioDesignImageGeometry(
        geometry.box,
        intrinsic,
        layer.fit,
        layer.focalPoint
      ),
    };
  };

  const item = (
    layer: ContentStudioDesignLayer
  ): ContentStudioDesignLayoutItem => {
    if (layer.type === 'text') {
      const textColor = color(layer.color);
      const font = fontSpec(layer.font);
      return layoutContentStudioDesignText(
        layer,
        textColor,
        font,
        resolveFont(font)
      );
    }
    return layer.type === 'shape' ? shape(layer) : image(layer);
  };

  return {
    schemaVersion: DESIGN_LAYOUT_SCHEMA_VERSION,
    pages: document.pages.map((page) => ({
      id: page.id,
      width: page.width,
      height: page.height,
      background: { type: 'solid', color: color(page.background.color) },
      clipRect: layoutRect(0, 0, page.width, page.height),
      items: page.layers.filter((layer) => layer.visible).map(item),
    })),
  };
}
