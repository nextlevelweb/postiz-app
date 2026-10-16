import * as fontkitModule from 'fontkit';
import {
  ContentStudioDesignFontMetrics,
  ContentStudioDesignFontSpec,
  ContentStudioDesignShapedGlyph,
  DESIGN_LAYOUT_FONT_KEY,
} from '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout.types';
import {
  ContentStudioDesignRenderError,
  ContentStudioDesignRenderErrorCode,
  ContentStudioRenderFontResolver,
  DESIGN_RENDER_FONT_MAX_BYTES,
  DESIGN_RENDER_GLYPH_PATH_MAX,
  designRenderAssetBytes,
  designRenderSha256,
} from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.types';

// Fonts for one render: the trusted resolver's bytes, checked, parsed once
// with fontkit (1.9) and used twice: as the layout engine's font provider
// (metrics and shaping) and for the glyph outlines the SVG draws. Both read
// the same parsed font, so what is laid out is what is drawn. Nothing is
// cached beyond the render

// The parts of fontkit 1.9 used here; the package has no types
interface FontkitGlyph {
  id: number;
  codePoints: number[];
  path: { toSVG(): string };
}
interface FontkitFont {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  numGlyphs: number;
  layout(text: string): {
    glyphs: FontkitGlyph[];
    positions: Array<{
      xAdvance: number;
      yAdvance: number;
      xOffset: number;
      yOffset: number;
    }>;
    direction: string;
  };
  getGlyph(id: number): FontkitGlyph;
  glyphForCodePoint(codePoint: number): FontkitGlyph;
}
const fontkit = fontkitModule as unknown as {
  create(buffer: Buffer): unknown;
};

// sfnt versions of a single TrueType or OpenType (CFF) font
const SINGLE_FONT = [0x00010000, 0x74727565, 0x4f54544f];
// collections (ttcf) and wrapped fonts (wOFF, wOF2) are not used in v1
const OTHER_FONT = [0x74746366, 0x774f4646, 0x774f4632];
// the path data fontkit writes: commands and numbers only
const SVG_PATH_DATA = /^[MLHVCSQTAZmlhvcsqtaz0-9.eE+\-\s,]*$/;

// The characters fontkit 1.9 draws as an empty space glyph (its copy of the
// Unicode default ignorables), whose glyph then names U+0020
const isDefaultIgnorable = (codePoint: number) => {
  const plane = codePoint >> 16;
  if (plane === 0) {
    switch (codePoint >> 8) {
      case 0x00:
        return codePoint === 0x00ad;
      case 0x03:
        return codePoint === 0x034f;
      case 0x06:
        return codePoint === 0x061c;
      case 0x17:
        return codePoint >= 0x17b4 && codePoint <= 0x17b5;
      case 0x18:
        return codePoint >= 0x180b && codePoint <= 0x180e;
      case 0x20:
        return (
          (codePoint >= 0x200b && codePoint <= 0x200f) ||
          (codePoint >= 0x202a && codePoint <= 0x202e) ||
          (codePoint >= 0x2060 && codePoint <= 0x206f)
        );
      case 0xfe:
        return (
          (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || codePoint === 0xfeff
        );
      case 0xff:
        return codePoint >= 0xfff0 && codePoint <= 0xfff8;
      default:
        return false;
    }
  }
  if (plane === 0x01) {
    return (
      (codePoint >= 0x1bca0 && codePoint <= 0x1bca3) ||
      (codePoint >= 0x1d173 && codePoint <= 0x1d17a)
    );
  }
  return plane === 0x0e && codePoint >= 0xe0000 && codePoint <= 0xe0fff;
};

// The UTF-16 cluster of every shaped glyph. fontkit 1.9 has no string
// indices; each glyph names the code points it stands for, in order: one
// for a plain glyph, several for a ligature ("fi"), a code point and its
// variation selector. The glyphs must consume the text's code points
// exactly, left to right; a glyph's cluster is the offset of its first one.
// fontkit reuses one glyph object per glyph id, so a glyph can name the
// code points it was first made for (two missing characters share .notdef;
// U+FB01 after "fi" shares the ligature). Such a glyph stands for one code
// point when the font maps that code point to it, or when the code point
// is one fontkit hides behind the space glyph. Anything else (reordering,
// decomposition, an unprovable ligature) returns null
export function contentStudioDesignGlyphClusters(
  text: string,
  glyphs: Array<{ id: number; codePoints: number[] }>,
  glyphIdOf: (codePoint: number) => number
): number[] | null {
  const points: Array<{ codePoint: number; start: number }> = [];
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index) as number;
    points.push({ codePoint, start: index });
    index += codePoint > 0xffff ? 2 : 1;
  }
  const clusters: number[] = [];
  let cursor = 0;
  for (const glyph of glyphs) {
    const named = glyph.codePoints;
    if (
      !Array.isArray(named) ||
      named.length === 0 ||
      cursor >= points.length
    ) {
      return null;
    }
    const exact =
      cursor + named.length <= points.length &&
      named.every(
        (codePoint, index) => points[cursor + index].codePoint === codePoint
      );
    const source = points[cursor].codePoint;
    if (
      !exact &&
      glyphIdOf(source) !== glyph.id &&
      !(isDefaultIgnorable(source) && glyphIdOf(0x20) === glyph.id)
    ) {
      return null;
    }
    clusters.push(points[cursor].start);
    cursor += exact ? named.length : 1;
  }
  return cursor === points.length ? clusters : null;
}

export interface ContentStudioDesignRenderFont {
  key: string;
  sha256: string;
  unitsPerEm: number;
  // SVG path data of one glyph outline in font units (+y up), or '' when it
  // has none (a space)
  glyphPath(id: number): string;
}

interface LoadedFont extends ContentStudioDesignRenderFont {
  metrics: ContentStudioDesignFontMetrics;
}

export function contentStudioDesignRenderFonts(
  resolver: ContentStudioRenderFontResolver
) {
  // per request: the font, null (the resolver has none) or the failure
  const requests = new Map<
    string,
    LoadedFont | null | ContentStudioDesignRenderErrorCode
  >();
  const byKey = new Map<string, LoadedFont>();
  let failure: ContentStudioDesignRenderErrorCode | null = null;
  // The first failure is kept: the layout engine turns whatever a provider
  // throws into its own code, and the renderer reports this one instead
  const fail = (code: ContentStudioDesignRenderErrorCode) => {
    failure = failure ?? code;
    return new ContentStudioDesignRenderError(code);
  };

  const load = (asset: unknown): LoadedFont => {
    let key: unknown;
    try {
      key = (asset as { key?: unknown }).key;
    } catch {
      throw fail('FONT_ASSET_INVALID');
    }
    if (typeof key !== 'string' || !DESIGN_LAYOUT_FONT_KEY.test(key)) {
      throw fail('FONT_ASSET_INVALID');
    }
    let file: { bytes: Buffer; sha256: string };
    try {
      file = designRenderAssetBytes(
        asset,
        DESIGN_RENDER_FONT_MAX_BYTES,
        'FONT_ASSET_INVALID'
      );
    } catch {
      throw fail('FONT_ASSET_INVALID');
    }
    const { bytes, sha256 } = file;
    if (designRenderSha256(bytes) !== sha256) {
      throw fail('FONT_ASSET_INTEGRITY_ERROR');
    }
    // one key, one file
    const known = byKey.get(key);
    if (known && known.sha256 !== sha256) {
      throw fail('FONT_ASSET_INTEGRITY_ERROR');
    }
    const tag = bytes.length >= 4 ? bytes.readUInt32BE(0) : -1;
    if (OTHER_FONT.includes(tag)) {
      throw fail('FONT_ASSET_UNSUPPORTED');
    }
    if (!SINGLE_FONT.includes(tag)) {
      throw fail('FONT_ASSET_INVALID');
    }
    let font: FontkitFont;
    let unitsPerEm: number;
    let ascent: number;
    let descent: number;
    let glyphCount: number;
    try {
      font = fontkit.create(bytes) as FontkitFont;
      if ('fonts' in (font as object)) {
        throw fail('FONT_ASSET_UNSUPPORTED');
      }
      ({ unitsPerEm, ascent, descent } = font);
      glyphCount = font.numGlyphs;
    } catch (error) {
      if (error instanceof ContentStudioDesignRenderError) {
        throw error;
      }
      throw fail('FONT_ASSET_INVALID');
    }
    if (
      !Number.isFinite(unitsPerEm) ||
      unitsPerEm <= 0 ||
      !Number.isSafeInteger(glyphCount) ||
      glyphCount <= 0
    ) {
      throw fail('FONT_ASSET_INVALID');
    }

    // shaping with fontkit's default features (kerning and ligatures
    // included), mapped to the layout engine's generic glyphs
    const shape = (text: string) => {
      let glyphs: ContentStudioDesignShapedGlyph[] | null;
      try {
        const run = font.layout(text);
        if (run.direction === 'rtl') {
          throw fail('FONT_SHAPING_UNSUPPORTED');
        }
        if (run.positions.length !== run.glyphs.length) {
          throw fail('FONT_ASSET_INVALID');
        }
        const clusters = contentStudioDesignGlyphClusters(
          text,
          run.glyphs.map((glyph) => ({
            id: glyph.id,
            codePoints: Array.from(glyph.codePoints ?? []),
          })),
          (codePoint) => font.glyphForCodePoint(codePoint).id
        );
        glyphs =
          clusters &&
          run.glyphs.map((glyph, index) => ({
            id: glyph.id,
            cluster: clusters[index],
            xAdvance: run.positions[index].xAdvance,
            yAdvance: run.positions[index].yAdvance,
            xOffset: run.positions[index].xOffset,
            yOffset: run.positions[index].yOffset,
          }));
      } catch (error) {
        if (error instanceof ContentStudioDesignRenderError) {
          throw error;
        }
        throw fail('FONT_ASSET_INVALID');
      }
      if (!glyphs) {
        throw fail('FONT_SHAPING_UNSUPPORTED');
      }
      return { glyphs };
    };

    const paths = new Map<number, string>();
    const glyphPath = (id: number) => {
      if (!Number.isSafeInteger(id) || id < 0 || id >= glyphCount) {
        throw new ContentStudioDesignRenderError('GLYPH_UNAVAILABLE');
      }
      let data = paths.get(id);
      if (data === undefined) {
        try {
          data = font.getGlyph(id).path.toSVG();
        } catch {
          throw new ContentStudioDesignRenderError('FONT_ASSET_INVALID');
        }
        if (
          typeof data !== 'string' ||
          data.length > DESIGN_RENDER_GLYPH_PATH_MAX ||
          !SVG_PATH_DATA.test(data)
        ) {
          throw new ContentStudioDesignRenderError('FONT_ASSET_INVALID');
        }
        paths.set(id, data);
      }
      return data;
    };

    return {
      key,
      sha256,
      unitsPerEm,
      glyphPath,
      metrics: { key, unitsPerEm, ascent, descent, shape },
    };
  };

  return {
    // the layout engine's font provider
    provider: {
      resolveFont(font: ContentStudioDesignFontSpec) {
        const request = JSON.stringify([font.family, font.weight, font.style]);
        const known = requests.get(request);
        if (typeof known === 'string') {
          throw fail(known);
        }
        if (known !== undefined) {
          return known ? known.metrics : null;
        }
        let loaded: LoadedFont | null;
        try {
          let asset: unknown;
          try {
            asset = resolver.resolveFont({
              family: font.family,
              weight: font.weight,
              style: font.style,
            });
          } catch {
            throw fail('FONT_ASSET_UNAVAILABLE');
          }
          loaded = asset === null || asset === undefined ? null : load(asset);
        } catch (error) {
          requests.set(request, (error as ContentStudioDesignRenderError).code);
          throw error;
        }
        requests.set(request, loaded);
        if (loaded) {
          byKey.set(loaded.key, loaded);
        }
        return loaded ? loaded.metrics : null;
      },
    },
    // the font the layout named by this key
    font(key: string): ContentStudioDesignRenderFont {
      const font = byKey.get(key);
      if (!font) {
        throw new ContentStudioDesignRenderError('RENDER_FAILED');
      }
      return font;
    },
    failure: () => failure,
  };
}
