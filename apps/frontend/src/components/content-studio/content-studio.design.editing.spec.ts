import React, {
  createElement as h,
  Fragment,
  ReactNode,
  useSyncExternalStore,
} from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { SWRConfig } from 'swr';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { TextEncoder as NodeTextEncoder } from 'util';
import { parseContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document';

// A .spec.ts without JSX, like the other Content Studio frontend specs:
// components are required, not imported, so the spec type check doesn't
// follow them; they are type checked with the frontend tsconfig.
// jsdom has no TextEncoder (every browser does): the Design Document parser
// counts UTF-8 bytes with it
if (typeof (globalThis as any).TextEncoder === 'undefined') {
  (globalThis as any).TextEncoder = NodeTextEncoder;
}

jest.mock('next/link', () => {
  const { createElement } = require('react');
  return {
    __esModule: true,
    default: ({ href, prefetch, children, ...rest }: any) =>
      createElement('a', { href, ...rest }, children),
  };
});
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  usePathname: () => '/content-studio',
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}));

// --- modals: a store and a host that renders them, close() removes one ---
type MockModal = {
  id: string;
  title?: string;
  children: ReactNode | ((close: () => void) => ReactNode);
};
const mockModals = {
  list: [] as MockModal[],
  listeners: new Set<() => void>(),
  set(list: MockModal[]) {
    this.list = list;
    this.listeners.forEach((listener) => listener());
  },
};
let modalId = 0;
const mockOpenModal = jest.fn();
jest.mock('@gitroom/frontend/components/layout/new-modal', () => ({
  useModalCloseGuard: () => undefined,
  useModals: () => ({
    openModal: mockOpenModal,
    closeAll: () => mockModals.set([]),
    closeById: jest.fn(),
    closeCurrent: jest.fn(),
  }),
}));
const ModalHost = () => {
  const list = useSyncExternalStore(
    (listener) => {
      mockModals.listeners.add(listener);
      return () => mockModals.listeners.delete(listener);
    },
    () => mockModals.list
  );
  return h(
    Fragment,
    null,
    list.map((modal) =>
      h(
        'div',
        { key: modal.id, role: 'dialog', 'aria-label': modal.title },
        typeof modal.children === 'function'
          ? modal.children(() =>
              mockModals.set(mockModals.list.filter((m) => m.id !== modal.id))
            )
          : modal.children
      )
    )
  );
};

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

// Direct canvas editing (P4-09) has its own spec: here the Fabric adapter is
// an inert stand-in, so jsdom never needs a real canvas
jest.mock('./content-studio.design.fabric', () => ({
  createContentStudioDesignFabric: () => ({
    sync: () => undefined,
    setView: () => undefined,
    dispose: () => undefined,
  }),
}));

const {
  ContentStudioDesignWorkspace,
} = require('./content-studio.design.workspace');

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
let override: (
  method: string,
  url: string,
  body: any
) => Reply | Promise<Reply> | undefined;

const calls = () =>
  mockFetch.mock.calls.map(([url, init]) => ({
    method: (init?.method as string) || 'GET',
    url: url as string,
    body: init?.body,
  }));
const gets = (prefix: string) =>
  calls().filter((c) => c.method === 'GET' && c.url.startsWith(prefix));
const writes = () => calls().filter((c) => c.method !== 'GET');
const toasts = () => mockToast.mock.calls.map(([text]) => text as string);
// the longer UI tests (P4-09: edit mode also mounts the canvas)
const LOOP_TIMEOUT = 60_000;

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

// --- markers: never shown as markup, logged or toasted ---
const SECRET = 'DESIGN_EDITOR_SERVER_SECRET_123';
const HTML_MARKER = 'DESIGN_EDITOR_HTML_MARKER_456';
const MEDIA_MARKER = 'DESIGN_EDITOR_MEDIA_PRIVATE_789';

const T0 = '2026-10-10T10:00:00.000Z';
const T1 = '2026-10-11T12:30:00.000Z';
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const BRAND_KIT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const REV_3 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const REV_7 = '3d6f0a8e-2b4c-4e1a-9f7d-5c8b2a6e4d10';
const REV_8 = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
type Plain = Record<string, any>;
const kit = (colors: Array<[string, string]>, typography: string[]) => ({
  schemaVersion: 1,
  identity: { brandName: 'Acme', tagline: '', description: '' },
  colors: colors.map(([id, value]) => ({
    id,
    name: `${id} <b>${HTML_MARKER}</b>`,
    value,
    role: 'custom',
  })),
  typography: typography.map((id) => ({
    id,
    name: `${id} style`,
    family: 'Poppins',
    weight: 700,
    style: 'normal',
    role: 'heading',
  })),
  visualDirection: { keywords: [], dos: [], donts: [] },
});
const BRAND = {
  [REV_3]: {
    number: 3,
    hash: SHA('3'),
    content: kit(
      [
        ['paper', '#faf7f2'],
        ['ink', '#1a1a1a'],
        ['accent', '#e4572e'],
      ],
      ['heading']
    ),
  },
  // lacks the accent color the main design uses
  [REV_7]: {
    number: 7,
    hash: SHA('7'),
    content: kit(
      [
        ['paper', '#ffffff'],
        ['ink', '#000000'],
      ],
      ['heading']
    ),
  },
  // every token, other values
  [REV_8]: {
    number: 8,
    hash: SHA('8'),
    content: kit(
      [
        ['paper', '#eeeeee'],
        ['ink', '#222222'],
        ['accent', '#00aa00'],
      ],
      ['heading']
    ),
  },
} as Record<string, { number: number; hash: string; content: Plain }>;
const brandRef = (id: string) => ({
  brandKitId: BRAND_KIT_ID,
  revisionId: id,
  revisionNumber: BRAND[id].number,
  contentHash: BRAND[id].hash,
});

const lit = (value: string) => ({ type: 'literal', value });
const tok = (tokenId: string) => ({ type: 'brand', tokenId });
const layerBase = (id: string, name: string, extra: Plain) => ({
  id,
  name,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  opacity: 1,
  visible: true,
  ...extra,
});
const rect = (id: string, name: string, extra: Plain = {}) =>
  layerBase(id, name, {
    type: 'shape',
    shape: 'rectangle',
    fill: lit('#ff0000'),
    cornerRadius: 0,
    ...extra,
  });
const textLayer = (id: string, name: string, text: string, extra = {}) =>
  layerBase(id, name, {
    type: 'text',
    text,
    font: { type: 'family', family: 'Inter', weight: 400, style: 'normal' },
    fontSize: 64,
    lineHeight: 1.25,
    letterSpacing: 2,
    color: lit('#111111'),
    align: 'center',
    verticalAlign: 'middle',
    overflow: 'clip',
    ...extra,
  });
const imageLayer = (id: string, name: string, extra: Plain = {}) =>
  layerBase(id, name, {
    type: 'image',
    imageRef: { type: 'media', mediaId: 'photo-1', sha256: SHA('a') },
    fit: 'cover',
    focalPoint: { x: 0.25, y: 0.75 },
    x: 50,
    y: 60,
    width: 400,
    height: 300,
    rotation: 15,
    opacity: 0.8,
    ...extra,
  });
const page = (
  id: string,
  name: string,
  layers: unknown[],
  extra: Plain = {}
) => ({
  id,
  name,
  width: 1080,
  height: 1080,
  background: { type: 'solid', color: lit('#ffffff') },
  layers,
  ...extra,
});
const doc = (pages: unknown[], brandKit: unknown = null) => ({
  schemaVersion: 1,
  brandKit,
  pages,
});
const BRANDED = () =>
  doc(
    [
      page(
        'p_intro',
        'Intro',
        [
          rect('accent-box', 'Accent box', { fill: tok('accent') }),
          textLayer('headline', 'Headline', 'Hello', {
            color: tok('ink'),
            font: tok('heading'),
          }),
        ],
        { background: { type: 'solid', color: tok('paper') } }
      ),
    ],
    brandRef(REV_3)
  );
const PLAIN = () =>
  doc([
    page('p_one', 'One', [
      rect('box', 'Box', { cornerRadius: 8 }),
      textLayer('title', 'Title', '  Keep  spaces\n'),
      imageLayer('photo', 'Photo'),
    ]),
    page('p_two', 'Two', [], { width: 1200, height: 628 }),
  ]);

type Revision = {
  id: string;
  revisionNumber: number;
  schemaVersion: number;
  contentHash: string;
  createdAt: string;
  content: any;
};
type Design = {
  id: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revisions: Revision[];
};
let designs: Design[];
let counter = 0;
const nextId = () =>
  `${String(++counter).padStart(8, '0')}-0000-4000-8000-000000000000`;
const revision = (revisionNumber: number, content: any): Revision => ({
  id: nextId(),
  revisionNumber,
  schemaVersion: 1,
  contentHash: SHA(String(revisionNumber)),
  createdAt: T0,
  content,
});
const design = (name: string, contents: any[], archived = false): Design => ({
  id: nextId(),
  name,
  archivedAt: archived ? T1 : null,
  createdAt: T0,
  updatedAt: T1,
  revisions: contents.map((content, index) => revision(index + 1, content)),
});
const summary = (d: Design) => ({
  id: d.id,
  name: d.name,
  latestRevisionNumber: d.revisions.length,
  archivedAt: d.archivedAt,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});
const meta = ({ content, ...rest }: Revision) => rest;
const latest = (d: Design) => d.revisions[d.revisions.length - 1];

let MAIN: Design; // active, Brand Kit revision 3, revisions 1 and 2
let SIMPLE: Design; // active, no Brand Kit, two pages
let OLD: Design; // archived
let brandMissing: boolean;
type MediaRow = {
  id: string;
  name: string | null;
  originalName: string | null;
  path: string;
  thumbnail: string | null;
  alt: string | null;
};
let library: MediaRow[];
let mediaRefs: Record<string, string>;

const server = (method: string, url: string, body: any): Reply => {
  const { pathname, searchParams } = new URL(url, 'https://api.test');
  if (method === 'GET' && pathname === '/media') {
    const pageNumber = Number(searchParams.get('page') || 1);
    return reply(200, {
      pages: 2,
      results:
        pageNumber === 1
          ? library
          : [
              {
                id: 'page-two',
                name: 'p2.png',
                originalName: 'Second page.png',
                path: 'https://cdn.test/p2.png',
                thumbnail: null,
                alt: null,
              },
            ],
    });
  }
  const mediaRef = pathname.match(
    /^\/content-studio\/media\/([^/]+)\/design-ref$/
  );
  if (method === 'GET' && mediaRef) {
    const id = decodeURIComponent(mediaRef[1]);
    if (id === 'unusable') {
      return reply(409, {
        msg: `${SECRET} ${MEDIA_MARKER}`,
        code: 'CS_DESIGN_MEDIA_UNAVAILABLE',
      });
    }
    if (id === 'broken') {
      return reply(500, {
        msg: `${SECRET} /srv/${MEDIA_MARKER}`,
        code: 'CS_DESIGN_MEDIA_READ_FAILED',
      });
    }
    return mediaRefs[id]
      ? reply(200, { mediaId: id, sha256: mediaRefs[id] })
      : reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
  }
  if (method === 'GET' && pathname === '/content-studio/brand-kit') {
    return reply(200, {
      latestRevisionNumber: 8,
      currentRevision: {
        id: REV_8,
        revisionNumber: 8,
        schemaVersion: 1,
        contentHash: BRAND[REV_8].hash,
        createdAt: T1,
        content: BRAND[REV_8].content,
      },
    });
  }
  if (method === 'GET' && pathname === '/content-studio/brand-kit/revisions') {
    return reply(200, {
      pages: 1,
      results: [REV_8, REV_7, REV_3].map((id) => ({
        id,
        revisionNumber: BRAND[id].number,
        schemaVersion: 1,
        contentHash: BRAND[id].hash,
        createdAt: T0,
      })),
    });
  }
  const brandMatch = pathname.match(
    /^\/content-studio\/brand-kit\/revisions\/([^/]+)(\/design-ref)?$/
  );
  if (method === 'GET' && brandMatch) {
    const one = BRAND[brandMatch[1]];
    if (!one || (brandMissing && brandMatch[1] === REV_3)) {
      return reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
    }
    return brandMatch[2]
      ? reply(200, brandRef(brandMatch[1]))
      : reply(200, {
          id: brandMatch[1],
          revisionNumber: one.number,
          schemaVersion: 1,
          contentHash: one.hash,
          createdAt: T0,
          content: one.content,
        });
  }
  const base = '/content-studio/designs';
  const match = pathname
    .slice(base.length)
    .match(
      /^\/([^/]+)(?:\/(revisions|archive|restore|render|render-all)(?:\/([^/]+))?)?$/
    );
  const found = match && designs.find((d) => d.id === match[1]);
  if (!pathname.startsWith(base) || !found) {
    if (method === 'GET' && pathname === base) {
      return reply(200, { pages: 1, results: designs.map(summary) });
    }
    return reply(404, { msg: 'Design not found.', code: 'CS_NOT_FOUND' });
  }
  const [, , action, revisionId] = match as RegExpMatchArray;
  if (method === 'GET' && !action) {
    return reply(200, {
      ...summary(found),
      currentRevision: {
        ...meta(latest(found)),
        content: latest(found).content,
      },
    });
  }
  if (method === 'POST' && action === 'archive') {
    found.archivedAt = T1;
    return reply(200, summary(found));
  }
  if (method === 'GET' && action === 'revisions' && !revisionId) {
    return reply(200, {
      pages: 1,
      results: [...found.revisions].reverse().map(meta),
    });
  }
  if (method === 'GET' && action === 'revisions' && revisionId) {
    const one = found.revisions.find((r) => r.id === revisionId);
    return one
      ? reply(200, one)
      : reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
  }
  if (method === 'POST' && action === 'revisions') {
    if (found.archivedAt) {
      return reply(409, { msg: SECRET, code: 'CS_DESIGN_ARCHIVED' });
    }
    if (body.baseRevisionNumber !== found.revisions.length) {
      return reply(409, {
        msg: `${SECRET} The design changed.`,
        code: 'CS_DESIGN_REVISION_CONFLICT',
        currentRevisionNumber: found.revisions.length,
      });
    }
    const current = latest(found);
    if (JSON.stringify(current.content) === JSON.stringify(body.content)) {
      return reply(200, { created: false, revision: current });
    }
    const next = revision(found.revisions.length + 1, body.content);
    found.revisions = [...found.revisions, next];
    return reply(201, { created: true, revision: next });
  }
  return reply(404, { msg: 'no route', code: 'CS_NOT_FOUND' });
};

let storageSpies: jest.SpyInstance[];
let consoleSpies: jest.SpyInstance[];

beforeEach(() => {
  mockModals.set([]);
  counter = 0;
  brandMissing = false;
  MAIN = design(`Launch <b>${HTML_MARKER}</b>`, [BRANDED(), BRANDED()]);
  SIMPLE = design('Simple', [PLAIN()]);
  OLD = design('Old', [PLAIN()], true);
  designs = [MAIN, SIMPLE, OLD];
  library = [
    {
      id: 'img-png',
      name: 'a.png',
      originalName: `Hero <img src=x onerror=alert(1)> ${HTML_MARKER}.png`,
      path: `https://cdn.test/${MEDIA_MARKER}/a.png`,
      thumbnail: null,
      alt: null,
    },
    {
      id: 'img-jpg',
      name: 'b.jpg',
      originalName: 'Team.jpg',
      path: 'https://cdn.test/b.jpg',
      thumbnail: 'https://cdn.test/b-thumb.jpg',
      alt: 'team',
    },
    {
      id: 'clip',
      name: 'c.mp4',
      originalName: 'Clip.mp4',
      path: 'https://cdn.test/c.mp4',
      thumbnail: null,
      alt: null,
    },
    {
      id: 'anim',
      name: 'd.gif',
      originalName: 'Anim.gif',
      path: 'https://cdn.test/d.gif',
      thumbnail: null,
      alt: null,
    },
    {
      id: 'unusable',
      name: 'e.png',
      originalName: 'Unusable.png',
      path: 'https://cdn.test/e.png',
      thumbnail: null,
      alt: null,
    },
    {
      id: 'broken',
      name: 'f.webp',
      originalName: 'Broken.webp',
      path: 'https://cdn.test/f.webp',
      thumbnail: null,
      alt: null,
    },
  ];
  mediaRefs = {
    'img-png': SHA('b'),
    'img-jpg': SHA('d'),
    'page-two': SHA('e'),
  };
  override = () => undefined;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    const method = init.method || 'GET';
    const custom = await override(method, url, body);
    return custom ?? server(method, url, body);
  });
  mockOpenModal.mockImplementation((params: Omit<MockModal, 'id'>) =>
    mockModals.set([
      ...mockModals.list,
      { ...params, id: `modal-${++modalId}` },
    ])
  );
  mockConfirm.mockReset();
  mockConfirm.mockResolvedValue(true);
  mockToast.mockReset();
  mockPush.mockReset();
  storageSpies = [
    jest.spyOn(Storage.prototype, 'setItem'),
    jest.spyOn(Storage.prototype, 'getItem'),
  ];
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
    (level) => jest.spyOn(console, level)
  );
});

afterEach(async () => {
  // a draft is never kept in the browser, and nothing is logged
  for (const spy of storageSpies) {
    expect(spy).not.toHaveBeenCalled();
  }
  for (const spy of consoleSpies) {
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(
      new RegExp(`${SECRET}|${HTML_MARKER}|${MEDIA_MARKER}`)
    );
  }
  for (const text of toasts()) {
    expect(text).not.toMatch(
      new RegExp(`${SECRET}|${HTML_MARKER}|${MEDIA_MARKER}|https?:\\/\\/`)
    );
  }
  expect(document.body.textContent).not.toMatch(
    new RegExp(`${SECRET}|${MEDIA_MARKER}`)
  );
  // markup in names and text is never turned into elements
  expect(document.querySelectorAll('script, b, [onerror]')).toHaveLength(0);
  cleanup();
  [...storageSpies, ...consoleSpies].forEach((spy) => spy.mockRestore());
});

let swrCache: Map<string, unknown>;
const renderWorkspace = async (id = MAIN.id) => {
  swrCache = new Map();
  const view = render(
    h(
      SWRConfig,
      { value: { provider: () => swrCache, dedupingInterval: 0 } },
      h(ModalHost),
      h(ContentStudioDesignWorkspace, { designId: id })
    )
  );
  await flush();
  return view;
};

const button = (name: string | RegExp, root: HTMLElement = document.body) =>
  within(root).getByRole('button', { name });
const queryButton = (
  name: string | RegExp,
  root: HTMLElement = document.body
) => within(root).queryByRole('button', { name });
const field = (name: string | RegExp, root: HTMLElement = document.body) =>
  within(root).getByLabelText(name) as HTMLInputElement;
const click = async (element: HTMLElement) => {
  fireEvent.click(element);
  await flush();
};
// a field's value enters the draft when it is left
const commit = async (element: HTMLElement, value: string) => {
  fireEvent.change(element, { target: { value } });
  fireEvent.blur(element);
  await flush();
};
const choose = async (element: HTMLElement, value: string) => {
  fireEvent.change(element, { target: { value } });
  await flush();
};
const deferred = () => {
  let resolve!: (value: Reply) => void;
  const promise = new Promise<Reply>((r) => (resolve = r));
  return { promise, resolve };
};
const designPath = (d: Design) => `/content-studio/designs/${d.id}`;
const saves = () =>
  writes().filter((c) => c.method === 'POST' && c.url.endsWith('/revisions'));
const bodyOf = (call: { body?: unknown }) => JSON.parse(call.body as string);
const toolbar = () => screen.getByRole('toolbar', { name: 'Design editor' });
const isOff = (element: HTMLElement) =>
  (element as HTMLButtonElement).disabled ||
  element.className.includes('opacity-50');
// P4-10: layer rows have quick actions beside them, and a page card is
// named "Select page N · name" and shows a thumbnail
const layerNames = () =>
  within(screen.getByRole('list', { name: 'Layers' }))
    .queryAllByRole('button')
    .filter((b) => b.hasAttribute('data-layer-row'))
    .map((b) => b.textContent);
const pageNames = () =>
  within(screen.getByRole('list', { name: 'Pages' }))
    .getAllByRole('button')
    .map((b) => b.querySelector('[data-page-label]')?.textContent);
const selectLayer = async (name: RegExp) =>
  click(
    within(screen.getByRole('list', { name: 'Layers' })).getByRole('button', {
      // the row, not its quick actions ("Hide layer …", "Duplicate layer …")
      name: new RegExp(`^${name.source}`),
    })
  );
const selectPage = async (name: RegExp) =>
  click(
    within(screen.getByRole('list', { name: 'Pages' })).getByRole('button', {
      name: new RegExp(name.source, 'i'),
    })
  );
const previewLayer = (id: string) =>
  document.querySelector(`[data-layer="${id}"]`) as HTMLElement | null;
const previewPage = () =>
  document.querySelector('[data-preview="page"]') as HTMLElement;
const header = () =>
  (screen.getByRole('heading', { level: 1 }).nextElementSibling as HTMLElement)
    .textContent;
const edit = async (id = SIMPLE.id) => {
  await renderWorkspace(id);
  await click(button('Edit design'));
};
const save = async () => click(button('Save', toolbar()));
const lastSaved = () => bodyOf(saves()[saves().length - 1]).content;
const failWith = (status: number, code: string) =>
  reply(status, { msg: `${SECRET} ${HTML_MARKER}`, code });
const dialog = (title: string) => screen.getByRole('dialog', { name: title });
const rgb = (hex: string) =>
  `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

// ============================================================================
describe('Creative Studio editing: edit mode', () => {
  it('EM1/116 the current revision of an active design offers Edit design; nothing is editable before it', async () => {
    await renderWorkspace(SIMPLE.id);
    expect(button('Edit design')).toBeTruthy();
    expect(screen.queryByRole('toolbar', { name: 'Design editor' })).toBeNull();
    expect(document.querySelectorAll('input, textarea, select')).toHaveLength(
      0
    );
  });

  it('EM2/M5 an opened older revision has no edit control', async () => {
    await renderWorkspace(MAIN.id);
    await click(button('View Revision 1'));
    expect(queryButton('Edit design')).toBeNull();
    expect(screen.queryByRole('toolbar', { name: 'Design editor' })).toBeNull();
  });

  it('EM3/M6 an archived design has no edit control and stays renderable', async () => {
    await renderWorkspace(OLD.id);
    expect(queryButton('Edit design')).toBeNull();
    expect(isOff(button('Render page'))).toBe(false);
  });

  it('102 a pinned Brand Kit revision that cannot be loaded blocks editing, not rendering', async () => {
    brandMissing = true;
    await renderWorkspace(MAIN.id);
    expect(isOff(button('Edit design'))).toBe(true);
    expect(
      screen.getByText(
        'The pinned Brand Kit revision must be available before this design can be edited.'
      )
    ).toBeTruthy();
    expect(isOff(button('Render page'))).toBe(false);
  });

  it(
    'EM4/EM5/EM6/EM7 editing works on a copy, with Save, Cancel, Undo and Redo; render and rename wait',
    async () => {
      const before = JSON.stringify(latest(SIMPLE).content);
      await edit();
      for (const name of ['Save', 'Cancel', 'Undo', 'Redo']) {
        expect(button(name, toolbar())).toBeTruthy();
      }
      expect(isOff(button('Save', toolbar()))).toBe(true);
      expect(isOff(button('Undo', toolbar()))).toBe(true);
      expect(isOff(button('Render page'))).toBe(true);
      expect(isOff(button('Render all pages'))).toBe(true);
      expect(
        screen.getByText('Save or cancel your changes before rendering.')
      ).toBeTruthy();
      expect(isOff(button('Rename Simple'))).toBe(true);
      await click(button('Add rectangle'));
      expect(JSON.stringify(latest(SIMPLE).content)).toBe(before);
      expect(layerNames()).toHaveLength(4);
    },
    LOOP_TIMEOUT
  );

  it('EM8/EM9/M11 editing sends nothing until Save', async () => {
    await edit();
    await click(button('Add text'));
    await commit(field('Layer name'), 'Named');
    await click(button('Add page'));
    await click(button('Undo', toolbar()));
    expect(writes()).toEqual([]);
  });

  it('EM10 Cancel without changes leaves at once', async () => {
    await edit();
    await click(button('Cancel', toolbar()));
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(button('Edit design')).toBeTruthy();
  });

  it('EM11/EM12 Cancel with changes asks; discarding shows the saved revision again', async () => {
    await edit();
    await click(button('Add ellipse'));
    mockConfirm.mockResolvedValueOnce(false);
    await click(button('Cancel', toolbar()));
    expect(mockConfirm).toHaveBeenCalledWith(
      'Your changes have not been saved as a design revision.',
      'Discard',
      'Discard unsaved changes?',
      'Keep editing'
    );
    expect(layerNames()).toHaveLength(4);
    await click(button('Cancel', toolbar()));
    expect(layerNames()).toEqual(['▣Photo', 'TTitle', '▭Box']);
    expect(writes()).toEqual([]);
  });

  it('76/121 opening an older revision while editing asks to discard first', async () => {
    await renderWorkspace(MAIN.id);
    await click(button('Edit design'));
    await click(button('Add text'));
    mockConfirm.mockResolvedValueOnce(false);
    await click(button('View Revision 1'));
    expect(screen.queryByText('Viewing revision 1')).toBeNull();
    expect(toolbar()).toBeTruthy();
    await click(button('View Revision 1'));
    expect(screen.getByText('Viewing revision 1')).toBeTruthy();
    await click(button('Back to current'));
    expect(queryButton('Save')).toBeNull();
  });

  it('77 archiving while editing first discards the draft, after asking', async () => {
    await edit();
    await click(button('Add text'));
    mockConfirm.mockResolvedValueOnce(false);
    await click(button('Archive Simple'));
    expect(writes()).toEqual([]);
    await click(button('Archive Simple'));
    expect(writes().map((c) => c.url)).toEqual([
      `${designPath(SIMPLE)}/archive`,
    ]);
    expect(queryButton('Edit design')).toBeNull();
  });

  it('9 the Creative Studio link asks before leaving a changed draft', async () => {
    await edit();
    await click(button('Add text'));
    mockConfirm.mockResolvedValueOnce(false);
    await click(screen.getByRole('link', { name: 'Creative Studio' }));
    expect(mockPush).not.toHaveBeenCalled();
    await click(screen.getByRole('link', { name: 'Creative Studio' }));
    expect(mockPush).toHaveBeenCalledWith('/content-studio/designs');
  });
});

// ============================================================================
describe('Creative Studio editing: save', () => {
  it('SV-UI1/SV-UI2/SV-UI3/SV-UI6/SV-UI8/SV-UI9/P408-10 saves the parsed draft over the base revision, then shows the new revision', async () => {
    await edit();
    await selectLayer(/Box/);
    await commit(field('Layer name'), '  Box renamed  ');
    await save();
    expect(saves()).toHaveLength(1);
    const [call] = saves();
    expect(call.url).toBe(`${designPath(SIMPLE)}/revisions`);
    const body = bodyOf(call);
    expect(Object.keys(body).sort()).toEqual(['baseRevisionNumber', 'content']);
    expect(body.baseRevisionNumber).toBe(1);
    // normalized by the Design Document parser: the name is trimmed
    expect(body.content).toEqual(
      parseContentStudioDesignDocument(body.content)
    );
    expect(body.content.pages[0].layers[0].name).toBe('Box renamed');
    expect(JSON.stringify(body)).not.toMatch(
      /organizationId|userId|contentHash|revisionId/
    );
    expect(toasts()).toEqual(['Design saved as Revision 2.']);
    expect(header()).toContain('Revision 2');
    expect(queryButton('Save')).toBeNull();
    expect(button('Edit design')).toBeTruthy();
    // the design and its history reloaded
    expect(
      gets(designPath(SIMPLE)).filter((c) => c.url === designPath(SIMPLE))
        .length
    ).toBe(2);
    expect(gets(`${designPath(SIMPLE)}/revisions?`).length).toBe(2);
  });

  it('SV-UI5/114 Save waits for a change, and undoing back to the saved revision is no change', async () => {
    await edit();
    expect(isOff(button('Save', toolbar()))).toBe(true);
    await click(button('Add rectangle'));
    expect(isOff(button('Save', toolbar()))).toBe(false);
    await click(button('Undo', toolbar()));
    expect(isOff(button('Save', toolbar()))).toBe(true);
    await click(button('Redo', toolbar()));
    expect(isOff(button('Save', toolbar()))).toBe(false);
  });

  it('SV-UI7 the same content as the base: no new revision', async () => {
    override = (method, url) =>
      method === 'POST' && url.endsWith('/revisions')
        ? reply(200, { created: false, revision: { ...latest(SIMPLE) } })
        : undefined;
    await edit();
    await click(button('Add rectangle'));
    await save();
    expect(toasts()).toEqual(['No changes to save.']);
    expect(SIMPLE.revisions).toHaveLength(1);
    expect(queryButton('Save')).toBeNull();
  });

  it('SV-UI4/74 one save at a time; editing waits while it runs', async () => {
    const gate = deferred();
    override = (method, url) =>
      method === 'POST' && url.endsWith('/revisions')
        ? gate.promise
        : undefined;
    await edit();
    await click(button('Add rectangle'));
    fireEvent.click(button('Save', toolbar()));
    fireEvent.click(button('Save', toolbar()));
    await flush();
    expect(saves()).toHaveLength(1);
    expect(isOff(button('Cancel', toolbar()))).toBe(true);
    expect(isOff(button('Add text'))).toBe(true);
    expect(isOff(button('View Revision 1'))).toBe(true);
    override = () => undefined;
    gate.resolve(
      server('POST', `${designPath(SIMPLE)}/revisions`, bodyOf(saves()[0]))
    );
    await flush();
    expect(toasts()).toEqual(['Design saved as Revision 2.']);
  });

  it(
    'SV-UI10/SV-UI11/115/M9/M10 a conflict keeps the draft and blocks saving, without retrying',
    async () => {
      await edit();
      await click(button('Add text'));
      // another tab saved revision 2 meanwhile
      SIMPLE.revisions = [...SIMPLE.revisions, revision(2, PLAIN())];
      await save();
      expect(saves()).toHaveLength(1);
      expect(
        screen.getByText('This design changed while you were editing.')
      ).toBeTruthy();
      expect(
        screen.getByText(
          'Reload the latest revision before saving. Your unsaved changes are still open in this browser.'
        )
      ).toBeTruthy();
      expect(layerNames()).toHaveLength(4);
      expect(isOff(button('Save', toolbar()))).toBe(true);
      await click(button('Keep editing'));
      expect(
        screen.queryByText('This design changed while you were editing.')
      ).toBeNull();
      expect(
        screen.getByText(
          'Saving is blocked until you reload the latest revision.'
        )
      ).toBeTruthy();
      await click(button('Add rectangle'));
      expect(isOff(button('Save', toolbar()))).toBe(true);
      fireEvent.click(button('Save', toolbar()));
      await flush();
      expect(saves()).toHaveLength(1);
      expect(toasts()).toEqual([]);
    },
    LOOP_TIMEOUT
  );

  it('SV-UI12/16 Reload latest asks, then drops the draft and shows the newest revision', async () => {
    await edit();
    await click(button('Add text'));
    SIMPLE.revisions = [...SIMPLE.revisions, revision(2, PLAIN())];
    await save();
    mockConfirm.mockResolvedValueOnce(false);
    await click(button('Reload latest'));
    expect(mockConfirm).toHaveBeenLastCalledWith(
      'Your unsaved changes will be discarded.',
      'Reload latest',
      'Reload latest revision?',
      'Cancel'
    );
    expect(toolbar()).toBeTruthy();
    await click(button('Reload latest'));
    expect(queryButton('Save')).toBeNull();
    expect(header()).toContain('Revision 2');
    expect(layerNames()).toEqual(['▣Photo', 'TTitle', '▭Box']);
    expect(saves()).toHaveLength(1);
  });

  it(
    'SV-UI13/SV-UI14/SV-UI15/M34 other save failures have fixed messages and keep the draft',
    async () => {
      for (const [status, code, message] of [
        [409, 'CS_DESIGN_ARCHIVED', 'This design is archived.'],
        [
          400,
          'CS_DESIGN_BRAND_REFERENCE_NOT_FOUND',
          'The selected Brand Kit revision is no longer available.',
        ],
        [
          400,
          'CS_DESIGN_BRAND_REFERENCE_INVALID',
          'The Brand Kit reference in this design is invalid.',
        ],
        [
          500,
          'CS_DESIGN_BRAND_REFERENCE_INTEGRITY_ERROR',
          'Stored Brand Kit data could not be read safely.',
        ],
        [
          500,
          'CS_DESIGN_INTEGRITY_ERROR',
          'Stored design data could not be read safely.',
        ],
        [413, 'CS_DESIGN_TOO_LARGE', 'This design is too large to save.'],
        [500, 'CS_NEW_THING', 'Something went wrong while saving the design.'],
      ] as const) {
        mockToast.mockReset();
        override = (method, url) =>
          method === 'POST' && url.endsWith('/revisions')
            ? failWith(status, code)
            : undefined;
        await edit();
        await click(button('Add text'));
        await save();
        expect([code, toasts()]).toEqual([code, [message]]);
        expect(layerNames()).toHaveLength(4);
        cleanup();
      }
    },
    LOOP_TIMEOUT
  );

  it('12/67 an invalid draft is never sent', async () => {
    await edit();
    await selectLayer(/Title/);
    // more text than one design may hold, through the field's own limit
    await commit(field('Text'), 'x'.repeat(10_000));
    expect(isOff(button('Save', toolbar()))).toBe(false);
    const parser = require('@gitroom/nestjs-libraries/content-studio/design/design.document');
    const spy = jest
      .spyOn(parser, 'parseContentStudioDesignDocument')
      .mockImplementation(() => {
        throw new parser.ContentStudioDesignDocumentError('TOO_LARGE');
      });
    await save();
    expect(toasts()).toEqual(['This design is too large to save.']);
    spy.mockImplementation(() => {
      throw new parser.ContentStudioDesignDocumentError('INVALID', [
        { path: [SECRET], code: SECRET },
      ]);
    });
    await save();
    expect(toasts()[1]).toBe(
      'The design contains invalid values. Fix them before saving.'
    );
    expect(saves()).toEqual([]);
    spy.mockRestore();
  });

  it('66 a design with too much text cannot be saved', async () => {
    SIMPLE.revisions[0].content.pages[0].layers = Array.from(
      { length: 20 },
      (_, i) => textLayer(`t${i}`, '', 'y'.repeat(10_000))
    );
    await edit();
    await click(
      within(screen.getByRole('list', { name: 'Layers' })).getAllByRole(
        'button'
      )[0]
    );
    expect(isOff(button('Save', toolbar()))).toBe(true);
    await click(button('Duplicate layer'));
    expect(
      screen.getByText('This design contains too much text.')
    ).toBeTruthy();
    expect(isOff(button('Save', toolbar()))).toBe(true);
  });
});

// ============================================================================
describe('Creative Studio editing: undo and redo', () => {
  it('UR8/90/92 selection falls back when the selected layer goes away', async () => {
    await edit();
    await click(button('Add text'));
    expect(screen.getByRole('heading', { name: 'Layer · Text' })).toBeTruthy();
    await click(button('Undo', toolbar()));
    expect(screen.getByRole('heading', { name: 'Page 1 · One' })).toBeTruthy();
    await selectLayer(/Box/);
    await click(button('Delete layer'));
    expect(layerNames()).toEqual(['▣Photo', 'TTitle']);
    expect(screen.getByRole('heading', { name: 'Page 1 · One' })).toBeTruthy();
    await click(button('Undo', toolbar()));
    expect(layerNames()).toEqual(['▣Photo', 'TTitle', '▭Box']);
  });

  it('21 Ctrl+Z and Ctrl+Shift+Z undo and redo outside fields; inside a field typing keeps its own undo', async () => {
    await edit();
    await click(button('Add rectangle'));
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await flush();
    expect(layerNames()).toHaveLength(3);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    await flush();
    expect(layerNames()).toHaveLength(4);
    fireEvent.keyDown(field('Layer name'), { key: 'z', metaKey: true });
    await flush();
    expect(layerNames()).toHaveLength(4);
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true });
    await flush();
    expect(layerNames()).toHaveLength(4);
  });
});

// ============================================================================
describe('Creative Studio editing: pages', () => {
  it(
    'PE1/PE2/PE3/PE5 add, duplicate, delete and move pages, selecting the result',
    async () => {
      await edit();
      await click(button('Add page'));
      expect(pageNames()).toEqual(['Page 1One', 'Page 2Two', 'Page 3']);
      expect(
        within(screen.getByRole('list', { name: 'Pages' }))
          .getAllByRole('button')[2]
          .getAttribute('aria-pressed')
      ).toBe('true');
      // the new page has the size of the page it was added from
      expect(previewPage().style.width).toBe('1080px');
      await selectPage(/Page 1/);
      await click(button('Duplicate page'));
      expect(pageNames()).toEqual([
        'Page 1One',
        'Page 2One',
        'Page 3Two',
        'Page 4',
      ]);
      expect(layerNames()).toEqual(['▣Photo', 'TTitle', '▭Box']);
      await click(button('Move page down'));
      expect(pageNames()).toEqual([
        'Page 1One',
        'Page 2Two',
        'Page 3One',
        'Page 4',
      ]);
      await click(button('Move page up'));
      await click(button('Move page up'));
      expect(pageNames()).toEqual([
        'Page 1One',
        'Page 2One',
        'Page 3Two',
        'Page 4',
      ]);
      expect(isOff(button('Move page up'))).toBe(true);
      await click(button('Delete page'));
      expect(pageNames()).toEqual(['Page 1One', 'Page 2Two', 'Page 3']);
      await save();
      const content = lastSaved();
      expect(content.pages.map((p: Plain) => p.name)).toEqual([
        'One',
        'Two',
        '',
      ]);
      expect(content.pages[2]).toMatchObject({
        width: 1080,
        height: 1080,
        layers: [],
      });
    },
    LOOP_TIMEOUT
  );

  it('PE4/M14 the last page cannot be deleted', async () => {
    SIMPLE.revisions[0].content.pages = [SIMPLE.revisions[0].content.pages[0]];
    await edit();
    expect(isOff(button('Delete page'))).toBe(true);
    fireEvent.click(button('Delete page'));
    await flush();
    expect(pageNames()).toEqual(['Page 1One']);
  });

  it('PE6/PE7/PE8/PE9 page name and background are editable; the size is not', async () => {
    await renderWorkspace(MAIN.id);
    await click(button('Edit design'));
    expect(screen.getByText('The page size cannot be changed.')).toBeTruthy();
    expect(screen.queryByLabelText('Width')).toBeNull();
    await commit(field('Page name'), 'Cover <b>x</b>');
    expect(field('Background source').value).toBe('brand');
    await choose(field('Background'), 'accent');
    expect(previewPage().style.backgroundColor).toBe(rgb('#e4572e'));
    await choose(field('Background source'), 'literal');
    await commit(field('Background'), '#ABCDEF');
    expect(previewPage().style.backgroundColor).toBe(rgb('#abcdef'));
    await commit(field('Background'), '#fff');
    expect(screen.getByText('Enter a color as #rrggbb.')).toBeTruthy();
    expect(previewPage().style.backgroundColor).toBe(rgb('#abcdef'));
    await save();
    expect(lastSaved().pages[0]).toMatchObject({
      name: 'Cover <b>x</b>',
      width: 1080,
      height: 1080,
      background: {
        type: 'solid',
        color: { type: 'literal', value: '#abcdef' },
      },
    });
  });

  it('PE10 the page limit disables adding pages', async () => {
    SIMPLE.revisions[0].content.pages = Array.from({ length: 25 }, (_, i) =>
      page(`p_${i}`, '', [])
    );
    await edit();
    expect(isOff(button('Add page'))).toBe(true);
    expect(isOff(button('Duplicate page'))).toBe(true);
    expect(screen.getByText('A design can have up to 25 pages.')).toBeTruthy();
  });
});

// ============================================================================
describe('Creative Studio editing: layers', () => {
  it(
    'LE1/LE2/LE3/LE4 adds text, rectangles and ellipses in front, each selected',
    async () => {
      await edit();
      await click(button('Add text'));
      expect(
        screen.getByRole('heading', { name: 'Layer · Text' })
      ).toBeTruthy();
      await click(button('Add rectangle'));
      expect(
        screen.getByRole('heading', { name: 'Layer · Rectangle' })
      ).toBeTruthy();
      await click(button('Add ellipse'));
      expect(
        screen.getByRole('heading', { name: 'Layer · Ellipse' })
      ).toBeTruthy();
      expect(layerNames().slice(0, 3)).toEqual([
        '◯Ellipse',
        '▭Rectangle',
        'TText',
      ]);
      // an ellipse never offers a corner radius
      expect(screen.queryByLabelText('Corner radius')).toBeNull();
      await save();
      const layers = lastSaved().pages[0].layers;
      expect(
        layers.slice(3).map((l: Plain) => [l.type, l.shape ?? null])
      ).toEqual([
        ['text', null],
        ['shape', 'rectangle'],
        ['shape', 'ellipse'],
      ]);
      expect(layers[5].cornerRadius).toBe(0);
    },
    LOOP_TIMEOUT
  );

  it('LE5/LE6/LE7/LE8/LE9/M19/M20 geometry, opacity, rotation, visibility and name; invalid numbers never enter the draft', async () => {
    await edit();
    await selectLayer(/Box/);
    await commit(field('X'), '-12.5');
    await commit(field('Y'), '40');
    await commit(field('Width'), '250');
    await commit(field('Height'), '0');
    expect(screen.getByRole('alert').textContent).toContain(
      'Enter a number > 0'
    );
    await commit(field('Height'), '120');
    await commit(field('Rotation'), '400');
    expect((previewLayer('box') as HTMLElement).style.transform).toBe(
      'rotate(0deg)'
    );
    await commit(field('Rotation'), '-90');
    await commit(field('Opacity'), '1.5');
    expect(field('Opacity').getAttribute('aria-invalid')).toBe('true');
    expect((previewLayer('box') as HTMLElement).style.opacity).toBe('1');
    await commit(field('Opacity'), 'abc');
    await commit(field('Opacity'), '0.4');
    fireEvent.click(field('Visible'));
    await flush();
    await commit(field('Layer name'), 'Card');
    expect(previewLayer('box')).toBeNull();
    expect(layerNames()).toContain('▭CardHidden');
    await save();
    expect(lastSaved().pages[0].layers[0]).toMatchObject({
      id: 'box',
      name: 'Card',
      x: -12.5,
      y: 40,
      width: 250,
      height: 120,
      rotation: -90,
      opacity: 0.4,
      visible: false,
    });
  });

  it('LE10/LE11/XE1/M18 text keeps its spaces and newlines exactly; the family is plain text', async () => {
    await edit();
    await selectLayer(/Title/);
    expect(field('Text').value).toBe('  Keep  spaces\n');
    await commit(field('Text'), `  <script>x</script>\n\t${HTML_MARKER}  `);
    await commit(field('Family'), 'Georgia');
    await choose(field('Weight'), '700');
    await choose(field('Style'), 'italic');
    await commit(field('Font size'), '2000');
    await commit(field('Font size'), '30');
    await commit(field('Line height'), '1.5');
    await commit(field('Letter spacing'), '-3');
    await choose(field('Alignment'), 'right');
    await choose(field('Vertical alignment'), 'bottom');
    await choose(field('Overflow'), 'shrink');
    await commit(field('Color'), '#00FF00');
    expect(previewLayer('title')?.textContent).toBe(
      `  <script>x</script>\n    ${HTML_MARKER}  `
    );
    await save();
    expect(lastSaved().pages[0].layers[1]).toMatchObject({
      text: `  <script>x</script>\n\t${HTML_MARKER}  `,
      font: { type: 'family', family: 'Georgia', weight: 700, style: 'italic' },
      fontSize: 30,
      lineHeight: 1.5,
      letterSpacing: -3,
      align: 'right',
      verticalAlign: 'bottom',
      overflow: 'shrink',
      color: { type: 'literal', value: '#00ff00' },
    });
  });

  it('LE12/LE13/XE7 a Brand type style and Brand color are kept as tokens, chosen by their names as text', async () => {
    await renderWorkspace(MAIN.id);
    await click(button('Edit design'));
    await click(button('Add text'));
    await choose(field('Font source'), 'brand');
    await choose(field('Color source'), 'brand');
    await choose(field('Color'), 'accent');
    const option = within(field('Color')).getByRole('option', {
      name: `accent <b>${HTML_MARKER}</b>`,
    });
    expect(option).toBeTruthy();
    await save();
    const added = lastSaved().pages[0].layers[2];
    expect(added.font).toEqual({ type: 'brand', tokenId: 'heading' });
    expect(added.color).toEqual({ type: 'brand', tokenId: 'accent' });
    expect(JSON.stringify(added)).not.toMatch(/Poppins|#e4572e/);
  });

  it('LE14/LE15 fill for shapes; corner radius only for rectangles', async () => {
    await edit();
    await selectLayer(/Box/);
    await commit(field('Fill'), '#123abc');
    await commit(field('Corner radius'), '5000');
    await commit(field('Corner radius'), '24');
    await save();
    expect(lastSaved().pages[0].layers[0]).toMatchObject({
      fill: { type: 'literal', value: '#123abc' },
      cornerRadius: 24,
    });
  });

  it('LE16/LE17 fit and focal point of an image', async () => {
    await edit();
    await selectLayer(/Photo/);
    await choose(field('Fit'), 'contain');
    await commit(field('Focal point X'), '1.2');
    await commit(field('Focal point X'), '0');
    await commit(field('Focal point Y'), '0.9');
    await save();
    expect(lastSaved().pages[0].layers[2]).toMatchObject({
      fit: 'contain',
      focalPoint: { x: 0, y: 0.9 },
      imageRef: { type: 'media', mediaId: 'photo-1', sha256: SHA('a') },
    });
  });

  it(
    'LE18/LE19/LE20 delete, duplicate and z-order act on the document order',
    async () => {
      await edit();
      await selectLayer(/Box/);
      expect(isOff(button('Send backward'))).toBe(true);
      expect(isOff(button('Send to back'))).toBe(true);
      await click(button('Bring forward'));
      expect(layerNames()).toEqual(['▣Photo', '▭Box', 'TTitle']);
      await click(button('Bring to front'));
      expect(layerNames()).toEqual(['▭Box', '▣Photo', 'TTitle']);
      expect(isOff(button('Bring forward'))).toBe(true);
      await click(button('Send to back'));
      expect(layerNames()).toEqual(['▣Photo', 'TTitle', '▭Box']);
      await click(button('Duplicate layer'));
      expect(layerNames()).toEqual(['▣Photo', 'TTitle', '▭Box', '▭Box']);
      await click(button('Delete layer'));
      await selectLayer(/Title/);
      await click(button('Delete layer'));
      await save();
      expect(lastSaved().pages[0].layers.map((l: Plain) => l.id)).toEqual([
        'box',
        'photo',
      ]);
    },
    LOOP_TIMEOUT
  );

  // P4-09: while editing, layers are chosen on the canvas instead (see
  // content-studio.design.canvas.spec); the read-only preview keeps this
  it('127/128 clicking a preview layer selects it; the page clears the choice', async () => {
    await renderWorkspace(SIMPLE.id);
    await click(previewLayer('box') as HTMLElement);
    expect(screen.getByRole('heading', { name: 'Layer · Box' })).toBeTruthy();
    expect((previewLayer('box') as HTMLElement).className).toContain(
      'outline-[4px]'
    );
    await click(previewPage());
    expect(screen.getByRole('heading', { name: 'Page 1 · One' })).toBeTruthy();
  });

  it('XE2/XE3/XE4/XE5 names and text stay text; there is no rich text editor', async () => {
    await edit();
    await selectLayer(/Box/);
    await commit(
      field('Layer name'),
      `<img src=x onerror=alert(1)> ${HTML_MARKER}`
    );
    expect(layerNames()[2]).toBe(
      `▭<img src=x onerror=alert(1)> ${HTML_MARKER}`
    );
    expect(
      document.querySelectorAll('[contenteditable], [onerror]')
    ).toHaveLength(0);
    expect(previewPage().querySelectorAll('img')).toHaveLength(0);
  });
});

// ============================================================================
describe('Creative Studio editing: Media picker', () => {
  const openPicker = async () => {
    await edit();
    await click(button('Add image'));
    return dialog('Add image');
  };
  const refCalls = () => gets('/content-studio/media/');

  it('MP-UI1/MP-UI2/MP-UI3/MP-UI12/XE6 lists one page of image Media, names as text, and references none yet', async () => {
    const picker = await openPicker();
    expect(gets('/media').map((c) => c.url)).toEqual(['/media?page=1']);
    const list = within(picker).getByRole('list', { name: 'Images' });
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label'))
    ).toEqual([
      `Hero <img src=x onerror=alert(1)> ${HTML_MARKER}.png`,
      'Team.jpg',
      'Unusable.png',
      'Broken.webp',
    ]);
    expect(refCalls()).toEqual([]);
    expect(within(picker).queryByText(/upload/i)).toBeNull();
    expect(picker.querySelector('input[type="file"]')).toBeNull();
    await click(button('Next', picker));
    expect(gets('/media').map((c) => c.url)).toEqual([
      '/media?page=1',
      '/media?page=2',
    ]);
    await click(within(picker).getByRole('button', { name: 'Previous' }));
    fireEvent.change(within(picker).getByLabelText('Search media'), {
      target: { value: 'team' },
    });
    await click(button('Search', picker));
    expect(gets('/media').map((c) => c.url)).toContain(
      '/media?page=1&search=team'
    );
    // still one page at a time, and nothing referenced
    expect(
      gets('/media').every((c) =>
        /^\/media\?page=\d+(&search=team)?$/.test(c.url)
      )
    ).toBe(true);
    expect(refCalls()).toEqual([]);
  });

  it('MP-UI4/MP-UI5/MP-UI6/MP-UI7/EL4 choosing one Media asks the server once for its reference, and stores only that', async () => {
    const picker = await openPicker();
    await click(within(picker).getByRole('button', { name: 'Team.jpg' }));
    await click(button('Use image', picker));
    expect(refCalls().map((c) => c.url)).toEqual([
      '/content-studio/media/img-jpg/design-ref',
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Layer · Image' })).toBeTruthy();
    await save();
    const added = lastSaved().pages[0].layers[3];
    expect(added).toMatchObject({
      type: 'image',
      imageRef: { type: 'media', mediaId: 'img-jpg', sha256: SHA('d') },
      fit: 'cover',
      focalPoint: { x: 0.5, y: 0.5 },
      x: 108,
      y: 108,
      width: 864,
      height: 648,
    });
    expect(JSON.stringify(lastSaved())).not.toMatch(
      /https?:|cdn\.test|thumb|Team/
    );
  });

  it('MP-UI8/MP-UI9 an unavailable or unreadable Media has a fixed message and adds nothing', async () => {
    const picker = await openPicker();
    for (const [name, message] of [
      ['Unusable.png', 'This media item cannot be used in a design.'],
      [
        'Broken.webp',
        'The file of this image is not available on this server. Add the image to your media library again and use the new one.',
      ],
    ]) {
      await click(within(picker).getByRole('button', { name }));
      await click(button('Use image', picker));
      expect(within(picker).getByRole('alert').textContent).toBe(message);
    }
    delete mediaRefs['img-png'];
    await click(within(picker).getByRole('button', { name: /^Hero/ }));
    await click(button('Use image', picker));
    expect(within(picker).getByRole('alert').textContent).toBe(
      'This item is no longer available.'
    );
    await click(button('Cancel', picker));
    expect(layerNames()).toHaveLength(3);
  });

  it('MP-UI10/107 one reference request at a time', async () => {
    const gate = deferred();
    override = (method, url) =>
      url.endsWith('/design-ref') && url.includes('/media/')
        ? gate.promise
        : undefined;
    const picker = await openPicker();
    await click(within(picker).getByRole('button', { name: 'Team.jpg' }));
    fireEvent.click(button('Use image', picker));
    fireEvent.click(button('Use image', picker));
    await flush();
    expect(refCalls()).toHaveLength(1);
    // UX review 02: the wait is said, so the button never looks dead
    expect(within(picker).getByRole('status').textContent).toBe(
      'Adding image…'
    );
    gate.resolve(reply(200, { mediaId: 'img-jpg', sha256: SHA('d') }));
    await flush();
    expect(layerNames()).toHaveLength(4);
    expect(mockToast.mock.calls.map(([text]) => text)).toContain(
      'Image added.'
    );
  });

  it('MP-UI12 a file type a design cannot use says which types it can', async () => {
    override = (method, url) =>
      url.endsWith('/design-ref') && url.includes('/media/')
        ? reply(409, {
            msg: `${SECRET} gif`,
            code: 'CS_DESIGN_MEDIA_UNSUPPORTED',
          })
        : undefined;
    const picker = await openPicker();
    await click(within(picker).getByRole('button', { name: 'Team.jpg' }));
    await click(button('Use image', picker));
    expect(within(picker).getByRole('alert').textContent).toBe(
      'This file type cannot be used in a design. Use a PNG, JPEG or WebP image.'
    );
    expect(layerNames()).toHaveLength(3);
  });

  it('MP-UI11/M26 replacing an image changes only its reference', async () => {
    const original = JSON.parse(
      JSON.stringify(latest(SIMPLE).content.pages[0].layers[2])
    );
    await edit();
    await selectLayer(/Photo/);
    await click(button('Replace image'));
    const picker = dialog('Replace image');
    await click(within(picker).getByRole('button', { name: /^Hero/ }));
    await click(button('Use image', picker));
    await save();
    expect(lastSaved().pages[0].layers[2]).toEqual({
      ...original,
      imageRef: { type: 'media', mediaId: 'img-png', sha256: SHA('b') },
    });
  });
});

// ============================================================================
describe('Creative Studio editing: Brand Kit revision', () => {
  const openBrand = async (id = MAIN.id) => {
    await renderWorkspace(id);
    await click(button('Edit design'));
    await click(button('Change Brand Kit revision'));
    return dialog('Change Brand Kit revision');
  };
  const rows = (picker: HTMLElement) =>
    within(within(picker).getByRole('list', { name: 'Brand Kit revisions' }))
      .getAllByRole('listitem')
      .map((li) => li.textContent);

  it('BR-EDIT1/BR-EDIT2/79 lists No Brand Kit and every revision, marking the pinned and the latest', async () => {
    const picker = await openBrand();
    expect(rows(picker)).toEqual([
      'No Brand Kit',
      'Revision 8Latest',
      'Revision 7',
      'Revision 3Pinned',
    ]);
    expect(gets('/content-studio/brand-kit').map((c) => c.url)).toEqual(
      expect.arrayContaining([
        '/content-studio/brand-kit',
        '/content-studio/brand-kit/revisions?page=1',
      ])
    );
    expect(
      screen.getByText(
        'A design is pinned to one exact Brand Kit revision. It does not follow later revisions.'
      )
    ).toBeTruthy();
  });

  it('BR-EDIT3/BR-EDIT4/BR-EDIT5/BR-EDIT9/EB4 pins exactly the chosen revision, checked against its content, as one undo step', async () => {
    const picker = await openBrand();
    const before = gets('/content-studio/brand-kit/revisions/').length;
    fireEvent.click(within(picker).getByRole('radio', { name: /Revision 8/ }));
    await click(button('Apply', picker));
    expect(
      gets('/content-studio/brand-kit/revisions/')
        .slice(before)
        .map((c) => c.url)
    ).toEqual(
      expect.arrayContaining([
        `/content-studio/brand-kit/revisions/${REV_8}/design-ref`,
        `/content-studio/brand-kit/revisions/${REV_8}`,
      ])
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Brand Kit · Revision 8')).toBeTruthy();
    // tokens stay tokens: the new revision's values show
    expect(previewPage().style.backgroundColor).toBe(rgb('#eeeeee'));
    await click(button('Undo', toolbar()));
    expect(screen.getByText('Brand Kit · Revision 3')).toBeTruthy();
    await click(button('Redo', toolbar()));
    await save();
    expect(lastSaved().brandKit).toEqual(brandRef(REV_8));
    expect(lastSaved().pages[0].layers[0].fill).toEqual({
      type: 'brand',
      tokenId: 'accent',
    });
  });

  it('BR-EDIT5 a reference that does not match the revision content is not used', async () => {
    override = (method, url) =>
      url.endsWith(`${REV_8}/design-ref`)
        ? reply(200, { ...brandRef(REV_8), contentHash: SHA('x') })
        : undefined;
    const picker = await openBrand();
    fireEvent.click(within(picker).getByRole('radio', { name: /Revision 8/ }));
    await click(button('Apply', picker));
    expect(within(picker).getByRole('alert').textContent).toBe(
      'Stored Brand Kit data could not be read safely.'
    );
    await click(button('Cancel', picker));
    expect(screen.getByText('Brand Kit · Revision 3')).toBeTruthy();
  });

  it('BR-EDIT8/EB5/M30 a revision without every token the design uses is refused', async () => {
    const picker = await openBrand();
    fireEvent.click(within(picker).getByRole('radio', { name: /Revision 7/ }));
    await click(button('Apply', picker));
    expect(within(picker).getByRole('alert').textContent).toBe(
      'This Brand Kit revision does not contain all tokens used by the design.'
    );
    await click(button('Cancel', picker));
    expect(isOff(button('Save', toolbar()))).toBe(true);
  });

  it('BR-EDIT7/EB2/M29 the Brand Kit cannot be removed while its tokens are used', async () => {
    const picker = await openBrand();
    fireEvent.click(
      within(picker).getByRole('radio', { name: 'No Brand Kit' })
    );
    await click(button('Apply', picker));
    expect(within(picker).getByRole('alert').textContent).toBe(
      'This design still uses Brand Kit colors or typography. Replace them before removing the Brand Kit.'
    );
  });

  it('BR-EDIT6 removes the Brand Kit once no token is used', async () => {
    SIMPLE.revisions[0].content.brandKit = brandRef(REV_3);
    const picker = await openBrand(SIMPLE.id);
    fireEvent.click(
      within(picker).getByRole('radio', { name: 'No Brand Kit' })
    );
    await click(button('Apply', picker));
    expect(screen.getByText('No Brand Kit revision attached')).toBeTruthy();
    await save();
    expect(lastSaved().brandKit).toBeNull();
  });

  it('BR-EDIT10/80/M31 a newer Brand Kit revision is never applied by itself', async () => {
    await renderWorkspace(MAIN.id);
    await click(button('Edit design'));
    await click(button('Add text'));
    await save();
    expect(lastSaved().brandKit).toEqual(brandRef(REV_3));
    expect(gets(`/content-studio/brand-kit/revisions/${REV_8}`)).toEqual([]);
  });

  it('101 a draft using a token the pinned revision lacks cannot be saved', async () => {
    BRAND[REV_3].content.colors = BRAND[REV_3].content.colors.filter(
      (c: Plain) => c.id !== 'accent'
    );
    try {
      await renderWorkspace(MAIN.id);
      await click(button('Edit design'));
      await click(button('Add text'));
      expect(isOff(button('Save', toolbar()))).toBe(true);
      expect(
        screen.getAllByText(
          'This Brand Kit revision does not contain all tokens used by the design.'
        ).length
      ).toBeGreaterThan(0);
    } finally {
      BRAND[REV_3].content = kit(
        [
          ['paper', '#faf7f2'],
          ['ink', '#1a1a1a'],
          ['accent', '#e4572e'],
        ],
        ['heading']
      );
    }
  });
});

// ============================================================================
describe('Creative Studio editing: boundaries', () => {
  const dir = __dirname;
  const FILES = [
    'content-studio.design.editor.ts',
    'content-studio.design.editing.tsx',
    'content-studio.design.workspace.tsx',
    'content-studio.design.preview.tsx',
    'content-studio.designs.api.ts',
    'content-studio.designs.tsx',
  ];
  const code = (text: string) =>
    text
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
  const sources = FILES.map(
    (file) => [file, code(readFileSync(join(dir, file), 'utf8'))] as const
  );

  it('P408-1/P408-2/P408-3/122/123/124/M33 Design Document v1 only: no Fabric, canvas state or editor fields in what is saved', () => {
    for (const [file, text] of sources) {
      expect([file, text]).not.toEqual([
        file,
        expect.stringMatching(
          /from '(fabric|konva|pixi[^']*|canvas)'|toJSON\(|fromJSON\(|loadFromJSON|schemaVersion: 2|<canvas|getContext\(/
        ),
      ]);
    }
    const editor = sources.find(([file]) => file.endsWith('editor.ts'))![1];
    expect(editor).not.toMatch(
      /selected|locked|zoom|viewport|thumbnail|expanded/i
    );
    // P4-09 adds Fabric as the browser interaction layer, imported by its
    // adapter only (content-studio.design.canvas.spec P409-1); none of these
    // files imports it
  });

  it('P408-4/P408-5/M32 no browser storage, autosave timer or unload persistence', () => {
    for (const [file, text] of sources) {
      expect([file, text]).not.toEqual([
        file,
        expect.stringMatching(
          /localStorage|sessionStorage|indexedDB|document\.cookie|setInterval|setTimeout|autosave|beforeunload|navigator\.sendBeacon/i
        ),
      ]);
    }
  });

  it('P408-11/P408-12/22/M22 no external fetch, Media URL in a reference, or font download', () => {
    for (const [file, text] of sources) {
      expect([file, text]).not.toEqual([
        file,
        expect.stringMatching(
          /\bfetch\(\s*['`]https?:|XMLHttpRequest|render-fonts|fonts\.googleapis|FontFace|@font-face|dangerouslySetInnerHTML|innerHTML|contentEditable|contenteditable/
        ),
      ]);
    }
    const editing = sources.find(([file]) => file.endsWith('editing.tsx'))![1];
    // what a picked Media becomes: its id and the server's SHA-256 only
    expect(
      (editing.match(/imageRef: \{[^}]*\}/g) ?? []).map((m) =>
        m.replace(/\s+/g, ' ').replace(/, \}/, ' }')
      )
    ).toEqual([
      "imageRef: { type: 'media', mediaId: ref.mediaId, sha256: ref.sha256 }",
    ]);
    expect(editing).toContain(
      'onPicked({ mediaId: ref.mediaId, sha256: ref.sha256 });'
    );
    expect(editing).not.toMatch(/sha256: [^r]|crypto\.subtle|digest\(/);
  });
});
