import { Canvas, Ellipse, FabricObject, Rect } from 'fabric';
import type {
  ContentStudioDesignCanvasObject,
  ContentStudioDesignCanvasSize,
  ContentStudioDesignCanvasTransform,
  ContentStudioDesignCanvasView,
} from '@gitroom/frontend/components/content-studio/content-studio.design.geometry';

// The Fabric side of direct canvas editing, loaded in the browser only while
// a design is edited. Fabric draws nothing of the design: every visible layer
// of the page is one transparent hitbox (an ellipse for an ellipse, a box
// otherwise) with the layer's box and nothing else of it, no text, name,
// color, font or image. Hitboxes exist to be selected, moved, resized and
// rotated; what a gesture did goes back to the editor as a box and the next
// sync puts every hitbox back where the draft says. Which layer a hitbox
// stands for is kept here in memory, never on the object, and nothing of the
// canvas is ever serialized

export type ContentStudioDesignFabricKind = 'box' | 'ellipse';

export interface ContentStudioDesignFabricHitbox {
  id: string;
  kind: ContentStudioDesignFabricKind;
  object: ContentStudioDesignCanvasObject;
}

export interface ContentStudioDesignFabricEvents {
  // a layer chosen on the canvas, or none
  onSelect: (id: string | null) => void;
  // a gesture on a layer started
  onTransformStart: () => void;
  // the layer is being moved: where its center is to be instead, or null
  onMoving: (
    id: string,
    center: { left: number; top: number; width: number; height: number },
    freely: boolean
  ) => { left: number; top: number } | null;
  // the gesture ended with the layer changed
  onModified: (
    id: string,
    transform: ContentStudioDesignCanvasTransform
  ) => void;
  // the pointer was released
  onTransformEnd: () => void;
  // something went wrong inside a canvas event
  onError: () => void;
}

export interface ContentStudioDesignFabricController {
  sync: (
    hitboxes: ContentStudioDesignFabricHitbox[],
    selectedId: string | null,
    interactive: boolean
  ) => void;
  setView: (
    view: ContentStudioDesignCanvasView,
    size: ContentStudioDesignCanvasSize
  ) => void;
  dispose: () => void;
}

// A hitbox is drawn at no visible strength: a box needs no fill to be hit,
// an ellipse is hit by its pixels, so its fill is just above transparent
const BOX_FILL = 'transparent';
const ELLIPSE_FILL = 'rgba(0,0,0,0.01)';

// the selection frame takes the theme's primary button color when there is
// one; Fabric's own frame otherwise
const accent = (host: HTMLElement) => {
  const value = host.ownerDocument.defaultView
    ?.getComputedStyle(host)
    .getPropertyValue('--new-btn-primary')
    .trim();
  return value ? { borderColor: value, cornerColor: value } : {};
};

const placement = (hitbox: ContentStudioDesignFabricHitbox) => ({
  left: hitbox.object.left,
  top: hitbox.object.top,
  angle: hitbox.object.angle,
  scaleX: 1,
  scaleY: 1,
  ...(hitbox.kind === 'ellipse'
    ? { rx: hitbox.object.width / 2, ry: hitbox.object.height / 2 }
    : { width: hitbox.object.width, height: hitbox.object.height }),
});

export const createContentStudioDesignFabric = (
  host: HTMLElement,
  events: ContentStudioDesignFabricEvents
): ContentStudioDesignFabricController => {
  const element = host.ownerDocument.createElement('canvas');
  host.appendChild(element);
  const canvas = new Canvas(element, {
    // one layer at a time: no drag rectangle, no Shift click groups
    selection: false,
    // the stacking is the design's, also for the selected layer
    preserveObjectStacking: true,
    // width and height are free; Shift keeps the proportions
    uniformScaling: false,
    renderOnAddRemove: false,
    stopContextMenu: true,
  });
  const style = accent(host);
  const ids = new WeakMap<FabricObject, string>();
  const objects = new Map<string, FabricObject>();
  const kinds = new Map<string, ContentStudioDesignFabricKind>();
  // set while the draft is put on the canvas: selection events of a sync
  // are not choices
  let syncing = false;
  let transforming = false;

  const guarded = (run: () => void) => {
    try {
      run();
    } catch {
      events.onError();
    }
  };

  const create = (hitbox: ContentStudioDesignFabricHitbox) => {
    const options = {
      ...placement(hitbox),
      originX: 'center' as const,
      originY: 'center' as const,
      strokeWidth: 0,
      padding: 0,
      objectCaching: false,
      centeredRotation: true,
      lockScalingFlip: true,
      lockSkewingX: true,
      lockSkewingY: true,
      transparentCorners: false,
      ...style,
    };
    const object =
      hitbox.kind === 'ellipse'
        ? new Ellipse({
            ...options,
            fill: ELLIPSE_FILL,
            perPixelTargetFind: true,
          })
        : new Rect({ ...options, fill: BOX_FILL });
    ids.set(object, hitbox.id);
    return object;
  };

  const choose = (selected: FabricObject[] | undefined) => {
    if (syncing) {
      return;
    }
    const id = selected?.length === 1 ? ids.get(selected[0]) : undefined;
    if (!id) {
      // never a group of layers
      syncing = true;
      try {
        canvas.discardActiveObject();
      } finally {
        syncing = false;
      }
      events.onSelect(null);
      return;
    }
    events.onSelect(id);
  };

  const begin = () => {
    if (!transforming) {
      transforming = true;
      events.onTransformStart();
    }
  };

  canvas.on('selection:created', (event) =>
    guarded(() => choose(event.selected))
  );
  canvas.on('selection:updated', (event) =>
    guarded(() => choose(event.selected))
  );
  canvas.on('selection:cleared', () =>
    guarded(() => {
      if (!syncing) {
        events.onSelect(null);
      }
    })
  );
  canvas.on('object:moving', (event) =>
    guarded(() => {
      begin();
      const id = ids.get(event.target);
      if (!id) {
        return;
      }
      const target = event.target;
      const center = events.onMoving(
        id,
        {
          left: target.left,
          top: target.top,
          width: target.width * Math.abs(target.scaleX),
          height: target.height * Math.abs(target.scaleY),
        },
        !!event.e?.altKey
      );
      if (center) {
        target.set({ left: center.left, top: center.top });
        target.setCoords();
      }
    })
  );
  canvas.on('object:scaling', () => guarded(begin));
  canvas.on('object:rotating', () => guarded(begin));
  canvas.on('object:modified', (event) =>
    guarded(() => {
      const id = ids.get(event.target);
      if (!id) {
        return;
      }
      const target = event.target;
      // the raw box and center: never the rotated bounding rectangle
      events.onModified(id, {
        left: target.left,
        top: target.top,
        width: target.width,
        height: target.height,
        scaleX: target.scaleX,
        scaleY: target.scaleY,
        angle: target.angle,
        flipX: target.flipX,
        flipY: target.flipY,
        skewX: target.skewX,
        skewY: target.skewY,
      });
    })
  );
  canvas.on('mouse:up', () =>
    guarded(() => {
      const ended = transforming;
      transforming = false;
      if (ended) {
        events.onTransformEnd();
      }
    })
  );

  const sync: ContentStudioDesignFabricController['sync'] = (
    hitboxes,
    selectedId,
    interactive
  ) => {
    syncing = true;
    try {
      const wanted = new Set(hitboxes.map((hitbox) => hitbox.id));
      for (const [id, object] of Array.from(objects.entries())) {
        if (!wanted.has(id)) {
          canvas.remove(object);
          objects.delete(id);
          kinds.delete(id);
        }
      }
      hitboxes.forEach((hitbox, index) => {
        let object = objects.get(hitbox.id);
        if (object && kinds.get(hitbox.id) !== hitbox.kind) {
          canvas.remove(object);
          object = undefined;
        }
        if (!object) {
          object = create(hitbox);
          objects.set(hitbox.id, object);
          kinds.set(hitbox.id, hitbox.kind);
          canvas.add(object);
        } else {
          object.set(placement(hitbox));
          object.setCoords();
        }
        // the first layer at the back, the last in front
        if (canvas.getObjects().indexOf(object) !== index) {
          canvas.moveObjectTo(object, index);
        }
      });
      const selected = selectedId ? objects.get(selectedId) : undefined;
      if (selected) {
        if (canvas.getActiveObject() !== selected) {
          canvas.setActiveObject(selected);
        }
      } else if (canvas.getActiveObject()) {
        canvas.discardActiveObject();
      }
      canvas.skipTargetFind = !interactive;
    } finally {
      syncing = false;
    }
    canvas.requestRenderAll();
  };

  return {
    sync: (hitboxes, selectedId, interactive) => {
      try {
        sync(hitboxes, selectedId, interactive);
      } catch {
        events.onError();
      }
    },
    setView: (view, size) => {
      canvas.setDimensions({ width: size.width, height: size.height });
      canvas.setViewportTransform([
        view.zoom,
        0,
        0,
        view.zoom,
        view.panX,
        view.panY,
      ]);
      canvas.requestRenderAll();
    },
    dispose: () => {
      objects.clear();
      kinds.clear();
      canvas.dispose().catch(() => undefined);
      element.remove();
    },
  };
};
