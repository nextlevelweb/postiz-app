'use client';

import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import type { ContentStudioDesignBlockContentV1 } from '@gitroom/nestjs-libraries/content-studio/design/design.block';
import {
  request,
  swrOptions,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import { designErrorCode } from '@gitroom/frontend/components/content-studio/content-studio.designs.api';

// Design blocks (P4-18): the organization's own reusable creative assets,
// styled layers saved as they are (there are no built-ins). The browser
// lists them, inserts one by copying its layers into a page of the draft
// under new ids (no request but the Media check), saves the selected layers
// as a new block (without ids, measured from their box, never a page or a
// document), renames, describes, archives and restores them. It never sends
// an organization, a user, a design or a hash

export interface ContentStudioOrganizationDesignBlock {
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

// every block is the organization's own
export type ContentStudioDesignBlock = ContentStudioOrganizationDesignBlock;

export interface ContentStudioDesignBlockCatalog {
  // always empty: there are no built-in blocks
  system: never[];
  pages: number;
  results: ContentStudioOrganizationDesignBlock[];
}

export const DESIGN_BLOCKS_PATH = '/content-studio/design-blocks';
export const designBlocksListPath = (archived: boolean, page: number) =>
  `${DESIGN_BLOCKS_PATH}?page=${page}&archived=${archived}`;
const designBlockPath = (id: string) =>
  `${DESIGN_BLOCKS_PATH}/${encodeURIComponent(id)}`;

// One page of the organization's blocks, active or archived; null while
// nothing should load
export const useContentStudioDesignBlocks = (
  open: boolean,
  archived: boolean,
  page: number
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioDesignBlockCatalog>(fetch, path),
    [fetch]
  );
  return useSWR(
    open ? designBlocksListPath(archived, page) : null,
    load,
    swrOptions
  );
};

// Block writes: one request each, never retried; each reloads the block
// lists. Nothing is edited in the cache by hand
export const useContentStudioDesignBlockActions = () => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();
  // matcher only, no data: the cached pages stay shown while they reload
  const refresh = useCallback(
    () =>
      mutate(
        (key) =>
          typeof key === 'string' && key.startsWith(`${DESIGN_BLOCKS_PATH}?`)
      ),
    [mutate]
  );

  return useMemo(
    () => ({
      // some layers of one page, as the shared layer snapshot, with a name
      createBlock: async (input: {
        name: string;
        description: string;
        content: ContentStudioDesignBlockContentV1;
      }) => {
        const created = await request<ContentStudioOrganizationDesignBlock>(
          fetch,
          DESIGN_BLOCKS_PATH,
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
      updateBlock: async (
        id: string,
        details: { name: string; description: string }
      ) => {
        await request(fetch, designBlockPath(id), {
          method: 'PATCH',
          body: JSON.stringify({
            name: details.name,
            description: details.description,
          }),
        });
        await refresh();
      },
      archiveBlock: async (id: string) => {
        await request(fetch, `${designBlockPath(id)}/archive`, {
          method: 'POST',
        });
        await refresh();
      },
      restoreBlock: async (id: string) => {
        await request(fetch, `${designBlockPath(id)}/restore`, {
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

export const designBlockErrorMessage = (t: Translate, error: unknown) => {
  switch (designErrorCode(error)) {
    case 'CS_INVALID_REQUEST':
      return t(
        'content_studio_error_invalid',
        'Check the values and try again.'
      );
    case 'CS_DESIGN_BLOCK_INVALID':
      return t(
        'content_studio_block_error_invalid',
        'These layers cannot be saved as a block.'
      );
    case 'CS_DESIGN_BLOCK_TOO_LARGE':
      return t(
        'content_studio_block_error_too_large',
        'These layers are too large to save as a block.'
      );
    case 'CS_DESIGN_BLOCK_MEDIA_INVALID':
      return t(
        'content_studio_layout_error_media',
        'An image in these layers is not available in your media library.'
      );
    case 'CS_DESIGN_BLOCK_ARCHIVED':
      return t(
        'content_studio_block_error_archived',
        'This block is archived.'
      );
    case 'CS_DESIGN_BLOCK_INTEGRITY_ERROR':
      return t(
        'content_studio_block_error_integrity',
        'Stored block data could not be read safely.'
      );
    case 'CS_NOT_FOUND':
      return t('content_studio_block_not_found', 'Block not found.');
    default:
      return t(
        'content_studio_block_error',
        'Something went wrong with the block.'
      );
  }
};
