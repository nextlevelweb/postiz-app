import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { Connection, WorkflowClient } from '@temporalio/client';
import { TEMPORAL_CONNECTION } from 'nestjs-temporal-core';
import { CommandService } from 'nestjs-command';

// Loading the Prisma client copies the repository's .env into process.env
// for every variable not set yet, and the Redis service connects to REDIS_URL
// as it loads. Set before anything loads them: no Redis and no Temporal server
// is reached. DATABASE_URL comes from the run and is checked below
process.env.REDIS_URL = '';
process.env.TEMPORAL_ADDRESS = '127.0.0.1:1';
/* eslint-disable @typescript-eslint/no-var-requires */
const {
  storedContentStudioSourceContent,
}: typeof import('@gitroom/nestjs-libraries/content-studio/sources/source.version') = require('@gitroom/nestjs-libraries/content-studio/sources/source.version');
const {
  assertContentStudioPostgresUrl,
  contentStudioPostgresUrlFromEnv,
  createContentStudioPostgresClient,
}: typeof import('../../../../../../jest.content-studio.postgres.guard') = require('../../../../../../jest.content-studio.postgres.guard');
const {
  ioRedis,
}: typeof import('@gitroom/nestjs-libraries/redis/redis.service') = require('@gitroom/nestjs-libraries/redis/redis.service');
const {
  CommandModule,
}: typeof import('../../../../../../apps/commands/src/command.module') = require('../../../../../../apps/commands/src/command.module');
/* eslint-enable @typescript-eslint/no-var-requires */

// The page-change backfill (P8-04B1) through the operator command runtime on
// a real PostgreSQL: CommandModule started by Nest with its real providers,
// PrismaService on the disposable database, and the command parsed and run
// by nestjs-command as `content-studio:backfill-page-changes`, twice. Only
// TEMPORAL_CONNECTION, the eager worker connection, is the null the Temporal
// module falls back to without Temporal; the client stays real and lazy.
// Opt-in: runs only through jest.content-studio.integration.config.ts

// published as ES modules only, which Node loads and Jest does not; never
// called by the backfill
jest.mock('file-type', () => ({
  fileTypeFromBuffer: jest.fn(),
  fileTypeStream: jest.fn(),
}));
jest.mock('isomorphic-dompurify', () => ({
  __esModule: true,
  default: { sanitize: jest.fn() },
}));
jest.mock('nostr-tools', () => ({
  getPublicKey: jest.fn(),
  finalizeEvent: jest.fn(),
  Relay: { connect: jest.fn() },
  SimplePool: class {},
}));

const ORG = '30841200-0000-4000-8000-00000000000a';
const USER = '30841200-0000-4000-8000-0000000000a1';
const V1 = 'content-studio-source-v1';
const V2 = 'content-studio-source-v2';
const NONE = [null, null, null, null];

let client: PrismaClient;
let moduleRef: TestingModule;

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1) + minute * 60_000);
const source = async (
  versions: Array<{ text: string; title?: string; extractionVersion?: string }>,
  over: { kind?: string; archivedAt?: Date } = {}
) => {
  const id = randomUUID();
  await client.contentStudioSource.create({
    data: {
      id,
      organizationId: ORG,
      kind: over.kind ?? 'url',
      name: 'P8041R1 page',
      canonicalUrl: `https://p8041r1.example/${id}`,
      createdById: USER,
      archivedAt: over.archivedAt ?? null,
      latestVersionNumber: versions.length,
    },
  });
  await client.contentStudioSourceVersion.createMany({
    data: versions.map((version, i) => ({
      id: randomUUID(),
      organizationId: ORG,
      sourceId: id,
      versionNumber: i + 1,
      extractionVersion: version.extractionVersion ?? V2,
      requestedUrl: 'https://p8041r1.example/bulk',
      finalUrl: 'https://p8041r1.example/bulk',
      redirectCount: 0,
      fetchedAt: at(i + 1),
      httpStatus: 200,
      contentType: 'text/html',
      contentLength: 100,
      title: version.title ?? 'Page',
      sourceHash: null,
      createdById: USER,
      ...storedContentStudioSourceContent({
        schemaVersion: 1,
        blocks: [
          { id: 'b1', type: 'paragraph', text: version.text, level: null },
        ],
      }),
    })),
  });
  return id;
};
const stored = async (id: string) => {
  const row = await client.contentStudioSource.findUniqueOrThrow({
    where: { id },
  });
  return [
    row.lastPageChangeAt,
    row.lastPageChangeVersionNumber,
    row.lastPageChangeKind,
    row.lastPageChangePreviousCaptureAt,
  ];
};
const updatedAts = async () =>
  (
    await client.contentStudioSource.findMany({
      where: { organizationId: ORG },
      orderBy: { id: 'asc' },
      select: { id: true, updatedAt: true },
    })
  ).map((row) => [row.id, row.updatedAt.toISOString()]);

// what an operator types, parsed by the command runtime
const run = async () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = jest
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);
  await moduleRef
    .get(CommandService)
    .exec(['content-studio:backfill-page-changes']);
  const lines = log.mock.calls
    .map((call) => call.join(' '))
    .filter((line) => /^Page changes/.test(line));
  const errors = error.mock.calls.map((call) => call.join(' '));
  log.mockRestore();
  error.mockRestore();
  return { lines, errors, exitCode: process.exitCode };
};

const cleanFixtures = async () => {
  const where = { organizationId: ORG };
  await client.contentStudioSourceVersion.deleteMany({ where });
  await client.contentStudioSource.deleteMany({ where });
  await client.userOrganization.deleteMany({ where });
  await client.user.deleteMany({ where: { id: USER } });
  await client.organization.deleteMany({ where: { id: ORG } });
};

beforeAll(async () => {
  // PrismaService reads DATABASE_URL: it must be the disposable database
  expect(assertContentStudioPostgresUrl(process.env.DATABASE_URL)).toBe(
    contentStudioPostgresUrlFromEnv()
  );
  client = createContentStudioPostgresClient();
  await client.$connect();
  await cleanFixtures();
  await client.organization.create({ data: { id: ORG, name: 'P8041R1' } });
  await client.user.create({
    data: {
      id: USER,
      email: `${USER}@p8041r1.invalid`,
      providerName: 'LOCAL',
      timezone: 0,
      name: 'P8041R1',
    },
  });
  await client.userOrganization.create({
    data: { userId: USER, organizationId: ORG, role: 'USER' },
  });
});

afterAll(async () => {
  await moduleRef?.close();
  if (client) {
    await cleanFixtures();
    await client.$disconnect();
  }
});

describe('The page-change backfill command on PostgreSQL', () => {
  it('P804B1R1PG1 the started command runtime rebuilds the page changes, then a second run writes nothing', async () => {
    // the backfill reads every organization: this suite needs the database
    // to itself
    expect(
      await client.contentStudioSource.count({
        where: { organizationId: { not: ORG } },
      })
    ).toBe(0);
    const initial = await source([{ text: 'A' }]);
    const repeats = await source([{ text: 'A' }, { text: 'A' }, { text: 'A' }]);
    const extraction = await source([
      { text: 'A', extractionVersion: V1 },
      { text: 'Z', title: 'Other', extractionVersion: V2 },
    ]);
    const title = await source([
      { text: 'A', title: 'One' },
      { text: 'A', title: 'Two' },
    ]);
    const content = await source([{ text: 'A' }, { text: 'A' }, { text: 'B' }]);
    const archived = await source([{ text: 'A' }, { text: 'B' }], {
      archivedAt: at(60),
    });
    const feed = await source([], { kind: 'feed' });
    const before = await updatedAts();

    const connect = jest.spyOn(Connection, 'connect');
    const started = [
      jest.spyOn(WorkflowClient.prototype, 'start'),
      jest.spyOn(WorkflowClient.prototype, 'signalWithStart'),
      jest.spyOn(WorkflowClient.prototype, 'execute'),
    ];
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const exitCode = process.exitCode;
    moduleRef = await Test.createTestingModule({ imports: [CommandModule] })
      .overrideProvider(TEMPORAL_CONNECTION)
      .useValue(null)
      .compile();
    // the lifecycle hooks a started command runs: Prisma connects, the
    // commands are registered
    await moduleRef.init();

    expect(await run()).toEqual({
      lines: [
        'Page changes backfill complete: 3 updated, 3 unchanged, 0 failed.',
      ],
      errors: [],
      exitCode,
    });
    expect(await stored(initial)).toEqual(NONE);
    expect(await stored(repeats)).toEqual(NONE);
    expect(await stored(extraction)).toEqual(NONE);
    expect(await stored(title)).toEqual([at(2), 2, 'title_changed', at(1)]);
    expect(await stored(content)).toEqual([at(3), 3, 'content_changed', at(2)]);
    expect(await stored(archived)).toEqual([
      at(2),
      2,
      'content_changed',
      at(1),
    ]);
    expect(await stored(feed)).toEqual(NONE);

    expect(await run()).toEqual({
      lines: [
        'Page changes backfill complete: 0 updated, 6 unchanged, 0 failed.',
      ],
      errors: [],
      exitCode,
    });
    // the backfill keeps updatedAt
    expect(await updatedAts()).toEqual(before);

    // no workflow, no eager Temporal connection, no Redis, no fetch
    expect(connect).not.toHaveBeenCalled();
    expect(ioRedis).not.toBeInstanceOf(Redis);
    for (const start of started) {
      expect(start).not.toHaveBeenCalled();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
