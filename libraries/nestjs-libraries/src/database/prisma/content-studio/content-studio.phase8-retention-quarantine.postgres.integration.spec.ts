import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.service';
import { ContentStudioMediaService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.media.service';
import { ContentStudioReviewService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.service';
import { ContentStudioEditorialPolicyService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.service';
import { ContentStudioDesignService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.service';
import { ContentStudioDesignTemplateService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-template.service';
import { ContentStudioDesignPageSetService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-page-set.service';
import { ContentStudioGroundingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.grounding.service';
import { ContentStudioSourceRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.repository';
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import { ContentStudioSourceCaptureAttemptRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-capture-attempt.repository';
import { ContentStudioSourceDiscoveryRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-discovery.repository';
import { ContentStudioSourceRetentionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention.repository';
import { ContentStudioSourceRetentionService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention.service';
import { ContentStudioAIOperationRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-operation.repository';
import { ContentStudioWritingProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.writing-profile.repository';
import { ContentStudioEditorialPolicyRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.repository';
import { ContentStudioAudienceProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.audience-profile.repository';
import { ContentStudioExpertiseProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.expertise-profile.repository';
import { ContentStudioAIWritingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-writing.service';
import { ContentStudioAIExecutionService } from '@gitroom/nestjs-libraries/content-studio/ai/ai.execution.service';
import { ContentStudioAIProviderResolver } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.resolver';
import { ContentStudioAITextResult } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';
import {
  ContentStudioSourceRetentionDryRunError,
  ContentStudioSourceVersionQuarantineError,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';
import { storedContentStudioSourceContent } from '@gitroom/nestjs-libraries/content-studio/sources/source.version';
import { createContentStudioPostgresClient } from '../../../../../../jest.content-studio.postgres.guard';

// The real MediaService pulls in uploads, Redis and Temporal at import time;
// a draft save and a revision never reach it
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);

// The retention quarantine (P8-R1Q) on a real PostgreSQL: the first foreign
// key onto a version (Restrict) holding it against removal, one plan per
// version and organization, two plans racing on two connections, a held
// version refused by the real draft save, revision and AI writing (no row,
// no provider call), the verify-then-write race measured, history still
// readable, and the dry run refused while anything is held and exactly as
// before once released. Versions are removed here only to prove the key, in
// this test database. Opt-in: runs only through
// jest.content-studio.integration.config.ts against the disposable local
// database. Nothing is fetched

const ORG_A = '30a1d000-0000-4000-8000-00000000000a';
const ORG_B = '30a1d000-0000-4000-8000-00000000000b';
const ORGS = [ORG_A, ORG_B];
const USER: Record<string, string> = Object.fromEntries(
  ORGS.map((org, i) => [org, `30a1d000-0000-4000-8000-0000000000${i + 1}1`])
);
const CONNECTION: Record<string, string> = Object.fromEntries(
  ORGS.map((org, i) => [org, `30a1d000-0000-4000-8000-0000000000${i + 1}2`])
);
const NOW = new Date('2026-10-26T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const LONG_AGO = Date.UTC(2026, 0, 1);
const PLAN_A = 'a'.repeat(64);
const PLAN_B = 'b'.repeat(64);
const POLICY = {
  mode: 'compact_repeats',
  olderThan: new Date(NOW.getTime() - 7 * DAY),
};
const HELD = {
  status: 409,
  body: {
    msg: 'This source version is temporarily unavailable for new references',
    code: 'CS_SOURCE_VERSION_RETENTION_PENDING',
  },
};

let client: PrismaClient;
let other: PrismaClient;
let prisma: PrismaService;
let transaction: PrismaTransaction;
let packages: ContentStudioRepository;
let sources: ContentStudioSourceRepository;
let grounding: ContentStudioGroundingService;
let packageService: ContentStudioService;
let sourceService: ContentStudioSourceService;
let retentionRepository: ContentStudioSourceRetentionRepository;
let retention: ContentStudioSourceRetentionService;
let operations: ContentStudioAIOperationRepository;
let writingRepository: ContentStudioWritingProfileRepository;
let editorialRepository: ContentStudioEditorialPolicyRepository;
let audienceRepository: ContentStudioAudienceProfileRepository;
let expertiseRepository: ContentStudioExpertiseProfileRepository;

// A page whose captures are these texts, oldest first, made long ago
const insertPage = async (organizationId: string, texts: string[]) => {
  const id = randomUUID();
  const rows = texts.map((text, i) => ({
    id: randomUUID(),
    organizationId,
    sourceId: id,
    versionNumber: i + 1,
    extractionVersion: 'content-studio-source-v2',
    requestedUrl: 'https://p8r1q.example/page',
    finalUrl: 'https://p8r1q.example/page',
    redirectCount: 0,
    fetchedAt: new Date(LONG_AGO + (i + 1) * 60_000),
    httpStatus: 200,
    contentType: 'text/html',
    contentLength: 100,
    title: 'P8R1Q',
    sourceHash: null,
    createdById: USER[organizationId],
    createdAt: new Date(LONG_AGO + (i + 1) * 60_000),
    ...storedContentStudioSourceContent({
      schemaVersion: 1,
      blocks: [{ id: 'b1', type: 'paragraph', text, level: null }],
    }),
  }));
  await client.contentStudioSource.create({
    data: {
      id,
      organizationId,
      kind: 'url',
      name: 'P8R1Q page',
      canonicalUrl: `https://p8r1q.example/${id}`,
      createdById: USER[organizationId],
      latestVersionNumber: rows.length,
    },
  });
  await client.contentStudioSourceVersion.createMany({ data: rows });
  return { id, rows, n: (k: number) => rows[k - 1] };
};
type Row = Awaited<ReturnType<typeof insertPage>>['rows'][number];

const evidence = (v: Row) => ({
  sourceId: v.sourceId,
  versionId: v.id,
  versionNumber: v.versionNumber,
  contentHash: v.contentHash,
  blockId: 'b1',
  quote: null,
});
const grounded = (...list: Row[]) => ({
  schemaVersion: 2,
  copy: { global: { thread: [{ id: 'main', text: 'Spring', mediaIds: [] }] } },
  grounding: {
    claims: [
      {
        id: 'c_p8r1q_claim',
        threadItemId: 'main',
        text: 'A claim',
        evidence: list.map(evidence),
      },
    ],
  },
});
const insertPackage = async (organizationId: string, draft: unknown) =>
  (
    await client.contentPackage.create({
      data: {
        organizationId,
        name: 'P8R1Q package',
        draft: JSON.stringify(draft),
        draftVersion: 1,
        createdById: USER[organizationId],
      },
      select: { id: true },
    })
  ).id;
const packageRow = (id: string) =>
  client.contentPackage.findUniqueOrThrow({
    where: { id },
    select: { draft: true, draftVersion: true, latestRevisionNumber: true },
  });

const pendingRows = (organizationId?: string) =>
  client.contentStudioSourceVersionRetentionPending.findMany({
    where: { organizationId: organizationId ?? { in: ORGS } },
    orderBy: [{ organizationId: 'asc' }, { sourceVersionId: 'asc' }],
  });
const hold = (
  organizationId: string,
  sourceVersionIds: string[],
  planHash = PLAN_A,
  now = NOW
) =>
  retention.quarantineSourceVersions({
    organizationId,
    sourceVersionIds,
    planHash,
    now,
  });

const refusal = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(HttpException);
  return {
    status: (err as HttpException).getStatus(),
    body: (err as HttpException).getResponse(),
  };
};
const quarantineError = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a quarantine error');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ContentStudioSourceVersionQuarantineError);
  return (err as ContentStudioSourceVersionQuarantineError).code;
};

// Two parties meet before either goes on
const barrier = (parties: number) => {
  let arrived = 0;
  let open: () => void = () => undefined;
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
          8000
        );
      }),
    ]).finally(() => clearTimeout(timer));
  };
};

// The real client's transaction, its options passed on, with `hook` run
// right before the given model's method inside it (a test object, never a
// production hook)
const hooked = (
  db: PrismaClient,
  at: { model: string; method: string; hook: () => Promise<void> }
) =>
  ({
    model: {
      $transaction: (
        fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: object
      ) =>
        db.$transaction(
          (tx) =>
            fn(
              new Proxy(tx, {
                get(target, property, receiver) {
                  const value = Reflect.get(target, property, receiver);
                  if (property !== at.model) {
                    return value;
                  }
                  return new Proxy(value, {
                    get(model, name, modelReceiver) {
                      const original = Reflect.get(model, name, modelReceiver);
                      if (name !== at.method) {
                        return original;
                      }
                      return async (args: unknown) => {
                        await at.hook();
                        return original.call(model, args);
                      };
                    },
                  });
                },
              })
            ),
          options
        ),
    },
  } as unknown as PrismaTransaction);

const packageServiceWith = (repository: ContentStudioRepository) =>
  new ContentStudioService(
    repository,
    {} as ContentStudioMediaService,
    grounding,
    // never reached by a draft save or a revision
    {} as ContentStudioReviewService,
    {} as ContentStudioEditorialPolicyService,
    {} as ContentStudioDesignService,
    {} as ContentStudioDesignTemplateService,
    {} as ContentStudioDesignPageSetService
  );
const packagesWith = (tx: PrismaTransaction) =>
  new ContentStudioRepository(
    new PrismaRepository<'contentStudioProject'>(prisma),
    new PrismaRepository<'contentPackage'>(prisma),
    new PrismaRepository<'contentPackageRevision'>(prisma),
    tx
  );
const retentionWith = (db: PrismaClient, tx: PrismaTransaction) => {
  const service = db as unknown as PrismaService;
  return new ContentStudioSourceRetentionService(
    new ContentStudioSourceRetentionRepository(
      new PrismaRepository<'contentStudioSourceVersion'>(service),
      new PrismaRepository<'contentStudioSourceVersionRetentionPending'>(
        service
      ),
      tx
    )
  );
};

// AI writing with an adapter that answers in memory
const fakeAdapter = () => {
  const adapter = {
    provider: 'openai' as const,
    validateConnection: jest.fn(),
    generateText: jest.fn(
      async (): Promise<ContentStudioAITextResult> => ({
        text: JSON.stringify({ text: 'A brighter spring.', claims: [] }),
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5 },
        providerRequestId: 'req_p8r1q',
      })
    ),
  };
  const resolver = {
    resolve: jest.fn(async (where: { connectionId: string }) => ({
      connectionId: where.connectionId,
      provider: 'openai' as const,
      adapter,
    })),
  };
  return { adapter, resolver };
};
const writing = (
  resolver: unknown,
  operationRepository: ContentStudioAIOperationRepository = operations
) =>
  new ContentStudioAIWritingService(
    packages,
    writingRepository,
    editorialRepository,
    audienceRepository,
    expertiseRepository,
    new ContentStudioAIExecutionService(
      packages,
      resolver as ContentStudioAIProviderResolver,
      operationRepository
    ),
    sources
  );
const propose = (resolver: unknown, packageId: string, sourceId: string) =>
  writing(resolver).proposeItem({
    organizationId: ORG_A,
    userId: USER[ORG_A],
    packageId,
    operation: 'rewrite_item',
    itemId: 'main',
    selection: {
      connectionId: CONNECTION[ORG_A],
      model: 'gpt-6.1-sol',
      baseDraftVersion: 1,
      sourceIds: [sourceId],
    },
  });
const operationRows = () =>
  client.contentStudioAIOperation.findMany({
    where: { organizationId: { in: ORGS } },
  });

const clean = async () => {
  const where = { organizationId: { in: ORGS } };
  await client.contentStudioSourceVersionRetentionPending.deleteMany({ where });
  await client.contentStudioAIUsage.deleteMany({ where });
  await client.contentStudioAIOperation.deleteMany({ where });
  await client.contentPackageRevision.deleteMany({ where });
  await client.contentPackage.deleteMany({ where });
  // test data only, in the disposable database
  await client.contentStudioSourceVersion.deleteMany({ where });
  await client.contentStudioSource.deleteMany({ where });
};
const cleanFixtures = async () => {
  await clean();
  const where = { organizationId: { in: ORGS } };
  await client.contentStudioAIConnection.deleteMany({ where });
  await client.userOrganization.deleteMany({ where });
  await client.user.deleteMany({ where: { id: { in: Object.values(USER) } } });
  await client.organization.deleteMany({ where: { id: { in: ORGS } } });
};

let fetchSpy: jest.SpyInstance;

beforeAll(async () => {
  client = createContentStudioPostgresClient();
  other = createContentStudioPostgresClient();
  await client.$connect();
  await other.$connect();
  prisma = client as unknown as PrismaService;
  transaction = new PrismaTransaction(prisma);
  packages = packagesWith(transaction);
  sources = new ContentStudioSourceRepository(
    new PrismaRepository<'contentStudioSource'>(prisma),
    new PrismaRepository<'contentStudioSourceVersion'>(prisma),
    transaction
  );
  grounding = new ContentStudioGroundingService(sources);
  packageService = packageServiceWith(packages);
  sourceService = new ContentStudioSourceService(
    sources,
    new ContentStudioSourceDiscoveryRepository(
      new PrismaRepository<'contentStudioSourceDiscovery'>(prisma)
    ),
    new ContentStudioSourceCaptureAttemptRepository(
      new PrismaRepository<'contentStudioSourceCaptureAttempt'>(prisma)
    )
  );
  retentionRepository = new ContentStudioSourceRetentionRepository(
    new PrismaRepository<'contentStudioSourceVersion'>(prisma),
    new PrismaRepository<'contentStudioSourceVersionRetentionPending'>(prisma),
    transaction
  );
  retention = new ContentStudioSourceRetentionService(retentionRepository);
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
  await cleanFixtures();
  for (const org of ORGS) {
    await client.organization.create({
      data: { id: org, name: `P8R1Q ${org}` },
    });
    await client.user.create({
      data: {
        id: USER[org],
        email: `${USER[org]}@p8r1q.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P8R1Q ${org}`,
      },
    });
    await client.userOrganization.create({
      data: { userId: USER[org], organizationId: org, role: 'USER' },
    });
    await client.contentStudioAIConnection.create({
      data: {
        id: CONNECTION[org],
        organizationId: org,
        name: 'P8R1Q',
        provider: 'openai',
        credentialUpdatedAt: new Date(),
        createdById: USER[org],
      },
    });
  }
});

beforeEach(async () => {
  await clean();
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('network access in the PostgreSQL integration suite');
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

afterAll(async () => {
  if (client) {
    await cleanFixtures();
    await client.$disconnect();
  }
  await other?.$disconnect();
});

describe('P8-R1Q the held row on PostgreSQL', () => {
  it('PGQ1 a held version cannot be removed: the foreign key is RESTRICT; released, it can (test-only removal)', async () => {
    const page = await insertPage(ORG_A, ['A', 'A', 'B']);
    const v2 = page.n(2);
    expect(await hold(ORG_A, [v2.id])).toEqual({
      created: 1,
      alreadyPending: 0,
    });
    // the database refuses, whoever asks
    const refused = await client.contentStudioSourceVersion
      .delete({ where: { id: v2.id } })
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((refused as Prisma.PrismaClientKnownRequestError).code).toBe(
      'P2003'
    );
    expect(
      await client.contentStudioSourceVersion.count({ where: { id: v2.id } })
    ).toBe(1);
    // the key itself: onto (id, organizationId), RESTRICT on delete and
    // update (test-only catalog read)
    const keys = await client.$queryRaw<
      Array<{ name: string; deletes: string; updates: string; def: string }>
    >`SELECT c.conname AS name, c.confdeltype::text AS deletes,
             c.confupdtype::text AS updates, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
       WHERE c.conrelid = '"ContentStudioSourceVersionRetentionPending"'::regclass
         AND c.contype = 'f'
       ORDER BY c.conname`;
    expect(
      keys.map(({ deletes, updates, def }) => [deletes, updates, def])
    ).toEqual([
      [
        'r',
        'c',
        'FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON UPDATE CASCADE ON DELETE RESTRICT',
      ],
      [
        'r',
        'r',
        'FOREIGN KEY ("sourceVersionId", "organizationId") REFERENCES "ContentStudioSourceVersion"(id, "organizationId") ON UPDATE RESTRICT ON DELETE RESTRICT',
      ],
    ]);
    // nothing holds the others: one of them can go (test only)
    await client.contentStudioSourceVersion.delete({
      where: { id: page.n(1).id },
    });
    expect(
      await retention.releaseSourceVersionQuarantine({
        organizationId: ORG_A,
        planHash: PLAN_A,
      })
    ).toEqual({ released: 1 });
    await client.contentStudioSourceVersion.delete({ where: { id: v2.id } });
    expect(
      await client.contentStudioSourceVersion.count({ where: { id: v2.id } })
    ).toBe(0);
  });

  it('PGQ2 the same plan again: one row per version, the first pendingAt and id kept, the new version held at its own time', async () => {
    const page = await insertPage(ORG_A, ['A', 'A', 'A', 'B']);
    const [v1, v2, v3] = [page.n(1), page.n(2), page.n(3)];
    await hold(ORG_A, [v1.id, v2.id], PLAN_A, NOW);
    const first = await pendingRows(ORG_A);
    const later = new Date(NOW.getTime() + 90_000);
    expect(await hold(ORG_A, [v2.id, v1.id, v3.id], PLAN_A, later)).toEqual({
      created: 1,
      alreadyPending: 2,
    });
    const rows = await pendingRows(ORG_A);
    expect(rows).toHaveLength(3);
    for (const row of first) {
      expect(
        rows.find((r) => r.sourceVersionId === row.sourceVersionId)
      ).toEqual(row);
    }
    expect(
      rows.find((r) => r.sourceVersionId === v3.id)!.pendingAt.toISOString()
    ).toBe(later.toISOString());
    expect(first.map((row) => row.pendingAt.toISOString())).toEqual([
      NOW.toISOString(),
      NOW.toISOString(),
    ]);
    // the read the next phase will use: by version id, with pendingAt
    expect(
      await retention.listSourceVersionQuarantine({
        organizationId: ORG_A,
        planHash: PLAN_A,
      })
    ).toEqual(
      [...rows]
        .sort((a, b) => (a.sourceVersionId < b.sourceVersionId ? -1 : 1))
        .map(({ sourceVersionId, planHash, pendingAt }) => ({
          sourceVersionId,
          planHash,
          pendingAt,
        }))
    );
    expect(
      await retentionRepository.getPendingForVersion({
        organizationId: ORG_A,
        sourceVersionId: v3.id,
      })
    ).toEqual({ sourceVersionId: v3.id, planHash: PLAN_A, pendingAt: later });
    expect(
      await retentionRepository.getPendingForVersion({
        organizationId: ORG_B,
        sourceVersionId: v3.id,
      })
    ).toBeNull();
  });

  it('PGQ3 another plan: PLAN_CONFLICT for the same version and for any other of the organization; plan A untouched', async () => {
    const page = await insertPage(ORG_A, ['A', 'A', 'A', 'B']);
    await hold(ORG_A, [page.n(2).id]);
    const before = await pendingRows();
    for (const ids of [
      [page.n(2).id],
      [page.n(3).id],
      [page.n(3).id, page.n(2).id],
    ]) {
      expect(await quarantineError(hold(ORG_A, ids, PLAN_B))).toBe(
        'RETENTION_QUARANTINE_PLAN_CONFLICT'
      );
    }
    expect(await pendingRows()).toEqual(before);
    // a direct second row for the version is refused by the unique key
    const duplicate = await client.contentStudioSourceVersionRetentionPending
      .create({
        data: {
          organizationId: ORG_A,
          sourceVersionId: page.n(2).id,
          planHash: PLAN_B,
        },
      })
      .catch((err: unknown) => err);
    expect((duplicate as Prisma.PrismaClientKnownRequestError).code).toBe(
      'P2002'
    );
  });

  it('PGQ4 two plans at once on two connections: exactly one holds, the other is PLAN_CONFLICT, whatever versions they name', async () => {
    const results: string[] = [];
    for (const shape of ['same version', 'other versions'] as const) {
      for (let round = 0; round < 3; round++) {
        await clean();
        const page = await insertPage(ORG_A, ['A', 'A', 'A', 'B']);
        const meet = barrier(2);
        let met = 0;
        // both read inside their serializable transactions, then both write
        const racing = (db: PrismaClient) =>
          retentionWith(
            db,
            hooked(db, {
              model: 'contentStudioSourceVersionRetentionPending',
              method: 'createMany',
              hook: async () => {
                if (met < 2) {
                  met += 1;
                  await meet();
                }
              },
            })
          );
        const settled = await Promise.allSettled([
          racing(client).quarantineSourceVersions({
            organizationId: ORG_A,
            sourceVersionIds: [page.n(2).id],
            planHash: PLAN_A,
            now: NOW,
          }),
          racing(other).quarantineSourceVersions({
            organizationId: ORG_A,
            sourceVersionIds: [
              shape === 'same version' ? page.n(2).id : page.n(3).id,
            ],
            planHash: PLAN_B,
            now: NOW,
          }),
        ]);
        expect(met).toBe(2);
        const won = settled.filter((s) => s.status === 'fulfilled');
        const lost = settled.filter(
          (s): s is PromiseRejectedResult => s.status === 'rejected'
        );
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(1);
        expect(lost[0].reason).toEqual(
          new ContentStudioSourceVersionQuarantineError(
            'RETENTION_QUARANTINE_PLAN_CONFLICT'
          )
        );
        const rows = await pendingRows(ORG_A);
        expect(rows).toHaveLength(1);
        const winner = settled[0].status === 'fulfilled' ? PLAN_A : PLAN_B;
        expect(rows[0].planHash).toBe(winner);
        results.push(`${shape}: ${winner === PLAN_A ? 'A' : 'B'} won`);
      }
    }
    expect(results).toHaveLength(6);
  });

  it('PGQ5/PGQ6 a missing version, or one of another organization, fails the whole batch: nothing held, nothing named', async () => {
    const a = await insertPage(ORG_A, ['A', 'A', 'B']);
    const b = await insertPage(ORG_B, ['A', 'A', 'B']);
    for (const ids of [
      [a.n(1).id, randomUUID()],
      [a.n(1).id, b.n(2).id],
      [b.n(2).id],
    ]) {
      const err = await hold(ORG_A, ids).catch((e: unknown) => e);
      expect(err).toEqual(
        new ContentStudioSourceVersionQuarantineError(
          'RETENTION_QUARANTINE_VERSION_NOT_FOUND'
        )
      );
      expect((err as Error).message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    }
    expect(await pendingRows()).toEqual([]);
    // the composite key: a row of org A can never name a version of org B
    const crossed = await client.contentStudioSourceVersionRetentionPending
      .create({
        data: {
          organizationId: ORG_A,
          sourceVersionId: b.n(2).id,
          planHash: PLAN_A,
        },
      })
      .catch((err: unknown) => err);
    expect((crossed as Prisma.PrismaClientKnownRequestError).code).toBe(
      'P2003'
    );
    expect(await pendingRows()).toEqual([]);
  });

  it('PGQ7 release: only these rows, only of the plan and organization; again is nothing; versions all stay', async () => {
    const a = await insertPage(ORG_A, ['A', 'A', 'A', 'B']);
    const b = await insertPage(ORG_B, ['A', 'A', 'B']);
    await hold(ORG_A, [a.n(2).id, a.n(3).id], PLAN_A);
    // org B's own plan, with the same hash: still another organization's
    await hold(ORG_B, [b.n(2).id], PLAN_A);
    const versions = await client.contentStudioSourceVersion.count({
      where: { organizationId: { in: ORGS } },
    });
    const release = (
      organizationId: string,
      planHash: string,
      ids?: string[]
    ) =>
      retention.releaseSourceVersionQuarantine({
        organizationId,
        planHash,
        ...(ids ? { sourceVersionIds: ids } : {}),
      });
    expect(await release(ORG_A, PLAN_B)).toEqual({ released: 0 });
    expect(await release(ORG_A, PLAN_A, [a.n(2).id, b.n(2).id])).toEqual({
      released: 1,
    });
    expect(
      (await pendingRows()).map((row) => row.sourceVersionId).sort()
    ).toEqual([a.n(3).id, b.n(2).id].sort());
    expect(await release(ORG_A, PLAN_A)).toEqual({ released: 1 });
    expect(await release(ORG_A, PLAN_A)).toEqual({ released: 0 });
    expect((await pendingRows()).map((row) => row.organizationId)).toEqual([
      ORG_B,
    ]);
    expect(
      await client.contentStudioSourceVersion.count({
        where: { organizationId: { in: ORGS } },
      })
    ).toBe(versions);
  });
});

describe('P8-R1Q writers of a new reference on PostgreSQL', () => {
  it('PGQ8 the real draft save: a held version is the 409 and the draft is not written; the same save without it, or before it, goes on', async () => {
    const page = await insertPage(ORG_A, ['A', 'A', 'B']);
    const packageId = await insertPackage(ORG_A, grounded(page.n(1)));
    const before = await packageRow(packageId);
    // the editor picked v2 and v3 before v2 was held: a stale submission
    const stale = grounded(page.n(2), page.n(3));
    await hold(ORG_A, [page.n(2).id]);
    expect(
      await refusal(
        packageService.saveDraft({
          organizationId: ORG_A,
          packageId,
          baseDraftVersion: 1,
          draft: stale,
        })
      )
    ).toEqual(HELD);
    expect(await packageRow(packageId)).toEqual(before);
    // a draft keeping a reference it already had is refused just the same
    await hold(ORG_A, [page.n(1).id]);
    expect(
      await refusal(
        packageService.saveDraft({
          organizationId: ORG_A,
          packageId,
          baseDraftVersion: 1,
          draft: grounded(page.n(1)),
        })
      )
    ).toEqual(HELD);
    expect(await packageRow(packageId)).toEqual(before);
    // without the held versions the same save goes on
    expect(
      await packageService.saveDraft({
        organizationId: ORG_A,
        packageId,
        baseDraftVersion: 1,
        draft: grounded(page.n(3)),
      })
    ).toEqual({ draftVersion: 2 });
    // missing stays the 400 it was, never the held answer
    expect(
      (
        await refusal(
          packageService.saveDraft({
            organizationId: ORG_A,
            packageId,
            baseDraftVersion: 2,
            draft: grounded({ ...page.n(3), id: randomUUID() }),
          })
        )
      ).body
    ).toEqual(expect.objectContaining({ code: 'CS_DRAFT_GROUNDING_INVALID' }));
  });

  it('PGQ9 the real revision: a held version is the 409 and no revision is made', async () => {
    const page = await insertPage(ORG_A, ['A', 'A', 'B']);
    const packageId = await insertPackage(ORG_A, grounded(page.n(2)));
    await hold(ORG_A, [page.n(2).id]);
    expect(
      await refusal(
        packageService.createRevision({
          organizationId: ORG_A,
          packageId,
          userId: USER[ORG_A],
          draftVersion: 1,
        })
      )
    ).toEqual(HELD);
    expect(
      await client.contentPackageRevision.count({ where: { packageId } })
    ).toBe(0);
    expect((await packageRow(packageId)).latestRevisionNumber).toBe(0);
    await retention.releaseSourceVersionQuarantine({
      organizationId: ORG_A,
      planHash: PLAN_A,
    });
    expect(
      (
        await packageService.createRevision({
          organizationId: ORG_A,
          packageId,
          userId: USER[ORG_A],
          draftVersion: 1,
        })
      ).created
    ).toBe(true);
  });

  it('PGQ10 AI writing: a held source version makes no operation and the provider is never asked; released, the same request runs', async () => {
    const page = await insertPage(ORG_A, ['A', 'A', 'B']);
    const packageId = await insertPackage(ORG_A, {
      schemaVersion: 1,
      copy: {
        global: { thread: [{ id: 'main', text: 'Spring', mediaIds: [] }] },
      },
    });
    // synthetic: a plan never holds a latest version (it is protected), but
    // the gate does not ask why a version is held
    await hold(ORG_A, [page.n(3).id]);
    const { adapter, resolver } = fakeAdapter();
    expect(await refusal(propose(resolver, packageId, page.id))).toEqual(HELD);
    expect(adapter.generateText).not.toHaveBeenCalled();
    expect(await operationRows()).toEqual([]);
    expect(
      await client.contentStudioAIUsage.count({
        where: { organizationId: { in: ORGS } },
      })
    ).toBe(0);
    await retention.releaseSourceVersionQuarantine({
      organizationId: ORG_A,
      planHash: PLAN_A,
    });
    const value = await propose(resolver, packageId, page.id);
    expect(adapter.generateText).toHaveBeenCalledTimes(1);
    const [operation] = await operationRows();
    expect(operation.id).toBe(value.operationId);
    expect(
      (operation.context as { sources: Array<{ versionId: string }> }).sources
    ).toEqual([expect.objectContaining({ versionId: page.n(3).id })]);
  });

  it('PGQ11 reading evidence (what a review shows) never asks whether a version is held: no new reference is made', async () => {
    const page = await insertPage(ORG_A, ['A', 'A', 'B']);
    await hold(ORG_A, [page.n(2).id]);
    const [resolved] = await grounding.resolveEvidence(ORG_A, [
      evidence(page.n(2)),
    ]);
    expect(resolved.version.id).toBe(page.n(2).id);
    expect(resolved.block.id).toBe('b1');
  });

  it('PGQ13 a held version stays in the history: listed, read and compared as before, with no field of it', async () => {
    const page = await insertPage(ORG_A, ['A', 'A', 'B']);
    await hold(ORG_A, [page.n(2).id, page.n(3).id]);
    const list = await sourceService.listVersions({
      organizationId: ORG_A,
      sourceId: page.id,
      page: 1,
    });
    expect(list.results.map((v) => v.id)).toContain(page.n(2).id);
    const detail = await sourceService.getVersion({
      organizationId: ORG_A,
      sourceId: page.id,
      versionId: page.n(2).id,
    });
    expect(detail.id).toBe(page.n(2).id);
    const changes = await sourceService.getVersionChanges({
      organizationId: ORG_A,
      sourceId: page.id,
      versionId: page.n(3).id,
    });
    expect(changes).toBeTruthy();
    expect(JSON.stringify([list, detail, changes])).not.toMatch(
      /pending|quarantine|planHash|retention/i
    );
  });
});

describe('P8-R1Q the verify-then-write race on PostgreSQL', () => {
  // The writer's own transaction with a pause right before its write, after
  // its held check passed: a plan holds the version in that pause
  const inFlight = (model: string, method: string) => {
    let reached: () => void = () => undefined;
    const atWrite = new Promise<void>((resolve) => (reached = resolve));
    let go: () => void = () => undefined;
    const resume = new Promise<void>((resolve) => (go = resolve));
    const repository = packagesWith(
      hooked(client, {
        model,
        method,
        hook: async () => {
          reached();
          await resume;
        },
      })
    );
    return { repository, atWrite, go };
  };

  it('PGQ14a once a hold is committed, every later draft save, revision and AI run naming it is refused', async () => {
    const page = await insertPage(ORG_A, ['A', 'A', 'B']);
    const draftPackage = await insertPackage(ORG_A, grounded(page.n(1)));
    const revisionPackage = await insertPackage(ORG_A, grounded(page.n(3)));
    const aiPackage = await insertPackage(ORG_A, {
      schemaVersion: 1,
      copy: {
        global: { thread: [{ id: 'main', text: 'Spring', mediaIds: [] }] },
      },
    });
    // held on the other connection, committed before the writers start
    await retentionWith(
      other,
      new PrismaTransaction(other as unknown as PrismaService)
    ).quarantineSourceVersions({
      organizationId: ORG_A,
      sourceVersionIds: [page.n(3).id],
      planHash: PLAN_A,
      now: NOW,
    });
    const { adapter, resolver } = fakeAdapter();
    const results = await Promise.allSettled([
      packageService.saveDraft({
        organizationId: ORG_A,
        packageId: draftPackage,
        baseDraftVersion: 1,
        draft: grounded(page.n(3)),
      }),
      packageService.createRevision({
        organizationId: ORG_A,
        packageId: revisionPackage,
        userId: USER[ORG_A],
        draftVersion: 1,
      }),
      propose(resolver, aiPackage, page.id),
    ]);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      expect(
        ((result as PromiseRejectedResult).reason as HttpException).getStatus()
      ).toBe(409);
    }
    expect(adapter.generateText).not.toHaveBeenCalled();
    expect(await operationRows()).toEqual([]);
    expect(
      await client.contentPackageRevision.count({
        where: { organizationId: ORG_A },
      })
    ).toBe(0);
    expect((await packageRow(draftPackage)).draftVersion).toBe(1);
  });

  // 30 captures: v2 is past the picker window, so only a reference keeps it
  const OLD_PAGE = [...Array(29).fill('A'), 'B'];

  it('PGQ14b a draft save whose check passed before the hold committed still commits, within its own transaction: protection sees the reference after', async () => {
    const page = await insertPage(ORG_A, OLD_PAGE);
    const packageId = await insertPackage(ORG_A, {
      schemaVersion: 1,
      copy: {
        global: { thread: [{ id: 'main', text: 'Spring', mediaIds: [] }] },
      },
    });
    const { repository, atWrite, go } = inFlight(
      'contentPackage',
      'updateMany'
    );
    const saving = packageServiceWith(repository).saveDraft({
      organizationId: ORG_A,
      packageId,
      baseDraftVersion: 1,
      draft: grounded(page.n(2)),
    });
    await atWrite;
    // the plan holds v2 while the save is between its check and its write
    await retentionWith(
      other,
      new PrismaTransaction(other as unknown as PrismaService)
    ).quarantineSourceVersions({
      organizationId: ORG_A,
      sourceVersionIds: [page.n(2).id],
      planHash: PLAN_A,
      now: NOW,
    });
    go();
    expect(await saving).toEqual({ draftVersion: 2 });
    // the fresh protection check of the plan, after its wait, sees it
    const map = await retention.computeProtectionMap({
      organizationId: ORG_A,
      now: NOW,
    });
    expect(map.get(page.n(2).id)?.map((p) => p.reason)).toEqual([
      'DRAFT_EVIDENCE',
    ]);
    // and any later save naming it is refused
    expect(
      await refusal(
        packageService.saveDraft({
          organizationId: ORG_A,
          packageId,
          baseDraftVersion: 2,
          draft: grounded(page.n(2)),
        })
      )
    ).toEqual(HELD);
  });

  it('PGQ14c the same for a revision: committed in its transaction, then REVISION_EVIDENCE', async () => {
    const page = await insertPage(ORG_A, OLD_PAGE);
    const packageId = await insertPackage(ORG_A, grounded(page.n(2)));
    const { repository, atWrite, go } = inFlight(
      'contentPackageRevision',
      'create'
    );
    const revising = packageServiceWith(repository).createRevision({
      organizationId: ORG_A,
      packageId,
      userId: USER[ORG_A],
      draftVersion: 1,
    });
    await atWrite;
    await retentionWith(
      other,
      new PrismaTransaction(other as unknown as PrismaService)
    ).quarantineSourceVersions({
      organizationId: ORG_A,
      sourceVersionIds: [page.n(2).id],
      planHash: PLAN_A,
      now: NOW,
    });
    go();
    expect((await revising).created).toBe(true);
    const map = await retention.computeProtectionMap({
      organizationId: ORG_A,
      now: NOW,
    });
    expect(
      map
        .get(page.n(2).id)
        ?.map((p) => p.reason)
        .sort()
    ).toEqual(['DRAFT_EVIDENCE', 'REVISION_EVIDENCE']);
  });

  it('PGQ14d a writer that passed its check can only commit within its transaction: Prisma ends it after 5 seconds and nothing is written', async () => {
    const page = await insertPage(ORG_A, OLD_PAGE);
    const packageId = await insertPackage(ORG_A, {
      schemaVersion: 1,
      copy: {
        global: { thread: [{ id: 'main', text: 'Spring', mediaIds: [] }] },
      },
    });
    const { repository, atWrite, go } = inFlight(
      'contentPackage',
      'updateMany'
    );
    const started = Date.now();
    const saving = packageServiceWith(repository)
      .saveDraft({
        organizationId: ORG_A,
        packageId,
        baseDraftVersion: 1,
        draft: grounded(page.n(2)),
      })
      .then(
        () => 'committed',
        (err: unknown) => err
      );
    await atWrite;
    await hold(ORG_A, [page.n(2).id]);
    // the writer stalls past the transaction's 5 seconds
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    go();
    const outcome = await saving;
    expect(outcome).not.toBe('committed');
    expect((outcome as Prisma.PrismaClientKnownRequestError).code).toBe(
      'P2028'
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
    expect(await packageRow(packageId)).toEqual(
      expect.objectContaining({ draftVersion: 1 })
    );
    const map = await retention.computeProtectionMap({
      organizationId: ORG_A,
      now: NOW,
    });
    expect(map.get(page.n(2).id)).toBeUndefined();
  }, 20_000);

  it('PGQ14e the window measured: from the held check to the commit of the write, each writer', async () => {
    const page = await insertPage(ORG_A, ['A', 'A', 'B']);
    const windows: Record<string, number[]> = {
      saveDraft: [],
      createRevision: [],
      aiOperation: [],
    };
    // the time from the held check's answer to the transaction's end
    const timed = (db: PrismaClient, into: number[]) =>
      ({
        model: {
          $transaction: async (
            fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
            options?: object
          ) => {
            let checked = 0n;
            const result = await db.$transaction(
              (tx) =>
                fn(
                  new Proxy(tx, {
                    get(target, property, receiver) {
                      const value = Reflect.get(target, property, receiver);
                      if (
                        property !==
                        'contentStudioSourceVersionRetentionPending'
                      ) {
                        return value;
                      }
                      return new Proxy(value, {
                        get(model, name, modelReceiver) {
                          const original = Reflect.get(
                            model,
                            name,
                            modelReceiver
                          );
                          if (name !== 'findFirst') {
                            return original;
                          }
                          return async (args: unknown) => {
                            const found = await original.call(model, args);
                            checked = process.hrtime.bigint();
                            return found;
                          };
                        },
                      });
                    },
                  })
                ),
              options
            );
            // the completion of an AI operation checks nothing
            if (checked) {
              into.push(Number(process.hrtime.bigint() - checked) / 1e6);
            }
            return result;
          },
        },
      } as unknown as PrismaTransaction);
    for (let i = 0; i < 10; i++) {
      const packageId = await insertPackage(ORG_A, grounded(page.n(2)));
      const service = packageServiceWith(
        packagesWith(timed(client, windows.saveDraft))
      );
      await service.saveDraft({
        organizationId: ORG_A,
        packageId,
        baseDraftVersion: 1,
        draft: grounded(page.n(2)),
      });
      await packageServiceWith(
        packagesWith(timed(client, windows.createRevision))
      ).createRevision({
        organizationId: ORG_A,
        packageId,
        userId: USER[ORG_A],
        draftVersion: 2,
      });
      const aiPackage = await insertPackage(ORG_A, {
        schemaVersion: 1,
        copy: {
          global: { thread: [{ id: 'main', text: 'Spring', mediaIds: [] }] },
        },
      });
      const { resolver } = fakeAdapter();
      await writing(
        resolver,
        new ContentStudioAIOperationRepository(
          new PrismaRepository<'contentStudioAIOperation'>(prisma),
          timed(client, windows.aiOperation)
        )
      ).proposeItem({
        organizationId: ORG_A,
        userId: USER[ORG_A],
        packageId: aiPackage,
        operation: 'rewrite_item',
        itemId: 'main',
        selection: {
          connectionId: CONNECTION[ORG_A],
          model: 'gpt-6.1-sol',
          baseDraftVersion: 1,
          sourceIds: [page.id],
        },
      });
    }
    const summary = Object.fromEntries(
      Object.entries(windows).map(([writer, list]) => [
        writer,
        {
          runs: list.length,
          maxMs: Math.round(Math.max(...list) * 100) / 100,
        },
      ])
    );
    // eslint-disable-next-line no-console
    console.log(`PGQ14e verify-to-commit windows: ${JSON.stringify(summary)}`);
    for (const list of Object.values(windows)) {
      expect(list).toHaveLength(10);
      // far inside the 5 seconds a transaction may last, and the 60 a plan
      // waits
      expect(Math.max(...list)).toBeLessThan(1_000);
    }
  });
});

describe('P8-R1Q the dry run while versions are held, on PostgreSQL', () => {
  it('PGQ12 a held version refuses the dry run of its organization only; released, the report and hash are exactly those of before', async () => {
    // A1..A12 B13..B40: v2..v11 old repeats; v21..v40 the picker window
    const a = await insertPage(ORG_A, [
      ...Array(12).fill('Alpha'),
      ...Array(28).fill('Beta'),
    ]);
    const b = await insertPage(ORG_B, Array(30).fill('Alpha'));
    // the stored page change, as the real backfill derives it
    for (let afterId: string | null = null; ; ) {
      const done: Awaited<
        ReturnType<ContentStudioSourceService['backfillPageChanges']>
      > = await sourceService.backfillPageChanges({ afterId });
      if (!done.next) {
        break;
      }
      afterId = done.next;
    }
    const dryRun = (organizationId: string) =>
      retention.computeRetentionDryRun({
        organizationId,
        now: NOW,
        policy: POLICY,
      });
    const before = await dryRun(ORG_A);
    const beforeB = await dryRun(ORG_B);
    // v2..v11 inside the first run, v14..v20 inside the second up to the
    // picker window (v21..v40); v1, v12, v13 the ends and the change
    expect(before.candidates.map((c) => c.versionNumber)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 16, 17, 18, 19, 20,
    ]);
    // the plan is the dry run itself: its candidates held under its hash
    await hold(
      ORG_A,
      before.candidates.slice(0, 3).map((c) => c.id),
      before.dryRunHash
    );
    const refused = await dryRun(ORG_A).catch((e: unknown) => e);
    expect(refused).toEqual(
      new ContentStudioSourceRetentionDryRunError(
        'RETENTION_DRY_RUN_QUARANTINE_ACTIVE'
      )
    );
    // another organization's dry run is not affected
    expect(await dryRun(ORG_B)).toEqual(beforeB);
    // protection (P8-R1A) is not refused, and holding protects nothing
    const map = await retention.computeProtectionMap({
      organizationId: ORG_A,
      now: NOW,
    });
    expect(map.get(before.candidates[0].id)).toBeUndefined();
    await retention.releaseSourceVersionQuarantine({
      organizationId: ORG_A,
      planHash: before.dryRunHash,
    });
    const after = await dryRun(ORG_A);
    expect(after).toEqual(before);
    expect(after.dryRunHash).toBe(before.dryRunHash);
    expect(a.rows).toHaveLength(40);
    expect(b.rows).toHaveLength(30);
  });
});
