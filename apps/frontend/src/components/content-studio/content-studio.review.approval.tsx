'use client';

import { FC, FormEvent, useState } from 'react';
import dayjs from 'dayjs';
import { Button } from '@gitroom/react/form/button';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  CONTENT_STUDIO_APPROVAL_ACTIONS,
  CONTENT_STUDIO_APPROVAL_NOTE_MAX,
  ContentStudioApprovalAction,
  ContentStudioApprovalDecision,
  ContentStudioApprovalState,
  contentStudioApprovalActions,
  parseContentStudioApprovalNote,
} from '@gitroom/nestjs-libraries/content-studio/review/review.approval';
import type {
  ContentStudioRevisionApprovalStatus,
  ContentStudioRevisionApprovalSummary,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import type { ContentStudioRevisionApprovalState } from '@gitroom/nestjs-libraries/content-studio/review/review.approval';
import {
  ContentStudioReview,
  reviewErrorMessage,
  useContentStudioReviewActions,
  useContentStudioReviewApproval,
} from '@gitroom/frontend/components/content-studio/content-studio.reviews.api';
import { designErrorCode } from '@gitroom/frontend/components/content-studio/content-studio.designs.api';

// Approval (P5-04) of a review that is ready for approval: what was decided
// about exactly its revision, by whom and when, and the decisions the
// current state allows (from the shared rules). Approving may say why;
// refusing and withdrawing must. A decision is never edited or deleted: it
// is withdrawn, and stays in the history. Refusing approval is not
// requesting changes: a revised version needs a new review. Nothing here
// hands off or publishes

type Translate = (key: string, fallback: string) => string;

const textareaClass =
  'bg-newBgColorInner min-h-[64px] p-[10px] border-newTableBorder border rounded-[8px] text-textColor text-[14px] w-full min-w-0';
const when = (value: string) => dayjs(value).format('MMM D, YYYY HH:mm');

// Every state and decision in words: never by color alone
const stateLabel = (t: Translate, state: ContentStudioApprovalState) => {
  switch (state) {
    case 'APPROVED':
      return t('content_studio_approval_state_approved', 'Approved');
    case 'REFUSED':
      return t('content_studio_approval_state_refused', 'Refused');
    default:
      return t('content_studio_approval_state_pending', 'Pending approval');
  }
};

const decisionLabel = (
  t: Translate,
  decision: ContentStudioApprovalDecision
) => {
  switch (decision) {
    case 'APPROVED':
      return t('content_studio_approval_state_approved', 'Approved');
    case 'REFUSED':
      return t('content_studio_approval_state_refused', 'Refused');
    default:
      return t('content_studio_approval_withdrawn', 'Withdrawn');
  }
};

const actionLabel = (
  t: Translate,
  action: ContentStudioApprovalAction,
  state: ContentStudioApprovalState
) => {
  switch (action) {
    case 'approve':
      return t('content_studio_approval_approve', 'Approve');
    case 'refuse':
      return t('content_studio_approval_refuse', 'Refuse approval');
    default:
      return state === 'REFUSED'
        ? t('content_studio_approval_withdraw_refusal', 'Withdraw refusal')
        : t('content_studio_approval_withdraw_approval', 'Withdraw approval');
  }
};

const noteLabel = (t: Translate, action: ContentStudioApprovalAction) => {
  switch (action) {
    case 'approve':
      return t('content_studio_approval_note_optional', 'Note (optional)');
    case 'refuse':
      return t(
        'content_studio_approval_refuse_note',
        'Why is approval being refused?'
      );
    default:
      return t(
        'content_studio_approval_withdraw_note',
        'Why is this decision being withdrawn?'
      );
  }
};

// One decision with its note, sent once; the route is the decision
const DecisionForm: FC<{
  review: ContentStudioReview;
  action: ContentStudioApprovalAction;
  state: ContentStudioApprovalState;
  close: () => void;
}> = ({ review, action, state, close }) => {
  const t = useT();
  const toaster = useToaster();
  const actions = useContentStudioReviewActions();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const parsed = parseContentStudioApprovalNote(
    CONTENT_STUDIO_APPROVAL_ACTIONS[action],
    note
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!parsed || busy) {
      return;
    }
    setBusy(true);
    try {
      await actions.decideApproval(review.id, action, parsed.note);
      close();
    } catch (err) {
      toaster.show(reviewErrorMessage(t, err), 'warning');
      await actions.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      aria-label={actionLabel(t, action, state)}
      className="flex flex-col gap-[8px]"
    >
      <label className="flex flex-col gap-[4px] text-[12px]">
        {noteLabel(t, action)}
        <textarea
          className={textareaClass}
          value={note}
          maxLength={CONTENT_STUDIO_APPROVAL_NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {action === 'withdraw' && (
        <div className="text-[12px] text-textItemBlur">
          {t(
            'content_studio_approval_withdraw_hint',
            'The previous decision stays in the approval history.'
          )}
        </div>
      )}
      {action !== 'approve' && !parsed && (
        <div className="text-[12px] text-textItemBlur">
          {t('content_studio_approval_note_needed', 'A note is required.')}
        </div>
      )}
      <div className="flex flex-wrap gap-[8px]">
        <Button type="submit" loading={busy} disabled={!parsed || busy}>
          {actionLabel(t, action, state)}
        </Button>
        <Button secondary disabled={busy} onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
      </div>
    </form>
  );
};

export const ContentStudioReviewApproval: FC<{
  review: ContentStudioReview;
}> = ({ review }) => {
  const t = useT();
  const approval = useContentStudioReviewApproval(review.id);
  // the action whose form is open, for this review only
  const [deciding, setDeciding] = useState<{
    reviewId: string;
    action: ContentStudioApprovalAction;
  } | null>(null);
  const data =
    approval.data?.reviewId === review.id ? approval.data : undefined;
  const open = data ? contentStudioApprovalActions(data.state) : [];
  const action =
    deciding?.reviewId === review.id && open.includes(deciding.action)
      ? deciding.action
      : null;
  // the decision in force; none while pending
  const current =
    data && data.state !== 'PENDING'
      ? data.history[data.history.length - 1]
      : undefined;
  const applies =
    review.targetType === 'PACKAGE_REVISION'
      ? t(
          'content_studio_approval_applies_version',
          'This approval applies to saved version'
        )
      : t(
          'content_studio_approval_applies_revision',
          'This approval applies to saved revision'
        );

  return (
    <section
      aria-label={t('content_studio_approval', 'Approval')}
      data-review-approval=""
      className="flex flex-col gap-[8px] border-t border-newTableBorder pt-[8px]"
    >
      <h4 className="font-[600] text-[14px]">
        {t('content_studio_approval', 'Approval')}
      </h4>
      {approval.error ? (
        <div className="text-[13px]">
          {designErrorCode(approval.error) === 'CS_APPROVAL_INTEGRITY_ERROR' ||
          designErrorCode(approval.error) === 'CS_REVIEW_INTEGRITY_ERROR'
            ? reviewErrorMessage(t, approval.error)
            : t(
                'content_studio_approval_load_error',
                'The approval could not be loaded.'
              )}
        </div>
      ) : !data ? (
        <LoadingComponent width={24} height={24} />
      ) : (
        <>
          <div
            data-approval-state={data.state}
            aria-live="polite"
            className="text-[13px] font-[600]"
          >
            {stateLabel(t, data.state)}
          </div>
          {current && (
            <div className="flex flex-col gap-[4px] text-[12px]">
              <span className="text-textItemBlur">
                {[current.actor.name, when(current.createdAt)]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {current.note !== null && (
                <div
                  data-approval-note=""
                  className="whitespace-pre-wrap break-words text-[13px] border-s-[3px] border-newTableBorder ps-[8px]"
                >
                  {current.note}
                </div>
              )}
            </div>
          )}
          <div className="text-[12px] text-textItemBlur">
            {applies} {review.targetRevisionNumber}.
          </div>
          {!action && !!open.length && (
            <div className="flex flex-wrap gap-[8px]">
              {open.map((entry) => (
                <Button
                  key={entry}
                  secondary={entry !== open[0]}
                  onClick={() =>
                    setDeciding({ reviewId: review.id, action: entry })
                  }
                >
                  {actionLabel(t, entry, data.state)}
                </Button>
              ))}
            </div>
          )}
          {action && (
            <DecisionForm
              key={`${review.id}/${action}/${data.version}`}
              review={review}
              action={action}
              state={data.state}
              close={() => setDeciding(null)}
            />
          )}
          {!!data.history.length && (
            <details className="text-[12px]" data-approval-history="">
              <summary className="cursor-pointer text-textItemBlur">
                {t('content_studio_approval_history', 'Approval history')}
              </summary>
              <ol className="flex flex-col gap-[6px] mt-[4px]">
                {data.history.map((entry) => (
                  <li
                    key={entry.sequence}
                    data-approval-decision={entry.decision}
                    className="flex flex-col gap-[2px]"
                  >
                    <span>
                      {[
                        decisionLabel(t, entry.decision),
                        entry.actor.name,
                        when(entry.createdAt),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    {entry.note !== null && (
                      <span className="whitespace-pre-wrap break-words text-textItemBlur">
                        {entry.note}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
    </section>
  );
};

// Where exactly one saved revision stands (P5-05), in words
const revisionApprovalLabel = (
  t: Translate,
  state: ContentStudioRevisionApprovalState
) => {
  switch (state) {
    case 'NOT_REVIEWED':
      return t('content_studio_revision_approval_not_reviewed', 'Not reviewed');
    case 'REVIEW_REQUESTED':
      return t('content_studio_review_state_requested', 'Review requested');
    case 'IN_REVIEW':
      return t('content_studio_review_state_in_review', 'In review');
    case 'CHANGES_REQUESTED':
      return t(
        'content_studio_review_state_changes_requested',
        'Changes requested'
      );
    case 'REVIEW_CANCELLED':
      return t(
        'content_studio_revision_approval_review_cancelled',
        'Review cancelled'
      );
    case 'PENDING_APPROVAL':
      return t('content_studio_approval_state_pending', 'Pending approval');
    case 'APPROVED':
      return t('content_studio_approval_state_approved', 'Approved');
    case 'REFUSED':
      return t('content_studio_approval_state_refused', 'Refused');
  }
};

// The approval status of one saved revision exactly as the server answered
// it for that revision (P5-05): never worked out here from a decision
// history, and never by color alone. With the revision's own status, the
// decision in force says who made it and when
export const ContentStudioRevisionApprovalBadge: FC<{
  approval?:
    | ContentStudioRevisionApprovalSummary
    | ContentStudioRevisionApprovalStatus
    | null;
}> = ({ approval }) => {
  const t = useT();
  if (!approval) {
    return null;
  }
  const decision =
    'currentDecision' in approval ? approval.currentDecision : null;
  return (
    <span
      data-revision-approval={approval.state}
      className="text-[11px] font-[400] px-[8px] rounded-full border border-newTableBorder"
    >
      <span className="sr-only">
        {t('content_studio_revision_approval', 'Approval status')}:{' '}
      </span>
      {revisionApprovalLabel(t, approval.state)}
      {!!decision?.actor.name && ` · ${decision.actor.name}`}
      {!!decision && ` · ${when(decision.createdAt)}`}
    </span>
  );
};
