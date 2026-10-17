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

// Creative Studio templates (P4-11): the template library, using a template,
// saving a design revision as a template and the template workspace. A
// .spec.ts without JSX, like the other Content Studio frontend specs:
// components are required, not imported. The Fabric adapter is an inert
// stand-in (direct canvas editing has its own spec)
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
  ContentStudioDesignTemplates,
} = require('./content-studio.design-templates');
const {
  ContentStudioDesignTemplateWorkspace,
} = require('./content-studio.design-template.workspace');
const {
  ContentStudioDesignWorkspace,
} = require('./content-studio.design.workspace');

type Plain = Record<string, any>;
type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const SECRET = 'DESIGN_TEMPLATE_SERVER_SECRET_123';
const HTML_MARKER = 'DESIGN_TEMPLATE_HTML_MARKER_456';
const T0 = '2026-10-10T10:00:00.000Z';
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const lit = (value: string) => ({ type: 'literal', value });
const rect = (id: string, extra: Plain = {}) => ({
  id,
  name: `${id} <b>${HTML_MARKER}</b>`,
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  rotation: 0,
  opacity: 1,
  visible: true,
  type: 'shape',
  shape: 'rectangle',
  fill: lit('#ff0000'),
  cornerRadius: 0,
  ...extra,
});
const image = (id: string) => ({
  ...rect(id),
  type: 'image',
  imageRef: { type: 'media', mediaId: 'media-1', sha256: SHA('a') },
  fit: 'cover',
  focalPoint: { x: 0.5, y: 0.5 },
  shape: undefined,
  fill: undefined,
  cornerRadius: undefined,
});
const doc = (layers: Plain[], width = 1080, height = 1080) => ({
  schemaVersion: 1,
  brandKit: null,
  pages: [
    {
      id: 'p_one',
      name: 'One',
      width,
      height,
      background: { type: 'solid', color: lit('#ffffff') },
      layers: layers.map((l) => JSON.parse(JSON.stringify(l))),
    },
  ],
});
const system = (id: string, name: string, height: number) => ({
  source: 'system',
  id,
  name,
  description: `${name} <b>${HTML_MARKER}</b>`,
  latestRevisionNumber: 1,
  archivedAt: null,
  currentRevision: {
    revisionNumber: 1,
    schemaVersion: 1,
    contentHash: SHA('s'),
    content: doc([rect('band')], 1080, height),
  },
});
const SYSTEM = [
  system('system:square-post', 'Square post', 1080),
  system('system:story', 'Story', 1920),
];

let counter = 0;
const nextId = () =>
  `${String(++counter).padStart(8, '0')}-0000-4000-8000-000000000000`;
type Revision = {
  id: string;
  revisionNumber: number;
  content: any;
  guidance?: any;
};
type Template = {
  id: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  revisions: Revision[];
};
let templates: Template[];
let designs: Array<{ id: string; name: string; revisions: Revision[] }>;
const revision = (
  revisionNumber: number,
  content: any,
  guidance: any = null
): Revision => ({
  id: nextId(),
  revisionNumber,
  content,
  guidance,
});
const withGuidance = (r: Revision) => ({
  ...meta(r),
  content: r.content,
  guidanceHash: r.guidance ? SHA('g') : null,
  guidance: r.guidance ?? null,
});
const meta = (r: Revision) => ({
  id: r.id,
  revisionNumber: r.revisionNumber,
  schemaVersion: 1,
  contentHash: SHA(String(r.revisionNumber)),
  createdAt: T0,
});
const latest = <T extends { revisions: Revision[] }>(x: T) =>
  x.revisions[x.revisions.length - 1];
const templateSummary = (t: Template) => ({
  source: 'organization',
  id: t.id,
  name: t.name,
  description: t.description,
  latestRevisionNumber: t.revisions.length,
  archivedAt: t.archivedAt,
  createdAt: T0,
  updatedAt: T0,
});
const templateDetail = (t: Template) => ({
  ...templateSummary(t),
  currentRevision: withGuidance(latest(t)),
});
const designSummary = (d: (typeof designs)[number]) => ({
  id: d.id,
  name: d.name,
  latestRevisionNumber: d.revisions.length,
  archivedAt: null,
  createdAt: T0,
  updatedAt: T0,
});
let override: (method: string, url: string, body: any) => Reply | undefined;
// the exact Brand Kit revisions the server has
const KIT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const REV_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const REV_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const brandContent = (value: string) => ({
  schemaVersion: 1,
  identity: { brandName: 'Northwind', tagline: '', description: '' },
  colors: [{ id: 'primary', name: 'Primary', value, role: 'primary' }],
  typography: [],
  visualDirection: { keywords: [], dos: [], donts: [] },
});
let BRANDS: Record<string, Plain>;
const brandRevision = (id: string, revisionNumber: number, value: string) => ({
  id,
  revisionNumber,
  schemaVersion: 1,
  contentHash: SHA(String(revisionNumber + 4)),
  createdAt: T0,
  content: brandContent(value),
});
const brandRef = (id: string) => ({
  brandKitId: KIT,
  revisionId: id,
  revisionNumber: BRANDS[id].revisionNumber,
  contentHash: BRANDS[id].contentHash,
});

const server = (method: string, url: string, body: any): Reply => {
  const { pathname, searchParams } = new URL(url, 'https://api.test');
  const T = '/content-studio/design-templates';
  if (pathname === T && method === 'GET') {
    const archived = searchParams.get('archived') === 'true';
    return reply(200, {
      system: archived ? [] : SYSTEM,
      pages: 1,
      results: templates
        .filter((t) => !!t.archivedAt === archived)
        .map(templateDetail),
    });
  }
  if (pathname === T && method === 'POST') {
    const t: Template = {
      id: nextId(),
      name: body.name,
      description: body.description || null,
      archivedAt: null,
      revisions: [revision(1, body.content)],
    };
    templates.push(t);
    return reply(201, templateDetail(t));
  }
  if (pathname === `${T}/instantiate` && method === 'POST') {
    const d = {
      id: nextId(),
      name: body.name,
      revisions: [revision(1, doc([]))],
    };
    designs.push(d);
    return reply(201, designSummary(d));
  }
  const tm = pathname.match(
    /^\/content-studio\/design-templates\/([^/]+)(?:\/(revisions|archive|restore)(?:\/([^/]+))?)?$/
  );
  if (tm) {
    const t = templates.find((x) => x.id === tm[1]);
    if (!t) {
      return reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
    }
    const [, , action, revisionId] = tm;
    if (method === 'GET' && !action) return reply(200, templateDetail(t));
    if (method === 'PATCH') {
      Object.assign(t, body);
      return reply(200, templateSummary(t));
    }
    if (method === 'POST' && action === 'archive') {
      t.archivedAt = T0;
      return reply(200, templateSummary(t));
    }
    if (method === 'POST' && action === 'restore') {
      t.archivedAt = null;
      return reply(200, templateSummary(t));
    }
    if (method === 'GET' && action === 'revisions' && !revisionId) {
      return reply(200, {
        pages: 1,
        results: [...t.revisions].reverse().map(meta),
      });
    }
    if (method === 'GET' && action === 'revisions' && revisionId) {
      const r = t.revisions.find((x) => x.id === revisionId);
      return r
        ? reply(200, withGuidance(r))
        : reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
    }
    if (method === 'POST' && action === 'revisions') {
      if (body.baseRevisionNumber !== t.revisions.length) {
        return reply(409, {
          msg: SECRET,
          code: 'CS_DESIGN_TEMPLATE_REVISION_CONFLICT',
        });
      }
      const r = revision(t.revisions.length + 1, body.content, body.guidance);
      t.revisions.push(r);
      return reply(201, { created: true, revision: withGuidance(r) });
    }
  }
  // Brand Kit revisions (P4-12): exact revisions by id, and the list
  const bm = pathname.match(
    /^\/content-studio\/brand-kit\/revisions\/([^/]+)$/
  );
  if (bm && method === 'GET') {
    const b = BRANDS[bm[1]];
    return b
      ? reply(200, b)
      : reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
  }
  if (pathname === '/content-studio/brand-kit/revisions' && method === 'GET') {
    return reply(200, {
      pages: 1,
      results: Object.values(BRANDS).map(({ content, ...rest }) => rest),
    });
  }
  // Media (P4-12): one page of the library and the server's design reference
  if (pathname === '/media' && method === 'GET') {
    return reply(200, {
      pages: 1,
      results: [
        {
          id: 'media-2',
          name: 'beach.png',
          originalName: 'beach.png',
          path: '/uploads/beach.png',
          thumbnail: null,
          alt: '',
        },
      ],
    });
  }
  const mm = pathname.match(/^\/content-studio\/media\/([^/]+)\/design-ref$/);
  if (mm && method === 'GET') {
    return reply(200, { mediaId: mm[1], sha256: SHA('m') });
  }
  const D = '/content-studio/designs';
  if (pathname === D && method === 'GET') {
    return reply(200, { pages: 1, results: designs.map(designSummary) });
  }
  const dm = pathname.match(
    /^\/content-studio\/designs\/([^/]+)(?:\/(revisions)(?:\/([^/]+)(\/save-as-template)?)?)?$/
  );
  if (dm) {
    const d = designs.find((x) => x.id === dm[1]);
    if (!d) return reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
    if (method === 'GET' && !dm[2]) {
      return reply(200, {
        ...designSummary(d),
        currentRevision: { ...meta(latest(d)), content: latest(d).content },
      });
    }
    if (method === 'GET' && dm[2] && !dm[3]) {
      return reply(200, {
        pages: 1,
        results: [...d.revisions].reverse().map(meta),
      });
    }
    if (method === 'GET' && dm[3] && !dm[4]) {
      const r = d.revisions.find((x) => x.id === dm[3]);
      return r
        ? reply(200, { ...meta(r), content: r.content })
        : reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
    }
    if (method === 'POST' && dm[4]) {
      const r = d.revisions.find((x) => x.id === dm[3]);
      if (!r) return reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
      const t: Template = {
        id: nextId(),
        name: body.name,
        description: body.description || null,
        archivedAt: null,
        revisions: [revision(1, r.content)],
      };
      templates.push(t);
      return reply(201, templateDetail(t));
    }
  }
  return reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
};

let storageSpies: jest.SpyInstance[];
let consoleSpies: jest.SpyInstance[];
let CUSTOM: Template;
let ARCHIVED: Template;

beforeEach(() => {
  counter = 0;
  mockModals.set([]);
  CUSTOM = {
    id: nextId(),
    name: `Launch <b>${HTML_MARKER}</b>`,
    description: 'For launches',
    archivedAt: null,
    revisions: [
      revision(1, doc([rect('old')])),
      revision(2, doc([rect('box'), image('photo')])),
    ],
  };
  ARCHIVED = {
    id: nextId(),
    name: 'Old template',
    description: null,
    archivedAt: T0,
    revisions: [revision(1, doc([rect('box')]))],
  };
  templates = [CUSTOM, ARCHIVED];
  BRANDS = {
    [REV_A]: brandRevision(REV_A, 1, '#0057ff'),
    [REV_B]: brandRevision(REV_B, 2, '#ff5700'),
  };
  designs = [
    {
      id: nextId(),
      name: 'My design',
      revisions: [
        revision(1, doc([rect('d1')])),
        revision(2, doc([rect('d2')])),
      ],
    },
  ];
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
  mockPush.mockReset();
  storageSpies = [
    jest.spyOn(Storage.prototype, 'setItem'),
    jest.spyOn(Storage.prototype, 'getItem'),
  ];
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
    (level) => jest.spyOn(console, level)
  );
});

afterEach(() => {
  for (const spy of storageSpies) {
    expect(spy).not.toHaveBeenCalled();
  }
  for (const spy of consoleSpies) {
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(
      new RegExp(`${SECRET}|${HTML_MARKER}`)
    );
  }
  for (const [text] of mockToast.mock.calls) {
    expect(String(text)).not.toMatch(new RegExp(`${SECRET}|${HTML_MARKER}`));
  }
  expect(document.body.textContent).not.toContain(SECRET);
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
  within(root).getByRole('button', { name });
const queryButton = (
  name: string | RegExp,
  root: HTMLElement = document.body
) => within(root).queryByRole('button', { name });
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
const card = (name: RegExp) =>
  screen.getByRole('heading', { level: 3, name }).closest('li') as HTMLElement;
const dialog = (title: string) => screen.getByRole('dialog', { name: title });
const submit = async (root: HTMLElement) => {
  fireEvent.submit(root.querySelector('form') as HTMLFormElement);
  await flush();
};
const UI_TIMEOUT = 60_000;
const ui = (name: string, test: () => Promise<void>) =>
  it(name, test, UI_TIMEOUT);

// ============================================================================
describe('Template library', () => {
  ui(
    'TL1/TL2/TL3 built-in and organization templates, each labelled by source in text',
    async () => {
      await show(h(ContentStudioDesignTemplates));
      const builtIn = screen.getByRole('list', { name: 'Built-in templates' });
      const organization = screen.getByRole('list', {
        name: 'Organization templates',
      });
      expect(
        within(builtIn)
          .getAllByRole('heading', { level: 3 })
          .map((e) => e.textContent)
      ).toEqual(['Square post', 'Story']);
      expect(
        within(organization)
          .getAllByRole('heading', { level: 3 })
          .map((e) => e.textContent)
      ).toEqual([`Launch <b>${HTML_MARKER}</b>`]);
      expect(card(/Square post/).textContent).toContain('Built-in');
      expect(card(/Launch/).textContent).toContain('Organization');
      expect(card(/Launch/).textContent).toContain('Revision 2');
    }
  );

  ui(
    'TL4/TL5/M26 only organization templates can be opened, edited, archived; built-ins can only be used',
    async () => {
      await show(h(ContentStudioDesignTemplates));
      const builtIn = card(/Square post/);
      expect(
        within(builtIn)
          .getAllByRole('button')
          .map((b) => b.textContent)
      ).toEqual(['Use template']);
      expect(within(builtIn).queryByRole('link')).toBeNull();
      const custom = card(/Launch/);
      expect(
        within(custom)
          .getAllByRole('button')
          .map((b) => b.textContent)
      ).toEqual(['Use template', 'Edit details', 'Archive']);
      expect(
        within(custom)
          .getByRole('link', { name: /^Open / })
          .getAttribute('href')
      ).toBe(`/content-studio/templates/${CUSTOM.id}`);
      await click(button(/^Archive Launch/));
      expect(mockConfirm).toHaveBeenCalledTimes(1);
      expect(writes()).toEqual([
        {
          method: 'POST',
          url: `/content-studio/design-templates/${CUSTOM.id}/archive`,
          body: undefined,
        },
      ]);
    }
  );

  ui(
    'TL6/TL7/TL8/TL9/M23/M24/M25 each card is a structural thumbnail: no render, Media or canvas',
    async () => {
      await show(h(ContentStudioDesignTemplates));
      const cards = Array.from(document.querySelectorAll('li[data-template]'));
      expect(cards).toHaveLength(3);
      for (const entry of cards) {
        const thumbnails = entry.querySelectorAll('[data-preview="thumbnail"]');
        expect(thumbnails).toHaveLength(1);
        expect(thumbnails[0].parentElement?.getAttribute('aria-hidden')).toBe(
          'true'
        );
      }
      // the story thumbnail keeps the page proportions
      const story = card(/Story/).querySelector('[data-preview="thumbnail"]')
        ?.parentElement as HTMLElement;
      expect(story.style.height).toBe('80px');
      expect(card(/Launch/).textContent).toContain('Image');
      expect(document.querySelectorAll('canvas, img, [src]')).toHaveLength(0);
      expect(calls().map((c) => `${c.method} ${c.url}`)).toEqual([
        'GET /content-studio/design-templates?page=1&archived=false',
      ]);
    }
  );

  ui(
    'TL10/UT6/M27 archived templates are apart: Restore and Open, never Use',
    async () => {
      await show(h(ContentStudioDesignTemplates));
      expect(
        screen.queryByRole('heading', { level: 3, name: 'Old template' })
      ).toBeNull();
      await click(button('Archived'));
      expect(
        screen.queryByRole('list', { name: 'Built-in templates' })
      ).toBeNull();
      const archived = card(/Old template/);
      expect(
        within(archived)
          .getAllByRole('button')
          .map((b) => b.textContent)
      ).toEqual(['Restore']);
      expect(archived.textContent).toContain('Archived');
      await click(button(/^Restore Old template/));
      expect(writes().map((c) => c.url)).toEqual([
        `/content-studio/design-templates/${ARCHIVED.id}/restore`,
      ]);
    }
  );

  ui(
    'a new organization template starts as one blank page and opens',
    async () => {
      await show(h(ContentStudioDesignTemplates));
      await click(button('Create template'));
      const modal = dialog('Create template');
      fireEvent.change(within(modal).getByLabelText('Template name'), {
        target: { value: '  Promo  ' },
      });
      await submit(modal);
      const [post] = writes();
      expect(post.url).toBe('/content-studio/design-templates');
      expect(Object.keys(post.body).sort()).toEqual([
        'content',
        'description',
        'name',
      ]);
      expect(post.body.name).toBe('Promo');
      expect(post.body.content.pages[0]).toMatchObject({
        width: 1080,
        height: 1080,
        layers: [],
      });
      expect(mockPush).toHaveBeenCalledWith(
        `/content-studio/templates/${templates[templates.length - 1].id}`
      );
    }
  );
});

// ============================================================================
describe('Use template', () => {
  ui(
    'UT1/UT2/UT3/UT4 a built-in template: a design name, then exactly its id and revision number; the design opens',
    async () => {
      await show(h(ContentStudioDesignTemplates));
      await click(button(/^Use template Story/));
      const modal = dialog('Use template');
      const name = within(modal).getByLabelText(
        'Design name'
      ) as HTMLInputElement;
      expect(name.value).toBe('Story');
      fireEvent.change(name, { target: { value: ' My story ' } });
      await submit(modal);
      expect(writes()).toEqual([
        {
          method: 'POST',
          url: '/content-studio/design-templates/instantiate',
          body: {
            source: 'system',
            templateId: 'system:story',
            revisionNumber: 1,
            name: 'My story',
          },
        },
      ]);
      expect(mockPush).toHaveBeenCalledWith(
        `/content-studio/designs/${designs[designs.length - 1].id}`
      );
    }
  );

  ui(
    'UT5 an organization template: exactly its current revision id, never its document',
    async () => {
      await show(h(ContentStudioDesignTemplates));
      await click(button(/^Use template Launch/));
      await submit(dialog('Use template'));
      const [post] = writes();
      expect(post.body).toEqual({
        source: 'organization',
        templateId: CUSTOM.id,
        revisionId: CUSTOM.revisions[1].id,
        name: `Launch <b>${HTML_MARKER}</b>`,
      });
      expect(JSON.stringify(post.body)).not.toMatch(/content|pages|layers/);
    }
  );

  ui('a failed use keeps the form, with a fixed message', async () => {
    override = (method, url) =>
      url.endsWith('/instantiate')
        ? reply(409, { msg: SECRET, code: 'CS_DESIGN_TEMPLATE_ARCHIVED' })
        : undefined;
    await show(h(ContentStudioDesignTemplates));
    await click(button(/^Use template Launch/));
    await submit(dialog('Use template'));
    expect(mockToast).toHaveBeenCalledWith(
      'This template is archived.',
      'warning'
    );
    expect(mockPush).not.toHaveBeenCalled();
    expect(dialog('Use template')).toBeTruthy();
  });
});

// ============================================================================
describe('Save as template', () => {
  ui(
    'ST1/ST3/ST4/M20 a saved design revision: the request names it and holds details only; the template opens',
    async () => {
      const design = designs[0];
      await show(h(ContentStudioDesignWorkspace, { designId: design.id }));
      await click(button('Save as template'));
      const modal = dialog('Save as template');
      expect(modal.textContent).toContain('saved revision 2');
      fireEvent.change(within(modal).getByLabelText('Template name'), {
        target: { value: 'From design' },
      });
      await submit(modal);
      expect(writes()).toEqual([
        {
          method: 'POST',
          url: `/content-studio/designs/${design.id}/revisions/${design.revisions[1].id}/save-as-template`,
          body: { name: 'From design', description: '' },
        },
      ]);
      expect(mockPush).toHaveBeenCalledWith(
        `/content-studio/templates/${templates[templates.length - 1].id}`
      );
    }
  );

  ui('SAT5 an opened older design revision is saved as itself', async () => {
    const design = designs[0];
    await show(h(ContentStudioDesignWorkspace, { designId: design.id }));
    await click(button('View Revision 1'));
    await click(button('Save as template'));
    await submit(dialog('Save as template'));
    expect(writes()[0].url).toBe(
      `/content-studio/designs/${design.id}/revisions/${design.revisions[0].id}/save-as-template`
    );
  });

  ui('ST2/M21 an unsaved draft cannot be saved as a template', async () => {
    await show(h(ContentStudioDesignWorkspace, { designId: designs[0].id }));
    await click(button('Edit design'));
    expect((button('Save as template') as HTMLButtonElement).disabled).toBe(
      false
    );
    await click(button('Add rectangle'));
    expect((button('Save as template') as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(
      screen.getByText(
        'Save your changes first: a template is made from a saved revision.'
      )
    ).toBeTruthy();
    expect(writes()).toEqual([]);
  });
});

// ============================================================================
describe('Template workspace', () => {
  const open = (template: Template = CUSTOM) =>
    show(h(ContentStudioDesignTemplateWorkspace, { templateId: template.id }));
  const toolbar = () => screen.getByRole('toolbar', { name: 'Design editor' });

  ui(
    'TW1/TW2/TW6/TW7/TW8/M29 the current revision is edited and saved as the next template revision: Design Document v1 only',
    async () => {
      await open();
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        `Launch <b>${HTML_MARKER}</b>`
      );
      expect(queryButton('Render page')).toBeNull();
      await click(button('Edit template'));
      await click(button('Add rectangle'));
      fireEvent.click(screen.getByRole('switch', { name: 'Snap' }));
      await flush();
      await click(button('Save', toolbar()));
      const [post] = writes();
      expect(post.url).toBe(
        `/content-studio/design-templates/${CUSTOM.id}/revisions`
      );
      // P4-12: the guidance goes with the document: none here
      expect(Object.keys(post.body).sort()).toEqual([
        'baseRevisionNumber',
        'content',
        'guidance',
      ]);
      expect(post.body.guidance).toBeNull();
      expect(post.body.baseRevisionNumber).toBe(2);
      expect(Object.keys(post.body.content).sort()).toEqual([
        'brandKit',
        'pages',
        'schemaVersion',
      ]);
      expect(
        post.body.content.pages[0].layers.map((l: Plain) => l.id).slice(0, 2)
      ).toEqual(['box', 'photo']);
      // the image reference stays exactly as stored
      expect(post.body.content.pages[0].layers[1].imageRef).toEqual({
        type: 'media',
        mediaId: 'media-1',
        sha256: SHA('a'),
      });
      const keys = new Set<string>();
      JSON.parse(JSON.stringify(post.body), (k, v) => (keys.add(k), v));
      for (const word of [
        'selectedLayerId',
        'clipboard',
        'snap',
        'guides',
        'zoom',
        'panX',
        'scaleX',
        'left',
        'objects',
        'templateId',
        'source',
      ]) {
        expect([word, keys.has(word)]).toEqual([word, false]);
      }
      expect(mockToast).toHaveBeenCalledWith(
        'Template saved as Revision 3.',
        'success'
      );
      expect(CUSTOM.revisions).toHaveLength(3);
    }
  );

  ui(
    'TW3/M28/M31 an older revision is shown exactly and read-only; it can be used as itself',
    async () => {
      await open();
      await click(button('View Revision 1'));
      expect(screen.getByText('Read-only historical revision')).toBeTruthy();
      expect(queryButton('Edit template')).toBeNull();
      expect(document.querySelector('[data-layer="old"]')).toBeTruthy();
      expect(document.querySelector('[data-layer="box"]')).toBeNull();
      await click(button('Use this revision'));
      await submit(dialog('Use template'));
      expect(writes()[0].body).toMatchObject({
        source: 'organization',
        templateId: CUSTOM.id,
        revisionId: CUSTOM.revisions[0].id,
      });
    }
  );

  ui(
    'TW4 an archived template is read-only: no edit, no use; it can be restored',
    async () => {
      await open(ARCHIVED);
      expect(queryButton('Edit template')).toBeNull();
      expect(queryButton('Use template')).toBeNull();
      expect(queryButton('Edit details')).toBeNull();
      expect(
        screen.getByText(
          'This template is archived: restore it to edit or use it.'
        )
      ).toBeTruthy();
      await click(button('Restore'));
      expect(writes().map((c) => c.url)).toEqual([
        `/content-studio/design-templates/${ARCHIVED.id}/restore`,
      ]);
    }
  );

  ui(
    'TW5 a conflict keeps the draft, blocks saving and is not retried',
    async () => {
      await open();
      await click(button('Edit template'));
      await click(button('Add rectangle'));
      // someone saved meanwhile
      CUSTOM.revisions.push(revision(3, doc([rect('other')])));
      await click(button('Save', toolbar()));
      expect(
        screen.getByText('This design changed while you were editing.')
      ).toBeTruthy();
      expect(writes().filter((c) => c.url.endsWith('/revisions'))).toHaveLength(
        1
      );
      expect((button('Save', toolbar()) as HTMLButtonElement).disabled).toBe(
        true
      );
      expect(CUSTOM.revisions).toHaveLength(3);
    }
  );

  ui('details change without a revision', async () => {
    await open();
    await click(button('Edit details'));
    const modal = dialog('Edit details');
    fireEvent.change(within(modal).getByLabelText('Template name'), {
      target: { value: 'Renamed' },
    });
    await submit(modal);
    expect(writes()).toEqual([
      {
        method: 'PATCH',
        url: `/content-studio/design-templates/${CUSTOM.id}`,
        body: { name: 'Renamed', description: 'For launches' },
      },
    ]);
  });

  ui('a missing template is a fixed message', async () => {
    await show(
      h(ContentStudioDesignTemplateWorkspace, {
        templateId: '99999999-0000-4000-8000-000000000000',
      })
    );
    expect(screen.getByRole('alert').textContent).toBe('Template not found.');
  });
});

// ============================================================================
// P4-12: template fields, guided use and Brand-resolved thumbnails
const words = (id: string, value: string, name = id) => ({
  id,
  name,
  x: 10,
  y: 200,
  width: 400,
  height: 80,
  rotation: 0,
  opacity: 1,
  visible: true,
  type: 'text',
  text: value,
  font: { type: 'family', family: 'Inter', weight: 400, style: 'normal' },
  fontSize: 24,
  lineHeight: 1.2,
  letterSpacing: 0,
  color: lit('#000000'),
  align: 'left',
  verticalAlign: 'top',
  overflow: 'clip',
});
const branded = (revisionId: string, layers: Plain[]) => ({
  ...doc(layers),
  brandKit: brandRef(revisionId),
});
const brandRect = (id: string) =>
  rect(id, { fill: { type: 'brand', tokenId: 'primary' } });
const HEADLINE = {
  id: 'headline',
  type: 'text',
  label: 'Headline',
  description: 'A few words',
  pageId: 'p_one',
  layerId: 'title',
  required: true,
  multiline: false,
};
const BODY = {
  id: 'body',
  type: 'text',
  label: 'Body',
  pageId: 'p_one',
  layerId: 'body',
  required: false,
  multiline: true,
};
const PHOTO = {
  id: 'photo',
  type: 'image',
  label: 'Photo',
  pageId: 'p_one',
  layerId: 'photo',
  required: false,
};
const guidanceOf = (slots: Plain[], brandRebinding = false) => ({
  schemaVersion: 1,
  brandRebinding,
  slots,
});
let GUIDED: Template;

describe('P4-12 guided use', () => {
  beforeEach(() => {
    GUIDED = {
      id: nextId(),
      name: 'Guided',
      description: null,
      archivedAt: null,
      revisions: [
        revision(
          1,
          branded(REV_A, [
            brandRect('band'),
            words('title', 'Big news', 'Title'),
            words('body', 'Line one\nline two', 'Body'),
            image('photo'),
          ]),
          guidanceOf([HEADLINE, BODY, PHOTO], true)
        ),
      ],
    };
    templates = [GUIDED, CUSTOM, ARCHIVED];
  });
  const openUse = async (name: RegExp = /^Use template Guided/) => {
    await show(h(ContentStudioDesignTemplates));
    await click(button(name));
    return dialog('Use template');
  };

  ui(
    'GUI1 a template without guidance is used exactly like before: no fields, no values',
    async () => {
      const modal = await openUse(/^Use template Launch/);
      expect(within(modal).queryByText('Template fields')).toBeNull();
      expect(within(modal).queryByRole('checkbox')).toBeNull();
      await submit(modal);
      expect(writes()[0].body).toEqual({
        source: 'organization',
        templateId: CUSTOM.id,
        revisionId: CUSTOM.revisions[1].id,
        name: `Launch <b>${HTML_MARKER}</b>`,
      });
    }
  );

  ui(
    'GUI2/GUI7/GUI9 text fields in guidance order, labelled, described and starting from the template text; only the revision’s fields are sent',
    async () => {
      const modal = await openUse();
      const fields = Array.from(
        modal.querySelectorAll('[data-template-field]')
      ).map((entry) => entry.getAttribute('data-template-field'));
      expect(fields).toEqual(['text', 'text', 'image']);
      const headline = within(modal).getByLabelText(
        'Headline (required)'
      ) as HTMLInputElement;
      expect(headline.tagName).toBe('INPUT');
      expect(headline.value).toBe('Big news');
      expect(headline.getAttribute('aria-required')).toBe('true');
      const described = headline.getAttribute('aria-describedby') as string;
      expect(document.getElementById(described)?.textContent).toBe(
        'A few words'
      );
      const body = within(modal).getByLabelText('Body') as HTMLTextAreaElement;
      expect(body.tagName).toBe('TEXTAREA');
      expect(body.value).toBe('Line one\nline two');
      fireEvent.change(headline, { target: { value: '  Launch day ' } });
      await submit(modal);
      const [post] = writes();
      expect(post.body).toEqual({
        source: 'organization',
        templateId: GUIDED.id,
        revisionId: GUIDED.revisions[0].id,
        name: 'Guided',
        values: { headline: '  Launch day ', body: 'Line one\nline two' },
      });
      expect(JSON.stringify(post.body)).not.toMatch(
        /content|pages|layers|title|guidance|https?:/
      );
      expect(mockPush).toHaveBeenCalledWith(
        `/content-studio/designs/${designs[designs.length - 1].id}`
      );
    }
  );

  ui(
    'GUI3/GUI4/M8 an image field opens the Media picker and sends exactly the server’s design reference',
    async () => {
      const modal = await openUse();
      expect(
        within(modal).getByText('The template image is used.')
      ).toBeTruthy();
      await click(button('Choose image: Photo', modal));
      const picker = dialog('Choose image');
      await click(within(picker).getByRole('button', { name: 'beach.png' }));
      await click(button('Use image', picker));
      expect(
        calls().some(
          (c) => c.url === '/content-studio/media/media-2/design-ref'
        )
      ).toBe(true);
      expect(within(modal).getByText('A new image is chosen.')).toBeTruthy();
      await submit(modal);
      const post = writes().find((c) => c.url.endsWith('/instantiate'));
      expect(post?.body.values.photo).toEqual({
        mediaId: 'media-2',
        sha256: SHA('m'),
      });
      expect(JSON.stringify(post?.body)).not.toMatch(/uploads|beach|path|url/i);
    }
  );

  ui(
    'GUI5/GUI8 a required field or the design name left blank blocks the submit, with the reason tied to the field',
    async () => {
      const modal = await openUse();
      const headline = within(modal).getByLabelText('Headline (required)');
      fireEvent.change(headline, { target: { value: '   ' } });
      await flush();
      expect(headline.getAttribute('aria-invalid')).toBe('true');
      const reason = (headline.getAttribute('aria-describedby') as string)
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent);
      expect(reason).toContain('This field is required.');
      const create = button('Create design', modal) as HTMLButtonElement;
      expect(create.disabled).toBe(true);
      await submit(modal);
      fireEvent.change(headline, { target: { value: 'Back' } });
      fireEvent.change(within(modal).getByLabelText('Design name'), {
        target: { value: '  ' },
      });
      await flush();
      expect(create.disabled).toBe(true);
      await submit(modal);
      expect(writes()).toEqual([]);
    }
  );

  ui(
    'GUI6 the server stays authoritative: its refusal is a fixed message and the form stays',
    async () => {
      override = (method, url) =>
        url.endsWith('/instantiate')
          ? reply(400, {
              msg: SECRET,
              code: 'CS_DESIGN_TEMPLATE_FIELD_REQUIRED',
            })
          : undefined;
      const modal = await openUse();
      await submit(modal);
      expect(mockToast).toHaveBeenCalledWith(
        'Fill in every required field.',
        'warning'
      );
      expect(mockPush).not.toHaveBeenCalled();
      expect(dialog('Use template')).toBeTruthy();
    }
  );

  ui(
    'GUI10/BR6 another exact Brand Kit revision only where the template allows it; never a latest lookup',
    async () => {
      const modal = await openUse();
      expect(
        within(modal).getByText(
          'The new design keeps the template’s Brand Kit revision 1.'
        )
      ).toBeTruthy();
      fireEvent.click(
        within(modal).getByLabelText('Use another Brand Kit revision')
      );
      await flush();
      const create = button('Create design', modal) as HTMLButtonElement;
      expect(create.disabled).toBe(true);
      fireEvent.click(within(modal).getByLabelText(/^Revision 2/));
      await flush();
      expect(create.disabled).toBe(false);
      await submit(modal);
      const post = writes().find((c) => c.url.endsWith('/instantiate'));
      expect(post?.body.brandKitRevisionId).toBe(REV_B);
      expect(Object.keys(post?.body ?? {}).sort()).toEqual([
        'brandKitRevisionId',
        'name',
        'revisionId',
        'source',
        'templateId',
        'values',
      ]);
      // the list of revisions to choose from, never the kit's current one
      expect(calls().map((c) => c.url)).not.toContain(
        '/content-studio/brand-kit'
      );
    }
  );

  ui(
    'GUI10b built-in templates have no Brand Kit to rebind: no switch; an incompatible revision is a fixed message',
    async () => {
      const modal = await openUse(/^Use template Story/);
      expect(
        within(modal).queryByLabelText('Use another Brand Kit revision')
      ).toBeNull();
      await click(button('Cancel', modal));
      override = (method, url) =>
        url.endsWith('/instantiate')
          ? reply(400, {
              msg: SECRET,
              code: 'CS_DESIGN_TEMPLATE_BRAND_INCOMPATIBLE',
            })
          : undefined;
      await click(button(/^Use template Guided/));
      const guided = dialog('Use template');
      fireEvent.click(
        within(guided).getByLabelText('Use another Brand Kit revision')
      );
      await flush();
      fireEvent.click(within(guided).getByLabelText(/^Revision 2/));
      await submit(guided);
      expect(mockToast).toHaveBeenCalledWith(
        'The selected Brand Kit revision lacks a color or type style this template uses.',
        'warning'
      );
    }
  );

  ui(
    'GUI7b guidance that does not match its document is never filled in',
    async () => {
      GUIDED.revisions[0].guidance = guidanceOf([
        { ...HEADLINE, layerId: 'gone' },
      ]);
      const modal = await openUse();
      expect(within(modal).getByRole('alert').textContent).toBe(
        'Stored template data could not be read safely.'
      );
      expect(
        (button('Create design', modal) as HTMLButtonElement).disabled
      ).toBe(true);
    }
  );
});

describe('P4-12 template fields in the template workspace', () => {
  beforeEach(() => {
    GUIDED = {
      id: nextId(),
      name: 'Fields',
      description: null,
      archivedAt: null,
      revisions: [
        revision(1, doc([rect('box'), words('title', 'Hello', 'Title')])),
        revision(
          2,
          doc([rect('box'), words('title', 'Hello', 'Title'), image('photo')]),
          guidanceOf([{ ...HEADLINE, required: false }])
        ),
      ],
    };
    templates = [GUIDED, CUSTOM, ARCHIVED];
  });
  const open = (template: Template = GUIDED) =>
    show(h(ContentStudioDesignTemplateWorkspace, { templateId: template.id }));
  const toolbar = () => screen.getByRole('toolbar', { name: 'Design editor' });
  const panel = () =>
    screen.getByRole('region', { name: 'Template fields' }) as HTMLElement;
  // the back-most layer row with this name (rows run front to back)
  const row = async (name: RegExp) => {
    const entries = Array.from(
      document.querySelectorAll('[data-layer-row]')
    ).filter((element) => name.test(element.textContent ?? ''));
    await click(entries[entries.length - 1] as HTMLElement);
  };
  const slotIds = () =>
    Array.from(panel().querySelectorAll('[data-template-slot]')).map((entry) =>
      entry.getAttribute('data-template-slot')
    );
  const saved = () =>
    writes()
      .filter((c) => c.url.endsWith('/revisions'))
      .map((c) => c.body);

  ui(
    'TWG1/TWG2/TWG3/TWG4/TWG11 text and image layers become fields, a shape cannot; the fields are saved with the document',
    async () => {
      await open();
      // read-only until edited
      expect(slotIds()).toEqual(['headline']);
      expect(within(panel()).queryAllByRole('button')).toEqual([]);
      await click(button('Edit template'));
      await row(/^.?box/);
      expect(
        within(panel()).getByText('Shapes cannot be template fields.')
      ).toBeTruthy();
      expect(
        within(panel()).queryByRole('button', { name: /Use as template/ })
      ).toBeNull();
      await row(/photo/);
      await click(button('Use as template image field', panel()));
      expect(slotIds()).toEqual(['headline', 'field_1']);
      fireEvent.change(within(panel()).getByLabelText('Field label'), {
        target: { value: '  Hero image ' },
      });
      fireEvent.click(within(panel()).getByLabelText('Required'));
      await flush();
      await row(/Title/);
      // the existing field of this layer is edited, not added again
      expect(
        within(panel()).queryByRole('button', {
          name: 'Use as template text field',
        })
      ).toBeNull();
      fireEvent.click(within(panel()).getByLabelText('Several lines'));
      await flush();
      await click(button('Save', toolbar()));
      const [body] = saved();
      expect(Object.keys(body).sort()).toEqual([
        'baseRevisionNumber',
        'content',
        'guidance',
      ]);
      expect(body.guidance).toEqual({
        schemaVersion: 1,
        brandRebinding: false,
        slots: [
          { ...HEADLINE, required: false, multiline: true },
          {
            id: 'field_1',
            type: 'image',
            label: 'Hero image',
            pageId: 'p_one',
            layerId: 'photo',
            required: true,
          },
        ],
      });
      // the document is Design Document v1 only
      expect(Object.keys(body.content).sort()).toEqual([
        'brandKit',
        'pages',
        'schemaVersion',
      ]);
      expect(JSON.stringify(body.content)).not.toMatch(
        /headline|field_1|Hero image|guidance|slot|"objects"|"left":/
      );
      expect(GUIDED.revisions).toHaveLength(3);
    }
  );

  ui(
    'TWG8 deleting a field’s layer leaves its field out of the draft and of the save; undo brings both back',
    async () => {
      await open();
      await click(button('Edit template'));
      await row(/Title/);
      await click(button('Delete layer'));
      expect(slotIds()).toEqual([]);
      await click(button('Undo', toolbar()));
      expect(slotIds()).toEqual(['headline']);
      await row(/Title/);
      await click(button('Delete layer'));
      await click(button('Save', toolbar()));
      expect(saved()[0].guidance).toBeNull();
    }
  );

  ui('TWG9/TWG10/M26 a duplicated or pasted layer gets no field', async () => {
    await open();
    await click(button('Edit template'));
    await row(/Title/);
    await click(screen.getAllByRole('button', { name: 'Duplicate layer' })[0]);
    expect(slotIds()).toEqual(['headline']);
    expect(button('Use as template text field', panel())).toBeTruthy();
    await row(/Title/);
    await click(button('Copy layer'));
    await click(button('Paste layer'));
    expect(slotIds()).toEqual(['headline']);
    expect(button('Use as template text field', panel())).toBeTruthy();
    await click(button('Save', toolbar()));
    expect(
      saved()[0].guidance.slots.map((slot: Plain) => slot.layerId)
    ).toEqual(['title']);
  });

  ui(
    'TWG9b a duplicated page gets no fields; deleting a page drops its fields',
    async () => {
      await open();
      await click(button('Edit template'));
      await click(button('Duplicate page'));
      expect(
        document.querySelectorAll('[aria-label^="Select page"]')
      ).toHaveLength(2);
      expect(slotIds()).toEqual(['headline']);
      await click(button(/^Select page 1/));
      await click(button('Delete page'));
      expect(
        document.querySelectorAll('[aria-label^="Select page"]')
      ).toHaveLength(1);
      expect(slotIds()).toEqual([]);
      await click(button('Save', toolbar()));
      const [body] = saved();
      expect(body.guidance).toBeNull();
      expect(body.content.pages).toHaveLength(1);
    }
  );

  ui(
    'a field change alone is unsaved work: Save is offered and leaving asks first; order and removal are explicit',
    async () => {
      GUIDED.revisions[1].guidance = guidanceOf([
        { ...HEADLINE, required: false },
        { ...PHOTO },
      ]);
      await open();
      await click(button('Edit template'));
      expect((button('Save', toolbar()) as HTMLButtonElement).disabled).toBe(
        true
      );
      await click(button('Move field down: Headline', panel()));
      expect(slotIds()).toEqual(['photo', 'headline']);
      expect((button('Save', toolbar()) as HTMLButtonElement).disabled).toBe(
        false
      );
      await click(button('Move field up: Headline', panel()));
      // back to the saved fields: nothing to save again
      expect((button('Save', toolbar()) as HTMLButtonElement).disabled).toBe(
        true
      );
      await click(button('Remove field: Photo', panel()));
      expect(slotIds()).toEqual(['headline']);
      await click(button('Remove field: Headline', panel()));
      mockConfirm.mockResolvedValueOnce(false);
      await click(button('Cancel', toolbar()));
      expect(mockConfirm).toHaveBeenCalledTimes(1);
      expect(slotIds()).toEqual([]);
    }
  );

  ui(
    'TWG12 a conflict keeps the document draft and the field draft; nothing is retried',
    async () => {
      await open();
      await click(button('Edit template'));
      await row(/photo/);
      await click(button('Use as template image field', panel()));
      GUIDED.revisions.push(revision(3, doc([rect('other')])));
      await click(button('Save', toolbar()));
      expect(
        screen.getByText('This design changed while you were editing.')
      ).toBeTruthy();
      expect(slotIds()).toEqual(['headline', 'field_1']);
      expect(saved()).toHaveLength(1);
      expect((button('Save', toolbar()) as HTMLButtonElement).disabled).toBe(
        true
      );
    }
  );

  ui('an invalid field label is refused before anything is sent', async () => {
    await open();
    await click(button('Edit template'));
    await row(/Title/);
    fireEvent.change(within(panel()).getByLabelText('Field label'), {
      target: { value: '   ' },
    });
    await flush();
    expect(within(panel()).getByText('A field needs a label.')).toBeTruthy();
    await click(button('Save', toolbar()));
    expect(saved()).toEqual([]);
    expect(mockToast).toHaveBeenCalledWith(
      'The template fields are invalid.',
      'warning'
    );
  });

  ui('TWG6/M27 an older revision shows its own fields, read-only', async () => {
    await open();
    await click(button('View Revision 1'));
    expect(slotIds()).toEqual([]);
    expect(within(panel()).getByText(/^0 fields/)).toBeTruthy();
    expect(within(panel()).queryAllByRole('button')).toEqual([]);
    expect(within(panel()).queryAllByRole('checkbox')).toEqual([]);
    await click(button('Use this revision'));
    await submit(dialog('Use template'));
    expect(writes()[0].body).not.toHaveProperty('values');
  });

  ui('TWG7/M28 an archived template’s fields are read-only', async () => {
    GUIDED.archivedAt = T0;
    await open();
    expect(slotIds()).toEqual(['headline']);
    expect(within(panel()).queryAllByRole('button')).toEqual([]);
    expect(within(panel()).queryAllByRole('checkbox')).toEqual([]);
    expect(queryButton('Edit template')).toBeNull();
  });

  ui(
    'TWG5/P412-3/P412-15 a design has no fields panel and still saves exactly its document',
    async () => {
      await show(h(ContentStudioDesignWorkspace, { designId: designs[0].id }));
      expect(
        screen.queryByRole('region', { name: 'Template fields' })
      ).toBeNull();
      await click(button('Edit design'));
      await click(button('Add rectangle'));
      expect(
        screen.queryByRole('region', { name: 'Template fields' })
      ).toBeNull();
      overrideDesignSave();
      await click(button('Save', toolbar()));
      const post = writes().find((c) =>
        c.url.startsWith(`/content-studio/designs/${designs[0].id}/revisions`)
      );
      expect(Object.keys(post?.body ?? {}).sort()).toEqual([
        'baseRevisionNumber',
        'content',
      ]);
    }
  );
});

// the mock server takes design saves only when a test asks for them
const overrideDesignSave = () => {
  override = (method, url, body) => {
    const match = url.match(/^\/content-studio\/designs\/([^/]+)\/revisions$/);
    if (method !== 'POST' || !match) {
      return undefined;
    }
    const d = designs.find((x) => x.id === match[1]);
    if (!d) {
      return undefined;
    }
    const r = revision(d.revisions.length + 1, body.content);
    d.revisions.push(r);
    return reply(201, {
      created: true,
      revision: { ...meta(r), content: r.content },
    });
  };
};

describe('P4-12 template thumbnails with exact Brand Kit revisions', () => {
  const brandCalls = () =>
    calls().filter((c) => c.url.startsWith('/content-studio/brand-kit'));
  const brandedTemplate = (name: string, revisionId: string): Template => ({
    id: nextId(),
    name,
    description: null,
    archivedAt: null,
    revisions: [revision(1, branded(revisionId, [brandRect('band')]))],
  });
  const thumbnail = (name: RegExp) =>
    card(name).querySelector('[data-preview="thumbnail"]') as HTMLElement;

  ui(
    'TB1/TB5/TB8/TB9/TB10 literal and built-in cards make no Brand, render or Media request and draw no canvas',
    async () => {
      await show(h(ContentStudioDesignTemplates));
      expect(brandCalls()).toEqual([]);
      expect(calls().map((c) => c.url)).toEqual([
        '/content-studio/design-templates?page=1&archived=false',
      ]);
      expect(document.querySelectorAll('canvas, img')).toHaveLength(0);
    }
  );

  ui(
    'TB2/TB3/M21 eight cards on one exact revision load it once, and its tokens are drawn',
    async () => {
      templates = Array.from({ length: 8 }, (_, i) =>
        brandedTemplate(`Branded ${i + 1}`, REV_A)
      );
      await show(h(ContentStudioDesignTemplates));
      // the list and one exact revision: nothing else, no Media or render
      expect(calls().map((c) => `${c.method} ${c.url}`)).toEqual([
        'GET /content-studio/design-templates?page=1&archived=false',
        `GET /content-studio/brand-kit/revisions/${REV_A}`,
      ]);
      for (let i = 1; i <= 8; i++) {
        const shape = thumbnail(new RegExp(`^Branded ${i}$`)).querySelector(
          '[style*="background-color: rgb(0, 87, 255)"]'
        );
        expect(shape).toBeTruthy();
      }
      expect(document.querySelectorAll('[data-unresolved]')).toHaveLength(0);
    }
  );

  ui('TB4 two distinct revisions are two requests', async () => {
    templates = [
      brandedTemplate('One', REV_A),
      brandedTemplate('Two', REV_B),
      brandedTemplate('Three', REV_A),
    ];
    await show(h(ContentStudioDesignTemplates));
    expect(
      brandCalls()
        .map((c) => c.url)
        .sort()
    ).toEqual(
      [
        `/content-studio/brand-kit/revisions/${REV_A}`,
        `/content-studio/brand-kit/revisions/${REV_B}`,
      ].sort()
    );
    expect(
      thumbnail(/^Two$/).querySelector(
        '[style*="background-color: rgb(255, 87, 0)"]'
      )
    ).toBeTruthy();
  });

  ui(
    'TB6/TB7/M22 a revision that fails, or is not exactly the referenced one, leaves its cards unresolved; no latest fallback',
    async () => {
      templates = [
        brandedTemplate('Works', REV_A),
        brandedTemplate('Broken', REV_B),
      ];
      override = (method, url) =>
        url === `/content-studio/brand-kit/revisions/${REV_B}`
          ? reply(500, { msg: SECRET, code: 'CS_BRAND_KIT_INTEGRITY_ERROR' })
          : undefined;
      await show(h(ContentStudioDesignTemplates));
      expect(card(/^Broken$/).textContent).toContain(
        'Brand Kit revision unavailable'
      );
      expect(
        thumbnail(/^Broken$/).querySelector('[data-unresolved]')
      ).toBeTruthy();
      expect(
        thumbnail(/^Works$/).querySelector('[data-unresolved]')
      ).toBeNull();
      // a card naming another hash for a known revision is not resolved by it
      templates = [
        brandedTemplate('Works', REV_A),
        {
          ...brandedTemplate('Moved', REV_A),
          revisions: [
            revision(1, {
              ...branded(REV_A, [brandRect('band')]),
              brandKit: { ...brandRef(REV_A), contentHash: SHA('9') },
            }),
          ],
        },
      ];
      cleanup();
      mockFetch.mockClear();
      override = () => undefined;
      await show(h(ContentStudioDesignTemplates));
      expect(
        thumbnail(/^Moved$/).querySelector('[data-unresolved]')
      ).toBeTruthy();
      expect(card(/^Moved$/).textContent).toContain(
        'Brand Kit revision unavailable'
      );
      expect(calls().map((c) => c.url)).not.toContain(
        '/content-studio/brand-kit'
      );
      expect(
        calls().filter((c) => /brand-kit\/revisions\?/.test(c.url))
      ).toEqual([]);
    }
  );
});

// ============================================================================
describe('Template frontend boundaries', () => {
  const dir = __dirname;
  const FILES = [
    'content-studio.design-templates.api.ts',
    'content-studio.design-templates.tsx',
    'content-studio.design-template.workspace.tsx',
  ];
  const code = (file: string) =>
    readFileSync(join(dir, file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');

  it('P411-1/P411-2/P411-3 no Fabric serialization, system clipboard, browser storage or AI', () => {
    for (const file of FILES) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /from 'fabric'|toJSON|toObject|loadFromJSON|navigator\.clipboard|localStorage|sessionStorage|indexedDB|console\.|\/ai\/|generate/
        ),
      ]);
    }
  });

  it('TL7/TL8/M23/M24 the library renders nothing, reads no Media and creates no canvas', () => {
    for (const file of FILES) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /render-all|\/render|useContentStudioRenderedMedia|\/media|ContentStudioDesignCanvas|<canvas|<img/
        ),
      ]);
    }
  });

  it('UT2/ST3/P411-9 using a template and saving a design as one send identities only', () => {
    const api = code('content-studio.design-templates.api.ts');
    const instantiate = api.slice(
      api.indexOf('instantiateTemplate: async'),
      api.indexOf('saveDesignAsTemplate: async')
    );
    expect(instantiate).not.toMatch(/content/);
    const save = api.slice(
      api.indexOf('saveDesignAsTemplate: async'),
      api.indexOf('}),\n    [fetch, refresh]')
    );
    expect(save).toContain('/save-as-template');
    expect(save).toMatch(
      /body: JSON\.stringify\(\{\s*name: details\.name,\s*description: details\.description,\s*\}\)/
    );
    expect(save).not.toMatch(/content/);
  });

  it('P412-3/P412-15/M25 the design editor and the design save know nothing of template guidance', () => {
    for (const file of [
      'content-studio.design.editing.tsx',
      'content-studio.design.workspace.tsx',
      'content-studio.designs.api.ts',
      'content-studio.design.editor.ts',
      'content-studio.design.canvas.tsx',
      'content-studio.design.fabric.ts',
    ]) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /template\.guidance|TemplateGuidance|slots|guidanceTo/
        ),
      ]);
    }
    const api = code('content-studio.designs.api.ts');
    expect(api).toContain(
      'body: JSON.stringify({ baseRevisionNumber, content })'
    );
  });

  it('P412-6/P412-7/P412-8 guided use sends field values only: no clipboard, browser storage, URL or path', () => {
    const api = code('content-studio.design-templates.api.ts');
    const instantiate = api.slice(
      api.indexOf('instantiateTemplate: async'),
      api.indexOf('saveDesignAsTemplate: async')
    );
    expect(instantiate).toContain('values: customization.values');
    expect(instantiate).not.toMatch(
      /\bcontent\b|\burl\b|\bpath\b|thumbnail|\bdocument\b/i
    );
    const form = code('content-studio.design-templates.tsx');
    const values = form.slice(
      form.indexOf('const values: Record'),
      form.indexOf("await run('use'")
    );
    expect(values).toMatch(
      /mediaId: images\[slot\.id\]\.mediaId,\s*sha256: images\[slot\.id\]\.sha256/
    );
    expect(values).not.toMatch(/path|url|thumbnail/i);
  });

  it('TB7/P412-9 thumbnails load exact Brand Kit revisions by id only, never the kit or its list', () => {
    const api = code('content-studio.design-templates.api.ts');
    const brands = api.slice(
      api.indexOf('export const useContentStudioDesignTemplateBrands'),
      api.indexOf('// Template writes')
    );
    expect(brands).toContain('brandKitRevisionPath(ref.revisionId)');
    expect(brands).not.toMatch(
      /useContentStudioBrandKit\b|BRAND_KIT_PATH|latest|current/i
    );
  });

  it('the template routes are thin', () => {
    const routes = join(dir, '../../app/(app)/(site)/content-studio/templates');
    expect(
      code(
        join('..', '..', 'app/(app)/(site)/content-studio/templates/page.tsx')
      )
    ).toContain('return <ContentStudioDesignTemplates />;');
    expect(readFileSync(join(routes, '[id]/page.tsx'), 'utf8')).toContain(
      'return <ContentStudioDesignTemplateWorkspace key={id} templateId={id} />;'
    );
  });
});
