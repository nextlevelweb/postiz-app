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
  CreateContentStudioDesignStylePresetDto,
  ListContentStudioDesignStylePresetsDto,
  UpdateContentStudioDesignStylePresetDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.design-style-preset.dto';
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

const MARKER = 'STYLE_PRESET_PRIVATE_MARKER_456';
const ID = '33333333-3333-4333-8333-333333333333';
const ORG = {
  id: 'org-a',
  users: [{ disabled: false, role: 'USER' }],
} as unknown as Organization;
const USER = { id: 'user-1' } as User;
const CONTENT = {
  schemaVersion: 1,
  kind: 'shape',
  style: {
    fill: { type: 'literal', value: '#ffffff' },
    cornerRadius: 8,
    opacity: 1,
  },
};

const setup = () => {
  const result = { from: 'service' };
  const presets = {
    listPresets: jest.fn().mockResolvedValue(result),
    createPreset: jest.fn().mockResolvedValue(result),
    updatePreset: jest.fn().mockResolvedValue(result),
    archivePreset: jest.fn().mockResolvedValue(result),
    restorePreset: jest.fn().mockResolvedValue(result),
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
    presets as unknown as ContentStudioDesignStylePresetService,
    {} as ContentStudioDesignLayoutPatternService,
    {} as ContentStudioDesignPageSetService,
    {} as ContentStudioDesignBlockService,
    {} as ContentStudioReviewService,
    {} as ContentStudioDesignAIService,
    {} as ContentStudioAISetupService
  );
  return { presets, controller, result };
};

// A DTO that also carries fields it does not declare, as it would without the
// strict pipe: the controller must still forward only the declared fields
const withExtras = <T extends object>(dto: T) =>
  Object.assign(dto, {
    organizationId: 'org-b',
    createdById: 'user-b',
    userId: 'user-b',
    kind: 'text',
    contentHash: 'f'.repeat(64),
    layer: { id: 'l1', x: 0, text: MARKER },
  });

const handler = (name: string) =>
  (ContentStudioController.prototype as unknown as Record<string, object>)[
    name
  ];
const route = (name: string) =>
  `${
    RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler(name))]
  } ${Reflect.getMetadata(PATH_METADATA, handler(name))}`;

describe('ContentStudioController design style preset routes', () => {
  it('declares exactly these five routes, 200 for archive and restore, no delete, apply, share or render', () => {
    const names = Object.getOwnPropertyNames(
      ContentStudioController.prototype
    ).filter((name) => /StylePreset/.test(name));
    expect(names.map(route).sort()).toEqual([
      'GET /design-style-presets',
      'PATCH /design-style-presets/:id',
      'POST /design-style-presets',
      'POST /design-style-presets/:id/archive',
      'POST /design-style-presets/:id/restore',
    ]);
    for (const name of [
      'archiveDesignStylePreset',
      'restoreDesignStylePreset',
    ]) {
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
    // P8-C3: two more, pause and resume a feed
    // P8-C4: one more, a feed's interval
    expect(all).toHaveLength(150);
    expect(
      all.filter(
        (r) =>
          /preset/i.test(r) &&
          /^(DELETE|PUT) |apply|share|public|market|render|preview|generate|media/i.test(
            r
          )
      )
    ).toEqual([]);
  });

  it('PSEC5 lists and changes presets for the request organization only, with the declared fields', async () => {
    const { controller, presets } = setup();
    await controller.listDesignStylePresets(
      ORG,
      Object.assign(new ListContentStudioDesignStylePresetsDto(), {
        kind: 'text',
        page: 2,
        archived: true,
      })
    );
    expect(presets.listPresets).toHaveBeenCalledWith({
      organizationId: 'org-a',
      kind: 'text',
      archived: true,
      page: 2,
    });
    await controller.createDesignStylePreset(
      ORG,
      USER,
      withExtras(
        Object.assign(new CreateContentStudioDesignStylePresetDto(), {
          name: 'Card',
          description: 'D',
          content: CONTENT,
        })
      )
    );
    expect(presets.createPreset).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      name: 'Card',
      description: 'D',
      content: CONTENT,
    });
    await controller.updateDesignStylePreset(
      ORG,
      ID,
      withExtras(
        Object.assign(new UpdateContentStudioDesignStylePresetDto(), {
          name: 'Renamed',
        })
      )
    );
    expect(presets.updatePreset).toHaveBeenCalledWith('org-a', ID, {
      name: 'Renamed',
      description: undefined,
      content: undefined,
    });
    await controller.archiveDesignStylePreset(ORG, ID);
    await controller.restoreDesignStylePreset(ORG, ID);
    expect(presets.archivePreset).toHaveBeenCalledWith('org-a', ID);
    expect(presets.restorePreset).toHaveBeenCalledWith('org-a', ID);
  });

  it('declares the DTOs and adds no role, policy, billing, AI, Media, Brand Kit or render gate', () => {
    const types = (method: string) =>
      Reflect.getMetadata(
        'design:paramtypes',
        ContentStudioController.prototype,
        method
      );
    expect(types('listDesignStylePresets')[1]).toBe(
      ListContentStudioDesignStylePresetsDto
    );
    expect(types('createDesignStylePreset')[2]).toBe(
      CreateContentStudioDesignStylePresetDto
    );
    expect(types('updateDesignStylePreset')[2]).toBe(
      UpdateContentStudioDesignStylePresetDto
    );
    const text = fs.readFileSync(
      path.join(__dirname, 'content-studio.controller.ts'),
      'utf8'
    );
    const block = text.slice(
      text.indexOf("@Get('/design-style-presets')"),
      text.indexOf('// Renders one page of exactly the revision')
    );
    expect(block).toContain('restoreDesignStylePreset');
    expect(block).not.toMatch(
      /AIConnection|AIWriting|Role\.|users|Media|render|BrandKit|@Delete|CheckPolicies/
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

describe('Design style preset DTO validation', () => {
  it('accepts the declared bodies and queries as sent', async () => {
    expect({
      ...(await run(CreateContentStudioDesignStylePresetDto, {
        name: 'Card',
        content: CONTENT,
      })),
    }).toEqual({ name: 'Card', content: CONTENT });
    expect({
      ...(await run(UpdateContentStudioDesignStylePresetDto, {
        description: 'D',
      })),
    }).toEqual({ description: 'D' });
    expect({
      ...(await run(
        ListContentStudioDesignStylePresetsDto,
        { kind: 'shape', page: '3', archived: 'true' },
        'query'
      )),
    }).toEqual({ kind: 'shape', page: 3, archived: true });
  });

  it.each([
    ['no content', CreateContentStudioDesignStylePresetDto, { name: 'N' }],
    [
      'content as text',
      CreateContentStudioDesignStylePresetDto,
      { name: 'N', content: MARKER },
    ],
    [
      'content as a list',
      CreateContentStudioDesignStylePresetDto,
      { name: 'N', content: [] },
    ],
    [
      'a long name',
      CreateContentStudioDesignStylePresetDto,
      { name: 'n'.repeat(101), content: CONTENT },
    ],
    [
      'a long description',
      CreateContentStudioDesignStylePresetDto,
      { name: 'N', description: 'd'.repeat(501), content: CONTENT },
    ],
    ...[
      'organizationId',
      'userId',
      'kind',
      'contentHash',
      'layer',
      'document',
      'designId',
      'x',
      'text',
      'imageRef',
      'css',
      'fabric',
    ].map(
      (field) =>
        [
          `a ${field}`,
          CreateContentStudioDesignStylePresetDto,
          { name: 'N', content: CONTENT, [field]: MARKER },
        ] as [
          string,
          typeof CreateContentStudioDesignStylePresetDto,
          Record<string, unknown>
        ]
    ),
    [
      'an archivedAt in the update',
      UpdateContentStudioDesignStylePresetDto,
      { archivedAt: null },
    ],
    [
      'a kind in the update',
      UpdateContentStudioDesignStylePresetDto,
      { kind: 'text' },
    ],
  ])('refuses a body with %s', async (_name, dto, body) => {
    await rejected(dto, body);
  });

  it.each([
    [{ kind: 'image' }],
    [{ page: '0' }],
    [{ archived: 'maybe' }],
    [{ organizationId: 'org-b' }],
  ])('refuses the query %p', async (query) => {
    await rejected(ListContentStudioDesignStylePresetsDto, query, 'query');
  });
});
