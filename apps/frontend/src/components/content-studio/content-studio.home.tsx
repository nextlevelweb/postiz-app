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
  packagePath,
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
import {
  ContentStudioLinkPending,
  ContentStudioLoading,
  ContentStudioPage,
} from '@gitroom/frontend/components/content-studio/content-studio.shell';
import { ContentStudioDialogLayout } from '@gitroom/frontend/components/content-studio/content-studio.dialog';
import {
  ContentStudioSetupCard,
  useContentStudioFirstUseSetup,
} from '@gitroom/frontend/components/content-studio/content-studio.setup.card';

// What each other part of Content Studio is for, in one line
const SectionCards: FC = () => {
  const t = useT();
  const cards = [
    {
      href: '/content-studio/sources',
      title: t('content_studio_sources', 'Sources'),
      text: t(
        'content_studio_sources_card',
        'Save web pages and feeds you want to write from. Each capture keeps its version and origin.'
      ),
    },
    {
      href: RADAR_PAGE,
      title: t('content_studio_research', 'Research'),
      text: t(
        'content_studio_radar_card',
        'New articles your feeds found, and what changed on pages you follow. Pick one and turn it into content.'
      ),
    },
    {
      href: '/content-studio/designs',
      title: t('content_studio_creative_studio', 'Creative Studio'),
      text: t(
        'content_studio_creative_card',
        'Make on-brand visuals from templates and render them for your posts.'
      ),
    },
    {
      href: REVIEW_QUEUE_PAGE,
      title: t('content_studio_review_queue', 'Review & Approval'),
      text: t(
        'content_studio_reviews_card',
        'Ask colleagues to review a version and approve it before it is used.'
      ),
    },
  ];
  return (
    <ul className="grid grid-cols-1 tablet:grid-cols-2 xl:grid-cols-4 gap-[12px]">
      {cards.map((card) => (
        <li key={card.href}>
          <Link
            href={card.href}
            className="flex flex-col gap-[4px] h-full p-[16px] rounded-[12px] border border-newTableBorder hover:border-[var(--brand-primary,#612ad5)] transition-colors"
          >
            <span className="flex items-center gap-[8px] font-[600]">
              {card.title}
              <ContentStudioLinkPending label={card.title} />
            </span>
            <span className="text-[13px] text-textItemBlur">{card.text}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
};

// The Content Studio home. Until setup is done (or hidden) it leads with the
// setup assistant; then with creating content and what was worked on last.
// Below: the packages of the organization, filtered by project and archive
// state on the server, one summary page at a time
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
      children: (
        <ContentStudioDialogLayout>
          <ContentStudioProjectsModal />
        </ContentStudioDialogLayout>
      ),
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
        'No content yet. A package is one post or thread: start one and let AI draft it with you.'
      );

  const latest =
    !filters.archived && !filters.projectId && filters.page === 1
      ? packages.data?.results[0]
      : undefined;

  // only the plain list says whether there is content at all; a filtered or
  // failed one never sends anyone to setup
  const unfiltered =
    !filters.archived && !filters.projectId && filters.page === 1;
  const decision = useContentStudioFirstUseSetup(
    !unfiltered || packages.error
      ? true
      : packages.data
      ? !!packages.data.results.length
      : undefined
  );
  if (decision !== 'home') {
    return (
      <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col min-w-0">
        <ContentStudioLoading
          label={t('content_studio_opening_home', 'Opening Content Studio…')}
        />
      </div>
    );
  }

  return (
    <ContentStudioPage
      title={t('content_studio', 'Content Studio')}
      description={t(
        'content_studio_subtitle',
        'Turn your sources, research and expertise into on-brand posts: AI drafts them with you, Creative Studio makes the visuals, and colleagues review before you publish.'
      )}
      actions={
        <Button onClick={newPackage}>
          {t('content_studio_new_package', 'New package')}
        </Button>
      }
    >
      <ContentStudioSetupCard hasContent={!!packages.data?.results.length} />

      {!!latest && (
        <div className="flex flex-wrap items-center gap-[12px] p-[16px] rounded-[12px] bg-newBgLineColor">
          <div className="flex flex-col gap-[2px] flex-1 min-w-[200px]">
            <span className="text-[12px] text-textItemBlur">
              {t(
                'content_studio_continue_latest',
                'Continue where you left off'
              )}
            </span>
            <span className="font-[600] break-words">
              {`${t('content_studio_last_edited', 'Last edited')}: ${
                latest.name
              }`}
            </span>
          </div>
          <Link
            href={packagePath(latest.id)}
            aria-label={`${t('content_studio_continue', 'Continue')}: ${
              latest.name
            }`}
            className="h-[40px] px-[24px] flex items-center rounded-full bg-[var(--brand-primary,#612ad5)] text-[var(--brand-action-text,#fff)]"
          >
            {t('content_studio_continue', 'Continue')}
          </Link>
        </div>
      )}

      <SectionCards />

      <div className="flex flex-wrap items-center gap-[12px] pt-[8px]">
        <h2 className="flex-1 min-w-[200px] text-[18px] font-[600]">
          {t('content_studio_your_content', 'Your content')}
        </h2>
        <Button secondary onClick={manageProjects}>
          {t('content_studio_manage_projects', 'Manage projects')}
        </Button>
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
        <div className="flex flex-col items-center gap-[12px] py-[40px] text-center">
          <div className="max-w-[520px]">{empty}</div>
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
    </ContentStudioPage>
  );
};
