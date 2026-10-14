'use client';

import { FC, FormEvent, useCallback, useRef, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  ContentStudioProject,
  contentStudioErrorMessage,
  PROJECT_NAME_MAX,
  useContentStudioActions,
  useContentStudioFilters,
  useContentStudioProjects,
} from '@gitroom/frontend/components/content-studio/content-studio.api';

// One write at a time per modal: a second click while a request runs does
// nothing
export const useSingleFlight = () => {
  const running = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async (id: string, task: () => Promise<void>) => {
    if (running.current) {
      return;
    }
    running.current = true;
    setBusy(id);
    try {
      await task();
    } finally {
      running.current = false;
      setBusy(null);
    }
  }, []);
  return { busy, run };
};

const ActiveProjectRow: FC<{
  project: ContentStudioProject;
  busy: boolean;
  onRename: (name: string) => Promise<boolean>;
  onArchive: () => void;
}> = ({ project, busy, onRename, onArchive }) => {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);

  const save = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!name.trim()) {
        return;
      }
      if (await onRename(name.trim())) {
        setEditing(false);
      }
    },
    [name, onRename]
  );

  if (editing) {
    return (
      <form onSubmit={save} className="flex flex-wrap items-end gap-[8px]">
        <div className="flex-1 min-w-[160px]">
          <Input
            label="Name"
            translationKey="content_studio_project_name"
            name="name"
            aria-label={t('content_studio_project_name', 'Project name')}
            disableForm={true}
            removeError={true}
            value={name}
            maxLength={PROJECT_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <Button type="submit" loading={busy} disabled={busy || !name.trim()}>
          {t('save', 'Save')}
        </Button>
        <Button
          type="button"
          secondary
          onClick={() => {
            setName(project.name);
            setEditing(false);
          }}
        >
          {t('cancel', 'Cancel')}
        </Button>
      </form>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-[8px]">
      <div className="flex-1 min-w-[120px] break-words">{project.name}</div>
      <Button
        secondary
        disabled={busy}
        aria-label={`${t('content_studio_rename', 'Rename')} ${project.name}`}
        onClick={() => setEditing(true)}
      >
        {t('content_studio_rename', 'Rename')}
      </Button>
      <Button
        secondary
        loading={busy}
        disabled={busy}
        aria-label={`${t('content_studio_archive', 'Archive')} ${project.name}`}
        onClick={onArchive}
      >
        {t('content_studio_archive', 'Archive')}
      </Button>
    </div>
  );
};

// Create, rename, archive and restore projects. Archiving a project keeps
// its packages as they are
export const ContentStudioProjectsModal: FC = () => {
  const t = useT();
  const toaster = useToaster();
  const actions = useContentStudioActions();
  const { filters, setFilters } = useContentStudioFilters();
  const { data: activeProjects, isLoading: activeLoading } =
    useContentStudioProjects(false);
  const { data: archivedProjects, isLoading: archivedLoading } =
    useContentStudioProjects(true);
  const [newName, setNewName] = useState('');
  const { busy, run } = useSingleFlight();

  const failed = useCallback(
    (err: unknown) =>
      toaster.show(contentStudioErrorMessage(t, err), 'warning'),
    [toaster, t]
  );

  const create = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const name = newName.trim();
      if (!name) {
        return;
      }
      await run('new', async () => {
        try {
          await actions.createProject(name);
          setNewName('');
        } catch (err) {
          failed(err);
        }
      });
    },
    [newName, actions, run, failed]
  );

  const rename = useCallback(
    (id: string) => async (name: string) => {
      let renamed = false;
      await run(id, async () => {
        try {
          await actions.renameProject(id, name);
          renamed = true;
        } catch (err) {
          failed(err);
        }
      });
      return renamed;
    },
    [actions, run, failed]
  );

  const archive = useCallback(
    (project: ContentStudioProject) => async () => {
      if (
        !(await deleteDialog(
          t(
            'content_studio_project_archive_hint',
            'Archive this project? Packages in it will remain available.'
          ),
          t('content_studio_archive', 'Archive'),
          t('content_studio_archive_project', 'Archive project'),
          t('cancel', 'Cancel')
        ))
      ) {
        return;
      }
      await run(project.id, async () => {
        try {
          await actions.archiveProject(project.id);
          // the list stops filtering on it
          if (filters.projectId === project.id) {
            setFilters({ projectId: undefined });
          }
        } catch (err) {
          failed(err);
        }
      });
    },
    [actions, run, failed, filters, setFilters, t]
  );

  const restore = useCallback(
    (project: ContentStudioProject) => () =>
      run(project.id, async () => {
        try {
          await actions.restoreProject(project.id);
        } catch (err) {
          failed(err);
        }
      }),
    [actions, run, failed]
  );

  return (
    <div className="flex flex-col gap-[24px] min-w-0">
      <form onSubmit={create} className="flex flex-wrap items-end gap-[8px]">
        <div className="flex-1 min-w-[160px]">
          <Input
            label="New project"
            translationKey="content_studio_new_project"
            name="name"
            aria-label={t('content_studio_new_project', 'New project')}
            disableForm={true}
            removeError={true}
            value={newName}
            maxLength={PROJECT_NAME_MAX}
            onChange={(e) => setNewName(e.target.value)}
          />
        </div>
        <Button
          type="submit"
          loading={busy === 'new'}
          disabled={!!busy || !newName.trim()}
        >
          {t('content_studio_create_project', 'Create project')}
        </Button>
      </form>

      <section className="flex flex-col gap-[12px]">
        <h3 className="text-[16px] font-[600]">
          {t('content_studio_active_projects', 'Active projects')}
        </h3>
        {activeLoading ? (
          <div>{t('loading', 'Loading')}</div>
        ) : !activeProjects?.length ? (
          <div className="text-textItemBlur">
            {t('content_studio_no_projects', 'No projects yet.')}
          </div>
        ) : (
          activeProjects.map((project) => (
            <ActiveProjectRow
              key={project.id}
              project={project}
              busy={busy === project.id}
              onRename={rename(project.id)}
              onArchive={archive(project)}
            />
          ))
        )}
      </section>

      <section className="flex flex-col gap-[12px]">
        <h3 className="text-[16px] font-[600]">
          {t('content_studio_archived_projects', 'Archived projects')}
        </h3>
        {archivedLoading ? (
          <div>{t('loading', 'Loading')}</div>
        ) : !archivedProjects?.length ? (
          <div className="text-textItemBlur">
            {t('content_studio_no_archived_projects', 'No archived projects.')}
          </div>
        ) : (
          archivedProjects.map((project) => (
            <div
              key={project.id}
              className="flex flex-wrap items-center gap-[8px]"
            >
              <div className="flex-1 min-w-[120px] break-words">
                {project.name}
              </div>
              <Button
                secondary
                loading={busy === project.id}
                disabled={busy === project.id}
                aria-label={`${t('content_studio_restore', 'Restore')} ${
                  project.name
                }`}
                onClick={restore(project)}
              >
                {t('content_studio_restore', 'Restore')}
              </Button>
            </div>
          ))
        )}
      </section>
    </div>
  );
};
