'use client';

import { FC, FormEvent, useState } from 'react';
import dayjs from 'dayjs';
import { Button } from '@gitroom/react/form/button';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import {
  CONTENT_STUDIO_REVIEW_COMMENT_MAX,
  CONTENT_STUDIO_REVISION_REQUEST_MAX,
  ContentStudioReviewTargetType,
  isContentStudioReviewDiscussionOpen,
  isContentStudioReviewText,
} from '@gitroom/nestjs-libraries/content-studio/review/review.state';
import {
  ContentStudioReview,
  ContentStudioReviewComment,
  reviewErrorMessage,
  useContentStudioReviewActions,
  useContentStudioReviewComments,
  useContentStudioReviewRevisionRequest,
} from '@gitroom/frontend/components/content-studio/content-studio.reviews.api';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';

// A saved revision of the same package or design as the reviewed one, as
// the revision history already shows it
export interface ContentStudioReviewRevisionChoice {
  id: string;
  revisionNumber: number;
}

type Translate = (key: string, fallback: string) => string;

const textareaClass =
  'bg-newBgColorInner min-h-[64px] p-[10px] border-newTableBorder border rounded-[8px] text-textColor text-[14px] w-full min-w-0';
const when = (value: string) => dayjs(value).format('MMM D, YYYY HH:mm');
const revisionText = (
  t: Translate,
  targetType: ContentStudioReviewTargetType,
  revisionNumber: number
) =>
  targetType === 'PACKAGE_REVISION'
    ? `${t('content_studio_revision', 'Version')} ${revisionNumber}`
    : `${t('content_studio_design_revision', 'Revision')} ${revisionNumber}`;

// One write at a time per form; a failure keeps the text and says why in
// fixed words
const useReviewWrite = () => {
  const t = useT();
  const toaster = useToaster();
  const [busy, setBusy] = useState(false);
  const run = async (write: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await write();
      return true;
    } catch (err) {
      toaster.show(reviewErrorMessage(t, err), 'warning');
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
};

// The formal request for changes: what the reviewed revision must change,
// required, as plain text. Sending it moves the review to Changes requested
// together with the request, or neither
export const ContentStudioRequestChangesForm: FC<{
  review: ContentStudioReview;
  close: () => void;
}> = ({ review, close }) => {
  const t = useT();
  const actions = useContentStudioReviewActions();
  const { busy, run } = useReviewWrite();
  const [body, setBody] = useState('');
  const valid = isContentStudioReviewText(
    body,
    CONTENT_STUDIO_REVISION_REQUEST_MAX
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) {
      return;
    }
    if (await run(() => actions.requestChanges(review.id, body))) {
      close();
    }
  };

  return (
    <form
      onSubmit={submit}
      data-request-changes-form=""
      className="flex flex-col gap-[8px]"
    >
      <label className="flex flex-col gap-[6px] text-[14px]">
        {t('content_studio_review_what_to_change', 'What needs to change?')}
        <textarea
          className={textareaClass}
          value={body}
          maxLength={CONTENT_STUDIO_REVISION_REQUEST_MAX}
          aria-describedby={`request-changes-hint-${review.id}`}
          onChange={(e) => setBody(e.target.value)}
          autoFocus
        />
      </label>
      <div
        id={`request-changes-hint-${review.id}`}
        className="text-[12px] text-textItemBlur"
      >
        {valid
          ? t(
              'content_studio_review_request_changes_hint',
              'This becomes the formal revision request for this exact revision.'
            )
          : t(
              'content_studio_review_request_changes_required',
              'Describe what needs to change before sending the request.'
            )}
      </div>
      <div className="flex flex-wrap gap-[8px]">
        <Button type="submit" loading={busy} disabled={!valid || busy}>
          {t('content_studio_review_send_request', 'Send revision request')}
        </Button>
        <Button secondary disabled={busy} onClick={close}>
          {t('content_studio_review_form_cancel', 'Cancel')}
        </Button>
      </div>
    </form>
  );
};

// Resolving names exactly one saved newer revision of the same package or
// design, chosen from the revisions the page already shows; never an
// unsaved draft, never "the latest" by itself
const ResolveRevisionRequest: FC<{
  review: ContentStudioReview;
  newerRevisions: ContentStudioReviewRevisionChoice[];
  unsaved: boolean;
}> = ({ review, newerRevisions, unsaved }) => {
  const t = useT();
  const actions = useContentStudioReviewActions();
  const { busy, run } = useReviewWrite();
  const [chosen, setChosen] = useState<string | null>(null);
  const choices = newerRevisions
    .filter(
      (revision) =>
        revision.revisionNumber > review.targetRevisionNumber &&
        revision.id !== review.targetRevisionId
    )
    .sort((a, b) => a.revisionNumber - b.revisionNumber);
  const selected = choices.find((revision) => revision.id === chosen) ?? null;

  return (
    <div className="flex flex-col gap-[8px]" data-resolve-request="">
      {unsaved && (
        <div className="text-[12px] text-textItemBlur" data-resolve-unsaved="">
          {t(
            'content_studio_review_resolve_unsaved',
            'Unsaved changes cannot resolve this request. Save them as a new revision first.'
          )}
        </div>
      )}
      {!choices.length ? (
        <div className="text-[13px]" data-resolve-none="">
          {t(
            'content_studio_review_resolve_none',
            'Create and save a newer revision before resolving this request.'
          )}
        </div>
      ) : (
        <>
          <fieldset className="flex flex-col gap-[6px] min-w-0">
            <legend className="text-[13px] mb-[4px]">
              {t(
                'content_studio_review_resolve_choose',
                'Which saved revision made these changes?'
              )}
            </legend>
            {choices.map((revision) => (
              <label
                key={revision.id}
                className="flex items-center gap-[8px] cursor-pointer text-[13px]"
              >
                <input
                  type="radio"
                  name={`resolve-${review.id}`}
                  value={revision.id}
                  checked={chosen === revision.id}
                  onChange={() => setChosen(revision.id)}
                />
                {revisionText(t, review.targetType, revision.revisionNumber)}
              </label>
            ))}
          </fieldset>
          <div>
            <Button
              loading={busy}
              disabled={!selected || busy}
              onClick={() =>
                selected &&
                run(() =>
                  actions.resolveRevisionRequest(review.id, selected.id)
                )
              }
            >
              {selected
                ? `${t(
                    'content_studio_review_mark_resolved_by',
                    'Mark resolved by'
                  )} ${revisionText(
                    t,
                    review.targetType,
                    selected.revisionNumber
                  )}`
                : t('content_studio_review_mark_resolved', 'Mark resolved')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

// The formal revision request of a review that asked for changes: who asked,
// what must change, when, and whether a newer revision resolved it. The
// review itself stays Changes requested either way
export const ContentStudioRevisionRequestPanel: FC<{
  review: ContentStudioReview;
  newerRevisions: ContentStudioReviewRevisionChoice[];
  unsaved: boolean;
}> = ({ review, newerRevisions, unsaved }) => {
  const t = useT();
  const revisionRequest = useContentStudioReviewRevisionRequest(review.id);
  const current = revisionRequest.data;

  return (
    <section
      aria-label={t(
        'content_studio_review_revision_request',
        'Revision request'
      )}
      data-revision-request={current?.status ?? 'NONE'}
      className="flex flex-col gap-[8px] border border-newTableBorder rounded-[8px] p-[10px]"
    >
      <div className="font-[600] text-[14px]">
        {t('content_studio_review_revision_request', 'Revision request')}
      </div>
      {revisionRequest.error ? (
        <div className="text-[13px]" data-revision-request-error="">
          {reviewErrorMessage(t, revisionRequest.error)}
        </div>
      ) : current === undefined ? (
        <LoadingComponent width={24} height={24} />
      ) : current === null ? (
        <div className="text-[13px] text-textItemBlur">
          {t(
            'content_studio_review_no_revision_request',
            'No revision request was recorded for this review.'
          )}
        </div>
      ) : (
        <>
          <div className="text-[12px] text-textItemBlur flex flex-wrap gap-x-[12px]">
            <span data-revision-request-status={current.status}>
              {current.status === 'OPEN'
                ? t('content_studio_review_request_open', 'Open')
                : t('content_studio_review_request_resolved', 'Resolved')}
            </span>
            {!!current.requestedBy.name && (
              <span>{current.requestedBy.name}</span>
            )}
            <span>{when(current.createdAt)}</span>
          </div>
          <div
            className="whitespace-pre-wrap break-words text-[14px]"
            data-revision-request-body=""
          >
            {current.body}
          </div>
          {current.resolution ? (
            <div className="text-[13px]" data-revision-request-resolution="">
              {`${t(
                'content_studio_review_resolved_by',
                'Resolved by'
              )} ${revisionText(
                t,
                review.targetType,
                current.resolution.revisionNumber
              )}`}
              {!!current.resolution.resolvedBy.name &&
                ` · ${current.resolution.resolvedBy.name}`}
              {` · ${when(current.resolution.resolvedAt)}`}
            </div>
          ) : (
            <ResolveRevisionRequest
              review={review}
              newerRevisions={newerRevisions}
              unsaved={unsaved}
            />
          )}
        </>
      )}
    </section>
  );
};

const CommentItem: FC<{
  review: ContentStudioReview;
  comment: ContentStudioReviewComment;
  own: boolean;
  open: boolean;
}> = ({ review, comment, own, open }) => {
  const t = useT();
  const actions = useContentStudioReviewActions();
  const { busy, run } = useReviewWrite();
  const [draft, setDraft] = useState<string | null>(null);
  const valid = isContentStudioReviewText(
    draft,
    CONTENT_STUDIO_REVIEW_COMMENT_MAX
  );

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (draft === null || !valid || busy) {
      return;
    }
    if (await run(() => actions.editComment(review.id, comment.id, draft))) {
      setDraft(null);
    }
  };

  return (
    <li className="flex flex-col gap-[4px]" data-review-comment={comment.id}>
      <div className="text-[12px] text-textItemBlur flex flex-wrap gap-x-[8px]">
        <span className="font-[600] text-textColor">
          {comment.author.name ||
            t('content_studio_review_comment_author', 'Team member')}
        </span>
        <span>{when(comment.createdAt)}</span>
        {!!comment.editedAt && (
          <span data-comment-edited="">
            {t('content_studio_review_comment_edited', 'edited')}
          </span>
        )}
      </div>
      {draft === null ? (
        <>
          <div
            className="whitespace-pre-wrap break-words text-[14px]"
            data-comment-body=""
          >
            {comment.body}
          </div>
          {own && open && (
            <div>
              <Button
                secondary
                className="!h-[28px] !px-[12px] text-[12px]"
                aria-label={t(
                  'content_studio_review_edit_comment',
                  'Edit comment'
                )}
                onClick={() => setDraft(comment.body)}
              >
                {t('content_studio_review_edit', 'Edit')}
              </Button>
            </div>
          )}
        </>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-[6px]">
          <label className="flex flex-col gap-[4px] text-[13px]">
            {t('content_studio_review_edit_comment', 'Edit comment')}
            <textarea
              className={textareaClass}
              value={draft}
              maxLength={CONTENT_STUDIO_REVIEW_COMMENT_MAX}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
          </label>
          <div className="flex flex-wrap gap-[8px]">
            <Button type="submit" loading={busy} disabled={!valid || busy}>
              {t('content_studio_review_save_comment', 'Save comment')}
            </Button>
            <Button secondary disabled={busy} onClick={() => setDraft(null)}>
              {t('content_studio_review_form_cancel', 'Cancel')}
            </Button>
          </div>
        </form>
      )}
    </li>
  );
};

// The discussion of the review: flat comments, oldest first, loaded only
// when it is opened. Any member posts; only the author edits their own; a
// cancelled review is read-only. A comment never changes the review's state
// and is about the reviewed revision, never unsaved changes
export const ContentStudioReviewDiscussion: FC<{
  review: ContentStudioReview;
}> = ({ review }) => {
  const t = useT();
  const user = useUser();
  const actions = useContentStudioReviewActions();
  const { busy, run } = useReviewWrite();
  const [shown, setShown] = useState(false);
  const [page, setPage] = useState(1);
  const [body, setBody] = useState('');
  const list = useContentStudioReviewComments(shown ? review.id : null, page);
  const open = isContentStudioReviewDiscussionOpen(review.state);
  const valid = isContentStudioReviewText(
    body,
    CONTENT_STUDIO_REVIEW_COMMENT_MAX
  );

  const post = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) {
      return;
    }
    if (await run(() => actions.postComment(review.id, body))) {
      setBody('');
    }
  };

  return (
    <section
      aria-label={t('content_studio_review_discussion', 'Discussion')}
      className="flex flex-col gap-[8px]"
    >
      <div>
        <Button
          secondary
          className="!h-[32px] !px-[14px] text-[13px]"
          aria-expanded={shown}
          onClick={() => setShown(!shown)}
        >
          {shown
            ? t('content_studio_review_hide_discussion', 'Hide discussion')
            : t('content_studio_review_show_discussion', 'Show discussion')}
        </Button>
      </div>
      {shown && (
        <>
          {list.error ? (
            <div className="text-[13px]" data-comments-error="">
              {reviewErrorMessage(t, list.error)}
            </div>
          ) : !list.data ? (
            <LoadingComponent width={24} height={24} />
          ) : !list.data.results.length ? (
            <div className="text-[13px] text-textItemBlur">
              {t('content_studio_review_no_comments', 'No comments yet.')}
            </div>
          ) : (
            <ol className="flex flex-col gap-[10px]">
              {list.data.results.map((comment) => (
                <CommentItem
                  key={comment.id}
                  review={review}
                  comment={comment}
                  own={!!user?.id && comment.author.id === user.id}
                  open={open}
                />
              ))}
            </ol>
          )}
          {!!list.data && list.data.pages > 1 && (
            <ContentStudioPager
              page={page}
              pages={list.data.pages}
              setPage={setPage}
            />
          )}
          {open ? (
            <form onSubmit={post} className="flex flex-col gap-[6px]">
              <label className="flex flex-col gap-[4px] text-[13px]">
                {t('content_studio_review_add_comment', 'Add a comment')}
                <textarea
                  className={textareaClass}
                  value={body}
                  maxLength={CONTENT_STUDIO_REVIEW_COMMENT_MAX}
                  onChange={(e) => setBody(e.target.value)}
                />
              </label>
              <div>
                <Button type="submit" loading={busy} disabled={!valid || busy}>
                  {t('content_studio_review_post_comment', 'Post comment')}
                </Button>
              </div>
            </form>
          ) : (
            <div
              className="text-[12px] text-textItemBlur"
              data-comments-closed=""
            >
              {t(
                'content_studio_review_discussion_closed',
                'This review was cancelled: its discussion is closed.'
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
};
