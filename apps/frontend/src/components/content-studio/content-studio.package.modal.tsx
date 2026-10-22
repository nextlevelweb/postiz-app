'use client';

import { FC, FormEvent, useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { Select } from '@gitroom/react/form/select';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import {
  contentStudioErrorMessage,
  PACKAGE_NAME_MAX,
  packagePath,
  packageResearchPath,
  useContentStudioActions,
  useContentStudioProjects,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import { isContentStudioSourceUsable } from '@gitroom/frontend/components/content-studio/content-studio.sources.api';

// A new package, optionally in an active project. A blank name is left to the
// server ("Untitled package"). On success the package opens; with research
// sources (P8-03) it opens with them ready for AI writing, named in its URL
// only: the package itself is created exactly as without them
export const CreateContentStudioPackageModal: FC<{
  close: () => void;
  projectId?: string;
  sourceIds?: string[];
}> = ({ close, projectId, sourceIds }) => {
  const t = useT();
  const router = useRouter();
  const toaster = useToaster();
  const { createPackage } = useContentStudioActions();
  const { data: activeProjects } = useContentStudioProjects(false);
  const [name, setName] = useState('');
  const [selectedProject, setSelectedProject] = useState(
    projectId && activeProjects?.some((p) => p.id === projectId)
      ? projectId
      : ''
  );
  const [saving, setSaving] = useState(false);
  // set at once, so a second click before the rerender sends nothing
  const submitting = useRef(false);

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (submitting.current) {
        return;
      }
      submitting.current = true;
      setSaving(true);
      try {
        const created = await createPackage({
          name: name.trim() || undefined,
          // only an active project can be chosen
          projectId: activeProjects?.some((p) => p.id === selectedProject)
            ? selectedProject
            : undefined,
        });
        close();
        router.push(
          sourceIds?.length
            ? packageResearchPath(created.id, sourceIds)
            : packagePath(created.id)
        );
      } catch (err) {
        submitting.current = false;
        setSaving(false);
        toaster.show(contentStudioErrorMessage(t, err), 'warning');
      }
    },
    [
      name,
      selectedProject,
      activeProjects,
      createPackage,
      close,
      router,
      sourceIds,
    ]
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <Input
        label="Name"
        translationKey="content_studio_package_name"
        name="name"
        aria-label={t('content_studio_package_name', 'Name')}
        disableForm={true}
        value={name}
        maxLength={PACKAGE_NAME_MAX}
        placeholder={t('content_studio_untitled_package', 'Untitled package')}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <Select
        label="Project"
        translationKey="content_studio_project"
        name="projectId"
        aria-label={t('content_studio_project', 'Project')}
        disableForm={true}
        value={selectedProject}
        onChange={(e) => setSelectedProject(e.target.value)}
      >
        <option value="">{t('content_studio_no_project', 'No project')}</option>
        {activeProjects?.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </Select>
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button type="submit" loading={saving} disabled={saving}>
          {t('create', 'Create')}
        </Button>
      </div>
    </form>
  );
};

// Research into content (P8-03), for a live web page with a captured version:
// opens the New package dialog with the page ready for AI writing. Nothing is
// created until the dialog's Create, and nothing is asked of the AI: the
// version used is the one AI writing reads when Generate is clicked
export const ContentStudioUseInContent: FC<{
  source: {
    id: string;
    kind?: string;
    latestVersionNumber: number;
    archivedAt: string | null;
  };
}> = ({ source }) => {
  const t = useT();
  const modals = useModals();
  const open = useCallback(
    () =>
      modals.openModal({
        title: t('content_studio_new_package', 'New package'),
        children: (close: () => void) => (
          <CreateContentStudioPackageModal
            close={close}
            sourceIds={[source.id]}
          />
        ),
      }),
    [modals, source.id, t]
  );
  if (!isContentStudioSourceUsable(source)) {
    return null;
  }
  return (
    <div>
      <Button secondary onClick={open}>
        {t('content_studio_use_in_content', 'Use in content')}
      </Button>
    </div>
  );
};
