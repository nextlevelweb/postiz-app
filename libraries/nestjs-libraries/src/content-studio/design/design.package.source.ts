import { ContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  ContentStudioDesignDocumentV1,
  ContentStudioDesignTextLayer,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  DESIGN_CANVAS_PRESETS,
  instantiateContentStudioDesignPageSet,
} from '@gitroom/nestjs-libraries/content-studio/design/design.page.set';
import {
  ContentStudioDesignTemplateGuidanceV1,
  ContentStudioDesignTemplateValue,
} from '@gitroom/nestjs-libraries/content-studio/design/design.template.guidance';

// A design from a package (P6-01): a new, ordinary design whose first
// document carries the text of exactly one thread item of exactly one saved
// Content Package revision, verified by the server. It is a copy, never a
// link: the design keeps which revision it came from (its id and its
// contentHash, outside the document) and nothing else of the package. A
// newer revision, a change of the draft or an edit of the design reaches
// neither side. The text is the item's own, as stored: never rewritten,
// shortened, translated or split (a text layer takes exactly what a thread
// item takes). It goes into one template field the person chose, or else
// into one new text layer on the first page; other thread items, the
// grounding and the review of the package are not copied. Like the other
// content parsers this file uses no Node-only module

// Where a design came from, as the server read it: the exact package
// revision and the contentHash it was stored with
export interface ContentStudioDesignPackageSource {
  packageRevisionId: string;
  contentHash: string;
}

// The thread item a design starts from: its text and Media as saved
export interface ContentStudioDesignPackageItem {
  id: string;
  text: string;
  mediaIds: string[];
}

// What a design from a package is made with: where it came from and the
// item, both read by the server from that exact revision
export interface ContentStudioDesignFromPackage {
  source: ContentStudioDesignPackageSource;
  item: ContentStudioDesignPackageItem;
}

// ITEM_NOT_FOUND: the revision has no such thread item. SLOT_INVALID: the
// package text or image named a template field it cannot go into, or one
// was left without a field to go into
export type ContentStudioDesignFromPackageErrorCode =
  | 'ITEM_NOT_FOUND'
  | 'SLOT_INVALID';

// A fixed message only: never package text, a field label or an id
export class ContentStudioDesignFromPackageError extends Error {
  constructor(readonly code: ContentStudioDesignFromPackageErrorCode) {
    super('The design cannot be made from this package content');
    this.name = 'ContentStudioDesignFromPackageError';
  }
}

// The name of the layer the package text is put in when no field takes it
export const DESIGN_PACKAGE_TEXT_LAYER_NAME = 'Package text';
// new ids are random: a taken one is only ever tried again a few times
const LAYER_ID_ATTEMPTS = 5;

// One thread item of a verified revision, by its id (never its position),
// as a copy
export function contentStudioDesignPackageItem(
  draft: ContentPackageDraft,
  itemId: unknown
): ContentStudioDesignPackageItem {
  const item =
    typeof itemId === 'string'
      ? draft.copy.global.thread.find((entry) => entry.id === itemId)
      : undefined;
  if (!item) {
    throw new ContentStudioDesignFromPackageError('ITEM_NOT_FOUND');
  }
  return { id: item.id, text: item.text, mediaIds: [...item.mediaIds] };
}

// The text fields of a template revision (P4-12), in their order
export const contentStudioDesignTemplateTextSlots = (
  guidance: ContentStudioDesignTemplateGuidanceV1 | null
) => (guidance?.slots ?? []).filter((slot) => slot.type === 'text');

// The values of a template's fields with the package's in them: the item's
// text, exactly, in the text field the person chose, and the image the
// server referenced for one Media of that item in the image field chosen
// for it. A template with text fields needs one chosen; one without any
// takes the text as a layer instead (see below), so none may be named. The
// person's own values may fill other fields, never these two. Anything else
// is refused, never guessed: no field is picked by its name, label or
// position. The values given are not changed
export function fillContentStudioDesignSemanticSlots(input: {
  guidance: ContentStudioDesignTemplateGuidanceV1 | null;
  values: Record<string, ContentStudioDesignTemplateValue>;
  text: string;
  textSlotId: unknown;
  image?: { mediaId: string; sha256: string };
  imageSlotId: unknown;
}): Record<string, ContentStudioDesignTemplateValue> {
  const slots = input.guidance?.slots ?? [];
  const slotOf = (id: unknown, type: 'text' | 'image') =>
    typeof id === 'string'
      ? slots.find((slot) => slot.id === id && slot.type === type)
      : undefined;
  const has = (id: string) =>
    Object.prototype.hasOwnProperty.call(input.values, id);
  const textSlots = contentStudioDesignTemplateTextSlots(input.guidance);
  const textSlot = slotOf(input.textSlotId, 'text');
  const imageSlot = slotOf(input.imageSlotId, 'image');
  if (
    (textSlots.length ? !textSlot : input.textSlotId !== undefined) ||
    (input.image ? !imageSlot : input.imageSlotId !== undefined) ||
    (textSlot && has(textSlot.id)) ||
    (imageSlot && has(imageSlot.id))
  ) {
    throw new ContentStudioDesignFromPackageError('SLOT_INVALID');
  }
  const values: Record<string, ContentStudioDesignTemplateValue> =
    Object.create(null);
  Object.assign(values, input.values);
  if (textSlot) {
    values[textSlot.id] = input.text;
  }
  if (imageSlot && input.image) {
    values[imageSlot.id] = {
      mediaId: input.image.mediaId,
      sha256: input.image.sha256,
    };
  }
  return values;
}

// Where no field takes it, the package text becomes one new text layer in
// front of the others on the first page: the editor's text layer style
// (Arial 48, black, left and top) in a box of 80% of the page, shrinking to
// fit as any text layer may, never cut. Blank text adds no layer: there is
// nothing to show. The layer gets the first id newId makes that no layer of
// the document has. The document is not changed; the result is parsed as
// Design Document v1 again, which refuses a page that is already full
export function withContentStudioDesignPackageText(
  document: ContentStudioDesignDocumentV1,
  text: string,
  newId: () => string
): ContentStudioDesignDocumentV1 {
  const copy = JSON.parse(
    JSON.stringify(document)
  ) as ContentStudioDesignDocumentV1;
  if (!text.trim()) {
    return parseContentStudioDesignDocument(copy);
  }
  const taken = new Set(
    copy.pages.flatMap((page) => page.layers.map((layer) => layer.id))
  );
  let id = newId();
  for (let attempt = 1; taken.has(id); attempt++) {
    if (attempt === LAYER_ID_ATTEMPTS) {
      throw new Error('No free layer id');
    }
    id = newId();
  }
  const page = copy.pages[0];
  const layer: ContentStudioDesignTextLayer = {
    id,
    name: DESIGN_PACKAGE_TEXT_LAYER_NAME,
    x: page.width * 0.1,
    y: page.height * 0.1,
    width: page.width * 0.8,
    height: page.height * 0.8,
    rotation: 0,
    opacity: 1,
    visible: true,
    type: 'text',
    text,
    font: { type: 'family', family: 'Arial', weight: 400, style: 'normal' },
    fontSize: 48,
    lineHeight: 1.2,
    letterSpacing: 0,
    color: { type: 'literal', value: '#000000' },
    align: 'left',
    verticalAlign: 'top',
    overflow: 'shrink',
  };
  page.layers.push(layer);
  return parseContentStudioDesignDocument(copy);
}

// A blank design of one of the fixed canvas sizes, as Creative Studio
// starts one: one empty white page with the id given, no name, no Brand Kit
// (the same blank page a page set makes). Null for any other size
export function contentStudioDesignBlankDocument(
  presetId: unknown,
  pageId: string
): ContentStudioDesignDocumentV1 | null {
  const preset = DESIGN_CANVAS_PRESETS.find((entry) => entry.id === presetId);
  if (!preset) {
    return null;
  }
  return {
    schemaVersion: 1,
    brandKit: null,
    pages: instantiateContentStudioDesignPageSet(
      {
        schemaVersion: 1,
        pages: [{ name: '', width: preset.width, height: preset.height }],
      },
      () => pageId
    ),
  };
}
