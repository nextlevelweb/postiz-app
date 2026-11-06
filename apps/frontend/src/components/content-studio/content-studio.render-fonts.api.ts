'use client';

import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import {
  ContentStudioRequestError,
  request,
  swrOptions,
} from '@gitroom/frontend/components/content-studio/content-studio.api';

// Render fonts of the organization: which uploaded font file draws a design
// font (family, weight and style, exactly as the design names it). Every
// member reads the list; the server lets only ADMIN and SUPERADMIN upload,
// disable and enable. A font without an enabled render font is drawn with the
// bundled default (Noto Sans), so nothing here is needed before a first
// render. The browser sends the file and the three tuple fields only; it
// never reads a stored font back

export interface ContentStudioRenderFont {
  id: string;
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const RENDER_FONTS_PATH = '/content-studio/render-fonts';
const renderFontPath = (id: string) =>
  `${RENDER_FONTS_PATH}/${encodeURIComponent(id)}`;

// the bundled default, as the server draws it (design.render.default.font)
export const DEFAULT_RENDER_FONT_FAMILY = 'Noto Sans';
export const RENDER_FONT_WEIGHTS = [
  100, 200, 300, 400, 500, 600, 700, 800, 900,
] as const;
export const RENDER_FONT_STYLES = ['normal', 'italic'] as const;
// the server's limit (32 MiB); a larger file is refused before it is sent
export const RENDER_FONT_FILE_MAX_BYTES = 33_554_432;
export const RENDER_FONT_ACCEPT = '.ttf,.otf,font/ttf,font/otf';

export const useContentStudioRenderFonts = (open: boolean) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioRenderFont[]>(fetch, path),
    [fetch]
  );
  return useSWR(open ? RENDER_FONTS_PATH : null, load, swrOptions);
};

// One request each, never retried; every write reloads the list
export const useContentStudioRenderFontActions = () => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();
  const refresh = useCallback(() => mutate(RENDER_FONTS_PATH), [mutate]);

  return useMemo(
    () => ({
      upload: async (input: {
        family: string;
        weight: number;
        style: string;
        file: File;
      }) => {
        const body = new FormData();
        body.append('family', input.family);
        body.append('weight', String(input.weight));
        body.append('style', input.style);
        body.append('file', input.file);
        const font = await request<ContentStudioRenderFont>(
          fetch,
          `${RENDER_FONTS_PATH}/upload`,
          { method: 'POST', body }
        );
        await refresh();
        return font;
      },
      setEnabled: async (id: string, enabled: boolean) => {
        const font = await request<ContentStudioRenderFont>(
          fetch,
          `${renderFontPath(id)}/${enabled ? 'enable' : 'disable'}`,
          { method: 'POST' }
        );
        await refresh();
        return font;
      },
    }),
    [fetch, refresh]
  );
};

type Translate = (key: string, fallback: string) => string;

// Fixed text for every outcome, never a server message
export const renderFontErrorMessage = (t: Translate, error: unknown) => {
  const code =
    error instanceof ContentStudioRequestError ? error.code : undefined;
  switch (code) {
    case 'CS_RENDER_FONT_ADMIN_REQUIRED':
      return t(
        'content_studio_render_font_admin_required',
        'Only organization administrators can manage render fonts.'
      );
    case 'CS_RENDER_FONT_INVALID':
      return t(
        'content_studio_render_font_invalid',
        'This file is not a font that can be used for rendering.'
      );
    case 'CS_RENDER_FONT_UNSUPPORTED':
      return t(
        'content_studio_render_font_unsupported',
        'Use a single TrueType (.ttf) or OpenType (.otf) font file. Web fonts and font collections are not supported.'
      );
    case 'CS_RENDER_FONT_TOO_LARGE':
      return t(
        'content_studio_render_font_too_large',
        'The font file is larger than 32 MB.'
      );
    case 'CS_RENDER_FONT_LIMIT':
      return t(
        'content_studio_render_font_limit',
        'The organization already has the maximum number of active render fonts. Disable one first.'
      );
    case 'CS_RENDER_FONT_CONFLICT':
      return t(
        'content_studio_render_font_conflict',
        'This font changed at the same time. Try again.'
      );
    case 'CS_RENDER_FONT_STORAGE_UNAVAILABLE':
      return t(
        'content_studio_render_font_storage_unavailable',
        'Private render font storage is not configured, so fonts cannot be uploaded yet. Designs still render with the built-in font.'
      );
    case 'CS_INVALID_REQUEST':
      return t(
        'content_studio_error_invalid',
        'Check the values and try again.'
      );
    case 'CS_NOT_FOUND':
      return t(
        'content_studio_render_font_not_found',
        'This render font no longer exists.'
      );
    default:
      return t(
        'content_studio_render_font_error',
        'The render font could not be saved. Try again.'
      );
  }
};
