'use client';

import { FC, useEffect } from 'react';
import clsx from 'clsx';
import Link from 'next/link';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';
import { formatDate } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';
import { ContentStudioPage } from '@gitroom/frontend/components/content-studio/content-studio.shell';
import { contentStudioSourceHost } from '@gitroom/frontend/components/content-studio/content-studio.sources.api';
import {
  SOURCE_LIBRARY_PATH,
  sourcePagePath,
} from '@gitroom/frontend/components/content-studio/content-studio.sources';
import {
  ContentStudioPageChange,
  useContentStudioPageChangeFilters,
  useContentStudioSourceChanges,
} from '@gitroom/frontend/components/content-studio/content-studio.page-changes.api';
import {
  CONTENT_STUDIO_DISCOVERY_WINDOWS,
  ContentStudioDiscoveryWindow,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.types';

const linkClass =
  'px-[24px] h-[40px] flex items-center rounded-full bg-third border border-textColor/60 text-textColor';

// The change a source shows on its own page, opened from its exact version
export const pageChangePath = (change: ContentStudioPageChange) =>
  `${sourcePagePath(change.source.id)}?change=${encodeURIComponent(
    change.version.id
  )}`;

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

// One source's last page change: its current name (the organization's label,
// not the page title), what changed, when it was captured and when the
// capture before it was, as plain text
const PageChangeRow: FC<{ change: ContentStudioPageChange }> = ({ change }) => {
  const t = useT();
  return (
    <li className="flex flex-col gap-[4px] border border-newTableBorder rounded-[8px] p-[12px] min-w-0">
      <Link
        href={sourcePagePath(change.source.id)}
        className="font-[600] break-words hover:underline"
      >
        {change.source.name}
      </Link>
      <div className="text-[13px] text-textItemBlur truncate">
        {contentStudioSourceHost(change.source.canonicalUrl)}
      </div>
      <div className="text-[13px]">
        {change.change === 'title_changed'
          ? t('content_studio_changes_title_changed', 'Title changed')
          : t('content_studio_changes_content_changed', 'Content changed')}
      </div>
      <div className="text-[12px] text-textItemBlur flex flex-wrap items-center gap-x-[12px] gap-y-[2px]">
        <span>
          {t('content_studio_changes_changed', 'Changed')}{' '}
          {formatDate(change.changedAt)}
        </span>
        <span>
          {t(
            'content_studio_changes_previously_captured',
            'Previously captured'
          )}{' '}
          {formatDate(change.previousCaptureAt)}
        </span>
        {change.source.archivedAt && (
          <span className="px-[8px] rounded-full border border-newTableBorder text-[12px]">
            {t('content_studio_archived', 'Archived')}
          </span>
        )}
      </div>
      <div>
        <Link
          href={pageChangePath(change)}
          aria-label={`${t(
            'content_studio_source_what_changed_in',
            'What changed in'
          )} ${t('content_studio_revision', 'Version')} ${
            change.version.versionNumber
          }`}
          className="text-[13px] underline hover:no-underline"
        >
          {t('content_studio_source_what_changed', 'What changed')}
        </Link>
      </div>
    </li>
  );
};

// Changes: the organization's page sources by their last page change,
// newest first, one row per source (an archived one too). A change is a
// capture whose blocks or title differ from the capture before it with the
// same extraction; it is found when a page is captured again, never watched
// for. Read only: opening it fetches and captures nothing
export const ContentStudioPageChanges: FC = () => {
  const t = useT();
  const windowLabel = useWindowLabel();
  const { filters, setFilters } = useContentStudioPageChangeFilters();
  const changes = useContentStudioSourceChanges(filters);

  const pages = changes.data?.pages;
  // a page that no longer exists moves to the last one
  useEffect(() => {
    if (pages !== undefined && filters.page > Math.max(pages, 1)) {
      setFilters({ page: Math.max(pages, 1) });
    }
  }, [pages, filters.page, setFilters]);

  const empty = () => (
    <>
      <div>
        {filters.since === '24h'
          ? t(
              'content_studio_changes_nothing_24h',
              'No page changes in the last 24 hours.'
            )
          : filters.since === '7d'
          ? t(
              'content_studio_changes_nothing_7d',
              'No page changes in the last 7 days.'
            )
          : filters.since === '30d'
          ? t(
              'content_studio_changes_nothing_30d',
              'No page changes in the last 30 days.'
            )
          : t(
              'content_studio_changes_nothing_yet',
              'No page changes captured yet.'
            )}
      </div>
      {filters.since !== 'all' && (
        <Button secondary onClick={() => setFilters({ since: 'all' })}>
          {t('content_studio_radar_show_all', 'Show all time')}
        </Button>
      )}
      <Link href={SOURCE_LIBRARY_PATH} className={linkClass}>
        {t('content_studio_sources', 'Sources')}
      </Link>
    </>
  );

  return (
    <ContentStudioPage
      nav={false}
      title={t('content_studio_changes', 'Changes')}
      description={t(
        'content_studio_changes_subtitle',
        'Pages whose content or title changed between two captures.'
      )}
      help={t(
        'content_studio_changes_note',
        'A change is found when a page is captured again: by its feed or by Refresh.'
      )}
      actions={
        <Link href={SOURCE_LIBRARY_PATH} className={linkClass}>
          {t('content_studio_sources', 'Sources')}
        </Link>
      }
    >
      <div
        role="group"
        aria-label={t('content_studio_changes_window', 'Changed in')}
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

      {changes.error ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-[12px] py-[40px]"
        >
          <div>
            {t(
              'content_studio_changes_load_error',
              'Changes could not be loaded.'
            )}
          </div>
          <Button secondary onClick={() => changes.mutate()}>
            {t('content_studio_retry', 'Try again')}
          </Button>
        </div>
      ) : !changes.data ? (
        <LoadingComponent />
      ) : !changes.data.results.length ? (
        <div className="flex flex-col items-center gap-[12px] py-[40px] text-center">
          {empty()}
        </div>
      ) : (
        <>
          <div className="text-[13px] text-textItemBlur">
            {t('content_studio_changes_total', 'Pages changed')}:{' '}
            {changes.data.total}
          </div>
          <ul className="flex flex-col gap-[8px]">
            {changes.data.results.map((change) => (
              <PageChangeRow key={change.source.id} change={change} />
            ))}
          </ul>
          {changes.data.pages > 1 && (
            <ContentStudioPager
              page={filters.page}
              pages={changes.data.pages}
              setPage={(page) => setFilters({ page })}
            />
          )}
        </>
      )}
    </ContentStudioPage>
  );
};
