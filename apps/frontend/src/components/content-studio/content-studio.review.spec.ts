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
// revision, never the unsaved draft). P5-02: the discussion (comments on
// demand, the author's own edit), Request changes with its required text,
// the revision request and its resolution by a saved newer revision only. A .spec.ts without JSX, like the other
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
// the signed-in member: user-1 (Ann)
jest.mock('@gitroom/frontend/components/layout/user.context', () => ({
  useUser: () => ({ id: 'user-1' }),
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
  // a copy, as a real response is: never the server's own object
  json: async () => JSON.parse(JSON.stringify(body)),
});
const SECRET = 'REVIEW_UI_SERVER_SECRET_789';
const T0 = '2026-10-19T10:00:00.000Z';
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PACKAGE = uuid(1);
const PKG_REV_3 = uuid(3);
const PKG_REV_4 = uuid(4);
const PKG_REV_5 = uuid(5);
const DESIGN = uuid(2);
const DESIGN_REV_1 = uuid(11);
const DESIGN_REV_2 = uuid(12);

// --- a small review server: one review per exact revision ---
let reviews: Plain[];
let counter: number;
let failNext: { status: number; code: string } | null;
let comments: Record<string, Plain[]>;
let revisionRequests: Record<string, Plain>;
let extraDesignRevisions: Plain[];
// P5-03B: the claims of each package review, as the server answers them
let claimLists: Record<string, Plain>;
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
  [PKG_REV_3]: 3,
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
  ...extraDesignRevisions,
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

const openRequest = (text: string) => ({
  id: uuid(900 + ++counter),
  body: text,
  status: 'OPEN',
  requestedBy: { id: 'user-2', name: 'Bo' },
  createdAt: T0,
  resolution: null,
});

const claimOf = (
  id: string,
  text: string,
  status = 'UNREVIEWED',
  finding: string | null = null
) => ({
  claimId: id,
  threadItemId: 'i1',
  claimText: text,
  claimContentHash: SHA('a'),
  status,
  finding,
  reviewedBy: status === 'UNREVIEWED' ? null : { id: 'user-2', name: 'Bo' },
  reviewedAt: status === 'UNREVIEWED' ? null : T0,
  evidence: [
    {
      source: { id: uuid(700), name: 'Weekly report' },
      version: {
        id: uuid(701),
        versionNumber: 2,
        title: 'Spring report',
        contentHash: SHA('b'),
        fetchedAt: T0,
      },
      block: { id: 'b1', type: 'paragraph', text: `Block of ${id}.` },
      quote: `quote of ${id}`,
    },
  ],
});
const claimListOf = (review: Plain, claims: Plain[]) => {
  const verified = claims.filter((c) => c.status === 'VERIFIED').length;
  const needsRevision = claims.filter(
    (c) => c.status === 'NEEDS_REVISION'
  ).length;
  return {
    reviewId: review.id,
    reviewState: review.state,
    reviewVersion: review.version,
    summary: {
      total: claims.length,
      verified,
      needsRevision,
      unreviewed: claims.length - verified - needsRevision,
      complete: verified === claims.length,
    },
    claims,
  };
};

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
  // claim review (P5-03B)
  const km = pathname.match(
    /^\/content-studio\/reviews\/([^/]+)\/claims(?:\/([^/]+))?$/
  );
  if (km) {
    if (failNext) {
      const failure = failNext;
      failNext = null;
      return reply(failure.status, { msg: SECRET, code: failure.code });
    }
    const review = reviews.find((r) => r.id === km[1]);
    if (!review) return reply(404, { msg: SECRET, code: 'CS_NOT_FOUND' });
    if (review.targetType !== 'PACKAGE_REVISION') {
      return reply(409, { msg: SECRET, code: 'CS_REVIEW_CLAIMS_UNAVAILABLE' });
    }
    const list = claimLists[review.id] ?? claimListOf(review, []);
    if (method === 'PUT') {
      if (review.state !== 'IN_REVIEW') {
        return reply(409, {
          msg: SECRET,
          code: 'CS_REVIEW_CLAIM_MUTATION_FORBIDDEN',
        });
      }
      const claim = list.claims.find((c: Plain) => c.claimId === km[2]);
      if (!claim) {
        return reply(404, { msg: SECRET, code: 'CS_REVIEW_CLAIM_NOT_FOUND' });
      }
      claim.status = body.status;
      claim.finding = body.finding;
      claim.reviewedBy =
        body.status === 'UNREVIEWED' ? null : { id: 'user-1', name: 'Ann' };
      claim.reviewedAt = body.status === 'UNREVIEWED' ? null : T0;
      claimLists[review.id] = claimListOf(review, list.claims);
    }
    return reply(200, claimLists[review.id] ?? list);
  }
  // the discussion (P5-02)
  const cm = pathname.match(
    /^\/content-studio\/reviews\/([^/]+)\/comments(?:\/([^/]+))?$/
  );
  if (cm) {
    if (failNext) {
      const failure = failNext;
      failNext = null;
      return reply(failure.status, { msg: SECRET, code: failure.code });
    }
    const list = (comments[cm[1]] = comments[cm[1]] ?? []);
    if (method === 'GET') {
      return reply(200, { pages: 1, results: list });
    }
    if (method === 'POST') {
      const created = {
        id: uuid(500 + ++counter),
        body: body.body,
        author: { id: 'user-1', name: 'Ann' },
        createdAt: T0,
        editedAt: null,
      };
      list.push(created);
      return reply(201, created);
    }
    const comment = list.find((c) => c.id === cm[2]);
    if (!comment) {
      return reply(404, { msg: SECRET, code: 'CS_REVIEW_COMMENT_NOT_FOUND' });
    }
    if (comment.author.id !== 'user-1') {
      return reply(403, { msg: SECRET, code: 'CS_REVIEW_COMMENT_FORBIDDEN' });
    }
    comment.body = body.body;
    comment.editedAt = T0;
    return reply(200, comment);
  }
  const qm = pathname.match(
    /^\/content-studio\/reviews\/([^/]+)\/revision-request(\/resolve)?$/
  );
  if (qm) {
    if (failNext) {
      const failure = failNext;
      failNext = null;
      return reply(failure.status, { msg: SECRET, code: failure.code });
    }
    const current = revisionRequests[qm[1]];
    if (!current) {
      return reply(404, {
        msg: SECRET,
        code: 'CS_REVIEW_REVISION_REQUEST_NOT_FOUND',
      });
    }
    if (method === 'POST') {
      current.status = 'RESOLVED';
      current.resolution = {
        revisionId: body.resolutionRevisionId,
        revisionNumber: numberOf[body.resolutionRevisionId] ?? 3,
        contentHash: SHA('e'),
        resolvedBy: { id: 'user-2', name: 'Bo' },
        resolvedAt: T0,
      };
    }
    return reply(200, current);
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
    if (rm[2] === 'request-changes') {
      revisionRequests[review.id] = openRequest(body.body);
    }
    return reply(200, review);
  }
  // package versions
  if (pathname === `/content-studio/packages/${PACKAGE}/revisions`) {
    return reply(200, {
      pages: 1,
      results: [
        packageRevision(PKG_REV_5, 5),
        packageRevision(PKG_REV_4, 4),
        packageRevision(PKG_REV_3, 3),
      ],
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
  comments = {};
  revisionRequests = {};
  extraDesignRevisions = [];
  claimLists = {};
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
// the review actions: the discussion toggle (P5-02) is not one of them
const buttons = () =>
  within(card())
    .queryAllByRole('button')
    .map((b) => b.textContent)
    .filter((name) => !/^(Show|Hide) (discussion|claims)$/.test(name ?? ''));
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
const textbox = (name: string) =>
  within(card()).getByRole('textbox', { name }) as HTMLTextAreaElement;
const type = (name: string, value: string) =>
  fireEvent.change(textbox(name), { target: { value } });
// fills in the Request changes form and sends it
const ask = async (text: string) => {
  type('What needs to change?', text);
  await click(button('Send revision request'));
};
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
    await ask('Shorter intro.');
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
    expect(bodies).toEqual([
      'targetType, targetRevisionId: revisionId,',
      'body',
      'body',
      'body',
      'status, finding',
      'resolutionRevisionId',
    ]);
    // a claim assessment sends its status and finding (P5-03B), nothing else
    const writes = api
      .slice(
        api.indexOf('export const useContentStudioReviewActions'),
        api.indexOf('export const reviewErrorMessage')
      )
      .replace(/assessClaim: async \([\s\S]*?\n      \},\n/, '');
    expect(writes).toContain("method: 'POST'");
    expect(writes).not.toMatch(
      /organization|userId|user:|authorUserId|resolvedBy|contentHash|state|status|version|latest|DELETE/i
    );
    // P502-6 the only edit is PATCH of a comment; there is no delete
    expect(api.match(/method: '(PATCH|PUT|DELETE)'/g)).toEqual([
      "method: 'PATCH'",
      "method: 'PUT'",
    ]);
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

// --- P5-02: the discussion in the browser ---

const seedReview = (
  state: string,
  targetType = 'DESIGN_REVISION',
  revisionId = DESIGN_REV_1,
  revisionNumber = 1
) => {
  const review = reviewOf(targetType, revisionId, revisionNumber, state);
  reviews.push(review);
  return review;
};
const comment = (id: number, author: Plain, text: string, edited = false) => ({
  id: uuid(700 + id),
  body: text,
  author,
  createdAt: T0,
  editedAt: edited ? T0 : null,
});
const ANN = { id: 'user-1', name: 'Ann' };
const BO = { id: 'user-2', name: 'Bo' };
const discussionCalls = () =>
  reviewCalls().filter((c) => /\/comments/.test(c.url));
const panel = () =>
  within(card()).getByRole('region', { name: 'Revision request' });
const radios = () =>
  within(card())
    .queryAllByRole('radio')
    .map((r) => (r.closest('label') as HTMLElement).textContent);

describe('Review discussion', () => {
  it('FC1 comments load only for an existing review, and only once the discussion is opened', async () => {
    await showCard();
    expect(
      within(card()).queryByRole('button', { name: 'Show discussion' })
    ).toBeNull();
    expect(discussionCalls()).toEqual([]);
    cleanup();
    const review = seedReview('IN_REVIEW');
    await showCard();
    expect(discussionCalls()).toEqual([]);
    const toggle = button('Show discussion');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await click(toggle);
    expect(discussionCalls()).toEqual([
      {
        method: 'GET',
        url: `/content-studio/reviews/${review.id}/comments?page=1`,
        body: undefined,
      },
    ]);
    expect(button('Hide discussion').getAttribute('aria-expanded')).toBe(
      'true'
    );
    expect(card().textContent).toContain('No comments yet.');
  });

  it('FC2/FC3 a comment shows its author, its text with line breaks kept, its time and "edited"', async () => {
    const review = seedReview('IN_REVIEW');
    comments[review.id] = [
      comment(1, BO, 'First line\n\n  indented second <b>line</b>'),
      comment(2, ANN, 'Fixed it', true),
    ];
    await showCard();
    await click(button('Show discussion'));
    const items = Array.from(
      card().querySelectorAll('[data-review-comment]')
    ) as HTMLElement[];
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Bo');
    expect(items[0].textContent).toContain('Oct 19, 2026');
    const text = items[0].querySelector('[data-comment-body]') as HTMLElement;
    expect(text.textContent).toBe(
      'First line\n\n  indented second <b>line</b>'
    );
    expect(text.className).toContain('whitespace-pre-wrap');
    // plain text, never markup
    expect(text.querySelector('b')).toBeNull();
    expect(items[0].querySelector('[data-comment-edited]')).toBeNull();
    expect(items[1].querySelector('[data-comment-edited]')!.textContent).toBe(
      'edited'
    );
  });

  it('FC4 posting sends the text only; empty text cannot be posted; a comment moves no state', async () => {
    const review = seedReview('READY_FOR_APPROVAL');
    await showCard();
    await click(button('Show discussion'));
    expect(button('Post comment').disabled).toBe(true);
    type('Add a comment', '   \n ');
    expect(button('Post comment').disabled).toBe(true);
    type('Add a comment', 'Looks good.\nShip it.');
    await click(button('Post comment'));
    expect(writes()).toEqual([
      {
        method: 'POST',
        url: `/content-studio/reviews/${review.id}/comments`,
        body: JSON.stringify({ body: 'Looks good.\nShip it.' }),
      },
    ]);
    expect(textbox('Add a comment').value).toBe('');
    expect(card().textContent).toContain('Looks good.');
    expect(state()).toBe('Ready for approval');
    expect(reviews[0].state).toBe('READY_FOR_APPROVAL');
  });

  it('FC5 the author edits their own comment in place, sending the text only', async () => {
    const review = seedReview('IN_REVIEW');
    comments[review.id] = [comment(1, ANN, 'Frist')];
    await showCard();
    await click(button('Show discussion'));
    await click(button('Edit comment'));
    expect(textbox('Edit comment').value).toBe('Frist');
    type('Edit comment', 'First');
    await click(button('Save comment'));
    expect(writes()).toEqual([
      {
        method: 'PATCH',
        url: `/content-studio/reviews/${review.id}/comments/${uuid(701)}`,
        body: JSON.stringify({ body: 'First' }),
      },
    ]);
    const item = card().querySelector('[data-review-comment]') as HTMLElement;
    expect(item.querySelector('[data-comment-body]')!.textContent).toBe(
      'First'
    );
    expect(item.querySelector('[data-comment-edited]')).not.toBeNull();
  });

  it("FC6/FC7 another member's comment has no Edit, and nothing can be deleted", async () => {
    const review = seedReview('IN_REVIEW');
    comments[review.id] = [comment(1, BO, 'Theirs'), comment(2, ANN, 'Mine')];
    await showCard();
    await click(button('Show discussion'));
    const items = Array.from(
      card().querySelectorAll('[data-review-comment]')
    ) as HTMLElement[];
    expect(within(items[0]).queryByRole('button')).toBeNull();
    expect(
      within(items[1]).getByRole('button', { name: 'Edit comment' })
    ).toBeTruthy();
    expect(
      within(card()).queryAllByRole('button', { name: /delete|remove/i })
    ).toEqual([]);
  });

  it('FC8/40 a cancelled review shows its discussion read-only: no form, no edit', async () => {
    const review = seedReview('CANCELLED');
    comments[review.id] = [comment(1, ANN, 'Before the cancel')];
    await showCard();
    await click(button('Show discussion'));
    expect(card().textContent).toContain('Before the cancel');
    expect(within(card()).queryByRole('textbox')).toBeNull();
    expect(
      within(card()).queryByRole('button', { name: 'Edit comment' })
    ).toBeNull();
    expect(card().querySelector('[data-comments-closed]')!.textContent).toBe(
      'This review was cancelled: its discussion is closed.'
    );
  });

  it.each([
    [
      'CS_REVIEW_COMMENT_INVALID',
      400,
      'Write a comment of at most 10,000 characters.',
    ],
    ['CS_REVIEW_COMMENT_FORBIDDEN', 403, 'Only its author can edit a comment.'],
    [
      'CS_REVIEW_CANCELLED',
      409,
      'This review was cancelled: its discussion is closed.',
    ],
    ['CS_SOMETHING', 500, 'The review action could not be completed.'],
  ])(
    '67 a failed comment (%s) shows a fixed message and keeps the text',
    async (code, status, message) => {
      seedReview('IN_REVIEW');
      await showCard();
      await click(button('Show discussion'));
      type('Add a comment', 'Keep me');
      failNext = { status, code };
      await click(button('Post comment'));
      expect(mockToast).toHaveBeenCalledWith(message, 'warning');
      expect(textbox('Add a comment').value).toBe('Keep me');
    }
  );
});

describe('Request changes and the revision request', () => {
  it('FR1/FR2 Request changes opens a form that needs the text first; nothing is sent before', async () => {
    seedReview('IN_REVIEW');
    await showCard();
    await click(button('Request changes'));
    expect(button('Request changes').getAttribute('aria-expanded')).toBe(
      'true'
    );
    expect(textbox('What needs to change?').value).toBe('');
    expect(button('Send revision request').disabled).toBe(true);
    expect(card().textContent).toContain(
      'Describe what needs to change before sending the request.'
    );
    type('What needs to change?', '  \n\t ');
    expect(button('Send revision request').disabled).toBe(true);
    fireEvent.submit(
      card().querySelector('[data-request-changes-form]') as HTMLFormElement
    );
    await flush();
    expect(writes()).toEqual([]);
    // the other actions wait while the form is open
    expect(button('Ready for approval').disabled).toBe(true);
    await click(button('Cancel'));
    expect(card().querySelector('[data-request-changes-form]')).toBeNull();
    expect(writes()).toEqual([]);
  });

  it('FR3/FR4/FR5 sending it is one request with the text only; the review shows Changes requested and the open request', async () => {
    const review = seedReview('IN_REVIEW');
    await showCard();
    await click(button('Request changes'));
    type(
      'What needs to change?',
      'Change CTA to "Book a call".\nRemove the claim.'
    );
    await click(button('Send revision request'));
    expect(writes()).toEqual([
      {
        method: 'POST',
        url: `/content-studio/reviews/${review.id}/request-changes`,
        body: JSON.stringify({
          body: 'Change CTA to "Book a call".\nRemove the claim.',
        }),
      },
    ]);
    expect(state()).toBe('Changes requested');
    expect(card().querySelector('[data-request-changes-form]')).toBeNull();
    expect(panel().getAttribute('data-revision-request')).toBe('OPEN');
    expect(
      panel().querySelector('[data-revision-request-body]')!.textContent
    ).toBe('Change CTA to "Book a call".\nRemove the claim.');
    expect(
      panel().querySelector('[data-revision-request-status]')!.textContent
    ).toBe('Open');
    expect(panel().textContent).toContain('Bo');
    expect(panel().textContent).toContain('Oct 19, 2026');
  });

  it('a review with no recorded request says so; one of another state loads none', async () => {
    seedReview('CHANGES_REQUESTED');
    await showCard();
    expect(panel().textContent).toContain(
      'No revision request was recorded for this review.'
    );
    cleanup();
    reviews = [];
    seedReview('READY_FOR_APPROVAL');
    const before = calls().length;
    await showCard();
    expect(
      within(card()).queryByRole('region', { name: 'Revision request' })
    ).toBeNull();
    expect(
      calls()
        .slice(before)
        .filter((c) => /revision-request/.test(c.url))
    ).toHaveLength(0);
  });

  it('FR7/DD1 without a saved newer revision there is nothing to resolve by, and unsaved changes do not count', async () => {
    const review = seedReview('CHANGES_REQUESTED');
    revisionRequests[review.id] = openRequest('Fix it');
    await showCard({ newerRevisions: [], unsaved: true });
    expect(panel().querySelector('[data-resolve-none]')!.textContent).toBe(
      'Create and save a newer revision before resolving this request.'
    );
    expect(panel().querySelector('[data-resolve-unsaved]')).not.toBeNull();
    expect(
      within(panel()).queryAllByRole('button', { name: /resolved/ })
    ).toEqual([]);
    expect(radios()).toEqual([]);
  });

  it('FR6/M26 only newer saved revisions are offered: never the reviewed one or an older one', async () => {
    const review = seedReview(
      'CHANGES_REQUESTED',
      'DESIGN_REVISION',
      DESIGN_REV_2,
      4
    );
    revisionRequests[review.id] = openRequest('Fix it');
    await showCard({
      revisionId: DESIGN_REV_2,
      revisionNumber: 4,
      newerRevisions: [
        { id: uuid(60), revisionNumber: 6 },
        { id: DESIGN_REV_2, revisionNumber: 4 },
        { id: uuid(30), revisionNumber: 3 },
        { id: uuid(50), revisionNumber: 5 },
      ],
    });
    expect(radios()).toEqual(['Revision 5', 'Revision 6']);
    expect(button('Mark resolved').disabled).toBe(true);
  });

  it('FR8/FR9/FR10 resolving sends the chosen revision id only; the request shows it, the review stays Changes requested', async () => {
    const review = seedReview(
      'CHANGES_REQUESTED',
      'PACKAGE_REVISION',
      PKG_REV_4,
      4
    );
    revisionRequests[review.id] = openRequest('Fix it');
    await showCard({
      targetType: 'PACKAGE_REVISION',
      revisionId: PKG_REV_4,
      revisionNumber: 4,
      newerRevisions: [{ id: PKG_REV_5, revisionNumber: 5 }],
    });
    const radio = within(panel()).getByRole('radio', {
      name: 'Version 5',
    }) as HTMLInputElement;
    await click(radio);
    expect(radio.checked).toBe(true);
    await click(button('Mark resolved by Version 5'));
    expect(writes()).toEqual([
      {
        method: 'POST',
        url: `/content-studio/reviews/${review.id}/revision-request/resolve`,
        body: JSON.stringify({ resolutionRevisionId: PKG_REV_5 }),
      },
    ]);
    expect(panel().getAttribute('data-revision-request')).toBe('RESOLVED');
    expect(
      panel().querySelector('[data-revision-request-resolution]')!.textContent
    ).toMatch(/^Resolved by Version 5 · Bo · Oct 19, 2026 \d\d:\d\d$/);
    expect(radios()).toEqual([]);
    expect(state()).toBe('Changes requested');
    // no review is requested for version 5 by this
    expect(writes().filter((c) => c.url === '/content-studio/reviews')).toEqual(
      []
    );
    expect(reviews).toHaveLength(1);
  });

  it.each([
    [
      'CS_REVIEW_REVISION_REQUEST_INVALID_RESOLUTION',
      400,
      'Choose a newer saved revision of the same package or design.',
    ],
    [
      'CS_REVIEW_REVISION_REQUEST_CONFLICT',
      409,
      'This revision request has changed. Check its current state and try again.',
    ],
    [
      'CS_REVIEW_INTEGRITY_ERROR',
      500,
      'Stored review data could not be read safely.',
    ],
  ])(
    '67 a failed resolution (%s) shows a fixed message',
    async (code, status, message) => {
      const review = seedReview('CHANGES_REQUESTED');
      revisionRequests[review.id] = openRequest('Fix it');
      await showCard({
        newerRevisions: [{ id: DESIGN_REV_2, revisionNumber: 2 }],
      });
      await click(within(panel()).getByRole('radio', { name: 'Revision 2' }));
      failNext = { status, code };
      await click(button('Mark resolved by Revision 2'));
      expect(mockToast).toHaveBeenCalledWith(message, 'warning');
    }
  );

  it('67 a failed request for changes keeps the form and the text', async () => {
    seedReview('IN_REVIEW');
    await showCard();
    await click(button('Request changes'));
    type('What needs to change?', 'Keep me');
    mockFetch.mockImplementationOnce(async () =>
      reply(400, { msg: SECRET, code: 'CS_REVIEW_REVISION_REQUEST_INVALID' })
    );
    await click(button('Send revision request'));
    expect(mockToast).toHaveBeenCalledWith(
      'Describe what needs to change, in at most 20,000 characters.',
      'warning'
    );
    expect(textbox('What needs to change?').value).toBe('Keep me');
  });
});

describe('Resolution from the package versions and the design workspace', () => {
  const history = () =>
    show(
      h(ContentStudioRevisionHistory, {
        packageId: PACKAGE,
        canRestore: true,
        onRestore: async () => true,
        close: () => undefined,
      })
    );

  it('FR6/DD1 a package version offers the newer saved versions from the history, no new request', async () => {
    const review = seedReview(
      'CHANGES_REQUESTED',
      'PACKAGE_REVISION',
      PKG_REV_3,
      3
    );
    revisionRequests[review.id] = openRequest('Fix it');
    await history();
    const before = calls().length;
    await click(screen.getByRole('button', { name: 'View 3' }));
    expect(radios()).toEqual(['Version 4', 'Version 5']);
    // the versions come from the history already loaded: no second list
    expect(
      calls()
        .slice(before)
        .filter((c) => /\/packages\/[^/]+\/revisions\?/.test(c.url))
    ).toEqual([]);
    await click(within(panel()).getByRole('radio', { name: 'Version 5' }));
    await click(button('Mark resolved by Version 5'));
    expect(JSON.parse(writes()[0].body!)).toEqual({
      resolutionRevisionId: PKG_REV_5,
    });
  });

  it('FR7 the newest package version has nothing newer to be resolved by', async () => {
    const review = seedReview(
      'CHANGES_REQUESTED',
      'PACKAGE_REVISION',
      PKG_REV_5,
      5
    );
    revisionRequests[review.id] = openRequest('Fix it');
    await history();
    await click(screen.getByRole('button', { name: 'View 5' }));
    expect(panel().querySelector('[data-resolve-none]')).not.toBeNull();
  });

  const open = () =>
    show(h(ContentStudioDesignWorkspace, { designId: DESIGN }));

  it('DD2/DD3 a dirty design draft is never a resolution, and comments stay on the reviewed revision', async () => {
    const review = seedReview(
      'CHANGES_REQUESTED',
      'DESIGN_REVISION',
      DESIGN_REV_2,
      2
    );
    revisionRequests[review.id] = openRequest('Fix it');
    await open();
    await click(screen.getByRole('button', { name: 'Edit design' }));
    await click(screen.getByRole('button', { name: 'Add text' }));
    expect(card().getAttribute('data-review-revision')).toBe(DESIGN_REV_2);
    expect(panel().querySelector('[data-resolve-unsaved]')).not.toBeNull();
    expect(panel().querySelector('[data-resolve-none]')).not.toBeNull();
    expect(radios()).toEqual([]);
    await click(button('Show discussion'));
    type('Add a comment', 'About revision 2');
    await click(button('Post comment'));
    expect(writes()).toEqual([
      {
        method: 'POST',
        url: `/content-studio/reviews/${review.id}/comments`,
        body: JSON.stringify({ body: 'About revision 2' }),
      },
    ]);
  });

  it("DD4 once a newer revision is saved, the older revision's request can be resolved by it", async () => {
    const review = seedReview(
      'CHANGES_REQUESTED',
      'DESIGN_REVISION',
      DESIGN_REV_2,
      2
    );
    revisionRequests[review.id] = openRequest('Fix it');
    const DESIGN_REV_3 = uuid(13);
    extraDesignRevisions = [
      { id: DESIGN_REV_3, revisionNumber: 3, content: doc('#123456') },
    ];
    numberOf[DESIGN_REV_3] = 3;
    await open();
    await click(screen.getByRole('button', { name: 'View Revision 2' }));
    expect(card().getAttribute('data-review-revision')).toBe(DESIGN_REV_2);
    expect(radios()).toEqual(['Revision 3']);
    await click(within(panel()).getByRole('radio', { name: 'Revision 3' }));
    await click(button('Mark resolved by Revision 3'));
    expect(JSON.parse(writes()[0].body!)).toEqual({
      resolutionRevisionId: DESIGN_REV_3,
    });
    expect(panel().textContent).toContain('Resolved by Revision 3');
    delete numberOf[DESIGN_REV_3];
  });
});

describe('Review discussion UI boundaries (P5-02)', () => {
  const read = (file: string) =>
    readFileSync(join(__dirname, file), 'utf8').replace(/\/\/.*$/gm, '');

  it('P502-7/P502-8/P502-9 no mention, attachment, annotation, markdown or delete', () => {
    const ui = read('content-studio.review.discussion.tsx');
    expect(ui).not.toMatch(
      /dangerouslySetInnerHTML|markdown|mention|attachment|upload|layerId|annotation|delete|remove/i
    );
    expect(ui).toContain('whitespace-pre-wrap');
  });

  it('M27 resolution choices are only saved revisions passed by the page, newer than the reviewed one', () => {
    const ui = read('content-studio.review.discussion.tsx');
    expect(ui).toMatch(
      /revision\.revisionNumber > review\.targetRevisionNumber &&\s+revision\.id !== review\.targetRevisionId/
    );
    expect(ui).toMatch(
      /actions\.resolveRevisionRequest\(review\.id, selected\.id\)/
    );
    expect(read('content-studio.revision.history.tsx')).toMatch(
      /newerRevisions=\{newest\.data\?\.results \?\? \[\]\}/
    );
    expect(read('content-studio.design.workspace.tsx')).toMatch(
      /newerRevisions=\{\[\s+currentRevision,\s+\.\.\.\(history\.data\?\.results \?\? \[\]\)/
    );
  });

  it('P502-2 the discussion gates no handoff, approval or publishing', () => {
    for (const file of [
      'content-studio.review.discussion.tsx',
      'content-studio.review.status.tsx',
      'content-studio.reviews.api.ts',
    ]) {
      expect(read(file)).not.toMatch(
        /handoff|publish|approve\(|approval[A-Z]|signature/i
      );
    }
  });
});

// --- claim review (P5-03B) ---

describe('Claims & evidence in a package review (P5-03B)', () => {
  const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');
  const C1 = 'c_claim000000000001';
  const C2 = 'c_claim000000000002';
  const reviewIn = (state: string, revisionId = PKG_REV_4, n = 4) => {
    const review = { ...reviewOf('PACKAGE_REVISION', revisionId, n), state };
    reviews.push(review);
    return review;
  };
  const withClaims = (review: Plain, claims: Plain[]) => {
    claimLists[review.id] = claimListOf(review, claims);
  };
  const showPackage = (revisionId = PKG_REV_4, n = 4) =>
    show(
      h(ContentStudioReviewStatus, {
        targetType: 'PACKAGE_REVISION',
        revisionId,
        revisionNumber: n,
      })
    );
  const section = () =>
    within(card()).getByRole('region', { name: 'Claims & evidence' });
  const openClaims = () =>
    click(within(card()).getByRole('button', { name: 'Show claims' }));
  const claimCard = (id: string) =>
    card().querySelector(`[data-review-claim="${id}"]`) as HTMLElement;
  const claimCalls = () => calls().filter((c) => c.url.includes('/claims'));
  const sourceCalls = () =>
    calls().filter((c) => c.url.startsWith('/content-studio/sources'));
  const ready = () =>
    within(card()).getByRole('button', {
      name: 'Ready for approval',
    }) as HTMLButtonElement;

  it('FCL1/FCL4/FCL5 an in-review package review loads its claims: the counts in words and each claim exactly', async () => {
    const review = reviewIn('IN_REVIEW');
    withClaims(review, [
      claimOf(C1, '  Sales grew\nby ten percent.', 'VERIFIED'),
      claimOf(C2, 'The outlook is covered.', 'NEEDS_REVISION', 'Wrong figure.'),
      claimOf('c_claim000000000003', 'Third.'),
    ]);
    await showPackage();
    expect(claimCalls()).toEqual([
      {
        method: 'GET',
        url: `/content-studio/reviews/${review.id}/claims`,
        body: undefined,
      },
    ]);
    const summary = section().querySelector('[data-review-claims-summary]')!;
    expect(
      Array.from(summary.querySelectorAll('dt')).map((n) => n.textContent)
    ).toEqual(['Total', 'Verified', 'Needs revision', 'Unreviewed']);
    expect(
      Array.from(summary.querySelectorAll('dd')).map((n) => n.textContent)
    ).toEqual(['3', '1', '1', '1']);
    await openClaims();
    const first = claimCard(C1);
    expect(first.querySelector('.whitespace-pre-wrap')?.textContent).toBe(
      '  Sales grew\nby ten percent.'
    );
    expect(first.getAttribute('data-review-claim-status')).toBe('VERIFIED');
    expect(within(first).getByText('Verified')).toBeTruthy();
    expect(within(first).getByText('Evidence: 1')).toBeTruthy();
    expect(first.textContent).toContain('Bo');
    expect(
      claimCard(C2).querySelector('[data-review-claim-finding]')?.textContent
    ).toBe('Wrong figure.');
    expect(
      within(section()).getByText(
        'Use Request changes to formally send required changes back.'
      )
    ).toBeTruthy();
  });

  it('FCL6/FCL7 evidence opens on demand from the review answer: no source request at all', async () => {
    const review = reviewIn('IN_REVIEW');
    withClaims(review, [claimOf(C1, 'Sales grew.')]);
    await showPackage();
    await openClaims();
    const toggle = within(claimCard(C1)).getByRole('button', {
      name: 'Show evidence',
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(
      claimCard(C1).querySelector('[data-review-evidence-block]')
    ).toBeNull();
    await click(toggle);
    const evidence = claimCard(C1).querySelector(
      '[data-review-evidence-block="b1"]'
    ) as HTMLElement;
    expect(evidence.getAttribute('data-review-evidence-version')).toBe(
      uuid(701)
    );
    expect(evidence.textContent).toContain(
      'Weekly report · Spring report · Version 2'
    );
    expect(evidence.querySelector('blockquote')?.textContent).toBe(
      `quote of ${C1}`
    );
    expect(evidence.textContent).toContain(`Block of ${C1}.`);
    expect(sourceCalls()).toEqual([]);
  });

  it('FCL8 Mark verified sends the status and an empty finding only', async () => {
    const review = reviewIn('IN_REVIEW');
    withClaims(review, [claimOf(C1, 'Sales grew.')]);
    await showPackage();
    await openClaims();
    await click(
      within(claimCard(C1)).getByRole('button', { name: 'Mark verified' })
    );
    const form = within(card()).getByRole('form', { name: 'Mark verified' });
    expect(
      within(form).getByRole('textbox', { name: 'Finding (optional)' })
    ).toBeTruthy();
    await click(within(form).getByRole('button', { name: 'Save as verified' }));
    expect(
      claimCalls()
        .filter((c) => c.method === 'PUT')
        .map((c) => [c.url, JSON.parse(c.body as string)])
    ).toEqual([
      [
        `/content-studio/reviews/${review.id}/claims/${C1}`,
        { status: 'VERIFIED', finding: null },
      ],
    ]);
    expect(claimCard(C1).getAttribute('data-review-claim-status')).toBe(
      'VERIFIED'
    );
  });

  it('FCL9 Needs revision needs a finding before it can be saved, and sends it exactly', async () => {
    const review = reviewIn('IN_REVIEW');
    withClaims(review, [claimOf(C1, 'Sales grew.')]);
    await showPackage();
    await openClaims();
    await click(
      within(claimCard(C1)).getByRole('button', { name: 'Needs revision' })
    );
    const form = within(card()).getByRole('form', { name: 'Needs revision' });
    const save = within(form).getByRole('button', {
      name: 'Save as needs revision',
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const box = within(form).getByRole('textbox', {
      name: 'Finding (required)',
    });
    fireEvent.change(box, { target: { value: '   ' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(box, {
      target: { value: ' The quote says ten,\nnot twenty. ' },
    });
    expect(save.disabled).toBe(false);
    await click(save);
    expect(
      JSON.parse(claimCalls().find((c) => c.method === 'PUT')!.body as string)
    ).toEqual({
      status: 'NEEDS_REVISION',
      finding: ' The quote says ten,\nnot twenty. ',
    });
  });

  it('FCL10 Reset to unreviewed sends UNREVIEWED without a finding', async () => {
    const review = reviewIn('IN_REVIEW');
    withClaims(review, [claimOf(C1, 'Sales grew.', 'NEEDS_REVISION', 'Why.')]);
    await showPackage();
    await openClaims();
    await click(
      within(claimCard(C1)).getByRole('button', { name: 'Reset to unreviewed' })
    );
    expect(
      JSON.parse(claimCalls().find((c) => c.method === 'PUT')!.body as string)
    ).toEqual({ status: 'UNREVIEWED', finding: null });
    expect(claimCard(C1).getAttribute('data-review-claim-status')).toBe(
      'UNREVIEWED'
    );
  });

  it.each([
    'REQUESTED',
    'CHANGES_REQUESTED',
    'READY_FOR_APPROVAL',
    'CANCELLED',
  ])(
    'FCL11/M21 %s: the claims are readable once opened, with no assessment control',
    async (state) => {
      const review = reviewIn(state);
      withClaims(review, [claimOf(C1, 'Sales grew.', 'VERIFIED')]);
      await showPackage();
      // not in review: nothing is loaded until the section is opened
      expect(claimCalls()).toEqual([]);
      await openClaims();
      expect(claimCard(C1)).toBeTruthy();
      for (const name of [
        'Mark verified',
        'Needs revision',
        'Reset to unreviewed',
      ]) {
        expect(
          within(claimCard(C1)).queryByRole('button', { name })
        ).toBeNull();
      }
      expect(
        within(claimCard(C1)).getByRole('button', { name: 'Show evidence' })
      ).toBeTruthy();
    }
  );

  it('FCL12/M22 Ready for approval is off, with the reason, while a claim is not verified', async () => {
    const review = reviewIn('IN_REVIEW');
    withClaims(review, [claimOf(C1, 'One.', 'VERIFIED'), claimOf(C2, 'Two.')]);
    await showPackage();
    expect(ready().disabled).toBe(true);
    expect(
      card().querySelector('[data-review-claims-blocking]')?.textContent
    ).toBe(
      'Review every grounded claim before marking this revision ready for approval.'
    );
    // Request changes and Cancel stay available
    expect(
      (
        within(card()).getByRole('button', {
          name: 'Request changes',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  });

  it('FCL13 every claim verified (or no claims): Ready for approval is on', async () => {
    const review = reviewIn('IN_REVIEW');
    withClaims(review, [claimOf(C1, 'One.', 'VERIFIED')]);
    await showPackage();
    expect(ready().disabled).toBe(false);
    expect(card().querySelector('[data-review-claims-blocking]')).toBeNull();
    await click(ready());
    expect(state()).toBe('Ready for approval');
  });

  it('FCL3 a version without grounded claims says so, and can become ready', async () => {
    const review = reviewIn('IN_REVIEW');
    withClaims(review, []);
    await showPackage();
    expect(ready().disabled).toBe(false);
    await openClaims();
    expect(
      within(section()).getByText(
        'No grounded claims were recorded in this revision.'
      )
    ).toBeTruthy();
  });

  it('FCL14 a stale page that sends Ready for approval gets the fixed reason from the server', async () => {
    const review = reviewIn('IN_REVIEW');
    withClaims(review, [claimOf(C1, 'One.', 'VERIFIED')]);
    await showPackage();
    // the server finds a claim no longer verified
    const original = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) =>
      /ready-for-approval$/.test(url)
        ? reply(409, { msg: SECRET, code: 'CS_REVIEW_CLAIMS_INCOMPLETE' })
        : original(url, init)
    );
    await click(ready());
    expect(mockToast).toHaveBeenCalledWith(
      'Review every grounded claim before marking this revision ready for approval.',
      'warning'
    );
    expect(state()).toBe('In review');
  });

  it('a refused assessment shows its fixed message and reloads', async () => {
    const review = reviewIn('IN_REVIEW');
    withClaims(review, [claimOf(C1, 'One.')]);
    await showPackage();
    await openClaims();
    await click(
      within(claimCard(C1)).getByRole('button', { name: 'Mark verified' })
    );
    failNext = { status: 409, code: 'CS_REVIEW_CLAIM_MUTATION_FORBIDDEN' };
    await click(
      within(
        within(card()).getByRole('form', { name: 'Mark verified' })
      ).getByRole('button', { name: 'Save as verified' })
    );
    expect(mockToast).toHaveBeenCalledWith(
      'Claims can only be assessed while the review is in review.',
      'warning'
    );
  });

  it('FCL2 a design review has no Claims & evidence and asks for none', async () => {
    reviews.push({
      ...reviewOf('DESIGN_REVISION', DESIGN_REV_1, 1),
      state: 'IN_REVIEW',
    });
    await show(
      h(ContentStudioReviewStatus, {
        targetType: 'DESIGN_REVISION',
        revisionId: DESIGN_REV_1,
        revisionNumber: 1,
      })
    );
    expect(
      within(card()).queryByRole('region', { name: 'Claims & evidence' })
    ).toBeNull();
    expect(claimCalls()).toEqual([]);
    expect(ready().disabled).toBe(false);
  });

  it("FCL15/M25 each version's review shows its own claims: a newer version never replaces them", async () => {
    const four = reviewIn('IN_REVIEW', PKG_REV_4, 4);
    const five = reviewIn('IN_REVIEW', PKG_REV_5, 5);
    withClaims(four, [claimOf(C1, 'Claim of version 4.')]);
    withClaims(five, [claimOf(C2, 'Claim of version 5.')]);
    await showPackage(PKG_REV_4, 4);
    await openClaims();
    expect(section().textContent).toContain('Claim of version 4.');
    expect(section().textContent).not.toContain('Claim of version 5.');
    expect(claimCalls().map((c) => c.url)).toEqual([
      `/content-studio/reviews/${four.id}/claims`,
    ]);
  });

  it('FCL16/M23/M24 the claim UI reads verified data only, sends status and finding only, and grounding authoring has no review words', () => {
    const claimsUi = read('content-studio.review.claims.tsx');
    expect(claimsUi).not.toMatch(
      /sources\.api|useContentStudioSource|fetch\(|organizationId|claimContentHash|reviewedBy:|userId/
    );
    const grounding = read('content-studio.grounding.tsx');
    expect(grounding).not.toMatch(
      /review|Verified|Needs revision|Unreviewed|claims\.api/i
    );
  });
});
