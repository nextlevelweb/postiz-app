'use client';

import {
  FC,
  FormEvent,
  KeyboardEvent,
  PointerEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';
import { ChoiceField } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';
import {
  BRAND_FONT_STYLES,
  BRAND_FONT_WEIGHTS,
  ContentStudioBrandKitContentV1,
  parseContentStudioBrandKitContent,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import {
  ContentStudioDesignColorValue,
  ContentStudioDesignDocumentError,
  ContentStudioDesignDocumentV1,
  ContentStudioDesignFontRef,
  ContentStudioDesignImageLayer,
  ContentStudioDesignImageMask,
  ContentStudioDesignLayer,
  ContentStudioDesignPage,
  DESIGN_COORDINATE_MAX,
  DESIGN_CORNER_RADIUS_MAX,
  DESIGN_FONT_FAMILY_MAX,
  DESIGN_FONT_SIZE_MAX,
  DESIGN_FONT_SIZE_MIN,
  DESIGN_LAYER_NAME_MAX,
  DESIGN_LETTER_SPACING_MAX,
  DESIGN_LINE_HEIGHT_MAX,
  DESIGN_LINE_HEIGHT_MIN,
  DESIGN_PAGE_NAME_MAX,
  DESIGN_ROTATION_MAX,
  DESIGN_TEXT_MAX,
  DESIGN_TOTAL_TEXT_MAX,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  addContentStudioDesignImageLayer,
  addContentStudioDesignLayer,
  addContentStudioDesignPage,
  alignContentStudioDesignLayers,
  arrangeContentStudioDesignLayersInColumn,
  arrangeContentStudioDesignLayersInGrid,
  arrangeContentStudioDesignLayersInRow,
  centerContentStudioDesignLayersOnPage,
  ContentStudioDesignCenterAxis,
  alignContentStudioDesignLayerToPage,
  amendContentStudioDesignHistory,
  applyContentStudioDesignHistory,
  areContentStudioDesignDocumentsEqual,
  cloneContentStudioDesignDocument,
  ContentStudioDesignAlignEdge,
  ContentStudioDesignEditorError,
  ContentStudioDesignEditorHistory,
  ContentStudioDesignLayerMove,
  ContentStudioDesignLayerPatch,
  contentStudioDesignEditorLimits,
  contentStudioDesignDocumentColors,
  contentStudioDesignFocalPointAt,
  contentStudioDesignImagePillRadius,
  DESIGN_IMAGE_MASK_DEFAULT_RADIUS,
  nudgeContentStudioDesignFocalPoint,
  setContentStudioDesignImageMask,
  contentStudioDesignLayerMoves,
  contentStudioDesignTextLength,
  deleteContentStudioDesignLayer,
  deleteContentStudioDesignPage,
  distributeContentStudioDesignLayers,
  moveContentStudioDesignLayersIntoPage,
  spaceContentStudioDesignLayers,
  duplicateContentStudioDesignLayer,
  createContentStudioDesignPageVariant,
  createContentStudioDesignPageVariants,
  duplicateContentStudioDesignPage,
  missingContentStudioDesignBrandTokens,
  moveContentStudioDesignLayer,
  moveContentStudioDesignPage,
  redoContentStudioDesignHistory,
  setContentStudioDesignBrandKit,
  startContentStudioDesignHistory,
  undoContentStudioDesignHistory,
  updateContentStudioDesignLayer,
  updateContentStudioDesignPage,
} from '@gitroom/frontend/components/content-studio/content-studio.design.editor';
import {
  ContentStudioDesignMediaRef,
  DESIGN_CANVAS_PRESETS,
  designErrorCode,
  designReferenceErrorMessage,
  designSaveErrorMessage,
  useContentStudioBrandKit,
  useContentStudioBrandKitRevisions,
  useContentStudioDesignActions,
  useContentStudioMediaLibrary,
} from '@gitroom/frontend/components/content-studio/content-studio.designs.api';
import {
  resolveDesignPreviewColor,
  resolveDesignPreviewFont,
} from '@gitroom/frontend/components/content-studio/content-studio.design.preview';

// Structured editing of the current revision of a design. The edit is a
// draft in this browser tab only: a Design Document v1 copied from the saved
// revision, changed by the editor operations, with up to 50 undo steps.
// Nothing is kept anywhere until Save sends the whole document, checked by
// the Design Document parser, as the next revision over the revision the edit
// started from; a revision saved meanwhile is a conflict that keeps the draft
// and blocks saving until the latest revision is reloaded (the draft is then
// discarded: nothing is merged). Images and Brand Kit revisions enter the
// draft only as references the server made. Rendering always uses saved
// revisions

type Translate = (key: string, fallback: string) => string;

// repeated nudges this close together are one undo step
export const DESIGN_EDITOR_RUN_MS = 300;

interface EditorState {
  designId: string;
  base: {
    revisionId: string;
    revisionNumber: number;
    document: ContentStudioDesignDocumentV1;
  };
  history: ContentStudioDesignEditorHistory;
}

export const designEditorErrorMessage = (t: Translate, error: unknown) => {
  const code =
    error instanceof ContentStudioDesignEditorError ? error.code : undefined;
  switch (code) {
    case 'PAGE_LIMIT':
      return t(
        'content_studio_design_edit_page_limit',
        'A design can have up to 25 pages.'
      );
    case 'LAYER_LIMIT':
      return t(
        'content_studio_design_edit_layer_limit',
        'This page or design has reached its layer limit.'
      );
    case 'LAST_PAGE':
      return t(
        'content_studio_design_edit_last_page',
        'A design needs at least one page.'
      );
    case 'BRAND_TOKENS_IN_USE':
      return t(
        'content_studio_design_edit_brand_in_use',
        'This design still uses Brand Kit colors or typography. Replace them before removing the Brand Kit.'
      );
    case 'BRAND_TOKENS_MISSING':
      return t(
        'content_studio_design_edit_brand_missing',
        'This Brand Kit revision does not contain all tokens used by the design.'
      );
    case 'OUT_OF_LIMITS':
      return t(
        'content_studio_design_align_out_of_limits',
        'That alignment is outside the design limits.'
      );
    case 'IMAGE_MASK_INVALID':
      return t(
        'content_studio_design_frame_invalid',
        'That frame radius is not possible.'
      );
    case 'STYLE_KIND_MISMATCH':
      return t(
        'content_studio_style_preset_wrong_layer',
        'This style preset is for another kind of layer.'
      );
    case 'INVALID_TARGET_SIZE':
      return t(
        'content_studio_design_variant_invalid_size',
        'Choose one or more different, valid page sizes.'
      );
    case 'VARIANT_OUT_OF_LIMITS':
      return t(
        'content_studio_design_variant_out_of_limits',
        'At that size this page would be outside the design limits. Nothing was created.'
      );
    case 'BLOCK_BRAND_UNAVAILABLE':
      return t(
        'content_studio_block_brand_unavailable',
        'This block uses Brand Kit colors or typography that this design’s Brand Kit revision does not have. Nothing was inserted.'
      );
    case 'BLOCK_OUT_OF_LIMITS':
      return t(
        'content_studio_block_out_of_limits',
        'With this block the design would be outside its limits. Nothing was inserted.'
      );
    case 'PAGE_SET_OUT_OF_LIMITS':
      return t(
        'content_studio_page_set_out_of_limits',
        'With these pages the design would be outside its limits. Nothing was added.'
      );
    case 'LAYOUT_BRAND_UNAVAILABLE':
      return t(
        'content_studio_layout_brand_unavailable',
        'This layout uses Brand Kit colors or typography that this design’s Brand Kit revision does not have. Nothing was inserted.'
      );
    case 'STYLE_BRAND_UNAVAILABLE':
      return t(
        'content_studio_style_preset_brand_unavailable',
        'This style uses Brand Kit colors or typography that this design’s Brand Kit revision does not have. Nothing was changed.'
      );
    default:
      return t(
        'content_studio_design_edit_failed',
        'This change could not be applied.'
      );
  }
};

// Typing in a field keeps the field's own undo
export const isDesignEditorTextTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable);

// Editor shortcuts belong to the editor: a key pressed on the page itself
// or inside the editor (marked data-design-editor), never in a field or
// in a dialog, which are elsewhere in the page
export const isDesignEditorShortcutTarget = (target: EventTarget | null) =>
  !isDesignEditorTextTarget(target) &&
  (!(target instanceof Element) ||
    target === target.ownerDocument.body ||
    target === target.ownerDocument.documentElement ||
    !!target.closest('[data-design-editor]'));

// The edit of one design: entered explicitly from the current revision of an
// active design, left by Save, Cancel or a confirmed discard
// Where a draft is saved: the next revision of the design (the default), or
// of another owner of Design Document v1 revisions, a design template
// (P4-11), with its own conflict code and wording. Same rules either way:
// the parsed draft, once, over the base revision, never retried. A template
// also saves its guidance with the document (P4-12): the target keeps that
// draft itself, and says when it has unsaved changes too; a design has none
export interface ContentStudioDesignEditorTarget {
  save: (
    id: string,
    baseRevisionNumber: number,
    content: ContentStudioDesignDocumentV1
  ) => Promise<{ created: boolean; revision: { revisionNumber: number } }>;
  conflictCode: string;
  savedMessage: (revisionNumber: number) => string;
  errorMessage: (error: unknown) => string;
  dirty?: boolean;
}

export const useContentStudioDesignEditor = (
  designId: string,
  target?: ContentStudioDesignEditorTarget
) => {
  const t = useT();
  const toaster = useToaster();
  const { saveDesignRevision } = useContentStudioDesignActions();
  const targetRef = useRef(target);
  targetRef.current = target;
  const [state, setState] = useState<EditorState | null>(null);
  const latest = useRef<EditorState | null>(null);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  // a save lost to another revision: no save until the latest is loaded
  const [conflict, setConflict] = useState(false);
  // a canvas gesture in progress: its change is not in the draft yet, so
  // nothing undoes, redoes or saves until it ends
  const interactingRef = useRef(false);
  const [interacting, setInteractingState] = useState(false);
  const setInteracting = useCallback((active: boolean) => {
    interactingRef.current = active;
    setInteractingState(active);
  }, []);

  const commit = useCallback((next: EditorState | null) => {
    latest.current = next;
    setState(next);
  }, []);

  const begin = useCallback(
    (
      revision: { id: string; revisionNumber: number },
      document: ContentStudioDesignDocumentV1
    ) => {
      setConflict(false);
      commit({
        designId,
        base: {
          revisionId: revision.id,
          revisionNumber: revision.revisionNumber,
          document: cloneContentStudioDesignDocument(document),
        },
        history: startContentStudioDesignHistory(document),
      });
    },
    [designId, commit]
  );

  // the last edit that may be continued as the same undo step
  const run = useRef<{ key: string; at: number; present: unknown } | null>(
    null
  );

  // One edit as one undo step. A refused edit leaves the draft as it was.
  // Edits of the same run (a key such as one layer nudged one way) that
  // follow each other within 300 ms, with nothing in between, are one step
  const apply = useCallback(
    <T,>(
      operation: (document: ContentStudioDesignDocumentV1) => {
        document: ContentStudioDesignDocumentV1;
        result?: T;
      },
      runKey?: string
    ): T | undefined => {
      const current = latest.current;
      if (!current || savingRef.current) {
        return undefined;
      }
      let outcome;
      try {
        outcome = operation(current.history.present);
      } catch (err) {
        toaster.show(designEditorErrorMessage(t, err), 'warning');
        return undefined;
      }
      const now = Date.now();
      const previous = run.current;
      const continues =
        !!runKey &&
        previous?.key === runKey &&
        previous.present === current.history.present &&
        now - previous.at <= DESIGN_EDITOR_RUN_MS;
      const history = (
        continues
          ? amendContentStudioDesignHistory
          : applyContentStudioDesignHistory
      )(current.history, outcome.document);
      run.current = runKey
        ? { key: runKey, at: now, present: history.present }
        : null;
      commit({ ...current, history });
      return outcome.result;
    },
    [commit, toaster, t]
  );

  const undo = useCallback(() => {
    const current = latest.current;
    if (current && !savingRef.current && !interactingRef.current) {
      commit({
        ...current,
        history: undoContentStudioDesignHistory(current.history),
      });
    }
  }, [commit]);
  const redo = useCallback(() => {
    const current = latest.current;
    if (current && !savingRef.current && !interactingRef.current) {
      commit({
        ...current,
        history: redoContentStudioDesignHistory(current.history),
      });
    }
  }, [commit]);

  const discard = useCallback(() => {
    setConflict(false);
    commit(null);
  }, [commit]);

  const dirty =
    !!state &&
    (!areContentStudioDesignDocumentsEqual(
      state.history.present,
      state.base.document
    ) ||
      !!target?.dirty);

  // Explicit and once: the draft as the parser normalizes it, over the base
  // the edit started from
  const save = useCallback(async () => {
    const current = latest.current;
    if (!current || savingRef.current || interactingRef.current || conflict) {
      return;
    }
    let content: ContentStudioDesignDocumentV1;
    try {
      content = parseContentStudioDesignDocument(current.history.present);
    } catch (err) {
      toaster.show(
        err instanceof ContentStudioDesignDocumentError &&
          err.code === 'TOO_LARGE'
          ? t(
              'content_studio_design_save_too_large',
              'This design is too large to save.'
            )
          : t(
              'content_studio_design_save_invalid',
              'The design contains invalid values. Fix them before saving.'
            ),
        'warning'
      );
      return;
    }
    savingRef.current = true;
    setSaving(true);
    const custom = targetRef.current;
    try {
      const saved = await (custom?.save ?? saveDesignRevision)(
        current.designId,
        current.base.revisionNumber,
        content
      );
      toaster.show(
        saved.created
          ? custom
            ? custom.savedMessage(saved.revision.revisionNumber)
            : `${t(
                'content_studio_design_saved_as',
                'Design saved as Revision'
              )} ${saved.revision.revisionNumber}.`
          : t('content_studio_design_save_unchanged', 'No changes to save.'),
        'success'
      );
      setConflict(false);
      commit(null);
    } catch (err) {
      if (
        designErrorCode(err) ===
        (custom?.conflictCode ?? 'CS_DESIGN_REVISION_CONFLICT')
      ) {
        // the draft stays; it is never sent over the newer revision
        setConflict(true);
      } else {
        toaster.show(
          custom ? custom.errorMessage(err) : designSaveErrorMessage(t, err),
          'warning'
        );
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [conflict, saveDesignRevision, toaster, commit, t]);

  // Undo and redo from the keyboard while editing, outside text fields
  const editing = !!state;
  useEffect(() => {
    if (!editing) {
      return;
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        isDesignEditorTextTarget(event.target)
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, undo, redo]);

  return {
    state,
    document: state?.history.present ?? null,
    baseRevisionNumber: state?.base.revisionNumber ?? null,
    dirty,
    canUndo: !!state?.history.past.length,
    canRedo: !!state?.history.future.length,
    saving,
    conflict,
    interacting,
    setInteracting,
    begin,
    apply,
    undo,
    redo,
    discard,
    save,
  };
};

export type ContentStudioDesignEditor = ReturnType<
  typeof useContentStudioDesignEditor
>;

// Asks before an unsaved draft is thrown away; true when there is nothing
// to lose or the user agreed
export const useConfirmDiscard = () => {
  const t = useT();
  return useCallback(
    async (dirty: boolean) =>
      !dirty ||
      (await deleteDialog(
        t(
          'content_studio_design_discard_hint',
          'Your changes have not been saved as a design revision.'
        ),
        t('content_studio_design_discard', 'Discard'),
        t('content_studio_design_discard_title', 'Discard unsaved changes?'),
        t('content_studio_design_keep_editing', 'Keep editing')
      )),
    [t]
  );
};

// ---------------------------------------------------------------------------
// Fields: a value enters the draft only once it is valid, on blur or Enter
// ---------------------------------------------------------------------------

const FIELD =
  'bg-newBgColorInner h-[36px] px-[10px] border-newTableBorder border rounded-[8px] text-textColor text-[14px] w-full min-w-0 disabled:opacity-60';

const FieldLabel: FC<{
  label: string;
  children: ReactNode;
  error?: string | null;
}> = ({ label, children, error }) => (
  <div className="flex flex-col gap-[4px] min-w-0">
    <span className="text-[12px] text-textItemBlur">{label}</span>
    {children}
    {!!error && (
      <span role="alert" className="text-[12px] text-red-400">
        {error}
      </span>
    )}
  </div>
);

const onEnter = (commit: () => void) => (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    commit();
  }
};

export const DesignNumberField: FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  // width and height must be more than 0
  aboveMin?: boolean;
  step?: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
}> = ({ label, value, min, max, aboveMin, step, disabled, onCommit }) => {
  const t = useT();
  const [text, setText] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(String(value));
    setInvalid(false);
  }, [value]);
  const commit = () => {
    const trimmed = text.trim();
    const number = trimmed === '' ? NaN : Number(trimmed);
    if (
      !Number.isFinite(number) ||
      (aboveMin ? number <= min : number < min) ||
      number > max
    ) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (number !== value) {
      onCommit(number);
    }
  };
  return (
    <FieldLabel
      label={label}
      error={
        invalid
          ? `${t('content_studio_design_number_range', 'Enter a number')} ${
              aboveMin ? '>' : '≥'
            } ${min} ${t('content_studio_design_and', 'and')} ≤ ${max}.`
          : null
      }
    >
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        aria-invalid={invalid}
        data-step={step}
        className={FIELD}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={onEnter(commit)}
      />
    </FieldLabel>
  );
};

// One line of plain text, kept as typed: the parser normalizes it on save
export const DesignTextField: FC<{
  label: string;
  value: string;
  max: number;
  required?: boolean;
  disabled?: boolean;
  onCommit: (value: string) => void;
}> = ({ label, value, max, required, disabled, onCommit }) => {
  const t = useT();
  const [text, setText] = useState(value);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(value);
    setInvalid(false);
  }, [value]);
  const commit = () => {
    if (
      text.length > max ||
      text.includes('\0') ||
      (required && !text.trim())
    ) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (text !== value) {
      onCommit(text);
    }
  };
  return (
    <FieldLabel
      label={label}
      error={
        invalid
          ? required
            ? t('content_studio_design_text_required', 'Enter a value.')
            : t(
                'content_studio_design_text_invalid',
                'This value is not allowed.'
              )
          : null
      }
    >
      <input
        type="text"
        aria-label={label}
        aria-invalid={invalid}
        className={FIELD}
        maxLength={max}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={onEnter(commit)}
      />
    </FieldLabel>
  );
};

// The text of a text layer exactly as typed: spaces and newlines stay
const DesignTextArea: FC<{
  label: string;
  value: string;
  disabled?: boolean;
  onCommit: (value: string) => void;
}> = ({ label, value, disabled, onCommit }) => {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <FieldLabel label={label}>
      <textarea
        aria-label={label}
        className="bg-newBgColorInner min-h-[96px] p-[10px] outline-none border-newTableBorder border rounded-[8px] text-textColor text-[14px] disabled:opacity-60"
        maxLength={DESIGN_TEXT_MAX}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== value && text.length <= DESIGN_TEXT_MAX) {
            onCommit(text);
          }
        }}
      />
    </FieldLabel>
  );
};

const HEX = /^#[0-9a-f]{6}$/i;

// A literal #rrggbb (stored lowercase) or a color token of the exact Brand
// Kit revision; a token stays a token, never its value
// A literal #rrggbb or a color token of the design's exact Brand Kit
// revision. Swatches (P4-13) offer that revision's color tokens and the
// literal colors the design already uses, as the same two kinds of value:
// nothing else is accepted, and no other revision is looked at
export const DesignColorField: FC<{
  label: string;
  value: ContentStudioDesignColorValue;
  brand: ContentStudioBrandKitContentV1 | null;
  disabled?: boolean;
  onCommit: (value: ContentStudioDesignColorValue) => void;
  palette?: string[];
}> = ({ label, value, brand, disabled, onCommit, palette }) => {
  const t = useT();
  const resolved = resolveDesignPreviewColor(value, brand);
  const [text, setText] = useState(value.type === 'literal' ? value.value : '');
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(value.type === 'literal' ? value.value : '');
    setInvalid(false);
  }, [value]);
  const commitHex = (hex: string) => {
    if (!HEX.test(hex)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const next = hex.toLowerCase();
    if (value.type !== 'literal' || value.value !== next) {
      onCommit({ type: 'literal', value: next });
    }
  };
  const tokens = brand?.colors ?? [];
  return (
    <FieldLabel
      label={label}
      error={
        invalid
          ? t(
              'content_studio_design_color_invalid',
              'Enter a color as #rrggbb.'
            )
          : value.type === 'brand' && !resolved
          ? t(
              'content_studio_design_brand_color_unavailable',
              'Brand color unavailable.'
            )
          : null
      }
    >
      <select
        aria-label={`${label} ${t('content_studio_design_source', 'source')}`}
        className={FIELD}
        value={value.type}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === 'brand' && tokens.length) {
            onCommit({ type: 'brand', tokenId: tokens[0].id });
          } else if (e.target.value === 'literal') {
            onCommit({ type: 'literal', value: resolved ?? '#000000' });
          }
        }}
      >
        <option value="literal">
          {t('content_studio_design_color_literal', 'Color')}
        </option>
        <option value="brand" disabled={!tokens.length}>
          {t('content_studio_design_color_brand', 'Brand color')}
        </option>
      </select>
      {value.type === 'literal' ? (
        <div className="flex gap-[6px] items-center">
          <input
            type="text"
            aria-label={label}
            aria-invalid={invalid}
            className={FIELD}
            value={text}
            maxLength={7}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => commitHex(text.trim())}
            onKeyDown={onEnter(() => commitHex(text.trim()))}
          />
          <input
            type="color"
            aria-label={`${label} ${t(
              'content_studio_design_picker',
              'picker'
            )}`}
            className="w-[36px] h-[36px] shrink-0 bg-transparent"
            value={value.value}
            disabled={disabled}
            onChange={(e) => commitHex(e.target.value)}
          />
        </div>
      ) : (
        <select
          aria-label={label}
          className={FIELD}
          value={value.tokenId}
          disabled={disabled}
          onChange={(e) => onCommit({ type: 'brand', tokenId: e.target.value })}
        >
          {!tokens.some((token) => token.id === value.tokenId) && (
            <option value={value.tokenId}>
              {t(
                'content_studio_design_brand_color_unavailable',
                'Brand color unavailable.'
              )}
            </option>
          )}
          {tokens.map((token) => (
            <option key={token.id} value={token.id}>
              {token.name}
            </option>
          ))}
        </select>
      )}
      {!!tokens.length && (
        <div
          role="group"
          aria-label={`${label}: ${t(
            'content_studio_design_brand_swatches',
            'Brand colors'
          )}`}
          className="flex flex-wrap gap-[4px]"
        >
          {tokens.map((token) => {
            const pressed =
              value.type === 'brand' && value.tokenId === token.id;
            return (
              <button
                key={token.id}
                type="button"
                disabled={disabled}
                aria-pressed={pressed}
                aria-label={`${label}: ${t(
                  'content_studio_design_color_brand',
                  'Brand color'
                )} ${token.name}`}
                title={token.name}
                data-swatch="brand"
                className={clsx(
                  'w-[22px] h-[22px] rounded-[4px] border disabled:opacity-50',
                  pressed
                    ? 'border-textColor border-[2px]'
                    : 'border-newTableBorder'
                )}
                style={{ backgroundColor: token.value }}
                onClick={() =>
                  !pressed && onCommit({ type: 'brand', tokenId: token.id })
                }
              />
            );
          })}
        </div>
      )}
      {!!palette?.length && (
        <div
          role="group"
          aria-label={`${label}: ${t(
            'content_studio_design_document_swatches',
            'Colors in this design'
          )}`}
          className="flex flex-wrap gap-[4px]"
        >
          {palette.map((hex) => {
            const pressed = value.type === 'literal' && value.value === hex;
            return (
              <button
                key={hex}
                type="button"
                disabled={disabled}
                aria-pressed={pressed}
                aria-label={`${label}: ${hex}`}
                title={hex}
                data-swatch="literal"
                className={clsx(
                  'w-[22px] h-[22px] rounded-[4px] border disabled:opacity-50',
                  pressed
                    ? 'border-textColor border-[2px]'
                    : 'border-newTableBorder'
                )}
                style={{ backgroundColor: hex }}
                onClick={() => !pressed && commitHex(hex)}
              />
            );
          })}
        </div>
      )}
    </FieldLabel>
  );
};

// A family with weight and style, or a type style token of the exact Brand
// Kit revision. No font is loaded
const DesignFontField: FC<{
  value: ContentStudioDesignFontRef;
  brand: ContentStudioBrandKitContentV1 | null;
  disabled?: boolean;
  onCommit: (value: ContentStudioDesignFontRef) => void;
}> = ({ value, brand, disabled, onCommit }) => {
  const t = useT();
  const tokens = brand?.typography ?? [];
  const resolved = resolveDesignPreviewFont(value, brand);
  const family = value.type === 'family' ? value : null;
  return (
    <div className="flex flex-col gap-[8px] min-w-0">
      <FieldLabel
        label={t('content_studio_design_font', 'Font')}
        error={
          value.type === 'brand' && !resolved
            ? t(
                'content_studio_design_brand_font_unavailable',
                'Brand font unavailable.'
              )
            : null
        }
      >
        <select
          aria-label={`${t('content_studio_design_font', 'Font')} ${t(
            'content_studio_design_source',
            'source'
          )}`}
          className={FIELD}
          value={value.type}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value === 'brand' && tokens.length) {
              onCommit({ type: 'brand', tokenId: tokens[0].id });
            } else if (e.target.value === 'family') {
              onCommit({
                type: 'family',
                family: resolved?.family ?? 'Arial',
                weight: resolved?.weight ?? 400,
                style: resolved?.style ?? 'normal',
              });
            }
          }}
        >
          <option value="family">
            {t('content_studio_design_font_family', 'Font family')}
          </option>
          <option value="brand" disabled={!tokens.length}>
            {t('content_studio_design_font_brand', 'Brand typography')}
          </option>
        </select>
      </FieldLabel>
      {family ? (
        <>
          <DesignTextField
            label={t('content_studio_design_family', 'Family')}
            value={family.family}
            max={DESIGN_FONT_FAMILY_MAX}
            required
            disabled={disabled}
            onCommit={(next) => onCommit({ ...family, family: next })}
          />
          <ChoiceField
            label={t('content_studio_design_weight', 'Weight')}
            value={String(family.weight)}
            disabled={disabled}
            options={BRAND_FONT_WEIGHTS.map((weight) => ({
              value: String(weight),
              label: String(weight),
            }))}
            onChange={(next) =>
              onCommit({
                ...family,
                weight: Number(next) as (typeof BRAND_FONT_WEIGHTS)[number],
              })
            }
          />
          <div
            role="group"
            aria-label={t(
              'content_studio_design_quick_font',
              'Quick font style'
            )}
            className="flex flex-wrap gap-[6px]"
          >
            <button
              type="button"
              className={COMMAND}
              disabled={disabled}
              aria-pressed={family.weight >= 600}
              onClick={() =>
                onCommit({
                  ...family,
                  weight: family.weight >= 600 ? 400 : 700,
                })
              }
            >
              {t('content_studio_design_bold', 'Bold')}
            </button>
            <button
              type="button"
              className={COMMAND}
              disabled={disabled}
              aria-pressed={family.style === 'italic'}
              onClick={() =>
                onCommit({
                  ...family,
                  style: family.style === 'italic' ? 'normal' : 'italic',
                })
              }
            >
              {t('content_studio_design_style_italic', 'Italic')}
            </button>
          </div>
          <ChoiceField
            label={t('content_studio_design_style', 'Style')}
            value={family.style}
            disabled={disabled}
            options={BRAND_FONT_STYLES.map((style) => ({
              value: style,
              label:
                style === 'italic'
                  ? t('content_studio_design_style_italic', 'Italic')
                  : t('content_studio_design_style_normal', 'Normal'),
            }))}
            onChange={(next) =>
              onCommit({
                ...family,
                style: next as (typeof BRAND_FONT_STYLES)[number],
              })
            }
          />
        </>
      ) : (
        value.type === 'brand' && (
          <select
            aria-label={t(
              'content_studio_design_font_brand',
              'Brand typography'
            )}
            className={FIELD}
            value={value.tokenId}
            disabled={disabled}
            onChange={(e) =>
              onCommit({ type: 'brand', tokenId: e.target.value })
            }
          >
            {!tokens.some((token) => token.id === value.tokenId) && (
              <option value={value.tokenId}>
                {t(
                  'content_studio_design_brand_font_unavailable',
                  'Brand font unavailable.'
                )}
              </option>
            )}
            {tokens.map((token) => (
              <option key={token.id} value={token.id}>
                {token.name}
              </option>
            ))}
          </select>
        )
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Media picker: existing image Media of the organization, one page at a
// time; only the chosen one is referenced, by the server
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];
const isImagePath = (path: string) =>
  IMAGE_EXTENSIONS.some((extension) => hasExtension(path, extension));
// A URL the Media API gave, when it is a web or app path
const mediaUrl = (value: string | null | undefined) =>
  typeof value === 'string' && /^(https?:\/\/|\/(?!\/))/i.test(value)
    ? value
    : null;

export const DesignMediaPicker: FC<{
  close: () => void;
  onPicked: (ref: ContentStudioDesignMediaRef) => void;
}> = ({ close, onPicked }) => {
  const t = useT();
  const toaster = useToaster();
  const { getMediaDesignRef } = useContentStudioDesignActions();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const library = useContentStudioMediaLibrary(true, page, query);
  const images = (library.data?.results ?? []).filter((media) =>
    isImagePath(media.path)
  );

  const confirm = async () => {
    if (!selected || running.current) {
      return;
    }
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const ref = await getMediaDesignRef(selected);
      onPicked({ mediaId: ref.mediaId, sha256: ref.sha256 });
      toaster.show(
        t('content_studio_design_media_added', 'Image added.'),
        'success'
      );
      close();
    } catch (err) {
      setError(designReferenceErrorMessage(t, err));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-[12px] min-w-0">
      <div className="flex gap-[8px]">
        <input
          type="search"
          aria-label={t('content_studio_design_media_search', 'Search media')}
          className={FIELD}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onEnter(() => {
            setPage(1);
            setQuery(search);
          })}
        />
        <Button
          secondary
          onClick={() => {
            setPage(1);
            setQuery(search);
          }}
        >
          {t('content_studio_design_media_search_button', 'Search')}
        </Button>
      </div>
      {library.error ? (
        <div role="alert">
          {t(
            'content_studio_design_media_load_error',
            'Media could not be loaded.'
          )}
        </div>
      ) : !library.data ? (
        <LoadingComponent width={40} height={40} />
      ) : !images.length ? (
        <div className="text-textItemBlur">
          {t('content_studio_design_media_empty', 'No images on this page.')}
        </div>
      ) : (
        <ul
          aria-label={t('content_studio_design_media_list', 'Images')}
          className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-[8px]"
        >
          {images.map((media) => {
            const src = mediaUrl(media.thumbnail) ?? mediaUrl(media.path);
            const name = media.originalName || media.name || '';
            return (
              <li key={media.id}>
                <button
                  type="button"
                  aria-pressed={selected === media.id}
                  aria-label={
                    name || t('content_studio_design_layer_image', 'Image')
                  }
                  onClick={() => setSelected(media.id)}
                  className={clsx(
                    'w-full flex flex-col gap-[4px] p-[4px] rounded-[8px] border text-start',
                    selected === media.id
                      ? 'border-textColor/60 bg-boxFocused'
                      : 'border-newTableBorder'
                  )}
                >
                  {src ? (
                    <img
                      src={src}
                      alt={media.alt || ''}
                      className="w-full h-[96px] object-cover rounded-[6px]"
                    />
                  ) : (
                    <span className="h-[96px] flex items-center justify-center">
                      {t('content_studio_design_layer_image', 'Image')}
                    </span>
                  )}
                  <span className="text-[12px] truncate">{name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {!!library.data && library.data.pages > 1 && (
        <ContentStudioPager
          page={page}
          pages={library.data.pages}
          setPage={setPage}
        />
      )}
      {busy && (
        <div role="status" className="text-[14px] text-textItemBlur">
          {t('content_studio_design_media_adding', 'Adding image…')}
        </div>
      )}
      {!!error && (
        <div role="alert" className="text-red-400">
          {error}
        </div>
      )}
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button loading={busy} disabled={busy || !selected} onClick={confirm}>
          {t('content_studio_design_media_use', 'Use image')}
        </Button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Brand Kit revision picker: no Brand Kit, or exactly one revision. Nothing
// follows the latest revision
// ---------------------------------------------------------------------------

export const DesignBrandKitPicker: FC<{
  document: ContentStudioDesignDocumentV1;
  close: () => void;
  apply: ContentStudioDesignEditor['apply'];
}> = ({ document, close, apply }) => {
  const t = useT();
  const { getBrandKitDesignRef, getBrandKitRevision } =
    useContentStudioDesignActions();
  const [page, setPage] = useState(1);
  const kit = useContentStudioBrandKit(true);
  const revisions = useContentStudioBrandKitRevisions(true, page);
  const pinned = document.brandKit;
  const [choice, setChoice] = useState<string | null>(
    pinned?.revisionId ?? 'none'
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const confirm = async () => {
    if (running.current || !choice) {
      return;
    }
    if (choice === (pinned?.revisionId ?? 'none')) {
      close();
      return;
    }
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      if (choice === 'none') {
        try {
          setContentStudioDesignBrandKit(document, null);
        } catch (err) {
          setError(designEditorErrorMessage(t, err));
          return;
        }
        apply((latest) => ({
          document: setContentStudioDesignBrandKit(latest, null),
        }));
        close();
        return;
      }
      // the exact reference and that revision's content, checked against
      // each other before anything changes
      let ref;
      let detail;
      try {
        ref = await getBrandKitDesignRef(choice);
        detail = await getBrandKitRevision(choice);
      } catch (err) {
        setError(designReferenceErrorMessage(t, err));
        return;
      }
      let content: ContentStudioBrandKitContentV1 | null;
      try {
        content = parseContentStudioBrandKitContent(detail.content);
      } catch {
        content = null;
      }
      if (
        !content ||
        ref.revisionId !== choice ||
        detail.id !== choice ||
        detail.revisionNumber !== ref.revisionNumber ||
        detail.contentHash !== ref.contentHash
      ) {
        setError(
          t(
            'content_studio_design_brand_integrity',
            'Stored Brand Kit data could not be read safely.'
          )
        );
        return;
      }
      const brandKit = { ref, content };
      try {
        setContentStudioDesignBrandKit(document, brandKit);
      } catch (err) {
        setError(designEditorErrorMessage(t, err));
        return;
      }
      apply((latest) => ({
        document: setContentStudioDesignBrandKit(latest, brandKit),
      }));
      close();
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const latestNumber = kit.data?.latestRevisionNumber ?? 0;
  return (
    <div className="flex flex-col gap-[12px] min-w-0">
      <div className="text-[13px] text-textItemBlur">
        {t(
          'content_studio_design_brand_pick_hint',
          'A design is pinned to one exact Brand Kit revision. It does not follow later revisions.'
        )}
      </div>
      {revisions.error || kit.error ? (
        <div role="alert">
          {t(
            'content_studio_design_brand_list_error',
            'Brand Kit revisions could not be loaded.'
          )}
        </div>
      ) : !revisions.data ? (
        <LoadingComponent width={40} height={40} />
      ) : (
        <ul
          aria-label={t(
            'content_studio_design_brand_revisions',
            'Brand Kit revisions'
          )}
          className="flex flex-col gap-[6px]"
        >
          {[{ id: 'none', revisionNumber: 0 }, ...revisions.data.results].map(
            (revision) => (
              <li key={revision.id}>
                <label className="flex items-center gap-[8px] border border-newTableBorder rounded-[8px] px-[12px] py-[8px] cursor-pointer">
                  <input
                    type="radio"
                    name="brand-kit-revision"
                    value={revision.id}
                    checked={choice === revision.id}
                    onChange={() => setChoice(revision.id)}
                  />
                  <span className="flex-1">
                    {revision.id === 'none'
                      ? t('content_studio_design_no_brand', 'No Brand Kit')
                      : `${t('content_studio_design_revision', 'Revision')} ${
                          revision.revisionNumber
                        }`}
                  </span>
                  {(revision.id === 'none'
                    ? !pinned
                    : pinned?.revisionId === revision.id) && (
                    <span className="text-[11px] px-[8px] rounded-full border border-newTableBorder">
                      {t('content_studio_design_brand_pinned_badge', 'Pinned')}
                    </span>
                  )}
                  {revision.id !== 'none' &&
                    revision.revisionNumber === latestNumber && (
                      <span className="text-[11px] px-[8px] rounded-full border border-newTableBorder">
                        {t(
                          'content_studio_design_brand_latest_badge',
                          'Latest'
                        )}
                      </span>
                    )}
                </label>
              </li>
            )
          )}
        </ul>
      )}
      {!!revisions.data && revisions.data.pages > 1 && (
        <ContentStudioPager
          page={page}
          pages={revisions.data.pages}
          setPage={setPage}
        />
      )}
      {!!error && (
        <div role="alert" className="text-red-400">
          {error}
        </div>
      )}
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button loading={busy} disabled={busy} onClick={confirm}>
          {t('content_studio_design_brand_apply', 'Apply')}
        </Button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// The editing controls of the workspace
// ---------------------------------------------------------------------------

// Size variants (P4-16): the current page made again in one fixed canvas
// size (Duplicate as size) or in several at once (Create campaign
// variants), each one an ordinary new page right after it, scaled
// uniformly and centered. One undo step for all of them; the first new page
// opens with nothing selected. Nothing links a variant to its page, and a
// template's guidance is never copied: the new layers have new ids
const DesignPageVariantDialog: FC<{
  editor: ContentStudioDesignEditor;
  page: ContentStudioDesignPage;
  campaign: boolean;
  close: () => void;
  onCreated: (pageId: string) => void;
}> = ({ editor, page, campaign, close, onCreated }) => {
  const t = useT();
  const sameSize = (preset: { width: number; height: number }) =>
    preset.width === page.width && preset.height === page.height;
  const [chosen, setChosen] = useState<string[]>(() => {
    const other = DESIGN_CANVAS_PRESETS.find((preset) => !sameSize(preset));
    return campaign || !other ? [] : [other.id];
  });
  const label = (preset: (typeof DESIGN_CANVAS_PRESETS)[number]) =>
    t(`content_studio_design_preset_${preset.id}`, preset.label);
  // the targets in the presets' own order, whatever order they were ticked
  const targets = DESIGN_CANVAS_PRESETS.filter((preset) =>
    chosen.includes(preset.id)
  ).map((preset) => ({
    width: preset.width,
    height: preset.height,
    label: label(preset),
  }));
  const ready = campaign ? targets.length >= 2 : targets.length === 1;
  const toggle = (id: string) =>
    setChosen((current) =>
      campaign
        ? current.includes(id)
          ? current.filter((entry) => entry !== id)
          : [...current, id]
        : [id]
    );
  const create = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || editor.saving || editor.interacting) {
      return;
    }
    const first = editor.apply((latest) => {
      if (!campaign) {
        const created = createContentStudioDesignPageVariant(
          latest,
          page.id,
          targets[0]
        );
        return { document: created.document, result: created.pageId };
      }
      const created = createContentStudioDesignPageVariants(
        latest,
        page.id,
        targets
      );
      return { document: created.document, result: created.pageIds[0] };
    });
    if (first) {
      onCreated(first);
      close();
    }
  };
  return (
    <form onSubmit={create} className="flex flex-col gap-[16px] min-w-0">
      <div className="text-[13px] text-textItemBlur">
        {`${t('content_studio_design_variant_source', 'This page')}: ${
          page.width
        } × ${page.height} · ${t(
          'content_studio_design_variant_hint',
          'Each new page is a scaled, centered copy you can edit on its own; it does not stay linked to this page.'
        )}`}
      </div>
      <fieldset className="flex flex-col gap-[8px]">
        <legend className="text-[14px] mb-[6px]">
          {campaign
            ? t('content_studio_design_variant_sizes', 'Page sizes')
            : t('content_studio_design_variant_size', 'Page size')}
        </legend>
        {DESIGN_CANVAS_PRESETS.map((preset) => (
          <label
            key={preset.id}
            className="flex items-center gap-[8px] cursor-pointer"
          >
            <input
              type={campaign ? 'checkbox' : 'radio'}
              name="variant-size"
              value={preset.id}
              checked={chosen.includes(preset.id)}
              onChange={() => toggle(preset.id)}
            />
            <span>
              {label(preset)}{' '}
              <span className="text-textItemBlur">
                {preset.width} × {preset.height}
                {sameSize(preset) &&
                  ` · ${t('content_studio_design_variant_same', 'same size')}`}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {campaign && (
        <div className="text-[12px] text-textItemBlur">
          {t(
            'content_studio_design_variant_campaign_hint',
            'Choose two or more sizes. The pages are added after this one in the order shown.'
          )}
        </div>
      )}
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button type="submit" disabled={!ready || editor.saving}>
          {campaign
            ? t('content_studio_design_variant_create_all', 'Create variants')
            : t('content_studio_design_variant_create', 'Create variant')}
        </Button>
      </div>
    </form>
  );
};

// Save, Cancel, Undo, Redo, adding layers and page actions. Save waits for a
// change, a known Brand Kit and no known conflict
export const DesignEditorToolbar: FC<{
  editor: ContentStudioDesignEditor;
  document: ContentStudioDesignDocumentV1;
  page: ContentStudioDesignPage;
  pageIndex: number;
  brandReady: boolean;
  brand: ContentStudioBrandKitContentV1 | null;
  setPageId: (id: string) => void;
  setLayerId: (id: string | null) => void;
  onCancel: () => void;
  onReloadLatest: () => void;
  // canvas settings of this visit only: snapping and its guides
  snap: boolean;
  guides: boolean;
  onSnapChange: (on: boolean) => void;
  onGuidesChange: (on: boolean) => void;
}> = ({
  editor,
  document,
  page,
  pageIndex,
  brandReady,
  brand,
  setPageId,
  setLayerId,
  onCancel,
  onReloadLatest,
  snap,
  guides,
  onSnapChange,
  onGuidesChange,
}) => {
  const t = useT();
  const modals = useModals();
  const [conflictHidden, setConflictHidden] = useState(false);
  useEffect(() => {
    if (!editor.conflict) {
      setConflictHidden(false);
    }
  }, [editor.conflict]);
  const limits = contentStudioDesignEditorLimits(document, page.id);
  const missing = useMemo(
    () =>
      document.brandKit && brandReady
        ? missingContentStudioDesignBrandTokens(document, brand)
        : { colors: [], typography: [] },
    [document, brand, brandReady]
  );
  const tooMuchText =
    contentStudioDesignTextLength(document) > DESIGN_TOTAL_TEXT_MAX;
  const brandBlocked =
    !!document.brandKit &&
    (!brandReady || !!missing.colors.length || !!missing.typography.length);
  const busy = editor.saving;
  // a canvas gesture in progress is finished before anything else
  const held = busy || editor.interacting;
  const add = (kind: 'text' | 'rectangle' | 'ellipse') => {
    const layerId = editor.apply((latest) => {
      const added = addContentStudioDesignLayer(latest, page.id, kind);
      return { document: added.document, result: added.layerId };
    });
    if (layerId) {
      setLayerId(layerId);
    }
  };
  const addImage = () =>
    modals.openModal({
      title: t('content_studio_design_add_image', 'Add image'),
      children: (close: () => void) => (
        <DesignMediaPicker
          close={close}
          onPicked={(ref) => {
            const layerId = editor.apply((latest) => {
              const added = addContentStudioDesignImageLayer(
                latest,
                page.id,
                ref
              );
              return { document: added.document, result: added.layerId };
            });
            if (layerId) {
              setLayerId(layerId);
            }
          }}
        />
      ),
    });
  const pageAction = (
    run: (latest: ContentStudioDesignDocumentV1) => {
      document: ContentStudioDesignDocumentV1;
      pageId?: string;
    }
  ) => {
    const next = editor.apply((latest) => {
      const outcome = run(latest);
      return { document: outcome.document, result: outcome.pageId };
    });
    if (next) {
      setPageId(next);
      setLayerId(null);
    }
  };

  const openVariants = (campaign: boolean) =>
    modals.openModal({
      title: campaign
        ? t(
            'content_studio_design_variant_campaign',
            'Create campaign variants'
          )
        : t('content_studio_design_variant_one', 'Duplicate as size'),
      children: (close: () => void) => (
        <DesignPageVariantDialog
          editor={editor}
          page={page}
          campaign={campaign}
          close={close}
          onCreated={(pageId) => {
            setPageId(pageId);
            setLayerId(null);
          }}
        />
      ),
    });

  return (
    <div className="flex flex-col gap-[8px] border border-newTableBorder rounded-[8px] p-[12px]">
      {editor.conflict && !conflictHidden && (
        <div role="alert" className="flex flex-col gap-[6px]">
          <div className="font-[600]">
            {t(
              'content_studio_design_conflict_title',
              'This design changed while you were editing.'
            )}
          </div>
          <div className="text-[13px]">
            {t(
              'content_studio_design_conflict_hint',
              'Reload the latest revision before saving. Your unsaved changes are still open in this browser.'
            )}
          </div>
          <div className="flex flex-wrap gap-[8px]">
            <Button secondary onClick={onReloadLatest}>
              {t('content_studio_reload_latest', 'Reload latest')}
            </Button>
            <Button secondary onClick={() => setConflictHidden(true)}>
              {t('content_studio_design_keep_editing', 'Keep editing')}
            </Button>
          </div>
        </div>
      )}
      <div
        role="toolbar"
        aria-label={t('content_studio_design_editor', 'Design editor')}
        className="flex flex-wrap gap-[8px] items-center"
      >
        <Button
          loading={busy}
          disabled={
            held ||
            !editor.dirty ||
            editor.conflict ||
            brandBlocked ||
            tooMuchText
          }
          onClick={editor.save}
        >
          {t('save', 'Save')}
        </Button>
        <Button secondary disabled={held} onClick={onCancel}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button
          secondary
          disabled={held || !editor.canUndo}
          onClick={editor.undo}
        >
          {t('content_studio_design_undo', 'Undo')}
        </Button>
        <Button
          secondary
          disabled={held || !editor.canRedo}
          onClick={editor.redo}
        >
          {t('content_studio_design_redo', 'Redo')}
        </Button>
        <label className="flex items-center gap-[6px] text-[13px]">
          <input
            type="checkbox"
            role="switch"
            aria-checked={snap}
            checked={snap}
            onChange={(e) => onSnapChange(e.target.checked)}
          />
          {t('content_studio_design_snap', 'Snap')}
        </label>
        <label className="flex items-center gap-[6px] text-[13px]">
          <input
            type="checkbox"
            role="switch"
            aria-checked={guides}
            checked={guides}
            onChange={(e) => onGuidesChange(e.target.checked)}
          />
          {t('content_studio_design_guides', 'Guides')}
        </label>
      </div>
      <div className="flex flex-wrap gap-[8px] items-center">
        <Button
          secondary
          disabled={busy || !limits.canAddLayer}
          onClick={() => add('text')}
        >
          {t('content_studio_design_add_text', 'Add text')}
        </Button>
        <Button
          secondary
          disabled={busy || !limits.canAddLayer}
          onClick={() => add('rectangle')}
        >
          {t('content_studio_design_add_rectangle', 'Add rectangle')}
        </Button>
        <Button
          secondary
          disabled={busy || !limits.canAddLayer}
          onClick={() => add('ellipse')}
        >
          {t('content_studio_design_add_ellipse', 'Add ellipse')}
        </Button>
        <Button
          secondary
          disabled={busy || !limits.canAddLayer}
          onClick={addImage}
        >
          {t('content_studio_design_add_image', 'Add image')}
        </Button>
      </div>
      <div className="flex flex-wrap gap-[8px] items-center">
        <Button
          secondary
          disabled={busy || !limits.canAddPage}
          onClick={() =>
            pageAction((latest) => addContentStudioDesignPage(latest, page.id))
          }
        >
          {t('content_studio_design_add_page', 'Add page')}
        </Button>
        <Button
          secondary
          disabled={busy || !limits.canDuplicatePage}
          onClick={() =>
            pageAction((latest) =>
              duplicateContentStudioDesignPage(latest, page.id)
            )
          }
        >
          {t('content_studio_design_duplicate_page', 'Duplicate page')}
        </Button>
        <Button
          secondary
          disabled={busy || !limits.canAddPage}
          onClick={() => openVariants(false)}
        >
          {t('content_studio_design_variant_one', 'Duplicate as size')}
        </Button>
        <Button
          secondary
          disabled={busy || !limits.canAddPage}
          onClick={() => openVariants(true)}
        >
          {t(
            'content_studio_design_variant_campaign',
            'Create campaign variants'
          )}
        </Button>
        <Button
          secondary
          disabled={busy || !limits.canDeletePage}
          onClick={() =>
            pageAction((latest) =>
              deleteContentStudioDesignPage(latest, page.id)
            )
          }
        >
          {t('content_studio_design_delete_page', 'Delete page')}
        </Button>
        <Button
          secondary
          disabled={busy || pageIndex === 0}
          onClick={() =>
            pageAction((latest) => ({
              document: moveContentStudioDesignPage(latest, page.id, -1),
              pageId: page.id,
            }))
          }
        >
          {t('content_studio_design_move_page_up', 'Move page up')}
        </Button>
        <Button
          secondary
          disabled={busy || pageIndex === document.pages.length - 1}
          onClick={() =>
            pageAction((latest) => ({
              document: moveContentStudioDesignPage(latest, page.id, 1),
              pageId: page.id,
            }))
          }
        >
          {t('content_studio_design_move_page_down', 'Move page down')}
        </Button>
      </div>
      <div className="text-[12px] text-textItemBlur flex flex-col gap-[2px]">
        <span>
          {t(
            'content_studio_design_edit_hint',
            'Changes stay in this browser tab until you save them as a new revision. Rendering uses saved revisions only.'
          )}
        </span>
        {!limits.canAddPage && (
          <span>
            {t(
              'content_studio_design_edit_page_limit',
              'A design can have up to 25 pages.'
            )}
          </span>
        )}
        {!limits.canAddLayer && (
          <span>
            {t(
              'content_studio_design_edit_layer_limit',
              'This page or design has reached its layer limit.'
            )}
          </span>
        )}
        {tooMuchText && (
          <span role="alert">
            {t(
              'content_studio_design_too_much_text',
              'This design contains too much text.'
            )}
          </span>
        )}
        {brandBlocked && (
          <span role="alert">
            {t(
              'content_studio_design_edit_brand_missing',
              'This Brand Kit revision does not contain all tokens used by the design.'
            )}
          </span>
        )}
        {editor.conflict && (
          <span>
            {t(
              'content_studio_design_conflict_blocked',
              'Saving is blocked until you reload the latest revision.'
            )}
          </span>
        )}
      </div>
    </div>
  );
};

const ALIGN_OPTIONS = (t: Translate) => [
  { value: 'left', label: t('content_studio_design_align_left', 'Left') },
  { value: 'center', label: t('content_studio_design_align_center', 'Center') },
  { value: 'right', label: t('content_studio_design_align_right', 'Right') },
];
const VERTICAL_OPTIONS = (t: Translate) => [
  { value: 'top', label: t('content_studio_design_align_top', 'Top') },
  { value: 'middle', label: t('content_studio_design_align_middle', 'Middle') },
  { value: 'bottom', label: t('content_studio_design_align_bottom', 'Bottom') },
];
const OVERFLOW_OPTIONS = (t: Translate) => [
  { value: 'clip', label: t('content_studio_design_overflow_clip', 'Clip') },
  {
    value: 'shrink',
    label: t('content_studio_design_overflow_shrink', 'Shrink to fit'),
  },
];
// where the image is held when it is cropped (fit cover)
const FOCAL_PRESETS = (t: Translate) => [
  { label: t('content_studio_design_focal_center', 'Center'), x: 0.5, y: 0.5 },
  { label: t('content_studio_design_focal_top', 'Top'), x: 0.5, y: 0 },
  { label: t('content_studio_design_focal_bottom', 'Bottom'), x: 0.5, y: 1 },
  { label: t('content_studio_design_focal_left', 'Left'), x: 0, y: 0.5 },
  { label: t('content_studio_design_focal_right', 'Right'), x: 1, y: 0.5 },
];

// a small command button, for rows of related commands
const COMMAND =
  'px-[8px] h-[28px] rounded-[6px] border border-newTableBorder text-[12px] disabled:opacity-50';

const FIT_OPTIONS = (t: Translate) => [
  { value: 'cover', label: t('content_studio_design_fit_cover', 'Cover') },
  {
    value: 'contain',
    label: t('content_studio_design_fit_contain', 'Contain'),
  },
];

// The focal point of an image, by pointing (P4-14): the box stands for the
// whole image, 0..1 across and down. A press-drag-release is one change,
// committed on release; the marker follows the pointer meanwhile. Arrow keys
// move it by 0.05 (0.01 with Shift), a run of presses one way being one
// undo step. With Contain the focal point is kept but not used, so the
// picker rests. Only the 0..1 values are stored, nothing of the screen
const DesignFocalPointPicker: FC<{
  editor: ContentStudioDesignEditor;
  layer: ContentStudioDesignImageLayer;
  disabled: boolean;
}> = ({ editor, layer, disabled }) => {
  const t = useT();
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const resting = disabled || layer.fit === 'contain';
  const shown = drag ?? layer.focalPoint;
  const commit = (point: { x: number; y: number }, runKey?: string) =>
    editor.apply(
      (latest) => ({
        document: updateContentStudioDesignLayer(latest, layer.id, {
          focalPoint: point,
        }),
      }),
      runKey
    );
  const pointAt = (event: PointerEvent<HTMLButtonElement>) =>
    contentStudioDesignFocalPointAt(
      event.currentTarget.getBoundingClientRect(),
      event.clientX,
      event.clientY
    );
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  return (
    <div className="flex flex-col gap-[4px] min-w-0">
      <button
        type="button"
        data-focal-picker=""
        disabled={resting}
        aria-label={`${t(
          'content_studio_design_focal_picker',
          'Focal point picker'
        )}: X ${percent(shown.x)}, Y ${percent(shown.y)}`}
        className="relative w-full h-[90px] rounded-[6px] border border-newTableBorder bg-newTableBorder/40 disabled:opacity-50 touch-none"
        onPointerDown={(event) => {
          const point = pointAt(event);
          if (!point) {
            return;
          }
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDrag(point);
        }}
        onPointerMove={(event) => {
          const point = drag && pointAt(event);
          if (point) {
            setDrag(point);
          }
        }}
        onPointerUp={(event) => {
          const point = drag && (pointAt(event) ?? drag);
          setDrag(null);
          if (
            point &&
            (point.x !== layer.focalPoint.x || point.y !== layer.focalPoint.y)
          ) {
            commit(point);
          }
        }}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 0.01 : 0.05;
          const move: Record<string, [number, number]> = {
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
            ArrowUp: [0, -step],
            ArrowDown: [0, step],
          };
          const delta = move[event.key];
          if (!delta) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          commit(
            nudgeContentStudioDesignFocalPoint(
              layer.focalPoint,
              delta[0],
              delta[1]
            ),
            `focal:${layer.id}:${event.key}:${step}`
          );
        }}
      >
        <span
          aria-hidden="true"
          data-focal-marker=""
          className="absolute w-[12px] h-[12px] -ml-[6px] -mt-[6px] rounded-full border-[2px] border-textColor bg-newBgColorInner pointer-events-none"
          style={{ left: percent(shown.x), top: percent(shown.y) }}
        />
      </button>
      <span className="text-[12px] text-textItemBlur">
        {layer.fit === 'contain'
          ? t(
              'content_studio_design_focal_contain',
              'Contain shows the whole image: the focal point is kept for Cover.'
            )
          : t(
              'content_studio_design_focal_hint',
              'Point at the part of the image Cover should keep in view, or use the arrow keys.'
            )}
      </span>
    </div>
  );
};

// The shape an image is cut to (P4-14), in its box: the box itself, a
// rounded rectangle with a radius in design units (presets, or the field)
// or an ellipse filling the box. One choice is one change; Media, fit, focal
// point and geometry stay
const DesignImageFrameControls: FC<{
  editor: ContentStudioDesignEditor;
  layer: ContentStudioDesignImageLayer;
  disabled: boolean;
}> = ({ editor, layer, disabled }) => {
  const t = useT();
  const type = layer.mask?.type ?? 'rectangle';
  const radius =
    layer.mask?.type === 'roundedRectangle' ? layer.mask.cornerRadius : null;
  const pill = contentStudioDesignImagePillRadius(layer);
  const setMask = (mask: ContentStudioDesignImageMask | null) =>
    editor.apply((latest) => ({
      document: setContentStudioDesignImageMask(latest, layer.id, mask),
    }));
  const rounded = (cornerRadius: number) =>
    setMask({ type: 'roundedRectangle', cornerRadius });
  const frames = [
    {
      value: 'rectangle',
      label: t('content_studio_design_frame_rectangle', 'Rectangle'),
      apply: () => setMask(null),
    },
    {
      value: 'roundedRectangle',
      label: t('content_studio_design_frame_rounded', 'Rounded'),
      apply: () => rounded(Math.min(DESIGN_IMAGE_MASK_DEFAULT_RADIUS, pill)),
    },
    {
      value: 'ellipse',
      label: t('content_studio_design_frame_ellipse', 'Ellipse'),
      apply: () => setMask({ type: 'ellipse' }),
    },
  ];
  return (
    <div className="flex flex-col gap-[6px] min-w-0">
      <div
        role="group"
        aria-label={t('content_studio_design_frame', 'Frame')}
        className="flex flex-wrap gap-[6px]"
      >
        {frames.map((frame) => (
          <button
            key={frame.value}
            type="button"
            className={COMMAND}
            disabled={disabled}
            aria-pressed={type === frame.value}
            aria-label={`${t('content_studio_design_frame', 'Frame')} ${
              frame.label
            }`}
            onClick={() => type !== frame.value && frame.apply()}
          >
            {frame.label}
          </button>
        ))}
      </div>
      {radius !== null && (
        <>
          <DesignNumberField
            label={t('content_studio_design_frame_radius', 'Frame radius')}
            value={radius}
            min={0}
            max={DESIGN_CORNER_RADIUS_MAX}
            disabled={disabled}
            onCommit={(cornerRadius) => rounded(cornerRadius)}
          />
          <div
            role="group"
            aria-label={t(
              'content_studio_design_frame_radius_presets',
              'Frame radius presets'
            )}
            className="flex flex-wrap gap-[6px]"
          >
            {(
              [
                [8, t('content_studio_design_frame_small', 'Small')],
                [24, t('content_studio_design_frame_medium', 'Medium')],
                [48, t('content_studio_design_frame_large', 'Large')],
                [pill, t('content_studio_design_corner_pill', 'Pill')],
              ] as const
            ).map(([value, name]) => (
              <button
                key={name}
                type="button"
                className={COMMAND}
                disabled={disabled}
                aria-pressed={radius === value}
                aria-label={`${t(
                  'content_studio_design_frame_radius',
                  'Frame radius'
                )} ${name}`}
                onClick={() => radius !== value && rounded(value)}
              >
                {name}
              </button>
            ))}
          </div>
          <span className="text-[12px] text-textItemBlur">
            {t(
              'content_studio_design_frame_radius_hint',
              'Drawn at most half the shorter side of the box.'
            )}
          </span>
        </>
      )}
    </div>
  );
};

// The inspector while editing: the page's name and background (its size
// stays), or every field of the selected layer, each committed as one step
export const DesignEditableInspector: FC<{
  editor: ContentStudioDesignEditor;
  document: ContentStudioDesignDocumentV1;
  page: ContentStudioDesignPage;
  layer: ContentStudioDesignLayer | null;
  brand: ContentStudioBrandKitContentV1 | null;
  setLayerId: (id: string | null) => void;
}> = ({ editor, document, page, layer, brand, setLayerId }) => {
  const t = useT();
  const modals = useModals();
  const disabled = editor.saving;
  const updatePage = (
    patch: Parameters<typeof updateContentStudioDesignPage>[2]
  ) =>
    editor.apply((latest) => ({
      document: updateContentStudioDesignPage(latest, page.id, patch),
    }));
  const update = (patch: ContentStudioDesignLayerPatch) =>
    layer &&
    editor.apply((latest) => ({
      document: updateContentStudioDesignLayer(latest, layer.id, patch),
    }));
  // the literal colors of the draft, for the color swatches
  const palette = contentStudioDesignDocumentColors(document);

  if (!layer) {
    return (
      <div className="flex flex-col gap-[10px]">
        <DesignTextField
          label={t('content_studio_design_page_name', 'Page name')}
          value={page.name}
          max={DESIGN_PAGE_NAME_MAX}
          disabled={disabled}
          onCommit={(name) => updatePage({ name })}
        />
        <div className="text-[13px]">
          {t('content_studio_design_size', 'Size')}: {page.width} ×{' '}
          {page.height}
          <div className="text-[12px] text-textItemBlur">
            {t(
              'content_studio_design_size_fixed',
              'The page size cannot be changed.'
            )}
          </div>
        </div>
        <DesignColorField
          label={t('content_studio_design_background', 'Background')}
          value={page.background.color}
          brand={brand}
          disabled={disabled}
          palette={palette}
          onCommit={(background) => updatePage({ background })}
        />
      </div>
    );
  }

  const moves = contentStudioDesignLayerMoves(document, layer.id);
  const move = (direction: ContentStudioDesignLayerMove) =>
    editor.apply((latest) => ({
      document: moveContentStudioDesignLayer(latest, layer.id, direction),
    }));
  const replaceImage = () =>
    modals.openModal({
      title: t('content_studio_design_replace_image', 'Replace image'),
      children: (close: () => void) => (
        <DesignMediaPicker
          close={close}
          // the reference only: box, fit, focal point and the rest stay
          onPicked={(ref) =>
            editor.apply((latest) => ({
              document: updateContentStudioDesignLayer(latest, layer.id, {
                imageRef: {
                  type: 'media',
                  mediaId: ref.mediaId,
                  sha256: ref.sha256,
                },
              }),
            }))
          }
        />
      ),
    });

  return (
    <div className="flex flex-col gap-[10px]">
      <DesignTextField
        label={t('content_studio_design_layer_name', 'Layer name')}
        value={layer.name}
        max={DESIGN_LAYER_NAME_MAX}
        disabled={disabled}
        onCommit={(name) => update({ name })}
      />
      <div className="grid grid-cols-2 gap-[8px]">
        <DesignNumberField
          label="X"
          value={layer.x}
          min={-DESIGN_COORDINATE_MAX}
          max={DESIGN_COORDINATE_MAX}
          disabled={disabled}
          onCommit={(x) => update({ x })}
        />
        <DesignNumberField
          label="Y"
          value={layer.y}
          min={-DESIGN_COORDINATE_MAX}
          max={DESIGN_COORDINATE_MAX}
          disabled={disabled}
          onCommit={(y) => update({ y })}
        />
        <DesignNumberField
          label={t('content_studio_design_width', 'Width')}
          value={layer.width}
          min={0}
          aboveMin
          max={DESIGN_COORDINATE_MAX}
          disabled={disabled}
          onCommit={(width) => update({ width })}
        />
        <DesignNumberField
          label={t('content_studio_design_height', 'Height')}
          value={layer.height}
          min={0}
          aboveMin
          max={DESIGN_COORDINATE_MAX}
          disabled={disabled}
          onCommit={(height) => update({ height })}
        />
        <DesignNumberField
          label={t('content_studio_design_rotation', 'Rotation')}
          value={layer.rotation}
          min={-DESIGN_ROTATION_MAX}
          max={DESIGN_ROTATION_MAX}
          disabled={disabled}
          onCommit={(rotation) => update({ rotation })}
        />
        <DesignNumberField
          label={t('content_studio_design_opacity', 'Opacity')}
          value={layer.opacity}
          min={0}
          max={1}
          step={0.05}
          disabled={disabled}
          onCommit={(opacity) => update({ opacity })}
        />
      </div>
      <label className="flex items-center gap-[8px] text-[14px]">
        <input
          type="checkbox"
          checked={layer.visible}
          disabled={disabled}
          onChange={(e) => update({ visible: e.target.checked })}
        />
        {t('content_studio_design_visible', 'Visible')}
      </label>

      {layer.type === 'text' && (
        <>
          <DesignTextArea
            label={t('content_studio_design_text', 'Text')}
            value={layer.text}
            disabled={disabled}
            onCommit={(text) => update({ text })}
          />
          <DesignFontField
            value={layer.font}
            brand={brand}
            disabled={disabled}
            onCommit={(font) => update({ font })}
          />
          <div
            role="group"
            aria-label={t(
              'content_studio_design_font_size_steps',
              'Font size steps'
            )}
            className="flex flex-wrap gap-[6px]"
          >
            {(
              [
                [
                  -2,
                  t('content_studio_design_font_smaller', 'Decrease font size'),
                  'A−',
                ],
                [
                  2,
                  t('content_studio_design_font_larger', 'Increase font size'),
                  'A+',
                ],
              ] as const
            ).map(([step, name, mark]) => (
              <button
                key={step}
                type="button"
                className={COMMAND}
                disabled={
                  disabled ||
                  (step < 0
                    ? layer.fontSize <= DESIGN_FONT_SIZE_MIN
                    : layer.fontSize >= DESIGN_FONT_SIZE_MAX)
                }
                aria-label={name}
                // presses in a row are one undo step
                onClick={() =>
                  editor.apply((latest) => {
                    const current = latest.pages
                      .flatMap((entry) => entry.layers)
                      .find((entry) => entry.id === layer.id);
                    const size =
                      current?.type === 'text'
                        ? current.fontSize
                        : layer.fontSize;
                    return {
                      document: updateContentStudioDesignLayer(
                        latest,
                        layer.id,
                        {
                          fontSize: Math.min(
                            DESIGN_FONT_SIZE_MAX,
                            Math.max(DESIGN_FONT_SIZE_MIN, size + step)
                          ),
                        }
                      ),
                    };
                  }, `font-size:${layer.id}`)
                }
              >
                {mark}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-[8px]">
            <DesignNumberField
              label={t('content_studio_design_font_size', 'Font size')}
              value={layer.fontSize}
              min={DESIGN_FONT_SIZE_MIN}
              max={DESIGN_FONT_SIZE_MAX}
              disabled={disabled}
              onCommit={(fontSize) => update({ fontSize })}
            />
            <DesignNumberField
              label={t('content_studio_design_line_height', 'Line height')}
              value={layer.lineHeight}
              min={DESIGN_LINE_HEIGHT_MIN}
              max={DESIGN_LINE_HEIGHT_MAX}
              step={0.05}
              disabled={disabled}
              onCommit={(lineHeight) => update({ lineHeight })}
            />
            <DesignNumberField
              label={t(
                'content_studio_design_letter_spacing',
                'Letter spacing'
              )}
              value={layer.letterSpacing}
              min={-DESIGN_LETTER_SPACING_MAX}
              max={DESIGN_LETTER_SPACING_MAX}
              disabled={disabled}
              onCommit={(letterSpacing) => update({ letterSpacing })}
            />
          </div>
          <ChoiceField
            label={t('content_studio_design_alignment', 'Alignment')}
            value={layer.align}
            options={ALIGN_OPTIONS(t)}
            disabled={disabled}
            onChange={(align) => update({ align: align as 'left' })}
          />
          <div
            role="group"
            aria-label={t(
              'content_studio_design_alignment_quick',
              'Text alignment'
            )}
            className="flex flex-wrap gap-[6px]"
          >
            {ALIGN_OPTIONS(t).map((option) => (
              <button
                key={option.value}
                type="button"
                className={COMMAND}
                disabled={disabled}
                aria-pressed={layer.align === option.value}
                aria-label={`${t(
                  'content_studio_design_align_text',
                  'Align text'
                )} ${option.label}`}
                onClick={() =>
                  layer.align !== option.value &&
                  update({ align: option.value as 'left' })
                }
              >
                {option.label}
              </button>
            ))}
          </div>
          <ChoiceField
            label={t(
              'content_studio_design_vertical_alignment',
              'Vertical alignment'
            )}
            value={layer.verticalAlign}
            options={VERTICAL_OPTIONS(t)}
            disabled={disabled}
            onChange={(verticalAlign) =>
              update({ verticalAlign: verticalAlign as 'top' })
            }
          />
          <ChoiceField
            label={t('content_studio_design_overflow', 'Overflow')}
            value={layer.overflow}
            options={OVERFLOW_OPTIONS(t)}
            disabled={disabled}
            onChange={(overflow) => update({ overflow: overflow as 'clip' })}
          />
          <DesignColorField
            label={t('content_studio_design_color', 'Color')}
            value={layer.color}
            brand={brand}
            disabled={disabled}
            palette={palette}
            onCommit={(color) => update({ color })}
          />
        </>
      )}
      {layer.type === 'shape' && (
        <>
          <DesignColorField
            label={t('content_studio_design_fill', 'Fill')}
            value={layer.fill}
            brand={brand}
            disabled={disabled}
            palette={palette}
            onCommit={(fill) => update({ fill })}
          />
          {layer.shape === 'rectangle' && (
            <>
              <DesignNumberField
                label={t(
                  'content_studio_design_corner_radius',
                  'Corner radius'
                )}
                value={layer.cornerRadius}
                min={0}
                max={DESIGN_CORNER_RADIUS_MAX}
                disabled={disabled}
                onCommit={(cornerRadius) => update({ cornerRadius })}
              />
              <div
                role="group"
                aria-label={t(
                  'content_studio_design_corner_presets',
                  'Corner presets'
                )}
                className="flex flex-wrap gap-[6px]"
              >
                {(
                  [
                    [0, t('content_studio_design_corner_square', 'Square')],
                    [16, t('content_studio_design_corner_rounded', 'Rounded')],
                    [
                      // half the shorter side: the renderer limits it there
                      Math.min(
                        DESIGN_CORNER_RADIUS_MAX,
                        Math.round(Math.min(layer.width, layer.height) / 2)
                      ),
                      t('content_studio_design_corner_pill', 'Pill'),
                    ],
                  ] as const
                ).map(([radius, name]) => (
                  <button
                    key={name}
                    type="button"
                    className={COMMAND}
                    disabled={disabled}
                    aria-pressed={layer.cornerRadius === radius}
                    aria-label={`${t(
                      'content_studio_design_corners',
                      'Corners'
                    )} ${name}`}
                    onClick={() =>
                      layer.cornerRadius !== radius &&
                      update({ cornerRadius: radius })
                    }
                  >
                    {name}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
      {layer.type === 'image' && (
        <>
          <ChoiceField
            label={t('content_studio_design_fit', 'Fit')}
            value={layer.fit}
            options={FIT_OPTIONS(t)}
            disabled={disabled}
            onChange={(fit) => update({ fit: fit as 'cover' })}
          />
          <div
            role="group"
            aria-label={t('content_studio_design_fit_options', 'Fit options')}
            className="flex flex-wrap gap-[6px]"
          >
            {FIT_OPTIONS(t).map((option) => (
              <button
                key={option.value}
                type="button"
                className={COMMAND}
                disabled={disabled}
                aria-pressed={layer.fit === option.value}
                aria-label={`${t('content_studio_design_fit', 'Fit')} ${
                  option.label
                }`}
                // the focal point stays, also with Contain
                onClick={() =>
                  layer.fit !== option.value &&
                  update({ fit: option.value as 'cover' })
                }
              >
                {option.label}
              </button>
            ))}
          </div>
          <DesignFocalPointPicker
            editor={editor}
            layer={layer}
            disabled={disabled}
          />
          <div className="grid grid-cols-2 gap-[8px]">
            <DesignNumberField
              label={t('content_studio_design_focal_x', 'Focal point X')}
              value={layer.focalPoint.x}
              min={0}
              max={1}
              step={0.01}
              disabled={disabled}
              onCommit={(x) =>
                update({ focalPoint: { ...layer.focalPoint, x } })
              }
            />
            <DesignNumberField
              label={t('content_studio_design_focal_y', 'Focal point Y')}
              value={layer.focalPoint.y}
              min={0}
              max={1}
              step={0.01}
              disabled={disabled}
              onCommit={(y) =>
                update({ focalPoint: { ...layer.focalPoint, y } })
              }
            />
          </div>
          <div
            role="group"
            aria-label={t(
              'content_studio_design_focal_presets',
              'Focal point presets'
            )}
            className="flex flex-wrap gap-[6px]"
          >
            {FOCAL_PRESETS(t).map((preset) => (
              <button
                key={preset.label}
                type="button"
                disabled={disabled}
                aria-label={`${t(
                  'content_studio_design_focal_point',
                  'Focal point'
                )} ${preset.label}`}
                className={COMMAND}
                onClick={() =>
                  update({ focalPoint: { x: preset.x, y: preset.y } })
                }
              >
                {preset.label}
              </button>
            ))}
          </div>
          <DesignImageFrameControls
            editor={editor}
            layer={layer}
            disabled={disabled}
          />
          <Button secondary disabled={disabled} onClick={replaceImage}>
            {t('content_studio_design_replace_image', 'Replace image')}
          </Button>
        </>
      )}

      <div className="flex flex-wrap gap-[6px]">
        <Button
          secondary
          disabled={disabled || !moves.forward}
          onClick={() => move('forward')}
        >
          {t('content_studio_design_bring_forward', 'Bring forward')}
        </Button>
        <Button
          secondary
          disabled={disabled || !moves.backward}
          onClick={() => move('backward')}
        >
          {t('content_studio_design_send_backward', 'Send backward')}
        </Button>
        <Button
          secondary
          disabled={disabled || !moves.front}
          onClick={() => move('front')}
        >
          {t('content_studio_design_bring_to_front', 'Bring to front')}
        </Button>
        <Button
          secondary
          disabled={disabled || !moves.back}
          onClick={() => move('back')}
        >
          {t('content_studio_design_send_to_back', 'Send to back')}
        </Button>
      </div>
      <div className="flex flex-wrap gap-[6px]">
        <Button
          secondary
          disabled={disabled}
          onClick={() => {
            const copy = editor.apply((latest) => {
              const duplicated = duplicateContentStudioDesignLayer(
                latest,
                layer.id
              );
              return {
                document: duplicated.document,
                result: duplicated.layerId,
              };
            });
            if (copy) {
              setLayerId(copy);
            }
          }}
        >
          {t('content_studio_design_duplicate_layer', 'Duplicate layer')}
        </Button>
        <Button
          secondary
          disabled={disabled}
          onClick={() => {
            editor.apply((latest) => ({
              document: deleteContentStudioDesignLayer(latest, layer.id),
            }));
            setLayerId(null);
          }}
        >
          {t('content_studio_design_delete_layer', 'Delete layer')}
        </Button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Arranging: alignment, distribution and the editor's own layer clipboard
// ---------------------------------------------------------------------------

const ALIGN_TO_PAGE = (t: Translate) =>
  [
    ['left', t('content_studio_design_align_page_left', 'Align to page left')],
    [
      'centerX',
      t(
        'content_studio_design_align_page_center_x',
        'Align to page horizontal center'
      ),
    ],
    [
      'right',
      t('content_studio_design_align_page_right', 'Align to page right'),
    ],
    ['top', t('content_studio_design_align_page_top', 'Align to page top')],
    [
      'centerY',
      t(
        'content_studio_design_align_page_center_y',
        'Align to page vertical center'
      ),
    ],
    [
      'bottom',
      t('content_studio_design_align_page_bottom', 'Align to page bottom'),
    ],
  ] as Array<[ContentStudioDesignAlignEdge, string]>;

const ALIGN_SELECTION = (t: Translate) =>
  [
    [
      'left',
      t('content_studio_design_align_selection_left', 'Align selection left'),
    ],
    [
      'centerX',
      t(
        'content_studio_design_align_selection_center_x',
        'Align selection horizontal centers'
      ),
    ],
    [
      'right',
      t('content_studio_design_align_selection_right', 'Align selection right'),
    ],
    [
      'top',
      t('content_studio_design_align_selection_top', 'Align selection top'),
    ],
    [
      'centerY',
      t(
        'content_studio_design_align_selection_center_y',
        'Align selection vertical centers'
      ),
    ],
    [
      'bottom',
      t(
        'content_studio_design_align_selection_bottom',
        'Align selection bottom'
      ),
    ],
  ] as Array<[ContentStudioDesignAlignEdge, string]>;

// the short text of an alignment button; its full name is its label
const EDGE_TEXT = (
  t: Translate
): Record<ContentStudioDesignAlignEdge, string> => ({
  left: t('content_studio_design_align_left', 'Left'),
  centerX: t('content_studio_design_align_center', 'Center'),
  right: t('content_studio_design_align_right', 'Right'),
  top: t('content_studio_design_align_top', 'Top'),
  centerY: t('content_studio_design_align_middle', 'Middle'),
  bottom: t('content_studio_design_align_bottom', 'Bottom'),
});

const CENTER_ON_PAGE = (t: Translate) =>
  [
    [
      'horizontal',
      t('content_studio_design_center_horizontal', 'Horizontally'),
      t(
        'content_studio_design_center_horizontal_label',
        'Center selection on page horizontally'
      ),
    ],
    [
      'vertical',
      t('content_studio_design_center_vertical', 'Vertically'),
      t(
        'content_studio_design_center_vertical_label',
        'Center selection on page vertically'
      ),
    ],
    [
      'both',
      t('content_studio_design_center_both', 'Both'),
      t('content_studio_design_center_both_label', 'Center selection on page'),
    ],
  ] as Array<[ContentStudioDesignCenterAxis, string, string]>;

// a gap in design units, within the coordinate limits; may be negative
const gapValue = (value: string) => {
  const gap = value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(gap) && Math.abs(gap) <= DESIGN_COORDINATE_MAX
    ? gap
    : null;
};

// Composition (P4-15): the chosen layers moved together onto the page
// (centered, or moved inside it), and two or more spaced by an exact gap,
// or set out as a row, a column or a grid in the page's order. Each command
// is one undo step for every layer it moves, and refuses it all when a
// layer would leave the design limits. Boxes are moved, never resized: a
// rotated layer is placed by its stored, unrotated box
const DesignCompositionControls: FC<{
  editor: ContentStudioDesignEditor;
  layerIds: string[];
}> = ({ editor, layerIds }) => {
  const t = useT();
  const disabled = editor.saving || editor.interacting;
  const [gapText, setGapText] = useState('24');
  const [columnsText, setColumnsText] = useState('2');
  const gap = gapValue(gapText);
  const columns = Number(columnsText);
  const columnsOk =
    Number.isInteger(columns) && columns >= 1 && columns <= layerIds.length;
  const run = (
    operation: (
      latest: ContentStudioDesignDocumentV1
    ) => ContentStudioDesignDocumentV1
  ) => editor.apply((latest) => ({ document: operation(latest) }));
  const several = layerIds.length > 1;
  return (
    <div
      role="group"
      aria-label={t('content_studio_design_composition', 'Composition')}
      className="flex flex-col gap-[6px]"
    >
      <span className="text-[12px] text-textItemBlur">
        {t('content_studio_design_center_on_page', 'Center on page')}
      </span>
      <div className="flex flex-wrap gap-[4px]">
        {CENTER_ON_PAGE(t).map(([axis, text, name]) => (
          <button
            key={axis}
            type="button"
            aria-label={name}
            title={name}
            disabled={disabled}
            className={COMMAND}
            onClick={() =>
              run((latest) =>
                centerContentStudioDesignLayersOnPage(latest, layerIds, axis)
              )
            }
          >
            {text}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          className={COMMAND}
          title={t(
            'content_studio_design_move_into_page_hint',
            'Moves the selection inside the page; nothing is resized.'
          )}
          onClick={() =>
            run((latest) =>
              moveContentStudioDesignLayersIntoPage(latest, layerIds)
            )
          }
        >
          {t('content_studio_design_move_into_page', 'Move into page')}
        </button>
      </div>
      {several && (
        <>
          <div className="flex gap-[8px] items-end">
            <label className="flex flex-col gap-[4px] text-[12px] min-w-0 flex-1">
              {t('content_studio_design_gap', 'Gap')}
              <input
                type="number"
                inputMode="decimal"
                className={FIELD}
                value={gapText}
                aria-invalid={gap === null}
                disabled={disabled}
                onChange={(e) => setGapText(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-[4px] text-[12px] min-w-0 flex-1">
              {t('content_studio_design_grid_columns', 'Columns')}
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={layerIds.length}
                step={1}
                className={FIELD}
                value={columnsText}
                aria-invalid={!columnsOk}
                disabled={disabled}
                onChange={(e) => setColumnsText(e.target.value)}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-[4px]">
            <button
              type="button"
              disabled={disabled || gap === null}
              className={COMMAND}
              onClick={() =>
                gap !== null &&
                run((latest) =>
                  spaceContentStudioDesignLayers(
                    latest,
                    layerIds,
                    'horizontal',
                    gap
                  )
                )
              }
            >
              {t(
                'content_studio_design_space_horizontal',
                'Space horizontally'
              )}
            </button>
            <button
              type="button"
              disabled={disabled || gap === null}
              className={COMMAND}
              onClick={() =>
                gap !== null &&
                run((latest) =>
                  spaceContentStudioDesignLayers(
                    latest,
                    layerIds,
                    'vertical',
                    gap
                  )
                )
              }
            >
              {t('content_studio_design_space_vertical', 'Space vertically')}
            </button>
            <button
              type="button"
              disabled={disabled || gap === null}
              className={COMMAND}
              onClick={() =>
                gap !== null &&
                run((latest) =>
                  arrangeContentStudioDesignLayersInRow(latest, layerIds, gap)
                )
              }
            >
              {t('content_studio_design_arrange_row', 'Row')}
            </button>
            <button
              type="button"
              disabled={disabled || gap === null}
              className={COMMAND}
              onClick={() =>
                gap !== null &&
                run((latest) =>
                  arrangeContentStudioDesignLayersInColumn(
                    latest,
                    layerIds,
                    gap
                  )
                )
              }
            >
              {t('content_studio_design_arrange_column', 'Column')}
            </button>
            <button
              type="button"
              disabled={disabled || gap === null || !columnsOk}
              className={COMMAND}
              onClick={() =>
                gap !== null &&
                columnsOk &&
                run((latest) =>
                  arrangeContentStudioDesignLayersInGrid(
                    latest,
                    layerIds,
                    columns,
                    gap,
                    gap
                  )
                )
              }
            >
              {t('content_studio_design_arrange_grid', 'Grid')}
            </button>
          </div>
          <span className="text-[11px] text-textItemBlur">
            {t(
              'content_studio_design_arrange_order_hint',
              'Row, column and grid follow the layer order, back to front.'
            )}
          </span>
        </>
      )}
    </div>
  );
};

// The commands for the chosen layers of the page: one layer lines up with
// the page, two or more with the box around them, three or more can be
// distributed; each command is one undo step for every layer it moves. Copy
// takes one layer into this workspace's own clipboard (never the system
// one); Paste puts it on this page under a new id
export const DesignArrangePanel: FC<{
  editor: ContentStudioDesignEditor;
  layerIds: string[];
  canCopy: boolean;
  canPaste: boolean;
  onCopy: () => void;
  onPaste: () => void;
}> = ({ editor, layerIds, canCopy, canPaste, onCopy, onPaste }) => {
  const t = useT();
  const disabled = editor.saving || editor.interacting;
  const text = EDGE_TEXT(t);
  const group = (
    label: string,
    commands: Array<[ContentStudioDesignAlignEdge, string]>,
    run: (edge: ContentStudioDesignAlignEdge) => void
  ) => (
    <div role="group" aria-label={label} className="flex flex-col gap-[4px]">
      <span className="text-[12px] text-textItemBlur">{label}</span>
      <div className="flex flex-wrap gap-[4px]">
        {commands.map(([edge, name]) => (
          <button
            key={edge}
            type="button"
            aria-label={name}
            title={name}
            disabled={disabled}
            className={COMMAND}
            onClick={() => run(edge)}
          >
            {text[edge]}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-[10px]">
      {layerIds.length === 1 &&
        group(
          t('content_studio_design_align_to_page', 'Align to page'),
          ALIGN_TO_PAGE(t),
          (edge) =>
            editor.apply((latest) => ({
              document: alignContentStudioDesignLayerToPage(
                latest,
                layerIds[0],
                edge
              ),
            }))
        )}
      {layerIds.length > 1 &&
        group(
          t('content_studio_design_align_selection', 'Align selection'),
          ALIGN_SELECTION(t),
          (edge) =>
            editor.apply((latest) => ({
              document: alignContentStudioDesignLayers(latest, layerIds, edge),
            }))
        )}
      {layerIds.length > 2 && (
        <div
          role="group"
          aria-label={t('content_studio_design_distribute', 'Distribute')}
          className="flex flex-wrap gap-[4px]"
        >
          <button
            type="button"
            disabled={disabled}
            className={COMMAND}
            onClick={() =>
              editor.apply((latest) => ({
                document: distributeContentStudioDesignLayers(
                  latest,
                  layerIds,
                  'horizontal'
                ),
              }))
            }
          >
            {t(
              'content_studio_design_distribute_horizontal',
              'Distribute horizontally'
            )}
          </button>
          <button
            type="button"
            disabled={disabled}
            className={COMMAND}
            onClick={() =>
              editor.apply((latest) => ({
                document: distributeContentStudioDesignLayers(
                  latest,
                  layerIds,
                  'vertical'
                ),
              }))
            }
          >
            {t(
              'content_studio_design_distribute_vertical',
              'Distribute vertically'
            )}
          </button>
        </div>
      )}
      {layerIds.length > 0 && (
        <DesignCompositionControls editor={editor} layerIds={layerIds} />
      )}
      <div className="flex flex-wrap gap-[4px]">
        <button
          type="button"
          disabled={disabled || !canCopy}
          className={COMMAND}
          onClick={onCopy}
        >
          {t('content_studio_design_copy_layer', 'Copy layer')}
        </button>
        <button
          type="button"
          disabled={disabled || !canPaste}
          className={COMMAND}
          onClick={onPaste}
        >
          {t('content_studio_design_paste_layer', 'Paste layer')}
        </button>
      </div>
    </div>
  );
};
