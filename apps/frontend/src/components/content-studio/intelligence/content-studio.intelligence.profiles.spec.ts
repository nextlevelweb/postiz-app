import React, {
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
  waitFor,
  within,
} from '@testing-library/react';
import { SWRConfig } from 'swr';

// A .spec.ts without JSX, like the other Content Studio frontend specs:
// components are required, not imported, so the spec type check doesn't
// follow them; they are type checked with the frontend tsconfig

// --- URL: a small store behind next/navigation; replace/push change it ---
const mockUrl = {
  pathname: '/content-studio/intelligence',
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

const { ContentStudioIntelligence } = require('./content-studio.intelligence');

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

const calls = () =>
  mockFetch.mock.calls.map(([url, init]) => ({
    method: (init?.method as string) || 'GET',
    url: url as string,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  }));
const requests = (method: string, prefix: string) =>
  calls().filter((c) => c.method === method && c.url.startsWith(prefix));
const writes = () => calls().filter((c) => c.method !== 'GET');
const toasts = () => mockToast.mock.calls.map(([text]) => text as string);

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

let swrCache: Map<string, unknown>;
const renderPage = (href = '/content-studio/intelligence') => {
  setUrl(href);
  swrCache = new Map();
  return render(
    h(
      SWRConfig,
      { value: { provider: () => swrCache, dedupingInterval: 0 } },
      h(ModalHost),
      h(ContentStudioIntelligence)
    )
  );
};
const dialog = (title: string | RegExp) =>
  screen.getByRole('dialog', { name: title });
// the in-page profile editor
const editor = (title: string | RegExp) =>
  screen.findByRole('region', { name: title });
// actions sit at the top and the bottom of an editor: the first of them
const first = (name: string | RegExp, root: HTMLElement = document.body) =>
  within(root).getAllByRole('button', { name })[0];
const button = (name: string | RegExp, root: HTMLElement = document.body) =>
  within(root).getByRole('button', { name });
const queryButton = (
  name: string | RegExp,
  root: HTMLElement = document.body
) => within(root).queryByRole('button', { name });
const field = (name: string | RegExp, root: HTMLElement = document.body) =>
  within(root).getByLabelText(name) as HTMLInputElement;
const type = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } });

// --- server: named profiles of three kinds and the one editorial policy ---
const MARKER = 'PROFILE_CONTENT_MARKER_123';
const T0 = '2026-10-10T10:00:00.000Z';
type Revision = {
  id: string;
  revisionNumber: number;
  schemaVersion: number;
  contentHash: string;
  createdAt: string;
  content: any;
};
type Profile = {
  id: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revisions: Revision[];
};
const BASES = [
  '/content-studio/writing-profiles',
  '/content-studio/audience-profiles',
  '/content-studio/expertise-profiles',
];
let store: Record<string, Profile[]>;
let policy: Revision[];
let counter = 0;
const nextId = () =>
  `${String(++counter).padStart(8, '0')}-0000-4000-8000-000000000000`;
const hash = (content: unknown) =>
  JSON.stringify(content)
    .split('')
    .reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7)
    .toString(16)
    .padStart(64, '0');
const revision = (revisionNumber: number, content: unknown): Revision => ({
  id: nextId(),
  revisionNumber,
  schemaVersion: 1,
  contentHash: hash(content),
  createdAt: T0,
  content,
});
const summary = (profile: Profile) => ({
  id: profile.id,
  name: profile.name,
  latestRevisionNumber: profile.revisions.length,
  archivedAt: profile.archivedAt,
  createdAt: profile.createdAt,
  updatedAt: profile.updatedAt,
});
const latest = (list: Revision[]) => list[list.length - 1];
const meta = ({ content, ...rest }: Revision) => rest;

const writingContent = (voice = `Warm and direct. ${MARKER}`) => ({
  schemaVersion: 1,
  voice,
  toneTags: ['warm'],
  perspective: 'first_plural',
  formatting: { emoji: 'sparing', hashtags: 'few', notes: null },
  vocabulary: { prefer: ['customers'], avoid: ['synergy'] },
  dos: ['Lead with the benefit.'],
  donts: [],
  examples: [{ text: 'We shipped it.', note: null }],
});
const audienceContent = () => ({
  schemaVersion: 1,
  description: `Owners of Dutch SMEs. ${MARKER}`,
  role: 'Owner',
  knowledgeLevel: 'intermediate',
  goals: ['Save time'],
  painPoints: [],
  objections: [],
  preferredTone: null,
  locale: 'nl-NL',
});
const expertiseContent = () => ({
  schemaVersion: 1,
  subjects: ['Payroll'],
  differentiators: [],
  stances: [{ topic: 'Remote work', position: `Good for most. ${MARKER}` }],
  frameworks: [],
  evidenceExpectations: 'Use primary sources.',
  avoidTopics: [],
  confidenceBoundaries: '',
});
const policyContent = () => ({
  schemaVersion: 1,
  principles: ['Be useful.'],
  prohibitedTopics: ['Politics'],
  claimRules: [],
  ctaRules: [],
  formatConventions: [],
  complianceNotes: `Add the risk notice. ${MARKER}`,
});
const profile = (name: string, contents: unknown[], archived = false) => ({
  id: nextId(),
  name,
  archivedAt: archived ? T0 : null,
  createdAt: T0,
  updatedAt: T0,
  revisions: contents.map((content, index) => revision(index + 1, content)),
});

const server = (method: string, url: string, body: any): Reply => {
  const { pathname, searchParams } = new URL(url, 'https://api.test');
  if (pathname.startsWith('/content-studio/editorial-policy')) {
    const rest = pathname.slice('/content-studio/editorial-policy'.length);
    if (method === 'GET' && rest === '') {
      return reply(200, {
        latestRevisionNumber: policy.length,
        currentRevision: policy.length ? latest(policy) : null,
      });
    }
    if (method === 'POST' && rest === '/revisions') {
      if (body.baseRevisionNumber !== policy.length) {
        return reply(409, {
          msg: 'changed',
          code: 'CS_PROFILE_REVISION_CONFLICT',
          currentRevisionNumber: policy.length,
        });
      }
      if (
        policy.length &&
        JSON.stringify(latest(policy).content) === JSON.stringify(body.content)
      ) {
        return reply(201, {
          created: false,
          revision: latest(policy),
          latestRevisionNumber: policy.length,
        });
      }
      policy = [...policy, revision(policy.length + 1, body.content)];
      return reply(201, {
        created: true,
        revision: latest(policy),
        latestRevisionNumber: policy.length,
      });
    }
    if (method === 'GET' && rest === '/revisions') {
      return reply(200, {
        pages: policy.length ? 1 : 0,
        results: [...policy].reverse().map(meta),
      });
    }
    const one = rest.match(/^\/revisions\/([^/]+)$/);
    if (method === 'GET' && one) {
      const found = policy.find((r) => r.id === one[1]);
      return found ? reply(200, found) : reply(404, { code: 'CS_NOT_FOUND' });
    }
  }
  const base = BASES.find((b) => pathname.startsWith(b));
  if (base) {
    const profiles = store[base];
    const rest = pathname.slice(base.length);
    if (method === 'GET' && rest === '') {
      const archived = searchParams.get('archived') === 'true';
      return reply(200, {
        pages: 1,
        results: profiles
          .filter((p) => !!p.archivedAt === archived)
          .map(summary),
      });
    }
    if (method === 'POST' && rest === '') {
      const created = profile(body.name, [body.content]);
      store[base] = [...profiles, created];
      return reply(201, {
        ...summary(created),
        currentRevision: latest(created.revisions),
      });
    }
    const match = rest.match(
      /^\/([^/]+)(?:\/(revisions|archive|restore)(?:\/([^/]+))?)?$/
    );
    const found = match && profiles.find((p) => p.id === match[1]);
    if (!found) {
      return reply(404, { msg: 'not found', code: 'CS_NOT_FOUND' });
    }
    const [, , action, revisionId] = match as RegExpMatchArray;
    if (method === 'GET' && !action) {
      return reply(200, {
        ...summary(found),
        currentRevision: latest(found.revisions),
      });
    }
    if (method === 'PATCH' && !action) {
      found.name = body.name;
      return reply(200, summary(found));
    }
    if (method === 'POST' && action === 'archive') {
      found.archivedAt = T0;
      return reply(200, summary(found));
    }
    if (method === 'POST' && action === 'restore') {
      found.archivedAt = null;
      return reply(200, summary(found));
    }
    if (method === 'POST' && action === 'revisions') {
      if (body.baseRevisionNumber !== found.revisions.length) {
        return reply(409, {
          msg: 'changed',
          code: 'CS_PROFILE_REVISION_CONFLICT',
          currentRevisionNumber: found.revisions.length,
        });
      }
      const current = latest(found.revisions);
      if (JSON.stringify(current.content) === JSON.stringify(body.content)) {
        return reply(201, { created: false, revision: current });
      }
      found.revisions = [
        ...found.revisions,
        revision(found.revisions.length + 1, body.content),
      ];
      return reply(201, { created: true, revision: latest(found.revisions) });
    }
    if (method === 'GET' && action === 'revisions' && !revisionId) {
      return reply(200, {
        pages: 1,
        results: [...found.revisions].reverse().map(meta),
      });
    }
    if (method === 'GET' && action === 'revisions' && revisionId) {
      const one = found.revisions.find((r) => r.id === revisionId);
      return one ? reply(200, one) : reply(404, { code: 'CS_NOT_FOUND' });
    }
  }
  return reply(404, { msg: 'no route', code: 'CS_NOT_FOUND' });
};

let storageWrites: jest.SpyInstance;
let consoleSpies: jest.SpyInstance[];

beforeEach(() => {
  mockModals.set([]);
  store = {
    '/content-studio/writing-profiles': [
      profile('Brand voice', [writingContent('First voice'), writingContent()]),
      profile('Old voice', [writingContent('Old')], true),
    ],
    '/content-studio/audience-profiles': [
      profile('SME owners', [audienceContent()]),
      profile('Students', [audienceContent()], true),
    ],
    '/content-studio/expertise-profiles': [
      profile('Tax expertise', [expertiseContent()]),
      profile('Old expertise', [expertiseContent()], true),
    ],
  };
  policy = [];
  override = () => undefined;
  mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    return (
      override(init.method || 'GET', url, body) ??
      server(init.method || 'GET', url, body)
    );
  });
  mockRouter.replace.mockImplementation((href: string) => setUrl(href));
  mockRouter.push.mockImplementation(() => undefined);
  mockOpenModal.mockImplementation((params: Omit<MockModal, 'id'>) =>
    mockModals.set([
      ...mockModals.list,
      { ...params, id: `modal-${++modalId}` },
    ])
  );
  mockConfirm.mockResolvedValue(true);
  // an ordinary member: editorial context needs no manager role
  mockUser.mockReturnValue({ orgId: 'org', tier: 'PRO', role: 'USER' });
  storageWrites = jest.spyOn(Storage.prototype, 'setItem');
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
    (level) => jest.spyOn(console, level)
  );
});

afterEach(async () => {
  // no profile content is persisted in the browser or logged
  expect(storageWrites).not.toHaveBeenCalled();
  for (const spy of consoleSpies) {
    expect(JSON.stringify(spy.mock.calls)).not.toContain(MARKER);
  }
  cleanup();
  await flush();
});

const openTab = async (tab: string, waitFor: string) => {
  renderPage(`/content-studio/intelligence?tab=${tab}`);
  await screen.findByText(waitFor);
  await flush();
};
// a short text entry in a list editor
const addEntry = (root: HTMLElement, label: string, value: string) => {
  type(field(`New ${label}`, root), value);
  fireEvent.click(button(`Add ${label}`, root));
};
// buttons that must never appear in Brand & AI
const FORBIDDEN_ACTIONS =
  /generat|rewrite|shorten|expand|change tone|infer|analy|learn|import|upload|crawl|ai |with ai|default|verify|fact|ground|compliance|check|score|target|delete|restore revision|restore version|set current/i;
const actionLabels = (root: HTMLElement = document.body) =>
  within(root)
    .queryAllByRole('button')
    .map((b) => b.getAttribute('aria-label') || b.textContent || '');

const KINDS = [
  {
    tab: 'writing',
    base: '/content-studio/writing-profiles',
    active: 'Brand voice',
    archived: 'Old voice',
    create: 'New writing profile',
    empty: 'No writing profiles yet.',
    content: writingContent,
    latestRevision: 2,
  },
  {
    tab: 'audiences',
    base: '/content-studio/audience-profiles',
    active: 'SME owners',
    archived: 'Students',
    create: 'New audience profile',
    empty: 'No audience profiles yet.',
    content: audienceContent,
    latestRevision: 1,
  },
  {
    tab: 'expertise',
    base: '/content-studio/expertise-profiles',
    active: 'Tax expertise',
    archived: 'Old expertise',
    create: 'New expertise profile',
    empty: 'No expertise profiles yet.',
    content: expertiseContent,
    latestRevision: 1,
  },
] as const;

describe.each(KINDS)('Named profiles: $tab', (kind) => {
  it('WF1/AF1/XF1 lists active summaries only, without content', async () => {
    await openTab(kind.tab, kind.active);
    expect(requests('GET', kind.base).map((c) => c.url)).toEqual([
      `${kind.base}?page=1&archived=false`,
    ]);
    expect(screen.queryByText(kind.archived)).toBeNull();
    expect(document.body.textContent).not.toContain(MARKER);
    const row = screen.getByText(kind.active).closest('li') as HTMLElement;
    expect(row.textContent).toContain(`Version ${kind.latestRevision}`);
  });

  it('WF2 shows archived profiles on their own, readable, with Restore', async () => {
    await openTab(kind.tab, kind.active);
    fireEvent.click(button('Archived'));
    expect(await screen.findByText(kind.archived)).toBeTruthy();
    expect(requests('GET', `${kind.base}?`).map((c) => c.url)).toContain(
      `${kind.base}?page=1&archived=true`
    );
    expect(queryButton(`View ${kind.archived}`)).not.toBeNull();
    expect(queryButton(`History ${kind.archived}`)).not.toBeNull();
    fireEvent.click(button(`Restore ${kind.archived}`));
    await flush();
    expect(writes().map((w) => `${w.method} ${w.url}`)).toEqual([
      `POST ${kind.base}/${store[kind.base][1].id}/restore`,
    ]);
    expect(toasts()).toEqual(['Profile restored.']);
  });

  it('WF15/AF13/XF13 archives after a confirmation that history is kept', async () => {
    await openTab(kind.tab, kind.active);
    fireEvent.click(button(`Archive ${kind.active}`));
    await flush();
    expect(mockConfirm.mock.calls[0][0]).toBe(
      'This hides the profile from active selection. Revision history is kept.'
    );
    expect(writes()).toEqual([
      {
        method: 'POST',
        url: `${kind.base}/${store[kind.base][0].id}/archive`,
        body: undefined,
      },
    ]);
    await waitFor(() => expect(screen.queryByText(kind.active)).toBeNull());
    expect(calls().map((c) => c.method)).not.toContain('DELETE');
  });

  it('shows the empty state', async () => {
    store[kind.base] = [];
    renderPage(`/content-studio/intelligence?tab=${kind.tab}`);
    expect(await screen.findByText(kind.empty)).toBeTruthy();
  });

  it('WF6/WF7/AF11/XF11 edits over the loaded version and saves a new one', async () => {
    await openTab(kind.tab, kind.active);
    fireEvent.click(button(`Edit ${kind.active}`));
    const modal = await editor(kind.active);
    await within(modal).findByText(`Version ${kind.latestRevision}`);
    const list =
      kind.tab === 'writing'
        ? 'Tone tags'
        : kind.tab === 'audiences'
        ? 'Goals'
        : 'Subjects';
    addEntry(modal, list, 'Added entry');
    fireEvent.click(first('Save', modal));
    await flush();
    const [save] = requests('POST', `${kind.base}/`);
    expect(save.url).toBe(`${kind.base}/${store[kind.base][0].id}/revisions`);
    expect(save.body.baseRevisionNumber).toBe(kind.latestRevision);
    expect(save.body.content.schemaVersion).toBe(1);
    expect(toasts()).toEqual(['Saved as a new version.']);
    // Save returns to the list; the next edit goes over the new version
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: kind.active })).toBeNull()
    );
    fireEvent.click(button(`Edit ${kind.active}`));
    const again = await editor(kind.active);
    await within(again).findByText(`Version ${kind.latestRevision + 1}`);
    addEntry(again, list, 'Another entry');
    fireEvent.click(first('Save', again));
    await flush();
    expect(requests('POST', `${kind.base}/`)[1].body.baseRevisionNumber).toBe(
      kind.latestRevision + 1
    );
  });

  it('WF8 says when there is nothing new to save', async () => {
    await openTab(kind.tab, kind.active);
    fireEvent.click(button(`Edit ${kind.active}`));
    const modal = await editor(kind.active);
    await within(modal).findByText(`Version ${kind.latestRevision}`);
    fireEvent.click(first('Save', modal));
    await flush();
    expect(toasts()).toEqual(['No content changes to save.']);
  });

  it('WF9/WF10 shows a conflict and never saves again by itself; Reload loads the latest version', async () => {
    await openTab(kind.tab, kind.active);
    fireEvent.click(button(`Edit ${kind.active}`));
    const modal = await editor(kind.active);
    await within(modal).findByText(`Version ${kind.latestRevision}`);
    // someone else saves meanwhile
    const target = store[kind.base][0];
    target.revisions = [
      ...target.revisions,
      revision(target.revisions.length + 1, kind.content()),
    ];
    fireEvent.click(first('Save', modal));
    await flush();
    expect(within(modal).getByRole('alert').textContent).toContain(
      'This profile changed elsewhere. Reload the latest version before saving.'
    );
    expect(requests('POST', `${kind.base}/`)).toHaveLength(1);
    expect((first('Save', modal) as HTMLButtonElement).disabled).toBe(true);
    expect(toasts()).toEqual([]);

    fireEvent.click(button('Reload latest', modal));
    await flush();
    expect(within(modal).queryByRole('alert')).toBeNull();
    await within(modal).findByText(`Version ${kind.latestRevision + 1}`);
    fireEvent.click(first('Save', modal));
    await flush();
    expect(requests('POST', `${kind.base}/`)).toHaveLength(2);
    expect(requests('POST', `${kind.base}/`)[1].body.baseRevisionNumber).toBe(
      kind.latestRevision + 1
    );
  });

  it('WF11 a name change alone is one rename request, making no version', async () => {
    await openTab(kind.tab, kind.active);
    fireEvent.click(button(`Edit ${kind.active}`));
    const modal = await editor(kind.active);
    await within(modal).findByText(`Version ${kind.latestRevision}`);
    type(field('Name', modal), '  Renamed profile ');
    fireEvent.click(first('Save', modal));
    await flush();
    expect(writes()).toEqual([
      {
        method: 'PATCH',
        url: `${kind.base}/${store[kind.base][0].id}`,
        body: { name: 'Renamed profile' },
      },
    ]);
    expect(toasts()).toEqual(['Name saved.']);
  });

  it('WF12/WF13/WF14 shows the history newest first and one version read-only, with no way to change it', async () => {
    await openTab(kind.tab, kind.active);
    fireEvent.click(button(`History ${kind.active}`));
    const modal = dialog(`History: ${kind.active}`);
    await within(modal).findByText(`Version ${kind.latestRevision}`);
    const listed = within(modal)
      .getAllByText(/^Version \d+$/)
      .map((n) => n.textContent);
    expect(listed[0]).toBe(`Version ${kind.latestRevision}`);
    fireEvent.click(button(`View ${kind.latestRevision}`, modal));
    await flush();
    const id = store[kind.base][0].id;
    const detail = requests('GET', `${kind.base}/${id}/revisions/`);
    expect(detail).toHaveLength(1);
    for (const control of within(modal).queryAllByRole('textbox')) {
      expect((control as HTMLInputElement).disabled).toBe(true);
    }
    for (const control of within(modal).queryAllByRole('combobox')) {
      expect((control as HTMLSelectElement).disabled).toBe(true);
    }
    expect(actionLabels(modal)).toEqual(['Back to history']);
    expect(writes()).toEqual([]);
  });

  it('WF17 opens an archived profile read-only', async () => {
    await openTab(kind.tab, kind.active);
    fireEvent.click(button('Archived'));
    await screen.findByText(kind.archived);
    fireEvent.click(button(`View ${kind.archived}`));
    const modal = await editor(kind.archived);
    await within(modal).findByText(
      'This profile is archived. Restore it to edit it.'
    );
    expect(queryButton('Save', modal)).toBeNull();
    expect(queryButton('Save name', modal)).toBeNull();
    for (const control of within(modal).queryAllByRole('textbox')) {
      expect((control as HTMLInputElement).disabled).toBe(true);
    }
  });

  it('WF3/AF2/XF2 lets an ordinary member create, and refuses safely', async () => {
    await openTab(kind.tab, kind.active);
    fireEvent.click(first(kind.create));
    const modal = await editor(kind.create);
    type(field('Name', modal), 'Fresh');
    override = (method, url) =>
      method === 'POST' && url === kind.base
        ? reply(400, { msg: MARKER, code: 'CS_PROFILE_TOO_LARGE' })
        : undefined;
    fireEvent.click(first('Save', modal));
    await flush();
    expect(toasts()).toEqual([
      'This is too long to save. Shorten some fields and try again.',
    ]);
    // the form stays as typed
    expect(field('Name', modal).value).toBe('Fresh');
    override = () => undefined;
    fireEvent.click(first('Save', modal));
    await flush();
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: kind.create })).toBeNull()
    );
    expect(toasts()[1]).toBe('Profile created.');
    expect(await screen.findByText('Fresh')).toBeTruthy();
  });

  it('WF19/AF16/XF18 has no AI, default, import or checking action', async () => {
    await openTab(kind.tab, kind.active);
    fireEvent.click(button(`Edit ${kind.active}`));
    const modal = await editor(kind.active);
    await within(modal).findByText(`Version ${kind.latestRevision}`);
    expect(actionLabels().filter((l) => FORBIDDEN_ACTIONS.test(l))).toEqual([]);
  });
});

describe('Writing profile form', () => {
  it('WF4/WF5 builds Writing DNA v1 from the structured fields', async () => {
    await openTab('writing', 'Brand voice');
    fireEvent.click(first('New writing profile'));
    const modal = await editor('New writing profile');
    type(field('Name', modal), 'Calm voice');
    type(field('Voice', modal), '  Calm.\nClear. ');
    addEntry(modal, 'Tone tags', ' calm ');
    fireEvent.change(field('Perspective', modal), {
      target: { value: 'second' },
    });
    fireEvent.change(field('Emoji', modal), { target: { value: 'free' } });
    fireEvent.change(field('Hashtags', modal), { target: { value: 'many' } });
    type(field('Formatting notes', modal), 'One per post');
    addEntry(modal, 'Words to prefer', 'you');
    addEntry(modal, 'Words to avoid', 'leverage');
    addEntry(modal, 'Do', 'Be brief.');
    addEntry(modal, "Don't", 'No jargon.');
    fireEvent.click(button('Add example', modal));
    type(field('Example 1', modal), 'Hi there.');
    fireEvent.click(first('Save', modal));
    await flush();
    expect(
      requests('POST', '/content-studio/writing-profiles')[0].body
    ).toEqual({
      name: 'Calm voice',
      content: {
        schemaVersion: 1,
        voice: '  Calm.\nClear. ',
        toneTags: ['calm'],
        perspective: 'second',
        formatting: { emoji: 'free', hashtags: 'many', notes: 'One per post' },
        vocabulary: { prefer: ['you'], avoid: ['leverage'] },
        dos: ['Be brief.'],
        donts: ['No jargon.'],
        examples: [{ text: 'Hi there.', note: null }],
      },
    });
  });

  it('WF18 allows at most five examples', async () => {
    await openTab('writing', 'Brand voice');
    fireEvent.click(first('New writing profile'));
    const modal = await editor('New writing profile');
    for (let i = 0; i < 5; i++) {
      fireEvent.click(button('Add example', modal));
    }
    expect((button('Add example', modal) as HTMLButtonElement).disabled).toBe(
      true
    );
    fireEvent.click(button('Remove example 5', modal));
    expect((button('Add example', modal) as HTMLButtonElement).disabled).toBe(
      false
    );
  });
});

describe('Audience profile form', () => {
  it('AF3-AF10 builds Audience v1, with optional tone and locale', async () => {
    await openTab('audiences', 'SME owners');
    fireEvent.click(first('New audience profile'));
    const modal = await editor('New audience profile');
    const level = field(
      'Knowledge level',
      modal
    ) as unknown as HTMLSelectElement;
    expect(
      Array.from(level.options).map((o) => [o.value, o.textContent])
    ).toEqual([
      ['beginner', 'Beginner'],
      ['intermediate', 'Intermediate'],
      ['expert', 'Expert'],
      ['mixed', 'Mixed'],
    ]);
    expect(modal.textContent).toContain(
      'Locale controls writing language/locale context only.'
    );
    type(field('Name', modal), 'Developers');
    type(field('Description', modal), 'Senior developers.');
    type(field('Role', modal), 'Tech lead');
    fireEvent.change(level, { target: { value: 'expert' } });
    addEntry(modal, 'Goals', 'Ship faster');
    addEntry(modal, 'Pain points', 'Flaky tests');
    addEntry(modal, 'Objections', 'Too much hype');
    fireEvent.click(first('Save', modal));
    await flush();
    expect(
      requests('POST', '/content-studio/audience-profiles')[0].body
    ).toEqual({
      name: 'Developers',
      content: {
        schemaVersion: 1,
        description: 'Senior developers.',
        role: 'Tech lead',
        knowledgeLevel: 'expert',
        goals: ['Ship faster'],
        painPoints: ['Flaky tests'],
        objections: ['Too much hype'],
        preferredTone: null,
        locale: null,
      },
    });
  });

  it('AF14/AF15 has no demographic, targeting or upload control', async () => {
    await openTab('audiences', 'SME owners');
    fireEvent.click(first('New audience profile'));
    const modal = await editor('New audience profile');
    const labels = [
      ...within(modal).queryAllByRole('textbox'),
      ...within(modal).queryAllByRole('combobox'),
    ].map((control) => control.getAttribute('aria-label'));
    expect(labels.join(' ')).not.toMatch(
      /age|gender|income|ethnic|religio|politic|interest|device|zip|postal|email|phone|radius|location|target|upload|customer list/i
    );
    expect(modal.querySelector('input[type="file"]')).toBeNull();
  });
});

describe('Expertise profile form', () => {
  it('XF3-XF10 builds Expertise v1 with stances in the order entered', async () => {
    await openTab('expertise', 'Tax expertise');
    fireEvent.click(first('New expertise profile'));
    const modal = await editor('New expertise profile');
    expect(modal.textContent).toContain(
      'Expertise profiles are organization-provided context. They are not automatically verified facts.'
    );
    type(field('Name', modal), 'Payroll');
    addEntry(modal, 'Subjects', 'Payroll');
    addEntry(modal, 'Differentiators', 'Fixed fees');
    fireEvent.click(button('Add stance', modal));
    fireEvent.click(button('Add stance', modal));
    type(field('Topic 1', modal), 'Zebra topic');
    type(field('Position 1', modal), 'Last alphabetically.');
    type(field('Topic 2', modal), 'Apple topic');
    type(field('Position 2', modal), 'First alphabetically.');
    addEntry(modal, 'Frameworks', 'Jobs to be done');
    type(field('Evidence expectations', modal), 'Cite primary sources.');
    addEntry(modal, 'Avoid topics', 'Politics');
    type(field('Confidence boundaries', modal), 'Label forecasts.');
    fireEvent.click(first('Save', modal));
    await flush();
    expect(
      requests('POST', '/content-studio/expertise-profiles')[0].body
    ).toEqual({
      name: 'Payroll',
      content: {
        schemaVersion: 1,
        subjects: ['Payroll'],
        differentiators: ['Fixed fees'],
        stances: [
          { topic: 'Zebra topic', position: 'Last alphabetically.' },
          { topic: 'Apple topic', position: 'First alphabetically.' },
        ],
        frameworks: ['Jobs to be done'],
        evidenceExpectations: 'Cite primary sources.',
        avoidTopics: ['Politics'],
        confidenceBoundaries: 'Label forecasts.',
      },
    });
  });

  it('XF14-XF17 shows no verified badge, source, citation or grounding control', async () => {
    await openTab('expertise', 'Tax expertise');
    fireEvent.click(button('Edit Tax expertise'));
    const modal = await editor('Tax expertise');
    await within(modal).findByText('Version 1');
    // each piece of text on its own: the one mention of verification is
    // the note that says the content is not verified
    const NOTE =
      'Expertise profiles are organization-provided context. They are not automatically verified facts.';
    const texts: string[] = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT
    );
    while (walker.nextNode()) {
      texts.push((walker.currentNode.textContent || '').trim());
    }
    expect(texts).toContain(NOTE);
    expect(
      texts.filter(
        (text) =>
          text !== NOTE &&
          /verif|fact[- ]?check|grounded|citation|accurate|trusted/i.test(text)
      )
    ).toEqual([]);
    const labels = [
      ...within(modal).queryAllByRole('textbox'),
      ...within(modal).queryAllByRole('button'),
    ].map(
      (control) => control.getAttribute('aria-label') || control.textContent
    );
    expect(labels.join(' ')).not.toMatch(
      /source|citation|url|link|upload|verify|ground/i
    );
    expect(modal.querySelector('input[type="file"]')).toBeNull();
  });
});

describe('Editorial policy', () => {
  it('EF1/EF2/EF9 starts empty for any member and creates the policy with version 0 as base', async () => {
    await openTab('editorial', 'No editorial policy saved yet.');
    expect((button('History') as HTMLButtonElement).disabled).toBe(true);
    addEntry(document.body, 'Principles', 'Be useful.');
    type(field('Compliance notes'), 'Add the risk notice.');
    fireEvent.click(first('Save policy'));
    await flush();
    expect(writes()).toEqual([
      {
        method: 'POST',
        url: '/content-studio/editorial-policy/revisions',
        body: {
          baseRevisionNumber: 0,
          content: {
            schemaVersion: 1,
            principles: ['Be useful.'],
            prohibitedTopics: [],
            claimRules: [],
            ctaRules: [],
            formatConventions: [],
            complianceNotes: 'Add the risk notice.',
          },
        },
      },
    ]);
    expect(toasts()).toEqual(['Editorial policy saved.']);
    expect(await screen.findByText('Version 1')).toBeTruthy();
  });

  it('EF3/EF4/EF5 loads the current policy, saves over its version and says when nothing changed', async () => {
    policy = [revision(1, policyContent()), revision(2, policyContent())];
    await openTab('editorial', 'Version 2');
    expect(screen.getByText('Politics')).toBeTruthy();
    fireEvent.click(first('Save policy'));
    await flush();
    expect(toasts()).toEqual(['No policy changes to save.']);
    addEntry(document.body, 'Claim rules', 'Cite numbers.');
    fireEvent.click(first('Save policy'));
    await flush();
    expect(
      requests('POST', '/content-studio/editorial-policy/revisions').map(
        (c) => c.body.baseRevisionNumber
      )
    ).toEqual([2, 2]);
    expect(await screen.findByText('Version 3')).toBeTruthy();
  });

  it('EF6 shows a conflict and saves nothing more until the latest is loaded', async () => {
    policy = [revision(1, policyContent())];
    await openTab('editorial', 'Version 1');
    policy = [...policy, revision(2, policyContent())];
    addEntry(document.body, 'Claim rules', 'Cite numbers.');
    fireEvent.click(first('Save policy'));
    await flush();
    expect(screen.getByRole('alert').textContent).toContain(
      'The editorial policy changed elsewhere. Reload the latest version before saving.'
    );
    expect((first('Save policy') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button('Reload latest'));
    expect(await screen.findByText('Version 2')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      requests('POST', '/content-studio/editorial-policy/revisions')
    ).toHaveLength(1);
  });

  it('EF7/EF8 shows the history and a version read-only', async () => {
    policy = [revision(1, policyContent())];
    await openTab('editorial', 'Version 1');
    fireEvent.click(button('History'));
    const modal = dialog('Editorial policy history');
    fireEvent.click(
      await within(modal).findByRole('button', { name: 'View 1' })
    );
    await within(modal).findByText('Politics');
    expect(actionLabels(modal)).toEqual(['Back to history']);
    for (const control of within(modal).queryAllByRole('textbox')) {
      expect((control as HTMLInputElement).disabled).toBe(true);
    }
    expect(
      requests('GET', '/content-studio/editorial-policy/revisions/')
    ).toHaveLength(1);
  });

  it('EF10/EF11/EF12 has no archive, delete, compliance check or AI action', async () => {
    await openTab('editorial', 'No editorial policy saved yet.');
    expect(
      actionLabels().filter((l) =>
        /archive|delete|compliance|check|score|generat|ai\b/i.test(l)
      )
    ).toEqual([]);
  });

  it('maps an integrity error to its fixed message', async () => {
    override = (method, url) =>
      method === 'GET' && url === '/content-studio/editorial-policy'
        ? reply(500, { msg: MARKER, code: 'CS_PROFILE_INTEGRITY_ERROR' })
        : undefined;
    renderPage('/content-studio/intelligence?tab=editorial');
    expect(
      await screen.findByText(
        'Stored editorial policy data could not be verified. Please contact an administrator.'
      )
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain(MARKER);
  });
});

describe('Editorial policy: approval before handoff (P5-07)', () => {
  const toggle = (root: HTMLElement = document.body) =>
    within(root).getByRole('checkbox', {
      name: 'Require approval before handoff',
    }) as HTMLInputElement;
  const HINT =
    'Only revisions that are currently approved can be handed off to Postiz.';
  const ON_HINT =
    'Unreviewed, pending, refused or withdrawn revisions cannot be handed off.';
  const saved = () =>
    requests('POST', '/content-studio/editorial-policy/revisions').map(
      (c) => c.body
    );

  it('FP1/FP2/FP5 the switch is part of the editorial policy, off for a policy saved without it, with its description', async () => {
    policy = [revision(1, policyContent())];
    await openTab('editorial', 'Version 1');
    const box = toggle();
    expect(box.checked).toBe(false);
    expect(box.closest('fieldset')!.querySelector('legend')!.textContent).toBe(
      'Handoff'
    );
    const hint = document.getElementById(
      box.getAttribute('aria-describedby')!
    )!;
    expect(hint.textContent).toBe(HINT);
    expect(document.body.textContent).not.toContain(ON_HINT);
  });

  it('FP3/FP6 turning it on saves exactly the one switch in a new policy version', async () => {
    policy = [revision(1, policyContent())];
    await openTab('editorial', 'Version 1');
    fireEvent.click(toggle());
    expect(toggle().checked).toBe(true);
    expect(document.body.textContent).toContain(ON_HINT);
    fireEvent.click(first('Save policy'));
    await flush();
    expect(saved()).toEqual([
      {
        baseRevisionNumber: 1,
        content: {
          ...policyContent(),
          workflow: { requireApprovalForHandoff: true },
        },
      },
    ]);
    expect(await screen.findByText('Version 2')).toBeTruthy();
  });

  it('FP4/FP6 turning it off sends no workflow at all', async () => {
    policy = [
      revision(1, {
        ...policyContent(),
        workflow: { requireApprovalForHandoff: true },
      }),
    ];
    await openTab('editorial', 'Version 1');
    expect(toggle().checked).toBe(true);
    fireEvent.click(toggle());
    fireEvent.click(first('Save policy'));
    await flush();
    const [body] = saved();
    expect(body.content).toEqual(policyContent());
    expect(Object.keys(body.content)).not.toContain('workflow');
    expect(Object.keys(body).sort()).toEqual(['baseRevisionNumber', 'content']);
  });

  it('a version in the history shows its switch read-only', async () => {
    policy = [
      revision(1, {
        ...policyContent(),
        workflow: { requireApprovalForHandoff: true },
      }),
    ];
    await openTab('editorial', 'Version 1');
    fireEvent.click(button('History'));
    const modal = dialog('Editorial policy history');
    fireEvent.click(
      await within(modal).findByRole('button', { name: 'View 1' })
    );
    await within(modal).findByText('Politics');
    expect(toggle(modal).checked).toBe(true);
    expect(toggle(modal).disabled).toBe(true);
  });
});
