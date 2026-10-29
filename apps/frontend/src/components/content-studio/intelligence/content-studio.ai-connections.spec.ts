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

// --- server: the provider catalog and the connections of the organization ---
const SECRET = 'sk-content-studio-test-secret-123';
const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const providers = [
  {
    provider: 'openai',
    displayName: 'OpenAI',
    credentialFields: [
      { name: 'apiKey', label: 'API key', secret: true, required: true },
    ],
    defaultModel: 'gpt-6.1-sol',
    models: [
      {
        id: 'gpt-6.1-sol',
        label: 'GPT-6.1 Sol',
        capabilities: { text: true, structuredOutput: true },
      },
      {
        id: 'gpt-6-luna',
        label: 'GPT-6 Luna',
        capabilities: { text: true, structuredOutput: true },
      },
    ],
  },
  {
    provider: 'anthropic',
    displayName: 'Anthropic',
    credentialFields: [
      { name: 'apiKey', label: 'API key', secret: true, required: true },
      {
        name: 'workspaceId',
        label: 'Workspace ID',
        secret: false,
        required: false,
      },
    ],
    defaultModel: 'claude-opus-5-5',
    models: [
      {
        id: 'claude-opus-5-5',
        label: 'Claude Opus 5.5',
        capabilities: { text: true, structuredOutput: false },
      },
      {
        id: 'claude-haiku-4-5-20251001',
        label: 'Claude Haiku 4.5',
        capabilities: { text: true, structuredOutput: false },
      },
    ],
  },
];
const connection = (
  id: string,
  name: string,
  extra: Record<string, unknown> = {}
) => ({
  id,
  name,
  provider: 'openai',
  defaultModel: 'gpt-6.1-sol',
  disabled: false,
  credentialPresent: true,
  credentialUpdatedAt: '2026-10-01T10:00:00.000Z',
  lastValidatedAt: null,
  lastValidationStatus: null,
  lastValidationCode: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...extra,
});
let connections: any[];
let testAnswer: unknown;

const server = (method: string, url: string, body: any): Reply => {
  const { pathname } = new URL(url, 'https://api.test');
  if (method === 'GET' && pathname === '/content-studio/ai/providers') {
    return reply(200, providers);
  }
  if (method === 'GET' && pathname === '/content-studio/ai/connections') {
    return reply(200, connections);
  }
  if (method === 'POST' && pathname === '/content-studio/ai/connections') {
    const created = connection(
      '33333333-3333-4333-8333-333333333333',
      body.name,
      {
        provider: body.provider,
        defaultModel: body.defaultModel,
      }
    );
    connections = [...connections, created];
    return reply(201, created);
  }
  const match = pathname.match(
    /^\/content-studio\/ai\/connections\/([^/]+)(?:\/(credential|disable|enable|archive|test))?$/
  );
  if (match) {
    const [, id, action] = match;
    const index = connections.findIndex((c) => c.id === id);
    if (index < 0) {
      return reply(404, {
        msg: 'AI connection not found.',
        code: 'CS_NOT_FOUND',
      });
    }
    const current = connections[index];
    const update = (patch: Record<string, unknown>) => {
      connections = connections.map((c, at) =>
        at === index ? { ...c, ...patch } : c
      );
      return reply(200, connections[index]);
    };
    if (method === 'PATCH' && !action) {
      return update(body);
    }
    if (method === 'PUT' && action === 'credential') {
      return update({ credentialUpdatedAt: '2026-10-14T10:00:00.000Z' });
    }
    if (method === 'POST' && action === 'disable') {
      return update({ disabled: true });
    }
    if (method === 'POST' && action === 'enable') {
      return update({ disabled: false });
    }
    if (method === 'POST' && action === 'archive') {
      connections = connections.filter((c) => c.id !== id);
      return reply(200, { id });
    }
    if (method === 'POST' && action === 'test') {
      const answer = testAnswer as { ok: boolean; code?: string };
      update({
        lastValidatedAt: '2026-10-14T11:00:00.000Z',
        lastValidationStatus: answer.ok ? 'valid' : 'invalid',
        lastValidationCode: answer.ok ? null : answer.code ?? null,
      });
      void current;
      return reply(200, testAnswer);
    }
  }
  return reply(404, { msg: 'no route', code: 'CS_NOT_FOUND' });
};

let storageWrites: jest.SpyInstance;
let consoleSpies: jest.SpyInstance[];

beforeEach(() => {
  mockModals.set([]);
  connections = [
    connection(C1, 'Main OpenAI'),
    connection(C2, 'Old Claude', {
      provider: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      disabled: true,
      lastValidatedAt: '2026-10-02T10:00:00.000Z',
      lastValidationStatus: 'invalid',
      lastValidationCode: 'AUTH_FAILED',
    }),
  ];
  testAnswer = { ok: true };
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
  mockUser.mockReturnValue({ orgId: 'org', tier: 'PRO', role: 'ADMIN' });
  storageWrites = jest.spyOn(Storage.prototype, 'setItem');
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
    (level) => jest.spyOn(console, level)
  );
});

afterEach(async () => {
  cleanup();
  await flush();
});

// role null: a user without a role; 'none': no user at all
const open = async (role: string | null = 'ADMIN') => {
  mockUser.mockReturnValue(
    role === 'none' ? undefined : { orgId: 'org', tier: 'PRO', role }
  );
  renderPage('/content-studio/intelligence?tab=ai');
  await screen.findByText('Main OpenAI');
  await flush();
};

// Everywhere a key must never be: the visible text, toasts, the URL and the
// router, browser storage, the SWR cache and the console
const expectNoSecretOutsideTheInput = () => {
  expect(document.body.textContent).not.toContain(SECRET);
  expect(toasts().join('\n')).not.toContain(SECRET);
  expect(
    JSON.stringify([
      mockRouter.replace.mock.calls,
      mockRouter.push.mock.calls,
      mockUrl.pathname,
      mockUrl.params.toString(),
    ])
  ).not.toContain(SECRET);
  expect(JSON.stringify(storageWrites.mock.calls)).not.toContain(SECRET);
  expect(JSON.stringify([...swrCache.keys()])).not.toContain(SECRET);
  expect(
    JSON.stringify(
      [...swrCache.values()].map((entry: any) => entry?.data ?? null)
    )
  ).not.toContain(SECRET);
  for (const spy of consoleSpies) {
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
  }
};
const expectNoSecretAnywhere = () => {
  expectNoSecretOutsideTheInput();
  expect(document.body.innerHTML).not.toContain(SECRET);
};

const openCreate = () => {
  fireEvent.click(button('Add AI connection'));
  return dialog('Add AI connection');
};
const fillCreate = (modal: HTMLElement) => {
  type(field('Connection name (optional)', modal), 'Team OpenAI');
  type(field('API key', modal), SECRET);
};

describe('AI connections: list and roles', () => {
  it('AI1/AI2 loads the provider catalog and the connections, with safe fields only', async () => {
    await open();
    expect(requests('GET', '/content-studio/ai/providers')).toHaveLength(1);
    expect(requests('GET', '/content-studio/ai/connections')).toHaveLength(1);
    const row = screen.getByText('Main OpenAI').closest('li') as HTMLElement;
    expect(row.textContent).toContain('OpenAI');
    expect(row.textContent).toContain('GPT-6.1 Sol');
    expect(row.textContent).toContain('API key stored');
    // UX review 02: a saved key is only connected until a test passed
    expect(row.textContent).toContain('Connected, not tested yet');
    expect(row.textContent).not.toContain('Ready');
    expect(document.body.textContent).not.toMatch(
      /sealed|organizationId|baseURL/i
    );
  });

  it.each([['ADMIN'], ['SUPERADMIN']])(
    'AI3/AI4 %s sees Add and every connection control',
    async (role) => {
      await open(role);
      expect(queryButton('Add AI connection')).not.toBeNull();
      for (const name of [
        'Test Main OpenAI',
        'Edit Main OpenAI',
        'Replace key Main OpenAI',
        'Disable Main OpenAI',
        'Remove Main OpenAI',
        'Enable Old Claude',
      ]) {
        expect(queryButton(name)).not.toBeNull();
      }
    }
  );

  // UX review 03: five large buttons were too heavy on a phone. Test and
  // Edit stay buttons; the key, Disable and Remove are quieter text buttons,
  // each still named, never hidden behind a menu
  it('M2 keeps Test and Edit as buttons and the other actions as named text buttons', async () => {
    await open('ADMIN');
    for (const name of ['Test Main OpenAI', 'Edit Main OpenAI']) {
      expect(button(name).className).toContain('rounded-full');
    }
    for (const name of [
      'Replace key Main OpenAI',
      'Disable Main OpenAI',
      'Remove Main OpenAI',
    ]) {
      expect(button(name).className).not.toContain('rounded-full');
      expect(button(name).className).toContain('h-[32px]');
    }
    expect(button('Remove Main OpenAI').className).toContain('text-red-400');
  });

  it.each([['USER'], [null], ['none'], ['admin'], ['OWNER']])(
    'AI5/AI6 role %p sees the list read-only, with no control at all',
    async (role) => {
      await open(role);
      expect(screen.getByText('Old Claude')).toBeTruthy();
      expect(queryButton('Add AI connection')).toBeNull();
      expect(
        screen
          .queryAllByRole('button')
          .map((b) => b.getAttribute('aria-label') || b.textContent)
          .filter((label) =>
            /test|edit|replace|disable|enable|remove|add ai/i.test(label || '')
          )
      ).toEqual([]);
      expect(
        screen.getByText('Only admins can add or change AI connections.')
      ).toBeTruthy();
    }
  );

  it('AI30 shows a disabled connection as disabled, with its last result in words', async () => {
    await open();
    const row = screen.getByText('Old Claude').closest('li') as HTMLElement;
    expect(row.textContent).toContain('Disabled');
    expect(row.textContent).toContain('Anthropic');
    expect(row.textContent).toContain('Claude Haiku 4.5');
    expect(row.textContent).toContain(
      "We couldn't use this API key. Check the key and try again."
    );
    expect(row.textContent).not.toContain('AUTH_FAILED');
    expect((button('Test Old Claude') as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('shows the empty state', async () => {
    connections = [];
    renderPage('/content-studio/intelligence?tab=ai');
    expect(await screen.findByText('No AI connections yet.')).toBeTruthy();
  });
});

describe('AI connections: create', () => {
  it('AI7/AI8/AI9 offers the catalog providers and only their models, resetting to the default', async () => {
    await open();
    const modal = openCreate();
    const provider = field('Provider', modal) as unknown as HTMLSelectElement;
    const model = field('Model', modal) as unknown as HTMLSelectElement;
    expect(Array.from(provider.options).map((o) => o.textContent)).toEqual([
      'OpenAI',
      'Anthropic',
    ]);
    expect(model.value).toBe('gpt-6.1-sol');
    expect(Array.from(model.options).map((o) => o.value)).toEqual([
      'gpt-6.1-sol',
      'gpt-6-luna',
    ]);
    fireEvent.change(model, { target: { value: 'gpt-6-luna' } });
    fireEvent.change(provider, { target: { value: 'anthropic' } });
    expect(model.value).toBe('claude-opus-5-5');
    expect(Array.from(model.options).map((o) => o.value)).toEqual([
      'claude-opus-5-5',
      'claude-haiku-4-5-20251001',
    ]);
    // the model is a choice only: the text boxes are Anthropic's optional
    // workspace id and the optional name
    expect(
      within(modal)
        .getAllByRole('textbox')
        .map((box) => box.getAttribute('aria-label'))
    ).toEqual(['Workspace ID (optional)', 'Connection name (optional)']);
  });

  it('AI10/AI11/AI12 sends exactly the form with the key, then clears it and reloads the list', async () => {
    await open();
    const modal = openCreate();
    const key = field('API key', modal);
    expect(key.type).toBe('password');
    expect(key.getAttribute('autocomplete')).toBe('new-password');
    fillCreate(modal);
    fireEvent.change(field('Model', modal), {
      target: { value: 'gpt-6-luna' },
    });
    const listLoads = requests('GET', '/content-studio/ai/connections').length;
    fireEvent.click(button('Connect', modal));
    await flush();

    expect(requests('POST', '/content-studio/ai/connections')).toEqual([
      {
        method: 'POST',
        url: '/content-studio/ai/connections',
        body: {
          name: 'Team OpenAI',
          provider: 'openai',
          credential: { apiKey: SECRET },
          defaultModel: 'gpt-6-luna',
        },
      },
      // UX review 02: a new connection is tested right away
      {
        method: 'POST',
        url: '/content-studio/ai/connections/33333333-3333-4333-8333-333333333333/test',
        body: undefined,
      },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toasts()).toEqual(['AI connection created.']);
    expect(
      requests('GET', '/content-studio/ai/connections').length
    ).toBeGreaterThan(listLoads);
    expect(await screen.findByText('Team OpenAI')).toBeTruthy();
    expectNoSecretAnywhere();
  });

  it('AI13 cancel closes the dialog and drops the key; a new dialog starts empty', async () => {
    await open();
    let modal = openCreate();
    fillCreate(modal);
    fireEvent.click(button('Cancel', modal));
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expectNoSecretAnywhere();
    modal = openCreate();
    expect(field('API key', modal).value).toBe('');
    expect(writes()).toEqual([]);
  });

  it('AI14-AI19 keeps the key only in the open field after a refusal, never in a message, URL, storage, cache or log', async () => {
    await open();
    override = (method, url) =>
      method === 'POST' && url === '/content-studio/ai/connections'
        ? reply(400, {
            msg: `The AI credential is invalid. ${SECRET}`,
            code: 'CS_AI_CREDENTIAL_INVALID',
          })
        : undefined;
    const modal = openCreate();
    fillCreate(modal);
    fireEvent.click(button('Connect', modal));
    await flush();

    expect(toasts()).toEqual(['The API key is invalid.']);
    expect(dialog('Add AI connection')).toBeTruthy();
    expect(field('API key', modal).value).toBe(SECRET);
    expectNoSecretOutsideTheInput();

    fireEvent.click(button('Cancel', modal));
    await flush();
    expectNoSecretAnywhere();
  });

  it.each([
    [
      'CS_AI_ADMIN_REQUIRED',
      'You do not have permission to manage AI connections.',
    ],
    ['CS_AI_PROVIDER_UNSUPPORTED', 'This AI provider is not supported.'],
    [
      'CS_AI_MODEL_UNSUPPORTED',
      'This AI model is not supported for this provider.',
    ],
    [
      'CS_AI_SECRET_STORE_UNAVAILABLE',
      'Secure credential storage is temporarily unavailable.',
    ],
    ['SOMETHING_ELSE', 'Could not update the AI connection.'],
  ])('maps %s to a fixed message', async (code, text) => {
    await open();
    override = (method, url) =>
      method === 'POST' && url === '/content-studio/ai/connections'
        ? reply(403, { msg: `raw ${SECRET}`, code })
        : undefined;
    const modal = openCreate();
    fillCreate(modal);
    fireEvent.click(button('Connect', modal));
    await flush();
    expect(toasts()).toEqual([text]);
  });
});

describe('AI connections: edit, key, lifecycle', () => {
  it('AI20/AI21 edits the name and default model; the provider is shown, never changed', async () => {
    await open();
    fireEvent.click(button('Edit Main OpenAI'));
    const modal = dialog('Edit: Main OpenAI');
    expect(within(modal).queryByLabelText('Provider')).toBeNull();
    expect(modal.textContent).toContain('OpenAI');
    expect(within(modal).queryByLabelText('API key')).toBeNull();
    type(field('Name', modal), 'Renamed');
    fireEvent.change(field('Default model', modal), {
      target: { value: 'gpt-6-luna' },
    });
    fireEvent.click(button('Save', modal));
    await flush();
    expect(writes()).toEqual([
      {
        method: 'PATCH',
        url: `/content-studio/ai/connections/${C1}`,
        body: { name: 'Renamed', defaultModel: 'gpt-6-luna' },
      },
    ]);
    expect(toasts()).toEqual(['AI connection updated.']);
    expect(await screen.findByText('Renamed')).toBeTruthy();
  });

  it('AI22/AI23 replaces the key without ever asking for the old one, then clears it', async () => {
    await open();
    const before = calls().length;
    fireEvent.click(button('Replace key Main OpenAI'));
    const modal = dialog('Replace key: Main OpenAI');
    await flush();
    // opening asks for nothing
    expect(calls().slice(before)).toEqual([]);
    expect(modal.textContent).toContain(
      'The current API key cannot be viewed.'
    );
    expect(field('API key', modal).value).toBe('');
    type(field('API key', modal), SECRET);
    fireEvent.click(button('Replace key', modal));
    await flush();
    expect(writes()).toEqual([
      {
        method: 'PUT',
        url: `/content-studio/ai/connections/${C1}/credential`,
        body: { credential: { apiKey: SECRET } },
      },
      // tested again with the new key
      {
        method: 'POST',
        url: `/content-studio/ai/connections/${C1}/test`,
        body: undefined,
      },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toasts()).toEqual(['API key replaced.']);
    expect(
      calls().filter(
        (c) => c.method === 'GET' && /\/ai\/connections\/./.test(c.url)
      )
    ).toEqual([]);
    expectNoSecretAnywhere();
  });

  it('replace-key cancel drops the key, and a refusal keeps it out of messages', async () => {
    await open();
    override = (method, url) =>
      method === 'PUT' && url.endsWith('/credential')
        ? reply(400, { msg: SECRET, code: 'CS_AI_CREDENTIAL_INVALID' })
        : undefined;
    fireEvent.click(button('Replace key Main OpenAI'));
    const modal = dialog('Replace key: Main OpenAI');
    type(field('API key', modal), SECRET);
    fireEvent.click(button('Replace key', modal));
    await flush();
    expect(toasts()).toEqual(['The API key is invalid.']);
    expectNoSecretOutsideTheInput();
    fireEvent.click(button('Cancel', modal));
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expectNoSecretAnywhere();
  });

  it('AI24/AI25 disables after a confirmation and enables again', async () => {
    await open();
    fireEvent.click(button('Disable Main OpenAI'));
    await flush();
    expect(mockConfirm.mock.calls[0][0]).toBe(
      'This prevents Content Studio from using this connection until it is enabled again.'
    );
    fireEvent.click(button('Enable Old Claude'));
    await flush();
    expect(writes().map((w) => `${w.method} ${w.url}`)).toEqual([
      `POST /content-studio/ai/connections/${C1}/disable`,
      `POST /content-studio/ai/connections/${C2}/enable`,
    ]);
    expect(toasts()).toEqual([
      'AI connection disabled.',
      'AI connection enabled.',
    ]);
    expect(
      await screen.findByRole('button', { name: 'Enable Main OpenAI' })
    ).toBeTruthy();
  });

  it('does not disable when the confirmation is declined', async () => {
    await open();
    mockConfirm.mockResolvedValue(false);
    fireEvent.click(button('Disable Main OpenAI'));
    await flush();
    expect(writes()).toEqual([]);
  });

  it('AI26/AI27/AI29 removes through archive after a confirmation about the key, never DELETE', async () => {
    await open();
    fireEvent.click(button('Remove Main OpenAI'));
    await flush();
    const [message, approve] = mockConfirm.mock.calls[0];
    expect(message).toContain('permanently removes its stored API key');
    expect(message).toContain('cannot be restored');
    expect(approve).toBe('Remove');
    expect(writes()).toEqual([
      {
        method: 'POST',
        url: `/content-studio/ai/connections/${C1}/archive`,
        body: undefined,
      },
    ]);
    await waitFor(() => expect(screen.queryByText('Main OpenAI')).toBeNull());
    expect(calls().map((c) => c.method)).not.toContain('DELETE');
    expect(toasts()).toEqual(['AI connection removed.']);
  });
});

describe('AI connections: test', () => {
  it.each([
    ['TC1', { ok: true }, 'Connection works.'],
    [
      'TC2',
      { ok: false, code: 'AUTH_FAILED' },
      "We couldn't use this API key. Check the key and try again.",
    ],
    [
      'TC3',
      { ok: false, code: 'RATE_LIMITED' },
      'The provider is rate limiting this connection. Try again later.',
    ],
    [
      'TC4',
      { ok: false, code: 'QUOTA_EXCEEDED' },
      'The key works, but the provider account has no API credit left, so nothing can be generated. Add credit in your provider account, then test again.',
    ],
    [
      'TC5',
      { ok: false, code: 'PROVIDER_UNAVAILABLE' },
      'The provider is temporarily unavailable.',
    ],
    [
      'TC6',
      { ok: false, code: 'TIMEOUT' },
      'The provider did not respond in time.',
    ],
    [
      'TC7',
      { ok: false, code: 'MODEL_UNAVAILABLE' },
      'This model is not available for this connection. Choose another model with Edit.',
    ],
    [
      'TC8',
      { ok: false, code: 'INVALID_RESPONSE' },
      'The provider returned an unexpected response.',
    ],
    [
      'TC8b',
      { ok: false, code: 'REQUEST_REJECTED' },
      'The provider refused the request. Check the API key and the model, then test again.',
    ],
    [
      'TC9',
      { ok: false, code: 'NEW_CODE', message: `raw provider text ${SECRET}` },
      'The connection test did not succeed.',
    ],
  ])('%s AI28 shows a fixed message for %j', async (_id, answer, text) => {
    await open();
    testAnswer = answer;
    fireEvent.click(button('Test Main OpenAI'));
    await flush();
    expect(toasts()).toEqual([text]);
    expect(document.body.textContent).not.toMatch(/raw provider text|NEW_CODE/);
    expectNoSecretAnywhere();
  });

  it('TC10 reloads the list after a test, so the last result shows; one test at a time', async () => {
    await open();
    testAnswer = { ok: true };
    const listLoads = requests('GET', '/content-studio/ai/connections').length;
    fireEvent.click(button('Test Main OpenAI'));
    fireEvent.click(button('Test Main OpenAI'));
    await flush();
    expect(
      requests('POST', `/content-studio/ai/connections/${C1}/test`)
    ).toHaveLength(1);
    expect(
      requests('GET', '/content-studio/ai/connections').length
    ).toBeGreaterThan(listLoads);
    const row = screen.getByText('Main OpenAI').closest('li') as HTMLElement;
    await waitFor(() => expect(row.textContent).toContain('Ready'));
  });
});

// UX review 02: Lambert's Anthropic key was valid but not scoped to a
// workspace, so every call was refused; a connection now says whether it
// works, and an Anthropic one can name its workspace
describe('AI connections: health and Anthropic workspaces (review 02)', () => {
  it('AH1 an Anthropic connection can name its workspace; other providers are not asked', async () => {
    await open();
    const modal = openCreate();
    expect(
      within(modal).queryByLabelText('Workspace ID (optional)')
    ).toBeNull();
    fireEvent.change(field('Provider', modal), {
      target: { value: 'anthropic' },
    });
    type(field('API key', modal), SECRET);
    type(field('Workspace ID (optional)', modal), ' wrkspc_01Team ');
    fireEvent.click(button('Connect', modal));
    await flush();
    expect(requests('POST', '/content-studio/ai/connections')[0].body).toEqual({
      name: 'Anthropic',
      provider: 'anthropic',
      credential: { apiKey: SECRET, workspaceId: 'wrkspc_01Team' },
      defaultModel: 'claude-opus-5-5',
    });
    expectNoSecretAnywhere();
  });

  it('AH2 a key replaced on an Anthropic connection can carry the workspace id', async () => {
    await open();
    fireEvent.click(button('Replace key Old Claude'));
    const modal = dialog('Replace key: Old Claude');
    type(field('API key', modal), SECRET);
    type(field('Workspace ID (optional)', modal), 'wrkspc_01Team');
    fireEvent.click(button('Replace key', modal));
    await flush();
    expect(writes()[0]).toEqual({
      method: 'PUT',
      url: `/content-studio/ai/connections/${C2}/credential`,
      body: { credential: { apiKey: SECRET, workspaceId: 'wrkspc_01Team' } },
    });
  });

  it('AH3 Ready only after a passed test; a failed one needs attention, in words', async () => {
    connections = [
      connection(C1, 'Main OpenAI', {
        lastValidatedAt: '2026-10-27T10:00:00.000Z',
        lastValidationStatus: 'valid',
      }),
      connection(C2, 'Team Claude', {
        provider: 'anthropic',
        defaultModel: 'claude-opus-5-5',
        lastValidatedAt: '2026-10-27T10:00:00.000Z',
        lastValidationStatus: 'invalid',
        lastValidationCode: 'WORKSPACE_REQUIRED',
      }),
    ];
    await open();
    const ready = screen.getByText('Main OpenAI').closest('li') as HTMLElement;
    expect(ready.textContent).toContain('Ready');
    const attention = screen
      .getByText('Team Claude')
      .closest('li') as HTMLElement;
    expect(attention.textContent).toContain('Needs attention');
    expect(attention.textContent).toContain(
      'This Anthropic key is not tied to a workspace.'
    );
    expect(attention.textContent).not.toContain('WORKSPACE_REQUIRED');
  });

  it('AH4 a model the catalog no longer offers is named, and Edit proposes the recommended one', async () => {
    connections = [
      connection(C1, 'Main OpenAI', { defaultModel: 'gpt-retired-model' }),
    ];
    await open();
    expect(
      screen.getByText(/The previously selected model is no longer available/)
    ).toBeTruthy();
    fireEvent.click(button('Edit Main OpenAI'));
    const modal = dialog('Edit: Main OpenAI');
    expect(
      within(modal).getByText(
        'The previously selected model is no longer available. Choose another.'
      )
    ).toBeTruthy();
    expect(field('Default model', modal).value).toBe('gpt-6.1-sol');
    fireEvent.click(button('Save', modal));
    await flush();
    expect(writes()[0].body).toEqual({
      name: 'Main OpenAI',
      defaultModel: 'gpt-6.1-sol',
    });
  });
});
