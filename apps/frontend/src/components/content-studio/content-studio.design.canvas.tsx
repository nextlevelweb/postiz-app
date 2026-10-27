'use client';

import {
  FC,
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import type { ContentStudioBrandKitContentV1 } from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import type { ContentStudioDesignPage } from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  ContentStudioDesignPreviewPage,
  DesignLivePreviewHeader,
} from '@gitroom/frontend/components/content-studio/content-studio.design.preview';
import { isDesignEditorShortcutTarget } from '@gitroom/frontend/components/content-studio/content-studio.design.editing';
import {
  ContentStudioDesignCanvasBox,
  ContentStudioDesignCanvasSize,
  ContentStudioDesignCanvasTransform,
  ContentStudioDesignCanvasView,
  DESIGN_CANVAS_ZOOM_MAX,
  DESIGN_CANVAS_ZOOM_MIN,
  contentStudioDesignCanvasBox,
  contentStudioDesignCanvasObject,
  contentStudioDesignCanvasScreenPoint,
  contentStudioDesignCanvasSnapTargets,
  contentStudioDesignCanvasSnapThreshold,
  fitContentStudioDesignCanvasView,
  isContentStudioDesignCanvasBoxValid,
  panContentStudioDesignCanvasView,
  sameContentStudioDesignCanvasBox,
  snapContentStudioDesignCanvasMove,
  stepContentStudioDesignCanvasZoom,
  zoomContentStudioDesignCanvasView,
} from '@gitroom/frontend/components/content-studio/content-studio.design.geometry';
import type {
  ContentStudioDesignFabricController,
  ContentStudioDesignFabricHitbox,
} from '@gitroom/frontend/components/content-studio/content-studio.design.fabric';

// Direct editing of the selected page while a design is edited: the
// structural preview draws the page as always, and a transparent Fabric
// canvas over it lets a layer be selected, moved, resized and rotated. The
// draft stays the one source: a finished gesture becomes one layer update
// (one undo step) through the editor, and the canvas is then put back where
// the draft says, so Fabric never holds anything of its own. Zoom, pan,
// snapping guides and the gesture in progress live in this component only;
// none of it reaches the document

// used where the view cannot be measured
const VIEW_DEFAULT: ContentStudioDesignCanvasSize = { width: 640, height: 640 };

const hitboxes = (
  page: ContentStudioDesignPage
): ContentStudioDesignFabricHitbox[] =>
  page.layers
    .filter((layer) => layer.visible)
    .map((layer) => ({
      id: layer.id,
      kind:
        layer.type === 'shape' && layer.shape === 'ellipse' ? 'ellipse' : 'box',
      object: contentStudioDesignCanvasObject(layer),
    }));

const useViewSize = () => {
  const viewport = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<ContentStudioDesignCanvasSize | null>(null);
  useEffect(() => {
    const element = viewport.current;
    if (!element) {
      return;
    }
    const measure = () =>
      setSize((current) =>
        current?.width === element.clientWidth &&
        current?.height === element.clientHeight
          ? current
          : { width: element.clientWidth, height: element.clientHeight }
      );
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return {
    viewport,
    size: size && size.width > 0 && size.height > 0 ? size : VIEW_DEFAULT,
  };
};

// Space is the pan key unless a field, button or link has the keyboard
const isPanKeyTarget = (target: EventTarget | null, view: HTMLElement | null) =>
  !(target instanceof HTMLElement) ||
  target === target.ownerDocument.body ||
  !!view?.contains(target);

interface Guides {
  vertical: number | null;
  horizontal: number | null;
}
const NO_GUIDES: Guides = { vertical: null, horizontal: null };

export const ContentStudioDesignCanvas: FC<{
  page: ContentStudioDesignPage;
  pageLabel: string;
  brand: ContentStudioBrandKitContentV1 | null;
  selectedLayerId: string | null;
  interactive: boolean;
  onSelectLayer: (id: string | null) => void;
  onLayerGeometryCommit: (
    layerId: string,
    box: ContentStudioDesignCanvasBox
  ) => void;
  onTransformingChange: (active: boolean) => void;
  // snapping while moving, and whether its guide lines show
  snapEnabled: boolean;
  guidesEnabled: boolean;
}> = ({
  page,
  pageLabel,
  brand,
  selectedLayerId,
  interactive,
  onSelectLayer,
  onLayerGeometryCommit,
  onTransformingChange,
  snapEnabled,
  guidesEnabled,
}) => {
  const t = useT();
  const toaster = useToaster();
  const { viewport, size } = useViewSize();
  const host = useRef<HTMLDivElement | null>(null);
  const [controller, setController] =
    useState<ContentStudioDesignFabricController | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [view, setView] = useState<ContentStudioDesignCanvasView>(() =>
    fitContentStudioDesignCanvasView(page, VIEW_DEFAULT)
  );
  // Fit follows the view's size until the user zooms or pans
  const [fitted, setFitted] = useState(true);
  const [guides, setGuides] = useState<Guides>(NO_GUIDES);
  const [panKey, setPanKey] = useState(false);
  const [panning, setPanning] = useState(false);
  const pan = useRef<{ x: number; y: number } | null>(null);

  // what the canvas events read: always the latest render's values
  const props = {
    page,
    selectedLayerId,
    interactive,
    view,
    onSelectLayer,
    onLayerGeometryCommit,
    onTransformingChange,
    snapEnabled,
    guidesEnabled,
    size,
    t,
    toaster,
  };
  const latest = useRef(props);
  latest.current = props;
  const controllerRef = useRef<ContentStudioDesignFabricController | null>(
    null
  );

  // the canvas as the latest draft has it
  const resync = useCallback(() => {
    const current = latest.current;
    const visible = current.page.layers.find(
      (layer) => layer.id === current.selectedLayerId && layer.visible
    );
    controllerRef.current?.sync(
      hitboxes(current.page),
      visible ? visible.id : null,
      current.interactive
    );
  }, []);

  // One Fabric canvas for the whole edit, loaded with the edit and gone
  // with it
  useEffect(() => {
    const element = host.current;
    if (!element) {
      return;
    }
    let cancelled = false;
    let created: ContentStudioDesignFabricController | null = null;
    // a gesture whose change was handled: the canvas is put back after it
    let changed = false;
    // putting the canvas back after an error: one attempt, never a loop
    let recovering = false;
    import(
      '@gitroom/frontend/components/content-studio/content-studio.design.fabric'
    )
      .then(({ createContentStudioDesignFabric }) => {
        if (cancelled) {
          return;
        }
        created = createContentStudioDesignFabric(element, {
          onSelect: (id) => {
            setGuides(NO_GUIDES);
            latest.current.onSelectLayer(id);
          },
          onTransformStart: () => latest.current.onTransformingChange(true),
          onMoving: (id, center, freely) => {
            const current = latest.current;
            // Alt moves freely; so does every move with snapping off
            if (freely || !current.snapEnabled) {
              setGuides(NO_GUIDES);
              return null;
            }
            const snapped = snapContentStudioDesignCanvasMove(
              {
                x: center.left - center.width / 2,
                y: center.top - center.height / 2,
                width: center.width,
                height: center.height,
              },
              contentStudioDesignCanvasSnapTargets(current.page, id),
              contentStudioDesignCanvasSnapThreshold(current.view.zoom)
            );
            setGuides(
              current.guidesEnabled
                ? {
                    vertical: snapped.verticalGuide,
                    horizontal: snapped.horizontalGuide,
                  }
                : NO_GUIDES
            );
            return {
              left: snapped.x + center.width / 2,
              top: snapped.y + center.height / 2,
            };
          },
          onModified: (id, transform: ContentStudioDesignCanvasTransform) => {
            changed = true;
            setGuides(NO_GUIDES);
            const layer = latest.current.page.layers.find(
              (entry) => entry.id === id
            );
            if (!layer) {
              return;
            }
            const box = contentStudioDesignCanvasBox(transform, layer);
            if (!box || !isContentStudioDesignCanvasBoxValid(box)) {
              latest.current.toaster.show(
                latest.current.t(
                  'content_studio_design_canvas_out_of_limits',
                  'That transformation is outside the design limits.'
                ),
                'warning'
              );
              return;
            }
            if (!sameContentStudioDesignCanvasBox(box, layer)) {
              latest.current.onLayerGeometryCommit(id, box);
            }
          },
          onTransformEnd: () => {
            setGuides(NO_GUIDES);
            latest.current.onTransformingChange(false);
            if (changed) {
              changed = false;
              // after Fabric has finished the gesture
              queueMicrotask(resync);
            }
          },
          // never the error itself: the canvas is put back from the draft
          onError: () => {
            latest.current.toaster.show(
              latest.current.t(
                'content_studio_design_canvas_update_failed',
                'The layer could not be updated.'
              ),
              'warning'
            );
            if (!recovering) {
              recovering = true;
              queueMicrotask(() => {
                resync();
                recovering = false;
              });
            }
          },
        });
        controllerRef.current = created;
        setController(created);
      })
      .catch(() => {
        if (!cancelled) {
          setUnavailable(true);
        }
      });
    return () => {
      cancelled = true;
      controllerRef.current = null;
      created?.dispose();
      latest.current.onTransformingChange(false);
    };
  }, [resync]);

  // the draft, the selection and the editing state on the canvas
  useEffect(() => {
    resync();
  }, [controller, page, selectedLayerId, interactive, resync]);

  // a page is opened fitted, with no guides
  useEffect(() => {
    setFitted(true);
    setGuides(NO_GUIDES);
  }, [page.id]);
  const { width: pageWidth, height: pageHeight } = page;
  useEffect(() => {
    if (fitted) {
      setView(
        fitContentStudioDesignCanvasView(
          { width: pageWidth, height: pageHeight },
          size
        )
      );
    }
  }, [fitted, pageWidth, pageHeight, size]);

  useEffect(() => {
    controller?.setView(view, size);
  }, [controller, view, size]);

  // Space held: the pointer pans the view instead of editing a layer
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === 'Space' || event.key === ' ') {
        if (isPanKeyTarget(event.target, viewport.current)) {
          event.preventDefault();
          setPanKey(true);
        }
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space' || event.key === ' ') {
        setPanKey(false);
      }
    };
    const blur = () => setPanKey(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [viewport]);

  // a pan follows the pointer until it is released, anywhere
  useEffect(() => {
    if (!panning) {
      return;
    }
    const move = (event: MouseEvent) => {
      const from = pan.current;
      if (!from) {
        return;
      }
      pan.current = { x: event.clientX, y: event.clientY };
      setView((current) =>
        panContentStudioDesignCanvasView(
          current,
          event.clientX - from.x,
          event.clientY - from.y
        )
      );
    };
    const up = () => {
      pan.current = null;
      setPanning(false);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [panning]);

  // Space with the primary button, or the middle button: before the canvas
  // sees the press, so no layer is moved by it
  const startPan = (event: ReactMouseEvent) => {
    if (!(event.button === 1 || (event.button === 0 && panKey))) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    pan.current = { x: event.clientX, y: event.clientY };
    setFitted(false);
    setGuides(NO_GUIDES);
    setPanning(true);
  };

  const zoomTo = (zoom: number) => {
    setFitted(false);
    setView((current) =>
      zoomContentStudioDesignCanvasView(current, zoom, size)
    );
  };
  const fit = () => {
    setFitted(true);
    setView(fitContentStudioDesignCanvasView(page, size));
  };

  // Ctrl/Cmd with 0, + or -: Fit and zoom, only for a key pressed in the
  // editor (never in a field, a dialog or elsewhere in the app); the
  // browser's own zoom stays everywhere else
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = latest.current;
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        !current.interactive ||
        !isDesignEditorShortcutTarget(event.target)
      ) {
        return;
      }
      const step =
        event.key === '+' || event.key === '='
          ? 1
          : event.key === '-' || event.key === '_'
          ? -1
          : 0;
      if (event.key === '0') {
        event.preventDefault();
        setFitted(true);
        setView(fitContentStudioDesignCanvasView(current.page, current.size));
      } else if (step) {
        event.preventDefault();
        setFitted(false);
        setView((view) =>
          zoomContentStudioDesignCanvasView(
            view,
            stepContentStudioDesignCanvasZoom(view.zoom, step),
            current.size
          )
        );
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const vertical =
    guides.vertical === null
      ? null
      : contentStudioDesignCanvasScreenPoint(view, { x: guides.vertical, y: 0 })
          .x;
  const horizontal =
    guides.horizontal === null
      ? null
      : contentStudioDesignCanvasScreenPoint(view, {
          x: 0,
          y: guides.horizontal,
        }).y;

  return (
    <div className="flex flex-col gap-[8px] min-w-0">
      <DesignLivePreviewHeader />
      <div
        role="toolbar"
        aria-label={t('content_studio_design_canvas_view', 'Canvas view')}
        className="flex flex-wrap items-center gap-[8px]"
      >
        <Button
          secondary
          disabled={view.zoom <= DESIGN_CANVAS_ZOOM_MIN}
          onClick={() =>
            zoomTo(stepContentStudioDesignCanvasZoom(view.zoom, -1))
          }
        >
          {t('content_studio_design_zoom_out', 'Zoom out')}
        </Button>
        <span
          aria-label={t('content_studio_design_zoom', 'Zoom')}
          className="text-[13px] min-w-[48px] text-center"
        >
          {Math.round(view.zoom * 100)}%
        </span>
        <Button
          secondary
          disabled={view.zoom >= DESIGN_CANVAS_ZOOM_MAX}
          onClick={() =>
            zoomTo(stepContentStudioDesignCanvasZoom(view.zoom, 1))
          }
        >
          {t('content_studio_design_zoom_in', 'Zoom in')}
        </Button>
        <Button secondary aria-pressed={fitted} onClick={fit}>
          {t('content_studio_design_zoom_fit', 'Fit')}
        </Button>
      </div>
      <div
        ref={viewport}
        data-canvas="viewport"
        role="region"
        aria-label={`${t(
          'content_studio_design_canvas_region',
          'Design canvas'
        )} ${pageLabel}`}
        className="relative overflow-hidden border border-newTableBorder bg-newBgColor w-full h-[640px] min-w-0"
        onMouseDownCapture={startPan}
      >
        <ContentStudioDesignPreviewPage
          page={page}
          brand={brand}
          placement={{
            transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`,
            pointerEvents: 'none',
          }}
        />
        <div
          ref={host}
          data-canvas="interaction"
          className="absolute inset-0"
        />
        {guidesEnabled && vertical !== null && (
          <div
            data-guide="vertical"
            aria-hidden="true"
            className="absolute top-0 bottom-0 w-px bg-forth pointer-events-none"
            style={{ left: vertical }}
          />
        )}
        {guidesEnabled && horizontal !== null && (
          <div
            data-guide="horizontal"
            aria-hidden="true"
            className="absolute left-0 right-0 h-px bg-forth pointer-events-none"
            style={{ top: horizontal }}
          />
        )}
        {/* the editor loads on first use: say so until it is there */}
        {!controller && !unavailable && (
          <div
            role="status"
            data-canvas="preparing"
            className="absolute top-[12px] start-[12px] flex items-center gap-[8px] px-[12px] py-[6px] rounded-full bg-newBgColorInner border border-newTableBorder text-[13px] pointer-events-none"
          >
            <span
              aria-hidden="true"
              className="w-[12px] h-[12px] rounded-full border-2 border-current border-t-transparent animate-spin"
            />
            {t('content_studio_design_canvas_preparing', 'Preparing canvas…')}
          </div>
        )}
        {(panKey || panning) && (
          <div
            data-canvas="pan"
            className={clsx(
              'absolute inset-0',
              panning ? 'cursor-grabbing' : 'cursor-grab'
            )}
          />
        )}
      </div>
      <div className="text-[12px] text-textItemBlur">
        {unavailable
          ? t(
              'content_studio_design_canvas_unavailable',
              'Direct canvas editing is unavailable. Use the inspector to edit layers.'
            )
          : t(
              'content_studio_design_canvas_hint',
              'Drag a layer to move it; use its handles to resize or rotate it. Hold Alt to move without snapping. Hold Space and drag, or drag with the middle mouse button, to pan.'
            )}
      </div>
    </div>
  );
};
