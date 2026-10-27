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
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

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

// --- server: empty lists everywhere; this spec is about the page itself ---
const server = (method: string, url: string): Reply => {
  const { pathname } = new URL(url, 'https://api.test');
  if (method === 'GET' && pathname === '/content-studio/ai/providers') {
    return reply(200, []);
  }
  if (method === 'GET' && pathname === '/content-studio/ai/connections') {
    return reply(200, []);
  }
  if (method === 'GET' && pathname === '/content-studio/editorial-policy') {
    return reply(200, { latestRevisionNumber: 0, currentRevision: null });
  }
  if (method === 'GET' && /-profiles$/.test(pathname)) {
    return reply(200, { pages: 0, results: [] });
  }
  return reply(404, { msg: 'no route', code: 'CS_NOT_FOUND' });
};

beforeEach(() => {
  mockModals.set([]);
  override = () => undefined;
  mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) =>
    server(init.method || 'GET', url)
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

const TABS = [
  ['ai', 'AI Connections', 'No AI connections yet.'],
  ['writing', 'Writing', 'No writing profiles yet.'],
  ['editorial', 'Editorial Policy', 'No editorial policy saved yet.'],
  ['audiences', 'Audiences', 'No audience profiles yet.'],
  ['expertise', 'Expertise', 'No expertise profiles yet.'],
] as const;
const selectedTab = () =>
  screen
    .getAllByRole('tab')
    .filter((tab) => tab.getAttribute('aria-selected') === 'true')
    .map((tab) => tab.textContent);

describe('Brand & AI page', () => {
  it('PG1-PG4/PG10 renders for an ordinary member, titled Brand & AI, five tabs, AI connections first', async () => {
    renderPage();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Brand & AI' })
    ).toBeTruthy();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(
      TABS.map(([, label]) => label)
    );
    expect(selectedTab()).toEqual(['AI Connections']);
    expect(await screen.findByText('No AI connections yet.')).toBeTruthy();
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('content-studio-tab-ai');
    expect(
      screen.getByRole('link', { name: 'Content Studio' }).getAttribute('href')
    ).toBe('/content-studio');
    await flush();
  });

  it.each(TABS)(
    'PG5/PG6 the %s tab is kept in the URL and shows its section',
    async (key, label, empty) => {
      renderPage();
      fireEvent.click(screen.getByRole('tab', { name: label }));
      await flush();
      if (key !== 'ai') {
        expect(mockRouter.replace).toHaveBeenLastCalledWith(
          `/content-studio/intelligence?tab=${key}`,
          { scroll: false }
        );
      }
      expect(selectedTab()).toEqual([label]);
      expect(await screen.findByText(empty)).toBeTruthy();
      await flush();
      cleanup();
      renderPage(`/content-studio/intelligence?tab=${key}`);
      expect(selectedTab()).toEqual([label]);
      await flush();
    }
  );

  it.each([['nonsense'], ['AI'], [''], ['apiKey'], ['writing%20x']])(
    'PG7 falls back to the first tab for ?tab=%s',
    async (tab) => {
      renderPage(`/content-studio/intelligence?tab=${tab}`);
      expect(selectedTab()).toEqual(['AI Connections']);
      await flush();
    }
  );

  it.each([['USER'], ['ADMIN'], ['SUPERADMIN']])(
    'PG9/PG10 has no page gate: a %s member gets every editorial tab with its controls',
    async (role) => {
      mockUser.mockReturnValue({ orgId: 'org', tier: 'PRO', role });
      renderPage('/content-studio/intelligence?tab=writing');
      expect(await screen.findByText('No writing profiles yet.')).toBeTruthy();
      expect(
        screen.queryAllByRole('button', { name: 'New writing profile' }).length
      ).toBeGreaterThan(0);
      await flush();
      cleanup();
      renderPage('/content-studio/intelligence?tab=audiences');
      await screen.findByText('No audience profiles yet.');
      expect(
        screen.queryAllByRole('button', { name: 'New audience profile' }).length
      ).toBeGreaterThan(0);
      await flush();
      cleanup();
      renderPage('/content-studio/intelligence?tab=expertise');
      await screen.findByText('No expertise profiles yet.');
      expect(
        screen.queryAllByRole('button', { name: 'New expertise profile' })
          .length
      ).toBeGreaterThan(0);
      await flush();
      cleanup();
      renderPage('/content-studio/intelligence?tab=editorial');
      await screen.findByText('No editorial policy saved yet.');
      expect(
        screen.queryAllByRole('button', { name: 'Save policy' }).length
      ).toBeGreaterThan(0);
      expect(field('Compliance notes').disabled).toBe(false);
    }
  );

  it('PG11 has no AI writing, default or checking action on any tab', async () => {
    mockUser.mockReturnValue({ orgId: 'org', tier: 'PRO', role: 'ADMIN' });
    for (const [key, , empty] of TABS) {
      renderPage(`/content-studio/intelligence?tab=${key}`);
      await screen.findByText(empty);
      const labels = screen
        .queryAllByRole('button')
        .map((b) => b.getAttribute('aria-label') || b.textContent || '');
      expect(
        labels.filter((l) =>
          /generat|rewrite|shorten|expand|tone|thread|apply|use in|default|verify|compliance|check|score|infer|import|upload/i.test(
            l
          )
        )
      ).toEqual([]);
      await flush();
      cleanup();
    }
  });
});

describe('Brand & AI: routes and navigation', () => {
  const app = join(__dirname, '../../../app/(app)/(site)/content-studio');

  it('PG8 has a thin /content-studio/intelligence page, linked from the Content Studio navigation', () => {
    const page = readFileSync(join(app, 'intelligence/page.tsx'), 'utf8');
    expect(page).toContain('return <ContentStudioIntelligence />;');
    expect(page).not.toMatch(/fetch|useSWR|apiKey/);
    const shell = readFileSync(
      join(__dirname, '../content-studio.shell.tsx'),
      'utf8'
    );
    expect(shell).toContain("href: '/content-studio/intelligence'");
    expect(shell).toContain("t('content_studio_brand_ai', 'Brand & AI')");
  });

  it('keeps the one Content Studio menu entry, active on Brand & AI', () => {
    const {
      TopMenu,
      useMenuItem,
    } = require('@gitroom/frontend/components/layout/top.menu');
    let menu!: { all: any[] };
    const Probe = () => {
      menu = useMenuItem();
      return null;
    };
    render(h(Probe));
    expect(
      menu.all.filter((item) => /content-studio|intelligence/.test(item.path))
    ).toHaveLength(1);
    cleanup();
    setUrl('/content-studio/intelligence?tab=writing');
    render(h(TopMenu));
    const links = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href') === '/content-studio');
    expect(links).toHaveLength(1);
    expect(links[0].className).toContain('bg-boxFocused');
  });
});

describe('Brand & AI: source surface', () => {
  const FILES = [
    'content-studio.ai-connections.tsx',
    'content-studio.audience-profiles.tsx',
    'content-studio.editorial-policy.tsx',
    'content-studio.expertise-profiles.tsx',
    'content-studio.intelligence.api.ts',
    'content-studio.intelligence.shared.tsx',
    'content-studio.intelligence.tsx',
    'content-studio.writing-profiles.tsx',
  ];
  // code only: the comments explain these rules and may name them
  const code = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const sources = Object.fromEntries(
    readdirSync(__dirname)
      .filter((file) => /\.tsx?$/.test(file) && !/\.spec\.ts$/.test(file))
      .map((file) => [file, code(readFileSync(join(__dirname, file), 'utf8'))])
  );
  const all = Object.values(sources).join('\n');
  // the arguments of every call of `name(`, up to its closing parenthesis
  const callArgs = (text: string, name: string) => {
    const found: string[] = [];
    let at = text.indexOf(`${name}(`);
    while (at >= 0) {
      let depth = 0;
      let end = at + name.length;
      for (; end < text.length; end++) {
        if (text[end] === '(') depth++;
        if (text[end] === ')' && --depth === 0) break;
      }
      found.push(text.slice(at, end + 1));
      at = text.indexOf(`${name}(`, end);
    }
    return found;
  };

  it('is exactly these files', () => {
    expect(Object.keys(sources).sort()).toEqual([...FILES].sort());
  });

  it('never stores, logs or routes anything in the browser', () => {
    expect(all).not.toMatch(
      /localStorage|sessionStorage|indexedDB|document\.cookie|console\.|navigator\.sendBeacon|posthog|useTrack/
    );
    expect(all).not.toMatch(
      /router\.push|window\.location|history\.(push|replace)State/
    );
  });

  it('keeps the API key out of cache keys, revalidation, URLs, toasts and stores', () => {
    for (const name of [
      'useSWR',
      'mutate',
      'toaster.show',
      'router.replace',
      'new URLSearchParams',
      'params.set',
      'openModal',
    ]) {
      for (const args of callArgs(all, name)) {
        expect(args).not.toMatch(/apiKey|credential/i);
      }
    }
    // the key exists only in the AI connection dialogs and the two requests
    // that send it
    for (const [file, text] of Object.entries(sources)) {
      if (
        file !== 'content-studio.ai-connections.tsx' &&
        file !== 'content-studio.intelligence.api.ts'
      ) {
        expect(text).not.toMatch(/apiKey/);
      }
    }
    const api = sources['content-studio.intelligence.api.ts'];
    expect(api.match(/credential: \{ apiKey \}/g)).toHaveLength(2);
    expect(api).not.toMatch(/createContext|zustand|redux|useSWRMutation/);
  });

  it('types a connection without any key or sealed value', () => {
    const api = sources['content-studio.intelligence.api.ts'];
    const shape = api.slice(
      api.indexOf('export interface ContentStudioAIConnection {'),
      api.indexOf(
        '}',
        api.indexOf('export interface ContentStudioAIConnection {')
      )
    );
    expect(shape).toContain('credentialPresent: boolean;');
    expect(shape).not.toMatch(/apiKey|sealed|secret|credential:/i);
    expect(all).not.toMatch(/sealedCredential/);
  });

  it('calls no provider, no environment, no delete and no generation endpoint', () => {
    expect(all).not.toMatch(
      /from 'openai'|@anthropic-ai|@ai-sdk|from 'ai'|process\.env|sk-[a-z0-9]/i
    );
    expect(all).not.toMatch(/'DELETE'|"DELETE"/);
    const urls = Array.from(
      all.matchAll(/['`](\/content-studio[^'`]*)['`]/g)
    ).map((m) => m[1]);
    for (const url of urls) {
      expect(url).toMatch(
        /^\/content-studio(\/(ai\/(providers|connections)|writing-profiles|audience-profiles|expertise-profiles|editorial-policy|intelligence))?$/
      );
    }
    expect(all).not.toMatch(
      /\/generate|\/operations|\/execute|ContentStudioConfiguration|defaultProfile/i
    );
  });

  it('uses no raw JSON editor and no innerHTML', () => {
    expect(all).not.toMatch(/JSON\.parse|dangerouslySetInnerHTML|innerHTML/);
  });

  it('the route page exists', () => {
    expect(
      existsSync(
        join(
          __dirname,
          '../../../app/(app)/(site)/content-studio/intelligence/page.tsx'
        )
      )
    ).toBe(true);
  });
});
