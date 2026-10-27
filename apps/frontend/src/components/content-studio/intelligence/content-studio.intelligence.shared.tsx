'use client';

import { FC, ReactNode, useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import dayjs from 'dayjs';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';
import { useSingleFlight } from '@gitroom/frontend/components/content-studio/content-studio.projects.modal';
import {
  ContentStudioDialogLayout,
  useConfirmDiscardChanges,
  useUnsavedChangesWarning,
} from '@gitroom/frontend/components/content-studio/content-studio.dialog';
import {
  ContentStudioProfileKind,
  ContentStudioProfileRevisionSummary,
  ContentStudioProfilesPath,
  ContentStudioProfileSummary,
  isRevisionConflict,
  PROFILE_NAME_MAX,
  profileErrorMessage,
  useContentStudioProfile,
  useContentStudioProfileActions,
  useContentStudioProfiles,
  useContentStudioRevisionDetail,
  useContentStudioRevisionPage,
} from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.api';

// The structured editor of one kind of content. Read-only when disabled: the
// same fields, without anything that changes them
export type ContentStudioContentForm<C> = FC<{
  value: C;
  onChange: (next: C) => void;
  disabled?: boolean;
}>;

export const formatDate = (date: string) =>
  dayjs(date).format('MMM D, YYYY HH:mm');

// A labelled group of fields
export const FieldGroup: FC<{
  label: string;
  hint?: string;
  children: ReactNode;
}> = ({ label, hint, children }) => (
  <fieldset className="flex flex-col gap-[8px] min-w-0">
    <legend className="text-[14px] font-[600] mb-[4px]">{label}</legend>
    {!!hint && <div className="text-[12px] text-textItemBlur">{hint}</div>}
    {children}
  </fieldset>
);

// Splits pasted or typed text into entries: one per line, and per semicolon;
// per comma too for lists of single words or short phrases. Blank pieces are
// left out; nothing else is changed but the outer spaces
export const splitListEntries = (text: string, commas: boolean) =>
  text
    .split(commas ? /[\r\n;,]+/ : /[\r\n;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

// The entries to add to a list: new ones only, in order, up to its limit
export const addListEntries = (
  values: string[],
  entries: string[],
  max: number
) => {
  const next = [...values];
  for (const entry of entries) {
    if (next.length >= max) {
      break;
    }
    if (!next.includes(entry)) {
      next.push(entry);
    }
  }
  return next;
};

// A list of short texts, kept in order. Enter adds what was typed; a pasted
// list (one entry per line) adds every entry at once; and what is still in
// the field when it loses focus (a click on Save included) is added too, so
// a typed entry is never lost. The server checks the limits and refuses
// duplicates; nothing is cut here beyond the outer spaces of an entry.
// chips shows short entries (tags, words) side by side
export const StringListEditor: FC<{
  label: string;
  hint?: string;
  values: string[];
  max: number;
  onChange: (next: string[]) => void;
  disabled?: boolean;
  chips?: boolean;
  // more under an entry, such as the reason a word is avoided
  renderDetail?: (value: string) => ReactNode;
}> = ({
  label,
  hint,
  values,
  max,
  onChange,
  disabled,
  chips,
  renderDetail,
}) => {
  const t = useT();
  const [draft, setDraft] = useState('');
  const full = values.length >= max;

  const add = useCallback(
    (text: string) => {
      const entries = splitListEntries(text, !!chips);
      if (!entries.length) {
        setDraft('');
        return;
      }
      const next = addListEntries(values, entries, max);
      if (next.length !== values.length) {
        onChange(next);
      }
      setDraft('');
    },
    [values, max, onChange, chips]
  );

  const remove = (index: number) =>
    onChange(values.filter((_, other) => other !== index));

  return (
    <FieldGroup label={label} hint={hint}>
      {!values.length ? (
        <div className="text-[14px] text-textItemBlur">
          {t('content_studio_list_empty', 'None yet.')}
        </div>
      ) : chips && !renderDetail ? (
        <ul className="flex flex-wrap gap-[6px]">
          {values.map((value, index) => (
            <li
              key={`${index}-${value}`}
              className="flex items-center gap-[6px] max-w-full border border-newTableBorder rounded-full ps-[12px] pe-[6px] py-[4px] text-[14px]"
            >
              <span className="min-w-0 break-words">{value}</span>
              {!disabled && (
                <button
                  type="button"
                  className="w-[22px] h-[22px] shrink-0 flex items-center justify-center rounded-full hover:bg-boxFocused"
                  aria-label={`${t(
                    'content_studio_remove_entry',
                    'Remove'
                  )} ${value}`}
                  onClick={() => remove(index)}
                >
                  <span aria-hidden="true">{'\u00d7'}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <ul className="flex flex-col gap-[6px]">
          {values.map((value, index) => (
            <li
              key={`${index}-${value}`}
              className="flex flex-col gap-[4px] border border-newTableBorder rounded-[8px] px-[12px] py-[8px]"
            >
              <div className="flex items-start gap-[8px]">
                <span className="flex-1 min-w-0 whitespace-pre-wrap break-words">
                  {value}
                </span>
                {!disabled && (
                  <button
                    type="button"
                    className="text-[13px] underline shrink-0"
                    aria-label={`${t(
                      'content_studio_remove_entry',
                      'Remove'
                    )} ${value}`}
                    onClick={() => remove(index)}
                  >
                    {t('content_studio_remove_entry', 'Remove')}
                  </button>
                )}
              </div>
              {renderDetail?.(value)}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <div className="flex flex-col gap-[4px]">
          <div className="flex flex-wrap items-center gap-[8px]">
            <div className="flex-1 min-w-[160px]">
              <Input
                label=""
                name={`new-${label}`}
                aria-label={`${t('content_studio_new_entry', 'New')} ${label}`}
                disableForm={true}
                removeError={true}
                value={draft}
                disabled={full}
                placeholder={
                  full
                    ? t('content_studio_list_full', 'This list is full.')
                    : t(
                        'content_studio_list_placeholder',
                        'Type and press Enter'
                      )
                }
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    add(draft);
                  }
                }}
                onPaste={(e) => {
                  const pasted = e.clipboardData.getData('text');
                  // one plain entry is pasted into the field as usual
                  if (splitListEntries(pasted, !!chips).length > 1) {
                    e.preventDefault();
                    add(`${draft}\n${pasted}`);
                  }
                }}
                onBlur={() => add(draft)}
              />
            </div>
            <Button
              secondary
              aria-label={`${t('content_studio_add_entry', 'Add')} ${label}`}
              disabled={!draft.trim() || full}
              onClick={() => add(draft)}
            >
              {t('content_studio_add_entry', 'Add')}
            </Button>
          </div>
          <div className="text-[12px] text-textItemBlur">
            {t(
              'content_studio_list_input_hint',
              'Press Enter to add. Paste a list to add every line at once.'
            )}{' '}
            {values.length}/{max}
          </div>
        </div>
      )}
    </FieldGroup>
  );
};

// A long text, kept as typed: inner line breaks and spacing are content
export const LongTextField: FC<{
  label: string;
  hint?: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  rows?: number;
}> = ({ label, hint, value, onChange, disabled, rows = 4 }) => (
  <FieldGroup label={label} hint={hint}>
    <textarea
      aria-label={label}
      className="bg-newBgColorInner min-h-[96px] p-[12px] outline-none border-newTableBorder border rounded-[8px] text-textColor text-[14px] disabled:opacity-60"
      rows={rows}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  </FieldGroup>
);

// A one-line text
export const ShortTextField: FC<{
  label: string;
  hint?: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}> = ({ label, hint, value, onChange, disabled }) => (
  <FieldGroup label={label} hint={hint}>
    <Input
      label=""
      name={label}
      aria-label={label}
      disableForm={true}
      removeError={true}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  </FieldGroup>
);

// A choice from a fixed list
export const ChoiceField: FC<{
  label: string;
  hint?: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (next: string) => void;
  disabled?: boolean;
}> = ({ label, hint, value, options, onChange, disabled }) => (
  <FieldGroup label={label} hint={hint}>
    <select
      aria-label={label}
      className="bg-newBgColorInner h-[42px] px-[12px] border-newTableBorder border rounded-[8px] text-textColor text-[14px] disabled:opacity-60"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  </FieldGroup>
);

// Shown after a save was refused because the content changed elsewhere.
// Nothing is saved again until the latest version is loaded
export const ConflictNotice: FC<{
  message: string;
  onReload: () => void;
  busy?: boolean;
}> = ({ message, onReload, busy }) => {
  const t = useT();
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-[12px] border border-newTableBorder rounded-[8px] p-[12px]"
    >
      <div className="flex-1 min-w-[200px]">{message}</div>
      <Button secondary loading={busy} disabled={busy} onClick={onReload}>
        {t('content_studio_reload_latest', 'Reload latest')}
      </Button>
    </div>
  );
};

// The saved versions, newest first, one server page at a time, and one
// version read-only. Nothing here changes, restores or deletes a version:
// every change is a new version saved from the latest one
export const ContentStudioRevisionHistory = <C,>({
  base,
  id,
  Form,
}: {
  base: string;
  id?: string;
  Form: ContentStudioContentForm<C>;
}) => {
  const t = useT();
  const [page, setPage] = useState(1);
  const [viewing, setViewing] =
    useState<ContentStudioProfileRevisionSummary | null>(null);
  const list = useContentStudioRevisionPage(base, id, page);
  const detail = useContentStudioRevisionDetail<C>(
    base,
    id,
    viewing?.id ?? null
  );

  if (viewing) {
    return (
      <div className="flex flex-col gap-[16px]">
        <div className="flex flex-wrap items-center gap-[8px]">
          <h3 className="flex-1 font-[600]">
            {t('content_studio_revision', 'Version')} {viewing.revisionNumber}
          </h3>
          <Button secondary onClick={() => setViewing(null)}>
            {t('content_studio_back_to_history', 'Back to history')}
          </Button>
        </div>
        {detail.error ? (
          <div>
            {t('content_studio_load_error', 'Could not load Content Studio.')}
          </div>
        ) : !detail.data ? (
          <LoadingComponent width={40} height={40} />
        ) : (
          <Form value={detail.data.content} onChange={() => {}} disabled />
        )}
      </div>
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
        {t('content_studio_no_saved_versions', 'No saved versions yet.')}
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
              <div className="font-[600]">
                {t('content_studio_revision', 'Version')}{' '}
                {revision.revisionNumber}
              </div>
              <div className="text-[12px] text-textItemBlur flex flex-wrap gap-x-[12px]">
                <span>{formatDate(revision.createdAt)}</span>
                <span title={revision.contentHash}>
                  {revision.contentHash.slice(0, 12)}
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

// The query parameter of the open editor: new, or the id of a profile
export const PROFILE_PARAM = 'profile';
const PROFILE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What one kind of named profile (writing, audience, expertise) needs from
// the shared list and editor
export interface NamedProfileConfig<C> {
  kind: Exclude<ContentStudioProfileKind, 'editorial'>;
  base: ContentStudioProfilesPath;
  // already translated
  labels: {
    newProfile: string;
    empty: string;
    emptyArchived: string;
    content: string;
    // the way back from the editor to the list
    back: string;
    // what a profile of this kind is for, on the empty list
    emptyHint?: string;
  };
  empty: () => C;
  Form: ContentStudioContentForm<C>;
  // shown above the list and the editor
  note?: string;
}

const ProfileNameField: FC<{
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}> = ({ value, onChange, disabled }) => {
  const t = useT();
  return (
    <Input
      label="Name"
      translationKey="content_studio_profile_name"
      name="name"
      aria-label={t('content_studio_profile_name', 'Name')}
      disableForm={true}
      removeError={true}
      value={value}
      maxLength={PROFILE_NAME_MAX}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
};

// The actions at the end of an in-page editor. The same actions sit in its
// header, so Save is in reach at the top and at the bottom of a long form
export const EditorActions: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="pt-[16px] border-t border-newTableBorder flex flex-wrap items-center justify-end gap-[8px]">
    {children}
  </div>
);

// The top of an in-page editor: the way back to the list, what is edited and
// its actions
const EditorHeader: FC<{
  backLabel: string;
  onBack: () => void;
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
}> = ({ backLabel, onBack, title, meta, actions }) => (
  <div className="flex flex-col gap-[6px]">
    <button
      type="button"
      className="w-fit text-[13px] text-textItemBlur hover:underline hover:text-newTextColor"
      onClick={onBack}
    >
      {'\u2190'} {backLabel}
    </button>
    <div className="flex flex-wrap items-center gap-[8px]">
      <h2 className="flex-1 min-w-[200px] text-[18px] font-[600] break-words">
        {title}
      </h2>
      {meta}
      {!!actions && <div className="flex flex-wrap gap-[8px]">{actions}</div>}
    </div>
  </div>
);

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

// A new profile, on its own page: its name and first content, saved together
// as version 1. Save returns to the list
const CreateProfile = <C,>({
  config,
  close,
}: {
  config: NamedProfileConfig<C>;
  close: () => void;
}) => {
  const t = useT();
  const toaster = useToaster();
  const actions = useContentStudioProfileActions(config.base);
  const confirmDiscard = useConfirmDiscardChanges();
  const [name, setName] = useState('');
  const [initial] = useState<C>(config.empty);
  const [content, setContent] = useState<C>(initial);
  const [saved, setSaved] = useState(false);
  const { busy, run } = useSingleFlight();
  const dirty = !saved && (!!name.trim() || !sameJson(content, initial));
  useUnsavedChangesWarning(dirty);

  const cancel = async () => {
    if (!dirty || (await confirmDiscard())) {
      close();
    }
  };

  const create = () =>
    run('create', async () => {
      try {
        await actions.createProfile(name.trim(), content);
        setSaved(true);
        toaster.show(
          t('content_studio_profile_created', 'Profile created.'),
          'success'
        );
        close();
      } catch (err) {
        // the input stays as typed, to correct and try again
        toaster.show(profileErrorMessage(t, config.kind, err), 'warning');
      }
    });

  const buttons = (
    <>
      <Button secondary onClick={cancel}>
        {t('cancel', 'Cancel')}
      </Button>
      <Button
        loading={busy === 'create'}
        disabled={!!busy || !name.trim()}
        onClick={create}
      >
        {t('content_studio_save_profile', 'Save')}
      </Button>
    </>
  );

  return (
    <section
      aria-label={config.labels.newProfile}
      className="flex flex-col gap-[20px] min-w-0"
    >
      <EditorHeader
        backLabel={config.labels.back}
        onBack={cancel}
        title={config.labels.newProfile}
        actions={buttons}
      />
      {!!config.note && (
        <div className="text-[13px] text-textItemBlur">{config.note}</div>
      )}
      <ProfileNameField value={name} onChange={setName} />
      <config.Form value={content} onChange={setContent} />
      <EditorActions>
        {!name.trim() && (
          <span className="text-[13px] text-textItemBlur me-auto">
            {t(
              'content_studio_profile_name_required',
              'Give the profile a name to save it.'
            )}
          </span>
        )}
        {buttons}
      </EditorActions>
    </section>
  );
};

// An existing profile, on its own page. One Save stores what changed: a new
// name (a rename is not a version) and new content (a new version over the
// one it was loaded from), then returns to the list. If the profile changed
// elsewhere since, the content is refused and the latest version has to be
// loaded first
const EditProfile = <C,>({
  config,
  id,
  close,
}: {
  config: NamedProfileConfig<C>;
  id: string;
  close: () => void;
}) => {
  const t = useT();
  const toaster = useToaster();
  const actions = useContentStudioProfileActions(config.base);
  const detail = useContentStudioProfile<C>(config.base, id);
  const confirmDiscard = useConfirmDiscardChanges();
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [content, setContent] = useState<C | null>(null);
  const [savedContent, setSavedContent] = useState<C | null>(null);
  const [baseRevision, setBaseRevision] = useState(0);
  const [conflict, setConflict] = useState(false);
  const { busy, run } = useSingleFlight();

  const seed = useCallback((data: NonNullable<typeof detail.data>) => {
    setName(data.name);
    setSavedName(data.name);
    setContent(data.currentRevision.content);
    setSavedContent(data.currentRevision.content);
    setBaseRevision(data.currentRevision.revisionNumber);
    setConflict(false);
    setLoaded(true);
  }, []);

  // seeded once; later reloads only on request
  useEffect(() => {
    if (detail.data && !loaded) {
      seed(detail.data);
    }
  }, [detail.data, loaded, seed]);

  const nameChanged = !!name.trim() && name.trim() !== savedName;
  const contentChanged = !sameJson(content, savedContent);
  const dirty = loaded && (nameChanged || contentChanged);
  useUnsavedChangesWarning(dirty);

  const cancel = async () => {
    if (!dirty || (await confirmDiscard())) {
      close();
    }
  };

  const save = () =>
    run('save', async () => {
      if (!content) {
        return;
      }
      try {
        let saved = false;
        if (nameChanged) {
          await actions.renameProfile(id, name.trim());
          setSavedName(name.trim());
        }
        // a rename alone makes no version; otherwise the server compares
        // the content with the latest version, and refuses a stale one
        if (contentChanged || !nameChanged) {
          const result = await actions.saveRevision(id, baseRevision, content);
          setBaseRevision(result.revision.revisionNumber);
          setSavedContent(content);
          saved = result.created;
        }
        toaster.show(
          saved
            ? t('content_studio_profile_saved', 'Saved as a new version.')
            : nameChanged
            ? t('content_studio_name_saved', 'Name saved.')
            : t('content_studio_no_changes', 'No content changes to save.'),
          'success'
        );
        close();
      } catch (err) {
        if (isRevisionConflict(err)) {
          setConflict(true);
          return;
        }
        toaster.show(profileErrorMessage(t, config.kind, err), 'warning');
      }
    });

  const reload = () =>
    run('reload', async () => {
      const latest = await detail.mutate();
      if (latest) {
        seed(latest);
      }
    });

  if (detail.error && !loaded) {
    return (
      <div className="flex flex-col gap-[16px]">
        <EditorHeader
          backLabel={config.labels.back}
          onBack={close}
          title={config.labels.content}
        />
        <div role="alert">
          {profileErrorMessage(t, config.kind, detail.error)}
        </div>
      </div>
    );
  }
  if (!loaded || !content || !detail.data) {
    return <LoadingComponent width={40} height={40} />;
  }

  const archived = !!detail.data.archivedAt;
  const buttons = archived ? (
    <Button secondary onClick={close}>
      {config.labels.back}
    </Button>
  ) : (
    <>
      <Button secondary onClick={cancel}>
        {t('cancel', 'Cancel')}
      </Button>
      <Button
        loading={busy === 'save'}
        disabled={!!busy || conflict || !name.trim()}
        onClick={save}
      >
        {t('content_studio_save_profile', 'Save')}
      </Button>
    </>
  );
  return (
    <section
      aria-label={savedName}
      className="flex flex-col gap-[20px] min-w-0"
    >
      <EditorHeader
        backLabel={config.labels.back}
        onBack={cancel}
        title={savedName}
        meta={
          <span className="text-[12px] text-textItemBlur">
            {t('content_studio_revision', 'Version')} {baseRevision}
          </span>
        }
        actions={buttons}
      />
      {archived && (
        <div className="border border-newTableBorder rounded-[8px] p-[12px]">
          {t(
            'content_studio_profile_archived_readonly',
            'This profile is archived. Restore it to edit it.'
          )}
        </div>
      )}
      {!!config.note && (
        <div className="text-[13px] text-textItemBlur">{config.note}</div>
      )}
      <ProfileNameField value={name} onChange={setName} disabled={archived} />
      {conflict && (
        <ConflictNotice
          message={t(
            'content_studio_profile_conflict',
            'This profile changed elsewhere. Reload the latest version before saving.'
          )}
          busy={busy === 'reload'}
          onReload={reload}
        />
      )}
      <config.Form value={content} onChange={setContent} disabled={archived} />
      <EditorActions>{buttons}</EditorActions>
    </section>
  );
};

// The profiles of one kind: active or archived, one summary page at a time.
// Every member may create, edit, archive and restore them
export const NamedProfilesSection = <C,>({
  config,
}: {
  config: NamedProfileConfig<C>;
}) => {
  const t = useT();
  const modals = useModals();
  const toaster = useToaster();
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const list = useContentStudioProfiles(config.base, archived, page);
  const actions = useContentStudioProfileActions(config.base);
  const { busy, run } = useSingleFlight();

  const pages = list.data?.pages;
  // a page that no longer exists (after archiving, say) moves to the last one
  useEffect(() => {
    if (pages !== undefined && page > Math.max(pages, 1)) {
      setPage(Math.max(pages, 1));
    }
  }, [pages, page]);

  // the editor is a page of its own (?profile=new or ?profile=<id>), so it
  // has room, survives a reload and the back button leaves it
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const editing = searchParams.get(PROFILE_PARAM);
  const goTo = useCallback(
    (profile: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (profile) {
        params.set(PROFILE_PARAM, profile);
      } else {
        params.delete(PROFILE_PARAM);
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: true });
    },
    [router, pathname, searchParams]
  );
  const openCreate = () => goTo('new');
  const openEditor = (profile: ContentStudioProfileSummary) => goTo(profile.id);
  const openHistory = (profile: ContentStudioProfileSummary) =>
    modals.openModal({
      title: `${t('content_studio_history', 'History')}: ${profile.name}`,
      children: (
        <ContentStudioDialogLayout>
          <ContentStudioRevisionHistory
            base={config.base}
            id={profile.id}
            Form={config.Form}
          />
        </ContentStudioDialogLayout>
      ),
    });

  const archive = async (profile: ContentStudioProfileSummary) => {
    if (
      !(await deleteDialog(
        t(
          'content_studio_profile_archive_hint',
          'This hides the profile from active selection. Revision history is kept.'
        ),
        t('content_studio_archive', 'Archive'),
        t('content_studio_archive_profile', 'Archive profile'),
        t('cancel', 'Cancel')
      ))
    ) {
      return;
    }
    await run(profile.id, async () => {
      try {
        await actions.archiveProfile(profile.id);
        toaster.show(
          t('content_studio_profile_archived', 'Profile archived.'),
          'success'
        );
      } catch (err) {
        toaster.show(profileErrorMessage(t, config.kind, err), 'warning');
      }
    });
  };

  const restore = (profile: ContentStudioProfileSummary) =>
    run(profile.id, async () => {
      try {
        await actions.restoreProfile(profile.id);
        toaster.show(
          t('content_studio_profile_restored', 'Profile restored.'),
          'success'
        );
      } catch (err) {
        toaster.show(profileErrorMessage(t, config.kind, err), 'warning');
      }
    });

  if (editing === 'new') {
    return <CreateProfile config={config} close={() => goTo(null)} />;
  }
  if (editing && PROFILE_ID.test(editing)) {
    return (
      <EditProfile
        key={editing}
        config={config}
        id={editing}
        close={() => goTo(null)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-[16px] min-w-0">
      {!!config.note && (
        <div className="text-[13px] text-textItemBlur">{config.note}</div>
      )}
      <div className="flex flex-wrap items-center gap-[8px]">
        <div
          role="group"
          aria-label={t('content_studio_status', 'Status')}
          className="flex flex-1 gap-[8px]"
        >
          {[false, true].map((value) => (
            <Button
              key={String(value)}
              secondary={archived !== value}
              aria-pressed={archived === value}
              className={clsx(archived === value && 'font-[600]')}
              onClick={() => {
                setArchived(value);
                setPage(1);
              }}
            >
              {value
                ? t('content_studio_archived', 'Archived')
                : t('content_studio_active', 'Active')}
            </Button>
          ))}
        </div>
        <Button onClick={openCreate}>{config.labels.newProfile}</Button>
      </div>
      {list.error ? (
        <div className="flex flex-col items-center gap-[12px] py-[24px]">
          <div>
            {t('content_studio_load_error', 'Could not load Content Studio.')}
          </div>
          <Button secondary onClick={() => list.mutate()}>
            {t('content_studio_retry', 'Try again')}
          </Button>
        </div>
      ) : !list.data ? (
        <LoadingComponent />
      ) : !list.data.results.length ? (
        <div className="flex flex-col items-center gap-[12px] py-[32px] text-center">
          <div className="font-[600]">
            {archived ? config.labels.emptyArchived : config.labels.empty}
          </div>
          {!archived && !!config.labels.emptyHint && (
            <div className="max-w-[520px] text-[14px] text-textItemBlur">
              {config.labels.emptyHint}
            </div>
          )}
          {!archived && (
            <Button onClick={openCreate}>{config.labels.newProfile}</Button>
          )}
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-[8px]">
            {list.data.results.map((profile) => (
              <li
                key={profile.id}
                className="flex flex-wrap items-center gap-[8px] border border-newTableBorder rounded-[8px] p-[12px]"
              >
                <div className="flex flex-col gap-[2px] flex-1 min-w-[200px]">
                  <div className="font-[600] break-words">{profile.name}</div>
                  <div className="text-[12px] text-textItemBlur flex flex-wrap gap-x-[12px]">
                    <span>
                      {t('content_studio_revision', 'Version')}{' '}
                      {profile.latestRevisionNumber}
                    </span>
                    <span>{formatDate(profile.updatedAt)}</span>
                  </div>
                </div>
                <Button
                  secondary
                  aria-label={`${
                    archived
                      ? t('content_studio_view_profile', 'View')
                      : t('content_studio_edit_profile', 'Edit')
                  } ${profile.name}`}
                  onClick={() => openEditor(profile)}
                >
                  {archived
                    ? t('content_studio_view_profile', 'View')
                    : t('content_studio_edit_profile', 'Edit')}
                </Button>
                <Button
                  secondary
                  aria-label={`${t('content_studio_history', 'History')} ${
                    profile.name
                  }`}
                  onClick={() => openHistory(profile)}
                >
                  {t('content_studio_history', 'History')}
                </Button>
                {archived ? (
                  <Button
                    secondary
                    loading={busy === profile.id}
                    disabled={!!busy}
                    aria-label={`${t('content_studio_restore', 'Restore')} ${
                      profile.name
                    }`}
                    onClick={() => restore(profile)}
                  >
                    {t('content_studio_restore', 'Restore')}
                  </Button>
                ) : (
                  <Button
                    secondary
                    loading={busy === profile.id}
                    disabled={!!busy}
                    aria-label={`${t('content_studio_archive', 'Archive')} ${
                      profile.name
                    }`}
                    onClick={() => archive(profile)}
                  >
                    {t('content_studio_archive', 'Archive')}
                  </Button>
                )}
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
        </>
      )}
    </div>
  );
};
