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
import fs from 'fs';
import path from 'path';
import { Organization, User } from '@prisma/client';
import { ContentStudioController } from '@gitroom/backend/api/routes/content-studio.controller';
import { ContentStudioService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.service';
import { ContentStudioHandoffService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.handoff.service';
import { ContentStudioAIConnectionService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-connection.service';
import { ContentStudioWritingProfileService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.writing-profile.service';
import { ContentStudioAudienceProfileService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.audience-profile.service';
import { ContentStudioExpertiseProfileService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.expertise-profile.service';
import { ContentStudioAIWritingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-writing.service';
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import { ContentStudioSourceIngestionService } from '@gitroom/nestjs-libraries/content-studio/sources/ingestion/source.ingestion.service';
import { ContentStudioEditorialPolicyService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.service';
import {
  CreateContentStudioExpertiseProfileDto,
  CreateContentStudioExpertiseProfileRevisionDto,
  ListContentStudioExpertiseProfileRevisionsDto,
  ListContentStudioExpertiseProfilesDto,
  UpdateContentStudioExpertiseProfileDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.expertise-profile.dto';

// The real MediaService pulls in uploads, Redis and Temporal at import time;
// the composer serializer needs a DOM. Neither is used by these routes
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({
    MediaService: class MediaService {},
  })
);
jest.mock('@gitroom/nestjs-libraries/content-studio/handoff.html', () => ({
  contentStudioTextToComposerHtml: (text: string) => text,
}));

const MARKER = 'EXPERTISE_PROFILE_SECRET_MARKER_123';
const ID = '33333333-3333-4333-8333-333333333333';
const REVISION = '66666666-6666-4666-8666-666666666666';
// an ordinary member: Expertise Profiles need no manager role
const ORG = {
  id: 'org-a',
  users: [{ disabled: false, role: 'USER' }],
} as unknown as Organization;
const USER = { id: 'user-1' } as User;

const content = () => ({
  schemaVersion: 1,
  subjects: [],
  differentiators: [],
  stances: [{ topic: 'Remote work', position: `Good. ${MARKER}` }],
  frameworks: [],
  evidenceExpectations: MARKER,
  avoidTopics: [],
  confidenceBoundaries: '',
});

const setup = () => {
  const result = { from: 'service' };
  const profiles = {
    listProfiles: jest.fn().mockResolvedValue(result),
    createProfile: jest.fn().mockResolvedValue(result),
    getProfile: jest.fn().mockResolvedValue(result),
    renameProfile: jest.fn().mockResolvedValue(result),
    createRevision: jest.fn().mockResolvedValue(result),
    listRevisions: jest.fn().mockResolvedValue(result),
    getRevision: jest.fn().mockResolvedValue(result),
    archiveProfile: jest.fn().mockResolvedValue(result),
    restoreProfile: jest.fn().mockResolvedValue(result),
  };
  const controller = new ContentStudioController(
    {} as ContentStudioService,
    {} as ContentStudioHandoffService,
    {} as ContentStudioAIConnectionService,
    {} as ContentStudioWritingProfileService,
    {} as ContentStudioEditorialPolicyService,
    {} as ContentStudioAudienceProfileService,
    profiles as unknown as ContentStudioExpertiseProfileService,
    {} as ContentStudioAIWritingService,
    {} as ContentStudioSourceService,
    {} as ContentStudioSourceIngestionService
  );
  return { profiles, controller, result };
};

// A DTO that also carries fields it does not declare, as it would without the
// strict pipe: the controller must still forward only the declared fields
const withExtras = <T extends object>(dto: T) =>
  Object.assign(dto, {
    organizationId: 'org-b',
    createdById: 'user-b',
    revisionNumber: 9,
    contentHash: 'f'.repeat(64),
  });

const handler = (name: string) =>
  (ContentStudioController.prototype as unknown as Record<string, object>)[
    name
  ];
const route = (name: string) =>
  `${
    RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler(name))]
  } ${Reflect.getMetadata(PATH_METADATA, handler(name))}`;

describe('ContentStudioController expertise profile routes', () => {
  it('XC1-XC9 declares exactly these routes, with 200 for archive and restore', () => {
    const names = Object.getOwnPropertyNames(
      ContentStudioController.prototype
    ).filter((name) => /ExpertiseProfile/.test(name));
    expect(names.map(route).sort()).toEqual([
      'GET /expertise-profiles',
      'GET /expertise-profiles/:id',
      'GET /expertise-profiles/:id/revisions',
      'GET /expertise-profiles/:id/revisions/:revisionId',
      'PATCH /expertise-profiles/:id',
      'POST /expertise-profiles',
      'POST /expertise-profiles/:id/archive',
      'POST /expertise-profiles/:id/restore',
      'POST /expertise-profiles/:id/revisions',
    ]);
    for (const name of ['archiveExpertiseProfile', 'restoreExpertiseProfile']) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))).toBe(200);
    }
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handler('createExpertiseProfile'))
    ).toBeUndefined();
  });

  it('has no delete, generate, infer, verify, facts, ground, sources, import or AI route for profiles', () => {
    const routes = Object.getOwnPropertyNames(ContentStudioController.prototype)
      .filter((name) => name !== 'constructor')
      .map(route);
    expect(
      routes.filter(
        (r) =>
          /expertise/i.test(r) &&
          (/^DELETE /.test(r) ||
            /generate|infer|verif|fact|ground|source|citation|validate|analy|import|upload|website|learn|ai/i.test(
              r.replace('/expertise-profiles', '')
            ))
      )
    ).toEqual([]);
    expect(routes.filter((r) => r.startsWith('DELETE '))).toEqual([]);
  });

  it('XC1 lists for the request organization', async () => {
    const { profiles, controller, result } = setup();
    const query = Object.assign(new ListContentStudioExpertiseProfilesDto(), {
      page: 2,
      archived: true,
    });
    await expect(controller.listExpertiseProfiles(ORG, query)).resolves.toBe(
      result
    );
    expect(profiles.listProfiles).toHaveBeenCalledWith({
      organizationId: 'org-a',
      archived: true,
      page: 2,
    });
  });

  it('XC2 creates for the request organization and user with the declared fields only', async () => {
    const { profiles, controller } = setup();
    const body = withExtras(new CreateContentStudioExpertiseProfileDto());
    body.name = 'Tax expertise';
    body.content = content();
    await controller.createExpertiseProfile(ORG, USER, body);
    expect(profiles.createProfile).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      name: 'Tax expertise',
      content: content(),
    });
  });

  it('XC3/XC4 reads and renames with the request organization', async () => {
    const { profiles, controller } = setup();
    await controller.getExpertiseProfile(ORG, ID);
    const body = withExtras(new UpdateContentStudioExpertiseProfileDto());
    body.name = 'Renamed';
    await controller.updateExpertiseProfile(ORG, ID, body);
    expect(profiles.getProfile).toHaveBeenCalledWith('org-a', ID);
    expect(profiles.renameProfile).toHaveBeenCalledWith('org-a', ID, 'Renamed');
  });

  it('XC5 saves a revision by the request user with the declared fields only', async () => {
    const { profiles, controller } = setup();
    const body = withExtras(
      new CreateContentStudioExpertiseProfileRevisionDto()
    );
    body.baseRevisionNumber = 2;
    body.content = content();
    await controller.createExpertiseProfileRevision(ORG, USER, ID, body);
    expect(profiles.createRevision).toHaveBeenCalledWith({
      organizationId: 'org-a',
      profileId: ID,
      userId: 'user-1',
      baseRevisionNumber: 2,
      content: content(),
    });
  });

  it('XC6/XC7 reads the history and a revision of the request organization', async () => {
    const { profiles, controller } = setup();
    const query = Object.assign(
      new ListContentStudioExpertiseProfileRevisionsDto(),
      { page: 3 }
    );
    await controller.listExpertiseProfileRevisions(ORG, ID, query);
    await controller.getExpertiseProfileRevision(ORG, ID, REVISION);
    expect(profiles.listRevisions).toHaveBeenCalledWith({
      organizationId: 'org-a',
      profileId: ID,
      page: 3,
    });
    expect(profiles.getRevision).toHaveBeenCalledWith({
      organizationId: 'org-a',
      profileId: ID,
      revisionId: REVISION,
    });
  });

  it('XC8/XC9 archives and restores for any member of the request organization', async () => {
    const { profiles, controller } = setup();
    await controller.archiveExpertiseProfile(ORG, ID);
    await controller.restoreExpertiseProfile(ORG, ID);
    expect(profiles.archiveProfile).toHaveBeenCalledWith('org-a', ID);
    expect(profiles.restoreProfile).toHaveBeenCalledWith('org-a', ID);
  });

  it('declares the DTOs and adds no role, billing or AI gate', () => {
    const types = (method: string) =>
      Reflect.getMetadata(
        'design:paramtypes',
        ContentStudioController.prototype,
        method
      );
    expect(types('createExpertiseProfile')[2]).toBe(
      CreateContentStudioExpertiseProfileDto
    );
    expect(types('updateExpertiseProfile')[2]).toBe(
      UpdateContentStudioExpertiseProfileDto
    );
    expect(types('createExpertiseProfileRevision')[3]).toBe(
      CreateContentStudioExpertiseProfileRevisionDto
    );
    const text = fs.readFileSync(
      path.join(__dirname, 'content-studio.controller.ts'),
      'utf8'
    );
    expect(text).not.toMatch(/CheckPolicies|Sections\.|@Delete\(/);
    const block = text.slice(text.indexOf("@Get('/expertise-profiles')"));
    expect(block).not.toMatch(/AIConnection|AIExecution|Role\./);
  });
});

// Runs a request value through the pipes Nest would use: the global
// ValidationPipe from main.ts first, then the pipe declared on the controller
const controllerPipes = (): PipeTransform[] =>
  Reflect.getMetadata(PIPES_METADATA, ContentStudioController);
const globalPipe = new ValidationPipe({ transform: true });
const run = async (
  metatype: ArgumentMetadata['metatype'],
  value: unknown,
  type: ArgumentMetadata['type'] = 'body'
) => {
  const metadata: ArgumentMetadata = { type, metatype, data: undefined };
  let current = await globalPipe.transform(value, metadata);
  for (const pipe of controllerPipes()) {
    current = await pipe.transform(current, metadata);
  }
  return current;
};
const rejected = async (
  metatype: ArgumentMetadata['metatype'],
  value: unknown,
  type: ArgumentMetadata['type'] = 'body'
) => {
  const error = await run(metatype, value, type).then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(BadRequestException);
  const message = JSON.stringify((error as BadRequestException).getResponse());
  expect(message).not.toContain(MARKER);
  return message;
};

describe('Expertise profile DTO validation', () => {
  it('XD1 accepts a valid create body and keeps the content as sent', async () => {
    const body = await run(CreateContentStudioExpertiseProfileDto, {
      name: 'Tax expertise',
      content: content(),
    });
    expect(body).toBeInstanceOf(CreateContentStudioExpertiseProfileDto);
    expect({ ...body }).toEqual({ name: 'Tax expertise', content: content() });
  });

  it.each([
    ['XD2 no name', { content: content() }],
    ['XD3 no content', { name: 'Tax expertise' }],
    ['content as text', { name: 'Tax expertise', content: 'Warm' }],
    ['content as null', { name: 'Tax expertise', content: null }],
    [
      'a name over 100 characters',
      { name: 'n'.repeat(101), content: content() },
    ],
  ])('refuses a create body with %s', async (_name, body) => {
    await rejected(CreateContentStudioExpertiseProfileDto, body);
  });

  it.each([
    [
      'XD4 organizationId',
      CreateContentStudioExpertiseProfileDto,
      { organizationId: 'org-b' },
    ],
    [
      'XD5 createdById',
      CreateContentStudioExpertiseProfileDto,
      { createdById: 'u' },
    ],
    [
      'XD6 revisionNumber',
      CreateContentStudioExpertiseProfileDto,
      { revisionNumber: 1 },
    ],
    [
      'XD7 contentHash',
      CreateContentStudioExpertiseProfileDto,
      { contentHash: 'f' },
    ],
    [
      'latestRevisionNumber',
      CreateContentStudioExpertiseProfileDto,
      { latestRevisionNumber: 1 },
    ],
    [
      'archivedAt',
      CreateContentStudioExpertiseProfileDto,
      { archivedAt: null },
    ],
    [
      'XD8 verified',
      CreateContentStudioExpertiseProfileDto,
      { verified: true },
    ],
    ['XD9 sources', CreateContentStudioExpertiseProfileDto, { sources: [] }],
    [
      'verified',
      CreateContentStudioExpertiseProfileRevisionDto,
      { verified: true },
    ],
    [
      'citations',
      CreateContentStudioExpertiseProfileRevisionDto,
      { citations: [] },
    ],
    [
      'XD11 content',
      UpdateContentStudioExpertiseProfileDto,
      { content: content() },
    ],
    [
      'organizationId',
      UpdateContentStudioExpertiseProfileDto,
      { organizationId: 'org-b' },
    ],
    [
      'revisionNumber',
      CreateContentStudioExpertiseProfileRevisionDto,
      { revisionNumber: 3 },
    ],
    [
      'contentHash',
      CreateContentStudioExpertiseProfileRevisionDto,
      { contentHash: 'f' },
    ],
    [
      'createdById',
      CreateContentStudioExpertiseProfileRevisionDto,
      { createdById: 'u' },
    ],
  ])('refuses a body with %s', async (field, dto, extra) => {
    const base =
      dto === CreateContentStudioExpertiseProfileDto
        ? { name: 'Tax expertise', content: content() }
        : dto === UpdateContentStudioExpertiseProfileDto
        ? { name: 'Tax expertise' }
        : { baseRevisionNumber: 1, content: content() };
    const message = await rejected(dto, { ...base, ...extra });
    expect(message).toContain(
      `property ${field.replace(/^XD\d+ /, '')} should not exist`
    );
  });

  it('XD10 takes a rename with the name only', async () => {
    expect({
      ...(await run(UpdateContentStudioExpertiseProfileDto, {
        name: 'Renamed',
      })),
    }).toEqual({ name: 'Renamed' });
    await rejected(UpdateContentStudioExpertiseProfileDto, {});
  });

  it.each([
    ['XD12 no base revision', { content: content() }],
    ['XD13 no content', { baseRevisionNumber: 1 }],
    ['base 0', { baseRevisionNumber: 0, content: content() }],
    ['a fractional base', { baseRevisionNumber: 1.5, content: content() }],
    ['a base past int4', { baseRevisionNumber: 2 ** 31, content: content() }],
    ['a text base', { baseRevisionNumber: '1', content: content() }],
  ])('refuses a revision body with %s', async (_name, body) => {
    await rejected(CreateContentStudioExpertiseProfileRevisionDto, body);
  });

  it('XD14 leaves nested expertise content to the strict domain parser', async () => {
    // class-validator does not look inside content; the service's parser
    // refuses the unknown field with CS_PROFILE_INVALID
    const body = await run(CreateContentStudioExpertiseProfileRevisionDto, {
      baseRevisionNumber: 1,
      content: { ...content(), verified: MARKER },
    });
    expect(body.content).toEqual({ ...content(), verified: MARKER });
  });

  it('XD15/XD16 parses the list query exactly', async () => {
    expect({
      ...(await run(ListContentStudioExpertiseProfilesDto, {}, 'query')),
    }).toEqual({ page: 1, archived: false });
    expect({
      ...(await run(
        ListContentStudioExpertiseProfilesDto,
        { page: '3', archived: 'true' },
        'query'
      )),
    }).toEqual({ page: 3, archived: true });
    for (const query of [
      { archived: 'yes' },
      { archived: '1' },
      { page: '0' },
      { page: '100001' },
      { page: '1.5' },
      { page: 'abc' },
      { organizationId: 'org-b' },
    ]) {
      await rejected(ListContentStudioExpertiseProfilesDto, query, 'query');
    }
    expect({
      ...(await run(
        ListContentStudioExpertiseProfileRevisionsDto,
        { page: '2' },
        'query'
      )),
    }).toEqual({ page: 2 });
    await rejected(
      ListContentStudioExpertiseProfileRevisionsDto,
      { page: '-1' },
      'query'
    );
  });
});
