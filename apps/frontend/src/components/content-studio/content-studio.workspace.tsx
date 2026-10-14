'use client';

import { FC, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import {
  ContentStudioDraft,
  ContentStudioMediaPreview,
  ContentStudioPackageDetail,
  ContentStudioRequestError,
  useContentStudioPackage,
  useContentStudioWorkspaceApi,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import {
  ContentStudioAutosaveError,
  useContentStudioAutosave,
} from '@gitroom/frontend/components/content-studio/content-studio.autosave';
import { ContentStudioThreadEditor } from '@gitroom/frontend/components/content-studio/content-studio.thread.editor';
import { ContentStudioRevisionHistory } from '@gitroom/frontend/components/content-studio/content-studio.revision.history';
import {
  aiWritingErrorMessage,
  ContentStudioAIProposal,
  ContentStudioAIWritingDialog,
  ContentStudioAIWritingRequest,
  ContentStudioAIWritingTarget,
  useContentStudioAIWritingApi,
} from '@gitroom/frontend/components/content-studio/content-studio.ai-writing';
import {
  applyContentStudioAIProposal,
  ContentStudioAIProposalReview,
  isContentStudioAIProposalCurrent,
} from '@gitroom/frontend/components/content-studio/content-studio.ai-proposal';

const HANDOFF_ID = /^[0-9a-f]{64}$/;

// A copy of a revision's content in the draft's own key order, so it shares
// nothing with the revision it came from
const draftFrom = (content: ContentStudioDraft): ContentStudioDraft => ({
  schemaVersion: 1,
  copy: {
    global: {
      thread: content.copy.global.thread.map((item) => ({
        id: item.id,
        text: item.text,
        mediaIds: [...item.mediaIds],
      })),
    },
  },
});

interface PackageMeta {
  name: string;
  archived: boolean;
  latestRevisionNumber: number;
}

// The editor of one package. The draft is seeded once from the server and then
// lives in the autosave controller; the server's answers to saves keep its
// version. Saving a version, restoring one, "Use in Post" and AI writing first
// wait until the latest draft is saved, with the editor locked so nothing
// changes under them. Leaving the page within 1500 ms of an edit can lose
// that edit
export const ContentStudioWorkspace: FC<{ packageId: string }> = ({
  packageId,
}) => {
  const t = useT();
  const router = useRouter();
  const toaster = useToaster();
  const modals = useModals();
  const api = useContentStudioWorkspaceApi();
  const aiWriting = useContentStudioAIWritingApi();
  const detail = useContentStudioPackage(packageId);
  const save = useCallback(
    (draft: ContentStudioDraft, base: number) =>
      api.saveDraft(packageId, base, draft),
    [api, packageId]
  );
  const autosave = useContentStudioAutosave(save);
  const { controller } = autosave;
  const [media, setMedia] = useState(
    new Map<string, ContentStudioMediaPreview | null>()
  );
  const [meta, setMeta] = useState<PackageMeta | null>(null);
  const seeded = useRef<string | null>(null);
  const [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);
  // an AI suggestion under review; it lives here only and is never saved
  // until it is accepted
  const [proposal, setProposal] = useState<ContentStudioAIProposal | null>(
    null
  );

  const seed = useCallback(
    (data: ContentStudioPackageDetail) => {
      controller.reset(data.draft, data.draftVersion, !!data.archivedAt);
      setMedia(new Map(Object.entries(data.media || {})));
      setMeta({
        name: data.name,
        archived: !!data.archivedAt,
        latestRevisionNumber: data.latestRevisionNumber,
      });
    },
    [controller]
  );

  // only an answer fetched for this visit seeds the editor, and only once:
  // later revalidations never replace what the user is typing
  useEffect(() => {
    const fresh = detail.fresh.current;
    if (fresh && fresh.id === packageId && seeded.current !== packageId) {
      seeded.current = packageId;
      seed(fresh);
    }
  }, [detail.data, detail.isValidating, packageId, seed]);

  // the server's current state replaces the local one
  const reload = useCallback(async () => {
    seed(await api.getPackage(packageId));
  }, [api, packageId, seed]);

  const showReload = useCallback(
    (key: string, fallback: string) => {
      toaster.show(t(key, fallback), 'warning');
      reload().catch(() =>
        toaster.show(
          t('content_studio_load_error', 'Could not load Content Studio.'),
          'warning'
        )
      );
    },
    [reload, toaster, t]
  );

  // archived by someone else while editing: read-only from now on
  useEffect(() => {
    if (
      autosave.error instanceof ContentStudioRequestError &&
      autosave.error.code === 'CS_PACKAGE_ARCHIVED'
    ) {
      showReload(
        'content_studio_error_package_archived',
        'This package is archived.'
      );
    }
  }, [autosave.error]);

  const edit = useCallback(
    (update: (draft: ContentStudioDraft) => ContentStudioDraft) =>
      !lockedRef.current && controller.change(update),
    [controller]
  );
  const getDraft = useCallback(() => controller.currentDraft, [controller]);
  const addPreviews = useCallback(
    (previews: ContentStudioMediaPreview[]) =>
      setMedia((current) => {
        const next = new Map(current);
        previews.forEach((preview) => next.set(preview.id, preview));
        return next;
      }),
    []
  );

  // Fixed messages only: never the server's text or ids
  const explain = useCallback(
    (err: unknown, fallback: string) => {
      if (err instanceof ContentStudioAutosaveError) {
        toaster.show(
          err.state === 'conflict'
            ? t(
                'content_studio_conflict',
                'This package changed elsewhere. Reload the server version before continuing.'
              )
            : t(
                'content_studio_save_error',
                'Could not save this Content Studio draft.'
              ),
          'warning'
        );
        return;
      }
      const code =
        err instanceof ContentStudioRequestError ? err.code : undefined;
      switch (code) {
        case 'CS_DRAFT_VERSION_CONFLICT':
          controller.markConflict();
          toaster.show(
            t(
              'content_studio_conflict',
              'This package changed elsewhere. Reload the server version before continuing.'
            ),
            'warning'
          );
          return;
        case 'CS_PACKAGE_CHANGED':
          api.refreshRevisions(packageId);
          showReload(
            'content_studio_package_changed',
            'This package changed while saving. It was reloaded.'
          );
          return;
        case 'CS_PACKAGE_ARCHIVED':
          showReload(
            'content_studio_error_package_archived',
            'This package is archived.'
          );
          return;
        case 'CS_DRAFT_EMPTY_ITEM':
          toaster.show(
            t(
              'content_studio_empty_item',
              'Every post in the thread needs text or media before saving a version.'
            ),
            'warning'
          );
          return;
        case 'CS_MEDIA_UNAVAILABLE':
          toaster.show(
            t(
              'content_studio_media_not_ready',
              'Some media is not ready or is no longer available.'
            ),
            'warning'
          );
          return;
        case 'CS_NOT_FOUND':
          toaster.show(
            t(
              'content_studio_error_not_found',
              'This Content Studio item could not be found.'
            ),
            'warning'
          );
          return;
        default:
          toaster.show(fallback, 'warning');
      }
    },
    [api, controller, packageId, showReload, toaster, t]
  );

  // One action at a time, with the editor locked from before the flush until
  // the action ends (or for good, when it navigates away)
  const runAction = useCallback(
    async (action: () => Promise<'navigating' | void>, fallback: string) => {
      if (lockedRef.current) {
        return false;
      }
      lockedRef.current = true;
      setLocked(true);
      let navigating = false;
      let done = false;
      try {
        navigating = (await action()) === 'navigating';
        done = true;
      } catch (err) {
        explain(err, fallback);
      } finally {
        if (!navigating) {
          lockedRef.current = false;
          setLocked(false);
        }
      }
      return done;
    },
    [explain]
  );

  const saveVersion = useCallback(
    () =>
      runAction(async () => {
        await controller.flush();
        const result = await api.createRevision(
          packageId,
          controller.currentVersion,
          'manual'
        );
        toaster.show(
          result.created
            ? t('content_studio_version_saved', 'Version saved.')
            : t(
                'content_studio_version_unchanged',
                'No changes since the latest version.'
              ),
          'success'
        );
        setMeta(
          (current) =>
            current && {
              ...current,
              latestRevisionNumber: Math.max(
                current.latestRevisionNumber,
                result.revision.revisionNumber
              ),
            }
        );
        api.refreshRevisions(packageId);
        api.refreshPackageLists();
      }, t('content_studio_version_error', 'Could not save this version.')),
    [api, controller, packageId, runAction, toaster, t]
  );

  // An active package hands over a revision of its saved draft (the server
  // reuses the latest one when nothing changed). An archived package can only
  // hand over its latest existing revision
  const prepareInPost = useCallback(
    () =>
      runAction(async () => {
        let revisionId: string | undefined;
        if (meta?.archived) {
          revisionId = (await api.listRevisions(packageId, 1)).results[0]?.id;
          if (!revisionId) {
            throw new Error('No revision');
          }
        } else {
          await controller.flush();
          const result = await api.createRevision(
            packageId,
            controller.currentVersion,
            'handoff'
          );
          revisionId = result.revision.id;
          setMeta(
            (current) =>
              current && {
                ...current,
                latestRevisionNumber: Math.max(
                  current.latestRevisionNumber,
                  result.revision.revisionNumber
                ),
              }
          );
        }
        const handoff = await api.createHandoff(packageId, revisionId);
        if (!HANDOFF_ID.test(handoff.id)) {
          throw new Error('Unexpected handoff');
        }
        router.push(`/launches?handoff=${handoff.id}`);
        return 'navigating';
      }, t('content_studio_prepare_post_error', 'Could not prepare this post.')),
    [api, controller, meta?.archived, packageId, router, runAction, t]
  );

  // Copies a revision into the draft and saves it on the current version.
  // The revision itself never changes
  const restore = useCallback(
    async (revisionId: string, content?: ContentStudioDraft) => {
      if (
        !(await deleteDialog(
          t(
            'content_studio_restore_revision_confirm',
            'Restore this version into the current draft? The revision itself will remain unchanged.'
          ),
          t('content_studio_restore', 'Restore'),
          t('content_studio_restore_revision', 'Restore to draft'),
          t('cancel', 'Cancel')
        ))
      ) {
        return false;
      }
      return runAction(async () => {
        await controller.flush();
        const source =
          content || (await api.getRevision(packageId, revisionId)).content;
        if (!controller.change(() => draftFrom(source))) {
          throw new Error('Read-only draft');
        }
        await controller.flush();
        toaster.show(
          t('content_studio_revision_restored', 'Version restored to draft.'),
          'success'
        );
        // the current state of its Media
        await reload().catch(() => undefined);
      }, t('content_studio_restore_error', 'Could not restore this version.'));
    },
    [api, controller, packageId, reload, runAction, toaster, t]
  );

  // AI writing asks about the saved draft: the latest edit is saved first,
  // and the request names the version that save returned. A save that fails
  // or conflicts asks nothing. The answer is a suggestion for review only
  const generate = useCallback(
    async (request: ContentStudioAIWritingRequest) => {
      let generated = false;
      await runAction(async () => {
        await controller.flush();
        const base = controller.currentVersion;
        let result: ContentStudioAIProposal;
        try {
          result = await aiWriting.propose(packageId, base, request);
        } catch (err) {
          const message = aiWritingErrorMessage(t, err);
          if (!message) {
            throw err;
          }
          if (
            err instanceof ContentStudioRequestError &&
            err.code === 'CS_DRAFT_VERSION_CONFLICT'
          ) {
            controller.markConflict();
          }
          toaster.show(message, 'warning');
          return;
        }
        const draft = controller.currentDraft;
        if (
          result?.baseDraftVersion !== base ||
          !draft ||
          !isContentStudioAIProposalCurrent(result, draft, base, true) ||
          (result.proposal.type === 'item') !== !!request.itemId
        ) {
          throw new Error('Unexpected suggestion');
        }
        setProposal(result);
        generated = true;
      }, t('content_studio_ai_writing_error_failed', 'Could not generate a suggestion.'));
      return generated;
    },
    [aiWriting, controller, packageId, runAction, t, toaster]
  );

  const openAIWriting = useCallback(
    (target: ContentStudioAIWritingTarget) => {
      modals.openModal({
        title: t('content_studio_ai_writing', 'AI writing'),
        children: (close) => (
          <ContentStudioAIWritingDialog
            target={target}
            onGenerate={generate}
            close={close}
          />
        ),
      });
    },
    [modals, generate, t]
  );

  // Puts the suggested texts into the draft and saves it the usual way, in
  // one save. Only a suggestion for exactly the current saved draft is
  // applied; it is never merged into a newer one
  const acceptProposal = useCallback(
    () =>
      runAction(async () => {
        const draft = controller.currentDraft;
        const snapshot = controller.snapshot();
        if (
          !proposal ||
          !draft ||
          !isContentStudioAIProposalCurrent(
            proposal,
            draft,
            snapshot.version,
            snapshot.state === 'idle'
          )
        ) {
          return;
        }
        if (
          !controller.change((latest) =>
            applyContentStudioAIProposal(latest, proposal)
          )
        ) {
          throw new Error('Read-only draft');
        }
        setProposal(null);
        await controller.flush();
      }, t('content_studio_save_error', 'Could not save this Content Studio draft.')),
    [controller, proposal, runAction, t]
  );

  const openHistory = useCallback(() => {
    modals.openModal({
      title: t('content_studio_history', 'History'),
      children: (close) => (
        <ContentStudioRevisionHistory
          packageId={packageId}
          canRestore={
            !controller.snapshot().readOnly &&
            controller.snapshot().state !== 'conflict'
          }
          onRestore={restore}
          close={close}
        />
      ),
    });
  }, [modals, packageId, controller, restore, t]);

  if (detail.error && !meta) {
    const missing =
      detail.error instanceof ContentStudioRequestError &&
      detail.error.code === 'CS_NOT_FOUND';
    return (
      <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col gap-[16px]">
        <Link href="/content-studio" className="hover:underline w-fit">
          {t('content_studio_back', 'Back to Content Studio')}
        </Link>
        <div>
          {missing
            ? t(
                'content_studio_package_not_found',
                'Content Studio package not found.'
              )
            : t('content_studio_load_error', 'Could not load Content Studio.')}
        </div>
        {!missing && (
          <div>
            <Button secondary onClick={() => detail.mutate()}>
              {t('content_studio_retry', 'Try again')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (!meta || !autosave.draft) {
    return <LoadingComponent />;
  }

  const conflict = autosave.state === 'conflict';
  const aiDisabled = meta.archived || conflict || locked;
  const stateLabel = meta.archived
    ? t('content_studio_read_only_archived', 'Archived - read only')
    : {
        idle: t('content_studio_saved', 'Saved'),
        dirty: t('content_studio_unsaved', 'Unsaved changes'),
        saving: t('content_studio_saving', 'Saving...'),
        conflict: t('content_studio_state_conflict', 'Conflict'),
        error: t('content_studio_state_error', 'Not saved'),
      }[autosave.state];

  return (
    <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col gap-[16px] min-w-0">
      <div className="flex flex-wrap items-center gap-[12px]">
        <Link href="/content-studio" className="hover:underline">
          {t('content_studio_back', 'Back to Content Studio')}
        </Link>
        <h2 className="flex-1 min-w-[200px] text-[20px] font-[600] break-words">
          {meta.name}
        </h2>
        <span role="status" aria-live="polite" className="text-textItemBlur">
          {stateLabel}
        </span>
        <span className="text-textItemBlur">
          {t('content_studio_revisions', 'Revisions')}:{' '}
          {meta.latestRevisionNumber}
        </span>
        <div className="flex flex-wrap gap-[8px]">
          <Button secondary onClick={openHistory}>
            {t('content_studio_history', 'History')}
          </Button>
          <Button
            secondary
            disabled={aiDisabled}
            onClick={() => openAIWriting({ type: 'thread' })}
          >
            {t('content_studio_ai_thread', 'AI thread')}
          </Button>
          <Button
            secondary
            loading={locked}
            disabled={meta.archived || conflict || locked}
            onClick={saveVersion}
          >
            {t('content_studio_save_version', 'Save version')}
          </Button>
          <Button
            loading={locked}
            disabled={
              conflict ||
              locked ||
              (meta.archived && meta.latestRevisionNumber === 0)
            }
            onClick={prepareInPost}
          >
            {t('content_studio_use_in_post', 'Use in Post')}
          </Button>
        </div>
      </div>

      {meta.archived && meta.latestRevisionNumber === 0 && (
        <div className="text-textItemBlur">
          {t(
            'content_studio_archived_no_revision',
            'This archived package has no saved version to use in a post.'
          )}
        </div>
      )}

      {conflict && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-[12px] border border-red-400 rounded-[8px] p-[12px]"
        >
          <div className="flex-1 min-w-[200px]">
            {t(
              'content_studio_conflict',
              'This package changed elsewhere. Reload the server version before continuing.'
            )}
          </div>
          <Button
            onClick={() =>
              reload().catch(() =>
                toaster.show(
                  t(
                    'content_studio_load_error',
                    'Could not load Content Studio.'
                  ),
                  'warning'
                )
              )
            }
          >
            {t('content_studio_reload_package', 'Reload package')}
          </Button>
        </div>
      )}

      {autosave.state === 'error' && !meta.archived && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-[12px] border border-red-400 rounded-[8px] p-[12px]"
        >
          <div className="flex-1 min-w-[200px]">
            {t(
              'content_studio_save_error',
              'Could not save this Content Studio draft.'
            )}
          </div>
          <Button onClick={() => controller.retry()}>
            {t('content_studio_retry_save', 'Retry save')}
          </Button>
        </div>
      )}

      {proposal && (
        <ContentStudioAIProposalReview
          proposal={proposal}
          draft={autosave.draft}
          current={isContentStudioAIProposalCurrent(
            proposal,
            autosave.draft,
            autosave.version,
            autosave.state === 'idle'
          )}
          busy={locked}
          onAccept={acceptProposal}
          onDiscard={() => setProposal(null)}
        />
      )}

      <ContentStudioThreadEditor
        draft={autosave.draft}
        media={media}
        disabled={meta.archived || locked}
        edit={edit}
        getDraft={getDraft}
        addPreviews={addPreviews}
        itemActions={(item, label) => (
          <Button
            secondary
            disabled={aiDisabled}
            aria-label={`${t(
              'content_studio_ai_writing',
              'AI writing'
            )} ${label}`}
            onClick={() =>
              openAIWriting({
                type: 'item',
                itemId: item.id,
                label,
                hasText: !!item.text.trim(),
              })
            }
          >
            {t('content_studio_ai', 'AI')}
          </Button>
        )}
      />
    </div>
  );
};
