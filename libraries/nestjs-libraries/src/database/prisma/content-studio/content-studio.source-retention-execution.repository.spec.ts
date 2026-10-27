import { Prisma } from '@prisma/client';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioSourceRetentionExecutionRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention-execution.repository';
import { ContentStudioSourceVersionRetentionExecutionError } from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';

// The retention execution's ledger and its one removal (P8-R1C), with the
// Prisma delegates mocked: the statements each method sends, in order, and
// that a count which is not the batch's stops the batch before anything
// after it. Real transactions are in
// content-studio.phase8-retention-execution.postgres.integration.spec.ts

const ORG = '11111111-1111-4111-8111-111111111111';
const EXECUTION = '22222222-2222-4222-8222-222222222222';
const PLAN = 'a'.repeat(64);
const SOURCE = '33333333-3333-4333-8333-333333333333';
const V = (n: number) => `44444444-4444-4444-8444-44444444444${n}`;
const NOW = new Date('2026-10-26T12:00:00.000Z');

const delegate = () => ({
  count: jest.fn(async () => 0),
  findMany: jest.fn(async () => [] as unknown[]),
  findFirst: jest.fn(async () => null as unknown),
  findUnique: jest.fn(async () => null as unknown),
  create: jest.fn(async () => ({ id: EXECUTION })),
  createMany: jest.fn(async () => ({ count: 0 })),
  update: jest.fn(),
  updateMany: jest.fn(async () => ({ count: 1 })),
  upsert: jest.fn(),
  delete: jest.fn(),
  deleteMany: jest.fn(async () => ({ count: 1 })),
});

const MODELS = [
  'contentStudioSourceVersionRetentionExecution',
  'contentStudioSourceVersionRetentionExecutionLock',
  'contentStudioSourceVersionRetentionExecutionItem',
  'contentStudioSourceVersionRetentionPending',
  'contentStudioSourceVersion',
  'contentStudioSource',
] as const;

const setup = () => {
  const tx = Object.fromEntries(MODELS.map((m) => [m, delegate()])) as Record<
    (typeof MODELS)[number],
    ReturnType<typeof delegate>
  >;
  const outside = Object.fromEntries(
    MODELS.map((m) => [m, delegate()])
  ) as typeof tx;
  // the work and the transaction's options, as Prisma takes them
  const $transaction = jest.fn<
    Promise<unknown>,
    [(t: unknown) => Promise<unknown>, unknown?]
  >(async (work) => work(tx));
  const repository = new ContentStudioSourceRetentionExecutionRepository(
    {
      model: outside,
    } as unknown as PrismaRepository<'contentStudioSourceVersionRetentionExecution'>,
    {
      model: outside,
    } as unknown as PrismaRepository<'contentStudioSourceVersionRetentionExecutionItem'>,
    {
      model: outside,
    } as unknown as PrismaRepository<'contentStudioSourceVersionRetentionExecutionLock'>,
    {
      model: outside,
    } as unknown as PrismaRepository<'contentStudioSourceVersionRetentionPending'>,
    {
      model: outside,
    } as unknown as PrismaRepository<'contentStudioSourceVersion'>,
    { model: { $transaction } } as unknown as PrismaTransaction
  );
  return { repository, tx, outside, $transaction };
};

// every call made in the transaction, as model.method, in order
const calls = (tx: ReturnType<typeof setup>['tx']) =>
  Object.entries(tx)
    .flatMap(([model, d]) =>
      Object.entries(d).flatMap(([method, fn]) =>
        fn.mock.invocationCallOrder.map((order) => ({
          order,
          call: `${model.replace(
            'contentStudioSourceVersionRetention',
            'retention'
          )}.${method}`,
        }))
      )
    )
    .sort((a, b) => a.order - b.order)
    .map(({ call }) => call);

const failed = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ContentStudioSourceVersionRetentionExecutionError);
  return {
    code: (err as ContentStudioSourceVersionRetentionExecutionError).code,
    detail: (err as ContentStudioSourceVersionRetentionExecutionError).detail,
  };
};

const taken = () =>
  new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: '6.5.0',
  });

const PLAN_INPUT = {
  organizationId: ORG,
  planHash: PLAN,
  policyMode: 'compact_repeats',
  policyOlderThan: new Date('2026-10-19T12:00:00.000Z'),
  planEvaluationNow: NOW,
  planValidUntil: new Date('2026-10-26T13:00:00.000Z'),
  dryRunFormatVersion: 1,
  protectionVersion: 1,
  policyVersion: 1,
  executionFormatVersion: 1,
  sourceCount: 1,
};
const item = (n: number) => ({
  sourceVersionId: V(n),
  sourceId: SOURCE,
  versionNumber: n,
  contentHash: String(n).repeat(64).slice(0, 64),
});

describe('ContentStudioSourceRetentionExecutionRepository: the ledger (P8-R1C)', () => {
  it('RX1 an execution with its lock and items, preparing, in one transaction of 30 seconds at most', async () => {
    const { repository, tx, $transaction } = setup();
    const items = Array.from({ length: 2_500 }, (_, i) => item(i + 2));
    await expect(
      repository.createExecution({ ...PLAN_INPUT, items })
    ).resolves.toEqual({ id: EXECUTION });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction.mock.calls[0][1]).toEqual({
      maxWait: 5_000,
      timeout: 30_000,
    });
    expect(calls(tx)).toEqual([
      'retentionExecution.create',
      'retentionExecutionLock.create',
      'retentionExecutionItem.createMany',
      'retentionExecutionItem.createMany',
      'retentionExecutionItem.createMany',
    ]);
    expect(
      tx.contentStudioSourceVersionRetentionExecution.create.mock.calls[0]
    ).toEqual([
      {
        data: {
          ...PLAN_INPUT,
          status: 'preparing',
          plannedCount: 2_500,
        },
        select: { id: true },
      },
    ]);
    expect(
      tx.contentStudioSourceVersionRetentionExecutionLock.create.mock.calls[0]
    ).toEqual([
      {
        data: { organizationId: ORG, executionId: EXECUTION },
        select: { id: true },
      },
    ]);
    const written = (
      tx.contentStudioSourceVersionRetentionExecutionItem.createMany.mock
        .calls as unknown as Array<[{ data: Array<Record<string, unknown>> }]>
    ).map(([args]) => args.data);
    expect(written.map((rows) => rows.length)).toEqual([1_000, 1_000, 500]);
    expect(written[0][0]).toEqual({
      organizationId: ORG,
      executionId: EXECUTION,
      ...item(2),
      status: 'planned',
    });
  });

  it('RX2 the plan prepared before is ALREADY_RUN; another execution of the organization ALREADY_ACTIVE; anything else as it is', async () => {
    const run = setup();
    run.tx.contentStudioSourceVersionRetentionExecution.create.mockRejectedValue(
      taken()
    );
    expect(
      await failed(
        run.repository.createExecution({ ...PLAN_INPUT, items: [item(2)] })
      )
    ).toEqual({ code: 'RETENTION_EXECUTION_ALREADY_RUN', detail: null });
    expect(
      run.tx.contentStudioSourceVersionRetentionExecutionLock.create
    ).not.toHaveBeenCalled();

    const active = setup();
    active.tx.contentStudioSourceVersionRetentionExecutionLock.create.mockRejectedValue(
      taken()
    );
    expect(
      await failed(
        active.repository.createExecution({ ...PLAN_INPUT, items: [item(2)] })
      )
    ).toEqual({ code: 'RETENTION_EXECUTION_ALREADY_ACTIVE', detail: null });
    expect(
      active.tx.contentStudioSourceVersionRetentionExecutionItem.createMany
    ).not.toHaveBeenCalled();

    const other = setup();
    const bug = new TypeError('x');
    other.tx.contentStudioSourceVersionRetentionExecution.create.mockRejectedValue(
      bug
    );
    await expect(
      other.repository.createExecution({ ...PLAN_INPUT, items: [item(2)] })
    ).rejects.toBe(bug);
  });

  it('RX3 statuses move by compare-and-swap: preparing to prepared, prepared to executing with the backup word and the host', async () => {
    const { repository, outside } = setup();
    await repository.markPrepared({
      id: EXECUTION,
      organizationId: ORG,
      quarantinedAt: NOW,
      readyAt: NOW,
    });
    await repository.startExecuting({
      id: EXECUTION,
      organizationId: ORG,
      now: NOW,
      hostname: 'host',
    });
    expect(
      outside.contentStudioSourceVersionRetentionExecution.updateMany.mock.calls
    ).toEqual([
      [
        {
          where: { id: EXECUTION, organizationId: ORG, status: 'preparing' },
          data: { status: 'prepared', quarantinedAt: NOW, readyAt: NOW },
        },
      ],
      [
        {
          where: { id: EXECUTION, organizationId: ORG, status: 'prepared' },
          data: {
            status: 'executing',
            backupConfirmedAt: NOW,
            executionStartedAt: NOW,
            hostname: 'host',
          },
        },
      ],
    ]);
  });

  it('RX4 an execution ends with its lock removed in one transaction, only from a status it has and as many removed as read; else nothing', async () => {
    const end = {
      id: EXECUTION,
      organizationId: ORG,
      from: ['executing' as const],
      deletedCount: 3,
      status: 'completed' as const,
      errorCode: null,
      integrityCheck: 'passed' as const,
      finishedAt: NOW,
    };
    const ok = setup();
    await expect(ok.repository.finishExecution(end)).resolves.toBe(true);
    expect(calls(ok.tx)).toEqual([
      'retentionExecution.updateMany',
      'retentionExecutionLock.deleteMany',
    ]);
    expect(
      ok.tx.contentStudioSourceVersionRetentionExecution.updateMany.mock
        .calls[0]
    ).toEqual([
      {
        where: {
          id: EXECUTION,
          organizationId: ORG,
          status: { in: ['executing'] },
          deletedCount: 3,
        },
        data: {
          status: 'completed',
          errorCode: null,
          integrityCheck: 'passed',
          finishedAt: NOW,
        },
      },
    ]);
    expect(
      ok.tx.contentStudioSourceVersionRetentionExecutionLock.deleteMany.mock
        .calls[0]
    ).toEqual([{ where: { organizationId: ORG, executionId: EXECUTION } }]);
    for (const [updated, unlocked] of [
      [0, 1],
      [1, 0],
    ]) {
      const moved = setup();
      moved.tx.contentStudioSourceVersionRetentionExecution.updateMany.mockResolvedValue(
        { count: updated }
      );
      moved.tx.contentStudioSourceVersionRetentionExecutionLock.deleteMany.mockResolvedValue(
        { count: unlocked }
      );
      await expect(moved.repository.finishExecution(end)).resolves.toBe(false);
    }
    const down = setup();
    const lost = new Prisma.PrismaClientUnknownRequestError('lost', {
      clientVersion: '6.5.0',
    });
    down.$transaction.mockRejectedValueOnce(lost);
    await expect(down.repository.finishExecution(end)).rejects.toBe(lost);
  });

  it('RX5 a source after its removal: the source, all its versions and how many of the ids are held, in one RepeatableRead snapshot', async () => {
    const { repository, tx, $transaction } = setup();
    await repository.readSource({
      organizationId: ORG,
      sourceId: SOURCE,
      sourceVersionIds: [V(2)],
    });
    expect($transaction.mock.calls[0][1]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout: 30_000,
    });
    expect(calls(tx)).toEqual([
      'contentStudioSource.findFirst',
      'contentStudioSourceVersion.findMany',
      'retentionPending.count',
    ]);
    expect(tx.contentStudioSourceVersion.findMany.mock.calls[0]).toEqual([
      expect.objectContaining({
        where: { organizationId: ORG, sourceId: SOURCE },
      }),
    ]);
    expect(
      JSON.stringify(tx.contentStudioSourceVersion.findMany.mock.calls[0])
    ).not.toMatch(/"content"|requestedUrl|finalUrl/);
  });

  it('RX6 what the database holds of some versions of an execution: deleted items, versions there, held rows of its plan', async () => {
    const { repository, outside } = setup();
    outside.contentStudioSourceVersionRetentionExecutionItem.count.mockResolvedValue(
      2
    );
    outside.contentStudioSourceVersion.count.mockResolvedValue(1);
    outside.contentStudioSourceVersionRetentionPending.count.mockResolvedValue(
      0
    );
    expect(
      await repository.countState({
        executionId: EXECUTION,
        organizationId: ORG,
        planHash: PLAN,
        sourceVersionIds: [V(2), V(3)],
      })
    ).toEqual({ deleted: 2, versions: 1, held: 0 });
    expect(
      outside.contentStudioSourceVersionRetentionExecutionItem.count.mock
        .calls[0]
    ).toEqual([
      {
        where: {
          executionId: EXECUTION,
          organizationId: ORG,
          sourceVersionId: { in: [V(2), V(3)] },
          status: 'deleted',
        },
      },
    ]);
    expect(
      outside.contentStudioSourceVersionRetentionPending.count.mock.calls[0]
    ).toEqual([
      {
        where: {
          organizationId: ORG,
          planHash: PLAN,
          sourceVersionId: { in: [V(2), V(3)] },
        },
      },
    ]);
  });

  it('RX7 its methods: nothing else writes', () => {
    expect(
      Object.getOwnPropertyNames(
        ContentStudioSourceRetentionExecutionRepository.prototype
      ).sort()
    ).toEqual([
      'constructor',
      'countOtherPlanPending',
      'countState',
      'createExecution',
      'deleteQuarantinedSourceVersionsForRetention',
      'finishExecution',
      'getActiveExecution',
      'getExecution',
      'listItems',
      'markPrepared',
      'readSource',
      'startExecuting',
    ]);
  });
});

describe('ContentStudioSourceRetentionExecutionRepository: the removal of a batch (P8-R1C)', () => {
  // a batch of v2 and v3 that holds together
  const ready = () => {
    const s = setup();
    s.tx.contentStudioSourceVersionRetentionExecution.findFirst.mockResolvedValue(
      { id: EXECUTION }
    );
    s.tx.contentStudioSourceVersionRetentionExecutionLock.findFirst.mockResolvedValue(
      { id: 'lock' }
    );
    s.tx.contentStudioSourceVersionRetentionExecutionItem.findMany.mockResolvedValue(
      [item(2), item(3)]
    );
    s.tx.contentStudioSourceVersionRetentionPending.count.mockResolvedValue(2);
    s.tx.contentStudioSourceVersion.findMany.mockResolvedValue([
      {
        id: V(2),
        sourceId: SOURCE,
        versionNumber: 2,
        contentHash: item(2).contentHash,
      },
      {
        id: V(3),
        sourceId: SOURCE,
        versionNumber: 3,
        contentHash: item(3).contentHash,
      },
    ]);
    s.tx.contentStudioSource.findMany.mockResolvedValue([
      { id: SOURCE, latestVersionNumber: 9 },
    ]);
    s.tx.contentStudioSourceVersionRetentionPending.deleteMany.mockResolvedValue(
      {
        count: 2,
      }
    );
    s.tx.contentStudioSourceVersion.deleteMany.mockResolvedValue({ count: 2 });
    s.tx.contentStudioSourceVersionRetentionExecutionItem.updateMany.mockResolvedValue(
      { count: 2 }
    );
    return s;
  };
  const input = {
    executionId: EXECUTION,
    organizationId: ORG,
    planHash: PLAN,
    batchNumber: 4,
    sourceVersionIds: [V(2), V(3)],
    deletedAt: NOW,
  };
  const ORDER = [
    'retentionExecution.findFirst',
    'retentionExecutionLock.findFirst',
    'retentionExecutionItem.findMany',
    'retentionPending.count',
    'contentStudioSourceVersion.findMany',
    'contentStudioSource.findMany',
    'retentionPending.deleteMany',
    'contentStudioSourceVersion.deleteMany',
    'retentionExecutionItem.updateMany',
    'retentionExecution.updateMany',
  ];

  it('RX8 the ten steps in order, in one ReadCommitted transaction of 30 seconds at most, each of the organization and batch', async () => {
    const s = ready();
    await expect(
      s.repository.deleteQuarantinedSourceVersionsForRetention(input)
    ).resolves.toEqual({ deleted: 2 });
    expect(calls(s.tx)).toEqual(ORDER);
    expect(s.$transaction.mock.calls[0][1]).toEqual({
      maxWait: 5_000,
      timeout: 30_000,
    });
    const ids = { in: [V(2), V(3)] };
    const only = (d: { mock: { calls: unknown[][] } }) => d.mock.calls[0][0];
    expect(
      only(s.tx.contentStudioSourceVersionRetentionExecution.findFirst)
    ).toEqual({
      where: { id: EXECUTION, organizationId: ORG, status: 'executing' },
      select: { id: true },
    });
    expect(
      only(s.tx.contentStudioSourceVersionRetentionExecutionLock.findFirst)
    ).toEqual({
      where: { organizationId: ORG, executionId: EXECUTION },
      select: { id: true },
    });
    expect(
      only(s.tx.contentStudioSourceVersionRetentionExecutionItem.findMany)
    ).toEqual(
      expect.objectContaining({
        where: {
          executionId: EXECUTION,
          organizationId: ORG,
          sourceVersionId: ids,
          status: 'planned',
        },
      })
    );
    expect(only(s.tx.contentStudioSourceVersionRetentionPending.count)).toEqual(
      {
        where: { organizationId: ORG, planHash: PLAN, sourceVersionId: ids },
      }
    );
    expect(only(s.tx.contentStudioSourceVersion.findMany)).toEqual({
      where: { organizationId: ORG, id: ids },
      select: {
        id: true,
        sourceId: true,
        versionNumber: true,
        contentHash: true,
      },
    });
    expect(only(s.tx.contentStudioSource.findMany)).toEqual({
      where: { organizationId: ORG, id: { in: [SOURCE] } },
      select: { id: true, latestVersionNumber: true },
    });
    expect(
      only(s.tx.contentStudioSourceVersionRetentionPending.deleteMany)
    ).toEqual({
      where: { organizationId: ORG, planHash: PLAN, sourceVersionId: ids },
    });
    expect(only(s.tx.contentStudioSourceVersion.deleteMany)).toEqual({
      where: { organizationId: ORG, id: ids },
    });
    expect(
      only(s.tx.contentStudioSourceVersionRetentionExecutionItem.updateMany)
    ).toEqual({
      where: {
        executionId: EXECUTION,
        organizationId: ORG,
        sourceVersionId: ids,
        status: 'planned',
      },
      data: { status: 'deleted', batchNumber: 4, deletedAt: NOW },
    });
    expect(
      only(s.tx.contentStudioSourceVersionRetentionExecution.updateMany)
    ).toEqual({
      where: { id: EXECUTION, organizationId: ORG, status: 'executing' },
      data: { deletedCount: { increment: 2 }, batchCount: { increment: 1 } },
    });
    // nothing outside the transaction
    expect($outsideCalls(s)).toEqual([]);
  });

  const $outsideCalls = (s: ReturnType<typeof setup>) => calls(s.outside);

  // each check that does not hold stops the batch where it is: nothing of
  // what comes after it is sent
  const breaks: Array<
    [string, (s: ReturnType<typeof setup>) => void, string, number]
  > = [
    [
      'not executing',
      (s) =>
        s.tx.contentStudioSourceVersionRetentionExecution.findFirst.mockResolvedValue(
          null
        ),
      'NOT_EXECUTING',
      2,
    ],
    [
      'no lock',
      (s) =>
        s.tx.contentStudioSourceVersionRetentionExecutionLock.findFirst.mockResolvedValue(
          null
        ),
      'NOT_EXECUTING',
      2,
    ],
    [
      'an item not planned',
      (s) =>
        s.tx.contentStudioSourceVersionRetentionExecutionItem.findMany.mockResolvedValue(
          [item(2)]
        ),
      'ITEMS_CHANGED',
      3,
    ],
    [
      'one not held',
      (s) =>
        s.tx.contentStudioSourceVersionRetentionPending.count.mockResolvedValue(
          1
        ),
      'NOT_HELD',
      4,
    ],
    [
      'one gone',
      (s) =>
        s.tx.contentStudioSourceVersion.findMany.mockResolvedValue([
          {
            id: V(2),
            sourceId: SOURCE,
            versionNumber: 2,
            contentHash: item(2).contentHash,
          },
        ]),
      'VERSION_CHANGED',
      5,
    ],
    [
      'another blocks hash',
      (s) =>
        s.tx.contentStudioSourceVersion.findMany.mockResolvedValue([
          {
            id: V(2),
            sourceId: SOURCE,
            versionNumber: 2,
            contentHash: 'f'.repeat(64),
          },
          {
            id: V(3),
            sourceId: SOURCE,
            versionNumber: 3,
            contentHash: item(3).contentHash,
          },
        ]),
      'VERSION_CHANGED',
      5,
    ],
    [
      'another number',
      (s) =>
        s.tx.contentStudioSourceVersion.findMany.mockResolvedValue([
          {
            id: V(2),
            sourceId: SOURCE,
            versionNumber: 7,
            contentHash: item(2).contentHash,
          },
          {
            id: V(3),
            sourceId: SOURCE,
            versionNumber: 3,
            contentHash: item(3).contentHash,
          },
        ]),
      'VERSION_CHANGED',
      5,
    ],
    [
      'another source',
      (s) =>
        s.tx.contentStudioSourceVersion.findMany.mockResolvedValue([
          {
            id: V(2),
            sourceId: 'other',
            versionNumber: 2,
            contentHash: item(2).contentHash,
          },
          {
            id: V(3),
            sourceId: SOURCE,
            versionNumber: 3,
            contentHash: item(3).contentHash,
          },
        ]),
      'VERSION_CHANGED',
      5,
    ],
    [
      'the latest',
      (s) =>
        s.tx.contentStudioSource.findMany.mockResolvedValue([
          { id: SOURCE, latestVersionNumber: 3 },
        ]),
      'LATEST',
      6,
    ],
    [
      'no source',
      (s) => s.tx.contentStudioSource.findMany.mockResolvedValue([]),
      'LATEST',
      6,
    ],
    [
      'held rows released meanwhile',
      (s) =>
        s.tx.contentStudioSourceVersionRetentionPending.deleteMany.mockResolvedValue(
          { count: 1 }
        ),
      'NOT_HELD',
      7,
    ],
    [
      'a version removed meanwhile',
      (s) =>
        s.tx.contentStudioSourceVersion.deleteMany.mockResolvedValue({
          count: 1,
        }),
      'VERSION_CHANGED',
      8,
    ],
    [
      'an item marked meanwhile',
      (s) =>
        s.tx.contentStudioSourceVersionRetentionExecutionItem.updateMany.mockResolvedValue(
          { count: 1 }
        ),
      'ITEMS_CHANGED',
      9,
    ],
    [
      'no longer executing',
      (s) =>
        s.tx.contentStudioSourceVersionRetentionExecution.updateMany.mockResolvedValue(
          { count: 0 }
        ),
      'NOT_EXECUTING',
      10,
    ],
  ];
  for (const [name, change, detail, steps] of breaks) {
    it(`RX9 ${name}: BATCH_FAILED ${detail}, nothing after it`, async () => {
      const s = ready();
      change(s);
      expect(
        await failed(
          s.repository.deleteQuarantinedSourceVersionsForRetention(input)
        )
      ).toEqual({ code: 'RETENTION_EXECUTION_BATCH_FAILED', detail });
      expect(calls(s.tx)).toEqual(ORDER.slice(0, steps));
    });
  }

  it('RX10 an empty batch, or an id twice, is refused before any transaction', async () => {
    for (const sourceVersionIds of [[], [V(2), V(2)]]) {
      const s = ready();
      expect(() =>
        s.repository.deleteQuarantinedSourceVersionsForRetention({
          ...input,
          sourceVersionIds,
        })
      ).toThrow(ContentStudioSourceVersionRetentionExecutionError);
      expect(s.$transaction).not.toHaveBeenCalled();
    }
  });
});
