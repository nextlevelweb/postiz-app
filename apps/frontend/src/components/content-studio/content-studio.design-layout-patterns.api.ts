'use client';

import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import type { ContentStudioDesignLayoutPatternContentV1 } from '@gitroom/nestjs-libraries/content-studio/design/design.layout.pattern';
import {
  request,
  swrOptions,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import { designErrorCode } from '@gitroom/frontend/components/content-studio/content-studio.designs.api';

// Design layout patterns: the built-in ones (code on the server, read-only)
// and the organization's own, reusable arrangements of layers. The browser
// lists them, inserts one by copying its layers into a page of the draft
// under new ids (no request but the Media check), saves the selected layers
// as a new pattern (without ids, measured from their box, never a page or a
// document), renames, describes, archives and restores the organization's.
// It never sends an organization, a user, a design or a hash

export interface ContentStudioSystemDesignLayoutPattern {
  source: 'system';
  id: string;
  name: string;
  description: string;
  archivedAt: null;
  contentHash: string;
  content: unknown;
}

export interface ContentStudioOrganizationDesignLayoutPattern {
  source: 'organization';
  id: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
  content: unknown;
}

export type ContentStudioDesignLayoutPattern =
  | ContentStudioSystemDesignLayoutPattern
  | ContentStudioOrganizationDesignLayoutPattern;

export interface ContentStudioDesignLayoutPatternCatalog {
  system: ContentStudioSystemDesignLayoutPattern[];
  pages: number;
  results: ContentStudioOrganizationDesignLayoutPattern[];
}

export const DESIGN_LAYOUT_PATTERNS_PATH =
  '/content-studio/design-layout-patterns';
export const designLayoutPatternsListPath = (archived: boolean, page: number) =>
  `${DESIGN_LAYOUT_PATTERNS_PATH}?page=${page}&archived=${archived}`;
const designLayoutPatternPath = (id: string) =>
  `${DESIGN_LAYOUT_PATTERNS_PATH}/${encodeURIComponent(id)}`;

// The built-in patterns and one page of the organization's, active or
// archived; null while nothing should load
export const useContentStudioDesignLayoutPatterns = (
  open: boolean,
  archived: boolean,
  page: number
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) =>
      request<ContentStudioDesignLayoutPatternCatalog>(fetch, path),
    [fetch]
  );
  return useSWR(
    open ? designLayoutPatternsListPath(archived, page) : null,
    load,
    swrOptions
  );
};

// Pattern writes: one request each, never retried; each reloads the pattern
// lists. Nothing is edited in the cache by hand
export const useContentStudioDesignLayoutPatternActions = () => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();
  // matcher only, no data: the cached pages stay shown while they reload
  const refresh = useCallback(
    () =>
      mutate(
        (key) =>
          typeof key === 'string' &&
          key.startsWith(`${DESIGN_LAYOUT_PATTERNS_PATH}?`)
      ),
    [mutate]
  );

  return useMemo(
    () => ({
      // some layers of one page, as Layout Pattern v1 content, with a name
      createPattern: async (input: {
        name: string;
        description: string;
        content: ContentStudioDesignLayoutPatternContentV1;
      }) => {
        const created =
          await request<ContentStudioOrganizationDesignLayoutPattern>(
            fetch,
            DESIGN_LAYOUT_PATTERNS_PATH,
            {
              method: 'POST',
              body: JSON.stringify({
                name: input.name,
                description: input.description,
                content: {
                  schemaVersion: input.content.schemaVersion,
                  width: input.content.width,
                  height: input.content.height,
                  layers: input.content.layers,
                },
              }),
            }
          );
        await refresh();
        return created;
      },
      updatePattern: async (
        id: string,
        details: { name: string; description: string }
      ) => {
        await request(fetch, designLayoutPatternPath(id), {
          method: 'PATCH',
          body: JSON.stringify({
            name: details.name,
            description: details.description,
          }),
        });
        await refresh();
      },
      archivePattern: async (id: string) => {
        await request(fetch, `${designLayoutPatternPath(id)}/archive`, {
          method: 'POST',
        });
        await refresh();
      },
      restorePattern: async (id: string) => {
        await request(fetch, `${designLayoutPatternPath(id)}/restore`, {
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

export const designLayoutPatternErrorMessage = (
  t: Translate,
  error: unknown
) => {
  switch (designErrorCode(error)) {
    case 'CS_INVALID_REQUEST':
      return t(
        'content_studio_error_invalid',
        'Check the values and try again.'
      );
    case 'CS_DESIGN_LAYOUT_PATTERN_INVALID':
      return t(
        'content_studio_layout_error_invalid',
        'These layers cannot be saved as a layout.'
      );
    case 'CS_DESIGN_LAYOUT_PATTERN_TOO_LARGE':
      return t(
        'content_studio_layout_error_too_large',
        'These layers are too large to save as a layout.'
      );
    case 'CS_DESIGN_LAYOUT_PATTERN_MEDIA_INVALID':
      return t(
        'content_studio_layout_error_media',
        'An image in these layers is not available in your media library.'
      );
    case 'CS_DESIGN_LAYOUT_PATTERN_ARCHIVED':
      return t(
        'content_studio_layout_error_archived',
        'This layout is archived.'
      );
    case 'CS_DESIGN_LAYOUT_PATTERN_INTEGRITY_ERROR':
      return t(
        'content_studio_layout_error_integrity',
        'Stored layout data could not be read safely.'
      );
    case 'CS_NOT_FOUND':
      return t('content_studio_layout_not_found', 'Layout not found.');
    default:
      return t(
        'content_studio_layout_error',
        'Something went wrong with the layout.'
      );
  }
};
