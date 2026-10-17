import { z } from 'zod';
import {
  isPlainData,
  trimmedText,
} from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';
import {
  ContentStudioDesignBrandKitRef,
  ContentStudioDesignDocumentV1,
  DESIGN_TEXT_MAX,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';

// Template Guidance v1: what a design template revision says about how to
// customize it, kept next to its Design Document v1, never inside it. A
// field (a slot) names one text or image layer of that exact document by
// its page id and layer id, with a label, an optional description and
// whether a value is required; the order of the slots is the order of the
// fields. One switch says whether the template may be used with another
// exact Brand Kit revision. Guidance is checked against the document it
// belongs to: a slot naming a page or layer the document does not have, or
// a layer of the other kind, is refused, never dropped. A design made from a
// template holds none of this: customizing writes text and image references
// into a copy of the document, and the copy is an ordinary Design Document
// v1. Plain data only: no HTML, script, URL, Media bytes or secret. Like the
// other content parsers this file uses no Node-only module

export const DESIGN_TEMPLATE_GUIDANCE_SCHEMA_VERSION = 1;

export const DESIGN_TEMPLATE_SLOTS_MAX = 100;
export const DESIGN_TEMPLATE_SLOT_ID_MAX = 64;
export const DESIGN_TEMPLATE_SLOT_LABEL_MAX = 120;
export const DESIGN_TEMPLATE_SLOT_DESCRIPTION_MAX = 500;

// the layer id rule of the document; page and layer ids are matched against
// the document itself
const SLOT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// the Design Document image rule (the Content Package media id rule)
const MEDIA_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// Labels are shown as plain text: markup and links are refused, not escaped
const MARKUP_OR_LINK =
  /[<>]|\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\bjavascript:|\bdata:/i;

const plainLabel = (max: number) =>
  trimmedText(max, 1).refine(
    (text) => !MARKUP_OR_LINK.test(text),
    'Markup or link'
  );

const slotBase = {
  id: z.string().regex(SLOT_ID),
  label: plainLabel(DESIGN_TEMPLATE_SLOT_LABEL_MAX),
  description: plainLabel(DESIGN_TEMPLATE_SLOT_DESCRIPTION_MAX).optional(),
  pageId: z.string().min(1).max(DESIGN_TEMPLATE_SLOT_ID_MAX),
  layerId: z.string().min(1).max(DESIGN_TEMPLATE_SLOT_ID_MAX),
  required: z.boolean(),
};

const textSlot = z
  .object({
    ...slotBase,
    type: z.literal('text'),
    // a field of several lines or of one
    multiline: z.boolean(),
  })
  .strict();

const imageSlot = z
  .object({
    ...slotBase,
    type: z.literal('image'),
  })
  .strict();

const guidanceSchema = z
  .object({
    schemaVersion: z.literal(DESIGN_TEMPLATE_GUIDANCE_SCHEMA_VERSION),
    // whether the template may be used with another exact Brand Kit revision
    brandRebinding: z.boolean(),
    slots: z
      .array(z.discriminatedUnion('type', [textSlot, imageSlot]))
      .max(DESIGN_TEMPLATE_SLOTS_MAX),
  })
  .strict()
  .superRefine((guidance, context) => {
    const ids = new Set<string>();
    const targets = new Set<string>();
    guidance.slots.forEach((slot, index) => {
      if (ids.has(slot.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['slots', index, 'id'],
          message: 'Duplicate slot id',
        });
      }
      ids.add(slot.id);
      // one field per layer: layer ids are unique across the document
      if (targets.has(slot.layerId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['slots', index, 'layerId'],
          message: 'Duplicate slot target',
        });
      }
      targets.add(slot.layerId);
    });
  });

export interface ContentStudioDesignTemplateTextSlot {
  id: string;
  type: 'text';
  label: string;
  description?: string;
  pageId: string;
  layerId: string;
  required: boolean;
  multiline: boolean;
}

export interface ContentStudioDesignTemplateImageSlot {
  id: string;
  type: 'image';
  label: string;
  description?: string;
  pageId: string;
  layerId: string;
  required: boolean;
}

export type ContentStudioDesignTemplateSlot =
  | ContentStudioDesignTemplateTextSlot
  | ContentStudioDesignTemplateImageSlot;

export interface ContentStudioDesignTemplateGuidanceV1 {
  schemaVersion: 1;
  brandRebinding: boolean;
  slots: ContentStudioDesignTemplateSlot[];
}

// INVALID: not Template Guidance v1. STALE: valid on its own, but not for
// this document (a page, layer or kind it does not have, or Brand Kit
// rebinding for a document without a Brand Kit)
export type ContentStudioDesignTemplateGuidanceErrorCode = 'INVALID' | 'STALE';

const GUIDANCE_MESSAGES: Record<
  ContentStudioDesignTemplateGuidanceErrorCode,
  string
> = {
  INVALID: 'The template guidance does not match schema version 1',
  STALE: 'The template guidance does not match its design document',
};

// Fixed messages, and issues carry only the path and the kind of problem
export class ContentStudioDesignTemplateGuidanceError extends Error {
  constructor(
    readonly code: ContentStudioDesignTemplateGuidanceErrorCode,
    readonly issues: Array<{ path: Array<string | number>; code: string }> = []
  ) {
    super(GUIDANCE_MESSAGES[code]);
    this.name = 'ContentStudioDesignTemplateGuidanceError';
  }
}

// Validates and normalizes guidance (from a request, a built-in template or
// the database) for exactly this parsed document, into a new object: labels
// and descriptions trimmed, nothing else changed. Every slot must name a
// layer of its page of the kind it fills; Brand Kit rebinding needs a
// document with a Brand Kit reference. Anything else is refused, never
// repaired: nothing is dropped, merged, reordered or defaulted
export function parseContentStudioDesignTemplateGuidance(
  input: unknown,
  document: ContentStudioDesignDocumentV1
): ContentStudioDesignTemplateGuidanceV1 {
  if (!isPlainData(input)) {
    throw new ContentStudioDesignTemplateGuidanceError('INVALID', [
      { path: [], code: 'not_plain_data' },
    ]);
  }
  const result = guidanceSchema.safeParse(input);
  if (!result.success) {
    throw new ContentStudioDesignTemplateGuidanceError(
      'INVALID',
      result.error.issues.map(({ path, code }) => ({ path, code }))
    );
  }
  const guidance = result.data as ContentStudioDesignTemplateGuidanceV1;
  const issues: Array<{ path: Array<string | number>; code: string }> = [];
  guidance.slots.forEach((slot, index) => {
    const page = document.pages.find((entry) => entry.id === slot.pageId);
    const layer = page?.layers.find((entry) => entry.id === slot.layerId);
    if (!page) {
      issues.push({ path: ['slots', index, 'pageId'], code: 'missing_page' });
    } else if (!layer) {
      issues.push({ path: ['slots', index, 'layerId'], code: 'missing_layer' });
    } else if (layer.type !== slot.type) {
      issues.push({ path: ['slots', index, 'type'], code: 'wrong_layer' });
    }
  });
  if (guidance.brandRebinding && !document.brandKit) {
    issues.push({ path: ['brandRebinding'], code: 'no_brand_kit' });
  }
  if (issues.length) {
    throw new ContentStudioDesignTemplateGuidanceError('STALE', issues);
  }
  return guidance;
}

// ---------------------------------------------------------------------------
// Customization: a template's document with the values given for its fields
// ---------------------------------------------------------------------------

// A text field takes plain text, kept as written (the document normalizes
// line endings); an image field takes the exact Media reference the server
// made for a Media item of the organization
export type ContentStudioDesignTemplateValue =
  | string
  | { mediaId: string; sha256: string };

const valueSchema = z.union([
  z.string().max(DESIGN_TEXT_MAX),
  z
    .object({
      mediaId: z.string().regex(MEDIA_ID),
      sha256: z.string().regex(SHA256_HEX),
    })
    .strict(),
]);

// UNKNOWN_FIELD: a value for a field the guidance does not have. FIELD_TYPE:
// a value of the wrong kind for its field. REQUIRED_FIELD: a required field
// without a value. INVALID: values that are not field values at all.
// BRAND_REBIND_UNSUPPORTED: another Brand Kit revision for a template that
// does not allow it. STALE: guidance that does not match the document
export type ContentStudioDesignTemplateCustomizationErrorCode =
  | 'INVALID'
  | 'UNKNOWN_FIELD'
  | 'FIELD_TYPE'
  | 'REQUIRED_FIELD'
  | 'BRAND_REBIND_UNSUPPORTED'
  | 'STALE';

// A fixed message only: never a value, label or id
export class ContentStudioDesignTemplateCustomizationError extends Error {
  constructor(
    readonly code: ContentStudioDesignTemplateCustomizationErrorCode
  ) {
    super('The template customization is invalid');
    this.name = 'ContentStudioDesignTemplateCustomizationError';
  }
}

// The values of a request, by field id: at most one per field, each text or
// an exact Media reference. Their fields are checked by the customization
export function parseContentStudioDesignTemplateValues(
  input: unknown
): Record<string, ContentStudioDesignTemplateValue> {
  if (input === undefined) {
    return {};
  }
  if (
    !isPlainData(input) ||
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new ContentStudioDesignTemplateCustomizationError('INVALID');
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > DESIGN_TEMPLATE_SLOTS_MAX) {
    throw new ContentStudioDesignTemplateCustomizationError('INVALID');
  }
  const values: Record<string, ContentStudioDesignTemplateValue> =
    Object.create(null);
  for (const [id, value] of entries) {
    const parsed = valueSchema.safeParse(value);
    if (!SLOT_ID.test(id) || !parsed.success) {
      throw new ContentStudioDesignTemplateCustomizationError('INVALID');
    }
    values[id] = parsed.data as ContentStudioDesignTemplateValue;
  }
  return values;
}

// A new document from a template's document: each value replaces exactly
// the text, or exactly the image reference, of its field's layer (id,
// geometry, style, crop and everything else stay), and an exact Brand Kit
// reference, when given, replaces only the document's reference. A field
// left out keeps the template's own text or image; a required one may not
// be left out (a required text needs more than whitespace). A value for an
// unknown field or of the wrong kind, or a Brand Kit for a template that
// does not allow one, is refused: nothing is ignored. Whether the Brand Kit
// revision has every token the document uses is the caller's check against
// that revision. The template's document is never changed. The result is
// parsed as Design Document v1 again (which may refuse it, for too much
// text, say) and holds nothing of the template or its guidance
export function applyContentStudioDesignTemplateCustomization(input: {
  document: ContentStudioDesignDocumentV1;
  guidance: ContentStudioDesignTemplateGuidanceV1 | null;
  values: Record<string, ContentStudioDesignTemplateValue>;
  brandKit?: ContentStudioDesignBrandKitRef;
}): ContentStudioDesignDocumentV1 {
  const slots = input.guidance?.slots ?? [];
  for (const id of Object.keys(input.values)) {
    if (!slots.some((slot) => slot.id === id)) {
      throw new ContentStudioDesignTemplateCustomizationError('UNKNOWN_FIELD');
    }
  }
  if (
    input.brandKit &&
    (!input.guidance?.brandRebinding || !input.document.brandKit)
  ) {
    throw new ContentStudioDesignTemplateCustomizationError(
      'BRAND_REBIND_UNSUPPORTED'
    );
  }
  const document = JSON.parse(
    JSON.stringify(input.document)
  ) as ContentStudioDesignDocumentV1;
  for (const slot of slots) {
    const value = Object.prototype.hasOwnProperty.call(input.values, slot.id)
      ? input.values[slot.id]
      : undefined;
    if (
      slot.required &&
      (value === undefined || (typeof value === 'string' && !value.trim()))
    ) {
      throw new ContentStudioDesignTemplateCustomizationError('REQUIRED_FIELD');
    }
    if (value === undefined) {
      continue;
    }
    const layer = document.pages
      .find((page) => page.id === slot.pageId)
      ?.layers.find((entry) => entry.id === slot.layerId);
    if (!layer || layer.type !== slot.type) {
      throw new ContentStudioDesignTemplateCustomizationError('STALE');
    }
    if (layer.type === 'text') {
      if (typeof value !== 'string') {
        throw new ContentStudioDesignTemplateCustomizationError('FIELD_TYPE');
      }
      layer.text = value;
    } else if (layer.type === 'image') {
      if (typeof value === 'string') {
        throw new ContentStudioDesignTemplateCustomizationError('FIELD_TYPE');
      }
      layer.imageRef = {
        type: 'media',
        mediaId: value.mediaId,
        sha256: value.sha256,
      };
    }
  }
  if (input.brandKit) {
    document.brandKit = {
      brandKitId: input.brandKit.brandKitId,
      revisionId: input.brandKit.revisionId,
      revisionNumber: input.brandKit.revisionNumber,
      contentHash: input.brandKit.contentHash,
    };
  }
  return parseContentStudioDesignDocument(document);
}
