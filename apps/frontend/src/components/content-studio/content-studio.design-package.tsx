'use client';

import { FC, FormEvent, useCallback, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';
import { useSingleFlight } from '@gitroom/frontend/components/content-studio/content-studio.projects.modal';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';
import {
  ContentStudioMediaMap,
  ContentStudioMediaPreview,
} from '@gitroom/frontend/components/content-studio/content-studio.api';
import {
  ContentStudioDesignSource,
  DESIGN_CANVAS_PRESETS,
  DESIGN_NAME_MAX,
  designErrorCode,
  designFromPackageErrorMessage,
  useContentStudioDesignActions,
} from '@gitroom/frontend/components/content-studio/content-studio.designs.api';
import {
  ContentStudioDesignTemplateCard,
  useContentStudioDesignTemplates,
} from '@gitroom/frontend/components/content-studio/content-studio.design-templates.api';
import { designPageSetErrorMessage } from '@gitroom/frontend/components/content-studio/content-studio.design-page-sets.api';
import { DesignPageSetPicker } from '@gitroom/frontend/components/content-studio/content-studio.design-page-sets';
import {
  DesignCanvasChoice,
  designPagePath,
} from '@gitroom/frontend/components/content-studio/content-studio.designs';
import { UseTemplateForm } from '@gitroom/frontend/components/content-studio/content-studio.design-templates';
import { contentStudioReviewTargetHref } from '@gitroom/frontend/components/content-studio/content-studio.reviews.api';

// A design from a package (P6-01): a new design that starts with the text of
// one thread item of exactly one saved version of a package, opened from
// that version, never from the draft. The browser shows the version as the
// server returned it and sends only ids: the version (in the path), the
// item, the starting point (a canvas size, a page set or a template, through
// the same choices and forms as any new design) and the design's name. The
// server reads the text and Media again from that version. Once created the
// design is an ordinary one, with its own revisions and review: the package
// and the design change apart

export interface ContentStudioPackageDesignVersion {
  packageId: string;
  revisionId: string;
  revisionNumber: number;
  thread: Array<{ id: string; text: string; mediaIds: string[] }>;
  media: ContentStudioMediaMap;
}

// A package image as a small tile: its thumbnail or image, a video by name,
// or why it cannot be shown
const PackageImageTile: FC<{
  preview: ContentStudioMediaPreview | null | undefined;
}> = ({ preview }) => {
  const t = useT();
  const image =
    preview &&
    (preview.thumbnail ||
      (hasExtension(preview.path, 'mp4') ? null : preview.path));
  return (
    <span className="w-[72px] h-[72px] rounded-[8px] border border-newTableBorder overflow-hidden flex items-center justify-center text-center text-[11px] p-[2px]">
      {!preview ? (
        t('content_studio_media_unavailable', 'Unavailable media')
      ) : image ? (
        <img
          src={image}
          alt={preview.alt || ''}
          className="w-full h-full object-cover"
        />
      ) : (
        t('content_studio_media_video', 'Video')
      )}
    </span>
  );
};

// "Post" for the first item, "Follow-up n" for the others, as the revision
// view names them
const itemLabel = (
  t: (key: string, fallback: string) => string,
  index: number
) =>
  index === 0
    ? t('content_studio_main_post', 'Post')
    : `${t('content_studio_followup', 'Follow-up')} ${index}`;

// The built-in templates and one page of the organization's active ones,
// to start a design from; the current revision of each
const DesignTemplateChoice: FC<{
  value: ContentStudioDesignTemplateCard | null;
  onChange: (template: ContentStudioDesignTemplateCard) => void;
}> = ({ value, onChange }) => {
  const t = useT();
  const [page, setPage] = useState(1);
  const list = useContentStudioDesignTemplates(false, page);
  if (list.error) {
    return (
      <div role="status">
        {t(
          'content_studio_templates_load_error',
          'Templates could not be loaded.'
        )}
      </div>
    );
  }
  if (!list.data) {
    return <LoadingComponent width={40} height={40} />;
  }
  const choices: ContentStudioDesignTemplateCard[] = [
    ...list.data.system,
    ...list.data.results.filter((template) => !template.archivedAt),
  ];
  return (
    <fieldset className="flex flex-col gap-[8px] min-w-0">
      <legend className="text-[14px] mb-[6px]">
        {t('content_studio_template', 'Template')}
      </legend>
      {choices.map((template) => (
        <label
          key={`${template.source}:${template.id}`}
          data-template-choice={template.source}
          className="flex items-start gap-[8px] cursor-pointer border border-newTableBorder rounded-[8px] px-[10px] py-[8px]"
        >
          <input
            type="radio"
            name="package-design-template"
            value={template.id}
            checked={
              value?.source === template.source && value.id === template.id
            }
            onChange={() => onChange(template)}
          />
          <span className="flex flex-col gap-[4px] min-w-0">
            <span className="font-[600] break-words">{template.name}</span>
            {!!template.description && (
              <span className="text-[12px] text-textItemBlur break-words">
                {template.description}
              </span>
            )}
          </span>
        </label>
      ))}
      {list.data.pages > 1 && (
        <ContentStudioPager
          page={page}
          pages={list.data.pages}
          setPage={setPage}
        />
      )}
    </fieldset>
  );
};

// Create design from Version N: the post whose text it starts with (a
// choice only when the version has several), the design's name and where it
// starts. A canvas size or a page set creates it right away, with the text
// in a text layer on the first page; a template goes on to the template's
// fields, where the text takes the field chosen for it. The package's Media
// can go into a template's image field; otherwise they are added in the
// editor. It opens once it exists
export const CreateDesignFromPackageForm: FC<{
  version: ContentStudioPackageDesignVersion;
  close: () => void;
}> = ({ version, close }) => {
  const t = useT();
  const toaster = useToaster();
  const router = useRouter();
  const modals = useModals();
  const { createDesignFromPackageRevision } = useContentStudioDesignActions();
  const { busy, run } = useSingleFlight();
  const [itemId, setItemId] = useState(version.thread[0]?.id ?? '');
  const [name, setName] = useState(
    `${t('content_studio_design_from_version', 'Design from version')} ${
      version.revisionNumber
    }`
  );
  const [start, setStart] = useState<'size' | 'pageSet' | 'template'>('size');
  const [presetId, setPresetId] = useState<string>(DESIGN_CANVAS_PRESETS[0].id);
  const [pageSetId, setPageSetId] = useState<string | null>(null);
  const [template, setTemplate] =
    useState<ContentStudioDesignTemplateCard | null>(null);
  const [fields, setFields] = useState(false);
  const item = version.thread.find((entry) => entry.id === itemId);
  const trimmed = name.trim();
  const ready =
    !!item &&
    !!trimmed &&
    trimmed.length <= DESIGN_NAME_MAX &&
    !trimmed.includes('\0') &&
    (start === 'size' ||
      (start === 'pageSet' && !!pageSetId) ||
      (start === 'template' && !!template));

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!ready || !item) {
        return;
      }
      if (start === 'template') {
        setFields(true);
        return;
      }
      await run('create', async () => {
        try {
          const created = await createDesignFromPackageRevision(
            version.packageId,
            version.revisionId,
            {
              name: trimmed,
              itemId: item.id,
              start:
                start === 'pageSet' && pageSetId
                  ? { pageSetId }
                  : { canvas: presetId },
            }
          );
          toaster.show(
            t('content_studio_design_created', 'Design created.'),
            'success'
          );
          // the history and this form: the new design opens instead
          modals.closeAll();
          router.push(designPagePath(created.id));
        } catch (err) {
          const code = String(designErrorCode(err));
          toaster.show(
            start === 'pageSet' && code.startsWith('CS_DESIGN_PAGE_SET_')
              ? designPageSetErrorMessage(t, err)
              : designFromPackageErrorMessage(t, err),
            'warning'
          );
        }
      });
    },
    [
      ready,
      item,
      start,
      run,
      createDesignFromPackageRevision,
      version,
      trimmed,
      pageSetId,
      presetId,
      toaster,
      modals,
      router,
      t,
    ]
  );

  if (fields && template && item) {
    return (
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
        defaultName={trimmed}
        close={close}
        content={template.currentRevision.content}
        guidance={template.currentRevision.guidance}
        packageSource={{
          packageId: version.packageId,
          revisionId: version.revisionId,
          revisionNumber: version.revisionNumber,
          item,
          mediaTile: (mediaId) => (
            <PackageImageTile preview={version.media[mediaId]} />
          ),
        }}
      />
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <div className="text-[13px] text-textItemBlur">
        {`${t(
          'content_studio_design_from_version_hint',
          'The design starts with the text of saved version'
        )} ${version.revisionNumber}, ${t(
          'content_studio_design_from_version_exact',
          'exactly as saved. Unsaved changes to the draft are not used.'
        )}`}
      </div>
      {version.thread.length > 1 ? (
        <fieldset className="flex flex-col gap-[8px] min-w-0">
          <legend className="text-[14px] mb-[6px]">
            {t('content_studio_design_from_post', 'Post to start from')}
          </legend>
          {version.thread.map((entry, index) => (
            <label
              key={entry.id}
              className="flex items-start gap-[8px] cursor-pointer border border-newTableBorder rounded-[8px] px-[10px] py-[8px] min-w-0"
            >
              <input
                type="radio"
                name="package-design-item"
                value={entry.id}
                checked={itemId === entry.id}
                onChange={() => setItemId(entry.id)}
              />
              <span className="flex flex-col gap-[4px] min-w-0">
                <span className="font-[600]">{itemLabel(t, index)}</span>
                <span className="text-[12px] text-textItemBlur whitespace-pre-wrap break-words line-clamp-3">
                  {entry.text}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        !!item && (
          <div className="flex flex-col gap-[4px] min-w-0">
            <div className="text-[14px]">{itemLabel(t, 0)}</div>
            <div className="text-[12px] text-textItemBlur whitespace-pre-wrap break-words line-clamp-3">
              {item.text}
            </div>
          </div>
        )
      )}
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
      />
      <fieldset className="flex flex-wrap gap-[16px]">
        <legend className="text-[14px] mb-[6px]">
          {t('content_studio_design_start_with', 'Start with')}
        </legend>
        {(
          [
            ['size', t('content_studio_design_start_size', 'One canvas size')],
            [
              'pageSet',
              t('content_studio_design_start_page_set', 'A page set'),
            ],
            [
              'template',
              t('content_studio_design_start_template', 'A template'),
            ],
          ] as const
        ).map(([value, label]) => (
          <label
            key={value}
            className="flex items-center gap-[8px] cursor-pointer"
          >
            <input
              type="radio"
              name="package-design-start"
              value={value}
              checked={start === value}
              onChange={() => setStart(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {start === 'template' ? (
        <DesignTemplateChoice value={template} onChange={setTemplate} />
      ) : start === 'pageSet' ? (
        <DesignPageSetPicker value={pageSetId} onChange={setPageSetId} />
      ) : (
        <DesignCanvasChoice value={presetId} onChange={setPresetId} />
      )}
      {start !== 'template' && (
        <div className="text-[13px] text-textItemBlur">
          {t(
            'content_studio_design_from_package_layer',
            'The text is added as a text layer on the first page. Images of the package can be added in the editor.'
          )}
        </div>
      )}
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button type="submit" loading={!!busy} disabled={!!busy || !ready}>
          {start === 'template'
            ? t('content_studio_next', 'Next')
            : t('content_studio_create_design', 'Create design')}
        </Button>
      </div>
    </form>
  );
};

// Where a design came from (P6-01): the package and the exact saved version,
// linked to that version (never the package's latest). Shown as the server
// verified it; a newer version of the package changes nothing here
export const DesignPackageSource: FC<{
  source: ContentStudioDesignSource;
  onOpen?: (href: string) => Promise<boolean>;
}> = ({ source, onOpen }) => {
  const t = useT();
  const router = useRouter();
  const href = contentStudioReviewTargetHref({
    type: 'PACKAGE_REVISION',
    parentId: source.packageId,
    revisionId: source.packageRevisionId,
  });
  return (
    <div
      data-design-source
      className="flex flex-wrap gap-x-[8px] text-[12px] text-textItemBlur"
    >
      <span>
        {`${t(
          'content_studio_design_created_from_package',
          'Created from package'
        )}: ${source.packageName} · ${t(
          'content_studio_revision',
          'Version'
        )} ${source.packageRevisionNumber}`}
      </span>
      <Link
        href={href}
        className="hover:underline"
        onClick={async (event) => {
          if (!onOpen) {
            return;
          }
          event.preventDefault();
          if (await onOpen(href)) {
            router.push(href);
          }
        }}
      >
        {`${t(
          'content_studio_design_open_source',
          'Open source package Version'
        )} ${source.packageRevisionNumber}`}
      </Link>
    </div>
  );
};
