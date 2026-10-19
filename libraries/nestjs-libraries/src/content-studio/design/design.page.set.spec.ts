import { parseContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioDesignPageSetError,
  DESIGN_CANVAS_PRESETS,
  extractContentStudioDesignPageSet,
  instantiateContentStudioDesignPageSet,
  parseContentStudioDesignPageSetContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.page.set';
import {
  ContentStudioDesignPageSetIntegrityError,
  parseVerifiedContentStudioDesignPageSet,
  storedContentStudioDesignPageSet,
} from '@gitroom/nestjs-libraries/content-studio/design/design.page.set.stored';
import {
  buildContentStudioSystemDesignPageSets,
  ContentStudioSystemDesignPageSetError,
  getContentStudioSystemDesignPageSet,
  listContentStudioSystemDesignPageSets,
} from '@gitroom/nestjs-libraries/content-studio/design/design.system.page.sets';

// Page Set v1 (P4-17), pure: parsing, storage, the built-ins, extraction
// from a design and instantiation as blank pages. No database, Brand Kit,
// Media or network

type Row = Record<string, any>;
const lit = (value: string) => ({ type: 'literal', value });
const tok = (tokenId: string) => ({ type: 'brand', tokenId });
const solid = (color: Row) => ({ type: 'solid', color });
const page = (
  name: string,
  width: number,
  height: number,
  extra: Row = {}
) => ({
  name,
  width,
  height,
  ...extra,
});
const set = (pages: Row[]) => ({ schemaVersion: 1, pages });
const parse = parseContentStudioDesignPageSetContent;
const refused = (input: unknown, code = 'INVALID') => {
  let error: unknown;
  try {
    parse(input);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ContentStudioDesignPageSetError);
  expect((error as ContentStudioDesignPageSetError).code).toBe(code);
};

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
      id: 'p_cover',
      name: 'Cover',
      width: 1080,
      height: 1350,
      background: solid(lit('#ffeedd')),
      layers: [
        {
          id: 'photo',
          name: 'Photo',
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
            mediaId: 'media-1',
            sha256: 'a'.repeat(64),
          },
          fit: 'cover',
          focalPoint: { x: 0.5, y: 0.5 },
        },
      ],
    },
    {
      id: 'p_brand',
      name: '',
      width: 1080,
      height: 1920,
      background: solid(tok('primary')),
      layers: [],
    },
  ],
});
const frozen = JSON.stringify(DOCUMENT);

// ============================================================================
describe('Page Set v1', () => {
  it('PS1 a one-page set parses into a new object', () => {
    const input = set([page('Square', 1080, 1080)]);
    const before = JSON.stringify(input);
    const content = parse(input);
    expect(content).toEqual(input);
    expect(content).not.toBe(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('PS2/PS3 several pages keep their order; names are trimmed, colors lowercased', () => {
    expect(
      parse(
        set([
          page('  Story ', 1080, 1920),
          page('Square', 1080, 1080, { background: solid(lit('#AABBCC')) }),
          page('', 1200, 628),
        ])
      )
    ).toEqual(
      set([
        page('Story', 1080, 1920),
        page('Square', 1080, 1080, { background: solid(lit('#aabbcc')) }),
        page('', 1200, 628),
      ])
    );
  });

  it('PS4 sizes follow Design Document v1: integers 64..8192 within the area limit', () => {
    for (const [width, height] of [
      [63, 1080],
      [1080, 8193],
      [1080.5, 1080],
      [8192, 8192],
      [Number.NaN, 1080],
    ]) {
      refused(set([page('x', width, height)]));
    }
    refused(set([page('x', '1080' as never, 1080)]));
    expect(parse(set([page('x', 64, 8192)])).pages[0].width).toBe(64);
  });

  it('PS5 names follow Design Document v1: at most 100 characters, text only', () => {
    refused(set([page('n'.repeat(101), 1080, 1080)]));
    refused(set([page(1 as never, 1080, 1080)]));
    expect(
      parse(set([page('n'.repeat(100), 1080, 1080)])).pages[0].name
    ).toHaveLength(100);
  });

  it('PS6/PS7/PS10 a page with an id, layers or any other key is refused', () => {
    for (const extra of [
      { id: 'p_1' },
      { layers: [] },
      { guidance: {} },
      { templateId: 't' },
      { patternId: 'x' },
      { platform: 'instagram' },
      { sourcePageId: 'p' },
    ]) {
      refused(set([page('x', 1080, 1080, extra)]));
    }
    for (const input of [
      { ...set([page('x', 1080, 1080)]), brandKit: null },
      { ...set([page('x', 1080, 1080)]), campaignId: 'c' },
      { pages: [page('x', 1080, 1080)] },
      { ...set([page('x', 1080, 1080)]), schemaVersion: 2 },
      [page('x', 1080, 1080)],
      null,
      'pages',
    ]) {
      refused(input);
    }
    refused(set([{ name: 'x', width: 1080 }]));
  });

  it('PS8 a Brand Kit color as background is refused', () => {
    refused(
      set([page('x', 1080, 1080, { background: solid(tok('primary')) })])
    );
  });

  it('PS9 Media in any form is refused', () => {
    for (const background of [
      {
        type: 'image',
        imageRef: { type: 'media', mediaId: 'm', sha256: 'a'.repeat(64) },
      },
      { type: 'solid', color: lit('url(https://x.test/a.png)') },
      { ...solid(lit('#ffffff')), mediaId: 'm' },
    ]) {
      refused(set([page('x', 1080, 1080, { background })]));
    }
  });

  it('PS11/PS12 1 to 25 pages', () => {
    refused(set([]));
    refused(set(Array.from({ length: 26 }, () => page('x', 64, 64))));
    expect(
      parse(set(Array.from({ length: 25 }, () => page('x', 64, 64)))).pages
    ).toHaveLength(25);
  });

  it('the 64 KiB limit is a backstop the largest valid set stays under; non-plain data is refused', () => {
    // 25 pages with 100-character names of 4-byte characters and backgrounds
    const largest = parse(
      set(
        Array.from({ length: 25 }, () =>
          page('😀'.repeat(50), 8192, 4096, {
            background: solid(lit('#ffffff')),
          })
        )
      )
    );
    expect(
      new TextEncoder().encode(JSON.stringify(largest)).length
    ).toBeLessThan(65_536 / 4);
    class Pages {
      schemaVersion = 1;
      pages = [page('x', 1080, 1080)];
    }
    refused(new Pages());
  });

  it('PS13/PS14/PS15 canonical, deterministic hash; key order does not matter, page order does', () => {
    const one = storedContentStudioDesignPageSet(
      parse(set([page('A', 1080, 1080), page('B', 1080, 1350)]))
    );
    const reordered = storedContentStudioDesignPageSet(
      parse({
        pages: [
          { height: 1080, width: 1080, name: 'A' },
          { width: 1080, name: 'B', height: 1350 },
        ],
        schemaVersion: 1,
      })
    );
    expect(reordered).toEqual(one);
    expect(one.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(one.content).toBe(
      '{"pages":[{"height":1080,"name":"A","width":1080},{"height":1350,"name":"B","width":1080}],"schemaVersion":1}'
    );
    const swapped = storedContentStudioDesignPageSet(
      parse(set([page('B', 1080, 1350), page('A', 1080, 1080)]))
    );
    expect(swapped.contentHash).not.toBe(one.contentHash);
  });

  it('PSSEC10 a stored row that is not exactly what was written fails closed', () => {
    const stored = storedContentStudioDesignPageSet(
      parse(set([page('A', 1080, 1080)]))
    );
    expect(parseVerifiedContentStudioDesignPageSet(stored)).toEqual(
      set([page('A', 1080, 1080)])
    );
    for (const row of [
      { ...stored, contentHash: '0'.repeat(64) },
      { ...stored, schemaVersion: 2 },
      { ...stored, content: stored.content.replace('1080', '1081') },
      { ...stored, content: '{' },
      {
        ...stored,
        content: JSON.stringify(set([page('A', 1080, 1080)]), null, 1),
      },
    ]) {
      expect(() => parseVerifiedContentStudioDesignPageSet(row)).toThrow(
        ContentStudioDesignPageSetIntegrityError
      );
    }
  });
});

// ============================================================================
describe('Built-in page sets', () => {
  // read in a hook: an invalid built-in fails every test here, loudly
  let all: ReturnType<typeof listContentStudioSystemDesignPageSets>;
  beforeAll(() => {
    all = listContentStudioSystemDesignPageSets();
  });
  const sizes = (id: string) =>
    all
      .find((entry) => entry.id === id)!
      .content.pages.map((p) => `${p.name} ${p.width}x${p.height}`);

  it('PB1/PB2 a few valid page sets with stable unique ids', () => {
    expect(all.map((entry) => entry.id)).toEqual([
      'system:page-set-social-core',
      'system:page-set-social-full',
      'system:page-set-square-portrait',
      'system:page-set-square-story',
    ]);
    for (const entry of all) {
      expect(parse(entry.content)).toEqual(entry.content);
      expect(entry.name).toBeTruthy();
      expect(entry.description).toBeTruthy();
    }
  });

  it('PB3 hashes are canonical and pinned: a change needs a deliberate update', () => {
    for (const entry of all) {
      expect(entry.contentHash).toBe(
        storedContentStudioDesignPageSet(entry.content).contentHash
      );
    }
    expect(all.map((entry) => `${entry.id}:${entry.contentHash}`)).toEqual(
      PINNED
    );
  });

  it('PB4/PB5 Social core and Social full in their exact order', () => {
    expect(sizes('system:page-set-social-core')).toEqual([
      'Square 1080x1080',
      'Portrait 1080x1350',
      'Story 1080x1920',
    ]);
    expect(sizes('system:page-set-social-full')).toEqual([
      'Square 1080x1080',
      'Portrait 1080x1350',
      'Story 1080x1920',
      'Landscape 1200x628',
    ]);
    expect(sizes('system:page-set-square-portrait')).toEqual([
      'Square 1080x1080',
      'Portrait 1080x1350',
    ]);
    expect(sizes('system:page-set-square-story')).toEqual([
      'Square 1080x1080',
      'Story 1080x1920',
    ]);
  });

  it('PB6 every page is one of the canvas presets, named after it', () => {
    for (const entry of all) {
      for (const p of entry.content.pages) {
        expect(DESIGN_CANVAS_PRESETS).toContainEqual(
          expect.objectContaining({
            label: p.name,
            width: p.width,
            height: p.height,
          })
        );
      }
    }
  });

  it('PB7/PB8/PB9 no Media, Brand Kit, layers or background', () => {
    for (const entry of all) {
      expect(JSON.stringify(entry.content)).not.toMatch(
        /media|sha256|brand|token|layers|background|"id"/i
      );
    }
  });

  it('every caller gets its own copy; an invalid or duplicate built-in fails loudly', () => {
    (
      listContentStudioSystemDesignPageSets()[0].content.pages[0] as Row
    ).width = 1;
    expect(
      listContentStudioSystemDesignPageSets()[0].content.pages[0].width
    ).toBe(1080);
    expect(
      getContentStudioSystemDesignPageSet('system:page-set-social-core')!
        .content.pages
    ).toHaveLength(3);
    expect(getContentStudioSystemDesignPageSet('system:nope')).toBeNull();
    const good = {
      id: 'system:a',
      name: 'A',
      description: 'A',
      content: all[0].content,
    };
    expect(buildContentStudioSystemDesignPageSets([good])).toHaveLength(1);
    for (const definitions of [
      [good, { ...good }],
      [{ ...good, id: 'a' }],
      [{ ...good, name: '' }],
      [{ ...good, content: set([]) }],
      [{ ...good, content: set([page('x', 1080, 1080, { layers: [] })]) }],
    ]) {
      expect(() =>
        buildContentStudioSystemDesignPageSets(definitions as never)
      ).toThrow(ContentStudioSystemDesignPageSetError);
    }
  });
});

// ============================================================================
describe('Extraction from a design', () => {
  const content = () => extractContentStudioDesignPageSet(DOCUMENT);

  it('PE1/PE2/PE3 every page in order, exact names and sizes', () => {
    expect(content().pages.map((p) => [p.name, p.width, p.height])).toEqual([
      ['Cover', 1080, 1350],
      ['', 1080, 1920],
    ]);
  });

  it('PE4/PE5/PE6/PE7 no page id, layer, Media, Brand Kit or design name', () => {
    const text = JSON.stringify(content());
    expect(text).not.toMatch(
      /p_cover|p_brand|layers|photo|media|sha256|brand|token|primary/i
    );
    expect(Object.keys(content()).sort()).toEqual(['pages', 'schemaVersion']);
  });

  it('a literal background is kept; a Brand Kit background is left out', () => {
    expect(content().pages[0].background).toEqual(solid(lit('#ffeedd')));
    expect(content().pages[1]).not.toHaveProperty('background');
  });

  it('PE8 the design is not changed, and the result parses as Page Set v1 unchanged', () => {
    const extracted = content();
    (extracted.pages[0].background as Row).color.value = '#000000';
    expect(JSON.stringify(DOCUMENT)).toBe(frozen);
    expect(parse(content())).toEqual(content());
  });
});

// ============================================================================
describe('Instantiation', () => {
  // not the same read backwards: the order shows
  const recipe = () =>
    parse(
      set([
        page('Square', 1080, 1080),
        page('Story', 1080, 1920, { background: solid(lit('#123456')) }),
        page('Portrait', 1080, 1350),
      ])
    );

  let n = 0;
  const id = () => `p_new${++n}`;
  beforeEach(() => {
    n = 0;
  });

  it('PI1/PI2/PI3/PI4/PI5 one blank page per entry, in order, with the given ids, names and sizes', () => {
    expect(instantiateContentStudioDesignPageSet(recipe(), id)).toEqual([
      {
        id: 'p_new1',
        name: 'Square',
        width: 1080,
        height: 1080,
        background: solid(lit('#ffffff')),
        layers: [],
      },
      {
        id: 'p_new2',
        name: 'Story',
        width: 1080,
        height: 1920,
        background: solid(lit('#123456')),
        layers: [],
      },
      {
        id: 'p_new3',
        name: 'Portrait',
        width: 1080,
        height: 1350,
        background: solid(lit('#ffffff')),
        layers: [],
      },
    ]);
  });

  it('PI6 the page set is not changed', () => {
    const content = recipe();
    const before = JSON.stringify(content);
    const pages = instantiateContentStudioDesignPageSet(content, id);
    (pages[1].background.color as Row).value = '#000000';
    expect(JSON.stringify(content)).toBe(before);
  });

  it('PI7/PI8 the pages form a valid Design Document v1 with nothing of the page set', () => {
    const document = {
      schemaVersion: 1,
      brandKit: null,
      pages: instantiateContentStudioDesignPageSet(recipe(), id),
    };
    expect(parseContentStudioDesignDocument(document)).toEqual(document);
    expect(JSON.stringify(document)).not.toMatch(/pageSet|system:|recipe/i);
  });
});

// pinned: a change to a built-in page set is a deliberate update here
const PINNED = [
  'system:page-set-social-core:8e3663b4945274e394ea8577ce8f6893b22ac45f488f76aa9fa8d4990d27e48a',
  'system:page-set-social-full:ab2cbbadf8090254273664f8c90a86e27b490c7e8b0e8736e4002144f7144115',
  'system:page-set-square-portrait:a6d1e6a8bc67efa50d10c5a37f4297b54c82429b22bb21116c2a6365b0596dde',
  'system:page-set-square-story:80626e5b44143eb5ae4e0636ae1eb4d3c34f471e67ab96658cee8f6ab5619061',
];
