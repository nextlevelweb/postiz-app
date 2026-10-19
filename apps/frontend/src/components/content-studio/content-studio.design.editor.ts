import type { ContentStudioBrandKitContentV1 } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import {
  collectContentStudioDesignBrandTokenRefs,
  ContentStudioDesignBrandKitRef,
  ContentStudioDesignDocumentError,
  ContentStudioDesignColorValue,
  ContentStudioDesignDocumentV1,
  ContentStudioDesignImageLayer,
  ContentStudioDesignImageMask,
  ContentStudioDesignLayer,
  ContentStudioDesignPage,
  ContentStudioDesignShapeLayer,
  ContentStudioDesignTextLayer,
  DESIGN_COORDINATE_MAX,
  DESIGN_CORNER_RADIUS_MAX,
  DESIGN_LAYERS_MAX,
  DESIGN_LAYERS_PER_PAGE_MAX,
  DESIGN_PAGE_AREA_MAX,
  DESIGN_PAGE_NAME_MAX,
  DESIGN_PAGE_SIZE_MAX,
  DESIGN_PAGE_SIZE_MIN,
  DESIGN_PAGES_MAX,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  applyContentStudioDesignStylePreset,
  collectContentStudioDesignStylePresetBrandTokens,
  ContentStudioDesignStylePresetContentV1,
  designStylePresetKindOf,
} from '@gitroom/nestjs-libraries/content-studio/design/design.style.preset';
import type { ContentStudioDesignBlockContentV1 } from '@gitroom/nestjs-libraries/content-studio/design/design.block';
import {
  ContentStudioDesignPageSetContentV1,
  instantiateContentStudioDesignPageSet,
} from '@gitroom/nestjs-libraries/content-studio/design/design.page.set';
import {
  ContentStudioDesignLayoutPatternContentV1,
  instantiateContentStudioDesignLayoutPattern,
} from '@gitroom/nestjs-libraries/content-studio/design/design.layout.pattern';

// The operations of the Creative Studio editor on a Design Document v1, as
// pure functions: no React, API or DOM. Every operation leaves its input as
// it is and returns a new plain document, so each undo snapshot stands on
// its own. Array order is the design's z-order (first is at the back) and
// page order; ids are stable names, unique across the document (layers) or
// among the pages. Nothing here adds editor state (selection, zoom, panels)
// to the document: what is saved is exactly Design Document v1

export const DESIGN_EDITOR_HISTORY_MAX = 50;
// a fresh random id colliding even once is practically impossible
const ID_ATTEMPTS = 10;

export type ContentStudioDesignEditorErrorCode =
  | 'NOT_FOUND'
  | 'PAGE_LIMIT'
  | 'LAYER_LIMIT'
  | 'LAST_PAGE'
  | 'ID_EXHAUSTED'
  | 'BRAND_TOKENS_IN_USE'
  | 'BRAND_TOKENS_MISSING'
  | 'OUT_OF_LIMITS'
  | 'STYLE_KIND_MISMATCH'
  | 'STYLE_BRAND_UNAVAILABLE'
  | 'IMAGE_MASK_INVALID'
  | 'LAYOUT_BRAND_UNAVAILABLE'
  | 'INVALID_TARGET_SIZE'
  | 'VARIANT_OUT_OF_LIMITS'
  | 'PAGE_SET_OUT_OF_LIMITS'
  | 'BLOCK_BRAND_UNAVAILABLE'
  | 'BLOCK_OUT_OF_LIMITS';

// A code only: the UI shows its own fixed text for it
export class ContentStudioDesignEditorError extends Error {
  constructor(readonly code: ContentStudioDesignEditorErrorCode) {
    super('The design edit is not possible');
    this.name = 'ContentStudioDesignEditorError';
  }
}

const fail = (code: ContentStudioDesignEditorErrorCode) =>
  new ContentStudioDesignEditorError(code);

// 20 hex characters from the browser's random source
const randomHex = () => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  }
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
};

// A page id is a letter first, then at most 31 letters, digits, _ or -;
// a layer id may have 63 after the letter. p_ or l_ and 20 hex both fit
export const newContentStudioDesignPageId = () => `p_${randomHex()}`;
export const newContentStudioDesignLayerId = () => `l_${randomHex()}`;

const uniqueId = (create: () => string, taken: Set<string>) => {
  for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
    const id = create();
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
  throw fail('ID_EXHAUSTED');
};

const layerIds = (document: ContentStudioDesignDocumentV1) =>
  new Set(document.pages.flatMap((page) => page.layers.map((l) => l.id)));
const pageIds = (document: ContentStudioDesignDocumentV1) =>
  new Set(document.pages.map((page) => page.id));

// The document is plain JSON data (strings, finite numbers, booleans, null,
// arrays and objects), so a JSON round trip is an exact, independent copy
export const cloneContentStudioDesignDocument = (
  document: ContentStudioDesignDocumentV1
): ContentStudioDesignDocumentV1 => JSON.parse(JSON.stringify(document));

// Structural equality of plain data: arrays by position (page and layer
// order matter), objects by their keys whatever the key order
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => equal(value, b[index]))
    );
  }
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return false;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        equal(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key]
        )
    )
  );
};

export const areContentStudioDesignDocumentsEqual = (
  a: ContentStudioDesignDocumentV1,
  b: ContentStudioDesignDocumentV1
) => equal(a, b);

const layerCount = (document: ContentStudioDesignDocumentV1) =>
  document.pages.reduce((total, page) => total + page.layers.length, 0);

// What the limits of Design Document v1 still allow
export const contentStudioDesignEditorLimits = (
  document: ContentStudioDesignDocumentV1,
  pageId: string
) => {
  const page = document.pages.find((entry) => entry.id === pageId);
  const layersLeft = DESIGN_LAYERS_MAX - layerCount(document);
  return {
    canAddPage: document.pages.length < DESIGN_PAGES_MAX,
    // a duplicate page brings all of its layers
    canDuplicatePage:
      !!page &&
      document.pages.length < DESIGN_PAGES_MAX &&
      page.layers.length <= layersLeft,
    canDeletePage: document.pages.length > 1,
    canAddLayer:
      !!page &&
      page.layers.length < DESIGN_LAYERS_PER_PAGE_MAX &&
      layersLeft > 0,
  };
};

export const contentStudioDesignTextLength = (
  document: ContentStudioDesignDocumentV1
) =>
  document.pages.reduce(
    (total, page) =>
      total +
      page.layers.reduce(
        (sum, layer) => sum + (layer.type === 'text' ? layer.text.length : 0),
        0
      ),
    0
  );

const findPage = (document: ContentStudioDesignDocumentV1, pageId: string) => {
  const index = document.pages.findIndex((page) => page.id === pageId);
  if (index < 0) {
    throw fail('NOT_FOUND');
  }
  return index;
};

const withPages = (
  document: ContentStudioDesignDocumentV1,
  pages: ContentStudioDesignPage[]
): ContentStudioDesignDocumentV1 => ({ ...document, pages });

const withPage = (
  document: ContentStudioDesignDocumentV1,
  index: number,
  page: ContentStudioDesignPage
) =>
  withPages(
    document,
    document.pages.map((entry, position) => (position === index ? page : entry))
  );

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = { width: 1080, height: 1080 };
const WHITE: ContentStudioDesignColorValue = {
  type: 'literal',
  value: '#ffffff',
};

// An empty white page at the end, the size of the given page (else 1080)
export const addContentStudioDesignPage = (
  document: ContentStudioDesignDocumentV1,
  sizeOfPageId: string | null
) => {
  if (document.pages.length >= DESIGN_PAGES_MAX) {
    throw fail('PAGE_LIMIT');
  }
  const size =
    document.pages.find((page) => page.id === sizeOfPageId) ??
    DEFAULT_PAGE_SIZE;
  const page: ContentStudioDesignPage = {
    id: uniqueId(newContentStudioDesignPageId, pageIds(document)),
    name: '',
    width: size.width,
    height: size.height,
    background: { type: 'solid', color: { ...WHITE } },
    layers: [],
  };
  return {
    document: withPages(document, [...document.pages, page]),
    pageId: page.id,
  };
};

// A copy of a page right after it: the same name, size, background and
// layers, under a new page id and new layer ids
export const duplicateContentStudioDesignPage = (
  document: ContentStudioDesignDocumentV1,
  pageId: string
) => {
  const index = findPage(document, pageId);
  const source = document.pages[index];
  if (document.pages.length >= DESIGN_PAGES_MAX) {
    throw fail('PAGE_LIMIT');
  }
  if (source.layers.length > DESIGN_LAYERS_MAX - layerCount(document)) {
    throw fail('LAYER_LIMIT');
  }
  const takenLayers = layerIds(document);
  const copy = JSON.parse(JSON.stringify(source)) as ContentStudioDesignPage;
  const page: ContentStudioDesignPage = {
    ...copy,
    id: uniqueId(newContentStudioDesignPageId, pageIds(document)),
    layers: copy.layers.map((layer) => ({
      ...layer,
      id: uniqueId(newContentStudioDesignLayerId, takenLayers),
    })),
  };
  const pages = [...document.pages];
  pages.splice(index + 1, 0, page);
  return { document: withPages(document, pages), pageId: page.id };
};

// ---------------------------------------------------------------------------
// Size variants (P4-16)
// ---------------------------------------------------------------------------

// A size a page variant is made in, with the name it adds to the page name
export interface ContentStudioDesignPageVariantTarget {
  width: number;
  height: number;
  label: string;
}

// One layer of a page of one size, as it would be on a page of another:
// the whole page scaled uniformly by the factor that fits it inside the
// target (never stretched on one axis) and centered there. A layer keeps
// its place relative to the page center; its box, and every size measured
// in design units with it, scales by the same factor: a text's font size
// and letter spacing (line height is a multiple of the font size and
// stays), a shape's corner radius, an image frame's radius. Everything else
// stays exactly: id, name, text, rotation, opacity, visibility, colors and
// fonts (literal or Brand Kit tokens), Media reference, fit, focal point
// and mask type. A new object; the layer is not changed
export const scaleContentStudioDesignLayerForPageVariant = <
  T extends ContentStudioDesignLayer
>(
  layer: T,
  source: { width: number; height: number },
  target: { width: number; height: number }
): T => {
  const scale = Math.min(
    target.width / source.width,
    target.height / source.height
  );
  const copy = JSON.parse(JSON.stringify(layer)) as ContentStudioDesignLayer;
  const width = layer.width * scale;
  const height = layer.height * scale;
  const centerX =
    target.width / 2 + (layer.x + layer.width / 2 - source.width / 2) * scale;
  const centerY =
    target.height / 2 +
    (layer.y + layer.height / 2 - source.height / 2) * scale;
  const box = {
    x: plain(centerX - width / 2),
    y: plain(centerY - height / 2),
    width,
    height,
  };
  if (copy.type === 'text') {
    return {
      ...copy,
      ...box,
      fontSize: copy.fontSize * scale,
      letterSpacing: plain(copy.letterSpacing * scale),
    } as T;
  }
  if (copy.type === 'shape') {
    return {
      ...copy,
      ...box,
      cornerRadius: copy.cornerRadius * scale,
    } as T;
  }
  return {
    ...copy,
    ...box,
    ...(copy.mask?.type === 'roundedRectangle'
      ? {
          mask: {
            type: 'roundedRectangle',
            cornerRadius: copy.mask.cornerRadius * scale,
          },
        }
      : {}),
  } as T;
};

// A size a Design Document v1 page can have
const pageSizeOk = (size: { width: number; height: number }) =>
  [size.width, size.height].every(
    (side) =>
      Number.isInteger(side) &&
      side >= DESIGN_PAGE_SIZE_MIN &&
      side <= DESIGN_PAGE_SIZE_MAX
  ) && size.width * size.height <= DESIGN_PAGE_AREA_MAX;

// "Name · Label", or the label alone for a page without a name; the name is
// shortened (never the label) to fit the page name limit
const variantName = (name: string, label: string) => {
  if (!name.trim()) {
    return label.slice(0, DESIGN_PAGE_NAME_MAX);
  }
  const suffix = ` · ${label}`.slice(0, DESIGN_PAGE_NAME_MAX);
  return `${name.slice(0, DESIGN_PAGE_NAME_MAX - suffix.length)}${suffix}`;
};

// New pages made from one page, one per target size, right after it in
// the targets' order (the pages after it move along): ordinary independent
// pages, each with a new page id and new layer ids, the source's
// background and its layers in the same order, scaled and centered for the
// size (scaleContentStudioDesignLayerForPageVariant). Nothing links a
// variant to its source or to the others, and the source is not changed.
// All or nothing, before anything is made: no targets, an invalid or
// repeated size (INVALID_TARGET_SIZE), more pages or layers than a design
// may have (PAGE_LIMIT, LAYER_LIMIT), or a result that is not valid Design
// Document v1, such as a scaled value outside its limits or too much text
// (VARIANT_OUT_OF_LIMITS)
export const createContentStudioDesignPageVariants = (
  document: ContentStudioDesignDocumentV1,
  pageId: string,
  targets: ContentStudioDesignPageVariantTarget[]
) => {
  const index = findPage(document, pageId);
  const source = document.pages[index];
  const sizes = new Set(
    targets.map((target) => `${target.width}x${target.height}`)
  );
  if (
    !targets.length ||
    sizes.size !== targets.length ||
    !targets.every(pageSizeOk)
  ) {
    throw fail('INVALID_TARGET_SIZE');
  }
  if (document.pages.length + targets.length > DESIGN_PAGES_MAX) {
    throw fail('PAGE_LIMIT');
  }
  if (
    layerCount(document) + targets.length * source.layers.length >
    DESIGN_LAYERS_MAX
  ) {
    throw fail('LAYER_LIMIT');
  }
  const takenPages = pageIds(document);
  const takenLayers = layerIds(document);
  const variants = targets.map(
    (target): ContentStudioDesignPage => ({
      id: uniqueId(newContentStudioDesignPageId, takenPages),
      name: variantName(source.name, target.label),
      width: target.width,
      height: target.height,
      background: JSON.parse(JSON.stringify(source.background)),
      layers: source.layers.map((layer) => ({
        ...scaleContentStudioDesignLayerForPageVariant(layer, source, target),
        id: uniqueId(newContentStudioDesignLayerId, takenLayers),
      })),
    })
  );
  const pages = [...document.pages];
  pages.splice(index + 1, 0, ...variants);
  const next = withPages(document, pages);
  try {
    parseContentStudioDesignDocument(next);
  } catch (err) {
    if (err instanceof ContentStudioDesignDocumentError) {
      throw fail('VARIANT_OUT_OF_LIMITS');
    }
    throw err;
  }
  return { document: next, pageIds: variants.map((page) => page.id) };
};

// One size variant of a page, right after it
export const createContentStudioDesignPageVariant = (
  document: ContentStudioDesignDocumentV1,
  pageId: string,
  target: ContentStudioDesignPageVariantTarget
) => {
  const created = createContentStudioDesignPageVariants(document, pageId, [
    target,
  ]);
  return { document: created.document, pageId: created.pageIds[0] };
};

// ---------------------------------------------------------------------------
// Page sets (P4-17)
// ---------------------------------------------------------------------------

// The pages of a page set added after the last page of the design, in the
// set's order: ordinary blank pages, each with a new page id, the set's
// name, size and background, and no layers. Nothing of the page set stays
// in the design. All or nothing: more than 25 pages in all (PAGE_LIMIT), or
// a result that is not valid Design Document v1 (PAGE_SET_OUT_OF_LIMITS),
// adds no page
export const addContentStudioDesignPageSet = (
  document: ContentStudioDesignDocumentV1,
  content: ContentStudioDesignPageSetContentV1
) => {
  if (
    !content.pages.length ||
    document.pages.length + content.pages.length > DESIGN_PAGES_MAX
  ) {
    throw fail('PAGE_LIMIT');
  }
  const taken = pageIds(document);
  const added = instantiateContentStudioDesignPageSet(content, () =>
    uniqueId(newContentStudioDesignPageId, taken)
  );
  const next = withPages(document, [...document.pages, ...added]);
  try {
    parseContentStudioDesignDocument(next);
  } catch (err) {
    if (err instanceof ContentStudioDesignDocumentError) {
      throw fail('PAGE_SET_OUT_OF_LIMITS');
    }
    throw err;
  }
  return { document: next, pageIds: added.map((page) => page.id) };
};

// Never the last page. The page now at the same position is selected next,
// or the new last page
export const deleteContentStudioDesignPage = (
  document: ContentStudioDesignDocumentV1,
  pageId: string
) => {
  const index = findPage(document, pageId);
  if (document.pages.length <= 1) {
    throw fail('LAST_PAGE');
  }
  const pages = document.pages.filter((_, position) => position !== index);
  return {
    document: withPages(document, pages),
    pageId: pages[Math.min(index, pages.length - 1)].id,
  };
};

// One step toward the first page (-1) or the last (+1)
export const moveContentStudioDesignPage = (
  document: ContentStudioDesignDocumentV1,
  pageId: string,
  step: -1 | 1
) => {
  const index = findPage(document, pageId);
  const target = index + step;
  if (target < 0 || target >= document.pages.length) {
    return document;
  }
  const pages = [...document.pages];
  [pages[index], pages[target]] = [pages[target], pages[index]];
  return withPages(document, pages);
};

// The name and background only: a page keeps its size
export const updateContentStudioDesignPage = (
  document: ContentStudioDesignDocumentV1,
  pageId: string,
  patch: { name?: string; background?: ContentStudioDesignColorValue }
) => {
  const index = findPage(document, pageId);
  const page = document.pages[index];
  return withPage(document, index, {
    ...page,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.background
      ? { background: { type: 'solid', color: { ...patch.background } } }
      : {}),
  });
};

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const findLayer = (
  document: ContentStudioDesignDocumentV1,
  layerId: string
) => {
  for (const [pageIndex, page] of document.pages.entries()) {
    const layerIndex = page.layers.findIndex((layer) => layer.id === layerId);
    if (layerIndex >= 0) {
      return { pageIndex, layerIndex, page, layer: page.layers[layerIndex] };
    }
  }
  throw fail('NOT_FOUND');
};

const withLayers = (
  document: ContentStudioDesignDocumentV1,
  pageIndex: number,
  layers: ContentStudioDesignLayer[]
) => withPage(document, pageIndex, { ...document.pages[pageIndex], layers });

const box = (page: ContentStudioDesignPage, width: number, height: number) => ({
  name: '',
  x: page.width * 0.1,
  y: page.height * 0.1,
  width: page.width * width,
  height: page.height * height,
  rotation: 0,
  opacity: 1,
  visible: true,
});

export type ContentStudioDesignNewLayer = 'text' | 'rectangle' | 'ellipse';

const newLayer = (
  page: ContentStudioDesignPage,
  kind: ContentStudioDesignNewLayer,
  id: string
): ContentStudioDesignLayer => {
  if (kind === 'text') {
    const text: ContentStudioDesignTextLayer = {
      id,
      ...box(page, 0.8, 0),
      height: Math.min(200, page.height * 0.25),
      type: 'text',
      text: 'Text',
      font: { type: 'family', family: 'Arial', weight: 400, style: 'normal' },
      fontSize: 48,
      lineHeight: 1.2,
      letterSpacing: 0,
      color: { type: 'literal', value: '#000000' },
      align: 'left',
      verticalAlign: 'top',
      overflow: 'clip',
    };
    return text;
  }
  const shape: ContentStudioDesignShapeLayer = {
    id,
    ...box(page, 0.4, 0.25),
    type: 'shape',
    shape: kind,
    fill: { type: 'literal', value: '#d9d9d9' },
    // an ellipse has no corner radius in Design Document v1
    cornerRadius: 0,
  };
  return shape;
};

const appendLayer = (
  document: ContentStudioDesignDocumentV1,
  pageId: string,
  create: (
    page: ContentStudioDesignPage,
    id: string
  ) => ContentStudioDesignLayer
) => {
  const index = findPage(document, pageId);
  if (!contentStudioDesignEditorLimits(document, pageId).canAddLayer) {
    throw fail('LAYER_LIMIT');
  }
  const page = document.pages[index];
  const layer = create(
    page,
    uniqueId(newContentStudioDesignLayerId, layerIds(document))
  );
  return {
    document: withLayers(document, index, [...page.layers, layer]),
    layerId: layer.id,
  };
};

// A new layer in front of the others on the page
export const addContentStudioDesignLayer = (
  document: ContentStudioDesignDocumentV1,
  pageId: string,
  kind: ContentStudioDesignNewLayer
) => appendLayer(document, pageId, (page, id) => newLayer(page, kind, id));

// An image layer for a reference the server made: the Media id and the
// SHA-256 of its stored bytes. Nothing else of the Media is kept
export const addContentStudioDesignImageLayer = (
  document: ContentStudioDesignDocumentV1,
  pageId: string,
  ref: { mediaId: string; sha256: string }
) =>
  appendLayer(document, pageId, (page, id) => {
    const image: ContentStudioDesignImageLayer = {
      id,
      ...box(page, 0.8, 0.6),
      type: 'image',
      imageRef: { type: 'media', mediaId: ref.mediaId, sha256: ref.sha256 },
      fit: 'cover',
      focalPoint: { x: 0.5, y: 0.5 },
    };
    return image;
  });

// What can change on a layer: anything but its id and type (and the shape
// of a shape layer)
export type ContentStudioDesignLayerPatch = Partial<
  Omit<ContentStudioDesignTextLayer, 'id' | 'type'> &
    Omit<ContentStudioDesignShapeLayer, 'id' | 'type' | 'shape'> &
    Omit<ContentStudioDesignImageLayer, 'id' | 'type'>
>;

const FIELDS: Record<ContentStudioDesignLayer['type'], string[]> = {
  text: [
    'text',
    'font',
    'fontSize',
    'lineHeight',
    'letterSpacing',
    'color',
    'align',
    'verticalAlign',
    'overflow',
  ],
  shape: ['fill', 'cornerRadius'],
  image: ['imageRef', 'fit', 'focalPoint'],
};
const COMMON = [
  'name',
  'x',
  'y',
  'width',
  'height',
  'rotation',
  'opacity',
  'visible',
];

// Only the fields the layer's type has: a field of another type is ignored,
// and an ellipse keeps a corner radius of 0
export const updateContentStudioDesignLayer = (
  document: ContentStudioDesignDocumentV1,
  layerId: string,
  patch: ContentStudioDesignLayerPatch
) => {
  const { pageIndex, layerIndex, page, layer } = findLayer(document, layerId);
  const allowed = new Set([...COMMON, ...FIELDS[layer.type]]);
  const changes = Object.fromEntries(
    Object.entries(patch).filter(
      ([key, value]) =>
        allowed.has(key) &&
        value !== undefined &&
        !(
          key === 'cornerRadius' &&
          layer.type === 'shape' &&
          layer.shape === 'ellipse'
        )
    )
  );
  const next = JSON.parse(
    JSON.stringify({ ...layer, ...changes })
  ) as ContentStudioDesignLayer;
  return withLayers(
    document,
    pageIndex,
    page.layers.map((entry, position) =>
      position === layerIndex ? next : entry
    )
  );
};

export const deleteContentStudioDesignLayer = (
  document: ContentStudioDesignDocumentV1,
  layerId: string
) => {
  const { pageIndex, page } = findLayer(document, layerId);
  return withLayers(
    document,
    pageIndex,
    page.layers.filter((layer) => layer.id !== layerId)
  );
};

// A copy is moved by 20 units where that stays within the coordinate limits
const copyOffset = (value: number) =>
  value + 20 <= DESIGN_COORDINATE_MAX ? value + 20 : value;

// An exact copy right in front of the original, under a new id, moved by 20
// units where that stays within the coordinate limits
export const duplicateContentStudioDesignLayer = (
  document: ContentStudioDesignDocumentV1,
  layerId: string
) => {
  const { pageIndex, layerIndex, page, layer } = findLayer(document, layerId);
  if (!contentStudioDesignEditorLimits(document, page.id).canAddLayer) {
    throw fail('LAYER_LIMIT');
  }
  const copy = {
    ...(JSON.parse(JSON.stringify(layer)) as ContentStudioDesignLayer),
    id: uniqueId(newContentStudioDesignLayerId, layerIds(document)),
    x: copyOffset(layer.x),
    y: copyOffset(layer.y),
  };
  const layers = [...page.layers];
  layers.splice(layerIndex + 1, 0, copy);
  return {
    document: withLayers(document, pageIndex, layers),
    layerId: copy.id,
  };
};

export type ContentStudioDesignLayerMove =
  | 'forward'
  | 'backward'
  | 'front'
  | 'back';

// In the page's layer array: forward and front toward its end (the front),
// backward and back toward its start
export const contentStudioDesignLayerMoves = (
  document: ContentStudioDesignDocumentV1,
  layerId: string
) => {
  const { layerIndex, page } = findLayer(document, layerId);
  const last = page.layers.length - 1;
  return {
    forward: layerIndex < last,
    front: layerIndex < last,
    backward: layerIndex > 0,
    back: layerIndex > 0,
  };
};

export const moveContentStudioDesignLayer = (
  document: ContentStudioDesignDocumentV1,
  layerId: string,
  move: ContentStudioDesignLayerMove
) => {
  const { pageIndex, layerIndex, page, layer } = findLayer(document, layerId);
  const layers = [...page.layers];
  const swap = (target: number) => {
    if (target >= 0 && target < layers.length) {
      [layers[layerIndex], layers[target]] = [
        layers[target],
        layers[layerIndex],
      ];
    }
  };
  switch (move) {
    case 'forward':
      swap(layerIndex + 1);
      break;
    case 'backward':
      swap(layerIndex - 1);
      break;
    case 'front':
      layers.splice(layerIndex, 1);
      layers.push(layer);
      break;
    case 'back':
      layers.splice(layerIndex, 1);
      layers.unshift(layer);
      break;
  }
  return withLayers(document, pageIndex, layers);
};

// ---------------------------------------------------------------------------
// Arranging, copying and nudging layers
// ---------------------------------------------------------------------------

export type ContentStudioDesignAlignEdge =
  | 'left'
  | 'centerX'
  | 'right'
  | 'top'
  | 'centerY'
  | 'bottom';
export type ContentStudioDesignDistributeAxis = 'horizontal' | 'vertical';

// -0 is stored as 0
const plain = (value: number) => (value === 0 ? 0 : value);

// Several different layers of one page, in the page's order. Any id that is
// missing, repeated or on another page refuses the whole operation
const layersOfOnePage = (
  document: ContentStudioDesignDocumentV1,
  layerIds: string[]
) => {
  if (!layerIds.length || new Set(layerIds).size !== layerIds.length) {
    throw fail('NOT_FOUND');
  }
  const { pageIndex, page } = findLayer(document, layerIds[0]);
  const wanted = new Set(layerIds);
  const layers = page.layers.filter((layer) => wanted.has(layer.id));
  if (layers.length !== layerIds.length) {
    throw fail('NOT_FOUND');
  }
  return { pageIndex, page, layers };
};

// New top left corners for some layers of one page, all in one new
// document or none: a corner outside the coordinate limits refuses it all.
// Size, rotation and everything else stay
const placeLayers = (
  document: ContentStudioDesignDocumentV1,
  pageIndex: number,
  page: ContentStudioDesignPage,
  corners: Map<string, { x: number; y: number }>
) => {
  for (const { x, y } of Array.from(corners.values())) {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      Math.abs(x) > DESIGN_COORDINATE_MAX ||
      Math.abs(y) > DESIGN_COORDINATE_MAX
    ) {
      throw fail('OUT_OF_LIMITS');
    }
  }
  return withLayers(
    document,
    pageIndex,
    page.layers.map((layer) => {
      const corner = corners.get(layer.id);
      return corner
        ? { ...layer, x: plain(corner.x), y: plain(corner.y) }
        : layer;
    })
  );
};

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// Where a layer's stored, unrotated box goes to line up with an edge or
// center of the bounds; the other axis stays
const aligned = (
  layer: ContentStudioDesignLayer,
  edge: ContentStudioDesignAlignEdge,
  bounds: Bounds
) => {
  switch (edge) {
    case 'left':
      return { x: bounds.left, y: layer.y };
    case 'centerX':
      return {
        x: (bounds.left + bounds.right) / 2 - layer.width / 2,
        y: layer.y,
      };
    case 'right':
      return { x: bounds.right - layer.width, y: layer.y };
    case 'top':
      return { x: layer.x, y: bounds.top };
    case 'centerY':
      return {
        x: layer.x,
        y: (bounds.top + bounds.bottom) / 2 - layer.height / 2,
      };
    case 'bottom':
      return { x: layer.x, y: bounds.bottom - layer.height };
  }
};

// One layer lined up with an edge or the center of its page
export const alignContentStudioDesignLayerToPage = (
  document: ContentStudioDesignDocumentV1,
  layerId: string,
  edge: ContentStudioDesignAlignEdge
) => {
  const { pageIndex, page, layers } = layersOfOnePage(document, [layerId]);
  const bounds = { left: 0, top: 0, right: page.width, bottom: page.height };
  return placeLayers(
    document,
    pageIndex,
    page,
    new Map([[layerId, aligned(layers[0], edge, bounds)]])
  );
};

// Two or more layers of one page lined up with an edge or the center of
// the box around all of them (never with one of them), in one step.
// Hidden layers count like the others: this is the stored geometry
export const alignContentStudioDesignLayers = (
  document: ContentStudioDesignDocumentV1,
  layerIds: string[],
  edge: ContentStudioDesignAlignEdge
) => {
  const { pageIndex, page, layers } = layersOfOnePage(document, layerIds);
  if (layers.length < 2) {
    throw fail('NOT_FOUND');
  }
  const bounds = {
    left: Math.min(...layers.map((layer) => layer.x)),
    top: Math.min(...layers.map((layer) => layer.y)),
    right: Math.max(...layers.map((layer) => layer.x + layer.width)),
    bottom: Math.max(...layers.map((layer) => layer.y + layer.height)),
  };
  return placeLayers(
    document,
    pageIndex,
    page,
    new Map(layers.map((layer) => [layer.id, aligned(layer, edge, bounds)]))
  );
};

// Three or more layers of one page spaced with equal gaps between their
// boxes: in order of their left (top) edge, ties by id; the first and the
// last stay, the others follow each other at the same gap, which may be
// negative (they overlap). One step
export const distributeContentStudioDesignLayers = (
  document: ContentStudioDesignDocumentV1,
  layerIds: string[],
  axis: ContentStudioDesignDistributeAxis
) => {
  const { pageIndex, page, layers } = layersOfOnePage(document, layerIds);
  if (layers.length < 3) {
    throw fail('NOT_FOUND');
  }
  const start = (layer: ContentStudioDesignLayer) =>
    axis === 'horizontal' ? layer.x : layer.y;
  const size = (layer: ContentStudioDesignLayer) =>
    axis === 'horizontal' ? layer.width : layer.height;
  const order = [...layers].sort(
    (a, b) => start(a) - start(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const first = order[0];
  const last = order[order.length - 1];
  const sizes = order.reduce((total, layer) => total + size(layer), 0);
  const gap =
    (start(last) + size(last) - start(first) - sizes) / (order.length - 1);
  const corners = new Map<string, { x: number; y: number }>();
  let next = start(first);
  order.forEach((layer, index) => {
    // the first and the last keep their exact place
    const at = index === 0 || index === order.length - 1 ? start(layer) : next;
    corners.set(
      layer.id,
      axis === 'horizontal' ? { x: at, y: layer.y } : { x: layer.x, y: at }
    );
    next = at + size(layer) + gap;
  });
  return placeLayers(document, pageIndex, page, corners);
};

// ---------------------------------------------------------------------------
// Composition (P4-15)
// ---------------------------------------------------------------------------

// Every helper below moves the stored, unrotated boxes of some layers of
// one page, in one new document or not at all (placeLayers): sizes,
// rotation, z-order and everything else stay. A rotated layer is placed by
// its stored box, as align and distribute place it. A gap is in design
// units, within the coordinate limits, and may be 0 or negative (overlap)

export type ContentStudioDesignCenterAxis = 'horizontal' | 'vertical' | 'both';

const boundsOf = (layers: ContentStudioDesignLayer[]): Bounds => ({
  left: Math.min(...layers.map((layer) => layer.x)),
  top: Math.min(...layers.map((layer) => layer.y)),
  right: Math.max(...layers.map((layer) => layer.x + layer.width)),
  bottom: Math.max(...layers.map((layer) => layer.y + layer.height)),
});

const gapOk = (gap: number) =>
  Number.isFinite(gap) && Math.abs(gap) <= DESIGN_COORDINATE_MAX;

// The layers, all moved by the same amount
const translated = (
  layers: ContentStudioDesignLayer[],
  dx: number,
  dy: number
) =>
  new Map(
    layers.map((layer) => [layer.id, { x: layer.x + dx, y: layer.y + dy }])
  );

// One or more layers of one page moved together, so the box around them is
// centered on the page horizontally, vertically or both; their places
// relative to each other stay
export const centerContentStudioDesignLayersOnPage = (
  document: ContentStudioDesignDocumentV1,
  layerIds: string[],
  axis: ContentStudioDesignCenterAxis
) => {
  const { pageIndex, page, layers } = layersOfOnePage(document, layerIds);
  const bounds = boundsOf(layers);
  const dx =
    axis === 'vertical'
      ? 0
      : (page.width - (bounds.right - bounds.left)) / 2 - bounds.left;
  const dy =
    axis === 'horizontal'
      ? 0
      : (page.height - (bounds.bottom - bounds.top)) / 2 - bounds.top;
  return placeLayers(document, pageIndex, page, translated(layers, dx, dy));
};

// One or more layers of one page moved together, as little as needed, so
// the box around them is inside the page; on an axis where it is larger
// than the page, its left (top) edge goes to the page's. Only moved, never
// scaled: a text box has no font size to scale with it
export const moveContentStudioDesignLayersIntoPage = (
  document: ContentStudioDesignDocumentV1,
  layerIds: string[]
) => {
  const { pageIndex, page, layers } = layersOfOnePage(document, layerIds);
  const bounds = boundsOf(layers);
  const into = (start: number, end: number, size: number) =>
    end - start > size || start < 0 ? -start : end > size ? size - end : 0;
  return placeLayers(
    document,
    pageIndex,
    page,
    translated(
      layers,
      into(bounds.left, bounds.right, page.width),
      into(bounds.top, bounds.bottom, page.height)
    )
  );
};

// Two or more layers of one page spaced by exactly this gap along an axis:
// in order of their left (top) edge, ties by id; the first stays and the
// others follow it. The other axis stays
export const spaceContentStudioDesignLayers = (
  document: ContentStudioDesignDocumentV1,
  layerIds: string[],
  axis: ContentStudioDesignDistributeAxis,
  gap: number
) => {
  const { pageIndex, page, layers } = layersOfOnePage(document, layerIds);
  if (layers.length < 2) {
    throw fail('NOT_FOUND');
  }
  if (!gapOk(gap)) {
    throw fail('OUT_OF_LIMITS');
  }
  const horizontal = axis === 'horizontal';
  const start = (layer: ContentStudioDesignLayer) =>
    horizontal ? layer.x : layer.y;
  const order = [...layers].sort(
    (a, b) => start(a) - start(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const corners = new Map<string, { x: number; y: number }>();
  let next = start(order[0]);
  for (const layer of order) {
    corners.set(
      layer.id,
      horizontal ? { x: next, y: layer.y } : { x: layer.x, y: next }
    );
    next += (horizontal ? layer.width : layer.height) + gap;
  }
  return placeLayers(document, pageIndex, page, corners);
};

// Two or more layers of one page as a grid of this many columns, in the
// page's order (back to front) row by row, from the top left corner of the
// box around them. A column is as wide as its widest layer and a row as
// high as its highest; every layer goes to the top left of its cell. One
// column is a stack, as many columns as layers is a row
export const arrangeContentStudioDesignLayersInGrid = (
  document: ContentStudioDesignDocumentV1,
  layerIds: string[],
  columns: number,
  gapX: number,
  gapY: number
) => {
  const { pageIndex, page, layers } = layersOfOnePage(document, layerIds);
  if (layers.length < 2) {
    throw fail('NOT_FOUND');
  }
  if (
    !Number.isInteger(columns) ||
    columns < 1 ||
    columns > layers.length ||
    !gapOk(gapX) ||
    !gapOk(gapY)
  ) {
    throw fail('OUT_OF_LIMITS');
  }
  const bounds = boundsOf(layers);
  const widths: number[] = [];
  const heights: number[] = [];
  layers.forEach((layer, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    widths[column] = Math.max(widths[column] ?? 0, layer.width);
    heights[row] = Math.max(heights[row] ?? 0, layer.height);
  });
  const offsets = (sizes: number[], start: number, gap: number) =>
    sizes.reduce<number[]>(
      (list, size, index) =>
        index ? [...list, list[index - 1] + sizes[index - 1] + gap] : [start],
      []
    );
  const xs = offsets(widths, bounds.left, gapX);
  const ys = offsets(heights, bounds.top, gapY);
  return placeLayers(
    document,
    pageIndex,
    page,
    new Map(
      layers.map((layer, index) => [
        layer.id,
        { x: xs[index % columns], y: ys[Math.floor(index / columns)] },
      ])
    )
  );
};

// A row: all the layers side by side, tops lined up
export const arrangeContentStudioDesignLayersInRow = (
  document: ContentStudioDesignDocumentV1,
  layerIds: string[],
  gap: number
) =>
  arrangeContentStudioDesignLayersInGrid(
    document,
    layerIds,
    layerIds.length,
    gap,
    0
  );

// A column: all the layers stacked, left edges lined up
export const arrangeContentStudioDesignLayersInColumn = (
  document: ContentStudioDesignDocumentV1,
  layerIds: string[],
  gap: number
) => arrangeContentStudioDesignLayersInGrid(document, layerIds, 1, 0, gap);

// A layer as the editor's clipboard keeps it: an exact plain copy of
// everything but its id (an image keeps its Media id and SHA-256)
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
export type ContentStudioDesignLayerCopy = WithoutId<ContentStudioDesignLayer>;

export const copyContentStudioDesignLayer = (
  document: ContentStudioDesignDocumentV1,
  layerId: string
): ContentStudioDesignLayerCopy => {
  const { layer } = findLayer(document, layerId);
  const { id, ...copy } = JSON.parse(
    JSON.stringify(layer)
  ) as ContentStudioDesignLayer;
  return copy as ContentStudioDesignLayerCopy;
};

// A copied layer in front of the others on a page, under a new id, moved
// by 20 units where that stays within the coordinate limits
export const pasteContentStudioDesignLayer = (
  document: ContentStudioDesignDocumentV1,
  pageId: string,
  copy: ContentStudioDesignLayerCopy
) =>
  appendLayer(document, pageId, (_page, id) => {
    const layer = JSON.parse(
      JSON.stringify(copy)
    ) as ContentStudioDesignLayerCopy;
    return {
      id,
      ...layer,
      x: copyOffset(layer.x),
      y: copyOffset(layer.y),
    } as ContentStudioDesignLayer;
  });

// A layer moved by exact design units; a move past the coordinate limits
// changes nothing
export const nudgeContentStudioDesignLayer = (
  document: ContentStudioDesignDocumentV1,
  layerId: string,
  dx: number,
  dy: number
) => {
  const { pageIndex, page, layer } = findLayer(document, layerId);
  const x = layer.x + dx;
  const y = layer.y + dy;
  if (
    Math.abs(x) > DESIGN_COORDINATE_MAX ||
    Math.abs(y) > DESIGN_COORDINATE_MAX
  ) {
    return document;
  }
  return placeLayers(document, pageIndex, page, new Map([[layerId, { x, y }]]));
};

// ---------------------------------------------------------------------------
// Brand Kit
// ---------------------------------------------------------------------------

// The Brand Kit tokens the document uses that the content does not have
export const missingContentStudioDesignBrandTokens = (
  document: ContentStudioDesignDocumentV1,
  content: ContentStudioBrandKitContentV1 | null
) => {
  const { colorTokenIds, typographyTokenIds } =
    collectContentStudioDesignBrandTokenRefs(document);
  const colors = new Set(content?.colors.map((token) => token.id) ?? []);
  const typography = new Set(
    content?.typography.map((token) => token.id) ?? []
  );
  return {
    colors: colorTokenIds.filter((id) => !colors.has(id)),
    typography: typographyTokenIds.filter((id) => !typography.has(id)),
  };
};

// Pins the document to exactly this Brand Kit revision (with its content, to
// check every token the document uses exists there), or removes the Brand
// Kit, which only a document using no Brand token may do. Tokens stay
// referenced by id: nothing is copied or converted
export const setContentStudioDesignBrandKit = (
  document: ContentStudioDesignDocumentV1,
  brandKit: {
    ref: ContentStudioDesignBrandKitRef;
    content: ContentStudioBrandKitContentV1;
  } | null
): ContentStudioDesignDocumentV1 => {
  if (!brandKit) {
    const { colorTokenIds, typographyTokenIds } =
      collectContentStudioDesignBrandTokenRefs(document);
    if (colorTokenIds.length || typographyTokenIds.length) {
      throw fail('BRAND_TOKENS_IN_USE');
    }
    return { ...document, brandKit: null };
  }
  const missing = missingContentStudioDesignBrandTokens(
    document,
    brandKit.content
  );
  if (missing.colors.length || missing.typography.length) {
    throw fail('BRAND_TOKENS_MISSING');
  }
  const { brandKitId, revisionId, revisionNumber, contentHash } = brandKit.ref;
  return {
    ...document,
    brandKit: { brandKitId, revisionId, revisionNumber, contentHash },
  };
};

// ---------------------------------------------------------------------------
// Image composition (P4-14)
// ---------------------------------------------------------------------------

// a new rounded frame's radius, where the box allows it
export const DESIGN_IMAGE_MASK_DEFAULT_RADIUS = 24;

// The mask of one image layer: a rounded rectangle (radius in design units,
// 0 to the document limit) or an ellipse, or null to cut the image to its
// box again, which leaves the field out exactly as before masks existed.
// Nothing else of the layer changes: Media, fit, focal point and geometry
// stay
export const setContentStudioDesignImageMask = (
  document: ContentStudioDesignDocumentV1,
  layerId: string,
  mask: ContentStudioDesignImageMask | null
) => {
  const { pageIndex, layerIndex, page, layer } = findLayer(document, layerId);
  if (layer.type !== 'image') {
    throw fail('NOT_FOUND');
  }
  if (
    mask?.type === 'roundedRectangle' &&
    !(
      typeof mask.cornerRadius === 'number' &&
      Number.isFinite(mask.cornerRadius) &&
      mask.cornerRadius >= 0 &&
      mask.cornerRadius <= DESIGN_CORNER_RADIUS_MAX
    )
  ) {
    throw fail('IMAGE_MASK_INVALID');
  }
  const copy = JSON.parse(
    JSON.stringify(layer)
  ) as ContentStudioDesignImageLayer;
  delete copy.mask;
  const next: ContentStudioDesignImageLayer =
    !mask || mask.type === 'rectangle'
      ? copy
      : {
          ...copy,
          mask:
            mask.type === 'roundedRectangle'
              ? { type: 'roundedRectangle', cornerRadius: mask.cornerRadius }
              : { type: 'ellipse' },
        };
  return withLayers(
    document,
    pageIndex,
    page.layers.map((entry, position) =>
      position === layerIndex ? next : entry
    )
  );
};

// half the shorter side of the box: the largest radius that still shows
export const contentStudioDesignImagePillRadius = (layer: {
  width: number;
  height: number;
}) =>
  Math.min(DESIGN_CORNER_RADIUS_MAX, Math.min(layer.width, layer.height) / 2);

const unit = (value: number) =>
  Math.round(Math.min(Math.max(value, 0), 1) * 10_000) / 10_000;

// The focal point under a pointer in a picker of this on-screen box: 0..1
// across and down, rounded to 4 places. Null when the box has no size or the
// position is not a number: nothing of the screen is stored
export const contentStudioDesignFocalPointAt = (
  box: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number
) => {
  if (
    ![box.left, box.top, box.width, box.height, clientX, clientY].every(
      Number.isFinite
    ) ||
    box.width <= 0 ||
    box.height <= 0
  ) {
    return null;
  }
  return {
    x: unit((clientX - box.left) / box.width),
    y: unit((clientY - box.top) / box.height),
  };
};

// The focal point moved by a step across and down, kept within 0..1
export const nudgeContentStudioDesignFocalPoint = (
  point: { x: number; y: number },
  dx: number,
  dy: number
) => ({ x: unit(point.x + dx), y: unit(point.y + dy) });

// ---------------------------------------------------------------------------
// Style presets (P4-13)
// ---------------------------------------------------------------------------

// A style preset's values written over the same fields of one text or shape
// layer: geometry, text, name, visibility and the shape stay, and nothing of
// the preset is kept. A preset of the other kind is refused, and so is one
// using a Brand Kit token that the document's own exact revision (its
// content, as loaded) does not have, or any token for a document without a
// Brand Kit: nothing is attached, converted to a literal or partly applied
export const applyContentStudioDesignStyle = (
  document: ContentStudioDesignDocumentV1,
  layerId: string,
  content: ContentStudioDesignStylePresetContentV1,
  brand: ContentStudioBrandKitContentV1 | null
) => {
  const { pageIndex, layerIndex, page, layer } = findLayer(document, layerId);
  if (designStylePresetKindOf(layer) !== content.kind) {
    throw fail('STYLE_KIND_MISMATCH');
  }
  const { colorTokenIds, typographyTokenIds } =
    collectContentStudioDesignStylePresetBrandTokens(content);
  if (colorTokenIds.length || typographyTokenIds.length) {
    const colors = new Set(brand?.colors.map((token) => token.id) ?? []);
    const typography = new Set(
      brand?.typography.map((token) => token.id) ?? []
    );
    if (
      !document.brandKit ||
      !brand ||
      colorTokenIds.some((id) => !colors.has(id)) ||
      typographyTokenIds.some((id) => !typography.has(id))
    ) {
      throw fail('STYLE_BRAND_UNAVAILABLE');
    }
  }
  const next = applyContentStudioDesignStylePreset(layer, content);
  return withLayers(
    document,
    pageIndex,
    page.layers.map((entry, position) =>
      position === layerIndex ? next : entry
    )
  );
};

// ---------------------------------------------------------------------------
// Layout patterns (P4-15)
// ---------------------------------------------------------------------------

// A layout pattern's layers copied onto a page, in front of the others,
// with the pattern's box centered on the page: every layer under a new id,
// in the pattern's order (its z-order kept), and nothing of the pattern
// kept in the design. Refused as a whole, never partly inserted, when the
// page or the document would have more layers than allowed, a layer would
// be outside the coordinate limits, or a layer uses a Brand Kit token the
// document's own exact revision (its content, as loaded) does not have, or
// any token for a document without a Brand Kit. Whether the images still
// belong to the organization is the caller's check, before this is called
export const insertContentStudioDesignLayoutPattern = (
  document: ContentStudioDesignDocumentV1,
  pageId: string,
  content: ContentStudioDesignLayoutPatternContentV1,
  brand: ContentStudioBrandKitContentV1 | null
) => {
  const index = findPage(document, pageId);
  const page = document.pages[index];
  const count = content.layers.length;
  if (
    !count ||
    page.layers.length + count > DESIGN_LAYERS_PER_PAGE_MAX ||
    layerCount(document) + count > DESIGN_LAYERS_MAX
  ) {
    throw fail('LAYER_LIMIT');
  }
  const taken = layerIds(document);
  const layers = instantiateContentStudioDesignLayoutPattern(
    content,
    page,
    () => uniqueId(newContentStudioDesignLayerId, taken)
  );
  if (
    layers.some(
      (layer) =>
        Math.abs(layer.x) > DESIGN_COORDINATE_MAX ||
        Math.abs(layer.y) > DESIGN_COORDINATE_MAX
    )
  ) {
    throw fail('OUT_OF_LIMITS');
  }
  // the tokens of the new layers only: the page's background is not theirs
  const { colorTokenIds, typographyTokenIds } =
    collectContentStudioDesignBrandTokenRefs({
      ...document,
      pages: [{ ...page, background: { type: 'solid', color: WHITE }, layers }],
    });
  if (colorTokenIds.length || typographyTokenIds.length) {
    const colors = new Set(brand?.colors.map((token) => token.id) ?? []);
    const typography = new Set(
      brand?.typography.map((token) => token.id) ?? []
    );
    if (
      !document.brandKit ||
      !brand ||
      colorTokenIds.some((id) => !colors.has(id)) ||
      typographyTokenIds.some((id) => !typography.has(id))
    ) {
      throw fail('LAYOUT_BRAND_UNAVAILABLE');
    }
  }
  return {
    document: withLayers(document, index, [...page.layers, ...layers]),
    layerIds: layers.map((layer) => layer.id),
  };
};

// ---------------------------------------------------------------------------
// Design blocks (P4-18)
// ---------------------------------------------------------------------------

// A design block's layers copied onto a page exactly as a layout pattern's
// are (the same layer snapshot): in front of the others, centered, every
// layer under a new id, nothing of the block kept in the design, and the
// same refusals as a whole (layer limits, coordinate limits, a Brand Kit
// token the design's exact revision does not have: BLOCK_BRAND_UNAVAILABLE).
// The whole result must also be valid Design Document v1, or nothing is
// inserted (BLOCK_OUT_OF_LIMITS). Whether the images still belong to the
// organization is the caller's check, before this is called
export const insertContentStudioDesignBlock = (
  document: ContentStudioDesignDocumentV1,
  pageId: string,
  content: ContentStudioDesignBlockContentV1,
  brand: ContentStudioBrandKitContentV1 | null
) => {
  let inserted: ReturnType<typeof insertContentStudioDesignLayoutPattern>;
  try {
    inserted = insertContentStudioDesignLayoutPattern(
      document,
      pageId,
      content,
      brand
    );
  } catch (err) {
    if (
      err instanceof ContentStudioDesignEditorError &&
      err.code === 'LAYOUT_BRAND_UNAVAILABLE'
    ) {
      throw fail('BLOCK_BRAND_UNAVAILABLE');
    }
    throw err;
  }
  try {
    parseContentStudioDesignDocument(inserted.document);
  } catch (err) {
    if (err instanceof ContentStudioDesignDocumentError) {
      throw fail('BLOCK_OUT_OF_LIMITS');
    }
    throw err;
  }
  return inserted;
};

// The literal colors the document uses (backgrounds, text and fills), each
// once in first-use order, for quick reuse: at most 12
export const contentStudioDesignDocumentColors = (
  document: ContentStudioDesignDocumentV1
) => {
  const colors: string[] = [];
  const add = (value: ContentStudioDesignColorValue) => {
    if (
      value.type === 'literal' &&
      !colors.includes(value.value) &&
      colors.length < 12
    ) {
      colors.push(value.value);
    }
  };
  for (const page of document.pages) {
    add(page.background.color);
    for (const layer of page.layers) {
      if (layer.type === 'text') {
        add(layer.color);
      } else if (layer.type === 'shape') {
        add(layer.fill);
      }
    }
  }
  return colors;
};

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

export interface ContentStudioDesignEditorHistory {
  past: ContentStudioDesignDocumentV1[];
  present: ContentStudioDesignDocumentV1;
  future: ContentStudioDesignDocumentV1[];
}

export const startContentStudioDesignHistory = (
  document: ContentStudioDesignDocumentV1
): ContentStudioDesignEditorHistory => ({
  past: [],
  present: cloneContentStudioDesignDocument(document),
  future: [],
});

// A change that changes nothing is not a step. At most 50 steps back; a
// new step drops what could be redone
export const applyContentStudioDesignHistory = (
  history: ContentStudioDesignEditorHistory,
  next: ContentStudioDesignDocumentV1
): ContentStudioDesignEditorHistory => {
  if (areContentStudioDesignDocumentsEqual(history.present, next)) {
    return history;
  }
  return {
    past: [...history.past, history.present].slice(-DESIGN_EDITOR_HISTORY_MAX),
    present: cloneContentStudioDesignDocument(next),
    future: [],
  };
};

// A change folded into the last step instead of becoming a new one (a run
// of nudges is one undo step). Without a step to fold into it is a new one
export const amendContentStudioDesignHistory = (
  history: ContentStudioDesignEditorHistory,
  next: ContentStudioDesignDocumentV1
): ContentStudioDesignEditorHistory => {
  if (!history.past.length) {
    return applyContentStudioDesignHistory(history, next);
  }
  if (areContentStudioDesignDocumentsEqual(history.present, next)) {
    return history;
  }
  return {
    past: history.past,
    present: cloneContentStudioDesignDocument(next),
    future: [],
  };
};

export const undoContentStudioDesignHistory = (
  history: ContentStudioDesignEditorHistory
): ContentStudioDesignEditorHistory =>
  history.past.length
    ? {
        past: history.past.slice(0, -1),
        present: history.past[history.past.length - 1],
        future: [history.present, ...history.future],
      }
    : history;

export const redoContentStudioDesignHistory = (
  history: ContentStudioDesignEditorHistory
): ContentStudioDesignEditorHistory =>
  history.future.length
    ? {
        past: [...history.past, history.present],
        present: history.future[0],
        future: history.future.slice(1),
      }
    : history;
