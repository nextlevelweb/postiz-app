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
  CreateContentStudioDesignTemplateDto,
  CreateContentStudioDesignTemplateRevisionDto,
  InstantiateContentStudioDesignTemplateDto,
  ListContentStudioDesignTemplateRevisionsDto,
  ListContentStudioDesignTemplatesDto,
  SaveContentStudioDesignAsTemplateDto,
  UpdateContentStudioDesignTemplateDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.design-template.dto';
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

const MARKER = 'DESIGN_TEMPLATE_PRIVATE_MARKER_123';
const ID = '33333333-3333-4333-8333-333333333333';
const REVISION = '66666666-6666-4666-8666-666666666666';
// an ordinary member: templates need no manager role
const ORG = {
  id: 'org-a',
  users: [{ disabled: false, role: 'USER' }],
} as unknown as Organization;
const USER = { id: 'user-1' } as User;

const content = () => ({
  schemaVersion: 1,
  brandKit: null,
  pages: [
    {
      id: 'cover',
      name: MARKER,
      width: 1080,
      height: 1080,
      background: {
        type: 'solid',
        color: { type: 'literal', value: '#ffffff' },
      },
      layers: [],
    },
  ],
});

const GUIDANCE = {
  schemaVersion: 1,
  brandRebinding: false,
  slots: [] as unknown[],
};

const setup = () => {
  const result = { from: 'service' };
  const templates = {
    listTemplates: jest.fn().mockResolvedValue(result),
    createTemplate: jest.fn().mockResolvedValue(result),
    getTemplate: jest.fn().mockResolvedValue(result),
    updateTemplate: jest.fn().mockResolvedValue(result),
    createRevision: jest.fn().mockResolvedValue(result),
    listRevisions: jest.fn().mockResolvedValue(result),
    getRevision: jest.fn().mockResolvedValue(result),
    archiveTemplate: jest.fn().mockResolvedValue(result),
    restoreTemplate: jest.fn().mockResolvedValue(result),
    instantiateTemplate: jest.fn().mockResolvedValue(result),
    saveDesignRevisionAsTemplate: jest.fn().mockResolvedValue(result),
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
    {} as ContentStudioBrandKitService,
    {} as ContentStudioDesignService,
    {} as ContentStudioRenderFontService,
    {} as ContentStudioDesignRenderService,
    {} as ContentStudioDesignReferenceService,
    templates as unknown as ContentStudioDesignTemplateService,
    {} as ContentStudioDesignStylePresetService,
    {} as ContentStudioDesignLayoutPatternService,
    {} as ContentStudioDesignPageSetService,
    {} as ContentStudioDesignBlockService,
    {} as ContentStudioReviewService,
    {} as ContentStudioDesignAIService
  );
  return { templates, controller, result };
};

// A DTO that also carries fields it does not declare, as it would without the
// strict pipe: the controller must still forward only the declared fields
const withExtras = <T extends object>(dto: T) =>
  Object.assign(dto, {
    organizationId: 'org-b',
    createdById: 'user-b',
    userId: 'user-b',
    content: { schemaVersion: 1, stolen: MARKER },
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
const names = () =>
  Object.getOwnPropertyNames(ContentStudioController.prototype).filter((name) =>
    /Template/.test(name)
  );

describe('ContentStudioController design template routes', () => {
  it('TPC1/P411-12 declares exactly these eleven routes, 200 for archive and restore, no delete, share or render', () => {
    expect(names().map(route).sort()).toEqual([
      'GET /design-templates',
      'GET /design-templates/:id',
      'GET /design-templates/:id/revisions',
      'GET /design-templates/:id/revisions/:revisionId',
      'PATCH /design-templates/:id',
      'POST /design-templates',
      'POST /design-templates/:id/archive',
      'POST /design-templates/:id/restore',
      'POST /design-templates/:id/revisions',
      'POST /design-templates/instantiate',
      'POST /designs/:id/revisions/:revisionId/save-as-template',
    ]);
    for (const name of ['archiveDesignTemplate', 'restoreDesignTemplate']) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))).toBe(200);
    }
    const all = Object.getOwnPropertyNames(ContentStudioController.prototype)
      .filter((name) => name !== 'constructor')
      .map(route);
    // P4-13 adds the five style preset routes
    // P6-01: one more, a design from a saved package revision
    // P8-01: one more, the pages a feed source found
    // P8-02: one more, News Radar across feeds
    // P8-04A: one more, what changed in a source version
    // P8-04B1: one more, the organization's page changes
    expect(all).toHaveLength(145);
    expect(
      all.filter(
        (r) =>
          /template/i.test(r) &&
          /^(DELETE|PUT) |share|public|market|render|preview|export|generate|ai\b|media|upload/i.test(
            r
          )
      )
    ).toEqual([]);
  });

  it('TPC2/TSEC lists, reads and changes templates for the request organization only', async () => {
    const { controller, templates, result } = setup();
    const list = Object.assign(new ListContentStudioDesignTemplatesDto(), {
      page: 2,
      archived: true,
    });
    expect(await controller.listDesignTemplates(ORG, list)).toBe(result);
    expect(templates.listTemplates).toHaveBeenCalledWith({
      organizationId: 'org-a',
      archived: true,
      page: 2,
    });
    await controller.getDesignTemplate(ORG, ID);
    expect(templates.getTemplate).toHaveBeenCalledWith('org-a', ID);
    await controller.updateDesignTemplate(
      ORG,
      ID,
      withExtras(
        Object.assign(new UpdateContentStudioDesignTemplateDto(), {
          name: 'New',
          description: 'D',
        })
      )
    );
    expect(templates.updateTemplate).toHaveBeenCalledWith('org-a', ID, {
      name: 'New',
      description: 'D',
    });
    await controller.archiveDesignTemplate(ORG, ID);
    await controller.restoreDesignTemplate(ORG, ID);
    expect(templates.archiveTemplate).toHaveBeenCalledWith('org-a', ID);
    expect(templates.restoreTemplate).toHaveBeenCalledWith('org-a', ID);
    await controller.listDesignTemplateRevisions(
      ORG,
      ID,
      Object.assign(new ListContentStudioDesignTemplateRevisionsDto(), {
        page: 3,
      })
    );
    expect(templates.listRevisions).toHaveBeenCalledWith({
      organizationId: 'org-a',
      templateId: ID,
      page: 3,
    });
    await controller.getDesignTemplateRevision(ORG, ID, REVISION);
    expect(templates.getRevision).toHaveBeenCalledWith({
      organizationId: 'org-a',
      templateId: ID,
      revisionId: REVISION,
    });
  });

  it('TPC3 creates and revises by the request organization and user, with the declared fields only', async () => {
    const { controller, templates } = setup();
    const doc = content();
    await controller.createDesignTemplate(
      ORG,
      USER,
      withExtras(
        Object.assign(new CreateContentStudioDesignTemplateDto(), {
          name: 'T',
          description: 'D',
          content: doc,
        })
      )
    );
    // withExtras replaced content: the controller forwards the DTO's field
    expect(templates.createTemplate).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      name: 'T',
      description: 'D',
      content: { schemaVersion: 1, stolen: MARKER },
    });
    await controller.createDesignTemplateRevision(
      ORG,
      USER,
      ID,
      Object.assign(new CreateContentStudioDesignTemplateRevisionDto(), {
        baseRevisionNumber: 4,
        content: doc,
        guidance: GUIDANCE,
      })
    );
    // P4-12: the document and its guidance go together
    expect(templates.createRevision).toHaveBeenCalledWith({
      organizationId: 'org-a',
      templateId: ID,
      userId: 'user-1',
      baseRevisionNumber: 4,
      content: doc,
      guidance: GUIDANCE,
    });
  });

  it('TPC4/UT2/ST3 using a template and saving a design revision send identities only, never a document', async () => {
    const { controller, templates } = setup();
    await controller.instantiateDesignTemplate(
      ORG,
      USER,
      withExtras(
        Object.assign(new InstantiateContentStudioDesignTemplateDto(), {
          source: 'organization',
          templateId: ID,
          revisionId: REVISION,
          name: 'New design',
          values: { title: 'Hello' },
          brandKitRevisionId: REVISION,
        })
      )
    );
    // P4-12: field values and an exact Brand Kit revision id, never a document
    expect(templates.instantiateTemplate).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      source: 'organization',
      templateId: ID,
      revisionId: REVISION,
      revisionNumber: undefined,
      name: 'New design',
      values: { title: 'Hello' },
      brandKitRevisionId: REVISION,
    });
    await controller.saveDesignRevisionAsTemplate(
      ORG,
      USER,
      ID,
      REVISION,
      withExtras(
        Object.assign(new SaveContentStudioDesignAsTemplateDto(), {
          name: 'Saved',
        })
      )
    );
    expect(templates.saveDesignRevisionAsTemplate).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      designId: ID,
      revisionId: REVISION,
      name: 'Saved',
      description: undefined,
    });
  });

  it('TPC5 declares the DTOs and adds no role, policy, billing, AI, Media or render gate', () => {
    const types = (method: string) =>
      Reflect.getMetadata(
        'design:paramtypes',
        ContentStudioController.prototype,
        method
      );
    expect(types('createDesignTemplate')[2]).toBe(
      CreateContentStudioDesignTemplateDto
    );
    expect(types('updateDesignTemplate')[2]).toBe(
      UpdateContentStudioDesignTemplateDto
    );
    expect(types('createDesignTemplateRevision')[3]).toBe(
      CreateContentStudioDesignTemplateRevisionDto
    );
    expect(types('instantiateDesignTemplate')[2]).toBe(
      InstantiateContentStudioDesignTemplateDto
    );
    expect(types('saveDesignRevisionAsTemplate')[4]).toBe(
      SaveContentStudioDesignAsTemplateDto
    );
    const text = fs.readFileSync(
      path.join(__dirname, 'content-studio.controller.ts'),
      'utf8'
    );
    const block = text.slice(
      text.indexOf("@Get('/design-templates')"),
      text.indexOf('// Renders one page of exactly the revision')
    );
    expect(block).toContain('restoreDesignTemplate');
    expect(block).not.toMatch(
      /AIConnection|AIExecution|AIWriting|Role\.|users|Media|render|@Delete|CheckPolicies/
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
  expect(
    JSON.stringify((error as BadRequestException).getResponse())
  ).not.toContain(MARKER);
};

describe('Design template DTO validation', () => {
  it('accepts the declared bodies as sent', async () => {
    expect({
      ...(await run(CreateContentStudioDesignTemplateDto, {
        name: 'T',
        content: content(),
      })),
    }).toEqual({ name: 'T', content: content() });
    expect({
      ...(await run(InstantiateContentStudioDesignTemplateDto, {
        source: 'system',
        templateId: 'system:story',
        revisionNumber: 1,
        name: 'N',
      })),
    }).toEqual({
      source: 'system',
      templateId: 'system:story',
      revisionNumber: 1,
      name: 'N',
    });
    // P4-12: the guidance goes with the document, null for none
    for (const guidance of [null, GUIDANCE]) {
      expect({
        ...(await run(CreateContentStudioDesignTemplateRevisionDto, {
          baseRevisionNumber: 2,
          content: content(),
          guidance,
        })),
      }).toEqual({ baseRevisionNumber: 2, content: content(), guidance });
    }
    expect({
      ...(await run(InstantiateContentStudioDesignTemplateDto, {
        source: 'organization',
        templateId: ID,
        revisionId: REVISION,
        name: 'N',
        values: { title: 'T', photo: { mediaId: 'm', sha256: 'a'.repeat(64) } },
        brandKitRevisionId: REVISION,
      })),
    }).toEqual({
      source: 'organization',
      templateId: ID,
      revisionId: REVISION,
      name: 'N',
      values: { title: 'T', photo: { mediaId: 'm', sha256: 'a'.repeat(64) } },
      brandKitRevisionId: REVISION,
    });
    expect({
      ...(await run(SaveContentStudioDesignAsTemplateDto, {
        name: 'S',
        description: 'D',
      })),
    }).toEqual({
      name: 'S',
      description: 'D',
    });
    expect({
      ...(await run(
        ListContentStudioDesignTemplatesDto,
        { page: '2', archived: 'true' },
        'query'
      )),
    }).toEqual({
      page: 2,
      archived: true,
    });
  });

  it.each([
    ['no content', CreateContentStudioDesignTemplateDto, { name: 'T' }],
    [
      'content as text',
      CreateContentStudioDesignTemplateDto,
      { name: 'T', content: MARKER },
    ],
    [
      'an organizationId',
      CreateContentStudioDesignTemplateDto,
      { name: 'T', content: content(), organizationId: 'org-b' },
    ],
    [
      'a source',
      CreateContentStudioDesignTemplateDto,
      { name: 'T', content: content(), source: 'system' },
    ],
    [
      'a long description',
      CreateContentStudioDesignTemplateDto,
      { name: 'T', content: content(), description: 'd'.repeat(1001) },
    ],
    [
      'a content in the update',
      UpdateContentStudioDesignTemplateDto,
      { name: 'T', content: content() },
    ],
    [
      'an archivedAt',
      UpdateContentStudioDesignTemplateDto,
      { archivedAt: null },
    ],
    [
      'a revision without base',
      CreateContentStudioDesignTemplateRevisionDto,
      { content: content() },
    ],
    [
      'a revisionNumber in a revision',
      CreateContentStudioDesignTemplateRevisionDto,
      { baseRevisionNumber: 1, content: content(), revisionNumber: 2 },
    ],
    [
      'an unknown source',
      InstantiateContentStudioDesignTemplateDto,
      { source: 'public', templateId: 'x', name: 'N' },
    ],
    [
      'a document to instantiate',
      InstantiateContentStudioDesignTemplateDto,
      {
        source: 'system',
        templateId: 'system:story',
        name: 'N',
        content: content(),
      },
    ],
    [
      'an organizationId to instantiate',
      InstantiateContentStudioDesignTemplateDto,
      {
        source: 'organization',
        templateId: 'x',
        name: 'N',
        organizationId: 'org-b',
      },
    ],
    [
      'P4-12 a revision without its guidance key',
      CreateContentStudioDesignTemplateRevisionDto,
      { baseRevisionNumber: 1, content: content() },
    ],
    [
      'P4-12 guidance as text',
      CreateContentStudioDesignTemplateRevisionDto,
      { baseRevisionNumber: 1, content: content(), guidance: MARKER },
    ],
    [
      'P4-12 guidance as a list',
      CreateContentStudioDesignTemplateRevisionDto,
      { baseRevisionNumber: 1, content: content(), guidance: [] },
    ],
    [
      'P4-12 values as text',
      InstantiateContentStudioDesignTemplateDto,
      {
        source: 'system',
        templateId: 'system:story',
        name: 'N',
        values: MARKER,
      },
    ],
    [
      'P4-12 values as a list',
      InstantiateContentStudioDesignTemplateDto,
      { source: 'system', templateId: 'system:story', name: 'N', values: [] },
    ],
    [
      'P4-12 a Brand Kit revision id as a number',
      InstantiateContentStudioDesignTemplateDto,
      {
        source: 'system',
        templateId: 'system:story',
        name: 'N',
        brandKitRevisionId: 7,
      },
    ],
    [
      'ST3/M21 a document to save as template',
      SaveContentStudioDesignAsTemplateDto,
      { name: 'S', content: content() },
    ],
    [
      'a revision id in the save body',
      SaveContentStudioDesignAsTemplateDto,
      { name: 'S', revisionId: REVISION },
    ],
  ])('refuses a body with %s', async (_name, dto, body) => {
    await rejected(dto, body);
  });

  // P4-12: a guided use carries field values and a Brand Kit revision id,
  // never a document, Brand Kit content, a URL, render or editor state
  it.each([
    'guidance',
    'document',
    'brandKit',
    'brandKitContent',
    'mediaUrl',
    'renderOptions',
    'fabric',
    'userId',
  ])('refuses a guided use carrying %s', async (field) => {
    await rejected(InstantiateContentStudioDesignTemplateDto, {
      source: 'system',
      templateId: 'system:story',
      name: 'N',
      values: {},
      [field]: { stolen: MARKER },
    });
  });
});
