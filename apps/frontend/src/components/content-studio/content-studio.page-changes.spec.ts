import { createElement as h, ReactNode } from 'react';
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
import dayjs from 'dayjs';

// Research Changes (P8-04B1): the tab next to News Radar, the organization's
// page sources by their last page change, and the link from a change into
// Source detail's What changed. A .spec.ts without JSX, like the other
// Content Studio frontend specs; the server is an in-memory fake

jest.mock('next/link', () => {
  const { createElement } = require('react');
  return {
    __esModule: true,
    default: ({ href, prefetch, children, ...rest }: any) =>
      createElement('a', { href, ...rest }, children),
  };
});
// the URL of the page, which a replace changes and every reader sees
const mockLocation = {
  pathname: '/content-studio/research',
  search: '',
  listeners: new Set<() => void>(),
  replace(url: string) {
    const [pathname, search = ''] = url.split('?');
    mockLocation.pathname = pathname;
    mockLocation.search = search;
    mockLocation.listeners.forEach((listener) => listener());
  },
};
const mockReplace = jest.fn((url: string) => mockLocation.replace(url));
jest.mock('next/navigation', () => {
  const { useSyncExternalStore } = require('react');
  return {
    useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
    usePathname: () => mockLocation.pathname,
    useSearchParams: () =>
      new URLSearchParams(
        useSyncExternalStore(
          (listener: () => void) => {
            mockLocation.listeners.add(listener);
            return () => mockLocation.listeners.delete(listener);
          },
          () => mockLocation.search
        )
      ),
  };
});
jest.mock('@gitroom/frontend/components/layout/new-modal', () => ({
  useModals: () => ({
    openModal: jest.fn(),
    closeAll: jest.fn(),
    closeById: jest.fn(),
    closeCurrent: jest.fn(),
  }),
}));
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

const { ContentStudioResearchTabs } = require('./content-studio.research.tabs');
const { ContentStudioSourceDetail } = require('./content-studio.source.detail');

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const T1 = '2026-10-20T08:00:00.000Z';
const T2 = '2026-10-21T09:30:00.000Z';
const T3 = '2026-10-22T07:15:00.000Z';
const PAGE_1 = '00000001-0000-4000-8000-000000000000';
const PAGE_2 = '00000002-0000-4000-8000-000000000000';
const VERSION_7 = '00000007-0000-4000-8000-000000000007';
const VERSION_3 = '00000003-0000-4000-8000-000000000003';
const date = (iso: string) => dayjs(iso).format('MMM D, YYYY HH:mm');
const HTML_NAME = '<img src=x onerror=alert(1)><b>Bold</b> pricing';

let changes: Array<Record<string, any>>;
let pages: number;
let override: (url: string) => Reply | Promise<Reply> | undefined;

const server = (url: string): Reply | Promise<Reply> => {
  const custom = override(url);
  if (custom) {
    return custom;
  }
  const { pathname } = new URL(url, 'https://api.test');
  if (pathname === '/content-studio/source-changes') {
    return reply(200, { pages, total: changes.length, results: changes });
  }
  // News Radar, for the default tab
  if (pathname === '/content-studio/sources') {
    return reply(200, { pages: 0, results: [] });
  }
  if (pathname === '/content-studio/discoveries') {
    return reply(200, { pages: 0, total: 0, results: [] });
  }
  return reply(404, { msg: 'Not found.', code: 'CS_NOT_FOUND' });
};

const urls = () => mockFetch.mock.calls.map(([url]) => url as string);
const changeQueries = () =>
  urls()
    .filter((url) => url.startsWith('/content-studio/source-changes?'))
    .map((url) =>
      Object.fromEntries(new URL(url, 'https://api.test').searchParams)
    );
const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
const wrap = (...children: ReactNode[]) =>
  render(
    h(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      ...children
    )
  );
const renderResearch = async (search = '') => {
  mockLocation.pathname = '/content-studio/research';
  mockLocation.search = search;
  wrap(h(ContentStudioResearchTabs));
  await flush();
};
const click = async (element: HTMLElement) => {
  fireEvent.click(element);
  await flush();
};
const location = () =>
  Object.fromEntries(new URLSearchParams(mockLocation.search));
const pressed = (name: string) =>
  screen.getByRole('button', { name }).getAttribute('aria-pressed');
const rowOf = (name: string) =>
  screen.getByRole('link', { name }).closest('li') as HTMLElement;

beforeEach(() => {
  mockFetch.mockReset();
  mockReplace.mockClear();
  mockFetch.mockImplementation(async (url: string) => server(url));
  override = () => undefined;
  pages = 1;
  changes = [
    {
      source: {
        id: PAGE_1,
        name: HTML_NAME,
        canonicalUrl: 'https://www.example.test/pricing',
        archivedAt: null,
      },
      change: 'content_changed',
      changedAt: T3,
      previousCaptureAt: T2,
      version: { id: VERSION_7, versionNumber: 7 },
    },
    {
      source: {
        id: PAGE_2,
        name: 'About us',
        canonicalUrl: 'https://about.test/team',
        archivedAt: T3,
      },
      change: 'title_changed',
      changedAt: T2,
      previousCaptureAt: T1,
      version: { id: VERSION_3, versionNumber: 3 },
    },
  ];
});
afterEach(() => cleanup());

describe('Research tabs', () => {
  it('FE1 no tab is News Radar, as the page always was', async () => {
    await renderResearch();
    expect(
      screen.getByRole('heading', { level: 1, name: 'News Radar' })
    ).toBeTruthy();
    expect(
      screen
        .getByRole('tab', { name: 'News Radar' })
        .getAttribute('aria-selected')
    ).toBe('true');
    expect(
      screen.getByRole('tab', { name: 'Changes' }).getAttribute('aria-selected')
    ).toBe('false');
    expect(urls().some((url) => url.includes('source-changes'))).toBe(false);
    // an unknown tab is News Radar too
    cleanup();
    await renderResearch('tab=radar2');
    expect(
      screen.getByRole('heading', { level: 1, name: 'News Radar' })
    ).toBeTruthy();
  });

  it('FE2 ?tab=changes is Changes, with its own heading', async () => {
    await renderResearch('tab=changes');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Changes' })
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'News Radar' })).toBeNull();
    expect(
      screen.getByRole('tab', { name: 'Changes' }).getAttribute('aria-selected')
    ).toBe('true');
    expect(
      urls().some((url) => url.startsWith('/content-studio/discoveries'))
    ).toBe(false);
  });

  it('FE3 switching tabs keeps no filter of the other one', async () => {
    await renderResearch(
      'since=30d&feed=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&capture=captured&page=2'
    );
    await click(screen.getByRole('tab', { name: 'Changes' }));
    expect(mockReplace).toHaveBeenLastCalledWith(
      '/content-studio/research?tab=changes',
      { scroll: false }
    );
    expect(changeQueries().at(-1)).toEqual({ page: '1', since: '7d' });
    await click(screen.getByRole('button', { name: '30 days' }));
    expect(location()).toEqual({ tab: 'changes', since: '30d' });
    await click(screen.getByRole('tab', { name: 'News Radar' }));
    expect(mockReplace).toHaveBeenLastCalledWith('/content-studio/research', {
      scroll: false,
    });
    expect(location()).toEqual({});
  });
});

describe('Changes', () => {
  it('FE4/FE6 seven days by default, with the number of pages changed', async () => {
    await renderResearch('tab=changes');
    expect(changeQueries()).toEqual([{ page: '1', since: '7d' }]);
    expect(pressed('7 days')).toBe('true');
    expect(screen.getByText('Pages changed: 2')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Changed in' })).toBeTruthy();
  });

  it('FE5 24 hours, 30 days and all time are asked of the server', async () => {
    await renderResearch('tab=changes');
    for (const [label, since] of [
      ['24 hours', '24h'],
      ['30 days', '30d'],
      ['All time', 'all'],
    ]) {
      await click(screen.getByRole('button', { name: label }));
      expect(changeQueries().at(-1)).toEqual({ page: '1', since });
      expect(pressed(label)).toBe('true');
      expect(location().since).toBe(since);
    }
    // the URL keeps a window and a page; anything else is the default
    cleanup();
    mockFetch.mockClear();
    await renderResearch('tab=changes&since=1h&page=x&feed=y');
    expect(changeQueries()).toEqual([{ page: '1', since: '7d' }]);
  });

  it('FE7-FE11/FE18 a row: current name and host as text, what changed, when, the capture before, Archived', async () => {
    await renderResearch('tab=changes');
    const first = rowOf(HTML_NAME);
    expect(first.querySelector('img, b')).toBeNull();
    expect(within(first).getByText('www.example.test')).toBeTruthy();
    expect(within(first).getByText('Content changed')).toBeTruthy();
    expect(within(first).getByText(`Changed ${date(T3)}`)).toBeTruthy();
    expect(
      within(first).getByText(`Previously captured ${date(T2)}`)
    ).toBeTruthy();
    expect(within(first).queryByText('Archived')).toBeNull();
    expect(
      screen.getByRole('link', { name: HTML_NAME }).getAttribute('href')
    ).toBe(`/content-studio/sources/${PAGE_1}`);
    const second = rowOf('About us');
    expect(within(second).getByText('Title changed')).toBeTruthy();
    expect(within(second).getByText('Archived')).toBeTruthy();
    expect(within(second).getByText(`Changed ${date(T2)}`)).toBeTruthy();
  });

  it('FE12 What changed opens that exact version on the source page', async () => {
    await renderResearch('tab=changes');
    const link = within(rowOf(HTML_NAME)).getByRole('link', {
      name: 'What changed in Version 7',
    });
    expect(link.textContent).toBe('What changed');
    expect(link.getAttribute('href')).toBe(
      `/content-studio/sources/${PAGE_1}?change=${VERSION_7}`
    );
    expect(
      within(rowOf('About us'))
        .getByRole('link', { name: 'What changed in Version 3' })
        .getAttribute('href')
    ).toBe(`/content-studio/sources/${PAGE_2}?change=${VERSION_3}`);
  });

  it('FE13/FE14 an empty window offers all time; all time says none were captured', async () => {
    changes = [];
    pages = 0;
    await renderResearch('tab=changes');
    expect(
      screen.getByText('No page changes in the last 7 days.')
    ).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Show all time' }));
    expect(location()).toEqual({ tab: 'changes', since: 'all' });
    expect(screen.getByText('No page changes captured yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show all time' })).toBeNull();
    for (const [since, text] of [
      ['24h', 'No page changes in the last 24 hours.'],
      ['30d', 'No page changes in the last 30 days.'],
    ]) {
      cleanup();
      await renderResearch(`tab=changes&since=${since}`);
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(
      screen.getByText(
        'A change is found when a page is captured again: by its feed or by Refresh.'
      )
    ).toBeTruthy();
  });

  it('FE15 a failure is fixed text with a retry, never the server message', async () => {
    let fail = true;
    override = (url) =>
      fail && url.startsWith('/content-studio/source-changes')
        ? reply(500, {
            msg: 'SERVER_SECRET_MARKER boom',
            code: 'CS_SOURCE_INTEGRITY_ERROR',
          })
        : undefined;
    await renderResearch('tab=changes');
    const alert = screen.getByRole('alert');
    // the fixed text and the retry, nothing of the answer: no message or code
    expect(alert.textContent).toBe('Changes could not be loaded.Try again');
    expect(document.body.textContent).not.toMatch(
      /SERVER_SECRET_MARKER|CS_SOURCE|500/
    );
    fail = false;
    await click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Pages changed: 2')).toBeTruthy();
  });

  it('FE16 shows the loading state until the server answers', async () => {
    let release: (value: Reply) => void = () => undefined;
    override = (url) =>
      url.startsWith('/content-studio/source-changes')
        ? new Promise<Reply>((resolve) => (release = resolve))
        : undefined;
    await renderResearch('tab=changes');
    expect(screen.queryByText('Pages changed: 2')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // the shared LoadingComponent
    expect(document.body.innerHTML).toContain('animation: spin');
    release(reply(200, { pages: 1, total: 2, results: changes }));
    await flush();
    expect(screen.getByText('Pages changed: 2')).toBeTruthy();
  });

  it('FE17 pages with the shared pager, one page at a time', async () => {
    pages = 3;
    await renderResearch('tab=changes');
    const pager = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(pager).getByText('1 / 3')).toBeTruthy();
    await click(within(pager).getByRole('button', { name: 'Next' }));
    expect(changeQueries().at(-1)).toEqual({ page: '2', since: '7d' });
    // the next page is a new list, with its own pager
    expect(
      within(screen.getByRole('navigation', { name: 'Pages' })).getByText(
        '2 / 3'
      )
    ).toBeTruthy();
    expect(location()).toEqual({ tab: 'changes', page: '2' });
    // a new window starts on page 1
    await click(screen.getByRole('button', { name: '30 days' }));
    expect(location()).toEqual({ tab: 'changes', since: '30d' });
  });
});

describe('Changes code', () => {
  const dir = __dirname;
  const code = (file: string) =>
    readFileSync(join(dir, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const own = [
    'content-studio.page-changes.tsx',
    'content-studio.page-changes.api.ts',
    'content-studio.research.tabs.tsx',
  ]
    .map(code)
    .join('\n');

  it('FE19 reads only, one address, no AI, no Radar change and no logic of its own', () => {
    expect(own).not.toMatch(
      /method:|refreshInterval|setInterval|WebSocket|EventSource|dangerouslySetInnerHTML|innerHTML|\bfetch\(|axios/
    );
    expect(own).not.toMatch(
      /ai\.?connection|openai|anthropic|summar|score|relevan|importan|severity|rank/i
    );
    // the server finds, checks and orders the changes; this only shows them
    expect(own).not.toMatch(
      /contentHash|extractionVersion|lastPageChange|\.sort\(|Date\.now|new Date|getTime|classify/
    );
    const urls = Array.from(
      own.matchAll(/['"`](\/content-studio[^'"`$]*)/g)
    ).map((m) => m[1]);
    expect([...new Set(urls)].sort()).toEqual([
      '/content-studio',
      '/content-studio/source-changes',
    ]);
    // one SWR call in its own hook
    expect(
      code('content-studio.page-changes.api.ts').match(/useSWR\(/g)
    ).toHaveLength(1);
    // the Radar is shown as it is: it knows nothing of changes
    expect(code('content-studio.research.tsx')).not.toMatch(
      /page-changes|PageChange|tab/
    );
    expect(code('content-studio.discovery.row.tsx')).not.toMatch(
      /lastPageChange|Changed/
    );
  });

  it('every label is in the English translations', () => {
    const translations = JSON.parse(
      readFileSync(
        join(
          dir,
          '../../../../../libraries/react-shared-libraries/src/translation/locales/en/translation.json'
        ),
        'utf8'
      )
    );
    const keys = Array.from(
      own.matchAll(/t\(\s*'([a-z0-9_]+)',\s*'([^']*)'/g)
    ).map((m) => [m[1], m[2]]);
    expect(keys.length).toBeGreaterThan(15);
    for (const [key, text] of keys) {
      expect([key, translations[key]]).toEqual([key, text]);
    }
  });
});

// The link from Changes into Source detail (P8-04B1): ?change=<version id>
// opens What changed for that version; Back to history drops it
describe('Source detail ?change=', () => {
  const SOURCE = '11111111-1111-4111-8111-111111111111';
  const vid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  let source: Record<string, any>;
  const summary = (n: number) => ({
    id: vid(n),
    versionNumber: n,
    schemaVersion: 1,
    extractionVersion: 'content-studio-source-v2',
    requestedUrl: 'https://example.com/pricing',
    finalUrl: 'https://example.com/pricing',
    redirectCount: 0,
    fetchedAt: [T1, T2, T3][n - 1],
    httpStatus: 200,
    contentType: 'text/html',
    contentLength: 1000,
    title: `Pricing ${n}`,
    contentHash: String(n).repeat(64),
    sourceHash: 'f'.repeat(64),
    createdAt: T1,
  });
  const compared = (n: number) => ({
    id: vid(n),
    versionNumber: n,
    fetchedAt: [T1, T2, T3][n - 1],
    title: `Pricing ${n}`,
    extractionVersion: 'content-studio-source-v2',
  });
  const detailServer = (url: string): Reply => {
    const { pathname } = new URL(url, 'https://api.test');
    const base = `/content-studio/sources/${SOURCE}`;
    if (pathname === base) {
      return reply(200, { ...source, currentVersion: summary(3) });
    }
    if (pathname === `${base}/versions`) {
      return reply(200, {
        pages: 1,
        results: [summary(3), summary(2), summary(1)],
      });
    }
    const change = pathname.match(/\/versions\/([^/]+)\/changes$/);
    if (change) {
      const n = [1, 2, 3].find((i) => vid(i) === change[1]);
      return n && n > 1
        ? reply(200, {
            source: {
              id: SOURCE,
              name: 'Pricing page',
              canonicalUrl: 'https://example.com/pricing',
            },
            after: compared(n),
            before: compared(n - 1),
            repeatOf: null,
            change: 'content_changed',
            titleChanged: false,
            sameFetchedBytes: false,
            counts: {
              added: 1,
              removed: 1,
              unchanged: 2,
              beforeBlocks: 3,
              afterBlocks: 3,
            },
            blocks: [
              {
                change: 'removed',
                type: 'paragraph',
                level: null,
                text: 'Old',
              },
              { change: 'added', type: 'paragraph', level: null, text: 'New' },
              { change: 'unchanged', count: 2 },
            ],
          })
        : reply(404, { msg: 'Source not found.', code: 'CS_NOT_FOUND' });
    }
    return reply(404, { msg: 'Source not found.', code: 'CS_NOT_FOUND' });
  };
  const renderDetail = async (search: string) => {
    mockLocation.pathname = `/content-studio/sources/${SOURCE}`;
    mockLocation.search = search;
    wrap(h(ContentStudioSourceDetail, { sourceId: SOURCE }));
    await flush();
  };
  const changeRequests = () => urls().filter((url) => url.endsWith('/changes'));

  beforeEach(() => {
    source = {
      id: SOURCE,
      kind: 'url',
      name: 'Pricing page',
      canonicalUrl: 'https://example.com/pricing',
      latestVersionNumber: 3,
      archivedAt: null,
      createdAt: T1,
      updatedAt: T3,
      lastCapturedAt: null,
    };
    mockFetch.mockImplementation(async (url: string) => detailServer(url));
  });

  it('DL1 opens What changed for the linked version, instead of the history', async () => {
    await renderDetail(`change=${vid(2)}`);
    expect(changeRequests()).toEqual([
      `/content-studio/sources/${SOURCE}/versions/${vid(2)}/changes`,
    ]);
    expect(
      screen.getByRole('heading', { name: 'Version 2 compared with Version 1' })
    ).toBeTruthy();
    expect(
      screen.queryByRole('heading', { name: 'Version history' })
    ).toBeNull();
  });

  it('DL2/DL3 Back to history drops the link from the address and keeps everything else', async () => {
    await renderDetail(`tab=x&change=${vid(3)}&from=changes`);
    await click(screen.getByRole('button', { name: 'Back to history' }));
    expect(mockReplace).toHaveBeenLastCalledWith(
      `/content-studio/sources/${SOURCE}?tab=x&from=changes`,
      { scroll: false }
    );
    expect(location()).toEqual({ tab: 'x', from: 'changes' });
    expect(
      screen.getByRole('heading', { name: 'Version history' })
    ).toBeTruthy();
    // only the link: a second back leaves the address alone
    cleanup();
    mockReplace.mockClear();
    await renderDetail(`change=${vid(3)}`);
    await click(screen.getByRole('button', { name: 'Back to history' }));
    expect(mockReplace).toHaveBeenLastCalledWith(
      `/content-studio/sources/${SOURCE}`,
      { scroll: false }
    );
    // opening another version from the page drops the link as well
    cleanup();
    mockReplace.mockClear();
    await renderDetail(`change=${vid(3)}`);
    await click(screen.getByRole('button', { name: 'View extracted content' }));
    expect(location()).toEqual({});
  });

  it('DL4 a link to no version of this source shows the fixed message; anything that is no id is the history', async () => {
    await renderDetail(`change=${vid(9)}`);
    expect(screen.getByRole('alert').textContent).toBe(
      'This source version is no longer available.'
    );
    expect(
      screen.getByRole('button', { name: 'Back to history' })
    ).toBeTruthy();
    for (const value of ['abc', '../../x', `${vid(2)}/../1`, '']) {
      cleanup();
      mockFetch.mockClear();
      await renderDetail(`change=${encodeURIComponent(value)}`);
      expect([value, changeRequests()]).toEqual([value, []]);
      expect(
        screen.getByRole('heading', { name: 'Version history' })
      ).toBeTruthy();
    }
  });

  it('DL5 an archived source opens its linked change too', async () => {
    source.archivedAt = T3;
    await renderDetail(`change=${vid(3)}`);
    expect(
      screen.getByRole('heading', { name: 'Version 3 compared with Version 2' })
    ).toBeTruthy();
  });
});
