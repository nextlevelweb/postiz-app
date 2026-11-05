import React, {
  createElement as h,
  Fragment,
  StrictMode,
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
  waitFor,
} from '@testing-library/react';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { CalendarWeekProvider } from '@gitroom/frontend/components/launches/calendar.context';
dayjs.extend(utc);

// A .spec.ts without JSX: the frontend tsconfig (and so `next build`) skips
// src/**/*.spec.ts only. The opener is required, not imported, like
// LaunchesComponent below: the composer files it reaches use JSX the spec type
// check has no types for (styled-jsx). Both are type checked with the
// frontend tsconfig
const {
  ContentStudioHandoffOpener,
  ContentStudioPostOpener,
}: {
  ContentStudioHandoffOpener: React.FC;
  ContentStudioPostOpener: React.FC;
} = require('@gitroom/frontend/components/launches/content-studio.handoff.opener');

// --- URL: a tiny store behind next/navigation; replace() really changes it ---
const mockUrl = {
  pathname: '/launches',
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

// --- modals: the store's dedupe-by-id, and a host that mounts the children ---
type MockModal = { id: string; children: React.ReactNode } & Record<
  string,
  unknown
>;
const mockModals = {
  list: [] as MockModal[],
  listeners: new Set<() => void>(),
  set(list: MockModal[]) {
    this.list = list;
    this.listeners.forEach((listener) => listener());
  },
};
const mockSubscribeModals = (listener: () => void) => {
  mockModals.listeners.add(listener);
  return () => mockModals.listeners.delete(listener);
};
const mockOpenModal = jest.fn();
const mockCloseAll = jest.fn();
jest.mock('@gitroom/frontend/components/layout/new-modal', () => {
  const { useSyncExternalStore: useStore } = require('react');
  return {
    useModals: () => ({
      openModal: mockOpenModal,
      closeAll: mockCloseAll,
      closeById: jest.fn(),
      closeCurrent: jest.fn(),
    }),
    useIsModalOpen: (id: string) =>
      useStore(mockSubscribeModals, () =>
        mockModals.list.some((modal) => modal.id === id)
      ),
  };
});
const ModalHost = () => {
  const list = useSyncExternalStore(mockSubscribeModals, () => mockModals.list);
  return h(
    Fragment,
    null,
    list.map((modal) => h(Fragment, { key: modal.id }, modal.children))
  );
};
const closeModal = (id: string) =>
  act(() => mockModals.set(mockModals.list.filter((m) => m.id !== id)));

// --- calendar context: integrations and reloadCalendarView like the provider ---
const mockReloadCalendarView = jest.fn();
jest.mock('@gitroom/frontend/components/launches/calendar.context', () => {
  const R = require('react');
  const Context = R.createContext({
    integrations: [],
    reloadCalendarView: () => undefined,
  });
  return {
    CalendarWeekProvider: ({
      integrations,
      children,
    }: {
      integrations: unknown[];
      children: React.ReactNode;
    }) =>
      R.createElement(
        Context.Provider,
        { value: { integrations, reloadCalendarView: mockReloadCalendarView } },
        children
      ),
    useCalendar: () => R.useContext(Context),
  };
});

// the composer itself is not rendered: its props are recorded, and the
// existing post it edits (none for a handoff)
const mockAddEditModal = jest.fn();
const mockExistingData = jest.fn();
jest.mock('@gitroom/frontend/components/new-launch/add.edit.modal', () => ({
  AddEditModal: (props: unknown) => {
    mockAddEditModal(props);
    mockExistingData(
      require('@gitroom/frontend/components/launches/helpers/use.existing.data').useExistingData()
    );
    return null;
  },
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
  useT: () => (_key: string, fallback: string) => fallback,
}));
const mockDeleteDialog = jest.fn();
jest.mock('@gitroom/react/helpers/delete.dialog', () => ({
  deleteDialog: (...args: unknown[]) => mockDeleteDialog(...args),
}));

// --- LaunchesComponent's other imports, as stubs ---
const mockUseIntegrationList = jest.fn();
jest.mock(
  '@gitroom/frontend/components/launches/helpers/use.integration.list',
  () => ({ useIntegrationList: () => mockUseIntegrationList() })
);
const mockNewPost = jest.fn();
jest.mock('@gitroom/frontend/components/launches/new.post', () => ({
  NewPost: () => {
    mockNewPost();
    return null;
  },
}));
jest.mock(
  '@gitroom/frontend/components/launches/add.provider.component',
  () => ({
    AddProviderButton: () => null,
    CustomVariables: () => null,
  })
);
jest.mock('@gitroom/frontend/components/launches/filters', () => ({
  Filters: () => null,
}));
jest.mock('@gitroom/frontend/components/launches/calendar', () => ({
  Calendar: () => null,
}));
jest.mock('@gitroom/frontend/components/launches/generator/generator', () => ({
  GeneratorComponent: () => null,
}));
jest.mock('@gitroom/frontend/components/launches/menu/menu', () => ({
  Menu: () => null,
}));
jest.mock('@gitroom/frontend/components/onboarding/onboarding', () => ({
  Onboarding: () => null,
}));
jest.mock('@gitroom/frontend/components/layout/loading', () => ({
  LoadingComponent: () => 'loading',
}));
jest.mock('@gitroom/frontend/components/launches/helpers/dnd.provider', () => ({
  DNDProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('react-dnd', () => ({
  useDrag: () => [{}, jest.fn(), jest.fn()],
  useDrop: () => [{ isOver: false }, jest.fn()],
}));
jest.mock('@gitroom/frontend/components/layout/user.context', () => ({
  useUser: () => ({ tier: { ai: false } }),
}));
jest.mock('@gitroom/react/helpers/variable.context', () => ({
  useVariables: () => ({ billingEnabled: false }),
}));
jest.mock('@gitroom/helpers/utils/use.fire.events', () => ({
  useFireEvents: () => jest.fn(),
}));
jest.mock('@gitroom/react/helpers/safe.image', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@gitroom/react/helpers/image.with.fallback', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@gitroom/react/form/input', () => ({ Input: () => null }));
jest.mock('@gitroom/react/form/button', () => ({ Button: () => null }));
// ESM only; the real modal store (below) imports it
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: () => undefined }));

// --- fixtures ---
let idCounter = 0;
// a fresh valid id per test, so no test depends on another's guard
const newId = () => (++idCounter).toString(16).padStart(64, 'a');

const INTEGRATIONS = [
  { id: 'int_1', name: 'Account one', identifier: 'x', disabled: false },
  { id: 'int_2', name: 'Account two', identifier: 'linkedin', disabled: false },
] as any[];
const ONLY_VALUES = [
  {
    content: '<p>First &lt;b&gt;bold&lt;/b&gt; line</p><p>second line</p>',
    image: [
      { id: 'media_2', path: 'https://cdn.example/uploads/second.png' },
      { id: 'media_1', path: '/uploads/first.png' },
    ],
  },
  { content: '<p>Second post</p>' },
  {
    content: '<p>Third post</p>',
    image: [{ id: 'media_3', path: '/uploads/third.mp4' }],
  },
];
const SLOT = '2026-10-12T14:30:00.000Z';

const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const handoffBody = (id: string) => ({
  id,
  packageId: 'pkg_secret',
  revisionId: 'rev_secret',
  revisionNumber: 3,
  expiresAt: '2026-10-13T10:00:00.000Z',
  onlyValues: ONLY_VALUES,
});
let handoffReply: (id: string) => unknown;
let slotReply: () => unknown;
// a post saved as a draft, as GET /posts/group/:group answers it
const SAVED_GROUP = '51766056-e439-4d14-892f-fdf34b26c5b5';
const groupBody = (group: string) => ({
  group,
  integration: 'int_2',
  integrationPicture: 'https://cdn.example/picture.png',
  settings: {},
  posts: [
    {
      id: 'post_1',
      group,
      state: 'DRAFT',
      content: '<p>Saved first post</p>',
      publishDate: '2026-11-25T07:20:00.000Z',
    },
  ],
});
let groupReply: (group: string) => unknown;

const handoffCalls = () =>
  mockFetch.mock.calls.filter(([url]) =>
    String(url).startsWith('/content-studio/handoffs/')
  );
const slotCalls = () =>
  mockFetch.mock.calls.filter(([url]) => url === '/posts/find-slot');
const composerOpens = () =>
  mockOpenModal.mock.calls.filter(([params]) => params.id === 'add-edit-modal');
const lastComposerProps = () =>
  mockAddEditModal.mock.calls[mockAddEditModal.mock.calls.length - 1][0];
const toasts = () => mockToast.mock.calls.map(([text]) => text);
const replaced = () => mockRouter.replace.mock.calls.map(([href]) => href);
const query = () => mockUrl.params.toString();

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

const Opener = ({ integrations = INTEGRATIONS }: { integrations?: any[] }) =>
  h(CalendarWeekProvider, {
    integrations,
    children: h(ContentStudioHandoffOpener),
  });
const renderOpener = (
  href: string,
  { strict = false, integrations = INTEGRATIONS } = {}
) => {
  setUrl(href);
  const tree = (list: any[]) => {
    const page = h(
      Fragment,
      null,
      h(ModalHost),
      h(Opener, { integrations: list })
    );
    return strict ? h(StrictMode, null, page) : page;
  };
  const view = render(tree(integrations));
  return {
    ...view,
    setIntegrations: (list: any[]) => view.rerender(tree(list)),
  };
};

const MESSAGES = {
  invalid: 'This Content Studio link is not valid',
  missing: 'This Content Studio handoff could not be found',
  gone: 'This Content Studio handoff has expired or was revoked. Open it again from Content Studio.',
  media:
    'Some media in this Content Studio post is not ready or is no longer available.',
  error: 'Could not open this Content Studio post',
  closeCurrent:
    'Close the post you are editing before opening this Content Studio post',
  connect: 'Connect a channel before opening this Content Studio post',
};

beforeEach(() => {
  mockModals.set([]);
  mockRouter.replace.mockImplementation((href: string) => setUrl(href));
  mockOpenModal.mockImplementation((params: MockModal) => {
    if (!mockModals.list.some((modal) => modal.id === params.id)) {
      mockModals.set([...mockModals.list, params]);
    }
  });
  handoffReply = (id) => reply(200, handoffBody(id));
  slotReply = () => reply(200, { date: SLOT });
  mockFetch.mockImplementation(async (url: string) =>
    url === '/posts/find-slot'
      ? slotReply()
      : url.startsWith('/posts/group/')
      ? groupReply(decodeURIComponent(url.replace('/posts/group/', '')))
      : handoffReply(url.replace('/content-studio/handoffs/', ''))
  );
  groupReply = (group) => reply(200, groupBody(group));
});

// A composer still open at the end of a test closes on unmount, a tick later:
// that close must land before the next test sets its URL
afterEach(async () => {
  cleanup();
  await flush();
});

describe('ContentStudioHandoffOpener: the URL', () => {
  it('O1 does nothing without a handoff parameter', async () => {
    renderOpener('/launches?msg=hello');
    await flush();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockOpenModal).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('O2 opens a 64 character lowercase hex handoff', async () => {
    const id = newId();
    renderOpener(`/launches?handoff=${id}`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));

    expect(handoffCalls()).toEqual([[`/content-studio/handoffs/${id}`]]);
  });

  it.each([
    ['uppercase', 'A'.repeat(64)],
    ['63 characters', 'a'.repeat(63)],
    ['65 characters', 'a'.repeat(65)],
    ['non hex', 'g'.repeat(64)],
    ['a uuid', '123e4567-e89b-12d3-a456-426614174000'],
    ['path like', `..%2F..%2Fposts%2F${'a'.repeat(64)}`],
    ['empty', ''],
  ])(
    'O3/O4 refuses a malformed id (%s) without a request, keeping other parameters',
    async (_name, bad) => {
      renderOpener(`/launches?msg=x&handoff=${bad}&added=y`);
      await flush();

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockOpenModal).not.toHaveBeenCalled();
      expect(toasts()).toEqual([MESSAGES.invalid]);
      expect(mockToast).toHaveBeenCalledWith(MESSAGES.invalid, 'warning');
      expect(replaced()).toEqual(['/launches?msg=x&added=y']);
      expect(query()).toBe('msg=x&added=y');
    }
  );

  it('O5 keeps every other parameter, in order, when it removes the handoff', async () => {
    renderOpener('/launches?display=week&handoff=BAD&customer=c1&msg=a%20b');
    await flush();

    expect(replaced()).toEqual(['/launches?display=week&customer=c1&msg=a+b']);
    expect(mockUrl.params.get('msg')).toBe('a b');
  });

  it('O6 leaves no trailing ? when the handoff was the only parameter', async () => {
    renderOpener('/launches?handoff=nope');
    await flush();

    expect(replaced()).toEqual(['/launches']);
  });

  it('uses the current pathname, not a hardcoded /launches', async () => {
    renderOpener('/p/launches?handoff=nope&x=1');
    await flush();

    expect(replaced()).toEqual(['/p/launches?x=1']);
  });

  it('never shows or sends the malformed id', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => null);
    renderOpener('/launches?handoff=SECRET-HANDOFF-VALUE');
    await flush();

    expect(JSON.stringify(mockToast.mock.calls)).not.toContain('SECRET');
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('ContentStudioHandoffOpener: integrations', () => {
  it('O8 with no channel: no request, asks to connect one, keeps the handoff', async () => {
    const id = newId();
    renderOpener(`/launches?handoff=${id}&msg=1`, { integrations: [] });
    await flush();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockOpenModal).not.toHaveBeenCalled();
    expect(toasts()).toEqual([MESSAGES.connect]);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockUrl.params.get('handoff')).toBe(id);
  });

  it('O9 opens once when a channel becomes available', async () => {
    const id = newId();
    const view = renderOpener(`/launches?handoff=${id}`, { integrations: [] });
    await flush();
    expect(mockFetch).not.toHaveBeenCalled();

    view.setIntegrations(INTEGRATIONS);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    view.setIntegrations([...INTEGRATIONS]);
    await flush();

    expect(handoffCalls()).toHaveLength(1);
    expect(composerOpens()).toHaveLength(1);
  });
});

describe('ContentStudioHandoffOpener: an open composer', () => {
  const openOtherPost = () =>
    act(() =>
      mockModals.set([
        ...mockModals.list,
        { id: 'add-edit-modal', children: 'post being written' },
      ])
    );

  it('O10 never replaces a composer that is already open', async () => {
    openOtherPost();
    const id = newId();
    renderOpener(`/launches?handoff=${id}`);
    await flush();

    expect(handoffCalls()).toHaveLength(0);
    expect(slotCalls()).toHaveLength(0);
    expect(mockOpenModal).not.toHaveBeenCalled();
    expect(mockCloseAll).not.toHaveBeenCalled();
    expect(mockModals.list).toEqual([
      { id: 'add-edit-modal', children: 'post being written' },
    ]);
    expect(toasts()).toEqual([MESSAGES.closeCurrent]);
    expect(mockUrl.params.get('handoff')).toBe(id);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('O11 opens the same handoff once the other post is closed', async () => {
    openOtherPost();
    const id = newId();
    renderOpener(`/launches?handoff=${id}`);
    await flush();
    expect(handoffCalls()).toHaveLength(0);

    closeModal('add-edit-modal');
    await waitFor(() => expect(composerOpens()).toHaveLength(1));

    expect(handoffCalls()).toEqual([[`/content-studio/handoffs/${id}`]]);
    expect(lastComposerProps().onlyValues).toEqual(ONLY_VALUES);
  });

  it('does not open over a post opened while the handoff was loading, and opens after it closes', async () => {
    const id = newId();
    let release!: () => void;
    handoffReply = (handoff) =>
      new Promise((resolve) => {
        release = () => resolve(reply(200, handoffBody(handoff)));
      });
    renderOpener(`/launches?handoff=${id}`);
    await flush();
    expect(handoffCalls()).toHaveLength(1);

    openOtherPost();
    await act(async () => release());
    await flush();

    expect(composerOpens()).toHaveLength(0);
    expect(mockModals.list.map((m) => m.children)).toEqual([
      'post being written',
    ]);
    expect(toasts()).toEqual([MESSAGES.closeCurrent]);
    expect(mockUrl.params.get('handoff')).toBe(id);

    handoffReply = (handoff) => reply(200, handoffBody(handoff));
    closeModal('add-edit-modal');
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    expect(handoffCalls()).toHaveLength(2);
  });
});

describe('ContentStudioHandoffOpener: opening', () => {
  it('O12-O19 fetches, finds a slot and opens the existing composer once', async () => {
    const id = newId();
    renderOpener(`/launches?handoff=${id}`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    await flush();

    // O12: request order and counts
    expect(mockFetch.mock.calls).toEqual([
      [`/content-studio/handoffs/${id}`],
      ['/posts/find-slot'],
    ]);
    expect(mockOpenModal).toHaveBeenCalledTimes(1);

    // O13 + the same modal options as "Create Post"
    const { children, ...options } = mockOpenModal.mock.calls[0][0];
    expect(options).toEqual({
      id: 'add-edit-modal',
      closeOnClickOutside: false,
      removeLayout: true,
      closeOnEscape: false,
      withCloseButton: false,
      askClose: true,
      fullScreen: true,
      classNames: { modal: 'w-[100%] max-w-[1400px] text-textColor' },
      size: '80%',
      title: '',
    });
    expect(children).toBeTruthy();

    const props = lastComposerProps();
    // exactly these props: no set, preselected channel, focus or close override
    expect(Object.keys(props).sort()).toEqual([
      'allIntegrations',
      'date',
      'integrations',
      'mutate',
      'onlyValues',
      'reopenModal',
    ]);

    // O14-O16: backend values untouched, thread and Media order kept
    expect(JSON.stringify(props.onlyValues)).toBe(JSON.stringify(ONLY_VALUES));
    expect(props.onlyValues).toHaveLength(3);
    expect(props.onlyValues.map((v: any) => v.content)).toEqual([
      '<p>First &lt;b&gt;bold&lt;/b&gt; line</p><p>second line</p>',
      '<p>Second post</p>',
      '<p>Third post</p>',
    ]);
    expect(props.onlyValues[0].image).toEqual([
      { id: 'media_2', path: 'https://cdn.example/uploads/second.png' },
      { id: 'media_1', path: '/uploads/first.png' },
    ]);
    expect('image' in props.onlyValues[1]).toBe(false);

    // O17: the integrations as NewPost passes them
    expect(props.integrations).toBe(INTEGRATIONS);
    expect(props.allIntegrations).toEqual(INTEGRATIONS);
    expect(props.allIntegrations[0]).not.toBe(INTEGRATIONS[0]);

    // O18: the slot, as NewPost converts it
    expect(props.date.toISOString()).toBe(SLOT);
    expect(props.date.isUTC()).toBe(false);
    expect(props.date.format()).toBe(dayjs.utc(SLOT).local().format());

    // O19
    expect(props.mutate).toBe(mockReloadCalendarView);
    expect(props.reopenModal()).toBeUndefined();
    expect(mockReloadCalendarView).not.toHaveBeenCalled();
  });

  it('O20/O21 keeps only the handoff id in the URL while the composer is open', async () => {
    const id = newId();
    renderOpener(`/launches?handoff=${id}&msg=1`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    await flush();

    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(query()).toBe(`handoff=${id}&msg=1`);
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('sends nothing but the handoff GET and the slot lookup (no save, schedule or selection)', async () => {
    const id = newId();
    renderOpener(`/launches?handoff=${id}`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    await flush();

    for (const [url, options] of mockFetch.mock.calls) {
      expect(['/posts/find-slot', `/content-studio/handoffs/${id}`]).toContain(
        url
      );
      expect(options).toBeUndefined();
    }
  });

  it('M10 guard: what reaches the composer is the backend answer only', async () => {
    const id = newId();
    const body = handoffBody(id);
    handoffReply = () => reply(200, body);
    renderOpener(
      `/launches?handoff=${id}&content=evil&image=%2Fevil.png&onlyValues=x`
    );
    await waitFor(() => expect(composerOpens()).toHaveLength(1));

    expect(lastComposerProps().onlyValues).toBe(body.onlyValues);
    expect(JSON.stringify(lastComposerProps())).not.toContain('evil');
  });
});

describe('ContentStudioHandoffOpener: duplicates', () => {
  it('O22/O37 under StrictMode: one GET, one slot, one modal, and the handoff stays', async () => {
    const id = newId();
    renderOpener(`/launches?handoff=${id}&msg=1`, { strict: true });
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    await flush();

    expect(handoffCalls()).toHaveLength(1);
    expect(slotCalls()).toHaveLength(1);
    expect(mockOpenModal).toHaveBeenCalledTimes(1);
    // the composer wrapper was mounted, unmounted and mounted again by
    // StrictMode, and still did not count that as a close
    expect(mockAddEditModal).toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(query()).toBe(`handoff=${id}&msg=1`);
  });

  it('O23/O24 rerenders, new integration arrays and remounts do not open it again', async () => {
    const id = newId();
    const view = renderOpener(`/launches?handoff=${id}`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));

    view.setIntegrations(INTEGRATIONS);
    view.setIntegrations([...INTEGRATIONS]);
    act(() => setUrl(`/launches?handoff=${id}&display=day`));
    await flush();
    // the launches tree reloading (its `reload` state) remounts the opener
    view.unmount();
    renderOpener(`/launches?handoff=${id}&display=day`);
    await flush();

    expect(handoffCalls()).toHaveLength(1);
    expect(mockOpenModal).toHaveBeenCalledTimes(1);
    // the opened composer is this handoff's own: no "close it" message
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('guards the request itself, not only the open composer', async () => {
    const id = newId();
    let release!: () => void;
    handoffReply = (handoff) =>
      new Promise((resolve) => {
        release = () => resolve(reply(200, handoffBody(handoff)));
      });
    const view = renderOpener(`/launches?handoff=${id}`);
    await flush();
    // no composer is open yet while the first request is in flight
    view.setIntegrations([...INTEGRATIONS]);
    view.unmount();
    renderOpener(`/launches?handoff=${id}`, { strict: true });
    await flush();
    expect(handoffCalls()).toHaveLength(1);

    await act(async () => release());
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    expect(handoffCalls()).toHaveLength(1);
  });

  it('O25 a different handoff after the first was closed opens normally', async () => {
    const first = newId();
    renderOpener(`/launches?handoff=${first}`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    closeModal('add-edit-modal');
    await flush();
    expect(query()).toBe('');

    const second = newId();
    act(() => setUrl(`/launches?handoff=${second}`));
    await waitFor(() => expect(composerOpens()).toHaveLength(2));
    expect(handoffCalls().map(([url]) => url)).toEqual([
      `/content-studio/handoffs/${first}`,
      `/content-studio/handoffs/${second}`,
    ]);
  });

  it('a handoff replaced in the URL while loading never opens', async () => {
    const first = newId();
    const second = newId();
    let release!: () => void;
    handoffReply = (handoff) =>
      handoff === first
        ? new Promise((resolve) => {
            release = () => resolve(reply(200, handoffBody(handoff)));
          })
        : reply(200, {
            ...handoffBody(handoff),
            onlyValues: [{ content: '<p>second</p>' }],
          });
    renderOpener(`/launches?handoff=${first}`);
    await flush();
    act(() => setUrl(`/launches?handoff=${second}`));
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    await act(async () => release());
    await flush();

    expect(composerOpens()).toHaveLength(1);
    expect(lastComposerProps().onlyValues).toEqual([
      { content: '<p>second</p>' },
    ]);
  });
});

describe('ContentStudioHandoffOpener: expected handoff errors', () => {
  const leaky = {
    msg: 'detail with media_1 and /uploads/first.png',
    items: [{ itemIndex: 0, mediaIndex: 1, reason: 'processing' }],
  };

  it.each([
    ['O27 404', 404, 'CS_NOT_FOUND', MESSAGES.missing],
    ['O28 410', 410, 'CS_HANDOFF_GONE', MESSAGES.gone],
    ['O29 400', 400, 'CS_MEDIA_UNAVAILABLE', MESSAGES.media],
  ])(
    '%s: fixed message, no composer, handoff removed and not retried',
    async (_name, status, code, message) => {
      const log = jest.fn();
      for (const level of ['error', 'warn', 'log', 'info'] as const) {
        jest.spyOn(console, level).mockImplementation(log);
      }
      const id = newId();
      handoffReply = () => reply(status, { ...leaky, code });
      const view = renderOpener(`/launches?msg=x&handoff=${id}&added=y`);
      await flush();

      expect(handoffCalls()).toHaveLength(1);
      expect(slotCalls()).toHaveLength(0);
      expect(mockOpenModal).not.toHaveBeenCalled();
      expect(mockToast.mock.calls).toEqual([[message, 'warning']]);
      expect(replaced()).toEqual(['/launches?msg=x&added=y']);

      // O30: nothing of the id or the body reaches the user or the console
      const shown = JSON.stringify([mockToast.mock.calls, log.mock.calls]);
      for (const secret of [
        id,
        'media_1',
        '/uploads',
        'processing',
        'detail',
      ]) {
        expect(shown).not.toContain(secret);
      }

      view.setIntegrations([...INTEGRATIONS]);
      await flush();
      expect(handoffCalls()).toHaveLength(1);
    }
  );
});

describe('ContentStudioHandoffOpener: unexpected errors', () => {
  const expectRetryable = async (
    view: ReturnType<typeof renderOpener>,
    id: string,
    requests: () => unknown[]
  ) => {
    expect(mockOpenModal).not.toHaveBeenCalled();
    expect(mockToast.mock.calls).toEqual([[MESSAGES.error, 'warning']]);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockUrl.params.get('handoff')).toBe(id);
    expect(JSON.stringify(mockToast.mock.calls)).not.toContain(id);

    // no retry loop by itself
    await flush();
    expect(requests()).toHaveLength(1);

    // the next attempt (a remount after a reload of the tree) tries again
    handoffReply = (handoff) => reply(200, handoffBody(handoff));
    slotReply = () => reply(200, { date: SLOT });
    view.unmount();
    renderOpener(`/launches?handoff=${id}`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    expect(requests()).toHaveLength(2);
  };

  it('O31 a 500 keeps the handoff and can be retried', async () => {
    const id = newId();
    handoffReply = () =>
      reply(500, { msg: 'boom', code: 'CS_STORED_REVISION_INVALID' });
    const view = renderOpener(`/launches?handoff=${id}`);
    await flush();
    expect(slotCalls()).toHaveLength(0);
    await expectRetryable(view, id, handoffCalls);
  });

  it('O31 a network failure keeps the handoff and can be retried', async () => {
    const id = newId();
    handoffReply = () => Promise.reject(new TypeError('Failed to fetch'));
    const view = renderOpener(`/launches?handoff=${id}`);
    await flush();
    await expectRetryable(view, id, handoffCalls);
  });

  it('a 404 without the Content Studio code (no such route) is not taken as final', async () => {
    const id = newId();
    handoffReply = () => reply(404, { message: 'Cannot GET', statusCode: 404 });
    const view = renderOpener(`/launches?handoff=${id}`);
    await flush();
    await expectRetryable(view, id, handoffCalls);
  });

  it('an unreadable success body keeps the handoff', async () => {
    const id = newId();
    handoffReply = () => ({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    });
    const view = renderOpener(`/launches?handoff=${id}`);
    await flush();
    await expectRetryable(view, id, handoffCalls);
  });

  it('O32 a failed slot lookup opens nothing and keeps the handoff', async () => {
    const id = newId();
    slotReply = () => reply(500, {});
    const view = renderOpener(`/launches?handoff=${id}`);
    await flush();
    expect(handoffCalls()).toHaveLength(1);
    expect(slotCalls()).toHaveLength(1);
    await expectRetryable(view, id, slotCalls);
  });

  it('O32 a rejected slot lookup opens nothing and keeps the handoff', async () => {
    const id = newId();
    slotReply = () => Promise.reject(new TypeError('Failed to fetch'));
    const view = renderOpener(`/launches?handoff=${id}`);
    await flush();
    await expectRetryable(view, id, slotCalls);
  });
});

describe('ContentStudioHandoffOpener: closing the composer', () => {
  it('O33-O35 the handoff stays while open and leaves the URL once on close, other parameters kept', async () => {
    const id = newId();
    renderOpener(`/launches?msg=abc&handoff=${id}&added=1`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    await flush();
    expect(mockUrl.params.get('handoff')).toBe(id);

    closeModal('add-edit-modal');
    await flush();

    expect(replaced()).toEqual(['/launches?msg=abc&added=1']);
    expect(query()).toBe('msg=abc&added=1');
    // closing doesn't fetch or open it again
    expect(handoffCalls()).toHaveLength(1);
    expect(mockOpenModal).toHaveBeenCalledTimes(1);
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('O36 closeAll after saving a post behaves the same', async () => {
    const id = newId();
    renderOpener(`/launches?handoff=${id}`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));

    act(() => mockModals.set([]));
    await flush();

    expect(replaced()).toEqual(['/launches']);
    expect(handoffCalls()).toHaveLength(1);
  });

  // activation flow 01: the first post comes back to its own page, which
  // then sees whether the post was scheduled
  it('a handoff of the first post goes back to the first post page when the composer closes', async () => {
    const id = newId();
    renderOpener(`/launches?handoff=${id}&return=first-post`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    act(() => mockModals.set([]));
    await flush();
    expect(mockRouter.push).toHaveBeenCalledWith('/content-studio/first-post');
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  // activation review 02: the way back is on the screen, not only the
  // browser's Back or the composer's close
  it('N3/N4/N5/NAV3 a first post handoff shows "Back to Content Studio", which asks, closes the composer and returns to the first post', async () => {
    mockCloseAll.mockImplementation(() => mockModals.set([]));
    const id = newId();
    renderOpener(`/launches?handoff=${id}&return=first-post`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    const back = screen.getByRole('button', { name: /Back to Content Studio/ });
    // not now: the composer stays
    mockDeleteDialog.mockResolvedValueOnce(false);
    fireEvent.click(back);
    await flush();
    expect(mockCloseAll).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
    // yes: closed, and back on the first post page
    mockDeleteDialog.mockResolvedValueOnce(true);
    fireEvent.click(back);
    await flush();
    expect(mockDeleteDialog.mock.calls[1][0]).toContain(
      'your Content Studio draft stays as it is'
    );
    expect(mockCloseAll).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith('/content-studio/first-post');
    // nothing was saved, scheduled or sent on the way
    expect(
      mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST')
    ).toEqual([]);
    mockCloseAll.mockReset();
  });

  it('a handoff without a known return page has no Back bar of its own', async () => {
    const id = newId();
    renderOpener(`/launches?handoff=${id}&return=${encodeURIComponent('/x')}`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    expect(
      screen.queryByRole('button', { name: /Back to Content Studio/ })
    ).toBeNull();
  });

  it('an unknown return page is ignored: only the fixed list, never an address from the URL', async () => {
    for (const page of [
      'https://evil.example',
      'constructor',
      '/content-studio',
    ]) {
      cleanup();
      mockRouter.push.mockClear();
      mockRouter.replace.mockClear();
      const id = newId();
      renderOpener(
        `/launches?handoff=${id}&return=${encodeURIComponent(page)}`
      );
      await waitFor(() => expect(composerOpens().length).toBeGreaterThan(0));
      act(() => mockModals.set([]));
      await flush();
      expect(mockRouter.push).not.toHaveBeenCalled();
      expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    }
  });

  it('O37 under StrictMode the URL is only cleaned on the real close', async () => {
    const id = newId();
    renderOpener(`/launches?handoff=${id}&msg=1`, { strict: true });
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    await flush();
    expect(mockRouter.replace).not.toHaveBeenCalled();

    closeModal('add-edit-modal');
    await flush();
    expect(replaced()).toEqual(['/launches?msg=1']);
  });

  it('leaves the URL alone when it already names another handoff', async () => {
    const id = newId();
    renderOpener(`/launches?handoff=${id}`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    const other = newId();
    act(() => setUrl(`/launches?handoff=${other}`));

    closeModal('add-edit-modal');
    await flush();

    expect(replaced()).not.toContain('/launches');
    await waitFor(() => expect(composerOpens()).toHaveLength(2));
  });
});

describe('ContentStudioHandoffOpener: reload model', () => {
  it('the same page load never refetches it; a fresh page load (fresh module) opens it again', async () => {
    const id = newId();
    renderOpener(`/launches?handoff=${id}`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));

    // the page goes away with the composer open
    cleanup();
    await flush();
    act(() => mockModals.set([]));
    setUrl(`/launches?handoff=${id}`);

    // the module of the old page still holds it
    renderOpener(`/launches?handoff=${id}`);
    await flush();
    expect(handoffCalls()).toHaveLength(1);
    cleanup();
    await flush();
    act(() => mockModals.set([]));
    setUrl(`/launches?handoff=${id}`);

    // a reload loads the module again: nothing remembered, same handoff opens
    let FreshOpener!: React.FC;
    jest.isolateModules(() => {
      jest.doMock('react', () => React);
      FreshOpener =
        require('@gitroom/frontend/components/launches/content-studio.handoff.opener').ContentStudioHandoffOpener;
    });
    expect(FreshOpener).not.toBe(ContentStudioHandoffOpener);
    render(
      h(
        Fragment,
        null,
        h(ModalHost),
        h(CalendarWeekProvider, {
          integrations: INTEGRATIONS,
          children: h(FreshOpener),
        })
      )
    );
    await waitFor(() => expect(composerOpens()).toHaveLength(2));
    expect(handoffCalls()).toHaveLength(2);
    expect(lastComposerProps().onlyValues).toEqual(ONLY_VALUES);
    expect(mockUrl.params.get('handoff')).toBe(id);
  });
});

describe('LaunchesComponent mounts the opener', () => {
  // its menu and channel files also use the browser extension `chrome` global
  const {
    LaunchesComponent,
  } = require('@gitroom/frontend/components/launches/launches.component');
  const source = readFileSync(
    join(__dirname, 'launches.component.tsx'),
    'utf8'
  );

  it('exactly once, inside the calendar provider, after the loading return', () => {
    expect(source.match(/<ContentStudioHandoffOpener\b/g)).toHaveLength(1);
    const loading = source.indexOf('if (isLoading || reload)');
    const provider = source.indexOf('<CalendarWeekProvider');
    const opener = source.indexOf('<ContentStudioHandoffOpener');
    const providerEnd = source.indexOf('</CalendarWeekProvider>');
    expect(loading).toBeGreaterThan(-1);
    expect(provider).toBeGreaterThan(loading);
    expect(opener).toBeGreaterThan(provider);
    expect(opener).toBeLessThan(providerEnd);
    // not inside a NewPost branch
    expect(opener).toBeLessThan(source.indexOf('<NewPost'));
  });

  it('O7 while integrations load: nothing is requested or shown', async () => {
    mockUseIntegrationList.mockReturnValue({
      isLoading: true,
      data: [],
      mutate: jest.fn(),
    });
    setUrl(`/launches?handoff=${newId()}`);
    render(h(Fragment, null, h(ModalHost), h(LaunchesComponent)));
    await flush();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('with no channels: one message (one opener), handoff kept', async () => {
    mockUseIntegrationList.mockReturnValue({
      isLoading: false,
      data: [],
      mutate: jest.fn(),
    });
    const id = newId();
    setUrl(`/launches?handoff=${id}`);
    render(h(LaunchesComponent));
    await flush();

    expect(toasts()).toEqual([MESSAGES.connect]);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUrl.params.get('handoff')).toBe(id);
  });

  it('once loaded: one handoff opened with the sorted integrations, while NewPost renders twice', async () => {
    const list = {
      isLoading: true,
      data: [] as any[],
      mutate: jest.fn(),
    };
    mockUseIntegrationList.mockImplementation(() => list);
    const id = newId();
    setUrl(`/launches?handoff=${id}`);
    const view = render(h(Fragment, null, h(ModalHost), h(LaunchesComponent)));
    await flush();
    expect(mockFetch).not.toHaveBeenCalled();

    list.isLoading = false;
    list.data = INTEGRATIONS;
    view.rerender(h(Fragment, null, h(ModalHost), h(LaunchesComponent)));
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    await flush();

    expect(handoffCalls()).toHaveLength(1);
    expect(mockNewPost.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(lastComposerProps().integrations.map((i: any) => i.id)).toEqual([
      'int_2',
      'int_1',
    ]);
  });
});

describe('useIsModalOpen (the real modal store)', () => {
  const actual = jest.requireActual(
    '@gitroom/frontend/components/layout/new-modal'
  ) as typeof import('@gitroom/frontend/components/layout/new-modal');

  it('follows opening and closing by id, and exposes no way to change the store', () => {
    const seen: boolean[] = [];
    let modals!: ReturnType<typeof actual.useModals>;
    const Probe = () => {
      seen.push(actual.useIsModalOpen('add-edit-modal'));
      modals = actual.useModals();
      return null;
    };
    render(h(Probe));
    expect(seen[seen.length - 1]).toBe(false);

    act(() => modals.openModal({ id: 'other', children: null }));
    expect(seen[seen.length - 1]).toBe(false);
    act(() => modals.openModal({ id: 'add-edit-modal', children: null }));
    expect(seen[seen.length - 1]).toBe(true);
    act(() => modals.closeById('add-edit-modal'));
    expect(seen[seen.length - 1]).toBe(false);
    act(() => modals.openModal({ id: 'add-edit-modal', children: null }));
    act(() => modals.closeAll());
    expect(seen[seen.length - 1]).toBe(false);

    expect(Object.keys(actual)).not.toContain('useModalStore');
  });
});

describe('opener source surface', () => {
  const source = readFileSync(
    join(__dirname, 'content-studio.handoff.opener.tsx'),
    'utf8'
  );

  it('leaves the composer store, storage and raw HTML alone', () => {
    expect(source).not.toMatch(/new-launch\/store|useLaunchStore/);
    expect(source).not.toMatch(
      /addGlobalValue|reset\(|setSelectedIntegrations/
    );
    expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML/);
    expect(source).not.toMatch(/console\.|alert\(/);
    expect(source).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
    expect(source).not.toMatch(/router\.(push|replace)\('\/launches/);
  });

  it('requests only the handoff, the slot and a saved post (read)', () => {
    const urls = source.match(/fetch\(([^)]*)\)/g);
    expect(urls).toEqual([
      'fetch(`/content-studio/handoffs/${id}`)',
      "fetch('/posts/find-slot')",
      'fetch(`/posts/group/${id}`)',
    ]);
  });
});

// activation review 04: a first post saved as a draft opens again, the same
// post, to schedule it
const renderPostOpener = (href: string, integrations = INTEGRATIONS) => {
  setUrl(href);
  return render(
    h(
      Fragment,
      null,
      h(ModalHost),
      h(CalendarWeekProvider, {
        integrations,
        children: h(ContentStudioPostOpener),
      })
    )
  );
};
const groupCalls = () =>
  mockFetch.mock.calls.filter(([url]) =>
    String(url).startsWith('/posts/group/')
  );

describe('ContentStudioPostOpener: the first post saved as a draft, opened again', () => {
  it('D7 opens the same saved post in the composer by its group, with its channel and its own date; nothing new is made or sent', async () => {
    renderPostOpener(`/launches?post=${SAVED_GROUP}&return=first-post`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    expect(groupCalls()).toEqual([[`/posts/group/${SAVED_GROUP}`]]);
    // no handoff, no slot: the post exists
    expect(handoffCalls()).toEqual([]);
    expect(slotCalls()).toEqual([]);
    const props = lastComposerProps();
    expect(props.integrations).toEqual([
      { ...INTEGRATIONS[1], picture: 'https://cdn.example/picture.png' },
    ]);
    expect(props.onlyValues).toBeUndefined();
    expect(props.date.toISOString()).toBe('2026-11-25T07:20:00.000Z');
    expect(props.draftForLater).toBe(true);
    // the composer edits that post: its group and its DRAFT state
    const existing =
      mockExistingData.mock.calls[mockExistingData.mock.calls.length - 1][0];
    expect(existing.group).toBe(SAVED_GROUP);
    expect(existing.posts[0].state).toBe('DRAFT');
    expect(mockFetch.mock.calls.filter(([, init]) => init?.method)).toEqual([]);
  });

  it('D7/NAV3 shows "Back to Content Studio" and what finishes the first post; closing returns to the first post page', async () => {
    renderPostOpener(`/launches?post=${SAVED_GROUP}&return=first-post`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    expect(
      screen.getByRole('button', { name: /Back to Content Studio/ })
    ).toBeTruthy();
    expect(
      screen.getByTestId('content-studio-handoff-finish').textContent
    ).toBe(
      'Schedule it here to finish your first post. Save for later keeps it as a draft.'
    );
    act(() => mockModals.set([]));
    await flush();
    expect(mockRouter.push).toHaveBeenCalledWith('/content-studio/first-post');
    // closed for good: not opened again on the way out
    expect(composerOpens()).toHaveLength(1);
  });

  it('BAR1 a handoff (a new post) is asked to be scheduled, as a DRAFT is', async () => {
    renderOpener(`/launches?handoff=${newId()}&return=first-post`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    expect(
      screen.getByTestId('content-studio-handoff-finish').textContent
    ).toBe(
      'Schedule it here to finish your first post. Save for later keeps it as a draft.'
    );
  });

  it('BAR2 like the clone after review 06: the first post already scheduled (QUEUE) for 5 January 2027 is never asked to be scheduled again', async () => {
    const group = 'a5b2d54d-54a8-463e-8e85-7fcffd560181';
    groupReply = (g) => {
      const body = groupBody(g);
      return reply(200, {
        ...body,
        posts: [
          {
            ...body.posts[0],
            state: 'QUEUE',
            publishDate: '2027-01-05T07:20:00.000Z',
          },
        ],
      });
    };
    renderPostOpener(`/launches?post=${group}&return=first-post`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    const finish = screen.getByTestId('content-studio-handoff-finish');
    expect(finish.textContent).toBe(
      'Your first post is already scheduled. Update saves your changes to it; Save for later turns it back into a draft.'
    );
    expect(finish.textContent).not.toMatch(/Schedule it here/);
    expect(lastComposerProps().date.toISOString()).toBe(
      '2027-01-05T07:20:00.000Z'
    );
    // opening it sends nothing
    expect(mockFetch.mock.calls.filter(([, init]) => init?.method)).toEqual([]);
  });

  it('BAR3 a published first post is not asked to be scheduled', async () => {
    groupReply = (g) => {
      const body = groupBody(g);
      return reply(200, {
        ...body,
        posts: [{ ...body.posts[0], state: 'PUBLISHED' }],
      });
    };
    renderPostOpener(`/launches?post=${SAVED_GROUP}&return=first-post`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    expect(
      screen.getByTestId('content-studio-handoff-finish').textContent
    ).toBe(
      'Your first post is already published. There is nothing left to schedule.'
    );
  });

  it('BAR4 a post that failed (ERROR) still has to be scheduled: the first-post wording stays', async () => {
    groupReply = (g) => {
      const body = groupBody(g);
      return reply(200, {
        ...body,
        posts: [{ ...body.posts[0], state: 'ERROR' }],
      });
    };
    renderPostOpener(`/launches?post=${SAVED_GROUP}&return=first-post`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    expect(
      screen.getByTestId('content-studio-handoff-finish').textContent
    ).toBe(
      'Schedule it here to finish your first post. Save for later keeps it as a draft.'
    );
  });

  it('GROUP1 an old group (the composer gave the post a new one when it was scheduled) opens nothing and goes back to the first post page', async () => {
    groupReply = (g) => reply(200, { group: g, posts: [] });
    renderPostOpener(`/launches?post=${SAVED_GROUP}&return=first-post`);
    await flush();
    expect(composerOpens()).toEqual([]);
    expect(toasts()).toEqual(['Post not found']);
    expect(mockRouter.push).toHaveBeenCalledWith('/content-studio/first-post');
    expect(mockFetch.mock.calls.filter(([, init]) => init?.method)).toEqual([]);
  });

  it('a group that is no group is never sent to the backend', async () => {
    renderPostOpener(
      `/launches?post=${encodeURIComponent('../posts/x?y')}&return=first-post`
    );
    await flush();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(composerOpens()).toEqual([]);
    expect(toasts()).toEqual([MESSAGES.invalid]);
  });

  it('a post that is gone (deleted, or of another organization) says so and opens nothing', async () => {
    groupReply = () => reply(200, { group: SAVED_GROUP, posts: [] });
    renderPostOpener(`/launches?post=${SAVED_GROUP}&return=first-post`);
    await flush();
    expect(composerOpens()).toEqual([]);
    expect(toasts()).toEqual(['Post not found']);
    expect(mockRouter.push).toHaveBeenCalledWith('/content-studio/first-post');
  });

  it('D7 the same post opens again on a later visit, after the composer was closed', async () => {
    const first = renderPostOpener(
      `/launches?post=${SAVED_GROUP}&return=first-post`
    );
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    act(() => mockModals.set([]));
    await flush();
    // back on the first post page: the calendar is left
    first.unmount();
    renderPostOpener(`/launches?post=${SAVED_GROUP}&return=first-post`);
    await waitFor(() => expect(composerOpens()).toHaveLength(2));
  });

  it('a post whose channel is no longer connected says so and opens nothing', async () => {
    groupReply = (group) =>
      reply(200, { ...groupBody(group), integration: 'int_gone' });
    renderPostOpener(`/launches?post=${SAVED_GROUP}&return=first-post`);
    await flush();
    expect(composerOpens()).toEqual([]);
    expect(toasts()).toEqual([
      'The channel of this post is no longer connected',
    ]);
  });

  it('waits for the channels, and never opens over a post being written', async () => {
    const view = renderPostOpener(
      `/launches?post=${SAVED_GROUP}&return=first-post`,
      []
    );
    await flush();
    expect(groupCalls()).toEqual([]);
    view.rerender(
      h(
        Fragment,
        null,
        h(ModalHost),
        h(CalendarWeekProvider, {
          integrations: INTEGRATIONS,
          children: h(ContentStudioPostOpener),
        })
      )
    );
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
  });
});

describe('the first post composer: Schedule finishes it, Save for later is quiet', () => {
  it('B6/B7 a first post handoff asks the composer for the quiet "Save for later"', async () => {
    const id = newId();
    renderOpener(`/launches?handoff=${id}&return=first-post`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    expect(lastComposerProps().draftForLater).toBe(true);
    expect(screen.getByTestId('content-studio-handoff-finish')).toBeTruthy();
  });

  it('any other handoff keeps the composer as it is', async () => {
    const id = newId();
    renderOpener(`/launches?handoff=${id}`);
    await waitFor(() => expect(composerOpens()).toHaveLength(1));
    expect(lastComposerProps().draftForLater).toBeUndefined();
    expect(screen.queryByTestId('content-studio-handoff-finish')).toBeNull();
  });

  it('the composer: "Save as Draft" stays everywhere else; only draftForLater makes it the outlined "Save for later"', () => {
    const manage = readFileSync(
      join(__dirname, '../new-launch/manage.modal.tsx'),
      'utf8'
    );
    expect(manage).toContain("t('save_as_draft', 'Save as Draft')");
    expect(manage).toContain("t('save_for_later', 'Save for later')");
    expect(manage).toMatch(
      /draftForLater\s*\?\s*'border border-newTableBorder[^']*'\s*:\s*'bg-\[var\(--brand-primary\)\]/
    );
    // the action that schedules is unchanged
    expect(manage).toContain("onClick={schedule('schedule')}");
  });
});
