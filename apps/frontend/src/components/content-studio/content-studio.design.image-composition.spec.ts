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

// Creative Studio image composition (P4-14): Fit buttons, the focal point
// picker, the image frame (mask) and its radius, in the editor, the
// structural preview, read-only revisions and templates. A .spec.ts without
// JSX, like the other Content Studio frontend specs: components are
// required, not imported. The Fabric adapter is an inert stand-in (direct
// canvas editing has its own spec)
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

// jsdom has no PointerEvent: without one, fireEvent.pointer* drops clientX
// and clientY. A MouseEvent with a pointerId is all the picker reads
if (typeof (globalThis as any).PointerEvent === 'undefined') {
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  (globalThis as any).PointerEvent = TestPointerEvent;
}

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
const SECRET = 'IMAGE_COMPOSITION_SERVER_SECRET_123';
const T0 = '2026-10-21T10:00:00.000Z';
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const lit = (value: string) => ({ type: 'literal', value });
const PHOTO = {
  id: 'photo',
  name: 'Photo',
  x: 100,
  y: 200,
  width: 400,
  height: 300,
  rotation: 10,
  opacity: 0.9,
  visible: true,
  type: 'image',
  imageRef: { type: 'media', mediaId: 'media-1', sha256: SHA('a') },
  fit: 'cover',
  focalPoint: { x: 0.25, y: 0.75 },
};
const BOX = {
  id: 'box',
  name: 'Box',
  x: 0,
  y: 0,
  width: 50,
  height: 50,
  rotation: 0,
  opacity: 1,
  visible: true,
  type: 'shape',
  shape: 'rectangle',
  fill: lit('#ff0000'),
  cornerRadius: 0,
};
const doc = (photo: Plain = PHOTO) => ({
  schemaVersion: 1,
  brandKit: null,
  pages: [
    {
      id: 'p_one',
      name: 'One',
      width: 1080,
      height: 1080,
      background: { type: 'solid', color: lit('#ffffff') },
      layers: [
        JSON.parse(JSON.stringify(photo)),
        JSON.parse(JSON.stringify(BOX)),
      ],
    },
  ],
});

let counter = 0;
const nextId = () =>
  `${String(++counter).padStart(8, '0')}-0000-4000-8000-000000000000`;
type Owner = { id: string; archivedAt: string | null; revisions: Plain[] };
let design: Owner;
let template: Owner;
let override: (method: string, url: string, body: any) => Reply | undefined;
const meta = (r: Plain) => ({
  id: r.id,
  revisionNumber: r.revisionNumber,
  schemaVersion: 1,
  contentHash: SHA(String(r.revisionNumber)),
  createdAt: T0,
});

const server = (method: string, url: string, body: any): Reply => {
  const { pathname } = new URL(url, 'https://api.test');
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
    return reply(200, { mediaId: mm[1], sha256: SHA('c') });
  }
  if (pathname.startsWith('/content-studio/design-style-presets')) {
    return reply(200, { system: [], pages: 0, results: [] });
  }
  const dm = pathname.match(
    /^\/content-studio\/(designs|design-templates)\/([^/]+)(?:\/(revisions)(?:\/([^/]+))?)?$/
  );
  if (dm) {
    const o = dm[1] === 'designs' ? design : template;
    if (o.id !== dm[2])
      return reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
    const last = o.revisions[o.revisions.length - 1];
    if (method === 'GET' && !dm[3]) {
      return reply(200, {
        ...(dm[1] === 'design-templates'
          ? { source: 'organization', description: null }
          : {}),
        id: o.id,
        name: 'Thing',
        latestRevisionNumber: o.revisions.length,
        archivedAt: o.archivedAt,
        createdAt: T0,
        updatedAt: T0,
        currentRevision: {
          ...meta(last),
          content: last.content,
          guidance: null,
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
      const r = o.revisions.find((x) => x.id === dm[4]);
      return r
        ? reply(200, {
            ...meta(r),
            content: r.content,
            guidance: null,
            guidanceHash: null,
          })
        : reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
    }
    if (method === 'POST' && dm[3]) {
      const r = {
        id: nextId(),
        revisionNumber: o.revisions.length + 1,
        content: body.content,
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
  design = {
    id: nextId(),
    archivedAt: null,
    revisions: [
      { id: nextId(), revisionNumber: 1, content: doc() },
      {
        id: nextId(),
        revisionNumber: 2,
        content: doc({
          ...PHOTO,
          mask: { type: 'roundedRectangle', cornerRadius: 40 },
        }),
      },
    ],
  };
  template = {
    id: nextId(),
    archivedAt: T0,
    revisions: [
      {
        id: nextId(),
        revisionNumber: 1,
        content: doc({ ...PHOTO, mask: { type: 'ellipse' } }),
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
const queryButton = (name: string | RegExp) =>
  screen.queryByRole('button', { name });
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
const toolbar = () => screen.getByRole('toolbar', { name: 'Design editor' });
const row = async (name: string) => {
  const entry = Array.from(document.querySelectorAll('[data-layer-row]')).find(
    (element) => (element.textContent ?? '').includes(name)
  ) as HTMLElement;
  fireEvent.click(entry);
  await flush();
};
const openEdit = async () => {
  await show(h(ContentStudioDesignWorkspace, { designId: design.id }));
  await click(button('Edit design'));
  await row('Photo');
};
const saveDraft = async () => {
  await click(button('Save', toolbar()));
  return writes()
    .filter((c) => /\/revisions$/.test(c.url))
    .pop()?.body;
};
const photoOf = (content: Plain) =>
  content.pages[0].layers.find((l: Plain) => l.id === 'photo');
const ROUNDED = { type: 'roundedRectangle', cornerRadius: 40 };
const picker = () =>
  document.querySelector('[data-focal-picker]') as HTMLButtonElement;
const withBox = (element: HTMLElement) => {
  element.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
};
const UI_TIMEOUT = 60_000;
const ui = (name: string, test: () => Promise<void>) =>
  it(name, test, UI_TIMEOUT);

// ============================================================================
describe('Image composition in the editor', () => {
  ui(
    'IMG1/IMG2/M5/M7 Fit buttons change only the fit; Contain keeps the focal point for Cover',
    async () => {
      await openEdit();
      expect(button('Fit Cover').getAttribute('aria-pressed')).toBe('true');
      await click(button('Fit Contain'));
      expect(button('Fit Contain').getAttribute('aria-pressed')).toBe('true');
      expect(picker().disabled).toBe(true);
      expect(
        screen.getByText(
          'Contain shows the whole image: the focal point is kept for Cover.'
        )
      ).toBeTruthy();
      await click(button('Fit Cover'));
      const body = await saveDraft();
      // back to the stored values: a contain/cover round trip changes nothing
      expect(body).toBeUndefined();
      await click(button('Fit Contain'));
      const saved = await saveDraft();
      expect(photoOf(saved.content)).toEqual({
        ...PHOTO,
        mask: ROUNDED,
        fit: 'contain',
      });
    }
  );

  ui(
    'IMG3/IMG4/IMG5/IMG11/M6 pointing sets the focal point once per gesture, clamped; the layer stays selected',
    async () => {
      await openEdit();
      const area = picker();
      withBox(area);
      fireEvent.pointerDown(area, { clientX: 50, clientY: 25, pointerId: 1 });
      fireEvent.pointerMove(area, { clientX: 120, clientY: 60, pointerId: 1 });
      fireEvent.pointerMove(area, { clientX: 400, clientY: -50, pointerId: 1 });
      await flush();
      // the marker follows; nothing is in the draft yet
      expect(
        (document.querySelector('[data-focal-marker]') as HTMLElement).style
          .left
      ).toBe('100%');
      expect(
        (screen.getByLabelText('Focal point X') as HTMLInputElement).value
      ).toBe('0.25');
      fireEvent.pointerUp(area, { clientX: 400, clientY: -50, pointerId: 1 });
      await flush();
      expect(
        (screen.getByLabelText('Focal point X') as HTMLInputElement).value
      ).toBe('1');
      expect(
        (screen.getByLabelText('Focal point Y') as HTMLInputElement).value
      ).toBe('0');
      expect(
        screen.getByRole('heading', { name: 'Layer · Photo' })
      ).toBeTruthy();
      // one gesture, one undo step
      await click(button('Undo', toolbar()));
      expect(
        (screen.getByLabelText('Focal point X') as HTMLInputElement).value
      ).toBe('0.25');
      expect((button('Undo', toolbar()) as HTMLButtonElement).disabled).toBe(
        true
      );
    }
  );

  ui(
    'focal point keys: arrows move it by steps, a run being one undo step; presets still work',
    async () => {
      await openEdit();
      let clock = 1_000_000;
      const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
      fireEvent.keyDown(picker(), { key: 'ArrowRight' });
      clock += 50;
      fireEvent.keyDown(picker(), { key: 'ArrowRight' });
      now.mockRestore();
      await flush();
      expect(
        (screen.getByLabelText('Focal point X') as HTMLInputElement).value
      ).toBe('0.35');
      // the layer did not move: the picker keeps its arrow keys
      expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe(
        '100'
      );
      await click(button('Undo', toolbar()));
      expect(
        (screen.getByLabelText('Focal point X') as HTMLInputElement).value
      ).toBe('0.25');
      await click(button('Focal point Top'));
      expect(picker().getAttribute('aria-label')).toBe(
        'Focal point picker: X 50%, Y 0%'
      );
    }
  );

  ui(
    'IMG6/IMG7/IMG8/IMG12/M8/M9/M10/M11 frames change only the mask, one undo step each; undo and redo restore it exactly',
    async () => {
      await openEdit();
      expect(button('Frame Rounded').getAttribute('aria-pressed')).toBe('true');
      expect(
        (screen.getByLabelText('Frame radius') as HTMLInputElement).value
      ).toBe('40');
      await click(button('Frame Ellipse'));
      expect(screen.queryByLabelText('Frame radius')).toBeNull();
      await click(button('Frame Rectangle'));
      await click(button('Frame Rounded'));
      // a new rounded frame starts at the default radius
      expect(
        (screen.getByLabelText('Frame radius') as HTMLInputElement).value
      ).toBe('24');
      await click(button('Frame radius Pill'));
      expect(
        (screen.getByLabelText('Frame radius') as HTMLInputElement).value
      ).toBe('150');
      await click(button('Undo', toolbar()));
      await click(button('Undo', toolbar()));
      expect(button('Frame Rectangle').getAttribute('aria-pressed')).toBe(
        'true'
      );
      await click(button('Undo', toolbar()));
      expect(button('Frame Ellipse').getAttribute('aria-pressed')).toBe('true');
      await click(button('Redo', toolbar()));
      await click(button('Redo', toolbar()));
      await click(button('Redo', toolbar()));
      const body = await saveDraft();
      expect(photoOf(body.content)).toEqual({
        ...PHOTO,
        mask: { type: 'roundedRectangle', cornerRadius: 150 },
      });
    }
  );

  ui(
    'IMG9/IMG10 the radius field takes 0..4096; other values never enter the draft',
    async () => {
      await openEdit();
      const field = screen.getByLabelText('Frame radius') as HTMLInputElement;
      fireEvent.change(field, { target: { value: '5000' } });
      fireEvent.blur(field);
      await flush();
      expect((button('Undo', toolbar()) as HTMLButtonElement).disabled).toBe(
        true
      );
      fireEvent.change(field, { target: { value: '12.5' } });
      fireEvent.blur(field);
      await flush();
      const body = await saveDraft();
      expect(photoOf(body.content).mask).toEqual({
        type: 'roundedRectangle',
        cornerRadius: 12.5,
      });
    }
  );

  ui(
    'MRIMG1/MRIMG3/MRIMG6/SECIMG1 Replace image changes only the Media reference the server made',
    async () => {
      await openEdit();
      await click(button('Replace image'));
      const modal = dialog('Replace image');
      await click(within(modal).getByRole('button', { name: 'beach.png' }));
      await click(button('Use image', modal));
      const body = await saveDraft();
      expect(photoOf(body.content)).toEqual({
        ...PHOTO,
        mask: ROUNDED,
        imageRef: { type: 'media', mediaId: 'media-2', sha256: SHA('c') },
      });
      expect(
        calls().some(
          (c) => c.url === '/content-studio/media/media-2/design-ref'
        )
      ).toBe(true);
    }
  );

  ui('a shape or text layer shows no image controls', async () => {
    await show(h(ContentStudioDesignWorkspace, { designId: design.id }));
    await click(button('Edit design'));
    await row('Box');
    expect(queryButton('Frame Ellipse')).toBeNull();
    expect(queryButton('Fit Contain')).toBeNull();
    expect(document.querySelector('[data-focal-picker]')).toBeNull();
  });
});

// ============================================================================
describe('Image composition in previews and read-only revisions', () => {
  ui(
    'PVIMG1/PVIMG2/PVIMG4/PVIMG5/PVIMG6 the structural preview rounds the placeholder; no render, Media or canvas',
    async () => {
      await show(h(ContentStudioDesignWorkspace, { designId: design.id }));
      const placeholder = document.querySelector(
        '[data-layer="photo"]'
      ) as HTMLElement;
      expect(placeholder.getAttribute('data-mask')).toBe('roundedRectangle');
      expect(placeholder.style.borderRadius).toBe('40px');
      expect(document.querySelectorAll('canvas, img')).toHaveLength(0);
      expect(calls().filter((c) => /render|\/media/.test(c.url))).toEqual([]);
    }
  );

  ui(
    'HISTIMG1/HISTIMG3/PVIMG1 an older revision without a mask opens as a rectangle, read-only',
    async () => {
      await show(h(ContentStudioDesignWorkspace, { designId: design.id }));
      await click(button('View Revision 1'));
      const placeholder = document.querySelector(
        '[data-layer="photo"]'
      ) as HTMLElement;
      expect(placeholder.getAttribute('data-mask')).toBe('rectangle');
      expect(placeholder.style.borderRadius).toBe('');
      await row('Photo');
      expect(screen.getByText('Rectangle')).toBeTruthy();
      expect(queryButton('Frame Ellipse')).toBeNull();
      expect(queryButton('Edit design')).toBeNull();
    }
  );

  ui(
    'HISTIMG1 the current revision shows its frame as text before editing',
    async () => {
      await show(h(ContentStudioDesignWorkspace, { designId: design.id }));
      await row('Photo');
      expect(screen.getByText('Rounded · 40')).toBeTruthy();
      expect(queryButton('Frame Rounded')).toBeNull();
    }
  );

  ui(
    'HISTIMG2/PVIMG3 an archived template shows its ellipse frame, read-only',
    async () => {
      await show(
        h(ContentStudioDesignTemplateWorkspace, { templateId: template.id })
      );
      const placeholder = document.querySelector(
        '[data-layer="photo"]'
      ) as HTMLElement;
      expect(placeholder.getAttribute('data-mask')).toBe('ellipse');
      expect(placeholder.style.borderRadius).toBe('50%');
      await row('Photo');
      expect(screen.getByText('Ellipse')).toBeTruthy();
      expect(queryButton('Edit template')).toBeNull();
      expect(queryButton('Frame Ellipse')).toBeNull();
    }
  );
});

// ============================================================================
describe('Image composition frontend boundaries', () => {
  const dir = __dirname;
  const code = (file: string) =>
    readFileSync(join(dir, file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');

  it('P414-5/P414-6/P414-15/M23/M24 masks never reach Fabric or a render; the preview draws CSS only', () => {
    const fabric = code('content-studio.design.fabric.ts');
    expect(fabric).not.toMatch(/mask|clipPath|toJSON|toObject|loadFromJSON/);
    const preview = code('content-studio.design.preview.tsx');
    expect(preview).not.toMatch(
      /clip-path|clipPath|\/render|useFetch|fetch\(|<canvas|<img/
    );
    const editing = code('content-studio.design.editing.tsx');
    expect(editing).not.toMatch(
      /clipPath|clip-path|localStorage|sessionStorage/
    );
  });

  it('P414-12/P414-13/P414-14/M25/M26 no image style preset, filter or crop zoom', () => {
    const presets = readFileSync(
      join(
        dir,
        '../../../../../libraries/nestjs-libraries/src/content-studio/design/design.style.preset.ts'
      ),
      'utf8'
    );
    expect(presets).toMatch(
      /DESIGN_STYLE_PRESET_KINDS: ContentStudioDesignStylePresetKind\[\] = \[\s*'text',\s*'shape',\s*\]/
    );
    const editor = code('content-studio.design.editor.ts');
    expect(editor).not.toMatch(
      /brightness|contrast|saturat|grayscale|blur|zoom|frameBackground/i
    );
  });
});
