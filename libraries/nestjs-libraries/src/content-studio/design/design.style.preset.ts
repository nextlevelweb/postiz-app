import { isPlainData } from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';
import {
  ContentStudioDesignColorValue,
  ContentStudioDesignDocumentError,
  ContentStudioDesignFontRef,
  ContentStudioDesignLayer,
  ContentStudioDesignShapeLayer,
  ContentStudioDesignTextLayer,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';

// Style Preset v1: a reusable recipe of text or shape style, written into a
// layer when it is applied, never linked to it. A preset holds exactly the
// style fields Design Document v1 already has, with the same values and
// limits (colors and type styles literal or Brand Kit tokens): no id, name,
// geometry, rotation, visibility, text, image, page, Brand Kit reference,
// template guidance or editor state. Applying one copies those values over
// the same fields of a layer of its kind; the layer keeps everything else,
// and the design holds nothing of the preset afterwards. Every value is
// checked by the Design Document v1 parser itself, on a probe layer, so a
// preset can never hold what a design could not. Like the other content
// parsers this file uses no Node-only module

export const DESIGN_STYLE_PRESET_SCHEMA_VERSION = 1;
export const DESIGN_STYLE_PRESET_NAME_MAX = 100;
export const DESIGN_STYLE_PRESET_DESCRIPTION_MAX = 500;

export type ContentStudioDesignStylePresetKind = 'text' | 'shape';
export const DESIGN_STYLE_PRESET_KINDS: ContentStudioDesignStylePresetKind[] = [
  'text',
  'shape',
];

// The style fields of each kind. Opacity is style for both; overflow (how a
// text fits its box) and the shape (rectangle or ellipse) are not
export const DESIGN_TEXT_STYLE_FIELDS = [
  'font',
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'color',
  'align',
  'verticalAlign',
  'opacity',
] as const;
export const DESIGN_SHAPE_STYLE_FIELDS = [
  'fill',
  'cornerRadius',
  'opacity',
] as const;

export type ContentStudioDesignTextStyle = Pick<
  ContentStudioDesignTextLayer,
  (typeof DESIGN_TEXT_STYLE_FIELDS)[number]
>;
export type ContentStudioDesignShapeStyle = Pick<
  ContentStudioDesignShapeLayer,
  (typeof DESIGN_SHAPE_STYLE_FIELDS)[number]
>;

export type ContentStudioDesignStylePresetContentV1 =
  | { schemaVersion: 1; kind: 'text'; style: ContentStudioDesignTextStyle }
  | { schemaVersion: 1; kind: 'shape'; style: ContentStudioDesignShapeStyle };

// INVALID: not Style Preset v1
export class ContentStudioDesignStylePresetError extends Error {
  constructor() {
    super('The style preset does not match schema version 1');
    this.name = 'ContentStudioDesignStylePresetError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// exactly these keys, each present: nothing more, nothing defaulted
const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[]
) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));

// A layer around the style, for the Design Document v1 parser to check
const PROBE = {
  id: 'probe',
  name: '',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  visible: true,
};
const probeText = { text: '', overflow: 'clip' };

const parseStyle = (
  kind: ContentStudioDesignStylePresetKind,
  style: Record<string, unknown>
) => {
  const layer =
    kind === 'text'
      ? { ...PROBE, ...probeText, type: 'text', ...style }
      : { ...PROBE, type: 'shape', shape: 'rectangle', ...style };
  let parsed: ContentStudioDesignLayer;
  try {
    parsed = parseContentStudioDesignDocument({
      schemaVersion: 1,
      brandKit: null,
      pages: [
        {
          id: 'probe',
          name: '',
          width: 100,
          height: 100,
          background: {
            type: 'solid',
            color: { type: 'literal', value: '#ffffff' },
          },
          layers: [layer],
        },
      ],
    }).pages[0].layers[0];
  } catch (err) {
    if (err instanceof ContentStudioDesignDocumentError) {
      throw new ContentStudioDesignStylePresetError();
    }
    throw err;
  }
  return parsed;
};

// Validates and normalizes Style Preset v1 content (from a request, a
// built-in or the database) into a new object, as the Design Document v1
// parser normalizes the same fields (literal colors lowercased, families
// trimmed). The input is never changed; anything else is refused
export function parseContentStudioDesignStylePresetContent(
  input: unknown
): ContentStudioDesignStylePresetContentV1 {
  if (
    !isPlainData(input) ||
    !isRecord(input) ||
    !hasExactKeys(input, ['schemaVersion', 'kind', 'style']) ||
    input.schemaVersion !== DESIGN_STYLE_PRESET_SCHEMA_VERSION ||
    (input.kind !== 'text' && input.kind !== 'shape') ||
    !isRecord(input.style)
  ) {
    throw new ContentStudioDesignStylePresetError();
  }
  const kind = input.kind;
  const fields =
    kind === 'text' ? DESIGN_TEXT_STYLE_FIELDS : DESIGN_SHAPE_STYLE_FIELDS;
  if (!hasExactKeys(input.style, fields)) {
    throw new ContentStudioDesignStylePresetError();
  }
  const parsed = parseStyle(kind, input.style) as unknown as Record<
    string,
    unknown
  >;
  const style = Object.fromEntries(fields.map((key) => [key, parsed[key]]));
  return {
    schemaVersion: 1,
    kind,
    style,
  } as ContentStudioDesignStylePresetContentV1;
}

// The kind a layer's style is, or null for an image: images have no preset
export const designStylePresetKindOf = (
  layer: Pick<ContentStudioDesignLayer, 'type'>
): ContentStudioDesignStylePresetKind | null =>
  layer.type === 'text' || layer.type === 'shape' ? layer.type : null;

// The style of a text or shape layer as preset content: its style fields
// only, deep-copied, and nothing of its id, name, geometry, rotation,
// visibility, text or shape. Null for an image layer
export function extractContentStudioDesignStylePreset(
  layer: ContentStudioDesignLayer
): ContentStudioDesignStylePresetContentV1 | null {
  const kind = designStylePresetKindOf(layer);
  if (!kind) {
    return null;
  }
  const fields =
    kind === 'text' ? DESIGN_TEXT_STYLE_FIELDS : DESIGN_SHAPE_STYLE_FIELDS;
  const source = layer as unknown as Record<string, unknown>;
  const style = JSON.parse(
    JSON.stringify(Object.fromEntries(fields.map((key) => [key, source[key]])))
  );
  return { schemaVersion: 1, kind, style };
}

// The Brand Kit tokens a preset's style uses, each once
export function collectContentStudioDesignStylePresetBrandTokens(
  content: ContentStudioDesignStylePresetContentV1
) {
  const colors: string[] = [];
  const typography: string[] = [];
  const color = (value: ContentStudioDesignColorValue) => {
    if (value.type === 'brand' && !colors.includes(value.tokenId)) {
      colors.push(value.tokenId);
    }
  };
  if (content.kind === 'text') {
    color(content.style.color);
    const font: ContentStudioDesignFontRef = content.style.font;
    if (font.type === 'brand') {
      typography.push(font.tokenId);
    }
  } else {
    color(content.style.fill);
  }
  return { colorTokenIds: colors, typographyTokenIds: typography };
}

// KIND_MISMATCH: a text preset for a shape, or the other way round, or any
// preset for an image
export class ContentStudioDesignStylePresetApplyError extends Error {
  constructor(readonly code: 'KIND_MISMATCH') {
    super('The style preset does not fit this layer');
    this.name = 'ContentStudioDesignStylePresetApplyError';
  }
}

// A new layer with the preset's style written over the same fields: id,
// name, geometry, rotation, visibility, text, overflow and the shape stay.
// An ellipse keeps a corner radius of 0, as Design Document v1 requires.
// Whether the document's exact Brand Kit revision has the tokens the style
// uses is the caller's check, before this is called. Neither the layer nor
// the preset is changed
export function applyContentStudioDesignStylePreset<
  T extends ContentStudioDesignLayer
>(layer: T, content: ContentStudioDesignStylePresetContentV1): T {
  if (designStylePresetKindOf(layer) !== content.kind) {
    throw new ContentStudioDesignStylePresetApplyError('KIND_MISMATCH');
  }
  const style = JSON.parse(JSON.stringify(content.style)) as Record<
    string,
    unknown
  >;
  if (
    layer.type === 'shape' &&
    (layer as ContentStudioDesignShapeLayer).shape === 'ellipse'
  ) {
    style.cornerRadius = 0;
  }
  return { ...(JSON.parse(JSON.stringify(layer)) as T), ...style };
}
