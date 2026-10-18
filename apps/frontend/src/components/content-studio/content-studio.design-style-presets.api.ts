'use client';

import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import type {
  ContentStudioDesignStylePresetContentV1,
  ContentStudioDesignStylePresetKind,
} from '@gitroom/nestjs-libraries/content-studio/design/design.style.preset';
import {
  request,
  swrOptions,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import { designErrorCode } from '@gitroom/frontend/components/content-studio/content-studio.designs.api';

// Design style presets: the built-in ones (code on the server, read-only)
// and the organization's own, reusable text and shape styles. The browser
// lists them by kind, applies one by copying its style into a layer of the
// draft (no request), saves the style of the selected layer as a new preset
// (its style fields only, never a layer or a document), renames, describes,
// archives and restores the organization's. It never sends an organization,
// a user, a kind of its own or a hash

export interface ContentStudioSystemDesignStylePreset {
  source: 'system';
  id: string;
  name: string;
  description: string;
  kind: ContentStudioDesignStylePresetKind;
  archivedAt: null;
  contentHash: string;
  content: unknown;
}

export interface ContentStudioOrganizationDesignStylePreset {
  source: 'organization';
  id: string;
  name: string;
  description: string | null;
  kind: ContentStudioDesignStylePresetKind;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
  content: unknown;
}

export type ContentStudioDesignStylePreset =
  | ContentStudioSystemDesignStylePreset
  | ContentStudioOrganizationDesignStylePreset;

export interface ContentStudioDesignStylePresetCatalog {
  system: ContentStudioSystemDesignStylePreset[];
  pages: number;
  results: ContentStudioOrganizationDesignStylePreset[];
}

// The limits the API enforces
export const DESIGN_STYLE_PRESET_NAME_MAX = 100;
export const DESIGN_STYLE_PRESET_DESCRIPTION_MAX = 500;

export const DESIGN_STYLE_PRESETS_PATH = '/content-studio/design-style-presets';
export const designStylePresetsListPath = (
  kind: ContentStudioDesignStylePresetKind,
  archived: boolean,
  page: number
) =>
  `${DESIGN_STYLE_PRESETS_PATH}?kind=${kind}&page=${page}&archived=${archived}`;
const designStylePresetPath = (id: string) =>
  `${DESIGN_STYLE_PRESETS_PATH}/${encodeURIComponent(id)}`;

// The built-in presets of one kind and one page of the organization's,
// active or archived; null while no layer of a kind is selected
export const useContentStudioDesignStylePresets = (
  kind: ContentStudioDesignStylePresetKind | null,
  archived: boolean,
  page: number
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) =>
      request<ContentStudioDesignStylePresetCatalog>(fetch, path),
    [fetch]
  );
  return useSWR(
    kind ? designStylePresetsListPath(kind, archived, page) : null,
    load,
    swrOptions
  );
};

// Preset writes: one request each, never retried; each reloads the preset
// lists. Nothing is edited in the cache by hand
export const useContentStudioDesignStylePresetActions = () => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();
  // matcher only, no data: the cached pages stay shown while they reload
  const refresh = useCallback(
    () =>
      mutate(
        (key) =>
          typeof key === 'string' &&
          key.startsWith(`${DESIGN_STYLE_PRESETS_PATH}?`)
      ),
    [mutate]
  );

  return useMemo(
    () => ({
      // the style of one layer, as Style Preset v1 content, with a name
      createPreset: async (input: {
        name: string;
        description: string;
        content: ContentStudioDesignStylePresetContentV1;
      }) => {
        const created =
          await request<ContentStudioOrganizationDesignStylePreset>(
            fetch,
            DESIGN_STYLE_PRESETS_PATH,
            {
              method: 'POST',
              body: JSON.stringify({
                name: input.name,
                description: input.description,
                content: {
                  schemaVersion: input.content.schemaVersion,
                  kind: input.content.kind,
                  style: input.content.style,
                },
              }),
            }
          );
        await refresh();
        return created;
      },
      updatePreset: async (
        id: string,
        details: { name: string; description: string }
      ) => {
        await request(fetch, designStylePresetPath(id), {
          method: 'PATCH',
          body: JSON.stringify({
            name: details.name,
            description: details.description,
          }),
        });
        await refresh();
      },
      archivePreset: async (id: string) => {
        await request(fetch, `${designStylePresetPath(id)}/archive`, {
          method: 'POST',
        });
        await refresh();
      },
      restorePreset: async (id: string) => {
        await request(fetch, `${designStylePresetPath(id)}/restore`, {
          method: 'POST',
        });
        await refresh();
      },
    }),
    [fetch, refresh]
  );
};

// --- messages: fixed text for every outcome, never a server message ---

type Translate = (key: string, fallback: string) => string;

export const designStylePresetErrorMessage = (t: Translate, error: unknown) => {
  switch (designErrorCode(error)) {
    case 'CS_INVALID_REQUEST':
      return t(
        'content_studio_error_invalid',
        'Check the values and try again.'
      );
    case 'CS_DESIGN_STYLE_PRESET_INVALID':
      return t(
        'content_studio_style_preset_error_invalid',
        'This style cannot be saved as a preset.'
      );
    case 'CS_DESIGN_STYLE_PRESET_ARCHIVED':
      return t(
        'content_studio_style_preset_error_archived',
        'This style preset is archived.'
      );
    case 'CS_DESIGN_STYLE_PRESET_KIND_MISMATCH':
      return t(
        'content_studio_style_preset_error_kind',
        'A style preset keeps its kind.'
      );
    case 'CS_DESIGN_STYLE_PRESET_INTEGRITY_ERROR':
      return t(
        'content_studio_style_preset_error_integrity',
        'Stored style preset data could not be read safely.'
      );
    case 'CS_NOT_FOUND':
      return t(
        'content_studio_style_preset_not_found',
        'Style preset not found.'
      );
    default:
      return t(
        'content_studio_style_preset_error',
        'Something went wrong with the style preset.'
      );
  }
};
