import {
  ArgumentMetadata,
  BadRequestException,
  PipeTransform,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  PIPES_METADATA,
} from '@nestjs/common/constants';
import { Organization, User } from '@prisma/client';
import { ContentStudioController } from '@gitroom/backend/api/routes/content-studio.controller';
import { ContentStudioService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.service';
import { ContentStudioHandoffService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.handoff.service';
import { ContentStudioAIConnectionService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.service';
import { ContentStudioWritingProfileService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.writing-profile.service';
import { ContentStudioEditorialPolicyService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.service';
import { ContentStudioAudienceProfileService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.audience-profile.service';
import { ContentStudioExpertiseProfileService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.expertise-profile.service';
import { ContentStudioAIWritingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-writing.service';
import {
  CreateContentStudioProjectDto,
  ListContentStudioProjectsDto,
  UpdateContentStudioProjectDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.project.dto';
import {
  CreateContentPackageDto,
  CreateContentPackageRevisionDto,
  ListContentPackageRevisionsDto,
  ListContentPackagesDto,
  SaveContentPackageDraftDto,
  UpdateContentPackageDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.package.dto';

// The real MediaService pulls in uploads, Redis and Temporal at import time;
// the controller only needs the service class it forwards to
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);
// The composer serializer needs a DOM for its sanitizer; it has its own specs
jest.mock('@gitroom/nestjs-libraries/content-studio/handoff.html', () => ({
  contentStudioTextToComposerHtml: (text: string) => text,
}));

const ORG = { id: 'org-a' } as Organization;
const USER = { id: 'user-1' } as User;
const PROJECT_ID = '3b241101-e2bb-4255-8caf-4136c566a962';
const DRAFT = {
  schemaVersion: 1,
  copy: { global: { thread: [{ id: 'main', text: 'Hi', mediaIds: [] }] } },
};

const setup = () => {
  const result = { from: 'service' };
  const service = {
    listProjects: jest.fn().mockResolvedValue(result),
    createProject: jest.fn().mockResolvedValue(result),
    updateProjectName: jest.fn().mockResolvedValue(result),
    archiveProject: jest.fn().mockResolvedValue(result),
    restoreProject: jest.fn().mockResolvedValue(result),
    listPackages: jest.fn().mockResolvedValue(result),
    createPackage: jest.fn().mockResolvedValue(result),
    getPackage: jest.fn().mockResolvedValue(result),
    updatePackageMetadata: jest.fn().mockResolvedValue(result),
    archivePackage: jest.fn().mockResolvedValue(result),
    restorePackage: jest.fn().mockResolvedValue(result),
    saveDraft: jest.fn().mockResolvedValue(result),
    createRevision: jest.fn().mockResolvedValue({ created: true }),
    listRevisions: jest.fn().mockResolvedValue(result),
    getRevision: jest.fn().mockResolvedValue(result),
  };
  const handoffs = {
    createHandoff: jest.fn().mockResolvedValue(result),
    resolveHandoff: jest.fn().mockResolvedValue(result),
    revokeHandoff: jest.fn().mockResolvedValue(result),
  };
  const controller = new ContentStudioController(
    service as unknown as ContentStudioService,
    handoffs as unknown as ContentStudioHandoffService,
    {} as ContentStudioAIConnectionService,
    {} as ContentStudioWritingProfileService,
    {} as ContentStudioEditorialPolicyService,
    {} as ContentStudioAudienceProfileService,
    {} as ContentStudioExpertiseProfileService,
    {} as ContentStudioAIWritingService
  );
  return { service, handoffs, controller, result };
};

// A DTO that also carries fields it does not declare, as it would without the
// strict pipe: the controller must still forward only the declared fields
const withExtras = <T extends object>(dto: T) =>
  Object.assign(dto, { organizationId: 'org-b', createdById: 'user-b' });

describe('ContentStudioController wiring', () => {
  it('C1 lists projects of the request organization', async () => {
    const { service, controller, result } = setup();
    const query = withExtras(new ListContentStudioProjectsDto());
    query.archived = true;

    await expect(controller.listProjects(ORG, query)).resolves.toBe(result);
    expect(service.listProjects).toHaveBeenCalledWith('org-a', true);
  });

  it('C2 creates a project for the request organization and user', async () => {
    const { service, controller, result } = setup();
    const body = withExtras(new CreateContentStudioProjectDto());
    body.name = 'Launch';

    await expect(controller.createProject(ORG, USER, body)).resolves.toBe(
      result
    );
    expect(service.createProject).toHaveBeenCalledWith(
      'org-a',
      'user-1',
      'Launch'
    );
  });

  it('C3 renames a project of the request organization', async () => {
    const { service, controller } = setup();
    const body = withExtras(new UpdateContentStudioProjectDto());
    body.name = 'Renamed';

    await controller.updateProject(ORG, PROJECT_ID, body);
    expect(service.updateProjectName).toHaveBeenCalledWith(
      'org-a',
      PROJECT_ID,
      'Renamed'
    );
  });

  it('C4 archives and restores a project of the request organization', async () => {
    const { service, controller, result } = setup();

    await expect(controller.archiveProject(ORG, PROJECT_ID)).resolves.toBe(
      result
    );
    await expect(controller.restoreProject(ORG, PROJECT_ID)).resolves.toBe(
      result
    );
    expect(service.archiveProject).toHaveBeenCalledWith('org-a', PROJECT_ID);
    expect(service.restoreProject).toHaveBeenCalledWith('org-a', PROJECT_ID);
  });

  it('C5 lists packages with the declared query fields only', async () => {
    const { service, controller } = setup();
    const query = withExtras(new ListContentPackagesDto());
    query.page = 3;
    query.archived = true;
    query.projectId = PROJECT_ID;

    await controller.listPackages(ORG, query);
    expect(service.listPackages).toHaveBeenCalledWith({
      organizationId: 'org-a',
      archived: true,
      projectId: PROJECT_ID,
      page: 3,
    });
  });

  it('C6 creates a package with the declared body fields only', async () => {
    const { service, controller } = setup();
    const body = withExtras(new CreateContentPackageDto());
    body.name = 'Post';
    body.projectId = PROJECT_ID;

    await controller.createPackage(ORG, USER, body);
    expect(service.createPackage).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      name: 'Post',
      projectId: PROJECT_ID,
    });
  });

  it('C7 reads a package of the request organization', async () => {
    const { service, controller, result } = setup();

    await expect(controller.getPackage(ORG, 'package-1')).resolves.toBe(result);
    expect(service.getPackage).toHaveBeenCalledWith('org-a', 'package-1');
  });

  it('C8 updates a package with name and projectId only', async () => {
    const { service, controller } = setup();
    const body = withExtras(new UpdateContentPackageDto());
    body.projectId = null;

    await controller.updatePackage(ORG, 'package-1', body);
    expect(service.updatePackageMetadata).toHaveBeenCalledWith({
      organizationId: 'org-a',
      packageId: 'package-1',
      name: undefined,
      projectId: null,
    });
  });

  it('C9 archives and restores a package of the request organization', async () => {
    const { service, controller } = setup();

    await controller.archivePackage(ORG, 'package-1');
    await controller.restorePackage(ORG, 'package-1');
    expect(service.archivePackage).toHaveBeenCalledWith('org-a', 'package-1');
    expect(service.restorePackage).toHaveBeenCalledWith('org-a', 'package-1');
  });

  it('C10 saves a draft with the base version and the draft as sent', async () => {
    const { service, controller } = setup();
    const body = withExtras(new SaveContentPackageDraftDto());
    body.baseDraftVersion = 4;
    body.draft = DRAFT;

    await controller.saveDraft(ORG, 'package-1', body);
    expect(service.saveDraft).toHaveBeenCalledWith({
      organizationId: 'org-a',
      packageId: 'package-1',
      baseDraftVersion: 4,
      draft: DRAFT,
    });
    expect(service.saveDraft.mock.calls[0][0].draft).toBe(DRAFT);
  });

  it('C11 returns what the service returns', async () => {
    const { controller, result } = setup();

    for (const value of [
      controller.listPackages(ORG, new ListContentPackagesDto()),
      controller.updatePackage(ORG, 'package-1', new UpdateContentPackageDto()),
      controller.saveDraft(ORG, 'package-1', new SaveContentPackageDraftDto()),
    ]) {
      await expect(value).resolves.toBe(result);
    }
  });

  it('C12 takes the organization and user only from the request', () => {
    // route parameters: org (and user) come from decorators, the rest from
    // the DTOs below, none of which declares organizationId or createdById
    for (const dto of [
      ListContentStudioProjectsDto,
      CreateContentStudioProjectDto,
      UpdateContentStudioProjectDto,
      ListContentPackagesDto,
      CreateContentPackageDto,
      UpdateContentPackageDto,
      SaveContentPackageDraftDto,
      CreateContentPackageRevisionDto,
      ListContentPackageRevisionsDto,
    ]) {
      const fields = Object.keys(new dto());
      expect(fields).not.toContain('organizationId');
      expect(fields).not.toContain('createdById');
    }
    const types = (method: string) =>
      Reflect.getMetadata(
        'design:paramtypes',
        ContentStudioController.prototype,
        method
      );
    expect(types('listProjects')[1]).toBe(ListContentStudioProjectsDto);
    expect(types('createProject')[2]).toBe(CreateContentStudioProjectDto);
    expect(types('updateProject')[2]).toBe(UpdateContentStudioProjectDto);
    expect(types('listPackages')[1]).toBe(ListContentPackagesDto);
    expect(types('createPackage')[2]).toBe(CreateContentPackageDto);
    expect(types('updatePackage')[2]).toBe(UpdateContentPackageDto);
    expect(types('saveDraft')[2]).toBe(SaveContentPackageDraftDto);
    expect(types('createRevision')[3]).toBe(CreateContentPackageRevisionDto);
    expect(types('listRevisions')[2]).toBe(ListContentPackageRevisionsDto);
  });

  it('exposes exactly the project, package, draft, revision, handoff, AI connection, profile and AI writing routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ContentStudioController)).toBe(
      '/content-studio'
    );
    const routes = Object.getOwnPropertyNames(ContentStudioController.prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => {
        const handler = (
          ContentStudioController.prototype as unknown as Record<string, object>
        )[name];
        return `${
          RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)]
        } ${Reflect.getMetadata(PATH_METADATA, handler)}`;
      })
      .sort();

    expect(routes).toEqual([
      'GET /ai/connections',
      'GET /ai/connections/:id',
      'GET /ai/providers',
      'GET /audience-profiles',
      'GET /audience-profiles/:id',
      'GET /audience-profiles/:id/revisions',
      'GET /audience-profiles/:id/revisions/:revisionId',
      'GET /editorial-policy',
      'GET /editorial-policy/revisions',
      'GET /editorial-policy/revisions/:revisionId',
      'GET /expertise-profiles',
      'GET /expertise-profiles/:id',
      'GET /expertise-profiles/:id/revisions',
      'GET /expertise-profiles/:id/revisions/:revisionId',
      'GET /handoffs/:handoffId',
      'GET /packages',
      'GET /packages/:id',
      'GET /packages/:id/revisions',
      'GET /packages/:id/revisions/:revisionId',
      'GET /projects',
      'GET /writing-profiles',
      'GET /writing-profiles/:id',
      'GET /writing-profiles/:id/revisions',
      'GET /writing-profiles/:id/revisions/:revisionId',
      'PATCH /ai/connections/:id',
      'PATCH /audience-profiles/:id',
      'PATCH /expertise-profiles/:id',
      'PATCH /packages/:id',
      'PATCH /projects/:id',
      'PATCH /writing-profiles/:id',
      'POST /ai/connections',
      'POST /ai/connections/:id/archive',
      'POST /ai/connections/:id/disable',
      'POST /ai/connections/:id/enable',
      'POST /ai/connections/:id/test',
      'POST /audience-profiles',
      'POST /audience-profiles/:id/archive',
      'POST /audience-profiles/:id/restore',
      'POST /audience-profiles/:id/revisions',
      'POST /editorial-policy/revisions',
      'POST /expertise-profiles',
      'POST /expertise-profiles/:id/archive',
      'POST /expertise-profiles/:id/restore',
      'POST /expertise-profiles/:id/revisions',
      'POST /handoffs/:handoffId/revoke',
      'POST /packages',
      'POST /packages/:id/ai/item',
      'POST /packages/:id/ai/thread',
      'POST /packages/:id/archive',
      'POST /packages/:id/restore',
      'POST /packages/:id/revisions',
      'POST /packages/:id/revisions/:revisionId/handoffs',
      'POST /projects',
      'POST /projects/:id/archive',
      'POST /projects/:id/restore',
      'POST /writing-profiles',
      'POST /writing-profiles/:id/archive',
      'POST /writing-profiles/:id/restore',
      'POST /writing-profiles/:id/revisions',
      'PUT /ai/connections/:id/credential',
      'PUT /packages/:id/draft',
    ]);
  });
});

describe('ContentStudioController handoffs', () => {
  const handler = (name: string) =>
    (ContentStudioController.prototype as unknown as Record<string, object>)[
      name
    ];

  it('C21 C24 creates a handoff for the request org and user, package and revision', async () => {
    const { handoffs, controller, result } = setup();

    await expect(
      controller.createHandoff(ORG, USER, 'package-1', 'revision-1')
    ).resolves.toBe(result);
    expect(handoffs.createHandoff).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      packageId: 'package-1',
      revisionId: 'revision-1',
    });
  });

  it('C22 C25 opens a handoff for the request org and user', async () => {
    const { handoffs, controller, result } = setup();
    const opened = {
      id: 'h',
      onlyValues: [{ content: '<p>Hi</p>', image: [{ id: 'm1', path: '/p' }] }],
    };
    handoffs.resolveHandoff.mockResolvedValue(opened);

    await expect(controller.resolveHandoff(ORG, USER, 'h')).resolves.toBe(
      opened
    );
    expect(handoffs.resolveHandoff).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      handoffId: 'h',
    });
    expect(result).not.toBe(opened);
  });

  it('C23 C26 revokes a handoff for the request org and user', async () => {
    const { handoffs, controller, result } = setup();

    await expect(controller.revokeHandoff(ORG, USER, 'h')).resolves.toBe(
      result
    );
    expect(handoffs.revokeHandoff).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      handoffId: 'h',
    });
  });

  it('C27 C28 handoff routes read no body and answer 201, 200 and 200', () => {
    const routes = {
      createHandoff: 'POST /packages/:id/revisions/:revisionId/handoffs',
      resolveHandoff: 'GET /handoffs/:handoffId',
      revokeHandoff: 'POST /handoffs/:handoffId/revoke',
    };
    for (const [name, route] of Object.entries(routes)) {
      expect(
        `${
          RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler(name))]
        } ${Reflect.getMetadata(PATH_METADATA, handler(name))}`
      ).toBe(route);
      // org, user and route params only: no DTO class to fill from a body
      const types: unknown[] = Reflect.getMetadata(
        'design:paramtypes',
        ContentStudioController.prototype,
        name
      );
      expect(types).toEqual([
        Object,
        Object,
        ...types.slice(2).map(() => String),
      ]);
    }
    // create keeps Nest's POST default (201); revoke is set to 200
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handler('createHandoff'))
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handler('revokeHandoff'))
    ).toBe(200);
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handler('resolveHandoff'))
    ).toBeUndefined();
  });

  it('C29 C30 keeps the strict pipe on the controller that also serves handoffs', () => {
    expect(
      Reflect.getMetadata(PIPES_METADATA, ContentStudioController)
    ).toHaveLength(1);
    expect(
      Reflect.getMetadata('design:paramtypes', ContentStudioController)
    ).toEqual([
      ContentStudioService,
      ContentStudioHandoffService,
      ContentStudioAIConnectionService,
      ContentStudioWritingProfileService,
      ContentStudioEditorialPolicyService,
      ContentStudioAudienceProfileService,
      ContentStudioExpertiseProfileService,
      ContentStudioAIWritingService,
    ]);
  });
});

describe('ContentStudioController revisions', () => {
  const response = () => ({ status: jest.fn() });
  const revisionBody = (draftVersion: number, origin?: 'manual' | 'handoff') =>
    Object.assign(withExtras(new CreateContentPackageRevisionDto()), {
      draftVersion,
      ...(origin ? { origin } : {}),
    });

  it('C13 C16 creates a revision with the request org, user and declared fields', async () => {
    const { service, controller } = setup();
    const created = { created: true, revision: { id: 'revision-1' } };
    service.createRevision.mockResolvedValue(created);
    const res = response();

    await expect(
      controller.createRevision(
        ORG,
        USER,
        'package-1',
        revisionBody(5, 'handoff'),
        res as never
      )
    ).resolves.toBe(created);
    expect(service.createRevision).toHaveBeenCalledWith({
      organizationId: 'org-a',
      packageId: 'package-1',
      userId: 'user-1',
      draftVersion: 5,
      origin: 'handoff',
    });
  });

  it('C13 leaves the origin to the service when none is sent', async () => {
    const { service, controller } = setup();

    await controller.createRevision(
      ORG,
      USER,
      'package-1',
      revisionBody(5),
      response() as never
    );
    expect(service.createRevision.mock.calls[0][0].origin).toBeUndefined();
  });

  it('C20 answers 201 for a new revision and 200 for an unchanged draft', async () => {
    const { service, controller } = setup();
    for (const [created, status] of [
      [true, 201],
      [false, 200],
    ] as const) {
      service.createRevision.mockResolvedValue({ created, revision: {} });
      const res = response();

      await controller.createRevision(
        ORG,
        USER,
        'package-1',
        revisionBody(5),
        res as never
      );
      expect(res.status).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(status);
    }
  });

  it('C14 lists revisions of a package with the page', async () => {
    const { service, controller, result } = setup();
    const query = withExtras(new ListContentPackageRevisionsDto());
    query.page = 3;

    await expect(
      controller.listRevisions(ORG, 'package-1', query)
    ).resolves.toBe(result);
    expect(service.listRevisions).toHaveBeenCalledWith({
      organizationId: 'org-a',
      packageId: 'package-1',
      page: 3,
    });
  });

  it('C15 reads one revision of a package', async () => {
    const { service, controller, result } = setup();

    await expect(
      controller.getRevision(ORG, 'package-1', 'revision-1')
    ).resolves.toBe(result);
    expect(service.getRevision).toHaveBeenCalledWith({
      organizationId: 'org-a',
      packageId: 'package-1',
      revisionId: 'revision-1',
    });
  });

  it('C19 has no route that changes or deletes a revision', () => {
    const handlers = Object.getOwnPropertyNames(
      ContentStudioController.prototype
    )
      .filter((name) => name !== 'constructor')
      .map(
        (name) =>
          (
            ContentStudioController.prototype as unknown as Record<
              string,
              object
            >
          )[name]
      );
    const revisionRoutes = handlers
      .map(
        (handler) =>
          `${
            RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)]
          } ${Reflect.getMetadata(PATH_METADATA, handler)}`
      )
      .filter((route) => route.includes('/revisions'))
      .sort();
    // the only route below a revision creates a handoff from it
    expect(
      revisionRoutes.filter((route) => /^(PATCH|PUT|DELETE) /.test(route))
    ).toEqual([]);

    expect(revisionRoutes).toEqual([
      'GET /audience-profiles/:id/revisions',
      'GET /audience-profiles/:id/revisions/:revisionId',
      'GET /editorial-policy/revisions',
      'GET /editorial-policy/revisions/:revisionId',
      'GET /expertise-profiles/:id/revisions',
      'GET /expertise-profiles/:id/revisions/:revisionId',
      'GET /packages/:id/revisions',
      'GET /packages/:id/revisions/:revisionId',
      'GET /writing-profiles/:id/revisions',
      'GET /writing-profiles/:id/revisions/:revisionId',
      'POST /audience-profiles/:id/revisions',
      'POST /editorial-policy/revisions',
      'POST /expertise-profiles/:id/revisions',
      'POST /packages/:id/revisions',
      'POST /packages/:id/revisions/:revisionId/handoffs',
      'POST /writing-profiles/:id/revisions',
    ]);
  });
});

// Runs a request value through the pipes Nest would use: the global
// ValidationPipe from main.ts first, then the pipe declared on the controller
const controllerPipes = (): PipeTransform[] =>
  Reflect.getMetadata(PIPES_METADATA, ContentStudioController);
const globalPipe = new ValidationPipe({ transform: true });
const run = async (
  type: ArgumentMetadata['type'],
  metatype: ArgumentMetadata['metatype'],
  value: unknown
) => {
  const metadata: ArgumentMetadata = { type, metatype, data: undefined };
  let current = await globalPipe.transform(value, metadata);
  for (const pipe of controllerPipes()) {
    current = await pipe.transform(current, metadata);
  }
  return current;
};
const rejected = async (
  type: ArgumentMetadata['type'],
  metatype: ArgumentMetadata['metatype'],
  value: unknown
) => {
  const error = await run(type, metatype, value).then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(BadRequestException);
  return JSON.stringify((error as BadRequestException).getResponse());
};
// The controller pipe on its own: the extra fields must be rejected there,
// whatever the global pipe does
const strictOnly = async (
  type: ArgumentMetadata['type'],
  metatype: ArgumentMetadata['metatype'],
  value: unknown
) => {
  const [pipe] = controllerPipes();
  return pipe.transform(value, { type, metatype, data: undefined });
};

describe('ContentStudioController validation', () => {
  it('declares one strict ValidationPipe on the controller', () => {
    const pipes = controllerPipes();
    expect(pipes).toHaveLength(1);
    expect(pipes[0]).toBeInstanceOf(ValidationPipe);
    const options = pipes[0] as unknown as {
      isTransformEnabled: boolean;
      validatorOptions: { whitelist?: boolean; forbidNonWhitelisted?: boolean };
    };
    expect(options.isTransformEnabled).toBe(true);
    expect(options.validatorOptions).toMatchObject({
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  });

  it.each([
    ['organizationId', CreateContentPackageDto, { organizationId: 'org-b' }],
    ['createdById', CreateContentPackageDto, { createdById: 'user-b' }],
    ['draftVersion', UpdateContentPackageDto, { name: 'x', draftVersion: 9 }],
    [
      'latestRevisionNumber',
      UpdateContentPackageDto,
      { name: 'x', latestRevisionNumber: 9 },
    ],
    ['archivedAt', UpdateContentPackageDto, { name: 'x', archivedAt: null }],
    [
      'organizationId',
      CreateContentStudioProjectDto,
      { name: 'x', organizationId: 'org-b' },
    ],
    [
      'organizationId',
      UpdateContentStudioProjectDto,
      { name: 'x', organizationId: 'org-b' },
    ],
    [
      'organizationId',
      SaveContentPackageDraftDto,
      { baseDraftVersion: 1, draft: DRAFT, organizationId: 'org-b' },
    ],
  ])('rejects a body with %s (%p)', async (field, dto, body) => {
    const message = await rejected('body', dto, body);
    expect(message).toContain(`property ${field} should not exist`);
    await expect(strictOnly('body', dto, body)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('rejects a query with organizationId', async () => {
    expect(
      await rejected('query', ListContentPackagesDto, {
        organizationId: 'org-b',
      })
    ).toContain('property organizationId should not exist');
    expect(
      await rejected('query', ListContentStudioProjectsDto, {
        organizationId: 'org-b',
      })
    ).toContain('property organizationId should not exist');
  });

  it('applies query defaults: page 1, active packages', async () => {
    const query = await run('query', ListContentPackagesDto, {});
    expect(query).toBeInstanceOf(ListContentPackagesDto);
    expect({ ...query }).toEqual({ page: 1, archived: false });
    expect({
      ...(await run('query', ListContentStudioProjectsDto, {})),
    }).toEqual({ archived: false });
  });

  it.each([
    ['2', 2],
    ['007', 7],
    ['100000', 100000],
  ])('turns page %p into %p', async (page, expected) => {
    expect((await run('query', ListContentPackagesDto, { page })).page).toBe(
      expected
    );
  });

  it.each([['0'], ['-1'], ['1.5'], ['2abc'], [''], ['100001'], [['1', '2']]])(
    'rejects page %p',
    async (page) => {
      await rejected('query', ListContentPackagesDto, { page });
    }
  );

  it.each([
    ['true', true],
    ['false', false],
  ])('turns archived %p into %p', async (archived, expected) => {
    expect(
      (await run('query', ListContentPackagesDto, { archived })).archived
    ).toBe(expected);
    expect(
      (await run('query', ListContentStudioProjectsDto, { archived })).archived
    ).toBe(expected);
  });

  it.each([['banana'], ['1'], ['0'], ['TRUE'], [''], [['true', 'false']]])(
    'rejects archived %p',
    async (archived) => {
      await rejected('query', ListContentPackagesDto, { archived });
      await rejected('query', ListContentStudioProjectsDto, { archived });
    }
  );

  it('accepts a project uuid filter and rejects anything else', async () => {
    expect(
      (await run('query', ListContentPackagesDto, { projectId: PROJECT_ID }))
        .projectId
    ).toBe(PROJECT_ID);
    await rejected('query', ListContentPackagesDto, { projectId: 'project-1' });
    await rejected('query', ListContentPackagesDto, {
      projectId: '../projects',
    });
  });

  it('limits project names to 100 characters', async () => {
    for (const dto of [
      CreateContentStudioProjectDto,
      UpdateContentStudioProjectDto,
    ]) {
      expect(
        (await run('body', dto, { name: 'p'.repeat(100) })).name
      ).toHaveLength(100);
      await rejected('body', dto, { name: 'p'.repeat(101) });
      await rejected('body', dto, {});
      await rejected('body', dto, { name: null });
      await rejected('body', dto, { name: 5 });
    }
  });

  it('limits package names to 200 characters', async () => {
    for (const dto of [CreateContentPackageDto, UpdateContentPackageDto]) {
      expect(
        (await run('body', dto, { name: 'p'.repeat(200) })).name
      ).toHaveLength(200);
      await rejected('body', dto, { name: 'p'.repeat(201) });
      await rejected('body', dto, { name: null });
    }
  });

  it('accepts an empty create body and an update that detaches the project', async () => {
    expect({ ...(await run('body', CreateContentPackageDto, {})) }).toEqual({});
    expect({
      ...(await run('body', UpdateContentPackageDto, { projectId: null })),
    }).toEqual({ projectId: null });
    // an empty update passes here; the service answers it with a 400
    expect({ ...(await run('body', UpdateContentPackageDto, {})) }).toEqual({});
  });

  it('accepts project uuids only on create and update', async () => {
    expect(
      (await run('body', CreateContentPackageDto, { projectId: PROJECT_ID }))
        .projectId
    ).toBe(PROJECT_ID);
    for (const projectId of ['project-1', '', 5]) {
      await rejected('body', CreateContentPackageDto, { projectId });
      await rejected('body', UpdateContentPackageDto, { projectId });
    }
    await rejected('body', CreateContentPackageDto, { projectId: null });
  });

  it.each([[0], [-1], [1.5], ['4'], [null], [2_147_483_648]])(
    'rejects baseDraftVersion %p',
    async (baseDraftVersion) => {
      await rejected('body', SaveContentPackageDraftDto, {
        baseDraftVersion,
        draft: DRAFT,
      });
    }
  );

  it.each([[null], ['{}'], [[DRAFT]], [5]])(
    'rejects a draft that is not an object (%p)',
    async (draft) => {
      await rejected('body', SaveContentPackageDraftDto, {
        baseDraftVersion: 1,
        draft,
      });
    }
  );

  it('passes the draft object through untouched for the service to validate', async () => {
    // unknown nested fields are not class-validator's job: they reach the
    // service, whose draft schema rejects them (see the service spec)
    const draft = JSON.parse(
      '{"schemaVersion":1,"copy":{"global":{"thread":[{"id":"a","text":"","mediaIds":[],"html":"<b>"}]},"organizationId":"org-b"},"__proto__":{"x":1}}'
    );
    const body = await run('body', SaveContentPackageDraftDto, {
      baseDraftVersion: 3,
      draft,
    });

    expect(body).toBeInstanceOf(SaveContentPackageDraftDto);
    expect(body.baseDraftVersion).toBe(3);
    expect(body.draft).toBe(draft);
    // Nest's ValidationPipe deletes __proto__ keys; nothing else is touched
    expect(Object.keys(body.draft)).toEqual(['schemaVersion', 'copy']);
    expect(body.draft.copy.organizationId).toBe('org-b');
  });
});

describe('ContentStudioController revision validation', () => {
  it('C17 accepts a draft version and an allowed origin', async () => {
    for (const body of [
      { draftVersion: 1 },
      { draftVersion: 2_147_483_647, origin: 'manual' },
      { draftVersion: 4, origin: 'handoff' },
    ]) {
      const dto = await run('body', CreateContentPackageRevisionDto, body);
      expect(dto).toBeInstanceOf(CreateContentPackageRevisionDto);
      expect({ ...dto }).toEqual(body);
    }
  });

  it.each([
    [{}],
    [{ draftVersion: 0 }],
    [{ draftVersion: 2_147_483_648 }],
    [{ draftVersion: 1.5 }],
    [{ draftVersion: '4' }],
    [{ draftVersion: 1, origin: 'ai' }],
    [{ draftVersion: 1, origin: 'approval' }],
    [{ draftVersion: 1, origin: 'MANUAL' }],
    [{ draftVersion: 1, origin: null }],
  ])('C17 rejects the revision body %p', async (body) => {
    await rejected('body', CreateContentPackageRevisionDto, body);
  });

  it.each([
    ['organizationId', { draftVersion: 1, organizationId: 'org-b' }],
    ['createdById', { draftVersion: 1, createdById: 'user-b' }],
    ['sourceDraftVersion', { draftVersion: 1, sourceDraftVersion: 9 }],
    ['revisionNumber', { draftVersion: 1, revisionNumber: 9 }],
    ['content', { draftVersion: 1, content: '{}' }],
  ])('C17 rejects a revision body with %s', async (field, body) => {
    expect(
      await rejected('body', CreateContentPackageRevisionDto, body)
    ).toContain(`property ${field} should not exist`);
  });

  it('C18 parses the revision page', async () => {
    expect({
      ...(await run('query', ListContentPackageRevisionsDto, {})),
    }).toEqual({ page: 1 });
    expect(
      (await run('query', ListContentPackageRevisionsDto, { page: '3' })).page
    ).toBe(3);
  });

  it.each([
    [{ page: '0' }],
    [{ page: '100001' }],
    [{ page: '2abc' }],
    [{ organizationId: 'org-b' }],
    [{ archived: 'true' }],
  ])('C18 rejects the revision query %p', async (query) => {
    await rejected('query', ListContentPackageRevisionsDto, query);
  });
});
