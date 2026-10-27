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
  const operations = {
    createRunningOperation: jest.fn(async () => ({ id: 'op' })),
    completeSucceededWithUsage: jest.fn(async () => ({ completed: true })),
    completeFailedWithUsage: jest.fn(async () => ({ completed: true })),
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
    execution
  );
  return { service, connections, adapter, resolver, operations, packages };
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

describe('ContentStudioAISetupService.proposeSetup', () => {
  it('returns a validated draft and records one organization operation, with hashes only', async () => {
    const ctx = build();
    const result = await ctx.service.proposeSetup({
      organizationId: ORG,
      userId: USER,
      request: request(),
    });
    expect(result.proposal.writing.content.perspective).toBe('first_plural');
    expect(result.proposal.audiences[0].content.locale).toBe('nl');
    expect(result.ai).toEqual({
      provider: 'openai',
      model: 'gpt-6.1-sol',
      promptVersion: CONTENT_STUDIO_AI_SETUP_PROMPT_VERSION,
    });

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
    // nothing the user typed or the AI answered is stored, and no key
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
    expect(
      JSON.stringify(ctx.operations.completeSucceededWithUsage.mock.calls)
    ).not.toContain('Studio voice');
    expect(stored).not.toContain(KEY);
    expect(ctx.packages.getPackageForOrganization).not.toHaveBeenCalled();
  });

  it('asks a model with structured output for the JSON schema, others for text', async () => {
    const openai = build();
    await openai.service.proposeSetup({
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
    await anthropic.service.proposeSetup({
      organizationId: ORG,
      userId: USER,
      request: request(),
    });
    const [[text]] = anthropic.adapter.generateText.mock.calls;
    expect(text.output).toEqual({ type: 'text' });
    expect(text.model).toBe('claude-opus-5-5');
  });

  it("uses the connection's own model, never one from the request", async () => {
    const ctx = build({ defaultModel: 'gpt-6-luna' });
    await ctx.service.proposeSetup({
      organizationId: ORG,
      userId: USER,
      request: { ...request(), model: 'gpt-6.1-sol' } as never,
    });
    expect(ctx.adapter.generateText.mock.calls[0][0].model).toBe('gpt-6-luna');
  });

  it("refuses another organization's or a missing connection before anything is recorded", async () => {
    const ctx = build();
    const err = await failure(() =>
      ctx.service.proposeSetup({
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
      ctx.service.proposeSetup({
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
    await ctx.service.proposeSetup({
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
      ctx.service.proposeSetup({
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
      ctx.service.proposeSetup({
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
      ctx.service.proposeSetup({
        organizationId: ORG,
        userId: USER,
        request: request(),
      })
    );
    expect(body(err).code).toBe('CS_AI_WORKSPACE_REQUIRED');
    expect(warn).toHaveBeenCalledWith(
      'setup proposal failed: provider=anthropic model=claude-opus-5-5 code=WORKSPACE_REQUIRED httpStatus=400 providerRequestId=req_1'
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(COMPANY);
    warn.mockRestore();
  });

  it('gives the provider longer than a writing call: a whole profile set is a long answer', async () => {
    const ctx = build();
    await ctx.service.proposeSetup({
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
      ctx.service.proposeSetup({
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
