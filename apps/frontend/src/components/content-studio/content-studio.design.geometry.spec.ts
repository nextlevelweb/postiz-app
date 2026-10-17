import { TextEncoder as NodeTextEncoder } from 'util';
import {
  ContentStudioDesignPage,
  parseContentStudioDesignDocument,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document';
import {
  clampContentStudioDesignCanvasZoom,
  contentStudioDesignCanvasBox,
  contentStudioDesignCanvasObject,
  contentStudioDesignCanvasScreenPoint,
  contentStudioDesignCanvasSnapTargets,
  contentStudioDesignCanvasSnapThreshold,
  fitContentStudioDesignCanvasView,
  isContentStudioDesignCanvasBoxValid,
  normalizeContentStudioDesignCanvasAngle,
  panContentStudioDesignCanvasView,
  sameContentStudioDesignCanvasBox,
  snapContentStudioDesignCanvasMove,
  stepContentStudioDesignCanvasZoom,
  zoomContentStudioDesignCanvasView,
} from './content-studio.design.geometry';

// jsdom has no TextEncoder (every browser does): the parser counts UTF-8
// bytes with it
if (typeof (globalThis as any).TextEncoder === 'undefined') {
  (globalThis as any).TextEncoder = NodeTextEncoder;
}

type Plain = Record<string, any>;
const box = (
  x: number,
  y: number,
  width: number,
  height: number,
  rotation = 0
) => ({
  x,
  y,
  width,
  height,
  rotation,
});
// what a gesture left on the interaction object
const moved = (current: ReturnType<typeof box>, change: Plain) => ({
  ...contentStudioDesignCanvasObject(current),
  flipX: false,
  flipY: false,
  skewX: 0,
  skewY: 0,
  ...change,
});
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};
const rect = (id: string, geometry: Plain, extra: Plain = {}) => ({
  id,
  name: '',
  ...geometry,
  rotation: geometry.rotation ?? 0,
  opacity: 1,
  visible: true,
  type: 'shape',
  shape: 'rectangle',
  fill: { type: 'literal', value: '#ff0000' },
  cornerRadius: 0,
  ...extra,
});
const page = (layers: unknown[], width = 1000, height = 600) =>
  ({
    id: 'p_one',
    name: '',
    width,
    height,
    background: { type: 'solid', color: { type: 'literal', value: '#ffffff' } },
    layers,
  } as unknown as ContentStudioDesignPage);
const parsesAsLayer = (geometry: Plain) => {
  try {
    parseContentStudioDesignDocument({
      schemaVersion: 1,
      brandKit: null,
      pages: [page([rect('l_one', geometry)])],
    });
    return true;
  } catch {
    return false;
  }
};

describe('canvas geometry: Design box and interaction object', () => {
  it('CG1/M1 a layer box is held by its center, unscaled, at its stored angle', () => {
    expect(
      contentStudioDesignCanvasObject(box(100, 200, 300, 100, 30))
    ).toEqual({
      left: 250,
      top: 250,
      width: 300,
      height: 100,
      scaleX: 1,
      scaleY: 1,
      angle: 30,
    });
  });

  it('CG2/75 a move of the center moves the unrotated top left; size and rotation stay', () => {
    const current = box(100, 200, 300, 100, 30);
    expect(
      contentStudioDesignCanvasBox(
        moved(current, { left: 270, top: 290 }),
        current
      )
    ).toEqual(box(120, 240, 300, 100, 30));
  });

  it('CG3/CG4/76 a free scale gives the scaled size around the same center, at scale 1 again', () => {
    const current = box(100, 100, 200, 100);
    const next = contentStudioDesignCanvasBox(
      moved(current, { scaleX: 1.5, scaleY: 0.5 }),
      current
    ) as Plain;
    expect(next).toEqual(box(50, 125, 300, 50));
    // the next sync holds it unscaled
    expect(contentStudioDesignCanvasObject(next as any)).toMatchObject({
      left: 200,
      top: 150,
      width: 300,
      height: 50,
      scaleX: 1,
      scaleY: 1,
    });
  });

  it('CG5/CT1/CT2/CT3 a rotation changes the rotation only, exactly', () => {
    const current = box(0.1, 0.3, 0.7, 0.9);
    expect(
      contentStudioDesignCanvasBox(moved(current, { angle: 45 }), current)
    ).toEqual(box(0.1, 0.3, 0.7, 0.9, 45));
    // without the kept fields the round trip would not be exact
    expect(0.1 + 0.7 / 2 - 0.7 / 2).not.toBe(0.1);
  });

  it('CG6/CT4 an angle the gesture left is stored in (-180, 180]', () => {
    const current = box(0, 0, 10, 10);
    expect(
      contentStudioDesignCanvasBox(moved(current, { angle: 350 }), current)
    ).toMatchObject({ rotation: -10 });
    expect(
      contentStudioDesignCanvasBox(moved(current, { angle: 180 }), current)
    ).toMatchObject({ rotation: 180 });
    expect(normalizeContentStudioDesignCanvasAngle(181)).toBe(-179);
    expect(normalizeContentStudioDesignCanvasAngle(-180)).toBe(180);
    expect(normalizeContentStudioDesignCanvasAngle(-190)).toBe(170);
    expect(normalizeContentStudioDesignCanvasAngle(720)).toBe(0);
  });

  it('CG7/CT6/M5 a stored 270 is held as 270, and stays 270 when the layer is only moved', () => {
    const current = box(10, 20, 30, 40, 270);
    expect(contentStudioDesignCanvasObject(current).angle).toBe(270);
    expect(
      contentStudioDesignCanvasBox(moved(current, { left: 100 }), current)
    ).toEqual(box(85, 20, 30, 40, 270));
    expect(
      contentStudioDesignCanvasBox(moved(current, { angle: 300 }), current)
    ).toMatchObject({ rotation: -60 });
  });

  it('CG8/CM6/CR9/M4 fractional values stay as they are: nothing is rounded', () => {
    const current = box(10, 10, 200, 100);
    expect(
      contentStudioDesignCanvasBox(
        moved(current, { left: 110.25, top: 60.125, scaleX: 1.2345 }),
        current
      )
    ).toEqual(box(110.25 - (200 * 1.2345) / 2, 10.125, 200 * 1.2345, 100));
  });

  it('CG9 -0 is stored as 0', () => {
    const current = box(0, 0, 10, 10, 5);
    const turned = contentStudioDesignCanvasBox(
      moved(current, { angle: -0 }),
      current
    ) as Plain;
    expect(Object.is(turned.rotation, 0)).toBe(true);
    const flat = contentStudioDesignCanvasBox(
      moved(current, { width: -0 }),
      current
    ) as Plain;
    expect(Object.is(flat.width, 0)).toBe(true);
    expect(isContentStudioDesignCanvasBoxValid(flat as any)).toBe(false);
  });

  it.each([
    ['NaN left', { left: NaN }],
    ['Infinity width', { width: Infinity }],
    ['-Infinity scale', { scaleY: -Infinity }],
    ['missing height', { height: undefined }],
    ['a string angle', { angle: '45' }],
    ['null top', { top: null }],
  ])('CG10/CG11/74 %s is refused, never NaN', (_, change) => {
    const current = box(0, 0, 10, 10);
    expect(
      contentStudioDesignCanvasBox(moved(current, change), current)
    ).toBeNull();
  });

  it('CR7/M6 a flip or a skew is refused: Design v1 has neither', () => {
    const current = box(0, 0, 10, 10);
    for (const change of [
      { flipX: true },
      { flipY: true },
      { skewX: 5 },
      { skewY: -5 },
    ]) {
      expect(
        contentStudioDesignCanvasBox(moved(current, change), current)
      ).toBeNull();
    }
    // a negative scale is the size of its absolute value (Fabric reports
    // flips separately, and they are refused above)
    expect(
      contentStudioDesignCanvasBox(moved(current, { scaleX: -2 }), current)
    ).toMatchObject({ width: 20 });
  });

  it('CG12/M2 a rotated resize uses the raw scaled size and the center, not the rotated bounds', () => {
    const current = box(100, 100, 200, 100, 45);
    const next = contentStudioDesignCanvasBox(
      moved(current, { scaleX: 1.5 }),
      current
    );
    expect(next).toEqual(box(50, 100, 300, 100, 45));
    // the rotated bounding box would be about 283 wide
    const rad = (45 * Math.PI) / 180;
    expect(300 * Math.cos(rad) + 100 * Math.sin(rad)).toBeGreaterThan(282);
  });

  it('CR8/17 the Design Document v1 box limits are the parser limits', () => {
    const cases: Plain[] = [
      box(0, 0, 1, 1),
      box(-32768, 32768, 32768, 0.0001, -360),
      box(0, 0, 32768.0001, 1),
      box(0, 0, 0, 1),
      box(0, 0, 1, -1),
      box(32768.5, 0, 1, 1),
      box(0, -32769, 1, 1),
      box(0, 0, 1, 1, 360.5),
      box(0, 0, 1, 1, -361),
      box(0.25, 0.5, 0.75, 1.125, 12.5),
    ];
    for (const geometry of cases) {
      expect([
        geometry,
        isContentStudioDesignCanvasBoxValid(geometry as any),
      ]).toEqual([geometry, parsesAsLayer(geometry)]);
    }
    expect(isContentStudioDesignCanvasBoxValid(box(NaN, 0, 1, 1))).toBe(false);
    expect(isContentStudioDesignCanvasBoxValid(box(0, 0, Infinity, 1))).toBe(
      false
    );
  });

  it('73 the same box is no change; any difference is one', () => {
    const current = box(1, 2, 3, 4, 5);
    expect(sameContentStudioDesignCanvasBox(current, { ...current })).toBe(
      true
    );
    for (const key of ['x', 'y', 'width', 'height', 'rotation'] as const) {
      expect(
        sameContentStudioDesignCanvasBox(current, {
          ...current,
          [key]: current[key] + 1e-12,
        })
      ).toBe(false);
    }
    // an untouched object gives exactly the stored box back
    expect(
      contentStudioDesignCanvasBox(
        moved(box(0.1, 0.2, 0.7, 0.3, 270), {}),
        box(0.1, 0.2, 0.7, 0.3, 270)
      )
    ).toEqual(box(0.1, 0.2, 0.7, 0.3, 270));
  });
});

describe('canvas geometry: snapping while moving', () => {
  const OTHER = rect('other', { x: 400, y: 300, width: 100, height: 50 });
  const PAGE = page(
    [rect('moving', { x: 0, y: 0, width: 100, height: 40 }), OTHER],
    1200,
    800
  );
  const targets = contentStudioDesignCanvasSnapTargets(PAGE, 'moving');
  const snap = (
    x: number,
    y: number,
    width = 100,
    height = 40,
    threshold = 6
  ) =>
    snapContentStudioDesignCanvasMove(
      { x, y, width, height },
      targets,
      threshold
    );

  it('SN1 page left', () => {
    expect(snap(4, 200)).toMatchObject({ x: 0, verticalGuide: 0 });
  });
  it('SN2 page center x', () => {
    // center 597 -> 600
    expect(snap(547, 100)).toMatchObject({ x: 550, verticalGuide: 600 });
  });
  it('SN3 page right', () => {
    expect(snap(1095, 100)).toMatchObject({ x: 1100, verticalGuide: 1200 });
  });
  it('SN4 page top', () => {
    expect(snap(700, -5)).toMatchObject({ y: 0, horizontalGuide: 0 });
  });
  it('SN5 page center y', () => {
    // center 397 -> 400
    expect(snap(700, 377)).toMatchObject({ y: 380, horizontalGuide: 400 });
  });
  it('SN6 page bottom', () => {
    expect(snap(700, 763)).toMatchObject({ y: 760, horizontalGuide: 800 });
  });
  it('SN7 other layer left, edge to edge', () => {
    // right edge 397 -> the other layer's left 400
    expect(snap(297, 100)).toMatchObject({ x: 300, verticalGuide: 400 });
  });
  it('SN8 other layer centers', () => {
    // center 452 -> 450, center y 322 -> 325
    expect(snap(422, 307, 60, 30)).toEqual({
      x: 420,
      y: 310,
      verticalGuide: 450,
      horizontalGuide: 325,
    });
  });
  it('SN9 other layer right and bottom', () => {
    expect(snap(443, 312, 60, 40)).toEqual({
      x: 440,
      y: 310,
      verticalGuide: 500,
      horizontalGuide: 350,
    });
  });
  it('SN10 the closest target wins', () => {
    // left 398 is 2 from 400, center 446 is 4 from 450, right 494 is 6 from 500
    expect(snap(398, 100, 96)).toMatchObject({ x: 400, verticalGuide: 400 });
    // left 403 is 3 from 400, center 451 is 1 from 450, right 499 is 1 from 500
    expect(snap(403, 100, 96)).toMatchObject({ x: 402, verticalGuide: 450 });
    // 5, 5 and 5: the earlier target
    expect(snap(395, 100)).toMatchObject({ x: 400, verticalGuide: 400 });
  });
  it('SN11/80/M20 an exact tie goes to the page, then to the earlier layer', () => {
    const tie = page([
      rect('moving', { x: 0, y: 0, width: 10, height: 10 }),
      rect('first', { x: 500, y: 0, width: 10, height: 10 }),
      rect('second', { x: 497, y: 0, width: 10, height: 10 }),
    ]);
    const all = contentStudioDesignCanvasSnapTargets(tie, 'moving');
    // left at 498.5: page center 500 and "first" left 500 are both 1.5 away
    expect(
      snapContentStudioDesignCanvasMove(
        { x: 498.5, y: 100, width: 10, height: 10 },
        all,
        6
      )
    ).toMatchObject({ x: 500, verticalGuide: 500 });
    const layersOnly = page(
      [
        rect('moving', { x: 0, y: 0, width: 10, height: 10 }),
        rect('first', { x: 300, y: 0, width: 10, height: 10 }),
        rect('second', { x: 296, y: 0, width: 10, height: 10 }),
      ],
      2000,
      2000
    );
    // 298 is 2 from "first" (300) and 2 from "second" (296)
    expect(
      snapContentStudioDesignCanvasMove(
        { x: 298, y: 1500, width: 100, height: 3 },
        contentStudioDesignCanvasSnapTargets(layersOnly, 'moving'),
        6
      )
    ).toMatchObject({ x: 300, verticalGuide: 300 });
    expect(
      contentStudioDesignCanvasSnapTargets(layersOnly, 'moving').x
    ).toEqual([0, 1000, 2000, 300, 305, 310, 296, 301, 306]);
  });
  it('SN12 beyond the threshold nothing snaps and there is no guide', () => {
    expect(snap(207, 107)).toEqual({
      x: 207,
      y: 107,
      verticalGuide: null,
      horizontalGuide: null,
    });
  });
  it('SN13/M18 hidden layers are no targets', () => {
    const hidden = page([
      rect('moving', { x: 0, y: 0, width: 10, height: 10 }),
      rect(
        'hidden',
        { x: 333, y: 222, width: 10, height: 10 },
        { visible: false }
      ),
    ]);
    const all = contentStudioDesignCanvasSnapTargets(hidden, 'moving');
    expect(all.x).toEqual([0, 500, 1000]);
    expect(all.y).toEqual([0, 300, 600]);
  });
  it('SN14 the moved layer is no target', () => {
    expect(targets.x).toEqual([0, 600, 1200, 400, 450, 500]);
    expect(targets.y).toEqual([0, 400, 800, 300, 325, 350]);
  });
  it('SN15 a visible layer off the page is a target', () => {
    const off = page([
      rect('moving', { x: 0, y: 0, width: 10, height: 10 }),
      rect('off', { x: 1500, y: -400, width: 100, height: 100 }),
    ]);
    expect(contentStudioDesignCanvasSnapTargets(off, 'moving')).toEqual({
      x: [0, 500, 1000, 1500, 1550, 1600],
      y: [0, 300, 600, -400, -350, -300],
    });
  });
  it('SN16/36/M17 the threshold is 6 screen pixels at every zoom', () => {
    expect(contentStudioDesignCanvasSnapThreshold(1)).toBe(6);
    expect(contentStudioDesignCanvasSnapThreshold(0.25)).toBe(24);
    expect(contentStudioDesignCanvasSnapThreshold(2)).toBe(3);
    // 10 design units from the page left: snaps at 25%, not at 100%
    expect(
      snap(10, 200, 100, 40, contentStudioDesignCanvasSnapThreshold(0.25))
    ).toMatchObject({ x: 0 });
    expect(
      snap(10, 200, 100, 40, contentStudioDesignCanvasSnapThreshold(1))
    ).toMatchObject({ x: 10 });
  });
  it('SN17/M19 rotation is ignored: targets and anchors are the stored unrotated boxes', () => {
    const rotated = page(
      [
        rect('moving', { x: 0, y: 0, width: 10, height: 10 }),
        rect('turned', {
          x: 400,
          y: 300,
          width: 100,
          height: 50,
          rotation: 45,
        }),
      ],
      1200,
      800
    );
    expect(contentStudioDesignCanvasSnapTargets(rotated, 'moving')).toEqual(
      targets
    );
  });
  it('SN18/SN19 each axis snaps on its own; a guide only for an axis that snapped', () => {
    expect(snap(3, 107)).toEqual({
      x: 0,
      y: 107,
      verticalGuide: 0,
      horizontalGuide: null,
    });
    expect(snap(207, 2)).toEqual({
      x: 207,
      y: 0,
      verticalGuide: null,
      horizontalGuide: 0,
    });
    expect(snap(2, 3)).toEqual({
      x: 0,
      y: 0,
      verticalGuide: 0,
      horizontalGuide: 0,
    });
  });
  it('the page and its layers are left as they are', () => {
    const frozen = deepFreeze(
      page([rect('moving', { x: 0, y: 0, width: 10, height: 10 }), OTHER])
    );
    expect(() =>
      contentStudioDesignCanvasSnapTargets(frozen, 'moving')
    ).not.toThrow();
  });
});

describe('canvas geometry: zoom and pan', () => {
  it('ZP1/84 a square page in a square view fits with padding', () => {
    const view = fitContentStudioDesignCanvasView(
      { width: 1080, height: 1080 },
      { width: 540, height: 540 }
    );
    expect(view.zoom).toBeCloseTo((540 - 48) / 1080, 10);
    expect(view.zoom).toBeGreaterThan(0.45);
    expect(view.zoom).toBeLessThan(0.5);
    expect(view.panX).toBeCloseTo(24, 10);
    expect(view.panY).toBeCloseTo(24, 10);
  });
  it('ZP2 a portrait page fits its height, centered across', () => {
    const view = fitContentStudioDesignCanvasView(
      { width: 1080, height: 1920 },
      { width: 800, height: 600 }
    );
    expect(view.zoom).toBeCloseTo(552 / 1920, 10);
    expect(view.panY).toBeCloseTo(24, 10);
    expect(view.panX).toBeCloseTo((800 - 1080 * view.zoom) / 2, 10);
  });
  it('ZP3 fit never zooms above 100%', () => {
    expect(
      fitContentStudioDesignCanvasView(
        { width: 1080, height: 1080 },
        { width: 4000, height: 3000 }
      )
    ).toEqual({ zoom: 1, panX: (4000 - 1080) / 2, panY: (3000 - 1080) / 2 });
  });
  it('ZP4 a tiny view fits below 25%', () => {
    const view = fitContentStudioDesignCanvasView(
      { width: 8192, height: 4096 },
      { width: 200, height: 200 }
    );
    expect(view.zoom).toBeLessThan(0.25);
    expect(view.zoom).toBeGreaterThan(0);
  });
  it('ZP5/ZP6 zoom steps are 25% within 25% to 200%', () => {
    expect(stepContentStudioDesignCanvasZoom(0.4556, 1)).toBe(0.5);
    expect(stepContentStudioDesignCanvasZoom(0.5, 1)).toBe(0.75);
    expect(stepContentStudioDesignCanvasZoom(0.4556, -1)).toBe(0.25);
    expect(stepContentStudioDesignCanvasZoom(0.25, -1)).toBe(0.25);
    expect(stepContentStudioDesignCanvasZoom(1.75, 1)).toBe(2);
    expect(stepContentStudioDesignCanvasZoom(2, 1)).toBe(2);
    expect(stepContentStudioDesignCanvasZoom(0.05, 1)).toBe(0.25);
    expect(clampContentStudioDesignCanvasZoom(0.1)).toBe(0.25);
    expect(clampContentStudioDesignCanvasZoom(5)).toBe(2);
  });
  it('ZP7/83 a design point is at pan + point × zoom; zooming keeps the middle of the view', () => {
    const view = { zoom: 0.5, panX: 30, panY: -20 };
    expect(
      contentStudioDesignCanvasScreenPoint(view, { x: 540, y: 100 })
    ).toEqual({
      x: 300,
      y: 30,
    });
    const viewport = { width: 600, height: 400 };
    const zoomed = zoomContentStudioDesignCanvasView(view, 1, viewport);
    const middle = (v: typeof view) => ({
      x: (viewport.width / 2 - v.panX) / v.zoom,
      y: (viewport.height / 2 - v.panY) / v.zoom,
    });
    expect(middle(zoomed).x).toBeCloseTo(middle(view).x, 10);
    expect(middle(zoomed).y).toBeCloseTo(middle(view).y, 10);
    expect(panContentStudioDesignCanvasView(view, 12, -7)).toEqual({
      zoom: 0.5,
      panX: 42,
      panY: -27,
    });
  });
  it('ZP8 no helper changes its input', () => {
    const current = deepFreeze(box(1, 2, 3, 4, 5));
    const view = deepFreeze({ zoom: 1, panX: 0, panY: 0 });
    expect(() => {
      contentStudioDesignCanvasObject(current);
      contentStudioDesignCanvasBox(
        deepFreeze(moved(current, { left: 9 })),
        current
      );
      zoomContentStudioDesignCanvasView(view, 2, { width: 10, height: 10 });
      panContentStudioDesignCanvasView(view, 1, 1);
      fitContentStudioDesignCanvasView(
        deepFreeze({ width: 10, height: 10 }),
        deepFreeze({ width: 5, height: 5 })
      );
    }).not.toThrow();
  });
});
