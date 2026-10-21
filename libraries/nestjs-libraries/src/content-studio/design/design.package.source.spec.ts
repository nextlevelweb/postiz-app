import fs from 'fs';
import path from 'path';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  ContentStudioDesignDocumentError,
  DESIGN_LAYERS_PER_PAGE_MAX,
  DESIGN_TEXT_MAX,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { parseContentStudioDesignTemplateGuidance } from '@gitroom/nestjs-libraries/content-studio/design/design.template.guidance';
import { findContentStudioSystemDesignTemplate } from '@gitroom/nestjs-libraries/content-studio/design/design.system.templates';
import {
  contentStudioDesignBlankDocument,
  contentStudioDesignPackageItem,
  ContentStudioDesignFromPackageError,
  contentStudioDesignTemplateTextSlots,
  DESIGN_PACKAGE_TEXT_LAYER_NAME,
  fillContentStudioDesignSemanticSlots,
  withContentStudioDesignPackageText,
} from '@gitroom/nestjs-libraries/content-studio/design/design.package.source';

// P6-01: the pure part of a design from a package. The thread item is found
// by its id in a verified revision, its text goes unchanged into one chosen
// template field or one new text layer, and nothing is guessed, cut or
// rewritten. The services and the database are pinned elsewhere
// (content-studio.design-package.spec.ts and the PostgreSQL suite)

const read = (file: string) =>
  fs.readFileSync(path.join(__dirname, file), 'utf8');

// exact text: outer spaces, blank lines, tabs, emoji and non-Latin script
const EXACT = '  Spring sale 🌸\n\n\tTwo lines — été 春\n  ';

const draft = (
  thread: Array<{ id: string; text: string; mediaIds?: string[] }>
) =>
  parseContentPackageDraft({
    schemaVersion: 1,
    copy: {
      global: {
        thread: thread.map((item) => ({ mediaIds: [], ...item })),
      },
    },
  });

const square = () =>
  findContentStudioSystemDesignTemplate('system:square-post')!;

const fromPackageError = (run: () => unknown) => {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(ContentStudioDesignFromPackageError);
    expect((err as Error).message).toBe(
      'The design cannot be made from this package content'
    );
    return (err as ContentStudioDesignFromPackageError).code;
  }
  throw new Error('expected a fromPackage error');
};

describe('the thread item a design starts from (P6-01)', () => {
  it('PD2/CM1/PD3 is found by its id, with exactly its text and Media, as a copy', () => {
    const content = draft([
      { id: 'main', text: 'First' },
      { id: 'second', text: EXACT, mediaIds: ['m1', 'm2'] },
    ]);
    const item = contentStudioDesignPackageItem(content, 'second');
    expect(item).toEqual({ id: 'second', text: EXACT, mediaIds: ['m1', 'm2'] });
    item.mediaIds.push('m3');
    expect(content.copy.global.thread[1].mediaIds).toEqual(['m1', 'm2']);
  });

  it('CM5/M9 refuses an id the revision does not have, and never a position or a near match', () => {
    const content = draft([
      { id: 'main', text: 'First' },
      { id: 'second', text: 'Second' },
    ]);
    for (const id of [
      'other',
      'Main',
      ' main',
      0,
      1,
      '0',
      null,
      undefined,
      {},
    ]) {
      expect(
        fromPackageError(() => contentStudioDesignPackageItem(content, id))
      ).toBe('ITEM_NOT_FOUND');
    }
  });
});

describe('the package text in a template field (P6-01)', () => {
  const guidance = () => square().guidance!;

  it('TP2/CM1/CM2 puts the exact text into the chosen text field, and nothing else changes', () => {
    const values = fillContentStudioDesignSemanticSlots({
      guidance: guidance(),
      values: { headline: 'Given headline' },
      text: EXACT,
      textSlotId: 'body',
      imageSlotId: undefined,
    });
    expect({ ...values }).toEqual({ headline: 'Given headline', body: EXACT });
  });

  it('TP2 is deterministic: the same input gives the same values, and the input is not changed', () => {
    const input = {
      guidance: guidance(),
      values: { headline: 'H' },
      text: EXACT,
      textSlotId: 'body',
      imageSlotId: undefined,
    };
    const before = JSON.stringify(input);
    expect({ ...fillContentStudioDesignSemanticSlots(input) }).toEqual({
      ...fillContentStudioDesignSemanticSlots(input),
    });
    expect(JSON.stringify(input)).toBe(before);
  });

  it('PD4/CM3/M8 keeps the longest text a thread item may hold, character for character', () => {
    const long = `${'x'.repeat(DESIGN_TEXT_MAX - 2)}\n.`;
    const values = fillContentStudioDesignSemanticSlots({
      guidance: guidance(),
      values: {},
      text: long,
      textSlotId: 'headline',
      imageSlotId: undefined,
    });
    expect(values.headline).toBe(long);
    expect((values.headline as string).length).toBe(DESIGN_TEXT_MAX);
  });

  it('a template with text fields needs one chosen: none, an unknown one or an image field is refused', () => {
    const document = parseContentStudioDesignDocument({
      schemaVersion: 1,
      brandKit: null,
      pages: [
        {
          id: 'page_1',
          name: '',
          width: 1080,
          height: 1080,
          background: {
            type: 'solid',
            color: { type: 'literal', value: '#ffffff' },
          },
          layers: [
            {
              id: 'title',
              name: '',
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              rotation: 0,
              opacity: 1,
              visible: true,
              type: 'text',
              text: 'T',
              font: {
                type: 'family',
                family: 'Inter',
                weight: 400,
                style: 'normal',
              },
              fontSize: 20,
              lineHeight: 1.2,
              letterSpacing: 0,
              color: { type: 'literal', value: '#000000' },
              align: 'left',
              verticalAlign: 'top',
              overflow: 'clip',
            },
            {
              id: 'photo',
              name: '',
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              rotation: 0,
              opacity: 1,
              visible: true,
              type: 'image',
              imageRef: {
                type: 'media',
                mediaId: 'm0',
                sha256: 'a'.repeat(64),
              },
              fit: 'cover',
              focalPoint: { x: 0.5, y: 0.5 },
            },
          ],
        },
      ],
    });
    const mixed = parseContentStudioDesignTemplateGuidance(
      {
        schemaVersion: 1,
        brandRebinding: false,
        slots: [
          {
            id: 'title',
            type: 'text',
            label: 'Title',
            pageId: 'page_1',
            layerId: 'title',
            required: false,
            multiline: false,
          },
          {
            id: 'photo',
            type: 'image',
            label: 'Photo',
            pageId: 'page_1',
            layerId: 'photo',
            required: false,
          },
        ],
      },
      document
    );
    for (const textSlotId of [undefined, 'headline', 'photo', '', 7]) {
      expect(
        fromPackageError(() =>
          fillContentStudioDesignSemanticSlots({
            guidance: mixed,
            values: {},
            text: 'x',
            textSlotId,
            imageSlotId: undefined,
          })
        )
      ).toBe('SLOT_INVALID');
    }
    // MD3: one Media of the item into the image field chosen for it
    const image = { mediaId: 'm1', sha256: 'b'.repeat(64) };
    const values = fillContentStudioDesignSemanticSlots({
      guidance: mixed,
      values: {},
      text: 'x',
      textSlotId: 'title',
      image,
      imageSlotId: 'photo',
    });
    expect({ ...values }).toEqual({ title: 'x', photo: image });
    // an image needs an image field, and a field needs an image
    for (const [withImage, imageSlotId] of [
      [true, undefined],
      [true, 'title'],
      [true, 'nope'],
      [false, 'photo'],
    ] as const) {
      expect(
        fromPackageError(() =>
          fillContentStudioDesignSemanticSlots({
            guidance: mixed,
            values: {},
            text: 'x',
            textSlotId: 'title',
            image: withImage ? image : undefined,
            imageSlotId,
          })
        )
      ).toBe('SLOT_INVALID');
    }
    // M2/SEC5: the person's own values never take the fields the package fills
    for (const values of [{ title: 'typed' }, { photo: image }]) {
      expect(
        fromPackageError(() =>
          fillContentStudioDesignSemanticSlots({
            guidance: mixed,
            values,
            text: 'x',
            textSlotId: 'title',
            image,
            imageSlotId: 'photo',
          })
        )
      ).toBe('SLOT_INVALID');
    }
  });

  it('TP3 a template without text fields takes no field for the text (the layer fallback) and refuses one', () => {
    expect(contentStudioDesignTemplateTextSlots(null)).toEqual([]);
    expect(
      fillContentStudioDesignSemanticSlots({
        guidance: null,
        values: {},
        text: 'x',
        textSlotId: undefined,
        imageSlotId: undefined,
      })
    ).toEqual({});
    expect(
      fromPackageError(() =>
        fillContentStudioDesignSemanticSlots({
          guidance: null,
          values: {},
          text: 'x',
          textSlotId: 'headline',
          imageSlotId: undefined,
        })
      )
    ).toBe('SLOT_INVALID');
  });

  it('no field is picked by name, label or position: the built-in fields are listed in their order only', () => {
    expect(
      contentStudioDesignTemplateTextSlots(guidance()).map((slot) => slot.id)
    ).toEqual(['headline', 'body']);
    expect(read('design.package.source.ts')).not.toMatch(
      /['"](headline|body|title|caption|cta|subheadline)['"]|slots\[0\]|label\s*===/
    );
  });
});

describe('the package text as a layer (P6-01)', () => {
  const blank = () => contentStudioDesignBlankDocument('portrait', 'p_seed')!;

  it('TP3/CM1/CM2 adds one text layer in front on the first page with the exact text, shrinking to fit, never cut', () => {
    const before = blank();
    const document = withContentStudioDesignPackageText(
      before,
      EXACT,
      () => 'l_seed'
    );
    expect(before.pages[0].layers).toEqual([]);
    expect(document.pages[0].layers).toEqual([
      {
        id: 'l_seed',
        name: DESIGN_PACKAGE_TEXT_LAYER_NAME,
        x: 108,
        y: 135,
        width: 864,
        height: 1080,
        rotation: 0,
        opacity: 1,
        visible: true,
        type: 'text',
        text: EXACT,
        font: { type: 'family', family: 'Arial', weight: 400, style: 'normal' },
        fontSize: 48,
        lineHeight: 1.2,
        letterSpacing: 0,
        color: { type: 'literal', value: '#000000' },
        align: 'left',
        verticalAlign: 'top',
        overflow: 'shrink',
      },
    ]);
    expect(parseContentStudioDesignDocument(document)).toEqual(document);
  });

  it('CM6 blank text adds no layer; a page that is already full is refused by Design Document v1, not cut', () => {
    expect(
      withContentStudioDesignPackageText(blank(), '  \n\t ', () => 'l_x')
    ).toEqual(blank());
    const full = blank();
    full.pages[0].layers = Array.from(
      { length: DESIGN_LAYERS_PER_PAGE_MAX },
      (_, index) => ({
        id: `s${index}`,
        name: '',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        rotation: 0,
        opacity: 1,
        visible: true,
        type: 'shape' as const,
        shape: 'rectangle' as const,
        fill: { type: 'literal' as const, value: '#000000' },
        cornerRadius: 0,
      })
    );
    expect(() =>
      withContentStudioDesignPackageText(full, 'x', () => 'l_x')
    ).toThrow(ContentStudioDesignDocumentError);
  });

  it('PD4 the longest thread item text goes into the layer unchanged', () => {
    const long = 'y'.repeat(DESIGN_TEXT_MAX);
    const document = withContentStudioDesignPackageText(
      blank(),
      long,
      () => 'l_x'
    );
    expect(document.pages[0].layers[0]).toMatchObject({
      type: 'text',
      text: long,
    });
  });

  it('takes a layer id no layer of the document has, and gives up after a few taken ones', () => {
    const template = square().content;
    const ids = ['headline', 'body', 'l_free'];
    const document = withContentStudioDesignPackageText(
      template,
      'x',
      () => ids.shift()!
    );
    expect(document.pages[0].layers.map((layer) => layer.id)).toEqual([
      'band',
      'headline',
      'body',
      'l_free',
    ]);
    expect(() =>
      withContentStudioDesignPackageText(template, 'x', () => 'headline')
    ).toThrow('No free layer id');
  });

  it('only the first page gets the text: the other pages stay as they are', () => {
    const two = blank();
    two.pages.push({ ...two.pages[0], id: 'p_two' });
    const document = withContentStudioDesignPackageText(two, 'x', () => 'l_x');
    expect(document.pages[0].layers).toHaveLength(1);
    expect(document.pages[1].layers).toEqual([]);
  });
});

describe('a blank design of a canvas size (P6-01)', () => {
  it('is one empty white page of that size, no name and no Brand Kit, as a page set makes it', () => {
    expect(contentStudioDesignBlankDocument('story', 'p_one')).toEqual({
      schemaVersion: 1,
      brandKit: null,
      pages: [
        {
          id: 'p_one',
          name: '',
          width: 1080,
          height: 1920,
          background: {
            type: 'solid',
            color: { type: 'literal', value: '#ffffff' },
          },
          layers: [],
        },
      ],
    });
    for (const size of ['huge', '', undefined, 1080, 'Square']) {
      expect(contentStudioDesignBlankDocument(size, 'p_one')).toBeNull();
    }
  });
});

describe('package to design source boundaries (P6-01)', () => {
  // the code, without its comments
  const source = read('design.package.source.ts').replace(/^\s*\/\/.*$/gm, '');

  it('P601-1/P601-7 has no AI, network, Node-only module or Design Document schema change', () => {
    expect(source).not.toMatch(
      /AIExecution|ai\.execution|ai\.provider|generateText|openai|anthropic|\bfetch\(|from 'crypto'|from 'fs'|schemaVersion: 2/
    );
    expect(read('design.document.ts')).toMatch(
      /export const DESIGN_DOCUMENT_SCHEMA_VERSION = 1;/
    );
    expect(read('design.document.ts')).not.toMatch(
      /sourcePackage|packageRevision|PackageSource/
    );
  });

  it('P601-3/P601-4/RA1/RA2 knows nothing of a draft, a newer revision, a review, an approval or a handoff', () => {
    expect(source).not.toMatch(
      /draftVersion|latestRevision|\breview|approv|handoff|grounding|claims/i
    );
  });

  it('M8/PD4 never shortens, splits or rewrites the text', () => {
    expect(source).not.toMatch(
      /\.slice\(|\.substring\(|\.substr\(|\.split\(|toUpperCase|toLowerCase|replace\(|text\s*=[^=]/
    );
  });
});
