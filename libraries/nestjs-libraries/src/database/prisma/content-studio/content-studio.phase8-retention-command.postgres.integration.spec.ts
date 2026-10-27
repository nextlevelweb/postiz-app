import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
  canonicalJson,
}: typeof import('@gitroom/nestjs-libraries/content-studio/canonical.json') = require('@gitroom/nestjs-libraries/content-studio/canonical.json');
const {
  ContentStudioSourceRetentionRepository,
}: typeof import('@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention.repository') = require('@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention.repository');
const {
  ContentStudioSourceRetentionService,
}: typeof import('@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention.service') = require('@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention.service');
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

// The retention dry run (P8-R1B) through the operator command runtime on a
// real PostgreSQL: CommandModule started by Nest with its real providers,
// PrismaService on the disposable database, and the command parsed and run
// by nestjs-command as `content-studio:retention-dry-run`: the summary, the
// JSON and nothing else on stdout, every refusal with exit code 1, and no
// row changed. Only TEMPORAL_CONNECTION, the eager worker connection, is the
// null the Temporal module falls back to without Temporal. Opt-in: runs only
// through jest.content-studio.integration.config.ts

// published as ES modules only, which Node loads and Jest does not; never
// called by the dry run
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

const ORG = '30a1bc00-0000-4000-8000-00000000000a';
const EMPTY_ORG = '30a1bc00-0000-4000-8000-00000000000b';
const USER = '30a1bc00-0000-4000-8000-0000000000a1';
const X2 = 'content-studio-source-v2';

let client: PrismaClient;
let moduleRef: TestingModule;

const at = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 60_000);
// A page of these captures (by text), its last page change as captures
// store it
const page = async (texts: string[], stale = false) => {
  const id = randomUUID();
  let change: { n: number } | null = null;
  texts.forEach((text, i) => {
    if (i > 0 && text !== texts[i - 1]) {
      change = { n: i + 1 };
    }
  });
  const last = change as { n: number } | null;
  await client.contentStudioSource.create({
    data: {
      id,
      organizationId: ORG,
      kind: 'url',
      name: 'P8R1B command page',
      canonicalUrl: `https://p8r1bc.example/${id}`,
      createdById: USER,
      latestVersionNumber: texts.length,
      ...(last && !stale
        ? {
            lastPageChangeAt: at(last.n),
            lastPageChangeVersionNumber: last.n,
            lastPageChangeKind: 'content_changed',
            lastPageChangePreviousCaptureAt: at(last.n - 1),
          }
        : {}),
    },
  });
  await client.contentStudioSourceVersion.createMany({
    data: texts.map((text, i) => ({
      id: randomUUID(),
      organizationId: ORG,
      sourceId: id,
      versionNumber: i + 1,
      extractionVersion: X2,
      requestedUrl: 'https://p8r1bc.example/page',
      finalUrl: 'https://p8r1bc.example/page',
      redirectCount: 0,
      fetchedAt: at(i + 1),
      httpStatus: 200,
      contentType: 'text/html',
      contentLength: 100,
      title: 'Page',
      sourceHash: null,
      createdById: USER,
      createdAt: at(i + 1),
      ...storedContentStudioSourceContent({
        schemaVersion: 1,
        blocks: [{ id: 'b1', type: 'paragraph', text, level: null }],
      }),
    })),
  });
  return id;
};

const rows = async () => ({
  sources: await client.contentStudioSource.findMany({
    where: { organizationId: ORG },
    orderBy: { id: 'asc' },
  }),
  versions: await client.contentStudioSourceVersion.findMany({
    where: { organizationId: ORG },
    orderBy: { id: 'asc' },
  }),
});

// what an operator types, parsed by the command runtime
const run = (...args: string[]) =>
  command('content-studio:retention-dry-run', ...args);
const command = async (name: string, ...args: string[]) => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = jest
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  await moduleRef.get(CommandService).exec([name, ...args]);
  const result = {
    stdout: log.mock.calls.map((call) => call.join(' ')),
    stderr: error.mock.calls.map((call) => call.join(' ')),
    exitCode: process.exitCode,
  };
  process.exitCode = exitCode;
  log.mockRestore();
  error.mockRestore();
  return result;
};

const cleanFixtures = async () => {
  const where = { organizationId: { in: [ORG, EMPTY_ORG] } };
  // test data only, in the disposable database
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
  await client.contentStudioSourceVersion.deleteMany({ where });
  await client.contentStudioSource.deleteMany({ where });
  await client.userOrganization.deleteMany({ where });
  await client.user.deleteMany({ where: { id: USER } });
  await client.organization.deleteMany({
    where: { id: { in: [ORG, EMPTY_ORG] } },
  });
};

beforeAll(async () => {
  // PrismaService reads DATABASE_URL: it must be the disposable database
  expect(assertContentStudioPostgresUrl(process.env.DATABASE_URL)).toBe(
    contentStudioPostgresUrlFromEnv()
  );
  client = createContentStudioPostgresClient();
  await client.$connect();
  await cleanFixtures();
  await client.organization.create({ data: { id: ORG, name: 'P8R1BC' } });
  await client.organization.create({
    data: { id: EMPTY_ORG, name: 'P8R1BC empty' },
  });
  await client.user.create({
    data: {
      id: USER,
      email: `${USER}@p8r1bc.invalid`,
      providerName: 'LOCAL',
      timezone: 0,
      name: 'P8R1BC',
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

describe('The retention dry-run command on PostgreSQL', () => {
  it('P8R1BC1 the started command runtime prints the summary or the JSON alone, refuses with exit code 1, and changes nothing', async () => {
    // 30 captures: A1..A29 B30 (v2..v10 inside A's run, before the picker
    // window: 9 candidates), and a stale page: 30 A then B, its change not
    // stored (v1 its run's first, v2..v11 held back)
    const fine = await page([...Array(29).fill('A'), 'B']);
    const stale = await page([...Array(30).fill('A'), 'B'], true);
    const before = await rows();

    const connect = jest.spyOn(Connection, 'connect');
    const started = [
      jest.spyOn(WorkflowClient.prototype, 'start'),
      jest.spyOn(WorkflowClient.prototype, 'signalWithStart'),
      jest.spyOn(WorkflowClient.prototype, 'execute'),
    ];
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    moduleRef = await Test.createTestingModule({ imports: [CommandModule] })
      .overrideProvider(TEMPORAL_CONNECTION)
      .useValue(null)
      .compile();
    await moduleRef.init();

    // the summary
    const human = await run('--organization', ORG, '--older-than-days', '7');
    expect(human.exitCode).toBeUndefined();
    expect(human.stderr).toEqual([]);
    expect(human.stdout[0]).toBe(
      'Content Studio retention dry run: read only, nothing was changed or removed.'
    );
    expect(human.stdout).toEqual(
      expect.arrayContaining([
        `Organization: ${ORG}`,
        'Versions: 61 in total, 41 protected, 20 technically unprotected',
        'Technically unprotected: 1 kept by the policy (1 first or last of a run, 0 too recent), 9 candidates, 10 held back',
        'Blocked sources: 1',
        `  ${stale} PAGE_CHANGE_STATE_STALE (10 held back)`,
      ])
    );
    expect(human.stdout.find((l) => l.startsWith('Policy: '))).toMatch(
      /^Policy: compact_repeats, versions made before \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/
    );
    const hashLine = human.stdout.find((l) => l.startsWith('Dry run hash: '))!;
    expect(hashLine).toMatch(/^Dry run hash: [0-9a-f]{64}$/);
    expect(human.stdout.join('\n')).not.toMatch(/p8r1bc\.example|Page\b/);

    // the JSON, and nothing else on stdout
    const json = await run(
      '--organization',
      ORG,
      '--older-than-days',
      '7',
      '--json'
    );
    expect(json.exitCode).toBeUndefined();
    expect(json.stdout).toHaveLength(1);
    const report = JSON.parse(json.stdout[0]);
    expect(canonicalJson(report)).toBe(json.stdout[0]);
    expect(report.format).toBe(
      'content-studio.source-version-retention-dry-run'
    );
    expect(report.organizationId).toBe(ORG);
    expect(report.policy.mode).toBe('compact_repeats');
    // the time is the command's, in whole seconds; olderThan a week before it
    expect(report.evaluationNow).toMatch(/\.000Z$/);
    expect(
      new Date(report.evaluationNow).getTime() -
        new Date(report.policy.olderThan).getTime()
    ).toBe(7 * 24 * 60 * 60 * 1000);
    expect(
      new Date(report.validUntil).getTime() -
        new Date(report.evaluationNow).getTime()
    ).toBe(60 * 60 * 1000);
    expect(
      report.candidates.map(
        (c: { sourceId: string; versionNumber: number }) => [
          c.sourceId === fine,
          c.versionNumber,
        ]
      )
    ).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [true, n]));
    expect(report.blockedSources).toEqual([
      {
        sourceId: stale,
        blocker: 'PAGE_CHANGE_STATE_STALE',
        suppressedCandidates: 10,
      },
    ]);

    // an organization with nothing: a report and exit code 0
    const empty = await run(
      '--organization',
      EMPTY_ORG,
      '--older-than-days',
      '30',
      '--json'
    );
    expect(empty.exitCode).toBeUndefined();
    expect(JSON.parse(empty.stdout[0]).candidateSummary.candidateVersions).toBe(
      0
    );

    // refusals: exit code 1, a message on stderr, nothing on stdout
    for (const [args, message] of [
      [
        ['--older-than-days', '7'],
        'Retention dry run refused: --organization must be an organization id',
      ],
      [
        ['--organization', 'not-an-id', '--older-than-days', '7'],
        'Retention dry run refused: --organization must be an organization id',
      ],
      [
        ['--organization', ORG.toUpperCase(), '--older-than-days', '7'],
        'Retention dry run refused: --organization must be an organization id',
      ],
      ...['6', '0', '7.5', 'seven', '3651', '10000', ''].map((days) => [
        ['--organization', ORG, '--older-than-days', days],
        'Retention dry run refused: RETENTION_POLICY_INVALID (--older-than-days must be a whole number from 7 to 3650)',
      ]),
      [
        ['--organization', ORG],
        'Retention dry run refused: RETENTION_POLICY_INVALID (--older-than-days must be a whole number from 7 to 3650)',
      ],
      ...['all_unprotected', 'COMPACT_REPEATS', 'duplicate_only'].map(
        (mode) => [
          ['--organization', ORG, '--older-than-days', '7', '--mode', mode],
          'Retention dry run refused: RETENTION_POLICY_NOT_ENABLED (only compact_repeats is enabled)',
        ]
      ),
    ] as Array<[string[], string]>) {
      const refused = await run(...args, '--json');
      expect([args, refused]).toEqual([
        args,
        { stdout: [], stderr: [message], exitCode: 1 },
      ]);
    }
    // the mode by name works too
    expect(
      (
        await run(
          '--organization',
          ORG,
          '--older-than-days',
          '7',
          '--mode',
          'compact_repeats',
          '--json'
        )
      ).exitCode
    ).toBeUndefined();

    // too many versions for one snapshot: refused, nothing read after the
    // count
    const repository = moduleRef.get(ContentStudioSourceRetentionRepository);
    const original = repository.readSnapshot.bind(repository);
    const reads: string[] = [];
    const snapshot = jest
      .spyOn(repository, 'readSnapshot')
      .mockImplementation((work) =>
        original((real) =>
          work({
            ...real,
            countVersions: async () => {
              reads.push('count');
              return 1_000_001;
            },
            listSources: (input) => {
              reads.push('sources');
              return real.listSources(input);
            },
          })
        )
      );
    expect(
      await run('--organization', ORG, '--older-than-days', '7', '--json')
    ).toEqual({
      stdout: [],
      stderr: ['Retention dry run refused: RETENTION_DRY_RUN_SCALE_LIMIT'],
      exitCode: 1,
    });
    expect(reads).toEqual(['count']);
    snapshot.mockRestore();

    // no row changed by any of it
    expect(await rows()).toEqual(before);
    // no workflow, no eager Temporal connection, no Redis, no fetch
    expect(connect).not.toHaveBeenCalled();
    expect(ioRedis).not.toBeInstanceOf(Redis);
    for (const start of started) {
      expect(start).not.toHaveBeenCalled();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 120_000);

  it('P8R1QC1 P8-R1Q: while a version of the organization is held the command refuses with exit code 1 and no report; released, the same plan again', async () => {
    // the command runtime P8R1BC1 started, with its real providers
    expect(moduleRef).toBeDefined();
    const args = ['--organization', ORG, '--older-than-days', '7'];
    const first = await run(...args, '--json');
    expect(first.exitCode).toBeUndefined();
    const report = JSON.parse(first.stdout[0]);
    expect(report.candidates.length).toBe(9);
    const versions = await rows();

    // held through the internal service, as the next phase will
    const retention = moduleRef.get(ContentStudioSourceRetentionService);
    expect(
      await retention.quarantineSourceVersions({
        organizationId: ORG,
        sourceVersionIds: [report.candidates[0].id],
        planHash: report.dryRunHash,
        now: new Date(),
      })
    ).toEqual({ created: 1, alreadyPending: 0 });
    for (const json of [['--json'], []]) {
      expect(await run(...args, ...json)).toEqual({
        stdout: [],
        stderr: [
          'Retention dry run refused: RETENTION_DRY_RUN_QUARANTINE_ACTIVE',
        ],
        exitCode: 1,
      });
    }
    // another organization is not refused
    expect(
      (
        await run(
          '--organization',
          EMPTY_ORG,
          '--older-than-days',
          '7',
          '--json'
        )
      ).exitCode
    ).toBeUndefined();

    expect(
      await retention.releaseSourceVersionQuarantine({
        organizationId: ORG,
        planHash: report.dryRunHash,
      })
    ).toEqual({ released: 1 });
    const again = await run(...args, '--json');
    expect(again.exitCode).toBeUndefined();
    const after = JSON.parse(again.stdout[0]);
    // the same plan; only the command's own clock moved
    expect(after.candidates).toEqual(report.candidates);
    expect(after.blockedSources).toEqual(report.blockedSources);
    expect(after.candidateSummary).toEqual(report.candidateSummary);
    expect(await rows()).toEqual(versions);
  }, 60_000);

  it('P8R1CC1 P8-R1C: prepare, execute and cancel through the command runtime: their options, JSON alone on stdout, exit codes 0, 1 and 2, no content', async () => {
    expect(moduleRef).toBeDefined();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p8r1cc-'));
    const file = (name: string, text: string) => {
      const full = path.join(dir, name);
      fs.writeFileSync(full, text, { mode: 0o600 });
      return full;
    };
    try {
      const dryRun = await run(
        '--organization',
        ORG,
        '--older-than-days',
        '7',
        '--json'
      );
      // the stale page holds its candidates back: no execution runs it
      const blocked = file('blocked.json', dryRun.stdout[0]);
      expect(
        await command(
          'content-studio:retention-prepare',
          '--plan',
          blocked,
          '--organization',
          ORG,
          '--confirm',
          '--json'
        )
      ).toEqual({
        stdout: [],
        stderr: [
          'Retention prepare refused: RETENTION_EXECUTION_BLOCKED_SOURCES',
        ],
        exitCode: 1,
      });
      // without the stale page
      await client.contentStudioSourceVersion.deleteMany({
        where: { organizationId: ORG, source: { lastPageChangeAt: null } },
      });
      await client.contentStudioSource.deleteMany({
        where: { organizationId: ORG, lastPageChangeAt: null },
      });
      const plan = file(
        'plan.json',
        (await run('--organization', ORG, '--older-than-days', '7', '--json'))
          .stdout[0]
      );
      const reviewed = JSON.parse(fs.readFileSync(plan, 'utf8'));
      expect(reviewed.candidates).toHaveLength(9);
      const versions = (await rows()).versions.length;

      // refusals before anything is read or written: exit code 1
      const prepareRefusals: Array<[string[], string]> = [
        [
          ['--plan', plan, '--organization', ORG],
          'Retention prepare refused: RETENTION_EXECUTION_PLAN_INVALID (--confirm is required)',
        ],
        [
          ['--plan', plan, '--confirm'],
          'Retention prepare refused: --organization must be an organization id',
        ],
        [
          ['--organization', ORG, '--confirm'],
          'Retention prepare refused: RETENTION_EXECUTION_PLAN_INVALID (--plan is required)',
        ],
        [
          [
            '--plan',
            path.join(dir, 'missing.json'),
            '--organization',
            ORG,
            '--confirm',
          ],
          'Retention prepare refused: RETENTION_EXECUTION_PLAN_INVALID (the plan file cannot be read)',
        ],
        [
          ['--plan', dir, '--organization', ORG, '--confirm'],
          'Retention prepare refused: RETENTION_EXECUTION_PLAN_INVALID (not a plan file, or too large)',
        ],
        [
          [
            '--plan',
            file('broken.json', '{'),
            '--organization',
            ORG,
            '--confirm',
          ],
          'Retention prepare refused: RETENTION_EXECUTION_PLAN_INVALID',
        ],
        [
          ['--plan', plan, '--organization', EMPTY_ORG, '--confirm'],
          'Retention prepare refused: RETENTION_EXECUTION_PLAN_INVALID',
        ],
      ];
      for (const [args, message] of prepareRefusals) {
        expect([
          args,
          await command('content-studio:retention-prepare', ...args, '--json'),
        ]).toEqual([args, { stdout: [], stderr: [message], exitCode: 1 }]);
      }
      // a plan file larger than 64 MiB is refused before it is read
      const large = path.join(dir, 'large.json');
      fs.writeFileSync(large, '');
      fs.truncateSync(large, 64 * 1024 * 1024 + 1);
      expect(
        await command(
          'content-studio:retention-prepare',
          '--plan',
          large,
          '--organization',
          ORG,
          '--confirm',
          '--json'
        )
      ).toEqual({
        stdout: [],
        stderr: [
          'Retention prepare refused: RETENTION_EXECUTION_PLAN_INVALID (not a plan file, or too large)',
        ],
        exitCode: 1,
      });
      expect(
        await client.contentStudioSourceVersionRetentionExecution.count({
          where: { organizationId: ORG },
        })
      ).toBe(0);

      // prepared: exit code 0 and the report alone
      const prepared = await command(
        'content-studio:retention-prepare',
        '--plan',
        plan,
        '--organization',
        ORG,
        '--confirm',
        '--json'
      );
      expect(prepared.exitCode).toBe(0);
      expect(prepared.stderr).toEqual([]);
      expect(prepared.stdout).toHaveLength(1);
      const report = JSON.parse(prepared.stdout[0]);
      expect(canonicalJson(report)).toBe(prepared.stdout[0]);
      expect(report).toEqual(
        expect.objectContaining({
          outcome: 'prepared',
          status: 'prepared',
          planHash: reviewed.dryRunHash,
          plannedCount: 9,
        })
      );
      const id = report.executionId;

      // execute: both confirmations, an execution id; then not yet ready
      const executeRefusals: Array<[string[], string]> = [
        [
          ['--execution', id, '--backup-confirmed'],
          'Retention execute refused: RETENTION_EXECUTION_STATE_INVALID (--confirm is required)',
        ],
        [
          ['--execution', id, '--confirm'],
          'Retention execute refused: RETENTION_EXECUTION_STATE_INVALID (--backup-confirmed is required). This command does not create or verify your database backup.',
        ],
        [
          ['--execution', 'not-an-id', '--backup-confirmed', '--confirm'],
          'Retention execute refused: --execution must be an execution id',
        ],
        [
          ['--execution', randomUUID(), '--backup-confirmed', '--confirm'],
          'Retention execute refused: RETENTION_EXECUTION_STATE_INVALID',
        ],
      ];
      for (const [args, message] of executeRefusals) {
        expect([
          args,
          await command('content-studio:retention-execute', ...args, '--json'),
        ]).toEqual([args, { stdout: [], stderr: [message], exitCode: 1 }]);
      }
      const early = await command(
        'content-studio:retention-execute',
        '--execution',
        id,
        '--backup-confirmed',
        '--confirm',
        '--json'
      );
      expect(early.exitCode).toBe(1);
      expect(JSON.parse(early.stdout[0])).toEqual(
        expect.objectContaining({
          outcome: 'not_ready',
          errorCode: 'RETENTION_EXECUTION_NOT_READY',
        })
      );
      // the human output says what the backup flag is
      const humanEarly = await command(
        'content-studio:retention-execute',
        '--execution',
        id,
        '--backup-confirmed',
        '--confirm'
      );
      expect(humanEarly.stdout[0]).toBe(
        'Content Studio retention execute. This command does not create or verify your database backup. --backup-confirmed is your word that one was made.'
      );
      expect(humanEarly.stdout).toContain('Outcome: not_ready');

      // the wait, shortened in this test database only
      await client.contentStudioSourceVersionRetentionExecution.update({
        where: { id },
        data: { readyAt: new Date(Date.now() - 1000) },
      });
      const done = await command(
        'content-studio:retention-execute',
        '--execution',
        id,
        '--backup-confirmed',
        '--confirm',
        '--json'
      );
      expect(done.exitCode).toBe(0);
      expect(done.stderr).toEqual([]);
      expect(JSON.parse(done.stdout[0])).toEqual(
        expect.objectContaining({
          outcome: 'completed',
          deletedCount: 9,
          integrityCheck: 'passed',
        })
      );
      expect((await rows()).versions).toHaveLength(versions - 9);

      // cancel: confirmation, then an ended execution is refused; the plan
      // is never prepared again
      expect(
        await command('content-studio:retention-cancel', '--execution', id)
      ).toEqual({
        stdout: [],
        stderr: [
          'Retention cancel refused: RETENTION_EXECUTION_STATE_INVALID (--confirm is required)',
        ],
        exitCode: 1,
      });
      expect(
        await command(
          'content-studio:retention-cancel',
          '--execution',
          id,
          '--confirm',
          '--json'
        )
      ).toEqual({
        stdout: [],
        stderr: ['Retention cancel refused: RETENTION_EXECUTION_STATE_INVALID'],
        exitCode: 1,
      });
      expect(
        await command(
          'content-studio:retention-prepare',
          '--plan',
          plan,
          '--organization',
          ORG,
          '--confirm',
          '--json'
        )
      ).toEqual({
        stdout: [],
        stderr: ['Retention prepare refused: RETENTION_EXECUTION_ALREADY_RUN'],
        exitCode: 1,
      });

      // a new plan, prepared and cancelled: exit code 0, the human output
      const fresh = await page([...Array(29).fill('A'), 'B']);
      const second = file(
        'second.json',
        (await run('--organization', ORG, '--older-than-days', '7', '--json'))
          .stdout[0]
      );
      const humanPrepared = await command(
        'content-studio:retention-prepare',
        '--plan',
        second,
        '--organization',
        ORG,
        '--confirm'
      );
      expect(humanPrepared.exitCode).toBe(0);
      expect(humanPrepared.stdout[0]).toBe(
        'Content Studio retention prepare: prepare does not delete SourceVersions.'
      );
      expect(humanPrepared.stdout).toEqual(
        expect.arrayContaining([
          `Organization: ${ORG}`,
          'Candidates: 9 of 1 sources',
          'Outcome: prepared',
        ])
      );
      const secondId = (
        await client.contentStudioSourceVersionRetentionExecution.findFirstOrThrow(
          { where: { organizationId: ORG, status: 'prepared' } }
        )
      ).id;
      const cancelled = await command(
        'content-studio:retention-cancel',
        '--execution',
        secondId,
        '--confirm'
      );
      expect(cancelled.exitCode).toBe(0);
      expect(cancelled.stdout[0]).toBe(
        'Content Studio retention cancel: cancel does not delete SourceVersions.'
      );
      expect(cancelled.stdout).toEqual(
        expect.arrayContaining(['Outcome: cancelled', '  releasedCount: 9'])
      );
      expect(
        await client.contentStudioSourceVersion.count({
          where: { sourceId: fresh },
        })
      ).toBe(30);
      // ids, hashes, counts and times only: no URL, title or content
      for (const out of [prepared, done, humanPrepared, cancelled]) {
        expect(out.stdout.join('\n')).not.toMatch(
          /p8r1bc\.example|Page\b|"content"|"title"/
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
