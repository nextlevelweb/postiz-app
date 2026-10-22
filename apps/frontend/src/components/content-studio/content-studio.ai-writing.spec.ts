import React, {
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
import { SWRConfig, useSWRConfig } from 'swr';

// AI writing in the package workspace, with the workspace harness: a .spec.ts
// without JSX, components required (not imported), real SWR with a fresh
// cache per test, and an in-memory server that also answers the AI routes

const mockRouter = { push: jest.fn(), replace: jest.fn() };
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  usePathname: () => '/content-studio/pkg-1',
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

// the existing media library, as a stub with its real props
const mockMediaBox = jest.fn();
jest.mock('@gitroom/frontend/components/media/media.component', () => {
  const { createElement } = require('react');
  return {
    MediaBox: (props: unknown) => {
      mockMediaBox(props);
      return createElement('div', { 'data-testid': 'media-box' });
    },
  };
});
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

const { ContentStudioWorkspace } = require('./content-studio.workspace');

// --- the server ---
const PKG = 'pkg-1';
const BASE = `/content-studio/packages/${PKG}`;
const HANDOFF = 'a'.repeat(64);
type Item = { id: string; text: string; mediaIds: string[] };
const draftOf = (...items: Item[]) => ({
  schemaVersion: 1,
  copy: { global: { thread: items } },
});
const item = (id: string, text: string, mediaIds: string[] = []): Item => ({
  id,
  text,
  mediaIds,
});
const preview = (
  id: string,
  status = 'ready',
  thumbnail: string | null = `/t/${id}.png`
) => ({
  id,
  path: `/uploads/${id}.png`,
  thumbnail,
  alt: null,
  status,
});
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

interface Revision {
  id: string;
  revisionNumber: number;
  origin: string;
  sourceDraftVersion: number;
  content: ReturnType<typeof draftOf>;
}
let server: {
  name: string;
  draft: ReturnType<typeof draftOf>;
  draftVersion: number;
  archivedAt: string | null;
  media: Record<string, ReturnType<typeof preview> | null>;
  revisions: Revision[];
};
type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
let override: (
  method: string,
  url: string,
  body: any
) => Reply | Promise<Reply> | undefined;
const revisionSummary = (r: Revision) => ({
  id: r.id,
  revisionNumber: r.revisionNumber,
  contentHash: `hash-${r.revisionNumber}`,
  origin: r.origin,
  sourceDraftVersion: r.sourceDraftVersion,
  createdAt: '2026-10-10T10:00:00.000Z',
  createdBy: { id: 'u1', name: 'Robin' },
});
const handle = (method: string, url: string, body: any): Reply => {
  const path = url.split('?')[0];
  if (method === 'GET' && path === BASE) {
    return reply(200, {
      id: PKG,
      name: server.name,
      projectId: null,
      draft: JSON.parse(JSON.stringify(server.draft)),
      draftVersion: server.draftVersion,
      latestRevisionNumber: server.revisions.length,
      archivedAt: server.archivedAt,
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-11T10:00:00.000Z',
      media: { ...server.media },
    });
  }
  if (method === 'PUT' && path === `${BASE}/draft`) {
    if (server.archivedAt) {
      return reply(409, { msg: 'archived', code: 'CS_PACKAGE_ARCHIVED' });
    }
    if (body.baseDraftVersion !== server.draftVersion) {
      return reply(409, {
        msg: 'changed',
        code: 'CS_DRAFT_VERSION_CONFLICT',
        currentDraftVersion: server.draftVersion,
      });
    }
    server.draft = body.draft;
    server.draftVersion += 1;
    return reply(200, { draftVersion: server.draftVersion });
  }
  if (method === 'POST' && path === `${BASE}/revisions`) {
    if (server.archivedAt) {
      return reply(409, { msg: 'archived', code: 'CS_PACKAGE_ARCHIVED' });
    }
    if (body.draftVersion !== server.draftVersion) {
      return reply(409, { msg: 'x', code: 'CS_DRAFT_VERSION_CONFLICT' });
    }
    const latest = server.revisions[0];
    if (
      latest &&
      JSON.stringify(latest.content) === JSON.stringify(server.draft)
    ) {
      return reply(200, { created: false, revision: revisionSummary(latest) });
    }
    const revision = {
      id: `rev-${server.revisions.length + 1}`,
      revisionNumber: server.revisions.length + 1,
      origin: body.origin,
      sourceDraftVersion: server.draftVersion,
      content: JSON.parse(JSON.stringify(server.draft)),
    };
    server.revisions.unshift(revision);
    return reply(201, { created: true, revision: revisionSummary(revision) });
  }
  if (method === 'GET' && path === `${BASE}/revisions`) {
    const page = Number(new URLSearchParams(url.split('?')[1]).get('page'));
    return reply(200, {
      pages: Math.ceil(server.revisions.length / 20),
      results: server.revisions
        .slice((page - 1) * 20, page * 20)
        .map(revisionSummary),
    });
  }
  const detail = path.match(
    /^\/content-studio\/packages\/pkg-1\/revisions\/([^/]+)$/
  );
  if (method === 'GET' && detail) {
    const revision = server.revisions.find((r) => r.id === detail[1]);
    return revision
      ? reply(
          200,
          deepFreeze({
            ...revisionSummary(revision),
            packageId: PKG,
            schemaVersion: 1,
            // canonical order, as stored
            content: JSON.parse(JSON.stringify(revision.content)),
            media: { m1: preview('m1'), gone: null },
          })
        )
      : reply(404, { code: 'CS_NOT_FOUND' });
  }
  if (
    method === 'POST' &&
    /^\/content-studio\/packages\/pkg-1\/revisions\/[^/]+\/handoffs$/.test(path)
  ) {
    return reply(201, { id: HANDOFF, expiresAt: '2026-10-14T10:00:00.000Z' });
  }
  const answer = handleAI(method, path, url, body);
  if (answer) {
    return answer;
  }
  return reply(404, { msg: 'no route', code: 'CS_NOT_FOUND' });
};

const calls = () =>
  mockFetch.mock.calls.map(([url, init]) => ({
    method: (init?.method as string) || 'GET',
    url: url as string,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  }));
const of = (method: string, path: string) =>
  calls().filter((c) => c.method === method && c.url.split('?')[0] === path);
const puts = () => of('PUT', `${BASE}/draft`);
const putTexts = () =>
  puts().map((c) => [
    c.body.draft.copy.global.thread.map((i: Item) => i.text).join('|'),
    c.body.baseDraftVersion,
  ]);
const revisionPosts = () => of('POST', `${BASE}/revisions`);
const handoffPosts = () =>
  calls().filter((c) => c.method === 'POST' && c.url.endsWith('/handoffs'));
const toasts = () => mockToast.mock.calls.map(([text]) => text);

const settle = () =>
  act(async () => {
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
    }
  });
const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await settle();
};

let swrMutate: ReturnType<typeof useSWRConfig>['mutate'];
const Probe = () => {
  swrMutate = useSWRConfig().mutate;
  return null;
};
const renderWorkspace = async (cache = new Map()) => {
  const view = render(
    h(
      SWRConfig,
      { value: { provider: () => cache, dedupingInterval: 0 } },
      h(Probe),
      h(ModalHost),
      h(ContentStudioWorkspace, { packageId: PKG })
    )
  );
  await settle();
  return view;
};
const box = (name: string) =>
  screen.getByRole('textbox', { name }) as HTMLTextAreaElement;
const type = (name: string, value: string) =>
  fireEvent.change(box(name), { target: { value } });
const button = (name: string | RegExp, root: HTMLElement = document.body) =>
  within(root).getByRole('button', { name });
const click = async (name: string | RegExp, root?: HTMLElement) => {
  fireEvent.click(button(name, root));
  await settle();
};
const status = () => screen.getByRole('status').textContent;
const deferNext = (method: string, suffix: string) => {
  let release!: () => void;
  const previous = override;
  let used = false;
  override = (m, url, body) => {
    if (!used && m === method && url.split('?')[0].endsWith(suffix)) {
      used = true;
      return new Promise<Reply>((resolve) => {
        release = () => resolve(handle(m, url, body));
      });
    }
    return previous(m, url, body);
  };
  return async () => {
    release();
    await settle();
  };
};
const pick = async (selection: unknown[]) => {
  const props = mockMediaBox.mock.calls[mockMediaBox.mock.calls.length - 1][0];
  act(() => props.setMedia(selection));
  await settle();
};

beforeEach(() => {
  jest.useFakeTimers();
  mockModals.set([]);
  server = {
    name: 'Spring launch',
    draft: draftOf(
      item('main', 'Hello\nworld  ', ['m1', 'm2']),
      item('f1', 'Second', ['m3', 'gone']),
      item('f2', 'Third')
    ),
    draftVersion: 4,
    archivedAt: null,
    media: {
      m1: preview('m1'),
      m2: preview('m2', 'processing'),
      m3: preview('m3', 'failed', null),
      gone: null,
    },
    revisions: [],
  };
  override = () => undefined;
  mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    return (await override(method, url, body)) ?? handle(method, url, body);
  });
  mockOpenModal.mockImplementation((params: Omit<MockModal, 'id'>) =>
    mockModals.set([
      ...mockModals.list,
      { ...params, id: `modal-${++modalId}` },
    ])
  );
  mockConfirm.mockResolvedValue(true);
});
afterEach(async () => {
  cleanup();
  await settle();
  jest.useRealTimers();
});

// --- the AI side of the server ---
const MARKER = 'WORKSPACE_AI_PRIVATE_MARKER_123';
const KEY = 'sk-content-studio-test-secret-123';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const WRITING = 'a1111111-1111-4111-8111-111111111111';
const AUDIENCE = 'b1111111-1111-4111-8111-111111111111';
const EXPERTISE = 'c1111111-1111-4111-8111-111111111111';
const connection = (overrides: Record<string, unknown> = {}) => ({
  id: CONNECTION,
  name: 'Team OpenAI',
  provider: 'openai',
  defaultModel: 'gpt-6-luna',
  disabled: false,
  credentialPresent: true,
  credentialUpdatedAt: '2026-10-01T10:00:00.000Z',
  lastValidatedAt: null,
  lastValidationStatus: null,
  lastValidationCode: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...overrides,
});
const model = (id: string, label: string) => ({
  id,
  label,
  capabilities: { text: true, structuredOutput: false },
});
const PROVIDERS = [
  {
    provider: 'openai',
    displayName: 'OpenAI',
    credentialFields: [
      { name: 'apiKey', label: 'API key', secret: true, required: true },
    ],
    defaultModel: 'gpt-6.1-sol',
    models: [
      model('gpt-6.1-sol', 'GPT-6.1 Sol'),
      model('gpt-6-luna', 'GPT-6 Luna'),
    ],
  },
  {
    provider: 'anthropic',
    displayName: 'Anthropic',
    credentialFields: [
      { name: 'apiKey', label: 'API key', secret: true, required: true },
    ],
    defaultModel: 'claude-opus-5-5',
    models: [
      model('claude-opus-5-5', 'Claude Opus 5.5'),
      model('claude-haiku-5-5', 'Claude Haiku 5.5'),
    ],
  },
];
const profile = (
  id: string,
  name: string,
  archivedAt: string | null = null
) => ({
  id,
  name,
  latestRevisionNumber: 3,
  archivedAt,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
});

// sources: ingested ones, one never captured, one archived
const SOURCE = (n: number) => `f${n}111111-1111-4111-8111-111111111111`;
const sourceRow = (
  n: number,
  name: string,
  latestVersionNumber: number,
  archivedAt: string | null = null
) => ({
  id: SOURCE(n),
  kind: 'url',
  name,
  canonicalUrl: `https://example.com/source-${n}?token=URL_PRIVATE`,
  latestVersionNumber,
  archivedAt,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
});
// the exact capture the server answers for a chosen source
const capture = (id: string) => {
  const row = ai.sources.find((source) => source.id === id)!;
  const n = Number(id[1]);
  return {
    sourceId: id,
    versionId: `0${n}222222-2222-4222-8222-222222222222`,
    versionNumber: row.latestVersionNumber,
    contentHash: String(n).repeat(64),
    name: row.name,
    title: n === 2 ? null : `Title of ${row.name}`,
  };
};

let ai: {
  connections: ReturnType<typeof connection>[];
  profiles: Record<string, ReturnType<typeof profile>[]>;
  policyRevisions: number;
  sources: ReturnType<typeof sourceRow>[];
  propose?: (kind: 'item' | 'thread', body: any) => Reply;
};

const proposeAnswer = (kind: 'item' | 'thread', body: any): Reply => {
  if (body.baseDraftVersion !== server.draftVersion) {
    return reply(409, { msg: 'changed', code: 'CS_DRAFT_VERSION_CONFLICT' });
  }
  return reply(200, {
    operationId: '66666666-6666-4666-8666-666666666666',
    baseDraftVersion: body.baseDraftVersion,
    provenance: { sources: (body.sourceIds || []).map(capture) },
    proposal:
      kind === 'item'
        ? {
            type: 'item',
            itemId: body.itemId,
            text: `Suggested ${body.itemId}`,
          }
        : {
            type: 'thread',
            items: server.draft.copy.global.thread.map((i) => ({
              itemId: i.id,
              text: `Suggested ${i.id}`,
            })),
          },
  });
};

function handleAI(
  method: string,
  path: string,
  url: string,
  body: any
): Reply | undefined {
  if (method === 'GET' && path === '/content-studio/ai/connections') {
    return reply(200, ai.connections);
  }
  if (method === 'GET' && path === '/content-studio/ai/providers') {
    return reply(200, PROVIDERS);
  }
  const list = path.match(
    /^\/content-studio\/(writing|audience|expertise)-profiles$/
  );
  if (method === 'GET' && list) {
    const query = new URLSearchParams(url.split('?')[1]);
    const archived = query.get('archived') === 'true';
    return reply(200, {
      pages: 1,
      results: ai.profiles[list[1]].filter((p) => !!p.archivedAt === archived),
    });
  }
  if (
    method === 'GET' &&
    path === '/content-studio/editorial-policy/revisions'
  ) {
    return reply(200, {
      pages: ai.policyRevisions ? 1 : 0,
      results: Array.from({ length: ai.policyRevisions }, (_, i) => ({
        id: `d2222222-2222-4222-8222-00000000000${i + 1}`,
        revisionNumber: ai.policyRevisions - i,
        schemaVersion: 1,
        contentHash: 'f'.repeat(64),
        createdAt: '2026-10-01T10:00:00.000Z',
      })),
    });
  }
  if (method === 'GET' && path === '/content-studio/sources') {
    const query = new URLSearchParams(url.split('?')[1]);
    const archived = query.get('archived') === 'true';
    return reply(200, {
      pages: 1,
      results: ai.sources.filter((s) => !!s.archivedAt === archived),
    });
  }
  const propose = path.match(
    /^\/content-studio\/packages\/pkg-1\/ai\/(item|thread)$/
  );
  if (method === 'POST' && propose) {
    const kind = propose[1] as 'item' | 'thread';
    return (ai.propose || proposeAnswer)(kind, body);
  }
  return undefined;
}

beforeEach(() => {
  ai = {
    connections: [
      connection(),
      connection({
        id: '45555555-5555-4555-8555-555555555555',
        name: 'Claude',
        provider: 'anthropic',
        defaultModel: null,
      }),
      connection({
        id: '46666666-6666-4666-8666-666666666666',
        name: 'Paused',
        disabled: true,
      }),
      connection({
        id: '47777777-7777-4777-8777-777777777777',
        name: 'No key',
        credentialPresent: false,
      }),
    ],
    profiles: {
      writing: [
        profile(WRITING, 'Brand voice'),
        profile(
          'a9999999-1111-4111-8111-111111111111',
          'Old voice',
          '2026-10-02T10:00:00.000Z'
        ),
      ],
      audience: [profile(AUDIENCE, 'Founders')],
      expertise: [profile(EXPERTISE, 'Bookkeeping')],
    },
    policyRevisions: 2,
    sources: [
      sourceRow(1, 'Weekly news', 3),
      sourceRow(2, 'Market report', 1),
      sourceRow(3, 'Not captured yet', 0),
      sourceRow(4, 'Old source', 2, '2026-10-02T10:00:00.000Z'),
      sourceRow(5, 'Blog D', 1),
      sourceRow(6, 'Blog E', 1),
      sourceRow(7, 'Blog F', 1),
      sourceRow(8, 'Blog G', 2),
    ],
  };
});

// --- helpers ---
const aiPosts = () =>
  calls().filter(
    (c) => c.method === 'POST' && /\/ai\/(item|thread)$/.test(c.url)
  );
const dialog = () => screen.getByRole('dialog', { name: 'AI writing' });
const queryDialog = () => screen.queryByRole('dialog', { name: 'AI writing' });
const choose = (label: string, value: string) =>
  fireEvent.change(within(dialog()).getByRole('combobox', { name: label }), {
    target: { value },
  });
const optionsOf = (label: string) =>
  Array.from(
    (
      within(dialog()).getByRole('combobox', {
        name: label,
      }) as HTMLSelectElement
    ).options
  ).map((o) => [o.value, o.textContent]);
const instruction = (label: string, value: string) =>
  fireEvent.change(within(dialog()).getByRole('textbox', { name: label }), {
    target: { value },
  });
const openItem = async (label = 'Post') => {
  await click(`AI writing ${label}`);
  return dialog();
};
const generate = async () => {
  await click('Generate suggestion', dialog());
};
const review = () => screen.getByRole('region', { name: 'AI suggestion' });
const queryReview = () =>
  screen.queryByRole('region', { name: 'AI suggestion' });
const panels = (root: HTMLElement, itemId: string) =>
  Array.from(
    root.querySelectorAll(
      `[data-proposal-item="${itemId}"] .whitespace-pre-wrap`
    )
  ).map((node) => node.textContent);

describe('AI writing: availability', () => {
  it('FW1-FW3 shows an AI control per post and one for the thread, for any member', async () => {
    await renderWorkspace();
    expect(button('AI writing Post')).toHaveProperty('disabled', false);
    expect(button('AI writing Follow-up 1')).toHaveProperty('disabled', false);
    expect(button('AI writing Follow-up 2')).toHaveProperty('disabled', false);
    expect(button('AI thread')).toHaveProperty('disabled', false);
    // nothing about AI is loaded until a dialog opens
    expect(calls()).toEqual([{ method: 'GET', url: BASE, body: undefined }]);
  });

  it('turns the AI controls off for an archived package', async () => {
    server.archivedAt = '2026-10-05T10:00:00.000Z';
    await renderWorkspace();
    expect(button('AI writing Post')).toHaveProperty('disabled', true);
    expect(button('AI thread')).toHaveProperty('disabled', true);
  });

  it('FW4/FW5/FW6/FW7 without a usable connection: points to Brand & AI and offers no generation', async () => {
    ai.connections = ai.connections.filter(
      (c) => c.disabled || !c.credentialPresent
    );
    await renderWorkspace();
    const root = await openItem();
    expect(
      within(root).getByText('Connect an AI provider in Brand & AI.')
    ).toBeTruthy();
    expect(
      within(root)
        .getByRole('link', { name: 'Brand & AI' })
        .getAttribute('href')
    ).toBe('/content-studio/intelligence?tab=ai');
    expect(
      within(root).queryByRole('button', { name: 'Generate suggestion' })
    ).toBeNull();
    expect(aiPosts()).toHaveLength(0);
  });

  it('FS1/FW6/FW7 lists enabled connections with a key only, by name and provider', async () => {
    await renderWorkspace();
    await openItem();
    expect(optionsOf('AI connection')).toEqual([
      [CONNECTION, 'Team OpenAI (OpenAI)'],
      ['45555555-5555-4555-8555-555555555555', 'Claude (Anthropic)'],
    ]);
  });

  it('FS2/FS3/FW8 takes the models from the catalog and preselects the default', async () => {
    await renderWorkspace();
    await openItem();
    expect(optionsOf('Model')).toEqual([
      ['gpt-6.1-sol', 'GPT-6.1 Sol'],
      ['gpt-6-luna', 'GPT-6 Luna'],
    ]);
    // the connection's own default model
    expect(
      (
        within(dialog()).getByRole('combobox', {
          name: 'Model',
        }) as HTMLSelectElement
      ).value
    ).toBe('gpt-6-luna');
    // no default model: the provider's default
    choose('AI connection', '45555555-5555-4555-8555-555555555555');
    await settle();
    expect(optionsOf('Model').map(([id]) => id)).toEqual([
      'claude-opus-5-5',
      'claude-haiku-5-5',
    ]);
    expect(
      (
        within(dialog()).getByRole('combobox', {
          name: 'Model',
        }) as HTMLSelectElement
      ).value
    ).toBe('claude-opus-5-5');
    expect(
      within(dialog()).queryAllByRole('textbox', { name: /model/i })
    ).toEqual([]);
  });

  it('falls back to the provider default when the connection model left the catalog', async () => {
    ai.connections[0] = connection({ defaultModel: 'gpt-4-retired' });
    await renderWorkspace();
    await openItem();
    expect(
      (
        within(dialog()).getByRole('combobox', {
          name: 'Model',
        }) as HTMLSelectElement
      ).value
    ).toBe('gpt-6.1-sol');
  });
});

describe('AI writing: context selection', () => {
  it('FS4/FS6/FS7/FS8 offers None and the active profiles of each kind, never archived ones', async () => {
    await renderWorkspace();
    await openItem();
    expect(optionsOf('Writing Profile')).toEqual([
      ['', 'None'],
      [WRITING, 'Brand voice'],
    ]);
    expect(optionsOf('Audience Profile')).toEqual([
      ['', 'None'],
      [AUDIENCE, 'Founders'],
    ]);
    expect(optionsOf('Expertise Profile')).toEqual([
      ['', 'None'],
      [EXPERTISE, 'Bookkeeping'],
    ]);
    for (const base of ['writing', 'audience', 'expertise']) {
      expect(
        of('GET', `/content-studio/${base}-profiles`).map((c) => c.url)
      ).toEqual([`/content-studio/${base}-profiles?page=1&archived=false`]);
    }
  });

  it('FS9/FP6 loads no profile or policy content: names and the policy history page only', async () => {
    await renderWorkspace();
    await openItem();
    const urls = calls()
      .map((c) => c.url)
      .filter((url) => url !== BASE);
    expect([...urls].sort()).toEqual(
      [
        '/content-studio/ai/connections',
        '/content-studio/ai/providers',
        '/content-studio/audience-profiles?page=1&archived=false',
        '/content-studio/editorial-policy/revisions?page=1',
        '/content-studio/expertise-profiles?page=1&archived=false',
        '/content-studio/sources?page=1&archived=false',
        '/content-studio/writing-profiles?page=1&archived=false',
      ].sort()
    );
  });

  it('FS5 the editorial policy is an explicit toggle, off by default and off without a policy', async () => {
    await renderWorkspace();
    await openItem();
    const toggle = within(dialog()).getByRole('checkbox', {
      name: 'Use Editorial Policy',
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
  });

  it('FS5 without a saved policy the toggle is off and explained', async () => {
    ai.policyRevisions = 0;
    await renderWorkspace();
    await openItem();
    const toggle = within(dialog()).getByRole('checkbox', {
      name: 'Use Editorial Policy',
    }) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(
      within(dialog()).getByText('No editorial policy has been saved yet.')
    ).toBeTruthy();
    await generate();
    expect(aiPosts()[0].body.editorialPolicy).toBe(false);
  });

  it('FS10/FS11 starts empty every time: nothing chosen earlier is kept', async () => {
    await renderWorkspace();
    await openItem();
    choose('Writing Profile', WRITING);
    choose('Model', 'gpt-6.1-sol');
    instruction('Additional instruction', 'Mention the sale');
    await click('Cancel', dialog());
    expect(queryDialog()).toBeNull();
    await openItem();
    expect(
      (
        within(dialog()).getByRole('combobox', {
          name: 'Writing Profile',
        }) as HTMLSelectElement
      ).value
    ).toBe('');
    expect(
      (
        within(dialog()).getByRole('combobox', {
          name: 'Model',
        }) as HTMLSelectElement
      ).value
    ).toBe('gpt-6-luna');
    expect(
      (
        within(dialog()).getByRole('textbox', {
          name: 'Additional instruction',
        }) as HTMLTextAreaElement
      ).value
    ).toBe('');
  });
});

describe('AI writing: saving first', () => {
  it('FG1-FG5/FG8 saves the pending edit first and asks with the version that save returned', async () => {
    await renderWorkspace();
    type('Post', 'Edited before AI');
    expect(status()).toBe('Unsaved changes');
    await openItem();
    await generate();
    const order = calls()
      .filter((c) => c.method !== 'GET')
      .map((c) => `${c.method} ${c.url}`);
    expect(order).toEqual([`PUT ${BASE}/draft`, `POST ${BASE}/ai/item`]);
    expect(puts()[0].body.baseDraftVersion).toBe(4);
    expect(putTexts()[0][0]).toBe('Edited before AI|Second|Third');
    expect(aiPosts()[0].body.baseDraftVersion).toBe(5);
    expect(server.draftVersion).toBe(5);
  });

  it('asks right away with the current version when nothing is pending', async () => {
    await renderWorkspace();
    await openItem();
    await generate();
    expect(puts()).toHaveLength(0);
    expect(aiPosts()[0].body.baseDraftVersion).toBe(4);
  });

  it('M12 waits for a running save and uses its new version', async () => {
    await renderWorkspace();
    type('Post', 'Saving now');
    const release = deferNext('PUT', '/draft');
    await advance(1500);
    expect(status()).toBe('Saving...');
    await openItem();
    fireEvent.click(button('Generate suggestion', dialog()));
    await settle();
    expect(aiPosts()).toHaveLength(0);
    await release();
    expect(aiPosts()).toHaveLength(1);
    expect(aiPosts()[0].body.baseDraftVersion).toBe(5);
  });

  it('FG6 a failed save asks nothing', async () => {
    await renderWorkspace();
    type('Post', 'Will fail');
    override = (m, url) =>
      m === 'PUT' && url.endsWith('/draft')
        ? reply(500, { code: 'CS_INTERNAL' })
        : undefined;
    await openItem();
    await generate();
    expect(puts()).toHaveLength(1);
    expect(aiPosts()).toHaveLength(0);
    expect(toasts()).toContain('Could not save this Content Studio draft.');
    expect(queryReview()).toBeNull();
    // the dialog stays open for another try
    expect(queryDialog()).not.toBeNull();
  });

  it('FG7 a conflicting save asks nothing', async () => {
    await renderWorkspace();
    server.draftVersion = 9;
    type('Post', 'Conflicting');
    await openItem();
    await generate();
    expect(puts()).toHaveLength(1);
    expect(aiPosts()).toHaveLength(0);
    expect(status()).toBe('Conflict');
  });

  it('locks the editor while the suggestion is generated', async () => {
    await renderWorkspace();
    const release = deferNext('POST', '/ai/item');
    await openItem();
    fireEvent.click(button('Generate suggestion', dialog()));
    await settle();
    expect(box('Post')).toHaveProperty('disabled', true);
    expect(button('Generate suggestion', dialog())).toHaveProperty(
      'disabled',
      true
    );
    // a second click asks nothing more
    fireEvent.click(button('Generate suggestion', dialog()));
    await settle();
    await release();
    expect(aiPosts()).toHaveLength(1);
    expect(box('Post')).toHaveProperty('disabled', false);
  });
});

describe('AI writing: item actions', () => {
  it.each([
    ['FI1', 'generate_item', 'Generate'],
    ['FI2', 'rewrite_item', 'Rewrite'],
    ['FI3', 'shorten_item', 'Shorten'],
    ['FI4', 'expand_item', 'Expand'],
    ['FI5', 'change_tone', 'Change tone'],
  ])('%s sends %s for the post', async (_n, operation) => {
    await renderWorkspace();
    await openItem('Follow-up 2');
    choose('AI action', operation);
    if (operation === 'change_tone') {
      instruction('Tone', 'Playful');
    }
    await generate();
    expect(aiPosts()).toHaveLength(1);
    expect(aiPosts()[0].url).toBe(`${BASE}/ai/item`);
    expect(aiPosts()[0].body).toMatchObject({ operation, itemId: 'f2' });
  });

  it('offers the five actions for a post with text and Generate only for an empty one', async () => {
    server.draft.copy.global.thread[1].text = '  ';
    await renderWorkspace();
    await openItem();
    expect(optionsOf('AI action')).toEqual([
      ['generate_item', 'Generate'],
      ['rewrite_item', 'Rewrite'],
      ['shorten_item', 'Shorten'],
      ['expand_item', 'Expand'],
      ['change_tone', 'Change tone'],
    ]);
    await click('Cancel', dialog());
    await openItem('Follow-up 1');
    expect(optionsOf('AI action')).toEqual([['generate_item', 'Generate']]);
  });

  it('FI6 change tone needs a tone', async () => {
    await renderWorkspace();
    await openItem();
    choose('AI action', 'change_tone');
    expect(
      within(dialog()).getByRole('textbox', { name: 'Tone' })
    ).toBeTruthy();
    expect(button('Generate suggestion', dialog())).toHaveProperty(
      'disabled',
      true
    );
    instruction('Tone', '   ');
    expect(button('Generate suggestion', dialog())).toHaveProperty(
      'disabled',
      true
    );
    instruction('Tone', ' Formal ');
    expect(button('Generate suggestion', dialog())).toHaveProperty(
      'disabled',
      false
    );
    await generate();
    expect(aiPosts()[0].body.instruction).toBe('Formal');
  });

  it('FI7-FI13 sends exactly the choices: item, connection, model, profile ids, policy flag, instruction', async () => {
    await renderWorkspace();
    await openItem('Follow-up 1');
    choose('AI connection', '45555555-5555-4555-8555-555555555555');
    await settle();
    choose('Model', 'claude-haiku-5-5');
    choose('Writing Profile', WRITING);
    choose('Audience Profile', AUDIENCE);
    choose('Expertise Profile', EXPERTISE);
    fireEvent.click(
      within(dialog()).getByRole('checkbox', { name: 'Use Editorial Policy' })
    );
    instruction('Additional instruction', '  Mention the sale \n');
    await generate();
    expect(aiPosts()[0].body).toEqual({
      operation: 'rewrite_item',
      itemId: 'f1',
      connectionId: '45555555-5555-4555-8555-555555555555',
      model: 'claude-haiku-5-5',
      writingProfileId: WRITING,
      editorialPolicy: true,
      audienceProfileId: AUDIENCE,
      expertiseProfileId: EXPERTISE,
      sourceIds: [],
      instruction: 'Mention the sale',
      baseDraftVersion: 4,
    });
  });

  it('sends null for every context left at None, and no instruction when blank', async () => {
    await renderWorkspace();
    await openItem();
    await generate();
    expect(aiPosts()[0].body).toEqual({
      operation: 'rewrite_item',
      itemId: 'main',
      connectionId: CONNECTION,
      model: 'gpt-6-luna',
      writingProfileId: null,
      editorialPolicy: false,
      audienceProfileId: null,
      expertiseProfileId: null,
      sourceIds: [],
      instruction: null,
      baseDraftVersion: 4,
    });
    expect(JSON.stringify(aiPosts()[0].body)).not.toMatch(
      /revision|provider|prompt|system|apiKey|credential|organization|user/i
    );
  });
});

describe('AI writing: thread', () => {
  it('FT1-FT4 asks for the whole thread, without an item', async () => {
    await renderWorkspace();
    await click('AI thread');
    expect(
      within(dialog()).queryByRole('combobox', { name: 'AI action' })
    ).toBeNull();
    choose('Writing Profile', WRITING);
    await generate();
    expect(aiPosts()).toHaveLength(1);
    expect(aiPosts()[0].url).toBe(`${BASE}/ai/thread`);
    expect(aiPosts()[0].body).toEqual({
      operation: 'generate_thread',
      connectionId: CONNECTION,
      model: 'gpt-6-luna',
      writingProfileId: WRITING,
      editorialPolicy: false,
      audienceProfileId: null,
      expertiseProfileId: null,
      sourceIds: [],
      instruction: null,
      baseDraftVersion: 4,
    });
  });

  it('FT5-FT7 shows Current and Suggestion per post in draft order, and saves nothing', async () => {
    await renderWorkspace();
    await click('AI thread');
    await generate();
    const root = review();
    expect(
      Array.from(root.querySelectorAll('[data-proposal-item]')).map((n) =>
        n.getAttribute('data-proposal-item')
      )
    ).toEqual(['main', 'f1', 'f2']);
    expect(panels(root, 'main')).toEqual(['Hello\nworld  ', 'Suggested main']);
    expect(panels(root, 'f1')).toEqual(['Second', 'Suggested f1']);
    expect(panels(root, 'f2')).toEqual(['Third', 'Suggested f2']);
    expect(within(root).getByText('Follow-up 2')).toBeTruthy();
    expect(puts()).toHaveLength(0);
    await advance(10_000);
    expect(puts()).toHaveLength(0);
  });

  it('PR8-PR12 Accept changes only the texts, in one save, keeping ids, order and media', async () => {
    await renderWorkspace();
    await click('AI thread');
    await generate();
    await click('Accept');
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body).toEqual({
      baseDraftVersion: 4,
      draft: draftOf(
        item('main', 'Suggested main', ['m1', 'm2']),
        item('f1', 'Suggested f1', ['m3', 'gone']),
        item('f2', 'Suggested f2')
      ),
    });
    expect(box('Post').value).toBe('Suggested main');
    expect(box('Follow-up 2').value).toBe('Suggested f2');
    expect(queryReview()).toBeNull();
    expect(status()).toBe('Saved');
    await advance(10_000);
    expect(puts()).toHaveLength(1);
  });

  it('refuses a thread answer that does not match the draft', async () => {
    ai.propose = (_kind, body) =>
      reply(200, {
        operationId: 'op',
        baseDraftVersion: body.baseDraftVersion,
        proposal: {
          type: 'thread',
          items: [
            { itemId: 'f1', text: 'b' },
            { itemId: 'main', text: 'a' },
            { itemId: 'f2', text: 'c' },
          ],
        },
      });
    await renderWorkspace();
    await click('AI thread');
    await generate();
    expect(queryReview()).toBeNull();
    expect(toasts()).toEqual(['Could not generate a suggestion.']);
  });
});

describe('AI writing: review', () => {
  const itemProposal = async () => {
    await renderWorkspace();
    await openItem();
    await generate();
  };

  it('PR1-PR3/M18 shows Current and Suggestion and saves nothing until Accept', async () => {
    await itemProposal();
    expect(queryDialog()).toBeNull();
    const root = review();
    expect(within(root).getByText('Current')).toBeTruthy();
    expect(within(root).getByText('Suggestion')).toBeTruthy();
    expect(panels(root, 'main')).toEqual(['Hello\nworld  ', 'Suggested main']);
    expect(box('Post').value).toBe('Hello\nworld  ');
    expect(status()).toBe('Saved');
    await advance(10_000);
    expect(puts()).toHaveLength(0);
    expect(button('Accept', root)).toHaveProperty('disabled', false);
  });

  it('PR4/PR5/M19 Discard closes the suggestion and writes nothing', async () => {
    await itemProposal();
    await click('Discard');
    expect(queryReview()).toBeNull();
    expect(box('Post').value).toBe('Hello\nworld  ');
    await advance(10_000);
    expect(puts()).toHaveLength(0);
    expect(
      calls()
        .filter((c) => c.method !== 'GET')
        .map((c) => c.url)
    ).toEqual([`${BASE}/ai/item`]);
  });

  it('PR6/PR7/PR13 Accept puts the text in the draft and saves it through the usual draft save, once', async () => {
    await itemProposal();
    await click('Accept');
    expect(box('Post').value).toBe('Suggested main');
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body).toEqual({
      baseDraftVersion: 4,
      draft: draftOf(
        item('main', 'Suggested main', ['m1', 'm2']),
        item('f1', 'Second', ['m3', 'gone']),
        item('f2', 'Third')
      ),
    });
    expect(
      calls()
        .filter((c) => c.method !== 'GET')
        .map((c) => `${c.method} ${c.url}`)
    ).toEqual([`POST ${BASE}/ai/item`, `PUT ${BASE}/draft`]);
    expect(queryReview()).toBeNull();
    expect(status()).toBe('Saved');
  });

  it('PS1/PS2 the suggestion belongs to the version it was made from and can be accepted while that is current', async () => {
    await itemProposal();
    expect(aiPosts()[0].body.baseDraftVersion).toBe(4);
    expect(within(review()).queryByRole('alert')).toBeNull();
    expect(button('Accept', review())).toHaveProperty('disabled', false);
  });

  it('PS3-PS7/M20 an edit makes the suggestion stale: Accept off, Discard on, nothing merged', async () => {
    await itemProposal();
    type('Follow-up 1', 'Edited after');
    const root = review();
    expect(within(root).getByRole('alert').textContent).toBe(
      'This suggestion was generated from an older draft. Generate a new suggestion before applying it.'
    );
    expect(button('Accept', root)).toHaveProperty('disabled', true);
    fireEvent.click(button('Accept', root));
    await settle();
    // the edit saves as usual; the suggestion stays out of it
    await advance(1500);
    expect(putTexts()).toEqual([['Hello\nworld  |Edited after|Third', 4]]);
    expect(button('Accept', review())).toHaveProperty('disabled', true);
    expect(box('Post').value).toBe('Hello\nworld  ');
    await click('Discard');
    expect(queryReview()).toBeNull();
    expect(puts()).toHaveLength(1);
  });

  it('PS7 an edit undone before saving still needs a new suggestion once the version moved', async () => {
    await itemProposal();
    type('Post', 'Changed');
    await advance(1500);
    type('Post', 'Hello\nworld  ');
    await advance(1500);
    expect(puts()).toHaveLength(2);
    expect(button('Accept', review())).toHaveProperty('disabled', true);
  });

  it('a new suggestion replaces the one under review', async () => {
    await itemProposal();
    await openItem('Follow-up 2');
    await generate();
    expect(
      screen.getAllByRole('region', { name: 'AI suggestion' })
    ).toHaveLength(1);
    expect(panels(review(), 'f2')).toEqual(['Third', 'Suggested f2']);
  });

  it('refuses an answer for another version or another item', async () => {
    ai.propose = (_kind, body) =>
      reply(200, {
        operationId: 'op',
        baseDraftVersion: body.baseDraftVersion + 1,
        proposal: { type: 'item', itemId: body.itemId, text: 'x' },
      });
    await renderWorkspace();
    await openItem();
    await generate();
    expect(queryReview()).toBeNull();
    ai.propose = (_kind, body) =>
      reply(200, {
        operationId: 'op',
        baseDraftVersion: body.baseDraftVersion,
        proposal: { type: 'item', itemId: 'nope', text: 'x' },
      });
    await generate();
    expect(queryReview()).toBeNull();
    expect(toasts()).toEqual([
      'Could not generate a suggestion.',
      'Could not generate a suggestion.',
    ]);
  });
});

describe('AI writing: errors', () => {
  it.each([
    [
      'FE1',
      'CS_AI_CONNECTION_REQUIRED',
      'Connect an AI provider before using AI writing.',
    ],
    ['FE2', 'CS_AI_CONNECTION_DISABLED', 'This AI connection is disabled.'],
    [
      'FE3',
      'CS_AI_CONNECTION_CREDENTIAL_INVALID',
      'This AI connection needs a new API key.',
    ],
    [
      'FE4',
      'CS_AI_MODEL_UNSUPPORTED',
      'This model is not available for the selected connection.',
    ],
    [
      'FE5',
      'CS_AI_CONTEXT_NOT_FOUND',
      'A selected AI context profile is no longer available.',
    ],
    [
      'FE6',
      'CS_AI_CONTEXT_ARCHIVED',
      'A selected AI context profile is archived.',
    ],
    [
      'FE7',
      'CS_AI_CONTEXT_INTEGRITY_ERROR',
      'Selected AI context could not be verified.',
    ],
    ['FE8', 'CS_AI_CONTEXT_TOO_LARGE', 'The selected AI context is too large.'],
    ['', 'CS_AI_SOURCE_NOT_FOUND', 'A selected source is no longer available.'],
    [
      '',
      'CS_AI_SOURCE_NOT_READY',
      'A selected source has not been ingested yet.',
    ],
    ['', 'CS_AI_SOURCE_ARCHIVED', 'A selected source is archived.'],
    [
      '',
      'CS_AI_SOURCE_CONTEXT_TOO_LARGE',
      'The selected source context is too large.',
    ],
    [
      '',
      'CS_AI_SOURCE_INTEGRITY_ERROR',
      'Selected source context could not be verified.',
    ],
    [
      'FE9',
      'CS_DRAFT_VERSION_CONFLICT',
      'The draft changed before AI generation started. Reload and try again.',
    ],
    [
      'FE10',
      'CS_AI_AUTH_FAILED',
      'Authentication failed. Replace the API key and try again.',
    ],
    [
      'FE11',
      'CS_AI_RATE_LIMITED',
      'The provider is rate limiting this connection. Try again later.',
    ],
    [
      'FE12',
      'CS_AI_QUOTA_EXCEEDED',
      'The provider reports that the account has no available quota or credits.',
    ],
    ['FE13', 'CS_AI_TIMEOUT', 'The provider did not respond in time.'],
    [
      'FE14',
      'CS_AI_CONTENT_REJECTED',
      'The provider rejected the request content.',
    ],
    [
      'FE15',
      'CS_AI_INVALID_RESPONSE',
      'The provider returned an unusable suggestion. Try again.',
    ],
    [
      '',
      'CS_AI_PROVIDER_UNAVAILABLE',
      'The provider is temporarily unavailable.',
    ],
    ['', 'CS_AI_MODEL_UNAVAILABLE', 'The provider could not use this model.'],
    ['', 'CS_AI_REQUEST_REJECTED', 'The provider rejected the request.'],
    ['', 'CS_AI_OPERATION_FAILED', 'Could not generate a suggestion.'],
    [
      '',
      'CS_INVALID_REQUEST',
      'This AI action cannot be used here. Check the post and the choices and try again.',
    ],
    ['', 'SOMETHING_NEW', 'Could not generate a suggestion.'],
  ])(
    '%s %s shows a fixed message, never the server text (FE16)',
    async (_n, code, message) => {
      ai.propose = () =>
        reply(code === 'CS_AI_RATE_LIMITED' ? 429 : 400, {
          code,
          msg: `provider said ${MARKER} ${KEY}`,
        });
      await renderWorkspace();
      await openItem();
      await generate();
      expect(toasts()).toEqual([message]);
      expect(document.body.textContent).not.toContain(MARKER);
      expect(queryReview()).toBeNull();
      expect(queryDialog()).not.toBeNull();
      expect(puts()).toHaveLength(0);
    }
  );

  it('FE9 a draft conflict stops saving until the package is reloaded', async () => {
    ai.propose = () =>
      reply(409, { code: 'CS_DRAFT_VERSION_CONFLICT', msg: 'x' });
    await renderWorkspace();
    await openItem();
    await generate();
    expect(status()).toBe('Conflict');
    expect(button('AI writing Post')).toHaveProperty('disabled', true);
  });

  it('an archived package is explained like the other workspace actions', async () => {
    ai.propose = () => reply(409, { code: 'CS_PACKAGE_ARCHIVED', msg: MARKER });
    await renderWorkspace();
    await openItem();
    await generate();
    expect(toasts()[0]).toBe('This package is archived.');
  });

  it('shows a load error, never a generation, when the connections cannot be read', async () => {
    override = (m, url) =>
      m === 'GET' && url === '/content-studio/ai/connections'
        ? reply(500, { code: 'X', msg: MARKER })
        : undefined;
    await renderWorkspace();
    const root = await openItem();
    expect(
      within(root).getByText('Could not load Content Studio.')
    ).toBeTruthy();
    expect(
      within(root).queryByRole('button', { name: 'Generate suggestion' })
    ).toBeNull();
  });
});

describe('AI writing: privacy', () => {
  it('FP1-FP5 the instruction goes to the one request only: no storage, URL, console or toast; no key field', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem');
    const consoleCalls = ['log', 'info', 'warn', 'error', 'debug'].map((name) =>
      jest.spyOn(console, name as 'log').mockImplementation(() => undefined)
    );
    try {
      ai.propose = () =>
        reply(429, { code: 'CS_AI_RATE_LIMITED', msg: MARKER });
      await renderWorkspace();
      await openItem();
      instruction('Additional instruction', `Use ${MARKER}`);
      expect(dialog().querySelectorAll('input[type="password"]')).toHaveLength(
        0
      );
      expect(
        within(dialog()).queryByRole('textbox', { name: /key/i })
      ).toBeNull();
      await generate();
      expect(aiPosts()[0].body.instruction).toBe(`Use ${MARKER}`);
      expect(setItem).not.toHaveBeenCalled();
      for (const spy of consoleCalls) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(MARKER);
      }
      expect(JSON.stringify(toasts())).not.toContain(MARKER);
      expect(JSON.stringify(mockRouter.push.mock.calls)).not.toContain(MARKER);
      expect(JSON.stringify(mockRouter.replace.mock.calls)).not.toContain(
        MARKER
      );
      expect(
        calls().filter(
          (c) => c.url.includes(MARKER) || c.url.includes('instruction')
        )
      ).toEqual([]);
      for (const c of calls()) {
        expect(JSON.stringify(c.body ?? {})).not.toMatch(
          /apiKey|credential|sk-/
        );
      }
    } finally {
      setItem.mockRestore();
      consoleCalls.forEach((spy) => spy.mockRestore());
    }
  });

  it('FP7 keeps the suggestion out of the SWR cache', async () => {
    const cache = new Map();
    await renderWorkspace(cache);
    await openItem();
    await generate();
    expect(JSON.stringify(Array.from(cache.keys()))).not.toMatch(
      /\/ai\/(item|thread)/
    );
    expect(
      JSON.stringify(
        Array.from(cache.values(), (entry: any) => entry?.data ?? null)
      )
    ).not.toContain('Suggested main');
  });

  it('the instruction is gone when the dialog closes', async () => {
    await renderWorkspace();
    await openItem();
    instruction('Additional instruction', MARKER);
    await click('Cancel', dialog());
    expect(document.body.textContent).not.toContain(MARKER);
    await openItem();
    expect(
      (
        within(dialog()).getByRole('textbox', {
          name: 'Additional instruction',
        }) as HTMLTextAreaElement
      ).value
    ).toBe('');
  });
});

// --- sources ---
const SOURCES_LIST = '/content-studio/sources?page=1&archived=false';
const sourceBox = (name: string) =>
  within(dialog()).getByRole('checkbox', { name }) as HTMLInputElement;
const sourceBoxes = () =>
  within(
    within(dialog()).getByRole('group', { name: 'Sources' })
  ).queryAllByRole('checkbox') as HTMLInputElement[];
const sourceNames = () =>
  sourceBoxes().map((box) => box.closest('label')!.textContent);
const tick = async (name: string) => {
  fireEvent.click(sourceBox(name));
  await settle();
};
const sourceGets = () =>
  calls().filter(
    (c) => c.method === 'GET' && c.url.startsWith('/content-studio/sources')
  );

describe('AI writing: sources', () => {
  it('UI-S1/UI-S5 offers Sources in the dialog, explained, with none chosen', async () => {
    await renderWorkspace();
    const root = await openItem();
    expect(within(root).getByRole('group', { name: 'Sources' })).toBeTruthy();
    expect(
      within(root).getByText(
        'Use selected source material as reference context. Sources are not automatically fact-checked. Up to 5, used in the order you select them.'
      )
    ).toBeTruthy();
    expect(sourceBoxes().length).toBeGreaterThan(0);
    expect(sourceBoxes().filter((box) => box.checked)).toEqual([]);
    expect(root.textContent).not.toMatch(/#\d/);
  });

  it('UI-S2 loads the active source list once, only when a dialog opens', async () => {
    await renderWorkspace();
    expect(sourceGets()).toEqual([]);
    await openItem();
    expect(sourceGets().map((c) => c.url)).toEqual([SOURCES_LIST]);
  });

  it('UI-S3/UI-S4 lists active sources with a captured version only, by name', async () => {
    // an archived row in the active list is left out as well
    ai.sources.push(
      sourceRow(9, 'Archived but listed', 1, '2026-10-03T10:00:00.000Z')
    );
    override = (m, url) =>
      m === 'GET' && url === SOURCES_LIST
        ? reply(200, { pages: 1, results: ai.sources })
        : undefined;
    await renderWorkspace();
    await openItem();
    expect(sourceNames()).toEqual([
      'Weekly news',
      'Market report',
      'Blog D',
      'Blog E',
      'Blog F',
      'Blog G',
    ]);
    expect(dialog().textContent).not.toMatch(
      /Not captured yet|Old source|Archived but listed|example\.com|URL_PRIVATE/
    );
  });

  it('UI-S6/UI-S10/UI-S11 one source: the request names its id only, no version, hash or text', async () => {
    await renderWorkspace();
    await openItem();
    await tick('Weekly news');
    expect(sourceBox('Weekly news').checked).toBe(true);
    await generate();
    const body = aiPosts()[0].body;
    expect(body.sourceIds).toEqual([SOURCE(1)]);
    expect(Object.keys(body).sort()).toEqual(
      [
        'operation',
        'itemId',
        'connectionId',
        'model',
        'writingProfileId',
        'editorialPolicy',
        'audienceProfileId',
        'expertiseProfileId',
        'sourceIds',
        'instruction',
        'baseDraftVersion',
      ].sort()
    );
    expect(JSON.stringify(body)).not.toMatch(
      /version(Id|Number)|contentHash|sourceVersion|sources"|content|blocks|title|https?:|222222/
    );
  });

  it('UI-S7 five sources go in the order they were ticked, numbered in the list', async () => {
    await renderWorkspace();
    await click('AI thread');
    for (const name of [
      'Blog F',
      'Weekly news',
      'Blog D',
      'Market report',
      'Blog G',
    ]) {
      await tick(name);
    }
    expect(dialog().textContent).toContain('Blog F#1');
    expect(dialog().textContent).toContain('Blog G#5');
    await generate();
    expect(aiPosts()[0].body.sourceIds).toEqual([
      SOURCE(7),
      SOURCE(1),
      SOURCE(5),
      SOURCE(2),
      SOURCE(8),
    ]);
  });

  it('UI-S8 takes five at most: the others are turned off until one is removed', async () => {
    await renderWorkspace();
    await openItem();
    for (const name of [
      'Weekly news',
      'Market report',
      'Blog D',
      'Blog E',
      'Blog F',
    ]) {
      await tick(name);
    }
    expect(sourceBox('Blog G').disabled).toBe(true);
    expect(dialog().textContent).not.toContain('#6');
    // a browser sends no click to a disabled box; even one that arrives
    // adds nothing
    fireEvent.click(sourceBox('Blog G'));
    await settle();
    expect(dialog().textContent).not.toContain('#6');
    await generate();
    expect(aiPosts()[0].body.sourceIds).toEqual([1, 2, 5, 6, 7].map(SOURCE));
  });

  it('UI-S9 a ticked source can be removed; the rest keep their order', async () => {
    await renderWorkspace();
    await openItem();
    for (const name of ['Blog D', 'Weekly news', 'Blog E']) {
      await tick(name);
    }
    await tick('Weekly news');
    expect(sourceBox('Weekly news').checked).toBe(false);
    for (const name of ['Weekly news', 'Market report', 'Blog F', 'Blog G']) {
      expect(sourceBox(name).disabled).toBe(false);
    }
    await generate();
    expect(aiPosts()[0].body.sourceIds).toEqual([SOURCE(5), SOURCE(6)]);
  });

  it('UI-S12/UI-S13 never loads a source, its versions or their content', async () => {
    await renderWorkspace();
    await openItem();
    await tick('Weekly news');
    await tick('Market report');
    await generate();
    expect(sourceGets().map((c) => c.url)).toEqual([SOURCES_LIST]);
    expect(
      calls().filter((c) => /\/content-studio\/sources\//.test(c.url))
    ).toEqual([]);
  });

  it('UI-S14 keeps no selection: nothing stored, and a new dialog starts empty', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem');
    try {
      await renderWorkspace();
      await openItem();
      await tick('Weekly news');
      await click('Cancel', dialog());
      await openItem();
      expect(sourceBoxes().filter((box) => box.checked)).toEqual([]);
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });

  it('a source list that cannot be loaded leaves AI writing usable without sources', async () => {
    override = (m, url) =>
      m === 'GET' && url === SOURCES_LIST
        ? reply(500, { code: 'X', msg: MARKER })
        : undefined;
    await renderWorkspace();
    const root = await openItem();
    expect(
      within(root).getByText(
        'Sources could not be loaded. You can still generate without them.'
      )
    ).toBeTruthy();
    expect(root.textContent).not.toContain(MARKER);
    await generate();
    expect(aiPosts()[0].body.sourceIds).toEqual([]);
    expect(queryReview()).not.toBeNull();
  });

  it('says so when no source has been captured yet', async () => {
    ai.sources = [sourceRow(3, 'Not captured yet', 0)];
    await renderWorkspace();
    await openItem();
    expect(within(dialog()).getByText('No ingested sources yet.')).toBeTruthy();
    expect(sourceBoxes()).toEqual([]);
  });
});

describe('AI writing: source provenance', () => {
  const sourced = async (...names: string[]) => {
    await renderWorkspace();
    await openItem();
    for (const name of names) {
      await tick(name);
    }
    await generate();
    return review();
  };
  const SOURCE_WORDS = /Based on selected sources|Source-backed/;

  it('UI-P1 a suggestion without sources shows no source part', async () => {
    const root = await sourced();
    expect(root.textContent).not.toMatch(SOURCE_WORDS);
    expect(root.textContent).not.toMatch(/Version \d/);
  });

  it('UI-P2-UI-P5 names the sources it was written from: name, title when there is one, and the version', async () => {
    const root = await sourced('Market report', 'Weekly news');
    expect(within(root).getByText('Based on selected sources')).toBeTruthy();
    expect(
      Array.from(root.querySelectorAll('li')).map((li) => li.textContent)
    ).toEqual([
      'Market report · Version 1',
      'Weekly news · Title of Weekly news · Version 3',
    ]);
  });

  it('UI-P6-UI-P10 shows no hash, id or URL, and never calls the sources verified', async () => {
    const root = await sourced('Weekly news', 'Market report');
    const text = root.textContent as string;
    expect(text).not.toMatch(/[0-9a-f]{64}|1111111111|2222222222/);
    expect(text).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/
    );
    expect(text).not.toMatch(/https?:|example\.com|URL_PRIVATE/);
    expect(text).not.toMatch(/verified|fact[- ]?checked|trusted|accurate/i);
    expect(root.innerHTML).not.toMatch(/f1111111|01222222|[0-9a-f]{64}/);
  });

  it('a thread suggestion names its sources the same way', async () => {
    await renderWorkspace();
    await click('AI thread');
    await tick('Blog G');
    await generate();
    expect(
      Array.from(review().querySelectorAll('li')).map((li) => li.textContent)
    ).toEqual(['Blog G · Title of Blog G · Version 2']);
  });

  it('ST-S1/ST-S2/ST-S5 a refresh or archive of a source after the suggestion changes nothing: it stays current and Accept saves it', async () => {
    await sourced('Weekly news');
    ai.sources[0] = sourceRow(
      1,
      'Weekly news renamed',
      4,
      '2026-10-12T10:00:00.000Z'
    );
    await act(async () => {
      await swrMutate(SOURCES_LIST);
    });
    await settle();
    const root = review();
    expect(within(root).queryByRole('alert')).toBeNull();
    expect(
      Array.from(root.querySelectorAll('li')).map((li) => li.textContent)
    ).toEqual(['Weekly news · Title of Weekly news · Version 3']);
    expect(button('Accept', root)).toHaveProperty('disabled', false);
    await click('Accept');
    expect(box('Post').value).toBe('Suggested main');
    expect(
      calls()
        .filter((c) => c.method !== 'GET')
        .map((c) => `${c.method} ${c.url}`)
    ).toEqual([`POST ${BASE}/ai/item`, `PUT ${BASE}/draft`]);
  });

  it('ST-S3 an edit still makes a source-backed suggestion stale', async () => {
    await sourced('Weekly news');
    type('Post', 'Edited after');
    expect(within(review()).getByRole('alert')).toBeTruthy();
    expect(button('Accept', review())).toHaveProperty('disabled', true);
  });

  it('ST-S4 staleness looks at the draft only: the same sources or other ones make no difference', () => {
    const {
      isContentStudioAIProposalCurrent,
    } = require('./content-studio.ai-proposal');
    const draft = draftOf(item('main', 'a'), item('f1', 'b'));
    const proposal = (sources: unknown[]) => ({
      operationId: 'op',
      baseDraftVersion: 4,
      proposal: {
        type: 'thread',
        items: [
          { itemId: 'main', text: 'x' },
          { itemId: 'f1', text: 'y' },
        ],
      },
      provenance: { sources },
    });
    const one = [capture(SOURCE(1))];
    for (const sources of [[], one, [{ ...one[0], versionNumber: 9 }]]) {
      expect(
        isContentStudioAIProposalCurrent(proposal(sources), draft, 4, true)
      ).toBe(true);
      expect(
        isContentStudioAIProposalCurrent(proposal(sources), draft, 5, true)
      ).toBe(false);
      expect(
        isContentStudioAIProposalCurrent(
          proposal(sources),
          draftOf(item('f1', 'b'), item('main', 'a')),
          4,
          true
        )
      ).toBe(false);
      expect(
        isContentStudioAIProposalCurrent(
          proposal(sources),
          draftOf(item('main', 'a'), item('f1', 'b'), item('f2', 'c')),
          4,
          true
        )
      ).toBe(false);
    }
  });
});

describe('AI writing: source surface', () => {
  const files = [
    'content-studio.ai-writing.tsx',
    'content-studio.ai-proposal.tsx',
  ];
  // code only: the comments explain these rules and may name them
  const code = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const sources = files.map(
    (file) => [file, code(readFileSync(join(__dirname, file), 'utf8'))] as const
  );
  const workspace = code(
    readFileSync(join(__dirname, 'content-studio.workspace.tsx'), 'utf8')
  );
  const all = [...sources.map(([, text]) => text), workspace].join('\n');

  it('FW3/M23 has no role or admin gate, no billing, credits or usage', () => {
    expect(all).not.toMatch(/useUser|\.role\b|ADMIN|useCanManageAIConnections/);
    expect(all).not.toMatch(
      /billing|subscription|wallet|\bprice|\bcost\b|tokens?\b|usage|buyCredits|creditsRemaining|useCredits/i
    );
  });

  it('FP1/FP4/FP5 stores nothing in the browser and never handles a key', () => {
    expect(all).not.toMatch(
      /localStorage|sessionStorage|indexedDB|document\.cookie|console\.|sendBeacon|posthog|useTrack/
    );
    // a connection is only usable with a stored key; the key itself never appears
    expect(all).not.toMatch(/apiKey|sealed|password|credential:/i);
    expect(all).not.toMatch(/router\.(push|replace)\([^)]*instruction/);
  });

  it('PR13 calls only the two proposal routes besides the draft save: no apply route, no provider', () => {
    const text = sources.map(([, t]) => t).join('\n');
    expect(text).not.toMatch(
      /from 'openai'|@anthropic-ai|@ai-sdk|process\.env/
    );
    expect(text).not.toMatch(/'PUT'|'PATCH'|'DELETE'|useSWR\(|mutate\(/);
    expect(
      Array.from(text.matchAll(/method: '([A-Z]+)'/g)).map((m) => m[1])
    ).toEqual(['POST']);
    expect(text).toContain("/ai/${itemId ? 'item' : 'thread'}");
    expect(all).not.toMatch(/\/apply|\/accept|ai\/generate|\/operations/);
  });

  it('M13/M28 never calls sources verified, fact checked or trusted', () => {
    const text = sources.map(([, t]) => t).join('\n');
    expect(text).not.toMatch(
      /verified sources?|sources? verified|source-backed|trusted|accurate|guaranteed/i
    );
    // the one mention: sources are not automatically fact-checked
    expect(text.match(/fact[- ]?checked/gi)).toEqual(['fact-checked']);
    expect(text).toContain('Sources are not automatically fact-checked.');
  });

  it('UI-S12 the source list is the one source request: names only, no version or content route, no write', () => {
    // the shared Source API also serves the Source Library; the dialog takes
    // only its list hook, and that hook loads only the list path
    const api = code(
      readFileSync(join(__dirname, 'content-studio.sources.api.ts'), 'utf8')
    );
    const listHook = api.slice(
      api.indexOf('export const useContentStudioSources ='),
      api.indexOf('export const useContentStudioSource =')
    );
    // P8-02: one kind when named (News Radar's feed choice); the dialog
    // names none, so it lists every kind as before
    expect(listHook).toContain(
      'useSWR(sourcesListPath(archived, page, kind), load, swrOptions)'
    );
    expect(listHook).not.toMatch(/method:|mutate|\/versions|\/refresh/);
    expect(api).not.toMatch(/localStorage|sessionStorage|console\./);
    for (const [, text] of sources) {
      const imports = Array.from(
        text.matchAll(
          /import \{([^}]*)\} from '[^']*content-studio\.sources\.api'/g
        )
      ).flatMap((m) =>
        m[1]
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean)
      );
      for (const name of imports) {
        expect([
          'useContentStudioSources',
          'ContentStudioSourceSummary',
        ]).toContain(name);
      }
    }
    expect(all).not.toMatch(
      /\/versions|\/refresh|useContentStudioSource\b|useContentStudioSourceVersions?\b|useContentStudioSourceActions|captureSource|sourcePath\(/
    );
    const dialogCode = sources.find(
      ([file]) => file === 'content-studio.ai-writing.tsx'
    )![1];
    expect(dialogCode).toContain('useContentStudioSources(false, 1)');
    // the request names sources by id only
    const requestType = dialogCode.slice(
      dialogCode.indexOf('export interface ContentStudioAIWritingRequest'),
      dialogCode.indexOf(
        '}',
        dialogCode.indexOf('export interface ContentStudioAIWritingRequest')
      )
    );
    expect(requestType).toContain('sourceIds: string[];');
    expect(requestType).not.toMatch(
      /[vV]ersion|[hH]ash|sourceContent|blocks|[tT]itle|[uU]rl/
    );
    expect(all).not.toMatch(/sourceVersionId/);
  });

  it('builds no prompt in the browser and fetches no profile content', () => {
    expect(all).not.toMatch(
      /useContentStudioProfile\b|useContentStudioEditorialPolicy\b|system:|prompt:/
    );
  });
});

// P3-11: a suggestion made with sources can carry grounded claims. They are
// shown with the suggestion and enter the draft only on Accept, in place of
// the claims of the posts it changes
describe('AI writing: grounded claims (P3-11)', () => {
  const evidence = (blockId: string) => ({
    sourceId: SOURCE(1),
    versionId: '01222222-2222-4222-8222-222222222222',
    versionNumber: 3,
    contentHash: '1'.repeat(64),
    blockId,
    quote: null,
  });
  const claim = (id: string, threadItemId: string, text: string) => ({
    id,
    threadItemId,
    text,
    evidence: [evidence('b1')],
  });
  const proposeWith = (claims: ReturnType<typeof claim>[]) => {
    ai.propose = (kind, body) => {
      const base = proposeAnswer(kind, body);
      return {
        ...base,
        json: async () => ({
          ...((await base.json()) as object),
          grounding: { claims },
        }),
      };
    };
  };
  const putDraft = (index = 0) => puts()[index].body.draft;

  it('FG6/AP1 accepting a grounded suggestion saves its claims in a v2 draft, once', async () => {
    proposeWith([claim('c_aaaaaaaaaaaaaaaa', 'main', 'Sales grew.')]);
    await renderWorkspace();
    await openItem();
    await generate();
    const root = review();
    expect(within(root).getByText('Grounded claims')).toBeTruthy();
    expect(
      root.querySelector('[data-proposal-claim="c_aaaaaaaaaaaaaaaa"]')
        ?.textContent
    ).toContain('Sales grew.');
    expect(puts()).toHaveLength(0);
    await click('Accept');
    expect(puts()).toHaveLength(1);
    expect(putDraft()).toEqual({
      schemaVersion: 2,
      copy: draftOf(
        item('main', 'Suggested main', ['m1', 'm2']),
        item('f1', 'Second', ['m3', 'gone']),
        item('f2', 'Third')
      ).copy,
      grounding: {
        claims: [claim('c_aaaaaaaaaaaaaaaa', 'main', 'Sales grew.')],
      },
    });
    // the workspace shows the claim it saved
    const grounding = screen.getByRole('region', { name: 'Grounding' });
    expect(within(grounding).getByText('Sales grew.')).toBeTruthy();
  });

  it('FG7/AP2 a grounded suggestion that is discarded writes nothing', async () => {
    proposeWith([claim('c_aaaaaaaaaaaaaaaa', 'main', 'Sales grew.')]);
    await renderWorkspace();
    await openItem();
    await generate();
    await click('Discard');
    await advance(10_000);
    expect(puts()).toHaveLength(0);
    expect(
      screen
        .getByRole('region', { name: 'Grounding' })
        .querySelector('[data-claim-count]')
        ?.getAttribute('data-claim-count')
    ).toBe('0');
  });

  it("AP3/AP4 a suggestion for one post replaces only that post's claims", async () => {
    server.draft = {
      schemaVersion: 2,
      copy: server.draft.copy,
      grounding: {
        claims: [
          claim('c_main000000000001', 'main', 'Old main claim.'),
          claim('c_f10000000000001', 'f1', 'Follow-up claim.'),
        ],
      },
    } as never;
    proposeWith([claim('c_main000000000002', 'main', 'New main claim.')]);
    await renderWorkspace();
    await openItem();
    await generate();
    expect(
      within(review()).getByText(
        'Accepting replaces the grounded claims of the posts it changes.'
      )
    ).toBeTruthy();
    await click('Accept');
    expect(
      putDraft().grounding.claims.map((entry: { id: string }) => entry.id)
    ).toEqual(['c_f10000000000001', 'c_main000000000002']);
  });

  it("AP7 an ungrounded suggestion for a grounded post removes that post's claims", async () => {
    server.draft = {
      schemaVersion: 2,
      copy: server.draft.copy,
      grounding: {
        claims: [
          claim('c_main000000000001', 'main', 'Old main claim.'),
          claim('c_f10000000000001', 'f1', 'Follow-up claim.'),
        ],
      },
    } as never;
    await renderWorkspace();
    await openItem();
    await generate();
    await click('Accept');
    expect(putDraft().schemaVersion).toBe(2);
    expect(
      putDraft().grounding.claims.map((entry: { id: string }) => entry.id)
    ).toEqual(['c_f10000000000001']);
  });

  it('an ungrounded suggestion on a v1 draft still saves a v1 draft', async () => {
    await renderWorkspace();
    await openItem();
    await generate();
    await click('Accept');
    expect(putDraft().schemaVersion).toBe(1);
    expect(putDraft().grounding).toBeUndefined();
  });

  it('a claim the suggestion names for another post is never taken', async () => {
    proposeWith([
      claim('c_aaaaaaaaaaaaaaaa', 'main', 'Main claim.'),
      claim('c_bbbbbbbbbbbbbbbb', 'f2', 'Not this post.'),
    ]);
    await renderWorkspace();
    await openItem();
    await generate();
    await click('Accept');
    expect(
      putDraft().grounding.claims.map((entry: { id: string }) => entry.id)
    ).toEqual(['c_aaaaaaaaaaaaaaaa']);
  });

  it('a thread suggestion replaces the claims of every post', async () => {
    server.draft = {
      schemaVersion: 2,
      copy: server.draft.copy,
      grounding: {
        claims: [claim('c_f10000000000001', 'f1', 'Follow-up claim.')],
      },
    } as never;
    proposeWith([claim('c_f20000000000001', 'f2', 'Third claim.')]);
    await renderWorkspace();
    await click('AI thread');
    await generate();
    await click('Accept');
    expect(
      putDraft().grounding.claims.map((entry: { id: string }) => entry.id)
    ).toEqual(['c_f20000000000001']);
  });

  it('a suggestion refused for its grounding has its own fixed message', async () => {
    ai.propose = () =>
      reply(502, {
        msg: 'server text PRIVATE',
        code: 'CS_AI_GROUNDING_INVALID',
      });
    await renderWorkspace();
    await openItem();
    await generate();
    expect(toasts()).toContain(
      'The AI suggestion cited source material that does not match the selected sources. Try again.'
    );
    expect(toasts().join('\n')).not.toContain('PRIVATE');
    expect(puts()).toHaveLength(0);
  });
});
