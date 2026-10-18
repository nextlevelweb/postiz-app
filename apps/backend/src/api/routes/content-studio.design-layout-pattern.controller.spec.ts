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
import {
  CreateContentStudioDesignLayoutPatternDto,
  ListContentStudioDesignLayoutPatternsDto,
  UpdateContentStudioDesignLayoutPatternDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.design-layout-pattern.dto';

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

const MARKER = 'LAYOUT_PATTERN_PRIVATE_MARKER_789';
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
  const patterns = {
    listPatterns: jest.fn().mockResolvedValue(result),
    createPattern: jest.fn().mockResolvedValue(result),
    updatePattern: jest.fn().mockResolvedValue(result),
    archivePattern: jest.fn().mockResolvedValue(result),
    restorePattern: jest.fn().mockResolvedValue(result),
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
    patterns as unknown as ContentStudioDesignLayoutPatternService
  );
  return { patterns, controller, result };
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

// Design layout patterns (P4-15): the five routes, the request organization
// and user only, the strict DTOs. The service has its own spec
describe('ContentStudioController design layout pattern routes', () => {
  it('LSEC1 declares exactly these five routes, 200 for archive and restore, no delete, apply, share or render', () => {
    const names = Object.getOwnPropertyNames(
      ContentStudioController.prototype
    ).filter((name) => /LayoutPattern/.test(name));
    expect(names.map(route).sort()).toEqual([
      'GET /design-layout-patterns',
      'PATCH /design-layout-patterns/:id',
      'POST /design-layout-patterns',
      'POST /design-layout-patterns/:id/archive',
      'POST /design-layout-patterns/:id/restore',
    ]);
    for (const name of [
      'archiveDesignLayoutPattern',
      'restoreDesignLayoutPattern',
    ]) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))).toBe(200);
    }
    const all = Object.getOwnPropertyNames(ContentStudioController.prototype)
      .filter((name) => name !== 'constructor')
      .map(route);
    expect(all).toHaveLength(112);
    expect(
      all.filter(
        (r) =>
          /pattern|layout/i.test(r) &&
          /^(DELETE|PUT) |apply|share|public|market|render|preview|generate|media/i.test(
            r
          )
      )
    ).toEqual([]);
  });

  it('LSEC2 lists and changes patterns for the request organization only, with the declared fields', async () => {
    const { controller, patterns } = setup();
    await controller.listDesignLayoutPatterns(
      ORG,
      Object.assign(new ListContentStudioDesignLayoutPatternsDto(), {
        page: 2,
        archived: true,
      })
    );
    expect(patterns.listPatterns).toHaveBeenCalledWith({
      organizationId: 'org-a',
      archived: true,
      page: 2,
    });
    await controller.createDesignLayoutPattern(
      ORG,
      USER,
      withExtras(
        Object.assign(new CreateContentStudioDesignLayoutPatternDto(), {
          name: 'Card',
          description: 'D',
          content: CONTENT,
        })
      )
    );
    expect(patterns.createPattern).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      name: 'Card',
      description: 'D',
      content: CONTENT,
    });
    await controller.updateDesignLayoutPattern(
      ORG,
      ID,
      withExtras(
        Object.assign(new UpdateContentStudioDesignLayoutPatternDto(), {
          name: 'Renamed',
        })
      )
    );
    expect(patterns.updatePattern).toHaveBeenCalledWith('org-a', ID, {
      name: 'Renamed',
      description: undefined,
      content: undefined,
    });
    await controller.archiveDesignLayoutPattern(ORG, ID);
    await controller.restoreDesignLayoutPattern(ORG, ID);
    expect(patterns.archivePattern).toHaveBeenCalledWith('org-a', ID);
    expect(patterns.restorePattern).toHaveBeenCalledWith('org-a', ID);
  });

  it('LSEC3 declares the DTOs and adds no role, policy, billing, AI, Brand Kit or render gate', () => {
    const types = (method: string) =>
      Reflect.getMetadata(
        'design:paramtypes',
        ContentStudioController.prototype,
        method
      );
    expect(types('listDesignLayoutPatterns')[1]).toBe(
      ListContentStudioDesignLayoutPatternsDto
    );
    expect(types('createDesignLayoutPattern')[2]).toBe(
      CreateContentStudioDesignLayoutPatternDto
    );
    expect(types('updateDesignLayoutPattern')[2]).toBe(
      UpdateContentStudioDesignLayoutPatternDto
    );
    const text = fs.readFileSync(
      path.join(__dirname, 'content-studio.controller.ts'),
      'utf8'
    );
    const block = text.slice(
      text.indexOf("@Get('/design-layout-patterns')"),
      text.indexOf('// Renders one page of exactly the revision')
    );
    expect(block).toContain('restoreDesignLayoutPattern');
    expect(block).not.toMatch(
      /AIConnection|AIWriting|Role\.|users|Reference|render\(|BrandKit|@Delete|CheckPolicies|StylePreset/
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

describe('Design layout pattern DTO validation', () => {
  it('LSEC4 accepts the declared bodies and queries as sent', async () => {
    expect({
      ...(await run(CreateContentStudioDesignLayoutPatternDto, {
        name: 'Card',
        content: CONTENT,
      })),
    }).toEqual({ name: 'Card', content: CONTENT });
    expect({
      ...(await run(UpdateContentStudioDesignLayoutPatternDto, {
        description: 'D',
      })),
    }).toEqual({ description: 'D' });
    expect({
      ...(await run(
        ListContentStudioDesignLayoutPatternsDto,
        { page: '3', archived: 'true' },
        'query'
      )),
    }).toEqual({ page: 3, archived: true });
  });

  it.each([
    ['no content', CreateContentStudioDesignLayoutPatternDto, { name: 'N' }],
    [
      'content as text',
      CreateContentStudioDesignLayoutPatternDto,
      { name: 'N', content: MARKER },
    ],
    [
      'content as a list',
      CreateContentStudioDesignLayoutPatternDto,
      { name: 'N', content: [] },
    ],
    [
      'a long name',
      CreateContentStudioDesignLayoutPatternDto,
      { name: 'n'.repeat(101), content: CONTENT },
    ],
    [
      'a long description',
      CreateContentStudioDesignLayoutPatternDto,
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
      'patternId',
      'groups',
      'constraints',
      'fabric',
    ].map(
      (field) =>
        [
          `a ${field}`,
          CreateContentStudioDesignLayoutPatternDto,
          { name: 'N', content: CONTENT, [field]: MARKER },
        ] as [
          string,
          typeof CreateContentStudioDesignLayoutPatternDto,
          Record<string, unknown>
        ]
    ),
    [
      'an archivedAt in the update',
      UpdateContentStudioDesignLayoutPatternDto,
      { archivedAt: null },
    ],
    [
      'a contentHash in the update',
      UpdateContentStudioDesignLayoutPatternDto,
      { contentHash: 'f'.repeat(64) },
    ],
  ])('LSEC5 refuses a body with %s', async (_name, dto, body) => {
    await rejected(dto, body);
  });

  it.each([
    [{ kind: 'text' }],
    [{ page: '0' }],
    [{ archived: 'maybe' }],
    [{ organizationId: 'org-b' }],
  ])('LSEC6 refuses the query %p', async (query) => {
    await rejected(ListContentStudioDesignLayoutPatternsDto, query, 'query');
  });
});
