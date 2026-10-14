'use client';

import { FC, ReactNode, useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
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

// A list of short texts: added one at a time, removed by row, kept in order.
// The server checks the limits and refuses duplicates; nothing is trimmed or
// cut here beyond the outer spaces of a new entry
export const StringListEditor: FC<{
  label: string;
  hint?: string;
  values: string[];
  max: number;
  onChange: (next: string[]) => void;
  disabled?: boolean;
}> = ({ label, hint, values, max, onChange, disabled }) => {
  const t = useT();
  const [draft, setDraft] = useState('');
  const add = useCallback(() => {
    const entry = draft.trim();
    if (!entry || values.length >= max) {
      return;
    }
    onChange([...values, entry]);
    setDraft('');
  }, [draft, values, max, onChange]);

  return (
    <FieldGroup label={label} hint={hint}>
      {!values.length ? (
        <div className="text-[14px] text-textItemBlur">
          {t('content_studio_list_empty', 'None yet.')}
        </div>
      ) : (
        <ul className="flex flex-col gap-[6px]">
          {values.map((value, index) => (
            <li
              key={`${index}-${value}`}
              className="flex items-start gap-[8px] border border-newTableBorder rounded-[8px] px-[12px] py-[8px]"
            >
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
                  )} ${label} ${index + 1}`}
                  onClick={() =>
                    onChange(values.filter((_, other) => other !== index))
                  }
                >
                  {t('content_studio_remove_entry', 'Remove')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <div className="flex flex-wrap items-center gap-[8px]">
          <div className="flex-1 min-w-[160px]">
            <Input
              label=""
              name={`new-${label}`}
              aria-label={`${t('content_studio_new_entry', 'New')} ${label}`}
              disableForm={true}
              removeError={true}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
            />
          </div>
          <Button
            secondary
            aria-label={`${t('content_studio_add_entry', 'Add')} ${label}`}
            disabled={!draft.trim() || values.length >= max}
            onClick={add}
          >
            {t('content_studio_add_entry', 'Add')}
          </Button>
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

// A new profile: its name and first content, saved together as version 1
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
  const [name, setName] = useState('');
  const [content, setContent] = useState<C>(config.empty);
  const { busy, run } = useSingleFlight();

  const create = () =>
    run('create', async () => {
      try {
        await actions.createProfile(name.trim(), content);
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

  return (
    <div className="flex flex-col gap-[16px] min-w-0">
      {!!config.note && (
        <div className="text-[13px] text-textItemBlur">{config.note}</div>
      )}
      <ProfileNameField value={name} onChange={setName} />
      <config.Form value={content} onChange={setContent} />
      <div className="flex flex-wrap gap-[8px] justify-end">
        <Button secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button
          loading={busy === 'create'}
          disabled={!!busy || !name.trim()}
          onClick={create}
        >
          {t('content_studio_create_profile', 'Create profile')}
        </Button>
      </div>
    </div>
  );
};

// An existing profile. The name and the content are saved separately: a
// rename is not a version, and each save is its own request. Content is
// saved over the version it was loaded from; if the profile changed since,
// the save is refused and the latest version has to be loaded first
const EditProfile = <C,>({
  config,
  id,
}: {
  config: NamedProfileConfig<C>;
  id: string;
}) => {
  const t = useT();
  const toaster = useToaster();
  const actions = useContentStudioProfileActions(config.base);
  const detail = useContentStudioProfile<C>(config.base, id);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [content, setContent] = useState<C | null>(null);
  const [baseRevision, setBaseRevision] = useState(0);
  const [conflict, setConflict] = useState(false);
  const { busy, run } = useSingleFlight();

  const seed = useCallback((data: NonNullable<typeof detail.data>) => {
    setName(data.name);
    setSavedName(data.name);
    setContent(data.currentRevision.content);
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

  const failed = (err: unknown) => {
    if (isRevisionConflict(err)) {
      setConflict(true);
      return;
    }
    toaster.show(profileErrorMessage(t, config.kind, err), 'warning');
  };

  const rename = () =>
    run('name', async () => {
      try {
        await actions.renameProfile(id, name.trim());
        setSavedName(name.trim());
        toaster.show(t('content_studio_name_saved', 'Name saved.'), 'success');
      } catch (err) {
        failed(err);
      }
    });

  const save = () =>
    run('content', async () => {
      if (!content) {
        return;
      }
      try {
        const result = await actions.saveRevision(id, baseRevision, content);
        setBaseRevision(result.revision.revisionNumber);
        toaster.show(
          result.created
            ? t('content_studio_profile_saved', 'Saved as a new version.')
            : t('content_studio_no_changes', 'No content changes to save.'),
          'success'
        );
      } catch (err) {
        failed(err);
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
    return <div>{profileErrorMessage(t, config.kind, detail.error)}</div>;
  }
  if (!loaded || !content || !detail.data) {
    return <LoadingComponent width={40} height={40} />;
  }

  const archived = !!detail.data.archivedAt;
  return (
    <div className="flex flex-col gap-[20px] min-w-0">
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
      <section className="flex flex-wrap items-end gap-[8px]">
        <div className="flex-1 min-w-[200px]">
          <ProfileNameField
            value={name}
            onChange={setName}
            disabled={archived}
          />
        </div>
        {!archived && (
          <Button
            secondary
            loading={busy === 'name'}
            disabled={!!busy || !name.trim() || name.trim() === savedName}
            onClick={rename}
          >
            {t('content_studio_save_name', 'Save name')}
          </Button>
        )}
      </section>
      <section className="flex flex-col gap-[16px]">
        <div className="flex flex-wrap items-center gap-[8px]">
          <h3 className="flex-1 font-[600]">{config.labels.content}</h3>
          <span className="text-[12px] text-textItemBlur">
            {t('content_studio_revision', 'Version')} {baseRevision}
          </span>
        </div>
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
        <config.Form
          value={content}
          onChange={setContent}
          disabled={archived}
        />
        {!archived && (
          <div className="flex justify-end">
            <Button
              loading={busy === 'content'}
              disabled={!!busy || conflict}
              onClick={save}
            >
              {t('content_studio_save_profile', 'Save')}
            </Button>
          </div>
        )}
      </section>
    </div>
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

  const openCreate = () =>
    modals.openModal({
      title: config.labels.newProfile,
      children: (close: () => void) => (
        <CreateProfile config={config} close={close} />
      ),
    });
  const openEditor = (profile: ContentStudioProfileSummary) =>
    modals.openModal({
      title: profile.name,
      children: <EditProfile config={config} id={profile.id} />,
    });
  const openHistory = (profile: ContentStudioProfileSummary) =>
    modals.openModal({
      title: `${t('content_studio_history', 'History')}: ${profile.name}`,
      children: (
        <ContentStudioRevisionHistory
          base={config.base}
          id={profile.id}
          Form={config.Form}
        />
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
        <div className="py-[24px] text-center">
          {archived ? config.labels.emptyArchived : config.labels.empty}
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
