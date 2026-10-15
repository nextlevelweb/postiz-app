'use client';

import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import {
  request,
  swrOptions,
} from '@gitroom/frontend/components/content-studio/content-studio.api';

// Sources of the organization, as the source list answers them: names and
// version numbers only. A version's blocks are never loaded here, and a
// source is provenance, not a statement that its text is true

export interface ContentStudioSourceSummary {
  id: string;
  kind: string;
  name: string;
  canonicalUrl: string | null;
  // 0 until the first capture
  latestVersionNumber: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentStudioSourceList {
  pages: number;
  results: ContentStudioSourceSummary[];
}

export const SOURCES_PATH = '/content-studio/sources';

export const sourcesListPath = (archived: boolean, page: number) =>
  `${SOURCES_PATH}?page=${page}&archived=${archived}`;

// One summary page
export const useContentStudioSources = (archived: boolean, page: number) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioSourceList>(fetch, path),
    [fetch]
  );
  return useSWR(sourcesListPath(archived, page), load, swrOptions);
};
