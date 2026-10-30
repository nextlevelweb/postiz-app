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
import {
  REVIEW_QUEUE_PAGE,
  useContentStudioReviewQueue,
} from '@gitroom/frontend/components/content-studio/content-studio.reviews.api';
import { useContentStudioSetupStatus } from '@gitroom/frontend/components/content-studio/content-studio.setup.api';
import {
  FIRST_POST_PAGE,
  useContentStudioFirstPost,
} from '@gitroom/frontend/components/content-studio/content-studio.first-post';
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
import { ContentStudioGetStarted } from '@gitroom/frontend/components/content-studio/content-studio.onboarding';

// What needs the user now, from the organization's data only: the first
// post while it is not out yet, and reviews waiting for a decision. Not a
// second menu: where each section is, the navigation above says. Nothing
// when nothing waits. An organization that makes content already is not
// asked to start a first post
const ContentStudioHomeAttention: FC<{ hasContent: boolean }> = ({
  hasContent,
}) => {
  const t = useT();
  const status = useContentStudioSetupStatus();
  const firstPost = useContentStudioFirstPost();
  const reviews = useContentStudioReviewQueue({
    queue: 'NEEDS_REVIEW',
    targetType: null,
    search: '',
    page: 1,
  });
  const items: Array<{
    key: string;
    title: string;
    text: string;
    href: string;
    action: string;
  }> = [];
  const firstPostOpen =
    !!firstPost.data?.package && !firstPost.data.package.archived;
  if (
    status.complete &&
    firstPost.data &&
    !firstPost.data.activated &&
    (firstPostOpen || !hasContent)
  ) {
    items.push(
      firstPostOpen
        ? {
            key: 'first_post',
            title: t(
              'content_studio_home_first_post_waiting',
              'Your first post is waiting'
            ),
            text: t(
              'content_studio_home_first_post_waiting_text',
              'Review it, then schedule or publish it.'
            ),
            href: FIRST_POST_PAGE,
            action: t(
              'content_studio_home_first_post_open',
              'Open your first post'
            ),
          }
        : {
            key: 'first_post',
            title: t(
              'content_studio_home_first_post_create',
              'Create your first post'
            ),
            text: t(
              'content_studio_home_first_post_create_text',
              'Content Studio researches a relevant topic and writes the post for you.'
            ),
            href: FIRST_POST_PAGE,
            action: t(
              'content_studio_setup_create_first_post',
              'Create my first post'
            ),
          }
    );
  }
  const waiting = reviews.data?.results.length ?? 0;
  if (waiting) {
    items.push({
      key: 'reviews',
      title:
        (reviews.data?.pages ?? 1) > 1
          ? t(
              'content_studio_home_reviews_many',
              'More than {{count}} items need review',
              { count: waiting }
            )
          : t('content_studio_home_reviews', '{{count}} waiting for review', {
              count: waiting,
            }),
      text: t(
        'content_studio_home_reviews_text',
        'Posts and designs waiting for a review or approval.'
      ),
      href: REVIEW_QUEUE_PAGE,
      action: t('content_studio_home_reviews_open', 'Open approvals'),
    });
  }
  if (!items.length) {
    return null;
  }
  return (
    <ul
      aria-label={t('content_studio_home_attention', 'Needs your attention')}
      className="flex flex-col gap-[8px]"
    >
      {items.map((item) => (
        <li
          key={item.key}
          data-attention={item.key}
          className="flex flex-wrap items-center gap-[12px] p-[16px] rounded-[12px] border border-newTableBorder"
        >
          <div className="flex flex-col gap-[2px] flex-1 min-w-[200px]">
            <span className="font-[600] break-words">{item.title}</span>
            <span className="text-[13px] text-textItemBlur break-words">
              {item.text}
            </span>
          </div>
          <Link
            href={item.href}
            className="h-[40px] px-[20px] flex items-center gap-[6px] rounded-full border border-newTableBorder hover:border-[var(--brand-primary,#612ad5)]"
          >
            {item.action}
            <ContentStudioLinkPending label={item.action} />
          </Link>
        </li>
      ))}
    </ul>
  );
};

// The Content Studio home. Until setup is done (or hidden) it leads with the
// setup assistant; then with what needs attention (the first post, the
// checklist, reviews waiting) and what was worked on last.
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

  // a filtered or paged list was asked for on purpose: never sent to setup
  const decision = useContentStudioFirstUseSetup(
    !!filters.archived || !!filters.projectId || filters.page !== 1
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
      <ContentStudioGetStarted />
      <ContentStudioHomeAttention
        hasContent={!!packages.data?.results.length}
      />

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
