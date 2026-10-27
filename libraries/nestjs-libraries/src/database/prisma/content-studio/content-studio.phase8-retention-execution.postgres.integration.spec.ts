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
import { ContentStudioSourceRetentionExecutionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention-execution.repository';
import {
  ContentStudioSourceRetentionExecutionService,
  contentStudioSourceVersionRetentionExecutionExitCode,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention-execution.service';
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
  batchContentStudioSourceVersionRetentionCandidates,
  ContentStudioSourceRetentionIntegrityError,
  ContentStudioSourceVersionRetentionExecutionError,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_QUARANTINE_WAIT_MS,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';
import {
  classifyContentStudioSourceCaptureTransition,
  isContentStudioSourcePageChange,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.change';
import { storedContentStudioSourceContent } from '@gitroom/nestjs-libraries/content-studio/sources/source.version';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import {
  canonicalJson,
  sha256Hex,
} from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import {
  contentStudioPostgresUrlFromEnv,
  createContentStudioPostgresClient,
} from '../../../../../../jest.content-studio.postgres.guard';

// The real MediaService pulls in uploads, Redis and Temporal at import time;
// a draft save and a revision never reach it
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);

// The retention execution (P8-R1C) on a real PostgreSQL: a reviewed dry-run
// plan prepared (its hash made again, its candidates held, ready a minute
// after the last hold), executed (checked again at both times, removed in
// source-aware batches, each with its held rows and items in one
// transaction, every source and the whole organization checked after) and
// cancelled; the writers' one-statement check (W1) against a removal that
// commits between their lookup and their write, and the unsafe order shown
// to leave a dangling reference; forced failures inside a batch, a batch
// failing after others committed, crashes, an unknown commit, a cancel
// during an execution, and a plan never prepared twice. Versions are removed
// only in this test database. Opt-in: runs only through
// jest.content-studio.integration.config.ts against the disposable local
// database. Nothing is fetched

const ORG_A = '30a1c000-0000-4000-8000-00000000000a';
const ORG_B = '30a1c000-0000-4000-8000-00000000000b';
const ORGS = [ORG_A, ORG_B];
const USER: Record<string, string> = Object.fromEntries(
  ORGS.map((org, i) => [org, `30a1c000-0000-4000-8000-0000000000${i + 1}1`])
);
const CONNECTION: Record<string, string> = Object.fromEntries(
  ORGS.map((org, i) => [org, `30a1c000-0000-4000-8000-0000000000${i + 1}2`])
);
const NOW = new Date('2026-10-26T12:00:00.000Z');
const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const DAY = 24 * HOUR;
const LONG_AGO = Date.UTC(2026, 0, 1);
const WAIT = CONTENT_STUDIO_SOURCE_VERSION_RETENTION_QUARANTINE_WAIT_MS;
const VALID_UNTIL = NOW.getTime() + HOUR;
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
let logged: PrismaClient;
const queries: string[] = [];
let prisma: PrismaService;
let transaction: PrismaTransaction;
let sources: ContentStudioSourceRepository;
let sourceService: ContentStudioSourceService;
let grounding: ContentStudioGroundingService;
let packages: ContentStudioRepository;
let packageService: ContentStudioService;
let retention: ContentStudioSourceRetentionService;
let execution: ContentStudioSourceRetentionExecutionService;
let operations: ContentStudioAIOperationRepository;
let writingRepository: ContentStudioWritingProfileRepository;
let editorialRepository: ContentStudioEditorialPolicyRepository;
let audienceRepository: ContentStudioAudienceProfileRepository;
let expertiseRepository: ContentStudioExpertiseProfileRepository;

// A capture by letter: the same letter is the same capture
const IDENTITY: Record<string, string> = {
  A: 'Alpha',
  B: 'Beta',
  C: 'Gamma',
  D: 'Delta',
};

const versionRow = (
  organizationId: string,
  sourceId: string,
  n: number,
  letter: string,
  at = LONG_AGO + n * 60_000
) => ({
  id: randomUUID(),
  organizationId,
  sourceId,
  versionNumber: n,
  extractionVersion: 'content-studio-source-v2',
  requestedUrl: 'https://p8r1c.example/page',
  finalUrl: 'https://p8r1c.example/page',
  redirectCount: 0,
  fetchedAt: new Date(at),
  httpStatus: 200,
  contentType: 'text/html',
  contentLength: 100,
  title: 'P8R1C',
  sourceHash: null,
  createdById: USER[organizationId],
  createdAt: new Date(at),
  ...storedContentStudioSourceContent({
    schemaVersion: 1,
    blocks: [
      { id: 'b1', type: 'paragraph', text: IDENTITY[letter], level: null },
    ],
  }),
});
type Row = ReturnType<typeof versionRow>;

// A page with these captures, numbered from 1 (or as given), made long ago;
// its last page change is set by the real backfill
const insertPage = async (
  organizationId: string,
  letters: string,
  numbers?: number[]
) => {
  const id = randomUUID();
  const ns = numbers ?? [...letters].map((_, i) => i + 1);
  const rows = [...letters].map((letter, i) =>
    versionRow(organizationId, id, ns[i], letter)
  );
  await client.contentStudioSource.create({
    data: {
      id,
      organizationId,
      kind: 'url',
      name: 'P8R1C page',
      canonicalUrl: `https://p8r1c.example/${id}`,
      createdById: USER[organizationId],
      latestVersionNumber: ns[ns.length - 1],
    },
  });
  for (let i = 0; i < rows.length; i += 5000) {
    await client.contentStudioSourceVersion.createMany({
      data: rows.slice(i, i + 5000),
    });
  }
  await backfill();
  return {
    id,
    rows,
    n: (k: number) => rows.find((row) => row.versionNumber === k)!,
  };
};

// The real page-change backfill over every source
const backfill = async () => {
  const total = { updated: 0, unchanged: 0, failed: 0 };
  let afterId: string | null = null;
  do {
    const page: Awaited<
      ReturnType<ContentStudioSourceService['backfillPageChanges']>
    > = await sourceService.backfillPageChanges({ afterId });
    total.updated += page.updated;
    total.unchanged += page.unchanged;
    total.failed += page.failed.length;
    afterId = page.next;
  } while (afterId);
  return total;
};

// A capture of the page as ingestion stores one: the next number after the
// source's latest, its last page change with it when it is one
const capture = async (
  organizationId: string,
  sourceId: string,
  letter: string,
  at: number
) => {
  const source = await client.contentStudioSource.findUniqueOrThrow({
    where: { id: sourceId },
    select: { latestVersionNumber: true },
  });
  const previous = await sources.getVersionByNumber(
    organizationId,
    sourceId,
    source.latestVersionNumber
  );
  const row = versionRow(
    organizationId,
    sourceId,
    source.latestVersionNumber + 1,
    letter,
    at
  );
  const transition = classifyContentStudioSourceCaptureTransition(
    previous,
    row
  );
  const result = await sources.appendVersionWithCompareAndSwap({
    organizationId,
    sourceId,
    expectedLatestVersionNumber: source.latestVersionNumber,
    versionId: row.id,
    version: {
      requestedUrl: row.requestedUrl,
      finalUrl: row.finalUrl,
      redirectCount: row.redirectCount,
      fetchedAt: row.fetchedAt,
      httpStatus: row.httpStatus,
      contentType: row.contentType,
      contentLength: row.contentLength,
      title: row.title,
      sourceHash: null,
      extractionVersion: row.extractionVersion,
      schemaVersion: 1,
      content: row.content,
      contentHash: row.contentHash,
    },
    createdById: USER[organizationId],
    pageChange:
      previous && isContentStudioSourcePageChange(transition)
        ? {
            at: row.fetchedAt,
            versionNumber: row.versionNumber,
            kind: transition,
            previousCaptureAt: previous.fetchedAt,
          }
        : null,
    validators: { mode: 'merge' },
  });
  expect(result.status).toBe('created');
  return row;
};

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
        id: 'c_p8r1c_claim',
        threadItemId: 'main',
        text: 'A claim',
        evidence: list.map(evidence),
      },
    ],
  },
});
const UNGROUNDED = {
  schemaVersion: 1,
  copy: { global: { thread: [{ id: 'main', text: 'Spring', mediaIds: [] }] } },
};
const insertPackage = async (organizationId: string, draft: unknown) =>
  (
    await client.contentPackage.create({
      data: {
        organizationId,
        name: 'P8R1C package',
        draft: JSON.stringify(draft),
        draftVersion: 1,
        createdById: USER[organizationId],
      },
      select: { id: true },
    })
  ).id;
const insertRevision = async (
  organizationId: string,
  packageId: string,
  draft: unknown
) => {
  const content = canonicalJson(parseContentPackageDraft(draft));
  return client.contentPackageRevision.create({
    data: {
      organizationId,
      packageId,
      revisionNumber: 1,
      schemaVersion: 2,
      content,
      contentHash: sha256Hex(content),
      origin: 'manual',
      sourceDraftVersion: 1,
      createdById: USER[organizationId],
    },
    select: { id: true, contentHash: true },
  });
};
const insertOperation = (organizationId: string, versions: Row[]) =>
  client.contentStudioAIOperation.createMany({
    data: {
      id: randomUUID(),
      organizationId,
      userId: USER[organizationId],
      connectionId: CONNECTION[organizationId],
      packageId: null,
      kind: 'generate_item',
      status: 'succeeded',
      provider: 'openai',
      model: 'gpt-test',
      promptVersion: 'cs-item-v1',
      context: {
        v: 1,
        itemId: 'main',
        sources: versions.map((v) => ({
          sourceId: v.sourceId,
          versionId: v.id,
          versionNumber: v.versionNumber,
          contentHash: v.contentHash,
        })),
      } as Prisma.InputJsonValue,
      requestHash: sha256Hex(`request ${randomUUID()}`),
    },
  });

// The reviewed plan: exactly what content-studio:retention-dry-run --json
// prints
const planOf = async (organizationId = ORG_A, now = NOW) =>
  canonicalJson(
    await retention.computeRetentionDryRun({
      organizationId,
      now,
      policy: POLICY,
    })
  );
const candidatesOf = (plan: string) =>
  (JSON.parse(plan).candidates as Array<{ id: string }>).map((c) => c.id);
// the batches a plan is removed in: in canonical order, by source id, so
// which source comes first depends on its random id
const batchesOf = (plan: string) =>
  batchContentStudioSourceVersionRetentionCandidates(
    JSON.parse(plan).candidates as Array<{
      id: string;
      sourceId: string;
      versionNumber: number;
    }>
  );

// The operator's clock: from `start`, `step` later at every read
const clock = (start: number, step = 0) => {
  let time = start - step;
  return () => new Date((time += step));
};

const prepared = async (
  plan: string,
  organizationId = ORG_A,
  service = execution,
  start = NOW.getTime() + SECOND
) => {
  const report = await service.prepare({
    organizationId,
    plan,
    clock: clock(start, 10),
  });
  expect(report.outcome).toBe('prepared');
  return report as typeof report & { executionId: string };
};
const executed = (
  executionId: string,
  at: number,
  service = execution,
  step = 0
) =>
  service.execute({
    executionId,
    clock: clock(at, step),
    hostname: 'p8r1c-test',
  });
const readyOf = (report: { readyAt: string | null }) =>
  new Date(report.readyAt!).getTime();

const refusedWith = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ContentStudioSourceVersionRetentionExecutionError);
  const { code, detail } =
    err as ContentStudioSourceVersionRetentionExecutionError;
  return { code, detail };
};
const httpRefusal = async (promise: Promise<unknown>) => {
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

const state = async (organizationId = ORG_A) => ({
  executions:
    await client.contentStudioSourceVersionRetentionExecution.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    }),
  items: await client.contentStudioSourceVersionRetentionExecutionItem.findMany(
    {
      where: { organizationId },
      orderBy: [{ sourceId: 'asc' }, { versionNumber: 'asc' }],
    }
  ),
  locks: await client.contentStudioSourceVersionRetentionExecutionLock.findMany(
    { where: { organizationId } }
  ),
  pending: await client.contentStudioSourceVersionRetentionPending.findMany({
    where: { organizationId },
  }),
  versions: (
    await client.contentStudioSourceVersion.findMany({
      where: { organizationId },
      select: { id: true },
    })
  ).map((v) => v.id),
});

// Every protection of the organization still resolves (P8-R1A)
const intact = async (organizationId = ORG_A) =>
  retention.computeProtectionMap({ organizationId, now: NOW }).then(
    () => true,
    (err) => {
      if (err instanceof ContentStudioSourceRetentionIntegrityError) {
        return false;
      }
      throw err;
    }
  );

// A transaction whose model calls inside it go through `tap` first (a test
// object, never a production hook): `tap` may wait, throw, or write through
// the same transaction
const tapped = (
  db: PrismaClient,
  tap: (
    model: string,
    method: string,
    tx: Prisma.TransactionClient
  ) => Promise<void> | void
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
                  if (
                    typeof property !== 'string' ||
                    property.startsWith('$')
                  ) {
                    return value;
                  }
                  return new Proxy(value, {
                    get(model, name, modelReceiver) {
                      const original = Reflect.get(model, name, modelReceiver);
                      if (typeof original !== 'function') {
                        return original;
                      }
                      return async (args: unknown) => {
                        await tap(property, String(name), tx);
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

// A transaction that waits for `gate` before it begins
const gated = (db: PrismaClient, gate: () => Promise<void>) =>
  ({
    model: {
      $transaction: async (
        fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: object
      ) => {
        await gate();
        return db.$transaction(fn, options);
      },
    },
  } as unknown as PrismaTransaction);

const latch = () => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

const executionRepository = (tx: PrismaTransaction = transaction) =>
  new ContentStudioSourceRetentionExecutionRepository(
    new PrismaRepository<'contentStudioSourceVersionRetentionExecution'>(
      prisma
    ),
    new PrismaRepository<'contentStudioSourceVersionRetentionExecutionItem'>(
      prisma
    ),
    new PrismaRepository<'contentStudioSourceVersionRetentionExecutionLock'>(
      prisma
    ),
    new PrismaRepository<'contentStudioSourceVersionRetentionPending'>(prisma),
    new PrismaRepository<'contentStudioSourceVersion'>(prisma),
    tx
  );
const executionWith = (
  options: {
    tx?: PrismaTransaction;
    retention?: ContentStudioSourceRetentionService;
  } = {}
) =>
  new ContentStudioSourceRetentionExecutionService(
    executionRepository(options.tx),
    options.retention ?? retention
  );
// The real retention service with some of its methods replaced
const retentionWith = (
  methods: Partial<
    Record<
      keyof ContentStudioSourceRetentionService,
      (...args: never[]) => Promise<unknown>
    >
  >
) =>
  Object.assign(
    Object.create(retention),
    methods
  ) as ContentStudioSourceRetentionService;

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
const packagesWith = (tx: PrismaTransaction, db: PrismaService = prisma) =>
  new ContentStudioRepository(
    new PrismaRepository<'contentStudioProject'>(db),
    new PrismaRepository<'contentPackage'>(db),
    new PrismaRepository<'contentPackageRevision'>(db),
    tx
  );

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
        providerRequestId: 'req_p8r1c',
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
const propose = (
  resolver: unknown,
  packageId: string,
  sourceId: string,
  operationRepository = operations
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
  ).proposeItem({
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

const clean = async () => {
  const where = { organizationId: { in: ORGS } };
  await client.contentStudioSourceVersionRetentionExecutionLock.deleteMany({
    where,
  });
  await client.contentStudioSourceVersionRetentionExecutionItem.deleteMany({
    where,
  });
  await client.contentStudioSourceVersionRetentionExecution.deleteMany({
    where,
  });
  await client.contentStudioSourceVersionRetentionPending.deleteMany({ where });
  await client.contentStudioAIUsage.deleteMany({ where });
  await client.contentStudioAIOperation.deleteMany({ where });
  await client.contentStudioReview.deleteMany({ where });
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
  // the same database, with every statement it is sent
  const logging = new PrismaClient({
    datasources: { db: { url: contentStudioPostgresUrlFromEnv() } },
    log: [{ emit: 'event', level: 'query' }],
  });
  logging.$on('query', (event) => queries.push(event.query));
  logged = logging;
  await client.$connect();
  await other.$connect();
  await logged.$connect();
  prisma = client as unknown as PrismaService;
  transaction = new PrismaTransaction(prisma);
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
  grounding = new ContentStudioGroundingService(sources);
  packages = packagesWith(transaction);
  packageService = packageServiceWith(packages);
  retention = new ContentStudioSourceRetentionService(
    new ContentStudioSourceRetentionRepository(
      new PrismaRepository<'contentStudioSourceVersion'>(prisma),
      new PrismaRepository<'contentStudioSourceVersionRetentionPending'>(
        prisma
      ),
      transaction
    )
  );
  execution = executionWith();
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
      data: { id: org, name: `P8R1C ${org}` },
    });
    await client.user.create({
      data: {
        id: USER[org],
        email: `${USER[org]}@p8r1c.invalid`,
        providerName: 'LOCAL',
        timezone: 0,
        name: `P8R1C ${org}`,
      },
    });
    await client.userOrganization.create({
      data: { userId: USER[org], organizationId: org, role: 'USER' },
    });
    await client.contentStudioAIConnection.create({
      data: {
        id: CONNECTION[org],
        organizationId: org,
        name: 'P8R1C',
        provider: 'openai',
        credentialUpdatedAt: new Date(),
        createdById: USER[org],
      },
    });
  }
});

beforeEach(async () => {
  await clean();
  queries.length = 0;
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
  await logged?.$disconnect();
});

// 5 captures of A then 20 of B: v2, v3 and v4 are the candidates (v6 to v25
// are the picker window; v1 and v5 the ends of A's run)
const SMALL = 'AAAAA' + 'B'.repeat(20);

describe('P8-R1C prepare on PostgreSQL', () => {
  it('PGX-P1/P5/P6 a reviewed plan is prepared: recorded, its items planned, its candidates held, ready a minute after the last hold; nothing removed', async () => {
    const page = await insertPage(ORG_A, SMALL);
    const plan = await planOf();
    expect(candidatesOf(plan)).toEqual([2, 3, 4].map((k) => page.n(k).id));
    const before = await state();
    const report = await prepared(plan);
    const after = await state();
    expect(report).toEqual(
      expect.objectContaining({
        outcome: 'prepared',
        organizationId: ORG_A,
        planHash: JSON.parse(plan).dryRunHash,
        status: 'prepared',
        plannedCount: 3,
        sourceCount: 1,
        deletedCount: 0,
        batchCount: 0,
        errorCode: null,
        integrityCheck: null,
        planEvaluationNow: NOW.toISOString(),
        validUntil: new Date(VALID_UNTIL).toISOString(),
        backupConfirmedAt: null,
        executionStartedAt: null,
        finishedAt: null,
      })
    );
    expect(after.versions.sort()).toEqual(before.versions.sort());
    expect(after.locks).toEqual([
      expect.objectContaining({ executionId: report.executionId }),
    ]);
    expect(
      after.items.map((item) => [item.sourceVersionId, item.status])
    ).toEqual([2, 3, 4].map((k) => [page.n(k).id, 'planned']));
    expect(after.items.every((item) => item.batchNumber === null)).toBe(true);
    expect(after.pending.map((row) => row.sourceVersionId).sort()).toEqual(
      candidatesOf(plan).sort()
    );
    expect(
      after.pending.every((row) => row.planHash === JSON.parse(plan).dryRunHash)
    ).toBe(true);
    const last = Math.max(
      ...after.pending.map((row) => row.pendingAt.getTime())
    );
    expect(readyOf(report)).toBe(last + WAIT);
    expect(after.executions[0]).toEqual(
      expect.objectContaining({
        policyMode: 'compact_repeats',
        policyOlderThan: POLICY.olderThan,
        dryRunFormatVersion: 1,
        protectionVersion: 1,
        policyVersion: 1,
        executionFormatVersion: 1,
        hostname: null,
      })
    );
    // the dry run is refused while the plan holds its versions
    await expect(planOf()).rejects.toThrow(
      'RETENTION_DRY_RUN_QUARANTINE_ACTIVE'
    );
  });

  it('PGX-P6/P7 more than 500 candidates are held in calls of 500, each at its own time: ready a minute after the LAST, never the first', async () => {
    // 600 captures of A, then 20 of B: 598 candidates
    const page = await insertPage(ORG_A, 'A'.repeat(600) + 'B'.repeat(20));
    const plan = await planOf();
    expect(candidatesOf(plan)).toHaveLength(598);
    const calls: number[] = [];
    const counting = retentionWith({
      quarantineSourceVersions: async (input: never) => {
        calls.push(
          (input as { sourceVersionIds: string[] }).sourceVersionIds.length
        );
        return retention.quarantineSourceVersions(input);
      },
    });
    const report = await prepared(
      plan,
      ORG_A,
      executionWith({ retention: counting })
    );
    expect(calls).toEqual([500, 98]);
    const { pending } = await state();
    const times = [...new Set(pending.map((row) => row.pendingAt.getTime()))];
    expect(times).toHaveLength(2);
    expect(readyOf(report)).toBe(Math.max(...times) + WAIT);
    expect(readyOf(report)).toBeGreaterThan(Math.min(...times) + WAIT);
    expect(pending).toHaveLength(598);
    expect(page.rows).toHaveLength(620);
  });

  it('PGX-P2/P3 the organization changed since the dry run: HASH_MISMATCH, nothing held, aborted and unlocked', async () => {
    const page = await insertPage(ORG_A, SMALL);
    const plan = await planOf();
    // a draft names a candidate after the dry run
    await insertPackage(ORG_A, grounded(page.n(3)));
    const report = await execution.prepare({
      organizationId: ORG_A,
      plan,
      clock: clock(NOW.getTime() + SECOND),
    });
    expect(report).toEqual(
      expect.objectContaining({
        outcome: 'aborted',
        status: 'aborted',
        errorCode: 'RETENTION_EXECUTION_HASH_MISMATCH',
        deletedCount: 0,
      })
    );
    expect(
      contentStudioSourceVersionRetentionExecutionExitCode(report.outcome)
    ).toBe(1);
    const after = await state();
    expect(after.pending).toEqual([]);
    expect(after.locks).toEqual([]);
    expect(after.versions).toHaveLength(25);
    expect(after.executions[0].finishedAt).not.toBeNull();
    // the plan is never prepared again
    expect(
      (
        await refusedWith(
          execution.prepare({
            organizationId: ORG_A,
            plan,
            clock: clock(NOW.getTime() + SECOND),
          })
        )
      ).code
    ).toBe('RETENTION_EXECUTION_ALREADY_RUN');
  });

  it('PGX-P2b an edited plan fails its own hash before anything is read or written', async () => {
    const page = await insertPage(ORG_A, SMALL);
    const plan = JSON.parse(await planOf());
    plan.candidates = plan.candidates.filter(
      (c: { id: string }) => c.id !== page.n(3).id
    );
    expect(
      (
        await refusedWith(
          execution.prepare({
            organizationId: ORG_A,
            plan: canonicalJson(plan),
            clock: clock(NOW.getTime() + SECOND),
          })
        )
      ).code
    ).toBe('RETENTION_EXECUTION_PLAN_INVALID');
    // a display field may change: it is not decided on
    const shown = JSON.parse(await planOf());
    shown.candidateSummary.logicalContentBytes = 1;
    shown.candidates[0].createdAt = '2000-01-01T00:00:00.000Z';
    expect(
      (
        await execution.prepare({
          organizationId: ORG_A,
          plan: JSON.stringify(shown),
          clock: clock(NOW.getTime() + SECOND),
        })
      ).outcome
    ).toBe('prepared');
  });

  it('PGX-P4 too close to the end of the plan: PLAN_EXPIRED before anything is written; ready after the end: released and aborted', async () => {
    await insertPage(ORG_A, SMALL);
    const plan = await planOf();
    for (const at of [VALID_UNTIL - WAIT, VALID_UNTIL, VALID_UNTIL + 1]) {
      expect(
        (
          await refusedWith(
            execution.prepare({ organizationId: ORG_A, plan, clock: clock(at) })
          )
        ).code
      ).toBe('RETENTION_EXECUTION_PLAN_EXPIRED');
    }
    expect((await state()).executions).toEqual([]);
    // the preflight passes, the hold is later: ready at or after the end
    const report = await execution.prepare({
      organizationId: ORG_A,
      plan,
      clock: clock(VALID_UNTIL - WAIT - 1, 100),
    });
    expect(report).toEqual(
      expect.objectContaining({
        outcome: 'aborted',
        errorCode: 'RETENTION_EXECUTION_PLAN_EXPIRED',
      })
    );
    const after = await state();
    expect(after.pending).toEqual([]);
    expect(after.locks).toEqual([]);
  });

  it('PGX-P8 a hold that fails after another was made: everything released, QUARANTINE_FAILED, aborted and unlocked', async () => {
    await insertPage(ORG_A, 'A'.repeat(600) + 'B'.repeat(20));
    const plan = await planOf();
    let calls = 0;
    const failing = retentionWith({
      quarantineSourceVersions: async (input: never) => {
        if (++calls === 2) {
          throw new Error('hold failed');
        }
        return retention.quarantineSourceVersions(input);
      },
    });
    const report = await executionWith({ retention: failing }).prepare({
      organizationId: ORG_A,
      plan,
      clock: clock(NOW.getTime() + SECOND, 10),
    });
    expect(report).toEqual(
      expect.objectContaining({
        outcome: 'aborted',
        status: 'aborted',
        errorCode: 'RETENTION_EXECUTION_QUARANTINE_FAILED',
      })
    );
    const after = await state();
    expect(after.pending).toEqual([]);
    expect(after.locks).toEqual([]);
    expect(after.versions).toHaveLength(620);
  });

  it('PGX-P9 when releasing fails too: CLEANUP_REQUIRED, the execution stays preparing and locked, held rows stay; cancel then recovers', async () => {
    await insertPage(ORG_A, 'A'.repeat(600) + 'B'.repeat(20));
    const plan = await planOf();
    let calls = 0;
    const failing = retentionWith({
      quarantineSourceVersions: async (input: never) => {
        if (++calls === 2) {
          throw new Error('hold failed');
        }
        return retention.quarantineSourceVersions(input);
      },
      releaseSourceVersionQuarantine: async () => {
        throw new Error('release failed');
      },
    });
    const report = await executionWith({ retention: failing }).prepare({
      organizationId: ORG_A,
      plan,
      clock: clock(NOW.getTime() + SECOND, 10),
    });
    expect(report).toEqual(
      expect.objectContaining({
        outcome: 'cleanup_required',
        status: 'preparing',
        errorCode: 'RETENTION_EXECUTION_CLEANUP_REQUIRED',
        detail: 'RETENTION_EXECUTION_QUARANTINE_FAILED',
      })
    );
    expect(
      contentStudioSourceVersionRetentionExecutionExitCode(report.outcome)
    ).toBe(2);
    let after = await state();
    expect(after.locks).toHaveLength(1);
    expect(after.pending).toHaveLength(500);
    const cancelled = await execution.cancel({
      executionId: report.executionId!,
      clock: clock(NOW.getTime() + 2 * SECOND),
    });
    expect(cancelled).toEqual(
      expect.objectContaining({
        outcome: 'cancelled',
        previousStatus: 'preparing',
        status: 'cancelled',
        releasedCount: 500,
        deletedCount: 0,
      })
    );
    after = await state();
    expect(after.locks).toEqual([]);
    expect(after.pending).toEqual([]);
    expect(after.versions).toHaveLength(620);
  });

  it('PGX-P10 two plans of one organization prepared at once on two connections: exactly one is prepared, the other ALREADY_ACTIVE', async () => {
    await insertPage(ORG_A, SMALL);
    const first = await planOf(ORG_A, NOW);
    const second = await planOf(ORG_A, new Date(NOW.getTime() + SECOND));
    expect(JSON.parse(first).dryRunHash).not.toBe(
      JSON.parse(second).dryRunHash
    );
    const onOther = new ContentStudioSourceRetentionExecutionService(
      new ContentStudioSourceRetentionExecutionRepository(
        ...([0, 0, 0, 0, 0].map(
          () => new PrismaRepository(other as unknown as PrismaService)
        ) as [never, never, never, never, never]),
        new PrismaTransaction(other as unknown as PrismaService)
      ),
      retention
    );
    const results = await Promise.allSettled([
      execution.prepare({
        organizationId: ORG_A,
        plan: first,
        clock: clock(NOW.getTime() + 2 * SECOND, 10),
      }),
      onOther.prepare({
        organizationId: ORG_A,
        plan: second,
        clock: clock(NOW.getTime() + 2 * SECOND, 10),
      }),
    ]);
    const done = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(done).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(
      (
        (lost[0] as PromiseRejectedResult)
          .reason as ContentStudioSourceVersionRetentionExecutionError
      ).code
    ).toBe('RETENTION_EXECUTION_ALREADY_ACTIVE');
    const after = await state();
    expect(after.executions).toHaveLength(1);
    expect(after.locks).toHaveLength(1);
  });

  it('PGX-P11/P12 the same plan again is ALREADY_RUN; another plan while one is active is ALREADY_ACTIVE, naming it', async () => {
    await insertPage(ORG_A, SMALL);
    const plan = await planOf();
    const report = await prepared(plan);
    expect(
      (
        await refusedWith(
          execution.prepare({
            organizationId: ORG_A,
            plan,
            clock: clock(NOW.getTime() + 2 * SECOND),
          })
        )
      ).code
    ).toBe('RETENTION_EXECUTION_ALREADY_RUN');
    // a plan made with nothing held would differ: here, its record only
    const another = JSON.parse(plan);
    another.evaluationNow = new Date(NOW.getTime() + SECOND).toISOString();
    another.validUntil = new Date(VALID_UNTIL + SECOND).toISOString();
    another.dryRunHash = (
      await import(
        '@gitroom/nestjs-libraries/content-studio/sources/source.retention'
      )
    ).contentStudioSourceVersionRetentionDryRunHash({
      organizationId: ORG_A,
      evaluationNow: new Date(another.evaluationNow),
      validUntil: new Date(another.validUntil),
      policy: { mode: 'compact_repeats', olderThan: POLICY.olderThan },
      candidates: another.candidates,
      blockedSources: [],
    });
    expect(
      await refusedWith(
        execution.prepare({
          organizationId: ORG_A,
          plan: JSON.stringify(another),
          clock: clock(NOW.getTime() + 2 * SECOND),
        })
      )
    ).toEqual({
      code: 'RETENTION_EXECUTION_ALREADY_ACTIVE',
      detail: `execution ${report.executionId}`,
    });
    expect((await state()).executions).toHaveLength(1);
  });

  it('PGX-E6 a plan with no candidates is NOTHING_TO_DELETE: no execution, lock, item or held row', async () => {
    await insertPage(ORG_A, 'B'.repeat(20));
    const report = await execution.prepare({
      organizationId: ORG_A,
      plan: await planOf(),
      clock: clock(NOW.getTime() + SECOND),
    });
    expect(report.outcome).toBe('nothing_to_delete');
    expect(
      contentStudioSourceVersionRetentionExecutionExitCode(report.outcome)
    ).toBe(0);
    const after = await state();
    expect([after.executions, after.items, after.locks, after.pending]).toEqual(
      [[], [], [], []]
    );
  });
});

describe('P8-R1C execute on PostgreSQL', () => {
  it('PGX-X1/X2 before readyAt: NOT_READY, nothing changes; at readyAt exactly: executed, completed and unlocked', async () => {
    const page = await insertPage(ORG_A, SMALL);
    const report = await prepared(await planOf());
    const ready = readyOf(report);
    const early = await executed(report.executionId, ready - 1);
    expect(early).toEqual(
      expect.objectContaining({
        outcome: 'not_ready',
        status: 'prepared',
        errorCode: 'RETENTION_EXECUTION_NOT_READY',
      })
    );
    expect(
      contentStudioSourceVersionRetentionExecutionExitCode(early.outcome)
    ).toBe(1);
    expect((await state()).pending).toHaveLength(3);
    const done = await executed(report.executionId, ready);
    expect(done).toEqual(
      expect.objectContaining({
        outcome: 'completed',
        status: 'completed',
        deletedCount: 3,
        batchCount: 1,
        errorCode: null,
        integrityCheck: 'passed',
        backupConfirmedAt: new Date(ready).toISOString(),
        executionStartedAt: new Date(ready).toISOString(),
      })
    );
    expect(
      contentStudioSourceVersionRetentionExecutionExitCode(done.outcome)
    ).toBe(0);
    const after = await state();
    expect(after.locks).toEqual([]);
    expect(after.pending).toEqual([]);
    expect(after.versions.sort()).toEqual(
      page.rows
        .filter((row) => ![2, 3, 4].includes(row.versionNumber))
        .map((row) => row.id)
        .sort()
    );
    expect(after.executions[0].hostname).toBe('p8r1c-test');
    // again: it ran
    expect((await refusedWith(executed(report.executionId, ready))).code).toBe(
      'RETENTION_EXECUTION_ALREADY_RUN'
    );
  });

  it('PGX-X3/X4 at validUntil exactly, or after: released, aborted, nothing removed', async () => {
    for (const at of [VALID_UNTIL, VALID_UNTIL + 5 * SECOND]) {
      await clean();
      await insertPage(ORG_A, SMALL);
      const report = await prepared(await planOf());
      const late = await executed(report.executionId, at);
      expect(late).toEqual(
        expect.objectContaining({
          outcome: 'aborted',
          status: 'aborted',
          errorCode: 'RETENTION_EXECUTION_PLAN_EXPIRED',
          deletedCount: 0,
        })
      );
      const after = await state();
      expect(after.pending).toEqual([]);
      expect(after.locks).toEqual([]);
      expect(after.versions).toHaveLength(25);
    }
  });

  const gained: Array<
    [string, (page: Awaited<ReturnType<typeof insertPage>>) => Promise<unknown>]
  > = [
    ['X6 DRAFT_EVIDENCE', (page) => insertPackage(ORG_A, grounded(page.n(3)))],
    [
      'X7 REVISION_EVIDENCE',
      async (page) =>
        insertRevision(
          ORG_A,
          await insertPackage(ORG_A, UNGROUNDED),
          grounded(page.n(3))
        ),
    ],
    ['X8 AI_OPERATION', (page) => insertOperation(ORG_A, [page.n(3)])],
  ];
  for (const [name, gain] of gained) {
    it(`PGX-${name} gained during the wait (a writer that checked before the hold): the whole plan is aborted, nothing removed`, async () => {
      const page = await insertPage(ORG_A, SMALL);
      const report = await prepared(await planOf());
      await gain(page);
      const result = await executed(report.executionId, readyOf(report));
      expect(result).toEqual(
        expect.objectContaining({
          outcome: 'aborted',
          status: 'aborted',
          errorCode: 'RETENTION_EXECUTION_RECHECK_FAILED',
          detail: 'CANDIDATE_NOT_ELIGIBLE',
          deletedCount: 0,
          batchCount: 0,
        })
      );
      const after = await state();
      expect(after.versions).toHaveLength(25);
      expect(after.pending).toEqual([]);
      expect(after.locks).toEqual([]);
      expect(after.items.every((item) => item.status === 'planned')).toBe(true);
    });
  }

  it('PGX-X9/X10/X11/X12 a candidate gone, an item that is not the version, a held row missing or foreign, a corrupt source: aborted, nothing removed', async () => {
    const cases: Array<
      [
        string,
        (
          page: Awaited<ReturnType<typeof insertPage>>,
          executionId: string
        ) => Promise<unknown>,
        string
      ]
    > = [
      [
        'gone',
        async (page) => {
          await client.contentStudioSourceVersionRetentionPending.deleteMany({
            where: { sourceVersionId: page.n(3).id },
          });
          await client.contentStudioSourceVersion.delete({
            where: { id: page.n(3).id },
          });
        },
        'PENDING_MISMATCH',
      ],
      [
        'identity',
        (page, executionId) =>
          client.contentStudioSourceVersionRetentionExecutionItem.updateMany({
            where: { executionId, sourceVersionId: page.n(3).id },
            data: { contentHash: 'f'.repeat(64) },
          }),
        'CANDIDATE_CHANGED',
      ],
      [
        'unheld',
        (page) =>
          client.contentStudioSourceVersionRetentionPending.deleteMany({
            where: { sourceVersionId: page.n(2).id },
          }),
        'PENDING_MISMATCH',
      ],
      [
        'foreign',
        (page) =>
          client.contentStudioSourceVersionRetentionPending.create({
            data: {
              organizationId: ORG_A,
              sourceVersionId: page.n(10).id,
              planHash: 'e'.repeat(64),
            },
          }),
        'PENDING_MISMATCH',
      ],
      [
        'corrupt',
        (page) =>
          client.contentStudioSource.update({
            where: { id: page.id },
            data: { lastPageChangeAt: new Date(LONG_AGO) },
          }),
        'RETENTION_INTEGRITY_ERROR ContentStudioSource',
      ],
    ];
    for (const [name, change, detail] of cases) {
      await clean();
      const page = await insertPage(ORG_A, SMALL);
      const report = await prepared(await planOf());
      await change(page, report.executionId);
      const result = await executed(report.executionId, readyOf(report));
      expect([
        name,
        result.outcome,
        result.errorCode,
        result.deletedCount,
      ]).toEqual([name, 'aborted', 'RETENTION_EXECUTION_RECHECK_FAILED', 0]);
      expect([name, result.detail?.startsWith(detail)]).toEqual([name, true]);
      const after = await state();
      expect([
        name,
        after.locks,
        after.pending.filter((row) => row.planHash === report.planHash),
      ]).toEqual([name, [], []]);
      // the rows this test added aside, no version was removed by the execution
      expect(after.versions.length).toBe(name === 'gone' ? 24 : 25);
    }
  });

  it('PGX-X12 a source whose stored page change went stale since (an older change stored): it is blocked, the plan aborted', async () => {
    // changes at v6 (A to B) and v16 (B to C); the candidates are v2..v4
    const page = await insertPage(
      ORG_A,
      'AAAAA' + 'B'.repeat(10) + 'C'.repeat(10)
    );
    const report = await prepared(await planOf());
    expect(report.plannedCount).toBe(3);
    // the change before the last, stored as if it were the last
    await client.contentStudioSource.update({
      where: { id: page.id },
      data: {
        lastPageChangeAt: page.n(6).fetchedAt,
        lastPageChangeVersionNumber: 6,
        lastPageChangeKind: 'content_changed',
        lastPageChangePreviousCaptureAt: page.n(5).fetchedAt,
      },
    });
    expect(await intact()).toBe(true);
    const result = await executed(report.executionId, readyOf(report));
    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'aborted',
        errorCode: 'RETENTION_EXECUTION_RECHECK_FAILED',
        detail: 'CANDIDATE_NOT_ELIGIBLE',
        deletedCount: 0,
      })
    );
    expect((await state()).versions).toHaveLength(25);
  });

  it('PGX-X13/X14 captures between prepare and execute, a repeat and a change: the plan still runs, and removes only its own candidates', async () => {
    const page = await insertPage(ORG_A, SMALL);
    const report = await prepared(await planOf());
    // a repeat of B (v25, the last, is now an interior), then a change
    const repeat = await capture(
      ORG_A,
      page.id,
      'B',
      NOW.getTime() + 2 * SECOND
    );
    const change = await capture(
      ORG_A,
      page.id,
      'C',
      NOW.getTime() + 3 * SECOND
    );
    const result = await executed(report.executionId, readyOf(report));
    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'completed',
        deletedCount: 3,
        integrityCheck: 'passed',
      })
    );
    const after = await state();
    expect(after.versions.sort()).toEqual(
      [
        ...page.rows.filter((row) => ![2, 3, 4].includes(row.versionNumber)),
        repeat,
        change,
      ]
        .map((row) => row.id)
        .sort()
    );
    const source = await client.contentStudioSource.findUniqueOrThrow({
      where: { id: page.id },
    });
    expect(source.latestVersionNumber).toBe(27);
    expect(source.lastPageChangeVersionNumber).toBe(27);
    // the stored change is what the versions show: the backfill would write nothing
    expect((await backfill()).updated).toBe(0);
    expect(await intact()).toBe(true);
  });

  it('PGX-X15 two executes at once: one runs, the other is ALREADY_ACTIVE', async () => {
    await insertPage(ORG_A, SMALL);
    const report = await prepared(await planOf());
    const results = await Promise.allSettled([
      executed(report.executionId, readyOf(report)),
      executed(report.executionId, readyOf(report)),
    ]);
    const done = results.filter((r) => r.status === 'fulfilled');
    expect(done).toHaveLength(1);
    expect(
      (done[0] as PromiseFulfilledResult<{ outcome: string }>).value.outcome
    ).toBe('completed');
    expect(
      (
        (results.find((r) => r.status === 'rejected') as PromiseRejectedResult)
          .reason as ContentStudioSourceVersionRetentionExecutionError
      ).code
    ).toBe('RETENTION_EXECUTION_ALREADY_ACTIVE');
  });
});

describe('P8-R1C what the removal leaves, on PostgreSQL', () => {
  it('PGX-D1..D14 batches by source, gaps kept, history readable, What changed unchanged, the backfill unchanged, the latest kept, the next capture after it', async () => {
    // one candidate; a run of 101 candidates (two batches of its own); two
    // small sources packed together
    const one = await insertPage(ORG_A, 'AAA' + 'B'.repeat(20));
    const big = await insertPage(ORG_A, 'A'.repeat(103) + 'C'.repeat(20));
    const small1 = await insertPage(ORG_A, 'AAAA' + 'D'.repeat(20));
    const small2 = await insertPage(ORG_A, 'AAAAA' + 'B'.repeat(20));
    const plan = await planOf();
    expect(candidatesOf(plan)).toHaveLength(1 + 101 + 2 + 3);
    // What changed of every version kept, before
    const changesOf = async (page: typeof one) => {
      const out: Record<string, unknown> = {};
      for (const row of page.rows) {
        if (candidatesOf(plan).includes(row.id)) continue;
        out[row.id] = await sourceService.getVersionChanges({
          organizationId: ORG_A,
          sourceId: page.id,
          versionId: row.id,
        });
      }
      return out;
    };
    const before = await Promise.all([one, big, small1, small2].map(changesOf));
    const report = await prepared(plan);
    const result = await executed(report.executionId, readyOf(report));
    // 1 + 101 + 2 + 3: 3 batches with the big source first or last, 4 when
    // it comes between small ones
    expect([3, 4]).toContain(batchesOf(plan).length);
    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'completed',
        deletedCount: 107,
        batchCount: batchesOf(plan).length,
        integrityCheck: 'passed',
      })
    );
    const after = await state();
    // D13/D14: nothing held, every item deleted with its batch and time
    expect(after.pending).toEqual([]);
    expect(after.items).toHaveLength(107);
    expect(
      after.items.every((item) => item.status === 'deleted' && item.deletedAt)
    ).toBe(true);
    // canonical order: by source id, then number; a source of more than
    // 100 fills batches of its own; small sources are packed together
    const batchOf = (page: typeof one) => [
      ...new Set(
        after.items
          .filter((item) => item.sourceId === page.id)
          .map((item) => item.batchNumber)
      ),
    ];
    const order = [one, big, small1, small2].sort((a, b) =>
      a.id < b.id ? -1 : 1
    );
    const bigBatches = batchOf(big);
    expect(bigBatches).toHaveLength(2);
    expect(bigBatches[1]).toBe(bigBatches[0]! + 1);
    expect(
      after.items.filter((item) => item.batchNumber === bigBatches[0]).length
    ).toBe(100);
    for (const batch of bigBatches) {
      expect(
        new Set(
          after.items
            .filter((item) => item.batchNumber === batch)
            .map((item) => item.sourceId)
        )
      ).toEqual(new Set([big.id]));
    }
    for (const page of order.filter((p) => p !== big)) {
      expect(batchOf(page)).toHaveLength(1);
    }
    // D5/D6: the gaps stay; the history lists and counts what is there
    const kept = await client.contentStudioSourceVersion.findMany({
      where: { sourceId: big.id },
      orderBy: { versionNumber: 'asc' },
      select: { versionNumber: true },
    });
    expect(kept.map((v) => v.versionNumber)).toEqual([
      1,
      ...Array.from({ length: 21 }, (_, i) => 103 + i),
    ]);
    const list = await sourceService.listVersions({
      organizationId: ORG_A,
      sourceId: big.id,
      page: 1,
    });
    expect(list.pages).toBe(2);
    expect(list.results).toHaveLength(20);
    // D7: a removed version is not found, like any other
    expect(
      (
        await httpRefusal(
          sourceService.getVersion({
            organizationId: ORG_A,
            sourceId: big.id,
            versionId: big.n(50).id,
          })
        )
      ).body
    ).toEqual(expect.objectContaining({ code: 'CS_NOT_FOUND' }));
    // D8: What changed of every version kept is exactly as before
    expect(
      await Promise.all([one, big, small1, small2].map(changesOf))
    ).toEqual(before);
    // D9: the backfill would write nothing; D10: every protection resolves
    expect((await backfill()).updated).toBe(0);
    expect(await intact()).toBe(true);
    // D11: no latest version removed
    for (const page of [one, big, small1, small2]) {
      const source = await client.contentStudioSource.findUniqueOrThrow({
        where: { id: page.id },
      });
      expect(after.versions).toContain(page.n(source.latestVersionNumber).id);
    }
    // D12: the next capture is the latest + 1, never the count + 1
    const next = await capture(ORG_A, big.id, 'C', NOW.getTime() + 2 * HOUR);
    expect(next.versionNumber).toBe(124);
    expect(
      await client.contentStudioSourceVersion.count({
        where: { sourceId: big.id },
      })
    ).toBe(23);
  });

  it('PGX-119 a rich organization: drafts, revisions, reviews, AI operations and page changes all still resolve; only free interiors are removed', async () => {
    const page = await insertPage(
      ORG_A,
      'A'.repeat(12) + 'B'.repeat(6) + 'C'.repeat(20)
    );
    // v3 in a draft, v5 in a revision and its review, v7 in an AI operation,
    // v14 in a draft of another package
    const draftPackage = await insertPackage(ORG_A, grounded(page.n(3)));
    const revisionPackage = await insertPackage(ORG_A, grounded(page.n(5)));
    const revision = await insertRevision(
      ORG_A,
      revisionPackage,
      grounded(page.n(5))
    );
    await client.contentStudioReview.create({
      data: {
        organizationId: ORG_A,
        packageRevisionId: revision.id,
        targetContentHash: revision.contentHash,
        state: 'APPROVED',
        requestedById: USER[ORG_A],
      },
    });
    await insertOperation(ORG_A, [page.n(7)]);
    await insertPackage(ORG_A, grounded(page.n(14)));
    const plan = await planOf();
    const protectedIds: string[] = [3, 5, 7, 14].map((k) => page.n(k).id);
    expect(
      candidatesOf(plan).filter((id) => protectedIds.includes(id))
    ).toEqual([]);
    expect(candidatesOf(plan)).toHaveLength(10 - 3 + 4 - 1);
    const report = await prepared(plan);
    expect((await executed(report.executionId, readyOf(report))).outcome).toBe(
      'completed'
    );
    const after = await state();
    for (const id of protectedIds) {
      expect(after.versions).toContain(id);
    }
    expect(await intact()).toBe(true);
    // the draft saves and the revision is made as before
    expect(
      await packageService.saveDraft({
        organizationId: ORG_A,
        packageId: draftPackage,
        baseDraftVersion: 1,
        draft: grounded(page.n(3), page.n(12)),
      })
    ).toEqual({ draftVersion: 2 });
  });
});

describe('P8-R1C W1: the writers against a removal, on PostgreSQL', () => {
  // A page whose v3 is a candidate, prepared and executed while the writer
  // waits between its lookup and its transaction
  const removedWhileWaiting = async (
    start: (tx: PrismaTransaction) => Promise<unknown>
  ) => {
    const page = await insertPage(ORG_A, SMALL);
    const plan = await planOf();
    const atGate = latch();
    const go = latch();
    const tx = gated(client, async () => {
      atGate.open();
      await go.opened;
    });
    const writing = start(tx).then(
      (value) => ({ value }),
      (err: unknown) => ({ err })
    );
    // wait for the writer to have looked its version up
    await atGate.opened;
    const report = await prepared(plan);
    const done = await executed(report.executionId, readyOf(report));
    expect(done.outcome).toBe('completed');
    expect((await state()).versions).not.toContain(page.n(3).id);
    go.open();
    return { page, outcome: await writing };
  };

  it('PGX-W1-A a draft save that looked v3 up before it was removed is refused in its transaction: the 409, nothing written, nothing dangling', async () => {
    let packageId = '';
    const { outcome } = await removedWhileWaiting(async (tx) => {
      packageId = await insertPackage(ORG_A, UNGROUNDED);
      const page = await client.contentStudioSourceVersion.findFirstOrThrow({
        where: { organizationId: ORG_A, versionNumber: 3 },
      });
      return packageServiceWith(packagesWith(tx)).saveDraft({
        organizationId: ORG_A,
        packageId,
        baseDraftVersion: 1,
        draft: grounded(page as unknown as Row),
      });
    });
    expect('err' in outcome).toBe(true);
    const err = (outcome as { err: HttpException }).err;
    expect({ status: err.getStatus(), body: err.getResponse() }).toEqual(HELD);
    const row = await client.contentPackage.findUniqueOrThrow({
      where: { id: packageId },
    });
    expect(row.draftVersion).toBe(1);
    expect(await intact()).toBe(true);
  });

  it('PGX-W1-B a revision whose draft names v3 is refused the same way when v3 is removed before its transaction', async () => {
    // the draft names v3 before the plan, so v3 is protected: no candidate.
    // The revision's own check is what is shown: its draft is written by
    // this test after the removal, as a draft saved before W1 could have been
    const page = await insertPage(ORG_A, SMALL);
    const plan = await planOf();
    const report = await prepared(plan);
    expect((await executed(report.executionId, readyOf(report))).outcome).toBe(
      'completed'
    );
    const packageId = await insertPackage(ORG_A, grounded(page.n(3)));
    const revisions = packagesWith(transaction);
    const created = await revisions
      .createRevisionWithCompareAndSwap({
        organizationId: ORG_A,
        packageId,
        expectedDraftVersion: 1,
        expectedLatestRevisionNumber: 0,
        schemaVersion: 2,
        content: '{}',
        contentHash: sha256Hex('{}'),
        origin: 'manual',
        createdById: USER[ORG_A],
        sourceVersionIds: [page.n(3).id],
      })
      .then(
        () => 'created',
        (err: Error) => err.name
      );
    expect(created).toBe('ContentStudioSourceVersionRetentionPendingError');
    expect(
      await client.contentPackageRevision.count({ where: { packageId } })
    ).toBe(0);
  });

  it('PGX-W1-C AI writing whose sources were looked up before the removal: no operation, the provider never asked', async () => {
    // an AI context lists the source's newest versions only: a removed
    // candidate is never among them. The operation's own check is shown
    // with a context naming a removed version
    const page = await insertPage(ORG_A, SMALL);
    const report = await prepared(await planOf());
    expect((await executed(report.executionId, readyOf(report))).outcome).toBe(
      'completed'
    );
    const created = await operations
      .createRunningOperation({
        id: randomUUID(),
        organizationId: ORG_A,
        userId: USER[ORG_A],
        connectionId: CONNECTION[ORG_A],
        packageId: null,
        designRevisionId: null,
        baseDraftVersion: null,
        kind: 'generate_item',
        provider: 'openai',
        model: 'gpt-test',
        promptVersion: 'cs-item-v1',
        context: {
          v: 1,
          itemId: 'main',
          sources: [
            {
              sourceId: page.id,
              versionId: page.n(3).id,
              versionNumber: 3,
              contentHash: page.n(3).contentHash,
            },
          ],
        },
        requestHash: sha256Hex('request'),
        startedAt: new Date(),
      })
      .then(
        () => 'created',
        (err: Error) => err.name
      );
    expect(created).toBe('ContentStudioSourceVersionRetentionPendingError');
    expect(
      await client.contentStudioAIOperation.count({
        where: { organizationId: ORG_A },
      })
    ).toBe(0);
    // the real AI writing path with a held version: refused before the provider
    await clean();
    const held = await insertPage(ORG_A, SMALL);
    const packageId = await insertPackage(ORG_A, UNGROUNDED);
    await client.contentStudioSourceVersionRetentionPending.create({
      data: {
        organizationId: ORG_A,
        sourceVersionId: held.n(25).id,
        planHash: 'a'.repeat(64),
      },
    });
    const { adapter, resolver } = fakeAdapter();
    expect(await httpRefusal(propose(resolver, packageId, held.id))).toEqual(
      HELD
    );
    expect(adapter.generateText).not.toHaveBeenCalled();
    expect(
      await client.contentStudioAIOperation.count({
        where: { organizationId: ORG_A },
      })
    ).toBe(0);
  });

  it('PGX-W1-D a writer while a removal is open (pending and version removed, not committed): it sees the committed hold and is refused', async () => {
    const page = await insertPage(ORG_A, SMALL);
    const report = await prepared(await planOf());
    const inside = latch();
    const go = latch();
    const paused = executionWith({
      tx: tapped(client, async (model, method) => {
        if (
          model === 'contentStudioSourceVersionRetentionExecutionItem' &&
          method === 'updateMany'
        ) {
          inside.open();
          await go.opened;
        }
      }),
    });
    const running = executed(report.executionId, readyOf(report), paused);
    await inside.opened;
    const packageId = await insertPackage(ORG_A, UNGROUNDED);
    expect(
      await httpRefusal(
        packageService.saveDraft({
          organizationId: ORG_A,
          packageId,
          baseDraftVersion: 1,
          draft: grounded(page.n(3)),
        })
      )
    ).toEqual(HELD);
    go.open();
    expect((await running).outcome).toBe('completed');
    expect(await intact()).toBe(true);
  });

  it('PGX-W1-E/F after the removal the version is not there: the check refuses it in ONE statement; none for no version', async () => {
    const page = await insertPage(ORG_A, SMALL);
    const report = await prepared(await planOf());
    await executed(report.executionId, readyOf(report));
    const packageId = await insertPackage(ORG_A, UNGROUNDED);
    const loggedPackages = packagesWith(
      new PrismaTransaction(logged as unknown as PrismaService),
      logged as unknown as PrismaService
    );
    queries.length = 0;
    const refused = await loggedPackages
      .saveDraftCompareAndSwap({
        organizationId: ORG_A,
        packageId,
        baseDraftVersion: 1,
        draft: '{}',
        sourceVersionIds: [
          page.n(3).id,
          page.n(5).id,
          page.n(6).id,
          page.n(5).id,
        ],
      })
      .then(
        () => 'saved',
        (err: Error) => err.name
      );
    expect(refused).toBe('ContentStudioSourceVersionRetentionPendingError');
    const versionStatements = queries.filter((q) =>
      /ContentStudioSourceVersion/.test(q)
    );
    expect(versionStatements).toHaveLength(1);
    expect(versionStatements[0]).toMatch(/COUNT/i);
    expect(versionStatements[0]).toMatch(
      /ContentStudioSourceVersionRetentionPending/
    );
    // three distinct ids, one statement; the two that are there pass
    queries.length = 0;
    expect(
      await loggedPackages.saveDraftCompareAndSwap({
        organizationId: ORG_A,
        packageId,
        baseDraftVersion: 1,
        draft: '{}',
        sourceVersionIds: [page.n(5).id, page.n(6).id, page.n(7).id],
      })
    ).toEqual({ count: 1 });
    expect(
      queries.filter((q) => /ContentStudioSourceVersion/.test(q))
    ).toHaveLength(1);
    // no version: no statement on versions at all
    queries.length = 0;
    expect(
      await loggedPackages.saveDraftCompareAndSwap({
        organizationId: ORG_A,
        packageId,
        baseDraftVersion: 2,
        draft: '{}',
        sourceVersionIds: [],
      })
    ).toEqual({ count: 1 });
    expect(queries.filter((q) => /ContentStudioSourceVersion/.test(q))).toEqual(
      []
    );
    // another organization's version is refused the same way
    const foreign = await insertPage(ORG_B, SMALL);
    expect(
      await loggedPackages
        .saveDraftCompareAndSwap({
          organizationId: ORG_A,
          packageId,
          baseDraftVersion: 3,
          draft: '{}',
          sourceVersionIds: [foreign.n(25).id],
        })
        .then(
          () => 'saved',
          (err: Error) => err.name
        )
    ).toBe('ContentStudioSourceVersionRetentionPendingError');
  });

  it('PGX-W1-G versions that are there and held for nothing are written as before', async () => {
    const page = await insertPage(ORG_A, SMALL);
    const packageId = await insertPackage(ORG_A, UNGROUNDED);
    expect(
      await packageService.saveDraft({
        organizationId: ORG_A,
        packageId,
        baseDraftVersion: 1,
        draft: grounded(page.n(2), page.n(25)),
      })
    ).toEqual({ draftVersion: 2 });
    expect(
      (
        await packageService.createRevision({
          organizationId: ORG_A,
          packageId,
          userId: USER[ORG_A],
          draftVersion: 2,
        })
      ).created
    ).toBe(true);
  });

  it('PGX-W1-NEG the unsafe order (is it there? the removal commits; is it held?) writes a reference to a removed version', async () => {
    const page = await insertPage(ORG_A, SMALL);
    const report = await prepared(await planOf());
    const packageId = await insertPackage(ORG_A, UNGROUNDED);
    const v3 = page.n(3);
    // test-only: the wrong gate, never production code
    const wrongGate = async () => {
      const there = await other.contentStudioSourceVersion.count({
        where: { organizationId: ORG_A, id: v3.id },
      });
      expect(there).toBe(1);
      // the removal commits between the two reads
      expect(
        (await executed(report.executionId, readyOf(report))).outcome
      ).toBe('completed');
      const held =
        await other.contentStudioSourceVersionRetentionPending.findFirst({
          where: { organizationId: ORG_A, sourceVersionId: v3.id },
        });
      if (held) {
        return 'refused';
      }
      await other.contentPackage.update({
        where: { id: packageId },
        data: {
          draft: JSON.stringify(grounded(v3)),
          draftVersion: { increment: 1 },
        },
      });
      return 'written';
    };
    expect(await wrongGate()).toBe('written');
    // the reference names a version that is gone: protection fails the organization
    expect(await intact()).toBe(false);
    // and the production check refuses the very same write
    expect(
      await packages
        .saveDraftCompareAndSwap({
          organizationId: ORG_A,
          packageId,
          baseDraftVersion: 2,
          draft: JSON.stringify(grounded(v3)),
          sourceVersionIds: [v3.id],
        })
        .then(
          () => 'written',
          (err: Error) => err.name
        )
    ).toBe('ContentStudioSourceVersionRetentionPendingError');
    await client.contentPackage.delete({ where: { id: packageId } });
  });
});

describe('P8-R1C one batch, all or nothing, on PostgreSQL', () => {
  it('PGX-F1 a held version cannot be removed: the foreign key refuses (P2003)', async () => {
    const page = await insertPage(ORG_A, SMALL);
    await prepared(await planOf());
    const err = await client.contentStudioSourceVersion
      .delete({ where: { id: page.n(3).id } })
      .catch((e: unknown) => e);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2003');
  });

  const failingAt: Array<[string, string, string]> = [
    [
      'F2 after the held rows, before the versions',
      'contentStudioSourceVersion',
      'deleteMany',
    ],
    [
      'F3 after the versions, before the items',
      'contentStudioSourceVersionRetentionExecutionItem',
      'updateMany',
    ],
  ];
  for (const [name, model, method] of failingAt) {
    it(`PGX-${name}: the batch is rolled back whole, read back as not committed, and the execution aborted`, async () => {
      await insertPage(ORG_A, SMALL);
      const report = await prepared(await planOf());
      let reached = false;
      const failing = executionWith({
        tx: tapped(client, (m, f) => {
          if (m === model && f === method && !reached) {
            reached = true;
            throw new Error('the connection dropped');
          }
        }),
      });
      const result = await executed(
        report.executionId,
        readyOf(report),
        failing
      );
      expect(reached).toBe(true);
      expect(result).toEqual(
        expect.objectContaining({
          outcome: 'aborted',
          errorCode: 'RETENTION_EXECUTION_BATCH_FAILED',
          detail: 'UNKNOWN_OUTCOME_NOT_COMMITTED',
          deletedCount: 0,
          batchCount: 0,
        })
      );
      const after = await state();
      expect(after.versions).toHaveLength(25);
      expect(after.items.every((item) => item.status === 'planned')).toBe(true);
      expect(after.pending).toEqual([]);
      expect(after.locks).toEqual([]);
    });
  }
});

describe('P8-R1C the defences no ordinary run reaches, on PostgreSQL', () => {
  it('PGX-F4 a batch that removes fewer versions than it holds is rolled back whole: nothing removed', async () => {
    const page = await insertPage(ORG_A, SMALL);
    const report = await prepared(await planOf());
    let done = false;
    const short = executionWith({
      tx: tapped(client, async (model, method, tx) => {
        if (
          model === 'contentStudioSourceVersion' &&
          method === 'deleteMany' &&
          !done
        ) {
          done = true;
          // one of the batch gone already, inside the same transaction
          await tx.contentStudioSourceVersion.deleteMany({
            where: { id: page.n(3).id },
          });
        }
      }),
    });
    const result = await executed(report.executionId, readyOf(report), short);
    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'aborted',
        errorCode: 'RETENTION_EXECUTION_BATCH_FAILED',
        detail: 'VERSION_CHANGED',
        deletedCount: 0,
      })
    );
    expect((await state()).versions).toHaveLength(25);
  });

  it('PGX-F5 an execution whose lock is gone removes nothing more: the next batch fails, it stops, and it cannot end without its lock', async () => {
    await insertPage(ORG_A, 'A'.repeat(103) + 'C'.repeat(20));
    const report = await prepared(await planOf());
    let batch = 0;
    const unlocked = executionWith({
      tx: tapped(client, async (model, method) => {
        if (
          model === 'contentStudioSourceVersionRetentionExecution' &&
          method === 'findFirst' &&
          ++batch === 2
        ) {
          // test-only: the lock removed by hand between two batches
          await other.contentStudioSourceVersionRetentionExecutionLock.deleteMany(
            { where: { executionId: report.executionId } }
          );
        }
      }),
    });
    const result = await executed(
      report.executionId,
      readyOf(report),
      unlocked
    );
    // an end and its lock go together: without the lock nothing ends it,
    // and an operator must look (exit code 2)
    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'interrupted',
        status: 'executing',
        errorCode: 'RETENTION_EXECUTION_STATE_INVALID',
        deletedCount: 100,
        batchCount: 1,
      })
    );
    expect(
      contentStudioSourceVersionRetentionExecutionExitCode(result.outcome)
    ).toBe(2);
    const after = await state();
    expect(
      after.items.filter((item) => item.status === 'deleted')
    ).toHaveLength(100);
    // the rest is released and still there
    expect(after.pending).toEqual([]);
    const left = after.items.find((item) => item.status === 'planned')!;
    expect(after.versions).toContain(left.sourceVersionId);
  });

  it('PGX-F6 a source that no longer reads as it should after its last batch stops the execution: partial, its integrity failed', async () => {
    // its change state goes stale right after its batch: a change before
    // the last is stored, which R1A accepts and the per-source check not
    const stale = await insertPage(
      ORG_A,
      'AAAAA' + 'B'.repeat(10) + 'C'.repeat(10)
    );
    const report = await prepared(await planOf());
    let reads = 0;
    const corrupting = executionWith({
      tx: tapped(client, async (model, method) => {
        if (
          model === 'contentStudioSource' &&
          method === 'findFirst' &&
          ++reads === 1
        ) {
          await other.contentStudioSource.update({
            where: { id: stale.id },
            data: {
              lastPageChangeAt: stale.n(6).fetchedAt,
              lastPageChangeVersionNumber: 6,
              lastPageChangeKind: 'content_changed',
              lastPageChangePreviousCaptureAt: stale.n(5).fetchedAt,
            },
          });
        }
      }),
    });
    const result = await executed(
      report.executionId,
      readyOf(report),
      corrupting
    );
    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'partial',
        errorCode: 'RETENTION_EXECUTION_INTEGRITY_FAILED',
        detail: 'PAGE_CHANGE_STATE_STALE',
        integrityCheck: 'failed',
        deletedCount: 3,
      })
    );
    // the organization itself still resolves: only the source's own check
    // saw it
    expect(await intact()).toBe(true);
    expect((await state()).locks).toEqual([]);
  });
});

describe('P8-R1C failures part way, on PostgreSQL', () => {
  // three batches: a source of 101 candidates (two batches) and one of 3
  const threeBatches = async () => {
    const pages = [
      await insertPage(ORG_A, 'A'.repeat(103) + 'C'.repeat(20)),
      await insertPage(ORG_A, SMALL),
    ];
    const plan = await planOf();
    expect(candidatesOf(plan)).toHaveLength(104);
    return { pages, plan };
  };
  const onBatch = (n: number, act: () => Promise<void> | void) => {
    let batch = 0;
    return tapped(client, async (model, method) => {
      if (
        model === 'contentStudioSourceVersionRetentionExecution' &&
        method === 'findFirst'
      ) {
        batch += 1;
        if (batch === n) {
          await act();
        }
      }
    });
  };

  it('PGX-PF1 batches 1 and 2 commit and 3 fails: partial, the rest released and kept, unlocked, the organization checked; never planned again', async () => {
    const { plan } = await threeBatches();
    const report = await prepared(plan);
    const failing = executionWith({
      tx: onBatch(3, () => {
        throw new Error('the connection dropped');
      }),
    });
    const result = await executed(report.executionId, readyOf(report), failing);
    const after = await state();
    const deleted = after.items.filter((item) => item.status === 'deleted');
    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'partial',
        status: 'partial',
        errorCode: 'RETENTION_EXECUTION_BATCH_FAILED',
        detail: 'UNKNOWN_OUTCOME_NOT_COMMITTED',
        deletedCount: deleted.length,
        batchCount: 2,
        integrityCheck: 'passed',
      })
    );
    expect(
      contentStudioSourceVersionRetentionExecutionExitCode(result.outcome)
    ).toBe(2);
    expect(new Set(deleted.map((item) => item.batchNumber))).toEqual(
      new Set([1, 2])
    );
    for (const item of after.items.filter((i) => i.status === 'planned')) {
      expect(after.versions).toContain(item.sourceVersionId);
    }
    expect(after.pending).toEqual([]);
    expect(after.locks).toEqual([]);
    expect(await intact()).toBe(true);
    expect(
      (
        await refusedWith(
          execution.prepare({
            organizationId: ORG_A,
            plan,
            clock: clock(NOW.getTime() + SECOND),
          })
        )
      ).code
    ).toBe('RETENTION_EXECUTION_ALREADY_RUN');
  });

  it('PGX-PF2 a count that is not the batch rolls the batch back and stops: aborted, nothing removed', async () => {
    const page = await insertPage(ORG_A, SMALL);
    const report = await prepared(await planOf());
    let done = false;
    const meddling = executionWith({
      tx: tapped(client, async (model, method) => {
        if (
          model === 'contentStudioSourceVersionRetentionExecutionItem' &&
          method === 'updateMany' &&
          !done
        ) {
          done = true;
          // another connection marks one item while the batch is open
          await other.contentStudioSourceVersionRetentionExecutionItem.updateMany(
            {
              where: { sourceVersionId: page.n(2).id },
              data: { status: 'deleted' },
            }
          );
        }
      }),
    });
    const result = await executed(
      report.executionId,
      readyOf(report),
      meddling
    );
    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'aborted',
        errorCode: 'RETENTION_EXECUTION_BATCH_FAILED',
        detail: 'ITEMS_CHANGED',
        deletedCount: 0,
      })
    );
    expect((await state()).versions).toHaveLength(25);
  });

  it('PGX-PF3 releasing fails after a stop: CLEANUP_REQUIRED, executing and locked; cancel recovers', async () => {
    const page = await insertPage(ORG_A, SMALL);
    const report = await prepared(await planOf());
    await insertPackage(ORG_A, grounded(page.n(3)));
    const failing = retentionWith({
      releaseSourceVersionQuarantine: async () => {
        throw new Error('release failed');
      },
    });
    const result = await executed(
      report.executionId,
      readyOf(report),
      executionWith({ retention: failing })
    );
    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'cleanup_required',
        status: 'executing',
        errorCode: 'RETENTION_EXECUTION_CLEANUP_REQUIRED',
        detail: 'RETENTION_EXECUTION_RECHECK_FAILED',
      })
    );
    expect((await state()).locks).toHaveLength(1);
    const cancelled = await execution.cancel({
      executionId: report.executionId,
      clock: clock(readyOf(report)),
    });
    expect(cancelled).toEqual(
      expect.objectContaining({
        outcome: 'cancelled',
        previousStatus: 'executing',
        releasedCount: 3,
      })
    );
    const after = await state();
    expect([after.locks, after.pending]).toEqual([[], []]);
    expect(after.versions).toHaveLength(25);
  });

  it('PGX-UC an unknown outcome that did commit is read back as committed, counted, and the execution stops', async () => {
    const { plan } = await threeBatches();
    const report = await prepared(plan);
    let batch = 0;
    const flaky = {
      model: {
        $transaction: async (fn: never, options?: object) => {
          const result = await client.$transaction(fn, options);
          if (
            (options as { isolationLevel?: string } | undefined)
              ?.isolationLevel === undefined &&
            ++batch === 1 &&
            (result as { deleted?: number })?.deleted
          ) {
            throw new Prisma.PrismaClientUnknownRequestError(
              'connection lost after commit',
              {
                clientVersion: Prisma.prismaVersion.client,
              }
            );
          }
          return result;
        },
      },
    } as unknown as PrismaTransaction;
    const result = await executed(
      report.executionId,
      readyOf(report),
      executionWith({ tx: flaky })
    );
    // the first batch, whichever source comes first: 100 or 3
    const first = batchesOf(plan)[0].length;
    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'partial',
        errorCode: 'RETENTION_EXECUTION_BATCH_FAILED',
        detail: 'UNKNOWN_OUTCOME_COMMITTED',
        deletedCount: first,
        batchCount: 1,
        integrityCheck: 'passed',
      })
    );
    const after = await state();
    expect(
      after.items.filter((item) => item.status === 'deleted')
    ).toHaveLength(first);
    expect(after.pending).toEqual([]);
    expect(after.locks).toEqual([]);
  });
});

describe('P8-R1C crashes and cancel, on PostgreSQL', () => {
  it('PGX-CR1/CA2 a crash right after the execution was recorded: preparing and locked, nothing held; prepare names it, cancel ends it', async () => {
    await insertPage(ORG_A, SMALL);
    const plan = await planOf();
    const crashed = retentionWith({
      evaluateRetentionPlan: () => new Promise(() => undefined),
    });
    // the process dies while the plan is made again: nothing awaits it
    void executionWith({ retention: crashed }).prepare({
      organizationId: ORG_A,
      plan,
      clock: clock(NOW.getTime() + SECOND),
    });
    for (let i = 0; i < 50 && !(await state()).locks.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const at = await state();
    expect(at.executions.map((e) => e.status)).toEqual(['preparing']);
    expect(at.locks).toHaveLength(1);
    expect(at.pending).toEqual([]);
    // nothing is held, so another dry run is made; its plan is refused,
    // naming the execution to cancel
    const second = await planOf(ORG_A, new Date(NOW.getTime() + SECOND));
    expect(
      await refusedWith(
        execution.prepare({
          organizationId: ORG_A,
          plan: second,
          clock: clock(NOW.getTime() + 2 * SECOND),
        })
      )
    ).toEqual({
      code: 'RETENTION_EXECUTION_ALREADY_ACTIVE',
      detail: `execution ${at.executions[0].id}`,
    });
    const cancelled = await execution.cancel({
      executionId: at.executions[0].id,
      clock: clock(NOW.getTime() + 3 * SECOND),
    });
    expect(cancelled).toEqual(
      expect.objectContaining({
        outcome: 'cancelled',
        previousStatus: 'preparing',
        deletedCount: 0,
      })
    );
    expect((await state()).locks).toEqual([]);
  });

  it('PGX-CR2/CA1/CA7 prepared and left: cancel releases every held row, cancelled, unlocked, no version removed', async () => {
    await insertPage(ORG_A, SMALL);
    const report = await prepared(await planOf());
    const before = await state();
    const cancelled = await execution.cancel({
      executionId: report.executionId,
      clock: clock(NOW.getTime() + 2 * SECOND),
    });
    expect(cancelled).toEqual(
      expect.objectContaining({
        outcome: 'cancelled',
        previousStatus: 'prepared',
        status: 'cancelled',
        plannedCount: 3,
        deletedCount: 0,
        releasedCount: 3,
        oldestPendingAt: expect.any(String),
        integrityCheck: null,
      })
    );
    expect(
      contentStudioSourceVersionRetentionExecutionExitCode(cancelled.outcome)
    ).toBe(0);
    const after = await state();
    expect(after.versions.sort()).toEqual(before.versions.sort());
    expect([after.locks, after.pending]).toEqual([[], []]);
    // CA5: again is STATE_INVALID; executing it is ALREADY_RUN
    expect(
      (
        await refusedWith(
          execution.cancel({ executionId: report.executionId, clock: clock(0) })
        )
      ).code
    ).toBe('RETENTION_EXECUTION_STATE_INVALID');
    expect(
      (await refusedWith(executed(report.executionId, readyOf(report)))).code
    ).toBe('RETENTION_EXECUTION_ALREADY_RUN');
  });

  it('PGX-CR3/CA3 a crash after executing began, before any batch: execute again is ALREADY_ACTIVE; cancel ends it, nothing removed', async () => {
    await insertPage(ORG_A, SMALL);
    const report = await prepared(await planOf());
    expect(
      (
        await executionRepository().startExecuting({
          id: report.executionId,
          organizationId: ORG_A,
          now: new Date(readyOf(report)),
          hostname: null,
        })
      ).count
    ).toBe(1);
    expect(
      (await refusedWith(executed(report.executionId, readyOf(report)))).code
    ).toBe('RETENTION_EXECUTION_ALREADY_ACTIVE');
    const cancelled = await execution.cancel({
      executionId: report.executionId,
      clock: clock(readyOf(report)),
    });
    expect(cancelled).toEqual(
      expect.objectContaining({
        outcome: 'cancelled',
        previousStatus: 'executing',
      })
    );
    expect((await state()).versions).toHaveLength(25);
  });

  it('PGX-CR4/CA4 a crash after the first batch: executing, locked, its items deleted; cancel makes it partial with the organization checked', async () => {
    const big = await insertPage(ORG_A, 'A'.repeat(103) + 'C'.repeat(20));
    const report = await prepared(await planOf());
    // the second batch never comes, and the process is gone before
    // anything is read back or released
    let batch = 0;
    const crashing = Object.assign(
      executionRepository(
        tapped(client, (model, method) => {
          if (
            model === 'contentStudioSourceVersionRetentionExecution' &&
            method === 'findFirst' &&
            ++batch === 2
          ) {
            throw new Error('crash');
          }
        })
      ),
      { countState: () => Promise.reject(new Error('crash')) }
    );
    const crashedService = new ContentStudioSourceRetentionExecutionService(
      crashing,
      retention
    );
    await expect(
      executed(report.executionId, readyOf(report), crashedService)
    ).rejects.toThrow('crash');
    const at = await state();
    expect(at.executions[0]).toEqual(
      expect.objectContaining({
        status: 'executing',
        deletedCount: 100,
        batchCount: 1,
      })
    );
    expect(at.locks).toHaveLength(1);
    expect(at.pending).toHaveLength(1);
    const cancelled = await execution.cancel({
      executionId: report.executionId,
      clock: clock(readyOf(report)),
    });
    expect(cancelled).toEqual(
      expect.objectContaining({
        outcome: 'partial',
        previousStatus: 'executing',
        status: 'partial',
        deletedCount: 100,
        releasedCount: 1,
        integrityCheck: 'passed',
      })
    );
    expect(
      contentStudioSourceVersionRetentionExecutionExitCode(cancelled.outcome)
    ).toBe(2);
    const after = await state();
    expect([after.locks, after.pending]).toEqual([[], []]);
    expect(after.versions).toContain(big.n(102).id);
  });

  it('PGX-CA6 cancel whose release fails: CLEANUP_REQUIRED, still locked; again, it ends', async () => {
    await insertPage(ORG_A, SMALL);
    const report = await prepared(await planOf());
    const failing = executionWith({
      retention: retentionWith({
        releaseSourceVersionQuarantine: async () => {
          throw new Error('release failed');
        },
      }),
    });
    const result = await failing.cancel({
      executionId: report.executionId,
      clock: clock(0),
    });
    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'cleanup_required',
        status: 'prepared',
        errorCode: 'RETENTION_EXECUTION_CLEANUP_REQUIRED',
      })
    );
    expect((await state()).locks).toHaveLength(1);
    expect(
      (
        await execution.cancel({
          executionId: report.executionId,
          clock: clock(0),
        })
      ).outcome
    ).toBe('cancelled');
  });

  it('PGX-166 cancel while an execution runs: the open batch commits whole or fails, the rest stays, nothing dangles', async () => {
    await insertPage(ORG_A, 'A'.repeat(103) + 'C'.repeat(20));
    const report = await prepared(await planOf());
    const atSecond = latch();
    const go = latch();
    let batch = 0;
    const paused = executionWith({
      tx: tapped(client, async (model, method) => {
        if (
          model === 'contentStudioSourceVersionRetentionExecution' &&
          method === 'findFirst' &&
          ++batch === 2
        ) {
          atSecond.open();
          await go.opened;
        }
      }),
    });
    const running = executed(report.executionId, readyOf(report), paused);
    await atSecond.opened;
    const cancelled = await execution.cancel({
      executionId: report.executionId,
      clock: clock(readyOf(report)),
    });
    expect(cancelled).toEqual(
      expect.objectContaining({
        outcome: 'partial',
        deletedCount: 100,
        releasedCount: 1,
      })
    );
    go.open();
    const result = await running;
    expect(result.outcome).toBe('interrupted');
    expect(
      contentStudioSourceVersionRetentionExecutionExitCode(result.outcome)
    ).toBe(2);
    const after = await state();
    expect(after.executions[0]).toEqual(
      expect.objectContaining({
        status: 'partial',
        deletedCount: 100,
        batchCount: 1,
      })
    );
    expect([after.locks, after.pending]).toEqual([[], []]);
    expect(await intact()).toBe(true);
  });

  it('PGX-RP a plan is never prepared again: completed, aborted, cancelled or partial', async () => {
    const ends: Array<
      [
        string,
        (report: {
          executionId: string;
          readyAt: string | null;
        }) => Promise<unknown>
      ]
    > = [
      ['completed', (r) => executed(r.executionId, readyOf(r))],
      ['aborted', (r) => executed(r.executionId, VALID_UNTIL)],
      [
        'cancelled',
        (r) =>
          execution.cancel({ executionId: r.executionId, clock: clock(0) }),
      ],
    ];
    for (const [end, act] of ends) {
      await clean();
      await insertPage(ORG_A, SMALL);
      const plan = await planOf();
      const report = await prepared(plan);
      await act(report);
      expect((await state()).executions[0].status).toBe(end);
      expect([
        end,
        (
          await refusedWith(
            execution.prepare({
              organizationId: ORG_A,
              plan,
              clock: clock(NOW.getTime() + SECOND),
            })
          )
        ).code,
      ]).toEqual([end, 'RETENTION_EXECUTION_ALREADY_RUN']);
    }
  });
});

// Opt-in only (CONTENT_STUDIO_RETENTION_EXECUTION_SCALE=1), never in the
// default suite: the most an execution removes, 10,000 candidates of 100
// sources, prepared and executed end to end, with the time each step took
const scale =
  process.env.CONTENT_STUDIO_RETENTION_EXECUTION_SCALE === '1'
    ? describe
    : describe.skip;
scale('P8-R1C scale on PostgreSQL (opt-in)', () => {
  it('PGX-S1 10,000 candidates: 100 batches, every one removed, the organization intact', async () => {
    const pages = [];
    for (let i = 0; i < 100; i++) {
      pages.push(await insertPage(ORG_A, 'A'.repeat(102) + 'B'.repeat(20)));
    }
    let started = Date.now();
    const plan = await planOf();
    const dryRunMs = Date.now() - started;
    expect(candidatesOf(plan)).toHaveLength(10_000);
    started = Date.now();
    const report = await prepared(plan);
    const prepareMs = Date.now() - started;
    started = Date.now();
    const result = await executed(report.executionId, readyOf(report));
    const executeMs = Date.now() - started;
    expect(result).toEqual(
      expect.objectContaining({
        outcome: 'completed',
        deletedCount: 10_000,
        batchCount: 100,
        integrityCheck: 'passed',
      })
    );
    expect(
      await client.contentStudioSourceVersion.count({
        where: { organizationId: ORG_A },
      })
    ).toBe(100 * 22);
    expect(await intact()).toBe(true);
    console.log(
      `P8-R1C scale: dry run ${dryRunMs} ms, prepare ${prepareMs} ms, execute ${executeMs} ms`
    );
    expect(prepareMs + executeMs).toBeLessThan(60_000);
  }, 600_000);
});
