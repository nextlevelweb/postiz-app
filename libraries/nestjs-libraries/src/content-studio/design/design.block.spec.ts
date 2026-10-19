import { parseContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioDesignBlockError,
  DESIGN_BLOCK_LAYERS_MAX,
  extractContentStudioDesignBlock,
  instantiateContentStudioDesignBlock,
  parseContentStudioDesignBlockContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.block';
import {
  ContentStudioDesignBlockIntegrityError,
  parseVerifiedContentStudioDesignBlock,
  storedContentStudioDesignBlock,
} from '@gitroom/nestjs-libraries/content-studio/design/design.block.stored';
import { listContentStudioSystemDesignLayoutPatterns } from '@gitroom/nestjs-libraries/content-studio/design/design.system.layout.patterns';

// Design Block v1 (P4-18), pure: the shared layer snapshot (Layout Pattern
// v1) as a reusable creative asset. Parsing, storage, extraction from a
// selection and placement on a page. No database, Brand Kit, Media or
// network

type Row = Record<string, any>;
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const lit = (value: string) => ({ type: 'literal', value });
const tok = (tokenId: string) => ({ type: 'brand', tokenId });
const base = {
  name: 'Layer',
  x: 0,
  y: 0,
  width: 400,
  height: 100,
  rotation: 0,
  opacity: 1,
  visible: true,
};
const text = (extra: Row = {}) => ({
  ...base,
  type: 'text',
  text: '  Buy now\n ',
  font: tok('heading'),
  fontSize: 48,
  lineHeight: 1.1,
  letterSpacing: 1.5,
  color: tok('ink'),
  align: 'center',
  verticalAlign: 'middle',
  overflow: 'shrink',
  ...extra,
});
const shape = (extra: Row = {}) => ({
  ...base,
  type: 'shape',
  shape: 'rectangle',
  fill: lit('#ff5500'),
  cornerRadius: 24,
  opacity: 0.9,
  ...extra,
});
const image = (extra: Row = {}) => ({
  ...base,
  type: 'image',
  imageRef: { type: 'media', mediaId: 'logo-1', sha256: SHA('a') },
  fit: 'contain',
  focalPoint: { x: 0.25, y: 0.75 },
  mask: { type: 'roundedRectangle', cornerRadius: 12 },
  rotation: 10,
  ...extra,
});
const block = (layers: Row[], extra: Row = {}) => ({
  schemaVersion: 1,
  width: 400,
  height: 300,
  layers,
  ...extra,
});
const parse = parseContentStudioDesignBlockContent;
const refused = (input: unknown, code = 'INVALID') => {
  let error: unknown;
  try {
    parse(input);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ContentStudioDesignBlockError);
  expect((error as { code: string }).code).toBe(code);
};
const withId = (id: string, layer: Row) => ({ ...layer, id });
const DOCUMENT = parseContentStudioDesignDocument({
  schemaVersion: 1,
  brandKit: {
    brandKitId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    revisionId: '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    revisionNumber: 1,
    contentHash: SHA('b'),
  },
  pages: [
    {
      id: 'p_one',
      name: 'Launch',
      width: 1080,
      height: 1080,
      background: { type: 'solid', color: lit('#ffffff') },
      layers: [
        withId('back', shape({ x: 100, y: 600, width: 500, height: 200 })),
        withId('other', shape({ x: 900, y: 50, width: 40, height: 40 })),
        withId('cta', text({ x: 150, y: 650, width: 400, height: 100 })),
        withId('logo', image({ x: 120, y: 820, width: 80, height: 80 })),
      ],
    },
  ],
});
const frozen = JSON.stringify(DOCUMENT);

// ============================================================================
describe('Design Block v1', () => {
  it('DBP1 a text block parses, keeping its text exactly and its Brand tokens', () => {
    const content = parse(block([text()]));
    expect(content.layers[0]).toMatchObject({
      text: '  Buy now\n ',
      font: tok('heading'),
      color: tok('ink'),
      fontSize: 48,
      lineHeight: 1.1,
      letterSpacing: 1.5,
      align: 'center',
      verticalAlign: 'middle',
    });
  });

  it('DBP2 a mixed text and shape block keeps its order', () => {
    expect(
      parse(block([shape(), text({ y: 40 })])).layers.map((l) => l.type)
    ).toEqual(['shape', 'text']);
  });

  it('DBP3/DBP4 an image block keeps its Media reference, fit, focal point and mask exactly', () => {
    expect(parse(block([image()])).layers[0]).toMatchObject({
      imageRef: { type: 'media', mediaId: 'logo-1', sha256: SHA('a') },
      fit: 'contain',
      focalPoint: { x: 0.25, y: 0.75 },
      mask: { type: 'roundedRectangle', cornerRadius: 12 },
      rotation: 10,
    });
  });

  it('DBP5 relative geometry is kept, fractions included', () => {
    expect(parse(block([shape({ x: 12.5, y: 7.25 })])).layers[0]).toMatchObject(
      {
        x: 12.5,
        y: 7.25,
      }
    );
  });

  it('DBP6/DBP7/DBP8 a layer id, a page, a document or any other top-level key is refused', () => {
    refused(block([{ ...text(), id: 'l_1' }]));
    for (const extra of [
      { pageId: 'p_one' },
      { pages: [] },
      { brandKit: null },
      { guidance: {} },
      { templateId: 't' },
      { layoutPatternId: 'x' },
      { stylePresetId: 'x' },
      { pageSetId: 'x' },
      { designBlockId: 'x' },
      { selection: [] },
    ]) {
      refused(block([text()], extra));
    }
  });

  it('DBP9 layer data Design Document v1 does not know is refused', () => {
    for (const layer of [
      { ...text(), stylePresetId: 'p' },
      { ...shape(), fabric: {} },
      { ...image(), imageRef: { type: 'url', url: 'https://x.test/a.png' } },
      { ...image(), url: 'https://x.test/a.png' },
      { ...shape(), type: 'group' },
    ]) {
      refused(block([layer]));
    }
  });

  it('DBP10 at most 50 layers', () => {
    refused(
      block(Array.from({ length: DESIGN_BLOCK_LAYERS_MAX + 1 }, () => shape()))
    );
    expect(
      parse(
        block(Array.from({ length: DESIGN_BLOCK_LAYERS_MAX }, () => shape()))
      ).layers
    ).toHaveLength(50);
  });

  it('DBP11 more than 512 KiB of content is TOO_LARGE', () => {
    const long = '€'.repeat(10_000);
    refused(
      block(Array.from({ length: 20 }, () => text({ text: long }))),
      'TOO_LARGE'
    );
  });

  it('DBP12/DBP13 canonical and deterministic; read back exactly or not at all', () => {
    const one = storedContentStudioDesignBlock(parse(block([shape(), text()])));
    expect(
      storedContentStudioDesignBlock(parse(block([shape(), text()])))
    ).toEqual(one);
    expect(one.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parseVerifiedContentStudioDesignBlock(one)).toEqual(
      parse(block([shape(), text()]))
    );
    expect(() =>
      parseVerifiedContentStudioDesignBlock({ ...one, contentHash: SHA('0') })
    ).toThrow(ContentStudioDesignBlockIntegrityError);
  });

  it('P418-15 the built-in layout pattern hashes are unchanged by sharing the format', () => {
    expect(
      listContentStudioSystemDesignLayoutPatterns().map(
        (entry) => entry.contentHash
      )
    ).toEqual([
      '94c4e33a9aea46630e86d586a188052b822bad1319476a2f0187b4c4d789051d',
      '26173ea86bca72f2d38a4fcd0492376d23f8a103ece07e9c922b3f4372ffebb8',
      'a71e20c7a3e1fe0d7f13fdc4b275643e95278356f6ff728f961cb2aae2d32f4f',
      'd46741df28af583f99b1d4ca135be898797952cbc727837637a1fdda399913d5',
      'd32031702101fa1a6ce7d876567c9acfdaaabac2ade1faff4d6971296e94ed63',
    ]);
  });
});

// ============================================================================
describe('Extraction from a selection', () => {
  const extract = () =>
    extractContentStudioDesignBlock(DOCUMENT, ['logo', 'cta', 'back'])!;

  it('DBE1/DBE2 the box is the selection bounds; positions are measured from it', () => {
    const content = extract();
    expect(content).toMatchObject({ width: 500, height: 300 });
    expect(content.layers.map((l) => [l.x, l.y])).toEqual([
      [0, 0],
      [50, 50],
      [20, 220],
    ]);
  });

  it('DBE3/DBE4/DBE11 no ids, page order kept, unselected layers absent', () => {
    const content = extract();
    expect(content.layers.map((l) => l.type)).toEqual([
      'shape',
      'text',
      'image',
    ]);
    for (const layer of content.layers) {
      expect(layer).not.toHaveProperty('id');
    }
    expect(JSON.stringify(content)).not.toMatch(/"other"|p_one|Launch/);
  });

  it('DBE5/DBE6/DBE9 text, style values and Brand tokens exactly', () => {
    const { id, x, y, ...cta } = DOCUMENT.pages[0].layers[2] as Row;
    void id;
    void x;
    void y;
    expect(extract().layers[1]).toEqual({ ...cta, x: 50, y: 50 });
  });

  it('DBE7/DBE8 the Media reference, mask, focal point and fit exactly', () => {
    expect(extract().layers[2]).toMatchObject({
      imageRef: { type: 'media', mediaId: 'logo-1', sha256: SHA('a') },
      fit: 'contain',
      focalPoint: { x: 0.25, y: 0.75 },
      mask: { type: 'roundedRectangle', cornerRadius: 12 },
    });
  });

  it('DBE10 the design is not changed', () => {
    const content = extract();
    (content.layers[2] as Row).focalPoint.x = 0;
    expect(JSON.stringify(DOCUMENT)).toBe(frozen);
  });

  it('placement centers the box with the ids it is given, as layout patterns do', () => {
    let n = 0;
    const layers = instantiateContentStudioDesignBlock(
      extract(),
      { width: 1080, height: 1080 },
      () => `l_b${++n}`
    );
    expect(layers.map((l) => [l.id, l.x, l.y])).toEqual([
      ['l_b1', 290, 390],
      ['l_b2', 340, 440],
      ['l_b3', 310, 610],
    ]);
  });
});
