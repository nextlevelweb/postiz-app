import { parseContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioDesignLayoutPatternError,
  DESIGN_LAYOUT_PATTERN_LAYERS_MAX,
  extractContentStudioDesignLayoutPattern,
  instantiateContentStudioDesignLayoutPattern,
  parseContentStudioDesignLayoutPatternContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.layout.pattern';
import {
  ContentStudioDesignLayoutPatternIntegrityError,
  parseVerifiedContentStudioDesignLayoutPattern,
  storedContentStudioDesignLayoutPattern,
} from '@gitroom/nestjs-libraries/content-studio/design/design.layout.pattern.stored';
import {
  buildContentStudioSystemDesignLayoutPatterns,
  ContentStudioSystemDesignLayoutPatternError,
  listContentStudioSystemDesignLayoutPatterns,
} from '@gitroom/nestjs-libraries/content-studio/design/design.system.layout.patterns';

// Layout Pattern v1 (P4-15), pure: parsing, extraction from a selection,
// instantiation on a page and the built-ins. No database, Brand Kit, Media
// or network

type Row = Record<string, any>;
const lit = (value: string) => ({ type: 'literal', value });
const base = {
  name: 'Layer',
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  rotation: 0,
  opacity: 1,
  visible: true,
};
const text = (extra: Row = {}) => ({
  ...base,
  type: 'text',
  text: 'Hello',
  font: { type: 'family', family: '  Inter ', weight: 700, style: 'normal' },
  fontSize: 40,
  lineHeight: 1.2,
  letterSpacing: 0,
  color: lit('#AABBCC'),
  align: 'left',
  verticalAlign: 'top',
  overflow: 'clip',
  ...extra,
});
const shape = (extra: Row = {}) => ({
  ...base,
  type: 'shape',
  shape: 'rectangle',
  fill: { type: 'brand', tokenId: 'primary' },
  cornerRadius: 12,
  ...extra,
});
const image = (extra: Row = {}) => ({
  ...base,
  type: 'image',
  imageRef: { type: 'media', mediaId: 'm1', sha256: 'a'.repeat(64) },
  fit: 'contain',
  focalPoint: { x: 0.2, y: 0.8 },
  mask: { type: 'roundedRectangle', cornerRadius: 16 },
  ...extra,
});
const pattern = (extra: Row = {}) => ({
  schemaVersion: 1,
  width: 400,
  height: 300,
  layers: [shape(), text({ x: 20, y: 40 }), image({ x: 100, y: 150 })],
  ...extra,
});
const parse = parseContentStudioDesignLayoutPatternContent;
const refused = (input: unknown, code = 'INVALID') => {
  let error: unknown;
  try {
    parse(input);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ContentStudioDesignLayoutPatternError);
  expect((error as ContentStudioDesignLayoutPatternError).code).toBe(code);
};

const withId = (id: string, layer: Row) => ({ ...layer, id });
const DOCUMENT = parseContentStudioDesignDocument({
  schemaVersion: 1,
  brandKit: {
    brandKitId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    revisionId: '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    revisionNumber: 1,
    contentHash: 'b'.repeat(64),
  },
  pages: [
    {
      id: 'p1',
      name: '',
      width: 1080,
      height: 1080,
      background: { type: 'solid', color: lit('#ffffff') },
      layers: [
        withId('back', shape({ x: 100, y: 200, width: 300, height: 200 })),
        withId(
          'title',
          text({ x: 150.5, y: 250, width: 400, height: 80, rotation: 30 })
        ),
        withId('other', shape({ x: 900, y: 900, width: 50, height: 50 })),
        withId('photo', image({ x: 120, y: 500, visible: false })),
      ],
    },
    {
      id: 'p2',
      name: '',
      width: 1080,
      height: 1080,
      background: { type: 'solid', color: lit('#ffffff') },
      layers: [withId('elsewhere', shape())],
    },
  ],
});
const frozen = JSON.stringify(DOCUMENT);

// ============================================================================
describe('Layout Pattern v1', () => {
  it('LP1 parses and normalizes as Design Document v1 does, into a new object', () => {
    const input = pattern();
    const before = JSON.stringify(input);
    const content = parse(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(content).toEqual({
      schemaVersion: 1,
      width: 400,
      height: 300,
      layers: [
        shape(),
        text({
          x: 20,
          y: 40,
          font: {
            type: 'family',
            family: 'Inter',
            weight: 700,
            style: 'normal',
          },
          color: lit('#aabbcc'),
        }),
        image({ x: 100, y: 150 }),
      ],
    });
    expect(content.layers[0]).not.toBe(input.layers[0]);
  });

  it('LP2 keeps fit, focal point, mask, Media reference and Brand tokens as they are', () => {
    const content = parse(pattern());
    expect(content.layers[2]).toMatchObject({
      imageRef: { type: 'media', mediaId: 'm1', sha256: 'a'.repeat(64) },
      fit: 'contain',
      focalPoint: { x: 0.2, y: 0.8 },
      mask: { type: 'roundedRectangle', cornerRadius: 16 },
    });
    expect(content.layers[0]).toMatchObject({
      fill: { type: 'brand', tokenId: 'primary' },
    });
  });

  it('LP3 refuses anything that is not a plain object with exactly the four keys', () => {
    for (const input of [
      null,
      undefined,
      'pattern',
      [],
      { ...pattern(), extra: 1 },
      { ...pattern(), pages: [] },
      { ...pattern(), brandKit: null },
      { ...pattern(), guidance: {} },
      { schemaVersion: 1, width: 400, height: 300 },
    ]) {
      refused(input);
    }
  });

  it('LP4 refuses another schema version', () => {
    for (const schemaVersion of [0, 2, '1', null]) {
      refused(pattern({ schemaVersion }));
    }
  });

  it('LP5 refuses a box that is not a positive finite size within the limits', () => {
    for (const size of [0, -1, NaN, Infinity, 32_769, '400', null]) {
      refused(pattern({ width: size }));
      refused(pattern({ height: size }));
    }
    expect(parse(pattern({ width: 0.5, height: 32_768 })).width).toBe(0.5);
  });

  it('LP6 refuses no layers, too many layers, or layers that are not a list', () => {
    refused(pattern({ layers: [] }));
    refused(pattern({ layers: {} }));
    refused(
      pattern({
        layers: Array.from(
          { length: DESIGN_LAYOUT_PATTERN_LAYERS_MAX + 1 },
          () => shape()
        ),
      })
    );
    expect(
      parse(
        pattern({
          layers: Array.from({ length: DESIGN_LAYOUT_PATTERN_LAYERS_MAX }, () =>
            shape()
          ),
        })
      ).layers
    ).toHaveLength(DESIGN_LAYOUT_PATTERN_LAYERS_MAX);
  });

  it('LP7 refuses a layer that names an id: a pattern has no layer identity', () => {
    refused(pattern({ layers: [{ ...shape(), id: 'l_1' }] }));
    refused(pattern({ layers: [{ ...shape(), id: undefined }] }));
  });

  it('LP8 refuses a layer that Design Document v1 refuses', () => {
    for (const layer of [
      { ...shape(), type: 'group' },
      { ...shape(), extra: true },
      { ...shape(), x: 40_000 },
      { ...shape(), fill: lit('red') },
      { ...text(), fontSize: 0 },
      { ...image(), imageRef: { type: 'url', url: 'https://x.test/a.png' } },
      { ...image(), mask: { type: 'path', d: 'M0 0' } },
      { ...shape(), constraints: { left: true } },
    ]) {
      refused(pattern({ layers: [layer] }));
    }
  });

  it('LP9 refuses non-plain data (prototypes, functions, getters)', () => {
    class Box {
      schemaVersion = 1;
      width = 1;
      height = 1;
      layers = [shape()];
    }
    refused(new Box());
    refused(pattern({ layers: [{ ...shape(), toJSON: () => ({}) }] }));
  });

  it('LP10 refuses content larger than 512 KiB as TOO_LARGE', () => {
    // within the document's text limits (200 000 characters), but three
    // UTF-8 bytes each
    const long = '€'.repeat(10_000);
    refused(
      pattern({
        layers: Array.from({ length: 20 }, () => text({ text: long })),
      }),
      'TOO_LARGE'
    );
    expect(
      parse(
        pattern({
          layers: Array.from({ length: 17 }, () => text({ text: long })),
        })
      ).layers
    ).toHaveLength(17);
  });

  it('LP11 stores canonical JSON and its SHA-256; layer order is part of it', () => {
    const one = storedContentStudioDesignLayoutPattern(parse(pattern()));
    const again = storedContentStudioDesignLayoutPattern(parse(pattern()));
    expect(one).toEqual(again);
    expect(one.schemaVersion).toBe(1);
    expect(one.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const reordered = pattern();
    reordered.layers.reverse();
    expect(
      storedContentStudioDesignLayoutPattern(parse(reordered)).contentHash
    ).not.toBe(one.contentHash);
  });

  it('LP12 reading back proves the row is exactly what was written', () => {
    const stored = storedContentStudioDesignLayoutPattern(parse(pattern()));
    expect(parseVerifiedContentStudioDesignLayoutPattern(stored)).toEqual(
      parse(pattern())
    );
    for (const row of [
      { ...stored, contentHash: '0'.repeat(64) },
      { ...stored, schemaVersion: 2 },
      { ...stored, content: JSON.stringify(parse(pattern()), null, 2) },
      { ...stored, content: '{' },
      {
        ...stored,
        content: stored.content.replace('"width":400', '"width":401'),
      },
    ]) {
      expect(() => parseVerifiedContentStudioDesignLayoutPattern(row)).toThrow(
        ContentStudioDesignLayoutPatternIntegrityError
      );
    }
  });
});

// ============================================================================
describe('Built-in layout patterns', () => {
  const all = listContentStudioSystemDesignLayoutPatterns();

  it('LP13 a few valid patterns with stable unique ids, no Media and no Brand Kit', () => {
    expect(all.map((entry) => entry.id)).toEqual([
      'system:layout-title-body',
      'system:layout-title-subtitle-body',
      'system:layout-two-column-text',
      'system:layout-quote',
      'system:layout-callout-card',
    ]);
    for (const entry of all) {
      expect(parse(entry.content)).toEqual(entry.content);
      expect(entry.name).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(JSON.stringify(entry.content)).not.toMatch(
        /tokenId|brand|media|imageRef/
      );
    }
  });

  it('LP14 hashes are canonical and pinned: a change needs a deliberate update', () => {
    for (const entry of all) {
      expect(entry.contentHash).toBe(
        storedContentStudioDesignLayoutPattern(entry.content).contentHash
      );
    }
    expect(all.map((entry) => `${entry.id}:${entry.contentHash}`)).toEqual(
      PINNED
    );
  });

  it('LP15 every caller gets its own copy; an invalid, duplicate, Brand or Media built-in fails loudly', () => {
    (listContentStudioSystemDesignLayoutPatterns()[0].content as Row).width = 1;
    expect(listContentStudioSystemDesignLayoutPatterns()[0].content.width).toBe(
      840
    );
    const good = {
      id: 'system:a',
      name: 'A',
      description: 'A',
      content: all[0].content,
    };
    expect(buildContentStudioSystemDesignLayoutPatterns([good])).toHaveLength(
      1
    );
    for (const definitions of [
      [good, { ...good }],
      [{ ...good, id: 'a' }],
      [{ ...good, name: '' }],
      [{ ...good, content: { ...all[0].content, width: 0 } }],
      [{ ...good, content: pattern({ layers: [shape()] }) }],
      [
        {
          ...good,
          content: pattern({ layers: [image({ mask: undefined })] }),
        },
      ],
      [
        {
          ...good,
          content: pattern({
            layers: [text({ font: { type: 'brand', tokenId: 'heading' } })],
          }),
        },
      ],
    ]) {
      expect(() =>
        buildContentStudioSystemDesignLayoutPatterns(definitions as never)
      ).toThrow(ContentStudioSystemDesignLayoutPatternError);
    }
  });
});

// ============================================================================
describe('Extraction from a selection', () => {
  const extract = (ids: string[]) =>
    extractContentStudioDesignLayoutPattern(DOCUMENT, ids);

  it('LE1 the box is the bounds of the stored boxes; x and y are measured from it', () => {
    const content = extract(['title', 'back'])!;
    expect(content).toMatchObject({
      schemaVersion: 1,
      width: 450.5,
      height: 200,
    });
    expect(content.layers.map((l) => [l.x, l.y])).toEqual([
      [0, 0],
      [50.5, 50],
    ]);
  });

  it('LE2 layers keep the page order (back to front), whatever the selection order', () => {
    expect(
      extract(['photo', 'title', 'back'])!.layers.map((l) => l.type)
    ).toEqual(['shape', 'text', 'image']);
  });

  it('LE3 no layer keeps its id', () => {
    for (const layer of extract(['back', 'title', 'photo'])!.layers) {
      expect(layer).not.toHaveProperty('id');
    }
  });

  it('LE4 everything else is copied exactly: rotation, visibility, style, Brand tokens, Media, fit, focal point and mask', () => {
    const [back, title, photo] = extract(['back', 'title', 'photo'])!
      .layers as Row[];
    const source = DOCUMENT.pages[0].layers;
    const { id: _b, x: _bx, y: _by, ...backRest } = source[0] as Row;
    const { id: _t, x: _tx, y: _ty, ...titleRest } = source[1] as Row;
    const { id: _p, x: _px, y: _py, ...photoRest } = source[3] as Row;
    expect(back).toMatchObject(backRest);
    expect(title).toMatchObject(titleRest);
    expect(title.rotation).toBe(30);
    expect(photo).toMatchObject(photoRest);
    expect(photo.visible).toBe(false);
  });

  it('LE5 a rotated layer is measured by its stored, unrotated box', () => {
    const content = extract(['title'])!;
    expect(content).toMatchObject({ width: 400, height: 80 });
    expect(content.layers[0]).toMatchObject({ x: 0, y: 0, rotation: 30 });
  });

  it('LE6 the result is a deep copy: the document stays as it was', () => {
    const content = extract(['photo'])!;
    (content.layers[0] as Row).focalPoint.x = 0.9;
    expect(JSON.stringify(DOCUMENT)).toBe(frozen);
  });

  it('LE7 the extracted content parses as Layout Pattern v1 unchanged', () => {
    const content = extract(['back', 'title', 'photo'])!;
    expect(parse(content)).toEqual(content);
  });

  it('LE8 null for no ids, an unknown id or a repeated id', () => {
    expect(extract([])).toBeNull();
    expect(extract(['missing'])).toBeNull();
    expect(extract(['back', 'missing'])).toBeNull();
    expect(extract(['back', 'back'])).toBeNull();
  });

  it('LE9 null for layers of two pages', () => {
    expect(extract(['back', 'elsewhere'])).toBeNull();
  });

  it('LE10 null for more layers than a pattern holds', () => {
    const many = parseContentStudioDesignDocument({
      ...DOCUMENT,
      pages: [
        {
          ...DOCUMENT.pages[0],
          layers: Array.from({ length: 51 }, (_, i) =>
            withId(`l${i}`, shape())
          ),
        },
      ],
    });
    const ids = many.pages[0].layers.map((l) => l.id);
    expect(extractContentStudioDesignLayoutPattern(many, ids)).toBeNull();
    expect(
      extractContentStudioDesignLayoutPattern(many, ids.slice(0, 50))!.layers
    ).toHaveLength(50);
  });

  it('LE11 -0 is stored as 0', () => {
    const zero = parseContentStudioDesignDocument({
      ...DOCUMENT,
      pages: [
        { ...DOCUMENT.pages[0], layers: [withId('z', shape({ x: -0 }))] },
      ],
    });
    const content = extractContentStudioDesignLayoutPattern(zero, ['z'])!;
    expect(Object.is(content.layers[0].x, 0)).toBe(true);
    expect(Object.is(content.layers[0].y, 0)).toBe(true);
  });
});

// ============================================================================
describe('Instantiation on a page', () => {
  let n = 0;
  const id = () => `l_new${++n}`;
  beforeEach(() => {
    n = 0;
  });

  it('LI1 the box is centered on the page; relative places stay', () => {
    const layers = instantiateContentStudioDesignLayoutPattern(
      parse(pattern()),
      { width: 1080, height: 1350 },
      id
    );
    expect(layers.map((l) => [l.x, l.y])).toEqual([
      [340, 525],
      [360, 565],
      [440, 675],
    ]);
  });

  it('LI2 every layer gets the id it is given, in the pattern order', () => {
    const layers = instantiateContentStudioDesignLayoutPattern(
      parse(pattern()),
      { width: 1080, height: 1080 },
      id
    );
    expect(layers.map((l) => [l.id, l.type])).toEqual([
      ['l_new1', 'shape'],
      ['l_new2', 'text'],
      ['l_new3', 'image'],
    ]);
  });

  it('LI3 a box larger than the page is centered too (negative corner)', () => {
    const layers = instantiateContentStudioDesignLayoutPattern(
      parse(pattern({ width: 2000, height: 100, layers: [shape()] })),
      { width: 1000, height: 1000 },
      id
    );
    expect(layers[0]).toMatchObject({ x: -500, y: 450 });
  });

  it('LI4 the layers are deep copies and the pattern stays as it was', () => {
    const content = parse(pattern());
    const before = JSON.stringify(content);
    const layers = instantiateContentStudioDesignLayoutPattern(
      content,
      { width: 1080, height: 1080 },
      id
    );
    (layers[2] as Row).focalPoint.x = 0.1;
    (layers[2] as Row).mask.cornerRadius = 1;
    expect(JSON.stringify(content)).toBe(before);
  });

  it('LI5 the instantiated layers form a valid Design Document v1 page', () => {
    const layers = instantiateContentStudioDesignLayoutPattern(
      parse(pattern()),
      { width: 1080, height: 1080 },
      id
    );
    expect(() =>
      parseContentStudioDesignDocument({
        ...DOCUMENT,
        pages: [{ ...DOCUMENT.pages[0], layers }],
      })
    ).not.toThrow();
  });
});

// pinned: a change to a built-in pattern is a deliberate update here
const PINNED = [
  'system:layout-title-body:94c4e33a9aea46630e86d586a188052b822bad1319476a2f0187b4c4d789051d',
  'system:layout-title-subtitle-body:26173ea86bca72f2d38a4fcd0492376d23f8a103ece07e9c922b3f4372ffebb8',
  'system:layout-two-column-text:a71e20c7a3e1fe0d7f13fdc4b275643e95278356f6ff728f961cb2aae2d32f4f',
  'system:layout-quote:d46741df28af583f99b1d4ca135be898797952cbc727837637a1fdda399913d5',
  'system:layout-callout-card:d32031702101fa1a6ce7d876567c9acfdaaabac2ade1faff4d6971296e94ed63',
];
