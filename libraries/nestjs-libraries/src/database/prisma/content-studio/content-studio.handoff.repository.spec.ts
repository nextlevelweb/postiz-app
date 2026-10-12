import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioHandoffRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.handoff.repository';

// No database: the Prisma delegate is mocked, so these tests pin the queries
// the repository sends, which is where the organization and user boundary is

const ORG = 'org-a';
const USER = 'user-1';
const ID = 'a'.repeat(64);
const AT = new Date('2026-10-12T10:00:00.000Z');

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
  const repository = new ContentStudioHandoffRepository({
    model: { contentStudioHandoff: handoff },
  } as unknown as PrismaRepository<'contentStudioHandoff'>);
  return { handoff, repository };
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
