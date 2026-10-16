'use client';

import { FC, ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import Link from 'next/link';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { ContentStudioPager } from '@gitroom/frontend/components/content-studio/content-studio.package.list';
import { formatDate } from '@gitroom/frontend/components/content-studio/intelligence/content-studio.intelligence.shared';
import {
  ContentStudioBrandKitContentV1,
  parseContentStudioBrandKitContent,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import {
  ContentStudioDesignBrandKitRef,
  ContentStudioDesignColorValue,
  ContentStudioDesignDocumentV1,
  ContentStudioDesignFontRef,
  ContentStudioDesignLayer,
  ContentStudioDesignPage,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioDesignBatchRender,
  ContentStudioDesignDetail,
  ContentStudioDesignPageRender,
  ContentStudioDesignRevisionSummary,
  designErrorCode,
  designRenderErrorMessage,
  useContentStudioBrandKitRevision,
  useContentStudioDesign,
  useContentStudioDesignActions,
  useContentStudioDesignRevision,
  useContentStudioDesignRevisions,
  useContentStudioRenderedMedia,
} from '@gitroom/frontend/components/content-studio/content-studio.designs.api';
import {
  DESIGN_LIBRARY_PATH,
  DesignLifecycleActions,
  DesignStatus,
  useDesignCommands,
} from '@gitroom/frontend/components/content-studio/content-studio.designs';
import {
  ContentStudioDesignPreview,
  resolveDesignPreviewColor,
  resolveDesignPreviewFont,
} from '@gitroom/frontend/components/content-studio/content-studio.design.preview';

// The Creative Studio workspace of one design: its pages and layers, a live
// structural preview, a read-only inspector, the revision history, and
// server renders of one page or all pages. Every revision is read-only here,
// the current one included: nothing in this workspace saves a revision. A
// historical revision is shown and rendered exactly as it was stored; nothing
// restores it. Documents are checked again with the Design Document v1
// parser before they are shown, and the Brand Kit revision a document names
// is loaded by its exact id and must match the reference before its tokens
// are used

// The document, or null when it does not parse as Design Document v1
const parseDesign = (content: unknown) => {
  try {
    return parseContentStudioDesignDocument(content);
  } catch {
    return null;
  }
};

// The revision the workspace shows: the current one or an opened one
interface ShownRevision {
  id: string;
  revisionNumber: number;
  historical: boolean;
}

type BrandState =
  | { status: 'none' | 'loading' | 'error'; content: null }
  | { status: 'ready'; content: ContentStudioBrandKitContentV1 };

// The exact Brand Kit revision of the reference: its id, number and hash
// must be the reference's, and its content a valid Brand Kit. Never the
// current kit, never another revision
const useDesignBrand = (
  ref: ContentStudioDesignBrandKitRef | null
): BrandState => {
  const revision = useContentStudioBrandKitRevision(ref?.revisionId ?? null);
  return useMemo(() => {
    if (!ref) {
      return { status: 'none', content: null };
    }
    if (revision.error) {
      return { status: 'error', content: null };
    }
    if (!revision.data) {
      return { status: 'loading', content: null };
    }
    if (
      revision.data.id !== ref.revisionId ||
      revision.data.revisionNumber !== ref.revisionNumber ||
      revision.data.contentHash !== ref.contentHash
    ) {
      return { status: 'error', content: null };
    }
    try {
      return {
        status: 'ready',
        content: parseContentStudioBrandKitContent(revision.data.content),
      };
    } catch {
      return { status: 'error', content: null };
    }
  }, [ref, revision.data, revision.error]);
};

type RenderResult =
  | {
      kind: 'page';
      revisionNumber: number;
      pageNumber: number;
      pageName: string;
      render: ContentStudioDesignPageRender;
    }
  | {
      kind: 'all';
      revisionNumber: number;
      pageNames: Record<string, string>;
      render: ContentStudioDesignBatchRender;
    };

// Renders only on request, one at a time per workspace: a page render and a
// render of all pages never run together, and a double click sends one
// request. A result keeps the revision and page it was asked for, whatever
// is shown by the time it arrives. It lives in this component only: the
// Media it names stays stored, and nothing is kept in the browser
const useDesignRender = (designId: string) => {
  const t = useT();
  const toaster = useToaster();
  const { renderDesignPage, renderAllDesignPages } =
    useContentStudioDesignActions();
  const running = useRef(false);
  const [rendering, setRendering] = useState<'page' | 'all' | null>(null);
  const [result, setResult] = useState<RenderResult | null>(null);

  const start = useCallback(
    async (kind: 'page' | 'all', work: () => Promise<void>) => {
      if (running.current) {
        return;
      }
      running.current = true;
      setRendering(kind);
      try {
        await work();
      } finally {
        running.current = false;
        setRendering(null);
      }
    },
    []
  );

  const renderPage = useCallback(
    (revision: ShownRevision, page: ContentStudioDesignPage, index: number) =>
      start('page', async () => {
        try {
          const render = await renderDesignPage(designId, revision.id, page.id);
          setResult({
            kind: 'page',
            revisionNumber: revision.revisionNumber,
            pageNumber: index + 1,
            pageName: page.name,
            render,
          });
          toaster.show(
            t('content_studio_design_page_rendered', 'Page rendered.'),
            'success'
          );
        } catch (err) {
          // a previous result stays: it is still a stored Media
          toaster.show(designRenderErrorMessage(t, err, 'page'), 'warning');
        }
      }),
    [designId, start, renderDesignPage, toaster, t]
  );

  const renderAll = useCallback(
    (revision: ShownRevision, document: ContentStudioDesignDocumentV1) =>
      start('all', async () => {
        const pageNames = Object.fromEntries(
          document.pages.map((page) => [page.id, page.name])
        );
        try {
          const render = await renderAllDesignPages(designId, revision.id);
          setResult({
            kind: 'all',
            revisionNumber: revision.revisionNumber,
            pageNames,
            render,
          });
          toaster.show(
            t('content_studio_design_pages_rendered', 'All pages rendered.'),
            'success'
          );
        } catch (err) {
          toaster.show(designRenderErrorMessage(t, err, 'all'), 'warning');
        }
      }),
    [designId, start, renderAllDesignPages, toaster, t]
  );

  return { rendering, result, renderPage, renderAll };
};

const pageLabel = (
  t: (key: string, fallback: string) => string,
  number: number,
  name: string
) =>
  `${t('content_studio_design_page', 'Page')} ${number}${
    name ? ` · ${name}` : ''
  }`;

export const designLayerTypeLabel = (
  t: (key: string, fallback: string) => string,
  layer: ContentStudioDesignLayer
) => {
  switch (layer.type) {
    case 'text':
      return t('content_studio_design_layer_text', 'Text');
    case 'image':
      return t('content_studio_design_layer_image', 'Image');
    default:
      return layer.shape === 'ellipse'
        ? t('content_studio_design_layer_ellipse', 'Ellipse')
        : t('content_studio_design_layer_rectangle', 'Rectangle');
  }
};

const LAYER_ICON: Record<string, string> = {
  text: 'T',
  rectangle: '▭',
  ellipse: '◯',
  image: '▣',
};

const Fact: FC<{ label: string; children: ReactNode }> = ({
  label,
  children,
}) => (
  <div className="flex flex-col gap-[2px] min-w-0">
    <dt className="text-[12px] text-textItemBlur">{label}</dt>
    <dd className="break-words">{children}</dd>
  </div>
);

const ColorValue: FC<{
  value: ContentStudioDesignColorValue;
  brand: ContentStudioBrandKitContentV1 | null;
}> = ({ value, brand }) => {
  const t = useT();
  const color = resolveDesignPreviewColor(value, brand);
  const token =
    value.type === 'brand'
      ? brand?.colors.find((entry) => entry.id === value.tokenId)
      : undefined;
  if (!color) {
    return (
      <span role="status" className="text-red-400">
        {t(
          'content_studio_design_brand_color_unavailable',
          'Brand color unavailable.'
        )}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-[6px]">
      <span
        aria-hidden="true"
        className="inline-block w-[14px] h-[14px] rounded-[3px] border border-newTableBorder"
        style={{ backgroundColor: color }}
      />
      <span>{token ? `${token.name} · ${color}` : color}</span>
    </span>
  );
};

const FontValue: FC<{
  value: ContentStudioDesignFontRef;
  brand: ContentStudioBrandKitContentV1 | null;
}> = ({ value, brand }) => {
  const t = useT();
  const font = resolveDesignPreviewFont(value, brand);
  if (!font) {
    return (
      <span role="status" className="text-red-400">
        {t(
          'content_studio_design_brand_font_unavailable',
          'Brand font unavailable.'
        )}
      </span>
    );
  }
  const token =
    value.type === 'brand'
      ? brand?.typography.find((entry) => entry.id === value.tokenId)
      : undefined;
  const spec = `${font.family} · ${font.weight} · ${font.style}`;
  return <span>{token ? `${token.name} · ${spec}` : spec}</span>;
};

const ALIGN: Record<string, [string, string]> = {
  left: ['content_studio_design_align_left', 'Left'],
  center: ['content_studio_design_align_center', 'Center'],
  right: ['content_studio_design_align_right', 'Right'],
  top: ['content_studio_design_align_top', 'Top'],
  middle: ['content_studio_design_align_middle', 'Middle'],
  bottom: ['content_studio_design_align_bottom', 'Bottom'],
  clip: ['content_studio_design_overflow_clip', 'Clip'],
  shrink: ['content_studio_design_overflow_shrink', 'Shrink to fit'],
  cover: ['content_studio_design_fit_cover', 'Cover'],
  contain: ['content_studio_design_fit_contain', 'Contain'],
};

// What the selected page or layer is, as stored: read-only, with tokens
// resolved from the exact Brand Kit revision. No hash, Media URL or storage
// detail
const DesignInspector: FC<{
  page: ContentStudioDesignPage;
  layer: ContentStudioDesignLayer | null;
  brand: ContentStudioBrandKitContentV1 | null;
}> = ({ page, layer, brand }) => {
  const t = useT();
  const word = (value: string) => t(ALIGN[value][0], ALIGN[value][1]);
  if (!layer) {
    return (
      <dl className="grid grid-cols-1 gap-[10px]">
        <Fact label={t('content_studio_design_width', 'Width')}>
          {page.width}
        </Fact>
        <Fact label={t('content_studio_design_height', 'Height')}>
          {page.height}
        </Fact>
        <Fact label={t('content_studio_design_background', 'Background')}>
          <ColorValue value={page.background.color} brand={brand} />
        </Fact>
      </dl>
    );
  }
  return (
    <dl className="grid grid-cols-1 gap-[10px]">
      <Fact label={t('content_studio_design_type', 'Type')}>
        {designLayerTypeLabel(t, layer)}
      </Fact>
      <Fact label={t('content_studio_design_position', 'Position')}>
        {layer.x}, {layer.y}
      </Fact>
      <Fact label={t('content_studio_design_size', 'Size')}>
        {layer.width} × {layer.height}
      </Fact>
      <Fact label={t('content_studio_design_rotation', 'Rotation')}>
        {layer.rotation}°
      </Fact>
      <Fact label={t('content_studio_design_opacity', 'Opacity')}>
        {layer.opacity}
      </Fact>
      <Fact label={t('content_studio_design_visible', 'Visible')}>
        {layer.visible
          ? t('content_studio_design_yes', 'Yes')
          : t('content_studio_design_no', 'No')}
      </Fact>
      {layer.type === 'text' && (
        <>
          <Fact label={t('content_studio_design_text', 'Text')}>
            <span className="whitespace-pre-wrap">{layer.text}</span>
          </Fact>
          <Fact label={t('content_studio_design_font', 'Font')}>
            <FontValue value={layer.font} brand={brand} />
          </Fact>
          <Fact label={t('content_studio_design_font_size', 'Font size')}>
            {layer.fontSize}
          </Fact>
          <Fact label={t('content_studio_design_line_height', 'Line height')}>
            {layer.lineHeight}
          </Fact>
          <Fact
            label={t('content_studio_design_letter_spacing', 'Letter spacing')}
          >
            {layer.letterSpacing}
          </Fact>
          <Fact label={t('content_studio_design_alignment', 'Alignment')}>
            {word(layer.align)}
          </Fact>
          <Fact
            label={t(
              'content_studio_design_vertical_alignment',
              'Vertical alignment'
            )}
          >
            {word(layer.verticalAlign)}
          </Fact>
          <Fact label={t('content_studio_design_overflow', 'Overflow')}>
            {word(layer.overflow)}
            {layer.overflow === 'shrink' && (
              <div className="text-[12px] text-textItemBlur">
                {t(
                  'content_studio_design_shrink_hint',
                  'Final shrink-to-fit is applied by the server renderer.'
                )}
              </div>
            )}
          </Fact>
          <Fact label={t('content_studio_design_color', 'Color')}>
            <ColorValue value={layer.color} brand={brand} />
          </Fact>
        </>
      )}
      {layer.type === 'shape' && (
        <>
          <Fact label={t('content_studio_design_fill', 'Fill')}>
            <ColorValue value={layer.fill} brand={brand} />
          </Fact>
          {layer.shape === 'rectangle' && (
            <Fact
              label={t('content_studio_design_corner_radius', 'Corner radius')}
            >
              {layer.cornerRadius}
            </Fact>
          )}
        </>
      )}
      {layer.type === 'image' && (
        <>
          <Fact label={t('content_studio_design_media', 'Media')}>
            {t('content_studio_design_media_linked', 'Linked Media image')}
            <div className="text-[12px] text-textItemBlur">
              {t(
                'content_studio_design_media_hint',
                'The image is drawn by the server render once its Media is verified.'
              )}
            </div>
          </Fact>
          <Fact label={t('content_studio_design_fit', 'Fit')}>
            {word(layer.fit)}
          </Fact>
          <Fact label={t('content_studio_design_focal_point', 'Focal point')}>
            {layer.focalPoint.x}, {layer.focalPoint.y}
          </Fact>
        </>
      )}
    </dl>
  );
};

// The layers of the page, front-most first, as editors list them. A copy is
// reversed: the document's order (first is at the back) is never changed
const DesignLayerList: FC<{
  page: ContentStudioDesignPage;
  selected: string | null;
  onSelect: (id: string | null) => void;
}> = ({ page, selected, onSelect }) => {
  const t = useT();
  if (!page.layers.length) {
    return (
      <div className="text-textItemBlur text-[13px]">
        {t('content_studio_design_no_layers', 'No layers on this page.')}
      </div>
    );
  }
  return (
    <ul
      aria-label={t('content_studio_design_layers', 'Layers')}
      className="flex flex-col gap-[4px]"
    >
      {[...page.layers].reverse().map((layer) => {
        const icon =
          layer.type === 'shape'
            ? LAYER_ICON[layer.shape]
            : LAYER_ICON[layer.type];
        return (
          <li key={layer.id}>
            <button
              type="button"
              aria-pressed={selected === layer.id}
              onClick={() => onSelect(selected === layer.id ? null : layer.id)}
              className={clsx(
                'w-full flex items-center gap-[8px] text-start px-[8px] py-[6px] rounded-[6px] border',
                selected === layer.id
                  ? 'border-textColor/60 bg-boxFocused'
                  : 'border-newTableBorder'
              )}
            >
              <span aria-hidden="true" className="w-[16px] text-center">
                {icon}
              </span>
              <span className="flex-1 min-w-0 truncate">
                {layer.name || designLayerTypeLabel(t, layer)}
              </span>
              {!layer.visible && (
                <span className="text-[11px] text-textItemBlur">
                  {t('content_studio_design_hidden', 'Hidden')}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
};

// The URL the Media API gave for a Media, when it is a web or app path
const mediaUrl = (value: string | null | undefined) =>
  typeof value === 'string' && /^(https?:\/\/|\/(?!\/))/i.test(value)
    ? value
    : null;

// A rendered PNG, shown from the Media API's own record of it, never from a
// URL built here
const RenderedMediaPreview: FC<{ mediaId: string; label: string }> = ({
  mediaId,
  label,
}) => {
  const t = useT();
  const media = useContentStudioRenderedMedia(mediaId);
  const src = mediaUrl(media.data?.thumbnail) ?? mediaUrl(media.data?.path);
  if (src) {
    return (
      <img
        src={src}
        alt={label}
        className="max-w-full max-h-[240px] object-contain border border-newTableBorder rounded-[6px]"
      />
    );
  }
  if (!media.data && !media.error) {
    return <LoadingComponent width={32} height={32} />;
  }
  return (
    <div className="text-[13px] text-textItemBlur">
      {t('content_studio_design_media_created', 'Rendered media created.')}
    </div>
  );
};

// The last successful render of this visit, for the revision and pages it
// was asked for
const DesignRenderResult: FC<{ result: RenderResult }> = ({ result }) => {
  const t = useT();
  const revision = `${t(
    'content_studio_design_rendered_revision',
    'Rendered revision'
  )} ${result.revisionNumber}`;
  if (result.kind === 'page') {
    const label = pageLabel(t, result.pageNumber, result.pageName);
    return (
      <section
        aria-label={t('content_studio_design_rendered_page', 'Rendered page')}
        className="flex flex-col gap-[8px] border border-newTableBorder rounded-[8px] p-[12px]"
      >
        <h3 className="font-[600]">
          {t('content_studio_design_rendered_page', 'Rendered page')}
        </h3>
        <div className="text-[13px] text-textItemBlur flex flex-wrap gap-x-[12px]">
          <span>{revision}</span>
          <span>{label}</span>
          <span>
            {result.render.width} × {result.render.height}
          </span>
        </div>
        <RenderedMediaPreview
          mediaId={result.render.renderedMediaId}
          label={label}
        />
      </section>
    );
  }
  return (
    <section
      aria-label={t('content_studio_design_rendered_pages', 'Rendered pages')}
      className="flex flex-col gap-[8px] border border-newTableBorder rounded-[8px] p-[12px]"
    >
      <h3 className="font-[600]">
        {t('content_studio_design_rendered_pages', 'Rendered pages')}
      </h3>
      <div className="text-[13px] text-textItemBlur">{revision}</div>
      <ol className="flex flex-col gap-[12px]">
        {result.render.outputs.map((output) => {
          const label = pageLabel(
            t,
            output.pageIndex + 1,
            result.pageNames[output.pageId] ?? ''
          );
          return (
            <li key={output.renderId} className="flex flex-col gap-[6px]">
              <div className="text-[13px] flex flex-wrap gap-x-[12px]">
                <span className="font-[600]">{label}</span>
                <span className="text-textItemBlur">
                  {output.width} × {output.height}
                </span>
                <span className="text-textItemBlur">
                  {t('content_studio_design_render_completed', 'Completed')}
                </span>
              </div>
              <RenderedMediaPreview
                mediaId={output.renderedMediaId}
                label={label}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
};

// The Brand Kit revision the shown document is pinned to, if any
const DesignBrandProvenance: FC<{
  reference: ContentStudioDesignBrandKitRef | null;
  brand: BrandState;
}> = ({ reference, brand }) => {
  const t = useT();
  if (!reference) {
    return (
      <div className="text-[13px] text-textItemBlur">
        {t(
          'content_studio_design_no_brand_kit',
          'No Brand Kit revision attached'
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-[4px] text-[13px]">
      <div className="font-[600]">
        {t('content_studio_design_brand_kit', 'Brand Kit')} ·{' '}
        {t('content_studio_design_revision', 'Revision')}{' '}
        {reference.revisionNumber}
      </div>
      <div className="text-textItemBlur">
        {t('content_studio_design_brand_pinned', 'Pinned revision')}.{' '}
        {t(
          'content_studio_design_brand_pinned_hint',
          'This design is pinned to a specific Brand Kit revision.'
        )}
      </div>
      {brand.status === 'error' && (
        <div role="alert" className="text-red-400">
          {t(
            'content_studio_design_brand_load_error',
            'Brand Kit revision could not be loaded.'
          )}
        </div>
      )}
    </div>
  );
};

// The revisions of the design, newest first, one server page at a time.
// Metadata only: a revision's document is loaded when it is opened
const DesignHistory: FC<{
  history: ReturnType<typeof useContentStudioDesignRevisions>;
  latestRevisionNumber: number;
  shownId: string;
  page: number;
  setPage: (page: number) => void;
  onView: (revision: ContentStudioDesignRevisionSummary) => void;
}> = ({ history, latestRevisionNumber, shownId, page, setPage, onView }) => {
  const t = useT();
  if (history.error) {
    return (
      <div role="alert">
        {t(
          'content_studio_design_history_load_error',
          'Revision history could not be loaded.'
        )}
      </div>
    );
  }
  if (!history.data) {
    return <LoadingComponent width={40} height={40} />;
  }
  return (
    <div className="flex flex-col gap-[12px]">
      <ul className="flex flex-col gap-[8px]">
        {history.data.results.map((revision) => {
          const label = `${t('content_studio_design_revision', 'Revision')} ${
            revision.revisionNumber
          }`;
          return (
            <li
              key={revision.id}
              className="flex flex-wrap items-center gap-[8px] border border-newTableBorder rounded-[8px] p-[12px]"
            >
              <div className="flex flex-col gap-[2px] flex-1 min-w-[160px]">
                <div className="font-[600] flex flex-wrap gap-[8px] items-center">
                  <span>{label}</span>
                  {revision.revisionNumber === latestRevisionNumber && (
                    <span className="text-[11px] px-[8px] rounded-full border border-newTableBorder">
                      {t('content_studio_design_current', 'Current')}
                    </span>
                  )}
                </div>
                <div className="text-[12px] text-textItemBlur">
                  {formatDate(revision.createdAt)}
                </div>
              </div>
              <Button
                secondary
                disabled={revision.id === shownId}
                aria-label={`${t(
                  'content_studio_view_source',
                  'View'
                )} ${label}`}
                onClick={() => onView(revision)}
              >
                {revision.id === shownId
                  ? t('content_studio_design_shown', 'Shown')
                  : t('content_studio_view_source', 'View')}
              </Button>
            </li>
          );
        })}
      </ul>
      {history.data.pages > 1 && (
        <ContentStudioPager
          page={page}
          pages={history.data.pages}
          setPage={setPage}
        />
      )}
    </div>
  );
};

// Pages, preview, layers and inspector of one parsed revision, with the
// render actions for exactly that revision
const DesignRevisionView: FC<{
  revision: ShownRevision;
  document: ContentStudioDesignDocumentV1;
  pageId: string | null;
  setPageId: (id: string) => void;
  render: ReturnType<typeof useDesignRender>;
}> = ({ revision, document, pageId, setPageId, render }) => {
  const t = useT();
  const brand = useDesignBrand(document.brandKit);
  const [layerId, setLayerId] = useState<string | null>(null);
  // the page chosen before, while this revision still has it; else the first
  const index = Math.max(
    document.pages.findIndex((page) => page.id === pageId),
    0
  );
  const page = document.pages[index];
  const layer = page.layers.find((entry) => entry.id === layerId) ?? null;
  const label = pageLabel(t, index + 1, page.name);

  return (
    <div className="flex flex-col gap-[16px] min-w-0">
      <div className="flex flex-wrap gap-[8px]">
        <Button
          loading={render.rendering === 'page'}
          disabled={!!render.rendering}
          onClick={() => render.renderPage(revision, page, index)}
        >
          {t('content_studio_design_render_page', 'Render page')}
        </Button>
        <Button
          secondary
          loading={render.rendering === 'all'}
          disabled={!!render.rendering}
          onClick={() => render.renderAll(revision, document)}
        >
          {t('content_studio_design_render_all', 'Render all pages')}
        </Button>
      </div>
      <div className="grid grid-cols-[200px_minmax(0,1fr)_280px] tablet:grid-cols-1 gap-[16px] min-w-0">
        <div className="flex flex-col gap-[16px] min-w-0">
          <section className="flex flex-col gap-[8px]">
            <h2 className="font-[600]">
              {t('content_studio_design_pages', 'Pages')}
            </h2>
            <ul
              aria-label={t('content_studio_design_pages', 'Pages')}
              className="flex flex-col gap-[4px]"
            >
              {document.pages.map((entry, position) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    aria-pressed={position === index}
                    onClick={() => {
                      setPageId(entry.id);
                      setLayerId(null);
                    }}
                    className={clsx(
                      'w-full flex flex-col text-start px-[8px] py-[6px] rounded-[6px] border',
                      position === index
                        ? 'border-textColor/60 bg-boxFocused'
                        : 'border-newTableBorder'
                    )}
                  >
                    <span>
                      {t('content_studio_design_page', 'Page')} {position + 1}
                    </span>
                    {!!entry.name && (
                      <span className="text-[12px] text-textItemBlur truncate">
                        {entry.name}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="flex flex-col gap-[8px]">
            <h2 className="font-[600]">
              {t('content_studio_design_layers', 'Layers')}
            </h2>
            <div className="text-[12px] text-textItemBlur">
              {t('content_studio_design_layers_order', 'Front to back')}
            </div>
            <DesignLayerList
              page={page}
              selected={layer?.id ?? null}
              onSelect={setLayerId}
            />
          </section>
        </div>
        <div className="flex flex-col gap-[16px] min-w-0">
          <ContentStudioDesignPreview
            page={page}
            pageLabel={label}
            brand={brand.content}
          />
          {render.result && <DesignRenderResult result={render.result} />}
        </div>
        <div className="flex flex-col gap-[16px] min-w-0">
          <section className="flex flex-col gap-[8px]">
            <h2 className="font-[600]">
              {layer
                ? `${t('content_studio_design_layer', 'Layer')} · ${
                    layer.name || designLayerTypeLabel(t, layer)
                  }`
                : label}
            </h2>
            <DesignInspector page={page} layer={layer} brand={brand.content} />
          </section>
          <section className="flex flex-col gap-[8px]">
            <h2 className="font-[600]">
              {t('content_studio_design_brand_kit', 'Brand Kit')}
            </h2>
            <DesignBrandProvenance
              reference={document.brandKit}
              brand={brand}
            />
          </section>
        </div>
      </div>
    </div>
  );
};

const NotLoaded: FC<{ children: ReactNode; retry?: () => void }> = ({
  children,
  retry,
}) => {
  const t = useT();
  return (
    <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col items-center gap-[12px] py-[40px] min-w-0">
      <div role="alert">{children}</div>
      {retry && (
        <Button secondary onClick={retry}>
          {t('content_studio_retry', 'Try again')}
        </Button>
      )}
      <Link href={DESIGN_LIBRARY_PATH} className="underline">
        {t('content_studio_back_to_creative_studio', 'Back to Creative Studio')}
      </Link>
    </div>
  );
};

// One design: its current revision (or an opened older one), read-only, and
// its history. An archived design stays readable and renderable; only its
// rename is gone until it is restored
export const ContentStudioDesignWorkspace: FC<{ designId: string }> = ({
  designId,
}) => {
  const t = useT();
  const detail = useContentStudioDesign(designId);
  const [historyPage, setHistoryPage] = useState(1);
  const history = useContentStudioDesignRevisions(designId, historyPage);
  const [viewing, setViewing] = useState<{
    id: string;
    revisionNumber: number;
  } | null>(null);
  const opened = useContentStudioDesignRevision(designId, viewing?.id ?? null);
  const [pageId, setPageId] = useState<string | null>(null);
  const commands = useDesignCommands();
  const render = useDesignRender(designId);

  const currentRevision = detail.data?.currentRevision;
  const currentDocument = useMemo(
    () => (currentRevision ? parseDesign(currentRevision.content) : null),
    [currentRevision]
  );
  const openedDocument = useMemo(
    () => (opened.data ? parseDesign(opened.data.content) : null),
    [opened.data]
  );

  if (detail.error) {
    const code = designErrorCode(detail.error);
    return code === 'CS_NOT_FOUND' ? (
      <NotLoaded>
        {t('content_studio_design_not_found', 'Design not found.')}
      </NotLoaded>
    ) : code === 'CS_DESIGN_INTEGRITY_ERROR' ? (
      <NotLoaded>
        {t(
          'content_studio_design_unsafe',
          'Design could not be loaded safely.'
        )}
      </NotLoaded>
    ) : (
      <NotLoaded retry={() => detail.mutate()}>
        {t('content_studio_design_load_error', 'Design could not be loaded.')}
      </NotLoaded>
    );
  }
  if (!detail.data || !currentRevision) {
    return <LoadingComponent />;
  }
  if (!currentDocument) {
    return (
      <NotLoaded>
        {t(
          'content_studio_design_unsafe',
          'Design could not be loaded safely.'
        )}
      </NotLoaded>
    );
  }

  const design: ContentStudioDesignDetail = detail.data;
  const shown: ShownRevision = viewing
    ? { ...viewing, historical: true }
    : {
        id: currentRevision.id,
        revisionNumber: currentRevision.revisionNumber,
        historical: false,
      };
  const busy = commands.busy[design.id];
  const openedCode = designErrorCode(opened.error);

  return (
    <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col gap-[20px] min-w-0">
      <div className="flex flex-wrap items-start gap-[12px]">
        <div className="flex flex-col gap-[6px] flex-1 min-w-[200px]">
          <Link
            href={DESIGN_LIBRARY_PATH}
            className="text-[13px] text-textItemBlur hover:underline"
          >
            {t('content_studio_creative_studio', 'Creative Studio')}
          </Link>
          <h1 className="text-[20px] font-[600] break-words">{design.name}</h1>
          <div className="flex flex-wrap gap-x-[16px] gap-y-[4px] text-[12px] text-textItemBlur">
            <DesignStatus design={design} />
            <span>
              {t('content_studio_design_revision', 'Revision')}{' '}
              {shown.revisionNumber}
              {shown.historical &&
                ` · ${t('content_studio_design_historical', 'Historical')}`}
            </span>
            <span>
              {t('content_studio_updated', 'Updated')}:{' '}
              {formatDate(design.updatedAt)}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-[8px]">
          <DesignLifecycleActions
            design={design}
            busy={busy}
            commands={commands}
          />
        </div>
      </div>

      {shown.historical ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-[12px] border border-newTableBorder rounded-[8px] p-[12px]"
        >
          <div className="flex flex-col gap-[2px] flex-1 min-w-[200px]">
            <div className="font-[600]">
              {t('content_studio_design_viewing_revision', 'Viewing revision')}{' '}
              {shown.revisionNumber}
            </div>
            <div className="text-[13px] text-textItemBlur">
              {t(
                'content_studio_design_historical_read_only',
                'Read-only historical revision'
              )}
            </div>
          </div>
          <Button secondary onClick={() => setViewing(null)}>
            {t('content_studio_design_back_to_current', 'Back to current')}
          </Button>
        </div>
      ) : (
        <div className="text-[13px] text-textItemBlur">
          {t(
            'content_studio_design_read_only',
            'This revision is read-only: inspect it here and render it to Media.'
          )}
        </div>
      )}

      {!shown.historical ? (
        <DesignRevisionView
          key={shown.id}
          revision={shown}
          document={currentDocument}
          pageId={pageId}
          setPageId={setPageId}
          render={render}
        />
      ) : opened.error ? (
        <div role="alert">
          {openedCode === 'CS_NOT_FOUND'
            ? t(
                'content_studio_design_revision_missing',
                'This design revision is no longer available.'
              )
            : openedCode === 'CS_DESIGN_INTEGRITY_ERROR'
            ? t(
                'content_studio_design_error_integrity',
                'Stored design data could not be read safely.'
              )
            : t(
                'content_studio_design_revision_load_error',
                'Design revision could not be loaded.'
              )}
        </div>
      ) : !opened.data ? (
        <LoadingComponent width={40} height={40} />
      ) : !openedDocument || opened.data.id !== shown.id ? (
        <div role="alert">
          {t(
            'content_studio_design_error_integrity',
            'Stored design data could not be read safely.'
          )}
        </div>
      ) : (
        <DesignRevisionView
          key={shown.id}
          revision={shown}
          document={openedDocument}
          pageId={pageId}
          setPageId={setPageId}
          render={render}
        />
      )}

      <section className="flex flex-col gap-[12px] min-w-0">
        <h2 className="text-[16px] font-[600]">
          {t('content_studio_design_history', 'Revision history')}
        </h2>
        <DesignHistory
          history={history}
          latestRevisionNumber={design.latestRevisionNumber}
          shownId={shown.id}
          page={historyPage}
          setPage={setHistoryPage}
          onView={(revision) =>
            setViewing(
              revision.id === currentRevision.id
                ? null
                : { id: revision.id, revisionNumber: revision.revisionNumber }
            )
          }
        />
      </section>
    </div>
  );
};
