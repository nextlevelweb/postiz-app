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

// Feed pause in the Source Library (P8-C3): pause and resume a live feed,
// its Paused label, and that a paused feed stays an active feed that can be
// refreshed. A .spec.ts without JSX like the other Content Studio frontend
// specs; the server is an in-memory fake of the source routes

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
};
let feed: Summary;
let pageSource: Summary;
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
  lastCapturedAt: T1,
  scanPausedAt: null,
  ...over,
});

// The source routes as the server answers them: pause and resume change the
// feed's pause time only, the lists are split by archivedAt only
const server = (method: string, url: string): Reply => {
  const { pathname, searchParams } = new URL(url, 'https://api.test');
  if (method === 'GET' && pathname === '/content-studio/sources') {
    const archived = searchParams.get('archived') === 'true';
    return reply(200, {
      pages: 1,
      results: [feed, pageSource].filter((s) => !!s.archivedAt === archived),
    });
  }
  const one = [feed, pageSource].find(
    (s) => pathname === `/content-studio/sources/${s.id}`
  );
  if (method === 'GET' && one) {
    return reply(200, { ...one, currentVersion: null });
  }
  if (method === 'GET' && /\/(versions|discoveries)\?/.test(url)) {
    return reply(200, { pages: 0, total: 0, results: [] });
  }
  if (
    method === 'POST' &&
    pathname === `/content-studio/sources/${FEED_ID}/pause`
  ) {
    feed = { ...feed, scanPausedAt: feed.scanPausedAt ?? T2, updatedAt: T2 };
    return reply(200, feed);
  }
  if (
    method === 'POST' &&
    pathname === `/content-studio/sources/${FEED_ID}/resume`
  ) {
    feed = { ...feed, scanPausedAt: null, updatedAt: T2 };
    return reply(200, feed);
  }
  if (
    method === 'POST' &&
    pathname === `/content-studio/sources/${FEED_ID}/refresh`
  ) {
    feed = { ...feed, lastCapturedAt: T2, updatedAt: T2 };
    return reply(200, {
      source: feed,
      capture: {
        entriesSeen: 3,
        entriesIgnored: 0,
        entriesSkipped: 0,
        entriesAccepted: 3,
        sourcesCreated: 1,
        versionsCreated: 1,
        unchanged: 2,
        failed: 0,
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
    body: init?.body,
  }));
const writes = () => calls().filter((c) => c.method !== 'GET');
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
const renderFeed = async (id = FEED_ID) => {
  wrap(h(ContentStudioSourceDetail, { sourceId: id }));
  await flush();
};
const button = (name: string) => screen.queryByRole('button', { name });
const row = (name: string) =>
  screen.getAllByRole('link', { name })[0].closest('li') as HTMLElement;

beforeEach(() => {
  mockModals.set([]);
  feed = summary({});
  pageSource = summary({
    id: PAGE_ID,
    kind: 'url',
    name: 'Launch post',
    canonicalUrl: 'https://news.test/launch',
    latestVersionNumber: 2,
    lastCapturedAt: null,
  });
  override = () => undefined;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    const custom = await override(method, url);
    if (custom) {
      return custom;
    }
    return server(method, url);
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

describe('Source Library: pausing a feed (P8-C3)', () => {
  it('UI1/M25 a running feed offers Pause feed and says it is captured about every hour', async () => {
    await renderFeed();
    expect(button('Pause feed Company newsroom')).toBeTruthy();
    expect(button('Resume feed Company newsroom')).toBeNull();
    expect(screen.getByText('About every hour')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.queryByText('Paused')).toBeNull();
    expect(
      screen.queryByText(
        'Automatic scans are paused. You can still refresh this feed manually.'
      )
    ).toBeNull();
  });

  it('UI6/M1/M26 Pause feed posts to the pause route with no body, says so, and shows the feed paused', async () => {
    await renderFeed();
    await click(button('Pause feed Company newsroom')!);
    expect(writes()).toEqual([
      {
        method: 'POST',
        url: `/content-studio/sources/${FEED_ID}/pause`,
        body: undefined,
      },
    ]);
    expect(mockToast).toHaveBeenCalledWith('Feed paused.', 'success');
    // the feed reloads from the server
    expect(button('Resume feed Company newsroom')).toBeTruthy();
    expect(button('Pause feed Company newsroom')).toBeNull();
  });

  it('UI2/UI3/UI5/M23/M24 a paused feed says Paused, offers Resume feed, and keeps its refresh', async () => {
    feed = summary({ scanPausedAt: T2 });
    await renderFeed();
    expect(screen.getAllByText('Paused').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('Active')).toBeNull();
    expect(screen.queryByText('Archived')).toBeNull();
    expect(screen.queryByText('About every hour')).toBeNull();
    expect(
      screen.getByText(
        'Automatic scans are paused. You can still refresh this feed manually.'
      )
    ).toBeTruthy();
    expect(button('Resume feed Company newsroom')).toBeTruthy();
    expect(button('Refresh feed Company newsroom')).toBeTruthy();
    // not error, warning or destructive: the plain label of a status
    const badge = screen
      .getAllByText('Paused')
      .find((el) => el.tagName === 'SPAN')!;
    expect(badge.className).not.toMatch(/red|error|danger|warning|yellow/);
    // still a live feed: archive and News Radar stay
    expect(button('Archive Company newsroom')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Show in News Radar' })
    ).toBeTruthy();
  });

  it('UI5/MR1/MR3 refreshing a paused feed captures it and leaves it paused', async () => {
    feed = summary({ scanPausedAt: T2 });
    await renderFeed();
    await click(button('Refresh feed Company newsroom')!);
    expect(writes()).toEqual([
      {
        method: 'POST',
        url: `/content-studio/sources/${FEED_ID}/refresh`,
        body: undefined,
      },
    ]);
    expect(mockToast.mock.calls[0]).toEqual([
      expect.stringMatching(/^Feed captured\./),
      'success',
    ]);
    expect(button('Resume feed Company newsroom')).toBeTruthy();
  });

  it('UI7 Resume feed posts to the resume route, says so, and shows the feed running again', async () => {
    feed = summary({ scanPausedAt: T2 });
    await renderFeed();
    await click(button('Resume feed Company newsroom')!);
    expect(writes()).toEqual([
      {
        method: 'POST',
        url: `/content-studio/sources/${FEED_ID}/resume`,
        body: undefined,
      },
    ]);
    expect(mockToast).toHaveBeenCalledWith('Feed resumed.', 'success');
    expect(button('Pause feed Company newsroom')).toBeTruthy();
    expect(screen.getByText('About every hour')).toBeTruthy();
  });

  it('UI8 a refused pause is shown with the fixed message of its code, never the server text', async () => {
    override = (method, url) =>
      method === 'POST' && url.endsWith('/pause')
        ? reply(409, { msg: 'server text', code: 'CS_SOURCE_ARCHIVED' })
        : undefined;
    await renderFeed();
    await click(button('Pause feed Company newsroom')!);
    expect(mockToast).toHaveBeenCalledWith(
      'This source is archived.',
      'warning'
    );
    expect(JSON.stringify(mockToast.mock.calls)).not.toContain('server text');
    expect(button('Pause feed Company newsroom')).toBeTruthy();
  });

  it('one action at a time: a double click sends one pause', async () => {
    let release!: () => void;
    override = (method, url) =>
      method === 'POST' && url.endsWith('/pause')
        ? new Promise<Reply>((resolve) => {
            release = () => resolve(server(method, url));
          })
        : undefined;
    await renderFeed();
    const pause = button('Pause feed Company newsroom')!;
    fireEvent.click(pause);
    fireEvent.click(pause);
    await flush();
    expect(
      button('Refresh feed Company newsroom')!.hasAttribute('disabled')
    ).toBe(true);
    release();
    await flush();
    expect(writes()).toHaveLength(1);
  });

  it('UI9/M22 a web page has no pause or resume', async () => {
    await renderFeed(PAGE_ID);
    expect(screen.getByText('Active')).toBeTruthy();
    expect(button('Pause feed Launch post')).toBeNull();
    expect(button('Resume feed Launch post')).toBeNull();
    expect(screen.queryByText('Paused')).toBeNull();
    // even if a server ever answered a time for one
    cleanup();
    pageSource = { ...pageSource, scanPausedAt: T2 };
    await renderFeed(PAGE_ID);
    expect(screen.queryByText('Paused')).toBeNull();
    expect(button('Resume feed Launch post')).toBeNull();
  });

  it('an archived feed offers Restore only, paused or not; restored paused, it says Paused', async () => {
    feed = summary({ archivedAt: T1, scanPausedAt: T2 });
    await renderFeed();
    expect(screen.getByText('Archived')).toBeTruthy();
    expect(screen.getByText('Paused while archived')).toBeTruthy();
    expect(screen.queryByText('Paused')).toBeNull();
    expect(button('Pause feed Company newsroom')).toBeNull();
    expect(button('Resume feed Company newsroom')).toBeNull();
    expect(button('Restore Company newsroom')).toBeTruthy();
    cleanup();
    // what a restore answers: live again, still paused
    feed = summary({ scanPausedAt: T2 });
    await renderFeed();
    expect(screen.getAllByText('Paused').length).toBeGreaterThanOrEqual(1);
    expect(button('Resume feed Company newsroom')).toBeTruthy();
  });
});

describe('Source Library: a paused feed in the list (P8-C3)', () => {
  it('UI4/M21 a paused feed stays with the active sources, labelled Paused; it is not archived', async () => {
    feed = summary({ scanPausedAt: T2 });
    wrap(h(ContentStudioSources));
    await flush();
    const item = row('Company newsroom');
    expect(within(item).getByText('Paused')).toBeTruthy();
    expect(
      within(item).getByRole('button', {
        name: 'Refresh feed Company newsroom',
      })
    ).toBeTruthy();
    expect(
      within(item).getByRole('button', { name: 'Archive Company newsroom' })
    ).toBeTruthy();
    expect(within(row('Launch post')).queryByText('Paused')).toBeNull();
    await click(screen.getByRole('button', { name: 'Archived' }));
    expect(screen.queryByRole('link', { name: 'Company newsroom' })).toBeNull();
    expect(screen.getByText('No archived sources.')).toBeTruthy();
  });

  it('a running feed in the list has no Paused label', async () => {
    wrap(h(ContentStudioSources));
    await flush();
    expect(within(row('Company newsroom')).queryByText('Paused')).toBeNull();
  });
});
