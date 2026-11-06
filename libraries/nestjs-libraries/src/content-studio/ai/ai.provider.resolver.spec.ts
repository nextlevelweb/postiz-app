import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import {
  createSecretBox,
  SecretBox,
} from '@gitroom/nestjs-libraries/services/secret.box';
import { openContentStudioAICredential } from '@gitroom/nestjs-libraries/content-studio/ai/ai.credential';
import { ContentStudioAIResolutionError } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import { ContentStudioAIProviderResolver } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.resolver';
import { createOpenAIProviderAdapter } from '@gitroom/nestjs-libraries/content-studio/ai/providers/openai.provider';
import { createOpenRouterProviderAdapter } from '@gitroom/nestjs-libraries/content-studio/ai/providers/openrouter.provider';
import { createAnthropicProviderAdapter } from '@gitroom/nestjs-libraries/content-studio/ai/providers/anthropic.provider';
import { ContentStudioAIConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.repository';
import { ContentStudioAIProviderGate } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.gate';

// the servers' provider gate: Codex on, as before the gate (Review 20); a
// test that needs it off sets another one before its setup
let gate = new ContentStudioAIProviderGate({ codex: true });
beforeEach(() => {
  gate = new ContentStudioAIProviderGate({ codex: true });
});

// No database and no provider: the repository is mocked, the credential
// wrapper and SecretBox run for real on a test keyring (null: not
// configured), and spies wrap the credential open and both adapter factories
// so the tests see what each step was given
const mockKeyring: { box: SecretBox | null } = { box: null };
jest.mock('@gitroom/nestjs-libraries/services/secret.box', () => {
  const actual = jest.requireActual(
    '@gitroom/nestjs-libraries/services/secret.box'
  );
  const current = (): SecretBox => {
    if (!mockKeyring.box) {
      throw new actual.SecretBoxError('NOT_CONFIGURED');
    }
    return mockKeyring.box;
  };
  return {
    ...actual,
    secretBox: {
      seal: (plaintext: string, context: string) =>
        current().seal(plaintext, context),
      open: (envelope: string, context: string) =>
        current().open(envelope, context),
      needsRotation: (envelope: string) => current().needsRotation(envelope),
    },
  };
});
jest.mock('@gitroom/nestjs-libraries/content-studio/ai/ai.credential', () => ({
  ...jest.requireActual(
    '@gitroom/nestjs-libraries/content-studio/ai/ai.credential'
  ),
  openContentStudioAICredential: jest.fn(),
}));
jest.mock(
  '@gitroom/nestjs-libraries/content-studio/ai/providers/openai.provider',
  () => ({
    ...jest.requireActual(
      '@gitroom/nestjs-libraries/content-studio/ai/providers/openai.provider'
    ),
    createOpenAIProviderAdapter: jest.fn(),
  })
);
jest.mock(
  '@gitroom/nestjs-libraries/content-studio/ai/providers/openrouter.provider',
  () => ({
    ...jest.requireActual(
      '@gitroom/nestjs-libraries/content-studio/ai/providers/openrouter.provider'
    ),
    createOpenRouterProviderAdapter: jest.fn(),
  })
);
jest.mock(
  '@gitroom/nestjs-libraries/content-studio/ai/providers/anthropic.provider',
  () => ({
    ...jest.requireActual(
      '@gitroom/nestjs-libraries/content-studio/ai/providers/anthropic.provider'
    ),
    createAnthropicProviderAdapter: jest.fn(),
  })
);

const actualCredential = jest.requireActual(
  '@gitroom/nestjs-libraries/content-studio/ai/ai.credential'
);
const actualOpenAI = jest.requireActual(
  '@gitroom/nestjs-libraries/content-studio/ai/providers/openai.provider'
);
const actualOpenRouter = jest.requireActual(
  '@gitroom/nestjs-libraries/content-studio/ai/providers/openrouter.provider'
);
const actualAnthropic = jest.requireActual(
  '@gitroom/nestjs-libraries/content-studio/ai/providers/anthropic.provider'
);
const open = jest.mocked(openContentStudioAICredential);
const openAIFactory = jest.mocked(createOpenAIProviderAdapter);
const openRouterFactory = jest.mocked(createOpenRouterProviderAdapter);
const anthropicFactory = jest.mocked(createAnthropicProviderAdapter);

const MARKER = 'sk-content-studio-test-secret-123';
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';

const sealed = (provider = 'openai', organizationId = ORG, connectionId = ID) =>
  actualCredential.sealContentStudioAICredential({
    organizationId,
    connectionId,
    provider,
    credential: { apiKey: MARKER },
  });

// The resolver read: the repository filters on organization and leaves
// archived connections out, so anything else reads as null
const setup = (overrides: Record<string, unknown> = {}) => {
  const row = {
    id: ID,
    provider: 'openai',
    sealedCredential: sealed(),
    disabledAt: null,
    ...overrides,
  };
  const repository = {
    getSealedCredentialForResolver: jest.fn(
      async (organizationId: string, id: string) =>
        organizationId === ORG && id === ID ? row : null
    ),
  };
  const resolver = new ContentStudioAIProviderResolver(
    repository as unknown as ContentStudioAIConnectionRepository,
    gate
  );
  return { repository, resolver };
};

const resolutionError = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ContentStudioAIResolutionError);
  expect(
    [String(err), JSON.stringify(err), inspect(err, { showHidden: true })].join(
      '\n'
    )
  ).not.toMatch(/sk-content-studio|sb1\./);
  return (err as ContentStudioAIResolutionError).code;
};

const factoriesUnused = () => {
  expect(openAIFactory).not.toHaveBeenCalled();
  expect(openRouterFactory).not.toHaveBeenCalled();
  expect(anthropicFactory).not.toHaveBeenCalled();
};

beforeEach(() => {
  mockKeyring.box = createSecretBox({
    keys: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
    activeKey: 'k1',
  });
  open.mockImplementation(actualCredential.openContentStudioAICredential);
  openAIFactory.mockImplementation(actualOpenAI.createOpenAIProviderAdapter);
  openRouterFactory.mockImplementation(
    actualOpenRouter.createOpenRouterProviderAdapter
  );
  anthropicFactory.mockImplementation(
    actualAnthropic.createAnthropicProviderAdapter
  );
});

// Codex has no key: its credential is the empty object
const sealedCodex = () =>
  actualCredential.sealContentStudioAICredential({
    organizationId: ORG,
    connectionId: ID,
    provider: 'codex',
    credential: {},
  });

describe('ContentStudioAIProviderResolver: Codex gate (Review 20)', () => {
  it('CG1 refuses a stored Codex connection while the gate is off, before its credential is opened', async () => {
    gate = new ContentStudioAIProviderGate({ codex: false });
    const { resolver } = setup({
      provider: 'codex',
      sealedCredential: sealedCodex(),
    });
    open.mockClear();
    expect(
      await resolutionError(
        resolver.resolve({ organizationId: ORG, connectionId: ID })
      )
    ).toBe('PROVIDER_UNSUPPORTED');
    expect(open).not.toHaveBeenCalled();
    factoriesUnused();
  });

  it('CG2 resolves Codex when switched on, and every other provider either way', async () => {
    for (const codex of [false, true]) {
      gate = new ContentStudioAIProviderGate({ codex });
      const { resolver } = setup();
      expect(
        (await resolver.resolve({ organizationId: ORG, connectionId: ID }))
          .provider
      ).toBe('openai');
    }
    gate = new ContentStudioAIProviderGate({ codex: true });
    const { resolver } = setup({
      provider: 'codex',
      sealedCredential: sealedCodex(),
    });
    expect(
      (await resolver.resolve({ organizationId: ORG, connectionId: ID }))
        .provider
    ).toBe('codex');
  });
});

describe('ContentStudioAIProviderResolver', () => {
  it('RSL1/RSL13 resolves an active OpenAI connection of the organization', async () => {
    const { repository, resolver } = setup();
    const resolved = await resolver.resolve({
      organizationId: ORG,
      connectionId: ID,
    });

    expect(repository.getSealedCredentialForResolver).toHaveBeenCalledWith(
      ORG,
      ID
    );
    expect(open).toHaveBeenCalledWith({
      organizationId: ORG,
      connectionId: ID,
      provider: 'openai',
      envelope: expect.stringMatching(/^sb1\.k1\./),
    });
    // the factory gets the opened credential and nothing else
    expect(openAIFactory.mock.calls).toEqual([[{ apiKey: MARKER }]]);
    expect(openRouterFactory).not.toHaveBeenCalled();
    expect(resolved.connectionId).toBe(ID);
    expect(resolved.provider).toBe('openai');
    expect(resolved.adapter).toBe(openAIFactory.mock.results[0].value);
    expect(resolved.adapter.provider).toBe('openai');
  });

  it('RSL2 resolves an active OpenRouter connection with the OpenRouter adapter', async () => {
    const { resolver } = setup({
      provider: 'openrouter',
      sealedCredential: sealed('openrouter'),
    });
    const resolved = await resolver.resolve({
      organizationId: ORG,
      connectionId: ID,
    });
    expect(openRouterFactory.mock.calls).toEqual([[{ apiKey: MARKER }]]);
    expect(openAIFactory).not.toHaveBeenCalled();
    expect(resolved.provider).toBe('openrouter');
    expect(resolved.adapter.provider).toBe('openrouter');
  });

  it('RSL3/RSL4/RSL5 reads missing, foreign and archived connections as not found', async () => {
    const { repository, resolver } = setup();
    for (const [organizationId, connectionId] of [
      [ORG, OTHER_ID],
      [OTHER_ORG, ID],
    ]) {
      expect(
        await resolutionError(
          resolver.resolve({ organizationId, connectionId })
        )
      ).toBe('NOT_FOUND');
    }
    expect(repository.getSealedCredentialForResolver.mock.calls).toEqual([
      [ORG, OTHER_ID],
      [OTHER_ORG, ID],
    ]);
    expect(open).not.toHaveBeenCalled();
    factoriesUnused();
  });

  it.each([
    [ORG, 'not-a-uuid'],
    [ORG, ID.toUpperCase().replace(/3/g, 'A')],
    ['org-a', ID],
    [ORG, ''],
  ])(
    'answers not found for malformed ids %s / %s without a query',
    async (organizationId, connectionId) => {
      const { repository, resolver } = setup();
      expect(
        await resolutionError(
          resolver.resolve({ organizationId, connectionId })
        )
      ).toBe('NOT_FOUND');
      expect(repository.getSealedCredentialForResolver).not.toHaveBeenCalled();
    }
  );

  it('RSL6 refuses a disabled connection before opening the credential or making an adapter', async () => {
    const { resolver } = setup({ disabledAt: new Date() });
    expect(
      await resolutionError(
        resolver.resolve({ organizationId: ORG, connectionId: ID })
      )
    ).toBe('DISABLED');
    expect(open).not.toHaveBeenCalled();
    factoriesUnused();
  });

  it('RSL7 refuses a connection without a credential', async () => {
    const { resolver } = setup({ sealedCredential: null });
    expect(
      await resolutionError(
        resolver.resolve({ organizationId: ORG, connectionId: ID })
      )
    ).toBe('CREDENTIAL_INVALID');
    expect(open).not.toHaveBeenCalled();
    factoriesUnused();
  });

  it('RSL8 maps a SecretBox without keyring to SECRET_STORE_UNAVAILABLE', async () => {
    const { resolver } = setup();
    mockKeyring.box = null;
    expect(
      await resolutionError(
        resolver.resolve({ organizationId: ORG, connectionId: ID })
      )
    ).toBe('SECRET_STORE_UNAVAILABLE');
    factoriesUnused();
  });

  it.each([
    ['sealed for another connection', () => sealed('openai', ORG, OTHER_ID)],
    ['sealed for another organization', () => sealed('openai', OTHER_ORG, ID)],
    ['tampered', () => `${sealed().slice(0, -4)}AAAA`],
    ['not an envelope', () => MARKER],
  ])(
    'RSL9 maps a credential %s to CREDENTIAL_INVALID',
    async (_name, envelope) => {
      const { resolver } = setup({ sealedCredential: envelope() });
      expect(
        await resolutionError(
          resolver.resolve({ organizationId: ORG, connectionId: ID })
        )
      ).toBe('CREDENTIAL_INVALID');
      factoriesUnused();
    }
  );

  it.each([['mistral'], ['Anthropic'], ['OpenAI'], [''], ['constructor']])(
    'RSL10/RSL12 refuses stored provider %p without any default adapter',
    async (provider) => {
      const { resolver } = setup({ provider });
      expect(
        await resolutionError(
          resolver.resolve({ organizationId: ORG, connectionId: ID })
        )
      ).toBe('PROVIDER_UNSUPPORTED');
      expect(open).not.toHaveBeenCalled();
      factoriesUnused();
    }
  );

  it('RSL11 never falls back to an environment key or a default connection', async () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, {
        OPENAI_API_KEY: 'sk-from-the-environment-0000000000',
        OPENROUTER_API_KEY: 'sk-or-from-the-environment-000000',
      });
      const { repository, resolver } = setup();
      repository.getSealedCredentialForResolver.mockResolvedValue(null);
      expect(
        await resolutionError(
          resolver.resolve({ organizationId: ORG, connectionId: ID })
        )
      ).toBe('NOT_FOUND');
      factoriesUnused();
    } finally {
      process.env = saved;
    }
  });

  it('RSL14 returns no key or envelope', async () => {
    const { resolver } = setup();
    const resolved = await resolver.resolve({
      organizationId: ORG,
      connectionId: ID,
    });
    expect(Object.keys(resolved).sort()).toEqual([
      'adapter',
      'connectionId',
      'provider',
    ]);
    expect(
      [
        JSON.stringify(resolved),
        inspect(resolved, { depth: 10, showHidden: true }),
      ].join('\n')
    ).not.toMatch(/sk-content-studio|sb1\./);
  });

  it('RSL15/RSL16 opens the credential and makes a new adapter on every resolve', async () => {
    const { repository, resolver } = setup();
    const first = await resolver.resolve({
      organizationId: ORG,
      connectionId: ID,
    });
    const second = await resolver.resolve({
      organizationId: ORG,
      connectionId: ID,
    });
    expect(repository.getSealedCredentialForResolver).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledTimes(2);
    expect(openAIFactory).toHaveBeenCalledTimes(2);
    expect(first.adapter).not.toBe(second.adapter);
    expect(first).not.toBe(second);
  });

  it('lets other errors through unchanged', async () => {
    const { repository, resolver } = setup();
    const failure = new Error('database down');
    repository.getSealedCredentialForResolver.mockRejectedValue(failure);
    await expect(
      resolver.resolve({ organizationId: ORG, connectionId: ID })
    ).rejects.toBe(failure);
  });
});

describe('ContentStudioAIProviderResolver source', () => {
  const text = fs
    .readFileSync(path.join(__dirname, 'ai.provider.resolver.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('has no environment, cache, SDK, logging or default provider', () => {
    expect(text).not.toMatch(
      /process\.|console\.|Logger|from 'openai'|@anthropic-ai|new Map|WeakMap|\bcache\b|static /
    );
    // the only default is the refusal
    expect(text).toMatch(
      /default:\n\s+throw new ContentStudioAIResolutionError\('PROVIDER_UNSUPPORTED'\);/
    );
  });
});

describe('ContentStudioAIProviderResolver: Anthropic', () => {
  const anthropicRow = (overrides: Record<string, unknown> = {}) =>
    setup({
      provider: 'anthropic',
      sealedCredential: sealed('anthropic'),
      ...overrides,
    });

  it('AR1-AR3 resolves an Anthropic connection with the Anthropic adapter only', async () => {
    const { repository, resolver } = anthropicRow();
    const resolved = await resolver.resolve({
      organizationId: ORG,
      connectionId: ID,
    });

    expect(repository.getSealedCredentialForResolver).toHaveBeenCalledWith(
      ORG,
      ID
    );
    expect(open).toHaveBeenCalledWith({
      organizationId: ORG,
      connectionId: ID,
      provider: 'anthropic',
      envelope: expect.stringMatching(/^sb1\.k1\./),
    });
    expect(anthropicFactory.mock.calls).toEqual([[{ apiKey: MARKER }]]);
    expect(openAIFactory).not.toHaveBeenCalled();
    expect(openRouterFactory).not.toHaveBeenCalled();
    expect(resolved.provider).toBe('anthropic');
    expect(resolved.adapter).toBe(anthropicFactory.mock.results[0].value);
    expect(resolved.adapter.provider).toBe('anthropic');
  });

  it('AR4 refuses a disabled Anthropic connection before opening it', async () => {
    const { resolver } = anthropicRow({ disabledAt: new Date() });
    expect(
      await resolutionError(
        resolver.resolve({ organizationId: ORG, connectionId: ID })
      )
    ).toBe('DISABLED');
    expect(open).not.toHaveBeenCalled();
    factoriesUnused();
  });

  it('AR5 reads a missing, foreign or archived Anthropic connection as not found', async () => {
    const { resolver } = anthropicRow();
    for (const [organizationId, connectionId] of [
      [ORG, OTHER_ID],
      [OTHER_ORG, ID],
    ]) {
      expect(
        await resolutionError(
          resolver.resolve({ organizationId, connectionId })
        )
      ).toBe('NOT_FOUND');
    }
    factoriesUnused();
  });

  it.each([
    ['tampered', () => `${sealed('anthropic').slice(0, -4)}AAAA`],
    ['sealed for another connection', () => sealed('anthropic', ORG, OTHER_ID)],
    ['missing', () => null],
  ])('AR6 maps a %s credential to CREDENTIAL_INVALID', async (_n, envelope) => {
    const { resolver } = anthropicRow({ sealedCredential: envelope() });
    expect(
      await resolutionError(
        resolver.resolve({ organizationId: ORG, connectionId: ID })
      )
    ).toBe('CREDENTIAL_INVALID');
    factoriesUnused();
  });

  it('AR7 never uses an Anthropic key or token from the environment', async () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, {
        ANTHROPIC_API_KEY: 'sk-ant-from-the-environment-000000',
        ANTHROPIC_AUTH_TOKEN: 'token-from-the-environment',
      });
      const { repository, resolver } = anthropicRow();
      repository.getSealedCredentialForResolver.mockResolvedValue(null);
      expect(
        await resolutionError(
          resolver.resolve({ organizationId: ORG, connectionId: ID })
        )
      ).toBe('NOT_FOUND');
      factoriesUnused();
    } finally {
      process.env = saved;
    }
  });

  it('AR8/AR9 makes a new adapter on every resolve and returns no key', async () => {
    const { resolver } = anthropicRow();
    const first = await resolver.resolve({
      organizationId: ORG,
      connectionId: ID,
    });
    const second = await resolver.resolve({
      organizationId: ORG,
      connectionId: ID,
    });
    expect(anthropicFactory).toHaveBeenCalledTimes(2);
    expect(first.adapter).not.toBe(second.adapter);
    expect(
      [
        JSON.stringify(first),
        inspect(first, { depth: 10, showHidden: true }),
      ].join('\n')
    ).not.toMatch(/sk-content-studio|sb1\./);
  });

  it('AR10 still refuses a provider it does not know, Anthropic look-alikes included', async () => {
    for (const provider of ['anthropic ', 'claude', 'ANTHROPIC']) {
      const { resolver } = setup({ provider });
      expect(
        await resolutionError(
          resolver.resolve({ organizationId: ORG, connectionId: ID })
        )
      ).toBe('PROVIDER_UNSUPPORTED');
    }
    factoriesUnused();
  });
});
