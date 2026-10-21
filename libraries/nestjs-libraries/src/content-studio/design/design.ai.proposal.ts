import { z } from 'zod';
import {
  isPlainData,
  trimmedText,
} from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';
import { contentPackageItemText } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  BRAND_FONT_STYLES,
  BRAND_FONT_WEIGHTS,
  BRAND_TOKEN_ID,
  ContentStudioBrandKitContentV1,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import {
  ContentStudioDesignColorValue,
  ContentStudioDesignDocumentV1,
  ContentStudioDesignFontRef,
  ContentStudioDesignLayer,
  DESIGN_COORDINATE_MAX,
  DESIGN_FONT_SIZE_MAX,
  DESIGN_FONT_SIZE_MIN,
  DESIGN_CORNER_RADIUS_MAX,
  DESIGN_LETTER_SPACING_MAX,
  DESIGN_LINE_HEIGHT_MAX,
  DESIGN_LINE_HEIGHT_MIN,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';

// Design Creative AI proposals (P6-02): what an AI may suggest for one exact
// saved design revision, as a short list of operations on what is already
// there. Never a document: an operation changes the text, the text or shape
// style, the box of an existing layer, or a page background, and nothing
// else. No layer or page is added, removed or reordered, no image source,
// mask, Media id, URL, SVG, CSS or new font can be named. The model sees
// pages, layers, fonts and Brand Kit colors as tokens (PAGE_1, TEXT_2,
// SHAPE_1, IMAGE_1, FONT_1, COLOR_3) made here from the document, never an
// id; its answer is mapped back to the exact ids and values, and anything
// unknown, not allowed for the intent or out of range refuses the whole
// answer. The same pure code applies an accepted proposal in the editor and
// checks it on the server: the result is parsed as Design Document v1 again.
// Like the other design modules this file uses no Node-only module

export const DESIGN_AI_PROPOSAL_SCHEMA_VERSION = 1;

// What the user can ask for, in three groups. Copy rewrites text only,
// style changes the look of existing layers, layout moves and sizes them
export const DESIGN_AI_INTENTS = [
  'improve_copy',
  'tighten_copy',
  'adapt_tone',
  'improve_hierarchy',
  'restyle',
  'rebalance_layout',
] as const;
export type ContentStudioDesignAIIntent = (typeof DESIGN_AI_INTENTS)[number];

export const isContentStudioDesignAIIntent = (
  value: unknown
): value is ContentStudioDesignAIIntent =>
  typeof value === 'string' &&
  (DESIGN_AI_INTENTS as readonly string[]).includes(value);

export const DESIGN_AI_COPY_INTENTS: readonly ContentStudioDesignAIIntent[] = [
  'improve_copy',
  'tighten_copy',
  'adapt_tone',
];

export const DESIGN_AI_OPERATION_TYPES = [
  'set_text',
  'set_text_style',
  'set_shape_style',
  'set_page_background',
  'set_bounds',
] as const;
export type ContentStudioDesignAIOperationType =
  (typeof DESIGN_AI_OPERATION_TYPES)[number];

type LayerType = ContentStudioDesignLayer['type'];

// The operations each intent allows, with the layer types each may target.
// A page background has no layer
export const DESIGN_AI_INTENT_OPERATIONS: Record<
  ContentStudioDesignAIIntent,
  Partial<Record<ContentStudioDesignAIOperationType, readonly LayerType[]>>
> = {
  improve_copy: { set_text: ['text'] },
  tighten_copy: { set_text: ['text'] },
  adapt_tone: { set_text: ['text'] },
  improve_hierarchy: { set_text_style: ['text'], set_bounds: ['text'] },
  restyle: {
    set_text_style: ['text'],
    set_shape_style: ['shape'],
    set_page_background: [],
    set_bounds: ['text', 'shape', 'image'],
  },
  rebalance_layout: { set_bounds: ['text', 'shape', 'image'] },
};

export const DESIGN_AI_OPERATIONS_MAX = 50;
export const DESIGN_AI_SUMMARY_MAX = 1000;
// the smallest box a suggestion may give a layer, in design units
export const DESIGN_AI_BOX_MIN = 1;

const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
const VERTICAL_ALIGNS = ['top', 'middle', 'bottom'] as const;

const ERROR_MESSAGE = 'The design suggestion does not fit this design';

// A fixed message: never the model's text, a token or an id
export class ContentStudioDesignAIProposalError extends Error {
  constructor() {
    super(ERROR_MESSAGE);
    this.name = 'ContentStudioDesignAIProposalError';
  }
}

const invalid = () => new ContentStudioDesignAIProposalError();

// ---------------------------------------------------------------------------
// Tokens: the names the model sees, made from the document and its kit
// ---------------------------------------------------------------------------

const LAYER_TOKEN_PREFIX: Record<LayerType, string> = {
  text: 'TEXT',
  shape: 'SHAPE',
  image: 'IMAGE',
};

export interface ContentStudioDesignAIPageRef {
  token: string;
  pageId: string;
}

export interface ContentStudioDesignAILayerRef {
  token: string;
  pageId: string;
  layerId: string;
  type: LayerType;
}

export interface ContentStudioDesignAIFontRef {
  token: string;
  font: ContentStudioDesignFontRef;
}

export interface ContentStudioDesignAIColorRef {
  token: string;
  tokenId: string;
}

export interface ContentStudioDesignAIReferences {
  pages: ContentStudioDesignAIPageRef[];
  layers: ContentStudioDesignAILayerRef[];
  // the only fonts a suggestion can use: the Brand Kit typography tokens,
  // then every family font the document already uses
  fonts: ContentStudioDesignAIFontRef[];
  // the Brand Kit color tokens; any other color is a literal #rrggbb
  colors: ContentStudioDesignAIColorRef[];
}

const sameFont = (
  left: ContentStudioDesignFontRef,
  right: ContentStudioDesignFontRef
) =>
  left.type === 'brand' || right.type === 'brand'
    ? left.type === right.type &&
      (left as { tokenId: string }).tokenId ===
        (right as { tokenId: string }).tokenId
    : left.family === right.family &&
      left.weight === right.weight &&
      left.style === right.style;

// Tokens in document order: pages from 1, layers per type from 1 across all
// pages. The kit must be the exact revision the document names, or null
// when it names none
export function contentStudioDesignAIReferences(
  document: ContentStudioDesignDocumentV1,
  brand: ContentStudioBrandKitContentV1 | null
): ContentStudioDesignAIReferences {
  const counts: Record<LayerType, number> = { text: 0, shape: 0, image: 0 };
  const pages: ContentStudioDesignAIPageRef[] = [];
  const layers: ContentStudioDesignAILayerRef[] = [];
  const fonts: ContentStudioDesignAIFontRef[] = (brand?.typography ?? []).map(
    (token, index) => ({
      token: `FONT_${index + 1}`,
      font: { type: 'brand', tokenId: token.id },
    })
  );
  document.pages.forEach((page, pageIndex) => {
    pages.push({ token: `PAGE_${pageIndex + 1}`, pageId: page.id });
    for (const layer of page.layers) {
      counts[layer.type] += 1;
      layers.push({
        token: `${LAYER_TOKEN_PREFIX[layer.type]}_${counts[layer.type]}`,
        pageId: page.id,
        layerId: layer.id,
        type: layer.type,
      });
      if (
        layer.type === 'text' &&
        layer.font.type === 'family' &&
        !fonts.some((entry) => sameFont(entry.font, layer.font))
      ) {
        fonts.push({
          token: `FONT_${fonts.length + 1}`,
          font: { ...layer.font },
        });
      }
    }
  });
  return {
    pages,
    layers,
    fonts,
    colors: (brand?.colors ?? []).map((token, index) => ({
      token: `COLOR_${index + 1}`,
      tokenId: token.id,
    })),
  };
}

// The token of a font or color as the document has it, for the prompt
export const contentStudioDesignAIFontToken = (
  references: ContentStudioDesignAIReferences,
  font: ContentStudioDesignFontRef
) => references.fonts.find((entry) => sameFont(entry.font, font))?.token;

export const contentStudioDesignAIColorToken = (
  references: ContentStudioDesignAIReferences,
  color: ContentStudioDesignColorValue
) =>
  color.type === 'brand'
    ? references.colors.find((entry) => entry.tokenId === color.tokenId)?.token
    : undefined;

// ---------------------------------------------------------------------------
// The model's answer, exactly as it must be written
// ---------------------------------------------------------------------------

// Tokens and colors are short: anything longer cannot be one
const reference = z.string().max(16);
const number = z.number().finite();

const modelOperation = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('set_text'),
      layer: reference,
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('set_text_style'),
      layer: reference,
      fontSize: number.optional(),
      lineHeight: number.optional(),
      letterSpacing: number.optional(),
      align: z.enum(TEXT_ALIGNS).optional(),
      verticalAlign: z.enum(VERTICAL_ALIGNS).optional(),
      color: reference.optional(),
      font: reference.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('set_shape_style'),
      layer: reference,
      fill: reference.optional(),
      cornerRadius: number.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('set_page_background'),
      page: reference,
      color: reference,
    })
    .strict(),
  z
    .object({
      type: z.literal('set_bounds'),
      layer: reference,
      x: number,
      y: number,
      width: number,
      height: number,
    })
    .strict(),
]);

const modelProposal = z
  .object({
    summary: z.string(),
    operations: z.array(modelOperation).min(1).max(DESIGN_AI_OPERATIONS_MAX),
  })
  .strict();

type ModelOperation = z.output<typeof modelOperation>;

// ---------------------------------------------------------------------------
// The proposal as the server answers it: exact ids and values
// ---------------------------------------------------------------------------

const PAGE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const LAYER_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/;

const colorValue = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('literal'), value: z.string().regex(HEX_COLOR) })
    .strict(),
  z
    .object({
      type: z.literal('brand'),
      tokenId: z.string().regex(BRAND_TOKEN_ID),
    })
    .strict(),
]);

const fontRef = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('family'),
      family: trimmedText(200, 1),
      weight: z
        .number()
        .refine((weight) =>
          (BRAND_FONT_WEIGHTS as readonly number[]).includes(weight)
        ),
      style: z.enum(BRAND_FONT_STYLES),
    })
    .strict(),
  z
    .object({
      type: z.literal('brand'),
      tokenId: z.string().regex(BRAND_TOKEN_ID),
    })
    .strict(),
]);

const layerId = z.string().regex(LAYER_ID);
const coordinate = number
  .min(-DESIGN_COORDINATE_MAX)
  .max(DESIGN_COORDINATE_MAX);
const size = number.min(DESIGN_AI_BOX_MIN).max(DESIGN_COORDINATE_MAX);

const proposalOperation = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('set_text'),
      layerId,
      text: contentPackageItemText,
    })
    .strict(),
  z
    .object({
      type: z.literal('set_text_style'),
      layerId,
      fontSize: number
        .min(DESIGN_FONT_SIZE_MIN)
        .max(DESIGN_FONT_SIZE_MAX)
        .optional(),
      lineHeight: number
        .min(DESIGN_LINE_HEIGHT_MIN)
        .max(DESIGN_LINE_HEIGHT_MAX)
        .optional(),
      letterSpacing: number
        .min(-DESIGN_LETTER_SPACING_MAX)
        .max(DESIGN_LETTER_SPACING_MAX)
        .optional(),
      align: z.enum(TEXT_ALIGNS).optional(),
      verticalAlign: z.enum(VERTICAL_ALIGNS).optional(),
      color: colorValue.optional(),
      font: fontRef.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('set_shape_style'),
      layerId,
      fill: colorValue.optional(),
      cornerRadius: number.min(0).max(DESIGN_CORNER_RADIUS_MAX).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('set_page_background'),
      pageId: z.string().regex(PAGE_ID),
      color: colorValue,
    })
    .strict(),
  z
    .object({
      type: z.literal('set_bounds'),
      layerId,
      x: coordinate,
      y: coordinate,
      width: size,
      height: size,
    })
    .strict(),
]);

const proposalSchema = z
  .object({
    schemaVersion: z.literal(DESIGN_AI_PROPOSAL_SCHEMA_VERSION),
    intent: z.enum(DESIGN_AI_INTENTS),
    summary: trimmedText(DESIGN_AI_SUMMARY_MAX, 1),
    operations: z.array(proposalOperation).min(1).max(DESIGN_AI_OPERATIONS_MAX),
  })
  .strict();

export type ContentStudioDesignAIOperation =
  | { type: 'set_text'; layerId: string; text: string }
  | {
      type: 'set_text_style';
      layerId: string;
      fontSize?: number;
      lineHeight?: number;
      letterSpacing?: number;
      align?: (typeof TEXT_ALIGNS)[number];
      verticalAlign?: (typeof VERTICAL_ALIGNS)[number];
      color?: ContentStudioDesignColorValue;
      font?: ContentStudioDesignFontRef;
    }
  | {
      type: 'set_shape_style';
      layerId: string;
      fill?: ContentStudioDesignColorValue;
      cornerRadius?: number;
    }
  | {
      type: 'set_page_background';
      pageId: string;
      color: ContentStudioDesignColorValue;
    }
  | {
      type: 'set_bounds';
      layerId: string;
      x: number;
      y: number;
      width: number;
      height: number;
    };

export interface ContentStudioDesignAIProposalV1 {
  schemaVersion: 1;
  intent: ContentStudioDesignAIIntent;
  // the model's own words, for the user only: never what is applied
  summary: string;
  operations: ContentStudioDesignAIOperation[];
}

// A proposal as stored nowhere but passed around: exactly the shape above,
// or ContentStudioDesignAIProposalError. Nothing is repaired
export function parseContentStudioDesignAIProposal(
  value: unknown
): ContentStudioDesignAIProposalV1 {
  if (!isPlainData(value)) {
    throw invalid();
  }
  const result = proposalSchema.safeParse(value);
  if (!result.success) {
    throw invalid();
  }
  return result.data as ContentStudioDesignAIProposalV1;
}

// ---------------------------------------------------------------------------
// From the model's answer to a proposal
// ---------------------------------------------------------------------------

const target = (operation: ModelOperation) =>
  operation.type === 'set_page_background' ? operation.page : operation.layer;

// What the model may write for a color: a literal #rrggbb (any case, stored
// lowercase) or a Brand Kit color token of the prompt
const resolveColor = (
  references: ContentStudioDesignAIReferences,
  value: string
): ContentStudioDesignColorValue => {
  if (/^#[0-9A-Fa-f]{6}$/.test(value)) {
    return { type: 'literal', value: value.toLowerCase() };
  }
  const color = references.colors.find((entry) => entry.token === value);
  if (!color) {
    throw invalid();
  }
  return { type: 'brand', tokenId: color.tokenId };
};

const resolveFont = (
  references: ContentStudioDesignAIReferences,
  value: string
): ContentStudioDesignFontRef => {
  const font = references.fonts.find((entry) => entry.token === value);
  if (!font) {
    throw invalid();
  }
  return { ...font.font };
};

// Only the fields given, so a missing one stays as it is
const defined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T;

// The model's answer to one intent, as a proposal for exactly this document
// and kit: one JSON object, nothing around it (no Markdown fence), every
// operation of the intent's kinds on a token of this document, each target
// changed by one operation of a kind at most, and the document with all of
// them applied still valid Design Document v1. Anything else, in any
// operation, refuses the whole answer: nothing is cut, guessed or partly
// kept
export function resolveContentStudioDesignAIProposal(input: {
  document: ContentStudioDesignDocumentV1;
  brand: ContentStudioBrandKitContentV1 | null;
  intent: ContentStudioDesignAIIntent;
  raw: unknown;
}): ContentStudioDesignAIProposalV1 {
  if (
    !isContentStudioDesignAIIntent(input.intent) ||
    typeof input.raw !== 'string'
  ) {
    throw invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch {
    throw invalid();
  }
  const answer = modelProposal.safeParse(parsed);
  if (!answer.success) {
    throw invalid();
  }
  const allowed = DESIGN_AI_INTENT_OPERATIONS[input.intent];
  const references = contentStudioDesignAIReferences(
    input.document,
    input.brand
  );
  const seen = new Set<string>();
  const operations = answer.data.operations.map(
    (operation): ContentStudioDesignAIOperation => {
      const layerTypes = allowed[operation.type];
      const key = `${operation.type}:${target(operation)}`;
      if (!layerTypes || seen.has(key)) {
        throw invalid();
      }
      seen.add(key);
      if (operation.type === 'set_page_background') {
        const page = references.pages.find(
          (entry) => entry.token === operation.page
        );
        if (!page) {
          throw invalid();
        }
        return {
          type: 'set_page_background',
          pageId: page.pageId,
          color: resolveColor(references, operation.color),
        };
      }
      const layer = references.layers.find(
        (entry) => entry.token === operation.layer
      );
      if (!layer || !layerTypes.includes(layer.type)) {
        throw invalid();
      }
      switch (operation.type) {
        case 'set_text':
          return {
            type: 'set_text',
            layerId: layer.layerId,
            text: operation.text,
          };
        case 'set_text_style':
          return defined({
            type: 'set_text_style',
            layerId: layer.layerId,
            fontSize: operation.fontSize,
            lineHeight: operation.lineHeight,
            letterSpacing: operation.letterSpacing,
            align: operation.align,
            verticalAlign: operation.verticalAlign,
            color:
              operation.color === undefined
                ? undefined
                : resolveColor(references, operation.color),
            font:
              operation.font === undefined
                ? undefined
                : resolveFont(references, operation.font),
          });
        case 'set_shape_style':
          return defined({
            type: 'set_shape_style',
            layerId: layer.layerId,
            fill:
              operation.fill === undefined
                ? undefined
                : resolveColor(references, operation.fill),
            cornerRadius: operation.cornerRadius,
          });
        default:
          return {
            type: 'set_bounds',
            layerId: layer.layerId,
            x: operation.x,
            y: operation.y,
            width: operation.width,
            height: operation.height,
          };
      }
    }
  );
  const proposal = parseContentStudioDesignAIProposal({
    schemaVersion: DESIGN_AI_PROPOSAL_SCHEMA_VERSION,
    intent: input.intent,
    summary: answer.data.summary,
    operations,
  });
  // the whole result must be a valid design of this kit
  applyContentStudioDesignAIProposal(input.document, proposal, input.brand);
  return proposal;
}

// ---------------------------------------------------------------------------
// Applying a proposal
// ---------------------------------------------------------------------------

const STYLE_FIELDS = [
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'align',
  'verticalAlign',
  'color',
  'font',
] as const;

// A style operation that changes nothing is no operation
const hasChange = (operation: ContentStudioDesignAIOperation) => {
  switch (operation.type) {
    case 'set_text_style':
      return STYLE_FIELDS.some((field) => operation[field] !== undefined);
    case 'set_shape_style':
      return (
        operation.fill !== undefined || operation.cornerRadius !== undefined
      );
    default:
      return true;
  }
};

// The document with the proposal's operations applied in order, as a new
// valid Design Document v1; the input is never changed. Every target must be
// a layer of that type (or a page) of exactly this document, a box must
// overlap its page, a text must keep something besides whitespace, and with
// a kit every Brand Kit token must be one of that kit. Anything else throws
// ContentStudioDesignAIProposalError and nothing is applied
export function applyContentStudioDesignAIProposal(
  document: ContentStudioDesignDocumentV1,
  value: ContentStudioDesignAIProposalV1,
  brand?: ContentStudioBrandKitContentV1 | null
): ContentStudioDesignDocumentV1 {
  const proposal = parseContentStudioDesignAIProposal(value);
  let draft: ContentStudioDesignDocumentV1;
  try {
    // a deep copy, as the parser builds a new object
    draft = parseContentStudioDesignDocument(document);
  } catch {
    throw invalid();
  }
  const findLayer = (id: string) => {
    for (const page of draft.pages) {
      const layer = page.layers.find((entry) => entry.id === id);
      if (layer) {
        return { page, layer };
      }
    }
    throw invalid();
  };
  const colors = new Set((brand?.colors ?? []).map((token) => token.id));
  const typography = new Set(
    (brand?.typography ?? []).map((token) => token.id)
  );
  const checkColor = (color: ContentStudioDesignColorValue | undefined) => {
    if (
      brand !== undefined &&
      color?.type === 'brand' &&
      !colors.has(color.tokenId)
    ) {
      throw invalid();
    }
  };

  for (const operation of proposal.operations) {
    if (!hasChange(operation)) {
      throw invalid();
    }
    if (operation.type === 'set_page_background') {
      const page = draft.pages.find((entry) => entry.id === operation.pageId);
      if (!page) {
        throw invalid();
      }
      checkColor(operation.color);
      page.background = { type: 'solid', color: { ...operation.color } };
      continue;
    }
    const { page, layer } = findLayer(operation.layerId);
    switch (operation.type) {
      case 'set_text':
        if (layer.type !== 'text' || !operation.text.trim()) {
          throw invalid();
        }
        layer.text = operation.text;
        break;
      case 'set_text_style': {
        if (layer.type !== 'text') {
          throw invalid();
        }
        checkColor(operation.color);
        if (
          brand !== undefined &&
          operation.font?.type === 'brand' &&
          !typography.has(operation.font.tokenId)
        ) {
          throw invalid();
        }
        for (const field of STYLE_FIELDS) {
          const next = operation[field];
          if (next !== undefined) {
            Object.assign(layer, {
              [field]: typeof next === 'object' ? { ...next } : next,
            });
          }
        }
        break;
      }
      case 'set_shape_style':
        if (layer.type !== 'shape') {
          throw invalid();
        }
        checkColor(operation.fill);
        if (operation.fill !== undefined) {
          layer.fill = { ...operation.fill };
        }
        if (operation.cornerRadius !== undefined) {
          layer.cornerRadius = operation.cornerRadius;
        }
        break;
      default:
        // the box stays on its page: a layer moved off it would be gone
        if (
          operation.x >= page.width ||
          operation.y >= page.height ||
          operation.x + operation.width <= 0 ||
          operation.y + operation.height <= 0
        ) {
          throw invalid();
        }
        layer.x = operation.x;
        layer.y = operation.y;
        layer.width = operation.width;
        layer.height = operation.height;
    }
  }
  try {
    return parseContentStudioDesignDocument(draft);
  } catch {
    throw invalid();
  }
}

// ---------------------------------------------------------------------------
// What a proposal changes, for people: from the documents, never the summary
// ---------------------------------------------------------------------------

export type ContentStudioDesignAIStyleField =
  | (typeof STYLE_FIELDS)[number]
  | 'fill'
  | 'cornerRadius';

interface LayerChangeBase {
  pageId: string;
  layerId: string;
  layerName: string;
  layerType: LayerType;
}

export type ContentStudioDesignAIChange =
  | (LayerChangeBase & { kind: 'text'; before: string; after: string })
  | (LayerChangeBase & {
      kind: 'style';
      field: ContentStudioDesignAIStyleField;
      before: unknown;
      after: unknown;
    })
  | (LayerChangeBase & {
      kind: 'bounds';
      before: { x: number; y: number; width: number; height: number };
      after: { x: number; y: number; width: number; height: number };
    })
  | {
      kind: 'background';
      pageId: string;
      pageName: string;
      before: ContentStudioDesignColorValue;
      after: ContentStudioDesignColorValue;
    };

const sameValue = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

// Every value that differs between the document and the document with the
// proposal applied, in the order of the operations: fields a suggestion set
// to what they already were are not listed
export function describeContentStudioDesignAIProposal(
  document: ContentStudioDesignDocumentV1,
  proposal: ContentStudioDesignAIProposalV1,
  brand?: ContentStudioBrandKitContentV1 | null
): ContentStudioDesignAIChange[] {
  const after = applyContentStudioDesignAIProposal(document, proposal, brand);
  const layerIn = (source: ContentStudioDesignDocumentV1, id: string) => {
    for (const page of source.pages) {
      const layer = page.layers.find((entry) => entry.id === id);
      if (layer) {
        return { page, layer };
      }
    }
    throw invalid();
  };
  const changes: ContentStudioDesignAIChange[] = [];
  for (const operation of proposal.operations) {
    if (operation.type === 'set_page_background') {
      const index = document.pages.findIndex(
        (page) => page.id === operation.pageId
      );
      const before = document.pages[index];
      const next = after.pages[index];
      if (!sameValue(before.background.color, next.background.color)) {
        changes.push({
          kind: 'background',
          pageId: before.id,
          pageName: before.name,
          before: before.background.color,
          after: next.background.color,
        });
      }
      continue;
    }
    const { page, layer } = layerIn(document, operation.layerId);
    const next = layerIn(after, operation.layerId).layer;
    const base = {
      pageId: page.id,
      layerId: layer.id,
      layerName: layer.name,
      layerType: layer.type,
    };
    if (operation.type === 'set_text') {
      if (
        layer.type === 'text' &&
        next.type === 'text' &&
        layer.text !== next.text
      ) {
        changes.push({
          ...base,
          kind: 'text',
          before: layer.text,
          after: next.text,
        });
      }
      continue;
    }
    if (operation.type === 'set_bounds') {
      const box = (entry: ContentStudioDesignLayer) => ({
        x: entry.x,
        y: entry.y,
        width: entry.width,
        height: entry.height,
      });
      if (!sameValue(box(layer), box(next))) {
        changes.push({
          ...base,
          kind: 'bounds',
          before: box(layer),
          after: box(next),
        });
      }
      continue;
    }
    const fields: ContentStudioDesignAIStyleField[] =
      operation.type === 'set_text_style'
        ? STYLE_FIELDS.filter((field) => operation[field] !== undefined)
        : (['fill', 'cornerRadius'] as const).filter(
            (field) => operation[field] !== undefined
          );
    for (const field of fields) {
      const before = (layer as unknown as Record<string, unknown>)[field];
      const value = (next as unknown as Record<string, unknown>)[field];
      if (!sameValue(before, value)) {
        changes.push({ ...base, kind: 'style', field, before, after: value });
      }
    }
  }
  return changes;
}
