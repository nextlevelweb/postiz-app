import fs from 'fs';
import path from 'path';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioEditorialPolicyRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.repository';

// No database: the Prisma delegates are mocked. The transaction mock runs on
// a small in-memory copy of the rows, applies where clauses like Prisma
// (undefined is no condition), enforces the unique keys the schema declares
// and puts everything back when the callback throws, like a rollback. The
// real constraints come with the PostgreSQL integration suite

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const POLICY = '33333333-3333-4333-8333-333333333333';
const OTHER_POLICY = '44444444-4444-4444-8444-444444444444';
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
    policies: [] as Row[],
    revisions: [] as Row[],
  };
  const delegate = (table: 'policies' | 'revisions') => {
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
          table === 'policies' &&
          state.policies.some(
            (r) => r.organizationId === args.data.organizationId
          )
        ) {
          throw new UniqueConstraintError('organizationId');
        }
        if (
          table === 'revisions' &&
          state.revisions.some(
            (r) =>
              r.policyId === args.data.policyId &&
              r.revisionNumber === args.data.revisionNumber
          )
        ) {
          throw new UniqueConstraintError('policyId, revisionNumber');
        }
        const row = {
          createdAt: NOW,
          ...(table === 'policies' ? { updatedAt: NOW } : {}),
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
  const policy = delegate('policies');
  const revision = delegate('revisions');
  const tx = {
    contentStudioEditorialPolicy: policy,
    contentStudioEditorialPolicyRevision: revision,
  };
  const transaction = {
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => {
      const snapshot = JSON.parse(JSON.stringify(state));
      try {
        return await fn(tx);
      } catch (err) {
        state.policies = snapshot.policies;
        state.revisions = snapshot.revisions;
        throw err;
      }
    }),
  };
  const repository = new ContentStudioEditorialPolicyRepository(
    {
      model: { contentStudioEditorialPolicy: policy },
    } as unknown as PrismaRepository<'contentStudioEditorialPolicy'>,
    {
      model: { contentStudioEditorialPolicyRevision: revision },
    } as unknown as PrismaRepository<'contentStudioEditorialPolicyRevision'>,
    { model: transaction } as unknown as PrismaTransaction
  );
  return { repository, policy, revision, transaction, state };
};

const create = (
  repository: ContentStudioEditorialPolicyRepository,
  overrides: Partial<{ organizationId: string; policyId: string }> = {}
) =>
  repository.createPolicyWithFirstRevision({
    policyId: overrides.policyId ?? POLICY,
    revisionId: 'rev-1',
    organizationId: overrides.organizationId ?? ORG,
    createdById: USER,
    revision: stored('a'),
  });

const save = (
  repository: ContentStudioEditorialPolicyRepository,
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

describe('ContentStudioEditorialPolicyRepository: first save', () => {
  it('ER1-ER7 creates the policy and revision 1 in one transaction', async () => {
    const { repository, transaction, state } = setup();
    const result = await create(repository);

    expect(transaction.$transaction).toHaveBeenCalledTimes(1);
    expect(state.policies).toEqual([
      {
        id: POLICY,
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
        policyId: POLICY,
        revisionNumber: 1,
        createdById: USER,
        createdAt: NOW,
        ...stored('a'),
      },
    ]);
    expect(result).toEqual({
      policy: { id: POLICY, latestRevisionNumber: 1 },
      revision: {
        id: 'rev-1',
        revisionNumber: 1,
        schemaVersion: 1,
        contentHash: stored('a').contentHash,
        createdAt: NOW,
      },
    });
  });

  it('ER8 leaves no policy when its first revision cannot be written', async () => {
    const { repository, revision, state } = setup();
    revision.create.mockRejectedValueOnce(new Error('database down'));
    await expect(create(repository)).rejects.toThrow('database down');
    expect(state.policies).toEqual([]);
    expect(state.revisions).toEqual([]);
  });

  it('ER9 lets a second first save for the organization fail on its unique key, writing nothing', async () => {
    const { repository, state } = setup();
    await create(repository);
    const second = await create(repository, { policyId: OTHER_POLICY }).then(
      () => null,
      (err: unknown) => err
    );
    expect(second).toBeInstanceOf(UniqueConstraintError);
    expect((second as UniqueConstraintError).code).toBe('P2002');
    expect(state.policies).toHaveLength(1);
    expect(state.revisions).toHaveLength(1);
    // another organization has its own policy
    await create(repository, {
      organizationId: OTHER_ORG,
      policyId: OTHER_POLICY,
    });
    expect(state.policies).toHaveLength(2);
  });

  it('ER10/ER19 has no method to change content, rename, archive, delete or upsert', () => {
    expect(
      Object.getOwnPropertyNames(
        ContentStudioEditorialPolicyRepository.prototype
      ).sort()
    ).toEqual([
      'constructor',
      'countRevisionsForPolicy',
      'createPolicyWithFirstRevision',
      'createRevisionWithCompareAndSwap',
      'getPolicyForOrganization',
      'getRevisionByNumber',
      'getRevisionForPolicy',
      'listRevisionsForPolicy',
    ]);
  });
});

describe('ContentStudioEditorialPolicyRepository: revision compare-and-swap', () => {
  it('ER11 reads the policy of the organization only', async () => {
    const { repository, policy } = setup();
    expect(await repository.getPolicyForOrganization(ORG)).toBeNull();
    await create(repository);
    expect(await repository.getPolicyForOrganization(ORG)).toEqual({
      id: POLICY,
      latestRevisionNumber: 1,
    });
    expect(await repository.getPolicyForOrganization(OTHER_ORG)).toBeNull();
    expect(policy.findUnique.mock.calls.map(([args]) => args)).toEqual([
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

  it('ER16/ER17/ER18 numbers successive saves 2 and 3, one counter step each', async () => {
    const { repository, policy, revision, state } = setup();
    await create(repository);
    expect(await save(repository, 1, 'b')).toEqual({
      status: 'created',
      revision: expect.objectContaining({ revisionNumber: 2 }),
    });
    expect(state.policies[0].latestRevisionNumber).toBe(2);
    expect(await save(repository, 2, 'c')).toEqual({
      status: 'created',
      revision: expect.objectContaining({ revisionNumber: 3 }),
    });
    expect(state.policies[0].latestRevisionNumber).toBe(3);
    expect(state.revisions.map((r) => r.revisionNumber)).toEqual([1, 2, 3]);
    expect(policy.updateMany).toHaveBeenCalledTimes(2);
    expect(policy.updateMany.mock.calls[1][0]).toEqual({
      where: { id: POLICY, organizationId: ORG, latestRevisionNumber: 2 },
      data: { latestRevisionNumber: { increment: 1 } },
    });
    expect(revision.create.mock.calls[2][0].data).toEqual({
      id: 'rev-c',
      organizationId: ORG,
      policyId: POLICY,
      revisionNumber: 3,
      createdById: USER,
      ...stored('c'),
    });
    // the created answer carries no stored text
    expect(Object.keys(revision.create.mock.calls[2][0].select)).not.toContain(
      'content'
    );
  });

  it('ER12/ER13/ER15 refuses a stale base, even with the current content', async () => {
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
    expect(state.policies[0].latestRevisionNumber).toBe(2);
  });

  it('ER14 returns the current revision for unchanged content, without a new number', async () => {
    const { repository, revision, policy, state } = setup();
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
    expect(state.policies[0].latestRevisionNumber).toBe(1);
    expect(state.revisions).toHaveLength(1);
    expect(policy.updateMany).not.toHaveBeenCalled();
    expect(revision.findFirst.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      policyId: POLICY,
      revisionNumber: 1,
    });
  });

  it('answers not found when the organization has no policy, and never creates one', async () => {
    const { repository, state } = setup();
    expect(await save(repository, 1, 'b')).toEqual({ status: 'not-found' });
    await create(repository);
    expect(await save(repository, 1, 'b', OTHER_ORG)).toEqual({
      status: 'not-found',
    });
    expect(state.policies).toHaveLength(1);
    expect(state.revisions).toHaveLength(1);
  });

  it('lets only one of two writers advance the same base', async () => {
    const { repository, policy, state } = setup();
    await create(repository);
    // the other writer commits between this read and the update
    const realUpdate = policy.updateMany.getMockImplementation();
    policy.updateMany.mockImplementationOnce(async (args) => {
      state.policies[0].latestRevisionNumber = 2;
      state.revisions.push({ policyId: POLICY, revisionNumber: 2 });
      return (realUpdate as typeof policy.updateMany)(args);
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
    expect(state.policies[0].latestRevisionNumber).toBe(1);
    expect(state.revisions).toHaveLength(1);
  });
});

describe('ContentStudioEditorialPolicyRepository: history', () => {
  it('ER20/ER24/ER25 lists summaries of the policy of the organization, newest first, by page', async () => {
    const { repository, revision } = setup();
    await create(repository);
    await save(repository, 1, 'b');
    const list = await repository.listRevisionsForPolicy({
      organizationId: ORG,
      policyId: POLICY,
      skip: 20,
      take: 20,
    });
    expect(revision.findMany.mock.calls[0][0]).toEqual({
      where: { organizationId: ORG, policyId: POLICY },
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
    expect(await repository.countRevisionsForPolicy(ORG, POLICY)).toBe(2);
    expect(await repository.countRevisionsForPolicy(OTHER_ORG, POLICY)).toBe(0);
    expect(revision.count.mock.calls[1][0]).toEqual({
      where: { organizationId: OTHER_ORG, policyId: POLICY },
    });
  });

  it('ER21/ER22/ER23 reads a revision of the policy of the organization only', async () => {
    const { repository, revision } = setup();
    await create(repository);
    await save(repository, 1, 'b');
    await create(repository, {
      organizationId: OTHER_ORG,
      policyId: OTHER_POLICY,
    });

    expect(
      await repository.getRevisionForPolicy(ORG, POLICY, 'rev-b')
    ).toMatchObject({ revisionNumber: 2, content: stored('b').content });
    expect(
      await repository.getRevisionForPolicy(OTHER_ORG, POLICY, 'rev-b')
    ).toBeNull();
    expect(
      await repository.getRevisionForPolicy(ORG, OTHER_POLICY, 'rev-b')
    ).toBeNull();
    expect(
      revision.findFirst.mock.calls.slice(-3).map(([a]) => a.where)
    ).toEqual([
      { id: 'rev-b', policyId: POLICY, organizationId: ORG },
      { id: 'rev-b', policyId: POLICY, organizationId: OTHER_ORG },
      { id: 'rev-b', policyId: OTHER_POLICY, organizationId: ORG },
    ]);
    expect(await repository.getRevisionByNumber(ORG, POLICY, 2)).toMatchObject({
      id: 'rev-b',
    });
    expect(
      await repository.getRevisionByNumber(OTHER_ORG, POLICY, 2)
    ).toBeNull();
  });
});

describe('ContentStudioEditorialPolicyRepository source', () => {
  const text = read(
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.editorial-policy.repository.ts'
  ).replace(/^\s*\/\/.*$/gm, '');

  it('ER19 only ever creates revisions, changes only the revision counter and deletes nothing', () => {
    expect(text).not.toMatch(
      /contentStudioEditorialPolicyRevision\.(update|updateMany|upsert|delete|deleteMany)\(/
    );
    expect(text).not.toMatch(/\.delete(Many)?\(|\.upsert\(|\.update\(/);
    expect(
      text.match(/contentStudioEditorialPolicyRevision\.create\(/g)
    ).toHaveLength(2);
    const updates = text.match(/\.updateMany\(\{[\s\S]*?\n {6}\}\);/g) ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(
      /data: \{\s*latestRevisionNumber: \{\s*increment: 1,\s*\},\s*\}/
    );
  });

  it('reads no environment, provider SDK, AI service or logger', () => {
    expect(text).not.toMatch(
      /process\.env|from 'openai'|@anthropic-ai|@ai-sdk|ai\.execution|ai\.provider|console\.|Logger|\bfetch\(/
    );
  });

  it('is registered once in the database module', () => {
    const module = read(
      'libraries/nestjs-libraries/src/database/prisma/database.module.ts'
    );
    expect(
      module.match(/ContentStudioEditorialPolicyRepository\b/g)
    ).toHaveLength(2);
    expect(module.match(/ContentStudioEditorialPolicyService\b/g)).toHaveLength(
      2
    );
  });
});

describe('ContentStudioEditorialPolicy schema', () => {
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

  it('keeps the rules in the revisions only: no name, archive or content on the policy', () => {
    expect(fields('ContentStudioEditorialPolicy')).toEqual({
      id: 'String',
      organizationId: 'String',
      latestRevisionNumber: 'Int',
      createdById: 'String',
      createdAt: 'DateTime',
      updatedAt: 'DateTime',
      organization: 'Organization',
      createdBy: 'User',
      revisions: 'ContentStudioEditorialPolicyRevision[]',
    });
    expect(fields('ContentStudioEditorialPolicyRevision')).toEqual({
      id: 'String',
      organizationId: 'String',
      policyId: 'String',
      revisionNumber: 'Int',
      schemaVersion: 'Int',
      content: 'String',
      contentHash: 'String',
      createdById: 'String',
      createdAt: 'DateTime',
      organization: 'Organization',
      policy: 'ContentStudioEditorialPolicy',
      createdBy: 'User',
    });
  });

  it('allows one policy per organization and binds a revision to it, numbered once', () => {
    const policy = block('ContentStudioEditorialPolicy');
    expect(policy).toMatch(/\n\s*organizationId\s+String\s+@unique\n/);
    expect(policy).toMatch(/@@unique\(\[id, organizationId\]\)/);
    const revision = block('ContentStudioEditorialPolicyRevision');
    expect(revision).toMatch(
      /policy\s+ContentStudioEditorialPolicy\s+@relation\(fields: \[policyId, organizationId\], references: \[id, organizationId\]\)/
    );
    expect(revision).toMatch(/@@unique\(\[policyId, revisionNumber\]\)/);
    expect(revision).toMatch(/@@unique\(\[id, organizationId\]\)/);
    expect(block('Organization')).toMatch(
      /contentStudioEditorialPolicy\s+ContentStudioEditorialPolicy\?\n/
    );
    expect(block('Organization')).toMatch(
      /contentStudioEditorialPolicyRevisions\s+ContentStudioEditorialPolicyRevision\[\]\n/
    );
    expect(block('User')).toMatch(
      /contentStudioEditorialPolicies\s+ContentStudioEditorialPolicy\[\]\s+@relation\("ContentStudioEditorialPolicyCreatedBy"\)/
    );
    expect(block('User')).toMatch(
      /contentStudioEditorialPolicyRevisions\s+ContentStudioEditorialPolicyRevision\[\]\s+@relation\("ContentStudioEditorialPolicyRevisionCreatedBy"\)/
    );
  });
});
