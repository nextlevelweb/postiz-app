'use client';

import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import {
  CONTENT_STUDIO_DISCOVERY_CAPTURE_STATES,
  CONTENT_STUDIO_DISCOVERY_DEFAULT_WINDOW,
  CONTENT_STUDIO_DISCOVERY_WINDOWS,
  ContentStudioDiscoveryCaptureState,
  ContentStudioDiscoveryWindow,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.types';
import {
  request,
  swrOptions,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import { ContentStudioSourceDiscovery } from '@gitroom/frontend/components/content-studio/content-studio.sources.api';

// Research (P8-02): News Radar, what the organization's live feeds found, as
// one read-only list across feeds. Its filters live in the page URL. It only
// reads: feeds are added, captured and archived in the Source Library

// News Radar (P8-02): a page one live feed of the organization found, with
// that feed. A page two feeds found is two of these
export interface ContentStudioRadarDiscovery
  extends ContentStudioSourceDiscovery {
  feed: { id: string; name: string };
}

export interface ContentStudioRadarList {
  pages: number;
  total: number;
  results: ContentStudioRadarDiscovery[];
}

export interface ContentStudioRadarFilters {
  since: ContentStudioDiscoveryWindow;
  feed: string | null;
  capture: ContentStudioDiscoveryCaptureState | null;
  page: number;
}

export const RADAR_PAGE = '/content-studio/research';
export const DISCOVERIES_PATH = '/content-studio/discoveries';
const PAGE_MAX = 100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The Radar of the URL: a known window (none: 7 days), a feed id, a capture
// state and a page; anything else is the default
export const parseContentStudioRadarFilters = (search: {
  get(name: string): string | null;
}): ContentStudioRadarFilters => {
  const since = search.get('since');
  const feed = search.get('feed');
  const capture = search.get('capture');
  const page = search.get('page');
  const pageNumber = page && /^\d+$/.test(page) ? Number(page) : 1;
  return {
    since: (CONTENT_STUDIO_DISCOVERY_WINDOWS as readonly string[]).includes(
      since ?? ''
    )
      ? (since as ContentStudioDiscoveryWindow)
      : CONTENT_STUDIO_DISCOVERY_DEFAULT_WINDOW,
    feed: feed && UUID.test(feed) ? feed : null,
    capture: (
      CONTENT_STUDIO_DISCOVERY_CAPTURE_STATES as readonly string[]
    ).includes(capture ?? '')
      ? (capture as ContentStudioDiscoveryCaptureState)
      : null,
    page: pageNumber >= 1 && pageNumber <= PAGE_MAX ? pageNumber : 1,
  };
};

export const radarPath = (filters: ContentStudioRadarFilters) => {
  const params = new URLSearchParams({
    page: String(filters.page),
    since: filters.since,
  });
  if (filters.feed) {
    params.set('feedSourceId', filters.feed);
  }
  if (filters.capture) {
    params.set('captureState', filters.capture);
  }
  return `${DISCOVERIES_PATH}?${params.toString()}`;
};

// The Radar page of one feed
export const radarFeedPagePath = (feedId: string) =>
  `${RADAR_PAGE}?feed=${encodeURIComponent(feedId)}`;

// The filters live in the URL, so leaving for a page and coming back shows
// the same Radar. A new window, feed or capture state starts on page 1
export const useContentStudioRadarFilters = () => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(
    () => parseContentStudioRadarFilters(searchParams),
    [searchParams]
  );
  const setFilters = useCallback(
    (next: Partial<ContentStudioRadarFilters>) => {
      const merged = { ...filters, page: 1, ...next };
      const params = new URLSearchParams();
      if (merged.since !== CONTENT_STUDIO_DISCOVERY_DEFAULT_WINDOW) {
        params.set('since', merged.since);
      }
      if (merged.feed) {
        params.set('feed', merged.feed);
      }
      if (merged.capture) {
        params.set('capture', merged.capture);
      }
      if (merged.page > 1) {
        params.set('page', String(merged.page));
      }
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [filters, pathname, router]
  );
  return { filters, setFilters };
};

// One page of what the organization's live feeds found, as the server
// ordered it. Read only: loading it fetches and captures nothing
export const useContentStudioRadar = (filters: ContentStudioRadarFilters) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioRadarList>(fetch, path),
    [fetch]
  );
  return useSWR(radarPath(filters), load, swrOptions);
};
