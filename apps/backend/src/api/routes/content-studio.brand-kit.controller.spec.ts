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
import {
  ListContentStudioBrandKitRevisionsDto,
  SaveContentStudioBrandKitRevisionDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.brand-kit.dto';

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

const MARKER = 'BRAND_KIT_PRIVATE_MARKER_123';
const REVISION = '66666666-6666-4666-8666-666666666666';
// an ordinary member: the Brand Kit needs no manager role
const ORG = {
  id: 'org-a',
  users: [{ disabled: false, role: 'USER' }],
} as unknown as Organization;
const USER = { id: 'user-1' } as User;

const content = () => ({
  schemaVersion: 1,
  identity: { brandName: 'Northwind', tagline: '', description: MARKER },
  colors: [{ id: 'primary', name: 'Blue', value: '#0057ff', role: 'primary' }],
  typography: [],
  visualDirection: { keywords: [], dos: [`Whitespace. ${MARKER}`], donts: [] },
});

const setup = () => {
  const result = { from: 'service' };
  const brandKit = {
    getBrandKit: jest.fn().mockResolvedValue(result),
    createRevision: jest.fn().mockResolvedValue(result),
    listRevisions: jest.fn().mockResolvedValue(result),
    getRevision: jest.fn().mockResolvedValue(result),
  };
  const controller = new ContentStudioController(
    {} as ContentStudioService,
    {} as ContentStudioHandoffService,
    {} as ContentStudioAIConnectionService,
    {} as ContentStudioWritingProfileService,
    {} as ContentStudioEditorialPolicyService,
    {} as ContentStudioAudienceProfileService,
    {} as ContentStudioExpertiseProfileService,
    {} as ContentStudioAIWritingService,
    {} as ContentStudioSourceService,
    {} as ContentStudioSourceIngestionService,
    brandKit as unknown as ContentStudioBrandKitService,
    {} as ContentStudioDesignService,
    {} as ContentStudioRenderFontService,
    {} as ContentStudioDesignRenderService,
    {} as ContentStudioDesignReferenceService,
    {} as ContentStudioDesignTemplateService,
    {} as ContentStudioDesignStylePresetService
  );
  return { brandKit, controller, result };
};

const handler = (name: string) =>
  (ContentStudioController.prototype as unknown as Record<string, object>)[
    name
  ];
const route = (name: string) =>
  `${
    RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler(name))]
  } ${Reflect.getMetadata(PATH_METADATA, handler(name))}`;
const allRoutes = () =>
  Object.getOwnPropertyNames(ContentStudioController.prototype)
    .filter((name) => name !== 'constructor')
    .map(route);

describe('ContentStudioController Brand Kit routes', () => {
  // P4-08 adds the read-only design reference of one revision
  it('BKC1 declares exactly these five routes, none with an id for the kit', () => {
    expect(
      allRoutes()
        .filter((r) => r.includes('/brand-kit'))
        .sort()
    ).toEqual([
      'GET /brand-kit',
      'GET /brand-kit/revisions',
      'GET /brand-kit/revisions/:revisionId',
      'GET /brand-kit/revisions/:revisionId/design-ref',
      'POST /brand-kit/revisions',
    ]);
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handler('createBrandKitRevision'))
    ).toBeUndefined();
  });

  it('BKC10/BKC11 has no patch, delete, archive, restore, asset, Media, font, logo, generate, infer, extract or import route', () => {
    expect(
      allRoutes().filter(
        (r) =>
          /brand/i.test(r) &&
          r !== 'GET /brand-kit/revisions/:revisionId/design-ref' &&
          (/^(PATCH|PUT|DELETE) /.test(r) ||
            /archive|restore|default|asset|media|font|logo|image|upload|generate|infer|extract|import|analy|website|render|design|ai|:id\b/i.test(
              r.replace('/brand-kit', '')
            ))
      )
    ).toEqual([]);
    expect(allRoutes().filter((r) => r.startsWith('DELETE '))).toEqual([]);
    expect(allRoutes()).not.toContain('POST /brand-kit');
  });

  it('BKC2/BKC6 reads the kit of the request organization', async () => {
    const { brandKit, controller, result } = setup();
    await expect(controller.getBrandKit(ORG)).resolves.toBe(result);
    expect(brandKit.getBrandKit).toHaveBeenCalledWith('org-a');
  });

  it('BKC3/BKC7 saves a revision by the request user with the declared fields only', async () => {
    const { brandKit, controller } = setup();
    const body = Object.assign(new SaveContentStudioBrandKitRevisionDto(), {
      baseRevisionNumber: 0,
      content: content(),
      organizationId: 'org-b',
      brandKitId: 'kit-b',
      createdById: 'user-b',
      revisionNumber: 9,
      contentHash: 'f'.repeat(64),
    });
    await controller.createBrandKitRevision(ORG, USER, body);
    expect(brandKit.createRevision).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      baseRevisionNumber: 0,
      content: content(),
    });
  });

  it('BKC4/BKC5 reads the history and a revision of the request organization', async () => {
    const { brandKit, controller } = setup();
    const query = Object.assign(new ListContentStudioBrandKitRevisionsDto(), {
      page: 3,
    });
    await controller.listBrandKitRevisions(ORG, query);
    await controller.getBrandKitRevision(ORG, REVISION);
    expect(brandKit.listRevisions).toHaveBeenCalledWith({
      organizationId: 'org-a',
      page: 3,
    });
    expect(brandKit.getRevision).toHaveBeenCalledWith({
      organizationId: 'org-a',
      revisionId: REVISION,
    });
  });

  it('BKC8/BKC9 declares the DTOs and adds no role, policy, billing or AI gate', () => {
    const types = (method: string) =>
      Reflect.getMetadata(
        'design:paramtypes',
        ContentStudioController.prototype,
        method
      );
    expect(types('createBrandKitRevision')[2]).toBe(
      SaveContentStudioBrandKitRevisionDto
    );
    expect(types('listBrandKitRevisions')[1]).toBe(
      ListContentStudioBrandKitRevisionsDto
    );
    const text = fs.readFileSync(
      path.join(__dirname, 'content-studio.controller.ts'),
      'utf8'
    );
    expect(text).not.toMatch(/CheckPolicies|Sections\.|@Delete\(/);
    const block = text.slice(
      text.indexOf("@Get('/brand-kit')"),
      text.indexOf('// Designs:')
    );
    expect(block).toContain('getBrandKitRevision');
    expect(block).not.toMatch(
      /AIConnection|AIExecution|AIWriting|Role\.|users|brandKitId|Media|@HttpCode|@Delete|@Patch/
    );
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

describe('Brand Kit DTO validation', () => {
  it('BD1/BD2 accepts a save body, base 0 included, and keeps the content as sent', async () => {
    for (const baseRevisionNumber of [0, 1, 2_147_483_647]) {
      const body = await run(SaveContentStudioBrandKitRevisionDto, {
        baseRevisionNumber,
        content: content(),
      });
      expect(body).toBeInstanceOf(SaveContentStudioBrandKitRevisionDto);
      expect({ ...body }).toEqual({ baseRevisionNumber, content: content() });
    }
  });

  it.each([
    ['BD3 a negative base', { baseRevisionNumber: -1, content: content() }],
    ['BD5 a decimal base', { baseRevisionNumber: 1.5, content: content() }],
    [
      'BD4 a base past int4',
      { baseRevisionNumber: 2 ** 31, content: content() },
    ],
    ['a text base', { baseRevisionNumber: '1', content: content() }],
    ['no base', { content: content() }],
    ['BD6 no content', { baseRevisionNumber: 0 }],
    ['content as text', { baseRevisionNumber: 0, content: MARKER }],
    ['content as null', { baseRevisionNumber: 0, content: null }],
  ])('refuses a save body with %s', async (_name, body) => {
    await rejected(SaveContentStudioBrandKitRevisionDto, body);
  });

  it.each([
    ['BD7 organizationId', { organizationId: 'org-b' }],
    ['BD9 brandKitId', { brandKitId: 'kit-b' }],
    ['revisionNumber', { revisionNumber: 3 }],
    ['BD11 contentHash', { contentHash: 'f' }],
    ['createdById', { createdById: 'u' }],
    ['BD12 an unknown field', { logoUrl: 'https://example.com/logo.png' }],
    ['BD10 revisionId', { revisionId: 'rev' }],
    ['BD8 userId', { userId: 'u' }],
    ['a mediaId', { mediaId: 'media-1' }],
    ['schemaVersion', { schemaVersion: 1 }],
  ])('refuses a save body with %s', async (field, extra) => {
    const message = await rejected(SaveContentStudioBrandKitRevisionDto, {
      baseRevisionNumber: 1,
      content: content(),
      ...extra,
    });
    expect(message).toContain(
      `property ${Object.keys(extra)[0]} should not exist`
    );
    expect(field).toBeTruthy();
  });

  it('leaves a nested Brand Kit field to the strict domain parser', async () => {
    // class-validator does not look inside content; the service's parser
    // refuses the unknown field with CS_BRAND_KIT_INVALID
    const body = await run(SaveContentStudioBrandKitRevisionDto, {
      baseRevisionNumber: 1,
      content: { ...content(), logoUrl: MARKER },
    });
    expect(body.content).toEqual({ ...content(), logoUrl: MARKER });
  });

  it('parses the history page exactly', async () => {
    expect({
      ...(await run(ListContentStudioBrandKitRevisionsDto, {}, 'query')),
    }).toEqual({ page: 1 });
    expect({
      ...(await run(
        ListContentStudioBrandKitRevisionsDto,
        { page: '100000' },
        'query'
      )),
    }).toEqual({ page: 100000 });
    for (const query of [
      { page: '0' },
      { page: '-1' },
      { page: '100001' },
      { page: '1.5' },
      { page: 'abc' },
      { page: '' },
      { organizationId: 'org-b' },
    ]) {
      await rejected(ListContentStudioBrandKitRevisionsDto, query, 'query');
    }
  });
});
