import {
  isPlainData,
  utf8ByteLength,
} from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';
import {
  ContentStudioDesignDocumentError,
  ContentStudioDesignDocumentV1,
  ContentStudioDesignLayer,
  DESIGN_COORDINATE_MAX,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';

// Layout Pattern v1: a reusable arrangement of layers, copied into a page
// when it is used and never linked to it. A pattern is the box around its
// layers (width and height) and the layers themselves, back to front, each
// an ordinary Design Document v1 layer without its id, its x and y measured
// from the top left of that box. Everything else of a layer is kept as it
// was: text, style, Brand Kit token references, image references with
// their SHA-256, fit, focal point and mask. There is no page, layer id,
// document Brand Kit, template guidance, preset, group, constraint or link:
// every layer is checked by the Design Document v1 parser itself, so a
// pattern can hold nothing a design could not. Using a pattern gives every
// layer a new id. Like the other content parsers this file uses no
// Node-only module

export const DESIGN_LAYOUT_PATTERN_SCHEMA_VERSION = 1;
export const DESIGN_LAYOUT_PATTERN_LAYERS_MAX = 50;
// UTF-8 bytes of the normalized pattern as JSON
export const DESIGN_LAYOUT_PATTERN_MAX_BYTES = 524_288;
export const DESIGN_LAYOUT_PATTERN_NAME_MAX = 100;
export const DESIGN_LAYOUT_PATTERN_DESCRIPTION_MAX = 500;

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
export type ContentStudioDesignLayoutPatternLayer =
  WithoutId<ContentStudioDesignLayer>;

export interface ContentStudioDesignLayoutPatternContentV1 {
  schemaVersion: 1;
  width: number;
  height: number;
  layers: ContentStudioDesignLayoutPatternLayer[];
}

// INVALID: not Layout Pattern v1. TOO_LARGE: valid, but larger than allowed
export class ContentStudioDesignLayoutPatternError extends Error {
  constructor(readonly code: 'INVALID' | 'TOO_LARGE' = 'INVALID') {
    super(
      code === 'TOO_LARGE'
        ? 'The layout pattern is larger than allowed'
        : 'The layout pattern does not match schema version 1'
    );
    this.name = 'ContentStudioDesignLayoutPatternError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sizeOk = (value: unknown) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value > 0 &&
  value <= DESIGN_COORDINATE_MAX;

// The layers, each given a probe id, parsed as one page of a document: the
// Design Document v1 rules decide every value (Brand Kit tokens are checked
// against the target design when the pattern is used)
const parseLayers = (layers: Record<string, unknown>[]) => {
  try {
    return parseContentStudioDesignDocument({
      schemaVersion: 1,
      brandKit: null,
      pages: [
        {
          id: 'pattern',
          name: '',
          width: 1024,
          height: 1024,
          background: {
            type: 'solid',
            color: { type: 'literal', value: '#ffffff' },
          },
          layers: layers.map((layer, index) => ({
            ...layer,
            id: `pattern_${index}`,
          })),
        },
      ],
    }).pages[0].layers;
  } catch (err) {
    if (err instanceof ContentStudioDesignDocumentError) {
      throw new ContentStudioDesignLayoutPatternError();
    }
    throw err;
  }
};

const withoutId = (layer: ContentStudioDesignLayer) => {
  const { id, ...rest } = layer;
  void id;
  return rest as ContentStudioDesignLayoutPatternLayer;
};

// Validates and normalizes Layout Pattern v1 content (from a request, a
// built-in or the database) into a new object, as the Design Document v1
// parser normalizes layers. The input is never changed. A layer that names
// an id is refused: a pattern has no layer identity
export function parseContentStudioDesignLayoutPatternContent(
  input: unknown
): ContentStudioDesignLayoutPatternContentV1 {
  if (
    !isPlainData(input) ||
    !isRecord(input) ||
    Object.keys(input).sort().join(',') !==
      'height,layers,schemaVersion,width' ||
    input.schemaVersion !== DESIGN_LAYOUT_PATTERN_SCHEMA_VERSION ||
    !sizeOk(input.width) ||
    !sizeOk(input.height) ||
    !Array.isArray(input.layers) ||
    !input.layers.length ||
    input.layers.length > DESIGN_LAYOUT_PATTERN_LAYERS_MAX ||
    !input.layers.every(
      (layer) =>
        isRecord(layer) && !Object.prototype.hasOwnProperty.call(layer, 'id')
    )
  ) {
    throw new ContentStudioDesignLayoutPatternError();
  }
  const content: ContentStudioDesignLayoutPatternContentV1 = {
    schemaVersion: 1,
    width: input.width as number,
    height: input.height as number,
    layers: parseLayers(input.layers as Record<string, unknown>[]).map(
      withoutId
    ),
  };
  if (
    utf8ByteLength(JSON.stringify(content)) > DESIGN_LAYOUT_PATTERN_MAX_BYTES
  ) {
    throw new ContentStudioDesignLayoutPatternError('TOO_LARGE');
  }
  return content;
}

// -0 is stored as 0
const plain = (value: number) => (value === 0 ? 0 : value);

// A pattern from some layers of one page: the box around their stored,
// unrotated boxes, and the layers in the page's order (back to front),
// deep-copied without their ids, x and y measured from that box. Null when
// an id is missing, repeated, on another page, or there are none or too
// many. The document is not changed
export function extractContentStudioDesignLayoutPattern(
  document: ContentStudioDesignDocumentV1,
  layerIds: string[]
): ContentStudioDesignLayoutPatternContentV1 | null {
  if (
    !layerIds.length ||
    layerIds.length > DESIGN_LAYOUT_PATTERN_LAYERS_MAX ||
    new Set(layerIds).size !== layerIds.length
  ) {
    return null;
  }
  const wanted = new Set(layerIds);
  const page = document.pages.find((entry) =>
    entry.layers.some((layer) => wanted.has(layer.id))
  );
  const layers = page?.layers.filter((layer) => wanted.has(layer.id)) ?? [];
  if (layers.length !== layerIds.length) {
    return null;
  }
  const left = Math.min(...layers.map((layer) => layer.x));
  const top = Math.min(...layers.map((layer) => layer.y));
  const right = Math.max(...layers.map((layer) => layer.x + layer.width));
  const bottom = Math.max(...layers.map((layer) => layer.y + layer.height));
  return {
    schemaVersion: 1,
    width: right - left,
    height: bottom - top,
    layers: layers.map((layer) => {
      const copy = withoutId(
        JSON.parse(JSON.stringify(layer)) as ContentStudioDesignLayer
      );
      return { ...copy, x: plain(layer.x - left), y: plain(layer.y - top) };
    }),
  };
}

// The pattern's layers placed with the box centered on a page of this size,
// back to front, each deep-copied with the id it is given. The pattern is
// not changed; the caller checks limits, ids and Brand Kit tokens
export function instantiateContentStudioDesignLayoutPattern(
  content: ContentStudioDesignLayoutPatternContentV1,
  page: { width: number; height: number },
  newId: () => string
): ContentStudioDesignLayer[] {
  const offsetX = (page.width - content.width) / 2;
  const offsetY = (page.height - content.height) / 2;
  return content.layers.map((layer) => {
    const copy = JSON.parse(
      JSON.stringify(layer)
    ) as ContentStudioDesignLayoutPatternLayer;
    return {
      ...copy,
      id: newId(),
      x: plain(layer.x + offsetX),
      y: plain(layer.y + offsetY),
    } as ContentStudioDesignLayer;
  });
}
