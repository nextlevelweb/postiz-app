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
  ApproveContentStudioReviewDto,
  CreateContentStudioReviewCommentDto,
  CreateContentStudioReviewDto,
  ListContentStudioReviewCommentsDto,
  ListContentStudioReviewsDto,
  RefuseContentStudioReviewDto,
  RequestContentStudioReviewChangesDto,
  ResolveContentStudioReviewRevisionRequestDto,
  UpdateContentStudioReviewClaimDto,
  UpdateContentStudioReviewCommentDto,
  WithdrawContentStudioReviewApprovalDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.review.dto';
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

const MARKER = 'REVIEW_ROUTE_PRIVATE_MARKER_456';
const ID = '44444444-4444-4444-8444-444444444444';
const REVISION = '55555555-5555-4555-8555-555555555555';
const COMMENT = '66666666-6666-4666-8666-666666666666';
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
    requestChanges: jest.fn().mockResolvedValue(result),
    listComments: jest.fn().mockResolvedValue(result),
    addComment: jest.fn().mockResolvedValue(result),
    editComment: jest.fn().mockResolvedValue(result),
    getRevisionRequest: jest.fn().mockResolvedValue(result),
    resolveRevisionRequest: jest.fn().mockResolvedValue(result),
    listClaims: jest.fn().mockResolvedValue(result),
    assessClaim: jest.fn().mockResolvedValue(result),
    getApproval: jest.fn().mockResolvedValue(result),
    decideApproval: jest.fn().mockResolvedValue(result),
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
    reviews as unknown as ContentStudioReviewService,
    {} as ContentStudioDesignAIService
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
    reviewId: 'review-b',
    authorUserId: 'user-b',
    resolvedByUserId: 'user-b',
    resolvedAt: new Date(0),
    resolvedByContentHash: 'd'.repeat(64),
    status: 'RESOLVED',
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
// The state changes that read no body; request changes reads its revision
// request (P5-02)
const TRANSITIONS = [
  ['startReview', 'start'],
  ['markReviewReadyForApproval', 'ready-for-approval'],
  ['cancelReview', 'cancel'],
] as const;

// Reviews (P5-01) and their discussion (P5-02): the eleven routes, the
// request organization and user only, the strict DTOs. The service has its
// own spec
describe('ContentStudioController review routes', () => {
  it('RE8/P501-13/C16/P502-6/API10/P504-4/P504-5 declares exactly these seventeen routes (122 -> 128 -> 133 -> 135 -> 139 -> 140 with P6-01, 141 with P6-02, 142 with P8-01, 143 with P8-02, 144 with P8-04A, 145 with P8-04B1): no delete, event, edit of a decision or reopen route', () => {
    const names = Object.getOwnPropertyNames(
      ContentStudioController.prototype
    ).filter((name) => /Review(?!sion)/.test(name));
    expect(names.map(route).sort()).toEqual([
      'GET /reviews',
      'GET /reviews/:id/approval',
      'GET /reviews/:id/claims',
      'GET /reviews/:id/comments',
      'GET /reviews/:id/revision-request',
      'PATCH /reviews/:id/comments/:commentId',
      'POST /reviews',
      'POST /reviews/:id/approval/approve',
      'POST /reviews/:id/approval/refuse',
      'POST /reviews/:id/approval/withdraw',
      'POST /reviews/:id/cancel',
      'POST /reviews/:id/comments',
      'POST /reviews/:id/ready-for-approval',
      'POST /reviews/:id/request-changes',
      'POST /reviews/:id/revision-request/resolve',
      'POST /reviews/:id/start',
      'PUT /reviews/:id/claims/:claimId',
    ]);
    for (const name of [
      ...TRANSITIONS.map(([name]) => name),
      'requestReviewChanges',
      'resolveReviewRevisionRequest',
      'approveReview',
      'refuseReviewApproval',
      'withdrawReviewApproval',
    ]) {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))).toBe(200);
    }
    // created: the default 201
    for (const name of ['requestReview', 'addReviewComment']) {
      expect(
        Reflect.getMetadata(HTTP_CODE_METADATA, handler(name))
      ).toBeUndefined();
    }
    const all = allRoutes();
    // P6-01: one more, a design from a saved package revision
    // P8-01: one more, the pages a feed source found
    // P8-02: one more, News Radar across feeds
    // P8-04A: one more, what changed in a source version
    // P8-04B1: one more, the organization's page changes
    // P8-C3: two more, pause and resume a feed
    expect(all).toHaveLength(147);
    expect(
      all.filter(
        (r) =>
          /review/i.test(r) &&
          /^(DELETE|PUT) |events|approve|approval(?!$)|reason|assign|reopen|latest|mention|attachment|reaction|annotation|layer|claim|source/i.test(
            r
              .replace('ready-for-approval', '')
              .replace(/^(GET|PUT) \/reviews\/:id\/claims(\/:claimId)?$/, '')
              .replace(
                /^(GET \/reviews\/:id\/approval|POST \/reviews\/:id\/approval\/(approve|refuse|withdraw))$/,
                ''
              )
          )
      )
    ).toEqual([]);
    // the only edit is a comment's own body
    expect(all.filter((r) => /review/i.test(r) && /^PATCH /.test(r))).toEqual([
      'PATCH /reviews/:id/comments/:commentId',
    ]);
    expect(all.filter((r) => /approv|claim/i.test(r)).sort()).toEqual([
      'GET /reviews/:id/approval',
      'GET /reviews/:id/claims',
      'POST /reviews/:id/approval/approve',
      'POST /reviews/:id/approval/refuse',
      'POST /reviews/:id/approval/withdraw',
      'POST /reviews/:id/ready-for-approval',
      'PUT /reviews/:id/claims/:claimId',
    ]);
    // a decision is never edited or deleted, and there is no generic "set
    // the approval" route
    expect(
      all.filter((r) => /approv/i.test(r) && /^(PATCH|PUT|DELETE) /.test(r))
    ).toEqual([]);
    expect(
      all.filter((r) => /\/approval(\/(state|set|status|decision))?$/.test(r))
    ).toEqual(['GET /reviews/:id/approval']);
    // the one whole-assessment write; a claim is never deleted
    expect(all.filter((r) => /review/i.test(r) && /^PUT /.test(r))).toEqual([
      'PUT /reviews/:id/claims/:claimId',
    ]);
    expect(all.filter((r) => /^DELETE .*comment/i.test(r))).toEqual([]);
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
      queue: undefined,
      search: undefined,
      page: 2,
    });
  });

  it('QSEC5 the Review & Approval queue (P5-06) is the same list: the queue and search as declared, the organization from the request only', async () => {
    const { controller, reviews } = setup();
    await controller.listReviews(
      ORG,
      Object.assign(withExtras(new ListContentStudioReviewsDto()), {
        page: 1,
        targetType: 'PACKAGE_REVISION',
        state: undefined,
        queue: 'PENDING_APPROVAL',
        search: 'Summer',
        organizationId: 'org-b',
      })
    );
    expect(reviews.listReviews).toHaveBeenCalledWith({
      organizationId: 'org-a',
      targetType: 'PACKAGE_REVISION',
      targetRevisionId: undefined,
      state: undefined,
      queue: 'PENDING_APPROVAL',
      search: 'Summer',
      page: 1,
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

  it('RR1/RR7 request changes forwards the request organization and user and the revision request text only', async () => {
    const { controller, reviews } = setup();
    await controller.requestReviewChanges(
      ORG,
      USER,
      ID,
      withExtras(
        Object.assign(new RequestContentStudioReviewChangesDto(), {
          body: 'Change the CTA.',
        })
      )
    );
    expect(reviews.requestChanges).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      id: ID,
      body: 'Change the CTA.',
    });
    expect(reviews.transitionReview).not.toHaveBeenCalled();
    expect(types('requestReviewChanges')).toEqual([
      Object,
      Object,
      String,
      RequestContentStudioReviewChangesDto,
    ]);
  });

  it('C9/C10/C11/CSEC1/CSEC2 comments are listed and posted for the request organization, by the request user, on the path review', async () => {
    const { controller, reviews } = setup();
    await controller.listReviewComments(
      ORG,
      ID,
      Object.assign(withExtras(new ListContentStudioReviewCommentsDto()), {
        page: 3,
      })
    );
    expect(reviews.listComments).toHaveBeenCalledWith({
      organizationId: 'org-a',
      reviewId: ID,
      page: 3,
    });
    await controller.addReviewComment(
      ORG,
      USER,
      ID,
      withExtras(
        Object.assign(new CreateContentStudioReviewCommentDto(), {
          body: 'Looks good.',
        })
      )
    );
    expect(reviews.addComment).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      reviewId: ID,
      body: 'Looks good.',
    });
    expect(types('listReviewComments')).toEqual([
      Object,
      String,
      ListContentStudioReviewCommentsDto,
    ]);
    expect(types('addReviewComment')).toEqual([
      Object,
      Object,
      String,
      CreateContentStudioReviewCommentDto,
    ]);
  });

  it('C12/C14/CSEC3 a comment edit names the path review and comment and the request user as its author', async () => {
    const { controller, reviews } = setup();
    await controller.editReviewComment(
      ORG,
      USER,
      ID,
      COMMENT,
      withExtras(
        Object.assign(new UpdateContentStudioReviewCommentDto(), {
          body: 'Edited',
        })
      )
    );
    expect(reviews.editComment).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      reviewId: ID,
      commentId: COMMENT,
      body: 'Edited',
    });
    expect(types('editReviewComment')).toEqual([
      Object,
      Object,
      String,
      String,
      UpdateContentStudioReviewCommentDto,
    ]);
  });

  it('CSEC4/CSEC5/CSEC8-CSEC10 the revision request is read and resolved for the request organization and user, by a revision id only', async () => {
    const { controller, reviews } = setup();
    await controller.getReviewRevisionRequest(ORG, ID);
    expect(reviews.getRevisionRequest).toHaveBeenCalledWith({
      organizationId: 'org-a',
      reviewId: ID,
    });
    await controller.resolveReviewRevisionRequest(
      ORG,
      USER,
      ID,
      withExtras(
        Object.assign(new ResolveContentStudioReviewRevisionRequestDto(), {
          resolutionRevisionId: REVISION,
        })
      )
    );
    expect(reviews.resolveRevisionRequest).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      reviewId: ID,
      resolutionRevisionId: REVISION,
    });
    expect(types('getReviewRevisionRequest')).toEqual([Object, String]);
    expect(types('resolveReviewRevisionRequest')).toEqual([
      Object,
      Object,
      String,
      ResolveContentStudioReviewRevisionRequestDto,
    ]);
  });

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
    expect(block).toContain('resolveReviewRevisionRequest');
    expect(block).not.toMatch(
      /AIConnection|AIWriting|Role\.|users|render|Handoff|@Delete|CheckPolicies|BrandKit|Media|isAdmin|ADMIN|AIOperation|Source(Service|Ingestion)|@Body\(\) body: (?!(CreateContentStudioReview|RequestContentStudioReviewChanges|CreateContentStudioReviewComment|UpdateContentStudioReviewComment|ResolveContentStudioReviewRevisionRequest|UpdateContentStudioReviewClaim|ApproveContentStudioReview|RefuseContentStudioReview|WithdrawContentStudioReviewApproval)Dto\b)/
    );
    // P5-04: approve, refuse and withdraw each read their note only
    expect(block.match(/@Body\(\)/g)).toHaveLength(9);
  });

  it('API1/API9/CLSEC1/CLSEC2 claims are listed and assessed for the request organization, by the request user, with the path claim and the declared fields only', async () => {
    const { controller, reviews, result } = setup();
    expect(await controller.listReviewClaims(ORG, ID)).toBe(result);
    expect(reviews.listClaims).toHaveBeenCalledWith({
      organizationId: 'org-a',
      reviewId: ID,
    });
    expect(
      await controller.assessReviewClaim(
        ORG,
        USER,
        ID,
        'c_claim000000000001',
        Object.assign(withExtras(new UpdateContentStudioReviewClaimDto()), {
          status: 'NEEDS_REVISION',
          finding: 'Wrong figure.',
          claimContentHash: 'f'.repeat(64),
          reviewedByUserId: 'user-b',
        })
      )
    ).toBe(result);
    expect(reviews.assessClaim).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-1',
      reviewId: ID,
      claimId: 'c_claim000000000001',
      status: 'NEEDS_REVISION',
      finding: 'Wrong figure.',
    });
    expect(types('listReviewClaims')).toEqual([Object, String]);
    expect(types('assessReviewClaim')).toEqual([
      Object,
      Object,
      String,
      String,
      UpdateContentStudioReviewClaimDto,
    ]);
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handler('assessReviewClaim'))
    ).toBeUndefined();
  });

  it('P504 approval is read and decided for the request organization, by the request user: the decision from the route, the note only from the body', async () => {
    const { controller, reviews, result } = setup();
    expect(await controller.getReviewApproval(ORG, ID)).toBe(result);
    expect(reviews.getApproval).toHaveBeenCalledWith({
      organizationId: 'org-a',
      reviewId: ID,
    });
    const extras = {
      decision: 'APPROVED',
      sequence: 1,
      packageRevisionId: REVISION,
      designRevisionId: REVISION,
    };
    for (const [method, dto, action] of [
      ['approveReview', ApproveContentStudioReviewDto, 'approve'],
      ['refuseReviewApproval', RefuseContentStudioReviewDto, 'refuse'],
      [
        'withdrawReviewApproval',
        WithdrawContentStudioReviewApprovalDto,
        'withdraw',
      ],
    ] as const) {
      reviews.decideApproval.mockClear();
      const body = Object.assign(withExtras(new dto()), extras, {
        note: 'Because.',
      });
      expect(
        await (
          controller[method] as (...args: unknown[]) => Promise<unknown>
        ).call(controller, ORG, USER, ID, body)
      ).toBe(result);
      expect(reviews.decideApproval).toHaveBeenCalledWith({
        organizationId: 'org-a',
        userId: 'user-1',
        reviewId: ID,
        action,
        note: 'Because.',
      });
      expect(types(method)).toEqual([Object, Object, String, dto]);
    }
    expect(types('getReviewApproval')).toEqual([Object, String]);
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

  it('accepts a queue and a search of the Review & Approval queue (P5-06)', async () => {
    for (const queue of [
      'NEEDS_REVIEW',
      'CHANGES_REQUESTED',
      'PENDING_APPROVAL',
      'APPROVED',
      'REFUSED',
      'CANCELLED',
    ]) {
      expect({
        ...(await run(
          ListContentStudioReviewsDto,
          { queue, search: 'Summer launch', targetType: 'DESIGN_REVISION' },
          'query'
        )),
      }).toEqual({
        page: 1,
        queue,
        search: 'Summer launch',
        targetType: 'DESIGN_REVISION',
      });
    }
    expect({
      ...(await run(
        ListContentStudioReviewsDto,
        { search: 'x'.repeat(100) },
        'query'
      )),
    }).toEqual({ page: 1, search: 'x'.repeat(100) });
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
    // P5-06: only a declared queue, never an approval or decision filter
    [{ queue: 'OPEN' }],
    [{ queue: 'ALL' }],
    [{ queue: 'approved' }],
    [{ queue: ['APPROVED', 'REFUSED'] }],
    [{ lifecycleState: 'APPROVED' }],
    [{ approvalState: 'APPROVED' }],
    [{ decision: 'APPROVED' }],
    [{ search: 'x'.repeat(101) }],
    [{ search: ['a', 'b'] }],
  ])('RA6 refuses the query %p', async (query) => {
    await rejected(ListContentStudioReviewsDto, query, 'query');
  });
});

describe('Approval DTO validation (P5-04)', () => {
  it('an approval takes an optional note; a refusal and a withdrawal take one, as sent', async () => {
    const note = '  Not cleared.\n\nSee legal.  ';
    for (const body of [{}, { note: null }, { note: '' }, { note }]) {
      expect({ ...(await run(ApproveContentStudioReviewDto, body)) }).toEqual(
        body
      );
    }
    for (const dto of [
      RefuseContentStudioReviewDto,
      WithdrawContentStudioReviewApprovalDto,
    ]) {
      expect({ ...(await run(dto, { note })) }).toEqual({ note });
      // blank text is the service's rule (CS_APPROVAL_NOTE_INVALID)
      expect({ ...(await run(dto, { note: ' ' })) }).toEqual({ note: ' ' });
      await run(dto, { note: 'x'.repeat(10_000) });
    }
  });

  const forbidden = [
    'organizationId',
    'userId',
    'actorUserId',
    'decision',
    'sequence',
    'targetContentHash',
    'contentHash',
    'packageRevisionId',
    'designRevisionId',
    'targetType',
    'reviewId',
    'state',
    'reviewState',
    'version',
    'createdAt',
    'approverId',
    'body',
    'comment',
  ];
  it.each([
    ...[
      ApproveContentStudioReviewDto,
      RefuseContentStudioReviewDto,
      WithdrawContentStudioReviewApprovalDto,
    ].flatMap((dto) => [
      [
        `${dto.name} with a note over 10,000 characters`,
        dto,
        { note: 'x'.repeat(10_001) },
      ],
      [`${dto.name} with a number`, dto, { note: 5 }],
      [`${dto.name} with a list`, dto, { note: ['x'] }],
      ...forbidden.map(
        (field) =>
          [
            `ASEC5-ASEC9 ${dto.name} with a ${field}`,
            dto,
            { note: 'Because.', [field]: MARKER },
          ] as [string, unknown, Record<string, unknown>]
      ),
    ]),
    ['a refusal without a note', RefuseContentStudioReviewDto, {}],
    [
      'a refusal with a null note',
      RefuseContentStudioReviewDto,
      { note: null },
    ],
    ['a withdrawal without a note', WithdrawContentStudioReviewApprovalDto, {}],
  ] as [string, ArgumentMetadata['metatype'], Record<string, unknown>][])(
    'refuses %s',
    async (_name, dto, body) => {
      await rejected(dto, body);
    }
  );
});

describe('Claim review DTO validation (P5-03B)', () => {
  it('API2/API3/API4 accepts a status with an optional finding as sent', async () => {
    for (const body of [
      { status: 'VERIFIED' },
      { status: 'VERIFIED', finding: null },
      { status: 'VERIFIED', finding: '  Checked\nagainst it.  ' },
      { status: 'NEEDS_REVISION', finding: 'Wrong figure.' },
      { status: 'UNREVIEWED', finding: null },
      { status: 'UNREVIEWED' },
    ]) {
      expect({
        ...(await run(UpdateContentStudioReviewClaimDto, body)),
      }).toEqual(body);
    }
    // which status needs or forbids a finding is the service's rule
    expect({
      ...(await run(UpdateContentStudioReviewClaimDto, {
        status: 'NEEDS_REVISION',
      })),
    }).toEqual({ status: 'NEEDS_REVISION' });
    await run(UpdateContentStudioReviewClaimDto, {
      status: 'VERIFIED',
      finding: 'x'.repeat(10_000),
    });
  });

  it.each([
    ['API6 an unknown status', { status: 'APPROVED' }],
    ['API6 a lower-case status', { status: 'verified' }],
    ['no status', { finding: 'x' }],
    [
      'API7 a finding over 10,000 characters',
      { status: 'VERIFIED', finding: 'x'.repeat(10_001) },
    ],
    ['a finding that is not text', { status: 'VERIFIED', finding: 5 }],
    [
      'API5/CLSEC5 an organization',
      { status: 'VERIFIED', organizationId: 'org-b' },
    ],
    ['API5/CLSEC6 a user', { status: 'VERIFIED', userId: 'user-b' }],
    ['CLSEC6 a reviewer', { status: 'VERIFIED', reviewedByUserId: 'user-b' }],
    ['CLSEC6 a review time', { status: 'VERIFIED', reviewedAt: '2026-01-01' }],
    [
      'CLSEC7 a claim hash',
      { status: 'VERIFIED', claimContentHash: 'f'.repeat(64) },
    ],
    ['CLSEC8 a claim text', { status: 'VERIFIED', claimText: MARKER }],
    ['CLSEC8 a thread item', { status: 'VERIFIED', threadItemId: 'main' }],
    ['CLSEC8 evidence', { status: 'VERIFIED', evidence: [] }],
    ['CLSEC8 a source', { status: 'VERIFIED', sourceId: REVISION }],
    ['CLSEC8 a source version', { status: 'VERIFIED', versionId: REVISION }],
    [
      'CLSEC8 a package revision',
      { status: 'VERIFIED', packageRevisionId: REVISION },
    ],
    ['a review id', { status: 'VERIFIED', reviewId: ID }],
  ])('API5 refuses %s', async (_label, body) => {
    await rejected(UpdateContentStudioReviewClaimDto, body);
  });
});

describe('Review discussion DTO validation (P5-02)', () => {
  it('C8/RR4 accepts plain text as sent, line breaks and spaces included', async () => {
    const text = '  Change the CTA.\n\n  Remove the claim.  ';
    for (const dto of [
      RequestContentStudioReviewChangesDto,
      CreateContentStudioReviewCommentDto,
      UpdateContentStudioReviewCommentDto,
    ]) {
      expect({ ...(await run(dto, { body: text })) }).toEqual({ body: text });
    }
    expect({
      ...(await run(ResolveContentStudioReviewRevisionRequestDto, {
        resolutionRevisionId: REVISION,
      })),
    }).toEqual({ resolutionRevisionId: REVISION });
    expect({
      ...(await run(
        ListContentStudioReviewCommentsDto,
        { page: '2' },
        'query'
      )),
    }).toEqual({ page: 2 });
    expect({
      ...(await run(ListContentStudioReviewCommentsDto, {}, 'query')),
    }).toEqual({ page: 1 });
  });

  it('C7/RR3 a comment is at most 10,000 characters and a revision request 20,000', async () => {
    await run(CreateContentStudioReviewCommentDto, {
      body: 'x'.repeat(10_000),
    });
    await rejected(CreateContentStudioReviewCommentDto, {
      body: 'x'.repeat(10_001),
    });
    await rejected(UpdateContentStudioReviewCommentDto, {
      body: 'x'.repeat(10_001),
    });
    await run(RequestContentStudioReviewChangesDto, {
      body: 'x'.repeat(20_000),
    });
    await rejected(RequestContentStudioReviewChangesDto, {
      body: 'x'.repeat(20_001),
    });
  });

  const textFields = [
    'organizationId',
    'userId',
    'authorUserId',
    'requestedByUserId',
    'reviewId',
    'createdAt',
    'editedAt',
    'state',
    'status',
    'parentId',
    'threadId',
    'mentions',
    'attachments',
    'layerId',
    'pageId',
    'sourceId',
    'claimId',
    'revisionId',
    'contentHash',
  ];
  it.each([
    ...[
      RequestContentStudioReviewChangesDto,
      CreateContentStudioReviewCommentDto,
      UpdateContentStudioReviewCommentDto,
    ].flatMap((dto) => [
      [`${dto.name} without a body`, dto, {}],
      [`${dto.name} with a number`, dto, { body: 5 }],
      [`${dto.name} with a list`, dto, { body: ['a'] }],
      [`${dto.name} with an object`, dto, { body: { text: MARKER } }],
      ...textFields.map(
        (field) =>
          [
            `${dto.name} with a ${field}`,
            dto,
            { body: 'text', [field]: MARKER },
          ] as [string, unknown, Record<string, unknown>]
      ),
    ]),
  ] as [string, ArgumentMetadata['metatype'], Record<string, unknown>][])(
    'RR1/C6/CSEC6/CSEC7/CSEC9 refuses %s',
    async (_name, dto, body) => {
      await rejected(dto, body);
    }
  );

  it.each([
    ['no revision', {}],
    ['"latest"', { resolutionRevisionId: 'latest' }],
    ['a package id that is not a uuid', { resolutionRevisionId: MARKER }],
    ['a list', { resolutionRevisionId: [REVISION] }],
    ...[
      'organizationId',
      'userId',
      'resolvedByUserId',
      'resolvedAt',
      'status',
      'resolutionContentHash',
      'resolvedByContentHash',
      'contentHash',
      'targetType',
      'resolvedByPackageRevisionId',
      'resolvedByDesignRevisionId',
      'revisionNumber',
      'state',
    ].map(
      (field) =>
        [`a ${field}`, { resolutionRevisionId: REVISION, [field]: MARKER }] as [
          string,
          Record<string, unknown>
        ]
    ),
  ])(
    'CSEC8/CSEC9/CSEC10/M15 the resolution refuses %s',
    async (_name, body) => {
      await rejected(ResolveContentStudioReviewRevisionRequestDto, body);
    }
  );

  it.each([
    [{ page: '0' }],
    [{ page: 'x' }],
    [{ order: 'desc' }],
    [{ take: '500' }],
    [{ organizationId: 'org-b' }],
  ])('C11 refuses the comment query %p', async (query) => {
    await rejected(ListContentStudioReviewCommentsDto, query, 'query');
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

  it('P501-4/P501-5/P501-6/P502-1/51 adds exactly the review, state event, comment and revision request models: no claim event, annotation or reviewer model (the approval decision model is P5-04)', () => {
    const models = Array.from(
      schema.matchAll(/^model (ContentStudio\w*) \{/gm),
      (m) => m[1]
    );
    expect(models.filter((m) => /Review/.test(m))).toEqual([
      'ContentStudioReview',
      'ContentStudioReviewStateEvent',
      'ContentStudioReviewComment',
      'ContentStudioReviewRevisionRequest',
      // P5-03B: the one claim assessment model
      'ContentStudioReviewClaim',
    ]);
    expect(
      models.filter((m) =>
        /Approval|Claim(?!$)|Annotation|Reviewer|Signature|Mention|Attachment|Reaction|Notification|SourceReview|Event(?!$)/.test(
          m
        )
      )
    ).toEqual(['ContentStudioApproval']);
    expect(
      models.filter((m) =>
        /Approver|Quorum|ApprovalGroup|ApprovalState/.test(m)
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
    // no package, design, project, template or content of its own, and no
    // approval state: only the relation to its decisions (P5-04)
    expect(review).toMatch(/approvals +ContentStudioApproval\[\]/);
    expect(
      review.replace(/approvals +ContentStudioApproval\[\]/, '')
    ).not.toMatch(
      /packageId|designProjectId|projectId|templateId|content +String|Json|approv|reason|assigned|dueAt|metadata/i
    );
    // P5-02 adds only the two discussion relations
    expect(review).toMatch(/comments +ContentStudioReviewComment\[\]/);
    expect(review).toMatch(
      /revisionRequest +ContentStudioReviewRevisionRequest\?/
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

  it('P501-7/P501-8/M26 publishing is never gated on a review; a handoff only through the P5-07 approval gate', () => {
    for (const file of [
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.repository.ts',
      'libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts',
    ]) {
      expect(code(file)).not.toMatch(/\breview|READY_FOR_APPROVAL|approv/i);
    }
    // P5-07: where the policy requires it, the handoff asks
    // requireApprovedRevision; P5-08: opening one has the review service
    // check what authorized it, never the approval of now
    expect(
      code(
        'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.handoff.service.ts'
      )
        .match(/_contentStudioReviewService\.\w+/g)!
        .sort()
    ).toEqual([
      '_contentStudioReviewService.requireApprovedRevision',
      '_contentStudioReviewService.requireApprovedRevision',
      '_contentStudioReviewService.verifyHandoffApprovalAuthorization',
    ]);
    // P5-05: the package and design revision views show whether exactly a
    // revision is approved, read from the review service; they gate nothing
    for (const file of [
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.service.ts',
      'libraries/nestjs-libraries/src/database/prisma/content-studio/content-studio.design.service.ts',
    ]) {
      const text = code(file);
      expect(text.match(/_contentStudioReviewService\.\w+/g)!.sort()).toEqual([
        '_contentStudioReviewService.getRevisionApprovalStatus',
        '_contentStudioReviewService.getRevisionApprovalStatuses',
      ]);
      expect(text).not.toMatch(
        /READY_FOR_APPROVAL|requireApproved|CS_APPROVAL|\.approved\b/
      );
    }
    // P5-08: a handoff keeps only what authorized it when it was created
    // (the four approval fields and its review), never a gate or the
    // approval of now
    const handoff = model('ContentStudioHandoff');
    expect(
      Array.from(handoff.matchAll(/^ {2}(\w+) +\S/gm), (m) => m[1]).filter(
        (field) => /review|approv/i.test(field)
      )
    ).toEqual([
      'approvalRequiredAtCreation',
      'approvalReviewId',
      'approvalSequence',
      'approvalContentHash',
      'approvalReview',
    ]);
    expect(handoff).not.toMatch(
      /\b(approved|currentApproval\w*|approvalState)\b/
    );
  });

  it('P502-3/P502-7/P502-9/44 a comment is plain text on the review only: no target, hash, thread, attachment or annotation', () => {
    const comment = model('ContentStudioReviewComment');
    const fields = Array.from(
      comment.matchAll(/^ {2}(\w+) +\S/gm),
      (m) => m[1]
    );
    expect(fields).toEqual([
      'id',
      'organizationId',
      'reviewId',
      'authorUserId',
      'body',
      'createdAt',
      'editedAt',
      'organization',
      'review',
      'author',
    ]);
    expect(comment).toMatch(
      /review +ContentStudioReview +@relation\(fields: \[reviewId, organizationId\], references: \[id, organizationId\]\)/
    );
    expect(comment).toMatch(/editedAt +DateTime\?/);
    for (const index of [
      '@@unique([id, organizationId])',
      '@@index([reviewId, createdAt])',
      '@@index([organizationId, createdAt])',
      '@@index([authorUserId])',
    ]) {
      expect(comment).toContain(index);
    }
    expect(comment).not.toMatch(
      /Json|parent|thread|mention|attach|reaction|layer|page|coordinate|source|claim|contentHash|packageRevision|designRevision|updatedAt|deletedAt/i
    );
  });

  it('13/25/51 one revision request per review, resolved by exactly one org-scoped revision with its hash', () => {
    const request = model('ContentStudioReviewRevisionRequest');
    const fields = Array.from(
      request.matchAll(/^ {2}(\w+) +\S/gm),
      (m) => m[1]
    );
    expect(fields).toEqual([
      'id',
      'organizationId',
      'reviewId',
      'requestedByUserId',
      'body',
      'status',
      'resolvedByUserId',
      'resolvedAt',
      'resolvedByPackageRevisionId',
      'resolvedByDesignRevisionId',
      'resolvedByContentHash',
      'createdAt',
      'organization',
      'review',
      'requestedBy',
      'resolvedBy',
      'resolvedByPackageRevision',
      'resolvedByDesignRevision',
    ]);
    expect(request).toContain('@@unique([reviewId, organizationId])');
    expect(request).toContain('@@unique([id, organizationId])');
    expect(request).toMatch(
      /resolvedByPackageRevision +ContentPackageRevision\? +@relation\(fields: \[resolvedByPackageRevisionId, organizationId\], references: \[id, organizationId\], onDelete: Restrict, onUpdate: Restrict\)/
    );
    expect(request).toMatch(
      /resolvedByDesignRevision +ContentStudioDesignRevision\? +@relation\(fields: \[resolvedByDesignRevisionId, organizationId\], references: \[id, organizationId\], onDelete: Restrict, onUpdate: Restrict\)/
    );
    expect(request).toMatch(/resolvedByContentHash +String\?/);
    expect(request).not.toMatch(
      /Json|approv|reject|updatedAt|deletedAt|metadata/i
    );
    expect(schema).not.toMatch(/^enum ContentStudio/m);
  });

  it('P501-14 adds no dependency', () => {
    const pkg = JSON.parse(read('package.json'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(
      deps.filter((d) => /review|approv|state-?machine|xstate/i.test(d))
    ).toEqual([]);
  });
});
