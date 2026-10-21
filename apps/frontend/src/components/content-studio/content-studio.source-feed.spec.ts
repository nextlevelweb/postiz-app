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
};
let feed: Summary;
let pageSource: Summary;
let discoveries: Array<Record<string, unknown>>;
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
      source: {
        id: PAGE_ID,
        name: 'Launch post',
        canonicalUrl: 'https://news.test/launch',
        latestVersionNumber: 2,
        archivedAt: null,
      },
    },
    {
      id: 'd2',
      entryTitle: null,
      publishedAt: null,
      firstSeenAt: T0,
      lastSeenAt: T2,
      source: {
        id: PAGE_2_ID,
        name: 'news.test',
        canonicalUrl: 'https://news.test/older',
        latestVersionNumber: 0,
        archivedAt: null,
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
    expect(screen.getByText('About every hour')).toBeTruthy();
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

  it('UI5/UI6/119 lists the pages it found as links to their own source, with published, first and last seen', async () => {
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
    expect(within(item).getByText(`Published: ${date(T1)}`)).toBeTruthy();
    expect(within(item).getByText(`First seen: ${date(T1)}`)).toBeTruthy();
    expect(within(item).getByText(`Last seen: ${date(T2)}`)).toBeTruthy();
    expect(within(item).getByText('Version 2')).toBeTruthy();
    // no entry title: the page source's name; no date: said so
    const second = screen.getByRole('link', { name: 'news.test' });
    expect(second.getAttribute('href')).toBe(
      `/content-studio/sources/${PAGE_2_ID}`
    );
    const secondItem = second.closest('li') as HTMLElement;
    expect(
      within(secondItem).getByText('Published: No date in the feed')
    ).toBeTruthy();
    expect(within(secondItem).getByText('Not captured yet')).toBeTruthy();
    // pages of pages
    expect(screen.getByRole('button', { name: /next/i })).toBeTruthy();
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
