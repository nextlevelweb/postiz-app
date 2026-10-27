'use client';

import { FC, FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import Link from 'next/link';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { ContentStudioPage } from '@gitroom/frontend/components/content-studio/content-studio.shell';
import { useContentStudioDialogGuard } from '@gitroom/frontend/components/content-studio/content-studio.dialog';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';
import { useSingleFlight } from '@gitroom/frontend/components/content-studio/content-studio.projects.modal';
import { formatDate } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';
import { CONTENT_STUDIO_FEED_INTERVALS } from '@gitroom/nestjs-libraries/content-studio/sources/source.types';
import {
  ContentStudioFeedCaptureCounts,
  ContentStudioSourceKind,
  ContentStudioSourceSummary,
  SOURCE_NAME_MAX,
  SOURCE_SEARCH_MAX,
  sourceErrorCode,
  sourceErrorMessage,
  useContentStudioSourceActions,
  useContentStudioSources,
} from '@gitroom/frontend/components/content-studio/content-studio.sources.api';

export const SOURCE_LIBRARY_PATH = '/content-studio/sources';
export const sourcePagePath = (id: string) =>
  `${SOURCE_LIBRARY_PATH}/${encodeURIComponent(id)}`;

const WEB_URL = /^https?:\/\/\S+$/i;

// A size as received, e.g. 842 B, 24.3 KB, 1.8 MB (1 KB is 1024 bytes)
export const formatSourceBytes = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const useSourceKindLabel = () => {
  const t = useT();
  return (kind: string) =>
    kind === 'url'
      ? t('content_studio_source_kind_url', 'Web page')
      : kind === 'feed'
      ? t('content_studio_source_kind_feed', 'Feed')
      : kind;
};

// A feed's interval (P8-C4) in words. The default and an explicit hourly
// read alike today, but only the default follows a later change of it
export const useFeedIntervalLabel = () => {
  const t = useT();
  return (minutes: number | null) => {
    switch (minutes) {
      case null:
        return t(
          'content_studio_feed_interval_default',
          'Every hour (default)'
        );
      case 60:
        return t('content_studio_feed_interval_60', 'Every hour');
      case 180:
        return t('content_studio_feed_interval_180', 'Every 3 hours');
      case 360:
        return t('content_studio_feed_interval_360', 'Every 6 hours');
      case 720:
        return t('content_studio_feed_interval_720', 'Every 12 hours');
      case 1440:
        return t('content_studio_feed_interval_1440', 'Daily');
      default:
        return String(minutes);
    }
  };
};

// What a feed capture did, in fixed words and counts only: never a page
// title or address
export const feedCaptureMessage = (
  t: (key: string, fallback: string) => string,
  capture: ContentStudioFeedCaptureCounts
) =>
  [
    t('content_studio_feed_captured', 'Feed captured.'),
    `${t('content_studio_feed_captured_pages', 'Pages found')}: ${
      capture.entriesAccepted
    }.`,
    `${t('content_studio_feed_captured_new', 'New sources')}: ${
      capture.sourcesCreated
    }.`,
    `${t('content_studio_feed_captured_versions', 'New versions')}: ${
      capture.versionsCreated
    }.`,
    ...(capture.failed
      ? [
          `${t(
            'content_studio_feed_captured_failed',
            'Pages not captured this time'
          )}: ${capture.failed}.`,
        ]
      : []),
    ...(capture.entriesLimited
      ? [
          `${t(
            'content_studio_feed_captured_limited',
            'Pages not added because the organization reached its source limit'
          )}: ${capture.entriesLimited}.`,
        ]
      : []),
  ].join(' ');

// The stored URL, as a plain outgoing link: showing it fetches nothing
export const SourceUrl: FC<{ url: string | null; className?: string }> = ({
  url,
  className,
}) => {
  if (!url) {
    return null;
  }
  return WEB_URL.test(url) ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      className={clsx('block min-w-0 truncate hover:underline', className)}
    >
      {url}
    </a>
  ) : (
    <span title={url} className={clsx('block min-w-0 truncate', className)}>
      {url}
    </span>
  );
};

// A new source: its type, name and address only. It is not captured here;
// that is a separate, explicit action. A feed is an RSS or Atom address: its
// captures find pages, each one kept as a page source of its own
const AddSourceForm: FC<{ close: () => void }> = ({ close }) => {
  const t = useT();
  const toaster = useToaster();
  const { createSource } = useContentStudioSourceActions();
  const [kind, setKind] = useState<ContentStudioSourceKind>('url');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [urlInvalid, setUrlInvalid] = useState(false);
  const { busy, run } = useSingleFlight();
  const address = url.trim();
  // a typed name or address is not dropped by a click outside or Escape
  const release = useContentStudioDialogGuard(!!name.trim() || !!address);

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!name.trim() || !address) {
        return;
      }
      // the syntax only: whether the address may be fetched is the server's
      // decision, when it is captured
      if (!WEB_URL.test(address)) {
        setUrlInvalid(true);
        return;
      }
      await run('create', async () => {
        try {
          await createSource(kind, name.trim(), address);
          toaster.show(
            t('content_studio_source_added', 'Source added.'),
            'success'
          );
          release();
          close();
        } catch (err) {
          // the input stays as typed, to correct and try again
          toaster.show(sourceErrorMessage(t, err), 'warning');
        }
      });
    },
    [kind, name, address, run, createSource, toaster, close, t, release]
  );

  const kinds: Array<[ContentStudioSourceKind, string, string]> = [
    [
      'url',
      t('content_studio_source_kind_url', 'Web page'),
      t(
        'content_studio_source_kind_url_hint',
        'One page, captured as versions when you capture it.'
      ),
    ],
    [
      'feed',
      t('content_studio_source_kind_feed_option', 'Feed (RSS or Atom)'),
      t(
        'content_studio_source_kind_feed_hint',
        'A news or blog feed. Each capture adds the pages it lists as web page sources.'
      ),
    ],
  ];

  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <fieldset className="flex flex-col gap-[8px] min-w-0">
        <legend className="text-[14px] mb-[6px]">
          {t('content_studio_source_type', 'Source type')}
        </legend>
        {kinds.map(([value, label, hint]) => (
          <label
            key={value}
            className="flex items-start gap-[8px] cursor-pointer border border-newTableBorder rounded-[8px] px-[10px] py-[8px]"
          >
            <input
              type="radio"
              name="source-kind"
              value={value}
              checked={kind === value}
              onChange={() => setKind(value)}
            />
            <span className="flex flex-col gap-[4px] min-w-0">
              <span className="font-[600] break-words">{label}</span>
              <span className="text-[12px] text-textItemBlur break-words">
                {hint}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <Input
        label="Name"
        translationKey="content_studio_source_name"
        name="name"
        aria-label={t('content_studio_source_name', 'Name')}
        disableForm={true}
        removeError={true}
        value={name}
        maxLength={SOURCE_NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <div className="flex flex-col gap-[6px]">
        <Input
          label="URL"
          translationKey="content_studio_source_url"
          name="url"
          aria-label={t('content_studio_source_url', 'URL')}
          disableForm={true}
          removeError={true}
          inputMode="url"
          value={url}
          placeholder="https://"
          onChange={(e) => {
            setUrl(e.target.value);
            setUrlInvalid(false);
          }}
        />
        {urlInvalid && (
          <div role="alert" className="text-red-400 text-[12px]">
            {t(
              'content_studio_source_url_syntax',
              'Enter a URL that starts with http:// or https://.'
            )}
          </div>
        )}
        {/^http:\/\//i.test(address) && (
          <div className="text-[12px] text-textItemBlur">
            {t(
              'content_studio_source_http_warning',
              'This source can be saved, but the current capture policy only fetches HTTPS URLs.'
            )}
          </div>
        )}
      </div>
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button
          type="submit"
          loading={!!busy}
          disabled={!!busy || !name.trim() || !address}
        >
          {t('content_studio_add_source', 'Add source')}
        </Button>
      </div>
    </form>
  );
};

// The name only: the URL is the source's identity and never changes
const RenameSourceForm: FC<{
  source: ContentStudioSourceSummary;
  close: () => void;
}> = ({ source, close }) => {
  const t = useT();
  const toaster = useToaster();
  const { renameSource } = useContentStudioSourceActions();
  const [name, setName] = useState(source.name);
  const { busy, run } = useSingleFlight();

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!name.trim() || name.trim() === source.name) {
        return;
      }
      await run('rename', async () => {
        try {
          await renameSource(source.id, name.trim());
          toaster.show(
            t('content_studio_source_renamed', 'Source renamed.'),
            'success'
          );
          close();
        } catch (err) {
          toaster.show(sourceErrorMessage(t, err), 'warning');
        }
      });
    },
    [name, source, run, renameSource, toaster, close, t]
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <Input
        label="Name"
        translationKey="content_studio_source_name"
        name="name"
        aria-label={t('content_studio_source_name', 'Name')}
        disableForm={true}
        removeError={true}
        value={name}
        maxLength={SOURCE_NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button
          type="submit"
          loading={!!busy}
          disabled={!!busy || !name.trim() || name.trim() === source.name}
        >
          {t('save', 'Save')}
        </Button>
      </div>
    </form>
  );
};

export type SourceTask =
  | 'capture'
  | 'archive'
  | 'restore'
  | 'pause'
  | 'resume'
  | 'interval';

// The source actions of the library and of one source. One action at a time
// per source, so a double click sends one request; other sources stay usable.
// A capture is only ever started here, by the user, and never repeated
// automatically: after a conflict the source reloads and the user decides
export const useSourceCommands = (onCaptured?: () => void) => {
  const t = useT();
  const toaster = useToaster();
  const modals = useModals();
  const actions = useContentStudioSourceActions();
  const running = useRef(new Set<string>());
  const [busy, setBusy] = useState<Record<string, SourceTask>>({});

  const run = useCallback(
    async (id: string, task: SourceTask, work: () => Promise<void>) => {
      if (running.current.has(id)) {
        return;
      }
      running.current.add(id);
      setBusy((current) => ({ ...current, [id]: task }));
      try {
        await work();
      } finally {
        running.current.delete(id);
        setBusy((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
      }
    },
    []
  );

  const capture = useCallback(
    (source: ContentStudioSourceSummary) =>
      run(source.id, 'capture', async () => {
        try {
          const result = await actions.captureSource(source.id);
          toaster.show(
            // a feed that had not changed (P8-G1) only says so
            'capture' in result
              ? result.notModified
                ? t(
                    'content_studio_feed_captured_not_modified',
                    'Feed checked. No changes detected since its last capture.'
                  )
                : feedCaptureMessage(t, result.capture)
              : t('content_studio_source_captured', 'Source captured.'),
            'success'
          );
          onCaptured?.();
        } catch (err) {
          toaster.show(sourceErrorMessage(t, err), 'warning');
          // another capture, an archive or a removal won: show what is there
          // now. A feed's failed refresh is in its capture history (P8-O1)
          if (
            source.kind === 'feed' ||
            [
              'CS_SOURCE_VERSION_CONFLICT',
              'CS_SOURCE_ARCHIVED',
              'CS_NOT_FOUND',
            ].includes(sourceErrorCode(err) ?? '')
          ) {
            await actions.refresh(source.id);
          }
        }
      }),
    [run, actions, toaster, onCaptured, t]
  );

  const archive = useCallback(
    async (source: ContentStudioSourceSummary) => {
      if (
        !(await deleteDialog(
          t(
            'content_studio_source_archive_hint',
            'It will no longer be available for new AI source selections. Its captured version history will remain available.'
          ),
          t('content_studio_archive', 'Archive'),
          t('content_studio_source_archive_title', 'Archive this source?'),
          t('cancel', 'Cancel')
        ))
      ) {
        return;
      }
      await run(source.id, 'archive', async () => {
        try {
          await actions.archiveSource(source.id);
          toaster.show(
            t('content_studio_source_archived', 'Source archived.'),
            'success'
          );
        } catch (err) {
          toaster.show(sourceErrorMessage(t, err), 'warning');
        }
      });
    },
    [run, actions, toaster, t]
  );

  const restore = useCallback(
    (source: ContentStudioSourceSummary) =>
      run(source.id, 'restore', async () => {
        try {
          await actions.restoreSource(source.id);
          toaster.show(
            t('content_studio_source_restored', 'Source restored.'),
            'success'
          );
        } catch (err) {
          toaster.show(sourceErrorMessage(t, err), 'warning');
        }
      }),
    [run, actions, toaster, t]
  );

  // a feed's scheduled captures (P8-C3); a refresh stays possible
  const pause = useCallback(
    (source: ContentStudioSourceSummary) =>
      run(source.id, 'pause', async () => {
        try {
          await actions.pauseFeed(source.id);
          toaster.show(
            t('content_studio_feed_paused', 'Feed paused.'),
            'success'
          );
        } catch (err) {
          toaster.show(sourceErrorMessage(t, err), 'warning');
        }
      }),
    [run, actions, toaster, t]
  );

  const resume = useCallback(
    (source: ContentStudioSourceSummary) =>
      run(source.id, 'resume', async () => {
        try {
          await actions.resumeFeed(source.id);
          toaster.show(
            t('content_studio_feed_resumed', 'Feed resumed.'),
            'success'
          );
        } catch (err) {
          toaster.show(sourceErrorMessage(t, err), 'warning');
        }
      }),
    [run, actions, toaster, t]
  );

  // how often a feed is captured automatically (P8-C4)
  const changeInterval = useCallback(
    (source: ContentStudioSourceSummary, intervalMinutes: number | null) =>
      run(source.id, 'interval', async () => {
        try {
          await actions.setFeedInterval(source.id, intervalMinutes);
          toaster.show(
            t('content_studio_feed_interval_saved', 'Capture interval saved.'),
            'success'
          );
        } catch (err) {
          toaster.show(sourceErrorMessage(t, err), 'warning');
        }
      }),
    [run, actions, toaster, t]
  );

  const rename = useCallback(
    (source: ContentStudioSourceSummary) =>
      modals.openModal({
        title: t('content_studio_rename_source', 'Rename source'),
        children: (close: () => void) => (
          <RenameSourceForm source={source} close={close} />
        ),
      }),
    [modals, t]
  );

  return {
    busy,
    capture,
    archive,
    restore,
    pause,
    resume,
    changeInterval,
    rename,
  };
};

// Pause feed while a live feed is captured on the schedule, Resume feed while
// it is paused (P8-C3). Never for a page or an archived feed
export const FeedScheduleButton: FC<{
  source: ContentStudioSourceSummary;
  busy?: SourceTask;
  commands: ReturnType<typeof useSourceCommands>;
}> = ({ source, busy, commands }) => {
  const t = useT();
  if (source.kind !== 'feed' || source.archivedAt) {
    return null;
  }
  const paused = !!source.scanPausedAt;
  const label = paused
    ? t('content_studio_feed_resume', 'Resume feed')
    : t('content_studio_feed_pause', 'Pause feed');
  return (
    <Button
      secondary
      loading={busy === (paused ? 'resume' : 'pause')}
      disabled={!!busy}
      aria-label={`${label} ${source.name}`}
      onClick={() =>
        paused ? commands.resume(source) : commands.pause(source)
      }
    >
      {label}
    </Button>
  );
};

// A live feed whose scheduled captures are paused (P8-C3): a plain label,
// like Active. Archived says more, so it is not shown then
export const FeedPausedBadge: FC<{ source: ContentStudioSourceSummary }> = ({
  source,
}) => {
  const t = useT();
  if (source.kind !== 'feed' || source.archivedAt || !source.scanPausedAt) {
    return null;
  }
  return (
    <span className="px-[8px] rounded-full border border-newTableBorder">
      {t('content_studio_feed_paused_status', 'Paused')}
    </span>
  );
};

// A live feed whose last scheduled capture failed (P8-C4), while it runs:
// its next try is later than its interval. A plain label like Paused, which
// says more and is shown instead; never the error or how often it failed
export const FeedDelayedBadge: FC<{ source: ContentStudioSourceSummary }> = ({
  source,
}) => {
  const t = useT();
  if (
    source.kind !== 'feed' ||
    source.archivedAt ||
    source.scanPausedAt ||
    !(source.consecutiveCaptureFailures > 0)
  ) {
    return null;
  }
  return (
    <span className="px-[8px] rounded-full border border-newTableBorder">
      {t('content_studio_feed_delayed', 'Capture delayed')}
    </span>
  );
};

// How often a live feed is captured automatically (P8-C4), paused or not:
// the default first, then each preset. Never for a page or an archived feed
export const FeedIntervalSelect: FC<{
  source: ContentStudioSourceSummary;
  busy?: SourceTask;
  commands: ReturnType<typeof useSourceCommands>;
}> = ({ source, busy, commands }) => {
  const t = useT();
  const intervalLabel = useFeedIntervalLabel();
  if (source.kind !== 'feed' || source.archivedAt) {
    return null;
  }
  return (
    <label className="flex flex-col gap-[4px] text-[12px]">
      {t('content_studio_feed_interval', 'Capture interval')}
      <select
        className="bg-newBgColorInner h-[32px] px-[8px] border-newTableBorder border rounded-[8px] text-textColor text-[13px] max-w-[280px]"
        value={source.captureIntervalMinutes ?? ''}
        disabled={!!busy}
        aria-busy={busy === 'interval'}
        onChange={(e) =>
          commands.changeInterval(
            source,
            e.target.value ? Number(e.target.value) : null
          )
        }
      >
        <option value="">{intervalLabel(null)}</option>
        {CONTENT_STUDIO_FEED_INTERVALS.map((minutes) => (
          <option key={minutes} value={minutes}>
            {intervalLabel(minutes)}
          </option>
        ))}
      </select>
    </label>
  );
};

// Capture now before the first capture, Refresh after it: both ask the server
// to fetch the stored URL and keep what it gets as the next version. A feed:
// Capture feed, then Refresh feed, which find and capture its pages
export const CaptureButton: FC<{
  source: ContentStudioSourceSummary;
  busy?: SourceTask;
  onClick: () => void;
}> = ({ source, busy, onClick }) => {
  const t = useT();
  const label =
    source.kind === 'feed'
      ? source.lastCapturedAt
        ? t('content_studio_feed_refresh', 'Refresh feed')
        : t('content_studio_feed_capture', 'Capture feed')
      : source.latestVersionNumber > 0
      ? t('content_studio_source_refresh', 'Refresh')
      : t('content_studio_source_capture', 'Capture now');
  return (
    <Button
      secondary
      loading={busy === 'capture'}
      disabled={!!busy}
      aria-busy={busy === 'capture'}
      aria-label={`${label} ${source.name}`}
      onClick={onClick}
    >
      {label}
    </Button>
  );
};

// Captured: the page has a version. Never "failed" (P8-02: a page a feed
// found; P8-03: a page in the Source picker)
export const ContentStudioCaptureBadge: FC<{ latestVersionNumber: number }> = ({
  latestVersionNumber,
}) => {
  const t = useT();
  return (
    <span className="px-[8px] rounded-full border border-newTableBorder text-[12px]">
      {latestVersionNumber >= 1
        ? t('content_studio_discovery_captured', 'Captured')
        : t('content_studio_discovery_not_captured', 'Not captured')}
    </span>
  );
};

// Active, Archived, Not captured yet or Version N (a feed: when it was last
// captured): nothing about whether the source is right
export const SourceStatus: FC<{ source: ContentStudioSourceSummary }> = ({
  source,
}) => {
  const t = useT();
  if (source.kind === 'feed') {
    return (
      <span>
        {source.lastCapturedAt
          ? `${t(
              'content_studio_feed_last_captured',
              'Last captured'
            )}: ${formatDate(source.lastCapturedAt)}`
          : t('content_studio_source_not_captured', 'Not captured yet')}
      </span>
    );
  }
  return (
    <span>
      {source.latestVersionNumber > 0
        ? `${t('content_studio_revision', 'Version')} ${
            source.latestVersionNumber
          }`
        : t('content_studio_source_not_captured', 'Not captured yet')}
    </span>
  );
};

const SourceRow: FC<{
  source: ContentStudioSourceSummary;
  busy?: SourceTask;
  commands: ReturnType<typeof useSourceCommands>;
}> = ({ source, busy, commands }) => {
  const t = useT();
  const kindLabel = useSourceKindLabel();
  const archived = !!source.archivedAt;
  return (
    <li className="flex flex-wrap items-center gap-[12px] p-[16px] border border-newTableBorder rounded-[8px]">
      <div className="flex flex-col gap-[4px] flex-1 min-w-[200px]">
        <Link
          href={sourcePagePath(source.id)}
          className="text-[16px] font-[600] break-words hover:underline"
        >
          {source.name}
        </Link>
        <SourceUrl
          url={source.canonicalUrl}
          className="text-[13px] text-textItemBlur"
        />
        <div className="flex flex-wrap gap-x-[16px] gap-y-[4px] text-[12px] text-textItemBlur">
          <span>{kindLabel(source.kind)}</span>
          <FeedPausedBadge source={source} />
          <FeedDelayedBadge source={source} />
          <SourceStatus source={source} />
          <span>
            {t('content_studio_updated', 'Updated')}:{' '}
            {formatDate(source.updatedAt)}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-[8px]">
        <Link
          href={sourcePagePath(source.id)}
          aria-label={`${t('content_studio_view_source', 'View')} ${
            source.name
          }`}
          className="h-[40px] px-[24px] flex items-center rounded-full bg-[var(--brand-primary,#612ad5)] text-[var(--brand-action-text,#fff)]"
        >
          {t('content_studio_view_source', 'View')}
        </Link>
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
    </li>
  );
};

// The Source Library: the organization's sources, active or archived, one
// summary page at a time, in the server's order. Nothing is captured unless
// the user asks for it. A search (P8-03) is the server's: part of a source's
// name or URL, in any case, over every page
export const ContentStudioSources: FC = () => {
  const t = useT();
  const modals = useModals();
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const list = useContentStudioSources(archived, page, undefined, search);
  const commands = useSourceCommands();

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setSearch(query.trim());
    setPage(1);
  };

  const pages = list.data?.pages;
  // a page that no longer exists (after archiving, say) moves to the last one
  useEffect(() => {
    if (pages !== undefined && page > Math.max(pages, 1)) {
      setPage(Math.max(pages, 1));
    }
  }, [pages, page]);

  const addSource = useCallback(
    () =>
      modals.openModal({
        title: t('content_studio_add_source', 'Add source'),
        children: (close: () => void) => <AddSourceForm close={close} />,
      }),
    [modals, t]
  );

  return (
    <ContentStudioPage
      title={t('content_studio_sources', 'Sources')}
      description={t(
        'content_studio_sources_subtitle',
        'Web pages and feeds you write from. Content Studio captures them, so AI writing can quote and cite them.'
      )}
      help={t(
        'content_studio_sources_note',
        'Captured source material is stored with version history and provenance. Sources are not automatically fact-checked.'
      )}
      actions={
        <Button onClick={addSource}>
          {t('content_studio_add_source', 'Add source')}
        </Button>
      }
    >
      <div
        role="group"
        aria-label={t('content_studio_status', 'Status')}
        className="flex gap-[8px]"
      >
        {[false, true].map((value) => (
          <Button
            key={String(value)}
            secondary={archived !== value}
            aria-pressed={archived === value}
            className={clsx(archived === value && 'font-[600]')}
            onClick={() => {
              if (archived !== value) {
                setArchived(value);
                setPage(1);
              }
            }}
          >
            {value
              ? t('content_studio_archived', 'Archived')
              : t('content_studio_active', 'Active')}
          </Button>
        ))}
      </div>

      <form
        role="search"
        onSubmit={submitSearch}
        className="flex gap-[8px] items-end min-w-0"
      >
        <label className="flex flex-col gap-[4px] text-[12px] min-w-0 flex-1">
          {t('content_studio_source_picker_search', 'Name or address')}
          <input
            type="search"
            className="bg-newBgColorInner h-[40px] px-[10px] border-newTableBorder border rounded-[8px] text-textColor text-[14px] w-full min-w-0"
            value={query}
            maxLength={SOURCE_SEARCH_MAX}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <Button type="submit" secondary>
          {t('content_studio_library_search', 'Search')}
        </Button>
      </form>

      {list.error ? (
        <div className="flex flex-col items-center gap-[12px] py-[40px]">
          <div>
            {t(
              'content_studio_sources_load_error',
              'Sources could not be loaded.'
            )}
          </div>
          <Button secondary onClick={() => list.mutate()}>
            {t('content_studio_retry', 'Try again')}
          </Button>
        </div>
      ) : !list.data ? (
        <LoadingComponent />
      ) : !list.data.results.length ? (
        <div className="flex flex-col items-center gap-[12px] py-[40px] text-center">
          {search ? (
            <div>
              {t(
                'content_studio_source_picker_no_match',
                'No sources match this search.'
              )}
            </div>
          ) : archived ? (
            <div>
              {t('content_studio_no_archived_sources', 'No archived sources.')}
            </div>
          ) : (
            <>
              <div>{t('content_studio_no_sources', 'No sources yet.')}</div>
              <div className="text-textItemBlur">
                {t(
                  'content_studio_no_sources_hint',
                  'Add the address of a page you want to write about, such as your own website, a blog post or a news feed. Content Studio captures its text so AI writing can use and cite it.'
                )}
              </div>
              <Button onClick={addSource}>
                {t('content_studio_add_source', 'Add source')}
              </Button>
            </>
          )}
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-[12px]">
            {list.data.results.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                busy={commands.busy[source.id]}
                commands={commands}
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
        </>
      )}
    </ContentStudioPage>
  );
};
