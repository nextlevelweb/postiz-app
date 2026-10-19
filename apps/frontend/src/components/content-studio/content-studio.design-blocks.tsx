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
  ContentStudioDesignBlockContentV1,
  DESIGN_BLOCK_DESCRIPTION_MAX,
  DESIGN_BLOCK_NAME_MAX,
  extractContentStudioDesignBlock,
  parseContentStudioDesignBlockContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.block';
import { insertContentStudioDesignBlock } from '@gitroom/frontend/components/content-studio/content-studio.design.editor';
import { ContentStudioDesignEditor } from '@gitroom/frontend/components/content-studio/content-studio.design.editing';
import { ContentStudioDesignPageThumbnail } from '@gitroom/frontend/components/content-studio/content-studio.design.preview';
import { useContentStudioDesignActions } from '@gitroom/frontend/components/content-studio/content-studio.designs.api';
import {
  ContentStudioDesignBlock,
  ContentStudioOrganizationDesignBlock,
  designBlockErrorMessage,
  useContentStudioDesignBlockActions,
  useContentStudioDesignBlocks,
} from '@gitroom/frontend/components/content-studio/content-studio.design-blocks.api';

// Design blocks in the editor (P4-18): the organization's reusable creative
// assets. Insert copies a block's layers onto the current page of the
// draft, centered, in front of the others and under new ids, as one undo
// step; nothing of the block stays in the design. Save as block sends the
// chosen layers of one page only, without their ids. Each block shows a
// small DOM thumbnail drawn from its own layers (no render, Media request,
// font download or canvas), with Brand Kit tokens resolved only from the
// design's own exact revision. The same layer snapshot, thumbnail and
// insert rules as layout patterns (P4-15); stored and listed apart

// The content, or null when it does not parse as the layer snapshot
const parseBlock = (content: unknown) => {
  try {
    return parseContentStudioDesignBlockContent(content);
  } catch {
    return null;
  }
};

// The block's box as a page for the thumbnail: its own layers, white
const thumbnailPage = (
  content: ContentStudioDesignBlockContentV1
): ContentStudioDesignPage => ({
  id: 'block',
  name: '',
  width: content.width,
  height: content.height,
  background: { type: 'solid', color: { type: 'literal', value: '#ffffff' } },
  layers: content.layers.map(
    (layer, index) =>
      ({ ...layer, id: `block_${index}` } as ContentStudioDesignLayer)
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
    maxLength={DESIGN_BLOCK_NAME_MAX}
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
      {t('content_studio_block_description', 'Description')}
      <textarea
        className="bg-newBgColorInner min-h-[64px] p-[10px] border-newTableBorder border rounded-[8px] text-textColor text-[14px] w-full min-w-0"
        value={value}
        maxLength={DESIGN_BLOCK_DESCRIPTION_MAX}
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

// A new block from exactly the chosen layers, as they are in the draft now
const SaveBlockForm: FC<{
  content: ContentStudioDesignBlockContentV1;
  close: () => void;
}> = ({ content, close }) => {
  const t = useT();
  const toaster = useToaster();
  const { createBlock } = useContentStudioDesignBlockActions();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const { busy, run } = useSingleFlight();
  const valid =
    validText(name, DESIGN_BLOCK_NAME_MAX, true) &&
    validText(description, DESIGN_BLOCK_DESCRIPTION_MAX, false);
  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!valid) {
        return;
      }
      await run('save', async () => {
        try {
          await createBlock({
            name: name.trim(),
            description: description.trim(),
            content,
          });
          toaster.show(
            t('content_studio_block_saved', 'Block saved.'),
            'success'
          );
          close();
        } catch (err) {
          toaster.show(designBlockErrorMessage(t, err), 'warning');
        }
      });
    },
    [valid, run, createBlock, name, description, content, toaster, close, t]
  );
  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <div className="text-[13px] text-textItemBlur">
        {`${content.layers.length} ${t(
          'content_studio_block_layers',
          'layers'
        )} · ${t(
          'content_studio_block_save_hint',
          'The layers are saved as they are now, with their text, styles and images, without the page or the Brand Kit. Designs that use the block later get a copy.'
        )}`}
      </div>
      <NameField
        label={t('content_studio_block_name', 'Block name')}
        value={name}
        onChange={setName}
      />
      <DescriptionField value={description} onChange={setDescription} />
      <div className="flex gap-[8px] justify-end">
        <Button type="button" secondary onClick={close}>
          {t('cancel', 'Cancel')}
        </Button>
        <Button type="submit" loading={!!busy} disabled={!!busy || !valid}>
          {t('content_studio_block_save', 'Save block')}
        </Button>
      </div>
    </form>
  );
};

// The name and the description of a block
const BlockDetailsForm: FC<{
  block: ContentStudioOrganizationDesignBlock;
  close: () => void;
}> = ({ block, close }) => {
  const t = useT();
  const toaster = useToaster();
  const { updateBlock } = useContentStudioDesignBlockActions();
  const [name, setName] = useState(block.name);
  const [description, setDescription] = useState(block.description ?? '');
  const { busy, run } = useSingleFlight();
  const changed =
    validText(name, DESIGN_BLOCK_NAME_MAX, true) &&
    validText(description, DESIGN_BLOCK_DESCRIPTION_MAX, false) &&
    (name.trim() !== block.name ||
      description.trim() !== (block.description ?? ''));
  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!changed) {
        return;
      }
      await run('details', async () => {
        try {
          await updateBlock(block.id, {
            name: name.trim(),
            description: description.trim(),
          });
          toaster.show(
            t('content_studio_block_updated', 'Block updated.'),
            'success'
          );
          close();
        } catch (err) {
          toaster.show(designBlockErrorMessage(t, err), 'warning');
        }
      });
    },
    [changed, run, updateBlock, block, name, description, toaster, close, t]
  );
  return (
    <form onSubmit={submit} className="flex flex-col gap-[16px] min-w-0">
      <NameField
        label={t('content_studio_block_name', 'Block name')}
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

// The organization's archived blocks, each restorable
const ArchivedBlocks: FC<{
  brand: ContentStudioBrandKitContentV1 | null;
}> = ({ brand }) => {
  const t = useT();
  const toaster = useToaster();
  const { restoreBlock } = useContentStudioDesignBlockActions();
  const [page, setPage] = useState(1);
  const list = useContentStudioDesignBlocks(true, true, page);
  const { busy, run } = useSingleFlight();
  if (list.error) {
    return (
      <div role="alert">
        {t('content_studio_blocks_load_error', 'Blocks could not be loaded.')}
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
          {t('content_studio_blocks_none_archived', 'No archived blocks.')}
        </div>
      ) : (
        <ul
          aria-label={t('content_studio_blocks_archived', 'Archived blocks')}
          className="flex flex-col gap-[6px]"
        >
          {list.data.results.map((block) => {
            const content = parseBlock(block.content);
            return (
              <li
                key={block.id}
                className="flex items-center gap-[8px] border border-newTableBorder rounded-[8px] px-[10px] py-[6px]"
              >
                {content && (
                  <ContentStudioDesignPageThumbnail
                    page={thumbnailPage(content)}
                    brand={brand}
                  />
                )}
                <span className="flex-1 min-w-0 break-words">{block.name}</span>
                <Button
                  secondary
                  loading={busy === block.id}
                  disabled={!!busy}
                  aria-label={`${t('content_studio_restore', 'Restore')} ${
                    block.name
                  }`}
                  onClick={() =>
                    run(block.id, async () => {
                      try {
                        await restoreBlock(block.id);
                        toaster.show(
                          t('content_studio_block_restored', 'Block restored.'),
                          'success'
                        );
                      } catch (err) {
                        toaster.show(
                          designBlockErrorMessage(t, err),
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

// One block: its thumbnail, name, source as text and its actions
const BlockRow: FC<{
  block: ContentStudioDesignBlock;
  brand: ContentStudioBrandKitContentV1 | null;
  disabled: boolean;
  inserting: boolean;
  onInsert: (content: ContentStudioDesignBlockContentV1) => void;
}> = ({ block, brand, disabled, inserting, onInsert }) => {
  const t = useT();
  const toaster = useToaster();
  const modals = useModals();
  const { archiveBlock } = useContentStudioDesignBlockActions();
  const { busy, run } = useSingleFlight();
  const content = parseBlock(block.content);
  // every block is the organization's own
  const organization = block;
  return (
    <li
      data-design-block={block.source}
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
            {block.name}
          </span>
          <span className="text-[11px] text-textItemBlur">
            {t('content_studio_block_organization', 'Organization')}
            {content &&
              ` · ${content.layers.length} ${t(
                'content_studio_block_layers',
                'layers'
              )}`}
          </span>
        </div>
      </div>
      {!content && (
        <div role="alert" className="text-[12px]">
          {t(
            'content_studio_block_error_integrity',
            'Stored block data could not be read safely.'
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-[4px]">
        <Button
          secondary
          className="h-[28px] px-[10px] text-[12px]"
          loading={inserting}
          disabled={disabled || !content}
          aria-label={`${t('content_studio_block_insert', 'Insert')} ${
            block.name
          }`}
          onClick={() => content && onInsert(content)}
        >
          {t('content_studio_block_insert', 'Insert')}
        </Button>
        {organization && (
          <>
            <Button
              secondary
              className="h-[28px] px-[10px] text-[12px]"
              disabled={!!busy}
              aria-label={`${t('content_studio_block_edit', 'Edit details')} ${
                block.name
              }`}
              onClick={() =>
                modals.openModal({
                  title: t('content_studio_block_edit', 'Edit details'),
                  children: (close: () => void) => (
                    <BlockDetailsForm block={organization} close={close} />
                  ),
                })
              }
            >
              {t('content_studio_block_edit', 'Edit details')}
            </Button>
            <Button
              secondary
              className="h-[28px] px-[10px] text-[12px]"
              loading={busy === 'archive'}
              disabled={!!busy}
              aria-label={`${t('content_studio_archive', 'Archive')} ${
                block.name
              }`}
              onClick={() =>
                run('archive', async () => {
                  try {
                    await archiveBlock(organization.id);
                    toaster.show(
                      t(
                        'content_studio_block_archived',
                        'Block archived. Designs that used it keep their layers.'
                      ),
                      'success'
                    );
                  } catch (err) {
                    toaster.show(designBlockErrorMessage(t, err), 'warning');
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

// The distinct images of a block: Media id and the SHA-256 it names
const imagesOf = (content: ContentStudioDesignBlockContentV1) => {
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

export const DesignBlocks: FC<{
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
  const list = useContentStudioDesignBlocks(open, false, listPage);
  const { busy, run } = useSingleFlight();
  const disabled = editor.saving || editor.interacting || !!busy;
  const selection = layerIds.length
    ? extractContentStudioDesignBlock(document, layerIds)
    : null;

  // Every image must still be the organization's Media with exactly the
  // bytes the block names; then the layers go in as one undo step, all of
  // them selected, the front one primary. Anything refused inserts nothing
  const insert = (
    block: ContentStudioDesignBlock,
    content: ContentStudioDesignBlockContentV1
  ) =>
    run(`insert:${block.source}:${block.id}`, async () => {
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
              'content_studio_block_insert_media',
              'An image in this block is no longer available in your media library. Nothing was inserted.'
            ),
            'warning'
          );
          return;
        }
      }
      const inserted = editor.apply((latest) => {
        const outcome = insertContentStudioDesignBlock(
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
      title: t('content_studio_block_save_title', 'Save as block'),
      children: (close: () => void) => (
        <SaveBlockForm content={selection} close={close} />
      ),
    });
  };
  const rows = (blocks: ContentStudioDesignBlock[], label: string) => (
    <ul aria-label={label} className="flex flex-col gap-[6px]">
      {blocks.map((block) => (
        <BlockRow
          key={`${block.source}:${block.id}`}
          block={block}
          brand={brand}
          disabled={disabled}
          inserting={busy === `insert:${block.source}:${block.id}`}
          onInsert={(content) => insert(block, content)}
        />
      ))}
    </ul>
  );

  return (
    <section
      aria-label={t('content_studio_blocks', 'Blocks')}
      className="flex flex-col gap-[8px] min-w-0"
    >
      <h2 className="font-[600]">{t('content_studio_blocks', 'Blocks')}</h2>
      <div className="text-[12px] text-textItemBlur">
        {t(
          'content_studio_blocks_hint',
          'Inserting a block copies its layers onto this page; they do not stay linked.'
        )}
      </div>
      <div className="flex flex-wrap gap-[6px]">
        <Button
          secondary
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open
            ? t('content_studio_blocks_hide', 'Hide blocks')
            : t('content_studio_blocks_show', 'Browse blocks')}
        </Button>
        <Button
          secondary
          disabled={editor.saving || editor.interacting || !selection}
          onClick={saveSelection}
        >
          {t('content_studio_block_save_title', 'Save as block')}
        </Button>
        <Button
          secondary
          onClick={() =>
            modals.openModal({
              title: t('content_studio_blocks_archived', 'Archived blocks'),
              children: () => <ArchivedBlocks brand={brand} />,
            })
          }
        >
          {t('content_studio_blocks_archived', 'Archived blocks')}
        </Button>
      </div>
      {open &&
        (list.error ? (
          <div role="status">
            {t(
              'content_studio_blocks_load_error',
              'Blocks could not be loaded.'
            )}
          </div>
        ) : !list.data ? (
          <LoadingComponent width={40} height={40} />
        ) : (
          <>
            <h3 className="text-[13px] font-[600]">
              {t('content_studio_blocks_organization', 'Organization')}
            </h3>
            {list.data.results.length ? (
              rows(
                list.data.results.filter(
                  (block) => !block.archivedAt && matches(block)
                ),
                `${t(
                  'content_studio_blocks_organization',
                  'Organization'
                )} · ${t('content_studio_blocks', 'Blocks')}`
              )
            ) : (
              <div className="text-[12px] text-textItemBlur">
                {t(
                  'content_studio_blocks_none',
                  'No blocks yet. Select layers and save them as a block.'
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
