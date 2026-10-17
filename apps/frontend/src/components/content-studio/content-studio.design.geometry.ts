import {
  ContentStudioDesignPage,
  DESIGN_COORDINATE_MAX,
  DESIGN_ROTATION_MAX,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';

// The geometry of direct canvas editing, as pure functions: no React, Fabric,
// API or DOM. A Design Document layer box is x/y (its unrotated top left),
// width/height and a rotation in degrees around its center; the canvas
// interaction object of a layer is the same box held by its center. What a
// gesture changes comes back as a layer box for the editor operations, and
// only the five box fields ever reach the document. Zoom and pan are screen
// pixels of the editor view and never touch a document

// snapping is felt the same at every zoom: this many screen pixels
export const DESIGN_CANVAS_SNAP_PX = 6;
export const DESIGN_CANVAS_ZOOM_MIN = 0.25;
export const DESIGN_CANVAS_ZOOM_MAX = 2;
export const DESIGN_CANVAS_ZOOM_STEP = 0.25;
// the room kept around the page when it is fitted
export const DESIGN_CANVAS_FIT_PADDING = 24;

export interface ContentStudioDesignCanvasBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

// A canvas interaction object: centered, unscaled, at the layer's angle
export interface ContentStudioDesignCanvasObject {
  left: number;
  top: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  angle: number;
}

// What a transformed interaction object reports back. Any of it may be
// missing or not a number: nothing is trusted before it is checked
export interface ContentStudioDesignCanvasTransform {
  left?: unknown;
  top?: unknown;
  width?: unknown;
  height?: unknown;
  scaleX?: unknown;
  scaleY?: unknown;
  angle?: unknown;
  flipX?: unknown;
  flipY?: unknown;
  skewX?: unknown;
  skewY?: unknown;
}

export interface ContentStudioDesignCanvasView {
  zoom: number;
  panX: number;
  panY: number;
}

export interface ContentStudioDesignCanvasSize {
  width: number;
  height: number;
}

// -0 is stored as 0
const plain = (value: number) => (value === 0 ? 0 : value);

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const contentStudioDesignCanvasObject = (
  box: ContentStudioDesignCanvasBox
): ContentStudioDesignCanvasObject => ({
  left: box.x + box.width / 2,
  top: box.y + box.height / 2,
  width: box.width,
  height: box.height,
  scaleX: 1,
  scaleY: 1,
  // exactly as stored: 270 stays 270 until the layer is rotated here
  angle: box.rotation,
});

// An angle a rotation gesture left, as one in (-180, 180]
export const normalizeContentStudioDesignCanvasAngle = (angle: number) => {
  let value = angle % 360;
  if (value > 180) {
    value -= 360;
  } else if (value <= -180) {
    value += 360;
  }
  return plain(value);
};

// The layer box a transformed interaction object stands for: its scaled
// width and height and the top left of that box around the object's center.
// A field the gesture left as it was keeps the stored value exactly (no
// floating point noise), an angle the gesture changed is normalized, and the
// numbers are otherwise kept as they are: nothing is rounded. Null when the
// object is not a plain box (a flip or skew, or a value that is not a
// finite number)
export const contentStudioDesignCanvasBox = (
  transform: ContentStudioDesignCanvasTransform,
  current: ContentStudioDesignCanvasBox
): ContentStudioDesignCanvasBox | null => {
  const { left, top, width, height, scaleX, scaleY, angle } = transform;
  if (
    transform.flipX ||
    transform.flipY ||
    transform.skewX ||
    transform.skewY ||
    !finite(left) ||
    !finite(top) ||
    !finite(width) ||
    !finite(height) ||
    !finite(scaleX) ||
    !finite(scaleY) ||
    !finite(angle)
  ) {
    return null;
  }
  const at = contentStudioDesignCanvasObject(current);
  const nextWidth = width * Math.abs(scaleX);
  const nextHeight = height * Math.abs(scaleY);
  const keepX = left === at.left && nextWidth === current.width;
  const keepY = top === at.top && nextHeight === current.height;
  const box = {
    x: keepX ? current.x : left - nextWidth / 2,
    y: keepY ? current.y : top - nextHeight / 2,
    width: nextWidth === current.width ? current.width : nextWidth,
    height: nextHeight === current.height ? current.height : nextHeight,
    rotation:
      angle === current.rotation
        ? current.rotation
        : normalizeContentStudioDesignCanvasAngle(angle),
  };
  return Object.values(box).every(finite)
    ? {
        x: plain(box.x),
        y: plain(box.y),
        width: plain(box.width),
        height: plain(box.height),
        rotation: plain(box.rotation),
      }
    : null;
};

// The Design Document v1 limits of a layer box, as its parser has them
export const isContentStudioDesignCanvasBoxValid = (
  box: ContentStudioDesignCanvasBox
) =>
  [box.x, box.y, box.width, box.height, box.rotation].every(finite) &&
  Math.abs(box.x) <= DESIGN_COORDINATE_MAX &&
  Math.abs(box.y) <= DESIGN_COORDINATE_MAX &&
  box.width > 0 &&
  box.width <= DESIGN_COORDINATE_MAX &&
  box.height > 0 &&
  box.height <= DESIGN_COORDINATE_MAX &&
  Math.abs(box.rotation) <= DESIGN_ROTATION_MAX;

export const sameContentStudioDesignCanvasBox = (
  a: ContentStudioDesignCanvasBox,
  b: ContentStudioDesignCanvasBox
) =>
  a.x === b.x &&
  a.y === b.y &&
  a.width === b.width &&
  a.height === b.height &&
  a.rotation === b.rotation;

// ---------------------------------------------------------------------------
// Snapping while a layer is moved
// ---------------------------------------------------------------------------

export interface ContentStudioDesignCanvasSnapTargets {
  x: number[];
  y: number[];
}

// What a moved layer snaps to, in a fixed order: the page's edges and
// center first, then every other visible layer of the page in the design's
// layer order, each as its left, center and right (top, center, bottom).
// Boxes are the stored unrotated boxes, wherever they are, on the page or
// not; hidden layers and the moved layer itself are left out
export const contentStudioDesignCanvasSnapTargets = (
  page: ContentStudioDesignPage,
  layerId: string
): ContentStudioDesignCanvasSnapTargets => {
  const x = [0, page.width / 2, page.width];
  const y = [0, page.height / 2, page.height];
  for (const layer of page.layers) {
    if (layer.visible && layer.id !== layerId) {
      x.push(layer.x, layer.x + layer.width / 2, layer.x + layer.width);
      y.push(layer.y, layer.y + layer.height / 2, layer.y + layer.height);
    }
  }
  return { x, y };
};

export const contentStudioDesignCanvasSnapThreshold = (zoom: number) =>
  DESIGN_CANVAS_SNAP_PX / zoom;

// The closest target within the threshold for any of start, middle and
// end of the box on one axis; on a tie the earlier target wins
const snapAxis = (
  start: number,
  size: number,
  targets: number[],
  max: number
) => {
  let best: { offset: number; guide: number } | null = null;
  for (const target of targets) {
    for (const anchor of [start, start + size / 2, start + size]) {
      const offset = target - anchor;
      if (
        Math.abs(offset) <= max &&
        (!best || Math.abs(offset) < Math.abs(best.offset))
      ) {
        best = { offset, guide: target };
      }
    }
  }
  return best;
};

// Where a moved box lands: each axis snaps on its own, the size and
// rotation stay. A guide is given for an axis that snapped only
export const snapContentStudioDesignCanvasMove = (
  box: { x: number; y: number; width: number; height: number },
  targets: ContentStudioDesignCanvasSnapTargets,
  threshold: number
) => {
  const x = snapAxis(box.x, box.width, targets.x, threshold);
  const y = snapAxis(box.y, box.height, targets.y, threshold);
  return {
    x: x ? box.x + x.offset : box.x,
    y: y ? box.y + y.offset : box.y,
    verticalGuide: x ? x.guide : null,
    horizontalGuide: y ? y.guide : null,
  };
};

// ---------------------------------------------------------------------------
// Zoom and pan of the editor view
// ---------------------------------------------------------------------------

// The whole page in the view, centered, never above 100%; for a large page
// in a small view below the 25% the zoom buttons stop at
export const fitContentStudioDesignCanvasView = (
  page: ContentStudioDesignCanvasSize,
  viewport: ContentStudioDesignCanvasSize
): ContentStudioDesignCanvasView => {
  const room = (size: number) =>
    Math.max(size - 2 * DESIGN_CANVAS_FIT_PADDING, 1);
  const zoom = Math.min(
    1,
    room(viewport.width) / page.width,
    room(viewport.height) / page.height
  );
  return {
    zoom,
    panX: (viewport.width - page.width * zoom) / 2,
    panY: (viewport.height - page.height * zoom) / 2,
  };
};

export const clampContentStudioDesignCanvasZoom = (zoom: number) =>
  Math.min(DESIGN_CANVAS_ZOOM_MAX, Math.max(DESIGN_CANVAS_ZOOM_MIN, zoom));

// The next 25% step in or out, within 25% to 200%
export const stepContentStudioDesignCanvasZoom = (
  zoom: number,
  direction: 1 | -1
) => {
  const steps = zoom / DESIGN_CANVAS_ZOOM_STEP;
  const next =
    direction > 0 ? Math.floor(steps + 1e-9) + 1 : Math.ceil(steps - 1e-9) - 1;
  return clampContentStudioDesignCanvasZoom(next * DESIGN_CANVAS_ZOOM_STEP);
};

// A new zoom around the middle of the view: the design point there stays
export const zoomContentStudioDesignCanvasView = (
  view: ContentStudioDesignCanvasView,
  zoom: number,
  viewport: ContentStudioDesignCanvasSize
): ContentStudioDesignCanvasView => {
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  return {
    zoom,
    panX: centerX - ((centerX - view.panX) / view.zoom) * zoom,
    panY: centerY - ((centerY - view.panY) / view.zoom) * zoom,
  };
};

export const panContentStudioDesignCanvasView = (
  view: ContentStudioDesignCanvasView,
  dx: number,
  dy: number
): ContentStudioDesignCanvasView => ({
  ...view,
  panX: view.panX + dx,
  panY: view.panY + dy,
});

// Where a design point is in the view, in screen pixels
export const contentStudioDesignCanvasScreenPoint = (
  view: ContentStudioDesignCanvasView,
  point: { x: number; y: number }
) => ({
  x: view.panX + point.x * view.zoom,
  y: view.panY + point.y * view.zoom,
});
