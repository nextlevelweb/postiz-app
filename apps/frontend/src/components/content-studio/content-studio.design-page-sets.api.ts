'use client';

import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import type { ContentStudioDesignPageSetContentV1 } from '@gitroom/nestjs-libraries/content-studio/design/design.page.set';
import {
  request,
  swrOptions,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import { designErrorCode } from '@gitroom/frontend/components/content-studio/content-studio.designs.api';

// Design page sets: the built-in ones (code on the server, read-only) and
// the organization's own, reusable page structures (names, sizes, literal
// backgrounds). The browser lists them, starts a new design from one by its
// id (the server makes the pages), adds one to a draft as blank pages under
// new ids (no request), saves the page structure of the draft as a new page
// set (never a page id, a layer or the document), renames, describes,
// archives and restores the organization's. It never sends an organization,
// a user, a design or a hash

export interface ContentStudioSystemDesignPageSet {
  source: 'system';
  id: string;
  name: string;
  description: string;
  pageCount: number;
  archivedAt: null;
  contentHash: string;
  content: unknown;
}

export interface ContentStudioOrganizationDesignPageSet {
  source: 'organization';
  id: string;
  name: string;
  description: string | null;
  pageCount: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
  content: unknown;
}

export type ContentStudioDesignPageSet =
  | ContentStudioSystemDesignPageSet
  | ContentStudioOrganizationDesignPageSet;

export interface ContentStudioDesignPageSetCatalog {
  system: ContentStudioSystemDesignPageSet[];
  pages: number;
  results: ContentStudioOrganizationDesignPageSet[];
}

export const DESIGN_PAGE_SETS_PATH = '/content-studio/design-page-sets';
export const designPageSetsListPath = (archived: boolean, page: number) =>
  `${DESIGN_PAGE_SETS_PATH}?page=${page}&archived=${archived}`;
const designPageSetPath = (id: string) =>
  `${DESIGN_PAGE_SETS_PATH}/${encodeURIComponent(id)}`;

// The built-in page sets and one page of the organization's, active or
// archived; null while nothing should load
export const useContentStudioDesignPageSets = (
  open: boolean,
  archived: boolean,
  page: number
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioDesignPageSetCatalog>(fetch, path),
    [fetch]
  );
  return useSWR(
    open ? designPageSetsListPath(archived, page) : null,
    load,
    swrOptions
  );
};

// Page set writes: one request each, never retried; each reloads the page
// set lists. Nothing is edited in the cache by hand
export const useContentStudioDesignPageSetActions = () => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();
  // matcher only, no data: the cached pages stay shown while they reload
  const refresh = useCallback(
    () =>
      mutate(
        (key) =>
          typeof key === 'string' && key.startsWith(`${DESIGN_PAGE_SETS_PATH}?`)
      ),
    [mutate]
  );

  return useMemo(
    () => ({
      // the page structure of a draft, as Page Set v1 content, with a name
      createPageSet: async (input: {
        name: string;
        description: string;
        content: ContentStudioDesignPageSetContentV1;
      }) => {
        const created = await request<ContentStudioOrganizationDesignPageSet>(
          fetch,
          DESIGN_PAGE_SETS_PATH,
          {
            method: 'POST',
            body: JSON.stringify({
              name: input.name,
              description: input.description,
              content: {
                schemaVersion: input.content.schemaVersion,
                pages: input.content.pages,
              },
            }),
          }
        );
        await refresh();
        return created;
      },
      updatePageSet: async (
        id: string,
        details: { name: string; description: string }
      ) => {
        await request(fetch, designPageSetPath(id), {
          method: 'PATCH',
          body: JSON.stringify({
            name: details.name,
            description: details.description,
          }),
        });
        await refresh();
      },
      archivePageSet: async (id: string) => {
        await request(fetch, `${designPageSetPath(id)}/archive`, {
          method: 'POST',
        });
        await refresh();
      },
      restorePageSet: async (id: string) => {
        await request(fetch, `${designPageSetPath(id)}/restore`, {
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

export const designPageSetErrorMessage = (t: Translate, error: unknown) => {
  switch (designErrorCode(error)) {
    case 'CS_INVALID_REQUEST':
      return t(
        'content_studio_error_invalid',
        'Check the values and try again.'
      );
    case 'CS_DESIGN_PAGE_SET_INVALID':
      return t(
        'content_studio_page_set_error_invalid',
        'These pages cannot be saved as a page set.'
      );
    case 'CS_DESIGN_PAGE_SET_TOO_LARGE':
      return t(
        'content_studio_page_set_error_too_large',
        'This page set is too large.'
      );
    case 'CS_DESIGN_PAGE_SET_ARCHIVED':
      return t(
        'content_studio_page_set_error_archived',
        'This page set is archived.'
      );
    case 'CS_DESIGN_PAGE_SET_INTEGRITY_ERROR':
      return t(
        'content_studio_page_set_error_integrity',
        'Stored page set data could not be read safely.'
      );
    case 'CS_NOT_FOUND':
      return t('content_studio_page_set_not_found', 'Page set not found.');
    default:
      return t(
        'content_studio_page_set_error',
        'Something went wrong with the page set.'
      );
  }
};
