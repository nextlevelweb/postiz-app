import { Prisma } from '@prisma/client';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  ContentStudioSourceRetentionRepository,
  ContentStudioSourceRetentionSnapshotReads,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention.repository';
import {
  ContentStudioSourceRetentionDryRunError,
  ContentStudioSourceRetentionIntegrityError,
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
  };
  // the client outside the transaction: never read inside it
  const outside = delegate();
  const $transaction = jest.fn(
    transaction ?? ((work: (t: unknown) => Promise<unknown>) => work(tx))
  );
  const repository = new ContentStudioSourceRetentionRepository(
    {
      model: { contentStudioSourceVersion: outside },
    } as unknown as PrismaRepository<'contentStudioSourceVersion'>,
    { model: { $transaction } } as unknown as PrismaTransaction
  );
  return { repository, tx, outside, $transaction };
};

const everyRead = async (reads: ContentStudioSourceRetentionSnapshotReads) => {
  const page = { organizationId: ORG, afterId: null, take: 10 };
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
    ]);
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

  it('RR6 its methods: the snapshot and the measuring read, nothing that writes', () => {
    expect(
      Object.getOwnPropertyNames(
        ContentStudioSourceRetentionRepository.prototype
      ).sort()
    ).toEqual(['constructor', 'listVersionContents', 'readSnapshot']);
  });
});
