import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  ClientOptions,
} from 'openai';
import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import {
  ContentStudioOpenAISdk,
  createOpenAIProviderAdapter,
  toContentStudioAIFinishReason,
  toContentStudioAIProviderError,
  toContentStudioAIUsage,
} from '@gitroom/nestjs-libraries/content-studio/ai/providers/openai.provider';
import { ContentStudioAIProviderError } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import { ContentStudioAITextRequest } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';

// No network: the SDK class is replaced, either by a fake client or by the
// real SDK with a fetch that answers in memory. A global fetch that is
// reached fails the test
const MARKER = 'sk-content-studio-test-secret-123';
const CREDENTIAL = { apiKey: MARKER };

const rendered = (value: unknown) =>
  [
    String(value),
    JSON.stringify(value),
    inspect(value, { depth: 10, showHidden: true }),
    (value as Error)?.stack,
  ].join('\n');

const apiError = (status: number, headers: Record<string, string> = {}) =>
  APIError.generate(
    status,
    { error: { message: `Incorrect API key provided: ${MARKER}` } },
    `Incorrect API key provided: ${MARKER}`,
    new Headers({ 'x-request-id': 'req_err_1', ...headers })
  );

const completion = (overrides: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'gpt-6.1-sol',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'Hello there', refusal: null },
    },
  ],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 30,
    total_tokens: 42,
    prompt_tokens_details: { cached_tokens: 4 },
    completion_tokens_details: { reasoning_tokens: 9 },
  },
  ...overrides,
});

// A fake SDK class: records the options of every client and gives each one
// the methods below
const fakeSdk = (client: {
  list?: jest.Mock;
  create?: jest.Mock;
  get?: jest.Mock;
}) => {
  const constructed: ClientOptions[] = [];
  const list = client.list || jest.fn(async () => ({ data: [] }));
  const create =
    client.create ||
    jest.fn(() => ({
      withResponse: async () => ({
        data: completion(),
        response: {},
        request_id: 'req_ok_1',
      }),
    }));
  const get = client.get || jest.fn();
  const Fake = jest.fn().mockImplementation((options: ClientOptions) => {
    constructed.push(options);
    return { models: { list }, chat: { completions: { create } }, get };
  });
  return {
    sdk: { OpenAI: Fake as unknown as typeof OpenAI },
    constructed,
    list,
    create,
    get,
    Fake,
  };
};

// The real SDK, with a fetch that never leaves the process
const realSdk = (
  respond: (url: string, init: RequestInit) => Response
): {
  sdk: ContentStudioOpenAISdk;
  requests: Array<{ url: string; init: RequestInit }>;
} => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init || {} });
    return respond(String(url), init || {});
  };
  class InMemoryOpenAI extends OpenAI {
    constructor(options: ClientOptions) {
      super({ ...options, fetch });
    }
  }
  return { sdk: { OpenAI: InMemoryOpenAI }, requests };
};

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const textRequest = (
  overrides: Partial<ContentStudioAITextRequest> = {}
): ContentStudioAITextRequest => ({
  model: 'gpt-6.1-sol',
  system: 'You write social posts.',
  prompt: 'Write a post about spring.',
  output: { type: 'text' },
  maxOutputTokens: 500,
  ...overrides,
});

const providerError = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ContentStudioAIProviderError);
  expect(rendered(err)).not.toContain(MARKER);
  return err as ContentStudioAIProviderError;
};

let globalFetch: jest.SpyInstance;
beforeEach(() => {
  globalFetch = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('no network in unit tests');
  });
});
afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
});

describe('OpenAI adapter: client options', () => {
  it('OA1-OA8 gives every environment backed option explicitly', async () => {
    const { sdk, constructed } = fakeSdk({});
    await createOpenAIProviderAdapter(CREDENTIAL, sdk).validateConnection();

    expect(constructed).toEqual([
      {
        apiKey: MARKER,
        baseURL: 'https://api.openai.com/v1',
        organization: null,
        project: null,
        webhookSecret: null,
        logLevel: 'off',
        maxRetries: 0,
        timeout: 30_000,
      },
    ]);
  });

  it('OA9/OA10 makes no client until a call and a new one for every call', async () => {
    const { sdk, Fake } = fakeSdk({});
    const adapter = createOpenAIProviderAdapter(CREDENTIAL, sdk);
    expect(Fake).not.toHaveBeenCalled();

    await adapter.validateConnection();
    await adapter.validateConnection();
    await adapter.generateText(textRequest());
    expect(Fake).toHaveBeenCalledTimes(3);
    const clients = Fake.mock.results.map((result) => result.value);
    expect(new Set(clients).size).toBe(3);
  });

  it('keeps the key out of the adapter object', () => {
    const { sdk } = fakeSdk({});
    const adapter = createOpenAIProviderAdapter(CREDENTIAL, sdk);
    expect(Object.keys(adapter).sort()).toEqual([
      'generateText',
      'provider',
      'validateConnection',
    ]);
    expect(adapter.provider).toBe('openai');
    expect(rendered(adapter)).not.toContain(MARKER);
  });

  it('ignores every OpenAI environment variable', async () => {
    const saved = { ...process.env };
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (level) => jest.spyOn(console, level).mockImplementation(() => undefined)
    );
    try {
      Object.assign(process.env, {
        OPENAI_API_KEY: 'sk-from-the-environment-0000000000',
        OPENAI_BASE_URL: 'https://environment.invalid/v1',
        OPENAI_ORG_ID: 'org-from-environment',
        OPENAI_PROJECT_ID: 'proj-from-environment',
        OPENAI_WEBHOOK_SECRET: 'whsec-from-environment',
        OPENAI_LOG: 'debug',
      });
      const { sdk, requests } = realSdk(() => json(200, { data: [] }));
      await expect(
        createOpenAIProviderAdapter(CREDENTIAL, sdk).validateConnection()
      ).resolves.toEqual({ ok: true });

      expect(requests).toHaveLength(1);
      const headers = new Headers(requests[0].init.headers);
      expect(requests[0].url).toBe('https://api.openai.com/v1/models');
      expect(headers.get('authorization')).toBe(`Bearer ${MARKER}`);
      expect(headers.get('openai-organization')).toBeNull();
      expect(headers.get('openai-project')).toBeNull();
      for (const log of logs) {
        expect(log).not.toHaveBeenCalled();
      }
    } finally {
      process.env = saved;
    }
  });
});

describe('OpenAI adapter: validateConnection', () => {
  it('OA11 lists models with the key and generates nothing', async () => {
    const { sdk, list, create } = fakeSdk({});
    await expect(
      createOpenAIProviderAdapter(CREDENTIAL, sdk).validateConnection()
    ).resolves.toEqual({ ok: true });
    expect(list).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  // UX review 02: the connection's own model is what its AI calls use
  it('OA11b reads the connection model, and a model the key cannot use is MODEL_UNAVAILABLE', async () => {
    const { sdk, requests } = realSdk(() =>
      json(200, { id: 'gpt-6.1-sol', object: 'model', owned_by: 'openai' })
    );
    await expect(
      createOpenAIProviderAdapter(CREDENTIAL, sdk).validateConnection(
        'gpt-6.1-sol'
      )
    ).resolves.toEqual({ ok: true });
    expect(requests.map((r) => [r.init.method, r.url])).toEqual([
      ['GET', 'https://api.openai.com/v1/models/gpt-6.1-sol'],
    ]);

    const missing = realSdk(() =>
      json(404, {
        error: { message: 'The model does not exist', code: 'model_not_found' },
      })
    );
    await expect(
      createOpenAIProviderAdapter(CREDENTIAL, missing.sdk).validateConnection(
        'gpt-6.1-sol'
      )
    ).resolves.toEqual({ ok: false, code: 'MODEL_UNAVAILABLE' });
  });

  it('OA11 sends one authenticated GET /v1/models through the real SDK', async () => {
    const { sdk, requests } = realSdk(() => json(200, { data: [] }));
    await createOpenAIProviderAdapter(CREDENTIAL, sdk).validateConnection();
    expect(requests.map((r) => [r.init.method, r.url])).toEqual([
      ['GET', 'https://api.openai.com/v1/models'],
    ]);
  });

  it.each([
    ['OA12', 401, 'AUTH_FAILED'],
    ['OA13', 403, 'AUTH_FAILED'],
    ['OA14', 429, 'RATE_LIMITED'],
    ['', 402, 'QUOTA_EXCEEDED'],
    ['', 408, 'TIMEOUT'],
    ['', 404, 'MODEL_UNAVAILABLE'],
    ['', 400, 'REQUEST_REJECTED'],
    ['OA16', 500, 'PROVIDER_UNAVAILABLE'],
    ['OA16', 503, 'PROVIDER_UNAVAILABLE'],
    ['', 418, 'PROVIDER_UNAVAILABLE'],
  ])('%s maps HTTP %s to %s', async (_id, status, code) => {
    const { sdk } = fakeSdk({
      list: jest.fn(async () => {
        throw apiError(status);
      }),
    });
    const result = await createOpenAIProviderAdapter(
      CREDENTIAL,
      sdk
    ).validateConnection();
    expect(result).toEqual({ ok: false, code });
    expect(rendered(result)).not.toContain(MARKER);
  });

  it('maps an exhausted quota to QUOTA_EXCEEDED', async () => {
    const quota = APIError.generate(
      429,
      { error: { code: 'insufficient_quota', message: MARKER } },
      MARKER,
      new Headers()
    );
    const { sdk } = fakeSdk({
      list: jest.fn(async () => {
        throw quota;
      }),
    });
    expect(
      await createOpenAIProviderAdapter(CREDENTIAL, sdk).validateConnection()
    ).toEqual({ ok: false, code: 'QUOTA_EXCEEDED' });
  });

  it('OA15 maps a timeout to TIMEOUT', async () => {
    const { sdk } = fakeSdk({
      list: jest.fn(async () => {
        throw new APIConnectionTimeoutError();
      }),
    });
    expect(
      await createOpenAIProviderAdapter(CREDENTIAL, sdk).validateConnection()
    ).toEqual({ ok: false, code: 'TIMEOUT' });
  });

  it.each([
    ['a connection error', () => new APIConnectionError({ message: MARKER })],
    ['a plain error', () => new Error(MARKER)],
    ['a thrown string', () => MARKER],
  ])('OA17 maps %s to PROVIDER_UNAVAILABLE', async (_name, make) => {
    const { sdk } = fakeSdk({
      list: jest.fn(async () => {
        throw make();
      }),
    });
    const result = await createOpenAIProviderAdapter(
      CREDENTIAL,
      sdk
    ).validateConnection();
    expect(result).toEqual({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
  });

  it('OA12/OA18 maps a real 401 once, without retrying or keeping the provider message', async () => {
    const { sdk, requests } = realSdk(() =>
      json(
        401,
        { error: { message: `Incorrect API key provided: ${MARKER}` } },
        { 'x-request-id': 'req_401' }
      )
    );
    const result = await createOpenAIProviderAdapter(
      CREDENTIAL,
      sdk
    ).validateConnection();
    expect(result).toEqual({ ok: false, code: 'AUTH_FAILED' });
    expect(requests).toHaveLength(1);
    expect(rendered(result)).not.toContain(MARKER);
  });

  it('OA16 does not retry a 500', async () => {
    const { sdk, requests } = realSdk(() => json(500, { error: MARKER }));
    expect(
      await createOpenAIProviderAdapter(CREDENTIAL, sdk).validateConnection()
    ).toEqual({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
    expect(requests).toHaveLength(1);
  });
});

describe('OpenAI adapter: provider errors', () => {
  it('OA18 keeps status, request id and Retry-After, never the message', () => {
    const err = toContentStudioAIProviderError(
      apiError(429, { 'retry-after': '12', 'set-cookie': MARKER })
    );
    expect(err.toJSON()).toEqual({
      name: 'ContentStudioAIProviderError',
      code: 'RATE_LIMITED',
      message: 'The AI provider is rate limiting this connection',
      httpStatus: 429,
      providerRequestId: 'req_err_1',
      retryAfterSeconds: 12,
    });
    expect(err).not.toHaveProperty('cause');
    expect(rendered(err)).not.toContain(MARKER);
  });

  it('passes a provider error through unchanged', () => {
    const err = new ContentStudioAIProviderError('CONTENT_REJECTED');
    expect(toContentStudioAIProviderError(err)).toBe(err);
  });
});

describe('OpenAI adapter: generateText', () => {
  it('OA19-OA22 sends the catalog model and maps text, usage, finish reason and request id', async () => {
    const { sdk, create, list } = fakeSdk({});
    const result = await createOpenAIProviderAdapter(
      CREDENTIAL,
      sdk
    ).generateText(textRequest({ temperature: 0.4 }));

    expect(create).toHaveBeenCalledWith(
      {
        model: 'gpt-6.1-sol',
        messages: [
          { role: 'system', content: 'You write social posts.' },
          { role: 'user', content: 'Write a post about spring.' },
        ],
        max_completion_tokens: 500,
        temperature: 0.4,
      },
      { timeout: 30000 }
    );
    expect(list).not.toHaveBeenCalled();
    expect(result).toEqual({
      text: 'Hello there',
      finishReason: 'stop',
      usage: {
        inputTokens: 12,
        outputTokens: 30,
        cachedInputTokens: 4,
        reasoningTokens: 9,
        totalTokens: 42,
      },
      providerRequestId: 'req_ok_1',
    });
  });

  it('OA19 leaves temperature out when it is not given', async () => {
    const { sdk, create } = fakeSdk({});
    await createOpenAIProviderAdapter(CREDENTIAL, sdk).generateText(
      textRequest()
    );
    expect(create.mock.calls[0][0]).not.toHaveProperty('temperature');
    expect(create.mock.calls[0][0]).not.toHaveProperty('response_format');
  });

  it('OA19/OA22 posts to /v1/chat/completions through the real SDK', async () => {
    const { sdk, requests } = realSdk(() =>
      json(200, completion(), { 'x-request-id': 'req_real_1' })
    );
    const result = await createOpenAIProviderAdapter(
      CREDENTIAL,
      sdk
    ).generateText(textRequest({ model: 'gpt-6-luna' }));

    expect(requests.map((r) => [r.init.method, r.url])).toEqual([
      ['POST', 'https://api.openai.com/v1/chat/completions'],
    ]);
    expect(JSON.parse(String(requests[0].init.body))).toMatchObject({
      model: 'gpt-6-luna',
      max_completion_tokens: 500,
    });
    expect(result.providerRequestId).toBe('req_real_1');
  });

  it('OA23 never reports a cost or currency', async () => {
    const { sdk } = fakeSdk({
      create: jest.fn(() => ({
        withResponse: async () => ({
          data: completion({
            usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0.5 },
          }),
          request_id: null,
        }),
      })),
    });
    const result = await createOpenAIProviderAdapter(
      CREDENTIAL,
      sdk
    ).generateText(textRequest());
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(result).not.toHaveProperty('providerRequestId');
  });

  it('OA24 asks for strict JSON schema output from a model that supports it', async () => {
    const { sdk, create } = fakeSdk({});
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    };
    await createOpenAIProviderAdapter(CREDENTIAL, sdk).generateText(
      textRequest({ output: { type: 'json', schemaName: 'post', schema } })
    );
    expect(create.mock.calls[0][0].response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'post', strict: true, schema },
    });
  });

  it.each([
    [
      'a model of another provider',
      { model: 'openai/gpt-6.1-sol' },
      'MODEL_UNAVAILABLE',
    ],
    ['an unknown model', { model: 'gpt-4o' }, 'MODEL_UNAVAILABLE'],
    ['zero output tokens', { maxOutputTokens: 0 }, 'REQUEST_REJECTED'],
    ['fractional output tokens', { maxOutputTokens: 1.5 }, 'REQUEST_REJECTED'],
  ])(
    'OA25 refuses %s before any client exists',
    async (_name, overrides, code) => {
      const { sdk, Fake } = fakeSdk({});
      const err = await providerError(
        createOpenAIProviderAdapter(CREDENTIAL, sdk).generateText(
          textRequest(overrides)
        )
      );
      expect(err.code).toBe(code);
      expect(Fake).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['stop', 'stop'],
    ['length', 'length'],
    ['content_filter', 'content_filter'],
    ['tool_calls', 'other'],
    ['function_call', 'other'],
    ['error', 'other'],
    [null, 'other'],
    ['STOP', 'other'],
  ])('OA21 maps finish reason %p to %s', (value, expected) => {
    expect(toContentStudioAIFinishReason(value)).toBe(expected);
  });

  it('OA20 keeps reported, whole, non-negative counts only', () => {
    expect(toContentStudioAIUsage(undefined)).toBeNull();
    expect(toContentStudioAIUsage({})).toBeNull();
    expect(
      toContentStudioAIUsage({
        prompt_tokens: -1,
        completion_tokens: 2.5,
        total_tokens: '3',
        prompt_tokens_details: null,
      })
    ).toBeNull();
    expect(toContentStudioAIUsage({ total_tokens: 7 })).toEqual({
      totalTokens: 7,
    });
  });

  it.each([
    ['no choices', { choices: [] }, 'INVALID_RESPONSE'],
    [
      'no message',
      { choices: [{ finish_reason: 'stop' }] },
      'INVALID_RESPONSE',
    ],
    [
      'a null content',
      { choices: [{ finish_reason: 'stop', message: { content: null } }] },
      'INVALID_RESPONSE',
    ],
    [
      'a refusal',
      {
        choices: [
          {
            finish_reason: 'stop',
            message: { content: null, refusal: MARKER },
          },
        ],
      },
      'CONTENT_REJECTED',
    ],
    [
      'a filtered answer',
      {
        choices: [
          { finish_reason: 'content_filter', message: { content: null } },
        ],
      },
      'CONTENT_REJECTED',
    ],
  ])('maps %s to %s', async (_name, data, code) => {
    const { sdk } = fakeSdk({
      create: jest.fn(() => ({
        withResponse: async () => ({ data, request_id: 'req_1' }),
      })),
    });
    const err = await providerError(
      createOpenAIProviderAdapter(CREDENTIAL, sdk).generateText(textRequest())
    );
    expect(err.code).toBe(code);
  });

  it('OA18 normalizes a failed generation without the provider message', async () => {
    const { sdk } = fakeSdk({
      create: jest.fn(() => ({
        withResponse: async () => {
          throw apiError(401);
        },
      })),
    });
    const err = await providerError(
      createOpenAIProviderAdapter(CREDENTIAL, sdk).generateText(textRequest())
    );
    expect(err.code).toBe('AUTH_FAILED');
    expect(err.httpStatus).toBe(401);
  });
});

describe('OpenAI adapter source', () => {
  const text = fs
    .readFileSync(path.join(__dirname, 'openai.provider.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('has no environment, logging, cache or other network path', () => {
    expect(text).not.toMatch(
      /process\.|console\.|Logger|\bfetch\(|new Map|WeakMap|\bcache\b|responses\.create|err\.message|\bcause\b/i
    );
    expect(text.match(/new sdk\.OpenAI\(/g)).toHaveLength(1);
  });
});
