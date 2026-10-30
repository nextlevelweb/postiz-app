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
    expect(window.localStorage.getItem(TOUR_KEY)).toBe('1');
  });

  it('TOUR1 the first step is about the research the user just used', async () => {
    await show(ContentStudioFirstPostPage);
    expect(within(card()).getByText(/research focus/)).toBeTruthy();
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

  it('keeps no flag for what the data says: only the tour and the hidden list are remembered', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'content-studio.onboarding.tsx'),
      'utf8'
    );
    const keys = source.match(/`content-studio-[a-z-]+:/g);
    expect(keys).toEqual([
      '`content-studio-tour:',
      '`content-studio-checklist-hidden:',
    ]);
    expect(source).not.toMatch(/method: 'POST'|\/posts|integrations/);
  });
});
