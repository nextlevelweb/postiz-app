import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  ClientOptions,
} from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import {
  ContentStudioAnthropicSdk,
  createAnthropicProviderAdapter,
  toContentStudioAnthropicFinishReason,
  toContentStudioAnthropicProviderError,
  toContentStudioAnthropicUsage,
} from '@gitroom/nestjs-libraries/content-studio/ai/providers/anthropic.provider';
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
    {
      type: 'error',
      error: {
        type: 'authentication_error',
        message: `invalid x-api-key ${MARKER}`,
      },
      request_id: 'req_body_1',
    },
    `invalid x-api-key ${MARKER}`,
    new Headers({ 'request-id': 'req_err_1', ...headers })
  );

const message = (overrides: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [
    { type: 'thinking', thinking: `private ${MARKER}`, signature: 'sig' },
    { type: 'text', text: 'Spring is ', citations: null },
    { type: 'text', text: 'here', citations: null },
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 12,
    output_tokens: 30,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 4,
    server_tool_use: null,
    service_tier: 'standard',
  },
  ...overrides,
});

// A fake SDK class: records the options of every client and gives each one
// the methods below
const fakeSdk = (client: { list?: jest.Mock; create?: jest.Mock }) => {
  const constructed: ClientOptions[] = [];
  const list = client.list || jest.fn(async () => ({ data: [] }));
  const create =
    client.create ||
    jest.fn(() => ({
      withResponse: async () => ({
        data: message(),
        response: {},
        request_id: 'req_ok_1',
      }),
    }));
  const Fake = jest.fn().mockImplementation((options: ClientOptions) => {
    constructed.push(options);
    return { models: { list }, messages: { create } };
  });
  return {
    sdk: { Anthropic: Fake as unknown as typeof Anthropic },
    constructed,
    list,
    create,
    Fake,
  };
};

// The real SDK, with a fetch that never leaves the process. The spec adds the
// fetch here; production clients may not take one
const realSdk = (
  respond: (url: string, init: RequestInit) => Response
): {
  sdk: ContentStudioAnthropicSdk;
  requests: Array<{ url: string; init: RequestInit }>;
  clients: Anthropic[];
} => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const clients: Anthropic[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init || {} });
    return respond(String(url), init || {});
  };
  class InMemoryAnthropic extends Anthropic {
    constructor(options: ClientOptions) {
      super({ ...options, fetch });
      clients.push(this);
    }
  }
  return { sdk: { Anthropic: InMemoryAnthropic }, requests, clients };
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

const MODEL_LIST = {
  data: [],
  has_more: false,
  first_id: null,
  last_id: null,
};

const textRequest = (
  overrides: Partial<ContentStudioAITextRequest> = {}
): ContentStudioAITextRequest => ({
  model: 'claude-opus-5-5',
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

const HOSTILE_ENVIRONMENT = {
  ANTHROPIC_API_KEY: 'sk-ant-from-the-environment-0000000000',
  ANTHROPIC_AUTH_TOKEN: 'token-from-the-environment',
  ANTHROPIC_BASE_URL: 'https://environment.invalid',
  ANTHROPIC_LOG: 'debug',
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

describe('Anthropic adapter: client options', () => {
  it('AA1-AA6 gives every environment backed option explicitly, and nothing else', async () => {
    const { sdk, constructed } = fakeSdk({});
    await createAnthropicProviderAdapter(CREDENTIAL, sdk).validateConnection();

    expect(constructed).toEqual([
      {
        apiKey: MARKER,
        authToken: null,
        baseURL: 'https://api.anthropic.com',
        logLevel: 'off',
        maxRetries: 0,
        timeout: 30_000,
      },
    ]);
    expect(constructed[0]).not.toHaveProperty('fetch');
    expect(constructed[0]).not.toHaveProperty('defaultHeaders');
  });

  it('AA7/AA8 makes no client until a call and a new one for every call', async () => {
    const { sdk, Fake } = fakeSdk({});
    const adapter = createAnthropicProviderAdapter(CREDENTIAL, sdk);
    expect(Fake).not.toHaveBeenCalled();

    await adapter.validateConnection();
    await adapter.validateConnection();
    await adapter.generateText(textRequest());
    expect(Fake).toHaveBeenCalledTimes(3);
    expect(new Set(Fake.mock.results.map((r) => r.value)).size).toBe(3);
  });

  it('AA9 keeps the key out of the adapter object', () => {
    const { sdk } = fakeSdk({});
    const adapter = createAnthropicProviderAdapter(CREDENTIAL, sdk);
    expect(Object.keys(adapter).sort()).toEqual([
      'generateText',
      'provider',
      'validateConnection',
    ]);
    expect(adapter.provider).toBe('anthropic');
    expect(rendered(adapter)).not.toContain(MARKER);
  });

  it('AA10 ignores every Anthropic environment variable in the real SDK', async () => {
    const saved = { ...process.env };
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (level) => jest.spyOn(console, level).mockImplementation(() => undefined)
    );
    try {
      Object.assign(process.env, HOSTILE_ENVIRONMENT);
      const { sdk, requests, clients } = realSdk(() => json(200, MODEL_LIST));
      await expect(
        createAnthropicProviderAdapter(CREDENTIAL, sdk).validateConnection()
      ).resolves.toEqual({ ok: true });

      expect(requests).toHaveLength(1);
      const headers = new Headers(requests[0].init.headers);
      expect(requests[0].url).toBe('https://api.anthropic.com/v1/models');
      expect(headers.get('x-api-key')).toBe(MARKER);
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('anthropic-version')).toBe('2023-06-01');
      expect(clients[0].baseURL).toBe('https://api.anthropic.com');
      expect(clients[0].apiKey).toBe(MARKER);
      expect(clients[0].authToken).toBeNull();
      expect(clients[0].maxRetries).toBe(0);
      expect(clients[0].timeout).toBe(30_000);
      expect(clients[0].logLevel).toBe('off');
      for (const log of logs) {
        expect(log).not.toHaveBeenCalled();
      }
    } finally {
      process.env = saved;
    }
  });
});

describe('Anthropic adapter: validateConnection', () => {
  it('AA11 lists models with the key and generates nothing', async () => {
    const { sdk, list, create } = fakeSdk({});
    await expect(
      createAnthropicProviderAdapter(CREDENTIAL, sdk).validateConnection()
    ).resolves.toEqual({ ok: true });
    expect(list).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('AA11 sends one authenticated GET /v1/models through the real SDK', async () => {
    const { sdk, requests } = realSdk(() => json(200, MODEL_LIST));
    await createAnthropicProviderAdapter(CREDENTIAL, sdk).validateConnection();
    expect(requests.map((r) => [r.init.method, r.url])).toEqual([
      ['GET', 'https://api.anthropic.com/v1/models'],
    ]);
    expect(new Headers(requests[0].init.headers).get('x-api-key')).toBe(MARKER);
  });

  it.each([
    ['AA12', 401, 'AUTH_FAILED'],
    ['AA13', 403, 'AUTH_FAILED'],
    ['AA15', 402, 'QUOTA_EXCEEDED'],
    ['AA14', 429, 'RATE_LIMITED'],
    ['AA19', 404, 'MODEL_UNAVAILABLE'],
    ['AA20', 400, 'REQUEST_REJECTED'],
    ['AA20', 413, 'REQUEST_REJECTED'],
    ['AA16', 504, 'TIMEOUT'],
    ['AA17', 500, 'PROVIDER_UNAVAILABLE'],
    ['AA17', 529, 'PROVIDER_UNAVAILABLE'],
  ])('%s maps HTTP %s to %s', async (_id, status, code) => {
    const { sdk } = fakeSdk({
      list: jest.fn(async () => {
        throw apiError(status);
      }),
    });
    const result = await createAnthropicProviderAdapter(
      CREDENTIAL,
      sdk
    ).validateConnection();
    expect(result).toEqual({ ok: false, code });
    expect(rendered(result)).not.toContain(MARKER);
  });

  it('AA16 maps a timeout to TIMEOUT', async () => {
    const { sdk } = fakeSdk({
      list: jest.fn(async () => {
        throw new APIConnectionTimeoutError();
      }),
    });
    expect(
      await createAnthropicProviderAdapter(CREDENTIAL, sdk).validateConnection()
    ).toEqual({ ok: false, code: 'TIMEOUT' });
  });

  it.each([
    ['a connection error', () => new APIConnectionError({ message: MARKER })],
    ['a plain error', () => new Error(MARKER)],
    ['a thrown string', () => MARKER],
  ])('AA18 maps %s to PROVIDER_UNAVAILABLE', async (_name, make) => {
    const { sdk } = fakeSdk({
      list: jest.fn(async () => {
        throw make();
      }),
    });
    expect(
      await createAnthropicProviderAdapter(CREDENTIAL, sdk).validateConnection()
    ).toEqual({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
  });

  it('AA12/AA22 maps a real 401 once, without the provider message', async () => {
    const { sdk, requests } = realSdk(() =>
      json(
        401,
        {
          type: 'error',
          error: { type: 'authentication_error', message: MARKER },
          request_id: 'req_401',
        },
        { 'request-id': 'req_401' }
      )
    );
    const result = await createAnthropicProviderAdapter(
      CREDENTIAL,
      sdk
    ).validateConnection();
    expect(result).toEqual({ ok: false, code: 'AUTH_FAILED' });
    expect(requests).toHaveLength(1);
    expect(rendered(result)).not.toContain(MARKER);
  });

  it('AA38 does not retry a 500 or a 529', async () => {
    for (const status of [500, 529]) {
      const { sdk, requests } = realSdk(() =>
        json(status, { type: 'error', error: { message: MARKER } })
      );
      expect(
        await createAnthropicProviderAdapter(
          CREDENTIAL,
          sdk
        ).validateConnection()
      ).toEqual({ ok: false, code: 'PROVIDER_UNAVAILABLE' });
      expect(requests).toHaveLength(1);
    }
  });
});

describe('Anthropic adapter: provider errors', () => {
  it('AA22 keeps status, request id and Retry-After, never the message or body', () => {
    const err = toContentStudioAnthropicProviderError(
      apiError(429, { 'retry-after': '9', 'set-cookie': MARKER })
    );
    expect(err.toJSON()).toEqual({
      name: 'ContentStudioAIProviderError',
      code: 'RATE_LIMITED',
      message: 'The AI provider is rate limiting this connection',
      httpStatus: 429,
      providerRequestId: 'req_err_1',
      retryAfterSeconds: 9,
    });
    expect(err).not.toHaveProperty('cause');
    expect(rendered(err)).not.toMatch(
      /sk-content-studio|authentication_error|req_body_1/
    );
  });

  it('passes a provider error through unchanged', () => {
    const err = new ContentStudioAIProviderError('CONTENT_REJECTED');
    expect(toContentStudioAnthropicProviderError(err)).toBe(err);
  });
});

describe('Anthropic adapter: generateText', () => {
  it('AA23-AA29/AA34 sends a native Messages request and maps the answer', async () => {
    const { sdk, create, list } = fakeSdk({});
    const result = await createAnthropicProviderAdapter(
      CREDENTIAL,
      sdk
    ).generateText(textRequest({ temperature: 0.3 }));

    expect(create).toHaveBeenCalledWith(
      {
        model: 'claude-opus-5-5',
        max_tokens: 500,
        system: 'You write social posts.',
        messages: [{ role: 'user', content: 'Write a post about spring.' }],
        temperature: 0.3,
      },
      { timeout: 30000 }
    );
    expect(list).not.toHaveBeenCalled();
    expect(result).toEqual({
      text: 'Spring is here',
      finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 30, cachedInputTokens: 4 },
      providerRequestId: 'req_ok_1',
    });
    // the thinking block is never part of the answer
    expect(rendered(result)).not.toContain(MARKER);
  });

  it('AA27 leaves temperature out when it is not given', async () => {
    const { sdk, create } = fakeSdk({});
    await createAnthropicProviderAdapter(CREDENTIAL, sdk).generateText(
      textRequest()
    );
    expect(Object.keys(create.mock.calls[0][0]).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'system',
    ]);
  });

  it('AA23/AA34 posts to /v1/messages through the real SDK', async () => {
    const { sdk, requests } = realSdk(() =>
      json(200, message({ model: 'claude-haiku-4-5-20251001' }), {
        'request-id': 'req_real_1',
      })
    );
    const result = await createAnthropicProviderAdapter(
      CREDENTIAL,
      sdk
    ).generateText(textRequest({ model: 'claude-haiku-4-5-20251001' }));

    expect(requests.map((r) => [r.init.method, r.url])).toEqual([
      ['POST', 'https://api.anthropic.com/v1/messages'],
    ]);
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: 'You write social posts.',
      messages: [{ role: 'user', content: 'Write a post about spring.' }],
    });
    expect(result.providerRequestId).toBe('req_real_1');
  });

  it('AA30 never reports a cost, currency, total or reasoning tokens', async () => {
    const { sdk } = fakeSdk({});
    const { usage } = await createAnthropicProviderAdapter(
      CREDENTIAL,
      sdk
    ).generateText(textRequest());
    expect(Object.keys(usage || {}).sort()).toEqual([
      'cachedInputTokens',
      'inputTokens',
      'outputTokens',
    ]);
  });

  it.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['max_tokens', 'length'],
    ['model_context_window_exceeded', 'length'],
    ['refusal', 'content_filter'],
    ['tool_use', 'other'],
    ['pause_turn', 'other'],
    ['constructor', 'other'],
    ['toString', 'other'],
    [null, 'other'],
    ['END_TURN', 'other'],
  ])('AA31-AA33 maps stop reason %p to %s', (value, expected) => {
    expect(toContentStudioAnthropicFinishReason(value)).toBe(expected);
  });

  it('AA29 keeps reported, whole, non-negative counts only', () => {
    expect(toContentStudioAnthropicUsage(undefined)).toBeNull();
    expect(toContentStudioAnthropicUsage({})).toBeNull();
    expect(
      toContentStudioAnthropicUsage({
        input_tokens: -1,
        output_tokens: 1.5,
        cache_read_input_tokens: null,
      })
    ).toBeNull();
    expect(toContentStudioAnthropicUsage({ output_tokens: 7 })).toEqual({
      outputTokens: 7,
    });
  });

  it('AA34 drops a request id that is too long or not printable', async () => {
    for (const requestId of ['r'.repeat(201), 'req 1', null]) {
      const { sdk } = fakeSdk({
        create: jest.fn(() => ({
          withResponse: async () => ({
            data: message(),
            request_id: requestId,
          }),
        })),
      });
      const result = await createAnthropicProviderAdapter(
        CREDENTIAL,
        sdk
      ).generateText(textRequest());
      expect(result).not.toHaveProperty('providerRequestId');
    }
  });

  it('AA21 answers the text of a refusal that has some, as content_filter', async () => {
    const { sdk } = fakeSdk({
      create: jest.fn(() => ({
        withResponse: async () => ({
          data: message({
            content: [{ type: 'text', text: 'I can only help with' }],
            stop_reason: 'refusal',
          }),
          request_id: 'req_1',
        }),
      })),
    });
    const result = await createAnthropicProviderAdapter(
      CREDENTIAL,
      sdk
    ).generateText(textRequest());
    expect(result.finishReason).toBe('content_filter');
  });

  it.each([
    [
      'AA21 a refusal without text',
      { content: [], stop_reason: 'refusal' },
      'CONTENT_REJECTED',
    ],
    ['AA35 no content', { content: undefined }, 'INVALID_RESPONSE'],
    [
      'AA35 content that is not a list',
      { content: MARKER },
      'INVALID_RESPONSE',
    ],
    [
      'AA35 no text block',
      { content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
      'INVALID_RESPONSE',
    ],
    [
      'AA35 only thinking',
      { content: [{ type: 'thinking', thinking: MARKER }] },
      'INVALID_RESPONSE',
    ],
    [
      'AA35 a text block without text',
      { content: [{ type: 'text', text: 7 }] },
      'INVALID_RESPONSE',
    ],
  ])('maps %s to %s', async (_name, overrides, code) => {
    const { sdk } = fakeSdk({
      create: jest.fn(() => ({
        withResponse: async () => ({
          data: message(overrides),
          request_id: 'req_1',
        }),
      })),
    });
    const err = await providerError(
      createAnthropicProviderAdapter(CREDENTIAL, sdk).generateText(
        textRequest()
      )
    );
    expect(err.code).toBe(code);
  });

  it('AA28 leaves tool use and unknown blocks out of the text', async () => {
    const { sdk } = fakeSdk({
      create: jest.fn(() => ({
        withResponse: async () => ({
          data: message({
            content: [
              { type: 'text', text: 'One' },
              { type: 'tool_use', id: 't', name: 'x', input: { a: MARKER } },
              { type: 'something_new', text: MARKER },
              { type: 'redacted_thinking', data: MARKER },
              { type: 'text', text: ' two' },
            ],
          }),
          request_id: 'req_1',
        }),
      })),
    });
    const result = await createAnthropicProviderAdapter(
      CREDENTIAL,
      sdk
    ).generateText(textRequest());
    expect(result.text).toBe('One two');
  });

  it.each([
    [
      'AA36 JSON output, which no Claude model offers here yet',
      {
        output: {
          type: 'json',
          schemaName: 'post',
          schema: { type: 'object' },
        },
      },
      'REQUEST_REJECTED',
    ],
    [
      'a model of another provider',
      { model: 'gpt-6.1-sol' },
      'MODEL_UNAVAILABLE',
    ],
    [
      'an unlisted Claude model',
      { model: 'claude-fable-5-1' },
      'MODEL_UNAVAILABLE',
    ],
    ['zero output tokens', { maxOutputTokens: 0 }, 'REQUEST_REJECTED'],
  ])('refuses %s before any client exists', async (_name, overrides, code) => {
    const { sdk, Fake } = fakeSdk({});
    const err = await providerError(
      createAnthropicProviderAdapter(CREDENTIAL, sdk).generateText(
        textRequest(overrides as Partial<ContentStudioAITextRequest>)
      )
    );
    expect(err.code).toBe(code);
    expect(Fake).not.toHaveBeenCalled();
  });

  it('AA37 offers no structured output for any catalog model', async () => {
    // structuredOutput is false for every Claude model in the catalog, so the
    // adapter has no native JSON mapping to test yet
    for (const model of [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-4-5-20251001',
    ]) {
      const { sdk } = fakeSdk({});
      const err = await providerError(
        createAnthropicProviderAdapter(CREDENTIAL, sdk).generateText(
          textRequest({
            model,
            output: { type: 'json', schemaName: 'post', schema: {} },
          })
        )
      );
      expect(err.code).toBe('REQUEST_REJECTED');
    }
  });

  it('AA22 normalizes a failed generation without the provider message', async () => {
    const { sdk } = fakeSdk({
      create: jest.fn(() => ({
        withResponse: async () => {
          throw apiError(404);
        },
      })),
    });
    const err = await providerError(
      createAnthropicProviderAdapter(CREDENTIAL, sdk).generateText(
        textRequest()
      )
    );
    expect(err.code).toBe('MODEL_UNAVAILABLE');
    expect(err.httpStatus).toBe(404);
  });
});

describe('Anthropic adapter source', () => {
  const text = fs
    .readFileSync(path.join(__dirname, 'anthropic.provider.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('AA39/AA40 has no environment, logging, cache, wrapper or other network path', () => {
    expect(text).not.toMatch(
      /process\.|console\.|Logger|\bfetch\(|new Map|WeakMap|\bcache\b|err\.message|\bcause\b|@ai-sdk|langchain|from 'openai'/i
    );
    expect(text.match(/new sdk\.Anthropic\(/g)).toHaveLength(1);
    expect(text).toContain(
      "const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';"
    );
  });
});

// UX review 02: a key that is not scoped to a workspace (the real failure of
// the first local setup: every call answered 400 asking for the
// anthropic-workspace-id header)
describe('Anthropic adapter: workspace, model check and timeout', () => {
  const WORKSPACE = 'wrkspc_01TestWorkspace';
  const workspaceError = () =>
    json(400, {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: `This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. ${MARKER}`,
      },
    });

  it('AW1 sends the workspace id of the connection on every request, and none without one', async () => {
    const { sdk, requests } = realSdk((url) =>
      url.endsWith('/v1/messages')
        ? json(200, message(), { 'request-id': 'req_ok_2' })
        : json(200, MODEL_LIST)
    );
    const adapter = createAnthropicProviderAdapter(
      { apiKey: MARKER, workspaceId: WORKSPACE },
      sdk
    );
    await adapter.validateConnection();
    await adapter.generateText(textRequest());
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(
        new Headers(request.init.headers).get('anthropic-workspace-id')
      ).toBe(WORKSPACE);
    }

    const plain = realSdk(() => json(200, MODEL_LIST));
    await createAnthropicProviderAdapter(
      CREDENTIAL,
      plain.sdk
    ).validateConnection();
    expect(
      new Headers(plain.requests[0].init.headers).get('anthropic-workspace-id')
    ).toBeNull();
  });

  it('AW2 tells a key that needs a workspace apart from any other rejected request, without the message', async () => {
    const { sdk } = realSdk(() => workspaceError());
    const adapter = createAnthropicProviderAdapter(CREDENTIAL, sdk);
    await expect(
      adapter.validateConnection('claude-opus-5-5')
    ).resolves.toEqual({
      ok: false,
      code: 'WORKSPACE_REQUIRED',
    });
    const err = await providerError(adapter.generateText(textRequest()));
    expect(err.code).toBe('WORKSPACE_REQUIRED');
    expect(err.httpStatus).toBe(400);
    expect(rendered(err)).not.toMatch(/scoped|workspace-id/);

    const other = realSdk(() =>
      json(400, {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'max_tokens: too large',
        },
      })
    );
    const rejected = await providerError(
      createAnthropicProviderAdapter(CREDENTIAL, other.sdk).generateText(
        textRequest()
      )
    );
    expect(rejected.code).toBe('REQUEST_REJECTED');
  });

  it('AW3 checks the connection model by reading it, and a model the key cannot use is MODEL_UNAVAILABLE', async () => {
    const ok = realSdk(() =>
      json(200, {
        type: 'model',
        id: 'claude-opus-5-5',
        display_name: 'Claude Opus 5.5',
        created_at: '2026-01-01T00:00:00Z',
      })
    );
    await expect(
      createAnthropicProviderAdapter(CREDENTIAL, ok.sdk).validateConnection(
        'claude-opus-5-5'
      )
    ).resolves.toEqual({ ok: true });
    expect(ok.requests.map((r) => r.url)).toEqual([
      'https://api.anthropic.com/v1/models/claude-opus-5-5',
    ]);
    expect(ok.requests[0].init.method).toBe('GET');

    const missing = realSdk(() =>
      json(404, {
        type: 'error',
        error: { type: 'not_found_error', message: 'model: claude-x' },
      })
    );
    await expect(
      createAnthropicProviderAdapter(
        CREDENTIAL,
        missing.sdk
      ).validateConnection('claude-opus-5-5')
    ).resolves.toEqual({ ok: false, code: 'MODEL_UNAVAILABLE' });
  });

  it('AW4 waits longer only when the request asks, and never more than the cap', async () => {
    for (const [timeoutMs, expected] of [
      [undefined, 30_000],
      [10_000, 30_000],
      [150_000, 150_000],
      [999_999, 180_000],
    ] as const) {
      const { sdk, create } = fakeSdk({});
      await createAnthropicProviderAdapter(CREDENTIAL, sdk).generateText(
        textRequest(timeoutMs === undefined ? {} : { timeoutMs })
      );
      expect(create.mock.calls[0][1]).toEqual({ timeout: expected });
    }
  });
});
