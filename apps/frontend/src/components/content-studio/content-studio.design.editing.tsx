'use client';

import {
  FC,
  KeyboardEvent,
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
  applyContentStudioDesignHistory,
  areContentStudioDesignDocumentsEqual,
  cloneContentStudioDesignDocument,
  ContentStudioDesignEditorError,
  ContentStudioDesignEditorHistory,
  ContentStudioDesignLayerMove,
  ContentStudioDesignLayerPatch,
  contentStudioDesignEditorLimits,
  contentStudioDesignLayerMoves,
  contentStudioDesignTextLength,
  deleteContentStudioDesignLayer,
  deleteContentStudioDesignPage,
  duplicateContentStudioDesignLayer,
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
    default:
      return t(
        'content_studio_design_edit_failed',
        'This change could not be applied.'
      );
  }
};

// Typing in a field keeps the field's own undo
const isTextTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable);

// The edit of one design: entered explicitly from the current revision of an
// active design, left by Save, Cancel or a confirmed discard
export const useContentStudioDesignEditor = (designId: string) => {
  const t = useT();
  const toaster = useToaster();
  const { saveDesignRevision } = useContentStudioDesignActions();
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

  // One edit as one undo step. A refused edit leaves the draft as it was
  const apply = useCallback(
    <T,>(
      operation: (document: ContentStudioDesignDocumentV1) => {
        document: ContentStudioDesignDocumentV1;
        result?: T;
      }
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
      commit({
        ...current,
        history: applyContentStudioDesignHistory(
          current.history,
          outcome.document
        ),
      });
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
    !areContentStudioDesignDocumentsEqual(
      state.history.present,
      state.base.document
    );

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
    try {
      const saved = await saveDesignRevision(
        current.designId,
        current.base.revisionNumber,
        content
      );
      toaster.show(
        saved.created
          ? `${t(
              'content_studio_design_saved_as',
              'Design saved as Revision'
            )} ${saved.revision.revisionNumber}.`
          : t('content_studio_design_save_unchanged', 'No changes to save.'),
        'success'
      );
      setConflict(false);
      commit(null);
    } catch (err) {
      if (designErrorCode(err) === 'CS_DESIGN_REVISION_CONFLICT') {
        // the draft stays; it is never sent over the newer revision
        setConflict(true);
      } else {
        toaster.show(designSaveErrorMessage(t, err), 'warning');
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
      if (!(event.metaKey || event.ctrlKey) || isTextTarget(event.target)) {
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
export const DesignColorField: FC<{
  label: string;
  value: ContentStudioDesignColorValue;
  brand: ContentStudioBrandKitContentV1 | null;
  disabled?: boolean;
  onCommit: (value: ContentStudioDesignColorValue) => void;
}> = ({ label, value, brand, disabled, onCommit }) => {
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
const FIT_OPTIONS = (t: Translate) => [
  { value: 'cover', label: t('content_studio_design_fit_cover', 'Cover') },
  {
    value: 'contain',
    label: t('content_studio_design_fit_contain', 'Contain'),
  },
];

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
            onCommit={(fill) => update({ fill })}
          />
          {layer.shape === 'rectangle' && (
            <DesignNumberField
              label={t('content_studio_design_corner_radius', 'Corner radius')}
              value={layer.cornerRadius}
              min={0}
              max={DESIGN_CORNER_RADIUS_MAX}
              disabled={disabled}
              onCommit={(cornerRadius) => update({ cornerRadius })}
            />
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
