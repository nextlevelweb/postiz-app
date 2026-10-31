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
  ContentStudioGetStarted,
  CONTENT_STUDIO_TOUR,
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
const firstPost = (activated: boolean) => ({
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
  firstPost: { scheduled: activated, published: false },
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
  sources: number;
  designs: number;
  policy: Record<string, unknown>;
};
const server = (url: string) => {
  const { pathname } = new URL(url, 'https://api.test');
  switch (pathname) {
    case '/content-studio/activation/first-post':
      return reply(200, firstPost(state.activated));
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

  it('ACT4/ACT5/ACT6/ACT7 scheduled in the composer: the return reads it again at once, shows the success and starts the tour, without Home', async () => {
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

  it('ACT3 published in the composer: the success says so, and the tour starts', async () => {
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

  it("ACT9 saved as a draft in the composer (Lambert's post): said, with its date and the way to schedule it; no success, no tour", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      new URL(url, 'https://api.test').pathname ===
      '/content-studio/activation/first-post'
        ? reply(200, {
            ...firstPost(false),
            firstPost: {
              scheduled: false,
              published: false,
              savedAsDraft: { publishDate: '2026-11-25T07:20:00.000Z' },
            },
          })
        : server(url)
    );
    await mount();
    const notice = screen.getByTestId('first-post-saved-as-draft');
    expect(
      within(notice).getByText(
        'Your post is saved as a draft, not scheduled yet'
      )
    ).toBeTruthy();
    expect(within(notice).getByText(/Nov 25, 2026/)).toBeTruthy();
    expect(
      within(notice)
        .getByRole('link', { name: 'Open the calendar' })
        .getAttribute('href')
    ).toBe('/launches');
    expect(screen.queryByText('Your first post is scheduled')).toBeNull();
    expect(screen.queryByTestId('tour-card')).toBeNull();
  });
});

describe('After the first post: the getting-started list on Home', () => {
  const task = (key: string) =>
    document.querySelector(`[data-task="${key}"]`) as HTMLElement;

  it('CL1 appears only once the first post was scheduled or published', async () => {
    window.localStorage.setItem(TOUR_KEY, '1');
    state.activated = false;
    await show(ContentStudioGetStarted);
    expect(screen.queryByText('Get more out of Content Studio')).toBeNull();
    cleanup();
    state.activated = true;
    await show(ContentStudioGetStarted);
    expect(screen.getByText('Get more out of Content Studio')).toBeTruthy();
  });

  it('CL2-CL7 every task is done by doing it, and leads to where it is done', async () => {
    window.localStorage.setItem(TOUR_KEY, '1');
    await show(ContentStudioGetStarted);
    expect(task('setup').getAttribute('data-done')).toBe('true');
    expect(task('first_post').getAttribute('data-done')).toBe('true');
    expect(screen.getByText('2 of 6 done')).toBeTruthy();
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
    expect(link('Decide who approves posts')).toBe(
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
    expect(screen.getByText('5 of 6 done')).toBeTruthy();
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

  it('keeps no flag for what the data says: only the tour, the hidden list and a deliberate "no approval" are remembered', () => {
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
    ]);
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
        name: 'Decide who approves posts',
      })
    ).toBeTruthy();
    expect(
      within(task('approval')).getByRole('button', {
        name: 'No approval needed',
      })
    ).toBeTruthy();
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
