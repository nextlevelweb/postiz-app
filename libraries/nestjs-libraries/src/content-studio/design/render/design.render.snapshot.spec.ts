import { parseContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import { storedContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit.revision';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import { parseContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { layoutContentStudioDesign } from '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout';
import { ContentStudioDesignFontSpec } from '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout.types';
import { ContentStudioDesignRenderError } from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.types';
import {
  collectContentStudioDesignRenderFontRequests,
  CONTENT_STUDIO_LAYOUT_VERSION,
  CONTENT_STUDIO_RENDERER_VERSION,
  ContentStudioRenderAssetSnapshotError,
  ContentStudioRenderSnapshotIntegrityError,
  parseContentStudioRenderAssetSnapshot,
  parseVerifiedContentStudioRenderAssetSnapshot,
  RENDER_ASSET_SNAPSHOT_MAX_BYTES,
  storedContentStudioRenderAssetSnapshot,
} from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.snapshot';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

type Plain = Record<string, unknown>;

const font = (n: number, extra: Plain = {}) => ({
  mappingId: uuid(n),
  fontAssetId: uuid(1000 + n),
  family: `Family ${n}`,
  weight: 400,
  style: 'normal',
  sha256: SHA_A,
  ...extra,
});
const image = (n: number, extra: Plain = {}) => ({
  mediaId: `media-${n}`,
  sha256: SHA_B,
  ...extra,
});
const snapshot = (extra: Plain = {}) => ({
  schemaVersion: 1,
  fonts: [font(1)],
  images: [image(1)],
  ...extra,
});

const refused = (input: unknown) =>
  expect(() => parseContentStudioRenderAssetSnapshot(input)).toThrow(
    ContentStudioRenderAssetSnapshotError
  );

describe('render asset snapshot v1', () => {
  it('pins the renderer and layout contract names', () => {
    expect(CONTENT_STUDIO_RENDERER_VERSION).toBe('content-studio-renderer-v1');
    expect(CONTENT_STUDIO_LAYOUT_VERSION).toBe('content-studio-layout-v1');
  });

  it('RS1 accepts an empty snapshot', () => {
    expect(
      parseContentStudioRenderAssetSnapshot({
        schemaVersion: 1,
        fonts: [],
        images: [],
      })
    ).toEqual({ schemaVersion: 1, fonts: [], images: [] });
  });

  it('RS2 accepts a representative snapshot as a new object', () => {
    const input = snapshot({
      fonts: [font(1), font(2, { weight: 700, style: 'italic' })],
      images: [image(1), image(2)],
    });
    const parsed = parseContentStudioRenderAssetSnapshot(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.fonts[0]).not.toBe(input.fonts[0]);
  });

  it('RS3/RS4 has exactly schemaVersion, fonts and images', () => {
    refused({ fonts: [], images: [] });
    refused({ schemaVersion: 1, images: [] });
    refused({ schemaVersion: 1, fonts: [] });
    refused(snapshot({ schemaVersion: 2 }));
    refused(snapshot({ output: { mediaId: 'x' } }));
    refused(snapshot({ renderedMediaId: 'x' }));
  });

  it('RS5 has exactly the font fields', () => {
    for (const key of Object.keys(font(1))) {
      const entry: Plain = font(1);
      delete entry[key];
      refused(snapshot({ fonts: [entry] }));
    }
    refused(snapshot({ fonts: [font(1, { mediaId: 'font-media' })] }));
    refused(snapshot({ fonts: [font(1, { storageKey: 'fonts/x' })] }));
    refused(snapshot({ fonts: [font(1, { key: 'a:b' })] }));
  });

  it('RS6 has exactly the image fields', () => {
    refused(snapshot({ images: [{ mediaId: 'media-1' }] }));
    refused(snapshot({ images: [{ sha256: SHA_B }] }));
    refused(snapshot({ images: [image(1, { width: 10 })] }));
  });

  it('RS7 takes lowercase 64-hex SHA-256s only', () => {
    refused(snapshot({ fonts: [font(1, { sha256: SHA_A.toUpperCase() })] }));
    refused(snapshot({ images: [image(1, { sha256: SHA_B.slice(1) })] }));
    refused(snapshot({ images: [image(1, { sha256: `${SHA_B}0` })] }));
  });

  it('RS8 takes the Design font weights and styles only', () => {
    refused(snapshot({ fonts: [font(1, { weight: 450 })] }));
    refused(snapshot({ fonts: [font(1, { weight: '400' })] }));
    refused(snapshot({ fonts: [font(1, { weight: 1000 })] }));
    refused(snapshot({ fonts: [font(1, { style: 'oblique' })] }));
    refused(snapshot({ fonts: [font(1, { family: '' })] }));
    refused(snapshot({ fonts: [font(1, { family: 'x'.repeat(201) })] }));
    refused(snapshot({ fonts: [font(1, { family: 'A\u0000B' })] }));
  });

  it('RS9 takes lowercase UUIDs for the mapping and the asset', () => {
    refused(snapshot({ fonts: [font(1, { mappingId: 'mapping-1' })] }));
    refused(
      snapshot({
        fonts: [
          font(1, { fontAssetId: 'ABCDEF00-0000-4000-8000-000000000001' }),
        ],
      })
    );
  });

  it('RS10 takes the Design Media id rule only', () => {
    for (const mediaId of [
      '',
      'a/b',
      '../x',
      'http://x',
      'a.png',
      'x'.repeat(65),
    ]) {
      refused(snapshot({ images: [image(1, { mediaId })] }));
    }
  });

  it('RS11/RS12 refuses a mapping, asset or font tuple twice', () => {
    refused(snapshot({ fonts: [font(1), font(2, { mappingId: uuid(1) })] }));
    refused(
      snapshot({ fonts: [font(1), font(2, { fontAssetId: uuid(1001) })] })
    );
    refused(snapshot({ fonts: [font(1), font(2, { family: 'Family 1' })] }));
  });

  it('RS13/RS14 refuses an image pair twice and keeps another SHA-256 apart', () => {
    refused(snapshot({ images: [image(1), image(1)] }));
    expect(
      parseContentStudioRenderAssetSnapshot(
        snapshot({ images: [image(1), image(1, { sha256: SHA_A })] })
      ).images
    ).toHaveLength(2);
  });

  it('RS15-RS18 takes at most 200 fonts and 200 images', () => {
    const fonts = Array.from({ length: 200 }, (_, n) => font(n + 1));
    const images = Array.from({ length: 200 }, (_, n) => image(n + 1));
    expect(
      parseContentStudioRenderAssetSnapshot({
        schemaVersion: 1,
        fonts,
        images: [],
      }).fonts
    ).toHaveLength(200);
    expect(
      parseContentStudioRenderAssetSnapshot({
        schemaVersion: 1,
        fonts: [],
        images,
      }).images
    ).toHaveLength(200);
    refused({ schemaVersion: 1, fonts: [...fonts, font(201)], images: [] });
    refused({ schemaVersion: 1, fonts: [], images: [...images, image(201)] });
  });

  it('RS19 keeps the first-use order', () => {
    const input = snapshot({
      fonts: [font(3), font(1), font(2)],
      images: [image(9), image(2)],
    });
    expect(
      parseContentStudioRenderAssetSnapshot(input).fonts.map((f) => f.mappingId)
    ).toEqual([uuid(3), uuid(1), uuid(2)]);
    expect(
      parseContentStudioRenderAssetSnapshot(input).images.map((i) => i.mediaId)
    ).toEqual(['media-9', 'media-2']);
  });

  it('RS20/RS21 stores canonical JSON and its SHA-256; another order is another hash', () => {
    const stored = storedContentStudioRenderAssetSnapshot(
      snapshot({ fonts: [font(1), font(2)] })
    );
    expect(stored.assetSnapshot).toBe(
      canonicalJson(snapshot({ fonts: [font(1), font(2)] }))
    );
    expect(stored.assetSnapshotHash).toBe(sha256Hex(stored.assetSnapshot));
    expect(stored.assetSnapshot.startsWith('{"fonts":[{"family":')).toBe(true);
    const reordered = storedContentStudioRenderAssetSnapshot(
      snapshot({ fonts: [font(2), font(1)] })
    );
    expect(reordered.assetSnapshotHash).not.toBe(stored.assetSnapshotHash);
  });

  it('RS22-RS24 verifies a stored snapshot: valid, canonical and matching its hash', () => {
    const stored = storedContentStudioRenderAssetSnapshot(snapshot());
    expect(parseVerifiedContentStudioRenderAssetSnapshot(stored)).toEqual(
      snapshot()
    );
    const broken = (assetSnapshot: string, assetSnapshotHash: string) =>
      expect(() =>
        parseVerifiedContentStudioRenderAssetSnapshot({
          assetSnapshot,
          assetSnapshotHash,
        })
      ).toThrow(ContentStudioRenderSnapshotIntegrityError);
    broken('{', sha256Hex('{'));
    const pretty = JSON.stringify(snapshot(), null, 2);
    broken(pretty, sha256Hex(pretty));
    broken(stored.assetSnapshot, sha256Hex(`${stored.assetSnapshot} `));
    const invalid = canonicalJson({ ...snapshot(), extra: 1 });
    broken(invalid, sha256Hex(invalid));
    try {
      parseVerifiedContentStudioRenderAssetSnapshot({
        assetSnapshot: stored.assetSnapshot,
        assetSnapshotHash: SHA_A,
      });
    } catch (err) {
      expect((err as Error).message).not.toContain(SHA_A);
      expect((err as Error).message).not.toContain('Family');
    }
  });

  it('RS25/RS26 fits 64 KiB of canonical JSON', () => {
    const fill = (length: number) =>
      Array.from({ length }, (_, n) =>
        font(n + 1, { family: `${'F'.repeat(190)}${n}` })
      );
    const size = (fonts: unknown[]) =>
      canonicalJson({ schemaVersion: 1, fonts, images: [] }).length;
    let count = 1;
    while (size(fill(count + 1)) <= RENDER_ASSET_SNAPSHOT_MAX_BYTES) {
      count += 1;
    }
    expect(
      parseContentStudioRenderAssetSnapshot({
        schemaVersion: 1,
        fonts: fill(count),
        images: [],
      }).fonts
    ).toHaveLength(count);
    refused({ schemaVersion: 1, fonts: fill(count + 1), images: [] });
  });

  it('RS27 holds no URL, path, file name, bytes or base64 field', () => {
    for (const extra of [
      { url: 'https://cdn.example/x.ttf' },
      { path: '/srv/fonts/x.ttf' },
      { fileName: 'x.ttf' },
      { bytes: 'AAEAAA==' },
      { base64: 'AAEAAA==' },
      { contentType: 'font/ttf' },
    ]) {
      refused(snapshot({ fonts: [font(1, extra)] }));
      refused(snapshot({ images: [image(1, extra)] }));
      refused(snapshot(extra));
    }
    refused(
      snapshot({ fonts: [font(1)], images: [{ ...image(1), href: 'x' }] })
    );
    refused({ ...snapshot(), fonts: [Buffer.from('x')] });
  });
});

// ---------------------------------------------------------------------------
// Font dependency collector, against the layout engine's own requests
// ---------------------------------------------------------------------------

const literal = (value: string) => ({ type: 'literal', value });
const INTER = { type: 'family', family: 'Inter', weight: 400, style: 'normal' };
const text = (id: string, value: string, extra: Plain = {}) => ({
  id,
  name: '',
  x: 0,
  y: 0,
  width: 500,
  height: 200,
  rotation: 0,
  opacity: 1,
  visible: true,
  type: 'text',
  text: value,
  font: INTER,
  fontSize: 40,
  lineHeight: 1.2,
  letterSpacing: 0,
  color: literal('#111111'),
  align: 'left',
  verticalAlign: 'top',
  overflow: 'clip',
  ...extra,
});
const photo = (id: string) => ({
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
  fit: 'cover',
  focalPoint: { x: 0.5, y: 0.5 },
});
const shape = (id: string) => ({
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
});
const page = (id: string, layers: unknown[]) => ({
  id,
  name: '',
  width: 600,
  height: 600,
  background: { type: 'solid', color: literal('#ffffff') },
  layers,
});

const KIT = parseContentStudioBrandKitContent({
  schemaVersion: 1,
  identity: { brandName: 'Acme', tagline: '', description: '' },
  colors: [{ id: 'ink', name: 'Ink', value: '#1A1A1A', role: 'text' }],
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

const design = (pages: unknown[], brandKit: unknown = null) =>
  parseContentStudioDesignDocument({ schemaVersion: 1, brandKit, pages });

// What the layout engine itself asks its font provider for, in order
function layoutRequests(
  document: ReturnType<typeof design>,
  withBrand: boolean
) {
  const requests: ContentStudioDesignFontSpec[] = [];
  layoutContentStudioDesign({
    document,
    brandKit: withBrand ? { ref: REF, content: KIT } : null,
    fonts: {
      resolveFont(spec) {
        requests.push({ ...spec });
        return {
          key: JSON.stringify(spec),
          unitsPerEm: 1000,
          ascent: 800,
          descent: -200,
          shape: (value: string) => ({
            glyphs: Array.from(value).map((char, index) => ({
              id: char.codePointAt(0) as number,
              cluster: index,
              xAdvance: 500,
              yAdvance: 0,
              xOffset: 0,
              yOffset: 0,
            })),
          }),
        };
      },
    },
    images: { getImageMetadata: () => ({ width: 10, height: 10 }) },
  });
  return requests;
}

const collect = (document: ReturnType<typeof design>, withBrand: boolean) =>
  collectContentStudioDesignRenderFontRequests(
    document,
    withBrand ? KIT : null
  );

const POPPINS = { family: 'Poppins', weight: 700, style: 'normal' };
const INTER_SPEC = { family: 'Inter', weight: 400, style: 'normal' };

describe('render font dependency collector', () => {
  it('FC1 a family font as written', () => {
    expect(collect(design([page('p1', [text('t1', 'Hi')])]), false)).toEqual([
      INTER_SPEC,
    ]);
  });

  it('FC2 a Brand Kit type style as the revision defines it', () => {
    const document = design(
      [
        page('p1', [
          text('t1', 'Hi', { font: { type: 'brand', tokenId: 'heading' } }),
        ]),
      ],
      REF
    );
    expect(collect(document, true)).toEqual([POPPINS]);
  });

  it('FC3 each tuple once, in first-use order', () => {
    const document = design(
      [
        page('p1', [
          text('t1', 'a', {
            font: {
              type: 'family',
              family: 'Lora',
              weight: 700,
              style: 'italic',
            },
          }),
          text('t2', 'b'),
          text('t3', 'c', {
            font: {
              type: 'family',
              family: 'Lora',
              weight: 700,
              style: 'italic',
            },
          }),
          text('t4', 'd', {
            font: {
              type: 'family',
              family: 'lora',
              weight: 700,
              style: 'italic',
            },
          }),
        ]),
      ],
      null
    );
    expect(collect(document, false)).toEqual([
      { family: 'Lora', weight: 700, style: 'italic' },
      INTER_SPEC,
      { family: 'lora', weight: 700, style: 'italic' },
    ]);
  });

  it('FC4 skips hidden text', () => {
    const document = design([
      page('p1', [
        text('t1', 'a', {
          visible: false,
          font: {
            type: 'family',
            family: 'Hidden',
            weight: 400,
            style: 'normal',
          },
        }),
      ]),
    ]);
    expect(collect(document, false)).toEqual([]);
  });

  it('FC5 includes empty visible text, as the layout asks for its font', () => {
    const document = design([page('p1', [text('t1', '')])]);
    expect(collect(document, false)).toEqual([INTER_SPEC]);
    expect(layoutRequests(document, false)).toEqual([INTER_SPEC]);
  });

  it('FC6 goes page by page and layer by layer', () => {
    const document = design([
      page('p1', [
        text('t1', 'a', {
          font: { type: 'family', family: 'B', weight: 400, style: 'normal' },
        }),
      ]),
      page('p2', [
        text('t2', 'b', {
          font: { type: 'family', family: 'A', weight: 400, style: 'normal' },
        }),
      ]),
    ]);
    expect(collect(document, false).map((f) => f.family)).toEqual(['B', 'A']);
  });

  it('FC7/FC8 a type style without the Brand Kit, or one it lacks, is a Brand context error', () => {
    const missing = design(
      [
        page('p1', [
          text('t1', 'a', { font: { type: 'brand', tokenId: 'caption' } }),
        ]),
      ],
      REF
    );
    for (const run of [
      () => collect(missing, true),
      () => collect(missing, false),
    ]) {
      expect(run).toThrow(ContentStudioDesignRenderError);
      try {
        run();
      } catch (err) {
        expect((err as ContentStudioDesignRenderError).code).toBe(
          'BRAND_CONTEXT_ERROR'
        );
      }
    }
  });

  it('FC9 a design of shapes and images needs no font', () => {
    const document = design([page('p1', [shape('s1'), photo('i1')])]);
    expect(collect(document, false)).toEqual([]);
    expect(layoutRequests(document, false)).toEqual([]);
  });

  it('FC10 returns plain specs, never the layer or token objects', () => {
    const document = design([page('p1', [text('t1', 'a')])]);
    const [spec] = collect(document, false);
    expect(Object.keys(spec).sort()).toEqual(['family', 'style', 'weight']);
  });

  describe('parity with the layout engine', () => {
    it('FC-P1 representative document', () => {
      const document = design(
        [
          page('p1', [
            shape('s1'),
            text('t1', 'Title', {
              font: { type: 'brand', tokenId: 'heading' },
            }),
            photo('i1'),
            text('t2', 'Body'),
          ]),
          page('p2', [
            text('t3', 'Quote', {
              font: {
                type: 'family',
                family: 'Lora',
                weight: 400,
                style: 'italic',
              },
            }),
          ]),
        ],
        REF
      );
      expect(collect(document, true)).toEqual(layoutRequests(document, true));
      expect(collect(document, true)).toEqual([
        POPPINS,
        INTER_SPEC,
        { family: 'Lora', weight: 400, style: 'italic' },
      ]);
    });

    it('FC-P2 a Brand Kit style and a family that name the same tuple', () => {
      const document = design(
        [
          page('p1', [
            text('t1', 'a', { font: { type: 'brand', tokenId: 'body' } }),
            text('t2', 'b'),
          ]),
        ],
        REF
      );
      expect(collect(document, true)).toEqual(layoutRequests(document, true));
      expect(collect(document, true)).toEqual([INTER_SPEC]);
    });

    it('FC-P3 hidden text', () => {
      const document = design([
        page('p1', [
          text('t1', 'a', {
            visible: false,
            font: {
              type: 'family',
              family: 'Hidden',
              weight: 400,
              style: 'normal',
            },
          }),
          text('t2', 'b'),
        ]),
      ]);
      expect(collect(document, false)).toEqual(layoutRequests(document, false));
      expect(collect(document, false)).toEqual([INTER_SPEC]);
    });

    it('FC-P4 several pages', () => {
      const document = design([
        page('p1', [text('t1', 'a')]),
        page('p2', [
          text('t2', 'b', {
            font: {
              type: 'family',
              family: 'Mono',
              weight: 300,
              style: 'normal',
            },
          }),
          text('t3', 'c'),
        ]),
        page('p3', []),
      ]);
      expect(collect(document, false)).toEqual(layoutRequests(document, false));
      expect(collect(document, false)).toHaveLength(2);
    });
  });
});
