import fs from 'fs';
import path from 'path';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioWritingProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.writing-profile.repository';

// No database: the Prisma delegates are mocked. The transaction mock runs on
// a small in-memory copy of the rows, applies where clauses like Prisma
// (undefined is no condition) and puts everything back when the callback
// throws, like a rollback. The real constraints come with the PostgreSQL
// integration suite

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const PROFILE = '33333333-3333-4333-8333-333333333333';
const OTHER_PROFILE = '44444444-4444-4444-8444-444444444444';
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

const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([key, value]) => {
    if (value === undefined) {
      return true;
    }
    if (value && typeof value === 'object' && 'not' in (value as Row)) {
      return row[key] !== (value as Row).not;
    }
    return row[key] === value;
  });

const pick = (row: Row, select?: Row) =>
  select
    ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]))
    : { ...row };

const setup = () => {
  const state = {
    profiles: [] as Row[],
    revisions: [] as Row[],
  };
  const delegate = (table: 'profiles' | 'revisions') => ({
    findFirst: jest.fn(async (args: { where: Row; select?: Row }) => {
      const row = state[table].find((r) => matches(r, args.where));
      return row ? pick(row, args.select) : null;
    }),
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
        table === 'revisions' &&
        state.revisions.some(
          (r) =>
            r.profileId === args.data.profileId &&
            r.revisionNumber === args.data.revisionNumber
        )
      ) {
        throw new Error('Unique constraint failed (profileId, revisionNumber)');
      }
      const row = {
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
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
            value && typeof value === 'object' && 'increment' in (value as Row)
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
  });
  const profile = delegate('profiles');
  const revision = delegate('revisions');
  const tx = {
    contentStudioWritingProfile: profile,
    contentStudioWritingProfileRevision: revision,
  };
  const transaction = {
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => {
      const snapshot = JSON.parse(JSON.stringify(state));
      try {
        return await fn(tx);
      } catch (err) {
        state.profiles = snapshot.profiles;
        state.revisions = snapshot.revisions;
        throw err;
      }
    }),
  };
  const repository = new ContentStudioWritingProfileRepository(
    {
      model: { contentStudioWritingProfile: profile },
    } as unknown as PrismaRepository<'contentStudioWritingProfile'>,
    {
      model: { contentStudioWritingProfileRevision: revision },
    } as unknown as PrismaRepository<'contentStudioWritingProfileRevision'>,
    { model: transaction } as unknown as PrismaTransaction
  );
  return { repository, profile, revision, transaction, state };
};

const create = (
  repository: ContentStudioWritingProfileRepository,
  overrides: Partial<{ organizationId: string; profileId: string }> = {}
) =>
  repository.createProfileWithFirstRevision({
    profileId: overrides.profileId ?? PROFILE,
    revisionId: 'rev-1',
    organizationId: overrides.organizationId ?? ORG,
    name: 'Brand voice',
    createdById: USER,
    revision: stored('a'),
  });

const save = (
  repository: ContentStudioWritingProfileRepository,
  expectedLatestRevisionNumber: number,
  hash: string,
  overrides: Partial<{ organizationId: string; profileId: string }> = {}
) =>
  repository.createRevisionWithCompareAndSwap({
    organizationId: overrides.organizationId ?? ORG,
    profileId: overrides.profileId ?? PROFILE,
    expectedLatestRevisionNumber,
    revisionId: `rev-${hash}`,
    revision: stored(hash),
    createdById: USER,
  });

describe('ContentStudioWritingProfileRepository: create', () => {
  it('WR1-WR7/WR9 creates the profile and revision 1 in one transaction', async () => {
    const { repository, transaction, state } = setup();
    const result = await create(repository);

    expect(transaction.$transaction).toHaveBeenCalledTimes(1);
    expect(state.profiles).toEqual([
      expect.objectContaining({
        id: PROFILE,
        organizationId: ORG,
        name: 'Brand voice',
        latestRevisionNumber: 1,
        createdById: USER,
      }),
    ]);
    expect(Object.keys(state.profiles[0])).not.toEqual(
      expect.arrayContaining(['content'])
    );
    expect(Object.keys(state.profiles[0])).not.toContain('contentHash');
    expect(state.revisions).toEqual([
      expect.objectContaining({
        id: 'rev-1',
        organizationId: ORG,
        profileId: PROFILE,
        revisionNumber: 1,
        createdById: USER,
        ...stored('a'),
      }),
    ]);
    expect(result.profile).toEqual({
      id: PROFILE,
      name: 'Brand voice',
      latestRevisionNumber: 1,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    // the creation answer carries no stored text
    expect(Object.keys(result.revision)).not.toContain('content');
  });

  it('WR8 leaves no profile when its first revision cannot be written', async () => {
    const { repository, revision, state } = setup();
    revision.create.mockRejectedValueOnce(new Error('database down'));
    await expect(create(repository)).rejects.toThrow('database down');
    expect(state.profiles).toEqual([]);
    expect(state.revisions).toEqual([]);
  });

  it('WR10 has no method to change or remove a revision, nor a generic one', () => {
    expect(
      Object.getOwnPropertyNames(
        ContentStudioWritingProfileRepository.prototype
      ).sort()
    ).toEqual([
      'archiveProfile',
      'constructor',
      'countProfilesForOrganization',
      'countRevisionsForProfile',
      'createProfileWithFirstRevision',
      'createRevisionWithCompareAndSwap',
      'getProfileForOrganization',
      'getRevisionByNumber',
      'getRevisionForProfile',
      'listProfilesForOrganization',
      'listRevisionsForProfile',
      'restoreProfile',
      'updateProfileName',
    ]);
  });
});

describe('ContentStudioWritingProfileRepository: profiles', () => {
  it('WR11-WR13/WR20 lists and counts active or archived profiles of the organization, newest first', async () => {
    const { repository, profile } = setup();
    await repository.listProfilesForOrganization({
      organizationId: ORG,
      archived: false,
      skip: 20,
      take: 20,
    });
    await repository.listProfilesForOrganization({
      organizationId: ORG,
      archived: true,
      skip: 0,
      take: 20,
    });
    await repository.countProfilesForOrganization({
      organizationId: ORG,
      archived: false,
    });
    await repository.countProfilesForOrganization({
      organizationId: ORG,
      archived: true,
    });

    expect(profile.findMany.mock.calls.map(([args]) => args)).toEqual([
      {
        where: { organizationId: ORG, archivedAt: null },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          latestRevisionNumber: true,
          archivedAt: true,
          createdAt: true,
          updatedAt: true,
        },
        skip: 20,
        take: 20,
      },
      expect.objectContaining({
        where: { organizationId: ORG, archivedAt: { not: null } },
        skip: 0,
      }),
    ]);
    expect(profile.count.mock.calls.map(([args]) => args)).toEqual([
      { where: { organizationId: ORG, archivedAt: null } },
      { where: { organizationId: ORG, archivedAt: { not: null } } },
    ]);
  });

  it('WR14/WR15 reads a profile of the organization only', async () => {
    const { repository, profile } = setup();
    await create(repository);
    expect(
      await repository.getProfileForOrganization(ORG, PROFILE)
    ).toMatchObject({ id: PROFILE, latestRevisionNumber: 1 });
    expect(
      await repository.getProfileForOrganization(OTHER_ORG, PROFILE)
    ).toBeNull();
    expect(profile.findFirst.mock.calls[1][0].where).toEqual({
      id: PROFILE,
      organizationId: OTHER_ORG,
    });
  });

  it('WR16-WR19 renames and archives live profiles, restores archived ones, and deletes nothing', async () => {
    const { repository, profile, state } = setup();
    await create(repository);

    expect(await repository.updateProfileName(ORG, PROFILE, 'New')).toEqual({
      count: 1,
    });
    expect(
      await repository.updateProfileName(OTHER_ORG, PROFILE, 'Theirs')
    ).toEqual({ count: 0 });
    expect(await repository.restoreProfile(ORG, PROFILE)).toEqual({ count: 0 });
    expect(await repository.archiveProfile(ORG, PROFILE, NOW)).toEqual({
      count: 1,
    });
    expect(await repository.archiveProfile(ORG, PROFILE, NOW)).toEqual({
      count: 0,
    });
    expect(await repository.updateProfileName(ORG, PROFILE, 'Late')).toEqual({
      count: 0,
    });
    expect(await repository.restoreProfile(OTHER_ORG, PROFILE)).toEqual({
      count: 0,
    });
    expect(await repository.restoreProfile(ORG, PROFILE)).toEqual({ count: 1 });

    expect(profile.updateMany.mock.calls.map(([args]) => args.where)).toEqual([
      { id: PROFILE, organizationId: ORG, archivedAt: null },
      { id: PROFILE, organizationId: OTHER_ORG, archivedAt: null },
      { id: PROFILE, organizationId: ORG, archivedAt: { not: null } },
      { id: PROFILE, organizationId: ORG, archivedAt: null },
      { id: PROFILE, organizationId: ORG, archivedAt: null },
      { id: PROFILE, organizationId: ORG, archivedAt: null },
      { id: PROFILE, organizationId: OTHER_ORG, archivedAt: { not: null } },
      { id: PROFILE, organizationId: ORG, archivedAt: { not: null } },
    ]);
    // archive and restore leave the revision counter alone
    expect(state.profiles[0]).toMatchObject({
      name: 'New',
      archivedAt: null,
      latestRevisionNumber: 1,
    });
    for (const method of [
      'delete',
      'deleteMany',
      'update',
      'upsert',
    ] as const) {
      expect(profile[method]).not.toHaveBeenCalled();
    }
  });
});

describe('ContentStudioWritingProfileRepository: revision compare-and-swap', () => {
  it('WR21/WR24/WR25/WR26 numbers successive saves 2, 3, 4 in transactions', async () => {
    const { repository, revision, transaction, state } = setup();
    await create(repository);
    for (const [base, hash] of [
      [1, 'b'],
      [2, 'c'],
      [3, 'd'],
    ] as const) {
      expect(await save(repository, base, hash)).toEqual({
        status: 'created',
        revision: expect.objectContaining({ revisionNumber: base + 1 }),
      });
    }
    expect(transaction.$transaction).toHaveBeenCalledTimes(4);
    expect(state.profiles[0].latestRevisionNumber).toBe(4);
    expect(state.revisions.map((r) => r.revisionNumber)).toEqual([1, 2, 3, 4]);
    expect(revision.create.mock.calls[1][0].data).toEqual({
      id: 'rev-b',
      organizationId: ORG,
      profileId: PROFILE,
      revisionNumber: 2,
      createdById: USER,
      ...stored('b'),
    });
  });

  it('WR22/WR29 refuses a stale base, even with the current content', async () => {
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
    expect(state.revisions).toHaveLength(2);
  });

  it('WR27/WR28 returns the current revision for unchanged content, without a new number', async () => {
    const { repository, revision, state } = setup();
    await create(repository);
    const result = await save(repository, 1, 'a');
    expect(result).toEqual({
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
    expect(state.profiles[0].latestRevisionNumber).toBe(1);
    expect(state.revisions).toHaveLength(1);
    expect(revision.findFirst.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      profileId: PROFILE,
      revisionNumber: 1,
    });
  });

  it('WR23 never adds a revision to an archived profile', async () => {
    const { repository, state } = setup();
    await create(repository);
    await repository.archiveProfile(ORG, PROFILE, NOW);
    expect(await save(repository, 1, 'b')).toEqual({ status: 'archived' });
    expect(state.revisions).toHaveLength(1);
  });

  it('answers not found for a missing or foreign profile', async () => {
    const { repository, state } = setup();
    await create(repository);
    expect(
      await save(repository, 1, 'b', { organizationId: OTHER_ORG })
    ).toEqual({ status: 'not-found' });
    expect(
      await save(repository, 1, 'b', { profileId: OTHER_PROFILE })
    ).toEqual({ status: 'not-found' });
    expect(state.revisions).toHaveLength(1);
  });

  it('WR30 lets only one of two writers advance the same base', async () => {
    const { repository, profile, state } = setup();
    await create(repository);
    // the other writer commits between this read and the update
    const realUpdate = profile.updateMany.getMockImplementation();
    profile.updateMany.mockImplementationOnce(async (args) => {
      state.profiles[0].latestRevisionNumber = 2;
      state.revisions.push({ profileId: PROFILE, revisionNumber: 2 });
      return (realUpdate as typeof profile.updateMany)(args);
    });
    expect(await save(repository, 1, 'b')).toEqual({ status: 'changed' });
    expect(profile.updateMany.mock.calls[0][0].where).toEqual({
      id: PROFILE,
      organizationId: ORG,
      archivedAt: null,
      latestRevisionNumber: 1,
    });
    expect(state.revisions.filter((r) => r.revisionNumber === 2)).toHaveLength(
      1
    );
  });

  it('rolls the counter back when the revision cannot be written', async () => {
    const { repository, revision, state } = setup();
    await create(repository);
    revision.create.mockRejectedValueOnce(new Error('database down'));
    await expect(save(repository, 1, 'b')).rejects.toThrow('database down');
    expect(state.profiles[0].latestRevisionNumber).toBe(1);
    expect(state.revisions).toHaveLength(1);
  });
});

describe('ContentStudioWritingProfileRepository: history', () => {
  it('WR31-WR34 reads revisions of one profile of the organization only, archived or not', async () => {
    const { repository, revision } = setup();
    await create(repository);
    await create(repository, { profileId: OTHER_PROFILE });
    await save(repository, 1, 'b');
    await repository.archiveProfile(ORG, PROFILE, NOW);

    const list = await repository.listRevisionsForProfile({
      organizationId: ORG,
      profileId: PROFILE,
      skip: 0,
      take: 20,
    });
    expect(revision.findMany.mock.calls[0][0]).toEqual({
      where: { organizationId: ORG, profileId: PROFILE },
      orderBy: { revisionNumber: 'desc' },
      select: {
        id: true,
        revisionNumber: true,
        schemaVersion: true,
        contentHash: true,
        createdAt: true,
      },
      skip: 0,
      take: 20,
    });
    expect(list.map((r) => Object.keys(r))).not.toContainEqual(
      expect.arrayContaining(['content'])
    );
    expect(await repository.countRevisionsForProfile(ORG, PROFILE)).toBe(2);

    expect(
      await repository.getRevisionForProfile(ORG, PROFILE, 'rev-b')
    ).toMatchObject({ revisionNumber: 2, content: stored('b').content });
    // the revision exists, but under another profile or organization
    expect(
      await repository.getRevisionForProfile(ORG, OTHER_PROFILE, 'rev-b')
    ).toBeNull();
    expect(
      await repository.getRevisionForProfile(OTHER_ORG, PROFILE, 'rev-b')
    ).toBeNull();
    expect(
      revision.findFirst.mock.calls.slice(-3).map(([a]) => a.where)
    ).toEqual([
      { id: 'rev-b', profileId: PROFILE, organizationId: ORG },
      { id: 'rev-b', profileId: OTHER_PROFILE, organizationId: ORG },
      { id: 'rev-b', profileId: PROFILE, organizationId: OTHER_ORG },
    ]);
    expect(
      await repository.getRevisionByNumber(OTHER_ORG, PROFILE, 2)
    ).toBeNull();
  });
});

describe('ContentStudioWritingProfileRepository source', () => {
  const text = read(
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.writing-profile.repository.ts'
  ).replace(/^\s*\/\/.*$/gm, '');

  it('only ever creates revisions and deletes nothing', () => {
    expect(text).not.toMatch(
      /contentStudioWritingProfileRevision\.(update|updateMany|upsert|delete|deleteMany)\(/
    );
    expect(text).not.toMatch(/\.delete(Many)?\(|\.upsert\(|\.update\(/);
    expect(
      text.match(/contentStudioWritingProfileRevision\.create\(/g)
    ).toHaveLength(2);
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
      module.match(/ContentStudioWritingProfileRepository\b/g)
    ).toHaveLength(2);
    expect(module.match(/ContentStudioWritingProfileService\b/g)).toHaveLength(
      2
    );
  });
});

describe('ContentStudioWritingProfile schema', () => {
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

  it('keeps Writing DNA in the revisions only', () => {
    expect(fields('ContentStudioWritingProfile')).toEqual({
      id: 'String',
      organizationId: 'String',
      name: 'String',
      latestRevisionNumber: 'Int',
      archivedAt: 'DateTime?',
      createdById: 'String',
      createdAt: 'DateTime',
      updatedAt: 'DateTime',
      organization: 'Organization',
      createdBy: 'User',
      revisions: 'ContentStudioWritingProfileRevision[]',
    });
    expect(fields('ContentStudioWritingProfileRevision')).toEqual({
      id: 'String',
      organizationId: 'String',
      profileId: 'String',
      revisionNumber: 'Int',
      schemaVersion: 'Int',
      content: 'String',
      contentHash: 'String',
      createdById: 'String',
      createdAt: 'DateTime',
      organization: 'Organization',
      profile: 'ContentStudioWritingProfile',
      createdBy: 'User',
    });
  });

  it('binds a revision to a profile of its own organization, numbered once', () => {
    const revision = block('ContentStudioWritingProfileRevision');
    expect(revision).toMatch(
      /profile\s+ContentStudioWritingProfile\s+@relation\(fields: \[profileId, organizationId\], references: \[id, organizationId\]\)/
    );
    expect(revision).toMatch(/@@unique\(\[profileId, revisionNumber\]\)/);
    expect(revision).toMatch(/@@unique\(\[id, organizationId\]\)/);
    expect(block('ContentStudioWritingProfile')).toMatch(
      /@@unique\(\[id, organizationId\]\)/
    );
    expect(block('Organization')).toMatch(
      /contentStudioWritingProfiles\s+ContentStudioWritingProfile\[\]/
    );
    expect(block('User')).toMatch(
      /contentStudioWritingProfileRevisions\s+ContentStudioWritingProfileRevision\[\]\s+@relation\("ContentStudioWritingProfileRevisionCreatedBy"\)/
    );
  });
});
