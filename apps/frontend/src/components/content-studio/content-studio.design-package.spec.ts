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
import { listContentStudioSystemDesignTemplates } from '@gitroom/nestjs-libraries/content-studio/design/design.system.templates';
import { listContentStudioSystemDesignPageSets } from '@gitroom/nestjs-libraries/content-studio/design/design.system.page.sets';
import { parseContentStudioDesignDocument } from '@gitroom/nestjs-libraries/content-studio/design/design.document';

// P6-01 in the browser: Create design from one exact saved version of a
// package (any version, never the draft), its choices (the post, the
// starting point through the existing canvas, page set and template
// choices, the template's fields with the package text in the field chosen
// for it), the one request it sends (ids only, never the text) and where
// the new design says it came from. A .spec.ts without JSX, like the other
// Content Studio frontend specs: components are required, not imported
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
  usePathname: () => '/content-studio',
  useSearchParams: () => new URLSearchParams(),
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
const mockCloseAll = jest.fn(() => mockModals.set([]));
jest.mock('@gitroom/frontend/components/layout/new-modal', () => ({
  useModals: () => ({
    openModal: (modal: Omit<MockModal, 'id'>) =>
      mockModals.set([...mockModals.list, { ...modal, id: `m${++modalId}` }]),
    closeAll: mockCloseAll,
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
jest.mock('@gitroom/frontend/components/media/media.component', () => ({
  MediaBox: () => null,
}));
jest.mock('@gitroom/react/helpers/delete.dialog', () => ({
  deleteDialog: async () => true,
}));
const mockFetch = jest.fn();
jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));
jest.mock('@gitroom/frontend/components/layout/user.context', () => ({
  useUser: () => ({ id: 'user-1' }),
}));
const mockToast = jest.fn();
jest.mock('@gitroom/react/toaster/toaster', () => ({
  useToaster: () => ({ show: mockToast }),
}));
jest.mock('@gitroom/react/translation/get.transation.service.client', () => ({
  useT: () => (key: string, fallback?: string) => fallback ?? key,
}));
jest.mock('./content-studio.design.fabric', () => ({
  createContentStudioDesignFabric: () => ({
    sync: () => undefined,
    setView: () => undefined,
    dispose: () => undefined,
  }),
}));

const {
  ContentStudioRevisionHistory,
} = require('./content-studio.revision.history');
const { DesignPackageSource } = require('./content-studio.design-package');

type Plain = Record<string, any>;
const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => JSON.parse(JSON.stringify(body)),
});
const T0 = '2026-10-21T10:00:00.000Z';
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PACKAGE = uuid(1);
const REV_3 = uuid(3);
const REV_4 = uuid(4);
const NEW_DESIGN = uuid(9);
const ORG_TEMPLATE = uuid(21);
const ORG_TEMPLATE_REV = uuid(22);
const TEXT = '  Spring sale 🌸 PACKAGE_TEXT_ONLY_SERVER_READS\n\nSecond line';
const FOLLOW_UP = 'The follow-up';

const summary = (id: string, revisionNumber: number) => ({
  id,
  revisionNumber,
  contentHash: String(revisionNumber).repeat(64),
  origin: 'manual',
  sourceDraftVersion: revisionNumber,
  createdAt: T0,
  createdBy: { id: 'user-1', name: 'Ann' },
  approval: { approved: false, state: 'NOT_REVIEWED' },
});
const thread: Record<string, Plain[]> = {
  [REV_3]: [
    { id: 'main', text: TEXT, mediaIds: ['m1'] },
    { id: 'second', text: FOLLOW_UP, mediaIds: [] },
  ],
  [REV_4]: [{ id: 'only', text: 'Version four', mediaIds: [] }],
};
const detail = (id: string, revisionNumber: number) => ({
  ...summary(id, revisionNumber),
  packageId: PACKAGE,
  schemaVersion: 1,
  content: { schemaVersion: 1, copy: { global: { thread: thread[id] } } },
  media: {
    m1: {
      id: 'm1',
      path: '/m1.png',
      thumbnail: null,
      alt: null,
      status: 'ready',
    },
  },
  approval: {
    targetType: 'PACKAGE_REVISION',
    targetRevisionId: id,
    approved: false,
    state: 'NOT_REVIEWED',
  },
  handoffApprovalRequired: false,
});

// an organization template with a text field and an image field
const page = (layers: unknown[]) => ({
  id: 'page_1',
  name: '',
  width: 1080,
  height: 1080,
  background: { type: 'solid', color: { type: 'literal', value: '#ffffff' } },
  layers,
});
const orgTemplateContent = parseContentStudioDesignDocument({
  schemaVersion: 1,
  brandKit: null,
  pages: [
    page([
      {
        id: 'photo',
        name: '',
        x: 0,
        y: 0,
        width: 1080,
        height: 600,
        rotation: 0,
        opacity: 1,
        visible: true,
        type: 'image',
        imageRef: {
          type: 'media',
          mediaId: 'm_template',
          sha256: 'e'.repeat(64),
        },
        fit: 'cover',
        focalPoint: { x: 0.5, y: 0.5 },
      },
      {
        id: 'title',
        name: '',
        x: 0,
        y: 700,
        width: 1000,
        height: 200,
        rotation: 0,
        opacity: 1,
        visible: true,
        type: 'text',
        text: 'Title',
        font: { type: 'family', family: 'Inter', weight: 400, style: 'normal' },
        fontSize: 40,
        lineHeight: 1.2,
        letterSpacing: 0,
        color: { type: 'literal', value: '#000000' },
        align: 'left',
        verticalAlign: 'top',
        overflow: 'clip',
      },
    ]),
  ],
});
const orgTemplate = {
  source: 'organization',
  id: ORG_TEMPLATE,
  name: 'Photo post',
  description: null,
  latestRevisionNumber: 1,
  archivedAt: null,
  createdAt: T0,
  updatedAt: T0,
  currentRevision: {
    id: ORG_TEMPLATE_REV,
    revisionNumber: 1,
    schemaVersion: 1,
    contentHash: 'c'.repeat(64),
    createdAt: T0,
    content: orgTemplateContent,
    guidanceHash: 'd'.repeat(64),
    guidance: {
      schemaVersion: 1,
      brandRebinding: false,
      slots: [
        {
          id: 'title',
          type: 'text',
          label: 'Title',
          pageId: 'page_1',
          layerId: 'title',
          required: true,
          multiline: true,
        },
        {
          id: 'photo',
          type: 'image',
          label: 'Photo',
          pageId: 'page_1',
          layerId: 'photo',
          required: false,
        },
      ],
    },
  },
};

let failCreate: { status: number; code: string } | null;
// the server answers for version 3 with another version's data
let otherDetail: boolean;
const server = async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  if (url === `/content-studio/packages/${PACKAGE}/revisions?page=1`) {
    return reply(200, {
      pages: 1,
      results: [summary(REV_4, 4), summary(REV_3, 3)],
    });
  }
  for (const [id, n] of [
    [REV_3, 3],
    [REV_4, 4],
  ] as const) {
    if (url === `/content-studio/packages/${PACKAGE}/revisions/${id}`) {
      return reply(
        200,
        otherDetail && id === REV_3 ? detail(REV_4, 4) : detail(id, n)
      );
    }
    if (
      method === 'POST' &&
      url === `/content-studio/packages/${PACKAGE}/revisions/${id}/designs`
    ) {
      return failCreate
        ? reply(failCreate.status, { code: failCreate.code, msg: 'x' })
        : reply(201, {
            id: NEW_DESIGN,
            name: 'Design',
            latestRevisionNumber: 1,
            archivedAt: null,
            createdAt: T0,
            updatedAt: T0,
          });
    }
  }
  if (url.startsWith('/content-studio/reviews')) {
    return reply(200, { pages: 1, results: [] });
  }
  if (url.startsWith('/content-studio/design-templates?')) {
    return reply(200, {
      system: listContentStudioSystemDesignTemplates().map((template) => ({
        source: 'system',
        id: template.id,
        name: template.name,
        description: template.description,
        latestRevisionNumber: template.revisionNumber,
        archivedAt: null,
        currentRevision: {
          revisionNumber: template.revisionNumber,
          schemaVersion: template.schemaVersion,
          contentHash: template.contentHash,
          content: template.content,
          guidanceHash: template.guidanceHash,
          guidance: template.guidance,
        },
      })),
      pages: 1,
      results: [orgTemplate],
    });
  }
  if (url.startsWith('/content-studio/design-page-sets?')) {
    return reply(200, {
      system: listContentStudioSystemDesignPageSets().map((pageSet) => ({
        source: 'system',
        ...pageSet,
        pageCount: pageSet.content.pages.length,
        archivedAt: null,
      })),
      pages: 1,
      results: [],
    });
  }
  return reply(404, { code: 'CS_NOT_FOUND' });
};

beforeEach(() => {
  failCreate = null;
  otherDetail = false;
  modalId = 0;
  mockModals.set([]);
  mockPush.mockReset();
  mockToast.mockReset();
  mockCloseAll.mockClear();
  mockFetch.mockReset();
  mockFetch.mockImplementation(server);
});
afterEach(() => cleanup());

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
      h(Fragment, null, element, h(ModalHost))
    )
  );
  await flush();
};
const click = async (element: HTMLElement) => {
  fireEvent.click(element);
  await flush();
};
const history = () =>
  show(
    h(ContentStudioRevisionHistory, {
      packageId: PACKAGE,
      canRestore: true,
      onRestore: async () => true,
      close: () => undefined,
    })
  );
const openVersion = async (n: number) => {
  await history();
  await click(screen.getByRole('button', { name: `View ${n}` }));
};
const dialog = () =>
  screen.getByRole('dialog', {
    name: /Create design from version/,
  }) as HTMLElement;
const openCreate = async (n: number) => {
  await openVersion(n);
  await click(
    screen.getByRole('button', { name: `Create design from version ${n}` })
  );
};
const posts = () =>
  mockFetch.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([url, init]) => ({
      url: url as string,
      body: JSON.parse(init.body),
    }));
const submit = (name: string) =>
  click(within(dialog()).getByRole('button', { name }));

describe('Create design from a saved package version (P6-01)', () => {
  it('F1/F2 a saved version offers Create design, naming exactly that version', async () => {
    await openVersion(4);
    const action = screen.getByRole('button', {
      name: 'Create design from version 4',
    });
    expect(action.textContent).toBe('Create design');
    await click(action);
    expect(dialog().getAttribute('aria-label')).toBe(
      'Create design from version 4'
    );
    expect(dialog().textContent).toContain(
      'The design starts with the text of saved version 4, exactly as saved. Unsaved changes to the draft are not used.'
    );
  });

  it('F4/M14 a version answered with another version’s data starts no design', async () => {
    otherDetail = true;
    await openVersion(3);
    const action = screen.getByRole('button', {
      name: 'Create design from version 3',
    }) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    await click(action);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts()).toEqual([]);
  });

  it('F3/F7/SEC5 an older version starts a design: ids only are sent, never the text, and the new design opens', async () => {
    await openCreate(3);
    await submit('Create design');
    expect(posts()).toEqual([
      {
        url: `/content-studio/packages/${PACKAGE}/revisions/${REV_3}/designs`,
        body: {
          name: 'Design from version 3',
          itemId: 'main',
          canvas: 'square',
        },
      },
    ]);
    expect(JSON.stringify(posts().map((post) => post.body))).not.toMatch(
      /PACKAGE_TEXT_ONLY_SERVER_READS|contentHash|organizationId|"text"|content/
    );
    expect(mockToast).toHaveBeenCalledWith('Design created.', 'success');
    expect(mockCloseAll).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith(
      `/content-studio/designs/${NEW_DESIGN}`
    );
  });

  it('F5 a version with several posts asks which one; a version with one shows it', async () => {
    await openCreate(3);
    const group = within(dialog()).getByRole('group', {
      name: 'Post to start from',
    });
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual(['main', 'second']);
    expect(radios[0].checked).toBe(true);
    await click(radios[1]);
    await submit('Create design');
    expect(posts()[0].body.itemId).toBe('second');
    cleanup();
    mockModals.set([]);
    await openCreate(4);
    expect(
      within(dialog()).queryByRole('group', { name: 'Post to start from' })
    ).toBeNull();
    expect(dialog().textContent).toContain('Version four');
  });

  it('F6 the starting points are the existing ones: a canvas size, a page set, a template', async () => {
    await openCreate(3);
    const start = within(dialog()).getByRole('group', { name: 'Start with' });
    expect(
      within(start)
        .getAllByRole('radio')
        .map((r) => (r as HTMLInputElement).value)
    ).toEqual(['size', 'pageSet', 'template']);
    // the canvas sizes of Creative Studio
    expect(
      within(dialog()).getByRole('group', { name: 'Canvas size' })
    ).toBeTruthy();
    await click(within(dialog()).getByRole('radio', { name: /Story/ }));
    await click(within(start).getByRole('radio', { name: 'A page set' }));
    expect(
      within(dialog()).getByRole('group', { name: 'Page set' })
    ).toBeTruthy();
    expect(
      (
        within(dialog()).getByRole('button', {
          name: 'Create design',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    await click(within(dialog()).getByRole('radio', { name: /Social core/ }));
    await submit('Create design');
    expect(posts()[0].body).toEqual({
      name: 'Design from version 3',
      itemId: 'main',
      pageSetId: 'system:page-set-social-core',
    });
  });

  it('F6 a template goes on to its fields: the package text in the field chosen for it, not editable, the other fields as for any use', async () => {
    await openCreate(3);
    await click(within(dialog()).getByRole('radio', { name: 'A template' }));
    await click(within(dialog()).getByRole('radio', { name: /Square post/ }));
    await submit('Next');
    // the first text field of several lines takes the text by default
    const field = within(dialog()).getByRole('group', {
      name: 'Supporting text',
    });
    expect(field.querySelector('[data-package-text]')!.textContent).toBe(TEXT);
    expect(within(field).queryByRole('textbox')).toBeNull();
    // the person may pick the other text field
    const choice = within(dialog()).getByRole('group', {
      name: 'Field for the text of version 3',
    });
    expect(
      within(choice)
        .getAllByRole('radio')
        .map((r) => (r as HTMLInputElement).value)
    ).toEqual(['headline', 'body']);
    await submit('Create design');
    expect(posts()).toEqual([
      {
        url: `/content-studio/packages/${PACKAGE}/revisions/${REV_3}/designs`,
        body: {
          name: 'Design from version 3',
          itemId: 'main',
          templateSource: 'system',
          templateId: 'system:square-post',
          templateRevisionNumber: 2,
          textSlotId: 'body',
          values: { headline: 'Your headline' },
        },
      },
    ]);
    expect(JSON.stringify(posts())).not.toContain(
      'PACKAGE_TEXT_ONLY_SERVER_READS'
    );
    expect(mockPush).toHaveBeenCalledWith(
      `/content-studio/designs/${NEW_DESIGN}`
    );
  });

  it('MD3/MD4 a package image goes into an image field only when chosen, by its id', async () => {
    await openCreate(3);
    await click(within(dialog()).getByRole('radio', { name: 'A template' }));
    await click(within(dialog()).getByRole('radio', { name: /Photo post/ }));
    await submit('Next');
    expect(dialog().textContent).toContain('The template image is used.');
    await click(
      within(dialog()).getByRole('button', {
        name: 'Use package image 1: Photo',
      })
    );
    expect(dialog().textContent).toContain(
      'An image of the package is chosen.'
    );
    await submit('Create design');
    expect(posts()[0].body).toEqual({
      name: 'Design from version 3',
      itemId: 'main',
      templateSource: 'organization',
      templateId: ORG_TEMPLATE,
      templateRevisionId: ORG_TEMPLATE_REV,
      textSlotId: 'title',
      values: {},
      mediaId: 'm1',
      imageSlotId: 'photo',
    });
  });

  it('a refusal is a fixed message and the form stays open to try again', async () => {
    failCreate = { status: 400, code: 'CS_DESIGN_SOURCE_ITEM_NOT_FOUND' };
    await openCreate(3);
    await submit('Create design');
    expect(mockToast).toHaveBeenCalledWith(
      'The selected post is not part of this version.',
      'warning'
    );
    expect(mockPush).not.toHaveBeenCalled();
    expect(dialog()).toBeTruthy();
    failCreate = { status: 500, code: 'CS_STORED_REVISION_INVALID' };
    await submit('Create design');
    expect(mockToast).toHaveBeenLastCalledWith(
      'This package version could not be read safely.',
      'warning'
    );
  });
});

describe('Where a design came from (P6-01)', () => {
  const source = {
    packageId: PACKAGE,
    packageName: 'Spring launch',
    packageRevisionId: REV_3,
    packageRevisionNumber: 3,
    packageContentHash: '3'.repeat(64),
  };

  it('F8/F9/F10 names the package and exactly its version, linked to that version, never the latest', async () => {
    await show(h(DesignPackageSource, { source }));
    const shown = document.querySelector('[data-design-source]')!;
    expect(shown.textContent).toContain(
      'Created from package: Spring launch · Version 3'
    );
    const link = screen.getByRole('link', {
      name: 'Open source package Version 3',
    });
    expect(link.getAttribute('href')).toBe(
      `/content-studio/${PACKAGE}?revision=${REV_3}`
    );
  });

  it('F9 leaving an edit is asked first, and a refusal stays', async () => {
    const onOpen = jest.fn(async () => false);
    await show(h(DesignPackageSource, { source, onOpen }));
    await click(
      screen.getByRole('link', { name: 'Open source package Version 3' })
    );
    expect(onOpen).toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    onOpen.mockResolvedValueOnce(true);
    await click(
      screen.getByRole('link', { name: 'Open source package Version 3' })
    );
    expect(mockPush).toHaveBeenCalledWith(
      `/content-studio/${PACKAGE}?revision=${REV_3}`
    );
  });
});

describe('P6-01 frontend boundaries', () => {
  // the code, without its comments
  const read = (file: string) =>
    readFileSync(join(__dirname, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');

  it('F4/M14 the form is opened from a saved version with the server’s copy of it, never the draft', () => {
    const history = read('content-studio.revision.history.tsx');
    expect(history).toMatch(
      /detail\.data\?\.id === revision\.id \? detail\.data : null/
    );
    expect(history).toMatch(/thread: saved\.content\.copy\.global\.thread/);
    const form = read('content-studio.design-package.tsx');
    expect(form).not.toMatch(
      /\.draft\b|draftVersion|useContentStudioPackage\(|autosave|latestRevision|flush\(/
    );
  });

  it('F9/M15 the link is built from the exact revision id the server verified', () => {
    const form = read('content-studio.design-package.tsx');
    expect(form).toMatch(/revisionId: source\.packageRevisionId/);
    expect(form).not.toMatch(/latest/i);
    expect(read('content-studio.design.workspace.tsx')).toMatch(
      /<DesignPackageSource source=\{design\.source\}/
    );
  });

  it('P601-1/P5-06 no AI in the flow, and the review queue offers no Create design', () => {
    const form = read('content-studio.design-package.tsx');
    expect(form).not.toMatch(/ai-writing|AIWriting|generate|proposal/i);
    const queue = read('content-studio.review.queue.tsx');
    expect(queue).not.toMatch(/design-package|Create design|createDesignFrom/);
  });
});
