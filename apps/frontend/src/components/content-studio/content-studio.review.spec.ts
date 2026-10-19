import { createElement as h } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { SWRConfig } from 'swr';
import { readFileSync } from 'fs';
import { join } from 'path';
import { TextEncoder as NodeTextEncoder } from 'util';

// Reviews in the browser (P5-01): the review card of one exact saved
// revision (state in words, the actions of that state, Request review), the
// requests it sends (target type and revision id only, a fixed action, no
// body), the package version view, and the design workspace (the shown saved
// revision, never the unsaved draft). A .spec.ts without JSX, like the other
// Content Studio frontend specs: components are required, not imported. The
// Fabric adapter is an inert stand-in
if (typeof (globalThis as any).TextEncoder === 'undefined') {
  (globalThis as any).TextEncoder = NodeTextEncoder;
}

jest.mock('next/link', () => {
  const { createElement } = require('react');
  return {
    __esModule: true,
    default: ({ href, prefetch, children, ...rest }: any) =>
      createElement('a', { href, ...rest }, children),
  };
});
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock('@gitroom/frontend/components/layout/new-modal', () => ({
  useModals: () => ({
    openModal: jest.fn(),
    closeAll: jest.fn(),
    closeById: jest.fn(),
    closeCurrent: jest.fn(),
  }),
}));
// the existing media library pulls in uploads: a stub
jest.mock('@gitroom/frontend/components/media/media.component', () => ({
  MediaBox: () => null,
}));
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
jest.mock('./content-studio.design.fabric', () => ({
  createContentStudioDesignFabric: () => ({
    sync: () => undefined,
    setView: () => undefined,
    dispose: () => undefined,
  }),
}));

const { ContentStudioReviewStatus } = require('./content-studio.review.status');
const {
  ContentStudioRevisionHistory,
} = require('./content-studio.revision.history');
const {
  ContentStudioDesignWorkspace,
} = require('./content-studio.design.workspace');

type Plain = Record<string, any>;
type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const SECRET = 'REVIEW_UI_SERVER_SECRET_789';
const T0 = '2026-10-19T10:00:00.000Z';
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PACKAGE = uuid(1);
const PKG_REV_4 = uuid(4);
const PKG_REV_5 = uuid(5);
const DESIGN = uuid(2);
const DESIGN_REV_1 = uuid(11);
const DESIGN_REV_2 = uuid(12);

// --- a small review server: one review per exact revision ---
let reviews: Plain[];
let counter: number;
let failNext: { status: number; code: string } | null;
const NEXT: Record<string, Record<string, string>> = {
  REQUESTED: { start: 'IN_REVIEW', cancel: 'CANCELLED' },
  IN_REVIEW: {
    'request-changes': 'CHANGES_REQUESTED',
    'ready-for-approval': 'READY_FOR_APPROVAL',
    cancel: 'CANCELLED',
  },
};
const reviewOf = (
  targetType: string,
  targetRevisionId: string,
  revisionNumber: number,
  state = 'REQUESTED'
) => ({
  id: uuid(100 + ++counter),
  targetType,
  targetRevisionId,
  targetRevisionNumber: revisionNumber,
  targetContentHash: SHA('c'),
  state,
  version: 1,
  requestedBy: { id: 'user-1', name: 'Ann' },
  createdAt: T0,
  updatedAt: T0,
  events: [
    {
      sequence: 1,
      fromState: null,
      toState: 'REQUESTED',
      actor: { id: 'user-1', name: 'Ann' },
      createdAt: T0,
    },
  ],
});
const numberOf: Record<string, number> = {
  [PKG_REV_4]: 4,
  [PKG_REV_5]: 5,
  [DESIGN_REV_1]: 1,
  [DESIGN_REV_2]: 2,
};

const doc = (color: string) => ({
  schemaVersion: 1,
  brandKit: null,
  pages: [
    {
      id: 'p_one',
      name: 'Cover',
      width: 1080,
      height: 1080,
      background: { type: 'solid', color: { type: 'literal', value: color } },
      layers: [],
    },
  ],
});
const designRevisions = () => [
  { id: DESIGN_REV_1, revisionNumber: 1, content: doc('#ffffff') },
  { id: DESIGN_REV_2, revisionNumber: 2, content: doc('#000000') },
];
const designMeta = (r: Plain) => ({
  id: r.id,
  revisionNumber: r.revisionNumber,
  schemaVersion: 1,
  contentHash: SHA(String(r.revisionNumber)),
  createdAt: T0,
});
const packageRevision = (id: string, n: number) => ({
  id,
  revisionNumber: n,
  contentHash: SHA(String(n)),
  origin: 'manual',
  sourceDraftVersion: n,
  createdAt: T0,
  createdBy: { id: 'user-1', name: 'Ann' },
});

const server = (method: string, url: string, body: any): Reply => {
  const { pathname, searchParams } = new URL(url, 'https://api.test');
  if (pathname === '/content-studio/reviews') {
    if (failNext) {
      const failure = failNext;
      failNext = null;
      return reply(failure.status, { msg: SECRET, code: failure.code });
    }
    if (method === 'GET') {
      const results = reviews.filter(
        (r) =>
          (!searchParams.get('targetType') ||
            r.targetType === searchParams.get('targetType')) &&
          (!searchParams.get('targetRevisionId') ||
            r.targetRevisionId === searchParams.get('targetRevisionId'))
      );
      return reply(200, { pages: 1, results });
    }
    if (
      reviews.some(
        (r) =>
          r.targetType === body.targetType &&
          r.targetRevisionId === body.targetRevisionId
      )
    ) {
      return reply(409, { msg: SECRET, code: 'CS_REVIEW_ALREADY_EXISTS' });
    }
    const created = reviewOf(
      body.targetType,
      body.targetRevisionId,
      numberOf[body.targetRevisionId]
    );
    reviews.push(created);
    return reply(201, created);
  }
  const rm = pathname.match(/^\/content-studio\/reviews\/([^/]+)\/([a-z-]+)$/);
  if (rm && method === 'POST') {
    if (failNext) {
      const failure = failNext;
      failNext = null;
      return reply(failure.status, { msg: SECRET, code: failure.code });
    }
    const review = reviews.find((r) => r.id === rm[1]);
    const next = review && NEXT[review.state]?.[rm[2]];
    if (!review) return reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
    if (!next) {
      return reply(409, { msg: SECRET, code: 'CS_REVIEW_INVALID_TRANSITION' });
    }
    review.events = [
      ...review.events,
      {
        sequence: review.version + 1,
        fromState: review.state,
        toState: next,
        actor: { id: 'user-2', name: 'Bo' },
        createdAt: T0,
      },
    ];
    review.state = next;
    review.version += 1;
    return reply(200, review);
  }
  // package versions
  if (pathname === `/content-studio/packages/${PACKAGE}/revisions`) {
    return reply(200, {
      pages: 1,
      results: [packageRevision(PKG_REV_5, 5), packageRevision(PKG_REV_4, 4)],
    });
  }
  const pm = pathname.match(
    new RegExp(`^/content-studio/packages/${PACKAGE}/revisions/([^/]+)$`)
  );
  if (pm && numberOf[pm[1]]) {
    return reply(200, {
      ...packageRevision(pm[1], numberOf[pm[1]]),
      schemaVersion: 1,
      packageId: PACKAGE,
      content: {
        copy: {
          global: {
            thread: [{ id: 'i1', text: `Text ${pm[1]}`, mediaIds: [] }],
          },
        },
      },
      media: {},
    });
  }
  // the design
  const revisions = designRevisions();
  const last = revisions[revisions.length - 1];
  if (pathname === `/content-studio/designs/${DESIGN}`) {
    return reply(200, {
      id: DESIGN,
      name: 'Launch',
      latestRevisionNumber: revisions.length,
      archivedAt: null,
      createdAt: T0,
      updatedAt: T0,
      currentRevision: { ...designMeta(last), content: last.content },
    });
  }
  if (pathname === `/content-studio/designs/${DESIGN}/revisions`) {
    return reply(200, {
      pages: 1,
      results: [...revisions].reverse().map(designMeta),
    });
  }
  const dm = pathname.match(
    new RegExp(`^/content-studio/designs/${DESIGN}/revisions/([^/]+)$`)
  );
  if (dm) {
    const revision = revisions.find((r) => r.id === dm[1]);
    if (revision) {
      return reply(200, { ...designMeta(revision), content: revision.content });
    }
  }
  return reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
};

beforeEach(() => {
  reviews = [];
  counter = 0;
  failNext = null;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) =>
    server(
      init.method || 'GET',
      url,
      init.body ? JSON.parse(init.body as string) : undefined
    )
  );
  mockToast.mockReset();
});
afterEach(() => {
  expect(document.body.textContent).not.toContain(SECRET);
  cleanup();
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
const show = async (element: ReturnType<typeof h>) => {
  const cache = new Map();
  render(
    h(
      SWRConfig,
      { value: { provider: () => cache, dedupingInterval: 0 } },
      element
    )
  );
  await flush();
};
const click = async (element: HTMLElement) => {
  fireEvent.click(element);
  await flush();
};
const card = () =>
  screen.getByRole('region', { name: 'Review' }) as HTMLElement;
const buttons = () =>
  within(card())
    .queryAllByRole('button')
    .map((b) => b.textContent);
const button = (name: string) =>
  within(card()).getByRole('button', { name }) as HTMLButtonElement;
const state = () => within(card()).getByRole('status').textContent;
const calls = () =>
  mockFetch.mock.calls.map(([url, init]) => ({
    method: (init?.method as string) || 'GET',
    url: url as string,
    body: init?.body as string | undefined,
  }));
const reviewCalls = () =>
  calls().filter((c) => c.url.startsWith('/content-studio/reviews'));
const writes = () => reviewCalls().filter((c) => c.method !== 'GET');
const showCard = (props: Plain = {}) =>
  show(
    h(ContentStudioReviewStatus, {
      targetType: 'DESIGN_REVISION',
      revisionId: DESIGN_REV_1,
      revisionNumber: 1,
      ...props,
    })
  );

describe('Review card', () => {
  it('RF2/RF6 no review: the exact revision in words, "No review yet" and Request review only', async () => {
    await showCard({ revisionNumber: 7 });
    expect(card().textContent).toContain('Review · Revision 7');
    expect(state()).toBe('No review yet');
    expect(
      card()
        .querySelector('[data-review-state]')!
        .getAttribute('data-review-state')
    ).toBe('NONE');
    expect(buttons()).toEqual(['Request review']);
    expect(card().textContent).toContain(
      'This review applies to saved revision 7.'
    );
    // loaded for exactly this revision, nothing else
    expect(reviewCalls()).toEqual([
      {
        method: 'GET',
        url: `/content-studio/reviews?targetType=DESIGN_REVISION&targetRevisionId=${DESIGN_REV_1}`,
        body: undefined,
      },
    ]);
  });

  it('RF8-RF12 Request review sends the target type and the revision id only', async () => {
    await showCard();
    await click(button('Request review'));
    expect(writes()).toEqual([
      {
        method: 'POST',
        url: '/content-studio/reviews',
        body: JSON.stringify({
          targetType: 'DESIGN_REVISION',
          targetRevisionId: DESIGN_REV_1,
        }),
      },
    ]);
    const sent = JSON.parse(writes()[0].body!);
    expect(Object.keys(sent).sort()).toEqual([
      'targetRevisionId',
      'targetType',
    ]);
    expect(writes()[0].body).not.toMatch(
      /organization|userId|requestedBy|actor|contentHash|targetContentHash|state|latest/i
    );
    // the card reloads and shows the new review
    expect(state()).toBe('Review requested');
  });

  it('RF1/RF3 REQUESTED: the state in words, Start review and Cancel review', async () => {
    reviews.push(reviewOf('DESIGN_REVISION', DESIGN_REV_1, 1));
    await showCard();
    expect(state()).toBe('Review requested');
    expect(buttons()).toEqual(['Start review', 'Cancel review']);
    expect(
      within(card()).queryByRole('button', { name: 'Ready for approval' })
    ).toBeNull();
    expect(
      within(card()).queryByRole('button', { name: 'Request review' })
    ).toBeNull();
  });

  it('RF4 IN_REVIEW: Request changes, Ready for approval and Cancel review; each action is its own route with no body', async () => {
    reviews.push(reviewOf('DESIGN_REVISION', DESIGN_REV_1, 1));
    const id = reviews[0].id;
    await showCard();
    await click(button('Start review'));
    expect(state()).toBe('In review');
    expect(buttons()).toEqual([
      'Request changes',
      'Ready for approval',
      'Cancel review',
    ]);
    await click(button('Ready for approval'));
    expect(state()).toBe('Ready for approval');
    expect(card().textContent).toContain(
      'Ready for approval is not an approval.'
    );
    expect(writes()).toEqual([
      {
        method: 'POST',
        url: `/content-studio/reviews/${id}/start`,
        body: undefined,
      },
      {
        method: 'POST',
        url: `/content-studio/reviews/${id}/ready-for-approval`,
        body: undefined,
      },
    ]);
  });

  it.each([
    ['CHANGES_REQUESTED', 'Changes requested'],
    ['READY_FOR_APPROVAL', 'Ready for approval'],
    ['CANCELLED', 'Cancelled'],
  ])(
    'RF5 %s is final: its words and no action at all',
    async (final, words) => {
      reviews.push(reviewOf('DESIGN_REVISION', DESIGN_REV_1, 1, final));
      await showCard();
      expect(state()).toBe(words);
      expect(buttons()).toEqual([]);
    }
  );

  it('the state history is a compact disclosure, in words', async () => {
    reviews.push(reviewOf('DESIGN_REVISION', DESIGN_REV_1, 1));
    await showCard();
    await click(button('Start review'));
    await click(button('Request changes'));
    const items = Array.from(card().querySelectorAll('details li')).map(
      (li) => li.textContent
    );
    expect(items).toHaveLength(3);
    expect(items[0]).toMatch(/^Review requested · Ann · /);
    expect(items[1]).toMatch(/^In review · Bo · /);
    expect(items[2]).toMatch(/^Changes requested · Bo · /);
  });

  it('RF7 unsaved changes are not part of the review: the card says so and Request review waits for a save', async () => {
    await showCard({ unsaved: true });
    expect(card().textContent).toContain(
      'Unsaved changes are not part of this review.'
    );
    expect(button('Request review').disabled).toBe(true);
    fireEvent.click(button('Request review'));
    await flush();
    expect(writes()).toEqual([]);
    // an existing review can still move on: it is about the saved revision
    reviews.push(reviewOf('DESIGN_REVISION', DESIGN_REV_2, 2));
    cleanup();
    await showCard({
      revisionId: DESIGN_REV_2,
      revisionNumber: 2,
      unsaved: true,
    });
    expect(button('Start review').disabled).toBe(false);
  });

  it.each([
    ['CS_REVIEW_ALREADY_EXISTS', 409, 'This revision already has a review.'],
    [
      'CS_REVIEW_CONFLICT',
      409,
      'This review has changed. Check its current state and try again.',
    ],
    [
      'CS_REVIEW_INVALID_TRANSITION',
      409,
      'This review has changed. Check its current state and try again.',
    ],
    [
      'CS_REVIEW_TARGET_NOT_FOUND',
      404,
      'The revision to review is no longer available.',
    ],
    [
      'CS_REVIEW_INTEGRITY_ERROR',
      500,
      'Stored review data could not be read safely.',
    ],
    ['CS_SOMETHING', 500, 'The review action could not be completed.'],
  ])(
    'a failed action (%s) shows a fixed message, never the server text',
    async (code, status, message) => {
      reviews.push(reviewOf('DESIGN_REVISION', DESIGN_REV_1, 1));
      await showCard();
      failNext = { status, code };
      await click(button('Start review'));
      expect(mockToast).toHaveBeenCalledWith(message, 'warning');
    }
  );

  it('a load failure is a fixed message; a review that is not about this revision is refused', async () => {
    failNext = { status: 500, code: 'CS_SOMETHING' };
    await showCard();
    expect(card().querySelector('[data-review-error]')!.textContent).toBe(
      'Review status could not be loaded.'
    );
    expect(buttons()).toEqual([]);
    cleanup();
    // the server answers with another revision's review: never shown as this one's
    mockFetch.mockImplementation(async () =>
      reply(200, {
        pages: 1,
        results: [reviewOf('DESIGN_REVISION', DESIGN_REV_2, 2)],
      })
    );
    await showCard();
    expect(card().querySelector('[data-review-error]')!.textContent).toBe(
      'Stored review data could not be read safely.'
    );
    expect(buttons()).toEqual([]);
  });
});

describe('Package version review', () => {
  const history = () =>
    show(
      h(ContentStudioRevisionHistory, {
        packageId: PACKAGE,
        canRestore: true,
        onRestore: async () => true,
        close: () => undefined,
      })
    );
  const view = async (n: number) =>
    click(screen.getByRole('button', { name: `View ${n}` }));

  it('the history list loads no review; viewing a version shows the review of exactly that version', async () => {
    await history();
    expect(reviewCalls()).toEqual([]);
    await view(4);
    expect(card().getAttribute('data-review-target')).toBe('PACKAGE_REVISION');
    expect(card().getAttribute('data-review-revision')).toBe(PKG_REV_4);
    expect(card().textContent).toContain('Review · Version 4');
    expect(card().textContent).toContain(
      'This review applies to saved version 4.'
    );
    await click(button('Request review'));
    expect(JSON.parse(writes()[0].body!)).toEqual({
      targetType: 'PACKAGE_REVISION',
      targetRevisionId: PKG_REV_4,
    });
  });

  it('RF13/NR1-NR4 each version shows its own review; changes requested on 4 marks nothing on 5', async () => {
    reviews.push(
      reviewOf('PACKAGE_REVISION', PKG_REV_4, 4, 'CHANGES_REQUESTED')
    );
    await history();
    await view(4);
    expect(state()).toBe('Changes requested');
    expect(buttons()).toEqual([]);
    await click(screen.getByRole('button', { name: 'Back to history' }));
    await view(5);
    expect(card().getAttribute('data-review-revision')).toBe(PKG_REV_5);
    expect(state()).toBe('No review yet');
    await click(button('Request review'));
    expect(state()).toBe('Review requested');
    expect(reviews.map((r) => [r.targetRevisionId, r.state])).toEqual([
      [PKG_REV_4, 'CHANGES_REQUESTED'],
      [PKG_REV_5, 'REQUESTED'],
    ]);
  });
});

describe('Design revision review', () => {
  const open = () =>
    show(h(ContentStudioDesignWorkspace, { designId: DESIGN }));

  it('the workspace shows the review of the current saved revision, by its id', async () => {
    await open();
    expect(card().getAttribute('data-review-target')).toBe('DESIGN_REVISION');
    expect(card().getAttribute('data-review-revision')).toBe(DESIGN_REV_2);
    expect(card().textContent).toContain('Review · Revision 2');
    expect(reviewCalls().map((c) => c.url)).toEqual([
      `/content-studio/reviews?targetType=DESIGN_REVISION&targetRevisionId=${DESIGN_REV_2}`,
    ]);
  });

  it('RF13 an opened historical revision shows its own review', async () => {
    reviews.push(reviewOf('DESIGN_REVISION', DESIGN_REV_1, 1, 'CANCELLED'));
    await open();
    expect(state()).toBe('No review yet');
    await click(screen.getByRole('button', { name: 'View Revision 1' }));
    expect(card().getAttribute('data-review-revision')).toBe(DESIGN_REV_1);
    expect(card().textContent).toContain('Review · Revision 1');
    expect(state()).toBe('Cancelled');
  });

  it('RF7/M24 while the draft has unsaved changes, the review stays on the saved revision and says so', async () => {
    await open();
    await click(screen.getByRole('button', { name: 'Edit design' }));
    expect(card().querySelector('[data-review-unsaved]')).toBeNull();
    await click(screen.getByRole('button', { name: 'Add text' }));
    expect(card().getAttribute('data-review-revision')).toBe(DESIGN_REV_2);
    expect(card().querySelector('[data-review-unsaved]')).not.toBeNull();
    expect(button('Request review').disabled).toBe(true);
    // clicking review saves nothing
    expect(calls().filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('Review UI boundaries', () => {
  const read = (file: string) =>
    readFileSync(join(__dirname, file), 'utf8').replace(/\/\/.*$/gm, '');

  it('RF9-RF12/M21/M22 the API module never sends an organization, a user, a hash or a state', () => {
    const api = read('content-studio.reviews.api.ts');
    const bodies = Array.from(
      api.matchAll(/body: JSON\.stringify\(\{([^}]*)\}\)/g),
      (m) => m[1].replace(/\s+/g, ' ').trim()
    );
    expect(bodies).toEqual(['targetType, targetRevisionId: revisionId,']);
    const writes = api.slice(
      api.indexOf('export const useContentStudioReviewActions'),
      api.indexOf('export const reviewErrorMessage')
    );
    expect(writes).toContain("method: 'POST'");
    expect(writes).not.toMatch(
      /organization|userId|user:|contentHash|state|version|latest/i
    );
  });

  it('M23 the actions offered come from the shared state machine, not from the component', () => {
    const status = read('content-studio.review.status.tsx');
    expect(status).toContain('contentStudioReviewActions(current.state)');
    expect(status).not.toMatch(/state === 'REQUESTED'|state === 'IN_REVIEW'/);
  });

  it('the package version view and the design workspace bind the review to the exact shown revision', () => {
    expect(read('content-studio.revision.history.tsx')).toMatch(
      /targetType="PACKAGE_REVISION"\s+revisionId=\{revision\.id\}\s+revisionNumber=\{revision\.revisionNumber\}/
    );
    expect(read('content-studio.design.workspace.tsx')).toMatch(
      /targetType="DESIGN_REVISION"\s+revisionId=\{shown\.id\}\s+revisionNumber=\{shown\.revisionNumber\}\s+unsaved=\{editing && editor\.dirty\}/
    );
  });
});
