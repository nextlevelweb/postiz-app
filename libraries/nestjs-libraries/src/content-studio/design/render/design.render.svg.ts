import type {
  ContentStudioDesignLayoutImageItem,
  ContentStudioDesignLayoutItem,
  ContentStudioDesignLayoutPage,
  ContentStudioDesignLayoutTextItem,
} from '@gitroom/nestjs-libraries/content-studio/design/layout/design.layout.types';
import {
  ContentStudioDesignRenderError,
  DESIGN_RENDER_SVG_MAX_BYTES,
} from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.types';

// The SVG for one laid-out page: a render intermediate, built here from the
// display list and handed straight to the rasterizer; never stored or
// returned. It draws exactly what the layout says and computes no layout of
// its own. The vocabulary is fixed (svg, defs, clipPath, rect, ellipse, g,
// path, image) with fixed attribute order; no text element, style, script,
// foreignObject or external reference. Nothing the user wrote reaches it:
// colors are checked #rrggbb, numbers are written by svgNumber, ids are
// counters, glyph outlines come from the font and the only href is a
// data:image/png URI of a normalized image the renderer made itself.
//
// Per item, in display-list order (first at the back):
//   <g transform="rotate(angle originX originY)" opacity="o"> ... </g>
// with transform left out at rotation 0 and opacity left out at 1. Text and
// images clip inside that group, so the clip turns with the layer. An image
// with a rounded rectangle or ellipse mask (P4-14) is also clipped to that
// shape in its box, an outer clip numbered before the image's own; a
// rectangle mask is the box itself and adds nothing

export interface ContentStudioDesignSvgAssets {
  font(key: string): { unitsPerEm: number; glyphPath(id: number): string };
  image(ref: { mediaId: string; sha256: string }): { png: Buffer };
}

const fail = () => new ContentStudioDesignRenderError('RENDER_FAILED');

// A number as SVG reads it: finite only, -0 as 0, the shortest text that
// reads back as the same number (no rounding, no locale)
export function svgNumber(value: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw fail();
  }
  return String(value === 0 ? 0 : value);
}

const svgColor = (value: string) => {
  if (!/^#[0-9a-f]{6}$/.test(value)) {
    throw fail();
  }
  return value;
};

const rect = (box: { x: number; y: number; width: number; height: number }) =>
  `x="${svgNumber(box.x)}" y="${svgNumber(box.y)}" width="${svgNumber(
    box.width
  )}" height="${svgNumber(box.height)}"`;

export function buildContentStudioDesignPageSvg(
  page: ContentStudioDesignLayoutPage,
  assets: ContentStudioDesignSvgAssets
): string {
  const parts: string[] = [];
  let length = 0;
  // the output is ASCII, so its length is its size in bytes
  const write = (part: string) => {
    length += part.length;
    if (length > DESIGN_RENDER_SVG_MAX_BYTES) {
      throw new ContentStudioDesignRenderError('RENDER_OUTPUT_TOO_LARGE');
    }
    parts.push(part);
  };
  let clips = 0;
  const clip = (box: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => {
    const id = `clip-${clips}`;
    clips += 1;
    write(`<defs><clipPath id="${id}"><rect ${rect(box)}/></clipPath></defs>`);
    return id;
  };

  // the mask shape in the item's box, or null when the box itself is the cut
  const maskClip = (item: ContentStudioDesignLayoutImageItem) => {
    const mask = item.mask;
    if (
      !mask ||
      mask.type === 'rectangle' ||
      (mask.type === 'roundedRectangle' && mask.cornerRadius === 0)
    ) {
      return null;
    }
    const id = `clip-${clips}`;
    clips += 1;
    const { box } = item;
    const shape =
      mask.type === 'ellipse'
        ? `<ellipse cx="${svgNumber(box.x + box.width / 2)}" cy="${svgNumber(
            box.y + box.height / 2
          )}" rx="${svgNumber(box.width / 2)}" ry="${svgNumber(
            box.height / 2
          )}"/>`
        : `<rect ${rect(box)} rx="${svgNumber(
            mask.cornerRadius
          )}" ry="${svgNumber(mask.cornerRadius)}"/>`;
    write(`<defs><clipPath id="${id}">${shape}</clipPath></defs>`);
    return id;
  };

  // the source rectangle of the image scaled exactly onto the destination;
  // the whole image is placed accordingly and clipped to the destination,
  // and to its mask
  const image = (item: ContentStudioDesignLayoutImageItem) => {
    const { sourceRect: source, destinationRect: target } = item;
    const scaleX = target.width / source.width;
    const scaleY = target.height / source.height;
    const masked = maskClip(item);
    if (masked) {
      write(`<g clip-path="url(#${masked})">`);
    }
    const id = clip(target);
    const { png } = assets.image(item.imageRef);
    // refused before the base64 text is made
    if (length + Math.ceil(png.length / 3) * 4 > DESIGN_RENDER_SVG_MAX_BYTES) {
      throw new ContentStudioDesignRenderError('RENDER_OUTPUT_TOO_LARGE');
    }
    const data = png.toString('base64');
    write(
      `<g clip-path="url(#${id})"><image ${rect({
        x: target.x - source.x * scaleX,
        y: target.y - source.y * scaleY,
        width: item.intrinsic.width * scaleX,
        height: item.intrinsic.height * scaleY,
      })} preserveAspectRatio="none" href="data:image/png;base64,${data}"/></g>`
    );
    if (masked) {
      write('</g>');
    }
  };

  // every glyph outline at its laid-out origin, scaled from font units to
  // the resolved size with +y turned down
  const text = (item: ContentStudioDesignLayoutTextItem) => {
    const font = assets.font(item.fontKey);
    const scale = item.resolvedFontSize / font.unitsPerEm;
    const id = clip(item.clipRect);
    write(`<g clip-path="url(#${id})" fill="${svgColor(item.color)}">`);
    for (const line of item.lines) {
      for (const glyph of line.glyphs) {
        const data = font.glyphPath(glyph.id);
        if (data !== '') {
          write(
            `<path transform="translate(${svgNumber(glyph.x)} ${svgNumber(
              glyph.y
            )}) scale(${svgNumber(scale)} ${svgNumber(-scale)})" d="${data}"/>`
          );
        }
      }
    }
    write('</g>');
  };

  const item = (entry: ContentStudioDesignLayoutItem) => {
    const transform =
      entry.rotation === 0
        ? ''
        : ` transform="rotate(${svgNumber(entry.rotation)} ${svgNumber(
            entry.transformOrigin.x
          )} ${svgNumber(entry.transformOrigin.y)})"`;
    const opacity =
      entry.opacity === 1 ? '' : ` opacity="${svgNumber(entry.opacity)}"`;
    write(`<g${transform}${opacity}>`);
    switch (entry.type) {
      case 'rectangle': {
        const radius =
          entry.cornerRadius === 0
            ? ''
            : ` rx="${svgNumber(entry.cornerRadius)}" ry="${svgNumber(
                entry.cornerRadius
              )}"`;
        write(
          `<rect ${rect(entry.box)}${radius} fill="${svgColor(entry.fill)}"/>`
        );
        break;
      }
      case 'ellipse':
        write(
          `<ellipse cx="${svgNumber(
            entry.box.x + entry.box.width / 2
          )}" cy="${svgNumber(
            entry.box.y + entry.box.height / 2
          )}" rx="${svgNumber(entry.box.width / 2)}" ry="${svgNumber(
            entry.box.height / 2
          )}" fill="${svgColor(entry.fill)}"/>`
        );
        break;
      case 'image':
        image(entry);
        break;
      case 'text':
        text(entry);
        break;
      default:
        throw fail();
    }
    write('</g>');
  };

  const size = `width="${svgNumber(page.width)}" height="${svgNumber(
    page.height
  )}"`;
  write(
    `<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="0 0 ${svgNumber(
      page.width
    )} ${svgNumber(page.height)}">`
  );
  write(
    `<rect x="0" y="0" ${size} fill="${svgColor(page.background.color)}"/>`
  );
  page.items.forEach(item);
  write('</svg>');
  return parts.join('');
}
