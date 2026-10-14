import fs from 'fs';
import path from 'path';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioExpertiseProfileRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.expertise-profile.repository';

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
    contentStudioExpertiseProfile: profile,
    contentStudioExpertiseProfileRevision: revision,
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
  const repository = new ContentStudioExpertiseProfileRepository(
    {
      model: { contentStudioExpertiseProfile: profile },
    } as unknown as PrismaRepository<'contentStudioExpertiseProfile'>,
    {
      model: { contentStudioExpertiseProfileRevision: revision },
    } as unknown as PrismaRepository<'contentStudioExpertiseProfileRevision'>,
    { model: transaction } as unknown as PrismaTransaction
  );
  return { repository, profile, revision, transaction, state };
};

const create = (
  repository: ContentStudioExpertiseProfileRepository,
  overrides: Partial<{ organizationId: string; profileId: string }> = {}
) =>
  repository.createProfileWithFirstRevision({
    profileId: overrides.profileId ?? PROFILE,
    revisionId: 'rev-1',
    organizationId: overrides.organizationId ?? ORG,
    name: 'Tax expertise',
    createdById: USER,
    revision: stored('a'),
  });

const save = (
  repository: ContentStudioExpertiseProfileRepository,
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

describe('ContentStudioExpertiseProfileRepository: create', () => {
  it('XR1-XR7 creates the profile and revision 1 in one transaction', async () => {
    const { repository, transaction, state } = setup();
    const result = await create(repository);

    expect(transaction.$transaction).toHaveBeenCalledTimes(1);
    expect(state.profiles).toEqual([
      expect.objectContaining({
        id: PROFILE,
        organizationId: ORG,
        name: 'Tax expertise',
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
      name: 'Tax expertise',
      latestRevisionNumber: 1,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    // the creation answer carries no stored text
    expect(Object.keys(result.revision)).not.toContain('content');
  });

  it('XR8 leaves no profile when its first revision cannot be written', async () => {
    const { repository, revision, state } = setup();
    revision.create.mockRejectedValueOnce(new Error('database down'));
    await expect(create(repository)).rejects.toThrow('database down');
    expect(state.profiles).toEqual([]);
    expect(state.revisions).toEqual([]);
  });

  it('XR15/XR20/XR21/XR34 has no delete, default, verification, source or revision-changing method', () => {
    expect(
      Object.getOwnPropertyNames(
        ContentStudioExpertiseProfileRepository.prototype
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

describe('ContentStudioExpertiseProfileRepository: profiles', () => {
  it('XR9-XR12 lists and counts active or archived profiles of the organization, newest first', async () => {
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

  it('XR13/XR14 reads a profile of the organization only', async () => {
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

  it('XR16-XR19 renames and archives live profiles, restores archived ones, and writes no revision', async () => {
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
    expect(state.revisions).toHaveLength(1);
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

describe('ContentStudioExpertiseProfileRepository: revision compare-and-swap', () => {
  it('XR25/XR26 numbers successive saves 2, 3, 4 in transactions', async () => {
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

  it('XR22/XR23/XR28 refuses a stale base, even with the current content', async () => {
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

  it('XR27 returns the current revision for unchanged content, without a new number', async () => {
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

  it('XR24 never adds a revision to an archived profile', async () => {
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

  it('XR29 lets only one of two writers advance the same base', async () => {
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

describe('ContentStudioExpertiseProfileRepository: history', () => {
  it('XR30-XR33 reads revisions of one profile of the organization only, archived or not', async () => {
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

describe('ContentStudioExpertiseProfileRepository source', () => {
  const text = read(
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.expertise-profile.repository.ts'
  ).replace(/^\s*\/\/.*$/gm, '');

  it('XR15/XR34 only ever creates revisions and deletes nothing', () => {
    expect(text).not.toMatch(
      /contentStudioExpertiseProfileRevision\.(update|updateMany|upsert|delete|deleteMany)\(/
    );
    expect(text).not.toMatch(/\.delete(Many)?\(|\.upsert\(|\.update\(/);
    expect(
      text.match(/contentStudioExpertiseProfileRevision\.create\(/g)
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
      module.match(/ContentStudioExpertiseProfileRepository\b/g)
    ).toHaveLength(2);
    expect(
      module.match(/ContentStudioExpertiseProfileService\b/g)
    ).toHaveLength(2);
  });
});

describe('ContentStudioExpertiseProfile schema', () => {
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

  it('keeps the expertise content in the revisions only: no default, package or ad-platform field', () => {
    expect(fields('ContentStudioExpertiseProfile')).toEqual({
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
      revisions: 'ContentStudioExpertiseProfileRevision[]',
    });
    expect(fields('ContentStudioExpertiseProfileRevision')).toEqual({
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
      profile: 'ContentStudioExpertiseProfile',
      createdBy: 'User',
    });
  });

  it('binds a revision to a profile of its own organization, numbered once', () => {
    const revision = block('ContentStudioExpertiseProfileRevision');
    expect(revision).toMatch(
      /profile\s+ContentStudioExpertiseProfile\s+@relation\(fields: \[profileId, organizationId\], references: \[id, organizationId\]\)/
    );
    expect(revision).toMatch(/@@unique\(\[profileId, revisionNumber\]\)/);
    expect(revision).toMatch(/@@unique\(\[id, organizationId\]\)/);
    expect(block('ContentStudioExpertiseProfile')).toMatch(
      /@@unique\(\[id, organizationId\]\)/
    );
    expect(block('Organization')).toMatch(
      /contentStudioExpertiseProfiles\s+ContentStudioExpertiseProfile\[\]/
    );
    expect(block('User')).toMatch(
      /contentStudioExpertiseProfileRevisions\s+ContentStudioExpertiseProfileRevision\[\]\s+@relation\("ContentStudioExpertiseProfileRevisionCreatedBy"\)/
    );
  });

  it('XR21 models no verification, source, citation or grounding field', () => {
    // Organization-provided context, never verified fact or stored evidence.
    // Identifiers only (comments and string literals are stripped, so fixed
    // messages may use plain words), whole words only, in the Expertise
    // Profile files and nowhere else. evidenceExpectations, an instruction,
    // is the one allowed evidence word
    const BOUNDARY =
      /\b(verified|verifiedAt|verify\w*|factCheck\w*|truthScore|confidenceScore|sourceVerified|citationVerified|proof|evidenceVerified|evidence|grounded|grounding|sources?|sourceIds|citations?|urls?|links?|references|documents|attachments|accurate|factual)\b/i;
    const strip = (text: string) =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    const code = (file: string) => strip(read(file));
    for (const file of [
      'libraries/nestjs-libraries/src/content-studio/editorial/expertise.profile.ts',
      'libraries/nestjs-libraries/src/content-studio/editorial/expertise.profile.revision.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.expertise-profile.repository.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.expertise-profile.service.ts',
      'libraries/nestjs-libraries/src/dtos/content-studio/content-studio.expertise-profile.dto.ts',
    ]) {
      expect(code(file)).not.toMatch(BOUNDARY);
    }
    // the field names of both models (a relation's "references:" is syntax)
    expect(
      [
        ...Object.keys(fields('ContentStudioExpertiseProfile')),
        ...Object.keys(fields('ContentStudioExpertiseProfileRevision')),
      ].join(' ')
    ).not.toMatch(BOUNDARY);
    // the controller's expertise routes; their paths are checked by the
    // route inventory in the controller spec
    const controller = read(
      'apps/backend/src/api/routes/content-studio.controller.ts'
    );
    const routes = strip(
      controller.slice(controller.indexOf("@Get('/expertise-profiles')"))
    );
    expect(routes).toContain('_contentStudioExpertiseProfileService');
    expect(routes).not.toMatch(BOUNDARY);
  });
});
