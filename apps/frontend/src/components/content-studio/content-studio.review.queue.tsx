'use client';

import { FC, FormEvent, useEffect, useState } from 'react';
import clsx from 'clsx';
import dayjs from 'dayjs';
import Link from 'next/link';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { ContentStudioPage } from '@gitroom/frontend/components/content-studio/content-studio.shell';
import { CONTENT_STUDIO_REVIEW_QUEUE_SEARCH_MAX } from '@gitroom/nestjs-libraries/content-studio/review/review.approval';
import type { ContentStudioReviewQueue as Queue } from '@gitroom/nestjs-libraries/content-studio/review/review.approval';
import type { ContentStudioReviewTargetType } from '@gitroom/nestjs-libraries/content-studio/review/review.state';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';
import { ContentStudioRevisionApprovalBadge } from '@gitroom/frontend/components/content-studio/content-studio.review.approval';
import {
  contentStudioReviewTargetHref,
  ContentStudioReviewQueueItem,
  useContentStudioReviewQueue,
  useContentStudioReviewQueueFilters,
} from '@gitroom/frontend/components/content-studio/content-studio.reviews.api';

// The Review & Approval queue (P5-06): the organization's reviews, one server
// page at a time, by where each one stands now as the server derived it
// (P5-05), never worked out here. A row says what it is about (the package
// or design and its exact version or revision), where it stands, who asked
// and when it last moved. Its one action opens exactly that revision, where
// the review, claims, discussion and approval are acted on; nothing is
// decided, commented, requested or assessed here

type Translate = (key: string, fallback: string) => string;

const when = (value: string) => dayjs(value).format('MMM D, YYYY HH:mm');

// null: every review
const QUEUES: (Queue | null)[] = [
  'NEEDS_REVIEW',
  'CHANGES_REQUESTED',
  'PENDING_APPROVAL',
  'APPROVED',
  'REFUSED',
  'CANCELLED',
  null,
];
const TYPES: (ContentStudioReviewTargetType | null)[] = [
  null,
  'PACKAGE_REVISION',
  'DESIGN_REVISION',
];

const queueLabel = (t: Translate, queue: Queue | null) => {
  switch (queue) {
    case 'NEEDS_REVIEW':
      return t('content_studio_review_queue_needs_review', 'Needs review');
    case 'CHANGES_REQUESTED':
      return t(
        'content_studio_review_state_changes_requested',
        'Changes requested'
      );
    case 'PENDING_APPROVAL':
      return t('content_studio_approval_state_pending', 'Pending approval');
    case 'APPROVED':
      return t('content_studio_approval_state_approved', 'Approved');
    case 'REFUSED':
      return t('content_studio_approval_state_refused', 'Refused');
    case 'CANCELLED':
      return t(
        'content_studio_revision_approval_review_cancelled',
        'Review cancelled'
      );
    default:
      return t('content_studio_review_queue_all', 'All');
  }
};

const typeLabel = (t: Translate, type: ContentStudioReviewTargetType | null) =>
  type === 'PACKAGE_REVISION'
    ? t('content_studio_review_queue_packages', 'Packages')
    : type === 'DESIGN_REVISION'
    ? t('content_studio_review_queue_designs', 'Designs')
    : t('content_studio_review_queue_all', 'All');

// The package or design and the exact revision, in words
const targetText = (t: Translate, item: ContentStudioReviewQueueItem) => {
  const pkg = item.target.type === 'PACKAGE_REVISION';
  return {
    kind: pkg
      ? t('content_studio_review_queue_package', 'Package')
      : t('content_studio_review_queue_design', 'Design'),
    name:
      item.target.parentName.trim() ||
      (pkg
        ? t('content_studio_review_queue_untitled_package', 'Untitled package')
        : t('content_studio_review_queue_untitled_design', 'Untitled design')),
    revision: `${
      pkg
        ? t('content_studio_revision', 'Version')
        : t('content_studio_design_revision', 'Revision')
    } ${item.target.revisionNumber}`,
  };
};

const requestLabel = (
  t: Translate,
  request: ContentStudioReviewQueueItem['revisionRequest']
) =>
  request?.status === 'OPEN'
    ? t('content_studio_review_queue_request_open', 'Revision request open')
    : request?.status === 'RESOLVED'
    ? t(
        'content_studio_review_queue_request_resolved',
        'Revision request resolved'
      )
    : t(
        'content_studio_review_queue_request_none',
        'No revision request recorded'
      );

const QueueRow: FC<{ item: ContentStudioReviewQueueItem }> = ({ item }) => {
  const t = useT();
  const target = targetText(t, item);
  const claims = item.claimSummary;
  return (
    <li className="flex flex-wrap items-center gap-[12px] border border-newTableBorder rounded-[8px] p-[12px] min-w-0">
      <div className="flex flex-col gap-[4px] flex-1 min-w-[200px]">
        <div className="text-[12px] text-textItemBlur">{target.kind}</div>
        <h2 className="text-[15px] font-[600] break-words">{target.name}</h2>
        <div className="flex flex-wrap items-center gap-[8px]">
          <span>{target.revision}</span>
          <ContentStudioRevisionApprovalBadge approval={item.approval} />
        </div>
        <div className="text-[12px] text-textItemBlur flex flex-wrap gap-x-[12px]">
          {!!item.requestedBy.name && (
            <span>
              {t('content_studio_review_queue_requested_by', 'Requested by')}{' '}
              {item.requestedBy.name}
            </span>
          )}
          <span>
            {t('content_studio_review_queue_updated', 'Updated')}{' '}
            {when(item.updatedAt)}
          </span>
          {!!item.approval.decidedAt && (
            <span>
              {t('content_studio_review_queue_decided', 'Decided')}{' '}
              {when(item.approval.decidedAt)}
            </span>
          )}
        </div>
        {item.approval.state === 'CHANGES_REQUESTED' && (
          <div className="text-[13px]">
            {requestLabel(t, item.revisionRequest)}
          </div>
        )}
        {!!claims && (
          <div className="text-[13px]">
            {claims.total
              ? `${t(
                  'content_studio_review_queue_claims_verified',
                  'Claims verified'
                )}: ${claims.verified} / ${claims.total}`
              : t(
                  'content_studio_review_queue_no_claims',
                  'No grounded claims'
                )}
          </div>
        )}
      </div>
      <Link
        href={contentStudioReviewTargetHref(item.target)}
        aria-label={`${t('content_studio_review_queue_open', 'Open review')}: ${
          target.name
        }, ${target.revision}`}
        className="px-[24px] h-[40px] flex items-center rounded-full bg-third border border-textColor/60 text-textColor"
      >
        {t('content_studio_review_queue_open', 'Open review')}
      </Link>
    </li>
  );
};

export const ContentStudioReviewQueue: FC = () => {
  const t = useT();
  const { filters, setFilters } = useContentStudioReviewQueueFilters();
  const list = useContentStudioReviewQueue(filters);
  const [search, setSearch] = useState(filters.search);
  // the URL's search, once it changes (back and forward included)
  useEffect(() => {
    setSearch(filters.search);
  }, [filters.search]);

  const pages = list.data?.pages;
  // a page that no longer exists (after a decision, say) moves to the last one
  useEffect(() => {
    if (pages === undefined) {
      return;
    }
    if (pages === 0 && filters.page > 1) {
      setFilters({ page: 1 });
    } else if (pages > 0 && filters.page > pages) {
      setFilters({ page: pages });
    }
  }, [pages, filters.page]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFilters({ search });
  };

  const empty =
    filters.targetType || filters.search.trim()
      ? t(
          'content_studio_review_queue_empty_filtered',
          'No reviews match these filters.'
        )
      : filters.queue === 'APPROVED' ||
        filters.queue === 'REFUSED' ||
        filters.queue === 'CANCELLED'
      ? t(
          'content_studio_review_queue_empty_completed',
          'No completed reviews yet.'
        )
      : filters.queue
      ? t(
          'content_studio_review_queue_empty_open',
          'No review or approval work needs attention.'
        )
      : t('content_studio_review_queue_empty_all', 'No reviews yet.');

  return (
    <ContentStudioPage
      title={t('content_studio_review_queue', 'Review & Approval')}
      description={t(
        'content_studio_review_queue_subtitle',
        'Find the reviews and approvals that need attention. Each one opens at its exact version.'
      )}
      help={t(
        'content_studio_review_queue_help',
        'Ask for a review from a package or a design: colleagues comment, request changes or approve that exact version.'
      )}
    >
      <div
        role="group"
        aria-label={t('content_studio_review_queue_filter', 'Review state')}
        className="flex flex-wrap gap-[8px]"
      >
        {QUEUES.map((queue) => (
          <Button
            key={queue ?? 'all'}
            secondary={filters.queue !== queue}
            aria-pressed={filters.queue === queue}
            className={clsx(filters.queue === queue && 'font-[600]')}
            onClick={() => {
              if (filters.queue !== queue) {
                setFilters({ queue });
              }
            }}
          >
            {queueLabel(t, queue)}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-[12px]">
        <div
          role="group"
          aria-label={t('content_studio_review_queue_type', 'Content type')}
          className="flex flex-wrap gap-[8px]"
        >
          {TYPES.map((type) => (
            <Button
              key={type ?? 'all'}
              secondary={filters.targetType !== type}
              aria-pressed={filters.targetType === type}
              className={clsx(filters.targetType === type && 'font-[600]')}
              onClick={() => {
                if (filters.targetType !== type) {
                  setFilters({ targetType: type });
                }
              }}
            >
              {typeLabel(t, type)}
            </Button>
          ))}
        </div>
        <form
          role="search"
          onSubmit={submit}
          className="flex gap-[8px] items-end flex-1 min-w-[200px]"
        >
          <label className="flex flex-col gap-[4px] text-[12px] min-w-0 flex-1">
            {t('content_studio_review_queue_search', 'Package or design name')}
            <input
              type="search"
              className="bg-newBgColorInner h-[40px] px-[10px] border-newTableBorder border rounded-[8px] text-textColor text-[14px] w-full min-w-0"
              value={search}
              maxLength={CONTENT_STUDIO_REVIEW_QUEUE_SEARCH_MAX}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <Button type="submit" secondary>
            {t('content_studio_library_search', 'Search')}
          </Button>
        </form>
      </div>

      {list.error ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-[12px] py-[40px]"
        >
          <div>
            {t(
              'content_studio_review_queue_load_error',
              'Review & Approval could not be loaded.'
            )}
          </div>
          <Button secondary onClick={() => list.mutate()}>
            {t('content_studio_retry', 'Try again')}
          </Button>
        </div>
      ) : !list.data ? (
        <LoadingComponent />
      ) : !list.data.results.length ? (
        <div className="flex flex-col items-center gap-[12px] py-[40px]">
          {empty}
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-[8px] min-w-0">
            {list.data.results.map((item) => (
              <QueueRow key={item.id} item={item} />
            ))}
          </ul>
          {list.data.pages > 1 && (
            <ContentStudioPager
              page={filters.page}
              pages={list.data.pages}
              setPage={(page) => setFilters({ page })}
            />
          )}
        </>
      )}
    </ContentStudioPage>
  );
};
