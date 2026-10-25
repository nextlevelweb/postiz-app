'use client';

import { FC, ReactNode, useEffect, useState } from 'react';
import clsx from 'clsx';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';
import { formatDate } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';
import { ContentStudioDiscoveryRow } from '@gitroom/frontend/components/content-studio/content-studio.discovery.row';
import { radarFeedPagePath } from '@gitroom/frontend/components/content-studio/content-studio.research.api';
import { ContentStudioUseInContent } from '@gitroom/frontend/components/content-studio/content-studio.package.modal';
import {
  ContentStudioSourceBlock,
  ContentStudioSourceDetail as SourceDetailData,
  ContentStudioSourceVersionSummary,
  sourceErrorCode,
  useContentStudioSource,
  useContentStudioSourceDiscoveries,
  useContentStudioSourceVersion,
  useContentStudioSourceVersionChanges,
  useContentStudioSourceVersions,
} from '@gitroom/frontend/components/content-studio/content-studio.sources.api';
import {
  CaptureButton,
  FeedIntervalSelect,
  FeedScheduleButton,
  formatSourceBytes,
  SOURCE_LIBRARY_PATH,
  SourceStatus,
  SourceTask,
  SourceUrl,
  useFeedIntervalLabel,
  useSourceCommands,
  useSourceKindLabel,
} from '@gitroom/frontend/components/content-studio/content-studio.sources';

// Version ids are Prisma uuid() values; a link naming anything else opens
// the history
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HEADING_SIZE: Record<number, string> = {
  1: 'text-[20px]',
  2: 'text-[18px]',
  3: 'text-[16px]',
};

// One captured block as plain React text: a `<script>` in it is just
// characters, and instructions in it are just text
const SourceBlockText: FC<{
  block: Omit<ContentStudioSourceBlock, 'id'>;
}> = ({ block }) => {
  switch (block.type) {
    case 'heading':
      return (
        <p
          className={clsx(
            'font-[600] break-words',
            HEADING_SIZE[block.level ?? 0] || 'text-[14px]'
          )}
        >
          {block.text}
        </p>
      );
    case 'list_item':
      return (
        <p
          className="flex gap-[8px] break-words"
          style={{ paddingLeft: `${(block.level ?? 0) * 20}px` }}
        >
          <span aria-hidden="true">•</span>
          <span className="min-w-0 whitespace-pre-wrap">{block.text}</span>
        </p>
      );
    case 'quote':
      return (
        <blockquote className="border-l-[3px] border-newTableBorder pl-[12px] italic whitespace-pre-wrap break-words">
          {block.text}
        </blockquote>
      );
    default:
      return <p className="whitespace-pre-wrap break-words">{block.text}</p>;
  }
};

// Captured text, read-only. Block ids are keys only
export const ContentStudioSourceBlocks: FC<{
  blocks: ContentStudioSourceBlock[];
}> = ({ blocks }) => {
  const t = useT();
  if (!blocks.length) {
    return (
      <div className="text-textItemBlur">
        {t(
          'content_studio_source_no_text',
          'No text was captured from this source.'
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-[8px] min-w-0">
      {blocks.map((block) => (
        <SourceBlockText key={block.id} block={block} />
      ))}
    </div>
  );
};

const Fact: FC<{ label: string; children: ReactNode; mono?: boolean }> = ({
  label,
  children,
  mono,
}) => (
  <div className="flex flex-col gap-[2px] min-w-0">
    <dt className="text-[12px] text-textItemBlur">{label}</dt>
    <dd className={clsx('break-all', mono && 'font-mono text-[12px]')}>
      {children}
    </dd>
  </div>
);

// What a capture is: when, what title and type, how big
const VersionFacts: FC<{ version: ContentStudioSourceVersionSummary }> = ({
  version,
}) => {
  const t = useT();
  const unknown = t('content_studio_source_unknown', 'Unknown');
  return (
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-[12px]">
      <Fact label={t('content_studio_revision', 'Version')}>
        {version.versionNumber}
      </Fact>
      <Fact label={t('content_studio_source_captured_at', 'Captured')}>
        {formatDate(version.fetchedAt)}
      </Fact>
      <Fact label={t('content_studio_source_title', 'Title')}>
        {version.title ??
          t('content_studio_source_no_title', 'No title captured')}
      </Fact>
      <Fact label={t('content_studio_source_content_type', 'Content type')}>
        {version.contentType ?? unknown}
      </Fact>
      <Fact label={t('content_studio_source_size', 'Size')}>
        {version.contentLength === null
          ? unknown
          : formatSourceBytes(version.contentLength)}
      </Fact>
    </dl>
  );
};

// Where and how the server fetched it. The hashes identify the captured bytes
// and the extracted text; they say nothing about whether either is true
const ProvenanceDetails: FC<{ version: ContentStudioSourceVersionSummary }> = ({
  version,
}) => {
  const t = useT();
  const notRecorded = t('content_studio_source_not_recorded', 'Not recorded');
  return (
    <details className="border border-newTableBorder rounded-[8px] p-[12px]">
      <summary className="cursor-pointer font-[600]">
        {t('content_studio_source_provenance', 'Provenance details')}
      </summary>
      <dl className="grid grid-cols-1 gap-[12px] mt-[12px]">
        <Fact label={t('content_studio_source_requested_url', 'Requested URL')}>
          {version.requestedUrl}
        </Fact>
        <Fact label={t('content_studio_source_final_url', 'Final URL')}>
          {version.finalUrl}
        </Fact>
        <Fact label={t('content_studio_source_redirects', 'Redirects')}>
          {version.redirectCount}
        </Fact>
        <Fact label={t('content_studio_source_http_status', 'HTTP status')}>
          {version.httpStatus ?? notRecorded}
        </Fact>
        <Fact
          label={t(
            'content_studio_source_extractor_version',
            'Extractor version'
          )}
        >
          {version.extractionVersion}
        </Fact>
        <Fact
          label={t('content_studio_source_content_schema', 'Content schema')}
        >
          {version.schemaVersion}
        </Fact>
        <Fact
          mono
          label={t(
            'content_studio_source_content_hash',
            'Extracted content hash'
          )}
        >
          {version.contentHash}
        </Fact>
        <Fact
          mono
          label={t('content_studio_source_source_hash', 'Captured source hash')}
        >
          {version.sourceHash ?? notRecorded}
        </Fact>
      </dl>
      <div className="text-[12px] text-textItemBlur mt-[12px]">
        {t(
          'content_studio_source_hash_hint',
          'These hashes identify the captured response and the extracted text. They do not show whether the content is true.'
        )}
      </div>
    </details>
  );
};

// One captured version with its text, loaded when it is opened. Nothing here
// changes, deletes or replaces a version
const SourceVersionView: FC<{
  sourceId: string;
  version: { id: string; versionNumber: number };
  onBack: () => void;
}> = ({ sourceId, version, onBack }) => {
  const t = useT();
  const detail = useContentStudioSourceVersion(sourceId, version.id);
  const code = sourceErrorCode(detail.error);

  return (
    <section className="flex flex-col gap-[16px] min-w-0">
      <div className="flex flex-wrap items-center gap-[8px]">
        <h2 className="flex-1 text-[16px] font-[600]">
          {t('content_studio_revision', 'Version')} {version.versionNumber}
        </h2>
        <Button secondary onClick={onBack}>
          {t('content_studio_back_to_history', 'Back to history')}
        </Button>
      </div>
      <div className="text-[13px] text-textItemBlur">
        {t(
          'content_studio_source_versions_read_only',
          'Captured versions are read-only.'
        )}
      </div>
      {detail.error ? (
        <div role="alert">
          {code === 'CS_SOURCE_INTEGRITY_ERROR'
            ? t(
                'content_studio_source_error_integrity',
                'Stored source data could not be read safely.'
              )
            : code === 'CS_NOT_FOUND'
            ? t(
                'content_studio_source_version_missing',
                'This source version is no longer available.'
              )
            : t(
                'content_studio_source_version_load_error',
                'Source version could not be loaded.'
              )}
        </div>
      ) : !detail.data ? (
        <LoadingComponent width={40} height={40} />
      ) : (
        <>
          <VersionFacts version={detail.data} />
          <ProvenanceDetails version={detail.data} />
          <h3 className="font-[600]">
            {t('content_studio_source_extracted_content', 'Extracted content')}
          </h3>
          <ContentStudioSourceBlocks blocks={detail.data.content.blocks} />
        </>
      )}
    </section>
  );
};

// What changed in one version, exactly as the server compared it, with the
// earlier capture the server chose. Nothing is worked out here; kept blocks
// are a count only. A version opened from a link (P8-04B1) has its number
// once the server answers
const SourceChangeView: FC<{
  sourceId: string;
  version: { id: string; versionNumber: number | null };
  onBack: () => void;
}> = ({ sourceId, version, onBack }) => {
  const t = useT();
  const changes = useContentStudioSourceVersionChanges(sourceId, version.id);
  const code = sourceErrorCode(changes.error);
  const noTitle = t('content_studio_source_no_title', 'No title captured');
  const data = changes.data;

  return (
    <section className="flex flex-col gap-[16px] min-w-0">
      <div className="flex flex-wrap items-center gap-[8px]">
        <h2 className="flex-1 text-[16px] font-[600]">
          {data?.before
            ? `${t('content_studio_revision', 'Version')} ${
                data.after.versionNumber
              } ${t(
                'content_studio_source_compared_with',
                'compared with'
              )} ${t('content_studio_revision', 'Version')} ${
                data.before.versionNumber
              }`
            : data || version.versionNumber !== null
            ? `${t('content_studio_revision', 'Version')} ${
                data ? data.after.versionNumber : version.versionNumber
              }`
            : t('content_studio_source_what_changed', 'What changed')}
        </h2>
        <Button secondary onClick={onBack}>
          {t('content_studio_back_to_history', 'Back to history')}
        </Button>
      </div>
      {changes.error ? (
        <div role="alert">
          {code === 'CS_SOURCE_INTEGRITY_ERROR'
            ? t(
                'content_studio_source_error_integrity',
                'Stored source data could not be read safely.'
              )
            : code === 'CS_NOT_FOUND'
            ? t(
                'content_studio_source_version_missing',
                'This source version is no longer available.'
              )
            : t(
                'content_studio_source_changes_load_error',
                'Changes could not be loaded.'
              )}
        </div>
      ) : !data ? (
        <LoadingComponent width={40} height={40} />
      ) : (
        <>
          <div className="text-[12px] text-textItemBlur flex flex-wrap gap-x-[12px]">
            <span>
              {t('content_studio_revision', 'Version')}{' '}
              {data.after.versionNumber}: {formatDate(data.after.fetchedAt)}
            </span>
            {!!data.before && (
              <span>
                {t('content_studio_revision', 'Version')}{' '}
                {data.before.versionNumber}: {formatDate(data.before.fetchedAt)}
              </span>
            )}
          </div>
          {!!data.repeatOf && (
            <p>
              {t(
                'content_studio_source_repeat_of',
                'Same content, title and extraction as Version'
              )}{' '}
              {data.repeatOf.versionNumber} (
              {formatDate(data.repeatOf.fetchedAt)}).
            </p>
          )}
          {data.change === 'no_earlier_change' ? (
            <p className="text-textItemBlur">
              {t(
                'content_studio_source_no_earlier_change',
                'No earlier different capture to compare with.'
              )}
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-[4px]">
                <p className="font-[600]">
                  {data.change === 'content_changed'
                    ? t(
                        'content_studio_source_content_changed',
                        'Content changed'
                      )
                    : data.change === 'title_changed'
                    ? t(
                        'content_studio_source_title_changed',
                        'Only the title changed'
                      )
                    : `${t(
                        'content_studio_source_extraction_changed',
                        'Captured with a different extraction version'
                      )}: ${data.before?.extractionVersion} → ${
                        data.after.extractionVersion
                      }.`}
                </p>
                {data.change === 'extraction_changed' && (
                  <p>
                    {t(
                      'content_studio_source_extraction_hint',
                      'Differences may come from the extractor, not the page.'
                    )}
                    {data.sameFetchedBytes &&
                      ` ${t(
                        'content_studio_source_same_fetched_bytes',
                        'The fetched page bytes were identical, so the visible differences come from extraction.'
                      )}`}
                  </p>
                )}
                {data.titleChanged && (
                  <p className="break-words">
                    {t('content_studio_source_title', 'Title')}:{' '}
                    {data.before?.title ?? noTitle} →{' '}
                    {data.after.title ?? noTitle}
                  </p>
                )}
              </div>
              <p className="text-[13px] text-textItemBlur">
                +{data.counts.added}{' '}
                {t('content_studio_source_blocks_added', 'blocks added')} · −
                {data.counts.removed}{' '}
                {t('content_studio_source_blocks_removed', 'removed')} ·{' '}
                {data.counts.unchanged}{' '}
                {t('content_studio_source_blocks_unchanged', 'unchanged')}
              </p>
              <ol className="flex flex-col gap-[8px] min-w-0">
                {data.blocks.map((block, index) =>
                  block.change === 'unchanged' ? (
                    <li
                      key={index}
                      className="text-[12px] text-textItemBlur border border-dashed border-newTableBorder rounded-[8px] px-[12px] py-[6px]"
                    >
                      {block.count}{' '}
                      {t(
                        'content_studio_source_unchanged_blocks',
                        'unchanged blocks'
                      )}
                    </li>
                  ) : (
                    <li
                      key={index}
                      className={clsx(
                        'flex flex-col gap-[4px] border-l-[3px] pl-[12px] min-w-0',
                        block.change === 'added'
                          ? 'border-textColor/60 bg-boxFocused'
                          : 'border-newTableBorder text-textItemBlur'
                      )}
                    >
                      <span className="text-[12px] font-[600]">
                        {block.change === 'added'
                          ? t('content_studio_source_block_added', 'Added')
                          : t('content_studio_source_block_removed', 'Removed')}
                      </span>
                      <div
                        className={clsx(
                          block.change === 'removed' && 'line-through'
                        )}
                      >
                        <SourceBlockText block={block} />
                      </div>
                    </li>
                  )
                )}
              </ol>
            </>
          )}
        </>
      )}
    </section>
  );
};

// The captures of a source, newest first, one server page at a time.
// Metadata only: the text is loaded for the version opened
const SourceHistory: FC<{
  history: ReturnType<typeof useContentStudioSourceVersions>;
  page: number;
  setPage: (page: number) => void;
  onView: (version: ContentStudioSourceVersionSummary) => void;
  onCompare: (version: ContentStudioSourceVersionSummary) => void;
}> = ({ history, page, setPage, onView, onCompare }) => {
  const t = useT();
  if (history.error) {
    return (
      <div role="alert">
        {t(
          'content_studio_source_history_load_error',
          'Version history could not be loaded.'
        )}
      </div>
    );
  }
  if (!history.data) {
    return <LoadingComponent width={40} height={40} />;
  }
  if (!history.data.results.length) {
    return (
      <div className="text-textItemBlur">
        {t('content_studio_source_no_versions', 'No captured versions yet.')}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-[12px]">
      <ul className="flex flex-col gap-[8px]">
        {history.data.results.map((version) => (
          <li
            key={version.id}
            className="flex flex-wrap items-center gap-[8px] border border-newTableBorder rounded-[8px] p-[12px]"
          >
            <div className="flex flex-col gap-[2px] flex-1 min-w-[200px]">
              <div className="font-[600]">
                {t('content_studio_revision', 'Version')}{' '}
                {version.versionNumber}
              </div>
              <div className="break-words">
                {version.title ??
                  t('content_studio_source_no_title', 'No title captured')}
              </div>
              <div className="text-[12px] text-textItemBlur flex flex-wrap gap-x-[12px]">
                <span>{formatDate(version.fetchedAt)}</span>
                {!!version.contentType && <span>{version.contentType}</span>}
                {version.contentLength !== null && (
                  <span>{formatSourceBytes(version.contentLength)}</span>
                )}
                {version.redirectCount > 0 && (
                  <span>
                    {t('content_studio_source_redirects', 'Redirects')}:{' '}
                    {version.redirectCount}
                  </span>
                )}
              </div>
            </div>
            <Button
              secondary
              aria-label={`${t('content_studio_view_source', 'View')} ${t(
                'content_studio_revision',
                'Version'
              )} ${version.versionNumber}`}
              onClick={() => onView(version)}
            >
              {t('content_studio_view_source', 'View')}
            </Button>
            {version.versionNumber >= 2 && (
              <Button
                secondary
                aria-label={`${t(
                  'content_studio_source_what_changed_in',
                  'What changed in'
                )} ${t('content_studio_revision', 'Version')} ${
                  version.versionNumber
                }`}
                onClick={() => onCompare(version)}
              >
                {t('content_studio_source_what_changed', 'What changed')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {history.data.pages > 1 && (
        <ContentStudioPager
          page={page}
          pages={history.data.pages}
          setPage={setPage}
        />
      )}
    </div>
  );
};

// The pages a feed found, newest first sighting first (a capture's pages by
// their feed date), one server page at a time, in the row News Radar uses.
// The entry's title and date are what the feed said, shown as plain text;
// each page opens as its own source, with its own captures
const FeedDiscoveries: FC<{ feed: SourceDetailData }> = ({ feed }) => {
  const t = useT();
  const [page, setPage] = useState(1);
  const list = useContentStudioSourceDiscoveries(feed.id, page, true);
  if (list.error) {
    return (
      <div role="alert" className="flex flex-col items-start gap-[8px]">
        <div>
          {t(
            'content_studio_feed_discoveries_load_error',
            'The pages of this feed could not be loaded.'
          )}
        </div>
        <Button secondary onClick={() => list.mutate()}>
          {t('content_studio_retry', 'Try again')}
        </Button>
      </div>
    );
  }
  if (!list.data) {
    return <LoadingComponent width={40} height={40} />;
  }
  if (!list.data.results.length) {
    return (
      <div className="text-textItemBlur">
        {feed.lastCapturedAt
          ? t(
              'content_studio_feed_no_discoveries',
              'The last capture found no pages with an HTTPS link.'
            )
          : t(
              'content_studio_feed_no_discoveries_yet',
              'No pages yet. Capture the feed to find its pages.'
            )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-[12px]">
      <div className="text-[13px] text-textItemBlur">
        {t('content_studio_feed_discoveries_total', 'Pages found')}:{' '}
        {list.data.total}
      </div>
      <ul className="flex flex-col gap-[8px]">
        {list.data.results.map((discovery) => (
          <ContentStudioDiscoveryRow
            key={discovery.id}
            discovery={discovery}
            lastSeen
          />
        ))}
      </ul>
      {list.data.pages > 1 && (
        <ContentStudioPager
          page={page}
          pages={list.data.pages}
          setPage={setPage}
        />
      )}
    </div>
  );
};

// When a running feed is captured next (P8-C4): never an exact time, since
// the scan looks every 10 minutes and captures may wait in their queue.
// After failed scheduled captures, that it failed and when it is tried
// again, never the error or how often it failed
const feedScheduleMessage = (
  t: (key: string, fallback: string) => string,
  feed: SourceDetailData
) => {
  const due =
    !feed.nextCaptureAt || new Date(feed.nextCaptureAt).getTime() <= Date.now();
  if (feed.consecutiveCaptureFailures > 0) {
    return [
      t('content_studio_feed_capture_failed', 'Capture failed.'),
      due
        ? t(
            'content_studio_feed_next_try_soon',
            'Next try within a few minutes.'
          )
        : `${t(
            'content_studio_feed_next_try_after',
            'Next try after'
          )} ${formatDate(feed.nextCaptureAt!)}.`,
      t('content_studio_feed_refresh_to_try', 'Refresh the feed to try now.'),
    ].join(' ');
  }
  return due
    ? t(
        'content_studio_feed_next_capture_soon',
        'Next capture within a few minutes.'
      )
    : `${t(
        'content_studio_feed_next_capture_after',
        'Next capture after'
      )} ${formatDate(feed.nextCaptureAt!)}.`;
};

// A feed's own state: when it was last read, how often it is read again on
// its schedule (P8-C4) while it is active and not paused (P8-C3), and when
// next. It has no versions of its own
const FeedCapture: FC<{
  feed: SourceDetailData;
  busy?: SourceTask;
  commands: ReturnType<typeof useSourceCommands>;
}> = ({ feed, busy, commands }) => {
  const t = useT();
  const intervalLabel = useFeedIntervalLabel();
  return (
    <section className="flex flex-col gap-[12px] min-w-0">
      <h2 className="text-[16px] font-[600]">
        {t('content_studio_feed_capture_heading', 'Feed capture')}
      </h2>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-[12px]">
        <Fact label={t('content_studio_feed_last_captured', 'Last captured')}>
          {feed.lastCapturedAt
            ? formatDate(feed.lastCapturedAt)
            : t('content_studio_source_not_captured', 'Not captured yet')}
        </Fact>
        <Fact
          label={t(
            'content_studio_feed_automatic_capture',
            'Automatic capture'
          )}
        >
          {feed.archivedAt
            ? t('content_studio_feed_automatic_paused', 'Paused while archived')
            : feed.scanPausedAt
            ? t('content_studio_feed_paused_status', 'Paused')
            : intervalLabel(feed.captureIntervalMinutes)}
        </Fact>
      </dl>
      <FeedIntervalSelect source={feed} busy={busy} commands={commands} />
      {!feed.archivedAt && !feed.scanPausedAt && (
        <div className="text-[13px] text-textItemBlur">
          {feedScheduleMessage(t, feed)}
        </div>
      )}
      {!feed.archivedAt && feed.scanPausedAt && (
        <div className="text-[13px] text-textItemBlur">
          {t(
            'content_studio_feed_paused_note',
            'Automatic scans are paused. You can still refresh this feed manually.'
          )}
        </div>
      )}
      <div className="text-[13px] text-textItemBlur">
        {t(
          'content_studio_feed_note',
          'A capture reads the first 25 entries of the feed, in the order the feed lists them. Each page they link to is kept as a web page source with its own versions; a page that has not changed gets no new version.'
        )}
      </div>
      {/* News Radar shows live feeds only */}
      {!feed.archivedAt && (
        <Link
          href={radarFeedPagePath(feed.id)}
          className="self-start text-[14px] underline hover:no-underline"
        >
          {t('content_studio_radar_show_feed', 'Show in News Radar')}
        </Link>
      )}
    </section>
  );
};

// One source: what it is, its current capture and its history. An archived
// source stays fully readable. Opening it fetches nothing from the source
// itself, and loads no captured text until a version is opened
export const ContentStudioSourceDetail: FC<{ sourceId: string }> = ({
  sourceId,
}) => {
  const t = useT();
  const kindLabel = useSourceKindLabel();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // a link to one change (P8-04B1, from Changes): ?change=<version id>. The
  // server decides whether it is a version of this source
  const change = searchParams.get('change');
  const linked = change && UUID.test(change) ? change : null;
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<{
    id: string;
    versionNumber: number;
  } | null>(null);
  // the version whose changes are open, instead of the history
  const [comparing, setComparing] = useState<{
    id: string;
    versionNumber: number | null;
  } | null>(linked ? { id: linked, versionNumber: null } : null);
  useEffect(() => {
    if (linked) {
      setViewing(null);
      setComparing((open) =>
        open?.id === linked ? open : { id: linked, versionNumber: null }
      );
    }
  }, [linked]);
  // leaving a linked change drops it from the address, and nothing else
  const unlink = () => {
    if (searchParams.has('change')) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete('change');
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    }
  };
  const view = (version: { id: string; versionNumber: number } | null) => {
    unlink();
    setComparing(null);
    setViewing(version);
  };
  const compare = (version: { id: string; versionNumber: number }) => {
    unlink();
    setViewing(null);
    setComparing(version);
  };
  const detail = useContentStudioSource(sourceId);
  const history = useContentStudioSourceVersions(sourceId, page);
  // a new capture is the newest version: show the first page
  const commands = useSourceCommands(() => setPage(1));

  if (detail.error) {
    const missing = sourceErrorCode(detail.error) === 'CS_NOT_FOUND';
    return (
      <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col items-center gap-[12px] py-[40px] min-w-0">
        <div>
          {missing
            ? t('content_studio_source_not_found', 'Source not found.')
            : t(
                'content_studio_source_load_error',
                'Source could not be loaded.'
              )}
        </div>
        {!missing && (
          <Button secondary onClick={() => detail.mutate()}>
            {t('content_studio_retry', 'Try again')}
          </Button>
        )}
        <Link href={SOURCE_LIBRARY_PATH} className="underline">
          {t('content_studio_back_to_sources', 'Back to sources')}
        </Link>
      </div>
    );
  }
  if (!detail.data) {
    return <LoadingComponent />;
  }

  const source = detail.data;
  const archived = !!source.archivedAt;
  const busy = commands.busy[source.id];

  return (
    <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col gap-[20px] min-w-0">
      <div className="flex flex-wrap items-start gap-[12px]">
        <div className="flex flex-col gap-[6px] flex-1 min-w-[200px]">
          <Link
            href={SOURCE_LIBRARY_PATH}
            className="text-[13px] text-textItemBlur hover:underline"
          >
            {t('content_studio_sources', 'Sources')}
          </Link>
          <h1 className="text-[20px] font-[600] break-words">{source.name}</h1>
          <SourceUrl url={source.canonicalUrl} className="text-[14px]" />
          <div className="flex flex-wrap gap-x-[16px] gap-y-[4px] text-[12px] text-textItemBlur">
            <span className="px-[8px] rounded-full border border-newTableBorder">
              {archived
                ? t('content_studio_archived', 'Archived')
                : source.kind === 'feed' && source.scanPausedAt
                ? t('content_studio_feed_paused_status', 'Paused')
                : t('content_studio_active', 'Active')}
            </span>
            <span>{kindLabel(source.kind)}</span>
            <SourceStatus source={source} />
            <span>
              {t('content_studio_created', 'Created')}:{' '}
              {formatDate(source.createdAt)}
            </span>
            <span>
              {t('content_studio_updated', 'Updated')}:{' '}
              {formatDate(source.updatedAt)}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-[8px]">
          {archived ? (
            <Button
              secondary
              loading={busy === 'restore'}
              disabled={!!busy}
              aria-label={`${t('content_studio_restore', 'Restore')} ${
                source.name
              }`}
              onClick={() => commands.restore(source)}
            >
              {t('content_studio_restore', 'Restore')}
            </Button>
          ) : (
            <>
              <ContentStudioUseInContent source={source} />
              <CaptureButton
                source={source}
                busy={busy}
                onClick={() => commands.capture(source)}
              />
              <FeedScheduleButton
                source={source}
                busy={busy}
                commands={commands}
              />
              <Button
                secondary
                disabled={!!busy}
                aria-label={`${t('content_studio_rename', 'Rename')} ${
                  source.name
                }`}
                onClick={() => commands.rename(source)}
              >
                {t('content_studio_rename', 'Rename')}
              </Button>
              <Button
                secondary
                loading={busy === 'archive'}
                disabled={!!busy}
                aria-label={`${t('content_studio_archive', 'Archive')} ${
                  source.name
                }`}
                onClick={() => commands.archive(source)}
              >
                {t('content_studio_archive', 'Archive')}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="text-[13px] text-textItemBlur">
        {t(
          'content_studio_source_provenance_note',
          'This records what was captured and when. It does not independently verify whether the source is factually correct.'
        )}
      </div>

      {source.kind === 'feed' ? (
        <>
          <FeedCapture feed={source} busy={busy} commands={commands} />
          <section className="flex flex-col gap-[12px] min-w-0">
            <h2 className="text-[16px] font-[600]">
              {t('content_studio_feed_discoveries', 'Pages found in this feed')}
            </h2>
            <FeedDiscoveries feed={source} />
          </section>
        </>
      ) : (
        <>
          <section className="flex flex-col gap-[12px] min-w-0">
            <h2 className="text-[16px] font-[600]">
              {t('content_studio_source_current_capture', 'Current capture')}
            </h2>
            {source.currentVersion ? (
              <>
                <VersionFacts version={source.currentVersion} />
                <ProvenanceDetails version={source.currentVersion} />
                <div className="flex flex-wrap gap-[8px]">
                  <Button secondary onClick={() => view(source.currentVersion)}>
                    {t(
                      'content_studio_source_view_content',
                      'View extracted content'
                    )}
                  </Button>
                  {source.latestVersionNumber >= 2 && (
                    <Button
                      secondary
                      onClick={() =>
                        source.currentVersion && compare(source.currentVersion)
                      }
                    >
                      {t('content_studio_source_what_changed', 'What changed')}
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <div className="text-textItemBlur">
                {t('content_studio_source_not_captured', 'Not captured yet')}
              </div>
            )}
          </section>

          {comparing ? (
            <SourceChangeView
              key={comparing.id}
              sourceId={source.id}
              version={comparing}
              onBack={() => {
                unlink();
                setComparing(null);
              }}
            />
          ) : viewing ? (
            <SourceVersionView
              key={viewing.id}
              sourceId={source.id}
              version={viewing}
              onBack={() => setViewing(null)}
            />
          ) : (
            <section className="flex flex-col gap-[12px] min-w-0">
              <h2 className="text-[16px] font-[600]">
                {t('content_studio_source_history', 'Version history')}
              </h2>
              <SourceHistory
                history={history}
                page={page}
                setPage={setPage}
                onView={view}
                onCompare={compare}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
};
