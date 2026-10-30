import {
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

// The setup assistant (product UX foundation): four steps, one AI draft,
// review, and a save that never deletes or overwrites. A .spec.ts without
// JSX, like the other Content Studio frontend specs

const mockRouter = { replace: jest.fn(), push: jest.fn() };
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  usePathname: () => '/content-studio/setup',
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
jest.mock('i18next', () => ({
  __esModule: true,
  default: { resolvedLanguage: 'nl' },
}));

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
const mockOpenModal = jest.fn((params: Omit<MockModal, 'id'>) =>
  mockModals.set([...mockModals.list, { ...params, id: `m${++modalId}` }])
);
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
          ? modal.children(() => mockModals.set([]))
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
// the fallback text, with {{name}} filled in like i18next does
jest.mock('@gitroom/react/translation/get.transation.service.client', () => ({
  useT:
    () => (key: string, fallback?: string, params?: Record<string, unknown>) =>
      (fallback ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) =>
        String(params?.[name] ?? '')
      ),
}));
const mockUser = jest.fn();
jest.mock('@gitroom/frontend/components/layout/user.context', () => ({
  useUser: () => mockUser(),
}));

const { ContentStudioSetupWizard } = require('./content-studio.setup');

// --- server ---
type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const reply = (status: number, body: unknown): Reply => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const T0 = '2026-10-27T10:00:00.000Z';
const PROVIDERS = [
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
    ],
  },
];
const CONNECTION = {
  id: '44444444-4444-4444-8444-444444444444',
  name: 'OpenAI',
  provider: 'openai',
  defaultModel: 'gpt-6.1-sol',
  disabled: false,
  credentialPresent: true,
  credentialUpdatedAt: T0,
  lastValidatedAt: null,
  lastValidationStatus: null,
  lastValidationCode: null,
  createdAt: T0,
  updatedAt: T0,
};
const KIT_CONTENT = {
  schemaVersion: 1,
  identity: { brandName: 'Acme', tagline: 'Old line', description: '' },
  colors: [{ id: 'primary', name: 'Red', value: '#cc0000', role: 'primary' }],
  typography: [],
  visualDirection: { keywords: ['bold'], dos: [], donts: [] },
};
const writing = (voice: string) => ({
  schemaVersion: 1,
  voice,
  toneTags: ['practical'],
  perspective: 'first_plural',
  formatting: { emoji: 'none', hashtags: 'few', notes: null },
  vocabulary: { prefer: ['concrete'], avoid: ['revolutionary'] },
  dos: ['Be specific.'],
  donts: ['"revolutionary" — Hype.'],
  examples: [],
});
const audience = (description: string) => ({
  schemaVersion: 1,
  description,
  role: 'Owner',
  knowledgeLevel: 'beginner',
  goals: ['More customers'],
  painPoints: [],
  objections: [],
  preferredTone: null,
  locale: 'nl',
});
const expertise = () => ({
  schemaVersion: 1,
  subjects: ['Websites'],
  differentiators: ['Fixed prices'],
  stances: [],
  frameworks: [],
  evidenceExpectations: '',
  avoidTopics: [],
  confidenceBoundaries: '',
});
const policyContent = (principle: string) => ({
  schemaVersion: 1,
  principles: [principle],
  prohibitedTopics: [],
  claimRules: [],
  ctaRules: [],
  formatConventions: [],
  complianceNotes: '',
});
const PROPOSAL = {
  brand: { tagline: 'Websites that bring in work', description: 'AI brand.' },
  writing: { name: 'Studio voice', content: writing('AI voice.') },
  audiences: [
    { name: 'Shop owners', content: audience('AI audience.') },
    { name: 'Start-ups', content: audience('Second audience.') },
  ],
  expertise: { name: 'Web expertise', content: expertise() },
  editorialPolicy: { content: policyContent('AI principle.') },
};

let state: {
  connections: (typeof CONNECTION)[];
  kit: { latestRevisionNumber: number; content: unknown | null };
  profiles: Record<
    string,
    Array<{ id: string; name: string; rev: number; content: unknown }>
  >;
  policy: { latest: number; content: any | null };
  proposal: () => Reply | Promise<Reply>;
  // what a connection test answers
  test: () => { ok: true } | { ok: false; code: string };
  firstPost?: () => Reply;
  // where the first post stands (GET), when one was made
  firstPostRead?: () => Reply;
  fail?: (method: string, url: string) => Reply | undefined;
};
const BASES = [
  '/content-studio/writing-profiles',
  '/content-studio/audience-profiles',
  '/content-studio/expertise-profiles',
];
let ids = 0;
// the drafts the server started, by operation
const drafts = new Map<string, Promise<Reply>>();

const server = (
  method: string,
  url: string,
  body: any
): Reply | Promise<Reply> => {
  const failed = state.fail?.(method, url);
  if (failed) {
    return failed;
  }
  const { pathname } = new URL(url, 'https://api.test');
  if (method === 'GET' && pathname === '/content-studio/ai/providers') {
    return reply(200, PROVIDERS);
  }
  if (method === 'GET' && pathname === '/content-studio/ai/connections') {
    return reply(200, state.connections);
  }
  if (method === 'POST' && pathname === '/content-studio/ai/connections') {
    state.connections = [{ ...CONNECTION, name: body.name }];
    return reply(201, state.connections[0]);
  }
  // The server starts the draft and answers with its operation at once;
  // state.proposal is how that draft ends, read back below
  // the first post (activation flow 01) starts on the server
  if (
    method === 'GET' &&
    pathname === '/content-studio/activation/first-post'
  ) {
    return (
      state.firstPostRead?.() ??
      reply(200, {
        packageId: null,
        research: null,
        draft: null,
        alternatives: [],
        firstPost: { scheduled: false, published: false },
        activated: false,
      })
    );
  }
  if (
    method === 'POST' &&
    pathname === '/content-studio/activation/first-post'
  ) {
    return (
      state.firstPost?.() ?? reply(202, { packageId: 'first-post-package' })
    );
  }
  if (method === 'POST' && pathname === '/content-studio/ai/setup/proposal') {
    const operationId = `00000000-0000-4000-8000-a${String(++ids).padStart(
      11,
      '0'
    )}`;
    drafts.set(operationId, Promise.resolve(state.proposal()));
    return reply(202, { operationId, status: 'running' });
  }
  const proposal = pathname.match(
    /^\/content-studio\/ai\/setup\/proposal\/([^/]+)$/
  );
  if (method === 'GET' && proposal) {
    const ended = drafts.get(proposal[1]);
    if (!ended) {
      return reply(404, { code: 'CS_NOT_FOUND' });
    }
    return ended.then(async (answer) => {
      const body = (await answer.json()) as any;
      return reply(
        200,
        answer.ok
          ? {
              operationId: proposal[1],
              status: 'succeeded',
              proposal: body.proposal,
            }
          : { operationId: proposal[1], status: 'failed', code: body?.code }
      );
    });
  }
  const test = pathname.match(
    /^\/content-studio\/ai\/connections\/([^/]+)\/test$/
  );
  if (method === 'POST' && test) {
    const result = state.test();
    state.connections = state.connections.map((c) =>
      c.id === test[1]
        ? {
            ...c,
            lastValidatedAt: T0,
            lastValidationStatus: result.ok ? 'valid' : 'invalid',
            lastValidationCode: result.ok ? null : (result as any).code,
          }
        : c
    );
    return reply(200, result);
  }
  if (method === 'GET' && pathname === '/content-studio/brand-kit') {
    return reply(200, {
      latestRevisionNumber: state.kit.latestRevisionNumber,
      currentRevision: state.kit.content
        ? {
            id: 'kit-rev',
            revisionNumber: state.kit.latestRevisionNumber,
            schemaVersion: 1,
            contentHash: 'h',
            createdAt: T0,
            content: state.kit.content,
          }
        : null,
    });
  }
  if (method === 'POST' && pathname === '/content-studio/brand-kit/revisions') {
    state.kit = {
      latestRevisionNumber: state.kit.latestRevisionNumber + 1,
      content: body.content,
    };
    return reply(201, {
      created: true,
      latestRevisionNumber: state.kit.latestRevisionNumber,
    });
  }
  if (method === 'GET' && pathname === '/content-studio/editorial-policy') {
    return reply(200, {
      latestRevisionNumber: state.policy.latest,
      currentRevision: state.policy.content
        ? {
            id: 'policy-rev',
            revisionNumber: state.policy.latest,
            schemaVersion: 1,
            contentHash: 'h',
            createdAt: T0,
            content: state.policy.content,
          }
        : null,
    });
  }
  if (
    method === 'POST' &&
    pathname === '/content-studio/editorial-policy/revisions'
  ) {
    state.policy = { latest: state.policy.latest + 1, content: body.content };
    return reply(201, {
      created: true,
      latestRevisionNumber: state.policy.latest,
      revision: { revisionNumber: state.policy.latest },
    });
  }
  for (const base of BASES) {
    const list = state.profiles[base];
    if (method === 'GET' && pathname === base) {
      return reply(200, {
        pages: list.length ? 1 : 0,
        results: list.map((p) => ({
          id: p.id,
          name: p.name,
          latestRevisionNumber: p.rev,
          archivedAt: null,
          createdAt: T0,
          updatedAt: T0,
        })),
      });
    }
    if (method === 'POST' && pathname === base) {
      const created = {
        id: `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
        name: body.name,
        rev: 1,
        content: body.content,
      };
      list.unshift(created);
      return reply(201, { id: created.id, name: created.name });
    }
    const match = pathname.match(new RegExp(`^${base}/([^/]+)(/revisions)?$`));
    if (match) {
      const profile = list.find((p) => p.id === match[1]);
      if (!profile) {
        return reply(404, { code: 'CS_NOT_FOUND' });
      }
      if (method === 'GET' && !match[2]) {
        return reply(200, {
          id: profile.id,
          name: profile.name,
          latestRevisionNumber: profile.rev,
          archivedAt: null,
          createdAt: T0,
          updatedAt: T0,
          currentRevision: {
            id: `${profile.id}-r${profile.rev}`,
            revisionNumber: profile.rev,
            schemaVersion: 1,
            contentHash: 'h',
            createdAt: T0,
            content: profile.content,
          },
        });
      }
      if (method === 'POST' && match[2]) {
        if (body.baseRevisionNumber !== profile.rev) {
          return reply(409, { code: 'CS_PROFILE_REVISION_CONFLICT' });
        }
        profile.rev += 1;
        profile.content = body.content;
        return reply(201, {
          created: true,
          revision: { revisionNumber: profile.rev },
        });
      }
    }
  }
  return reply(404, { code: 'CS_NOT_FOUND' });
};

const calls = () =>
  mockFetch.mock.calls.map(([url, init]) => ({
    method: (init?.method as string) || 'GET',
    url: url as string,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  }));
const TEST_URL = `/content-studio/ai/connections/${CONNECTION.id}/test`;
const writes = () => calls().filter((c) => c.method !== 'GET');
// what changes Content Studio data: a connection test only records its result
const dataWrites = () => writes().filter((c) => c.url !== TEST_URL);

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
      h(ModalHost),
      h(ContentStudioSetupWizard)
    )
  );
  await flush();
};
const button = (name: string | RegExp) =>
  screen.getByRole('button', { name }) as HTMLButtonElement;
const field = (label: string) =>
  screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) =>
  fireEvent.change(field(label), { target: { value } });
const fillCompany = () => {
  type('Company name', 'Next Level Web');
  type('What does your company do?', 'We build websites for small shops.');
  type('Website', 'https://nextlevelweb.example');
};
const DRAFT_KEY = 'content-studio-setup-draft:org-1';

beforeEach(() => {
  window.localStorage.clear();
  mockModals.set([]);
  ids = 0;
  drafts.clear();
  state = {
    connections: [CONNECTION],
    kit: { latestRevisionNumber: 2, content: KIT_CONTENT },
    profiles: {
      '/content-studio/writing-profiles': [],
      '/content-studio/audience-profiles': [
        {
          id: '00000000-0000-4000-8000-0000000000a1',
          name: 'Shop owners',
          rev: 3,
          content: audience('Existing audience.'),
        },
      ],
      '/content-studio/expertise-profiles': [],
    },
    policy: {
      latest: 1,
      content: {
        ...policyContent('Existing principle.'),
        workflow: { requireApprovalForHandoff: true },
      },
    },
    proposal: () =>
      reply(200, {
        operationId: 'op',
        proposal: PROPOSAL,
        ai: {
          provider: 'openai',
          model: 'gpt-6.1-sol',
          promptVersion: 'cs-setup-v1',
        },
      }),
    test: () => ({ ok: true }),
  };
  mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) =>
    server(
      init.method || 'GET',
      url,
      init.body ? JSON.parse(init.body as string) : undefined
    )
  );
  mockUser.mockReturnValue({ orgId: 'org-1', tier: 'PRO', role: 'ADMIN' });
  mockConfirm.mockResolvedValue(true);
});

afterEach(async () => {
  cleanup();
  await flush();
  mockFetch.mockReset();
  mockToast.mockReset();
});

describe('Setup assistant: progress and the AI step', () => {
  it('W1 says which step of four; AI is ready only after its test, then goes on to the company', async () => {
    await show();
    expect(screen.getByText('Step 1 of 4')).toBeTruthy();
    // UX review 02: no second "steps left" line
    expect(screen.queryByText(/steps? left|Last step/)).toBeNull();
    // the connection was tested (key and model), and passed
    expect(writes().map((w) => w.url)).toEqual([TEST_URL]);
    expect(screen.getByText('AI is ready')).toBeTruthy();
    // nothing else is written by opening the assistant
    expect(dataWrites()).toEqual([]);
    fireEvent.click(button('Next'));
    await flush();
    expect(screen.getByText('Step 2 of 4')).toBeTruthy();
    // prefilled from what exists: the Brand Kit's name
    expect(field('Company name').value).toBe('Acme');
  });

  it('W2 without AI an admin connects it right here, or continues without it', async () => {
    state.connections = [];
    await show();
    expect(screen.queryByText('AI is ready')).toBeNull();
    // the inline form of Brand & AI, provider first
    expect(screen.getByLabelText('Provider')).toBeTruthy();
    expect(screen.getByLabelText('API key')).toBeTruthy();
    fireEvent.click(button('Continue without AI'));
    await flush();
    expect(screen.getByText('Step 2 of 4')).toBeTruthy();
    // no AI: the step offers Next, never an AI draft
    expect(
      screen.queryByRole('button', { name: 'Draft my profile with AI' })
    ).toBeNull();
  });

  it('W3 an ordinary member without AI is told who can connect it, and is not trapped', async () => {
    state.connections = [];
    mockUser.mockReturnValue({ orgId: 'org-1', tier: 'PRO', role: 'USER' });
    await show();
    expect(screen.queryByLabelText('API key')).toBeNull();
    expect(
      screen.getByText(/An admin of your organization can connect AI/)
    ).toBeTruthy();
    expect(button('Continue without AI')).toBeTruthy();
  });

  it('W4 connecting AI inline keeps the assistant where it is', async () => {
    state.connections = [];
    await show();
    fireEvent.change(field('API key'), {
      target: { value: 'sk-test-local-key' },
    });
    fireEvent.click(button('Connect'));
    await flush();
    expect(screen.getByText('AI is ready')).toBeTruthy();
    expect(screen.getByText('Step 1 of 4')).toBeTruthy();
    // a new connection is tested right away
    expect(writes().map((w) => w.url)).toEqual([
      '/content-studio/ai/connections',
      TEST_URL,
    ]);
    const [created] = writes();
    expect(created.url).toBe('/content-studio/ai/connections');
    // a blank name is the provider's name
    expect(created.body.name).toBe('OpenAI');
    // the key never reaches the assistant's saved state
    expect(window.localStorage.getItem(DRAFT_KEY) || '').not.toContain(
      'sk-test'
    );
  });
});

describe('Setup assistant: the AI draft', () => {
  const toProfile = async () => {
    await show();
    fireEvent.click(button('Next'));
    await flush();
    fillCompany();
    fireEvent.click(button('Draft my profile with AI'));
    await flush();
  };

  it('W5 asks the AI once, with the company facts and the connection only', async () => {
    await toProfile();
    const asked = calls().filter(
      (c) => c.url === '/content-studio/ai/setup/proposal'
    );
    expect(asked).toHaveLength(1);
    expect(asked[0].body).toEqual({
      connectionId: CONNECTION.id,
      companyName: 'Next Level Web',
      // the Brand Kit's tagline, prefilled in step 2
      tagline: 'Old line',
      website: 'https://nextlevelweb.example',
      description: 'We build websites for small shops.',
      goal: null,
      audience: null,
      language: 'nl',
    });
    expect(screen.getByText('Step 3 of 4')).toBeTruthy();
    expect(
      screen.getByText(/We drafted this from your company description/)
    ).toBeTruthy();
    expect(screen.getByText('AI voice.')).toBeTruthy();
    expect(screen.getByText('Audience: Start-ups')).toBeTruthy();
    // a draft is a suggestion: nothing of a profile is saved yet
    expect(dataWrites().map((w) => w.url)).toEqual([
      '/content-studio/ai/setup/proposal',
    ]);
  });

  it('W6 a failed draft keeps the company facts, and offers Try again and Continue manually', async () => {
    state.proposal = () => reply(502, { code: 'CS_AI_INVALID_RESPONSE' });
    await toProfile();
    expect(screen.getByRole('alert').textContent).toBe(
      'The AI answer could not be used. Try again.'
    );
    expect(screen.getByText(/Everything you entered is kept/)).toBeTruthy();
    // every way on: retry, the connection, by hand, or later
    expect(button('Check AI connection')).toBeTruthy();
    expect(button('Continue manually')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Finish later' })).toBeTruthy();
    state.proposal = () =>
      reply(200, { operationId: 'op', proposal: PROPOSAL, ai: {} });
    fireEvent.click(button('Try again'));
    await flush();
    expect(screen.getByText('AI voice.')).toBeTruthy();
    fireEvent.click(button('Back'));
    await flush();
    expect(field('Company name').value).toBe('Next Level Web');
  });

  it('W7 Continue manually starts from what exists, never from an AI draft', async () => {
    state.proposal = () => reply(502, { code: 'CS_AI_QUOTA_EXCEEDED' });
    await toProfile();
    expect(screen.getByRole('alert').textContent).toBe(
      'Your OpenAI key works, but the OpenAI account has no API credit left, so no draft can be made. Add credit in your OpenAI account, then try again, or continue manually.'
    );
    fireEvent.click(button('Continue manually'));
    await flush();
    expect(screen.getByText(/Fill in what you can/)).toBeTruthy();
    // the existing audience, its name and content
    expect(screen.getByText('Audience: Shop owners')).toBeTruthy();
    expect(screen.getByText('Existing audience.')).toBeTruthy();
  });

  it('W8 Regenerate replaces only its own section', async () => {
    await toProfile();
    // the brand edited by hand stays
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    type('Tagline', 'My own line');
    fireEvent.click(button('Done'));
    state.proposal = () =>
      reply(200, {
        operationId: 'op2',
        proposal: {
          ...PROPOSAL,
          brand: { tagline: 'Other', description: 'Other brand.' },
          writing: { name: 'Studio voice', content: writing('Second voice.') },
        },
        ai: {},
      });
    fireEvent.click(screen.getAllByRole('button', { name: 'Regenerate' })[1]);
    await flush();
    expect(screen.getByText('Second voice.')).toBeTruthy();
    expect(screen.getByText('My own line')).toBeTruthy();
    expect(screen.queryByText('Other brand.')).toBeNull();
  });
});

describe('Setup assistant: resume', () => {
  it('W9 every step is kept per organization, and the assistant resumes there', async () => {
    await show();
    fireEvent.click(button('Next'));
    await flush();
    fillCompany();
    await flush();
    const saved = JSON.parse(window.localStorage.getItem(DRAFT_KEY) as string);
    expect(saved.step).toBe(2);
    expect(saved.company.companyName).toBe('Next Level Web');
    cleanup();
    await show();
    expect(screen.getByText('Step 2 of 4')).toBeTruthy();
    expect(field('Company name').value).toBe('Next Level Web');
    // another organization starts fresh
    cleanup();
    mockUser.mockReturnValue({ orgId: 'org-2', tier: 'PRO', role: 'ADMIN' });
    await show();
    expect(screen.getByText('Step 1 of 4')).toBeTruthy();
  });

  it('W10 steps 3 and 4 cannot be opened before the company is described', async () => {
    await show();
    const step3 = screen.getByRole('button', { name: 'Your content profile' });
    expect(step3.hasAttribute('disabled')).toBe(true);
  });
});

describe('Setup assistant: save', () => {
  const toReview = async () => {
    await show();
    fireEvent.click(button('Next'));
    await flush();
    fillCompany();
    fireEvent.click(button('Draft my profile with AI'));
    await flush();
    fireEvent.click(button('Next'));
    await flush();
  };

  it('W11/ACT3 saves without deleting or overwriting, then starts the first post', async () => {
    await toReview();
    expect(screen.getByText('Step 4 of 4')).toBeTruthy();
    expect(dataWrites().map((w) => w.url)).toEqual([
      '/content-studio/ai/setup/proposal',
    ]);
    fireEvent.click(button('Create my first post'));
    await flush();
    const saved = dataWrites().filter(
      (w) =>
        w.url !== '/content-studio/ai/setup/proposal' &&
        w.url !== '/content-studio/activation/first-post'
    );
    expect(saved.map((w) => `${w.method} ${w.url}`)).toEqual([
      'POST /content-studio/brand-kit/revisions',
      'POST /content-studio/writing-profiles',
      // the same name: a new version of the existing audience
      'POST /content-studio/audience-profiles/00000000-0000-4000-8000-0000000000a1/revisions',
      'POST /content-studio/audience-profiles',
      'POST /content-studio/expertise-profiles',
      'POST /content-studio/editorial-policy/revisions',
    ]);
    // the Brand Kit: over its latest version, colors and direction kept
    expect(saved[0].body.baseRevisionNumber).toBe(2);
    expect(saved[0].body.content.colors).toEqual(KIT_CONTENT.colors);
    expect(saved[0].body.content.visualDirection).toEqual(
      KIT_CONTENT.visualDirection
    );
    expect(saved[0].body.content.identity).toEqual({
      brandName: 'Next Level Web',
      // the Brand Kit's own tagline, kept in step 2, wins over the AI's
      tagline: 'Old line',
      description: 'AI brand.',
    });
    expect(saved[2].body.baseRevisionNumber).toBe(3);
    // the approval workflow is kept as it was
    expect(saved[5].body).toEqual({
      baseRevisionNumber: 1,
      content: {
        ...policyContent('AI principle.'),
        workflow: { requireApprovalForHandoff: true },
      },
    });
    // then, and only then, the first post
    expect(
      dataWrites()
        .map((w) => w.url)
        .slice(-1)
    ).toEqual(['/content-studio/activation/first-post']);
    expect(mockRouter.push).toHaveBeenCalledWith('/content-studio/first-post');
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(calls().map((c) => c.method)).not.toContain('DELETE');
  });

  it('W12 a part left out is not saved', async () => {
    await show();
    fireEvent.click(button('Next'));
    await flush();
    fillCompany();
    fireEvent.click(button('Draft my profile with AI'));
    await flush();
    const checkboxes = screen.getAllByRole('checkbox', { name: 'Use this' });
    // brand, writing, two audiences, expertise, editorial
    expect(checkboxes).toHaveLength(6);
    fireEvent.click(checkboxes[5]);
    fireEvent.click(checkboxes[3]);
    fireEvent.click(button('Next'));
    await flush();
    fireEvent.click(button('Create my first post'));
    await flush();
    const urls = writes().map((w) => w.url);
    expect(urls).not.toContain('/content-studio/editorial-policy/revisions');
    expect(
      urls.filter((u) => u === '/content-studio/audience-profiles')
    ).toEqual([]);
  });

  it('W13 after a failure, saving again goes on where it stopped and creates nothing twice', async () => {
    await toReview();
    state.fail = (method, url) =>
      method === 'POST' && url === '/content-studio/expertise-profiles'
        ? reply(400, { code: 'CS_PROFILE_TOO_LARGE' })
        : undefined;
    fireEvent.click(button('Create my first post'));
    await flush();
    expect(screen.getByRole('alert').textContent).toContain(
      'This is too long to save.'
    );
    const before = writes().length;
    state.fail = undefined;
    fireEvent.click(button('Save again'));
    await flush();
    const again = writes()
      .slice(before)
      .map((w) => `${w.method} ${w.url}`);
    expect(again).toEqual([
      'POST /content-studio/expertise-profiles',
      'POST /content-studio/editorial-policy/revisions',
      'POST /content-studio/activation/first-post',
    ]);
    expect(mockRouter.push).toHaveBeenCalledWith('/content-studio/first-post');
  });
});

// UX review 02: Lambert's second review
describe('Setup assistant: quiet progress (review 02)', () => {
  it('W14 only the current step stands out; done steps are checked, later ones muted', async () => {
    await show();
    fireEvent.click(button('Next'));
    await flush();
    const steps = screen
      .getByRole('navigation', { name: 'Setup steps' })
      .querySelectorAll('li');
    expect(
      Array.from(steps).map((li) => li.getAttribute('data-state'))
    ).toEqual(['done', 'current', 'upcoming', 'upcoming']);
    const current = document.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain('Your company');
    // upcoming steps are muted and cannot be opened yet
    for (const li of Array.from(steps).slice(2)) {
      const step = li.querySelector('button') as HTMLButtonElement;
      expect(step.className).toMatch(/opacity-/);
      expect(step.disabled).toBe(true);
    }
    // "Finish later" is a quiet link, the step's way on a button
    const later = screen.getByRole('link', { name: 'Finish later' });
    expect(later.tagName).toBe('A');
    expect(later.className).toMatch(/text-textItemBlur/);
    expect(button('Draft my profile with AI')).toBeTruthy();
  });

  it('W15 Finish later keeps what was typed and stops Home from opening the assistant', async () => {
    await show();
    fireEvent.click(button('Next'));
    await flush();
    fillCompany();
    await flush();
    fireEvent.click(screen.getByRole('link', { name: 'Finish later' }));
    expect(
      window.localStorage.getItem('content-studio-setup-hidden:org-1')
    ).toBe('1');
    const kept = JSON.parse(window.localStorage.getItem(DRAFT_KEY) as string);
    expect(kept.company.companyName).toBe('Next Level Web');
  });
});

describe('Setup assistant: AI connection health (review 02)', () => {
  it('W16 a connection whose test fails needs attention: fix it, or continue manually', async () => {
    state.test = () => ({ ok: false, code: 'WORKSPACE_REQUIRED' });
    await show();
    expect(screen.queryByText('AI is ready')).toBeNull();
    expect(screen.getByText('AI needs attention')).toBeTruthy();
    expect(screen.getByText(/not tied to a workspace/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Fix connection' }).getAttribute('href')
    ).toBe('/content-studio/intelligence?tab=ai');
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    fireEvent.click(button('Continue manually'));
    await flush();
    expect(screen.getByText('Step 2 of 4')).toBeTruthy();
    // without working AI the profile is filled in by hand
    expect(
      screen.queryByRole('button', { name: 'Draft my profile with AI' })
    ).toBeNull();
  });

  it('W17 a member cannot test: an untested connection is used as it is', async () => {
    mockUser.mockReturnValue({ orgId: 'org-1', tier: 'PRO', role: 'USER' });
    await show();
    expect(writes()).toEqual([]);
    expect(screen.getByText(/An admin can test this connection/)).toBeTruthy();
    fireEvent.click(button('Next'));
    await flush();
    expect(button('Draft my profile with AI')).toBeTruthy();
  });

  it('W18 a failed draft about the connection goes back to step 1 without losing step 2', async () => {
    state.proposal = () => reply(502, { code: 'CS_AI_WORKSPACE_REQUIRED' });
    await show();
    fireEvent.click(button('Next'));
    await flush();
    fillCompany();
    type('Main goal of your posts (optional)', 'More inbound leads');
    fireEvent.click(button('Draft my profile with AI'));
    await flush();
    expect(screen.getByRole('alert').textContent).toMatch(
      /not tied to a workspace/
    );
    const before = writes().filter((w) => w.url === TEST_URL).length;
    state.test = () => ({ ok: false, code: 'WORKSPACE_REQUIRED' });
    fireEvent.click(button('Check AI connection'));
    await flush();
    expect(screen.getByText('Step 1 of 4')).toBeTruthy();
    // tested again on the way back
    expect(writes().filter((w) => w.url === TEST_URL).length).toBe(before + 1);
    expect(screen.getByText('AI needs attention')).toBeTruthy();
    // fixed elsewhere: tested again, ready, and the company is as typed
    state.test = () => ({ ok: true });
    fireEvent.click(button('Test again'));
    await flush();
    expect(screen.getByText('AI is ready')).toBeTruthy();
    fireEvent.click(button('Next'));
    await flush();
    expect(field('Company name').value).toBe('Next Level Web');
    expect(field('Main goal of your posts (optional)').value).toBe(
      'More inbound leads'
    );
  });

  it('W19 an answer that arrives after the user went back is dropped', async () => {
    let answer: (value: Reply) => void = () => undefined;
    state.proposal = () =>
      new Promise<Reply>((resolve) => {
        answer = resolve;
      });
    await show();
    fireEvent.click(button('Next'));
    await flush();
    fillCompany();
    fireEvent.click(button('Draft my profile with AI'));
    await flush();
    expect(screen.getByText('Drafting your content profile…')).toBeTruthy();
    expect(
      screen.getByText(
        'This takes about a minute. You can switch to another app: we keep working and show the result when you are back.'
      )
    ).toBeTruthy();
    // Back stays possible while the AI works
    fireEvent.click(button('Back'));
    await flush();
    expect(screen.getByText('Step 2 of 4')).toBeTruthy();
    answer(reply(200, { operationId: 'late', proposal: PROPOSAL, ai: {} }));
    await flush();
    expect(screen.getByText('Step 2 of 4')).toBeTruthy();
    const kept = JSON.parse(window.localStorage.getItem(DRAFT_KEY) as string);
    expect(kept.profile).toBeNull();
    // a new attempt still works
    state.proposal = () =>
      reply(200, { operationId: 'op', proposal: PROPOSAL, ai: {} });
    fireEvent.click(button('Draft my profile with AI'));
    await flush();
    expect(screen.getByText('AI voice.')).toBeTruthy();
  });
});

describe('Setup assistant: company step fields (review 02)', () => {
  const toCompany = async () => {
    await show();
    fireEvent.click(button('Next'));
    await flush();
  };

  it('W20 the description, goal and audience are text areas of a useful size', async () => {
    await toCompany();
    const description = field('What does your company do?');
    expect(description.tagName).toBe('TEXTAREA');
    expect(Number(description.getAttribute('rows'))).toBeGreaterThanOrEqual(5);
    for (const label of [
      'Main goal of your posts (optional)',
      'Who do you write for? (optional)',
    ]) {
      const area = field(label);
      expect(area.tagName).toBe('TEXTAREA');
      expect(Number(area.getAttribute('rows'))).toBeGreaterThanOrEqual(3);
    }
  });

  it('W21 the website shows no warning until an invalid address is left, then an error under the field', async () => {
    await toCompany();
    const website = field('Website');
    expect(website.getAttribute('placeholder')).toBe('https://nextlevelweb.nl');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(website, { target: { value: 'nextlevelweb.nl' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.blur(website);
    const error = screen.getByRole('alert');
    expect(error.textContent).toContain(
      'Use a full URL, for example https://nextlevelweb.nl'
    );
    expect(website.getAttribute('aria-invalid')).toBe('true');
    expect(website.getAttribute('aria-describedby')).toBe(error.id);
    // the error is next to its field, not elsewhere in the form
    expect(website.parentElement?.contains(error)).toBe(true);
    fireEvent.change(website, { target: { value: 'https://nextlevelweb.nl' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(website.getAttribute('aria-invalid')).toBeNull();
  });
});

describe('Setup: when Content Studio opens the assistant (review 02)', () => {
  const {
    shouldOpenContentStudioSetup,
  } = require('./content-studio.setup.api');
  const base = { complete: false, hidden: false, filtered: false };
  // UX review 03: the same on every device, from the organization's data
  it.each([
    ['a setup that is not complete', {}, true],
    ['everything set up', { complete: true }, false],
    [
      'after Skip for now or Finish later on this device',
      { hidden: true },
      false,
    ],
    ['a filtered or paged home page', { filtered: true }, false],
  ])('%s', (_label, patch, expected) => {
    expect(shouldOpenContentStudioSetup({ ...base, ...patch })).toBe(expected);
  });
});

describe('Setup assistant: source surface', () => {
  const { readFileSync } = require('fs');
  const { join } = require('path');
  const code = readFileSync(
    join(__dirname, 'content-studio.setup.tsx'),
    'utf8'
  );
  const api = readFileSync(
    join(__dirname, 'content-studio.setup.api.ts'),
    'utf8'
  );

  it('reaches the AI through the one setup route only, and never deletes', () => {
    expect(`${code}\n${api}`).not.toMatch(
      /method: 'DELETE'|\/archive|openai\.com|anthropic\.com/
    );
    expect(api).toContain("'/content-studio/ai/setup/proposal'");
  });

  it('keeps no key: the assistant itself never handles an API key', () => {
    expect(code).not.toMatch(/apiKey|credential:|API key:/);
  });
});

describe('Setup assistant: real AI failures and retry (review 03)', () => {
  const toDraft = async () => {
    await show();
    fireEvent.click(button('Next'));
    await flush();
    fillCompany();
  };
  const proposals = () =>
    calls().filter((c) => c.url === '/content-studio/ai/setup/proposal');
  const wait = (ms: number) =>
    act(() => new Promise((resolve) => setTimeout(resolve, ms)));

  it('W22 the tagline is asked in step 2, prefilled from the Brand Kit, sent to the AI and kept as typed', async () => {
    await toDraft();
    expect(field('Tagline (optional)').value).toBe('Old line');
    type('Tagline (optional)', 'Strategy, websites and automation');
    fireEvent.click(button('Draft my profile with AI'));
    await flush();
    expect(proposals()[0].body.tagline).toBe(
      'Strategy, websites and automation'
    );
    expect(screen.getByText('Strategy, websites and automation')).toBeTruthy();
    expect(screen.queryByText('Websites that bring in work')).toBeNull();
  });

  it('W23 an empty tagline is sent as none and the AI suggests one', async () => {
    await toDraft();
    type('Tagline (optional)', '   ');
    fireEvent.click(button('Draft my profile with AI'));
    await flush();
    expect(proposals()[0].body.tagline).toBeNull();
    expect(screen.getByText('Websites that bring in work')).toBeTruthy();
  });

  it('W24 an account without credit says so by provider name, and the connection list is read again', async () => {
    state.proposal = () => reply(502, { code: 'CS_AI_QUOTA_EXCEEDED' });
    await toDraft();
    const listed = () =>
      calls().filter(
        (c) => c.method === 'GET' && c.url === '/content-studio/ai/connections'
      ).length;
    const before = listed();
    fireEvent.click(button('Draft my profile with AI'));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(
      'Your OpenAI key works, but the OpenAI account has no API credit left, so no draft can be made. Add credit in your OpenAI account, then try again, or continue manually.'
    );
    expect(listed()).toBeGreaterThan(before);
    // the connection is the way on: Check AI connection leads
    expect(button('Check AI connection').className).not.toMatch(/secondary/);
    expect(button('Continue manually')).toBeTruthy();
  });

  it('W25 Try again visibly tries again: a new request, "Trying again…", and a repeat says so', async () => {
    state.proposal = () => reply(503, { code: 'CS_AI_PROVIDER_UNAVAILABLE' });
    await toDraft();
    fireEvent.click(button('Draft my profile with AI'));
    await flush();
    expect(proposals()).toHaveLength(1);
    expect(screen.queryByText(/Tried again just now/)).toBeNull();

    fireEvent.click(button('Try again'));
    // the old error is gone at once and the wait says it is a retry
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Trying again…')).toBeTruthy();
    await flush();
    expect(proposals()).toHaveLength(2);
    // still waiting: a refusal that comes back at once is shown a moment
    expect(screen.getByText('Trying again…')).toBeTruthy();
    await wait(700);
    await flush();
    expect(screen.getByRole('alert').textContent).toMatch(
      /not available right now.*Tried again just now \(2 tries\): the same problem came back\./
    );

    // a different answer is a new message, not a repeat
    state.proposal = () => reply(502, { code: 'CS_AI_INVALID_RESPONSE' });
    fireEvent.click(button('Try again'));
    await flush();
    await wait(700);
    await flush();
    expect(proposals()).toHaveLength(3);
    expect(screen.getByRole('alert').textContent).toBe(
      'The AI answer could not be used. Try again.'
    );
    // and one that works shows the draft
    state.proposal = () =>
      reply(200, { operationId: 'op', proposal: PROPOSAL, ai: {} });
    fireEvent.click(button('Try again'));
    await flush();
    expect(screen.getByText('AI voice.')).toBeTruthy();
    expect(proposals()).toHaveLength(4);
  });

  it('W26 a request the provider could not accept names the provider and points at the model', async () => {
    state.proposal = () => reply(502, { code: 'CS_AI_REQUEST_REJECTED' });
    await toDraft();
    fireEvent.click(button('Draft my profile with AI'));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(
      'OpenAI could not accept the request Content Studio sent. Try again; if it keeps happening, choose another model under Check AI connection.'
    );
  });

  it('W27 a draft kept before the tagline field opens with the Brand Kit tagline and its typed facts', async () => {
    window.localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        v: 1,
        step: 2,
        connectionId: CONNECTION.id,
        manual: false,
        company: {
          companyName: 'Next Level Web',
          website: 'https://nextlevelweb.nl',
          description: 'Strategy, websites, marketing and automation.',
          goal: 'Inbound leads',
          audience: 'Growing SMEs',
          language: 'nl',
        },
        source: null,
        profile: null,
        saved: {},
      })
    );
    await show();
    expect(field('Company name').value).toBe('Next Level Web');
    expect(field('Tagline (optional)').value).toBe('Old line');
    expect(field('What does your company do?').value).toBe(
      'Strategy, websites, marketing and automation.'
    );
    expect(field('Main goal of your posts (optional)').value).toBe(
      'Inbound leads'
    );
  });
});

describe('Setup assistant: phone layout (review 03)', () => {
  it('M3 a phone shows "Step x of 4" over a bar of four parts instead of the labelled steps', async () => {
    await show();
    fireEvent.click(button('Next'));
    await flush();
    const bar = screen.getByTestId('setup-progress-bar');
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    expect(bar.className).toMatch(/(^| )flex sm:hidden( |$)/);
    const parts = Array.from(bar.children).map((part) =>
      part.className.includes('bg-newTableBorder') ? 'todo' : 'done'
    );
    expect(parts).toEqual(['done', 'done', 'todo', 'todo']);
    const steps = screen
      .getByRole('navigation', { name: 'Setup steps' })
      .querySelector('ol') as HTMLElement;
    expect(steps.className).toMatch(/(^| )hidden sm:flex( |$)/);
    expect(screen.getByText('Step 2 of 4')).toBeTruthy();
  });

  it('M4 website and language sit side by side only where both fit, and actions stack on a phone, the main one on top', async () => {
    await show();
    fireEvent.click(button('Next'));
    await flush();
    const grid = field('Website').closest('.grid') as HTMLElement;
    expect(grid.className).toContain(
      'grid-cols-[repeat(auto-fit,minmax(240px,1fr))]'
    );
    expect(grid.contains(field('Language of your posts'))).toBe(true);
    const footer = button('Draft my profile with AI')
      .parentElement as HTMLElement;
    expect(footer.className).toMatch(/(^| )flex-col-reverse( |$)/);
    expect(footer.className).toContain('sm:flex-row');
    // the last button (the main one) comes first when reversed
    expect(footer.lastElementChild?.textContent).toBe(
      'Draft my profile with AI'
    );

    state.proposal = () => reply(502, { code: 'CS_AI_INVALID_RESPONSE' });
    fillCompany();
    fireEvent.click(button('Draft my profile with AI'));
    await flush();
    const actions = button('Continue manually').parentElement as HTMLElement;
    expect(actions.className).toMatch(/(^| )flex-col( |$)/);
    expect(actions.className).toContain('items-stretch');
  });

  it('M5 Finish later never wraps under the title', async () => {
    await show();
    const later = screen.getByRole('link', { name: 'Finish later' });
    expect(later.className).toContain('shrink-0');
    expect(later.className).toContain('whitespace-nowrap');
    expect((later.parentElement as HTMLElement).className).not.toContain(
      'flex-wrap'
    );
  });
});

// Activation flow 01: on an iPhone the draft failed whenever Safari was put
// away while the AI worked. The server finished it; the page had lost the
// one request that would have carried it. The assistant now keeps the
// operation and reads the draft back
describe('Setup assistant: a draft that survives leaving the page', () => {
  const held = () => {
    let answer: (value: Reply) => void = () => undefined;
    state.proposal = () =>
      new Promise<Reply>((resolve) => {
        answer = resolve;
      });
    return (value: Reply) => answer(value);
  };
  const startDraft = async () => {
    await show();
    fireEvent.click(button('Next'));
    await flush();
    fillCompany();
    fireEvent.click(button('Draft my profile with AI'));
    await flush();
  };
  const posts = () =>
    calls().filter(
      (c) =>
        c.method === 'POST' && c.url === '/content-studio/ai/setup/proposal'
    );

  it('BG1-F keeps the started operation with the assistant before waiting', async () => {
    held();
    await startDraft();
    const kept = JSON.parse(window.localStorage.getItem(DRAFT_KEY) as string);
    expect(kept.pending).toEqual({
      operationId: expect.stringMatching(/^00000000-/),
      section: 'all',
    });
    expect(kept.step).toBe(3);
  });

  it('BG7-F a reload while the AI works picks the same draft up again, without asking the AI twice', async () => {
    const answer = held();
    await startDraft();
    // the page is gone (reload, or Safari discarded it)
    cleanup();
    await show();
    expect(
      screen.getByText('Still drafting your content profile…')
    ).toBeTruthy();
    answer(reply(200, { proposal: PROPOSAL }));
    await flush();
    expect(screen.getByText('AI voice.')).toBeTruthy();
    expect(posts()).toHaveLength(1);
    const kept = JSON.parse(window.localStorage.getItem(DRAFT_KEY) as string);
    expect(kept.pending).toBeNull();
    expect(kept.profile.writing.content.voice).toBe('AI voice.');
  });

  it('BG2-F a look that gets no answer (the page was suspended) is made again, and the draft still arrives', async () => {
    const answer = held();
    const original = mockFetch.getMockImplementation()!;
    let dropped = 0;
    mockFetch.mockImplementation(
      async (url: string, init: RequestInit = {}) => {
        if (
          (init.method || 'GET') === 'GET' &&
          url.startsWith('/content-studio/ai/setup/proposal/') &&
          dropped < 1
        ) {
          dropped += 1;
          throw new TypeError('Load failed');
        }
        return original(url, init);
      }
    );
    await startDraft();
    expect(dropped).toBe(1);
    expect(screen.getByText('Drafting your content profile…')).toBeTruthy();
    answer(reply(200, { proposal: PROPOSAL }));
    await flush();
    // the page is shown again: it looks at once instead of waiting
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(dropped).toBe(1);
    expect(screen.getByText('AI voice.')).toBeTruthy();
    expect(
      screen.queryByText("We couldn't generate suggestions right now.")
    ).toBeNull();
  });

  it('BG5-F a draft that failed while the page was away shows the real reason on return', async () => {
    const answer = held();
    await startDraft();
    cleanup();
    answer(reply(429, { code: 'CS_AI_RATE_LIMITED' }));
    await show();
    await flush();
    expect(
      screen.getByText('The AI provider is busy. Wait a moment and try again.')
    ).toBeTruthy();
    expect(button('Try again')).toBeTruthy();
  });

  it('BG6-F Back drops the running draft: its late answer never fills the profile', async () => {
    const answer = held();
    await startDraft();
    fireEvent.click(button('Back'));
    await flush();
    answer(reply(200, { proposal: PROPOSAL }));
    await flush();
    const kept = JSON.parse(window.localStorage.getItem(DRAFT_KEY) as string);
    expect(kept.pending).toBeNull();
    expect(kept.profile).toBeNull();
    // reopening the assistant does not pick the dropped draft up either
    cleanup();
    await show();
    expect(screen.getByText('Step 2 of 4')).toBeTruthy();
  });
});

// Activation flow 01: step 4 puts the reviewed profile to work instead of
// summing it up a second time
describe('Setup assistant: step 4 creates the first post', () => {
  const toStep4 = async () => {
    await show();
    fireEvent.click(button('Next'));
    await flush();
    fillCompany();
    fireEvent.click(button('Draft my profile with AI'));
    await flush();
    fireEvent.click(button('Next'));
    await flush();
  };

  it('ACT1/ACT2/C1-C5 step 4 is short: the profile is ready, Content Studio researches and writes the first post, the user decides', async () => {
    await toStep4();
    expect(screen.getByText('Step 4 of 4')).toBeTruthy();
    // C3 a simple "your profile is ready"
    expect(
      screen.getByRole('heading', { name: 'Your profile is ready!' })
    ).toBeTruthy();
    // C4 who does what: Content Studio researches and creates, the user
    // reviews and decides
    expect(
      screen.getByText(
        'Content Studio can now use your company profile, audience and expertise to research a relevant topic and create your first post. You can review it, edit it and decide whether to schedule it or publish it.'
      )
    ).toBeTruthy();
    // C1 no note about versions, C2 no "Built on your" chips, C5 no 1-2-3
    // list repeating the intro
    expect(screen.queryByText(/Saving never deletes anything/)).toBeNull();
    expect(screen.queryByText('Built on your')).toBeNull();
    expect(screen.queryByText(/^Research:|^Draft:|^You:/)).toBeNull();
    expect(screen.queryByText('Review and save')).toBeNull();
    expect(screen.queryByText('Studio voice')).toBeNull();
    expect(button('Create my first post')).toBeTruthy();
  });

  it('ACT4/ACT5 starts research with the AI connection and the language of step 2, then opens the first post', async () => {
    await toStep4();
    fireEvent.click(button('Create my first post'));
    await flush();
    const started = calls().find(
      (c) =>
        c.method === 'POST' && c.url === '/content-studio/activation/first-post'
    );
    expect(started?.body).toEqual({
      connectionId: CONNECTION.id,
      mode: 'first',
      language: 'nl',
      name: 'First post',
    });
    expect(mockRouter.push).toHaveBeenCalledWith('/content-studio/first-post');
  });

  it('saved, but the first post could not start: the profile stays saved and the first post page says why', async () => {
    state.firstPost = () => reply(429, { code: 'CS_AI_RATE_LIMITED' });
    await toStep4();
    fireEvent.click(button('Create my first post'));
    await flush();
    expect(
      writes().some(
        (w) => w.url === '/content-studio/editorial-policy/revisions'
      )
    ).toBe(true);
    expect(mockRouter.push).toHaveBeenCalledWith(
      '/content-studio/first-post?error=CS_AI_RATE_LIMITED'
    );
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('without AI, step 4 saves the profile and offers what is next', async () => {
    state.connections = [];
    await show();
    fireEvent.click(button('Continue without AI'));
    await flush();
    type('Company name', 'Next Level Web');
    type('What does your company do?', 'We build websites for small shops.');
    fireEvent.click(button('Next'));
    await flush();
    fireEvent.click(button('Next'));
    await flush();
    expect(
      screen.getByRole('heading', { name: 'Your profile is ready!' })
    ).toBeTruthy();
    fireEvent.click(button('Save setup'));
    await flush();
    expect(screen.getByText('Your Content Studio is ready')).toBeTruthy();
    expect(
      calls().some(
        (c) =>
          c.method === 'POST' &&
          c.url === '/content-studio/activation/first-post'
      )
    ).toBe(false);
  });

  it('keeps research preferences the policy has when the setup saves it', async () => {
    state.policy.content = {
      ...state.policy.content,
      research: {
        lookFor: ['AI'],
        avoid: [],
        freshness: 'week',
        angles: [],
      },
    };
    await toStep4();
    fireEvent.click(button('Create my first post'));
    await flush();
    const policy = writes().find(
      (w) => w.url === '/content-studio/editorial-policy/revisions'
    );
    expect(policy?.body.content.research).toEqual({
      lookFor: ['AI'],
      avoid: [],
      freshness: 'week',
      angles: [],
    });
  });
});

// Activation flow 01: on a phone the paired lists of step 3 were two narrow
// columns, and "+4" looked like a control but was text
describe('Setup assistant: step 3 lists on a phone', () => {
  const LONG = Array.from({ length: 7 }, (_, i) => `Rule number ${i + 1}`);
  const toStep3 = async () => {
    state.proposal = () =>
      reply(200, {
        proposal: {
          ...PROPOSAL,
          writing: {
            ...PROPOSAL.writing,
            content: {
              ...writing('AI voice.'),
              dos: LONG,
              donts: LONG.slice(0, 5),
            },
          },
        },
      });
    await show();
    fireEvent.click(button('Next'));
    await flush();
    fillCompany();
    fireEvent.click(button('Draft my profile with AI'));
    await flush();
  };

  it('UX1/UX2 paired lists are one column below the small breakpoint and two from it up', async () => {
    await toStep3();
    const doList = screen.getByText('Do').parentElement!.parentElement!;
    expect(doList.className).toContain('grid-cols-1');
    expect(doList.className).toContain('sm:grid-cols-2');
    // the max-width tablet: prefix made phones two columns
    expect(doList.className).not.toContain('tablet:grid-cols-2');
  });

  it('UX3/UX4/UX5/L1-L4 "Show all" is a real button that opens its own list only, and "Show less" closes it', async () => {
    await toStep3();
    expect(screen.queryByText('+4')).toBeNull();
    // L1 not "Show 4 more", which reads as if 4 would be added
    expect(screen.queryByText(/Show \d+ more/)).toBeNull();
    const more = screen.getByRole('button', { name: 'Show all: Do' });
    expect(more.textContent).toBe('Show all');
    // L3
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Rule number 7')).toBeNull();
    fireEvent.click(more);
    expect(screen.getAllByText('Rule number 7')).toHaveLength(1);
    // L4 the Don't list stayed as it was
    expect(
      screen.getByRole('button', { name: "Show all: Don't" })
    ).toBeTruthy();
    // L2
    const less = screen.getByRole('button', { name: 'Show less: Do' });
    expect(less.getAttribute('aria-expanded')).toBe('true');
    expect(less.textContent).toBe('Show less');
    fireEvent.click(less);
    expect(screen.queryByText('Rule number 7')).toBeNull();
  });

  it('UX6 Edit still opens the full form of the section', async () => {
    await toStep3();
    const [edit] = screen.getAllByRole('button', { name: 'Edit' });
    fireEvent.click(edit);
    expect(screen.getByLabelText('Tagline')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Done' }).length).toBe(1);
  });
});

// Activation review 02: what the organization saved wins over what a
// browser kept. Lambert's setup reopened at step 1 after the first post and
// only "Draft my profile with AI" went on, so the AI wrote his profile again
describe('Setup assistant: the saved setup wins over this browser', () => {
  const VOICE = 'Our saved voice.';
  const savedSetup = () => {
    state.kit = {
      latestRevisionNumber: 4,
      content: {
        ...KIT_CONTENT,
        identity: {
          brandName: 'Next Level Web',
          tagline: 'Saved line',
          description: 'We build websites for small shops.',
        },
      },
    };
    state.profiles['/content-studio/writing-profiles'] = [
      {
        id: '00000000-0000-4000-8000-0000000000b1',
        name: 'Saved voice',
        rev: 1,
        content: writing(VOICE),
      },
    ];
    state.profiles['/content-studio/expertise-profiles'] = [
      {
        id: '00000000-0000-4000-8000-0000000000c1',
        name: 'Saved expertise',
        rev: 2,
        content: expertise(),
      },
    ];
  };
  const aiCalls = () =>
    calls().filter((c) => c.url.startsWith('/content-studio/ai/setup/'));
  const opened = (step: number) =>
    expect(screen.getByText(`Step ${step} of 4`)).toBeTruthy();
  const stale = (patch: Record<string, unknown> = {}) =>
    window.localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        v: 1,
        step: 3,
        connectionId: CONNECTION.id,
        manual: false,
        company: {
          companyName: 'Next Level Web',
          tagline: '',
          website: '',
          description: 'Typed long ago.',
          goal: '',
          audience: '',
          language: 'nl',
        },
        source: null,
        profile: null,
        saved: {},
        ...patch,
      })
    );

  it('S1 a saved setup and a stale step-3 draft in this browser: step 4, with the saved profile, and the stale draft gone', async () => {
    savedSetup();
    stale();
    await show();
    opened(4);
    expect(
      screen.getByRole('heading', { name: 'Your profile is ready!' })
    ).toBeTruthy();
    expect(aiCalls()).toEqual([]);
    const kept = JSON.parse(window.localStorage.getItem(DRAFT_KEY) as string);
    expect(kept.step).toBe(4);
    expect(kept.source).toBe('saved');
    expect(kept.profile.writing.content.voice).toBe(VOICE);
    expect(kept.base).toBeTruthy();
  });

  it('S2 a saved setup is never drafted or saved again by opening it', async () => {
    savedSetup();
    await show();
    opened(4);
    fireEvent.click(button(/^Your content profile/));
    await flush();
    opened(3);
    expect(screen.getByText(/This is your saved profile/)).toBeTruthy();
    expect(screen.getByText(VOICE)).toBeTruthy();
    fireEvent.click(button('Next'));
    await flush();
    fireEvent.click(button('Create my first post'));
    await flush();
    // nothing of the profile was written, and no AI drafted it
    expect(aiCalls()).toEqual([]);
    expect(dataWrites().map((w) => w.url)).toEqual([
      '/content-studio/activation/first-post',
    ]);
  });

  it('S3 revisiting step 2 goes on with the saved profile; the AI drafts only when asked', async () => {
    savedSetup();
    await show();
    fireEvent.click(button(/^Your company/));
    await flush();
    opened(2);
    expect(field('Company name').value).toBe('Next Level Web');
    expect(
      screen.queryByRole('button', { name: 'Draft my profile with AI' })
    ).toBeNull();
    fireEvent.click(button('Next'));
    await flush();
    opened(3);
    expect(screen.getByText(VOICE)).toBeTruthy();
    expect(aiCalls()).toEqual([]);
    // asked for by name: then it drafts
    fireEvent.click(button(/^Your company/));
    await flush();
    fireEvent.click(button('Draft a new profile with AI'));
    await flush();
    expect(
      aiCalls()
        .filter((c) => c.method === 'POST')
        .map((c) => c.url)
    ).toEqual(['/content-studio/ai/setup/proposal']);
  });

  it('S4 /content-studio/setup without anything kept opens where the organization stands', async () => {
    await show();
    opened(1);
    cleanup();
    window.localStorage.clear();
    savedSetup();
    await show();
    opened(4);
    // a saved setup is looked at again, not finished later
    expect(
      screen.getByRole('link', { name: 'Back to Content Studio' })
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Finish later' })).toBeNull();
  });

  it('S5 a first post that exists is opened, never started again; a return finds the assistant as it was', async () => {
    savedSetup();
    state.firstPostRead = () =>
      reply(200, {
        packageId: 'first-post-package',
        package: {
          name: 'First post',
          draftVersion: 2,
          archived: false,
          text: 'x',
        },
        research: null,
        draft: null,
        alternatives: [],
        firstPost: { scheduled: false, published: false },
        activated: false,
      });
    await show();
    opened(4);
    expect(screen.getByText(/Your first post is waiting for you/)).toBeTruthy();
    fireEvent.click(button('Open my first post'));
    await flush();
    expect(mockRouter.push).toHaveBeenCalledWith('/content-studio/first-post');
    expect(dataWrites()).toEqual([]);
  });

  it('S5 a revisit of exactly the saved setup is continued; once the setup is saved again elsewhere it is stale', async () => {
    savedSetup();
    await show();
    fireEvent.click(button(/^Your content profile/));
    await flush();
    cleanup();
    await show();
    opened(3);
    // saved again under Brand & AI meanwhile
    cleanup();
    state.profiles['/content-studio/writing-profiles'][0].rev = 2;
    await show();
    opened(4);
    expect(aiCalls()).toEqual([]);
  });

  it('a changed saved profile is saved on the way to the first post, as a new version', async () => {
    savedSetup();
    state.firstPostRead = () =>
      reply(200, {
        packageId: 'first-post-package',
        package: {
          name: 'First post',
          draftVersion: 2,
          archived: false,
          text: 'x',
        },
        research: null,
        draft: null,
        alternatives: [],
        firstPost: { scheduled: false, published: false },
        activated: false,
      });
    await show();
    fireEvent.click(button(/^Your company/));
    await flush();
    type('Company name', 'Next Level Web BV');
    fireEvent.click(button('Next'));
    await flush();
    fireEvent.click(button('Next'));
    await flush();
    fireEvent.click(button('Save and open my first post'));
    await flush();
    expect(dataWrites().map((w) => w.url)).toEqual([
      '/content-studio/brand-kit/revisions',
    ]);
    expect(mockRouter.push).toHaveBeenCalledWith('/content-studio/first-post');
  });

  it('S4 a connection that needs attention listed first does not take the AI path away: the working one is used', async () => {
    savedSetup();
    const healthy = {
      ...CONNECTION,
      id: '44444444-4444-4444-8444-444444444445',
      name: 'Working',
    };
    state.connections = [
      {
        ...CONNECTION,
        name: 'A no credit',
        lastValidationStatus: 'invalid',
        lastValidationCode: 'QUOTA_EXCEEDED',
      } as typeof CONNECTION,
      healthy,
    ];
    await show();
    opened(4);
    fireEvent.click(button('Create my first post'));
    await flush();
    expect(
      calls().find(
        (c) =>
          c.method === 'POST' &&
          c.url === '/content-studio/activation/first-post'
      )?.body.connectionId
    ).toBe(healthy.id);
  });

  it('a description changed in step 2 goes into the profile and is saved with it; the language alone saves nothing', async () => {
    savedSetup();
    await show();
    fireEvent.click(button('Back'));
    await flush();
    fireEvent.click(button('Back'));
    await flush();
    opened(2);
    fireEvent.change(field('Language of your posts'), {
      target: { value: 'en' },
    });
    fireEvent.click(button('Next'));
    await flush();
    fireEvent.click(button('Next'));
    await flush();
    expect(button('Create my first post')).toBeTruthy();
    fireEvent.click(button('Back'));
    await flush();
    fireEvent.click(button('Back'));
    await flush();
    type('What does your company do?', 'We now also host websites.');
    fireEvent.click(button('Next'));
    await flush();
    expect(screen.getByText('We now also host websites.')).toBeTruthy();
    fireEvent.click(button('Next'));
    await flush();
    fireEvent.click(button('Create my first post'));
    await flush();
    const kit = writes().find(
      (w) => w.url === '/content-studio/brand-kit/revisions'
    );
    expect(kit?.body.content.identity.description).toBe(
      'We now also host websites.'
    );
    expect(dataWrites().map((w) => w.url)).toEqual([
      '/content-studio/brand-kit/revisions',
      '/content-studio/activation/first-post',
    ]);
  });

  it('an archived first post is not opened again: a new one is made', async () => {
    savedSetup();
    state.firstPostRead = () =>
      reply(200, {
        packageId: 'first-post-package',
        package: {
          name: 'First post',
          draftVersion: 2,
          archived: true,
          text: 'x',
        },
        research: null,
        draft: null,
        alternatives: [],
        firstPost: { scheduled: false, published: false },
        activated: false,
      });
    await show();
    fireEvent.click(button('Create my first post'));
    await flush();
    expect(
      calls().some(
        (c) =>
          c.method === 'POST' &&
          c.url === '/content-studio/activation/first-post'
      )
    ).toBe(true);
  });

  it('the pure rule: saved wins, a revisit of exactly it is continued, nothing saved keeps what was kept', () => {
    const { chooseContentStudioSetupStart } = require('./content-studio.setup');
    expect(chooseContentStudioSetupStart(null, 'b')).toBe('saved');
    expect(chooseContentStudioSetupStart({ v: 1 }, 'b')).toBe('saved');
    expect(chooseContentStudioSetupStart({ v: 1, base: 'a' }, 'b')).toBe(
      'saved'
    );
    expect(chooseContentStudioSetupStart({ v: 1, base: 'b' }, 'b')).toBe(
      'resume'
    );
    expect(chooseContentStudioSetupStart({ v: 1 }, null)).toBe('resume');
    expect(chooseContentStudioSetupStart(null, null)).toBe('new');
  });
});
