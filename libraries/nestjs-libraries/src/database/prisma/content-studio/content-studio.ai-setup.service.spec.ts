import { inspect } from 'util';
import { HttpException, Logger } from '@nestjs/common';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioAIConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.repository';
import { ContentStudioAIOperationRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-operation.repository';
import {
  ContentStudioAISetupService,
  SETUP_TIMEOUT_MS,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-setup.service';
import { ContentStudioAIExecutionService } from '@gitroom/nestjs-libraries/content-studio/ai/ai.execution.service';
import { AI_OPERATION_INTERRUPTED_AFTER_MS } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-writing.service';
import { ContentStudioAIProviderResolver } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.resolver';
import {
  ContentStudioAIProviderError,
  ContentStudioAIResolutionError,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import {
  AI_REQUEST_TIMEOUT_MAX_MS,
  ContentStudioAITextRequest,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';
import {
  CONTENT_STUDIO_AI_SETUP_PROMPT_VERSION,
  CONTENT_STUDIO_AI_SETUP_SCHEMA_NAME,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.setup.prompt';

// The guided setup's AI draft through the real setup and AI execution
// services. Only the repositories, the provider resolver and its adapter are
// stand-ins: the operation is recorded through the real execution path, for
// the organization, with no package and no design

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const COMPANY = 'COMPANY_PRIVATE_SETUP Next Level Web';
const KEY = 'sk-content-studio-test-secret-setup';

const validAnswer = () => ({
  brand: { tagline: 'Websites that work', description: 'A web studio.' },
  writing: {
    name: 'Studio voice',
    voice: 'Direct.',
    toneTags: ['practical'],
    perspective: 'first_plural',
    emoji: 'none',
    hashtags: 'few',
    formattingNotes: null,
    prefer: ['concrete'],
    avoid: [{ term: 'revolutionary', reason: 'Hype.' }],
    dos: ['Be specific.'],
    donts: [],
  },
  audiences: [
    {
      name: 'Shop owners',
      description: 'Local shops.',
      role: 'Owner',
      knowledgeLevel: 'beginner',
      goals: ['More customers'],
      painPoints: [],
      objections: [],
      preferredTone: null,
    },
  ],
  expertise: {
    name: 'Web expertise',
    subjects: ['Websites'],
    differentiators: [],
    stances: [],
    frameworks: [],
    evidenceExpectations: '',
    avoidTopics: [],
    confidenceBoundaries: '',
  },
  editorial: {
    principles: ['Useful first.'],
    prohibitedTopics: [],
    claimRules: [],
    ctaRules: [],
    formatConventions: [],
    complianceNotes: '',
  },
});

const providerResult = (text: string) => ({
  text,
  finishReason: 'stop' as 'stop' | 'length',
  usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  providerRequestId: 'req_setup_1',
});

const build = (
  options: { provider?: string; defaultModel?: string | null } = {}
) => {
  const provider = options.provider ?? 'openai';
  const connection = {
    id: CONNECTION,
    name: 'Team AI',
    provider,
    defaultModel:
      options.defaultModel === undefined ? null : options.defaultModel,
    disabledAt: null,
  };
  const connections = {
    getConnectionForOrganization: jest.fn(
      async (organizationId: string, id: string) =>
        organizationId === ORG && id === CONNECTION ? { ...connection } : null
    ),
    setValidationResult: jest.fn(async () => ({ count: 1 })),
  };
  const adapter = {
    provider,
    validateConnection: jest.fn(),
    generateText: jest.fn(async (_request: ContentStudioAITextRequest) =>
      providerResult(JSON.stringify(validAnswer()))
    ),
  };
  const resolver = {
    resolve: jest.fn(
      async (where: { organizationId: string; connectionId: string }) => {
        if (where.organizationId !== ORG || where.connectionId !== CONNECTION) {
          throw new ContentStudioAIResolutionError('NOT_FOUND');
        }
        return { connectionId: CONNECTION, provider, adapter };
      }
    ),
  };
  // the operations as the repository keeps them: created running, completed
  // once, read back by the organization
  const stored = new Map<string, Record<string, any>>();
  const operations = {
    createRunningOperation: jest.fn(async (input: Record<string, any>) => {
      stored.set(input.id, { ...input, status: 'running', result: null });
      return { id: input.id };
    }),
    completeSucceededWithUsage: jest.fn(async (input: Record<string, any>) => {
      const op = stored.get(input.operationId);
      if (!op || op.status !== 'running') {
        return { completed: false };
      }
      Object.assign(op, {
        status: 'succeeded',
        result: input.result ?? null,
        errorCode: null,
      });
      return { completed: true };
    }),
    completeFailedWithUsage: jest.fn(async (input: Record<string, any>) => {
      const op = stored.get(input.operationId);
      if (!op || op.status !== 'running') {
        return { completed: false };
      }
      Object.assign(op, { status: 'failed', errorCode: input.errorCode });
      return { completed: true };
    }),
    getOperationStateForOrganization: jest.fn(
      async (organizationId: string, id: string) => {
        const op = stored.get(id);
        return op && op.organizationId === organizationId
          ? {
              id,
              kind: op.kind,
              status: op.status,
              packageId: null,
              baseDraftVersion: null,
              errorCode: op.errorCode ?? null,
              result: op.result,
              startedAt: op.startedAt,
              completedAt: null,
            }
          : null;
      }
    ),
  };
  // a setup operation never reads a package
  const packages = { getPackageForOrganization: jest.fn() };
  const execution = new ContentStudioAIExecutionService(
    packages as unknown as ContentStudioRepository,
    resolver as unknown as ContentStudioAIProviderResolver,
    operations as unknown as ContentStudioAIOperationRepository
  );
  const service = new ContentStudioAISetupService(
    connections as unknown as ContentStudioAIConnectionRepository,
    execution,
    operations as unknown as ContentStudioAIOperationRepository
  );
  return {
    service,
    connections,
    adapter,
    resolver,
    operations,
    packages,
    stored,
  };
};

type Ctx = ReturnType<typeof build>;

// What the assistant does: start the draft, then read it back once it is
// done. A failure reads back as the code the request used to answer, thrown
// like that answer
const propose = async (
  ctx: Ctx,
  input: Parameters<Ctx['service']['startSetup']>[0]
) => {
  const { operationId, done } = await ctx.service.startSetup(input);
  await done;
  const state = await ctx.service.getSetupProposal(
    input.organizationId,
    operationId
  );
  if (state.status === 'failed') {
    throw new HttpException({ code: state.code, msg: 'failed' }, 502);
  }
  return state as typeof state & {
    proposal: NonNullable<(typeof state & { proposal?: any })['proposal']>;
  };
};

const request = (patch: Record<string, unknown> = {}) => ({
  connectionId: CONNECTION,
  companyName: COMPANY,
  website: 'https://example.test',
  description: 'We build websites for small businesses.',
  goal: null,
  audience: null,
  language: 'nl',
  ...patch,
});

const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (err) {
    return err as HttpException;
  }
  throw new Error('expected a failure');
};
const body = (err: HttpException) =>
  err.getResponse() as { code: string; msg: string };

describe('ContentStudioAISetupService: the setup draft', () => {
  it('returns a validated draft and records one organization operation, with hashes only', async () => {
    const ctx = build();
    const result = await propose(ctx, {
      organizationId: ORG,
      userId: USER,
      request: request(),
    });
    expect(result.proposal.writing.content.perspective).toBe('first_plural');
    expect(result.proposal.audiences[0].content.locale).toBe('nl');

    expect(ctx.operations.createRunningOperation).toHaveBeenCalledTimes(1);
    const [[created]] = ctx.operations.createRunningOperation.mock
      .calls as unknown as [[Record<string, unknown>]];
    expect(created).toMatchObject({
      organizationId: ORG,
      userId: USER,
      connectionId: CONNECTION,
      packageId: null,
      designRevisionId: null,
      baseDraftVersion: null,
      kind: 'setup_proposal',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      promptVersion: CONTENT_STUDIO_AI_SETUP_PROMPT_VERSION,
      context: { v: 1 },
    });
    expect(created.requestHash).toMatch(/^[0-9a-f]{64}$/);
    // nothing the user typed is stored, and no key: only the checked draft
    // is kept with the operation, for the assistant to read back
    const stored = inspect(
      [
        ctx.operations.createRunningOperation.mock.calls,
        ctx.operations.completeSucceededWithUsage.mock.calls,
      ],
      { depth: 10 }
    );
    expect(
      JSON.stringify(ctx.operations.createRunningOperation.mock.calls)
    ).not.toContain('COMPANY_PRIVATE_SETUP');
    const [[completed]] = ctx.operations.completeSucceededWithUsage.mock
      .calls as unknown as [[Record<string, unknown>]];
    expect(completed.result).toEqual(result.proposal);
    expect(JSON.stringify(completed.result)).not.toContain(
      'COMPANY_PRIVATE_SETUP'
    );
    expect(stored).not.toContain(KEY);
    expect(ctx.packages.getPackageForOrganization).not.toHaveBeenCalled();
  });

  it('asks a model with structured output for the JSON schema, others for text', async () => {
    const openai = build();
    await propose(openai, {
      organizationId: ORG,
      userId: USER,
      request: request(),
    });
    const [[sent]] = openai.adapter.generateText.mock.calls;
    expect(sent.output).toMatchObject({
      type: 'json',
      schemaName: CONTENT_STUDIO_AI_SETUP_SCHEMA_NAME,
    });

    const anthropic = build({ provider: 'anthropic' });
    await propose(anthropic, {
      organizationId: ORG,
      userId: USER,
      request: request(),
    });
    const [[text]] = anthropic.adapter.generateText.mock.calls;
    expect(text.output).toEqual({ type: 'text' });
    expect(text.model).toBe('claude-sonnet-5-5');
  });

  it("uses the connection's own model, never one from the request", async () => {
    const ctx = build({ defaultModel: 'gpt-6-luna' });
    await propose(ctx, {
      organizationId: ORG,
      userId: USER,
      request: { ...request(), model: 'gpt-6.1-sol' } as never,
    });
    expect(ctx.adapter.generateText.mock.calls[0][0].model).toBe('gpt-6-luna');
  });

  it("refuses another organization's or a missing connection before anything is recorded", async () => {
    const ctx = build();
    const err = await failure(() =>
      propose(ctx, {
        organizationId: OTHER_ORG,
        userId: USER,
        request: request(),
      })
    );
    expect(body(err).code).toBe('CS_AI_CONNECTION_REQUIRED');
    expect(ctx.operations.createRunningOperation).not.toHaveBeenCalled();
    expect(ctx.adapter.generateText).not.toHaveBeenCalled();
  });

  it.each([
    ['a blank company name', { companyName: '   ' }],
    ['a blank description', { description: '' }],
    ['a missing description', { description: undefined }],
    ['a website that is not http(s)', { website: 'file:///etc/passwd' }],
    ['a website without a scheme', { website: 'example.test' }],
    ['an odd language tag', { language: 'nl;drop' }],
    ['a too long description', { description: 'x'.repeat(2001) }],
    ['a connection id that is not a uuid', { connectionId: 'abc' }],
    ['a NUL in a text', { goal: 'a\u0000b' }],
  ])('refuses %s without asking the provider', async (_label, patch) => {
    const ctx = build();
    const err = await failure(() =>
      propose(ctx, {
        organizationId: ORG,
        userId: USER,
        request: request(patch),
      })
    );
    expect(body(err).code).toBe('CS_INVALID_REQUEST');
    expect(ctx.connections.getConnectionForOrganization).not.toHaveBeenCalled();
    expect(ctx.adapter.generateText).not.toHaveBeenCalled();
  });

  it('defaults the language to English and never fetches the website', async () => {
    const ctx = build();
    const fetchSpy = jest.spyOn(global, 'fetch' as never);
    await propose(ctx, {
      organizationId: ORG,
      userId: USER,
      request: request({ language: null }),
    });
    expect(ctx.adapter.generateText.mock.calls[0][0].prompt).toContain(
      'language with the tag en.'
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('records an answer that is not a valid draft as a failed attempt, with a fixed message', async () => {
    const ctx = build();
    ctx.adapter.generateText.mockResolvedValueOnce(
      providerResult('Sure! Here is a draft: SECRET_DRAFT_TEXT')
    );
    const err = await failure(() =>
      propose(ctx, {
        organizationId: ORG,
        userId: USER,
        request: request(),
      })
    );
    expect(body(err).code).toBe('CS_AI_INVALID_RESPONSE');
    expect(JSON.stringify(body(err))).not.toContain('SECRET_DRAFT_TEXT');
    expect(ctx.operations.completeFailedWithUsage).toHaveBeenCalledTimes(1);
    expect(ctx.operations.completeSucceededWithUsage).not.toHaveBeenCalled();
  });

  it('maps provider failures to the shared AI codes, never the provider message', async () => {
    const ctx = build();
    ctx.adapter.generateText.mockRejectedValueOnce(
      new ContentStudioAIProviderError('AUTH_FAILED')
    );
    const err = await failure(() =>
      propose(ctx, {
        organizationId: ORG,
        userId: USER,
        request: request(),
      })
    );
    expect(body(err).code).toBe('CS_AI_AUTH_FAILED');
  });

  // UX review 02: the real first call failed (an Anthropic key without a
  // workspace); every such failure has its own code and a safe log line
  it('maps a key that needs a workspace to its own code and logs only safe diagnostics', async () => {
    const ctx = build({ provider: 'anthropic' });
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    ctx.adapter.generateText.mockRejectedValueOnce(
      new ContentStudioAIProviderError('WORKSPACE_REQUIRED', {
        httpStatus: 400,
        providerRequestId: 'req_1',
      })
    );
    const err = await failure(() =>
      propose(ctx, {
        organizationId: ORG,
        userId: USER,
        request: request(),
      })
    );
    expect(body(err).code).toBe('CS_AI_WORKSPACE_REQUIRED');
    expect(warn).toHaveBeenCalledWith(
      'setup proposal failed: provider=anthropic model=claude-sonnet-5-5 code=WORKSPACE_REQUIRED httpStatus=400 providerRequestId=req_1'
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(COMPANY);
    warn.mockRestore();
  });

  // UX review 03: the connection tested Ready, but every draft failed on an
  // Anthropic organization without API credit. Such an answer now marks the
  // connection, so its status says what to fix
  it('SR1 records an account failure on the connection, never a busy or slow provider', async () => {
    for (const code of [
      'QUOTA_EXCEEDED',
      'AUTH_FAILED',
      'WORKSPACE_REQUIRED',
      'MODEL_UNAVAILABLE',
    ] as const) {
      const ctx = build({ provider: 'anthropic' });
      ctx.adapter.generateText.mockRejectedValueOnce(
        new ContentStudioAIProviderError(code, { httpStatus: 400 })
      );
      const err = await failure(() =>
        propose(ctx, {
          organizationId: ORG,
          userId: USER,
          request: request(),
        })
      );
      expect(body(err).code).toBe(`CS_AI_${code}`);
      expect(ctx.connections.setValidationResult).toHaveBeenCalledWith({
        organizationId: ORG,
        connectionId: CONNECTION,
        validatedAt: expect.any(Date),
        status: 'invalid',
        code,
      });
    }
    for (const code of [
      'RATE_LIMITED',
      'TIMEOUT',
      'PROVIDER_UNAVAILABLE',
      'REQUEST_REJECTED',
      'INVALID_RESPONSE',
    ] as const) {
      const ctx = build({ provider: 'anthropic' });
      ctx.adapter.generateText.mockRejectedValueOnce(
        new ContentStudioAIProviderError(code)
      );
      await failure(() =>
        propose(ctx, {
          organizationId: ORG,
          userId: USER,
          request: request(),
        })
      );
      expect(ctx.connections.setValidationResult).not.toHaveBeenCalled();
    }
  });

  it('SR2 answers the provider failure even when the connection cannot be marked', async () => {
    const ctx = build({ provider: 'anthropic' });
    ctx.connections.setValidationResult.mockRejectedValueOnce(
      new Error('db down')
    );
    ctx.adapter.generateText.mockRejectedValueOnce(
      new ContentStudioAIProviderError('QUOTA_EXCEEDED')
    );
    const err = await failure(() =>
      propose(ctx, {
        organizationId: ORG,
        userId: USER,
        request: request(),
      })
    );
    expect(body(err).code).toBe('CS_AI_QUOTA_EXCEEDED');
  });

  it('SR3 gives the AI the tagline the user typed, as company information', async () => {
    const ctx = build();
    await propose(ctx, {
      organizationId: ORG,
      userId: USER,
      request: request({
        tagline: '  Strategy, websites and automation  ',
        goal: 'More inbound leads',
        audience: 'Growing SMEs',
      }),
    });
    const [[sent]] = ctx.adapter.generateText.mock.calls;
    const company = JSON.parse(
      sent.prompt.slice(
        sent.prompt.indexOf('{', sent.prompt.indexOf('## Company information'))
      )
    );
    expect(company).toEqual({
      name: COMPANY,
      tagline: 'Strategy, websites and automation',
      website: 'https://example.test',
      description: 'We build websites for small businesses.',
      goal: 'More inbound leads',
      audience: 'Growing SMEs',
    });
    expect(sent.prompt).toContain('language with the tag nl.');
    expect(CONTENT_STUDIO_AI_SETUP_PROMPT_VERSION).toBe('cs-setup-v3');

    const without = build();
    await propose(without, {
      organizationId: ORG,
      userId: USER,
      request: request(),
    });
    expect(without.adapter.generateText.mock.calls[0][0].prompt).toContain(
      '"tagline": null'
    );
    const err = await failure(() =>
      propose(without, {
        organizationId: ORG,
        userId: USER,
        request: request({ tagline: 'x'.repeat(301) }),
      })
    );
    expect(body(err).code).toBe('CS_INVALID_REQUEST');
  });

  it('SR4 asks the provider again on every try, each a new operation', async () => {
    const ctx = build({ provider: 'anthropic' });
    ctx.adapter.generateText.mockRejectedValueOnce(
      new ContentStudioAIProviderError('PROVIDER_UNAVAILABLE')
    );
    await failure(() =>
      propose(ctx, {
        organizationId: ORG,
        userId: USER,
        request: request(),
      })
    );
    const second = await propose(ctx, {
      organizationId: ORG,
      userId: USER,
      request: request(),
    });
    expect(second.proposal.brand.tagline).toBe('Websites that work');
    expect(ctx.adapter.generateText).toHaveBeenCalledTimes(2);
    expect(ctx.operations.createRunningOperation).toHaveBeenCalledTimes(2);
    expect(ctx.operations.completeFailedWithUsage).toHaveBeenCalledTimes(1);
    expect(ctx.operations.completeSucceededWithUsage).toHaveBeenCalledTimes(1);
  });

  it('gives the provider longer than a writing call: a whole profile set is a long answer', async () => {
    const ctx = build();
    await propose(ctx, {
      organizationId: ORG,
      userId: USER,
      request: request(),
    });
    expect(ctx.adapter.generateText.mock.calls[0][0].timeoutMs).toBe(
      SETUP_TIMEOUT_MS
    );
    expect(SETUP_TIMEOUT_MS).toBeGreaterThan(30_000);
    expect(SETUP_TIMEOUT_MS).toBeLessThanOrEqual(AI_REQUEST_TIMEOUT_MAX_MS);
  });

  it('refuses an answer cut off at the output limit', async () => {
    const ctx = build();
    ctx.adapter.generateText.mockResolvedValueOnce({
      ...providerResult(JSON.stringify(validAnswer())),
      finishReason: 'length',
    });
    const err = await failure(() =>
      propose(ctx, {
        organizationId: ORG,
        userId: USER,
        request: request(),
      })
    );
    expect(body(err).code).toBe('CS_AI_INVALID_RESPONSE');
  });
});

describe('ContentStudioAIExecutionService.executeForOrganization', () => {
  const input = () => ({
    organizationId: ORG,
    userId: USER,
    connectionId: CONNECTION,
    kind: 'setup_proposal' as const,
    model: 'gpt-6.1-sol',
    promptVersion: 'cs-setup-v1',
    context: { v: 1 as const },
    request: {
      model: 'gpt-6.1-sol',
      system: 's',
      prompt: 'p',
      output: { type: 'text' as const },
      maxOutputTokens: 10,
    },
  });

  it.each([
    ['a package kind', { kind: 'generate_item' }],
    ['a design kind', { kind: 'design_restyle' }],
    [
      'a context that names a source',
      {
        context: {
          v: 1,
          sources: [
            {
              sourceId: CONNECTION,
              versionId: USER,
              versionNumber: 1,
              contentHash: 'a'.repeat(64),
            },
          ],
        },
      },
    ],
    ['a context that names an item', { context: { v: 1, itemId: 'item_1' } }],
    ['a package', { packageId: CONNECTION }],
    ['a draft version', { baseDraftVersion: 1 }],
    ['a design revision', { designRevisionId: CONNECTION }],
  ])('refuses %s before anything is recorded', async (_label, patch) => {
    const ctx = build();
    const execution = (
      ctx.service as unknown as {
        _contentStudioAIExecutionService: ContentStudioAIExecutionService;
      }
    )._contentStudioAIExecutionService;
    await expect(
      execution.executeForOrganization({ ...input(), ...patch } as never)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(ctx.operations.createRunningOperation).not.toHaveBeenCalled();
    expect(ctx.resolver.resolve).not.toHaveBeenCalled();
  });
});

// Activation flow 01: the real iPhone test lost two finished drafts. The
// server made both (the operations succeeded), but the answer lived only in
// the response of one long request, which Safari dropped when the browser
// was put away. The draft is now kept with its operation and read back
describe('ContentStudioAISetupService: a draft that outlives its request', () => {
  // a provider that answers only when the test says so
  const held = (ctx: Ctx) => {
    let answer!: (value: ReturnType<typeof providerResult>) => void;
    let refuse!: (err: unknown) => void;
    ctx.adapter.generateText.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          answer = resolve;
          refuse = reject;
        })
    );
    return {
      answer: () => answer(providerResult(JSON.stringify(validAnswer()))),
      refuse: (err: unknown) => refuse(err),
    };
  };
  const start = (ctx: Ctx) =>
    ctx.service.startSetup({
      organizationId: ORG,
      userId: USER,
      request: request(),
    });

  it('BG1/BG3 starting answers at once with the running operation', async () => {
    const ctx = build();
    const provider = held(ctx);
    const { operationId, done } = await start(ctx);
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.adapter.generateText).toHaveBeenCalledTimes(1);
    expect(await ctx.service.getSetupProposal(ORG, operationId)).toEqual({
      operationId,
      status: 'running',
    });
    provider.answer();
    await done;
  });

  it('BG2/BG4 the draft is made and kept when nobody waits for it, and read back later', async () => {
    const ctx = build();
    const provider = held(ctx);
    // the request that started it is gone: only its operation id is known
    const { operationId } = await start(ctx);
    provider.answer();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const state = await ctx.service.getSetupProposal(ORG, operationId);
    expect(state).toMatchObject({ operationId, status: 'succeeded' });
    expect(
      (state as { proposal: { brand: { tagline: string } } }).proposal.brand
        .tagline
    ).toBe('Websites that work');
    // read again, from anywhere: the same draft, no new provider call
    expect(await ctx.service.getSetupProposal(ORG, operationId)).toEqual(state);
    expect(ctx.adapter.generateText).toHaveBeenCalledTimes(1);
  });

  it('BG5 a failure reads back as the code the request would have answered, never a provider message', async () => {
    const ctx = build();
    const provider = held(ctx);
    const { operationId, done } = await start(ctx);
    provider.refuse(
      new ContentStudioAIProviderError('RATE_LIMITED', {
        httpStatus: 429,
      })
    );
    await done;
    expect(await ctx.service.getSetupProposal(ORG, operationId)).toEqual({
      operationId,
      status: 'failed',
      code: 'CS_AI_RATE_LIMITED',
    });
  });

  it('BG6 two drafts keep their own answers: an older one never becomes the newer one', async () => {
    const ctx = build();
    const first = held(ctx);
    const older = await start(ctx);
    const second = held(ctx);
    const newer = await start(ctx);
    second.refuse(new ContentStudioAIProviderError('TIMEOUT'));
    await newer.done;
    first.answer();
    await older.done;
    expect(
      (await ctx.service.getSetupProposal(ORG, newer.operationId)).status
    ).toBe('failed');
    expect(
      (await ctx.service.getSetupProposal(ORG, older.operationId)).status
    ).toBe('succeeded');
    // a completed operation is never completed again
    expect(
      await ctx.operations.completeSucceededWithUsage({
        organizationId: ORG,
        operationId: newer.operationId,
        result: validAnswer(),
      })
    ).toEqual({ completed: false });
  });

  it('BG7 an operation left running by a stopped server reads back as interrupted', async () => {
    const ctx = build();
    held(ctx);
    const { operationId } = await start(ctx);
    ctx.stored.get(operationId)!.startedAt = new Date(
      Date.now() - AI_OPERATION_INTERRUPTED_AFTER_MS - 1000
    );
    expect(await ctx.service.getSetupProposal(ORG, operationId)).toEqual({
      operationId,
      status: 'failed',
      code: 'CS_AI_OPERATION_INTERRUPTED',
    });
  });

  it('reads a setup draft of the organization only', async () => {
    const ctx = build();
    const { operationId, done } = await start(ctx);
    await done;
    for (const [org, id] of [
      [OTHER_ORG, operationId],
      [ORG, 'not-a-uuid'],
      [ORG, '55555555-5555-4555-8555-555555555555'],
    ]) {
      const err = await failure(() => ctx.service.getSetupProposal(org, id));
      expect(body(err).code).toBe('CS_NOT_FOUND');
    }
    ctx.stored.get(operationId)!.kind = 'generate_item';
    const err = await failure(() =>
      ctx.service.getSetupProposal(ORG, operationId)
    );
    expect(body(err).code).toBe('CS_NOT_FOUND');
  });
});
