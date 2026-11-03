import React, {
  createElement as h,
  Fragment,
  ReactNode,
  useSyncExternalStore,
} from 'react';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
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

// A .spec.ts without JSX, like the other frontend specs: the frontend
// tsconfig (and so `next build`) skips src/**/*.spec.ts only. Components are
// required, not imported, so the spec type check doesn't follow them into
// files it has no types for; they are type checked with the frontend tsconfig

// --- URL: a small store behind next/navigation; replace/push change it ---
const mockUrl = {
  pathname: '/content-studio',
  params: new URLSearchParams(),
  listeners: new Set<() => void>(),
};
const setUrl = (href: string) => {
  const url = new URL(href, 'https://app.test');
  mockUrl.pathname = url.pathname;
  mockUrl.params = new URLSearchParams(url.search);
  mockUrl.listeners.forEach((listener) => listener());
};
const mockSubscribeUrl = (listener: () => void) => {
  mockUrl.listeners.add(listener);
  return () => mockUrl.listeners.delete(listener);
};
const mockRouter = { replace: jest.fn(), push: jest.fn() };
jest.mock('next/navigation', () => {
  const { useSyncExternalStore: useStore } = require('react');
  return {
    useRouter: () => mockRouter,
    usePathname: () => useStore(mockSubscribeUrl, () => mockUrl.pathname),
    useSearchParams: () => useStore(mockSubscribeUrl, () => mockUrl.params),
  };
});
jest.mock('next/link', () => {
  const { createElement } = require('react');
  return {
    __esModule: true,
    default: ({ href, prefetch, children, ...rest }: any) =>
      createElement('a', { href, ...rest }, children),
  };
});

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

// top.menu's other imports
const mockUser = jest.fn();
jest.mock('@gitroom/frontend/components/layout/user.context', () => ({
  useUser: () => mockUser(),
}));
jest.mock('@gitroom/react/helpers/variable.context', () => ({
  useVariables: () => ({ isGeneral: true, billingEnabled: true }),
}));
jest.mock('@gitroom/frontend/components/layout/agent.media.modal', () => ({
  AgentMediaModal: () => null,
}));

const { ContentStudioHome } = require('./content-studio.home');

// --- server ---
const P_ALPHA = '11111111-1111-4111-8111-111111111111';
const P_BETA = '22222222-2222-4222-8222-222222222222';
const P_OLD = '33333333-3333-4333-8333-333333333333';
const P_GONE = '44444444-4444-4444-8444-444444444444';
const NEW_PACKAGE = 'pkg-new-1';
const project = (id: string, name: string, archived = false) => ({
  id,
  name,
  archivedAt: archived ? '2026-10-01T10:00:00.000Z' : null,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-02T10:00:00.000Z',
});
const pkg = (
  id: string,
  name: string,
  projectId: string | null,
  extra = {}
) => ({
  id,
  name,
  projectId,
  draftVersion: 4,
  latestRevisionNumber: 2,
  archivedAt: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-10-11T09:30:00.000Z',
  ...extra,
});
let activeProjects: any[];
let archivedProjects: any[];
let packageList: { pages: number; results: any[] };
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

const server = (method: string, url: string, body: any) => {
  const custom = override(method, url, body);
  if (custom) {
    return custom;
  }
  const { pathname, searchParams } = new URL(url, 'https://api.test');
  if (method === 'GET' && pathname === '/content-studio/projects') {
    return reply(
      200,
      searchParams.get('archived') === 'true'
        ? archivedProjects
        : activeProjects
    );
  }
  if (method === 'GET' && pathname === '/content-studio/packages') {
    return reply(200, packageList);
  }
  if (method === 'POST' && pathname === '/content-studio/packages') {
    return reply(201, pkg(NEW_PACKAGE, body?.name || 'Untitled package', null));
  }
  if (method === 'POST' && pathname === '/content-studio/projects') {
    return reply(
      201,
      project('55555555-5555-4555-8555-555555555555', body.name)
    );
  }
  const match = pathname.match(
    /^\/content-studio\/(projects|packages)\/([^/]+)(?:\/(archive|restore))?$/
  );
  if (match && (method === 'PATCH' || (method === 'POST' && match[3]))) {
    return reply(200, { id: match[2] });
  }
  return reply(404, { msg: 'no route', code: 'CS_NOT_FOUND' });
};

const calls = () =>
  mockFetch.mock.calls.map(([url, init]) => ({
    method: (init?.method as string) || 'GET',
    url: url as string,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  }));
const gets = (prefix: string) =>
  calls().filter((c) => c.method === 'GET' && c.url.startsWith(prefix));
const writes = () => calls().filter((c) => c.method !== 'GET');
const packageQueries = () =>
  gets('/content-studio/packages?').map((c) => c.url);
const toasts = () => mockToast.mock.calls.map(([text]) => text);

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

const renderHome = (href = '/content-studio') => {
  setUrl(href);
  return render(
    h(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      h(ModalHost),
      h(ContentStudioHome)
    )
  );
};
const loaded = () => screen.findByText('Spring launch');
const dialog = (title: string) => screen.getByRole('dialog', { name: title });
const button = (name: string | RegExp, root: HTMLElement = document.body) =>
  within(root).getByRole('button', { name });

beforeEach(() => {
  window.localStorage.clear();
  // the setup of these organizations is not complete; "Finish later" was
  // chosen on this device, so Home stays Home (first use is tested below)
  window.localStorage.setItem('content-studio-setup-hidden:org', '1');
  mockModals.set([]);
  activeProjects = [project(P_ALPHA, 'Alpha'), project(P_BETA, 'Beta')];
  archivedProjects = [project(P_OLD, 'Old project', true)];
  packageList = {
    pages: 3,
    results: [
      pkg('pkg-1', 'Spring launch', P_ALPHA),
      pkg('pkg-2', 'Loose notes', null, {
        draftVersion: 9,
        latestRevisionNumber: 0,
      }),
      pkg('pkg-3', 'Old campaign', P_OLD),
      pkg('pkg-4', 'Orphan', P_GONE),
    ],
  };
  override = () => undefined;
  mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) =>
    server(
      init.method || 'GET',
      url,
      init.body ? JSON.parse(init.body as string) : undefined
    )
  );
  mockRouter.replace.mockImplementation((href: string) => setUrl(href));
  mockRouter.push.mockImplementation(() => undefined);
  mockOpenModal.mockImplementation((params: Omit<MockModal, 'id'>) =>
    mockModals.set([
      ...mockModals.list,
      { ...params, id: `modal-${++modalId}` },
    ])
  );
  mockConfirm.mockResolvedValue(true);
  mockUser.mockReturnValue({ orgId: 'org', tier: 'PRO', role: 'USER' });
});

afterEach(async () => {
  cleanup();
  await flush();
});

describe('Content Studio home: loading the list', () => {
  it('H1 loads active and archived projects and the first active page, once each', async () => {
    renderHome();
    await loaded();
    await flush();

    expect(
      gets('/content-studio/projects')
        .map((c) => c.url)
        .sort()
    ).toEqual([
      '/content-studio/projects?archived=false',
      '/content-studio/projects?archived=true',
    ]);
    expect(packageQueries()).toEqual([
      '/content-studio/packages?page=1&archived=false',
    ]);
    expect(writes()).toEqual([]);
  });

  it('H2 shows a spinner while the list loads, then the rows', async () => {
    let release!: () => void;
    override = (method, url) =>
      method === 'GET' && url.startsWith('/content-studio/packages?')
        ? new Promise<Reply>((resolve) => {
            release = () => resolve(reply(200, packageList));
          })
        : undefined;
    renderHome();
    await flush();

    // UX review 03: whether setup opens no longer waits for the list; the
    // home page is there and the list shows it is loading
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.queryByText('Spring launch')).toBeNull();
    expect(screen.queryByText(/No content yet/)).toBeNull();
    await act(async () => release());
    await loaded();
  });

  it('H3/H10/H11 rows show name, project (archived and unknown too), date, draft version and revisions', async () => {
    renderHome();
    await loaded();
    await flush();
    // the package rows, not the setup checklist above them
    const rows = screen
      .getAllByRole('listitem')
      .filter((row) => row.textContent?.includes('Draft version'));
    const text = rows.map((row) => row.textContent);

    expect(text[0]).toContain('Spring launch');
    expect(text[0]).toContain('Project: Alpha');
    expect(text[0]).toContain('Draft version: 4');
    expect(text[0]).toContain('Revisions: 2');
    expect(text[0]).toMatch(/Updated: Oct 1[01], 2026/);
    expect(text[1]).toContain('Project: No project');
    expect(text[1]).toContain('Draft version: 9');
    expect(text[1]).toContain('Revisions: 0');
    expect(text[2]).toContain('Project: Old project (Archived)');
    expect(text[3]).toContain('Project: Unavailable project');
    expect(text.join(' ')).not.toContain('undefined');
  });

  it('H4/H5/H6 one list request: no package detail, revision, Media or post request', async () => {
    renderHome();
    await loaded();
    await flush();

    const urls = calls().map((c) => c.url);
    expect(
      urls.filter((u) => /\/content-studio\/packages\/[^?]/.test(u))
    ).toEqual([]);
    expect(
      urls.filter((u) => /revision|handoff|media|\/posts/.test(u))
    ).toEqual([]);
    expect(packageQueries()).toHaveLength(1);
  });

  it('links each row to /content-studio/<id>', async () => {
    renderHome();
    await loaded();
    const links = screen.getAllByRole('link', { name: /^Open / });

    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/content-studio/pkg-1',
      '/content-studio/pkg-2',
      '/content-studio/pkg-3',
      '/content-studio/pkg-4',
    ]);
    expect(
      screen.getByRole('link', { name: 'Spring launch' }).getAttribute('href')
    ).toBe('/content-studio/pkg-1');
  });
});

describe('Content Studio home: filters (URL state)', () => {
  it('H7 choosing a project asks the server for it and goes back to page 1', async () => {
    renderHome('/content-studio?page=2&keep=1');
    await loaded();
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), {
      target: { value: P_BETA },
    });
    await flush();

    expect(mockRouter.replace).toHaveBeenLastCalledWith(
      `/content-studio?keep=1&project=${P_BETA}`,
      { scroll: false }
    );
    expect(packageQueries().pop()).toBe(
      `/content-studio/packages?page=1&archived=false&projectId=${P_BETA}`
    );
  });

  it('H8 the archived view asks for archived=true from page 1 and offers archived projects', async () => {
    renderHome(`/content-studio?project=${P_ALPHA}&page=3`);
    await loaded();
    const select = screen.getByRole('combobox', { name: 'Project' });
    expect(within(select).queryByText('Old project (Archived)')).toBeNull();

    fireEvent.click(button('Archived'));
    await flush();

    expect(mockUrl.params.toString()).toBe(`project=${P_ALPHA}&archived=true`);
    expect(packageQueries().pop()).toBe(
      `/content-studio/packages?page=1&archived=true&projectId=${P_ALPHA}`
    );
    expect(within(select).getByText('Old project (Archived)')).toBeTruthy();
    expect(button('Archived').getAttribute('aria-pressed')).toBe('true');
    expect(button('Active').getAttribute('aria-pressed')).toBe('false');
  });

  it('H9 next and previous pages keep the filters', async () => {
    renderHome(`/content-studio?project=${P_ALPHA}&archived=true`);
    await loaded();
    fireEvent.click(button('Next'));
    await flush();
    expect(packageQueries().pop()).toBe(
      `/content-studio/packages?page=2&archived=true&projectId=${P_ALPHA}`
    );
    fireEvent.click(button('Previous'));
    // page 1 is cached: SWR revalidates it on the next animation frame
    await waitFor(() =>
      expect(packageQueries().pop()).toBe(
        `/content-studio/packages?page=1&archived=true&projectId=${P_ALPHA}`
      )
    );
    expect(mockUrl.params.get('page')).toBeNull();
  });

  it('shows no pager for a single page', async () => {
    packageList.pages = 1;
    renderHome();
    await loaded();
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();
  });

  it.each([
    ['F1 nothing', '', '/content-studio/packages?page=1&archived=false'],
    [
      'F2 a project',
      `project=${P_BETA}`,
      `/content-studio/packages?page=1&archived=false&projectId=${P_BETA}`,
    ],
    [
      'F3 archived',
      'archived=true',
      '/content-studio/packages?page=1&archived=true',
    ],
    ['F4 page 2', 'page=2', '/content-studio/packages?page=2&archived=false'],
    ['F5 page 0', 'page=0', '/content-studio/packages?page=1&archived=false'],
    [
      'F5 page abc',
      'page=abc',
      '/content-studio/packages?page=1&archived=false',
    ],
    ['F5 page -2', 'page=-2', '/content-studio/packages?page=1&archived=false'],
    [
      'F5 page 1.5',
      'page=1.5',
      '/content-studio/packages?page=1&archived=false',
    ],
    [
      'F5 a huge page',
      'page=999999999',
      '/content-studio/packages?page=1&archived=false',
    ],
    [
      'F6 archived=yes',
      'archived=yes',
      '/content-studio/packages?page=1&archived=false',
    ],
    [
      'F6 archived=TRUE',
      'archived=TRUE',
      '/content-studio/packages?page=1&archived=false',
    ],
    [
      'F7 a project that is not a uuid',
      'project=..%2Fposts',
      '/content-studio/packages?page=1&archived=false',
    ],
  ])('%s in the URL', async (_name, query, expected) => {
    renderHome(`/content-studio${query ? `?${query}` : ''}`);
    await loaded();
    expect(packageQueries()[0]).toBe(expected);
  });

  it('F7 an unknown project: fixed message and back to all projects', async () => {
    override = (method, url) =>
      url.includes(`projectId=${P_GONE}`)
        ? reply(404, {
            msg: `Project ${P_GONE} of org-9 missing`,
            code: 'CS_NOT_FOUND',
          })
        : undefined;
    renderHome(`/content-studio?project=${P_GONE}`);
    await loaded();

    expect(toasts()).toEqual(['This project could not be found.']);
    expect(mockUrl.params.get('project')).toBeNull();
    expect(packageQueries().pop()).toBe(
      '/content-studio/packages?page=1&archived=false'
    );
  });

  it('a page past the end moves to the last page, without a loop', async () => {
    renderHome('/content-studio?page=7');
    await loaded();
    await flush();

    expect(mockUrl.params.get('page')).toBe('3');
    expect(packageQueries()).toEqual([
      '/content-studio/packages?page=7&archived=false',
      '/content-studio/packages?page=3&archived=false',
    ]);
  });

  it('an empty result past page 1 goes back to page 1', async () => {
    packageList = { pages: 0, results: [] };
    renderHome('/content-studio?page=2');
    await screen.findByText(
      'No content yet. A package is one post or thread: start one and let AI draft it with you.'
    );
    await flush();
    expect(mockUrl.params.get('page')).toBeNull();
  });

  it('never puts names or content in the URL', async () => {
    renderHome();
    await loaded();
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), {
      target: { value: P_ALPHA },
    });
    fireEvent.click(button('Archived'));
    await flush();
    const hrefs = mockRouter.replace.mock.calls.map(([href]) => href).join(' ');
    expect(hrefs).not.toMatch(/Alpha|Spring|org|draft/);
  });
});

describe('Content Studio home: empty, loading and error states', () => {
  it.each([
    [
      '',
      'No content yet. A package is one post or thread: start one and let AI draft it with you.',
      true,
    ],
    [`project=${P_ALPHA}`, 'No active packages in this project.', true],
    ['archived=true', 'No archived packages.', false],
  ])('empty list (%s)', async (query, text, offersCreate) => {
    packageList = { pages: 0, results: [] };
    // set up skipped: an empty organization would get the assistant
    window.localStorage.setItem('content-studio-setup-hidden:org', '1');
    renderHome(`/content-studio?${query}`);
    await screen.findByText(text);
    // the header button, and one more in the empty state when active
    expect(screen.getAllByRole('button', { name: 'New package' })).toHaveLength(
      offersCreate ? 2 : 1
    );
  });

  it('a failed list shows a fixed message and can be retried', async () => {
    let fail = true;
    override = (method, url) =>
      fail && url.startsWith('/content-studio/packages?')
        ? reply(500, { msg: 'stack trace at org-1' })
        : undefined;
    renderHome();
    await screen.findByText('Could not load Content Studio.');
    expect(document.body.textContent).not.toContain('stack trace');

    fail = false;
    fireEvent.click(button('Try again'));
    await loaded();
  });
});

// UX review 02: a new organization lands in the setup assistant
describe('Content Studio home: first use opens the setup assistant', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it('F1 an organization without content or setup goes straight to the assistant', async () => {
    packageList = { pages: 0, results: [] };
    renderHome();
    await waitFor(() =>
      expect(mockRouter.replace).toHaveBeenCalledWith('/content-studio/setup')
    );
    expect(screen.queryByText(/No content yet/)).toBeNull();
  });

  it('F2 an unfinished assistant is picked up again, even with content', async () => {
    window.localStorage.setItem(
      'content-studio-setup-draft:org',
      JSON.stringify({ v: 1, step: 2 })
    );
    renderHome();
    await flush();
    await flush();
    expect(mockRouter.replace).toHaveBeenCalledWith('/content-studio/setup');
  });

  it('F3 after Finish later or Skip for now, Home stays Home with a quiet Continue setup', async () => {
    packageList = { pages: 0, results: [] };
    window.localStorage.setItem('content-studio-setup-hidden:org', '1');
    window.localStorage.setItem(
      'content-studio-setup-draft:org',
      JSON.stringify({ v: 1, step: 2 })
    );
    renderHome();
    await screen.findByText(/No content yet/);
    await flush();
    expect(mockRouter.replace).not.toHaveBeenCalledWith(
      '/content-studio/setup'
    );
    expect(
      screen.getByRole('link', { name: 'Continue setup' }).getAttribute('href')
    ).toBe('/content-studio/setup');
    expect(screen.queryByText('Welcome to Content Studio')).toBeNull();
  });

  // UX review 03: the phone did not open the assistant the computer did;
  // the organization's own setup decides now, not this browser's draft
  it('F4 an organization with content but an incomplete setup opens the assistant on a device without a draft', async () => {
    renderHome();
    await waitFor(() =>
      expect(mockRouter.replace).toHaveBeenCalledWith('/content-studio/setup')
    );
  });

  it('F5 a filtered or paged home page is never sent to the assistant', async () => {
    renderHome(`/content-studio?project=${P_ALPHA}`);
    await loaded();
    renderHome('/content-studio?page=2');
    await flush();
    expect(mockRouter.replace).not.toHaveBeenCalledWith(
      '/content-studio/setup'
    );
  });
});

describe('Content Studio home: create a package', () => {
  const openCreate = async (href?: string) => {
    renderHome(href);
    await loaded();
    fireEvent.click(screen.getAllByRole('button', { name: 'New package' })[0]);
    return dialog('New package');
  };
  const submit = (modal: HTMLElement) =>
    fireEvent.submit(button('Create', modal).closest('form')!);

  it('CP1/CP2/CP6/CP8 opens; a blank name sends {} and the package opens', async () => {
    const modal = await openCreate();
    submit(modal);
    await flush();

    const posts = writes();
    expect(posts).toEqual([
      { method: 'POST', url: '/content-studio/packages', body: {} },
    ]);
    expect(mockRouter.push).toHaveBeenCalledWith(
      `/content-studio/${NEW_PACKAGE}`
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('CP4/CP7/CP9 a trimmed name and an active project; the list is reloaded', async () => {
    const modal = await openCreate();
    const before = packageQueries().length;
    fireEvent.change(within(modal).getByRole('textbox', { name: 'Name' }), {
      target: { value: '  Autumn launch  ' },
    });
    fireEvent.change(
      within(modal).getByRole('combobox', { name: 'Project (optional)' }),
      {
        target: { value: P_BETA },
      }
    );
    submit(modal);
    await flush();

    expect(writes()).toEqual([
      {
        method: 'POST',
        url: '/content-studio/packages',
        body: { name: 'Autumn launch', projectId: P_BETA },
      },
    ]);
    expect(packageQueries().length).toBeGreaterThan(before);
    expect(mockRouter.push).toHaveBeenCalledWith(
      `/content-studio/${NEW_PACKAGE}`
    );
  });

  it('CP3/CP5 offers no project or active projects only', async () => {
    const modal = await openCreate();
    const options = within(
      within(modal).getByRole('combobox', { name: 'Project (optional)' })
    )
      .getAllByRole('option')
      .map((o) => [o.getAttribute('value'), o.textContent]);

    expect(options).toEqual([
      ['', 'No project'],
      [P_ALPHA, 'Alpha'],
      [P_BETA, 'Beta'],
    ]);
  });

  it('starts on the filtered project when it is active', async () => {
    const modal = await openCreate(`/content-studio?project=${P_ALPHA}`);
    submit(modal);
    await flush();
    expect(writes()[0].body).toEqual({ projectId: P_ALPHA });
  });

  it('never sends an archived project, even if the select is forced to it', async () => {
    const modal = await openCreate(
      `/content-studio?project=${P_OLD}&archived=true`
    );
    const select = within(modal).getByRole('combobox', {
      name: 'Project (optional)',
    }) as HTMLSelectElement;
    const forged = document.createElement('option');
    forged.value = P_OLD;
    select.appendChild(forged);
    fireEvent.change(select, { target: { value: P_OLD } });
    submit(modal);
    await flush();
    expect(writes()[0].body).toEqual({});
  });

  it('CP10/M16 a 409 is a failure: fixed message, modal stays, no navigation', async () => {
    override = (method) =>
      method === 'POST'
        ? reply(409, {
            msg: 'Project 33333333 of org-7 is archived',
            code: 'CS_PROJECT_ARCHIVED',
          })
        : undefined;
    const modal = await openCreate();
    submit(modal);
    await flush();

    expect(toasts()).toEqual(['This project is archived.']);
    expect(JSON.stringify(mockToast.mock.calls)).not.toMatch(/org-7|33333333/);
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(dialog('New package')).toBeTruthy();
    // and the user can try again
    override = () => undefined;
    submit(modal);
    await flush();
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
  });

  it('a network failure is a fixed message too', async () => {
    override = (method) =>
      method === 'POST' ? Promise.reject(new TypeError('offline')) : undefined;
    const modal = await openCreate();
    submit(modal);
    await flush();
    expect(toasts()).toEqual(['Could not update Content Studio.']);
  });

  it('CP11/CP12 two quick submits create one package; the button is disabled while saving', async () => {
    let release!: () => void;
    override = (method) =>
      method === 'POST'
        ? new Promise<Reply>((resolve) => {
            release = () => resolve(reply(201, pkg(NEW_PACKAGE, 'x', null)));
          })
        : undefined;
    const modal = await openCreate();
    submit(modal);
    submit(modal);
    await flush();
    expect(button('Create', modal)).toHaveProperty('disabled', true);
    submit(modal);
    await act(async () => release());
    await flush();

    expect(writes()).toHaveLength(1);
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
  });
});

describe('Content Studio home: projects', () => {
  const openProjects = async (href?: string) => {
    renderHome(href);
    await loaded();
    fireEvent.click(button('Manage projects'));
    const modal = dialog('Manage projects');
    await within(modal).findByText('Old project');
    return modal;
  };

  it('PJ1 lists active and archived projects', async () => {
    const modal = await openProjects();
    expect(button('Rename Alpha', modal)).toBeTruthy();
    expect(button('Archive Beta', modal)).toBeTruthy();
    expect(button('Restore Old project', modal)).toBeTruthy();
    expect(
      within(modal).queryByRole('button', { name: 'Archive Old project' })
    ).toBeNull();
  });

  it('PJ2 a blank name sends nothing', async () => {
    const modal = await openProjects();
    fireEvent.change(
      within(modal).getByRole('textbox', { name: 'New project' }),
      {
        target: { value: '   ' },
      }
    );
    fireEvent.submit(button('Create project', modal).closest('form')!);
    await flush();
    expect(writes()).toEqual([]);
  });

  it('PJ3/PJ10 creates with the trimmed name, reloads projects and clears the input', async () => {
    const modal = await openProjects();
    const before = gets('/content-studio/projects?archived=false').length;
    const input = within(modal).getByRole('textbox', { name: 'New project' });
    fireEvent.change(input, { target: { value: '  Gamma ' } });
    fireEvent.submit(button('Create project', modal).closest('form')!);
    fireEvent.submit(button('Create project', modal).closest('form')!);
    await flush();

    expect(writes()).toEqual([
      {
        method: 'POST',
        url: '/content-studio/projects',
        body: { name: 'Gamma' },
      },
    ]);
    expect(
      gets('/content-studio/projects?archived=false').length
    ).toBeGreaterThan(before);
    expect((input as HTMLInputElement).value).toBe('');
    expect(input.getAttribute('maxlength')).toBe('100');
  });

  it('PJ4/PJ5 renames with exactly the name; blank sends nothing', async () => {
    const modal = await openProjects();
    fireEvent.click(button('Rename Alpha', modal));
    const input = within(modal).getByRole('textbox', { name: 'Project name' });
    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.submit(input.closest('form')!);
    await flush();
    expect(writes()).toEqual([]);

    fireEvent.change(input, { target: { value: ' Alpha two ' } });
    fireEvent.submit(input.closest('form')!);
    await flush();
    expect(writes()).toEqual([
      {
        method: 'PATCH',
        url: `/content-studio/projects/${P_ALPHA}`,
        body: { name: 'Alpha two' },
      },
    ]);
  });

  it('PJ6 archiving asks first, says packages stay, and never touches packages', async () => {
    const modal = await openProjects();
    const packagesBefore = packageQueries().length;
    fireEvent.click(button('Archive Alpha', modal));
    await flush();

    expect(mockConfirm).toHaveBeenCalledWith(
      'Archive this project? Packages in it will remain available.',
      'Archive',
      'Archive project',
      'Cancel'
    );
    expect(writes()).toEqual([
      {
        method: 'POST',
        url: `/content-studio/projects/${P_ALPHA}/archive`,
        body: undefined,
      },
    ]);
    expect(writes().some((c) => c.url.includes('/packages'))).toBe(false);
    expect(packageQueries()).toHaveLength(packagesBefore);
    expect(
      gets('/content-studio/projects?archived=true').length
    ).toBeGreaterThan(1);
    // its package is still listed, under the archived project's name
    const row = screen.getByText('Spring launch').closest('li')!;
    expect(row.textContent).toContain('Project: Alpha');
  });

  it('archiving needs the confirmation', async () => {
    mockConfirm.mockResolvedValue(false);
    const modal = await openProjects();
    fireEvent.click(button('Archive Beta', modal));
    await flush();
    expect(writes()).toEqual([]);
  });

  it('PJ7 archiving the filtered project goes back to all projects', async () => {
    const modal = await openProjects(`/content-studio?project=${P_ALPHA}&x=1`);
    fireEvent.click(button('Archive Alpha', modal));
    await flush();
    expect(mockUrl.params.toString()).toBe('x=1');
    expect(packageQueries().pop()).toBe(
      '/content-studio/packages?page=1&archived=false'
    );
  });

  it('archiving another project keeps the filter', async () => {
    const modal = await openProjects(`/content-studio?project=${P_ALPHA}`);
    fireEvent.click(button('Archive Beta', modal));
    await flush();
    expect(mockUrl.params.get('project')).toBe(P_ALPHA);
  });

  it('PJ8 restores without a confirmation', async () => {
    const modal = await openProjects();
    fireEvent.click(button('Restore Old project', modal));
    await flush();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(writes()).toEqual([
      {
        method: 'POST',
        url: `/content-studio/projects/${P_OLD}/restore`,
        body: undefined,
      },
    ]);
  });

  it('PJ9 a failed write shows a fixed message only', async () => {
    override = (method) =>
      method !== 'GET'
        ? reply(409, { msg: 'raw detail org-3', code: 'CS_PROJECT_ARCHIVED' })
        : undefined;
    const modal = await openProjects();
    fireEvent.click(button('Rename Alpha', modal));
    const input = within(modal).getByRole('textbox', { name: 'Project name' });
    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.submit(input.closest('form')!);
    await flush();

    expect(toasts()).toEqual(['This project is archived.']);
    expect(JSON.stringify(mockToast.mock.calls)).not.toContain('raw detail');
    // still editing
    expect(
      within(modal).getByRole('textbox', { name: 'Project name' })
    ).toBeTruthy();
  });
});

describe('Content Studio home: package archive and restore', () => {
  it('PA1/PA3 active rows archive after confirmation and the list reloads', async () => {
    renderHome();
    await loaded();
    expect(screen.queryByRole('button', { name: /^Restore / })).toBeNull();
    const before = packageQueries().length;
    fireEvent.click(button('Archive Spring launch'));
    await flush();

    expect(mockConfirm).toHaveBeenCalledWith(
      'Archive this package?',
      'Archive',
      'Archive package',
      'Cancel'
    );
    expect(writes()).toEqual([
      {
        method: 'POST',
        url: '/content-studio/packages/pkg-1/archive',
        body: undefined,
      },
    ]);
    expect(packageQueries().length).toBeGreaterThan(before);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('PA4 a cancelled confirmation sends nothing', async () => {
    mockConfirm.mockResolvedValue(false);
    renderHome();
    await loaded();
    fireEvent.click(button('Archive Spring launch'));
    await flush();
    expect(writes()).toEqual([]);
  });

  it('PA2/PA5 archived rows restore without a confirmation', async () => {
    packageList = {
      pages: 1,
      results: [
        pkg('pkg-1', 'Spring launch', P_ALPHA, {
          archivedAt: '2026-10-05T10:00:00.000Z',
        }),
      ],
    };
    renderHome('/content-studio?archived=true');
    await loaded();
    expect(screen.queryByRole('button', { name: /^Archive / })).toBeNull();
    const before = packageQueries().length;
    fireEvent.click(button('Restore Spring launch'));
    await flush();

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(writes()).toEqual([
      {
        method: 'POST',
        url: '/content-studio/packages/pkg-1/restore',
        body: undefined,
      },
    ]);
    expect(packageQueries().length).toBeGreaterThan(before);
  });

  it('a failed archive shows a fixed message', async () => {
    override = (method) =>
      method === 'POST'
        ? reply(404, { msg: 'pkg-1 in org-2', code: 'CS_NOT_FOUND' })
        : undefined;
    renderHome();
    await loaded();
    fireEvent.click(button('Archive Spring launch'));
    await flush();
    expect(toasts()).toEqual(['This Content Studio item could not be found.']);
  });
});

describe('Content Studio: every request', () => {
  it('PA6-PA8/CP8/PJ10 uses project and package endpoints only, without ids of the organization or user', async () => {
    renderHome();
    await loaded();
    fireEvent.click(button('Archive Spring launch'));
    await flush();
    fireEvent.click(button('Manage projects'));
    const modal = dialog('Manage projects');
    await within(modal).findByText('Old project');
    fireEvent.click(button('Restore Old project', modal));
    await flush();

    // the setup card only reads what is set up, without ids; the getting
    // started list (activation flow 01) the first post and the designs; what
    // needs attention (activation review 02) the reviews waiting
    const all = calls();
    const setupReads = all.filter((call) =>
      /^\/content-studio\/(ai\/providers|ai\/connections|brand-kit|writing-profiles|audience-profiles|expertise-profiles|editorial-policy|sources|activation\/first-post|designs|reviews)(\?|$)/.test(
        call.url
      )
    );
    for (const call of setupReads) {
      expect(call.method).toBe('GET');
    }
    for (const call of all.filter((c) => !setupReads.includes(c))) {
      expect(['GET', 'POST', 'PATCH']).toContain(call.method);
      expect(call.url).toMatch(
        /^\/content-studio\/(projects|packages)(\?|\/|$)/
      );
      expect(call.url).not.toMatch(/draft|revision|handoff|organization|user/i);
      expect(JSON.stringify(call.body ?? {})).not.toMatch(
        /organization|user|draft|content/i
      );
    }
  });
});

describe('Content Studio: routes and navigation', () => {
  const app = join(__dirname, '../../app/(app)/(site)/content-studio');

  it('has the /content-studio page; /content-studio/[id] is the workspace', () => {
    const home = readFileSync(join(app, 'page.tsx'), 'utf8');
    const workspace = readFileSync(join(app, '[id]/page.tsx'), 'utf8');
    expect(home).toContain('return <ContentStudioHome />;');
    // P5-06: with the exact version a review links to; P8-03: and the
    // research sources a research link names
    expect(workspace).toMatch(
      /<ContentStudioWorkspace\s+key=\{id\}\s+packageId=\{id\}\s+linkedRevisionId=\{linked\}\s+researchSources=\{research\}\s+\/>/
    );
    expect(workspace).not.toMatch(/fetch|useSWR|Placeholder/);
    expect(
      existsSync(join(__dirname, 'content-studio.workspace.placeholder.tsx'))
    ).toBe(false);
  });

  it('M12 the menu has Content Studio once, after Launches, with no extra gate', () => {
    const {
      useMenuItem,
    } = require('@gitroom/frontend/components/layout/top.menu');
    let menu!: { all: any[]; firstMenu: any[] };
    const Probe = () => {
      menu = useMenuItem();
      return null;
    };
    render(h(Probe));

    const entries = menu.all.filter((item) => item.path === '/content-studio');
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Content Studio');
    expect(entries[0].role).toBeUndefined();
    expect(entries[0].requireBilling).toBeUndefined();
    expect(entries[0].hide).toBeUndefined();
    expect(menu.firstMenu.map((item) => item.path).slice(0, 2)).toEqual([
      '/launches',
      '/content-studio',
    ]);
  });

  it('renders one Content Studio link for a regular user, active on /content-studio/<id>', () => {
    const { TopMenu } = require('@gitroom/frontend/components/layout/top.menu');
    setUrl('/content-studio/pkg-1');
    render(h(TopMenu));
    const links = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href') === '/content-studio');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('title')).toBe('Content Studio');
    expect(links[0].className).toContain('bg-boxFocused');
  });
});

describe('Content Studio home: source surface', () => {
  const dir = __dirname;
  // the home and its modals; the workspace has its own checks
  const HOME_FILES = [
    'content-studio.home.tsx',
    'content-studio.package.list.tsx',
    'content-studio.package.modal.tsx',
    'content-studio.projects.modal.tsx',
  ];
  const sources = readdirSync(dir)
    .filter((file) => HOME_FILES.includes(file))
    .map((file) => [file, readFileSync(join(dir, file), 'utf8')] as const);

  it('stays away from the composer, handoffs, Media, Prisma and AI', () => {
    expect(sources.map(([file]) => file).sort()).toEqual(
      [...HOME_FILES].sort()
    );
    for (const [, source] of sources) {
      expect(source).not.toMatch(
        /new-launch\/store|add\.edit\.modal|handoff|@prisma\/client|media\.component|media\.service|launches\/ai|openai|copilot/i
      );
      expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML/);
      expect(source).not.toMatch(
        /process\.env|localStorage|sessionStorage|console\./
      );
      expect(source).not.toMatch(/organizationId|orgId|userId/);
      expect(source).not.toMatch(/'DELETE'|"DELETE"/);
    }
  });

  it('requests only project and package endpoints', () => {
    const urls = sources.flatMap(([, source]) =>
      Array.from(source.matchAll(/['`](\/content-studio[^'`]*)['`]/g)).map(
        (m) => m[1]
      )
    );
    for (const url of urls) {
      expect(url).toMatch(/^\/content-studio(\/(projects|packages))?($|\?|\/)/);
    }
    expect(urls.join(' ')).not.toMatch(/revision|handoff|draft/);
  });

  it('the route pages are thin', () => {
    expect(
      existsSync(join(dir, '../../app/(app)/(site)/content-studio/page.tsx'))
    ).toBe(true);
  });
});

// UX review 03: on an iPhone Content Studio looked zoomed in. iOS Safari zooms
// into a focused field under 16px and stays there; zooming is never turned
// off to hide it
describe('Content Studio: phones and tablets', () => {
  const app = join(__dirname, '../../app');

  it('M6 gives every field 16px on a touch or small screen while Content Studio is open, dialogs included', () => {
    const css = readFileSync(join(app, 'global.scss'), 'utf8');
    const rule = css.slice(
      css.indexOf('@media (pointer: coarse), (max-width: 1025px)')
    );
    expect(rule).toMatch(
      /^@media \(pointer: coarse\), \(max-width: 1025px\) \{/
    );
    for (const field of ['input:not', 'select', 'textarea']) {
      expect(rule).toContain(`html.content-studio-open ${field}`);
    }
    expect(rule.slice(0, rule.indexOf('}'))).toContain('font-size: 16px');
    const layout = readFileSync(
      join(app, '(app)/(site)/content-studio/layout.tsx'),
      'utf8'
    );
    expect(layout).toContain('<ContentStudioDocumentClass />');
  });

  it('M7 marks the document only while Content Studio is open', () => {
    const { ContentStudioDocumentClass } = require('./content-studio.shell');
    const { unmount } = render(h(ContentStudioDocumentClass));
    expect(
      document.documentElement.classList.contains('content-studio-open')
    ).toBe(true);
    unmount();
    expect(
      document.documentElement.classList.contains('content-studio-open')
    ).toBe(false);
  });

  it('M8 never turns zooming off', () => {
    const layouts = [
      'layout.tsx',
      '(app)/layout.tsx',
      '(app)/(site)/layout.tsx',
      '(app)/(site)/content-studio/layout.tsx',
    ]
      .map((file) => join(app, file))
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(layouts).not.toMatch(/maximum-?scale|user-?scalable/i);
  });
});

// Activation review 02: Home says what needs the user, not where the
// sections are (the navigation above does), and the navigation is the row
// of pills the Settings page uses
describe('Content Studio home: what needs attention, not a second menu', () => {
  const T0 = '2026-10-30T10:00:00.000Z';
  const list = (n: number) => ({
    pages: n ? 1 : 0,
    results: Array.from({ length: n }, (_, i) => ({
      id: `id-${i}`,
      name: `n${i}`,
      latestRevisionNumber: 1,
      archivedAt: null,
      createdAt: T0,
      updatedAt: T0,
    })),
  });
  const firstPostState = (
    packageId: string | null,
    activated = false,
    // saved in the composer as a draft
    saved = false
  ) => ({
    packageId,
    package: packageId
      ? { name: 'First post', draftVersion: 2, archived: false, text: 'x' }
      : null,
    research: null,
    draft: null,
    alternatives: [],
    firstPost: {
      scheduled: activated,
      published: false,
      savedAsDraft: saved
        ? {
            publishDate: '2026-11-25T07:20:00.000Z',
            group: 'group-1',
            createdAt: T0,
          }
        : null,
    },
    activated,
  });
  // a set-up organization, with its first post and reviews as asked
  const organization = (input: {
    firstPost: ReturnType<typeof firstPostState>;
    reviews?: number;
  }) => {
    override = (method, url) => {
      const { pathname } = new URL(url, 'https://api.test');
      if (method !== 'GET') {
        return undefined;
      }
      switch (pathname) {
        case '/content-studio/ai/providers':
          return reply(200, [
            {
              provider: 'codex',
              displayName: 'Codex',
              credentialFields: [],
              defaultModel: 'gpt-6.1-sol',
              models: [],
            },
          ]);
        case '/content-studio/ai/connections':
          return reply(200, [
            {
              id: '44444444-4444-4444-8444-444444444444',
              name: 'Codex',
              provider: 'codex',
              defaultModel: 'gpt-6.1-sol',
              disabled: false,
              credentialPresent: true,
              credentialUpdatedAt: T0,
              lastValidatedAt: T0,
              lastValidationStatus: 'valid',
              lastValidationCode: null,
              createdAt: T0,
              updatedAt: T0,
            },
          ]);
        case '/content-studio/brand-kit':
          return reply(200, {
            latestRevisionNumber: 1,
            currentRevision: {
              content: {
                identity: { brandName: 'A', tagline: '', description: 'd' },
              },
            },
          });
        case '/content-studio/editorial-policy':
          return reply(200, {
            latestRevisionNumber: 1,
            currentRevision: { content: { schemaVersion: 1 } },
          });
        case '/content-studio/writing-profiles':
        case '/content-studio/audience-profiles':
        case '/content-studio/expertise-profiles':
          return reply(200, list(1));
        case '/content-studio/sources':
        case '/content-studio/designs':
          return reply(200, list(0));
        case '/content-studio/activation/first-post':
          return reply(200, input.firstPost);
        case '/content-studio/reviews':
          return reply(200, {
            pages: input.reviews ? 1 : 0,
            results: Array.from({ length: input.reviews ?? 0 }, (_, i) => ({
              id: `review-${i}`,
              targetType: 'PACKAGE_REVISION',
              targetRevisionId: `rev-${i}`,
              targetRevisionNumber: 1,
              target: {
                type: 'PACKAGE_REVISION',
                revisionId: `rev-${i}`,
                revisionNumber: 1,
                parentId: 'pkg',
                parentName: 'A post',
              },
            })),
          });
      }
      return undefined;
    };
  };
  const attention = (key: string) =>
    document.querySelector(`[data-attention="${key}"]`) as HTMLElement | null;

  it('H1 repeats no section of the navigation as a card', async () => {
    renderHome();
    await loaded();
    const nav = screen.getByRole('navigation', { name: 'Content Studio' });
    for (const name of ['Knowledge', 'Radar', 'Creative Studio', 'Approvals']) {
      // only the navigation links there
      expect(screen.getAllByRole('link', { name })).toEqual([
        within(nav).getByRole('link', { name }),
      ]);
    }
    expect(
      screen.queryByText('The websites and feeds Content Studio writes from.')
    ).toBeNull();
  });

  it('H2 leads with the first post while it is not out yet, and with reviews waiting', async () => {
    organization({ firstPost: firstPostState('pkg-first'), reviews: 2 });
    renderHome();
    await loaded();
    await flush();
    const first = attention('first_post') as HTMLElement;
    expect(within(first).getByText('Your first post is waiting')).toBeTruthy();
    expect(
      within(first)
        .getByRole('link', { name: 'Open your first post' })
        .getAttribute('href')
    ).toBe('/content-studio/first-post');
    const reviews = attention('reviews') as HTMLElement;
    expect(within(reviews).getByText(/waiting for review/)).toBeTruthy();
    expect(
      within(reviews)
        .getByRole('link', { name: 'Open approvals' })
        .getAttribute('href')
    ).toBe('/content-studio/reviews');
  });

  it('H2 an organization that already makes content is not asked to start a first post; a new one is', async () => {
    organization({ firstPost: firstPostState(null) });
    renderHome();
    await loaded();
    await flush();
    expect(attention('first_post')).toBeNull();
    cleanup();
    packageList = { pages: 0, results: [] };
    renderHome();
    await screen.findByText(/No content yet/);
    await flush();
    expect(
      within(attention('first_post') as HTMLElement).getByText(
        'Create your first post'
      )
    ).toBeTruthy();
  });

  it('H2 nothing waits: nothing is shown, no made-up numbers', async () => {
    organization({ firstPost: firstPostState('pkg-first', true), reviews: 0 });
    window.localStorage.setItem('content-studio-tour:org', '1');
    renderHome();
    await loaded();
    await flush();
    expect(attention('first_post')).toBeNull();
    expect(attention('reviews')).toBeNull();
  });

  it('D6/B9/B18 a first post saved as a draft: Home leads with the reminder to schedule that post, then the list; no second first-post item', async () => {
    organization({ firstPost: firstPostState('pkg-first', false, true) });
    window.localStorage.setItem('content-studio-tour:org', 'completed');
    renderHome();
    await loaded();
    await flush();
    const reminder = screen.getByTestId('first-post-reminder');
    expect(
      within(reminder).getByText('Your first post is still waiting')
    ).toBeTruthy();
    expect(
      within(reminder)
        .getByRole('link', { name: 'Review and schedule' })
        .getAttribute('href')
    ).toBe('/launches?post=group-1&return=first-post');
    expect(attention('first_post')).toBeNull();
    const list = screen.getByText('Get more out of Content Studio');
    // the reminder comes first
    expect(
      reminder.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('H3 after the first post is out, the checklist is on Home', async () => {
    organization({ firstPost: firstPostState('pkg-first', true) });
    window.localStorage.setItem('content-studio-tour:org', '1');
    renderHome();
    await loaded();
    await flush();
    expect(screen.getByText('Get more out of Content Studio')).toBeTruthy();
  });
});

describe('Content Studio: the section navigation', () => {
  const shellSource = readFileSync(
    join(__dirname, 'content-studio.shell.tsx'),
    'utf8'
  );

  it('T1 follows the Settings tabs: a row of pills that scrolls sideways', () => {
    const settings = readFileSync(
      join(__dirname, '../layout/settings.component.tsx'),
      'utf8'
    );
    for (const token of [
      'overflow-x-auto',
      'shrink-0 whitespace-nowrap rounded-full',
      'bg-[var(--brand-primary',
    ]) {
      expect(settings).toContain(token);
      expect(shellSource).toContain(token);
    }
  });

  it('T2/T4 one row that scrolls on a phone instead of wrapping onto a second line', async () => {
    renderHome();
    await loaded();
    const nav = screen.getByRole('navigation', { name: 'Content Studio' });
    expect(nav.className).toContain('overflow-x-auto');
    expect(nav.className).not.toContain('flex-wrap');
    for (const link of within(nav).getAllByRole('link')) {
      expect(link.className).toContain('whitespace-nowrap');
      expect(link.className).toContain('shrink-0');
    }
  });

  it('T3/T5 the current section is filled with the brand colour, marked for assistive tech and reachable by keyboard', async () => {
    renderHome();
    await loaded();
    const nav = screen.getByRole('navigation', { name: 'Content Studio' });
    const links = within(nav).getAllByRole('link');
    const current = links.filter(
      (link) => link.getAttribute('aria-current') === 'page'
    );
    expect(current.map((link) => link.textContent)).toEqual(['Home']);
    expect(current[0].className).toContain('bg-[var(--brand-primary,#612ad5)]');
    for (const link of links) {
      expect(link.getAttribute('href')).toBeTruthy();
      expect(link.className).toContain('focus-visible:outline');
    }
    expect(
      links.filter((link) => link !== current[0]).map((l) => l.className)
    ).not.toContainEqual(expect.stringContaining('bg-[var(--brand-primary'));
  });
});
