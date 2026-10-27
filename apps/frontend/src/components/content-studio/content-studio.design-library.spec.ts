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

// Creative Studio library and design blocks (P4-18): the Creative Library
// categories (lazy, searchable, by source), saving the chosen layers as a
// block, inserting a block (Media checked, exact Brand Kit, one undo step),
// managing blocks, the template workspace, and the pure insert operation.
// A .spec.ts without JSX, like the other Content Studio frontend specs:
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

const {
  ContentStudioDesignEditorError,
  insertContentStudioDesignBlock,
} = require('./content-studio.design.editor');
const {
  parseContentStudioDesignDocument,
} = require('@gitroom/nestjs-libraries/content-studio/design/design.document');
const {
  parseContentStudioBrandKitContent,
} = require('@gitroom/nestjs-libraries/content-studio/brand/brand.kit');

type Plain = Record<string, any>;
type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const SECRET = 'DESIGN_BLOCK_SERVER_SECRET_123';
const T0 = '2026-10-19T10:00:00.000Z';
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const lit = (value: string) => ({ type: 'literal', value });
const tok = (tokenId: string) => ({ type: 'brand', tokenId });
const solid = (color: Plain) => ({ type: 'solid', color });
const KIT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const REV = 'aaaaaaaa-0000-4000-8000-000000000001';
const BRAND_CONTENT = {
  schemaVersion: 1,
  identity: { brandName: 'Northwind', tagline: '', description: '' },
  colors: [
    { id: 'primary', name: 'Primary', value: '#0057ff', role: 'primary' },
  ],
  typography: [],
  visualDirection: { keywords: [], dos: [], donts: [] },
};
const BRAND = {
  id: REV,
  revisionNumber: 3,
  schemaVersion: 1,
  contentHash: SHA('b'),
  createdAt: T0,
  content: BRAND_CONTENT,
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
  text: '  Buy now\n',
  font: { type: 'family', family: 'Inter', weight: 700, style: 'normal' },
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
  cornerRadius: 12,
};
const PHOTO = {
  ...base,
  rotation: 0,
  id: 'photo',
  name: 'Photo',
  type: 'image',
  imageRef: { type: 'media', mediaId: 'media-1', sha256: SHA('a') },
  fit: 'contain',
  focalPoint: { x: 0.2, y: 0.8 },
  mask: { type: 'ellipse' },
};
const pageOf = (id: string, layers: Plain[]) => ({
  id,
  name: 'One',
  width: 1080,
  height: 1080,
  background: solid(lit('#ffffff')),
  layers: layers.map((l) => JSON.parse(JSON.stringify(l))),
});
const doc = (brandKit: Plain | null = null, more: Plain[] = []) => ({
  schemaVersion: 1,
  brandKit,
  pages: [pageOf('p_one', [TITLE, BOX, PHOTO, ...more])],
});
const snap = (layers: Plain[], width = 400, height = 200) => ({
  schemaVersion: 1,
  width,
  height,
  layers,
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
const CTA = snap([
  {
    ...box(0, 0, 400, 200),
    name: 'Button',
    type: 'shape',
    shape: 'rectangle',
    fill: lit('#0057ff'),
    cornerRadius: 40,
  },
  {
    ...box(20, 60, 360, 80),
    name: 'Label',
    type: 'text',
    text: 'Shop now',
    font: { type: 'family', family: 'Inter', weight: 700, style: 'normal' },
    fontSize: 48,
    lineHeight: 1.2,
    letterSpacing: 0,
    color: lit('#ffffff'),
    align: 'center',
    verticalAlign: 'middle',
    overflow: 'shrink',
  },
]);
const BRANDED = snap([
  {
    ...box(0, 0, 200, 100),
    name: 'Brand strip',
    type: 'shape',
    shape: 'rectangle',
    fill: tok('primary'),
    cornerRadius: 0,
  },
]);
const LOGO = snap(
  [
    {
      ...box(0, 0, 100, 100),
      name: 'Logo',
      type: 'image',
      imageRef: { type: 'media', mediaId: 'media-1', sha256: SHA('a') },
      fit: 'contain',
      focalPoint: { x: 0.5, y: 0.5 },
      mask: { type: 'roundedRectangle', cornerRadius: 16 },
    },
  ],
  100,
  100
);
const SYSTEM_LAYOUT = {
  source: 'system',
  id: 'system:layout-title-card',
  name: 'Title card',
  description: 'A card with a heading.',
  archivedAt: null,
  contentHash: SHA('1'),
  content: CTA,
};
const TEMPLATE_DOC = {
  schemaVersion: 1,
  brandKit: null,
  pages: [
    {
      id: 'p_t',
      name: '',
      width: 1080,
      height: 1350,
      background: solid(lit('#eeeeee')),
      layers: [],
    },
  ],
};

let counter = 0;
const nextId = () =>
  `${String(++counter).padStart(8, '0')}-0000-4000-8000-000000000000`;
type Entry = {
  id: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  content: any;
};
let blocks: Entry[];
let mediaSha: string;
let design: { id: string; revisions: any[] };
let template: { id: string; revisions: any[] };
let override: (method: string, url: string, body: any) => Reply | undefined;
const orgEntry = (p: Entry) => ({
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
  const archived = searchParams.get('archived') === 'true';
  const B = '/content-studio/design-blocks';
  if (pathname === B && method === 'GET') {
    return reply(200, {
      system: [],
      pages: 1,
      results: blocks.filter((p) => !!p.archivedAt === archived).map(orgEntry),
    });
  }
  if (pathname === B && method === 'POST') {
    const p: Entry = {
      id: nextId(),
      name: body.name,
      description: body.description || null,
      archivedAt: null,
      content: body.content,
    };
    blocks.push(p);
    return reply(201, orgEntry(p));
  }
  const bm = pathname.match(
    /^\/content-studio\/design-blocks\/([^/]+)(?:\/(archive|restore))?$/
  );
  if (bm) {
    const p = blocks.find((x) => x.id === bm[1]);
    if (!p) return reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
    if (method === 'PATCH') Object.assign(p, body);
    if (bm[2] === 'archive') p.archivedAt = T0;
    if (bm[2] === 'restore') p.archivedAt = null;
    return reply(200, orgEntry(p));
  }
  if (pathname === '/content-studio/design-layout-patterns') {
    return reply(200, {
      system: archived ? [] : [SYSTEM_LAYOUT],
      pages: 1,
      results: [],
    });
  }
  if (pathname === '/content-studio/design-page-sets') {
    return reply(200, {
      system: archived
        ? []
        : [
            {
              source: 'system',
              id: 'system:page-set-social-core',
              name: 'Social core',
              description: 'Square, portrait and story pages.',
              pageCount: 1,
              archivedAt: null,
              contentHash: SHA('2'),
              content: {
                schemaVersion: 1,
                pages: [{ name: 'Square', width: 1080, height: 1080 }],
              },
            },
          ],
      pages: 1,
      results: [],
    });
  }
  if (pathname === '/content-studio/design-templates' && method === 'GET') {
    return reply(200, {
      system: [
        {
          source: 'system',
          id: 'system:story',
          name: 'Story promo',
          description: 'A tall promo.',
          latestRevisionNumber: 1,
          archivedAt: null,
          currentRevision: {
            revisionNumber: 1,
            schemaVersion: 1,
            contentHash: SHA('3'),
            content: TEMPLATE_DOC,
            guidanceHash: null,
            guidance: null,
          },
        },
      ],
      pages: 1,
      // an archived template the server returns by mistake is still left out
      results: [
        {
          source: 'organization',
          id: nextId(),
          name: 'Old template',
          description: null,
          latestRevisionNumber: 1,
          archivedAt: T0,
          createdAt: T0,
          updatedAt: T0,
          currentRevision: {
            id: nextId(),
            revisionNumber: 1,
            schemaVersion: 1,
            contentHash: SHA('4'),
            content: TEMPLATE_DOC,
            guidanceHash: null,
            guidance: null,
          },
        },
      ],
    });
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
  mediaSha = SHA('a');
  blocks = [
    {
      id: nextId(),
      name: 'Shop CTA',
      description: 'Blue button',
      archivedAt: null,
      content: CTA,
    },
    {
      id: nextId(),
      name: 'Brand strip',
      description: null,
      archivedAt: null,
      content: BRANDED,
    },
    {
      id: nextId(),
      name: 'Logo mark',
      description: 'Our logo',
      archivedAt: null,
      content: LOGO,
    },
    {
      id: nextId(),
      name: 'Old block',
      description: null,
      archivedAt: T0,
      content: CTA,
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
const library = () =>
  screen.getByRole('region', { name: 'Creative library' }) as HTMLElement;
const category = async (name: string) =>
  click(
    within(
      within(library()).getByRole('group', { name: 'Library category' })
    ).getByRole('button', { name })
  );
const blocksPanel = () =>
  screen.getByRole('region', { name: 'Blocks' }) as HTMLElement;
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
const browseBlocks = async () => click(button('Browse blocks', blocksPanel()));
const saveDraft = async () => {
  await click(button('Save', toolbar()));
  return writes()
    .filter((c) => /\/revisions$/.test(c.url))
    .pop()?.body;
};
const listed = (part: string) =>
  calls()
    .filter((c) => c.url.includes(part))
    .map((c) => c.url);
const warned = (text: string) =>
  expect(mockToast).toHaveBeenCalledWith(text, 'warning');
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
describe('Inserting a block (pure)', () => {
  const brand = parseContentStudioBrandKitContent(BRAND_CONTENT);
  const base = (brandKit: Plain | null = null, more: Plain[] = []) =>
    parseContentStudioDesignDocument(doc(brandKit, more));

  it('DBI1/DBI2/DBI3/DBI4/DBI5/DBI9/DBI10 fresh ids, centered, geometry and order kept, in front as one section; the block and the design unchanged', () => {
    const document = base();
    const frozen = JSON.stringify(document);
    const content = JSON.parse(JSON.stringify(CTA));
    const recipe = JSON.stringify(content);
    const { document: next, layerIds } = insertContentStudioDesignBlock(
      document,
      'p_one',
      content,
      null
    );
    const layers = next.pages[0].layers;
    expect(layers.slice(0, 3).map((l: Plain) => l.id)).toEqual([
      'title',
      'box',
      'photo',
    ]);
    expect(layers.slice(3).map((l: Plain) => l.id)).toEqual(layerIds);
    expect(
      layers.slice(3).map((l: Plain) => [l.name, l.x, l.y, l.width, l.height])
    ).toEqual([
      ['Button', 340, 440, 400, 200],
      ['Label', 360, 500, 360, 80],
    ]);
    for (const id of layerIds) {
      expect(id).toMatch(/^l_[0-9a-f]{20}$/);
    }
    expect(JSON.stringify(document)).toBe(frozen);
    expect(JSON.stringify(content)).toBe(recipe);
    expect(parseContentStudioDesignDocument(next)).toEqual(next);
    expect(JSON.stringify(next)).not.toMatch(/blockId|designBlock|Shop CTA/);
  });

  it('DBI11/DBI12 image references and Brand tokens stay exactly as they were', () => {
    const logo = insertContentStudioDesignBlock(base(), 'p_one', LOGO, null);
    expect(logo.document.pages[0].layers[3]).toMatchObject({
      imageRef: { type: 'media', mediaId: 'media-1', sha256: SHA('a') },
      fit: 'contain',
      mask: { type: 'roundedRectangle', cornerRadius: 16 },
    });
    const branded = insertContentStudioDesignBlock(
      base(BRAND_REF),
      'p_one',
      BRANDED,
      brand
    );
    expect(branded.document.pages[0].layers[3].fill).toEqual(tok('primary'));
  });

  it('DBB1/DBB3/DBB4/DBB6 literal blocks need no Brand Kit; a token block needs the exact revision to have it, never a literal fallback', () => {
    expect(() =>
      insertContentStudioDesignBlock(base(), 'p_one', CTA, null)
    ).not.toThrow();
    refused(
      () => insertContentStudioDesignBlock(base(), 'p_one', BRANDED, brand),
      'BLOCK_BRAND_UNAVAILABLE'
    );
    refused(
      () =>
        insertContentStudioDesignBlock(base(BRAND_REF), 'p_one', BRANDED, {
          ...brand,
          colors: [],
        }),
      'BLOCK_BRAND_UNAVAILABLE'
    );
    refused(
      () =>
        insertContentStudioDesignBlock(base(BRAND_REF), 'p_one', BRANDED, null),
      'BLOCK_BRAND_UNAVAILABLE'
    );
  });

  it('DBL1/DBL2/DBL3 layer limits and coordinates refuse it all', () => {
    const fill = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...BOX, id: `f${i}` }));
    const full = base(null, fill(196));
    const frozen = JSON.stringify(full);
    refused(
      () => insertContentStudioDesignBlock(full, 'p_one', CTA, null),
      'LAYER_LIMIT'
    );
    expect(JSON.stringify(full)).toBe(frozen);
    // 3 + 996 = 999 layers: two more would be 1001
    const pages = Array.from({ length: 5 }, (_, p) =>
      pageOf(
        `p_more${p}`,
        Array.from({ length: p === 4 ? 196 : 200 }, (_, i) => ({
          ...BOX,
          id: `m${p}_${i}`,
        }))
      )
    );
    const heavy = parseContentStudioDesignDocument({
      ...doc(),
      pages: [...doc().pages, ...pages],
    });
    refused(
      () => insertContentStudioDesignBlock(heavy, 'p_one', CTA, null),
      'LAYER_LIMIT'
    );
    // centered on 1080: 32 500 + 539.5 is past the coordinate limit
    const far = snap([{ ...CTA.layers[0], x: 32_500 }], 1, 100);
    refused(
      () => insertContentStudioDesignBlock(base(), 'p_one', far, null),
      'OUT_OF_LIMITS'
    );
  });

  it('a result over the design’s text limit refuses it all', () => {
    const long = { ...TITLE, text: 'x'.repeat(10_000) };
    const heavy = parseContentStudioDesignDocument({
      ...doc(),
      pages: [
        pageOf(
          'p_one',
          Array.from({ length: 20 }, (_, i) => ({ ...long, id: `t${i}` }))
        ),
      ],
    });
    const textBlock = snap([{ ...CTA.layers[1], text: 'one more' }]);
    refused(
      () => insertContentStudioDesignBlock(heavy, 'p_one', textBlock, null),
      'BLOCK_OUT_OF_LIMITS'
    );
  });
});

// ============================================================================
describe('Creative library', () => {
  ui(
    'LIB1/LIB2/LIB3 only while editing; categories in text; only the active one loads',
    async () => {
      await show(h(ContentStudioDesignWorkspace, { designId: design.id }));
      expect(
        screen.queryByRole('region', { name: 'Creative library' })
      ).toBeNull();
      await click(button('Edit design'));
      const group = within(library()).getByRole('group', {
        name: 'Library category',
      });
      expect(
        within(group)
          .getAllByRole('button')
          .map((b) => [b.textContent, b.getAttribute('aria-pressed')])
      ).toEqual([
        ['Blocks', 'true'],
        ['Layouts', 'false'],
        ['Templates', 'false'],
        ['Page sets', 'false'],
        ['Media', 'false'],
      ]);
      expect(listed('design-blocks')).toEqual([]);
      expect(listed('design-layout-patterns')).toEqual([]);
      expect(listed('design-templates')).toEqual([]);
      expect(listed('design-page-sets')).toEqual([]);
      expect(listed('/media')).toEqual([]);
      await browseBlocks();
      expect(listed('design-blocks')).toEqual([
        '/content-studio/design-blocks?page=1&archived=false',
      ]);
      await category('Templates');
      expect(listed('design-templates')).toEqual([
        '/content-studio/design-templates?page=1&archived=false',
      ]);
      expect(listed('design-layout-patterns')).toEqual([]);
      expect(listed('design-page-sets')).toEqual([]);
    }
  );

  ui(
    'LIB4/LIB5/LIB7/LIB8 switching and searching change nothing in the design; search looks at names and descriptions; archived blocks never show',
    async () => {
      // the server returns an archived block by mistake: it is still left out
      override = (method, url) =>
        method === 'GET' && url.includes('design-blocks?page=1&archived=false')
          ? reply(200, { system: [], pages: 1, results: blocks.map(orgEntry) })
          : undefined;
      await openDesign();
      await browseBlocks();
      // each listed block by its Insert action's name
      const names = () =>
        within(blocksPanel())
          .queryAllByRole('button', { name: /^Insert / })
          .map((b) =>
            (b.getAttribute('aria-label') ?? '').replace('Insert ', '')
          );
      expect(names()).toEqual(['Shop CTA', 'Brand strip', 'Logo mark']);
      expect(blocksPanel().textContent).toContain('Organization · 2 layers');
      expect(blocksPanel().textContent).not.toContain('Old block');
      await type(within(library()).getByLabelText('Search'), 'blue');
      expect(names()).toEqual(['Shop CTA']);
      await type(within(library()).getByLabelText('Search'), 'LOGO');
      expect(names()).toEqual(['Logo mark']);
      await category('Layouts');
      await category('Page sets');
      await category('Media');
      expect(within(library()).queryByLabelText('Search')).toBeNull();
      await category('Blocks');
      expect(button('Undo', toolbar()).disabled).toBe(true);
      expect(button('Save', toolbar()).disabled).toBe(true);
      expect(writes()).toEqual([]);
    }
  );

  ui('LIB6 the source filter applies where there are built-ins', async () => {
    await openDesign();
    await category('Templates');
    const templates = () =>
      within(library()).getByRole('list', { name: 'Templates' });
    expect(templates().textContent).toContain('Story promo');
    expect(library().textContent).not.toContain('Old template');
    expect(templates().textContent).toContain(
      'Built-in · 1 pages · 1080 × 1350'
    );
    expect(within(library()).getByLabelText('Source')).toBeTruthy();
    fireEvent.change(within(library()).getByLabelText('Source'), {
      target: { value: 'organization' },
    });
    await flush();
    expect(
      within(library()).queryByRole('list', { name: 'Templates' })
    ).toBeNull();
    expect(library().textContent).toContain('Nothing matches.');
    await category('Blocks');
    expect(within(library()).queryByLabelText('Source')).toBeNull();
  });

  ui(
    'LIB9/LIB10/LIB11/LIB12 previews are DOM drawings: no render, no canvas per card, no Media request for a preview',
    async () => {
      await openDesign();
      await browseBlocks();
      expect(
        blocksPanel().querySelectorAll('[data-preview="thumbnail"]')
      ).toHaveLength(3);
      expect(blocksPanel().querySelectorAll('canvas, img, [src]')).toHaveLength(
        0
      );
      await category('Layouts');
      await click(button('Browse layouts'));
      await category('Templates');
      expect(
        library().querySelectorAll('[data-preview="thumbnail"]')
      ).toHaveLength(1);
      expect(library().querySelectorAll('canvas, img, [src]')).toHaveLength(0);
      expect(
        calls().filter((c) => /render|design-ref|\/media/.test(c.url))
      ).toEqual([]);
    }
  );

  ui(
    'templates are used to start a new design, never inserted into this page',
    async () => {
      await openDesign();
      await category('Templates');
      await click(button('Use template Story promo', library()));
      expect(dialog('Use template')).toBeTruthy();
      expect(writes()).toEqual([]);
      expect(button('Undo', toolbar()).disabled).toBe(true);
    }
  );

  ui(
    'Media adds an image through the existing picker, loaded only when it opens',
    async () => {
      await openDesign();
      await category('Media');
      expect(listed('/media')).toEqual([]);
      await click(button('Add image from Media', library()));
      expect(dialog('Add image')).toBeTruthy();
    }
  );
});

// ============================================================================
describe('Design blocks', () => {
  ui('DBF1/DBF2 Save as block needs chosen layers while editing', async () => {
    await show(h(ContentStudioDesignWorkspace, { designId: design.id }));
    expect(screen.queryByRole('button', { name: 'Save as block' })).toBeNull();
    await click(button('Edit design'));
    expect(button('Save as block', blocksPanel()).disabled).toBe(true);
    await row('Title');
    expect(button('Save as block', blocksPanel()).disabled).toBe(false);
  });

  ui(
    'DBF3/DBF4/DBF5 the request is the chosen layers only, measured from their box, with no ids; the block is listed',
    async () => {
      await openDesign();
      await row('Box');
      await row('Title', { ctrlKey: true });
      await row('Photo', { ctrlKey: true });
      await click(button('Save as block', blocksPanel()));
      const form = dialog('Save as block');
      expect(form.textContent).toContain('3 layers');
      await type(within(form).getByLabelText('Block name'), ' Promo ');
      await submit(form);
      const sent = writes().pop()!;
      expect(sent.url).toBe('/content-studio/design-blocks');
      expect(Object.keys(sent.body).sort()).toEqual([
        'content',
        'description',
        'name',
      ]);
      const { id: _t, ...title } = TITLE;
      const { id: _b, ...shape } = BOX;
      const { id: _p, ...photo } = PHOTO;
      expect(sent.body).toMatchObject({ name: 'Promo' });
      expect(sent.body.content).toEqual({
        schemaVersion: 1,
        width: 700,
        height: 600,
        layers: [
          { ...title, x: 0, y: 0 },
          { ...shape, x: 400, y: 500 },
          { ...photo, x: 0, y: 0 },
        ],
      });
      expect(JSON.stringify(sent.body)).not.toMatch(
        /p_one|"id"|pages|brandKit|guidance/
      );
      expect(mockToast).toHaveBeenCalledWith('Block saved.', 'success');
      expect(writes().filter((c) => /revisions/.test(c.url))).toEqual([]);
      await browseBlocks();
      expect(blocksPanel().textContent).toContain('Promo');
    }
  );

  ui(
    'DBF6/DBF7/DBI6/DBI7/DBI8 one insert is one undo step; all inserted layers are selected, the front one primary',
    async () => {
      await openDesign();
      await browseBlocks();
      const before = writes().length;
      await click(button('Insert Shop CTA', blocksPanel()));
      expect(writes()).toHaveLength(before);
      expect(screen.getByText(/2 layers selected/)).toBeTruthy();
      const selection = (kind: string) =>
        Array.from(
          document.querySelectorAll(
            `[data-layer-row][data-selection="${kind}"]`
          )
        ).map((el) => el.textContent);
      expect(selection('primary')).toEqual([expect.stringContaining('Label')]);
      expect(selection('secondary')).toEqual([
        expect.stringContaining('Button'),
      ]);
      await click(button('Undo', toolbar()));
      expect(screen.queryByText(/2 layers selected/)).toBeNull();
      expect(button('Undo', toolbar()).disabled).toBe(true);
      await click(button('Insert Shop CTA', blocksPanel()));
      const body = await saveDraft();
      expect(body.content.pages[0].layers).toHaveLength(5);
      expect(JSON.stringify(body)).not.toMatch(/Shop CTA|designBlock|blockId/);
    }
  );

  ui(
    'DBM1/DBM3 images are checked against the organization’s Media first; other bytes insert nothing',
    async () => {
      await openDesign();
      await browseBlocks();
      await click(button('Insert Logo mark', blocksPanel()));
      expect(listed('design-ref')).toEqual([
        '/content-studio/media/media-1/design-ref',
      ]);
      expect(screen.getByText(/Layer · Logo/)).toBeTruthy();
      mediaSha = SHA('z');
      await click(button('Undo', toolbar()));
      await click(button('Insert Logo mark', blocksPanel()));
      warned(
        'An image in this block is no longer available in your media library. Nothing was inserted.'
      );
      expect(button('Undo', toolbar()).disabled).toBe(true);
    }
  );

  ui(
    'DBSEC8/DBB2/DBL4/DBL5 an incompatible Brand Kit refuses the insert: a fixed message, no undo step, the selection unchanged',
    async () => {
      await openDesign();
      await row('Title');
      await browseBlocks();
      await click(button('Insert Brand strip', blocksPanel()));
      warned(
        'This block uses Brand Kit colors or typography that this design’s Brand Kit revision does not have. Nothing was inserted.'
      );
      expect(button('Undo', toolbar()).disabled).toBe(true);
      expect(screen.getByText(/Layer · Title/)).toBeTruthy();
      cleanup();
      await openDesign(BRAND_REF);
      await browseBlocks();
      await click(button('Insert Brand strip', blocksPanel()));
      const body = await saveDraft();
      expect(body.content.pages[0].layers[3].fill).toEqual(tok('primary'));
      expect(body.content.brandKit).toEqual(BRAND_REF);
    }
  );

  ui(
    'DBF8/DBF9/DBF10/DBF11 edit details, archive and restore are the organization’s own; archived blocks leave the list until restored',
    async () => {
      await openDesign();
      await browseBlocks();
      await click(button('Edit details Shop CTA', blocksPanel()));
      const form = dialog('Edit details');
      await type(within(form).getByLabelText('Block name'), 'Shop button');
      await submit(form);
      expect(writes().pop()).toEqual({
        method: 'PATCH',
        url: `/content-studio/design-blocks/${blocks[0].id}`,
        body: { name: 'Shop button', description: 'Blue button' },
      });
      await click(button('Archive Logo mark', blocksPanel()));
      expect(writes().pop()).toEqual({
        method: 'POST',
        url: `/content-studio/design-blocks/${blocks[2].id}/archive`,
        body: undefined,
      });
      expect(blocksPanel().textContent).not.toContain('Logo mark');
      await click(button('Archived blocks', blocksPanel()));
      const archived = dialog('Archived blocks');
      expect(archived.textContent).toContain('Old block');
      expect(
        within(archived).queryByRole('button', { name: /^Insert/ })
      ).toBeNull();
      await click(button('Restore Logo mark', archived));
      expect(writes().pop()).toEqual({
        method: 'POST',
        url: `/content-studio/design-blocks/${blocks[2].id}/restore`,
        body: undefined,
      });
      expect(blocksPanel().textContent).toContain('Logo mark');
      expect(writes().filter((c) => c.method === 'DELETE')).toEqual([]);
    }
  );
});

// ============================================================================
describe('Design blocks in the template workspace', () => {
  ui(
    'DBT1/DBT2/DBT3 a block from a template has no guidance; inserting makes no slot; the guidance stays exactly as it was',
    async () => {
      await show(
        h(ContentStudioDesignTemplateWorkspace, { templateId: template.id })
      );
      await click(button('Edit template'));
      await row('Title');
      await click(button('Save as block', blocksPanel()));
      const form = dialog('Save as block');
      await type(within(form).getByLabelText('Block name'), 'Headline');
      await submit(form);
      const sent = writes().pop()!;
      expect(JSON.stringify(sent.body)).not.toMatch(
        /guidance|slots|headline"|"id"/
      );
      await browseBlocks();
      await click(button('Insert Shop CTA', blocksPanel()));
      const body = await saveDraft();
      expect(Object.keys(body).sort()).toEqual([
        'baseRevisionNumber',
        'content',
        'guidance',
      ]);
      expect(body.guidance).toEqual(GUIDANCE);
      expect(body.content.pages[0].layers).toHaveLength(5);
    }
  );
});

// ============================================================================
describe('Creative library boundaries', () => {
  const dir = __dirname;
  const ROOT = join(dir, '../../../../..');
  const code = (file: string) =>
    readFileSync(join(ROOT, file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
  const CS = 'apps/frontend/src/components/content-studio';
  const FILES = [
    `${CS}/content-studio.design-library.tsx`,
    `${CS}/content-studio.design-blocks.tsx`,
    `${CS}/content-studio.design-blocks.api.ts`,
  ];

  it('P418-8/P418-9/P418-12/P418-13 no Fabric, server render, canvas, AI, storage or sharing', () => {
    for (const file of FILES) {
      expect([file, code(file)]).not.toEqual([
        file,
        expect.stringMatching(
          /from 'fabric'|toJSON|toObject|loadFromJSON|\/render|ContentStudioDesignCanvas|<canvas|<img|localStorage|sessionStorage|navigator\.clipboard|\/ai\/|generate|marketplace|public|share/
        ),
      ]);
    }
  });

  it('P418-10/P418-11 blocks name no URL and load no Brand Kit; Media only through the existing design reference', () => {
    const blocksCode = code(`${CS}/content-studio.design-blocks.tsx`);
    expect(blocksCode).toContain('getMediaDesignRef(mediaId)');
    expect(blocksCode).not.toMatch(
      /useContentStudioBrandKit|brand-kit|getBrandKit|latestRevision/
    );
    expect(code(`${CS}/content-studio.design-blocks.api.ts`)).not.toMatch(
      /brand-kit|BrandKit|latest|\/media/i
    );
    const insert = blocksCode.slice(blocksCode.indexOf('const insert = '));
    expect(insert.indexOf('getMediaDesignRef')).toBeLessThan(
      insert.indexOf('insertContentStudioDesignBlock(')
    );
  });

  it('the client uses the five block routes only and sends the snapshot only', () => {
    const api = code(`${CS}/content-studio.design-blocks.api.ts`);
    expect(api).not.toMatch(/DELETE|PUT|\/apply|\/instantiate/);
    expect(api.match(/method: '(POST|PATCH)'/g)).toEqual([
      "method: 'POST'",
      "method: 'PATCH'",
      "method: 'POST'",
      "method: 'POST'",
    ]);
    expect(api).toMatch(
      /content: \{\s*schemaVersion: input\.content\.schemaVersion,\s*width: input\.content\.width,\s*height: input\.content\.height,\s*layers: input\.content\.layers,\s*\}/
    );
  });

  it('LIB3/M23 the library mounts only the active category; it adds no route of its own', () => {
    const libraryCode = code(`${CS}/content-studio.design-library.tsx`);
    for (const id of ['blocks', 'layouts', 'templates', 'pageSets', 'media']) {
      expect(libraryCode).toContain(`{category === '${id}' && `);
    }
    expect(libraryCode).not.toMatch(
      /useSWR|request\(|fetch\(|['`]\/content-studio\//
    );
  });

  it('P418-1/P418-2 Design Document v1 and its save body are unchanged; the block insert keeps nothing of the block', () => {
    const document = code(
      'libraries/nestjs-libraries/src/content-studio/design/design.document.ts'
    );
    expect(document).toContain(
      'export const DESIGN_DOCUMENT_SCHEMA_VERSION = 1;'
    );
    expect(document).not.toMatch(/designBlock|blockId|componentId|symbolId/i);
    expect(code(`${CS}/content-studio.designs.api.ts`)).toContain(
      'body: JSON.stringify({ baseRevisionNumber, content })'
    );
    const editor = code(`${CS}/content-studio.design.editor.ts`);
    const insert = editor.slice(
      editor.indexOf('export const insertContentStudioDesignBlock'),
      editor.indexOf('export const contentStudioDesignDocumentColors')
    );
    expect(insert).toContain('insertContentStudioDesignLayoutPattern(');
    expect(insert).toContain(
      'parseContentStudioDesignDocument(inserted.document)'
    );
    expect(insert).not.toMatch(/blockId|block\.id|source|latest/);
  });

  it('P418-14 no new dependency; Fabric stays 6.9.1', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.dependencies.fabric).toBe('6.9.1');
  });
});
