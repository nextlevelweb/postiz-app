import {
  ContentStudioDesignDocumentError,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { ContentStudioDesignIntegrityError } from '@gitroom/nestjs-libraries/content-studio/design/design.document.revision';
import {
  applyContentStudioDesignTemplateCustomization,
  ContentStudioDesignTemplateCustomizationError,
  ContentStudioDesignTemplateGuidanceError,
  DESIGN_TEMPLATE_SLOT_DESCRIPTION_MAX,
  DESIGN_TEMPLATE_SLOT_LABEL_MAX,
  DESIGN_TEMPLATE_SLOTS_MAX,
  parseContentStudioDesignTemplateGuidance,
  parseContentStudioDesignTemplateValues,
} from '@gitroom/nestjs-libraries/content-studio/design/design.template.guidance';
import {
  parseVerifiedContentStudioDesignTemplateGuidance,
  storedContentStudioDesignTemplateGuidance,
} from '@gitroom/nestjs-libraries/content-studio/design/design.template.guidance.revision';

// Template Guidance v1 and customization (P4-12), pure: no database, Media,
// Brand Kit or network. Guidance is checked against exactly its document;
// customization writes values into a copy that is Design Document v1 only

type Row = Record<string, any>;
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const BRAND = {
  brandKitId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  revisionId: '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  revisionNumber: 1,
  contentHash: SHA('b'),
};
const OTHER_BRAND = {
  ...BRAND,
  revisionId: '9b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e',
  revisionNumber: 2,
  contentHash: SHA('c'),
};

const base = {
  x: 10.5,
  y: 20,
  width: 300,
  height: 120.25,
  rotation: 12.5,
  opacity: 0.8,
  visible: true,
};
const text = (id: string, value: string, extra: Row = {}) => ({
  ...base,
  id,
  name: id,
  type: 'text',
  text: value,
  font: { type: 'brand', tokenId: 'heading' },
  fontSize: 64,
  lineHeight: 1.2,
  letterSpacing: 0.5,
  color: { type: 'literal', value: '#123456' },
  align: 'center',
  verticalAlign: 'middle',
  overflow: 'shrink',
  ...extra,
});
const picture = (id: string, extra: Row = {}) => ({
  ...base,
  id,
  name: id,
  type: 'image',
  imageRef: { type: 'media', mediaId: 'media-old', sha256: SHA('a') },
  fit: 'cover',
  focalPoint: { x: 0.25, y: 0.75 },
  ...extra,
});
const shape = (id: string) => ({
  ...base,
  id,
  name: id,
  type: 'shape',
  shape: 'rectangle',
  fill: { type: 'brand', tokenId: 'primary' },
  cornerRadius: 4,
});
const documentWith = (brandKit: Row | null = BRAND) =>
  parseContentStudioDesignDocument({
    schemaVersion: 1,
    brandKit,
    pages: [
      {
        id: 'p_one',
        name: 'One',
        width: 1080,
        height: 1080,
        background: {
          type: 'solid',
          color: brandKit
            ? { type: 'brand', tokenId: 'primary' }
            : { type: 'literal', value: '#ffffff' },
        },
        layers: brandKit
          ? [
              shape('band'),
              text('headline', '  Big news \n'),
              picture('photo'),
              text('body', 'Body'),
            ]
          : [
              text('headline', 'Plain', {
                font: {
                  type: 'family',
                  family: 'Inter',
                  weight: 700,
                  style: 'normal',
                },
              }),
            ],
      },
      {
        id: 'p_two',
        name: 'Two',
        width: 1080,
        height: 1080,
        background: {
          type: 'solid',
          color: { type: 'literal', value: '#000000' },
        },
        layers: brandKit ? [picture('second')] : [],
      },
    ],
  });
const DOCUMENT = documentWith();

const textSlot = (extra: Row = {}) => ({
  id: 'headline',
  type: 'text',
  label: 'Headline',
  pageId: 'p_one',
  layerId: 'headline',
  required: true,
  multiline: false,
  ...extra,
});
const imageSlot = (extra: Row = {}) => ({
  id: 'photo',
  type: 'image',
  label: 'Photo',
  pageId: 'p_one',
  layerId: 'photo',
  required: false,
  ...extra,
});
const guidanceOf = (slots: Row[], brandRebinding = false) => ({
  schemaVersion: 1,
  brandRebinding,
  slots,
});
const parse = (input: unknown, document = DOCUMENT) =>
  parseContentStudioDesignTemplateGuidance(input, document);
const code = (run: () => unknown) => {
  try {
    run();
  } catch (err) {
    if (
      err instanceof ContentStudioDesignTemplateGuidanceError ||
      err instanceof ContentStudioDesignTemplateCustomizationError
    ) {
      return err.code;
    }
    throw err;
  }
  return 'ok';
};
const FULL = parse(
  guidanceOf(
    [
      textSlot({ description: '  A few words  ' }),
      imageSlot(),
      textSlot({
        id: 'body',
        layerId: 'body',
        label: 'Body',
        required: false,
        multiline: true,
      }),
      imageSlot({
        id: 'second',
        pageId: 'p_two',
        layerId: 'second',
        label: 'Second',
        required: true,
      }),
    ],
    true
  )
);
const apply = (values: Row, extra: Row = {}) =>
  applyContentStudioDesignTemplateCustomization({
    document: DOCUMENT,
    guidance: FULL,
    values: parseContentStudioDesignTemplateValues(values),
    ...extra,
  });
const NEW_IMAGE = { mediaId: 'media-new', sha256: SHA('d') };
const REQUIRED = { headline: 'Hello', second: NEW_IMAGE };
const layerOf = (document: Row, id: string) =>
  document.pages
    .flatMap((page: Row) => page.layers)
    .find((layer: Row) => layer.id === id);

// ============================================================================
describe('Template Guidance v1', () => {
  it('G1 empty guidance is valid and stays empty', () => {
    expect(parse(guidanceOf([]))).toEqual({
      schemaVersion: 1,
      brandRebinding: false,
      slots: [],
    });
  });

  it('G2/G3 text and image slots name layers of their page; labels are trimmed, nothing else changes', () => {
    expect(FULL.slots.map((slot) => [slot.id, slot.type])).toEqual([
      ['headline', 'text'],
      ['photo', 'image'],
      ['body', 'text'],
      ['second', 'image'],
    ]);
    expect(FULL.slots[0]).toEqual({
      ...textSlot(),
      description: 'A few words',
    });
    expect(FULL.slots[1]).toEqual(imageSlot());
    expect(FULL.brandRebinding).toBe(true);
  });

  it('G4/M3 a duplicate slot id is refused', () => {
    expect(
      code(() => parse(guidanceOf([textSlot(), imageSlot({ id: 'headline' })])))
    ).toBe('INVALID');
  });

  it('G5 two slots for one layer are refused', () => {
    expect(
      code(() => parse(guidanceOf([textSlot(), textSlot({ id: 'again' })])))
    ).toBe('INVALID');
  });

  it('G6/G7/M1 a page or layer the document does not have, or a layer of another page, is stale', () => {
    expect(
      code(() => parse(guidanceOf([textSlot({ pageId: 'p_gone' })])))
    ).toBe('STALE');
    expect(code(() => parse(guidanceOf([textSlot({ layerId: 'gone' })])))).toBe(
      'STALE'
    );
    // the layer exists, on the other page
    expect(
      code(() => parse(guidanceOf([imageSlot({ layerId: 'second' })])))
    ).toBe('STALE');
  });

  it('G8/G9/M2 a text slot needs a text layer, an image slot an image layer; shapes take none', () => {
    expect(
      code(() => parse(guidanceOf([textSlot({ layerId: 'photo' })])))
    ).toBe('STALE');
    expect(
      code(() => parse(guidanceOf([imageSlot({ layerId: 'headline' })])))
    ).toBe('STALE');
    expect(code(() => parse(guidanceOf([textSlot({ layerId: 'band' })])))).toBe(
      'STALE'
    );
    expect(
      code(() => parse(guidanceOf([imageSlot({ layerId: 'band' })])))
    ).toBe('STALE');
    expect(
      code(() => parse(guidanceOf([{ ...textSlot(), type: 'shape' }])))
    ).toBe('INVALID');
  });

  it('G10/G11 labels and descriptions are bounded, required and plain', () => {
    const long = (n: number) => 'x'.repeat(n);
    expect(
      code(() =>
        parse(
          guidanceOf([
            textSlot({ label: long(DESIGN_TEMPLATE_SLOT_LABEL_MAX) }),
          ])
        )
      )
    ).toBe('ok');
    expect(
      code(() =>
        parse(
          guidanceOf([
            textSlot({ label: long(DESIGN_TEMPLATE_SLOT_LABEL_MAX + 1) }),
          ])
        )
      )
    ).toBe('INVALID');
    expect(
      code(() =>
        parse(
          guidanceOf([
            textSlot({
              description: long(DESIGN_TEMPLATE_SLOT_DESCRIPTION_MAX + 1),
            }),
          ])
        )
      )
    ).toBe('INVALID');
    for (const label of [
      '   ',
      '<b>Title</b>',
      'See https://example.test',
      'www.example.test',
      'javascript:alert(1)',
      'a\u0000b',
    ]) {
      expect([
        label,
        code(() => parse(guidanceOf([textSlot({ label })]))),
      ]).toEqual([label, 'INVALID']);
    }
    expect(code(() => parse(guidanceOf([textSlot({ description: '' })])))).toBe(
      'INVALID'
    );
    expect(
      code(() => parse(guidanceOf([textSlot({ label: 'Metadata: tagline' })])))
    ).toBe('ok');
  });

  it('G12 at most 100 slots', () => {
    const many = Array.from({ length: DESIGN_TEMPLATE_SLOTS_MAX + 1 }, (_, i) =>
      textSlot({ id: `s${i}`, layerId: `l${i}` })
    );
    expect(code(() => parse(guidanceOf(many)))).toBe('INVALID');
  });

  it('G15 unknown keys, a wrong schema version, missing keys or non-plain data are refused', () => {
    expect(code(() => parse({ ...guidanceOf([]), extra: 1 }))).toBe('INVALID');
    expect(
      code(() => parse(guidanceOf([{ ...textSlot(), defaultValue: 'x' }])))
    ).toBe('INVALID');
    expect(
      code(() => parse(guidanceOf([{ ...imageSlot(), multiline: true }])))
    ).toBe('INVALID');
    expect(code(() => parse({ ...guidanceOf([]), schemaVersion: 2 }))).toBe(
      'INVALID'
    );
    expect(code(() => parse({ schemaVersion: 1, slots: [] }))).toBe('INVALID');
    const { multiline, ...noMultiline } = textSlot();
    expect(multiline).toBe(false);
    expect(code(() => parse(guidanceOf([noMultiline])))).toBe('INVALID');
    expect(code(() => parse(new Date()))).toBe('INVALID');
    expect(code(() => parse(guidanceOf([textSlot({ id: 'bad id' })])))).toBe(
      'INVALID'
    );
  });

  it('Brand Kit rebinding needs a document with a Brand Kit reference', () => {
    const plain = documentWith(null);
    expect(code(() => parse(guidanceOf([], true), plain))).toBe('STALE');
    expect(code(() => parse(guidanceOf([], false), plain))).toBe('ok');
  });

  it('the input is never changed', () => {
    const input = guidanceOf([textSlot({ label: '  Padded  ' })]);
    const before = JSON.stringify(input);
    parse(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

// ============================================================================
describe('Stored guidance', () => {
  it('G13/M4 the hash is the SHA-256 of the canonical JSON, the same on every call', () => {
    const stored = storedContentStudioDesignTemplateGuidance(FULL);
    expect(stored.guidanceSchemaVersion).toBe(1);
    expect(stored.guidanceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(storedContentStudioDesignTemplateGuidance(FULL)).toEqual(stored);
    // keys sorted at every level, slots in their order
    expect(
      stored.guidance?.startsWith(
        '{"brandRebinding":true,"schemaVersion":1,"slots":[{"description":"A few words","id":"headline","label":"Headline","layerId":"headline","multiline":false,"pageId":"p_one","required":true,"type":"text"}'
      )
    ).toBe(true);
    expect(storedContentStudioDesignTemplateGuidance(null)).toEqual({
      guidanceSchemaVersion: null,
      guidance: null,
      guidanceHash: null,
    });
  });

  it('G14 the same guidance in another key order has the same hash; another slot order has another', () => {
    const reordered = parse({
      slots: [
        {
          required: true,
          multiline: false,
          layerId: 'headline',
          pageId: 'p_one',
          label: 'Headline',
          type: 'text',
          id: 'headline',
        },
      ],
      brandRebinding: false,
      schemaVersion: 1,
    });
    expect(storedContentStudioDesignTemplateGuidance(reordered)).toEqual(
      storedContentStudioDesignTemplateGuidance(parse(guidanceOf([textSlot()])))
    );
    const swapped = parse(
      guidanceOf([...FULL.slots].reverse(), FULL.brandRebinding)
    );
    expect(
      storedContentStudioDesignTemplateGuidance(swapped).guidanceHash
    ).not.toBe(storedContentStudioDesignTemplateGuidance(FULL).guidanceHash);
  });

  it('reads back exactly, and fails closed on anything else', () => {
    const stored = storedContentStudioDesignTemplateGuidance(FULL);
    expect(
      parseVerifiedContentStudioDesignTemplateGuidance(stored, DOCUMENT)
    ).toEqual(FULL);
    expect(
      parseVerifiedContentStudioDesignTemplateGuidance(
        storedContentStudioDesignTemplateGuidance(null),
        DOCUMENT
      )
    ).toBeNull();
    const broken = [
      { ...stored, guidanceHash: SHA('0') },
      { ...stored, guidanceSchemaVersion: 2 },
      { ...stored, guidance: ` ${stored.guidance}` },
      { ...stored, guidance: '{' },
      { ...stored, guidanceHash: null },
      { ...stored, guidance: null },
    ];
    for (const row of broken) {
      expect(() =>
        parseVerifiedContentStudioDesignTemplateGuidance(row, DOCUMENT)
      ).toThrow(ContentStudioDesignIntegrityError);
    }
    // valid guidance, but for another document: never paired with it
    expect(() =>
      parseVerifiedContentStudioDesignTemplateGuidance(
        stored,
        documentWith(null)
      )
    ).toThrow(ContentStudioDesignIntegrityError);
  });
});

// ============================================================================
describe('Template customization', () => {
  it('C1/C2/C14/M5/M6 a text value replaces only the text of its layer', () => {
    const result = apply({ ...REQUIRED, headline: '  New\r\nheadline ' });
    const before = layerOf(DOCUMENT, 'headline');
    const after = layerOf(result, 'headline');
    // line endings normalized like any text layer, spaces kept
    expect(after).toEqual({ ...before, text: '  New\nheadline ' });
    expect(result.pages.map((page) => page.id)).toEqual(['p_one', 'p_two']);
    expect(
      result.pages.flatMap((page) => page.layers.map((layer) => layer.id))
    ).toEqual(['band', 'headline', 'photo', 'body', 'second']);
  });

  it('C3/C4/M8/M9 an image value replaces only the reference; crop, focal point and geometry stay', () => {
    const result = apply({ ...REQUIRED, photo: NEW_IMAGE });
    expect(layerOf(result, 'photo')).toEqual({
      ...layerOf(DOCUMENT, 'photo'),
      imageRef: { type: 'media', mediaId: 'media-new', sha256: SHA('d') },
    });
    expect(layerOf(result, 'photo').focalPoint).toEqual({ x: 0.25, y: 0.75 });
    expect(layerOf(result, 'second').imageRef.sha256).toBe(SHA('d'));
  });

  it('C5/C6/M7 a required text or image without a value is refused; blank text is no value', () => {
    expect(code(() => apply({ second: NEW_IMAGE }))).toBe('REQUIRED_FIELD');
    expect(code(() => apply({ headline: 'Hi' }))).toBe('REQUIRED_FIELD');
    expect(code(() => apply({ ...REQUIRED, headline: ' \n ' }))).toBe(
      'REQUIRED_FIELD'
    );
  });

  it('C7 an optional field left out keeps the template value; an empty optional text is a value', () => {
    const result = apply(REQUIRED);
    expect(layerOf(result, 'photo')).toEqual(layerOf(DOCUMENT, 'photo'));
    expect(layerOf(result, 'body')).toEqual(layerOf(DOCUMENT, 'body'));
    expect(layerOf(apply({ ...REQUIRED, body: '' }), 'body').text).toBe('');
  });

  it('C8/C9/SEC5 unknown fields and values of the wrong kind fail closed', () => {
    expect(code(() => apply({ ...REQUIRED, band: 'x' }))).toBe('UNKNOWN_FIELD');
    expect(code(() => apply({ ...REQUIRED, nope: 'x' }))).toBe('UNKNOWN_FIELD');
    expect(code(() => apply({ ...REQUIRED, photo: 'text' }))).toBe(
      'FIELD_TYPE'
    );
    expect(code(() => apply({ ...REQUIRED, headline: NEW_IMAGE }))).toBe(
      'FIELD_TYPE'
    );
    // no guidance: no value is accepted at all
    expect(
      code(() =>
        applyContentStudioDesignTemplateCustomization({
          document: DOCUMENT,
          guidance: null,
          values: { headline: 'x' },
        })
      )
    ).toBe('UNKNOWN_FIELD');
  });

  it('values are field id to text or an exact Media reference, nothing else', () => {
    expect(parseContentStudioDesignTemplateValues(undefined)).toEqual({});
    for (const values of [
      null,
      [],
      'x',
      { headline: 1 },
      { headline: null },
      { photo: { mediaId: 'media-new' } },
      { photo: { ...NEW_IMAGE, url: 'https://x.test/a.png' } },
      { photo: { mediaId: '../etc', sha256: SHA('d') } },
      { photo: { mediaId: 'm', sha256: 'ABC' } },
      { 'bad id': 'x' },
      { headline: 'x'.repeat(10_001) },
      Object.fromEntries(
        Array.from({ length: DESIGN_TEMPLATE_SLOTS_MAX + 1 }, (_, i) => [
          `s${i}`,
          'x',
        ])
      ),
    ]) {
      expect([
        values,
        code(() => parseContentStudioDesignTemplateValues(values)),
      ]).toEqual([values, 'INVALID']);
    }
  });

  it('C10 several values apply deterministically, in any key order', () => {
    const one = apply({ ...REQUIRED, body: 'B', photo: NEW_IMAGE });
    const two = apply({ photo: NEW_IMAGE, body: 'B', ...REQUIRED });
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });

  it('C11 the result is Design Document v1 and nothing else; text it cannot hold is refused by the document parser', () => {
    const result = apply(REQUIRED);
    expect(parseContentStudioDesignDocument(result)).toEqual(result);
    expect(Object.keys(result).sort()).toEqual([
      'brandKit',
      'pages',
      'schemaVersion',
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /slot|guidance|template|required|multiline|label/i
    );
    expect(() => apply({ ...REQUIRED, headline: 'a\u0000b' })).toThrow(
      ContentStudioDesignDocumentError
    );
    expect(() =>
      apply({ ...REQUIRED, body: 'x'.repeat(10_000), headline: 'y' })
    ).not.toThrow();
  });

  it('C12/M20 the template document is never changed', () => {
    const before = JSON.stringify(DOCUMENT);
    apply(
      { ...REQUIRED, photo: NEW_IMAGE, body: 'B' },
      { brandKit: OTHER_BRAND }
    );
    expect(JSON.stringify(DOCUMENT)).toBe(before);
  });

  it('C13 unrelated layers and pages stay deep-equal', () => {
    const result = apply({ ...REQUIRED, headline: 'X' });
    expect(layerOf(result, 'band')).toEqual(layerOf(DOCUMENT, 'band'));
    expect(result.pages[0].background).toEqual(DOCUMENT.pages[0].background);
    expect({ ...result.pages[0], layers: [] }).toEqual({
      ...DOCUMENT.pages[0],
      layers: [],
    });
  });
});

// ============================================================================
describe('Brand Kit rebinding (pure)', () => {
  it('BR1 without a chosen revision the exact original reference stays', () => {
    expect(apply(REQUIRED).brandKit).toEqual(BRAND);
  });

  it('BR2/BR7/BR10/M13 a chosen revision replaces only the reference, exactly; literals and tokens stay', () => {
    const result = apply(REQUIRED, { brandKit: OTHER_BRAND });
    expect(result.brandKit).toEqual(OTHER_BRAND);
    const plain = apply(REQUIRED);
    expect({ ...result, brandKit: null }).toEqual({ ...plain, brandKit: null });
    expect(layerOf(result, 'headline').color).toEqual({
      type: 'literal',
      value: '#123456',
    });
    expect(layerOf(result, 'band').fill).toEqual({
      type: 'brand',
      tokenId: 'primary',
    });
  });

  it('BR8/BR9/M15 no rebinding where the guidance does not allow it or the document has no Brand Kit', () => {
    const noRebind = parse(guidanceOf([textSlot()], false));
    expect(
      code(() =>
        applyContentStudioDesignTemplateCustomization({
          document: DOCUMENT,
          guidance: noRebind,
          values: { headline: 'x' },
          brandKit: OTHER_BRAND,
        })
      )
    ).toBe('BRAND_REBIND_UNSUPPORTED');
    expect(
      code(() =>
        applyContentStudioDesignTemplateCustomization({
          document: DOCUMENT,
          guidance: null,
          values: {},
          brandKit: OTHER_BRAND,
        })
      )
    ).toBe('BRAND_REBIND_UNSUPPORTED');
    // guidance claiming rebinding for a document without a Brand Kit
    const plain = documentWith(null);
    expect(
      code(() =>
        applyContentStudioDesignTemplateCustomization({
          document: plain,
          guidance: { schemaVersion: 1, brandRebinding: true, slots: [] },
          values: {},
          brandKit: OTHER_BRAND,
        })
      )
    ).toBe('BRAND_REBIND_UNSUPPORTED');
  });

  it('extra keys of a reference are never copied', () => {
    const result = apply(REQUIRED, {
      brandKit: { ...OTHER_BRAND, latest: true } as never,
    });
    expect(result.brandKit).toEqual(OTHER_BRAND);
  });
});

// ============================================================================
// P4-14: a guided image keeps the layer's composition
describe('Template customization: image composition', () => {
  const masked = (mask: Row) =>
    parseContentStudioDesignDocument({
      schemaVersion: 1,
      brandKit: null,
      pages: [
        {
          id: 'p_one',
          name: '',
          width: 1080,
          height: 1080,
          background: {
            type: 'solid',
            color: { type: 'literal', value: '#ffffff' },
          },
          layers: [picture('photo', { fit: 'contain', mask })],
        },
      ],
    });
  const guidance = (document: Row) =>
    parseContentStudioDesignTemplateGuidance(
      { schemaVersion: 1, brandRebinding: false, slots: [imageSlot()] },
      document as never
    );

  it('GTIMG1/GTIMG2/GTIMG3/GTIMG4/GTIMG5/GTIMG6/M19 only the Media reference changes: fit, focal point, mask, radius and geometry stay', () => {
    for (const mask of [
      { type: 'roundedRectangle', cornerRadius: 36 },
      { type: 'ellipse' },
      { type: 'rectangle' },
    ]) {
      const document = masked(mask);
      const before = JSON.stringify(document);
      const result = applyContentStudioDesignTemplateCustomization({
        document,
        guidance: guidance(document),
        values: parseContentStudioDesignTemplateValues({ photo: NEW_IMAGE }),
      });
      expect(layerOf(result, 'photo')).toEqual({
        ...layerOf(document, 'photo'),
        imageRef: { type: 'media', ...NEW_IMAGE },
      });
      expect(layerOf(result, 'photo')).toMatchObject({
        fit: 'contain',
        focalPoint: { x: 0.25, y: 0.75 },
        mask,
      });
      // the template is untouched, and the result is a plain image layer
      expect(JSON.stringify(document)).toBe(before);
      expect(JSON.stringify(result)).not.toMatch(
        /slot|guidance|label|required/
      );
    }
  });
});
