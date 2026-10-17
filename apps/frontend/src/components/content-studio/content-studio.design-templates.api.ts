'use client';

import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import type { ContentStudioDesignDocumentV1 } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  request,
  swrOptions,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import {
  ContentStudioDesignRevisionDetail,
  ContentStudioDesignRevisionList,
  ContentStudioDesignSaveResult,
  ContentStudioDesignSummary,
  DESIGNS_PATH,
  designErrorCode,
} from '@gitroom/frontend/components/content-studio/content-studio.designs.api';

// Design templates: the built-in ones (code on the server, read-only) and
// the organization's own, whose Design Document v1 revisions are immutable.
// The browser lists them with their current documents (drawn by the
// structural preview, never rendered), creates, renames, revises, archives
// and restores the organization's, and asks the server for a new design from
// one exact template revision, or for a new template from one exact saved
// design revision: those two send identities, never a document. It never
// sends an organization or user and never makes a hash

export interface ContentStudioDesignTemplateRevision {
  revisionNumber: number;
  schemaVersion: number;
  contentHash: string;
  content: unknown;
}

// A built-in template: an id like "system:story", never archived or changed
export interface ContentStudioSystemDesignTemplate {
  source: 'system';
  id: string;
  name: string;
  description: string;
  latestRevisionNumber: number;
  archivedAt: null;
  currentRevision: ContentStudioDesignTemplateRevision;
}

export interface ContentStudioOrganizationDesignTemplate {
  source: 'organization';
  id: string;
  name: string;
  description: string | null;
  latestRevisionNumber: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentStudioOrganizationDesignTemplateDetail
  extends ContentStudioOrganizationDesignTemplate {
  currentRevision: ContentStudioDesignRevisionDetail;
}

export type ContentStudioDesignTemplateCard =
  | ContentStudioSystemDesignTemplate
  | ContentStudioOrganizationDesignTemplateDetail;

export interface ContentStudioDesignTemplateCatalog {
  system: ContentStudioSystemDesignTemplate[];
  pages: number;
  results: ContentStudioOrganizationDesignTemplateDetail[];
}

// The limits the API enforces
export const DESIGN_TEMPLATE_DESCRIPTION_MAX = 1000;

export const DESIGN_TEMPLATES_PATH = '/content-studio/design-templates';

export const designTemplatesListPath = (archived: boolean, page: number) =>
  `${DESIGN_TEMPLATES_PATH}?page=${page}&archived=${archived}`;
export const designTemplatePath = (id: string) =>
  `${DESIGN_TEMPLATES_PATH}/${encodeURIComponent(id)}`;
export const designTemplateRevisionsPath = (id: string, page: number) =>
  `${designTemplatePath(id)}/revisions?page=${page}`;
const designTemplateRevisionPath = (id: string, revisionId: string) =>
  `${designTemplatePath(id)}/revisions/${encodeURIComponent(revisionId)}`;

// The built-in templates and one page of the organization's, each with its
// current document only: no history is loaded per card
export const useContentStudioDesignTemplates = (
  archived: boolean,
  page: number
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioDesignTemplateCatalog>(fetch, path),
    [fetch]
  );
  return useSWR(designTemplatesListPath(archived, page), load, swrOptions);
};

// One template of the organization with its current revision
export const useContentStudioDesignTemplate = (id: string) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) =>
      request<ContentStudioOrganizationDesignTemplateDetail>(fetch, path),
    [fetch]
  );
  return useSWR(designTemplatePath(id), load, swrOptions);
};

// Revision metadata, newest first
export const useContentStudioDesignTemplateRevisions = (
  id: string,
  page: number
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioDesignRevisionList>(fetch, path),
    [fetch]
  );
  return useSWR(designTemplateRevisionsPath(id, page), load, swrOptions);
};

// Loaded only for the revision the user opens; a revision never changes
export const useContentStudioDesignTemplateRevision = (
  id: string,
  revisionId: string | null
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioDesignRevisionDetail>(fetch, path),
    [fetch]
  );
  return useSWR(
    revisionId ? designTemplateRevisionPath(id, revisionId) : null,
    load,
    { ...swrOptions, revalidateIfStale: false }
  );
};

// Which exact template revision a new design starts from
export type ContentStudioDesignTemplateChoice =
  | { source: 'system'; templateId: string; revisionNumber: number }
  | { source: 'organization'; templateId: string; revisionId: string };

// Template writes: one request each, never retried. Writes reload the
// template lists, the template and its history; using a template or saving
// a design as one also reloads the design lists. Nothing is edited in the
// cache by hand
export const useContentStudioDesignTemplateActions = () => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();
  // matcher only, no data: the cached pages stay shown while they reload
  const refresh = useCallback(
    (id?: string) =>
      mutate(
        (key) =>
          typeof key === 'string' &&
          (key.startsWith(`${DESIGN_TEMPLATES_PATH}?`) ||
            key.startsWith(`${DESIGNS_PATH}?`) ||
            (!!id &&
              (key === designTemplatePath(id) ||
                key.startsWith(`${designTemplatePath(id)}/revisions?`))))
      ),
    [mutate]
  );

  return useMemo(
    () => ({
      createTemplate: async (input: {
        name: string;
        description: string;
        content: ContentStudioDesignDocumentV1;
      }) => {
        const created =
          await request<ContentStudioOrganizationDesignTemplateDetail>(
            fetch,
            DESIGN_TEMPLATES_PATH,
            {
              method: 'POST',
              body: JSON.stringify({
                name: input.name,
                description: input.description,
                content: input.content,
              }),
            }
          );
        await refresh();
        return created;
      },
      // the name and the description only: the document changes through a
      // revision
      updateTemplate: async (
        id: string,
        details: { name: string; description: string }
      ) => {
        await request(fetch, designTemplatePath(id), {
          method: 'PATCH',
          body: JSON.stringify({
            name: details.name,
            description: details.description,
          }),
        });
        await refresh(id);
      },
      archiveTemplate: async (id: string) => {
        await request(fetch, `${designTemplatePath(id)}/archive`, {
          method: 'POST',
        });
        await refresh(id);
      },
      restoreTemplate: async (id: string) => {
        await request(fetch, `${designTemplatePath(id)}/restore`, {
          method: 'POST',
        });
        await refresh(id);
      },
      // the edited document as the next revision, over the revision the edit
      // started from: a stale base is a conflict
      saveTemplateRevision: async (
        id: string,
        baseRevisionNumber: number,
        content: ContentStudioDesignDocumentV1
      ) => {
        const saved = await request<ContentStudioDesignSaveResult>(
          fetch,
          `${designTemplatePath(id)}/revisions`,
          {
            method: 'POST',
            body: JSON.stringify({ baseRevisionNumber, content }),
          }
        );
        await refresh(id);
        return saved;
      },
      // a new design from exactly this template revision: identities and a
      // name, never a document
      instantiateTemplate: async (
        choice: ContentStudioDesignTemplateChoice,
        name: string
      ) => {
        const created = await request<ContentStudioDesignSummary>(
          fetch,
          `${DESIGN_TEMPLATES_PATH}/instantiate`,
          {
            method: 'POST',
            body: JSON.stringify(
              choice.source === 'system'
                ? {
                    source: 'system',
                    templateId: choice.templateId,
                    revisionNumber: choice.revisionNumber,
                    name,
                  }
                : {
                    source: 'organization',
                    templateId: choice.templateId,
                    revisionId: choice.revisionId,
                    name,
                  }
            ),
          }
        );
        await refresh();
        return created;
      },
      // a new template from exactly this saved design revision: the server
      // reads the revision, the body holds only the template's details
      saveDesignAsTemplate: async (
        designId: string,
        revisionId: string,
        details: { name: string; description: string }
      ) => {
        const created =
          await request<ContentStudioOrganizationDesignTemplateDetail>(
            fetch,
            `${DESIGNS_PATH}/${encodeURIComponent(
              designId
            )}/revisions/${encodeURIComponent(revisionId)}/save-as-template`,
            {
              method: 'POST',
              body: JSON.stringify({
                name: details.name,
                description: details.description,
              }),
            }
          );
        await refresh();
        return created;
      },
    }),
    [fetch, refresh]
  );
};

// --- messages: fixed text for every outcome, never a server message ---

type Translate = (key: string, fallback: string) => string;

export const designTemplateErrorMessage = (t: Translate, error: unknown) => {
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
    case 'CS_DESIGN_TEMPLATE_ARCHIVED':
      return t(
        'content_studio_template_error_archived',
        'This template is archived.'
      );
    case 'CS_DESIGN_TEMPLATE_INTEGRITY_ERROR':
    case 'CS_DESIGN_INTEGRITY_ERROR':
      return t(
        'content_studio_template_error_integrity',
        'Stored template data could not be read safely.'
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
      return t(
        'content_studio_design_brand_integrity',
        'Stored Brand Kit data could not be read safely.'
      );
    case 'CS_NOT_FOUND':
      return t('content_studio_template_not_found', 'Template not found.');
    default:
      return t(
        'content_studio_template_error',
        'Something went wrong with the template.'
      );
  }
};
