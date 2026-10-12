import { HttpException, Logger } from '@nestjs/common';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import { ContentStudioService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.service';
import { parseContentPackageDraft } from '@gitroom/nestjs-libraries/content-studio/content.package.draft';

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
  'name',
  'projectId',
  'updatedAt',
];

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
  };
  const service = new ContentStudioService(
    repository as unknown as ContentStudioRepository
  );
  return { repository, service };
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
