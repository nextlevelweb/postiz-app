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
  CreateContentStudioReviewDto,
  ListContentStudioReviewsDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.review.dto';

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

const MARKER = 'REVIEW_ROUTE_PRIVATE_MARKER_456';
const ID = '44444444-4444-4444-8444-444444444444';
const REVISION = '55555555-5555-4555-8555-555555555555';
const ORG = {
  id: 'org-a',
  users: [{ disabled: false, role: 'USER' }],
} as unknown as Organization;
const USER = { id: 'user-1' } as User;
const REPO = path.join(__dirname, '../../../../..');
const read = (file: string) => fs.readFileSync(path.join(REPO, file), 'utf8');

const setup = () => {
  const result = { from: 'service' };
  const reviews = {
    listReviews: jest.fn().mockResolvedValue(result),
    requestReview: jest.fn().mockResolvedValue(result),
    transitionReview: jest.fn().mockResolvedValue(result),
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
    {} as ContentStudioDesignBlockService,
    reviews as unknown as ContentStudioReviewService
  );
  return { reviews, controller, result };
};

// A DTO that also carries fields it does not declare, as it would without the
// strict pipe: the controller must still forward only the declared fields
const withExtras = <T extends object>(dto: T) =>
  Object.assign(dto, {
    organizationId: 'org-b',
    userId: 'user-b',
    requestedById: 'user-b',
    actorUserId: 'user-b',
    contentHash: 'f'.repeat(64),
    targetContentHash: 'e'.repeat(64),
    state: 'READY_FOR_APPROVAL',
    packageId: 'package-b',
    designId: 'design-b',
    reason: MARKER,
  });

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
const types = (method: string) =>
  Reflect.getMetadata(
    'design:paramtypes',
    ContentStudioController.prototype,
    method
  );
const TRANSITIONS = [
  ['startReview', 'start'],
  ['requestReviewChanges', 'request-changes'],
  ['markReviewReadyForApproval', 'ready-for-approval'],
  ['cancelReview', 'cancel'],
] as const;

// Reviews (P5-01): the six routes, the request organization and user only,
// the strict DTOs, state changes without a body. The service has its own spec
describe('ContentStudioController review routes', () => {
  it('RE8/P501-13 declares exactly these six routes (122 -> 128): no delete, edit, event, approval or comment route', () => {
    const names = Object.getOwnPropertyNames(
      ContentStudioController.prototype
    ).filter((name) => /Review(?!sion)/.test(name));
    expect(names.map(route).sort()).toEqual([
      'GET /reviews',
      'POST /reviews',
      'POST /reviews/:id/cancel',
      'POST /reviews/:id/ready-for-approval',
      'POST /reviews/:id/request-changes',
      'POST /reviews/:id/start',
    ]);
    for (const [name] of TRANSITIONS) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))).toBe(200);
    }
    // created: the default 201
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handler('requestReview'))
    ).toBeUndefined();
    const all = allRoutes();
    expect(all).toHaveLength(128);
    expect(
      all.filter(
        (r) =>
          /review/i.test(r) &&
          /^(DELETE|PUT|PATCH) |events|approve|approval(?!$)|comment|reason|assign|reopen|latest/i.test(
            r.replace('ready-for-approval', '')
          )
      )
    ).toEqual([]);
    expect(all.filter((r) => /approv|comment|claim/i.test(r))).toEqual([
      'POST /reviews/:id/ready-for-approval',
    ]);
  });

  it('RA10/RSEC3 lists for the request organization only, with the declared filters', async () => {
    const { controller, reviews } = setup();
    await controller.listReviews(
      ORG,
      Object.assign(withExtras(new ListContentStudioReviewsDto()), {
        page: 2,
        targetType: 'DESIGN_REVISION',
        targetRevisionId: REVISION,
        state: 'IN_REVIEW',
      })
    );
    expect(reviews.listReviews).toHaveBeenCalledWith({
      organizationId: 'org-a',
      targetType: 'DESIGN_REVISION',
      targetRevisionId: REVISION,
      state: 'IN_REVIEW',
      page: 2,
    });
  });

  it('RA10/RC5/RC6/RSEC8-RSEC11 requests a review with the request organization and user and the declared target only', async () => {
    const { controller, reviews, result } = setup();
    await expect(
      controller.requestReview(
        ORG,
        USER,
        withExtras(
          Object.assign(new CreateContentStudioReviewDto(), {
            targetType: 'PACKAGE_REVISION',
            targetRevisionId: REVISION,
          })
        )
      )
    ).resolves.toBe(result);
    expect(reviews.requestReview).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      targetType: 'PACKAGE_REVISION',
      targetRevisionId: REVISION,
    });
  });

  it.each(TRANSITIONS)(
    'RE5 %s moves the review by the request user with a fixed action and reads no body',
    async (name, action) => {
      const { controller, reviews } = setup();
      await (
        controller as unknown as Record<
          string,
          (...args: unknown[]) => Promise<unknown>
        >
      )[name](ORG, USER, ID, { state: 'CANCELLED', reason: MARKER });
      expect(reviews.transitionReview).toHaveBeenCalledWith({
        organizationId: 'org-a',
        userId: 'user-1',
        id: ID,
        action,
      });
      // organization, user, id: no body parameter at all
      expect(types(name)).toEqual([Object, Object, String]);
    }
  );

  it('RA1 declares the strict DTOs and adds no role, policy, billing, AI, render or handoff gate', () => {
    expect(types('listReviews')[1]).toBe(ListContentStudioReviewsDto);
    expect(types('requestReview')[2]).toBe(CreateContentStudioReviewDto);
    const text = read(
      'apps/backend/src/api/routes/content-studio.controller.ts'
    );
    const block = text.slice(
      text.indexOf("@Get('/reviews')"),
      text.indexOf('// Renders one page of exactly the revision')
    );
    expect(block).toContain('cancelReview');
    expect(block).not.toMatch(
      /AIConnection|AIWriting|Role\.|users|render|Handoff|@Delete|CheckPolicies|BrandKit|Media|@Body\(\) body: (?!CreateContentStudioReviewDto)/
    );
    expect(block.match(/@Body\(\)/g)).toHaveLength(1);
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

describe('Review DTO validation', () => {
  it('RA2/RA3 accepts a package or a design revision target as sent', async () => {
    for (const targetType of ['PACKAGE_REVISION', 'DESIGN_REVISION']) {
      expect({
        ...(await run(CreateContentStudioReviewDto, {
          targetType,
          targetRevisionId: REVISION,
        })),
      }).toEqual({ targetType, targetRevisionId: REVISION });
    }
  });

  it('RA6-RA9 accepts the bounded list query: page, target type, exact revision, state', async () => {
    expect({
      ...(await run(
        ListContentStudioReviewsDto,
        {
          page: '3',
          targetType: 'PACKAGE_REVISION',
          targetRevisionId: REVISION,
          state: 'CHANGES_REQUESTED',
        },
        'query'
      )),
    }).toEqual({
      page: 3,
      targetType: 'PACKAGE_REVISION',
      targetRevisionId: REVISION,
      state: 'CHANGES_REQUESTED',
    });
    expect({
      ...(await run(ListContentStudioReviewsDto, {}, 'query')),
    }).toEqual({ page: 1 });
  });

  it.each([
    ['no target type', { targetRevisionId: REVISION }],
    ['no revision id', { targetType: 'PACKAGE_REVISION' }],
    [
      'an unknown target type',
      { targetType: 'PACKAGE', targetRevisionId: REVISION },
    ],
    ['a project target', { targetType: 'PROJECT', targetRevisionId: REVISION }],
    [
      'a template target',
      { targetType: 'TEMPLATE_REVISION', targetRevisionId: REVISION },
    ],
    [
      'a lower-case target type',
      { targetType: 'package_revision', targetRevisionId: REVISION },
    ],
    [
      '"latest" as the revision',
      { targetType: 'DESIGN_REVISION', targetRevisionId: 'latest' },
    ],
    [
      'a revision id that is not a uuid',
      { targetType: 'DESIGN_REVISION', targetRevisionId: MARKER },
    ],
    [
      'a list of revisions',
      { targetType: 'DESIGN_REVISION', targetRevisionId: [REVISION] },
    ],
    ...[
      'organizationId',
      'userId',
      'requestedById',
      'actorUserId',
      'contentHash',
      'targetContentHash',
      'state',
      'version',
      'packageRevisionId',
      'designRevisionId',
      'packageId',
      'designId',
      'reason',
      'comment',
      'reviewerId',
      'approved',
    ].map(
      (field) =>
        [
          `a ${field}`,
          {
            targetType: 'PACKAGE_REVISION',
            targetRevisionId: REVISION,
            [field]: MARKER,
          },
        ] as [string, Record<string, unknown>]
    ),
  ])('RA1/RA4/RA5/RSEC8-RSEC11 refuses a body with %s', async (_name, body) => {
    await rejected(CreateContentStudioReviewDto, body);
  });

  it.each([
    [{ page: '0' }],
    [{ page: '100001' }],
    [{ targetType: 'PACKAGE' }],
    [{ targetRevisionId: 'latest' }],
    [{ state: 'APPROVED' }],
    [{ state: 'requested' }],
    [{ organizationId: 'org-b' }],
    [{ take: '1000' }],
    [{ where: MARKER }],
  ])('RA6 refuses the query %p', async (query) => {
    await rejected(ListContentStudioReviewsDto, query, 'query');
  });
});

// What P5-01 leaves exactly as it was
describe('Review boundaries (P5-01)', () => {
  const schema = read(
    'libraries/nestjs-libraries/src/database/prisma/schema.prisma'
  );
  const model = (name: string) => {
    const start = schema.indexOf(`model ${name} {`);
    return schema.slice(start, schema.indexOf('\n}', start));
  };
  const code = (file: string) => read(file).replace(/\/\/.*$/gm, '');

  it('P501-4/P501-5/P501-6 adds exactly the review and state event models: no approval, comment, claim or revision request model', () => {
    const models = Array.from(
      schema.matchAll(/^model (ContentStudio\w*) \{/gm),
      (m) => m[1]
    );
    expect(models.filter((m) => /Review/.test(m))).toEqual([
      'ContentStudioReview',
      'ContentStudioReviewStateEvent',
    ]);
    expect(
      models.filter((m) =>
        /Approval|Comment|Claim|RevisionRequest|Annotation|Reviewer|Signature/.test(
          m
        )
      )
    ).toEqual([]);
    expect(schema).not.toMatch(/^enum ContentStudio/m);
  });

  it('the review binds an exact revision by id, organization-scoped, with a unique target', () => {
    const review = model('ContentStudioReview');
    expect(review).toMatch(
      /packageRevision +ContentPackageRevision\? +@relation\(fields: \[packageRevisionId, organizationId\], references: \[id, organizationId\], onDelete: Restrict, onUpdate: Restrict\)/
    );
    expect(review).toMatch(
      /designRevision +ContentStudioDesignRevision\? +@relation\(fields: \[designRevisionId, organizationId\], references: \[id, organizationId\], onDelete: Restrict, onUpdate: Restrict\)/
    );
    expect(review).toContain('@@unique([organizationId, packageRevisionId])');
    expect(review).toContain('@@unique([organizationId, designRevisionId])');
    expect(review).toMatch(/version +Int +@default\(1\)/);
    // no package, design, project, template or content of its own
    expect(review).not.toMatch(
      /packageId|designProjectId|projectId|templateId|content +String|Json|approv|comment|reason|assigned|dueAt|metadata/i
    );
    const event = model('ContentStudioReviewStateEvent');
    expect(event).toContain('@@unique([reviewId, sequence])');
    expect(event).toMatch(/fromState +String\?/);
    // append-only: no updatedAt, no free text or metadata bag
    expect(event).not.toMatch(
      /updatedAt|Json|comment|reason|ip|userAgent|metadata/
    );
  });

  it('P501-1/P501-2/P501-3 Design Document v1 and the package draft hold no review state', () => {
    const design = code(
      'libraries/nestjs-libraries/src/content-studio/design/design.document.ts'
    );
    expect(design).toMatch(/DESIGN_DOCUMENT_SCHEMA_VERSION = 1\b/);
    for (const source of [
      design,
      code(
        'libraries/nestjs-libraries/src/content-studio/content.package.draft.ts'
      ),
    ]) {
      expect(source).not.toMatch(/\breview|approv/i);
    }
  });

  it('P501-7/P501-8/M26 handoff and publishing are not gated on a review', () => {
    for (const file of [
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.handoff.service.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.handoff.repository.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.service.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.repository.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design.service.ts',
      'libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts',
    ]) {
      expect(code(file)).not.toMatch(/\breview|READY_FOR_APPROVAL|approv/i);
    }
    const handoff = model('ContentStudioHandoff');
    expect(handoff).not.toMatch(/review|approv/i);
  });

  it('P501-14 adds no dependency', () => {
    const pkg = JSON.parse(read('package.json'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(
      deps.filter((d) => /review|approv|state-?machine|xstate/i.test(d))
    ).toEqual([]);
  });
});
