'use client';

import { FC, useEffect } from 'react';
import clsx from 'clsx';
import Link from 'next/link';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';
import { ContentStudioDiscoveryRow } from '@gitroom/frontend/components/content-studio/content-studio.discovery.row';
import { useContentStudioSources } from '@gitroom/frontend/components/content-studio/content-studio.sources.api';
import {
  ContentStudioRadarDiscovery,
  ContentStudioRadarFilters,
  useContentStudioRadar,
  useContentStudioRadarFilters,
} from '@gitroom/frontend/components/content-studio/content-studio.research.api';
import {
  SOURCE_LIBRARY_PATH,
  sourcePagePath,
} from '@gitroom/frontend/components/content-studio/content-studio.sources';
import {
  CONTENT_STUDIO_DISCOVERY_CAPTURE_STATES,
  CONTENT_STUDIO_DISCOVERY_WINDOWS,
  ContentStudioDiscoveryCaptureState,
  ContentStudioDiscoveryWindow,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.types';

const linkClass =
  'px-[24px] h-[40px] flex items-center rounded-full bg-third border border-textColor/60 text-textColor';

const useWindowLabel = () => {
  const t = useT();
  return (since: ContentStudioDiscoveryWindow) =>
    since === '24h'
      ? t('content_studio_radar_24h', '24 hours')
      : since === '7d'
      ? t('content_studio_radar_7d', '7 days')
      : since === '30d'
      ? t('content_studio_radar_30d', '30 days')
      : t('content_studio_radar_all', 'All time');
};

const useCaptureLabel = () => {
  const t = useT();
  return (capture: ContentStudioDiscoveryCaptureState | null) =>
    capture === 'captured'
      ? t('content_studio_discovery_captured', 'Captured')
      : capture === 'not-captured'
      ? t('content_studio_discovery_not_captured', 'Not captured')
      : t('content_studio_radar_capture_all', 'All');
};

// The feed that found a page: its own source, or the Radar of that feed only
const Provenance: FC<{
  discovery: ContentStudioRadarDiscovery;
  filters: ContentStudioRadarFilters;
  setFilters: (next: Partial<ContentStudioRadarFilters>) => void;
}> = ({ discovery, filters, setFilters }) => {
  const t = useT();
  return (
    <div className="text-[13px] flex flex-wrap items-center gap-x-[8px] gap-y-[2px] min-w-0">
      <span>{t('content_studio_radar_found_by', 'Found by')}</span>
      <Link
        href={sourcePagePath(discovery.feed.id)}
        className="underline hover:no-underline break-words min-w-0"
      >
        {discovery.feed.name}
      </Link>
      {filters.feed !== discovery.feed.id && (
        <button
          type="button"
          className="text-textItemBlur underline hover:no-underline"
          onClick={() => setFilters({ feed: discovery.feed.id })}
        >
          {t('content_studio_radar_only_feed', 'Only this feed')}
        </button>
      )}
    </div>
  );
};

// What the organization's live feeds found, across feeds, newest first
// sighting first: one row per feed and page, so a page two feeds found is
// two rows. Found is when a feed first listed the page for this
// organization, not when it was published. Read only: opening it fetches,
// captures and marks nothing. Feeds are managed in Sources
export const ContentStudioResearch: FC = () => {
  const t = useT();
  const windowLabel = useWindowLabel();
  const captureLabel = useCaptureLabel();
  const { filters, setFilters } = useContentStudioRadarFilters();
  // the first page of live feeds only: P8-DEFERRED-07
  const feeds = useContentStudioSources(false, 1, 'feed');
  const radar = useContentStudioRadar(filters);

  const pages = radar.data?.pages;
  // a page that no longer exists moves to the last one
  useEffect(() => {
    if (pages !== undefined && filters.page > Math.max(pages, 1)) {
      setFilters({ page: Math.max(pages, 1) });
    }
  }, [pages, filters.page, setFilters]);

  const feedOptions = feeds.data?.results ?? [];
  // a feed named in the URL but not on the first page keeps its choice
  const selectedName =
    filters.feed && !feedOptions.some((feed) => feed.id === filters.feed)
      ? radar.data?.results.find((row) => row.feed.id === filters.feed)?.feed
          .name ?? t('content_studio_radar_selected_feed', 'Selected feed')
      : null;
  const noFeeds = !!feeds.data && feeds.data.results.length === 0;

  const empty = () => {
    if (noFeeds) {
      return (
        <>
          <div>
            {t(
              'content_studio_radar_no_feeds',
              'Add a feed to see what it finds.'
            )}
          </div>
          <Link href={SOURCE_LIBRARY_PATH} className={linkClass}>
            {t('content_studio_sources', 'Sources')}
          </Link>
        </>
      );
    }
    if (filters.feed || filters.capture) {
      return (
        <div>
          {t('content_studio_radar_no_match', 'No pages match these filters.')}
        </div>
      );
    }
    return (
      <>
        <div>
          {filters.since === '24h'
            ? t(
                'content_studio_radar_nothing_24h',
                'Nothing found in the last 24 hours.'
              )
            : filters.since === '7d'
            ? t(
                'content_studio_radar_nothing_7d',
                'Nothing found in the last 7 days.'
              )
            : filters.since === '30d'
            ? t(
                'content_studio_radar_nothing_30d',
                'Nothing found in the last 30 days.'
              )
            : t('content_studio_radar_nothing_yet', 'Nothing found yet.')}
        </div>
        {filters.since !== 'all' && (
          <Button secondary onClick={() => setFilters({ since: 'all' })}>
            {t('content_studio_radar_show_all', 'Show all time')}
          </Button>
        )}
        <div className="text-textItemBlur">
          {t(
            'content_studio_radar_automatic',
            'Feeds are captured automatically, every hour unless a feed is set to another interval.'
          )}
        </div>
        <Link href={SOURCE_LIBRARY_PATH} className={linkClass}>
          {t('content_studio_sources', 'Sources')}
        </Link>
      </>
    );
  };

  return (
    <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col gap-[16px] min-w-0">
      <div className="flex flex-wrap items-center gap-[12px]">
        <div className="flex flex-col gap-[4px] flex-1 min-w-[200px]">
          <h1 className="text-[20px] font-[600]">
            {t('content_studio_news_radar', 'News Radar')}
          </h1>
          <div className="text-textItemBlur">
            {t(
              'content_studio_radar_subtitle',
              'Recent pages discovered by your feeds.'
            )}
          </div>
          <div className="text-[13px] text-textItemBlur">
            {t(
              'content_studio_radar_note',
              'Found is when a feed first listed a page; Published is the date the feed gave it.'
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-[8px]">
          <Link href="/content-studio" className={linkClass}>
            {t('content_studio', 'Content Studio')}
          </Link>
          <Link href={SOURCE_LIBRARY_PATH} className={linkClass}>
            {t('content_studio_sources', 'Sources')}
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-[12px]">
        <div
          role="group"
          aria-label={t('content_studio_radar_window', 'Found in')}
          className="flex flex-wrap gap-[8px]"
        >
          {CONTENT_STUDIO_DISCOVERY_WINDOWS.map((since) => (
            <Button
              key={since}
              secondary={filters.since !== since}
              aria-pressed={filters.since === since}
              className={clsx(filters.since === since && 'font-[600]')}
              onClick={() => {
                if (filters.since !== since) {
                  setFilters({ since });
                }
              }}
            >
              {windowLabel(since)}
            </Button>
          ))}
        </div>
        <div
          role="group"
          aria-label={t('content_studio_radar_capture', 'Capture state')}
          className="flex flex-wrap gap-[8px]"
        >
          {[null, ...CONTENT_STUDIO_DISCOVERY_CAPTURE_STATES].map((capture) => (
            <Button
              key={capture ?? 'all'}
              secondary={filters.capture !== capture}
              aria-pressed={filters.capture === capture}
              className={clsx(filters.capture === capture && 'font-[600]')}
              onClick={() => {
                if (filters.capture !== capture) {
                  setFilters({ capture });
                }
              }}
            >
              {captureLabel(capture)}
            </Button>
          ))}
        </div>
        <label className="flex flex-col gap-[4px] text-[12px]">
          {t('content_studio_radar_feed', 'Feed')}
          <select
            className="bg-newBgColorInner h-[32px] px-[8px] border-newTableBorder border rounded-[8px] text-textColor text-[13px] max-w-[280px]"
            value={filters.feed ?? ''}
            onChange={(e) => setFilters({ feed: e.target.value || null })}
          >
            <option value="">
              {t('content_studio_radar_all_feeds', 'All feeds')}
            </option>
            {selectedName && filters.feed && (
              <option value={filters.feed}>{selectedName}</option>
            )}
            {feedOptions.map((feed) => (
              <option key={feed.id} value={feed.id}>
                {feed.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {radar.error ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-[12px] py-[40px]"
        >
          <div>
            {t(
              'content_studio_radar_load_error',
              'News Radar could not be loaded.'
            )}
          </div>
          <Button secondary onClick={() => radar.mutate()}>
            {t('content_studio_retry', 'Try again')}
          </Button>
        </div>
      ) : !radar.data ? (
        <LoadingComponent />
      ) : !radar.data.results.length ? (
        <div className="flex flex-col items-center gap-[12px] py-[40px] text-center">
          {empty()}
        </div>
      ) : (
        <>
          <div className="text-[13px] text-textItemBlur">
            {t('content_studio_feed_discoveries_total', 'Pages found')}:{' '}
            {radar.data.total}
          </div>
          <ul className="flex flex-col gap-[8px]">
            {radar.data.results.map((discovery) => (
              <ContentStudioDiscoveryRow
                key={discovery.id}
                discovery={discovery}
                provenance={
                  <Provenance
                    discovery={discovery}
                    filters={filters}
                    setFilters={setFilters}
                  />
                }
              />
            ))}
          </ul>
          {radar.data.pages > 1 && (
            <ContentStudioPager
              page={filters.page}
              pages={radar.data.pages}
              setPage={(page) => setFilters({ page })}
            />
          )}
        </>
      )}
    </div>
  );
};
