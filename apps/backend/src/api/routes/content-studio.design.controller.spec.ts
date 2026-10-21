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
  CreateContentStudioDesignDto,
  CreateContentStudioDesignFromPackageDto,
  CreateContentStudioDesignRevisionDto,
  ListContentStudioDesignRevisionsDto,
  ListContentStudioDesignsDto,
  UpdateContentStudioDesignDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.design.dto';
import { ContentStudioDesignAIService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-ai.service';
import { ContentStudioDesignAIProposalDto } from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.design-ai.dto';

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

const MARKER = 'DESIGN_DOCUMENT_PRIVATE_MARKER_123';
const ID = '33333333-3333-4333-8333-333333333333';
const REVISION = '66666666-6666-4666-8666-666666666666';
// an ordinary member: designs need no manager role
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

const setup = () => {
  const result = { from: 'service' };
  const designs = {
    listDesigns: jest.fn().mockResolvedValue(result),
    createDesign: jest.fn().mockResolvedValue(result),
    getDesign: jest.fn().mockResolvedValue(result),
    renameDesign: jest.fn().mockResolvedValue(result),
    createRevision: jest.fn().mockResolvedValue(result),
    listRevisions: jest.fn().mockResolvedValue(result),
    getRevision: jest.fn().mockResolvedValue(result),
    archiveDesign: jest.fn().mockResolvedValue(result),
    restoreDesign: jest.fn().mockResolvedValue(result),
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
    designs as unknown as ContentStudioDesignService,
    {} as ContentStudioRenderFontService,
    {} as ContentStudioDesignRenderService,
    {} as ContentStudioDesignReferenceService,
    {} as ContentStudioDesignTemplateService,
    {} as ContentStudioDesignStylePresetService,
    {} as ContentStudioDesignLayoutPatternService,
    {} as ContentStudioDesignPageSetService,
    {} as ContentStudioDesignBlockService,
    {} as ContentStudioReviewService,
    {} as ContentStudioDesignAIService
  );
  return { designs, controller, result };
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

describe('ContentStudioController design routes', () => {
  // P4-05 adds the one render route; the other nine are the P4-02 routes
  // P4-06 adds render-all: eleven routes
  it('DPC1 declares exactly these thirteen routes, with 200 for archive, restore, render and render-all', () => {
    const names = Object.getOwnPropertyNames(ContentStudioController.prototype)
      .filter((name) => /Designs?\b|Design[A-Z]/.test(name))
      // P4-08: the Brand Kit and Media design references live elsewhere;
      // P4-11: so do the design template routes (template controller spec),
      // P4-13: and the style preset routes (style preset controller spec),
      // P4-15: and the layout pattern routes (layout pattern controller spec),
      // P4-17: and the page set routes (page set controller spec),
      // P4-18: and the design block routes (design block controller spec)
      .filter((name) => !/DesignReference$/.test(name))
      .filter((name) => !/Template/.test(name))
      .filter((name) => !/StylePreset/.test(name))
      .filter((name) => !/LayoutPattern/.test(name))
      .filter((name) => !/PageSet/.test(name))
      .filter((name) => !/DesignBlock/.test(name));
    expect(names.map(route).sort()).toEqual([
      'GET /designs',
      'GET /designs/:id',
      'GET /designs/:id/revisions',
      'GET /designs/:id/revisions/:revisionId',
      'PATCH /designs/:id',
      'POST /designs',
      'POST /designs/:id/archive',
      'POST /designs/:id/render',
      'POST /designs/:id/render-all',
      'POST /designs/:id/restore',
      'POST /designs/:id/revisions',
      // P6-02: a Design Creative AI suggestion for one saved revision
      'POST /designs/:id/revisions/:revisionId/ai/propose',
      // P6-01: a design from a saved package revision, under that revision
      'POST /packages/:id/revisions/:revisionId/designs',
    ]);
    for (const name of [
      'archiveDesign',
      'restoreDesign',
      'renderDesign',
      'renderAllDesignPages',
    ]) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))).toBe(200);
    }
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handler('createDesign'))
    ).toBeUndefined();
  });

  // The render route (P4-05) and the render-all route (P4-06) are the only
  // exceptions, with the Design Creative AI suggestion (P6-02)
  it('DPC11/DPC12 has no delete, preview, export, duplicate, template, generate, AI or Media route for designs, and the two render routes', () => {
    const routes = Object.getOwnPropertyNames(ContentStudioController.prototype)
      .filter((name) => name !== 'constructor')
      .map(route);
    expect(routes.filter((r) => /design.*render/i.test(r)).sort()).toEqual([
      'POST /designs/:id/render',
      'POST /designs/:id/render-all',
    ]);
    expect(
      routes.filter(
        (r) =>
          r !== 'POST /designs/:id/render' &&
          r !== 'POST /designs/:id/render-all' &&
          // P4-08: the read-only Media and Brand Kit design references
          !r.endsWith('/design-ref') &&
          // P4-11: the design template routes, pinned by the template
          // controller spec (none renders, previews, exports or generates)
          !r.startsWith('GET /design-templates') &&
          !/^(POST|PATCH) \/design-templates/.test(r) &&
          r !== 'POST /designs/:id/revisions/:revisionId/save-as-template' &&
          // P4-15: the layout pattern routes, pinned by the layout pattern
          // controller spec (none touches a design, renders or applies)
          !/^(GET|POST|PATCH) \/design-layout-patterns/.test(r) &&
          // P4-18: the design block routes, pinned by their controller spec
          !/^(GET|POST|PATCH) \/design-blocks/.test(r) &&
          // P6-02: the one AI route, a suggestion for one saved revision
          // that changes nothing of the design (pinned by the Phase 6
          // security spec)
          r !== 'POST /designs/:id/revisions/:revisionId/ai/propose' &&
          /design/i.test(r) &&
          (/^(DELETE|PUT) /.test(r) ||
            /render|preview|export|duplicate|copy|clone|template|generate|ai\b|media|upload|image|font|layout|thumbnail/i.test(
              r.replace('/designs', '')
            ))
      )
    ).toEqual([]);
    expect(routes.filter((r) => r.startsWith('DELETE '))).toEqual([]);
  });

  it('DPC2/DPC15 lists for the request organization', async () => {
    const { designs, controller, result } = setup();
    const query = Object.assign(new ListContentStudioDesignsDto(), {
      page: 2,
      archived: true,
    });
    await expect(controller.listDesigns(ORG, query)).resolves.toBe(result);
    expect(designs.listDesigns).toHaveBeenCalledWith({
      organizationId: 'org-a',
      archived: true,
      page: 2,
    });
  });

  it('DPC3/DPC15 creates for the request organization and user with the declared fields only', async () => {
    const { designs, controller } = setup();
    const body = withExtras(new CreateContentStudioDesignDto());
    body.name = 'Voice';
    body.content = content();
    await controller.createDesign(ORG, USER, body);
    expect(designs.createDesign).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      name: 'Voice',
      content: content(),
    });
  });

  it('DPC4/DPC5 reads and renames with the request organization', async () => {
    const { designs, controller } = setup();
    await controller.getDesign(ORG, ID);
    const body = withExtras(new UpdateContentStudioDesignDto());
    body.name = 'Renamed';
    await controller.updateDesign(ORG, ID, body);
    expect(designs.getDesign).toHaveBeenCalledWith('org-a', ID);
    expect(designs.renameDesign).toHaveBeenCalledWith('org-a', ID, 'Renamed');
  });

  it('DPC6 saves a revision by the request user with the declared fields only', async () => {
    const { designs, controller } = setup();
    const body = withExtras(new CreateContentStudioDesignRevisionDto());
    body.baseRevisionNumber = 2;
    body.content = content();
    await controller.createDesignRevision(ORG, USER, ID, body);
    expect(designs.createRevision).toHaveBeenCalledWith({
      organizationId: 'org-a',
      designId: ID,
      userId: 'user-1',
      baseRevisionNumber: 2,
      content: content(),
    });
  });

  it('DPC7/DPC8 reads the history and a revision of the request organization', async () => {
    const { designs, controller } = setup();
    const query = Object.assign(new ListContentStudioDesignRevisionsDto(), {
      page: 3,
    });
    await controller.listDesignRevisions(ORG, ID, query);
    await controller.getDesignRevision(ORG, ID, REVISION);
    expect(designs.listRevisions).toHaveBeenCalledWith({
      organizationId: 'org-a',
      designId: ID,
      page: 3,
    });
    expect(designs.getRevision).toHaveBeenCalledWith({
      organizationId: 'org-a',
      designId: ID,
      revisionId: REVISION,
    });
  });

  it('DPC9/DPC10/DPC13 archives and restores for any member of the request organization', async () => {
    const { designs, controller } = setup();
    await controller.archiveDesign(ORG, ID);
    await controller.restoreDesign(ORG, ID);
    expect(designs.archiveDesign).toHaveBeenCalledWith('org-a', ID);
    expect(designs.restoreDesign).toHaveBeenCalledWith('org-a', ID);
  });

  it('DPC13/DPC14 declares the DTOs and adds no role, policy, billing, AI or Media gate', () => {
    const types = (method: string) =>
      Reflect.getMetadata(
        'design:paramtypes',
        ContentStudioController.prototype,
        method
      );
    expect(types('createDesign')[2]).toBe(CreateContentStudioDesignDto);
    expect(types('updateDesign')[2]).toBe(UpdateContentStudioDesignDto);
    expect(types('createDesignRevision')[3]).toBe(
      CreateContentStudioDesignRevisionDto
    );
    const text = fs.readFileSync(
      path.join(__dirname, 'content-studio.controller.ts'),
      'utf8'
    );
    expect(text).not.toMatch(/CheckPolicies|Sections\.|@Delete\(/);
    // the P4-02 routes, up to the P4-05 render route
    const block = text.slice(
      text.indexOf("@Get('/designs')"),
      text.indexOf('// Renders one page of exactly the revision')
    );
    expect(block).toContain('restoreDesign');
    expect(block).not.toMatch(
      /AIConnection|AIExecution|AIWriting|Role\.|users|Media|@Delete/
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

describe('Design DTO validation', () => {
  it('accepts a valid create body and keeps the content as sent', async () => {
    const body = await run(CreateContentStudioDesignDto, {
      name: 'Voice',
      content: content(),
    });
    expect(body).toBeInstanceOf(CreateContentStudioDesignDto);
    expect({ ...body }).toEqual({ name: 'Voice', content: content() });
  });

  it.each([
    ['WD2 no name', { content: content() }],
    ['WD3 no content', { name: 'Voice' }],
    ['content as text', { name: 'Voice', content: 'Warm' }],
    ['content as null', { name: 'Voice', content: null }],
    [
      'a name over 200 characters',
      { name: 'n'.repeat(201), content: content() },
    ],
  ])('refuses a create body with %s', async (_name, body) => {
    await rejected(CreateContentStudioDesignDto, body);
  });

  it.each([
    [
      'WD4 organizationId',
      CreateContentStudioDesignDto,
      { organizationId: 'org-b' },
    ],
    ['WD5 createdById', CreateContentStudioDesignDto, { createdById: 'u' }],
    ['WD6 revisionNumber', CreateContentStudioDesignDto, { revisionNumber: 1 }],
    ['WD7 contentHash', CreateContentStudioDesignDto, { contentHash: 'f' }],
    [
      'latestRevisionNumber',
      CreateContentStudioDesignDto,
      { latestRevisionNumber: 1 },
    ],
    ['archivedAt', CreateContentStudioDesignDto, { archivedAt: null }],
    ['userId', CreateContentStudioDesignDto, { userId: 'u' }],
    ['revisionId', CreateContentStudioDesignDto, { revisionId: 'r' }],
    [
      'renderSettings',
      CreateContentStudioDesignDto,
      { renderSettings: { scale: 2 } },
    ],
    [
      'upload',
      CreateContentStudioDesignDto,
      { upload: 'data:image/png;base64,AAAA' },
    ],
    ['mediaId', CreateContentStudioDesignRevisionDto, { mediaId: 'm' }],
    ['revisionId', CreateContentStudioDesignRevisionDto, { revisionId: 'r' }],
    ['brandKitId', CreateContentStudioDesignRevisionDto, { brandKitId: 'k' }],
    ['WD9 content', UpdateContentStudioDesignDto, { content: content() }],
    [
      'organizationId',
      UpdateContentStudioDesignDto,
      { organizationId: 'org-b' },
    ],
    [
      'revisionNumber',
      CreateContentStudioDesignRevisionDto,
      { revisionNumber: 3 },
    ],
    ['contentHash', CreateContentStudioDesignRevisionDto, { contentHash: 'f' }],
    ['createdById', CreateContentStudioDesignRevisionDto, { createdById: 'u' }],
  ])('refuses a body with %s', async (field, dto, extra) => {
    const base =
      dto === CreateContentStudioDesignDto
        ? { name: 'Voice', content: content() }
        : dto === UpdateContentStudioDesignDto
        ? { name: 'Voice' }
        : { baseRevisionNumber: 1, content: content() };
    const message = await rejected(dto, { ...base, ...extra });
    expect(message).toContain(
      `property ${field.replace(/^WD\d+ /, '')} should not exist`
    );
  });

  it('takes a rename with the name only', async () => {
    expect({
      ...(await run(UpdateContentStudioDesignDto, { name: 'Renamed' })),
    }).toEqual({ name: 'Renamed' });
    await rejected(UpdateContentStudioDesignDto, {});
  });

  it.each([
    ['WD10 no base revision', { content: content() }],
    ['WD11 no content', { baseRevisionNumber: 1 }],
    ['base 0', { baseRevisionNumber: 0, content: content() }],
    ['a fractional base', { baseRevisionNumber: 1.5, content: content() }],
    ['a base past int4', { baseRevisionNumber: 2 ** 31, content: content() }],
    ['a text base', { baseRevisionNumber: '1', content: content() }],
  ])('refuses a revision body with %s', async (_name, body) => {
    await rejected(CreateContentStudioDesignRevisionDto, body);
  });

  it('leaves the nested document to the strict domain parser', async () => {
    // class-validator does not look inside content; the service's parser
    // refuses the unknown field with CS_DESIGN_INVALID
    const body = await run(CreateContentStudioDesignRevisionDto, {
      baseRevisionNumber: 1,
      content: { ...content(), fabric: MARKER },
    });
    expect(body.content).toEqual({ ...content(), fabric: MARKER });
  });

  it('parses the list queries exactly', async () => {
    expect({
      ...(await run(ListContentStudioDesignsDto, {}, 'query')),
    }).toEqual({ page: 1, archived: false });
    expect({
      ...(await run(
        ListContentStudioDesignsDto,
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
      await rejected(ListContentStudioDesignsDto, query, 'query');
    }
    expect({
      ...(await run(
        ListContentStudioDesignRevisionsDto,
        { page: '2' },
        'query'
      )),
    }).toEqual({ page: 2 });
    await rejected(
      ListContentStudioDesignRevisionsDto,
      { page: '-1' },
      'query'
    );
  });
});

// P6-01: a new design from a saved package revision. The path names the
// package and the revision; the body only ids, a name and the starting
// point. The package service reads the text and the hash itself
describe('ContentStudioController design from a package revision (P6-01)', () => {
  const PACKAGE = '44444444-4444-4444-8444-444444444444';
  const setupPackages = () => {
    const result = { from: 'package service' };
    const packages = {
      createDesignFromRevision: jest.fn().mockResolvedValue(result),
    };
    const controller = new ContentStudioController(
      packages as unknown as ContentStudioService,
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
      {} as ContentStudioDesignTemplateService,
      {} as ContentStudioDesignStylePresetService,
      {} as ContentStudioDesignLayoutPatternService,
      {} as ContentStudioDesignPageSetService,
      {} as ContentStudioDesignBlockService,
      {} as ContentStudioReviewService,
      {} as ContentStudioDesignAIService
    );
    return { packages, controller, result };
  };

  it('API2/API4 is one POST under the exact revision, answered by the package service as it is', async () => {
    expect(route('createDesignFromPackageRevision')).toBe(
      'POST /packages/:id/revisions/:revisionId/designs'
    );
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        handler('createDesignFromPackageRevision')
      )
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        'design:paramtypes',
        ContentStudioController.prototype,
        'createDesignFromPackageRevision'
      )[4]
    ).toBe(CreateContentStudioDesignFromPackageDto);
    const { packages, controller, result } = setupPackages();
    const body = Object.assign(new CreateContentStudioDesignFromPackageDto(), {
      name: 'Spring',
      itemId: 'main',
      templateSource: 'system',
      templateId: 'system:square-post',
      templateRevisionNumber: 2,
      textSlotId: 'body',
      values: { headline: 'H' },
      mediaId: 'm1',
      imageSlotId: 'photo',
    });
    await expect(
      controller.createDesignFromPackageRevision(
        ORG,
        USER,
        PACKAGE,
        REVISION,
        body
      )
    ).resolves.toBe(result);
    expect(packages.createDesignFromRevision).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      packageId: PACKAGE,
      revisionId: REVISION,
      name: 'Spring',
      itemId: 'main',
      canvas: undefined,
      pageSetId: undefined,
      templateSource: 'system',
      templateId: 'system:square-post',
      templateRevisionId: undefined,
      templateRevisionNumber: 2,
      values: { headline: 'H' },
      textSlotId: 'body',
      mediaId: 'm1',
      imageSlotId: 'photo',
    });
  });

  it('SEC4/SEC5/SEC6 forwards the declared fields only, with the organization and user of the request', async () => {
    const { packages, controller } = setupPackages();
    const body = Object.assign(
      withExtras(new CreateContentStudioDesignFromPackageDto()),
      {
        name: 'Spring',
        itemId: 'main',
        canvas: 'square',
        text: 'forged copy',
        content: content(),
        sourcePackageRevisionId: 'other',
        sourcePackageContentHash: 'f'.repeat(64),
        packageId: 'other',
      }
    );
    await controller.createDesignFromPackageRevision(
      ORG,
      USER,
      PACKAGE,
      REVISION,
      body
    );
    const [[input]] = packages.createDesignFromRevision.mock.calls;
    expect(input).toMatchObject({
      organizationId: 'org-a',
      userId: 'user-1',
      packageId: PACKAGE,
      revisionId: REVISION,
    });
    expect(JSON.stringify(input)).not.toMatch(
      /forged copy|org-b|user-b|"other"|ffffffff|DESIGN_DOCUMENT_PRIVATE/
    );
  });

  it('API1 the manual design create route is unchanged: it never takes a package source', () => {
    const text = fs.readFileSync(
      path.join(__dirname, 'content-studio.controller.ts'),
      'utf8'
    );
    const manual = text.slice(
      text.indexOf("@Post('/designs')"),
      text.indexOf("@Get('/designs/:id')")
    );
    expect(manual).not.toMatch(/source|package|Package/);
  });
});

describe('Design from a package revision DTO validation (P6-01)', () => {
  const base = { name: 'Spring', itemId: 'main', canvas: 'square' };

  it('accepts ids, a name and one starting point, as sent', async () => {
    expect({
      ...(await run(CreateContentStudioDesignFromPackageDto, base)),
    }).toEqual(base);
    const template = {
      name: 'Spring',
      itemId: 'main',
      templateSource: 'organization',
      templateId: ID,
      templateRevisionId: REVISION,
      textSlotId: 'title',
      values: { other: 'x' },
      mediaId: 'm1',
      imageSlotId: 'photo',
    };
    expect({
      ...(await run(CreateContentStudioDesignFromPackageDto, template)),
    }).toEqual(template);
  });

  it.each([
    [
      'SEC4 a source hash',
      { sourcePackageContentHash: 'f'.repeat(64) },
      'sourcePackageContentHash',
    ],
    ['SEC4 a content hash', { contentHash: 'f'.repeat(64) }, 'contentHash'],
    ['SEC5 package text', { text: 'forged' }, 'text'],
    ['SEC5 a copy', { copy: { global: {} } }, 'copy'],
    ['SEC5 a document', { content: content() }, 'content'],
    ['SEC6 an organization', { organizationId: 'org-b' }, 'organizationId'],
    ['a creator', { createdById: 'u' }, 'createdById'],
    [
      'a source revision',
      { sourcePackageRevisionId: REVISION },
      'sourcePackageRevisionId',
    ],
    ['a package', { packageId: ID }, 'packageId'],
    ['a review', { reviewId: ID }, 'reviewId'],
    ['an approval', { approved: true }, 'approved'],
    ['a Brand Kit revision', { brandKitRevisionId: ID }, 'brandKitRevisionId'],
    ['an image reference', { sha256: 'a'.repeat(64) }, 'sha256'],
  ])('API5 refuses %s', async (_name, extra, field) => {
    const message = await rejected(CreateContentStudioDesignFromPackageDto, {
      ...base,
      ...extra,
    });
    expect(message).toContain(`property ${field} should not exist`);
  });

  it.each([
    ['API3 no item', { name: 'Spring', canvas: 'square' }],
    ['no name', { itemId: 'main', canvas: 'square' }],
    ['an item id over 32 characters', { ...base, itemId: 'i'.repeat(33) }],
    ['a size that is not offered', { ...base, canvas: 'huge' }],
    ['an unknown template source', { ...base, templateSource: 'public' }],
    [
      'a fractional template revision',
      { ...base, templateRevisionNumber: 1.5 },
    ],
    ['values that are not an object', { ...base, values: 'x' }],
    ['a media id over 64 characters', { ...base, mediaId: 'm'.repeat(65) }],
  ])('refuses a body with %s', async (_name, body) => {
    await rejected(CreateContentStudioDesignFromPackageDto, body);
  });
});

// P6-02: a Design Creative AI suggestion. The path names the design and the
// exact revision; the body the intent, the connection, an instruction and,
// for copy, the profiles. The design AI service reads everything else
describe('ContentStudioController Design Creative AI suggestion (P6-02)', () => {
  const CONNECTION = '55555555-5555-4555-8555-555555555555';
  const setupAI = () => {
    const result = { from: 'design ai service' };
    const designAI = { proposeDesign: jest.fn().mockResolvedValue(result) };
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
      {} as ContentStudioDesignTemplateService,
      {} as ContentStudioDesignStylePresetService,
      {} as ContentStudioDesignLayoutPatternService,
      {} as ContentStudioDesignPageSetService,
      {} as ContentStudioDesignBlockService,
      {} as ContentStudioReviewService,
      designAI as unknown as ContentStudioDesignAIService
    );
    return { designAI, controller, result };
  };

  it('API1 is one POST under the exact revision, 200, answered by the design AI service as it is', async () => {
    expect(route('proposeDesignAI')).toBe(
      'POST /designs/:id/revisions/:revisionId/ai/propose'
    );
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handler('proposeDesignAI'))
    ).toBe(200);
    expect(
      Reflect.getMetadata(
        'design:paramtypes',
        ContentStudioController.prototype,
        'proposeDesignAI'
      )[4]
    ).toBe(ContentStudioDesignAIProposalDto);
    const { designAI, controller, result } = setupAI();
    const body = Object.assign(new ContentStudioDesignAIProposalDto(), {
      intent: 'improve_copy',
      connectionId: CONNECTION,
      writingProfileId: ID,
      editorialPolicy: true,
      instruction: 'Warmer',
    });
    await expect(
      controller.proposeDesignAI(ORG, USER, ID, REVISION, body)
    ).resolves.toBe(result);
    expect(designAI.proposeDesign).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      designId: ID,
      revisionId: REVISION,
      intent: 'improve_copy',
      selection: {
        connectionId: CONNECTION,
        writingProfileId: ID,
        editorialPolicy: true,
        audienceProfileId: undefined,
        expertiseProfileId: undefined,
        instruction: 'Warmer',
      },
    });
  });

  it('SEC2-SEC5 forwards the declared fields only, with the organization and user of the request', async () => {
    const { designAI, controller } = setupAI();
    const body = Object.assign(
      withExtras(new ContentStudioDesignAIProposalDto()),
      {
        intent: 'restyle',
        connectionId: CONNECTION,
        model: 'gpt-evil',
        provider: 'anthropic',
        apiKey: 'sk-evil',
        content: content(),
        baseContentHash: 'f'.repeat(64),
      }
    );
    await controller.proposeDesignAI(ORG, USER, ID, REVISION, body);
    const forwarded = JSON.stringify(designAI.proposeDesign.mock.calls);
    for (const field of [
      'org-b',
      'user-b',
      'gpt-evil',
      'anthropic',
      'sk-evil',
      MARKER,
      'f'.repeat(64),
    ]) {
      expect(forwarded).not.toContain(field);
    }
  });
});

describe('Design Creative AI DTO validation (P6-02)', () => {
  const base = {
    intent: 'improve_copy',
    connectionId: '55555555-5555-4555-8555-555555555555',
  };

  it('accepts an intent, a connection, an instruction and profiles, as sent', async () => {
    const full = {
      ...base,
      writingProfileId: ID,
      editorialPolicy: false,
      audienceProfileId: ID,
      expertiseProfileId: ID,
      instruction: 'Make it feel more premium',
    };
    expect({ ...(await run(ContentStudioDesignAIProposalDto, full)) }).toEqual(
      full
    );
  });

  it.each([
    ['SEC2 an organization', { organizationId: 'org-b' }, 'organizationId'],
    [
      'SEC3 a base hash',
      { baseContentHash: 'f'.repeat(64) },
      'baseContentHash',
    ],
    ['SEC3 a content hash', { contentHash: 'f'.repeat(64) }, 'contentHash'],
    ['SEC4 a document', { content: content() }, 'content'],
    ['SEC4 a document by another name', { document: content() }, 'document'],
    ['SEC5 a model', { model: 'gpt-6.1-sol' }, 'model'],
    ['SEC5 a provider', { provider: 'openai' }, 'provider'],
    ['SEC5 an API key', { apiKey: 'sk-x' }, 'apiKey'],
    ['a revision', { revisionId: REVISION }, 'revisionId'],
    ['operations', { operations: [] }, 'operations'],
    ['a proposal', { proposal: {} }, 'proposal'],
    ['a Media id', { mediaId: 'm1' }, 'mediaId'],
    ['a URL', { url: 'https://evil.test' }, 'url'],
    ['sources', { sourceIds: [ID] }, 'sourceIds'],
    ['an approval', { approved: true }, 'approved'],
  ])('refuses %s', async (_name, extra, field) => {
    const message = await rejected(ContentStudioDesignAIProposalDto, {
      ...base,
      ...extra,
    });
    expect(message).toContain(`property ${field} should not exist`);
  });

  it.each([
    ['INT4 an unknown intent', { ...base, intent: 'delete_layers' }],
    ['an upper-case intent', { ...base, intent: 'IMPROVE_COPY' }],
    ['no intent', { connectionId: base.connectionId }],
    ['no connection', { intent: 'restyle' }],
    ['a connection that is no uuid', { ...base, connectionId: 'default' }],
    [
      'an instruction over 2000 characters',
      { ...base, instruction: 'x'.repeat(2001) },
    ],
    ['a profile that is no uuid', { ...base, writingProfileId: 'latest' }],
    ['a policy that is no boolean', { ...base, editorialPolicy: 'yes' }],
  ])('refuses a body with %s', async (_name, body) => {
    await rejected(ContentStudioDesignAIProposalDto, body);
  });
});
