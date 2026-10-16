import fs from 'fs';
import path from 'path';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioBrandKitRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.repository';

// Mirrors the editorial policy repository spec. No database: the Prisma
// delegates are mocked. The transaction mock runs on
// a small in-memory copy of the rows, applies where clauses like Prisma
// (undefined is no condition), enforces the unique keys the schema declares
// and puts everything back when the callback throws, like a rollback. The
// real constraints come with the PostgreSQL integration suite

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const BRAND_KIT = '33333333-3333-4333-8333-333333333333';
const OTHER_BRAND_KIT = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-14T10:00:00.000Z');
const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const read = (file: string) =>
  fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

const stored = (hash: string) => ({
  schemaVersion: 1,
  content: `{"canonical":"${hash}"}`,
  contentHash: hash.padEnd(64, '0'),
});

type Row = Record<string, unknown>;

class UniqueConstraintError extends Error {
  code = 'P2002';
}

const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(
    ([key, value]) => value === undefined || row[key] === value
  );

const pick = (row: Row, select?: Row) =>
  select
    ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]))
    : { ...row };

const setup = () => {
  const state = {
    kits: [] as Row[],
    revisions: [] as Row[],
  };
  const delegate = (table: 'kits' | 'revisions') => {
    const findFirst = jest.fn(async (args: { where: Row; select?: Row }) => {
      const row = state[table].find((r) => matches(r, args.where));
      return row ? pick(row, args.select) : null;
    });
    return {
      findFirst,
      findUnique: jest.fn(async (args: { where: Row; select?: Row }) =>
        findFirst(args)
      ),
      findMany: jest.fn(async (args: { where: Row; select?: Row }) =>
        state[table]
          .filter((r) => matches(r, args.where))
          .map((r) => pick(r, args.select))
      ),
      count: jest.fn(
        async (args: { where: Row }) =>
          state[table].filter((r) => matches(r, args.where)).length
      ),
      create: jest.fn(async (args: { data: Row; select?: Row }) => {
        if (
          table === 'kits' &&
          state.kits.some((r) => r.organizationId === args.data.organizationId)
        ) {
          throw new UniqueConstraintError('organizationId');
        }
        if (
          table === 'revisions' &&
          state.revisions.some(
            (r) =>
              r.brandKitId === args.data.brandKitId &&
              r.revisionNumber === args.data.revisionNumber
          )
        ) {
          throw new UniqueConstraintError('brandKitId, revisionNumber');
        }
        const row = {
          createdAt: NOW,
          ...(table === 'kits' ? { updatedAt: NOW } : {}),
          ...args.data,
        };
        state[table].push(row);
        return pick(row, args.select);
      }),
      updateMany: jest.fn(async (args: { where: Row; data: Row }) => {
        const rows = state[table].filter((r) => matches(r, args.where));
        for (const row of rows) {
          for (const [key, value] of Object.entries(args.data)) {
            row[key] =
              value &&
              typeof value === 'object' &&
              'increment' in (value as Row)
                ? (row[key] as number) + ((value as Row).increment as number)
                : value;
          }
        }
        return { count: rows.length };
      }),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    };
  };
  const brandKit = delegate('kits');
  const revision = delegate('revisions');
  const tx = {
    contentStudioBrandKit: brandKit,
    contentStudioBrandKitRevision: revision,
  };
  const transaction = {
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => {
      const snapshot = JSON.parse(JSON.stringify(state));
      try {
        return await fn(tx);
      } catch (err) {
        state.kits = snapshot.kits;
        state.revisions = snapshot.revisions;
        throw err;
      }
    }),
  };
  const repository = new ContentStudioBrandKitRepository(
    {
      model: { contentStudioBrandKit: brandKit },
    } as unknown as PrismaRepository<'contentStudioBrandKit'>,
    {
      model: { contentStudioBrandKitRevision: revision },
    } as unknown as PrismaRepository<'contentStudioBrandKitRevision'>,
    { model: transaction } as unknown as PrismaTransaction
  );
  return { repository, brandKit, revision, transaction, state };
};

const create = (
  repository: ContentStudioBrandKitRepository,
  overrides: Partial<{ organizationId: string; brandKitId: string }> = {}
) =>
  repository.createBrandKitWithFirstRevision({
    brandKitId: overrides.brandKitId ?? BRAND_KIT,
    revisionId: 'rev-1',
    organizationId: overrides.organizationId ?? ORG,
    createdById: USER,
    revision: stored('a'),
  });

const save = (
  repository: ContentStudioBrandKitRepository,
  expectedLatestRevisionNumber: number,
  hash: string,
  organizationId = ORG
) =>
  repository.createRevisionWithCompareAndSwap({
    organizationId,
    expectedLatestRevisionNumber,
    revisionId: `rev-${hash}`,
    revision: stored(hash),
    createdById: USER,
  });

describe('ContentStudioBrandKitRepository: first save', () => {
  it('BKR1/BKR3 creates the kit and revision 1 in one transaction', async () => {
    const { repository, transaction, state } = setup();
    const result = await create(repository);

    expect(transaction.$transaction).toHaveBeenCalledTimes(1);
    expect(state.kits).toEqual([
      {
        id: BRAND_KIT,
        organizationId: ORG,
        latestRevisionNumber: 1,
        createdById: USER,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    expect(state.revisions).toEqual([
      {
        id: 'rev-1',
        organizationId: ORG,
        brandKitId: BRAND_KIT,
        revisionNumber: 1,
        createdById: USER,
        createdAt: NOW,
        ...stored('a'),
      },
    ]);
    expect(result).toEqual({
      brandKit: { id: BRAND_KIT, latestRevisionNumber: 1 },
      revision: {
        id: 'rev-1',
        revisionNumber: 1,
        schemaVersion: 1,
        contentHash: stored('a').contentHash,
        createdAt: NOW,
      },
    });
  });

  it('BKR4 leaves no kit when its first revision cannot be written', async () => {
    const { repository, revision, state } = setup();
    revision.create.mockRejectedValueOnce(new Error('database down'));
    await expect(create(repository)).rejects.toThrow('database down');
    expect(state.kits).toEqual([]);
    expect(state.revisions).toEqual([]);
  });

  it('BKR5 lets a second first save for the organization fail on its unique key, writing nothing', async () => {
    const { repository, state } = setup();
    await create(repository);
    const second = await create(repository, {
      brandKitId: OTHER_BRAND_KIT,
    }).then(
      () => null,
      (err: unknown) => err
    );
    expect(second).toBeInstanceOf(UniqueConstraintError);
    expect((second as UniqueConstraintError).code).toBe('P2002');
    expect(state.kits).toHaveLength(1);
    expect(state.revisions).toHaveLength(1);
    // another organization has its own brandKit
    await create(repository, {
      organizationId: OTHER_ORG,
      brandKitId: OTHER_BRAND_KIT,
    });
    expect(state.kits).toHaveLength(2);
  });

  it('BKR17-BKR20 has no method to update or delete a revision, delete the kit, archive, restore or upsert', () => {
    expect(
      Object.getOwnPropertyNames(
        ContentStudioBrandKitRepository.prototype
      ).sort()
    ).toEqual([
      'constructor',
      'countRevisionsForBrandKit',
      'createBrandKitWithFirstRevision',
      'createRevisionWithCompareAndSwap',
      'getBrandKitForOrganization',
      'getRevisionByNumber',
      'getRevisionForBrandKit',
      'listRevisionsForBrandKit',
    ]);
  });
});

describe('ContentStudioBrandKitRepository: revision compare-and-swap', () => {
  it('BKR1/BKR2 reads the kit of the organization only', async () => {
    const { repository, brandKit } = setup();
    expect(await repository.getBrandKitForOrganization(ORG)).toBeNull();
    await create(repository);
    expect(await repository.getBrandKitForOrganization(ORG)).toEqual({
      id: BRAND_KIT,
      latestRevisionNumber: 1,
    });
    expect(await repository.getBrandKitForOrganization(OTHER_ORG)).toBeNull();
    expect(brandKit.findUnique.mock.calls.map(([args]) => args)).toEqual([
      {
        where: { organizationId: ORG },
        select: { id: true, latestRevisionNumber: true },
      },
      {
        where: { organizationId: ORG },
        select: { id: true, latestRevisionNumber: true },
      },
      {
        where: { organizationId: OTHER_ORG },
        select: { id: true, latestRevisionNumber: true },
      },
    ]);
  });

  it('BKR9/BKR13 numbers successive saves 2 and 3, one counter step each, on the organization and expected number', async () => {
    const { repository, brandKit, revision, state } = setup();
    await create(repository);
    expect(await save(repository, 1, 'b')).toEqual({
      status: 'created',
      revision: expect.objectContaining({ revisionNumber: 2 }),
    });
    expect(state.kits[0].latestRevisionNumber).toBe(2);
    expect(await save(repository, 2, 'c')).toEqual({
      status: 'created',
      revision: expect.objectContaining({ revisionNumber: 3 }),
    });
    expect(state.kits[0].latestRevisionNumber).toBe(3);
    expect(state.revisions.map((r) => r.revisionNumber)).toEqual([1, 2, 3]);
    expect(brandKit.updateMany).toHaveBeenCalledTimes(2);
    expect(brandKit.updateMany.mock.calls[1][0]).toEqual({
      where: { id: BRAND_KIT, organizationId: ORG, latestRevisionNumber: 2 },
      data: { latestRevisionNumber: { increment: 1 } },
    });
    expect(revision.create.mock.calls[2][0].data).toEqual({
      id: 'rev-c',
      organizationId: ORG,
      brandKitId: BRAND_KIT,
      revisionNumber: 3,
      createdById: USER,
      ...stored('c'),
    });
    // the created answer carries no stored text
    expect(Object.keys(revision.create.mock.calls[2][0].select)).not.toContain(
      'content'
    );
  });

  it('BKR10/BKR12 refuses a stale base, even with the current content', async () => {
    const { repository, state } = setup();
    await create(repository);
    await save(repository, 1, 'b');
    expect(await save(repository, 1, 'c')).toEqual({
      status: 'conflict',
      currentRevisionNumber: 2,
    });
    // same content as revision 2, but saved over revision 1
    expect(await save(repository, 1, 'b')).toEqual({
      status: 'conflict',
      currentRevisionNumber: 2,
    });
    expect(await save(repository, 3, 'b')).toEqual({
      status: 'conflict',
      currentRevisionNumber: 2,
    });
    expect(state.revisions).toHaveLength(2);
    expect(state.kits[0].latestRevisionNumber).toBe(2);
  });

  it('BKR8/BKR11 returns the current revision for unchanged content, without a new number', async () => {
    const { repository, revision, brandKit, state } = setup();
    await create(repository);
    expect(await save(repository, 1, 'a')).toEqual({
      status: 'unchanged',
      revision: {
        id: 'rev-1',
        revisionNumber: 1,
        schemaVersion: 1,
        contentHash: stored('a').contentHash,
        createdAt: NOW,
        content: stored('a').content,
      },
    });
    expect(state.kits[0].latestRevisionNumber).toBe(1);
    expect(state.revisions).toHaveLength(1);
    expect(brandKit.updateMany).not.toHaveBeenCalled();
    expect(revision.findFirst.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      brandKitId: BRAND_KIT,
      revisionNumber: 1,
    });
  });

  it('answers not found when the organization has no kit, and never creates one', async () => {
    const { repository, state } = setup();
    expect(await save(repository, 1, 'b')).toEqual({ status: 'not-found' });
    await create(repository);
    expect(await save(repository, 1, 'b', OTHER_ORG)).toEqual({
      status: 'not-found',
    });
    expect(state.kits).toHaveLength(1);
    expect(state.revisions).toHaveLength(1);
  });

  it('BKR14 lets only one of two writers advance the same base', async () => {
    const { repository, brandKit, state } = setup();
    await create(repository);
    // the other writer commits between this read and the update
    const realUpdate = brandKit.updateMany.getMockImplementation();
    brandKit.updateMany.mockImplementationOnce(async (args) => {
      state.kits[0].latestRevisionNumber = 2;
      state.revisions.push({ brandKitId: BRAND_KIT, revisionNumber: 2 });
      return (realUpdate as typeof brandKit.updateMany)(args);
    });
    expect(await save(repository, 1, 'b')).toEqual({ status: 'changed' });
    expect(state.revisions.filter((r) => r.revisionNumber === 2)).toHaveLength(
      1
    );
  });

  it('rolls the counter back when the revision cannot be written', async () => {
    const { repository, revision, state } = setup();
    await create(repository);
    revision.create.mockRejectedValueOnce(new Error('database down'));
    await expect(save(repository, 1, 'b')).rejects.toThrow('database down');
    expect(state.kits[0].latestRevisionNumber).toBe(1);
    expect(state.revisions).toHaveLength(1);
  });
});

describe('ContentStudioBrandKitRepository: history', () => {
  it('BKR15 lists summaries of the kit of the organization, newest first, by page', async () => {
    const { repository, revision } = setup();
    await create(repository);
    await save(repository, 1, 'b');
    const list = await repository.listRevisionsForBrandKit({
      organizationId: ORG,
      brandKitId: BRAND_KIT,
      skip: 20,
      take: 20,
    });
    expect(revision.findMany.mock.calls[0][0]).toEqual({
      where: { organizationId: ORG, brandKitId: BRAND_KIT },
      orderBy: { revisionNumber: 'desc' },
      select: {
        id: true,
        revisionNumber: true,
        schemaVersion: true,
        contentHash: true,
        createdAt: true,
      },
      skip: 20,
      take: 20,
    });
    expect(list.map((r) => Object.keys(r))).not.toContainEqual(
      expect.arrayContaining(['content'])
    );
    expect(await repository.countRevisionsForBrandKit(ORG, BRAND_KIT)).toBe(2);
    expect(
      await repository.countRevisionsForBrandKit(OTHER_ORG, BRAND_KIT)
    ).toBe(0);
    expect(revision.count.mock.calls[1][0]).toEqual({
      where: { organizationId: OTHER_ORG, brandKitId: BRAND_KIT },
    });
  });

  it('BKR16 reads a revision of the kit of the organization only', async () => {
    const { repository, revision } = setup();
    await create(repository);
    await save(repository, 1, 'b');
    await create(repository, {
      organizationId: OTHER_ORG,
      brandKitId: OTHER_BRAND_KIT,
    });

    expect(
      await repository.getRevisionForBrandKit(ORG, BRAND_KIT, 'rev-b')
    ).toMatchObject({ revisionNumber: 2, content: stored('b').content });
    expect(
      await repository.getRevisionForBrandKit(OTHER_ORG, BRAND_KIT, 'rev-b')
    ).toBeNull();
    expect(
      await repository.getRevisionForBrandKit(ORG, OTHER_BRAND_KIT, 'rev-b')
    ).toBeNull();
    expect(
      revision.findFirst.mock.calls.slice(-3).map(([a]) => a.where)
    ).toEqual([
      { id: 'rev-b', brandKitId: BRAND_KIT, organizationId: ORG },
      { id: 'rev-b', brandKitId: BRAND_KIT, organizationId: OTHER_ORG },
      { id: 'rev-b', brandKitId: OTHER_BRAND_KIT, organizationId: ORG },
    ]);
    expect(
      await repository.getRevisionByNumber(ORG, BRAND_KIT, 2)
    ).toMatchObject({
      id: 'rev-b',
    });
    expect(
      await repository.getRevisionByNumber(OTHER_ORG, BRAND_KIT, 2)
    ).toBeNull();
  });
});

describe('ContentStudioBrandKitRepository source', () => {
  const text = read(
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.brand-kit.repository.ts'
  ).replace(/^\s*\/\/.*$/gm, '');

  it('BKR17/BKR18/BKR19 only ever creates revisions, changes only the revision counter and deletes nothing', () => {
    expect(text).not.toMatch(
      /contentStudioBrandKitRevision\.(update|updateMany|upsert|delete|deleteMany)\(/
    );
    expect(text).not.toMatch(/\.delete(Many)?\(|\.upsert\(|\.update\(/);
    expect(text.match(/contentStudioBrandKitRevision\.create\(/g)).toHaveLength(
      2
    );
    const updates = text.match(/\.updateMany\(\{[\s\S]*?\n {6}\}\);/g) ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(
      /data: \{\s*latestRevisionNumber: \{\s*increment: 1,\s*\},\s*\}/
    );
  });

  it('reads no environment, provider SDK, AI service, Media, renderer or logger', () => {
    expect(text).not.toMatch(
      /process\.env|from 'openai'|@anthropic-ai|@ai-sdk|ai\.execution|ai\.provider|console\.|Logger|\bfetch\(|contentStudioMedia|\bmedia\b|sharp|fontkit|fabric/i
    );
  });

  it('is registered once in the database module', () => {
    const module = read(
      'libraries/nestjs-libraries/src/database/prisma/database.module.ts'
    );
    expect(module.match(/ContentStudioBrandKitRepository\b/g)).toHaveLength(2);
    expect(module.match(/ContentStudioBrandKitService\b/g)).toHaveLength(2);
  });
});

describe('ContentStudioBrandKit schema', () => {
  const schema = read(
    'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
  );
  const block = (name: string) => {
    const match = schema.match(
      new RegExp(`\\nmodel ${name} \\{([\\s\\S]*?)\\n\\}`)
    );
    if (!match) {
      throw new Error(`model ${name} not found`);
    }
    return match[1];
  };
  const fields = (name: string) =>
    Object.fromEntries(
      block(name)
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter(([field]) => field && !field.startsWith('@@'))
        .map(([field, type]) => [field, type])
    );

  it('BKR5 keeps the kit in the revisions only: no name, archive, content, Media or design field on the kit', () => {
    expect(fields('ContentStudioBrandKit')).toEqual({
      id: 'String',
      organizationId: 'String',
      latestRevisionNumber: 'Int',
      createdById: 'String',
      createdAt: 'DateTime',
      updatedAt: 'DateTime',
      organization: 'Organization',
      createdBy: 'User',
      revisions: 'ContentStudioBrandKitRevision[]',
    });
    expect(fields('ContentStudioBrandKitRevision')).toEqual({
      id: 'String',
      organizationId: 'String',
      brandKitId: 'String',
      revisionNumber: 'Int',
      schemaVersion: 'Int',
      content: 'String',
      contentHash: 'String',
      createdById: 'String',
      createdAt: 'DateTime',
      organization: 'Organization',
      brandKit: 'ContentStudioBrandKit',
      createdBy: 'User',
      // P4-05: the renders that used this exact revision point to it
      designRenders: 'ContentStudioDesignRender[]',
    });
  });

  it('BKR5/BKR6/BKR7 allows one kit per organization and binds a revision to it, numbered once', () => {
    const brandKit = block('ContentStudioBrandKit');
    expect(brandKit).toMatch(/\n\s*organizationId\s+String\s+@unique\n/);
    expect(brandKit).toMatch(/@@unique\(\[id, organizationId\]\)/);
    const revision = block('ContentStudioBrandKitRevision');
    expect(revision).toMatch(
      /brandKit\s+ContentStudioBrandKit\s+@relation\(fields: \[brandKitId, organizationId\], references: \[id, organizationId\]\)/
    );
    expect(revision).toMatch(/@@unique\(\[brandKitId, revisionNumber\]\)/);
    expect(revision).toMatch(/@@unique\(\[id, organizationId\]\)/);
    expect(block('Organization')).toMatch(
      /contentStudioBrandKit\s+ContentStudioBrandKit\?\n/
    );
    expect(block('Organization')).toMatch(
      /contentStudioBrandKitRevisions\s+ContentStudioBrandKitRevision\[\]\n/
    );
    expect(block('User')).toMatch(
      /contentStudioBrandKits\s+ContentStudioBrandKit\[\]\s+@relation\("ContentStudioBrandKitCreatedBy"\)/
    );
    expect(block('User')).toMatch(
      /contentStudioBrandKitRevisions\s+ContentStudioBrandKitRevision\[\]\s+@relation\("ContentStudioBrandKitRevisionCreatedBy"\)/
    );
  });
});
