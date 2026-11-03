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

// The first post (activation flow 01): the page that owns the research and
// draft made on the server after the guided setup, the draft with why its
// topic was chosen, another angle, the research refinement and the way to
// the composer. A .spec.ts without JSX, like the other Content Studio
// frontend specs

const mockRouter = { replace: jest.fn(), push: jest.fn() };
let mockParams = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  usePathname: () => '/content-studio/first-post',
  useSearchParams: () => mockParams,
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

const {
  ContentStudioFirstPost,
  firstPostDraftPath,
  firstPostPhase,
} = require('./content-studio.first-post');

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const T0 = '2026-10-30T10:00:00.000Z';
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
const PROVIDERS = [
  {
    provider: 'codex',
    displayName: 'Codex (ChatGPT sign-in)',
    credentialFields: [],
    defaultModel: 'gpt-6.1-sol',
    models: [],
  },
];
const PACKAGE = '55555555-5555-4555-8555-555555555555';
const RESEARCH = {
  topic: 'AI in het mkb',
  angle: 'Wat werkt echt',
  summary: 'Samenvatting',
  why: {
    audience: 'Eigenaren willen resultaat',
    expertise: 'Wij automatiseren dagelijks',
    timing: 'Net verschenen',
  },
  sources: [
    {
      title: 'Radar article',
      url: 'https://news.example/ai',
      publisher: 'Nieuws',
      publishedAt: '2026-10-28',
      origin: 'radar',
    },
  ],
  sourceBacked: true,
};
const POLICY = {
  schemaVersion: 1,
  principles: ['Show expertise'],
  prohibitedTopics: [],
  claimRules: [],
  ctaRules: [],
  formatConventions: [],
  complianceNotes: '',
  workflow: { requireApprovalForHandoff: true },
};

const ready = (patch: Record<string, unknown> = {}) => ({
  packageId: PACKAGE,
  package: {
    name: 'First post',
    draftVersion: 3,
    archived: false,
    text: 'Eerste post over AI.',
  },
  research: {
    operationId: 'r1',
    status: 'succeeded',
    completedAt: T0,
    result: RESEARCH,
  },
  draft: { operationId: 'd1', status: 'succeeded', applied: true },
  firstPost: { scheduled: false, published: false },
  activated: false,
  ...patch,
});

let state: {
  firstPost: unknown;
  policy: { latestRevisionNumber: number; content: unknown };
  start?: () => Reply;
};

const server = (method: string, url: string, body: any): Reply => {
  const { pathname } = new URL(url, 'https://api.test');
  if (pathname === '/content-studio/activation/first-post') {
    if (method === 'GET') {
      return reply(200, state.firstPost);
    }
    return state.start?.() ?? reply(202, { packageId: PACKAGE });
  }
  if (pathname === '/content-studio/ai/providers') {
    return reply(200, PROVIDERS);
  }
  if (pathname === '/content-studio/ai/connections') {
    return reply(200, [CONNECTION]);
  }
  if (pathname === '/content-studio/editorial-policy' && method === 'GET') {
    return reply(200, {
      latestRevisionNumber: state.policy.latestRevisionNumber,
      currentRevision: state.policy.content
        ? {
            id: 'p',
            revisionNumber: state.policy.latestRevisionNumber,
            schemaVersion: 1,
            contentHash: 'h',
            createdAt: T0,
            content: state.policy.content,
          }
        : null,
    });
  }
  if (pathname === '/content-studio/editorial-policy/revisions') {
    state.policy = {
      latestRevisionNumber: state.policy.latestRevisionNumber + 1,
      content: body.content,
    };
    return reply(201, { created: true, latestRevisionNumber: 2 });
  }
  if (pathname === `/content-studio/packages/${PACKAGE}/revisions`) {
    return reply(201, { created: true, revision: { id: 'rev-1' } });
  }
  if (
    pathname === `/content-studio/packages/${PACKAGE}/revisions/rev-1/handoffs`
  ) {
    return reply(201, { id: 'a'.repeat(64), expiresAt: T0 });
  }
  return reply(404, { code: 'CS_NOT_FOUND' });
};

const calls = () =>
  mockFetch.mock.calls.map(([url, init]) => ({
    method: (init?.method as string) || 'GET',
    url: url as string,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  }));
const posts = (url: string) =>
  calls().filter((c) => c.method === 'POST' && c.url === url);

const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
const show = async () => {
  render(
    h(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      h(ContentStudioFirstPost)
    )
  );
  await flush();
};
const button = (name: string | RegExp) =>
  screen.getByRole('button', { name }) as HTMLButtonElement;

beforeEach(() => {
  mockParams = new URLSearchParams();
  state = {
    firstPost: ready(),
    policy: { latestRevisionNumber: 1, content: POLICY },
  };
  mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) =>
    server(
      init.method || 'GET',
      url,
      init.body ? JSON.parse(init.body as string) : undefined
    )
  );
});

afterEach(async () => {
  cleanup();
  await flush();
  mockFetch.mockReset();
});

describe('First post: where it stands', () => {
  const NOW = new Date(T0).getTime();
  const at = (patch: Record<string, unknown>) =>
    firstPostPhase(ready(patch), NOW);

  it('reads the phase from the server state, never from the browser', () => {
    expect(
      firstPostPhase({
        packageId: null,
        research: null,
        draft: null,
        firstPost: { scheduled: false, published: false },
        activated: false,
      })
    ).toBe('none');
    expect(
      at({
        research: { operationId: 'r', status: 'running', completedAt: null },
      })
    ).toBe('researching');
    expect(
      at({
        research: {
          operationId: 'r',
          status: 'failed',
          code: 'CS_AI_TIMEOUT',
          completedAt: T0,
        },
        draft: null,
      })
    ).toBe('research_failed');
    // the draft starts right after the research
    expect(at({ draft: null })).toBe('drafting');
    expect(firstPostPhase(ready({ draft: null }), NOW + 3 * 60 * 1000)).toBe(
      'draft_failed'
    );
    expect(at({ draft: { operationId: 'd', status: 'running' } })).toBe(
      'drafting'
    );
    expect(
      at({
        draft: { operationId: 'd', status: 'failed', code: 'CS_AI_TIMEOUT' },
      })
    ).toBe('draft_failed');
    expect(
      at({
        draft: { operationId: 'd', status: 'succeeded', applied: false },
        package: { name: 'x', draftVersion: 1, archived: false, text: '' },
      })
    ).toBe('not_placed');
    // text the user wrote over the draft is theirs: ready, not "not placed"
    expect(
      at({ draft: { operationId: 'd', status: 'succeeded', applied: false } })
    ).toBe('ready');
    expect(at({})).toBe('ready');
  });

  it('AC1/AC4 only a scheduled or published post is the success', () => {
    expect(at({})).toBe('ready');
    expect(
      at({
        activated: true,
        firstPost: { scheduled: true, published: false },
      })
    ).toBe('activated');
  });
});

// Activation review 04: saved in the composer as a draft is progress, said
// as its own state; only QUEUE or PUBLISHED is the success
describe('First post: saved as a draft', () => {
  const NOW = new Date(T0).getTime();
  const SAVED = {
    publishDate: '2026-11-25T07:20:00.000Z',
    group: 'group-1',
    createdAt: '2026-10-30T22:29:45.106Z',
  };
  const at = (patch: Record<string, unknown>) =>
    firstPostPhase(ready(patch), NOW);

  it('D1/SCHED1 a DRAFT with a future date is saved, never activated or scheduled', () => {
    expect(
      at({
        research: {
          ...ready().research,
          completedAt: '2026-10-30T22:23:46.952Z',
        },
        firstPost: { scheduled: false, published: false, savedAsDraft: SAVED },
      })
    ).toBe('saved');
  });

  it('SCHED2/SCHED3 QUEUE or PUBLISHED is the success, whatever was saved before', () => {
    for (const firstPost of [
      { scheduled: true, published: false, savedAsDraft: null },
      { scheduled: false, published: true, savedAsDraft: null },
    ]) {
      expect(at({ activated: true, firstPost })).toBe('activated');
    }
  });

  it('research after the post was saved is a new idea: ready again (the saved post is still named there)', () => {
    expect(
      at({
        research: {
          ...ready().research,
          completedAt: '2026-10-31T09:00:00.000Z',
        },
        firstPost: { scheduled: false, published: false, savedAsDraft: SAVED },
      })
    ).toBe('ready');
    // and while it runs, it runs
    expect(
      at({
        research: { operationId: 'r2', status: 'running', completedAt: null },
        firstPost: { scheduled: false, published: false, savedAsDraft: SAVED },
      })
    ).toBe('researching');
  });

  it('the saved post opens again by its group, back to the first post', () => {
    expect(firstPostDraftPath('51766056-e439-4d14-892f-fdf34b26c5b5')).toBe(
      '/launches?post=51766056-e439-4d14-892f-fdf34b26c5b5&return=first-post'
    );
  });
});

describe('First post: research and draft while the user waits or is away', () => {
  it('ACT6 the page owns the running research: never an empty editor', async () => {
    state.firstPost = ready({
      research: { operationId: 'r', status: 'running', completedAt: null },
      draft: null,
    });
    await show();
    expect(
      screen.getByText('Researching a relevant topic for your audience…')
    ).toBeTruthy();
    expect(
      screen.getByText('Turning the strongest angle into your first post…')
    ).toBeTruthy();
    expect(
      screen.getByText(/switch to another app or leave this page/)
    ).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('ACT6 then the topic is chosen and the draft is being written', async () => {
    state.firstPost = ready({ draft: { operationId: 'd', status: 'running' } });
    await show();
    expect(screen.getByText('Topic chosen: AI in het mkb')).toBeTruthy();
    expect(
      screen
        .getByText('Turning the strongest angle into your first post…')
        .closest('li')
        ?.getAttribute('data-state')
    ).toBe('current');
  });

  it('ACT7/BG4 a draft that was finished while the user was away is there when they return', async () => {
    await show();
    expect(screen.getByTestId('first-post-text').textContent).toBe(
      'Eerste post over AI.'
    );
    const why = screen.getByText('Why this topic?').closest('details')!;
    expect(within(why).getByText('Eigenaren willen resultaat')).toBeTruthy();
    const source = within(why).getByRole('link', { name: 'Radar article' });
    expect(source.getAttribute('href')).toBe('https://news.example/ai');
    expect(source.getAttribute('rel')).toContain('noopener');
    expect(within(why).getByText(/from your Radar/)).toBeTruthy();
  });

  it('says when no current source was found instead of presenting it as news', async () => {
    state.firstPost = ready({
      research: {
        operationId: 'r',
        status: 'succeeded',
        completedAt: T0,
        result: { ...RESEARCH, sources: [], sourceBacked: false },
      },
    });
    await show();
    expect(
      screen.getByText(/this post builds on your expertise, not on news/)
    ).toBeTruthy();
  });
});

describe('First post: to the composer', () => {
  it('ACT5/N2/NAV2 Review and schedule hands exactly this draft to the real composer, which brings the user back', async () => {
    await show();
    fireEvent.click(button('Review and schedule'));
    await flush();
    expect(
      posts(`/content-studio/packages/${PACKAGE}/revisions`)[0].body
    ).toEqual({ draftVersion: 3, origin: 'handoff' });
    expect(mockRouter.push).toHaveBeenCalledWith(
      `/launches?handoff=${'a'.repeat(64)}&return=first-post`
    );
    // nothing is published or scheduled here
    expect(calls().some((c) => c.url.startsWith('/posts'))).toBe(false);
  });

  it('a policy that asks for approval says so, and the draft stays', async () => {
    const original = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) =>
      url.endsWith('/handoffs')
        ? reply(409, { code: 'CS_APPROVAL_REQUIRED' })
        : original(url, init)
    );
    await show();
    fireEvent.click(button('Review and schedule'));
    await flush();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('asks for approval first');
    // approvals live with the package: the one place it is linked
    expect(
      within(alert)
        .getByRole('link', { name: 'Ask for a review' })
        .getAttribute('href')
    ).toBe(`/content-studio/${PACKAGE}`);
    expect(screen.getByTestId('first-post-text')).toBeTruthy();
  });
});

describe('First post: when it misses the mark', () => {
  it('REF6 Try another angle starts new research with the same preferences', async () => {
    await show();
    fireEvent.click(button('Try another angle'));
    await flush();
    expect(posts('/content-studio/activation/first-post')[0].body).toEqual({
      connectionId: CONNECTION.id,
      mode: 'angle',
    });
    expect(posts('/content-studio/editorial-policy/revisions')).toEqual([]);
  });

  it('REF1/REF2/REF4 Refine my research asks four questions, each with why, saves them with the policy and researches again on the same page', async () => {
    await show();
    expect(
      screen.getByText(
        'Change what Content Studio looks for before creating another draft.'
      )
    ).toBeTruthy();
    fireEvent.click(button('Refine my research'));
    await flush();
    expect(screen.getByText('Question 1 of 4')).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'What should we look for?' })
    ).toBeTruthy();
    expect(
      screen.getByText(/Content Studio uses this to decide which topics/)
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('New What should we look for?'), {
      target: { value: 'Nieuwe wetgeving' },
    });
    fireEvent.click(button('Add What should we look for?'));
    fireEvent.click(button('Next'));
    expect(
      screen.getByRole('heading', { name: 'What should we avoid?' })
    ).toBeTruthy();
    fireEvent.click(button('Next'));
    expect(
      screen.getByRole('heading', { name: 'How fresh should results be?' })
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText('The last month'));
    fireEvent.click(button('Next'));
    expect(
      screen.getByRole('heading', { name: 'What angle fits you?' })
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Myth-busting'));
    fireEvent.click(button('Update research & try again'));
    await flush();
    const [saved] = posts('/content-studio/editorial-policy/revisions');
    expect(saved.body.baseRevisionNumber).toBe(1);
    // the rest of the policy, workflow included, as it was
    expect(saved.body.content).toEqual({
      ...POLICY,
      research: {
        lookFor: ['Nieuwe wetgeving'],
        avoid: [],
        freshness: 'month',
        angles: ['myth_busting'],
      },
    });
    expect(posts('/content-studio/activation/first-post')[0].body).toEqual({
      connectionId: CONNECTION.id,
      mode: 'research',
    });
    // still the first post page, not a dashboard
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(screen.queryByText('Question 4 of 4')).toBeNull();
  });

  it('?refine=1 opens the refinement at once (where the checklist links)', async () => {
    mockParams = new URLSearchParams('refine=1');
    await show();
    expect(screen.getByText('Question 1 of 4')).toBeTruthy();
  });

  it('the refinement starts from the preferences already saved', async () => {
    state.policy.content = {
      ...POLICY,
      research: {
        lookFor: ['Bestaande focus'],
        avoid: [],
        freshness: 'evergreen',
        angles: [],
      },
    };
    await show();
    fireEvent.click(button('Refine my research'));
    await flush();
    expect(screen.getByText('Bestaande focus')).toBeTruthy();
  });
});

describe('First post: every failure says what failed and what to do', () => {
  it('setup saved but the first post could not start', async () => {
    mockParams = new URLSearchParams('error=CS_AI_RATE_LIMITED');
    state.firstPost = {
      packageId: null,
      research: null,
      draft: null,
      firstPost: { scheduled: false, published: false },
      activated: false,
    };
    await show();
    expect(
      screen.getByText(
        "Your profile is saved, but we couldn't create the first post yet."
      )
    ).toBeTruthy();
    fireEvent.click(button('Try research again'));
    await flush();
    expect(posts('/content-studio/activation/first-post')[0].body.mode).toBe(
      'first'
    );
    expect(button('Refine my research')).toBeTruthy();
  });

  it('research failed: its reason, try again or refine', async () => {
    state.firstPost = ready({
      research: {
        operationId: 'r',
        status: 'failed',
        code: 'CS_AI_RATE_LIMITED',
        completedAt: T0,
      },
      draft: null,
    });
    await show();
    expect(
      screen.getByText("We couldn't research a topic for your first post.")
    ).toBeTruthy();
    expect(
      screen.getByText('The AI provider is busy. Wait a moment and try again.')
    ).toBeTruthy();
    fireEvent.click(button('Try research again'));
    await flush();
    expect(posts('/content-studio/activation/first-post')[0].body.mode).toBe(
      'research'
    );
  });

  it('research succeeded but the draft failed: write the post again from the same research', async () => {
    state.firstPost = ready({
      draft: { operationId: 'd', status: 'failed', code: 'CS_AI_TIMEOUT' },
    });
    await show();
    expect(
      screen.getByText("We found a topic, but couldn't write the post yet.")
    ).toBeTruthy();
    expect(screen.getByText('Why this topic?')).toBeTruthy();
    fireEvent.click(button('Write the post again'));
    await flush();
    expect(posts('/content-studio/activation/first-post')[0].body.mode).toBe(
      'draft'
    );
  });

  it('the draft was made but not placed in the post: put it in, without AI', async () => {
    state.firstPost = ready({
      draft: { operationId: 'd', status: 'succeeded', applied: false },
      package: { name: 'x', draftVersion: 2, archived: false, text: '' },
    });
    await show();
    fireEvent.click(button('Put the draft in my post'));
    await flush();
    expect(posts('/content-studio/activation/first-post')[0].body.mode).toBe(
      'apply'
    );
  });
});

describe('First post: the success', () => {
  it('AC2/AC3 a scheduled or published first post is celebrated, not a draft', async () => {
    state.firstPost = ready({
      activated: true,
      firstPost: { scheduled: true, published: false },
    });
    await show();
    expect(screen.getByText('Your first post is scheduled')).toBeTruthy();
    expect(
      screen.getByText(
        'Content Studio used your profile and research preferences to help create it.'
      )
    ).toBeTruthy();
    cleanup();
    state.firstPost = ready({
      activated: true,
      firstPost: { scheduled: false, published: true },
    });
    await show();
    expect(screen.getByText('Your first post is published')).toBeTruthy();
  });
});

describe('First post: review hardening', () => {
  it('a new draft made after the user changed the post waits: "Use the new draft" puts it in', async () => {
    state.firstPost = ready({
      draft: { operationId: 'd', status: 'succeeded', applied: false },
    });
    await show();
    expect(screen.getByTestId('first-post-text').textContent).toBe(
      'Eerste post over AI.'
    );
    fireEvent.click(button('Use the new draft'));
    await flush();
    expect(posts('/content-studio/activation/first-post')[0].body.mode).toBe(
      'apply'
    );
  });

  it('a start already on its way (another tab) is followed, not shown as an error', async () => {
    state.start = () => reply(409, { code: 'CS_FIRST_POST_STARTING' });
    await show();
    fireEvent.click(button('Try another angle'));
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// Activation review 02: one clear purpose, the post before the actions, and
// every draft kept
const ALTERNATIVE_NEW = {
  operationId: '66666666-6666-4666-8666-666666666666',
  completedAt: T0,
  text: 'Eerste post over AI.',
  research: RESEARCH,
  current: true,
};
const ALTERNATIVE_OLD = {
  operationId: '77777777-7777-4777-8777-777777777777',
  completedAt: T0,
  text: 'De oude versie die beter was.',
  research: { ...RESEARCH, topic: 'Het oude onderwerp' },
  current: false,
};

describe('First post: one clear purpose', () => {
  it('N1 has no editor link: the composer is where the post is finished', async () => {
    await show();
    expect(screen.queryByRole('link', { name: /Open in editor/ })).toBeNull();
    expect(
      screen
        .getAllByRole('link')
        .some(
          (link) => link.getAttribute('href') === `/content-studio/${PACKAGE}`
        )
    ).toBe(false);
  });

  it('N5 the way back is on the page: breadcrumbs to Content Studio and the section navigation', async () => {
    await show();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(
      within(crumbs)
        .getByRole('link', { name: 'Content Studio' })
        .getAttribute('href')
    ).toBe('/content-studio');
    expect(
      screen.getByRole('navigation', { name: 'Content Studio' })
    ).toBeTruthy();
  });

  it('the post comes first, then why, then Review and schedule, Try another angle and Refine my research, in that order, each saying what it does', async () => {
    await show();
    const text = screen.getByTestId('first-post-text');
    const why = screen.getByText('Why this topic?');
    const actions = screen.getByTestId('first-post-actions');
    const order = (a: Node, b: Node) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(order(text, why)).toBeTruthy();
    expect(order(why, actions)).toBeTruthy();
    expect(
      within(actions)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual([
      'Review and schedule',
      'Try another angle',
      'Refine my research',
    ]);
    expect(
      within(actions).getByText(
        'Keep the same research focus and create a different post idea. This draft stays available.'
      )
    ).toBeTruthy();
  });
});

describe('First post: earlier drafts are kept', () => {
  it('P2/N4/NAV4/PRES1/PRES2/PRES5 a return from the composer shows the same post and its research again, without starting anything', async () => {
    mockParams = new URLSearchParams();
    await show();
    expect(screen.getByTestId('first-post-text').textContent).toBe(
      'Eerste post over AI.'
    );
    expect(screen.getByText('Why this topic?')).toBeTruthy();
    expect(posts('/content-studio/activation/first-post')).toEqual([]);
  });

  it('P3/NAV4 a ready first post opened again starts no research', async () => {
    state.firstPost = ready({ alternatives: [ALTERNATIVE_NEW] });
    await show();
    await flush();
    expect(
      calls()
        .filter((c) => c.url === '/content-studio/activation/first-post')
        .every((c) => c.method === 'GET')
    ).toBe(true);
  });

  it('P4/P5/PRES3/PRES4 the earlier draft stays listed and is put back on request, without AI', async () => {
    state.firstPost = ready({
      alternatives: [ALTERNATIVE_NEW, ALTERNATIVE_OLD],
    });
    await show();
    const drafts = screen.getByRole('region', { name: 'Your drafts' });
    const items = within(drafts).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('data-current'))).toEqual([
      'true',
      'false',
    ]);
    expect(within(items[0]).getByText('In your post')).toBeTruthy();
    expect(within(items[1]).getByText('Draft 1')).toBeTruthy();
    expect(within(items[1]).getByText('Het oude onderwerp')).toBeTruthy();
    expect(
      within(items[1]).getByText('De oude versie die beter was.')
    ).toBeTruthy();
    // the one in the post has nothing to put back
    expect(within(items[0]).queryByRole('button')).toBeNull();
    fireEvent.click(
      within(items[1]).getByRole('button', { name: 'Use this draft' })
    );
    await flush();
    expect(posts('/content-studio/activation/first-post')[0].body).toEqual({
      connectionId: CONNECTION.id,
      mode: 'apply',
      draftOperationId: ALTERNATIVE_OLD.operationId,
    });
  });

  it('P5 "Why this topic?" explains the draft that is in the post', async () => {
    state.firstPost = ready({
      alternatives: [
        { ...ALTERNATIVE_NEW, current: false },
        { ...ALTERNATIVE_OLD, text: 'Eerste post over AI.', current: true },
      ],
    });
    await show();
    const why = screen.getByText('Why this topic?').closest('details')!;
    expect(within(why).getByText('Het oude onderwerp')).toBeTruthy();
    // a draft the user put back is no change by hand: no "new draft" offer
    expect(
      screen.queryByRole('button', { name: 'Use the new draft' })
    ).toBeNull();
  });

  it('P6 while another draft is made, the earlier ones are said to stay', async () => {
    state.firstPost = ready({
      research: { operationId: 'r2', status: 'running', completedAt: null },
      draft: null,
      alternatives: [ALTERNATIVE_NEW],
    });
    await show();
    expect(
      screen.getByText(
        'Your earlier drafts stay available: you can go back to any of them.'
      )
    ).toBeTruthy();
  });

  it('a single draft shows no list to choose from', async () => {
    state.firstPost = ready({ alternatives: [ALTERNATIVE_NEW] });
    await show();
    expect(screen.queryByRole('region', { name: 'Your drafts' })).toBeNull();
  });
});
