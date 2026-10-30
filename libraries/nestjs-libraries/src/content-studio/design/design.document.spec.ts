import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import { createHash } from 'crypto';
import {
  canonicalJsonWithFiniteNumbers,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  collectContentStudioDesignBrandTokenRefs,
  ContentStudioDesignDocumentError,
  DESIGN_DOCUMENT_MAX_BYTES,
  emptyContentStudioDesignDocument,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioDesignIntegrityError,
  parseVerifiedContentStudioDesignRevision,
  storedContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document.revision';

const MARKER = 'DESIGN_DOCUMENT_PRIVATE_MARKER_123';
const BRAND_KIT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const BRAND_REVISION = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(64);

type Obj = Record<string, unknown>;
const literal = (value = '#0057ff') => ({ type: 'literal', value });
const brand = (tokenId = 'primary') => ({ type: 'brand', tokenId });
const geometry = (overrides: Obj = {}) => ({
  name: '',
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  rotation: 0,
  opacity: 1,
  visible: true,
  ...overrides,
});
const text = (overrides: Obj = {}) => ({
  id: 'title',
  type: 'text',
  ...geometry(),
  text: `Spring sale ${MARKER}`,
  font: { type: 'family', family: 'Inter', weight: 700, style: 'normal' },
  fontSize: 64,
  lineHeight: 1.2,
  letterSpacing: 0,
  color: literal('#111111'),
  align: 'left',
  verticalAlign: 'top',
  overflow: 'shrink',
  ...overrides,
});
const shape = (overrides: Obj = {}) => ({
  id: 'panel',
  type: 'shape',
  ...geometry(),
  shape: 'rectangle',
  fill: literal(),
  cornerRadius: 12,
  ...overrides,
});
const image = (overrides: Obj = {}) => ({
  id: 'photo',
  type: 'image',
  ...geometry({ x: -40, width: 1200, height: 800 }),
  imageRef: { type: 'media', mediaId: 'media-1', sha256: SHA },
  fit: 'cover',
  focalPoint: { x: 0.5, y: 0.25 },
  ...overrides,
});
const page = (overrides: Obj = {}) => ({
  id: 'cover',
  name: 'Cover',
  width: 1080,
  height: 1350,
  background: { type: 'solid', color: literal('#FFFFFF') },
  layers: [image(), shape(), text()],
  ...overrides,
});
const brandKitRef = (overrides: Obj = {}) => ({
  brandKitId: BRAND_KIT,
  revisionId: BRAND_REVISION,
  revisionNumber: 3,
  contentHash: 'c'.repeat(64),
  ...overrides,
});
const doc = (overrides: Obj = {}) => ({
  schemaVersion: 1,
  brandKit: null,
  pages: [page()],
  ...overrides,
});
const withLayers = (layers: unknown[], pageOverrides: Obj = {}) =>
  doc({ pages: [page({ layers, ...pageOverrides })] });
const firstLayer = (input: unknown) =>
  parse(input).pages[0].layers[0] as unknown as Obj;

const parse = parseContentStudioDesignDocument;
const refused = (input: unknown) => {
  let error: unknown;
  try {
    parse(input);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ContentStudioDesignDocumentError);
  expect(inspect(error, { depth: 8 })).not.toContain(MARKER);
  return error as ContentStudioDesignDocumentError;
};
const invalid = (input: unknown) => expect(refused(input).code).toBe('INVALID');
const bytes = (value: unknown) =>
  Buffer.byteLength(canonicalJsonWithFiniteNumbers(value), 'utf8');

// ============================================================================
describe('Design Document v1: document', () => {
  it('DD1 the minimal document is valid; the helper gives one', () => {
    const minimal = {
      schemaVersion: 1,
      brandKit: null,
      pages: [page({ layers: [] })],
    };
    expect(parse(minimal).pages[0].layers).toEqual([]);
    expect(emptyContentStudioDesignDocument()).toEqual({
      schemaVersion: 1,
      brandKit: null,
      pages: [
        {
          id: 'page-1',
          name: '',
          width: 1080,
          height: 1080,
          background: {
            type: 'solid',
            color: { type: 'literal', value: '#ffffff' },
          },
          layers: [],
        },
      ],
    });
  });

  it('DD2 a representative document is valid and returned as a new object', () => {
    const input = doc({
      brandKit: brandKitRef(),
      pages: [
        page(),
        page({
          id: 'slide-2',
          background: { type: 'solid', color: brand('paper') },
          layers: [
            text({ id: 'quote', font: brand('body'), color: brand('ink') }),
            shape({
              id: 'dot',
              shape: 'ellipse',
              cornerRadius: 0,
              fill: brand(),
            }),
          ],
        }),
      ],
    });
    const parsed = parse(input);
    expect(parsed).not.toBe(input);
    expect(parsed.pages[0].background.color).toEqual(literal('#ffffff'));
    expect(parsed.pages[1].layers.map((l) => l.id)).toEqual(['quote', 'dot']);
    // the input is not changed
    expect((input.pages as Obj[])[0]).toMatchObject({
      background: { color: { value: '#FFFFFF' } },
    });
  });

  it('DD3 has exactly these keys at the top, on a page and on the Brand Kit reference', () => {
    const parsed = parse(doc({ brandKit: brandKitRef() }));
    expect(Object.keys(parsed).sort()).toEqual([
      'brandKit',
      'pages',
      'schemaVersion',
    ]);
    expect(Object.keys(parsed.pages[0]).sort()).toEqual([
      'background',
      'height',
      'id',
      'layers',
      'name',
      'width',
    ]);
    expect(Object.keys(parsed.brandKit as unknown as Obj).sort()).toEqual([
      'brandKitId',
      'contentHash',
      'revisionId',
      'revisionNumber',
    ]);
  });

  it.each([
    'documentId',
    'revisionId',
    'createdAt',
    'canvas',
    'objects',
    'fabric',
    'html',
    'css',
    'svg',
    'templateId',
    'brandKitLatest',
    'useCurrentBrandKit',
    'colors',
    'typography',
  ])('DD4/77-79/130 refuses a top-level %s field', (key) => {
    invalid(doc({ [key]: MARKER }));
  });

  it('DD5/81 accepts plain data only, at every level', () => {
    class Doc {
      schemaVersion = 1;
    }
    invalid(new Doc());
    invalid(Object.assign(Object.create({ x: 1 }), doc()));
    invalid(doc({ pages: [new Map()] }));
    invalid(withLayers([new Date()]));
    invalid(withLayers([Object.assign(Object.create({ y: 1 }), text())]));
    invalid(doc({ pages: new Set([page()]) }));
    invalid(withLayers([text({ font: () => ({}) })]));
    invalid(null);
    invalid([]);
    invalid(MARKER);
    expect(parse(Object.assign(Object.create(null), doc())).pages).toHaveLength(
      1
    );
  });

  it('DD6/DD7 needs schema version 1', () => {
    const input: Obj = doc();
    delete input.schemaVersion;
    invalid(input);
    invalid(doc({ schemaVersion: 2 }));
    invalid(doc({ schemaVersion: '1' }));
  });

  it('DD8 brandKit may be null but must be present', () => {
    expect(parse(doc({ brandKit: null })).brandKit).toBeNull();
    const input: Obj = doc();
    delete input.brandKit;
    invalid(input);
  });

  it('DD9 a Brand Kit reference names one exact revision', () => {
    expect(parse(doc({ brandKit: brandKitRef() })).brandKit).toEqual(
      brandKitRef()
    );
    for (const bad of [
      { brandKitId: BRAND_KIT.toUpperCase() },
      { brandKitId: 'kit-1' },
      { revisionId: '' },
      { revisionNumber: 0 },
      { revisionNumber: 2 ** 31 },
      { revisionNumber: 1.5 },
      { revisionNumber: '3' },
      { contentHash: 'C'.repeat(64) },
      { contentHash: 'c'.repeat(63) },
    ]) {
      invalid(doc({ brandKit: brandKitRef(bad) }));
    }
    invalid(doc({ brandKit: 'current' }));
  });

  it.each(['latest', 'colors', 'typography', 'brandName', 'name'])(
    'DD10/129 refuses a Brand Kit reference with %s',
    (key) => invalid(doc({ brandKit: { ...brandKitRef(), [key]: MARKER } }))
  );
});

// ============================================================================
describe('Design Document v1: pages', () => {
  const pages = (count: number) =>
    Array.from({ length: count }, (_, i) => page({ id: `p${i}`, layers: [] }));

  it('DP1/DP2/DP3/DP4 takes one to twenty-five pages', () => {
    expect(parse(doc({ pages: pages(1) })).pages).toHaveLength(1);
    invalid(doc({ pages: [] }));
    expect(parse(doc({ pages: pages(25) })).pages).toHaveLength(25);
    invalid(doc({ pages: pages(26) }));
  });

  it('DP5 takes page ids of 1-32 characters starting with a letter, case kept', () => {
    for (const id of [
      'cover',
      'slide-2',
      'PageA',
      'a',
      'x'.padEnd(32, '9'),
      'a_b',
    ]) {
      expect(parse(doc({ pages: [page({ id })] })).pages[0].id).toBe(id);
    }
    for (const id of [
      '',
      '2nd',
      '-a',
      '_a',
      'a b',
      'a.b',
      'a/b',
      'päge',
      'x'.padEnd(33, '9'),
    ]) {
      invalid(doc({ pages: [page({ id })] }));
    }
  });

  it('DP6/97 refuses a page id used twice, case-sensitively', () => {
    invalid(
      doc({
        pages: [page({ id: 'a', layers: [] }), page({ id: 'a', layers: [] })],
      })
    );
    expect(
      parse(
        doc({
          pages: [
            page({ id: 'page', layers: [] }),
            page({ id: 'Page', layers: [] }),
          ],
        })
      ).pages.map((p) => p.id)
    ).toEqual(['page', 'Page']);
  });

  it('DP7 normalizes and trims a page name, up to 100 characters, empty allowed', () => {
    expect(
      parse(doc({ pages: [page({ name: '  One\r\nTwo  ' })] })).pages[0].name
    ).toBe('One\nTwo');
    expect(parse(doc({ pages: [page({ name: '' })] })).pages[0].name).toBe('');
    expect(
      parse(doc({ pages: [page({ name: 'n'.repeat(100) })] })).pages[0].name
    ).toHaveLength(100);
    invalid(doc({ pages: [page({ name: 'n'.repeat(101) })] }));
    invalid(doc({ pages: [page({ name: `\u0000${MARKER}` })] }));
  });

  it('DP8-DP12 takes integer dimensions from 64 to 8192', () => {
    for (const [width, height] of [
      [64, 64],
      [8192, 64],
      [64, 8192],
      [1200, 627],
    ]) {
      expect(
        parse(doc({ pages: [page({ width, height })] })).pages[0]
      ).toMatchObject({ width, height });
    }
    for (const [width, height] of [
      [63, 100],
      [100, 63],
      [8193, 100],
      [100, 8193],
      [0, 100],
      [-1080, 1080],
      [1080.5, 1080],
      ['1080', 1080],
      [NaN, 1080],
      [Infinity, 1080],
    ]) {
      invalid(doc({ pages: [page({ width, height })] }));
    }
  });

  it('DP13/DP14/DP15 keeps a page at or below 32 Mi pixels', () => {
    expect(
      parse(doc({ pages: [page({ width: 8192, height: 4096 })] })).pages[0]
        .width
    ).toBe(8192);
    expect(
      parse(doc({ pages: [page({ width: 4096, height: 8192 })] })).pages[0]
        .height
    ).toBe(8192);
    const error = refused(
      doc({ pages: [page({ width: 8192, height: 4097 })] })
    );
    expect(error.issues).toEqual([{ path: ['pages', 0], code: 'custom' }]);
    invalid(doc({ pages: [page({ width: 8192, height: 8192 })] }));
  });

  it('DP16 keeps the page order', () => {
    expect(
      parse(
        doc({
          pages: [page({ id: 'b', layers: [] }), page({ id: 'a', layers: [] })],
        })
      ).pages.map((p) => p.id)
    ).toEqual(['b', 'a']);
  });
});

// ============================================================================
describe('Design Document v1: background and colors', () => {
  const background = (value: unknown) =>
    doc({ pages: [page({ background: value })] });

  it('DC1/DC2 takes a solid literal color, stored lowercase', () => {
    expect(
      parse(background({ type: 'solid', color: literal('#AABBCC') })).pages[0]
        .background
    ).toEqual({ type: 'solid', color: { type: 'literal', value: '#aabbcc' } });
  });

  it.each([
    '#fff',
    '#0057ffcc',
    'rgb(0,0,0)',
    'blue',
    '0057ff',
    'var(--x)',
    ' #0057ff',
  ])('DC3 refuses the literal %s', (value) =>
    invalid(background({ type: 'solid', color: literal(value) }))
  );

  it('DC4/DC5 takes a Brand Kit color token by id', () => {
    expect(
      parse(background({ type: 'solid', color: brand('brand-blue') })).pages[0]
        .background.color
    ).toEqual(brand('brand-blue'));
    for (const tokenId of ['Primary', '1a', '', 'a.b', 'x'.padEnd(33, '0')]) {
      invalid(background({ type: 'solid', color: brand(tokenId) }));
    }
    invalid(
      background({
        type: 'solid',
        color: { type: 'brand', tokenId: 'primary', value: '#000000' },
      })
    );
    invalid(
      background({
        type: 'solid',
        color: { type: 'current', tokenId: 'primary' },
      })
    );
  });

  it('DC6/DC7/DC8 is a solid color only', () => {
    invalid(background({ type: 'solid', color: literal(), opacity: 0.5 }));
    invalid(
      background({ type: 'gradient', stops: [literal(), literal('#000000')] })
    );
    invalid(
      background({
        type: 'image',
        imageRef: { type: 'media', mediaId: 'm', sha256: SHA },
      })
    );
    invalid(background({ type: 'transparent' }));
    invalid(background(literal()));
  });
});

// ============================================================================
describe('Design Document v1: common layer fields', () => {
  const shapes = (count: number, prefix = 's') =>
    Array.from({ length: count }, (_, i) => shape({ id: `${prefix}${i}` }));

  it('DL1/DL2/DL3 takes up to 200 layers on a page', () => {
    expect(parse(withLayers([])).pages[0].layers).toEqual([]);
    expect(parse(withLayers(shapes(200))).pages[0].layers).toHaveLength(200);
    invalid(withLayers(shapes(201)));
  });

  it('DL4/DL5 takes up to 1000 layers in a document', () => {
    const pagesOf = (count: number) =>
      Array.from({ length: 5 }, (_, p) =>
        page({
          id: `p${p}`,
          layers: shapes(p < 4 ? 200 : count - 800, `p${p}s`),
        })
      );
    expect(parse(doc({ pages: pagesOf(1000) })).pages).toHaveLength(5);
    const error = refused(
      doc({
        pages: [
          ...pagesOf(1000),
          page({ id: 'extra', layers: [shape({ id: 'one-more' })] }),
        ],
      })
    );
    expect(error.issues).toEqual([{ path: ['pages'], code: 'custom' }]);
  });

  it('DL6 takes layer ids of 1-64 characters starting with a letter, case kept', () => {
    for (const id of ['hero', 'Hero_2', 'h', 'x'.padEnd(64, '9')]) {
      expect(firstLayer(withLayers([shape({ id })])).id).toBe(id);
    }
    for (const id of [
      '',
      '1hero',
      '_hero',
      'he ro',
      'he.ro',
      'x'.padEnd(65, '9'),
      null,
    ]) {
      invalid(withLayers([shape({ id })]));
    }
  });

  it('DL7/DL8/98 refuses a layer id used twice, on one page or across pages', () => {
    invalid(withLayers([shape({ id: 'hero' }), text({ id: 'hero' })]));
    const error = refused(
      doc({
        pages: [
          page({ id: 'a', layers: [shape({ id: 'hero' })] }),
          page({ id: 'b', layers: [shape({ id: 'hero' })] }),
        ],
      })
    );
    expect(error.issues).toEqual([
      { path: ['pages', 1, 'layers', 0, 'id'], code: 'custom' },
    ]);
    // pages and layers are separate namespaces, ids keep case
    expect(
      parse(
        doc({
          pages: [
            page({
              id: 'hero',
              layers: [shape({ id: 'hero' }), shape({ id: 'Hero' })],
            }),
          ],
        })
      ).pages[0].layers.map((l) => l.id)
    ).toEqual(['hero', 'Hero']);
  });

  it('DL9/DL10/23 takes coordinates within -32768..32768, off the page included', () => {
    for (const [x, y] of [
      [-32768, 32768],
      [32768, -32768],
      [-40.25, 1200.5],
      [5000, 5000],
    ]) {
      expect(firstLayer(withLayers([shape({ x, y })]))).toMatchObject({ x, y });
    }
    for (const [x, y] of [
      [-32768.5, 0],
      [0, 32769],
    ]) {
      invalid(withLayers([shape({ x, y })]));
    }
  });

  it('DL11 takes a width and height above 0, up to 32768', () => {
    expect(
      firstLayer(withLayers([shape({ width: 0.5, height: 32768 })]))
    ).toMatchObject({
      width: 0.5,
      height: 32768,
    });
    for (const [width, height] of [
      [0, 10],
      [10, 0],
      [-1, 10],
      [10, 32768.01],
    ]) {
      invalid(withLayers([shape({ width, height })]));
    }
  });

  it.each(['x', 'y', 'width', 'height', 'rotation', 'opacity'])(
    'DL12/83 refuses a non-finite or text %s',
    (field) => {
      for (const value of [
        NaN,
        Infinity,
        -Infinity,
        '1',
        null,
        undefined,
        true,
      ]) {
        invalid(withLayers([shape({ [field]: value })]));
      }
    }
  );

  it('DL13/DL14/85 takes a rotation within -360..360, kept as given', () => {
    for (const rotation of [-360, 360, 12.5, 0]) {
      expect(firstLayer(withLayers([shape({ rotation })])).rotation).toBe(
        rotation
      );
    }
    invalid(withLayers([shape({ rotation: 360.01 })]));
    invalid(withLayers([shape({ rotation: -720 })]));
  });

  it('DL15/DL16/84 takes an opacity within 0..1', () => {
    for (const opacity of [0, 0.5, 1]) {
      expect(firstLayer(withLayers([shape({ opacity })])).opacity).toBe(
        opacity
      );
    }
    for (const opacity of [-0.01, 1.01, 50, '50%']) {
      invalid(withLayers([shape({ opacity })]));
    }
  });

  it('DL17/24 takes visible as a boolean, and keeps hidden layers', () => {
    expect(
      firstLayer(withLayers([shape({ visible: false, opacity: 0 })]))
    ).toMatchObject({
      visible: false,
      opacity: 0,
    });
    for (const visible of [0, 1, 'true', null]) {
      invalid(withLayers([shape({ visible })]));
    }
  });

  it('DL18/19 keeps the layer order: first is at the back', () => {
    expect(
      parse(
        withLayers([text({ id: 'front' }), shape({ id: 'back' })])
      ).pages[0].layers.map((l) => l.id)
    ).toEqual(['front', 'back']);
    invalid(withLayers([shape({ zIndex: 3 })]));
  });

  it('trims and bounds layer names', () => {
    expect(firstLayer(withLayers([shape({ name: ' Panel\r\n ' })])).name).toBe(
      'Panel'
    );
    invalid(withLayers([shape({ name: 'n'.repeat(101) })]));
  });

  it.each([
    ['group'],
    ['video'],
    ['icon'],
    ['vector'],
    ['svg'],
    ['chart'],
    [''],
  ])('25 refuses the layer type %j', (type) =>
    invalid(withLayers([{ ...shape(), type }]))
  );
});

// ============================================================================
describe('Design Document v1: text layers', () => {
  it('DT1 a text layer with a family and a literal color', () => {
    const layer = firstLayer(withLayers([text()]));
    expect(Object.keys(layer).sort()).toEqual([
      'align',
      'color',
      'font',
      'fontSize',
      'height',
      'id',
      'letterSpacing',
      'lineHeight',
      'name',
      'opacity',
      'overflow',
      'rotation',
      'text',
      'type',
      'verticalAlign',
      'visible',
      'width',
      'x',
      'y',
    ]);
    expect(layer.font).toEqual({
      type: 'family',
      family: 'Inter',
      weight: 700,
      style: 'normal',
    });
  });

  it('DT2 Brand Kit font and color tokens parse on their own', () => {
    expect(
      firstLayer(
        withLayers([text({ font: brand('heading'), color: brand('ink') })])
      )
    ).toMatchObject({
      font: { type: 'brand', tokenId: 'heading' },
      color: { type: 'brand', tokenId: 'ink' },
    });
    invalid(
      withLayers([
        text({ font: { type: 'brand', tokenId: 'heading', family: 'Inter' } }),
      ])
    );
  });

  it('DT3/DT4/DT5/27 normalizes line endings only: outer spaces and newlines stay, empty is fine', () => {
    expect(
      firstLayer(withLayers([text({ text: '  Line one\r\nLine two\r  ' })]))
        .text
    ).toBe('  Line one\nLine two\n  ');
    expect(firstLayer(withLayers([text({ text: '' })])).text).toBe('');
    expect(
      firstLayer(
        withLayers([text({ text: '<b>not html</b> **nor markdown**' })])
      ).text
    ).toBe('<b>not html</b> **nor markdown**');
  });

  it('DT6/DT7 takes up to 10000 characters', () => {
    expect(
      (
        firstLayer(withLayers([text({ text: 't'.repeat(10000) })]))
          .text as string
      ).length
    ).toBe(10000);
    invalid(withLayers([text({ text: 't'.repeat(10001) })]));
  });

  it('DT8/DT9 refuses NUL and lone surrogates', () => {
    invalid(withLayers([text({ text: `a\u0000${MARKER}` })]));
    invalid(withLayers([text({ text: `\ud800${MARKER}` })]));
    invalid(withLayers([text({ text: 'x\udc00' })]));
    expect(firstLayer(withLayers([text({ text: 'Café 🚀' })])).text).toBe(
      'Café 🚀'
    );
  });

  it('DT10/100 a family is 1-200 characters of plain text, trimmed, never parsed', () => {
    const family = `url(https://evil.example/f.woff2) ${MARKER}`;
    expect(
      (
        firstLayer(
          withLayers([
            text({
              font: { type: 'family', family, weight: 400, style: 'normal' },
            }),
          ])
        ).font as Obj
      ).family
    ).toBe(family);
    for (const value of ['', '  ', 'f'.repeat(201), '\u0000']) {
      invalid(
        withLayers([
          text({
            font: {
              type: 'family',
              family: value,
              weight: 400,
              style: 'normal',
            },
          }),
        ])
      );
    }
  });

  it('DT11/DT12 takes weights 100-900 by 100 and normal or italic', () => {
    for (const weight of [100, 400, 900]) {
      expect(
        (
          firstLayer(
            withLayers([
              text({
                font: { type: 'family', family: 'A', weight, style: 'italic' },
              }),
            ])
          ).font as Obj
        ).weight
      ).toBe(weight);
    }
    for (const weight of [450, 0, 1000, '400']) {
      invalid(
        withLayers([
          text({
            font: { type: 'family', family: 'A', weight, style: 'normal' },
          }),
        ])
      );
    }
    for (const style of ['oblique', 'bold', '']) {
      invalid(
        withLayers([
          text({ font: { type: 'family', family: 'A', weight: 400, style } }),
        ])
      );
    }
    invalid(
      withLayers([
        text({
          font: {
            type: 'family',
            family: 'A',
            weight: 400,
            style: 'normal',
            url: 'x',
          },
        }),
      ])
    );
  });

  it('DT13/DT14/DT15 takes a font size of 1 to 1024', () => {
    for (const fontSize of [1, 1024, 13.5]) {
      expect(firstLayer(withLayers([text({ fontSize })])).fontSize).toBe(
        fontSize
      );
    }
    for (const fontSize of [0.99, 1025, 0, -12]) {
      invalid(withLayers([text({ fontSize })]));
    }
  });

  it('DT16/DT17 takes a line height multiple of 0.5 to 10', () => {
    for (const lineHeight of [0.5, 10, 1.15]) {
      expect(firstLayer(withLayers([text({ lineHeight })])).lineHeight).toBe(
        lineHeight
      );
    }
    for (const lineHeight of [0.49, 10.01, 0]) {
      invalid(withLayers([text({ lineHeight })]));
    }
  });

  it('DT18/DT19 takes a letter spacing of -100 to 100', () => {
    for (const letterSpacing of [-100, 100, -0.5]) {
      expect(
        firstLayer(withLayers([text({ letterSpacing })])).letterSpacing
      ).toBe(letterSpacing);
    }
    for (const letterSpacing of [-100.1, 100.1]) {
      invalid(withLayers([text({ letterSpacing })]));
    }
  });

  it('DT20/DT21/DT22 takes exactly these alignments and overflows', () => {
    for (const align of ['left', 'center', 'right']) {
      expect(firstLayer(withLayers([text({ align })])).align).toBe(align);
    }
    for (const verticalAlign of ['top', 'middle', 'bottom']) {
      expect(
        firstLayer(withLayers([text({ verticalAlign })])).verticalAlign
      ).toBe(verticalAlign);
    }
    for (const overflow of ['clip', 'shrink']) {
      expect(firstLayer(withLayers([text({ overflow })])).overflow).toBe(
        overflow
      );
    }
    invalid(withLayers([text({ align: 'justify' })]));
    invalid(withLayers([text({ verticalAlign: 'center' })]));
    for (const overflow of ['ellipsis', 'auto', 'flow', 'visible']) {
      invalid(withLayers([text({ overflow })]));
    }
  });

  it.each([
    'fill',
    'html',
    'markdown',
    'css',
    'className',
    'shadow',
    'strokeColor',
    'fontUrl',
  ])('DT23/99 refuses a text %s field', (key) =>
    invalid(withLayers([text({ [key]: MARKER })]))
  );
});

// ============================================================================
describe('Design Document v1: shape layers', () => {
  it('DS1/DS4/DS5/DS6 a rectangle with a radius of 0 to 4096', () => {
    const layer = firstLayer(withLayers([shape()]));
    expect(Object.keys(layer).sort()).toEqual([
      'cornerRadius',
      'fill',
      'height',
      'id',
      'name',
      'opacity',
      'rotation',
      'shape',
      'type',
      'visible',
      'width',
      'x',
      'y',
    ]);
    for (const cornerRadius of [0, 4096, 8.5]) {
      expect(
        firstLayer(withLayers([shape({ cornerRadius })])).cornerRadius
      ).toBe(cornerRadius);
    }
    for (const cornerRadius of [4096.5, -1, NaN]) {
      invalid(withLayers([shape({ cornerRadius })]));
    }
  });

  it('DS2/DS3/34 an ellipse has a radius of exactly 0', () => {
    expect(
      firstLayer(withLayers([shape({ shape: 'ellipse', cornerRadius: 0 })]))
        .shape
    ).toBe('ellipse');
    const error = refused(
      withLayers([shape({ shape: 'ellipse', cornerRadius: 4 })])
    );
    expect(error.issues).toEqual([
      { path: ['pages', 0, 'layers', 0, 'cornerRadius'], code: 'custom' },
    ]);
  });

  it('DS7 a Brand Kit fill token parses on its own', () => {
    expect(
      firstLayer(withLayers([shape({ fill: brand('accent-2') })])).fill
    ).toEqual(brand('accent-2'));
    invalid(withLayers([shape({ fill: { type: 'gradient' } })]));
    invalid(withLayers([shape({ fill: 'transparent' })]));
  });

  it.each(['polygon', 'path', 'line', 'star', 'Rectangle'])(
    'DS8 refuses the shape %s',
    (value) => {
      invalid(withLayers([shape({ shape: value })]));
    }
  );

  it.each([
    'stroke',
    'strokeColor',
    'strokeWidth',
    'path',
    'd',
    'points',
    'shadow',
    'blur',
    'filter',
    'text',
    'gradient',
  ])('DS9/DS10/101-103 refuses a shape %s field', (key) =>
    invalid(withLayers([shape({ [key]: MARKER })]))
  );
});

// ============================================================================
describe('Design Document v1: image layers', () => {
  const ref = (overrides: Obj = {}) => ({
    type: 'media',
    mediaId: 'media-1',
    sha256: SHA,
    ...overrides,
  });

  it('DI1/128 an image names a Media id and its SHA-256, nothing else', () => {
    const layer = firstLayer(withLayers([image()]));
    expect(Object.keys(layer).sort()).toEqual([
      'fit',
      'focalPoint',
      'height',
      'id',
      'imageRef',
      'name',
      'opacity',
      'rotation',
      'type',
      'visible',
      'width',
      'x',
      'y',
    ]);
    expect(Object.keys(layer.imageRef as Obj).sort()).toEqual([
      'mediaId',
      'sha256',
      'type',
    ]);
  });

  it('DI2/DI3 takes media ids exactly like a Content Package draft does', () => {
    const draftAccepts = (mediaId: unknown) => {
      try {
        parseContentPackageDraft({
          schemaVersion: 1,
          copy: {
            global: { thread: [{ id: 'main', text: '', mediaIds: [mediaId] }] },
          },
        });
        return true;
      } catch {
        return false;
      }
    };
    const designAccepts = (mediaId: unknown) => {
      try {
        parse(withLayers([image({ imageRef: ref({ mediaId }) })]));
        return true;
      } catch {
        return false;
      }
    };
    const samples = [
      'media-1',
      '0f8fad5b-d9cb-469f-a165-70867728950e',
      'A_b-9',
      'x'.repeat(64),
      'x'.repeat(65),
      '',
      'a b',
      'a.png',
      '../etc/passwd',
      'https://example.com/a.png',
      'data:image/png;base64,AAAA',
      '\u0000',
      'média',
      7,
      null,
    ];
    for (const sample of samples) {
      expect([sample, designAccepts(sample)]).toEqual([
        sample,
        draftAccepts(sample),
      ]);
    }
    expect(designAccepts('media-1')).toBe(true);
    expect(designAccepts('https://example.com/a.png')).toBe(false);
  });

  it('DI4/DI5 takes a lowercase 64-hex SHA-256 only', () => {
    expect(
      (
        firstLayer(
          withLayers([image({ imageRef: ref({ sha256: 'f'.repeat(64) }) })])
        ).imageRef as Obj
      ).sha256
    ).toBe('f'.repeat(64));
    for (const sha256 of [
      'F'.repeat(64),
      'f'.repeat(63),
      'f'.repeat(65),
      'g'.repeat(64),
      '',
    ]) {
      invalid(withLayers([image({ imageRef: ref({ sha256 }) })]));
    }
  });

  it('DI6/DI7 fits by cover or contain', () => {
    for (const fit of ['cover', 'contain']) {
      expect(firstLayer(withLayers([image({ fit })])).fit).toBe(fit);
    }
    for (const fit of ['fill', 'stretch', 'none', 'scale-down']) {
      invalid(withLayers([image({ fit })]));
    }
  });

  it('DI8/DI9 needs a focal point within 0..1 on both axes', () => {
    for (const focalPoint of [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0.5, y: 0.5 },
    ]) {
      expect(
        firstLayer(withLayers([image({ focalPoint })])).focalPoint
      ).toEqual(focalPoint);
    }
    for (const focalPoint of [
      { x: -0.1, y: 0.5 },
      { x: 0.5, y: 1.1 },
      { x: 0.5 },
      { x: 0.5, y: 0.5, z: 0 },
      null,
      [0.5, 0.5],
    ]) {
      invalid(withLayers([image({ focalPoint })]));
    }
  });

  it.each([
    'url',
    'src',
    'href',
    'imageUrl',
    'externalUrl',
    'dataUrl',
    'base64',
    'filename',
    'path',
    'mimeType',
    'color',
  ])('DI10/DI11/DI12/41/99 refuses an image %s field', (key) =>
    invalid(withLayers([image({ [key]: MARKER })]))
  );

  it.each(['url', 'src', 'path', 'filename', 'mimeType', 'width', 'base64'])(
    'DI13 refuses an imageRef %s field',
    (key) => invalid(withLayers([image({ imageRef: ref({ [key]: MARKER }) })]))
  );

  it('refuses another reference type', () => {
    invalid(withLayers([image({ imageRef: ref({ type: 'url' }) })]));
    invalid(withLayers([image({ imageRef: 'media-1' })]));
  });
});

// ============================================================================
describe('Design Document v1: totals and size', () => {
  const texts = (count: number, length: number, char = 't') =>
    Array.from({ length: count }, (_, i) =>
      text({ id: `t${i}`, text: char.repeat(length) })
    );

  it('DZ1/DZ2 takes 200000 characters of text in all, not one more', () => {
    expect(parse(withLayers(texts(20, 10000))).pages[0].layers).toHaveLength(
      20
    );
    const error = refused(
      withLayers([...texts(20, 10000), text({ id: 'extra', text: 'x' })])
    );
    expect(error.code).toBe('INVALID');
    expect(error.issues).toEqual([{ path: ['pages'], code: 'custom' }]);
  });

  // A structurally valid document whose canonical JSON is exactly `target`
  // UTF-8 bytes: 200000 three-byte text characters, shapes named with
  // three-byte characters (found by bisection), then six filler shapes whose
  // ASCII names make up the rest
  const sized = (target: number) => {
    const build = (named: number, filler: number[]) => {
      const layers: unknown[] = [
        ...texts(20, 10000, '€'),
        ...Array.from({ length: named }, (_, i) =>
          shape({ id: `s${i}`, name: '€'.repeat(100) })
        ),
        ...filler.map((length, i) =>
          shape({ id: `f${i}`, name: 'a'.repeat(length) })
        ),
      ];
      const pages = [];
      for (let i = 0; i < layers.length; i += 200) {
        pages.push(page({ id: `p${i}`, layers: layers.slice(i, i + 200) }));
      }
      return doc({ pages });
    };
    const empty = [0, 0, 0, 0, 0, 0];
    let low = 0;
    let high = 974;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (bytes(build(middle, empty)) <= target) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    let gap = target - bytes(build(low, empty));
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(600);
    const filler = empty.map(() => {
      const length = Math.min(100, gap);
      gap -= length;
      return length;
    });
    const result = build(low, filler);
    expect(bytes(result)).toBe(target);
    return result;
  };

  it('DZ3 a typical document is far below 1 MiB', () => {
    expect(bytes(parse(doc()))).toBeLessThan(DESIGN_DOCUMENT_MAX_BYTES);
  });

  it('DZ4 exactly 1_048_576 bytes is accepted', () => {
    expect(DESIGN_DOCUMENT_MAX_BYTES).toBe(1_048_576);
    const input = sized(1_048_576);
    expect(
      Buffer.byteLength(storedContentStudioDesignDocument(parse(input)).content)
    ).toBe(1_048_576);
  });

  it('DZ5/DZ6/86 1_048_577 bytes is too large, counted in UTF-8 bytes', () => {
    const input = sized(1_048_577);
    // far fewer JavaScript characters than bytes
    expect(JSON.stringify(input).length).toBeLessThan(700_000);
    const error = refused(input);
    expect(error.code).toBe('TOO_LARGE');
    expect(error.message).toBe('The design document is larger than allowed');
  });

  it('86 structural limits are invalid, not too large', () => {
    expect(
      refused(
        doc({
          pages: Array.from({ length: 26 }, (_, i) => page({ id: `p${i}` })),
        })
      ).code
    ).toBe('INVALID');
    expect(refused(withLayers(texts(21, 10000, '€'))).code).toBe('INVALID');
  });
});

// ============================================================================
describe('Design Document v1: Brand Kit token use', () => {
  it('90 collects each color and type token once, in first-use order, without changing the document', () => {
    const input = parse(
      doc({
        brandKit: brandKitRef(),
        pages: [
          page({
            background: { type: 'solid', color: brand('paper') },
            layers: [
              text({ id: 'a', font: brand('heading'), color: brand('ink') }),
              shape({ id: 'b', fill: brand('paper') }),
              text({ id: 'c', font: brand('body'), color: literal() }),
              image({ id: 'd' }),
            ],
          }),
          page({
            id: 'p2',
            background: { type: 'solid', color: brand('ink') },
            layers: [text({ id: 'e', font: brand('heading') })],
          }),
        ],
      })
    );
    const before = JSON.stringify(input);
    expect(collectContentStudioDesignBrandTokenRefs(input)).toEqual({
      colorTokenIds: ['paper', 'ink'],
      typographyTokenIds: ['heading', 'body'],
    });
    expect(JSON.stringify(input)).toBe(before);
    expect(collectContentStudioDesignBrandTokenRefs(parse(doc()))).toEqual({
      colorTokenIds: [],
      typographyTokenIds: [],
    });
  });
});

// ============================================================================
describe('Design revisions: canonical storage and verified reads', () => {
  const sha = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  const row = (input: unknown = doc()) =>
    storedContentStudioDesignDocument(parse(input));

  it('DR1 stores canonical JSON, fractions included, with its SHA-256', () => {
    const value = row(
      withLayers([shape({ x: 10.5, opacity: 0.25, rotation: -12.75 })])
    );
    expect(value.schemaVersion).toBe(1);
    expect(value.content.startsWith('{"brandKit":null,"pages":[')).toBe(true);
    expect(value.content).toContain('"opacity":0.25');
    expect(value.content).toContain('"rotation":-12.75');
    expect(value.content).toContain('"x":10.5');
    expect(value.contentHash).toBe(sha(value.content));
    expect(value.contentHash).toBe(sha256Hex(value.content));
    expect(JSON.parse(value.content)).toEqual(
      parse(withLayers([shape({ x: 10.5, opacity: 0.25, rotation: -12.75 })]))
    );
  });

  it('DR2 the order of object keys does not matter', () => {
    const input = doc();
    const reordered = { pages: input.pages, brandKit: null, schemaVersion: 1 };
    expect(row(reordered)).toEqual(row(input));
  });

  it('DR3 uppercase literal colors hash like lowercase ones', () => {
    expect(row(withLayers([shape({ fill: literal('#AABBCC') })]))).toEqual(
      row(withLayers([shape({ fill: literal('#aabbcc') })]))
    );
  });

  it('DR4/DR5/DR6/95/96 page order, layer order and the Brand Kit reference are part of the hash', () => {
    const a = page({
      id: 'a',
      layers: [shape({ id: 'one' }), text({ id: 'two' })],
    });
    const b = page({ id: 'b', layers: [] });
    const base = row(doc({ pages: [a, b] })).contentHash;
    expect(row(doc({ pages: [b, a] })).contentHash).not.toBe(base);
    expect(
      row(
        doc({
          pages: [
            page({
              id: 'a',
              layers: [text({ id: 'two' }), shape({ id: 'one' })],
            }),
            b,
          ],
        })
      ).contentHash
    ).not.toBe(base);
    const withKit = row(
      doc({ pages: [a, b], brandKit: brandKitRef() })
    ).contentHash;
    expect(withKit).not.toBe(base);
    for (const change of [
      { brandKitId: '33333333-3333-4333-8333-333333333333' },
      { revisionId: '44444444-4444-4444-8444-444444444444' },
      { revisionNumber: 4 },
      { contentHash: 'd'.repeat(64) },
    ]) {
      expect(
        row(doc({ pages: [a, b], brandKit: brandKitRef(change) })).contentHash
      ).not.toBe(withKit);
    }
  });

  it('DR7 reads a stored revision back exactly', () => {
    const value = row(doc({ brandKit: brandKitRef() }));
    expect(parseVerifiedContentStudioDesignRevision(value)).toEqual(
      parse(doc({ brandKit: brandKitRef() }))
    );
  });

  const corrupt = (change: Partial<ReturnType<typeof row>>) => {
    let error: unknown;
    try {
      parseVerifiedContentStudioDesignRevision({ ...row(), ...change });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ContentStudioDesignIntegrityError);
    expect((error as Error).message).toBe(
      'A stored design revision failed its integrity check'
    );
    expect(inspect(error, { depth: 8 })).not.toContain(MARKER);
  };

  it('DR8 malformed JSON', () => corrupt({ content: `{"pages":"${MARKER}"` }));

  it('DR9 valid but not canonical JSON', () => {
    const pretty = JSON.stringify(JSON.parse(row().content), null, 1);
    corrupt({ content: pretty, contentHash: sha(pretty) });
    const upper = row().content.replace('#ffffff', '#FFFFFF');
    corrupt({ content: upper, contentHash: sha(upper) });
  });

  it('DR10 a hash that does not match', () => {
    corrupt({ contentHash: 'f'.repeat(64) });
  });

  it('DR11 another schema version on the row', () =>
    corrupt({ schemaVersion: 2 }));

  it('DR12/DR13 an unknown stored field, never repeated', () => {
    const extra = JSON.stringify({
      ...JSON.parse(row().content),
      fabric: MARKER,
    });
    corrupt({ content: extra, contentHash: sha(extra) });
  });

  it('58 verifies its own bytes only: the Brand Kit it names is not consulted', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'design.document.revision.ts'),
      'utf8'
    );
    expect(source).not.toMatch(
      /BrandKitRepository|parseVerifiedContentStudioBrandKitRevision/
    );
  });
});

// ============================================================================
describe('Design Document P4-02 persistence boundary', () => {
  const ROOT = path.resolve(__dirname, '../../../../..');
  const FILES = [
    'libraries/nestjs-libraries/src/content-studio/design/design.document.ts',
    'libraries/nestjs-libraries/src/content-studio/design/design.document.revision.ts',
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design.repository.ts',
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design.service.ts',
    'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.design.dto.ts',
  ];
  // code only: the comments explain the boundary and may name it
  const code = (file: string) =>
    fs
      .readFileSync(path.join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const sources = FILES.map((file) => [file, code(file)] as const);
  const identifiers = (value: string) =>
    new Set(Array.from(value.matchAll(/[A-Za-z_$][\w$]*/g)).map((m) => m[0]));

  it('127 no Fabric, web markup, SVG, external image, renderer, Media or AI identifier', () => {
    for (const [file, value] of sources) {
      const names = identifiers(value);
      for (const name of [
        'fabric',
        'objects',
        'canvasJson',
        'html',
        'markup',
        'css',
        'className',
        'svg',
        'imageUrl',
        'src',
        'href',
        'externalUrl',
        'dataUrl',
        'base64',
        'url',
        'filename',
        'mimeType',
        'zIndex',
        'group',
        'stroke',
        'shadow',
        'gradient',
        'useCurrentBrandKit',
        'brandKitLatest',
        'ContentStudioMediaRepository',
        'ContentStudioMediaService',
        'MediaService',
        'AIExecution',
        'ContentStudioAIExecutionService',
        'generateDesign',
        'provider',
      ]) {
        expect([file, name, names.has(name)]).toEqual([file, name, false]);
      }
      expect([file, value]).not.toEqual([
        file,
        expect.stringMatching(
          /from '(sharp|fontkit|fabric|canvas|@napi-rs\/canvas|puppeteer|playwright|jsdom|svg[^']*)'|from '[^']*media[^']*'|from '[^']*\/ai\/[^']*'|safeFetch|\bfetch\(/i
        ),
      ]);
    }
  });

  it('129 the document holds the Brand Kit reference only, never its content', () => {
    const domain = sources[0][1];
    const names = identifiers(domain);
    for (const name of [
      'brandName',
      'tagline',
      'visualDirection',
      'BRAND_COLOR_ROLES',
    ]) {
      expect([name, names.has(name)]).toEqual([name, false]);
    }
    expect(
      Object.keys(
        parse(doc({ brandKit: brandKitRef() })).brandKit as unknown as Obj
      ).sort()
    ).toEqual(['brandKitId', 'contentHash', 'revisionId', 'revisionNumber']);
  });

  // P4-08: Creative Studio saves an edited document as the next revision,
  // through its API helper only
  it('110 designs reach the frontend only through Creative Studio, which saves revisions through its API helper only', () => {
    const walk = (dir: string): string[] =>
      fs
        .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
        .flatMap((entry) =>
          entry.isDirectory()
            ? walk(`${dir}/${entry.name}`)
            : [`${dir}/${entry.name}`]
        );
    const frontend = [
      ...walk('apps/frontend/src/components/content-studio'),
      ...walk('apps/frontend/src/app/(app)/(site)/content-studio'),
    ].filter((file) => /\.tsx?$/.test(file) && !/\.spec\.tsx?$/.test(file));
    expect(frontend.length).toBeGreaterThan(10);
    const CS = 'apps/frontend/src/components/content-studio';
    expect(
      frontend
        .filter((file) =>
          /\/designs\b|DesignDocument|designProject/.test(code(file))
        )
        .sort()
    ).toEqual([
      // P6-02: AI suggestions are applied into the draft document as one
      // editor step; they save no design revision
      `${CS}/content-studio.design-ai.tsx`,
      // P4-18: blocks are copied out of and into the draft document, and the
      // library hands the draft on; neither saves a design revision
      `${CS}/content-studio.design-blocks.tsx`,
      // P4-15: layouts are copied out of and into the draft document; they
      // save no design revision
      `${CS}/content-studio.design-layout-patterns.tsx`,
      `${CS}/content-studio.design-library.tsx`,
      // P4-17: page sets are read from and added to the draft document; they
      // save no design revision
      `${CS}/content-studio.design-page-sets.tsx`,
      // P4-11: design templates hold Design Document v1 revisions too
      `${CS}/content-studio.design-template.workspace.tsx`,
      `${CS}/content-studio.design-templates.api.ts`,
      `${CS}/content-studio.design-templates.tsx`,
      `${CS}/content-studio.design.editing.tsx`,
      `${CS}/content-studio.design.editor.ts`,
      `${CS}/content-studio.design.workspace.tsx`,
      `${CS}/content-studio.designs.api.ts`,
      `${CS}/content-studio.designs.tsx`,
      // the link to Creative Studio only
      `${CS}/content-studio.home.tsx`,
      // activation flow 01: the getting-started list links to Creative
      // Studio and reads whether a design exists; it saves nothing
      `${CS}/content-studio.onboarding.tsx`,
      // P5-06: the link of a review to its exact design revision only
      `${CS}/content-studio.reviews.api.ts`,
      // the Content Studio navigation: the link to Creative Studio only
      `${CS}/content-studio.shell.tsx`,
    ]);
    const creativeStudio = frontend.filter((f) =>
      /content-studio\.designs?[.a-z]*\.tsx?$|\/designs\//.test(f)
    );
    // P4-09 adds the canvas, its geometry helper and its Fabric adapter
    expect(creativeStudio).toHaveLength(11);
    for (const file of creativeStudio) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /design\.document\.revision|design\/layout|design\/render/
        ),
      ]);
    }
    // the one design revision write: the API helper, over the base revision
    expect(
      frontend
        .filter((file) =>
          /designPath\(id\)\}\/revisions`,\s*\{/.test(code(file))
        )
        .sort()
    ).toEqual([`${CS}/content-studio.designs.api.ts`]);
    expect(code(`${CS}/content-studio.designs.api.ts`)).toContain(
      'JSON.stringify({ baseRevisionNumber, content })'
    );
  });
});

// ============================================================================
// P4-14: the optional image mask
describe('Design Document v1: image masks', () => {
  const imageLayer = (extra: Record<string, unknown> = {}) => ({
    id: 'photo',
    name: '',
    x: 10,
    y: 20,
    width: 300,
    height: 200,
    rotation: 15,
    opacity: 0.8,
    visible: true,
    type: 'image',
    imageRef: { type: 'media', mediaId: 'media-1', sha256: 'a'.repeat(64) },
    fit: 'cover',
    focalPoint: { x: 0.25, y: 0.75 },
    ...extra,
  });
  const documentWith = (layer: Record<string, unknown>) => ({
    schemaVersion: 1,
    brandKit: null,
    pages: [
      {
        id: 'p1',
        name: '',
        width: 1080,
        height: 1080,
        background: {
          type: 'solid',
          color: { type: 'literal', value: '#ffffff' },
        },
        layers: [layer],
      },
    ],
  });
  const parsedLayer = (layer: Record<string, unknown>) =>
    parseContentStudioDesignDocument(documentWith(layer)).pages[0].layers[0];
  const refused = (mask: unknown) => {
    expect(() =>
      parseContentStudioDesignDocument(documentWith(imageLayer({ mask })))
    ).toThrow();
  };

  it('DDIMG1/P414-1 a legacy image without a mask parses unchanged: no default is written, the version stays 1', () => {
    const document = parseContentStudioDesignDocument(
      documentWith(imageLayer())
    );
    expect(document.schemaVersion).toBe(1);
    expect(document.pages[0].layers[0]).toEqual(imageLayer());
    expect(Object.keys(document.pages[0].layers[0])).not.toContain('mask');
    expect(storedContentStudioDesignDocument(document).content).not.toContain(
      'mask'
    );
  });

  it('DDIMG2/DDIMG3/DDIMG4 rectangle, rounded rectangle and ellipse parse exactly', () => {
    for (const mask of [
      { type: 'rectangle' },
      { type: 'roundedRectangle', cornerRadius: 0 },
      { type: 'roundedRectangle', cornerRadius: 24.5 },
      { type: 'roundedRectangle', cornerRadius: 4096 },
      { type: 'ellipse' },
    ]) {
      expect(parsedLayer(imageLayer({ mask }))).toEqual(imageLayer({ mask }));
    }
    // a radius beyond the box is stored as given, like a shape's corner
    // radius; the layout limits it when drawn
    expect(
      parsedLayer(
        imageLayer({ mask: { type: 'roundedRectangle', cornerRadius: 1000 } })
      )
    ).toMatchObject({ mask: { cornerRadius: 1000 } });
  });

  it('DDIMG5/DDIMG6/DDIMG7/DDIMG8/DDIMG9/P414-3/P414-4/SECIMG3/SECIMG4 anything else is refused', () => {
    for (const mask of [
      { type: 'circle' },
      { type: 'path', d: 'M0 0L10 10Z' },
      { type: 'svg', svg: '<clipPath/>' },
      { type: 'ellipse', clipPath: 'circle(50%)' },
      { type: 'rectangle', url: 'https://example.test/mask.png' },
      { type: 'roundedRectangle', cornerRadius: -1 },
      { type: 'roundedRectangle', cornerRadius: 4097 },
      { type: 'roundedRectangle', cornerRadius: Number.NaN },
      { type: 'roundedRectangle', cornerRadius: Infinity },
      { type: 'roundedRectangle', cornerRadius: '24' },
      { type: 'roundedRectangle' },
      { type: 'rectangle', cornerRadius: 8 },
      { type: 'ellipse', cornerRadius: 8 },
      { type: 'roundedRectangle', cornerRadius: 8, extra: true },
      'ellipse',
      null,
      [],
    ]) {
      refused(mask);
    }
    // a mask belongs to images only
    expect(() =>
      parseContentStudioDesignDocument(
        documentWith({
          ...imageLayer(),
          type: 'shape',
          shape: 'rectangle',
          fill: { type: 'literal', value: '#000000' },
          cornerRadius: 0,
          imageRef: undefined,
          fit: undefined,
          focalPoint: undefined,
          mask: { type: 'ellipse' },
        })
      )
    ).toThrow();
  });

  it('DDIMG10 the canonical JSON is the same whatever the key order', () => {
    const one = storedContentStudioDesignDocument(
      parseContentStudioDesignDocument(
        documentWith(
          imageLayer({ mask: { type: 'roundedRectangle', cornerRadius: 12 } })
        )
      )
    );
    const two = storedContentStudioDesignDocument(
      parseContentStudioDesignDocument(
        documentWith(
          imageLayer({ mask: { cornerRadius: 12, type: 'roundedRectangle' } })
        )
      )
    );
    expect(two).toEqual(one);
    expect(one.content).toContain(
      '"mask":{"cornerRadius":12,"type":"roundedRectangle"}'
    );
  });

  it('P414-2/P414-13/P414-14 no new version, no filter, zoom, frame background or arbitrary mask field in the schema', () => {
    const source = fs
      .readFileSync(path.join(__dirname, 'design.document.ts'), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).toContain(
      'export const DESIGN_DOCUMENT_SCHEMA_VERSION = 1;'
    );
    expect(source).not.toMatch(
      /brightness|contrast|saturat|grayscale|blur|duotone|blendMode|zoom|scale:|frameBackground|clipPath|svg|polygon/i
    );
    // the mask schema itself: three fixed shapes, one number
    const mask = source.slice(
      source.indexOf('const imageMask'),
      source.indexOf('const imageLayer')
    );
    expect(mask.match(/z\.literal\('(\w+)'\)/g)).toEqual([
      "z.literal('rectangle')",
      "z.literal('roundedRectangle')",
      "z.literal('ellipse')",
    ]);
    expect(mask).not.toMatch(/z\.string\(|path|url|href|d:/i);
  });
});
