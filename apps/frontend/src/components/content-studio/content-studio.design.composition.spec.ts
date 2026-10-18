import { TextEncoder as NodeTextEncoder } from 'util';
import {
  ContentStudioDesignDocumentV1,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { parseContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import {
  extractContentStudioDesignLayoutPattern,
  parseContentStudioDesignLayoutPatternContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.layout.pattern';
import { listContentStudioSystemDesignLayoutPatterns } from '@gitroom/nestjs-libraries/content-studio/design/design.system.layout.patterns';
import {
  arrangeContentStudioDesignLayersInColumn,
  arrangeContentStudioDesignLayersInGrid,
  arrangeContentStudioDesignLayersInRow,
  centerContentStudioDesignLayersOnPage,
  ContentStudioDesignEditorError,
  insertContentStudioDesignLayoutPattern,
  moveContentStudioDesignLayersIntoPage,
  spaceContentStudioDesignLayers,
} from './content-studio.design.editor';

// Composition helpers and layout pattern insertion (P4-15), pure: the
// editor operations on a Design Document v1, without React, API or DOM
if (typeof (globalThis as any).TextEncoder === 'undefined') {
  (globalThis as any).TextEncoder = NodeTextEncoder;
}

type Plain = Record<string, any>;
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const lit = (value: string) => ({ type: 'literal', value });
const tok = (tokenId: string) => ({ type: 'brand', tokenId });
const rect = (id: string, x: number, y: number, extra: Plain = {}) => ({
  id,
  name: '',
  x,
  y,
  width: 100,
  height: 100,
  rotation: 0,
  opacity: 1,
  visible: true,
  type: 'shape',
  shape: 'rectangle',
  fill: lit('#ff0000'),
  cornerRadius: 0,
  ...extra,
});
const text = (extra: Plain = {}) => ({
  name: 'Title',
  x: 0,
  y: 0,
  width: 400,
  height: 100,
  rotation: 0,
  opacity: 1,
  visible: true,
  type: 'text',
  text: 'Hello',
  font: { type: 'family', family: 'Inter', weight: 400, style: 'normal' },
  fontSize: 40,
  lineHeight: 1.2,
  letterSpacing: 0,
  color: lit('#111111'),
  align: 'left',
  verticalAlign: 'top',
  overflow: 'clip',
  ...extra,
});
const withoutId = ({ id, ...layer }: Plain) => {
  void id;
  return layer;
};
const BRAND_REF = {
  brandKitId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  revisionId: '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  revisionNumber: 2,
  contentHash: SHA('b'),
};
const BRAND = parseContentStudioBrandKitContent({
  schemaVersion: 1,
  identity: { brandName: 'Northwind', tagline: '', description: '' },
  colors: [
    { id: 'primary', name: 'Primary', value: '#0057ff', role: 'primary' },
  ],
  typography: [
    {
      id: 'heading',
      name: 'Heading',
      family: 'Inter',
      weight: 700,
      style: 'normal',
      role: 'heading',
    },
  ],
  visualDirection: { keywords: [], dos: [], donts: [] },
});
const page = (id: string, layers: Plain[], extra: Plain = {}) => ({
  id,
  name: '',
  width: 1000,
  height: 800,
  background: { type: 'solid', color: lit('#ffffff') },
  layers,
  ...extra,
});
const documentOf = (
  layers: Plain[],
  brandKit: Plain | null = null,
  pages: Plain[] = []
) =>
  parseContentStudioDesignDocument({
    schemaVersion: 1,
    brandKit,
    pages: [page('p1', layers), ...pages],
  });
// a: 100 wide at 0, b: 200 wide at 300, c: 50 wide at 700 (page order a, b, c)
const ROW = () =>
  documentOf(
    [
      rect('a', 0, 10),
      rect('b', 300, 40, { width: 200, height: 50 }),
      rect('c', 700, 0, { width: 50, height: 150, rotation: 45 }),
    ],
    null,
    [page('p2', [rect('far', 0, 0)])]
  );
const at = (document: ContentStudioDesignDocumentV1, id: string) => {
  const layer = document.pages
    .flatMap((entry) => entry.layers)
    .find((entry) => entry.id === id)!;
  return [layer.x, layer.y];
};
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

// ============================================================================
describe('Composition helpers', () => {
  it('CH1 centers the selection on the page as a whole, keeping relative places', () => {
    const before = ROW();
    const frozen = JSON.stringify(before);
    const next = centerContentStudioDesignLayersOnPage(
      before,
      ['a', 'b', 'c'],
      'both'
    );
    // bounds 0..750 x 0..150 → centered on 1000 x 800
    expect([at(next, 'a'), at(next, 'b'), at(next, 'c')]).toEqual([
      [125, 335],
      [425, 365],
      [825, 325],
    ]);
    expect(JSON.stringify(before)).toBe(frozen);
    valid(next);
  });

  it('CH2 centers horizontally or vertically only; one layer works too', () => {
    const doc = ROW();
    expect(
      at(centerContentStudioDesignLayersOnPage(doc, ['b'], 'horizontal'), 'b')
    ).toEqual([400, 40]);
    expect(
      at(centerContentStudioDesignLayersOnPage(doc, ['b'], 'vertical'), 'b')
    ).toEqual([300, 375]);
  });

  it('CH3 equal horizontal gap: ordered by left edge, the first stays, the others follow', () => {
    const next = spaceContentStudioDesignLayers(
      ROW(),
      ['c', 'a', 'b'],
      'horizontal',
      24
    );
    expect([at(next, 'a'), at(next, 'b'), at(next, 'c')]).toEqual([
      [0, 10],
      [124, 40],
      [348, 0],
    ]);
  });

  it('CH4 equal vertical gap keeps x; ties by id; two layers are enough', () => {
    const doc = documentOf([rect('y', 50, 100), rect('x', 0, 100)]);
    const next = spaceContentStudioDesignLayers(doc, ['y', 'x'], 'vertical', 0);
    expect([at(next, 'x'), at(next, 'y')]).toEqual([
      [0, 100],
      [50, 200],
    ]);
  });

  it('CH5 a negative gap overlaps; a gap past the limits refuses it all', () => {
    expect(
      at(
        spaceContentStudioDesignLayers(ROW(), ['a', 'b'], 'horizontal', -50),
        'b'
      )
    ).toEqual([50, 40]);
    for (const gap of [NaN, Infinity, 32_769, -32_769]) {
      refused(
        () =>
          spaceContentStudioDesignLayers(ROW(), ['a', 'b'], 'horizontal', gap),
        'OUT_OF_LIMITS'
      );
    }
  });

  it('CH6 row: page order, tops lined up at the bounds, exact gaps', () => {
    const next = arrangeContentStudioDesignLayersInRow(
      ROW(),
      ['c', 'b', 'a'],
      10
    );
    expect([at(next, 'a'), at(next, 'b'), at(next, 'c')]).toEqual([
      [0, 0],
      [110, 0],
      [320, 0],
    ]);
  });

  it('CH7 column: page order, left edges lined up, exact gaps', () => {
    const next = arrangeContentStudioDesignLayersInColumn(
      ROW(),
      ['a', 'b', 'c'],
      20
    );
    expect([at(next, 'a'), at(next, 'b'), at(next, 'c')]).toEqual([
      [0, 0],
      [0, 120],
      [0, 190],
    ]);
  });

  it('CH8 grid: row by row, columns as wide as their widest, rows as high as their highest', () => {
    const doc = documentOf([
      // the tallest of a row is not its last
      rect('g1', 500, 500, { width: 50, height: 60 }),
      rect('g2', 100, 200, { width: 80, height: 30 }),
      rect('g3', 0, 0, { width: 120, height: 10 }),
      rect('g4', 900, 700, { width: 20, height: 40 }),
      rect('g5', 300, 300, { width: 10, height: 10 }),
    ]);
    const next = arrangeContentStudioDesignLayersInGrid(
      doc,
      ['g1', 'g2', 'g3', 'g4', 'g5'],
      2,
      5,
      7
    );
    // columns: max(50,120,10)=120, max(80,20)=80; rows: max(60,30)=60, 40, 10
    expect(['g1', 'g2', 'g3', 'g4', 'g5'].map((id) => at(next, id))).toEqual([
      [0, 0],
      [125, 0],
      [0, 67],
      [125, 67],
      [0, 114],
    ]);
  });

  it('CH9 sizes, rotation, z-order and everything else stay; rotated layers use the stored box', () => {
    const before = ROW();
    const next = arrangeContentStudioDesignLayersInGrid(
      before,
      ['a', 'b', 'c'],
      2,
      0,
      0
    );
    const rest = (layer: Plain) => ({ ...layer, x: 0, y: 0 });
    expect(next.pages[0].layers.map(rest)).toEqual(
      before.pages[0].layers.map(rest)
    );
    expect(next.pages[0].layers.map((l) => l.id)).toEqual(['a', 'b', 'c']);
    expect(next.pages[1]).toBe(before.pages[1]);
  });

  it('CH10 a grid of invalid columns or gaps is refused', () => {
    for (const columns of [0, -1, 1.5, 4, NaN]) {
      refused(
        () =>
          arrangeContentStudioDesignLayersInGrid(
            ROW(),
            ['a', 'b', 'c'],
            columns,
            0,
            0
          ),
        'OUT_OF_LIMITS'
      );
    }
    refused(
      () =>
        arrangeContentStudioDesignLayersInGrid(ROW(), ['a', 'b'], 1, 0, NaN),
      'OUT_OF_LIMITS'
    );
  });

  it('CH11 needs one page and enough layers: missing, repeated, cross-page or too few ids refuse it', () => {
    refused(
      () => centerContentStudioDesignLayersOnPage(ROW(), [], 'both'),
      'NOT_FOUND'
    );
    refused(
      () => centerContentStudioDesignLayersOnPage(ROW(), ['a', 'far'], 'both'),
      'NOT_FOUND'
    );
    refused(
      () => spaceContentStudioDesignLayers(ROW(), ['a'], 'horizontal', 0),
      'NOT_FOUND'
    );
    refused(
      () => arrangeContentStudioDesignLayersInRow(ROW(), ['a', 'a'], 0),
      'NOT_FOUND'
    );
    refused(
      () =>
        arrangeContentStudioDesignLayersInColumn(ROW(), ['a', 'missing'], 0),
      'NOT_FOUND'
    );
  });

  it('CH12 atomic: a result outside the coordinate limits changes no layer', () => {
    const doc = documentOf([
      rect('w', 0, 0, { width: 20_000 }),
      rect('v', 0, 0, { width: 20_000 }),
      rect('u', 0, 0, { width: 20_000 }),
    ]);
    const frozen = JSON.stringify(doc);
    refused(
      () => arrangeContentStudioDesignLayersInRow(doc, ['w', 'v', 'u'], 0),
      'OUT_OF_LIMITS'
    );
    expect(JSON.stringify(doc)).toBe(frozen);
  });

  it('CH13 move into page: only translation, as little as needed; larger than the page goes to its edge', () => {
    const doc = documentOf([
      rect('out', -50, 760, { width: 100, height: 100 }),
      rect('wide', 900, 100, { width: 1200, height: 100 }),
      rect('inside', 10, 10),
    ]);
    const moved = moveContentStudioDesignLayersIntoPage(doc, ['out']);
    expect(at(moved, 'out')).toEqual([0, 700]);
    const wide = moveContentStudioDesignLayersIntoPage(doc, ['wide']);
    expect(at(wide, 'wide')).toEqual([0, 100]);
    expect(wide.pages[0].layers[1].width).toBe(1200);
    const both = moveContentStudioDesignLayersIntoPage(doc, ['out', 'inside']);
    // together 850 high: taller than the page, so the top goes to its top
    expect([at(both, 'out'), at(both, 'inside')]).toEqual([
      [0, 750],
      [60, 0],
    ]);
    expect(moveContentStudioDesignLayersIntoPage(doc, ['inside'])).toEqual(doc);
  });
});

// ============================================================================
describe('Layout pattern insertion', () => {
  const PATTERN = parseContentStudioDesignLayoutPatternContent({
    schemaVersion: 1,
    width: 400,
    height: 200,
    layers: [
      withoutId(rect('x', 0, 0, { width: 400, height: 200 })),
      text({ x: 20, y: 50 }),
    ],
  });
  const insert = (
    doc: ContentStudioDesignDocumentV1,
    content = PATTERN,
    brand: typeof BRAND | null = null
  ) => insertContentStudioDesignLayoutPattern(doc, 'p1', content, brand);

  it('LI6 appends the layers in front, centered on the page, in pattern order', () => {
    const doc = documentOf([rect('old', 0, 0)]);
    const { document: next, layerIds } = insert(doc);
    const layers = next.pages[0].layers;
    expect(layers.map((l) => l.id)).toEqual(['old', ...layerIds]);
    expect(layers.slice(1).map((l) => [l.type, l.x, l.y])).toEqual([
      ['shape', 300, 300],
      ['text', 320, 350],
    ]);
    valid(next);
  });

  it('LI7 every inserted layer has a fresh id, unique in the document', () => {
    const doc = documentOf([rect('old', 0, 0)], null, [
      page('p2', [rect('far', 0, 0)]),
    ]);
    const once = insert(doc);
    const twice = insert(once.document);
    const ids = twice.document.pages.flatMap((p) => p.layers.map((l) => l.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(twice.layerIds).toHaveLength(2);
    for (const id of [...once.layerIds, ...twice.layerIds]) {
      expect(id).toMatch(/^l_[0-9a-f]{20}$/);
    }
  });

  it('LI8 the result names the new layers back to front (the last one is in front)', () => {
    const { document: next, layerIds } = insert(documentOf([]));
    expect(next.pages[0].layers.map((l) => l.id)).toEqual(layerIds);
  });

  it('LI9 the pattern and the document stay as they were; layers are copies', () => {
    const doc = documentOf([]);
    const frozenDoc = JSON.stringify(doc);
    const frozenPattern = JSON.stringify(PATTERN);
    const { document: next } = insert(doc);
    (next.pages[0].layers[1] as Plain).font.weight = 900;
    expect(JSON.stringify(doc)).toBe(frozenDoc);
    expect(JSON.stringify(PATTERN)).toBe(frozenPattern);
  });

  it('LI10 other pages, the page background and the Brand Kit reference stay', () => {
    const doc = documentOf([], BRAND_REF, [page('p2', [rect('far', 0, 0)])]);
    const { document: next } = insert(doc, PATTERN, BRAND);
    expect(next.pages[1]).toBe(doc.pages[1]);
    expect(next.pages[0].background).toEqual(doc.pages[0].background);
    expect(next.brandKit).toEqual(BRAND_REF);
  });

  it('LI11 Media references, fit, focal point and mask are kept exactly', () => {
    const content = parseContentStudioDesignLayoutPatternContent({
      schemaVersion: 1,
      width: 100,
      height: 100,
      layers: [
        {
          name: 'Photo',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          rotation: 10,
          opacity: 1,
          visible: true,
          type: 'image',
          imageRef: { type: 'media', mediaId: 'media-1', sha256: SHA('c') },
          fit: 'contain',
          focalPoint: { x: 0.1, y: 0.9 },
          mask: { type: 'ellipse' },
        },
      ],
    });
    const { document: next } = insert(documentOf([]), content);
    expect(next.pages[0].layers[0]).toMatchObject({
      imageRef: { type: 'media', mediaId: 'media-1', sha256: SHA('c') },
      fit: 'contain',
      focalPoint: { x: 0.1, y: 0.9 },
      mask: { type: 'ellipse' },
      rotation: 10,
    });
  });

  it('LI12 an unknown page is refused', () => {
    refused(
      () =>
        insertContentStudioDesignLayoutPattern(
          documentOf([]),
          'nope',
          PATTERN,
          null
        ),
      'NOT_FOUND'
    );
  });

  it('LI13 a pattern larger than the page is centered (negative corner) when within the limits', () => {
    const content = parseContentStudioDesignLayoutPatternContent({
      ...PATTERN,
      width: 3000,
    });
    const { document: next } = insert(documentOf([]), content);
    expect(next.pages[0].layers[0].x).toBe(-1000);
  });

  it('LI14 a layer that would be outside the coordinate limits refuses it all', () => {
    const content = parseContentStudioDesignLayoutPatternContent({
      schemaVersion: 1,
      width: 1,
      height: 100,
      layers: [{ ...text(), x: 32_000 }],
    });
    // centered on a page 8192 wide: 32 000 + 4095.5 is past the limit
    const doc = parseContentStudioDesignDocument({
      schemaVersion: 1,
      brandKit: null,
      pages: [page('p1', [], { width: 8192, height: 1000 })],
    });
    const frozen = JSON.stringify(doc);
    refused(() => insert(doc, content), 'OUT_OF_LIMITS');
    expect(JSON.stringify(doc)).toBe(frozen);
  });

  it('LI15 a saved selection inserted again is the same arrangement, centered', () => {
    const doc = documentOf([
      rect('a', 10, 20, { width: 50 }),
      rect('b', 200, 300, { rotation: 15 }),
    ]);
    const content = extractContentStudioDesignLayoutPattern(doc, ['b', 'a'])!;
    const { document: next, layerIds } = insert(documentOf([]), content);
    const [a, b] = next.pages[0].layers;
    expect(layerIds).toHaveLength(2);
    expect(b.x - a.x).toBe(190);
    expect(b.y - a.y).toBe(280);
    expect(b.rotation).toBe(15);
    // bounds 290 x 380 centered on 1000 x 800
    expect([a.x, a.y]).toEqual([355, 210]);
  });

  it('LIM1 refuses a page that would hold more than 200 layers', () => {
    const doc = documentOf(
      Array.from({ length: 199 }, (_, i) => rect(`l${i}`, 0, 0))
    );
    refused(() => insert(doc), 'LAYER_LIMIT');
    const one = parseContentStudioDesignLayoutPatternContent({
      ...PATTERN,
      layers: [PATTERN.layers[0]],
    });
    expect(insert(doc, one).document.pages[0].layers).toHaveLength(200);
  });

  it('LIM2 refuses a document that would hold more than 1000 layers', () => {
    const pages = Array.from({ length: 5 }, (_, p) =>
      page(
        `q${p}`,
        Array.from({ length: p === 4 ? 199 : 200 }, (_, i) =>
          rect(`q${p}_${i}`, 0, 0)
        )
      )
    );
    const doc = documentOf([], null, pages);
    refused(() => insert(doc), 'LAYER_LIMIT');
  });

  it('LIM3 a refused insert changes nothing (all or nothing)', () => {
    const doc = documentOf(
      Array.from({ length: 199 }, (_, i) => rect(`l${i}`, 0, 0))
    );
    const frozen = JSON.stringify(doc);
    refused(() => insert(doc), 'LAYER_LIMIT');
    expect(JSON.stringify(doc)).toBe(frozen);
  });

  it('LIM4 a built-in pattern inserts within the limits on a standard page', () => {
    for (const entry of listContentStudioSystemDesignLayoutPatterns()) {
      const doc = documentOf([]);
      const { document: next, layerIds } = insert(doc, entry.content);
      expect(layerIds).toHaveLength(entry.content.layers.length);
      valid(next);
    }
  });

  it('LIM5 an empty pattern (not valid Layout Pattern v1) is refused', () => {
    refused(
      () => insert(documentOf([]), { ...PATTERN, layers: [] }),
      'LAYER_LIMIT'
    );
  });

  const BRANDED = parseContentStudioDesignLayoutPatternContent({
    ...PATTERN,
    layers: [
      { ...PATTERN.layers[0], fill: tok('primary') },
      { ...PATTERN.layers[1], font: tok('heading') },
    ],
  });

  it('LB1 a pattern with Brand tokens inserts when the exact revision has them', () => {
    const doc = documentOf([], BRAND_REF);
    const { document: next } = insert(doc, BRANDED, BRAND);
    expect(next.pages[0].layers[0]).toMatchObject({ fill: tok('primary') });
    expect(next.pages[0].layers[1]).toMatchObject({ font: tok('heading') });
    valid(next);
  });

  it('LB2 refused for a design without a Brand Kit: nothing is attached', () => {
    refused(
      () => insert(documentOf([]), BRANDED, BRAND),
      'LAYOUT_BRAND_UNAVAILABLE'
    );
  });

  it('LB3 refused when the Brand Kit content is not loaded', () => {
    refused(
      () => insert(documentOf([], BRAND_REF), BRANDED, null),
      'LAYOUT_BRAND_UNAVAILABLE'
    );
  });

  it('LB4 refused for a missing color token', () => {
    const content = parseContentStudioDesignLayoutPatternContent({
      ...PATTERN,
      layers: [{ ...PATTERN.layers[0], fill: tok('accent') }],
    });
    refused(
      () => insert(documentOf([], BRAND_REF), content, BRAND),
      'LAYOUT_BRAND_UNAVAILABLE'
    );
  });

  it('LB5 refused for a missing typography token', () => {
    const content = parseContentStudioDesignLayoutPatternContent({
      ...PATTERN,
      layers: [{ ...PATTERN.layers[1], font: tok('body') }],
    });
    refused(
      () => insert(documentOf([], BRAND_REF), content, BRAND),
      'LAYOUT_BRAND_UNAVAILABLE'
    );
  });

  it('LB6 never converted to literals and never partly inserted', () => {
    const doc = documentOf([], BRAND_REF);
    const frozen = JSON.stringify(doc);
    const content = parseContentStudioDesignLayoutPatternContent({
      ...PATTERN,
      layers: [
        { ...PATTERN.layers[0], fill: tok('primary') },
        { ...PATTERN.layers[1], color: tok('missing') },
      ],
    });
    refused(() => insert(doc, content, BRAND), 'LAYOUT_BRAND_UNAVAILABLE');
    expect(JSON.stringify(doc)).toBe(frozen);
  });

  it('LB7 a literal-only pattern needs no Brand Kit; a Brand page background is not the pattern’s', () => {
    const doc = parseContentStudioDesignDocument({
      ...documentOf([], BRAND_REF),
      pages: [
        page('p1', [], {
          background: { type: 'solid', color: tok('primary') },
        }),
      ],
    });
    expect(() => insert(documentOf([]), PATTERN, null)).not.toThrow();
    // the page's own token is the design's business, not the pattern's
    expect(() => insert(doc, PATTERN, null)).not.toThrow();
  });
});
