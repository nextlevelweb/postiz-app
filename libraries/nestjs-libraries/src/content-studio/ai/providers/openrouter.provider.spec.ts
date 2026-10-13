import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  ClientOptions,
} from 'openai';
import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import { createOpenRouterProviderAdapter } from '@gitroom/nestjs-libraries/content-studio/ai/providers/openrouter.provider';
import { ContentStudioOpenAISdk } from '@gitroom/nestjs-libraries/content-studio/ai/providers/openai.provider';
import { ContentStudioAIProviderError } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import { ContentStudioAITextRequest } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';

// No network: the SDK class is replaced, either by a fake client or by the
// real SDK with a fetch that answers in memory. A global fetch that is
// reached fails the test
const MARKER = 'sk-content-studio-test-secret-123';
const CREDENTIAL = { apiKey: MARKER };
const KEY_RECORD = { data: { label: 'Main', limit: null, usage: 0 } };

const rendered = (value: unknown) =>
  [
    String(value),
    JSON.stringify(value),
    inspect(value, { depth: 10, showHidden: true }),
    (value as Error)?.stack,
  ].join('\n');

const apiError = (status: number) =>
  APIError.generate(
    status,
    { error: { message: `No auth credentials found: ${MARKER}` } },
    MARKER,
    new Headers({ 'x-request-id': 'req_err_1' })
  );

const completion = (overrides: Record<string, unknown> = {}) => ({
  id: 'gen-1',
  object: 'chat.completion',
  created: 1,
  model: 'google/gemini-3.8-flash',
  choices: [
    {
      index: 0,
      finish_reason: 'length',
      native_finish_reason: 'MAX_TOKENS',
      message: { role: 'assistant', content: 'Spring is here' },
    },
  ],
  usage: {
    prompt_tokens: 20,
    completion_tokens: 10,
    total_tokens: 30,
    cost: 0.00042,
    cost_details: { upstream_inference_cost: 0.0004 },
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 3 },
    completion_tokens_details: { reasoning_tokens: 0 },
  },
  ...overrides,
});

const fakeSdk = (client: {
  get?: jest.Mock;
  create?: jest.Mock;
  list?: jest.Mock;
}) => {
  const constructed: ClientOptions[] = [];
  const get = client.get || jest.fn(async () => KEY_RECORD);
  const list = client.list || jest.fn(async () => ({ data: [] }));
  const create =
    client.create ||
    jest.fn(() => ({
      withResponse: async () => ({
        data: completion(),
        response: {},
        request_id: 'req_or_1',
      }),
    }));
  const Fake = jest.fn().mockImplementation((options: ClientOptions) => {
    constructed.push(options);
    return { get, models: { list }, chat: { completions: { create } } };
  });
  return {
    sdk: { OpenAI: Fake as unknown as typeof OpenAI },
    constructed,
    get,
    list,
    create,
    Fake,
  };
};

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
  model: 'google/gemini-3.8-flash',
  system: 'You write social posts.',
  prompt: 'Write a post about spring.',
  output: { type: 'text' },
  maxOutputTokens: 300,
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

describe('OpenRouter adapter: client options', () => {
  it('OR1-OR8 gives every environment backed option explicitly', async () => {
    const { sdk, constructed } = fakeSdk({});
    await createOpenRouterProviderAdapter(CREDENTIAL, sdk).validateConnection();
    expect(constructed).toEqual([
      {
        apiKey: MARKER,
        baseURL: 'https://openrouter.ai/api/v1',
        organization: null,
        project: null,
        webhookSecret: null,
        logLevel: 'off',
        maxRetries: 0,
        timeout: 30_000,
      },
    ]);
  });

  it('makes no client until a call and a new one for every call', async () => {
    const { sdk, Fake } = fakeSdk({});
    const adapter = createOpenRouterProviderAdapter(CREDENTIAL, sdk);
    expect(Fake).not.toHaveBeenCalled();
    await adapter.validateConnection();
    await adapter.generateText(textRequest());
    expect(Fake).toHaveBeenCalledTimes(2);
    expect(Fake.mock.results[0].value).not.toBe(Fake.mock.results[1].value);
    expect(adapter.provider).toBe('openrouter');
    expect(rendered(adapter)).not.toContain(MARKER);
  });

  it('ignores every OpenAI environment variable', async () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, {
        OPENAI_API_KEY: 'sk-from-the-environment-0000000000',
        OPENAI_BASE_URL: 'https://environment.invalid/v1',
        OPENAI_ORG_ID: 'org-from-environment',
        OPENAI_PROJECT_ID: 'proj-from-environment',
        OPENAI_LOG: 'debug',
        OPENROUTER_API_KEY: 'sk-or-from-the-environment-000000',
      });
      const { sdk, requests } = realSdk(() => json(200, KEY_RECORD));
      await createOpenRouterProviderAdapter(
        CREDENTIAL,
        sdk
      ).validateConnection();
      const headers = new Headers(requests[0].init.headers);
      expect(requests[0].url).toBe('https://openrouter.ai/api/v1/key');
      expect(headers.get('authorization')).toBe(`Bearer ${MARKER}`);
      expect(headers.get('openai-organization')).toBeNull();
      expect(headers.get('openai-project')).toBeNull();
      expect(headers.get('http-referer')).toBeNull();
      expect(headers.get('x-title')).toBeNull();
    } finally {
      process.env = saved;
    }
  });
});

describe('OpenRouter adapter: validateConnection', () => {
  it('OR9 sends one authenticated GET /api/v1/key and keeps nothing of the answer', async () => {
    const { sdk, requests } = realSdk(() => json(200, KEY_RECORD));
    const result = await createOpenRouterProviderAdapter(
      CREDENTIAL,
      sdk
    ).validateConnection();

    expect(result).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].init.method).toBe('GET');
    expect(requests[0].url).toBe('https://openrouter.ai/api/v1/key');
    expect(new Headers(requests[0].init.headers).get('authorization')).toBe(
      `Bearer ${MARKER}`
    );
  });

  it('OR10 never uses the public model list or a generation as proof', async () => {
    const { sdk, get, list, create } = fakeSdk({});
    await createOpenRouterProviderAdapter(CREDENTIAL, sdk).validateConnection();
    expect(get.mock.calls).toEqual([['/key']]);
    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty body', {}],
    ['a model list', { data: [{ id: 'openai/gpt-6.1-sol' }] }],
    ['a string', 'ok'],
    ['null data', { data: null }],
  ])('refuses %s as a key record', async (_name, body) => {
    const { sdk } = fakeSdk({ get: jest.fn(async () => body) });
    const result = await createOpenRouterProviderAdapter(
      CREDENTIAL,
      sdk
    ).validateConnection();
    expect(result).toEqual({ ok: false, code: 'INVALID_RESPONSE' });
  });

  it.each([
    ['OR11', 401, 'AUTH_FAILED'],
    ['OR11', 403, 'AUTH_FAILED'],
    ['', 402, 'QUOTA_EXCEEDED'],
    ['OR13', 408, 'TIMEOUT'],
    ['OR12', 429, 'RATE_LIMITED'],
    ['OR14', 500, 'PROVIDER_UNAVAILABLE'],
    ['OR14', 502, 'PROVIDER_UNAVAILABLE'],
    ['OR14', 503, 'PROVIDER_UNAVAILABLE'],
  ])('%s maps HTTP %s to %s', async (_id, status, code) => {
    const { sdk } = fakeSdk({
      get: jest.fn(async () => {
        throw apiError(status);
      }),
    });
    const result = await createOpenRouterProviderAdapter(
      CREDENTIAL,
      sdk
    ).validateConnection();
    expect(result).toEqual({ ok: false, code });
    expect(rendered(result)).not.toContain(MARKER);
  });

  it('OR11/OR15 maps a real 401 once, without the provider message', async () => {
    const { sdk, requests } = realSdk(() =>
      json(401, { error: { message: `No auth credentials found ${MARKER}` } })
    );
    const result = await createOpenRouterProviderAdapter(
      CREDENTIAL,
      sdk
    ).validateConnection();
    expect(result).toEqual({ ok: false, code: 'AUTH_FAILED' });
    expect(requests).toHaveLength(1);
    expect(rendered(result)).not.toContain(MARKER);
  });

  it('OR13 maps a timeout to TIMEOUT', async () => {
    const { sdk } = fakeSdk({
      get: jest.fn(async () => {
        throw new APIConnectionTimeoutError();
      }),
    });
    expect(
      await createOpenRouterProviderAdapter(
        CREDENTIAL,
        sdk
      ).validateConnection()
    ).toEqual({ ok: false, code: 'TIMEOUT' });
  });

  it('OR14 maps a network failure to PROVIDER_UNAVAILABLE', async () => {
    const { sdk } = fakeSdk({
      get: jest.fn(async () => {
        throw new APIConnectionError({ message: MARKER });
      }),
    });
    expect(
      await createOpenRouterProviderAdapter(
        CREDENTIAL,
        sdk
      ).validateConnection()
    ).toEqual({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
  });
});

describe('OpenRouter adapter: generateText', () => {
  it('OR16-OR20 maps text, usage, finish reason and request id, without the credit cost', async () => {
    const { sdk, create } = fakeSdk({});
    const result = await createOpenRouterProviderAdapter(
      CREDENTIAL,
      sdk
    ).generateText(textRequest());

    expect(create).toHaveBeenCalledWith({
      model: 'google/gemini-3.8-flash',
      messages: [
        { role: 'system', content: 'You write social posts.' },
        { role: 'user', content: 'Write a post about spring.' },
      ],
      max_completion_tokens: 300,
    });
    expect(result).toEqual({
      text: 'Spring is here',
      finishReason: 'length',
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 30,
      },
      providerRequestId: 'req_or_1',
    });
    expect(result.usage).not.toHaveProperty('costMicros');
    expect(result.usage).not.toHaveProperty('currency');
  });

  it('OR16 posts to /api/v1/chat/completions through the real SDK', async () => {
    const { sdk, requests } = realSdk(() => json(200, completion()));
    const result = await createOpenRouterProviderAdapter(
      CREDENTIAL,
      sdk
    ).generateText(textRequest({ model: 'openai/gpt-6.1-sol' }));
    expect(requests.map((r) => [r.init.method, r.url])).toEqual([
      ['POST', 'https://openrouter.ai/api/v1/chat/completions'],
    ]);
    expect(JSON.parse(String(requests[0].init.body)).model).toBe(
      'openai/gpt-6.1-sol'
    );
    // no x-request-id header: no request id
    expect(result).not.toHaveProperty('providerRequestId');
  });

  it.each([
    ['stop', 'stop'],
    ['length', 'length'],
    ['content_filter', 'content_filter'],
    ['tool_calls', 'other'],
    ['error', 'other'],
  ])('OR18 maps finish reason %s to %s', async (reason, expected) => {
    const { sdk } = fakeSdk({
      create: jest.fn(() => ({
        withResponse: async () => ({
          data: completion({
            choices: [{ finish_reason: reason, message: { content: 'x' } }],
          }),
          request_id: 'req_1',
        }),
      })),
    });
    const result = await createOpenRouterProviderAdapter(
      CREDENTIAL,
      sdk
    ).generateText(textRequest());
    expect(result.finishReason).toBe(expected);
  });

  it('OR19 drops a request id that is too long or not printable', async () => {
    for (const requestId of ['r'.repeat(201), 'req 1', `req\n${MARKER}`]) {
      const { sdk } = fakeSdk({
        create: jest.fn(() => ({
          withResponse: async () => ({
            data: completion(),
            request_id: requestId,
          }),
        })),
      });
      const result = await createOpenRouterProviderAdapter(
        CREDENTIAL,
        sdk
      ).generateText(textRequest());
      expect(result).not.toHaveProperty('providerRequestId');
    }
  });

  it('asks for strict JSON schema output from a model that supports it', async () => {
    const { sdk, create } = fakeSdk({});
    await createOpenRouterProviderAdapter(CREDENTIAL, sdk).generateText(
      textRequest({
        output: {
          type: 'json',
          schemaName: 'post',
          schema: { type: 'object' },
        },
      })
    );
    expect(create.mock.calls[0][0].response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'post', strict: true, schema: { type: 'object' } },
    });
  });

  it.each([
    [
      'JSON output from a model without it',
      {
        model: 'openai/gpt-6-luna',
        output: { type: 'json', schemaName: 'post', schema: {} },
      },
      'REQUEST_REJECTED',
    ],
    [
      'an OpenAI id without its prefix',
      { model: 'gpt-6.1-sol' },
      'MODEL_UNAVAILABLE',
    ],
    ['an unlisted model', { model: 'meta-llama/llama-9' }, 'MODEL_UNAVAILABLE'],
  ])('refuses %s before any client exists', async (_name, overrides, code) => {
    const { sdk, Fake } = fakeSdk({});
    const err = await providerError(
      createOpenRouterProviderAdapter(CREDENTIAL, sdk).generateText(
        textRequest(overrides as Partial<ContentStudioAITextRequest>)
      )
    );
    expect(err.code).toBe(code);
    expect(Fake).not.toHaveBeenCalled();
  });

  it('OR15 normalizes a failed generation without the provider message', async () => {
    const { sdk } = fakeSdk({
      create: jest.fn(() => ({
        withResponse: async () => {
          throw apiError(402);
        },
      })),
    });
    const err = await providerError(
      createOpenRouterProviderAdapter(CREDENTIAL, sdk).generateText(
        textRequest()
      )
    );
    expect(err.code).toBe('QUOTA_EXCEEDED');
  });
});

describe('OpenRouter adapter source', () => {
  const text = fs
    .readFileSync(path.join(__dirname, 'openrouter.provider.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('validates on the key endpoint only, with no environment, logging or other network path', () => {
    expect(text).toContain("const OPENROUTER_KEY_PATH = '/key';");
    expect(text).not.toMatch(
      /models\.list|\/models|process\.|console\.|Logger|\bfetch\(|new Map|\bcache\b|defaultHeaders|HTTP-Referer|X-Title/i
    );
    expect(text.match(/new sdk\.OpenAI\(/g)).toHaveLength(1);
  });
});
