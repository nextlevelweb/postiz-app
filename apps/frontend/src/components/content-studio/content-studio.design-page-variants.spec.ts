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

// Creative Studio size variants (P4-16): Duplicate as size and Create
// campaign variants from the editor toolbar, page sizes on the page cards,
// and the same in the template workspace (guidance never copied). A
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
const SECRET = 'PAGE_VARIANT_SERVER_SECRET_123';
const T0 = '2026-10-18T10:00:00.000Z';
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const lit = (value: string) => ({ type: 'literal', value });
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
const PHOTO = {
  ...base,
  x: 400,
  y: 500,
  id: 'photo',
  name: 'Photo',
  type: 'image',
  imageRef: { type: 'media', mediaId: 'media-1', sha256: SHA('a') },
  fit: 'cover',
  focalPoint: { x: 0.3, y: 0.6 },
  mask: { type: 'roundedRectangle', cornerRadius: 20 },
};
const pageOf = (id: string, name: string, size: number[], layers: Plain[]) => ({
  id,
  name,
  width: size[0],
  height: size[1],
  background: { type: 'solid', color: lit('#ffffff') },
  layers: layers.map((l) => JSON.parse(JSON.stringify(l))),
});
const doc = (extraPages: Plain[] = []) => ({
  schemaVersion: 1,
  brandKit: null,
  pages: [
    pageOf('p_one', 'Launch', [1080, 1080], [TITLE, PHOTO]),
    pageOf('p_two', 'Back', [1080, 1350], []),
    ...extraPages,
  ],
});

let counter = 0;
const nextId = () =>
  `${String(++counter).padStart(8, '0')}-0000-4000-8000-000000000000`;
let design: { id: string; revisions: any[] };
let template: { id: string; revisions: any[] };
const meta = (r: any) => ({
  id: r.id,
  revisionNumber: r.revisionNumber,
  schemaVersion: 1,
  contentHash: SHA(String(r.revisionNumber)),
  createdAt: T0,
});

const server = (method: string, url: string, body: any): Reply => {
  const { pathname } = new URL(url, 'https://api.test');
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
    if (method === 'GET' && dm[4]) {
      const r = o.revisions.find((entry: any) => entry.id === dm[4]);
      return r
        ? reply(200, { ...meta(r), content: r.content })
        : reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
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
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    return server(init.method || 'GET', url, body);
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
const toolbar = () => screen.getByRole('toolbar', { name: 'Design editor' });
const dialog = (title: string) =>
  screen.getByRole('dialog', { name: title }) as HTMLElement;
const ONE = 'Duplicate as size';
const CAMPAIGN = 'Create campaign variants';
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
const pageSizes = () =>
  pageCards().map(
    (card) => card.querySelector('[data-page-size]')?.textContent
  );
// the card's own text: its label and size, not its thumbnail's
const cardText = (card: HTMLElement) =>
  `${card.querySelector('[data-page-label]')?.textContent}${
    card.querySelector('[data-page-size]')?.textContent
  }`;
const current = () =>
  pageCards().findIndex((card) => card.getAttribute('aria-pressed') === 'true');
const option = (root: HTMLElement, name: RegExp) =>
  within(root).getByRole(
    within(root).queryAllByRole('checkbox').length ? 'checkbox' : 'radio',
    { name }
  ) as HTMLInputElement;
const create = async (title: string, sizes: RegExp[]) => {
  await click(button(title, toolbar().parentElement as HTMLElement));
  const form = dialog(title);
  for (const size of sizes) {
    await click(option(form, size));
  }
  await click(
    button(title === ONE ? 'Create variant' : 'Create variants', form)
  );
};
const UI_TIMEOUT = 60_000;
const ui = (name: string, test: () => Promise<void>) =>
  it(name, test, UI_TIMEOUT);

// ============================================================================
describe('Duplicate as size', () => {
  ui('FV1/FV2 only while editing; never on a historical revision', async () => {
    design.revisions.push({ id: nextId(), revisionNumber: 2, content: doc() });
    await show(h(ContentStudioDesignWorkspace, { designId: design.id }));
    expect(screen.queryByRole('button', { name: ONE })).toBeNull();
    expect(screen.queryByRole('button', { name: CAMPAIGN })).toBeNull();
    await click(button('View Revision 1'));
    expect(screen.getByText('Read-only historical revision')).toBeTruthy();
    expect(screen.queryByRole('button', { name: ONE })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit design' })).toBeNull();
    cleanup();
    await openDesign();
    expect(button(ONE)).toBeTruthy();
    expect(button(CAMPAIGN)).toBeTruthy();
  });

  ui(
    'FV3 the sizes are named with their dimensions; the page’s own size says so',
    async () => {
      await openDesign();
      await click(button(ONE));
      const form = dialog(ONE);
      expect(form.textContent).toContain('This page: 1080 × 1080');
      const labels = Array.from(form.querySelectorAll('label')).map(
        (label) => label.textContent
      );
      expect(labels).toEqual([
        'Square 1080 × 1080 · same size',
        'Portrait 1080 × 1350',
        'Story 1080 × 1920',
        'Landscape 1200 × 628',
      ]);
      expect(within(form).getAllByRole('radio')).toHaveLength(4);
      // a different size is chosen to start with
      expect(option(form, /Portrait/).checked).toBe(true);
    }
  );

  ui(
    'FV4/FV5/FV6/FV7 one size makes one page after the source, opened with nothing selected; the draft is dirty',
    async () => {
      await openDesign();
      await row('Title');
      expect(button('Save', toolbar()).disabled).toBe(true);
      await create(ONE, [/Story/]);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(pageSizes()).toEqual([
        '1080 × 1080',
        '1080 × 1920',
        '1080 × 1350',
      ]);
      expect(current()).toBe(1);
      expect(screen.queryByText(/layers selected/)).toBeNull();
      expect(
        document.querySelectorAll('[data-layer-row][aria-pressed="true"]')
      ).toHaveLength(0);
      expect(button('Save', toolbar()).disabled).toBe(false);
      expect(writes()).toEqual([]);
    }
  );

  ui(
    'FV8 Save is the normal design save: the base revision and the document, nothing else',
    async () => {
      await openDesign();
      await create(ONE, [/Story/]);
      const body = await saveDraft();
      expect(Object.keys(body)).toEqual(['baseRevisionNumber', 'content']);
      const pages = body.content.pages;
      expect(pages.map((p: Plain) => p.name)).toEqual([
        'Launch',
        'Launch · Story',
        'Back',
      ]);
      expect(pages[0]).toEqual(doc().pages[0]);
      const [title, photo] = pages[1].layers;
      expect(title).toMatchObject({ x: 10, y: 440, fontSize: 40 });
      expect(photo).toMatchObject({
        imageRef: PHOTO.imageRef,
        focalPoint: PHOTO.focalPoint,
        mask: PHOTO.mask,
      });
      expect(title.id).not.toBe('title');
    }
  );
});

// ============================================================================
describe('Create campaign variants', () => {
  ui(
    'FCAM1/FCAM2 several sizes, each at most once; at least two are needed',
    async () => {
      await openDesign();
      await click(button(CAMPAIGN));
      const form = dialog(CAMPAIGN);
      expect(within(form).getAllByRole('checkbox')).toHaveLength(4);
      expect(within(form).queryAllByRole('radio')).toHaveLength(0);
      const go = button('Create variants', form);
      expect(go.disabled).toBe(true);
      await click(option(form, /Story/));
      expect(go.disabled).toBe(true);
      await click(option(form, /Portrait/));
      expect(go.disabled).toBe(false);
      // ticking again removes it: a size is never asked for twice
      await click(option(form, /Portrait/));
      expect(option(form, /Portrait/).checked).toBe(false);
      expect(go.disabled).toBe(true);
    }
  );

  ui(
    'FCAM3/FCAM4/FCAM5/CAM7/CAM8 one click makes all of them after the source, in the shown order; the first opens',
    async () => {
      await openDesign();
      await row('Photo');
      // ticked out of order: the pages follow the order shown
      await create(CAMPAIGN, [/Story/, /Square/, /Portrait/]);
      expect(pageCards().map(cardText)).toEqual([
        'Page 1Launch1080 × 1080',
        'Page 2Launch · Square1080 × 1080',
        'Page 3Launch · Portrait1080 × 1350',
        'Page 4Launch · Story1080 × 1920',
        'Page 5Back1080 × 1350',
      ]);
      expect(
        screen
          .getByRole('list', { name: 'Pages' })
          .querySelectorAll('[data-preview="thumbnail"]')
      ).toHaveLength(5);
      expect(current()).toBe(1);
      expect(
        document.querySelectorAll('[data-layer-row][aria-pressed="true"]')
      ).toHaveLength(0);
    }
  );

  ui(
    'CAM5/CAM6 one undo step removes every new page; redo brings back the same ones',
    async () => {
      await openDesign();
      await create(CAMPAIGN, [/Portrait/, /Story/]);
      const made = pageCards().map(cardText);
      await click(button('Undo', toolbar()));
      expect(pageSizes()).toEqual(['1080 × 1080', '1080 × 1350']);
      expect(button('Undo', toolbar()).disabled).toBe(true);
      await click(button('Redo', toolbar()));
      expect(pageCards().map(cardText)).toEqual(made);
    }
  );

  ui(
    'FCAM6 no campaign, variant or source link is saved: ordinary pages only',
    async () => {
      await openDesign();
      await create(CAMPAIGN, [/Portrait/, /Story/]);
      const body = await saveDraft();
      expect(JSON.stringify(body)).not.toMatch(
        /source|variant|campaign|responsive|breakpoint|constraint|group/i
      );
      for (const page of body.content.pages) {
        expect(Object.keys(page).sort()).toEqual([
          'background',
          'height',
          'id',
          'layers',
          'name',
          'width',
        ]);
      }
    }
  );

  ui(
    'VLIM5 a refused request makes nothing: a fixed message, no undo step, the page stays open',
    async () => {
      // 23 more pages: 25 in all, so no page can be added
      await openDesign(
        Array.from({ length: 22 }, (_, i) =>
          pageOf(`p_more${i}`, '', [1080, 1080], [])
        )
      );
      expect(button(ONE).disabled).toBe(false);
      await create(CAMPAIGN, [/Portrait/, /Story/]);
      expect(mockToast).toHaveBeenCalledWith(
        'A design can have up to 25 pages.',
        'warning'
      );
      expect(button('Undo', toolbar()).disabled).toBe(true);
      expect(pageCards()).toHaveLength(24);
      expect(current()).toBe(0);
      expect(dialog(CAMPAIGN)).toBeTruthy();
    }
  );

  ui('a full design offers no variants', async () => {
    await openDesign(
      Array.from({ length: 23 }, (_, i) =>
        pageOf(`p_more${i}`, '', [1080, 1080], [])
      )
    );
    expect(button(ONE).disabled).toBe(true);
    expect(button(CAMPAIGN).disabled).toBe(true);
  });
});

// ============================================================================
describe('Size variants in the template workspace', () => {
  ui(
    'TV1/TV2/TV3/TV4 new layers get new ids, no guidance is made for them, the old guidance stays on its own targets, the template saves',
    async () => {
      await show(
        h(ContentStudioDesignTemplateWorkspace, { templateId: template.id })
      );
      await click(button('Edit template'));
      await create(CAMPAIGN, [/Portrait/, /Story/]);
      const body = await saveDraft();
      expect(Object.keys(body).sort()).toEqual([
        'baseRevisionNumber',
        'content',
        'guidance',
      ]);
      expect(body.guidance).toEqual(GUIDANCE);
      const ids = body.content.pages.flatMap((p: Plain) =>
        p.layers.map((l: Plain) => l.id)
      );
      expect(ids.filter((id: string) => id === 'title')).toHaveLength(1);
      expect(new Set(ids).size).toBe(ids.length);
      expect(body.content.pages).toHaveLength(4);
    }
  );
});

// ============================================================================
describe('Size variant boundaries', () => {
  const dir = __dirname;
  const ROOT = join(dir, '../../../../..');
  const code = (file: string) =>
    readFileSync(join(ROOT, file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
  const EDITOR =
    'apps/frontend/src/components/content-studio/content-studio.design.editor.ts';
  const EDITING =
    'apps/frontend/src/components/content-studio/content-studio.design.editing.tsx';
  const variants = () => {
    const editor = code(EDITOR);
    return editor.slice(
      editor.indexOf('export interface ContentStudioDesignPageVariantTarget'),
      editor.indexOf('export const deleteContentStudioDesignPage')
    );
  };
  const dialogCode = () => {
    const editing = code(EDITING);
    return editing.slice(
      editing.indexOf('const DesignPageVariantDialog'),
      editing.indexOf('export const DesignEditorToolbar')
    );
  };

  it('P416-1/P416-2/P416-3/P416-4/P416-5 Design Document v1 has no variant, link, group, constraint or breakpoint', () => {
    const document = code(
      'libraries/nestjs-libraries/src/content-studio/design/design.document.ts'
    );
    expect(document).toContain(
      'export const DESIGN_DOCUMENT_SCHEMA_VERSION = 1;'
    );
    expect(document).not.toMatch(
      /sourcePageId|variantOf|variantGroup|campaign|responsive|breakpoint|constraint/i
    );
    expect(variants()).not.toMatch(
      /sourcePageId|variantOf|variantGroup|campaignGroup|responsive|breakpoint|constraint/
    );
  });

  it('P416-6/P416-13 no page link, campaign or variant model', () => {
    const schema = readFileSync(
      join(
        ROOT,
        'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
      ),
      'utf8'
    );
    // P4-17 adds the one page set recipe model; still no link or campaign
    expect(schema).not.toMatch(/model \w*(Campaign|Variant|PageLink)\w* \{/);
    expect(schema.match(/model \w*PageSet\w* \{/g)).toEqual([
      'model ContentStudioDesignPageSet {',
    ]);
  });

  it('P416-7/P416-9/P416-10/P416-11 pure: no Fabric, network, AI, Media read or Brand Kit lookup', () => {
    for (const body of [variants(), dialogCode()]) {
      expect(body).not.toMatch(
        /fabric|toJSON\(|toObject|loadFromJSON|fetch|request\(|useSWR|\/ai\/|AIWriting|generate|getMediaDesignRef|design-ref|readMedia|sha256Hex|BrandKit|latest Brand|getBrandKit/i
      );
    }
    expect(variants()).toContain('parseContentStudioDesignDocument(next)');
  });

  // P4-17 adds the 5 page set routes: still no variant route
  it('P416-8/P416-14 no variant route: the API keeps its routes (112; 117 with page sets, 122 with blocks, 128 with reviews, 133 with review discussion, 135 with claim review, 139 with approval decisions)', () => {
    const controller = code(
      'apps/backend/src/api/routes/content-studio.controller.ts'
    );
    expect(
      controller.match(/^\s*@(Get|Post|Put|Patch|Delete)\(/gm)
    ).toHaveLength(139);
    expect(controller).not.toMatch(/variant|campaign|resize|responsive/i);
  });

  it('P416-12 no new dependency', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(
      names.filter((name) => /resize|geometry|responsive|layout/i.test(name))
    ).toEqual([]);
    expect(pkg.dependencies.fabric).toBe('6.9.1');
  });

  it('the sizes come from the one canvas preset list; plain duplicate page is untouched', () => {
    expect(dialogCode()).toContain('DESIGN_CANVAS_PRESETS');
    expect(dialogCode()).not.toMatch(/1080|1350|1920|1200|628/);
    const editor = code(EDITOR);
    const duplicate = editor.slice(
      editor.indexOf('export const duplicateContentStudioDesignPage'),
      editor.indexOf('export interface ContentStudioDesignPageVariantTarget')
    );
    expect(duplicate).not.toMatch(/scale|Variant/);
  });
});
