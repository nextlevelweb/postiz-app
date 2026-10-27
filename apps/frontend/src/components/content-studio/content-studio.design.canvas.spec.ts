import { createElement as h } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { SWRConfig } from 'swr';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { TextEncoder as NodeTextEncoder } from 'util';
import { fitContentStudioDesignCanvasView } from './content-studio.design.geometry';

// Direct canvas editing (P4-09) in the Creative Studio workspace. A .spec.ts
// without JSX, like the other Content Studio frontend specs: components are
// required, not imported, and type checked with the frontend tsconfig.
// jsdom has no canvas, so Fabric is replaced by a small stand-in with the
// part of its API the adapter uses (and nothing else: a Fabric text or image
// class would be undefined here). The stand-in records what the adapter gave
// each hitbox and lets the tests act as the user: select, move, scale, rotate
if (typeof (globalThis as any).TextEncoder === 'undefined') {
  (globalThis as any).TextEncoder = NodeTextEncoder;
}

type Plain = Record<string, any>;

const mockFabric = {
  canvases: [] as any[],
  created: [] as Array<{ kind: string; options: Plain }>,
  sets: [] as Plain[],
};
jest.mock('fabric', () => {
  class FabricObject {
    [key: string]: any;
    constructor(kind: string, options: Plain) {
      Object.assign(this, {
        scaleX: 1,
        scaleY: 1,
        angle: 0,
        flipX: false,
        flipY: false,
        skewX: 0,
        skewY: 0,
      });
      this.assign(options);
      this.kind = kind;
      mockFabric.created.push({ kind, options: { ...options } });
    }
    assign(options: Plain) {
      Object.assign(this, options);
      if ('rx' in options) {
        this.width = options.rx * 2;
      }
      if ('ry' in options) {
        this.height = options.ry * 2;
      }
    }
    set(options: Plain) {
      mockFabric.sets.push({ ...options });
      this.assign(options);
      return this;
    }
    setCoords() {
      return undefined;
    }
    // the rotated bounds Fabric would also offer: never what is stored
    getBoundingRect() {
      const rad = (this.angle * Math.PI) / 180;
      const w = this.width * this.scaleX;
      const hh = this.height * this.scaleY;
      const width = Math.abs(w * Math.cos(rad)) + Math.abs(hh * Math.sin(rad));
      const height = Math.abs(w * Math.sin(rad)) + Math.abs(hh * Math.cos(rad));
      return {
        left: this.left - width / 2,
        top: this.top - height / 2,
        width,
        height,
      };
    }
    // a scene point inside the object's own (rotated) shape
    contains(x: number, y: number) {
      const rad = (-this.angle * Math.PI) / 180;
      const dx = x - this.left;
      const dy = y - this.top;
      const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
      const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
      const rx = (this.width * this.scaleX) / 2;
      const ry = (this.height * this.scaleY) / 2;
      return this.kind === 'ellipse' && this.perPixelTargetFind
        ? (lx / rx) ** 2 + (ly / ry) ** 2 <= 1
        : Math.abs(lx) <= rx && Math.abs(ly) <= ry;
    }
  }
  class Rect extends FabricObject {
    constructor(options: Plain) {
      super('rect', options);
    }
  }
  class Ellipse extends FabricObject {
    constructor(options: Plain) {
      super('ellipse', options);
    }
  }
  class Canvas {
    [key: string]: any;
    constructor(element: HTMLCanvasElement, options: Plain) {
      this.element = element;
      this.options = { ...options };
      Object.assign(this, options);
      this.objects = [] as any[];
      this.handlers = {} as Record<string, Array<(event: Plain) => void>>;
      this.active = undefined;
      this.disposed = false;
      this.skipTargetFind = false;
      // like Fabric: the element moves into a container of its own
      const container = element.ownerDocument.createElement('div');
      container.setAttribute('data-fabric', 'container');
      element.parentNode?.replaceChild(container, element);
      container.appendChild(element);
      this.container = container;
      mockFabric.canvases.push(this);
    }
    on(name: string, handler: (event: Plain) => void) {
      (this.handlers[name] ??= []).push(handler);
      return () => undefined;
    }
    fire(name: string, event: Plain = {}) {
      for (const handler of this.handlers[name] ?? []) {
        handler(event);
      }
    }
    add(...objects: any[]) {
      this.objects.push(...objects);
    }
    remove(...objects: any[]) {
      for (const object of objects) {
        this.objects = this.objects.filter((entry: any) => entry !== object);
        if (this.active === object) {
          this.active = undefined;
          this.fire('selection:cleared', { deselected: [object] });
        }
      }
    }
    getObjects() {
      return [...this.objects];
    }
    moveObjectTo(object: any, index: number) {
      this.objects = this.objects.filter((entry: any) => entry !== object);
      this.objects.splice(index, 0, object);
    }
    getActiveObject() {
      return this.active;
    }
    setActiveObject(object: any) {
      const previous = this.active;
      this.active = object;
      this.fire(previous ? 'selection:updated' : 'selection:created', {
        selected: [object],
      });
      return true;
    }
    discardActiveObject() {
      const previous = this.active;
      this.active = undefined;
      if (previous) {
        this.fire('selection:cleared', { deselected: [previous] });
      }
      return !!previous;
    }
    setDimensions(size: Plain) {
      this.size = size;
    }
    setViewportTransform(matrix: number[]) {
      this.matrix = matrix;
    }
    requestRenderAll() {
      return undefined;
    }
    dispose() {
      this.disposed = true;
      this.container.parentNode?.replaceChild(this.element, this.container);
      return Promise.resolve(true);
    }
    // the top-most hitbox under a scene point, as Fabric finds it with the
    // design's stacking kept
    findAt(x: number, y: number) {
      for (let i = this.objects.length - 1; i >= 0; i--) {
        if (this.objects[i].contains(x, y)) {
          return this.objects[i];
        }
      }
      return undefined;
    }
  }
  return { Canvas, Rect, Ellipse, FabricObject };
});

jest.mock('next/link', () => {
  const { createElement } = require('react');
  return {
    __esModule: true,
    default: ({ href, prefetch, children, ...rest }: any) =>
      createElement('a', { href, ...rest }, children),
  };
});
jest.mock('next/navigation', () => ({
  usePathname: () => '/content-studio',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock('@gitroom/frontend/components/layout/new-modal', () => ({
  useModalCloseGuard: () => undefined,
  useModals: () => ({
    openModal: jest.fn(),
    closeAll: jest.fn(),
    closeById: jest.fn(),
    closeCurrent: jest.fn(),
  }),
}));
const mockConfirm = jest.fn();
jest.mock('@gitroom/react/helpers/delete.dialog', () => ({
  deleteDialog: (...args: unknown[]) => mockConfirm(...args),
}));
const mockFetch = jest.fn();
jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));
const mockToast = jest.fn();
jest.mock('@gitroom/react/toaster/toaster', () => ({
  useToaster: () => ({ show: mockToast }),
}));
jest.mock('@gitroom/react/translation/get.transation.service.client', () => ({
  useT: () => (key: string, fallback?: string) => fallback ?? key,
}));

const {
  ContentStudioDesignWorkspace,
} = require('./content-studio.design.workspace');

// --- markers: never in Fabric, shown as markup, logged or toasted ---
const SECRET = 'DESIGN_CANVAS_SERVER_SECRET_123';
const HTML_MARKER = 'DESIGN_CANVAS_HTML_MARKER_456';
const FABRIC_MARKER = 'DESIGN_CANVAS_FABRIC_PRIVATE_789';

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const T0 = '2026-10-10T10:00:00.000Z';
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const lit = (value: string) => ({ type: 'literal', value });
const layerBase = (id: string, geometry: Plain, extra: Plain) => ({
  id,
  name: `${id} <b>${HTML_MARKER}</b>`,
  rotation: 0,
  opacity: 1,
  visible: true,
  ...geometry,
  ...extra,
});
const rect = (id: string, geometry: Plain, extra: Plain = {}) =>
  layerBase(id, geometry, {
    type: 'shape',
    shape: 'rectangle',
    fill: lit('#ff0000'),
    cornerRadius: 4,
    ...extra,
  });
const ellipse = (id: string, geometry: Plain, extra: Plain = {}) =>
  layerBase(id, geometry, {
    type: 'shape',
    shape: 'ellipse',
    fill: lit('#00ff00'),
    cornerRadius: 0,
    ...extra,
  });
const text = (id: string, geometry: Plain) =>
  layerBase(id, geometry, {
    type: 'text',
    text: `Hello <img src=x onerror=alert(1)> ${HTML_MARKER}`,
    font: { type: 'family', family: 'Inter', weight: 700, style: 'italic' },
    fontSize: 48,
    lineHeight: 1.2,
    letterSpacing: 0,
    color: lit('#123456'),
    align: 'left',
    verticalAlign: 'top',
    overflow: 'clip',
  });
const image = (id: string, geometry: Plain) =>
  layerBase(id, geometry, {
    type: 'image',
    imageRef: { type: 'media', mediaId: 'photo-1', sha256: SHA('a') },
    fit: 'cover',
    focalPoint: { x: 0.5, y: 0.5 },
  });
const page = (id: string, layers: unknown[], width = 1080, height = 1080) => ({
  id,
  name: id === 'p_one' ? 'One' : 'Two',
  width,
  height,
  background: { type: 'solid', color: lit('#ffffff') },
  layers,
});
const doc = (pages: unknown[]) => ({ schemaVersion: 1, brandKit: null, pages });
// the order is the design's: first at the back
const MAIN_DOC = () =>
  doc([
    page('p_one', [
      rect('back', { x: 100, y: 100, width: 200, height: 100 }),
      rect('card', { x: 100, y: 200, width: 300, height: 100, rotation: 30 }),
      ellipse('dot', { x: 600, y: 600, width: 200, height: 100 }),
      text('title', { x: 50, y: 700, width: 500, height: 100 }),
      image('photo', {
        x: 700,
        y: 100,
        width: 200,
        height: 200,
        rotation: 270,
      }),
      rect('cover', { x: 150, y: 110, width: 100, height: 50 }),
      rect(
        'clear',
        { x: 800, y: 800, width: 100, height: 100 },
        { opacity: 0 }
      ),
      rect(
        'ghost',
        { x: 150, y: 120, width: 100, height: 50 },
        { visible: false }
      ),
    ]),
    page(
      'p_two',
      [rect('other', { x: 10, y: 10, width: 50, height: 50 })],
      1200,
      628
    ),
  ]);
const SOLO_DOC = () =>
  doc([
    page('p_one', [rect('solo', { x: 100, y: 100, width: 200, height: 100 })]),
  ]);
const VISIBLE = ['back', 'card', 'dot', 'title', 'photo', 'cover', 'clear'];

type Revision = { id: string; revisionNumber: number; content: any };
type Design = { id: string; name: string; revisions: Revision[] };
let designs: Design[];
let counter = 0;
const nextId = () =>
  `${String(++counter).padStart(8, '0')}-0000-4000-8000-000000000000`;
const revision = (revisionNumber: number, content: any): Revision => ({
  id: nextId(),
  revisionNumber,
  content,
});
const design = (name: string, content: any): Design => ({
  id: nextId(),
  name,
  revisions: [revision(1, content)],
});
const latest = (d: Design) => d.revisions[d.revisions.length - 1];
const meta = (d: Design, r: Revision) => ({
  id: r.id,
  revisionNumber: r.revisionNumber,
  schemaVersion: 1,
  contentHash: SHA(String(r.revisionNumber)),
  createdAt: T0,
});
const summary = (d: Design) => ({
  id: d.id,
  name: d.name,
  latestRevisionNumber: d.revisions.length,
  archivedAt: null,
  createdAt: T0,
  updatedAt: T0,
});
let MAIN: Design;
let SOLO: Design;

const server = (method: string, url: string, body: any): Reply => {
  const { pathname } = new URL(url, 'https://api.test');
  const base = '/content-studio/designs';
  const match = pathname
    .slice(base.length)
    .match(/^\/([^/]+)(?:\/(revisions)(?:\/([^/]+))?)?$/);
  const found = match && designs.find((d) => d.id === match[1]);
  if (!pathname.startsWith(base) || !found) {
    if (method === 'GET' && pathname === base) {
      return reply(200, { pages: 1, results: designs.map(summary) });
    }
    return reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
  }
  const [, , action, revisionId] = match as RegExpMatchArray;
  if (method === 'GET' && !action) {
    const current = latest(found);
    return reply(200, {
      ...summary(found),
      currentRevision: { ...meta(found, current), content: current.content },
    });
  }
  if (method === 'GET' && action === 'revisions' && !revisionId) {
    return reply(200, {
      pages: 1,
      results: [...found.revisions].reverse().map((r) => meta(found, r)),
    });
  }
  if (method === 'POST' && action === 'revisions') {
    if (body.baseRevisionNumber !== found.revisions.length) {
      return reply(409, {
        msg: `${SECRET} ${FABRIC_MARKER}`,
        code: 'CS_DESIGN_REVISION_CONFLICT',
      });
    }
    const next = revision(found.revisions.length + 1, body.content);
    found.revisions = [...found.revisions, next];
    return reply(201, {
      created: true,
      revision: { ...meta(found, next), content: next.content },
    });
  }
  return reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
};

let storageSpies: jest.SpyInstance[];
let consoleSpies: jest.SpyInstance[];

beforeEach(() => {
  counter = 0;
  mockFabric.canvases = [];
  mockFabric.created = [];
  mockFabric.sets = [];
  MAIN = design('Main', MAIN_DOC());
  SOLO = design('Solo', SOLO_DOC());
  designs = [MAIN, SOLO];
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    return server(init.method || 'GET', url, body);
  });
  mockConfirm.mockReset();
  mockConfirm.mockResolvedValue(true);
  mockToast.mockReset();
  storageSpies = [
    jest.spyOn(Storage.prototype, 'setItem'),
    jest.spyOn(Storage.prototype, 'getItem'),
  ];
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
    (level) => jest.spyOn(console, level)
  );
});

afterEach(async () => {
  // nothing of the view or the canvas is kept, and nothing is logged
  for (const spy of storageSpies) {
    expect(spy).not.toHaveBeenCalled();
  }
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled();
  }
  for (const text of mockToast.mock.calls.map(([t]) => t as string)) {
    expect(text).not.toMatch(
      new RegExp(`${SECRET}|${HTML_MARKER}|${FABRIC_MARKER}`)
    );
  }
  expect(document.body.textContent).not.toMatch(
    new RegExp(`${SECRET}|${FABRIC_MARKER}`)
  );
  expect(document.querySelectorAll('script, b, [onerror]')).toHaveLength(0);
  cleanup();
  [...storageSpies, ...consoleSpies].forEach((spy) => spy.mockRestore());
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
const renderWorkspace = async (id = MAIN.id) => {
  const cache = new Map();
  render(
    h(
      SWRConfig,
      { value: { provider: () => cache, dedupingInterval: 0 } },
      h(ContentStudioDesignWorkspace, { designId: id })
    )
  );
  await flush();
};
const button = (name: string | RegExp, root: HTMLElement = document.body) =>
  within(root).getByRole('button', { name });
const click = async (element: HTMLElement) => {
  fireEvent.click(element);
  await flush();
};
const field = (name: string | RegExp) =>
  screen.getByLabelText(name) as HTMLInputElement;
const commit = async (element: HTMLElement, value: string) => {
  fireEvent.change(element, { target: { value } });
  fireEvent.blur(element);
  await flush();
};
const edit = async (id = MAIN.id) => {
  await renderWorkspace(id);
  await click(button('Edit design'));
};
const toolbar = () => screen.getByRole('toolbar', { name: 'Design editor' });
const isOff = (element: HTMLElement) =>
  (element as HTMLButtonElement).disabled ||
  element.className.includes('opacity-50');
const saveOff = () => isOff(button('Save', toolbar()));
const undoOff = () => isOff(button('Undo', toolbar()));
const redoOff = () => isOff(button('Redo', toolbar()));
const heading = () =>
  screen
    .getAllByRole('heading', { level: 2 })
    .map((el) => el.textContent)
    .find((value) => /^Layer · |^Page \d/.test(value ?? ''));
const selectLayer = async (id: string) =>
  click(
    within(screen.getByRole('list', { name: 'Layers' })).getByRole('button', {
      name: new RegExp(`^${id} `),
    })
  );
const selectPage = async (name: RegExp) =>
  click(
    within(screen.getByRole('list', { name: 'Pages' })).getByRole('button', {
      // P4-10: a page card is named "Select page N · name"
      name: new RegExp(name.source, 'i'),
    })
  );
const canvases = () => mockFabric.canvases;
const fabric = () => canvases()[canvases().length - 1];
const hitboxes = () => fabric().getObjects();
// the hitbox of a visible layer, by its place in the design's order
const hitbox = (id: string, order = VISIBLE) => hitboxes()[order.indexOf(id)];
const previewPage = () =>
  document.querySelector('[data-preview="page"]') as HTMLElement;
const previewLayer = (id: string) =>
  document.querySelector(`[data-layer="${id}"]`) as HTMLElement | null;
const saves = () =>
  mockFetch.mock.calls.filter(
    ([url, init]) =>
      init?.method === 'POST' && String(url).endsWith('/revisions')
  );
const lastSaved = () => JSON.parse(saves()[saves().length - 1][1].body);
const draftLayer = async (id: string) => {
  // the draft as the save sends it
  await click(button('Save', toolbar()));
  return lastSaved()
    .content.pages.flatMap((p: Plain) => p.layers)
    .find((l: Plain) => l.id === id);
};
const geometry = (layer: Plain) => ({
  x: layer.x,
  y: layer.y,
  width: layer.width,
  height: layer.height,
  rotation: layer.rotation,
});
const zoomText = () => screen.getByLabelText('Zoom').textContent;
const viewport = () =>
  document.querySelector('[data-canvas="viewport"]') as HTMLElement;
const guide = (axis: 'vertical' | 'horizontal') =>
  document.querySelector(`[data-guide="${axis}"]`) as HTMLElement | null;

// --- the user on the canvas ---
// Fabric events reach React outside its own event system
const fire = (name: string, event: Plain = {}) =>
  act(() => {
    fabric().fire(name, event);
  });
const userSelect = async (object: any) => {
  const canvas = fabric();
  const previous = canvas.active;
  canvas.active = object;
  fire(previous ? 'selection:updated' : 'selection:created', {
    selected: [object],
  });
  fire('mouse:up');
  await flush();
};
const userClickEmpty = async () => {
  const canvas = fabric();
  const previous = canvas.active;
  canvas.active = undefined;
  if (previous) {
    fire('selection:cleared', { deselected: [previous] });
  }
  fire('mouse:up');
  await flush();
};
const userClickAt = async (x: number, y: number) => {
  const target = fabric().findAt(x, y);
  return target ? userSelect(target) : userClickEmpty();
};
// a gesture in two parts, so what happens in between can be checked
const gesture = (object: any) => ({
  move(dx: number, dy: number, altKey = false) {
    const start = { left: object.left, top: object.top };
    // Fabric places the object from the pointer at every step
    for (const share of [0.25, 0.5, 1]) {
      object.left = start.left + dx * share;
      object.top = start.top + dy * share;
      fire('object:moving', { target: object, e: { altKey } });
    }
  },
  scale(scaleX: number, scaleY: number) {
    object.scaleX = scaleX;
    object.scaleY = scaleY;
    fire('object:scaling', { target: object, e: {} });
  },
  rotate(angle: number) {
    object.angle = angle;
    fire('object:rotating', { target: object, e: {} });
  },
  async end() {
    fire('object:modified', { target: object, action: 'drag' });
    fire('mouse:up');
    await flush();
  },
});
const userMove = async (object: any, dx: number, dy: number, altKey = true) => {
  const g = gesture(object);
  g.move(dx, dy, altKey);
  await g.end();
};
const userScale = async (object: any, scaleX: number, scaleY: number) => {
  const g = gesture(object);
  g.scale(scaleX, scaleY);
  await g.end();
};
const userRotate = async (object: any, angle: number) => {
  const g = gesture(object);
  g.rotate(angle);
  await g.end();
};

// rendering the workspace and acting on it takes a while in jsdom: like the
// other workspace specs, the UI tests get a longer timeout
const UI_TIMEOUT = 60_000;
const ui = (name: string, test: () => Promise<void>) =>
  it(name, test, UI_TIMEOUT);

// ============================================================================
describe('Direct canvas: mounting and hydration', () => {
  ui(
    '61/CH12/M31 no Fabric canvas outside edit mode; one while editing',
    async () => {
      await renderWorkspace();
      expect(canvases()).toHaveLength(0);
      expect(document.querySelector('[data-canvas="viewport"]')).toBeNull();
      expect(previewPage()).toBeTruthy();
      await click(button('Edit design'));
      expect(canvases()).toHaveLength(1);
      expect(fabric().options).toMatchObject({
        selection: false,
        preserveObjectStacking: true,
        uniformScaling: false,
      });
      // the stored revision is not changed by any of it
      expect(latest(MAIN).content).toEqual(MAIN_DOC());
      expect(saveOff()).toBe(true);
      expect(undoOff()).toBe(true);
    }
  );

  ui(
    'CH1/CH2/CH3/CH9/M12/M13/M16 one hitbox per visible layer, in the design order; hidden none, opacity 0 one',
    async () => {
      await edit();
      expect(hitboxes()).toHaveLength(VISIBLE.length);
      expect(hitboxes().map((o: any) => [o.left, o.top])).toEqual([
        [200, 150],
        [250, 250],
        [700, 650],
        [300, 750],
        [800, 200],
        [200, 135],
        [850, 850],
      ]);
      expect(mockFabric.created).toHaveLength(VISIBLE.length);
    }
  );

  ui(
    'CH4/CH5/CH6/CH7/CH8/M1/M27/M28 hitboxes: an ellipse for an ellipse, boxes otherwise, centered at the stored angle',
    async () => {
      await edit();
      expect(hitboxes().map((o: any) => o.kind)).toEqual([
        'rect',
        'rect',
        'ellipse',
        'rect',
        'rect',
        'rect',
        'rect',
      ]);
      expect(hitbox('card')).toMatchObject({
        originX: 'center',
        originY: 'center',
        left: 250,
        top: 250,
        width: 300,
        height: 100,
        angle: 30,
        scaleX: 1,
        scaleY: 1,
      });
      expect(hitbox('dot')).toMatchObject({
        rx: 100,
        ry: 50,
        width: 200,
        height: 100,
        perPixelTargetFind: true,
      });
      // CG7/M5: 270 is held as stored
      expect(hitbox('photo').angle).toBe(270);
      for (const object of hitboxes()) {
        expect(object).toMatchObject({
          lockScalingFlip: true,
          lockSkewingX: true,
          lockSkewingY: true,
          strokeWidth: 0,
          centeredRotation: true,
        });
      }
    }
  );

  ui(
    'CH10/138/P409-7 Fabric gets geometry only: no text, name, color, font, image or URL',
    async () => {
      await edit();
      const allowed = [
        'left',
        'top',
        'angle',
        'scaleX',
        'scaleY',
        'width',
        'height',
        'rx',
        'ry',
        'originX',
        'originY',
        'strokeWidth',
        'padding',
        'objectCaching',
        'centeredRotation',
        'lockScalingFlip',
        'lockSkewingX',
        'lockSkewingY',
        'transparentCorners',
        'fill',
        'perPixelTargetFind',
        'borderColor',
        'cornerColor',
      ];
      for (const { options } of mockFabric.created) {
        for (const key of Object.keys(options)) {
          expect(allowed).toContain(key);
        }
        expect(['transparent', 'rgba(0,0,0,0.01)']).toContain(options.fill);
      }
      const everything = JSON.stringify([mockFabric.created, mockFabric.sets]);
      expect(everything).not.toMatch(
        new RegExp(
          `${HTML_MARKER}|Hello|Inter|italic|#ff0000|#00ff00|#123456|photo-1|${SHA(
            'a'
          )}|https?:|<img|onerror`
        )
      );
      // the layer id lives in the adapter's memory, not on the object
      expect(everything).not.toMatch(/back|card|title|layerId|"id"/);
    }
  );

  ui(
    'CH11 the hitbox mapping is not a property of the Fabric objects',
    async () => {
      await edit();
      for (const object of hitboxes()) {
        expect(Object.getOwnPropertySymbols(object)).toEqual([]);
        expect(
          Object.keys(object).filter((key) =>
            /^(id|name|layer|layerId|designId|data|meta)$/i.test(key)
          )
        ).toEqual([]);
        expect(Object.values(object)).not.toEqual(
          expect.arrayContaining(VISIBLE)
        );
      }
    }
  );

  ui(
    '25/93/M29/M30 the DOM preview stays the picture, under the canvas, unclickable and without its own outline',
    async () => {
      await edit();
      const pageEl = previewPage();
      const view = viewport();
      expect(view.contains(pageEl)).toBe(true);
      expect(pageEl.style.pointerEvents).toBe('none');
      expect(pageEl.style.width).toBe('1080px');
      expect(pageEl.style.transformOrigin).toBe('top left');
      // layers are still drawn by the preview: text as text, image as a placeholder
      expect(previewLayer('title')?.textContent).toContain(HTML_MARKER);
      expect(previewLayer('photo')?.textContent).toBe('Image');
      expect(previewLayer('ghost')).toBeNull();
      // the Fabric canvas lies over it
      const host = document.querySelector(
        '[data-canvas="interaction"]'
      ) as HTMLElement;
      expect(host.querySelector('canvas')).toBeTruthy();
      const children = Array.from(view.children);
      expect(children.indexOf(host)).toBeGreaterThan(children.indexOf(pageEl));
      expect(children.indexOf(pageEl)).toBeGreaterThanOrEqual(0);
      await selectLayer('back');
      expect(previewLayer('back')?.className).not.toContain('outline-[4px]');
      fireEvent.click(previewLayer('cover') as HTMLElement);
      await flush();
      expect(heading()).toBe(`Layer · back <b>${HTML_MARKER}</b>`);
      // the warning stays: the canvas is not the render
      expect(
        screen.getByText(
          'Final typography and image rendering may differ. Use Render page for the authoritative output.'
        )
      ).toBeTruthy();
    }
  );

  ui(
    '46/M32 Cancel disposes the canvas and removes it from the page',
    async () => {
      await edit();
      const canvas = fabric();
      await click(button('Cancel', toolbar()));
      expect(canvas.disposed).toBe(true);
      expect(document.querySelector('canvas')).toBeNull();
      expect(document.querySelector('[data-canvas="viewport"]')).toBeNull();
    }
  );
});

// ============================================================================
describe('Direct canvas: selection', () => {
  ui(
    'CS1/M14 a click on a hitbox selects its layer for the list and the inspector',
    async () => {
      await edit();
      await userSelect(hitbox('dot'));
      expect(heading()).toBe(`Layer · dot <b>${HTML_MARKER}</b>`);
      expect(
        within(screen.getByRole('list', { name: 'Layers' }))
          .getByRole('button', { name: /^dot / })
          .getAttribute('aria-pressed')
      ).toBe('true');
      expect(field('X').value).toBe('600');
    }
  );

  ui(
    'CS2 a layer chosen in the list becomes the canvas selection',
    async () => {
      await edit();
      await selectLayer('card');
      expect(fabric().getActiveObject()).toBe(hitbox('card'));
      await selectLayer('title');
      expect(fabric().getActiveObject()).toBe(hitbox('title'));
      expect(heading()).toBe(`Layer · title <b>${HTML_MARKER}</b>`);
    }
  );

  ui(
    'CS3/20 a click on empty canvas clears the choice: the page inspector returns',
    async () => {
      await edit();
      await userSelect(hitbox('back'));
      await userClickEmpty();
      expect(heading()).toBe('Page 1 · One');
      expect(fabric().getActiveObject()).toBeUndefined();
    }
  );

  ui(
    'CS4/90 a hidden layer chosen in the list has the inspector but no canvas selection',
    async () => {
      await edit();
      await selectLayer('ghost');
      expect(heading()).toBe(`Layer · ghost <b>${HTML_MARKER}</b>`);
      expect(fabric().getActiveObject()).toBeUndefined();
      expect(field('X').value).toBe('150');
    }
  );

  ui(
    'CS5/92 a layer at opacity 0 gets the canvas selection with its controls',
    async () => {
      await edit();
      await selectLayer('clear');
      const active = fabric().getActiveObject();
      expect(active).toBe(hitbox('clear'));
      expect(active.opacity).toBeUndefined();
      expect(active.hasControls).not.toBe(false);
    }
  );

  ui(
    'CS6/55/M16 a click selects the front-most visible layer; a hidden front layer lets it through',
    async () => {
      await edit();
      // back and cover overlap; cover is in front
      await userClickAt(200, 130);
      expect(heading()).toBe(`Layer · cover <b>${HTML_MARKER}</b>`);
      // only back and the hidden ghost are here
      await userClickAt(240, 165);
      expect(heading()).toBe(`Layer · back <b>${HTML_MARKER}</b>`);
      // an ellipse is not hit in its bounding box corner
      await userClickAt(605, 605);
      expect(heading()).toBe('Page 1 · One');
      await userClickAt(700, 650);
      expect(heading()).toBe(`Layer · dot <b>${HTML_MARKER}</b>`);
    }
  );

  ui(
    'CS7/M15 no group selection: a selection of several is dropped',
    async () => {
      await edit();
      await userSelect(hitbox('back'));
      const canvas = fabric();
      canvas.active = { group: true };
      fire('selection:updated', {
        selected: [hitbox('back'), hitbox('card')],
      });
      await flush();
      expect(canvas.getActiveObject()).toBeUndefined();
      expect(heading()).toBe('Page 1 · One');
      expect(canvas.options.selection).toBe(false);
    }
  );

  ui(
    'CS8/CS9/68/M9 choosing and clearing layers changes nothing: no draft change, no undo step',
    async () => {
      await edit();
      await userSelect(hitbox('back'));
      await userSelect(hitbox('dot'));
      await selectLayer('ghost');
      await userClickEmpty();
      expect(saveOff()).toBe(true);
      expect(undoOff()).toBe(true);
    }
  );
});

// ============================================================================
describe('Direct canvas: move', () => {
  ui(
    'CM1/CM2/CM3/16/M7 moving changes nothing until the gesture ends, then one undo step',
    async () => {
      await edit(SOLO.id);
      const box = hitboxes()[0];
      await selectLayer('solo');
      const g = gesture(box);
      g.move(30, 20, true);
      // in the middle of the gesture: the draft is as it was, nothing can save,
      // undo or cancel
      expect(field('X').value).toBe('100');
      expect(previewLayer('solo')?.style.left).toBe('100px');
      expect(saveOff()).toBe(true);
      expect(undoOff()).toBe(true);
      expect(isOff(button('Cancel', toolbar()))).toBe(true);
      await g.end();
      expect(field('X').value).toBe('130');
      expect(field('Y').value).toBe('120');
      expect(previewLayer('solo')?.style.left).toBe('130px');
      expect(saveOff()).toBe(false);
      expect(undoOff()).toBe(false);
      await click(button('Undo', toolbar()));
      // one step back is the start
      expect(field('X').value).toBe('100');
      expect(undoOff()).toBe(true);
    }
  );

  ui(
    'CM4/67 the snapped position is what is committed; undo returns to the exact start',
    async () => {
      await edit(SOLO.id);
      const box = hitboxes()[0];
      await selectLayer('solo');
      // center x 200 -> 537 is 3 from the page center 540
      await userMove(box, 337, 0, false);
      expect(field('X').value).toBe('440');
      await click(button('Undo', toolbar()));
      expect(field('X').value).toBe('100');
      await click(button('Redo', toolbar()));
      expect(field('X').value).toBe('440');
    }
  );

  ui('107 Alt moves without snapping', async () => {
    await edit(SOLO.id);
    await selectLayer('solo');
    await userMove(hitboxes()[0], 337, 0, true);
    expect(field('X').value).toBe('437');
    expect(guide('vertical')).toBeNull();
  });

  ui('CM5 the other layers stay exactly as they were', async () => {
    await edit();
    await selectLayer('card');
    await userMove(hitbox('card'), 20, 40);
    const saved = (await draftLayer('card')) as Plain;
    expect(geometry(saved)).toEqual({
      x: 120,
      y: 240,
      width: 300,
      height: 100,
      rotation: 30,
    });
    const others = lastSaved()
      .content.pages.flatMap((p: Plain) => p.layers)
      .filter((l: Plain) => l.id !== 'card');
    const before = MAIN_DOC()
      .pages.flatMap((p: Plain) => p.layers)
      .filter((l: Plain) => l.id !== 'card');
    expect(others.map(geometry)).toEqual(before.map(geometry));
  });

  ui('CM6/M4 a fractional move is kept, not rounded', async () => {
    await edit(SOLO.id);
    await selectLayer('solo');
    await userMove(hitboxes()[0], 0.25, 10.125);
    expect(geometry(await draftLayer('solo'))).toEqual({
      x: 100.25,
      y: 110.125,
      width: 200,
      height: 100,
      rotation: 0,
    });
  });

  ui(
    'CM7/17 a move outside the design limits is refused and put back, with no undo step',
    async () => {
      await edit(SOLO.id);
      const box = hitboxes()[0];
      await selectLayer('solo');
      await userMove(box, 40000, 0);
      expect(mockToast).toHaveBeenCalledWith(
        'That transformation is outside the design limits.',
        'warning'
      );
      expect(field('X').value).toBe('100');
      expect(undoOff()).toBe(true);
      expect(saveOff()).toBe(true);
      expect(box.left).toBe(200);
    }
  );

  ui(
    'CM8/70/139 an error inside a canvas event is a fixed message; nothing raw is shown or logged',
    async () => {
      await edit(SOLO.id);
      const box = hitboxes()[0];
      await selectLayer('solo');
      const set = box.set;
      box.set = () => {
        throw new Error(`${FABRIC_MARKER} ${SECRET}`);
      };
      // snapping would place the object: that throws
      const g = gesture(box);
      g.move(337, 0, false);
      box.set = set;
      await g.end();
      expect(mockToast).toHaveBeenCalledWith(
        'The layer could not be updated.',
        'warning'
      );
      for (const spy of consoleSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    }
  );
});

describe('Direct canvas: failures', () => {
  ui(
    'CM9/70 a canvas that keeps failing is put back once, never in a loop',
    async () => {
      await edit();
      const canvas = fabric();
      canvas.setActiveObject = () => {
        throw new Error(`${FABRIC_MARKER} ${SECRET}`);
      };
      await selectLayer('card');
      await flush();
      const failures = mockToast.mock.calls.filter(
        ([text]) => text === 'The layer could not be updated.'
      );
      expect(failures.length).toBeGreaterThan(0);
      expect(failures.length).toBeLessThanOrEqual(4);
      // the editor still works
      expect(heading()).toBe(`Layer · card <b>${HTML_MARKER}</b>`);
    }
  );
});

// ============================================================================
describe('Direct canvas: resize', () => {
  ui(
    'CR1/CR2/CR3/CR4/CR6/76 width, height or both, around the same center: one step each',
    async () => {
      await edit(SOLO.id);
      await selectLayer('solo');
      await userScale(hitboxes()[0], 1.5, 1);
      expect([field('Width').value, field('X').value]).toEqual(['300', '50']);
      await userScale(hitboxes()[0], 1, 0.5);
      expect([field('Height').value, field('Y').value]).toEqual(['50', '125']);
      await userScale(hitboxes()[0], 0.5, 2);
      // the next sync holds the hitbox unscaled
      expect(hitboxes()[0]).toMatchObject({
        scaleX: 1,
        scaleY: 1,
        width: 150,
        height: 100,
      });
      expect(geometry(await draftLayer('solo'))).toEqual({
        x: 125,
        y: 100,
        width: 150,
        height: 100,
        rotation: 0,
      });
    }
  );

  ui(
    'CR5/CG12/78/M2 a rotated layer keeps its rotation and is sized by its raw box, not its rotated bounds',
    async () => {
      await edit();
      await selectLayer('card');
      await userScale(hitbox('card'), 1.5, 1);
      expect(geometry(await draftLayer('card'))).toEqual({
        x: 25,
        y: 200,
        width: 450,
        height: 100,
        rotation: 30,
      });
    }
  );

  ui('CR7/14/M6 flips are locked; a flipped result is refused', async () => {
    await edit(SOLO.id);
    const box = hitboxes()[0];
    expect(box.lockScalingFlip).toBe(true);
    await selectLayer('solo');
    box.flipX = true;
    await userScale(box, 1, 1.2);
    expect(mockToast).toHaveBeenCalledWith(
      'That transformation is outside the design limits.',
      'warning'
    );
    expect(undoOff()).toBe(true);
    expect(box.flipX).toBe(true);
  });

  ui('CR8 a size above the limit is refused', async () => {
    await edit(SOLO.id);
    await selectLayer('solo');
    await userScale(hitboxes()[0], 200, 1);
    expect(field('Width').value).toBe('200');
    expect(undoOff()).toBe(true);
    expect(hitboxes()[0].scaleX).toBe(1);
  });

  ui('CR9 a fractional resize is kept', async () => {
    await edit(SOLO.id);
    await selectLayer('solo');
    await userScale(hitboxes()[0], 1.2345, 1);
    const saved = await draftLayer('solo');
    expect(saved.width).toBe(200 * 1.2345);
    expect(saved.x).toBe(200 - (200 * 1.2345) / 2);
  });

  ui('CR10/71/M3 nothing of Fabric enters the saved document', async () => {
    await edit(SOLO.id);
    await selectLayer('solo');
    await userScale(hitboxes()[0], 1.5, 1);
    const saved = await draftLayer('solo');
    expect(Object.keys(saved).sort()).toEqual(
      [
        'id',
        'name',
        'x',
        'y',
        'width',
        'height',
        'rotation',
        'opacity',
        'visible',
        'type',
        'shape',
        'fill',
        'cornerRadius',
      ].sort()
    );
  });
});

// ============================================================================
describe('Direct canvas: rotate', () => {
  ui(
    'CT1/CT2/CT3/CT5 a rotation changes the rotation only: one undo step',
    async () => {
      await edit(SOLO.id);
      await selectLayer('solo');
      await userRotate(hitboxes()[0], 45);
      expect(field('Rotation').value).toBe('45');
      await click(button('Undo', toolbar()));
      expect(field('Rotation').value).toBe('0');
      expect(undoOff()).toBe(true);
      await click(button('Redo', toolbar()));
      expect(geometry(await draftLayer('solo'))).toEqual({
        x: 100,
        y: 100,
        width: 200,
        height: 100,
        rotation: 45,
      });
    }
  );

  ui('CT4/77 a rotation Fabric reports as 350 is stored as -10', async () => {
    await edit(SOLO.id);
    await selectLayer('solo');
    await userRotate(hitboxes()[0], 350);
    expect(field('Rotation').value).toBe('-10');
  });

  ui(
    'CT6/CG7/M5 a stored 270 stays 270 until the layer is rotated on the canvas',
    async () => {
      await edit();
      await selectLayer('photo');
      await userMove(hitbox('photo'), 10, 0);
      expect(field('Rotation').value).toBe('270');
      await userRotate(hitbox('photo'), 300);
      expect(field('Rotation').value).toBe('-60');
    }
  );
});

// ============================================================================
describe('Direct canvas: undo, redo and the inspector', () => {
  ui(
    'CU1/CU2/CU3/CU4/CU5/66 drag, resize and rotate undo exactly, and the hitbox follows',
    async () => {
      await edit(SOLO.id);
      await selectLayer('solo');
      await userMove(hitboxes()[0], 30, 20);
      await userScale(hitboxes()[0], 1.5, 1);
      await userRotate(hitboxes()[0], 45);
      expect(hitboxes()[0]).toMatchObject({
        left: 230,
        top: 170,
        width: 300,
        angle: 45,
      });
      await click(button('Undo', toolbar()));
      expect(hitboxes()[0]).toMatchObject({
        left: 230,
        top: 170,
        width: 300,
        angle: 0,
      });
      await click(button('Undo', toolbar()));
      expect(hitboxes()[0]).toMatchObject({ left: 230, top: 170, width: 200 });
      await click(button('Undo', toolbar()));
      expect(hitboxes()[0]).toMatchObject({ left: 200, top: 150, width: 200 });
      expect(undoOff()).toBe(true);
      await click(button('Redo', toolbar()));
      expect(hitboxes()[0]).toMatchObject({ left: 230, top: 170 });
    }
  );

  ui(
    'CU6/CI8/M8 putting the canvas back from the draft is no edit',
    async () => {
      await edit();
      await selectLayer('back');
      await selectPage(/Page 2/);
      await selectPage(/Page 1/);
      await click(button('Zoom in'));
      expect(undoOff()).toBe(true);
      await userMove(hitbox('back'), 5, 5);
      await click(button('Undo', toolbar()));
      expect(undoOff()).toBe(true);
      expect(saveOff()).toBe(true);
    }
  );

  ui('CU7 a canvas change after an undo clears redo', async () => {
    await edit(SOLO.id);
    await selectLayer('solo');
    await userMove(hitboxes()[0], 30, 20);
    await click(button('Undo', toolbar()));
    expect(redoOff()).toBe(false);
    await userRotate(hitboxes()[0], 10);
    expect(redoOff()).toBe(true);
  });

  ui('64 keyboard undo waits for a gesture in progress', async () => {
    await edit(SOLO.id);
    await selectLayer('solo');
    await userMove(hitboxes()[0], 30, 20);
    const g = gesture(hitboxes()[0]);
    g.rotate(20);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await flush();
    expect(field('X').value).toBe('130');
    await g.end();
    expect(field('Rotation').value).toBe('20');
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await flush();
    expect(field('Rotation').value).toBe('0');
  });

  ui(
    'CI1/48 an inspector geometry change moves the hitbox, with no extra step',
    async () => {
      await edit(SOLO.id);
      await selectLayer('solo');
      await commit(field('X'), '400');
      await commit(field('Rotation'), '270');
      expect(hitboxes()[0]).toMatchObject({ left: 500, angle: 270 });
      await click(button('Undo', toolbar()));
      await click(button('Undo', toolbar()));
      expect(undoOff()).toBe(true);
    }
  );

  ui(
    'CI2/CI3/90 hiding removes the hitbox (the inspector stays); showing it again brings it back selected',
    async () => {
      await edit();
      await selectLayer('card');
      fireEvent.click(screen.getByLabelText('Visible'));
      await flush();
      expect(hitboxes()).toHaveLength(VISIBLE.length - 1);
      expect(fabric().getActiveObject()).toBeUndefined();
      expect(heading()).toBe(`Layer · card <b>${HTML_MARKER}</b>`);
      fireEvent.click(screen.getByLabelText('Visible'));
      await flush();
      expect(hitboxes()).toHaveLength(VISIBLE.length);
      expect(fabric().getActiveObject()).toBe(hitbox('card'));
    }
  );

  ui(
    'CI4/53/89 a z-order change restacks the hitboxes; the selection stays',
    async () => {
      await edit();
      await selectLayer('back');
      const object = hitbox('back');
      await click(button('Bring to front'));
      const order = ['card', 'dot', 'title', 'photo', 'cover', 'clear', 'back'];
      expect(hitboxes()).toHaveLength(order.length);
      expect(hitboxes()[6]).toBe(object);
      expect(fabric().getActiveObject()).toBe(object);
      // the click at the overlap now finds back in front of cover
      await userClickAt(200, 130);
      expect(heading()).toBe(`Layer · back <b>${HTML_MARKER}</b>`);
    }
  );

  ui(
    'CI5/CI6/51/52/91 delete removes the hitbox; duplicate adds one, selected',
    async () => {
      await edit();
      await selectLayer('dot');
      await click(button('Duplicate layer'));
      expect(hitboxes()).toHaveLength(VISIBLE.length + 1);
      expect(fabric().getActiveObject()).toBe(hitboxes()[3]);
      expect(hitboxes()[3]).toMatchObject({ left: 720, top: 670 });
      await click(button('Delete layer'));
      expect(hitboxes()).toHaveLength(VISIBLE.length);
      expect(fabric().getActiveObject()).toBeUndefined();
      await click(button('Add rectangle'));
      expect(hitboxes()).toHaveLength(VISIBLE.length + 1);
      expect(fabric().getActiveObject()).toBe(hitboxes()[VISIBLE.length]);
    }
  );

  ui(
    'CI7/85/86/87/88/M33 pages: the same canvas shows the chosen page only, fitted again',
    async () => {
      await edit();
      await click(button('Zoom in'));
      await selectLayer('back');
      await selectPage(/Page 2/);
      expect(canvases()).toHaveLength(1);
      expect(hitboxes()).toHaveLength(1);
      expect(hitboxes()[0]).toMatchObject({ left: 35, top: 35 });
      expect(fabric().getActiveObject()).toBeUndefined();
      expect(zoomText()).toBe(`${Math.round(((640 - 48) / 1200) * 100)}%`);
      // reorder keeps the page
      await click(button('Move page up'));
      expect(hitboxes()).toHaveLength(1);
      // duplicate opens the copy
      await click(button('Duplicate page'));
      expect(hitboxes()).toHaveLength(1);
      // delete opens the next: page 1 again
      await click(button('Delete page'));
      expect(hitboxes()).toHaveLength(VISIBLE.length);
      expect(canvases()).toHaveLength(1);
      expect(undoOff()).toBe(false);
    }
  );
});

// ============================================================================
// the fitted view of a 1080 page in the 640 × 640 view jsdom gets
const FITTED = fitContentStudioDesignCanvasView(
  { width: 1080, height: 1080 },
  { width: 640, height: 640 }
);
const FIT = FITTED.zoom;
const FIT_MATRIX = [FIT, 0, 0, FIT, FITTED.panX, FITTED.panY];

describe('Direct canvas: zoom and pan', () => {
  ui('CZO1/27 the view opens fitted, centered', async () => {
    await edit();
    expect(zoomText()).toBe(`${Math.round(FIT * 100)}%`);
    expect(FIT).toBeCloseTo((640 - 48) / 1080, 10);
    expect(FITTED.panX).toBeCloseTo(24, 10);
    expect(fabric().matrix).toEqual(FIT_MATRIX);
    expect(fabric().size).toEqual({ width: 640, height: 640 });
    expect(previewPage().style.transform).toBe(
      `translate(${FITTED.panX}px, ${FITTED.panY}px) scale(${FIT})`
    );
  });

  ui(
    'CZO2/CZO3/CZO4/28 zoom steps of 25% within 25% to 200%; DOM and canvas move together',
    async () => {
      await edit();
      await click(button('Zoom in'));
      expect(zoomText()).toBe('75%');
      await click(button('Zoom out'));
      await click(button('Zoom out'));
      expect(zoomText()).toBe('25%');
      expect(isOff(button('Zoom out'))).toBe(true);
      for (let i = 0; i < 8; i++) {
        await click(button('Zoom in'));
      }
      expect(zoomText()).toBe('200%');
      expect(isOff(button('Zoom in'))).toBe(true);
      const [zoom, , , , panX, panY] = fabric().matrix;
      expect(zoom).toBe(2);
      expect(previewPage().style.transform).toBe(
        `translate(${panX}px, ${panY}px) scale(2)`
      );
    }
  );

  ui('CZO5 Fit resets zoom and pan', async () => {
    await edit();
    await click(button('Zoom in'));
    fireEvent.mouseDown(viewport(), { button: 1, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 70, clientY: 30 });
    fireEvent.mouseUp(window, {});
    await flush();
    await click(button('Fit'));
    expect(fabric().matrix).toEqual(FIT_MATRIX);
  });

  ui(
    'CZO7/CZO8/CZO9/CZO10/29/69/M10/M11 zoom and pan change nothing in the draft and add no undo step',
    async () => {
      await edit();
      await click(button('Zoom in'));
      await click(button('Zoom out'));
      fireEvent.mouseDown(viewport(), { button: 1, clientX: 0, clientY: 0 });
      fireEvent.mouseMove(window, { clientX: 50, clientY: 50 });
      fireEvent.mouseUp(window, {});
      await flush();
      expect(saveOff()).toBe(true);
      expect(undoOff()).toBe(true);
      expect(hitbox('back')).toMatchObject({ left: 200, top: 150 });
    }
  );

  ui(
    'CZO11/30/31/32 Space with the primary button pans; the canvas does not get the press',
    async () => {
      await edit();
      const listener = jest.fn();
      const host = document.querySelector(
        '[data-canvas="interaction"] canvas'
      ) as HTMLElement;
      host.addEventListener('mousedown', listener);
      fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
      await flush();
      const shield = document.querySelector(
        '[data-canvas="pan"]'
      ) as HTMLElement;
      expect(shield.className).toContain('cursor-grab');
      fireEvent.mouseDown(host, { button: 0, clientX: 100, clientY: 100 });
      fireEvent.mouseMove(window, { clientX: 130, clientY: 150 });
      await flush();
      expect(
        document.querySelector('[data-canvas="pan"]')?.className
      ).toContain('cursor-grabbing');
      fireEvent.mouseUp(window, {});
      fireEvent.keyUp(document.body, { key: ' ', code: 'Space' });
      await flush();
      expect(listener).not.toHaveBeenCalled();
      const panned = [FIT, 0, 0, FIT, FITTED.panX + 30, FITTED.panY + 50];
      expect(fabric().matrix).toEqual(panned);
      expect(previewPage().style.transform).toBe(
        `translate(${panned[4]}px, ${panned[5]}px) scale(${FIT})`
      );
      expect(document.querySelector('[data-canvas="pan"]')).toBeNull();
      expect(fabric().getActiveObject()).toBeUndefined();
    }
  );

  ui(
    'CZO12 without Space a primary press goes to the canvas, where a drag edits the layer',
    async () => {
      await edit(SOLO.id);
      const listener = jest.fn();
      const host = document.querySelector(
        '[data-canvas="interaction"] canvas'
      ) as HTMLElement;
      host.addEventListener('mousedown', listener);
      fireEvent.mouseDown(host, { button: 0, clientX: 100, clientY: 100 });
      fireEvent.mouseUp(host, {});
      expect(listener).toHaveBeenCalledTimes(1);
      await selectLayer('solo');
      await userMove(hitboxes()[0], 30, 20);
      expect(field('X').value).toBe('130');
    }
  );

  ui('CZO6 a page change fits again', async () => {
    await edit();
    await click(button('Zoom in'));
    await selectPage(/Page 2/);
    await selectPage(/Page 1/);
    expect(fabric().matrix).toEqual(FIT_MATRIX);
  });

  ui('CZO13/40 a pan clears the guides; the selection stays', async () => {
    await edit(SOLO.id);
    await selectLayer('solo');
    const g = gesture(hitboxes()[0]);
    g.move(337, 0, false);
    await flush();
    expect(guide('vertical')).toBeTruthy();
    fireEvent.mouseDown(viewport(), { button: 1, clientX: 0, clientY: 0 });
    await flush();
    expect(guide('vertical')).toBeNull();
    fireEvent.mouseUp(window, {});
    await g.end();
    expect(fabric().getActiveObject()).toBe(hitboxes()[0]);
  });
});

// ============================================================================
describe('Direct canvas: snapping guides', () => {
  ui(
    'CGD1/CGD6/39 a vertical guide at the snapped x, as a DOM line over the view',
    async () => {
      await edit(SOLO.id);
      await selectLayer('solo');
      const g = gesture(hitboxes()[0]);
      g.move(337, 0, false);
      await flush();
      const line = guide('vertical') as HTMLElement;
      expect(line.style.left).toBe(`${FITTED.panX + 540 * FIT}px`);
      expect(line.className).toContain('pointer-events-none');
      expect(viewport().contains(line)).toBe(true);
      expect(guide('horizontal')).toBeNull();
      // no Fabric object for it
      expect(hitboxes()).toHaveLength(1);
      expect(mockFabric.created).toHaveLength(1);
      await g.end();
    }
  );

  ui('CGD2/CGD3 a horizontal guide, and both', async () => {
    await edit(SOLO.id);
    await selectLayer('solo');
    const g = gesture(hitboxes()[0]);
    // center y 150 -> 537
    g.move(0, 387, false);
    await flush();
    expect(guide('horizontal')?.style.top).toBe(`${FITTED.panY + 540 * FIT}px`);
    expect(guide('vertical')).toBeNull();
    g.move(337, 0, false);
    await flush();
    expect(guide('vertical')).toBeTruthy();
    expect(guide('horizontal')).toBeTruthy();
    await g.end();
  });

  ui(
    'CGD4/CGD7/M22 guides go when the gesture ends, and are never saved',
    async () => {
      await edit(SOLO.id);
      await selectLayer('solo');
      await userMove(hitboxes()[0], 337, 0, false);
      expect(guide('vertical')).toBeNull();
      const saved = JSON.stringify((await draftLayer('solo')) as Plain);
      expect(saved).not.toMatch(/guide|snap|zoom|pan|viewport/i);
    }
  );

  ui('CGD5 guides go when the selection is cleared', async () => {
    await edit(SOLO.id);
    await selectLayer('solo');
    gesture(hitboxes()[0]).move(337, 0, false);
    await flush();
    expect(guide('vertical')).toBeTruthy();
    fabric().active = undefined;
    fire('selection:cleared', { deselected: [] });
    await flush();
    expect(guide('vertical')).toBeNull();
    fire('mouse:up');
    await flush();
  });

  ui('M21 targets come from the shown page only', async () => {
    await edit();
    await selectPage(/Page 2/);
    await selectLayer('other');
    // x 10 -> 112: nothing on page 1 is a target here
    await userMove(hitboxes()[0], 102, 0, false);
    expect(field('X').value).toBe('112');
  });
});

// ============================================================================
describe('Direct canvas: save, cancel and conflict', () => {
  ui(
    '133/112/CR10/M3/M24/M25/M26 three gestures, then Save sends exactly the Design Document',
    async () => {
      await edit(SOLO.id);
      await selectLayer('solo');
      await userMove(hitboxes()[0], 30, 20);
      await userScale(hitboxes()[0], 1.5, 1);
      await userRotate(hitboxes()[0], 45);
      await click(button('Zoom in'));
      await click(button('Save', toolbar()));
      expect(saves()).toHaveLength(1);
      const body = lastSaved();
      expect(Object.keys(body).sort()).toEqual([
        'baseRevisionNumber',
        'content',
      ]);
      expect(body.baseRevisionNumber).toBe(1);
      const layer = body.content.pages[0].layers[0];
      expect(geometry(layer)).toEqual({
        x: 80,
        y: 120,
        width: 300,
        height: 100,
        rotation: 45,
      });
      const raw = JSON.stringify(body);
      for (const key of [
        'left',
        'top',
        'scaleX',
        'scaleY',
        'angle',
        'originX',
        'originY',
        'selectable',
        'evented',
        'canvas',
        'zoom',
        'panX',
        'selectedLayerId',
        'objects',
        'version',
      ]) {
        expect(raw).not.toContain(`"${key}"`);
      }
      expect(raw).not.toMatch(/"type":"(rect|ellipse|activeselection|group)"/i);
    }
  );

  ui(
    '135 a save stores a new revision, leaves the edit and unmounts Fabric; the preview shows the saved box',
    async () => {
      await edit(SOLO.id);
      const canvas = fabric();
      await selectLayer('solo');
      await userMove(hitboxes()[0], 30, 20);
      await click(button('Save', toolbar()));
      expect(SOLO.revisions).toHaveLength(2);
      expect(canvas.disposed).toBe(true);
      expect(document.querySelector('canvas')).toBeNull();
      expect(
        screen.queryByRole('toolbar', { name: 'Design editor' })
      ).toBeNull();
      expect(previewLayer('solo')?.style.left).toBe('130px');
      expect(previewPage().style.transform).toMatch(/^scale\(/);
    }
  );

  ui(
    '134/62 Cancel after a canvas change asks, then shows the saved box; no canvas state survives',
    async () => {
      await edit(SOLO.id);
      const canvas = fabric();
      await selectLayer('solo');
      await userMove(hitboxes()[0], 30, 20);
      await click(button('Cancel', toolbar()));
      expect(mockConfirm).toHaveBeenCalledTimes(1);
      expect(canvas.disposed).toBe(true);
      expect(previewLayer('solo')?.style.left).toBe('100px');
      expect(saves()).toHaveLength(0);
      await click(button('Edit design'));
      expect(canvases()).toHaveLength(2);
      expect(hitboxes()[0]).toMatchObject({ left: 200, top: 150 });
      expect(undoOff()).toBe(true);
    }
  );

  ui(
    '136/65 a conflict keeps the local geometry on the canvas, with no retry',
    async () => {
      await edit(SOLO.id);
      await selectLayer('solo');
      await userMove(hitboxes()[0], 30, 20);
      // someone else saved meanwhile
      SOLO.revisions = [...SOLO.revisions, revision(2, SOLO_DOC())];
      await click(button('Save', toolbar()));
      expect(
        screen.getByText('This design changed while you were editing.')
      ).toBeTruthy();
      expect(saves()).toHaveLength(1);
      expect(hitboxes()[0]).toMatchObject({ left: 230, top: 170 });
      expect(field('X').value).toBe('130');
      await click(button('Keep editing'));
      await userMove(hitboxes()[0], 10, 0);
      expect(field('X').value).toBe('140');
      expect(saveOff()).toBe(true);
      expect(saves()).toHaveLength(1);
    }
  );

  ui(
    '63/M34 Save, Cancel, Undo and Redo wait while a gesture is in progress',
    async () => {
      await edit(SOLO.id);
      await selectLayer('solo');
      await userMove(hitboxes()[0], 30, 20);
      await userMove(hitboxes()[0], 30, 20);
      await click(button('Undo', toolbar()));
      // a changed draft with a redo step: only the gesture holds the buttons
      expect([saveOff(), undoOff(), redoOff()]).toEqual([false, false, false]);
      const g = gesture(hitboxes()[0]);
      g.scale(1.5, 1);
      await flush();
      expect(saveOff()).toBe(true);
      expect(undoOff()).toBe(true);
      expect(redoOff()).toBe(true);
      expect(isOff(button('Cancel', toolbar()))).toBe(true);
      await g.end();
      expect(saveOff()).toBe(false);
      expect(isOff(button('Cancel', toolbar()))).toBe(false);
    }
  );
});

// ============================================================================
describe('Direct canvas: static Fabric boundaries', () => {
  const ROOT = join(__dirname, '../../../../..');
  const dir = __dirname;
  const P409 = [
    'content-studio.design.geometry.ts',
    'content-studio.design.fabric.ts',
    'content-studio.design.canvas.tsx',
  ];
  const code = (text: string) =>
    text
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
  const source = (file: string) => code(readFileSync(join(dir, file), 'utf8'));
  const walk = (folder: string): string[] =>
    readdirSync(folder).flatMap((entry) => {
      const full = join(folder, entry);
      if (entry === 'node_modules' || entry === 'dist' || entry === '.next') {
        return [];
      }
      return statSync(full).isDirectory()
        ? walk(full)
        : /\.tsx?$/.test(entry) && !/\.spec\.tsx?$/.test(entry)
        ? [full]
        : [];
    });
  const FABRIC_IMPORT =
    /from 'fabric(\/[^']*)?'|require\('fabric|import\('fabric/;

  it('P409-1/P409-2/110 Fabric is imported by its adapter only, a frontend file, pinned exactly', () => {
    const users = [
      ...walk(join(ROOT, 'apps')),
      ...walk(join(ROOT, 'libraries')),
    ]
      .filter((file) => FABRIC_IMPORT.test(code(readFileSync(file, 'utf8'))))
      .map((file) => file.slice(ROOT.length + 1));
    expect(users).toEqual([
      'apps/frontend/src/components/content-studio/content-studio.design.fabric.ts',
    ]);
    expect(source('content-studio.design.fabric.ts')).toContain(
      "import { Canvas, Ellipse, FabricObject, Rect } from 'fabric';"
    );
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.dependencies.fabric).toBe('6.9.1');
    expect(pkg.devDependencies?.fabric).toBeUndefined();
  });

  it('45/P409-1 the adapter is loaded on demand by the canvas component only', () => {
    const users = walk(join(ROOT, 'apps/frontend/src'))
      .filter((file) =>
        code(readFileSync(file, 'utf8')).includes(
          'content-studio.design.fabric'
        )
      )
      .map((file) => file.slice(dir.length + 1));
    expect(users).toEqual(['content-studio.design.canvas.tsx']);
    const canvas = source('content-studio.design.canvas.tsx');
    expect(canvas).toMatch(
      /import\(\s*'@gitroom\/frontend\/components\/content-studio\/content-studio\.design\.fabric'\s*\)/
    );
    // its only static mention is erased by the compiler
    expect(
      canvas.match(/^import[^;]*content-studio\.design\.fabric';/gm)
    ).toEqual([expect.stringMatching(/^import type \{/)]);
    expect(source('content-studio.design.geometry.ts')).not.toMatch(
      /fabric|from 'react'|document\.|window\.|useFetch|fetch\(/i
    );
  });

  it('P409-3/P409-4/P409-5/111/M23/M24 no Fabric serialization, and the save body is the P4-08 one', () => {
    for (const file of [...P409, 'content-studio.design.workspace.tsx']) {
      expect([file, source(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /toJSON|toObject|toDatalessJSON|toDatalessObject|loadFromJSON|enlivenObjects|fromObject|toSVG|toDataURL|JSON\.stringify|JSON\.parse|fabricJson|canvasJson/
        ),
      ]);
    }
    const api = source('content-studio.designs.api.ts');
    expect(api.match(/JSON\.stringify\(\{[^}]*\}\)/g)).toContain(
      'JSON.stringify({ baseRevisionNumber, content })'
    );
    expect(api).not.toMatch(/fabric|zoom|viewport|scaleX|originX|panX/i);
  });

  it('P409-6/M25/M26 no browser storage, timer persistence or editor state in the document helpers', () => {
    for (const file of P409) {
      expect([file, source(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /localStorage|sessionStorage|indexedDB|document\.cookie|setInterval|setTimeout|beforeunload|console\.|process\.env/
        ),
      ]);
    }
    const editor = source('content-studio.design.editor.ts');
    expect(editor).not.toMatch(/zoom|viewport|pan[XY]|selected|guide|fabric/i);
  });

  it('P409-7/P409-8/M27/M28 no Fabric text, image, path, URL or font loading', () => {
    for (const file of P409) {
      expect([file, source(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /Textbox|IText|FabricText|FabricImage|\bImage\b|fromURL|loadSVG|Path\b|FontFace|@font-face|\bfetch\(|XMLHttpRequest|src:|innerHTML|dangerouslySetInnerHTML/
        ),
      ]);
    }
  });

  it('P409-9/M15 single selection only: no group, no active selection, selection off', () => {
    const adapter = source('content-studio.design.fabric.ts');
    expect(adapter).toContain('selection: false,');
    for (const file of P409) {
      expect([file, source(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /ActiveSelection|\bGroup\b|selection: true|multiSelect/
        ),
      ]);
    }
  });

  it('P409-10/P409-11/P409-12 no backend, schema, AI, template, node canvas or browser automation in this slice', () => {
    for (const file of P409) {
      expect([file, source(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /from '(canvas|@napi-rs\/canvas|jsdom|playwright|puppeteer|sharp|fontkit|@nestjs\/[^']*|@prisma\/client)'|\/ai\/|template|generate|nestjs-libraries\/database/i
        ),
      ]);
    }
    const backend = walk(join(ROOT, 'apps/backend/src'))
      .concat(walk(join(ROOT, 'libraries/nestjs-libraries/src')))
      .filter((file) =>
        /fabric|content-studio\.design\.(canvas|geometry)/.test(
          code(readFileSync(file, 'utf8'))
        )
      );
    expect(backend).toEqual([]);
    const schema = readFileSync(
      join(
        ROOT,
        'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
      ),
      'utf8'
    );
    expect(schema).not.toMatch(/fabric|viewport|zoom/i);
    // Fabric's optional Node dependencies are the ones already locked
    const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
    const entry = lock.match(
      /\n {2}fabric@6\.9\.1\(bufferutil@4\.1\.0\)\(utf-8-validate@5\.0\.10\):\n([\s\S]*?)\n\n/
    );
    expect(entry?.[1]).toContain('canvas: 2.11.2');
    expect(entry?.[1]).toContain(
      'jsdom: 20.0.3(bufferutil@4.1.0)(canvas@2.11.2)(utf-8-validate@5.0.10)'
    );
    expect(lock.match(/\n {2}canvas@[^:]+:/g)).toEqual([
      '\n  canvas@2.11.2:',
      '\n  canvas@2.11.2:',
    ]);
  });
});
