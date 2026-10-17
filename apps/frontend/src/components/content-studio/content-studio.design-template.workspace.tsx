'use client';

import { FC, ReactNode, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@gitroom/react/form/button';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { formatDate } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';
import {
  ContentStudioDesignDocumentV1,
  ContentStudioDesignLayer,
  ContentStudioDesignPage,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioDesignTemplateGuidanceV1,
  ContentStudioDesignTemplateSlot,
  DESIGN_TEMPLATE_SLOT_DESCRIPTION_MAX,
  DESIGN_TEMPLATE_SLOT_LABEL_MAX,
  DESIGN_TEMPLATE_SLOTS_MAX,
  parseContentStudioDesignTemplateGuidance,
} from '@gitroom/nestjs-libraries/content-studio/design/design.template.guidance';
import { ContentStudioRequestError } from '@gitroom/frontend/components/content-studio/content-studio.api';
import { designErrorCode } from '@gitroom/frontend/components/content-studio/content-studio.designs.api';
import { ContentStudioDesignLayerCopy } from '@gitroom/frontend/components/content-studio/content-studio.design.editor';
import {
  ContentStudioDesignEditorTarget,
  useConfirmDiscard,
  useContentStudioDesignEditor,
} from '@gitroom/frontend/components/content-studio/content-studio.design.editing';
import {
  designLayerTypeLabel,
  DesignHistory,
  DesignRevisionView,
  ShownRevision,
} from '@gitroom/frontend/components/content-studio/content-studio.design.workspace';
import {
  designTemplateErrorMessage,
  designTemplateGuidance,
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
// change without a revision. While editing, text and image layers can be
// marked as the template's fields (P4-12), in a draft of its own next to the
// document draft (never in the document or its undo history): a field whose
// layer is deleted, or whose page is, is left out (and back with an undo);
// a duplicated, pasted or copied layer gets no field. The fields are saved
// with the document, in the same revision

// The document, or null when it does not parse as Design Document v1
const parseTemplate = (content: unknown) => {
  try {
    return parseContentStudioDesignDocument(content);
  } catch {
    return null;
  }
};

type Guidance = ContentStudioDesignTemplateGuidanceV1;
const NO_GUIDANCE: Guidance = {
  schemaVersion: 1,
  brandRebinding: false,
  slots: [],
};

const slotLayer = (
  document: ContentStudioDesignDocumentV1,
  slot: ContentStudioDesignTemplateSlot
) =>
  document.pages
    .find((page) => page.id === slot.pageId)
    ?.layers.find((entry) => entry.id === slot.layerId);

// The fields of a draft that still have their layer, of their kind, on
// their page, and rebinding only while the document names a Brand Kit
const keptGuidance = (
  guidance: Guidance,
  document: ContentStudioDesignDocumentV1
): Guidance => ({
  schemaVersion: 1,
  brandRebinding: guidance.brandRebinding && !!document.brandKit,
  slots: guidance.slots.filter(
    (slot) => slotLayer(document, slot)?.type === slot.type
  ),
});

// What a save sends with the document: the kept fields (an empty
// description left out), checked against exactly that document, or null
// for none. Invalid fields are refused here, with nothing sent
const guidanceToSave = (
  guidance: Guidance,
  document: ContentStudioDesignDocumentV1
) => {
  const kept = keptGuidance(guidance, document);
  if (!kept.slots.length && !kept.brandRebinding) {
    return null;
  }
  try {
    return parseContentStudioDesignTemplateGuidance(
      {
        schemaVersion: 1,
        brandRebinding: kept.brandRebinding,
        slots: kept.slots.map(({ description, ...slot }) =>
          description?.trim() ? { ...slot, description } : slot
        ),
      },
      document
    );
  } catch {
    throw new ContentStudioRequestError(
      400,
      'CS_DESIGN_TEMPLATE_GUIDANCE_INVALID'
    );
  }
};

// Two drafts with the same fields, labels and switches compare equal
const guidanceKey = (guidance: Guidance) =>
  JSON.stringify([
    guidance.brandRebinding,
    guidance.slots.map((slot) => [
      slot.id,
      slot.type,
      slot.label.trim(),
      slot.description?.trim() ?? '',
      slot.pageId,
      slot.layerId,
      slot.required,
      slot.type === 'text' ? slot.multiline : null,
    ]),
  ]);

const FIELD_INPUT =
  'bg-newBgColorInner h-[36px] px-[10px] border-newTableBorder border rounded-[8px] text-textColor text-[13px] w-full min-w-0';

// The template's fields: their order, kind and layer, and whether another
// Brand Kit revision may be used. While editing, the selected text or image
// layer can become a field (a shape cannot) and a field can be renamed,
// described, made required, moved or removed. Read-only otherwise
const TemplateFieldsPanel: FC<{
  guidance: Guidance | 'invalid';
  document: ContentStudioDesignDocumentV1;
  page: ContentStudioDesignPage;
  layer: ContentStudioDesignLayer | null;
  single: boolean;
  onChange: ((guidance: Guidance) => void) | null;
}> = ({ guidance, document, page, layer, single, onChange }) => {
  const t = useT();
  if (guidance === 'invalid') {
    return (
      <section className="flex flex-col gap-[8px]">
        <h2 className="font-[600]">
          {t('content_studio_template_fields', 'Template fields')}
        </h2>
        <div role="alert">
          {t(
            'content_studio_template_error_integrity',
            'Stored template data could not be read safely.'
          )}
        </div>
      </section>
    );
  }
  const slots = guidance.slots;
  const pageNumber = (pageId: string) =>
    document.pages.findIndex((entry) => entry.id === pageId) + 1;
  const kind = (slot: ContentStudioDesignTemplateSlot) =>
    slot.type === 'text'
      ? t('content_studio_template_text_field', 'Text field')
      : t('content_studio_template_image_field', 'Image field');
  const update = (
    id: string,
    patch: Partial<ContentStudioDesignTemplateSlot>
  ) =>
    onChange?.({
      ...guidance,
      slots: slots.map((slot) =>
        slot.id === id
          ? ({ ...slot, ...patch } as ContentStudioDesignTemplateSlot)
          : slot
      ),
    });
  const remove = (id: string) =>
    onChange?.({ ...guidance, slots: slots.filter((slot) => slot.id !== id) });
  const move = (index: number, by: number) => {
    const next = [...slots];
    const [slot] = next.splice(index, 1);
    next.splice(index + by, 0, slot);
    onChange?.({ ...guidance, slots: next });
  };
  // a new field: the next free id, the layer's name as its label when it is
  // plain, optional, on one line unless the text has several
  const add = (target: ContentStudioDesignLayer) => {
    if (target.type === 'shape') {
      return;
    }
    let number = 1;
    while (slots.some((slot) => slot.id === `field_${number}`)) {
      number += 1;
    }
    const name = target.name.trim();
    const label =
      name && !/[<>]|:\/\/|www\./i.test(name)
        ? name.slice(0, DESIGN_TEMPLATE_SLOT_LABEL_MAX)
        : designLayerTypeLabel(t, target);
    const base = {
      id: `field_${number}`,
      label,
      pageId: page.id,
      layerId: target.id,
      required: false,
    };
    onChange?.({
      ...guidance,
      slots: [
        ...slots,
        target.type === 'text'
          ? {
              ...base,
              type: 'text' as const,
              multiline: target.text.includes('\n'),
            }
          : { ...base, type: 'image' as const },
      ],
    });
  };
  const selected =
    layer && single
      ? slots.find(
          (slot) => slot.layerId === layer.id && slot.pageId === page.id
        ) ?? null
      : null;

  return (
    <section
      className="flex flex-col gap-[8px]"
      aria-label={t('content_studio_template_fields', 'Template fields')}
    >
      <h2 className="font-[600]">
        {t('content_studio_template_fields', 'Template fields')}
      </h2>
      <div className="text-[12px] text-textItemBlur">
        {`${slots.length} ${
          slots.length === 1
            ? t('content_studio_template_field_count_one', 'field')
            : t('content_studio_template_field_count', 'fields')
        } · ${
          guidance.brandRebinding
            ? t(
                'content_studio_template_rebind_allowed',
                'Another Brand Kit revision allowed'
              )
            : t(
                'content_studio_template_rebind_not_allowed',
                'Template Brand Kit revision only'
              )
        }`}
      </div>
      {!!onChange && (
        <div className="flex flex-col gap-[8px]">
          {!layer || !single ? (
            <div className="text-[12px] text-textItemBlur">
              {t(
                'content_studio_template_fields_select_hint',
                'Select one text or image layer to make it a template field.'
              )}
            </div>
          ) : layer.type === 'shape' ? (
            <div className="text-[12px] text-textItemBlur">
              {t(
                'content_studio_template_fields_shape',
                'Shapes cannot be template fields.'
              )}
            </div>
          ) : !selected ? (
            <Button
              secondary
              disabled={slots.length >= DESIGN_TEMPLATE_SLOTS_MAX}
              onClick={() => add(layer)}
            >
              {layer.type === 'text'
                ? t(
                    'content_studio_template_use_text_field',
                    'Use as template text field'
                  )
                : t(
                    'content_studio_template_use_image_field',
                    'Use as template image field'
                  )}
            </Button>
          ) : (
            <div
              role="group"
              aria-label={`${kind(selected)} · ${selected.label}`}
              className="flex flex-col gap-[6px] border border-newTableBorder rounded-[8px] p-[8px]"
            >
              <div className="text-[12px]">{kind(selected)}</div>
              <label className="flex flex-col gap-[4px] text-[13px]">
                {t('content_studio_template_field_label', 'Field label')}
                <input
                  type="text"
                  className={FIELD_INPUT}
                  value={selected.label}
                  maxLength={DESIGN_TEMPLATE_SLOT_LABEL_MAX}
                  aria-invalid={!selected.label.trim()}
                  onChange={(e) =>
                    update(selected.id, { label: e.target.value })
                  }
                />
              </label>
              {!selected.label.trim() && (
                <div className="text-[12px] text-red-400">
                  {t(
                    'content_studio_template_field_label_required',
                    'A field needs a label.'
                  )}
                </div>
              )}
              <label className="flex flex-col gap-[4px] text-[13px]">
                {t(
                  'content_studio_template_field_description',
                  'Field description'
                )}
                <input
                  type="text"
                  className={FIELD_INPUT}
                  value={selected.description ?? ''}
                  maxLength={DESIGN_TEMPLATE_SLOT_DESCRIPTION_MAX}
                  onChange={(e) =>
                    update(selected.id, { description: e.target.value })
                  }
                />
              </label>
              <label className="flex items-center gap-[8px] text-[13px]">
                <input
                  type="checkbox"
                  checked={selected.required}
                  onChange={(e) =>
                    update(selected.id, { required: e.target.checked })
                  }
                />
                {t('content_studio_template_field_required', 'Required')}
              </label>
              {selected.type === 'text' && (
                <label className="flex items-center gap-[8px] text-[13px]">
                  <input
                    type="checkbox"
                    checked={selected.multiline}
                    onChange={(e) =>
                      update(selected.id, { multiline: e.target.checked })
                    }
                  />
                  {t(
                    'content_studio_template_field_multiline',
                    'Several lines'
                  )}
                </label>
              )}
              <div>
                <Button secondary onClick={() => remove(selected.id)}>
                  {t('content_studio_template_field_remove', 'Remove field')}
                </Button>
              </div>
            </div>
          )}
          <label className="flex items-center gap-[8px] text-[13px]">
            <input
              type="checkbox"
              checked={guidance.brandRebinding}
              disabled={!document.brandKit}
              onChange={(e) =>
                onChange({ ...guidance, brandRebinding: e.target.checked })
              }
            />
            {t(
              'content_studio_template_allow_rebind',
              'Allow another Brand Kit revision'
            )}
          </label>
          {!document.brandKit && (
            <div className="text-[12px] text-textItemBlur">
              {t(
                'content_studio_template_allow_rebind_hint',
                'Pin a Brand Kit revision first: only a template using a Brand Kit can be used with another revision.'
              )}
            </div>
          )}
        </div>
      )}
      {!!slots.length && (
        <ol
          aria-label={t('content_studio_template_field_list', 'Field order')}
          className="flex flex-col gap-[4px]"
        >
          {slots.map((slot, index) => {
            const target = slotLayer(document, slot);
            return (
              <li
                key={slot.id}
                data-template-slot={slot.id}
                className="flex flex-col gap-[4px] border border-newTableBorder rounded-[6px] px-[8px] py-[6px] text-[12px]"
              >
                <span className="font-[600] break-words">
                  {slot.label.trim() ||
                    t('content_studio_template_field_unnamed', 'Unnamed field')}
                </span>
                <span className="text-textItemBlur break-words">
                  {[
                    kind(slot),
                    slot.required
                      ? t('content_studio_template_field_required', 'Required')
                      : t('content_studio_template_field_optional', 'Optional'),
                    `${t('content_studio_design_page', 'Page')} ${pageNumber(
                      slot.pageId
                    )}`,
                    target
                      ? target.name || designLayerTypeLabel(t, target)
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {!!onChange && (
                  <span className="flex flex-wrap gap-[4px]">
                    <Button
                      secondary
                      className="h-[28px] px-[10px] text-[12px]"
                      disabled={index === 0}
                      aria-label={`${t(
                        'content_studio_template_field_up',
                        'Move field up'
                      )}: ${slot.label}`}
                      onClick={() => move(index, -1)}
                    >
                      {t('content_studio_template_field_up_short', 'Up')}
                    </Button>
                    <Button
                      secondary
                      className="h-[28px] px-[10px] text-[12px]"
                      disabled={index === slots.length - 1}
                      aria-label={`${t(
                        'content_studio_template_field_down',
                        'Move field down'
                      )}: ${slot.label}`}
                      onClick={() => move(index, 1)}
                    >
                      {t('content_studio_template_field_down_short', 'Down')}
                    </Button>
                    <Button
                      secondary
                      className="h-[28px] px-[10px] text-[12px]"
                      aria-label={`${t(
                        'content_studio_template_field_remove',
                        'Remove field'
                      )}: ${slot.label}`}
                      onClick={() => remove(slot.id)}
                    >
                      {t(
                        'content_studio_template_field_remove_short',
                        'Remove'
                      )}
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
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
  const currentRevision = detail.data?.currentRevision;
  const currentDocument = useMemo(
    () => (currentRevision ? parseTemplate(currentRevision.content) : null),
    [currentRevision]
  );
  const currentGuidance = useMemo(
    () =>
      currentRevision && currentDocument
        ? designTemplateGuidance(currentDocument, currentRevision.guidance)
        : null,
    [currentRevision, currentDocument]
  );
  // the fields being edited: a draft of this tab, next to the document's
  const [guidanceDraft, setGuidanceDraft] = useState<Guidance>(NO_GUIDANCE);
  const guidanceRef = useRef(guidanceDraft);
  guidanceRef.current = guidanceDraft;
  const guidanceBase =
    currentGuidance && currentGuidance !== 'invalid'
      ? currentGuidance
      : NO_GUIDANCE;
  const guidanceDirty =
    guidanceKey(guidanceDraft) !== guidanceKey(guidanceBase);
  // the draft and its fields are saved as the template's next revision
  const target = useMemo<ContentStudioDesignEditorTarget>(
    () => ({
      save: (id, baseRevisionNumber, content) =>
        saveTemplateRevision(
          id,
          baseRevisionNumber,
          content,
          guidanceToSave(guidanceRef.current, content)
        ),
      conflictCode: 'CS_DESIGN_TEMPLATE_REVISION_CONFLICT',
      savedMessage: (revisionNumber) =>
        `${t(
          'content_studio_template_saved_as',
          'Template saved as Revision'
        )} ${revisionNumber}.`,
      errorMessage: (error) => designTemplateErrorMessage(t, error),
      dirty: guidanceDirty,
    }),
    [saveTemplateRevision, t, guidanceDirty]
  );
  const editor = useContentStudioDesignEditor(templateId, target);
  // a copied layer, in memory only: gone when this workspace is left
  const [clipboard, setClipboard] =
    useState<ContentStudioDesignLayerCopy | null>(null);
  const confirmDiscard = useConfirmDiscard();

  const openedDocument = useMemo(
    () => (opened.data ? parseTemplate(opened.data.content) : null),
    [opened.data]
  );
  const openedGuidance = useMemo(
    () =>
      opened.data && openedDocument
        ? designTemplateGuidance(openedDocument, opened.data.guidance)
        : null,
    [opened.data, openedDocument]
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
  // a new design from exactly the shown revision (saved, never the draft),
  // with that revision's own fields
  const shownRevision = shown.historical ? opened.data : currentRevision;
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
          content={shownRevision?.content}
          guidance={shownRevision?.guidance}
        />
      ),
    });

  // the fields of what is shown: the draft's while editing (only those that
  // still have their layer), else the shown revision's, read-only
  const shownGuidance = editing
    ? keptGuidance(guidanceDraft, shownCurrent)
    : (shown.historical ? openedGuidance : currentGuidance) ?? NO_GUIDANCE;
  const view = (document: typeof currentDocument) => (
    <DesignRevisionView
      key={shown.id}
      revision={shown}
      document={document}
      pageId={pageId}
      setPageId={setPageId}
      render={null}
      editLabel={t('content_studio_template_edit', 'Edit template')}
      canEdit={!archived && !shown.historical && currentGuidance !== 'invalid'}
      onBeginEdit={() => {
        setGuidanceDraft(
          currentGuidance && currentGuidance !== 'invalid'
            ? currentGuidance
            : NO_GUIDANCE
        );
        editor.begin(currentRevision, currentDocument);
      }}
      edit={shown.historical ? null : edit}
      aside={(context) => (
        <TemplateFieldsPanel
          guidance={shownGuidance}
          {...context}
          // a change starts from the kept fields: a field whose layer is
          // gone is then dropped from the draft for good
          onChange={editing && !editor.saving ? setGuidanceDraft : null}
        />
      )}
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
            <Button
              disabled={
                !!editor.state ||
                (shown.historical && shownRevision?.id !== shown.id)
              }
              onClick={openUseRevision}
            >
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
