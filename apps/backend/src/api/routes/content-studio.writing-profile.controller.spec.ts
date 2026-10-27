import { ContentStudioAISetupService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-setup.service';
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
import { ContentStudioEditorialPolicyService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.service';
import { ContentStudioAudienceProfileService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.audience-profile.service';
import { ContentStudioExpertiseProfileService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.expertise-profile.service';
import { ContentStudioAIWritingService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-writing.service';
import { ContentStudioSourceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source.service';
import { ContentStudioSourceIngestionService } from '@gitroom/nestjs-libraries/content-studio/sources/ingestion/source.ingestion.service';
import { ContentStudioBrandKitService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.service';
import { ContentStudioDesignService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design.service';
import { ContentStudioRenderFontService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.render-font.service';
import { ContentStudioDesignRenderService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-render.service';
import { ContentStudioDesignReferenceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-reference.service';
import { ContentStudioDesignTemplateService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-template.service';
import { ContentStudioDesignStylePresetService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-style-preset.service';
import { ContentStudioDesignLayoutPatternService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-layout-pattern.service';
import { ContentStudioDesignPageSetService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-page-set.service';
import { ContentStudioDesignBlockService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-block.service';
import { ContentStudioReviewService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.service';
import {
  CreateContentStudioWritingProfileDto,
  CreateContentStudioWritingProfileRevisionDto,
  ListContentStudioWritingProfileRevisionsDto,
  ListContentStudioWritingProfilesDto,
  UpdateContentStudioWritingProfileDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.writing-profile.dto';
import { ContentStudioDesignAIService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-ai.service';

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

const MARKER = 'WRITING_PROFILE_SECRET_MARKER_123';
const ID = '33333333-3333-4333-8333-333333333333';
const REVISION = '66666666-6666-4666-8666-666666666666';
// an ordinary member: Writing Profiles need no manager role
const ORG = {
  id: 'org-a',
  users: [{ disabled: false, role: 'USER' }],
} as unknown as Organization;
const USER = { id: 'user-1' } as User;

const content = () => ({
  schemaVersion: 1,
  voice: `Warm. ${MARKER}`,
  toneTags: ['warm'],
  perspective: null,
  formatting: { emoji: 'none', hashtags: 'none', notes: null },
  vocabulary: { prefer: [], avoid: [] },
  dos: [],
  donts: [],
  examples: [],
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
    profiles as unknown as ContentStudioWritingProfileService,
    {} as ContentStudioEditorialPolicyService,
    {} as ContentStudioAudienceProfileService,
    {} as ContentStudioExpertiseProfileService,
    {} as ContentStudioAIWritingService,
    {} as ContentStudioSourceService,
    {} as ContentStudioSourceIngestionService,
    {} as ContentStudioBrandKitService,
    {} as ContentStudioDesignService,
    {} as ContentStudioRenderFontService,
    {} as ContentStudioDesignRenderService,
    {} as ContentStudioDesignReferenceService,
    {} as ContentStudioDesignTemplateService,
    {} as ContentStudioDesignStylePresetService,
    {} as ContentStudioDesignLayoutPatternService,
    {} as ContentStudioDesignPageSetService,
    {} as ContentStudioDesignBlockService,
    {} as ContentStudioReviewService,
    {} as ContentStudioDesignAIService,
    {} as ContentStudioAISetupService
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

describe('ContentStudioController writing profile routes', () => {
  it('WC1-WC9 declares exactly these routes, with 200 for archive and restore', () => {
    const names = Object.getOwnPropertyNames(
      ContentStudioController.prototype
    ).filter((name) => /WritingProfile/.test(name));
    expect(names.map(route).sort()).toEqual([
      'GET /writing-profiles',
      'GET /writing-profiles/:id',
      'GET /writing-profiles/:id/revisions',
      'GET /writing-profiles/:id/revisions/:revisionId',
      'PATCH /writing-profiles/:id',
      'POST /writing-profiles',
      'POST /writing-profiles/:id/archive',
      'POST /writing-profiles/:id/restore',
      'POST /writing-profiles/:id/revisions',
    ]);
    for (const name of ['archiveWritingProfile', 'restoreWritingProfile']) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))).toBe(200);
    }
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handler('createWritingProfile'))
    ).toBeUndefined();
  });

  it('has no delete, generate, analyze, import or AI route for profiles', () => {
    const routes = Object.getOwnPropertyNames(ContentStudioController.prototype)
      .filter((name) => name !== 'constructor')
      .map(route);
    expect(
      routes.filter(
        (r) =>
          /writing|profile/i.test(r) &&
          (/^DELETE /.test(r) ||
            /generate|analy|import|source|website|learn|infer|ai/i.test(
              r.replace('/writing-profiles', '')
            ))
      )
    ).toEqual([]);
    expect(routes.filter((r) => r.startsWith('DELETE '))).toEqual([]);
  });

  it('WC1 lists for the request organization', async () => {
    const { profiles, controller, result } = setup();
    const query = Object.assign(new ListContentStudioWritingProfilesDto(), {
      page: 2,
      archived: true,
    });
    await expect(controller.listWritingProfiles(ORG, query)).resolves.toBe(
      result
    );
    expect(profiles.listProfiles).toHaveBeenCalledWith({
      organizationId: 'org-a',
      archived: true,
      page: 2,
    });
  });

  it('WC2 creates for the request organization and user with the declared fields only', async () => {
    const { profiles, controller } = setup();
    const body = withExtras(new CreateContentStudioWritingProfileDto());
    body.name = 'Voice';
    body.content = content();
    await controller.createWritingProfile(ORG, USER, body);
    expect(profiles.createProfile).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      name: 'Voice',
      content: content(),
    });
  });

  it('WC3/WC4 reads and renames with the request organization', async () => {
    const { profiles, controller } = setup();
    await controller.getWritingProfile(ORG, ID);
    const body = withExtras(new UpdateContentStudioWritingProfileDto());
    body.name = 'Renamed';
    await controller.updateWritingProfile(ORG, ID, body);
    expect(profiles.getProfile).toHaveBeenCalledWith('org-a', ID);
    expect(profiles.renameProfile).toHaveBeenCalledWith('org-a', ID, 'Renamed');
  });

  it('WC5 saves a revision by the request user with the declared fields only', async () => {
    const { profiles, controller } = setup();
    const body = withExtras(new CreateContentStudioWritingProfileRevisionDto());
    body.baseRevisionNumber = 2;
    body.content = content();
    await controller.createWritingProfileRevision(ORG, USER, ID, body);
    expect(profiles.createRevision).toHaveBeenCalledWith({
      organizationId: 'org-a',
      profileId: ID,
      userId: 'user-1',
      baseRevisionNumber: 2,
      content: content(),
    });
  });

  it('WC6/WC7 reads the history and a revision of the request organization', async () => {
    const { profiles, controller } = setup();
    const query = Object.assign(
      new ListContentStudioWritingProfileRevisionsDto(),
      { page: 3 }
    );
    await controller.listWritingProfileRevisions(ORG, ID, query);
    await controller.getWritingProfileRevision(ORG, ID, REVISION);
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

  it('WC8/WC9 archives and restores for any member of the request organization', async () => {
    const { profiles, controller } = setup();
    await controller.archiveWritingProfile(ORG, ID);
    await controller.restoreWritingProfile(ORG, ID);
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
    expect(types('createWritingProfile')[2]).toBe(
      CreateContentStudioWritingProfileDto
    );
    expect(types('updateWritingProfile')[2]).toBe(
      UpdateContentStudioWritingProfileDto
    );
    expect(types('createWritingProfileRevision')[3]).toBe(
      CreateContentStudioWritingProfileRevisionDto
    );
    const text = fs.readFileSync(
      path.join(__dirname, 'content-studio.controller.ts'),
      'utf8'
    );
    expect(text).not.toMatch(/CheckPolicies|Sections\.|@Delete\(/);
    const block = text.slice(text.indexOf("@Get('/writing-profiles')"));
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

describe('Writing profile DTO validation', () => {
  it('WD1 accepts a valid create body and keeps the content as sent', async () => {
    const body = await run(CreateContentStudioWritingProfileDto, {
      name: 'Voice',
      content: content(),
    });
    expect(body).toBeInstanceOf(CreateContentStudioWritingProfileDto);
    expect({ ...body }).toEqual({ name: 'Voice', content: content() });
  });

  it.each([
    ['WD2 no name', { content: content() }],
    ['WD3 no content', { name: 'Voice' }],
    ['content as text', { name: 'Voice', content: 'Warm' }],
    ['content as null', { name: 'Voice', content: null }],
    [
      'a name over 100 characters',
      { name: 'n'.repeat(101), content: content() },
    ],
  ])('refuses a create body with %s', async (_name, body) => {
    await rejected(CreateContentStudioWritingProfileDto, body);
  });

  it.each([
    [
      'WD4 organizationId',
      CreateContentStudioWritingProfileDto,
      { organizationId: 'org-b' },
    ],
    [
      'WD5 createdById',
      CreateContentStudioWritingProfileDto,
      { createdById: 'u' },
    ],
    [
      'WD6 revisionNumber',
      CreateContentStudioWritingProfileDto,
      { revisionNumber: 1 },
    ],
    [
      'WD7 contentHash',
      CreateContentStudioWritingProfileDto,
      { contentHash: 'f' },
    ],
    [
      'latestRevisionNumber',
      CreateContentStudioWritingProfileDto,
      { latestRevisionNumber: 1 },
    ],
    ['archivedAt', CreateContentStudioWritingProfileDto, { archivedAt: null }],
    [
      'WD9 content',
      UpdateContentStudioWritingProfileDto,
      { content: content() },
    ],
    [
      'organizationId',
      UpdateContentStudioWritingProfileDto,
      { organizationId: 'org-b' },
    ],
    [
      'revisionNumber',
      CreateContentStudioWritingProfileRevisionDto,
      { revisionNumber: 3 },
    ],
    [
      'contentHash',
      CreateContentStudioWritingProfileRevisionDto,
      { contentHash: 'f' },
    ],
    [
      'createdById',
      CreateContentStudioWritingProfileRevisionDto,
      { createdById: 'u' },
    ],
  ])('refuses a body with %s', async (field, dto, extra) => {
    const base =
      dto === CreateContentStudioWritingProfileDto
        ? { name: 'Voice', content: content() }
        : dto === UpdateContentStudioWritingProfileDto
        ? { name: 'Voice' }
        : { baseRevisionNumber: 1, content: content() };
    const message = await rejected(dto, { ...base, ...extra });
    expect(message).toContain(
      `property ${field.replace(/^WD\d+ /, '')} should not exist`
    );
  });

  it('WD8 takes a rename with the name only', async () => {
    expect({
      ...(await run(UpdateContentStudioWritingProfileDto, { name: 'Renamed' })),
    }).toEqual({ name: 'Renamed' });
    await rejected(UpdateContentStudioWritingProfileDto, {});
  });

  it.each([
    ['WD10 no base revision', { content: content() }],
    ['WD11 no content', { baseRevisionNumber: 1 }],
    ['base 0', { baseRevisionNumber: 0, content: content() }],
    ['a fractional base', { baseRevisionNumber: 1.5, content: content() }],
    ['a base past int4', { baseRevisionNumber: 2 ** 31, content: content() }],
    ['a text base', { baseRevisionNumber: '1', content: content() }],
  ])('refuses a revision body with %s', async (_name, body) => {
    await rejected(CreateContentStudioWritingProfileRevisionDto, body);
  });

  it('WD12 leaves nested Writing DNA to the strict domain parser', async () => {
    // class-validator does not look inside content; the service's parser
    // refuses the unknown field with CS_PROFILE_INVALID
    const body = await run(CreateContentStudioWritingProfileRevisionDto, {
      baseRevisionNumber: 1,
      content: { ...content(), audience: MARKER },
    });
    expect(body.content).toEqual({ ...content(), audience: MARKER });
  });

  it('WD13/WD14 parses the list query exactly', async () => {
    expect({
      ...(await run(ListContentStudioWritingProfilesDto, {}, 'query')),
    }).toEqual({ page: 1, archived: false });
    expect({
      ...(await run(
        ListContentStudioWritingProfilesDto,
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
      await rejected(ListContentStudioWritingProfilesDto, query, 'query');
    }
    expect({
      ...(await run(
        ListContentStudioWritingProfileRevisionsDto,
        { page: '2' },
        'query'
      )),
    }).toEqual({ page: 2 });
    await rejected(
      ListContentStudioWritingProfileRevisionsDto,
      { page: '-1' },
      'query'
    );
  });
});
