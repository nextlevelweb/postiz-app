'use client';

import { FC, ReactNode, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@gitroom/react/form/button';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { formatDate } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';
import { parseContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { designErrorCode } from '@gitroom/frontend/components/content-studio/content-studio.designs.api';
import { ContentStudioDesignLayerCopy } from '@gitroom/frontend/components/content-studio/content-studio.design.editor';
import {
  ContentStudioDesignEditorTarget,
  useConfirmDiscard,
  useContentStudioDesignEditor,
} from '@gitroom/frontend/components/content-studio/content-studio.design.editing';
import {
  DesignHistory,
  DesignRevisionView,
  ShownRevision,
} from '@gitroom/frontend/components/content-studio/content-studio.design.workspace';
import {
  designTemplateErrorMessage,
  useContentStudioDesignTemplate,
  useContentStudioDesignTemplateActions,
  useContentStudioDesignTemplateRevision,
  useContentStudioDesignTemplateRevisions,
} from '@gitroom/frontend/components/content-studio/content-studio.design-templates.api';
import {
  TEMPLATE_LIBRARY_PATH,
  TemplateDetailsForm,
  UseTemplateForm,
  useTemplateCommands,
} from '@gitroom/frontend/components/content-studio/content-studio.design-templates';

// One template of the organization: its current revision (or an opened older
// one), its history, and editing exactly like a design: the same pages,
// layers, canvas, inspector and editor, a draft in this browser tab only,
// saved as the template's next immutable revision over the revision the edit
// started from (a revision saved meanwhile is a conflict that keeps the
// draft). Only the current revision of an active template is edited; older
// revisions and archived templates are read-only. A template is never
// rendered here: a design made from it is. Details (name and description)
// change without a revision

// The document, or null when it does not parse as Design Document v1
const parseTemplate = (content: unknown) => {
  try {
    return parseContentStudioDesignDocument(content);
  } catch {
    return null;
  }
};

const NotLoaded: FC<{ children: ReactNode; retry?: () => void }> = ({
  children,
  retry,
}) => {
  const t = useT();
  return (
    <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col items-center gap-[12px] py-[40px] min-w-0">
      <div role="alert">{children}</div>
      {retry && (
        <Button secondary onClick={retry}>
          {t('content_studio_retry', 'Try again')}
        </Button>
      )}
      <Link href={TEMPLATE_LIBRARY_PATH} className="underline">
        {t('content_studio_back_to_templates', 'Back to templates')}
      </Link>
    </div>
  );
};

export const ContentStudioDesignTemplateWorkspace: FC<{
  templateId: string;
}> = ({ templateId }) => {
  const t = useT();
  const modals = useModals();
  const router = useRouter();
  const detail = useContentStudioDesignTemplate(templateId);
  const [historyPage, setHistoryPage] = useState(1);
  const history = useContentStudioDesignTemplateRevisions(
    templateId,
    historyPage
  );
  const [viewing, setViewing] = useState<{
    id: string;
    revisionNumber: number;
  } | null>(null);
  const opened = useContentStudioDesignTemplateRevision(
    templateId,
    viewing?.id ?? null
  );
  const [pageId, setPageId] = useState<string | null>(null);
  const commands = useTemplateCommands();
  const { saveTemplateRevision } = useContentStudioDesignTemplateActions();
  // the draft is saved as the template's next revision
  const target = useMemo<ContentStudioDesignEditorTarget>(
    () => ({
      save: saveTemplateRevision,
      conflictCode: 'CS_DESIGN_TEMPLATE_REVISION_CONFLICT',
      savedMessage: (revisionNumber) =>
        `${t(
          'content_studio_template_saved_as',
          'Template saved as Revision'
        )} ${revisionNumber}.`,
      errorMessage: (error) => designTemplateErrorMessage(t, error),
    }),
    [saveTemplateRevision, t]
  );
  const editor = useContentStudioDesignEditor(templateId, target);
  // a copied layer, in memory only: gone when this workspace is left
  const [clipboard, setClipboard] =
    useState<ContentStudioDesignLayerCopy | null>(null);
  const confirmDiscard = useConfirmDiscard();

  const currentRevision = detail.data?.currentRevision;
  const currentDocument = useMemo(
    () => (currentRevision ? parseTemplate(currentRevision.content) : null),
    [currentRevision]
  );
  const openedDocument = useMemo(
    () => (opened.data ? parseTemplate(opened.data.content) : null),
    [opened.data]
  );

  if (detail.error) {
    const code = designErrorCode(detail.error);
    return code === 'CS_NOT_FOUND' ? (
      <NotLoaded>
        {t('content_studio_template_not_found', 'Template not found.')}
      </NotLoaded>
    ) : code === 'CS_DESIGN_TEMPLATE_INTEGRITY_ERROR' ? (
      <NotLoaded>
        {t(
          'content_studio_template_error_integrity',
          'Stored template data could not be read safely.'
        )}
      </NotLoaded>
    ) : (
      <NotLoaded retry={() => detail.mutate()}>
        {t(
          'content_studio_template_load_error',
          'Template could not be loaded.'
        )}
      </NotLoaded>
    );
  }
  if (!detail.data || !currentRevision) {
    return <LoadingComponent />;
  }
  if (!currentDocument) {
    return (
      <NotLoaded>
        {t(
          'content_studio_template_error_integrity',
          'Stored template data could not be read safely.'
        )}
      </NotLoaded>
    );
  }

  const template = detail.data;
  const archived = !!template.archivedAt;
  const shown: ShownRevision = viewing
    ? { ...viewing, historical: true }
    : {
        id: currentRevision.id,
        revisionNumber: currentRevision.revisionNumber,
        historical: false,
      };
  const busy = commands.busy[template.id];
  const openedCode = designErrorCode(opened.error);
  // only the current revision of an active template is ever edited
  const editing = !!editor.document && !shown.historical && !archived;
  const shownCurrent =
    editing && editor.document ? editor.document : currentDocument;
  // leaving the edit for anything that replaces the draft asks first
  const leaveEdit = async () => {
    if (!editor.state) {
      return true;
    }
    if (editor.saving || !(await confirmDiscard(editor.dirty))) {
      return false;
    }
    editor.discard();
    return true;
  };
  const edit = editing
    ? {
        editor,
        clipboard,
        setClipboard,
        onCancel: () => {
          void leaveEdit();
        },
        onReloadLatest: async () => {
          if (
            !(await deleteDialog(
              t(
                'content_studio_design_reload_hint',
                'Your unsaved changes will be discarded.'
              ),
              t('content_studio_reload_latest', 'Reload latest'),
              t(
                'content_studio_design_reload_title',
                'Reload latest revision?'
              ),
              t('cancel', 'Cancel')
            ))
          ) {
            return;
          }
          editor.discard();
          await Promise.all([detail.mutate(), history.mutate()]);
        },
      }
    : null;
  // a new design from exactly the shown revision (saved, never the draft)
  const openUseRevision = () =>
    modals.openModal({
      title: t('content_studio_use_template', 'Use template'),
      children: (close: () => void) => (
        <UseTemplateForm
          choice={{
            source: 'organization',
            templateId: template.id,
            revisionId: shown.id,
          }}
          defaultName={template.name}
          close={close}
        />
      ),
    });

  const view = (document: typeof currentDocument) => (
    <DesignRevisionView
      key={shown.id}
      revision={shown}
      document={document}
      pageId={pageId}
      setPageId={setPageId}
      render={null}
      editLabel={t('content_studio_template_edit', 'Edit template')}
      canEdit={!archived && !shown.historical}
      onBeginEdit={() => editor.begin(currentRevision, currentDocument)}
      edit={shown.historical ? null : edit}
    />
  );

  return (
    <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col gap-[20px] min-w-0">
      <div className="flex flex-wrap items-start gap-[12px]">
        <div className="flex flex-col gap-[6px] flex-1 min-w-[200px]">
          <Link
            href={TEMPLATE_LIBRARY_PATH}
            className="text-[13px] text-textItemBlur hover:underline"
            onClick={async (event) => {
              if (!editor.state) {
                return;
              }
              event.preventDefault();
              if (await leaveEdit()) {
                router.push(TEMPLATE_LIBRARY_PATH);
              }
            }}
          >
            {t('content_studio_templates', 'Templates')}
          </Link>
          <h1 className="text-[20px] font-[600] break-words">
            {template.name}
          </h1>
          {!!template.description && (
            <div className="text-[13px] break-words">
              {template.description}
            </div>
          )}
          <div className="flex flex-wrap gap-x-[16px] gap-y-[4px] text-[12px] text-textItemBlur">
            <span className="px-[8px] rounded-full border border-newTableBorder">
              {t('content_studio_template_organization', 'Organization')}
            </span>
            <span className="px-[8px] rounded-full border border-newTableBorder">
              {archived
                ? t('content_studio_archived', 'Archived')
                : t('content_studio_active', 'Active')}
            </span>
            <span>
              {t('content_studio_design_revision', 'Revision')}{' '}
              {shown.revisionNumber}
              {shown.historical &&
                ` · ${t('content_studio_design_historical', 'Historical')}`}
            </span>
            <span>
              {t('content_studio_updated', 'Updated')}:{' '}
              {formatDate(template.updatedAt)}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-[8px]">
          {!archived && (
            <Button disabled={!!editor.state} onClick={openUseRevision}>
              {shown.historical
                ? t('content_studio_template_use_revision', 'Use this revision')
                : t('content_studio_use_template', 'Use template')}
            </Button>
          )}
          {archived ? (
            <Button
              secondary
              loading={busy === 'restore'}
              disabled={!!busy}
              onClick={() => commands.restore(template)}
            >
              {t('content_studio_restore', 'Restore')}
            </Button>
          ) : (
            <>
              <Button
                secondary
                disabled={!!busy || !!editor.state}
                onClick={() =>
                  modals.openModal({
                    title: t(
                      'content_studio_template_edit_details',
                      'Edit details'
                    ),
                    children: (close: () => void) => (
                      <TemplateDetailsForm template={template} close={close} />
                    ),
                  })
                }
              >
                {t('content_studio_template_edit_details', 'Edit details')}
              </Button>
              <Button
                secondary
                loading={busy === 'archive'}
                disabled={!!busy || editor.saving}
                onClick={async () => {
                  if (await leaveEdit()) {
                    await commands.archive(template);
                  }
                }}
              >
                {t('content_studio_archive', 'Archive')}
              </Button>
            </>
          )}
        </div>
      </div>

      {shown.historical ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-[12px] border border-newTableBorder rounded-[8px] p-[12px]"
        >
          <div className="flex flex-col gap-[2px] flex-1 min-w-[200px]">
            <div className="font-[600]">
              {t('content_studio_design_viewing_revision', 'Viewing revision')}{' '}
              {shown.revisionNumber}
            </div>
            <div className="text-[13px] text-textItemBlur">
              {t(
                'content_studio_design_historical_read_only',
                'Read-only historical revision'
              )}
            </div>
          </div>
          <Button secondary onClick={() => setViewing(null)}>
            {t('content_studio_design_back_to_current', 'Back to current')}
          </Button>
        </div>
      ) : editing ? (
        <div role="status" className="text-[13px]">
          {t(
            'content_studio_template_editing',
            'Editing the current template revision. Unsaved changes stay in this browser tab until you save.'
          )}
        </div>
      ) : (
        <div role="status" className="text-[13px] text-textItemBlur">
          {archived
            ? t(
                'content_studio_template_archived_read_only',
                'This template is archived: restore it to edit or use it.'
              )
            : t(
                'content_studio_template_read_only',
                'This revision is read-only until you edit the template.'
              )}
        </div>
      )}

      {!shown.historical ? (
        view(shownCurrent)
      ) : opened.error ? (
        <div role="alert">
          {openedCode === 'CS_NOT_FOUND'
            ? t(
                'content_studio_template_revision_missing',
                'This template revision is no longer available.'
              )
            : t(
                'content_studio_template_error_integrity',
                'Stored template data could not be read safely.'
              )}
        </div>
      ) : !opened.data ? (
        <LoadingComponent width={40} height={40} />
      ) : !openedDocument || opened.data.id !== shown.id ? (
        <div role="alert">
          {t(
            'content_studio_template_error_integrity',
            'Stored template data could not be read safely.'
          )}
        </div>
      ) : (
        view(openedDocument)
      )}

      <section className="flex flex-col gap-[12px] min-w-0">
        <h2 className="text-[16px] font-[600]">
          {t('content_studio_design_history', 'Revision history')}
        </h2>
        <DesignHistory
          history={history}
          latestRevisionNumber={template.latestRevisionNumber}
          shownId={shown.id}
          page={historyPage}
          setPage={setHistoryPage}
          disabled={editor.saving}
          onView={async (revision) => {
            if (!(await leaveEdit())) {
              return;
            }
            setViewing(
              revision.id === currentRevision.id
                ? null
                : { id: revision.id, revisionNumber: revision.revisionNumber }
            );
          }}
        />
      </section>
    </div>
  );
};
