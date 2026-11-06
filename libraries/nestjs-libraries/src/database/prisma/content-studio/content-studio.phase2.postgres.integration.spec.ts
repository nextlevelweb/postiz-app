import { inspect } from 'util';
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  createSecretBox,
  SecretBox,
} from '@gitroom/nestjs-libraries/services/secret.box';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioAIConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.repository';
import { ContentStudioAIConnectionService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.service';
import { ContentStudioAIOperationRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-operation.repository';
import { ContentStudioWritingProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.writing-profile.repository';
import { ContentStudioWritingProfileService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.writing-profile.service';
import { ContentStudioEditorialPolicyRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.repository';
import { ContentStudioEditorialPolicyService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.service';
import { ContentStudioAudienceProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.audience-profile.repository';
import { ContentStudioExpertiseProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.expertise-profile.repository';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioAIWritingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-writing.service';
import { ContentStudioAIExecutionService } from '@gitroom/nestjs-libraries/content-studio/ai/ai.execution.service';
import { ContentStudioAIProviderResolver } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.resolver';
import { openContentStudioAICredential } from '@gitroom/nestjs-libraries/content-studio/ai/ai.credential';
import {
  ContentStudioAIProviderError,
  ContentStudioAIResolutionError,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import { ContentStudioAITextResult } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';
import { parseContentStudioAIOperationContext } from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.types';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import { parseContentStudioWritingProfileContent } from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile';
import { parseContentStudioEditorialPolicyContent } from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy';
import { parseContentStudioAudienceProfileContent } from '@gitroom/nestjs-libraries/content-studio/editorial/audience.profile';
import { parseContentStudioExpertiseProfileContent } from '@gitroom/nestjs-libraries/content-studio/editorial/expertise.profile';
import { storedContentStudioWritingProfileContent } from '@gitroom/nestjs-libraries/content-studio/editorial/writing.profile.revision';
import { storedContentStudioEditorialPolicyContent } from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy.revision';
import { storedContentStudioAudienceProfileContent } from '@gitroom/nestjs-libraries/content-studio/editorial/audience.profile.revision';
import { storedContentStudioExpertiseProfileContent } from '@gitroom/nestjs-libraries/content-studio/editorial/expertise.profile.revision';
import { createContentStudioPostgresClient } from '../../../../../../jest.content-studio.postgres.guard';
import { ContentStudioAIProviderGate } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.gate';

// every catalog provider on, as before the Codex gate (Review 20)
const CODEX_GATE = new ContentStudioAIProviderGate({ codex: true });

// Phase 2 on a real PostgreSQL (P2-11). Opt-in: runs only through
// jest.content-studio.integration.config.ts against the disposable local
// database (see jest.content-studio.postgres.guard.ts). The repositories and
// services run unchanged; Prisma is used directly only to build fixtures, read
// final state and bypass the repositories on purpose, to prove what the
// database itself enforces and what only the application does. Concurrent
// calls are judged by the final state, never by timing. No provider is ever
// reached: adapters are fakes, and fetch fails the test if anything calls it

// The production `secretBox` reads its keyring from the environment. Here it
// forwards to a local test keyring, so credentials are sealed with real
// AES-GCM without any deployment secret
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

// Phase 2 resource ids are uuids, and so are these organizations and users:
// the AI execution service only accepts uuids
const ORG_A = '21100000-0000-4000-8000-00000000000a';
const ORG_B = '21100000-0000-4000-8000-00000000000b';
const USER_A = '21100000-0000-4000-8000-0000000000a1';
const USER_B = '21100000-0000-4000-8000-0000000000b1';
const MISSING = '21100000-0000-4000-8000-0000000000ff';
const ORGS = [ORG_A, ORG_B];
const USERS = [USER_A, USER_B];
const OWNER: Record<string, string> = { [ORG_A]: USER_A, [ORG_B]: USER_B };

const PROMPT_MARKER = 'DB_PROMPT_SECRET_123';
const RESULT_MARKER = 'DB_RESULT_SECRET_456';
const KEY_MARKER = 'sk-DB_KEY_SECRET_789';
const DB_MARKERS =
  /DB_PROMPT_SECRET_123|DB_RESULT_SECRET_456|DB_KEY_SECRET_789/;

let client: PrismaClient;
let packages: ContentStudioRepository;
let connections: ContentStudioAIConnectionRepository;
let operations: ContentStudioAIOperationRepository;
let writingRepository: ContentStudioWritingProfileRepository;
let editorialRepository: ContentStudioEditorialPolicyRepository;
let audienceRepository: ContentStudioAudienceProfileRepository;
let expertiseRepository: ContentStudioExpertiseProfileRepository;
let sourceRepository: ContentStudioSourceRepository;
let fetchSpy: jest.SpyInstance;

// --- profile content: valid v1, stored the way the services store it ---
const writingContent = (marker: string) =>
  parseContentStudioWritingProfileContent({
    schemaVersion: 1,
    voice: `${marker} Calm and direct.`,
    toneTags: ['warm'],
    perspective: 'first_plural',
    formatting: { emoji: 'sparing', hashtags: 'few', notes: null },
    vocabulary: { prefer: ['customers'], avoid: ['users'] },
    dos: ['Use examples'],
    donts: ['Overpromise'],
    examples: [],
  });
const editorialContent = (marker: string) =>
  parseContentStudioEditorialPolicyContent({
    schemaVersion: 1,
    principles: [`${marker} Be accurate`],
    prohibitedTopics: ['Politics'],
    claimRules: [],
    ctaRules: [],
    formatConventions: [],
    complianceNotes: '',
  });
const audienceContent = (marker: string) =>
  parseContentStudioAudienceProfileContent({
    schemaVersion: 1,
    description: `${marker} Owners`,
    role: 'Owner',
    knowledgeLevel: 'mixed',
    goals: [],
    painPoints: [],
    objections: [],
    preferredTone: null,
    locale: 'nl-NL',
  });
const expertiseContent = (marker: string) =>
  parseContentStudioExpertiseProfileContent({
    schemaVersion: 1,
    subjects: [`${marker} Bookkeeping`],
    differentiators: [],
    stances: [],
    frameworks: [],
    evidenceExpectations: '',
    avoidTopics: [],
    confidenceBoundaries: '',
  });

type Kind = 'writing' | 'audience' | 'expertise';
const storedRevision = {
  writing: (marker: string) =>
    storedContentStudioWritingProfileContent(writingContent(marker)),
  audience: (marker: string) =>
    storedContentStudioAudienceProfileContent(audienceContent(marker)),
  expertise: (marker: string) =>
    storedContentStudioExpertiseProfileContent(expertiseContent(marker)),
};
const storedPolicy = (marker: string) =>
  storedContentStudioEditorialPolicyContent(editorialContent(marker));

// The three named profile kinds share one repository contract, so most
// checks run for each of them
interface NamedProfileRepository {
  getProfileForOrganization(
    organizationId: string,
    id: string
  ): Promise<{ id: string; latestRevisionNumber: number } | null>;
  createProfileWithFirstRevision(input: {
    profileId: string;
    revisionId: string;
    organizationId: string;
    name: string;
    createdById: string;
    revision: { schemaVersion: number; content: string; contentHash: string };
  }): Promise<unknown>;
  updateProfileName(
    organizationId: string,
    id: string,
    name: string
  ): Promise<{ count: number }>;
  archiveProfile(
    organizationId: string,
    id: string,
    archivedAt: Date
  ): Promise<{ count: number }>;
  restoreProfile(
    organizationId: string,
    id: string
  ): Promise<{ count: number }>;
  createRevisionWithCompareAndSwap(input: {
    organizationId: string;
    profileId: string;
    expectedLatestRevisionNumber: number;
    revisionId: string;
    revision: { schemaVersion: number; content: string; contentHash: string };
    createdById: string;
  }): Promise<{ status: string; currentRevisionNumber?: number }>;
  listRevisionsForProfile(input: {
    organizationId: string;
    profileId: string;
    skip: number;
    take: number;
  }): Promise<unknown[]>;
  getRevisionForProfile(
    organizationId: string,
    profileId: string,
    revisionId: string
  ): Promise<unknown | null>;
  getRevisionByNumber(
    organizationId: string,
    profileId: string,
    revisionNumber: number
  ): Promise<unknown | null>;
}

// Prisma delegates differ per model in type only; the tests use the same
// calls on each
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Delegate = any;
const KINDS: Record<
  Kind,
  {
    repository: () => NamedProfileRepository;
    profiles: () => Delegate;
    revisions: () => Delegate;
  }
> = {
  writing: {
    repository: () => writingRepository,
    profiles: () => client.contentStudioWritingProfile,
    revisions: () => client.contentStudioWritingProfileRevision,
  },
  audience: {
    repository: () => audienceRepository,
    profiles: () => client.contentStudioAudienceProfile,
    revisions: () => client.contentStudioAudienceProfileRevision,
  },
  expertise: {
    repository: () => expertiseRepository,
    profiles: () => client.contentStudioExpertiseProfile,
    revisions: () => client.contentStudioExpertiseProfileRevision,
  },
};

// --- fixtures ---
const draftJson = (text: string) =>
  JSON.stringify(
    parseContentPackageDraft({
      schemaVersion: 1,
      copy: { global: { thread: [{ id: 'main', text, mediaIds: [] }] } },
    })
  );

const createPackage = async (organizationId: string, text = 'Spring sale') =>
  (
    await client.contentPackage.create({
      data: {
        organizationId,
        name: 'P211 package',
        draft: draftJson(text),
        draftVersion: 1,
        latestRevisionNumber: 0,
        createdById: OWNER[organizationId],
      },
      select: { id: true },
    })
  ).id;

// a row only: the envelope is a placeholder unless a test seals a real one
const createConnection = async (
  organizationId: string,
  data: Partial<Prisma.ContentStudioAIConnectionUncheckedCreateInput> = {}
) =>
  (
    await client.contentStudioAIConnection.create({
      data: {
        organizationId,
        name: 'P211 connection',
        provider: 'openai',
        sealedCredential: 'sb1.placeholder.not-a-real-envelope',
        defaultModel: 'gpt-6.1-sol',
        credentialUpdatedAt: new Date('2026-10-01T10:00:00.000Z'),
        createdById: OWNER[organizationId],
        ...data,
      },
      select: { id: true },
    })
  ).id;

const operationData = (
  organizationId: string,
  connectionId: string,
  packageId: string,
  overrides: Partial<Prisma.ContentStudioAIOperationUncheckedCreateInput> = {}
): Prisma.ContentStudioAIOperationUncheckedCreateInput => ({
  id: randomUUID(),
  organizationId,
  userId: OWNER[organizationId],
  connectionId,
  packageId,
  kind: 'rewrite_item',
  status: 'running',
  provider: 'openai',
  model: 'gpt-6.1-sol',
  promptVersion: 'cs-rewrite-item-v1',
  baseDraftVersion: 1,
  context: { v: 1, itemId: 'main' },
  requestHash: 'a'.repeat(64),
  ...overrides,
});

const usageData = (
  organizationId: string,
  operationId: string,
  overrides: Partial<Prisma.ContentStudioAIUsageUncheckedCreateInput> = {}
): Prisma.ContentStudioAIUsageUncheckedCreateInput => ({
  organizationId,
  operationId,
  attempt: 1,
  provider: 'openai',
  model: 'gpt-6.1-sol',
  outcome: 'succeeded',
  usageSource: 'none',
  ...overrides,
});

const usage = (overrides: Record<string, unknown> = {}) => ({
  attempt: 1,
  provider: 'openai',
  model: 'gpt-6.1-sol',
  outcome: 'succeeded' as 'succeeded' | 'failed',
  usageSource: 'provider' as 'provider' | 'none',
  inputTokens: 10,
  outputTokens: 20,
  cachedInputTokens: null,
  reasoningTokens: null,
  totalTokens: 30,
  providerCostMicros: null,
  costCurrency: null,
  providerRequestId: 'req_p211',
  ...overrides,
});

// The org A package and connection most operation tests start from
const operationFixture = async () => {
  const packageA = await createPackage(ORG_A);
  const packageB = await createPackage(ORG_B);
  const connectionA = await createConnection(ORG_A);
  const connectionB = await createConnection(ORG_B);
  return { packageA, packageB, connectionA, connectionB };
};

const runningOperation = async () => {
  const { packageA, connectionA } = await operationFixture();
  const id = randomUUID();
  await operations.createRunningOperation({
    id,
    organizationId: ORG_A,
    userId: USER_A,
    connectionId: connectionA,
    packageId: packageA,
    kind: 'rewrite_item',
    provider: 'openai',
    model: 'gpt-6.1-sol',
    promptVersion: 'cs-rewrite-item-v1',
    baseDraftVersion: 1,
    context: { v: 1, itemId: 'main' },
    requestHash: 'b'.repeat(64),
    startedAt: new Date(),
  });
  return id;
};

const operationRow = (id: string) =>
  client.contentStudioAIOperation.findUniqueOrThrow({ where: { id } });
const usagesOf = (operationId: string) =>
  client.contentStudioAIUsage.findMany({
    where: { operationId },
    orderBy: { attempt: 'asc' },
  });

// A named profile with revision 1, made through its repository
const profileWithRevision = async (
  kind: Kind,
  organizationId = ORG_A,
  marker = 'base'
) => {
  const profileId = randomUUID();
  const revisionId = randomUUID();
  await KINDS[kind].repository().createProfileWithFirstRevision({
    profileId,
    revisionId,
    organizationId,
    name: `P211 ${kind}`,
    createdById: OWNER[organizationId],
    revision: storedRevision[kind](`${marker} r1`),
  });
  return { profileId, revisionId };
};

// The organization's policy with revision 1, made through its repository
const policyWithRevision = async (organizationId = ORG_A, marker = 'base') => {
  const policyId = randomUUID();
  const revisionId = randomUUID();
  await editorialRepository.createPolicyWithFirstRevision({
    policyId,
    revisionId,
    organizationId,
    createdById: OWNER[organizationId],
    revision: storedPolicy(`${marker} r1`),
  });
  return { policyId, revisionId };
};

// The Prisma error code of a failed write; a write that succeeds fails the
// test. Raw database messages are never asserted
const prismaCode = async (write: Promise<unknown>) => {
  try {
    await write;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return err.code;
    }
    throw err;
  }
  throw new Error('the write was expected to fail');
};

// A refused service call: its status and fixed body, which never carries a
// Prisma code, SQL, a constraint name or stored content
const httpRefusal = async (call: Promise<unknown>) => {
  const err = await call.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(HttpException);
  const body = (err as HttpException).getResponse() as {
    code?: string;
    msg?: string;
    [field: string]: unknown;
  };
  expect(JSON.stringify(body)).not.toMatch(
    /P20\d\d|constraint|_fkey|_key\b|prisma|INSERT INTO|UPDATE "|SELECT "|"ContentStudio/i
  );
  expect(String((err as Error).message)).not.toMatch(/P20\d\d|constraint/i);
  return { status: (err as HttpException).getStatus(), ...body };
};

// A deferred value, to hold a transaction open on purpose
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

const cleanPhase2 = async () => {
  const where = { organizationId: { in: ORGS } };
  await client.contentStudioAIUsage.deleteMany({ where });
  await client.contentStudioAIOperation.deleteMany({ where });
  await client.contentStudioAIConnection.deleteMany({ where });
  await client.contentStudioWritingProfileRevision.deleteMany({ where });
  await client.contentStudioWritingProfile.deleteMany({ where });
  await client.contentStudioEditorialPolicyRevision.deleteMany({ where });
  await client.contentStudioEditorialPolicy.deleteMany({ where });
  await client.contentStudioAudienceProfileRevision.deleteMany({ where });
  await client.contentStudioAudienceProfile.deleteMany({ where });
  await client.contentStudioExpertiseProfileRevision.deleteMany({ where });
  await client.contentStudioExpertiseProfile.deleteMany({ where });
  await client.contentPackage.deleteMany({ where });
};

const cleanFixtures = async () => {
  await cleanPhase2();
  await client.userOrganization.deleteMany({
    where: { organizationId: { in: ORGS } },
  });
  await client.user.deleteMany({ where: { id: { in: USERS } } });
  await client.organization.deleteMany({ where: { id: { in: ORGS } } });
};

beforeAll(async () => {
  // checks CONTENT_STUDIO_POSTGRES_INTEGRATION_URL before any client exists
  client = createContentStudioPostgresClient();
  await client.$connect();
  const prisma = client as unknown as PrismaService;
  const transaction = new PrismaTransaction(prisma);
  packages = new ContentStudioRepository(
    new PrismaRepository<'contentStudioProject'>(prisma),
    new PrismaRepository<'contentPackage'>(prisma),
    new PrismaRepository<'contentPackageRevision'>(prisma),
    transaction
  );
  connections = new ContentStudioAIConnectionRepository(
    new PrismaRepository<'contentStudioAIConnection'>(prisma)
  );
  operations = new ContentStudioAIOperationRepository(
    new PrismaRepository<'contentStudioAIOperation'>(prisma),
    transaction
  );
  writingRepository = new ContentStudioWritingProfileRepository(
    new PrismaRepository<'contentStudioWritingProfile'>(prisma),
    new PrismaRepository<'contentStudioWritingProfileRevision'>(prisma),
    transaction
  );
  editorialRepository = new ContentStudioEditorialPolicyRepository(
    new PrismaRepository<'contentStudioEditorialPolicy'>(prisma),
    new PrismaRepository<'contentStudioEditorialPolicyRevision'>(prisma),
    transaction
  );
  audienceRepository = new ContentStudioAudienceProfileRepository(
    new PrismaRepository<'contentStudioAudienceProfile'>(prisma),
    new PrismaRepository<'contentStudioAudienceProfileRevision'>(prisma),
    transaction
  );
  expertiseRepository = new ContentStudioExpertiseProfileRepository(
    new PrismaRepository<'contentStudioExpertiseProfile'>(prisma),
    new PrismaRepository<'contentStudioExpertiseProfileRevision'>(prisma),
    transaction
  );
  sourceRepository = new ContentStudioSourceRepository(
    new PrismaRepository<'contentStudioSource'>(prisma),
    new PrismaRepository<'contentStudioSourceVersion'>(prisma),
    transaction
  );

  await cleanFixtures();
  for (const [org, user] of [
    [ORG_A, USER_A],
    [ORG_B, USER_B],
  ]) {
    await client.organization.create({
      data: { id: org, name: `P211 ${org}` },
    });
    await client.user.create({
      data: {
        id: user,
        email: `${user}@p211.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P211 ${user}`,
      },
    });
    await client.userOrganization.create({
      data: { userId: user, organizationId: org, role: 'USER' },
    });
  }
});

beforeEach(async () => {
  await cleanPhase2();
  mockKeyring.box = createSecretBox({
    keys: `p211:${Buffer.alloc(32, 7).toString('base64')}`,
    activeKey: 'p211',
  });
  // nothing here may reach a network: a provider call fails the test
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('network access in the PostgreSQL integration suite');
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  mockKeyring.box = null;
});

afterAll(async () => {
  if (client) {
    await cleanFixtures();
    await client.$disconnect();
  }
});

describe('AI connections: what PostgreSQL enforces', () => {
  it('ACDB1/ACDB5/ACDB6 stores a connection of org A; archivedAt, disabledAt and the envelope may be empty', async () => {
    const id = await createConnection(ORG_A, { sealedCredential: null });
    expect(
      await client.contentStudioAIConnection.findUniqueOrThrow({
        where: { id },
        select: {
          organizationId: true,
          sealedCredential: true,
          archivedAt: true,
          disabledAt: true,
        },
      })
    ).toEqual({
      organizationId: ORG_A,
      sealedCredential: null,
      archivedAt: null,
      disabledAt: null,
    });
  });

  it('ACDB3/ACDB4 needs an existing creator and organization', async () => {
    expect(
      await prismaCode(createConnection(ORG_A, { createdById: MISSING }))
    ).toBe('P2003');
    expect(
      await prismaCode(
        client.contentStudioAIConnection.create({
          data: {
            organizationId: MISSING,
            name: 'x',
            provider: 'openai',
            credentialUpdatedAt: new Date(),
            createdById: USER_A,
          },
        })
      )
    ).toBe('P2003');
  });

  it('ACDB2/ACDB7 the [id, organizationId] key finds a connection with its own organization only', async () => {
    const id = await createConnection(ORG_A);
    const find = (organizationId: string) =>
      client.contentStudioAIConnection.findUnique({
        where: { id_organizationId: { id, organizationId } },
        select: { id: true },
      });
    expect(await find(ORG_A)).toEqual({ id });
    expect(await find(ORG_B)).toBeNull();
    // the id alone is already the primary key: the pair adds no uniqueness,
    // it is what the operation's composite foreign key points at
    expect(
      await prismaCode(
        createConnection(ORG_B, {
          id,
        } as Partial<Prisma.ContentStudioAIConnectionUncheckedCreateInput>)
      )
    ).toBe('P2002');
  });

  it('DOCUMENTED PI3: the database lets a direct write change the provider; only the repository and API keep it fixed', async () => {
    const id = await createConnection(ORG_A);
    await client.contentStudioAIConnection.update({
      where: { id },
      data: { provider: 'anthropic' },
    });
    expect(
      (
        await client.contentStudioAIConnection.findUniqueOrThrow({
          where: { id },
        })
      ).provider
    ).toBe('anthropic');
  });
});

describe('AI connections: the real repository is organization scoped', () => {
  it('ACR1/ACR2/ACR3/ACR8-SEC1 lists and reads per organization, without the envelope', async () => {
    const a = await createConnection(ORG_A, { name: 'A one' });
    const b = await createConnection(ORG_B, { name: 'B one' });
    const listA = await connections.listConnectionsForOrganization(ORG_A);
    const listB = await connections.listConnectionsForOrganization(ORG_B);
    expect(listA.map((row) => row.id)).toEqual([a]);
    expect(listB.map((row) => row.id)).toEqual([b]);
    expect(await connections.getConnectionForOrganization(ORG_B, a)).toBeNull();
    const row = await connections.getConnectionForOrganization(ORG_A, a);
    for (const shape of [row, ...listA, ...listB]) {
      expect(Object.keys(shape as object)).not.toContain('sealedCredential');
      expect(JSON.stringify(shape)).not.toContain('sb1.placeholder');
    }
  });

  it('ACR4/58 replacing a credential resets the last test, for its own organization only', async () => {
    const id = await createConnection(ORG_A, {
      lastValidatedAt: new Date('2026-10-02T10:00:00.000Z'),
      lastValidationStatus: 'invalid',
      lastValidationCode: 'AUTH_FAILED',
    });
    const replacedAt = new Date('2026-10-03T10:00:00.000Z');
    const replace = (organizationId: string, sealedCredential: string) =>
      connections.replaceCredential({
        organizationId,
        connectionId: id,
        sealedCredential,
        credentialUpdatedAt: replacedAt,
      });
    expect(await replace(ORG_B, 'sb1.foreign')).toEqual({ count: 0 });
    expect(
      await client.contentStudioAIConnection.findUniqueOrThrow({
        where: { id },
      })
    ).toMatchObject({
      sealedCredential: 'sb1.placeholder.not-a-real-envelope',
      lastValidationStatus: 'invalid',
    });
    expect(await replace(ORG_A, 'sb1.replaced')).toEqual({ count: 1 });
    expect(
      await client.contentStudioAIConnection.findUniqueOrThrow({
        where: { id },
        select: {
          sealedCredential: true,
          credentialUpdatedAt: true,
          lastValidatedAt: true,
          lastValidationStatus: true,
          lastValidationCode: true,
        },
      })
    ).toEqual({
      sealedCredential: 'sb1.replaced',
      credentialUpdatedAt: replacedAt,
      lastValidatedAt: null,
      lastValidationStatus: null,
      lastValidationCode: null,
    });
  });

  it('ACR5/ACR6/59 disables and enables for its own organization only; disabling is not archiving', async () => {
    const id = await createConnection(ORG_A);
    const disabledAt = new Date('2026-10-04T10:00:00.000Z');
    expect(await connections.disableConnection(ORG_B, id, disabledAt)).toEqual({
      count: 0,
    });
    expect(await connections.disableConnection(ORG_A, id, disabledAt)).toEqual({
      count: 1,
    });
    let row = await client.contentStudioAIConnection.findUniqueOrThrow({
      where: { id },
    });
    expect(row.disabledAt).toEqual(disabledAt);
    expect(row.archivedAt).toBeNull();
    expect(row.sealedCredential).not.toBeNull();
    // still listed and readable: a disabled connection is refused by the resolver
    expect(
      await connections.getConnectionForOrganization(ORG_A, id)
    ).not.toBeNull();
    expect(await connections.enableConnection(ORG_B, id)).toEqual({ count: 0 });
    expect(await connections.enableConnection(ORG_A, id)).toEqual({ count: 1 });
    row = await client.contentStudioAIConnection.findUniqueOrThrow({
      where: { id },
    });
    expect(row.disabledAt).toBeNull();
  });

  it('ACR7/ACR8/ACR9/57 archives for its own organization only, wiping the envelope in the same write', async () => {
    const id = await createConnection(ORG_A);
    const archivedAt = new Date('2026-10-05T10:00:00.000Z');
    expect(await connections.archiveConnection(ORG_B, id, archivedAt)).toEqual({
      count: 0,
    });
    expect(
      (
        await client.contentStudioAIConnection.findUniqueOrThrow({
          where: { id },
        })
      ).sealedCredential
    ).not.toBeNull();
    expect(await connections.archiveConnection(ORG_A, id, archivedAt)).toEqual({
      count: 1,
    });
    expect(
      await client.contentStudioAIConnection.findUniqueOrThrow({
        where: { id },
        select: { archivedAt: true, sealedCredential: true },
      })
    ).toEqual({ archivedAt, sealedCredential: null });
    expect(await connections.listConnectionsForOrganization(ORG_A)).toEqual([]);
    expect(
      await connections.getConnectionForOrganization(ORG_A, id)
    ).toBeNull();
    expect(
      await connections.getSealedCredentialForResolver(ORG_A, id)
    ).toBeNull();
    // archived is final: no write reaches it any more
    expect(await connections.archiveConnection(ORG_A, id, new Date())).toEqual({
      count: 0,
    });
    expect(await connections.enableConnection(ORG_A, id)).toEqual({ count: 0 });
    expect(
      await connections.replaceCredential({
        organizationId: ORG_A,
        connectionId: id,
        sealedCredential: 'sb1.revived',
        credentialUpdatedAt: new Date(),
      })
    ).toEqual({ count: 0 });
  });

  it('ACDB8/AWDB5/SEC3 the resolver read is organization scoped and is the only read of the envelope', async () => {
    const a = await createConnection(ORG_A);
    const b = await createConnection(ORG_B);
    expect(
      await connections.getSealedCredentialForResolver(ORG_A, b)
    ).toBeNull();
    expect(
      await connections.getSealedCredentialForResolver(ORG_B, a)
    ).toBeNull();
    expect(await connections.getSealedCredentialForResolver(ORG_A, a)).toEqual({
      id: a,
      provider: 'openai',
      sealedCredential: 'sb1.placeholder.not-a-real-envelope',
      disabledAt: null,
    });
  });
});

describe('AI connections: sealed credentials on PostgreSQL (local test keyring)', () => {
  const admin = (organizationId: string) => ({
    organization: {
      id: organizationId,
      users: [
        { role: 'ADMIN', disabled: false, userId: OWNER[organizationId] },
      ],
    },
    user: { id: OWNER[organizationId] },
  });
  const member = (organizationId: string) => ({
    organization: {
      id: organizationId,
      users: [{ role: 'USER', disabled: false, userId: OWNER[organizationId] }],
    },
    user: { id: OWNER[organizationId] },
  });
  const service = () =>
    new ContentStudioAIConnectionService(
      connections,
      new ContentStudioAIProviderResolver(connections, CODEX_GATE),
      CODEX_GATE
    );
  const create = (organizationId: string, apiKey = KEY_MARKER) =>
    service().createConnection(admin(organizationId), {
      name: 'Sealed',
      provider: 'openai',
      credential: { apiKey },
    });
  const envelopeOf = async (id: string) =>
    (
      await client.contentStudioAIConnection.findUniqueOrThrow({
        where: { id },
        select: { sealedCredential: true },
      })
    ).sealedCredential as string;

  it('SB1/SB2/SEC2 stores an envelope, never the key, and answers without either', async () => {
    const created = await create(ORG_A);
    const envelope = await envelopeOf(created.id);
    expect(envelope).not.toContain('DB_KEY_SECRET_789');
    expect(envelope.length).toBeGreaterThan(40);
    const rows = await client.contentStudioAIConnection.findMany({
      where: { organizationId: ORG_A },
    });
    expect(inspect(rows)).not.toMatch(DB_MARKERS);
    for (const answer of [
      created,
      await service().getConnection(ORG_A, created.id),
      ...(await service().listConnections(ORG_A)),
    ]) {
      expect(Object.keys(answer)).not.toEqual(
        expect.arrayContaining(['sealedCredential'])
      );
      expect(JSON.stringify(answer)).not.toMatch(
        /sealedCredential|apiKey|sb1\./
      );
      expect(JSON.stringify(answer)).not.toMatch(DB_MARKERS);
    }
  });

  it('SB1 a replaced key is sealed again, never stored in plain text', async () => {
    const created = await create(ORG_A);
    const before = await envelopeOf(created.id);
    await service().replaceCredential(admin(ORG_A), created.id, {
      apiKey: 'sk-DB_KEY_SECRET_789-replacement',
    });
    const after = await envelopeOf(created.id);
    expect(after).not.toBe(before);
    expect(after).not.toMatch(DB_MARKERS);
  });

  it('SB3 the resolver opens the envelope of its own organization and connection', async () => {
    const created = await create(ORG_A);
    const resolved = await new ContentStudioAIProviderResolver(
      connections,
      CODEX_GATE
    ).resolve({ organizationId: ORG_A, connectionId: created.id });
    expect(resolved.provider).toBe('openai');
    expect(resolved.connectionId).toBe(created.id);
    // the stored envelope opens to the key it was given (no provider call)
    expect(
      openContentStudioAICredential({
        organizationId: ORG_A,
        connectionId: created.id,
        provider: 'openai',
        envelope: await envelopeOf(created.id),
      }).apiKey
    ).toBe(KEY_MARKER);
  });

  it('SB4/SB5 an envelope moved to another connection or organization does not open', async () => {
    const source = await create(ORG_A);
    const sameOrg = await create(ORG_A, 'sk-other-key-of-org-a');
    const otherOrg = await create(ORG_B, 'sk-other-key-of-org-b');
    const envelope = await envelopeOf(source.id);
    for (const target of [sameOrg.id, otherOrg.id]) {
      await client.contentStudioAIConnection.update({
        where: { id: target },
        data: { sealedCredential: envelope },
      });
    }
    const resolver = new ContentStudioAIProviderResolver(
      connections,
      CODEX_GATE
    );
    for (const [organizationId, connectionId] of [
      [ORG_A, sameOrg.id],
      [ORG_B, otherOrg.id],
    ]) {
      const err = await resolver.resolve({ organizationId, connectionId }).then(
        () => {
          throw new Error('expected a refusal');
        },
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(ContentStudioAIResolutionError);
      expect((err as ContentStudioAIResolutionError).code).toBe(
        'CREDENTIAL_INVALID'
      );
      expect(inspect(err)).not.toMatch(DB_MARKERS);
    }
  });

  it('AUTH1/AUTH2 a USER member reads connections but may not change them; nothing is written', async () => {
    const created = await create(ORG_A);
    expect((await service().listConnections(ORG_A)).map((c) => c.id)).toEqual([
      created.id,
    ]);
    expect(
      await httpRefusal(
        service().createConnection(member(ORG_A), {
          name: 'Nope',
          provider: 'openai',
          credential: { apiKey: KEY_MARKER },
        })
      )
    ).toMatchObject({ status: 403, code: 'CS_AI_ADMIN_REQUIRED' });
    expect(
      (
        await httpRefusal(
          service().archiveConnection(member(ORG_A), created.id)
        )
      ).status
    ).toBe(403);
    expect(
      await client.contentStudioAIConnection.count({
        where: { organizationId: ORG_A },
      })
    ).toBe(1);
    expect((await envelopeOf(created.id)).length).toBeGreaterThan(0);
  });
});

describe('AI operations and usage: tenant keys enforced by PostgreSQL', () => {
  it('AODB1 an operation of org A on a connection and package of org A is stored', async () => {
    const { packageA, connectionA } = await operationFixture();
    const data = operationData(ORG_A, connectionA, packageA);
    await client.contentStudioAIOperation.create({ data });
    expect((await operationRow(data.id)).organizationId).toBe(ORG_A);
  });

  it('AODB2/AODB3 an operation of org A cannot point at a connection or package of org B', async () => {
    const { packageA, packageB, connectionA, connectionB } =
      await operationFixture();
    expect(
      await prismaCode(
        client.contentStudioAIOperation.create({
          data: operationData(ORG_A, connectionB, packageA),
        })
      )
    ).toBe('P2003');
    expect(
      await prismaCode(
        client.contentStudioAIOperation.create({
          data: operationData(ORG_A, connectionA, packageB),
        })
      )
    ).toBe('P2003');
    expect(
      await client.contentStudioAIOperation.count({
        where: { organizationId: { in: ORGS } },
      })
    ).toBe(0);
  });

  it('AODB4-AODB7 needs an existing connection, package, user and organization', async () => {
    const { packageA, connectionA } = await operationFixture();
    for (const data of [
      operationData(ORG_A, MISSING, packageA),
      operationData(ORG_A, connectionA, MISSING),
      operationData(ORG_A, connectionA, packageA, { userId: MISSING }),
      operationData(ORG_A, connectionA, packageA, { organizationId: MISSING }),
    ]) {
      expect(
        await prismaCode(client.contentStudioAIOperation.create({ data }))
      ).toBe('P2003');
    }
  });

  it('AODB8/AUDB1/AUDB2/AUDB3 usage belongs to an operation of its own organization', async () => {
    const operationId = await runningOperation();
    expect(
      await prismaCode(
        client.contentStudioAIUsage.create({
          data: usageData(ORG_B, operationId),
        })
      )
    ).toBe('P2003');
    expect(
      await prismaCode(
        client.contentStudioAIUsage.create({ data: usageData(ORG_A, MISSING) })
      )
    ).toBe('P2003');
    await client.contentStudioAIUsage.create({
      data: usageData(ORG_A, operationId),
    });
    expect(await usagesOf(operationId)).toHaveLength(1);
  });

  it('AUDB4/AUDB5/AUDB6 an attempt number is unique per operation', async () => {
    const operationId = await runningOperation();
    await client.contentStudioAIUsage.create({
      data: usageData(ORG_A, operationId, { attempt: 1 }),
    });
    expect(
      await prismaCode(
        client.contentStudioAIUsage.create({
          data: usageData(ORG_A, operationId, { attempt: 1 }),
        })
      )
    ).toBe('P2002');
    await client.contentStudioAIUsage.create({
      data: usageData(ORG_A, operationId, { attempt: 2 }),
    });
    expect((await usagesOf(operationId)).map((u) => u.attempt)).toEqual([1, 2]);
  });

  it('AUDB7/AUDB8 token counts are optional and a cost is stored exactly as given', async () => {
    const operationId = await runningOperation();
    const cost = BigInt('9007199254740993');
    await client.contentStudioAIUsage.create({
      data: usageData(ORG_A, operationId, {
        usageSource: 'provider',
        inputTokens: 12,
        providerCostMicros: cost,
        costCurrency: 'USD',
      }),
    });
    const [row] = await usagesOf(operationId);
    expect(row).toMatchObject({
      inputTokens: 12,
      outputTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      providerCostMicros: cost,
      costCurrency: 'USD',
    });
  });

  it('DOCUMENTED: the database accepts any currency text; only the execution service checks it', async () => {
    const operationId = await runningOperation();
    await client.contentStudioAIUsage.create({
      data: usageData(ORG_A, operationId, { costCurrency: 'credits' }),
    });
    expect((await usagesOf(operationId))[0].costCurrency).toBe('credits');
  });
});

describe('AI operation completion on PostgreSQL', () => {
  it('AOS1-AOS8 completes once: succeeded, its result hash and one usage row; a second completion changes nothing', async () => {
    const operationId = await runningOperation();
    const completedAt = new Date('2026-10-06T10:00:00.000Z');
    const resultHash = 'c'.repeat(64);
    expect(
      await operations.completeSucceededWithUsage({
        organizationId: ORG_A,
        operationId,
        completedAt,
        resultHash,
        usage: usage(),
      })
    ).toEqual({ completed: true });
    expect(await operationRow(operationId)).toMatchObject({
      status: 'succeeded',
      completedAt,
      resultHash,
      errorCode: null,
    });
    expect(await usagesOf(operationId)).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: 'succeeded',
        totalTokens: 30,
      }),
    ]);
    for (const again of [
      operations.completeSucceededWithUsage({
        organizationId: ORG_A,
        operationId,
        completedAt: new Date(),
        resultHash: 'd'.repeat(64),
        usage: usage({ attempt: 2 }),
      }),
      operations.completeFailedWithUsage({
        organizationId: ORG_A,
        operationId,
        completedAt: new Date(),
        errorCode: 'TIMEOUT',
        usage: usage({ attempt: 2, outcome: 'failed' }),
      }),
    ]) {
      expect(await again).toEqual({ completed: false });
    }
    expect(await operationRow(operationId)).toMatchObject({
      status: 'succeeded',
      completedAt,
      resultHash,
    });
    expect(await usagesOf(operationId)).toHaveLength(1);
  });

  it('AOF1-AOF5 fails once: its fixed code, no result hash, one failed usage row', async () => {
    const operationId = await runningOperation();
    expect(
      await operations.completeFailedWithUsage({
        organizationId: ORG_A,
        operationId,
        completedAt: new Date(),
        errorCode: 'RATE_LIMITED',
        usage: usage({
          outcome: 'failed',
          usageSource: 'none',
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
        }),
      })
    ).toEqual({ completed: true });
    expect(await operationRow(operationId)).toMatchObject({
      status: 'failed',
      errorCode: 'RATE_LIMITED',
      resultHash: null,
    });
    expect(
      await operations.completeFailedWithUsage({
        organizationId: ORG_A,
        operationId,
        completedAt: new Date(),
        errorCode: 'TIMEOUT',
        usage: usage({ attempt: 2, outcome: 'failed' }),
      })
    ).toEqual({ completed: false });
    expect((await usagesOf(operationId)).map((u) => u.outcome)).toEqual([
      'failed',
    ]);
    expect((await operationRow(operationId)).errorCode).toBe('RATE_LIMITED');
  });

  it('AOF6 another organization cannot complete the operation', async () => {
    const operationId = await runningOperation();
    for (const completion of [
      operations.completeSucceededWithUsage({
        organizationId: ORG_B,
        operationId,
        completedAt: new Date(),
        resultHash: 'e'.repeat(64),
        usage: usage(),
      }),
      operations.completeFailedWithUsage({
        organizationId: ORG_B,
        operationId,
        completedAt: new Date(),
        errorCode: 'TIMEOUT',
        usage: usage({ outcome: 'failed' }),
      }),
    ]) {
      expect(await completion).toEqual({ completed: false });
    }
    expect(await operationRow(operationId)).toMatchObject({
      status: 'running',
      completedAt: null,
    });
    expect(await usagesOf(operationId)).toEqual([]);
  });

  it('AOR1-AOR5 a usage row that cannot be written rolls the status change back', async () => {
    for (const complete of [
      (operationId: string) =>
        operations.completeSucceededWithUsage({
          organizationId: ORG_A,
          operationId,
          completedAt: new Date(),
          resultHash: 'f'.repeat(64),
          usage: usage(),
        }),
      (operationId: string) =>
        operations.completeFailedWithUsage({
          organizationId: ORG_A,
          operationId,
          completedAt: new Date(),
          errorCode: 'TIMEOUT',
          usage: usage({ outcome: 'failed' }),
        }),
    ]) {
      await cleanPhase2();
      const operationId = await runningOperation();
      // attempt 1 already exists, so the completion's usage insert collides
      // after its status update ran inside the same transaction
      await client.contentStudioAIUsage.create({
        data: usageData(ORG_A, operationId, {
          providerRequestId: 'pre-existing',
        }),
      });
      expect(await prismaCode(complete(operationId))).toBe('P2002');
      expect(await operationRow(operationId)).toMatchObject({
        status: 'running',
        completedAt: null,
        resultHash: null,
        errorCode: null,
      });
      expect(
        (await usagesOf(operationId)).map((u) => u.providerRequestId)
      ).toEqual(['pre-existing']);
    }
  });
});

describe('AI operation context on PostgreSQL', () => {
  it('OCDB1/OCDB2 stores old and current v1 contexts exactly', async () => {
    const { packageA, connectionA } = await operationFixture();
    const current = {
      v: 1,
      itemId: 'main',
      profiles: [
        {
          kind: 'writing',
          profileId: randomUUID(),
          revisionId: randomUUID(),
          revisionNumber: 4,
        },
        {
          kind: 'audience',
          profileId: randomUUID(),
          revisionId: randomUUID(),
          revisionNumber: 1,
        },
      ],
      editorialPolicy: { revisionId: randomUUID(), revisionNumber: 2 },
    };
    for (const context of [{ v: 1 }, { v: 1, itemId: 'main' }, current]) {
      const data = operationData(ORG_A, connectionA, packageA, { context });
      await client.contentStudioAIOperation.create({ data });
      const stored = (await operationRow(data.id)).context;
      expect(stored).toEqual(context);
      expect(parseContentStudioAIOperationContext(stored)).toEqual(context);
    }
  });

  it('DOCUMENTED OCDB3: PostgreSQL takes any JSON; only the application parser enforces the context shape', async () => {
    const { packageA, connectionA } = await operationFixture();
    const data = operationData(ORG_A, connectionA, packageA, {
      context: { v: 99, prompt: 'not checked by the database' },
    });
    await client.contentStudioAIOperation.create({ data });
    const stored = (await operationRow(data.id)).context;
    expect(stored).toEqual({ v: 99, prompt: 'not checked by the database' });
    expect(parseContentStudioAIOperationContext(stored)).toBeUndefined();
  });
});

// Writing (WP*), Audience (AP*) and Expertise (XP*) profiles share one design
describe.each(['writing', 'audience', 'expertise'] as Kind[])(
  '%s profiles on PostgreSQL',
  (kind) => {
    const repository = () => KINDS[kind].repository();
    const revisionRow = (
      profileId: string,
      revisionNumber: number,
      organizationId = ORG_A,
      createdById = OWNER[organizationId]
    ) =>
      KINDS[kind].revisions().create({
        data: {
          organizationId,
          profileId,
          revisionNumber,
          ...storedRevision[kind](`direct ${revisionNumber}`),
          createdById,
        },
        select: { id: true },
      });
    const revisionNumbers = async (profileId: string) =>
      (
        await KINDS[kind].revisions().findMany({
          where: { profileId },
          orderBy: { revisionNumber: 'asc' },
          select: { revisionNumber: true },
        })
      ).map((row: { revisionNumber: number }) => row.revisionNumber);
    const latest = async (profileId: string) =>
      (
        await KINDS[kind].profiles().findUniqueOrThrow({
          where: { id: profileId },
          select: { latestRevisionNumber: true },
        })
      ).latestRevisionNumber;
    const cas = (
      profileId: string,
      expectedLatestRevisionNumber: number,
      marker: string,
      organizationId = ORG_A
    ) =>
      repository().createRevisionWithCompareAndSwap({
        organizationId,
        profileId,
        expectedLatestRevisionNumber,
        revisionId: randomUUID(),
        revision: storedRevision[kind](marker),
        createdById: OWNER[organizationId],
      });

    it('PDB1/PDB2/PDB9 a profile and its revisions of the same organization are stored', async () => {
      const { profileId } = await profileWithRevision(kind);
      await revisionRow(profileId, 2);
      expect(await revisionNumbers(profileId)).toEqual([1, 2]);
    });

    it('PDB3 a revision of org B cannot point at a profile of org A', async () => {
      const { profileId } = await profileWithRevision(kind);
      expect(await prismaCode(revisionRow(profileId, 2, ORG_B))).toBe('P2003');
      expect(await revisionNumbers(profileId)).toEqual([1]);
    });

    it('PDB4/PDB5 a revision needs an existing profile and creator; a profile needs an existing creator', async () => {
      const { profileId } = await profileWithRevision(kind);
      expect(await prismaCode(revisionRow(MISSING, 1))).toBe('P2003');
      expect(await prismaCode(revisionRow(profileId, 2, ORG_A, MISSING))).toBe(
        'P2003'
      );
      expect(
        await prismaCode(
          KINDS[kind].profiles().create({
            data: {
              organizationId: ORG_A,
              name: 'x',
              latestRevisionNumber: 1,
              createdById: MISSING,
            },
          })
        )
      ).toBe('P2003');
    });

    it('PDB6/PDB7/PDB8 a revision number is unique per profile, not across profiles', async () => {
      const first = await profileWithRevision(kind);
      const second = await profileWithRevision(kind, ORG_A, 'second');
      expect(await prismaCode(revisionRow(first.profileId, 1))).toBe('P2002');
      await revisionRow(first.profileId, 2);
      await revisionRow(second.profileId, 2);
      expect(await revisionNumbers(first.profileId)).toEqual([1, 2]);
      expect(await revisionNumbers(second.profileId)).toEqual([1, 2]);
    });

    it('PA1-PA3 creates the profile and revision 1 together, for one organization and creator', async () => {
      const { profileId, revisionId } = await profileWithRevision(kind);
      expect(
        await KINDS[kind].profiles().findUniqueOrThrow({
          where: { id: profileId },
          select: {
            organizationId: true,
            createdById: true,
            latestRevisionNumber: true,
          },
        })
      ).toEqual({
        organizationId: ORG_A,
        createdById: USER_A,
        latestRevisionNumber: 1,
      });
      expect(
        await KINDS[kind].revisions().findUniqueOrThrow({
          where: { id: revisionId },
          select: {
            organizationId: true,
            createdById: true,
            profileId: true,
            revisionNumber: true,
          },
        })
      ).toEqual({
        organizationId: ORG_A,
        createdById: USER_A,
        profileId,
        revisionNumber: 1,
      });
    });

    it('PA4 leaves no profile when its first revision cannot be written', async () => {
      // the new revision reuses the id of an existing revision, so its
      // insert fails after the profile insert inside the same transaction
      const existing = await profileWithRevision(kind);
      const profileId = randomUUID();
      expect(
        await prismaCode(
          repository().createProfileWithFirstRevision({
            profileId,
            revisionId: existing.revisionId,
            organizationId: ORG_A,
            name: 'Rolled back',
            createdById: USER_A,
            revision: storedRevision[kind]('rolled back'),
          })
        )
      ).toBe('P2002');
      expect(
        await KINDS[kind].profiles().findUnique({ where: { id: profileId } })
      ).toBeNull();
    });

    it('PC1-PC5 two saves on the same base: exactly one revision 2, 5 races', async () => {
      for (let race = 0; race < 5; race++) {
        const { profileId } = await profileWithRevision(
          kind,
          ORG_A,
          `race ${race}`
        );
        const results = await Promise.allSettled([
          cas(profileId, 1, `left ${race}`),
          cas(profileId, 1, `right ${race}`),
        ]);
        const statuses = results
          .map((r) => {
            if (r.status !== 'fulfilled') {
              throw r.reason;
            }
            return r.value.status;
          })
          .sort();
        // the loser either read the old number and lost the update
        // ('changed'), or read the new one ('conflict')
        expect(['changed', 'conflict']).toContain(statuses[0]);
        expect(statuses[1]).toBe('created');
        expect(await latest(profileId)).toBe(2);
        expect(await revisionNumbers(profileId)).toEqual([1, 2]);
      }
    });

    it('PD1-PD4 the current content at the current base is unchanged; at a stale base it conflicts', async () => {
      const { profileId, revisionId } = await profileWithRevision(
        kind,
        ORG_A,
        'same'
      );
      const unchanged = await cas(profileId, 1, 'same r1');
      expect(unchanged).toMatchObject({
        status: 'unchanged',
        revision: { id: revisionId, revisionNumber: 1 },
      });
      expect(await latest(profileId)).toBe(1);
      expect(await revisionNumbers(profileId)).toEqual([1]);
      expect((await cas(profileId, 1, 'next')).status).toBe('created');
      // the content of revision 2, sent with the old base 1
      expect(await cas(profileId, 1, 'next')).toEqual({
        status: 'conflict',
        currentRevisionNumber: 2,
      });
      expect(await revisionNumbers(profileId)).toEqual([1, 2]);
    });

    it('PT1-PT5 org B can neither read nor change a profile of org A', async () => {
      const { profileId, revisionId } = await profileWithRevision(kind);
      expect(
        await repository().getProfileForOrganization(ORG_B, profileId)
      ).toBeNull();
      expect(
        await repository().getRevisionForProfile(ORG_B, profileId, revisionId)
      ).toBeNull();
      expect(
        await repository().getRevisionByNumber(ORG_B, profileId, 1)
      ).toBeNull();
      expect(
        await repository().listRevisionsForProfile({
          organizationId: ORG_B,
          profileId,
          skip: 0,
          take: 20,
        })
      ).toEqual([]);
      expect(
        await repository().updateProfileName(ORG_B, profileId, 'B')
      ).toEqual({ count: 0 });
      expect(
        await repository().archiveProfile(ORG_B, profileId, new Date())
      ).toEqual({ count: 0 });
      expect(await cas(profileId, 1, 'from b', ORG_B)).toEqual({
        status: 'not-found',
      });
      // archived by its own organization, org B still cannot restore it
      expect(
        await repository().archiveProfile(ORG_A, profileId, new Date())
      ).toEqual({ count: 1 });
      expect(await repository().restoreProfile(ORG_B, profileId)).toEqual({
        count: 0,
      });
      expect(
        await KINDS[kind].profiles().findUniqueOrThrow({
          where: { id: profileId },
          select: { name: true, latestRevisionNumber: true },
        })
      ).toEqual({ name: `P211 ${kind}`, latestRevisionNumber: 1 });
      expect(await revisionNumbers(profileId)).toEqual([1]);
    });

    it('PR1 archiving while a save waits: the save never adds a revision to the archived profile', async () => {
      const { profileId } = await profileWithRevision(kind);
      const archived = deferred();
      const release = deferred();
      // the archive holds the profile row locked until it is released
      const archive = client.$transaction(async (tx) => {
        await (tx as unknown as Record<string, Delegate>)[
          kind === 'writing'
            ? 'contentStudioWritingProfile'
            : kind === 'audience'
            ? 'contentStudioAudienceProfile'
            : 'contentStudioExpertiseProfile'
        ].updateMany({
          where: { id: profileId, organizationId: ORG_A, archivedAt: null },
          data: { archivedAt: new Date() },
        });
        archived.resolve();
        await release.promise;
      });
      await archived.promise;
      const save = cas(profileId, 1, 'during archive');
      release.resolve();
      await archive;
      // whether the save read the profile before or after the archive
      // committed, it cannot create a revision
      expect(['archived', 'changed']).toContain((await save).status);
      expect(await revisionNumbers(profileId)).toEqual([1]);
      expect(await latest(profileId)).toBe(1);
    });
  }
);

describe('Writing profile service on PostgreSQL', () => {
  it('a lost race is a fixed 409 with the current revision, never a database error', async () => {
    const service = new ContentStudioWritingProfileService(writingRepository);
    const { profileId } = await profileWithRevision('writing');
    const save = (marker: string) =>
      service.createRevision({
        organizationId: ORG_A,
        profileId,
        userId: USER_A,
        baseRevisionNumber: 1,
        content: writingContent(marker),
      });
    const results = await Promise.allSettled([save('left'), save('right')]);
    const created = results.filter((r) => r.status === 'fulfilled');
    expect(created).toHaveLength(1);
    const lost = results.find(
      (r) => r.status === 'rejected'
    ) as PromiseRejectedResult;
    expect(await httpRefusal(Promise.reject(lost.reason))).toEqual({
      status: 409,
      code: 'CS_PROFILE_REVISION_CONFLICT',
      msg: 'The writing profile changed. Reload it and try again.',
      currentRevisionNumber: 2,
    });
  });

  it('DOCUMENTED: PostgreSQL lets a direct write change a revision (no trigger); reading it back is an integrity error', async () => {
    const service = new ContentStudioWritingProfileService(writingRepository);
    const { profileId, revisionId } = await profileWithRevision('writing');
    await client.contentStudioWritingProfileRevision.update({
      where: { id: revisionId },
      data: { content: '{"tampered":true}' },
    });
    expect(
      (
        await client.contentStudioWritingProfileRevision.findUniqueOrThrow({
          where: { id: revisionId },
        })
      ).content
    ).toBe('{"tampered":true}');
    expect(await httpRefusal(service.getProfile(ORG_A, profileId))).toEqual({
      status: 500,
      code: 'CS_PROFILE_INTEGRITY_ERROR',
      msg: 'Stored writing profile data could not be verified.',
    });
  });

  it('DOCUMENTED: the same holds for policy, audience and expertise revisions: immutability is the application boundary', async () => {
    const policy = await policyWithRevision();
    const audience = await profileWithRevision('audience');
    const expertise = await profileWithRevision('expertise');
    for (const [delegate, id] of [
      [client.contentStudioEditorialPolicyRevision, policy.revisionId],
      [client.contentStudioAudienceProfileRevision, audience.revisionId],
      [client.contentStudioExpertiseProfileRevision, expertise.revisionId],
    ] as Array<[Delegate, string]>) {
      await delegate.update({
        where: { id },
        data: { contentHash: '0'.repeat(64) },
      });
      expect(
        (await delegate.findUniqueOrThrow({ where: { id } })).contentHash
      ).toBe('0'.repeat(64));
    }
  });
});

describe('Editorial policy on PostgreSQL', () => {
  const revisionRow = (
    policyId: string,
    revisionNumber: number,
    organizationId = ORG_A
  ) =>
    client.contentStudioEditorialPolicyRevision.create({
      data: {
        organizationId,
        policyId,
        revisionNumber,
        ...storedPolicy(`direct ${revisionNumber}`),
        createdById: OWNER[organizationId],
      },
      select: { id: true },
    });
  const policyRows = (organizationId = ORG_A) =>
    client.contentStudioEditorialPolicy.findMany({
      where: { organizationId },
      select: { id: true, latestRevisionNumber: true },
    });
  const revisionNumbers = async (organizationId = ORG_A) =>
    (
      await client.contentStudioEditorialPolicyRevision.findMany({
        where: { organizationId },
        orderBy: { revisionNumber: 'asc' },
        select: { revisionNumber: true },
      })
    ).map((row) => row.revisionNumber);
  const service = () =>
    new ContentStudioEditorialPolicyService(editorialRepository);
  const save = (
    baseRevisionNumber: number,
    marker: string,
    organizationId = ORG_A
  ) =>
    service().createRevision({
      organizationId,
      userId: OWNER[organizationId],
      // the request membership: these saves leave the approval switch off
      memberships: [{ role: 'USER', userId: OWNER[organizationId] }],
      baseRevisionNumber,
      content: editorialContent(marker),
    });

  it('EPDB1-EPDB4 one policy per organization; revisions point at a policy of their own organization', async () => {
    const { policyId } = await policyWithRevision();
    expect(
      await prismaCode(
        client.contentStudioEditorialPolicy.create({
          data: {
            organizationId: ORG_A,
            latestRevisionNumber: 1,
            createdById: USER_A,
          },
        })
      )
    ).toBe('P2002');
    await policyWithRevision(ORG_B);
    expect(await prismaCode(revisionRow(policyId, 2, ORG_B))).toBe('P2003');
    expect(await prismaCode(revisionRow(policyId, 1))).toBe('P2002');
    await revisionRow(policyId, 2);
    expect(await revisionNumbers()).toEqual([1, 2]);
    expect(await policyRows()).toHaveLength(1);
  });

  it('EPA1-EPA5 the first save creates the policy at revision 1, for one organization and creator', async () => {
    const result = await save(0, 'first');
    expect(result).toMatchObject({
      created: true,
      latestRevisionNumber: 1,
      revision: { revisionNumber: 1 },
    });
    const [policy] = await policyRows();
    expect(policy.latestRevisionNumber).toBe(1);
    expect(
      await client.contentStudioEditorialPolicyRevision.findMany({
        where: { policyId: policy.id },
        select: {
          revisionNumber: true,
          organizationId: true,
          createdById: true,
        },
      })
    ).toEqual([
      { revisionNumber: 1, organizationId: ORG_A, createdById: USER_A },
    ]);
  });

  it('EPA6 leaves no policy when its first revision cannot be written', async () => {
    const other = await policyWithRevision(ORG_B);
    expect(
      await prismaCode(
        editorialRepository.createPolicyWithFirstRevision({
          policyId: randomUUID(),
          revisionId: other.revisionId,
          organizationId: ORG_A,
          createdById: USER_A,
          revision: storedPolicy('rolled back'),
        })
      )
    ).toBe('P2002');
    expect(await policyRows()).toEqual([]);
  });

  it('EPR1-EPR5/60 two first saves at once: one policy, one revision 1; the loser gets a fixed 409 at revision 1, 5 races', async () => {
    for (let race = 0; race < 5; race++) {
      await client.contentStudioEditorialPolicyRevision.deleteMany({
        where: { organizationId: ORG_A },
      });
      await client.contentStudioEditorialPolicy.deleteMany({
        where: { organizationId: ORG_A },
      });
      const results = await Promise.allSettled([
        save(0, `left ${race}`),
        save(0, `right ${race}`),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find(
        (r) => r.status === 'rejected'
      ) as PromiseRejectedResult;
      const refusal = await httpRefusal(Promise.reject(lost.reason));
      expect(refusal).toEqual({
        status: 409,
        code: 'CS_PROFILE_REVISION_CONFLICT',
        msg: 'The editorial policy changed. Reload it and try again.',
        currentRevisionNumber: 1,
      });
      const policies = await policyRows();
      expect(policies).toHaveLength(1);
      expect(JSON.stringify(refusal)).not.toContain(policies[0].id);
      expect(policies[0].latestRevisionNumber).toBe(1);
      expect(await revisionNumbers()).toEqual([1]);
    }
  });

  it('EPC1-EPC4 two saves on revision 1 at once: one revision 2, the loser a fixed 409 at revision 2', async () => {
    await save(0, 'base');
    const results = await Promise.allSettled([
      save(1, 'left'),
      save(1, 'right'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find(
      (r) => r.status === 'rejected'
    ) as PromiseRejectedResult;
    expect(await httpRefusal(Promise.reject(lost.reason))).toMatchObject({
      status: 409,
      code: 'CS_PROFILE_REVISION_CONFLICT',
      currentRevisionNumber: 2,
    });
    expect((await policyRows())[0].latestRevisionNumber).toBe(2);
    expect(await revisionNumbers()).toEqual([1, 2]);
  });

  it('EPC1-EPC4 the repository compare-and-swap lets exactly one writer through, 5 races', async () => {
    for (let race = 0; race < 5; race++) {
      await client.contentStudioEditorialPolicyRevision.deleteMany({
        where: { organizationId: ORG_A },
      });
      await client.contentStudioEditorialPolicy.deleteMany({
        where: { organizationId: ORG_A },
      });
      await policyWithRevision(ORG_A, `race ${race}`);
      const results = await Promise.allSettled(
        ['left', 'right'].map((side) =>
          editorialRepository.createRevisionWithCompareAndSwap({
            organizationId: ORG_A,
            expectedLatestRevisionNumber: 1,
            revisionId: randomUUID(),
            revision: storedPolicy(`${side} ${race}`),
            createdById: USER_A,
          })
        )
      );
      const statuses = results
        .map((r) => {
          if (r.status !== 'fulfilled') {
            throw r.reason;
          }
          return r.value.status;
        })
        .sort();
      expect(['changed', 'conflict']).toContain(statuses[0]);
      expect(statuses[1]).toBe('created');
      expect(await revisionNumbers()).toEqual([1, 2]);
    }
  });

  it('EPC5/EPC6 the current content is unchanged at the current base and a conflict at a stale one', async () => {
    await save(0, 'same');
    expect(await save(1, 'same')).toMatchObject({
      created: false,
      revision: { revisionNumber: 1 },
    });
    expect(await revisionNumbers()).toEqual([1]);
    await save(1, 'next');
    expect(await httpRefusal(save(1, 'next'))).toMatchObject({
      status: 409,
      currentRevisionNumber: 2,
    });
    expect(await revisionNumbers()).toEqual([1, 2]);
  });

  it('PT6-PT9 org B reads only its own policy and cannot add to the policy of org A', async () => {
    const { policyId, revisionId } = await policyWithRevision();
    expect(
      await editorialRepository.getPolicyForOrganization(ORG_B)
    ).toBeNull();
    expect(
      await editorialRepository.getRevisionForPolicy(
        ORG_B,
        policyId,
        revisionId
      )
    ).toBeNull();
    expect(
      await editorialRepository.getRevisionByNumber(ORG_B, policyId, 1)
    ).toBeNull();
    expect(
      await editorialRepository.listRevisionsForPolicy({
        organizationId: ORG_B,
        policyId,
        skip: 0,
        take: 20,
      })
    ).toEqual([]);
    expect(
      await editorialRepository.createRevisionWithCompareAndSwap({
        organizationId: ORG_B,
        expectedLatestRevisionNumber: 1,
        revisionId: randomUUID(),
        revision: storedPolicy('from b'),
        createdById: USER_B,
      })
    ).toEqual({ status: 'not-found' });
    // org B saving revision 1 makes its own policy, never touching A's
    expect(await save(0, 'b own', ORG_B)).toMatchObject({ created: true });
    expect(await revisionNumbers(ORG_A)).toEqual([1]);
    expect((await policyRows(ORG_A))[0].id).toBe(policyId);
  });
});

describe('AI execution and AI writing on PostgreSQL (fake adapter, no network)', () => {
  // A resolver that never opens a credential or makes a client: the adapter
  // is a fake that answers in memory
  const fakeResolver = (answer: () => Promise<ContentStudioAITextResult>) => {
    const adapter = {
      provider: 'openai' as const,
      validateConnection: jest.fn(),
      generateText: jest.fn(answer),
    };
    const resolver = {
      resolve: jest.fn(
        async (where: { organizationId: string; connectionId: string }) => {
          const row = await connections.getSealedCredentialForResolver(
            where.organizationId,
            where.connectionId
          );
          if (!row) {
            throw new ContentStudioAIResolutionError('NOT_FOUND');
          }
          return { connectionId: row.id, provider: 'openai' as const, adapter };
        }
      ),
    };
    return { adapter, resolver };
  };
  const execution = (resolver: unknown) =>
    new ContentStudioAIExecutionService(
      packages,
      resolver as ContentStudioAIProviderResolver,
      operations
    );
  const writing = (resolver: unknown) =>
    new ContentStudioAIWritingService(
      packages,
      writingRepository,
      editorialRepository,
      audienceRepository,
      expertiseRepository,
      execution(resolver),
      sourceRepository
    );
  const answer = (text: string): ContentStudioAITextResult => ({
    text,
    finishReason: 'stop',
    usage: { inputTokens: 100, outputTokens: 40 },
    providerRequestId: 'req_p211_fake',
  });
  // every column of every operation and usage row of both organizations
  const storedRows = async () =>
    inspect(
      [
        await client.contentStudioAIOperation.findMany({
          where: { organizationId: { in: ORGS } },
        }),
        await client.contentStudioAIUsage.findMany({
          where: { organizationId: { in: ORGS } },
        }),
      ],
      { depth: 10 }
    );

  it('SEC5/SEC6/37 a run stores hashes, ids and usage only: never the prompt, the answer or a key', async () => {
    const packageId = await createPackage(ORG_A);
    const connectionId = await createConnection(ORG_A);
    const { adapter, resolver } = fakeResolver(async () =>
      answer(`${RESULT_MARKER} A brighter spring.`)
    );
    const result = await execution(resolver).execute({
      organizationId: ORG_A,
      userId: USER_A,
      connectionId,
      packageId,
      kind: 'generate_item',
      model: 'gpt-6.1-sol',
      promptVersion: 'cs-generate-item-v1',
      baseDraftVersion: 1,
      context: { v: 1, itemId: 'main' },
      request: {
        model: 'gpt-6.1-sol',
        system: `${PROMPT_MARKER} system`,
        prompt: `${PROMPT_MARKER} prompt ${KEY_MARKER}`,
        output: { type: 'text' },
        maxOutputTokens: 500,
      },
    });
    expect(result.result.text).toContain(RESULT_MARKER);
    expect(adapter.generateText).toHaveBeenCalledTimes(1);
    const row = await operationRow(result.operationId);
    expect(row).toMatchObject({
      status: 'succeeded',
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      resultHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(await usagesOf(result.operationId)).toEqual([
      expect.objectContaining({
        attempt: 1,
        inputTokens: 100,
        outputTokens: 40,
      }),
    ]);
    expect(await storedRows()).not.toMatch(DB_MARKERS);
  });

  it('SEC5/SEC6 a refused answer is a failed operation that stores none of it either', async () => {
    const packageId = await createPackage(ORG_A);
    const connectionId = await createConnection(ORG_A);
    const { resolver } = fakeResolver(async () =>
      answer(`{"items":[ ${RESULT_MARKER}`)
    );
    const err = await writing(resolver)
      .proposeThread({
        organizationId: ORG_A,
        userId: USER_A,
        packageId,
        operation: 'generate_thread',
        selection: {
          connectionId,
          model: 'gpt-6.1-sol',
          baseDraftVersion: 1,
          instruction: `${PROMPT_MARKER} instruction`,
        },
      })
      .then(
        () => {
          throw new Error('expected a refusal');
        },
        (e: unknown) => e
      );
    expect((err as HttpException).getResponse()).toMatchObject({
      code: 'CS_AI_INVALID_RESPONSE',
    });
    const [operation] = await client.contentStudioAIOperation.findMany({
      where: { organizationId: ORG_A },
    });
    expect(operation).toMatchObject({
      status: 'failed',
      errorCode: 'INVALID_RESPONSE',
      resultHash: null,
    });
    expect(await storedRows()).not.toMatch(DB_MARKERS);
  });

  it('AUTH7/OCDB2 a USER member gets a proposal; the operation records the exact revisions and no text', async () => {
    const packageId = await createPackage(ORG_A, `${PROMPT_MARKER} draft`);
    const connectionId = await createConnection(ORG_A);
    const writingProfile = await profileWithRevision(
      'writing',
      ORG_A,
      PROMPT_MARKER
    );
    const policy = await policyWithRevision(ORG_A, PROMPT_MARKER);
    const audience = await profileWithRevision(
      'audience',
      ORG_A,
      PROMPT_MARKER
    );
    const expertise = await profileWithRevision(
      'expertise',
      ORG_A,
      PROMPT_MARKER
    );
    const { adapter, resolver } = fakeResolver(async () =>
      answer(`${RESULT_MARKER} suggestion`)
    );
    const value = await writing(resolver).proposeItem({
      organizationId: ORG_A,
      userId: USER_A,
      packageId,
      operation: 'rewrite_item',
      itemId: 'main',
      selection: {
        connectionId,
        model: 'gpt-6.1-sol',
        baseDraftVersion: 1,
        writingProfileId: writingProfile.profileId,
        editorialPolicy: true,
        audienceProfileId: audience.profileId,
        expertiseProfileId: expertise.profileId,
        instruction: `${PROMPT_MARKER} instruction`,
      },
    });
    expect(value.proposal).toEqual({
      type: 'item',
      itemId: 'main',
      text: `${RESULT_MARKER} suggestion`,
    });
    // the provider got the profile content and draft text, in memory
    const [request] = adapter.generateText.mock.calls[0] as unknown as [
      { prompt: string }
    ];
    expect(request.prompt).toContain(PROMPT_MARKER);
    expect((await operationRow(value.operationId)).context).toEqual({
      v: 1,
      itemId: 'main',
      profiles: [
        {
          kind: 'writing',
          profileId: writingProfile.profileId,
          revisionId: writingProfile.revisionId,
          revisionNumber: 1,
        },
        {
          kind: 'audience',
          profileId: audience.profileId,
          revisionId: audience.revisionId,
          revisionNumber: 1,
        },
        {
          kind: 'expertise',
          profileId: expertise.profileId,
          revisionId: expertise.revisionId,
          revisionNumber: 1,
        },
      ],
      editorialPolicy: { revisionId: policy.revisionId, revisionNumber: 1 },
    });
    expect(await storedRows()).not.toMatch(DB_MARKERS);
    // the draft itself is untouched: a proposal is never saved
    expect(
      await client.contentPackage.findUniqueOrThrow({
        where: { id: packageId },
        select: { draftVersion: true, draft: true },
      })
    ).toEqual({ draftVersion: 1, draft: draftJson(`${PROMPT_MARKER} draft`) });
  });

  it.each([
    ['AWDB1 a Writing Profile', 'writingProfileId'],
    ['AWDB2 an Audience Profile', 'audienceProfileId'],
    ['AWDB3 an Expertise Profile', 'expertiseProfileId'],
  ] as const)(
    '%s of org B is not available to org A, and nothing runs',
    async (_name, field) => {
      const packageId = await createPackage(ORG_A);
      const connectionId = await createConnection(ORG_A);
      const kind = field.replace('ProfileId', '') as Kind;
      const foreign = await profileWithRevision(kind, ORG_B);
      const { adapter, resolver } = fakeResolver(async () => answer('x'));
      expect(
        await httpRefusal(
          writing(resolver).proposeItem({
            organizationId: ORG_A,
            userId: USER_A,
            packageId,
            operation: 'rewrite_item',
            itemId: 'main',
            selection: {
              connectionId,
              model: 'gpt-6.1-sol',
              baseDraftVersion: 1,
              [field]: foreign.profileId,
            },
          })
        )
      ).toEqual({
        status: 400,
        code: 'CS_AI_CONTEXT_NOT_FOUND',
        msg: 'The selected AI context is not available.',
      });
      expect(adapter.generateText).not.toHaveBeenCalled();
      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(
        await client.contentStudioAIOperation.count({
          where: { organizationId: { in: ORGS } },
        })
      ).toBe(0);
    }
  );

  it('AWDB4 the editorial policy of org B is not the policy of org A', async () => {
    const packageId = await createPackage(ORG_A);
    const connectionId = await createConnection(ORG_A);
    await policyWithRevision(ORG_B);
    const { adapter, resolver } = fakeResolver(async () => answer('x'));
    expect(
      (
        await httpRefusal(
          writing(resolver).proposeItem({
            organizationId: ORG_A,
            userId: USER_A,
            packageId,
            operation: 'rewrite_item',
            itemId: 'main',
            selection: {
              connectionId,
              model: 'gpt-6.1-sol',
              baseDraftVersion: 1,
              editorialPolicy: true,
            },
          })
        )
      ).code
    ).toBe('CS_AI_CONTEXT_NOT_FOUND');
    expect(adapter.generateText).not.toHaveBeenCalled();
  });

  it('AWDB5 a connection of org B is not available to org A with the real resolver, and nothing is stored', async () => {
    const packageId = await createPackage(ORG_A);
    const connectionB = await createConnection(ORG_B);
    expect(
      await httpRefusal(
        writing(
          new ContentStudioAIProviderResolver(connections, CODEX_GATE)
        ).proposeItem({
          organizationId: ORG_A,
          userId: USER_A,
          packageId,
          operation: 'rewrite_item',
          itemId: 'main',
          selection: {
            connectionId: connectionB,
            model: 'gpt-6.1-sol',
            baseDraftVersion: 1,
          },
        })
      )
    ).toEqual({
      status: 400,
      code: 'CS_AI_CONNECTION_REQUIRED',
      msg: 'Select an available AI connection.',
    });
    expect(
      await client.contentStudioAIOperation.count({
        where: { organizationId: { in: ORGS } },
      })
    ).toBe(0);
  });

  it('a package of org B is not found for org A, and a stale draft version runs nothing', async () => {
    const packageB = await createPackage(ORG_B);
    const packageA = await createPackage(ORG_A);
    const connectionId = await createConnection(ORG_A);
    const { adapter, resolver } = fakeResolver(async () => answer('x'));
    const run = (packageId: string, baseDraftVersion: number) =>
      writing(resolver).proposeItem({
        organizationId: ORG_A,
        userId: USER_A,
        packageId,
        operation: 'rewrite_item',
        itemId: 'main',
        selection: { connectionId, model: 'gpt-6.1-sol', baseDraftVersion },
      });
    expect((await httpRefusal(run(packageB, 1))).status).toBe(404);
    expect((await httpRefusal(run(packageA, 2))).code).toBe(
      'CS_DRAFT_VERSION_CONFLICT'
    );
    expect(adapter.generateText).not.toHaveBeenCalled();
  });

  it('a provider failure is stored as a failed operation with its normalized code only', async () => {
    const packageId = await createPackage(ORG_A);
    const connectionId = await createConnection(ORG_A);
    const { resolver } = fakeResolver(async () => {
      throw new ContentStudioAIProviderError('RATE_LIMITED', {
        providerRequestId: 'req_p211_limited',
      });
    });
    expect(
      (
        await httpRefusal(
          writing(resolver).proposeItem({
            organizationId: ORG_A,
            userId: USER_A,
            packageId,
            operation: 'rewrite_item',
            itemId: 'main',
            selection: {
              connectionId,
              model: 'gpt-6.1-sol',
              baseDraftVersion: 1,
              instruction: PROMPT_MARKER,
            },
          })
        )
      ).status
    ).toBe(429);
    const [operation] = await client.contentStudioAIOperation.findMany({
      where: { organizationId: ORG_A },
    });
    expect(operation).toMatchObject({
      status: 'failed',
      errorCode: 'RATE_LIMITED',
    });
    expect(await usagesOf(operation.id)).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        usageSource: 'none',
        providerRequestId: 'req_p211_limited',
      }),
    ]);
    expect(await storedRows()).not.toMatch(DB_MARKERS);
  });
});
