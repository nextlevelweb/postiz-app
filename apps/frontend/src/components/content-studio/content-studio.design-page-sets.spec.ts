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

// Creative Studio page sets (P4-17): a new design from a page set (by id
// only), Save page set (structure only), adding a page set to a draft (one
// undo step), archive and restore, the template workspace, and the pure
// add operation. A .spec.ts without JSX, like the other Content Studio
// frontend specs: components are required, not imported. The Fabric adapter
// is an inert stand-in (direct canvas editing has its own spec)
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

const { ContentStudioDesigns } = require('./content-studio.designs');
const {
  ContentStudioDesignWorkspace,
} = require('./content-studio.design.workspace');
const {
  ContentStudioDesignTemplateWorkspace,
} = require('./content-studio.design-template.workspace');

const {
  addContentStudioDesignPageSet,
  ContentStudioDesignEditorError,
} = require('./content-studio.design.editor');
const {
  parseContentStudioDesignDocument,
} = require('@gitroom/nestjs-libraries/content-studio/design/design.document');

type Plain = Record<string, any>;
type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const SECRET = 'PAGE_SET_SERVER_SECRET_123';
const T0 = '2026-10-19T10:00:00.000Z';
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const lit = (value: string) => ({ type: 'literal', value });
const tok = (tokenId: string) => ({ type: 'brand', tokenId });
const solid = (color: Plain) => ({ type: 'solid', color });
const TITLE = {
  id: 'title',
  name: 'Title',
  x: 10,
  y: 20,
  width: 300,
  height: 100,
  rotation: 0,
  opacity: 1,
  visible: true,
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
const pageOf = (
  id: string,
  name: string,
  size: number[],
  layers: Plain[] = [],
  background: Plain = solid(lit('#ffffff'))
) => ({
  id,
  name,
  width: size[0],
  height: size[1],
  background,
  layers: layers.map((l) => JSON.parse(JSON.stringify(l))),
});
const BRAND_REF = {
  brandKitId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  revisionId: 'aaaaaaaa-0000-4000-8000-000000000001',
  revisionNumber: 3,
  contentHash: SHA('b'),
};
const doc = (extraPages: Plain[] = []) => ({
  schemaVersion: 1,
  brandKit: null,
  pages: [
    pageOf('p_one', 'Launch', [1080, 1080], [TITLE], solid(lit('#FFEEDD'))),
    pageOf('p_two', 'Back', [1080, 1350]),
    ...extraPages,
  ],
});
const CORE = {
  schemaVersion: 1,
  pages: [
    { name: 'Square', width: 1080, height: 1080 },
    { name: 'Portrait', width: 1080, height: 1350 },
    { name: 'Story', width: 1080, height: 1920 },
  ],
};
const SYSTEM = [
  {
    source: 'system',
    id: 'system:page-set-social-core',
    name: 'Social core',
    description: 'Square, portrait and story pages.',
    pageCount: 3,
    archivedAt: null,
    contentHash: SHA('1'),
    content: CORE,
  },
];

let counter = 0;
const nextId = () =>
  `${String(++counter).padStart(8, '0')}-0000-4000-8000-000000000000`;
type PageSet = {
  id: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  content: any;
};
let pageSets: PageSet[];
let design: { id: string; revisions: any[] };
let template: { id: string; revisions: any[] };
let override: (method: string, url: string, body: any) => Reply | undefined;
const orgPageSet = (p: PageSet) => ({
  source: 'organization',
  ...p,
  pageCount: p.content.pages.length,
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
  const P = '/content-studio/design-page-sets';
  if (pathname === P && method === 'GET') {
    const archived = searchParams.get('archived') === 'true';
    return reply(200, {
      system: archived ? [] : SYSTEM,
      pages: 1,
      results: pageSets
        .filter((p) => !!p.archivedAt === archived)
        .map(orgPageSet),
    });
  }
  if (pathname === P && method === 'POST') {
    const p: PageSet = {
      id: nextId(),
      name: body.name,
      description: body.description || null,
      archivedAt: null,
      content: body.content,
    };
    pageSets.push(p);
    return reply(201, orgPageSet(p));
  }
  const pm = pathname.match(
    /^\/content-studio\/design-page-sets\/([^/]+)(?:\/(archive|restore))?$/
  );
  if (pm) {
    const p = pageSets.find((x) => x.id === pm[1]);
    if (!p) return reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
    if (method === 'PATCH') Object.assign(p, body);
    if (pm[2] === 'archive') p.archivedAt = T0;
    if (pm[2] === 'restore') p.archivedAt = null;
    return reply(200, orgPageSet(p));
  }
  if (pathname === '/content-studio/designs' && method === 'GET') {
    return reply(200, { pages: 1, results: [] });
  }
  if (pathname === '/content-studio/designs' && method === 'POST') {
    return reply(201, {
      id: 'new-design',
      name: body.name,
      latestRevisionNumber: 1,
      archivedAt: null,
      createdAt: T0,
      updatedAt: T0,
    });
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

const GUIDANCE = {
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
};
let storageSpies: jest.SpyInstance[];
beforeEach(() => {
  counter = 0;
  mockModals.set([]);
  mockPush.mockReset();
  pageSets = [
    {
      id: nextId(),
      name: 'Our pair',
      description: 'Ours',
      archivedAt: null,
      content: {
        schemaVersion: 1,
        pages: [
          {
            name: 'Cover',
            width: 1080,
            height: 1350,
            background: solid(lit('#123456')),
          },
          { name: 'Wide', width: 1200, height: 628 },
        ],
      },
    },
    {
      id: nextId(),
      name: 'Old set',
      description: null,
      archivedAt: T0,
      content: CORE,
    },
  ];
  design = {
    id: nextId(),
    revisions: [{ id: nextId(), revisionNumber: 1, content: doc() }],
  };
  template = {
    id: nextId(),
    revisions: [
      { id: nextId(), revisionNumber: 1, content: doc(), guidance: GUIDANCE },
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
const type = async (element: HTMLElement, value: string) => {
  fireEvent.change(element, { target: { value } });
  await flush();
};
const calls = () =>
  mockFetch.mock.calls.map(([url, init]) => ({
    method: (init?.method as string) || 'GET',
    url: url as string,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  }));
const writes = () => calls().filter((c) => c.method !== 'GET');
const toolbar = () => screen.getByRole('toolbar', { name: 'Design editor' });
const dialog = (title: string) =>
  screen.getByRole('dialog', { name: title }) as HTMLElement;
const submit = async (root: HTMLElement) => {
  fireEvent.submit(root.querySelector('form') as HTMLFormElement);
  await flush();
};
// P4-18: page sets live in the Creative Library, under their own category
const panel = () => {
  if (!screen.queryByRole('region', { name: 'Page sets' })) {
    fireEvent.click(screen.getByRole('button', { name: 'Page sets' }));
  }
  return screen.getByRole('region', { name: 'Page sets' }) as HTMLElement;
};
const row = async (name: string, options: Plain = {}) => {
  const entry = Array.from(document.querySelectorAll('[data-layer-row]')).find(
    (element) => (element.textContent ?? '').includes(name)
  ) as HTMLElement;
  fireEvent.click(entry, options);
  await flush();
};
const openDesign = async (extraPages: Plain[] = []) => {
  design.revisions[0].content = doc(extraPages);
  await show(h(ContentStudioDesignWorkspace, { designId: design.id }));
  await click(button('Edit design'));
};
const browse = async () => click(button('Browse page sets', panel()));
const saveDraft = async () => {
  await click(button('Save', toolbar()));
  return writes()
    .filter((c) => /\/revisions$/.test(c.url))
    .pop()?.body;
};
const pageCards = () =>
  Array.from(
    screen
      .getByRole('list', { name: 'Pages' })
      .querySelectorAll('button[aria-pressed]')
  ) as HTMLElement[];
const cardText = (card: HTMLElement) =>
  `${card.querySelector('[data-page-label]')?.textContent}${
    card.querySelector('[data-page-size]')?.textContent
  }`;
const current = () =>
  pageCards().findIndex((card) => card.getAttribute('aria-pressed') === 'true');
const refused = (run: () => unknown, code: string) => {
  let error: unknown;
  try {
    run();
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ContentStudioDesignEditorError);
  expect((error as { code: string }).code).toBe(code);
};
const UI_TIMEOUT = 60_000;
const ui = (name: string, test: () => Promise<void>) =>
  it(name, test, UI_TIMEOUT);

// ============================================================================
describe('Adding a page set (pure)', () => {
  const base = () => parseContentStudioDesignDocument(doc());

  it('PA1/PA2/PA8 the set’s pages after the last page, in order; existing pages unchanged', () => {
    const document = base();
    const frozen = JSON.stringify(document);
    const { document: next, pageIds } = addContentStudioDesignPageSet(
      document,
      CORE
    );
    expect(next.pages.map((p: Plain) => [p.name, p.width, p.height])).toEqual([
      ['Launch', 1080, 1080],
      ['Back', 1080, 1350],
      ['Square', 1080, 1080],
      ['Portrait', 1080, 1350],
      ['Story', 1080, 1920],
    ]);
    expect(pageIds).toEqual(next.pages.slice(2).map((p: Plain) => p.id));
    expect(next.pages[0]).toBe(document.pages[0]);
    expect(next.pages[1]).toBe(document.pages[1]);
    expect(JSON.stringify(document)).toBe(frozen);
  });

  it('PI1/PI5 fresh page ids, blank pages, valid Design Document v1, nothing of the page set', () => {
    const { document: next, pageIds } = addContentStudioDesignPageSet(
      base(),
      CORE
    );
    expect(new Set(next.pages.map((p: Plain) => p.id)).size).toBe(5);
    for (const id of pageIds) {
      expect(id).toMatch(/^p_[0-9a-f]{20}$/);
    }
    for (const page of next.pages.slice(2)) {
      expect(page.layers).toEqual([]);
      expect(page.background).toEqual(solid(lit('#ffffff')));
    }
    expect(parseContentStudioDesignDocument(next)).toEqual(next);
    expect(JSON.stringify(next)).not.toMatch(/pageSet|system:|campaign/i);
  });

  it('PA9 never more than 25 pages: all or nothing', () => {
    const full = parseContentStudioDesignDocument(
      doc(
        Array.from({ length: 21 }, (_, i) => pageOf(`p_more${i}`, '', [64, 64]))
      )
    );
    const frozen = JSON.stringify(full);
    refused(() => addContentStudioDesignPageSet(full, CORE), 'PAGE_LIMIT');
    expect(JSON.stringify(full)).toBe(frozen);
    const pair = { schemaVersion: 1, pages: CORE.pages.slice(0, 2) };
    expect(
      addContentStudioDesignPageSet(full, pair).document.pages
    ).toHaveLength(25);
  });
});

// ============================================================================
describe('A new design from a page set', () => {
  const openCreate = async () => {
    await show(h(ContentStudioDesigns));
    await click(screen.getAllByRole('button', { name: 'Create design' })[0]);
    return dialog('Create design');
  };

  ui(
    'PF1/PF2/PF3/PF4/PF5/PF7 the page set option lists built-in and active organization sets with their sizes and source in text',
    async () => {
      const form = await openCreate();
      expect(calls().filter((c) => c.url.includes('design-page-sets'))).toEqual(
        []
      );
      await click(within(form).getByRole('radio', { name: 'A page set' }));
      const choices = Array.from(
        form.querySelectorAll('[data-page-set-choice]')
      ) as HTMLElement[];
      expect(
        choices.map((c) => c.getAttribute('data-page-set-choice'))
      ).toEqual(['system', 'organization']);
      expect(choices[0].textContent).toContain('Social core');
      expect(choices[0].textContent).toContain('Built-in · 3 pages');
      expect(choices[0].textContent).toContain('Square 1080 × 1080');
      expect(choices[0].textContent).toContain('Story 1080 × 1920');
      expect(choices[1].textContent).toContain('Organization · 2 pages');
      expect(choices[1].textContent).toContain('Cover 1080 × 1350');
      expect(form.textContent).not.toContain('Old set');
      expect(form.querySelectorAll('[data-page-set-page]')).toHaveLength(5);
      expect(form.querySelectorAll('canvas, img, [src]')).toHaveLength(0);
    }
  );

  ui(
    'PF6/PF8 creating sends the name and the page set id only, then opens the new design',
    async () => {
      const form = await openCreate();
      await type(within(form).getByLabelText('Name'), ' Launch ');
      await click(within(form).getByRole('radio', { name: 'A page set' }));
      const create = button('Create design', form);
      expect(create.disabled).toBe(true);
      await click(within(form).getByRole('radio', { name: /Social core/ }));
      expect(create.disabled).toBe(false);
      await submit(form);
      expect(writes()).toEqual([
        {
          method: 'POST',
          url: '/content-studio/designs',
          body: { name: 'Launch', pageSetId: 'system:page-set-social-core' },
        },
      ]);
      expect(mockPush).toHaveBeenCalledWith(
        '/content-studio/designs/new-design'
      );
    }
  );

  ui(
    'PC4 an archived page set refused by the server shows a fixed message',
    async () => {
      override = (method, url) =>
        method === 'POST' && url === '/content-studio/designs'
          ? reply(409, { msg: SECRET, code: 'CS_DESIGN_PAGE_SET_ARCHIVED' })
          : undefined;
      const form = await openCreate();
      await type(within(form).getByLabelText('Name'), 'Launch');
      await click(within(form).getByRole('radio', { name: 'A page set' }));
      await click(within(form).getByRole('radio', { name: /Our pair/ }));
      await submit(form);
      expect(writes().pop()!.body).toEqual({
        name: 'Launch',
        pageSetId: pageSets[0].id,
      });
      expect(mockToast).toHaveBeenCalledWith(
        'This page set is archived.',
        'warning'
      );
      expect(mockPush).not.toHaveBeenCalled();
    }
  );

  ui('one canvas size still sends the document as before', async () => {
    const form = await openCreate();
    await type(within(form).getByLabelText('Name'), 'Plain');
    await submit(form);
    const body = writes().pop()!.body;
    expect(Object.keys(body)).toEqual(['name', 'content']);
    expect(body.content.pages).toHaveLength(1);
  });
});

// ============================================================================
describe('Save page set', () => {
  ui('PFS1 only while editing', async () => {
    await show(h(ContentStudioDesignWorkspace, { designId: design.id }));
    expect(screen.queryByRole('region', { name: 'Page sets' })).toBeNull();
    await click(button('Edit design'));
    expect(button('Save page set', panel()).disabled).toBe(false);
  });

  ui(
    'PFS2/PFS3/PFS4/PFS5/PFS6/PFS7 the dialog lists the pages; the request is the name, description and structure only; the new set is listed',
    async () => {
      design.revisions[0].content = {
        ...doc([
          pageOf('p_three', '', [1080, 1920], [], solid(tok('primary'))),
        ]),
        brandKit: BRAND_REF,
      };
      override = (method, url) =>
        url.includes('/brand-kit/revisions/')
          ? reply(200, {
              id: BRAND_REF.revisionId,
              revisionNumber: 3,
              schemaVersion: 1,
              contentHash: SHA('b'),
              createdAt: T0,
              content: {
                schemaVersion: 1,
                identity: { brandName: 'N', tagline: '', description: '' },
                colors: [
                  {
                    id: 'primary',
                    name: 'P',
                    value: '#0057ff',
                    role: 'primary',
                  },
                ],
                typography: [],
                visualDirection: { keywords: [], dos: [], donts: [] },
              },
            })
          : undefined;
      await show(h(ContentStudioDesignWorkspace, { designId: design.id }));
      await click(button('Edit design'));
      await click(button('Save page set', panel()));
      const form = dialog('Save page set');
      expect(form.textContent).toContain('Launch 1080 × 1080');
      expect(form.textContent).toContain('Back 1080 × 1350');
      expect(form.textContent).toContain('Page 3 1080 × 1920');
      expect(button('Save page set', form).disabled).toBe(true);
      await type(within(form).getByLabelText('Page set name'), ' Trio ');
      await submit(form);
      const sent = writes().pop()!;
      expect(sent.url).toBe('/content-studio/design-page-sets');
      expect(Object.keys(sent.body).sort()).toEqual([
        'content',
        'description',
        'name',
      ]);
      expect(sent.body.name).toBe('Trio');
      expect(sent.body.content).toEqual({
        schemaVersion: 1,
        pages: [
          {
            name: 'Launch',
            width: 1080,
            height: 1080,
            background: solid(lit('#ffeedd')),
          },
          {
            name: 'Back',
            width: 1080,
            height: 1350,
            background: solid(lit('#ffffff')),
          },
          { name: '', width: 1080, height: 1920 },
        ],
      });
      expect(JSON.stringify(sent.body)).not.toMatch(
        /p_one|p_two|p_three|layers|title|Hello|brand|primary|tokenId/i
      );
      expect(mockToast).toHaveBeenCalledWith('Page set saved.', 'success');
      expect(writes().filter((c) => /revisions/.test(c.url))).toEqual([]);
      expect(button('Undo', toolbar()).disabled).toBe(true);
      await click(button('Browse page sets', panel()));
      expect(panel().textContent).toContain('Trio');
    }
  );
});

// ============================================================================
describe('Add pages from a page set', () => {
  ui(
    'PFA1/PFA2/PFA4/PFA5/PFA6 the picker loads on demand: built-in and active organization sets, sizes in text, nothing rendered',
    async () => {
      await openDesign();
      expect(calls().filter((c) => c.url.includes('design-page-sets'))).toEqual(
        []
      );
      await browse();
      expect(
        calls()
          .filter((c) => c.url.includes('design-page-sets'))
          .map((c) => c.url)
      ).toEqual(['/content-studio/design-page-sets?page=1&archived=false']);
      const builtIn = within(panel()).getByRole('list', {
        name: 'Built-in · Page sets',
      });
      const organization = within(panel()).getByRole('list', {
        name: 'Organization · Page sets',
      });
      expect(builtIn.textContent).toContain('Social core');
      expect(builtIn.textContent).toContain('Portrait 1080 × 1350');
      expect(
        within(builtIn)
          .getAllByRole('button')
          .map((b) => b.textContent)
      ).toEqual(['Add pages']);
      expect(
        within(organization)
          .getAllByRole('button')
          .map((b) => b.textContent)
      ).toEqual(['Add pages', 'Edit details', 'Archive']);
      expect(panel().textContent).not.toContain('Old set');
      expect(panel().querySelectorAll('canvas, img, [src]')).toHaveLength(0);
      expect(
        calls().filter((c) => /render|design-ref|\/media/.test(c.url))
      ).toEqual([]);
    }
  );

  ui(
    'PFA3/PA3/PA4 one operation adds every page after the last one; the first added page opens with nothing selected',
    async () => {
      await openDesign();
      await row('Title');
      await browse();
      await click(button('Add pages Social core', panel()));
      expect(pageCards().map(cardText)).toEqual([
        'Page 1Launch1080 × 1080',
        'Page 2Back1080 × 1350',
        'Page 3Square1080 × 1080',
        'Page 4Portrait1080 × 1350',
        'Page 5Story1080 × 1920',
      ]);
      expect(current()).toBe(2);
      expect(
        document.querySelectorAll('[data-layer-row][aria-pressed="true"]')
      ).toHaveLength(0);
      expect(writes()).toEqual([]);
    }
  );

  ui(
    'PA5/PA6/PA7 one undo step removes them all; redo brings back the same pages',
    async () => {
      await openDesign();
      await browse();
      await click(button('Add pages Our pair', panel()));
      const made = pageCards().map(cardText);
      expect(made).toHaveLength(4);
      await click(button('Undo', toolbar()));
      expect(pageCards()).toHaveLength(2);
      expect(button('Undo', toolbar()).disabled).toBe(true);
      await click(button('Redo', toolbar()));
      expect(pageCards().map(cardText)).toEqual(made);
      const body = await saveDraft();
      expect(Object.keys(body)).toEqual(['baseRevisionNumber', 'content']);
      expect(body.content.pages[2]).toMatchObject({
        name: 'Cover',
        width: 1080,
        height: 1350,
        background: solid(lit('#123456')),
        layers: [],
      });
      expect(JSON.stringify(body)).not.toMatch(/pageSet|page-set|Our pair/);
    }
  );

  ui(
    'PFA7/PA9 a design that would pass 25 pages adds nothing: a fixed message, no undo step',
    async () => {
      await openDesign(
        Array.from({ length: 21 }, (_, i) => pageOf(`p_more${i}`, '', [64, 64]))
      );
      await browse();
      await click(button('Add pages Social core', panel()));
      expect(mockToast).toHaveBeenCalledWith(
        'A design can have up to 25 pages.',
        'warning'
      );
      expect(pageCards()).toHaveLength(23);
      expect(current()).toBe(0);
      expect(button('Undo', toolbar()).disabled).toBe(true);
    }
  );

  ui(
    'edit details, archive and restore send exactly their requests',
    async () => {
      await openDesign();
      await browse();
      await click(button('Edit details Our pair', panel()));
      const form = dialog('Edit details');
      await type(within(form).getByLabelText('Page set name'), 'Our two');
      await submit(form);
      expect(writes().pop()).toEqual({
        method: 'PATCH',
        url: `/content-studio/design-page-sets/${pageSets[0].id}`,
        body: { name: 'Our two', description: 'Ours' },
      });
      await click(button('Archive Our two', panel()));
      expect(writes().pop()).toEqual({
        method: 'POST',
        url: `/content-studio/design-page-sets/${pageSets[0].id}/archive`,
        body: undefined,
      });
      expect(panel().textContent).not.toContain('Our two');
      await click(button('Archived page sets', panel()));
      const archived = dialog('Archived page sets');
      await click(button('Restore Old set', archived));
      expect(writes().pop()).toEqual({
        method: 'POST',
        url: `/content-studio/design-page-sets/${pageSets[1].id}/restore`,
        body: undefined,
      });
      expect(
        writes().filter((c) => c.method === 'DELETE' || /revisions/.test(c.url))
      ).toEqual([]);
    }
  );
});

// ============================================================================
describe('Page sets in the template workspace', () => {
  ui(
    'PT1/PT2/PT3/PT4 saving takes the structure only; adding makes blank pages; the guidance stays exactly as it was',
    async () => {
      await show(
        h(ContentStudioDesignTemplateWorkspace, { templateId: template.id })
      );
      await click(button('Edit template'));
      await click(button('Save page set', panel()));
      const form = dialog('Save page set');
      await type(within(form).getByLabelText('Page set name'), 'From template');
      await submit(form);
      const sent = writes().pop()!;
      expect(JSON.stringify(sent.body)).not.toMatch(
        /headline|slots|guidance|title/i
      );
      await browse();
      await click(button('Add pages Social core', panel()));
      const body = await saveDraft();
      expect(Object.keys(body).sort()).toEqual([
        'baseRevisionNumber',
        'content',
        'guidance',
      ]);
      expect(body.guidance).toEqual(GUIDANCE);
      expect(body.content.pages).toHaveLength(5);
      for (const page of body.content.pages.slice(2)) {
        expect(page.layers).toEqual([]);
      }
    }
  );
});

// ============================================================================
describe('Page set boundaries', () => {
  const dir = __dirname;
  const ROOT = join(dir, '../../../../..');
  const code = (file: string) =>
    readFileSync(join(ROOT, file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
  const CS = 'apps/frontend/src/components/content-studio';
  const FILES = [
    `${CS}/content-studio.design-page-sets.tsx`,
    `${CS}/content-studio.design-page-sets.api.ts`,
  ];

  it('P417-10/P417-11/P417-12 previews are DOM boxes: no render, canvas, image, Fabric, Media, storage or AI', () => {
    for (const file of FILES) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /from 'fabric'|toJSON|toObject|loadFromJSON|\/render|ContentStudioDesignCanvas|<canvas|<img|\/media|design-ref|getMediaDesignRef|localStorage|sessionStorage|\/ai\/|generate|marketplace|public/
        ),
      ]);
    }
  });

  it('the client uses the five page set routes only and never sends an organization, user, hash, page id or layers', () => {
    const api = code(`${CS}/content-studio.design-page-sets.api.ts`);
    expect(api).not.toMatch(/DELETE|PUT|\/apply|\/instantiate/);
    expect(api.match(/method: '(POST|PATCH)'/g)).toEqual([
      "method: 'POST'",
      "method: 'PATCH'",
      "method: 'POST'",
      "method: 'POST'",
    ]);
    expect(api).toMatch(
      /content: \{\s*schemaVersion: input\.content\.schemaVersion,\s*pages: input\.content\.pages,\s*\}/
    );
    for (const file of FILES) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /organizationId|userId|createdById|contentHash: (?!string)|layers:/
        ),
      ]);
    }
    expect(code(`${CS}/content-studio.designs.api.ts`)).toContain(
      'body: JSON.stringify({ name, pageSetId })'
    );
  });

  it('P417-1/P417-2/P417-9 Design Document v1 and its save body are unchanged', () => {
    const document = code(
      'libraries/nestjs-libraries/src/content-studio/design/design.document.ts'
    );
    expect(document).toContain(
      'export const DESIGN_DOCUMENT_SCHEMA_VERSION = 1;'
    );
    expect(document).not.toMatch(/pageSet|campaign|responsive|breakpoint/i);
    expect(code(`${CS}/content-studio.designs.api.ts`)).toContain(
      'body: JSON.stringify({ baseRevisionNumber, content })'
    );
  });

  it('P417-6/P417-7/P417-8 the add operation keeps nothing of the page set and the content parser refuses layers, Media and Brand', () => {
    const editor = code(`${CS}/content-studio.design.editor.ts`);
    const add = editor.slice(
      editor.indexOf('export const addContentStudioDesignPageSet'),
      editor.indexOf('export const deleteContentStudioDesignPage')
    );
    expect(add).toContain('instantiateContentStudioDesignPageSet(content');
    expect(add).toContain('[...document.pages, ...added]');
    expect(add).toContain('parseContentStudioDesignDocument(next)');
    expect(add).not.toMatch(/pageSetId|source|campaign|latest|brandKit/);
    const pure = code(
      'libraries/nestjs-libraries/src/content-studio/design/design.page.set.ts'
    );
    expect(pure).toContain(
      "const PAGE_KEYS = ['name', 'width', 'height', 'background'];"
    );
    expect(pure).toContain("if (color.type !== 'literal') {");
  });

  it('P417-13 no new dependency; Fabric stays 6.9.1', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.dependencies.fabric).toBe('6.9.1');
  });

  it('the canvas presets are one list, shared by new designs, size variants and built-in page sets', () => {
    expect(code(`${CS}/content-studio.designs.api.ts`)).not.toMatch(
      /1350|1920|628/
    );
    expect(
      code(
        'libraries/nestjs-libraries/src/content-studio/design/design.system.page.sets.ts'
      )
    ).not.toMatch(/1080|1350|1920|628/);
  });
});
