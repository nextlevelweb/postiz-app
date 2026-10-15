'use client';

import { FC, ReactNode, useState } from 'react';
import clsx from 'clsx';
import Link from 'next/link';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';
import { formatDate } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';
import {
  ContentStudioSourceBlock,
  ContentStudioSourceVersionSummary,
  sourceErrorCode,
  useContentStudioSource,
  useContentStudioSourceVersion,
  useContentStudioSourceVersions,
} from '@gitroom/frontend/components/content-studio/content-studio.sources.api';
import {
  CaptureButton,
  formatSourceBytes,
  SOURCE_LIBRARY_PATH,
  SourceStatus,
  SourceUrl,
  useSourceCommands,
  useSourceKindLabel,
} from '@gitroom/frontend/components/content-studio/content-studio.sources';

const HEADING_SIZE: Record<number, string> = {
  1: 'text-[20px]',
  2: 'text-[18px]',
  3: 'text-[16px]',
};

// Captured text, read-only, as plain React text: a `<script>` in it is just
// characters, and instructions in it are just text. Block ids are keys only
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
      {blocks.map((block) => {
        switch (block.type) {
          case 'heading':
            return (
              <p
                key={block.id}
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
                key={block.id}
                className="flex gap-[8px] break-words"
                style={{ paddingLeft: `${(block.level ?? 0) * 20}px` }}
              >
                <span aria-hidden="true">•</span>
                <span className="min-w-0 whitespace-pre-wrap">
                  {block.text}
                </span>
              </p>
            );
          case 'quote':
            return (
              <blockquote
                key={block.id}
                className="border-l-[3px] border-newTableBorder pl-[12px] italic whitespace-pre-wrap break-words"
              >
                {block.text}
              </blockquote>
            );
          default:
            return (
              <p key={block.id} className="whitespace-pre-wrap break-words">
                {block.text}
              </p>
            );
        }
      })}
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

// The captures of a source, newest first, one server page at a time.
// Metadata only: the text is loaded for the version opened
const SourceHistory: FC<{
  history: ReturnType<typeof useContentStudioSourceVersions>;
  page: number;
  setPage: (page: number) => void;
  onView: (version: ContentStudioSourceVersionSummary) => void;
}> = ({ history, page, setPage, onView }) => {
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

// One source: what it is, its current capture and its history. An archived
// source stays fully readable. Opening it fetches nothing from the source
// itself, and loads no captured text until a version is opened
export const ContentStudioSourceDetail: FC<{ sourceId: string }> = ({
  sourceId,
}) => {
  const t = useT();
  const kindLabel = useSourceKindLabel();
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<{
    id: string;
    versionNumber: number;
  } | null>(null);
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
              <CaptureButton
                source={source}
                busy={busy}
                onClick={() => commands.capture(source)}
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

      <section className="flex flex-col gap-[12px] min-w-0">
        <h2 className="text-[16px] font-[600]">
          {t('content_studio_source_current_capture', 'Current capture')}
        </h2>
        {source.currentVersion ? (
          <>
            <VersionFacts version={source.currentVersion} />
            <ProvenanceDetails version={source.currentVersion} />
            <div>
              <Button
                secondary
                onClick={() => setViewing(source.currentVersion)}
              >
                {t(
                  'content_studio_source_view_content',
                  'View extracted content'
                )}
              </Button>
            </div>
          </>
        ) : (
          <div className="text-textItemBlur">
            {t('content_studio_source_not_captured', 'Not captured yet')}
          </div>
        )}
      </section>

      {viewing ? (
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
            onView={setViewing}
          />
        </section>
      )}
    </div>
  );
};
