import { readFileSync } from 'fs';
import path from 'path';
import { designRenderSha256 } from '@gitroom/nestjs-libraries/content-studio/design/render/design.render.types';

// The render fonts every organization has without any setup: Noto Sans 2.015
// Regular and Bold, unmodified files of the official release under the SIL
// Open Font License 1.1 (fonts/OFL.txt, provenance in fonts/FONTLOG.txt).
// A text whose exact family, weight and style has no enabled render font of
// its organization is drawn with one of them, so a design renders before any
// font is uploaded: weights up to 500 with Regular, 600 and over with Bold,
// italic upright (no italic is bundled). The files ship in the source tree
// and are copied into the build (see apps/backend/nest-cli.json); the bytes
// must be exactly the pinned SHA-256 or the font is unavailable. No system
// font, URL or other file is ever read

export const CONTENT_STUDIO_DEFAULT_RENDER_FONT_FAMILY = 'Noto Sans';

const DEFAULT_FONTS = {
  'noto-sans-regular': {
    file: 'NotoSans-Regular.ttf',
    sha256: 'f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8',
  },
  'noto-sans-bold': {
    file: 'NotoSans-Bold.ttf',
    sha256: '87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9',
  },
} as const;

export type ContentStudioDefaultRenderFontId = keyof typeof DEFAULT_FONTS;
export const CONTENT_STUDIO_DEFAULT_RENDER_FONT_IDS = Object.keys(
  DEFAULT_FONTS
) as ContentStudioDefaultRenderFontId[];

export const contentStudioDefaultRenderFontId = (font: {
  weight: number;
}): ContentStudioDefaultRenderFontId =>
  font.weight >= 600 ? 'noto-sans-bold' : 'noto-sans-regular';

// read and verified once per process; a failure is not kept
const loaded = new Map<ContentStudioDefaultRenderFontId, Buffer>();

// The bytes of one bundled font (a copy), or null when the file is missing
// or is not exactly the pinned file
export function readContentStudioDefaultRenderFont(
  id: ContentStudioDefaultRenderFontId
): { bytes: Buffer; sha256: string } | null {
  const font = DEFAULT_FONTS[id];
  if (!font) {
    return null;
  }
  let bytes = loaded.get(id);
  if (!bytes) {
    try {
      bytes = readFileSync(path.join(__dirname, 'fonts', font.file));
    } catch {
      return null;
    }
    if (designRenderSha256(bytes) !== font.sha256) {
      return null;
    }
    loaded.set(id, bytes);
  }
  return { bytes: Buffer.from(bytes), sha256: font.sha256 };
}
