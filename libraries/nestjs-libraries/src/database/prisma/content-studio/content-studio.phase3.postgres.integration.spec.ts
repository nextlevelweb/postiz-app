import { inspect } from 'util';
import { createHash, randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioAIConnectionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.repository';
import { ContentStudioAIOperationRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-operation.repository';
import { ContentStudioWritingProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.writing-profile.repository';
import { ContentStudioEditorialPolicyRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.repository';
import { ContentStudioAudienceProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.audience-profile.repository';
import { ContentStudioExpertiseProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.expertise-profile.repository';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import { ContentStudioSourceCaptureAttemptRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-capture-attempt.repository';
import { ContentStudioSourceDiscoveryRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-discovery.repository';
import { ContentStudioAIWritingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-writing.service';
import { ContentStudioAIExecutionService } from '@gitroom/nestjs-libraries/content-studio/ai/ai.execution.service';
import { ContentStudioAIProviderResolver } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.resolver';
import {
  ContentStudioAIProviderError,
  ContentStudioAIResolutionError,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import { ContentStudioAITextResult } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';
import { parseContentStudioAIOperationContext } from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.types';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import { sha256Hex } from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  ContentStudioSourceVersionData,
  ContentStudioSourceVersionError,
  parseContentStudioSourceVersionInput,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.version';
import { createContentStudioPostgresClient } from '../../../../../../jest.content-studio.postgres.guard';

// Phase 3 on a real PostgreSQL (P3-06): sources, their immutable versions and
// the source grounding of AI writing. Opt-in: runs only through
// jest.content-studio.integration.config.ts against the disposable local
// database (see jest.content-studio.postgres.guard.ts). The repositories and
// services run unchanged; Prisma is used directly only to build fixtures, read
// final state and bypass the repositories on purpose, to prove what the
// database itself enforces and what only the application does.
//
// Nothing is fetched: a version is appended through the repository with the
// trusted, parsed input server-side ingestion would hand it after its fetch,
// and AI adapters are in-memory fakes. fetch and SafeFetch fail the test if
// anything calls them. Concurrency is ordered with promise barriers placed in
// the transaction the repository is given (a test object, not a production
// hook), and races are judged by their final state, never by timing

const mockSafeFetch = jest.fn(() => {
  throw new Error('SafeFetch in the PostgreSQL integration suite');
});
jest.mock('@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch', () => ({
  ...jest.requireActual('@gitroom/nestjs-libraries/dtos/webhooks/safe.fetch'),
  safeFetch: (...args: unknown[]) => mockSafeFetch(...(args as [])),
}));

// Separate from the Phase 1 and Phase 2 fixtures: their own organizations
// and users, all uuids (the AI execution service only accepts uuids)
const ORG_A = '30600000-0000-4000-8000-00000000000a';
const ORG_B = '30600000-0000-4000-8000-00000000000b';
const USER_A1 = '30600000-0000-4000-8000-0000000000a1';
const USER_A2 = '30600000-0000-4000-8000-0000000000a2';
const USER_B1 = '30600000-0000-4000-8000-0000000000b1';
const MISSING = '30600000-0000-4000-8000-0000000000ff';
const ORGS = [ORG_A, ORG_B];
const USERS = [USER_A1, USER_A2, USER_B1];
const OWNER: Record<string, string> = { [ORG_A]: USER_A1, [ORG_B]: USER_B1 };

// Source text and metadata markers: they belong in the source tables, may
// reach the provider prompt (except the URL), and must never be copied into
// an AI operation or usage row
const PROMPT_MARKER = 'DB_SOURCE_PROMPT_PRIVATE_123';
const TITLE_MARKER = 'DB_SOURCE_TITLE_PRIVATE_456';
const URL_MARKER = 'DB_SOURCE_URL_PRIVATE_789';
const NAME_MARKER = 'DB_SOURCE_NAME_PRIVATE_111';
const SERVICE_MARKER = 'P3_DB_PRIVATE_SOURCE_123';
const CORRUPT_MARKER = 'P3_AI_CORRUPT_PRIVATE_456';
const SOURCE_MARKERS = new RegExp(
  [PROMPT_MARKER, TITLE_MARKER, URL_MARKER, NAME_MARKER, CORRUPT_MARKER].join(
    '|'
  )
);

let client: PrismaClient;
let prisma: PrismaService;
let packages: ContentStudioRepository;
let connections: ContentStudioAIConnectionRepository;
let operations: ContentStudioAIOperationRepository;
let writingRepository: ContentStudioWritingProfileRepository;
let editorialRepository: ContentStudioEditorialPolicyRepository;
let audienceRepository: ContentStudioAudienceProfileRepository;
let expertiseRepository: ContentStudioExpertiseProfileRepository;
let sources: ContentStudioSourceRepository;
let sourceService: ContentStudioSourceService;
let fetchSpy: jest.SpyInstance;

// --- source fixtures ---
const T1 = new Date('2026-10-01T10:00:00.000Z');
const T2 = new Date('2026-10-02T10:00:00.000Z');
const url = (path = 'article') =>
  `https://example.com/${path}?private=${URL_MARKER}`;
const hashOf = (text: string) =>
  createHash('sha256').update(text).digest('hex');

// The trusted capture server-side ingestion appends after its fetch, parsed
// by the same function it uses
const capture = (
  marker = PROMPT_MARKER,
  overrides: Record<string, unknown> = {}
): ContentStudioSourceVersionData =>
  parseContentStudioSourceVersionInput({
    requestedUrl: url(),
    finalUrl: url(),
    redirectCount: 0,
    fetchedAt: T1,
    httpStatus: 200,
    contentType: 'text/html; charset=utf-8',
    contentLength: 2048,
    title: `${TITLE_MARKER} Annual report`,
    sourceHash: hashOf(`fetched bytes ${marker}`),
    extractionVersion: 'content-studio-source-v2',
    content: {
      schemaVersion: 1,
      blocks: [
        { id: 'h1', type: 'heading', text: 'Results', level: 1 },
        { id: 'p1', type: 'paragraph', text: `${marker} grew.`, level: null },
      ],
    },
    ...overrides,
  });

// far below the organization limits (P8-C1 has its own suite)
const createSource = async (
  organizationId: string,
  overrides: { name?: string; canonicalUrl?: string; createdById?: string } = {}
) => {
  const result = await sources.createSourcesWithinLimit({
    organizationId,
    kind: 'url',
    createdById: overrides.createdById ?? OWNER[organizationId],
    limit: 1000,
    sources: [
      {
        id: randomUUID(),
        name: overrides.name ?? `${NAME_MARKER} report`,
        canonicalUrl: overrides.canonicalUrl ?? url(randomUUID()),
      },
    ],
  });
  if (result.status !== 'decided' || result.results[0].status !== 'created') {
    throw new Error('source not created');
  }
  return result.results[0].source.id;
};
const restore = (organizationId: string, id: string) =>
  sources.restoreSourceWithinLimit({
    organizationId,
    id,
    activeFeedsMax: 1000,
  });

const append = (
  organizationId: string,
  sourceId: string,
  expectedLatestVersionNumber: number,
  version: ContentStudioSourceVersionData = capture(),
  options: {
    versionId?: string;
    createdById?: string;
    repository?: ContentStudioSourceRepository;
  } = {}
) =>
  (options.repository ?? sources).appendVersionWithCompareAndSwap({
    organizationId,
    sourceId,
    expectedLatestVersionNumber,
    versionId: options.versionId ?? randomUUID(),
    version,
    createdById: options.createdById ?? OWNER[organizationId],
    validators: { mode: 'replace', etag: null, lastModified: null },
  });

// A source of the organization with its first capture
const capturedSource = async (
  organizationId = ORG_A,
  version: ContentStudioSourceVersionData = capture()
) => {
  const sourceId = await createSource(organizationId);
  const result = await append(organizationId, sourceId, 0, version);
  if (result.status !== 'created') {
    throw new Error('fixture capture failed');
  }
  return { sourceId, versionId: result.version.id };
};

const sourceRow = (id: string) =>
  client.contentStudioSource.findUniqueOrThrow({ where: { id } });
const versionsOf = (sourceId: string) =>
  client.contentStudioSourceVersion.findMany({
    where: { sourceId },
    orderBy: { versionNumber: 'asc' },
  });

// A version row written directly, bypassing the repository
const versionRow = (
  organizationId: string,
  sourceId: string,
  versionNumber: number,
  overrides: Partial<Prisma.ContentStudioSourceVersionUncheckedCreateInput> = {}
): Prisma.ContentStudioSourceVersionUncheckedCreateInput => {
  const data = capture();
  return {
    id: randomUUID(),
    organizationId,
    sourceId,
    versionNumber,
    schemaVersion: data.schemaVersion,
    extractionVersion: data.extractionVersion,
    requestedUrl: data.requestedUrl,
    finalUrl: data.finalUrl,
    redirectCount: data.redirectCount,
    fetchedAt: data.fetchedAt,
    httpStatus: data.httpStatus,
    contentType: data.contentType,
    contentLength: data.contentLength,
    title: data.title,
    content: data.content,
    contentHash: data.contentHash,
    sourceHash: data.sourceHash,
    createdById: OWNER[organizationId],
    ...overrides,
  };
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
// Prisma code, SQL, a constraint name, a stored value or another
// organization's id
const httpRefusal = async (call: Promise<unknown>, hidden: string[] = []) => {
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
  };
  const text = `${JSON.stringify(body)} ${(err as Error).message}`;
  expect(text).not.toMatch(
    /P20\d\d|constraint|_fkey|_key\b|prisma|INSERT INTO|UPDATE "|SELECT "|"ContentStudio/i
  );
  expect(text).not.toMatch(SOURCE_MARKERS);
  expect(text).not.toContain(SERVICE_MARKER);
  for (const value of hidden) {
    expect(text).not.toContain(value);
  }
  // a fixed code and message, at most with a retry hint
  expect(
    Object.keys(body).filter((key) => key !== 'code' && key !== 'msg')
  ).toEqual(Object.keys(body).filter((key) => /^retryAfter/.test(key)));
  return { status: (err as HttpException).getStatus(), ...body };
};

// --- barriers: no sleeps. A latch opens once `parties` callers arrived; the
// timer only turns a deadlock into a failure, it never orders anything ---
const latch = (parties: number) => {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return async () => {
    arrived += 1;
    if (arrived >= parties) {
      open();
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      opened,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('barrier not reached: deadlock')),
          4000
        );
      }),
    ]).finally(() => clearTimeout(timer));
  };
};

// The repository with a transaction that runs `beforeCas` right before its
// compare-and-swap update and `afterCas` right after it, inside the same
// transaction. Everything else is the real client
const hookedSources = (hooks: {
  beforeCas?: () => Promise<void>;
  afterCas?: () => Promise<void>;
}) => {
  const transaction = {
    model: {
      $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        client.$transaction((tx) =>
          fn(
            new Proxy(tx, {
              get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver);
                if (property !== 'contentStudioSource') {
                  return value;
                }
                return new Proxy(value, {
                  get(model, name, modelReceiver) {
                    const original = Reflect.get(model, name, modelReceiver);
                    if (name !== 'updateMany') {
                      return original;
                    }
                    return async (args: unknown) => {
                      await hooks.beforeCas?.();
                      const result = await original.call(model, args);
                      await hooks.afterCas?.();
                      return result;
                    };
                  },
                });
              },
            })
          )
        ),
    },
  } as unknown as PrismaTransaction;
  return new ContentStudioSourceRepository(
    new PrismaRepository<'contentStudioSource'>(prisma),
    new PrismaRepository<'contentStudioSourceVersion'>(prisma),
    transaction
  );
};

// --- package, connection and AI writing fixtures ---
const draftJson = (text: string) =>
  JSON.stringify(
    parseContentPackageDraft({
      schemaVersion: 1,
      copy: { global: { thread: [{ id: 'main', text, mediaIds: [] }] } },
    })
  );

const createPackage = async (organizationId: string) =>
  (
    await client.contentPackage.create({
      data: {
        organizationId,
        name: 'P306 package',
        draft: draftJson('Spring sale'),
        draftVersion: 1,
        latestRevisionNumber: 0,
        createdById: OWNER[organizationId],
      },
      select: { id: true },
    })
  ).id;

// a customer-managed connection row; the fake resolver never opens it
const createConnection = async (organizationId: string) =>
  (
    await client.contentStudioAIConnection.create({
      data: {
        organizationId,
        name: 'P306 connection',
        provider: 'openai',
        sealedCredential: 'sb1.placeholder.not-a-real-envelope',
        defaultModel: 'gpt-6.1-sol',
        credentialUpdatedAt: T1,
        createdById: OWNER[organizationId],
      },
      select: { id: true },
    })
  ).id;

const answer = (text: string): ContentStudioAITextResult => ({
  text,
  finishReason: 'stop',
  usage: { inputTokens: 100, outputTokens: 40 },
  providerRequestId: 'req_p306_fake',
});

// A resolver that never opens a credential or makes a client: the adapter
// is a fake that answers in memory, after `during` ran (if given)
const fakeResolver = (
  reply: () => Promise<ContentStudioAITextResult> = async () =>
    answer('A brighter spring.')
) => {
  const adapter = {
    provider: 'openai' as const,
    validateConnection: jest.fn(),
    generateText: jest.fn(reply),
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

const writing = (resolver: unknown) =>
  new ContentStudioAIWritingService(
    packages,
    writingRepository,
    editorialRepository,
    audienceRepository,
    expertiseRepository,
    new ContentStudioAIExecutionService(
      packages,
      resolver as ContentStudioAIProviderResolver,
      operations
    ),
    sources
  );

const promptOf = (adapter: { generateText: jest.Mock }) => {
  const [request] = adapter.generateText.mock.calls[0] as unknown as [
    { system: string; prompt: string }
  ];
  return `${request.system}\n${request.prompt}`;
};

// One AI writing item request of org A with these sources
const aiFixture = async () => ({
  packageId: await createPackage(ORG_A),
  connectionId: await createConnection(ORG_A),
});
const proposeItem = (
  resolver: unknown,
  fixture: { packageId: string; connectionId: string },
  sourceIds: unknown,
  userId = USER_A1
) =>
  writing(resolver).proposeItem({
    organizationId: ORG_A,
    userId,
    packageId: fixture.packageId,
    operation: 'rewrite_item',
    itemId: 'main',
    selection: {
      connectionId: fixture.connectionId,
      model: 'gpt-6.1-sol',
      baseDraftVersion: 1,
      sourceIds,
    },
  });

const operationRows = () =>
  client.contentStudioAIOperation.findMany({
    where: { organizationId: { in: ORGS } },
  });
const operationRow = (id: string) =>
  client.contentStudioAIOperation.findUniqueOrThrow({ where: { id } });
const usageRows = () =>
  client.contentStudioAIUsage.findMany({
    where: { organizationId: { in: ORGS } },
  });
// every column of every AI operation and usage row of both organizations,
// BigInt and Date included, as one string
const storedAIRows = async () =>
  inspect([await operationRows(), await usageRows()], {
    depth: 10,
    maxArrayLength: null,
    maxStringLength: null,
  });

const cleanPhase3 = async () => {
  const where = { organizationId: { in: ORGS } };
  await client.contentStudioAIUsage.deleteMany({ where });
  await client.contentStudioAIOperation.deleteMany({ where });
  await client.contentStudioAIConnection.deleteMany({ where });
  await client.contentStudioSourceCaptureAttempt.deleteMany({ where });
  await client.contentStudioSourceDiscovery.deleteMany({ where });
  await client.contentStudioSourceVersion.deleteMany({ where });
  await client.contentStudioSource.deleteMany({ where });
  await client.contentPackage.deleteMany({ where });
};

const cleanFixtures = async () => {
  await cleanPhase3();
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
  prisma = client as unknown as PrismaService;
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
  sources = new ContentStudioSourceRepository(
    new PrismaRepository<'contentStudioSource'>(prisma),
    new PrismaRepository<'contentStudioSourceVersion'>(prisma),
    transaction
  );
  sourceService = new ContentStudioSourceService(
    sources,
    new ContentStudioSourceDiscoveryRepository(
      new PrismaRepository<'contentStudioSourceDiscovery'>(prisma)
    ),
    new ContentStudioSourceCaptureAttemptRepository(
      new PrismaRepository<'contentStudioSourceCaptureAttempt'>(prisma)
    )
  );

  await cleanFixtures();
  for (const [id] of [[ORG_A], [ORG_B]]) {
    await client.organization.create({ data: { id, name: `P306 ${id}` } });
  }
  // ordinary members: nothing here needs a manager role
  for (const [user, org] of [
    [USER_A1, ORG_A],
    [USER_A2, ORG_A],
    [USER_B1, ORG_B],
  ]) {
    await client.user.create({
      data: {
        id: user,
        email: `${user}@p306.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P306 ${user}`,
      },
    });
    await client.userOrganization.create({
      data: { userId: user, organizationId: org, role: 'USER' },
    });
  }
});

beforeEach(async () => {
  await cleanPhase3();
  mockSafeFetch.mockClear();
  // nothing here may reach a network: a call fails the test
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('network access in the PostgreSQL integration suite');
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(mockSafeFetch).not.toHaveBeenCalled();
});

afterAll(async () => {
  if (client) {
    await cleanFixtures();
    await client.$disconnect();
  }
});

// ============================================================================
describe('A. Sources: what PostgreSQL enforces', () => {
  const sourceData = (
    organizationId: string,
    overrides: Partial<Prisma.ContentStudioSourceUncheckedCreateInput> = {}
  ): Prisma.ContentStudioSourceUncheckedCreateInput => ({
    organizationId,
    kind: 'url',
    name: 'P306 direct',
    canonicalUrl: url(randomUUID()),
    createdById: OWNER[organizationId],
    ...overrides,
  });

  it('SDB1/SDB2 a source needs an existing organization and creator (P2003)', async () => {
    expect(
      await prismaCode(
        client.contentStudioSource.create({
          data: sourceData(ORG_A, { organizationId: MISSING }),
        })
      )
    ).toBe('P2003');
    expect(
      await prismaCode(
        client.contentStudioSource.create({
          data: sourceData(ORG_A, { createdById: MISSING }),
        })
      )
    ).toBe('P2003');
  });

  it('SDB3 a source id is never reused, in either organization (P2002)', async () => {
    const id = randomUUID();
    await client.contentStudioSource.create({
      data: sourceData(ORG_A, { id }),
    });
    expect(
      await prismaCode(
        client.contentStudioSource.create({ data: sourceData(ORG_B, { id }) })
      )
    ).toBe('P2002');
  });

  it('CU1/CU2/CU3 one canonical URL per organization; the other organization may have it too', async () => {
    const canonicalUrl = url('cu');
    await client.contentStudioSource.create({
      data: sourceData(ORG_A, { canonicalUrl }),
    });
    expect(
      await prismaCode(
        client.contentStudioSource.create({
          data: sourceData(ORG_A, { canonicalUrl, name: 'again' }),
        })
      )
    ).toBe('P2002');
    await expect(
      client.contentStudioSource.create({
        data: sourceData(ORG_B, { canonicalUrl }),
      })
    ).resolves.toMatchObject({ organizationId: ORG_B, canonicalUrl });
  });

  it('CU4 an archived source still holds its URL', async () => {
    const canonicalUrl = url('archived');
    await client.contentStudioSource.create({
      data: sourceData(ORG_A, { canonicalUrl, archivedAt: T1 }),
    });
    expect(
      await prismaCode(
        client.contentStudioSource.create({
          data: sourceData(ORG_A, { canonicalUrl }),
        })
      )
    ).toBe('P2002');
  });

  it('CU5 another path or query is another canonical string and coexists', async () => {
    for (const canonicalUrl of [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/a?x=1',
    ]) {
      await client.contentStudioSource.create({
        data: sourceData(ORG_A, { canonicalUrl }),
      });
    }
    expect(
      await client.contentStudioSource.count({
        where: { organizationId: ORG_A },
      })
    ).toBe(3);
  });

  it('CU6/H1 PostgreSQL allows several null URLs and does not tie kind to URL: the application does', async () => {
    await client.contentStudioSource.create({
      data: sourceData(ORG_A, { canonicalUrl: null }),
    });
    await client.contentStudioSource.create({
      data: sourceData(ORG_A, { canonicalUrl: null, kind: 'url' }),
    });
    expect(
      await client.contentStudioSource.count({
        where: { organizationId: ORG_A, canonicalUrl: null },
      })
    ).toBe(2);
    // the service never creates one: a url source needs a valid URL
    for (const bad of [null, '', 'not a url']) {
      expect(
        (
          await httpRefusal(
            sourceService.createSource({
              organizationId: ORG_A,
              userId: USER_A1,
              kind: 'url',
              name: 'No URL',
              url: bad,
            })
          )
        ).code
      ).toBe('CS_SOURCE_URL_INVALID');
    }
  });

  it('SDB4/H2 the creator is only a user foreign key: PostgreSQL does not check membership', async () => {
    // a direct insert may name a user of another organization; the API only
    // ever passes the request's own member
    const id = (
      await client.contentStudioSource.create({
        data: sourceData(ORG_A, { createdById: USER_B1 }),
      })
    ).id;
    expect((await sourceRow(id)).createdById).toBe(USER_B1);
    await expect(
      client.contentStudioSourceVersion.create({
        data: versionRow(ORG_A, id, 1, { createdById: USER_B1 }),
      })
    ).resolves.toMatchObject({ createdById: USER_B1 });
  });
});

// ============================================================================
describe('A. Source versions: what PostgreSQL enforces', () => {
  it('SVDB1-SVDB5 a version belongs to a source of its own organization (composite foreign key)', async () => {
    const sourceA = await createSource(ORG_A);
    await expect(
      client.contentStudioSourceVersion.create({
        data: versionRow(ORG_A, sourceA, 1),
      })
    ).resolves.toMatchObject({ organizationId: ORG_A, sourceId: sourceA });
    expect(
      await prismaCode(
        client.contentStudioSourceVersion.create({
          data: versionRow(ORG_B, sourceA, 2, { createdById: USER_B1 }),
        })
      )
    ).toBe('P2003');
    expect(
      await prismaCode(
        client.contentStudioSourceVersion.create({
          data: versionRow(ORG_A, MISSING, 1),
        })
      )
    ).toBe('P2003');
    expect(
      await prismaCode(
        client.contentStudioSourceVersion.create({
          data: versionRow(ORG_A, sourceA, 3, { organizationId: MISSING }),
        })
      )
    ).toBe('P2003');
    expect(
      await prismaCode(
        client.contentStudioSourceVersion.create({
          data: versionRow(ORG_A, sourceA, 4, { createdById: MISSING }),
        })
      )
    ).toBe('P2003');
    expect(await versionsOf(sourceA)).toHaveLength(1);
  });

  it('VN1-VN4 a version number is unique per source, not across sources', async () => {
    const sourceA = await createSource(ORG_A);
    const sourceB = await createSource(ORG_A);
    await client.contentStudioSourceVersion.create({
      data: versionRow(ORG_A, sourceA, 1),
    });
    expect(
      await prismaCode(
        client.contentStudioSourceVersion.create({
          data: versionRow(ORG_A, sourceA, 1),
        })
      )
    ).toBe('P2002');
    await client.contentStudioSourceVersion.create({
      data: versionRow(ORG_A, sourceA, 2),
    });
    await client.contentStudioSourceVersion.create({
      data: versionRow(ORG_A, sourceB, 1),
    });
    expect((await versionsOf(sourceA)).map((v) => v.versionNumber)).toEqual([
      1, 2,
    ]);
  });

  it('SVDB6 hashes are not unique: equal content and source hashes may repeat', async () => {
    const sourceA = await createSource(ORG_A);
    await client.contentStudioSourceVersion.create({
      data: versionRow(ORG_A, sourceA, 1),
    });
    await client.contentStudioSourceVersion.create({
      data: versionRow(ORG_A, sourceA, 2),
    });
    const [v1, v2] = await versionsOf(sourceA);
    expect([v2.contentHash, v2.sourceHash]).toEqual([
      v1.contentHash,
      v1.sourceHash,
    ]);
  });

  it('108 a stored version is canonical JSON blocks with their hash, and has no HTML column', async () => {
    const { sourceId } = await capturedSource();
    const [row] = await versionsOf(sourceId);
    expect(Object.keys(row).sort()).toEqual(
      [
        'id',
        'organizationId',
        'sourceId',
        'versionNumber',
        'schemaVersion',
        'extractionVersion',
        'requestedUrl',
        'finalUrl',
        'redirectCount',
        'fetchedAt',
        'httpStatus',
        'contentType',
        'contentLength',
        'title',
        'content',
        'contentHash',
        'sourceHash',
        'createdById',
        'createdAt',
      ].sort()
    );
    expect(JSON.parse(row.content)).toEqual({
      blocks: [
        { id: 'h1', level: 1, text: 'Results', type: 'heading' },
        {
          id: 'p1',
          level: null,
          text: `${PROMPT_MARKER} grew.`,
          type: 'paragraph',
        },
      ],
      schemaVersion: 1,
    });
    expect(row.content).toBe(capture().content);
    expect(row.contentHash).toBe(sha256Hex(row.content));
    expect(row.content).not.toMatch(/<[a-z]/i);
  });

  it('109/H3 any extraction version string is stored; only the application checks its format', async () => {
    const sourceA = await createSource(ORG_A);
    for (const [n, extractionVersion] of [
      [1, 'content-studio-source-v1'],
      [2, 'content-studio-source-v2'],
      [3, 'not a version at all'],
    ] as const) {
      await client.contentStudioSourceVersion.create({
        data: versionRow(ORG_A, sourceA, n, { extractionVersion }),
      });
    }
    expect((await versionsOf(sourceA)).map((v) => v.extractionVersion)).toEqual(
      [
        'content-studio-source-v1',
        'content-studio-source-v2',
        'not a version at all',
      ]
    );
    expect(() =>
      capture(PROMPT_MARKER, { extractionVersion: 'not a version at all' })
    ).toThrow(ContentStudioSourceVersionError);
  });
});

// ============================================================================
describe('B. Source repository: organization scope on PostgreSQL', () => {
  it('STEN1 another organization reads nothing of a source', async () => {
    const canonicalUrl = url('tenant');
    const sourceId = await createSource(ORG_A, { canonicalUrl });
    const versionId = (await append(ORG_A, sourceId, 0)) as {
      version: { id: string };
    };
    expect(await sources.getSourceForOrganization(ORG_B, sourceId)).toBeNull();
    expect(
      await sources.getSourceByCanonicalUrlForOrganization(ORG_B, canonicalUrl)
    ).toBeNull();
    expect(
      await sources.listSourcesForOrganization({
        organizationId: ORG_B,
        archived: false,
        skip: 0,
        take: 20,
      })
    ).toEqual([]);
    expect(
      await sources.countSourcesForOrganization({
        organizationId: ORG_B,
        archived: false,
      })
    ).toBe(0);
    expect(
      await sources.listVersionsForSource({
        organizationId: ORG_B,
        sourceId,
        skip: 0,
        take: 20,
      })
    ).toEqual([]);
    expect(await sources.countVersionsForSource(ORG_B, sourceId)).toBe(0);
    expect(
      await sources.getVersionForSource(ORG_B, sourceId, versionId.version.id)
    ).toBeNull();
    expect(await sources.getVersionByNumber(ORG_B, sourceId, 1)).toBeNull();
    expect(
      await sources.getVersionDetailByNumber(ORG_B, sourceId, 1)
    ).toBeNull();
    // the owner sees it
    expect(
      await sources.getSourceForOrganization(ORG_A, sourceId)
    ).toMatchObject({ id: sourceId, latestVersionNumber: 1 });
    expect(
      await sources.getVersionForSource(ORG_A, sourceId, versionId.version.id)
    ).toMatchObject({ id: versionId.version.id });
  });

  it('STEN2 a version is read through its own source only', async () => {
    const one = await capturedSource();
    const other = await capturedSource();
    expect(
      await sources.getVersionForSource(ORG_A, other.sourceId, one.versionId)
    ).toBeNull();
  });

  it('STEN3 another organization cannot rename, archive, restore or append', async () => {
    const sourceId = await createSource(ORG_A, { name: 'Owned' });
    const before = await sourceRow(sourceId);
    expect(await sources.updateSourceName(ORG_B, sourceId, 'Taken')).toEqual({
      count: 0,
    });
    expect(await sources.archiveSource(ORG_B, sourceId, T2)).toEqual({
      count: 0,
    });
    await client.contentStudioSource.update({
      where: { id: sourceId },
      data: { archivedAt: T1 },
    });
    expect(await restore(ORG_B, sourceId)).toEqual({ status: 'not-found' });
    await client.contentStudioSource.update({
      where: { id: sourceId },
      data: { archivedAt: null },
    });
    expect(
      await append(ORG_B, sourceId, 0, capture(), { createdById: USER_B1 })
    ).toEqual({ status: 'not-found' });
    const after = await sourceRow(sourceId);
    expect({ ...after, updatedAt: null }).toEqual({
      ...before,
      updatedAt: null,
    });
    expect(await versionsOf(sourceId)).toEqual([]);
  });

  it('STEN4 lists are per organization and status, newest change first', async () => {
    const first = await createSource(ORG_A);
    const second = await createSource(ORG_A);
    const archived = await createSource(ORG_A);
    await sources.archiveSource(ORG_A, archived, T2);
    await createSource(ORG_B);
    await sources.updateSourceName(ORG_A, first, 'Touched');
    const active = await sources.listSourcesForOrganization({
      organizationId: ORG_A,
      archived: false,
      skip: 0,
      take: 20,
    });
    expect(active.map((s) => s.id)).toEqual([first, second]);
    expect(
      (
        await sources.listSourcesForOrganization({
          organizationId: ORG_A,
          archived: true,
          skip: 0,
          take: 20,
        })
      ).map((s) => s.id)
    ).toEqual([archived]);
  });
});

// ============================================================================
describe('C. Appending versions: compare-and-swap on PostgreSQL', () => {
  it('SCAS1 the first capture is version 1, with exactly what ingestion parsed', async () => {
    const sourceId = await createSource(ORG_A);
    const version = capture();
    const versionId = randomUUID();
    // another member of the organization asked for the capture
    const result = await append(ORG_A, sourceId, 0, version, {
      versionId,
      createdById: USER_A2,
    });
    expect(result).toEqual({
      status: 'created',
      version: expect.objectContaining({ id: versionId, versionNumber: 1 }),
    });
    expect((await sourceRow(sourceId)).latestVersionNumber).toBe(1);
    const rows = await versionsOf(sourceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: versionId,
      organizationId: ORG_A,
      sourceId,
      versionNumber: 1,
      ...version,
      createdById: USER_A2,
      createdAt: expect.any(Date),
    });
    // the creator of the source is not the creator of the capture
    expect((await sourceRow(sourceId)).createdById).toBe(USER_A1);
  });

  it('SCAS2 the second capture is version 2 and version 1 stays as it was', async () => {
    const { sourceId } = await capturedSource();
    const [v1] = await versionsOf(sourceId);
    const result = await append(
      ORG_A,
      sourceId,
      1,
      capture('Second capture', { fetchedAt: T2 })
    );
    expect(result).toMatchObject({
      status: 'created',
      version: { versionNumber: 2 },
    });
    expect((await sourceRow(sourceId)).latestVersionNumber).toBe(2);
    const rows = await versionsOf(sourceId);
    expect(rows[0]).toEqual(v1);
    expect(rows[1]).toMatchObject({
      versionNumber: 2,
      fetchedAt: T2,
      content: capture('Second capture').content,
    });
  });

  it('SCAS3/18 the same content captured again is a new version, never deduplicated', async () => {
    const { sourceId } = await capturedSource();
    const result = await append(
      ORG_A,
      sourceId,
      1,
      capture(PROMPT_MARKER, { fetchedAt: T2 })
    );
    expect(result).toMatchObject({ status: 'created' });
    const [v1, v2] = await versionsOf(sourceId);
    expect([v1.versionNumber, v2.versionNumber]).toEqual([1, 2]);
    expect(v2.id).not.toBe(v1.id);
    expect([v2.content, v2.contentHash, v2.sourceHash]).toEqual([
      v1.content,
      v1.contentHash,
      v1.sourceHash,
    ]);
    expect((await sourceRow(sourceId)).latestVersionNumber).toBe(2);
  });

  it('SCAS4/19 the same content hash with another source hash: both stored as they are', async () => {
    const sourceId = await createSource(ORG_A);
    await append(
      ORG_A,
      sourceId,
      0,
      capture(PROMPT_MARKER, { sourceHash: 'a'.repeat(64) })
    );
    await append(
      ORG_A,
      sourceId,
      1,
      capture(PROMPT_MARKER, { sourceHash: 'b'.repeat(64) })
    );
    const [v1, v2] = await versionsOf(sourceId);
    expect(v1.contentHash).toBe(v2.contentHash);
    expect([v1.sourceHash, v2.sourceHash]).toEqual([
      'a'.repeat(64),
      'b'.repeat(64),
    ]);
  });

  it('SCAS5/20 a stale expected version is a conflict and appends nothing', async () => {
    const { sourceId } = await capturedSource();
    expect(await append(ORG_A, sourceId, 0)).toEqual({
      status: 'conflict',
      currentVersionNumber: 1,
    });
    expect(await append(ORG_A, sourceId, 2)).toEqual({
      status: 'conflict',
      currentVersionNumber: 1,
    });
    expect((await sourceRow(sourceId)).latestVersionNumber).toBe(1);
    expect(await versionsOf(sourceId)).toHaveLength(1);
  });

  it('SCAS6/122 a missing source is not-found; an archived one is archived; nothing is written', async () => {
    expect(await append(ORG_A, MISSING, 0)).toEqual({ status: 'not-found' });
    const sourceId = await createSource(ORG_A);
    await sources.archiveSource(ORG_A, sourceId, T2);
    expect(await append(ORG_A, sourceId, 0)).toEqual({ status: 'archived' });
    expect((await sourceRow(sourceId)).latestVersionNumber).toBe(0);
    expect(await versionsOf(sourceId)).toEqual([]);
  });

  it.each([1, 2, 3, 4, 5])(
    'SCAS7/21 two captures of version 1 at once: exactly one wins (race %i)',
    async () => {
      const sourceId = await createSource(ORG_A);
      // both have read latestVersionNumber 0 before either swaps
      const repository = hookedSources({ beforeCas: latch(2) });
      const results = await Promise.allSettled([
        append(ORG_A, sourceId, 0, capture('Capture A'), { repository }),
        append(ORG_A, sourceId, 0, capture('Capture B'), { repository }),
      ]);
      const statuses = results.map((r) =>
        r.status === 'fulfilled' ? r.value.status : 'rejected'
      );
      expect(statuses.filter((s) => s === 'created')).toHaveLength(1);
      expect(
        statuses.filter((s) => s === 'changed' || s === 'conflict')
      ).toHaveLength(1);
      expect((await sourceRow(sourceId)).latestVersionNumber).toBe(1);
      const rows = await versionsOf(sourceId);
      expect(rows.map((v) => v.versionNumber)).toEqual([1]);
      // the stored version is the winner's
      const winner = results.find(
        (r) => r.status === 'fulfilled' && r.value.status === 'created'
      ) as PromiseFulfilledResult<{ version: { id: string } }>;
      expect(rows[0].id).toBe(winner.value.version.id);
    }
  );

  it.each([1, 2, 3, 4, 5])(
    'SCAS8/22 two captures of version 2 at once: exactly one wins (race %i)',
    async () => {
      const { sourceId } = await capturedSource();
      const repository = hookedSources({ beforeCas: latch(2) });
      const results = await Promise.allSettled([
        append(ORG_A, sourceId, 1, capture('Capture A'), { repository }),
        append(ORG_A, sourceId, 1, capture('Capture B'), { repository }),
      ]);
      const statuses = results.map((r) =>
        r.status === 'fulfilled' ? r.value.status : 'rejected'
      );
      expect(statuses.sort()).toEqual(['changed', 'created']);
      expect((await versionsOf(sourceId)).map((v) => v.versionNumber)).toEqual([
        1, 2,
      ]);
      expect((await sourceRow(sourceId)).latestVersionNumber).toBe(2);
    }
  );

  it('SCAS9 unsynchronised captures of the same expected version: still one winner', async () => {
    for (let round = 0; round < 5; round++) {
      const sourceId = await createSource(ORG_A);
      const results = await Promise.allSettled([
        append(ORG_A, sourceId, 0, capture('A')),
        append(ORG_A, sourceId, 0, capture('B')),
        append(ORG_A, sourceId, 0, capture('C')),
      ]);
      const created = results.filter(
        (r) => r.status === 'fulfilled' && r.value.status === 'created'
      );
      expect(created).toHaveLength(1);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(await versionsOf(sourceId)).toHaveLength(1);
      expect((await sourceRow(sourceId)).latestVersionNumber).toBe(1);
    }
  });

  it('SCAS10/23/54 a failing version insert rolls the counter back: the append is atomic', async () => {
    // an existing version id: the insert fails after the counter moved, in
    // the same transaction
    const taken = await capturedSource();
    const sourceId = await createSource(ORG_A);
    expect(
      await prismaCode(
        append(ORG_A, sourceId, 0, capture(), { versionId: taken.versionId })
      )
    ).toBe('P2002');
    expect((await sourceRow(sourceId)).latestVersionNumber).toBe(0);
    expect(await versionsOf(sourceId)).toEqual([]);
    // the other source is untouched, and the next capture still gets version 1
    expect(await versionsOf(taken.sourceId)).toHaveLength(1);
    expect(await append(ORG_A, sourceId, 0)).toMatchObject({
      status: 'created',
      version: { versionNumber: 1 },
    });
  });

  it('SCAS11 a version taken by a direct insert makes the swap fail as a whole', async () => {
    // a broken store: version 1 exists although the counter says 0
    const sourceId = await createSource(ORG_A);
    await client.contentStudioSourceVersion.create({
      data: versionRow(ORG_A, sourceId, 1),
    });
    expect(await prismaCode(append(ORG_A, sourceId, 0))).toBe('P2002');
    expect((await sourceRow(sourceId)).latestVersionNumber).toBe(0);
    expect(await versionsOf(sourceId)).toHaveLength(1);
  });
});

// ============================================================================
describe('D. Source lifecycle and races on PostgreSQL', () => {
  it('SLC1/55 archive sets archivedAt only: the counter and every version stay', async () => {
    const { sourceId } = await capturedSource();
    await append(ORG_A, sourceId, 1, capture('v2'));
    const before = await versionsOf(sourceId);
    const row = await sourceRow(sourceId);
    expect(await sources.archiveSource(ORG_A, sourceId, T2)).toEqual({
      count: 1,
    });
    const archived = await sourceRow(sourceId);
    expect({ ...archived, updatedAt: null }).toEqual({
      ...row,
      archivedAt: T2,
      updatedAt: null,
    });
    expect(await versionsOf(sourceId)).toEqual(before);
    // archiving again changes nothing
    expect(await sources.archiveSource(ORG_A, sourceId, T1)).toEqual({
      count: 0,
    });
    expect((await sourceRow(sourceId)).archivedAt).toEqual(T2);
  });

  it('SLC2/26 archived refuses captures; restored, the next capture continues the history', async () => {
    const { sourceId } = await capturedSource();
    await sources.archiveSource(ORG_A, sourceId, T2);
    expect(await append(ORG_A, sourceId, 1)).toEqual({ status: 'archived' });
    expect(await restore(ORG_A, sourceId)).toEqual({ status: 'restored' });
    const restored = await sourceRow(sourceId);
    expect(restored).toMatchObject({
      archivedAt: null,
      latestVersionNumber: 1,
    });
    expect(
      await append(ORG_A, sourceId, 1, capture('after restore'))
    ).toMatchObject({
      status: 'created',
      version: { versionNumber: 2 },
    });
    expect((await versionsOf(sourceId)).map((v) => v.versionNumber)).toEqual([
      1, 2,
    ]);
    expect(await restore(ORG_A, sourceId)).toEqual({ status: 'unchanged' });
  });

  it('SLC3/56 rename changes the name only', async () => {
    const { sourceId } = await capturedSource();
    const before = await sourceRow(sourceId);
    const versions = await versionsOf(sourceId);
    expect(await sources.updateSourceName(ORG_A, sourceId, 'Renamed')).toEqual({
      count: 1,
    });
    const after = await sourceRow(sourceId);
    expect({ ...after, updatedAt: null }).toEqual({
      ...before,
      name: 'Renamed',
      updatedAt: null,
    });
    expect(await versionsOf(sourceId)).toEqual(versions);
    // an archived source is read-only
    await sources.archiveSource(ORG_A, sourceId, T2);
    expect(await sources.updateSourceName(ORG_A, sourceId, 'Again')).toEqual({
      count: 0,
    });
    expect((await sourceRow(sourceId)).name).toBe('Renamed');
  });

  it.each([1, 2, 3, 4, 5])(
    'SRACE1/25 an archive that commits between the check and the swap stops the capture (race %i)',
    async () => {
      const sourceId = await createSource(ORG_A);
      // the capture read a live source; the archive commits before its swap
      const repository = hookedSources({
        beforeCas: async () => {
          expect(await sources.archiveSource(ORG_A, sourceId, T2)).toEqual({
            count: 1,
          });
        },
      });
      expect(
        await append(ORG_A, sourceId, 0, capture(), { repository })
      ).toEqual({ status: 'changed' });
      expect(await sourceRow(sourceId)).toMatchObject({
        archivedAt: T2,
        latestVersionNumber: 0,
      });
      expect(await versionsOf(sourceId)).toEqual([]);
    }
  );

  it.each([1, 2, 3, 4, 5])(
    'SRACE2/25 a capture that swapped first is kept; the archive then applies to it (race %i)',
    async () => {
      const sourceId = await createSource(ORG_A);
      let archiving: Promise<{ count: number }> | undefined;
      // the archive starts while the capture holds the source row
      const repository = hookedSources({
        afterCas: async () => {
          archiving = sources.archiveSource(ORG_A, sourceId, T2);
        },
      });
      expect(
        await append(ORG_A, sourceId, 0, capture(), { repository })
      ).toMatchObject({ status: 'created', version: { versionNumber: 1 } });
      expect(await archiving).toEqual({ count: 1 });
      expect(await sourceRow(sourceId)).toMatchObject({
        archivedAt: T2,
        latestVersionNumber: 1,
      });
      expect(await versionsOf(sourceId)).toHaveLength(1);
    }
  );

  it('SRACE3 archive and capture at once, unsynchronised: a version exists only if the capture won', async () => {
    for (let round = 0; round < 5; round++) {
      const sourceId = await createSource(ORG_A);
      const [captured, archived] = await Promise.all([
        append(ORG_A, sourceId, 0),
        sources.archiveSource(ORG_A, sourceId, T2),
      ]);
      expect(archived).toEqual({ count: 1 });
      const versions = await versionsOf(sourceId);
      const row = await sourceRow(sourceId);
      expect(row.archivedAt).toEqual(T2);
      if (captured.status === 'created') {
        expect(versions).toHaveLength(1);
        expect(row.latestVersionNumber).toBe(1);
      } else {
        expect(['archived', 'changed']).toContain(captured.status);
        expect(versions).toEqual([]);
        expect(row.latestVersionNumber).toBe(0);
      }
    }
  });
});

// ============================================================================
describe('E. Source service on PostgreSQL: fixed errors, organization scope', () => {
  it('SSEC1/28 another organization gets 404 for every source call, and nothing changes', async () => {
    const { sourceId, versionId } = await capturedSource();
    const before = await sourceRow(sourceId);
    const hidden = [sourceId, versionId, NAME_MARKER];
    for (const call of [
      () => sourceService.getSource(ORG_B, sourceId),
      () => sourceService.renameSource(ORG_B, sourceId, 'Taken'),
      () => sourceService.archiveSource(ORG_B, sourceId),
      () => sourceService.restoreSource(ORG_B, sourceId),
      () =>
        sourceService.listVersions({
          organizationId: ORG_B,
          sourceId,
          page: 1,
        }),
      () =>
        sourceService.getVersion({
          organizationId: ORG_B,
          sourceId,
          versionId,
        }),
    ]) {
      expect(await httpRefusal(call(), hidden)).toEqual({
        status: 404,
        code: 'CS_NOT_FOUND',
        msg: 'Source not found.',
      });
    }
    expect(await sourceRow(sourceId)).toEqual(before);
    expect(
      await sourceService.listSources({
        organizationId: ORG_B,
        archived: false,
        page: 1,
      })
    ).toEqual({ pages: 0, results: [] });
  });

  it('SSEC2/29/115 a duplicate URL is a fixed 409; the other organization may add it', async () => {
    const input = {
      organizationId: ORG_A,
      userId: USER_A1,
      kind: 'url',
      name: `${SERVICE_MARKER} name`,
      url: `https://example.com/dup?token=${SERVICE_MARKER}`,
    };
    const created = await sourceService.createSource(input);
    expect(created).toMatchObject({
      kind: 'url',
      canonicalUrl: input.url,
      latestVersionNumber: 0,
    });
    expect(await httpRefusal(sourceService.createSource(input))).toEqual({
      status: 409,
      code: 'CS_SOURCE_ALREADY_EXISTS',
      msg: 'This source already exists.',
    });
    await expect(
      sourceService.createSource({
        ...input,
        organizationId: ORG_B,
        userId: USER_B1,
      })
    ).resolves.toMatchObject({ canonicalUrl: input.url });
  });

  it('SSEC3/123 the same URL created twice at once: one source, one fixed 409', async () => {
    const input = {
      organizationId: ORG_A,
      userId: USER_A1,
      kind: 'url',
      name: 'Twice',
      url: 'https://example.com/twice',
    };
    const results = await Promise.allSettled([
      sourceService.createSource(input),
      sourceService.createSource({ ...input, userId: USER_A2 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [rejected] = results.filter(
      (r) => r.status === 'rejected'
    ) as PromiseRejectedResult[];
    expect(await httpRefusal(Promise.reject(rejected.reason))).toMatchObject({
      status: 409,
      code: 'CS_SOURCE_ALREADY_EXISTS',
    });
    expect(
      await client.contentStudioSource.count({
        where: { organizationId: ORG_A, canonicalUrl: input.url },
      })
    ).toBe(1);
  });

  it('SSEC4/113 URL canonicalization and the unique key together: one source per address', async () => {
    const create = (address: string) =>
      sourceService.createSource({
        organizationId: ORG_A,
        userId: USER_A1,
        kind: 'url',
        name: 'Canonical',
        url: address,
      });
    expect(await create('HTTPS://EXAMPLE.COM:443/a')).toMatchObject({
      canonicalUrl: 'https://example.com/a',
    });
    expect((await httpRefusal(create('https://example.com/a'))).code).toBe(
      'CS_SOURCE_ALREADY_EXISTS'
    );
  });

  it('SSEC5/114 the query order is part of the URL: both orders coexist', async () => {
    for (const address of [
      'https://example.com/q?a=1&b=2',
      'https://example.com/q?b=2&a=1',
    ]) {
      await sourceService.createSource({
        organizationId: ORG_A,
        userId: USER_A1,
        kind: 'url',
        name: 'Query',
        url: address,
      });
    }
    expect(
      await client.contentStudioSource.count({
        where: {
          organizationId: ORG_A,
          canonicalUrl: { startsWith: 'https://example.com/q?' },
        },
      })
    ).toBe(2);
  });

  it('SSEC6/112 an archived source keeps its URL: creating it again is a 409', async () => {
    const created = await sourceService.createSource({
      organizationId: ORG_A,
      userId: USER_A1,
      kind: 'url',
      name: 'Archived',
      url: 'https://example.com/archived',
    });
    await sourceService.archiveSource(ORG_A, created.id);
    expect(
      (
        await httpRefusal(
          sourceService.createSource({
            organizationId: ORG_A,
            userId: USER_A2,
            kind: 'url',
            name: 'Again',
            url: 'https://example.com/archived',
          })
        )
      ).code
    ).toBe('CS_SOURCE_ALREADY_EXISTS');
  });

  it('SSEC7/82 an ordinary member runs every source write and read; rename keeps the URL', async () => {
    const created = await sourceService.createSource({
      organizationId: ORG_A,
      userId: USER_A2,
      kind: 'url',
      name: 'Member source',
      url: 'https://example.com/member',
    });
    await append(ORG_A, created.id, 0);
    expect(
      await sourceService.renameSource(ORG_A, created.id, 'Renamed by member')
    ).toMatchObject({
      name: 'Renamed by member',
      canonicalUrl: 'https://example.com/member',
      latestVersionNumber: 1,
    });
    expect(await sourceService.archiveSource(ORG_A, created.id)).toMatchObject({
      archivedAt: expect.any(Date),
    });
    // still readable while archived
    expect(
      (
        await sourceService.listVersions({
          organizationId: ORG_A,
          sourceId: created.id,
          page: 1,
        })
      ).results
    ).toHaveLength(1);
    expect(
      (await httpRefusal(sourceService.renameSource(ORG_A, created.id, 'x')))
        .code
    ).toBe('CS_SOURCE_ARCHIVED');
    expect(await sourceService.restoreSource(ORG_A, created.id)).toMatchObject({
      archivedAt: null,
    });
    const detail = await sourceService.getSource(ORG_A, created.id);
    expect(detail.currentVersion).toMatchObject({ versionNumber: 1 });
    expect(detail.currentVersion).not.toHaveProperty('content');
  });

  it('SSEC8/30 a version changed behind the repository is refused on read, without its text', async () => {
    const { sourceId, versionId } = await capturedSource();
    await client.contentStudioSourceVersion.update({
      where: { id: versionId },
      data: {
        content: capture(`${CORRUPT_MARKER} ${SERVICE_MARKER}`).content,
      },
    });
    expect(
      await httpRefusal(
        sourceService.getVersion({ organizationId: ORG_A, sourceId, versionId })
      )
    ).toEqual({
      status: 500,
      code: 'CS_SOURCE_INTEGRITY_ERROR',
      msg: 'Stored source data could not be verified.',
    });
  });

  it('SSEC9/111 a counter pointing at a missing version is an integrity error, not a source', async () => {
    const { sourceId } = await capturedSource();
    await client.contentStudioSource.update({
      where: { id: sourceId },
      data: { latestVersionNumber: 99 },
    });
    expect(await httpRefusal(sourceService.getSource(ORG_A, sourceId))).toEqual(
      {
        status: 500,
        code: 'CS_SOURCE_INTEGRITY_ERROR',
        msg: 'Stored source data could not be verified.',
      }
    );
  });

  it('SSEC10 a successful read returns the source, a refused one never does', async () => {
    const { sourceId, versionId } = await capturedSource();
    const version = await sourceService.getVersion({
      organizationId: ORG_A,
      sourceId,
      versionId,
    });
    // the owner gets the captured text and provenance on success
    expect(JSON.stringify(version)).toContain(PROMPT_MARKER);
    expect(version).not.toHaveProperty('organizationId');
    expect(version).not.toHaveProperty('createdById');
  });
});

// ============================================================================
describe('F. AI source grounding with the real source repository (fake adapter, no network)', () => {
  // With source material the answer is JSON with the text and its claims
  // (P3-11, prompt templates v3); none are claimed here
  const groundedAnswer = (text: string) =>
    answer(JSON.stringify({ text, claims: [] }));
  const groundedReply = async () => groundedAnswer('A brighter spring.');

  const contextOf = async (operationId: string) =>
    (
      await client.contentStudioAIOperation.findUniqueOrThrow({
        where: { id: operationId },
      })
    ).context;
  const versionMeta = async (sourceId: string, versionNumber: number) =>
    client.contentStudioSourceVersion.findUniqueOrThrow({
      where: { sourceId_versionNumber: { sourceId, versionNumber } },
      select: { id: true, contentHash: true, sourceHash: true },
    });

  const expectNothingStored = async (adapter: { generateText: jest.Mock }) => {
    expect(adapter.generateText).not.toHaveBeenCalled();
    expect(await operationRows()).toEqual([]);
    expect(await usageRows()).toEqual([]);
  };

  it('AIG1/36/49 the prompt gets the source text; the operation keeps ids and the content hash only', async () => {
    const fixture = await aiFixture();
    const { sourceId } = await capturedSource();
    const v1 = await versionMeta(sourceId, 1);
    const { adapter, resolver } = fakeResolver(groundedReply);
    const value = await proposeItem(resolver, fixture, [sourceId]);
    const prompt = promptOf(adapter);
    expect(prompt).toContain(PROMPT_MARKER);
    expect(prompt).toContain(TITLE_MARKER);
    expect(prompt).toContain(NAME_MARKER);
    // URLs never reach the prompt
    expect(prompt).not.toContain(URL_MARKER);
    expect(prompt).not.toMatch(/https?:\/\//);
    expect(await contextOf(value.operationId)).toEqual({
      v: 1,
      itemId: 'main',
      sources: [
        {
          sourceId,
          versionId: v1.id,
          versionNumber: 1,
          contentHash: v1.contentHash,
        },
      ],
    });
    expect(value.provenance).toEqual({
      sources: [
        {
          sourceId,
          versionId: v1.id,
          versionNumber: 1,
          contentHash: v1.contentHash,
          name: `${NAME_MARKER} report`,
          title: `${TITLE_MARKER} Annual report`,
        },
      ],
    });
    const [operation] = await operationRows();
    expect(operation).toMatchObject({
      status: 'succeeded',
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      resultHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(parseContentStudioAIOperationContext(operation.context)).toEqual(
      operation.context
    );
  });

  it('PRIV1/46/73/74/75 no operation or usage column holds the text, title, name, URL or source hash', async () => {
    const fixture = await aiFixture();
    const { sourceId } = await capturedSource();
    const v1 = await versionMeta(sourceId, 1);
    const { resolver } = fakeResolver(groundedReply);
    await proposeItem(resolver, fixture, [sourceId]);
    const stored = await storedAIRows();
    expect(stored).toContain(sourceId);
    expect(stored).toContain(v1.contentHash);
    expect(stored).not.toMatch(SOURCE_MARKERS);
    expect(stored).not.toContain(v1.sourceHash as string);
    // the source tables keep them: that is where source material lives
    const versionText = inspect(await versionsOf(sourceId));
    expect(versionText).toContain(PROMPT_MARKER);
    expect(versionText).toContain(TITLE_MARKER);
    expect(versionText).toContain(URL_MARKER);
    expect((await sourceRow(sourceId)).name).toContain(NAME_MARKER);
  });

  it('PRIV2/50 the context source reference has exactly sourceId, versionId, versionNumber and contentHash', async () => {
    const fixture = await aiFixture();
    const { sourceId } = await capturedSource();
    const { resolver } = fakeResolver(groundedReply);
    const value = await proposeItem(resolver, fixture, [sourceId]);
    const context = (await contextOf(value.operationId)) as {
      sources: Array<Record<string, unknown>>;
    };
    expect(Object.keys(context.sources[0]).sort()).toEqual([
      'contentHash',
      'sourceId',
      'versionId',
      'versionNumber',
    ]);
    expect(JSON.stringify(context)).not.toMatch(
      /sourceHash|title|name|url|blocks|content"/i
    );
  });

  it('PRIV3/47 a provider failure stores its code and usage, and no source text', async () => {
    const fixture = await aiFixture();
    const { sourceId } = await capturedSource();
    const { adapter, resolver } = fakeResolver(async () => {
      throw new ContentStudioAIProviderError('RATE_LIMITED', {
        providerRequestId: 'req_p306_limited',
      });
    });
    expect(
      (await httpRefusal(proposeItem(resolver, fixture, [sourceId]))).status
    ).toBe(429);
    expect(promptOf(adapter)).toContain(PROMPT_MARKER);
    const [operation] = await operationRows();
    expect(operation).toMatchObject({
      status: 'failed',
      errorCode: 'RATE_LIMITED',
    });
    expect(await usageRows()).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        providerRequestId: 'req_p306_limited',
      }),
    ]);
    expect(await storedAIRows()).not.toMatch(SOURCE_MARKERS);
  });

  it('PRIV5/47 a provider failure without a request id stores no stand-in for it', async () => {
    const fixture = await aiFixture();
    const { sourceId } = await capturedSource();
    const { adapter, resolver } = fakeResolver(async () => {
      throw new ContentStudioAIProviderError('PROVIDER_UNAVAILABLE');
    });
    await httpRefusal(proposeItem(resolver, fixture, [sourceId]));
    expect(promptOf(adapter)).toContain(PROMPT_MARKER);
    expect(await usageRows()).toEqual([
      expect.objectContaining({ outcome: 'failed', providerRequestId: null }),
    ]);
    expect(await storedAIRows()).not.toMatch(SOURCE_MARKERS);
  });

  it('PRIV4/48 a refused thread answer is a failed operation without the source text or the answer', async () => {
    const fixture = await aiFixture();
    const { sourceId } = await capturedSource();
    const { adapter, resolver } = fakeResolver(async () =>
      answer(`{"items":[ ${PROMPT_MARKER}`)
    );
    const refusal = await httpRefusal(
      writing(resolver).proposeThread({
        organizationId: ORG_A,
        userId: USER_A1,
        packageId: fixture.packageId,
        operation: 'generate_thread',
        selection: {
          connectionId: fixture.connectionId,
          model: 'gpt-6.1-sol',
          baseDraftVersion: 1,
          sourceIds: [sourceId],
        },
      })
    );
    expect(refusal.code).toBe('CS_AI_INVALID_RESPONSE');
    expect(promptOf(adapter)).toContain(PROMPT_MARKER);
    const [operation] = await operationRows();
    expect(operation).toMatchObject({
      status: 'failed',
      errorCode: 'INVALID_RESPONSE',
      resultHash: null,
      context: { v: 1, sources: [expect.objectContaining({ sourceId })] },
    });
    expect(await storedAIRows()).not.toMatch(SOURCE_MARKERS);
  });

  it('AIG2/37/79 a capture during the run does not change the version used: the snapshot holds', async () => {
    const fixture = await aiFixture();
    const { sourceId } = await capturedSource(
      ORG_A,
      capture('FIRST_CAPTURE_V1')
    );
    const v1 = await versionMeta(sourceId, 1);
    // the source is refreshed while the provider is answering
    const { adapter, resolver } = fakeResolver(async () => {
      expect(
        await append(ORG_A, sourceId, 1, capture('SECOND_CAPTURE_V2'))
      ).toMatchObject({ status: 'created' });
      return groundedAnswer('Done.');
    });
    const lookup = jest.spyOn(sources, 'getSourceForOrganization');
    const detail = jest.spyOn(sources, 'getVersionDetailByNumber');
    const value = await proposeItem(resolver, fixture, [sourceId]);
    expect(promptOf(adapter)).toContain('FIRST_CAPTURE_V1');
    expect(promptOf(adapter)).not.toContain('SECOND_CAPTURE_V2');
    expect(await contextOf(value.operationId)).toMatchObject({
      sources: [{ sourceId, versionId: v1.id, versionNumber: 1 }],
    });
    expect(value.provenance.sources[0]).toMatchObject({
      versionId: v1.id,
      versionNumber: 1,
    });
    // read once, before the run
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(detail).toHaveBeenCalledTimes(1);
    expect((await sourceRow(sourceId)).latestVersionNumber).toBe(2);
  });

  it('AIG3/78 an archive during the run does not stop it: the operation keeps version 1', async () => {
    const fixture = await aiFixture();
    const { sourceId } = await capturedSource();
    const v1 = await versionMeta(sourceId, 1);
    const { resolver } = fakeResolver(async () => {
      expect(await sources.archiveSource(ORG_A, sourceId, T2)).toEqual({
        count: 1,
      });
      return groundedAnswer('Done.');
    });
    const value = await proposeItem(resolver, fixture, [sourceId]);
    expect(value.provenance.sources[0]).toMatchObject({ versionId: v1.id });
    const [operation] = await operationRows();
    expect(operation).toMatchObject({
      status: 'succeeded',
      context: { sources: [{ sourceId, versionId: v1.id }] },
    });
    expect((await sourceRow(sourceId)).archivedAt).toEqual(T2);
  });

  it('AIG4/38 a source of another organization is not found, and nothing about it is told', async () => {
    const fixture = await aiFixture();
    const other = await capturedSource(ORG_B);
    const { adapter, resolver } = fakeResolver(groundedReply);
    expect(
      await httpRefusal(proposeItem(resolver, fixture, [other.sourceId]), [
        other.sourceId,
        other.versionId,
        NAME_MARKER,
      ])
    ).toEqual({
      status: 400,
      code: 'CS_AI_SOURCE_NOT_FOUND',
      msg: 'A selected source is no longer available.',
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    await expectNothingStored(adapter);
  });

  it('AIG5/39/80 an archived source is refused before anything runs', async () => {
    const fixture = await aiFixture();
    const { sourceId } = await capturedSource();
    await sources.archiveSource(ORG_A, sourceId, T2);
    const { adapter, resolver } = fakeResolver(groundedReply);
    expect(
      await httpRefusal(proposeItem(resolver, fixture, [sourceId]))
    ).toEqual({
      status: 409,
      code: 'CS_AI_SOURCE_ARCHIVED',
      msg: 'A selected source is archived.',
    });
    await expectNothingStored(adapter);
  });

  it('AIG6/40 a source never captured is not ready, and is not captured for the run', async () => {
    const fixture = await aiFixture();
    const sourceId = await createSource(ORG_A);
    const { adapter, resolver } = fakeResolver(groundedReply);
    expect(
      await httpRefusal(proposeItem(resolver, fixture, [sourceId]))
    ).toEqual({
      status: 400,
      code: 'CS_AI_SOURCE_NOT_READY',
      msg: 'A selected source has not been ingested yet.',
    });
    await expectNothingStored(adapter);
    expect(await versionsOf(sourceId)).toEqual([]);
    expect((await sourceRow(sourceId)).latestVersionNumber).toBe(0);
  });

  it('AIG7/41 a counter with no version behind it is an integrity error (PostgreSQL allows the row)', async () => {
    const fixture = await aiFixture();
    const sourceId = (
      await client.contentStudioSource.create({
        data: {
          organizationId: ORG_A,
          kind: 'url',
          name: NAME_MARKER,
          canonicalUrl: url('pointer'),
          latestVersionNumber: 1,
          createdById: USER_A1,
        },
      })
    ).id;
    const { adapter, resolver } = fakeResolver(groundedReply);
    expect(
      await httpRefusal(proposeItem(resolver, fixture, [sourceId]))
    ).toEqual({
      status: 500,
      code: 'CS_AI_SOURCE_INTEGRITY_ERROR',
      msg: 'Selected source context could not be verified.',
    });
    await expectNothingStored(adapter);
  });

  it('AIG8/42/116 a version changed behind the repository is refused, its text never told', async () => {
    const fixture = await aiFixture();
    const { sourceId, versionId } = await capturedSource();
    // PostgreSQL has no trigger against it: the update goes through
    await client.contentStudioSourceVersion.update({
      where: { id: versionId },
      data: { content: capture(CORRUPT_MARKER).content },
    });
    expect(
      (
        await client.contentStudioSourceVersion.findUniqueOrThrow({
          where: { id: versionId },
        })
      ).content
    ).toContain(CORRUPT_MARKER);
    const { adapter, resolver } = fakeResolver(groundedReply);
    expect(
      await httpRefusal(proposeItem(resolver, fixture, [sourceId]))
    ).toEqual({
      status: 500,
      code: 'CS_AI_SOURCE_INTEGRITY_ERROR',
      msg: 'Selected source context could not be verified.',
    });
    await expectNothingStored(adapter);
  });

  it('AIG9/43 a version made by the first extractor is still used', async () => {
    const fixture = await aiFixture();
    const { sourceId } = await capturedSource(
      ORG_A,
      capture(PROMPT_MARKER, { extractionVersion: 'content-studio-source-v1' })
    );
    const { adapter, resolver } = fakeResolver(groundedReply);
    const value = await proposeItem(resolver, fixture, [sourceId]);
    expect(promptOf(adapter)).toContain(PROMPT_MARKER);
    expect(promptOf(adapter)).not.toContain('content-studio-source-v1');
    expect(value.provenance.sources[0]).toMatchObject({ versionNumber: 1 });
  });

  it('AIG10/81/121 any member may use a source another member created', async () => {
    const fixture = await aiFixture();
    const { sourceId } = await capturedSource();
    expect((await sourceRow(sourceId)).createdById).toBe(USER_A1);
    const { resolver } = fakeResolver(groundedReply);
    const value = await proposeItem(resolver, fixture, [sourceId], USER_A2);
    const [operation] = await operationRows();
    expect(operation).toMatchObject({ id: value.operationId, userId: USER_A2 });
  });

  it('AIG11/44 sources are used in the order chosen, in the prompt and the operation', async () => {
    const fixture = await aiFixture();
    const one = await capturedSource(ORG_A, capture('MARKER_SOURCE_ONE'));
    const two = await capturedSource(ORG_A, capture('MARKER_SOURCE_TWO'));
    const { adapter, resolver } = fakeResolver(groundedReply);
    const value = await proposeItem(resolver, fixture, [
      two.sourceId,
      one.sourceId,
    ]);
    const prompt = promptOf(adapter);
    expect(prompt.indexOf('MARKER_SOURCE_TWO')).toBeGreaterThan(-1);
    expect(prompt.indexOf('MARKER_SOURCE_TWO')).toBeLessThan(
      prompt.indexOf('MARKER_SOURCE_ONE')
    );
    expect(
      (
        (await contextOf(value.operationId)) as {
          sources: Array<{ sourceId: string }>;
        }
      ).sources.map((s) => s.sourceId)
    ).toEqual([two.sourceId, one.sourceId]);
    // the same sources in the other order are another request
    const again = fakeResolver(groundedReply);
    const reversed = await proposeItem(again.resolver, fixture, [
      one.sourceId,
      two.sourceId,
    ]);
    const first = await operationRow(value.operationId);
    const second = await operationRow(reversed.operationId);
    expect(first.requestHash).not.toBe(second.requestHash);
  });

  it('AIG12/45 more than five sources is an invalid request, before any source is read', async () => {
    const fixture = await aiFixture();
    const lookup = jest.spyOn(sources, 'getSourceForOrganization');
    const { adapter, resolver } = fakeResolver(groundedReply);
    expect(
      (
        await httpRefusal(
          proposeItem(
            resolver,
            fixture,
            Array.from({ length: 6 }, () => randomUUID())
          )
        )
      ).code
    ).toBe('CS_INVALID_REQUEST');
    expect(lookup).not.toHaveBeenCalled();
    await expectNothingStored(adapter);
  });

  it('AIG13/76/77 a later capture with the same content is another request: the exact version is part of it', async () => {
    const fixture = await aiFixture();
    const { sourceId } = await capturedSource();
    const { resolver } = fakeResolver(groundedReply);
    const first = await proposeItem(resolver, fixture, [sourceId]);
    await append(ORG_A, sourceId, 1, capture(PROMPT_MARKER, { fetchedAt: T2 }));
    const second = await proposeItem(resolver, fixture, [sourceId]);
    const [v1, v2] = await versionsOf(sourceId);
    expect(v2.contentHash).toBe(v1.contentHash);
    const a = await operationRow(first.operationId);
    const b = await operationRow(second.operationId);
    expect(a.context).toMatchObject({
      sources: [{ versionId: v1.id, versionNumber: 1 }],
    });
    expect(b.context).toMatchObject({
      sources: [{ versionId: v2.id, versionNumber: 2 }],
    });
    expect(a.requestHash).not.toBe(b.requestHash);
  });

  it('AIG14 without sources the operation has no sources key', async () => {
    const fixture = await aiFixture();
    const { resolver } = fakeResolver(groundedReply);
    const value = await proposeItem(resolver, fixture, []);
    expect(await contextOf(value.operationId)).toEqual({
      v: 1,
      itemId: 'main',
    });
    expect(value.provenance).toEqual({ sources: [] });
  });
});

// ============================================================================
describe('H. What PostgreSQL does not enforce: the application does', () => {
  it('H4/51/53 an operation may hold source references that exist nowhere: they are JSON, not foreign keys', async () => {
    const packageId = await createPackage(ORG_A);
    const connectionId = await createConnection(ORG_A);
    const context = {
      v: 1,
      itemId: 'main',
      sources: [
        {
          sourceId: randomUUID(),
          versionId: randomUUID(),
          versionNumber: 7,
          contentHash: 'c'.repeat(64),
        },
      ],
    };
    const row = await client.contentStudioAIOperation.create({
      data: {
        id: randomUUID(),
        organizationId: ORG_A,
        userId: USER_A1,
        connectionId,
        packageId,
        kind: 'rewrite_item',
        status: 'running',
        provider: 'openai',
        model: 'gpt-6.1-sol',
        promptVersion: 'cs-rewrite-item-v2',
        baseDraftVersion: 1,
        context,
        requestHash: 'a'.repeat(64),
      },
    });
    expect(row.context).toEqual(context);
    // the shape check passes: whether the version exists is decided only
    // when the service resolves it, before an operation is created
    expect(parseContentStudioAIOperationContext(row.context)).toEqual(context);
  });

  it('H5/52 the context shape refuses source text, names, titles and source hashes', () => {
    const ref = {
      sourceId: randomUUID(),
      versionId: randomUUID(),
      versionNumber: 1,
      contentHash: 'c'.repeat(64),
    };
    expect(
      parseContentStudioAIOperationContext({ v: 1, sources: [ref] })
    ).toEqual({ v: 1, sources: [ref] });
    // anything more is not a context at all
    for (const extra of [
      { content: PROMPT_MARKER },
      { title: TITLE_MARKER },
      { name: NAME_MARKER },
      { sourceHash: 'd'.repeat(64) },
      { blocks: [] },
      { url: url() },
    ]) {
      expect(
        parseContentStudioAIOperationContext({
          v: 1,
          sources: [{ ...ref, ...extra }],
        })
      ).toBeUndefined();
    }
  });

  it("H6/31/57/58 PostgreSQL lets a direct update rewrite a version or a source URL and kind: immutability is the application's", async () => {
    const { sourceId, versionId } = await capturedSource();
    await client.contentStudioSourceVersion.update({
      where: { id: versionId },
      data: { title: 'Rewritten', redirectCount: 3 },
    });
    await client.contentStudioSource.update({
      where: { id: sourceId },
      data: { canonicalUrl: 'https://example.com/elsewhere', kind: 'rss' },
    });
    expect(
      await client.contentStudioSourceVersion.findUniqueOrThrow({
        where: { id: versionId },
      })
    ).toMatchObject({ title: 'Rewritten', redirectCount: 3 });
    expect(await sourceRow(sourceId)).toMatchObject({
      canonicalUrl: 'https://example.com/elsewhere',
      kind: 'rss',
    });
    // the repository has no write for either (P8-04B1: the backfill writes
    // the derived last page change only, never a version, URL or kind)
    const methods = Object.getOwnPropertyNames(
      ContentStudioSourceRepository.prototype
    );
    expect(
      methods.filter((name) => /update|delete|set|upsert/i.test(name)).sort()
      // P8-C4: a feed's interval and its next capture, nothing of a version
    ).toEqual([
      'setFeedInterval',
      'setPageChangeWithCompareAndSwap',
      'updateSourceName',
    ]);
  });
});
