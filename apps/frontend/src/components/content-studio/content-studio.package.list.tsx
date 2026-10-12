'use client';

import { FC, useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import dayjs from 'dayjs';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import {
  ContentStudioPackageSummary,
  ContentStudioProject,
  contentStudioErrorMessage,
  packagePath,
  useContentStudioActions,
} from '@gitroom/frontend/components/content-studio/content-studio.api';

const PackageRow: FC<{
  item: ContentStudioPackageSummary;
  projectLabel: string;
  busy: boolean;
  onArchive: () => void;
  onRestore: () => void;
}> = ({ item, projectLabel, busy, onArchive, onRestore }) => {
  const t = useT();
  return (
    <li className="flex flex-wrap items-center gap-[12px] p-[16px] border border-newTableBorder rounded-[8px]">
      <div className="flex flex-col gap-[4px] flex-1 min-w-[200px]">
        <Link
          href={packagePath(item.id)}
          className="text-[16px] font-[600] break-words hover:underline"
        >
          {item.name}
        </Link>
        <div className="flex flex-wrap gap-x-[16px] gap-y-[4px] text-[12px] text-textItemBlur">
          <span>
            {t('content_studio_project', 'Project')}: {projectLabel}
          </span>
          <span>
            {t('content_studio_updated', 'Updated')}:{' '}
            {dayjs(item.updatedAt).format('MMM D, YYYY HH:mm')}
          </span>
          <span>
            {t('content_studio_draft_version', 'Draft version')}:{' '}
            {item.draftVersion}
          </span>
          <span>
            {t('content_studio_revisions', 'Revisions')}:{' '}
            {item.latestRevisionNumber}
          </span>
        </div>
      </div>
      <div className="flex gap-[8px]">
        <Link
          href={packagePath(item.id)}
          aria-label={`${t('content_studio_open', 'Open')} ${item.name}`}
          className="h-[40px] px-[24px] flex items-center rounded-full bg-[var(--brand-primary,#612ad5)] text-[var(--brand-action-text,#fff)]"
        >
          {t('content_studio_open', 'Open')}
        </Link>
        {item.archivedAt ? (
          <Button
            secondary
            loading={busy}
            disabled={busy}
            aria-label={`${t('content_studio_restore', 'Restore')} ${
              item.name
            }`}
            onClick={onRestore}
          >
            {t('content_studio_restore', 'Restore')}
          </Button>
        ) : (
          <Button
            secondary
            loading={busy}
            disabled={busy}
            aria-label={`${t('content_studio_archive', 'Archive')} ${
              item.name
            }`}
            onClick={onArchive}
          >
            {t('content_studio_archive', 'Archive')}
          </Button>
        )}
      </div>
    </li>
  );
};

// Package summaries as the list endpoint returns them. Project names come
// from the project lists, active and archived; nothing more is loaded per row
export const ContentStudioPackageList: FC<{
  packages: ContentStudioPackageSummary[];
  projects: Map<string, ContentStudioProject>;
  projectsLoaded: boolean;
}> = ({ packages, projects, projectsLoaded }) => {
  const t = useT();
  const toaster = useToaster();
  const { archivePackage, restorePackage } = useContentStudioActions();
  const running = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    async (id: string, task: () => Promise<void>) => {
      if (running.current) {
        return;
      }
      running.current = true;
      setBusy(id);
      try {
        await task();
      } catch (err) {
        toaster.show(contentStudioErrorMessage(t, err), 'warning');
      } finally {
        running.current = false;
        setBusy(null);
      }
    },
    [toaster, t]
  );

  const archive = useCallback(
    (id: string) => async () => {
      if (
        await deleteDialog(
          t('content_studio_package_archive_hint', 'Archive this package?'),
          t('content_studio_archive', 'Archive'),
          t('content_studio_archive_package', 'Archive package'),
          t('cancel', 'Cancel')
        )
      ) {
        await run(id, () => archivePackage(id));
      }
    },
    [run, archivePackage, t]
  );

  const projectLabel = (projectId: string | null) => {
    if (!projectId) {
      return t('content_studio_no_project', 'No project');
    }
    const project = projects.get(projectId);
    if (project) {
      return project.archivedAt
        ? `${project.name} (${t('content_studio_archived', 'Archived')})`
        : project.name;
    }
    return projectsLoaded
      ? t('content_studio_unavailable_project', 'Unavailable project')
      : '...';
  };

  return (
    <ul className="flex flex-col gap-[12px]">
      {packages.map((item) => (
        <PackageRow
          key={item.id}
          item={item}
          projectLabel={projectLabel(item.projectId)}
          busy={busy === item.id}
          onArchive={archive(item.id)}
          onRestore={() => run(item.id, () => restorePackage(item.id))}
        />
      ))}
    </ul>
  );
};

// Previous / next over the server's pages (1 based)
export const ContentStudioPager: FC<{
  page: number;
  pages: number;
  setPage: (page: number) => void;
}> = ({ page, pages, setPage }) => {
  const t = useT();
  return (
    <nav
      aria-label={t('content_studio_pages', 'Pages')}
      className="flex items-center justify-center gap-[12px]"
    >
      <Button secondary disabled={page <= 1} onClick={() => setPage(page - 1)}>
        {t('previous', 'Previous')}
      </Button>
      <span aria-current="page">
        {page} / {pages}
      </span>
      <Button
        secondary
        disabled={page >= pages}
        onClick={() => setPage(page + 1)}
      >
        {t('next', 'Next')}
      </Button>
    </nav>
  );
};
