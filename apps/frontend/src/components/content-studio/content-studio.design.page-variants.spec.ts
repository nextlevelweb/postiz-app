import { TextEncoder as NodeTextEncoder } from 'util';
import {
  ContentStudioDesignDocumentV1,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioDesignEditorError,
  createContentStudioDesignPageVariant,
  createContentStudioDesignPageVariants,
  duplicateContentStudioDesignPage,
  scaleContentStudioDesignLayerForPageVariant,
} from './content-studio.design.editor';

// Campaign size variants (P4-16), pure: a page made again in another size,
// scaled uniformly and centered, as ordinary independent Design Document v1
// pages. No React, API, DOM, Media or Brand Kit
if (typeof (globalThis as any).TextEncoder === 'undefined') {
  (globalThis as any).TextEncoder = NodeTextEncoder;
}

type Plain = Record<string, any>;
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const lit = (value: string) => ({ type: 'literal', value });
const tok = (tokenId: string) => ({ type: 'brand', tokenId });
const SQUARE = { width: 1080, height: 1080, label: 'Square' };
const PORTRAIT = { width: 1080, height: 1350, label: 'Portrait' };
const STORY = { width: 1080, height: 1920, label: 'Story' };
const LANDSCAPE = { width: 1200, height: 628, label: 'Landscape' };
const base = {
  name: 'Layer',
  x: 100,
  y: 200,
  width: 400,
  height: 100,
  rotation: 15,
  opacity: 0.8,
  visible: false,
};
const TEXT = {
  ...base,
  id: 'title',
  name: 'Title',
  type: 'text',
  text: '  Launch\nday ',
  font: { type: 'family', family: 'Inter', weight: 700, style: 'italic' },
  fontSize: 40,
  lineHeight: 1.2,
  letterSpacing: 2,
  color: lit('#112233'),
  align: 'center',
  verticalAlign: 'middle',
  overflow: 'shrink',
};
const BRAND_TEXT = {
  ...TEXT,
  id: 'tagline',
  font: tok('heading'),
  color: tok('ink'),
  letterSpacing: -1,
};
const RECT = {
  ...base,
  id: 'card',
  name: 'Card',
  type: 'shape',
  shape: 'rectangle',
  fill: tok('primary'),
  cornerRadius: 40,
  rotation: 0,
  visible: true,
};
const ELLIPSE = {
  ...RECT,
  id: 'dot',
  shape: 'ellipse',
  fill: lit('#ff0000'),
  cornerRadius: 0,
};
const image = (id: string, mask?: Plain) => ({
  ...base,
  id,
  name: 'Photo',
  type: 'image',
  imageRef: { type: 'media', mediaId: 'media-1', sha256: SHA('a') },
  fit: 'contain',
  focalPoint: { x: 0.2, y: 0.9 },
  rotation: 30,
  ...(mask ? { mask } : {}),
});
const page = (id: string, size: Plain, layers: Plain[], name = 'Launch') => ({
  id,
  name,
  width: size.width,
  height: size.height,
  background: { type: 'solid', color: tok('primary') },
  layers,
});
const BRAND_REF = {
  brandKitId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  revisionId: '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  revisionNumber: 2,
  contentHash: SHA('b'),
};
const LAYERS = () => [
  TEXT,
  BRAND_TEXT,
  RECT,
  ELLIPSE,
  image('plain'),
  image('rounded', { type: 'roundedRectangle', cornerRadius: 24 }),
  image('oval', { type: 'ellipse' }),
  image('rect', { type: 'rectangle' }),
];
const documentOf = (pages: Plain[]) =>
  parseContentStudioDesignDocument({
    schemaVersion: 1,
    brandKit: BRAND_REF,
    pages,
  });
const SOURCE = () =>
  documentOf([
    page('p_before', SQUARE, [], 'Before'),
    page('p_src', SQUARE, LAYERS()),
    page('p_after', PORTRAIT, [], 'After'),
  ]);
const refused = (run: () => unknown, code: string) => {
  let error: unknown;
  try {
    run();
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ContentStudioDesignEditorError);
  expect((error as ContentStudioDesignEditorError).code).toBe(code);
};
const valid = (document: ContentStudioDesignDocumentV1) =>
  expect(parseContentStudioDesignDocument(document)).toEqual(document);
const variantOf = (
  document: ContentStudioDesignDocumentV1,
  target = PORTRAIT,
  pageId = 'p_src'
) => {
  const created = createContentStudioDesignPageVariant(
    document,
    pageId,
    target
  );
  return {
    ...created,
    page: created.document.pages.find((p) => p.id === created.pageId)!,
  };
};
const layer = (p: { layers: Plain[] }, index: number) => p.layers[index];

// ============================================================================
describe('Page size variants: geometry', () => {
  it('V1/V2 square to portrait and to story: the target size, centered with scale 1', () => {
    const portrait = variantOf(SOURCE(), PORTRAIT).page;
    expect([portrait.width, portrait.height]).toEqual([1080, 1350]);
    expect(layer(portrait, 0)).toMatchObject({
      x: 100,
      y: 335,
      width: 400,
      height: 100,
    });
    const story = variantOf(SOURCE(), STORY).page;
    expect([story.width, story.height]).toEqual([1080, 1920]);
    expect(layer(story, 0)).toMatchObject({ x: 100, y: 620 });
  });

  it('V3 portrait to square: scale 0.8 around the page centers', () => {
    const doc = documentOf([page('p_src', PORTRAIT, [TEXT])]);
    const square = variantOf(doc, SQUARE).page;
    expect([square.width, square.height]).toEqual([1080, 1080]);
    expect(layer(square, 0)).toMatchObject({
      x: 188,
      y: 160,
      width: 320,
      height: 80,
      fontSize: 32,
      letterSpacing: 1.6,
    });
  });

  it('V4 story to square: a full-bleed layer fits the height and is centered', () => {
    const doc = documentOf([
      page('p_src', STORY, [
        { ...RECT, x: 0, y: 0, width: 1080, height: 1920 },
      ]),
    ]);
    expect(layer(variantOf(doc, SQUARE).page, 0)).toMatchObject({
      x: 236.25,
      y: 0,
      width: 607.5,
      height: 1080,
    });
  });

  it('V5/M3 the source page and the document are not changed', () => {
    const doc = SOURCE();
    const frozen = JSON.stringify(doc);
    const { document: next } = createContentStudioDesignPageVariants(
      doc,
      'p_src',
      [PORTRAIT, STORY]
    );
    expect(JSON.stringify(doc)).toBe(frozen);
    expect(next.pages[1]).toEqual(doc.pages[1]);
    expect(JSON.stringify(next.pages[1])).toBe(JSON.stringify(doc.pages[1]));
  });

  it('V6/V7 a new page id and a new id for every layer, unique in the document', () => {
    const { document: next, pageIds } = createContentStudioDesignPageVariants(
      SOURCE(),
      'p_src',
      [PORTRAIT, STORY]
    );
    const allPages = next.pages.map((p) => p.id);
    const allLayers = next.pages.flatMap((p) => p.layers.map((l) => l.id));
    expect(new Set(allPages).size).toBe(allPages.length);
    expect(new Set(allLayers).size).toBe(allLayers.length);
    for (const id of pageIds) {
      expect(id).toMatch(/^p_[0-9a-f]{20}$/);
      const created = next.pages.find((p) => p.id === id)!;
      for (const entry of created.layers) {
        expect(entry.id).toMatch(/^l_[0-9a-f]{20}$/);
      }
    }
  });

  it('V8 the layer order (z-order) and the background are kept', () => {
    const doc = SOURCE();
    const created = variantOf(doc, STORY).page;
    expect(created.layers.map((l) => l.name)).toEqual(
      doc.pages[1].layers.map((l) => l.name)
    );
    expect(created.layers.map((l) => l.type)).toEqual(
      doc.pages[1].layers.map((l) => l.type)
    );
    expect(created.background).toEqual(doc.pages[1].background);
    expect(created.background).not.toBe(doc.pages[1].background);
  });

  it('V9/V10 boxes scale uniformly and the composition is centered on the target', () => {
    const doc = documentOf([page('p_src', SQUARE, [RECT])]);
    const scale = 628 / 1080;
    const out = layer(variantOf(doc, LANDSCAPE).page, 0);
    expect(out.width).toBeCloseTo(400 * scale, 10);
    expect(out.height).toBeCloseTo(100 * scale, 10);
    // the layer center keeps its offset from the page center, scaled
    expect(out.x + out.width / 2 - 600).toBeCloseTo((300 - 540) * scale, 10);
    expect(out.y + out.height / 2 - 314).toBeCloseTo((250 - 540) * scale, 10);
  });

  it('V11/V12 rotation, opacity and visibility stay', () => {
    const created = variantOf(SOURCE(), LANDSCAPE).page;
    LAYERS().forEach((source, index) => {
      expect(layer(created, index)).toMatchObject({
        rotation: source.rotation,
        opacity: source.opacity,
        visible: source.visible,
      });
    });
  });

  it('V13 fractions are kept, never rounded; -0 is stored as 0', () => {
    const doc = documentOf([page('p_src', SQUARE, [{ ...RECT, x: 0.5 }])]);
    const out = layer(variantOf(doc, LANDSCAPE).page, 0);
    expect(Number.isInteger(out.x)).toBe(false);
    const centered = documentOf([
      page('p_src', SQUARE, [{ ...RECT, x: 340, y: 490 }]),
    ]);
    const square = layer(variantOf(centered, SQUARE).page, 0);
    expect(square).toMatchObject({ x: 340, y: 490 });
    const zero = documentOf([
      page('p_src', SQUARE, [
        { ...RECT, x: 0, y: 0, width: 1080, height: 1080 },
      ]),
    ]);
    const filled = layer(variantOf(zero, STORY).page, 0);
    expect(Object.is(filled.x, 0)).toBe(true);
    expect(filled.y).toBe(420);
  });

  it('V14 never stretched: the aspect of every box is kept, whatever the target', () => {
    for (const target of [PORTRAIT, STORY, LANDSCAPE, SQUARE]) {
      const created = variantOf(SOURCE(), target).page;
      created.layers.forEach((entry) => {
        expect(entry.width / entry.height).toBeCloseTo(400 / 100, 10);
      });
    }
  });

  it('the result is valid Design Document v1; plain duplicate page is unchanged', () => {
    const { document: next } = createContentStudioDesignPageVariants(
      SOURCE(),
      'p_src',
      [PORTRAIT, STORY, LANDSCAPE]
    );
    valid(next);
    const plain = duplicateContentStudioDesignPage(SOURCE(), 'p_src');
    const copy = plain.document.pages[2];
    expect(copy.name).toBe('Launch');
    expect([copy.width, copy.height]).toEqual([1080, 1080]);
    expect(copy.layers.map(({ id, ...rest }) => rest)).toEqual(
      SOURCE().pages[1].layers.map(({ id, ...rest }) => rest)
    );
  });
});

// ============================================================================
describe('Page size variants: text, shapes and images', () => {
  const FROM_PORTRAIT = () => documentOf([page('p_src', PORTRAIT, LAYERS())]);
  const square = () => variantOf(FROM_PORTRAIT(), SQUARE).page;

  it('TXT1/TXT7 font size and letter spacing (design units) scale with the page', () => {
    expect(layer(square(), 0)).toMatchObject({
      fontSize: 32,
      letterSpacing: 1.6,
    });
    expect(layer(square(), 1).letterSpacing).toBeCloseTo(-0.8, 10);
  });

  it('TXT2 the text is exactly the same, whitespace included', () => {
    expect(layer(square(), 0).text).toBe('  Launch\nday ');
  });

  it('TXT3/TXT4/TXT5 family, weight, style, color, alignment and overflow stay', () => {
    expect(layer(square(), 0)).toMatchObject({
      font: { type: 'family', family: 'Inter', weight: 700, style: 'italic' },
      color: lit('#112233'),
      align: 'center',
      verticalAlign: 'middle',
      overflow: 'shrink',
    });
  });

  it('TXT6 line height is a multiple of the font size and stays', () => {
    expect(layer(square(), 0).lineHeight).toBe(1.2);
    expect(layer(square(), 1).lineHeight).toBe(1.2);
  });

  it('TXT8 the scaled text is valid Design Document v1', () => {
    expect(() =>
      parseContentStudioDesignDocument(
        variantOf(FROM_PORTRAIT(), SQUARE).document
      )
    ).not.toThrow();
  });

  it('TXT9 a Brand typography token stays the same token; its layer font size scales', () => {
    expect(layer(square(), 1)).toMatchObject({
      font: tok('heading'),
      color: tok('ink'),
      fontSize: 32,
    });
  });

  it('SH1/SH2/SH3/SH4 a shape keeps fill, kind and opacity; its corner radius scales', () => {
    expect(layer(square(), 2)).toMatchObject({
      type: 'shape',
      shape: 'rectangle',
      fill: tok('primary'),
      opacity: 0.8,
      cornerRadius: 32,
    });
  });

  it('SH5 an ellipse stays an ellipse with radius 0', () => {
    expect(layer(square(), 3)).toMatchObject({
      shape: 'ellipse',
      cornerRadius: 0,
      fill: lit('#ff0000'),
    });
  });

  it('IM1/IM2/IM3/IM7/IM8 an image keeps its Media reference, SHA-256, fit, focal point and rotation', () => {
    for (const index of [4, 5, 6, 7]) {
      expect(layer(square(), index)).toMatchObject({
        imageRef: { type: 'media', mediaId: 'media-1', sha256: SHA('a') },
        fit: 'contain',
        focalPoint: { x: 0.2, y: 0.9 },
        rotation: 30,
      });
    }
  });

  it('IM4/IM5/IM6 masks: none stays none, rectangle and ellipse stay, a rounded radius scales', () => {
    expect(layer(square(), 4)).not.toHaveProperty('mask');
    const rounded = layer(square(), 5).mask;
    expect(rounded.type).toBe('roundedRectangle');
    // 24 x 0.8, exactly as floating point gives it: never rounded
    expect(rounded.cornerRadius).toBe(24 * (1080 / 1350));
    expect(rounded.cornerRadius).toBeCloseTo(19.2, 10);
    expect(layer(square(), 6).mask).toEqual({ type: 'ellipse' });
    expect(layer(square(), 7).mask).toEqual({ type: 'rectangle' });
  });

  it('the layer helper returns a new object and leaves its input as it was', () => {
    const input = JSON.parse(
      JSON.stringify(
        image('rounded', {
          type: 'roundedRectangle',
          cornerRadius: 24,
        })
      )
    );
    const frozen = JSON.stringify(input);
    const out = scaleContentStudioDesignLayerForPageVariant(
      input,
      PORTRAIT,
      SQUARE
    );
    (out as Plain).mask.cornerRadius = 1;
    (out as Plain).focalPoint.x = 0;
    expect(JSON.stringify(input)).toBe(frozen);
    expect(out.id).toBe('rounded');
  });
});

// ============================================================================
describe('Campaign variants', () => {
  it('CAM1/CAM2/PO3/PO4 all targets, right after the source, in the targets’ order', () => {
    const { document: next, pageIds } = createContentStudioDesignPageVariants(
      SOURCE(),
      'p_src',
      [STORY, SQUARE, PORTRAIT]
    );
    expect(next.pages.map((p) => [p.name, p.width, p.height])).toEqual([
      ['Before', 1080, 1080],
      ['Launch', 1080, 1080],
      ['Launch · Story', 1080, 1920],
      ['Launch · Square', 1080, 1080],
      ['Launch · Portrait', 1080, 1350],
      ['After', 1080, 1350],
    ]);
    expect(pageIds).toEqual(next.pages.slice(2, 5).map((p) => p.id));
  });

  it('CAM3/PO1/PO2 one variant goes directly after its source; following pages keep their order', () => {
    const { document: next, page: created } = variantOf(SOURCE(), STORY);
    expect(next.pages.map((p) => p.id)).toEqual([
      'p_before',
      'p_src',
      created.id,
      'p_after',
    ]);
  });

  it('CAM4 the source keeps its place, name and layers', () => {
    const doc = SOURCE();
    const { document: next } = createContentStudioDesignPageVariants(
      doc,
      'p_src',
      [PORTRAIT, STORY]
    );
    expect(next.pages[1]).toEqual(doc.pages[1]);
    expect(next.pages[0]).toBe(doc.pages[0]);
  });

  it('CAM9 a size asked for twice, no size, or an invalid size is refused', () => {
    refused(
      () =>
        createContentStudioDesignPageVariants(SOURCE(), 'p_src', [
          PORTRAIT,
          { ...PORTRAIT, label: 'Again' },
        ]),
      'INVALID_TARGET_SIZE'
    );
    refused(
      () => createContentStudioDesignPageVariants(SOURCE(), 'p_src', []),
      'INVALID_TARGET_SIZE'
    );
    for (const size of [
      { width: 63, height: 1080 },
      { width: 1080.5, height: 1080 },
      { width: 8193, height: 1080 },
      { width: 8192, height: 8192 },
      { width: NaN, height: 1080 },
    ]) {
      refused(
        () => variantOf(SOURCE(), { ...size, label: 'Odd' }),
        'INVALID_TARGET_SIZE'
      );
    }
    refused(() => variantOf(SOURCE(), PORTRAIT, 'nope'), 'NOT_FOUND');
  });

  it('CAM10 the source’s own size makes an ordinary copy at scale 1', () => {
    const doc = SOURCE();
    const created = variantOf(doc, SQUARE).page;
    expect(created.name).toBe('Launch · Square');
    expect(created.layers.map(({ id, ...rest }) => rest)).toEqual(
      doc.pages[1].layers.map(({ id, ...rest }) => rest)
    );
  });

  it('page names: "name · label", the label alone without a name, shortened to the limit', () => {
    const unnamed = documentOf([page('p_src', SQUARE, [], '')]);
    expect(variantOf(unnamed, STORY).page.name).toBe('Story');
    const long = documentOf([page('p_src', SQUARE, [], 'n'.repeat(100))]);
    const name = variantOf(long, STORY).page.name;
    expect(name).toHaveLength(100);
    expect(name.endsWith(' · Story')).toBe(true);
    const twice = variantOf(
      documentOf([page('p_src', SQUARE, [], 'Launch · Square')]),
      STORY
    ).page.name;
    expect(twice).toBe('Launch · Square · Story');
  });
});

// ============================================================================
describe('Page size variants: limits, all or nothing', () => {
  it('VLIM1 never a 26th page: refused before anything is made', () => {
    const doc = documentOf(
      Array.from({ length: 24 }, (_, i) => page(`p${i}`, SQUARE, []))
    );
    const frozen = JSON.stringify(doc);
    refused(
      () => createContentStudioDesignPageVariants(doc, 'p0', [PORTRAIT, STORY]),
      'PAGE_LIMIT'
    );
    expect(JSON.stringify(doc)).toBe(frozen);
    expect(
      createContentStudioDesignPageVariants(doc, 'p0', [PORTRAIT]).document
        .pages
    ).toHaveLength(25);
  });

  it('VLIM2 never more than 1000 layers in all', () => {
    const fill = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        ...RECT,
        id: `${prefix}${i}`,
      }));
    const doc = documentOf([
      page('p_src', SQUARE, fill('s', 200)),
      page('p1', SQUARE, fill('a', 200)),
      page('p2', SQUARE, fill('b', 200)),
      page('p3', SQUARE, fill('c', 100)),
    ]);
    refused(
      () =>
        createContentStudioDesignPageVariants(doc, 'p_src', [PORTRAIT, STORY]),
      'LAYER_LIMIT'
    );
    expect(
      createContentStudioDesignPageVariants(doc, 'p_src', [PORTRAIT]).document
        .pages
    ).toHaveLength(5);
  });

  it('VLIM3 too much text in the result is refused as a whole', () => {
    const long = { ...TEXT, text: 'x'.repeat(10_000) };
    const doc = documentOf([
      page(
        'p_src',
        SQUARE,
        Array.from({ length: 10 }, (_, i) => ({ ...long, id: `t${i}` }))
      ),
      page(
        'p_more',
        SQUARE,
        Array.from({ length: 10 }, (_, i) => ({ ...long, id: `u${i}` }))
      ),
    ]);
    // 200 000 characters already: one more copy of 100 000 is too much
    const frozen = JSON.stringify(doc);
    refused(() => variantOf(doc, STORY), 'VARIANT_OUT_OF_LIMITS');
    expect(JSON.stringify(doc)).toBe(frozen);
  });

  it('VLIM4 a scaled value outside the design limits refuses it all', () => {
    // a 1024 font on a 64 x 64 page made 1080 wide is past the font limit
    const doc = documentOf([
      page('p_src', { width: 64, height: 64 }, [
        { ...TEXT, x: 0, y: 0, width: 64, height: 64, fontSize: 100 },
      ]),
    ]);
    const frozen = JSON.stringify(doc);
    refused(() => variantOf(doc, SQUARE), 'VARIANT_OUT_OF_LIMITS');
    expect(JSON.stringify(doc)).toBe(frozen);
  });

  it('VLIM6 a refused request leaves the source page and every other page as they were', () => {
    const doc = SOURCE();
    const frozen = JSON.stringify(doc);
    for (const run of [
      () => createContentStudioDesignPageVariants(doc, 'p_src', []),
      () => variantOf(doc, { width: 1, height: 1, label: 'x' }),
    ]) {
      expect(run).toThrow(ContentStudioDesignEditorError);
    }
    expect(JSON.stringify(doc)).toBe(frozen);
  });
});
