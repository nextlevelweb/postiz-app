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

// News Radar (P8-02): what the organization's live feeds found, across
// feeds. A .spec.ts without JSX like the other Content Studio frontend specs;
// the server is an in-memory fake of GET /discoveries and GET /sources

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
  search: '',
  listeners: new Set<() => void>(),
  replace(url: string) {
    mockLocation.search = url.includes('?') ? url.split('?')[1] : '';
    mockLocation.listeners.forEach((listener) => listener());
  },
};
const mockReplace = jest.fn((url: string) => mockLocation.replace(url));
jest.mock('next/navigation', () => {
  const { useSyncExternalStore } = require('react');
  return {
    useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
    usePathname: () => '/content-studio/research',
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

const { ContentStudioResearch } = require('./content-studio.research');

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const T1 = '2026-10-20T08:00:00.000Z';
const T2 = '2026-10-21T09:30:00.000Z';
const FEED_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FEED_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAGE_1 = '00000001-0000-4000-8000-000000000000';
const PAGE_2 = '00000002-0000-4000-8000-000000000000';
const PAGE_3 = '00000003-0000-4000-8000-000000000000';
const date = (iso: string) => dayjs(iso).format('MMM D, YYYY HH:mm');
const HTML_TITLE = '<img src=x onerror=alert(1)><b>Bold</b> launch';

let feeds: Array<Record<string, unknown>>;
let rows: Array<Record<string, unknown>>;
let pages: number;
let override: (url: string) => Reply | Promise<Reply> | undefined;

const feedSummary = (id: string, name: string) => ({
  id,
  kind: 'feed',
  name,
  canonicalUrl: `https://${name.toLowerCase().replace(/\W+/g, '')}.test/rss`,
  latestVersionNumber: 0,
  archivedAt: null,
  createdAt: T1,
  updatedAt: T1,
  lastCapturedAt: T2,
});

const server = (url: string): Reply | Promise<Reply> => {
  const custom = override(url);
  if (custom) {
    return custom;
  }
  const { pathname } = new URL(url, 'https://api.test');
  if (pathname === '/content-studio/sources') {
    return reply(200, { pages: feeds.length ? 1 : 0, results: feeds });
  }
  if (pathname === '/content-studio/discoveries') {
    return reply(200, { pages, total: rows.length, results: rows });
  }
  return reply(404, { msg: 'Not found.', code: 'CS_NOT_FOUND' });
};

const requests = () =>
  mockFetch.mock.calls.map(([url, init]) => ({
    method: (init?.method as string) || 'GET',
    url: url as string,
  }));
const radarQueries = () =>
  requests()
    .filter((r) => r.url.startsWith('/content-studio/discoveries?'))
    .map((r) =>
      Object.fromEntries(new URL(r.url, 'https://api.test').searchParams)
    );
const lastRadarQuery = () => radarQueries().at(-1);
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
const renderRadar = async (search = '') => {
  mockLocation.search = search;
  wrap(h(ContentStudioResearch));
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
const rowOf = (title: string) =>
  screen.getByRole('link', { name: title }).closest('li') as HTMLElement;

beforeEach(() => {
  mockFetch.mockReset();
  mockReplace.mockClear();
  mockFetch.mockImplementation(async (url: string) => server(url));
  override = () => undefined;
  pages = 1;
  feeds = [feedSummary(FEED_A, 'Daily News'), feedSummary(FEED_B, 'Tech Wire')];
  rows = [
    {
      id: 'd1',
      entryTitle: HTML_TITLE,
      publishedAt: T1,
      firstSeenAt: T2,
      lastSeenAt: T2,
      changedSinceFound: false,
      feed: { id: FEED_A, name: 'Daily News' },
      source: {
        id: PAGE_1,
        name: 'Launch post',
        canonicalUrl: 'https://www.daily.test/2026/launch',
        latestVersionNumber: 3,
        archivedAt: null,
        lastPageChangeAt: null,
      },
    },
    {
      id: 'd2',
      entryTitle: null,
      publishedAt: null,
      firstSeenAt: T1,
      lastSeenAt: T2,
      changedSinceFound: false,
      feed: { id: FEED_B, name: 'Tech Wire' },
      source: {
        id: PAGE_2,
        name: 'wire.test',
        canonicalUrl: 'https://wire.test/story',
        latestVersionNumber: 0,
        archivedAt: null,
        lastPageChangeAt: null,
      },
    },
    {
      id: 'd3',
      entryTitle: 'Old story',
      publishedAt: T1,
      firstSeenAt: T1,
      lastSeenAt: T1,
      changedSinceFound: false,
      feed: { id: FEED_A, name: 'Daily News' },
      source: {
        id: PAGE_3,
        name: 'Old story',
        canonicalUrl: 'https://daily.test/old',
        latestVersionNumber: 0,
        archivedAt: T2,
        lastPageChangeAt: null,
      },
    },
  ];
});
afterEach(() => cleanup());

describe('News Radar: page and filters', () => {
  it('FE2 opens on 7 days, every live feed and every capture state, page 1', async () => {
    await renderRadar();
    expect(screen.getByRole('heading', { name: 'News Radar' })).toBeTruthy();
    expect(
      screen.getByText('Recent pages discovered by your feeds.')
    ).toBeTruthy();
    expect(radarQueries()).toEqual([{ page: '1', since: '7d' }]);
    expect(pressed('7 days')).toBe('true');
    expect(pressed('24 hours')).toBe('false');
    expect(pressed('30 days')).toBe('false');
    expect(pressed('All time')).toBe('false');
    expect(pressed('All')).toBe('true');
    expect(pressed('Captured')).toBe('false');
    expect(pressed('Not captured')).toBe('false');
    expect(
      (screen.getByRole('combobox', { name: 'Feed' }) as HTMLSelectElement)
        .value
    ).toBe('');
    expect(screen.getByText('Pages found: 3')).toBeTruthy();
  });

  it('FE3 restores the filters from the URL and asks the server for exactly them', async () => {
    pages = 3;
    await renderRadar(`since=30d&feed=${FEED_B}&capture=not-captured&page=2`);
    expect(radarQueries()).toEqual([
      {
        page: '2',
        since: '30d',
        feedSourceId: FEED_B,
        captureState: 'not-captured',
      },
    ]);
    expect(pressed('30 days')).toBe('true');
    expect(pressed('Not captured')).toBe('true');
    expect(
      (screen.getByRole('combobox', { name: 'Feed' }) as HTMLSelectElement)
        .value
    ).toBe(FEED_B);
  });

  it('a page past the last one moves to the last one', async () => {
    pages = 2;
    await renderRadar('since=30d&page=9');
    expect(location()).toEqual({ since: '30d', page: '2' });
    expect(lastRadarQuery()).toEqual({ page: '2', since: '30d' });
  });

  it('ignores what it does not know in the URL', async () => {
    await renderRadar(
      'since=1y&feed=not-an-id&capture=failed&page=abc&organizationId=x'
    );
    expect(radarQueries()).toEqual([{ page: '1', since: '7d' }]);
  });

  it('FE4 a new window keeps the feed and capture state and starts on page 1', async () => {
    // enough pages that the page in the URL is a real one
    pages = 5;
    await renderRadar(`feed=${FEED_A}&capture=captured&page=3`);
    await click(screen.getByRole('button', { name: '24 hours' }));
    expect(location()).toEqual({
      since: '24h',
      feed: FEED_A,
      capture: 'captured',
    });
    expect(lastRadarQuery()).toEqual({
      page: '1',
      since: '24h',
      feedSourceId: FEED_A,
      captureState: 'captured',
    });
  });

  it('FE5/FE7 the feed choice lists the live feeds (kind=feed) and starts on page 1', async () => {
    // enough pages that the page in the URL is a real one
    pages = 5;
    await renderRadar('since=30d&capture=captured&page=2');
    expect(
      requests().filter((r) => r.url.startsWith('/content-studio/sources'))
    ).toEqual([
      {
        method: 'GET',
        url: '/content-studio/sources?page=1&archived=false&kind=feed',
      },
    ]);
    const select = screen.getByRole('combobox', {
      name: 'Feed',
    }) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'All feeds',
      'Daily News',
      'Tech Wire',
    ]);
    fireEvent.change(select, { target: { value: FEED_B } });
    await flush();
    expect(location()).toEqual({
      since: '30d',
      feed: FEED_B,
      capture: 'captured',
    });
    fireEvent.change(select, { target: { value: '' } });
    await flush();
    expect(location()).toEqual({ since: '30d', capture: 'captured' });
  });

  it('FE6 a capture state keeps the window and feed and starts on page 1', async () => {
    // enough pages that the page in the URL is a real one
    pages = 5;
    await renderRadar(`since=all&feed=${FEED_A}&page=4`);
    await click(screen.getByRole('button', { name: 'Not captured' }));
    expect(location()).toEqual({
      since: 'all',
      feed: FEED_A,
      capture: 'not-captured',
    });
    await click(screen.getByRole('button', { name: 'All' }));
    expect(location()).toEqual({ since: 'all', feed: FEED_A });
  });

  it('pages through the server pages, keeping the filters', async () => {
    pages = 3;
    await renderRadar('since=30d');
    await click(screen.getByRole('button', { name: /next/i }));
    expect(location()).toEqual({ since: '30d', page: '2' });
    expect(lastRadarQuery()).toEqual({ page: '2', since: '30d' });
  });

  it('a feed in the URL that is not among the first 20 keeps its choice', async () => {
    const other = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    rows = rows.map((r) => ({ ...r, feed: { id: other, name: 'Far feed' } }));
    await renderRadar(`feed=${other}`);
    const select = screen.getByRole('combobox', {
      name: 'Feed',
    }) as HTMLSelectElement;
    expect(select.value).toBe(other);
    expect(select.selectedOptions[0].textContent).toBe('Far feed');
  });
});

describe('News Radar: rows', () => {
  it('FE8/FE16/FE11/FE15 a row: the feed title as plain text opening its page source, the host, found and published', async () => {
    await renderRadar();
    const link = screen.getByRole('link', { name: HTML_TITLE });
    expect(link.getAttribute('href')).toBe(`/content-studio/sources/${PAGE_1}`);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('li b')).toBeNull();
    const item = rowOf(HTML_TITLE);
    expect(within(item).getByText('www.daily.test')).toBeTruthy();
    expect(within(item).getByText(`Found ${date(T2)}`)).toBeTruthy();
    expect(within(item).getByText(`Published ${date(T1)}`)).toBeTruthy();
    expect(within(item).getByText('Captured')).toBeTruthy();
    // last seen is kept in the answer, not shown in the Radar row
    expect(within(item).queryByText(/Last seen/)).toBeNull();
    // no entry title: the page source's name; no date: Unknown
    const second = rowOf('wire.test');
    expect(within(second).getByText('Published Unknown')).toBeTruthy();
  });

  it('FE12/FE13/FE14 a page without a version is Not captured, never failed; an archived page says so', async () => {
    await renderRadar();
    expect(within(rowOf('wire.test')).getByText('Not captured')).toBeTruthy();
    const archived = rowOf('Old story');
    expect(within(archived).getByText('Not captured')).toBeTruthy();
    expect(within(archived).getByText('Archived')).toBeTruthy();
    expect(within(rowOf(HTML_TITLE)).queryByText('Archived')).toBeNull();
    expect(document.body.textContent).not.toMatch(/fail/i);
  });

  it('FE9/FE10 names the feed that found it, opens it, and narrows the Radar to it', async () => {
    await renderRadar('since=30d&capture=captured&page=2');
    const item = rowOf('wire.test');
    expect(within(item).getByText('Found by')).toBeTruthy();
    expect(
      within(item).getByRole('link', { name: 'Tech Wire' }).getAttribute('href')
    ).toBe(`/content-studio/sources/${FEED_B}`);
    await click(within(item).getByRole('button', { name: 'Only this feed' }));
    expect(location()).toEqual({
      since: '30d',
      feed: FEED_B,
      capture: 'captured',
    });
    // already narrowed: no button for that feed
    expect(
      within(rowOf('wire.test')).queryByRole('button', {
        name: 'Only this feed',
      })
    ).toBeNull();
  });

  it('D1 a page two feeds found is two rows, each with its feed', async () => {
    rows = [
      { ...rows[0], id: 'a', feed: { id: FEED_A, name: 'Daily News' } },
      { ...rows[0], id: 'b', feed: { id: FEED_B, name: 'Tech Wire' } },
    ];
    await renderRadar();
    const items = screen.getAllByRole('link', { name: HTML_TITLE });
    expect(items).toHaveLength(2);
    expect(
      items.map(
        (link) =>
          within(link.closest('li') as HTMLElement).getAllByRole('link')[1]
            .textContent
      )
    ).toEqual(['Daily News', 'Tech Wire']);
  });
});

// P8-04B2: Changed is the server's answer for the row, shown as it is
describe('News Radar: Changed', () => {
  const T3 = '2026-10-22T07:15:00.000Z';
  const changedRow = (
    row: Record<string, unknown>,
    over: Record<string, unknown>
  ) => ({
    ...row,
    ...over,
    source: {
      ...(row.source as Record<string, unknown>),
      lastPageChangeAt: T3,
    },
  });

  it('FEB2-1 a row the server calls changed says Changed, with when; one it does not says neither', async () => {
    rows = [
      changedRow(rows[0], { changedSinceFound: true }),
      // the page changed, but not since this feed found it
      changedRow(rows[1], { changedSinceFound: false }),
    ];
    await renderRadar();
    const changed = rowOf(HTML_TITLE);
    expect(within(changed).getByText('Changed')).toBeTruthy();
    expect(within(changed).getByText(`Changed ${date(T3)}`)).toBeTruthy();
    expect(within(changed).getByText('Captured')).toBeTruthy();
    const unchanged = rowOf('wire.test');
    expect(within(unchanged).queryByText(/Changed/)).toBeNull();
    expect(
      within(unchanged).queryByText(date(T3), { exact: false })
    ).toBeNull();
    expect(within(unchanged).getByText('Not captured')).toBeTruthy();
    // a fact, in one word: never new, updated or important
    expect(document.body.textContent).not.toMatch(
      /\bNew\b|Updated|Important|Significant/
    );
  });

  it('FEB2-2 an archived page that changed is Archived and Changed, beside its capture state', async () => {
    rows = [changedRow(rows[2], { changedSinceFound: true })];
    await renderRadar();
    const item = rowOf('Old story');
    expect(
      Array.from(item.querySelectorAll('span.rounded-full')).map(
        (badge) => badge.textContent
      )
    ).toEqual(['Not captured', 'Archived', 'Changed']);
    expect(within(item).getByText(`Changed ${date(T3)}`)).toBeTruthy();
  });

  it('FEB2-3 a changed row still opens its page source, not a change', async () => {
    rows = [changedRow(rows[0], { changedSinceFound: true })];
    await renderRadar();
    const hrefs = within(rowOf(HTML_TITLE))
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual([
      `/content-studio/sources/${PAGE_1}`,
      `/content-studio/sources/${FEED_A}`,
    ]);
    expect(hrefs.join(' ')).not.toMatch(/change=|source-changes/);
  });

  it('FEB2-4 the same page found by two feeds can be Changed for one and not the other', async () => {
    rows = [
      changedRow(rows[0], { id: 'a', changedSinceFound: true }),
      changedRow(rows[0], {
        id: 'b',
        changedSinceFound: false,
        feed: { id: FEED_B, name: 'Tech Wire' },
      }),
    ];
    await renderRadar();
    expect(
      screen
        .getAllByRole('link', { name: HTML_TITLE })
        .map(
          (link) =>
            within(link.closest('li') as HTMLElement).queryAllByText('Changed')
              .length
        )
    ).toEqual([1, 0]);
  });
});

describe('News Radar: empty, loading and error', () => {
  it('ES1 without feeds: add a feed in Sources', async () => {
    feeds = [];
    rows = [];
    await renderRadar();
    expect(screen.getByText('Add a feed to see what it finds.')).toBeTruthy();
    expect(
      screen
        .getAllByRole('link', { name: 'Sources' })
        .every((l) => l.getAttribute('href') === '/content-studio/sources')
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Show all time' })).toBeNull();
  });

  it('ES2/ES3 feeds but nothing in the window: say so, offer all time, and that feeds are captured hourly', async () => {
    rows = [];
    await renderRadar();
    expect(screen.getByText('Nothing found in the last 7 days.')).toBeTruthy();
    expect(
      screen.getByText('Feeds are captured automatically about every hour.')
    ).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Show all time' }));
    expect(location()).toEqual({ since: 'all' });
    expect(lastRadarQuery()).toEqual({ page: '1', since: 'all' });
    expect(screen.getByText('Nothing found yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show all time' })).toBeNull();
    cleanup();
    await renderRadar('since=24h');
    expect(
      screen.getByText('Nothing found in the last 24 hours.')
    ).toBeTruthy();
  });

  it('ES4 filters that match nothing say so', async () => {
    rows = [];
    await renderRadar(`feed=${FEED_A}`);
    expect(screen.getByText('No pages match these filters.')).toBeTruthy();
    cleanup();
    await renderRadar('capture=captured');
    expect(screen.getByText('No pages match these filters.')).toBeTruthy();
  });

  it('ES5/ES6 loading, then a fixed error with retry, never the server text', async () => {
    let answer: ((r: Reply) => void) | null = null;
    override = (url) =>
      url.startsWith('/content-studio/discoveries')
        ? new Promise<Reply>((resolve) => (answer = resolve))
        : undefined;
    await renderRadar();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByText('Pages found: 3')).toBeNull();
    await act(async () =>
      answer!(
        reply(500, {
          msg: 'SECRET backend detail',
          code: 'CS_SOURCE_INTEGRITY_ERROR',
        })
      )
    );
    await flush();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('News Radar could not be loaded.');
    expect(document.body.textContent).not.toContain('SECRET');
    override = () => undefined;
    await click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Pages found: 3')).toBeTruthy();
  });
});

describe('News Radar: surface', () => {
  const dir = __dirname;
  const code = (file: string) =>
    readFileSync(join(dir, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const radar = [
    'content-studio.research.tsx',
    'content-studio.research.api.ts',
    'content-studio.discovery.row.tsx',
  ]
    .map(code)
    .join('\n');
  const page = readFileSync(
    join(dir, '../../app/(app)/(site)/content-studio/research/page.tsx'),
    'utf8'
  );

  it('FE1 Content Studio home links to News Radar next to Sources; the top menu keeps one Content Studio entry', () => {
    const home = code('content-studio.home.tsx');
    expect(home).toContain('href={RADAR_PAGE}');
    expect(home).toContain("{t('content_studio_news_radar', 'News Radar')}");
    expect(home.indexOf('href={RADAR_PAGE}')).toBeGreaterThan(
      home.indexOf('href="/content-studio/sources"')
    );
    expect(home.indexOf('href={RADAR_PAGE}')).toBeLessThan(
      home.indexOf('href="/content-studio/designs"')
    );
    expect(code('content-studio.research.api.ts')).toContain(
      "export const RADAR_PAGE = '/content-studio/research';"
    );
    const top = readFileSync(join(dir, '../layout/top.menu.tsx'), 'utf8');
    expect(top).not.toMatch(/research|radar/i);
    // P8-04B1: the page is News Radar and Changes; no tab is News Radar
    expect(page).toContain('return <ContentStudioResearchTabs />;');
    expect(page).not.toMatch(/fetch|useSWR|refresh/);
  });

  it('FE17-FE19 reads only: no polling, no capture, no package, no AI, no other address', () => {
    expect(radar).not.toMatch(
      /refreshInterval|setInterval|WebSocket|EventSource/
    );
    const urls = Array.from(
      radar.matchAll(/['"`](\/content-studio[^'"`$]*)/g)
    ).map((m) => m[1]);
    expect([...new Set(urls)].sort()).toEqual([
      '/content-studio',
      '/content-studio/discoveries',
      '/content-studio/research',
    ]);
    // the pager is the one shared from the package list; the one way into
    // content (P8-03) is the shared Use in content button, which opens the
    // New package dialog and creates nothing itself
    const own = radar
      .replace(
        "from '@gitroom/frontend/components/content-studio/content-studio.package.list'",
        ''
      )
      .replace(
        "import { ContentStudioUseInContent } from '@gitroom/frontend/components/content-studio/content-studio.package.modal';",
        ''
      );
    expect(radar.match(/content-studio\.package\.modal/g)).toHaveLength(1);
    expect(own).not.toMatch(
      /method:|refresh|capture\(|\/packages|package|\/ai\b|ai\.?connection|openai|anthropic|summar|dangerouslySetInnerHTML|innerHTML|window\.open|new Image|favicon|og:image|XMLHttpRequest|axios/i
    );
    expect(radar).not.toMatch(/checkbox|selected(Ids|Sources)|bulk/i);
    expect(radar).not.toMatch(/\bfetch\(/);
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
    const labels = Array.from(
      radar.matchAll(/t\(\s*'([a-z0-9_]+)',\s*'((?:[^'\\]|\\.)*)'\s*\)/g)
    );
    expect(labels.length).toBeGreaterThan(25);
    for (const m of labels) {
      expect([m[1], translations[m[1]]]).toEqual([m[1], m[2]]);
    }
  });
});
