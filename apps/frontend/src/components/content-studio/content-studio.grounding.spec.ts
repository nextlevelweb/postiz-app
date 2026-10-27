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

// P3-11 grounding in the package workspace and the revision history. Same
// conventions as the other frontend specs: a .spec.ts without JSX,
// components required (not imported), real SWR with a fresh cache per test.
// The server below is the workspace spec's, with the Source Library's reads

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
const { createThreadItemId } = require('./content-studio.thread.editor');

// --- the server ---
const PKG = 'pkg-1';
const BASE = `/content-studio/packages/${PKG}`;
const HANDOFF = 'a'.repeat(64);
type Item = { id: string; text: string; mediaIds: string[] };
type Draft = {
  schemaVersion: number;
  copy: { global: { thread: Item[] } };
  grounding?: { claims: Claim[] };
};
const draftOf = (...items: Item[]): Draft => ({
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
  content: Draft;
}
let server: {
  name: string;
  draft: Draft;
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
            schemaVersion: revision.content.schemaVersion,
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

// --- the Source Library, as stored captures only ---
type Claim = {
  id: string;
  threadItemId: string;
  text: string;
  evidence: Evidence[];
};
type Evidence = {
  sourceId: string;
  versionId: string;
  versionNumber: number;
  contentHash: string;
  blockId: string;
  quote: string | null;
};
const SOURCE_ID = 'f1111111-1111-4111-8111-111111111111';
const V1 = 'f1222222-2222-4222-8222-000000000001';
const V2 = 'f1222222-2222-4222-8222-000000000002';
const HASH = { [V1]: '1'.repeat(64), [V2]: '2'.repeat(64) } as Record<
  string,
  string
>;
const versionDetail = (id: string) => {
  const n = id === V1 ? 1 : 2;
  return {
    id,
    versionNumber: n,
    schemaVersion: 1,
    extractionVersion: 'content-studio-source-v2',
    requestedUrl: 'https://example.com/report?token=URL_PRIVATE',
    finalUrl: 'https://example.com/report?token=URL_PRIVATE',
    redirectCount: 0,
    fetchedAt: '2026-10-10T10:00:00.000Z',
    httpStatus: 200,
    contentType: 'text/html',
    contentLength: 100,
    title: `Report v${n}`,
    contentHash: HASH[id],
    sourceHash: null,
    createdAt: '2026-10-10T10:00:00.000Z',
    content: {
      schemaVersion: 1,
      blocks: [
        {
          id: 'b1',
          type: 'paragraph',
          text: `Sales grew by ten percent in v${n}.`,
          level: null,
        },
        { id: 'b2', type: 'heading', text: `Outlook v${n}`, level: 2 },
      ],
    },
  };
};
const sourceSummary = (
  id: string,
  name: string,
  latestVersionNumber: number
) => ({
  id,
  kind: 'url',
  name,
  canonicalUrl: 'https://example.com/report?token=URL_PRIVATE',
  latestVersionNumber,
  archivedAt: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
});
let listed: ReturnType<typeof sourceSummary>[] = [];
const sourceRoutes = (method: string, url: string): Reply | undefined => {
  const path = url.split('?')[0];
  if (method !== 'GET') {
    return undefined;
  }
  // the Source picker's list (P8-03): searched by the server, 20 a page
  if (path === '/content-studio/sources') {
    const query = new URLSearchParams(url.split('?')[1]);
    const search = (query.get('search') || '').toLowerCase();
    const page = Number(query.get('page') || 1);
    const matching = listed.filter(
      (source) => !search || source.name.toLowerCase().includes(search)
    );
    return reply(200, {
      pages: Math.ceil(matching.length / 20),
      results: matching.slice((page - 1) * 20, page * 20),
    });
  }
  if (path === `/content-studio/sources/${SOURCE_ID}`) {
    // its current capture is version 2: evidence of version 1 must never
    // show it
    const { content: _content, ...current } = versionDetail(V2);
    return reply(200, {
      ...sourceSummary(SOURCE_ID, 'Weekly report', 2),
      currentVersion: current,
    });
  }
  if (path === `/content-studio/sources/${SOURCE_ID}/versions`) {
    return reply(200, {
      pages: 1,
      results: [V2, V1].map((id) => {
        const { content: _content, ...summary } = versionDetail(id);
        return summary;
      }),
    });
  }
  const version = path.match(
    /^\/content-studio\/sources\/[^/]+\/versions\/([^/]+)$/
  );
  if (version && HASH[version[1]]) {
    return reply(200, versionDetail(version[1]));
  }
  return undefined;
};
beforeEach(() => {
  listed = [
    sourceSummary(SOURCE_ID, 'Weekly report', 2),
    sourceSummary('f2111111-1111-4111-8111-111111111111', 'Never captured', 0),
  ];
  override = (method, url) => sourceRoutes(method, url);
});

const evidenceOf = (
  versionId: string,
  blockId = 'b1',
  quote: string | null = null
): Evidence => ({
  sourceId: SOURCE_ID,
  versionId,
  versionNumber: versionId === V1 ? 1 : 2,
  contentHash: HASH[versionId],
  blockId,
  quote,
});
const claimOf = (
  id: string,
  threadItemId: string,
  text: string,
  evidence = [evidenceOf(V1)]
): Claim => ({
  id,
  threadItemId,
  text,
  evidence,
});
const grounded = (claims: Claim[]): Draft => ({
  schemaVersion: 2,
  copy: server.draft.copy,
  grounding: { claims },
});
const region = () => screen.getByRole('region', { name: 'Grounding' });
const claimCard = (id: string) =>
  region().querySelector(`[data-claim-id="${id}"]`) as HTMLElement;
const sourceReads = () =>
  calls().filter((c) => c.url.startsWith('/content-studio/sources'));
const lastPut = () => puts()[puts().length - 1].body.draft;

describe('grounding: inspection (P3-11)', () => {
  it('FG2 a v2 draft shows its claims, grouped by post, with their count and evidence count', async () => {
    server.draft = grounded([
      claimOf('c_f1000000000000001', 'f1', 'Follow-up claim.'),
      claimOf('c_main0000000000001', 'main', 'Sales grew by ten percent.', [
        evidenceOf(V1),
        evidenceOf(V2, 'b2'),
      ]),
    ]);
    await renderWorkspace();
    const root = region();
    expect(root.getAttribute('data-grounding-schema')).toBe('2');
    expect(root.querySelector('[data-claim-count]')?.textContent).toBe(
      'Grounded claims: 2'
    );
    // in thread order: the main post first
    expect(
      Array.from(root.querySelectorAll('[data-claim-id]')).map((node) =>
        node.getAttribute('data-claim-id')
      )
    ).toEqual(['c_main0000000000001', 'c_f1000000000000001']);
    const main = claimCard('c_main0000000000001');
    expect(within(main).getByText('Post')).toBeTruthy();
    expect(within(main).getByText('Sales grew by ten percent.')).toBeTruthy();
    expect(within(main).getByText('Evidence: 2')).toBeTruthy();
    expect(
      within(claimCard('c_f1000000000000001')).getByText('Follow-up 1')
    ).toBeTruthy();
    // FG8 evidence is not read until it is shown
    expect(sourceReads()).toEqual([]);
  });

  it('FG3/FG4/FG8 Show evidence reads exactly the stored versions it names and shows the block and quote', async () => {
    server.draft = grounded([
      claimOf('c_main0000000000001', 'main', 'Sales grew.', [
        evidenceOf(V1, 'b1', 'grew by ten percent'),
        evidenceOf(V2, 'b2'),
      ]),
    ]);
    await renderWorkspace();
    const card = claimCard('c_main0000000000001');
    const toggle = within(card).getByRole('button', { name: 'Show evidence' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    await settle();
    expect(
      within(card)
        .getByRole('button', { name: 'Hide evidence' })
        .getAttribute('aria-expanded')
    ).toBe('true');
    const items = Array.from(card.querySelectorAll('[data-evidence-block]'));
    expect(
      items.map((node) => node.getAttribute('data-evidence-block'))
    ).toEqual(['b1', 'b2']);
    expect(items[0].textContent).toContain(
      'Weekly report · Report v1 · Version 1'
    );
    expect(items[0].querySelector('blockquote')?.textContent).toBe(
      'grew by ten percent'
    );
    expect(items[0].textContent).toContain('Sales grew by ten percent in v1.');
    expect(items[1].textContent).toContain('Version 2');
    expect(items[1].textContent).toContain('Outlook v2');
    expect(items[1].querySelector('blockquote')).toBeNull();
    // the exact versions only: never the latest, a refresh or the web
    expect(
      [...new Set(sourceReads().map((c) => `${c.method} ${c.url}`))].sort()
    ).toEqual(
      [
        `GET /content-studio/sources/${SOURCE_ID}`,
        `GET /content-studio/sources/${SOURCE_ID}/versions/${V1}`,
        `GET /content-studio/sources/${SOURCE_ID}/versions/${V2}`,
      ].sort()
    );
    expect(card.textContent).not.toMatch(/https?:|URL_PRIVATE|1111111111/);
  });

  it('evidence a stored version does not hold is shown as not matching, never replaced', async () => {
    server.draft = grounded([
      claimOf('c_main0000000000001', 'main', 'Sales grew.', [
        { ...evidenceOf(V1), contentHash: '9'.repeat(64) },
        evidenceOf(V1, 'b9'),
      ]),
    ]);
    await renderWorkspace();
    fireEvent.click(
      within(claimCard('c_main0000000000001')).getByRole('button', {
        name: 'Show evidence',
      })
    );
    await settle();
    expect(
      within(claimCard('c_main0000000000001'))
        .getAllByRole('alert')
        .map((node) => node.textContent)
    ).toEqual([
      'This evidence does not match its source version.',
      'This evidence does not match its source version.',
    ]);
    expect(claimCard('c_main0000000000001').textContent).not.toContain(
      'Sales grew by ten percent in v'
    );
  });

  it('a v1 draft has no claims yet and reads no source', async () => {
    await renderWorkspace();
    expect(region().getAttribute('data-grounding-schema')).toBe('1');
    expect(within(region()).getByText('No grounded claims yet.')).toBeTruthy();
    expect(sourceReads()).toEqual([]);
  });

  it('FG9 says what grounding is, with no review, verification or approval words', async () => {
    await renderWorkspace();
    expect(region().textContent).toContain(
      'Evidence shows what a captured source says, not that it is true.'
    );
    const text = readFileSync(
      join(__dirname, 'content-studio.grounding.tsx'),
      'utf8'
    );
    expect(text).not.toMatch(
      /review|verified|verify|approv|fact[- ]?check|trusted|accurate/i
    );
  });
});

describe('grounding: edits that invalidate claims (P3-11)', () => {
  it('FG5/AP5 editing a grounded post removes its claims, says so once, and saves the draft without them', async () => {
    server.draft = grounded([
      claimOf('c_main0000000000001', 'main', 'Main claim.'),
      claimOf('c_f1000000000000001', 'f1', 'Follow-up claim.'),
    ]);
    await renderWorkspace();
    expect(
      document.querySelector('[aria-label="Post"] [data-item-claims]')
        ?.textContent
    ).toBe('This post has grounded claims. Editing its text removes them. (1)');
    type('Post', 'Hello edited');
    type('Post', 'Hello edited again');
    expect(
      toasts().filter(
        (text) =>
          text ===
          'The grounded claims of this post were removed because its text changed.'
      )
    ).toHaveLength(1);
    expect(
      document.querySelector('[aria-label="Post"] [data-item-claims]')
    ).toBeNull();
    await advance(1500);
    expect(lastPut().schemaVersion).toBe(2);
    expect(lastPut().grounding.claims.map((c: Claim) => c.id)).toEqual([
      'c_f1000000000000001',
    ]);
    expect(lastPut().copy.global.thread[0].text).toBe('Hello edited again');
  });

  it('editing a post without claims changes no claim', async () => {
    server.draft = grounded([
      claimOf('c_f1000000000000001', 'f1', 'Follow-up claim.'),
    ]);
    await renderWorkspace();
    type('Post', 'Hello edited');
    await advance(1500);
    expect(toasts()).toEqual([]);
    expect(lastPut().grounding.claims.map((c: Claim) => c.id)).toEqual([
      'c_f1000000000000001',
    ]);
  });

  it('AP6 removing a follow-up removes its claims: no orphan claim is saved', async () => {
    server.draft = grounded([
      claimOf('c_main0000000000001', 'main', 'Main claim.'),
      claimOf('c_f1000000000000001', 'f1', 'Follow-up claim.'),
    ]);
    await renderWorkspace();
    await click('Remove follow-up 1');
    await advance(1500);
    expect(lastPut().copy.global.thread.map((i: Item) => i.id)).toEqual([
      'main',
      'f2',
    ]);
    expect(lastPut().grounding.claims.map((c: Claim) => c.id)).toEqual([
      'c_main0000000000001',
    ]);
  });

  it('AP8 there is no way to duplicate a post, so no claim is ever copied', () => {
    const editor = readFileSync(
      join(__dirname, 'content-studio.thread.editor.tsx'),
      'utf8'
    );
    expect(editor).not.toMatch(
      /duplicate[A-Z]|Duplicate post|copyItem|cloneItem/
    );
  });

  it('a save the server refuses for its grounding shows the fixed reason', async () => {
    server.draft = grounded([
      claimOf('c_main0000000000001', 'main', 'Main claim.'),
    ]);
    const previous = override;
    override = (method, url, body) =>
      method === 'PUT'
        ? reply(400, { msg: 'PRIVATE', code: 'CS_DRAFT_GROUNDING_INVALID' })
        : previous(method, url, body);
    await renderWorkspace();
    type('Follow-up 2', 'Changed');
    await advance(1500);
    expect(
      screen
        .getAllByRole('alert')
        .map((node) => node.textContent)
        .join('\n')
    ).toContain(
      'Some grounding evidence does not match its source version. Remove or replace it to save.'
    );
    expect(document.body.textContent).not.toContain('PRIVATE');
  });
});

describe('grounding: claims written by hand (P3-11)', () => {
  const form = (name: 'Add claim' | 'Edit claim') =>
    screen.getByRole('form', { name });
  const pickEvidence = async (
    root: HTMLElement,
    blockId = 'b1',
    quote = ''
  ) => {
    fireEvent.click(within(root).getByRole('radio', { name: 'Weekly report' }));
    await settle();
    fireEvent.click(
      root.querySelector(
        `input[type="radio"][value="${blockId}"]`
      ) as HTMLElement
    );
    await settle();
    if (quote) {
      fireEvent.change(
        within(root).getByRole('textbox', {
          name: 'Quote (optional, exact words of this passage)',
        }),
        { target: { value: quote } }
      );
    }
  };

  it('writes a claim with exact evidence of the version the server stored, newest version first', async () => {
    await renderWorkspace();
    await click('Add claim');
    const root = form('Add claim');
    // only captured web pages can be evidence (P8-03: the others are shown,
    // turned off); choosing a source adds no evidence by itself
    expect(
      within(root)
        .getAllByRole('radio')
        .map((radio) => [
          radio.closest('label')!.textContent,
          (radio as HTMLInputElement).disabled,
        ])
    ).toEqual([
      ['Weekly report', false],
      ['Never captured', true],
    ]);
    expect(
      sourceReads().filter((c) => c.url.startsWith('/content-studio/sources?'))
    ).toHaveLength(1);
    expect(
      sourceReads().find((c) => c.url.startsWith('/content-studio/sources?'))!
        .url
    ).toBe('/content-studio/sources?page=1&archived=false&kind=url');
    fireEvent.change(within(root).getByRole('combobox', { name: 'Post' }), {
      target: { value: 'f1' },
    });
    fireEvent.change(within(root).getByRole('textbox', { name: 'Claim' }), {
      target: { value: '  Sales grew by ten percent.  ' },
    });
    expect(button('Save claim', root)).toHaveProperty('disabled', true);
    await pickEvidence(root, 'b1', 'grew by ten');
    await click('Add evidence', root);
    expect(button('Save claim', root)).toHaveProperty('disabled', false);
    await click('Save claim', root);
    await advance(1500);
    const saved = lastPut();
    expect(saved.schemaVersion).toBe(2);
    // the copy exactly as it was: only grounding was added
    expect(saved.copy).toEqual(
      draftOf(
        item('main', 'Hello\nworld  ', ['m1', 'm2']),
        item('f1', 'Second', ['m3', 'gone']),
        item('f2', 'Third')
      ).copy
    );
    expect(saved.grounding.claims).toEqual([
      {
        id: expect.stringMatching(/^c_[0-9a-f]{16}$/),
        threadItemId: 'f1',
        text: 'Sales grew by ten percent.',
        evidence: [evidenceOf(V2, 'b1', 'grew by ten')],
      },
    ]);
    // the exact version read from the server, never a latest lookup
    expect(sourceReads().map((c) => c.url)).not.toContain(
      `/content-studio/sources/${SOURCE_ID}/refresh`
    );
  });

  it('an older version can be chosen, and its own hash and number are stored', async () => {
    await renderWorkspace();
    await click('Add claim');
    const root = form('Add claim');
    fireEvent.change(within(root).getByRole('textbox', { name: 'Claim' }), {
      target: { value: 'Old figure.' },
    });
    fireEvent.click(within(root).getByRole('radio', { name: 'Weekly report' }));
    await settle();
    fireEvent.change(within(root).getByRole('combobox', { name: 'Version' }), {
      target: { value: V1 },
    });
    await settle();
    fireEvent.click(
      root.querySelector('input[type="radio"][value="b2"]') as HTMLElement
    );
    await click('Add evidence', root);
    await click('Save claim', root);
    await advance(1500);
    expect(lastPut().grounding.claims[0].evidence).toEqual([
      evidenceOf(V1, 'b2'),
    ]);
  });

  it('EP1-EP6/M5 finds a source beyond the first page through the server search; evidence is still the version, block and quote chosen', async () => {
    // 30 newer pages ahead of it: not on the first page of the list
    listed = [
      ...Array.from({ length: 30 }, (_, i) =>
        sourceSummary(
          `e${String(i).padStart(7, '0')}-1111-4111-8111-111111111111`,
          `Found page ${i + 1}`,
          1
        )
      ),
      ...listed,
    ];
    await renderWorkspace();
    await click('Add claim');
    const root = form('Add claim');
    expect(within(root).queryByRole('radio', { name: 'Weekly report' })).toBe(
      null
    );
    fireEvent.change(within(root).getByRole('textbox', { name: 'Claim' }), {
      target: { value: 'Sales grew.' },
    });
    fireEvent.change(
      within(root).getByRole('searchbox', { name: 'Name or address' }),
      { target: { value: 'weekly' } }
    );
    // Enter searches here and never submits the claim
    fireEvent.keyDown(
      within(root).getByRole('searchbox', { name: 'Name or address' }),
      { key: 'Enter' }
    );
    await settle();
    expect(sourceReads().map((c) => c.url)).toContain(
      '/content-studio/sources?page=1&archived=false&kind=url&search=weekly'
    );
    expect(screen.queryByRole('form', { name: 'Add claim' })).not.toBeNull();
    fireEvent.click(within(root).getByRole('radio', { name: 'Weekly report' }));
    await settle();
    // the existing version and passage choice, newest version first
    expect(
      (
        within(root).getByRole('combobox', {
          name: 'Version',
        }) as HTMLSelectElement
      ).value
    ).toBe(V2);
    expect(button('Save claim', root)).toHaveProperty('disabled', true);
    fireEvent.click(
      root.querySelector('input[type="radio"][value="b1"]') as HTMLElement
    );
    await settle();
    await click('Add evidence', root);
    await click('Save claim', root);
    await advance(1500);
    expect(lastPut().grounding.claims[0].evidence).toEqual([
      evidenceOf(V2, 'b1'),
    ]);
  });

  it('a quote that is not words of the chosen passage cannot be added', async () => {
    await renderWorkspace();
    await click('Add claim');
    const root = form('Add claim');
    await pickEvidence(root, 'b1', 'grew by twenty');
    expect(
      within(root).getByText(
        'The quote must be exact words of the chosen passage.'
      )
    ).toBeTruthy();
    expect(button('Add evidence', root)).toHaveProperty('disabled', true);
  });

  it('a claim needs text and evidence before it can be saved', async () => {
    await renderWorkspace();
    await click('Add claim');
    const root = form('Add claim');
    expect(
      within(root).getByText(
        'A grounded claim needs at least one piece of evidence.'
      )
    ).toBeTruthy();
    fireEvent.change(within(root).getByRole('textbox', { name: 'Claim' }), {
      target: { value: '   ' },
    });
    await pickEvidence(root);
    await click('Add evidence', root);
    expect(button('Save claim', root)).toHaveProperty('disabled', true);
    await click('Cancel', root);
    expect(screen.queryByRole('form', { name: 'Add claim' })).toBeNull();
    await advance(1500);
    expect(puts()).toEqual([]);
  });

  it('editing a claim keeps its id and post; removing it removes only it', async () => {
    server.draft = grounded([
      claimOf('c_main0000000000001', 'main', 'Main claim.'),
      claimOf('c_f1000000000000001', 'f1', 'Follow-up claim.'),
    ]);
    await renderWorkspace();
    fireEvent.click(
      within(claimCard('c_main0000000000001')).getByRole('button', {
        name: 'Edit claim',
      })
    );
    await settle();
    const root = form('Edit claim');
    expect(within(root).getByRole('combobox', { name: 'Post' })).toHaveProperty(
      'disabled',
      true
    );
    fireEvent.change(within(root).getByRole('textbox', { name: 'Claim' }), {
      target: { value: 'Main claim, reworded.' },
    });
    await click('Save claim', root);
    await advance(1500);
    expect(lastPut().grounding.claims).toEqual([
      claimOf('c_main0000000000001', 'main', 'Main claim, reworded.'),
      claimOf('c_f1000000000000001', 'f1', 'Follow-up claim.'),
    ]);
    fireEvent.click(
      within(claimCard('c_f1000000000000001')).getByRole('button', {
        name: 'Remove claim',
      })
    );
    await advance(1500);
    expect(lastPut().schemaVersion).toBe(2);
    expect(lastPut().grounding.claims.map((c: Claim) => c.id)).toEqual([
      'c_main0000000000001',
    ]);
  });

  it('an archived package shows its claims read-only', async () => {
    server.archivedAt = '2026-10-05T10:00:00.000Z';
    server.draft = grounded([
      claimOf('c_main0000000000001', 'main', 'Main claim.'),
    ]);
    await renderWorkspace();
    expect(
      within(region()).queryByRole('button', { name: 'Add claim' })
    ).toBeNull();
    expect(
      within(claimCard('c_main0000000000001')).queryByRole('button', {
        name: 'Edit claim',
      })
    ).toBeNull();
    expect(
      within(claimCard('c_main0000000000001')).queryByRole('button', {
        name: 'Remove claim',
      })
    ).toBeNull();
    expect(
      within(claimCard('c_main0000000000001')).getByRole('button', {
        name: 'Show evidence',
      })
    ).toBeTruthy();
  });
});

describe('grounding: saved versions (P3-11)', () => {
  const openRevision = async (n: number) => {
    await click('History');
    await click(`View ${n}`);
    return screen.getByRole('dialog', { name: 'History' });
  };

  it('FG1 a v1 version says no grounded claims were recorded, and reads nothing else', async () => {
    server.revisions.unshift({
      id: 'rev-1',
      revisionNumber: 1,
      origin: 'manual',
      sourceDraftVersion: 1,
      content: draftOf(item('main', 'v1 text')),
    });
    await renderWorkspace();
    const dialog = await openRevision(1);
    const grounding = within(dialog).getByRole('region', { name: 'Grounding' });
    expect(grounding.getAttribute('data-grounding-schema')).toBe('1');
    expect(
      within(grounding).getByText(
        'No grounded claims were recorded in this revision.'
      )
    ).toBeTruthy();
    expect(sourceReads()).toEqual([]);
  });

  it('FG10/IR3 a v2 version shows exactly its own claims, read-only, whatever the draft holds now', async () => {
    server.revisions.unshift({
      id: 'rev-1',
      revisionNumber: 1,
      origin: 'manual',
      sourceDraftVersion: 1,
      content: grounded([
        claimOf('c_old0000000000001', 'main', 'Claim of version 1.'),
      ]),
    });
    server.draft = grounded([
      claimOf('c_new0000000000001', 'main', 'Claim of the draft.'),
    ]);
    await renderWorkspace();
    const dialog = await openRevision(1);
    const grounding = within(dialog).getByRole('region', { name: 'Grounding' });
    expect(within(grounding).getByText('Claim of version 1.')).toBeTruthy();
    expect(within(grounding).queryByText('Claim of the draft.')).toBeNull();
    expect(
      within(grounding).queryByRole('button', { name: 'Add claim' })
    ).toBeNull();
    expect(
      within(grounding).queryByRole('button', { name: 'Edit claim' })
    ).toBeNull();
    expect(
      within(grounding).queryByRole('button', { name: 'Remove claim' })
    ).toBeNull();
  });

  it('restoring a v2 version restores its claims with it', async () => {
    const content = grounded([
      claimOf('c_old0000000000001', 'main', 'Claim of version 1.'),
    ]);
    server.revisions.unshift({
      id: 'rev-1',
      revisionNumber: 1,
      origin: 'manual',
      sourceDraftVersion: 1,
      content,
    });
    server.draft = draftOf(item('main', 'Other text'));
    await renderWorkspace();
    await click('History');
    await click('Restore to draft 1');
    await settle();
    expect(lastPut()).toEqual(content);
  });
});
