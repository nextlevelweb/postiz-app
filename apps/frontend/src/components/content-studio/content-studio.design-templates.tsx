'use client';

import { FC, FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';
import { useSingleFlight } from '@gitroom/frontend/components/content-studio/content-studio.projects.modal';
import { parseContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  DESIGN_CANVAS_PRESETS,
  DESIGN_NAME_MAX,
  newContentStudioDesignDocument,
} from '@gitroom/frontend/components/content-studio/content-studio.designs.api';
import {
  ContentStudioDesignTemplateCard,
  ContentStudioDesignTemplateChoice,
  ContentStudioOrganizationDesignTemplate,
  DESIGN_TEMPLATE_DESCRIPTION_MAX,
  designTemplateErrorMessage,
  useContentStudioDesignTemplateActions,
  useContentStudioDesignTemplates,
} from '@gitroom/frontend/components/content-studio/content-studio.design-templates.api';
import {
  DESIGN_LIBRARY_PATH,
  designPagePath,
} from '@gitroom/frontend/components/content-studio/content-studio.designs';
import { ContentStudioDesignPageThumbnail } from '@gitroom/frontend/components/content-studio/content-studio.design.preview';

export const TEMPLATE_LIBRARY_PATH = '/content-studio/templates';
export const templatePagePath = (id: string) =>
  `${TEMPLATE_LIBRARY_PATH}/${encodeURIComponent(id)}`;

// The checks the API makes too: trimmed, within the length, no NUL
const validText = (value: string, max: number, required: boolean) => {
  const trimmed = value.trim();
  return (
    (!required || !!trimmed) && trimmed.length <= max && !trimmed.includes('\0')
  );
};

const FIELD =
  'bg-newBgColorInner min-h-[80px] p-[10px] border-newTableBorder border rounded-[8px] text-textColor text-[14px] w-full min-w-0';

// The name of a template, or of a design, and an optional description
const NameField: FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
}> = ({ label, value, onChange }) => (
  <Input
    label={label}
    name="name"
    aria-label={label}
    disableForm={true}
    removeError={true}
    value={value}
    maxLength={DESIGN_NAME_MAX}
    onChange={(e) => onChange(e.target.value)}
    autoFocus
  />
);
const DescriptionField: FC<{
  value: string;
  onChange: (value: string) => void;
}> = ({ value, onChange }) => {
  const t = useT();
  return (
    <label className="flex flex-col gap-[6px] text-[14px]">
      {t('content_studio_template_description', 'Description')}
      <textarea
        className={FIELD}
        value={value}
        maxLength={DESIGN_TEMPLATE_DESCRIPTION_MAX}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
};

// A new design from exactly the chosen template revision: only its name is
// asked; the server copies the template's document. It opens once it exists
export const UseTemplateForm: FC<{
  choice: ContentStudioDesignTemplateChoice;
  defaultName: string;
  close: () => void;
}> = ({ choice, defaultName, close }) => {
  const t = useT();
  const toaster = useToaster();
  const router = useRouter();
  const { instantiateTemplate } = useContentStudioDesignTemplateActions();
  const [name, setName] = useState(defaultName);
  const { busy, run } = useSingleFlight();
  const valid = validText(name, DESIGN_NAME_MAX, true);

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!valid) {
        return;
      }
      await run('use', async () => {
        try {
          const created = await instantiateTemplate(choice, name.trim());
          toaster.show(
            t('content_studio_design_created', 'Design created.'),
            'success'
          );
          close();
          router.push(designPagePath(created.id));
        } catch (err) {
          toaster.show(designTemplateErrorMessage(t, err), 'warning');
        }
      });
    },
    [valid, run, instantiateTemplate, choice, name, toaster, close, router, t]
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <NameField
        label={t('content_studio_template_design_name', 'Design name')}
        value={name}
        onChange={setName}
      />
      <div className="text-[13px] text-textItemBlur">
        {t(
          'content_studio_template_use_hint',
          'The new design starts as a copy of this template revision. Later changes to either one do not affect the other.'
        )}
      </div>
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button type="submit" loading={!!busy} disabled={!!busy || !valid}>
          {t('content_studio_create_design', 'Create design')}
        </Button>
      </div>
    </form>
  );
};

// A new template from exactly one saved revision of a design: the server
// reads that revision, nothing unsaved goes with it. It opens once it exists
export const SaveAsTemplateForm: FC<{
  designId: string;
  revisionId: string;
  revisionNumber: number;
  defaultName: string;
  close: () => void;
}> = ({ designId, revisionId, revisionNumber, defaultName, close }) => {
  const t = useT();
  const toaster = useToaster();
  const router = useRouter();
  const { saveDesignAsTemplate } = useContentStudioDesignTemplateActions();
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const { busy, run } = useSingleFlight();
  const valid =
    validText(name, DESIGN_NAME_MAX, true) &&
    validText(description, DESIGN_TEMPLATE_DESCRIPTION_MAX, false);

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!valid) {
        return;
      }
      await run('save', async () => {
        try {
          const created = await saveDesignAsTemplate(designId, revisionId, {
            name: name.trim(),
            description: description.trim(),
          });
          toaster.show(
            t('content_studio_template_created', 'Template created.'),
            'success'
          );
          close();
          router.push(templatePagePath(created.id));
        } catch (err) {
          toaster.show(designTemplateErrorMessage(t, err), 'warning');
        }
      });
    },
    [
      valid,
      run,
      saveDesignAsTemplate,
      designId,
      revisionId,
      name,
      description,
      toaster,
      close,
      router,
      t,
    ]
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <div className="text-[13px] text-textItemBlur">
        {`${t(
          'content_studio_template_from_revision',
          'The template is made from saved revision'
        )} ${revisionNumber}.`}
      </div>
      <NameField
        label={t('content_studio_template_name', 'Template name')}
        value={name}
        onChange={setName}
      />
      <DescriptionField value={description} onChange={setDescription} />
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button type="submit" loading={!!busy} disabled={!!busy || !valid}>
          {t('content_studio_save_as_template', 'Save as template')}
        </Button>
      </div>
    </form>
  );
};

// A new organization template: one empty white page of a fixed size, like a
// new design. It opens once it exists
const NewTemplateForm: FC<{ close: () => void }> = ({ close }) => {
  const t = useT();
  const toaster = useToaster();
  const router = useRouter();
  const { createTemplate } = useContentStudioDesignTemplateActions();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [presetId, setPresetId] = useState<string>(DESIGN_CANVAS_PRESETS[0].id);
  const { busy, run } = useSingleFlight();
  const valid =
    validText(name, DESIGN_NAME_MAX, true) &&
    validText(description, DESIGN_TEMPLATE_DESCRIPTION_MAX, false);

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const preset = DESIGN_CANVAS_PRESETS.find((p) => p.id === presetId);
      if (!valid || !preset) {
        return;
      }
      await run('create', async () => {
        try {
          const created = await createTemplate({
            name: name.trim(),
            description: description.trim(),
            content: newContentStudioDesignDocument(preset),
          });
          toaster.show(
            t('content_studio_template_created', 'Template created.'),
            'success'
          );
          close();
          router.push(templatePagePath(created.id));
        } catch (err) {
          toaster.show(designTemplateErrorMessage(t, err), 'warning');
        }
      });
    },
    [
      valid,
      presetId,
      run,
      createTemplate,
      name,
      description,
      toaster,
      close,
      router,
      t,
    ]
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <NameField
        label={t('content_studio_template_name', 'Template name')}
        value={name}
        onChange={setName}
      />
      <DescriptionField value={description} onChange={setDescription} />
      <fieldset className="flex flex-col gap-[8px]">
        <legend className="text-[14px] mb-[6px]">
          {t('content_studio_design_canvas', 'Canvas size')}
        </legend>
        {DESIGN_CANVAS_PRESETS.map((preset) => (
          <label
            key={preset.id}
            className="flex items-center gap-[8px] cursor-pointer"
          >
            <input
              type="radio"
              name="preset"
              value={preset.id}
              checked={presetId === preset.id}
              onChange={() => setPresetId(preset.id)}
            />
            <span>
              {t(`content_studio_design_preset_${preset.id}`, preset.label)}{' '}
              <span className="text-textItemBlur">
                {preset.width} × {preset.height}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button type="submit" loading={!!busy} disabled={!!busy || !valid}>
          {t('content_studio_create_template', 'Create template')}
        </Button>
      </div>
    </form>
  );
};

// The name and the description: no revision is made
export const TemplateDetailsForm: FC<{
  template: ContentStudioOrganizationDesignTemplate;
  close: () => void;
}> = ({ template, close }) => {
  const t = useT();
  const toaster = useToaster();
  const { updateTemplate } = useContentStudioDesignTemplateActions();
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? '');
  const { busy, run } = useSingleFlight();
  const changed =
    validText(name, DESIGN_NAME_MAX, true) &&
    validText(description, DESIGN_TEMPLATE_DESCRIPTION_MAX, false) &&
    (name.trim() !== template.name ||
      description.trim() !== (template.description ?? ''));

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!changed) {
        return;
      }
      await run('details', async () => {
        try {
          await updateTemplate(template.id, {
            name: name.trim(),
            description: description.trim(),
          });
          toaster.show(
            t('content_studio_template_updated', 'Template updated.'),
            'success'
          );
          close();
        } catch (err) {
          toaster.show(designTemplateErrorMessage(t, err), 'warning');
        }
      });
    },
    [
      changed,
      run,
      updateTemplate,
      template,
      name,
      description,
      toaster,
      close,
      t,
    ]
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <NameField
        label={t('content_studio_template_name', 'Template name')}
        value={name}
        onChange={setName}
      />
      <DescriptionField value={description} onChange={setDescription} />
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button type="submit" loading={!!busy} disabled={!!busy || !changed}>
          {t('save', 'Save')}
        </Button>
      </div>
    </form>
  );
};

export type TemplateTask = 'archive' | 'restore';

// Archive and Restore of the organization's templates, one at a time per
// template; built-in templates have neither. Nothing is ever deleted
export const useTemplateCommands = () => {
  const t = useT();
  const toaster = useToaster();
  const actions = useContentStudioDesignTemplateActions();
  const running = useRef(new Set<string>());
  const [busy, setBusy] = useState<Record<string, TemplateTask>>({});

  const run = useCallback(
    async (id: string, task: TemplateTask, work: () => Promise<void>) => {
      if (running.current.has(id)) {
        return;
      }
      running.current.add(id);
      setBusy((current) => ({ ...current, [id]: task }));
      try {
        await work();
      } finally {
        running.current.delete(id);
        setBusy((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
      }
    },
    []
  );

  const archive = useCallback(
    async (template: ContentStudioOrganizationDesignTemplate) => {
      if (
        !(await deleteDialog(
          t(
            'content_studio_template_archive_hint',
            'It will no longer be offered for new designs. Its revisions and the designs made from it stay as they are.'
          ),
          t('content_studio_archive', 'Archive'),
          t('content_studio_template_archive_title', 'Archive this template?'),
          t('cancel', 'Cancel')
        ))
      ) {
        return;
      }
      await run(template.id, 'archive', async () => {
        try {
          await actions.archiveTemplate(template.id);
          toaster.show(
            t('content_studio_template_archived', 'Template archived.'),
            'success'
          );
        } catch (err) {
          toaster.show(designTemplateErrorMessage(t, err), 'warning');
        }
      });
    },
    [run, actions, toaster, t]
  );

  const restore = useCallback(
    (template: ContentStudioOrganizationDesignTemplate) =>
      run(template.id, 'restore', async () => {
        try {
          await actions.restoreTemplate(template.id);
          toaster.show(
            t('content_studio_template_restored', 'Template restored.'),
            'success'
          );
        } catch (err) {
          toaster.show(designTemplateErrorMessage(t, err), 'warning');
        }
      }),
    [run, actions, toaster, t]
  );

  return { busy, archive, restore };
};

// The first page of a template's current document, drawn by the structural
// preview: shapes, text and image placeholders only. Brand Kit tokens are
// not resolved here (that would be a request per card), so they show as
// unresolved, like any token the preview cannot resolve
const TemplateThumbnail: FC<{ content: unknown }> = ({ content }) => {
  let page = null;
  try {
    page = parseContentStudioDesignDocument(content).pages[0];
  } catch {
    page = null;
  }
  return page ? (
    <ContentStudioDesignPageThumbnail page={page} brand={null} />
  ) : null;
};

// One template card: a heading and plain actions side by side (never a
// control inside another)
const TemplateCard: FC<{
  template: ContentStudioDesignTemplateCard;
  busy?: TemplateTask;
  commands: ReturnType<typeof useTemplateCommands>;
}> = ({ template, busy, commands }) => {
  const t = useT();
  const modals = useModals();
  const system = template.source === 'system';
  const archived = !system && !!template.archivedAt;
  const use = () =>
    modals.openModal({
      title: t('content_studio_use_template', 'Use template'),
      children: (close: () => void) => (
        <UseTemplateForm
          choice={
            template.source === 'system'
              ? {
                  source: 'system',
                  templateId: template.id,
                  revisionNumber: template.currentRevision.revisionNumber,
                }
              : {
                  source: 'organization',
                  templateId: template.id,
                  revisionId: template.currentRevision.id,
                }
          }
          defaultName={template.name}
          close={close}
        />
      ),
    });
  return (
    <li
      data-template={template.source}
      className="flex flex-col gap-[10px] p-[16px] border border-newTableBorder rounded-[8px] min-w-0"
    >
      <TemplateThumbnail content={template.currentRevision.content} />
      <div className="flex flex-col gap-[4px] min-w-0">
        <h3 className="text-[16px] font-[600] break-words">{template.name}</h3>
        <div className="flex flex-wrap gap-x-[12px] gap-y-[4px] text-[12px] text-textItemBlur">
          <span className="px-[8px] rounded-full border border-newTableBorder">
            {system
              ? t('content_studio_template_built_in', 'Built-in')
              : t('content_studio_template_organization', 'Organization')}
          </span>
          {archived && (
            <span className="px-[8px] rounded-full border border-newTableBorder">
              {t('content_studio_archived', 'Archived')}
            </span>
          )}
          <span>
            {t('content_studio_design_revision', 'Revision')}{' '}
            {template.latestRevisionNumber}
          </span>
        </div>
        {!!template.description && (
          <div className="text-[13px] break-words">{template.description}</div>
        )}
      </div>
      <div className="flex flex-wrap gap-[8px]">
        {!archived && (
          <Button
            aria-label={`${t('content_studio_use_template', 'Use template')} ${
              template.name
            }`}
            onClick={use}
          >
            {t('content_studio_use_template', 'Use template')}
          </Button>
        )}
        {template.source === 'organization' && (
          <>
            <Link
              href={templatePagePath(template.id)}
              aria-label={`${t('content_studio_open', 'Open')} ${
                template.name
              }`}
              className="h-[40px] px-[24px] flex items-center rounded-full bg-third border border-textColor/60 text-textColor"
            >
              {t('content_studio_open', 'Open')}
            </Link>
            {archived ? (
              <Button
                secondary
                loading={busy === 'restore'}
                disabled={!!busy}
                aria-label={`${t('content_studio_restore', 'Restore')} ${
                  template.name
                }`}
                onClick={() => commands.restore(template)}
              >
                {t('content_studio_restore', 'Restore')}
              </Button>
            ) : (
              <>
                <Button
                  secondary
                  disabled={!!busy}
                  aria-label={`${t(
                    'content_studio_template_edit_details',
                    'Edit details'
                  )} ${template.name}`}
                  onClick={() =>
                    modals.openModal({
                      title: t(
                        'content_studio_template_edit_details',
                        'Edit details'
                      ),
                      children: (close: () => void) => (
                        <TemplateDetailsForm
                          template={template}
                          close={close}
                        />
                      ),
                    })
                  }
                >
                  {t('content_studio_template_edit_details', 'Edit details')}
                </Button>
                <Button
                  secondary
                  loading={busy === 'archive'}
                  disabled={!!busy}
                  aria-label={`${t('content_studio_archive', 'Archive')} ${
                    template.name
                  }`}
                  onClick={() => commands.archive(template)}
                >
                  {t('content_studio_archive', 'Archive')}
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </li>
  );
};

const GRID =
  'grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-[12px] min-w-0';

// Templates: the built-in ones and the organization's, active or archived.
// Each card shows the first page of the current document, drawn by the
// structural preview; nothing is rendered or fetched per card
export const ContentStudioDesignTemplates: FC = () => {
  const t = useT();
  const modals = useModals();
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const list = useContentStudioDesignTemplates(archived, page);
  const commands = useTemplateCommands();

  const pages = list.data?.pages;
  // a page that no longer exists (after archiving, say) moves to the last one
  useEffect(() => {
    if (pages !== undefined && page > Math.max(pages, 1)) {
      setPage(Math.max(pages, 1));
    }
  }, [pages, page]);

  const newTemplate = useCallback(
    () =>
      modals.openModal({
        title: t('content_studio_create_template', 'Create template'),
        children: (close: () => void) => <NewTemplateForm close={close} />,
      }),
    [modals, t]
  );

  return (
    <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col gap-[16px] min-w-0">
      <div className="flex flex-wrap items-center gap-[12px]">
        <div className="flex flex-col gap-[4px] flex-1 min-w-[200px]">
          <h1 className="text-[20px] font-[600]">
            {t('content_studio_templates', 'Templates')}
          </h1>
          <div className="text-textItemBlur">
            {t(
              'content_studio_templates_subtitle',
              'Start new designs from built-in or saved templates.'
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-[8px]">
          <Link
            href={DESIGN_LIBRARY_PATH}
            className="px-[24px] h-[40px] flex items-center rounded-full bg-third border border-textColor/60 text-textColor"
          >
            {t('content_studio_creative_studio', 'Creative Studio')}
          </Link>
          <Button onClick={newTemplate}>
            {t('content_studio_create_template', 'Create template')}
          </Button>
        </div>
      </div>

      <div
        role="group"
        aria-label={t('content_studio_status', 'Status')}
        className="flex gap-[8px]"
      >
        {[false, true].map((value) => (
          <Button
            key={String(value)}
            secondary={archived !== value}
            aria-pressed={archived === value}
            className={clsx(archived === value && 'font-[600]')}
            onClick={() => {
              if (archived !== value) {
                setArchived(value);
                setPage(1);
              }
            }}
          >
            {value
              ? t('content_studio_archived', 'Archived')
              : t('content_studio_active', 'Active')}
          </Button>
        ))}
      </div>

      {list.error ? (
        <div className="flex flex-col items-center gap-[12px] py-[40px]">
          <div>
            {t(
              'content_studio_templates_load_error',
              'Templates could not be loaded.'
            )}
          </div>
          <Button secondary onClick={() => list.mutate()}>
            {t('content_studio_retry', 'Try again')}
          </Button>
        </div>
      ) : !list.data ? (
        <LoadingComponent />
      ) : (
        <>
          {!archived && (
            <section className="flex flex-col gap-[8px]">
              <h2 className="font-[600]">
                {t('content_studio_templates_built_in', 'Built-in templates')}
              </h2>
              <ul
                aria-label={t(
                  'content_studio_templates_built_in',
                  'Built-in templates'
                )}
                className={GRID}
              >
                {list.data.system.map((template) => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    commands={commands}
                  />
                ))}
              </ul>
            </section>
          )}
          <section className="flex flex-col gap-[8px]">
            <h2 className="font-[600]">
              {archived
                ? t(
                    'content_studio_templates_archived',
                    'Archived organization templates'
                  )
                : t(
                    'content_studio_templates_organization',
                    'Organization templates'
                  )}
            </h2>
            {!list.data.results.length ? (
              <div className="text-textItemBlur">
                {archived
                  ? t(
                      'content_studio_no_archived_templates',
                      'No archived templates.'
                    )
                  : t(
                      'content_studio_no_templates',
                      'No organization templates yet. Create one, or save a design as a template.'
                    )}
              </div>
            ) : (
              <ul
                aria-label={
                  archived
                    ? t(
                        'content_studio_templates_archived',
                        'Archived organization templates'
                      )
                    : t(
                        'content_studio_templates_organization',
                        'Organization templates'
                      )
                }
                className={GRID}
              >
                {list.data.results.map((template) => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    busy={commands.busy[template.id]}
                    commands={commands}
                  />
                ))}
              </ul>
            )}
            {list.data.pages > 1 && (
              <ContentStudioPager
                page={page}
                pages={list.data.pages}
                setPage={setPage}
              />
            )}
          </section>
        </>
      )}
    </div>
  );
};
