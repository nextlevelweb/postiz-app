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
import { ContentStudioPage } from '@gitroom/frontend/components/content-studio/content-studio.shell';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';
import { useSingleFlight } from '@gitroom/frontend/components/content-studio/content-studio.projects.modal';
import { formatDate } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';
import {
  ContentStudioDesignSummary,
  DESIGN_CANVAS_PRESETS,
  DESIGN_NAME_MAX,
  designErrorCode,
  designErrorMessage,
  newContentStudioDesignDocument,
  useContentStudioDesignActions,
  useContentStudioDesigns,
} from '@gitroom/frontend/components/content-studio/content-studio.designs.api';
import { designPageSetErrorMessage } from '@gitroom/frontend/components/content-studio/content-studio.design-page-sets.api';
import { DesignPageSetPicker } from '@gitroom/frontend/components/content-studio/content-studio.design-page-sets';

export const DESIGN_LIBRARY_PATH = '/content-studio/designs';
// the template library (P4-11): new designs from a template start there
const TEMPLATES_PATH = '/content-studio/templates';
export const designPagePath = (id: string) =>
  `${DESIGN_LIBRARY_PATH}/${encodeURIComponent(id)}`;

// The checks the API makes too: trimmed, 1-200 characters, no NUL
const validName = (name: string) => {
  const trimmed = name.trim();
  return (
    !!trimmed && trimmed.length <= DESIGN_NAME_MAX && !trimmed.includes('\0')
  );
};

// One of the fixed canvas sizes a new design can start from
export const DesignCanvasChoice: FC<{
  value: string;
  onChange: (presetId: string) => void;
}> = ({ value, onChange }) => {
  const t = useT();
  return (
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
            checked={value === preset.id}
            onChange={() => onChange(preset.id)}
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
  );
};

// A new design: its name and one of the fixed canvas sizes, or a page set
// (P4-17). A canvas size starts it as one empty white page; a page set as
// its blank pages, which the server makes from the page set's id. No Brand
// Kit either way; it opens once it exists, and nothing is rendered
const CreateDesignForm: FC<{ close: () => void }> = ({ close }) => {
  const t = useT();
  const toaster = useToaster();
  const router = useRouter();
  const { createDesign, createDesignFromPageSet } =
    useContentStudioDesignActions();
  const [name, setName] = useState('');
  const [presetId, setPresetId] = useState<string>(DESIGN_CANVAS_PRESETS[0].id);
  const [start, setStart] = useState<'size' | 'pageSet'>('size');
  const [pageSetId, setPageSetId] = useState<string | null>(null);
  const ready = validName(name) && (start === 'size' || !!pageSetId);
  const { busy, run } = useSingleFlight();

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const preset = DESIGN_CANVAS_PRESETS.find((p) => p.id === presetId);
      if (!ready || !preset) {
        return;
      }
      await run('create', async () => {
        try {
          const created =
            start === 'pageSet' && pageSetId
              ? await createDesignFromPageSet(name.trim(), pageSetId)
              : await createDesign(
                  name.trim(),
                  newContentStudioDesignDocument(preset)
                );
          toaster.show(
            t('content_studio_design_created', 'Design created.'),
            'success'
          );
          close();
          router.push(designPagePath(created.id));
        } catch (err) {
          // the input stays as typed, to correct and try again
          const code = designErrorCode(err);
          toaster.show(
            start === 'pageSet' &&
              (code === 'CS_NOT_FOUND' ||
                String(code).startsWith('CS_DESIGN_PAGE_SET_'))
              ? designPageSetErrorMessage(t, err)
              : designErrorMessage(t, err, 'create'),
            'warning'
          );
        }
      });
    },
    [
      ready,
      name,
      presetId,
      start,
      pageSetId,
      run,
      createDesign,
      createDesignFromPageSet,
      toaster,
      close,
      router,
      t,
    ]
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <Input
        label="Name"
        translationKey="content_studio_design_name"
        name="name"
        aria-label={t('content_studio_design_name', 'Name')}
        disableForm={true}
        removeError={true}
        value={name}
        maxLength={DESIGN_NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <fieldset className="flex flex-wrap gap-[16px]">
        <legend className="text-[14px] mb-[6px]">
          {t('content_studio_design_start_with', 'Start with')}
        </legend>
        <label className="flex items-center gap-[8px] cursor-pointer">
          <input
            type="radio"
            name="start"
            value="size"
            checked={start === 'size'}
            onChange={() => setStart('size')}
          />
          {t('content_studio_design_start_size', 'One canvas size')}
        </label>
        <label className="flex items-center gap-[8px] cursor-pointer">
          <input
            type="radio"
            name="start"
            value="pageSet"
            checked={start === 'pageSet'}
            onChange={() => setStart('pageSet')}
          />
          {t('content_studio_design_start_page_set', 'A page set')}
        </label>
      </fieldset>
      {start === 'pageSet' ? (
        <DesignPageSetPicker value={pageSetId} onChange={setPageSetId} />
      ) : (
        <DesignCanvasChoice value={presetId} onChange={setPresetId} />
      )}
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button type="submit" loading={!!busy} disabled={!!busy || !ready}>
          {t('content_studio_create_design', 'Create design')}
        </Button>
      </div>
    </form>
  );
};

// The name only: renaming creates no revision
const RenameDesignForm: FC<{
  design: ContentStudioDesignSummary;
  close: () => void;
}> = ({ design, close }) => {
  const t = useT();
  const toaster = useToaster();
  const { renameDesign } = useContentStudioDesignActions();
  const [name, setName] = useState(design.name);
  const { busy, run } = useSingleFlight();
  const changed = validName(name) && name.trim() !== design.name;

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!changed) {
        return;
      }
      await run('rename', async () => {
        try {
          await renameDesign(design.id, name.trim());
          toaster.show(
            t('content_studio_design_renamed', 'Design renamed.'),
            'success'
          );
          close();
        } catch (err) {
          toaster.show(designErrorMessage(t, err, 'update'), 'warning');
        }
      });
    },
    [changed, name, design, run, renameDesign, toaster, close, t]
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <Input
        label="Name"
        translationKey="content_studio_design_name"
        name="name"
        aria-label={t('content_studio_design_name', 'Name')}
        disableForm={true}
        removeError={true}
        value={name}
        maxLength={DESIGN_NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
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

export type DesignTask = 'archive' | 'restore';

// The lifecycle actions of the library and of one design. One action at a
// time per design, so a double click sends one request; other designs stay
// usable. Nothing is ever deleted
export const useDesignCommands = () => {
  const t = useT();
  const toaster = useToaster();
  const modals = useModals();
  const actions = useContentStudioDesignActions();
  const running = useRef(new Set<string>());
  const [busy, setBusy] = useState<Record<string, DesignTask>>({});

  const run = useCallback(
    async (id: string, task: DesignTask, work: () => Promise<void>) => {
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
    async (design: ContentStudioDesignSummary) => {
      if (
        !(await deleteDialog(
          t(
            'content_studio_design_archive_hint',
            'It will no longer appear with active designs. Its revision history and rendered media will remain available.'
          ),
          t('content_studio_archive', 'Archive'),
          t('content_studio_design_archive_title', 'Archive this design?'),
          t('cancel', 'Cancel')
        ))
      ) {
        return;
      }
      await run(design.id, 'archive', async () => {
        try {
          await actions.archiveDesign(design.id);
          toaster.show(
            t('content_studio_design_archived', 'Design archived.'),
            'success'
          );
        } catch (err) {
          toaster.show(designErrorMessage(t, err, 'update'), 'warning');
        }
      });
    },
    [run, actions, toaster, t]
  );

  const restore = useCallback(
    (design: ContentStudioDesignSummary) =>
      run(design.id, 'restore', async () => {
        try {
          await actions.restoreDesign(design.id);
          toaster.show(
            t('content_studio_design_restored', 'Design restored.'),
            'success'
          );
        } catch (err) {
          toaster.show(designErrorMessage(t, err, 'update'), 'warning');
        }
      }),
    [run, actions, toaster, t]
  );

  const rename = useCallback(
    (design: ContentStudioDesignSummary) =>
      modals.openModal({
        title: t('content_studio_rename_design', 'Rename design'),
        children: (close: () => void) => (
          <RenameDesignForm design={design} close={close} />
        ),
      }),
    [modals, t]
  );

  return { busy, archive, restore, rename };
};

// Rename and Archive for an active design, Restore for an archived one.
// While a design is edited its name stays as it is, and archiving first asks
// to give up the edit
export const DesignLifecycleActions: FC<{
  design: ContentStudioDesignSummary;
  busy?: DesignTask;
  commands: ReturnType<typeof useDesignCommands>;
  renameDisabled?: boolean;
  disabled?: boolean;
  beforeArchive?: () => Promise<boolean>;
}> = ({ design, busy, commands, renameDisabled, disabled, beforeArchive }) => {
  const t = useT();
  if (design.archivedAt) {
    return (
      <Button
        secondary
        loading={busy === 'restore'}
        disabled={!!busy || disabled}
        aria-label={`${t('content_studio_restore', 'Restore')} ${design.name}`}
        onClick={() => commands.restore(design)}
      >
        {t('content_studio_restore', 'Restore')}
      </Button>
    );
  }
  return (
    <>
      <Button
        secondary
        disabled={!!busy || disabled || renameDisabled}
        aria-label={`${t('content_studio_rename', 'Rename')} ${design.name}`}
        onClick={() => commands.rename(design)}
      >
        {t('content_studio_rename', 'Rename')}
      </Button>
      <Button
        secondary
        loading={busy === 'archive'}
        disabled={!!busy || disabled}
        aria-label={`${t('content_studio_archive', 'Archive')} ${design.name}`}
        onClick={async () => {
          if (!beforeArchive || (await beforeArchive())) {
            await commands.archive(design);
          }
        }}
      >
        {t('content_studio_archive', 'Archive')}
      </Button>
    </>
  );
};

export const DesignStatus: FC<{ design: ContentStudioDesignSummary }> = ({
  design,
}) => {
  const t = useT();
  return (
    <span className="px-[8px] rounded-full border border-newTableBorder">
      {design.archivedAt
        ? t('content_studio_archived', 'Archived')
        : t('content_studio_active', 'Active')}
    </span>
  );
};

const DesignRow: FC<{
  design: ContentStudioDesignSummary;
  busy?: DesignTask;
  commands: ReturnType<typeof useDesignCommands>;
}> = ({ design, busy, commands }) => {
  const t = useT();
  return (
    <li className="flex flex-wrap items-center gap-[12px] p-[16px] border border-newTableBorder rounded-[8px]">
      <div className="flex flex-col gap-[4px] flex-1 min-w-[200px]">
        <Link
          href={designPagePath(design.id)}
          className="text-[16px] font-[600] break-words hover:underline"
        >
          {design.name}
        </Link>
        <div className="flex flex-wrap gap-x-[16px] gap-y-[4px] text-[12px] text-textItemBlur">
          <DesignStatus design={design} />
          <span>
            {t('content_studio_design_revision', 'Revision')}{' '}
            {design.latestRevisionNumber}
          </span>
          <span>
            {t('content_studio_created', 'Created')}:{' '}
            {formatDate(design.createdAt)}
          </span>
          <span>
            {t('content_studio_updated', 'Updated')}:{' '}
            {formatDate(design.updatedAt)}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-[8px]">
        <Link
          href={designPagePath(design.id)}
          aria-label={`${t('content_studio_open', 'Open')} ${design.name}`}
          className="h-[40px] px-[24px] flex items-center rounded-full bg-[var(--brand-primary,#612ad5)] text-[var(--brand-action-text,#fff)]"
        >
          {t('content_studio_open', 'Open')}
        </Link>
        <DesignLifecycleActions
          design={design}
          busy={busy}
          commands={commands}
        />
      </div>
    </li>
  );
};

// What Creative Studio is for, shown while there is no design yet. Only what
// the editor does today: blank or template designs, text, images from the
// media library and shapes, the Brand Kit and AI suggestions, and pages
// rendered as images into the media library
export const CreativeStudioIntro: FC<{ onCreate: () => void }> = ({
  onCreate,
}) => {
  const t = useT();
  const points = [
    t(
      'content_studio_creative_intro_start',
      'Start from a blank design in a social media size, or from a template.'
    ),
    t(
      'content_studio_creative_intro_edit',
      'Add text, images from your media library, rectangles and ellipses; add pages for a carousel.'
    ),
    t(
      'content_studio_creative_intro_brand',
      'Apply your Brand Kit colors and fonts, and let AI suggest text.'
    ),
    t(
      'content_studio_creative_intro_render',
      'Render each page as an image into your media library, ready to add to a post.'
    ),
  ];
  return (
    <section
      aria-labelledby="creative-studio-intro"
      className="flex flex-col gap-[16px] p-[24px] mobile:p-[16px] rounded-[16px] border border-newTableBorder"
    >
      <h2 id="creative-studio-intro" className="text-[20px] font-[600]">
        {t(
          'content_studio_creative_intro_title',
          'Create on-brand visuals for your content'
        )}
      </h2>
      <ol className="grid grid-cols-1 tablet:grid-cols-2 gap-[12px]">
        {points.map((point, index) => (
          <li key={point} className="flex items-start gap-[10px] text-[14px]">
            <span
              aria-hidden="true"
              className="w-[22px] h-[22px] shrink-0 rounded-full bg-newBgLineColor flex items-center justify-center text-[12px] font-[600]"
            >
              {index + 1}
            </span>
            <span>{point}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-[8px]">
        <Button onClick={onCreate}>
          {t('content_studio_create_design', 'Create design')}
        </Button>
        <Link
          href={TEMPLATES_PATH}
          className="px-[24px] h-[40px] flex items-center rounded-full bg-third border border-textColor/60 text-textColor"
        >
          {t('content_studio_browse_templates', 'Browse templates')}
        </Link>
      </div>
    </section>
  );
};

// Creative Studio: the organization's designs, active or archived, one
// summary page at a time, in the server's order
export const ContentStudioDesigns: FC = () => {
  const t = useT();
  const modals = useModals();
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const list = useContentStudioDesigns(archived, page);
  const commands = useDesignCommands();

  const pages = list.data?.pages;
  // a page that no longer exists (after archiving, say) moves to the last one
  useEffect(() => {
    if (pages !== undefined && page > Math.max(pages, 1)) {
      setPage(Math.max(pages, 1));
    }
  }, [pages, page]);

  const createDesign = useCallback(
    () =>
      modals.openModal({
        title: t('content_studio_create_design', 'Create design'),
        children: (close: () => void) => <CreateDesignForm close={close} />,
      }),
    [modals, t]
  );

  return (
    <ContentStudioPage
      title={t('content_studio_creative_studio', 'Creative Studio')}
      description={t(
        'content_studio_designs_subtitle',
        'Make on-brand images for your posts and render them to your media library.'
      )}
      help={t(
        'content_studio_designs_note',
        'Every change to a design is kept as a revision.'
      )}
      actions={
        <>
          <Link
            href={TEMPLATES_PATH}
            className="px-[24px] h-[40px] flex items-center rounded-full bg-third border border-textColor/60 text-textColor"
          >
            {t('content_studio_from_template', 'From template')}
          </Link>
          <Button onClick={createDesign}>
            {t('content_studio_create_design', 'Create design')}
          </Button>
        </>
      }
    >
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
              'content_studio_designs_load_error',
              'Designs could not be loaded.'
            )}
          </div>
          <Button secondary onClick={() => list.mutate()}>
            {t('content_studio_retry', 'Try again')}
          </Button>
        </div>
      ) : !list.data ? (
        <LoadingComponent />
      ) : !list.data.results.length ? (
        <div className="flex flex-col items-center gap-[12px] py-[40px] text-center">
          {archived ? (
            <div>
              {t('content_studio_no_archived_designs', 'No archived designs.')}
            </div>
          ) : (
            <div className="w-full text-start">
              <CreativeStudioIntro onCreate={createDesign} />
            </div>
          )}
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-[12px]">
            {list.data.results.map((design) => (
              <DesignRow
                key={design.id}
                design={design}
                busy={commands.busy[design.id]}
                commands={commands}
              />
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
    </ContentStudioPage>
  );
};
