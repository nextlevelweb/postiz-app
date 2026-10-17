'use client';

import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import type {
  ContentStudioDesignBrandKitRef,
  ContentStudioDesignDocumentV1,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioDesignTemplateGuidanceV1,
  ContentStudioDesignTemplateValue,
  parseContentStudioDesignTemplateGuidance,
} from '@gitroom/nestjs-libraries/content-studio/design/design.template.guidance';
import {
  ContentStudioBrandKitContentV1,
  parseContentStudioBrandKitContent,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import {
  request,
  swrOptions,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import {
  brandKitRevisionPath,
  ContentStudioBrandKitRevisionDetail,
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
// sends an organization or user and never makes a hash. A template revision
// may come with Template Guidance v1 (P4-12): its fields, filled in when the
// template is used (text, or an image the server referenced), and whether
// another exact Brand Kit revision may be chosen. The guidance is saved with
// the document, in the same revision, and never goes into a design

export interface ContentStudioDesignTemplateRevision {
  revisionNumber: number;
  schemaVersion: number;
  contentHash: string;
  content: unknown;
  guidanceHash: string | null;
  guidance: unknown;
}

// An organization template revision with its document and guidance
export interface ContentStudioDesignTemplateRevisionDetail
  extends ContentStudioDesignRevisionDetail {
  guidanceHash: string | null;
  guidance: unknown;
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
  currentRevision: ContentStudioDesignTemplateRevisionDetail;
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
    (path: string) =>
      request<ContentStudioDesignTemplateRevisionDetail>(fetch, path),
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

// The guidance of a revision for exactly its document: none (null), or
// 'invalid' when it does not check out, which is never filled in
export const designTemplateGuidance = (
  document: ContentStudioDesignDocumentV1,
  guidance: unknown
): ContentStudioDesignTemplateGuidanceV1 | null | 'invalid' => {
  if (guidance === null || guidance === undefined) {
    return null;
  }
  try {
    return parseContentStudioDesignTemplateGuidance(guidance, document);
  } catch {
    return 'invalid';
  }
};

// What a guided use adds to the identities: the values of the revision's
// fields by field id and, only when chosen, the id of another exact Brand
// Kit revision
export interface ContentStudioDesignTemplateCustomization {
  values: Record<string, ContentStudioDesignTemplateValue>;
  brandKitRevisionId?: string;
}

export type ContentStudioDesignTemplateBrand =
  | { status: 'loading' | 'error'; content: null }
  | { status: 'ready'; content: ContentStudioBrandKitContentV1 };

// The exact Brand Kit revisions the listed template documents name, for
// their thumbnails: one request per distinct revision (never per card), none
// without a reference, and never the kit's current revision. A revision that
// fails to load, or is not exactly the referenced one, is an error for its
// cards only
export const useContentStudioDesignTemplateBrands = (
  refs: Array<ContentStudioDesignBrandKitRef | null>
) => {
  const fetch = useFetch();
  const distinct = useMemo(() => {
    const byId = new Map<string, ContentStudioDesignBrandKitRef>();
    for (const ref of refs) {
      if (ref && !byId.has(ref.revisionId)) {
        byId.set(ref.revisionId, ref);
      }
    }
    return Array.from(byId.values()).sort((a, b) =>
      a.revisionId < b.revisionId ? -1 : a.revisionId > b.revisionId ? 1 : 0
    );
  }, [refs]);
  const load = useCallback(async () => {
    const loaded = await Promise.all(
      distinct.map(async (ref) => {
        try {
          const revision = await request<ContentStudioBrandKitRevisionDetail>(
            fetch,
            brandKitRevisionPath(ref.revisionId)
          );
          if (revision.id !== ref.revisionId) {
            return [ref.revisionId, null] as const;
          }
          return [
            ref.revisionId,
            {
              revisionNumber: revision.revisionNumber,
              contentHash: revision.contentHash,
              content: parseContentStudioBrandKitContent(revision.content),
            },
          ] as const;
        } catch {
          return [ref.revisionId, null] as const;
        }
      })
    );
    return new Map(loaded);
  }, [distinct, fetch]);
  const key = distinct.length
    ? `content-studio-template-brands:${distinct
        .map((ref) => `${ref.revisionId}@${ref.contentHash}`)
        .join(',')}`
    : null;
  const brands = useSWR(key, load, { ...swrOptions, revalidateIfStale: false });
  return useCallback(
    (
      ref: ContentStudioDesignBrandKitRef | null
    ): ContentStudioDesignTemplateBrand | null => {
      if (!ref) {
        return null;
      }
      if (!brands.data) {
        return brands.error
          ? { status: 'error', content: null }
          : { status: 'loading', content: null };
      }
      // exactly the revision each card names: its number and hash too
      const revision = brands.data.get(ref.revisionId);
      return revision &&
        revision.revisionNumber === ref.revisionNumber &&
        revision.contentHash === ref.contentHash
        ? { status: 'ready', content: revision.content }
        : { status: 'error', content: null };
    },
    [brands.data, brands.error]
  );
};

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
      // the edited document and its guidance (or null) as the next revision,
      // over the revision the edit started from: a stale base is a conflict
      saveTemplateRevision: async (
        id: string,
        baseRevisionNumber: number,
        content: ContentStudioDesignDocumentV1,
        guidance: ContentStudioDesignTemplateGuidanceV1 | null
      ) => {
        const saved = await request<ContentStudioDesignSaveResult>(
          fetch,
          `${designTemplatePath(id)}/revisions`,
          {
            method: 'POST',
            body: JSON.stringify({ baseRevisionNumber, content, guidance }),
          }
        );
        await refresh(id);
        return saved;
      },
      // a new design from exactly this template revision: identities, a
      // name and, for a guided use, the field values and the chosen Brand
      // Kit revision id; never a document
      instantiateTemplate: async (
        choice: ContentStudioDesignTemplateChoice,
        name: string,
        customization?: ContentStudioDesignTemplateCustomization
      ) => {
        const guided = customization
          ? {
              values: customization.values,
              ...(customization.brandKitRevisionId
                ? { brandKitRevisionId: customization.brandKitRevisionId }
                : {}),
            }
          : {};
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
                    ...guided,
                  }
                : {
                    source: 'organization',
                    templateId: choice.templateId,
                    revisionId: choice.revisionId,
                    name,
                    ...guided,
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
    case 'CS_DESIGN_TEMPLATE_GUIDANCE_INVALID':
      return t(
        'content_studio_template_error_guidance',
        'The template fields are invalid.'
      );
    case 'CS_DESIGN_TEMPLATE_GUIDANCE_STALE':
      return t(
        'content_studio_template_error_guidance_stale',
        'A template field no longer matches a layer of the design.'
      );
    case 'CS_DESIGN_TEMPLATE_FIELD_REQUIRED':
      return t(
        'content_studio_template_error_field_required',
        'Fill in every required field.'
      );
    case 'CS_DESIGN_TEMPLATE_FIELD_UNKNOWN':
    case 'CS_DESIGN_TEMPLATE_FIELD_INVALID':
      return t(
        'content_studio_template_error_field_unknown',
        'The template fields changed. Reopen the template and try again.'
      );
    case 'CS_DESIGN_TEMPLATE_MEDIA_INVALID':
    case 'CS_DESIGN_MEDIA_UNAVAILABLE':
    case 'CS_DESIGN_MEDIA_READ_FAILED':
      return t(
        'content_studio_template_error_media',
        'The selected image cannot be used. Choose it again or pick another one.'
      );
    case 'CS_DESIGN_TEMPLATE_BRAND_INCOMPATIBLE':
      return t(
        'content_studio_template_error_brand_incompatible',
        'The selected Brand Kit revision lacks a color or type style this template uses.'
      );
    case 'CS_DESIGN_TEMPLATE_BRAND_REBIND_UNSUPPORTED':
      return t(
        'content_studio_template_error_brand_rebind',
        'This template cannot be used with another Brand Kit revision.'
      );
    case 'CS_DESIGN_TEMPLATE_REVISION_CONFLICT':
      return t(
        'content_studio_template_error_conflict',
        'The template changed. Reload it and try again.'
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
