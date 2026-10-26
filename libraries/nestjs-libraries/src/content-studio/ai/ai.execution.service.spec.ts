import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import { randomUUID } from 'crypto';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioAIOperationRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-operation.repository';
import { ContentStudioAIProviderResolver } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.resolver';
import {
  ContentStudioAIExecutionInput,
  ContentStudioAIExecutionService,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.execution.service';
import {
  ContentStudioAIExecutionError,
  ContentStudioAIProviderError,
  ContentStudioAIResolutionError,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import {
  ContentStudioAIProviderErrorCode,
  ContentStudioAITextResult,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';
import {
  hashContentStudioAIRequest,
  hashContentStudioAIResult,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.hash';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import { ContentStudioSourceVersionRetentionPendingError } from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';

// No database and no provider: the package repository, the operation
// repository, the resolver and its adapter are mocks. Every argument handed
// to persistence is captured and searched for the texts of the request and
// the result, which must never be there
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, randomUUID: jest.fn() };
});
const uuid = jest.mocked(randomUUID);

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const PACKAGE = '55555555-5555-4555-8555-555555555555';
const OPERATION = '66666666-6666-4666-8666-666666666666';
const SYSTEM = 'SYSTEM_SECRET_MARKER_123 You write social posts.';
const PROMPT = 'PROMPT_SECRET_MARKER_456 Write about spring.';
const RESULT = 'RESULT_SECRET_MARKER_789 Spring is here.';
const KEY = 'sk-content-studio-test-secret-123';
const MARKERS =
  /SECRET_MARKER|sk-content-studio|social posts|about spring|Spring is here/;

const input = (
  overrides: Partial<ContentStudioAIExecutionInput> = {},
  request: Partial<ContentStudioAIExecutionInput['request']> = {}
): ContentStudioAIExecutionInput => ({
  organizationId: ORG,
  userId: USER,
  connectionId: CONNECTION,
  packageId: PACKAGE,
  kind: 'generate_item',
  model: 'gpt-6.1-sol',
  promptVersion: 'cs-item-v1',
  baseDraftVersion: 3,
  context: { v: 1, itemId: 'item-1' },
  ...overrides,
  request: {
    model: overrides.model ?? 'gpt-6.1-sol',
    system: SYSTEM,
    prompt: PROMPT,
    output: { type: 'text' },
    maxOutputTokens: 500,
    ...request,
  },
});

const providerResult = (
  overrides: Partial<ContentStudioAITextResult> = {}
): ContentStudioAITextResult => ({
  text: RESULT,
  finishReason: 'stop',
  usage: {
    inputTokens: 12,
    outputTokens: 30,
    cachedInputTokens: 4,
    reasoningTokens: 9,
    totalTokens: 42,
  },
  providerRequestId: 'req_ok_1',
  ...overrides,
});

const setup = (provider: 'openai' | 'openrouter' | 'anthropic' = 'openai') => {
  const contentPackage = {
    id: PACKAGE,
    draft: '{"secret":"PROMPT_SECRET_MARKER_456 draft text"}',
    draftVersion: 3,
    archivedAt: null as Date | null,
  };
  const packages = {
    getPackageForOrganization: jest.fn(
      async (organizationId: string, id: string) =>
        organizationId === ORG && id === PACKAGE ? contentPackage : null
    ),
  };
  const adapter = {
    provider,
    validateConnection: jest.fn(),
    generateText: jest.fn(async () => providerResult()),
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
    createRunningOperation: jest.fn(async () => ({ id: OPERATION })),
    completeSucceededWithUsage: jest.fn(async () => ({ completed: true })),
    completeFailedWithUsage: jest.fn(async () => ({ completed: true })),
    getOperationForOrganization: jest.fn(),
  };
  const service = new ContentStudioAIExecutionService(
    packages as unknown as ContentStudioRepository,
    resolver as unknown as ContentStudioAIProviderResolver,
    operations as unknown as ContentStudioAIOperationRepository
  );
  return { service, packages, resolver, adapter, operations, contentPackage };
};
type Context = ReturnType<typeof setup>;

// every argument given to the operation repository, BigInt included
const persisted = (operations: Context['operations']) =>
  inspect(
    Object.values(operations).map((fn) => fn.mock.calls),
    { depth: 20 }
  );
const writes = (operations: Context['operations']) =>
  [
    operations.createRunningOperation,
    operations.completeSucceededWithUsage,
    operations.completeFailedWithUsage,
  ].flatMap((fn) => fn.mock.calls);
const created = (operations: Context['operations']) =>
  (
    operations.createRunningOperation.mock.calls[0] as unknown as [
      Record<string, unknown>
    ]
  )[0];
const succeeded = (operations: Context['operations']) =>
  (
    operations.completeSucceededWithUsage.mock.calls[0] as unknown as [
      { usage: Record<string, unknown> } & Record<string, unknown>
    ]
  )[0];
const failed = (operations: Context['operations']) =>
  (
    operations.completeFailedWithUsage.mock.calls[0] as unknown as [
      { usage: Record<string, unknown> } & Record<string, unknown>
    ]
  )[0];

const failure = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: unknown) => e
  );
  expect(
    [String(err), JSON.stringify(err), inspect(err, { showHidden: true })].join(
      '\n'
    )
  ).not.toMatch(MARKERS);
  expect(err).not.toHaveProperty('cause');
  return err as Error & { code: string };
};

beforeEach(() => {
  uuid.mockImplementation(() => OPERATION);
});

describe('ContentStudioAIExecutionService: preflight', () => {
  it('E1 runs a valid request', async () => {
    const { service } = setup();
    await expect(service.execute(input())).resolves.toMatchObject({
      operationId: OPERATION,
    });
  });

  it.each([
    ['E2 a malformed organization', input({ organizationId: 'org-a' })],
    [
      'an upper case organization',
      input({ organizationId: 'AAAAAAAA-1111-4111-8111-111111111111' }),
    ],
    ['a malformed user', input({ userId: 'user-1' })],
    ['E3 a malformed connection', input({ connectionId: 'connection-1' })],
    ['E4 a malformed package', input({ packageId: '' })],
    [
      'E5 an unknown kind',
      input({
        kind: 'connection_test' as ContentStudioAIExecutionInput['kind'],
      }),
    ],
    ['E6 draft version 0', input({ baseDraftVersion: 0 })],
    ['E6 a fractional draft version', input({ baseDraftVersion: 1.5 })],
    ['E6 a draft version past int4', input({ baseDraftVersion: 2 ** 31 })],
    ['E7 an empty prompt version', input({ promptVersion: '' })],
    ['E7 a prompt version with spaces', input({ promptVersion: 'cs item' })],
    ['E7 a long prompt version', input({ promptVersion: 'v'.repeat(65) })],
    [
      'E8 a context with text',
      input({
        context: {
          v: 1,
          ...({ instruction: PROMPT } as object),
        } as ContentStudioAIExecutionInput['context'],
      }),
    ],
    [
      'E8 an oversized context',
      input({
        context: {
          v: 1,
          ...({ padding: 'x'.repeat(9000) } as object),
        } as ContentStudioAIExecutionInput['context'],
      }),
    ],
    [
      'E8 a context of another version',
      input({
        context: {
          v: 2,
        } as unknown as ContentStudioAIExecutionInput['context'],
      }),
    ],
    ['E14 a request for another model', input({}, { model: 'gpt-6-luna' })],
    ['an empty model', input({ model: '' })],
    ['no output tokens', input({}, { maxOutputTokens: 0 })],
    ['a NaN temperature', input({}, { temperature: NaN })],
    ['an infinite temperature', input({}, { temperature: Infinity })],
    [
      'a JSON schema it cannot hash',
      input(
        {},
        {
          output: {
            type: 'json',
            schemaName: 'post',
            schema: { minimum: 0.5 },
          },
        }
      ),
    ],
    [
      'a prompt that is not text',
      input({}, { prompt: 7 as unknown as string }),
    ],
    ['no request', { ...input(), request: undefined } as never],
  ])(
    'refuses %s before any lookup, operation or provider',
    async (_name, value) => {
      const { service, packages, resolver, adapter, operations } = setup();
      const err = await failure(service.execute(value));
      expect(err).toBeInstanceOf(ContentStudioAIExecutionError);
      expect(err.code).toBe('INVALID_INPUT');
      expect(adapter.generateText).not.toHaveBeenCalled();
      expect(writes(operations)).toEqual([]);
      // the JSON schema is the only check that needs the resolved provider
      if (!/JSON schema/.test(_name)) {
        expect(packages.getPackageForOrganization).not.toHaveBeenCalled();
        expect(resolver.resolve).not.toHaveBeenCalled();
      }
    }
  );

  it('E9/E54/E58 answers PACKAGE_NOT_FOUND for a missing or foreign package, with no operation', async () => {
    const { service, packages, resolver, adapter, operations } = setup();
    for (const value of [
      input({ packageId: '77777777-7777-4777-8777-777777777777' }),
      input({ organizationId: OTHER_ORG }),
    ]) {
      const err = await failure(service.execute(value));
      expect(err.code).toBe('PACKAGE_NOT_FOUND');
    }
    expect(packages.getPackageForOrganization.mock.calls).toEqual([
      [ORG, '77777777-7777-4777-8777-777777777777'],
      [OTHER_ORG, PACKAGE],
    ]);
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(adapter.generateText).not.toHaveBeenCalled();
    expect(writes(operations)).toEqual([]);
  });

  it('E10 answers PACKAGE_ARCHIVED for an archived package', async () => {
    const { service, contentPackage, adapter, operations } = setup();
    contentPackage.archivedAt = new Date();
    expect((await failure(service.execute(input()))).code).toBe(
      'PACKAGE_ARCHIVED'
    );
    expect(adapter.generateText).not.toHaveBeenCalled();
    expect(writes(operations)).toEqual([]);
  });

  it('E11 answers DRAFT_VERSION_CONFLICT for a stale draft version, before the connection', async () => {
    const { service, resolver, adapter, operations } = setup();
    for (const baseDraftVersion of [2, 4]) {
      expect(
        (await failure(service.execute(input({ baseDraftVersion })))).code
      ).toBe('DRAFT_VERSION_CONFLICT');
    }
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(adapter.generateText).not.toHaveBeenCalled();
    expect(writes(operations)).toEqual([]);
  });

  it.each([
    ['NOT_FOUND'],
    ['DISABLED'],
    ['CREDENTIAL_INVALID'],
    ['SECRET_STORE_UNAVAILABLE'],
    ['PROVIDER_UNSUPPORTED'],
  ] as const)(
    'E12/E59 passes a resolver %s on and creates nothing',
    async (code) => {
      const { service, resolver, adapter, operations } = setup();
      resolver.resolve.mockRejectedValueOnce(
        new ContentStudioAIResolutionError(code)
      );
      const err = await failure(service.execute(input()));
      expect(err).toBeInstanceOf(ContentStudioAIResolutionError);
      expect(err.code).toBe(code);
      expect(adapter.generateText).not.toHaveBeenCalled();
      expect(writes(operations)).toEqual([]);
    }
  );

  it('E59 creates nothing for a connection of another organization', async () => {
    const { service, adapter, operations } = setup();
    const err = await failure(
      service.execute(
        input({ connectionId: '88888888-8888-4888-8888-888888888888' })
      )
    );
    expect(err.code).toBe('NOT_FOUND');
    expect(adapter.generateText).not.toHaveBeenCalled();
    expect(writes(operations)).toEqual([]);
  });

  it.each([
    ['openai', 'claude-opus-5-5'],
    ['openai', 'openai/gpt-6.1-sol'],
    ['openrouter', 'gpt-6.1-sol'],
    ['anthropic', 'gpt-6.1-sol'],
    ['anthropic', 'claude-fable-5-1'],
  ] as const)(
    'E13/E15 refuses %s model %s with no operation, call or fallback',
    async (provider, model) => {
      const { service, adapter, operations } = setup(provider);
      const err = await failure(service.execute(input({ model })));
      expect(err.code).toBe('MODEL_UNSUPPORTED');
      expect(adapter.generateText).not.toHaveBeenCalled();
      expect(writes(operations)).toEqual([]);
    }
  );

  it('checks the package, then the connection, then the model, then creates the operation', async () => {
    const { service, packages, resolver, adapter, operations } = setup();
    await service.execute(input());
    const order = [
      packages.getPackageForOrganization,
      resolver.resolve,
      operations.createRunningOperation,
      adapter.generateText,
      operations.completeSucceededWithUsage,
    ].map((fn) => fn.mock.invocationCallOrder[0]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('ContentStudioAIExecutionService: success', () => {
  it('E16-E21/E55/E56 records a running operation of hashes and ids, then calls the provider once', async () => {
    const { service, resolver, adapter, operations } = setup();
    await service.execute(input());

    expect(resolver.resolve).toHaveBeenCalledWith({
      organizationId: ORG,
      connectionId: CONNECTION,
    });
    expect(created(operations)).toEqual({
      id: OPERATION,
      organizationId: ORG,
      userId: USER,
      connectionId: CONNECTION,
      packageId: PACKAGE,
      kind: 'generate_item',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      promptVersion: 'cs-item-v1',
      baseDraftVersion: 3,
      context: { v: 1, itemId: 'item-1' },
      requestHash: hashContentStudioAIRequest({
        kind: 'generate_item',
        provider: 'openai',
        model: 'gpt-6.1-sol',
        promptVersion: 'cs-item-v1',
        packageId: PACKAGE,
        baseDraftVersion: 3,
        context: { v: 1, itemId: 'item-1' },
        request: input().request,
      }),
      startedAt: expect.any(Date),
    });
    expect(created(operations).requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      operations.createRunningOperation.mock.invocationCallOrder[0]
    ).toBeLessThan(adapter.generateText.mock.invocationCallOrder[0]);
    expect(adapter.generateText).toHaveBeenCalledTimes(1);
    expect(adapter.generateText).toHaveBeenCalledWith(input().request);
  });

  it('E22-E39/E57 returns the text in memory and records hashes and provider usage only', async () => {
    const { service, operations } = setup();
    const value = await service.execute(input());

    expect(value).toEqual({ operationId: OPERATION, result: providerResult() });
    expect(value.result.text).toBe(RESULT);
    expect(succeeded(operations)).toEqual({
      organizationId: ORG,
      operationId: OPERATION,
      completedAt: expect.any(Date),
      resultHash: hashContentStudioAIResult({
        text: RESULT,
        finishReason: 'stop',
        providerRequestId: 'req_ok_1',
      }),
      usage: {
        attempt: 1,
        provider: 'openai',
        model: 'gpt-6.1-sol',
        outcome: 'succeeded',
        usageSource: 'provider',
        inputTokens: 12,
        outputTokens: 30,
        cachedInputTokens: 4,
        reasoningTokens: 9,
        totalTokens: 42,
        providerCostMicros: null,
        costCurrency: null,
        providerRequestId: 'req_ok_1',
      },
    });
    expect(operations.completeFailedWithUsage).not.toHaveBeenCalled();
  });

  it('E18/E24/E47 never hands a prompt, system prompt, draft or result text to persistence', async () => {
    const { service, operations } = setup();
    const value = await service.execute(input());
    expect(inspect(value, { depth: 10 })).toContain('RESULT_SECRET_MARKER');
    expect(persisted(operations)).not.toMatch(MARKERS);
    expect(persisted(operations)).not.toContain('draft text');
  });

  it('E34 leaves totalTokens empty when the provider did not report it', async () => {
    const { service, adapter, operations } = setup('anthropic');
    adapter.generateText.mockResolvedValueOnce(
      providerResult({
        usage: { inputTokens: 12, outputTokens: 30, cachedInputTokens: 4 },
      })
    );
    await service.execute(input({ model: 'claude-opus-5-5' }));
    expect(succeeded(operations).usage).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      inputTokens: 12,
      outputTokens: 30,
      totalTokens: null,
      reasoningTokens: null,
    });
  });

  it('E40-E45 succeeds without provider usage, with a none usage row', async () => {
    const { service, adapter, operations } = setup();
    adapter.generateText.mockResolvedValueOnce(
      providerResult({ usage: null, providerRequestId: undefined })
    );
    await service.execute(input());
    expect(succeeded(operations)).toMatchObject({
      resultHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      usage: {
        attempt: 1,
        outcome: 'succeeded',
        usageSource: 'none',
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        providerCostMicros: null,
        costCurrency: null,
        providerRequestId: null,
      },
    });
  });

  it('E72 generates the operation id on the server and returns it', async () => {
    const { service, operations } = setup();
    const value = await service.execute({
      ...input(),
      ...({ id: 'caller-id', operationId: 'caller-id' } as object),
    });
    expect(uuid).toHaveBeenCalled();
    expect(value.operationId).toBe(OPERATION);
    expect(created(operations).id).toBe(OPERATION);
  });
});

describe('ContentStudioAIExecutionService: provider failures', () => {
  const CODES: ContentStudioAIProviderErrorCode[] = [
    'AUTH_FAILED',
    'RATE_LIMITED',
    'QUOTA_EXCEEDED',
    'TIMEOUT',
    'MODEL_UNAVAILABLE',
    'CONTENT_REJECTED',
    'REQUEST_REJECTED',
    'INVALID_RESPONSE',
    'PROVIDER_UNAVAILABLE',
  ];

  it.each(CODES.map((code) => [code]))(
    'E46 records %s as a failed operation with a failed usage row and throws it',
    async (code) => {
      const { service, adapter, operations } = setup();
      const providerError = new ContentStudioAIProviderError(code, {
        httpStatus: 401,
        providerRequestId: 'req_err_1',
      });
      adapter.generateText.mockRejectedValueOnce(providerError);

      const err = await failure(service.execute(input()));
      expect(err).toBe(providerError);
      expect(adapter.generateText).toHaveBeenCalledTimes(1);
      expect(operations.createRunningOperation).toHaveBeenCalledTimes(1);
      expect(operations.completeSucceededWithUsage).not.toHaveBeenCalled();
      expect(failed(operations)).toEqual({
        organizationId: ORG,
        operationId: OPERATION,
        completedAt: expect.any(Date),
        errorCode: code,
        usage: {
          attempt: 1,
          provider: 'openai',
          model: 'gpt-6.1-sol',
          outcome: 'failed',
          usageSource: 'none',
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          reasoningTokens: null,
          totalTokens: null,
          providerCostMicros: null,
          costCurrency: null,
          providerRequestId: 'req_err_1',
        },
      });
      expect(persisted(operations)).not.toMatch(MARKERS);
    }
  );

  it('E49/E48 records an unexpected error as PROVIDER_UNAVAILABLE without its message', async () => {
    const { service, adapter, operations } = setup();
    const raw = new Error(`provider said ${KEY} ${PROMPT}`);
    (raw as Error & { cause?: unknown }).cause = new Error(KEY);
    adapter.generateText.mockRejectedValueOnce(raw);

    const err = await failure(service.execute(input()));
    expect(err).toBeInstanceOf(ContentStudioAIProviderError);
    expect(err.code).toBe('PROVIDER_UNAVAILABLE');
    expect(err).not.toBe(raw);
    expect(adapter.generateText).toHaveBeenCalledTimes(1);
    expect(failed(operations)).toMatchObject({
      errorCode: 'PROVIDER_UNAVAILABLE',
      usage: {
        outcome: 'failed',
        usageSource: 'none',
        providerRequestId: null,
      },
    });
    expect(persisted(operations)).not.toMatch(MARKERS);
  });

  it.each([
    ['no text', { text: undefined }],
    ['an unknown finish reason', { finishReason: 'tool_calls' }],
  ])('records an answer with %s as INVALID_RESPONSE', async (_n, overrides) => {
    const { service, adapter, operations } = setup();
    adapter.generateText.mockResolvedValueOnce(
      providerResult(overrides as Partial<ContentStudioAITextResult>)
    );
    const err = await failure(service.execute(input()));
    expect(err.code).toBe('INVALID_RESPONSE');
    expect(failed(operations).errorCode).toBe('INVALID_RESPONSE');
  });

  it('drops an unsafe request id of a provider error', async () => {
    const { service, adapter, operations } = setup();
    const providerError = new ContentStudioAIProviderError('TIMEOUT');
    Object.defineProperty(providerError, 'providerRequestId', {
      value: `req ${KEY}`,
    });
    adapter.generateText.mockRejectedValueOnce(providerError);
    // the injected id is on the thrown error only; persistence never sees it
    await expect(service.execute(input())).rejects.toBe(providerError);
    expect(failed(operations).usage.providerRequestId).toBeNull();
    expect(persisted(operations)).not.toMatch(MARKERS);
  });
});

describe('ContentStudioAIExecutionService: result validation', () => {
  it('EV1 without a validator succeeds exactly as before', async () => {
    const { service, operations } = setup();
    await expect(service.execute(input(), {})).resolves.toEqual({
      operationId: OPERATION,
      result: providerResult(),
    });
    expect(operations.completeSucceededWithUsage).toHaveBeenCalledTimes(1);
    expect(operations.completeFailedWithUsage).not.toHaveBeenCalled();
  });

  it('EV2-EV4 checks the answer once, after the provider and before the success is recorded', async () => {
    const { service, adapter, operations } = setup();
    const validateResult = jest.fn();
    const value = await service.execute(input(), { validateResult });
    expect(validateResult).toHaveBeenCalledTimes(1);
    expect(validateResult).toHaveBeenCalledWith(providerResult());
    const order = [
      operations.createRunningOperation,
      adapter.generateText,
      validateResult,
      operations.completeSucceededWithUsage,
    ].map((fn) => fn.mock.invocationCallOrder[0]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(value.operationId).toBe(OPERATION);
    expect(succeeded(operations).usage.outcome).toBe('succeeded');
  });

  it('EV5 records a refused answer as a failed INVALID_RESPONSE attempt with its usage, asking the provider once', async () => {
    const { service, adapter, operations } = setup();
    const refusal = new ContentStudioAIProviderError('INVALID_RESPONSE');
    const err = await failure(
      service.execute(input(), {
        validateResult: () => {
          throw refusal;
        },
      })
    );
    expect(err).toBe(refusal);
    expect(adapter.generateText).toHaveBeenCalledTimes(1);
    expect(operations.completeSucceededWithUsage).not.toHaveBeenCalled();
    expect(failed(operations)).toEqual({
      organizationId: ORG,
      operationId: OPERATION,
      completedAt: expect.any(Date),
      errorCode: 'INVALID_RESPONSE',
      usage: {
        attempt: 1,
        provider: 'openai',
        model: 'gpt-6.1-sol',
        outcome: 'failed',
        usageSource: 'provider',
        inputTokens: 12,
        outputTokens: 30,
        cachedInputTokens: 4,
        reasoningTokens: 9,
        totalTokens: 42,
        providerCostMicros: null,
        costCurrency: null,
        providerRequestId: 'req_ok_1',
      },
    });
    expect(persisted(operations)).not.toMatch(MARKERS);
  });

  it('keeps another normalized code of the validator, such as CONTENT_REJECTED', async () => {
    const { service, operations } = setup();
    const err = await failure(
      service.execute(input(), {
        validateResult: () => {
          throw new ContentStudioAIProviderError('CONTENT_REJECTED');
        },
      })
    );
    expect(err.code).toBe('CONTENT_REJECTED');
    expect(failed(operations).errorCode).toBe('CONTENT_REJECTED');
  });

  it('EV6 turns any other validator error into INVALID_RESPONSE without its message', async () => {
    const { service, adapter, operations } = setup();
    const raw = new Error(`could not parse ${RESULT} ${KEY}`);
    const err = await failure(
      service.execute(input(), {
        validateResult: () => {
          throw raw;
        },
      })
    );
    expect(err).toBeInstanceOf(ContentStudioAIProviderError);
    expect(err.code).toBe('INVALID_RESPONSE');
    expect(err).not.toBe(raw);
    expect(adapter.generateText).toHaveBeenCalledTimes(1);
    expect(failed(operations).errorCode).toBe('INVALID_RESPONSE');
    expect(persisted(operations)).not.toMatch(MARKERS);
  });

  it('EV7 never runs the validator when the provider fails', async () => {
    const { service, adapter, operations } = setup();
    adapter.generateText.mockRejectedValueOnce(
      new ContentStudioAIProviderError('TIMEOUT')
    );
    const validateResult = jest.fn();
    expect(
      (await failure(service.execute(input(), { validateResult }))).code
    ).toBe('TIMEOUT');
    expect(validateResult).not.toHaveBeenCalled();
    expect(failed(operations).errorCode).toBe('TIMEOUT');
  });

  it('never runs the validator before a valid answer shape', async () => {
    const { service, adapter } = setup();
    adapter.generateText.mockResolvedValueOnce(
      providerResult({ text: undefined as unknown as string })
    );
    const validateResult = jest.fn();
    expect(
      (await failure(service.execute(input(), { validateResult }))).code
    ).toBe('INVALID_RESPONSE');
    expect(validateResult).not.toHaveBeenCalled();
  });

  it.each([
    ['success', () => undefined, 'completeSucceededWithUsage'],
    [
      'refusal',
      () => {
        throw new ContentStudioAIProviderError('INVALID_RESPONSE');
      },
      'completeFailedWithUsage',
    ],
  ] as const)(
    'EV8 never asks the provider again when the %s cannot be recorded',
    async (_name, validateResult, completion) => {
      const { service, adapter, operations } = setup();
      operations[completion].mockRejectedValueOnce(
        new Error(`deadlock ${KEY}`)
      );
      const err = await failure(service.execute(input(), { validateResult }));
      expect(err.code).toBe('PERSISTENCE_FAILED');
      expect(adapter.generateText).toHaveBeenCalledTimes(1);
      expect(operations[completion]).toHaveBeenCalledTimes(1);
    }
  );
});

describe('ContentStudioAIExecutionService: persistence failures', () => {
  it('E50 never calls the provider when the operation cannot be created', async () => {
    const { service, adapter, operations } = setup();
    operations.createRunningOperation.mockRejectedValueOnce(
      new Error(`P2003 ${KEY}`)
    );
    const err = await failure(service.execute(input()));
    expect(err).toBeInstanceOf(ContentStudioAIExecutionError);
    expect(err.code).toBe('PERSISTENCE_FAILED');
    expect(adapter.generateText).not.toHaveBeenCalled();
    expect(operations.completeSucceededWithUsage).not.toHaveBeenCalled();
  });

  it('Q30 P8-R1Q a held source version: SOURCE_VERSION_RETENTION_PENDING, no operation and the provider never asked', async () => {
    const { service, adapter, operations } = setup();
    operations.createRunningOperation.mockRejectedValueOnce(
      new ContentStudioSourceVersionRetentionPendingError()
    );
    const err = await failure(service.execute(input()));
    expect(err).toBeInstanceOf(ContentStudioAIExecutionError);
    expect(err.code).toBe('SOURCE_VERSION_RETENTION_PENDING');
    expect(err.message).toBe(
      'A selected source version is temporarily unavailable for new references'
    );
    expect(adapter.generateText).not.toHaveBeenCalled();
    expect(operations.completeSucceededWithUsage).not.toHaveBeenCalled();
    expect(operations.completeFailedWithUsage).not.toHaveBeenCalled();
  });

  it.each([
    ['throws', () => Promise.reject(new Error(`deadlock ${KEY}`))],
    [
      'finds the operation completed',
      () => Promise.resolve({ completed: false }),
    ],
  ])(
    'E51/E53/E24 asks the provider once when the success completion %s',
    async (_name, completion) => {
      const { service, adapter, operations } = setup();
      operations.completeSucceededWithUsage.mockImplementationOnce(completion);
      const err = await failure(service.execute(input()));
      expect(err.code).toBe('PERSISTENCE_FAILED');
      expect(adapter.generateText).toHaveBeenCalledTimes(1);
      expect(operations.completeSucceededWithUsage).toHaveBeenCalledTimes(1);
      expect(operations.completeFailedWithUsage).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['throws', () => Promise.reject(new Error(`deadlock ${KEY}`))],
    [
      'finds the operation completed',
      () => Promise.resolve({ completed: false }),
    ],
  ])(
    'E52 asks the provider once when the failure completion %s',
    async (_name, completion) => {
      const { service, adapter, operations } = setup();
      adapter.generateText.mockRejectedValueOnce(
        new ContentStudioAIProviderError('RATE_LIMITED')
      );
      operations.completeFailedWithUsage.mockImplementationOnce(completion);
      const err = await failure(service.execute(input()));
      expect(err.code).toBe('PERSISTENCE_FAILED');
      expect(adapter.generateText).toHaveBeenCalledTimes(1);
      expect(operations.completeFailedWithUsage).toHaveBeenCalledTimes(1);
    }
  );
});

describe('ContentStudioAIExecutionService: usage sanitization', () => {
  const usageOf = async (usage: unknown) => {
    const { service, adapter, operations } = setup();
    adapter.generateText.mockResolvedValueOnce(
      providerResult({ usage: usage as ContentStudioAITextResult['usage'] })
    );
    await service.execute(input());
    return succeeded(operations).usage;
  };

  it.each([
    ['U1 zero', 0, 0],
    ['U2 a positive count', 123, 123],
    ['the int4 maximum', 2_147_483_647, 2_147_483_647],
    ['U3 a negative count', -1, null],
    ['U4 a fraction', 1.5, null],
    ['U5 NaN', NaN, null],
    ['U6 Infinity', Infinity, null],
    ['U7 more than int4', 2_147_483_648, null],
    ['U7 more than a safe integer', Number.MAX_SAFE_INTEGER + 2, null],
    ['U8 a string', '12', null],
    ['a bigint', BigInt(12), null],
  ])('%s is stored as %p', async (_name, value, stored) => {
    const usage = await usageOf({
      inputTokens: value,
      outputTokens: value,
      cachedInputTokens: value,
      reasoningTokens: value,
      totalTokens: value,
    });
    expect(usage).toMatchObject({
      usageSource: 'provider',
      inputTokens: stored,
      outputTokens: stored,
      cachedInputTokens: stored,
      reasoningTokens: stored,
      totalTokens: stored,
    });
  });

  it('U9 never adds input and output up', async () => {
    expect(
      (await usageOf({ inputTokens: 10, outputTokens: 5 })).totalTokens
    ).toBeNull();
  });

  it('U10/U11 drops a malformed cached or reasoning count and still succeeds', async () => {
    expect(
      await usageOf({
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: -3,
        reasoningTokens: 'many',
      })
    ).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: null,
      reasoningTokens: null,
    });
  });

  it.each([
    [
      'U12 a safe request id',
      'req_011CSHoEeqs5C35K2UUqR7Fy',
      'req_011CSHoEeqs5C35K2UUqR7Fy',
    ],
    ['U13 a request id of 201 characters', 'r'.repeat(201), null],
    ['U13 a request id with a space', 'req 1', null],
    ['U13 a request id with a newline', 'req\n1', null],
  ])('%s', async (_name, providerRequestId, stored) => {
    const { service, adapter, operations } = setup();
    adapter.generateText.mockResolvedValueOnce(
      providerResult({ providerRequestId })
    );
    await service.execute(input());
    expect(succeeded(operations).usage.providerRequestId).toBe(stored);
  });

  it.each([
    ['U14 a cost with its currency', BigInt(1500), 'USD', BigInt(1500), 'USD'],
    ['U14 a zero cost', BigInt(0), 'EUR', BigInt(0), 'EUR'],
    ['U15 a negative cost', BigInt(-1), 'USD', null, null],
    ['U16 a cost without currency', BigInt(1500), undefined, null, null],
    ['U17 a currency without cost', undefined, 'USD', null, null],
    ['U18 a lower case currency', BigInt(1500), 'usd', null, null],
    ['U18 a long currency', BigInt(1500), 'USDT', null, null],
    ['U14 a number cost', 1500, 'USD', null, null],
    [
      'U14 credits that are not a currency',
      BigInt(1500),
      'CREDITS',
      null,
      null,
    ],
  ])('%s', async (_name, costMicros, currency, storedCost, storedCurrency) => {
    const usage = await usageOf({ inputTokens: 1, costMicros, currency });
    expect(usage.providerCostMicros).toBe(storedCost);
    expect(usage.costCurrency).toBe(storedCurrency);
  });

  it('E35 never invents a cost', async () => {
    expect(
      await usageOf({ inputTokens: 1000, outputTokens: 1000 })
    ).toMatchObject({ providerCostMicros: null, costCurrency: null });
  });
});

describe('ContentStudioAIExecutionService source', () => {
  // code only: the comments explain these rules and may name them
  const text = fs
    .readFileSync(path.join(__dirname, 'ai.execution.service.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('never sees a credential or a provider SDK', () => {
    expect(text).not.toMatch(
      /apiKey|sealedCredential|openContentStudioAICredential|getSealedCredentialForResolver|from 'openai'|@anthropic-ai|@ai-sdk|providers\//
    );
  });

  it('has no logging, environment, network, retry loop or commercial credit', () => {
    expect(text).not.toMatch(
      /console\.|Logger|process\.env|\bfetch\(|\bwhile\b|\bfor\s*\(|credit|wallet|balance|reserve|capture|release|billing|subscription|stripe/i
    );
    expect(text.match(/\.generateText\(/g)).toHaveLength(1);
    expect(text).not.toMatch(/\.message\b|JSON\.stringify|validateConnection/);
  });

  it('is not used by the connection test', () => {
    const connection = fs.readFileSync(
      path.join(
        __dirname,
        '../../database/prisma/content-studio/content-studio.ai-connection.service.ts'
      ),
      'utf8'
    );
    expect(connection).not.toMatch(
      /ContentStudioAIExecutionService|ContentStudioAIOperationRepository|generateText/
    );
  });
});

// P6-02: the same single attempt and records for one saved design revision
describe('ContentStudioAIExecutionService: design operations', () => {
  const REVISION = '77777777-7777-4777-8777-777777777777';
  const DESIGN = '88888888-8888-4888-8888-888888888888';
  const designContext = (revisionId = REVISION) => ({
    v: 1 as const,
    design: {
      designId: DESIGN,
      revisionId,
      revisionNumber: 4,
      contentHash: 'c'.repeat(64),
    },
  });
  const designInput = (overrides: Record<string, unknown> = {}) => ({
    organizationId: ORG,
    userId: USER,
    connectionId: CONNECTION,
    designRevisionId: REVISION,
    kind: 'design_restyle' as const,
    model: 'gpt-6.1-sol',
    promptVersion: 'cs-design-restyle-v1',
    context: designContext(),
    request: {
      model: 'gpt-6.1-sol',
      system: SYSTEM,
      prompt: PROMPT,
      output: { type: 'text' as const },
      maxOutputTokens: 500,
    },
    ...overrides,
  });

  beforeEach(() => {
    uuid.mockReset();
    uuid.mockReturnValue(OPERATION as ReturnType<typeof randomUUID>);
  });

  it('P602 EX1 records a design operation on its revision, without a package, and never reads a package', async () => {
    const ctx = setup();
    await expect(ctx.service.executeForDesign(designInput())).resolves.toEqual({
      operationId: OPERATION,
      result: providerResult(),
    });
    expect(ctx.packages.getPackageForOrganization).not.toHaveBeenCalled();
    const [[created]] = ctx.operations.createRunningOperation.mock
      .calls as unknown as [[Record<string, unknown>]];
    expect(created).toEqual({
      id: OPERATION,
      organizationId: ORG,
      userId: USER,
      connectionId: CONNECTION,
      packageId: null,
      designRevisionId: REVISION,
      baseDraftVersion: null,
      kind: 'design_restyle',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      promptVersion: 'cs-design-restyle-v1',
      context: designContext(),
      requestHash: hashContentStudioAIRequest({
        kind: 'design_restyle',
        provider: 'openai',
        model: 'gpt-6.1-sol',
        promptVersion: 'cs-design-restyle-v1',
        designRevisionId: REVISION,
        context: designContext(),
        request: designInput().request,
      }),
      startedAt: expect.any(Date),
    });
    expect(ctx.operations.completeSucceededWithUsage).toHaveBeenCalledTimes(1);
    expect(persisted(ctx.operations)).not.toMatch(MARKERS);
  });

  it('P602 EX2 refuses a package kind, a context of another revision, an item or source, or package fields, before anything', async () => {
    const ctx = setup();
    for (const overrides of [
      { kind: 'rewrite_item' },
      { kind: 'design_delete' },
      { context: designContext('99999999-9999-4999-8999-999999999999') },
      { context: { v: 1 } },
      { context: { ...designContext(), itemId: 'main' } },
      { designRevisionId: 'latest' },
      { packageId: PACKAGE },
      { baseDraftVersion: 3 },
      {
        model: 'gpt-6.1-sol',
        request: { ...designInput().request, model: 'other' },
      },
    ]) {
      await expect(
        ctx.service.executeForDesign(designInput(overrides) as never)
      ).rejects.toEqual(new ContentStudioAIExecutionError('INVALID_INPUT'));
    }
    expect(ctx.resolver.resolve).not.toHaveBeenCalled();
    expect(ctx.operations.createRunningOperation).not.toHaveBeenCalled();
  });

  it('P602 EX3 a package operation can never carry a design kind or a design context', async () => {
    const ctx = setup();
    for (const overrides of [
      { kind: 'design_restyle' as never },
      { context: { v: 1 as const, ...designContext() } },
    ]) {
      await expect(ctx.service.execute(input(overrides))).rejects.toEqual(
        new ContentStudioAIExecutionError('INVALID_INPUT')
      );
    }
    expect(ctx.operations.createRunningOperation).not.toHaveBeenCalled();
  });

  it('P602 EX4 a package request hash is exactly what it was before design operations', () => {
    const base = {
      kind: 'generate_item',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      promptVersion: 'cs-item-v1',
      context: { v: 1 as const, itemId: 'item-1' },
      request: input().request,
    };
    // the descriptor as it was written before P6-02, field for field
    const textHash = (text: string) => sha256Hex(canonicalJson(text));
    const before = sha256Hex(
      canonicalJson({
        v: 1,
        kind: base.kind,
        provider: base.provider,
        model: base.model,
        promptVersion: base.promptVersion,
        packageId: PACKAGE,
        baseDraftVersion: 3,
        context: base.context,
        request: {
          systemHash: textHash(SYSTEM),
          promptHash: textHash(PROMPT),
          output: { type: 'text' },
          maxOutputTokens: 500,
          temperature: null,
        },
      })
    );
    expect(
      hashContentStudioAIRequest({
        ...base,
        packageId: PACKAGE,
        baseDraftVersion: 3,
      })
    ).toBe(before);
    expect(
      hashContentStudioAIRequest({ ...base, designRevisionId: REVISION })
    ).not.toBe(before);
  });
});
