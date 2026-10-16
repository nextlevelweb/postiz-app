'use client';

import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import type { ContentStudioBrandKitContentV1 } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import type { ContentStudioDesignDocumentV1 } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioRequestError,
  request,
  swrOptions,
} from '@gitroom/frontend/components/content-studio/content-studio.api';

// Designs of the organization: named design projects whose Design Document
// v1 revisions are immutable. The browser reads designs and their revisions,
// creates a design with its first document, renames, archives and restores
// it, and asks the server to render one page or all pages of one exact
// revision. It never saves a revision (there is no editor yet), never sends an
// organization, user, hash, asset or URL, and never builds a URL from a Media
// id: a rendered Media is looked up through the Media API

export interface ContentStudioDesignSummary {
  id: string;
  name: string;
  latestRevisionNumber: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentStudioDesignList {
  pages: number;
  results: ContentStudioDesignSummary[];
}

export interface ContentStudioDesignRevisionSummary {
  id: string;
  revisionNumber: number;
  schemaVersion: number;
  contentHash: string;
  createdAt: string;
}

export interface ContentStudioDesignRevisionList {
  pages: number;
  results: ContentStudioDesignRevisionSummary[];
}

// The document as the server verified and returned it: checked again in the
// browser before it is shown (see the workspace)
export interface ContentStudioDesignRevisionDetail
  extends ContentStudioDesignRevisionSummary {
  content: unknown;
}

export interface ContentStudioDesignDetail extends ContentStudioDesignSummary {
  currentRevision: ContentStudioDesignRevisionDetail;
}

// One exact Brand Kit revision of the organization, verified by the server
export interface ContentStudioBrandKitRevisionDetail {
  id: string;
  revisionNumber: number;
  schemaVersion: number;
  contentHash: string;
  createdAt: string;
  content: unknown;
}

export interface ContentStudioDesignPageRender {
  id: string;
  designProjectId: string;
  designRevisionId: string;
  designRevisionNumber: number;
  pageId: string;
  status: 'completed';
  width: number;
  height: number;
  mimeType: string;
  renderedMediaId: string;
  createdAt: string;
  completedAt: string;
}

export interface ContentStudioDesignBatchRender {
  id: string;
  designProjectId: string;
  designRevisionId: string;
  designRevisionNumber: number;
  status: 'completed';
  pageCount: number;
  // in the design's page order, as the server rendered them
  outputs: Array<{
    renderId: string;
    pageId: string;
    pageIndex: number;
    width: number;
    height: number;
    mimeType: string;
    renderedMediaId: string;
  }>;
  createdAt: string;
  completedAt: string;
}

// What the Media API answers for one Media of the organization
export interface ContentStudioRenderedMedia {
  id: string;
  path: string | null;
  thumbnail: string | null;
  alt: string | null;
}

// The limit the API enforces
export const DESIGN_NAME_MAX = 200;

// The canvas sizes a new design can start from: nothing else is offered
export const DESIGN_CANVAS_PRESETS = [
  { id: 'square', label: 'Square', width: 1080, height: 1080 },
  { id: 'portrait', label: 'Portrait', width: 1080, height: 1350 },
  { id: 'story', label: 'Story', width: 1080, height: 1920 },
  { id: 'landscape', label: 'Landscape', width: 1200, height: 628 },
] as const;

export type ContentStudioDesignCanvasPreset =
  (typeof DESIGN_CANVAS_PRESETS)[number];

// A page id is a stable name, never a position: a letter first, then at most
// 31 letters, digits, _ or - (p_ and 20 hex characters here)
const randomHex = () => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  }
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
};
export const newContentStudioDesignPageId = () => `p_${randomHex()}`;

// The first document of a new design: one empty white page of the preset's
// size and no Brand Kit (choosing an exact Brand Kit revision is a later,
// explicit step)
export const newContentStudioDesignDocument = (
  preset: ContentStudioDesignCanvasPreset
): ContentStudioDesignDocumentV1 => ({
  schemaVersion: 1,
  brandKit: null,
  pages: [
    {
      id: newContentStudioDesignPageId(),
      name: '',
      width: preset.width,
      height: preset.height,
      background: {
        type: 'solid',
        color: { type: 'literal', value: '#ffffff' },
      },
      layers: [],
    },
  ],
});

export const DESIGNS_PATH = '/content-studio/designs';

export const designsListPath = (archived: boolean, page: number) =>
  `${DESIGNS_PATH}?page=${page}&archived=${archived}`;
export const designPath = (id: string) =>
  `${DESIGNS_PATH}/${encodeURIComponent(id)}`;
export const designRevisionsPath = (id: string, page: number) =>
  `${designPath(id)}/revisions?page=${page}`;
const designRevisionPath = (id: string, revisionId: string) =>
  `${designPath(id)}/revisions/${encodeURIComponent(revisionId)}`;
const brandKitRevisionPath = (revisionId: string) =>
  `/content-studio/brand-kit/revisions/${encodeURIComponent(revisionId)}`;
const mediaStatusPath = (id: string) =>
  `/media/${encodeURIComponent(id)}/status`;

// One summary page: no document is loaded per design
export const useContentStudioDesigns = (archived: boolean, page: number) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioDesignList>(fetch, path),
    [fetch]
  );
  return useSWR(designsListPath(archived, page), load, swrOptions);
};

// The design with its current revision
export const useContentStudioDesign = (id: string) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioDesignDetail>(fetch, path),
    [fetch]
  );
  return useSWR(designPath(id), load, swrOptions);
};

// Revision metadata, newest first
export const useContentStudioDesignRevisions = (id: string, page: number) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioDesignRevisionList>(fetch, path),
    [fetch]
  );
  return useSWR(designRevisionsPath(id, page), load, swrOptions);
};

// Loaded only for the revision the user opens. A revision never changes, so
// its answer is never revalidated
export const useContentStudioDesignRevision = (
  id: string,
  revisionId: string | null
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioDesignRevisionDetail>(fetch, path),
    [fetch]
  );
  return useSWR(revisionId ? designRevisionPath(id, revisionId) : null, load, {
    ...swrOptions,
    revalidateIfStale: false,
  });
};

// The exact Brand Kit revision a document names, never the current one;
// immutable like a design revision
export const useContentStudioBrandKitRevision = (revisionId: string | null) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioBrandKitRevisionDetail>(fetch, path),
    [fetch]
  );
  return useSWR(revisionId ? brandKitRevisionPath(revisionId) : null, load, {
    ...swrOptions,
    revalidateIfStale: false,
  });
};

// A rendered PNG through the Media API of the organization, by its id
export const useContentStudioRenderedMedia = (mediaId: string) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioRenderedMedia>(fetch, path),
    [fetch]
  );
  return useSWR(mediaStatusPath(mediaId), load, {
    ...swrOptions,
    revalidateIfStale: false,
  });
};

// Design writes and renders: one request each, never retried. Writes reload
// the design lists, the design and its history; a render changes no design
// or revision, so it reloads nothing. Nothing is edited in the cache by hand
export const useContentStudioDesignActions = () => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();
  // matcher only, no data: the cached pages stay shown while they reload
  const refresh = useCallback(
    (id?: string) =>
      mutate(
        (key) =>
          typeof key === 'string' &&
          (key.startsWith(`${DESIGNS_PATH}?`) ||
            (!!id &&
              (key === designPath(id) ||
                key.startsWith(`${designPath(id)}/revisions?`))))
      ),
    [mutate]
  );

  return useMemo(
    () => ({
      createDesign: async (
        name: string,
        content: ContentStudioDesignDocumentV1
      ) => {
        const created = await request<ContentStudioDesignSummary>(
          fetch,
          DESIGNS_PATH,
          {
            method: 'POST',
            body: JSON.stringify({ name, content }),
          }
        );
        await refresh();
        return created;
      },
      // the name only: the document changes through a revision
      renameDesign: async (id: string, name: string) => {
        await request(fetch, designPath(id), {
          method: 'PATCH',
          body: JSON.stringify({ name }),
        });
        await refresh(id);
      },
      archiveDesign: async (id: string) => {
        await request(fetch, `${designPath(id)}/archive`, { method: 'POST' });
        await refresh(id);
      },
      restoreDesign: async (id: string) => {
        await request(fetch, `${designPath(id)}/restore`, { method: 'POST' });
        await refresh(id);
      },
      // exactly this revision and page: the server never falls back to the
      // latest revision
      renderDesignPage: (id: string, revisionId: string, pageId: string) =>
        request<ContentStudioDesignPageRender>(
          fetch,
          `${designPath(id)}/render`,
          {
            method: 'POST',
            body: JSON.stringify({ revisionId, pageId }),
          }
        ),
      // the server decides the pages and their order
      renderAllDesignPages: (id: string, revisionId: string) =>
        request<ContentStudioDesignBatchRender>(
          fetch,
          `${designPath(id)}/render-all`,
          {
            method: 'POST',
            body: JSON.stringify({ revisionId }),
          }
        ),
    }),
    [fetch, refresh]
  );
};

// --- messages: fixed text for every outcome, never a server message ---

type Translate = (key: string, fallback: string) => string;

export const designErrorCode = (error: unknown) =>
  error instanceof ContentStudioRequestError ? error.code : undefined;

// Why creating, renaming, archiving or restoring a design failed
export const designErrorMessage = (
  t: Translate,
  error: unknown,
  action: 'create' | 'update'
) => {
  switch (designErrorCode(error)) {
    case 'CS_INVALID_REQUEST':
    case 'CS_DESIGN_INVALID':
      return t(
        'content_studio_error_invalid',
        'Check the values and try again.'
      );
    case 'CS_DESIGN_TOO_LARGE':
      return t(
        'content_studio_design_error_too_large',
        'The design is too large.'
      );
    case 'CS_DESIGN_ARCHIVED':
      return t(
        'content_studio_design_error_archived',
        'This design is archived.'
      );
    case 'CS_DESIGN_INTEGRITY_ERROR':
      return t(
        'content_studio_design_error_integrity',
        'Stored design data could not be read safely.'
      );
    case 'CS_NOT_FOUND':
      return t('content_studio_design_not_found', 'Design not found.');
    default:
      return action === 'create'
        ? t(
            'content_studio_design_create_error',
            'Something went wrong while creating the design.'
          )
        : t(
            'content_studio_design_update_error',
            'Something went wrong while updating the design.'
          );
  }
};

// Why a render failed. A failed render of all pages may still have stored
// the pages before the failing one: nothing here says that nothing was made
export const designRenderErrorMessage = (
  t: Translate,
  error: unknown,
  scope: 'page' | 'all'
) => {
  switch (designErrorCode(error)) {
    case 'CS_DESIGN_RENDER_PAGE_INVALID':
      return t(
        'content_studio_design_render_page_invalid',
        'This page is no longer available in the selected revision.'
      );
    case 'CS_DESIGN_RENDER_ASSET_UNAVAILABLE':
      return t(
        'content_studio_design_render_asset_unavailable',
        'A font or image required by this design is unavailable.'
      );
    case 'CS_DESIGN_RENDER_ASSET_INTEGRITY_ERROR':
      return t(
        'content_studio_design_render_asset_integrity',
        'A stored design asset could not be verified.'
      );
    case 'CS_DESIGN_RENDER_BRAND_INTEGRITY_ERROR':
      return t(
        'content_studio_design_render_brand_integrity',
        'The Brand Kit revision for this design could not be read safely.'
      );
    case 'CS_DESIGN_RENDER_STORAGE_FAILED':
      return t(
        'content_studio_design_render_storage_failed',
        'The rendered design could not be stored.'
      );
    case 'CS_DESIGN_RENDER_FAILED':
      return t(
        'content_studio_design_render_failed',
        'The design could not be rendered.'
      );
    case 'CS_RENDER_FONT_STORAGE_UNAVAILABLE':
      return t(
        'content_studio_design_render_font_storage',
        'Private render font storage is not configured. Ask an administrator to configure render font storage.'
      );
    case 'CS_DESIGN_RENDER_BATCH_TOO_LARGE':
      return t(
        'content_studio_design_render_batch_too_large',
        'This design uses too much source media to render all pages at once.'
      );
    case 'CS_DESIGN_REVISION_NOT_FOUND':
      return t(
        'content_studio_design_revision_missing',
        'This design revision is no longer available.'
      );
    case 'CS_DESIGN_INTEGRITY_ERROR':
      return t(
        'content_studio_design_error_integrity',
        'Stored design data could not be read safely.'
      );
    case 'CS_NOT_FOUND':
      return t('content_studio_design_not_found', 'Design not found.');
    default:
      return scope === 'page'
        ? t(
            'content_studio_design_render_error',
            'Something went wrong while rendering the design.'
          )
        : t(
            'content_studio_design_render_all_error',
            'The design could not be fully rendered.'
          );
  }
};
