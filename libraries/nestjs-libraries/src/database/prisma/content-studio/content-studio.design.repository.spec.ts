import fs from 'fs';
import path from 'path';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioDesignRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.repository';

// Mirrors the writing profile repository spec. No database: the Prisma
// delegates are mocked. The transaction mock runs on
// a small in-memory copy of the rows, applies where clauses like Prisma
// (undefined is no condition) and puts everything back when the callback
// throws, like a rollback. The real constraints come with the PostgreSQL
// integration suite

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const OTHER_PROJECT = '44444444-4444-4444-8444-444444444444';
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
    projects: [] as Row[],
    revisions: [] as Row[],
  };
  const delegate = (table: 'projects' | 'revisions') => ({
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
            r.designProjectId === args.data.designProjectId &&
            r.revisionNumber === args.data.revisionNumber
        )
      ) {
        throw new Error(
          'Unique constraint failed (designProjectId, revisionNumber)'
        );
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
  const project = delegate('projects');
  const revision = delegate('revisions');
  const tx = {
    contentStudioDesignProject: project,
    contentStudioDesignRevision: revision,
  };
  const transaction = {
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => {
      const snapshot = JSON.parse(JSON.stringify(state));
      try {
        return await fn(tx);
      } catch (err) {
        state.projects = snapshot.projects;
        state.revisions = snapshot.revisions;
        throw err;
      }
    }),
  };
  const repository = new ContentStudioDesignRepository(
    {
      model: { contentStudioDesignProject: project },
    } as unknown as PrismaRepository<'contentStudioDesignProject'>,
    {
      model: { contentStudioDesignRevision: revision },
    } as unknown as PrismaRepository<'contentStudioDesignRevision'>,
    { model: transaction } as unknown as PrismaTransaction
  );
  return { repository, project, revision, transaction, state };
};

const create = (
  repository: ContentStudioDesignRepository,
  overrides: Partial<{
    organizationId: string;
    designProjectId: string;
    source: { packageRevisionId: string; contentHash: string } | null;
  }> = {}
) =>
  repository.createProjectWithFirstRevision({
    designProjectId: overrides.designProjectId ?? PROJECT,
    revisionId: 'rev-1',
    organizationId: overrides.organizationId ?? ORG,
    name: 'Brand voice',
    createdById: USER,
    revision: stored('a'),
    source: overrides.source ?? null,
  });

const save = (
  repository: ContentStudioDesignRepository,
  expectedLatestRevisionNumber: number,
  hash: string,
  overrides: Partial<{ organizationId: string; designProjectId: string }> = {}
) =>
  repository.createRevisionWithCompareAndSwap({
    organizationId: overrides.organizationId ?? ORG,
    designProjectId: overrides.designProjectId ?? PROJECT,
    expectedLatestRevisionNumber,
    revisionId: `rev-${hash}`,
    revision: stored(hash),
    createdById: USER,
  });

describe('ContentStudioDesignRepository: create', () => {
  it('DPR4 creates the project and revision 1 in one transaction', async () => {
    const { repository, transaction, state } = setup();
    const result = await create(repository);

    expect(transaction.$transaction).toHaveBeenCalledTimes(1);
    expect(state.projects).toEqual([
      expect.objectContaining({
        id: PROJECT,
        organizationId: ORG,
        name: 'Brand voice',
        latestRevisionNumber: 1,
        createdById: USER,
        // PV4: a design created on its own has no source, written as such
        sourcePackageRevisionId: null,
        sourcePackageContentHash: null,
      }),
    ]);
    expect(Object.keys(state.projects[0])).not.toEqual(
      expect.arrayContaining(['content'])
    );
    expect(Object.keys(state.projects[0])).not.toContain('contentHash');
    expect(state.revisions).toEqual([
      expect.objectContaining({
        id: 'rev-1',
        organizationId: ORG,
        designProjectId: PROJECT,
        revisionNumber: 1,
        createdById: USER,
        ...stored('a'),
      }),
    ]);
    expect(result.project).toEqual({
      id: PROJECT,
      name: 'Brand voice',
      latestRevisionNumber: 1,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    // the creation answer carries no stored text
    expect(Object.keys(result.revision)).not.toContain('content');
  });

  it('PV1/PV5/P6PG1 writes the package revision a design came from with the project, in the same transaction', async () => {
    const { repository, transaction, state } = setup();
    const result = await create(repository, {
      source: { packageRevisionId: 'pkg-rev-3', contentHash: 'c'.repeat(64) },
    });
    expect(transaction.$transaction).toHaveBeenCalledTimes(1);
    expect(state.projects).toEqual([
      expect.objectContaining({
        id: PROJECT,
        sourcePackageRevisionId: 'pkg-rev-3',
        sourcePackageContentHash: 'c'.repeat(64),
      }),
    ]);
    // the creation answer is the summary, as before
    expect(Object.keys(result.project)).not.toContain(
      'sourcePackageRevisionId'
    );
  });

  it('P6PG6 leaves no project, and so no source, when the first revision of a design from a package cannot be written', async () => {
    const { repository, revision, state } = setup();
    revision.create.mockRejectedValueOnce(new Error('database down'));
    await expect(
      create(repository, {
        source: { packageRevisionId: 'pkg-rev-3', contentHash: 'c'.repeat(64) },
      })
    ).rejects.toThrow('database down');
    expect(state.projects).toEqual([]);
    expect(state.revisions).toEqual([]);
  });

  it('PV7 reads the detail with the source through its relation, scoped to the organization', async () => {
    const { repository, project } = setup();
    await repository.getProjectDetailForOrganization(ORG, PROJECT);
    expect(project.findFirst).toHaveBeenCalledWith({
      where: { id: PROJECT, organizationId: ORG },
      select: expect.objectContaining({
        sourcePackageRevisionId: true,
        sourcePackageContentHash: true,
        sourcePackageRevision: {
          select: {
            id: true,
            packageId: true,
            revisionNumber: true,
            contentHash: true,
            package: { select: { name: true } },
          },
        },
      }),
    });
  });

  it('DPR5 leaves no project when its first revision cannot be written', async () => {
    const { repository, revision, state } = setup();
    revision.create.mockRejectedValueOnce(new Error('database down'));
    await expect(create(repository)).rejects.toThrow('database down');
    expect(state.projects).toEqual([]);
    expect(state.revisions).toEqual([]);
  });

  it('DPR17/DPR18/DPR19 has no method to change or remove a revision or a project, nor a generic one', () => {
    expect(
      Object.getOwnPropertyNames(ContentStudioDesignRepository.prototype).sort()
    ).toEqual([
      'archiveProject',
      'constructor',
      'countProjectsForOrganization',
      'countRevisionsForProject',
      'createProjectWithFirstRevision',
      'createRevisionWithCompareAndSwap',
      'getProjectDetailForOrganization',
      'getProjectForOrganization',
      'getRevisionByNumber',
      'getRevisionForProject',
      'listProjectsForOrganization',
      'listRevisionsForProject',
      'restoreProject',
      'updateProjectName',
    ]);
  });
});

describe('ContentStudioDesignRepository: projects', () => {
  it('DPR1/DPR2 lists and counts active or archived projects of the organization, newest first', async () => {
    const { repository, project } = setup();
    await repository.listProjectsForOrganization({
      organizationId: ORG,
      archived: false,
      skip: 20,
      take: 20,
    });
    await repository.listProjectsForOrganization({
      organizationId: ORG,
      archived: true,
      skip: 0,
      take: 20,
    });
    await repository.countProjectsForOrganization({
      organizationId: ORG,
      archived: false,
    });
    await repository.countProjectsForOrganization({
      organizationId: ORG,
      archived: true,
    });

    expect(project.findMany.mock.calls.map(([args]) => args)).toEqual([
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
    expect(project.count.mock.calls.map(([args]) => args)).toEqual([
      { where: { organizationId: ORG, archivedAt: null } },
      { where: { organizationId: ORG, archivedAt: { not: null } } },
    ]);
  });

  it('DPR3 reads a project of the organization only', async () => {
    const { repository, project } = setup();
    await create(repository);
    expect(
      await repository.getProjectForOrganization(ORG, PROJECT)
    ).toMatchObject({ id: PROJECT, latestRevisionNumber: 1 });
    expect(
      await repository.getProjectForOrganization(OTHER_ORG, PROJECT)
    ).toBeNull();
    expect(project.findFirst.mock.calls[1][0].where).toEqual({
      id: PROJECT,
      organizationId: OTHER_ORG,
    });
  });

  it('DPR6/DPR7/DPR8 renames and archives live projects, restores archived ones, and deletes nothing', async () => {
    const { repository, project, state } = setup();
    await create(repository);

    expect(await repository.updateProjectName(ORG, PROJECT, 'New')).toEqual({
      count: 1,
    });
    expect(
      await repository.updateProjectName(OTHER_ORG, PROJECT, 'Theirs')
    ).toEqual({ count: 0 });
    expect(await repository.restoreProject(ORG, PROJECT)).toEqual({ count: 0 });
    expect(await repository.archiveProject(ORG, PROJECT, NOW)).toEqual({
      count: 1,
    });
    expect(await repository.archiveProject(ORG, PROJECT, NOW)).toEqual({
      count: 0,
    });
    expect(await repository.updateProjectName(ORG, PROJECT, 'Late')).toEqual({
      count: 0,
    });
    expect(await repository.restoreProject(OTHER_ORG, PROJECT)).toEqual({
      count: 0,
    });
    expect(await repository.restoreProject(ORG, PROJECT)).toEqual({ count: 1 });

    expect(project.updateMany.mock.calls.map(([args]) => args.where)).toEqual([
      { id: PROJECT, organizationId: ORG, archivedAt: null },
      { id: PROJECT, organizationId: OTHER_ORG, archivedAt: null },
      { id: PROJECT, organizationId: ORG, archivedAt: { not: null } },
      { id: PROJECT, organizationId: ORG, archivedAt: null },
      { id: PROJECT, organizationId: ORG, archivedAt: null },
      { id: PROJECT, organizationId: ORG, archivedAt: null },
      { id: PROJECT, organizationId: OTHER_ORG, archivedAt: { not: null } },
      { id: PROJECT, organizationId: ORG, archivedAt: { not: null } },
    ]);
    // archive and restore leave the revision counter alone
    expect(state.projects[0]).toMatchObject({
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
      expect(project[method]).not.toHaveBeenCalled();
    }
  });
});

describe('ContentStudioDesignRepository: revision compare-and-swap', () => {
  it('DPR9/DPR14 numbers successive saves 2, 3, 4 in transactions', async () => {
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
    expect(state.projects[0].latestRevisionNumber).toBe(4);
    expect(state.revisions.map((r) => r.revisionNumber)).toEqual([1, 2, 3, 4]);
    expect(revision.create.mock.calls[1][0].data).toEqual({
      id: 'rev-b',
      organizationId: ORG,
      designProjectId: PROJECT,
      revisionNumber: 2,
      createdById: USER,
      ...stored('b'),
    });
  });

  it('DPR10/DPR13 refuses a stale base, even with the current content', async () => {
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

  it('DPR12 returns the current revision for unchanged content, without a new number', async () => {
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
    expect(state.projects[0].latestRevisionNumber).toBe(1);
    expect(state.revisions).toHaveLength(1);
    expect(revision.findFirst.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      designProjectId: PROJECT,
      revisionNumber: 1,
    });
  });

  it('DPR11 never adds a revision to an archived project', async () => {
    const { repository, state } = setup();
    await create(repository);
    await repository.archiveProject(ORG, PROJECT, NOW);
    expect(await save(repository, 1, 'b')).toEqual({ status: 'archived' });
    expect(state.revisions).toHaveLength(1);
  });

  it('answers not found for a missing or foreign project', async () => {
    const { repository, state } = setup();
    await create(repository);
    expect(
      await save(repository, 1, 'b', { organizationId: OTHER_ORG })
    ).toEqual({ status: 'not-found' });
    expect(
      await save(repository, 1, 'b', { designProjectId: OTHER_PROJECT })
    ).toEqual({ status: 'not-found' });
    expect(state.revisions).toHaveLength(1);
  });

  it('lets only one of two writers advance the same base', async () => {
    const { repository, project, state } = setup();
    await create(repository);
    // the other writer commits between this read and the update
    const realUpdate = project.updateMany.getMockImplementation();
    project.updateMany.mockImplementationOnce(async (args) => {
      state.projects[0].latestRevisionNumber = 2;
      state.revisions.push({ designProjectId: PROJECT, revisionNumber: 2 });
      return (realUpdate as typeof project.updateMany)(args);
    });
    expect(await save(repository, 1, 'b')).toEqual({ status: 'changed' });
    expect(project.updateMany.mock.calls[0][0].where).toEqual({
      id: PROJECT,
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
    expect(state.projects[0].latestRevisionNumber).toBe(1);
    expect(state.revisions).toHaveLength(1);
  });
});

describe('ContentStudioDesignRepository: history', () => {
  it('DPR15/DPR16 reads revisions of one project of the organization only, archived or not', async () => {
    const { repository, revision } = setup();
    await create(repository);
    await create(repository, { designProjectId: OTHER_PROJECT });
    await save(repository, 1, 'b');
    await repository.archiveProject(ORG, PROJECT, NOW);

    const list = await repository.listRevisionsForProject({
      organizationId: ORG,
      designProjectId: PROJECT,
      skip: 0,
      take: 20,
    });
    expect(revision.findMany.mock.calls[0][0]).toEqual({
      where: { organizationId: ORG, designProjectId: PROJECT },
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
    expect(await repository.countRevisionsForProject(ORG, PROJECT)).toBe(2);

    expect(
      await repository.getRevisionForProject(ORG, PROJECT, 'rev-b')
    ).toMatchObject({ revisionNumber: 2, content: stored('b').content });
    // the revision exists, but under another project or organization
    expect(
      await repository.getRevisionForProject(ORG, OTHER_PROJECT, 'rev-b')
    ).toBeNull();
    expect(
      await repository.getRevisionForProject(OTHER_ORG, PROJECT, 'rev-b')
    ).toBeNull();
    expect(
      revision.findFirst.mock.calls.slice(-3).map(([a]) => a.where)
    ).toEqual([
      { id: 'rev-b', designProjectId: PROJECT, organizationId: ORG },
      { id: 'rev-b', designProjectId: OTHER_PROJECT, organizationId: ORG },
      { id: 'rev-b', designProjectId: PROJECT, organizationId: OTHER_ORG },
    ]);
    expect(
      await repository.getRevisionByNumber(OTHER_ORG, PROJECT, 2)
    ).toBeNull();
  });
});

describe('ContentStudioDesignRepository source', () => {
  const text = read(
    'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design.repository.ts'
  ).replace(/^\s*\/\/.*$/gm, '');

  it('only ever creates revisions and deletes nothing', () => {
    expect(text).not.toMatch(
      /contentStudioDesignRevision\.(update|updateMany|upsert|delete|deleteMany)\(/
    );
    expect(text).not.toMatch(/\.delete(Many)?\(|\.upsert\(|\.update\(/);
    expect(text.match(/contentStudioDesignRevision\.create\(/g)).toHaveLength(
      2
    );
  });

  it('reads no environment, provider SDK, AI service, Media, renderer or logger', () => {
    expect(text).not.toMatch(
      /process\.env|from 'openai'|@anthropic-ai|@ai-sdk|ai\.execution|ai\.provider|console\.|Logger|\bfetch\(|[mM]edia|sharp|fontkit|fabric/
    );
  });

  it('is registered once in the database module', () => {
    const module = read(
      'libraries/nestjs-libraries/src/database/prisma/database.module.ts'
    );
    expect(module.match(/ContentStudioDesignRepository\b/g)).toHaveLength(2);
    expect(module.match(/ContentStudioDesignService\b/g)).toHaveLength(2);
  });
});

describe('ContentStudioDesignProject schema', () => {
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

  it('DPR20 keeps the design document in the revisions only', () => {
    expect(fields('ContentStudioDesignProject')).toEqual({
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
      revisions: 'ContentStudioDesignRevision[]',
      // P4-05: renders of the design point to it
      renders: 'ContentStudioDesignRender[]',
      // P4-06: render-all batches of the design point to it
      renderBatches: 'ContentStudioDesignRenderBatch[]',
      // P6-01: the saved package revision a design was created from, and its
      // hash, outside the document (null for a design made on its own)
      sourcePackageRevisionId: 'String?',
      sourcePackageContentHash: 'String?',
      sourcePackageRevision: 'ContentPackageRevision?',
    });
    expect(fields('ContentStudioDesignRevision')).toEqual({
      id: 'String',
      organizationId: 'String',
      designProjectId: 'String',
      revisionNumber: 'Int',
      schemaVersion: 'Int',
      content: 'String',
      contentHash: 'String',
      createdById: 'String',
      createdAt: 'DateTime',
      organization: 'Organization',
      designProject: 'ContentStudioDesignProject',
      createdBy: 'User',
      // P4-05: renders of this exact revision point to it
      renders: 'ContentStudioDesignRender[]',
      // P4-06: render-all batches of this exact revision point to it
      renderBatches: 'ContentStudioDesignRenderBatch[]',
      // P5-01: a review of this exact revision points to it
      reviews: 'ContentStudioReview[]',
      // P5-02: a revision request resolved by this exact revision points to it
      resolvedRequests: 'ContentStudioReviewRevisionRequest[]',
      // P5-04: an approval decision about this exact revision points to it
      approvals: 'ContentStudioApproval[]',
      // P6-02: a Design Creative AI operation on this exact revision points
      // to it
      aiOperations: 'ContentStudioAIOperation[]',
    });
  });

  it('DPR20 binds a revision to a project of its own organization, numbered once', () => {
    const revision = block('ContentStudioDesignRevision');
    expect(revision).toMatch(
      /designProject\s+ContentStudioDesignProject\s+@relation\(fields: \[designProjectId, organizationId\], references: \[id, organizationId\]\)/
    );
    expect(revision).toMatch(/@@unique\(\[designProjectId, revisionNumber\]\)/);
    expect(revision).toMatch(/@@unique\(\[id, organizationId\]\)/);
    expect(block('ContentStudioDesignProject')).toMatch(
      /@@unique\(\[id, organizationId\]\)/
    );
    expect(block('Organization')).toMatch(
      /contentStudioDesignProjects\s+ContentStudioDesignProject\[\]/
    );
    expect(block('Organization')).toMatch(
      /contentStudioDesignRevisions\s+ContentStudioDesignRevision\[\]/
    );
    expect(block('User')).toMatch(
      /contentStudioDesignProjects\s+ContentStudioDesignProject\[\]\s+@relation\("ContentStudioDesignProjectCreatedBy"\)/
    );
    expect(block('ContentStudioDesignProject')).toMatch(
      /@@index\(\[organizationId, archivedAt\]\)/
    );
    expect(block('User')).toMatch(
      /contentStudioDesignRevisions\s+ContentStudioDesignRevision\[\]\s+@relation\("ContentStudioDesignRevisionCreatedBy"\)/
    );
  });
});
