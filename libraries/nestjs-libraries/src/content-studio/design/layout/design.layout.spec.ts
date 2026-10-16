import * as fs from 'fs';
import * as path from 'path';
import { parseContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import { storedContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit.revision';
import {
  ContentStudioDesignDocumentV1,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { isPlainData } from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';
import {
  layoutContentStudioDesign,
  layoutContentStudioDesignImageGeometry,
} from '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout';
import {
  ContentStudioDesignFontSpec,
  ContentStudioDesignLayoutError,
  ContentStudioDesignLayoutErrorCode,
  ContentStudioDesignLayoutImageItem,
  ContentStudioDesignLayoutInput,
  ContentStudioDesignLayoutTextItem,
  ContentStudioDesignShapedGlyph,
  DESIGN_LAYOUT_SCHEMA_VERSION,
} from '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout.types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const MARKER = '/srv/private/fonts/secret-marker.ttf';

type Plain = Record<string, unknown>;

const literal = (value: string) => ({ type: 'literal', value });
const brand = (tokenId: string) => ({ type: 'brand', tokenId });
const INTER = { type: 'family', family: 'Inter', weight: 400, style: 'normal' };

const rectangle = (id: string, extra: Plain = {}) => ({
  id,
  name: '',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  opacity: 1,
  visible: true,
  type: 'shape',
  shape: 'rectangle',
  fill: literal('#ff0000'),
  cornerRadius: 0,
  ...extra,
});

const ellipse = (id: string, extra: Plain = {}) =>
  rectangle(id, { shape: 'ellipse', ...extra });

const text = (id: string, value: string, extra: Plain = {}) => ({
  id,
  name: '',
  x: 0,
  y: 0,
  width: 1000,
  height: 1000,
  rotation: 0,
  opacity: 1,
  visible: true,
  type: 'text',
  text: value,
  font: INTER,
  fontSize: 100,
  lineHeight: 1.2,
  letterSpacing: 0,
  color: literal('#111111'),
  align: 'left',
  verticalAlign: 'top',
  overflow: 'clip',
  ...extra,
});

const image = (id: string, extra: Plain = {}) => ({
  id,
  name: '',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  opacity: 1,
  visible: true,
  type: 'image',
  imageRef: { type: 'media', mediaId: 'photo-1', sha256: SHA_A },
  fit: 'contain',
  focalPoint: { x: 0.5, y: 0.5 },
  ...extra,
});

const page = (layers: unknown[], extra: Plain = {}) => ({
  id: 'page-1',
  name: '',
  width: 1080,
  height: 1080,
  background: { type: 'solid', color: literal('#ffffff') },
  layers,
  ...extra,
});

const design = (pages: unknown[], brandKit: unknown = null) =>
  parseContentStudioDesignDocument({ schemaVersion: 1, brandKit, pages });

const KIT = parseContentStudioBrandKitContent({
  schemaVersion: 1,
  identity: { brandName: 'Acme', tagline: '', description: '' },
  colors: [
    { id: 'paper', name: 'Paper', value: '#FAF7F2', role: 'background' },
    { id: 'ink', name: 'Ink', value: '#1A1A1A', role: 'text' },
    { id: 'accent', name: 'Accent', value: '#E4572E', role: 'accent' },
  ],
  typography: [
    {
      id: 'heading',
      name: 'Heading',
      family: 'Poppins',
      weight: 700,
      style: 'normal',
      role: 'heading',
    },
    {
      id: 'body',
      name: 'Body',
      family: 'Inter',
      weight: 400,
      style: 'normal',
      role: 'body',
    },
  ],
  visualDirection: { keywords: [], dos: [], donts: [] },
});
const REF = {
  brandKitId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  revisionId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  revisionNumber: 3,
  contentHash: storedContentStudioBrandKitContent(KIT).contentHash,
};
const CONTEXT = { ref: REF, content: KIT };

// The fake font: 1000 units per em, ascent 800, descent -200. One glyph per
// code point (id = code point) with advance 600, a space 300, "i" 250 and
// "W" 900; "fi" is one ligature glyph (500) and "AV" is kerned by -100
const advanceOf = (char: string) =>
  char === ' ' ? 300 : char === 'i' ? 250 : char === 'W' ? 900 : 600;

function fakeShape(value: string) {
  const glyphs: ContentStudioDesignShapedGlyph[] = [];
  let index = 0;
  while (index < value.length) {
    const glyph = { cluster: index, yAdvance: 0, xOffset: 0, yOffset: 0 };
    if (value.startsWith('fi', index)) {
      glyphs.push({ ...glyph, id: 0xfb01, xAdvance: 500 });
      index += 2;
      continue;
    }
    const codePoint = value.codePointAt(index) as number;
    const char = String.fromCodePoint(codePoint);
    const kern = char === 'A' && value[index + char.length] === 'V' ? -100 : 0;
    glyphs.push({ ...glyph, id: codePoint, xAdvance: advanceOf(char) + kern });
    index += char.length;
  }
  return { glyphs };
}

function fakeFonts(
  available: Record<string, Plain> = { 'Inter|400|normal': {} }
) {
  const requests: ContentStudioDesignFontSpec[] = [];
  const shaped: string[] = [];
  return {
    requests,
    shaped,
    resolveFont(font: ContentStudioDesignFontSpec) {
      requests.push({ ...font });
      const key = `${font.family}|${font.weight}|${font.style}`;
      const overrides = available[key];
      if (!overrides) {
        return null;
      }
      return {
        key,
        unitsPerEm: 1000,
        ascent: 800,
        descent: -200,
        shape: (value: string) => {
          shaped.push(value);
          return fakeShape(value);
        },
        ...overrides,
      } as never;
    },
  };
}

function fakeImages(
  sizes: Record<string, unknown> = {
    [`photo-1:${SHA_A}`]: { width: 800, height: 400 },
  }
) {
  const requests: Array<{ mediaId: string; sha256: string }> = [];
  return {
    requests,
    getImageMetadata(ref: { mediaId: string; sha256: string }) {
      requests.push({ mediaId: ref.mediaId, sha256: ref.sha256 });
      return (sizes[`${ref.mediaId}:${ref.sha256}`] ?? null) as never;
    },
  };
}

interface RunOptions {
  brandKit?: unknown;
  fonts?: unknown;
  images?: unknown;
}

const run = (document: unknown, options: RunOptions = {}) =>
  layoutContentStudioDesign({
    document,
    brandKit: options.brandKit ?? null,
    fonts: options.fonts ?? fakeFonts(),
    images: options.images ?? fakeImages(),
  } as ContentStudioDesignLayoutInput);

const firstItem = (layer: unknown, options: RunOptions = {}) =>
  run(design([page([layer])]), options).pages[0].items[0];

const layoutText = (layer: unknown, options: RunOptions = {}) =>
  firstItem(layer, options) as ContentStudioDesignLayoutTextItem;

const layoutImage = (layer: unknown, options: RunOptions = {}) =>
  firstItem(layer, options) as ContentStudioDesignLayoutImageItem;

const lineTexts = (item: ContentStudioDesignLayoutTextItem) =>
  item.lines.map((line) => line.text);

const errorOf = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    return error as ContentStudioDesignLayoutError;
  }
  throw new Error('expected the layout to fail');
};

const expectLayoutError = (
  action: () => unknown,
  code: ContentStudioDesignLayoutErrorCode
) => {
  const error = errorOf(action);
  expect(error).toBeInstanceOf(ContentStudioDesignLayoutError);
  expect(error.code).toBe(code);
  expect(error.message).toBe(new ContentStudioDesignLayoutError(code).message);
  return error;
};

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

describe('design layout: pages and items', () => {
  it('L1 lays out a minimal page', () => {
    expect(run(design([page([])]))).toEqual({
      schemaVersion: DESIGN_LAYOUT_SCHEMA_VERSION,
      pages: [
        {
          id: 'page-1',
          width: 1080,
          height: 1080,
          background: { type: 'solid', color: '#ffffff' },
          clipRect: { x: 0, y: 0, width: 1080, height: 1080 },
          items: [],
        },
      ],
    });
    expect(DESIGN_LAYOUT_SCHEMA_VERSION).toBe(1);
  });

  it('L2 keeps the page order exactly', () => {
    const output = run(
      design([
        page([], { id: 'zeta', width: 64, height: 128 }),
        page([], { id: 'alpha' }),
        page([], { id: 'Mid' }),
      ])
    );
    expect(output.pages.map((entry) => entry.id)).toEqual([
      'zeta',
      'alpha',
      'Mid',
    ]);
    expect(output.pages[0]).toMatchObject({ width: 64, height: 128 });
  });

  it('L3 keeps the layer order as z-order', () => {
    const output = run(
      design([
        page([
          rectangle('charlie'),
          ellipse('alpha'),
          rectangle('bravo'),
          image('delta'),
        ]),
      ])
    );
    expect(
      output.pages[0].items.map((entry) => [entry.layerId, entry.type])
    ).toEqual([
      ['charlie', 'rectangle'],
      ['alpha', 'ellipse'],
      ['bravo', 'rectangle'],
      ['delta', 'image'],
    ]);
  });

  it('L4 leaves hidden layers out of the display list', () => {
    const output = run(
      design([
        page([
          rectangle('shown-1'),
          rectangle('hidden', { visible: false }),
          text('hidden-text', 'a', { visible: false }),
          image('hidden-image', { visible: false }),
          rectangle('shown-2'),
        ]),
      ])
    );
    expect(output.pages[0].items.map((entry) => entry.layerId)).toEqual([
      'shown-1',
      'shown-2',
    ]);
  });

  it('L5 keeps a visible layer with opacity 0', () => {
    const output = run(
      design([
        page([
          rectangle('clear', { opacity: 0 }),
          text('clear-text', 'a', { opacity: 0 }),
        ]),
      ])
    );
    expect(output.pages[0].items).toHaveLength(2);
    expect(output.pages[0].items.map((entry) => entry.opacity)).toEqual([0, 0]);
  });

  it('L6 puts the transform origin at the center of every layer box', () => {
    const output = run(
      design([
        page([
          rectangle('box', { x: 10, y: 20, width: 100, height: 50 }),
          text('words', 'a', { x: -40, y: 7.5, width: 81, height: 13 }),
          image('picture', { x: 1000, y: 1000, width: 200, height: 300 }),
        ]),
      ])
    );
    expect(output.pages[0].items.map((entry) => entry.transformOrigin)).toEqual(
      [
        { x: 60, y: 45 },
        { x: 0.5, y: 14 },
        { x: 1100, y: 1150 },
      ]
    );
  });

  it('L7 keeps the rotation as stored (degrees, positive turns clockwise)', () => {
    const output = run(
      design([
        page([
          rectangle('cw', { rotation: 30 }),
          rectangle('ccw', { rotation: -45.5 }),
          rectangle('full', { rotation: 360 }),
        ]),
      ])
    );
    expect(output.pages[0].items.map((entry) => entry.rotation)).toEqual([
      30, -45.5, 360,
    ]);
    // the contract states the direction and the origin
    const contract = fs.readFileSync(
      path.join(__dirname, 'design.layout.types.ts'),
      'utf8'
    );
    expect(contract).toContain('a positive angle turns\n// clockwise');
    expect(contract).toContain(
      'around `transformOrigin`, the center of that box'
    );
    expect(Object.keys(output.pages[0].items[0])).not.toContain('matrix');
  });

  it('L8 returns plain JSON data', () => {
    const output = goldenLayout();
    expect(isPlainData(output)).toBe(true);
    expect(JSON.parse(JSON.stringify(output))).toStrictEqual(output);
    const values: unknown[] = [];
    const walk = (value: unknown) => {
      values.push(value);
      if (value && typeof value === 'object') {
        Object.values(value).forEach(walk);
      }
    };
    walk(output);
    for (const value of values) {
      expect(['undefined', 'function', 'bigint', 'symbol']).not.toContain(
        typeof value
      );
      if (typeof value === 'number') {
        expect(Number.isFinite(value)).toBe(true);
        expect(Object.is(value, -0)).toBe(false);
      }
    }
  });

  it('L9 changes neither its input nor the provider data, and returns new objects', () => {
    const document = deepFreeze(goldenDocument());
    const context = deepFreeze({
      ref: { ...REF },
      content: JSON.parse(JSON.stringify(KIT)),
    });
    const sizes = deepFreeze({
      [`photo-1:${SHA_A}`]: { width: 800, height: 400 },
      [`hero-1:${SHA_B}`]: { width: 1000, height: 1000 },
    });
    const shapes: unknown[] = [];
    const frozenFonts = () => ({
      resolveFont: (font: ContentStudioDesignFontSpec) =>
        deepFreeze({
          ...(goldenFonts().resolveFont(font) as object),
          shape: (value: string) => {
            const result = deepFreeze(fakeShape(value));
            shapes.push(result);
            return result;
          },
        }),
    });
    const glyphs = shapes;
    const before = JSON.stringify([document, context, sizes]);
    const output = run(document, {
      brandKit: context,
      fonts: frozenFonts(),
      images: fakeImages(sizes),
    });
    const shaped = JSON.stringify(glyphs);
    expect(shapes.length).toBeGreaterThan(0);
    expect(JSON.stringify([document, context, sizes])).toBe(before);

    const expected = JSON.stringify(output);
    const item = output.pages[0].items[4] as ContentStudioDesignLayoutImageItem;
    item.intrinsic.width = 1;
    item.imageRef.mediaId = 'other';
    (
      output.pages[0].items[2] as ContentStudioDesignLayoutTextItem
    ).lines[0].glyphs[0].id = 9;
    output.pages[0].background.color = '#000000';
    expect(JSON.stringify([document, context, sizes])).toBe(before);
    expect(JSON.stringify(glyphs)).toBe(shaped);
    expect(
      JSON.stringify(
        run(document, {
          brandKit: context,
          fonts: frozenFonts(),
          images: fakeImages(sizes),
        })
      )
    ).toBe(expected);
  });

  it('L10 gives exactly the same output 100 times', () => {
    const first = JSON.stringify(goldenLayout());
    for (let index = 0; index < 100; index += 1) {
      expect(JSON.stringify(goldenLayout())).toBe(first);
    }
  });

  it('asks the providers in page and layer order, each font and image once', () => {
    const calls: string[] = [];
    const fonts = fakeFonts({
      'Inter|400|normal': {},
      'Poppins|700|normal': {},
    });
    const images = fakeImages({
      [`photo-1:${SHA_A}`]: { width: 10, height: 10 },
      [`hero-1:${SHA_B}`]: { width: 10, height: 10 },
    });
    const tracked = {
      resolveFont: (font: ContentStudioDesignFontSpec) => {
        calls.push(`font ${font.family}`);
        return fonts.resolveFont(font);
      },
    };
    const trackedImages = {
      getImageMetadata: (ref: { mediaId: string; sha256: string }) => {
        calls.push(`image ${ref.mediaId}`);
        return images.getImageMetadata(ref);
      },
    };
    run(
      design(
        [
          page(
            [
              image('i1', {
                imageRef: { type: 'media', mediaId: 'hero-1', sha256: SHA_B },
              }),
              text('t1', 'a', { font: brand('heading') }),
              image('i2'),
            ],
            { id: 'one' }
          ),
          page(
            [
              text('t2', 'a'),
              image('i3', {
                imageRef: { type: 'media', mediaId: 'hero-1', sha256: SHA_B },
              }),
              text('t3', 'b', { font: brand('body') }),
            ],
            { id: 'two' }
          ),
        ],
        REF
      ),
      { brandKit: CONTEXT, fonts: tracked, images: trackedImages }
    );
    expect(calls).toEqual([
      'image hero-1',
      'font Poppins',
      'image photo-1',
      'font Inter',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

describe('design layout: input', () => {
  const valid = () => ({
    document: design([page([])]),
    brandKit: null,
    fonts: fakeFonts(),
    images: fakeImages(),
  });

  it.each([
    ['no input', () => null],
    ['a string', () => 'design'],
    [
      'an invalid document',
      () => ({ ...valid(), document: { schemaVersion: 1 } }),
    ],
    [
      'a document of another version',
      () => ({
        ...valid(),
        document: { ...valid().document, schemaVersion: 2 },
      }),
    ],
    [
      'a document with NaN geometry',
      () => ({
        ...valid(),
        document: {
          ...valid().document,
          pages: [page([rectangle('r', { x: NaN })])],
        },
      }),
    ],
    ['no font provider', () => ({ ...valid(), fonts: undefined })],
    ['a font provider without resolveFont', () => ({ ...valid(), fonts: {} })],
    ['no image provider', () => ({ ...valid(), images: null })],
    [
      'an image provider without getImageMetadata',
      () => ({ ...valid(), images: { get: () => null } }),
    ],
    [
      'no Brand Kit context at all',
      () => ({ ...valid(), brandKit: undefined }),
    ],
  ])('refuses %s', (_name, input) => {
    expectLayoutError(
      () =>
        layoutContentStudioDesign(input() as ContentStudioDesignLayoutInput),
      'INVALID_INPUT'
    );
  });

  it('parses the document itself: an unnormalized one is laid out normalized', () => {
    const output = run({
      schemaVersion: 1,
      brandKit: null,
      pages: [
        page([
          text('t', 'a\r\nb\rc', { color: literal('#ABCDEF') }),
          rectangle('r', { fill: literal('#FF00AA') }),
        ]),
      ],
    });
    const item = output.pages[0].items[0] as ContentStudioDesignLayoutTextItem;
    expect(lineTexts(item)).toEqual(['a', 'b', 'c']);
    expect(item.color).toBe('#abcdef');
    expect(output.pages[0].items[1]).toMatchObject({ fill: '#ff00aa' });
  });

  it('has fixed error messages that name no value', () => {
    const messages = (
      [
        'INVALID_INPUT',
        'BRAND_CONTEXT_MISSING',
        'BRAND_CONTEXT_MISMATCH',
        'BRAND_TOKEN_MISSING',
        'FONT_UNAVAILABLE',
        'FONT_METRICS_INVALID',
        'FONT_SHAPING_UNSUPPORTED',
        'IMAGE_UNAVAILABLE',
        'IMAGE_METADATA_INVALID',
      ] as ContentStudioDesignLayoutErrorCode[]
    ).map((code) => [code, new ContentStudioDesignLayoutError(code).message]);
    expect(messages).toEqual([
      ['INVALID_INPUT', 'The design layout input is invalid.'],
      ['BRAND_CONTEXT_MISSING', 'The design Brand Kit context is missing.'],
      [
        'BRAND_CONTEXT_MISMATCH',
        'The design Brand Kit context does not match the design.',
      ],
      ['BRAND_TOKEN_MISSING', 'A design Brand Kit token is unavailable.'],
      ['FONT_UNAVAILABLE', 'A design font is unavailable.'],
      ['FONT_METRICS_INVALID', 'A design font returned invalid metrics.'],
      [
        'FONT_SHAPING_UNSUPPORTED',
        'A design font shaped text in an unsupported way.',
      ],
      ['IMAGE_UNAVAILABLE', 'A design image is unavailable.'],
      ['IMAGE_METADATA_INVALID', 'A design image has invalid metadata.'],
    ]);
    expect(new ContentStudioDesignLayoutError('FONT_UNAVAILABLE').name).toBe(
      'ContentStudioDesignLayoutError'
    );
  });
});

// ---------------------------------------------------------------------------
// Brand Kit
// ---------------------------------------------------------------------------

describe('design layout: Brand Kit', () => {
  const branded = (layers: unknown[], background = brand('paper')) =>
    design(
      [page(layers, { background: { type: 'solid', color: background } })],
      REF
    );
  const brandFonts = () =>
    fakeFonts({ 'Inter|400|normal': {}, 'Poppins|700|normal': {} });

  it('LB1 lays out literal colors without a Brand Kit', () => {
    const output = run(
      design([
        page([rectangle('r', { fill: literal('#00FF00') })], {
          background: { type: 'solid', color: literal('#123456') },
        }),
      ])
    );
    expect(output.pages[0].background.color).toBe('#123456');
    expect(output.pages[0].items[0]).toMatchObject({ fill: '#00ff00' });
  });

  it('LB2 resolves tokens from the matching Brand Kit context', () => {
    const output = run(branded([rectangle('r', { fill: brand('accent') })]), {
      brandKit: CONTEXT,
    });
    expect(output.pages[0].background.color).toBe('#faf7f2');
    expect(output.pages[0].items[0]).toMatchObject({ fill: '#e4572e' });
  });

  it('LB3 needs the context when the document names a Brand Kit', () => {
    expectLayoutError(() => run(branded([])), 'BRAND_CONTEXT_MISSING');
  });

  it('LB4 refuses a context for a document without a Brand Kit', () => {
    expectLayoutError(
      () => run(design([page([])]), { brandKit: CONTEXT }),
      'BRAND_CONTEXT_MISMATCH'
    );
  });

  it.each([
    [
      'LB5 another Brand Kit id',
      { brandKitId: '9b2f8e1c-4a6d-4f3b-8c2e-1d5a7b9c0e2f' },
    ],
    [
      'LB6 another revision id',
      { revisionId: '3d6f0a8e-2b4c-4e1a-9f7d-5c8b2a6e4d10' },
    ],
    ['LB7 another revision number', { revisionNumber: 4 }],
    ['LB8 another content hash', { contentHash: SHA_A }],
    ['a revision number as text', { revisionNumber: '3' }],
    ['an extra field', { current: true }],
  ])('%s in the context reference is a mismatch', (_name, change) => {
    expectLayoutError(
      () =>
        run(branded([]), {
          brandKit: { ref: { ...REF, ...change }, content: KIT },
        }),
      'BRAND_CONTEXT_MISMATCH'
    );
  });

  it('refuses a context without a reference or of the wrong shape', () => {
    expectLayoutError(
      () => run(branded([]), { brandKit: { content: KIT } }),
      'BRAND_CONTEXT_MISMATCH'
    );
    expectLayoutError(
      () => run(branded([]), { brandKit: 'kit' }),
      'INVALID_INPUT'
    );
  });

  it('LB9 verifies the content against the content hash', () => {
    const changed = {
      ...KIT,
      colors: KIT.colors.map((token) =>
        token.id === 'paper' ? { ...token, value: '#ffffff' } : token
      ),
    };
    expectLayoutError(
      () => run(branded([]), { brandKit: { ref: REF, content: changed } }),
      'BRAND_CONTEXT_MISMATCH'
    );
    // reordered tokens are another revision as well
    expectLayoutError(
      () =>
        run(branded([]), {
          brandKit: {
            ref: REF,
            content: { ...KIT, colors: [...KIT.colors].reverse() },
          },
        }),
      'BRAND_CONTEXT_MISMATCH'
    );
    // content that cannot be hashed at all
    expectLayoutError(
      () =>
        run(branded([]), {
          brandKit: { ref: REF, content: { ...KIT, extra: () => 1 } },
        }),
      'BRAND_CONTEXT_MISMATCH'
    );
  });

  it('LB10 fails on a missing color token, without a fallback color', () => {
    expectLayoutError(
      () =>
        run(branded([rectangle('r', { fill: brand('missing') })]), {
          brandKit: CONTEXT,
        }),
      'BRAND_TOKEN_MISSING'
    );
    expectLayoutError(
      () =>
        run(branded([text('t', 'a', { color: brand('missing') })]), {
          brandKit: CONTEXT,
          fonts: brandFonts(),
        }),
      'BRAND_TOKEN_MISSING'
    );
    // a page background is always drawn
    expectLayoutError(
      () => run(branded([], brand('missing')), { brandKit: CONTEXT }),
      'BRAND_TOKEN_MISSING'
    );
    // typography ids are not color ids
    expectLayoutError(
      () =>
        run(branded([rectangle('r', { fill: brand('heading') })]), {
          brandKit: CONTEXT,
        }),
      'BRAND_TOKEN_MISSING'
    );
  });

  it('LB10 fails on a color token in a document without a Brand Kit', () => {
    expectLayoutError(
      () => run(design([page([rectangle('r', { fill: brand('paper') })])])),
      'BRAND_TOKEN_MISSING'
    );
  });

  it('LB11 fails on a missing typography token, without a fallback font', () => {
    const fonts = brandFonts();
    expectLayoutError(
      () =>
        run(branded([text('t', 'a', { font: brand('missing') })]), {
          brandKit: CONTEXT,
          fonts,
        }),
      'BRAND_TOKEN_MISSING'
    );
    expectLayoutError(
      () =>
        run(branded([text('t', 'a', { font: brand('ink') })]), {
          brandKit: CONTEXT,
          fonts,
        }),
      'BRAND_TOKEN_MISSING'
    );
    expect(fonts.requests).toEqual([]);
  });

  it('LB12 resolves colors to their literal values', () => {
    const output = run(
      branded(
        [
          rectangle('r', { fill: brand('accent') }),
          ellipse('e', { fill: brand('ink') }),
          text('t', 'a', { color: brand('ink') }),
        ],
        brand('paper')
      ),
      { brandKit: CONTEXT }
    );
    expect(output.pages[0].background).toEqual({
      type: 'solid',
      color: '#faf7f2',
    });
    const colorOf = (entry: object) =>
      'fill' in entry ? entry.fill : (entry as { color: string }).color;
    expect(output.pages[0].items.map(colorOf)).toEqual([
      '#e4572e',
      '#1a1a1a',
      '#1a1a1a',
    ]);
  });

  it('LB13 resolves a typography token to its family, weight and style', () => {
    const fonts = brandFonts();
    const output = run(branded([text('t', 'a', { font: brand('heading') })]), {
      brandKit: CONTEXT,
      fonts,
    });
    const laid = output.pages[0].items[0] as ContentStudioDesignLayoutTextItem;
    expect(laid.font).toEqual({
      family: 'Poppins',
      weight: 700,
      style: 'normal',
    });
    expect(laid.fontKey).toBe('Poppins|700|normal');
    expect(fonts.requests).toEqual([
      { family: 'Poppins', weight: 700, style: 'normal' },
    ]);
  });

  it('LB14 uses only the given revision: newer content is refused and no token id remains', () => {
    const newer = parseContentStudioBrandKitContent({
      ...KIT,
      colors: [
        ...KIT.colors,
        { id: 'extra', name: 'Extra', value: '#000000', role: 'custom' },
      ],
    });
    expectLayoutError(
      () => run(branded([]), { brandKit: { ref: REF, content: newer } }),
      'BRAND_CONTEXT_MISMATCH'
    );
    const newerRef = {
      ...REF,
      revisionNumber: 4,
      contentHash: storedContentStudioBrandKitContent(newer).contentHash,
    };
    expectLayoutError(
      () => run(branded([]), { brandKit: { ref: newerRef, content: newer } }),
      'BRAND_CONTEXT_MISMATCH'
    );
    const output = JSON.stringify(goldenLayout());
    for (const tokenId of [
      'paper',
      'ink',
      'accent',
      'heading',
      'body',
      'tokenId',
      'brand',
    ]) {
      expect(output).not.toContain(`"${tokenId}"`);
    }
  });

  it('LB15 skips a hidden layer with a missing token', () => {
    const output = run(
      branded([
        rectangle('hidden', { fill: brand('missing'), visible: false }),
        text('hidden-text', 'a', {
          color: brand('missing'),
          font: brand('missing'),
          visible: false,
        }),
      ]),
      { brandKit: CONTEXT }
    );
    expect(output.pages[0].items).toEqual([]);
  });

  it('reads tokens from its own verified copy of the content', () => {
    const content = JSON.parse(JSON.stringify(KIT));
    const fonts = {
      resolveFont: (font: ContentStudioDesignFontSpec) => {
        content.colors[1].value = '#ff0000';
        return fakeFonts().resolveFont(font);
      },
    };
    const output = run(
      branded([
        text('t', 'a', { font: INTER }),
        rectangle('r', { fill: brand('ink') }),
      ]),
      { brandKit: { ref: REF, content }, fonts }
    );
    expect(output.pages[0].items[1]).toMatchObject({ fill: '#1a1a1a' });
  });
});

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

describe('design layout: shapes', () => {
  it('LS1 lays out a rectangle', () => {
    expect(
      firstItem(
        rectangle('card', {
          x: 10,
          y: 20,
          width: 300,
          height: 200,
          rotation: 12,
          opacity: 0.75,
          fill: literal('#336699'),
          cornerRadius: 16,
        })
      )
    ).toEqual({
      layerId: 'card',
      type: 'rectangle',
      box: { x: 10, y: 20, width: 300, height: 200 },
      rotation: 12,
      transformOrigin: { x: 160, y: 120 },
      opacity: 0.75,
      fill: '#336699',
      cornerRadius: 16,
    });
  });

  it('LS2 lays out an ellipse without a corner radius', () => {
    const item = firstItem(
      ellipse('dot', {
        x: -5,
        y: 5,
        width: 10,
        height: 30,
        fill: literal('#ABCDEF'),
      })
    );
    expect(item).toEqual({
      layerId: 'dot',
      type: 'ellipse',
      box: { x: -5, y: 5, width: 10, height: 30 },
      rotation: 0,
      transformOrigin: { x: 0, y: 20 },
      opacity: 1,
      fill: '#abcdef',
    });
    expect(Object.keys(item)).not.toContain('cornerRadius');
  });

  it('LS3 and LS4 fill with literal and Brand colors', () => {
    expect(
      firstItem(rectangle('r', { fill: literal('#FFFFFF') }))
    ).toMatchObject({ fill: '#ffffff' });
    const output = run(
      design([page([ellipse('e', { fill: brand('accent') })])], REF),
      { brandKit: CONTEXT }
    );
    expect(output.pages[0].items[0]).toMatchObject({ fill: '#e4572e' });
  });

  it.each([
    ['LS5 a radius below half of both sides is kept', 100, 40, 10, 10],
    ['LS5 exactly half', 100, 40, 20, 20],
    ['LS6 limited by the width', 40, 100, 100, 20],
    ['LS7 limited by the height', 100, 40, 100, 20],
    ['LS8 zero', 100, 40, 0, 0],
    ['a fractional limit', 15, 100, 4096, 7.5],
  ])('%s', (_name, width, height, cornerRadius, expected) => {
    expect(
      firstItem(rectangle('r', { width, height, cornerRadius }))
    ).toMatchObject({ cornerRadius: expected });
  });

  it('LS9 keeps fractional and off-page geometry exactly', () => {
    expect(
      firstItem(
        rectangle('r', {
          x: -10.125,
          y: 2000.5,
          width: 0.25,
          height: 33.3,
          rotation: -0.5,
          opacity: 0.333,
        })
      )
    ).toMatchObject({
      box: { x: -10.125, y: 2000.5, width: 0.25, height: 33.3 },
      transformOrigin: { x: -10, y: 2000.5 + 33.3 / 2 },
      rotation: -0.5,
      opacity: 0.333,
    });
  });

  it('writes -0 as 0', () => {
    const item = run({
      schemaVersion: 1,
      brandKit: null,
      pages: [page([rectangle('r', { x: -0, y: -0, rotation: -0 })])],
    }).pages[0].items[0];
    expect(Object.is(item.box.x, -0)).toBe(false);
    expect(Object.is(item.box.y, -0)).toBe(false);
    expect(Object.is(item.rotation, -0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

describe('design layout: image contain', () => {
  const contain = (
    width: number,
    height: number,
    box: Plain = {},
    focalPoint = { x: 0.5, y: 0.5 }
  ) =>
    layoutImage(
      image('img', { x: 10, y: 20, ...box, fit: 'contain', focalPoint }),
      {
        images: fakeImages({ [`photo-1:${SHA_A}`]: { width, height } }),
      }
    );

  it('IC1 fits a square image in a square box', () => {
    expect(contain(500, 500)).toMatchObject({
      sourceRect: { x: 0, y: 0, width: 500, height: 500 },
      destinationRect: { x: 10, y: 20, width: 100, height: 100 },
    });
  });

  it('IC2 and IC8 center a landscape image vertically', () => {
    expect(contain(200, 100)).toMatchObject({
      sourceRect: { x: 0, y: 0, width: 200, height: 100 },
      destinationRect: { x: 10, y: 45, width: 100, height: 50 },
    });
  });

  it('IC3 and IC8 center a portrait image horizontally', () => {
    expect(contain(100, 200)).toMatchObject({
      sourceRect: { x: 0, y: 0, width: 100, height: 200 },
      destinationRect: { x: 35, y: 20, width: 50, height: 100 },
    });
  });

  it('IC4 fits a square image in a landscape box', () => {
    expect(contain(300, 300, { width: 200, height: 100 })).toMatchObject({
      destinationRect: { x: 60, y: 20, width: 100, height: 100 },
    });
  });

  it('IC5 keeps fractional sizes', () => {
    expect(
      contain(3, 1, { x: 1.75, y: 0, width: 33.5, height: 10 })
    ).toMatchObject({
      sourceRect: { x: 0, y: 0, width: 3, height: 1 },
      destinationRect: { x: 3.5, y: 0, width: 30, height: 10 },
    });
    const thin = contain(3, 7, { width: 10, height: 10 });
    expect(thin.destinationRect.width).toBe((10 * 3) / 7);
    expect(thin.destinationRect.x).toBe(10 + (10 - (10 * 3) / 7) / 2);
    expect(Number.isInteger(thin.destinationRect.width)).toBe(false);
  });

  it('IC6 uses the whole image as the source', () => {
    for (const [width, height] of [
      [1, 1],
      [32768, 1],
      [1, 32768],
      [4000, 3000],
    ]) {
      expect(contain(width, height).sourceRect).toEqual({
        x: 0,
        y: 0,
        width,
        height,
      });
    }
  });

  it('IC7 ignores the focal point', () => {
    const centered = contain(200, 100);
    for (const focalPoint of [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0.2, y: 0.9 },
    ]) {
      expect(contain(200, 100, {}, focalPoint)).toEqual(centered);
    }
  });
});

describe('design layout: image cover', () => {
  const cover = (
    width: number,
    height: number,
    focalPoint = { x: 0.5, y: 0.5 },
    box: Plain = {}
  ) =>
    layoutImage(
      image('img', { x: 10, y: 20, ...box, fit: 'cover', focalPoint }),
      {
        images: fakeImages({ [`photo-1:${SHA_A}`]: { width, height } }),
      }
    );

  it('IV1 uses all of a square image in a square box', () => {
    expect(cover(400, 400)).toMatchObject({
      sourceRect: { x: 0, y: 0, width: 400, height: 400 },
      destinationRect: { x: 10, y: 20, width: 100, height: 100 },
    });
  });

  it('IV2 crops a landscape image across', () => {
    expect(cover(2000, 1000).sourceRect).toEqual({
      x: 500,
      y: 0,
      width: 1000,
      height: 1000,
    });
  });

  it('IV3 crops a portrait image down', () => {
    expect(cover(1000, 2000).sourceRect).toEqual({
      x: 0,
      y: 500,
      width: 1000,
      height: 1000,
    });
  });

  it.each([
    ['IV4', 0, 0],
    ['IV5', 0.5, 500],
    ['IV6', 1, 1000],
    ['clamps a near-left focal point', 0.1, 0],
    ['moves off-center', 0.3, 100],
    ['clamps a near-right focal point', 0.9, 1000],
  ])('%s: focal x %p starts the crop at %p', (_name, x, sourceX) => {
    expect(cover(2000, 1000, { x, y: 0.5 }).sourceRect).toEqual({
      x: sourceX,
      y: 0,
      width: 1000,
      height: 1000,
    });
    // the other axis is not cropped, so its focal value does not matter
    expect(cover(2000, 1000, { x, y: 0 })).toEqual(
      cover(2000, 1000, { x, y: 1 })
    );
  });

  it.each([
    ['IV7', 0, 0],
    ['IV8', 0.5, 500],
    ['IV9', 1, 1000],
    ['moves off-center', 0.7, 900],
  ])('%s: focal y %p starts the crop at %p', (_name, y, sourceY) => {
    expect(cover(1000, 2000, { x: 0.5, y }).sourceRect).toEqual({
      x: 0,
      y: sourceY,
      width: 1000,
      height: 1000,
    });
  });

  it('IV10 keeps the crop inside the image', () => {
    for (const x of [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1]) {
      for (const [width, height, box] of [
        [2000, 1000, {}],
        [1000, 1000, { width: 300, height: 100 }],
        [1000, 3000, { width: 250, height: 100 }],
      ] as Array<[number, number, Plain]>) {
        const { sourceRect } = cover(width, height, { x, y: x }, box);
        expect(sourceRect.x).toBeGreaterThanOrEqual(0);
        expect(sourceRect.y).toBeGreaterThanOrEqual(0);
        expect(sourceRect.x + sourceRect.width).toBeLessThanOrEqual(width);
        expect(sourceRect.y + sourceRect.height).toBeLessThanOrEqual(height);
      }
    }
  });

  it('IV11 fills exactly the layer box', () => {
    for (const [width, height] of [
      [2000, 1000],
      [1000, 2000],
      [7, 3],
    ]) {
      expect(
        cover(
          width,
          height,
          { x: 0.2, y: 0.8 },
          { x: -3.5, y: 4, width: 250, height: 90 }
        ).destinationRect
      ).toEqual({
        x: -3.5,
        y: 4,
        width: 250,
        height: 90,
      });
    }
  });

  it('IV12 keeps a fractional crop', () => {
    const { sourceRect } = cover(
      1000,
      1000,
      { x: 0.5, y: 0.5 },
      { width: 300, height: 200 }
    );
    expect(sourceRect.height).toBe((1000 * 200) / 300);
    expect(sourceRect.y).toBe(500 - (1000 * 200) / 300 / 2);
    expect(Number.isInteger(sourceRect.height)).toBe(false);
    expect(Number.isInteger(sourceRect.y)).toBe(false);
    expect(sourceRect).toMatchObject({ x: 0, width: 1000 });
  });

  it('computes the same geometry through the exported helper', () => {
    expect(
      layoutContentStudioDesignImageGeometry(
        { x: 0, y: 0, width: 100, height: 100 },
        { width: 2000, height: 1000 },
        'cover',
        { x: 1, y: 0 }
      )
    ).toEqual({
      sourceRect: { x: 1000, y: 0, width: 1000, height: 1000 },
      destinationRect: { x: 0, y: 0, width: 100, height: 100 },
    });
  });
});

describe('design layout: image provider', () => {
  const withSize = (size: unknown) =>
    fakeImages({ [`photo-1:${SHA_A}`]: size });

  it('copies the image reference and the intrinsic size', () => {
    expect(
      layoutImage(
        image('pic', {
          x: 1,
          y: 2,
          width: 100,
          height: 50,
          rotation: 90,
          opacity: 0.5,
        })
      )
    ).toEqual({
      layerId: 'pic',
      type: 'image',
      box: { x: 1, y: 2, width: 100, height: 50 },
      rotation: 90,
      transformOrigin: { x: 51, y: 27 },
      opacity: 0.5,
      imageRef: { mediaId: 'photo-1', sha256: SHA_A },
      intrinsic: { width: 800, height: 400 },
      fit: 'contain',
      sourceRect: { x: 0, y: 0, width: 800, height: 400 },
      destinationRect: { x: 1, y: 2, width: 100, height: 50 },
    });
  });

  it('IM1 fails without metadata', () => {
    expectLayoutError(
      () => firstItem(image('i'), { images: fakeImages({}) }),
      'IMAGE_UNAVAILABLE'
    );
    expectLayoutError(
      () => firstItem(image('i'), { images: withSize(undefined) }),
      'IMAGE_UNAVAILABLE'
    );
  });

  it('IM2 never passes on what the provider throws', () => {
    for (const thrown of [new Error(MARKER), MARKER, { message: MARKER }]) {
      const error = expectLayoutError(
        () =>
          firstItem(image('i'), {
            images: {
              getImageMetadata: () => {
                throw thrown;
              },
            },
          }),
        'IMAGE_UNAVAILABLE'
      );
      expect(
        `${error.message} ${error.stack} ${JSON.stringify(error)}`
      ).not.toContain('secret-marker');
    }
  });

  it.each([
    ['IM3 width 0', { width: 0, height: 10 }],
    ['IM4 height 0', { width: 10, height: 0 }],
    ['IM5 NaN', { width: NaN, height: 10 }],
    ['IM6 Infinity', { width: 10, height: Infinity }],
    ['IM7 a side above 32768', { width: 32769, height: 1 }],
    ['more than 256 Mi pixels', { width: 32768, height: 8193 }],
    ['a negative side', { width: -10, height: 10 }],
    ['a fractional side', { width: 10.5, height: 10 }],
    ['numeric text', { width: '10', height: 10 }],
    ['a missing side', { width: 10 }],
    ['a number', 10],
    ['a string', 'image'],
  ])('%s is invalid metadata', (_name, size) => {
    expectLayoutError(
      () => firstItem(image('i'), { images: withSize(size) }),
      'IMAGE_METADATA_INVALID'
    );
  });

  it('accepts the largest allowed image and refuses a throwing getter', () => {
    expect(
      layoutImage(image('i'), {
        images: withSize({ width: 16384, height: 16384 }),
      }).intrinsic
    ).toEqual({ width: 16384, height: 16384 });
    expect(
      layoutImage(image('i'), {
        images: withSize({ width: 32768, height: 8192 }),
      }).intrinsic
    ).toEqual({ width: 32768, height: 8192 });
    const trap = {
      get width(): number {
        throw new Error(MARKER);
      },
      height: 10,
    };
    const error = expectLayoutError(
      () => firstItem(image('i'), { images: withSize(trap) }),
      'IMAGE_METADATA_INVALID'
    );
    expect(error.message).not.toContain('secret');
  });

  it('IM8 looks up the same Media id with another SHA-256 separately', () => {
    const images = fakeImages({
      [`photo-1:${SHA_A}`]: { width: 800, height: 400 },
      [`photo-1:${SHA_B}`]: { width: 100, height: 300 },
    });
    const output = run(
      design([
        page([
          image('first'),
          image('second', {
            imageRef: { type: 'media', mediaId: 'photo-1', sha256: SHA_B },
          }),
        ]),
      ]),
      { images }
    );
    expect(images.requests).toEqual([
      { mediaId: 'photo-1', sha256: SHA_A },
      { mediaId: 'photo-1', sha256: SHA_B },
    ]);
    expect(
      output.pages[0].items.map(
        (entry) => (entry as ContentStudioDesignLayoutImageItem).intrinsic
      )
    ).toEqual([
      { width: 800, height: 400 },
      { width: 100, height: 300 },
    ]);
    // only the SHA-256 the document names is accepted
    expectLayoutError(
      () =>
        firstItem(
          image('i', {
            imageRef: {
              type: 'media',
              mediaId: 'photo-1',
              sha256: 'c'.repeat(64),
            },
          }),
          { images }
        ),
      'IMAGE_UNAVAILABLE'
    );
  });

  it('IM9 looks up an identical image once per layout', () => {
    const images = fakeImages();
    run(
      design([
        page([image('a'), image('b')]),
        page([image('c')], { id: 'page-2' }),
      ]),
      { images }
    );
    expect(images.requests).toEqual([{ mediaId: 'photo-1', sha256: SHA_A }]);
    // a new layout asks again: nothing is cached between layouts
    run(design([page([image('a')])]), { images });
    expect(images.requests).toHaveLength(2);
  });

  it('IM10 does not look up the image of a hidden layer', () => {
    const images = fakeImages({});
    const output = run(design([page([image('hidden', { visible: false })])]), {
      images,
    });
    expect(output.pages[0].items).toEqual([]);
    expect(images.requests).toEqual([]);
  });

  it('hands the provider a copy of the reference', () => {
    const images = {
      getImageMetadata: (ref: { mediaId: string; sha256: string }) => {
        expect(Object.keys(ref)).toEqual(['mediaId', 'sha256']);
        ref.mediaId = 'changed';
        return { width: 10, height: 10 };
      },
    };
    expect(layoutImage(image('i'), { images }).imageRef).toEqual({
      mediaId: 'photo-1',
      sha256: SHA_A,
    });
  });
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

// At font size 100 the fake font gives: "a" 60, " " 30, "i" 25, "W" 90,
// "fi" 50; line height 1.2 gives 120 per line and the baseline 90 below the
// line top ((120 - (80 + 20)) / 2 + 80)
const A = 97;
const SPACE = 32;

describe('design layout: text basics', () => {
  it('LT1 lays out an empty text without lines', () => {
    const fonts = fakeFonts();
    const item = layoutText(text('t', ''), { fonts });
    expect(item.lines).toEqual([]);
    expect(item.fits).toBe(true);
    expect(fonts.shaped).toEqual([]);
  });

  it('LT2 lays out one line with its glyphs', () => {
    expect(layoutText(text('t', 'aa')).lines).toEqual([
      {
        text: 'aa',
        x: 0,
        baselineY: 90,
        width: 120,
        glyphs: [
          { id: A, cluster: 0, x: 0, y: 90, advance: 60 },
          { id: A, cluster: 1, x: 60, y: 90, advance: 60 },
        ],
      },
    ]);
  });

  it('LT3 breaks at an explicit newline', () => {
    const item = layoutText(text('t', 'a\nb'));
    expect(item.lines.map((line) => [line.text, line.baselineY])).toEqual([
      ['a', 90],
      ['b', 210],
    ]);
  });

  it('LT4 keeps empty lines', () => {
    expect(layoutText(text('t', 'a\n\nb')).lines[1]).toEqual({
      text: '',
      x: 0,
      baselineY: 210,
      width: 0,
      glyphs: [],
    });
    expect(lineTexts(layoutText(text('t', '\n')))).toEqual(['', '']);
    expect(lineTexts(layoutText(text('t', '\n\n\n')))).toHaveLength(4);
  });

  it('LT5 sees no carriage return: the document is normalized', () => {
    const fonts = fakeFonts();
    const item = run(
      {
        schemaVersion: 1,
        brandKit: null,
        pages: [page([text('t', 'a\r\n\r\nb\r')])],
      },
      { fonts }
    ).pages[0].items[0] as ContentStudioDesignLayoutTextItem;
    expect(lineTexts(item)).toEqual(['a', '', 'b', '']);
    expect(fonts.shaped.join('')).not.toContain('\r');
  });

  it('LT6 expands a tab to four spaces', () => {
    const fonts = fakeFonts();
    const document = design([page([text('t', 'a\tb')])]);
    const item = run(document, { fonts }).pages[0]
      .items[0] as ContentStudioDesignLayoutTextItem;
    expect(item.lines[0].text).toBe('a    b');
    expect(item.lines[0].width).toBe(60 + 4 * 30 + 60);
    expect(item.lines[0].glyphs.map((glyph) => glyph.id)).toEqual([
      A,
      SPACE,
      SPACE,
      SPACE,
      SPACE,
      98,
    ]);
    expect(fonts.shaped.join('')).not.toContain('\t');
    // the document keeps its tab
    expect((document.pages[0].layers[0] as { text: string }).text).toBe('a\tb');
  });

  it('LT7 keeps spaces when nothing wraps', () => {
    const item = layoutText(text('t', 'a  b'));
    expect(lineTexts(item)).toEqual(['a  b']);
    expect(item.lines[0].width).toBe(180);
  });

  it('LT8 wraps at a space', () => {
    expect(
      lineTexts(layoutText(text('t', 'aa aa aa', { width: 300 })))
    ).toEqual(['aa aa', 'aa']);
    expect(lineTexts(layoutText(text('t', 'aa aa', { width: 200 })))).toEqual([
      'aa',
      'aa',
    ]);
  });

  it('LT9 breaks a word wider than the box between code points', () => {
    const item = layoutText(text('t', 'aaaaa', { width: 150 }));
    expect(lineTexts(item)).toEqual(['aa', 'aa', 'a']);
    expect(item.fits).toBe(true);
    // a short word before a long one still wraps first
    expect(lineTexts(layoutText(text('t', 'a aaaaa', { width: 150 })))).toEqual(
      ['a', 'aa', 'aa', 'a']
    );
  });

  it('LT10 never splits a surrogate pair', () => {
    const item = layoutText(
      text('t', 'a\u{1F600}b\u{1F600}\u{1F600}', { width: 70 })
    );
    expect(lineTexts(item)).toEqual([
      'a',
      '\u{1F600}',
      'b',
      '\u{1F600}',
      '\u{1F600}',
    ]);
    expect(item.lines[1].glyphs).toEqual([
      { id: 0x1f600, cluster: 0, x: 0, y: 210, advance: 60 },
    ]);
    for (const line of item.lines) {
      expect(line.text).toBe(Array.from(line.text).join(''));
      expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(line.text)).toBe(false);
    }
  });

  it('leaves combining sequences and right-to-left text in source order', () => {
    expect(lineTexts(layoutText(text('t', 'éé', { width: 70 })))).toEqual([
      'e',
      '́',
      'e',
      '́',
    ]);
    const rtl = layoutText(text('t', 'שלום'));
    expect(rtl.lines[0].glyphs.map((glyph) => glyph.cluster)).toEqual([
      0, 1, 2, 3,
    ]);
  });
});

describe('design layout: wrap whitespace', () => {
  it('LW1 drops the single space a line wraps at', () => {
    const item = layoutText(text('t', 'aa aa', { width: 200 }));
    expect(item.lines.map((line) => [line.text, line.width])).toEqual([
      ['aa', 120],
      ['aa', 120],
    ]);
  });

  it('LW2 drops the whole run of spaces a line wraps at', () => {
    expect(
      lineTexts(layoutText(text('t', 'aa    aa', { width: 200 })))
    ).toEqual(['aa', 'aa']);
  });

  it('LW3 keeps leading spaces of a logical line', () => {
    expect(lineTexts(layoutText(text('t', '  aa')))).toEqual(['  aa']);
    expect(layoutText(text('t', '  aa')).lines[0].glyphs[2].x).toBe(60);
  });

  it('LW4 keeps trailing spaces of a logical line that fits', () => {
    const item = layoutText(text('t', 'aa  ', { align: 'right', width: 500 }));
    expect(item.lines[0]).toMatchObject({ text: 'aa  ', width: 180, x: 320 });
  });

  it('LW5 wraps away trailing spaces that do not fit, without an empty line', () => {
    expect(lineTexts(layoutText(text('t', 'aa   ', { width: 200 })))).toEqual([
      'aa',
    ]);
    expect(
      lineTexts(layoutText(text('t', 'aa aa   ', { width: 200 })))
    ).toEqual(['aa', 'aa']);
    // a line of spaces only that fits is kept
    expect(lineTexts(layoutText(text('t', '   ')))).toEqual(['   ']);
  });

  it('LW6 keeps spaces around an explicit newline', () => {
    expect(lineTexts(layoutText(text('t', 'aa \n aa')))).toEqual([
      'aa ',
      ' aa',
    ]);
  });

  it('LW7 wraps at tab spaces too', () => {
    expect(lineTexts(layoutText(text('t', 'aa\taa', { width: 200 })))).toEqual([
      'aa',
      'aa',
    ]);
    expect(lineTexts(layoutText(text('t', 'aa\taa', { width: 400 })))).toEqual([
      'aa    aa',
    ]);
  });

  it('does not break at a no-break space', () => {
    expect(lineTexts(layoutText(text('t', 'aa aa', { width: 200 })))).toEqual([
      'aa ',
      'aa',
    ]);
  });
});

describe('design layout: alignment', () => {
  const aligned = (extra: Plain, value = 'aa') =>
    layoutText(
      text('t', value, { x: 100, y: 50, width: 500, height: 400, ...extra })
    );

  it.each([
    ['LA1 left', 'left', 100],
    ['LA2 center', 'center', 290],
    ['LA3 right', 'right', 480],
  ])('%s', (_name, align, x) => {
    const line = aligned({ align }).lines[0];
    expect(line.x).toBe(x);
    expect(line.glyphs.map((glyph) => glyph.x)).toEqual([x, x + 60]);
  });

  it.each([
    ['LA4 top', 'top', 140],
    ['LA5 middle', 'middle', 280],
    ['LA6 bottom', 'bottom', 420],
  ])('%s', (_name, verticalAlign, baselineY) => {
    expect(aligned({ verticalAlign }).lines[0].baselineY).toBe(baselineY);
  });

  it('LA7 includes letter spacing in the line width', () => {
    const line = aligned({ align: 'center', letterSpacing: 10 }).lines[0];
    expect(line.width).toBe(130);
    expect(line.x).toBe(285);
    expect(line.glyphs.map((glyph) => glyph.x)).toEqual([285, 355]);
    const right = aligned({ align: 'right', letterSpacing: -5 }, 'aaa')
      .lines[0];
    expect(right.width).toBe(170);
    expect(right.x).toBe(430);
  });

  it('LA8 centers the whole block vertically', () => {
    expect(
      aligned({ verticalAlign: 'middle' }, 'a\nb\nc').lines.map(
        (line) => line.baselineY
      )
    ).toEqual([160, 280, 400]);
  });

  it('LA9 lets a bottom-aligned block start above the box', () => {
    const item = aligned({ verticalAlign: 'bottom', height: 100 }, 'a\nb');
    expect(item.lines.map((line) => line.baselineY)).toEqual([0, 120]);
    expect(item.fits).toBe(false);
    const middle = aligned({ verticalAlign: 'middle', height: 100 }, 'a\nb');
    expect(middle.lines[0].baselineY).toBe(50 + (100 - 240) / 2 + 90);
  });

  it('centers a line wider than the box to the left of it', () => {
    const line = aligned({ align: 'center', width: 50 }, 'W').lines[0];
    expect(line.x).toBe(100 + (50 - 90) / 2);
  });
});

describe('design layout: font metrics and glyphs', () => {
  const custom = (overrides: Plain, extra: Plain = {}, value = 'aa') =>
    layoutText(text('t', value, extra), {
      fonts: fakeFonts({ 'Inter|400|normal': overrides }),
    });

  it('LM1 scales font units by fontSize / unitsPerEm', () => {
    expect(layoutText(text('t', 'aa', { fontSize: 50 })).lines[0].width).toBe(
      60
    );
    expect(custom({ unitsPerEm: 2000 }).lines[0].width).toBe(60);
  });

  it('LM2 places the baseline from ascent and descent', () => {
    expect(
      custom({ ascent: 700, descent: -300 }, { lineHeight: 1.5 }).lines[0]
        .baselineY
    ).toBe(95);
    // a positive descent counts the same
    expect(
      custom({ ascent: 700, descent: 300 }, { lineHeight: 1.5 }).lines[0]
        .baselineY
    ).toBe(95);
    // a line box smaller than the em box keeps its baseline; nothing grows
    const tight = custom({}, { lineHeight: 0.5 }, 'a\nb');
    expect(tight.lines.map((line) => line.baselineY)).toEqual([55, 105]);
  });

  it('LM3 spaces lines by fontSize x lineHeight', () => {
    expect(
      layoutText(text('t', 'a\nb', { lineHeight: 2 })).lines.map(
        (line) => line.baselineY
      )
    ).toEqual([130, 330]);
    expect(
      layoutText(text('t', 'a\nb', { lineHeight: 1 })).lines.map(
        (line) => line.baselineY
      )
    ).toEqual([80, 180]);
  });

  const shaped = (glyphs: Plain[]) => ({
    shape: () => ({
      glyphs: glyphs.map((glyph, index) => ({
        id: 1,
        cluster: index,
        xAdvance: 100,
        yAdvance: 0,
        xOffset: 0,
        yOffset: 0,
        ...glyph,
      })),
    }),
  });

  it('LM4 advances by the shaped xAdvance', () => {
    const line = custom(
      shaped([{ xAdvance: 100 }, { xAdvance: 300 }, { xAdvance: 50 }]),
      {},
      'abc'
    ).lines[0];
    expect(line.glyphs.map((glyph) => [glyph.x, glyph.advance])).toEqual([
      [0, 10],
      [10, 30],
      [40, 5],
    ]);
    expect(line.width).toBe(45);
  });

  it('LM5 draws at xOffset without moving the pen', () => {
    const line = custom(shaped([{ xOffset: 50 }, {}]), {}, 'ab').lines[0];
    expect(line.glyphs.map((glyph) => glyph.x)).toEqual([5, 10]);
    expect(line.width).toBe(20);
  });

  it('LM6 turns a font yOffset (up) into a page offset (down)', () => {
    const line = custom(shaped([{ yOffset: 100 }, { yOffset: -50 }]), {}, 'ab')
      .lines[0];
    expect(line.glyphs.map((glyph) => glyph.y)).toEqual([80, 95]);
    expect(line.baselineY).toBe(90);
  });

  it('LM7 adds letter spacing between glyphs, not after the last', () => {
    const line = layoutText(text('t', 'aaa', { letterSpacing: 7.5 })).lines[0];
    expect(line.glyphs.map((glyph) => glyph.x)).toEqual([0, 67.5, 135]);
    expect(line.width).toBe(195);
    expect(
      layoutText(text('t', 'a', { letterSpacing: 50 })).lines[0].width
    ).toBe(60);
  });

  it('LM8 respects the glyph count the font shapes (ligatures)', () => {
    const line = layoutText(text('t', 'fi', { letterSpacing: 10 })).lines[0];
    expect(line.glyphs).toEqual([
      { id: 0xfb01, cluster: 0, x: 0, y: 90, advance: 50 },
    ]);
    expect(line.width).toBe(50);
    expect(
      layoutText(text('t', 'afi', { letterSpacing: 10 })).lines[0].width
    ).toBe(60 + 10 + 50);
  });

  it('LM9 respects the advances the font shapes (kerning)', () => {
    const line = layoutText(text('t', 'AV')).lines[0];
    expect(line.width).toBe(110);
    expect(line.glyphs.map((glyph) => glyph.x)).toEqual([0, 50]);
    // the kerned pair fits a box the unkerned one would not
    expect(lineTexts(layoutText(text('t', 'AV', { width: 115 })))).toEqual([
      'AV',
    ]);
    expect(lineTexts(layoutText(text('t', 'AA', { width: 115 })))).toEqual([
      'A',
      'A',
    ]);
  });

  it('LM10 carries the font key and the resolved font', () => {
    const item = custom({ key: 'inter-regular#1' });
    expect(item.fontKey).toBe('inter-regular#1');
    expect(item.font).toEqual({
      family: 'Inter',
      weight: 400,
      style: 'normal',
    });
  });

  it('carries the text settings of the layer', () => {
    const item = layoutText(
      text('t', 'a', {
        x: 1,
        y: 2,
        width: 300,
        height: 40.5,
        rotation: -10,
        opacity: 0.4,
        fontSize: 12.5,
        lineHeight: 1.75,
        letterSpacing: -2,
        color: literal('#AA0000'),
        align: 'right',
        verticalAlign: 'bottom',
      })
    );
    const { lines, ...rest } = item;
    expect(lines).toHaveLength(1);
    expect(rest).toEqual({
      layerId: 't',
      type: 'text',
      box: { x: 1, y: 2, width: 300, height: 40.5 },
      rotation: -10,
      transformOrigin: { x: 151, y: 22.25 },
      opacity: 0.4,
      clipRect: { x: 1, y: 2, width: 300, height: 40.5 },
      font: { family: 'Inter', weight: 400, style: 'normal' },
      fontKey: 'Inter|400|normal',
      color: '#aa0000',
      requestedFontSize: 12.5,
      resolvedFontSize: 12.5,
      lineHeight: 1.75,
      letterSpacing: -2,
      align: 'right',
      verticalAlign: 'bottom',
      overflow: 'clip',
      fits: true,
    });
  });
});

describe('design layout: clipping', () => {
  it('LC1 clips to exactly the layer box', () => {
    const item = layoutText(
      text('t', 'a', {
        x: -3.25,
        y: 9.5,
        width: 77.75,
        height: 12,
        rotation: 45,
      })
    );
    expect(item.clipRect).toEqual({
      x: -3.25,
      y: 9.5,
      width: 77.75,
      height: 12,
    });
    expect(item.clipRect).toEqual(item.box);
    expect(item.clipRect).not.toBe(item.box);
  });

  it('LC2 and LC5 lay out every line, also below the box', () => {
    const item = layoutText(text('t', 'a\nb\nc\nd', { height: 100 }));
    expect(lineTexts(item)).toEqual(['a', 'b', 'c', 'd']);
    expect(item.lines[3].baselineY).toBe(450);
    expect(item.lines[3].glyphs).toHaveLength(1);
    const wrapped = layoutText(
      text('t', 'aa aa aa aa', { width: 150, height: 130 })
    );
    expect(lineTexts(wrapped)).toEqual(['aa', 'aa', 'aa', 'aa']);
  });

  it('LC3 does not fit when the lines are taller than the box', () => {
    expect(layoutText(text('t', 'a\nb', { height: 239 })).fits).toBe(false);
    expect(layoutText(text('t', 'a\nb', { height: 240 })).fits).toBe(true);
  });

  it('LC4 does not fit when one glyph is wider than the box', () => {
    const item = layoutText(text('t', 'Wa', { width: 80 }));
    expect(lineTexts(item)).toEqual(['W', 'a']);
    expect(item.lines[0].width).toBe(90);
    expect(item.fits).toBe(false);
    expect(layoutText(text('t', 'W', { width: 90 })).fits).toBe(true);
  });

  it('keeps the requested size when clipping', () => {
    const item = layoutText(
      text('t', 'a\nb\nc', { height: 10, fontSize: 33.3 })
    );
    expect(item.resolvedFontSize).toBe(33.3);
    expect(item.requestedFontSize).toBe(33.3);
  });
});

describe('design layout: shrink to fit', () => {
  const shrink = (value: string, extra: Plain = {}, options: RunOptions = {}) =>
    layoutText(text('t', value, { overflow: 'shrink', ...extra }), options);

  it('LR1 keeps the requested size when it fits, fractions included', () => {
    const item = shrink('aa', { fontSize: 12.345 });
    expect(item.resolvedFontSize).toBe(12.345);
    expect(item.fits).toBe(true);
  });

  it('LR2 and LR3 shrink to the largest fitting hundredth', () => {
    const item = shrink('a\nb', { height: 100 });
    expect(item.resolvedFontSize).toBe(41.66);
    expect(item.fits).toBe(true);
    expect(item.requestedFontSize).toBe(100);
    expect(lineTexts(item)).toEqual(['a', 'b']);
  });

  it('LR3 never returns a size above the requested one', () => {
    // 12.345 does not fit; 12.34 is the largest hundredth below it
    expect(
      shrink('a', { fontSize: 12.345, height: 12.345 * 1.2 - 0.001 })
        .resolvedFontSize
    ).toBe(12.34);
    // a requested hundredth that does not fit is not tried twice
    expect(
      shrink('a', { fontSize: 12.34, height: 12.34 * 1.2 - 0.001 })
        .resolvedFontSize
    ).toBe(12.33);
  });

  it('LR4 shrinks the same way every time', () => {
    const first = JSON.stringify(
      shrink('aa aa aa aa aa', { width: 333, height: 77 })
    );
    for (let index = 0; index < 20; index += 1) {
      expect(
        JSON.stringify(shrink('aa aa aa aa aa', { width: 333, height: 77 }))
      ).toBe(first);
    }
  });

  it('LR5 and LR6 stop at size 1 and report that it does not fit', () => {
    const item = shrink('a', { height: 1, fontSize: 1024 });
    expect(item.resolvedFontSize).toBe(1);
    expect(item.fits).toBe(false);
    expect(lineTexts(item)).toEqual(['a']);
    const many = shrink('a\n'.repeat(500), { height: 64 });
    expect(many.resolvedFontSize).toBe(1);
    expect(many.fits).toBe(false);
  });

  it('LR6 at size 1 a requested size of 1 stays 1', () => {
    const item = shrink('a\nb', { fontSize: 1, height: 1 });
    expect(item.resolvedFontSize).toBe(1);
    expect(item.fits).toBe(false);
  });

  it('LR7 does not shrink an empty text', () => {
    const item = shrink('', { height: 1, fontSize: 500 });
    expect(item.resolvedFontSize).toBe(500);
    expect(item.fits).toBe(true);
    expect(item.lines).toEqual([]);
  });

  it('LR8 counts empty lines', () => {
    expect(shrink('a\n\nb', { height: 100 }).resolvedFontSize).toBe(27.77);
    expect(shrink('\n', { height: 100 }).resolvedFontSize).toBe(41.66);
  });

  it('LR9 shrinks a glyph wider than the box until it fits the width', () => {
    const item = shrink('W', { width: 50 });
    expect(item.resolvedFontSize).toBe(55.55);
    expect(item.fits).toBe(true);
    expect(item.lines[0].width).toBeLessThanOrEqual(50);
  });

  it('LR9 rewraps while shrinking', () => {
    const item = shrink('aa aa', { width: 250, height: 130 });
    expect(item.resolvedFontSize).toBe(92.59);
    expect(lineTexts(item)).toEqual(['aa aa']);
    expect(
      lineTexts(layoutText(text('t', 'aa aa', { width: 250, height: 130 })))
    ).toEqual(['aa', 'aa']);
  });

  it('LR10 includes letter spacing while fitting', () => {
    const item = shrink('aa', { width: 130, height: 120, letterSpacing: 20 });
    expect(item.resolvedFontSize).toBe(91.66);
    expect(lineTexts(item)).toEqual(['aa']);
    expect(item.letterSpacing).toBe(20);
    expect(item.lines[0].width).toBeLessThanOrEqual(130);
  });

  it('LR11 aligns vertically at the resolved size', () => {
    const item = shrink('a\nb', { height: 100, verticalAlign: 'bottom' });
    const size = 41.66;
    const lineBox = size * 1.2;
    const top = 100 - 2 * lineBox;
    const baseline =
      top + (lineBox - (0.8 * size + 0.2 * size)) / 2 + 0.8 * size;
    expect(item.lines[0].baselineY).toBeCloseTo(baseline, 9);
    expect(item.lines[1].baselineY).toBeCloseTo(baseline + lineBox, 9);
    expect(item.lines[0].glyphs[0].advance).toBeCloseTo(0.6 * size, 9);
    const middle = shrink('a\nb', { height: 100, verticalAlign: 'middle' });
    expect(middle.lines[0].baselineY).toBeCloseTo(
      (100 - 2 * lineBox) / 2 + (lineBox - size) / 2 + 0.8 * size,
      9
    );
  });

  it('measures each text once per font within a layout', () => {
    const fonts = fakeFonts();
    const item = shrink('aa aa aa', { width: 300, height: 50 }, { fonts });
    // measured once each, then shaped once more for every final line
    const counts = new Map<string, number>();
    for (const value of fonts.shaped) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    for (const [value, count] of counts) {
      expect(count).toBe(
        1 + lineTexts(item).filter((line) => line === value).length
      );
    }
    expect(fonts.shaped.length).toBeGreaterThan(lineTexts(item).length);
  });
});

describe('design layout: fonts', () => {
  const withFont = (overrides: Plain) =>
    fakeFonts({ 'Inter|400|normal': overrides });

  it('LF1 fails on a font the provider does not have', () => {
    expectLayoutError(
      () => firstItem(text('t', 'a'), { fonts: fakeFonts({}) }),
      'FONT_UNAVAILABLE'
    );
    expectLayoutError(
      () => firstItem(text('t', 'a', { font: { ...INTER, weight: 700 } })),
      'FONT_UNAVAILABLE'
    );
    expectLayoutError(
      () =>
        firstItem(text('t', 'a'), { fonts: { resolveFont: () => undefined } }),
      'FONT_UNAVAILABLE'
    );
  });

  it('LF1 resolves a font even for an empty text', () => {
    expectLayoutError(
      () => firstItem(text('t', ''), { fonts: fakeFonts({}) }),
      'FONT_UNAVAILABLE'
    );
  });

  it('LF2 never passes on what the provider throws', () => {
    const throwing = (thrown: unknown) => () => {
      throw thrown;
    };
    for (const thrown of [new Error(MARKER), MARKER]) {
      for (const fonts of [
        { resolveFont: throwing(thrown) },
        withFont({ shape: throwing(thrown) }),
      ]) {
        const error = expectLayoutError(
          () => firstItem(text('t', 'a'), { fonts }),
          'FONT_UNAVAILABLE'
        );
        expect(
          `${error.message} ${error.stack} ${JSON.stringify(error)}`
        ).not.toContain('secret-marker');
      }
    }
  });

  it.each([
    ['LF3 unitsPerEm 0', { unitsPerEm: 0 }],
    ['a negative unitsPerEm', { unitsPerEm: -1000 }],
    ['LF4 NaN ascent', { ascent: NaN }],
    ['LF4 infinite descent', { descent: -Infinity }],
    ['LF4 NaN unitsPerEm', { unitsPerEm: NaN }],
    ['numeric text', { ascent: '800' }],
    ['no shape function', { shape: undefined }],
    ['an empty key', { key: '' }],
    ['a key with a control character', { key: 'Inter\u0000400' }],
    ['a key with a newline', { key: 'Inter\n400' }],
    ['a non-ASCII key', { key: 'Interé' }],
    ['a key above 256 characters', { key: 'k'.repeat(257) }],
    ['a numeric key', { key: 7 }],
  ])('%s is invalid', (_name, overrides) => {
    expectLayoutError(
      () => firstItem(text('t', 'a'), { fonts: withFont(overrides) }),
      'FONT_METRICS_INVALID'
    );
  });

  it.each([
    ['LF4 a NaN ascent', { ascent: NaN }],
    ['LF4 an infinite descent', { descent: Infinity }],
    ['LF3 unitsPerEm 0', { unitsPerEm: 0 }],
  ])('%s is refused even when no line would use it', (_name, overrides) => {
    expectLayoutError(
      () => firstItem(text('t', ''), { fonts: withFont(overrides) }),
      'FONT_METRICS_INVALID'
    );
  });

  it('refuses a provider result that is not an object', () => {
    expectLayoutError(
      () =>
        firstItem(text('t', 'a'), { fonts: { resolveFont: () => 'Inter' } }),
      'FONT_METRICS_INVALID'
    );
    const trap = {
      key: 'k',
      unitsPerEm: 1000,
      get ascent(): number {
        throw new Error(MARKER);
      },
      descent: 0,
      shape: fakeShape,
    };
    const error = expectLayoutError(
      () => firstItem(text('t', 'a'), { fonts: { resolveFont: () => trap } }),
      'FONT_METRICS_INVALID'
    );
    expect(error.message).not.toContain('secret');
  });

  const glyph = (extra: Plain) => ({
    shape: () => ({
      glyphs: [
        {
          id: 1,
          cluster: 0,
          xAdvance: 600,
          yAdvance: 0,
          xOffset: 0,
          yOffset: 0,
          ...extra,
        },
      ],
    }),
  });

  it.each([
    ['LF5 a negative glyph id', { id: -1 }],
    ['LF5 a fractional glyph id', { id: 1.5 }],
    ['LF5 a glyph id as text', { id: '1' }],
    ['LF6 an infinite advance', { xAdvance: Infinity }],
    ['LF6 a NaN advance', { xAdvance: NaN }],
    ['a NaN x offset', { xOffset: NaN }],
    ['an infinite y offset', { yOffset: -Infinity }],
    ['a NaN y advance', { yAdvance: NaN }],
    ['LF8 a negative cluster', { cluster: -1 }],
    ['LF8 a cluster past the text', { cluster: 1 }],
    ['a fractional cluster', { cluster: 0.5 }],
  ])('%s is invalid', (_name, extra) => {
    expectLayoutError(
      () => firstItem(text('t', 'a'), { fonts: withFont(glyph(extra)) }),
      'FONT_METRICS_INVALID'
    );
  });

  it.each([
    ['no glyph list', { shape: () => ({}) }],
    ['a glyph list that is not an array', { shape: () => ({ glyphs: 'a' }) }],
    ['a shape result that is not an object', { shape: () => null }],
    ['a glyph that is not an object', { shape: () => ({ glyphs: [1] }) }],
    ['a sparse glyph list', { shape: () => ({ glyphs: new Array(1) }) }],
  ])('refuses %s', (_name, overrides) => {
    expectLayoutError(
      () => firstItem(text('t', 'a'), { fonts: withFont(overrides) }),
      'FONT_METRICS_INVALID'
    );
  });

  it('LF7 refuses vertical advances as unsupported', () => {
    expectLayoutError(
      () =>
        firstItem(text('t', 'a'), { fonts: withFont(glyph({ yAdvance: 5 })) }),
      'FONT_SHAPING_UNSUPPORTED'
    );
  });

  it('LF9 allows repeated glyph ids and a text that shapes to no glyph', () => {
    expect(
      layoutText(text('t', 'aaa')).lines[0].glyphs.map((entry) => entry.id)
    ).toEqual([A, A, A]);
    const empty = layoutText(text('t', 'a'), {
      fonts: withFont({ shape: () => ({ glyphs: [] }) }),
    });
    expect(empty.lines[0]).toMatchObject({ text: 'a', width: 0, glyphs: [] });
  });

  it('fails instead of writing an overflowing number', () => {
    expectLayoutError(
      () =>
        firstItem(text('t', 'a', { fontSize: 1024 }), {
          fonts: withFont(glyph({ xAdvance: Number.MAX_VALUE })),
        }),
      'FONT_METRICS_INVALID'
    );
    expectLayoutError(
      () =>
        firstItem(text('t', 'a'), {
          fonts: withFont({ ascent: 1e308, unitsPerEm: 1e-300 }),
        }),
      'FONT_METRICS_INVALID'
    );
  });

  it('LF10 does not resolve the font of a hidden text layer', () => {
    const fonts = fakeFonts({});
    const output = run(
      design([
        page([
          text('hidden', 'a', {
            visible: false,
            font: { ...INTER, family: 'Missing' },
          }),
        ]),
      ]),
      { fonts }
    );
    expect(output.pages[0].items).toEqual([]);
    expect(fonts.requests).toEqual([]);
  });

  it('resolves each font once per layout, by family, weight and style', () => {
    const fonts = fakeFonts({
      'Inter|400|normal': {},
      'Inter|400|italic': {},
      'Poppins|700|normal': {},
    });
    run(
      design(
        [
          page([
            text('a', 'a'),
            text('b', 'b', { font: brand('body') }),
            text('c', 'c', { font: { ...INTER, style: 'italic' } }),
            text('d', 'd', { font: brand('heading') }),
          ]),
          page([text('e', 'e')], { id: 'page-2' }),
        ],
        REF
      ),
      { brandKit: CONTEXT, fonts }
    );
    expect(fonts.requests).toEqual([
      { family: 'Inter', weight: 400, style: 'normal' },
      { family: 'Inter', weight: 400, style: 'italic' },
      { family: 'Poppins', weight: 700, style: 'normal' },
    ]);
  });

  it('refuses one font key for two different fonts', () => {
    const fonts = fakeFonts({
      'Inter|400|normal': { key: 'same' },
      'Inter|700|normal': { key: 'same' },
    });
    expectLayoutError(
      () =>
        run(
          design([
            page([
              text('a', 'a'),
              text('b', 'b', { font: { ...INTER, weight: 700 } }),
            ]),
          ]),
          { fonts }
        ),
      'FONT_METRICS_INVALID'
    );
  });

  it('asks for exactly the resolved font, with no other field', () => {
    const fonts = fakeFonts();
    layoutText(text('t', 'a'), { fonts });
    expect(fonts.requests).toEqual([
      { family: 'Inter', weight: 400, style: 'normal' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The contract fixture: one page with everything
// ---------------------------------------------------------------------------

function goldenDocument(): ContentStudioDesignDocumentV1 {
  return design(
    [
      page(
        [
          rectangle('panel', {
            x: 40,
            y: 40,
            width: 1000,
            height: 400,
            fill: brand('accent'),
            cornerRadius: 24,
          }),
          ellipse('dot', {
            x: 900,
            y: 900,
            width: 120,
            height: 80,
            rotation: 15,
            opacity: 0.5,
            fill: literal('#00AAFF'),
          }),
          text('title', 'Hi', {
            x: 40,
            y: 40,
            width: 1000,
            height: 400,
            font: brand('heading'),
            color: brand('ink'),
            align: 'center',
            verticalAlign: 'middle',
          }),
          text('caption', 'aa aa', {
            x: 40,
            y: 500,
            width: 300,
            height: 60,
            color: literal('#333333'),
            align: 'right',
            verticalAlign: 'bottom',
            overflow: 'shrink',
          }),
          image('photo', {
            x: 40,
            y: 640,
            width: 400,
            height: 400,
            fit: 'contain',
            focalPoint: { x: 0.2, y: 0.8 },
          }),
          image('hero', {
            x: 480,
            y: 640,
            width: 400,
            height: 200,
            fit: 'cover',
            focalPoint: { x: 0.5, y: 0.6 },
            imageRef: { type: 'media', mediaId: 'hero-1', sha256: SHA_B },
          }),
          rectangle('draft', { visible: false, fill: brand('missing') }),
        ],
        { id: 'cover', background: { type: 'solid', color: brand('paper') } }
      ),
    ],
    REF
  );
}

const goldenFonts = () =>
  fakeFonts({ 'Inter|400|normal': {}, 'Poppins|700|normal': {} });

function goldenLayout() {
  return run(goldenDocument(), {
    brandKit: CONTEXT,
    fonts: goldenFonts(),
    images: fakeImages({
      [`photo-1:${SHA_A}`]: { width: 800, height: 400 },
      [`hero-1:${SHA_B}`]: { width: 1000, height: 1000 },
    }),
  });
}

describe('design layout: contract fixture', () => {
  it('lays out a whole page exactly', () => {
    const geometry = (
      x: number,
      y: number,
      width: number,
      height: number,
      rotation = 0,
      opacity = 1
    ) => ({
      box: { x, y, width, height },
      rotation,
      transformOrigin: { x: x + width / 2, y: y + height / 2 },
      opacity,
    });
    const glyph = (
      id: number,
      cluster: number,
      x: number,
      y: number,
      advance: number
    ) => ({ id, cluster, x, y, advance });
    expect(goldenLayout()).toStrictEqual({
      schemaVersion: 1,
      pages: [
        {
          id: 'cover',
          width: 1080,
          height: 1080,
          background: { type: 'solid', color: '#faf7f2' },
          clipRect: { x: 0, y: 0, width: 1080, height: 1080 },
          items: [
            {
              layerId: 'panel',
              type: 'rectangle',
              ...geometry(40, 40, 1000, 400),
              fill: '#e4572e',
              cornerRadius: 24,
            },
            {
              layerId: 'dot',
              type: 'ellipse',
              ...geometry(900, 900, 120, 80, 15, 0.5),
              fill: '#00aaff',
            },
            {
              layerId: 'title',
              type: 'text',
              ...geometry(40, 40, 1000, 400),
              clipRect: { x: 40, y: 40, width: 1000, height: 400 },
              font: { family: 'Poppins', weight: 700, style: 'normal' },
              fontKey: 'Poppins|700|normal',
              color: '#1a1a1a',
              requestedFontSize: 100,
              resolvedFontSize: 100,
              lineHeight: 1.2,
              letterSpacing: 0,
              align: 'center',
              verticalAlign: 'middle',
              overflow: 'clip',
              fits: true,
              lines: [
                {
                  text: 'Hi',
                  x: 497.5,
                  baselineY: 270,
                  width: 85,
                  glyphs: [
                    glyph(72, 0, 497.5, 270, 60),
                    glyph(105, 1, 557.5, 270, 25),
                  ],
                },
              ],
            },
            {
              layerId: 'caption',
              type: 'text',
              ...geometry(40, 500, 300, 60),
              clipRect: { x: 40, y: 500, width: 300, height: 60 },
              font: { family: 'Inter', weight: 400, style: 'normal' },
              fontKey: 'Inter|400|normal',
              color: '#333333',
              requestedFontSize: 100,
              resolvedFontSize: 50,
              lineHeight: 1.2,
              letterSpacing: 0,
              align: 'right',
              verticalAlign: 'bottom',
              overflow: 'shrink',
              fits: true,
              lines: [
                {
                  text: 'aa aa',
                  x: 205,
                  baselineY: 545,
                  width: 135,
                  glyphs: [
                    glyph(A, 0, 205, 545, 30),
                    glyph(A, 1, 235, 545, 30),
                    glyph(SPACE, 2, 265, 545, 15),
                    glyph(A, 3, 280, 545, 30),
                    glyph(A, 4, 310, 545, 30),
                  ],
                },
              ],
            },
            {
              layerId: 'photo',
              type: 'image',
              ...geometry(40, 640, 400, 400),
              imageRef: { mediaId: 'photo-1', sha256: SHA_A },
              intrinsic: { width: 800, height: 400 },
              fit: 'contain',
              sourceRect: { x: 0, y: 0, width: 800, height: 400 },
              destinationRect: { x: 40, y: 740, width: 400, height: 200 },
            },
            {
              layerId: 'hero',
              type: 'image',
              ...geometry(480, 640, 400, 200),
              imageRef: { mediaId: 'hero-1', sha256: SHA_B },
              intrinsic: { width: 1000, height: 1000 },
              fit: 'cover',
              sourceRect: { x: 0, y: 350, width: 1000, height: 500 },
              destinationRect: { x: 480, y: 640, width: 400, height: 200 },
            },
          ],
        },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

describe('design layout: boundaries', () => {
  const FILES = [
    'design.layout.ts',
    'design.layout.text.ts',
    'design.layout.types.ts',
  ];
  const sources = FILES.map((file) => [
    file,
    fs.readFileSync(path.join(__dirname, file), 'utf8'),
  ]);
  // code without comments, so the contract can describe what is not there
  const code = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const imports = (source: string) =>
    Array.from(source.matchAll(/from '([^']+)'/g), (match) => match[1]);

  it('imports only the design, Brand Kit and layout modules', () => {
    const allowed = [
      '@gitroom/nestjs-libraries/content-studio/brand/brand.kit',
      '@gitroom/nestjs-libraries/content-studio/brand/brand.kit.revision',
      '@gitroom/nestjs-libraries/content-studio/design/design.document',
      '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout.types',
      '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout.text',
    ];
    for (const [, source] of sources) {
      for (const specifier of imports(source)) {
        expect(allowed).toContain(specifier);
      }
    }
  });

  it.each([
    'fontkit',
    'sharp',
    'fabric',
    'canvas',
    'playwright',
    'puppeteer',
    'jsdom',
    'opentype',
    'linebreak',
    'grapheme',
    'axios',
    'undici',
    'node-fetch',
    'safe.fetch',
    'http',
    'https',
    'net',
    'dns',
    'fs',
    'path',
    'os',
    'child_process',
    'prisma',
    '@nestjs',
    'media',
    'ai/',
    'sources/',
  ])('never imports %s', (name) => {
    for (const [, source] of sources) {
      for (const specifier of imports(source)) {
        expect(
          specifier.replace('@gitroom/nestjs-libraries/content-studio/', '')
        ).not.toContain(name);
      }
      expect(source).not.toMatch(new RegExp(`require\\(\\s*['"]${name}`));
    }
  });

  it('uses no network, clock, randomness, environment, DOM or async code', () => {
    for (const [, source] of sources) {
      const body = code(source);
      for (const pattern of [
        /\bfetch\s*\(/,
        /\bXMLHttpRequest\b/,
        /\bWebSocket\b/,
        /\bprocess\./,
        /\bDate\b/,
        /\bperformance\b/,
        /Math\.random/,
        /randomUUID/,
        /\bIntl\b/,
        /toLocale/,
        /\bsetTimeout\b/,
        /\bPromise\b/,
        /\basync\b/,
        /\bawait\b/,
        /\brequire\s*\(/,
        /\bimport\s*\(/,
        /\bdocument\.createElement/,
        /\bwindow\b/,
        /\bglobalThis\b/,
        /\bBuffer\b/,
        /<svg|<\/|style=/i,
      ]) {
        expect(body).not.toMatch(pattern);
      }
    }
  });

  it('is not wired into the API, the database module or the frontend', () => {
    const root = path.join(__dirname, '../../../../../../');
    for (const file of [
      'apps/backend/src/api/routes/content-studio.controller.ts',
      'libraries/nestjs-libraries/src/database/prisma/database.module.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design.service.ts',
    ]) {
      expect(fs.readFileSync(path.join(root, file), 'utf8')).not.toContain(
        'design.layout'
      );
    }
    expect(
      fs.existsSync(
        path.join(
          root,
          'apps/backend/src/api/routes/content-studio.controller.ts'
        )
      )
    ).toBe(true);
  });
});
