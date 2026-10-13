import { inspect } from 'util';
import {
  AI_API_KEY_MAX,
  AI_API_KEY_MIN,
  CONTENT_STUDIO_AI_PROVIDERS,
  ContentStudioAICredentialError,
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
  it('PC1/PC2 supports openai and openrouter', () => {
    expect(CONTENT_STUDIO_AI_PROVIDERS).toEqual(['openai', 'openrouter']);
    expect(isContentStudioAIProvider('openai')).toBe(true);
    expect(isContentStudioAIProvider('openrouter')).toBe(true);
  });

  it.each([
    ['anthropic'],
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
    expect(rendered(refusal('anthropic', { apiKey: MARKER }))).not.toContain(
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
      '["openai","openrouter"]'
    );
  });
});

describe('Content Studio AI provider catalog: public metadata', () => {
  it('P1-P3 lists openai then openrouter with their display names', () => {
    expect(
      listContentStudioAIProviders().map(({ provider, displayName }) => [
        provider,
        displayName,
      ])
    ).toEqual([
      ['openai', 'OpenAI'],
      ['openrouter', 'OpenRouter'],
    ]);
  });

  it('P4/P5 describes the API key field only and no models yet', () => {
    for (const info of listContentStudioAIProviders()) {
      expect(info).toEqual({
        provider: info.provider,
        displayName: info.displayName,
        credentialFields: [
          { name: 'apiKey', label: 'API key', secret: true, required: true },
        ],
        models: [],
      });
    }
  });

  it('P6-P9/P11 is plain JSON with no endpoint, environment name, key or schema', () => {
    const json = JSON.stringify(listContentStudioAIProviders());
    expect(JSON.parse(json)).toEqual(listContentStudioAIProviders());
    expect(json).not.toMatch(
      /baseURL|baseUrl|https?:|api\.openai|openrouter\.ai|_API_KEY|process|env|sk-|AIza|example|placeholder|regex|min|max|_def|ZodObject|safeParse/i
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

  it('P10 has no Anthropic entry yet', () => {
    expect(
      listContentStudioAIProviders().map((info) => info.provider)
    ).not.toContain('anthropic');
    expect(JSON.stringify(listContentStudioAIProviders())).not.toMatch(
      /anthropic|claude/i
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
