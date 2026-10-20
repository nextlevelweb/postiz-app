import { HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.service';
import { ContentStudioMediaService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.media.service';
import { ContentStudioGroundingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.grounding.service';
import { ContentStudioReviewService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.service';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';
import * as canonical from '@gitroom/nestjs-libraries/content-studio/canonical.json';

// The real MediaService pulls in uploads, Redis and Temporal at import time;
// ContentStudioMediaService is mocked in every test below
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);

// No database: the repository is mocked, so these tests pin the business
// rules and the errors the API answers with

const ORG = 'org-a';
const USER = 'user-1';
const PROJECT_ID = '3b241101-e2bb-4255-8caf-4136c566a962';
const PACKAGE_ID = 'package-1';
const T = new Date('2026-10-12T10:00:00.000Z');
const ARCHIVED = new Date('2026-10-11T10:00:00.000Z');

const project = (archivedAt: Date | null = null) => ({
  id: PROJECT_ID,
  name: 'Launch',
  archivedAt,
  createdAt: T,
  updatedAt: T,
});

const DRAFT = {
  schemaVersion: 1,
  copy: { global: { thread: [{ id: 'main', text: 'Hello', mediaIds: [] }] } },
};
const packageRow = (archivedAt: Date | null = null) => ({
  id: PACKAGE_ID,
  name: 'Post',
  projectId: null as string | null,
  draft: JSON.stringify(DRAFT),
  draftVersion: 4,
  latestRevisionNumber: 0,
  archivedAt,
  createdAt: T,
  updatedAt: T,
});
const PACKAGE_DETAIL_KEYS = [
  'archivedAt',
  'createdAt',
  'draft',
  'draftVersion',
  'id',
  'latestRevisionNumber',
  'media',
  'name',
  'projectId',
  'updatedAt',
];

interface RevisionInput {
  packageId: string;
  expectedDraftVersion: number;
  expectedLatestRevisionNumber: number;
  schemaVersion: number;
  content: string;
  contentHash: string;
  origin: string;
}
type RevisionResult =
  | { created: true; revision: object }
  | { created: false; reason: 'compare-and-swap-failed' };

const setup = () => {
  const repository = {
    listProjectsForOrganization: jest.fn().mockResolvedValue([]),
    getProjectForOrganization: jest.fn().mockResolvedValue(null),
    createProject: jest.fn().mockResolvedValue(project()),
    updateProjectName: jest.fn().mockResolvedValue({ count: 1 }),
    archiveProject: jest.fn().mockResolvedValue({ count: 1 }),
    restoreProject: jest.fn().mockResolvedValue({ count: 1 }),
    listPackagesForOrganization: jest.fn().mockResolvedValue([]),
    countPackagesForOrganization: jest.fn().mockResolvedValue(0),
    getPackageForOrganization: jest.fn().mockResolvedValue(null),
    createPackage: jest.fn(
      async (data: {
        name: string;
        projectId: string | null;
        draft: string;
      }) => ({
        id: 'package-new',
        name: data.name,
        projectId: data.projectId,
        draftVersion: 1,
        latestRevisionNumber: 0,
        archivedAt: null as Date | null,
        createdAt: T,
        updatedAt: T,
      })
    ),
    updatePackageMetadata: jest.fn().mockResolvedValue({ count: 1 }),
    saveDraftCompareAndSwap: jest.fn().mockResolvedValue({ count: 1 }),
    getPackageWriteStateForOrganization: jest.fn().mockResolvedValue(null),
    archivePackage: jest.fn().mockResolvedValue({ count: 1 }),
    restorePackage: jest.fn().mockResolvedValue({ count: 1 }),
    getLatestRevisionForPackage: jest.fn().mockResolvedValue(null),
    createRevisionWithCompareAndSwap: jest.fn(
      async (input: RevisionInput): Promise<RevisionResult> => ({
        created: true,
        revision: {
          id: `revision-${input.expectedLatestRevisionNumber + 1}`,
          packageId: input.packageId,
          revisionNumber: input.expectedLatestRevisionNumber + 1,
          schemaVersion: input.schemaVersion,
          contentHash: input.contentHash,
          origin: input.origin,
          sourceDraftVersion: input.expectedDraftVersion,
          createdAt: T,
        },
      })
    ),
    listRevisionsForPackage: jest.fn().mockResolvedValue([]),
    countRevisionsForPackage: jest.fn().mockResolvedValue(0),
    getRevisionForPackage: jest.fn().mockResolvedValue(null),
  };
  const media = {
    getPreviewMap: jest.fn(async () => ({})),
    resolveForHandoff: jest.fn(),
  };
  const grounding = {
    verifyDraftGrounding: jest.fn(async () => undefined),
  };
  // approval binding (P5-05) is the review service's: a revision without a
  // review unless a test says otherwise
  const reviews = {
    getRevisionApprovalStatuses: jest.fn(
      async (input: { revisionIds: string[] }) =>
        new Map(input.revisionIds.map((id) => [id, NOT_REVIEWED_SUMMARY]))
    ),
    getRevisionApprovalStatus: jest.fn(
      async (input: { targetType: string; targetRevisionId: string }) =>
        notReviewedStatus(input.targetRevisionId)
    ),
  };
  const service = new ContentStudioService(
    repository as unknown as ContentStudioRepository,
    media as unknown as ContentStudioMediaService,
    grounding as unknown as ContentStudioGroundingService,
    reviews as unknown as ContentStudioReviewService
  );
  return { repository, media, grounding, reviews, service };
};

// Content Studio answers with plain HttpExceptions only: never the 403
// subclass, which logs the user out
const rejection = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(HttpException);
  expect((error as object).constructor).toBe(HttpException);
  const http = error as HttpException;
  return { status: http.getStatus(), body: http.getResponse() };
};

const NOT_FOUND = {
  status: 404,
  body: { msg: 'Content Studio item not found', code: 'CS_NOT_FOUND' },
};
const NOT_REVIEWED_SUMMARY = { approved: false, state: 'NOT_REVIEWED' };
const notReviewedStatus = (id: string) => ({
  targetType: 'PACKAGE_REVISION',
  targetRevisionId: id,
  targetRevisionNumber: 1,
  targetContentHash: 'a'.repeat(64),
  approved: false,
  state: 'NOT_REVIEWED',
  reviewId: null,
  approvalVersion: 0,
  currentDecision: null,
});
const PROJECT_ARCHIVED = {
  status: 409,
  body: { msg: 'This project is archived', code: 'CS_PROJECT_ARCHIVED' },
};
const PACKAGE_ARCHIVED = {
  status: 409,
  body: { msg: 'This package is archived', code: 'CS_PACKAGE_ARCHIVED' },
};
const INVALID_REQUEST = {
  status: 400,
  body: {
    msg: 'The Content Studio request is invalid',
    code: 'CS_INVALID_REQUEST',
  },
};
const DRAFT_INVALID = {
  status: 400,
  body: {
    msg: 'The Content Studio draft is invalid',
    code: 'CS_DRAFT_INVALID',
  },
};
const DRAFT_TOO_LARGE = {
  status: 400,
  body: {
    msg: 'The Content Studio draft is too large',
    code: 'CS_DRAFT_TOO_LARGE',
  },
};
const conflict = (currentDraftVersion: number) => ({
  status: 409,
  body: {
    msg: 'This Content Studio draft has changed',
    code: 'CS_DRAFT_VERSION_CONFLICT',
    currentDraftVersion,
  },
});

describe('ContentStudioService projects', () => {
  it('P1 lists active projects as the repository returns them', async () => {
    const { repository, service } = setup();
    const rows = [project()];
    repository.listProjectsForOrganization.mockResolvedValue(rows);

    await expect(service.listProjects(ORG, false)).resolves.toBe(rows);
    expect(repository.listProjectsForOrganization).toHaveBeenCalledWith(
      ORG,
      false
    );
  });

  it('P2 lists archived projects', async () => {
    const { repository, service } = setup();
    await service.listProjects(ORG, true);

    expect(repository.listProjectsForOrganization).toHaveBeenCalledWith(
      ORG,
      true
    );
  });

  it('P3 creates a project with a trimmed name for the organization and user', async () => {
    const { repository, service } = setup();

    await expect(
      service.createProject(ORG, USER, '  Launch  ')
    ).resolves.toEqual(project());
    expect(repository.createProject).toHaveBeenCalledWith({
      organizationId: ORG,
      name: 'Launch',
      createdById: USER,
    });
  });

  it('P3 rejects a blank project name', async () => {
    const { repository, service } = setup();

    expect(await rejection(service.createProject(ORG, USER, ' \t\n'))).toEqual(
      INVALID_REQUEST
    );
    expect(repository.createProject).not.toHaveBeenCalled();
  });

  it('P4 renames an active project and returns it', async () => {
    const { repository, service } = setup();
    const renamed = { ...project(), name: 'Renamed' };
    repository.getProjectForOrganization.mockResolvedValue(renamed);

    await expect(
      service.updateProjectName(ORG, PROJECT_ID, ' Renamed ')
    ).resolves.toBe(renamed);
    expect(repository.updateProjectName).toHaveBeenCalledWith(
      ORG,
      PROJECT_ID,
      'Renamed'
    );
    expect(repository.getProjectForOrganization).toHaveBeenCalledWith(
      ORG,
      PROJECT_ID
    );
  });

  it('P4 rejects a blank new name without writing', async () => {
    const { repository, service } = setup();

    expect(
      await rejection(service.updateProjectName(ORG, PROJECT_ID, '   '))
    ).toEqual(INVALID_REQUEST);
    expect(repository.updateProjectName).not.toHaveBeenCalled();
  });

  it('P5 answers 404 for a missing or foreign project', async () => {
    const { repository, service } = setup();
    repository.updateProjectName.mockResolvedValue({ count: 0 });

    expect(
      await rejection(service.updateProjectName(ORG, PROJECT_ID, 'Renamed'))
    ).toEqual(NOT_FOUND);
  });

  it('P6 refuses to rename an archived project', async () => {
    const { repository, service } = setup();
    repository.updateProjectName.mockResolvedValue({ count: 0 });
    repository.getProjectForOrganization.mockResolvedValue(project(ARCHIVED));

    expect(
      await rejection(service.updateProjectName(ORG, PROJECT_ID, 'Renamed'))
    ).toEqual(PROJECT_ARCHIVED);
  });

  it('P7 archives with a time set by the server and returns the project', async () => {
    const { repository, service } = setup();
    const archived = project(ARCHIVED);
    repository.getProjectForOrganization.mockResolvedValue(archived);
    const before = Date.now();

    await expect(service.archiveProject(ORG, PROJECT_ID)).resolves.toBe(
      archived
    );
    const [org, id, at] = repository.archiveProject.mock.calls[0];
    expect([org, id]).toEqual([ORG, PROJECT_ID]);
    expect(at).toBeInstanceOf(Date);
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
    expect(at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('P8 archiving an archived project returns it unchanged', async () => {
    const { repository, service } = setup();
    repository.archiveProject.mockResolvedValue({ count: 0 });
    repository.getProjectForOrganization.mockResolvedValue(project(ARCHIVED));

    await expect(service.archiveProject(ORG, PROJECT_ID)).resolves.toEqual(
      project(ARCHIVED)
    );
  });

  it('P9 archiving a missing project answers 404', async () => {
    const { repository, service } = setup();
    repository.archiveProject.mockResolvedValue({ count: 0 });

    expect(await rejection(service.archiveProject(ORG, PROJECT_ID))).toEqual(
      NOT_FOUND
    );
  });

  it('P10 restores an archived project', async () => {
    const { repository, service } = setup();
    repository.getProjectForOrganization.mockResolvedValue(project());

    await expect(service.restoreProject(ORG, PROJECT_ID)).resolves.toEqual(
      project()
    );
    expect(repository.restoreProject).toHaveBeenCalledWith(ORG, PROJECT_ID);
  });

  it('P11 restoring an active project returns it unchanged', async () => {
    const { repository, service } = setup();
    repository.restoreProject.mockResolvedValue({ count: 0 });
    repository.getProjectForOrganization.mockResolvedValue(project());

    await expect(service.restoreProject(ORG, PROJECT_ID)).resolves.toEqual(
      project()
    );
  });

  it('P12 restoring a missing project answers 404', async () => {
    const { repository, service } = setup();
    repository.restoreProject.mockResolvedValue({ count: 0 });

    expect(await rejection(service.restoreProject(ORG, PROJECT_ID))).toEqual(
      NOT_FOUND
    );
  });
});

describe('ContentStudioService packages', () => {
  it('K1 creates an untitled package with one server-generated item', async () => {
    const { repository, service } = setup();

    const created = await service.createPackage({
      organizationId: ORG,
      userId: USER,
    });

    const data = repository.createPackage.mock.calls[0][0];
    expect(data).toEqual({
      organizationId: ORG,
      projectId: null,
      name: 'Untitled package',
      draft: expect.any(String),
      createdById: USER,
    });
    const stored = JSON.parse(data.draft);
    expect(parseContentPackageDraft(stored)).toEqual(stored);
    expect(stored.copy.global.thread).toHaveLength(1);
    expect(stored.copy.global.thread[0]).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{11}$/),
      text: '',
      mediaIds: [],
    });
    expect(created.draft).toEqual(stored);
    expect(Object.keys(created).sort()).toEqual(PACKAGE_DETAIL_KEYS);
    expect(created).toMatchObject({ draftVersion: 1, latestRevisionNumber: 0 });
    expect(repository.getProjectForOrganization).not.toHaveBeenCalled();
  });

  it('K1 generates a new item id for every package', async () => {
    const { repository, service } = setup();
    for (let i = 0; i < 20; i++) {
      await service.createPackage({ organizationId: ORG, userId: USER });
    }

    const ids = repository.createPackage.mock.calls.map(
      ([data]) => JSON.parse(data.draft).copy.global.thread[0].id
    );
    expect(new Set(ids).size).toBe(20);
  });

  it('K1 names a package with a blank name "Untitled package"', async () => {
    const { repository, service } = setup();
    await service.createPackage({
      organizationId: ORG,
      userId: USER,
      name: '   ',
    });

    expect(repository.createPackage.mock.calls[0][0].name).toBe(
      'Untitled package'
    );
  });

  it('K2 trims the package name', async () => {
    const { repository, service } = setup();
    await service.createPackage({
      organizationId: ORG,
      userId: USER,
      name: '  Spring launch ',
    });

    expect(repository.createPackage.mock.calls[0][0].name).toBe(
      'Spring launch'
    );
  });

  it('K3 attaches an active project of the organization', async () => {
    const { repository, service } = setup();
    repository.getProjectForOrganization.mockResolvedValue(project());

    await service.createPackage({
      organizationId: ORG,
      userId: USER,
      projectId: PROJECT_ID,
    });
    expect(repository.getProjectForOrganization).toHaveBeenCalledWith(
      ORG,
      PROJECT_ID
    );
    expect(repository.createPackage.mock.calls[0][0].projectId).toBe(
      PROJECT_ID
    );
  });

  it('K4 answers 404 for a foreign or missing project and creates nothing', async () => {
    const { repository, service } = setup();

    expect(
      await rejection(
        service.createPackage({
          organizationId: ORG,
          userId: USER,
          projectId: PROJECT_ID,
        })
      )
    ).toEqual(NOT_FOUND);
    expect(repository.getProjectForOrganization).toHaveBeenCalledWith(
      ORG,
      PROJECT_ID
    );
    expect(repository.createPackage).not.toHaveBeenCalled();
  });

  it('K5 refuses an archived project and creates nothing', async () => {
    const { repository, service } = setup();
    repository.getProjectForOrganization.mockResolvedValue(project(ARCHIVED));

    expect(
      await rejection(
        service.createPackage({
          organizationId: ORG,
          userId: USER,
          projectId: PROJECT_ID,
        })
      )
    ).toEqual(PROJECT_ARCHIVED);
    expect(repository.createPackage).not.toHaveBeenCalled();
  });

  it('K6 lists the first page of active packages', async () => {
    const { repository, service } = setup();
    const rows = [{ id: PACKAGE_ID }];
    repository.listPackagesForOrganization.mockResolvedValue(rows);
    repository.countPackagesForOrganization.mockResolvedValue(41);

    await expect(
      service.listPackages({ organizationId: ORG, archived: false, page: 1 })
    ).resolves.toEqual({ pages: 3, results: rows });
    expect(repository.listPackagesForOrganization).toHaveBeenCalledWith({
      organizationId: ORG,
      archived: false,
      projectId: undefined,
      skip: 0,
      take: 20,
    });
    expect(repository.countPackagesForOrganization).toHaveBeenCalledWith({
      organizationId: ORG,
      archived: false,
      projectId: undefined,
    });
    expect(repository.getProjectForOrganization).not.toHaveBeenCalled();
  });

  it('K7 skips 40 rows for page 3 and reports 0 pages when empty', async () => {
    const { repository, service } = setup();

    await expect(
      service.listPackages({ organizationId: ORG, archived: true, page: 3 })
    ).resolves.toEqual({ pages: 0, results: [] });
    expect(repository.listPackagesForOrganization.mock.calls[0][0]).toEqual(
      expect.objectContaining({ archived: true, skip: 40, take: 20 })
    );
  });

  it('K8 filters on a project of the organization, archived or not', async () => {
    const { repository, service } = setup();
    repository.getProjectForOrganization.mockResolvedValue(project(ARCHIVED));

    await service.listPackages({
      organizationId: ORG,
      archived: false,
      projectId: PROJECT_ID,
      page: 1,
    });
    expect(repository.getProjectForOrganization).toHaveBeenCalledWith(
      ORG,
      PROJECT_ID
    );
    expect(
      repository.listPackagesForOrganization.mock.calls[0][0].projectId
    ).toBe(PROJECT_ID);
  });

  it('K8 answers 404 when filtering on a foreign or missing project', async () => {
    const { repository, service } = setup();

    expect(
      await rejection(
        service.listPackages({
          organizationId: ORG,
          archived: false,
          projectId: PROJECT_ID,
          page: 1,
        })
      )
    ).toEqual(NOT_FOUND);
    expect(repository.listPackagesForOrganization).not.toHaveBeenCalled();
    expect(repository.countPackagesForOrganization).not.toHaveBeenCalled();
  });

  it('K9 returns the package with its draft parsed into an object', async () => {
    const { repository, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(packageRow());

    const detail = await service.getPackage(ORG, PACKAGE_ID);
    expect(detail).toEqual({
      id: PACKAGE_ID,
      name: 'Post',
      projectId: null,
      draft: DRAFT,
      draftVersion: 4,
      latestRevisionNumber: 0,
      archivedAt: null,
      createdAt: T,
      updatedAt: T,
      media: {},
    });
    expect(typeof detail.draft).toBe('object');
    expect(repository.getPackageForOrganization).toHaveBeenCalledWith(
      ORG,
      PACKAGE_ID
    );
  });

  it('K9 leaves organization and creator out of the detail', async () => {
    const { repository, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue({
      ...packageRow(),
      organizationId: ORG,
      createdById: USER,
    });

    const detail = await service.getPackage(ORG, PACKAGE_ID);
    expect(Object.keys(detail).sort()).toEqual(PACKAGE_DETAIL_KEYS);
  });

  it('K10 answers 404 for a foreign or missing package', async () => {
    const { service } = setup();

    expect(await rejection(service.getPackage(ORG, PACKAGE_ID))).toEqual(
      NOT_FOUND
    );
  });

  it.each([
    ['an unknown schema version', '{"schemaVersion":999}'],
    ['broken JSON', '{"schemaVersion":1,"copy":'],
    [
      'an unknown field',
      '{"schemaVersion":1,"copy":{"global":{"thread":[{"id":"a","text":"secret text","mediaIds":[],"html":"<b>"}]}}}',
    ],
  ])('K11 answers 500 for a stored draft with %s', async (_name, stored) => {
    const { repository, service } = setup();
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    repository.getPackageForOrganization.mockResolvedValue({
      ...packageRow(),
      draft: stored,
    });

    const { status, body } = await rejection(
      service.getPackage(ORG, PACKAGE_ID)
    );
    expect(status).toBe(500);
    expect(body).toEqual({
      msg: 'Stored Content Studio draft is invalid',
      code: 'CS_STORED_DRAFT_INVALID',
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0].join(' ')).toContain(PACKAGE_ID);
    for (const output of [JSON.stringify(body), log.mock.calls[0].join(' ')]) {
      expect(output).not.toContain('secret');
      expect(output).not.toContain('schemaVersion');
    }
  });

  it('K12 renames a package with a trimmed name and returns the detail', async () => {
    const { repository, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(packageRow());

    const detail = await service.updatePackageMetadata({
      organizationId: ORG,
      packageId: PACKAGE_ID,
      name: '  Renamed ',
    });
    expect(repository.updatePackageMetadata).toHaveBeenCalledWith({
      organizationId: ORG,
      packageId: PACKAGE_ID,
      name: 'Renamed',
      projectId: undefined,
    });
    expect(detail.draft).toEqual(DRAFT);
    expect(repository.getProjectForOrganization).not.toHaveBeenCalled();
  });

  it('K13 checks a project before attaching it', async () => {
    const { repository, service } = setup();
    repository.getProjectForOrganization.mockResolvedValue(project());
    repository.getPackageForOrganization.mockResolvedValue(packageRow());

    await service.updatePackageMetadata({
      organizationId: ORG,
      packageId: PACKAGE_ID,
      projectId: PROJECT_ID,
    });
    expect(repository.getProjectForOrganization).toHaveBeenCalledWith(
      ORG,
      PROJECT_ID
    );
    expect(
      repository.getProjectForOrganization.mock.invocationCallOrder[0]
    ).toBeLessThan(
      repository.updatePackageMetadata.mock.invocationCallOrder[0]
    );
    expect(repository.updatePackageMetadata.mock.calls[0][0].projectId).toBe(
      PROJECT_ID
    );
  });

  it('K14 detaches the project without looking one up', async () => {
    const { repository, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(packageRow());

    await service.updatePackageMetadata({
      organizationId: ORG,
      packageId: PACKAGE_ID,
      projectId: null,
    });
    expect(repository.updatePackageMetadata).toHaveBeenCalledWith({
      organizationId: ORG,
      packageId: PACKAGE_ID,
      name: undefined,
      projectId: null,
    });
    expect(repository.getProjectForOrganization).not.toHaveBeenCalled();
  });

  it('K15 answers 404 for a foreign project and updates nothing', async () => {
    const { repository, service } = setup();

    expect(
      await rejection(
        service.updatePackageMetadata({
          organizationId: ORG,
          packageId: PACKAGE_ID,
          projectId: PROJECT_ID,
        })
      )
    ).toEqual(NOT_FOUND);
    expect(repository.updatePackageMetadata).not.toHaveBeenCalled();
  });

  it('K16 refuses an archived project and updates nothing', async () => {
    const { repository, service } = setup();
    repository.getProjectForOrganization.mockResolvedValue(project(ARCHIVED));

    expect(
      await rejection(
        service.updatePackageMetadata({
          organizationId: ORG,
          packageId: PACKAGE_ID,
          projectId: PROJECT_ID,
        })
      )
    ).toEqual(PROJECT_ARCHIVED);
    expect(repository.updatePackageMetadata).not.toHaveBeenCalled();
  });

  it('K17 refuses to change an archived package', async () => {
    const { repository, service } = setup();
    repository.updatePackageMetadata.mockResolvedValue({ count: 0 });
    repository.getPackageForOrganization.mockResolvedValue(
      packageRow(ARCHIVED)
    );

    expect(
      await rejection(
        service.updatePackageMetadata({
          organizationId: ORG,
          packageId: PACKAGE_ID,
          name: 'Renamed',
        })
      )
    ).toEqual(PACKAGE_ARCHIVED);
  });

  it('K18 answers 404 for a foreign or missing package', async () => {
    const { repository, service } = setup();
    repository.updatePackageMetadata.mockResolvedValue({ count: 0 });

    expect(
      await rejection(
        service.updatePackageMetadata({
          organizationId: ORG,
          packageId: PACKAGE_ID,
          name: 'Renamed',
        })
      )
    ).toEqual(NOT_FOUND);
  });

  it('K19 rejects an update with no changes', async () => {
    const { repository, service } = setup();

    expect(
      await rejection(
        service.updatePackageMetadata({
          organizationId: ORG,
          packageId: PACKAGE_ID,
        })
      )
    ).toEqual(INVALID_REQUEST);
    expect(repository.updatePackageMetadata).not.toHaveBeenCalled();
  });

  it('K20 rejects a blank new name without writing', async () => {
    const { repository, service } = setup();

    expect(
      await rejection(
        service.updatePackageMetadata({
          organizationId: ORG,
          packageId: PACKAGE_ID,
          name: ' \t ',
          projectId: null,
        })
      )
    ).toEqual(INVALID_REQUEST);
    expect(repository.updatePackageMetadata).not.toHaveBeenCalled();
  });

  it('K21 archives with a time set by the server and returns the detail', async () => {
    const { repository, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(
      packageRow(ARCHIVED)
    );

    const detail = await service.archivePackage(ORG, PACKAGE_ID);
    expect(detail.archivedAt).toBe(ARCHIVED);
    expect(detail.draft).toEqual(DRAFT);
    const [org, id, at] = repository.archivePackage.mock.calls[0];
    expect([org, id]).toEqual([ORG, PACKAGE_ID]);
    expect(at).toBeInstanceOf(Date);
  });

  it('K22 archiving an archived package returns it unchanged', async () => {
    const { repository, service } = setup();
    repository.archivePackage.mockResolvedValue({ count: 0 });
    repository.getPackageForOrganization.mockResolvedValue(
      packageRow(ARCHIVED)
    );

    await expect(service.archivePackage(ORG, PACKAGE_ID)).resolves.toEqual(
      expect.objectContaining({ id: PACKAGE_ID, archivedAt: ARCHIVED })
    );
  });

  it('K23 restores an archived package', async () => {
    const { repository, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(packageRow());

    await expect(service.restorePackage(ORG, PACKAGE_ID)).resolves.toEqual(
      expect.objectContaining({ id: PACKAGE_ID, archivedAt: null })
    );
    expect(repository.restorePackage).toHaveBeenCalledWith(ORG, PACKAGE_ID);
  });

  it('K24 restoring an active package returns it unchanged', async () => {
    const { repository, service } = setup();
    repository.restorePackage.mockResolvedValue({ count: 0 });
    repository.getPackageForOrganization.mockResolvedValue(packageRow());

    await expect(service.restorePackage(ORG, PACKAGE_ID)).resolves.toEqual(
      expect.objectContaining({ archivedAt: null })
    );
  });

  it('K25 archiving or restoring a missing package answers 404', async () => {
    const { repository, service } = setup();
    repository.archivePackage.mockResolvedValue({ count: 0 });
    repository.restorePackage.mockResolvedValue({ count: 0 });

    expect(await rejection(service.archivePackage(ORG, PACKAGE_ID))).toEqual(
      NOT_FOUND
    );
    expect(await rejection(service.restorePackage(ORG, PACKAGE_ID))).toEqual(
      NOT_FOUND
    );
  });
});

describe('ContentStudioService.saveDraft', () => {
  const save = (
    service: ContentStudioService,
    draft: unknown,
    baseDraftVersion = 4
  ) =>
    service.saveDraft({
      organizationId: ORG,
      packageId: PACKAGE_ID,
      baseDraftVersion,
      draft,
    });

  it('D1 stores the normalized draft over the base version', async () => {
    const { repository, service } = setup();
    // keys in another order: what is stored is the parsed draft
    const sent = {
      copy: { global: { thread: [{ mediaIds: [], text: 'Hi', id: 'main' }] } },
      schemaVersion: 1,
    };

    await expect(save(service, sent)).resolves.toEqual({ draftVersion: 5 });
    expect(repository.saveDraftCompareAndSwap).toHaveBeenCalledWith({
      organizationId: ORG,
      packageId: PACKAGE_ID,
      baseDraftVersion: 4,
      draft: JSON.stringify(parseContentPackageDraft(sent)),
    });
    expect(repository.saveDraftCompareAndSwap.mock.calls[0][0].draft).toBe(
      '{"schemaVersion":1,"copy":{"global":{"thread":[{"id":"main","text":"Hi","mediaIds":[]}]}}}'
    );
  });

  it('D2 stores CRLF and CR line breaks as \\n', async () => {
    const { repository, service } = setup();
    await save(service, {
      schemaVersion: 1,
      copy: {
        global: { thread: [{ id: 'main', text: 'a\r\nb\rc', mediaIds: [] }] },
      },
    });

    const stored = repository.saveDraftCompareAndSwap.mock.calls[0][0].draft;
    expect(stored).not.toMatch(/\\r/);
    expect(JSON.parse(stored).copy.global.thread[0].text).toBe('a\nb\nc');
  });

  it.each([
    ['an unknown top-level field', { ...DRAFT, organizationId: 'org-b' }],
    [
      'an unknown item field',
      {
        schemaVersion: 1,
        copy: {
          global: {
            thread: [
              { id: 'main', text: 'secret text', mediaIds: [], html: '<b>' },
            ],
          },
        },
      },
    ],
    ['a wrong schema version', { ...DRAFT, schemaVersion: 2 }],
    [
      'an own __proto__ key',
      JSON.parse(
        '{"schemaVersion":1,"copy":{"global":{"thread":[{"id":"a","text":"","mediaIds":[]}]}},"__proto__":{"x":1}}'
      ),
    ],
    ['no draft at all', undefined],
  ])('D3 rejects %s without writing', async (_name, draft) => {
    const { repository, service } = setup();

    expect(await rejection(save(service, draft))).toEqual(DRAFT_INVALID);
    expect(repository.saveDraftCompareAndSwap).not.toHaveBeenCalled();
    expect(
      repository.getPackageWriteStateForOrganization
    ).not.toHaveBeenCalled();
  });

  it('D4 rejects a draft over the size limit without writing', async () => {
    const { repository, service } = setup();
    const thread = Array.from({ length: 7 }, (_, i) => ({
      id: `item-${i}`,
      text: 'x'.repeat(10_000),
      mediaIds: [],
    }));

    expect(
      await rejection(
        save(service, { schemaVersion: 1, copy: { global: { thread } } })
      )
    ).toEqual(DRAFT_TOO_LARGE);
    expect(repository.saveDraftCompareAndSwap).not.toHaveBeenCalled();
  });

  it('D5 reads nothing after a successful save', async () => {
    const { repository, service } = setup();
    await save(service, DRAFT);

    expect(repository.saveDraftCompareAndSwap).toHaveBeenCalledTimes(1);
    expect(
      repository.getPackageWriteStateForOrganization
    ).not.toHaveBeenCalled();
    expect(repository.getPackageForOrganization).not.toHaveBeenCalled();
  });

  it('D6 answers 404 when the package is missing or foreign', async () => {
    const { repository, service } = setup();
    repository.saveDraftCompareAndSwap.mockResolvedValue({ count: 0 });

    expect(await rejection(save(service, DRAFT))).toEqual(NOT_FOUND);
    expect(repository.getPackageWriteStateForOrganization).toHaveBeenCalledWith(
      ORG,
      PACKAGE_ID
    );
  });

  it('D7 answers 409 when the package is archived', async () => {
    const { repository, service } = setup();
    repository.saveDraftCompareAndSwap.mockResolvedValue({ count: 0 });
    repository.getPackageWriteStateForOrganization.mockResolvedValue({
      draftVersion: 4,
      archivedAt: ARCHIVED,
    });

    expect(await rejection(save(service, DRAFT))).toEqual(PACKAGE_ARCHIVED);
  });

  it('D8 answers 409 with only the current version when the draft moved on', async () => {
    const { repository, service } = setup();
    repository.saveDraftCompareAndSwap.mockResolvedValue({ count: 0 });
    repository.getPackageWriteStateForOrganization.mockResolvedValue({
      draftVersion: 6,
      archivedAt: null,
    });

    const result = await rejection(save(service, DRAFT));
    expect(result).toEqual(conflict(6));
    expect(Object.keys(result.body as object).sort()).toEqual([
      'code',
      'currentDraftVersion',
      'msg',
    ]);
    expect(repository.getPackageForOrganization).not.toHaveBeenCalled();
  });

  it('D9 never echoes draft text in an error', async () => {
    const { repository, service } = setup();
    repository.saveDraftCompareAndSwap.mockResolvedValue({ count: 0 });
    repository.getPackageWriteStateForOrganization.mockResolvedValue({
      draftVersion: 6,
      archivedAt: null,
    });
    const secret = {
      schemaVersion: 1,
      copy: {
        global: { thread: [{ id: 'main', text: 'secret text', mediaIds: [] }] },
      },
    };

    const conflictBody = (await rejection(save(service, secret))).body;
    const invalidBody = (
      await rejection(save(service, { ...secret, extra: 'secret extra' }))
    ).body;
    for (const body of [conflictBody, invalidBody]) {
      expect(JSON.stringify(body)).not.toContain('secret');
      expect(JSON.stringify(body)).not.toContain('thread');
    }
  });

  it('D10 lets exactly one of two saves over the same version win', async () => {
    const { repository, service } = setup();
    // a package at version 4 that behaves like the compare-and-swap does
    const stored = { draftVersion: 4, draft: 'initial', writes: 0 };
    repository.saveDraftCompareAndSwap.mockImplementation(
      async (input: { baseDraftVersion: number; draft: string }) => {
        if (input.baseDraftVersion !== stored.draftVersion) {
          return { count: 0 };
        }
        stored.draftVersion += 1;
        stored.draft = input.draft;
        stored.writes += 1;
        return { count: 1 };
      }
    );
    repository.getPackageWriteStateForOrganization.mockImplementation(
      async () => ({ draftVersion: stored.draftVersion, archivedAt: null })
    );
    const draft = (text: string) => ({
      schemaVersion: 1,
      copy: { global: { thread: [{ id: 'main', text, mediaIds: [] }] } },
    });

    const results = await Promise.allSettled([
      save(service, draft('first'), 4),
      save(service, draft('second'), 4),
    ]);

    expect(results[0]).toEqual({
      status: 'fulfilled',
      value: { draftVersion: 5 },
    });
    expect(results[1].status).toBe('rejected');
    expect(
      await rejection(
        Promise.reject((results[1] as PromiseRejectedResult).reason)
      )
    ).toEqual(conflict(5));
    expect(stored).toEqual({
      draftVersion: 5,
      draft: JSON.stringify(draft('first')),
      writes: 1,
    });
    expect(repository.saveDraftCompareAndSwap).toHaveBeenCalledTimes(2);
  });

  it('D11 passes the base version through unchanged (the DTO checks it)', async () => {
    const { repository, service } = setup();
    await save(service, DRAFT, 1);

    expect(repository.saveDraftCompareAndSwap.mock.calls[0][0]).toMatchObject({
      baseDraftVersion: 1,
    });
  });
});

// Revisions: content is the canonical JSON of the stored draft and
// contentHash its SHA-256 (reference values computed with shasum -a 256)
const DRAFT_A = {
  schemaVersion: 1,
  copy: {
    global: {
      thread: [{ id: 'main', text: 'Launch day', mediaIds: ['m1', 'm2'] }],
    },
  },
};
const CANONICAL_A =
  '{"copy":{"global":{"thread":[{"id":"main","mediaIds":["m1","m2"],"text":"Launch day"}]}},"schemaVersion":1}';
const HASH_A =
  '017b5aa1ae90c19ee64f55ec80b0f842fed1e79649bd2c0901009363f8a8ee45';
const DRAFT_B = {
  schemaVersion: 1,
  copy: {
    global: {
      thread: [{ id: 'main', text: 'Launch week', mediaIds: ['m1', 'm2'] }],
    },
  },
};
const HASH_B =
  'be3d69c258ba69a2c85091b34319e8cc4aa677c470558a6be388c7ba4f74197c';

const revisionPackage = (
  overrides: Partial<{
    draft: string;
    draftVersion: number;
    latestRevisionNumber: number;
    archivedAt: Date | null;
  }> = {}
) => ({
  ...packageRow(),
  draft: JSON.stringify(DRAFT_A),
  draftVersion: 5,
  latestRevisionNumber: 0,
  ...overrides,
});
const storedRevision = (
  overrides: Partial<{
    id: string;
    revisionNumber: number;
    schemaVersion: number;
    content: string;
    contentHash: string;
  }> = {}
) => ({
  id: 'revision-1',
  packageId: PACKAGE_ID,
  revisionNumber: 1,
  schemaVersion: 1,
  content: CANONICAL_A,
  contentHash: HASH_A,
  origin: 'manual',
  sourceDraftVersion: 5,
  createdAt: T,
  createdBy: { id: USER, name: 'Ada' },
  ...overrides,
});
const REVISION_SUMMARY_KEYS = [
  'contentHash',
  'createdAt',
  'id',
  'origin',
  'packageId',
  'revisionNumber',
  'schemaVersion',
  'sourceDraftVersion',
];
const PACKAGE_CHANGED = {
  status: 409,
  body: {
    msg: 'The Content Studio package changed while creating a revision',
    code: 'CS_PACKAGE_CHANGED',
  },
};
const STORED_DRAFT_INVALID = {
  status: 500,
  body: {
    msg: 'Stored Content Studio draft is invalid',
    code: 'CS_STORED_DRAFT_INVALID',
  },
};
const STORED_REVISION_INVALID = {
  status: 500,
  body: {
    msg: 'Stored Content Studio revision is invalid',
    code: 'CS_STORED_REVISION_INVALID',
  },
};
const emptyItem = (itemIndex: number) => ({
  status: 400,
  body: {
    msg: 'The Content Studio draft contains an empty item',
    code: 'CS_DRAFT_EMPTY_ITEM',
    itemIndex,
  },
});
const thread = (...items: { text: string; mediaIds?: string[] }[]) =>
  JSON.stringify({
    schemaVersion: 1,
    copy: {
      global: {
        thread: items.map((item, i) => ({
          id: `item-${i}`,
          text: item.text,
          mediaIds: item.mediaIds ?? [],
        })),
      },
    },
  });

describe('ContentStudioService.createRevision', () => {
  const create = (
    service: ContentStudioService,
    overrides: Partial<{
      draftVersion: number;
      origin: 'manual' | 'handoff';
    }> = {}
  ) =>
    service.createRevision({
      organizationId: ORG,
      packageId: PACKAGE_ID,
      userId: USER,
      draftVersion: 5,
      ...overrides,
    });

  it('R1 stores the first revision of the current draft', async () => {
    const { repository, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(revisionPackage());

    const result = await create(service);
    expect(result).toEqual({
      created: true,
      revision: {
        id: 'revision-1',
        packageId: PACKAGE_ID,
        revisionNumber: 1,
        schemaVersion: 1,
        contentHash: HASH_A,
        origin: 'manual',
        sourceDraftVersion: 5,
        createdAt: T,
      },
    });
    expect(repository.getPackageForOrganization).toHaveBeenCalledWith(
      ORG,
      PACKAGE_ID
    );
    // R21: the request user is the creator
    expect(repository.createRevisionWithCompareAndSwap).toHaveBeenCalledWith({
      organizationId: ORG,
      packageId: PACKAGE_ID,
      expectedDraftVersion: 5,
      expectedLatestRevisionNumber: 0,
      schemaVersion: 1,
      content: CANONICAL_A,
      contentHash: HASH_A,
      origin: 'manual',
      createdById: USER,
    });
    // no revision yet, so nothing to compare with
    expect(repository.getLatestRevisionForPackage).not.toHaveBeenCalled();
  });

  it('R2 stores the handoff origin when asked', async () => {
    const { repository, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(revisionPackage());

    const result = await create(service, { origin: 'handoff' });
    expect(result.revision.origin).toBe('handoff');
    expect(
      repository.createRevisionWithCompareAndSwap.mock.calls[0][0].origin
    ).toBe('handoff');
  });

  it('R3 answers 404 for a missing or foreign package', async () => {
    const { repository, service } = setup();

    expect(await rejection(create(service))).toEqual(NOT_FOUND);
    expect(repository.getLatestRevisionForPackage).not.toHaveBeenCalled();
    expect(repository.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
  });

  it('R4 refuses an archived package', async () => {
    const { repository, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(
      revisionPackage({ archivedAt: ARCHIVED })
    );

    expect(await rejection(create(service))).toEqual(PACKAGE_ARCHIVED);
    expect(repository.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
  });

  it('R5 refuses a stale draft version before hashing anything', async () => {
    const { repository, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(
      revisionPackage({ draftVersion: 6, latestRevisionNumber: 2 })
    );
    const hash = jest.spyOn(canonical, 'sha256Hex');

    expect(await rejection(create(service, { draftVersion: 5 }))).toEqual(
      conflict(6)
    );
    expect(hash).not.toHaveBeenCalled();
    expect(repository.getLatestRevisionForPackage).not.toHaveBeenCalled();
    expect(repository.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
  });

  it.each([
    ['R6 broken JSON', '{"schemaVersion":1,"copy":{"secret text'],
    [
      'R7 an invalid draft',
      '{"schemaVersion":1,"copy":{"global":{"thread":[{"id":"a","text":"secret text","mediaIds":[],"extra":1}]}}}',
    ],
  ])('%s in the stored draft answers 500', async (_name, draft) => {
    const { repository, service } = setup();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    repository.getPackageForOrganization.mockResolvedValue(
      revisionPackage({ draft })
    );

    const result = await rejection(create(service));
    expect(result).toEqual(STORED_DRAFT_INVALID);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(repository.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
  });

  it('answers 500 if the parsed draft cannot be canonicalized', async () => {
    const { repository, service } = setup();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    repository.getPackageForOrganization.mockResolvedValue(revisionPackage());
    jest.spyOn(canonical, 'canonicalJson').mockImplementation(() => {
      throw new canonical.CanonicalJsonError('Cyclic value');
    });

    expect(await rejection(create(service))).toEqual(STORED_DRAFT_INVALID);
    expect(repository.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
  });

  it.each([
    ['R8 an empty first item', thread({ text: '' }, { text: 'b' }), 0],
    [
      'R9 a whitespace-only later item',
      thread({ text: 'a' }, { text: 'b' }, { text: ' \n\t ' }),
      2,
    ],
  ])('%s is refused with its index', async (_name, draft, itemIndex) => {
    const { repository, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(
      revisionPackage({ draft })
    );

    const result = await rejection(create(service));
    expect(result).toEqual(emptyItem(itemIndex));
    expect(Object.keys(result.body as object).sort()).toEqual([
      'code',
      'itemIndex',
      'msg',
    ]);
    expect(repository.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
  });

  it.each([
    ['R10 a media-only item', thread({ text: '', mediaIds: ['m1'] })],
    ['R11 a text-only item', thread({ text: 'Hello' })],
  ])('%s can become a revision', async (_name, draft) => {
    const { repository, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(
      revisionPackage({ draft })
    );

    await expect(create(service)).resolves.toMatchObject({ created: true });
  });

  it('R12 returns the latest revision when the draft is unchanged', async () => {
    const { repository, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(
      revisionPackage({ latestRevisionNumber: 1 })
    );
    repository.getLatestRevisionForPackage.mockResolvedValue(storedRevision());

    const result = await create(service);
    expect(result).toEqual({
      created: false,
      revision: {
        id: 'revision-1',
        packageId: PACKAGE_ID,
        revisionNumber: 1,
        schemaVersion: 1,
        contentHash: HASH_A,
        origin: 'manual',
        sourceDraftVersion: 5,
        createdAt: T,
      },
    });
    expect(Object.keys(result.revision).sort()).toEqual(REVISION_SUMMARY_KEYS);
    expect(repository.getLatestRevisionForPackage).toHaveBeenCalledWith(
      ORG,
      PACKAGE_ID
    );
    expect(repository.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
  });

  it('R13 answers 500 when the counter says there is a revision but none exists', async () => {
    const { repository, service } = setup();
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    repository.getPackageForOrganization.mockResolvedValue(
      revisionPackage({ latestRevisionNumber: 3 })
    );

    const result = await rejection(create(service));
    expect(result).toEqual({
      status: 500,
      body: {
        msg: 'Content Studio revision state is invalid',
        code: 'CS_REVISION_STATE_INVALID',
      },
    });
    expect(log.mock.calls[0].join(' ')).toContain(PACKAGE_ID);
    expect(repository.createRevisionWithCompareAndSwap).not.toHaveBeenCalled();
  });

  it('R14 creates the next revision when the draft changed', async () => {
    const { repository, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(
      revisionPackage({
        draft: JSON.stringify(DRAFT_B),
        draftVersion: 9,
        latestRevisionNumber: 1,
      })
    );
    repository.getLatestRevisionForPackage.mockResolvedValue(storedRevision());

    const result = await create(service, { draftVersion: 9 });
    expect(result).toMatchObject({
      created: true,
      revision: {
        revisionNumber: 2,
        contentHash: HASH_B,
        sourceDraftVersion: 9,
      },
    });
    expect(
      repository.createRevisionWithCompareAndSwap.mock.calls[0][0]
    ).toMatchObject({
      expectedDraftVersion: 9,
      expectedLatestRevisionNumber: 1,
      contentHash: HASH_B,
    });
  });

  it('R15 makes a new revision when content goes back to an older one', async () => {
    const { repository, service } = setup();
    // r1 was A, r2 is B, and the draft is A again
    repository.getPackageForOrganization.mockResolvedValue(
      revisionPackage({ latestRevisionNumber: 2 })
    );
    repository.getLatestRevisionForPackage.mockResolvedValue(
      storedRevision({
        id: 'revision-2',
        revisionNumber: 2,
        contentHash: HASH_B,
      })
    );

    const result = await create(service);
    expect(result).toMatchObject({
      created: true,
      revision: { revisionNumber: 3, contentHash: HASH_A },
    });
    // only the latest revision is ever looked at
    expect(repository.getLatestRevisionForPackage).toHaveBeenCalledTimes(1);
    expect(repository.listRevisionsForPackage).not.toHaveBeenCalled();
    expect(repository.getRevisionForPackage).not.toHaveBeenCalled();
  });

  it('R16 answers 409 when the package changed before the revision was stored', async () => {
    const { repository, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(revisionPackage());
    repository.createRevisionWithCompareAndSwap.mockResolvedValue({
      created: false,
      reason: 'compare-and-swap-failed',
    });

    expect(await rejection(create(service))).toEqual(PACKAGE_CHANGED);
  });

  it('R17 answers 409 for a revision number taken at the same time (P2002)', async () => {
    const { repository, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(revisionPackage());
    repository.createRevisionWithCompareAndSwap.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`packageId`,`revisionNumber`)',
        { code: 'P2002', clientVersion: '6.5.0', meta: { target: ['x'] } }
      )
    );

    const result = await rejection(create(service));
    expect(result).toEqual(PACKAGE_CHANGED);
    expect(JSON.stringify(result)).not.toContain('revisionNumber');
  });

  it.each([
    [
      'another Prisma error',
      new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: '6.5.0',
      }),
    ],
    [
      'a P2002-looking plain error',
      Object.assign(new Error('not prisma'), { code: 'P2002' }),
    ],
    ['a connection error', new Error('Connection refused')],
  ])('R18 lets %s through unchanged', async (_name, error) => {
    const { repository, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(revisionPackage());
    repository.createRevisionWithCompareAndSwap.mockRejectedValue(error);

    await expect(create(service)).rejects.toBe(error);
  });

  it('R19 R20 stores the canonical text and hashes exactly that text', async () => {
    const { repository, service } = setup();
    // the stored draft has its keys in a different order
    repository.getPackageForOrganization.mockResolvedValue(
      revisionPackage({
        draft:
          '{"copy":{"global":{"thread":[{"mediaIds":["m1","m2"],"text":"Launch day","id":"main"}]}},"schemaVersion":1}',
      })
    );

    await create(service);
    const input = repository.createRevisionWithCompareAndSwap.mock.calls[0][0];
    expect(input.content).toBe(CANONICAL_A);
    expect(input.content).not.toBe(JSON.stringify(DRAFT_A));
    expect(input.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(input.contentHash).toBe(canonical.sha256Hex(input.content));
    expect(input.contentHash).toBe(HASH_A);
  });

  it.each([
    [
      'thread order',
      thread({ text: 'b' }, { text: 'a' }),
      thread({ text: 'a' }, { text: 'b' }),
    ],
    [
      'media order',
      thread({ text: 'a', mediaIds: ['m2', 'm1'] }),
      thread({ text: 'a', mediaIds: ['m1', 'm2'] }),
    ],
  ])('changes the hash when the %s changes', async (_name, first, second) => {
    const { repository, service } = setup();
    repository.getPackageForOrganization
      .mockResolvedValueOnce(revisionPackage({ draft: first }))
      .mockResolvedValueOnce(revisionPackage({ draft: second }));

    await create(service);
    await create(service);
    const [a, b] = repository.createRevisionWithCompareAndSwap.mock.calls.map(
      ([input]) => input.contentHash
    );
    expect(a).not.toBe(b);
  });

  it('R22 never puts draft text in an error', async () => {
    const outputs: string[] = [];
    for (const draft of [
      thread({ text: 'secret text' }, { text: '' }),
      '{"secret text"',
    ]) {
      const { repository, service } = setup();
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
      repository.getPackageForOrganization.mockResolvedValue(
        revisionPackage({ draft })
      );
      outputs.push(JSON.stringify((await rejection(create(service))).body));
    }
    const { repository, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(
      revisionPackage({ draftVersion: 7 })
    );
    outputs.push(JSON.stringify((await rejection(create(service))).body));

    for (const output of outputs) {
      expect(output).not.toContain('secret');
      expect(output).not.toContain('Launch');
      expect(output).not.toContain('item-');
    }
  });
});

describe('ContentStudioService revision history', () => {
  it('R23 lists revisions of a package of the organization', async () => {
    const { repository, service } = setup();
    const rows = [{ id: 'revision-2' }, { id: 'revision-1' }];
    repository.getPackageWriteStateForOrganization.mockResolvedValue({
      draftVersion: 5,
      archivedAt: null,
    });
    repository.listRevisionsForPackage.mockResolvedValue(rows);
    repository.countRevisionsForPackage.mockResolvedValue(2);

    await expect(
      service.listRevisions({
        organizationId: ORG,
        packageId: PACKAGE_ID,
        page: 1,
      })
    ).resolves.toEqual({
      pages: 1,
      results: rows.map((row) => ({ ...row, approval: NOT_REVIEWED_SUMMARY })),
    });
    expect(repository.getPackageWriteStateForOrganization).toHaveBeenCalledWith(
      ORG,
      PACKAGE_ID
    );
    expect(repository.listRevisionsForPackage).toHaveBeenCalledWith({
      organizationId: ORG,
      packageId: PACKAGE_ID,
      skip: 0,
      take: 20,
    });
    expect(repository.countRevisionsForPackage).toHaveBeenCalledWith(
      ORG,
      PACKAGE_ID
    );
    // R37 R38: the repository rows are returned as they are, so the list
    // keeps the repository's select (no content, createdBy id and name),
    // with only the approval binding of each added (P5-05)
    expect(repository.getPackageForOrganization).not.toHaveBeenCalled();
  });

  it('R24 skips 40 revisions for page 3', async () => {
    const { repository, service } = setup();
    repository.getPackageWriteStateForOrganization.mockResolvedValue({
      draftVersion: 5,
      archivedAt: null,
    });
    repository.countRevisionsForPackage.mockResolvedValue(41);

    await expect(
      service.listRevisions({
        organizationId: ORG,
        packageId: PACKAGE_ID,
        page: 3,
      })
    ).resolves.toEqual({ pages: 3, results: [] });
    expect(repository.listRevisionsForPackage.mock.calls[0][0]).toMatchObject({
      skip: 40,
      take: 20,
    });
  });

  it('R25 lists the history of an archived package', async () => {
    const { repository, service } = setup();
    repository.getPackageWriteStateForOrganization.mockResolvedValue({
      draftVersion: 5,
      archivedAt: ARCHIVED,
    });

    await expect(
      service.listRevisions({
        organizationId: ORG,
        packageId: PACKAGE_ID,
        page: 1,
      })
    ).resolves.toEqual({ pages: 0, results: [] });
    expect(repository.listRevisionsForPackage).toHaveBeenCalled();
  });

  it('R26 answers 404 for a missing or foreign package without listing', async () => {
    const { repository, service } = setup();

    expect(
      await rejection(
        service.listRevisions({
          organizationId: ORG,
          packageId: PACKAGE_ID,
          page: 1,
        })
      )
    ).toEqual(NOT_FOUND);
    expect(repository.listRevisionsForPackage).not.toHaveBeenCalled();
    expect(repository.countRevisionsForPackage).not.toHaveBeenCalled();
  });

  it('R27 reports 0 pages for a package without revisions', async () => {
    const { repository, service } = setup();
    repository.getPackageWriteStateForOrganization.mockResolvedValue({
      draftVersion: 1,
      archivedAt: null,
    });

    await expect(
      service.listRevisions({
        organizationId: ORG,
        packageId: PACKAGE_ID,
        page: 1,
      })
    ).resolves.toEqual({ pages: 0, results: [] });
  });

  const get = (service: ContentStudioService, revisionId = 'revision-1') =>
    service.getRevision({
      organizationId: ORG,
      packageId: PACKAGE_ID,
      revisionId,
    });

  it('R28 returns the revision with its content as an object', async () => {
    const { repository, service } = setup();
    repository.getRevisionForPackage.mockResolvedValue({
      ...storedRevision(),
      organizationId: ORG,
    });

    const detail = await get(service);
    expect(detail).toEqual({
      id: 'revision-1',
      packageId: PACKAGE_ID,
      revisionNumber: 1,
      schemaVersion: 1,
      contentHash: HASH_A,
      origin: 'manual',
      sourceDraftVersion: 5,
      createdAt: T,
      createdBy: { id: USER, name: 'Ada' },
      content: DRAFT_A,
      media: {},
      approval: notReviewedStatus('revision-1'),
    });
    expect(typeof detail.content).toBe('object');
    expect(JSON.stringify(detail)).not.toContain(JSON.stringify(CANONICAL_A));
    expect(detail).not.toHaveProperty('organizationId');
    expect(repository.getRevisionForPackage).toHaveBeenCalledWith(
      ORG,
      PACKAGE_ID,
      'revision-1'
    );
  });

  it('R29 reads a revision of an archived package with the one scoped query', async () => {
    const { repository, service } = setup();
    repository.getRevisionForPackage.mockResolvedValue(storedRevision());

    await expect(get(service)).resolves.toMatchObject({ id: 'revision-1' });
    expect(repository.getPackageForOrganization).not.toHaveBeenCalled();
    expect(
      repository.getPackageWriteStateForOrganization
    ).not.toHaveBeenCalled();
  });

  it('R30 R31 answers 404 for a missing, foreign or other-package revision', async () => {
    const { repository, service } = setup();

    expect(await rejection(get(service, 'revision-of-other-package'))).toEqual(
      NOT_FOUND
    );
    expect(repository.getRevisionForPackage).toHaveBeenCalledWith(
      ORG,
      PACKAGE_ID,
      'revision-of-other-package'
    );
  });

  it.each([
    ['R32 broken JSON', { content: '{"copy":' }],
    [
      'R33 an invalid draft',
      {
        content: '{"schemaVersion":2}',
        contentHash: canonical.sha256Hex('{"schemaVersion":2}'),
      },
    ],
    [
      'R34 non-canonical key order',
      {
        content: JSON.stringify(DRAFT_A),
        contentHash: canonical.sha256Hex(JSON.stringify(DRAFT_A)),
      },
    ],
    [
      'R34 extra whitespace',
      {
        content: ` ${CANONICAL_A}`,
        contentHash: canonical.sha256Hex(` ${CANONICAL_A}`),
      },
    ],
    ['R35 a hash mismatch', { contentHash: HASH_B }],
    ['R35 an uppercase hash', { contentHash: HASH_A.toUpperCase() }],
    ['a schema version mismatch', { schemaVersion: 2 }],
  ])('%s in the stored revision answers 500', async (_name, overrides) => {
    const { repository, service } = setup();
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    repository.getRevisionForPackage.mockResolvedValue(
      storedRevision(overrides)
    );

    const result = await rejection(get(service));
    expect(result).toEqual(STORED_REVISION_INVALID);
    const output = `${JSON.stringify(result)} ${log.mock.calls[0].join(' ')}`;
    expect(output).toContain('revision-1');
    expect(output).not.toContain('Launch');
    expect(output).not.toContain(HASH_A);
  });

  it('R36 accepts a revision whose text and hash match', async () => {
    const { repository, service } = setup();
    repository.getRevisionForPackage.mockResolvedValue(storedRevision());

    await expect(get(service)).resolves.toMatchObject({
      contentHash: HASH_A,
      content: DRAFT_A,
    });
  });

  it('R38 returns only the id and name of the creator', async () => {
    const { repository, service } = setup();
    repository.getRevisionForPackage.mockResolvedValue({
      ...storedRevision(),
      createdBy: {
        id: USER,
        name: 'Ada',
        email: 'ada@example.com',
        password: 'hash',
      },
    });

    expect((await get(service)).createdBy).toStrictEqual({
      id: USER,
      name: 'Ada',
    });
  });
});

describe('ContentStudioService revision immutability and races', () => {
  // A package and its revisions in memory, behaving like the repository's
  // compare-and-swap transaction
  const memory = () => {
    const { repository, service } = setup();
    const state = {
      draft: JSON.stringify(DRAFT_A),
      draftVersion: 5,
      latestRevisionNumber: 0,
      revisions: [] as ReturnType<typeof storedRevision>[],
    };
    repository.getPackageForOrganization.mockImplementation(async () =>
      revisionPackage({
        draft: state.draft,
        draftVersion: state.draftVersion,
        latestRevisionNumber: state.latestRevisionNumber,
      })
    );
    repository.getLatestRevisionForPackage.mockImplementation(
      async () => state.revisions[state.revisions.length - 1] ?? null
    );
    repository.getRevisionForPackage.mockImplementation(
      async (_org: string, _packageId: string, id: string) =>
        state.revisions.find((revision) => revision.id === id) ?? null
    );
    repository.createRevisionWithCompareAndSwap.mockImplementation(
      async (input: RevisionInput): Promise<RevisionResult> => {
        if (
          input.expectedDraftVersion !== state.draftVersion ||
          input.expectedLatestRevisionNumber !== state.latestRevisionNumber
        ) {
          return { created: false, reason: 'compare-and-swap-failed' };
        }
        state.latestRevisionNumber += 1;
        const revision = storedRevision({
          id: `revision-${state.latestRevisionNumber}`,
          revisionNumber: state.latestRevisionNumber,
          content: input.content,
          contentHash: input.contentHash,
        });
        state.revisions.push(revision);
        return { created: true, revision };
      }
    );
    const create = () =>
      service.createRevision({
        organizationId: ORG,
        packageId: PACKAGE_ID,
        userId: USER,
        draftVersion: state.draftVersion,
      });
    return { repository, service, state, create };
  };

  it('lets one of two simultaneous revisions win and refuses the other', async () => {
    const { state, create } = memory();

    // both read the package at latestRevisionNumber 0 before either stores
    const results = await Promise.allSettled([create(), create()]);

    expect(results[0]).toMatchObject({
      status: 'fulfilled',
      value: { created: true, revision: { revisionNumber: 1 } },
    });
    expect(results[1].status).toBe('rejected');
    expect(
      await rejection(
        Promise.reject((results[1] as PromiseRejectedResult).reason)
      )
    ).toEqual(PACKAGE_CHANGED);
    expect(state.revisions).toHaveLength(1);
  });

  it('returns the same revision for a second click on unchanged content', async () => {
    const { state, create } = memory();

    const first = await create();
    const second = await create();
    expect(first).toMatchObject({
      created: true,
      revision: { id: 'revision-1' },
    });
    expect(second).toEqual({ created: false, revision: first.revision });
    expect(state.revisions).toHaveLength(1);
  });

  it('keeps numbering monotonic and records a return to older content', async () => {
    const { state, create } = memory();

    await create(); // r1 = A
    state.draft = JSON.stringify(DRAFT_B);
    state.draftVersion += 1;
    await create(); // r2 = B
    state.draft = JSON.stringify(DRAFT_A);
    state.draftVersion += 1;
    const third = await create(); // A again: r3, not r1

    expect(third).toMatchObject({
      created: true,
      revision: { revisionNumber: 3, contentHash: HASH_A },
    });
    expect(state.revisions.map((r) => r.revisionNumber)).toEqual([1, 2, 3]);
  });

  it('keeps a revision unchanged when the draft changes afterwards', async () => {
    const { service, state, create } = memory();

    await create();
    state.draft = JSON.stringify(DRAFT_B);
    state.draftVersion += 1;

    const detail = await service.getRevision({
      organizationId: ORG,
      packageId: PACKAGE_ID,
      revisionId: 'revision-1',
    });
    expect(detail.content).toEqual(DRAFT_A);
    expect(detail.contentHash).toBe(HASH_A);
  });

  it('has no method that updates or deletes a revision', () => {
    const methods = Object.getOwnPropertyNames(ContentStudioService.prototype);

    expect(methods).toEqual(
      expect.arrayContaining(['createRevision', 'listRevisions', 'getRevision'])
    );
    expect(
      methods.filter((name) =>
        /^(update|delete|remove|upsert|set|edit|archive|restore).*revision/i.test(
          name
        )
      )
    ).toEqual([]);
  });
});

describe('ContentStudioService media previews', () => {
  const DRAFT_WITH_MEDIA = {
    schemaVersion: 1,
    copy: {
      global: {
        thread: [
          { id: 'one', text: 'First', mediaIds: ['m1', 'm2'] },
          { id: 'two', text: 'Second', mediaIds: ['m2', 'm3'] },
        ],
      },
    },
  };
  const PREVIEW = {
    m1: {
      id: 'm1',
      path: 'https://uploads.example.com/m1.png',
      thumbnail: null as string | null,
      alt: null as string | null,
      status: 'ready',
    },
    m2: {
      id: 'm2',
      path: 'https://uploads.example.com/m2.mp4',
      thumbnail: null as string | null,
      alt: null as string | null,
      status: 'processing',
    },
    m3: null as null,
  };
  const withMedia = (archivedAt: Date | null = null) => ({
    ...packageRow(archivedAt),
    draft: JSON.stringify(DRAFT_WITH_MEDIA),
  });

  it('M1 shows {} for a package without Media', async () => {
    const { repository, media, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(packageRow());

    const detail = await service.getPackage(ORG, PACKAGE_ID);
    expect(detail.media).toEqual({});
    expect(media.getPreviewMap).toHaveBeenCalledTimes(1);
    expect(media.getPreviewMap).toHaveBeenCalledWith(ORG, DRAFT);
  });

  it('M2 M3 M4 M5 hands the parsed draft over and returns the preview map', async () => {
    const { repository, media, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(withMedia());
    media.getPreviewMap.mockResolvedValue(PREVIEW);

    const detail = await service.getPackage(ORG, PACKAGE_ID);
    // a missing (null) and a processing Media still give a detail
    expect(detail.media).toBe(PREVIEW);
    expect(detail.draft).toEqual(DRAFT_WITH_MEDIA);
    // the whole draft goes over: ids are collected and deduplicated there
    expect(media.getPreviewMap).toHaveBeenCalledWith(ORG, DRAFT_WITH_MEDIA);
    expect(media.resolveForHandoff).not.toHaveBeenCalled();
  });

  it('M6 includes {} for a new package', async () => {
    const { media, service } = setup();

    const created = await service.createPackage({
      organizationId: ORG,
      userId: USER,
    });
    expect(created.media).toEqual({});
    expect(media.getPreviewMap).toHaveBeenCalledWith(ORG, created.draft);
  });

  it('M7 includes the preview after a metadata update', async () => {
    const { repository, media, service } = setup();
    repository.getPackageForOrganization.mockResolvedValue(withMedia());
    media.getPreviewMap.mockResolvedValue(PREVIEW);

    const detail = await service.updatePackageMetadata({
      organizationId: ORG,
      packageId: PACKAGE_ID,
      name: 'Renamed',
    });
    expect(detail.media).toBe(PREVIEW);
  });

  it('M8 includes the preview after archiving and restoring', async () => {
    const { repository, media, service } = setup();
    media.getPreviewMap.mockResolvedValue(PREVIEW);

    repository.getPackageForOrganization.mockResolvedValue(withMedia(ARCHIVED));
    expect((await service.archivePackage(ORG, PACKAGE_ID)).media).toBe(PREVIEW);
    repository.getPackageForOrganization.mockResolvedValue(withMedia());
    expect((await service.restorePackage(ORG, PACKAGE_ID)).media).toBe(PREVIEW);
    expect(media.getPreviewMap).toHaveBeenCalledTimes(2);
  });

  it('M9 answers 500 for a broken stored draft before reading any Media', async () => {
    const { repository, media, service } = setup();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    repository.getPackageForOrganization.mockResolvedValue({
      ...packageRow(),
      draft: '{"schemaVersion":999}',
    });

    expect((await rejection(service.getPackage(ORG, PACKAGE_ID))).status).toBe(
      500
    );
    expect(media.getPreviewMap).not.toHaveBeenCalled();
  });

  it('reads no Media for the package list or a draft save', async () => {
    const { repository, media, service } = setup();
    repository.listPackagesForOrganization.mockResolvedValue([
      { id: PACKAGE_ID },
    ]);

    const list = await service.listPackages({
      organizationId: ORG,
      archived: false,
      page: 1,
    });
    expect(list.results).toEqual([{ id: PACKAGE_ID }]);
    await service.saveDraft({
      organizationId: ORG,
      packageId: PACKAGE_ID,
      baseDraftVersion: 4,
      draft: DRAFT_WITH_MEDIA,
    });
    expect(media.getPreviewMap).not.toHaveBeenCalled();
    expect(media.resolveForHandoff).not.toHaveBeenCalled();
  });

  const REVISION_WITH_MEDIA_CONTENT = canonical.canonicalJson(
    parseContentPackageDraft(DRAFT_WITH_MEDIA)
  );
  const revisionWithMedia = () =>
    storedRevision({
      content: REVISION_WITH_MEDIA_CONTENT,
      contentHash: canonical.sha256Hex(REVISION_WITH_MEDIA_CONTENT),
    });
  const getRevision = (service: ContentStudioService) =>
    service.getRevision({
      organizationId: ORG,
      packageId: PACKAGE_ID,
      revisionId: 'revision-1',
    });

  it('R1 shows {} for a revision without Media', async () => {
    const { repository, media, service } = setup();
    repository.getRevisionForPackage.mockResolvedValue(storedRevision());

    expect((await getRevision(service)).media).toEqual({});
    expect(media.getPreviewMap).toHaveBeenCalledWith(ORG, DRAFT_A);
  });

  it('R2 R3 R4 shows the current state of the revision Media', async () => {
    const { repository, media, service } = setup();
    repository.getRevisionForPackage.mockResolvedValue(revisionWithMedia());
    media.getPreviewMap.mockResolvedValue(PREVIEW);

    const detail = await getRevision(service);
    expect(detail.media).toBe(PREVIEW);
    expect(detail.content).toEqual(DRAFT_WITH_MEDIA);
    expect(media.getPreviewMap).toHaveBeenCalledWith(ORG, DRAFT_WITH_MEDIA);
  });

  it('R5 answers 500 for a corrupt revision before reading any Media', async () => {
    const { repository, media, service } = setup();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    repository.getRevisionForPackage.mockResolvedValue({
      ...revisionWithMedia(),
      contentHash: HASH_B,
    });

    expect((await rejection(getRevision(service))).status).toBe(500);
    expect(media.getPreviewMap).not.toHaveBeenCalled();
  });

  it('R6 reads no Media for the revision list', async () => {
    const { repository, media, service } = setup();
    repository.getPackageWriteStateForOrganization.mockResolvedValue({
      draftVersion: 5,
      archivedAt: null,
    });

    await service.listRevisions({
      organizationId: ORG,
      packageId: PACKAGE_ID,
      page: 1,
    });
    expect(media.getPreviewMap).not.toHaveBeenCalled();
  });

  it('R7 creates a revision without reading or requiring any Media', async () => {
    const { repository, media, service } = setup();
    // m2 is processing and m3 gone: a revision records the intent anyway
    repository.getPackageForOrganization.mockResolvedValue({
      ...withMedia(),
      draftVersion: 5,
    });

    await expect(
      service.createRevision({
        organizationId: ORG,
        packageId: PACKAGE_ID,
        userId: USER,
        draftVersion: 5,
      })
    ).resolves.toMatchObject({ created: true });
    expect(media.getPreviewMap).not.toHaveBeenCalled();
    expect(media.resolveForHandoff).not.toHaveBeenCalled();
    expect(
      repository.createRevisionWithCompareAndSwap.mock.calls[0][0].content
    ).toBe(REVISION_WITH_MEDIA_CONTENT);
  });
});

describe('ContentStudioService revision approval binding (P5-05)', () => {
  const APPROVED_STATUS = {
    targetType: 'PACKAGE_REVISION',
    targetRevisionId: 'revision-1',
    targetRevisionNumber: 1,
    targetContentHash: HASH_A,
    approved: true,
    state: 'APPROVED',
    reviewId: 'review-1',
    approvalVersion: 3,
    currentDecision: {
      sequence: 3,
      decision: 'APPROVED',
      note: null,
      actor: { id: USER, name: 'Ada' },
      createdAt: T,
    },
  };
  const listed = async (rows: { id: string }[]) => {
    const { repository, reviews, service } = setup();
    repository.getPackageWriteStateForOrganization.mockResolvedValue({
      draftVersion: 5,
      archivedAt: null,
    });
    repository.listRevisionsForPackage.mockResolvedValue(rows);
    repository.countRevisionsForPackage.mockResolvedValue(rows.length);
    return {
      reviews,
      list: await service.listRevisions({
        organizationId: ORG,
        packageId: PACKAGE_ID,
        page: 1,
      }),
    };
  };

  it('AS1 the revision view carries the full binding of exactly that revision', async () => {
    const { repository, reviews, service } = setup();
    repository.getRevisionForPackage.mockResolvedValue(storedRevision());
    reviews.getRevisionApprovalStatus.mockResolvedValue(APPROVED_STATUS);
    const detail = await service.getRevision({
      organizationId: ORG,
      packageId: PACKAGE_ID,
      revisionId: 'revision-1',
    });
    expect(detail.approval).toEqual(APPROVED_STATUS);
    // the organization of the request and the id of the revision read: no
    // package, hash or "latest"
    expect(reviews.getRevisionApprovalStatus.mock.calls).toEqual([
      [
        {
          organizationId: ORG,
          targetType: 'PACKAGE_REVISION',
          targetRevisionId: 'revision-1',
        },
      ],
    ]);
    expect(reviews.getRevisionApprovalStatuses).not.toHaveBeenCalled();
  });

  it('AS1 a missing or corrupt revision is answered before any binding is read', async () => {
    const { repository, reviews, service } = setup();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    expect(
      (
        await rejection(
          service.getRevision({
            organizationId: ORG,
            packageId: PACKAGE_ID,
            revisionId: 'revision-1',
          })
        )
      ).status
    ).toBe(404);
    repository.getRevisionForPackage.mockResolvedValue({
      ...storedRevision(),
      contentHash: HASH_B,
    });
    expect(
      (
        await rejection(
          service.getRevision({
            organizationId: ORG,
            packageId: PACKAGE_ID,
            revisionId: 'revision-1',
          })
        )
      ).status
    ).toBe(500);
    expect(reviews.getRevisionApprovalStatus).not.toHaveBeenCalled();
  });

  it('AS3/BQ1 a page of history asks for the binding of all its revisions once', async () => {
    const rows = [
      { id: 'revision-3' },
      { id: 'revision-2' },
      { id: 'revision-1' },
    ];
    const { reviews } = await listed(rows);
    expect(reviews.getRevisionApprovalStatuses.mock.calls).toEqual([
      [
        {
          organizationId: ORG,
          targetType: 'PACKAGE_REVISION',
          revisionIds: ['revision-3', 'revision-2', 'revision-1'],
        },
      ],
    ]);
    expect(reviews.getRevisionApprovalStatus).not.toHaveBeenCalled();
  });

  it("AS3/BQ4 each row gets the answer for its own id, never another row's", async () => {
    const { repository, reviews, service } = setup();
    repository.getPackageWriteStateForOrganization.mockResolvedValue({
      draftVersion: 5,
      archivedAt: null,
    });
    repository.listRevisionsForPackage.mockResolvedValue([
      { id: 'revision-2' },
      { id: 'revision-1' },
    ]);
    reviews.getRevisionApprovalStatuses.mockResolvedValue(
      new Map([
        ['revision-1', { approved: true, state: 'APPROVED' }],
        ['revision-2', { approved: false, state: 'NOT_REVIEWED' }],
      ])
    );
    const list = await service.listRevisions({
      organizationId: ORG,
      packageId: PACKAGE_ID,
      page: 1,
    });
    expect(list.results).toEqual([
      {
        id: 'revision-2',
        approval: { approved: false, state: 'NOT_REVIEWED' },
      },
      { id: 'revision-1', approval: { approved: true, state: 'APPROVED' } },
    ]);
  });

  it('AS5/AS6 a row keeps every existing field and adds the compact binding only', async () => {
    const row = {
      id: 'revision-1',
      revisionNumber: 1,
      contentHash: HASH_A,
      origin: 'manual',
      sourceDraftVersion: 5,
      createdAt: T,
      createdBy: { id: USER, name: 'Ada' },
    };
    const { list } = await listed([row]);
    expect(list.results).toEqual([{ ...row, approval: NOT_REVIEWED_SUMMARY }]);
    expect(Object.keys(list.results[0].approval!).sort()).toEqual([
      'approved',
      'state',
    ]);
  });

  it('a missing package lists nothing and reads no binding', async () => {
    const { reviews, service } = setup();
    await rejection(
      service.listRevisions({
        organizationId: ORG,
        packageId: PACKAGE_ID,
        page: 1,
      })
    );
    expect(reviews.getRevisionApprovalStatuses).not.toHaveBeenCalled();
  });

  it('HR1 a handoff never asks whether a revision is approved', () => {
    const text = require('fs')
      .readFileSync(
        require('path').join(__dirname, 'content-studio.handoff.service.ts'),
        'utf8'
      )
      .replace(/\/\/.*$/gm, '');
    expect(text).not.toMatch(
      /approv|ContentStudioReviewService|getRevision\(|requireApprovedRevision/i
    );
  });
});
