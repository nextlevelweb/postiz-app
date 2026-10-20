import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioHandoffRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.handoff.repository';

// No database: the Prisma delegate is mocked, so these tests pin the queries
// the repository sends, which is where the organization and user boundary is

const ORG = 'org-a';
const USER = 'user-1';
const ID = 'a'.repeat(64);
const AT = new Date('2026-10-12T10:00:00.000Z');
const HASH = 'f'.repeat(64);

const setup = () => {
  const handoff = {
    create: jest.fn().mockResolvedValue({ id: ID, expiresAt: AT }),
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    upsert: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  // the transaction of an approved handoff (P5-07): its own delegates, and
  // every call in order
  const log: { call: string; args: Record<string, any> }[] = [];
  const tracked = (call: string, value: unknown) =>
    jest.fn(async (args: Record<string, any>) => {
      log.push({ call, args });
      return value;
    });
  const tx = {
    contentStudioReview: {
      findFirst: tracked('review.findFirst', {
        updatedAt: AT,
        targetContentHash: HASH,
      }),
      updateMany: tracked('review.updateMany', { count: 1 }),
    },
    contentStudioApproval: {
      count: tracked('approval.count', 3),
      // P5-08: the APPROVED decision the handoff keeps
      findFirst: tracked('approval.findFirst', {
        sequence: 3,
        targetContentHash: HASH,
      }),
    },
    contentStudioHandoff: {
      create: tracked('handoff.create', { id: ID, expiresAt: AT }),
    },
  };
  const transaction = {
    model: {
      $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) =>
        fn(tx)
      ),
    },
  };
  const repository = new ContentStudioHandoffRepository(
    {
      model: { contentStudioHandoff: handoff },
    } as unknown as PrismaRepository<'contentStudioHandoff'>,
    transaction as unknown as PrismaTransaction
  );
  return { handoff, repository, tx, transaction, log };
};
const APPROVED_HANDOFF = {
  id: ID,
  organizationId: ORG,
  userId: USER,
  packageId: 'package-1',
  packageRevisionId: 'revision-1',
  expiresAt: AT,
  reviewId: 'review-1',
  approvalVersion: 3,
};
const onlyCall = (fn: jest.Mock) => {
  expect(fn).toHaveBeenCalledTimes(1);
  return fn.mock.calls[0][0];
};

const callEveryMethod = async (repository: ContentStudioHandoffRepository) => {
  await repository.createHandoff({
    id: ID,
    organizationId: ORG,
    userId: USER,
    packageId: 'package-1',
    packageRevisionId: 'revision-1',
    expiresAt: AT,
  });
  await repository.getHandoffForOrganizationAndUser({
    organizationId: ORG,
    userId: USER,
    id: ID,
  });
  await repository.markOpenedIfNeeded({
    organizationId: ORG,
    userId: USER,
    id: ID,
    openedAt: AT,
  });
  await repository.revokeHandoff({
    organizationId: ORG,
    userId: USER,
    id: ID,
    revokedAt: AT,
  });
};

describe('ContentStudioHandoffRepository', () => {
  it('HR1 creates a handoff from explicit fields and returns only id and expiry', async () => {
    const { handoff, repository } = setup();

    await expect(
      repository.createHandoff({
        id: ID,
        organizationId: ORG,
        userId: USER,
        packageId: 'package-1',
        packageRevisionId: 'revision-1',
        expiresAt: AT,
        // not part of the input type: must not reach Prisma
        ...({ openedAt: AT, revokedAt: null } as object),
      })
    ).resolves.toEqual({ id: ID, expiresAt: AT });
    expect(onlyCall(handoff.create)).toEqual({
      data: {
        id: ID,
        organizationId: ORG,
        userId: USER,
        packageId: 'package-1',
        packageRevisionId: 'revision-1',
        expiresAt: AT,
        // HAS1 (P5-08): known not required, with no approval field at all
        approvalRequiredAtCreation: false,
        approvalReviewId: null,
        approvalSequence: null,
        approvalContentHash: null,
      },
      select: { id: true, expiresAt: true },
    });
  });

  it('HR2 reads a handoff by id, organization and user', async () => {
    const { handoff, repository } = setup();
    const row = { id: ID };
    handoff.findFirst.mockResolvedValue(row);

    await expect(
      repository.getHandoffForOrganizationAndUser({
        organizationId: ORG,
        userId: USER,
        id: ID,
      })
    ).resolves.toBe(row);
    expect(onlyCall(handoff.findFirst)).toEqual({
      where: { id: ID, organizationId: ORG, userId: USER },
      select: {
        id: true,
        packageId: true,
        packageRevisionId: true,
        expiresAt: true,
        openedAt: true,
        revokedAt: true,
        createdAt: true,
        // P5-08: what authorized it, as stored
        approvalRequiredAtCreation: true,
        approvalReviewId: true,
        approvalSequence: true,
        approvalContentHash: true,
      },
    });
  });

  it('HR3 answers null for a missing, foreign or other-user handoff after one query', async () => {
    const { handoff, repository } = setup();

    await expect(
      repository.getHandoffForOrganizationAndUser({
        organizationId: ORG,
        userId: USER,
        id: ID,
      })
    ).resolves.toBeNull();
    expect(handoff.findFirst).toHaveBeenCalledTimes(1);
    expect(handoff.findUnique).not.toHaveBeenCalled();
    expect(handoff.findMany).not.toHaveBeenCalled();
  });

  it('HR4 HR5 stamps openedAt only on a first open of a live handoff', async () => {
    const { handoff, repository } = setup();
    handoff.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      repository.markOpenedIfNeeded({
        organizationId: ORG,
        userId: USER,
        id: ID,
        openedAt: AT,
      })
    ).resolves.toEqual({ count: 0 });
    expect(onlyCall(handoff.updateMany)).toEqual({
      where: {
        id: ID,
        organizationId: ORG,
        userId: USER,
        openedAt: null,
        revokedAt: null,
      },
      data: { openedAt: AT },
    });
  });

  it('HR6 HR7 revokes only a handoff of the organization and user that is not revoked', async () => {
    const { handoff, repository } = setup();

    await expect(
      repository.revokeHandoff({
        organizationId: ORG,
        userId: USER,
        id: ID,
        revokedAt: AT,
      })
    ).resolves.toEqual({ count: 1 });
    expect(onlyCall(handoff.updateMany)).toEqual({
      where: { id: ID, organizationId: ORG, userId: USER, revokedAt: null },
      data: { revokedAt: AT },
    });
  });

  it('HR8 never deletes, upserts, updates by id or reads by id alone', async () => {
    const { handoff, repository } = setup();
    await callEveryMethod(repository);

    for (const method of [
      'findUnique',
      'findMany',
      'update',
      'upsert',
      'delete',
      'deleteMany',
    ] as const) {
      expect(handoff[method]).not.toHaveBeenCalled();
    }
    expect(
      Object.getOwnPropertyNames(ContentStudioHandoffRepository.prototype)
        .filter((name) => name !== 'constructor')
        .sort()
    ).toEqual([
      'createHandoff',
      'createHandoffWhileApproved',
      'getHandoffForOrganizationAndUser',
      'markOpenedIfNeeded',
      'revokeHandoff',
    ]);
  });

  it('HR9 HR10 scopes every query to the organization and the user', async () => {
    const { handoff, repository } = setup();
    await callEveryMethod(repository);

    const calls = Object.entries(handoff).flatMap(([method, fn]) =>
      fn.mock.calls.map(([args]) => ({ method, args }))
    );
    expect(calls).toHaveLength(4);
    for (const { method, args } of calls) {
      const scope = method === 'create' ? args.data : args.where;
      expect(scope).toMatchObject({
        id: ID,
        organizationId: ORG,
        userId: USER,
      });
    }
  });
});

describe('ContentStudioHandoffRepository: an approved handoff (P5-07)', () => {
  const REVIEW_WHERE = {
    id: 'review-1',
    organizationId: ORG,
    packageRevisionId: 'revision-1',
    state: 'READY_FOR_APPROVAL',
  };

  it('WR2/AT4/HAS2-HAS4 holds the review without changing it, confirms the history and its APPROVED decision, then creates the handoff with them, in one transaction', async () => {
    const { handoff, repository, transaction, log } = setup();
    await expect(
      repository.createHandoffWhileApproved(APPROVED_HANDOFF)
    ).resolves.toEqual({ id: ID, expiresAt: AT });
    expect(transaction.model.$transaction).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      {
        call: 'review.findFirst',
        args: {
          where: REVIEW_WHERE,
          select: { updatedAt: true, targetContentHash: true },
        },
      },
      {
        call: 'review.updateMany',
        // the hold writes back exactly the value it matched: nothing moves
        args: {
          where: { ...REVIEW_WHERE, updatedAt: AT },
          data: { updatedAt: AT },
        },
      },
      {
        call: 'approval.count',
        args: { where: { organizationId: ORG, reviewId: 'review-1' } },
      },
      {
        // the last decision of exactly the judged history: the APPROVED one
        // about this revision and the hash the held review binds
        call: 'approval.findFirst',
        args: {
          where: {
            organizationId: ORG,
            reviewId: 'review-1',
            sequence: 3,
            decision: 'APPROVED',
            packageRevisionId: 'revision-1',
            designRevisionId: null,
            targetContentHash: HASH,
          },
          select: { sequence: true, targetContentHash: true },
        },
      },
      {
        call: 'handoff.create',
        // what authorized it, read under the hold, written with the row
        args: {
          data: {
            id: ID,
            organizationId: ORG,
            userId: USER,
            packageId: 'package-1',
            packageRevisionId: 'revision-1',
            expiresAt: AT,
            approvalRequiredAtCreation: true,
            approvalReviewId: 'review-1',
            approvalSequence: 3,
            approvalContentHash: HASH,
          },
          select: { id: true, expiresAt: true },
        },
      },
    ]);
    // never the plain create outside the transaction
    expect(handoff.create).not.toHaveBeenCalled();
  });

  it('WR1/WR4 a review that is no longer ready for approval, or not this revision, writes nothing', async () => {
    const { repository, tx } = setup();
    tx.contentStudioReview.findFirst.mockResolvedValueOnce(null);
    await expect(
      repository.createHandoffWhileApproved(APPROVED_HANDOFF)
    ).resolves.toBeNull();
    expect(tx.contentStudioReview.updateMany).not.toHaveBeenCalled();
    expect(tx.contentStudioApproval.count).not.toHaveBeenCalled();
    expect(tx.contentStudioHandoff.create).not.toHaveBeenCalled();
  });

  it('WR1/WR4 a review that changed before it was held writes nothing', async () => {
    const { repository, tx } = setup();
    tx.contentStudioReview.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      repository.createHandoffWhileApproved(APPROVED_HANDOFF)
    ).resolves.toBeNull();
    expect(tx.contentStudioApproval.count).not.toHaveBeenCalled();
    expect(tx.contentStudioHandoff.create).not.toHaveBeenCalled();
  });

  it.each([[2], [4]])(
    'WR1/WR4/M11 a history of %p decisions instead of the 3 judged writes nothing',
    async (count) => {
      const { repository, tx } = setup();
      tx.contentStudioApproval.count.mockResolvedValueOnce(count);
      await expect(
        repository.createHandoffWhileApproved(APPROVED_HANDOFF)
      ).resolves.toBeNull();
      expect(tx.contentStudioHandoff.create).not.toHaveBeenCalled();
    }
  );

  it('HAS3/M8/M16 a last decision that is not the APPROVED one about this revision and hash writes nothing', async () => {
    const { repository, tx } = setup();
    tx.contentStudioApproval.findFirst.mockResolvedValueOnce(null);
    await expect(
      repository.createHandoffWhileApproved(APPROVED_HANDOFF)
    ).resolves.toBeNull();
    expect(tx.contentStudioHandoff.create).not.toHaveBeenCalled();
  });

  it('HAS5 nothing of the snapshot comes from the caller: extra input never reaches the row', async () => {
    const { repository, tx } = setup();
    await repository.createHandoffWhileApproved({
      ...APPROVED_HANDOFF,
      ...({
        approvalSequence: 1,
        approvalContentHash: 'e'.repeat(64),
        approvalRequiredAtCreation: false,
        approvalReviewId: 'review-forged',
      } as object),
    });
    expect(
      (tx.contentStudioHandoff.create as jest.Mock).mock.calls[0][0].data
    ).toMatchObject({
      approvalRequiredAtCreation: true,
      approvalReviewId: 'review-1',
      approvalSequence: 3,
      approvalContentHash: HASH,
    });
    const { repository: plain, handoff } = setup();
    await plain.createHandoff({
      id: ID,
      organizationId: ORG,
      userId: USER,
      packageId: 'package-1',
      packageRevisionId: 'revision-1',
      expiresAt: AT,
      ...({ approvalRequiredAtCreation: true, approvalSequence: 2 } as object),
    });
    expect(onlyCall(handoff.create).data).toMatchObject({
      approvalRequiredAtCreation: false,
      approvalSequence: null,
    });
  });

  it('HAS6/HAS7/M20 opening and revoking never write what authorized a handoff', async () => {
    const { handoff, repository } = setup();
    await callEveryMethod(repository);
    for (const [args] of handoff.updateMany.mock.calls) {
      expect(Object.keys(args.data).join()).not.toMatch(/approval/i);
    }
  });

  it('M13 every statement of the transaction names the organization', async () => {
    const { repository, log } = setup();
    await repository.createHandoffWhileApproved(APPROVED_HANDOFF);
    expect(log).toHaveLength(5);
    for (const { args } of log) {
      expect(args.where ?? args.data).toMatchObject({ organizationId: ORG });
    }
  });
});
