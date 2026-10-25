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
import dayjs from 'dayjs';

// Feed sources in the Source Library (P8-01): create, list, capture and the
// pages a feed found. A .spec.ts without JSX like the other Content Studio
// frontend specs; the server is an in-memory fake of the source routes

// a source page reads ?change= (P8-04B1); none here
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/content-studio/sources/x',
  useSearchParams: () => new URLSearchParams(),
}));
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
jest.mock('@gitroom/react/helpers/delete.dialog', () => ({
  deleteDialog: async () => true,
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

const { ContentStudioSources } = require('./content-studio.sources');
const { ContentStudioSourceDetail } = require('./content-studio.source.detail');

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const T0 = '2026-10-10T10:00:00.000Z';
const T1 = '2026-10-20T08:00:00.000Z';
const T2 = '2026-10-20T09:30:00.000Z';
const FEED_ID = '00000001-0000-4000-8000-000000000000';
const PAGE_ID = '00000002-0000-4000-8000-000000000000';
const PAGE_2_ID = '00000003-0000-4000-8000-000000000000';
const date = (iso: string) => dayjs(iso).format('MMM D, YYYY HH:mm');
const HTML_TITLE = '<img src=x onerror=alert(1)><b>Bold</b> launch';

type Summary = {
  id: string;
  kind: string;
  name: string;
  canonicalUrl: string;
  latestVersionNumber: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastCapturedAt: string | null;
  scanPausedAt: string | null;
  captureIntervalMinutes: number | null;
  nextCaptureAt: string | null;
  consecutiveCaptureFailures: number;
};
let feed: Summary;
let pageSource: Summary;
let discoveries: Array<Record<string, unknown>>;
// the feed's capture history (P8-O1), newest first; 45 records in all when
// set, so there are three pages
let captures: Array<Record<string, unknown>>;
let override: (
  method: string,
  url: string
) => Reply | Promise<Reply> | undefined;

const summary = (over: Partial<Summary>): Summary => ({
  id: FEED_ID,
  kind: 'feed',
  name: 'Company newsroom',
  canonicalUrl: 'https://news.test/rss.xml',
  latestVersionNumber: 0,
  archivedAt: null,
  createdAt: T0,
  updatedAt: T0,
  lastCapturedAt: null,
  scanPausedAt: null,
  captureIntervalMinutes: null,
  nextCaptureAt: null,
  consecutiveCaptureFailures: 0,
  ...over,
});

const server = (method: string, url: string, body: any): Reply => {
  const { pathname, searchParams } = new URL(url, 'https://api.test');
  if (method === 'GET' && pathname === '/content-studio/sources') {
    return reply(200, { pages: 1, results: [feed, pageSource] });
  }
  if (method === 'POST' && pathname === '/content-studio/sources') {
    return reply(
      201,
      summary({
        id: 'new',
        kind: body.kind,
        name: body.name,
        canonicalUrl: body.url,
      })
    );
  }
  const one = [feed, pageSource].find(
    (s) => pathname === `/content-studio/sources/${s.id}`
  );
  if (method === 'GET' && one) {
    return reply(200, { ...one, currentVersion: null });
  }
  if (
    method === 'GET' &&
    pathname === `/content-studio/sources/${FEED_ID}/discoveries`
  ) {
    const page = Number(searchParams.get('page'));
    return reply(200, {
      pages: discoveries.length ? 2 : 0,
      total: discoveries.length ? 51 : 0,
      results: page === 1 ? discoveries : [],
    });
  }
  if (
    method === 'GET' &&
    pathname === `/content-studio/sources/${FEED_ID}/captures`
  ) {
    const page = Number(searchParams.get('page'));
    return reply(200, {
      pages: captures.length ? 3 : 0,
      total: captures.length ? 45 : 0,
      results: page === 1 ? captures : [],
    });
  }
  if (method === 'GET' && /\/versions\?/.test(url)) {
    return reply(200, { pages: 0, results: [] });
  }
  if (
    method === 'POST' &&
    pathname === `/content-studio/sources/${FEED_ID}/refresh`
  ) {
    feed = { ...feed, lastCapturedAt: T2, updatedAt: T2 };
    return reply(200, {
      source: feed,
      capture: {
        entriesSeen: 30,
        entriesIgnored: 5,
        entriesSkipped: 2,
        entriesAccepted: 23,
        sourcesCreated: 4,
        versionsCreated: 6,
        unchanged: 15,
        failed: 2,
        archived: 0,
        entriesLimited: 0,
      },
    });
  }
  return reply(404, { msg: 'Source not found.', code: 'CS_NOT_FOUND' });
};

const calls = () =>
  mockFetch.mock.calls.map(([url, init]) => ({
    method: (init?.method as string) || 'GET',
    url: url as string,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  }));
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
      h(ModalHost),
      ...children
    )
  );
const click = async (element: HTMLElement) => {
  fireEvent.click(element);
  await flush();
};
const row = (name: string) =>
  screen.getByRole('link', { name }).closest('li') as HTMLElement;

beforeEach(() => {
  mockModals.set([]);
  captures = [];
  feed = summary({});
  pageSource = summary({
    id: PAGE_ID,
    kind: 'url',
    name: 'Launch post',
    canonicalUrl: 'https://news.test/launch',
    latestVersionNumber: 2,
  });
  discoveries = [
    {
      id: 'd1',
      entryTitle: HTML_TITLE,
      publishedAt: T1,
      firstSeenAt: T1,
      lastSeenAt: T2,
      changedSinceFound: false,
      source: {
        id: PAGE_ID,
        name: 'Launch post',
        canonicalUrl: 'https://news.test/launch',
        latestVersionNumber: 2,
        archivedAt: null,
        lastPageChangeAt: null,
      },
    },
    {
      id: 'd2',
      entryTitle: null,
      publishedAt: null,
      firstSeenAt: T0,
      lastSeenAt: T2,
      changedSinceFound: false,
      source: {
        id: PAGE_2_ID,
        name: 'news.test',
        canonicalUrl: 'https://news.test/older',
        latestVersionNumber: 0,
        archivedAt: null,
        lastPageChangeAt: null,
      },
    },
  ];
  override = () => undefined;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    const custom = await override(method, url);
    if (custom) {
      return custom;
    }
    return server(
      method,
      url,
      init.body ? JSON.parse(init.body as string) : undefined
    );
  });
  mockOpenModal.mockImplementation((params: Omit<MockModal, 'id'>) =>
    mockModals.set([
      ...mockModals.list,
      { ...params, id: `modal-${++modalId}` },
    ])
  );
  mockToast.mockReset();
});
afterEach(() => cleanup());

describe('Source Library: add a feed', () => {
  const openAdd = async () => {
    wrap(h(ContentStudioSources));
    await flush();
    await click(screen.getAllByRole('button', { name: 'Add source' })[0]);
    return screen.getByRole('dialog', { name: 'Add source' });
  };
  const fill = (root: HTMLElement, name: string, url: string) => {
    fireEvent.change(within(root).getByLabelText('Name'), {
      target: { value: name },
    });
    fireEvent.change(within(root).getByLabelText('URL'), {
      target: { value: url },
    });
  };

  it('UI1/119 the source type is a labelled choice: Web page (the default) or Feed (RSS or Atom)', async () => {
    const root = await openAdd();
    const group = within(root).getByRole('group', { name: 'Source type' });
    expect(
      within(group).getByRole('radio', { name: /Web page/ })
    ).toHaveProperty('checked', true);
    expect(
      within(group).getByRole('radio', { name: /Feed \(RSS or Atom\)/ })
    ).toHaveProperty('checked', false);
  });

  it('UI1 a feed is created with its kind, name and URL only, and is not captured', async () => {
    const root = await openAdd();
    await click(
      within(root).getByRole('radio', { name: /Feed \(RSS or Atom\)/ })
    );
    fill(root, 'Newsroom', 'https://news.test/rss.xml');
    await click(within(root).getByRole('button', { name: 'Add source' }));
    expect(calls().filter((c) => c.method !== 'GET')).toEqual([
      {
        method: 'POST',
        url: '/content-studio/sources',
        body: {
          kind: 'feed',
          name: 'Newsroom',
          url: 'https://news.test/rss.xml',
        },
      },
    ]);
  });

  it.each([
    [
      'FE1/M26 a feed',
      'CS_SOURCE_FEED_LIMIT',
      'This organization has reached its limit of active feeds. Archive a feed to add or restore another.',
    ],
    [
      'FE2/M27 a page',
      'CS_SOURCE_LIMIT',
      'This organization has reached its limit of sources.',
    ],
  ])(
    'P8-C1 %s past the organization limit is refused with fixed text and no number',
    async (_name, code, text) => {
      override = (method, url) =>
        method === 'POST' && url === '/content-studio/sources'
          ? reply(409, { msg: 'server text 100 of 100', code })
          : undefined;
      const root = await openAdd();
      if (code === 'CS_SOURCE_FEED_LIMIT') {
        await click(
          within(root).getByRole('radio', { name: /Feed \(RSS or Atom\)/ })
        );
      }
      fill(root, 'Newsroom', 'https://news.test/rss.xml');
      await click(within(root).getByRole('button', { name: 'Add source' }));
      expect(mockToast).toHaveBeenCalledWith(text, 'warning');
      expect(mockToast.mock.calls.flat().join(' ')).not.toMatch(
        /server text|\d+ of \d+|upgrade|plan|billing|subscription/i
      );
      // the dialog stays open with what was typed
      expect(screen.getByRole('dialog', { name: 'Add source' })).toBeTruthy();
    }
  );

  it('UI2 a web page is created exactly as before', async () => {
    const root = await openAdd();
    fill(root, 'Page', 'https://news.test/page');
    await click(within(root).getByRole('button', { name: 'Add source' }));
    expect(calls().filter((c) => c.method !== 'GET')).toEqual([
      {
        method: 'POST',
        url: '/content-studio/sources',
        body: { kind: 'url', name: 'Page', url: 'https://news.test/page' },
      },
    ]);
  });
});

describe('Source Library: feeds in the list', () => {
  it('UI3 labels a feed Feed and a page Web page, with their own status and capture words', async () => {
    feed = summary({ lastCapturedAt: T1 });
    wrap(h(ContentStudioSources));
    await flush();
    const feedRow = row('Company newsroom');
    expect(within(feedRow).getByText('Feed')).toBeTruthy();
    expect(
      within(feedRow).getByText(`Last captured: ${date(T1)}`)
    ).toBeTruthy();
    expect(
      within(feedRow).getByRole('button', {
        name: 'Refresh feed Company newsroom',
      })
    ).toBeTruthy();
    const pageRow = row('Launch post');
    expect(within(pageRow).getByText('Web page')).toBeTruthy();
    expect(within(pageRow).getByText('Version 2')).toBeTruthy();
    expect(
      within(pageRow).getByRole('button', { name: 'Refresh Launch post' })
    ).toBeTruthy();
  });

  it('a feed never captured says so and offers Capture feed', async () => {
    wrap(h(ContentStudioSources));
    await flush();
    const feedRow = row('Company newsroom');
    expect(within(feedRow).getByText('Not captured yet')).toBeTruthy();
    expect(
      within(feedRow).getByRole('button', {
        name: 'Capture feed Company newsroom',
      })
    ).toBeTruthy();
  });
});

describe('Source Library: a feed', () => {
  const renderFeed = async () => {
    wrap(h(ContentStudioSourceDetail, { sourceId: FEED_ID }));
    await flush();
  };

  it('UI4 shows the feed capture, never a version history, and captures through the one refresh route', async () => {
    await renderFeed();
    expect(screen.getByRole('heading', { name: 'Feed capture' })).toBeTruthy();
    expect(
      screen.queryByRole('heading', { name: 'Version history' })
    ).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'Current capture' })
    ).toBeNull();
    // its interval (P8-C4): the default
    expect(
      screen.getByText('Automatic capture', { selector: 'dt' })
        .nextElementSibling!.textContent
    ).toBe('Every hour (default)');
    await click(
      screen.getByRole('button', { name: 'Capture feed Company newsroom' })
    );
    expect(calls().filter((c) => c.method !== 'GET')).toEqual([
      {
        method: 'POST',
        url: `/content-studio/sources/${FEED_ID}/refresh`,
        body: undefined,
      },
    ]);
    // what the capture did, in fixed words and counts
    expect(mockToast).toHaveBeenCalledWith(
      'Feed captured. Pages found: 23. New sources: 4. New versions: 6. Pages not captured this time: 2.',
      'success'
    );
    // the feed and its pages reload
    expect(
      calls().filter(
        (c) =>
          c.method === 'GET' &&
          c.url.startsWith(`/content-studio/sources/${FEED_ID}/discoveries`)
      ).length
    ).toBeGreaterThan(1);
    expect(
      screen.getByRole('button', { name: 'Refresh feed Company newsroom' })
    ).toBeTruthy();
  });

  it('UI5/UI6/119 lists the pages it found as links to their own source, with published, found and last seen', async () => {
    await renderFeed();
    expect(
      screen.getByRole('heading', { name: 'Pages found in this feed' })
    ).toBeTruthy();
    expect(screen.getByText('Pages found: 51')).toBeTruthy();
    const first = screen.getByRole('link', {
      name: '<img src=x onerror=alert(1)><b>Bold</b> launch',
    });
    expect(first.getAttribute('href')).toBe(
      `/content-studio/sources/${PAGE_ID}`
    );
    const item = first.closest('li') as HTMLElement;
    // P8-02: the row News Radar shares
    expect(within(item).getByText(`Published ${date(T1)}`)).toBeTruthy();
    expect(within(item).getByText(`Found ${date(T1)}`)).toBeTruthy();
    expect(within(item).getByText(`Last seen ${date(T2)}`)).toBeTruthy();
    expect(within(item).getByText('Captured')).toBeTruthy();
    expect(within(item).queryByText('Archived')).toBeNull();
    // no entry title: the page source's name; no date: said so
    const second = screen.getByRole('link', { name: 'news.test' });
    expect(second.getAttribute('href')).toBe(
      `/content-studio/sources/${PAGE_2_ID}`
    );
    const secondItem = second.closest('li') as HTMLElement;
    expect(within(secondItem).getByText('Published Unknown')).toBeTruthy();
    expect(within(secondItem).getByText('Not captured')).toBeTruthy();
    expect(within(secondItem).queryByText(/failed/i)).toBeNull();
    // pages of pages
    expect(screen.getByRole('button', { name: /next/i })).toBeTruthy();
  });

  it('FEB2-5 the pages of a feed say Changed, with when, exactly as the server answers each row (P8-04B2)', async () => {
    const T3 = '2026-10-21T11:45:00.000Z';
    discoveries = discoveries.map((d, i) => ({
      ...d,
      changedSinceFound: i === 0,
      source: {
        ...(d.source as Record<string, unknown>),
        lastPageChangeAt: T3,
      },
    }));
    await renderFeed();
    const changed = row('<img src=x onerror=alert(1)><b>Bold</b> launch');
    expect(within(changed).getByText('Changed')).toBeTruthy();
    expect(within(changed).getByText(`Changed ${date(T3)}`)).toBeTruthy();
    expect(within(changed).getByText(`Last seen ${date(T2)}`)).toBeTruthy();
    const unchanged = row('news.test');
    expect(within(unchanged).queryByText(/Changed/)).toBeNull();
  });

  it('UI8 an entry title with markup is plain text: no element is made from it', async () => {
    await renderFeed();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('li b')).toBeNull();
    expect(screen.getByText(HTML_TITLE)).toBeTruthy();
  });

  it('UI7 loading, error with retry, and empty before and after a capture', async () => {
    let answer: ((r: Reply) => void) | null = null;
    override = (method, url) =>
      method === 'GET' && url.includes('/discoveries')
        ? new Promise<Reply>((resolve) => (answer = resolve))
        : undefined;
    await renderFeed();
    expect(screen.queryByRole('link', { name: 'news.test' })).toBeNull();
    await act(async () =>
      answer!(reply(500, { msg: 'x', code: 'CS_SOURCE_INTEGRITY_ERROR' }))
    );
    await flush();
    expect(screen.getByRole('alert').textContent).toContain(
      'The pages of this feed could not be loaded.'
    );
    override = () => undefined;
    discoveries = [];
    await click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      screen.getByText('No pages yet. Capture the feed to find its pages.')
    ).toBeTruthy();
    cleanup();
    feed = summary({ lastCapturedAt: T1 });
    await renderFeed();
    expect(
      screen.getByText('The last capture found no pages with an HTTPS link.')
    ).toBeTruthy();
  });

  it('FE20 a live feed links to its own News Radar; an archived one does not', async () => {
    await renderFeed();
    expect(
      screen
        .getByRole('link', { name: 'Show in News Radar' })
        .getAttribute('href')
    ).toBe(`/content-studio/research?feed=${FEED_ID}`);
    cleanup();
    feed = summary({ archivedAt: T1 });
    await renderFeed();
    expect(
      screen.queryByRole('link', { name: 'Show in News Radar' })
    ).toBeNull();
  });

  it('an archived feed shows automatic capture paused and offers no capture', async () => {
    feed = summary({ archivedAt: T1 });
    await renderFeed();
    expect(screen.getByText('Paused while archived')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Capture feed|Refresh feed/ })
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Restore Company newsroom' })
    ).toBeTruthy();
  });

  it('a web page source never asks for discoveries', async () => {
    wrap(h(ContentStudioSourceDetail, { sourceId: PAGE_ID }));
    await flush();
    expect(calls().filter((c) => c.url.includes('/discoveries'))).toEqual([]);
    expect(
      screen.getByRole('heading', { name: 'Version history' })
    ).toBeTruthy();
  });

  it('FE4/FE6 a capture without limited pages reads exactly as before', async () => {
    await renderFeed();
    await click(
      screen.getByRole('button', { name: 'Capture feed Company newsroom' })
    );
    expect(mockToast.mock.calls[0][0]).not.toContain('Pages not added');
  });

  it('FE5/M30 new pages past the source limit are counted in the capture, apart from failures', async () => {
    override = (method, url) =>
      method === 'POST' && url.endsWith('/refresh')
        ? reply(200, {
            source: feed,
            capture: {
              entriesSeen: 5,
              entriesIgnored: 0,
              entriesSkipped: 0,
              entriesAccepted: 2,
              sourcesCreated: 0,
              versionsCreated: 1,
              unchanged: 1,
              failed: 0,
              archived: 0,
              entriesLimited: 3,
            },
          })
        : undefined;
    await renderFeed();
    await click(
      screen.getByRole('button', { name: 'Capture feed Company newsroom' })
    );
    expect(mockToast).toHaveBeenCalledWith(
      'Feed captured. Pages found: 2. New sources: 0. New versions: 1. Pages not added because the organization reached its source limit: 3.',
      'success'
    );
  });

  it('FE3 a feed captured a moment ago says so', async () => {
    override = (method, url) =>
      method === 'POST' && url.endsWith('/refresh')
        ? reply(429, {
            msg: 'server text',
            code: 'CS_SOURCE_REFRESH_TOO_SOON',
          })
        : undefined;
    await renderFeed();
    await click(
      screen.getByRole('button', { name: 'Capture feed Company newsroom' })
    );
    expect(mockToast).toHaveBeenCalledWith(
      'This source was captured a moment ago. Try again in a few minutes.',
      'warning'
    );
  });

  it('a feed that cannot be read has its own fixed message', async () => {
    override = (method, url) =>
      method === 'POST' && url.endsWith('/refresh')
        ? reply(422, {
            msg: 'server text https://x.test',
            code: 'CS_SOURCE_FEED_INVALID',
          })
        : undefined;
    await renderFeed();
    await click(
      screen.getByRole('button', { name: 'Capture feed Company newsroom' })
    );
    expect(mockToast).toHaveBeenCalledWith(
      'This address did not answer with an RSS or Atom feed that can be read.',
      'warning'
    );
  });
});

// A feed's capture history (P8-O1): what each scheduled capture or refresh
// did, as the server recorded it
describe('Source Library: a feed capture history', () => {
  const renderFeed = async () => {
    wrap(h(ContentStudioSourceDetail, { sourceId: FEED_ID }));
    await flush();
  };
  const history = () =>
    screen.getByRole('heading', { name: 'Capture history' })
      .parentElement as HTMLElement;
  const COUNTS = {
    entriesSeen: 30,
    entriesIgnored: 5,
    entriesSkipped: 2,
    entriesAccepted: 12,
    sourcesCreated: 1,
    versionsCreated: 4,
    unchanged: 7,
    failed: 1,
    archived: 0,
    entriesLimited: 0,
  };
  const capture = (over: Record<string, unknown>) => ({
    id: `c-${Math.random()}`,
    trigger: 'scheduled',
    status: 'success',
    startedAt: T1,
    finishedAt: T1,
    durationMs: 2400,
    attemptCount: 1,
    errorCode: null,
    summary: COUNTS,
    nextCaptureAtAfter: T2,
    consecutiveFailuresAfter: 0,
    ...over,
  });
  const rows = () => within(history()).queryAllByRole('listitem');

  it('UI1/UI3 a feed has a Capture history section, empty until its first capture', async () => {
    await renderFeed();
    expect(within(history()).getByText('No capture history yet.')).toBeTruthy();
    expect(calls().filter((c) => c.url.includes('/captures'))).toEqual([
      {
        method: 'GET',
        url: `/content-studio/sources/${FEED_ID}/captures?page=1`,
        body: undefined,
      },
    ]);
  });

  it('UI2 a web page source has no capture history and never asks for one', async () => {
    wrap(h(ContentStudioSourceDetail, { sourceId: PAGE_ID }));
    await flush();
    expect(
      screen.queryByRole('heading', { name: 'Capture history' })
    ).toBeNull();
    expect(calls().filter((c) => c.url.includes('/captures'))).toEqual([]);
  });

  it('UI4/UI8/UI9 a scheduled success: its time, trigger, duration and counts', async () => {
    captures = [capture({})];
    await renderFeed();
    const [row] = rows();
    expect(row.textContent).toContain('Captured successfully');
    expect(row.textContent).toContain('Scheduled');
    expect(row.textContent).toContain(date(T1));
    expect(row.textContent).toContain('2.4s');
    expect(row.textContent).toContain(
      'Pages found: 12 · New versions: 4 · Unchanged: 7 · Pages not captured this time: 1'
    );
    expect(row.textContent).not.toContain('Tries');
    expect(row.textContent).not.toContain('source limit');
  });

  it('UI5 a manual success reads Manual; limited pages are counted apart', async () => {
    captures = [
      capture({
        trigger: 'manual',
        summary: { ...COUNTS, failed: 0, entriesLimited: 3 },
      }),
    ];
    await renderFeed();
    const [row] = rows();
    expect(row.textContent).toContain('Manual');
    expect(row.textContent).not.toContain('Scheduled');
    expect(row.textContent).toContain(
      'Pages not added because the organization reached its source limit: 3'
    );
    expect(row.textContent).not.toContain('Pages not captured this time');
  });

  it('UI6/UI14 a failure of the feed reads as fixed words, with its tries and next try, never the code or a server message', async () => {
    captures = [
      capture({
        status: 'source_failed',
        errorCode: 'CS_SOURCE_FETCH_FAILED',
        summary: null,
        attemptCount: 3,
        durationMs: 272_000,
        nextCaptureAtAfter: T2,
        consecutiveFailuresAfter: 1,
        msg: 'server text https://x.test',
        stack: 'Error: at line 1',
      }),
    ];
    await renderFeed();
    const [row] = rows();
    expect(row.textContent).toContain('Failed');
    expect(row.textContent).toContain('The feed could not be fetched.');
    expect(row.textContent).toContain(`Next try after ${date(T2)}.`);
    expect(row.textContent).toContain('Tries: 3');
    expect(row.textContent).toContain('4m 32s');
    expect(row.textContent).not.toMatch(/CS_|server text|https|Error:/);
  });

  it('UI6 an unknown code is a capture that failed; a member refresh that failed promises no next try', async () => {
    captures = [
      capture({
        trigger: 'manual',
        status: 'source_failed',
        errorCode: 'CS_SOURCE_SOMETHING_NEW',
        summary: null,
        consecutiveFailuresAfter: 0,
      }),
    ];
    await renderFeed();
    const [row] = rows();
    expect(row.textContent).toContain('The capture failed.');
    expect(row.textContent).not.toContain('Next try');
    expect(row.textContent).not.toContain('CS_');
  });

  it('UI7 a failure of the system has its own words: the feed itself may be fine', async () => {
    captures = [capture({ status: 'infrastructure_failed', summary: null })];
    await renderFeed();
    const [row] = rows();
    expect(row.textContent).toContain('System problem');
    expect(row.textContent).toContain(
      'Capture could not complete because of a temporary system problem. The feed itself may be fine.'
    );
    expect(row.textContent).not.toContain('The feed could not be fetched.');
  });

  it('a running capture is in progress; one the server reports interrupted says no result was recorded', async () => {
    captures = [
      capture({
        status: 'running',
        finishedAt: null,
        durationMs: null,
        summary: null,
        nextCaptureAtAfter: null,
        consecutiveFailuresAfter: null,
      }),
      capture({
        status: 'interrupted',
        finishedAt: null,
        durationMs: null,
        summary: null,
        nextCaptureAtAfter: null,
        consecutiveFailuresAfter: null,
      }),
    ];
    await renderFeed();
    const [running, interrupted] = rows();
    expect(running.textContent).toContain('Capture in progress');
    expect(running.textContent).not.toMatch(/\ds\b/);
    expect(interrupted.textContent).toContain('Capture interrupted');
    expect(interrupted.textContent).toContain(
      'No result was recorded for this capture.'
    );
  });

  it('UI8 durations: under a second, tenths of seconds, minutes and seconds', async () => {
    const { formatCaptureDuration } = require('./content-studio.source.detail');
    expect(formatCaptureDuration(0)).toBe('<1s');
    expect(formatCaptureDuration(999)).toBe('<1s');
    expect(formatCaptureDuration(1000)).toBe('1.0s');
    expect(formatCaptureDuration(2400)).toBe('2.4s');
    expect(formatCaptureDuration(59_999)).toBe('59.9s');
    expect(formatCaptureDuration(60_000)).toBe('1m 0s');
    expect(formatCaptureDuration(72_000)).toBe('1m 12s');
  });

  it('UI10 a longer history is paged by the server, 20 at a time', async () => {
    captures = Array.from({ length: 20 }, (_, i) => capture({ id: `c${i}` }));
    await renderFeed();
    expect(rows()).toHaveLength(20);
    await click(within(history()).getByRole('button', { name: /next/i }));
    expect(calls().map((c) => c.url)).toContain(
      `/content-studio/sources/${FEED_ID}/captures?page=2`
    );
  });

  it('UI11/UI12 an archived or paused feed keeps its history', async () => {
    captures = [capture({})];
    feed = summary({ archivedAt: T1 });
    await renderFeed();
    expect(rows()).toHaveLength(1);
    cleanup();
    feed = summary({ scanPausedAt: T1 });
    await renderFeed();
    expect(rows()).toHaveLength(1);
  });

  it('UI13 a refresh, whether it succeeds or fails, reads the history again', async () => {
    await renderFeed();
    const before = calls().filter((c) => c.url.includes('/captures')).length;
    await click(
      screen.getByRole('button', { name: 'Capture feed Company newsroom' })
    );
    const afterSuccess = calls().filter((c) =>
      c.url.includes('/captures')
    ).length;
    expect(afterSuccess).toBeGreaterThan(before);
    override = (method, url) =>
      method === 'POST' && url.endsWith('/refresh')
        ? reply(502, { msg: 'x', code: 'CS_SOURCE_FETCH_FAILED' })
        : undefined;
    await click(
      screen.getByRole('button', { name: /Refresh feed Company newsroom/ })
    );
    expect(
      calls().filter((c) => c.url.includes('/captures')).length
    ).toBeGreaterThan(afterSuccess);
  });

  it('UI15 a history that cannot be loaded says so and can be tried again', async () => {
    override = (method, url) =>
      method === 'GET' && url.includes('/captures')
        ? reply(500, { msg: 'x', code: 'CS_SOURCE_INTEGRITY_ERROR' })
        : undefined;
    await renderFeed();
    expect(within(history()).getByRole('alert').textContent).toContain(
      'The capture history could not be loaded.'
    );
    override = () => undefined;
    await click(within(history()).getByRole('button', { name: 'Try again' }));
    expect(within(history()).getByText('No capture history yet.')).toBeTruthy();
  });

  // P8-G1: a feed that answered it had not changed since the capture before
  describe('a feed that had not changed (P8-G1)', () => {
    const ZERO = Object.fromEntries(Object.keys(COUNTS).map((k) => [k, 0]));

    it('G1-UI1/G1-UI4/G1-UI5 says No changes detected, with why, never a count, a status code or a validator', async () => {
      captures = [
        {
          ...capture({ notModified: true, summary: ZERO, durationMs: 300 }),
          // never shown, even if a server sent them
          httpEtag: 'W/"secret-etag"',
          httpLastModified: 'Sun, 18 Oct 2026 10:00:00 GMT',
        },
      ];
      await renderFeed();
      const [row] = rows();
      expect(row.textContent).toContain('No changes detected');
      expect(row.textContent).toContain(
        'The source reported that it has not changed since the previous capture.'
      );
      expect(row.textContent).toContain('Scheduled');
      expect(row.textContent).toContain('<1s');
      expect(row.textContent).not.toContain('Captured successfully');
      expect(row.textContent).not.toMatch(
        /Pages found|New versions|Unchanged|304|HTTP|Not Modified|etag|secret|GMT/i
      );
      expect(
        within(row).getByText('No changes detected').className
      ).not.toMatch(/font-\[600\]|textColor\/60/);
    });

    it('G1-UI2/G1-UI3 a success that was read, or one from before, reads as before', async () => {
      captures = [
        capture({ id: 'read', notModified: false }),
        capture({ id: 'older' }),
      ];
      await renderFeed();
      for (const row of rows()) {
        expect(row.textContent).toContain('Captured successfully');
        expect(row.textContent).toContain('Pages found: 12');
        expect(row.textContent).not.toContain('No changes detected');
      }
    });

    it('G1-UI6/G1-UI7 paging and failures are as they were', async () => {
      captures = [
        ...Array.from({ length: 10 }, (_, i) =>
          capture({ id: `n${i}`, notModified: true, summary: ZERO })
        ),
        ...Array.from({ length: 9 }, (_, i) => capture({ id: `r${i}` })),
        capture({
          id: 'failed',
          status: 'source_failed',
          errorCode: 'CS_SOURCE_FETCH_FAILED',
          summary: null,
          notModified: null,
        }),
      ];
      await renderFeed();
      expect(rows()).toHaveLength(20);
      expect(
        rows().filter((row) => row.textContent!.includes('No changes detected'))
      ).toHaveLength(10);
      const failed = rows()[19];
      expect(failed.textContent).toContain('Failed');
      expect(failed.textContent).toContain('The feed could not be fetched.');
      expect(failed.textContent).not.toContain('No changes detected');
    });

    it('G1-UI8 a member refresh the feed answered with not modified says so', async () => {
      override = (method, url) =>
        method === 'POST' && url.endsWith('/refresh')
          ? reply(200, { source: feed, capture: ZERO, notModified: true })
          : undefined;
      await renderFeed();
      await click(
        screen.getByRole('button', { name: 'Capture feed Company newsroom' })
      );
      expect(mockToast).toHaveBeenCalledWith(
        'Feed checked. No changes detected since its last capture.',
        'success'
      );
      // and one that was read, exactly as before
      mockToast.mockClear();
      override = (method, url) =>
        method === 'POST' && url.endsWith('/refresh')
          ? reply(200, {
              source: feed,
              capture: {
                ...ZERO,
                entriesSeen: 1,
                entriesAccepted: 1,
                unchanged: 1,
              },
              notModified: false,
            })
          : undefined;
      await click(
        screen.getByRole('button', {
          name: /(Capture|Refresh) feed Company newsroom/,
        })
      );
      expect(mockToast).toHaveBeenCalledWith(
        'Feed captured. Pages found: 1. New sources: 0. New versions: 0.',
        'success'
      );
    });
  });
});
