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
  CreateContentStudioEditorialPolicyRevisionDto,
  ListContentStudioEditorialPolicyRevisionsDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.editorial-policy.dto';

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

const MARKER = 'EDITORIAL_POLICY_SECRET_MARKER_123';
const REVISION = '66666666-6666-4666-8666-666666666666';
// an ordinary member: the editorial policy needs no manager role
const ORG = {
  id: 'org-a',
  users: [{ disabled: false, role: 'USER' }],
} as unknown as Organization;
const USER = { id: 'user-1' } as User;

const content = () => ({
  schemaVersion: 1,
  principles: ['Be useful.'],
  prohibitedTopics: [],
  claimRules: [`Cite sources. ${MARKER}`],
  ctaRules: [],
  formatConventions: [],
  complianceNotes: MARKER,
});

const setup = () => {
  const result = { from: 'service' };
  const policy = {
    getPolicy: jest.fn().mockResolvedValue(result),
    createRevision: jest.fn().mockResolvedValue(result),
    listRevisions: jest.fn().mockResolvedValue(result),
    getRevision: jest.fn().mockResolvedValue(result),
  };
  const controller = new ContentStudioController(
    {} as ContentStudioService,
    {} as ContentStudioHandoffService,
    {} as ContentStudioAIConnectionService,
    {} as ContentStudioWritingProfileService,
    policy as unknown as ContentStudioEditorialPolicyService,
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
    {} as ContentStudioDesignLayoutPatternService
  );
  return { policy, controller, result };
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

describe('ContentStudioController editorial policy routes', () => {
  it('EC1-EC4 declares exactly these routes, none with an id for the policy', () => {
    expect(
      allRoutes()
        .filter((r) => r.includes('/editorial-policy'))
        .sort()
    ).toEqual([
      'GET /editorial-policy',
      'GET /editorial-policy/revisions',
      'GET /editorial-policy/revisions/:revisionId',
      'POST /editorial-policy/revisions',
    ]);
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        handler('createEditorialPolicyRevision')
      )
    ).toBeUndefined();
  });

  it('has no patch, delete, archive, restore, generate, check, compliance or AI route for the policy', () => {
    expect(
      allRoutes().filter(
        (r) =>
          /editorial|polic|complian/i.test(r) &&
          (/^(PATCH|PUT|DELETE) /.test(r) ||
            /archive|restore|generate|check|complian|validate|analy|score|ai|:id\b/i.test(
              r.replace('/editorial-policy', '')
            ))
      )
    ).toEqual([]);
    expect(allRoutes().filter((r) => /complian|check|score/i.test(r))).toEqual(
      []
    );
  });

  it('EC1 reads the policy of the request organization', async () => {
    const { policy, controller, result } = setup();
    await expect(controller.getEditorialPolicy(ORG)).resolves.toBe(result);
    expect(policy.getPolicy).toHaveBeenCalledWith('org-a');
  });

  it('EC2 saves a revision by the request user with the declared fields only', async () => {
    const { policy, controller } = setup();
    const body = Object.assign(
      new CreateContentStudioEditorialPolicyRevisionDto(),
      {
        baseRevisionNumber: 0,
        content: content(),
        organizationId: 'org-b',
        policyId: 'policy-b',
        createdById: 'user-b',
        revisionNumber: 9,
        contentHash: 'f'.repeat(64),
      }
    );
    await controller.createEditorialPolicyRevision(ORG, USER, body);
    expect(policy.createRevision).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      baseRevisionNumber: 0,
      content: content(),
    });
  });

  it('EC3/EC4 reads the history and a revision of the request organization', async () => {
    const { policy, controller } = setup();
    const query = Object.assign(
      new ListContentStudioEditorialPolicyRevisionsDto(),
      { page: 3 }
    );
    await controller.listEditorialPolicyRevisions(ORG, query);
    await controller.getEditorialPolicyRevision(ORG, REVISION);
    expect(policy.listRevisions).toHaveBeenCalledWith({
      organizationId: 'org-a',
      page: 3,
    });
    expect(policy.getRevision).toHaveBeenCalledWith({
      organizationId: 'org-a',
      revisionId: REVISION,
    });
  });

  it('declares the DTOs and adds no role, billing or AI gate', () => {
    const types = (method: string) =>
      Reflect.getMetadata(
        'design:paramtypes',
        ContentStudioController.prototype,
        method
      );
    expect(types('createEditorialPolicyRevision')[2]).toBe(
      CreateContentStudioEditorialPolicyRevisionDto
    );
    expect(types('listEditorialPolicyRevisions')[1]).toBe(
      ListContentStudioEditorialPolicyRevisionsDto
    );
    const text = fs.readFileSync(
      path.join(__dirname, 'content-studio.controller.ts'),
      'utf8'
    );
    expect(text).not.toMatch(/CheckPolicies|Sections\.|@Delete\(/);
    const block = text.slice(text.indexOf("@Get('/editorial-policy')"));
    expect(block).not.toMatch(/AIConnection|AIExecution|Role\.|policyId/);
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

describe('Editorial policy DTO validation', () => {
  it('ED1/ED2 accepts a save body, base 0 included, and keeps the content as sent', async () => {
    for (const baseRevisionNumber of [0, 1, 2_147_483_647]) {
      const body = await run(CreateContentStudioEditorialPolicyRevisionDto, {
        baseRevisionNumber,
        content: content(),
      });
      expect(body).toBeInstanceOf(
        CreateContentStudioEditorialPolicyRevisionDto
      );
      expect({ ...body }).toEqual({ baseRevisionNumber, content: content() });
    }
  });

  it.each([
    ['ED3 a negative base', { baseRevisionNumber: -1, content: content() }],
    ['ED4 a decimal base', { baseRevisionNumber: 1.5, content: content() }],
    [
      'ED5 a base past int4',
      { baseRevisionNumber: 2 ** 31, content: content() },
    ],
    ['a text base', { baseRevisionNumber: '1', content: content() }],
    ['ED6 no base', { content: content() }],
    ['ED7 no content', { baseRevisionNumber: 0 }],
    ['content as text', { baseRevisionNumber: 0, content: MARKER }],
    ['content as null', { baseRevisionNumber: 0, content: null }],
  ])('refuses a save body with %s', async (_name, body) => {
    await rejected(CreateContentStudioEditorialPolicyRevisionDto, body);
  });

  it.each([
    ['ED8 organizationId', { organizationId: 'org-b' }],
    ['ED9 policyId', { policyId: 'policy-b' }],
    ['ED10 revisionNumber', { revisionNumber: 3 }],
    ['ED11 contentHash', { contentHash: 'f' }],
    ['ED12 createdById', { createdById: 'u' }],
    ['ED13 an unknown field', { complianceScore: 1 }],
    ['schemaVersion', { schemaVersion: 1 }],
  ])('refuses a save body with %s', async (field, extra) => {
    const message = await rejected(
      CreateContentStudioEditorialPolicyRevisionDto,
      { baseRevisionNumber: 1, content: content(), ...extra }
    );
    expect(message).toContain(
      `property ${Object.keys(extra)[0]} should not exist`
    );
    expect(field).toBeTruthy();
  });

  it('ED14 leaves a nested policy field to the strict domain parser', async () => {
    // class-validator does not look inside content; the service's parser
    // refuses the unknown field with CS_PROFILE_INVALID
    const body = await run(CreateContentStudioEditorialPolicyRevisionDto, {
      baseRevisionNumber: 1,
      content: { ...content(), platformRules: MARKER },
    });
    expect(body.content).toEqual({ ...content(), platformRules: MARKER });
  });

  it('ED15/ED16 parses the history page exactly', async () => {
    expect({
      ...(await run(ListContentStudioEditorialPolicyRevisionsDto, {}, 'query')),
    }).toEqual({ page: 1 });
    expect({
      ...(await run(
        ListContentStudioEditorialPolicyRevisionsDto,
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
      await rejected(
        ListContentStudioEditorialPolicyRevisionsDto,
        query,
        'query'
      );
    }
  });
});
