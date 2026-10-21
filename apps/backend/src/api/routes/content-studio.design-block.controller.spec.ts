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
  CreateContentStudioDesignBlockDto,
  ListContentStudioDesignBlocksDto,
  UpdateContentStudioDesignBlockDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.design-block.dto';
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

const MARKER = 'DESIGN_BLOCK_PRIVATE_MARKER_789';
const ID = '33333333-3333-4333-8333-333333333333';
const ORG = {
  id: 'org-a',
  users: [{ disabled: false, role: 'USER' }],
} as unknown as Organization;
const USER = { id: 'user-1' } as User;
const CONTENT = {
  schemaVersion: 1,
  width: 100,
  height: 100,
  layers: [
    {
      name: 'Card',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      opacity: 1,
      visible: true,
      type: 'shape',
      shape: 'rectangle',
      fill: { type: 'literal', value: '#ffffff' },
      cornerRadius: 8,
    },
  ],
};

const setup = () => {
  const result = { from: 'service' };
  const blocks = {
    listBlocks: jest.fn().mockResolvedValue(result),
    createBlock: jest.fn().mockResolvedValue(result),
    updateBlock: jest.fn().mockResolvedValue(result),
    archiveBlock: jest.fn().mockResolvedValue(result),
    restoreBlock: jest.fn().mockResolvedValue(result),
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
    {} as ContentStudioDesignTemplateService,
    {} as ContentStudioDesignStylePresetService,
    {} as ContentStudioDesignLayoutPatternService,
    {} as ContentStudioDesignPageSetService,
    blocks as unknown as ContentStudioDesignBlockService,
    {} as ContentStudioReviewService,
    {} as ContentStudioDesignAIService
  );
  return { blocks, controller, result };
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
    pageId: 'p1',
    layerIds: ['l1'],
    guidance: { text: MARKER },
  });

const handler = (name: string) =>
  (ContentStudioController.prototype as unknown as Record<string, object>)[
    name
  ];
const route = (name: string) =>
  `${
    RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler(name))]
  } ${Reflect.getMetadata(PATH_METADATA, handler(name))}`;

// Design blocks (P4-18): the five routes, the request organization and user
// only, the strict DTOs. The service has its own spec
describe('ContentStudioController design block routes', () => {
  it('DBSEC-R1 declares exactly these five routes, 200 for archive and restore, no delete, apply, share or render', () => {
    const names = Object.getOwnPropertyNames(
      ContentStudioController.prototype
    ).filter((name) => /DesignBlock/.test(name));
    expect(names.map(route).sort()).toEqual([
      'GET /design-blocks',
      'PATCH /design-blocks/:id',
      'POST /design-blocks',
      'POST /design-blocks/:id/archive',
      'POST /design-blocks/:id/restore',
    ]);
    for (const name of ['archiveDesignBlock', 'restoreDesignBlock']) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))).toBe(200);
    }
    const all = Object.getOwnPropertyNames(ContentStudioController.prototype)
      .filter((name) => name !== 'constructor')
      .map(route);
    // P6-01: one more, a design from a saved package revision
    expect(all).toHaveLength(141);
    expect(
      all.filter(
        (r) =>
          /block/i.test(r) &&
          /^(DELETE|PUT) |apply|share|public|market|render|preview|generate|media/i.test(
            r
          )
      )
    ).toEqual([]);
  });

  it('DBSEC4 lists and changes blocks for the request organization only, with the declared fields', async () => {
    const { controller, blocks } = setup();
    await controller.listDesignBlocks(
      ORG,
      Object.assign(new ListContentStudioDesignBlocksDto(), {
        page: 2,
        archived: true,
      })
    );
    expect(blocks.listBlocks).toHaveBeenCalledWith({
      organizationId: 'org-a',
      archived: true,
      page: 2,
    });
    await controller.createDesignBlock(
      ORG,
      USER,
      withExtras(
        Object.assign(new CreateContentStudioDesignBlockDto(), {
          name: 'Card',
          description: 'D',
          content: CONTENT,
        })
      )
    );
    expect(blocks.createBlock).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      name: 'Card',
      description: 'D',
      content: CONTENT,
    });
    await controller.updateDesignBlock(
      ORG,
      ID,
      withExtras(
        Object.assign(new UpdateContentStudioDesignBlockDto(), {
          name: 'Renamed',
        })
      )
    );
    expect(blocks.updateBlock).toHaveBeenCalledWith('org-a', ID, {
      name: 'Renamed',
      description: undefined,
      content: undefined,
    });
    await controller.archiveDesignBlock(ORG, ID);
    await controller.restoreDesignBlock(ORG, ID);
    expect(blocks.archiveBlock).toHaveBeenCalledWith('org-a', ID);
    expect(blocks.restoreBlock).toHaveBeenCalledWith('org-a', ID);
  });

  it('DBSEC-R2 declares the DTOs and adds no role, policy, billing, AI, Brand Kit or render gate', () => {
    const types = (method: string) =>
      Reflect.getMetadata(
        'design:paramtypes',
        ContentStudioController.prototype,
        method
      );
    expect(types('listDesignBlocks')[1]).toBe(ListContentStudioDesignBlocksDto);
    expect(types('createDesignBlock')[2]).toBe(
      CreateContentStudioDesignBlockDto
    );
    expect(types('updateDesignBlock')[2]).toBe(
      UpdateContentStudioDesignBlockDto
    );
    const text = fs.readFileSync(
      path.join(__dirname, 'content-studio.controller.ts'),
      'utf8'
    );
    const block = text.slice(
      text.indexOf("@Get('/design-blocks')"),
      text.indexOf('// Renders one page of exactly the revision')
    );
    expect(block).toContain('restoreDesignBlock');
    expect(block).not.toMatch(
      /AIConnection|AIWriting|Role\.|users|Reference|render\(|BrandKit|@Delete|CheckPolicies|StylePreset|LayoutPattern|PageSet/
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

describe('Design block DTO validation', () => {
  it('DBSEC-R3 accepts the declared bodies and queries as sent', async () => {
    expect({
      ...(await run(CreateContentStudioDesignBlockDto, {
        name: 'Card',
        content: CONTENT,
      })),
    }).toEqual({ name: 'Card', content: CONTENT });
    expect({
      ...(await run(UpdateContentStudioDesignBlockDto, {
        description: 'D',
      })),
    }).toEqual({ description: 'D' });
    expect({
      ...(await run(
        ListContentStudioDesignBlocksDto,
        { page: '3', archived: 'true' },
        'query'
      )),
    }).toEqual({ page: 3, archived: true });
  });

  it.each([
    ['no content', CreateContentStudioDesignBlockDto, { name: 'N' }],
    [
      'content as text',
      CreateContentStudioDesignBlockDto,
      { name: 'N', content: MARKER },
    ],
    [
      'content as a list',
      CreateContentStudioDesignBlockDto,
      { name: 'N', content: [] },
    ],
    [
      'a long name',
      CreateContentStudioDesignBlockDto,
      { name: 'n'.repeat(101), content: CONTENT },
    ],
    [
      'a long description',
      CreateContentStudioDesignBlockDto,
      { name: 'N', description: 'd'.repeat(501), content: CONTENT },
    ],
    ...[
      'organizationId',
      'userId',
      'contentHash',
      'designId',
      'pageId',
      'layerIds',
      'document',
      'brandKit',
      'guidance',
      'templateId',
      'layoutPatternId',
      'stylePresetId',
      'pageSetId',
      'designBlockId',
      'fabric',
    ].map(
      (field) =>
        [
          `a ${field}`,
          CreateContentStudioDesignBlockDto,
          { name: 'N', content: CONTENT, [field]: MARKER },
        ] as [
          string,
          typeof CreateContentStudioDesignBlockDto,
          Record<string, unknown>
        ]
    ),
    [
      'an archivedAt in the update',
      UpdateContentStudioDesignBlockDto,
      { archivedAt: null },
    ],
    [
      'a contentHash in the update',
      UpdateContentStudioDesignBlockDto,
      { contentHash: 'f'.repeat(64) },
    ],
  ])(
    'DBSEC4/DBSEC5/DBSEC6 refuses a body with %s',
    async (_name, dto, body) => {
      await rejected(dto, body);
    }
  );

  it.each([
    [{ kind: 'text' }],
    [{ page: '0' }],
    [{ archived: 'maybe' }],
    [{ organizationId: 'org-b' }],
  ])('DBSEC-R4 refuses the query %p', async (query) => {
    await rejected(ListContentStudioDesignBlocksDto, query, 'query');
  });
});
