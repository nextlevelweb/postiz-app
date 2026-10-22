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

// Same conventions as the other frontend specs: a .spec.ts without JSX,
// components required (not imported), real SWR with a fresh cache per test

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
const { createThreadItemId } = require('./content-studio.thread.editor');

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

const addRevision = (n: number, content = draftOf(item('main', `v${n}`))) =>
  server.revisions.unshift({
    id: `rev-${n}`,
    revisionNumber: n,
    origin: n % 2 ? 'manual' : 'handoff',
    sourceDraftVersion: n,
    content,
  });

describe('workspace: loading', () => {
  it('W1-W4 one GET; name, every item in order, text exactly as stored', async () => {
    await renderWorkspace();
    expect(calls()).toEqual([{ method: 'GET', url: BASE, body: undefined }]);
    expect(screen.getByRole('heading', { name: 'Spring launch' })).toBeTruthy();
    expect(box('Post').value).toBe('Hello\nworld  ');
    expect(box('Follow-up 1').value).toBe('Second');
    expect(box('Follow-up 2').value).toBe('Third');
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
    expect(status()).toBe('Saved');
  });

  it('W5-W8 Media from the preview map: image, processing, failed, unavailable', async () => {
    await renderWorkspace();
    const images = Array.from(document.querySelectorAll('img')).map((i) =>
      i.getAttribute('src')
    );
    expect(images).toEqual(['/t/m1.png', '/t/m2.png', '/uploads/m3.png']);
    expect(screen.getByText('Processing')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Unavailable media')).toBeTruthy();
  });

  it('W9-W11 no revision, handoff, Media or post request on load', async () => {
    await renderWorkspace();
    await advance(5000);
    expect(calls().map((c) => c.url)).toEqual([BASE]);
  });

  it('a missing package says so, with a way back', async () => {
    override = (m, url) =>
      url === BASE
        ? reply(404, { msg: 'pkg-1 of org-2', code: 'CS_NOT_FOUND' })
        : undefined;
    await renderWorkspace();
    expect(screen.getByText('Content Studio package not found.')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Back to Content Studio' })
        .getAttribute('href')
    ).toBe('/content-studio');
    expect(document.body.textContent).not.toContain('org-2');
  });

  it('a failed load can be retried', async () => {
    let fail = true;
    override = (m, url) =>
      fail && url === BASE ? reply(500, { msg: 'boom' }) : undefined;
    await renderWorkspace();
    expect(screen.getByText('Could not load Content Studio.')).toBeTruthy();
    fail = false;
    await click('Try again');
    expect(box('Post').value).toBe('Hello\nworld  ');
  });
});

describe('workspace: editing', () => {
  it('E1-E3/S1 typing shows at once; one PUT 1500 ms after the last keystroke', async () => {
    await renderWorkspace();
    type('Post', 'H');
    type('Post', 'Hi');
    type('Post', 'Hi there');
    expect(box('Post').value).toBe('Hi there');
    expect(status()).toBe('Unsaved changes');
    await advance(1499);
    expect(puts()).toHaveLength(0);
    await advance(1);
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body).toEqual({
      baseDraftVersion: 4,
      draft: draftOf(
        item('main', 'Hi there', ['m1', 'm2']),
        item('f1', 'Second', ['m3', 'gone']),
        item('f2', 'Third')
      ),
    });
    expect(status()).toBe('Saved');
  });

  it('E4 a follow-up gets a fresh 16 hex id and is saved', async () => {
    await renderWorkspace();
    await click('Add follow-up');
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
    await advance(1500);
    const thread = puts()[0].body.draft.copy.global.thread;
    expect(thread).toHaveLength(4);
    expect(thread[3]).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{16}$/),
      text: '',
      mediaIds: [],
    });
    expect(new Set(thread.map((i: Item) => i.id)).size).toBe(4);
  });

  it('createThreadItemId always fits the item id format and differs', () => {
    const ids = Array.from({ length: 200 }, () => createThreadItemId());
    ids.forEach((id) => expect(id).toMatch(/^[A-Za-z0-9_-]{1,32}$/));
    expect(new Set(ids).size).toBe(200);
  });

  it('E5 no more than 25 posts', async () => {
    server.draft = draftOf(
      ...Array.from({ length: 25 }, (_, i) => item(`i${i}`, `t${i}`))
    );
    await renderWorkspace();
    expect(button('Add follow-up')).toHaveProperty('disabled', true);
    fireEvent.click(button('Add follow-up'));
    await advance(1500);
    expect(puts()).toHaveLength(0);
  });

  it('E6/E7 removing a follow-up; the first post cannot be removed', async () => {
    await renderWorkspace();
    expect(
      screen.queryByRole('button', { name: /^Remove follow-up 0/ })
    ).toBeNull();
    await click('Remove follow-up 1');
    await advance(1500);
    expect(
      puts()[0].body.draft.copy.global.thread.map((i: Item) => i.id)
    ).toEqual(['main', 'f2']);
  });

  it('E14/MP7 removing a Media (even an unavailable one) changes only that item, never deletes Media', async () => {
    server.draft = draftOf(
      item('main', 'a', ['m1', 'gone']),
      item('f1', 'b', ['gone'])
    );
    await renderWorkspace();
    await click('Remove media 2', screen.getByRole('region', { name: 'Post' }));
    await advance(1500);
    expect(
      puts()[0].body.draft.copy.global.thread.map((i: Item) => i.mediaIds)
    ).toEqual([['m1'], ['gone']]);
    expect(
      calls().some((c) => c.method === 'DELETE' || c.url.includes('/media'))
    ).toBe(false);
  });

  it('E15 moving a Media changes the saved order', async () => {
    await renderWorkspace();
    const post = screen.getByRole('region', { name: 'Post' });
    expect(button('Move media left 1', post)).toHaveProperty('disabled', true);
    await click('Move media right 1', post);
    await advance(1500);
    expect(puts()[0].body.draft.copy.global.thread[0].mediaIds).toEqual([
      'm2',
      'm1',
    ]);
  });

  it('keeps emoji, combining marks, spaces and newlines exactly', async () => {
    await renderWorkspace();
    const text = '  e\u0301 \u{1F680}\n\n tab\tend ';
    type('Post', text);
    await advance(1500);
    expect(puts()[0].body.draft.copy.global.thread[0].text).toBe(text);
    expect(box('Post').getAttribute('maxlength')).toBe('10000');
  });
});

describe('workspace: Media picker', () => {
  const openPicker = async (region: string) => {
    await click(/^Add media/, screen.getByRole('region', { name: region }));
    expect(screen.getByRole('dialog', { name: 'Media Library' })).toBeTruthy();
  };

  it('MP1-MP3/E8/E9/E16 adds the picked ids to that item; paths only show the tile', async () => {
    await renderWorkspace();
    await openPicker('Follow-up 2');
    expect(mockMediaBox.mock.calls[0][0]).toEqual({
      setMedia: expect.any(Function),
      closeModal: expect.any(Function),
    });
    await pick([
      {
        id: 'm9',
        path: '/uploads/m9.png',
        thumbnail: '/uploads/m9-thumb.png',
        status: 'ready',
      },
      { id: 'm8', path: '/uploads/m8.mp4' },
    ]);
    const third = screen.getByRole('region', { name: 'Follow-up 2' });
    expect(
      Array.from(third.querySelectorAll('img')).map((i) =>
        i.getAttribute('src')
      )
    ).toEqual(['/uploads/m9-thumb.png']);
    expect(within(third).getByText('Video')).toBeTruthy();
    await advance(1500);
    const body = puts()[0].body;
    expect(body.draft.copy.global.thread[2].mediaIds).toEqual(['m9', 'm8']);
    expect(JSON.stringify(body)).not.toMatch(/uploads|thumb|path|status/);
  });

  it('MP4/E11 the same Media can go in another item', async () => {
    await renderWorkspace();
    await openPicker('Follow-up 2');
    await pick([{ id: 'm1', path: '/uploads/m1.png' }]);
    await advance(1500);
    expect(puts()[0].body.draft.copy.global.thread[2].mediaIds).toEqual(['m1']);
  });

  it('E10 a Media already in the item is refused, nothing changes', async () => {
    await renderWorkspace();
    await openPicker('Post');
    await pick([{ id: 'm1', path: '/uploads/m1.png' }]);
    await advance(1500);
    expect(toasts()).toEqual(['This media is already in this post.']);
    expect(puts()).toHaveLength(0);
  });

  it('E12 more than 20 in one item is refused', async () => {
    server.draft = draftOf(
      item(
        'main',
        'a',
        Array.from({ length: 19 }, (_, i) => `x${i}`)
      )
    );
    await renderWorkspace();
    await openPicker('Post');
    await pick([
      { id: 'n1', path: '/u/n1.png' },
      { id: 'n2', path: '/u/n2.png' },
    ]);
    await advance(1500);
    expect(toasts()).toEqual(['A post can have up to 20 media.']);
    expect(puts()).toHaveLength(0);
  });

  it('E13 more than 50 different Media in the package is refused', async () => {
    const ids = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => `x${from + i}`);
    server.draft = draftOf(
      item('a', 'a', ids(0, 20)),
      item('b', 'b', ids(20, 20)),
      item('c', 'c', ids(40, 10))
    );
    await renderWorkspace();
    await openPicker('Follow-up 2');
    await pick([{ id: 'new1', path: '/u/new1.png' }]);
    expect(toasts()).toEqual(['A package can use up to 50 different media.']);
    // an id already used elsewhere still fits
    await pick([{ id: 'x0', path: '/u/x0.png' }]);
    await advance(1500);
    expect(puts()[0].body.draft.copy.global.thread[2].mediaIds).toHaveLength(
      11
    );
  });

  it('a picked id that is not a Media id is refused', async () => {
    await renderWorkspace();
    await openPicker('Post');
    await pick([{ id: '../etc/passwd', path: '/x' }]);
    expect(toasts()).toEqual(['This media cannot be used.']);
  });
});

describe('workspace: autosave', () => {
  it('S2/S3 edits during a PUT wait; only the latest goes next, on the returned version', async () => {
    await renderWorkspace();
    const release = deferNext('PUT', '/draft');
    type('Post', 'A');
    await advance(1500);
    type('Post', 'B');
    await advance(100);
    type('Post', 'C');
    await advance(1500);
    expect(puts()).toHaveLength(1);
    expect(status()).toBe('Saving...');
    await release();
    expect(putTexts()).toEqual([
      ['A|Second|Third', 4],
      ['C|Second|Third', 5],
    ]);
    expect(status()).toBe('Saved');
  });

  it('S4-S6 a conflict stops saving until the package is reloaded', async () => {
    await renderWorkspace();
    // someone else saved
    server.draft = draftOf(item('main', 'theirs'));
    server.draftVersion = 9;
    type('Post', 'mine');
    await advance(1500);
    expect(screen.getByRole('alert').textContent).toContain(
      'This package changed elsewhere. Reload the server version before continuing.'
    );
    expect(status()).toBe('Conflict');
    type('Post', 'mine again');
    await advance(10_000);
    expect(puts()).toHaveLength(1);
    expect(button('Save version')).toHaveProperty('disabled', true);
    expect(button('Use in Post')).toHaveProperty('disabled', true);

    await click('Reload package');
    expect(box('Post').value).toBe('theirs');
    expect(screen.queryByRole('alert')).toBeNull();
    type('Post', 'theirs + mine');
    await advance(1500);
    expect(putTexts().pop()).toEqual(['theirs + mine', 9]);
  });

  it('S7/S8 a failed save keeps the text and can be retried', async () => {
    await renderWorkspace();
    let fail = true;
    override = (m) =>
      fail && m === 'PUT' ? reply(500, { msg: 'stack at org-1' }) : undefined;
    type('Post', 'keep me');
    await advance(1500);
    expect(box('Post').value).toBe('keep me');
    expect(screen.getByRole('alert').textContent).toContain(
      'Could not save this Content Studio draft.'
    );
    expect(document.body.textContent).not.toContain('org-1');
    await advance(60_000);
    expect(puts()).toHaveLength(1);
    fail = false;
    await click('Retry save');
    expect(putTexts().pop()).toEqual(['keep me|Second|Third', 4]);
    expect(status()).toBe('Saved');
  });

  it('S9 archived elsewhere while editing: message, reload, read-only', async () => {
    await renderWorkspace();
    server.archivedAt = '2026-10-12T10:00:00.000Z';
    type('Post', 'late edit');
    await advance(1500);
    expect(toasts()).toContain('This package is archived.');
    expect(of('GET', BASE)).toHaveLength(2);
    expect(box('Post')).toHaveProperty('disabled', true);
    expect(status()).toBe('Archived - read only');
    await advance(10_000);
    expect(puts()).toHaveLength(1);
  });

  it('S10 a revalidation of the package never replaces unsaved text', async () => {
    await renderWorkspace();
    type('Post', 'unsaved local');
    server.draft = draftOf(item('main', 'server changed'));
    await act(async () => {
      await swrMutate(BASE);
    });
    await settle();
    expect(of('GET', BASE)).toHaveLength(2);
    expect(box('Post').value).toBe('unsaved local');
  });

  it('a second visit seeds from a fresh load, not from the cache of the first', async () => {
    const cache = new Map();
    const first = await renderWorkspace(cache);
    type('Post', 'saved text');
    await advance(1500);
    first.unmount();
    await renderWorkspace(cache);
    // the cached (outdated) detail is never used: the editor waits
    expect(screen.queryByRole('textbox')).toBeNull();
    // with cached data SWR revalidates on the next animation frame
    await advance(50);
    expect(box('Post').value).toBe('saved text');
    type('Post', 'saved text 2');
    await advance(1500);
    expect(putTexts().pop()).toEqual(['saved text 2|Second|Third', 5]);
  });
});

describe('workspace: another package', () => {
  it('seeds only from the detail of the package it shows', async () => {
    const view = await renderWorkspace();
    expect(box('Post').value).toBe('Hello\nworld  ');
    override = (m, url) =>
      m === 'GET' && url === '/content-studio/packages/pkg-2'
        ? reply(200, {
            id: 'pkg-2',
            name: 'Other',
            projectId: null,
            draft: draftOf(item('other', 'other package')),
            draftVersion: 1,
            latestRevisionNumber: 0,
            archivedAt: null,
            createdAt: '2026-10-01T10:00:00.000Z',
            updatedAt: '2026-10-01T10:00:00.000Z',
            media: {},
          })
        : undefined;
    view.rerender(
      h(
        SWRConfig,
        { value: { provider: () => new Map(), dedupingInterval: 0 } },
        h(Probe),
        h(ModalHost),
        h(ContentStudioWorkspace, { packageId: 'pkg-2' })
      )
    );
    await settle();
    expect(box('Post').value).toBe('other package');
    expect(screen.getByRole('heading', { name: 'Other' })).toBeTruthy();
  });
});

describe('workspace: Save version', () => {
  it('V1/V4 with nothing unsaved: POST revisions on the current version, manual', async () => {
    await renderWorkspace();
    await click('Save version');
    expect(puts()).toHaveLength(0);
    expect(revisionPosts().map((c) => c.body)).toEqual([
      { draftVersion: 4, origin: 'manual' },
    ]);
    expect(toasts()).toEqual(['Version saved.']);
    expect(screen.getByText(/Revisions:/).textContent).toBe('Revisions: 1');
  });

  it('V2 unsaved text is saved first, and the version uses the returned draft version', async () => {
    await renderWorkspace();
    type('Post', 'fresh');
    await click('Save version');
    expect(
      calls()
        .slice(1)
        .map((c) => c.method + ' ' + c.url)
    ).toEqual([`PUT ${BASE}/draft`, `POST ${BASE}/revisions`]);
    expect(revisionPosts()[0].body).toEqual({
      draftVersion: 5,
      origin: 'manual',
    });
  });

  it('V3 waits for a running save and the queued latest one', async () => {
    await renderWorkspace();
    const release = deferNext('PUT', '/draft');
    type('Post', 'A');
    await advance(1500);
    type('Post', 'B');
    fireEvent.click(button('Save version'));
    await settle();
    expect(revisionPosts()).toHaveLength(0);
    await release();
    expect(putTexts()).toEqual([
      ['A|Second|Third', 4],
      ['B|Second|Third', 5],
    ]);
    expect(revisionPosts()[0].body).toEqual({
      draftVersion: 6,
      origin: 'manual',
    });
  });

  it('V5 unchanged content: told so, nothing assumed', async () => {
    await renderWorkspace();
    await click('Save version');
    await click('Save version');
    expect(toasts()).toEqual([
      'Version saved.',
      'No changes since the latest version.',
    ]);
    expect(server.revisions).toHaveLength(1);
  });

  it('V6 an empty post gives a fixed message without its text', async () => {
    await renderWorkspace();
    override = (m, url) =>
      m === 'POST' && url.endsWith('/revisions')
        ? reply(400, {
            msg: 'item 2 "Third" empty',
            code: 'CS_DRAFT_EMPTY_ITEM',
            itemIndex: 2,
          })
        : undefined;
    await click('Save version');
    expect(toasts()).toEqual([
      'Every post in the thread needs text or media before saving a version.',
    ]);
  });

  it('V7 a draft version conflict on the version request enters the conflict state', async () => {
    await renderWorkspace();
    override = (m, url) =>
      m === 'POST' && url.endsWith('/revisions')
        ? reply(409, { code: 'CS_DRAFT_VERSION_CONFLICT' })
        : undefined;
    await click('Save version');
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(status()).toBe('Conflict');
  });

  it('V7 "package changed" reloads the package', async () => {
    await renderWorkspace();
    override = (m, url) =>
      m === 'POST' && url.endsWith('/revisions')
        ? reply(409, { code: 'CS_PACKAGE_CHANGED' })
        : undefined;
    await click('Save version');
    expect(toasts()).toEqual([
      'This package changed while saving. It was reloaded.',
    ]);
    expect(of('GET', BASE)).toHaveLength(2);
  });

  it('M30 the editor is locked from the start of the action to its end', async () => {
    await renderWorkspace();
    const release = deferNext('POST', '/revisions');
    fireEvent.click(button('Save version'));
    await settle();
    expect(box('Post')).toHaveProperty('disabled', true);
    type('Post', 'sneaked in');
    expect(box('Post').value).toBe('Hello\nworld  ');
    await release();
    expect(box('Post')).toHaveProperty('disabled', false);
    await advance(5000);
    expect(puts()).toHaveLength(0);
  });
});

describe('workspace: history', () => {
  const openHistory = async () => {
    await click('History');
    return screen.getByRole('dialog', { name: 'History' });
  };

  it('H1-H5 opening fetches page 1, newest first, no content; nothing while closed', async () => {
    addRevision(1);
    addRevision(2);
    await renderWorkspace();
    expect(calls().filter((c) => c.url.includes('/revisions'))).toHaveLength(0);
    const dialog = await openHistory();
    expect(of('GET', `${BASE}/revisions`).map((c) => c.url)).toEqual([
      `${BASE}/revisions?page=1`,
    ]);
    const rows = within(dialog)
      .getAllByRole('listitem')
      .map((r) => r.textContent);
    expect(rows[0]).toMatch(/^Version 2/);
    expect(rows[0]).toContain('Robin');
    expect(rows[0]).toContain('Used in a post');
    expect(rows[1]).toContain('Saved version');
    expect(rows.join(' ')).not.toMatch(/v1|v2|hash/);
  });

  it('H4 pages come from the server', async () => {
    for (let n = 1; n <= 25; n++) addRevision(n);
    await renderWorkspace();
    const dialog = await openHistory();
    await click('Next', dialog);
    expect(of('GET', `${BASE}/revisions`).map((c) => c.url)).toEqual([
      `${BASE}/revisions?page=1`,
      `${BASE}/revisions?page=2`,
    ]);
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(5);
  });

  it('H6-H8 View loads that one revision and shows plain text and its Media', async () => {
    addRevision(
      1,
      draftOf(item('main', '<b>not html</b>\nline two', ['m1', 'gone']))
    );
    await renderWorkspace();
    const dialog = await openHistory();
    await click('View 1', dialog);
    expect(of('GET', `${BASE}/revisions/rev-1`)).toHaveLength(1);
    const text = within(dialog).getByText(
      (_, el) =>
        el?.textContent === '<b>not html</b>\nline two' &&
        el.className.includes('whitespace-pre-wrap')
    );
    expect(text.querySelector('b')).toBeNull();
    expect(within(dialog).getByText('Unavailable media')).toBeTruthy();
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('/t/m1.png');
  });

  it('H9/H10 restore asks first; cancelling changes nothing', async () => {
    addRevision(1);
    mockConfirm.mockResolvedValue(false);
    await renderWorkspace();
    const dialog = await openHistory();
    await click('Restore to draft 1', dialog);
    expect(mockConfirm).toHaveBeenCalledWith(
      'Restore this version into the current draft? The revision itself will remain unchanged.',
      'Restore',
      'Restore to draft',
      'Cancel'
    );
    await advance(5000);
    expect(puts()).toHaveLength(0);
    expect(box('Post').value).toBe('Hello\nworld  ');
  });

  it('H11-H15/M20 restore saves pending text first, then copies the revision onto the current version', async () => {
    addRevision(1, draftOf(item('main', 'old text', ['m1'])));
    server.revisions[0].sourceDraftVersion = 2;
    server.draftVersion = 7;
    await renderWorkspace();
    type('Post', 'pending');
    const dialog = await openHistory();
    await click('View 1', dialog);
    await click('Restore to draft', dialog);

    expect(putTexts()).toEqual([
      ['pending|Second|Third', 7],
      ['old text', 8],
    ]);
    expect(puts()[1].body.draft).toEqual(
      draftOf(item('main', 'old text', ['m1']))
    );
    expect(box('Post').value).toBe('old text');
    expect(toasts()).toEqual(['Version restored to draft.']);
    expect(server.revisions).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'History' })).toBeNull();
    // the package was reloaded for its Media
    expect(of('GET', BASE)).toHaveLength(2);
    // H12: the revision is untouched by later edits (it is frozen: a write would throw)
    type('Post', 'edited after restore');
    await advance(1500);
    expect(server.revisions[0].content).toEqual(
      draftOf(item('main', 'old text', ['m1']))
    );
    expect(
      calls().some(
        (c) =>
          c.url.includes('/revisions/') &&
          c.method !== 'GET' &&
          !c.url.endsWith('/handoffs')
      )
    ).toBe(false);
  });

  it('restore from the list fetches that revision once', async () => {
    addRevision(1, draftOf(item('main', 'from list')));
    await renderWorkspace();
    const dialog = await openHistory();
    await click('Restore to draft 1', dialog);
    expect(of('GET', `${BASE}/revisions/rev-1`)).toHaveLength(1);
    expect(box('Post').value).toBe('from list');
  });
});

describe('workspace: Use in Post', () => {
  it('U1/U4/U6-U9 makes a handoff revision, then a handoff, and opens only its id', async () => {
    await renderWorkspace();
    await click('Use in Post');
    expect(revisionPosts().map((c) => c.body)).toEqual([
      { draftVersion: 4, origin: 'handoff' },
    ]);
    expect(handoffPosts()).toEqual([
      {
        method: 'POST',
        url: `${BASE}/revisions/rev-1/handoffs`,
        body: undefined,
      },
    ]);
    expect(mockRouter.push).toHaveBeenCalledWith(
      `/launches?handoff=${HANDOFF}`
    );
    expect(mockRouter.push.mock.calls[0][0]).not.toMatch(
      /pkg|rev|Hello|uploads/
    );
  });

  it('U2/U3 saves the latest text first, waiting for a running save', async () => {
    await renderWorkspace();
    const release = deferNext('PUT', '/draft');
    type('Post', 'A');
    await advance(1500);
    type('Post', 'B');
    fireEvent.click(button('Use in Post'));
    await settle();
    expect(revisionPosts()).toHaveLength(0);
    await release();
    expect(putTexts()).toEqual([
      ['A|Second|Third', 4],
      ['B|Second|Third', 5],
    ]);
    expect(revisionPosts()[0].body).toEqual({
      draftVersion: 6,
      origin: 'handoff',
    });
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
  });

  it('U5 unchanged since the latest version: that revision is handed over', async () => {
    await renderWorkspace();
    await click('Save version');
    await click('Use in Post');
    expect(server.revisions).toHaveLength(1);
    expect(handoffPosts()[0].url).toBe(`${BASE}/revisions/rev-1/handoffs`);
  });

  it('U10 a double click runs one flow', async () => {
    await renderWorkspace();
    const release = deferNext('POST', '/revisions');
    // both clicks land before React re-renders the disabled button
    act(() => {
      button('Use in Post').click();
      button('Use in Post').click();
    });
    await settle();
    fireEvent.click(button('Use in Post'));
    await release();
    expect(revisionPosts()).toHaveLength(1);
    expect(handoffPosts()).toHaveLength(1);
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
  });

  it('a double click on Save version saves one version', async () => {
    await renderWorkspace();
    act(() => {
      button('Save version').click();
      button('Save version').click();
    });
    await settle();
    expect(revisionPosts()).toHaveLength(1);
  });

  it('U11 Media not ready: fixed message, no navigation, editor usable', async () => {
    override = (m, url) =>
      url.endsWith('/handoffs')
        ? reply(400, {
            code: 'CS_MEDIA_UNAVAILABLE',
            items: [{ itemIndex: 0, mediaIndex: 1, reason: 'processing' }],
          })
        : undefined;
    await renderWorkspace();
    await click('Use in Post');
    expect(toasts()).toEqual([
      'Some media is not ready or is no longer available.',
    ]);
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(box('Post')).toHaveProperty('disabled', false);
  });

  it('U12 a revision conflict creates no handoff', async () => {
    override = (m, url) =>
      m === 'POST' && url.endsWith('/revisions')
        ? reply(409, { code: 'CS_DRAFT_VERSION_CONFLICT' })
        : undefined;
    await renderWorkspace();
    await click('Use in Post');
    expect(handoffPosts()).toHaveLength(0);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('U13 a failed handoff: generic message, no navigation', async () => {
    override = (m, url) =>
      url.endsWith('/handoffs')
        ? reply(500, { msg: 'internal pkg-1' })
        : undefined;
    await renderWorkspace();
    await click('Use in Post');
    expect(toasts()).toEqual(['Could not prepare this post.']);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('an unexpected handoff id is never navigated to', async () => {
    override = (m, url) =>
      url.endsWith('/handoffs')
        ? reply(201, { id: '../posts?x=1' })
        : undefined;
    await renderWorkspace();
    await click('Use in Post');
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(toasts()).toEqual(['Could not prepare this post.']);
  });
});

describe('workspace: archived package', () => {
  beforeEach(() => {
    server.archivedAt = '2026-10-05T10:00:00.000Z';
  });

  it('AR1-AR6 read-only: no editing, no saves, no Save version', async () => {
    await renderWorkspace();
    expect(status()).toBe('Archived - read only');
    screen
      .getAllByRole('textbox')
      .forEach((t) => expect(t).toHaveProperty('disabled', true));
    expect(button('Add follow-up')).toHaveProperty('disabled', true);
    expect(button('Remove follow-up 1')).toHaveProperty('disabled', true);
    screen
      .getAllByRole('button', { name: /media/i })
      .forEach((b) => expect(b).toHaveProperty('disabled', true));
    expect(button('Save version')).toHaveProperty('disabled', true);
    type('Post', 'nope');
    await advance(10_000);
    expect(puts()).toHaveLength(0);
    expect(box('Post').value).toBe('Hello\nworld  ');
  });

  it('UA1/AR8 without a revision: Use in Post is off and explained', async () => {
    await renderWorkspace();
    expect(button('Use in Post')).toHaveProperty('disabled', true);
    expect(
      screen.getByText(
        'This archived package has no saved version to use in a post.'
      )
    ).toBeTruthy();
    fireEvent.click(button('Use in Post'));
    await settle();
    expect(calls()).toHaveLength(1);
  });

  it('UA2-UA7/AR7 hands over the latest existing revision, never a new one', async () => {
    addRevision(1);
    addRevision(2);
    await renderWorkspace();
    expect(button('History')).toHaveProperty('disabled', false);
    await click('Use in Post');
    expect(revisionPosts()).toHaveLength(0);
    expect(puts()).toHaveLength(0);
    expect(of('GET', `${BASE}/revisions`).map((c) => c.url)).toEqual([
      `${BASE}/revisions?page=1`,
    ]);
    expect(handoffPosts()[0].url).toBe(`${BASE}/revisions/rev-2/handoffs`);
    expect(mockRouter.push).toHaveBeenCalledWith(
      `/launches?handoff=${HANDOFF}`
    );
  });

  it('history is readable but restore is off', async () => {
    addRevision(1);
    await renderWorkspace();
    await click('History');
    const dialog = screen.getByRole('dialog', { name: 'History' });
    expect(button('Restore to draft 1', dialog)).toHaveProperty(
      'disabled',
      true
    );
  });
});

describe('workspace: source surface', () => {
  const files = [
    'content-studio.workspace.tsx',
    'content-studio.thread.editor.tsx',
    'content-studio.revision.history.tsx',
    'content-studio.autosave.ts',
    'content-studio.api.ts',
  ];
  const sources = files.map(
    (file) => [file, readFileSync(join(__dirname, file), 'utf8')] as const
  );

  it('M29 never imports the composer, its store or the handoff opener, nor calls post APIs', () => {
    for (const [file, source] of sources) {
      expect(source).not.toMatch(
        /new-launch\/store|add\.edit\.modal|handoff\.opener|AddEditModal|useLaunchStore/
      );
      expect(source).not.toMatch(/['`]\/posts|find-slot|\/public\/|schedule/i);
      expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML/);
      expect(source).not.toMatch(
        /process\.env|localStorage|sessionStorage|sendBeacon|Math\.random/
      );
      expect(source).not.toMatch(/organizationId|orgId/);
      expect(source).not.toMatch(/'DELETE'|"DELETE"/);
      if (file !== 'content-studio.api.ts') {
        // the home's project rename is the only PATCH, in the API layer
        expect(source).not.toMatch(/'PATCH'/);
      }
    }
  });

  it('only GET/PUT/POST on the package, its draft, revisions and handoffs', () => {
    const api = sources.find(([file]) => file === 'content-studio.api.ts')![1];
    const workspaceApi = api.slice(
      api.indexOf('export const useContentStudioWorkspaceApi')
    );
    expect(
      Array.from(workspaceApi.matchAll(/method: '([A-Z]+)'/g)).map((m) => m[1])
    ).toEqual(['PUT', 'POST', 'POST']);
    expect(workspaceApi).not.toMatch(
      /\/revisions\/[^`]*\/(restore|update|delete)/
    );
  });

  it('the route renders the workspace; the placeholder is gone', () => {
    const page = readFileSync(
      join(__dirname, '../../app/(app)/(site)/content-studio/[id]/page.tsx'),
      'utf8'
    );
    // P5-06: with the exact version a review links to; P8-03: and the
    // research sources a research link names, as the link's text only
    expect(page).toMatch(
      /<ContentStudioWorkspace\s+key=\{id\}\s+packageId=\{id\}\s+linkedRevisionId=\{linked\}\s+researchSources=\{research\}\s+\/>/
    );
    expect(page).toContain(
      "const research = typeof sources === 'string' ? sources : undefined;"
    );
    expect(page).not.toMatch(/fetch|Placeholder/);
  });
});

// P5-07: where the policy requires approval before handoff, the server says
// so with each revision it shows, and decides again on every handoff
describe('workspace: handoff where approval is required (P5-07)', () => {
  const statusOf = (id: string, approved: boolean) => ({
    targetType: 'PACKAGE_REVISION',
    targetRevisionId: id,
    targetRevisionNumber: 1,
    targetContentHash: 'h'.repeat(64),
    approved,
    state: approved ? 'APPROVED' : 'PENDING_APPROVAL',
    reviewId: 'review-1',
    approvalVersion: approved ? 1 : 0,
    currentDecision: null,
  });
  // the revision detail, with what the server says about its approval
  let shown: { approved: boolean; required?: boolean };
  const serveDetail = () => {
    const previous = override;
    override = (m, url, body) => {
      const match =
        m === 'GET' &&
        url
          .split('?')[0]
          .match(/^\/content-studio\/packages\/pkg-1\/revisions\/([^/]+)$/);
      if (match) {
        const base = handle(m, url, body);
        return {
          ...base,
          json: async () => ({
            ...((await base.json()) as object),
            approval: statusOf(match[1], shown.approved),
            ...(shown.required === undefined
              ? {}
              : { handoffApprovalRequired: shown.required }),
          }),
        };
      }
      return previous(m, url, body);
    };
  };
  const refuseHandoff = (code: string, status = 409) => {
    const previous = override;
    override = (m, url, body) =>
      m === 'POST' && url.endsWith('/handoffs')
        ? reply(status, { msg: `server text ${PKG}`, code })
        : previous(m, url, body);
  };
  const viewRevision = async () => {
    await click('History');
    const dialog = screen.getByRole('dialog', { name: 'History' });
    await click('View 1', dialog);
    return dialog;
  };
  const MUST = 'This revision must be approved before handoff.';

  it.each([
    ['not said', undefined],
    ['false', false],
  ])(
    'FH1 without the requirement (%s) the history is exactly as before: no Use in Post on a version',
    async (_name, required) => {
      shown = { approved: false, required };
      addRevision(1);
      serveDetail();
      await renderWorkspace();
      const dialog = await viewRevision();
      expect(
        within(dialog).queryByRole('button', { name: 'Use in Post' })
      ).toBeNull();
      expect(dialog.textContent).not.toContain(MUST);
    }
  );

  it('FH2 an approved version can be used in a post: exactly that revision is handed off', async () => {
    shown = { approved: true, required: true };
    addRevision(1);
    addRevision(2);
    serveDetail();
    await renderWorkspace();
    const dialog = await viewRevision();
    const use = button('Use in Post', dialog) as HTMLButtonElement;
    expect(use.disabled).toBe(false);
    expect(dialog.textContent).not.toContain(MUST);
    await click('Use in Post', dialog);
    // the older version itself, never a new revision of the draft
    expect(revisionPosts()).toHaveLength(0);
    expect(handoffPosts().map((c) => c.url)).toEqual([
      `${BASE}/revisions/rev-1/handoffs`,
    ]);
    expect(mockRouter.push).toHaveBeenCalledWith(
      `/launches?handoff=${HANDOFF}`
    );
    expect(screen.queryByRole('dialog', { name: 'History' })).toBeNull();
  });

  it('FH3/FH4 a version that is not approved cannot be used in a post, and says why in words', async () => {
    shown = { approved: false, required: true };
    addRevision(1);
    serveDetail();
    await renderWorkspace();
    const dialog = await viewRevision();
    expect((button('Use in Post', dialog) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(dialog.textContent).toContain(MUST);
    expect(handoffPosts()).toHaveLength(0);
  });

  it("FH5 Use in Post refused for its approval: a fixed message and the exact version's review one click away", async () => {
    shown = { approved: false, required: true };
    serveDetail();
    refuseHandoff('CS_APPROVAL_REQUIRED');
    await renderWorkspace();
    await click('Use in Post');
    expect(toasts()).toEqual([MUST]);
    expect(mockRouter.push).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(MUST);
    expect(alert.textContent).not.toContain(PKG);
    expect(box('Post')).toHaveProperty('disabled', false);
    await click('Open review', alert);
    const dialog = screen.getByRole('dialog', { name: 'History' });
    await settle();
    // the revision the handoff was refused for, exactly
    expect(of('GET', `${BASE}/revisions/rev-1`).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/^Version 1$/)).toBeTruthy();
  });

  it('FH6 a version shown approved but no longer approved: the server refuses, the message is fixed and the version is read again', async () => {
    shown = { approved: true, required: true };
    addRevision(1);
    serveDetail();
    refuseHandoff('CS_APPROVAL_REQUIRED');
    await renderWorkspace();
    const dialog = await viewRevision();
    const before = of('GET', `${BASE}/revisions/rev-1`).length;
    shown = { approved: false, required: true };
    await click('Use in Post', dialog);
    await settle();
    expect(toasts()).toEqual([MUST]);
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(of('GET', `${BASE}/revisions/rev-1`).length).toBeGreaterThan(before);
    expect((button('Use in Post', dialog) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it.each([
    'CS_REVIEW_INTEGRITY_ERROR',
    'CS_APPROVAL_INTEGRITY_ERROR',
    'CS_PROFILE_INTEGRITY_ERROR',
  ])(
    'FH7/M16 %s is not "needs approval": the revision could not be verified',
    async (code) => {
      refuseHandoff(code, 500);
      await renderWorkspace();
      await click('Use in Post');
      expect(toasts()).toEqual([
        'This revision could not be verified for handoff.',
      ]);
      expect(document.body.textContent).not.toContain(MUST);
      expect(screen.queryByRole('button', { name: 'Open review' })).toBeNull();
    }
  );

  it('FH7 the same codes outside a handoff keep their own message: a restore is never about approval', async () => {
    addRevision(1);
    override = (m, url) =>
      m === 'GET' && url.split('?')[0] === `${BASE}/revisions/rev-1`
        ? reply(500, { code: 'CS_REVIEW_INTEGRITY_ERROR' })
        : undefined;
    await renderWorkspace();
    await click('History');
    const dialog = screen.getByRole('dialog', { name: 'History' });
    await click('Restore to draft 1', dialog);
    expect(toasts()).toEqual(['Could not restore this version.']);
  });

  it('an approval that kept changing asks to try again', async () => {
    refuseHandoff('CS_APPROVAL_CONFLICT');
    await renderWorkspace();
    await click('Use in Post');
    expect(toasts()).toEqual([
      'The approval of this revision changed. Try again.',
    ]);
  });

  it('M15/SEC2-SEC4 a handoff sends nothing about approval, and the editor never reads the policy', async () => {
    shown = { approved: true, required: true };
    addRevision(1);
    serveDetail();
    await renderWorkspace();
    const dialog = await viewRevision();
    await click('Use in Post', dialog);
    expect(handoffPosts().map((c) => c.body)).toEqual([undefined]);
    expect(calls().some((c) => c.url.includes('editorial-policy'))).toBe(false);
  });

  it('FH8 the normal Postiz composer and the handoff opener know nothing of approval', () => {
    const launches = join(__dirname, '..', 'launches');
    const list = (dir: string): string[] =>
      require('fs')
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((entry: { name: string; isDirectory: () => boolean }) =>
          entry.isDirectory()
            ? list(join(dir, entry.name))
            : /\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)
            ? [join(dir, entry.name)]
            : []
        );
    for (const file of list(launches)) {
      expect(readFileSync(file, 'utf8')).not.toMatch(
        /CS_APPROVAL|handoffApprovalRequired|requireApproval|editorial-policy/
      );
    }
  });
});
