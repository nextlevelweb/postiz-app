import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';

// No database: the Prisma delegates are mocked, so these tests pin the queries
// the repository sends, which is where the organization boundary lives

const ORG = 'org-a';
const ARCHIVED_AT = new Date('2026-10-12T10:00:00.000Z');

const delegate = () => ({
  findMany: jest.fn().mockResolvedValue([]),
  findFirst: jest.fn().mockResolvedValue(null),
  findUnique: jest.fn().mockResolvedValue(null),
  count: jest.fn().mockResolvedValue(0),
  create: jest.fn().mockResolvedValue({}),
  update: jest.fn().mockResolvedValue({}),
  updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  upsert: jest.fn().mockResolvedValue({}),
  delete: jest.fn().mockResolvedValue({}),
  deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
});
type Delegate = ReturnType<typeof delegate>;

const setup = () => {
  const project = delegate();
  const contentPackage = delegate();
  const revision = delegate();
  const tx = {
    contentPackage: delegate(),
    contentPackageRevision: delegate(),
  };
  const $transaction = jest.fn(
    async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)
  );
  const repository = new ContentStudioRepository(
    {
      model: { contentStudioProject: project },
    } as unknown as PrismaRepository<'contentStudioProject'>,
    {
      model: { contentPackage },
    } as unknown as PrismaRepository<'contentPackage'>,
    {
      model: { contentPackageRevision: revision },
    } as unknown as PrismaRepository<'contentPackageRevision'>,
    { model: { $transaction } } as unknown as PrismaTransaction
  );
  return { project, contentPackage, revision, tx, $transaction, repository };
};

type Setup = ReturnType<typeof setup>;
const allDelegates = (s: Setup): [string, Delegate][] => [
  ['project', s.project],
  ['package', s.contentPackage],
  ['revision', s.revision],
  ['tx.package', s.tx.contentPackage],
  ['tx.revision', s.tx.contentPackageRevision],
];
const allCalls = (s: Setup) =>
  allDelegates(s).flatMap(([name, d]) =>
    Object.entries(d).flatMap(([method, fn]) =>
      fn.mock.calls.map((call) => ({ name, method, args: call[0] }))
    )
  );
const onlyCall = (fn: jest.Mock) => {
  expect(fn).toHaveBeenCalledTimes(1);
  return fn.mock.calls[0][0];
};

const PROJECT_SELECT = {
  id: true,
  name: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
};
const PACKAGE_SUMMARY_SELECT = {
  id: true,
  name: true,
  projectId: true,
  draftVersion: true,
  latestRevisionNumber: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
};
const PACKAGE_DETAIL_SELECT = {
  id: true,
  projectId: true,
  name: true,
  draft: true,
  draftVersion: true,
  latestRevisionNumber: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
};
const CREATED_BY_SELECT = { select: { id: true, name: true } };
const REVISION_SUMMARY_SELECT = {
  id: true,
  revisionNumber: true,
  contentHash: true,
  origin: true,
  sourceDraftVersion: true,
  createdAt: true,
  createdBy: CREATED_BY_SELECT,
};
const REVISION_DETAIL_SELECT = {
  id: true,
  packageId: true,
  revisionNumber: true,
  schemaVersion: true,
  content: true,
  contentHash: true,
  origin: true,
  sourceDraftVersion: true,
  createdAt: true,
  createdBy: CREATED_BY_SELECT,
};

const CONTENT =
  '{"copy":{"global":{"thread":[{"id":"main","mediaIds":["m1"],"text":"Launch \\"day\\" 🎉\\n\\u00e9"}]}},"schemaVersion":1}';
const REVISION_INPUT = {
  organizationId: ORG,
  packageId: 'package-1',
  expectedDraftVersion: 7,
  expectedLatestRevisionNumber: 2,
  schemaVersion: 1,
  content: CONTENT,
  contentHash: 'a'.repeat(64),
  origin: 'manual',
  createdById: 'user-1',
};

// Calls every public method once, with arguments for org-a
const callEveryMethod = async (repository: ContentStudioRepository) => {
  await repository.listProjectsForOrganization(ORG, false);
  await repository.getProjectForOrganization(ORG, 'project-1');
  await repository.createProject({
    organizationId: ORG,
    name: 'Launch',
    createdById: 'user-1',
  });
  await repository.updateProjectName(ORG, 'project-1', 'Renamed');
  await repository.archiveProject(ORG, 'project-1', ARCHIVED_AT);
  await repository.restoreProject(ORG, 'project-1');
  await repository.listPackagesForOrganization({
    organizationId: ORG,
    archived: false,
    projectId: 'project-1',
    skip: 0,
    take: 20,
  });
  await repository.countPackagesForOrganization({
    organizationId: ORG,
    archived: true,
  });
  await repository.getPackageForOrganization(ORG, 'package-1');
  await repository.createPackage({
    organizationId: ORG,
    projectId: null,
    name: 'Post',
    draft: '{}',
    createdById: 'user-1',
  });
  await repository.updatePackageMetadata({
    organizationId: ORG,
    packageId: 'package-1',
    name: 'Renamed',
  });
  await repository.saveDraftCompareAndSwap({
    organizationId: ORG,
    packageId: 'package-1',
    baseDraftVersion: 3,
    draft: '{}',
  });
  await repository.getPackageWriteStateForOrganization(ORG, 'package-1');
  await repository.archivePackage(ORG, 'package-1', ARCHIVED_AT);
  await repository.restorePackage(ORG, 'package-1');
  await repository.listRevisionsForPackage({
    organizationId: ORG,
    packageId: 'package-1',
    skip: 0,
    take: 20,
  });
  await repository.countRevisionsForPackage(ORG, 'package-1');
  await repository.getRevisionForPackage(ORG, 'package-1', 'revision-1');
  await repository.getLatestRevisionForPackage(ORG, 'package-1');
  await repository.createRevisionWithCompareAndSwap(REVISION_INPUT);
};

const PUBLIC_METHODS = [
  'archivePackage',
  'archiveProject',
  'countPackagesForOrganization',
  'countRevisionsForPackage',
  'createPackage',
  'createProject',
  'createRevisionWithCompareAndSwap',
  'getLatestRevisionForPackage',
  'getPackageForOrganization',
  'getPackageWriteStateForOrganization',
  'getProjectForOrganization',
  'getRevisionForPackage',
  // read only, for source version protection (P8-R1A)
  'listPackageDraftsForVersionProtection',
  'listPackageRevisionsForVersionProtection',
  'listPackagesForOrganization',
  'listProjectsForOrganization',
  'listRevisionsForPackage',
  'restorePackage',
  'restoreProject',
  'saveDraftCompareAndSwap',
  'updatePackageMetadata',
  'updateProjectName',
];

describe('ContentStudioRepository', () => {
  describe('surface', () => {
    it('exposes exactly the planned methods', () => {
      const methods = Object.getOwnPropertyNames(
        ContentStudioRepository.prototype
      )
        .filter((name) => name !== 'constructor')
        .sort();

      expect(methods).toEqual(PUBLIC_METHODS);
      expect(PUBLIC_METHODS).toHaveLength(22);
    });

    it('has no method that updates or deletes a revision', () => {
      const methods = Object.getOwnPropertyNames(
        ContentStudioRepository.prototype
      );

      expect(
        methods.filter((name) =>
          /^(update|delete|remove|upsert|save|set|archive|restore).*revision/i.test(
            name
          )
        )
      ).toEqual([]);
    });

    it('never changes, deletes or upserts through any delegate', async () => {
      const s = setup();
      await callEveryMethod(s.repository);

      for (const [, d] of allDelegates(s)) {
        expect(d.update).not.toHaveBeenCalled();
        expect(d.upsert).not.toHaveBeenCalled();
        expect(d.delete).not.toHaveBeenCalled();
        expect(d.deleteMany).not.toHaveBeenCalled();
        expect(d.findUnique).not.toHaveBeenCalled();
      }
      expect(s.revision.updateMany).not.toHaveBeenCalled();
      expect(s.tx.contentPackageRevision.updateMany).not.toHaveBeenCalled();
    });

    it('scopes every query of every method to the organization', async () => {
      const s = setup();
      await callEveryMethod(s.repository);
      const calls = allCalls(s);

      expect(calls).toHaveLength(21);
      for (const { method, args } of calls) {
        const scope = method === 'create' ? args.data : args.where;
        expect(scope).toHaveProperty('organizationId', ORG);
      }
    });
  });

  describe('projects', () => {
    it('P1 lists live projects of the organization by name', async () => {
      const { project, repository } = setup();
      await repository.listProjectsForOrganization(ORG, false);

      expect(onlyCall(project.findMany)).toEqual({
        where: { organizationId: ORG, archivedAt: null },
        orderBy: { name: 'asc' },
        select: PROJECT_SELECT,
      });
    });

    it('P1 lists archived projects of the organization', async () => {
      const { project, repository } = setup();
      await repository.listProjectsForOrganization(ORG, true);

      expect(onlyCall(project.findMany).where).toEqual({
        organizationId: ORG,
        archivedAt: { not: null },
      });
    });

    it('P2 reads a project by id and organization', async () => {
      const { project, repository } = setup();
      const row = { id: 'project-1', name: 'Launch' };
      project.findFirst.mockResolvedValue(row);

      await expect(
        repository.getProjectForOrganization(ORG, 'project-1')
      ).resolves.toBe(row);
      expect(onlyCall(project.findFirst)).toEqual({
        where: { id: 'project-1', organizationId: ORG },
        select: PROJECT_SELECT,
      });
    });

    it('creates a project from explicit fields only', async () => {
      const { project, repository } = setup();
      await repository.createProject({
        organizationId: ORG,
        name: 'Launch',
        createdById: 'user-1',
        // not part of the input type: must not reach Prisma
        ...({ archivedAt: ARCHIVED_AT, id: 'chosen' } as object),
      });

      expect(onlyCall(project.create)).toEqual({
        data: { organizationId: ORG, name: 'Launch', createdById: 'user-1' },
        select: PROJECT_SELECT,
      });
    });

    it('P3 renames only a live project of the organization', async () => {
      const { project, repository } = setup();
      project.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        repository.updateProjectName(ORG, 'project-1', 'Renamed')
      ).resolves.toEqual({ count: 0 });
      expect(onlyCall(project.updateMany)).toEqual({
        where: { id: 'project-1', organizationId: ORG, archivedAt: null },
        data: { name: 'Renamed' },
      });
      expect(project.update).not.toHaveBeenCalled();
    });

    it('P4 archives only a live project of the organization', async () => {
      const { project, repository } = setup();
      await repository.archiveProject(ORG, 'project-1', ARCHIVED_AT);

      expect(onlyCall(project.updateMany)).toEqual({
        where: { id: 'project-1', organizationId: ORG, archivedAt: null },
        data: { archivedAt: ARCHIVED_AT },
      });
    });

    it('P5 restores only an archived project of the organization', async () => {
      const { project, repository } = setup();
      await repository.restoreProject(ORG, 'project-1');

      expect(onlyCall(project.updateMany)).toEqual({
        where: {
          id: 'project-1',
          organizationId: ORG,
          archivedAt: { not: null },
        },
        data: { archivedAt: null },
      });
    });

    it('selects no creator, organization or package relation', async () => {
      const { project, repository } = setup();
      await repository.listProjectsForOrganization(ORG, false);
      await repository.getProjectForOrganization(ORG, 'project-1');

      for (const [args] of [
        ...project.findMany.mock.calls,
        ...project.findFirst.mock.calls,
      ]) {
        for (const field of [
          'createdBy',
          'createdById',
          'organization',
          'organizationId',
          'packages',
        ]) {
          expect(args.select).not.toHaveProperty(field);
        }
        expect(args).not.toHaveProperty('include');
      }
    });
  });

  describe('packages', () => {
    it('K1 lists live packages of the organization, newest first', async () => {
      const { contentPackage, repository } = setup();
      await repository.listPackagesForOrganization({
        organizationId: ORG,
        archived: false,
        skip: 40,
        take: 20,
      });

      const args = onlyCall(contentPackage.findMany);
      expect(args).toEqual({
        where: { organizationId: ORG, archivedAt: null },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        select: PACKAGE_SUMMARY_SELECT,
        skip: 40,
        take: 20,
      });
      expect(args.where.projectId).toBeUndefined();
    });

    it('K1 lists archived packages of the organization', async () => {
      const { contentPackage, repository } = setup();
      await repository.listPackagesForOrganization({
        organizationId: ORG,
        archived: true,
        skip: 0,
        take: 20,
      });

      expect(onlyCall(contentPackage.findMany).where).toEqual({
        organizationId: ORG,
        archivedAt: { not: null },
      });
    });

    it('K2 filters on the project when one is given', async () => {
      const { contentPackage, repository } = setup();
      await repository.listPackagesForOrganization({
        organizationId: ORG,
        archived: false,
        projectId: 'project-1',
        skip: 0,
        take: 20,
      });

      expect(onlyCall(contentPackage.findMany).where).toEqual({
        organizationId: ORG,
        archivedAt: null,
        projectId: 'project-1',
      });
    });

    it('counts packages with the same filter as the list', async () => {
      const { contentPackage, repository } = setup();
      contentPackage.count.mockResolvedValue(3);

      await expect(
        repository.countPackagesForOrganization({
          organizationId: ORG,
          archived: true,
          projectId: 'project-1',
        })
      ).resolves.toBe(3);
      expect(onlyCall(contentPackage.count)).toEqual({
        where: {
          organizationId: ORG,
          archivedAt: { not: null },
          projectId: 'project-1',
        },
      });
    });

    it('K3 reads a package by id and organization, with its draft', async () => {
      const { contentPackage, repository } = setup();
      const row = { id: 'package-1', draft: '{}' };
      contentPackage.findFirst.mockResolvedValue(row);

      await expect(
        repository.getPackageForOrganization(ORG, 'package-1')
      ).resolves.toBe(row);
      expect(onlyCall(contentPackage.findFirst)).toEqual({
        where: { id: 'package-1', organizationId: ORG },
        select: PACKAGE_DETAIL_SELECT,
      });
    });

    it('K4 creates a package from explicit fields only', async () => {
      const { contentPackage, repository } = setup();
      await repository.createPackage({
        organizationId: ORG,
        projectId: 'project-1',
        name: 'Post',
        draft: '{"schemaVersion":1}',
        createdById: 'user-1',
        // not part of the input type: must not reach Prisma
        ...({ draftVersion: 99, latestRevisionNumber: 5 } as object),
      });

      expect(onlyCall(contentPackage.create)).toEqual({
        data: {
          organizationId: ORG,
          projectId: 'project-1',
          name: 'Post',
          draft: '{"schemaVersion":1}',
          createdById: 'user-1',
        },
        select: PACKAGE_SUMMARY_SELECT,
      });
    });

    it('K4 creates a package without a project', async () => {
      const { contentPackage, repository } = setup();
      await repository.createPackage({
        organizationId: ORG,
        projectId: null,
        name: 'Post',
        draft: '{}',
        createdById: 'user-1',
      });

      expect(onlyCall(contentPackage.create).data.projectId).toBeNull();
    });

    it('K5 updates metadata of a live package of the organization only', async () => {
      const { contentPackage, repository } = setup();
      await repository.updatePackageMetadata({
        organizationId: ORG,
        packageId: 'package-1',
        name: 'Renamed',
        projectId: null,
      });

      expect(onlyCall(contentPackage.updateMany)).toEqual({
        where: { id: 'package-1', organizationId: ORG, archivedAt: null },
        data: { name: 'Renamed', projectId: null },
      });
      expect(contentPackage.update).not.toHaveBeenCalled();
    });

    it('K5 leaves fields that are not given unchanged', async () => {
      const { contentPackage, repository } = setup();
      await repository.updatePackageMetadata({
        organizationId: ORG,
        packageId: 'package-1',
        projectId: 'project-2',
        // not part of the input type: must not reach Prisma
        ...({ draft: 'x', organizationId: ORG } as object),
      });

      const { data } = onlyCall(contentPackage.updateMany);
      expect(data.name).toBeUndefined();
      expect(data.projectId).toBe('project-2');
      expect(Object.keys(data).sort()).toEqual(['name', 'projectId']);
    });

    it('K6 saves a draft only over the base version of a live package', async () => {
      const { contentPackage, repository } = setup();
      await expect(
        repository.saveDraftCompareAndSwap({
          organizationId: ORG,
          packageId: 'package-1',
          baseDraftVersion: 3,
          draft: '{"schemaVersion":1}',
        })
      ).resolves.toEqual({ count: 1 });

      expect(onlyCall(contentPackage.updateMany)).toEqual({
        where: {
          id: 'package-1',
          organizationId: ORG,
          archivedAt: null,
          draftVersion: 3,
        },
        data: {
          draft: '{"schemaVersion":1}',
          draftVersion: { increment: 1 },
        },
      });
    });

    it('K6 reports a lost compare-and-swap as count 0 without retrying', async () => {
      const { contentPackage, repository } = setup();
      contentPackage.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        repository.saveDraftCompareAndSwap({
          organizationId: ORG,
          packageId: 'package-1',
          baseDraftVersion: 3,
          draft: '{}',
        })
      ).resolves.toEqual({ count: 0 });
      expect(contentPackage.updateMany).toHaveBeenCalledTimes(1);
      expect(contentPackage.findFirst).not.toHaveBeenCalled();
      expect(contentPackage.update).not.toHaveBeenCalled();
    });

    it('K7 reads the write state by id and organization, nothing else', async () => {
      const { contentPackage, repository } = setup();
      const row = { draftVersion: 4, archivedAt: null as Date | null };
      contentPackage.findFirst.mockResolvedValue(row);

      await expect(
        repository.getPackageWriteStateForOrganization(ORG, 'package-1')
      ).resolves.toBe(row);
      expect(onlyCall(contentPackage.findFirst)).toEqual({
        where: { id: 'package-1', organizationId: ORG },
        select: { draftVersion: true, archivedAt: true },
      });
    });

    it('K8 archives only a live package of the organization', async () => {
      const { contentPackage, repository } = setup();
      await repository.archivePackage(ORG, 'package-1', ARCHIVED_AT);

      expect(onlyCall(contentPackage.updateMany)).toEqual({
        where: { id: 'package-1', organizationId: ORG, archivedAt: null },
        data: { archivedAt: ARCHIVED_AT },
      });
    });

    it('K8 restores only an archived package of the organization', async () => {
      const { contentPackage, repository } = setup();
      await repository.restorePackage(ORG, 'package-1');

      expect(onlyCall(contentPackage.updateMany)).toEqual({
        where: {
          id: 'package-1',
          organizationId: ORG,
          archivedAt: { not: null },
        },
        data: { archivedAt: null },
      });
    });

    it('K8 archiving touches nothing but the package', async () => {
      const s = setup();
      await s.repository.archivePackage(ORG, 'package-1', ARCHIVED_AT);
      await s.repository.archiveProject(ORG, 'project-1', ARCHIVED_AT);

      expect(
        allCalls(s).map(({ name, method }) => `${name}.${method}`)
      ).toEqual(['project.updateMany', 'package.updateMany']);
    });

    it('never selects the draft in the package list', async () => {
      const { contentPackage, repository } = setup();
      await repository.listPackagesForOrganization({
        organizationId: ORG,
        archived: false,
        skip: 0,
        take: 20,
      });
      const args = onlyCall(contentPackage.findMany);

      expect(args.select).not.toHaveProperty('draft');
      for (const field of [
        'organization',
        'project',
        'createdBy',
        'revisions',
        'handoffs',
      ]) {
        expect(args.select).not.toHaveProperty(field);
      }
      expect(args).not.toHaveProperty('include');
    });
  });

  describe('revisions', () => {
    it('R1 lists revisions of the package and organization, newest first', async () => {
      const { revision, repository } = setup();
      await repository.listRevisionsForPackage({
        organizationId: ORG,
        packageId: 'package-1',
        skip: 20,
        take: 10,
      });

      expect(onlyCall(revision.findMany)).toEqual({
        where: { organizationId: ORG, packageId: 'package-1' },
        orderBy: { revisionNumber: 'desc' },
        select: REVISION_SUMMARY_SELECT,
        skip: 20,
        take: 10,
      });
    });

    it('R2 counts revisions of the package and organization', async () => {
      const { revision, repository } = setup();
      revision.count.mockResolvedValue(4);

      await expect(
        repository.countRevisionsForPackage(ORG, 'package-1')
      ).resolves.toBe(4);
      expect(onlyCall(revision.count)).toEqual({
        where: { organizationId: ORG, packageId: 'package-1' },
      });
    });

    it('R3 reads a revision by id, package and organization, with content', async () => {
      const { revision, repository } = setup();
      const row = { id: 'revision-1', content: CONTENT };
      revision.findFirst.mockResolvedValue(row);

      await expect(
        repository.getRevisionForPackage(ORG, 'package-1', 'revision-1')
      ).resolves.toBe(row);
      expect(onlyCall(revision.findFirst)).toEqual({
        where: {
          id: 'revision-1',
          packageId: 'package-1',
          organizationId: ORG,
        },
        select: REVISION_DETAIL_SELECT,
      });
    });

    it('R4 reads the latest revision of the package and organization', async () => {
      const { revision, repository } = setup();
      await repository.getLatestRevisionForPackage(ORG, 'package-1');

      expect(onlyCall(revision.findFirst)).toEqual({
        where: { packageId: 'package-1', organizationId: ORG },
        orderBy: { revisionNumber: 'desc' },
        select: REVISION_DETAIL_SELECT,
      });
    });

    it('never selects the content in the revision list', async () => {
      const { revision, repository } = setup();
      await repository.listRevisionsForPackage({
        organizationId: ORG,
        packageId: 'package-1',
        skip: 0,
        take: 20,
      });
      const { select } = onlyCall(revision.findMany);

      expect(select).not.toHaveProperty('content');
      expect(select).not.toHaveProperty('package');
      expect(select).not.toHaveProperty('organization');
    });

    it('R5 selects only id and name of the creator', async () => {
      const { revision, repository } = setup();
      await repository.listRevisionsForPackage({
        organizationId: ORG,
        packageId: 'package-1',
        skip: 0,
        take: 20,
      });
      await repository.getRevisionForPackage(ORG, 'package-1', 'revision-1');
      await repository.getLatestRevisionForPackage(ORG, 'package-1');

      const selects = [
        ...revision.findMany.mock.calls,
        ...revision.findFirst.mock.calls,
      ].map(([args]) => args.select);
      expect(selects).toHaveLength(3);
      for (const select of selects) {
        expect(select.createdBy).toStrictEqual({
          select: { id: true, name: true },
        });
        expect(select).not.toHaveProperty('createdById');
      }
    });
  });

  // Prisma finds nothing in all cases: the row belongs to org-b or does not
  // exist. The repository must answer both identically, with one query
  describe('no existence leak', () => {
    it('returns null for a foreign or missing project after one query', async () => {
      const s = setup();
      await expect(
        s.repository.getProjectForOrganization(ORG, 'project-1')
      ).resolves.toBeNull();
      expect(allCalls(s)).toHaveLength(1);
      expect(s.project.findFirst).toHaveBeenCalledTimes(1);
    });

    it('returns null for a foreign or missing package after one query', async () => {
      const s = setup();
      await expect(
        s.repository.getPackageForOrganization(ORG, 'package-1')
      ).resolves.toBeNull();
      await expect(
        s.repository.getPackageWriteStateForOrganization(ORG, 'package-1')
      ).resolves.toBeNull();
      expect(allCalls(s)).toHaveLength(2);
      expect(s.contentPackage.findFirst).toHaveBeenCalledTimes(2);
    });

    it('returns null for a foreign or missing revision after one query', async () => {
      const s = setup();
      await expect(
        s.repository.getRevisionForPackage(ORG, 'package-1', 'revision-1')
      ).resolves.toBeNull();
      await expect(
        s.repository.getLatestRevisionForPackage(ORG, 'package-1')
      ).resolves.toBeNull();
      expect(allCalls(s)).toHaveLength(2);
      expect(s.revision.findFirst).toHaveBeenCalledTimes(2);
    });
  });

  describe('createRevisionWithCompareAndSwap', () => {
    it('T1 claims the next number only while draft and revision are current', async () => {
      const { tx, $transaction, repository } = setup();
      await repository.createRevisionWithCompareAndSwap(REVISION_INPUT);

      expect($transaction).toHaveBeenCalledTimes(1);
      expect(onlyCall(tx.contentPackage.updateMany)).toEqual({
        where: {
          id: 'package-1',
          organizationId: ORG,
          archivedAt: null,
          draftVersion: 7,
          latestRevisionNumber: 2,
        },
        // T5: incremented in the database, never set to a caller value
        data: { latestRevisionNumber: { increment: 1 } },
      });
    });

    it('T2 creates no revision when the compare-and-swap fails', async () => {
      const s = setup();
      s.tx.contentPackage.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        s.repository.createRevisionWithCompareAndSwap(REVISION_INPUT)
      ).resolves.toEqual({ created: false, reason: 'compare-and-swap-failed' });
      expect(s.tx.contentPackageRevision.create).not.toHaveBeenCalled();
      expect(allCalls(s)).toHaveLength(1);
    });

    it('T3 creates the revision with the next number when it succeeds', async () => {
      const { tx, repository } = setup();
      const created = { id: 'revision-3', revisionNumber: 3 };
      tx.contentPackageRevision.create.mockResolvedValue(created);

      await expect(
        repository.createRevisionWithCompareAndSwap(REVISION_INPUT)
      ).resolves.toEqual({ created: true, revision: created });
      expect(onlyCall(tx.contentPackageRevision.create)).toEqual({
        data: {
          organizationId: ORG,
          packageId: 'package-1',
          revisionNumber: 3,
          schemaVersion: 1,
          content: CONTENT,
          contentHash: 'a'.repeat(64),
          origin: 'manual',
          sourceDraftVersion: 7,
          createdById: 'user-1',
        },
        select: {
          id: true,
          packageId: true,
          revisionNumber: true,
          schemaVersion: true,
          contentHash: true,
          origin: true,
          sourceDraftVersion: true,
          createdAt: true,
        },
      });
    });

    it('T3 runs both writes inside the transaction, in order', async () => {
      const s = setup();
      await s.repository.createRevisionWithCompareAndSwap(REVISION_INPUT);

      expect(
        allCalls(s).map(({ name, method }) => `${name}.${method}`)
      ).toEqual(['tx.package.updateMany', 'tx.revision.create']);
      expect(
        s.tx.contentPackage.updateMany.mock.invocationCallOrder[0]
      ).toBeLessThan(
        s.tx.contentPackageRevision.create.mock.invocationCallOrder[0]
      );
    });

    it('T4 stores the canonical content byte for byte', async () => {
      const { tx, repository } = setup();
      await repository.createRevisionWithCompareAndSwap(REVISION_INPUT);

      const { data } = onlyCall(tx.contentPackageRevision.create);
      expect(data.content).toBe(CONTENT);
      expect(Buffer.from(data.content, 'utf8')).toEqual(
        Buffer.from(CONTENT, 'utf8')
      );
    });

    it('keeps the full content and the creator row out of the result', async () => {
      const { tx, repository } = setup();
      await repository.createRevisionWithCompareAndSwap(REVISION_INPUT);

      const { select } = onlyCall(tx.contentPackageRevision.create);
      expect(select).not.toHaveProperty('content');
      expect(select).not.toHaveProperty('createdBy');
    });

    it('lets a failed revision insert reject the transaction', async () => {
      const { tx, repository } = setup();
      const error = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
      });
      tx.contentPackageRevision.create.mockRejectedValue(error);

      await expect(
        repository.createRevisionWithCompareAndSwap(REVISION_INPUT)
      ).rejects.toBe(error);
    });
  });
});
