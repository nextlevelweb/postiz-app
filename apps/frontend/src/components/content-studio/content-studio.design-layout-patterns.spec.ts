import {
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
  within,
} from '@testing-library/react';
import { SWRConfig } from 'swr';
import { readFileSync } from 'fs';
import { join } from 'path';
import { TextEncoder as NodeTextEncoder } from 'util';

// Creative Studio layouts and composition (P4-15): the composition controls
// of the Arrange panel, the Layouts panel (browse, insert with exact Brand
// Kit tokens and Media, save the selection, edit, archive, restore), and the
// same in the template workspace. A .spec.ts without JSX, like the other
// Content Studio frontend specs: components are required, not imported. The
// Fabric adapter is an inert stand-in (direct canvas editing has its own
// spec)
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
const {
  ContentStudioDesignTemplateWorkspace,
} = require('./content-studio.design-template.workspace');

type Plain = Record<string, any>;
type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const SECRET = 'LAYOUT_PATTERN_SERVER_SECRET_123';
const T0 = '2026-10-18T10:00:00.000Z';
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const lit = (value: string) => ({ type: 'literal', value });
const tok = (tokenId: string) => ({ type: 'brand', tokenId });
const KIT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const REV = 'aaaaaaaa-0000-4000-8000-000000000001';
const BRAND = {
  id: REV,
  revisionNumber: 3,
  schemaVersion: 1,
  contentHash: SHA('b'),
  createdAt: T0,
  content: {
    schemaVersion: 1,
    identity: { brandName: 'Northwind', tagline: '', description: '' },
    colors: [
      { id: 'primary', name: 'Primary', value: '#0057ff', role: 'primary' },
    ],
    typography: [],
    visualDirection: { keywords: [], dos: [], donts: [] },
  },
};
const BRAND_REF = {
  brandKitId: KIT,
  revisionId: REV,
  revisionNumber: 3,
  contentHash: SHA('b'),
};
const base = {
  x: 10,
  y: 20,
  width: 300,
  height: 100,
  rotation: 5,
  opacity: 1,
  visible: true,
};
const TITLE = {
  ...base,
  id: 'title',
  name: 'Title',
  type: 'text',
  text: 'Hello world',
  font: { type: 'family', family: 'Inter', weight: 400, style: 'normal' },
  fontSize: 40,
  lineHeight: 1.2,
  letterSpacing: 0,
  color: lit('#111111'),
  align: 'left',
  verticalAlign: 'top',
  overflow: 'clip',
};
const BOX = {
  ...base,
  x: 410,
  y: 520,
  id: 'box',
  name: 'Box',
  type: 'shape',
  shape: 'rectangle',
  fill: lit('#ff0000'),
  cornerRadius: 0,
};
const PHOTO = {
  ...base,
  rotation: 0,
  id: 'photo',
  name: 'Photo',
  type: 'image',
  imageRef: { type: 'media', mediaId: 'media-1', sha256: SHA('a') },
  fit: 'cover',
  focalPoint: { x: 0.5, y: 0.5 },
};
const extra = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    ...BOX,
    id: `filler_${i}`,
    name: `Filler ${i}`,
  }));
const doc = (brandKit: Plain | null = null, more: Plain[] = []) => ({
  schemaVersion: 1,
  brandKit,
  pages: [
    {
      id: 'p_one',
      name: 'One',
      width: 1080,
      height: 1080,
      background: { type: 'solid', color: lit('#ffffff') },
      layers: [TITLE, BOX, PHOTO, ...more].map((l) =>
        JSON.parse(JSON.stringify(l))
      ),
    },
  ],
});
const box = (x: number, y: number, width: number, height: number) => ({
  name: '',
  x,
  y,
  width,
  height,
  rotation: 0,
  opacity: 1,
  visible: true,
});
const CARD_CONTENT = {
  schemaVersion: 1,
  width: 400,
  height: 200,
  layers: [
    {
      ...box(0, 0, 400, 200),
      name: 'Card',
      type: 'shape',
      shape: 'rectangle',
      fill: lit('#f3f4f6'),
      cornerRadius: 24,
    },
    {
      ...box(20, 40, 360, 80),
      name: 'Heading',
      type: 'text',
      text: 'Your headline',
      font: { type: 'family', family: 'Inter', weight: 700, style: 'normal' },
      fontSize: 48,
      lineHeight: 1.2,
      letterSpacing: 0,
      color: lit('#111827'),
      align: 'left',
      verticalAlign: 'top',
      overflow: 'shrink',
    },
  ],
};
const BANNER_CONTENT = {
  schemaVersion: 1,
  width: 200,
  height: 100,
  layers: [
    {
      ...box(0, 0, 200, 100),
      name: 'Banner',
      type: 'shape',
      shape: 'rectangle',
      fill: tok('primary'),
      cornerRadius: 0,
    },
  ],
};
const FRAME_CONTENT = {
  schemaVersion: 1,
  width: 300,
  height: 300,
  layers: [
    {
      ...box(0, 0, 300, 300),
      name: 'Framed photo',
      type: 'image',
      imageRef: { type: 'media', mediaId: 'media-1', sha256: SHA('a') },
      fit: 'contain',
      focalPoint: { x: 0.25, y: 0.75 },
      mask: { type: 'ellipse' },
    },
  ],
};
const SYSTEM = [
  {
    source: 'system',
    id: 'system:layout-title-card',
    name: 'Title card',
    description: 'A card with a heading.',
    archivedAt: null,
    contentHash: SHA('1'),
    content: CARD_CONTENT,
  },
];

let counter = 0;
const nextId = () =>
  `${String(++counter).padStart(8, '0')}-0000-4000-8000-000000000000`;
type Pattern = {
  id: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  content: any;
};
let patterns: Pattern[];
let mediaSha: string;
let design: { id: string; revisions: any[] };
let template: { id: string; revisions: any[] };
let override: (method: string, url: string, body: any) => Reply | undefined;
const orgPattern = (p: Pattern) => ({
  source: 'organization',
  ...p,
  createdAt: T0,
  updatedAt: T0,
  contentHash: SHA('p'),
});
const meta = (r: any) => ({
  id: r.id,
  revisionNumber: r.revisionNumber,
  schemaVersion: 1,
  contentHash: SHA(String(r.revisionNumber)),
  createdAt: T0,
});

const server = (method: string, url: string, body: any): Reply => {
  const { pathname, searchParams } = new URL(url, 'https://api.test');
  const P = '/content-studio/design-layout-patterns';
  if (pathname === P && method === 'GET') {
    const archived = searchParams.get('archived') === 'true';
    return reply(200, {
      system: archived ? [] : SYSTEM,
      pages: 1,
      results: patterns
        .filter((p) => !!p.archivedAt === archived)
        .map(orgPattern),
    });
  }
  if (pathname === P && method === 'POST') {
    const p: Pattern = {
      id: nextId(),
      name: body.name,
      description: body.description || null,
      archivedAt: null,
      content: body.content,
    };
    patterns.push(p);
    return reply(201, orgPattern(p));
  }
  const pm = pathname.match(
    /^\/content-studio\/design-layout-patterns\/([^/]+)(?:\/(archive|restore))?$/
  );
  if (pm) {
    const p = patterns.find((x) => x.id === pm[1]);
    if (!p) return reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
    if (method === 'PATCH') Object.assign(p, body);
    if (pm[2] === 'archive') p.archivedAt = T0;
    if (pm[2] === 'restore') p.archivedAt = null;
    return reply(200, orgPattern(p));
  }
  if (pathname === '/content-studio/media/media-1/design-ref') {
    return reply(200, { mediaId: 'media-1', sha256: mediaSha });
  }
  if (pathname === `/content-studio/brand-kit/revisions/${REV}`) {
    return reply(200, BRAND);
  }
  const owner = (kind: string, id: string) =>
    kind === 'designs'
      ? design.id === id
        ? design
        : null
      : template.id === id
      ? template
      : null;
  const dm = pathname.match(
    /^\/content-studio\/(designs|design-templates)\/([^/]+)(?:\/(revisions)(?:\/([^/]+))?)?$/
  );
  if (dm) {
    const o = owner(dm[1], dm[2]);
    if (!o) return reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
    const last = o.revisions[o.revisions.length - 1];
    if (method === 'GET' && !dm[3]) {
      return reply(200, {
        ...(dm[1] === 'design-templates'
          ? { source: 'organization', description: null }
          : {}),
        id: o.id,
        name: 'Thing',
        latestRevisionNumber: o.revisions.length,
        archivedAt: null,
        createdAt: T0,
        updatedAt: T0,
        currentRevision: {
          ...meta(last),
          content: last.content,
          guidance: last.guidance ?? null,
          guidanceHash: null,
        },
      });
    }
    if (method === 'GET' && dm[3] && !dm[4]) {
      return reply(200, {
        pages: 1,
        results: [...o.revisions].reverse().map(meta),
      });
    }
    if (method === 'POST' && dm[3]) {
      const r = {
        id: nextId(),
        revisionNumber: o.revisions.length + 1,
        content: body.content,
        guidance: body.guidance,
      };
      o.revisions.push(r);
      return reply(201, {
        created: true,
        revision: { ...meta(r), content: r.content },
      });
    }
  }
  return reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
};

let storageSpies: jest.SpyInstance[];
beforeEach(() => {
  counter = 0;
  mockModals.set([]);
  mediaSha = SHA('a');
  patterns = [
    {
      id: nextId(),
      name: 'Brand banner',
      description: 'Ours',
      archivedAt: null,
      content: BANNER_CONTENT,
    },
    {
      id: nextId(),
      name: 'Photo frame',
      description: null,
      archivedAt: null,
      content: FRAME_CONTENT,
    },
    {
      id: nextId(),
      name: 'Old layout',
      description: null,
      archivedAt: T0,
      content: CARD_CONTENT,
    },
  ];
  design = {
    id: nextId(),
    revisions: [{ id: nextId(), revisionNumber: 1, content: doc() }],
  };
  template = {
    id: nextId(),
    revisions: [
      {
        id: nextId(),
        revisionNumber: 1,
        content: doc(),
        guidance: {
          schemaVersion: 1,
          brandRebinding: false,
          slots: [
            {
              id: 'headline',
              type: 'text',
              label: 'Headline',
              pageId: 'p_one',
              layerId: 'title',
              required: true,
              multiline: false,
            },
          ],
        },
      },
    ],
  };
  override = () => undefined;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    const method = init.method || 'GET';
    return override(method, url, body) ?? server(method, url, body);
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
  storageSpies = [
    jest.spyOn(Storage.prototype, 'setItem'),
    jest.spyOn(Storage.prototype, 'getItem'),
  ];
});
afterEach(() => {
  for (const spy of storageSpies) {
    expect(spy).not.toHaveBeenCalled();
  }
  expect(document.body.textContent).not.toContain(SECRET);
  cleanup();
  storageSpies.forEach((spy) => spy.mockRestore());
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
const show = async (element: ReturnType<typeof h>) => {
  const cache = new Map();
  render(
    h(
      SWRConfig,
      { value: { provider: () => cache, dedupingInterval: 0 } },
      h(ModalHost),
      element
    )
  );
  await flush();
};
const button = (name: string | RegExp, root: HTMLElement = document.body) =>
  within(root).getByRole('button', { name }) as HTMLButtonElement;
const click = async (element: HTMLElement) => {
  fireEvent.click(element);
  await flush();
};
const calls = () =>
  mockFetch.mock.calls.map(([url, init]) => ({
    method: (init?.method as string) || 'GET',
    url: url as string,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  }));
const writes = () => calls().filter((c) => c.method !== 'GET');
const dialog = (title: string) =>
  screen.getByRole('dialog', { name: title }) as HTMLElement;
const submit = async (root: HTMLElement) => {
  fireEvent.submit(root.querySelector('form') as HTMLFormElement);
  await flush();
};
const type = async (element: HTMLElement, value: string) => {
  fireEvent.change(element, { target: { value } });
  await flush();
};
const toolbar = () => screen.getByRole('toolbar', { name: 'Design editor' });
// P4-18: layouts live in the Creative Library, under their own category
const layouts = () => {
  if (!screen.queryByRole('region', { name: 'Layouts' })) {
    fireEvent.click(screen.getByRole('button', { name: 'Layouts' }));
  }
  return screen.getByRole('region', { name: 'Layouts' }) as HTMLElement;
};
const compose = () =>
  screen.getByRole('group', { name: 'Composition' }) as HTMLElement;
const row = async (name: string, options: Plain = {}) => {
  const entry = Array.from(document.querySelectorAll('[data-layer-row]')).find(
    (element) => (element.textContent ?? '').includes(name)
  ) as HTMLElement;
  fireEvent.click(entry, options);
  await flush();
};
const openDesign = async (
  brandKit: Plain | null = null,
  more: Plain[] = []
) => {
  design.revisions[0].content = doc(brandKit, more);
  await show(h(ContentStudioDesignWorkspace, { designId: design.id }));
  await click(button('Edit design'));
};
const browse = async () => {
  await click(button('Browse layouts', layouts()));
};
const saveDraft = async () => {
  await click(button('Save', toolbar()));
  return writes()
    .filter((c) => /\/revisions$/.test(c.url))
    .pop()?.body;
};
const layerOf = (content: Plain, id: string) =>
  content.pages[0].layers.find((l: Plain) => l.id === id);
const at = (content: Plain, id: string) => {
  const layer = layerOf(content, id);
  return [layer.x, layer.y];
};
const warned = (text: string) =>
  expect(mockToast).toHaveBeenCalledWith(text, 'warning');
const LIMITS = 'That alignment is outside the design limits.';
const UI_TIMEOUT = 60_000;
const ui = (name: string, test: () => Promise<void>) =>
  it(name, test, UI_TIMEOUT);

// ============================================================================
describe('Composition controls', () => {
  ui(
    'FC1 one layer: center on page (both) moves it as one undo step; no gap commands',
    async () => {
      await openDesign();
      await row('Title');
      expect(within(compose()).queryByLabelText('Gap')).toBeNull();
      expect(
        within(compose()).queryByRole('button', { name: 'Row' })
      ).toBeNull();
      await click(button('Center selection on page', compose()));
      const body = await saveDraft();
      expect(at(body.content, 'title')).toEqual([390, 490]);
      expect(layerOf(body.content, 'title')).toMatchObject({
        width: 300,
        height: 100,
        rotation: 5,
      });
      expect(at(body.content, 'box')).toEqual([410, 520]);
    }
  );

  ui(
    'FC2 several layers: a row at the exact gap, tops lined up, in page order',
    async () => {
      await openDesign();
      await row('Title');
      await row('Box', { ctrlKey: true });
      await type(within(compose()).getByLabelText('Gap'), '24');
      await click(button('Row', compose()));
      const body = await saveDraft();
      expect(at(body.content, 'title')).toEqual([10, 20]);
      expect(at(body.content, 'box')).toEqual([334, 20]);
      expect(at(body.content, 'photo')).toEqual([10, 20]);
      expect(Object.keys(body)).toEqual(['baseRevisionNumber', 'content']);
    }
  );

  ui(
    'FC3 each command is one undo step for every layer it moves; the selection stays',
    async () => {
      await openDesign();
      await row('Title');
      await row('Box', { ctrlKey: true });
      await click(button('Row', compose()));
      expect(screen.getByText(/2 layers selected/)).toBeTruthy();
      await click(button('Undo', toolbar()));
      expect(button('Undo', toolbar()).disabled).toBe(true);
      await type(within(compose()).getByLabelText('Gap'), '0');
      await click(button('Space vertically', compose()));
      const body = await saveDraft();
      expect(at(body.content, 'title')).toEqual([10, 20]);
      expect(at(body.content, 'box')).toEqual([410, 120]);
    }
  );

  ui('FC4 an invalid gap disables the gap commands', async () => {
    await openDesign();
    await row('Title');
    await row('Box', { ctrlKey: true });
    for (const value of ['', '40000', '-40000']) {
      await type(within(compose()).getByLabelText('Gap'), value);
      for (const name of [
        'Row',
        'Column',
        'Grid',
        'Space horizontally',
        'Space vertically',
      ]) {
        expect([value, name, button(name, compose()).disabled]).toEqual([
          value,
          name,
          true,
        ]);
      }
    }
    await type(within(compose()).getByLabelText('Gap'), '-8');
    expect(button('Row', compose()).disabled).toBe(false);
  });

  ui(
    'FC5 grid: columns limited to the selection; row by row in page order',
    async () => {
      await openDesign();
      await row('Title');
      await row('Box', { ctrlKey: true });
      await row('Photo', { ctrlKey: true });
      const columns = within(compose()).getByLabelText('Columns');
      for (const value of ['4', '0', '1.5']) {
        await type(columns, value);
        expect(button('Grid', compose()).disabled).toBe(true);
      }
      await type(columns, '2');
      await type(within(compose()).getByLabelText('Gap'), '10');
      await click(button('Grid', compose()));
      const body = await saveDraft();
      expect(at(body.content, 'title')).toEqual([10, 20]);
      expect(at(body.content, 'box')).toEqual([320, 20]);
      expect(at(body.content, 'photo')).toEqual([10, 130]);
    }
  );

  ui(
    'FC6 a result past the design limits is refused as a whole: a fixed message, nothing changes',
    async () => {
      await openDesign();
      await row('Title');
      await row('Box', { ctrlKey: true });
      await row('Photo', { ctrlKey: true });
      await type(within(compose()).getByLabelText('Gap'), '32768');
      await click(button('Row', compose()));
      warned(LIMITS);
      expect(button('Undo', toolbar()).disabled).toBe(true);
      await click(button('Move into page', compose()));
      expect(button('Undo', toolbar()).disabled).toBe(true);
    }
  );

  ui(
    'FC7 no composition outside editing; move into page only moves',
    async () => {
      design.revisions[0].content = doc(null, [
        { ...BOX, id: 'outside', name: 'Outside', x: 1000, y: -40 },
      ]);
      await show(h(ContentStudioDesignWorkspace, { designId: design.id }));
      await row('Title');
      expect(screen.queryByRole('group', { name: 'Composition' })).toBeNull();
      await click(button('Edit design'));
      await row('Outside');
      await click(button('Move into page', compose()));
      const body = await saveDraft();
      expect(at(body.content, 'outside')).toEqual([780, 0]);
      expect(layerOf(body.content, 'outside')).toMatchObject({
        width: 300,
        height: 100,
      });
    }
  );
});

// ============================================================================
describe('Layouts panel', () => {
  ui(
    'FL1 only while editing; the catalog loads only once it is opened',
    async () => {
      await show(h(ContentStudioDesignWorkspace, { designId: design.id }));
      expect(screen.queryByRole('region', { name: 'Layouts' })).toBeNull();
      await click(button('Edit design'));
      expect(layouts()).toBeTruthy();
      const listed = () =>
        calls()
          .filter((c) => c.url.includes('design-layout-patterns'))
          .map((c) => c.url);
      expect(listed()).toEqual([]);
      await browse();
      expect(listed()).toEqual([
        '/content-studio/design-layout-patterns?page=1&archived=false',
      ]);
      expect(
        button('Hide layouts', layouts()).getAttribute('aria-expanded')
      ).toBe('true');
    }
  );

  ui(
    'FL2 built-in and organization layouts with DOM thumbnails and their actions; archived ones never',
    async () => {
      await openDesign();
      await browse();
      const builtIn = within(layouts()).getByRole('list', {
        name: 'Built-in · Layouts',
      });
      const organization = within(layouts()).getByRole('list', {
        name: 'Organization · Layouts',
      });
      expect(builtIn.textContent).toContain('Title card');
      expect(builtIn.textContent).toContain('2 layers');
      expect(
        within(builtIn)
          .getAllByRole('button')
          .map((b) => b.textContent)
      ).toEqual(['Insert']);
      expect(
        within(organization)
          .getAllByRole('button')
          .map((b) => b.textContent)
      ).toEqual([
        'Insert',
        'Edit details',
        'Archive',
        'Insert',
        'Edit details',
        'Archive',
      ]);
      expect(layouts().textContent).not.toContain('Old layout');
      expect(
        layouts().querySelectorAll('[data-preview="thumbnail"]')
      ).toHaveLength(3);
      expect(layouts().querySelectorAll('canvas, img, [src]')).toHaveLength(0);
      expect(calls().filter((c) => /render|design-ref/.test(c.url))).toEqual(
        []
      );
    }
  );

  ui(
    'FL3 Insert copies the layers onto the page, centered, in front, under new ids, all selected; nothing is sent',
    async () => {
      await openDesign();
      await browse();
      const before = writes().length;
      await click(button('Insert Title card', layouts()));
      expect(writes()).toHaveLength(before);
      expect(screen.getByText(/2 layers selected/)).toBeTruthy();
      const body = await saveDraft();
      const layers = body.content.pages[0].layers;
      expect(layers.slice(0, 3).map((l: Plain) => l.id)).toEqual([
        'title',
        'box',
        'photo',
      ]);
      const added = layers.slice(3);
      expect(added.map((l: Plain) => [l.name, l.x, l.y])).toEqual([
        ['Card', 340, 440],
        ['Heading', 360, 480],
      ]);
      for (const layer of added) {
        expect(layer.id).toMatch(/^l_[0-9a-f]{20}$/);
      }
      expect(JSON.stringify(body)).not.toMatch(/system:|pattern|layout/i);
    }
  );

  ui('FL4 an insert is one undo step', async () => {
    await openDesign();
    await browse();
    await click(button('Insert Title card', layouts()));
    await click(button('Undo', toolbar()));
    expect(screen.queryByText(/2 layers selected/)).toBeNull();
    await click(button('Insert Title card', layouts()));
    const body = await saveDraft();
    expect(body.content.pages[0].layers).toHaveLength(5);
  });

  ui(
    'FL5 Brand tokens insert only when the design’s exact revision has them',
    async () => {
      await openDesign();
      await browse();
      await click(button('Insert Brand banner', layouts()));
      warned(
        'This layout uses Brand Kit colors or typography that this design’s Brand Kit revision does not have. Nothing was inserted.'
      );
      expect(button('Undo', toolbar()).disabled).toBe(true);
      cleanup();
      await openDesign(BRAND_REF);
      await browse();
      await click(button('Insert Brand banner', layouts()));
      const body = await saveDraft();
      expect(body.content.brandKit).toEqual(BRAND_REF);
      expect(body.content.pages[0].layers[3]).toMatchObject({
        name: 'Banner',
        fill: tok('primary'),
        x: 440,
        y: 490,
      });
    }
  );

  ui(
    'FL6 images are checked against the organization’s Media first; other bytes insert nothing',
    async () => {
      await openDesign();
      await browse();
      await click(button('Insert Photo frame', layouts()));
      expect(
        calls()
          .filter((c) => c.url.includes('design-ref'))
          .map((c) => c.url)
      ).toEqual(['/content-studio/media/media-1/design-ref']);
      mediaSha = SHA('z');
      await click(button('Insert Photo frame', layouts()));
      warned(
        'An image in this layout is no longer available in your media library. Nothing was inserted.'
      );
      const body = await saveDraft();
      const layers = body.content.pages[0].layers;
      expect(layers).toHaveLength(4);
      expect(layers[3]).toMatchObject({
        imageRef: { type: 'media', mediaId: 'media-1', sha256: SHA('a') },
        fit: 'contain',
        focalPoint: { x: 0.25, y: 0.75 },
        mask: { type: 'ellipse' },
      });
    }
  );

  ui('FL7 a page that would pass its layer limit takes nothing', async () => {
    await openDesign(null, extra(196));
    await browse();
    await click(button('Insert Title card', layouts()));
    warned('This page or design has reached its layer limit.');
    expect(button('Undo', toolbar()).disabled).toBe(true);
  });

  ui(
    'FL8 edit details, archive and restore send exactly their requests',
    async () => {
      await openDesign();
      await browse();
      await click(button('Edit details Brand banner', layouts()));
      const form = dialog('Edit details');
      await type(within(form).getByLabelText('Layout name'), 'Banner 2');
      await submit(form);
      expect(writes().pop()).toEqual({
        method: 'PATCH',
        url: `/content-studio/design-layout-patterns/${patterns[0].id}`,
        body: { name: 'Banner 2', description: 'Ours' },
      });
      await click(button('Archive Photo frame', layouts()));
      expect(writes().pop()).toEqual({
        method: 'POST',
        url: `/content-studio/design-layout-patterns/${patterns[1].id}/archive`,
        body: undefined,
      });
      expect(layouts().textContent).not.toContain('Photo frame');
      await click(button('Archived layouts', layouts()));
      const archived = dialog('Archived layouts');
      expect(archived.textContent).toContain('Old layout');
      await click(button('Restore Old layout', archived));
      expect(writes().pop()).toEqual({
        method: 'POST',
        url: `/content-studio/design-layout-patterns/${patterns[2].id}/restore`,
        body: undefined,
      });
      expect(
        writes().filter((c) => c.method === 'DELETE' || /revisions/.test(c.url))
      ).toEqual([]);
    }
  );

  ui('FL9 a layout that does not parse cannot be inserted', async () => {
    patterns[0].content = {
      ...BANNER_CONTENT,
      layers: [{ ...BANNER_CONTENT.layers[0], id: 'l_1' }],
    };
    await openDesign();
    await browse();
    expect(button('Insert Brand banner', layouts()).disabled).toBe(true);
    expect(within(layouts()).getByRole('alert').textContent).toBe(
      'Stored layout data could not be read safely.'
    );
  });
});

// ============================================================================
describe('Save selection as layout', () => {
  ui('FS1 needs chosen layers', async () => {
    await openDesign();
    expect(button('Save selection as layout', layouts()).disabled).toBe(true);
    await row('Title');
    expect(button('Save selection as layout', layouts()).disabled).toBe(false);
  });

  ui(
    'FS2 sends the chosen layers only: no ids, measured from their box, in page order, nothing else',
    async () => {
      await openDesign();
      await row('Box');
      await row('Title', { ctrlKey: true });
      await click(button('Save selection as layout', layouts()));
      const form = dialog('Save selection as layout');
      expect(form.textContent).toContain('2 layers');
      await type(within(form).getByLabelText('Layout name'), '  Pair ');
      await submit(form);
      const sent = writes().pop()!;
      expect(sent.method).toBe('POST');
      expect(sent.url).toBe('/content-studio/design-layout-patterns');
      expect(Object.keys(sent.body).sort()).toEqual([
        'content',
        'description',
        'name',
      ]);
      expect(sent.body.name).toBe('Pair');
      const { id: _t, ...title } = TITLE;
      const { id: _b, ...shape } = BOX;
      expect(sent.body.content).toEqual({
        schemaVersion: 1,
        width: 700,
        height: 600,
        layers: [
          { ...title, x: 0, y: 0 },
          { ...shape, x: 400, y: 500 },
        ],
      });
      expect(mockToast).toHaveBeenCalledWith('Layout saved.', 'success');
    }
  );

  ui('FS3 a name is required', async () => {
    await openDesign();
    await row('Title');
    await click(button('Save selection as layout', layouts()));
    const form = dialog('Save selection as layout');
    expect(button('Save layout', form).disabled).toBe(true);
    await type(within(form).getByLabelText('Layout name'), '   ');
    expect(button('Save layout', form).disabled).toBe(true);
  });

  ui(
    'FS4 a refusal shows fixed text, never the server message; the dialog stays',
    async () => {
      override = (method, url) =>
        method === 'POST' && url === '/content-studio/design-layout-patterns'
          ? reply(400, {
              msg: SECRET,
              code: 'CS_DESIGN_LAYOUT_PATTERN_MEDIA_INVALID',
            })
          : undefined;
      await openDesign();
      await row('Photo');
      await click(button('Save selection as layout', layouts()));
      const form = dialog('Save selection as layout');
      await type(within(form).getByLabelText('Layout name'), 'Photo');
      await submit(form);
      warned(
        'An image in these layers is not available in your media library.'
      );
      expect(dialog('Save selection as layout')).toBeTruthy();
    }
  );

  ui(
    'FS5 saving a layout leaves the draft as it is: no revision, no undo step',
    async () => {
      await openDesign();
      await row('Title');
      await click(button('Save selection as layout', layouts()));
      const form = dialog('Save selection as layout');
      await type(within(form).getByLabelText('Layout name'), 'One');
      await submit(form);
      expect(writes().filter((c) => /revisions/.test(c.url))).toEqual([]);
      expect(button('Undo', toolbar()).disabled).toBe(true);
    }
  );

  ui(
    'FS6 images keep their Media id, SHA-256, fit, focal point and frame',
    async () => {
      await openDesign();
      await row('Photo');
      await click(button('Save selection as layout', layouts()));
      const form = dialog('Save selection as layout');
      await type(within(form).getByLabelText('Layout name'), 'Photo');
      await submit(form);
      const { id: _p, ...photo } = PHOTO;
      expect(writes().pop()!.body.content.layers).toEqual([
        { ...photo, x: 0, y: 0 },
      ]);
    }
  );

  ui(
    'FS7 the template workspace takes layouts like a design; its fields stay exactly as they were',
    async () => {
      await show(
        h(ContentStudioDesignTemplateWorkspace, { templateId: template.id })
      );
      await click(button('Edit template'));
      await browse();
      await click(button('Insert Title card', layouts()));
      const body = await saveDraft();
      expect(Object.keys(body).sort()).toEqual([
        'baseRevisionNumber',
        'content',
        'guidance',
      ]);
      expect(body.guidance).toEqual(template.revisions[0].guidance);
      expect(body.content.pages[0].layers).toHaveLength(5);
      expect(JSON.stringify(body)).not.toMatch(/system:|pattern/i);
    }
  );
});

// ============================================================================
describe('Layout and composition frontend boundaries', () => {
  const dir = __dirname;
  const code = (file: string) =>
    readFileSync(join(dir, file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
  const FILES = [
    'content-studio.design-layout-patterns.tsx',
    'content-studio.design-layout-patterns.api.ts',
  ];
  const editor = code('content-studio.design.editor.ts');
  const section = (start: string, end: string) =>
    editor.slice(editor.indexOf(start), editor.indexOf(end));

  it('P415-7 thumbnails are DOM drawings: no render, canvas, image, Fabric, storage or AI', () => {
    for (const file of FILES) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /from 'fabric'|toJSON|toObject|loadFromJSON|\/render|ContentStudioDesignCanvas|<canvas|<img|localStorage|sessionStorage|navigator\.clipboard|\/ai\/|generate|marketplace|public/
        ),
      ]);
    }
  });

  it('P415-8 the client uses the five routes only: no delete or apply endpoint', () => {
    const api = code('content-studio.design-layout-patterns.api.ts');
    expect(api).not.toMatch(/DELETE|PUT|\/apply|\/insert|\/use\b/);
    expect(api.match(/method: '(POST|PATCH)'/g)).toEqual([
      "method: 'POST'",
      "method: 'PATCH'",
      "method: 'POST'",
      "method: 'POST'",
    ]);
  });

  it('P415-9 the client never sends an organization, user, hash, design or page', () => {
    for (const file of FILES) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /organizationId|userId|createdById|contentHash: (?!string)|designId:|pageId:/
        ),
      ]);
    }
    expect(code('content-studio.design-layout-patterns.api.ts')).toMatch(
      /content: \{\s*schemaVersion: input\.content\.schemaVersion,\s*width: input\.content\.width,\s*height: input\.content\.height,\s*layers: input\.content\.layers,\s*\}/
    );
  });

  it('P415-10 every composition helper is atomic through placeLayers and moves boxes only', () => {
    // (comments are left out: the section is found by its code)
    const composition = section(
      'export type ContentStudioDesignCenterAxis',
      'export const copyContentStudioDesignLayer'
    );
    for (const name of [
      'centerContentStudioDesignLayersOnPage',
      'moveContentStudioDesignLayersIntoPage',
      'spaceContentStudioDesignLayers',
      'arrangeContentStudioDesignLayersInGrid',
    ]) {
      const start = composition.indexOf(`export const ${name}`);
      const body = composition.slice(
        start,
        composition.indexOf('\nexport const', start + 1)
      );
      expect([name, body]).toEqual([
        name,
        expect.stringMatching(/placeLayers\(\s*document,\s*pageIndex,\s*page,/),
      ]);
      expect([name, body]).toEqual([
        name,
        expect.stringContaining('layersOfOnePage(document, layerIds)'),
      ]);
    }
    expect(composition).not.toMatch(/width:|height:|fontSize|rotation:|scale/);
  });

  it('P415-11 insert takes fresh ids, checks limits, coordinates and the exact Brand Kit revision, and keeps nothing of the pattern', () => {
    const insert = section(
      'export const insertContentStudioDesignLayoutPattern',
      'export const contentStudioDesignDocumentColors'
    );
    expect(insert).toContain('uniqueId(newContentStudioDesignLayerId, taken)');
    expect(insert).toContain('DESIGN_LAYERS_PER_PAGE_MAX');
    expect(insert).toContain('DESIGN_LAYERS_MAX');
    expect(insert).toContain('DESIGN_COORDINATE_MAX');
    expect(insert).toContain("fail('LAYOUT_BRAND_UNAVAILABLE')");
    expect(insert).toContain('!document.brandKit');
    expect(insert).toContain('[...page.layers, ...layers]');
    expect(insert).not.toMatch(/patternId|pattern\.id|source|groupId|latest/);
  });

  it('P415-12 Design Document v1 and its save body are unchanged', () => {
    expect(code('content-studio.designs.api.ts')).toContain(
      'body: JSON.stringify({ baseRevisionNumber, content })'
    );
    const document = readFileSync(
      join(
        dir,
        '../../../../../libraries/nestjs-libraries/src/content-studio/design/design.document.ts'
      ),
      'utf8'
    );
    expect(document).toContain(
      'export const DESIGN_DOCUMENT_SCHEMA_VERSION = 1;'
    );
    expect(document).not.toMatch(
      /layoutPattern|patternId|constraints|autoLayout/
    );
  });

  it('P415-13 the panel resolves Brand Kit tokens only from the design’s exact revision and loads no kit itself', () => {
    const panel = code('content-studio.design-layout-patterns.tsx');
    expect(panel).not.toMatch(/useContentStudioBrandKit|brand-kit|getBrandKit/);
    expect(code('content-studio.design-layout-patterns.api.ts')).not.toMatch(
      /brand-kit|BrandKit|latest/i
    );
    // P4-18: the workspace hands it to the Creative Library, which hands it on
    const workspace = code('content-studio.design.workspace.tsx');
    const use = workspace.slice(workspace.indexOf('<DesignCreativeLibrary'));
    expect(use.slice(0, use.indexOf('/>'))).toContain('brand={brand.content}');
    const library = code('content-studio.design-library.tsx');
    const inner = library.slice(library.indexOf('<DesignLayoutPatterns'));
    expect(inner.slice(0, inner.indexOf('/>'))).toContain('brand={brand}');
  });

  it('P415-14 Media is checked through the existing design reference before an insert, never loaded or shown', () => {
    const panel = code('content-studio.design-layout-patterns.tsx');
    expect(panel).toContain('getMediaDesignRef(mediaId)');
    expect(panel).not.toMatch(
      /useContentStudioMediaLibrary|\/media\/|thumbnail:/
    );
    const insert = panel.slice(panel.indexOf('const insert = '));
    expect(insert.indexOf('getMediaDesignRef')).toBeLessThan(
      insert.indexOf('insertContentStudioDesignLayoutPattern(')
    );
  });

  it('P415-15 the catalog is fetched lazily and only while editing', () => {
    const panel = code('content-studio.design-layout-patterns.tsx');
    expect(panel).toContain(
      'useContentStudioDesignLayoutPatterns(open, false, listPage)'
    );
    // P4-18: only while editing, and only when its library category is open
    const workspace = code('content-studio.design.workspace.tsx');
    expect(workspace).toMatch(/\{edit && \(\s*<DesignCreativeLibrary/);
    expect(code('content-studio.design-library.tsx')).toMatch(
      /\{category === 'layouts' && \(\s*<DesignLayoutPatterns/
    );
  });

  it('P415-16 no component system, constraints, auto-layout, grouping or AI generation', () => {
    for (const file of [
      ...FILES,
      'content-studio.design.editor.ts',
      'content-studio.design.editing.tsx',
    ]) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /componentRef|symbolRef|instanceOf|constraints|autoLayout|groupId|\/ai\/|AIWriting/
        ),
      ]);
    }
  });
});
