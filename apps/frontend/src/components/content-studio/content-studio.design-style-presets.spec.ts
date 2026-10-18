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

// Creative Studio style presets and richer controls (P4-13): the preset
// picker, saving a layer's style, applying with exact Brand Kit tokens, the
// quick text and shape controls, and the same in the template workspace. A
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
const SECRET = 'STYLE_PRESET_SERVER_SECRET_123';
const T0 = '2026-10-18T10:00:00.000Z';
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const lit = (value: string) => ({ type: 'literal', value });
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
      { id: 'accent', name: 'Accent', value: '#ff5700', role: 'accent' },
    ],
    typography: [],
    visualDirection: { keywords: [], dos: [], donts: [] },
  },
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
  id: 'box',
  name: 'Box',
  type: 'shape',
  shape: 'rectangle',
  fill: lit('#ff0000'),
  cornerRadius: 0,
};
const DOT = { ...BOX, id: 'dot', name: 'Dot', shape: 'ellipse' };
const PHOTO = {
  ...base,
  id: 'photo',
  name: 'Photo',
  type: 'image',
  imageRef: { type: 'media', mediaId: 'media-1', sha256: SHA('a') },
  fit: 'cover',
  focalPoint: { x: 0.5, y: 0.5 },
};
const doc = (brandKit: Plain | null = null) => ({
  schemaVersion: 1,
  brandKit,
  pages: [
    {
      id: 'p_one',
      name: 'One',
      width: 1080,
      height: 1080,
      background: { type: 'solid', color: lit('#ffffff') },
      layers: [TITLE, BOX, DOT, PHOTO].map((l) =>
        JSON.parse(JSON.stringify(l))
      ),
    },
  ],
});
const BRAND_REF = {
  brandKitId: KIT,
  revisionId: REV,
  revisionNumber: 3,
  contentHash: SHA('b'),
};
const textContent = (style: Plain = {}) => ({
  schemaVersion: 1,
  kind: 'text',
  style: {
    font: { type: 'family', family: 'Inter', weight: 700, style: 'normal' },
    fontSize: 96,
    lineHeight: 1.1,
    letterSpacing: -1,
    color: lit('#222222'),
    align: 'center',
    verticalAlign: 'middle',
    opacity: 0.9,
    ...style,
  },
});
const shapeContent = (style: Plain = {}) => ({
  schemaVersion: 1,
  kind: 'shape',
  style: { fill: lit('#00ff00'), cornerRadius: 24, opacity: 0.5, ...style },
});
const SYSTEM = [
  {
    source: 'system',
    id: 'system:text-heading-bold',
    name: 'Heading — Bold',
    description: 'A heading.',
    kind: 'text',
    archivedAt: null,
    contentHash: SHA('1'),
    content: textContent(),
  },
  {
    source: 'system',
    id: 'system:shape-solid-card',
    name: 'Solid card',
    description: 'A card.',
    kind: 'shape',
    archivedAt: null,
    contentHash: SHA('2'),
    content: shapeContent(),
  },
];

let counter = 0;
const nextId = () =>
  `${String(++counter).padStart(8, '0')}-0000-4000-8000-000000000000`;
type Preset = {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  archivedAt: string | null;
  content: any;
};
let presets: Preset[];
let design: { id: string; revisions: any[] };
let template: { id: string; revisions: any[] };
let override: (method: string, url: string, body: any) => Reply | undefined;
const orgPreset = (p: Preset) => ({
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
  const P = '/content-studio/design-style-presets';
  if (pathname === P && method === 'GET') {
    const kind = searchParams.get('kind');
    const archived = searchParams.get('archived') === 'true';
    return reply(200, {
      system: archived ? [] : SYSTEM.filter((s) => s.kind === kind),
      pages: 1,
      results: presets
        .filter((p) => p.kind === kind && !!p.archivedAt === archived)
        .map(orgPreset),
    });
  }
  if (pathname === P && method === 'POST') {
    const p: Preset = {
      id: nextId(),
      name: body.name,
      description: body.description || null,
      kind: body.content.kind,
      archivedAt: null,
      content: body.content,
    };
    presets.push(p);
    return reply(201, orgPreset(p));
  }
  const pm = pathname.match(
    /^\/content-studio\/design-style-presets\/([^/]+)(?:\/(archive|restore))?$/
  );
  if (pm) {
    const p = presets.find((x) => x.id === pm[1]);
    if (!p) return reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
    if (method === 'PATCH') Object.assign(p, body);
    if (pm[2] === 'archive') p.archivedAt = T0;
    if (pm[2] === 'restore') p.archivedAt = null;
    return reply(200, orgPreset(p));
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
  presets = [
    {
      id: nextId(),
      name: 'Brand title',
      description: 'Ours',
      kind: 'text',
      archivedAt: null,
      content: textContent({ color: { type: 'brand', tokenId: 'primary' } }),
    },
    {
      id: nextId(),
      name: 'Old panel',
      description: null,
      kind: 'shape',
      archivedAt: T0,
      content: shapeContent({ fill: lit('#333333') }),
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
  within(root).getByRole('button', { name });
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
const dialog = (title: string) => screen.getByRole('dialog', { name: title });
const submit = async (root: HTMLElement) => {
  fireEvent.submit(root.querySelector('form') as HTMLFormElement);
  await flush();
};
const toolbar = () => screen.getByRole('toolbar', { name: 'Design editor' });
const panel = () =>
  screen.getByRole('region', { name: 'Style presets' }) as HTMLElement;
const queryPanel = () =>
  screen.queryByRole('region', { name: 'Style presets' });
const row = async (name: string, options: Plain = {}) => {
  const entry = Array.from(document.querySelectorAll('[data-layer-row]')).find(
    (element) => (element.textContent ?? '').includes(name)
  ) as HTMLElement;
  fireEvent.click(entry, options);
  await flush();
};
const openDesign = async (brandKit: Plain | null = null) => {
  design.revisions[0].content = doc(brandKit);
  await show(h(ContentStudioDesignWorkspace, { designId: design.id }));
  await click(button('Edit design'));
};
const saveDraft = async () => {
  await click(button('Save', toolbar()));
  return writes()
    .filter((c) => /\/revisions$/.test(c.url))
    .pop()?.body;
};
const layerOf = (content: Plain, id: string) =>
  content.pages[0].layers.find((l: Plain) => l.id === id);
const UI_TIMEOUT = 60_000;
const ui = (name: string, test: () => Promise<void>) =>
  it(name, test, UI_TIMEOUT);

// ============================================================================
describe('Style preset picker', () => {
  ui(
    'FP1/FP6/FP7/FP8/SS9 a text layer shows text presets only, each labelled by source; archived ones never',
    async () => {
      await openDesign();
      await row('Title');
      const builtIn = within(panel()).getByRole('list', {
        name: 'Built-in · Text styles',
      });
      const organization = within(panel()).getByRole('list', {
        name: 'Organization · Text styles',
      });
      expect(
        within(builtIn)
          .getAllByRole('listitem')
          .map((li) => li.textContent)
      ).toEqual([expect.stringContaining('Heading — Bold')]);
      expect(builtIn.textContent).toContain('Built-in');
      expect(within(organization).getAllByRole('listitem')).toHaveLength(1);
      expect(organization.textContent).toContain('Brand title');
      expect(organization.textContent).toContain('Organization');
      // built-ins can only be applied
      expect(
        within(builtIn)
          .getAllByRole('button')
          .map((b) => b.textContent)
      ).toEqual(['Apply']);
      expect(
        within(organization)
          .getAllByRole('button')
          .map((b) => b.textContent)
      ).toEqual(['Apply', 'Edit details', 'Archive']);
      expect(panel().textContent).not.toContain('Old panel');
      expect(
        calls()
          .filter((c) => c.url.includes('design-style-presets'))
          .map((c) => c.url)
      ).toEqual([
        '/content-studio/design-style-presets?kind=text&page=1&archived=false',
      ]);
    }
  );

  ui(
    'FP2 a shape layer shows shape presets; FP8/M24 an archived row the server returns by mistake is still left out',
    async () => {
      presets.push({
        id: nextId(),
        name: 'Leaked archived',
        description: null,
        kind: 'shape',
        archivedAt: T0,
        content: shapeContent(),
      });
      override = (method, url) => {
        if (
          method === 'GET' &&
          url.includes('design-style-presets?kind=shape&page=1&archived=false')
        ) {
          return reply(200, {
            system: SYSTEM.filter((s) => s.kind === 'shape'),
            pages: 1,
            results: presets.filter((p) => p.kind === 'shape').map(orgPreset),
          });
        }
        return undefined;
      };
      await openDesign();
      await row('Box');
      expect(panel().textContent).toContain('Solid card');
      expect(panel().textContent).not.toMatch(
        /Heading — Bold|Brand title|Leaked archived|Old panel/
      );
    }
  );

  ui(
    'FP3/FP4/FP5/SS3/M19/M20 no presets for an image, without a selection, with several layers chosen, or outside editing',
    async () => {
      await show(h(ContentStudioDesignWorkspace, { designId: design.id }));
      // a selection outside editing shows no presets
      await row('Title');
      expect(queryPanel()).toBeNull();
      await row('Title');
      await click(button('Edit design'));
      expect(queryPanel()).toBeNull();
      await row('Photo');
      expect(queryPanel()).toBeNull();
      await row('Title');
      expect(queryPanel()).toBeTruthy();
      await row('Box', { ctrlKey: true });
      expect(screen.getByText(/2 layers selected/)).toBeTruthy();
      expect(queryPanel()).toBeNull();
      expect(screen.queryByRole('button', { name: /^Apply / })).toBeNull();
    }
  );

  ui(
    'FP9/FP10/AP9/AP10/AP12/M13 Apply changes the draft only, as one undo step; the layer stays selected',
    async () => {
      await openDesign();
      await row('Title');
      const before = writes().length;
      await click(button('Apply Heading — Bold', panel()));
      expect(writes()).toHaveLength(before);
      expect(within(panel()).getByText(/Built-in · Applied/)).toBeTruthy();
      expect(
        screen.getByRole('heading', { name: 'Layer · Title' })
      ).toBeTruthy();
      expect(
        (screen.getByLabelText('Font size') as HTMLInputElement).value
      ).toBe('96');
      await click(button('Undo', toolbar()));
      expect(
        (screen.getByLabelText('Font size') as HTMLInputElement).value
      ).toBe('40');
      expect((button('Undo', toolbar()) as HTMLButtonElement).disabled).toBe(
        true
      );
      await click(button('Redo', toolbar()));
      const body = await saveDraft();
      expect(Object.keys(body).sort()).toEqual([
        'baseRevisionNumber',
        'content',
      ]);
      const title = layerOf(body.content, 'title');
      expect(title).toEqual({ ...TITLE, ...textContent().style });
      expect(layerOf(body.content, 'box')).toEqual(BOX);
      expect(JSON.stringify(body)).not.toMatch(
        /system:|preset|Heading|kind|schemaVersion":1,"kind/
      );
    }
  );

  ui(
    'AP5/AP6/M12 a shape preset keeps geometry and the shape; an ellipse keeps a corner radius of 0',
    async () => {
      await openDesign();
      await row('Dot');
      await click(button('Apply Solid card', panel()));
      const body = await saveDraft();
      expect(layerOf(body.content, 'dot')).toEqual({
        ...DOT,
        fill: lit('#00ff00'),
        opacity: 0.5,
        cornerRadius: 0,
      });
    }
  );
});

// ============================================================================
describe('Brand Kit tokens in presets', () => {
  ui(
    'BP4/BP6/BP7 a token preset on a design without a Brand Kit is refused whole: nothing attached, converted or partly applied',
    async () => {
      await openDesign();
      await row('Title');
      await click(button('Apply Brand title', panel()));
      expect(mockToast).toHaveBeenCalledWith(
        'This style uses Brand Kit colors or typography that this design’s Brand Kit revision does not have. Nothing was changed.',
        'warning'
      );
      expect(
        (screen.getByLabelText('Font size') as HTMLInputElement).value
      ).toBe('40');
      expect((button('Undo', toolbar()) as HTMLButtonElement).disabled).toBe(
        true
      );
      expect(calls().map((c) => c.url)).not.toContain(
        '/content-studio/brand-kit'
      );
    }
  );

  ui(
    'BP2/BP5/TC5 a compatible token preset applies with the design’s exact revision; no other revision is read',
    async () => {
      await openDesign(BRAND_REF);
      await row('Title');
      await click(button('Apply Brand title', panel()));
      const body = await saveDraft();
      expect(layerOf(body.content, 'title').color).toEqual({
        type: 'brand',
        tokenId: 'primary',
      });
      expect(body.content.brandKit).toEqual(BRAND_REF);
      expect(
        calls()
          .filter((c) => c.url.includes('brand-kit'))
          .map((c) => c.url)
          .every((u) => u === `/content-studio/brand-kit/revisions/${REV}`)
      ).toBe(true);
    }
  );

  ui(
    'BP3/M15/M16 a token the exact revision does not have rejects the whole apply',
    async () => {
      presets[0].content = textContent({
        color: { type: 'brand', tokenId: 'missing' },
      });
      await openDesign(BRAND_REF);
      await row('Title');
      await click(button('Apply Brand title', panel()));
      expect(mockToast).toHaveBeenCalledWith(
        expect.stringContaining('Nothing was changed.'),
        'warning'
      );
      expect(
        (screen.getByLabelText('Font size') as HTMLInputElement).value
      ).toBe('40');
    }
  );

  ui('BP1 a literal preset works without any Brand Kit', async () => {
    await openDesign();
    await row('Box');
    await click(button('Apply Solid card', panel()));
    expect(mockToast).not.toHaveBeenCalledWith(expect.anything(), 'warning');
  });
});

// ============================================================================
describe('Saving a style as a preset', () => {
  ui(
    'SS1/SS4/SS5/SS6/SS7/M21/M22 the selected text layer’s style fields only; the new preset appears',
    async () => {
      await openDesign();
      await row('Title');
      await click(button('Save style as preset', panel()));
      const modal = dialog('Save style as preset');
      fireEvent.change(within(modal).getByLabelText('Preset name'), {
        target: { value: '  My title ' },
      });
      await submit(modal);
      const [post] = writes();
      expect(post.url).toBe('/content-studio/design-style-presets');
      expect(Object.keys(post.body).sort()).toEqual([
        'content',
        'description',
        'name',
      ]);
      expect(post.body.name).toBe('My title');
      expect(post.body.content).toEqual({
        schemaVersion: 1,
        kind: 'text',
        style: {
          font: TITLE.font,
          fontSize: 40,
          lineHeight: 1.2,
          letterSpacing: 0,
          color: lit('#111111'),
          align: 'left',
          verticalAlign: 'top',
          opacity: 1,
        },
      });
      expect(JSON.stringify(post.body)).not.toMatch(
        /Hello world|"x"|"y"|width|height|rotation|"title"|p_one|overflow|visible|pages|layers/
      );
      expect(
        within(panel()).getByRole('list', {
          name: 'Organization · Text styles',
        }).textContent
      ).toContain('My title');
    }
  );

  ui(
    'SS2 a shape layer saves fill, corner radius and opacity only',
    async () => {
      await openDesign();
      await row('Box');
      await click(button('Save style as preset', panel()));
      const modal = dialog('Save style as preset');
      fireEvent.change(within(modal).getByLabelText('Preset name'), {
        target: { value: 'Red box' },
      });
      await submit(modal);
      expect(writes()[0].body.content).toEqual({
        schemaVersion: 1,
        kind: 'shape',
        style: { fill: lit('#ff0000'), cornerRadius: 0, opacity: 1 },
      });
    }
  );

  ui(
    'SS8/M23 organization presets are renamed, described, archived and restored; built-ins expose none of it',
    async () => {
      await openDesign();
      await row('Title');
      await click(button('Edit details Brand title', panel()));
      const modal = dialog('Edit details');
      fireEvent.change(within(modal).getByLabelText('Preset name'), {
        target: { value: 'Renamed' },
      });
      await submit(modal);
      expect(writes()[0]).toEqual({
        method: 'PATCH',
        url: `/content-studio/design-style-presets/${presets[0].id}`,
        body: { name: 'Renamed', description: 'Ours' },
      });
      await click(button('Archive Renamed', panel()));
      expect(writes()[1].url).toBe(
        `/content-studio/design-style-presets/${presets[0].id}/archive`
      );
      expect(panel().textContent).not.toContain('Renamed');
      await click(button('Archived style presets', panel()));
      const archived = dialog('Archived style presets');
      await click(button('Restore Renamed', archived));
      expect(writes()[2].url).toBe(
        `/content-studio/design-style-presets/${presets[0].id}/restore`
      );
      expect(
        screen.queryByRole('button', {
          name: /^(Archive|Edit details) Heading/,
        })
      ).toBeNull();
    }
  );
});

// ============================================================================
describe('Richer text and shape controls', () => {
  ui(
    'TC1/TC2/TC3/TC4 quick font size, alignment, bold and italic each change only their field',
    async () => {
      await openDesign();
      await row('Title');
      for (const name of [
        'Increase font size',
        'Decrease font size',
        'Align text Center',
        'Bold',
        'Italic',
      ]) {
        expect(button(name)).toBeTruthy();
      }
      expect(
        screen.queryByLabelText(/stroke|shadow|gradient|underline|uppercase/i)
      ).toBeNull();
      // presses in a row (within 300 ms) are one undo step
      let clock = 1_000_000;
      const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
      await click(button('Increase font size'));
      clock += 100;
      await click(button('Increase font size'));
      now.mockRestore();
      await click(button('Undo', toolbar()));
      expect(
        (screen.getByLabelText('Font size') as HTMLInputElement).value
      ).toBe('40');
      await click(button('Increase font size'));
      await click(button('Align text Center'));
      expect(button('Align text Center').getAttribute('aria-pressed')).toBe(
        'true'
      );
      await click(button('Bold'));
      expect(button('Bold').getAttribute('aria-pressed')).toBe('true');
      await click(button('Italic'));
      const body = await saveDraft();
      expect(layerOf(body.content, 'title')).toEqual({
        ...TITLE,
        fontSize: 42,
        align: 'center',
        font: { ...TITLE.font, weight: 700, style: 'italic' },
      });
    }
  );

  ui(
    'TC5/TC6/TC7/SC2 swatches: the exact revision’s Brand colors and the design’s own colors, literal entry kept',
    async () => {
      await openDesign(BRAND_REF);
      await row('Box');
      const brand = screen.getByRole('group', { name: 'Fill: Brand colors' });
      expect(
        within(brand)
          .getAllByRole('button')
          .map((b) => b.getAttribute('aria-label'))
      ).toEqual(['Fill: Brand color Primary', 'Fill: Brand color Accent']);
      const own = screen.getByRole('group', {
        name: 'Fill: Colors in this design',
      });
      expect(
        within(own)
          .getAllByRole('button')
          .map((b) => b.getAttribute('aria-label'))
      ).toEqual(['Fill: #ffffff', 'Fill: #111111', 'Fill: #ff0000']);
      expect(button('Fill: #ff0000').getAttribute('aria-pressed')).toBe('true');
      await click(button('Fill: Brand color Accent'));
      expect(
        button('Fill: Brand color Accent').getAttribute('aria-pressed')
      ).toBe('true');
      expect(screen.getByLabelText('Fill source')).toBeTruthy();
      const body = await saveDraft();
      expect(layerOf(body.content, 'box')).toEqual({
        ...BOX,
        fill: { type: 'brand', tokenId: 'accent' },
      });
      expect(calls().map((c) => c.url)).not.toContain(
        '/content-studio/brand-kit'
      );
      expect(calls().some((c) => /brand-kit\/revisions\?/.test(c.url))).toBe(
        false
      );
    }
  );

  ui('a design without a Brand Kit offers literal swatches only', async () => {
    await openDesign();
    await row('Title');
    expect(
      screen.queryByRole('group', { name: 'Color: Brand colors' })
    ).toBeNull();
    expect(
      screen.getByRole('group', { name: 'Color: Colors in this design' })
    ).toBeTruthy();
  });

  ui(
    'SC1/SC3/SC4/SC5 corner presets change only the corner radius of a rectangle; ellipses have none',
    async () => {
      await openDesign();
      await row('Box');
      await click(button('Corners Pill'));
      expect(button('Corners Pill').getAttribute('aria-pressed')).toBe('true');
      expect(screen.queryByLabelText(/stroke/i)).toBeNull();
      const body = await saveDraft();
      expect(layerOf(body.content, 'box')).toEqual({
        ...BOX,
        cornerRadius: 50,
      });
      await click(button('Edit design'));
      await row('Dot');
      expect(
        screen.queryByRole('group', { name: 'Corner presets' })
      ).toBeNull();
    }
  );
});

// ============================================================================
describe('Style presets in the template workspace', () => {
  ui(
    'a template draft takes presets like a design; its fields stay exactly as they were',
    async () => {
      await show(
        h(ContentStudioDesignTemplateWorkspace, { templateId: template.id })
      );
      await click(button('Edit template'));
      await row('Title');
      await click(button('Apply Heading — Bold', panel()));
      const body = await saveDraft();
      expect(Object.keys(body).sort()).toEqual([
        'baseRevisionNumber',
        'content',
        'guidance',
      ]);
      expect(body.guidance).toEqual(template.revisions[0].guidance);
      expect(layerOf(body.content, 'title')).toEqual({
        ...TITLE,
        ...textContent().style,
      });
      expect(JSON.stringify(body)).not.toMatch(/system:|preset/i);
    }
  );
});

// ============================================================================
describe('Style preset frontend boundaries', () => {
  const dir = __dirname;
  const code = (file: string) =>
    readFileSync(join(dir, file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
  const FILES = [
    'content-studio.design-style-presets.tsx',
    'content-studio.design-style-presets.api.ts',
  ];

  ui(
    'P413-6/P413-7/P413-8/P413-11/M25/M26 previews are DOM samples: no render, Media, canvas, image, Fabric, storage or AI',
    async () => {
      for (const file of FILES) {
        expect([file, code(file)]).not.toEqual([
          file,
          expect.stringMatching(
            /from 'fabric'|toJSON|toObject|loadFromJSON|\/render|\/media|ContentStudioDesignCanvas|<canvas|<img|localStorage|sessionStorage|navigator\.clipboard|\/ai\/|generate|marketplace|public/
          ),
        ]);
      }
      await openDesign();
      await row('Title');
      expect(panel().querySelectorAll('canvas, img, [src]')).toHaveLength(0);
      expect(
        panel().querySelectorAll('[data-style-sample="text"]')
      ).toHaveLength(2);
      expect(calls().filter((c) => /render|\/media/.test(c.url))).toEqual([]);
    }
  );

  it('P413-2/P413-9/P413-10/M27/M28 nothing of a preset or of the picker enters the design; Brand only from the exact revision', () => {
    const editor = code('content-studio.design.editor.ts');
    const applyOp = editor.slice(
      editor.indexOf('export const applyContentStudioDesignStyle'),
      editor.indexOf('export const contentStudioDesignDocumentColors')
    );
    expect(applyOp).toContain(
      'applyContentStudioDesignStylePreset(layer, content)'
    );
    expect(applyOp).not.toMatch(
      /presetId|preset\.id|kind:|source|selected|latest/
    );
    const api = code('content-studio.design-style-presets.api.ts');
    expect(api).not.toMatch(/brand-kit|BrandKit|latest/i);
    expect(code('content-studio.designs.api.ts')).toContain(
      'body: JSON.stringify({ baseRevisionNumber, content })'
    );
    const panelCode = code('content-studio.design-style-presets.tsx');
    expect(panelCode).not.toMatch(/useContentStudioBrandKit|brand-kit/);
    // saving sends the extracted style, never the layer or the document
    expect(panelCode).toContain('extractContentStudioDesignStylePreset(layer)');
    expect(api).toMatch(
      /content: \{\s*schemaVersion: input\.content\.schemaVersion,\s*kind: input\.content\.kind,\s*style: input\.content\.style,\s*\}/
    );
  });
});
