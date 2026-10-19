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
import dayjs from 'dayjs';
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

const { ContentStudioDesigns } = require('./content-studio.designs');
const {
  ContentStudioDesignWorkspace,
} = require('./content-studio.design.workspace');
const api = require('./content-studio.designs.api');

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
// per test: answer a request differently, or undefined for the default
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

// tests that render the workspace once per case, sequentially
const LOOP_TIMEOUT = 60_000;

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

// --- markers: never shown, logged or toasted, or shown only as plain text ---
const SECRET = 'DESIGN_UI_SERVER_SECRET_123';
const HTML_MARKER = 'DESIGN_UI_HTML_MARKER_456';
const RENDER_MARKER = 'DESIGN_UI_RENDER_PRIVATE_789';

// --- fixtures: Design Document v1 values, as the server returns them ---
const T0 = '2026-10-10T10:00:00.000Z';
const T1 = '2026-10-11T12:30:00.000Z';
const T2 = '2026-10-12T08:15:00.000Z';
const PAGE = 20;
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const BRAND_KIT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const BRAND_REV = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const BRAND_REF = {
  brandKitId: BRAND_KIT_ID,
  revisionId: BRAND_REV,
  revisionNumber: 3,
  contentHash: SHA('c'),
};
const KIT = {
  schemaVersion: 1,
  identity: { brandName: 'Acme', tagline: '', description: '' },
  colors: [
    { id: 'paper', name: 'Paper', value: '#faf7f2', role: 'background' },
    { id: 'ink', name: 'Ink', value: '#1a1a1a', role: 'text' },
    { id: 'accent', name: 'Accent', value: '#e4572e', role: 'accent' },
  ],
  typography: [
    {
      id: 'heading',
      name: 'Heading',
      family: 'Poppins',
      weight: 700,
      style: 'normal',
      role: 'heading',
    },
  ],
  visualDirection: { keywords: [], dos: [], donts: [] },
};

type Plain = Record<string, any>;
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
const ellipse = (id: string, name: string, extra: Plain = {}) =>
  rect(id, name, { shape: 'ellipse', fill: lit('#00ff00'), ...extra });
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

// The current revision of the main design: three pages, ids not in
// alphabetical order, a Brand Kit, and every kind of layer
const XSS_TEXT = `<script>alert(1)</script><img src=x onerror=alert(2)></div><b>bold</b> ${HTML_MARKER}`;
const MAIN_V2 = () =>
  doc(
    [
      page(
        'p_intro',
        'Intro',
        [
          rect('backdrop', 'Backdrop', {
            width: 1080,
            height: 1080,
            fill: tok('paper'),
          }),
          ellipse('dot', '', { x: 40, y: 50, width: 200, height: 120 }),
          rect('card', 'Card', {
            x: 10,
            y: 20,
            width: 300,
            height: 150,
            rotation: 30,
            opacity: 0.5,
            cornerRadius: 24,
          }),
          imageLayer('photo', 'Photo', { x: 600, y: 600 }),
          rect('ghost', 'Ghost', { visible: false }),
          rect('invisible', '', { opacity: 0 }),
          rect('offcanvas', 'Off canvas', { x: 1500, y: -400 }),
          textLayer('headline', 'Headline', 'Hello\tworld\nSecond line', {
            x: 100,
            y: 700,
            width: 880,
            height: 200,
            color: tok('ink'),
            font: tok('heading'),
            overflow: 'shrink',
          }),
          textLayer('xss', `Layer ${HTML_MARKER} <b>x</b>`, XSS_TEXT, {
            y: 900,
          }),
        ],
        { background: { type: 'solid', color: tok('paper') } }
      ),
      page('p_body', '', [], { width: 1080, height: 1350 }),
      page('p_cta', `CTA <img src=x onerror=alert(3)> ${HTML_MARKER}`, [
        rect('missing-color', 'Missing color', { fill: tok('nope') }),
      ]),
    ],
    BRAND_REF
  );
// The first revision: one page with another name and one layer
const MAIN_V1 = () =>
  doc([
    page('p_intro', 'First draft', [rect('first-only', 'First only shape')]),
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
let brandRevisions: Record<string, Plain>;
let media: Record<string, Plain>;
let renders = 0;

const revision = (revisionNumber: number, content: any): Revision => ({
  id: nextId(),
  revisionNumber,
  schemaVersion: 1,
  contentHash: SHA(String(revisionNumber)),
  createdAt: revisionNumber === 1 ? T0 : T1,
  content,
});
const design = (
  name: string,
  contents: any[],
  archived = false,
  over: Partial<Design> = {}
): Design => ({
  id: nextId(),
  name,
  archivedAt: archived ? T1 : null,
  createdAt: T0,
  updatedAt: T1,
  revisions: contents.map((content, index) => revision(index + 1, content)),
  ...over,
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

let MAIN: Design; // active, revisions 1 and 2, three pages, Brand Kit
let EMPTY: Design; // active, one empty page
let OLD: Design; // archived

const renderMedia = (width: number, height: number) => {
  const id = `render-media-${++renders}`;
  media[id] = {
    id,
    name: `${id}.png`,
    originalName: null,
    path: `https://cdn.test/uploads/${id}.png`,
    thumbnail: null,
    alt: null,
    status: 'ready',
    processingError: null,
  };
  return id;
};

const server = (method: string, url: string, body: any): Reply => {
  const { pathname, searchParams } = new URL(url, 'https://api.test');
  const mediaMatch = pathname.match(/^\/media\/([^/]+)\/status$/);
  if (method === 'GET' && mediaMatch) {
    const one = media[decodeURIComponent(mediaMatch[1])];
    return one ? reply(200, one) : reply(404, { message: 'Media not found' });
  }
  const brandMatch = pathname.match(
    /^\/content-studio\/brand-kit\/revisions\/([^/]+)$/
  );
  if (method === 'GET' && brandMatch) {
    const one = brandRevisions[brandMatch[1]];
    return one
      ? reply(200, one)
      : reply(404, {
          msg: 'Brand Kit revision not found.',
          code: 'CS_NOT_FOUND',
        });
  }
  const base = '/content-studio/designs';
  if (!pathname.startsWith(base)) {
    return reply(404, { msg: 'no route', code: 'CS_NOT_FOUND' });
  }
  const rest = pathname.slice(base.length);
  const pageNumber = Number(searchParams.get('page') || 1);
  if (method === 'GET' && rest === '') {
    const archived = searchParams.get('archived') === 'true';
    const rows = designs.filter((d) => !!d.archivedAt === archived);
    return reply(200, {
      pages: Math.ceil(rows.length / PAGE),
      results: rows
        .slice((pageNumber - 1) * PAGE, pageNumber * PAGE)
        .map(summary),
    });
  }
  if (method === 'POST' && rest === '') {
    const created = design(body.name, [body.content]);
    designs = [created, ...designs];
    return reply(201, {
      ...summary(created),
      currentRevision: latest(created),
    });
  }
  const match = rest.match(
    /^\/([^/]+)(?:\/(revisions|archive|restore|render|render-all)(?:\/([^/]+))?)?$/
  );
  const found = match && designs.find((d) => d.id === match[1]);
  if (!found) {
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
  if (method === 'PATCH' && !action) {
    if (found.archivedAt) {
      return reply(409, { msg: 'archived', code: 'CS_DESIGN_ARCHIVED' });
    }
    found.name = body.name;
    found.updatedAt = T2;
    return reply(200, summary(found));
  }
  if (method === 'POST' && action === 'archive') {
    found.archivedAt = found.archivedAt || T2;
    return reply(200, summary(found));
  }
  if (method === 'POST' && action === 'restore') {
    found.archivedAt = null;
    return reply(200, summary(found));
  }
  if (method === 'GET' && action === 'revisions' && !revisionId) {
    const rows = [...found.revisions].reverse();
    return reply(200, {
      pages: Math.ceil(rows.length / PAGE),
      results: rows.slice((pageNumber - 1) * PAGE, pageNumber * PAGE).map(meta),
    });
  }
  if (method === 'GET' && action === 'revisions' && revisionId) {
    const one = found.revisions.find((r) => r.id === revisionId);
    return one
      ? reply(200, one)
      : reply(404, { msg: 'Design not found.', code: 'CS_NOT_FOUND' });
  }
  if (method === 'POST' && (action === 'render' || action === 'render-all')) {
    const one = found.revisions.find((r) => r.id === body.revisionId);
    if (!one) {
      return reply(404, {
        msg: 'Design revision not found.',
        code: 'CS_DESIGN_REVISION_NOT_FOUND',
      });
    }
    const pages = one.content.pages as Plain[];
    if (action === 'render') {
      const target = pages.find((p) => p.id === body.pageId);
      if (!target) {
        return reply(400, {
          msg: 'The selected design page is not available.',
          code: 'CS_DESIGN_RENDER_PAGE_INVALID',
        });
      }
      return reply(200, {
        id: nextId(),
        designProjectId: found.id,
        designRevisionId: one.id,
        designRevisionNumber: one.revisionNumber,
        pageId: target.id,
        status: 'completed',
        width: target.width,
        height: target.height,
        mimeType: 'image/png',
        renderedMediaId: renderMedia(target.width, target.height),
        renderedSha256: SHA('e'),
        assetSnapshotHash: SHA('f'),
        createdAt: T2,
        completedAt: T2,
      });
    }
    return reply(200, {
      id: nextId(),
      designProjectId: found.id,
      designRevisionId: one.id,
      designRevisionNumber: one.revisionNumber,
      status: 'completed',
      pageCount: pages.length,
      outputs: pages.map((p, pageIndex) => ({
        renderId: nextId(),
        pageId: p.id,
        pageIndex,
        width: p.width,
        height: p.height,
        mimeType: 'image/png',
        renderedMediaId: renderMedia(p.width, p.height),
        renderedSha256: SHA('e'),
        assetSnapshotHash: SHA('f'),
      })),
      createdAt: T2,
      completedAt: T2,
    });
  }
  return reply(404, { msg: 'no route', code: 'CS_NOT_FOUND' });
};

let storageSpies: jest.SpyInstance[];
let consoleSpies: jest.SpyInstance[];

beforeEach(() => {
  mockModals.set([]);
  counter = 0;
  renders = 0;
  MAIN = design(`Launch <b>${HTML_MARKER}</b>`, [MAIN_V1(), MAIN_V2()]);
  EMPTY = design('Empty one', [doc([page('p_only', '', [])])]);
  OLD = design(
    'Old design',
    [doc([page('p_old', 'Old page', [rect('o', 'Old shape')])])],
    true
  );
  designs = [MAIN, EMPTY, OLD];
  brandRevisions = {
    [BRAND_REV]: {
      id: BRAND_REV,
      revisionNumber: 3,
      schemaVersion: 1,
      contentHash: SHA('c'),
      createdAt: T0,
      content: KIT,
    },
  };
  media = {};
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
  // nothing of a design is kept in the browser or logged
  for (const spy of storageSpies) {
    expect(spy).not.toHaveBeenCalled();
  }
  for (const spy of consoleSpies) {
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(
      new RegExp(`${SECRET}|${HTML_MARKER}|${RENDER_MARKER}`)
    );
  }
  // a toast is always fixed text: never a server message, name or URL
  for (const text of toasts()) {
    expect(text).not.toMatch(
      new RegExp(`${SECRET}|${HTML_MARKER}|${RENDER_MARKER}|https?:\\/\\/`)
    );
  }
  // and no server message ever reaches the page
  expect(document.body.textContent).not.toMatch(
    new RegExp(`${SECRET}|${RENDER_MARKER}`)
  );
  cleanup();
  [...storageSpies, ...consoleSpies].forEach((spy) => spy.mockRestore());
});

let swrCache: Map<string, unknown>;
const wrap = (...children: ReactNode[]) => {
  swrCache = new Map();
  return render(
    h(
      SWRConfig,
      { value: { provider: () => swrCache, dedupingInterval: 0 } },
      h(ModalHost),
      ...children
    )
  );
};
const renderLibrary = async () => {
  const view = wrap(h(ContentStudioDesigns));
  await flush();
  return view;
};
const renderWorkspace = async (id = MAIN.id) => {
  const view = wrap(h(ContentStudioDesignWorkspace, { designId: id }));
  await flush();
  return view;
};

const dialog = (title: string | RegExp) =>
  screen.getByRole('dialog', { name: title });
const button = (name: string | RegExp, root: HTMLElement = document.body) =>
  within(root).getByRole('button', { name });
const queryButton = (
  name: string | RegExp,
  root: HTMLElement = document.body
) => within(root).queryByRole('button', { name });
const field = (name: string | RegExp, root: HTMLElement = document.body) =>
  within(root).getByLabelText(name) as HTMLInputElement;
const type = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } });
const click = async (element: HTMLElement) => {
  fireEvent.click(element);
  await flush();
};
const row = (name: string) =>
  screen.getByRole('link', { name }).closest('li') as HTMLElement;
const listGets = (archived?: boolean) =>
  gets('/content-studio/designs?').filter(
    (c) => archived === undefined || c.url.includes(`archived=${archived}`)
  );
const deferred = () => {
  let resolve!: (value: Reply) => void;
  const promise = new Promise<Reply>((r) => (resolve = r));
  return { promise, resolve };
};
const date = (iso: string) => dayjs(iso).format('MMM D, YYYY HH:mm');
const designPath = (d: Design) => `/content-studio/designs/${d.id}`;
const posts = (suffix: string) =>
  writes().filter((c) => c.method === 'POST' && c.url.endsWith(suffix));
const bodyOf = (call: { body?: unknown }) => JSON.parse(call.body as string);
const previewPage = () =>
  document.querySelector('[data-preview="page"]') as HTMLElement;
const previewLayer = (id: string) =>
  document.querySelector(`[data-layer="${id}"]`) as HTMLElement | null;
const layerButtons = () =>
  within(screen.getByRole('list', { name: 'Layers' }))
    .getAllByRole('button')
    .map((b) => b.textContent);
// P4-10: a page card is named "Select page N · name" and shows a thumbnail
const pageButton = (name: RegExp) =>
  within(screen.getByRole('list', { name: 'Pages' })).getByRole('button', {
    name: new RegExp(name.source, 'i'),
  });
const selectLayer = async (label: string) =>
  click(
    within(screen.getByRole('list', { name: 'Layers' })).getByRole('button', {
      name: new RegExp(label),
    })
  );
const viewRevision = async (n: number) => click(button(`View Revision ${n}`));
const facts = () =>
  Object.fromEntries(
    Array.from(document.querySelectorAll('dl dt')).map((dt) => [
      dt.textContent,
      (dt.nextElementSibling as HTMLElement).textContent,
    ])
  );
// the line under the design name: status, revision, updated
const header = () =>
  (screen.getByRole('heading', { level: 1 }).nextElementSibling as HTMLElement)
    .textContent;
const rgb = (hex: string) =>
  `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
const failWith = (status: number, code: string) =>
  reply(status, { msg: `${SECRET} ${RENDER_MARKER} /srv/private`, code });

// ============================================================================
describe('Creative Studio: Design Library', () => {
  it('DL-UI1 loads page 1 of the active designs', async () => {
    await renderLibrary();
    expect(listGets().map((c) => c.url)).toEqual([
      '/content-studio/designs?page=1&archived=false',
    ]);
    expect(
      screen.getByRole('heading', { name: 'Creative Studio' })
    ).toBeTruthy();
    expect(
      screen.getByText('Create and render reusable visual designs.')
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Empty one' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Old design' })).toBeNull();
  });

  it('DL-UI2 the Archived filter loads and shows archived designs only', async () => {
    await renderLibrary();
    await click(button('Archived'));
    expect(listGets(true).map((c) => c.url)).toEqual([
      '/content-studio/designs?page=1&archived=true',
    ]);
    expect(screen.getByRole('link', { name: 'Old design' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Empty one' })).toBeNull();
    expect(button('Archived').getAttribute('aria-pressed')).toBe('true');
  });

  it('DL-UI3 switching the status starts again on page 1', async () => {
    designs = [
      ...Array.from({ length: 25 }, (_, i) =>
        design(`Active ${i + 1}`, [doc([page('p', '', [])])])
      ),
      ...Array.from({ length: 25 }, (_, i) =>
        design(`Archived ${i + 1}`, [doc([page('p', '', [])])], true)
      ),
    ];
    await renderLibrary();
    await click(button('Next'));
    expect(listGets().pop()?.url).toBe(
      '/content-studio/designs?page=2&archived=false'
    );
    await click(button('Archived'));
    expect(listGets().pop()?.url).toBe(
      '/content-studio/designs?page=1&archived=true'
    );
  });

  it('DL-UI4/DL-UI5 keeps the server order and loads only the current page', async () => {
    designs = [
      design('Zulu', [doc([page('p', '', [])])]),
      design('Alpha', [doc([page('p', '', [])])]),
      design('Mike', [doc([page('p', '', [])])]),
      ...Array.from({ length: 30 }, (_, i) =>
        design(`Later ${i}`, [doc([page('p', '', [])])])
      ),
    ];
    await renderLibrary();
    const names = screen
      .getAllByRole('listitem')
      .map((li) => within(li).getAllByRole('link')[0].textContent);
    expect(names.slice(0, 3)).toEqual(['Zulu', 'Alpha', 'Mike']);
    expect(names).toHaveLength(20);
    expect(listGets().map((c) => c.url)).toEqual([
      '/content-studio/designs?page=1&archived=false',
    ]);
  });

  it('DL-UI6 loads no design detail, revision or Brand Kit per row', async () => {
    await renderLibrary();
    expect(calls().map((c) => c.url)).toEqual([
      '/content-studio/designs?page=1&archived=false',
    ]);
  });

  it('DL-UI7 a row shows the name, status, latest revision and dates, and opens the design', async () => {
    await renderLibrary();
    const main = row(MAIN.name);
    expect(main.textContent).toContain('Active');
    expect(main.textContent).toContain('Revision 2');
    expect(main.textContent).toContain(`Created: ${date(T0)}`);
    expect(main.textContent).toContain(`Updated: ${date(T1)}`);
    expect(
      within(main)
        .getByRole('link', { name: `Open ${MAIN.name}` })
        .getAttribute('href')
    ).toBe(designPath(MAIN));
  });

  it('DL-UI8 an active design offers Open, Rename and Archive', async () => {
    await renderLibrary();
    const empty = row('Empty one');
    expect(
      within(empty)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Rename', 'Archive']);
    expect(
      within(empty).getByRole('link', { name: 'Open Empty one' })
    ).toBeTruthy();
  });

  it('DL-UI9 an archived design offers Open and Restore only', async () => {
    await renderLibrary();
    await click(button('Archived'));
    const old = row('Old design');
    expect(
      within(old)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Restore']);
    expect(
      within(old).getByRole('link', { name: 'Open Old design' })
    ).toBeTruthy();
  });

  it('DL-UI10 the active empty state invites to create a design', async () => {
    designs = [];
    await renderLibrary();
    expect(screen.getByText('No designs yet.')).toBeTruthy();
    expect(
      screen.getByText('Create a design to start building visual content.')
    ).toBeTruthy();
    expect(
      screen.getAllByRole('button', { name: 'Create design' })
    ).toHaveLength(2);
  });

  it('DL-UI11 the archived empty state says so', async () => {
    designs = [];
    await renderLibrary();
    await click(button('Archived'));
    expect(screen.getByText('No archived designs.')).toBeTruthy();
  });

  it('DL-UI12 a load failure has a fixed message and Try again', async () => {
    override = (method, url) =>
      method === 'GET' && url.startsWith('/content-studio/designs?')
        ? failWith(500, 'CS_INTERNAL')
        : undefined;
    await renderLibrary();
    expect(screen.getByText('Designs could not be loaded.')).toBeTruthy();
    override = () => undefined;
    await click(button('Try again'));
    expect(screen.getByRole('link', { name: 'Empty one' })).toBeTruthy();
  });

  it('DL-UI13/DRA10 offers no delete anywhere', async () => {
    await renderLibrary();
    expect(queryButton(/delete/i)).toBeNull();
    await click(button('Archived'));
    expect(queryButton(/delete/i)).toBeNull();
    await renderWorkspace();
    expect(queryButton(/delete/i)).toBeNull();
    expect(calls().some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('XS-D1 a design name stays literal text', async () => {
    await renderLibrary();
    const link = screen.getByRole('link', { name: MAIN.name });
    expect(link.textContent).toBe(`Launch <b>${HTML_MARKER}</b>`);
    expect(link.querySelector('b')).toBeNull();
  });
});

// ============================================================================
describe('Creative Studio: create a design', () => {
  const openCreate = async () => {
    await click(screen.getAllByRole('button', { name: 'Create design' })[0]);
    return dialog('Create design');
  };
  const presets = (root: HTMLElement) =>
    within(root)
      .getAllByRole('radio')
      .map((radio) => (radio.closest('label') as HTMLElement).textContent);
  const createPosts = () =>
    writes().filter(
      (c) => c.method === 'POST' && c.url === '/content-studio/designs'
    );

  it('DC-UI1/DC-UI2 a dialog with a name, required before it submits', async () => {
    await renderLibrary();
    const form = await openCreate();
    const submit = button('Create design', form);
    expect(submit.className).toContain('opacity-50');
    type(field('Name', form), '   ');
    expect(submit.className).toContain('opacity-50');
    await click(submit);
    expect(createPosts()).toEqual([]);
  });

  // P4-17: a design can also start from a page set (one canvas size first)
  it('DC-UI3/DC-UI4 four fixed canvas presets, Square by default', async () => {
    await renderLibrary();
    const form = await openCreate();
    expect(presets(form)).toEqual([
      'One canvas size',
      'A page set',
      'Square 1080 × 1080',
      'Portrait 1080 × 1350',
      'Story 1080 × 1920',
      'Landscape 1200 × 628',
    ]);
    const checked = within(form)
      .getAllByRole('radio')
      .filter((r) => (r as HTMLInputElement).checked);
    expect(checked.map((r) => (r as HTMLInputElement).value)).toEqual([
      'size',
      'square',
    ]);
    expect(within(form).queryByRole('spinbutton')).toBeNull();
  });

  it('DC-UI5/DC-UI6/DC-UI7/DC-UI8/DC-UI9/DC-UI10/DC-UI11/DC-UI12 sends the name and an exact Design Document v1, then opens the design without rendering', async () => {
    await renderLibrary();
    const form = await openCreate();
    type(field('Name', form), '  Spring campaign  ');
    fireEvent.click(within(form).getByRole('radio', { name: /Story/ }));
    await click(button('Create design', form));
    const [post] = createPosts();
    const body = bodyOf(post);
    expect(Object.keys(body).sort()).toEqual(['content', 'name']);
    expect(body.name).toBe('Spring campaign');
    // exactly what the server's parser accepts, unchanged
    expect(parseContentStudioDesignDocument(body.content)).toEqual(
      body.content
    );
    expect(body.content).toEqual({
      schemaVersion: 1,
      brandKit: null,
      pages: [
        {
          id: expect.stringMatching(/^p_[0-9a-f]{20}$/),
          name: '',
          width: 1080,
          height: 1920,
          background: {
            type: 'solid',
            color: { type: 'literal', value: '#ffffff' },
          },
          layers: [],
        },
      ],
    });
    const created = designs[0];
    expect(mockPush).toHaveBeenCalledWith(designPath(created));
    expect(toasts()).toContain('Design created.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes().map((c) => c.url)).toEqual(['/content-studio/designs']);
    // the lists reload
    expect(listGets(false).length).toBeGreaterThan(1);
  });

  it('DC-UI6 never names the current Brand Kit, even when one exists', async () => {
    await renderLibrary();
    const form = await openCreate();
    type(field('Name', form), 'Branded?');
    await click(button('Create design', form));
    expect(bodyOf(createPosts()[0]).content.brandKit).toBeNull();
    expect(gets('/content-studio/brand-kit')).toEqual([]);
  });

  it('DC-UI8/63 page ids follow the page id grammar, with or without randomUUID', () => {
    const PAGE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
    const ids = Array.from({ length: 50 }, () =>
      api.newContentStudioDesignPageId()
    );
    for (const id of ids) {
      expect(id).toMatch(PAGE_ID);
      expect(id).toMatch(/^p_[0-9a-f]{20}$/);
    }
    expect(new Set(ids).size).toBe(50);
    const original = (globalThis.crypto as any).randomUUID;
    (globalThis.crypto as any).randomUUID = () =>
      '12345678-9abc-4def-8123-456789abcdef';
    try {
      expect(api.newContentStudioDesignPageId()).toBe('p_123456789abc4def8123');
    } finally {
      (globalThis.crypto as any).randomUUID = original;
    }
  });

  it('DC-UI13 a double submit sends one request', async () => {
    const gate = deferred();
    override = (method, url) =>
      method === 'POST' && url === '/content-studio/designs'
        ? gate.promise
        : undefined;
    await renderLibrary();
    const form = await openCreate();
    type(field('Name', form), 'Twice');
    fireEvent.click(button('Create design', form));
    fireEvent.click(button('Create design', form));
    fireEvent.submit(form.querySelector('form') as HTMLFormElement);
    await flush();
    expect(createPosts()).toHaveLength(1);
    gate.resolve(reply(201, { id: EMPTY.id }));
    await flush();
  });

  it(
    'DC-UI14/DC-UI15 a failure shows a fixed message, never the server text, and keeps the input',
    async () => {
      for (const [code, message] of [
        ['CS_DESIGN_INVALID', 'Check the values and try again.'],
        ['CS_INVALID_REQUEST', 'Check the values and try again.'],
        ['CS_DESIGN_TOO_LARGE', 'The design is too large.'],
        [
          'CS_SOMETHING_ELSE',
          'Something went wrong while creating the design.',
        ],
      ]) {
        mockToast.mockReset();
        override = (method, url) =>
          method === 'POST' && url === '/content-studio/designs'
            ? failWith(400, code)
            : undefined;
        await renderLibrary();
        const form = await openCreate();
        type(field('Name', form), 'Kept');
        await click(button('Create design', form));
        expect(toasts()).toEqual([message]);
        expect(field('Name', form).value).toBe('Kept');
        expect(mockPush).not.toHaveBeenCalled();
        cleanup();
        mockModals.set([]);
      }
    },
    LOOP_TIMEOUT
  );
});

// ============================================================================
describe('Creative Studio: rename, archive and restore', () => {
  const openRename = async (root: HTMLElement = document.body) => {
    await click(within(root).getByRole('button', { name: /^Rename/ }));
    return dialog('Rename design');
  };

  it('DRA1/DRA2/DRA9 renames with the name only, then reloads the lists and the design', async () => {
    await renderWorkspace();
    const listCalls = listGets().length;
    const detailCalls = gets(designPath(MAIN)).filter(
      (c) => c.url === designPath(MAIN)
    ).length;
    const form = await openRename();
    type(field('Name', form), '  Launch v2  ');
    await click(button('Save', form));
    const [patch] = writes();
    expect(patch).toEqual({
      method: 'PATCH',
      url: designPath(MAIN),
      body: JSON.stringify({ name: 'Launch v2' }),
    });
    expect(toasts()).toEqual(['Design renamed.']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Launch v2'
    );
    expect(
      gets(designPath(MAIN)).filter((c) => c.url === designPath(MAIN)).length
    ).toBe(detailCalls + 1);
    // no revision was created and no history page is lost
    expect(MAIN.revisions).toHaveLength(2);
    expect(listGets().length).toBe(listCalls);
  });

  it('DRA3 Save is disabled for a blank or unchanged name', async () => {
    await renderLibrary();
    const form = await openRename(row('Empty one'));
    const save = button('Save', form);
    expect(save.className).toContain('opacity-50');
    type(field('Name', form), '   ');
    expect(save.className).toContain('opacity-50');
    type(field('Name', form), ' Empty one ');
    await click(save);
    expect(writes()).toEqual([]);
  });

  it('DRA4/M6 an archived design cannot be renamed, in the library or its workspace', async () => {
    await renderLibrary();
    await click(button('Archived'));
    expect(queryButton(/Rename/, row('Old design'))).toBeNull();
    cleanup();
    await renderWorkspace(OLD.id);
    expect(queryButton(/Rename/)).toBeNull();
    expect(button('Restore Old design')).toBeTruthy();
  });

  it('DRA5/DRA6/DRA9 archives after confirmation with one exact POST, then reloads', async () => {
    await renderLibrary();
    mockConfirm.mockResolvedValueOnce(false);
    await click(button('Archive Empty one'));
    expect(writes()).toEqual([]);
    expect(mockConfirm).toHaveBeenCalledWith(
      'It will no longer appear with active designs. Its revision history and rendered media will remain available.',
      'Archive',
      'Archive this design?',
      'Cancel'
    );
    await click(button('Archive Empty one'));
    expect(writes()).toEqual([
      {
        method: 'POST',
        url: `${designPath(EMPTY)}/archive`,
        body: undefined,
      },
    ]);
    expect(toasts()).toEqual(['Design archived.']);
    expect(screen.queryByRole('link', { name: 'Empty one' })).toBeNull();
  });

  it('DRA7/DRA8 restores with one exact POST and the workspace stays open', async () => {
    await renderWorkspace(OLD.id);
    await click(button('Restore Old design'));
    expect(writes()).toEqual([
      { method: 'POST', url: `${designPath(OLD)}/restore`, body: undefined },
    ]);
    expect(toasts()).toEqual(['Design restored.']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Old design'
    );
    expect(screen.getByText('Active')).toBeTruthy();
    expect(button('Rename Old design')).toBeTruthy();
  });

  it('DRA8/98 archiving keeps the workspace and the opened revision, and rendering stays possible', async () => {
    await renderWorkspace();
    await viewRevision(1);
    await click(button(`Archive ${MAIN.name}`));
    expect(screen.getByText('Viewing revision 1')).toBeTruthy();
    expect(screen.getByText('Archived')).toBeTruthy();
    expect(button('Render page').className).not.toContain('opacity-50');
  });

  it('97 renaming keeps the opened historical revision', async () => {
    await renderWorkspace();
    await viewRevision(1);
    const form = await openRename();
    type(field('Name', form), 'Renamed');
    await click(button('Save', form));
    expect(screen.getByText('Viewing revision 1')).toBeTruthy();
    expect(layerButtons()).toEqual(['▭First only shape']);
  });

  it('a lifecycle failure shows a fixed message', async () => {
    override = (method, url) =>
      method === 'POST' && url.endsWith('/archive')
        ? failWith(500, 'CS_UNKNOWN')
        : undefined;
    await renderLibrary();
    await click(button('Archive Empty one'));
    expect(toasts()).toEqual([
      'Something went wrong while updating the design.',
    ]);
  });
});

// ============================================================================
describe('Creative Studio: workspace', () => {
  it('DW1/RV2 loads the design and the first history page independently, and no older revision', async () => {
    await renderWorkspace();
    expect(
      calls()
        .filter((c) => c.url.startsWith('/content-studio/designs'))
        .map((c) => c.url)
    ).toEqual([designPath(MAIN), `${designPath(MAIN)}/revisions?page=1`]);
    expect(gets(`${designPath(MAIN)}/revisions/`)).toEqual([]);
  });

  it('DW2 a missing or foreign design is "Design not found." with a way back', async () => {
    await renderWorkspace('99999999-0000-4000-8000-000000000000');
    expect(screen.getByText('Design not found.')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Back to Creative Studio' })
        .getAttribute('href')
    ).toBe('/content-studio/designs');
    expect(queryButton('Try again')).toBeNull();
  });

  it(
    'DW3/69 a failed or unsafe design load has fixed messages',
    async () => {
      override = (method, url) =>
        method === 'GET' && url === designPath(MAIN)
          ? failWith(500, 'CS_INTERNAL')
          : undefined;
      await renderWorkspace();
      expect(screen.getByText('Design could not be loaded.')).toBeTruthy();
      override = () => undefined;
      await click(button('Try again'));
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        MAIN.name
      );
      cleanup();

      override = (method, url) =>
        method === 'GET' && url === designPath(MAIN)
          ? failWith(500, 'CS_DESIGN_INTEGRITY_ERROR')
          : undefined;
      await renderWorkspace();
      expect(
        screen.getByText('Design could not be loaded safely.')
      ).toBeTruthy();
      cleanup();

      // the browser checks the document again: one that is not v1 is not shown
      latest(MAIN).content = { ...MAIN_V2(), schemaVersion: 2, script: SECRET };
      override = () => undefined;
      await renderWorkspace();
      expect(
        screen.getByText('Design could not be loaded safely.')
      ).toBeTruthy();
      expect(previewPage()).toBeNull();
    },
    LOOP_TIMEOUT
  );

  it('DW4 a history failure leaves the design visible', async () => {
    override = (method, url) =>
      method === 'GET' && url.includes('/revisions?')
        ? failWith(500, 'CS_INTERNAL')
        : undefined;
    await renderWorkspace();
    expect(
      screen.getByText('Revision history could not be loaded.')
    ).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      MAIN.name
    );
    expect(previewPage()).toBeTruthy();
  });

  it('DW5/DW6/XS-D2 shows the pages in design order, the first selected, names as text', async () => {
    await renderWorkspace();
    const pages = within(
      screen.getByRole('list', { name: 'Pages' })
    ).getAllByRole('button');
    expect(
      pages.map((b) => b.querySelector('[data-page-label]')?.textContent)
    ).toEqual([
      'Page 1Intro',
      'Page 2',
      `Page 3CTA <img src=x onerror=alert(3)> ${HTML_MARKER}`,
    ]);
    expect(pages.map((b) => b.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    expect(pages[2].querySelector('img')).toBeNull();
  });

  it('DW7 an archived design is readable and renderable, with Restore and no Rename', async () => {
    await renderWorkspace(OLD.id);
    expect(screen.getByText('Archived')).toBeTruthy();
    expect(layerButtons()).toEqual(['▭Old shape']);
    expect(button('Render page').className).not.toContain('opacity-50');
    expect(button('Render all pages').className).not.toContain('opacity-50');
  });

  it('DW8/55 the header shows the name, status and current revision, with no Save', async () => {
    await renderWorkspace();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      MAIN.name
    );
    expect(
      screen.getByRole('heading', { level: 1 }).querySelector('b')
    ).toBeNull();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(header()).toBe(`ActiveRevision 2Updated: ${date(T1)}`);
    // P4-11: Save as template makes a new template, it saves no design
    expect(queryButton(/^Save(?! as template)/)).toBeNull();
    expect(
      screen.getByText(
        'This revision is read-only: inspect it here and render it to Media.'
      )
    ).toBeTruthy();
  });

  it('15 keeps the chosen page across revisions while it exists, else the first', async () => {
    await renderWorkspace();
    await click(pageButton(/Page 3/));
    await viewRevision(1);
    // revision 1 has p_intro only
    expect(pageButton(/Page 1/).getAttribute('aria-pressed')).toBe('true');
    await click(button('Back to current'));
    expect(pageButton(/Page 3/).getAttribute('aria-pressed')).toBe('true');
    await click(pageButton(/Page 1/));
    await viewRevision(1);
    await click(button('Back to current'));
    expect(pageButton(/Page 1/).getAttribute('aria-pressed')).toBe('true');
  });

  it('56 an empty page shows its background and says it has no layers', async () => {
    await renderWorkspace(EMPTY.id);
    expect(screen.getByText('No layers on this page.')).toBeTruthy();
    expect(previewPage().children).toHaveLength(0);
    expect(previewPage().style.backgroundColor).toBe(rgb('#ffffff'));
  });
});

// ============================================================================
describe('Creative Studio: layers and inspector', () => {
  it('LL1/LL2/LL3/LL4/LL5 lists the front-most layer first with exact labels, names and hidden status, leaving the document as it is', async () => {
    const before = JSON.stringify(latest(MAIN).content);
    await renderWorkspace();
    expect(layerButtons()).toEqual([
      `T${`Layer ${HTML_MARKER} <b>x</b>`}`,
      'THeadline',
      '▭Off canvas',
      '▭Rectangle',
      '▭GhostHidden',
      '▣Photo',
      '▭Card',
      '◯Ellipse',
      '▭Backdrop',
    ]);
    expect(JSON.stringify(latest(MAIN).content)).toBe(before);
    // the preview draws in document order: first is at the back
    expect(
      Array.from(previewPage().children).map((c) =>
        c.getAttribute('data-layer')
      )
    ).toEqual([
      'backdrop',
      'dot',
      'card',
      'photo',
      'invisible',
      'offcanvas',
      'headline',
      'xss',
    ]);
  });

  it('LL6 clicking a layer selects it for the inspector; clicking it again shows the page', async () => {
    await renderWorkspace();
    await selectLayer('Card');
    expect(screen.getByRole('heading', { name: 'Layer · Card' })).toBeTruthy();
    await selectLayer('Card');
    expect(
      screen.getByRole('heading', { name: 'Page 1 · Intro' })
    ).toBeTruthy();
  });

  it('LL7/LL8/IN7 no drag, visibility toggle or edit control', async () => {
    await renderWorkspace();
    await selectLayer('Headline');
    expect(document.querySelectorAll('[draggable="true"]')).toHaveLength(0);
    expect(
      document.querySelectorAll('input, textarea, select, [contenteditable]')
    ).toHaveLength(0);
    expect(
      queryButton(/hide|show layer|visib|delete|add|duplicate|move|up|down/i)
    ).toBeNull();
  });

  it('IN1 the page inspector shows its size and resolved background', async () => {
    await renderWorkspace();
    expect(facts()).toEqual({
      Width: '1080',
      Height: '1080',
      Background: 'Paper · #faf7f2',
    });
    await click(pageButton(/Page 2/));
    expect(facts()).toEqual({
      Width: '1080',
      Height: '1350',
      Background: '#ffffff',
    });
  });

  it('IN2/XS-D4 a text layer: geometry, type style, text as plain text', async () => {
    await renderWorkspace();
    await selectLayer('Headline');
    expect(facts()).toEqual({
      Type: 'Text',
      Position: '100, 700',
      Size: '880 × 200',
      Rotation: '0°',
      Opacity: '1',
      Visible: 'Yes',
      Text: 'Hello\tworld\nSecond line',
      Font: 'Heading · Poppins · 700 · normal',
      'Font size': '64',
      'Line height': '1.25',
      'Letter spacing': '2',
      Alignment: 'Center',
      'Vertical alignment': 'Middle',
      Overflow:
        'Shrink to fitFinal shrink-to-fit is applied by the server renderer.',
      Color: 'Ink · #1a1a1a',
    });
  });

  it('IN3 shapes: shape type, fill and the stored corner radius', async () => {
    await renderWorkspace();
    await selectLayer('Card');
    expect(facts()).toMatchObject({
      Type: 'Rectangle',
      Rotation: '30°',
      Opacity: '0.5',
      Fill: '#ff0000',
      'Corner radius': '24',
    });
    await selectLayer('Ellipse');
    expect(facts()).toMatchObject({ Type: 'Ellipse', Fill: '#00ff00' });
    expect(facts()).not.toHaveProperty('Corner radius');
  });

  it('IN4/IN5/IN6 an image: fit and focal point, no Media id, hash or URL', async () => {
    await renderWorkspace();
    await selectLayer('Photo');
    expect(facts()).toMatchObject({
      Type: 'Image',
      Media:
        'Linked Media imageThe image is drawn by the server render once its Media is verified.',
      Fit: 'Cover',
      'Focal point': '0.25, 0.75',
    });
    const text = document.body.textContent as string;
    expect(text).not.toContain('photo-1');
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    expect(text).not.toMatch(/https?:\/\/|uploads\/|storage/i);
    expect(document.body.innerHTML).not.toContain(SHA('a'));
    expect(document.body.innerHTML).not.toContain(SHA('c'));
  });

  it('XS-D3 a layer name stays literal text', async () => {
    await renderWorkspace();
    const list = screen.getByRole('list', { name: 'Layers' });
    expect(list.textContent).toContain(`Layer ${HTML_MARKER} <b>x</b>`);
    expect(list.querySelector('b')).toBeNull();
  });

  it('131 renders a deep-frozen document without changing it', async () => {
    const freeze = (value: any): any => {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
      return value;
    };
    latest(MAIN).content = freeze(MAIN_V2());
    brandRevisions[BRAND_REV] = freeze(brandRevisions[BRAND_REV]);
    await renderWorkspace();
    await selectLayer('Headline');
    await click(pageButton(/Page 3/));
    expect(previewPage()).toBeTruthy();
    expect(Object.isFrozen(latest(MAIN).content.pages[0].layers)).toBe(true);
  });
});

// ============================================================================
describe('Creative Studio: structural live preview', () => {
  it('PV1 draws the page at its design size, scaled as a whole', async () => {
    await renderWorkspace();
    const pageEl = previewPage();
    expect(pageEl.style.width).toBe('1080px');
    expect(pageEl.style.height).toBe('1080px');
    expect(pageEl.style.transform).toMatch(/^scale\([0-9.]+\)$/);
    expect(pageEl.style.transformOrigin).toBe('top left');
    expect(pageEl.style.backgroundColor).toBe(rgb('#faf7f2'));
  });

  it('PV2/PV7/77 a rectangle: its box, opacity, rotation around the center and stored radius', async () => {
    await renderWorkspace();
    const card = previewLayer('card') as HTMLElement;
    expect(card.style.left).toBe('10px');
    expect(card.style.top).toBe('20px');
    expect(card.style.width).toBe('300px');
    expect(card.style.height).toBe('150px');
    expect(card.style.opacity).toBe('0.5');
    expect(card.style.transform).toBe('rotate(30deg)');
    expect(card.style.transformOrigin).toBe('center center');
    expect(card.style.borderRadius).toBe('24px');
    expect(card.style.backgroundColor).toBe(rgb('#ff0000'));
  });

  it('PV3 an ellipse is fully rounded', async () => {
    await renderWorkspace();
    const dot = previewLayer('dot') as HTMLElement;
    expect(dot.style.borderRadius).toBe('50%');
    expect(dot.style.backgroundColor).toBe(rgb('#00ff00'));
  });

  it('PV4/PV10/PV9/79 text: requested geometry and style, newlines kept, a tab as four spaces', async () => {
    await renderWorkspace();
    const headline = previewLayer('headline') as HTMLElement;
    expect(headline.textContent).toBe('Hello    world\nSecond line');
    expect(headline.style.whiteSpace).toBe('pre-wrap');
    expect(headline.style.fontSize).toBe('64px');
    expect(headline.style.lineHeight).toBe('1.25');
    expect(headline.style.letterSpacing).toBe('2px');
    expect(headline.style.textAlign).toBe('center');
    expect(headline.style.justifyContent).toBe('center');
    expect(headline.style.overflow).toBe('hidden');
    expect(headline.style.left).toBe('100px');
    expect(headline.style.width).toBe('880px');
    // shrink is the server's: the requested size is drawn and clipped
    expect(api.newContentStudioDesignDocument).toBeTruthy();
  });

  it('PV5/73 a hidden layer is not drawn but stays in the list', async () => {
    await renderWorkspace();
    expect(previewLayer('ghost')).toBeNull();
    expect(layerButtons()).toContain('▭GhostHidden');
  });

  it('PV6/74 a layer at opacity 0 is drawn, invisibly, and selectable', async () => {
    await renderWorkspace();
    expect((previewLayer('invisible') as HTMLElement).style.opacity).toBe('0');
    await selectLayer('^Rectangle$');
    expect(facts()).toMatchObject({ Opacity: '0' });
  });

  it('PV8/75 nothing outside the page shows, and the inspector keeps the geometry', async () => {
    await renderWorkspace();
    expect(previewPage().style.overflow).toBe('hidden');
    const frame = document.querySelector(
      '[data-preview="frame"]'
    ) as HTMLElement;
    expect(frame.className).toContain('overflow-hidden');
    expect((previewLayer('offcanvas') as HTMLElement).style.left).toBe(
      '1500px'
    );
    await selectLayer('Off canvas');
    expect(facts()).toMatchObject({ Position: '1500, -400' });
  });

  it('PV11/PV12/58/92 an image is a placeholder: no src, href or background image from the document', async () => {
    await renderWorkspace();
    const photo = previewLayer('photo') as HTMLElement;
    expect(photo.textContent).toBe('Image');
    expect(
      previewPage().querySelectorAll('img, a, [src], [href]')
    ).toHaveLength(0);
    expect(previewPage().innerHTML).not.toMatch(
      /url\(|photo-1|background-image/
    );
    expect(gets('/media')).toEqual([]);
  });

  it('PV13/PV14 says it is a live preview and points to the server render', async () => {
    await renderWorkspace();
    expect(screen.getByText('Live preview')).toBeTruthy();
    expect(
      screen.getByText(
        'Final typography and image rendering may differ. Use Render page for the authoritative output.'
      )
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /pixel[- ]perfect|exact preview|identical/i
    );
  });

  it('XS-D4/XS-D5/XS-D6/XS-D7 text with markup stays text: no script, img or b element', async () => {
    await renderWorkspace();
    const xss = previewLayer('xss') as HTMLElement;
    expect(xss.textContent).toBe(XSS_TEXT);
    expect(document.querySelectorAll('script')).toHaveLength(0);
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(document.querySelectorAll('[onerror]')).toHaveLength(0);
    expect(document.querySelectorAll('b')).toHaveLength(0);
    await selectLayer('Layer');
    expect(document.querySelectorAll('script, img, b, [onerror]')).toHaveLength(
      0
    );
  });
});

// ============================================================================
describe('Creative Studio: Brand Kit revision', () => {
  const brandGets = () => gets('/content-studio/brand-kit');

  it('BR-UI1 a design without a Brand Kit says so and loads none', async () => {
    await renderWorkspace(EMPTY.id);
    expect(screen.getByText('No Brand Kit revision attached')).toBeTruthy();
    expect(brandGets()).toEqual([]);
  });

  it('BR-UI2/BR-UI9 loads exactly the pinned revision, never the current kit, and says it is pinned', async () => {
    await renderWorkspace();
    expect(brandGets().map((c) => c.url)).toEqual([
      `/content-studio/brand-kit/revisions/${BRAND_REV}`,
    ]);
    expect(screen.getByText('Brand Kit · Revision 3')).toBeTruthy();
    expect(
      screen.getByText(
        'Pinned revision. This design is pinned to a specific Brand Kit revision.'
      )
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /latest|current Brand Kit|follows/i
    );
  });

  it(
    'BR-UI3/71 a revision whose number, hash or id is not the reference is not used',
    async () => {
      for (const change of [
        { revisionNumber: 4 },
        { contentHash: SHA('d') },
        { id: '11111111-1111-4111-8111-111111111111' },
        { content: { ...KIT, colors: 'nope' } },
      ]) {
        brandRevisions[BRAND_REV] = { ...brandRevisions[BRAND_REV], ...change };
        await renderWorkspace();
        expect(
          screen.getByText('Brand Kit revision could not be loaded.')
        ).toBeTruthy();
        expect(previewPage().getAttribute('data-unresolved')).toBe('color');
        expect(previewPage().style.backgroundColor).toBe('');
        // the server render stays available: it checks for itself
        expect(button('Render page').className).not.toContain('opacity-50');
        cleanup();
        brandRevisions[BRAND_REV] = {
          id: BRAND_REV,
          revisionNumber: 3,
          schemaVersion: 1,
          contentHash: SHA('c'),
          createdAt: T0,
          content: KIT,
        };
      }
    },
    LOOP_TIMEOUT
  );

  it('BR-UI3 a revision that cannot be loaded leaves the literal parts visible', async () => {
    delete brandRevisions[BRAND_REV];
    await renderWorkspace();
    expect(
      screen.getByText('Brand Kit revision could not be loaded.')
    ).toBeTruthy();
    expect((previewLayer('card') as HTMLElement).style.backgroundColor).toBe(
      rgb('#ff0000')
    );
    expect(layerButtons()).toHaveLength(9);
  });

  it('BR-UI4/BR-UI5 literal colors as given, Brand colors from the exact revision', async () => {
    await renderWorkspace();
    expect((previewLayer('card') as HTMLElement).style.backgroundColor).toBe(
      rgb('#ff0000')
    );
    expect(
      (previewLayer('backdrop') as HTMLElement).style.backgroundColor
    ).toBe(rgb('#faf7f2'));
    expect((previewLayer('headline') as HTMLElement).style.color).toBe(
      rgb('#1a1a1a')
    );
  });

  it('BR-UI6/38/M18 a missing color token gets no fallback color, only a neutral outline and a warning', async () => {
    await renderWorkspace();
    await click(pageButton(/Page 3/));
    const missing = previewLayer('missing-color') as HTMLElement;
    expect(missing.getAttribute('data-unresolved')).toBe('color');
    expect(missing.style.backgroundColor).toBe('');
    expect(missing.className).toContain('outline-dashed');
    await selectLayer('Missing color');
    expect(facts()).toMatchObject({ Fill: 'Brand color unavailable.' });
  });

  it('BR-UI7/39 a Brand type style becomes plain CSS font properties', async () => {
    await renderWorkspace();
    const headline = previewLayer('headline') as HTMLElement;
    expect(headline.style.fontFamily).toBe('Poppins');
    expect(headline.style.fontWeight).toBe('700');
    expect(headline.style.fontStyle).toBe('normal');
    const xss = previewLayer('xss') as HTMLElement;
    expect(xss.style.fontFamily).toBe('Inter');
    expect(xss.style.fontWeight).toBe('400');
  });

  it('39 a missing type style gets no font, only the outline and a warning', async () => {
    // the server would refuse to save this; the browser still must not guess
    latest(MAIN).content.pages[0].layers[7].font = tok('missing');
    await renderWorkspace();
    const headline = previewLayer('headline') as HTMLElement;
    expect(headline.getAttribute('data-unresolved')).toBe('font');
    expect(headline.style.fontFamily).toBe('');
    await selectLayer('Headline');
    expect(facts()).toMatchObject({ Font: 'Brand font unavailable.' });
  });

  it('BR-UI8 loads no web font', async () => {
    await renderWorkspace();
    expect(document.querySelectorAll('link, style')).toHaveLength(0);
    expect(document.body.innerHTML).not.toMatch(/@font-face|url\(/);
    expect(
      calls().every((c) =>
        /^\/content-studio\/(designs|brand-kit\/revisions)\//.test(c.url)
      )
    ).toBe(true);
  });
});

// ============================================================================
describe('Creative Studio: revision history', () => {
  it('RV1 lists the revisions in the server order with the current one marked', async () => {
    await renderWorkspace();
    const history = screen.getByRole('heading', { name: 'Revision history' })
      .parentElement as HTMLElement;
    const items = within(history).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      `Revision 2Current${date(T1)}Shown`,
      `Revision 1${date(T0)}View`,
    ]);
  });

  it('RV1/94 pages through the history, and paging does not change what is shown', async () => {
    MAIN.revisions = [
      ...MAIN.revisions,
      ...Array.from({ length: 23 }, (_, i) => revision(i + 3, MAIN_V2())),
    ];
    await renderWorkspace();
    expect(
      screen.getByRole('button', { name: 'View Revision 25' })
    ).toBeTruthy();
    await viewRevision(24);
    await click(button('Next'));
    expect(gets(`${designPath(MAIN)}/revisions?`).map((c) => c.url)).toEqual([
      `${designPath(MAIN)}/revisions?page=1`,
      `${designPath(MAIN)}/revisions?page=2`,
    ]);
    expect(screen.getByText('Viewing revision 24')).toBeTruthy();
  });

  it('RV3/RV5/RV7 opening an older revision loads exactly it and shows exactly its content, read-only', async () => {
    await renderWorkspace();
    await viewRevision(1);
    expect(gets(`${designPath(MAIN)}/revisions/`).map((c) => c.url)).toEqual([
      `${designPath(MAIN)}/revisions/${MAIN.revisions[0].id}`,
    ]);
    expect(screen.getByText('Viewing revision 1')).toBeTruthy();
    expect(screen.getByText('Read-only historical revision')).toBeTruthy();
    expect(header()).toContain('Revision 1 · Historical');
    expect(layerButtons()).toEqual(['▭First only shape']);
    // P4-16: a page card also shows its size
    expect(pageButton(/Page 1/).textContent).toBe(
      'Page 1First draft1080 × 1080'
    );
    expect(screen.getByText('No Brand Kit revision attached')).toBeTruthy();
  });

  it('RV4/RV6/96 back to current, and the opened revision is never fetched again', async () => {
    await renderWorkspace();
    await viewRevision(1);
    await click(button('Back to current'));
    expect(screen.queryByText('Viewing revision 1')).toBeNull();
    expect(header()).toContain('Revision 2');
    expect(header()).not.toContain('Historical');
    await viewRevision(1);
    await click(button('Back to current'));
    await viewRevision(1);
    expect(gets(`${designPath(MAIN)}/revisions/`)).toHaveLength(1);
  });

  it('RV8/M10 there is no way to restore, revert or save a revision', async () => {
    await renderWorkspace();
    await viewRevision(1);
    expect(
      // P4-11: Save as template copies a revision into a new template
      queryButton(
        /restore revision|revert|roll ?back|make current|save(?! as template)/i
      )
    ).toBeNull();
    expect(writes()).toEqual([]);
  });

  it(
    'RV10/70 a missing, unsafe or unloadable revision has fixed messages',
    async () => {
      for (const [status, code, message] of [
        [404, 'CS_NOT_FOUND', 'This design revision is no longer available.'],
        [
          500,
          'CS_DESIGN_INTEGRITY_ERROR',
          'Stored design data could not be read safely.',
        ],
        [500, 'CS_OTHER', 'Design revision could not be loaded.'],
      ] as const) {
        override = (method, url) =>
          method === 'GET' && url.startsWith(`${designPath(MAIN)}/revisions/`)
            ? failWith(status, code)
            : undefined;
        await renderWorkspace();
        await viewRevision(1);
        expect(screen.getByRole('alert').textContent).toBe(message);
        expect(button('Back to current')).toBeTruthy();
        cleanup();
      }
      override = () => undefined;
      MAIN.revisions[0].content = { pages: 'not a document' };
      await renderWorkspace();
      await viewRevision(1);
      expect(screen.getByRole('alert').textContent).toBe(
        'Stored design data could not be read safely.'
      );
    },
    LOOP_TIMEOUT
  );
});

// ============================================================================
describe('Creative Studio: render a page', () => {
  const renderPosts = () => posts('/render');

  it('RP-UI1/M24 renders only when asked: never on open or when a page is chosen', async () => {
    await renderWorkspace();
    await selectLayer('Headline');
    await click(pageButton(/Page 2/));
    await viewRevision(1);
    expect(writes()).toEqual([]);
  });

  it('RP-UI2/RP-UI3/120 posts exactly the shown revision and page to the render route', async () => {
    await renderWorkspace();
    await click(pageButton(/Page 2/));
    await click(button('Render page'));
    expect(renderPosts()).toEqual([
      {
        method: 'POST',
        url: `${designPath(MAIN)}/render`,
        body: JSON.stringify({
          revisionId: latest(MAIN).id,
          pageId: 'p_body',
        }),
      },
    ]);
  });

  it('RP-UI4/RP-UI5/87/M23 one render at a time: a double click and Render all wait', async () => {
    const gate = deferred();
    override = (method, url) =>
      method === 'POST' && url.endsWith('/render') ? gate.promise : undefined;
    await renderWorkspace();
    fireEvent.click(button('Render page'));
    fireEvent.click(button('Render page'));
    await flush();
    expect(button('Render all pages').className).toContain('opacity-50');
    fireEvent.click(button('Render all pages'));
    await flush();
    expect(writes()).toHaveLength(1);
    override = () => undefined;
    gate.resolve(
      server('POST', `${designPath(MAIN)}/render`, {
        revisionId: latest(MAIN).id,
        pageId: 'p_intro',
      })
    );
    await flush();
    expect(button('Render all pages').className).not.toContain('opacity-50');
  });

  it('RP-UI6/RV9/M9/M20 an opened older revision renders exactly that revision', async () => {
    await renderWorkspace();
    await viewRevision(1);
    await click(button('Render page'));
    expect(bodyOf(renderPosts()[0])).toEqual({
      revisionId: MAIN.revisions[0].id,
      pageId: 'p_intro',
    });
    expect(screen.getByText('Rendered revision 1')).toBeTruthy();
  });

  it('RP-UI7 an archived design renders', async () => {
    await renderWorkspace(OLD.id);
    await click(button('Render page'));
    expect(renderPosts()).toHaveLength(1);
    expect(toasts()).toEqual(['Page rendered.']);
  });

  it('RP-UI8/91/62 shows the rendered page from its Media record, and reloads no design', async () => {
    await renderWorkspace();
    const before = calls().length;
    await click(button('Render page'));
    const result = screen.getByRole('region', { name: 'Rendered page' });
    expect(result.textContent).toContain('Rendered revision 2');
    expect(result.textContent).toContain('Page 1 · Intro');
    expect(result.textContent).toContain('1080 × 1080');
    const img = within(result).getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(
      'https://cdn.test/uploads/render-media-1.png'
    );
    expect(img.getAttribute('src')).not.toBe('render-media-1');
    expect(
      calls()
        .slice(before)
        .map((c) => `${c.method} ${c.url}`)
    ).toEqual([
      `POST ${designPath(MAIN)}/render`,
      'GET /media/render-media-1/status',
    ]);
    expect(result.textContent).not.toMatch(/[0-9a-f]{64}|render-media-1/);
  });

  it('RP-UI8/129 without a usable Media record it says the Media was created, and never uses a non-web URL', async () => {
    override = (method, url) =>
      method === 'GET' && url.startsWith('/media/')
        ? reply(200, {
            id: 'render-media-1',
            path: 'javascript:alert(1)',
            thumbnail: '//evil.test/x.png',
            alt: null,
          })
        : undefined;
    await renderWorkspace();
    await click(button('Render page'));
    const result = screen.getByRole('region', { name: 'Rendered page' });
    expect(within(result).queryByRole('img')).toBeNull();
    expect(result.textContent).toContain('Rendered media created.');
    cleanup();
    override = (method, url) =>
      method === 'GET' && url.startsWith('/media/')
        ? reply(404, { message: SECRET })
        : undefined;
    await renderWorkspace();
    await click(button('Render page'));
    expect(screen.getByText('Rendered media created.')).toBeTruthy();
  });

  it('RP-UI9/88/89 a result keeps the revision and page it was asked for', async () => {
    const gate = deferred();
    override = (method, url) =>
      method === 'POST' && url.endsWith('/render') ? gate.promise : undefined;
    await renderWorkspace();
    await click(pageButton(/Page 3/));
    fireEvent.click(button('Render page'));
    await flush();
    await viewRevision(1);
    override = () => undefined;
    gate.resolve(
      server('POST', `${designPath(MAIN)}/render`, {
        revisionId: latest(MAIN).id,
        pageId: 'p_cta',
      })
    );
    await flush();
    const result = screen.getByRole('region', { name: 'Rendered page' });
    expect(result.textContent).toContain('Rendered revision 2');
    expect(result.textContent).toContain('Page 3 · CTA');
    expect(screen.getByText('Viewing revision 1')).toBeTruthy();
  });

  it('90 a failed render keeps the previous result', async () => {
    await renderWorkspace();
    await click(button('Render page'));
    override = (method, url) =>
      method === 'POST' && url.endsWith('/render')
        ? failWith(500, 'CS_DESIGN_RENDER_FAILED')
        : undefined;
    await click(button('Render page'));
    expect(screen.getByRole('region', { name: 'Rendered page' })).toBeTruthy();
    expect(toasts()).toEqual([
      'Page rendered.',
      'The design could not be rendered.',
    ]);
  });

  it(
    'RP-UI10/53/100/M25 every render error has a fixed message, never the server text',
    async () => {
      const cases: Array<[number, string, string]> = [
        [
          400,
          'CS_DESIGN_RENDER_PAGE_INVALID',
          'This page is no longer available in the selected revision.',
        ],
        [
          409,
          'CS_DESIGN_RENDER_ASSET_UNAVAILABLE',
          'A font or image required by this design is unavailable.',
        ],
        [
          500,
          'CS_DESIGN_RENDER_ASSET_INTEGRITY_ERROR',
          'A stored design asset could not be verified.',
        ],
        [
          500,
          'CS_DESIGN_RENDER_BRAND_INTEGRITY_ERROR',
          'The Brand Kit revision for this design could not be read safely.',
        ],
        [
          500,
          'CS_DESIGN_RENDER_STORAGE_FAILED',
          'The rendered design could not be stored.',
        ],
        [500, 'CS_DESIGN_RENDER_FAILED', 'The design could not be rendered.'],
        [
          503,
          'CS_RENDER_FONT_STORAGE_UNAVAILABLE',
          'Private render font storage is not configured. Ask an administrator to configure render font storage.',
        ],
        [
          413,
          'CS_DESIGN_RENDER_BATCH_TOO_LARGE',
          'This design uses too much source media to render all pages at once.',
        ],
        [
          404,
          'CS_DESIGN_REVISION_NOT_FOUND',
          'This design revision is no longer available.',
        ],
        [
          500,
          'CS_DESIGN_INTEGRITY_ERROR',
          'Stored design data could not be read safely.',
        ],
        [404, 'CS_NOT_FOUND', 'Design not found.'],
        [
          500,
          'CS_SOMETHING_NEW',
          'Something went wrong while rendering the design.',
        ],
      ];
      for (const [status, code, message] of cases) {
        mockToast.mockReset();
        override = (method, url) =>
          method === 'POST' && url.endsWith('/render')
            ? failWith(status, code)
            : undefined;
        await renderWorkspace();
        await click(button('Render page'));
        expect([code, toasts()]).toEqual([code, [message]]);
        expect(
          screen.queryByRole('region', { name: 'Rendered page' })
        ).toBeNull();
        cleanup();
      }
      expect(
        api.designRenderErrorMessage(
          (_k: string, f: string) => f,
          new Error(SECRET),
          'page'
        )
      ).toBe('Something went wrong while rendering the design.');
    },
    LOOP_TIMEOUT
  );
});

// ============================================================================
describe('Creative Studio: render all pages', () => {
  const renderAllPosts = () => posts('/render-all');

  it('RA-UI1/RA-UI2/RA-UI3/M21 posts the shown revision only: no pages, order or settings', async () => {
    await renderWorkspace();
    await click(pageButton(/Page 2/));
    await click(button('Render all pages'));
    expect(renderAllPosts()).toEqual([
      {
        method: 'POST',
        url: `${designPath(MAIN)}/render-all`,
        body: JSON.stringify({ revisionId: latest(MAIN).id }),
      },
    ]);
    expect(posts('/render')).toEqual([]);
  });

  it('RA-UI4 one render of all pages at a time, and Render page waits', async () => {
    const gate = deferred();
    override = (method, url) =>
      method === 'POST' && url.endsWith('/render-all')
        ? gate.promise
        : undefined;
    await renderWorkspace();
    fireEvent.click(button('Render all pages'));
    fireEvent.click(button('Render all pages'));
    fireEvent.click(button('Render page'));
    await flush();
    expect(writes()).toHaveLength(1);
    expect(button('Render page').className).toContain('opacity-50');
    override = () => undefined;
    gate.resolve(
      server('POST', `${designPath(MAIN)}/render-all`, {
        revisionId: latest(MAIN).id,
      })
    );
    await flush();
  });

  it('RA-UI5/RA-UI6/RA-UI7/M22 shows every output in the server order with its page number and size', async () => {
    await renderWorkspace();
    await click(button('Render all pages'));
    const result = screen.getByRole('region', { name: 'Rendered pages' });
    expect(result.textContent).toContain('Rendered revision 2');
    const items = within(result).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'Page 1 · Intro1080 × 1080Completed',
      'Page 2' + '1080 × 1350Completed',
      `Page 3 · CTA <img src=x onerror=alert(3)> ${HTML_MARKER}1080 × 1080Completed`,
    ]);
    expect(
      items.map((li) =>
        (within(li).getByRole('img') as HTMLImageElement).getAttribute('src')
      )
    ).toEqual([
      'https://cdn.test/uploads/render-media-1.png',
      'https://cdn.test/uploads/render-media-2.png',
      'https://cdn.test/uploads/render-media-3.png',
    ]);
    expect(toasts()).toEqual(['All pages rendered.']);
  });

  it('RA-UI5 keeps an order the server gives, whatever the page ids', async () => {
    override = (method, url) =>
      method === 'POST' && url.endsWith('/render-all')
        ? reply(200, {
            id: nextId(),
            designProjectId: MAIN.id,
            designRevisionId: latest(MAIN).id,
            designRevisionNumber: 2,
            status: 'completed',
            pageCount: 2,
            outputs: [
              {
                renderId: 'r-z',
                pageId: 'p_cta',
                pageIndex: 0,
                width: 10,
                height: 20,
                mimeType: 'image/png',
                renderedMediaId: 'm-z',
              },
              {
                renderId: 'r-a',
                pageId: 'p_body',
                pageIndex: 1,
                width: 30,
                height: 40,
                mimeType: 'image/png',
                renderedMediaId: 'm-a',
              },
            ],
            createdAt: T2,
            completedAt: T2,
          })
        : undefined;
    await renderWorkspace();
    await click(button('Render all pages'));
    const items = within(
      screen.getByRole('region', { name: 'Rendered pages' })
    ).getAllByRole('listitem');
    expect(items.map((li) => li.textContent?.slice(0, 12))).toEqual([
      'Page 1 · CTA',
      'Page 230 × 4',
    ]);
  });

  it('RA-UI8 an opened older revision renders exactly that revision', async () => {
    await renderWorkspace();
    await viewRevision(1);
    await click(button('Render all pages'));
    expect(bodyOf(renderAllPosts()[0])).toEqual({
      revisionId: MAIN.revisions[0].id,
    });
    expect(screen.getByText('Rendered revision 1')).toBeTruthy();
  });

  it(
    'RA-UI9/RA-UI10/RA-UI11/52/M26 failures have fixed messages and never say that nothing was made',
    async () => {
      for (const [status, code, message] of [
        [500, 'CS_DESIGN_RENDER_FAILED', 'The design could not be rendered.'],
        [500, 'CS_SOMETHING_NEW', 'The design could not be fully rendered.'],
        [
          413,
          'CS_DESIGN_RENDER_BATCH_TOO_LARGE',
          'This design uses too much source media to render all pages at once.',
        ],
        [
          503,
          'CS_RENDER_FONT_STORAGE_UNAVAILABLE',
          'Private render font storage is not configured. Ask an administrator to configure render font storage.',
        ],
        [
          500,
          'CS_DESIGN_RENDER_STORAGE_FAILED',
          'The rendered design could not be stored.',
        ],
      ] as const) {
        mockToast.mockReset();
        override = (method, url) =>
          method === 'POST' && url.endsWith('/render-all')
            ? failWith(status, code)
            : undefined;
        await renderWorkspace();
        await click(button('Render all pages'));
        expect(toasts()).toEqual([message]);
        for (const text of [...toasts(), document.body.textContent as string]) {
          expect(text).not.toMatch(
            /nothing was|no pages were|none of the pages|not created/i
          );
        }
        cleanup();
      }
    },
    LOOP_TIMEOUT
  );
});

// ============================================================================
describe('Creative Studio: frontend boundaries', () => {
  const dir = __dirname;
  const routes = join(dir, '../../app/(app)/(site)/content-studio/designs');
  const FILES = [
    'content-studio.designs.api.ts',
    'content-studio.designs.tsx',
    'content-studio.design.workspace.tsx',
    'content-studio.design.preview.tsx',
    'content-studio.design.editor.ts',
    'content-studio.design.editing.tsx',
  ];
  const ROUTES = ['page.tsx', '[id]/page.tsx'];
  // code only: comments may name what the code must not do
  const code = (text: string) =>
    text
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
  const sources = [
    ...FILES.map((file) => [file, readFileSync(join(dir, file), 'utf8')]),
    ...ROUTES.map((file) => [file, readFileSync(join(routes, file), 'utf8')]),
  ] as const;

  it('65/4 the Content Studio home links to Creative Studio; the top menu keeps one Content Studio entry', () => {
    const home = readFileSync(join(dir, 'content-studio.home.tsx'), 'utf8');
    expect(home).toContain('href="/content-studio/designs"');
    expect(home).toContain(
      "t('content_studio_creative_studio', 'Creative Studio')"
    );
    const menu = readFileSync(join(dir, '../layout/top.menu.tsx'), 'utf8');
    expect(menu.match(/path: '\/content-studio/g)).toHaveLength(1);
  });

  it('4 the route pages are thin', () => {
    expect(existsSync(join(routes, 'page.tsx'))).toBe(true);
    expect(code(readFileSync(join(routes, 'page.tsx'), 'utf8'))).toContain(
      'return <ContentStudioDesigns />;'
    );
    expect(code(readFileSync(join(routes, '[id]/page.tsx'), 'utf8'))).toContain(
      'return <ContentStudioDesignWorkspace key={id} designId={id} />;'
    );
    expect(readdirSync(routes).sort()).toEqual(['[id]', 'page.tsx']);
  });

  it('84/119/M28/M29 no Fabric, canvas, editor, renderer, Sharp, fontkit, server crypto or Node module', () => {
    for (const [file, text] of sources) {
      const body = code(text);
      expect([file, body]).not.toEqual([
        file,
        expect.stringMatching(
          /from '(fabric|konva|pixi[^']*|canvas|playwright|puppeteer|sharp|fontkit|crypto|node:[^']*|fs|path|os|child_process|@prisma\/client|@nestjs\/[^']*)'|require\(|<canvas|getContext\(/
        ),
      ]);
      expect([file, body]).not.toEqual([
        file,
        expect.stringMatching(
          /design\/layout|design\/render|layoutContentStudioDesign|renderContentStudioDesignPage|brand\.kit\.revision|canonical\.json|design\.document\.revision/
        ),
      ]);
    }
  });

  it('101/119/M31 no browser storage, logging, environment or external fetch', () => {
    for (const [file, text] of sources) {
      expect([file, code(text)]).not.toEqual([
        file,
        expect.stringMatching(
          /localStorage|sessionStorage|indexedDB|document\.cookie|console\.|process\.env|\bfetch\(\s*['`]https?:|XMLHttpRequest|WebSocket|new Image\(|FontFace|@font-face|fonts\.googleapis/
        ),
      ]);
    }
  });

  it('34/119/M15/M32/PV15 no raw HTML, SVG or style text', () => {
    for (const [file, text] of sources) {
      expect([file, text]).not.toEqual([
        file,
        expect.stringMatching(
          /dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|<svg|cssText|style=\{`|style="/
        ),
      ]);
    }
  });

  // P4-08 adds the revision save, the two server-made design references,
  // the Brand Kit revision list and one page of the Media library
  it('120/86/P408-6/P408-10/P408-12 requests only the design, Brand Kit, design reference and Media routes, with exact bodies; never a font route', () => {
    const api = code(
      readFileSync(join(dir, 'content-studio.designs.api.ts'), 'utf8')
    );
    const routesUsed = Array.from(
      api.matchAll(/['`](\/(?:content-studio|media)[^'`]*)['`]/g),
      (m) => m[1]
    );
    expect(routesUsed.sort()).toEqual(
      [
        '/content-studio/designs',
        '/content-studio/brand-kit/revisions/${encodeURIComponent(revisionId)}',
        '/media/${encodeURIComponent(id)}/status',
        '/content-studio/brand-kit',
        '/media?${params.toString()}',
        '/content-studio/media/${encodeURIComponent(mediaId)}/design-ref',
      ].sort()
    );
    // P4-17: a new design from a page set is a second POST to /designs
    expect(api.match(/method: '(\w+)'/g)).toEqual([
      "method: 'POST'",
      "method: 'POST'",
      "method: 'PATCH'",
      "method: 'POST'",
      "method: 'POST'",
      "method: 'POST'",
      "method: 'POST'",
      "method: 'POST'",
    ]);
    expect(api).toMatch(/`\$\{designPath\(id\)\}\/render`/);
    expect(api).toMatch(/`\$\{designPath\(id\)\}\/render-all`/);
    expect(api).toMatch(/`\$\{designPath\(id\)\}\/revisions`/);
    expect(api).toMatch(
      /`\$\{brandKitRevisionPath\(revisionId\)\}\/design-ref`/
    );
    for (const [file, text] of sources) {
      expect([file, code(text)]).not.toEqual([
        file,
        expect.stringMatching(
          /render-fonts|'DELETE'|organizationId|userId|mediaIds|fontBytes|upload/i
        ),
      ]);
    }
    // every request body there is (the editor's JSON copies are not requests)
    expect(
      Array.from(api.matchAll(/JSON\.stringify\(([^)]*)\)/g), (m) => m[1])
    ).toEqual([
      '{ name, content }',
      // P4-17: a page set by its id only, never pages
      '{ name, pageSetId }',
      '{ name }',
      '{ revisionId, pageId }',
      '{ baseRevisionNumber, content }',
      '{ revisionId }',
    ]);
  });

  // P4-11 adds design templates; the rest stays out
  it('no AI, Source, upload or composer code', () => {
    for (const [file, text] of sources) {
      expect([file, code(text)]).not.toEqual([
        file,
        expect.stringMatching(
          /ai-writing|ai\.proposal|intelligence\.api|sources\.api|openai|anthropic|upload|new-launch|launches\/|handoff|media\.component/i
        ),
      ]);
    }
  });

  it('92 a Media id is never used as an image source or link', () => {
    const workspace = code(
      readFileSync(join(dir, 'content-studio.design.workspace.tsx'), 'utf8')
    );
    expect(workspace).not.toMatch(
      /src=\{[^}]*MediaId|href=\{[^}]*MediaId|src=\{[^}]*mediaId/
    );
    expect(workspace.match(/src=\{/g)).toEqual(['src={']);
    expect(workspace).toContain('src={src}');
  });
});
