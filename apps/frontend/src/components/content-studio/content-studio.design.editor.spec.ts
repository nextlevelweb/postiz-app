import { TextEncoder as NodeTextEncoder } from 'util';
import {
  ContentStudioDesignDocumentV1,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { parseContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import {
  addContentStudioDesignImageLayer,
  addContentStudioDesignLayer,
  addContentStudioDesignPage,
  applyContentStudioDesignHistory,
  areContentStudioDesignDocumentsEqual,
  cloneContentStudioDesignDocument,
  ContentStudioDesignEditorError,
  contentStudioDesignEditorLimits,
  contentStudioDesignLayerMoves,
  DESIGN_EDITOR_HISTORY_MAX,
  deleteContentStudioDesignLayer,
  deleteContentStudioDesignPage,
  duplicateContentStudioDesignLayer,
  duplicateContentStudioDesignPage,
  missingContentStudioDesignBrandTokens,
  moveContentStudioDesignLayer,
  moveContentStudioDesignPage,
  newContentStudioDesignLayerId,
  redoContentStudioDesignHistory,
  setContentStudioDesignBrandKit,
  startContentStudioDesignHistory,
  undoContentStudioDesignHistory,
  updateContentStudioDesignLayer,
  updateContentStudioDesignPage,
} from './content-studio.design.editor';

// jsdom has no TextEncoder (every browser does): the parser counts UTF-8
// bytes with it
if (typeof (globalThis as any).TextEncoder === 'undefined') {
  (globalThis as any).TextEncoder = NodeTextEncoder;
}

type Plain = Record<string, any>;
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const lit = (value: string) => ({ type: 'literal', value });
const tok = (tokenId: string) => ({ type: 'brand', tokenId });
const base = (id: string, extra: Plain) => ({
  id,
  name: '',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  opacity: 1,
  visible: true,
  ...extra,
});
const rect = (id: string, extra: Plain = {}) =>
  base(id, {
    type: 'shape',
    shape: 'rectangle',
    fill: lit('#ff0000'),
    cornerRadius: 0,
    ...extra,
  });
const text = (id: string, extra: Plain = {}) =>
  base(id, {
    type: 'text',
    text: '  Hello\n',
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
const page = (id: string, layers: unknown[], extra: Plain = {}) => ({
  id,
  name: '',
  width: 1080,
  height: 1350,
  background: { type: 'solid', color: lit('#ffffff') },
  layers,
  ...extra,
});
const REF = {
  brandKitId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  revisionId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  revisionNumber: 3,
  contentHash: SHA('c'),
};
const doc = (pages: unknown[], brandKit: unknown = null) =>
  parseContentStudioDesignDocument({ schemaVersion: 1, brandKit, pages });
const kit = (colors: string[], typography: string[], value = '#123456') =>
  parseContentStudioBrandKitContent({
    schemaVersion: 1,
    identity: { brandName: 'Acme', tagline: '', description: '' },
    colors: colors.map((id) => ({ id, name: id, value, role: 'custom' })),
    typography: typography.map((id) => ({
      id,
      name: id,
      family: 'Poppins',
      weight: 700,
      style: 'normal',
      role: 'heading',
    })),
    visualDirection: { keywords: [], dos: [], donts: [] },
  });

const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const valid = (document: ContentStudioDesignDocumentV1) => {
  expect(parseContentStudioDesignDocument(document)).toEqual(document);
  return document;
};
const ids = (document: ContentStudioDesignDocumentV1) =>
  document.pages.flatMap((p) => p.layers.map((l) => l.id));
const editorError = (run: () => unknown) => {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(ContentStudioDesignEditorError);
    return (err as ContentStudioDesignEditorError).code;
  }
  throw new Error('expected an editor error');
};

const sample = () =>
  freeze(
    doc([
      page('p_a', [rect('back'), text('middle'), rect('front')], {
        name: 'First',
      }),
      page('p_b', [rect('other')], { width: 1200, height: 628 }),
    ])
  );

describe('design editor: document', () => {
  it('ED1 a clone is an equal, independent plain copy', () => {
    const source = sample();
    const copy = cloneContentStudioDesignDocument(source);
    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
    copy.pages[0].layers[0].x = 99;
    expect(source.pages[0].layers[0].x).toBe(0);
  });

  it('ED2/ED3/ED4 equality is structural, but page and layer order count', () => {
    const source = sample();
    expect(areContentStudioDesignDocumentsEqual(source, sample())).toBe(true);
    expect(
      areContentStudioDesignDocumentsEqual(source, {
        ...source,
        pages: [...source.pages].reverse(),
      })
    ).toBe(false);
    expect(
      areContentStudioDesignDocumentsEqual(
        source,
        moveContentStudioDesignLayer(source, 'back', 'forward')
      )
    ).toBe(false);
    // key order alone is no change
    const keysReversed = {
      pages: source.pages,
      brandKit: null,
      schemaVersion: 1,
    } as ContentStudioDesignDocumentV1;
    expect(areContentStudioDesignDocumentsEqual(source, keysReversed)).toBe(
      true
    );
    expect(
      areContentStudioDesignDocumentsEqual(
        source,
        updateContentStudioDesignLayer(source, 'back', { x: 0.0001 })
      )
    ).toBe(false);
  });

  it('ED5/ED12 adds an empty white page at the end, sized like the chosen page, leaving the input alone', () => {
    const source = sample();
    const { document, pageId } = addContentStudioDesignPage(source, 'p_b');
    valid(document);
    expect(document.pages.map((p) => p.id)).toEqual(['p_a', 'p_b', pageId]);
    expect(pageId).toMatch(/^p_[0-9a-f]{20}$/);
    expect(document.pages[2]).toEqual({
      id: pageId,
      name: '',
      width: 1200,
      height: 628,
      background: {
        type: 'solid',
        color: { type: 'literal', value: '#ffffff' },
      },
      layers: [],
    });
    expect(
      addContentStudioDesignPage(source, null).document.pages[2]
    ).toMatchObject({
      width: 1080,
      height: 1080,
    });
    expect(source.pages).toHaveLength(2);
  });

  it('ED6/PE10 25 pages is the limit', () => {
    let document = doc([page('p_0', [])]);
    for (let i = 1; i < 25; i++) {
      document = addContentStudioDesignPage(document, 'p_0').document;
    }
    valid(document);
    expect(contentStudioDesignEditorLimits(document, 'p_0').canAddPage).toBe(
      false
    );
    expect(editorError(() => addContentStudioDesignPage(document, 'p_0'))).toBe(
      'PAGE_LIMIT'
    );
    expect(
      editorError(() => duplicateContentStudioDesignPage(document, 'p_0'))
    ).toBe('PAGE_LIMIT');
  });

  it('ED7/ED8/PE4/91 deletes a page, selects the one now in its place or the last, never the last page', () => {
    const three = addContentStudioDesignPage(sample(), 'p_a').document;
    const middle = deleteContentStudioDesignPage(three, 'p_b');
    valid(middle.document);
    expect(middle.document.pages.map((p) => p.id)).toEqual([
      'p_a',
      three.pages[2].id,
    ]);
    expect(middle.pageId).toBe(three.pages[2].id);
    const last = deleteContentStudioDesignPage(three, three.pages[2].id);
    expect(last.pageId).toBe('p_b');
    const one = doc([page('p_only', [])]);
    expect(contentStudioDesignEditorLimits(one, 'p_only').canDeletePage).toBe(
      false
    );
    expect(
      editorError(() => deleteContentStudioDesignPage(one, 'p_only'))
    ).toBe('LAST_PAGE');
  });

  it('ED9/M13 moves a page one step, by position, and not past the ends', () => {
    const source = freeze(
      doc([page('p_z', []), page('p_a', []), page('p_m', [])])
    );
    expect(
      moveContentStudioDesignPage(source, 'p_m', -1).pages.map((p) => p.id)
    ).toEqual(['p_z', 'p_m', 'p_a']);
    expect(
      moveContentStudioDesignPage(source, 'p_z', 1).pages.map((p) => p.id)
    ).toEqual(['p_a', 'p_z', 'p_m']);
    expect(moveContentStudioDesignPage(source, 'p_z', -1)).toBe(source);
    expect(moveContentStudioDesignPage(source, 'p_m', 1)).toBe(source);
  });

  it('ED10/ED11/M15 duplicates a page right after it, with a new page id and new layer ids for every layer', () => {
    const source = sample();
    const { document, pageId } = duplicateContentStudioDesignPage(
      source,
      'p_a'
    );
    valid(document);
    expect(document.pages.map((p) => p.id)).toEqual(['p_a', pageId, 'p_b']);
    const copy = document.pages[1];
    expect(copy.name).toBe('First');
    expect(copy.layers.map((l) => l.type)).toEqual(['shape', 'text', 'shape']);
    expect(copy.layers.map(({ id, ...rest }) => rest)).toEqual(
      source.pages[0].layers.map(({ id, ...rest }) => rest)
    );
    const all = ids(document);
    expect(new Set(all).size).toBe(all.length);
    for (const layer of copy.layers) {
      expect(layer.id).toMatch(/^l_[0-9a-f]{20}$/);
    }
  });

  it('PE6/PE8/PE9/PE7 updates the name and background only: the size stays', () => {
    const source = sample();
    const named = updateContentStudioDesignPage(source, 'p_a', {
      name: '  Cover ',
      background: tok('paper') as never,
      ...({ width: 64 } as object),
    });
    expect(named.pages[0]).toMatchObject({
      name: '  Cover ',
      width: 1080,
      height: 1350,
      background: { type: 'solid', color: { type: 'brand', tokenId: 'paper' } },
    });
    expect(source.pages[0].name).toBe('First');
  });
});

describe('design editor: layers', () => {
  it('EL1/EL5/LE4 adds a valid text layer in front, with the agreed defaults and a new id', () => {
    const source = sample();
    const { document, layerId } = addContentStudioDesignLayer(
      source,
      'p_a',
      'text'
    );
    valid(document);
    const layer = document.pages[0].layers[3];
    expect(layer).toEqual({
      id: layerId,
      name: '',
      x: 108,
      y: 135,
      width: 864,
      height: 200,
      rotation: 0,
      opacity: 1,
      visible: true,
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
    });
    expect(layerId).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
    // a short page: a quarter of its height
    const wide = addContentStudioDesignLayer(source, 'p_b', 'text');
    expect(wide.document.pages[1].layers[1].height).toBe(157);
  });

  it('EL2/EL3/M17 adds rectangles and ellipses; an ellipse has corner radius 0', () => {
    const source = sample();
    const rectangle = addContentStudioDesignLayer(source, 'p_a', 'rectangle');
    const ellipse = addContentStudioDesignLayer(
      rectangle.document,
      'p_a',
      'ellipse'
    );
    valid(ellipse.document);
    const [r, e] = ellipse.document.pages[0].layers.slice(3);
    expect(r).toMatchObject({
      shape: 'rectangle',
      x: 108,
      y: 135,
      width: 432,
      height: 337.5,
      fill: { type: 'literal', value: '#d9d9d9' },
      cornerRadius: 0,
    });
    expect(e).toMatchObject({ shape: 'ellipse', cornerRadius: 0 });
    // a corner radius never reaches an ellipse
    const edited = updateContentStudioDesignLayer(ellipse.document, e.id, {
      cornerRadius: 30,
    });
    valid(edited);
    expect(edited.pages[0].layers[4]).toMatchObject({ cornerRadius: 0 });
  });

  it('EL4 adds an image with exactly the server reference, cover and a centered focal point', () => {
    const { document, layerId } = addContentStudioDesignImageLayer(
      sample(),
      'p_a',
      {
        mediaId: 'media-1',
        sha256: SHA('a'),
        ...({ path: 'https://cdn.test/x.png' } as object),
      } as never
    );
    valid(document);
    expect(document.pages[0].layers[3]).toEqual({
      id: layerId,
      name: '',
      x: 108,
      y: 135,
      width: 864,
      height: 810,
      rotation: 0,
      opacity: 1,
      visible: true,
      type: 'image',
      imageRef: { type: 'media', mediaId: 'media-1', sha256: SHA('a') },
      fit: 'cover',
      focalPoint: { x: 0.5, y: 0.5 },
    });
    expect(JSON.stringify(document)).not.toMatch(/https?:|cdn\.test|path/);
  });

  it('EL5/68 a new id never repeats one in the document, and gives up after ten collisions', () => {
    const original = crypto.getRandomValues;
    const fixed = new Uint8Array(10).fill(171);
    (crypto as any).getRandomValues = (array: Uint8Array) => {
      array.set(fixed);
      return array;
    };
    try {
      const id = newContentStudioDesignLayerId();
      expect(id).toBe(`l_${'ab'.repeat(10)}`);
      const taken = doc([page('p_a', [rect(id)])]);
      expect(
        editorError(() => addContentStudioDesignLayer(taken, 'p_a', 'text'))
      ).toBe('ID_EXHAUSTED');
    } finally {
      (crypto as any).getRandomValues = original;
    }
  });

  it('EL6/EL7 200 layers per page and 1000 per design are the limits', () => {
    const full = doc([
      page(
        'p_a',
        Array.from({ length: 200 }, (_, i) => rect(`r${i}`))
      ),
    ]);
    expect(contentStudioDesignEditorLimits(full, 'p_a').canAddLayer).toBe(
      false
    );
    expect(
      editorError(() => addContentStudioDesignLayer(full, 'p_a', 'text'))
    ).toBe('LAYER_LIMIT');
    expect(
      editorError(() => duplicateContentStudioDesignLayer(full, 'r0'))
    ).toBe('LAYER_LIMIT');
    const pages = Array.from({ length: 5 }, (_, p) =>
      page(
        `p_${p}`,
        Array.from({ length: p === 4 ? 199 : 200 }, (_, i) =>
          rect(`r${p}_${i}`)
        )
      )
    );
    const almost = doc(pages);
    expect(contentStudioDesignEditorLimits(almost, 'p_4').canAddLayer).toBe(
      true
    );
    const last = addContentStudioDesignLayer(
      almost,
      'p_4',
      'rectangle'
    ).document;
    valid(last);
    const total = doc([...last.pages, page('p_extra', [])]);
    expect(contentStudioDesignEditorLimits(total, 'p_extra').canAddLayer).toBe(
      false
    );
    expect(contentStudioDesignEditorLimits(total, 'p_0').canDuplicatePage).toBe(
      false
    );
  });

  it('EL8 deletes a layer, leaving the others in order', () => {
    const document = deleteContentStudioDesignLayer(sample(), 'middle');
    valid(document);
    expect(document.pages[0].layers.map((l) => l.id)).toEqual([
      'back',
      'front',
    ]);
  });

  it('EL9/EL10/EL11/EL12/M18 updates only the fields of the layer type, keeping text exactly', () => {
    const source = sample();
    const geometry = updateContentStudioDesignLayer(source, 'back', {
      x: -10.5,
      y: 20,
      width: 300,
      height: 0.5,
      rotation: -45,
      opacity: 0.25,
      visible: false,
      name: ' Back ',
      text: 'not for shapes',
      ...({ id: 'hijack', type: 'text' } as object),
    });
    // the name is kept as typed; the parser trims it when the draft is saved
    expect(
      parseContentStudioDesignDocument(geometry).pages[0].layers[0].name
    ).toBe('Back');
    expect(geometry.pages[0].layers[0]).toEqual({
      ...source.pages[0].layers[0],
      x: -10.5,
      y: 20,
      width: 300,
      height: 0.5,
      rotation: -45,
      opacity: 0.25,
      visible: false,
      name: ' Back ',
    });
    const textEdit = updateContentStudioDesignLayer(source, 'middle', {
      text: '  two\n  lines  ',
      fontSize: 72,
      lineHeight: 1.5,
      letterSpacing: -2,
      align: 'center',
      verticalAlign: 'bottom',
      overflow: 'shrink',
      color: tok('ink') as never,
      font: tok('heading') as never,
    });
    expect(textEdit.pages[0].layers[1]).toMatchObject({
      text: '  two\n  lines  ',
      fontSize: 72,
      overflow: 'shrink',
      color: { type: 'brand', tokenId: 'ink' },
      font: { type: 'brand', tokenId: 'heading' },
    });
    const shape = updateContentStudioDesignLayer(source, 'front', {
      fill: lit('#00ff00') as never,
      cornerRadius: 12,
    });
    valid(shape);
    expect(shape.pages[0].layers[2]).toMatchObject({
      fill: { type: 'literal', value: '#00ff00' },
      cornerRadius: 12,
    });
    const image = addContentStudioDesignImageLayer(source, 'p_b', {
      mediaId: 'm',
      sha256: SHA('a'),
    });
    const fitted = updateContentStudioDesignLayer(
      image.document,
      image.layerId,
      {
        fit: 'contain',
        focalPoint: { x: 0, y: 1 },
      }
    );
    valid(fitted);
    expect(fitted.pages[1].layers[1]).toMatchObject({
      fit: 'contain',
      focalPoint: { x: 0, y: 1 },
    });
  });

  it('EL13/EL14/EL15/EL16/M16 moves a layer in the array: forward and front toward the end', () => {
    const source = sample();
    const order = (document: ContentStudioDesignDocumentV1) =>
      document.pages[0].layers.map((l) => l.id);
    expect(
      order(moveContentStudioDesignLayer(source, 'back', 'forward'))
    ).toEqual(['middle', 'back', 'front']);
    expect(
      order(moveContentStudioDesignLayer(source, 'front', 'backward'))
    ).toEqual(['back', 'front', 'middle']);
    expect(
      order(moveContentStudioDesignLayer(source, 'back', 'front'))
    ).toEqual(['middle', 'front', 'back']);
    expect(
      order(moveContentStudioDesignLayer(source, 'front', 'back'))
    ).toEqual(['front', 'back', 'middle']);
    expect(
      order(moveContentStudioDesignLayer(source, 'front', 'forward'))
    ).toEqual(['back', 'middle', 'front']);
    expect(contentStudioDesignLayerMoves(source, 'front')).toEqual({
      forward: false,
      front: false,
      backward: true,
      back: true,
    });
    expect(contentStudioDesignLayerMoves(source, 'back')).toEqual({
      forward: true,
      front: true,
      backward: false,
      back: false,
    });
  });

  it('EL17/EL18 duplicates a layer right in front of the original under a new id, 20 units off where it fits', () => {
    const source = sample();
    const { document, layerId } = duplicateContentStudioDesignLayer(
      source,
      'middle'
    );
    valid(document);
    expect(document.pages[0].layers.map((l) => l.id)).toEqual([
      'back',
      'middle',
      layerId,
      'front',
    ]);
    const { id, x, y, ...rest } = document.pages[0].layers[2];
    const { id: _id, x: _x, y: _y, ...original } = source.pages[0].layers[1];
    expect(rest).toEqual(original);
    expect([x, y]).toEqual([20, 20]);
    const edge = doc([page('p_a', [rect('edge', { x: 32_760, y: -5 })])]);
    const copy = duplicateContentStudioDesignLayer(edge, 'edge');
    expect(copy.document.pages[0].layers[1]).toMatchObject({
      x: 32_760,
      y: 15,
    });
  });

  it('EL19/ED12/M1 no operation changes its (deep-frozen) input', () => {
    const source = sample();
    const before = JSON.stringify(source);
    addContentStudioDesignPage(source, 'p_a');
    duplicateContentStudioDesignPage(source, 'p_a');
    deleteContentStudioDesignPage(source, 'p_a');
    moveContentStudioDesignPage(source, 'p_b', -1);
    updateContentStudioDesignPage(source, 'p_a', {
      name: 'x',
      background: lit('#000000') as never,
    });
    addContentStudioDesignLayer(source, 'p_a', 'text');
    addContentStudioDesignImageLayer(source, 'p_a', {
      mediaId: 'm',
      sha256: SHA('a'),
    });
    updateContentStudioDesignLayer(source, 'middle', { text: 'x', x: 3 });
    deleteContentStudioDesignLayer(source, 'middle');
    duplicateContentStudioDesignLayer(source, 'middle');
    for (const move of ['forward', 'backward', 'front', 'back'] as const) {
      moveContentStudioDesignLayer(source, 'middle', move);
    }
    expect(JSON.stringify(source)).toBe(before);
  });
});

describe('design editor: Brand Kit', () => {
  const branded = () =>
    freeze(
      doc(
        [
          page('p_a', [
            rect('fill', { fill: tok('accent') }),
            text('t', { font: tok('heading'), color: tok('ink') }),
          ]),
        ],
        REF
      )
    );

  it('EB1 removes the Brand Kit when no token is used', () => {
    const plain = freeze(doc([page('p_a', [rect('r')])], REF));
    const document = setContentStudioDesignBrandKit(plain, null);
    valid(document);
    expect(document.brandKit).toBeNull();
  });

  it('EB2/EB3/M29 never removes it while a color or a type style is still used', () => {
    expect(
      editorError(() => setContentStudioDesignBrandKit(branded(), null))
    ).toBe('BRAND_TOKENS_IN_USE');
    const colorOnly = doc(
      [page('p_a', [], { background: { type: 'solid', color: tok('paper') } })],
      REF
    );
    expect(
      editorError(() => setContentStudioDesignBrandKit(colorOnly, null))
    ).toBe('BRAND_TOKENS_IN_USE');
    const fontOnly = doc(
      [page('p_a', [text('t', { font: tok('heading') })])],
      REF
    );
    expect(
      editorError(() => setContentStudioDesignBrandKit(fontOnly, null))
    ).toBe('BRAND_TOKENS_IN_USE');
  });

  it('EB4/EB7/EB8 pins exactly the given revision, keeping tokens by id even when their values change', () => {
    const next = {
      brandKitId: REF.brandKitId,
      revisionId: '3d6f0a8e-2b4c-4e1a-9f7d-5c8b2a6e4d10',
      revisionNumber: 7,
      contentHash: SHA('d'),
    };
    const document = setContentStudioDesignBrandKit(branded(), {
      ref: {
        ...next,
        ...({ content: 'x', createdBy: 'u' } as object),
      } as never,
      content: kit(['accent', 'ink'], ['heading'], '#abcdef'),
    });
    valid(document);
    expect(document.brandKit).toEqual(next);
    expect(Object.keys(document.brandKit as object)).toEqual([
      'brandKitId',
      'revisionId',
      'revisionNumber',
      'contentHash',
    ]);
    expect(document.pages).toEqual(branded().pages);
  });

  it('EB5/EB6/M30 refuses a revision missing a color or a type style the design uses', () => {
    for (const content of [
      kit(['ink'], ['heading']),
      kit(['accent', 'ink'], []),
    ]) {
      expect(
        editorError(() =>
          setContentStudioDesignBrandKit(branded(), { ref: REF, content })
        )
      ).toBe('BRAND_TOKENS_MISSING');
    }
    expect(
      missingContentStudioDesignBrandTokens(branded(), kit(['ink'], []))
    ).toEqual({ colors: ['accent'], typography: ['heading'] });
    expect(
      missingContentStudioDesignBrandTokens(
        branded(),
        kit(['accent', 'ink'], ['heading'])
      )
    ).toEqual({ colors: [], typography: [] });
  });
});

describe('design editor: undo and redo', () => {
  const start = () => startContentStudioDesignHistory(sample());
  const moved = (n: number) =>
    updateContentStudioDesignLayer(sample(), 'back', { x: n });

  it('UR1/UR2/UR3 an edit is one step back; undo and redo walk the steps', () => {
    let history = start();
    history = applyContentStudioDesignHistory(history, moved(1));
    history = applyContentStudioDesignHistory(history, moved(2));
    expect(history.past).toHaveLength(2);
    history = undoContentStudioDesignHistory(history);
    expect(history.present.pages[0].layers[0].x).toBe(1);
    expect(history.future).toHaveLength(1);
    history = redoContentStudioDesignHistory(history);
    expect(history.present.pages[0].layers[0].x).toBe(2);
    expect(history.future).toEqual([]);
    // nothing to undo or redo leaves the history as it is
    const fresh = start();
    expect(undoContentStudioDesignHistory(fresh)).toBe(fresh);
    expect(redoContentStudioDesignHistory(fresh)).toBe(fresh);
  });

  it('UR4/M3 a new edit after undo drops what could be redone', () => {
    let history = applyContentStudioDesignHistory(start(), moved(1));
    history = undoContentStudioDesignHistory(history);
    history = applyContentStudioDesignHistory(history, moved(5));
    expect(history.future).toEqual([]);
    expect(redoContentStudioDesignHistory(history)).toBe(history);
  });

  it('UR5/M4 keeps at most 50 steps, dropping the oldest', () => {
    let history = start();
    for (let i = 1; i <= 60; i++) {
      history = applyContentStudioDesignHistory(history, moved(i));
    }
    expect(DESIGN_EDITOR_HISTORY_MAX).toBe(50);
    expect(history.past).toHaveLength(50);
    expect(history.past[0].pages[0].layers[0].x).toBe(10);
    for (let i = 0; i < 60; i++) {
      history = undoContentStudioDesignHistory(history);
    }
    expect(history.present.pages[0].layers[0].x).toBe(10);
  });

  it('UR6/M2 undoing back to the base gives a document equal to the base; a no-op edit is no step', () => {
    const baseDocument = sample();
    let history = startContentStudioDesignHistory(baseDocument);
    history = applyContentStudioDesignHistory(history, moved(3));
    expect(
      areContentStudioDesignDocumentsEqual(history.present, baseDocument)
    ).toBe(false);
    history = undoContentStudioDesignHistory(history);
    expect(
      areContentStudioDesignDocumentsEqual(history.present, baseDocument)
    ).toBe(true);
    const same = applyContentStudioDesignHistory(history, sample());
    expect(same).toBe(history);
  });

  it('UR7 snapshots are independent copies', () => {
    const next = cloneContentStudioDesignDocument(moved(4));
    let history = applyContentStudioDesignHistory(start(), next);
    next.pages[0].layers[0].x = 999;
    expect(history.present.pages[0].layers[0].x).toBe(4);
    history = undoContentStudioDesignHistory(history);
    expect(history.present.pages[0].layers[0].x).toBe(0);
  });
});
