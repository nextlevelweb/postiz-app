import {
  createElement as h,
  Fragment,
  ReactNode,
  useSyncExternalStore,
} from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { SWRConfig } from 'swr';

// Research into content (P8-03): "Use in content" on a News Radar row and on
// a web page's own page opens the New package dialog; only its Create makes
// a package, exactly as before, and the package opens with the page named in
// its link for AI writing. The Source Library searches on the server. A
// .spec.ts without JSX like the other Content Studio frontend specs; the
// server is an in-memory fake

const mockUrl = { search: '', listeners: new Set<() => void>() };
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn((url: string) => {
    mockUrl.search = url.includes('?') ? url.split('?')[1] : '';
    mockUrl.listeners.forEach((listener) => listener());
  }),
};
jest.mock('next/navigation', () => {
  const { useSyncExternalStore: useStore } = require('react');
  return {
    useRouter: () => mockRouter,
    usePathname: () => '/content-studio/research',
    useSearchParams: () =>
      new URLSearchParams(
        useStore(
          (listener: () => void) => {
            mockUrl.listeners.add(listener);
            return () => mockUrl.listeners.delete(listener);
          },
          () => mockUrl.search
        )
      ),
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
const mockOpenModal = jest.fn((params: Omit<MockModal, 'id'>) =>
  mockModals.set([...mockModals.list, { ...params, id: `m-${++modalId}` }])
);
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
jest.mock('@gitroom/react/helpers/delete.dialog', () => ({
  deleteDialog: async () => true,
}));
jest.mock('@gitroom/react/toaster/toaster', () => ({
  useToaster: () => ({ show: jest.fn() }),
}));
const mockFetch = jest.fn();
jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));
jest.mock('@gitroom/react/translation/get.transation.service.client', () => ({
  useT: () => (key: string, fallback?: string) => fallback ?? key,
}));

const { ContentStudioResearch } = require('./content-studio.research');
const { ContentStudioSourceDetail } = require('./content-studio.source.detail');
const { ContentStudioSources } = require('./content-studio.sources');

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const T1 = '2026-10-20T08:00:00.000Z';
const FEED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LIVE = '00000001-0000-4000-8000-000000000000';
const ARCHIVED = '00000002-0000-4000-8000-000000000000';
const UNCAPTURED = '00000003-0000-4000-8000-000000000000';
const NEW_PACKAGE = '99999999-9999-4999-8999-999999999999';

const summary = (
  id: string,
  name: string,
  extra: Record<string, unknown> = {}
) => ({
  id,
  kind: 'url',
  name,
  canonicalUrl: `https://${name
    .toLowerCase()
    .replace(/\W+/g, '-')}.example.com/a?token=PRIVATE`,
  latestVersionNumber: 2,
  archivedAt: null,
  createdAt: T1,
  updatedAt: T1,
  lastCapturedAt: null,
  ...extra,
});
const feed = summary(FEED, 'Daily feed', {
  kind: 'feed',
  latestVersionNumber: 0,
  canonicalUrl: 'https://daily.example.com/rss',
  lastCapturedAt: T1,
});
const discovery = (source: ReturnType<typeof summary>, n: number) => ({
  id: `d000000${n}-0000-4000-8000-000000000000`,
  entryTitle: `Entry ${source.name}`,
  publishedAt: T1,
  firstSeenAt: T1,
  lastSeenAt: T1,
  feed: { id: FEED, name: 'Daily feed' },
  source: {
    id: source.id,
    name: source.name,
    canonicalUrl: source.canonicalUrl,
    latestVersionNumber: source.latestVersionNumber,
    archivedAt: source.archivedAt,
  },
});

let library: ReturnType<typeof summary>[];
let details: Record<string, ReturnType<typeof summary>>;

const server = (method: string, url: string): Reply => {
  const { pathname, searchParams } = new URL(url, 'https://api.test');
  if (method === 'POST' && pathname === '/content-studio/packages') {
    return reply(200, {
      id: NEW_PACKAGE,
      name: 'Untitled package',
      projectId: null,
    });
  }
  if (method !== 'GET') {
    return reply(404, { msg: 'Not found.', code: 'CS_NOT_FOUND' });
  }
  if (pathname === '/content-studio/projects') {
    return reply(200, []);
  }
  if (pathname === '/content-studio/discoveries') {
    const rows = [details[LIVE], details[ARCHIVED], details[UNCAPTURED]].map(
      discovery
    );
    return reply(200, { pages: 1, total: rows.length, results: rows });
  }
  // like the server: one kind when named, a search over the name and the
  // URL in any case, 20 a page
  if (pathname === '/content-studio/sources') {
    const archived = searchParams.get('archived') === 'true';
    const kind = searchParams.get('kind');
    const search = (searchParams.get('search') || '').toLowerCase();
    const page = Number(searchParams.get('page') || 1);
    const matching = [feed, ...library].filter(
      (s) =>
        !!s.archivedAt === archived &&
        (!kind || s.kind === kind) &&
        (!search ||
          s.name.toLowerCase().includes(search) ||
          (s.canonicalUrl || '').toLowerCase().includes(search))
    );
    return reply(200, {
      pages: Math.ceil(matching.length / 20),
      results: matching.slice((page - 1) * 20, page * 20),
    });
  }
  const one = pathname.match(/^\/content-studio\/sources\/([^/]+)$/);
  if (one) {
    const source = details[one[1]] ?? (one[1] === FEED ? feed : undefined);
    return source
      ? reply(200, { ...source, currentVersion: null })
      : reply(404, { msg: 'Source not found.', code: 'CS_NOT_FOUND' });
  }
  if (/\/versions$|\/discoveries$/.test(pathname)) {
    return reply(200, { pages: 0, total: 0, results: [] });
  }
  return reply(404, { msg: 'Not found.', code: 'CS_NOT_FOUND' });
};

const requests = () =>
  mockFetch.mock.calls.map(([url, init]) => ({
    method: (init?.method as string) || 'GET',
    url: url as string,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  }));
const writes = () => requests().filter((r) => r.method !== 'GET');
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
const mount = async (element: ReturnType<typeof h>) => {
  render(
    h(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      h(ModalHost),
      element
    )
  );
  await flush();
};
const useButtons = () =>
  screen.queryAllByRole('button', { name: 'Use in content' });
const dialog = () => screen.getByRole('dialog', { name: 'New package' });

beforeEach(() => {
  mockUrl.search = '';
  mockModals.list = [];
  mockRouter.push.mockClear();
  mockRouter.replace.mockClear();
  mockOpenModal.mockClear();
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) =>
    server(init.method || 'GET', url)
  );
  details = {
    [LIVE]: summary(LIVE, 'Live page'),
    [ARCHIVED]: summary(ARCHIVED, 'Archived page', { archivedAt: T1 }),
    [UNCAPTURED]: summary(UNCAPTURED, 'Uncaptured page', {
      latestVersionNumber: 0,
    }),
  };
  library = Object.values(details);
});
afterEach(cleanup);

describe('Research into content: News Radar', () => {
  const rowOf = (name: string) =>
    screen.getByText(`Entry ${name}`).closest('li') as HTMLElement;

  it('RH1-RH3/M24/M25 offers Use in content on a live captured page only', async () => {
    await mount(h(ContentStudioResearch));
    expect(
      within(rowOf('Live page')).getByRole('button', { name: 'Use in content' })
    ).toBeTruthy();
    expect(
      within(rowOf('Archived page')).queryByRole('button', {
        name: 'Use in content',
      })
    ).toBeNull();
    expect(
      within(rowOf('Uncaptured page')).queryByRole('button', {
        name: 'Use in content',
      })
    ).toBeNull();
    expect(useButtons()).toHaveLength(1);
  });

  it('RH4/RH5/M16 the click only opens the New package dialog: nothing is written or asked of the AI', async () => {
    await mount(h(ContentStudioResearch));
    fireEvent.click(useButtons()[0]);
    await flush();
    expect(dialog()).toBeTruthy();
    expect(
      within(dialog()).getByRole('button', { name: 'Create' })
    ).toBeTruthy();
    expect(writes()).toEqual([]);
    expect(requests().filter((r) => /\/ai\/|\/packages/.test(r.url))).toEqual(
      []
    );
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('RH6 Cancel creates nothing', async () => {
    await mount(h(ContentStudioResearch));
    fireEvent.click(useButtons()[0]);
    await flush();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes()).toEqual([]);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('RH7/RH8/M17/M26 Create sends the usual package body only, then opens the package with the page for AI writing', async () => {
    await mount(h(ContentStudioResearch));
    fireEvent.click(useButtons()[0]);
    await flush();
    fireEvent.change(within(dialog()).getByRole('textbox', { name: 'Name' }), {
      target: { value: '  Launch notes  ' },
    });
    fireEvent.submit(
      within(dialog()).getByRole('button', { name: 'Create' }).closest('form')!
    );
    await flush();
    expect(writes()).toEqual([
      {
        method: 'POST',
        url: '/content-studio/packages',
        body: { name: 'Launch notes' },
      },
    ]);
    expect(mockRouter.push.mock.calls).toEqual([
      [`/content-studio/${NEW_PACKAGE}?sources=${LIVE}`],
    ]);
    // nothing more: no AI request, no second write
    expect(requests().filter((r) => /\/ai\//.test(r.url))).toEqual([]);
  });

  it('a page found by a feed offers it on the feed page as well (the shared row)', async () => {
    await mount(h(ContentStudioSourceDetail, { sourceId: FEED }));
    // the feed itself never: it is no source material
    expect(useButtons()).toEqual([]);
  });
});

describe('Research into content: a source page', () => {
  it('SD1/SD5 a live captured web page offers it, through the same dialog and path', async () => {
    await mount(h(ContentStudioSourceDetail, { sourceId: LIVE }));
    expect(useButtons()).toHaveLength(1);
    fireEvent.click(useButtons()[0]);
    await flush();
    expect(writes()).toEqual([]);
    fireEvent.submit(
      within(dialog()).getByRole('button', { name: 'Create' }).closest('form')!
    );
    await flush();
    expect(writes()).toEqual([
      { method: 'POST', url: '/content-studio/packages', body: {} },
    ]);
    expect(mockRouter.push.mock.calls).toEqual([
      [`/content-studio/${NEW_PACKAGE}?sources=${LIVE}`],
    ]);
  });

  it.each([
    ['SD2 a feed', FEED],
    ['SD3 an archived page', ARCHIVED],
    ['SD4 a page without a captured version', UNCAPTURED],
  ])('%s does not offer it', async (_, id) => {
    await mount(h(ContentStudioSourceDetail, { sourceId: id }));
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expect(useButtons()).toEqual([]);
  });

  it('M25b a feed is never offered, even one that claims a version', async () => {
    details[FEED] = { ...feed, latestVersionNumber: 3 };
    await mount(h(ContentStudioSourceDetail, { sourceId: FEED }));
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expect(useButtons()).toEqual([]);
  });
});

describe('Research into content: the Source Library', () => {
  const listGets = () =>
    requests()
      .filter((r) => r.url.startsWith('/content-studio/sources?'))
      .map((r) => r.url);
  const search = async (text: string) => {
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Name or address' }),
      {
        target: { value: text },
      }
    );
    fireEvent.submit(screen.getByRole('search'));
    await flush();
  };
  beforeEach(() => {
    library = [
      ...Array.from({ length: 44 }, (_, i) =>
        summary(
          `e${String(i).padStart(7, '0')}-1111-4111-8111-111111111111`,
          `Found page ${i + 1}`
        )
      ),
      summary(LIVE, 'Curated Brief'),
      summary(ARCHIVED, 'Old Brief', { archivedAt: T1 }),
    ];
  });

  it('SL1/SL3/SL4 finds a source beyond the first page by name, in any case, from page 1', async () => {
    await mount(h(ContentStudioSources));
    expect(screen.queryByText('Curated Brief')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await flush();
    expect(listGets().at(-1)).toBe(
      '/content-studio/sources?page=2&archived=false'
    );
    await search('  curated BRIEF ');
    expect(listGets().at(-1)).toBe(
      '/content-studio/sources?page=1&archived=false&search=curated%20BRIEF'
    );
    expect(screen.getByText('Curated Brief')).toBeTruthy();
    expect(screen.queryByText('Found page 1')).toBeNull();
  });

  it('SL2 finds a source by a part of its address', async () => {
    await mount(h(ContentStudioSources));
    await search('curated-brief.example');
    expect(screen.getByText('Curated Brief')).toBeTruthy();
  });

  it('SL5 without a search the list is the one it was', async () => {
    await mount(h(ContentStudioSources));
    expect(listGets()).toEqual([
      '/content-studio/sources?page=1&archived=false',
    ]);
    await search('   ');
    expect(listGets()).toEqual([
      '/content-studio/sources?page=1&archived=false',
    ]);
  });

  it('SL6 says so when nothing matches', async () => {
    await mount(h(ContentStudioSources));
    await search('nothing like this');
    expect(screen.getByText('No sources match this search.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add source' })).toBeTruthy();
  });

  it('SL7 the search keeps to the status shown', async () => {
    await mount(h(ContentStudioSources));
    await search('brief');
    expect(screen.getByText('Curated Brief')).toBeTruthy();
    expect(screen.queryByText('Old Brief')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    await flush();
    expect(listGets().at(-1)).toBe(
      '/content-studio/sources?page=1&archived=true&search=brief'
    );
    expect(screen.getByText('Old Brief')).toBeTruthy();
    expect(screen.queryByText('Curated Brief')).toBeNull();
  });

  it('offers no Use in content on its rows', async () => {
    await mount(h(ContentStudioSources));
    expect(screen.getByText('Found page 1')).toBeTruthy();
    expect(useButtons()).toEqual([]);
  });
});

describe('Research into content: surface', () => {
  const dir = __dirname;
  const code = (file: string) =>
    readFileSync(join(dir, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('P803-9/P803-10 the action opens the dialog; only the dialog creates, with the usual body', () => {
    const modal = code('content-studio.package.modal.tsx');
    const action = modal.slice(
      modal.indexOf('export const ContentStudioUseInContent')
    );
    expect(action).not.toMatch(/createPackage|\/packages|fetch|propose|\/ai\b/);
    expect(action).toContain('<CreateContentStudioPackageModal');
    expect(action).toContain('sourceIds={[source.id]}');
    // the create body is the one it always was
    expect(modal).toMatch(
      /createPackage\(\{\s*name: name\.trim\(\) \|\| undefined,[\s\S]*?projectId:[\s\S]*?: undefined,\s*\}\)/
    );
    expect(modal.match(/createPackage\(/g)).toHaveLength(1);
    const body = modal.slice(
      modal.indexOf('createPackage({'),
      modal.indexOf('});', modal.indexOf('createPackage({'))
    );
    expect(body).not.toMatch(/source|version|hash/i);
  });

  it('P803-11 a link with sources opens and asks nothing by itself', () => {
    const workspace = code('content-studio.workspace.tsx');
    const notice = code('content-studio.source.picker.tsx');
    expect(workspace).toMatch(
      /parseContentStudioResearchSourceIds\(researchSources\)/
    );
    expect(workspace).toMatch(/initialSourceIds=\{researchSourceIds\}/);
    // the only use of the ids outside the dialog: the notice and Clear
    expect(workspace.match(/researchSourceIds/g)!.length).toBeLessThanOrEqual(
      6
    );
    expect(notice).not.toMatch(/propose|\/ai\b|openModal|createPackage/);
    expect(notice).not.toMatch(/refresh|capture\(|captureSource|method:/);
  });

  it('every new label is in the English translations', () => {
    const translations = JSON.parse(
      readFileSync(
        join(
          dir,
          '../../../../../libraries/react-shared-libraries/src/translation/locales/en/translation.json'
        ),
        'utf8'
      )
    );
    const files = [
      'content-studio.source.picker.tsx',
      'content-studio.package.modal.tsx',
      'content-studio.sources.tsx',
      'content-studio.grounding.tsx',
      'content-studio.ai-writing.tsx',
    ];
    for (const file of files) {
      for (const m of readFileSync(join(dir, file), 'utf8').matchAll(
        /t\(\s*'([a-z0-9_]+)',\s*'((?:[^'\\]|\\.)*)'\s*\)/g
      )) {
        expect([m[1], translations[m[1]]]).toEqual([m[1], m[2]]);
      }
    }
    expect(translations.content_studio_grounding_choose_source).toBeUndefined();
  });
});
