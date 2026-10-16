'use client';

import { CSSProperties, FC, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import type { ContentStudioBrandKitContentV1 } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import type {
  ContentStudioDesignColorValue,
  ContentStudioDesignFontRef,
  ContentStudioDesignLayer,
  ContentStudioDesignPage,
  ContentStudioDesignTextLayer,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';

// The live preview of one design page: a structural drawing of the Design
// Document in plain DOM elements, for orientation only. It is not the
// renderer: text uses the browser's CSS fonts (private render fonts never
// leave the server), shrink-to-fit and image cropping are not computed, and
// images are placeholders. The authoritative picture is the server render of
// the same revision. Nothing here changes the document; every value is a
// number or a resolved #rrggbb set through React style properties, every text
// is React text, and no URL is ever taken from the document

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
// the frame never grows taller than this, whatever the page proportions
const PREVIEW_MAX_HEIGHT = 640;
// the width used before the frame is measured (or where it cannot be)
const PREVIEW_DEFAULT_WIDTH = 480;

// A literal color, or the color token of the exact Brand Kit revision; null
// when the token (or the revision) is not available. Never another color
export const resolveDesignPreviewColor = (
  value: ContentStudioDesignColorValue,
  brand: ContentStudioBrandKitContentV1 | null
) => {
  const color =
    value.type === 'literal'
      ? value.value
      : brand?.colors.find((token) => token.id === value.tokenId)?.value;
  return color && HEX_COLOR.test(color) ? color.toLowerCase() : null;
};

// A family with weight and style, or the type style token of the exact Brand
// Kit revision; null when it is not available
export const resolveDesignPreviewFont = (
  font: ContentStudioDesignFontRef,
  brand: ContentStudioBrandKitContentV1 | null
) => {
  if (font.type === 'family') {
    return { family: font.family, weight: font.weight, style: font.style };
  }
  const token = brand?.typography.find((entry) => entry.id === font.tokenId);
  return token
    ? { family: token.family, weight: token.weight, style: token.style }
    : null;
};

// The renderer draws a tab as four spaces; so does the preview
export const designPreviewText = (text: string) => text.replace(/\t/g, '    ');

const JUSTIFY = {
  top: 'flex-start',
  middle: 'center',
  bottom: 'flex-end',
} as const;

// What every layer shares: its box in design units and its rotation around
// the center (positive is clockwise, as in the design)
const boxStyle = (layer: ContentStudioDesignLayer): CSSProperties => ({
  position: 'absolute',
  left: layer.x,
  top: layer.y,
  width: layer.width,
  height: layer.height,
  opacity: layer.opacity,
  transform: `rotate(${layer.rotation}deg)`,
  transformOrigin: 'center center',
});

// A token the preview could not resolve shows as a neutral dashed outline,
// never as a guessed color or font
const UNRESOLVED = 'outline-dashed outline-[2px] outline-textItemBlur';

const TextPreview: FC<{
  layer: ContentStudioDesignTextLayer;
  brand: ContentStudioBrandKitContentV1 | null;
}> = ({ layer, brand }) => {
  const color = resolveDesignPreviewColor(layer.color, brand);
  const font = resolveDesignPreviewFont(layer.font, brand);
  return (
    <div
      data-layer={layer.id}
      data-unresolved={
        [!color && 'color', !font && 'font'].filter(Boolean).join(' ') ||
        undefined
      }
      className={clsx((!color || !font) && UNRESOLVED)}
      style={{
        ...boxStyle(layer),
        display: 'flex',
        flexDirection: 'column',
        justifyContent: JUSTIFY[layer.verticalAlign],
        overflow: 'hidden',
        ...(color ? { color } : {}),
        ...(font
          ? {
              fontFamily: font.family,
              fontWeight: font.weight,
              fontStyle: font.style,
            }
          : {}),
        fontSize: layer.fontSize,
        lineHeight: layer.lineHeight,
        letterSpacing: layer.letterSpacing,
        textAlign: layer.align,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
      }}
    >
      <span>{designPreviewText(layer.text)}</span>
    </div>
  );
};

const LayerPreview: FC<{
  layer: ContentStudioDesignLayer;
  brand: ContentStudioBrandKitContentV1 | null;
}> = ({ layer, brand }) => {
  const t = useT();
  if (layer.type === 'text') {
    return <TextPreview layer={layer} brand={brand} />;
  }
  if (layer.type === 'shape') {
    const fill = resolveDesignPreviewColor(layer.fill, brand);
    return (
      <div
        data-layer={layer.id}
        data-unresolved={fill ? undefined : 'color'}
        className={clsx(!fill && UNRESOLVED)}
        style={{
          ...boxStyle(layer),
          ...(fill ? { backgroundColor: fill } : {}),
          // the stored radius: how far it is limited is the renderer's rule
          borderRadius: layer.shape === 'ellipse' ? '50%' : layer.cornerRadius,
        }}
      />
    );
  }
  // the image itself is drawn by the server render, from the verified bytes
  return (
    <div
      data-layer={layer.id}
      className="flex items-center justify-center border-dashed border-[2px] border-textItemBlur bg-newTableBorder/40 text-textItemBlur overflow-hidden"
      style={boxStyle(layer)}
    >
      <span className="text-[32px]">
        {t('content_studio_design_layer_image', 'Image')}
      </span>
    </div>
  );
};

// The width of the frame, measured where the browser can; a fixed width
// otherwise
const useFrameWidth = () => {
  const frame = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = frame.current;
    if (!element) {
      return;
    }
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { frame, width: width > 0 ? width : PREVIEW_DEFAULT_WIDTH };
};

// The page at its own size in design units, scaled as a whole to fit: every
// layer keeps plain design-unit pixels. Hidden layers are not drawn, layers
// at opacity 0 are (invisibly), and nothing outside the page shows
export const ContentStudioDesignPreview: FC<{
  page: ContentStudioDesignPage;
  pageLabel: string;
  brand: ContentStudioBrandKitContentV1 | null;
}> = ({ page, pageLabel, brand }) => {
  const t = useT();
  const { frame, width } = useFrameWidth();
  const scale = Math.min(width / page.width, PREVIEW_MAX_HEIGHT / page.height);
  const background = resolveDesignPreviewColor(page.background.color, brand);

  return (
    <div className="flex flex-col gap-[8px] min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-[8px] text-[12px] text-textItemBlur">
        <span className="font-[600] text-textColor">
          {t('content_studio_design_live_preview', 'Live preview')}
        </span>
        <span>
          {t(
            'content_studio_design_live_preview_hint',
            'Final typography and image rendering may differ. Use Render page for the authoritative output.'
          )}
        </span>
      </div>
      <div ref={frame} className="w-full flex justify-center min-w-0">
        <div
          data-preview="frame"
          role="img"
          aria-label={`${t(
            'content_studio_design_live_preview',
            'Live preview'
          )} ${pageLabel}`}
          className="relative overflow-hidden border border-newTableBorder"
          style={{ width: page.width * scale, height: page.height * scale }}
        >
          <div
            data-preview="page"
            data-unresolved={background ? undefined : 'color'}
            className={clsx(!background && UNRESOLVED)}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: page.width,
              height: page.height,
              overflow: 'hidden',
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              ...(background ? { backgroundColor: background } : {}),
            }}
          >
            {page.layers
              .filter((layer) => layer.visible)
              .map((layer) => (
                <LayerPreview key={layer.id} layer={layer} brand={brand} />
              ))}
          </div>
        </div>
      </div>
    </div>
  );
};
