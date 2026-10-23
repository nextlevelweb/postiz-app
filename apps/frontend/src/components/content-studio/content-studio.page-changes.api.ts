'use client';

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import {
  CONTENT_STUDIO_DISCOVERY_DEFAULT_WINDOW,
  CONTENT_STUDIO_DISCOVERY_WINDOWS,
  ContentStudioDiscoveryWindow,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.types';
import {
  request,
  swrOptions,
} from '@gitroom/frontend/components/content-studio/content-studio.api';

// Research (P8-04B1): Changes, the organization's page sources by their last
// page change, as one read-only list next to News Radar. Its filters live in
// the page URL with the tab. The server finds and checks the changes; this
// only shows them, and opens a change through its own version

export interface ContentStudioPageChange {
  source: {
    id: string;
    name: string;
    canonicalUrl: string;
    archivedAt: string | null;
  };
  change: 'content_changed' | 'title_changed';
  changedAt: string;
  previousCaptureAt: string;
  version: { id: string; versionNumber: number };
}

export interface ContentStudioPageChangeList {
  pages: number;
  total: number;
  results: ContentStudioPageChange[];
}

export interface ContentStudioPageChangeFilters {
  since: ContentStudioDiscoveryWindow;
  page: number;
}

export const PAGE_CHANGES_PATH = '/content-studio/source-changes';
const PAGE_MAX = 100_000;

// The Changes of the URL: a known window (none: 7 days) and a page; anything
// else is the default
export const parseContentStudioPageChangeFilters = (search: {
  get(name: string): string | null;
}): ContentStudioPageChangeFilters => {
  const since = search.get('since');
  const page = search.get('page');
  const pageNumber = page && /^\d+$/.test(page) ? Number(page) : 1;
  return {
    since: (CONTENT_STUDIO_DISCOVERY_WINDOWS as readonly string[]).includes(
      since ?? ''
    )
      ? (since as ContentStudioDiscoveryWindow)
      : CONTENT_STUDIO_DISCOVERY_DEFAULT_WINDOW,
    page: pageNumber >= 1 && pageNumber <= PAGE_MAX ? pageNumber : 1,
  };
};

export const pageChangesPath = (filters: ContentStudioPageChangeFilters) =>
  `${PAGE_CHANGES_PATH}?${new URLSearchParams({
    page: String(filters.page),
    since: filters.since,
  }).toString()}`;

// The filters live in the URL next to the tab, so leaving for a page and
// coming back shows the same Changes. A new window starts on page 1
export const useContentStudioPageChangeFilters = () => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(
    () => parseContentStudioPageChangeFilters(searchParams),
    [searchParams]
  );
  const setFilters = useCallback(
    (next: Partial<ContentStudioPageChangeFilters>) => {
      const merged = { ...filters, page: 1, ...next };
      const params = new URLSearchParams({ tab: 'changes' });
      if (merged.since !== CONTENT_STUDIO_DISCOVERY_DEFAULT_WINDOW) {
        params.set('since', merged.since);
      }
      if (merged.page > 1) {
        params.set('page', String(merged.page));
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [filters, pathname, router]
  );
  return { filters, setFilters };
};

// One page of the organization's page changes, as the server ordered it.
// Read only: loading it fetches and captures nothing
export const useContentStudioSourceChanges = (
  filters: ContentStudioPageChangeFilters
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioPageChangeList>(fetch, path),
    [fetch]
  );
  return useSWR(pageChangesPath(filters), load, swrOptions);
};
