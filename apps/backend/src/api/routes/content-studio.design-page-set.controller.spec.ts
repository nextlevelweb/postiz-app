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
  CreateContentStudioDesignPageSetDto,
  ListContentStudioDesignPageSetsDto,
  UpdateContentStudioDesignPageSetDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.design-page-set.dto';
import { CreateContentStudioDesignDto } from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.design.dto';
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

const MARKER = 'PAGE_SET_PRIVATE_MARKER_789';
const ID = '33333333-3333-4333-8333-333333333333';
const ORG = {
  id: 'org-a',
  users: [{ disabled: false, role: 'USER' }],
} as unknown as Organization;
const USER = { id: 'user-1' } as User;
const CONTENT = {
  schemaVersion: 1,
  pages: [
    { name: 'Square', width: 1080, height: 1080 },
    { name: 'Story', width: 1080, height: 1920 },
  ],
};

const setup = () => {
  const result = { from: 'service' };
  const pageSets = {
    listPageSets: jest.fn().mockResolvedValue(result),
    createPageSet: jest.fn().mockResolvedValue(result),
    updatePageSet: jest.fn().mockResolvedValue(result),
    archivePageSet: jest.fn().mockResolvedValue(result),
    restorePageSet: jest.fn().mockResolvedValue(result),
    createDesignFromPageSet: jest.fn().mockResolvedValue(result),
  };
  const designs = { createDesign: jest.fn().mockResolvedValue(result) };
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
    pageSets as unknown as ContentStudioDesignPageSetService,
    {} as ContentStudioDesignBlockService,
    {} as ContentStudioReviewService,
    {} as ContentStudioDesignAIService
  );
  return { pageSets, designs, controller, result };
};

// A DTO that also carries fields it does not declare, as it would without the
// strict pipe: the controller must still forward only the declared fields
const withExtras = <T extends object>(dto: T) =>
  Object.assign(dto, {
    organizationId: 'org-b',
    createdById: 'user-b',
    userId: 'user-b',
    contentHash: 'f'.repeat(64),
    designId: 'design-b',
    pageIds: ['p1'],
    layers: [{ id: 'l1', text: MARKER }],
  });

const handler = (name: string) =>
  (ContentStudioController.prototype as unknown as Record<string, object>)[
    name
  ];
const route = (name: string) =>
  `${
    RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler(name))]
  } ${Reflect.getMetadata(PATH_METADATA, handler(name))}`;

// Design page sets (P4-17): the five routes, the request organization and
// user only, the strict DTOs, and a new design from a page set through the
// existing create route. The service has its own spec
describe('ContentStudioController design page set routes', () => {
  it('PSSEC-R1 declares exactly these five routes, 200 for archive and restore, no delete, apply, share or render', () => {
    const names = Object.getOwnPropertyNames(
      ContentStudioController.prototype
    ).filter((name) => /PageSet/.test(name));
    expect(names.map(route).sort()).toEqual([
      'GET /design-page-sets',
      'PATCH /design-page-sets/:id',
      'POST /design-page-sets',
      'POST /design-page-sets/:id/archive',
      'POST /design-page-sets/:id/restore',
    ]);
    for (const name of ['archiveDesignPageSet', 'restoreDesignPageSet']) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))).toBe(200);
    }
    const all = Object.getOwnPropertyNames(ContentStudioController.prototype)
      .filter((name) => name !== 'constructor')
      .map(route);
    // P6-01: one more, a design from a saved package revision
    // P8-01: one more, the pages a feed source found
    // P8-02: one more, News Radar across feeds
    // P8-04A: one more, what changed in a source version
    // P8-04B1: one more, the organization's page changes
    expect(all).toHaveLength(145);
    expect(
      all.filter(
        (r) =>
          /page-set|pageset|campaign/i.test(r) &&
          /^(DELETE|PUT) |apply|share|public|market|render|preview|generate|media/i.test(
            r
          )
      )
    ).toEqual([]);
  });

  it('PSSEC5 lists and changes page sets for the request organization only, with the declared fields', async () => {
    const { controller, pageSets } = setup();
    await controller.listDesignPageSets(
      ORG,
      Object.assign(new ListContentStudioDesignPageSetsDto(), {
        page: 2,
        archived: true,
      })
    );
    expect(pageSets.listPageSets).toHaveBeenCalledWith({
      organizationId: 'org-a',
      archived: true,
      page: 2,
    });
    await controller.createDesignPageSet(
      ORG,
      USER,
      withExtras(
        Object.assign(new CreateContentStudioDesignPageSetDto(), {
          name: 'Core',
          description: 'D',
          content: CONTENT,
        })
      )
    );
    expect(pageSets.createPageSet).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      name: 'Core',
      description: 'D',
      content: CONTENT,
    });
    await controller.updateDesignPageSet(
      ORG,
      ID,
      withExtras(
        Object.assign(new UpdateContentStudioDesignPageSetDto(), {
          name: 'Renamed',
        })
      )
    );
    expect(pageSets.updatePageSet).toHaveBeenCalledWith('org-a', ID, {
      name: 'Renamed',
      description: undefined,
      content: undefined,
    });
    await controller.archiveDesignPageSet(ORG, ID);
    await controller.restoreDesignPageSet(ORG, ID);
    expect(pageSets.archivePageSet).toHaveBeenCalledWith('org-a', ID);
    expect(pageSets.restorePageSet).toHaveBeenCalledWith('org-a', ID);
  });

  it('PF6/PC6 a new design names a page set by id; the page set service makes its pages, never the body', async () => {
    const { controller, pageSets, designs } = setup();
    await controller.createDesign(
      ORG,
      USER,
      withExtras(
        Object.assign(new CreateContentStudioDesignDto(), {
          name: 'Launch',
          pageSetId: 'system:page-set-social-core',
        })
      )
    );
    expect(pageSets.createDesignFromPageSet).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      name: 'Launch',
      pageSetId: 'system:page-set-social-core',
      content: undefined,
    });
    expect(designs.createDesign).not.toHaveBeenCalled();
    // without a page set, the design service creates it as before
    const document: Record<string, unknown> = {
      schemaVersion: 1,
      brandKit: null,
      pages: [],
    };
    await controller.createDesign(
      ORG,
      USER,
      Object.assign(new CreateContentStudioDesignDto(), {
        name: 'Plain',
        content: document,
      })
    );
    expect(designs.createDesign).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      name: 'Plain',
      content: document,
    });
    expect(pageSets.createDesignFromPageSet).toHaveBeenCalledTimes(1);
  });

  it('PSSEC-R2 declares the DTOs and adds no role, policy, billing, AI, Media, Brand Kit or render gate', () => {
    const types = (method: string) =>
      Reflect.getMetadata(
        'design:paramtypes',
        ContentStudioController.prototype,
        method
      );
    expect(types('listDesignPageSets')[1]).toBe(
      ListContentStudioDesignPageSetsDto
    );
    expect(types('createDesignPageSet')[2]).toBe(
      CreateContentStudioDesignPageSetDto
    );
    expect(types('updateDesignPageSet')[2]).toBe(
      UpdateContentStudioDesignPageSetDto
    );
    const text = fs.readFileSync(
      path.join(__dirname, 'content-studio.controller.ts'),
      'utf8'
    );
    const block = text.slice(
      text.indexOf("@Get('/design-page-sets')"),
      text.indexOf('// Renders one page of exactly the revision')
    );
    expect(block).toContain('restoreDesignPageSet');
    expect(block).not.toMatch(
      /AIConnection|AIWriting|Role\.|users|Reference|Media|render\(|BrandKit|@Delete|CheckPolicies|LayoutPattern/
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

describe('Design page set DTO validation', () => {
  it('PSSEC-R3 accepts the declared bodies and queries as sent', async () => {
    expect({
      ...(await run(CreateContentStudioDesignPageSetDto, {
        name: 'Card',
        content: CONTENT,
      })),
    }).toEqual({ name: 'Card', content: CONTENT });
    expect({
      ...(await run(UpdateContentStudioDesignPageSetDto, {
        description: 'D',
      })),
    }).toEqual({ description: 'D' });
    expect({
      ...(await run(
        ListContentStudioDesignPageSetsDto,
        { page: '3', archived: 'true' },
        'query'
      )),
    }).toEqual({ page: 3, archived: true });
  });

  it.each([
    ['no content', CreateContentStudioDesignPageSetDto, { name: 'N' }],
    [
      'content as text',
      CreateContentStudioDesignPageSetDto,
      { name: 'N', content: MARKER },
    ],
    [
      'content as a list',
      CreateContentStudioDesignPageSetDto,
      { name: 'N', content: [] },
    ],
    [
      'a long name',
      CreateContentStudioDesignPageSetDto,
      { name: 'n'.repeat(101), content: CONTENT },
    ],
    [
      'a long description',
      CreateContentStudioDesignPageSetDto,
      { name: 'N', description: 'd'.repeat(501), content: CONTENT },
    ],
    ...[
      'organizationId',
      'userId',
      'contentHash',
      'designId',
      'pageIds',
      'layers',
      'document',
      'brandKit',
      'guidance',
      'templateId',
      'campaignId',
      'platform',
      'fabric',
    ].map(
      (field) =>
        [
          `a ${field}`,
          CreateContentStudioDesignPageSetDto,
          { name: 'N', content: CONTENT, [field]: MARKER },
        ] as [
          string,
          typeof CreateContentStudioDesignPageSetDto,
          Record<string, unknown>
        ]
    ),
    [
      'an archivedAt in the update',
      UpdateContentStudioDesignPageSetDto,
      { archivedAt: null },
    ],
    [
      'a contentHash in the update',
      UpdateContentStudioDesignPageSetDto,
      { contentHash: 'f'.repeat(64) },
    ],
  ])('PSSEC5 refuses a body with %s', async (_name, dto, body) => {
    await rejected(dto, body);
  });

  it.each([
    [{ kind: 'text' }],
    [{ page: '0' }],
    [{ archived: 'maybe' }],
    [{ organizationId: 'org-b' }],
  ])('PSSEC-R4 refuses the query %p', async (query) => {
    await rejected(ListContentStudioDesignPageSetsDto, query, 'query');
  });
});
