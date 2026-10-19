'use client';

import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import type { ContentStudioBrandKitContentV1 } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import type {
  ContentStudioDesignBrandKitRef,
  ContentStudioDesignDocumentV1,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import type { ContentStudioDesignCanvasPreset } from '@gitroom/nestjs-libraries/content-studio/design/design.page.set';
import {
  ContentStudioRequestError,
  request,
  swrOptions,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import { newContentStudioDesignPageId } from '@gitroom/frontend/components/content-studio/content-studio.design.editor';

// Designs of the organization: named design projects whose Design Document
// v1 revisions are immutable. The browser reads designs and their revisions,
// creates a design with its first document, renames, archives and restores
// it, saves an edited document as a new revision over the revision it started
// from, and asks the server to render one page or all pages of one exact
// saved revision. It never sends an organization, user or asset, never makes
// a hash itself (image and Brand Kit references come from the server), and
// never builds a URL from a Media id: a rendered Media is looked up through
// the Media API

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

// What the server answers for saving a revision: a new revision, or the
// base revision when the content is the same
export interface ContentStudioDesignSaveResult {
  created: boolean;
  revision: ContentStudioDesignRevisionDetail;
}

// The image reference the server made for one ready Media: its id and the
// SHA-256 of its stored bytes
export interface ContentStudioDesignMediaRef {
  mediaId: string;
  sha256: string;
}

export interface ContentStudioBrandKitSummary {
  latestRevisionNumber: number;
  currentRevision: ContentStudioBrandKitRevisionDetail | null;
}

export interface ContentStudioBrandKitRevisionList {
  pages: number;
  results: Array<Omit<ContentStudioBrandKitRevisionDetail, 'content'>>;
}

// One page of the organization's Media library, as the Media API lists it
export interface ContentStudioMediaLibraryPage {
  pages: number;
  results: Array<{
    id: string;
    name: string | null;
    originalName: string | null;
    path: string;
    thumbnail: string | null;
    alt: string | null;
  }>;
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

// The canvas sizes a new design can start from: nothing else is offered.
// One list, shared with the size variants and the built-in page sets
export {
  DESIGN_CANVAS_PRESETS,
  type ContentStudioDesignCanvasPreset,
} from '@gitroom/nestjs-libraries/content-studio/design/design.page.set';

export { newContentStudioDesignPageId };

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
export const brandKitRevisionPath = (revisionId: string) =>
  `/content-studio/brand-kit/revisions/${encodeURIComponent(revisionId)}`;
const mediaStatusPath = (id: string) =>
  `/media/${encodeURIComponent(id)}/status`;
const BRAND_KIT_PATH = '/content-studio/brand-kit';
const brandKitRevisionsPath = (page: number) =>
  `${BRAND_KIT_PATH}/revisions?page=${page}`;
const mediaLibraryPath = (page: number, search: string) => {
  const params = new URLSearchParams({ page: String(page) });
  if (search.trim()) {
    params.set('search', search.trim());
  }
  return `/media?${params.toString()}`;
};

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

// The organization's Brand Kit and its revisions, for choosing the exact
// revision a design is pinned to. Loaded only while that choice is open
export const useContentStudioBrandKit = (open: boolean) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioBrandKitSummary>(fetch, path),
    [fetch]
  );
  return useSWR(open ? BRAND_KIT_PATH : null, load, swrOptions);
};

export const useContentStudioBrandKitRevisions = (
  open: boolean,
  page: number
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioBrandKitRevisionList>(fetch, path),
    [fetch]
  );
  return useSWR(open ? brandKitRevisionsPath(page) : null, load, swrOptions);
};

// One page of the existing Media library, with its own search; nothing is
// hashed or uploaded from here
export const useContentStudioMediaLibrary = (
  open: boolean,
  page: number,
  search: string
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioMediaLibraryPage>(fetch, path),
    [fetch]
  );
  return useSWR(open ? mediaLibraryPath(page, search) : null, load, swrOptions);
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
      // a new design from a page set, by its id only: the server makes its
      // blank pages (P4-17); the browser sends no pages
      createDesignFromPageSet: async (name: string, pageSetId: string) => {
        const created = await request<ContentStudioDesignSummary>(
          fetch,
          DESIGNS_PATH,
          {
            method: 'POST',
            body: JSON.stringify({ name, pageSetId }),
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
      // the edited document as the next revision, over the revision the edit
      // started from (never the latest one): a stale base is a conflict.
      // The lists, the design and its history reload before it returns
      saveDesignRevision: async (
        id: string,
        baseRevisionNumber: number,
        content: ContentStudioDesignDocumentV1
      ) => {
        const saved = await request<ContentStudioDesignSaveResult>(
          fetch,
          `${designPath(id)}/revisions`,
          {
            method: 'POST',
            body: JSON.stringify({ baseRevisionNumber, content }),
          }
        );
        await refresh(id);
        return saved;
      },
      // the server reads the Media's stored bytes and hashes them
      getMediaDesignRef: (mediaId: string) =>
        request<ContentStudioDesignMediaRef>(
          fetch,
          `/content-studio/media/${encodeURIComponent(mediaId)}/design-ref`
        ),
      // the exact reference of one verified Brand Kit revision, and that
      // revision's content (the existing revision route)
      getBrandKitDesignRef: (revisionId: string) =>
        request<ContentStudioDesignBrandKitRef>(
          fetch,
          `${brandKitRevisionPath(revisionId)}/design-ref`
        ),
      getBrandKitRevision: (revisionId: string) =>
        request<ContentStudioBrandKitRevisionDetail>(
          fetch,
          brandKitRevisionPath(revisionId)
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

// Why saving the edited document failed. A conflict has its own notice
export const designSaveErrorMessage = (t: Translate, error: unknown) => {
  switch (designErrorCode(error)) {
    case 'CS_DESIGN_ARCHIVED':
      return t(
        'content_studio_design_error_archived',
        'This design is archived.'
      );
    case 'CS_DESIGN_BRAND_REFERENCE_NOT_FOUND':
      return t(
        'content_studio_design_save_brand_missing',
        'The selected Brand Kit revision is no longer available.'
      );
    case 'CS_DESIGN_BRAND_REFERENCE_INVALID':
      return t(
        'content_studio_design_save_brand_invalid',
        'The Brand Kit reference in this design is invalid.'
      );
    case 'CS_DESIGN_BRAND_REFERENCE_INTEGRITY_ERROR':
    case 'CS_BRAND_KIT_INTEGRITY_ERROR':
      return t(
        'content_studio_design_brand_integrity',
        'Stored Brand Kit data could not be read safely.'
      );
    case 'CS_DESIGN_INTEGRITY_ERROR':
      return t(
        'content_studio_design_error_integrity',
        'Stored design data could not be read safely.'
      );
    case 'CS_DESIGN_TOO_LARGE':
      return t(
        'content_studio_design_save_too_large',
        'This design is too large to save.'
      );
    case 'CS_DESIGN_INVALID':
    case 'CS_INVALID_REQUEST':
      return t(
        'content_studio_design_save_invalid',
        'The design contains invalid values. Fix them before saving.'
      );
    case 'CS_NOT_FOUND':
      return t('content_studio_design_not_found', 'Design not found.');
    default:
      return t(
        'content_studio_design_save_error',
        'Something went wrong while saving the design.'
      );
  }
};

// Why a Media item or a Brand Kit revision could not be used in a design
export const designReferenceErrorMessage = (t: Translate, error: unknown) => {
  switch (designErrorCode(error)) {
    case 'CS_NOT_FOUND':
      return t(
        'content_studio_design_ref_not_found',
        'This item is no longer available.'
      );
    case 'CS_DESIGN_MEDIA_UNAVAILABLE':
      return t(
        'content_studio_design_media_unavailable',
        'This media item cannot be used in a design.'
      );
    case 'CS_DESIGN_MEDIA_READ_FAILED':
      return t(
        'content_studio_design_media_read_failed',
        'The media item could not be read safely.'
      );
    case 'CS_BRAND_KIT_INTEGRITY_ERROR':
      return t(
        'content_studio_design_brand_integrity',
        'Stored Brand Kit data could not be read safely.'
      );
    default:
      return t(
        'content_studio_design_ref_error',
        'Something went wrong. Try again.'
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
