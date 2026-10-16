import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { parseContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import { storedContentStudioBrandKitContent } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit.revision';
import type {
  ContentStudioDesignLayoutItem,
  ContentStudioDesignLayoutPage,
  ContentStudioDesignLayoutTextItem,
} from '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout.types';
import {
  assertContentStudioDesignRenderOutputSize,
  rasterizeContentStudioDesignSvg,
  renderContentStudioDesignPage,
  renderContentStudioDesignPageSvg,
} from '@gitroom/nestjs-libraries/content-studio/design/render/design.renderer';
import {
  buildContentStudioDesignPageSvg,
  svgNumber,
} from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.svg';
import {
  ContentStudioDesignRenderError,
  ContentStudioDesignRenderErrorCode,
  ContentStudioDesignRenderInput,
  DESIGN_RENDER_IMAGE_MAX_BYTES,
  DESIGN_RENDER_PNG_MAX_BYTES,
  DESIGN_RENDER_SVG_MAX_BYTES,
  designRenderSha256,
} from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.types';

// The test font is Geist Regular from the installed next package (a direct
// dependency, 16.3.1; SIL Open Font License 1.1), read at test time and
// never copied: see design.render.fonts.spec.ts. Test images are made with
// Sharp at test time. Pixel values and the two pinned hashes hold for the
// installed Sharp 0.33.5 / libvips 8.15.3 / librsvg 2.58.93 and fontkit 1.9.0
const GEIST = fs.readFileSync(
  path.join(
    path.dirname(require.resolve('next/package.json')),
    'dist/compiled/@vercel/og/Geist-Regular.ttf'
  )
);
const GEIST_SHA = designRenderSha256(GEIST);
const FONT_KEY = 'geist-regular';
const FONT_MARKER = 'RENDER_FONT_PRIVATE_PATH_123';
const IMAGE_MARKER = 'RENDER_IMAGE_PRIVATE_PATH_456';
const SHARP_MARKER = 'RENDER_SHARP_PRIVATE_789';

type Plain = Record<string, unknown>;
type Rgb = [number, number, number];

const RED: Rgb = [255, 0, 0];
const BLUE: Rgb = [0, 0, 255];
const WHITE: Rgb = [255, 255, 255];

const solidPng = (width: number, height: number, [r, g, b]: Rgb, alpha = 1) =>
  sharp({
    create: { width, height, channels: 4, background: { r, g, b, alpha } },
  })
    .png()
    .toBuffer();

// left half red, right half blue
const halvesPng = (width: number, height: number) => {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      raw.set(x < width / 2 ? RED : BLUE, (y * width + x) * 3);
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
};

// two frames of one pixel
const TWO_FRAME_GIF = Buffer.from(
  [
    '474946383961', // GIF89a
    '01000100800000', // 1 x 1, a two-color table
    '000000ffffff',
    '21f904000a000000', // frame 1: color 0
    '2c000000000100010000',
    '0202440100',
    '21f904000a000000', // frame 2: color 1
    '2c000000000100010000',
    '02024c0100',
    '3b',
  ].join(''),
  'hex'
);

const IMG: Record<string, Buffer> = {};
beforeAll(async () => {
  IMG.red = await solidPng(200, 100, RED);
  IMG.blue = await solidPng(50, 100, BLUE);
  IMG.halves = await halvesPng(200, 100);
  IMG.clear = await solidPng(20, 20, WHITE, 0);
  IMG.jpeg = await sharp({
    create: {
      width: 40,
      height: 20,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .jpeg({ quality: 100 })
    .toBuffer();
  // 4 x 2 pixels stored, shown 2 x 4 (EXIF orientation 6: turn 90 degrees)
  IMG.rotated = await sharp({
    create: {
      width: 4,
      height: 2,
      channels: 3,
      background: { r: 0, g: 0, b: 255 },
    },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  IMG.webp = await sharp({
    create: {
      width: 40,
      height: 20,
      channels: 4,
      background: { r: 0, g: 0, b: 255, alpha: 1 },
    },
  })
    .webp({ lossless: true })
    .toBuffer();
  IMG.gif = TWO_FRAME_GIF;
  IMG.animated = await sharp(TWO_FRAME_GIF, { animated: true })
    .webp()
    .toBuffer();
  IMG.stillGif = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .gif()
    .toBuffer();
  IMG.tiff = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .tiff()
    .toBuffer();
  IMG.svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="https://example.com/x.png" width="10" height="10"/></svg>'
  );
});

// a name without an image still gets a well-formed SHA-256
const sha = (name: string) =>
  IMG[name] ? designRenderSha256(IMG[name]) : 'f'.repeat(64);

// ---------------------------------------------------------------------------
// Design builders
// ---------------------------------------------------------------------------

const literal = (value: string) => ({ type: 'literal', value });
const brand = (tokenId: string) => ({ type: 'brand', tokenId });
const GEIST_FONT = {
  type: 'family',
  family: 'Geist',
  weight: 400,
  style: 'normal',
};

const layer = (id: string, extra: Plain) => ({
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
  layer(id, {
    type: 'shape',
    shape: 'rectangle',
    fill: literal('#000000'),
    cornerRadius: 0,
    ...extra,
  });
const ellipse = (id: string, extra: Plain = {}) =>
  layer(id, {
    type: 'shape',
    shape: 'ellipse',
    fill: literal('#000000'),
    cornerRadius: 0,
    ...extra,
  });
const text = (id: string, value: string, extra: Plain = {}) =>
  layer(id, {
    type: 'text',
    text: value,
    font: GEIST_FONT,
    fontSize: 100,
    lineHeight: 1.2,
    letterSpacing: 0,
    color: literal('#000000'),
    align: 'left',
    verticalAlign: 'top',
    overflow: 'clip',
    ...extra,
  });
const image = (id: string, name: string, extra: Plain = {}) =>
  layer(id, {
    type: 'image',
    imageRef: { type: 'media', mediaId: `${name}-1`, sha256: sha(name) },
    fit: 'contain',
    focalPoint: { x: 0.5, y: 0.5 },
    ...extra,
  });
const page = (layers: unknown[], extra: Plain = {}) => ({
  id: 'p',
  name: '',
  width: 200,
  height: 100,
  background: { type: 'solid', color: literal('#ffffff') },
  layers,
  ...extra,
});
const design = (pages: unknown[], brandKit: unknown = null) => ({
  schemaVersion: 1,
  brandKit,
  pages,
});

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

const geistAsset = (extra: Plain = {}) => ({
  key: FONT_KEY,
  bytes: GEIST,
  sha256: GEIST_SHA,
  ...extra,
});

function fontResolver(
  resolve?: (font: { family: string; weight: number; style: string }) => unknown
) {
  const calls: unknown[] = [];
  return {
    calls,
    resolveFont(font: { family: string; weight: number; style: string }) {
      calls.push({ ...font });
      if (resolve) {
        return resolve(font) as never;
      }
      return (
        font.family === 'Geist' &&
        font.weight === 400 &&
        font.style === 'normal'
          ? geistAsset()
          : null
      ) as never;
    },
  };
}

function imageResolver(
  override?: (ref: { mediaId: string; sha256: string }) => unknown
) {
  const calls: Array<{ mediaId: string; sha256: string }> = [];
  return {
    calls,
    resolveImage(ref: { mediaId: string; sha256: string }) {
      calls.push({ mediaId: ref.mediaId, sha256: ref.sha256 });
      if (override) {
        return override(ref) as never;
      }
      const name = ref.mediaId.replace(/-1$/, '');
      const bytes = IMG[name];
      return (
        bytes ? { bytes, sha256: designRenderSha256(bytes) } : null
      ) as never;
    },
  };
}

interface Options {
  brandKit?: unknown;
  pageId?: string;
  fonts?: unknown;
  images?: unknown;
}

const inputOf = (document: unknown, options: Options = {}) =>
  ({
    document,
    brandKit: options.brandKit ?? null,
    pageId: options.pageId ?? 'p',
    fonts: options.fonts ?? fontResolver(),
    images: options.images ?? imageResolver(),
  } as ContentStudioDesignRenderInput);

const render = (document: unknown, options: Options = {}) =>
  renderContentStudioDesignPage(inputOf(document, options));

const svgOf = (document: unknown, options: Options = {}) =>
  renderContentStudioDesignPageSvg(inputOf(document, options));

const pixelsOf = async (png: Buffer) => {
  const { data, info } = await sharp(png)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return (x: number, y: number) =>
    Array.from(
      data.subarray(
        (y * info.width + x) * info.channels,
        (y * info.width + x + 1) * info.channels
      )
    );
};

const near = (actual: number[], expected: number[], tolerance = 1) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => {
    expect(Math.abs(value - expected[index])).toBeLessThanOrEqual(tolerance);
  });
};

const renderPixels = async (
  layers: unknown[],
  extra: Plain = {},
  options: Options = {}
) => pixelsOf((await render(design([page(layers, extra)]), options)).bytes);

const renderErrorOf = async (action: () => Promise<unknown>) => {
  try {
    await action();
  } catch (error) {
    return error as ContentStudioDesignRenderError;
  }
  throw new Error('expected the render to fail');
};

const expectRenderError = async (
  action: () => Promise<unknown>,
  code: ContentStudioDesignRenderErrorCode
) => {
  const error = await renderErrorOf(action);
  expect(error).toBeInstanceOf(ContentStudioDesignRenderError);
  expect(error.code).toBe(code);
  expect(error.message).toBe(new ContentStudioDesignRenderError(code).message);
  const exposed = `${error.message} ${JSON.stringify(error)}`;
  for (const marker of [
    FONT_MARKER,
    IMAGE_MARKER,
    SHARP_MARKER,
    GEIST_SHA,
    'Geist',
  ]) {
    expect(exposed).not.toContain(marker);
  }
  return error;
};

// ---------------------------------------------------------------------------
// SVG from a display list
// ---------------------------------------------------------------------------

const box = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
});
const geometry = (b: ReturnType<typeof box>, rotation = 0, opacity = 1) => ({
  box: b,
  rotation,
  transformOrigin: { x: b.x + b.width / 2, y: b.y + b.height / 2 },
  opacity,
});
const layoutPage = (
  items: ContentStudioDesignLayoutItem[]
): ContentStudioDesignLayoutPage => ({
  id: 'p',
  width: 200,
  height: 100,
  background: { type: 'solid', color: '#ffffff' },
  clipRect: box(0, 0, 200, 100),
  items,
});
const fakeAssets = (
  paths: Record<number, string> = {},
  png = Buffer.from([1, 2, 3])
) => ({
  font: () => ({
    unitsPerEm: 1000,
    glyphPath: (id: number) => paths[id] ?? `M0 0L${id} 0Z`,
  }),
  image: () => ({ png }),
});
const ROOT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect x="0" y="0" width="200" height="100" fill="#ffffff"/>';
const svgWith = (
  items: ContentStudioDesignLayoutItem[],
  assets = fakeAssets()
) => buildContentStudioDesignPageSvg(layoutPage(items), assets);
const body = (
  items: ContentStudioDesignLayoutItem[],
  assets = fakeAssets()
) => {
  const svg = svgWith(items, assets);
  expect(svg.startsWith(ROOT)).toBe(true);
  expect(svg.endsWith('</svg>')).toBe(true);
  return svg.slice(ROOT.length, -'</svg>'.length);
};

const rectangleItem = (
  layerId: string,
  b = box(10, 20, 30, 40),
  extra: Plain = {}
) =>
  ({
    layerId,
    type: 'rectangle',
    ...geometry(b),
    fill: '#ff0000',
    cornerRadius: 0,
    ...extra,
  } as ContentStudioDesignLayoutItem);
const textItem = (extra: Plain = {}) =>
  ({
    layerId: 't',
    type: 'text',
    ...geometry(box(5, 6, 70, 30)),
    clipRect: box(5, 6, 70, 30),
    font: { family: 'Geist', weight: 400, style: 'normal' },
    fontKey: FONT_KEY,
    color: '#111111',
    requestedFontSize: 100,
    resolvedFontSize: 50,
    lineHeight: 1.2,
    letterSpacing: 0,
    align: 'left',
    verticalAlign: 'top',
    overflow: 'shrink',
    fits: true,
    lines: [
      {
        text: 'A B',
        x: 5,
        baselineY: 30,
        width: 60,
        glyphs: [
          { id: 65, cluster: 0, x: 5, y: 30, advance: 20 },
          { id: 32, cluster: 1, x: 25, y: 30, advance: 10 },
          { id: 66, cluster: 2, x: 35.5, y: 29, advance: 20 },
        ],
      },
    ],
    ...extra,
  } as ContentStudioDesignLayoutItem);
const imageItem = (extra: Plain = {}) =>
  ({
    layerId: 'i',
    type: 'image',
    ...geometry(box(0, 0, 100, 100)),
    imageRef: { mediaId: 'photo-1', sha256: 'a'.repeat(64) },
    intrinsic: { width: 200, height: 100 },
    fit: 'contain',
    sourceRect: box(0, 0, 200, 100),
    destinationRect: box(0, 25, 100, 50),
    ...extra,
  } as ContentStudioDesignLayoutItem);

describe('design renderer: SVG', () => {
  it('SV1 and SV2 start with the exact page size and the background', () => {
    expect(svgWith([])).toBe(`${ROOT}</svg>`);
  });

  it('SV3 keeps the display-list order', () => {
    const svg = body([
      rectangleItem('c', box(1, 1, 1, 1)),
      rectangleItem('a', box(2, 2, 2, 2)),
      rectangleItem('b', box(3, 3, 3, 3)),
    ]);
    expect(svg).toBe(
      '<g><rect x="1" y="1" width="1" height="1" fill="#ff0000"/></g>' +
        '<g><rect x="2" y="2" width="2" height="2" fill="#ff0000"/></g>' +
        '<g><rect x="3" y="3" width="3" height="3" fill="#ff0000"/></g>'
    );
  });

  it('SV4 draws a rectangle with the corner radius the layout gives', () => {
    expect(
      body([rectangleItem('r', box(10, 20, 30, 40), { cornerRadius: 7.5 })])
    ).toBe(
      '<g><rect x="10" y="20" width="30" height="40" rx="7.5" ry="7.5" fill="#ff0000"/></g>'
    );
  });

  it('SV5 draws an ellipse in its box', () => {
    expect(
      body([
        {
          layerId: 'e',
          type: 'ellipse',
          ...geometry(box(10, 20, 30, 40)),
          fill: '#00ff00',
        } as ContentStudioDesignLayoutItem,
      ])
    ).toBe('<g><ellipse cx="25" cy="40" rx="15" ry="20" fill="#00ff00"/></g>');
  });

  it('SV6 applies opacity once to the item group, 0 included', () => {
    expect(body([rectangleItem('r', box(1, 2, 3, 4), { opacity: 0.25 })])).toBe(
      '<g opacity="0.25"><rect x="1" y="2" width="3" height="4" fill="#ff0000"/></g>'
    );
    expect(
      body([rectangleItem('r', box(1, 2, 3, 4), { opacity: 0 })])
    ).toContain('<g opacity="0">');
  });

  it('SV7 rotates around the transform origin the layout gives, clockwise', () => {
    // an origin that is not the box center proves it is not recomputed
    expect(
      body([
        rectangleItem('r', box(1, 2, 3, 4), {
          rotation: -30.5,
          opacity: 0.5,
          transformOrigin: { x: 7, y: 8.25 },
        }),
      ])
    ).toBe(
      '<g transform="rotate(-30.5 7 8.25)" opacity="0.5"><rect x="1" y="2" width="3" height="4" fill="#ff0000"/></g>'
    );
  });

  it('SV8, SV9 and GP6 draw text as clipped glyph paths at the resolved size', () => {
    expect(body([textItem()], fakeAssets({ 32: '' }))).toBe(
      '<g><defs><clipPath id="clip-0"><rect x="5" y="6" width="70" height="30"/></clipPath></defs>' +
        '<g clip-path="url(#clip-0)" fill="#111111">' +
        '<path transform="translate(5 30) scale(0.05 -0.05)" d="M0 0L65 0Z"/>' +
        '<path transform="translate(35.5 29) scale(0.05 -0.05)" d="M0 0L66 0Z"/>' +
        '</g></g>'
    );
  });

  it('SV8 puts the text clip inside the rotated group', () => {
    const svg = body([textItem({ rotation: 90 })], fakeAssets({ 32: '' }));
    expect(
      svg.startsWith(
        '<g transform="rotate(90 40 21)"><defs><clipPath id="clip-0">'
      )
    ).toBe(true);
  });

  it('SV10 places a contain image exactly on its destination', () => {
    expect(body([imageItem()])).toBe(
      '<g><defs><clipPath id="clip-0"><rect x="0" y="25" width="100" height="50"/></clipPath></defs>' +
        '<g clip-path="url(#clip-0)"><image x="0" y="25" width="100" height="50" preserveAspectRatio="none" href="data:image/png;base64,AQID"/></g></g>'
    );
  });

  it('SV11 maps a fractional source rectangle exactly onto the destination', () => {
    const source = box(250.5, 0, 999.25, 1000);
    const target = box(10.25, 20.5, 500, 500);
    const svg = body([
      imageItem({
        fit: 'cover',
        intrinsic: { width: 2000, height: 1000 },
        sourceRect: source,
        destinationRect: target,
      }),
    ]);
    const scaleX = target.width / source.width;
    const scaleY = target.height / source.height;
    expect(svg).toContain(
      '<clipPath id="clip-0"><rect x="10.25" y="20.5" width="500" height="500"/></clipPath>'
    );
    expect(svg).toContain(
      `<image x="${String(target.x - source.x * scaleX)}" y="${String(
        target.y - source.y * scaleY
      )}" width="${String(2000 * scaleX)}" height="${String(
        1000 * scaleY
      )}" preserveAspectRatio="none"`
    );
    // nothing rounded
    expect(String(target.x - source.x * scaleX)).toMatch(/\.\d{5,}/);
  });

  it('SV12 and SV13 embed only data:image/png URIs and no external reference', () => {
    const svg = svgWith([imageItem(), imageItem({ layerId: 'j' }), textItem()]);
    expect(svg.match(/href="[^"]*"/g)).toEqual([
      'href="data:image/png;base64,AQID"',
      'href="data:image/png;base64,AQID"',
    ]);
    // the only URL is the SVG namespace name, which is never fetched
    expect(svg.split('http').length).toBe(2);
    const withoutNamespace = svg.replace(
      'xmlns="http://www.w3.org/2000/svg"',
      ''
    );
    for (const external of [
      'http:',
      'https:',
      'file:',
      'xlink',
      'url(http',
      '@import',
      '//',
    ]) {
      expect(withoutNamespace).not.toContain(external);
    }
  });

  it('SV14 and RBOUND9 use the fixed element vocabulary only', () => {
    const svg = svgWith([
      rectangleItem('r'),
      {
        layerId: 'e',
        type: 'ellipse',
        ...geometry(box(1, 1, 2, 2)),
        fill: '#000000',
      } as ContentStudioDesignLayoutItem,
      imageItem(),
      textItem({ rotation: 3, opacity: 0.5 }),
    ]);
    const tags = new Set(
      Array.from(svg.matchAll(/<\/?([A-Za-z]+)/g), (match) => match[1])
    );
    expect([...tags].sort()).toEqual([
      'clipPath',
      'defs',
      'ellipse',
      'g',
      'image',
      'path',
      'rect',
      'svg',
    ]);
    for (const forbidden of [
      '<text',
      '<tspan',
      'foreignObject',
      '<style',
      'style=',
      '<script',
      ' on',
      'class=',
      '<!--',
      '<use',
      '<filter',
      '<animate',
    ]) {
      expect(svg).not.toContain(forbidden);
    }
  });

  it('SV15 numbers clips in item order', () => {
    const svg = svgWith([
      imageItem(),
      rectangleItem('r'),
      textItem(),
      imageItem({ layerId: 'k' }),
    ]);
    expect(
      Array.from(svg.matchAll(/id="([^"]+)"/g), (match) => match[1])
    ).toEqual(['clip-0', 'clip-1', 'clip-2']);
    expect(
      Array.from(svg.matchAll(/url\(#([^)]+)\)/g), (match) => match[1])
    ).toEqual(['clip-0', 'clip-1', 'clip-2']);
  });

  it('SV16 gives the same SVG every time', () => {
    const items = [
      rectangleItem('r', box(1.1, 2.2, 3.3, 4.4), { rotation: 12.5 }),
      imageItem(),
      textItem(),
    ];
    const first = svgWith(items);
    for (let index = 0; index < 100; index += 1) {
      expect(svgWith(items)).toBe(first);
    }
  });

  it('SV17 refuses an SVG above 16 MiB, exactly at the limit', () => {
    const items = [
      textItem({
        lines: [
          {
            text: 'A',
            x: 0,
            baselineY: 0,
            width: 1,
            glyphs: [{ id: 65, cluster: 0, x: 0, y: 0, advance: 1 }],
          },
        ],
      }),
    ];
    const base = svgWith(items, fakeAssets({ 65: 'M' })).length;
    const padded = (extra: number) =>
      fakeAssets({ 65: `M${' '.repeat(extra)}` });
    expect(
      svgWith(items, padded(DESIGN_RENDER_SVG_MAX_BYTES - base))
    ).toHaveLength(DESIGN_RENDER_SVG_MAX_BYTES);
    expect(() =>
      svgWith(items, padded(DESIGN_RENDER_SVG_MAX_BYTES - base + 1))
    ).toThrow(new ContentStudioDesignRenderError('RENDER_OUTPUT_TOO_LARGE'));
    // an embedded image is refused before it is encoded
    expect(() =>
      svgWith([imageItem()], fakeAssets({}, Buffer.alloc(13 * 1024 * 1024)))
    ).toThrow(new ContentStudioDesignRenderError('RENDER_OUTPUT_TOO_LARGE'));
  });

  it('writes numbers without rounding or locale, -0 as 0, and refuses non-finite ones', () => {
    expect(
      [0, -0, 1, -2.5, 0.1 + 0.2, 1e21, 1e-7, 123456.789].map(svgNumber)
    ).toEqual([
      '0',
      '0',
      '1',
      '-2.5',
      '0.30000000000000004',
      '1e+21',
      '1e-7',
      '123456.789',
    ]);
    for (const value of [NaN, Infinity, -Infinity, '1' as unknown as number]) {
      expect(() => svgNumber(value)).toThrow(
        new ContentStudioDesignRenderError('RENDER_FAILED')
      );
    }
    expect(() => svgWith([rectangleItem('r', box(NaN, 0, 1, 1))])).toThrow(
      new ContentStudioDesignRenderError('RENDER_FAILED')
    );
  });

  it('refuses a color that is not #rrggbb rather than writing it', () => {
    for (const fill of ['#FF0000', 'red', '#ff0000" onload="x', '#fff']) {
      expect(() =>
        svgWith([rectangleItem('r', box(1, 1, 1, 1), { fill })])
      ).toThrow(new ContentStudioDesignRenderError('RENDER_FAILED'));
    }
    expect(() => svgWith([textItem({ color: '#000000"/><script>' })])).toThrow(
      new ContentStudioDesignRenderError('RENDER_FAILED')
    );
  });

  it('writes no layer id, font key, Media id or SHA-256', () => {
    const svg = svgWith([
      rectangleItem('layer-secret'),
      imageItem(),
      textItem(),
    ]);
    for (const value of [
      'layer-secret',
      FONT_KEY,
      'photo-1',
      'a'.repeat(64),
      'Geist',
    ]) {
      expect(svg).not.toContain(value);
    }
  });
});

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

describe('design renderer: PNG', () => {
  it('RP1 and RP2 return an sRGB PNG of exactly the page size', async () => {
    const result = await render(design([page([], { width: 333, height: 77 })]));
    expect(result.mimeType).toBe('image/png');
    expect(result.bytes.subarray(0, 8).toString('hex')).toBe(
      '89504e470d0a1a0a'
    );
    const metadata = await sharp(result.bytes).metadata();
    expect(metadata).toMatchObject({
      format: 'png',
      width: 333,
      height: 77,
      space: 'srgb',
      channels: 3,
      hasProfile: false,
    });
    expect(metadata.pages).toBeUndefined();
    expect([result.pageId, result.width, result.height]).toEqual([
      'p',
      333,
      77,
    ]);
  });

  it('RP3 and RP4 give the same bytes every time, with their SHA-256', async () => {
    const document = goldenDocument();
    const first = await render(document, goldenOptions());
    expect(first.sha256).toBe(designRenderSha256(first.bytes));
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (let index = 0; index < 10; index += 1) {
      const again = await render(document, goldenOptions());
      expect(again.bytes.equals(first.bytes)).toBe(true);
      expect(again.sha256).toBe(first.sha256);
    }
  });

  it('RP5 paints the background', async () => {
    const px = await renderPixels([], {
      background: { type: 'solid', color: literal('#336699') },
    });
    expect(px(0, 0)).toEqual([0x33, 0x66, 0x99]);
    expect(px(199, 99)).toEqual([0x33, 0x66, 0x99]);
  });

  it('RP6 paints later layers over earlier ones', async () => {
    const red = rect('red', { width: 120, fill: literal('#ff0000') });
    const blue = rect('blue', { x: 80, width: 120, fill: literal('#0000ff') });
    expect((await renderPixels([red, blue]))(100, 50)).toEqual(BLUE);
    expect((await renderPixels([blue, red]))(100, 50)).toEqual(RED);
  });

  it('RP7 blends opacity once', async () => {
    const px = await renderPixels([rect('veil', { width: 200, opacity: 0.5 })]);
    near(px(100, 50), [128, 128, 128]);
    const nothing = await renderPixels([
      rect('clear', { width: 200, opacity: 0 }),
    ]);
    expect(nothing(100, 50)).toEqual(WHITE);
  });

  it('RP8 rotates around the layer center, clockwise', async () => {
    // a 120 x 10 bar centered at (100, 50), turned 90 degrees
    const px = await renderPixels([
      rect('bar', { x: 40, y: 45, width: 120, height: 10, rotation: 90 }),
    ]);
    expect(px(100, 15)).toEqual([0, 0, 0]);
    expect(px(100, 85)).toEqual([0, 0, 0]);
    expect(px(60, 50)).toEqual(WHITE);
    expect(px(140, 50)).toEqual(WHITE);
    // 45 degrees clockwise: the right end goes down
    const turned = await renderPixels([
      rect('bar', { x: 40, y: 45, width: 120, height: 10, rotation: 45 }),
    ]);
    expect(turned(135, 85)).toEqual([0, 0, 0]);
    expect(turned(135, 15)).toEqual(WHITE);
  });

  it('RP9 rounds corners by the layout radius', async () => {
    const round = await renderPixels([rect('r', { cornerRadius: 50 })]);
    expect(round(3, 3)).toEqual(WHITE);
    expect(round(50, 50)).toEqual([0, 0, 0]);
    const square = await renderPixels([rect('r', { cornerRadius: 0 })]);
    expect(square(1, 1)).toEqual([0, 0, 0]);
  });

  it('RP10 draws an ellipse', async () => {
    const px = await renderPixels([
      ellipse('e', { width: 200, height: 100, fill: literal('#00ff00') }),
    ]);
    expect(px(100, 50)).toEqual([0, 255, 0]);
    expect(px(4, 4)).toEqual(WHITE);
    expect(px(195, 95)).toEqual(WHITE);
  });

  it('RP11 leaves the margins of a contain image transparent', async () => {
    const px = await renderPixels([image('photo', 'red', { fit: 'contain' })], {
      width: 100,
      height: 100,
    });
    expect(px(50, 10)).toEqual(WHITE);
    expect(px(50, 50)).toEqual(RED);
    expect(px(50, 90)).toEqual(WHITE);
  });

  it('RP12 crops a cover image where the layout puts the focal point', async () => {
    const cover = (x: number) =>
      renderPixels(
        [image('photo', 'halves', { fit: 'cover', focalPoint: { x, y: 0.5 } })],
        { width: 100, height: 100 }
      );
    expect((await cover(0))(50, 50)).toEqual(RED);
    expect((await cover(1))(50, 50)).toEqual(BLUE);
    const centered = await cover(0.5);
    expect(centered(25, 50)).toEqual(RED);
    expect(centered(75, 50)).toEqual(BLUE);
  });

  it('RP13 draws text from glyph outlines with +y turned down', async () => {
    // "A" at size 100: baseline 95.5; its bar spans y 66.9..75.3, x 18.5..45.4,
    // and its counter is open at (33, 55)
    const result = await render(
      design([
        page([text('a', 'A', { width: 200, height: 150 })], { height: 150 }),
      ])
    );
    const px = await pixelsOf(result.bytes);
    expect(Math.max(...px(32, 71))).toBeLessThan(60);
    expect(Math.min(...px(33, 55))).toBeGreaterThan(200);
    expect(px(150, 100)).toEqual(WHITE);
    expect(px(32, 140)).toEqual(WHITE);
  });

  it('RP14 clips text to its box: lines laid out below it are not painted', async () => {
    const document = design([
      page([text('a', 'A\nA', { width: 200, height: 100 })], { height: 260 }),
    ]);
    const { page: laidOut } = await svgOf(document);
    expect(
      (laidOut.items[0] as ContentStudioDesignLayoutTextItem).lines
    ).toHaveLength(2);
    const px = await pixelsOf((await render(document)).bytes);
    expect(Math.max(...px(32, 71))).toBeLessThan(60);
    expect(px(32, 191)).toEqual(WHITE);
    // the same page without a clip would paint it
    const unclipped = await renderPixels(
      [text('a', 'A\nA', { width: 200, height: 260 })],
      { height: 260 }
    );
    expect(Math.max(...unclipped(32, 191))).toBeLessThan(60);
  });

  it('RP14 turns the text clip with the layer', async () => {
    // a 200 x 50 box centered at (100, 100) turned 90 degrees covers x 75..125:
    // its unrotated area at (20, 100) stays empty
    const document = design([
      page(
        [
          text('a', 'AAAA AAAA AAAA', {
            x: 0,
            y: 75,
            width: 200,
            height: 50,
            fontSize: 40,
            rotation: 90,
          }),
        ],
        { height: 200 }
      ),
    ]);
    const px = await pixelsOf((await render(document)).bytes);
    for (const [x, y] of [
      [20, 100],
      [180, 100],
      [60, 20],
      [140, 180],
    ]) {
      expect(px(x, y)).toEqual(WHITE);
    }
    let painted = 0;
    for (let y = 0; y < 200; y += 2) {
      for (let x = 75; x < 125; x += 2) {
        painted += Math.max(...px(x, y)) < 128 ? 1 : 0;
      }
    }
    expect(painted).toBeGreaterThan(50);
  });

  it('RP15 scales glyphs by the resolved font size of shrunk text', async () => {
    const { page: laidOut, svg } = await svgOf(
      design([
        page(
          [text('a', 'AAAA', { width: 100, height: 200, overflow: 'shrink' })],
          { height: 200 }
        ),
      ])
    );
    const item = laidOut.items[0] as ContentStudioDesignLayoutTextItem;
    expect(item.resolvedFontSize).toBeLessThan(100);
    const scale = item.resolvedFontSize / 1000;
    expect(svg).toContain(`scale(${scale} ${-scale})`);
    expect(svg).not.toContain('scale(0.1 -0.1)');
    expect((svg.match(/<path /g) ?? []).length).toBe(4);
  });

  it('RP16 clips layers to the page', async () => {
    const result = await render(
      design([
        page([rect('wide', { x: 150, width: 100, fill: literal('#ff0000') })]),
      ])
    );
    expect(result.width).toBe(200);
    expect((await pixelsOf(result.bytes))(199, 50)).toEqual(RED);
  });

  it('RP17 refuses a PNG above 32 MiB', () => {
    expect(() =>
      assertContentStudioDesignRenderOutputSize(
        Buffer.alloc(DESIGN_RENDER_PNG_MAX_BYTES)
      )
    ).not.toThrow();
    expect(() =>
      assertContentStudioDesignRenderOutputSize(
        Buffer.alloc(DESIGN_RENDER_PNG_MAX_BYTES + 1)
      )
    ).toThrow(new ContentStudioDesignRenderError('RENDER_OUTPUT_TOO_LARGE'));
  });

  it('RE12 maps a Sharp failure to a fixed error', async () => {
    await expectRenderError(
      () => rasterizeContentStudioDesignSvg(`<svg ${SHARP_MARKER}`, 10, 10),
      'RENDER_FAILED'
    );
    // a size other than the page's is refused
    await expectRenderError(
      () =>
        rasterizeContentStudioDesignSvg(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
          10,
          11
        ),
      'RENDER_FAILED'
    );
  });
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

describe('design renderer: images', () => {
  const contain = (name: string, images?: unknown) =>
    renderPixels(
      [image('photo', name, { width: 200, height: 100 })],
      {},
      images ? { images } : {}
    );

  it('RI1, RI2 and RI3 draw PNG, JPEG and WebP', async () => {
    expect((await contain('red'))(100, 50)).toEqual(RED);
    near((await contain('jpeg'))(100, 50), RED, 3);
    expect((await contain('webp'))(100, 50)).toEqual(BLUE);
  });

  it('RI4 refuses bytes that are not the Design SHA-256', async () => {
    const wrong = { bytes: IMG.blue, sha256: sha('blue') };
    await expectRenderError(
      () =>
        render(design([page([image('photo', 'red')])]), {
          images: imageResolver(() => wrong),
        }),
      'IMAGE_ASSET_INTEGRITY_ERROR'
    );
    const lying = { bytes: IMG.blue, sha256: sha('red') };
    await expectRenderError(
      () =>
        render(design([page([image('photo', 'red')])]), {
          images: imageResolver(() => lying),
        }),
      'IMAGE_ASSET_INTEGRITY_ERROR'
    );
    const otherHash = { bytes: IMG.red, sha256: sha('blue') };
    await expectRenderError(
      () =>
        render(design([page([image('photo', 'red')])]), {
          images: imageResolver(() => otherHash),
        }),
      'IMAGE_ASSET_INTEGRITY_ERROR'
    );
    const upper = { bytes: IMG.red, sha256: sha('red').toUpperCase() };
    await expectRenderError(
      () =>
        render(design([page([image('photo', 'red')])]), {
          images: imageResolver(() => upper),
        }),
      'IMAGE_ASSET_INVALID'
    );
  });

  it('RI5 and RI6 fail without an image, never passing on the resolver error', async () => {
    const one = design([page([image('photo', 'red')])]);
    await expectRenderError(
      () => render(one, { images: imageResolver(() => null) }),
      'IMAGE_ASSET_UNAVAILABLE'
    );
    await expectRenderError(
      () =>
        render(one, {
          images: imageResolver(() => {
            throw new Error(IMAGE_MARKER);
          }),
        }),
      'IMAGE_ASSET_UNAVAILABLE'
    );
    await expectRenderError(
      () =>
        render(one, {
          images: imageResolver(() => Promise.reject(new Error(IMAGE_MARKER))),
        }),
      'IMAGE_ASSET_UNAVAILABLE'
    );
    expect(
      (
        await render(one, {
          images: imageResolver(async (ref) => ({
            bytes: IMG.red,
            sha256: ref.sha256,
          })),
        })
      ).width
    ).toBe(200);
  });

  it('RI7 and RI8 refuse empty and oversized bytes', async () => {
    const empty = Buffer.alloc(0);
    await expectRenderError(
      () =>
        render(design([page([image('photo', 'red')])]), {
          images: imageResolver(() => ({
            bytes: empty,
            sha256: designRenderSha256(empty),
          })),
        }),
      'IMAGE_ASSET_INVALID'
    );
    const big = Buffer.alloc(DESIGN_RENDER_IMAGE_MAX_BYTES + 1);
    const bigSha = designRenderSha256(big);
    await expectRenderError(
      () =>
        render(
          design([
            page([
              layer('photo', {
                type: 'image',
                imageRef: { type: 'media', mediaId: 'big', sha256: bigSha },
                fit: 'contain',
                focalPoint: { x: 0.5, y: 0.5 },
              }),
            ]),
          ]),
          {
            images: imageResolver(() => ({ bytes: big, sha256: bigSha })),
          }
        ),
      'IMAGE_ASSET_INVALID'
    );
    for (const bad of [
      'image',
      null,
      { bytes: 'x', sha256: sha('red') },
      { bytes: IMG.red },
    ]) {
      await expectRenderError(
        () =>
          render(design([page([image('photo', 'red')])]), {
            images: imageResolver(() =>
              bad === null ? { sha256: sha('red') } : bad
            ),
          }),
        'IMAGE_ASSET_INVALID'
      );
    }
  });

  it.each([
    ['RI9 SVG', 'svg'],
    ['RI10 a two-frame GIF', 'gif'],
    ['RI10 an animated WebP', 'animated'],
    ['a still GIF', 'stillGif'],
    ['RI11 TIFF', 'tiff'],
  ])('%s is not supported', async (_name, name) => {
    await expectRenderError(
      () => render(design([page([image('photo', name)])])),
      'IMAGE_ASSET_UNSUPPORTED'
    );
  });

  it('refuses bytes no decoder reads', async () => {
    const junk = Buffer.from(`${IMAGE_MARKER} not an image`);
    await expectRenderError(
      () =>
        render(
          design([
            page([
              layer('photo', {
                type: 'image',
                imageRef: {
                  type: 'media',
                  mediaId: 'junk',
                  sha256: designRenderSha256(junk),
                },
                fit: 'contain',
                focalPoint: { x: 0.5, y: 0.5 },
              }),
            ]),
          ]),
          {
            images: imageResolver(() => ({
              bytes: junk,
              sha256: designRenderSha256(junk),
            })),
          }
        ),
      'IMAGE_ASSET_INVALID'
    );
  });

  it('RI12 resolves an image once per render, across pages and passes', async () => {
    const images = imageResolver();
    await render(
      design([
        page([image('a', 'red'), image('b', 'red')]),
        page([image('c', 'red')], { id: 'q' }),
      ]),
      { images }
    );
    expect(images.calls).toEqual([{ mediaId: 'red-1', sha256: sha('red') }]);
  });

  it('RI13 resolves the same Media id with another SHA-256 separately', async () => {
    const images = imageResolver((ref) => ({
      bytes: ref.sha256 === sha('red') ? IMG.red : IMG.blue,
      sha256: ref.sha256,
    }));
    await render(
      design([
        page([
          image('a', 'red'),
          layer('b', {
            type: 'image',
            imageRef: { type: 'media', mediaId: 'red-1', sha256: sha('blue') },
            fit: 'contain',
            focalPoint: { x: 0.5, y: 0.5 },
          }),
        ]),
      ]),
      { images }
    );
    expect(images.calls).toEqual([
      { mediaId: 'red-1', sha256: sha('red') },
      { mediaId: 'red-1', sha256: sha('blue') },
    ]);
    // the same bytes for another SHA-256 are refused
    const same = imageResolver((ref) => ({
      bytes: IMG.red,
      sha256: ref.sha256,
    }));
    await expectRenderError(
      () =>
        render(
          design([
            page([
              image('a', 'red'),
              layer('b', {
                type: 'image',
                imageRef: {
                  type: 'media',
                  mediaId: 'red-1',
                  sha256: sha('blue'),
                },
                fit: 'contain',
                focalPoint: { x: 0.5, y: 0.5 },
              }),
            ]),
          ]),
          { images: same }
        ),
      'IMAGE_ASSET_INTEGRITY_ERROR'
    );
  });

  it('RI14, RI16 and the normalization: EXIF orientation applied, sRGB PNG embedded', async () => {
    const stored = await sharp(IMG.rotated).metadata();
    expect([
      stored.format,
      stored.width,
      stored.height,
      stored.orientation,
    ]).toEqual(['jpeg', 4, 2, 6]);
    const { page: laidOut, svg } = await svgOf(
      design([page([image('photo', 'rotated', { width: 20, height: 40 })])])
    );
    const item = laidOut.items[0] as {
      intrinsic: unknown;
      imageRef: { sha256: string };
    };
    expect(item.intrinsic).toEqual({ width: 2, height: 4 });
    // the Design SHA-256 stays the one of the original bytes
    expect(item.imageRef.sha256).toBe(sha('rotated'));
    const embedded = Buffer.from(
      (svg.match(/base64,([^"]+)"/) as RegExpMatchArray)[1],
      'base64'
    );
    const metadata = await sharp(embedded).metadata();
    expect(metadata).toMatchObject({
      format: 'png',
      width: 2,
      height: 4,
      space: 'srgb',
      hasProfile: false,
    });
    expect(metadata.orientation).toBeUndefined();
    for (const name of ['jpeg', 'webp', 'red']) {
      const result = await svgOf(design([page([image('photo', name)])]));
      const data = Buffer.from(
        (result.svg.match(/base64,([^"]+)"/) as RegExpMatchArray)[1],
        'base64'
      );
      expect(await sharp(data).metadata()).toMatchObject({
        format: 'png',
        space: 'srgb',
      });
    }
  });

  it('RI15 keeps alpha: a transparent image shows what is below', async () => {
    const px = await renderPixels([
      rect('under', { width: 200, fill: literal('#ff0000') }),
      image('photo', 'clear', { width: 200, height: 100 }),
    ]);
    expect(px(100, 50)).toEqual(RED);
  });

  it('RI17 does not change the resolver bytes and hands it a copy of the reference', async () => {
    const bytes = new Uint8Array(IMG.red);
    const before = Buffer.from(bytes);
    const images = imageResolver((ref) => {
      expect(Object.keys(ref)).toEqual(['mediaId', 'sha256']);
      (ref as { mediaId: string }).mediaId = 'changed';
      return { bytes, sha256: sha('red') };
    });
    const document = design([page([image('photo', 'red')])]);
    const before2 = JSON.stringify(document);
    const result = await render(document, { images });
    expect(Buffer.from(bytes).equals(before)).toBe(true);
    expect(JSON.stringify(document)).toBe(before2);
    expect(result.assets.images).toEqual([
      { mediaId: 'red-1', sha256: sha('red') },
    ]);
  });

  it('does not resolve the image of a hidden layer', async () => {
    const images = imageResolver();
    await render(
      design([
        page([
          image('ghost', 'missing', {
            visible: false,
            imageRef: {
              type: 'media',
              mediaId: 'missing',
              sha256: 'f'.repeat(64),
            },
          }),
        ]),
      ]),
      { images }
    );
    expect(images.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fonts through the renderer
// ---------------------------------------------------------------------------

describe('design renderer: fonts', () => {
  it('resolves each font once and records its file in the assets', async () => {
    const fonts = fontResolver();
    const result = await render(
      design([
        page([
          text('a', 'Hi'),
          text('b', 'there', { y: 50 }),
          image('c', 'red', { x: 120 }),
        ]),
      ]),
      { fonts }
    );
    expect(fonts.calls).toEqual([
      { family: 'Geist', weight: 400, style: 'normal' },
    ]);
    expect(result.assets.fonts).toEqual([{ key: FONT_KEY, sha256: GEIST_SHA }]);
  });

  it('records the font of an empty text, which the layout resolved', async () => {
    const result = await render(design([page([text('a', '')])]));
    expect(result.assets.fonts).toEqual([{ key: FONT_KEY, sha256: GEIST_SHA }]);
  });

  it('does not resolve the font of a hidden text layer', async () => {
    const fonts = fontResolver(() => null);
    await render(design([page([text('a', 'A', { visible: false })])]), {
      fonts,
    });
    expect(fonts.calls).toEqual([]);
  });

  it('RE4 fails without the exact font, with no fallback', async () => {
    const fonts = fontResolver();
    await expectRenderError(
      () =>
        render(
          design([
            page([text('a', 'A', { font: { ...GEIST_FONT, weight: 700 } })]),
          ]),
          { fonts }
        ),
      'FONT_ASSET_UNAVAILABLE'
    );
    expect(fonts.calls).toEqual([
      { family: 'Geist', weight: 700, style: 'normal' },
    ]);
  });

  it('RE5, RE6 and RE13 report the font failure behind the layout error', async () => {
    const one = design([page([text('a', 'A')])]);
    const junk = Buffer.from(`${FONT_MARKER} not a font`);
    await expectRenderError(
      () =>
        render(one, {
          fonts: fontResolver(() =>
            geistAsset({ bytes: junk, sha256: designRenderSha256(junk) })
          ),
        }),
      'FONT_ASSET_INVALID'
    );
    await expectRenderError(
      () =>
        render(one, {
          fonts: fontResolver(() => geistAsset({ sha256: 'c'.repeat(64) })),
        }),
      'FONT_ASSET_INTEGRITY_ERROR'
    );
    await expectRenderError(
      () =>
        render(one, {
          fonts: fontResolver(() => {
            throw new Error(FONT_MARKER);
          }),
        }),
      'FONT_ASSET_UNAVAILABLE'
    );
    const collection = Buffer.concat([Buffer.from('ttcf'), GEIST.subarray(4)]);
    await expectRenderError(
      () =>
        render(one, {
          fonts: fontResolver(() =>
            geistAsset({
              bytes: collection,
              sha256: designRenderSha256(collection),
            })
          ),
        }),
      'FONT_ASSET_UNSUPPORTED'
    );
  });

  it('refuses one font key for two different fonts', async () => {
    const fonts = fontResolver(() => geistAsset());
    await expectRenderError(
      () =>
        render(
          design([
            page([
              text('a', 'A'),
              text('b', 'B', { font: { ...GEIST_FONT, weight: 700 } }),
            ]),
          ]),
          { fonts }
        ),
      'FONT_ASSET_INVALID'
    );
  });

  it('refuses right-to-left text it cannot shape', async () => {
    await expectRenderError(
      () => render(design([page([text('a', 'שלום')])])),
      'FONT_SHAPING_UNSUPPORTED'
    );
  });
});

// ---------------------------------------------------------------------------
// Errors and input
// ---------------------------------------------------------------------------

describe('design renderer: errors', () => {
  const valid = () => inputOf(design([page([])]));

  it.each([
    ['no input', () => null],
    ['an array', () => []],
    ['no page id', () => ({ ...valid(), pageId: undefined })],
    ['a numeric page id', () => ({ ...valid(), pageId: 1 })],
    ['no font resolver', () => ({ ...valid(), fonts: undefined })],
    ['a font resolver without resolveFont', () => ({ ...valid(), fonts: {} })],
    ['no image resolver', () => ({ ...valid(), images: null })],
    [
      'an image resolver without resolveImage',
      () => ({ ...valid(), images: { getImageMetadata: () => null } }),
    ],
  ])('RE1 refuses %s', async (_name, input) => {
    await expectRenderError(
      () =>
        renderContentStudioDesignPage(
          input() as ContentStudioDesignRenderInput
        ),
      'INVALID_INPUT'
    );
  });

  it('RE2 renders only the exact page id, with no fallback', async () => {
    await expectRenderError(
      () => render(design([page([])]), { pageId: 'P' }),
      'PAGE_NOT_FOUND'
    );
    await expectRenderError(
      () => render(design([page([])]), { pageId: '' }),
      'PAGE_NOT_FOUND'
    );
    const second = await render(
      design([
        page([], { width: 64, height: 64 }),
        page([], { id: 'q', width: 80, height: 90 }),
      ]),
      { pageId: 'q' }
    );
    expect([second.pageId, second.width, second.height]).toEqual(['q', 80, 90]);
  });

  it('RE3 maps Brand Kit context problems to one code', async () => {
    const branded = design([page([rect('r', { fill: brand('accent') })])], REF);
    await expectRenderError(() => render(branded), 'BRAND_CONTEXT_ERROR');
    await expectRenderError(
      () =>
        render(branded, {
          brandKit: { ref: { ...REF, revisionNumber: 4 }, content: KIT },
        }),
      'BRAND_CONTEXT_ERROR'
    );
    await expectRenderError(
      () =>
        render(design([page([rect('r', { fill: brand('missing') })])], REF), {
          brandKit: CONTEXT,
        }),
      'BRAND_CONTEXT_ERROR'
    );
  });

  it('maps an invalid document to LAYOUT_FAILED; a document cannot carry an href', async () => {
    await expectRenderError(
      () => render({ schemaVersion: 1 }),
      'LAYOUT_FAILED'
    );
    await expectRenderError(
      () =>
        render(
          design([
            page([
              image('photo', 'red', { href: 'https://example.com/x.png' }),
            ]),
          ])
        ),
      'LAYOUT_FAILED'
    );
    await expectRenderError(
      () =>
        render(
          design([page([rect('r', { dataUrl: 'data:image/png;base64,AAAA' })])])
        ),
      'LAYOUT_FAILED'
    );
  });

  it('reports the failure the layout meets first', async () => {
    const missingFont = text('t', 'A', {
      font: { ...GEIST_FONT, family: 'Missing' },
    });
    const missingImage = image('i', 'missing', {
      imageRef: { type: 'media', mediaId: 'missing', sha256: 'e'.repeat(64) },
    });
    await expectRenderError(
      () => render(design([page([missingImage, missingFont])])),
      'IMAGE_ASSET_UNAVAILABLE'
    );
    await expectRenderError(
      () => render(design([page([missingFont, missingImage])])),
      'FONT_ASSET_UNAVAILABLE'
    );
    // an image that loads fine does not hide a later failure
    await expectRenderError(
      () => render(design([page([image('i', 'red'), missingFont])])),
      'FONT_ASSET_UNAVAILABLE'
    );
    await expectRenderError(
      () =>
        render(
          design([
            page([image('i', 'red'), rect('r', { fill: brand('accent') })]),
          ])
        ),
      'BRAND_CONTEXT_ERROR'
    );
  });

  it('RE14 logs nothing', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (name) => jest.spyOn(console, name).mockImplementation(() => undefined)
    );
    try {
      await render(goldenDocument(), goldenOptions());
      await renderErrorOf(() =>
        render(
          design([
            page([
              text('t', 'A', { font: { ...GEIST_FONT, family: 'Missing' } }),
            ]),
          ])
        )
      );
      await renderErrorOf(() => rasterizeContentStudioDesignSvg('<svg', 1, 1));
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it('has fixed messages', () => {
    const codes: ContentStudioDesignRenderErrorCode[] = [
      'INVALID_INPUT',
      'PAGE_NOT_FOUND',
      'BRAND_CONTEXT_ERROR',
      'FONT_ASSET_UNAVAILABLE',
      'FONT_ASSET_INVALID',
      'FONT_ASSET_INTEGRITY_ERROR',
      'FONT_ASSET_UNSUPPORTED',
      'FONT_SHAPING_UNSUPPORTED',
      'GLYPH_UNAVAILABLE',
      'IMAGE_ASSET_UNAVAILABLE',
      'IMAGE_ASSET_INVALID',
      'IMAGE_ASSET_INTEGRITY_ERROR',
      'IMAGE_ASSET_UNSUPPORTED',
      'LAYOUT_FAILED',
      'RENDER_OUTPUT_TOO_LARGE',
      'RENDER_FAILED',
    ];
    expect(
      codes.map((code) => [
        code,
        new ContentStudioDesignRenderError(code).message,
      ])
    ).toEqual([
      ['INVALID_INPUT', 'The design render input is invalid.'],
      ['PAGE_NOT_FOUND', 'The design page is not available.'],
      [
        'BRAND_CONTEXT_ERROR',
        'The design Brand Kit context could not be rendered.',
      ],
      ['FONT_ASSET_UNAVAILABLE', 'A design font is unavailable.'],
      ['FONT_ASSET_INVALID', 'A design font file is invalid.'],
      [
        'FONT_ASSET_INTEGRITY_ERROR',
        'A design font file failed its integrity check.',
      ],
      ['FONT_ASSET_UNSUPPORTED', 'A design font file is not supported.'],
      ['FONT_SHAPING_UNSUPPORTED', 'A design text could not be shaped.'],
      ['GLYPH_UNAVAILABLE', 'A design glyph is unavailable.'],
      ['IMAGE_ASSET_UNAVAILABLE', 'A design image is unavailable.'],
      ['IMAGE_ASSET_INVALID', 'A design image file is invalid.'],
      [
        'IMAGE_ASSET_INTEGRITY_ERROR',
        'A design image failed its integrity check.',
      ],
      ['IMAGE_ASSET_UNSUPPORTED', 'A design image format is not supported.'],
      ['LAYOUT_FAILED', 'The design could not be laid out.'],
      [
        'RENDER_OUTPUT_TOO_LARGE',
        'The rendered design is larger than allowed.',
      ],
      ['RENDER_FAILED', 'The design could not be rendered.'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// The representative fixture
// ---------------------------------------------------------------------------

const KIT = parseContentStudioBrandKitContent({
  schemaVersion: 1,
  identity: { brandName: 'Acme', tagline: '', description: '' },
  colors: [
    { id: 'ink', name: 'Ink', value: '#1A1A1A', role: 'text' },
    { id: 'accent', name: 'Accent', value: '#E4572E', role: 'accent' },
  ],
  typography: [
    {
      id: 'heading',
      name: 'Heading',
      family: 'Geist',
      weight: 400,
      style: 'normal',
      role: 'heading',
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

function goldenDocument() {
  return design(
    [
      page(
        [
          rect('block', { width: 240, height: 90, fill: brand('accent') }),
          ellipse('dot', {
            x: 180,
            y: 100,
            width: 40,
            height: 40,
            fill: literal('#00AA00'),
          }),
          text('title', 'Hi', {
            x: 10,
            y: 10,
            width: 160,
            height: 60,
            fontSize: 40,
            font: brand('heading'),
            color: brand('ink'),
          }),
          text('caption', 'aa aa aa', {
            x: 10,
            y: 100,
            width: 80,
            height: 20,
            fontSize: 30,
            overflow: 'shrink',
          }),
          image('photo', 'halves', {
            x: 100,
            y: 100,
            width: 60,
            height: 60,
            fit: 'contain',
          }),
          image('hero', 'blue', {
            x: 10,
            y: 130,
            width: 80,
            height: 40,
            fit: 'cover',
            focalPoint: { x: 0.5, y: 0 },
          }),
          rect('veil', {
            x: 120,
            y: 60,
            width: 100,
            height: 20,
            rotation: 30,
            opacity: 0.5,
          }),
          image('ghost', 'missing', {
            visible: false,
            imageRef: {
              type: 'media',
              mediaId: 'missing',
              sha256: 'd'.repeat(64),
            },
          }),
        ],
        {
          width: 240,
          height: 180,
          background: { type: 'solid', color: literal('#F0F0F0') },
        }
      ),
    ],
    REF
  );
}
const goldenOptions = (): Options => ({
  brandKit: CONTEXT,
  fonts: fontResolver(),
  images: imageResolver(),
});

describe('design renderer: representative page', () => {
  it('lays out, draws and rasterizes a whole page', async () => {
    const options = goldenOptions();
    const {
      svg,
      page: laidOut,
      assets,
    } = await svgOf(goldenDocument(), options);
    expect(laidOut.items.map((item) => item.layerId)).toEqual([
      'block',
      'dot',
      'title',
      'caption',
      'photo',
      'hero',
      'veil',
    ]);
    // no hidden asset was asked for
    expect((options.images as ReturnType<typeof imageResolver>).calls).toEqual([
      { mediaId: 'halves-1', sha256: sha('halves') },
      { mediaId: 'blue-1', sha256: sha('blue') },
    ]);
    expect((options.fonts as ReturnType<typeof fontResolver>).calls).toEqual([
      { family: 'Geist', weight: 400, style: 'normal' },
    ]);
    // the item groups, in order
    const groups = Array.from(
      svg.matchAll(
        /<g(?: transform="[^"]*")?(?: opacity="[^"]*")?><(rect|ellipse|defs)/g
      ),
      (match) => match[1]
    );
    expect(groups).toEqual([
      'rect',
      'ellipse',
      'defs',
      'defs',
      'defs',
      'defs',
      'rect',
    ]);
    expect(svg).toContain(
      '<rect x="0" y="0" width="240" height="90" fill="#e4572e"/>'
    );
    expect(svg).toContain('<g clip-path="url(#clip-0)" fill="#1a1a1a">');
    expect(svg).toContain('<g transform="rotate(30 170 70)" opacity="0.5">');
    expect((svg.match(/data:image\/png;base64,/g) ?? []).length).toBe(2);
    expect((svg.match(/<path /g) ?? []).length).toBe(2 + 6);
    expect(assets).toEqual({
      fonts: [{ key: FONT_KEY, sha256: GEIST_SHA }],
      images: [
        { mediaId: 'halves-1', sha256: sha('halves') },
        { mediaId: 'blue-1', sha256: sha('blue') },
      ],
    });

    const result = await render(goldenDocument(), goldenOptions());
    expect([result.width, result.height, result.mimeType]).toEqual([
      240,
      180,
      'image/png',
    ]);
    expect(result.assets).toEqual(assets);
    const px = await pixelsOf(result.bytes);
    expect(px(235, 5)).toEqual([0xe4, 0x57, 0x2e]);
    expect(px(200, 120)).toEqual([0, 0xaa, 0]);
    expect(px(235, 175)).toEqual([0xf0, 0xf0, 0xf0]);
    // the contain image keeps its margins; the cover image is blue
    expect(px(130, 105)).toEqual([0xf0, 0xf0, 0xf0]);
    expect(px(110, 130)).toEqual(RED);
    expect(px(150, 130)).toEqual(BLUE);
    expect(px(50, 150)).toEqual(BLUE);
    // the semi-transparent rotated veil over the accent block
    near(px(170, 70), [0xe4 / 2, 0x57 / 2, 0x2e / 2], 2);
  });

  it('pins the SVG and, for this Sharp/libvips build, the PNG', async () => {
    const { svg } = await svgOf(goldenDocument(), goldenOptions());
    expect(designRenderSha256(Buffer.from(svg))).toBe(GOLDEN_SVG_SHA256);
    expect((await render(goldenDocument(), goldenOptions())).sha256).toBe(
      GOLDEN_PNG_SHA256
    );
  });

  it('renders only the selected page assets, though the layout resolves every page', async () => {
    const images = imageResolver();
    const result = await render(
      design([
        page([
          text('t', 'A'),
          image('a', 'red'),
          image('b', 'red'),
          image('c', 'blue'),
        ]),
        page([image('d', 'halves')], { id: 'q' }),
      ]),
      { images }
    );
    expect(images.calls.map((call) => call.mediaId)).toEqual([
      'red-1',
      'blue-1',
      'halves-1',
    ]);
    expect(result.assets).toEqual({
      fonts: [{ key: FONT_KEY, sha256: GEIST_SHA }],
      images: [
        { mediaId: 'red-1', sha256: sha('red') },
        { mediaId: 'blue-1', sha256: sha('blue') },
      ],
    });
  });

  it('returns its own bytes', async () => {
    const first = await render(goldenDocument(), goldenOptions());
    const copy = Buffer.from(first.bytes);
    first.bytes.fill(0);
    const second = await render(goldenDocument(), goldenOptions());
    expect(second.bytes.equals(copy)).toBe(true);
  });
});

// version-sensitive pins (see the top of this file)
const GOLDEN_SVG_SHA256 =
  '03a765441d41ddf89f369ae870f2a9d517191a68c9b263f95974864ddbefa88f';
const GOLDEN_PNG_SHA256 =
  '35627d7750f3aebbedf672d07eb9b99965cf014c808589742e0fde4da7636992';

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

describe('design renderer: boundaries', () => {
  const ROOT_DIR = path.join(__dirname, '../../../../../../');
  const RENDER = [
    'design.render.types.ts',
    'design.render.fonts.ts',
    'design.render.images.ts',
    'design.render.svg.ts',
    'design.renderer.ts',
  ];
  const LAYOUT = [
    'design.layout.ts',
    'design.layout.text.ts',
    'design.layout.types.ts',
  ];
  const read = (file: string) => fs.readFileSync(file, 'utf8');
  const renderSources = RENDER.map((file) => read(path.join(__dirname, file)));
  const layoutSources = LAYOUT.map((file) =>
    read(path.join(__dirname, '../layout', file))
  );
  const imports = (source: string) =>
    Array.from(source.matchAll(/from '([^']+)'/g), (match) => match[1]);
  const code = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('RBOUND1 and RBOUND2 keep fontkit and Sharp out of the layout engine', () => {
    for (const source of layoutSources) {
      for (const specifier of imports(source)) {
        expect(['fontkit', 'sharp']).not.toContain(specifier);
      }
    }
  });

  it('RBOUND3 lets only the renderer import fontkit and Sharp', () => {
    const allowed = [
      'fontkit',
      'sharp',
      'crypto',
      '@gitroom/nestjs-libraries/content-studio/design/design.document',
      '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout',
      '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout.types',
      ...RENDER.map(
        (file) =>
          `@gitroom/nestjs-libraries/content-studio/design/render/${file.replace(
            /\.ts$/,
            ''
          )}`
      ),
    ];
    for (const source of renderSources) {
      for (const specifier of imports(source)) {
        expect(allowed).toContain(specifier);
      }
    }
    expect(imports(renderSources[1])).toContain('fontkit');
    expect(imports(renderSources[2])).toContain('sharp');
    // no other Content Studio production file uses fontkit
    const walk = (dir: string): string[] =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) =>
          entry.isDirectory()
            ? walk(path.join(dir, entry.name))
            : [path.join(dir, entry.name)]
        );
    const users = walk(path.join(__dirname, '../../'))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .filter((file) => imports(read(file)).includes('fontkit'))
      .map((file) => path.basename(file));
    expect(users).toEqual(['design.render.fonts.ts']);
  });

  it.each([
    'fabric',
    'canvas',
    'jsdom',
    'puppeteer',
    'playwright',
    'svgdom',
    'resvg',
    'opentype',
    'axios',
    'undici',
    'node-fetch',
    'got',
    'ky',
    'safe.fetch',
    'http',
    'https',
    'net',
    'dns',
    'fs',
    'path',
    'prisma',
    '@nestjs',
    'database',
    'sources',
    '/ai/',
    'brand.kit.repository',
    'design.service',
  ])('RBOUND4-8 the renderer never imports %s', (name) => {
    for (const source of renderSources) {
      for (const specifier of imports(source)) {
        expect(specifier === name || specifier.includes(name)).toBe(false);
      }
      expect(source).not.toMatch(
        new RegExp(
          `require\\(\\s*['"][^'"]*${name.replace(
            /[.*+?^${}()|[\]\\/]/g,
            '\\$&'
          )}`
        )
      );
    }
  });

  it('RBOUND4 and RBOUND5 use no network, DOM, file, clock, randomness, environment or log', () => {
    for (const source of renderSources) {
      const body = code(source);
      for (const pattern of [
        /\bfetch\s*\(/,
        /XMLHttpRequest/,
        /WebSocket/,
        /\bwindow\b/,
        /\bdocument\./,
        /DOMParser/,
        /\bprocess\./,
        /\bconsole\./,
        /\bLogger\b/,
        /Math\.random/,
        /randomUUID/,
        /\bDate\b/,
        /\brequire\s*\(/,
        /\bimport\s*\(/,
        /readFile|createReadStream|existsSync/,
        /<text|<tspan|foreignObject|<style|<script|xlink:href/,
      ]) {
        expect(body).not.toMatch(pattern);
      }
    }
  });

  it('RBOUND10 writes only data:image/png hrefs', () => {
    const svgSource = renderSources[3];
    expect(
      Array.from(svgSource.matchAll(/href="([^"$]*)/g), (match) => match[1])
    ).toEqual(['data:image/png;base64,']);
  });

  // P4-05 adds the one render route, through its render service; the
  // controller, module and design service still never import the renderer
  it('adds no API route, provider or frontend use of its own', () => {
    const controller = read(
      path.join(
        ROOT_DIR,
        'apps/backend/src/api/routes/content-studio.controller.ts'
      )
    );
    expect(
      controller.match(/@(Get|Post|Put|Patch|Delete)\('[^']*\/render'\)/g)
    ).toEqual(["@Post('/designs/:id/render')"]);
    for (const route of ['/preview', '/export']) {
      expect(controller).not.toContain(route);
    }
    for (const file of [
      'apps/backend/src/api/routes/content-studio.controller.ts',
      'libraries/nestjs-libraries/src/database/prisma/database.module.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design.service.ts',
    ]) {
      expect(read(path.join(ROOT_DIR, file))).not.toMatch(
        /design\.render|design\.renderer/
      );
    }
  });

  it('pins fontkit as a direct dependency', () => {
    const manifest = JSON.parse(read(path.join(ROOT_DIR, 'package.json')));
    expect(manifest.dependencies.fontkit).toBe('1.9.0');
    expect(manifest.dependencies.sharp).toBe('^0.33.4');
  });
});
