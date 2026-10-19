'use client';

import { FC, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Button } from '@gitroom/react/form/button';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';
import type { ContentStudioBrandKitContentV1 } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import {
  ContentStudioDesignDocumentV1,
  ContentStudioDesignPage,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import { addContentStudioDesignImageLayer } from '@gitroom/frontend/components/content-studio/content-studio.design.editor';
import {
  ContentStudioDesignEditor,
  DesignMediaPicker,
} from '@gitroom/frontend/components/content-studio/content-studio.design.editing';
import { ContentStudioDesignPageThumbnail } from '@gitroom/frontend/components/content-studio/content-studio.design.preview';
import { DesignBlocks } from '@gitroom/frontend/components/content-studio/content-studio.design-blocks';
import { DesignLayoutPatterns } from '@gitroom/frontend/components/content-studio/content-studio.design-layout-patterns';
import { DesignPageSets } from '@gitroom/frontend/components/content-studio/content-studio.design-page-sets';
import { UseTemplateForm } from '@gitroom/frontend/components/content-studio/content-studio.design-templates';
import {
  ContentStudioDesignTemplateCard,
  useContentStudioDesignTemplates,
} from '@gitroom/frontend/components/content-studio/content-studio.design-templates.api';

// The Creative Library (P4-18): one place in the editor to browse what can
// be reused, without merging what it is. Each category keeps its own data,
// API and rules, and only the active one is shown and loaded:
// - Blocks: the organization's design blocks, inserted as copied layers;
// - Layouts: layout patterns (P4-15), inserted as copied layers;
// - Templates: design templates (P4-11), used as before, to start a new
//   design (never inserted into this page);
// - Page sets: page sets (P4-17), added as blank pages;
// - Media: the organization's image Media, added as an image layer through
//   the existing picker.
// Search (name and description) and the source filter are view state of
// this panel only, applied to the entries already loaded; nothing of the
// library is saved, and nothing here changes the design but a category's
// own Insert, Add or Use

type Translate = (key: string, fallback: string) => string;

export type ContentStudioLibraryCategory =
  | 'blocks'
  | 'layouts'
  | 'templates'
  | 'pageSets'
  | 'media';
type LibrarySource = 'all' | 'system' | 'organization';

const CATEGORIES = (
  t: Translate
): Array<[ContentStudioLibraryCategory, string]> => [
  ['blocks', t('content_studio_library_blocks', 'Blocks')],
  ['layouts', t('content_studio_library_layouts', 'Layouts')],
  ['templates', t('content_studio_library_templates', 'Templates')],
  ['pageSets', t('content_studio_library_page_sets', 'Page sets')],
  ['media', t('content_studio_library_media', 'Media')],
];
// the categories that have built-in entries next to the organization's
const WITH_SOURCES: ContentStudioLibraryCategory[] = [
  'layouts',
  'templates',
  'pageSets',
];

// An entry is shown when its name or description has the search text
// (any case, trimmed) and it comes from the chosen source
const libraryMatcher =
  (query: string, source: LibrarySource) =>
  (entry: {
    name: string;
    description: string | null;
    source: 'system' | 'organization';
  }) => {
    const text = query.trim().toLowerCase();
    return (
      (source === 'all' || entry.source === source) &&
      (!text ||
        entry.name.toLowerCase().includes(text) ||
        (entry.description ?? '').toLowerCase().includes(text))
    );
  };

// The template's current document, or null when it does not parse
const templateDocument = (content: unknown) => {
  try {
    return parseContentStudioDesignDocument(content);
  } catch {
    return null;
  }
};

// The design templates, built-in and active of the organization, each with
// its first page drawn by the structural preview (Brand Kit tokens show as
// unresolved here: the template library resolves them). Use template opens
// the existing form, which starts a new design from it
const LibraryTemplates: FC<{
  matches: ReturnType<typeof libraryMatcher>;
}> = ({ matches }) => {
  const t = useT();
  const modals = useModals();
  const [page, setPage] = useState(1);
  const list = useContentStudioDesignTemplates(false, page);
  if (list.error) {
    return (
      <div role="status">
        {t(
          'content_studio_library_templates_error',
          'Templates could not be loaded.'
        )}
      </div>
    );
  }
  if (!list.data) {
    return <LoadingComponent width={40} height={40} />;
  }
  const templates: ContentStudioDesignTemplateCard[] = [
    ...list.data.system,
    ...list.data.results.filter((template) => !template.archivedAt),
  ].filter(matches);
  const use = (template: ContentStudioDesignTemplateCard) =>
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
          content={template.currentRevision.content}
          guidance={template.currentRevision.guidance}
        />
      ),
    });
  return (
    <div className="flex flex-col gap-[8px] min-w-0">
      <div className="text-[12px] text-textItemBlur">
        {t(
          'content_studio_library_templates_hint',
          'A template starts a new design; it is not added to this page.'
        )}
      </div>
      {!templates.length ? (
        <div className="text-[12px] text-textItemBlur">
          {t('content_studio_library_none', 'Nothing matches.')}
        </div>
      ) : (
        <ul
          aria-label={t('content_studio_library_templates', 'Templates')}
          className="flex flex-col gap-[6px]"
        >
          {templates.map((template) => {
            const document = templateDocument(template.currentRevision.content);
            const first: ContentStudioDesignPage | undefined =
              document?.pages[0];
            return (
              <li
                key={`${template.source}:${template.id}`}
                data-library-template={template.source}
                className="flex flex-col gap-[6px] border border-newTableBorder rounded-[8px] px-[10px] py-[8px] min-w-0"
              >
                <div className="flex items-center gap-[8px] min-w-0">
                  {first && (
                    <ContentStudioDesignPageThumbnail
                      page={first}
                      brand={null}
                    />
                  )}
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-[13px] font-[600] break-words">
                      {template.name}
                    </span>
                    <span className="text-[11px] text-textItemBlur">
                      {`${
                        template.source === 'system'
                          ? t('content_studio_template_built_in', 'Built-in')
                          : t(
                              'content_studio_template_organization',
                              'Organization'
                            )
                      }${
                        document
                          ? ` · ${document.pages.length} ${t(
                              'content_studio_page_set_pages',
                              'pages'
                            )} · ${first?.width} × ${first?.height}`
                          : ''
                      }`}
                    </span>
                  </div>
                </div>
                <div>
                  <Button
                    secondary
                    className="h-[28px] px-[10px] text-[12px]"
                    aria-label={`${t(
                      'content_studio_use_template',
                      'Use template'
                    )} ${template.name}`}
                    onClick={() => use(template)}
                  >
                    {t('content_studio_use_template', 'Use template')}
                  </Button>
                </div>
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

// The organization's image Media, through the existing picker: the chosen
// item is added as an image layer of this page, as Add image does. Nothing
// is loaded until the picker opens
const LibraryMedia: FC<{
  editor: ContentStudioDesignEditor;
  page: ContentStudioDesignPage;
  onAdded: (layerId: string) => void;
}> = ({ editor, page, onAdded }) => {
  const t = useT();
  const modals = useModals();
  return (
    <div className="flex flex-col gap-[8px] min-w-0">
      <div className="text-[12px] text-textItemBlur">
        {t(
          'content_studio_library_media_hint',
          'Images from your media library are added as an image layer; to replace an image, select its layer and use Replace image.'
        )}
      </div>
      <div>
        <Button
          secondary
          disabled={editor.saving || editor.interacting}
          onClick={() =>
            modals.openModal({
              title: t('content_studio_design_add_image', 'Add image'),
              children: (close: () => void) => (
                <DesignMediaPicker
                  close={close}
                  onPicked={(ref) => {
                    const layerId = editor.apply((latest) => {
                      const added = addContentStudioDesignImageLayer(
                        latest,
                        page.id,
                        ref
                      );
                      return {
                        document: added.document,
                        result: added.layerId,
                      };
                    });
                    if (layerId) {
                      onAdded(layerId);
                    }
                  }}
                />
              ),
            })
          }
        >
          {t('content_studio_library_media_add', 'Add image from Media')}
        </Button>
      </div>
    </div>
  );
};

export const DesignCreativeLibrary: FC<{
  editor: ContentStudioDesignEditor;
  document: ContentStudioDesignDocumentV1;
  page: ContentStudioDesignPage;
  layerIds: string[];
  brand: ContentStudioBrandKitContentV1 | null;
  // the inserted layers become the selection, the front one primary
  onLayersInserted: (layerIds: string[]) => void;
  // the first added page opens with nothing selected
  onPagesAdded: (pageIds: string[]) => void;
}> = ({
  editor,
  document,
  page,
  layerIds,
  brand,
  onLayersInserted,
  onPagesAdded,
}) => {
  const t = useT();
  const [category, setCategory] =
    useState<ContentStudioLibraryCategory>('blocks');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<LibrarySource>('all');
  const matches = useMemo(
    () =>
      libraryMatcher(query, WITH_SOURCES.includes(category) ? source : 'all'),
    [query, source, category]
  );
  const searchable = category !== 'media';

  return (
    <section
      aria-label={t('content_studio_library', 'Creative library')}
      className="flex flex-col gap-[8px] min-w-0"
    >
      <h2 className="font-[600]">
        {t('content_studio_library', 'Creative library')}
      </h2>
      <div
        role="group"
        aria-label={t('content_studio_library_category', 'Library category')}
        className="flex flex-wrap gap-[4px]"
      >
        {CATEGORIES(t).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={category === id}
            className={clsx(
              'px-[8px] h-[28px] rounded-[6px] border text-[12px]',
              category === id
                ? 'border-textColor/60 bg-boxFocused'
                : 'border-newTableBorder'
            )}
            onClick={() => setCategory(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {searchable && (
        <div className="flex gap-[8px] items-end">
          <label className="flex flex-col gap-[4px] text-[12px] min-w-0 flex-1">
            {t('content_studio_library_search', 'Search')}
            <input
              type="search"
              className="bg-newBgColorInner h-[32px] px-[10px] border-newTableBorder border rounded-[8px] text-textColor text-[13px] w-full min-w-0"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {WITH_SOURCES.includes(category) && (
            <label className="flex flex-col gap-[4px] text-[12px]">
              {t('content_studio_library_source', 'Source')}
              <select
                className="bg-newBgColorInner h-[32px] px-[8px] border-newTableBorder border rounded-[8px] text-textColor text-[13px]"
                value={source}
                onChange={(e) => setSource(e.target.value as LibrarySource)}
              >
                <option value="all">
                  {t('content_studio_library_source_all', 'All')}
                </option>
                <option value="system">
                  {t('content_studio_library_source_system', 'Built-in')}
                </option>
                <option value="organization">
                  {t(
                    'content_studio_library_source_organization',
                    'Organization'
                  )}
                </option>
              </select>
            </label>
          )}
        </div>
      )}
      {category === 'blocks' && (
        <DesignBlocks
          editor={editor}
          document={document}
          page={page}
          layerIds={layerIds}
          brand={brand}
          onInserted={onLayersInserted}
          matches={matches}
        />
      )}
      {category === 'layouts' && (
        <DesignLayoutPatterns
          editor={editor}
          document={document}
          page={page}
          layerIds={layerIds}
          brand={brand}
          onInserted={onLayersInserted}
          matches={matches}
        />
      )}
      {category === 'templates' && <LibraryTemplates matches={matches} />}
      {category === 'pageSets' && (
        <DesignPageSets
          editor={editor}
          document={document}
          onAdded={onPagesAdded}
          matches={matches}
        />
      )}
      {category === 'media' && (
        <LibraryMedia
          editor={editor}
          page={page}
          onAdded={(layerId) => onLayersInserted([layerId])}
        />
      )}
    </section>
  );
};
