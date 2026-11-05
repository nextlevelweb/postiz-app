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

// After the first post (activation flow 01): the success moment, a tour of
// five steps that starts once and begins with the research the user just
// used, and the getting-started list on Home whose tasks are done when the
// organization's data says so. A .spec.ts without JSX, like the other
// Content Studio frontend specs

const mockRouter = { replace: jest.fn(), push: jest.fn() };
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  usePathname: () => '/content-studio/first-post',
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
jest.mock('@gitroom/frontend/components/layout/new-modal', () => ({
  useModalCloseGuard: () => undefined,
  useModals: () => ({
    openModal: jest.fn(),
    closeAll: jest.fn(),
    closeById: jest.fn(),
    closeCurrent: jest.fn(),
  }),
}));
jest.mock('@gitroom/react/toaster/toaster', () => ({
  useToaster: () => ({ show: jest.fn() }),
}));
jest.mock('@gitroom/react/helpers/delete.dialog', () => ({
  deleteDialog: jest.fn(),
}));
const mockFetch = jest.fn();
jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));
jest.mock('@gitroom/react/translation/get.transation.service.client', () => ({
  useT:
    () => (key: string, fallback?: string, params?: Record<string, unknown>) =>
      (fallback ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) =>
        String(params?.[name] ?? '')
      ),
}));
jest.mock('@gitroom/frontend/components/layout/user.context', () => ({
  useUser: () => ({ orgId: 'org-1', tier: 'PRO', role: 'ADMIN' }),
}));

const {
  ContentStudioFirstPostPage,
  ContentStudioFirstPostReminder,
  ContentStudioGetStarted,
  CONTENT_STUDIO_TOUR,
  tourCardPosition,
} = require('./content-studio.onboarding');

const T0 = '2026-10-30T10:00:00.000Z';
const TOUR_KEY = 'content-studio-tour:org-1';
const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const CONNECTION = {
  id: '44444444-4444-4444-8444-444444444444',
  name: 'Codex',
  provider: 'codex',
  defaultModel: 'gpt-6.1-sol',
  disabled: false,
  credentialPresent: true,
  credentialUpdatedAt: T0,
  lastValidatedAt: T0,
  lastValidationStatus: 'valid',
  lastValidationCode: null,
  createdAt: T0,
  updatedAt: T0,
};
// Lambert's post: saved in the composer as a draft for 25 November, after
// the research it came from
const SAVED = {
  publishDate: '2026-11-25T07:20:00.000Z',
  group: '51766056-e439-4d14-892f-fdf34b26c5b5',
  createdAt: '2026-10-30T22:29:45.106Z',
};
const SAVED_PATH =
  '/launches?post=51766056-e439-4d14-892f-fdf34b26c5b5&return=first-post';
const alternative = (id: string, current: boolean) => ({
  operationId: id,
  completedAt: T0,
  text: `text ${id}`,
  research: null,
  current,
});
const firstPost = (activated: boolean, saved = false) => ({
  packageId: 'p',
  package: { name: 'First post', draftVersion: 2, archived: false, text: 'x' },
  research: {
    operationId: 'r',
    status: 'succeeded',
    completedAt: T0,
    result: {
      topic: 't',
      angle: 'a',
      summary: 's',
      why: { audience: 'a', expertise: 'e', timing: 't' },
      sources: [],
      sourceBacked: false,
    },
  },
  draft: { operationId: 'd', status: 'succeeded', applied: true },
  alternatives: [alternative('d', true), alternative('d0', false)],
  firstPost: {
    scheduled: activated,
    published: false,
    savedAsDraft: saved && !activated ? SAVED : null,
  },
  activated,
});
const list = (n: number) => ({
  pages: n ? 1 : 0,
  results: Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    name: `n${i}`,
    latestRevisionNumber: 1,
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
  })),
});

let state: {
  activated: boolean;
  // saved in the composer as a draft
  saved?: boolean;
  sources: number;
  designs: number;
  policy: Record<string, unknown>;
};
const server = (url: string) => {
  const { pathname } = new URL(url, 'https://api.test');
  switch (pathname) {
    case '/content-studio/activation/first-post':
      return reply(200, firstPost(state.activated, state.saved));
    case '/content-studio/ai/providers':
      return reply(200, [
        {
          provider: 'codex',
          displayName: 'Codex',
          credentialFields: [],
          defaultModel: 'gpt-6.1-sol',
          models: [],
        },
      ]);
    case '/content-studio/ai/connections':
      return reply(200, [CONNECTION]);
    case '/content-studio/brand-kit':
      return reply(200, {
        latestRevisionNumber: 1,
        currentRevision: {
          content: {
            identity: { brandName: 'A', tagline: '', description: 'd' },
          },
        },
      });
    case '/content-studio/editorial-policy':
      return reply(200, {
        latestRevisionNumber: 1,
        currentRevision: { content: state.policy },
      });
    case '/content-studio/sources':
      return reply(200, list(state.sources));
    case '/content-studio/designs':
      return reply(200, list(state.designs));
    default:
      // writing, audience and expertise profiles: one each
      return reply(200, list(1));
  }
};

const POLICY = {
  schemaVersion: 1,
  principles: [],
  prohibitedTopics: [],
  claimRules: [],
  ctaRules: [],
  formatConventions: [],
  complianceNotes: '',
};

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
const show = async (component: unknown) => {
  render(
    h(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      h(component as never)
    )
  );
  await flush();
};
const card = () => screen.getByTestId('tour-card');
const title = () => within(card()).getByRole('heading').textContent;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  state = { activated: true, sources: 0, designs: 0, policy: POLICY };
  mockFetch.mockImplementation(async (url: string) => server(url));
});

afterEach(async () => {
  cleanup();
  await flush();
  mockFetch.mockReset();
});

describe('After the first post: the success and the tour', () => {
  it('AC4 a first post that is only drafted shows no success and no tour', async () => {
    state.activated = false;
    await show(ContentStudioFirstPostPage);
    expect(screen.queryByTestId('tour-card')).toBeNull();
    expect(screen.queryByText('Your first post is scheduled')).toBeNull();
  });

  it('TOUR1-TOUR5 starts after the scheduled first post: Radar, Home, Knowledge, Creative Studio, Approvals', async () => {
    await show(ContentStudioFirstPostPage);
    expect(screen.getByText('Your first post is scheduled')).toBeTruthy();
    expect(CONTENT_STUDIO_TOUR).toEqual([
      'radar',
      'home',
      'sources',
      'creative',
      'reviews',
    ]);
    const titles: string[] = [];
    for (let i = 0; i < 5; i++) {
      expect(within(card()).getByText(`${i + 1} of 5`)).toBeTruthy();
      titles.push(title() as string);
      // the section it explains is in the navigation of the page
      expect(
        document.querySelector(`[data-cs-section="${CONTENT_STUDIO_TOUR[i]}"]`)
      ).toBeTruthy();
      expect(
        within(card()).getByRole('button', { name: 'Skip tour' })
      ).toBeTruthy();
      fireEvent.click(
        within(card()).getByRole('button', { name: i === 4 ? 'Done' : 'Next' })
      );
      await flush();
    }
    expect(titles).toEqual([
      'Research starts in Radar',
      'Home',
      'Knowledge',
      'Creative Studio',
      'Approvals',
    ]);
    expect(screen.queryByTestId('tour-card')).toBeNull();
    expect(window.localStorage.getItem(TOUR_KEY)).toBe('completed');
  });

  it('TOUR1 the first step is about the research the user just used', async () => {
    await show(ContentStudioFirstPostPage);
    expect(
      within(card()).getByText(
        /^You just used research to create your first post\. Radar is where Content Studio keeps an eye on new developments/
      )
    ).toBeTruthy();
  });

  it('TOUR7/AC5 Skip ends the tour for good: it never starts again by itself, but can be taken again', async () => {
    await show(ContentStudioFirstPostPage);
    fireEvent.click(within(card()).getByRole('button', { name: 'Skip tour' }));
    await flush();
    expect(screen.queryByTestId('tour-card')).toBeNull();
    cleanup();
    await show(ContentStudioFirstPostPage);
    expect(screen.queryByTestId('tour-card')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Take a quick tour' }));
    expect(title()).toBe('Research starts in Radar');
    // Escape skips too
    fireEvent.keyDown(document, { key: 'Escape' });
    await flush();
    expect(screen.queryByTestId('tour-card')).toBeNull();
  });

  it('TOUR6 a phone gets a sheet at the bottom; a wide screen a card kept inside the screen', async () => {
    const width = window.innerWidth;
    const rect = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset?.csSection
          ? ({
              top: 60,
              left: 1380,
              width: 90,
              height: 40,
              right: 1470,
              bottom: 100,
              x: 1380,
              y: 60,
              toJSON: () => ({}),
            } as DOMRect)
          : ({
              top: 0,
              left: 0,
              width: 0,
              height: 0,
              right: 0,
              bottom: 0,
              x: 0,
              y: 0,
              toJSON: () => ({}),
            } as DOMRect);
      });
    try {
      Object.defineProperty(window, 'innerWidth', {
        value: 390,
        configurable: true,
      });
      await show(ContentStudioFirstPostPage);
      expect(card().getAttribute('data-placement')).toBe('sheet');
      expect(card().className).toContain('bottom-0');
      cleanup();
      window.localStorage.clear();
      Object.defineProperty(window, 'innerWidth', {
        value: 1440,
        configurable: true,
      });
      await show(ContentStudioFirstPostPage);
      expect(card().getAttribute('data-placement')).toBe('popover');
      const left = parseFloat(card().style.left);
      const cardWidth = parseFloat(card().style.width);
      // a target at the right edge: the card is moved back inside
      expect(left + cardWidth).toBeLessThanOrEqual(1440 - 16);
      expect(left).toBeGreaterThanOrEqual(16);
      expect(screen.getByTestId('tour-highlight')).toBeTruthy();
    } finally {
      rect.mockRestore();
      Object.defineProperty(window, 'innerWidth', {
        value: width,
        configurable: true,
      });
    }
  });
});

// Activation review 07: the real schedule of review 06 (5 January 2027,
// 08:20 in Amsterdam) showed a success without its date, a desktop tour
// card over that success, and a tour that ended on it instead of Home
describe('After the first post: the scheduled date, the tour card and its end', () => {
  const PLANNED = '2027-01-05T07:20:00.000Z';
  const firstPostReply = (patch: Record<string, unknown>) =>
    mockFetch.mockImplementation(async (url: string) =>
      new URL(url, 'https://api.test').pathname ===
      '/content-studio/activation/first-post'
        ? reply(200, {
            ...firstPost(state.activated, state.saved),
            firstPost: {
              ...firstPost(state.activated, state.saved).firstPost,
              ...patch,
            },
          })
        : server(url)
    );
  // the date as this machine's clock shows it: the composer's timezone
  const local = (iso: string) => {
    const date = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.toLocaleString('en-US', {
      month: 'short',
    })} ${date.getDate()}, ${date.getFullYear()} ${pad(date.getHours())}:${pad(
      date.getMinutes()
    )}`;
  };

  it('SCHED-DATE2 a scheduled first post says when it goes out, never "published"', async () => {
    firstPostReply({ scheduledFor: { publishDate: PLANNED } });
    await show(ContentStudioFirstPostPage);
    expect(screen.getByText('Your first post is scheduled')).toBeTruthy();
    expect(screen.getByTestId('first-post-scheduled-for').textContent).toBe(
      `Scheduled for ${local(PLANNED)}`
    );
    expect(screen.queryByText('Your first post is published')).toBeNull();
    expect(screen.queryByText('Schedule my first post')).toBeNull();
  });

  it('SCHED-DATE2 the date is the one of the post, never a fixed one', async () => {
    const other = '2027-03-14T15:45:00.000Z';
    firstPostReply({ scheduledFor: { publishDate: other } });
    await show(ContentStudioFirstPostPage);
    expect(screen.getByTestId('first-post-scheduled-for').textContent).toBe(
      `Scheduled for ${local(other)}`
    );
  });

  it('SCHED-DATE2 scheduled without a known date: the success, without inventing one', async () => {
    firstPostReply({ scheduledFor: null });
    await show(ContentStudioFirstPostPage);
    expect(screen.getByText('Your first post is scheduled')).toBeTruthy();
    expect(screen.queryByTestId('first-post-scheduled-for')).toBeNull();
  });

  it('SCHED-DATE3 a first post saved as a draft shows its draft date, never "Scheduled for"', async () => {
    state.activated = false;
    state.saved = true;
    await show(ContentStudioFirstPostPage);
    expect(screen.getByText('Your first post is saved')).toBeTruthy();
    expect(screen.getByText(/^Draft date: /).textContent).toContain(
      local('2026-11-25T07:20:00.000Z')
    );
    expect(screen.queryByTestId('first-post-scheduled-for')).toBeNull();
    expect(screen.queryByText(/Scheduled for/)).toBeNull();
  });

  it('SCHED-DATE4 a published first post shows no scheduled date', async () => {
    firstPostReply({
      scheduled: false,
      published: true,
      scheduledFor: { publishDate: PLANNED },
    });
    await show(ContentStudioFirstPostPage);
    expect(screen.getByText('Your first post is published')).toBeTruthy();
    expect(screen.queryByTestId('first-post-scheduled-for')).toBeNull();
  });

  it('TOUR-DONE1/TOUR-DONE2 unseen: the tour starts on the scheduled success; Done keeps it completed and goes to Home', async () => {
    firstPostReply({ scheduledFor: { publishDate: PLANNED } });
    await show(ContentStudioFirstPostPage);
    expect(title()).toBe('Research starts in Radar');
    for (let i = 0; i < 5; i++) {
      fireEvent.click(
        within(card()).getByRole('button', { name: i === 4 ? 'Done' : 'Next' })
      );
      await flush();
    }
    expect(window.localStorage.getItem(TOUR_KEY)).toBe('completed');
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith('/content-studio');
  });

  it('TOUR-DONE3 Skip tour (or Escape) keeps it skipped and goes to Home, like the draft path', async () => {
    await show(ContentStudioFirstPostPage);
    fireEvent.click(within(card()).getByRole('button', { name: 'Skip tour' }));
    await flush();
    expect(window.localStorage.getItem(TOUR_KEY)).toBe('skipped');
    expect(mockRouter.push).toHaveBeenCalledWith('/content-studio');
    cleanup();
    mockRouter.push.mockClear();
    // taken again on purpose, then Escape
    await show(ContentStudioFirstPostPage);
    fireEvent.click(screen.getByRole('button', { name: 'Take a quick tour' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    await flush();
    expect(window.localStorage.getItem(TOUR_KEY)).toBe('skipped');
    expect(mockRouter.push).toHaveBeenCalledWith('/content-studio');
  });

  it.each(['completed', 'skipped'])(
    'TOUR-DONE4 a revisit after the tour was %s: the success only, no tour and no redirect',
    async (seen) => {
      window.localStorage.setItem(TOUR_KEY, seen);
      firstPostReply({ scheduledFor: { publishDate: PLANNED } });
      await show(ContentStudioFirstPostPage);
      expect(screen.getByText('Your first post is scheduled')).toBeTruthy();
      expect(screen.getByTestId('first-post-scheduled-for')).toBeTruthy();
      expect(screen.queryByTestId('tour-card')).toBeNull();
      expect(mockRouter.push).not.toHaveBeenCalled();
    }
  );

  // the geometry of review 06: Content Studio navigation at 113-153, Radar
  // at x 346, the success at 120-880 x 271-517, a card of 360 x 234
  const RADAR = { top: 113, left: 346, width: 85, height: 40 };
  const SUCCESS = { top: 271, left: 120, width: 760, height: 246 };
  const CARD = { width: 360, height: 234 };
  const covers = (
    position: { top: number; left: number },
    keep: typeof SUCCESS
  ) =>
    position.left < keep.left + keep.width &&
    keep.left < position.left + CARD.width &&
    position.top < keep.top + keep.height &&
    keep.top < position.top + CARD.height;

  it('TOUR-POS1 without anything to keep in view the card stays right below its target, as before', () => {
    expect(tourCardPosition(RADAR, CARD, { width: 1200, height: 900 })).toEqual(
      { top: 165, left: 346 }
    );
  });

  it('TOUR-POS2 at 1200 x 900 the card no longer covers the success: it goes under it, below Radar', () => {
    const position = tourCardPosition(
      RADAR,
      CARD,
      { width: 1200, height: 900 },
      SUCCESS
    );
    expect(position).toEqual({ top: 529, left: 346 });
    expect(covers(position, SUCCESS)).toBe(false);
    expect(position.top + CARD.height).toBeLessThanOrEqual(900 - 16);
  });

  it('TOUR-POS3 at 1440 x 900 there is room beside the success: the card sits next to it, at the height of the navigation', () => {
    const position = tourCardPosition(
      RADAR,
      CARD,
      { width: 1440, height: 900 },
      SUCCESS
    );
    expect(position).toEqual({ top: 165, left: 892 });
    expect(covers(position, SUCCESS)).toBe(false);
  });

  it('TOUR-POS4 at 820 x 1180 (a narrower success) the card goes under it, inside the screen', () => {
    const success = { top: 271, left: 120, width: 600, height: 246 };
    const position = tourCardPosition(
      RADAR,
      CARD,
      { width: 820, height: 1180 },
      success
    );
    expect(covers(position, success)).toBe(false);
    expect(position.left + CARD.width).toBeLessThanOrEqual(820 - 16);
  });

  it('TOUR-POS5 a screen with no free place for a popover gives the sheet at the bottom, never a popover over the success', () => {
    expect(
      tourCardPosition(RADAR, CARD, { width: 1200, height: 700 }, SUCCESS)
    ).toBeNull();
  });

  const withGeometry = async (
    keep: { top: number; left: number; width: number; height: number },
    heights: { sheet: number; popover: number },
    run: () => Promise<void>
  ) => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const box = (r: {
      top: number;
      left: number;
      width: number;
      height: number;
    }) =>
      ({
        ...r,
        right: r.left + r.width,
        bottom: r.top + r.height,
        x: r.left,
        y: r.top,
        toJSON: () => ({}),
      } as DOMRect);
    const rect = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.dataset?.csSection) {
          return box(RADAR);
        }
        if (this.hasAttribute('data-cs-tour-keep-visible')) {
          return box(keep);
        }
        return box({ top: 0, left: 0, width: 0, height: 0 });
      });
    // the sheet is wider than the popover, so its text takes fewer lines
    const offset = jest
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute('data-placement') === 'popover'
          ? heights.popover
          : heights.sheet;
      });
    Object.defineProperty(window, 'innerWidth', {
      value: 1200,
      configurable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
      value: 900,
      configurable: true,
    });
    try {
      firstPostReply({ scheduledFor: { publishDate: PLANNED } });
      await show(ContentStudioFirstPostPage);
      await run();
    } finally {
      rect.mockRestore();
      offset.mockRestore();
      Object.defineProperty(window, 'innerWidth', {
        value: width,
        configurable: true,
      });
      Object.defineProperty(window, 'innerHeight', {
        value: height,
        configurable: true,
      });
    }
  };

  it('TOUR-POS7 a success scrolled out of the screen is not kept free: the card stays right below its target', async () => {
    await withGeometry(
      { top: -600, left: 120, width: 760, height: 246 },
      { sheet: CARD.height, popover: CARD.height },
      async () => {
        expect(card().getAttribute('data-placement')).toBe('popover');
        expect(card().style.top).toBe('165px');
        expect(card().style.left).toBe('346px');
      }
    );
  });

  it('TOUR-POS8 measured first as the shorter sheet, the card is placed again with its popover height: never a popover running off the screen', async () => {
    // 150 high it would fit under the success (529-679); 400 high it does
    // not (529-929 on a 900 high screen), so the sheet it is
    await withGeometry(SUCCESS, { sheet: 150, popover: 400 }, async () => {
      expect(card().getAttribute('data-placement')).toBe('sheet');
    });
    cleanup();
    window.localStorage.clear();
    // a popover height that fits keeps the popover, under the success
    await withGeometry(
      SUCCESS,
      { sheet: 150, popover: CARD.height },
      async () => {
        expect(card().getAttribute('data-placement')).toBe('popover');
        expect(card().style.top).toBe('529px');
      }
    );
  });

  it('TOUR-POS9 like a first load in review 07: the page settles after the card was placed (no resize, no scroll); the card and the highlight follow it', async () => {
    // laid out mirrored at first: Radar at 1009, the success at 560
    let settled = false;
    const radar = () => (settled ? RADAR : { ...RADAR, left: 1009 });
    const success = () => (settled ? SUCCESS : { ...SUCCESS, left: 560 });
    const width = window.innerWidth;
    const height = window.innerHeight;
    const box = (r: {
      top: number;
      left: number;
      width: number;
      height: number;
    }) =>
      ({
        ...r,
        right: r.left + r.width,
        bottom: r.top + r.height,
        x: r.left,
        y: r.top,
        toJSON: () => ({}),
      } as DOMRect);
    const rect = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.dataset?.csSection === 'radar') {
          return box(radar());
        }
        if (this.hasAttribute('data-cs-tour-keep-visible')) {
          return box(success());
        }
        return box({ top: 0, left: 0, width: 0, height: 0 });
      });
    const offset = jest
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(CARD.height);
    Object.defineProperty(window, 'innerWidth', {
      value: 1440,
      configurable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
      value: 900,
      configurable: true,
    });
    try {
      firstPostReply({ scheduledFor: { publishDate: PLANNED } });
      await show(ContentStudioFirstPostPage);
      expect(screen.getByTestId('tour-highlight').style.left).toBe('1009px');
      settled = true;
      await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
      expect(screen.getByTestId('tour-highlight').style.left).toBe('346px');
      // beside the success where it is now, never over it
      expect(card().style.left).toBe('892px');
      expect(card().style.top).toBe('165px');
    } finally {
      rect.mockRestore();
      offset.mockRestore();
      Object.defineProperty(window, 'innerWidth', {
        value: width,
        configurable: true,
      });
      Object.defineProperty(window, 'innerHeight', {
        value: height,
        configurable: true,
      });
    }
  });

  it('TOUR-POS6 on the page: the success is kept in view on a desktop; a phone still gets the sheet', async () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const box = (r: {
      top: number;
      left: number;
      width: number;
      height: number;
    }) =>
      ({
        ...r,
        right: r.left + r.width,
        bottom: r.top + r.height,
        x: r.left,
        y: r.top,
        toJSON: () => ({}),
      } as DOMRect);
    const rect = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.dataset?.csSection) {
          return box(RADAR);
        }
        if (this.hasAttribute('data-cs-tour-keep-visible')) {
          return box(SUCCESS);
        }
        return box({ top: 0, left: 0, width: 0, height: 0 });
      });
    const offset = jest
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(CARD.height);
    try {
      Object.defineProperty(window, 'innerWidth', {
        value: 1200,
        configurable: true,
      });
      Object.defineProperty(window, 'innerHeight', {
        value: 900,
        configurable: true,
      });
      firstPostReply({ scheduledFor: { publishDate: PLANNED } });
      await show(ContentStudioFirstPostPage);
      expect(card().getAttribute('data-placement')).toBe('popover');
      expect(
        covers(
          {
            top: parseFloat(card().style.top),
            left: parseFloat(card().style.left),
          },
          SUCCESS
        )
      ).toBe(false);
      expect(screen.getByTestId('tour-highlight')).toBeTruthy();
      cleanup();
      window.localStorage.clear();
      Object.defineProperty(window, 'innerWidth', {
        value: 390,
        configurable: true,
      });
      await show(ContentStudioFirstPostPage);
      expect(card().getAttribute('data-placement')).toBe('sheet');
    } finally {
      rect.mockRestore();
      offset.mockRestore();
      Object.defineProperty(window, 'innerWidth', {
        value: width,
        configurable: true,
      });
      Object.defineProperty(window, 'innerHeight', {
        value: height,
        configurable: true,
      });
    }
  });
});

// Activation review 03: Lambert saved his first post in the composer and
// came back to the same page, with no word about it. Back from the
// composer, the page reads where the post stands at once
describe('After the first post: back from the composer', () => {
  const firstPostReads = () =>
    mockFetch.mock.calls.filter(
      ([url]) =>
        new URL(url, 'https://api.test').pathname ===
        '/content-studio/activation/first-post'
    ).length;
  // the same cache across leaving for the composer and coming back, as in
  // the app
  const cache = new Map();
  const mount = async () => {
    render(
      h(
        SWRConfig,
        { value: { provider: () => cache, dedupingInterval: 0 } },
        h(ContentStudioFirstPostPage)
      )
    );
    await flush();
  };
  beforeEach(() => cache.clear());

  it('ACT1 a first post that is drafted only: no success, no tour, no checklist', async () => {
    state.activated = false;
    await mount();
    expect(screen.getByText('Your draft')).toBeTruthy();
    expect(screen.queryByText('Your first post is scheduled')).toBeNull();
    expect(screen.queryByTestId('tour-card')).toBeNull();
    expect(screen.queryByText('Get more out of Content Studio')).toBeNull();
  });

  it('ACT4/ACT5/ACT6/ACT7/SCHED4/SCHED5/SCHED7 scheduled in the composer: the return reads it again at once, shows the success and starts the tour, without Home', async () => {
    state.activated = false;
    await mount();
    expect(screen.getByText('Your draft')).toBeTruthy();
    const before = firstPostReads();
    // to the composer and back: the page leaves and is shown again
    cleanup();
    state.activated = true;
    await mount();
    // what was kept is shown first; it is read again on the next frame
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    await flush();
    expect(firstPostReads()).toBeGreaterThan(before);
    expect(screen.getByText('Your first post is scheduled')).toBeTruthy();
    expect(title()).toBe('Research starts in Radar');
  });

  it('ACT3/SCHED6 published in the composer: the success says so, and the tour starts', async () => {
    mockFetch.mockImplementation(async (url: string) =>
      new URL(url, 'https://api.test').pathname ===
      '/content-studio/activation/first-post'
        ? reply(200, {
            ...firstPost(true),
            firstPost: { scheduled: false, published: true },
          })
        : server(url)
    );
    await mount();
    expect(screen.getByText('Your first post is published')).toBeTruthy();
    expect(title()).toBe('Research starts in Radar');
  });

  it('ACT8 the tour starts once: skipped or completed, a return shows the success only, and it can be taken again', async () => {
    await mount();
    fireEvent.click(within(card()).getByRole('button', { name: 'Skip tour' }));
    await flush();
    expect(window.localStorage.getItem(TOUR_KEY)).toBe('skipped');
    cleanup();
    await mount();
    expect(screen.getByText('Your first post is scheduled')).toBeTruthy();
    expect(screen.queryByTestId('tour-card')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Take a quick tour' }));
    expect(title()).toBe('Research starts in Radar');
  });

  it('ACT9/TOUR5 a tour kept as seen before skipped and completed were told apart still counts; nothing else blocks the first one', async () => {
    window.localStorage.setItem(TOUR_KEY, '1');
    await mount();
    expect(screen.queryByTestId('tour-card')).toBeNull();
    cleanup();
    window.localStorage.clear();
    window.localStorage.setItem('content-studio-setup-draft:org-1', '{}');
    window.localStorage.setItem('content-studio-setup-hidden:org-1', '1');
    await mount();
    expect(title()).toBe('Research starts in Radar');
  });
});

describe('After the first post: the getting-started list on Home', () => {
  const task = (key: string) =>
    document.querySelector(`[data-task="${key}"]`) as HTMLElement;

  it('CL1 appears once the first post was saved as a draft, scheduled or published; not for a draft made only here', async () => {
    window.localStorage.setItem(TOUR_KEY, '1');
    state.activated = false;
    await show(ContentStudioGetStarted);
    expect(screen.queryByText('Get more out of Content Studio')).toBeNull();
    cleanup();
    state.saved = true;
    await show(ContentStudioGetStarted);
    expect(screen.getByText('Get more out of Content Studio')).toBeTruthy();
    cleanup();
    state = { ...state, saved: false, activated: true };
    await show(ContentStudioGetStarted);
    expect(screen.getByText('Get more out of Content Studio')).toBeTruthy();
  });

  it('CL2-CL7 every task is done by doing it, and leads to where it is done', async () => {
    window.localStorage.setItem(TOUR_KEY, '1');
    await show(ContentStudioGetStarted);
    expect(task('setup').getAttribute('data-done')).toBe('true');
    expect(task('first_draft').getAttribute('data-done')).toBe('true');
    expect(task('first_post').getAttribute('data-done')).toBe('true');
    expect(screen.getByText('3 of 7 done')).toBeTruthy();
    const link = (name: string) =>
      screen.getByRole('link', { name }).getAttribute('href');
    expect(link('Add your first Knowledge source')).toBe(
      '/content-studio/sources'
    );
    expect(link('Set your research focus')).toBe(
      '/content-studio/first-post?refine=1'
    );
    expect(link('Create a visual in Creative Studio')).toBe(
      '/content-studio/designs'
    );
    expect(link('Decide whether posts need approval')).toBe(
      '/content-studio/intelligence?tab=editorial'
    );
    // done from the organization's data, nothing ticked by hand
    cleanup();
    state = {
      ...state,
      sources: 1,
      designs: 1,
      policy: {
        ...POLICY,
        research: { lookFor: ['x'], avoid: [], freshness: 'week', angles: [] },
      },
    };
    await show(ContentStudioGetStarted);
    for (const key of ['knowledge', 'research', 'visual']) {
      expect(task(key).getAttribute('data-done')).toBe('true');
    }
    expect(task('approval').getAttribute('data-done')).toBe('false');
    expect(screen.getByText('6 of 7 done')).toBeTruthy();
  });

  it('starts the tour once on Home when the first post succeeded elsewhere, and can be hidden', async () => {
    await show(ContentStudioGetStarted);
    expect(title()).toBe('Research starts in Radar');
    fireEvent.click(within(card()).getByRole('button', { name: 'Skip tour' }));
    await flush();
    fireEvent.click(
      screen.getByRole('button', { name: 'Take the tour again' })
    );
    expect(title()).toBe('Research starts in Radar');
    fireEvent.click(within(card()).getByRole('button', { name: 'Skip tour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide this list' }));
    await flush();
    expect(screen.queryByText('Get more out of Content Studio')).toBeNull();
    expect(
      window.localStorage.getItem('content-studio-checklist-hidden:org-1')
    ).toBe('1');
  });

  it('keeps no flag for what the data says: only the tour, the hidden list, a deliberate "no approval" and, for this visit, "not now" and exploring are remembered', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'content-studio.onboarding.tsx'),
      'utf8'
    );
    const keys = source.match(/`content-studio-[a-z-]+:/g);
    // approval switched off has no form in the policy (activation review
    // 02): the decision itself is the one thing the data cannot say
    expect(keys).toEqual([
      '`content-studio-tour:',
      '`content-studio-checklist-hidden:',
      '`content-studio-no-approval:',
      // sessionStorage: this visit only
      '`content-studio-first-post-not-now:',
      '`content-studio-first-post-explored:',
    ]);
    // saved, scheduled or published is read from the server, never kept
    expect(source).not.toMatch(/activated'|savedAsDraft'|scheduled'/);
    expect(source).not.toMatch(/method: 'POST'|\/posts|integrations/);
  });
});

// Activation review 02: a decision about approval counts either way, and
// the tour is never lost
describe('After the first post: approval is a decision either way', () => {
  const task = (key: string) =>
    document.querySelector(`[data-task="${key}"]`) as HTMLElement;
  beforeEach(() => {
    window.localStorage.setItem(TOUR_KEY, '1');
  });

  it('A1 approval switched on in the editorial policy: decided', async () => {
    state.policy = { ...POLICY, workflow: { requireApprovalForHandoff: true } };
    await show(ContentStudioGetStarted);
    expect(task('approval').getAttribute('data-done')).toBe('true');
  });

  it('A2 "No approval needed" is a decision too, and stays one', async () => {
    await show(ContentStudioGetStarted);
    fireEvent.click(
      within(task('approval')).getByRole('button', {
        name: 'No approval needed',
      })
    );
    await flush();
    expect(task('approval').getAttribute('data-done')).toBe('true');
    expect(
      window.localStorage.getItem('content-studio-no-approval:org-1')
    ).toBe('1');
    cleanup();
    await show(ContentStudioGetStarted);
    expect(task('approval').getAttribute('data-done')).toBe('true');
    // nothing was written to the policy
    expect(
      mockFetch.mock.calls.some(([, init]) => init?.method === 'POST')
    ).toBe(false);
  });

  it('A3 never looked at: still open, with both choices', async () => {
    await show(ContentStudioGetStarted);
    expect(task('approval').getAttribute('data-done')).toBe('false');
    expect(
      within(task('approval')).getByRole('link', {
        name: 'Decide whether posts need approval',
      })
    ).toBeTruthy();
    expect(
      within(task('approval')).getByRole('button', {
        name: 'No approval needed',
      })
    ).toBeTruthy();
  });
});

// Activation review 11 (iPhone Safari): the policy stores whether approval
// is required, never who approves (every member may decide), so the task
// promises that decision only, and leads to where it is made
describe('After the first post: the approval task says what it decides', () => {
  const task = () =>
    document.querySelector('[data-task="approval"]') as HTMLElement;
  beforeEach(() => {
    window.localStorage.setItem(TOUR_KEY, '1');
  });

  it('APPROVAL-COPY1 asks whether posts need approval, never who approves, and opens the Editorial Policy', async () => {
    await show(ContentStudioGetStarted);
    const link = within(task()).getByRole('link', {
      name: 'Decide whether posts need approval',
    });
    expect(link.getAttribute('href')).toBe(
      '/content-studio/intelligence?tab=editorial'
    );
    expect(task().textContent).toContain(
      'Choose whether a post must be approved before it goes to publishing (Require approval before handoff, under Editorial Policy), or confirm that no approval is needed.'
    );
    expect(task().textContent).not.toMatch(/who approves|approver/i);
    expect(
      within(task()).getByRole('button', { name: 'No approval needed' })
    ).toBeTruthy();
  });

  it('APPROVAL-COPY2 the English translations match the text in the code', () => {
    const en = JSON.parse(
      require('fs').readFileSync(
        require('path').join(
          __dirname,
          '../../../../../libraries/react-shared-libraries/src/translation/locales/en/translation.json'
        ),
        'utf8'
      )
    );
    expect(en.content_studio_get_started_approval).toBe(
      'Decide whether posts need approval'
    );
    expect(en.content_studio_get_started_approval_hint).toBe(
      'Choose whether a post must be approved before it goes to publishing (Require approval before handoff, under Editorial Policy), or confirm that no approval is needed.'
    );
    // the setting the hint names, in the policy form
    expect(
      require('fs').readFileSync(
        require('path').join(
          __dirname,
          'intelligence/content-studio.editorial-policy.tsx'
        ),
        'utf8'
      )
    ).toContain("'Require approval before handoff'");
  });
});

// Activation review 11 (iPhone Safari): the steps scroll the navigation row
// to their sections, so a tour ended on Home left the Home pill current but
// off the screen. The row on a phone: 350px wide from x 20, six pills of
// 90px every 100px (590px, so it scrolls up to 240px)
describe('After the first post: the tour gives the navigation back', () => {
  const SECTIONS = ['home', 'sources', 'radar', 'creative', 'reviews', 'brand'];
  const fakeRow = (current: string | null) => {
    const nav = document.createElement('nav');
    let scroll = 0;
    Object.defineProperty(nav, 'clientWidth', { value: 350 });
    Object.defineProperty(nav, 'scrollLeft', {
      configurable: true,
      get: () => scroll,
      set: (value: number) => {
        scroll = Math.min(Math.max(0, value), 240);
      },
    });
    nav.getBoundingClientRect = () =>
      ({ top: 20, left: 20, width: 350, height: 44 } as DOMRect);
    SECTIONS.forEach((section, index) => {
      const pill = document.createElement('a');
      pill.dataset.csSection = section;
      if (section === current) {
        pill.setAttribute('aria-current', 'page');
      }
      pill.getBoundingClientRect = () =>
        ({
          top: 20,
          left: 20 + index * 100 - scroll,
          width: 90,
          height: 40,
        } as DOMRect);
      // what the browser does for the step: the pill to the middle
      pill.scrollIntoView = () => {
        nav.scrollLeft = index * 100 - (350 - 90) / 2;
      };
      nav.appendChild(pill);
    });
    document.body.appendChild(nav);
    return nav;
  };
  const homeInView = () => {
    const left = (
      document.querySelector('[data-cs-section="home"]') as HTMLElement
    ).getBoundingClientRect().left;
    return left >= 20 && left + 90 <= 370;
  };
  const toLastStep = () => {
    for (let step = 1; step < CONTENT_STUDIO_TOUR.length; step++) {
      fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    }
    expect(title()).toBe('Approvals');
  };
  // the frames by hand: what the tour asks for when it closes happens only
  // when the browser draws the next frames, and nothing before
  let frames = new Map<number, FrameRequestCallback>();
  let lastFrame = 0;
  const nextFrame = () =>
    act(() => {
      const due = [...frames.values()];
      frames = new Map();
      due.forEach((callback) => callback(0));
    });
  let row: HTMLElement;
  let pageScroll: jest.SpyInstance;
  let pillScroll: number;
  beforeEach(() => {
    frames = new Map();
    jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.set(++lastFrame, callback);
        return lastFrame;
      });
    jest
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((frame) => frames.delete(frame));
    pageScroll = jest.spyOn(window, 'scrollTo').mockImplementation(() => {
      // the page itself never scrolls
    });
  });
  afterEach(() => {
    row?.remove();
    jest.restoreAllMocks();
  });
  const countPillScrolls = (nav: HTMLElement) => {
    pillScroll = 0;
    nav.querySelectorAll<HTMLElement>('[data-cs-section]').forEach((pill) => {
      const scroll = pill.scrollIntoView;
      pill.scrollIntoView = (...args) => {
        pillScroll++;
        scroll.apply(pill, args);
      };
    });
  };
  // after the tour is gone: the row is still where the last step left it in
  // the update that removed the tour and in the frame that draws that, and
  // the page's own section is shown in the frame after, by the row alone
  const homeComesBackAfterTheTour = async () => {
    await flush();
    expect(screen.queryByTestId('tour-card')).toBeNull();
    expect(screen.queryByTestId('tour-highlight')).toBeNull();
    expect(row.scrollLeft).toBe(240);
    countPillScrolls(row);
    await nextFrame();
    expect(row.scrollLeft).toBe(240);
    await nextFrame();
    expect(row.scrollLeft).toBe(0);
    expect(homeInView()).toBe(true);
    expect(
      document
        .querySelector('[data-cs-section="home"]')
        ?.getAttribute('aria-current')
    ).toBe('page');
    expect(pillScroll).toBe(0);
    expect(pageScroll).not.toHaveBeenCalled();
    // swiped by hand afterwards: the row stays where it is left
    row.scrollLeft = 150;
    for (let i = 0; i < 5; i++) {
      await nextFrame();
    }
    expect(row.scrollLeft).toBe(150);
    // nothing keeps running: no frame asks for the row again
    expect(frames.size).toBe(0);
  };

  it('NAV-TOUR1/SAFARI-NAV1/SAFARI-NAV10 Done on Home, the route unchanged: Home comes back into view in the frame after the tour is gone', async () => {
    window.localStorage.setItem(TOUR_KEY, '1');
    row = fakeRow('home');
    // swiped to the far right by hand before the tour
    row.scrollLeft = 240;
    await show(ContentStudioGetStarted);
    fireEvent.click(
      screen.getByRole('button', { name: 'Take the tour again' })
    );
    await nextFrame();
    toLastStep();
    expect(row.scrollLeft).toBe(240);
    expect(homeInView()).toBe(false);
    fireEvent.click(within(card()).getByRole('button', { name: 'Done' }));
    await homeComesBackAfterTheTour();
    expect(window.localStorage.getItem(TOUR_KEY)).toBe('completed');
  });

  it('NAV-TOUR2/SAFARI-NAV2/SAFARI-NAV3 Skip tour, or Escape, halfway: Home comes back into view the same way', async () => {
    window.localStorage.setItem(TOUR_KEY, '1');
    row = fakeRow('home');
    await show(ContentStudioGetStarted);
    for (const close of [
      () =>
        fireEvent.click(
          within(card()).getByRole('button', { name: 'Skip tour' })
        ),
      () => fireEvent.keyDown(document, { key: 'Escape' }),
    ]) {
      fireEvent.click(
        screen.getByRole('button', { name: 'Take the tour again' })
      );
      fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
      fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
      fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
      expect(title()).toBe('Creative Studio');
      // the row swiped on to its far end by hand during the step
      row.scrollLeft = 240;
      expect(homeInView()).toBe(false);
      close();
      await homeComesBackAfterTheTour();
      expect(window.localStorage.getItem(TOUR_KEY)).toBe('skipped');
    }
  });

  it('NAV-TOUR3 on the first post page (no current section) the row is left alone, and Done still goes to Home', async () => {
    row = fakeRow(null);
    await show(ContentStudioFirstPostPage);
    toLastStep();
    fireEvent.click(within(card()).getByRole('button', { name: 'Done' }));
    await flush();
    for (let i = 0; i < 3; i++) {
      await nextFrame();
    }
    expect(row.scrollLeft).toBe(240);
    expect(mockRouter.push).toHaveBeenCalledWith('/content-studio');
  });
});

// Activation review 11: a calm pulse around the highlighted section, on a
// pseudo-element of the highlight only, and none without motion
describe('After the first post: the tour highlight', () => {
  const css = () =>
    require('fs').readFileSync(
      require('path').join(__dirname, '../../app/global.scss'),
      'utf8'
    ) as string;

  it('TOURPULSE1 the highlight keeps its ring and carries the pulse class', async () => {
    const row = document.createElement('a');
    row.dataset.csSection = 'radar';
    row.getBoundingClientRect = () =>
      ({ top: 20, left: 20, width: 90, height: 40 } as DOMRect);
    document.body.appendChild(row);
    try {
      await show(ContentStudioFirstPostPage);
      const highlight = screen.getByTestId('tour-highlight');
      expect(highlight.className).toContain('content-studio-tour-highlight');
      expect(highlight.className).toContain('ring-2');
      expect(highlight.getAttribute('aria-hidden')).toBe('true');
      expect(highlight.className).toContain('pointer-events-none');
    } finally {
      row.remove();
    }
  });

  it('TOURPULSE2-TOURPULSE5 only a shadow and its opacity move, on the pseudo-element, and only where motion is allowed', () => {
    const all = css();
    const start = all.indexOf('@keyframes content-studio-tour-pulse');
    const media = all.indexOf(
      '@media (prefers-reduced-motion: no-preference)',
      start
    );
    const keyframes = all.slice(start, media);
    expect(keyframes).toContain('box-shadow');
    expect(keyframes).not.toMatch(
      /transform|width|height|top|left|margin|padding|inset/
    );
    const rule = all.slice(media);
    expect(rule).toMatch(
      /^@media \(prefers-reduced-motion: no-preference\) \{\s*\.content-studio-tour-highlight::after \{/
    );
    expect(rule).toContain('animation: content-studio-tour-pulse 2.4s');
    // the animation is nowhere else, so reduced motion keeps the ring still
    expect(all.match(/content-studio-tour-pulse/g)).toHaveLength(2);
  });
});

describe('After the first post: the tour is never lost', () => {
  it('TOUR1 an organization whose first post is not out yet gets no tour, on Home or the first post', async () => {
    state.activated = false;
    await show(ContentStudioGetStarted);
    expect(screen.queryByTestId('tour-card')).toBeNull();
    expect(screen.queryByRole('button', { name: /tour/i })).toBeNull();
    cleanup();
    await show(ContentStudioFirstPostPage);
    expect(screen.queryByTestId('tour-card')).toBeNull();
  });

  it('TOUR2 the first scheduled or published post starts it, once', async () => {
    await show(ContentStudioGetStarted);
    expect(title()).toBe('Research starts in Radar');
  });

  it('TOUR4 with the list hidden or done, the tour can still be taken again from Home', async () => {
    window.localStorage.setItem(TOUR_KEY, '1');
    window.localStorage.setItem('content-studio-checklist-hidden:org-1', '1');
    await show(ContentStudioGetStarted);
    expect(screen.queryByText('Get more out of Content Studio')).toBeNull();
    expect(screen.queryByTestId('tour-card')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Take the tour' }));
    expect(title()).toBe('Research starts in Radar');
  });

  it('TOUR5 only finishing or skipping it here stops it: other keys (another organization, the hidden list) never do', async () => {
    window.localStorage.setItem('content-studio-tour:org-2', '1');
    window.localStorage.setItem('content-studio-checklist-hidden:org-1', '1');
    await show(ContentStudioGetStarted);
    expect(title()).toBe('Research starts in Radar');
  });
});

// Activation review 04: a first post saved as a draft is progress, not the
// success. The page says it is saved, opens the same post to schedule it,
// and lets the user go on exploring; Home keeps reminding until it is
// scheduled or published
describe('A first post saved as a draft', () => {
  const cache = new Map();
  const mount = async (component: unknown = ContentStudioFirstPostPage) => {
    render(
      h(
        SWRConfig,
        { value: { provider: () => cache, dedupingInterval: 0 } },
        h(component as never)
      )
    );
    await flush();
  };
  const writes = () =>
    mockFetch.mock.calls.filter(
      ([, init]) => init?.method && init.method !== 'GET'
    );
  beforeEach(() => {
    cache.clear();
    state.activated = false;
    state.saved = true;
  });

  it('D1/D2/D3/SCHED1 back from the composer with a DRAFT: "Your first post is saved", its draft date (never "scheduled"), and Schedule my first post opens the same post', async () => {
    await mount();
    const saved = screen.getByTestId('first-post-saved');
    expect(within(saved).getByRole('heading').textContent).toBe(
      'Your first post is saved'
    );
    expect(
      within(saved).getByText(
        'The draft is safe. You can schedule it now or come back to it later.'
      )
    ).toBeTruthy();
    expect(
      within(saved).getByText(
        /^Draft date: Nov 25, 2026 \d\d:\d\d\. It stays a draft and will not be published until you schedule it\.$/
      )
    ).toBeTruthy();
    // the primary action, first: the same post in the composer
    const links = within(saved).getAllByRole('link');
    expect(links[0].textContent).toBe('Schedule my first post');
    expect(links[0].getAttribute('href')).toBe(SAVED_PATH);
    expect(
      within(saved).getByRole('button', {
        name: 'Continue exploring Content Studio',
      })
    ).toBeTruthy();
    // not the success, no tour by itself, nothing says scheduled
    expect(screen.queryByText('Your first post is scheduled')).toBeNull();
    expect(screen.queryByText(/scheduled for/i)).toBeNull();
    expect(screen.queryByTestId('tour-card')).toBeNull();
    // no new handoff from here: that would make a second post
    expect(
      screen.queryByRole('button', { name: 'Review and schedule' })
    ).toBeNull();
  });

  it('ONB1/ONB4/ONB6 the saved state starts nothing: no research, no draft, no write; the drafts stay readable, another angle stays possible', async () => {
    await mount();
    expect(writes()).toEqual([]);
    expect(screen.getByText('Your drafts')).toBeTruthy();
    expect(screen.getByText('Draft 2')).toBeTruthy();
    expect(screen.getByText('Draft 1')).toBeTruthy();
    // the saved post is what gets scheduled: no draft is put back from here
    expect(screen.queryByRole('button', { name: 'Use this draft' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Try another angle' })
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Refine my research' })
    ).toBeTruthy();
    // never sent to setup
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('D4/D5 Continue exploring starts the same five-step tour on purpose; finishing it goes Home, and the first post is still saved, not done', async () => {
    mockRouter.push.mockClear();
    await mount();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue exploring Content Studio' })
    );
    const seen = [title()];
    for (let i = 1; i < CONTENT_STUDIO_TOUR.length; i++) {
      fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
      seen.push(title());
    }
    expect(seen).toEqual([
      'Research starts in Radar',
      'Home',
      'Knowledge',
      'Creative Studio',
      'Approvals',
    ]);
    fireEvent.click(within(card()).getByRole('button', { name: 'Done' }));
    await flush();
    expect(window.localStorage.getItem(TOUR_KEY)).toBe('completed');
    expect(mockRouter.push).toHaveBeenCalledWith('/content-studio');
    expect(
      window.sessionStorage.getItem('content-studio-first-post-explored:org-1')
    ).toBe('1');
    // the server still says DRAFT: saved, not the success
    cleanup();
    await mount();
    expect(screen.getByTestId('first-post-saved')).toBeTruthy();
    expect(screen.queryByText('Your first post is scheduled')).toBeNull();
    expect(screen.queryByTestId('tour-card')).toBeNull();
  });

  it('D5 skipping the tour from there is the same: Home, still saved', async () => {
    mockRouter.push.mockClear();
    await mount();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue exploring Content Studio' })
    );
    fireEvent.click(within(card()).getByRole('button', { name: 'Skip tour' }));
    await flush();
    expect(window.localStorage.getItem(TOUR_KEY)).toBe('skipped');
    expect(mockRouter.push).toHaveBeenCalledWith('/content-studio');
  });

  it('SCHED4/SCHED5 scheduled later (QUEUE): the return shows the success; the tour starts by itself unless it was taken already', async () => {
    await mount();
    expect(screen.getByTestId('first-post-saved')).toBeTruthy();
    cleanup();
    state = { ...state, saved: false, activated: true };
    await mount();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    await flush();
    expect(screen.getByText('Your first post is scheduled')).toBeTruthy();
    expect(title()).toBe('Research starts in Radar');
    // taken while it was saved: the success only, and the tour at hand
    cleanup();
    window.localStorage.setItem(TOUR_KEY, 'completed');
    await mount();
    expect(screen.getByText('Your first post is scheduled')).toBeTruthy();
    expect(screen.queryByTestId('tour-card')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Take a quick tour' })
    ).toBeTruthy();
  });

  it('research made after the post was saved: the new draft is ready, and the saved post is still named with its draft date', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (
        new URL(url, 'https://api.test').pathname !==
        '/content-studio/activation/first-post'
      ) {
        return server(url);
      }
      const value = firstPost(false, true);
      return reply(200, {
        ...value,
        research: {
          ...value.research,
          completedAt: '2026-10-31T09:00:00.000Z',
        },
      });
    });
    await mount();
    expect(screen.queryByTestId('first-post-saved')).toBeNull();
    const notice = screen.getByTestId('first-post-saved-as-draft');
    expect(
      within(notice).getByText('Your earlier post is saved as a draft')
    ).toBeTruthy();
    expect(within(notice).getByText(/^Draft date: Nov 25, 2026/)).toBeTruthy();
    expect(
      within(notice)
        .getByRole('link', { name: 'Schedule that post' })
        .getAttribute('href')
    ).toBe(SAVED_PATH);
    expect(
      screen.getByRole('button', { name: 'Review and schedule' })
    ).toBeTruthy();
  });

  it('D6/D7 Home reminds on every visit: "Your first post is still waiting", Review and schedule opens the same post, Not now is for this visit only', async () => {
    await mount(ContentStudioFirstPostReminder);
    const reminder = screen.getByTestId('first-post-reminder');
    expect(within(reminder).getByRole('heading').textContent).toBe(
      'Your first post is still waiting'
    );
    expect(
      within(reminder).getByText(
        'You created your first AI-researched post. Want to review it once more and schedule it?'
      )
    ).toBeTruthy();
    expect(
      within(reminder)
        .getByRole('link', { name: 'Review and schedule' })
        .getAttribute('href')
    ).toBe(SAVED_PATH);
    fireEvent.click(within(reminder).getByRole('button', { name: 'Not now' }));
    expect(screen.queryByTestId('first-post-reminder')).toBeNull();
    // the same visit: still away
    cleanup();
    await mount(ContentStudioFirstPostReminder);
    expect(screen.queryByTestId('first-post-reminder')).toBeNull();
    // the next visit (a new browser session): back
    cleanup();
    window.sessionStorage.clear();
    await mount(ContentStudioFirstPostReminder);
    expect(screen.getByTestId('first-post-reminder')).toBeTruthy();
  });

  it('D6/B9/B18 after exploring and finishing the tour, still a draft: Home says the draft is ready and waits to be scheduled', async () => {
    window.localStorage.setItem(TOUR_KEY, 'completed');
    window.sessionStorage.setItem(
      'content-studio-first-post-explored:org-1',
      '1'
    );
    await mount(ContentStudioFirstPostReminder);
    const reminder = screen.getByTestId('first-post-reminder');
    expect(within(reminder).getByRole('heading').textContent).toBe(
      'Your first post is waiting'
    );
    expect(
      within(reminder).getByText(
        "Your AI-researched draft is ready. Review it and schedule it when you're ready."
      )
    ).toBeTruthy();
  });

  it('no reminder once it is scheduled or published, or before anything was saved', async () => {
    state = { ...state, saved: false, activated: true };
    await mount(ContentStudioFirstPostReminder);
    expect(screen.queryByTestId('first-post-reminder')).toBeNull();
    cleanup();
    cache.clear();
    state = { ...state, saved: false, activated: false };
    await mount(ContentStudioFirstPostReminder);
    expect(screen.queryByTestId('first-post-reminder')).toBeNull();
  });

  it('CL1/CL2 the list: the AI draft is done, scheduling it is not, and leads to the same post; the tour does not start by itself', async () => {
    await mount(ContentStudioGetStarted);
    const task = (key: string) =>
      document.querySelector(`[data-task="${key}"]`) as HTMLElement;
    expect(task('setup').getAttribute('data-done')).toBe('true');
    expect(task('first_draft').getAttribute('data-done')).toBe('true');
    expect(task('first_draft').textContent).toContain(
      'Create your first AI-researched post'
    );
    expect(task('first_post').getAttribute('data-done')).toBe('false');
    expect(
      within(task('first_post'))
        .getByRole('link', { name: 'Schedule or publish your first post' })
        .getAttribute('href')
    ).toBe(SAVED_PATH);
    expect(screen.queryByTestId('tour-card')).toBeNull();
  });

  it('CL3/CL4 scheduled or published: both done', async () => {
    for (const published of [false, true]) {
      cleanup();
      cache.clear();
      window.localStorage.setItem(TOUR_KEY, 'completed');
      mockFetch.mockImplementation(async (url: string) =>
        new URL(url, 'https://api.test').pathname ===
        '/content-studio/activation/first-post'
          ? reply(200, {
              ...firstPost(true),
              firstPost: {
                scheduled: !published,
                published,
                savedAsDraft: null,
              },
            })
          : server(url)
      );
      await mount(ContentStudioGetStarted);
      for (const key of ['first_draft', 'first_post']) {
        expect(
          (
            document.querySelector(`[data-task="${key}"]`) as HTMLElement
          ).getAttribute('data-done')
        ).toBe('true');
      }
    }
  });
});
