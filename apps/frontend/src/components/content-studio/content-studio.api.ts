'use client';

import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

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
const request = async <T>(
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

const swrOptions = {
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
