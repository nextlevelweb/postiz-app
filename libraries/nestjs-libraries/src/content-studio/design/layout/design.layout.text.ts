import type { ContentStudioDesignTextLayer } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  callLayoutProvider,
  ContentStudioDesignFontSpec,
  ContentStudioDesignLayoutError,
  ContentStudioDesignLayoutLine,
  ContentStudioDesignLayoutTextItem,
  ContentStudioDesignShapedGlyph,
  DESIGN_LAYOUT_FONT_KEY,
  DESIGN_LAYOUT_SHRINK_MIN_FONT_SIZE,
  DESIGN_LAYOUT_SHRINK_STEPS_PER_UNIT,
  DESIGN_LAYOUT_TAB,
  layoutFits,
  layoutItemGeometry,
  layoutNumber,
  layoutRect,
} from '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout.types';

// Text layout: line breaking, shrink-to-fit, alignment and glyph placement,
// all from the advances a font provider shapes. Nothing here measures
// characters itself, so kerning and ligatures are the font's.
//
// The rules, frozen for v1:
// - a tab is four spaces; "\n" ends a logical line; an empty text has no
//   lines, "\n" alone has two empty ones;
// - only the space is a break opportunity (a no-break space is not). A line
//   takes words while the line still fits; when it wraps at spaces, those
//   spaces belong to neither line. Spaces that are not a wrap point are kept,
//   at the start and the end of a logical line too;
// - a word wider than the box is broken between code points (never inside a
//   surrogate pair); a code point wider than the box stands alone;
// - letter spacing (design units, not scaled by shrinking) goes between
//   shaped glyphs: a line of n glyphs is wider by (n - 1) x letterSpacing;
// - a line box is fontSize x lineHeight; the em box (ascent + |descent|) is
//   centered in it vertically, which places the baseline;
// - every line is laid out, also the ones the box clips.
//
// There is no grapheme segmentation (a combining mark or an emoji sequence
// can be broken between code points when one word is wider than the box)
// and no bidirectional reordering: lines keep the order of the text and the
// glyph order the font returns

// A font as the layout uses it: the provider's values, checked and copied.
// measure returns the advance sum (font units) and glyph count of a text
export interface ContentStudioDesignLayoutFont {
  key: string;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  measure(text: string): { units: number; count: number };
  shape(text: string): ContentStudioDesignShapedGlyph[];
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isIndex = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const invalidMetrics = () =>
  new ContentStudioDesignLayoutError('FONT_METRICS_INVALID');

// The glyphs of one shaped text, copied. Anything that is not a finite
// number where one belongs fails, so NaN never reaches the output; a
// vertical advance means a writing mode v1 does not lay out
function shapedGlyphs(result: unknown, length: number) {
  const glyphs = callLayoutProvider(() => {
    const list =
      typeof result === 'object' && result !== null
        ? (result as { glyphs?: unknown }).glyphs
        : undefined;
    if (!Array.isArray(list)) {
      return null;
    }
    return Array.from(list, (glyph: unknown) => {
      if (typeof glyph !== 'object' || glyph === null) {
        return null;
      }
      const { id, cluster, xAdvance, yAdvance, xOffset, yOffset } =
        glyph as Record<string, unknown>;
      return { id, cluster, xAdvance, yAdvance, xOffset, yOffset };
    });
  }, 'FONT_METRICS_INVALID');
  if (!glyphs) {
    throw invalidMetrics();
  }
  let vertical = false;
  for (const glyph of glyphs) {
    if (
      !glyph ||
      !isIndex(glyph.id) ||
      !isIndex(glyph.cluster) ||
      glyph.cluster >= length ||
      !isFiniteNumber(glyph.xAdvance) ||
      !isFiniteNumber(glyph.yAdvance) ||
      !isFiniteNumber(glyph.xOffset) ||
      !isFiniteNumber(glyph.yOffset)
    ) {
      throw invalidMetrics();
    }
    vertical = vertical || glyph.yAdvance !== 0;
  }
  if (vertical) {
    throw new ContentStudioDesignLayoutError('FONT_SHAPING_UNSUPPORTED');
  }
  return glyphs as ContentStudioDesignShapedGlyph[];
}

// Checks what a font provider resolved and wraps it for this layout only.
// Measurements are cached per text within the layout; shaping for the final
// lines asks the provider again
export function contentStudioDesignLayoutFont(
  metrics: unknown
): ContentStudioDesignLayoutFont {
  const read = callLayoutProvider(() => {
    if (typeof metrics !== 'object' || metrics === null) {
      return null;
    }
    const { key, unitsPerEm, ascent, descent, shape } = metrics as Record<
      string,
      unknown
    >;
    return { key, unitsPerEm, ascent, descent, shape };
  }, 'FONT_METRICS_INVALID');
  if (
    !read ||
    typeof read.key !== 'string' ||
    !DESIGN_LAYOUT_FONT_KEY.test(read.key) ||
    !isFiniteNumber(read.unitsPerEm) ||
    read.unitsPerEm <= 0 ||
    !isFiniteNumber(read.ascent) ||
    !isFiniteNumber(read.descent) ||
    typeof read.shape !== 'function'
  ) {
    throw invalidMetrics();
  }
  const shapeFunction = read.shape;
  const shape = (text: string) =>
    shapedGlyphs(
      callLayoutProvider(
        () => shapeFunction.call(metrics, text),
        'FONT_UNAVAILABLE'
      ),
      text.length
    );
  const measured = new Map<string, { units: number; count: number }>();
  return {
    key: read.key,
    unitsPerEm: read.unitsPerEm,
    ascent: read.ascent,
    descent: read.descent,
    shape,
    measure(text) {
      let result = measured.get(text);
      if (!result) {
        const glyphs = shape(text);
        let units = 0;
        for (const glyph of glyphs) {
          units += glyph.xAdvance;
        }
        result = { units, count: glyphs.length };
        measured.set(text, result);
      }
      return result;
    },
  };
}

// a derived text number: overflowing font values fail instead of reaching
// the output
const textNumber = (value: number) => {
  if (!Number.isFinite(value)) {
    throw invalidMetrics();
  }
  return layoutNumber(value);
};

// the UTF-16 length of the code point at index: a surrogate pair stays whole
const codePointLength = (text: string, index: number) =>
  (text.codePointAt(index) as number) > 0xffff ? 2 : 1;

// Breaks one logical line. A candidate end is the end of a word, or the end
// of the line when it ends in spaces. The line grows while the next
// candidate still fits; then it wraps and the spaces after its end are
// skipped. When not even the first word fits, it is broken between code
// points, at least one per line, so every step moves on
function breakLogicalLine(text: string, fits: (text: string) => boolean) {
  if (text === '') {
    return [''];
  }
  const ends: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (
      text[index] !== ' ' &&
      (index + 1 === text.length || text[index + 1] === ' ')
    ) {
      ends.push(index + 1);
    }
  }
  if (text[text.length - 1] === ' ') {
    ends.push(text.length);
  }
  const lines: string[] = [];
  let start = 0;
  let next = 0;
  while (start < text.length) {
    while (ends[next] <= start) {
      next += 1;
    }
    let end = -1;
    for (
      let candidate = next;
      candidate < ends.length && fits(text.slice(start, ends[candidate]));
      candidate += 1
    ) {
      end = ends[candidate];
    }
    if (end === -1) {
      const limit = ends[next];
      end = start + codePointLength(text, start);
      while (end < limit) {
        const longer = end + codePointLength(text, end);
        if (!fits(text.slice(start, longer))) {
          break;
        }
        end = longer;
      }
      lines.push(text.slice(start, end));
      start = end;
    } else {
      lines.push(text.slice(start, end));
      start = end;
      if (end < text.length) {
        while (text[start] === ' ') {
          start += 1;
        }
      }
    }
  }
  return lines;
}

// Lays out one visible text layer whose color and font are resolved
export function layoutContentStudioDesignText(
  layer: ContentStudioDesignTextLayer,
  color: string,
  font: ContentStudioDesignFontSpec,
  metrics: ContentStudioDesignLayoutFont
): ContentStudioDesignLayoutTextItem {
  const logicalLines =
    layer.text === ''
      ? []
      : layer.text.replace(/\t/g, DESIGN_LAYOUT_TAB).split('\n');
  const lineWidth = (glyphUnits: number, count: number, size: number) =>
    count === 0
      ? 0
      : glyphUnits * (size / metrics.unitsPerEm) +
        (count - 1) * layer.letterSpacing;

  // the lines at one font size and whether they fit the box
  const attempt = (size: number) => {
    const width = (text: string) => {
      const { units, count } = metrics.measure(text);
      return lineWidth(units, count, size);
    };
    const fitsWidth = (text: string) =>
      text === '' || layoutFits(width(text), layer.width);
    const lines = logicalLines.flatMap((text) =>
      breakLogicalLine(text, fitsWidth)
    );
    const fits =
      layoutFits(lines.length * (size * layer.lineHeight), layer.height) &&
      lines.every(fitsWidth);
    return { size, lines, fits };
  };

  // Shrink: the requested size when it fits, otherwise the largest fitting
  // size in hundredths below it (a binary search), and 1 when none fits
  let chosen = attempt(layer.fontSize);
  if (layer.overflow === 'shrink' && !chosen.fits) {
    const steps = DESIGN_LAYOUT_SHRINK_STEPS_PER_UNIT;
    let low = DESIGN_LAYOUT_SHRINK_MIN_FONT_SIZE * steps - 1;
    let high = Math.floor(layer.fontSize * steps + 1e-6);
    while (high > low && high / steps >= layer.fontSize) {
      high -= 1;
    }
    let best: ReturnType<typeof attempt> | null = null;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = attempt(middle / steps);
      if (candidate.fits) {
        low = middle;
        best = candidate;
      } else {
        high = middle - 1;
      }
    }
    chosen = best ?? attempt(DESIGN_LAYOUT_SHRINK_MIN_FONT_SIZE);
  }

  const size = chosen.size;
  const scale = size / metrics.unitsPerEm;
  const lineBox = size * layer.lineHeight;
  const ascent = (metrics.ascent / metrics.unitsPerEm) * size;
  const descent = (Math.abs(metrics.descent) / metrics.unitsPerEm) * size;
  const baselineOffset = (lineBox - (ascent + descent)) / 2 + ascent;
  const blockHeight = chosen.lines.length * lineBox;
  const top =
    layer.verticalAlign === 'top'
      ? layer.y
      : layer.verticalAlign === 'middle'
      ? layer.y + (layer.height - blockHeight) / 2
      : layer.y + layer.height - blockHeight;

  const lines = chosen.lines.map(
    (text, index): ContentStudioDesignLayoutLine => {
      const glyphs = text === '' ? [] : metrics.shape(text);
      let units = 0;
      for (const glyph of glyphs) {
        units += glyph.xAdvance;
      }
      const width = lineWidth(units, glyphs.length, size);
      const x =
        layer.align === 'left'
          ? layer.x
          : layer.align === 'center'
          ? layer.x + (layer.width - width) / 2
          : layer.x + layer.width - width;
      const baselineY = top + index * lineBox + baselineOffset;
      let pen = 0;
      return {
        text,
        x: textNumber(x),
        baselineY: textNumber(baselineY),
        width: textNumber(width),
        glyphs: glyphs.map((glyph, glyphIndex) => {
          const placed = {
            id: glyph.id,
            cluster: glyph.cluster,
            x: textNumber(
              x +
                pen * scale +
                glyphIndex * layer.letterSpacing +
                glyph.xOffset * scale
            ),
            y: textNumber(baselineY - glyph.yOffset * scale),
            advance: textNumber(glyph.xAdvance * scale),
          };
          pen += glyph.xAdvance;
          return placed;
        }),
      };
    }
  );

  return {
    layerId: layer.id,
    type: 'text',
    ...layoutItemGeometry(layer),
    clipRect: layoutRect(layer.x, layer.y, layer.width, layer.height),
    font: { family: font.family, weight: font.weight, style: font.style },
    fontKey: metrics.key,
    color,
    requestedFontSize: layoutNumber(layer.fontSize),
    resolvedFontSize: layoutNumber(size),
    lineHeight: layoutNumber(layer.lineHeight),
    letterSpacing: layoutNumber(layer.letterSpacing),
    align: layer.align,
    verticalAlign: layer.verticalAlign,
    overflow: layer.overflow,
    fits:
      layoutFits(blockHeight, layer.height) &&
      lines.every((line) => layoutFits(line.width, layer.width)),
    lines,
  };
}
