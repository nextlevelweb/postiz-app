import fs from 'fs';
import path from 'path';
import { inspect } from 'util';
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioWritingProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.writing-profile.repository';
import { ContentStudioEditorialPolicyRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.repository';
import { ContentStudioAudienceProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.audience-profile.repository';
import { ContentStudioExpertiseProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.expertise-profile.repository';
import { ContentStudioAIOperationRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-operation.repository';
import { ContentStudioAIWritingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-writing.service';
import { ContentStudioAIExecutionService } from '@gitroom/nestjs-libraries/content-studio/ai/ai.execution.service';
import { ContentStudioAIProviderResolver } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.resolver';
import {
  ContentStudioAIProviderError,
  ContentStudioAIResolutionError,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import {
  ContentStudioAIProviderErrorCode,
  ContentStudioAITextResult,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';
import { hashContentStudioAIRequest } from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.hash';
import { parseContentStudioWritingProfileContent } from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';
import { parseContentStudioEditorialPolicyContent } from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy';
import { parseContentStudioAudienceProfileContent } from '@gitroom/nestjs-libraries/content-studio/editorial/audience.profile';
import { parseContentStudioExpertiseProfileContent } from '@gitroom/nestjs-libraries/content-studio/editorial/expertise.profile';
import { storedContentStudioWritingProfileContent } from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile.revision';
import { storedContentStudioEditorialPolicyContent } from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy.revision';
import { storedContentStudioAudienceProfileContent } from '@gitroom/nestjs-libraries/content-studio/editorial/audience.profile.revision';
import { storedContentStudioExpertiseProfileContent } from '@gitroom/nestjs-libraries/content-studio/editorial/expertise.profile.revision';

// No database and no provider. The package and profile repositories, the
// resolver, its adapter and the operation repository are mocks; the AI
// execution service is the real one, so every refusal is proven to happen
// before an operation exists, and every argument handed to persistence is
// searched for the texts that must never be stored
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, randomUUID: jest.fn() };
});

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const OTHER_CONNECTION = '48888888-8888-4888-8888-888888888888';
const PACKAGE = '55555555-5555-4555-8555-555555555555';
const OPERATION = '66666666-6666-4666-8666-666666666666';
const WRITING_ID = 'a1111111-1111-4111-8111-111111111111';
const AUDIENCE_ID = 'b1111111-1111-4111-8111-111111111111';
const EXPERTISE_ID = 'c1111111-1111-4111-8111-111111111111';
const POLICY_ID = 'd1111111-1111-4111-8111-111111111111';
const PREFIX = { writing: 'a', audience: 'b', expertise: 'c', policy: 'd' };
const revisionId = (kind: keyof typeof PREFIX, n: number) =>
  `${PREFIX[kind]}2222222-2222-4222-8222-${String(n).padStart(12, '0')}`;

const ITEM_MARKER = 'ITEM_PRIVATE_MARKER_456';
const PROFILE_MARKER = 'PROFILE_PRIVATE_MARKER_789';
const INSTRUCTION = 'INSTRUCTION_PRIVATE_MARKER_321 Mention the sale.';
const RESULT_MARKER = 'RESULT_PRIVATE_MARKER_654';
const KEY = 'sk-content-studio-test-secret-123';
// texts that may go to the provider but never to persistence or an error
const PRIVATE =
  /PRIVATE_MARKER|sk-content-studio|professional writing assistant|Spring sale|Calm and direct/;
const UUID_ANYWHERE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Valid profile content for the AI writing specs, each with its own marker
// so a test can tell where a text came from
const writingContent = (marker = 'WRITING_VOICE_MARKER') =>
  parseContentStudioWritingProfileContent({
    schemaVersion: 1,
    voice: `${marker} Calm and direct.`,
    toneTags: ['warm', 'clear'],
    perspective: 'first_plural',
    formatting: { emoji: 'sparing', hashtags: 'few', notes: 'Short lines.' },
    vocabulary: { prefer: ['customers'], avoid: ['users'] },
    dos: ['Use concrete examples'],
    donts: ['Overpromise'],
    examples: [{ text: 'We ship on Fridays.\nAlways.', note: 'Plain' }],
  });

const editorialContent = (marker = 'POLICY_MARKER') =>
  parseContentStudioEditorialPolicyContent({
    schemaVersion: 1,
    principles: [`${marker} Be accurate`],
    prohibitedTopics: ['Politics'],
    claimRules: ['No superlatives without proof'],
    ctaRules: ['One call to action'],
    formatConventions: ['Sentence case headings'],
    complianceNotes: 'Mention risks for financial products.',
  });

const audienceContent = (marker = 'AUDIENCE_MARKER') =>
  parseContentStudioAudienceProfileContent({
    schemaVersion: 1,
    description: `${marker} Small business owners`,
    role: 'Owner',
    knowledgeLevel: 'intermediate',
    goals: ['Save time'],
    painPoints: ['Too many tools'],
    objections: ['Price'],
    preferredTone: 'Friendly',
    locale: 'nl-NL',
  });

const expertiseContent = (marker = 'EXPERTISE_MARKER') =>
  parseContentStudioExpertiseProfileContent({
    schemaVersion: 1,
    subjects: [`${marker} Bookkeeping`],
    differentiators: ['Twenty years of practice'],
    stances: [{ topic: 'Automation', position: 'Automate the boring parts' }],
    frameworks: ['Jobs to be done'],
    evidenceExpectations: 'Cite public sources.',
    avoidTopics: ['Tax evasion'],
    confidenceBoundaries: 'No legal advice.',
  });

type Kind = 'writing' | 'audience' | 'expertise';
interface StoredRevision {
  id: string;
  revisionNumber: number;
  schemaVersion: number;
  content: string;
  contentHash: string;
}

const STORE = {
  writing: storedContentStudioWritingProfileContent,
  audience: storedContentStudioAudienceProfileContent,
  expertise: storedContentStudioExpertiseProfileContent,
  policy: storedContentStudioEditorialPolicyContent,
} as const;
const CONTENT = {
  writing: writingContent,
  audience: audienceContent,
  expertise: expertiseContent,
  policy: editorialContent,
} as const;
const stored = (kind: keyof typeof STORE, n: number, marker?: string) => ({
  id: revisionId(kind, n),
  revisionNumber: n,
  ...(
    STORE[kind] as (
      content: unknown
    ) => Omit<StoredRevision, 'id' | 'revisionNumber'>
  )(CONTENT[kind](marker ?? `${PROFILE_MARKER} ${kind} r${n}`)),
});

const draftOf = () => ({
  schemaVersion: 1,
  copy: {
    global: {
      thread: [
        { id: 'main', text: `${ITEM_MARKER} Spring sale`, mediaIds: ['m1'] },
        { id: 'f1', text: '', mediaIds: [] },
        { id: 'f2', text: 'Third post', mediaIds: ['m2', 'm3'] },
      ],
    },
  },
});

const providerResult = (
  text: string,
  overrides: Partial<ContentStudioAITextResult> = {}
): ContentStudioAITextResult => ({
  text,
  finishReason: 'stop',
  usage: { inputTokens: 100, outputTokens: 40 },
  providerRequestId: 'req_writing_1',
  ...overrides,
});
const threadAnswer = (items: Array<[string, string]>) =>
  JSON.stringify({
    items: items.map(([itemId, text]) => ({ itemId, text })),
  });
const VALID_THREAD = threadAnswer([
  ['main', `${RESULT_MARKER} one`],
  ['f1', 'two'],
  ['f2', 'three'],
]);

const profileRepository = (kind: Kind, id: string) => {
  const state = {
    row: { id, latestRevisionNumber: 4, archivedAt: null as Date | null },
    revisions: new Map<number, StoredRevision>([[4, stored(kind, 4)]]),
  };
  const repository = {
    getProfileForOrganization: jest.fn(
      async (organizationId: string, profileId: string) =>
        organizationId === ORG && profileId === state.row.id
          ? {
              ...state.row,
              name: `${PROFILE_MARKER} name`,
              createdAt: new Date(),
              updatedAt: new Date(),
            }
          : null
    ),
    getRevisionByNumber: jest.fn(
      async (organizationId: string, profileId: string, n: number) =>
        organizationId === ORG && profileId === state.row.id
          ? {
              ...(state.revisions.get(n) as StoredRevision),
              createdAt: new Date(),
            }
          : null
    ),
    // writes that must never happen here
    createProfileWithFirstRevision: jest.fn(),
    createRevisionWithCompareAndSwap: jest.fn(),
    updateProfileName: jest.fn(),
    archiveProfile: jest.fn(),
    restoreProfile: jest.fn(),
  };
  return { state, repository };
};

const setup = (provider: 'openai' | 'anthropic' = 'openai') => {
  const contentPackage = {
    id: PACKAGE,
    projectId: null,
    name: 'Spring',
    draft: JSON.stringify(draftOf()),
    draftVersion: 7,
    latestRevisionNumber: 2,
    archivedAt: null as Date | null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const packages = {
    getPackageForOrganization: jest.fn(
      async (organizationId: string, id: string) =>
        organizationId === ORG && id === PACKAGE ? { ...contentPackage } : null
    ),
    // writes that must never happen here
    saveDraftCompareAndSwap: jest.fn(),
    createRevisionWithCompareAndSwap: jest.fn(),
    updatePackageMetadata: jest.fn(),
    archivePackage: jest.fn(),
    restorePackage: jest.fn(),
    createPackage: jest.fn(),
  };
  const writing = profileRepository('writing', WRITING_ID);
  const audience = profileRepository('audience', AUDIENCE_ID);
  const expertise = profileRepository('expertise', EXPERTISE_ID);
  const policyState = {
    policy: { id: POLICY_ID, latestRevisionNumber: 2 } as {
      id: string;
      latestRevisionNumber: number;
    } | null,
    revisions: new Map<number, StoredRevision>([[2, stored('policy', 2)]]),
  };
  const policy = {
    getPolicyForOrganization: jest.fn(async (organizationId: string) =>
      organizationId === ORG && policyState.policy
        ? { ...policyState.policy }
        : null
    ),
    getRevisionByNumber: jest.fn(
      async (organizationId: string, policyId: string, n: number) =>
        organizationId === ORG && policyId === POLICY_ID
          ? {
              ...(policyState.revisions.get(n) as StoredRevision),
              createdAt: new Date(),
            }
          : null
    ),
    createPolicyWithFirstRevision: jest.fn(),
    createRevisionWithCompareAndSwap: jest.fn(),
  };

  const adapter = {
    provider,
    validateConnection: jest.fn(),
    generateText: jest.fn(async () =>
      providerResult(`${RESULT_MARKER} A brighter spring.`)
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
    createRunningOperation: jest.fn(async () => ({ id: OPERATION })),
    completeSucceededWithUsage: jest.fn(async () => ({ completed: true })),
    completeFailedWithUsage: jest.fn(async () => ({ completed: true })),
    getOperationForOrganization: jest.fn(),
  };
  const execution = new ContentStudioAIExecutionService(
    packages as unknown as ContentStudioRepository,
    resolver as unknown as ContentStudioAIProviderResolver,
    operations as unknown as ContentStudioAIOperationRepository
  );
  const executeSpy = jest.spyOn(execution, 'execute');
  const service = new ContentStudioAIWritingService(
    packages as unknown as ContentStudioRepository,
    writing.repository as unknown as ContentStudioWritingProfileRepository,
    policy as unknown as ContentStudioEditorialPolicyRepository,
    audience.repository as unknown as ContentStudioAudienceProfileRepository,
    expertise.repository as unknown as ContentStudioExpertiseProfileRepository,
    execution
  );
  return {
    service,
    packages,
    contentPackage,
    writing,
    audience,
    expertise,
    policy,
    policyState,
    adapter,
    resolver,
    operations,
    executeSpy,
  };
};
type Context = ReturnType<typeof setup>;

const itemInput = (
  overrides: Record<string, unknown> = {},
  selection: Record<string, unknown> = {}
) => ({
  organizationId: ORG,
  userId: USER,
  packageId: PACKAGE,
  operation: 'rewrite_item',
  itemId: 'main',
  ...overrides,
  selection: {
    connectionId: CONNECTION,
    model: 'gpt-6.1-sol',
    baseDraftVersion: 7,
    ...selection,
  },
});
const threadInput = (
  overrides: Record<string, unknown> = {},
  selection: Record<string, unknown> = {}
) => {
  const { itemId: _itemId, ...rest } = itemInput(
    { operation: 'generate_thread', ...overrides },
    selection
  );
  return rest;
};
const ALL_PROFILES = {
  writingProfileId: WRITING_ID,
  editorialPolicy: true,
  audienceProfileId: AUDIENCE_ID,
  expertiseProfileId: EXPERTISE_ID,
};

// every argument handed to the operation repository, BigInt included
const persisted = (ctx: Context) =>
  inspect(
    Object.values(ctx.operations).map((fn) => fn.mock.calls),
    { depth: 20 }
  );
const operationWrites = (ctx: Context) =>
  [
    ctx.operations.createRunningOperation,
    ctx.operations.completeSucceededWithUsage,
    ctx.operations.completeFailedWithUsage,
  ].flatMap((fn) => fn.mock.calls);
const created = (ctx: Context) =>
  (
    ctx.operations.createRunningOperation.mock.calls[0] as unknown as [
      Record<string, any>
    ]
  )[0];
const sentRequest = (ctx: Context) =>
  (
    ctx.adapter.generateText.mock.calls[0] as unknown as [
      {
        system: string;
        prompt: string;
        model: string;
        output: unknown;
        maxOutputTokens: number;
      }
    ]
  )[0];
// nothing ran: no operation row, no provider call
const nothingRan = (ctx: Context) => {
  expect(ctx.adapter.generateText).not.toHaveBeenCalled();
  expect(operationWrites(ctx)).toEqual([]);
};
// no write of a draft, revision, profile or policy, whatever happened
const noDraftOrProfileWrite = (ctx: Context) => {
  for (const repository of [
    ctx.packages,
    ctx.writing.repository,
    ctx.audience.repository,
    ctx.expertise.repository,
    ctx.policy,
  ]) {
    for (const [name, fn] of Object.entries(repository)) {
      if (!/^get/.test(name)) {
        expect([name, (fn as jest.Mock).mock.calls]).toEqual([name, []]);
      }
    }
  }
};

const refusal = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(HttpException);
  const response = (err as HttpException).getResponse() as {
    code: string;
    msg: string;
  };
  expect(
    [String(err), JSON.stringify(response), inspect(err)].join('\n')
  ).not.toMatch(PRIVATE);
  expect(JSON.stringify(response)).not.toMatch(UUID_ANYWHERE);
  expect(Object.keys(response).sort()).toEqual(['code', 'msg']);
  return { status: (err as HttpException).getStatus(), ...response };
};

beforeEach(() => {
  jest.mocked(randomUUID).mockImplementation(() => OPERATION);
});

describe('ContentStudioAIWritingService: preflight', () => {
  it('BW1/BW2 lets any member generate: no role, membership or plan is looked at', async () => {
    const ctx = setup();
    await expect(ctx.service.proposeItem(itemInput())).resolves.toMatchObject({
      operationId: OPERATION,
    });
    expect(ctx.adapter.generateText).toHaveBeenCalledTimes(1);
  });

  it('BW3/BW4 reads the package of the request organization only; another is missing, with no operation', async () => {
    const ctx = setup();
    for (const input of [
      itemInput({ organizationId: OTHER_ORG }),
      itemInput({ packageId: '57777777-7777-4777-8777-777777777777' }),
    ]) {
      expect(await refusal(ctx.service.proposeItem(input))).toEqual({
        status: 404,
        code: 'CS_NOT_FOUND',
        msg: 'Content Studio item not found',
      });
    }
    expect(ctx.packages.getPackageForOrganization.mock.calls).toEqual([
      [OTHER_ORG, PACKAGE],
      [ORG, '57777777-7777-4777-8777-777777777777'],
    ]);
    nothingRan(ctx);
  });

  it('answers 404 for a malformed package id without a lookup', async () => {
    const ctx = setup();
    expect(
      (
        await refusal(
          ctx.service.proposeItem(itemInput({ packageId: 'pkg-1' }))
        )
      ).status
    ).toBe(404);
    expect(ctx.packages.getPackageForOrganization).not.toHaveBeenCalled();
    nothingRan(ctx);
  });

  it('BW5 refuses an archived package', async () => {
    const ctx = setup();
    ctx.contentPackage.archivedAt = new Date();
    expect(
      await refusal(ctx.service.proposeThread(threadInput()))
    ).toMatchObject({
      status: 409,
      code: 'CS_PACKAGE_ARCHIVED',
    });
    nothingRan(ctx);
  });

  it('BW6 refuses a stale draft version before any profile, connection or provider', async () => {
    const ctx = setup();
    for (const baseDraftVersion of [6, 8]) {
      expect(
        await refusal(
          ctx.service.proposeItem(
            itemInput({}, { baseDraftVersion, ...ALL_PROFILES })
          )
        )
      ).toMatchObject({ status: 409, code: 'CS_DRAFT_VERSION_CONFLICT' });
    }
    expect(
      ctx.writing.repository.getProfileForOrganization
    ).not.toHaveBeenCalled();
    expect(ctx.resolver.resolve).not.toHaveBeenCalled();
    nothingRan(ctx);
  });

  it('BW7 answers 404 for an item that is not in the current draft', async () => {
    const ctx = setup();
    expect(
      await refusal(ctx.service.proposeItem(itemInput({ itemId: 'gone' })))
    ).toEqual({
      status: 404,
      code: 'CS_NOT_FOUND',
      msg: 'Content item not found.',
    });
    nothingRan(ctx);
  });

  it.each([
    ['BW8', 'rewrite_item'],
    ['BW9', 'shorten_item'],
    ['BW10', 'expand_item'],
    ['change_tone', 'change_tone'],
  ])('%s refuses %s on an empty item', async (_n, operation) => {
    const ctx = setup();
    expect(
      await refusal(
        ctx.service.proposeItem(
          itemInput({ operation, itemId: 'f1' }, { instruction: 'Playful' })
        )
      )
    ).toEqual({
      status: 400,
      code: 'CS_INVALID_REQUEST',
      msg: 'This AI action requires existing item text.',
    });
    nothingRan(ctx);
  });

  it('refuses a whitespace-only item for rewrite', async () => {
    const ctx = setup();
    const draft = draftOf();
    draft.copy.global.thread[1].text = ' \n\t ';
    ctx.contentPackage.draft = JSON.stringify(draft);
    expect(
      (await refusal(ctx.service.proposeItem(itemInput({ itemId: 'f1' })))).code
    ).toBe('CS_INVALID_REQUEST');
    nothingRan(ctx);
  });

  it.each([[undefined], [null], [''], [' \r\n ']])(
    'BW11 change_tone needs a tone, not %p',
    async (instruction) => {
      const ctx = setup();
      expect(
        await refusal(
          ctx.service.proposeItem(
            itemInput({ operation: 'change_tone' }, { instruction })
          )
        )
      ).toEqual({
        status: 400,
        code: 'CS_INVALID_REQUEST',
        msg: 'Changing the tone needs a tone.',
      });
      expect(ctx.packages.getPackageForOrganization).not.toHaveBeenCalled();
      nothingRan(ctx);
    }
  );

  it('BW12 generate_item may start from an empty item', async () => {
    const ctx = setup();
    const value = await ctx.service.proposeItem(
      itemInput({ operation: 'generate_item', itemId: 'f1' })
    );
    expect(value.proposal).toEqual({
      type: 'item',
      itemId: 'f1',
      text: `${RESULT_MARKER} A brighter spring.`,
    });
  });

  it('BW13/M25 a connection of another organization is not found, with no operation and no other connection tried', async () => {
    const ctx = setup();
    expect(
      await refusal(
        ctx.service.proposeItem(
          itemInput({}, { connectionId: OTHER_CONNECTION })
        )
      )
    ).toEqual({
      status: 400,
      code: 'CS_AI_CONNECTION_REQUIRED',
      msg: 'Select an available AI connection.',
    });
    expect(ctx.resolver.resolve.mock.calls).toEqual([
      [{ organizationId: ORG, connectionId: OTHER_CONNECTION }],
    ]);
    nothingRan(ctx);
  });

  it.each([
    ['BW14 DISABLED', 'DISABLED', 409, 'CS_AI_CONNECTION_DISABLED'],
    [
      'CREDENTIAL_INVALID',
      'CREDENTIAL_INVALID',
      409,
      'CS_AI_CONNECTION_CREDENTIAL_INVALID',
    ],
    [
      'SECRET_STORE_UNAVAILABLE',
      'SECRET_STORE_UNAVAILABLE',
      503,
      'CS_AI_SECRET_STORE_UNAVAILABLE',
    ],
    [
      'PROVIDER_UNSUPPORTED',
      'PROVIDER_UNSUPPORTED',
      400,
      'CS_AI_PROVIDER_UNSUPPORTED',
    ],
  ] as const)(
    '%s connection: %s, no operation',
    async (_n, code, status, csCode) => {
      const ctx = setup();
      ctx.resolver.resolve.mockRejectedValueOnce(
        new ContentStudioAIResolutionError(code)
      );
      expect(await refusal(ctx.service.proposeItem(itemInput()))).toMatchObject(
        {
          status,
          code: csCode,
        }
      );
      expect(ctx.resolver.resolve).toHaveBeenCalledTimes(1);
      nothingRan(ctx);
    }
  );

  it.each([
    ['openai', 'claude-opus-5-5'],
    ['openai', 'gpt-5'],
    ['anthropic', 'gpt-6.1-sol'],
  ] as const)(
    'BW15/M26 refuses %s model %s with no operation and no fallback model',
    async (provider, model) => {
      const ctx = setup(provider);
      expect(
        await refusal(ctx.service.proposeItem(itemInput({}, { model })))
      ).toEqual({
        status: 400,
        code: 'CS_AI_MODEL_UNSUPPORTED',
        msg: 'This AI model is not supported for this connection.',
      });
      nothingRan(ctx);
    }
  );

  it.each([
    ['an unknown operation', itemInput({ operation: 'summarize' })],
    [
      'the thread operation on an item',
      itemInput({ operation: 'generate_thread' }),
    ],
    ['a missing item id', itemInput({ itemId: undefined })],
    ['a malformed connection', itemInput({}, { connectionId: 'connection-1' })],
    ['an empty model', itemInput({}, { model: '' })],
    ['a long model', itemInput({}, { model: 'm'.repeat(129) })],
    ['draft version 0', itemInput({}, { baseDraftVersion: 0 })],
    ['a fractional draft version', itemInput({}, { baseDraftVersion: 1.5 })],
    ['a draft version past int4', itemInput({}, { baseDraftVersion: 2 ** 31 })],
    ['a string draft version', itemInput({}, { baseDraftVersion: '7' })],
    ['a non-boolean policy flag', itemInput({}, { editorialPolicy: 'yes' })],
    [
      'an instruction over 2000 characters',
      itemInput({}, { instruction: 'a'.repeat(2001) }),
    ],
    [
      'an instruction with NUL',
      itemInput({}, { instruction: `a${String.fromCharCode(0)}` }),
    ],
    [
      'an instruction with a lone surrogate',
      itemInput({}, { instruction: `a${String.fromCharCode(0xd800)}` }),
    ],
    ['an instruction that is not text', itemInput({}, { instruction: 7 })],
  ])('refuses %s with 400 before any lookup', async (_name, input) => {
    const ctx = setup();
    expect(
      (
        await refusal(
          ctx.service.proposeItem(input as ReturnType<typeof itemInput>)
        )
      ).code
    ).toBe('CS_INVALID_REQUEST');
    expect(ctx.packages.getPackageForOrganization).not.toHaveBeenCalled();
    nothingRan(ctx);
  });

  it.each([
    ['writingProfileId'],
    ['audienceProfileId'],
    ['expertiseProfileId'],
  ])('refuses a malformed %s with 400 and no query', async (field) => {
    const ctx = setup();
    for (const value of ['writing-1', 7, WRITING_ID.toUpperCase(), '']) {
      expect(
        (
          await refusal(
            ctx.service.proposeItem(itemInput({}, { [field]: value }))
          )
        ).code
      ).toBe('CS_INVALID_REQUEST');
    }
    expect(ctx.packages.getPackageForOrganization).not.toHaveBeenCalled();
    expect(
      ctx.writing.repository.getProfileForOrganization
    ).not.toHaveBeenCalled();
    expect(
      ctx.audience.repository.getProfileForOrganization
    ).not.toHaveBeenCalled();
    expect(
      ctx.expertise.repository.getProfileForOrganization
    ).not.toHaveBeenCalled();
    nothingRan(ctx);
  });

  it('accepts an instruction of exactly 2000 characters after trimming and normalizing', async () => {
    const ctx = setup();
    await ctx.service.proposeItem(
      itemInput({}, { instruction: `  ${'a'.repeat(1999)}\r\n` + ' ' })
    );
    await ctx.service.proposeItem(
      itemInput({}, { instruction: `${'a'.repeat(1998)}\r\nb` })
    );
    expect(ctx.adapter.generateText).toHaveBeenCalledTimes(2);
    expect(sentRequest(ctx).prompt).toContain(
      `## Additional instruction\n${'a'.repeat(1999)}\n\n`
    );
  });

  it('refuses a stored draft that is not valid, without quoting it', async () => {
    const ctx = setup();
    ctx.contentPackage.draft = `{"broken": "${ITEM_MARKER}"`;
    expect(await refusal(ctx.service.proposeItem(itemInput()))).toMatchObject({
      status: 500,
      code: 'CS_STORED_DRAFT_INVALID',
    });
    nothingRan(ctx);
  });
});

describe('ContentStudioAIWritingService: context snapshots', () => {
  it('BC1 records no references when nothing is selected', async () => {
    const ctx = setup();
    await ctx.service.proposeItem(itemInput());
    expect(created(ctx).context).toEqual({ v: 1, itemId: 'main' });
    for (const repository of [ctx.writing, ctx.audience, ctx.expertise]) {
      expect(
        repository.repository.getProfileForOrganization
      ).not.toHaveBeenCalled();
    }
    expect(ctx.policy.getPolicyForOrganization).not.toHaveBeenCalled();
    expect(sentRequest(ctx).prompt).not.toMatch(
      /## Writing profile|## Editorial|## Audience|## Expertise/
    );
  });

  it.each([
    ['BC2 writing', { writingProfileId: WRITING_ID }, 'writing', WRITING_ID],
    [
      'BC4 audience',
      { audienceProfileId: AUDIENCE_ID },
      'audience',
      AUDIENCE_ID,
    ],
    [
      'BC5 expertise',
      { expertiseProfileId: EXPERTISE_ID },
      'expertise',
      EXPERTISE_ID,
    ],
  ] as const)(
    '%s: the exact current immutable revision',
    async (_name, selection, kind, profileId) => {
      const ctx = setup();
      await ctx.service.proposeItem(itemInput({}, selection));
      expect(created(ctx).context).toEqual({
        v: 1,
        itemId: 'main',
        profiles: [
          {
            kind,
            profileId,
            revisionId: revisionId(kind, 4),
            revisionNumber: 4,
          },
        ],
      });
      expect(ctx[kind].repository.getRevisionByNumber).toHaveBeenCalledWith(
        ORG,
        profileId,
        4
      );
      expect(sentRequest(ctx).prompt).toContain(`${PROFILE_MARKER} ${kind} r4`);
    }
  );

  it('BC3 the exact current editorial policy revision', async () => {
    const ctx = setup();
    await ctx.service.proposeItem(itemInput({}, { editorialPolicy: true }));
    expect(created(ctx).context).toEqual({
      v: 1,
      itemId: 'main',
      editorialPolicy: {
        revisionId: revisionId('policy', 2),
        revisionNumber: 2,
      },
    });
    expect(ctx.policy.getPolicyForOrganization).toHaveBeenCalledWith(ORG);
    expect(ctx.policy.getRevisionByNumber).toHaveBeenCalledWith(
      ORG,
      POLICY_ID,
      2
    );
    expect(sentRequest(ctx).prompt).toContain(`${PROFILE_MARKER} policy r2`);
  });

  it('uses no policy when the flag is false, null or left out', async () => {
    const ctx = setup();
    await ctx.service.proposeItem(itemInput({}, { editorialPolicy: false }));
    await ctx.service.proposeItem(itemInput({}, { editorialPolicy: null }));
    expect(ctx.policy.getPolicyForOrganization).not.toHaveBeenCalled();
    expect(created(ctx).context).toEqual({ v: 1, itemId: 'main' });
  });

  it('BC6/BI8 records all four references in a fixed order, and only ids and numbers', async () => {
    const ctx = setup();
    ctx.writing.state.row.latestRevisionNumber = 7;
    ctx.writing.state.revisions.set(7, stored('writing', 7));
    await ctx.service.proposeItem(itemInput({}, ALL_PROFILES));
    const context = created(ctx).context;
    expect(context).toEqual({
      v: 1,
      itemId: 'main',
      profiles: [
        {
          kind: 'writing',
          profileId: WRITING_ID,
          revisionId: revisionId('writing', 7),
          revisionNumber: 7,
        },
        {
          kind: 'audience',
          profileId: AUDIENCE_ID,
          revisionId: revisionId('audience', 4),
          revisionNumber: 4,
        },
        {
          kind: 'expertise',
          profileId: EXPERTISE_ID,
          revisionId: revisionId('expertise', 4),
          revisionNumber: 4,
        },
      ],
      editorialPolicy: {
        revisionId: revisionId('policy', 2),
        revisionNumber: 2,
      },
    });
    expect(JSON.stringify(context)).not.toMatch(
      /PRIVATE_MARKER|name|content|hash/i
    );
  });

  it.each([
    ['BC7 writing', 'writing', { writingProfileId: WRITING_ID }],
    ['BC8 audience', 'audience', { audienceProfileId: AUDIENCE_ID }],
    ['BC9 expertise', 'expertise', { expertiseProfileId: EXPERTISE_ID }],
  ] as const)(
    '%s archived: 409 and nothing runs',
    async (_name, kind, selection) => {
      const ctx = setup();
      ctx[kind].state.row.archivedAt = new Date();
      expect(
        await refusal(ctx.service.proposeItem(itemInput({}, selection)))
      ).toEqual({
        status: 409,
        code: 'CS_AI_CONTEXT_ARCHIVED',
        msg: 'A selected AI context profile is archived.',
      });
      expect(ctx[kind].repository.getRevisionByNumber).not.toHaveBeenCalled();
      expect(ctx.resolver.resolve).not.toHaveBeenCalled();
      nothingRan(ctx);
    }
  );

  it.each([
    ['writing', { writingProfileId: '9a111111-1111-4111-8111-111111111111' }],
    ['audience', { audienceProfileId: '9b111111-1111-4111-8111-111111111111' }],
    [
      'expertise',
      { expertiseProfileId: '9c111111-1111-4111-8111-111111111111' },
    ],
  ])(
    'BC10 a missing %s profile is a context that is not available',
    async (_kind, selection) => {
      const ctx = setup();
      expect(
        await refusal(ctx.service.proposeItem(itemInput({}, selection)))
      ).toEqual({
        status: 400,
        code: 'CS_AI_CONTEXT_NOT_FOUND',
        msg: 'The selected AI context is not available.',
      });
      nothingRan(ctx);
    }
  );

  it('BC10/M4 a profile of another organization reads as missing and is looked up in the request organization only', async () => {
    const ctx = setup();
    // the profile exists, but only for ORG: the request is from OTHER_ORG
    ctx.packages.getPackageForOrganization.mockImplementation(async () => ({
      ...ctx.contentPackage,
    }));
    const err = await refusal(
      ctx.service.proposeItem(
        itemInput(
          { organizationId: OTHER_ORG },
          { writingProfileId: WRITING_ID }
        )
      )
    );
    expect(err.code).toBe('CS_AI_CONTEXT_NOT_FOUND');
    expect(ctx.writing.repository.getProfileForOrganization.mock.calls).toEqual(
      [[OTHER_ORG, WRITING_ID]]
    );
    nothingRan(ctx);
  });

  it('BC11/M5 an editorial policy asked for but never saved is an error, not left out', async () => {
    const ctx = setup();
    ctx.policyState.policy = null;
    expect(
      await refusal(
        ctx.service.proposeItem(itemInput({}, { editorialPolicy: true }))
      )
    ).toEqual({
      status: 400,
      code: 'CS_AI_CONTEXT_NOT_FOUND',
      msg: 'The selected AI context is not available.',
    });
    nothingRan(ctx);
  });

  const corrupt = (revision: StoredRevision) => ({
    'a changed hash': { ...revision, contentHash: '0'.repeat(64) },
    'a broken text': { ...revision, content: `{"x":"${PROFILE_MARKER}"` },
    'another schema version': { ...revision, schemaVersion: 2 },
  });

  it.each([
    ['BC12', 'writing', { writingProfileId: WRITING_ID }],
    ['BC14', 'audience', { audienceProfileId: AUDIENCE_ID }],
    ['BC15', 'expertise', { expertiseProfileId: EXPERTISE_ID }],
  ] as const)(
    '%s a corrupted %s revision is an integrity error, never quoted',
    async (_n, kind, selection) => {
      for (const broken of Object.values(corrupt(stored(kind, 4)))) {
        const ctx = setup();
        ctx[kind].state.revisions.set(4, broken);
        expect(
          await refusal(ctx.service.proposeItem(itemInput({}, selection)))
        ).toEqual({
          status: 500,
          code: 'CS_AI_CONTEXT_INTEGRITY_ERROR',
          msg: 'Selected AI context could not be verified.',
        });
        nothingRan(ctx);
      }
    }
  );

  it('BC13 a corrupted editorial policy revision is an integrity error', async () => {
    for (const broken of Object.values(corrupt(stored('policy', 2)))) {
      const ctx = setup();
      ctx.policyState.revisions.set(2, broken);
      expect(
        (
          await refusal(
            ctx.service.proposeItem(itemInput({}, { editorialPolicy: true }))
          )
        ).code
      ).toBe('CS_AI_CONTEXT_INTEGRITY_ERROR');
      nothingRan(ctx);
    }
  });

  it('a current revision that is missing is an integrity error', async () => {
    const ctx = setup();
    ctx.writing.state.revisions.clear();
    expect(
      (
        await refusal(
          ctx.service.proposeItem(
            itemInput({}, { writingProfileId: WRITING_ID })
          )
        )
      ).code
    ).toBe('CS_AI_CONTEXT_INTEGRITY_ERROR');
    nothingRan(ctx);
  });

  it.each([['writing'], ['audience'], ['expertise']] as const)(
    'BC16/M2 a %s revision saved after the snapshot changes nothing: one lookup, the snapshot revision in context and prompt',
    async (kind) => {
      const ctx = setup();
      const repository = ctx[kind].repository;
      const read = repository.getRevisionByNumber.getMockImplementation()!;
      repository.getRevisionByNumber.mockImplementation(async (...args) => {
        const revision = await read(...args);
        // someone saves revision 5 right after this run read revision 4
        ctx[kind].state.row.latestRevisionNumber = 5;
        ctx[kind].state.revisions.set(5, stored(kind, 5));
        return revision;
      });
      await ctx.service.proposeItem(itemInput({}, ALL_PROFILES));
      expect(repository.getProfileForOrganization).toHaveBeenCalledTimes(1);
      expect(repository.getRevisionByNumber).toHaveBeenCalledTimes(1);
      const ref = created(ctx).context.profiles.find(
        (profile: { kind: string }) => profile.kind === kind
      );
      expect(ref).toEqual({
        kind,
        profileId: ctx[kind].state.row.id,
        revisionId: revisionId(kind, 4),
        revisionNumber: 4,
      });
      expect(sentRequest(ctx).prompt).toContain(`${PROFILE_MARKER} ${kind} r4`);
      expect(sentRequest(ctx).prompt).not.toContain(`${kind} r5`);
    }
  );

  it('BC16 a policy revision saved after the snapshot changes nothing', async () => {
    const ctx = setup();
    const read = ctx.policy.getRevisionByNumber.getMockImplementation()!;
    ctx.policy.getRevisionByNumber.mockImplementation(async (...args) => {
      const revision = await read(...args);
      ctx.policyState.policy = { id: POLICY_ID, latestRevisionNumber: 3 };
      ctx.policyState.revisions.set(3, stored('policy', 3));
      return revision;
    });
    await ctx.service.proposeItem(itemInput({}, ALL_PROFILES));
    expect(ctx.policy.getPolicyForOrganization).toHaveBeenCalledTimes(1);
    expect(created(ctx).context.editorialPolicy).toEqual({
      revisionId: revisionId('policy', 2),
      revisionNumber: 2,
    });
    expect(sentRequest(ctx).prompt).toContain(`${PROFILE_MARKER} policy r2`);
    expect(sentRequest(ctx).prompt).not.toContain('policy r3');
  });

  it('resolves the context after the draft check and before the connection', async () => {
    const ctx = setup();
    await ctx.service.proposeItem(itemInput({}, ALL_PROFILES));
    const order = [
      ctx.packages.getPackageForOrganization,
      ctx.writing.repository.getProfileForOrganization,
      ctx.policy.getPolicyForOrganization,
      ctx.audience.repository.getProfileForOrganization,
      ctx.expertise.repository.getProfileForOrganization,
      ctx.resolver.resolve,
      ctx.operations.createRunningOperation,
      ctx.adapter.generateText,
    ].map((fn) => fn.mock.invocationCallOrder[0]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('ContentStudioAIWritingService: prompt', () => {
  it('BP1 builds the same request for the same input', async () => {
    const first = setup();
    const second = setup();
    await first.service.proposeItem(
      itemInput({}, { ...ALL_PROFILES, instruction: INSTRUCTION })
    );
    await second.service.proposeItem(
      itemInput({}, { ...ALL_PROFILES, instruction: INSTRUCTION })
    );
    expect(sentRequest(second)).toEqual(sentRequest(first));
    expect(created(second).requestHash).toBe(created(first).requestHash);
  });

  it('BP3-BP9/BP14 sends the selected context, the instruction and the item text', async () => {
    const ctx = setup();
    await ctx.service.proposeItem(
      itemInput({}, { ...ALL_PROFILES, instruction: `  ${INSTRUCTION}\r\n` })
    );
    const { prompt, system, output, model, maxOutputTokens } = sentRequest(ctx);
    for (const marker of [
      'writing r4',
      'policy r2',
      'audience r4',
      'expertise r4',
      ITEM_MARKER,
    ]) {
      expect(prompt).toContain(marker);
    }
    expect(prompt).toContain(
      `## Additional instruction\n${INSTRUCTION}\n\n## Task`
    );
    expect(prompt).toContain(
      'Treat this expertise profile as organization-provided context, not independently verified facts.'
    );
    expect(system).toContain('not independently verified facts');
    expect(output).toEqual({ type: 'text' });
    expect(model).toBe('gpt-6.1-sol');
    expect(maxOutputTokens).toBe(4096);
    expect(created(ctx).promptVersion).toBe('cs-rewrite-item-v1');
  });

  it('BP11-BP13 sends no profile, revision, policy, connection, package, organization or user id', async () => {
    const ctx = setup();
    await ctx.service.proposeItem(
      itemInput({}, { ...ALL_PROFILES, instruction: INSTRUCTION })
    );
    ctx.adapter.generateText.mockResolvedValueOnce(
      providerResult(VALID_THREAD)
    );
    await ctx.service.proposeThread(threadInput({}, ALL_PROFILES));
    expect(ctx.adapter.generateText).toHaveBeenCalledTimes(2);
    for (const [request] of ctx.adapter.generateText.mock
      .calls as unknown as Array<[{ system: string; prompt: string }]>) {
      const text = `${request.system}\n${request.prompt}`;
      expect(text).not.toMatch(UUID_ANYWHERE);
      for (const id of [
        ORG,
        USER,
        CONNECTION,
        PACKAGE,
        WRITING_ID,
        AUDIENCE_ID,
        EXPERTISE_ID,
        POLICY_ID,
      ]) {
        expect(text).not.toContain(id);
      }
    }
  });

  const big = (char: string) => {
    const ctx = setup();
    const text = (n: number) => char.repeat(n);
    ctx.contentPackage.draft = JSON.stringify({
      schemaVersion: 1,
      copy: {
        global: {
          thread: [
            { id: 'main', text: text(10_000), mediaIds: [] },
            { id: 'f1', text: text(10_000), mediaIds: [] },
            { id: 'f2', text: text(10_000), mediaIds: [] },
          ],
        },
      },
    });
    const writing = parseContentStudioWritingProfileContent({
      ...writingContent(),
      examples: [1, 2, 3].map(() => ({ text: text(5_000), note: null })),
    });
    ctx.writing.state.revisions.set(4, {
      id: revisionId('writing', 4),
      revisionNumber: 4,
      ...storedContentStudioWritingProfileContent(writing),
    });
    const expertise = parseContentStudioExpertiseProfileContent({
      ...expertiseContent(),
      evidenceExpectations: text(2_000),
      confidenceBoundaries: text(2_000),
    });
    ctx.expertise.state.revisions.set(4, {
      id: revisionId('expertise', 4),
      revisionNumber: 4,
      ...storedContentStudioExpertiseProfileContent(expertise),
    });
    return ctx;
  };
  const bigSelection = {
    writingProfileId: WRITING_ID,
    expertiseProfileId: EXPERTISE_ID,
  };

  it('BP15/BP16 refuses a prompt over 96 KiB of UTF-8 before any operation, though it has far fewer characters', async () => {
    const ctx = big(String.fromCharCode(0xe9));
    expect(
      await refusal(ctx.service.proposeThread(threadInput({}, bigSelection)))
    ).toEqual({
      status: 400,
      code: 'CS_AI_CONTEXT_TOO_LARGE',
      msg: 'The selected AI context is too large.',
    });
    expect(ctx.resolver.resolve).not.toHaveBeenCalled();
    nothingRan(ctx);
  });

  it('BP16 runs the same prompt in single byte characters', async () => {
    const ctx = big('e');
    ctx.adapter.generateText.mockResolvedValueOnce(
      providerResult(VALID_THREAD)
    );
    await ctx.service.proposeThread(threadInput({}, bigSelection));
    const { system, prompt } = sentRequest(ctx);
    const length = system.length + prompt.length;
    expect(length).toBeGreaterThan(50_000);
    expect(length).toBeLessThan(96 * 1024);
    expect(2 * length).toBeGreaterThan(96 * 1024);
  });
});

describe('ContentStudioAIWritingService: item proposals', () => {
  it.each([
    ['BI1', 'generate_item', 'cs-generate-item-v1'],
    ['BI2', 'rewrite_item', 'cs-rewrite-item-v1'],
    ['BI3', 'shorten_item', 'cs-shorten-item-v1'],
    ['BI4', 'expand_item', 'cs-expand-item-v1'],
    ['BI5', 'change_tone', 'cs-change-tone-v1'],
  ])(
    '%s %s runs once and returns a proposal only',
    async (_n, operation, promptVersion) => {
      const ctx = setup();
      const value = await ctx.service.proposeItem(
        itemInput({ operation }, { instruction: INSTRUCTION })
      );
      expect(value).toEqual({
        operationId: OPERATION,
        baseDraftVersion: 7,
        proposal: {
          type: 'item',
          itemId: 'main',
          text: `${RESULT_MARKER} A brighter spring.`,
        },
      });
      expect(ctx.executeSpy).toHaveBeenCalledTimes(1);
      expect(ctx.adapter.generateText).toHaveBeenCalledTimes(1);
      expect(created(ctx)).toMatchObject({
        organizationId: ORG,
        userId: USER,
        connectionId: CONNECTION,
        packageId: PACKAGE,
        kind: operation,
        provider: 'openai',
        model: 'gpt-6.1-sol',
        promptVersion,
        baseDraftVersion: 7,
        context: { v: 1, itemId: 'main' },
      });
      noDraftOrProfileWrite(ctx);
    }
  );

  it('BI6/BI7/BI9 hands the execution service the base version, the item and a validator', async () => {
    const ctx = setup();
    await ctx.service.proposeItem(itemInput({ itemId: 'f2' }));
    const [input, options] = ctx.executeSpy.mock.calls[0];
    expect(input).toMatchObject({
      organizationId: ORG,
      userId: USER,
      connectionId: CONNECTION,
      packageId: PACKAGE,
      baseDraftVersion: 7,
      context: { v: 1, itemId: 'f2' },
    });
    expect(Object.keys(input).sort()).toEqual([
      'baseDraftVersion',
      'connectionId',
      'context',
      'kind',
      'model',
      'organizationId',
      'packageId',
      'promptVersion',
      'request',
      'userId',
    ]);
    expect(typeof options?.validateResult).toBe('function');
    expect(created(ctx).requestHash).toBe(
      hashContentStudioAIRequest({
        kind: 'rewrite_item',
        provider: 'openai',
        model: 'gpt-6.1-sol',
        promptVersion: 'cs-rewrite-item-v1',
        packageId: PACKAGE,
        baseDraftVersion: 7,
        context: { v: 1, itemId: 'f2' },
        request: input.request,
      })
    );
  });

  it('keeps the suggested text as it came, line endings normalized', async () => {
    const ctx = setup();
    ctx.adapter.generateText.mockResolvedValueOnce(
      providerResult('  Line one\r\nLine two\n')
    );
    expect((await ctx.service.proposeItem(itemInput())).proposal.text).toBe(
      '  Line one\nLine two\n'
    );
  });

  it.each([
    ['BI13 no text', 42 as unknown as string, 'CS_AI_INVALID_RESPONSE'],
    ['BI13 empty text', '   ', 'CS_AI_INVALID_RESPONSE'],
    [
      'BI14/M16 over 10000 characters',
      'a'.repeat(10_001),
      'CS_AI_INVALID_RESPONSE',
    ],
    [
      'BI15 a NUL',
      `${RESULT_MARKER}${String.fromCharCode(0)}`,
      'CS_AI_INVALID_RESPONSE',
    ],
    [
      'BI15 a lone surrogate',
      `${RESULT_MARKER}${String.fromCharCode(0xdc00)}`,
      'CS_AI_INVALID_RESPONSE',
    ],
  ])(
    'BI9 %s fails the operation as INVALID_RESPONSE, asking once',
    async (_name, text) => {
      const ctx = setup();
      ctx.adapter.generateText.mockResolvedValueOnce(providerResult(text));
      expect(await refusal(ctx.service.proposeItem(itemInput()))).toEqual({
        status: 502,
        code: 'CS_AI_INVALID_RESPONSE',
        msg: 'The AI provider answered with an unexpected response.',
      });
      expect(ctx.adapter.generateText).toHaveBeenCalledTimes(1);
      expect(ctx.operations.completeSucceededWithUsage).not.toHaveBeenCalled();
      expect(ctx.operations.completeFailedWithUsage).toHaveBeenCalledTimes(1);
      expect(
        (
          ctx.operations.completeFailedWithUsage.mock.calls[0] as unknown as [
            { errorCode: string }
          ]
        )[0].errorCode
      ).toBe('INVALID_RESPONSE');
      expect(persisted(ctx)).not.toMatch(PRIVATE);
    }
  );

  it('a cut-off answer fails as INVALID_RESPONSE; a refused one as CONTENT_REJECTED', async () => {
    const cut = setup();
    cut.adapter.generateText.mockResolvedValueOnce(
      providerResult('Half a sen', { finishReason: 'length' })
    );
    expect((await refusal(cut.service.proposeItem(itemInput()))).code).toBe(
      'CS_AI_INVALID_RESPONSE'
    );
    const filtered = setup();
    filtered.adapter.generateText.mockResolvedValueOnce(
      providerResult('Sorry', { finishReason: 'content_filter' })
    );
    expect(
      await refusal(filtered.service.proposeItem(itemInput()))
    ).toMatchObject({
      status: 422,
      code: 'CS_AI_CONTENT_REJECTED',
    });
    expect(
      (
        filtered.operations.completeFailedWithUsage.mock
          .calls[0] as unknown as [{ errorCode: string }]
      )[0].errorCode
    ).toBe('CONTENT_REJECTED');
  });

  it('refuses a suggestion that would make the draft too large to save', async () => {
    const ctx = setup();
    const draft = draftOf();
    draft.copy.global.thread = [
      { id: 'main', text: 'short', mediaIds: [] },
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `f${i}`,
        text: 'x'.repeat(10_000),
        mediaIds: [],
      })),
    ];
    ctx.contentPackage.draft = JSON.stringify(draft);
    ctx.adapter.generateText.mockResolvedValueOnce(
      providerResult('y'.repeat(10_000))
    );
    expect((await refusal(ctx.service.proposeItem(itemInput()))).code).toBe(
      'CS_AI_INVALID_RESPONSE'
    );
    expect(ctx.adapter.generateText).toHaveBeenCalledTimes(1);
  });

  it('BI10-BI12 returns the text and never stores it, nor the prompt, instruction, item or profile text', async () => {
    const ctx = setup();
    const value = await ctx.service.proposeItem(
      itemInput({}, { ...ALL_PROFILES, instruction: INSTRUCTION })
    );
    expect(value.proposal.text).toContain(RESULT_MARKER);
    // the provider got them all
    const { prompt, system } = sentRequest(ctx);
    for (const marker of [
      ITEM_MARKER,
      PROFILE_MARKER,
      'INSTRUCTION_PRIVATE_MARKER_321',
    ]) {
      expect(prompt).toContain(marker);
    }
    expect(system).toContain('professional writing assistant');
    // persistence got none of them
    expect(persisted(ctx)).not.toMatch(PRIVATE);
    expect(persisted(ctx)).not.toMatch(/Mention the sale|A brighter spring/);
    expect(Object.keys(value).sort()).toEqual([
      'baseDraftVersion',
      'operationId',
      'proposal',
    ]);
    expect(JSON.stringify(value)).not.toMatch(
      /usage|req_writing|prompt|system/
    );
    noDraftOrProfileWrite(ctx);
  });
});

describe('ContentStudioAIWritingService: thread proposals', () => {
  it('BT1/BT2/BT3/BT14 runs once with the thread prompt and returns a proposal only', async () => {
    const ctx = setup();
    ctx.adapter.generateText.mockResolvedValueOnce(
      providerResult(VALID_THREAD)
    );
    const value = await ctx.service.proposeThread(
      threadInput({}, { instruction: INSTRUCTION })
    );
    expect(value).toEqual({
      operationId: OPERATION,
      baseDraftVersion: 7,
      proposal: {
        type: 'thread',
        items: [
          { itemId: 'main', text: `${RESULT_MARKER} one` },
          { itemId: 'f1', text: 'two' },
          { itemId: 'f2', text: 'three' },
        ],
      },
    });
    expect(ctx.adapter.generateText).toHaveBeenCalledTimes(1);
    expect(created(ctx)).toMatchObject({
      kind: 'generate_thread',
      promptVersion: 'cs-generate-thread-v1',
      context: { v: 1 },
    });
    expect(created(ctx).context).toEqual({ v: 1 });
    const { prompt, output, maxOutputTokens } = sentRequest(ctx);
    expect(output).toEqual({ type: 'text' });
    expect(maxOutputTokens).toBe(16_384);
    expect(prompt).toContain('item id: main');
    expect(prompt).toContain('item id: f1');
    expect(prompt).toContain('item id: f2');
    expect(persisted(ctx)).not.toMatch(PRIVATE);
    noDraftOrProfileWrite(ctx);
  });

  it('works with a provider without native structured output (Anthropic): JSON is asked for in the prompt', async () => {
    const ctx = setup('anthropic');
    ctx.adapter.generateText.mockResolvedValueOnce(
      providerResult(VALID_THREAD)
    );
    await ctx.service.proposeThread(
      threadInput({}, { model: 'claude-opus-5-5' })
    );
    expect(sentRequest(ctx).output).toEqual({ type: 'text' });
  });

  it('BT5 returns the draft order', async () => {
    const ctx = setup();
    ctx.adapter.generateText.mockResolvedValueOnce(
      providerResult(
        threadAnswer([
          ['f2', 'c'],
          ['main', 'a'],
          ['f1', 'b'],
        ])
      )
    );
    const value = await ctx.service.proposeThread(threadInput());
    expect(value.proposal.items.map((entry) => entry.itemId)).toEqual([
      'main',
      'f1',
      'f2',
    ]);
  });

  it('BT15 carries texts only: media and order are not part of a proposal', async () => {
    const ctx = setup();
    ctx.adapter.generateText.mockResolvedValueOnce(
      providerResult(VALID_THREAD)
    );
    const value = await ctx.service.proposeThread(threadInput());
    for (const entry of value.proposal.items) {
      expect(Object.keys(entry).sort()).toEqual(['itemId', 'text']);
    }
  });

  it.each([
    [
      'BT6 a missing item',
      threadAnswer([
        ['main', 'a'],
        ['f1', 'b'],
      ]),
    ],
    [
      'BT7 an extra item',
      threadAnswer([
        ['main', 'a'],
        ['f1', 'b'],
        ['f2', 'c'],
        ['f3', 'd'],
      ]),
    ],
    [
      'BT8/M15 a duplicate item',
      threadAnswer([
        ['main', 'a'],
        ['main', 'b'],
        ['f2', 'c'],
      ]),
    ],
    [
      'BT9/M14 an unknown item id',
      threadAnswer([
        ['main', 'a'],
        ['x9', 'b'],
        ['f2', 'c'],
      ]),
    ],
    ['BT10/M13 malformed JSON', '{"items":['],
    ['BT11 commentary around the JSON', `Sure! ${VALID_THREAD}`],
    ['BT11 a Markdown fence', '```json\n' + VALID_THREAD + '\n```'],
    [
      'BT12 an unknown field',
      JSON.stringify({
        items: [
          { itemId: 'main', text: 'a', mediaIds: ['m9'] },
          { itemId: 'f1', text: 'b' },
          { itemId: 'f2', text: 'c' },
        ],
      }),
    ],
    [
      'BT13 an overlong item text',
      threadAnswer([
        ['main', 'a'.repeat(10_001)],
        ['f1', 'b'],
        ['f2', 'c'],
      ]),
    ],
    [
      'an empty item text',
      threadAnswer([
        ['main', 'a'],
        ['f1', ' '],
        ['f2', 'c'],
      ]),
    ],
  ])(
    '%s fails the operation as INVALID_RESPONSE, asking once',
    async (_name, text) => {
      const ctx = setup();
      ctx.adapter.generateText.mockResolvedValueOnce(providerResult(text));
      expect(
        (await refusal(ctx.service.proposeThread(threadInput()))).code
      ).toBe('CS_AI_INVALID_RESPONSE');
      expect(ctx.adapter.generateText).toHaveBeenCalledTimes(1);
      expect(ctx.operations.completeSucceededWithUsage).not.toHaveBeenCalled();
      expect(
        (
          ctx.operations.completeFailedWithUsage.mock.calls[0] as unknown as [
            { errorCode: string }
          ]
        )[0].errorCode
      ).toBe('INVALID_RESPONSE');
      expect(persisted(ctx)).not.toMatch(PRIVATE);
      noDraftOrProfileWrite(ctx);
    }
  );

  it('refuses a thread suggestion that would make the draft too large to save', async () => {
    const ctx = setup();
    const ids = Array.from({ length: 7 }, (_, i) => `t${i}`);
    ctx.contentPackage.draft = JSON.stringify({
      schemaVersion: 1,
      copy: {
        global: { thread: ids.map((id) => ({ id, text: 'x', mediaIds: [] })) },
      },
    });
    ctx.adapter.generateText.mockResolvedValueOnce(
      providerResult(threadAnswer(ids.map((id) => [id, 'y'.repeat(10_000)])))
    );
    expect((await refusal(ctx.service.proposeThread(threadInput()))).code).toBe(
      'CS_AI_INVALID_RESPONSE'
    );
  });

  it('refuses an item operation on the thread route', async () => {
    const ctx = setup();
    expect(
      (
        await refusal(
          ctx.service.proposeThread(threadInput({ operation: 'rewrite_item' }))
        )
      ).code
    ).toBe('CS_INVALID_REQUEST');
    nothingRan(ctx);
  });
});

describe('ContentStudioAIWritingService: provider and persistence failures', () => {
  it.each([
    ['AUTH_FAILED', 502, 'CS_AI_AUTH_FAILED'],
    ['QUOTA_EXCEEDED', 502, 'CS_AI_QUOTA_EXCEEDED'],
    ['RATE_LIMITED', 429, 'CS_AI_RATE_LIMITED'],
    ['PROVIDER_UNAVAILABLE', 503, 'CS_AI_PROVIDER_UNAVAILABLE'],
    ['TIMEOUT', 504, 'CS_AI_TIMEOUT'],
    ['MODEL_UNAVAILABLE', 502, 'CS_AI_MODEL_UNAVAILABLE'],
    ['REQUEST_REJECTED', 502, 'CS_AI_REQUEST_REJECTED'],
    ['CONTENT_REJECTED', 422, 'CS_AI_CONTENT_REJECTED'],
    ['INVALID_RESPONSE', 502, 'CS_AI_INVALID_RESPONSE'],
  ] as Array<[ContentStudioAIProviderErrorCode, number, string]>)(
    'answers %s as %s %s, with a fixed message and no retry',
    async (code, status, csCode) => {
      const ctx = setup();
      ctx.adapter.generateText.mockRejectedValueOnce(
        new ContentStudioAIProviderError(code, {
          providerRequestId: 'req_err_1',
          httpStatus: 401,
        })
      );
      const err = await refusal(ctx.service.proposeItem(itemInput()));
      expect(err).toMatchObject({ status, code: csCode });
      expect([401, 402, 406]).not.toContain(err.status);
      expect(JSON.stringify(err)).not.toMatch(
        /req_err_1|providerCode|httpStatus/
      );
      expect(ctx.adapter.generateText).toHaveBeenCalledTimes(1);
      expect(ctx.resolver.resolve).toHaveBeenCalledTimes(1);
    }
  );

  it('answers an unexpected provider error without its message', async () => {
    const ctx = setup();
    ctx.adapter.generateText.mockRejectedValueOnce(
      new Error(`boom ${KEY} ${ITEM_MARKER}`)
    );
    expect((await refusal(ctx.service.proposeItem(itemInput()))).code).toBe(
      'CS_AI_PROVIDER_UNAVAILABLE'
    );
  });

  it('answers a recording failure as CS_AI_OPERATION_FAILED, and the provider is not asked again', async () => {
    const ctx = setup();
    ctx.operations.completeSucceededWithUsage.mockRejectedValueOnce(
      new Error(`deadlock ${KEY}`)
    );
    expect(await refusal(ctx.service.proposeItem(itemInput()))).toEqual({
      status: 500,
      code: 'CS_AI_OPERATION_FAILED',
      msg: 'The AI operation could not be recorded.',
    });
    expect(ctx.adapter.generateText).toHaveBeenCalledTimes(1);
  });

  it('M7 answers a draft that moved on between its check and the operation as a conflict, with no operation', async () => {
    const ctx = setup();
    let reads = 0;
    ctx.packages.getPackageForOrganization.mockImplementation(async () => ({
      ...ctx.contentPackage,
      draftVersion: reads++ === 0 ? 7 : 8,
    }));
    expect((await refusal(ctx.service.proposeItem(itemInput()))).code).toBe(
      'CS_DRAFT_VERSION_CONFLICT'
    );
    nothingRan(ctx);
  });
});

describe('ContentStudioAIWritingService source', () => {
  // code only: the comments explain these rules and may name them
  const text = fs
    .readFileSync(
      path.join(__dirname, 'content-studio.ai-writing.service.ts'),
      'utf8'
    )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('never touches a provider, credential, environment, network, role or bill', () => {
    expect(text).not.toMatch(
      /from 'openai'|@anthropic-ai|@ai-sdk|from 'ai'|providers\/|ContentStudioAIProviderResolver|generateText|process\.env|\bfetch\(|axios|SecretBox|apiKey|sealedCredential|openContentStudioAICredential/
    );
    expect(text).not.toMatch(
      /CheckPolicies|assertManager|Role\.|ADMIN|SUPERADMIN|billing|subscription|wallet|stripe|credits?\b(?! left)/i
    );
    expect(text).not.toMatch(/console\.|Logger/);
  });

  it('M10 writes no draft, revision, handoff, profile or policy', () => {
    expect(text).not.toMatch(
      /saveDraft|saveDraftCompareAndSwap|createRevision|updatePackage|archivePackage|restorePackage|createPackage|Handoff|createProfile|updateProfileName|archiveProfile|restoreProfile|createPolicy/
    );
    expect(text.match(/\.execute\(/g)).toHaveLength(1);
  });
});
