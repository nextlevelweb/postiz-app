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

// Creative Studio editor ergonomics (P4-10): keyboard nudging and shortcuts,
// the in-memory layer clipboard, multi-selection for alignment and
// distribution, snap and guide switches, zoom keys, layer-row quick actions,
// page thumbnails and focal point presets. A .spec.ts without JSX, like the
// other Content Studio frontend specs: components are required, not
// imported. jsdom has no canvas, so Fabric is the same small stand-in as in
// content-studio.design.canvas.spec
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
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock('@gitroom/frontend/components/layout/new-modal', () => ({
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
const SECRET = 'DESIGN_ERGONOMICS_SERVER_SECRET_123';
const HTML_MARKER = 'DESIGN_ERGONOMICS_HTML_MARKER_456';

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const T0 = '2026-10-10T10:00:00.000Z';
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const BRAND_KIT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const BRAND_REV = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const BRAND_CONTENT = {
  schemaVersion: 1,
  identity: { brandName: 'Acme', tagline: '', description: '' },
  colors: [{ id: 'accent', name: 'Accent', value: '#e4572e', role: 'custom' }],
  typography: [],
  visualDirection: { keywords: [], dos: [], donts: [] },
};
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
    cornerRadius: 0,
    ...extra,
  });
const text = (id: string, geometry: Plain) =>
  layerBase(id, geometry, {
    type: 'text',
    text: `  Keep <i>${HTML_MARKER}</i>\n  spaces `,
    font: { type: 'family', family: 'Inter', weight: 400, style: 'normal' },
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
    focalPoint: { x: 0.25, y: 0.75 },
  });
const page = (
  id: string,
  name: string,
  layers: Plain[],
  width = 1080,
  height = 1080
) => ({
  id,
  name,
  width,
  height,
  background: { type: 'solid', color: lit('#ffffff') },
  layers,
});
const BRAND_REF = {
  brandKitId: BRAND_KIT_ID,
  revisionId: BRAND_REV,
  revisionNumber: 3,
  contentHash: SHA('3'),
};
// the order is the design's: first at the back
const MAIN_DOC = () => ({
  schemaVersion: 1,
  brandKit: BRAND_REF,
  pages: [
    page('p_one', 'One', [
      rect('a', { x: 100, y: 50, width: 200, height: 100 }),
      rect('b', { x: 400, y: 300, width: 100, height: 50, rotation: 45 }),
      rect('c', { x: 250, y: 600, width: 50, height: 200 }, { visible: false }),
      rect(
        'brandbox',
        { x: 700, y: 700, width: 100, height: 100 },
        { fill: { type: 'brand', tokenId: 'accent' } }
      ),
      text('title', { x: 50, y: 900, width: 500, height: 100 }),
      image('photo', { x: 800, y: 50, width: 200, height: 200 }),
    ]),
    page(
      'p_two',
      'Two',
      [rect('other', { x: 10, y: 10, width: 50, height: 50 })],
      1200,
      628
    ),
  ],
});
// the visible layers of page one, back to front, as the canvas has them
const VISIBLE = ['a', 'b', 'brandbox', 'title', 'photo'];

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
const meta = (r: Revision) => ({
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

const server = (method: string, url: string, body: any): Reply => {
  const { pathname } = new URL(url, 'https://api.test');
  if (
    method === 'GET' &&
    pathname === `/content-studio/brand-kit/revisions/${BRAND_REV}`
  ) {
    return reply(200, {
      id: BRAND_REV,
      revisionNumber: 3,
      schemaVersion: 1,
      contentHash: SHA('3'),
      createdAt: T0,
      content: BRAND_CONTENT,
    });
  }
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
      currentRevision: { ...meta(current), content: current.content },
    });
  }
  if (method === 'GET' && action === 'revisions' && !revisionId) {
    return reply(200, {
      pages: 1,
      results: [...found.revisions].reverse().map(meta),
    });
  }
  if (method === 'POST' && action === 'revisions') {
    const next = revision(found.revisions.length + 1, body.content);
    found.revisions = [...found.revisions, next];
    return reply(201, {
      created: true,
      revision: { ...meta(next), content: next.content },
    });
  }
  return reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
};

let storageSpies: jest.SpyInstance[];
let consoleSpies: jest.SpyInstance[];
const systemClipboard = {
  writeText: jest.fn(),
  readText: jest.fn(),
  write: jest.fn(),
  read: jest.fn(),
};

beforeEach(() => {
  counter = 0;
  mockFabric.canvases = [];
  mockFabric.created = [];
  mockFabric.sets = [];
  MAIN = design('Main', MAIN_DOC());
  designs = [MAIN];
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    return server(init.method || 'GET', url, body);
  });
  mockConfirm.mockReset();
  mockConfirm.mockResolvedValue(true);
  mockToast.mockReset();
  Object.values(systemClipboard).forEach((fn) => fn.mockReset());
  Object.defineProperty(navigator, 'clipboard', {
    value: systemClipboard,
    configurable: true,
  });
  storageSpies = [
    jest.spyOn(Storage.prototype, 'setItem'),
    jest.spyOn(Storage.prototype, 'getItem'),
  ];
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
    (level) => jest.spyOn(console, level)
  );
});

afterEach(async () => {
  // nothing of the editor is kept anywhere, and nothing is logged
  for (const spy of storageSpies) {
    expect(spy).not.toHaveBeenCalled();
  }
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled();
  }
  // KS8: the system clipboard is never touched
  for (const fn of Object.values(systemClipboard)) {
    expect(fn).not.toHaveBeenCalled();
  }
  for (const value of mockToast.mock.calls.map(([t]) => t as string)) {
    expect(value).not.toMatch(new RegExp(`${SECRET}|${HTML_MARKER}`));
  }
  expect(document.body.textContent).not.toMatch(new RegExp(SECRET));
  // markup in names and text is never turned into elements
  expect(document.querySelectorAll('script, b, i, [onerror]')).toHaveLength(0);
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
  const view = render(
    h(
      SWRConfig,
      { value: { provider: () => cache, dedupingInterval: 0 } },
      h(ContentStudioDesignWorkspace, { designId: id })
    )
  );
  await flush();
  return view;
};
const button = (name: string | RegExp, root: HTMLElement = document.body) =>
  within(root).getByRole('button', { name });
const queryButton = (name: string | RegExp) =>
  screen.queryByRole('button', { name });
const click = async (element: HTMLElement, init: Plain = {}) => {
  fireEvent.click(element, init);
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
const undo = () => click(button('Undo', toolbar()));
const heading = () =>
  screen
    .getAllByRole('heading', { level: 2 })
    .map((el) => el.textContent)
    .find((value) => /^Layer · |^Page \d|layers selected$/.test(value ?? ''));
const layerList = () => screen.getByRole('list', { name: 'Layers' });
const row = (id: string) =>
  within(layerList()).getByRole('button', { name: new RegExp(`^${id} `) });
const rows = () =>
  within(layerList())
    .getAllByRole('button')
    .filter((b) => b.hasAttribute('data-layer-row'));
// after the one-character type icon: the name, here "<id> <b>…</b>"
const rowIds = () =>
  rows().map((b) => (b.textContent ?? '').slice(1).split(' ')[0]);
const selectLayer = (id: string) => click(row(id));
// Ctrl/Cmd-click: one more layer for a command (or one less)
const toggleLayer = (id: string, meta = false) =>
  click(row(id), meta ? { metaKey: true } : { ctrlKey: true });
const pages = () =>
  within(screen.getByRole('list', { name: 'Pages' })).getAllByRole('button');
const selectPage = (n: number) =>
  click(
    within(screen.getByRole('list', { name: 'Pages' })).getByRole('button', {
      name: new RegExp(`^Select page ${n}\\b`),
    })
  );
const canvases = () => mockFabric.canvases;
const fabric = () => canvases()[canvases().length - 1];
const hitboxes = () => fabric().getObjects();
const hitbox = (id: string, order = VISIBLE) => hitboxes()[order.indexOf(id)];
const saves = () =>
  mockFetch.mock.calls.filter(
    ([url, init]) =>
      init?.method === 'POST' && String(url).endsWith('/revisions')
  );
const lastSaved = () => JSON.parse(saves()[saves().length - 1][1].body);
const save = () => click(button('Save', toolbar()));
const saved = async () => {
  await save();
  return lastSaved().content;
};
const savedLayer = (content: Plain, id: string) =>
  content.pages.flatMap((p: Plain) => p.layers).find((l: Plain) => l.id === id);
const zoomText = () => screen.getByLabelText('Zoom').textContent;
const guide = (axis: 'vertical' | 'horizontal') =>
  document.querySelector(`[data-guide="${axis}"]`) as HTMLElement | null;
// a key pressed with the page itself focused, unless a target is given
const key = async (
  value: string,
  init: Plain = {},
  target: Element = document.body
) => {
  const event = fireEvent.keyDown(target, { key: value, ...init });
  await flush();
  return event;
};
const fire = (name: string, event: Plain = {}) =>
  act(() => {
    fabric().fire(name, event);
  });
const gesture = (object: any) => ({
  move(dx: number, dy: number, altKey = false) {
    const start = { left: object.left, top: object.top };
    for (const share of [0.25, 0.5, 1]) {
      object.left = start.left + dx * share;
      object.top = start.top + dy * share;
      fire('object:moving', { target: object, e: { altKey } });
    }
  },
  async end() {
    fire('object:modified', { target: object, action: 'drag' });
    fire('mouse:up');
    await flush();
  },
});
const userMove = async (
  object: any,
  dx: number,
  dy: number,
  altKey = false
) => {
  const g = gesture(object);
  g.move(dx, dy, altKey);
  await g.end();
};
const thumbnails = () =>
  Array.from(
    document.querySelectorAll('[data-preview="thumbnail"]')
  ) as HTMLElement[];
const rgb = (hex: string) =>
  `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
const fitted = () =>
  fitContentStudioDesignCanvasView(
    { width: 1080, height: 1080 },
    { width: 640, height: 640 }
  );

const UI_TIMEOUT = 60_000;
const ui = (name: string, test: () => Promise<void>) =>
  it(name, test, UI_TIMEOUT);

// ============================================================================
describe('Editor ergonomics: keyboard nudging', () => {
  ui(
    'KN1/KN2/KN3/KN4/KN5/14 arrows move the layer by 1, with Shift by 10',
    async () => {
      let clock = 1_000_000;
      const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
      try {
        await edit();
        await selectLayer('a');
        await key('ArrowLeft');
        expect(field('X').value).toBe('99');
        clock += 1000;
        await key('ArrowRight');
        clock += 1000;
        await key('ArrowRight');
        expect(field('X').value).toBe('101');
        clock += 1000;
        await key('ArrowUp');
        expect(field('Y').value).toBe('49');
        clock += 1000;
        await key('ArrowDown', { shiftKey: true });
        expect(field('Y').value).toBe('59');
        clock += 1000;
        await key('ArrowLeft', { shiftKey: true });
        expect(field('X').value).toBe('91');
        expect(hitbox('a')).toMatchObject({ left: 191, top: 109 });
      } finally {
        now.mockRestore();
      }
    }
  );

  ui('KN6/12 a nudge past the coordinate limits changes nothing', async () => {
    await edit();
    await selectLayer('a');
    await commit(field('X'), '32768');
    await undo();
    await commit(field('X'), '32768');
    const steps = () => isOff(button('Undo', toolbar()));
    await key('ArrowRight');
    expect(field('X').value).toBe('32768');
    await undo();
    // one undo goes back to before the inspector change: the nudge added none
    expect(field('X').value).toBe('100');
    expect(steps()).toBe(true);
  });

  ui('KN7 a nudge never snaps', async () => {
    await edit();
    await selectLayer('a');
    // center 537 is 3 from the page center
    await commit(field('X'), '436');
    await key('ArrowRight');
    expect(field('X').value).toBe('437');
    expect(guide('vertical')).toBeNull();
  });

  ui(
    'KN8/13 a run of presses one way within 300 ms is one undo step',
    async () => {
      let clock = 5_000_000;
      const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
      try {
        await edit();
        await selectLayer('a');
        for (let i = 0; i < 5; i++) {
          clock += 100;
          await key('ArrowRight');
        }
        expect(field('X').value).toBe('105');
        // a pause, then the other direction: new steps
        clock += 400;
        await key('ArrowRight');
        clock += 50;
        await key('ArrowDown');
        expect([field('X').value, field('Y').value]).toEqual(['106', '51']);
        await undo();
        expect([field('X').value, field('Y').value]).toEqual(['106', '50']);
        await undo();
        expect(field('X').value).toBe('105');
        await undo();
        expect(field('X').value).toBe('100');
        expect(undoOff()).toBe(true);
      } finally {
        now.mockRestore();
      }
    }
  );

  ui(
    'KN9/70 no nudge or shortcut in a field; the field keeps its keys',
    async () => {
      await edit();
      await selectLayer('title');
      const area = screen.getByLabelText('Text');
      const arrow = await key('ArrowRight', {}, area);
      const copy = await key('c', { ctrlKey: true }, area);
      const dup = await key('d', { ctrlKey: true }, field('X'));
      expect([arrow, copy, dup]).toEqual([true, true, true]);
      expect(field('X').value).toBe('50');
      expect(rowIds()).toHaveLength(6);
      expect(mockToast).not.toHaveBeenCalled();
    }
  );

  ui(
    'KN10/68 no nudge during a canvas gesture, while saving or outside the editor',
    async () => {
      await edit();
      await selectLayer('a');
      const g = gesture(hitbox('a'));
      g.move(5, 0, true);
      await key('ArrowRight');
      await g.end();
      expect(field('X').value).toBe('105');
      // a button keeps its arrows; a layer row lets them nudge
      await key('ArrowRight', {}, button('Undo', toolbar()));
      expect(field('X').value).toBe('105');
      await key('ArrowRight', {}, row('a'));
      expect(field('X').value).toBe('106');
      // outside the editor (here: an element of the page that is no part of it)
      const outside = document.createElement('div');
      outside.tabIndex = 0;
      document.body.appendChild(outside);
      await key('ArrowRight', {}, outside);
      outside.remove();
      expect(field('X').value).toBe('106');
    }
  );

  ui('only one chosen layer is nudged: none for several', async () => {
    await edit();
    await selectLayer('a');
    await toggleLayer('b');
    const event = await key('ArrowRight');
    expect(event).toBe(true);
    expect(undoOff()).toBe(true);
  });
});

// ============================================================================
describe('Editor ergonomics: duplicate, copy and paste', () => {
  ui(
    'KS1/KS2/KS3/15/71 Ctrl/Cmd+D duplicates the chosen layer, selects it, one undo step',
    async () => {
      await edit();
      await selectLayer('b');
      const event = await key('d', { metaKey: true });
      expect(event).toBe(false);
      expect(rows().map((r) => r.getAttribute('data-selection'))).toEqual(
        [
          undefined,
          undefined,
          undefined,
          undefined,
          'primary',
          undefined,
          undefined,
        ].map((v) => v ?? null)
      );
      expect(hitboxes()).toHaveLength(VISIBLE.length + 1);
      expect(fabric().getActiveObject()).toBe(hitboxes()[2]);
      expect(field('X').value).toBe('420');
      await undo();
      expect(hitboxes()).toHaveLength(VISIBLE.length);
      expect(undoOff()).toBe(true);
    }
  );

  ui(
    'KS4 with no chosen layer Ctrl/Cmd+D keeps its browser meaning',
    async () => {
      await edit();
      const event = await key('d', { ctrlKey: true });
      expect(event).toBe(true);
      expect(undoOff()).toBe(true);
    }
  );

  ui(
    'KS5/KS6/KS8/16/17/18 Ctrl/Cmd+C keeps a copy in memory; Ctrl/Cmd+V pastes it under a new id, in front, selected',
    async () => {
      await edit();
      await selectLayer('photo');
      expect(await key('c', { ctrlKey: true })).toBe(false);
      expect(mockToast).toHaveBeenCalledWith('Layer copied.', 'success');
      // nothing changed by the copy
      expect(undoOff()).toBe(true);
      expect(await key('v', { ctrlKey: true })).toBe(false);
      expect(hitboxes()).toHaveLength(VISIBLE.length + 1);
      expect(fabric().getActiveObject()).toBe(hitboxes()[VISIBLE.length]);
      const content = await saved();
      const layers = content.pages[0].layers;
      const pasted = layers[layers.length - 1];
      expect(pasted.id).not.toBe('photo');
      expect(pasted.id).toMatch(/^l_[0-9a-f]{20}$/);
      expect(pasted).toEqual({
        ...MAIN_DOC().pages[0].layers[5],
        id: pasted.id,
        x: 820,
        y: 70,
      });
      // CP5/M9: the Media reference exactly, with no Media request
      expect(pasted.imageRef).toEqual({
        type: 'media',
        mediaId: 'photo-1',
        sha256: SHA('a'),
      });
      expect(
        mockFetch.mock.calls.filter(([url]) => /\/media/.test(String(url)))
      ).toEqual([]);
    }
  );

  ui(
    'KS7/19/M8 a copy from one page pastes on another page of the same design',
    async () => {
      await edit();
      await selectLayer('title');
      await click(button('Copy layer'));
      await selectPage(2);
      await click(button('Paste layer'));
      const content = await saved();
      expect(content.pages[0].layers.map((l: Plain) => l.id)).toEqual(
        MAIN_DOC().pages[0].layers.map((l) => l.id)
      );
      const [other, pasted] = content.pages[1].layers;
      expect(other.id).toBe('other');
      expect(pasted.text).toBe(`  Keep <i>${HTML_MARKER}</i>\n  spaces `);
      expect([pasted.x, pasted.y]).toEqual([70, 920]);
    }
  );

  ui(
    'KS9/60/61/M4 with several layers chosen there is no copy and no duplicate',
    async () => {
      await edit();
      await selectLayer('a');
      await toggleLayer('b');
      expect(await key('c', { ctrlKey: true })).toBe(true);
      expect(await key('d', { ctrlKey: true })).toBe(true);
      expect(isOff(button('Copy layer'))).toBe(true);
      expect(isOff(button('Paste layer'))).toBe(true);
      expect(mockToast).not.toHaveBeenCalled();
      expect(undoOff()).toBe(true);
    }
  );

  ui(
    'KS10/20/M10 a full page takes no paste: a fixed message, nothing changes',
    async () => {
      const full = MAIN_DOC();
      full.pages[1].layers = Array.from({ length: 200 }, (_, i) =>
        rect(`r${i}`, { x: i, y: 0, width: 10, height: 10 })
      );
      MAIN.revisions = [revision(1, full)];
      await edit();
      await selectLayer('a');
      await key('c', { ctrlKey: true });
      await selectPage(2);
      await key('v', { ctrlKey: true });
      expect(mockToast).toHaveBeenLastCalledWith(
        'This design has reached its layer limit.',
        'warning'
      );
      expect(undoOff()).toBe(true);
    }
  );

  ui(
    '19 the clipboard lives with the workspace: gone once it is left',
    async () => {
      const view = await edit();
      await selectLayer('a');
      await key('c', { ctrlKey: true });
      cleanup();
      await edit();
      expect(isOff(button('Paste layer'))).toBe(true);
      void view;
    }
  );
});

// ============================================================================
describe('Editor ergonomics: choosing several layers', () => {
  ui(
    'MS-UI1/MS-UI2/MS-UI3/58 a click chooses one; Ctrl/Cmd-click adds one, which becomes the primary',
    async () => {
      await edit();
      await selectLayer('a');
      await toggleLayer('b');
      await toggleLayer('brandbox', true);
      expect(heading()).toBe('3 layers selected');
      expect(
        rows()
          .filter((r) => r.getAttribute('aria-pressed') === 'true')
          .map((r) => r.getAttribute('data-selection'))
      ).toEqual(['primary', 'secondary', 'secondary']);
      // the primary is the last chosen: brandbox, with the canvas handles
      expect(fabric().getActiveObject()).toBe(hitbox('brandbox'));
      await selectLayer('title');
      expect(heading()).toBe(`Layer · title <b>${HTML_MARKER}</b>`);
      expect(
        rows().filter((r) => r.getAttribute('aria-pressed') === 'true')
      ).toHaveLength(1);
    }
  );

  ui(
    'MS-UI4 taking out the primary makes the last one left the primary; taking out all leaves none',
    async () => {
      await edit();
      await selectLayer('a');
      await toggleLayer('b');
      await toggleLayer('photo');
      await toggleLayer('photo');
      expect(heading()).toBe('2 layers selected');
      expect(fabric().getActiveObject()).toBe(hitbox('b'));
      await toggleLayer('b');
      expect(heading()).toBe(`Layer · a <b>${HTML_MARKER}</b>`);
      await toggleLayer('a');
      expect(heading()).toBe('Page 1 · One');
    }
  );

  ui(
    'MS-UI5/8/M18 another page clears the choice; there is no choice across pages',
    async () => {
      await edit();
      await selectLayer('a');
      await toggleLayer('b');
      await selectPage(2);
      expect(heading()).toBe('Page 2 · Two');
      // back on the first page, nothing is chosen any more
      await selectPage(1);
      expect(heading()).toBe('Page 1 · One');
      expect(
        rows().filter((r) => r.getAttribute('aria-pressed') === 'true')
      ).toHaveLength(0);
      // and a choice on another page holds only layers of that page
      await toggleLayer('a');
      await selectPage(2);
      await toggleLayer('other');
      expect(heading()).toBe(`Layer · other <b>${HTML_MARKER}</b>`);
    }
  );

  ui(
    'MS-UI6/MS-UI7/9/M16/M17 choosing changes nothing: no draft change, no undo step',
    async () => {
      await edit();
      await selectLayer('a');
      await toggleLayer('b');
      await toggleLayer('c');
      await toggleLayer('b');
      expect(saveOff()).toBe(true);
      expect(undoOff()).toBe(true);
    }
  );

  ui(
    'MS-UI8/10 several layers: "N layers selected" and commands, no field editing',
    async () => {
      await edit();
      await selectLayer('a');
      await toggleLayer('b');
      expect(heading()).toBe('2 layers selected');
      expect(screen.queryByLabelText('X')).toBeNull();
      expect(queryButton('Delete layer')).toBeNull();
      expect(button('Align selection left')).toBeTruthy();
    }
  );

  ui(
    'MS-UI9/MS-UI10/M19/M20 the canvas keeps one active layer: a drag moves the primary only',
    async () => {
      await edit();
      await selectLayer('a');
      await toggleLayer('b');
      expect(fabric().options.selection).toBe(false);
      const active = fabric().getActiveObject();
      expect(active).toBe(hitbox('b'));
      expect(Array.isArray(active)).toBe(false);
      await userMove(active, 10, 0, true);
      const content = await saved();
      expect(savedLayer(content, 'b').x).toBe(410);
      expect(savedLayer(content, 'a').x).toBe(100);
    }
  );
});

// ============================================================================
describe('Editor ergonomics: alignment and distribution', () => {
  ui(
    'AL-UI1/24/56 one layer: Align to page, six commands; no selection or distribution commands',
    async () => {
      await edit();
      await selectLayer('a');
      const group = screen.getByRole('group', { name: 'Align to page' });
      expect(
        within(group)
          .getAllByRole('button')
          .map((b) => b.getAttribute('aria-label'))
      ).toEqual([
        'Align to page left',
        'Align to page horizontal center',
        'Align to page right',
        'Align to page top',
        'Align to page vertical center',
        'Align to page bottom',
      ]);
      expect(
        screen.queryByRole('group', { name: 'Align selection' })
      ).toBeNull();
      await click(button('Align to page horizontal center'));
      expect(field('X').value).toBe('440');
      await click(button('Align to page bottom'));
      expect(field('Y').value).toBe('980');
    }
  );

  ui('AL-UI2/AL-UI3 two layers: Align selection, no distribution', async () => {
    await edit();
    await selectLayer('a');
    await toggleLayer('b');
    expect(screen.getByRole('group', { name: 'Align selection' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Align to page' })).toBeNull();
    expect(queryButton('Distribute horizontally')).toBeNull();
  });

  ui(
    'AL-UI4/AL-UI5/AL-UI6/AL-UI7/AL-UI8/26/67/M12 three layers: one command is one undo step for all, the primary stays, the canvas follows',
    async () => {
      await edit();
      await selectLayer('a');
      await toggleLayer('c');
      await toggleLayer('b');
      expect(button('Distribute horizontally')).toBeTruthy();
      expect(button('Distribute vertically')).toBeTruthy();
      // the box around a, b and c: left 100, right 500
      await click(button('Align selection right'));
      expect(heading()).toBe('3 layers selected');
      expect(fabric().getActiveObject()).toBe(hitbox('b'));
      expect(hitbox('a').left).toBe(400);
      expect(hitbox('b').left).toBe(450);
      await undo();
      expect(undoOff()).toBe(true);
      expect([hitbox('a').left, hitbox('b').left]).toEqual([200, 450]);
      await click(button('Redo', toolbar()));
      const content = await saved();
      expect(
        ['a', 'b', 'c'].map((id) => [
          savedLayer(content, id).x,
          savedLayer(content, id).rotation,
        ])
      ).toEqual([
        [300, 0],
        [400, 45],
        [450, 0],
      ]);
      // the hidden layer took part and stays hidden
      expect(savedLayer(content, 'c').visible).toBe(false);
    }
  );

  ui(
    '27/28 distribution keeps the outer layers and spaces the gaps',
    async () => {
      await edit();
      await selectLayer('a');
      await toggleLayer('b');
      await toggleLayer('brandbox');
      await click(button('Distribute horizontally'));
      const content = await saved();
      // a 100..300, brandbox 700..800, b between: span 700, boxes 400, gaps 150
      expect(
        ['a', 'b', 'brandbox'].map((id) => savedLayer(content, id).x)
      ).toEqual([100, 450, 700]);
    }
  );

  ui(
    '63 an alignment past the coordinate limits is refused as a whole, with a fixed message',
    async () => {
      const far = MAIN_DOC();
      far.pages[0].layers[0] = rect('a', {
        x: -32768,
        y: 0,
        width: 10,
        height: 10,
      });
      far.pages[0].layers[1] = rect('b', {
        x: 32000,
        y: 0,
        width: 32768,
        height: 10,
      });
      MAIN.revisions = [revision(1, far)];
      await edit();
      await selectLayer('a');
      await toggleLayer('b');
      await click(button('Align selection right'));
      expect(mockToast).toHaveBeenCalledWith(
        'That alignment is outside the design limits.',
        'warning'
      );
      expect(undoOff()).toBe(true);
    }
  );
});

// ============================================================================
describe('Editor ergonomics: snapping and guides', () => {
  const near = async () => {
    await selectLayer('a');
    // center 200 -> 537: 3 from the page center
    await userMove(hitbox('a'), 337, 0);
    return field('X').value;
  };

  ui('SG1/33 snapping and guides start on, as switches', async () => {
    await edit();
    const snap = screen.getByRole('switch', {
      name: 'Snap',
    }) as HTMLInputElement;
    const guides = screen.getByRole('switch', {
      name: 'Guides',
    }) as HTMLInputElement;
    expect([snap.checked, guides.checked]).toEqual([true, true]);
    expect(await near()).toBe('440');
  });

  ui(
    'SG2/SG3/34/M21 snap off: the move is exact and no guide shows',
    async () => {
      await edit();
      fireEvent.click(screen.getByRole('switch', { name: 'Snap' }));
      await flush();
      await selectLayer('a');
      const g = gesture(hitbox('a'));
      g.move(337, 0);
      await flush();
      expect(guide('vertical')).toBeNull();
      expect(guide('horizontal')).toBeNull();
      await g.end();
      expect(field('X').value).toBe('437');
    }
  );

  ui('SG4/35/M22 guides off: it still snaps, with no lines', async () => {
    await edit();
    fireEvent.click(screen.getByRole('switch', { name: 'Guides' }));
    await flush();
    await selectLayer('a');
    const g = gesture(hitbox('a'));
    g.move(337, 0);
    await flush();
    expect(guide('vertical')).toBeNull();
    await g.end();
    expect(field('X').value).toBe('440');
  });

  ui(
    'SG5/36/M23 Alt still moves freely with snapping on; guides show with both on',
    async () => {
      await edit();
      await selectLayer('a');
      const g = gesture(hitbox('a'));
      g.move(337, 0);
      await flush();
      expect(guide('vertical')).toBeTruthy();
      await g.end();
      await undo();
      await userMove(hitbox('a'), 337, 0, true);
      expect(field('X').value).toBe('437');
    }
  );

  ui(
    'SG6/SG7/SG8/37/M25 the switches change nothing in the draft and stay across pages',
    async () => {
      await edit();
      fireEvent.click(screen.getByRole('switch', { name: 'Snap' }));
      fireEvent.click(screen.getByRole('switch', { name: 'Guides' }));
      await flush();
      expect(saveOff()).toBe(true);
      expect(undoOff()).toBe(true);
      await selectPage(2);
      await selectPage(1);
      expect(
        (screen.getByRole('switch', { name: 'Snap' }) as HTMLInputElement)
          .checked
      ).toBe(false);
      expect(
        (screen.getByRole('switch', { name: 'Guides' }) as HTMLInputElement)
          .checked
      ).toBe(false);
    }
  );

  ui('SG9/M24 a new visit starts with both on again', async () => {
    await edit();
    fireEvent.click(screen.getByRole('switch', { name: 'Snap' }));
    await flush();
    cleanup();
    await edit();
    expect(
      (screen.getByRole('switch', { name: 'Snap' }) as HTMLInputElement).checked
    ).toBe(true);
  });
});

// ============================================================================
describe('Editor ergonomics: zoom keys', () => {
  ui(
    'ZK1/ZK2/ZK3/ZK4/ZK5/38 Ctrl/Cmd with +, - and 0 zoom and fit, changing nothing in the draft',
    async () => {
      await edit();
      expect(await key('=', { ctrlKey: true })).toBe(false);
      expect(zoomText()).toBe('75%');
      await key('+', { metaKey: true });
      expect(zoomText()).toBe('100%');
      expect(await key('-', { ctrlKey: true })).toBe(false);
      expect(zoomText()).toBe('75%');
      expect(button('Fit').getAttribute('aria-pressed')).toBe('false');
      expect(await key('0', { ctrlKey: true })).toBe(false);
      expect(zoomText()).toBe(`${Math.round(fitted().zoom * 100)}%`);
      expect(button('Fit').getAttribute('aria-pressed')).toBe('true');
      expect(fabric().matrix).toEqual([
        fitted().zoom,
        0,
        0,
        fitted().zoom,
        fitted().panX,
        fitted().panY,
      ]);
      expect(saveOff()).toBe(true);
      expect(undoOff()).toBe(true);
    }
  );

  ui(
    'ZK6/ZK7 a field, or a page without the editor, keeps the browser zoom',
    async () => {
      await renderWorkspace();
      expect(await key('=', { ctrlKey: true })).toBe(true);
      expect(await key('0', { ctrlKey: true })).toBe(true);
      await click(button('Edit design'));
      await selectLayer('a');
      expect(await key('=', { ctrlKey: true }, field('X'))).toBe(true);
      expect(zoomText()).toBe(`${Math.round(fitted().zoom * 100)}%`);
      const outside = document.createElement('div');
      document.body.appendChild(outside);
      expect(await key('=', { ctrlKey: true }, outside)).toBe(true);
      outside.remove();
      expect(zoomText()).toBe(`${Math.round(fitted().zoom * 100)}%`);
    }
  );
});

// ============================================================================
describe('Editor ergonomics: layer list', () => {
  ui(
    'LP1/LP2/LP3/LP4 front-most first; the primary and the others chosen are marked; hidden is shown',
    async () => {
      await edit();
      expect(rowIds()).toEqual(['photo', 'title', 'brandbox', 'c', 'b', 'a']);
      await selectLayer('a');
      await toggleLayer('c');
      expect(row('c').getAttribute('data-selection')).toBe('primary');
      expect(row('a').getAttribute('data-selection')).toBe('secondary');
      expect(row('c').className).toContain('bg-boxFocused');
      expect(row('a').className).toContain('border-dashed');
      expect(row('c').textContent).toContain('Hidden');
      expect(row('b').getAttribute('aria-pressed')).toBe('false');
    }
  );

  ui(
    'LP5/LP6/LP7/43 the visibility quick action shows and hides, one undo step, and leaves the selection',
    async () => {
      await edit();
      await selectLayer('b');
      await click(button(new RegExp(`^Hide layer a `)));
      expect(row('a').textContent).toContain('Hidden');
      expect(hitboxes()).toHaveLength(VISIBLE.length - 1);
      expect(heading()).toBe(`Layer · b <b>${HTML_MARKER}</b>`);
      expect(fabric().getActiveObject()).toBe(hitboxes()[0]);
      await click(button(new RegExp(`^Show layer c `)));
      expect(row('c').textContent).not.toContain('Hidden');
      await undo();
      await undo();
      expect(undoOff()).toBe(true);
      expect(hitboxes()).toHaveLength(VISIBLE.length);
    }
  );

  ui(
    'LP8 the duplicate quick action duplicates that layer and selects the copy',
    async () => {
      await edit();
      await selectLayer('a');
      await click(button(new RegExp(`^Duplicate layer title `)));
      expect(heading()).toBe(`Layer · title <b>${HTML_MARKER}</b>`);
      expect(field('X').value).toBe('70');
      expect(rowIds()).toHaveLength(7);
    }
  );

  ui(
    'LP9/46 no drag to reorder; read-only views have no quick actions',
    async () => {
      await renderWorkspace();
      expect(document.querySelectorAll('[draggable="true"]')).toHaveLength(0);
      expect(queryButton(/^Hide layer /)).toBeNull();
      await click(button('Edit design'));
      expect(document.querySelectorAll('[draggable="true"]')).toHaveLength(0);
    }
  );
});

// ============================================================================
describe('Editor ergonomics: page thumbnails', () => {
  ui(
    'PT1/PT2/PT3/PT4/51 one thumbnail per page, in page order; a card selects its page',
    async () => {
      await edit();
      expect(thumbnails()).toHaveLength(2);
      expect(pages().map((b) => b.getAttribute('aria-label'))).toEqual([
        'Select page 1 · One',
        'Select page 2 · Two',
      ]);
      expect(pages().map((b) => b.getAttribute('aria-pressed'))).toEqual([
        'true',
        'false',
      ]);
      expect(pages()[1].contains(thumbnails()[1])).toBe(true);
      await selectPage(2);
      expect(pages().map((b) => b.getAttribute('aria-pressed'))).toEqual([
        'false',
        'true',
      ]);
      expect(heading()).toBe('Page 2 · Two');
      // M28: after a move the order is the design's, never sorted
      await click(button('Move page up'));
      expect(pages().map((b) => b.getAttribute('aria-label'))).toEqual([
        'Select page 1 · Two',
        'Select page 2 · One',
      ]);
      expect(thumbnails()[0].style.width).toBe('1200px');
    }
  );

  ui(
    'PT5/PT8/PT9/PT10/47/49/76/77 the structural drawing, scaled: Brand colors, placeholders, no hidden layers, no marks, no URLs',
    async () => {
      await renderWorkspace();
      const [first, second] = thumbnails();
      const box = first.parentElement as HTMLElement;
      expect(box.getAttribute('aria-hidden')).toBe('true');
      expect(box.className).toContain('pointer-events-none');
      // 1080 square in 120 × 80; 1200 × 628 too
      expect(box.style.width).toBe(`${1080 * (80 / 1080)}px`);
      expect(first.style.transform).toBe(`scale(${80 / 1080})`);
      expect((second.parentElement as HTMLElement).style.width).toBe('120px');
      expect(first.querySelectorAll('[data-layer]')).toHaveLength(0);
      const fills = Array.from(first.children).map(
        (el) => (el as HTMLElement).style.backgroundColor
      );
      expect(fills).toContain(rgb('#e4572e'));
      expect(first.children).toHaveLength(5);
      expect(first.textContent).toContain('Image');
      expect(first.textContent).toContain(HTML_MARKER);
      expect(
        first.querySelectorAll('img, a, [src], [href], canvas')
      ).toHaveLength(0);
      expect(first.innerHTML).not.toMatch(/url\(|https?:|photo-1/);
    }
  );

  ui(
    'PT6/PT7/PT11/M26/M27/M29 thumbnails ask nothing of the server and get no Fabric canvas',
    async () => {
      await edit();
      await selectPage(2);
      await selectPage(1);
      const urls = mockFetch.mock.calls.map(([url]) => String(url));
      expect(
        urls.filter((url) => /render|\/media|thumbnail/.test(url))
      ).toEqual([]);
      expect(canvases()).toHaveLength(1);
      expect(document.querySelectorAll('canvas')).toHaveLength(1);
    }
  );

  ui('PT12/50 a design of 25 pages has 25 thumbnails', async () => {
    const many = MAIN_DOC();
    many.pages = Array.from({ length: 25 }, (_, i) =>
      page(`p_${i}`, `P${i}`, [
        rect(`r${i}`, { x: i, y: i, width: 10, height: 10 }),
      ])
    );
    MAIN.revisions = [revision(1, many)];
    await renderWorkspace();
    expect(thumbnails()).toHaveLength(25);
    expect(pages()[24].getAttribute('aria-label')).toBe('Select page 25 · P24');
  });
});

// ============================================================================
describe('Editor ergonomics: focal point presets', () => {
  ui(
    'FP1/FP2/FP3/FP4/FP5/FP6/54 five presets with exact values, each one undo step',
    async () => {
      await edit();
      await selectLayer('photo');
      const values: Array<[string, string, string]> = [
        ['Center', '0.5', '0.5'],
        ['Top', '0.5', '0'],
        ['Bottom', '0.5', '1'],
        ['Left', '0', '0.5'],
        ['Right', '1', '0.5'],
      ];
      for (const [name, x, y] of values) {
        await click(button(`Focal point ${name}`));
        expect([
          name,
          field('Focal point X').value,
          field('Focal point Y').value,
        ]).toEqual([name, x, y]);
      }
      for (let i = 0; i < values.length; i++) {
        await undo();
      }
      expect([
        field('Focal point X').value,
        field('Focal point Y').value,
      ]).toEqual(['0.25', '0.75']);
      expect(undoOff()).toBe(true);
    }
  );

  ui('FP7 only image layers have them', async () => {
    await edit();
    await selectLayer('a');
    expect(
      screen.queryByRole('group', { name: 'Focal point presets' })
    ).toBeNull();
  });
});

// ============================================================================
describe('Editor ergonomics: what is saved', () => {
  ui(
    '90/112/P410-12/M30/M31/M32/M33 after nudging, pasting, aligning, hiding, switching and zooming, Save sends exactly the Design Document',
    async () => {
      let clock = 9_000_000;
      const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
      try {
        await edit();
        await selectLayer('a');
        await toggleLayer('b');
        await toggleLayer('brandbox');
        await click(button('Align selection top'));
        await click(button(new RegExp(`^Hide layer title `)));
        await selectLayer('a');
        await key('ArrowRight', { shiftKey: true });
        clock += 1000;
        await key('c', { ctrlKey: true });
        await key('v', { ctrlKey: true });
        fireEvent.click(screen.getByRole('switch', { name: 'Snap' }));
        fireEvent.click(screen.getByRole('switch', { name: 'Guides' }));
        await key('=', { ctrlKey: true });
        fireEvent.mouseDown(
          document.querySelector('[data-canvas="viewport"]') as HTMLElement,
          { button: 1, clientX: 0, clientY: 0 }
        );
        fireEvent.mouseMove(window, { clientX: 40, clientY: 30 });
        fireEvent.mouseUp(window, {});
        await flush();
        await save();
      } finally {
        now.mockRestore();
      }
      // the draft is a valid Design Document v1: it was sent, once
      expect(saves()).toHaveLength(1);
      const body = lastSaved();
      expect(Object.keys(body).sort()).toEqual([
        'baseRevisionNumber',
        'content',
      ]);
      const content = body.content;
      expect(Object.keys(content).sort()).toEqual([
        'brandKit',
        'pages',
        'schemaVersion',
      ]);
      expect(content.brandKit).toEqual(BRAND_REF);
      for (const p of content.pages) {
        expect(Object.keys(p).sort()).toEqual(
          ['background', 'height', 'id', 'layers', 'name', 'width'].sort()
        );
      }
      const layers = content.pages[0].layers;
      expect(layers.map((l: Plain) => l.id).slice(0, 6)).toEqual(
        MAIN_DOC().pages[0].layers.map((l) => l.id)
      );
      expect(layers).toHaveLength(7);
      expect(savedLayer(content, 'a')).toMatchObject({ x: 110, y: 50 });
      expect(savedLayer(content, 'b')).toMatchObject({
        x: 400,
        y: 50,
        rotation: 45,
      });
      expect(savedLayer(content, 'brandbox')).toMatchObject({ y: 50 });
      expect(savedLayer(content, 'title').visible).toBe(false);
      expect(layers[6]).toMatchObject({ type: 'shape', x: 130, y: 70 });
      // every key in what is sent is a Design Document v1 key
      const keys = new Set<string>();
      JSON.parse(JSON.stringify(body), (k, v) => {
        keys.add(k);
        return v;
      });
      for (const word of [
        'selected',
        'selectedLayerId',
        'selectedLayerIds',
        'selection',
        'clipboard',
        'copy',
        'snap',
        'snapEnabled',
        'guides',
        'guidesEnabled',
        'zoom',
        'panX',
        'panY',
        'viewport',
        'thumbnail',
        'primary',
        'scaleX',
        'left',
        'top',
        'group',
      ]) {
        expect([word, keys.has(word)]).toEqual([word, false]);
      }
      expect(JSON.stringify(body)).not.toMatch(
        /clipboard|thumbnail|snap|guide/i
      );
    }
  );
});

// ============================================================================
describe('Editor ergonomics: static boundaries', () => {
  const ROOT = join(__dirname, '../../../../..');
  const dir = __dirname;
  const FILES = [
    'content-studio.design.editor.ts',
    'content-studio.design.editing.tsx',
    'content-studio.design.workspace.tsx',
    'content-studio.design.preview.tsx',
    'content-studio.design.canvas.tsx',
    'content-studio.design.fabric.ts',
    'content-studio.design.geometry.ts',
  ];
  const code = (text: string) =>
    text
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
  const source = (file: string) => code(readFileSync(join(dir, file), 'utf8'));

  it('P410-1/P410-3/93 the Content Studio API keeps exactly its routes (P4-09: 91; P4-11 adds the 11 template routes, P4-13 the 5 style preset routes, P5-01 the 6 review routes, P5-02 the 5 discussion routes)', () => {
    const controller = code(
      readFileSync(
        join(ROOT, 'apps/backend/src/api/routes/content-studio.controller.ts'),
        'utf8'
      )
    );
    expect(
      controller.match(/^\s*@(Get|Post|Put|Patch|Delete)\(/gm)
      // P6-01: one more, a design from a saved package revision; P6-02 one
      // more, a Design Creative AI suggestion; P8-01 one more, the pages a
      // feed source found
      // P8-02: one more, News Radar across feeds
      // P8-04A: one more, what changed in a source version
      // P8-04B1: one more, the organization's page changes
    ).toHaveLength(145);
    const api = source('content-studio.designs.api.ts');
    expect(api).not.toMatch(
      // (thumbnail is the Media list's own field, from P4-08)
      /clipboard|snapEnabled|guidesEnabled|distribute|nudge|layerIds/i
    );
  });

  it('P410-2/5 the schema and Design Document v1 gain nothing', () => {
    const schema = readFileSync(
      join(
        ROOT,
        'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
      ),
      'utf8'
    );
    expect(schema).not.toMatch(
      /clipboard|snapEnabled|guidesEnabled|selectedLayer|designThumbnail/i
    );
    const designDocument = readFileSync(
      join(
        ROOT,
        'libraries/nestjs-libraries/src/content-studio/design/design.document.ts'
      ),
      'utf8'
    );
    expect(designDocument).not.toMatch(
      /clipboard|thumbnail|snap|guide|selectedLayer|group/i
    );
  });

  it('P410-4/P410-5/P410-6/21/M6/M7 no Fabric JSON, system clipboard or browser storage', () => {
    for (const file of FILES) {
      expect([file, source(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /navigator\.clipboard|execCommand|ClipboardEvent|clipboardData|localStorage|sessionStorage|indexedDB|document\.cookie|toJSON|loadFromJSON|enlivenObjects|toDatalessJSON/
        ),
      ]);
    }
  });

  // P4-11 adds design templates (Save as template in the workspace, the
  // shared editor for template revisions); AI stays out
  it('P410-7 no AI', () => {
    for (const file of FILES) {
      expect([file, source(file)]).not.toEqual([
        file,
        expect.stringMatching(/\/ai\/|ai-writing|generate\(/i),
      ]);
    }
  });

  it('P410-8/P410-9/M26/M27 thumbnails are the structural preview: no request, Media URL or image', () => {
    const preview = source('content-studio.design.preview.tsx');
    expect(preview).not.toMatch(
      /useSWR|useFetch|fetch\(|useContentStudio|<img|src=|url\(|new Image|mediaId|sha256/
    );
    expect(preview).toContain('export const ContentStudioDesignPageThumbnail');
  });

  it('P410-10/P410-11/M19 no group, in the document or on the canvas; Fabric stays single-selection', () => {
    expect(source('content-studio.design.editor.ts')).not.toMatch(/group/i);
    const adapter = source('content-studio.design.fabric.ts');
    expect(adapter).toContain('selection: false,');
    for (const file of FILES) {
      expect([file, source(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /ActiveSelection|new Group|\bGroup\b|selection: true/
        ),
      ]);
    }
  });

  it('41/46/40 no wheel zoom, drag reorder or new pan gesture', () => {
    for (const file of FILES) {
      expect([file, source(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /onWheel|'wheel'|draggable|onDragStart|onDoubleClick|dblclick/
        ),
      ]);
    }
  });

  it('69 no delete, select-all, group or cut shortcut', () => {
    const workspace = source('content-studio.design.workspace.tsx');
    expect(workspace).not.toMatch(
      /'Delete'|'Backspace'|key === 'a'|key === 'g'|key === 'x'/
    );
  });
});
