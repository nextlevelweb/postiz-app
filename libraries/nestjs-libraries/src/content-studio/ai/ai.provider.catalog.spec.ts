import { inspect } from 'util';
import {
  AI_API_KEY_MAX,
  AI_API_KEY_MIN,
  CONTENT_STUDIO_AI_PROVIDERS,
  ContentStudioAICredentialError,
  getContentStudioAIDefaultModel,
  getContentStudioAIModel,
  getContentStudioAIProvider,
  isContentStudioAIModelSupported,
  isContentStudioAIProvider,
  listContentStudioAIProviders,
  parseContentStudioAICredential,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';

const MARKER = 'sk-content-studio-test-secret-123';

// Every way an error could carry the key it refused
const rendered = (err: unknown) =>
  [
    String(err),
    (err as Error).message,
    (err as Error).stack,
    JSON.stringify(err),
    inspect(err),
  ].join('\n');

const refusal = (provider: unknown, input: unknown) => {
  try {
    parseContentStudioAICredential(provider, input);
  } catch (err) {
    return err;
  }
  throw new Error('the credential was expected to be refused');
};

describe('Content Studio AI provider catalog', () => {
  it('PC1/PC2/AC1 supports openai, openrouter and anthropic', () => {
    expect(CONTENT_STUDIO_AI_PROVIDERS).toEqual([
      'openai',
      'openrouter',
      'anthropic',
    ]);
    expect(isContentStudioAIProvider('openai')).toBe(true);
    expect(isContentStudioAIProvider('openrouter')).toBe(true);
    expect(isContentStudioAIProvider('anthropic')).toBe(true);
  });

  it.each([
    ['mistral'],
    ['Anthropic'],
    ['claude'],
    ['google'],
    ['OpenAI'],
    [' openai'],
    [''],
    [null],
    [undefined],
    [1],
    [{}],
    ['constructor'],
    ['toString'],
  ])('PC3/PC4 does not support %p', (provider) => {
    expect(isContentStudioAIProvider(provider)).toBe(false);
    const err = refusal(provider, { apiKey: MARKER });
    expect(err).toBeInstanceOf(ContentStudioAICredentialError);
    expect((err as ContentStudioAICredentialError).code).toBe('INVALID');
  });

  it.each(CONTENT_STUDIO_AI_PROVIDERS.map((provider) => [provider]))(
    'PC5 accepts a key exactly as given for %s',
    (provider) => {
      for (const apiKey of [
        MARKER,
        'sk-test_ABC-123.xyz',
        'x'.repeat(AI_API_KEY_MIN),
        'y'.repeat(AI_API_KEY_MAX),
        // every printable ASCII character but the space
        Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).join(
          ''
        ),
        'no-vendor-prefix-at-all',
      ]) {
        expect(parseContentStudioAICredential(provider, { apiKey })).toEqual({
          apiKey,
        });
      }
    }
  );

  it.each([
    ['PC6 too short', 'x'.repeat(AI_API_KEY_MIN - 1)],
    ['PC7 too long', 'x'.repeat(AI_API_KEY_MAX + 1)],
    ['PC8 a space inside', 'sk-content studio-key'],
    ['PC8 a leading space (never trimmed)', ` ${MARKER}`],
    ['PC8 a trailing space (never trimmed)', `${MARKER} `],
    ['PC8 a tab', `${MARKER}\t`],
    ['PC9 a newline', `${MARKER}\n`],
    ['PC9 a carriage return', `sk-content\r-studio-key`],
    ['PC10 NUL', `${MARKER}\u0000`],
    ['DEL', `${MARKER}\u007f`],
    ['a non-ASCII letter', `${MARKER}\u00e9`],
    ['a no-break space', `${MARKER}\u00a0`],
    ['empty', ''],
  ])('refuses a key with %s', (_name, apiKey) => {
    const err = refusal('openai', { apiKey });
    expect(err).toBeInstanceOf(ContentStudioAICredentialError);
    expect((err as ContentStudioAICredentialError).code).toBe('INVALID');
  });

  it.each([
    ['PC11 an unknown field', { apiKey: MARKER, baseURL: 'https://x.test' }],
    ['PC11 an organization field', { apiKey: MARKER, organization: 'org' }],
    ['PC12 no apiKey', {}],
    ['PC12 apiKey under another name', { key: MARKER }],
    ['a number', { apiKey: 12345678901 }],
    ['an array', [MARKER]],
    ['a string', MARKER],
    ['null', null],
  ])('refuses a credential with %s', (_name, input) => {
    const err = refusal('openrouter', input);
    expect(err).toBeInstanceOf(ContentStudioAICredentialError);
    expect((err as ContentStudioAICredentialError).code).toBe('INVALID');
  });

  it('PC13 never repeats the refused key or any part of it', () => {
    for (const input of [
      { apiKey: `${MARKER} ` },
      { apiKey: `${MARKER}\n` },
      { apiKey: MARKER.repeat(20) },
      { apiKey: MARKER, extra: MARKER },
      { key: MARKER },
      MARKER,
    ]) {
      const text = rendered(refusal('openai', input));
      expect(text).not.toContain(MARKER);
      expect(text).not.toContain('content-studio-test');
    }
    expect(rendered(refusal('mistral', { apiKey: MARKER }))).not.toContain(
      MARKER
    );
  });

  it('has fixed messages and no cause', () => {
    const err = refusal('openai', { apiKey: `${MARKER} ` }) as Error;
    expect(err.message).toBe('The AI connection credential is invalid');
    expect(err.name).toBe('ContentStudioAICredentialError');
    expect('cause' in err).toBe(false);
    expect(JSON.parse(JSON.stringify(err))).toEqual({
      name: 'ContentStudioAICredentialError',
      code: 'INVALID',
      message: 'The AI connection credential is invalid',
    });
  });

  it('PC14 lists provider ids only, no credential values or defaults', () => {
    expect(JSON.stringify(CONTENT_STUDIO_AI_PROVIDERS)).toBe(
      '["openai","openrouter","anthropic"]'
    );
  });
});

describe('Content Studio AI provider catalog: public metadata', () => {
  it('P1-P3/AC2/AC15 lists openai, openrouter, then anthropic with their display names', () => {
    expect(
      listContentStudioAIProviders().map(({ provider, displayName }) => [
        provider,
        displayName,
      ])
    ).toEqual([
      ['openai', 'OpenAI'],
      ['openrouter', 'OpenRouter'],
      ['anthropic', 'Anthropic'],
    ]);
  });

  it('P4/P5 describes the API key field, the default model and the models only', () => {
    for (const info of listContentStudioAIProviders()) {
      expect(Object.keys(info)).toEqual([
        'provider',
        'displayName',
        'credentialFields',
        'defaultModel',
        'models',
      ]);
      expect(info.credentialFields[0]).toEqual({
        name: 'apiKey',
        label: 'API key',
        secret: true,
        required: true,
      });
      // only Anthropic asks for more: an optional workspace id
      expect(info.credentialFields.slice(1)).toEqual(
        info.provider === 'anthropic'
          ? [
              {
                name: 'workspaceId',
                label: 'Workspace ID',
                secret: false,
                required: false,
              },
            ]
          : []
      );
    }
  });

  it('P6-P9/P11 is plain JSON with no endpoint, environment name, key or schema', () => {
    const json = JSON.stringify(listContentStudioAIProviders());
    expect(JSON.parse(json)).toEqual(listContentStudioAIProviders());
    expect(json).not.toMatch(
      /baseURL|baseUrl|https?:|api\.openai|openrouter\.ai|_API_KEY|process|env|sk-|AIza|example|placeholder|regex|\bmin|\bmax|_def|ZodObject|safeParse/i
    );
    for (const info of listContentStudioAIProviders()) {
      for (const value of Object.values(info)) {
        expect(
          value?.constructor === Object ||
            Array.isArray(value) ||
            typeof value === 'string'
        ).toBe(true);
      }
    }
  });

  it('P10/AC13 describes Anthropic with the API key and an optional workspace id', () => {
    const anthropic = getContentStudioAIProvider('anthropic');
    expect(anthropic?.credentialFields).toEqual([
      { name: 'apiKey', label: 'API key', secret: true, required: true },
      {
        name: 'workspaceId',
        label: 'Workspace ID',
        secret: false,
        required: false,
      },
    ]);
    expect(JSON.stringify(anthropic)).not.toMatch(
      /sk-ant|ANTHROPIC_|authToken|x-api-key|anthropic-version|baseURL|https?:/i
    );
  });

  it('answers a new copy every time', () => {
    const first = listContentStudioAIProviders();
    first[0].displayName = 'changed';
    first[0].credentialFields.length = 0;
    expect(listContentStudioAIProviders()[0]).toMatchObject({
      displayName: 'OpenAI',
      credentialFields: [{ name: 'apiKey' }],
    });
  });
});

describe('Content Studio AI provider catalog: models', () => {
  const ids = (provider: string) =>
    getContentStudioAIProvider(provider)?.models.map((model) => model.id);

  it('MC1 lists the curated OpenAI models', () => {
    expect(getContentStudioAIProvider('openai')?.models).toEqual([
      {
        id: 'gpt-6.1-sol',
        label: 'GPT-6.1 Sol',
        capabilities: { text: true, structuredOutput: true },
      },
      {
        id: 'gpt-6-luna',
        label: 'GPT-6 Luna',
        capabilities: { text: true, structuredOutput: true },
      },
    ]);
  });

  it('MC2 lists the curated OpenRouter models', () => {
    expect(getContentStudioAIProvider('openrouter')?.models).toEqual([
      {
        id: 'openai/gpt-6.1-sol',
        label: 'GPT-6.1 Sol (OpenAI)',
        capabilities: { text: true, structuredOutput: true },
      },
      {
        id: 'google/gemini-3.8-flash',
        label: 'Gemini 3.8 Flash (Google)',
        capabilities: { text: true, structuredOutput: true },
      },
      {
        id: 'openai/gpt-6-luna',
        label: 'GPT-6 Luna (OpenAI)',
        capabilities: { text: true, structuredOutput: false },
      },
    ]);
  });

  it('MC3/MC10 gives each provider a default model of its own list', () => {
    expect(getContentStudioAIDefaultModel('openai')).toBe('gpt-6.1-sol');
    expect(getContentStudioAIDefaultModel('openrouter')).toBe(
      'openai/gpt-6.1-sol'
    );
    for (const info of listContentStudioAIProviders()) {
      expect(info.defaultModel).toBe(
        getContentStudioAIDefaultModel(info.provider)
      );
      expect(ids(info.provider)).toContain(info.defaultModel);
    }
  });

  it('MC4 has unique ids within a provider and a small list', () => {
    for (const provider of CONTENT_STUDIO_AI_PROVIDERS) {
      const list = ids(provider) as string[];
      expect(new Set(list).size).toBe(list.length);
      expect(list.length).toBeGreaterThanOrEqual(2);
      expect(list.length).toBeLessThanOrEqual(4);
    }
  });

  it('MC5-MC8/MC12 models are plain metadata: no price, endpoint, limit or SDK detail', () => {
    for (const info of listContentStudioAIProviders()) {
      for (const model of info.models) {
        expect(Object.keys(model)).toEqual(['id', 'label', 'capabilities']);
        expect(Object.keys(model.capabilities)).toEqual([
          'text',
          'structuredOutput',
        ]);
        expect(model.capabilities.text).toBe(true);
        expect(typeof model.capabilities.structuredOutput).toBe('boolean');
        expect(model.id).toMatch(/^[a-z0-9][a-z0-9./-]*$/);
      }
    }
    expect(JSON.stringify(listContentStudioAIProviders())).not.toMatch(
      /price|pricing|cost|credit|token|context|baseURL|https?:|endpoint|chat\.completions|responses|sdk/i
    );
  });

  it('MC9 lists Claude models under Anthropic only', () => {
    for (const provider of ['openai', 'openrouter']) {
      expect(JSON.stringify(getContentStudioAIProvider(provider))).not.toMatch(
        /anthropic|claude/i
      );
    }
  });

  it.each([
    ['openai', 'gpt-6.1-sol', true],
    ['openai', 'gpt-6-luna', true],
    ['openrouter', 'openai/gpt-6.1-sol', true],
    ['openrouter', 'google/gemini-3.8-flash', true],
    ['openrouter', 'openai/gpt-6-luna', true],
    // MC11: a model belongs to the provider it is listed under
    ['openai', 'openai/gpt-6.1-sol', false],
    ['openrouter', 'gpt-6.1-sol', false],
    ['openai', 'google/gemini-3.8-flash', false],
    // MC10: anything that is not exactly a listed id
    ['openai', 'GPT-6.1-SOL', false],
    ['openai', ' gpt-6.1-sol', false],
    ['openai', 'gpt-6.1-sol-latest', false],
    ['openai', 'gpt-4o', false],
    ['openai', '', false],
    ['openai', 'constructor', false],
    ['openai', '__proto__', false],
    ['openai', null, false],
    ['openai', ['gpt-6.1-sol'], false],
    ['anthropic', 'claude-opus-5-5', true],
    ['anthropic', 'claude-sonnet-5-5', true],
    ['anthropic', 'claude-haiku-4-5-20251001', true],
    // AC7: anything that is not exactly an Anthropic catalog id
    ['anthropic', 'claude-opus-5', false],
    ['anthropic', 'claude-fable-5-1', false],
    ['anthropic', 'claude-opus-5-5-latest', false],
    ['anthropic', 'Claude-Opus-5-5', false],
    ['anthropic', 'anthropic/claude-opus-5-5', false],
    ['anthropic', 'anthropic.claude-opus-5-5', false],
    // AC8/AC9: OpenAI and OpenRouter ids are not Anthropic ids, and back
    ['anthropic', 'gpt-6.1-sol', false],
    ['anthropic', 'openai/gpt-6.1-sol', false],
    ['anthropic', 'google/gemini-3.8-flash', false],
    ['openai', 'claude-opus-5-5', false],
    ['openrouter', 'claude-opus-5-5', false],
    ['__proto__', 'gpt-6.1-sol', false],
  ])('MC10/MC11 %s supports %p: %s', (provider, model, supported) => {
    expect(isContentStudioAIModelSupported(provider, model)).toBe(supported);
    expect(getContentStudioAIModel(provider, model) !== undefined).toBe(
      supported
    );
  });

  it('MC13 answers new copies of providers and models', () => {
    const provider = getContentStudioAIProvider('openai');
    const model = getContentStudioAIModel('openai', 'gpt-6-luna');
    if (!provider || !model) {
      throw new Error('expected the catalog entries');
    }
    provider.models[0].capabilities.structuredOutput = false;
    provider.models.length = 0;
    provider.defaultModel = 'changed';
    model.id = 'changed';
    model.capabilities.structuredOutput = false;
    const listed = listContentStudioAIProviders();
    listed[1].models[0].label = 'changed';

    expect(getContentStudioAIProvider('openai')?.defaultModel).toBe(
      'gpt-6.1-sol'
    );
    expect(getContentStudioAIModel('openai', 'gpt-6-luna')).toEqual({
      id: 'gpt-6-luna',
      label: 'GPT-6 Luna',
      capabilities: { text: true, structuredOutput: true },
    });
    expect(getContentStudioAIProvider('openai')?.models).toHaveLength(2);
    expect(listContentStudioAIProviders()[1].models[0].label).toBe(
      'GPT-6.1 Sol (OpenAI)'
    );
  });
});

describe('Content Studio AI provider catalog: Anthropic', () => {
  it('AC3/AC6 lists the curated Claude models, none with JSON output yet', () => {
    expect(getContentStudioAIProvider('anthropic')?.models).toEqual([
      {
        id: 'claude-opus-5-5',
        label: 'Claude Opus 5.5',
        capabilities: { text: true, structuredOutput: false },
      },
      {
        id: 'claude-sonnet-5-5',
        label: 'Claude Sonnet 5.5',
        capabilities: { text: true, structuredOutput: false },
      },
      {
        id: 'claude-haiku-4-5-20251001',
        label: 'Claude Haiku 4.5',
        capabilities: { text: true, structuredOutput: false },
      },
    ]);
  });

  it('AC4/AC5 defaults to Claude Opus 5.5, one of its unique models', () => {
    const anthropic = getContentStudioAIProvider('anthropic');
    const ids = anthropic?.models.map((model) => model.id) || [];
    expect(getContentStudioAIDefaultModel('anthropic')).toBe(
      'claude-sonnet-5-5'
    );
    expect(anthropic?.defaultModel).toBe('claude-sonnet-5-5');
    expect(ids).toContain(anthropic?.defaultModel);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('AC10-AC12 has no price, URL, environment name or SDK detail', () => {
    expect(JSON.stringify(getContentStudioAIProvider('anthropic'))).not.toMatch(
      /price|pricing|cost|credit|token|https?:|api\.anthropic|ANTHROPIC_|env|sdk|messages\.create|output_config/i
    );
  });

  it('AC14 answers new copies', () => {
    const first = getContentStudioAIProvider('anthropic');
    if (!first) {
      throw new Error('expected Anthropic');
    }
    first.models[0].capabilities.structuredOutput = true;
    first.defaultModel = 'changed';
    first.models.length = 0;
    expect(getContentStudioAIProvider('anthropic')?.defaultModel).toBe(
      'claude-sonnet-5-5'
    );
    expect(
      getContentStudioAIModel('anthropic', 'claude-opus-5-5')?.capabilities
    ).toEqual({ text: true, structuredOutput: false });
    expect(listContentStudioAIProviders()[2].models).toHaveLength(3);
  });

  it('parses an Anthropic credential with the same exact API key rules', () => {
    expect(
      parseContentStudioAICredential('anthropic', { apiKey: MARKER })
    ).toEqual({ apiKey: MARKER });
    for (const input of [
      { apiKey: `${MARKER} ` },
      { apiKey: ` ${MARKER}` },
      { apiKey: MARKER, baseURL: 'https://x.test' },
      { apiKey: MARKER, authToken: MARKER },
      { apiKey: 'short' },
      {},
    ]) {
      const err = refusal('anthropic', input);
      expect((err as ContentStudioAICredentialError).code).toBe('INVALID');
      expect(rendered(err)).not.toContain(MARKER);
    }
  });
});
