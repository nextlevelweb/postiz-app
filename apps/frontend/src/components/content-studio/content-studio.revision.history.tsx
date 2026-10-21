'use client';

import { FC, useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { Button } from '@gitroom/react/form/button';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  ContentStudioDraft,
  ContentStudioRevisionSummary,
  useContentStudioRevision,
  useContentStudioRevisions,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';
import { ContentStudioMediaTile } from '@gitroom/frontend/components/content-studio/content-studio.thread.editor';
import { ContentStudioReviewStatus } from '@gitroom/frontend/components/content-studio/content-studio.review.status';
import { ContentStudioRevisionApprovalBadge } from '@gitroom/frontend/components/content-studio/content-studio.review.approval';
import { ContentStudioGroundingPanel } from '@gitroom/frontend/components/content-studio/content-studio.grounding';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { CreateDesignFromPackageForm } from '@gitroom/frontend/components/content-studio/content-studio.design-package';

// One revision, read-only: its text as plain text and its Media as they are
// now, its grounding exactly as saved in it (P3-11), and the review of
// exactly this version (P5-01), never of the draft, with whether exactly
// this version is approved as the server answered for it (P5-05).
// A revision request of that review is resolved by one of the newest saved
// versions of this package (P5-02). Where the server says a handoff
// requires approval (P5-07), exactly this version can be used in a post once
// it says this version is approved; the server decides again when it is
// handed off. Any saved version, of any age, can start a new design
// (P6-01): exactly this version, never the draft, and with no approval
// asked for. Nothing here can change a revision
const RevisionView: FC<{
  packageId: string;
  revision: ContentStudioRevisionSummary;
  newerRevisions: ContentStudioRevisionSummary[];
  canRestore: boolean;
  onBack: () => void;
  onRestore: (content: ContentStudioDraft) => void;
  onUseInPost?: () => void;
}> = ({
  packageId,
  revision,
  newerRevisions,
  canRestore,
  onBack,
  onRestore,
  onUseInPost,
}) => {
  const t = useT();
  const modals = useModals();
  const detail = useContentStudioRevision(packageId, revision.id);
  const media = new Map(Object.entries(detail.data?.media || {}));
  // exactly this version as the server returned it, or nothing yet
  const saved = detail.data?.id === revision.id ? detail.data : null;
  const createDesign = () =>
    saved &&
    modals.openModal({
      title: `${t(
        'content_studio_create_design_from_version',
        'Create design from version'
      )} ${revision.revisionNumber}`,
      children: (close: () => void) => (
        <CreateDesignFromPackageForm
          version={{
            packageId,
            revisionId: saved.id,
            revisionNumber: saved.revisionNumber,
            thread: saved.content.copy.global.thread,
            media: saved.media,
          }}
          close={close}
        />
      ),
    });
  // the status of exactly this version, or none
  const approval =
    detail.data?.approval?.targetRevisionId === revision.id
      ? detail.data.approval
      : null;
  const handoffRequiresApproval =
    !!onUseInPost &&
    !!approval &&
    detail.data?.handoffApprovalRequired === true;

  return (
    <div className="flex flex-col gap-[16px]">
      <div className="flex flex-wrap items-center gap-[8px]">
        <h3 className="flex-1 font-[600] flex flex-wrap items-center gap-[8px]">
          <span>
            {t('content_studio_revision', 'Version')} {revision.revisionNumber}
          </span>
          <ContentStudioRevisionApprovalBadge approval={approval} />
        </h3>
        <Button secondary onClick={onBack}>
          {t('content_studio_back_to_history', 'Back to history')}
        </Button>
        <Button
          disabled={!canRestore || !detail.data}
          onClick={() => detail.data && onRestore(detail.data.content)}
        >
          {t('content_studio_restore_revision', 'Restore to draft')}
        </Button>
        {handoffRequiresApproval && (
          <Button disabled={!approval.approved} onClick={onUseInPost}>
            {t('content_studio_use_in_post', 'Use in Post')}
          </Button>
        )}
        <Button
          secondary
          disabled={!saved}
          aria-label={`${t(
            'content_studio_create_design_from_version',
            'Create design from version'
          )} ${revision.revisionNumber}`}
          onClick={createDesign}
        >
          {t('content_studio_create_design', 'Create design')}
        </Button>
      </div>
      {handoffRequiresApproval && !approval.approved && (
        <div className="text-textItemBlur">
          {t(
            'content_studio_handoff_approval_required',
            'This revision must be approved before handoff.'
          )}
        </div>
      )}
      <ContentStudioReviewStatus
        targetType="PACKAGE_REVISION"
        revisionId={revision.id}
        revisionNumber={revision.revisionNumber}
        newerRevisions={newerRevisions}
      />
      {detail.error ? (
        <div>
          {t('content_studio_load_error', 'Could not load Content Studio.')}
        </div>
      ) : !detail.data ? (
        <LoadingComponent width={40} height={40} />
      ) : (
        <>
          {detail.data.content.copy.global.thread.map((item, index) => (
            <section
              key={item.id}
              className="flex flex-col gap-[8px] border border-newTableBorder rounded-[8px] p-[12px]"
            >
              <div className="font-[600]">
                {index === 0
                  ? t('content_studio_main_post', 'Post')
                  : `${t('content_studio_followup', 'Follow-up')} ${index}`}
              </div>
              <div className="whitespace-pre-wrap break-words">{item.text}</div>
              {!!item.mediaIds.length && (
                <div className="flex flex-wrap gap-[8px]">
                  {item.mediaIds.map((mediaId, mediaIndex) => (
                    <ContentStudioMediaTile
                      key={`${mediaId}-${mediaIndex}`}
                      preview={media.get(mediaId)}
                    />
                  ))}
                </div>
              )}
            </section>
          ))}
          <ContentStudioGroundingPanel
            draft={detail.data.content}
            mode="revision"
          />
        </>
      )}
    </div>
  );
};

// The saved versions of a package, newest first, one server page at a time,
// each with whether exactly it is approved (P5-05): never another version's.
// Restoring copies a version into the draft; the version itself stays as it
// is. Opened for one version (a review link, P5-06), it shows exactly that
// version once the server answered for it, never another one instead.
// onUseInPost is offered for a version only where the server says a handoff
// requires approval
export const ContentStudioRevisionHistory: FC<{
  packageId: string;
  initialRevisionId?: string | null;
  canRestore: boolean;
  onRestore: (
    revisionId: string,
    content?: ContentStudioDraft
  ) => Promise<boolean>;
  onUseInPost?: (revisionId: string) => Promise<boolean>;
  close: () => void;
}> = ({
  packageId,
  initialRevisionId = null,
  canRestore,
  onRestore,
  onUseInPost,
  close,
}) => {
  const t = useT();
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<ContentStudioRevisionSummary | null>(
    null
  );
  // the version a link asks for, until it is shown or left
  const [linked, setLinked] = useState(initialRevisionId);
  const linkedDetail = useContentStudioRevision(packageId, linked);
  useEffect(() => {
    if (linked && linkedDetail.data?.id === linked) {
      setViewing(linkedDetail.data);
      setLinked(null);
    }
  }, [linked, linkedDetail.data]);
  const list = useContentStudioRevisions(packageId, page);
  // the newest saved versions (the same request as the list on page 1): the
  // ones a revision request can be resolved by
  const newest = useContentStudioRevisions(packageId, 1);

  const restore = async (revisionId: string, content?: ContentStudioDraft) => {
    if (await onRestore(revisionId, content)) {
      close();
    }
  };
  const inPost = async (revisionId: string) => {
    if (onUseInPost && (await onUseInPost(revisionId))) {
      close();
    }
  };

  if (linked) {
    return linkedDetail.error ? (
      <div className="flex flex-col gap-[12px]">
        <div role="alert">
          {t(
            'content_studio_linked_revision_error',
            'This version could not be opened.'
          )}
        </div>
        <div>
          <Button secondary onClick={() => setLinked(null)}>
            {t('content_studio_back_to_history', 'Back to history')}
          </Button>
        </div>
      </div>
    ) : (
      <LoadingComponent width={40} height={40} />
    );
  }

  if (viewing) {
    return (
      <RevisionView
        packageId={packageId}
        revision={viewing}
        newerRevisions={newest.data?.results ?? []}
        canRestore={canRestore}
        onBack={() => setViewing(null)}
        onRestore={(content) => restore(viewing.id, content)}
        onUseInPost={onUseInPost ? () => inPost(viewing.id) : undefined}
      />
    );
  }

  if (list.error) {
    return (
      <div>
        {t('content_studio_load_error', 'Could not load Content Studio.')}
      </div>
    );
  }
  if (!list.data) {
    return <LoadingComponent width={40} height={40} />;
  }
  if (!list.data.results.length) {
    return (
      <div>
        {t(
          'content_studio_no_revisions',
          'No versions yet. Save a version to keep this draft.'
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[12px]">
      <ul className="flex flex-col gap-[8px]">
        {list.data.results.map((revision) => (
          <li
            key={revision.id}
            className="flex flex-wrap items-center gap-[8px] border border-newTableBorder rounded-[8px] p-[12px]"
          >
            <div className="flex flex-col gap-[2px] flex-1 min-w-[200px]">
              <div className="font-[600] flex flex-wrap items-center gap-[8px]">
                <span>
                  {t('content_studio_revision', 'Version')}{' '}
                  {revision.revisionNumber}
                </span>
                <ContentStudioRevisionApprovalBadge
                  approval={revision.approval}
                />
              </div>
              <div className="text-[12px] text-textItemBlur flex flex-wrap gap-x-[12px]">
                <span>
                  {dayjs(revision.createdAt).format('MMM D, YYYY HH:mm')}
                </span>
                {!!revision.createdBy?.name && (
                  <span>{revision.createdBy.name}</span>
                )}
                <span>
                  {revision.origin === 'handoff'
                    ? t('content_studio_origin_handoff', 'Used in a post')
                    : t('content_studio_origin_manual', 'Saved version')}
                </span>
                <span>
                  {t('content_studio_from_draft_version', 'From draft version')}{' '}
                  {revision.sourceDraftVersion}
                </span>
              </div>
            </div>
            <Button
              secondary
              aria-label={`${t('content_studio_view_revision', 'View')} ${
                revision.revisionNumber
              }`}
              onClick={() => setViewing(revision)}
            >
              {t('content_studio_view_revision', 'View')}
            </Button>
            <Button
              secondary
              disabled={!canRestore}
              aria-label={`${t(
                'content_studio_restore_revision',
                'Restore to draft'
              )} ${revision.revisionNumber}`}
              onClick={() => restore(revision.id)}
            >
              {t('content_studio_restore_revision', 'Restore to draft')}
            </Button>
          </li>
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
