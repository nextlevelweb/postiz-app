'use client';

import { FC, FormEvent, useCallback, useState } from 'react';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';
import { useSingleFlight } from '@gitroom/frontend/components/content-studio/content-studio.projects.modal';
import type { ContentStudioBrandKitContentV1 } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import type {
  ContentStudioDesignDocumentV1,
  ContentStudioDesignLayer,
  ContentStudioDesignPage,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioDesignLayoutPatternContentV1,
  DESIGN_LAYOUT_PATTERN_DESCRIPTION_MAX,
  DESIGN_LAYOUT_PATTERN_NAME_MAX,
  extractContentStudioDesignLayoutPattern,
  parseContentStudioDesignLayoutPatternContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.layout.pattern';
import { insertContentStudioDesignLayoutPattern } from '@gitroom/frontend/components/content-studio/content-studio.design.editor';
import { ContentStudioDesignEditor } from '@gitroom/frontend/components/content-studio/content-studio.design.editing';
import { ContentStudioDesignPageThumbnail } from '@gitroom/frontend/components/content-studio/content-studio.design.preview';
import { useContentStudioDesignActions } from '@gitroom/frontend/components/content-studio/content-studio.designs.api';
import {
  ContentStudioDesignLayoutPattern,
  ContentStudioOrganizationDesignLayoutPattern,
  designLayoutPatternErrorMessage,
  useContentStudioDesignLayoutPatternActions,
  useContentStudioDesignLayoutPatterns,
} from '@gitroom/frontend/components/content-studio/content-studio.design-layout-patterns.api';

// Layouts in the editor (P4-15): the built-in and the organization's layout
// patterns. Insert copies a pattern's layers onto the current page of the
// draft, centered, in front of the others and under new ids, as one undo
// step; nothing of the pattern stays in the design. Save selection as
// layout sends the chosen layers of one page only, without their ids. Each
// pattern shows a small DOM thumbnail drawn from its own layers (no render,
// Media request, font download or canvas), with Brand Kit tokens resolved
// only from the design's own exact revision

// The content, or null when it does not parse as Layout Pattern v1
const parsePattern = (content: unknown) => {
  try {
    return parseContentStudioDesignLayoutPatternContent(content);
  } catch {
    return null;
  }
};

// The pattern's box as a page for the thumbnail: its own layers, white
const thumbnailPage = (
  content: ContentStudioDesignLayoutPatternContentV1
): ContentStudioDesignPage => ({
  id: 'layout',
  name: '',
  width: content.width,
  height: content.height,
  background: { type: 'solid', color: { type: 'literal', value: '#ffffff' } },
  layers: content.layers.map(
    (layer, index) =>
      ({ ...layer, id: `layout_${index}` } as ContentStudioDesignLayer)
  ),
});

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
    maxLength={DESIGN_LAYOUT_PATTERN_NAME_MAX}
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
      {t('content_studio_layout_description', 'Description')}
      <textarea
        className="bg-newBgColorInner min-h-[64px] p-[10px] border-newTableBorder border rounded-[8px] text-textColor text-[14px] w-full min-w-0"
        value={value}
        maxLength={DESIGN_LAYOUT_PATTERN_DESCRIPTION_MAX}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
};

const validText = (value: string, max: number, required: boolean) => {
  const trimmed = value.trim();
  return (
    (!required || !!trimmed) && trimmed.length <= max && !trimmed.includes('\0')
  );
};

// A new pattern from exactly the chosen layers, as they are in the draft now
const SaveLayoutForm: FC<{
  content: ContentStudioDesignLayoutPatternContentV1;
  close: () => void;
}> = ({ content, close }) => {
  const t = useT();
  const toaster = useToaster();
  const { createPattern } = useContentStudioDesignLayoutPatternActions();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const { busy, run } = useSingleFlight();
  const valid =
    validText(name, DESIGN_LAYOUT_PATTERN_NAME_MAX, true) &&
    validText(description, DESIGN_LAYOUT_PATTERN_DESCRIPTION_MAX, false);
  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!valid) {
        return;
      }
      await run('save', async () => {
        try {
          await createPattern({
            name: name.trim(),
            description: description.trim(),
            content,
          });
          toaster.show(
            t('content_studio_layout_saved', 'Layout saved.'),
            'success'
          );
          close();
        } catch (err) {
          toaster.show(designLayoutPatternErrorMessage(t, err), 'warning');
        }
      });
    },
    [valid, run, createPattern, name, description, content, toaster, close, t]
  );
  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <div className="text-[13px] text-textItemBlur">
        {`${content.layers.length} ${t(
          'content_studio_layout_save_layers',
          'layers'
        )} · ${t(
          'content_studio_layout_save_hint',
          'The layers are saved as they are now, without the page or the Brand Kit. Designs that use the layout later get a copy.'
        )}`}
      </div>
      <NameField
        label={t('content_studio_layout_name', 'Layout name')}
        value={name}
        onChange={setName}
      />
      <DescriptionField value={description} onChange={setDescription} />
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button type="submit" loading={!!busy} disabled={!!busy || !valid}>
          {t('content_studio_layout_save', 'Save layout')}
        </Button>
      </div>
    </form>
  );
};

// The name and the description of an organization pattern
const LayoutDetailsForm: FC<{
  pattern: ContentStudioOrganizationDesignLayoutPattern;
  close: () => void;
}> = ({ pattern, close }) => {
  const t = useT();
  const toaster = useToaster();
  const { updatePattern } = useContentStudioDesignLayoutPatternActions();
  const [name, setName] = useState(pattern.name);
  const [description, setDescription] = useState(pattern.description ?? '');
  const { busy, run } = useSingleFlight();
  const changed =
    validText(name, DESIGN_LAYOUT_PATTERN_NAME_MAX, true) &&
    validText(description, DESIGN_LAYOUT_PATTERN_DESCRIPTION_MAX, false) &&
    (name.trim() !== pattern.name ||
      description.trim() !== (pattern.description ?? ''));
  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!changed) {
        return;
      }
      await run('details', async () => {
        try {
          await updatePattern(pattern.id, {
            name: name.trim(),
            description: description.trim(),
          });
          toaster.show(
            t('content_studio_layout_updated', 'Layout updated.'),
            'success'
          );
          close();
        } catch (err) {
          toaster.show(designLayoutPatternErrorMessage(t, err), 'warning');
        }
      });
    },
    [changed, run, updatePattern, pattern, name, description, toaster, close, t]
  );
  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <NameField
        label={t('content_studio_layout_name', 'Layout name')}
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

// The organization's archived patterns, each restorable
const ArchivedLayouts: FC<{
  brand: ContentStudioBrandKitContentV1 | null;
}> = ({ brand }) => {
  const t = useT();
  const toaster = useToaster();
  const { restorePattern } = useContentStudioDesignLayoutPatternActions();
  const [page, setPage] = useState(1);
  const list = useContentStudioDesignLayoutPatterns(true, true, page);
  const { busy, run } = useSingleFlight();
  if (list.error) {
    return (
      <div role="alert">
        {t('content_studio_layouts_load_error', 'Layouts could not be loaded.')}
      </div>
    );
  }
  if (!list.data) {
    return <LoadingComponent width={40} height={40} />;
  }
  return (
    <div className="flex flex-col gap-[8px] min-w-0">
      {!list.data.results.length ? (
        <div className="text-textItemBlur">
          {t('content_studio_layouts_none_archived', 'No archived layouts.')}
        </div>
      ) : (
        <ul
          aria-label={t('content_studio_layouts_archived', 'Archived layouts')}
          className="flex flex-col gap-[6px]"
        >
          {list.data.results.map((pattern) => {
            const content = parsePattern(pattern.content);
            return (
              <li
                key={pattern.id}
                className="flex items-center gap-[8px] border border-newTableBorder rounded-[8px] px-[10px] py-[6px]"
              >
                {content && (
                  <ContentStudioDesignPageThumbnail
                    page={thumbnailPage(content)}
                    brand={brand}
                  />
                )}
                <span className="flex-1 min-w-0 break-words">
                  {pattern.name}
                </span>
                <Button
                  secondary
                  loading={busy === pattern.id}
                  disabled={!!busy}
                  aria-label={`${t('content_studio_restore', 'Restore')} ${
                    pattern.name
                  }`}
                  onClick={() =>
                    run(pattern.id, async () => {
                      try {
                        await restorePattern(pattern.id);
                        toaster.show(
                          t(
                            'content_studio_layout_restored',
                            'Layout restored.'
                          ),
                          'success'
                        );
                      } catch (err) {
                        toaster.show(
                          designLayoutPatternErrorMessage(t, err),
                          'warning'
                        );
                      }
                    })
                  }
                >
                  {t('content_studio_restore', 'Restore')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
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

// One pattern: its thumbnail, name, source as text and its actions
const LayoutRow: FC<{
  pattern: ContentStudioDesignLayoutPattern;
  brand: ContentStudioBrandKitContentV1 | null;
  disabled: boolean;
  inserting: boolean;
  onInsert: (content: ContentStudioDesignLayoutPatternContentV1) => void;
}> = ({ pattern, brand, disabled, inserting, onInsert }) => {
  const t = useT();
  const toaster = useToaster();
  const modals = useModals();
  const { archivePattern } = useContentStudioDesignLayoutPatternActions();
  const { busy, run } = useSingleFlight();
  const content = parsePattern(pattern.content);
  const organization = pattern.source === 'organization' ? pattern : null;
  return (
    <li
      data-layout-pattern={pattern.source}
      className="flex flex-col gap-[6px] border border-newTableBorder rounded-[8px] px-[10px] py-[8px] min-w-0"
    >
      <div className="flex items-center gap-[8px] min-w-0">
        {content && (
          <ContentStudioDesignPageThumbnail
            page={thumbnailPage(content)}
            brand={brand}
          />
        )}
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-[13px] font-[600] break-words">
            {pattern.name}
          </span>
          <span className="text-[11px] text-textItemBlur">
            {organization
              ? t('content_studio_layout_organization', 'Organization')
              : t('content_studio_layout_built_in', 'Built-in')}
            {content &&
              ` · ${content.layers.length} ${t(
                'content_studio_layout_save_layers',
                'layers'
              )}`}
          </span>
        </div>
      </div>
      {!content && (
        <div role="alert" className="text-[12px]">
          {t(
            'content_studio_layout_error_integrity',
            'Stored layout data could not be read safely.'
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-[4px]">
        <Button
          secondary
          className="h-[28px] px-[10px] text-[12px]"
          loading={inserting}
          disabled={disabled || !content}
          aria-label={`${t('content_studio_layout_insert', 'Insert')} ${
            pattern.name
          }`}
          onClick={() => content && onInsert(content)}
        >
          {t('content_studio_layout_insert', 'Insert')}
        </Button>
        {organization && (
          <>
            <Button
              secondary
              className="h-[28px] px-[10px] text-[12px]"
              disabled={!!busy}
              aria-label={`${t('content_studio_layout_edit', 'Edit details')} ${
                pattern.name
              }`}
              onClick={() =>
                modals.openModal({
                  title: t('content_studio_layout_edit', 'Edit details'),
                  children: (close: () => void) => (
                    <LayoutDetailsForm pattern={organization} close={close} />
                  ),
                })
              }
            >
              {t('content_studio_layout_edit', 'Edit details')}
            </Button>
            <Button
              secondary
              className="h-[28px] px-[10px] text-[12px]"
              loading={busy === 'archive'}
              disabled={!!busy}
              aria-label={`${t('content_studio_archive', 'Archive')} ${
                pattern.name
              }`}
              onClick={() =>
                run('archive', async () => {
                  try {
                    await archivePattern(organization.id);
                    toaster.show(
                      t(
                        'content_studio_layout_archived',
                        'Layout archived. Designs that used it keep their layers.'
                      ),
                      'success'
                    );
                  } catch (err) {
                    toaster.show(
                      designLayoutPatternErrorMessage(t, err),
                      'warning'
                    );
                  }
                })
              }
            >
              {t('content_studio_archive', 'Archive')}
            </Button>
          </>
        )}
      </div>
    </li>
  );
};

// The distinct images of a pattern: Media id and the SHA-256 it names
const imagesOf = (content: ContentStudioDesignLayoutPatternContentV1) => {
  const images = new Map<string, string[]>();
  for (const layer of content.layers) {
    if (layer.type === 'image') {
      const hashes = images.get(layer.imageRef.mediaId) ?? [];
      if (!hashes.includes(layer.imageRef.sha256)) {
        hashes.push(layer.imageRef.sha256);
      }
      images.set(layer.imageRef.mediaId, hashes);
    }
  }
  return Array.from(images.entries());
};

export const DesignLayoutPatterns: FC<{
  editor: ContentStudioDesignEditor;
  document: ContentStudioDesignDocumentV1;
  page: ContentStudioDesignPage;
  layerIds: string[];
  brand: ContentStudioBrandKitContentV1 | null;
  onInserted: (layerIds: string[]) => void;
  // the Creative Library's search and source filter (P4-18): which entries
  // are shown; every entry when left out
  matches?: (entry: {
    name: string;
    description: string | null;
    source: 'system' | 'organization';
  }) => boolean;
}> = ({
  editor,
  document,
  page,
  layerIds,
  brand,
  onInserted,
  matches = () => true,
}) => {
  const t = useT();
  const modals = useModals();
  const toaster = useToaster();
  const { getMediaDesignRef } = useContentStudioDesignActions();
  // the catalog loads only once it is opened
  const [open, setOpen] = useState(false);
  const [listPage, setListPage] = useState(1);
  const list = useContentStudioDesignLayoutPatterns(open, false, listPage);
  const { busy, run } = useSingleFlight();
  const disabled = editor.saving || editor.interacting || !!busy;
  const selection = layerIds.length
    ? extractContentStudioDesignLayoutPattern(document, layerIds)
    : null;

  // Every image must still be the organization's Media with exactly the
  // bytes the pattern names; then the layers go in as one undo step, all of
  // them selected, the front one primary. Anything refused inserts nothing
  const insert = (
    pattern: ContentStudioDesignLayoutPattern,
    content: ContentStudioDesignLayoutPatternContentV1
  ) =>
    run(`insert:${pattern.source}:${pattern.id}`, async () => {
      for (const [mediaId, hashes] of imagesOf(content)) {
        let available = false;
        try {
          const ref = await getMediaDesignRef(mediaId);
          available =
            ref.mediaId === mediaId &&
            hashes.length === 1 &&
            ref.sha256 === hashes[0];
        } catch {
          available = false;
        }
        if (!available) {
          toaster.show(
            t(
              'content_studio_layout_insert_media',
              'An image in this layout is no longer available in your media library. Nothing was inserted.'
            ),
            'warning'
          );
          return;
        }
      }
      const inserted = editor.apply((latest) => {
        const outcome = insertContentStudioDesignLayoutPattern(
          latest,
          page.id,
          content,
          brand
        );
        return { document: outcome.document, result: outcome.layerIds };
      });
      if (inserted) {
        onInserted(inserted);
      }
    });

  const saveSelection = () => {
    if (!selection) {
      return;
    }
    modals.openModal({
      title: t('content_studio_layout_save_title', 'Save selection as layout'),
      children: (close: () => void) => (
        <SaveLayoutForm content={selection} close={close} />
      ),
    });
  };
  const rows = (
    patterns: ContentStudioDesignLayoutPattern[],
    label: string
  ) => (
    <ul aria-label={label} className="flex flex-col gap-[6px]">
      {patterns.map((pattern) => (
        <LayoutRow
          key={`${pattern.source}:${pattern.id}`}
          pattern={pattern}
          brand={brand}
          disabled={disabled}
          inserting={busy === `insert:${pattern.source}:${pattern.id}`}
          onInsert={(content) => insert(pattern, content)}
        />
      ))}
    </ul>
  );

  return (
    <section
      aria-label={t('content_studio_layouts', 'Layouts')}
      className="flex flex-col gap-[8px] min-w-0"
    >
      <h2 className="font-[600]">{t('content_studio_layouts', 'Layouts')}</h2>
      <div className="text-[12px] text-textItemBlur">
        {t(
          'content_studio_layouts_hint',
          'Inserting copies the layers onto this page; they do not stay linked.'
        )}
      </div>
      <div className="flex flex-wrap gap-[6px]">
        <Button
          secondary
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open
            ? t('content_studio_layouts_hide', 'Hide layouts')
            : t('content_studio_layouts_show', 'Browse layouts')}
        </Button>
        <Button
          secondary
          disabled={editor.saving || editor.interacting || !selection}
          onClick={saveSelection}
        >
          {t('content_studio_layout_save_title', 'Save selection as layout')}
        </Button>
        <Button
          secondary
          onClick={() =>
            modals.openModal({
              title: t('content_studio_layouts_archived', 'Archived layouts'),
              children: () => <ArchivedLayouts brand={brand} />,
            })
          }
        >
          {t('content_studio_layouts_archived', 'Archived layouts')}
        </Button>
      </div>
      {open &&
        (list.error ? (
          <div role="status">
            {t(
              'content_studio_layouts_load_error',
              'Layouts could not be loaded.'
            )}
          </div>
        ) : !list.data ? (
          <LoadingComponent width={40} height={40} />
        ) : (
          <>
            <h3 className="text-[13px] font-[600]">
              {t('content_studio_layouts_built_in', 'Built-in')}
            </h3>
            {rows(
              list.data.system.filter(matches),
              `${t('content_studio_layouts_built_in', 'Built-in')} · ${t(
                'content_studio_layouts',
                'Layouts'
              )}`
            )}
            <h3 className="text-[13px] font-[600]">
              {t('content_studio_layouts_organization', 'Organization')}
            </h3>
            {list.data.results.length ? (
              rows(
                list.data.results.filter(
                  (pattern) => !pattern.archivedAt && matches(pattern)
                ),
                `${t(
                  'content_studio_layouts_organization',
                  'Organization'
                )} · ${t('content_studio_layouts', 'Layouts')}`
              )
            ) : (
              <div className="text-[12px] text-textItemBlur">
                {t(
                  'content_studio_layouts_none',
                  'No organization layouts yet. Select layers and save them as a layout.'
                )}
              </div>
            )}
            {list.data.pages > 1 && (
              <ContentStudioPager
                page={listPage}
                pages={list.data.pages}
                setPage={setListPage}
              />
            )}
          </>
        ))}
    </section>
  );
};
