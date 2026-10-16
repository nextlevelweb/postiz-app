import * as fs from 'fs';
import * as path from 'path';
import { isPlainData } from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';
import { parseContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { layoutContentStudioDesign } from '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout';
import type { ContentStudioDesignLayoutTextItem } from '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout.types';
import {
  contentStudioDesignGlyphClusters,
  contentStudioDesignRenderFonts,
} from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.fonts';
import {
  ContentStudioDesignRenderError,
  ContentStudioDesignRenderErrorCode,
  DESIGN_RENDER_FONT_MAX_BYTES,
  designRenderSha256,
} from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.types';

// The test font: Geist Regular, which next (a direct dependency, 16.3.1)
// ships for @vercel/og at dist/compiled/@vercel/og/Geist-Regular.ttf.
// "Copyright 2024 The Geist Project Authors", SIL Open Font License 1.1 (its
// name table says so). It is read from the installed package at test time,
// never copied into the repository. Facts used below, read from the file
// with fontkit 1.9: 1000 units per em, ascent 1005, descent -295, 973
// glyphs; A = 1 (advance 668), V = 157, a = 227 (551), b = 251, space = 737
// (250, no outline), no-break space = 738, the "fi" ligature = 488 (599),
// .notdef = 0 (600); "AV" kerns A to 562
const GEIST = fs.readFileSync(
  path.join(
    path.dirname(require.resolve('next/package.json')),
    'dist/compiled/@vercel/og/Geist-Regular.ttf'
  )
);
const GEIST_SHA = designRenderSha256(GEIST);
const MARKER = 'RENDER_FONT_PRIVATE_PATH_123';
const SPEC = {
  family: 'Geist',
  weight: 400 as const,
  style: 'normal' as const,
};
const asset = (extra: Record<string, unknown> = {}) => ({
  key: 'geist-regular',
  bytes: GEIST,
  sha256: GEIST_SHA,
  ...extra,
});

const registryFor = (resolve: (font: unknown) => unknown = () => asset()) => {
  const calls: unknown[] = [];
  const registry = contentStudioDesignRenderFonts({
    resolveFont: (font) => {
      calls.push(font);
      return resolve(font) as never;
    },
  });
  return { registry, calls };
};

const metricsOf = (registry: ReturnType<typeof registryFor>['registry']) =>
  registry.provider.resolveFont(SPEC) as NonNullable<
    ReturnType<typeof registry.provider.resolveFont>
  >;

const renderErrorOf = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    return error as ContentStudioDesignRenderError;
  }
  throw new Error('expected a render error');
};

const expectFontFailure = (
  resolve: (font: unknown) => unknown,
  code: ContentStudioDesignRenderErrorCode
) => {
  const { registry } = registryFor(resolve);
  const error = renderErrorOf(() => registry.provider.resolveFont(SPEC));
  expect(error).toBeInstanceOf(ContentStudioDesignRenderError);
  expect(error.code).toBe(code);
  expect(error.message).toBe(new ContentStudioDesignRenderError(code).message);
  expect(registry.failure()).toBe(code);
  expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(MARKER);
  return registry;
};

describe('design render fonts: registry', () => {
  it('RF1, RF12 and RF13 resolve a font with its real metrics', () => {
    const { registry, calls } = registryFor();
    const metrics = metricsOf(registry);
    expect(metrics.key).toBe('geist-regular');
    expect(metrics.unitsPerEm).toBe(1000);
    expect(metrics.ascent).toBe(1005);
    expect(metrics.descent).toBe(-295);
    expect(typeof metrics.shape).toBe('function');
    expect(calls).toEqual([SPEC]);
    expect(registry.failure()).toBeNull();
    expect(registry.font('geist-regular')).toMatchObject({
      key: 'geist-regular',
      sha256: GEIST_SHA,
      unitsPerEm: 1000,
    });
  });

  it('RF2 and RF3 resolve and parse a request once per render', () => {
    const { registry, calls } = registryFor();
    const first = metricsOf(registry);
    expect(metricsOf(registry)).toBe(first);
    expect(calls).toHaveLength(1);
    // a new registry (a new render) asks again
    const other = registryFor();
    metricsOf(other.registry);
    expect(other.calls).toHaveLength(1);
  });

  it('hands the resolver a fresh request with exactly three fields', () => {
    const seen: unknown[] = [];
    const registry = contentStudioDesignRenderFonts({
      resolveFont: (font) => {
        seen.push({ ...font });
        expect(Object.keys(font)).toEqual(['family', 'weight', 'style']);
        (font as { family: string }).family = 'Changed';
        return asset();
      },
    });
    const request = { ...SPEC };
    registry.provider.resolveFont(request);
    expect(request).toEqual(SPEC);
    expect(seen).toEqual([SPEC]);
  });

  it('RF4 returns null when the resolver has no font, asking once', () => {
    const { registry, calls } = registryFor(() => null);
    expect(registry.provider.resolveFont(SPEC)).toBeNull();
    expect(registry.provider.resolveFont(SPEC)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(registry.failure()).toBeNull();
    expect(
      registryFor(() => undefined).registry.provider.resolveFont(SPEC)
    ).toBeNull();
  });

  it('RF5 never passes on what the resolver throws', () => {
    const { registry, calls } = registryFor(() => {
      throw new Error(MARKER);
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = renderErrorOf(() => registry.provider.resolveFont(SPEC));
      expect(error.code).toBe('FONT_ASSET_UNAVAILABLE');
      expect(`${error.message} ${error.stack}`).not.toContain(MARKER);
    }
    expect(calls).toHaveLength(1);
    expect(registry.failure()).toBe('FONT_ASSET_UNAVAILABLE');
  });

  it.each([
    [
      'RF6 empty bytes',
      { bytes: Buffer.alloc(0), sha256: designRenderSha256(Buffer.alloc(0)) },
    ],
    ['bytes that are not bytes', { bytes: 'font' }],
    ['an array of numbers', { bytes: Array.from(GEIST.subarray(0, 10)) }],
    ['no SHA-256', { sha256: undefined }],
    ['an uppercase SHA-256', { sha256: GEIST_SHA.toUpperCase() }],
    ['a short SHA-256', { sha256: GEIST_SHA.slice(1) }],
    ['RF10 an empty key', { key: '' }],
    ['RF10 a key with a newline', { key: 'geist\nregular' }],
    ['RF10 a non-ASCII key', { key: 'géist' }],
    ['RF10 a key above 256 characters', { key: 'k'.repeat(257) }],
    ['RF10 a numeric key', { key: 7 }],
  ])('%s is an invalid font asset', (_name, change) => {
    expectFontFailure(() => asset(change), 'FONT_ASSET_INVALID');
  });

  it('refuses an asset that is not an object or throws when read', () => {
    expectFontFailure(() => 'font', 'FONT_ASSET_INVALID');
    expectFontFailure(
      () => ({
        key: 'k',
        get bytes(): Buffer {
          throw new Error(MARKER);
        },
        sha256: GEIST_SHA,
      }),
      'FONT_ASSET_INVALID'
    );
  });

  it('RF7 refuses a file above 32 MiB', () => {
    const big = Buffer.alloc(DESIGN_RENDER_FONT_MAX_BYTES + 1);
    big.write('OTTO');
    expectFontFailure(
      () => asset({ bytes: big, sha256: designRenderSha256(big) }),
      'FONT_ASSET_INVALID'
    );
  });

  it('RF8 refuses bytes that do not match their SHA-256', () => {
    expectFontFailure(
      () => asset({ sha256: 'a'.repeat(64) }),
      'FONT_ASSET_INTEGRITY_ERROR'
    );
    const changed = Buffer.from(GEIST);
    changed[1000] ^= 1;
    expectFontFailure(
      () => asset({ bytes: changed }),
      'FONT_ASSET_INTEGRITY_ERROR'
    );
  });

  it('binds one key to one file within a render', () => {
    const other = Buffer.concat([GEIST, Buffer.from([0])]);
    const { registry } = registryFor((font) =>
      (font as { weight: number }).weight === 400
        ? asset()
        : asset({ bytes: other, sha256: designRenderSha256(other) })
    );
    metricsOf(registry);
    const error = renderErrorOf(() =>
      registry.provider.resolveFont({ ...SPEC, weight: 700 })
    );
    expect(error.code).toBe('FONT_ASSET_INTEGRITY_ERROR');
  });

  it('RF9 refuses bytes that are not a font', () => {
    const withSha = (bytes: Buffer) => () =>
      asset({ bytes, sha256: designRenderSha256(bytes) });
    expectFontFailure(
      withSha(Buffer.from(`${MARKER} not a font`)),
      'FONT_ASSET_INVALID'
    );
    expectFontFailure(
      withSha(Buffer.concat([Buffer.from('OTTO'), Buffer.alloc(40)])),
      'FONT_ASSET_INVALID'
    );
    expectFontFailure(withSha(Buffer.from([0, 1, 0, 0])), 'FONT_ASSET_INVALID');
    expectFontFailure(withSha(Buffer.from([1])), 'FONT_ASSET_INVALID');
  });

  it.each([
    ['a font collection', 'ttcf'],
    ['a WOFF font', 'wOFF'],
    ['a WOFF2 font', 'wOF2'],
  ])('refuses %s as unsupported', (_name, tag) => {
    const bytes = Buffer.concat([Buffer.from(tag), GEIST.subarray(4)]);
    expectFontFailure(
      () => asset({ bytes, sha256: designRenderSha256(bytes) }),
      'FONT_ASSET_UNSUPPORTED'
    );
  });

  it('records a font whose tables fail while shaping as invalid', () => {
    const damaged = Buffer.from(GEIST);
    damaged.fill(0, 2000, 60000);
    const { registry } = registryFor(() =>
      asset({ bytes: damaged, sha256: designRenderSha256(damaged) })
    );
    const metrics = metricsOf(registry);
    const error = renderErrorOf(() => metrics.shape('A'));
    expect(error.code).toBe('FONT_ASSET_INVALID');
    expect(registry.failure()).toBe('FONT_ASSET_INVALID');
  });

  it('keeps the first failure only', () => {
    const { registry } = registryFor((font) => {
      if ((font as { weight: number }).weight === 700) {
        return asset({ sha256: 'b'.repeat(64) });
      }
      throw new Error(MARKER);
    });
    expect(() =>
      registry.provider.resolveFont({ ...SPEC, weight: 700 })
    ).toThrow(ContentStudioDesignRenderError);
    expect(() => registry.provider.resolveFont(SPEC)).toThrow(
      ContentStudioDesignRenderError
    );
    expect(registry.failure()).toBe('FONT_ASSET_INTEGRITY_ERROR');
  });

  it('does not change the bytes it was given', () => {
    const bytes = new Uint8Array(GEIST);
    const before = Buffer.from(bytes);
    const { registry } = registryFor(() => asset({ bytes }));
    metricsOf(registry).shape('Afi');
    registry.font('geist-regular').glyphPath(1);
    bytes[0] = 9;
    // the registry kept its own copy
    expect(
      registry.font('geist-regular').glyphPath(227).length
    ).toBeGreaterThan(0);
    bytes[0] = before[0];
    expect(Buffer.from(bytes).equals(before)).toBe(true);
  });

  it('fails for a font key the layout did not resolve', () => {
    expect(
      renderErrorOf(() => registryFor().registry.font('missing')).code
    ).toBe('RENDER_FAILED');
  });
});

describe('design render fonts: shaping with fontkit', () => {
  const shape = (text: string) =>
    metricsOf(registryFor().registry).shape(text).glyphs;
  const plain = (id: number, cluster: number, xAdvance: number) => ({
    id,
    cluster,
    xAdvance,
    yAdvance: 0,
    xOffset: 0,
    yOffset: 0,
  });

  it('FS1 and FS8 shape ASCII with the font kerning, values unchanged', () => {
    expect(shape('A')).toEqual([plain(1, 0, 668)]);
    expect(shape('AV')).toEqual([plain(1, 0, 562), plain(157, 1, 667)]);
  });

  it('FS2 shapes a space as a glyph with an advance', () => {
    expect(shape('A V')).toEqual([
      plain(1, 0, 668),
      plain(737, 1, 250),
      plain(157, 2, 667),
    ]);
    expect(shape('a b').map((glyph) => glyph.id)).toEqual([227, 738, 251]);
  });

  it('FS3 gives repeated characters their own clusters', () => {
    expect(shape('aaa')).toEqual([
      plain(227, 0, 551),
      plain(227, 1, 551),
      plain(227, 2, 551),
    ]);
  });

  it('FS4 and FS6 count clusters in UTF-16 code units across surrogate pairs', () => {
    // the font has no emoji: .notdef stands in, one glyph per code point
    expect(
      shape('a\u{1F600}b').map((glyph) => [glyph.id, glyph.cluster])
    ).toEqual([
      [227, 0],
      [0, 1],
      [251, 3],
    ]);
    // two different missing characters share the .notdef glyph object
    expect(shape('\u{1F600}\u{1F642}a').map((glyph) => glyph.cluster)).toEqual([
      0, 2, 4,
    ]);
  });

  it('FS5 maps a ligature to the cluster of its first character', () => {
    expect(shape('fi')).toEqual([plain(488, 0, 599)]);
    expect(shape('afi').map((glyph) => [glyph.id, glyph.cluster])).toEqual([
      [227, 0],
      [488, 1],
    ]);
    // the ligature kerns against the next one
    expect(
      shape('fifi').map((glyph) => [glyph.id, glyph.cluster, glyph.xAdvance])
    ).toEqual([
      [488, 0, 552],
      [488, 2, 599],
    ]);
  });

  it('maps a precomposed ligature character after the shaped ligature to one code point', () => {
    const metrics = metricsOf(registryFor().registry);
    metrics.shape('fi');
    expect(
      metrics.shape('ﬁ fi').glyphs.map((glyph) => [glyph.id, glyph.cluster])
    ).toEqual([
      [488, 0],
      [737, 1],
      [488, 2],
    ]);
  });

  it('FS8 keeps mark offsets from fontkit', () => {
    expect(shape('é')).toEqual([
      plain(262, 0, 561),
      {
        id: 916,
        cluster: 1,
        xAdvance: 0,
        yAdvance: 0,
        xOffset: -355,
        yOffset: -2,
      },
    ]);
  });

  it('FS7 has no vertical advance', () => {
    for (const glyph of shape('Hello, Wörld fi 123')) {
      expect(glyph.yAdvance).toBe(0);
    }
  });

  it('FS9 returns plain generic glyphs, no fontkit objects', () => {
    const result = metricsOf(registryFor().registry).shape('Afi');
    expect(isPlainData(result)).toBe(true);
    expect(Object.keys(result)).toEqual(['glyphs']);
    for (const glyph of result.glyphs) {
      expect(Object.keys(glyph).sort()).toEqual([
        'cluster',
        'id',
        'xAdvance',
        'xOffset',
        'yAdvance',
        'yOffset',
      ]);
    }
  });

  it('accepts a zero-width joiner the font draws as .notdef', () => {
    expect(shape('a‍b').map((glyph) => glyph.cluster)).toEqual([0, 1, 2]);
  });

  it('refuses right-to-left text: v1 has no bidirectional layout', () => {
    const { registry } = registryFor();
    const error = renderErrorOf(() => metricsOf(registry).shape('שלום'));
    expect(error.code).toBe('FONT_SHAPING_UNSUPPORTED');
    expect(registry.failure()).toBe('FONT_SHAPING_UNSUPPORTED');
  });
});

describe('design render fonts: cluster mapping', () => {
  const ids: Record<number, number> = {
    0x61: 10,
    0x62: 11,
    0x66: 12,
    0x69: 13,
    0x20: 3,
  };
  const glyphIdOf = (codePoint: number) => ids[codePoint] ?? 0;
  const clusters = (text: string, glyphs: Array<[number, number[]]>) =>
    contentStudioDesignGlyphClusters(
      text,
      glyphs.map(([id, codePoints]) => ({ id, codePoints })),
      glyphIdOf
    );

  it('maps plain glyphs, ligatures and surrogate pairs', () => {
    expect(
      clusters('ab', [
        [10, [0x61]],
        [11, [0x62]],
      ])
    ).toEqual([0, 1]);
    expect(
      clusters('fia', [
        [99, [0x66, 0x69]],
        [10, [0x61]],
      ])
    ).toEqual([0, 2]);
    expect(
      clusters('a\u{1F600}b', [
        [10, [0x61]],
        [0, [0x1f600]],
        [11, [0x62]],
      ])
    ).toEqual([0, 1, 3]);
    // a code point and its variation selector
    expect(
      clusters('a️b', [
        [50, [0x61, 0xfe0f]],
        [11, [0x62]],
      ])
    ).toEqual([0, 2]);
  });

  it('accepts a reused glyph only where the font maps the code point to it', () => {
    expect(
      clusters('\u{1F600}\u{1F642}', [
        [0, [0x1f600]],
        [0, [0x1f600]],
      ])
    ).toEqual([0, 2]);
    expect(
      clusters('ab', [
        [10, [0x61]],
        [10, [0x61]],
      ])
    ).toBeNull();
    // a default ignorable drawn as the space glyph
    expect(
      clusters('a‍b', [
        [10, [0x61]],
        [3, [0x20]],
        [11, [0x62]],
      ])
    ).toEqual([0, 1, 2]);
    expect(
      clusters('aéb', [
        [10, [0x61]],
        [3, [0x20]],
        [11, [0x62]],
      ])
    ).toBeNull();
  });

  it('returns null for what it cannot prove', () => {
    // reordered
    expect(
      clusters('ab', [
        [11, [0x62]],
        [10, [0x61]],
      ])
    ).toBeNull();
    // a glyph that names nothing
    expect(clusters('a', [[10, []]])).toBeNull();
    // one code point drawn as two glyphs
    expect(
      clusters('a', [
        [10, [0x61]],
        [10, [0x61]],
      ])
    ).toBeNull();
    // code points left over
    expect(clusters('ab', [[10, [0x61]]])).toBeNull();
    // a ligature that names more than the text has
    expect(clusters('f', [[99, [0x66, 0x69]]])).toBeNull();
    expect(clusters('', [])).toEqual([]);
  });
});

describe('design render fonts: glyph paths', () => {
  const font = () => {
    const { registry } = registryFor();
    metricsOf(registry);
    return registry.font('geist-regular');
  };

  it('GP1 returns the outline in font units', () => {
    expect(font().glyphPath(1)).toBe(
      'M20 0L276 710L392 710L648 0L554 0L483 202L185 202L114 0ZM214 286L454 286L334 635Z'
    );
  });

  it('GP2 returns an empty outline for a space', () => {
    expect(font().glyphPath(737)).toBe('');
  });

  it.each([[973], [-1], [1.5], [NaN]])(
    'GP3 refuses the missing glyph id %p',
    (id) => {
      expect(renderErrorOf(() => font().glyphPath(id)).code).toBe(
        'GLYPH_UNAVAILABLE'
      );
    }
  );

  it('GP4 gives the same outline every time', () => {
    const geist = font();
    const first = geist.glyphPath(488);
    expect(geist.glyphPath(488)).toBe(first);
    expect(font().glyphPath(488)).toBe(first);
    expect(first).toMatch(/^[MLHVCSQTAZmlhvcsqtaz0-9.eE+\-\s,]+$/);
  });

  it('GP5 keeps the resolver key out of the outline', () => {
    const { registry } = registryFor(() => asset({ key: MARKER }));
    metricsOf(registry);
    expect(registry.font(MARKER).glyphPath(1)).not.toContain(MARKER);
  });

  it('RF14 lays out only glyph ids the same font has', () => {
    const { registry } = registryFor();
    const layout = layoutContentStudioDesign({
      document: parseContentStudioDesignDocument({
        schemaVersion: 1,
        brandKit: null,
        pages: [
          {
            id: 'p',
            name: '',
            width: 400,
            height: 200,
            background: {
              type: 'solid',
              color: { type: 'literal', value: '#ffffff' },
            },
            layers: [
              {
                id: 't',
                name: '',
                type: 'text',
                x: 0,
                y: 0,
                width: 400,
                height: 200,
                rotation: 0,
                opacity: 1,
                visible: true,
                text: 'Afi AV\u{1F600} é',
                font: { type: 'family', ...SPEC },
                fontSize: 40,
                lineHeight: 1.2,
                letterSpacing: 0,
                color: { type: 'literal', value: '#000000' },
                align: 'left',
                verticalAlign: 'top',
                overflow: 'clip',
              },
            ],
          },
        ],
      }),
      brandKit: null,
      fonts: registry.provider,
      images: { getImageMetadata: () => null },
    });
    const item = layout.pages[0].items[0] as ContentStudioDesignLayoutTextItem;
    expect(item.fontKey).toBe('geist-regular');
    const glyphs = item.lines.flatMap((line) => line.glyphs);
    expect(glyphs.map((glyph) => glyph.id)).toEqual([
      1, 488, 737, 1, 157, 0, 737, 262, 916,
    ]);
    for (const glyph of glyphs) {
      expect(typeof registry.font(item.fontKey).glyphPath(glyph.id)).toBe(
        'string'
      );
    }
  });
});
