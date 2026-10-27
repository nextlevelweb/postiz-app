import { Prisma } from '@prisma/client';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  assertContentStudioSourceVersionsExistAndNotPending,
  ContentStudioSourceRetentionRepository,
  ContentStudioSourceRetentionSnapshotReads,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention.repository';
import {
  ContentStudioSourceRetentionDryRunError,
  ContentStudioSourceRetentionIntegrityError,
  ContentStudioSourceVersionQuarantineError,
  ContentStudioSourceVersionRetentionPendingError,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';

// The read model of source version protection and the retention dry run
// (P8-R1B), with the Prisma delegates mocked: the one RepeatableRead
// transaction and its options, every read through it and nothing outside
// it, only reads, and a failing snapshot reported as one. Real snapshots are
// in content-studio.phase8-retention-dry-run.postgres.integration.spec.ts

const ORG = '11111111-1111-4111-8111-111111111111';

const delegate = () => ({
  count: jest.fn(async () => 0),
  findMany: jest.fn(async () => []),
  findFirst: jest.fn(async () => null),
  create: jest.fn(),
  createMany: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
  upsert: jest.fn(),
  delete: jest.fn(),
  deleteMany: jest.fn(),
});

const setup = (
  transaction?: (
    work: (tx: unknown) => Promise<unknown>,
    options: unknown
  ) => Promise<unknown>
) => {
  const tx = {
    contentStudioSource: delegate(),
    contentStudioSourceVersion: delegate(),
    contentPackage: delegate(),
    contentPackageRevision: delegate(),
    contentStudioReview: delegate(),
    contentStudioAIOperation: delegate(),
    contentStudioSourceVersionRetentionPending: delegate(),
  };
  // the client outside the transaction: never read inside it
  const outside = delegate();
  const pending = delegate();
  const $transaction = jest.fn(
    transaction ?? ((work: (t: unknown) => Promise<unknown>) => work(tx))
  );
  const repository = new ContentStudioSourceRetentionRepository(
    {
      model: { contentStudioSourceVersion: outside },
    } as unknown as PrismaRepository<'contentStudioSourceVersion'>,
    {
      model: { contentStudioSourceVersionRetentionPending: pending },
    } as unknown as PrismaRepository<'contentStudioSourceVersionRetentionPending'>,
    { model: { $transaction } } as unknown as PrismaTransaction
  );
  return { repository, tx, outside, pending, $transaction };
};

const everyRead = async (reads: ContentStudioSourceRetentionSnapshotReads) => {
  const page = { organizationId: ORG, afterId: null, take: 10 };
  await reads.findPending(ORG);
  await reads.listPending(ORG);
  await reads.countVersions(ORG);
  await reads.listSources(page);
  await reads.listPackageDrafts(page);
  await reads.listPackageReviews(page);
  await reads.listPackageRevisions(page);
  await reads.listOperationContexts(page);
  await reads.listVersionsOfSources({ organizationId: ORG, sourceIds: ['s'] });
  await reads.findVersionOfOtherOrganizationSource(ORG);
};

describe('ContentStudioSourceRetentionRepository (P8-R1B)', () => {
  it('RR1 one RepeatableRead transaction, waiting at most 5 seconds and lasting at most 2 minutes', async () => {
    const { repository, $transaction } = setup();
    expect(await repository.readSnapshot(async () => 'done')).toBe('done');
    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction.mock.calls[0][1]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout: 120_000,
    });
    expect(Prisma.TransactionIsolationLevel.RepeatableRead).toBe(
      'RepeatableRead'
    );
  });

  it('RR2 every read is through the transaction, of the organization, and only reads', async () => {
    const { repository, tx, outside } = setup();
    await repository.readSnapshot(everyRead);
    for (const [model, methods] of Object.entries(tx)) {
      for (const [method, mock] of Object.entries(methods)) {
        if (!['count', 'findMany', 'findFirst'].includes(method)) {
          expect([model, method, mock.mock.calls.length]).toEqual([
            model,
            method,
            0,
          ]);
        }
        for (const [args] of mock.mock.calls as unknown as Array<
          [{ where: { organizationId: string } }]
        >) {
          expect([model, args.where.organizationId]).toEqual([model, ORG]);
        }
      }
    }
    for (const mock of Object.values(outside)) {
      expect(mock).not.toHaveBeenCalled();
    }
    // the reads made: one each
    expect(
      Object.entries(tx).map(([model, d]) => [
        model,
        d.count.mock.calls.length +
          d.findMany.mock.calls.length +
          d.findFirst.mock.calls.length,
      ])
    ).toEqual([
      ['contentStudioSource', 1],
      ['contentStudioSourceVersion', 3],
      ['contentPackage', 1],
      ['contentPackageRevision', 1],
      ['contentStudioReview', 1],
      ['contentStudioAIOperation', 1],
      // P8-R1Q: whether any version of the organization is held; P8-R1C:
      // which, for which plan
      ['contentStudioSourceVersionRetentionPending', 2],
    ]);
    expect(
      tx.contentStudioSourceVersionRetentionPending.findFirst
    ).toHaveBeenCalledWith({
      where: { organizationId: ORG },
      select: { id: true },
    });
    expect(
      tx.contentStudioSourceVersionRetentionPending.findMany
    ).toHaveBeenCalledWith({
      where: { organizationId: ORG },
      select: { sourceVersionId: true, planHash: true },
    });
  });

  it('RR3 versions are read whole by a batch of sources, by source and number, never their blocks', async () => {
    const { repository, tx } = setup();
    await repository.readSnapshot((reads) =>
      reads.listVersionsOfSources({
        organizationId: ORG,
        sourceIds: ['a', 'b'],
      })
    );
    expect(tx.contentStudioSourceVersion.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, sourceId: { in: ['a', 'b'] } },
      orderBy: [{ sourceId: 'asc' }, { versionNumber: 'asc' }],
      select: {
        id: true,
        organizationId: true,
        sourceId: true,
        versionNumber: true,
        contentHash: true,
        title: true,
        extractionVersion: true,
        fetchedAt: true,
        createdAt: true,
      },
    });
  });

  it('RR4 a timeout or a lost connection is RETENTION_DRY_RUN_SNAPSHOT_FAILED; anything of the evaluation passes as it is', async () => {
    for (const err of [
      new Prisma.PrismaClientKnownRequestError(
        'Transaction already closed: A query cannot be executed on an expired transaction.',
        { code: 'P2028', clientVersion: '6.5.0' }
      ),
      new Prisma.PrismaClientKnownRequestError("Can't reach database server", {
        code: 'P1001',
        clientVersion: '6.5.0',
      }),
      new Prisma.PrismaClientUnknownRequestError('connection reset', {
        clientVersion: '6.5.0',
      }),
      new Prisma.PrismaClientInitializationError('no server', '6.5.0'),
    ]) {
      const { repository } = setup(async () => {
        throw err;
      });
      const thrown = await repository
        .readSnapshot(async () => 'never')
        .catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(ContentStudioSourceRetentionDryRunError);
      expect((thrown as ContentStudioSourceRetentionDryRunError).code).toBe(
        'RETENTION_DRY_RUN_SNAPSHOT_FAILED'
      );
      // never the database's own message
      expect((thrown as Error).message).not.toMatch(/P20|server|connection/);
    }
    const integrity = new ContentStudioSourceRetentionIntegrityError({
      type: 'ContentPackage',
      id: 'p',
    });
    const { repository } = setup();
    await expect(
      repository.readSnapshot(async () => {
        throw integrity;
      })
    ).rejects.toBe(integrity);
    const bug = new TypeError('x');
    await expect(
      repository.readSnapshot(async () => {
        throw bug;
      })
    ).rejects.toBe(bug);
  });

  it('RR5 after the snapshot: the blocks of the candidates of the organization, id and blocks only', async () => {
    const { repository, outside, $transaction } = setup();
    await repository.listVersionContents({ organizationId: ORG, ids: ['v'] });
    expect(outside.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, id: { in: ['v'] } },
      select: { id: true, content: true },
    });
    expect($transaction).not.toHaveBeenCalled();
    outside.findMany.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('gone', {
        code: 'P1017',
        clientVersion: '6.5.0',
      })
    );
    await expect(
      repository.listVersionContents({ organizationId: ORG, ids: ['v'] })
    ).rejects.toEqual(
      new ContentStudioSourceRetentionDryRunError(
        'RETENTION_DRY_RUN_SNAPSHOT_FAILED'
      )
    );
  });

  it('RR6 its methods: the snapshot, the measuring read and the quarantine (P8-R1Q), nothing else that writes', () => {
    expect(
      Object.getOwnPropertyNames(
        ContentStudioSourceRetentionRepository.prototype
      ).sort()
    ).toEqual([
      'constructor',
      'getPendingForVersion',
      'listPendingForPlan',
      'listVersionContents',
      'quarantineVersions',
      'readSnapshot',
      'releaseQuarantine',
    ]);
  });
});

const ORG_B = '22222222-2222-4222-8222-222222222222';
const PLAN_A = 'a'.repeat(64);
const PLAN_B = 'b'.repeat(64);
const V1 = '33333333-3333-4333-8333-333333333331';
const V2 = '33333333-3333-4333-8333-333333333332';
const NOW = new Date('2026-10-26T12:00:00.000Z');

const race = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('conflict', {
    code,
    clientVersion: '6.5.0',
  });

// The held versions of a fake transaction: the versions the organization
// has and the rows already held
const quarantineSetup = (input: {
  versions: string[];
  held?: { sourceVersionId: string; planHash: string }[];
}) => {
  const s = setup();
  const held = input.held ?? [];
  s.tx.contentStudioSourceVersion.findMany.mockImplementation((async (args: {
    where: { id: { in: string[] } };
  }) =>
    args.where.id.in
      .filter((id) => input.versions.includes(id))
      .map((id) => ({ id }))) as never);
  s.tx.contentStudioSourceVersionRetentionPending.findFirst.mockImplementation(
    (async (args: { where: { planHash: { not: string } } }) =>
      held.find((row) => row.planHash !== args.where.planHash.not)
        ? { id: 'other' }
        : null) as never
  );
  s.tx.contentStudioSourceVersionRetentionPending.findMany.mockImplementation(
    (async (args: { where: { sourceVersionId: { in: string[] } } }) =>
      held
        .filter((row) =>
          args.where.sourceVersionId.in.includes(row.sourceVersionId)
        )
        .map((row) => ({ sourceVersionId: row.sourceVersionId }))) as never
  );
  s.tx.contentStudioSourceVersionRetentionPending.createMany.mockImplementation(
    (async (args: { data: unknown[] }) => ({
      count: args.data.length,
    })) as never
  );
  return s;
};

const quarantine = (
  s: ReturnType<typeof setup>,
  sourceVersionIds: string[],
  planHash = PLAN_A
) =>
  s.repository.quarantineVersions({
    organizationId: ORG,
    sourceVersionIds,
    planHash,
    now: NOW,
  });

const writes = (s: ReturnType<typeof setup>) =>
  [s.tx, { outside: s.outside, pending: s.pending }].flatMap((models) =>
    Object.entries(models).flatMap(([model, d]) =>
      (
        [
          'create',
          'createMany',
          'update',
          'updateMany',
          'upsert',
          'delete',
          'deleteMany',
        ] as const
      )
        .filter((method) => d[method].mock.calls.length)
        .map((method) => `${model}.${method}`)
    )
  );

describe('ContentStudioSourceRetentionRepository: the writer check (P8-R1Q, P8-R1C)', () => {
  it('Q1/Q2/W1 every version still there and held for nothing: the check passes after ONE count of the organization', async () => {
    const { tx } = setup();
    tx.contentStudioSourceVersion.count.mockResolvedValue(2 as never);
    await expect(
      assertContentStudioSourceVersionsExistAndNotPending(tx as never, {
        organizationId: ORG,
        sourceVersionIds: [V1, V2],
      })
    ).resolves.toBeUndefined();
    expect(tx.contentStudioSourceVersion.count).toHaveBeenCalledTimes(1);
    expect(tx.contentStudioSourceVersion.count).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        id: { in: [V1, V2] },
        retentionPending: { is: null },
      },
    });
    // the one statement: no separate read of held rows or versions
    expect(
      tx.contentStudioSourceVersionRetentionPending.findFirst
    ).not.toHaveBeenCalled();
    expect(tx.contentStudioSourceVersion.findMany).not.toHaveBeenCalled();
  });

  it('Q3/W1 one held or gone among them (fewer counted than named) is refused, with the same fixed message', async () => {
    for (const available of [0, 1]) {
      const { tx } = setup();
      tx.contentStudioSourceVersion.count.mockResolvedValue(available as never);
      const thrown = await assertContentStudioSourceVersionsExistAndNotPending(
        tx as never,
        { organizationId: ORG, sourceVersionIds: [V1, V2] }
      ).catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(
        ContentStudioSourceVersionRetentionPendingError
      );
      expect((thrown as Error).message).toBe(
        'This source version is temporarily unavailable for new references'
      );
    }
  });

  it("Q4 only the organization's own versions are counted: another organization's is refused like a gone one", async () => {
    const { tx } = setup();
    tx.contentStudioSourceVersion.count.mockResolvedValue(1 as never);
    for (const organizationId of [ORG, ORG_B]) {
      await assertContentStudioSourceVersionsExistAndNotPending(tx as never, {
        organizationId,
        sourceVersionIds: [V1],
      });
    }
    expect(
      tx.contentStudioSourceVersion.count.mock.calls.map(
        (call) =>
          (call as unknown as [{ where: { organizationId: string } }])[0].where
            .organizationId
      )
    ).toEqual([ORG, ORG_B]);
  });

  it('Q5 many ids, repeated ones too: one count of each distinct id, against their number', async () => {
    const { tx } = setup();
    tx.contentStudioSourceVersion.count.mockResolvedValue(2 as never);
    await assertContentStudioSourceVersionsExistAndNotPending(tx as never, {
      organizationId: ORG,
      sourceVersionIds: [V2, V1, V2, V1],
    });
    expect(tx.contentStudioSourceVersion.count).toHaveBeenCalledTimes(1);
    expect(tx.contentStudioSourceVersion.count).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        id: { in: [V2, V1] },
        retentionPending: { is: null },
      },
    });
  });

  it('Q6 no version: no read at all', async () => {
    const { tx } = setup();
    await assertContentStudioSourceVersionsExistAndNotPending(tx as never, {
      organizationId: ORG,
      sourceVersionIds: [],
    });
    expect(tx.contentStudioSourceVersion.count).not.toHaveBeenCalled();
  });
});

describe('ContentStudioSourceRetentionRepository: holding versions (P8-R1Q)', () => {
  it('Q7/Q8 holds every version for the plan at now, in one serializable transaction: exists, no other plan, then created', async () => {
    const s = quarantineSetup({ versions: [V1, V2] });
    await expect(quarantine(s, [V1, V2])).resolves.toEqual({
      created: 2,
      alreadyPending: 0,
    });
    expect(s.$transaction).toHaveBeenCalledTimes(1);
    expect(s.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(s.tx.contentStudioSourceVersion.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, id: { in: [V1, V2] } },
      select: { id: true },
    });
    expect(
      s.tx.contentStudioSourceVersionRetentionPending.findFirst
    ).toHaveBeenCalledWith({
      where: { organizationId: ORG, planHash: { not: PLAN_A } },
      select: { id: true },
    });
    expect(
      s.tx.contentStudioSourceVersionRetentionPending.createMany
    ).toHaveBeenCalledWith({
      data: [
        {
          organizationId: ORG,
          sourceVersionId: V1,
          planHash: PLAN_A,
          pendingAt: NOW,
        },
        {
          organizationId: ORG,
          sourceVersionId: V2,
          planHash: PLAN_A,
          pendingAt: NOW,
        },
      ],
    });
    // never a version, never an update of a held row
    expect(writes(s)).toEqual([
      'contentStudioSourceVersionRetentionPending.createMany',
    ]);
  });

  it('Q9/Q10/Q114 the same plan again: held rows stay as they were (first pendingAt), only the others are held', async () => {
    const s = quarantineSetup({
      versions: [V1, V2],
      held: [{ sourceVersionId: V1, planHash: PLAN_A }],
    });
    await expect(quarantine(s, [V1, V2])).resolves.toEqual({
      created: 1,
      alreadyPending: 1,
    });
    expect(
      s.tx.contentStudioSourceVersionRetentionPending.createMany
    ).toHaveBeenCalledWith({
      data: [
        {
          organizationId: ORG,
          sourceVersionId: V2,
          planHash: PLAN_A,
          pendingAt: NOW,
        },
      ],
    });
    expect(writes(s)).toEqual([
      'contentStudioSourceVersionRetentionPending.createMany',
    ]);

    const again = quarantineSetup({
      versions: [V1],
      held: [{ sourceVersionId: V1, planHash: PLAN_A }],
    });
    await expect(quarantine(again, [V1])).resolves.toEqual({
      created: 0,
      alreadyPending: 1,
    });
  });

  it('Q11/Q115 a version, or any version of the organization, held for another plan: PLAN_CONFLICT and nothing is held', async () => {
    for (const versions of [[V1, V2], [V2]]) {
      const s = quarantineSetup({
        versions: [V1, V2],
        held: [{ sourceVersionId: V1, planHash: PLAN_B }],
      });
      const thrown = await quarantine(s, versions).catch((err: unknown) => err);
      expect(thrown).toEqual(
        new ContentStudioSourceVersionQuarantineError(
          'RETENTION_QUARANTINE_PLAN_CONFLICT'
        )
      );
      expect((thrown as Error).message).not.toContain(PLAN_B);
      expect(writes(s)).toEqual([]);
    }
  });

  it("Q12/Q13 a missing version or another organization's fails the whole batch: VERSION_NOT_FOUND, nothing held", async () => {
    // the read is of the organization: another organization's version is
    // not found, like a missing one
    const s = quarantineSetup({ versions: [V1] });
    await expect(quarantine(s, [V1, V2])).rejects.toEqual(
      new ContentStudioSourceVersionQuarantineError(
        'RETENTION_QUARANTINE_VERSION_NOT_FOUND'
      )
    );
    expect(writes(s)).toEqual([]);
    expect(
      s.tx.contentStudioSourceVersionRetentionPending.findFirst
    ).not.toHaveBeenCalled();
  });

  it('Q63 a concurrent plan (P2034) or the same key held meanwhile (P2002): run again from the start, at most 3 times, then CONFLICT', async () => {
    for (const code of ['P2034', 'P2002']) {
      const s = quarantineSetup({ versions: [V1] });
      let calls = 0;
      s.$transaction.mockImplementation((async (
        work: (tx: unknown) => Promise<unknown>
      ) => {
        calls++;
        if (calls < 3) {
          throw race(code);
        }
        return work(s.tx);
      }) as never);
      await expect(quarantine(s, [V1])).resolves.toEqual({
        created: 1,
        alreadyPending: 0,
      });
      expect(calls).toBe(3);

      const lost = setup(async () => {
        throw race(code);
      });
      await expect(quarantine(lost, [V1])).rejects.toEqual(
        new ContentStudioSourceVersionQuarantineError(
          'RETENTION_QUARANTINE_CONFLICT'
        )
      );
      expect(lost.$transaction).toHaveBeenCalledTimes(3);
    }
    // anything else at once, as it is
    const other = race('P2003');
    const s = setup(async () => {
      throw other;
    });
    await expect(quarantine(s, [V1])).rejects.toBe(other);
    expect(s.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('ContentStudioSourceRetentionRepository: releasing and reading held versions (P8-R1Q)', () => {
  it('Q15/Q18/Q19 releases these versions only of this organization and plan, and only held rows', async () => {
    const s = setup();
    s.pending.deleteMany.mockResolvedValueOnce({ count: 1 } as never);
    await expect(
      s.repository.releaseQuarantine({
        organizationId: ORG,
        planHash: PLAN_A,
        sourceVersionIds: [V1],
      })
    ).resolves.toEqual({ count: 1 });
    expect(s.pending.deleteMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        planHash: PLAN_A,
        sourceVersionId: { in: [V1] },
      },
    });
    expect(writes(s)).toEqual(['pending.deleteMany']);
  });

  it("Q16/Q17 all the plan's rows of the organization; none left is no error", async () => {
    const s = setup();
    s.pending.deleteMany.mockResolvedValueOnce({ count: 0 } as never);
    await expect(
      s.repository.releaseQuarantine({ organizationId: ORG, planHash: PLAN_A })
    ).resolves.toEqual({ count: 0 });
    expect(s.pending.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, planHash: PLAN_A },
    });
    expect(s.outside.delete).not.toHaveBeenCalled();
    expect(s.outside.deleteMany).not.toHaveBeenCalled();
  });

  it("Q119/Q120 a plan's held versions by version id with pendingAt; one version's by its key", async () => {
    const s = setup();
    const findUnique = jest.fn(async () => null);
    (s.pending as unknown as { findUnique: jest.Mock }).findUnique = findUnique;
    await s.repository.listPendingForPlan({
      organizationId: ORG,
      planHash: PLAN_A,
    });
    expect(s.pending.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, planHash: PLAN_A },
      orderBy: { sourceVersionId: 'asc' },
      select: { sourceVersionId: true, planHash: true, pendingAt: true },
    });
    await s.repository.getPendingForVersion({
      organizationId: ORG,
      sourceVersionId: V1,
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        sourceVersionId_organizationId: {
          sourceVersionId: V1,
          organizationId: ORG,
        },
      },
      select: { sourceVersionId: true, planHash: true, pendingAt: true },
    });
  });
});
