// the media service reaches Postiz's upload stack, which these tests never use
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);

import { ContentStudioActivationService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.activation.service';
import { ContentStudioAIExecutionService } from '@gitroom/nestjs-libraries/content-studio/ai/ai.execution.service';
import { ContentStudioAIProviderError } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import { ContentStudioAITextRequest } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';
import { parseContentStudioEditorialPolicyContent } from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy';

// The first post (activation flow 01) through the real activation and AI
// execution services: research, then the draft that follows it on the
// server, put into the package that holds the first post. Repositories,
// profiles and the provider are stand-ins; the provider answers only when a
// test says so, so the request that started it is long gone by then

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const PACKAGE = '55555555-5555-4555-8555-555555555555';

const policyWith = (lookFor: string[]) =>
  parseContentStudioEditorialPolicyContent({
    schemaVersion: 1,
    principles: ['Show expertise'],
    prohibitedTopics: [],
    claimRules: [],
    ctaRules: ['Invite a conversation'],
    formatConventions: [],
    complianceNotes: '',
    research: { lookFor, avoid: ['Hype'], freshness: 'week', angles: [] },
  });

const researchAnswer = (topic = 'AI in het mkb') =>
  JSON.stringify({
    topic,
    angle: 'Wat werkt echt',
    summary: 'Samenvatting',
    why: { audience: 'a', expertise: 'b', timing: 'c' },
    sources: [
      {
        title: 'Radar article',
        url: 'https://news.example/ai',
        publisher: null,
        publishedAt: '2026-10-28',
      },
    ],
  });
const draftAnswer = (text = 'Eerste post over AI in het mkb.') =>
  JSON.stringify({ text });
const result = (text: string) => ({
  text,
  finishReason: 'stop' as const,
  usage: { inputTokens: 10, outputTokens: 20 },
});

const build = (
  options: {
    provider?: 'codex' | 'openai';
    // the language of the latest audience, the one the posts are written in
    audienceLocale?: string | null;
  } = {}
) => {
  const provider = options.provider ?? 'codex';
  let policy = policyWith(['AI in het mkb']);
  // the provider: each call waits until the test answers it
  const calls: Array<{
    request: ContentStudioAITextRequest;
    answer: (text: string) => void;
    refuse: (err: unknown) => void;
  }> = [];
  const adapter = {
    provider,
    validateConnection: jest.fn(),
    generateText: jest.fn(
      (request: ContentStudioAITextRequest) =>
        new Promise((resolve, reject) => {
          calls.push({
            request,
            answer: (text) => resolve(result(text)),
            refuse: reject,
          });
        })
    ),
  };
  const resolver = {
    resolve: jest.fn(async () => ({
      connectionId: CONNECTION,
      provider,
      adapter,
    })),
  };
  // the packages, as the Content Studio service keeps them
  const packages = new Map<string, any>();
  const service = {
    createPackage: jest.fn(async (input: { name: string }) => {
      packages.set(PACKAGE, {
        id: PACKAGE,
        name: input.name,
        draftVersion: 1,
        archivedAt: null,
        draft: {
          schemaVersion: 1,
          copy: { global: { thread: [{ id: 'i1', text: '', mediaIds: [] }] } },
        },
      });
      return { id: PACKAGE };
    }),
    getPackage: jest.fn(async (_org: string, id: string) => {
      const found = packages.get(id);
      if (!found) {
        throw new Error('not found');
      }
      return JSON.parse(JSON.stringify(found));
    }),
    saveDraft: jest.fn(
      async (input: {
        packageId: string;
        baseDraftVersion: number;
        draft: any;
      }) => {
        const found = packages.get(input.packageId);
        if (found.draftVersion !== input.baseDraftVersion) {
          throw new Error('conflict');
        }
        found.draft = input.draft;
        found.draftVersion += 1;
        return { draftVersion: found.draftVersion };
      }
    ),
  };
  const repository = {
    getPackageForOrganization: jest.fn(
      async (_org: string, id: string) => packages.get(id) ?? null
    ),
  };
  const stored: any[] = [];
  const operations = {
    createRunningOperation: jest.fn(async (input: any) => {
      stored.unshift({
        ...input,
        status: 'running',
        result: null,
        errorCode: null,
        completedAt: null,
      });
      return { id: input.id };
    }),
    completeSucceededWithUsage: jest.fn(async (input: any) => {
      const op = stored.find((entry) => entry.id === input.operationId);
      Object.assign(op, {
        status: 'succeeded',
        result: input.result ?? null,
        completedAt: new Date(),
      });
      return { completed: true };
    }),
    completeFailedWithUsage: jest.fn(async (input: any) => {
      const op = stored.find((entry) => entry.id === input.operationId);
      Object.assign(op, {
        status: 'failed',
        errorCode: input.errorCode,
        completedAt: new Date(),
      });
      return { completed: true };
    }),
    listOperationStatesForOrganization: jest.fn(
      async (input: { organizationId: string; kinds: readonly string[] }) =>
        stored.filter(
          (op) =>
            op.organizationId === input.organizationId &&
            input.kinds.includes(op.kind)
        )
    ),
  };
  const execution = new ContentStudioAIExecutionService(
    repository as never,
    resolver as never,
    operations as never
  );
  const profiles = (id: string) => ({
    listProfilesForOrganization: jest.fn(async () => [{ id }]),
  });
  const writing = {
    resolveProfileContext: jest.fn(async () => ({
      context: {
        writing: null,
        editorialPolicy: policy,
        audience:
          options.audienceLocale === undefined
            ? null
            : {
                schemaVersion: 1,
                description: 'Ondernemers',
                role: 'Eigenaar',
                knowledgeLevel: 'beginner',
                goals: [],
                painPoints: [],
                objections: [],
                preferredTone: null,
                locale: options.audienceLocale,
              },
        expertise: null,
      },
      refs: {},
    })),
  };
  const policyService = {
    getPolicy: jest.fn(async () => ({
      latestRevisionNumber: 1,
      currentRevision: { content: policy },
    })),
  };
  const brandKit = {
    getBrandKit: jest.fn(async () => ({
      latestRevisionNumber: 1,
      currentRevision: {
        content: {
          identity: {
            brandName: 'Testbedrijf ABC',
            tagline: 'Slim groeien',
            description: 'Websites en automatisering',
          },
        },
      },
    })),
  };
  const discoveries = {
    listDiscoveriesForOrganization: jest.fn(async () => [
      {
        entryTitle: 'Radar article',
        publishedAt: new Date('2026-10-28T08:00:00Z'),
        discoveredSource: {
          name: 'Radar article',
          canonicalUrl: 'https://news.example/ai',
        },
        feedSource: { name: 'Branche' },
      },
    ]),
  };
  const activation = {
    getFirstHandoffOfPackage: jest.fn(
      async (): Promise<{ createdAt: Date } | null> => null
    ),
    listPostStatesSince: jest.fn(
      async (): Promise<Array<{ state: string }>> => []
    ),
    getLatestDraftSince: jest.fn(
      async (): Promise<{ publishDate: Date } | null> => null
    ),
  };
  const connections = {
    getConnectionForOrganization: jest.fn(async () => ({
      id: CONNECTION,
      provider,
      defaultModel: provider === 'codex' ? 'gpt-6.1-sol' : 'gpt-6.1-sol',
    })),
  };
  const activationService = new ContentStudioActivationService(
    connections as never,
    execution,
    operations as never,
    writing as never,
    profiles('w1') as never,
    profiles('a1') as never,
    profiles('e1') as never,
    brandKit as never,
    policyService as never,
    discoveries as never,
    service as never,
    activation as never
  );
  return {
    activationService,
    calls,
    packages,
    service,
    stored,
    activation,
    policyService,
    setPolicy: (next: ReturnType<typeof policyWith>) => {
      policy = next;
    },
  };
};
type Ctx = ReturnType<typeof build>;

const start = (ctx: Ctx, mode: string) =>
  ctx.activationService.startFirstPost({
    organizationId: ORG,
    userId: USER,
    request: {
      connectionId: CONNECTION,
      mode,
      language: 'nl',
      name: 'Eerste post',
    },
  });
const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
const state = (ctx: Ctx) => ctx.activationService.getFirstPost(ORG);

// research answered, draft answered: the first post as the user sees it
const firstPost = async (ctx: Ctx) => {
  await start(ctx, 'first');
  ctx.calls[0].answer(researchAnswer());
  await settle();
  ctx.calls[1].answer(draftAnswer());
  await settle();
};

describe('First post: research and draft that outlive the request', () => {
  it('BG8 starting answers at once; research, then the draft, run on the server and are read back', async () => {
    const ctx = build();
    const { packageId } = await start(ctx, 'first');
    expect(packageId).toBe(PACKAGE);
    expect(ctx.service.createPackage).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Eerste post' })
    );
    // nobody waits: the request is gone
    expect((await state(ctx)).research).toMatchObject({ status: 'running' });

    ctx.calls[0].answer(researchAnswer());
    await settle();
    const drafting = await state(ctx);
    expect(drafting.research).toMatchObject({
      status: 'succeeded',
      result: { topic: 'AI in het mkb', sourceBacked: true },
    });
    expect(drafting.draft).toMatchObject({ status: 'running' });

    ctx.calls[1].answer(draftAnswer());
    await settle();
    const ready = await state(ctx);
    expect(ready.draft).toMatchObject({ status: 'succeeded', applied: true });
    expect(ready.package).toMatchObject({
      text: 'Eerste post over AI in het mkb.',
    });
    expect(ctx.calls).toHaveLength(2);
  });

  it('RES1/RES2 the research uses the profile, the preferences and the radar findings; codex searches the web', async () => {
    const ctx = build();
    await start(ctx, 'first');
    const [{ request }] = ctx.calls;
    expect(request.webSearch).toBe(true);
    expect(request.prompt).toContain('Websites en automatisering');
    expect(request.prompt).toContain('AI in het mkb');
    expect(request.prompt).toContain('https://news.example/ai');
    expect(request.prompt).toContain('Invite a conversation');
    // a model that cannot search is never asked to
    const plain = build({ provider: 'openai' });
    await start(plain, 'first');
    expect(plain.calls[0].request.webSearch).toBeUndefined();
    expect(plain.calls[0].request.prompt).toContain(
      'You cannot search the web'
    );
  });

  it('RES4 the draft is written from the research that was found', async () => {
    const ctx = build();
    await start(ctx, 'first');
    ctx.calls[0].answer(researchAnswer('ONDERWERP_X'));
    await settle();
    expect(ctx.calls[1].request.prompt).toContain('ONDERWERP_X');
    expect(ctx.calls[1].request.prompt).toContain('https://news.example/ai');
  });

  it('does not start twice while research or a draft runs', async () => {
    const ctx = build();
    await start(ctx, 'first');
    await start(ctx, 'angle');
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.service.createPackage).toHaveBeenCalledTimes(1);
  });
});

describe('First post: failures say where it stopped', () => {
  it('research failed: its code, no draft, the package as it was', async () => {
    const ctx = build();
    await start(ctx, 'first');
    ctx.calls[0].refuse(new ContentStudioAIProviderError('RATE_LIMITED'));
    await settle();
    const now = await state(ctx);
    expect(now.research).toMatchObject({
      status: 'failed',
      code: 'CS_AI_RATE_LIMITED',
    });
    expect(now.draft).toBeNull();
    expect(now.package).toMatchObject({ text: '' });
  });

  it('research succeeded but the draft failed: a new draft asks for the draft only', async () => {
    const ctx = build();
    await start(ctx, 'first');
    ctx.calls[0].answer(researchAnswer());
    await settle();
    ctx.calls[1].refuse(new ContentStudioAIProviderError('TIMEOUT'));
    await settle();
    expect((await state(ctx)).draft).toMatchObject({
      status: 'failed',
      code: 'CS_AI_TIMEOUT',
    });
    await start(ctx, 'draft');
    expect(ctx.calls).toHaveLength(3);
    expect(ctx.calls[2].request.prompt).toContain(
      'Write the first social media post'
    );
    ctx.calls[2].answer(draftAnswer('Tweede poging.'));
    await settle();
    expect((await state(ctx)).package).toMatchObject({
      text: 'Tweede poging.',
    });
  });

  it('the draft was made but could not be put into the post: apply puts it in, without AI', async () => {
    const ctx = build();
    await start(ctx, 'first');
    ctx.calls[0].answer(researchAnswer());
    await settle();
    ctx.service.saveDraft.mockRejectedValueOnce(new Error('db'));
    ctx.calls[1].answer(draftAnswer());
    await settle();
    expect((await state(ctx)).draft).toMatchObject({
      status: 'succeeded',
      applied: false,
    });
    await start(ctx, 'apply');
    expect((await state(ctx)).draft).toMatchObject({ applied: true });
    expect(ctx.calls).toHaveLength(2);
  });
});

describe('First post: another angle and refined research', () => {
  it('REF3 research again reads the refined preferences and steers away from the earlier subject', async () => {
    const ctx = build();
    await firstPost(ctx);
    ctx.setPolicy(policyWith(['NIEUWE_FOCUS_WETGEVING']));
    await start(ctx, 'research');
    const prompt = ctx.calls[2].request.prompt;
    expect(prompt).toContain('NIEUWE_FOCUS_WETGEVING');
    expect(prompt).toContain('AI in het mkb');
    expect(prompt).toMatch(/different subject or a clearly different angle/);
  });

  it('REF5 a new draft replaces the first post text only: same package, name, other items and media kept', async () => {
    const ctx = build();
    await firstPost(ctx);
    const pkg = ctx.packages.get(PACKAGE);
    pkg.name = 'Mijn eerste post';
    pkg.draft.copy.global.thread = [
      {
        id: 'i1',
        text: pkg.draft.copy.global.thread[0].text,
        mediaIds: ['m1'],
      },
      { id: 'i2', text: 'Tweede item', mediaIds: [] },
    ];
    await start(ctx, 'angle');
    ctx.calls[2].answer(researchAnswer('Ander onderwerp'));
    await settle();
    ctx.calls[3].answer(draftAnswer('Nieuwe invalshoek.'));
    await settle();
    const after = ctx.packages.get(PACKAGE);
    expect(after.name).toBe('Mijn eerste post');
    expect(after.draft.copy.global.thread).toEqual([
      { id: 'i1', text: 'Nieuwe invalshoek.', mediaIds: ['m1'] },
      { id: 'i2', text: 'Tweede item', mediaIds: [] },
    ]);
    expect(ctx.service.createPackage).toHaveBeenCalledTimes(1);
  });

  it('REF6 another angle keeps the research preferences as they are', async () => {
    const ctx = build();
    await firstPost(ctx);
    await start(ctx, 'angle');
    expect(ctx.calls[2].request.prompt).toContain('AI in het mkb');
    // only read: there is nothing here that could write a policy
    expect(Object.keys(ctx.policyService)).toEqual(['getPolicy']);
    expect(ctx.policyService.getPolicy).toHaveBeenCalled();
  });
});

describe('First post: the language of the posts (review 03)', () => {
  const asked = (ctx: Ctx, index: number) =>
    `${ctx.calls[index].request.system}\n${ctx.calls[index].request.prompt}`;
  const withoutLanguage = (ctx: Ctx, mode: string) =>
    ctx.activationService.startFirstPost({
      organizationId: ORG,
      userId: USER,
      request: { connectionId: CONNECTION, mode },
    });

  it('LANG4/LANG5 another angle, which sends no language, researches and drafts in the saved audience language (nl)', async () => {
    const ctx = build({ audienceLocale: 'nl' });
    await firstPost(ctx);
    await withoutLanguage(ctx, 'angle');
    expect(asked(ctx, 2)).toContain('the language with the tag nl');
    ctx.calls[2].answer(researchAnswer('Iets anders'));
    await settle();
    expect(asked(ctx, 3)).toContain('the language with the tag nl');
  });

  it('LANG4/LANG6 a language chosen in the setup wins over the saved audience language', async () => {
    const ctx = build({ audienceLocale: 'en' });
    await start(ctx, 'first');
    expect(asked(ctx, 0)).toContain('the language with the tag nl');
    expect(asked(ctx, 0)).not.toContain('the language with the tag en');
  });

  it('English only as the last fallback: no language chosen and none saved', async () => {
    const ctx = build({ audienceLocale: null });
    await withoutLanguage(ctx, 'first');
    expect(asked(ctx, 0)).toContain('the language with the tag en');
  });
});

describe('First post: activation is a scheduled or published post', () => {
  it('AC1 a draft alone is not activation', async () => {
    const ctx = build();
    await firstPost(ctx);
    expect(await state(ctx)).toMatchObject({
      activated: false,
      firstPost: { scheduled: false, published: false, savedAsDraft: null },
    });
    expect(ctx.activation.listPostStatesSince).not.toHaveBeenCalled();
    expect(ctx.activation.getLatestDraftSince).not.toHaveBeenCalled();
  });

  it('AC2 a post scheduled after the first post went to the composer is activation', async () => {
    const ctx = build();
    await firstPost(ctx);
    const handedOff = new Date('2026-10-30T10:00:00Z');
    ctx.activation.getFirstHandoffOfPackage.mockResolvedValue({
      createdAt: handedOff,
    });
    ctx.activation.listPostStatesSince.mockResolvedValue([{ state: 'QUEUE' }]);
    expect(await state(ctx)).toMatchObject({
      activated: true,
      firstPost: { scheduled: true, published: false },
    });
    expect(ctx.activation.listPostStatesSince).toHaveBeenCalledWith(
      ORG,
      handedOff
    );
  });

  it('AC3 a published post is activation', async () => {
    const ctx = build();
    await firstPost(ctx);
    ctx.activation.getFirstHandoffOfPackage.mockResolvedValue({
      createdAt: new Date(),
    });
    ctx.activation.listPostStatesSince.mockResolvedValue([
      { state: 'PUBLISHED' },
    ]);
    expect(await state(ctx)).toMatchObject({
      activated: true,
      firstPost: { scheduled: false, published: true },
    });
  });

  it('no first post yet: nothing started, nothing activated', async () => {
    expect(await state(build())).toEqual({
      packageId: null,
      research: null,
      draft: null,
      alternatives: [],
      firstPost: { scheduled: false, published: false, savedAsDraft: null },
      activated: false,
    });
  });

  it('ACT9 like the clone: handed off 22:24, then saved in the composer as a draft for 25 November: no activation, the draft is said', async () => {
    const ctx = build();
    await firstPost(ctx);
    const handedOff = new Date('2026-10-30T22:24:15.154Z');
    const planned = new Date('2026-11-25T07:20:00.000Z');
    ctx.activation.getFirstHandoffOfPackage.mockResolvedValue({
      createdAt: handedOff,
    });
    // drafts never count as scheduled or published
    ctx.activation.listPostStatesSince.mockResolvedValue([]);
    ctx.activation.getLatestDraftSince.mockResolvedValue({
      publishDate: planned,
    });
    expect(await state(ctx)).toMatchObject({
      activated: false,
      firstPost: {
        scheduled: false,
        published: false,
        savedAsDraft: { publishDate: planned },
      },
    });
    expect(ctx.activation.getLatestDraftSince).toHaveBeenCalledWith(
      ORG,
      handedOff
    );
  });

  it('ACT2/ACT9 the same post scheduled instead (QUEUE) is activation, and no draft is looked for', async () => {
    const ctx = build();
    await firstPost(ctx);
    ctx.activation.getFirstHandoffOfPackage.mockResolvedValue({
      createdAt: new Date('2026-10-30T22:24:15.154Z'),
    });
    ctx.activation.listPostStatesSince.mockResolvedValue([{ state: 'QUEUE' }]);
    expect(await state(ctx)).toMatchObject({
      activated: true,
      firstPost: { scheduled: true, published: false, savedAsDraft: null },
    });
    expect(ctx.activation.getLatestDraftSince).not.toHaveBeenCalled();
  });
});

describe('First post: requests', () => {
  it.each([
    ['an unknown mode', { mode: 'publish' }],
    ['a connection id that is not a uuid', { connectionId: 'x' }],
    ['an odd language', { language: 'nl;drop' }],
  ])('refuses %s before anything starts', async (_label, patch) => {
    const ctx = build();
    await expect(
      ctx.activationService.startFirstPost({
        organizationId: ORG,
        userId: USER,
        request: { connectionId: CONNECTION, mode: 'first', ...patch },
      })
    ).rejects.toMatchObject({ response: { code: 'CS_INVALID_REQUEST' } });
    expect(ctx.calls).toHaveLength(0);
  });

  it('a new draft or apply before any research is refused', async () => {
    const ctx = build();
    for (const mode of ['draft', 'apply']) {
      await expect(start(ctx, mode)).rejects.toMatchObject({
        response: { code: 'CS_FIRST_POST_NOT_STARTED' },
      });
    }
  });
});

describe('First post: review hardening', () => {
  it('a second start while the first is still being set up is refused, not researched twice', async () => {
    const ctx = build();
    const [one, two] = await Promise.allSettled([
      start(ctx, 'first'),
      start(ctx, 'first'),
    ]);
    expect(one.status).toBe('fulfilled');
    expect(two).toMatchObject({
      status: 'rejected',
      reason: { response: { code: 'CS_FIRST_POST_STARTING' } },
    });
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.service.createPackage).toHaveBeenCalledTimes(1);
    // and a later start works again
    ctx.calls[0].refuse(new ContentStudioAIProviderError('TIMEOUT'));
    await settle();
    await start(ctx, 'research');
    expect(ctx.calls).toHaveLength(2);
  });

  it('text the user saved while the draft was written is kept; the new draft waits for "Use the new draft"', async () => {
    const ctx = build();
    await start(ctx, 'first');
    ctx.calls[0].answer(researchAnswer());
    await settle();
    // the user writes their own text in the editor meanwhile
    const pkg = ctx.packages.get(PACKAGE);
    pkg.draft.copy.global.thread[0].text = 'Mijn eigen tekst';
    pkg.draftVersion += 1;
    ctx.calls[1].answer(draftAnswer('AI-tekst'));
    await settle();
    const now = await state(ctx);
    expect(now.package).toMatchObject({ text: 'Mijn eigen tekst' });
    expect(now.draft).toMatchObject({ status: 'succeeded', applied: false });
    await start(ctx, 'apply');
    expect((await state(ctx)).package).toMatchObject({ text: 'AI-tekst' });
  });
});

// Activation review 02: what was made for the first post stays, and coming
// back to it never starts it again
describe('First post: earlier drafts are kept and can be put back', () => {
  // the first post, then another draft from the mode asked for
  const twoDrafts = async (ctx: Ctx, mode: 'angle' | 'research') => {
    await firstPost(ctx);
    await start(ctx, mode);
    ctx.calls[2].answer(researchAnswer('Ander onderwerp'));
    await settle();
    ctx.calls[3].answer(draftAnswer('Tweede versie.'));
    await settle();
  };

  it('P1 research and draft are read back from the server, as often as asked', async () => {
    const ctx = build();
    await firstPost(ctx);
    const one = await state(ctx);
    expect(await state(ctx)).toEqual(one);
    expect(one.package).toMatchObject({
      text: 'Eerste post over AI in het mkb.',
    });
    expect(one.research).toMatchObject({
      status: 'succeeded',
      result: { topic: 'AI in het mkb' },
    });
    expect(ctx.calls).toHaveLength(2);
  });

  it('P3 starting the first post again once it exists (setup opened again, a return) researches nothing', async () => {
    const ctx = build();
    await firstPost(ctx);
    const { packageId } = await start(ctx, 'first');
    expect(packageId).toBe(PACKAGE);
    expect(ctx.calls).toHaveLength(2);
    expect(ctx.service.createPackage).toHaveBeenCalledTimes(1);
    expect((await state(ctx)).package).toMatchObject({
      text: 'Eerste post over AI in het mkb.',
    });
  });

  it('P4 another angle keeps the previous draft, with its own research', async () => {
    const ctx = build();
    await twoDrafts(ctx, 'angle');
    const now = await state(ctx);
    expect(now.package).toMatchObject({ text: 'Tweede versie.' });
    expect(
      now.alternatives.map((alternative) => ({
        text: alternative.text,
        topic: alternative.research?.topic,
        current: alternative.current,
      }))
    ).toEqual([
      { text: 'Tweede versie.', topic: 'Ander onderwerp', current: true },
      {
        text: 'Eerste post over AI in het mkb.',
        topic: 'AI in het mkb',
        current: false,
      },
    ]);
  });

  it('P5 an earlier draft is put back into the post without AI, and the newer one stays', async () => {
    const ctx = build();
    await twoDrafts(ctx, 'angle');
    const earlier = (await state(ctx)).alternatives[1];
    await ctx.activationService.startFirstPost({
      organizationId: ORG,
      userId: USER,
      request: {
        connectionId: CONNECTION,
        mode: 'apply',
        draftOperationId: earlier.operationId,
      },
    });
    expect(ctx.calls).toHaveLength(4);
    const now = await state(ctx);
    expect(now.package).toMatchObject({
      text: 'Eerste post over AI in het mkb.',
    });
    expect(now.alternatives.map((alternative) => alternative.current)).toEqual([
      false,
      true,
    ]);
    // a draft of another package, or one that does not exist, is refused
    await expect(
      ctx.activationService.startFirstPost({
        organizationId: ORG,
        userId: USER,
        request: {
          connectionId: CONNECTION,
          mode: 'apply',
          draftOperationId: '99999999-9999-4999-8999-999999999999',
        },
      })
    ).rejects.toMatchObject({
      response: { code: 'CS_FIRST_POST_NOT_STARTED' },
    });
  });

  it('P6 refined research adds a draft; the earlier one is still there', async () => {
    const ctx = build();
    await twoDrafts(ctx, 'research');
    const now = await state(ctx);
    expect(now.alternatives).toHaveLength(2);
    expect(now.alternatives[1]).toMatchObject({
      text: 'Eerste post over AI in het mkb.',
      research: { topic: 'AI in het mkb' },
    });
  });

  it.each([
    ['with another mode', { mode: 'angle', draftOperationId: PACKAGE }],
    ['that is not a uuid', { mode: 'apply', draftOperationId: 'x' }],
  ])('refuses an earlier draft %s', async (_label, patch) => {
    const ctx = build();
    await expect(
      ctx.activationService.startFirstPost({
        organizationId: ORG,
        userId: USER,
        request: { connectionId: CONNECTION, ...patch },
      })
    ).rejects.toMatchObject({ response: { code: 'CS_INVALID_REQUEST' } });
  });
});
