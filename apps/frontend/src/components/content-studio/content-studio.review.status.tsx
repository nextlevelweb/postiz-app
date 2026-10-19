'use client';

import { FC, useState } from 'react';
import dayjs from 'dayjs';
import { Button } from '@gitroom/react/form/button';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  ContentStudioReviewAction,
  ContentStudioReviewState,
  ContentStudioReviewTargetType,
  contentStudioReviewActions,
} from '@gitroom/nestjs-libraries/content-studio/review/review.state';
import {
  reviewErrorMessage,
  useContentStudioReviewActions,
  useContentStudioReviewForRevision,
} from '@gitroom/frontend/components/content-studio/content-studio.reviews.api';
import { designErrorCode } from '@gitroom/frontend/components/content-studio/content-studio.designs.api';
import {
  ContentStudioRequestChangesForm,
  ContentStudioReviewDiscussion,
  ContentStudioReviewRevisionChoice,
  ContentStudioRevisionRequestPanel,
} from '@gitroom/frontend/components/content-studio/content-studio.review.discussion';

type Translate = (key: string, fallback: string) => string;

// Every state in words: never by color alone
const stateLabel = (t: Translate, state: ContentStudioReviewState) => {
  switch (state) {
    case 'REQUESTED':
      return t('content_studio_review_state_requested', 'Review requested');
    case 'IN_REVIEW':
      return t('content_studio_review_state_in_review', 'In review');
    case 'CHANGES_REQUESTED':
      return t(
        'content_studio_review_state_changes_requested',
        'Changes requested'
      );
    case 'READY_FOR_APPROVAL':
      return t('content_studio_review_state_ready', 'Ready for approval');
    case 'CANCELLED':
      return t('content_studio_review_state_cancelled', 'Cancelled');
  }
};

const actionLabel = (t: Translate, action: ContentStudioReviewAction) => {
  switch (action) {
    case 'start':
      return t('content_studio_review_start', 'Start review');
    case 'request-changes':
      return t('content_studio_review_request_changes', 'Request changes');
    case 'ready-for-approval':
      return t('content_studio_review_mark_ready', 'Ready for approval');
    case 'cancel':
      return t('content_studio_review_cancel', 'Cancel review');
  }
};

// The review of exactly one saved revision of a package or a design: which
// revision, its state in words, and the actions that state allows (from the
// shared state machine), or "Request review" when it has none. Unsaved
// changes are never part of it: requesting one waits until they are saved,
// and the card says so. The review loads when the card is shown, for this
// revision only. Its discussion (P5-02) is part of it: Request changes asks
// what must change first, a review that asked for changes shows its
// revision request, resolved by one of the saved newer revisions the page
// passes (never an unsaved draft), and the comments open on demand. A review
// is not an approval; nothing here hands off, publishes or approves
export const ContentStudioReviewStatus: FC<{
  targetType: ContentStudioReviewTargetType;
  revisionId: string;
  revisionNumber: number;
  unsaved?: boolean;
  newerRevisions?: ContentStudioReviewRevisionChoice[];
}> = ({
  targetType,
  revisionId,
  revisionNumber,
  unsaved = false,
  newerRevisions = [],
}) => {
  const t = useT();
  const toaster = useToaster();
  const review = useContentStudioReviewForRevision(targetType, revisionId);
  const actions = useContentStudioReviewActions();
  const [busy, setBusy] = useState<string | null>(null);
  // the review the Request changes form is open for, if any
  const [askingFor, setAskingFor] = useState<string | null>(null);
  const revision =
    targetType === 'PACKAGE_REVISION'
      ? `${t('content_studio_revision', 'Version')} ${revisionNumber}`
      : `${t('content_studio_design_revision', 'Revision')} ${revisionNumber}`;
  const applies =
    targetType === 'PACKAGE_REVISION'
      ? t(
          'content_studio_review_applies_version',
          'This review applies to saved version'
        )
      : t(
          'content_studio_review_applies_revision',
          'This review applies to saved revision'
        );

  const run = async (key: string, write: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await write();
    } catch (err) {
      toaster.show(reviewErrorMessage(t, err), 'warning');
      // someone else got there first: show what is there now
      if (designErrorCode(err) !== 'CS_REVIEW_INTEGRITY_ERROR') {
        await actions.refresh();
      }
    } finally {
      setBusy(null);
    }
  };

  const current = review.data ?? null;
  const open = current ? contentStudioReviewActions(current.state) : [];
  const askingChanges =
    !!current && askingFor === current.id && open.includes('request-changes');

  return (
    <section
      aria-label={t('content_studio_review', 'Review')}
      data-review-target={targetType}
      data-review-revision={revisionId}
      className="flex flex-col gap-[8px] border border-newTableBorder rounded-[8px] p-[12px]"
    >
      <div className="flex flex-wrap items-center gap-[8px]">
        <div className="flex flex-col gap-[2px] flex-1 min-w-[200px]">
          <div className="font-[600]">
            {t('content_studio_review', 'Review')} · {revision}
          </div>
          {review.error ? (
            <div data-review-error="" className="text-[13px]">
              {designErrorCode(review.error) === 'CS_REVIEW_INTEGRITY_ERROR'
                ? reviewErrorMessage(t, review.error)
                : t(
                    'content_studio_review_load_error',
                    'Review status could not be loaded.'
                  )}
            </div>
          ) : review.data === undefined ? (
            <LoadingComponent width={24} height={24} />
          ) : (
            <div
              role="status"
              data-review-state={current?.state ?? 'NONE'}
              className="text-[13px]"
            >
              {current
                ? stateLabel(t, current.state)
                : t('content_studio_review_none', 'No review yet')}
            </div>
          )}
        </div>
        {review.data === null && (
          <Button
            loading={busy === 'request'}
            disabled={!!busy || unsaved}
            onClick={() =>
              run('request', () =>
                actions.requestReview(targetType, revisionId)
              )
            }
          >
            {t('content_studio_review_request', 'Request review')}
          </Button>
        )}
        {current &&
          open.map((action) => (
            <Button
              key={action}
              secondary={action !== open[0]}
              loading={busy === action}
              disabled={!!busy || askingChanges}
              aria-expanded={
                action === 'request-changes' ? askingChanges : undefined
              }
              onClick={() =>
                action === 'request-changes'
                  ? setAskingFor(current.id)
                  : run(action, () =>
                      actions.transitionReview(current.id, action)
                    )
              }
            >
              {actionLabel(t, action)}
            </Button>
          ))}
      </div>
      {current && askingChanges && (
        <ContentStudioRequestChangesForm
          review={current}
          close={() => setAskingFor(null)}
        />
      )}
      <div className="text-[12px] text-textItemBlur">
        {applies} {revisionNumber}.
        {current?.state === 'READY_FOR_APPROVAL' &&
          ` ${t(
            'content_studio_review_not_approval',
            'Ready for approval is not an approval.'
          )}`}
      </div>
      {unsaved && (
        <div className="text-[12px] text-textItemBlur" data-review-unsaved="">
          {t(
            'content_studio_review_unsaved',
            'Unsaved changes are not part of this review. Save them first to review them as a new revision.'
          )}
        </div>
      )}
      {current?.state === 'CHANGES_REQUESTED' && (
        <ContentStudioRevisionRequestPanel
          review={current}
          newerRevisions={newerRevisions}
          unsaved={unsaved}
        />
      )}
      {current && <ContentStudioReviewDiscussion review={current} />}
      {!!current?.events.length && (
        <details className="text-[12px]">
          <summary className="cursor-pointer text-textItemBlur">
            {t('content_studio_review_history', 'Review history')}
          </summary>
          <ol className="flex flex-col gap-[2px] mt-[4px]">
            {current.events.map((event) => (
              <li key={event.sequence}>
                {stateLabel(t, event.toState)}
                {!!event.actor.name && ` · ${event.actor.name}`}
                {` · ${dayjs(event.createdAt).format('MMM D, YYYY HH:mm')}`}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
};
