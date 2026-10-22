'use client';

import { FC, useCallback, useEffect, useMemo } from 'react';
import clsx from 'clsx';
import Link from 'next/link';
import { Button } from '@gitroom/react/form/button';
import { Select } from '@gitroom/react/form/select';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import {
  ContentStudioProject,
  ContentStudioRequestError,
  useContentStudioFilters,
  useContentStudioPackages,
  useContentStudioProjects,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import {
  ContentStudioPackageList,
  ContentStudioPager,
} from '@gitroom/frontend/components/content-studio/content-studio.package.list';
import { CreateContentStudioPackageModal } from '@gitroom/frontend/components/content-studio/content-studio.package.modal';
import { ContentStudioProjectsModal } from '@gitroom/frontend/components/content-studio/content-studio.projects.modal';
import { REVIEW_QUEUE_PAGE } from '@gitroom/frontend/components/content-studio/content-studio.reviews.api';
import { RADAR_PAGE } from '@gitroom/frontend/components/content-studio/content-studio.research.api';

// The Content Studio home: packages of the organization, filtered by project
// and archive state on the server, one summary page at a time
export const ContentStudioHome: FC = () => {
  const t = useT();
  const modals = useModals();
  const toaster = useToaster();
  const { filters, setFilters } = useContentStudioFilters();
  const activeProjects = useContentStudioProjects(false);
  const archivedProjects = useContentStudioProjects(true);
  const packages = useContentStudioPackages(filters);

  // archived projects too: an archived project still names its packages
  const projects = useMemo(
    () =>
      new Map<string, ContentStudioProject>(
        [...(activeProjects.data || []), ...(archivedProjects.data || [])].map(
          (project) => [project.id, project]
        )
      ),
    [activeProjects.data, archivedProjects.data]
  );
  const filterProjects = filters.archived
    ? [...(activeProjects.data || []), ...(archivedProjects.data || [])]
    : activeProjects.data || [];

  const pages = packages.data?.pages;
  // a page that no longer exists (after archiving, say) moves to the last one
  useEffect(() => {
    if (pages === undefined) {
      return;
    }
    if (pages === 0 && filters.page > 1) {
      setFilters({ page: 1 });
    } else if (pages > 0 && filters.page > pages) {
      setFilters({ page: pages });
    }
  }, [pages, filters.page]);

  // a project of the URL that doesn't exist (or is another organization's)
  const listError = packages.error;
  useEffect(() => {
    if (
      filters.projectId &&
      listError instanceof ContentStudioRequestError &&
      listError.code === 'CS_NOT_FOUND'
    ) {
      toaster.show(
        t(
          'content_studio_project_not_found',
          'This project could not be found.'
        ),
        'warning'
      );
      setFilters({ projectId: undefined });
    }
  }, [listError, filters.projectId]);

  const newPackage = useCallback(() => {
    modals.openModal({
      title: t('content_studio_new_package', 'New package'),
      children: (close) => (
        <CreateContentStudioPackageModal
          close={close}
          projectId={filters.projectId}
        />
      ),
    });
  }, [modals, filters.projectId, t]);

  const manageProjects = useCallback(() => {
    modals.openModal({
      title: t('content_studio_manage_projects', 'Manage projects'),
      children: <ContentStudioProjectsModal />,
    });
  }, [modals, t]);

  const empty = filters.archived
    ? t('content_studio_no_archived_packages', 'No archived packages.')
    : filters.projectId
    ? t(
        'content_studio_no_packages_in_project',
        'No active packages in this project.'
      )
    : t(
        'content_studio_no_packages',
        'Create your first Content Studio package.'
      );

  return (
    <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col gap-[16px] min-w-0">
      <div className="flex flex-wrap items-center gap-[12px]">
        <div className="flex-1 min-w-[200px] text-textItemBlur">
          {t(
            'content_studio_subtitle',
            'Prepare post content in packages, then use it in a post.'
          )}
        </div>
        <div className="flex flex-wrap gap-[8px]">
          <Link
            href="/content-studio/sources"
            className="px-[24px] h-[40px] flex items-center rounded-full bg-third border border-textColor/60 text-textColor"
          >
            {t('content_studio_sources', 'Sources')}
          </Link>
          <Link
            href={RADAR_PAGE}
            className="px-[24px] h-[40px] flex items-center rounded-full bg-third border border-textColor/60 text-textColor"
          >
            {t('content_studio_news_radar', 'News Radar')}
          </Link>
          <Link
            href="/content-studio/designs"
            title={t(
              'content_studio_creative_studio_hint',
              'Create and render reusable visual designs.'
            )}
            className="px-[24px] h-[40px] flex items-center rounded-full bg-third border border-textColor/60 text-textColor"
          >
            {t('content_studio_creative_studio', 'Creative Studio')}
          </Link>
          <Link
            href={REVIEW_QUEUE_PAGE}
            className="px-[24px] h-[40px] flex items-center rounded-full bg-third border border-textColor/60 text-textColor"
          >
            {t('content_studio_review_queue', 'Review & Approval')}
          </Link>
          <Link
            href="/content-studio/intelligence"
            className="px-[24px] h-[40px] flex items-center rounded-full bg-third border border-textColor/60 text-textColor"
          >
            {t('content_studio_brand_ai', 'Brand & AI')}
          </Link>
          <Button secondary onClick={manageProjects}>
            {t('content_studio_manage_projects', 'Manage projects')}
          </Button>
          <Button onClick={newPackage}>
            {t('content_studio_new_package', 'New package')}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-[12px]">
        <div
          role="group"
          aria-label={t('content_studio_status', 'Status')}
          className="flex gap-[8px]"
        >
          {[false, true].map((archived) => (
            <Button
              key={String(archived)}
              secondary={filters.archived !== archived}
              aria-pressed={filters.archived === archived}
              className={clsx(filters.archived === archived && 'font-[600]')}
              onClick={() => {
                if (filters.archived !== archived) {
                  setFilters({ archived });
                }
              }}
            >
              {archived
                ? t('content_studio_archived', 'Archived')
                : t('content_studio_active', 'Active')}
            </Button>
          ))}
        </div>
        <div className="min-w-[200px]">
          <Select
            label="Project"
            translationKey="content_studio_project"
            name="project"
            aria-label={t('content_studio_project', 'Project')}
            disableForm={true}
            hideErrors={true}
            value={filters.projectId || ''}
            onChange={(e) =>
              setFilters({ projectId: e.target.value || undefined })
            }
          >
            <option value="">
              {t('content_studio_all_projects', 'All projects')}
            </option>
            {filterProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.archivedAt
                  ? `${project.name} (${t(
                      'content_studio_archived',
                      'Archived'
                    )})`
                  : project.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {packages.error ? (
        <div className="flex flex-col items-center gap-[12px] py-[40px]">
          <div>
            {t('content_studio_load_error', 'Could not load Content Studio.')}
          </div>
          <Button secondary onClick={() => packages.mutate()}>
            {t('content_studio_retry', 'Try again')}
          </Button>
        </div>
      ) : !packages.data ? (
        <LoadingComponent />
      ) : !packages.data.results.length ? (
        <div className="flex flex-col items-center gap-[12px] py-[40px]">
          <div>{empty}</div>
          {!filters.archived && (
            <Button onClick={newPackage}>
              {t('content_studio_new_package', 'New package')}
            </Button>
          )}
        </div>
      ) : (
        <>
          <ContentStudioPackageList
            packages={packages.data.results}
            projects={projects}
            projectsLoaded={!!activeProjects.data && !!archivedProjects.data}
          />
          {packages.data.pages > 1 && (
            <ContentStudioPager
              page={filters.page}
              pages={packages.data.pages}
              setPage={(page) => setFilters({ page })}
            />
          )}
        </>
      )}
    </div>
  );
};
