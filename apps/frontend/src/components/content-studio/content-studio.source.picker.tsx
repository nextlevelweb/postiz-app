'use client';

import { FC, KeyboardEvent, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import {
  contentStudioSourceHost,
  ContentStudioSourceSummary,
  isContentStudioSourceUsable,
  SOURCE_SEARCH_MAX,
  useContentStudioSource,
  useContentStudioSources,
} from '@gitroom/frontend/components/content-studio/content-studio.sources.api';
import {
  ContentStudioCaptureBadge,
  sourcePagePath,
} from '@gitroom/frontend/components/content-studio/content-studio.sources';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';

// Choosing sources for AI writing or for evidence (P8-03): the organization's
// live web pages, searched by the server (part of the name or the URL, any
// case) and paged 20 at a time, so every page can be found, not only the most
// recently updated ones. A page without a captured version is shown but
// cannot be chosen: nothing is captured here. The choice is ids only, in the
// order chosen, owned by the caller: a search or another page never drops it.
// Which version is used is decided by the server when the source is used

type Summary = Pick<
  ContentStudioSourceSummary,
  'id' | 'kind' | 'name' | 'canonicalUrl' | 'latestVersionNumber' | 'archivedAt'
>;

const fieldClass =
  'bg-newBgColorInner h-[32px] px-[10px] border-newTableBorder border rounded-[8px] text-textColor text-[13px] w-full min-w-0';

// The host of a page's stored URL, never the URL itself
const SourceHost: FC<{ source: Summary }> = ({ source }) =>
  source.canonicalUrl ? (
    <span className="text-[12px] text-textItemBlur truncate">
      {contentStudioSourceHost(source.canonicalUrl)}
    </span>
  ) : null;

// A chosen source that is not on the page shown: read by its id, from this
// organization only. One that is gone, of another organization or no longer
// usable is reported once and left out
const LookedUpSource: FC<{
  id: string;
  onFound: (source: Summary) => void;
  onUnavailable: (id: string) => void;
}> = ({ id, onFound, onUnavailable }) => {
  const { data, error } = useContentStudioSource(id);
  useEffect(() => {
    if (error) {
      onUnavailable(id);
    } else if (data) {
      if (data.id === id && isContentStudioSourceUsable(data)) {
        onFound(data);
      } else {
        onUnavailable(id);
      }
    }
  }, [data, error, id]);
  return <LoadingComponent width={16} height={16} />;
};

export const ContentStudioSourcePicker: FC<{
  mode: 'multiple' | 'single';
  // multiple only: how many can be chosen
  max?: number;
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  // shown instead of the list when it cannot be loaded
  errorText: string;
  // shown when the organization has no web page yet
  emptyText: string;
}> = ({ mode, max, value, onChange, disabled, errorText, emptyText }) => {
  const t = useT();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const list = useContentStudioSources(false, page, 'url', search);
  // what is known of each chosen source, from the list or its own lookup
  const [known, setKnown] = useState<Record<string, Summary>>({});
  const [unavailable, setUnavailable] = useState(false);
  // the choice as it is now, for a lookup that answers later
  const current = useRef(value);
  current.current = value;

  // live web pages only, whatever a list holds
  const rows = (list.data?.results || []).filter(
    (source) => source.kind === 'url' && !source.archivedAt
  );
  const pages = list.data?.pages;
  // a page that no longer exists moves to the last one
  useEffect(() => {
    if (pages !== undefined && page > Math.max(pages, 1)) {
      setPage(Math.max(pages, 1));
    }
  }, [pages, page]);

  // a chosen id (from a link, say) whose page is listed without a captured
  // version cannot be used: it is left out, never kept as chosen
  useEffect(() => {
    const unusable = value.filter((id) => {
      const row = rows.find((source) => source.id === id);
      return !!row && !isContentStudioSourceUsable(row);
    });
    if (unusable.length) {
      setUnavailable(true);
      onChange(value.filter((id) => !unusable.includes(id)));
    }
  }, [rows, value]);

  const summaryOf = (id: string) =>
    known[id] ?? rows.find((source) => source.id === id);
  const limit = mode === 'single' ? 1 : max ?? 1;
  const full = mode === 'multiple' && value.length >= limit;

  const remember = (source: Summary) =>
    setKnown((entries) => ({ ...entries, [source.id]: source }));
  // several lookups can answer before the next render: each one drops from
  // the choice as the previous one left it
  const drop = (id: string) => {
    setUnavailable(true);
    const next = current.current.filter((entry) => entry !== id);
    current.current = next;
    onChange(next);
  };
  const choose = (source: Summary, checked: boolean) => {
    if (!checked) {
      onChange(value.filter((id) => id !== source.id));
      return;
    }
    if (!isContentStudioSourceUsable(source) || value.includes(source.id)) {
      return;
    }
    remember(source);
    if (mode === 'single') {
      onChange([source.id]);
    } else if (!full) {
      onChange([...value, source.id]);
    }
  };

  const submit = () => {
    setSearch(query.trim());
    setPage(1);
  };
  // the search sits inside other forms (a claim), so Enter searches here and
  // never submits them
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex flex-col gap-[8px] min-w-0">
      {!!value.length && (
        <div
          aria-label={t('content_studio_source_picker_selected', 'Selected')}
          className="flex flex-col gap-[4px]"
        >
          <div className="text-[12px] text-textItemBlur">
            {mode === 'multiple'
              ? `${t('content_studio_source_picker_selected', 'Selected')} (${
                  value.length
                }/${limit})`
              : t('content_studio_source_picker_selected', 'Selected')}
          </div>
          <ol className="flex flex-col gap-[4px]">
            {value.map((id, index) => {
              const source = summaryOf(id);
              return (
                <li
                  key={id}
                  data-selected-source={id}
                  className="flex items-center gap-[8px] text-[13px] min-w-0"
                >
                  {mode === 'multiple' && (
                    <span className="text-[12px] text-textItemBlur">
                      #{index + 1}
                    </span>
                  )}
                  <span className="flex flex-col flex-1 min-w-0">
                    {source ? (
                      <>
                        <span className="break-words">{source.name}</span>
                        <SourceHost source={source} />
                      </>
                    ) : (
                      <LookedUpSource
                        id={id}
                        onFound={remember}
                        onUnavailable={drop}
                      />
                    )}
                  </span>
                  <Button
                    secondary
                    disabled={disabled}
                    aria-label={`${t(
                      'content_studio_source_picker_remove',
                      'Remove'
                    )} ${source?.name ?? ''}`.trim()}
                    onClick={() =>
                      onChange(value.filter((entry) => entry !== id))
                    }
                  >
                    {t('content_studio_source_picker_remove', 'Remove')}
                  </Button>
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {unavailable && (
        <div role="status" className="text-[12px] text-textItemBlur">
          {t(
            'content_studio_research_unavailable',
            'A research source is no longer available.'
          )}
        </div>
      )}
      <div role="search" className="flex gap-[8px] items-end min-w-0">
        <label className="flex flex-col gap-[4px] text-[12px] min-w-0 flex-1">
          {t('content_studio_source_picker_search', 'Name or address')}
          <input
            type="search"
            className={fieldClass}
            value={query}
            maxLength={SOURCE_SEARCH_MAX}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>
        <Button type="button" secondary onClick={submit}>
          {t('content_studio_library_search', 'Search')}
        </Button>
      </div>
      {list.error ? (
        <div role="alert" className="text-[12px] text-textItemBlur">
          {errorText}
        </div>
      ) : !list.data ? (
        <LoadingComponent width={24} height={24} />
      ) : !rows.length ? (
        <div className="text-[12px] text-textItemBlur">
          {search
            ? t(
                'content_studio_source_picker_no_match',
                'No sources match this search.'
              )
            : emptyText}
        </div>
      ) : (
        <ul className="flex flex-col gap-[4px] max-h-[240px] overflow-y-auto min-w-0">
          {rows.map((source) => {
            const chosen = value.includes(source.id);
            const captured = source.latestVersionNumber >= 1;
            return (
              <li
                key={source.id}
                data-source={source.id}
                className="flex items-center gap-[8px] text-[14px] min-w-0"
              >
                <span className="flex flex-col flex-1 min-w-0">
                  <label className="flex items-center gap-[8px] min-w-0">
                    <input
                      type={mode === 'single' ? 'radio' : 'checkbox'}
                      checked={chosen}
                      disabled={
                        disabled ||
                        !isContentStudioSourceUsable(source) ||
                        (!chosen && full)
                      }
                      onChange={(e) => choose(source, e.target.checked)}
                    />
                    <span className="break-words">{source.name}</span>
                  </label>
                  <SourceHost source={source} />
                </span>
                <ContentStudioCaptureBadge
                  latestVersionNumber={source.latestVersionNumber}
                />
                {!captured && (
                  <Link
                    href={sourcePagePath(source.id)}
                    className="text-[12px] underline"
                  >
                    {t('content_studio_view_source', 'View')}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!!pages && pages > 1 && (
        <ContentStudioPager page={page} pages={pages} setPage={setPage} />
      )}
    </div>
  );
};

// One research source a link named, by name once it proves to be a live
// captured web page of this organization; anything else is reported and
// never named
const ResearchSourceName: FC<{
  id: string;
  onUnavailable: (id: string) => void;
}> = ({ id, onUnavailable }) => {
  const { data, error } = useContentStudioSource(id);
  const usable = !!data && data.id === id && isContentStudioSourceUsable(data);
  useEffect(() => {
    if (error || (data && !usable)) {
      onUnavailable(id);
    }
  }, [data, error, usable, id]);
  return usable ? <li className="break-words">{data.name}</li> : null;
};

// Research into content (P8-03): the sources a package link names, ready to
// start out chosen in AI writing. Showing them reads each one by id only; it
// asks nothing of the AI and opens nothing. Clear forgets them
export const ContentStudioResearchNotice: FC<{
  sourceIds: string[];
  onClear: () => void;
}> = ({ sourceIds, onClear }) => {
  const t = useT();
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const report = (id: string) =>
    setUnavailable((ids) => (ids.includes(id) ? ids : [...ids, id]));
  const usable = sourceIds.filter((id) => !unavailable.includes(id));
  return (
    <div
      role="status"
      className="flex flex-wrap items-start gap-[8px] border border-newTableBorder rounded-[8px] p-[12px] text-[13px] min-w-0"
    >
      <div className="flex flex-col gap-[4px] flex-1 min-w-[200px]">
        {!!usable.length && (
          <>
            <div className="font-[600]">
              {t(
                'content_studio_research_ready',
                'Research ready for AI writing:'
              )}
            </div>
            <ul className="flex flex-col gap-[2px]">
              {usable.map((id) => (
                <ResearchSourceName key={id} id={id} onUnavailable={report} />
              ))}
            </ul>
          </>
        )}
        {!!unavailable.length && (
          <div className="text-textItemBlur">
            {t(
              'content_studio_research_unavailable',
              'A research source is no longer available.'
            )}
          </div>
        )}
      </div>
      <Button secondary onClick={onClear}>
        {t('content_studio_research_clear', 'Clear')}
      </Button>
    </div>
  );
};
