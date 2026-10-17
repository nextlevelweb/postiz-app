import type { ContentStudioBrandKitContentV1 } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import {
  collectContentStudioDesignBrandTokenRefs,
  ContentStudioDesignBrandKitRef,
  ContentStudioDesignColorValue,
  ContentStudioDesignDocumentV1,
  ContentStudioDesignImageLayer,
  ContentStudioDesignLayer,
  ContentStudioDesignPage,
  ContentStudioDesignShapeLayer,
  ContentStudioDesignTextLayer,
  DESIGN_COORDINATE_MAX,
  DESIGN_LAYERS_MAX,
  DESIGN_LAYERS_PER_PAGE_MAX,
  DESIGN_PAGES_MAX,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';

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
  | 'BRAND_TOKENS_MISSING';

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
  const offset = (value: number) =>
    value + 20 <= DESIGN_COORDINATE_MAX ? value + 20 : value;
  const copy = {
    ...(JSON.parse(JSON.stringify(layer)) as ContentStudioDesignLayer),
    id: uniqueId(newContentStudioDesignLayerId, layerIds(document)),
    x: offset(layer.x),
    y: offset(layer.y),
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
