'use client';

import { useCallback, useMemo, useRef } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import type { ContentStudioRevisionApprovalState } from '@gitroom/nestjs-libraries/content-studio/review/review.approval';

// The shapes the Content Studio API returns. The organization comes from the
// session on the server: it is never part of a request, a cache key or the
// URL. A reload on organization switch clears the SWR cache
export interface ContentStudioProject {
  id: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentStudioPackageSummary {
  id: string;
  name: string;
  projectId: string | null;
  draftVersion: number;
  latestRevisionNumber: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentStudioPackageList {
  pages: number;
  results: ContentStudioPackageSummary[];
}

export interface ContentStudioFilters {
  projectId?: string;
  archived: boolean;
  page: number;
}

// The limits the API enforces
export const PROJECT_NAME_MAX = 100;
export const PACKAGE_NAME_MAX = 200;
const PAGE_MAX = 100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The status and Content Studio code of a failed request, never its body text
export class ContentStudioRequestError extends Error {
  constructor(public status: number, public code?: string) {
    super('Content Studio request failed');
    this.name = 'ContentStudioRequestError';
  }
}

type Fetch = ReturnType<typeof useFetch>;

// useFetch answers every HTTP status with a Response: anything but 2xx is a
// failure here
export const request = async <T>(
  fetch: Fetch,
  path: string,
  init?: RequestInit
): Promise<T> => {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ContentStudioRequestError(
      response.status,
      typeof body?.code === 'string' ? body.code : undefined
    );
  }
  return response.json();
};

const PROJECTS = '/content-studio/projects';
const PACKAGES = '/content-studio/packages';

export const projectsPath = (archived: boolean) =>
  `${PROJECTS}?archived=${archived}`;

export const packagesPath = (filters: ContentStudioFilters) => {
  const params = new URLSearchParams({
    page: String(filters.page),
    archived: String(filters.archived),
  });
  if (filters.projectId) {
    params.set('projectId', filters.projectId);
  }
  return `${PACKAGES}?${params.toString()}`;
};

export const packagePath = (id: string) =>
  `/content-studio/${encodeURIComponent(id)}`;

// Research into content (P8-03): the sources a package link names for AI
// writing, as `sources=id1,id2` in the order given. As many as one AI writing
// request can use (CONTENT_STUDIO_AI_MAX_SOURCES)
export const RESEARCH_SOURCES_PARAM = 'sources';
export const RESEARCH_SOURCES_MAX = 5;

// The source ids of the link, in its order: only ids (anything else is
// dropped), each once, at most five. They are names to look up, nothing more:
// the server decides what each one is
export const parseContentStudioResearchSourceIds = (value: unknown) => {
  if (typeof value !== 'string') {
    return [];
  }
  const ids: string[] = [];
  for (const part of value.split(',')) {
    const id = part.trim().toLowerCase();
    if (UUID.test(id) && !ids.includes(id)) {
      ids.push(id);
    }
    if (ids.length === RESEARCH_SOURCES_MAX) {
      break;
    }
  }
  return ids;
};

// A package with research sources ready for AI writing
export const packageResearchPath = (packageId: string, sourceIds: string[]) => {
  const ids = parseContentStudioResearchSourceIds(sourceIds.join(','));
  return ids.length
    ? `${packagePath(packageId)}?${new URLSearchParams({
        [RESEARCH_SOURCES_PARAM]: ids.join(','),
      }).toString()}`
    : packagePath(packageId);
};

export const swrOptions = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  refreshWhenHidden: false,
  refreshWhenOffline: false,
};

export const useContentStudioProjects = (archived: boolean) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioProject[]>(fetch, path),
    [fetch]
  );
  return useSWR(projectsPath(archived), load, swrOptions);
};

// One summary list: no draft, Media or revisions are loaded per package
export const useContentStudioPackages = (filters: ContentStudioFilters) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioPackageList>(fetch, path),
    [fetch]
  );
  return useSWR(packagesPath(filters), load, swrOptions);
};

// The package draft as the API sends it: plain text and Media ids only.
// Paths never live in a draft. Schema v1 is the copy alone; v2 adds
// grounding (P3-11): claims of thread items, each with evidence naming one
// block of one exact source version. Grounding never changes the copy
export interface ContentStudioThreadItem {
  id: string;
  text: string;
  mediaIds: string[];
}

export interface ContentStudioClaimEvidence {
  sourceId: string;
  versionId: string;
  versionNumber: number;
  contentHash: string;
  blockId: string;
  quote: string | null;
}

export interface ContentStudioClaim {
  id: string;
  threadItemId: string;
  text: string;
  evidence: ContentStudioClaimEvidence[];
}

interface ContentStudioCopy {
  global: {
    thread: ContentStudioThreadItem[];
  };
}

export type ContentStudioDraft =
  | { schemaVersion: 1; copy: ContentStudioCopy }
  | {
      schemaVersion: 2;
      copy: ContentStudioCopy;
      grounding: { claims: ContentStudioClaim[] };
    };

// The current state of a Media the draft refers to; null when it is missing,
// deleted or not the organization's
export interface ContentStudioMediaPreview {
  id: string;
  path: string;
  thumbnail: string | null;
  alt: string | null;
  status: string;
}

export type ContentStudioMediaMap = Record<
  string,
  ContentStudioMediaPreview | null
>;

export interface ContentStudioPackageDetail
  extends ContentStudioPackageSummary {
  draft: ContentStudioDraft;
  media: ContentStudioMediaMap;
}

// Whether exactly one saved revision is approved now and where it stands
// (P5-05), as the server judged it from that revision's own review and its
// whole approval history. Shown as it is: never derived in the browser
export interface ContentStudioRevisionApprovalSummary {
  approved: boolean;
  state: ContentStudioRevisionApprovalState;
}

// The same for one revision on its own, with the decision in force (none
// while pending, also after a withdrawal)
export interface ContentStudioRevisionApprovalStatus
  extends ContentStudioRevisionApprovalSummary {
  targetType: 'PACKAGE_REVISION' | 'DESIGN_REVISION';
  targetRevisionId: string;
  targetRevisionNumber: number;
  targetContentHash: string;
  reviewId: string | null;
  approvalVersion: number;
  currentDecision: null | {
    sequence: number;
    decision: 'APPROVED' | 'REFUSED';
    note: string | null;
    actor: { id: string; name: string | null };
    createdAt: string;
  };
}

export interface ContentStudioRevisionSummary {
  id: string;
  revisionNumber: number;
  contentHash: string;
  origin: string;
  sourceDraftVersion: number;
  createdAt: string;
  createdBy: { id: string; name: string | null };
  approval: ContentStudioRevisionApprovalSummary;
}

export interface ContentStudioRevisionList {
  pages: number;
  results: ContentStudioRevisionSummary[];
}

export interface ContentStudioRevisionDetail
  extends ContentStudioRevisionSummary {
  packageId: string;
  schemaVersion: number;
  content: ContentStudioDraft;
  media: ContentStudioMediaMap;
  approval: ContentStudioRevisionApprovalStatus;
  // whether a handoff requires approval, by the current policy (P5-07)
  handoffApprovalRequired: boolean;
}

export interface ContentStudioCreateRevisionResult {
  created: boolean;
  revision: {
    id: string;
    revisionNumber: number;
  };
}

export interface ContentStudioHandoffCreateResult {
  id: string;
  expiresAt: string;
}

// The draft limits the API enforces
export const THREAD_ITEMS_MAX = 25;
export const ITEM_TEXT_MAX = 10_000;
export const ITEM_MEDIA_MAX = 20;
export const PACKAGE_UNIQUE_MEDIA_MAX = 50;

export const packageDetailPath = (id: string) =>
  `${PACKAGES}/${encodeURIComponent(id)}`;
export const revisionsPath = (id: string, page: number) =>
  `${packageDetailPath(id)}/revisions?page=${page}`;

// The detail is read once per visit to seed the editor: `fresh` is the last
// answer this hook instance fetched itself, so data cached by an earlier visit
// (and maybe outdated by saves since) is never mistaken for it
export const useContentStudioPackage = (id: string) => {
  const fetch = useFetch();
  const fresh = useRef<ContentStudioPackageDetail | null>(null);
  const load = useCallback(
    async (path: string) => {
      const detail = await request<ContentStudioPackageDetail>(fetch, path);
      fresh.current = detail;
      return detail;
    },
    [fetch]
  );
  const swr = useSWR(packageDetailPath(id), load, {
    ...swrOptions,
    revalidateIfStale: false,
    revalidateOnMount: true,
  });
  return { ...swr, fresh };
};

// Only mounted while the history is shown
export const useContentStudioRevisions = (id: string, page: number) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioRevisionList>(fetch, path),
    [fetch]
  );
  return useSWR(revisionsPath(id, page), load, swrOptions);
};

// Loaded only for the revision the user opens
export const useContentStudioRevision = (
  id: string,
  revisionId: string | null
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioRevisionDetail>(fetch, path),
    [fetch]
  );
  return useSWR(
    revisionId
      ? `${packageDetailPath(id)}/revisions/${encodeURIComponent(revisionId)}`
      : null,
    load,
    swrOptions
  );
};

// The writes of the workspace. None of them edits the SWR cache: the editor
// keeps its own state, seeded once from the detail
export const useContentStudioWorkspaceApi = () => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();

  return useMemo(
    () => ({
      getPackage: (id: string) =>
        request<ContentStudioPackageDetail>(fetch, packageDetailPath(id)),
      saveDraft: (id: string, baseDraftVersion: number, draft: unknown) =>
        request<{ draftVersion: number }>(
          fetch,
          `${packageDetailPath(id)}/draft`,
          {
            method: 'PUT',
            body: JSON.stringify({ baseDraftVersion, draft }),
          }
        ),
      createRevision: (
        id: string,
        draftVersion: number,
        origin: 'manual' | 'handoff'
      ) =>
        request<ContentStudioCreateRevisionResult>(
          fetch,
          `${packageDetailPath(id)}/revisions`,
          {
            method: 'POST',
            body: JSON.stringify({ draftVersion, origin }),
          }
        ),
      listRevisions: (id: string, page: number) =>
        request<ContentStudioRevisionList>(fetch, revisionsPath(id, page)),
      getRevision: (id: string, revisionId: string) =>
        request<ContentStudioRevisionDetail>(
          fetch,
          `${packageDetailPath(id)}/revisions/${encodeURIComponent(revisionId)}`
        ),
      createHandoff: (id: string, revisionId: string) =>
        request<ContentStudioHandoffCreateResult>(
          fetch,
          `${packageDetailPath(id)}/revisions/${encodeURIComponent(
            revisionId
          )}/handoffs`,
          { method: 'POST' }
        ),
      // the history pages of this package, and the home lists
      refreshRevisions: (id: string) =>
        mutate(
          (key) =>
            typeof key === 'string' &&
            key.startsWith(`${packageDetailPath(id)}/revisions?`)
        ),
      refreshPackageLists: () =>
        mutate(
          (key) => typeof key === 'string' && key.startsWith(`${PACKAGES}?`)
        ),
    }),
    [fetch, mutate]
  );
};

// Filters live in the URL (?project=&archived=true&page=), so a reload or
// the back button keeps them. Anything malformed falls back to the default
export const parseContentStudioFilters = (search: {
  get(name: string): string | null;
}): ContentStudioFilters => {
  const project = search.get('project');
  const page = search.get('page');
  const pageNumber = page && /^\d+$/.test(page) ? Number(page) : 1;
  return {
    ...(project && UUID.test(project) ? { projectId: project } : {}),
    archived: search.get('archived') === 'true',
    page: pageNumber >= 1 && pageNumber <= PAGE_MAX ? pageNumber : 1,
  };
};

export const useContentStudioFilters = () => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(
    () => parseContentStudioFilters(searchParams),
    [searchParams]
  );

  // A new project or archive state starts again on page 1. Other URL
  // parameters are kept
  const setFilters = useCallback(
    (next: Partial<ContentStudioFilters>) => {
      const merged = { ...filters, ...next };
      if ('projectId' in next || 'archived' in next) {
        merged.page = next.page ?? 1;
      }
      const params = new URLSearchParams(searchParams.toString());
      params.delete('project');
      params.delete('archived');
      params.delete('page');
      if (merged.projectId) {
        params.set('project', merged.projectId);
      }
      if (merged.archived) {
        params.set('archived', 'true');
      }
      if (merged.page > 1) {
        params.set('page', String(merged.page));
      }
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [filters, searchParams, pathname, router]
  );

  return { filters, setFilters };
};

// Writes revalidate what they change: project names live in the project
// lists, packages in the package pages. Nothing is edited in the cache by hand
export const useContentStudioActions = () => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();

  // matcher only, no data: the cached pages stay shown while they reload
  const refresh = useCallback(
    (prefix: string) =>
      mutate((key) => typeof key === 'string' && key.startsWith(`${prefix}?`)),
    [mutate]
  );
  const send = useCallback(
    <T>(path: string, method: string, body?: Record<string, unknown>) =>
      request<T>(fetch, path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    [fetch]
  );

  return useMemo(
    () => ({
      createProject: async (name: string) => {
        const project = await send<ContentStudioProject>(PROJECTS, 'POST', {
          name,
        });
        await refresh(PROJECTS);
        return project;
      },
      renameProject: async (id: string, name: string) => {
        const project = await send<ContentStudioProject>(
          `${PROJECTS}/${encodeURIComponent(id)}`,
          'PATCH',
          { name }
        );
        await refresh(PROJECTS);
        return project;
      },
      // its packages are not archived with it
      archiveProject: async (id: string) => {
        const project = await send<ContentStudioProject>(
          `${PROJECTS}/${encodeURIComponent(id)}/archive`,
          'POST'
        );
        await refresh(PROJECTS);
        return project;
      },
      restoreProject: async (id: string) => {
        const project = await send<ContentStudioProject>(
          `${PROJECTS}/${encodeURIComponent(id)}/restore`,
          'POST'
        );
        await refresh(PROJECTS);
        return project;
      },
      createPackage: async (input: { name?: string; projectId?: string }) => {
        const created = await send<ContentStudioPackageSummary>(
          PACKAGES,
          'POST',
          {
            ...(input.name ? { name: input.name } : {}),
            ...(input.projectId ? { projectId: input.projectId } : {}),
          }
        );
        await refresh(PACKAGES);
        return created;
      },
      archivePackage: async (id: string) => {
        await send(`${PACKAGES}/${encodeURIComponent(id)}/archive`, 'POST');
        await refresh(PACKAGES);
      },
      restorePackage: async (id: string) => {
        await send(`${PACKAGES}/${encodeURIComponent(id)}/restore`, 'POST');
        await refresh(PACKAGES);
      },
    }),
    [send, refresh]
  );
};

// Fixed text for every failure: never the server's message
export const contentStudioErrorMessage = (
  t: (key: string, fallback: string) => string,
  error: unknown
) => {
  const code =
    error instanceof ContentStudioRequestError ? error.code : undefined;
  switch (code) {
    case 'CS_NOT_FOUND':
      return t(
        'content_studio_error_not_found',
        'This Content Studio item could not be found.'
      );
    case 'CS_PROJECT_ARCHIVED':
      return t(
        'content_studio_error_project_archived',
        'This project is archived.'
      );
    case 'CS_PACKAGE_ARCHIVED':
      return t(
        'content_studio_error_package_archived',
        'This package is archived.'
      );
    case 'CS_INVALID_REQUEST':
      return t(
        'content_studio_error_invalid',
        'Check the values and try again.'
      );
    default:
      return error instanceof ContentStudioRequestError && error.status === 400
        ? t('content_studio_error_invalid', 'Check the values and try again.')
        : t('content_studio_error', 'Could not update Content Studio.');
  }
};
