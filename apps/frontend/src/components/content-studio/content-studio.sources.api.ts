'use client';

import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import {
  ContentStudioRequestError,
  request,
  swrOptions,
} from '@gitroom/frontend/components/content-studio/content-studio.api';

// Sources of the organization: pages it tracks, with their captured versions
// as provenance, and feeds (RSS or Atom) that find pages. A source is never a
// statement that its text is true. The browser only names a source (kind,
// name, URL) and asks the server to capture it; every version, every page a
// feed found and their provenance come from the server's own fetch. Lists and
// the source carry metadata only: a version's blocks are loaded for the one
// version opened

// A page has versions; a feed has none: its captures find pages, each one an
// ordinary page source
export type ContentStudioSourceKind = 'url' | 'feed';

export interface ContentStudioSourceSummary {
  id: string;
  kind: string;
  name: string;
  canonicalUrl: string | null;
  // 0 until the first capture; always 0 for a feed
  latestVersionNumber: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // a feed's last successful capture; null for a page
  lastCapturedAt: string | null;
}

export interface ContentStudioSourceList {
  pages: number;
  results: ContentStudioSourceSummary[];
}

// What the server recorded about one capture
export interface ContentStudioSourceVersionSummary {
  id: string;
  versionNumber: number;
  schemaVersion: number;
  extractionVersion: string;
  requestedUrl: string;
  finalUrl: string;
  redirectCount: number;
  fetchedAt: string;
  httpStatus: number | null;
  contentType: string | null;
  // bytes the fetch received
  contentLength: number | null;
  title: string | null;
  contentHash: string;
  sourceHash: string | null;
  createdAt: string;
}

export interface ContentStudioSourceVersionList {
  pages: number;
  results: ContentStudioSourceVersionSummary[];
}

export interface ContentStudioSourceDetail extends ContentStudioSourceSummary {
  // metadata of the latest capture, null before the first one
  currentVersion: ContentStudioSourceVersionSummary | null;
}

// Plain text blocks: never HTML, no links or attributes
export interface ContentStudioSourceBlock {
  id: string;
  type: 'heading' | 'paragraph' | 'list_item' | 'quote';
  text: string;
  // heading 1-6, list item nesting 0-8, null otherwise
  level: number | null;
}

export interface ContentStudioSourceVersionDetail
  extends ContentStudioSourceVersionSummary {
  content: {
    schemaVersion: number;
    blocks: ContentStudioSourceBlock[];
  };
}

// What changed in one version (P8-04A), as the server compared it: with the
// first capture of the newest earlier run that is not the same capture
// (blocks, title and extraction), chosen by the server. The browser only
// shows it
export type ContentStudioSourceChange =
  | 'no_earlier_change'
  | 'content_changed'
  | 'title_changed'
  | 'extraction_changed';

export interface ContentStudioComparedVersion {
  id: string;
  versionNumber: number;
  fetchedAt: string;
  title: string | null;
  extractionVersion: string;
}

// Added and removed blocks in document order; kept ones as a count only
export type ContentStudioSourceBlockChange =
  | ({ change: 'added' | 'removed' } & Omit<ContentStudioSourceBlock, 'id'>)
  | { change: 'unchanged'; count: number };

export interface ContentStudioSourceVersionChanges {
  source: { id: string; name: string; canonicalUrl: string | null };
  after: ContentStudioComparedVersion;
  before: ContentStudioComparedVersion | null;
  // the oldest earlier version this one is the same capture as
  repeatOf: { id: string; versionNumber: number; fetchedAt: string } | null;
  change: ContentStudioSourceChange;
  titleChanged: boolean;
  // both fetched bodies had the same hash
  sameFetchedBytes: boolean;
  counts: {
    added: number;
    removed: number;
    unchanged: number;
    beforeBlocks: number;
    afterBlocks: number;
  };
  blocks: ContentStudioSourceBlockChange[];
}

export interface ContentStudioSourceRefreshResult {
  source: ContentStudioSourceSummary;
  version: ContentStudioSourceVersionSummary;
}

// What one feed capture did, in counts only
export interface ContentStudioFeedCaptureCounts {
  entriesSeen: number;
  entriesIgnored: number;
  entriesSkipped: number;
  entriesAccepted: number;
  sourcesCreated: number;
  versionsCreated: number;
  unchanged: number;
  failed: number;
  archived: number;
  // new pages not added: the organization has its most sources (P8-C1)
  entriesLimited: number;
}

export interface ContentStudioFeedCaptureResult {
  source: ContentStudioSourceSummary;
  capture: ContentStudioFeedCaptureCounts;
}

// A page a feed found, with when this feed listed it. The entry's title and
// date are what the feed said, as plain text; the page's own text is in its
// own source. changedSinceFound is the server's answer (P8-04B2): the page
// changed after this feed first listed it, last at source.lastPageChangeAt
export interface ContentStudioSourceDiscovery {
  id: string;
  entryTitle: string | null;
  publishedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  changedSinceFound: boolean;
  source: {
    id: string;
    name: string;
    canonicalUrl: string;
    latestVersionNumber: number;
    archivedAt: string | null;
    lastPageChangeAt: string | null;
  };
}

export interface ContentStudioSourceDiscoveryList {
  pages: number;
  total: number;
  results: ContentStudioSourceDiscovery[];
}

// The limits the API enforces
export const SOURCE_NAME_MAX = 200;
export const SOURCE_SEARCH_MAX = 100;

// A source that can be source material for AI writing (P8-03): a live web
// page with a captured version. The server checks it again when it is used
export const isContentStudioSourceUsable = (source: {
  kind?: string;
  latestVersionNumber: number;
  archivedAt: string | null;
}) =>
  (source.kind === undefined || source.kind === 'url') &&
  !source.archivedAt &&
  source.latestVersionNumber >= 1;

// The host of a stored page URL, read here: nothing is stored or fetched
export const contentStudioSourceHost = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

export const SOURCES_PATH = '/content-studio/sources';

export const sourcesListPath = (
  archived: boolean,
  page: number,
  kind?: ContentStudioSourceKind,
  search?: string
) =>
  `${SOURCES_PATH}?page=${page}&archived=${archived}${
    kind ? `&kind=${kind}` : ''
  }${search?.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''}`;
export const sourcePath = (id: string) =>
  `${SOURCES_PATH}/${encodeURIComponent(id)}`;
export const sourceVersionsPath = (id: string, page: number) =>
  `${sourcePath(id)}/versions?page=${page}`;
export const sourceDiscoveriesPath = (id: string, page: number) =>
  `${sourcePath(id)}/discoveries?page=${page}`;
const sourceVersionPath = (id: string, versionId: string) =>
  `${sourcePath(id)}/versions/${encodeURIComponent(versionId)}`;
export const sourceVersionChangesPath = (id: string, versionId: string) =>
  `${sourceVersionPath(id, versionId)}/changes`;

// One summary page; of one kind when named, and only the sources whose name
// or URL holds the search when there is one (P8-03): searched by the server,
// a page at a time
export const useContentStudioSources = (
  archived: boolean,
  page: number,
  kind?: ContentStudioSourceKind,
  search?: string
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioSourceList>(fetch, path),
    [fetch]
  );
  return useSWR(
    sourcesListPath(archived, page, kind, search),
    load,
    swrOptions
  );
};

export const useContentStudioSource = (id: string) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioSourceDetail>(fetch, path),
    [fetch]
  );
  return useSWR(sourcePath(id), load, swrOptions);
};

// Version metadata, newest first
export const useContentStudioSourceVersions = (id: string, page: number) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioSourceVersionList>(fetch, path),
    [fetch]
  );
  return useSWR(sourceVersionsPath(id, page), load, swrOptions);
};

// The pages a feed found, newest first; loaded for a feed only
export const useContentStudioSourceDiscoveries = (
  id: string,
  page: number,
  enabled: boolean
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioSourceDiscoveryList>(fetch, path),
    [fetch]
  );
  return useSWR(
    enabled ? sourceDiscoveriesPath(id, page) : null,
    load,
    swrOptions
  );
};

// Loaded only for the version the user opens. A version never changes, so
// its answer is never revalidated
export const useContentStudioSourceVersion = (
  id: string,
  versionId: string | null
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioSourceVersionDetail>(fetch, path),
    [fetch]
  );
  return useSWR(versionId ? sourceVersionPath(id, versionId) : null, load, {
    ...swrOptions,
    revalidateIfStale: false,
  });
};

// Loaded only for the version whose changes the user opens. Versions never
// change, but a later capture never changes what an earlier one is compared
// with either, so the answer is never revalidated
export const useContentStudioSourceVersionChanges = (
  id: string,
  versionId: string | null
) => {
  const fetch = useFetch();
  const load = useCallback(
    (path: string) => request<ContentStudioSourceVersionChanges>(fetch, path),
    [fetch]
  );
  return useSWR(
    versionId ? sourceVersionChangesPath(id, versionId) : null,
    load,
    {
      ...swrOptions,
      revalidateIfStale: false,
    }
  );
};

// Source writes: one request each, never retried (a capture repeated after a
// conflict or a timeout is the user's decision), then the source lists (the
// AI writing source list too), the source and its history reload. Nothing is
// edited in the cache by hand
export const useContentStudioSourceActions = () => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();
  // matcher only, no data: the cached pages stay shown while they reload
  const refresh = useCallback(
    (id?: string) =>
      mutate(
        (key) =>
          typeof key === 'string' &&
          (key.startsWith(`${SOURCES_PATH}?`) ||
            (!!id &&
              (key === sourcePath(id) ||
                key.startsWith(`${sourcePath(id)}/versions?`) ||
                key.startsWith(`${sourcePath(id)}/discoveries?`))))
      ),
    [mutate]
  );

  return useMemo(
    () => ({
      refresh,
      // a new source has no capture yet: nothing is fetched here
      createSource: async (
        kind: ContentStudioSourceKind,
        name: string,
        url: string
      ) => {
        const created = await request<ContentStudioSourceSummary>(
          fetch,
          SOURCES_PATH,
          {
            method: 'POST',
            body: JSON.stringify({ kind, name, url }),
          }
        );
        await refresh();
        return created;
      },
      // the name only: the URL is the source's identity
      renameSource: async (id: string, name: string) => {
        await request(fetch, sourcePath(id), {
          method: 'PATCH',
          body: JSON.stringify({ name }),
        });
        await refresh(id);
      },
      archiveSource: async (id: string) => {
        await request(fetch, `${sourcePath(id)}/archive`, { method: 'POST' });
        await refresh(id);
      },
      restoreSource: async (id: string) => {
        await request(fetch, `${sourcePath(id)}/restore`, { method: 'POST' });
        await refresh(id);
      },
      // No body: the server fetches the source's own stored URL. A page
      // answers with its new version, a feed with what its capture did
      captureSource: async (id: string) => {
        const result = await request<
          ContentStudioSourceRefreshResult | ContentStudioFeedCaptureResult
        >(fetch, `${sourcePath(id)}/refresh`, { method: 'POST' });
        await refresh(id);
        return result;
      },
    }),
    [fetch, refresh]
  );
};

// --- messages: fixed text for every outcome, never a server message ---

type Translate = (key: string, fallback: string) => string;

export const sourceErrorCode = (error: unknown) =>
  error instanceof ContentStudioRequestError ? error.code : undefined;

// Why a write or a capture failed. A blocked address says no more than that
// the policy refused it
export const sourceErrorMessage = (t: Translate, error: unknown) => {
  switch (sourceErrorCode(error)) {
    case 'CS_SOURCE_ALREADY_EXISTS':
      return t(
        'content_studio_source_error_exists',
        'This source already exists.'
      );
    case 'CS_SOURCE_INVALID':
    case 'CS_INVALID_REQUEST':
      return t(
        'content_studio_error_invalid',
        'Check the values and try again.'
      );
    case 'CS_SOURCE_FETCH_BLOCKED':
      return t(
        'content_studio_source_error_blocked',
        'This source cannot be fetched by the current security policy.'
      );
    case 'CS_SOURCE_URL_INVALID':
      return t(
        'content_studio_source_error_url_invalid',
        'The source URL is invalid.'
      );
    case 'CS_SOURCE_FETCH_TOO_LARGE':
      return t(
        'content_studio_source_error_fetch_too_large',
        'The source response is too large.'
      );
    case 'CS_SOURCE_CONTENT_TYPE_UNSUPPORTED':
      return t(
        'content_studio_source_error_content_type',
        'This source content type or character encoding is not supported.'
      );
    case 'CS_SOURCE_FETCH_TIMEOUT':
      return t(
        'content_studio_source_error_timeout',
        'The source did not respond in time.'
      );
    case 'CS_SOURCE_FETCH_FAILED':
      return t(
        'content_studio_source_error_fetch_failed',
        'The source could not be fetched.'
      );
    case 'CS_SOURCE_CONTENT_INVALID':
    case 'CS_SOURCE_EXTRACTION_FAILED':
      return t(
        'content_studio_source_error_content_invalid',
        'The source content could not be processed.'
      );
    case 'CS_SOURCE_FEED_INVALID':
      return t(
        'content_studio_source_error_feed_invalid',
        'This address did not answer with an RSS or Atom feed that can be read.'
      );
    case 'CS_SOURCE_TOO_LARGE':
      return t(
        'content_studio_source_error_too_large',
        'The extracted source content is too large.'
      );
    case 'CS_SOURCE_VERSION_CONFLICT':
      return t(
        'content_studio_source_error_conflict',
        'The source changed while it was being captured. Try again.'
      );
    case 'CS_SOURCE_ARCHIVED':
      return t(
        'content_studio_source_error_archived',
        'This source is archived.'
      );
    // the organization's technical limits (P8-C1)
    case 'CS_SOURCE_FEED_LIMIT':
      return t(
        'content_studio_source_error_feed_limit',
        'This organization has reached its limit of active feeds. Archive a feed to add or restore another.'
      );
    case 'CS_SOURCE_LIMIT':
      return t(
        'content_studio_source_error_source_limit',
        'This organization has reached its limit of sources.'
      );
    case 'CS_SOURCE_REFRESH_TOO_SOON':
      return t(
        'content_studio_source_error_refresh_too_soon',
        'This source was captured a moment ago. Try again in a few minutes.'
      );
    case 'CS_SOURCE_CONFLICT':
      return t(
        'content_studio_source_error_sources_changed',
        'Sources were changed at the same time. Try again.'
      );
    case 'CS_SOURCE_KIND_UNSUPPORTED':
      return t(
        'content_studio_source_error_kind',
        'This source type cannot be captured.'
      );
    case 'CS_SOURCE_INTEGRITY_ERROR':
      return t(
        'content_studio_source_error_integrity',
        'Stored source data could not be read safely.'
      );
    case 'CS_NOT_FOUND':
      return t('content_studio_source_not_found', 'Source not found.');
    default:
      return t(
        'content_studio_source_error',
        'Something went wrong while updating the source.'
      );
  }
};
