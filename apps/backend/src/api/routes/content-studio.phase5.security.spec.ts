import fs from 'fs';
import path from 'path';
import { ValidationPipe } from '@nestjs/common';
import {
  ApproveContentStudioReviewDto,
  CreateContentStudioReviewCommentDto,
  CreateContentStudioReviewDto,
  RefuseContentStudioReviewDto,
  RequestContentStudioReviewChangesDto,
  ResolveContentStudioReviewRevisionRequestDto,
  UpdateContentStudioReviewClaimDto,
  UpdateContentStudioReviewCommentDto,
  WithdrawContentStudioReviewApprovalDto,
} from '@gitroom/nestjs-libraries/dtos/content-studio/content-studio.review.dto';
import {
  emptyContentStudioEditorialPolicyContent,
  isContentStudioApprovalRequiredForHandoff,
  parseContentStudioEditorialPolicyContent,
} from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy';
import { canonicalJson } from '@gitroom/nestjs-libraries/content-studio/canonical.json';
import { CONTENT_STUDIO_REVIEW_STATES } from '@gitroom/nestjs-libraries/content-studio/review/review.state';
import { CONTENT_STUDIO_APPROVAL_DECISIONS } from '@gitroom/nestjs-libraries/content-studio/review/review.approval';

// The final Phase 5 architecture in one place (P5-08), pinned on the source:
// what is append-only, which one path creates a handoff and what it keeps,
// where approval may be enforced and where never, what a client can never
// send, and that errors name nothing. The behavior behind each line is
// covered by the review and handoff specs and by the PostgreSQL suite; this
// spec keeps the decisions from drifting. Comments are stripped: they
// explain the rules and may name them.
//
// The audit model it pins: package and design revisions and source versions
// are immutable; review state events and approval decisions are append-only;
// a revision request is resolved once and then fixed; what authorized a
// handoff is written with it and never changed. Comments are NOT audit
// records (their author edits them; editedAt says so), and claim assessments
// are current state that changes while a review is IN_REVIEW and freezes
// with it
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const BASES = [
  'libraries/nestjs-libraries/src',
  'libraries/helpers/src',
  'apps/backend/src',
  'apps/orchestrator/src',
  'apps/frontend/src',
];
const SKIPPED = new Set(['node_modules', 'dist', '.next', 'generated']);
const walk = (directory: string): string[] =>
  fs.existsSync(directory)
    ? fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          return SKIPPED.has(entry.name) ? [] : walk(full);
        }
        return /\.tsx?$/.test(entry.name) &&
          !/\.(spec|test)\.tsx?$/.test(entry.name) &&
          !entry.name.endsWith('.d.ts')
          ? [full]
          : [];
      })
    : [];
const PRODUCTION = BASES.flatMap((base) =>
  walk(path.join(REPO_ROOT, base))
).map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'));
const code = (relative: string) =>
  fs
    .readFileSync(path.join(REPO_ROOT, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
const CODE = new Map(PRODUCTION.map((file) => [file, code(file)]));
const users = (pattern: RegExp) =>
  PRODUCTION.filter((file) => pattern.test(CODE.get(file)!)).sort();
const count = (text: string, pattern: RegExp) =>
  (text.match(new RegExp(pattern.source, 'g')) ?? []).length;
// The body of one class method: from its name to the next member
const method = (source: string, name: string) => {
  const start = source.search(new RegExp(`\\n  (async )?${name}\\(`));
  expect(start).toBeGreaterThan(-1);
  const next = source
    .slice(start + 1)
    .search(/\n  (async |private |private async )?[a-zA-Z]+\(/);
  return next === -1
    ? source.slice(start)
    : source.slice(start, start + 1 + next);
};

const LIB = 'libraries/nestjs-libraries/src';
const CS = `${LIB}/database/prisma/content-studio`;
const REVIEW_SERVICE = `${CS}/content-studio.review.service.ts`;
const REVIEW_REPOSITORY = `${CS}/content-studio.review.repository.ts`;
const HANDOFF_SERVICE = `${CS}/content-studio.handoff.service.ts`;
const HANDOFF_REPOSITORY = `${CS}/content-studio.handoff.repository.ts`;
const POLICY_SERVICE = `${CS}/content-studio.editorial-policy.service.ts`;
const STUDIO_SERVICE = `${CS}/content-studio.service.ts`;
const POLICY = `${LIB}/content-studio/editorial/editorial.policy.ts`;
const REVIEW_STATE = `${LIB}/content-studio/review/review.state.ts`;
const REVIEW_APPROVAL = `${LIB}/content-studio/review/review.approval.ts`;
const REVIEW_CLAIM = `${LIB}/content-studio/review/review.claim.ts`;
const REVIEW_DTO = `${LIB}/dtos/content-studio/content-studio.review.dto.ts`;
const CONTROLLER = 'apps/backend/src/api/routes/content-studio.controller.ts';
const FE = 'apps/frontend/src/components/content-studio';
const SCHEMA = fs.readFileSync(
  path.join(REPO_ROOT, `${LIB}/database/prisma/schema.prisma`),
  'utf8'
);
const model = (name: string) => {
  const start = SCHEMA.indexOf(`model ${name} {`);
  expect(start).toBeGreaterThan(-1);
  return SCHEMA.slice(start, SCHEMA.indexOf('\n}', start));
};
const P5_MODELS = [
  'ContentStudioReview',
  'ContentStudioReviewStateEvent',
  'ContentStudioReviewComment',
  'ContentStudioReviewRevisionRequest',
  'ContentStudioReviewClaim',
  'ContentStudioApproval',
  'ContentStudioHandoff',
];
const delegate = (name: string) => name[0].toLowerCase() + name.slice(1);

describe('Phase 5 security and audit architecture (P5-08)', () => {
  it('lists the Phase 5 production files', () => {
    for (const file of [
      REVIEW_SERVICE,
      REVIEW_REPOSITORY,
      HANDOFF_SERVICE,
      HANDOFF_REPOSITORY,
      POLICY_SERVICE,
      POLICY,
      REVIEW_STATE,
      REVIEW_APPROVAL,
      REVIEW_CLAIM,
      REVIEW_DTO,
      CONTROLLER,
    ]) {
      expect(PRODUCTION).toContain(file);
    }
  });

  describe('append-only history', () => {
    it('P5S-1/M10 approval decisions are only ever created, by the one append that holds the review', () => {
      expect(
        users(
          /contentStudioApproval\.(update|updateMany|upsert|delete|deleteMany)\(/
        )
      ).toEqual([]);
      expect(users(/contentStudioApproval\.create\(/)).toEqual([
        REVIEW_REPOSITORY,
      ]);
      const repository = CODE.get(REVIEW_REPOSITORY)!;
      expect(count(repository, /contentStudioApproval\.create\(/)).toBe(1);
      expect(method(repository, 'appendApprovalDecision')).toMatch(
        /contentStudioApproval\.create\(/
      );
      // the handoff only counts and reads them under its hold
      expect(
        CODE.get(HANDOFF_REPOSITORY)!.match(/contentStudioApproval\.\w+/g)
      ).toEqual([
        'contentStudioApproval.count',
        'contentStudioApproval.findFirst',
      ]);
    });

    it('P5S-2 review state events are only ever created, with the review or its transition', () => {
      expect(
        users(
          /contentStudioReviewStateEvent\.(update|updateMany|upsert|delete|deleteMany)\(/
        )
      ).toEqual([]);
      expect(users(/contentStudioReviewStateEvent\.create\(/)).toEqual([
        REVIEW_REPOSITORY,
      ]);
      const repository = CODE.get(REVIEW_REPOSITORY)!;
      expect(count(repository, /contentStudioReviewStateEvent\.create\(/)).toBe(
        2
      );
      expect(method(repository, 'createReview')).toMatch(
        /sequence: 1,\s*fromState: null,\s*toState: 'REQUESTED'/
      );
      expect(method(repository, 'transitionReviewWithCompareAndSwap')).toMatch(
        /sequence: input\.expectedVersion \+ 1,\s*fromState: input\.expectedState/
      );
    });

    it('P5S-3 nothing of Phase 5 is ever deleted or upserted by the application', () => {
      for (const name of P5_MODELS) {
        expect(
          users(new RegExp(`${delegate(name)}\\.(delete|deleteMany|upsert)\\(`))
        ).toEqual([]);
      }
    });

    it('P5S-4 a review changes only by compare-and-swap or a hold; its target and hash are never written after it is created', () => {
      const repository = CODE.get(REVIEW_REPOSITORY)!;
      for (const update of repository
        .split(/contentStudioReview\.updateMany\(/)
        .slice(1)) {
        const data = update.slice(
          update.indexOf('data:'),
          update.indexOf('}', update.indexOf('data:')) + 40
        );
        expect(data).not.toMatch(
          /packageRevisionId|designRevisionId|targetContentHash|organizationId|requestedById/
        );
      }
      expect(users(/contentStudioReview\.(update|upsert)\(/)).toEqual([]);
    });

    it('P5S-5 a revision request is resolved once: every resolution field in one compare-and-swap from OPEN with none set', () => {
      const resolve = method(
        CODE.get(REVIEW_REPOSITORY)!,
        'resolveRevisionRequestWithCompareAndSwap'
      );
      expect(resolve).toMatch(
        /status: 'OPEN',\s*resolvedByUserId: null,\s*resolvedAt: null,\s*resolvedByPackageRevisionId: null,\s*resolvedByDesignRevisionId: null,\s*resolvedByContentHash: null,/
      );
      expect(users(/contentStudioReviewRevisionRequest\.updateMany\(/)).toEqual(
        [REVIEW_REPOSITORY]
      );
      expect(
        count(
          CODE.get(REVIEW_REPOSITORY)!,
          /contentStudioReviewRevisionRequest\.updateMany\(/
        )
      ).toBe(1);
    });

    it('P5S-6 comments are editable by their author only, never deleted: they are not audit records', () => {
      const edit = method(CODE.get(REVIEW_REPOSITORY)!, 'editCommentOfAuthor');
      expect(edit).toMatch(/authorUserId: input\.authorUserId,/);
      expect(edit).toMatch(
        /data: \{\s*body: input\.body,\s*editedAt: input\.editedAt,\s*\}/
      );
      expect(
        count(
          CODE.get(REVIEW_REPOSITORY)!,
          /contentStudioReviewComment\.updateMany\(/
        )
      ).toBe(1);
      expect(
        users(/deleteComment|removeComment/).filter((file) =>
          /content-studio/.test(file)
        )
      ).toEqual([]);
    });

    it('P5S-7 claim assessments are current state: written only while the review is held IN_REVIEW, frozen after', () => {
      const repository = CODE.get(REVIEW_REPOSITORY)!;
      expect(users(/contentStudioReviewClaim\.(create|updateMany)\(/)).toEqual([
        REVIEW_REPOSITORY,
      ]);
      const set = method(repository, 'setClaimAssessment');
      expect(set).toMatch(
        /state: 'IN_REVIEW',\s*version: input\.expectedVersion,/
      );
      expect(
        count(repository, /contentStudioReviewClaim\.(create|updateMany)\(/)
      ).toBe(2);
      expect(
        count(set, /contentStudioReviewClaim\.(create|updateMany)\(/)
      ).toBe(2);
      // no claim event history was invented
      expect(SCHEMA).not.toMatch(/model ContentStudioReviewClaimEvent/);
    });
  });

  describe('the handoff and what authorized it', () => {
    it('P5S-8 one path creates a handoff: the handoff service through its repository', () => {
      expect(users(/contentStudioHandoff\.create\(/)).toEqual([
        HANDOFF_REPOSITORY,
      ]);
      expect(
        count(CODE.get(HANDOFF_REPOSITORY)!, /contentStudioHandoff\.create\(/)
      ).toBe(2);
      expect(users(/\.createHandoff\(|\.createHandoffWhileApproved\(/)).toEqual(
        [
          CONTROLLER,
          // the first post (activation flow 01), the same way
          `${FE}/content-studio.first-post.tsx`,
          // the package editor, through the API client and so the route
          `${FE}/content-studio.workspace.tsx`,
          HANDOFF_SERVICE,
        ]
      );
      expect(users(/ContentStudioHandoffRepository\b/)).toEqual([
        HANDOFF_REPOSITORY,
        HANDOFF_SERVICE,
        `${LIB}/database/prisma/database.module.ts`,
      ]);
      // the controller creates through the service only
      expect(CODE.get(CONTROLLER)).toMatch(
        /this\._contentStudioHandoffService\.createHandoff\(\{\s*organizationId: org\.id,\s*userId: user\.id,\s*packageId: id,\s*revisionId,\s*\}\)/
      );
      // an approved one only inside the hold, after the predicate
      const create = method(CODE.get(HANDOFF_SERVICE)!, 'createHandoff');
      expect(create.indexOf('requireApprovedRevision(')).toBeLessThan(
        create.indexOf('createHandoffWhileApproved(')
      );
    });

    it('P5S-9/M20/M22 what authorized a handoff is written by its create only, whole, and never by an update', () => {
      const repository = CODE.get(HANDOFF_REPOSITORY)!;
      const fields =
        /approvalRequiredAtCreation|approvalReviewId|approvalSequence|approvalContentHash/;
      for (const update of repository
        .split(/contentStudioHandoff\.updateMany\(/)
        .slice(1)) {
        expect(update.slice(0, update.indexOf('});'))).not.toMatch(fields);
      }
      // the plain create says not required with no approval field; the
      // approved one says required with all three, from inside the hold
      expect(method(repository, 'createHandoff')).toMatch(
        /approvalRequiredAtCreation: false,\s*approvalReviewId: null,\s*approvalSequence: null,\s*approvalContentHash: null,/
      );
      expect(method(repository, 'createHandoffWhileApproved')).toMatch(
        /approvalRequiredAtCreation: true,\s*approvalReviewId: input\.reviewId,\s*approvalSequence: authorizing\.sequence,\s*approvalContentHash: authorizing\.targetContentHash,/
      );
      // nothing outside the handoff repository writes them (the pure
      // classifier only reads them into what it returns), and the service
      // never names one: it reads them through that classifier
      expect(
        users(
          /approvalSequence:|approvalContentHash:|approvalRequiredAtCreation:/
        )
      ).toEqual([REVIEW_APPROVAL, HANDOFF_REPOSITORY]);
      expect(CODE.get(REVIEW_APPROVAL)).not.toMatch(
        /prisma|\.create\(|updateMany/i
      );
      expect(CODE.get(HANDOFF_SERVICE)).not.toMatch(fields);
    });

    it('P5S-10/M16 the authorization is read under the same hold as the history it confirms, before the row is written', () => {
      const approved = method(
        CODE.get(HANDOFF_REPOSITORY)!,
        'createHandoffWhileApproved'
      );
      const order = [
        'contentStudioReview.findFirst(',
        'contentStudioReview.updateMany(',
        'contentStudioApproval.count(',
        'contentStudioApproval.findFirst(',
        'contentStudioHandoff.create(',
      ].map((call) => approved.indexOf(call));
      expect(order.every((at) => at > -1)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(approved).toMatch(/\$transaction\(async \(tx\) =>/);
      expect(approved).not.toMatch(/this\._handoff\./);
    });

    it('P5S-11 the snapshot is a record of the past, not a second approval truth: no approved flag or current state anywhere', () => {
      const handoff = model('ContentStudioHandoff');
      expect(handoff).not.toMatch(
        /\b(approved|currentApprovalState|approvalState|isApproved)\b/
      );
      for (const name of P5_MODELS) {
        expect(model(name)).not.toMatch(
          /\n\s+(approved|approvalState|currentApproval\w*|isApproved|approvedAt|approvedById)\s/
        );
      }
      // the one approval relation of a handoff is its review, inside the
      // organization
      expect(handoff).toMatch(
        /approvalReview\s+ContentStudioReview\?\s+@relation\(fields: \[approvalReviewId, organizationId\], references: \[id, organizationId\], onDelete: Restrict, onUpdate: Restrict\)/
      );
    });

    it('P5S-12/M25 opening checks only what authorized it, never the approval of now; revoking reads no approval', () => {
      const service = CODE.get(HANDOFF_SERVICE)!;
      const open = method(service, 'resolveHandoff');
      const revoke = method(service, 'revokeHandoff');
      expect(open).not.toMatch(
        /requireApprovedRevision|isApprovalRequiredForHandoff/
      );
      expect(revoke).not.toMatch(/approv/i);
      expect(service.match(/_contentStudioReviewService\.\w+/g)).toEqual([
        '_contentStudioReviewService.requireApprovedRevision',
        '_contentStudioReviewService.requireApprovedRevision',
        '_contentStudioReviewService.verifyHandoffApprovalAuthorization',
      ]);
      // the historical check reads the review and its history, never the
      // predicate of now
      const verify = method(
        CODE.get(REVIEW_SERVICE)!,
        'verifyHandoffApprovalAuthorization'
      );
      expect(verify).not.toMatch(
        /getRevisionApprovalStatus|requireApprovedRevision|revisionApprovalStatuses|approvalBindings|policy/i
      );
      expect(verify).toMatch(/this\.approvalHistory\(/);
    });
  });

  describe('where approval is enforced, and where never', () => {
    it('P5S-13 requireApprovedRevision: the review service has it, the handoff service is its one caller', () => {
      expect(users(/requireApprovedRevision/)).toEqual([
        HANDOFF_SERVICE,
        REVIEW_SERVICE,
      ]);
      expect(users(/verifyHandoffApprovalAuthorization/)).toEqual([
        HANDOFF_SERVICE,
        REVIEW_SERVICE,
      ]);
    });

    it('P5S-14 the approval policy and its refusal live in exactly the intended Content Studio modules', () => {
      // the policy and its setting; the editor only hears from the server
      // whether a revision needs approval (handoffApprovalRequired)
      // activation flow 01: the getting-started list only reads whether
      // approval is on, to tick its task
      expect(users(/requireApprovalForHandoff/)).toEqual([
        `${FE}/content-studio.onboarding.tsx`,
        `${FE}/intelligence/content-studio.editorial-policy.tsx`,
        POLICY,
      ]);
      expect(CODE.get(`${FE}/content-studio.workspace.tsx`)).not.toMatch(
        /editorial-policy|EditorialPolicy/
      );
      expect(users(/isApprovalRequiredForHandoff\(/)).toEqual(
        [POLICY_SERVICE, HANDOFF_SERVICE, STUDIO_SERVICE].sort()
      );
      // the first post (activation flow 01) says so the same way
      expect(users(/CS_APPROVAL_REQUIRED/)).toEqual(
        [
          REVIEW_SERVICE,
          `${FE}/content-studio.first-post.tsx`,
          `${FE}/content-studio.workspace.tsx`,
        ].sort()
      );
    });

    it('P5S-15/M18 general Postiz posting, scheduling, publishing and the composer never ask Content Studio approval', () => {
      const general = PRODUCTION.filter(
        (file) =>
          file.startsWith('apps/orchestrator/') ||
          file.startsWith(`${LIB}/database/prisma/posts/`) ||
          file.startsWith(`${LIB}/integrations/`) ||
          file.startsWith('apps/frontend/src/components/new-launch/') ||
          file.startsWith('apps/frontend/src/components/launches/') ||
          file.startsWith('apps/backend/src/public-api/') ||
          file === 'apps/backend/src/api/routes/posts.controller.ts'
      );
      expect(general.length).toBeGreaterThan(50);
      for (const file of general) {
        expect([
          file,
          CODE.get(file)!.match(
            /requireApproved|ContentStudioApproval|contentStudioApproval|CS_APPROVAL|requireApprovalForHandoff|isApprovalRequiredForHandoff|ContentStudioReviewService|approvalAuthorization|verifyHandoffApproval/
          ),
        ]).toEqual([file, null]);
      }
    });

    it('P5S-16/M19 no approval cache: the handoff and the review keep nothing of the approval of now', () => {
      for (const file of [
        HANDOFF_SERVICE,
        HANDOFF_REPOSITORY,
        REVIEW_SERVICE,
      ]) {
        expect(CODE.get(file)).not.toMatch(
          /redis|cacheManager|memoize|\bttl:/i
        );
      }
      expect(CODE.get(HANDOFF_SERVICE)).not.toMatch(/new Map|static /);
    });
  });

  describe('what a client never decides', () => {
    const REVISION_UUID = '3b241101-e2bb-4255-8caf-4136c566a962';
    const TRUSTED =
      /^\s+(organizationId|userId|actorUserId|requestedById|requestedByUserId|reviewedByUserId|resolvedByUserId|authorUserId|targetContentHash|claimContentHash|contentHash|resolvedByContentHash|sequence|decision|version|approval\w*|requireApproval\w*|bypass|force|override|skipApproval)\??!?:/m;

    it('P5S-17 no Content Studio DTO has a trusted field', () => {
      const dtos = PRODUCTION.filter((file) =>
        file.startsWith(`${LIB}/dtos/content-studio/`)
      );
      expect(dtos.length).toBeGreaterThan(10);
      for (const file of dtos) {
        expect([file, CODE.get(file)!.match(TRUSTED)?.[0] ?? null]).toEqual([
          file,
          null,
        ]);
      }
    });

    it('P5S-18 every Content Studio route takes the organization and the user from the request, never from the body', () => {
      const controller = CODE.get(CONTROLLER)!;
      expect(
        controller.match(/organizationId: (?!org\.id\b)[^,\n]+/g)
      ).toBeNull();
      expect(controller.match(/\buserId: (?!user\.id\b)[^,\n]+/g)).toBeNull();
      // the strict pipe: an extra field is refused, never ignored
      expect(controller).toMatch(
        /whitelist: true,\s*forbidNonWhitelisted: true,/
      );
      expect(controller).toMatch(/@UsePipes\(contentStudioValidationPipe\)/);
    });

    it.each([
      [
        CreateContentStudioReviewDto,
        { targetType: 'PACKAGE_REVISION', targetRevisionId: REVISION_UUID },
      ],
      [RequestContentStudioReviewChangesDto, { body: 'Change it.' }],
      [CreateContentStudioReviewCommentDto, { body: 'A comment.' }],
      [UpdateContentStudioReviewCommentDto, { body: 'An edit.' }],
      [UpdateContentStudioReviewClaimDto, { status: 'VERIFIED' }],
      [
        ResolveContentStudioReviewRevisionRequestDto,
        { resolutionRevisionId: REVISION_UUID },
      ],
      [ApproveContentStudioReviewDto, {}],
      [RefuseContentStudioReviewDto, { note: 'No.' }],
      [WithdrawContentStudioReviewApprovalDto, { note: 'Too early.' }],
    ] as [new () => object, Record<string, unknown>][])(
      'P5S-19 %p refuses every server field a client might add',
      async (metatype, valid) => {
        const pipe = new ValidationPipe({
          transform: true,
          whitelist: true,
          forbidNonWhitelisted: true,
        });
        await expect(
          pipe.transform(valid, { type: 'body', metatype })
        ).resolves.toBeDefined();
        for (const field of [
          'organizationId',
          'actorUserId',
          'targetContentHash',
          'claimContentHash',
          'sequence',
          'decision',
          'state',
          'approvalSequence',
          'approvalRequiredAtCreation',
          'requireApproval',
        ]) {
          await expect(
            pipe.transform(
              { ...valid, [field]: 'forged' },
              { type: 'body', metatype }
            )
          ).rejects.toMatchObject({
            response: {
              message: expect.arrayContaining([
                `property ${field} should not exist`,
              ]),
            },
          });
        }
      }
    );

    it('P5S-20 the handoff route reads no body, query or header: no bypass can be sent', () => {
      const controller = CODE.get(CONTROLLER)!;
      const route = controller.slice(
        controller.indexOf(
          "@Post('/packages/:id/revisions/:revisionId/handoffs')"
        ),
        controller.indexOf("@Get('/handoffs/:handoffId')")
      );
      expect(route).not.toMatch(/@Body|@Query|@Headers|@Req\(/);
      for (const file of [HANDOFF_SERVICE, HANDOFF_REPOSITORY, CONTROLLER]) {
        expect(CODE.get(file)).not.toMatch(
          /bypass|skipApproval|forceHandoff|override|emergency/i
        );
      }
    });
  });

  describe('errors', () => {
    const httpErrors = (file: string) =>
      [
        ...CODE.get(file)!.matchAll(/new HttpException\(\s*\{([\s\S]*?)\}/g),
      ].map((match) => match[1]);

    it('P5S-21 every Phase 5 error is a fixed message and code: no template, id, hash or Prisma text', () => {
      for (const file of [REVIEW_SERVICE, HANDOFF_SERVICE]) {
        const errors = httpErrors(file);
        expect(errors.length).toBeGreaterThan(5);
        for (const body of errors) {
          expect(body).toMatch(/msg: '[^'`$]+',/);
          expect(body).toMatch(/code: 'CS_[A-Z_]+'/);
          // positions and reasons only, for unavailable Media
          expect(body).not.toMatch(/`|\$\{|\.message|organizationId|Id\b/);
        }
      }
      // the logs name a row id at most, never content or a hash
      for (const file of [REVIEW_SERVICE, HANDOFF_SERVICE]) {
        for (const [log] of CODE.get(file)!.matchAll(
          /this\._logger\.error\(\s*`[^`]*`/g
        )) {
          expect(log).not.toMatch(/Hash|content\b|body|note|finding|text/);
        }
      }
    });

    it('P5S-22 corruption and the normal lifecycle are different codes, never mapped onto each other', () => {
      const codes = (file: string) =>
        new Set(
          httpErrors(file).map((body) => body.match(/code: '(CS_[A-Z_]+)'/)![1])
        );
      const review = codes(REVIEW_SERVICE);
      for (const lifecycle of [
        'CS_APPROVAL_REQUIRED',
        'CS_APPROVAL_UNAVAILABLE',
        'CS_REVIEW_CLAIMS_INCOMPLETE',
        'CS_REVIEW_CONFLICT',
        'CS_APPROVAL_CONFLICT',
      ]) {
        expect(review).toContain(lifecycle);
      }
      for (const corruption of [
        'CS_REVIEW_INTEGRITY_ERROR',
        'CS_APPROVAL_INTEGRITY_ERROR',
      ]) {
        expect(review).toContain(corruption);
      }
      expect(codes(HANDOFF_SERVICE)).toContain('CS_STORED_HANDOFF_INVALID');
      // integrity errors are 500s; the lifecycle ones are not
      const source = CODE.get(REVIEW_SERVICE)!;
      for (const [name, status] of [
        ['integrityError', '500'],
        ['approvalIntegrityError', '500'],
        ['approvalRequired', '409'],
      ]) {
        const at = source.indexOf(`const ${name} = () =>`);
        expect(at).toBeGreaterThan(-1);
        expect(source.slice(at, source.indexOf(');', at))).toMatch(
          new RegExp(`\\}\\s*,\\s*${status}\\s*$`)
        );
      }
      // the handoff never turns an integrity error into "approval required"
      expect(CODE.get(HANDOFF_SERVICE)).not.toMatch(
        /catch[\s\S]{0,200}approvalRequired/
      );
    });
  });

  describe('the final Phase 5 shape', () => {
    it('P5S-23 a review is about one exact revision, has no APPROVED state, and is no approval', () => {
      expect(CONTENT_STUDIO_REVIEW_STATES).toEqual([
        'REQUESTED',
        'IN_REVIEW',
        'CHANGES_REQUESTED',
        'READY_FOR_APPROVAL',
        'CANCELLED',
      ]);
      expect(CONTENT_STUDIO_APPROVAL_DECISIONS).toEqual([
        'APPROVED',
        'REFUSED',
        'WITHDRAWN',
      ]);
      const review = model('ContentStudioReview');
      expect(review).toMatch(
        /@@unique\(\[organizationId, packageRevisionId\]\)/
      );
      expect(review).toMatch(
        /@@unique\(\[organizationId, designRevisionId\]\)/
      );
      expect(review).not.toMatch(/packageId|designProjectId|latest/);
    });

    it("P5S-24 claims are the package revision's own grounding: review never depends on an AI operation", () => {
      for (const file of [REVIEW_SERVICE, REVIEW_REPOSITORY, REVIEW_CLAIM]) {
        expect(CODE.get(file)).not.toMatch(
          /aiOperation|AIOperation|ai-operation/
        );
      }
      expect(CODE.get(REVIEW_SERVICE)).toMatch(
        /getReviewableClaimsFromContentPackageRevision\(revision\)/
      );
    });

    it('P5S-25 the queue only reads', () => {
      const service = CODE.get(REVIEW_SERVICE)!;
      const queue = service.slice(
        service.indexOf('async listReviews('),
        service.indexOf('async requestReview(')
      );
      expect(queue.length).toBeGreaterThan(1000);
      expect(
        queue.match(/_contentStudioReviewRepository\.\w+/g)?.length
      ).toBeGreaterThan(5);
      expect(queue).not.toMatch(
        /_contentStudioReviewRepository\.(create|transition|append|set|resolve|edit)\w*\(/
      );
      expect(
        fs.readFileSync(
          path.join(REPO_ROOT, `${FE}/content-studio.review.queue.tsx`),
          'utf8'
        )
      ).not.toMatch(
        /approve\(|refuse\(|withdraw\(|createHandoff|method: 'POST'/
      );
    });

    it('P5S-26 the binding is exact: no hash match, no latest, no carry-over', () => {
      const repository = CODE.get(REVIEW_REPOSITORY)!;
      expect(repository).not.toMatch(/where: \{[^}]*contentHash/);
      expect(repository).not.toMatch(/orderBy: \{\s*revisionNumber: 'desc'/);
    });

    it('P5S-27 one approval policy flag, and only one', () => {
      const policy = CODE.get(POLICY)!;
      const workflow = policy.slice(
        policy.indexOf('const workflowSchema'),
        policy.indexOf('.strict();', policy.indexOf('const workflowSchema'))
      );
      expect(workflow.match(/\w+: z\./g)).toEqual([
        'requireApprovalForHandoff: z.',
      ]);
    });
  });

  describe('the approval policy (AHO1)', () => {
    const parse = (content: Record<string, unknown>) =>
      parseContentStudioEditorialPolicyContent({
        ...emptyContentStudioEditorialPolicyContent(),
        ...content,
      });

    it('AHO1 missing is off, off is written as nothing, on is explicit', () => {
      const missing = parse({});
      const off = parse({ workflow: { requireApprovalForHandoff: false } });
      const on = parse({ workflow: { requireApprovalForHandoff: true } });
      expect(isContentStudioApprovalRequiredForHandoff(missing)).toBe(false);
      expect(isContentStudioApprovalRequiredForHandoff(off)).toBe(false);
      expect(isContentStudioApprovalRequiredForHandoff(on)).toBe(true);
      expect(isContentStudioApprovalRequiredForHandoff(null)).toBe(false);
      expect(canonicalJson(off)).toBe(canonicalJson(missing));
      expect(off).not.toHaveProperty('workflow');
      expect(on.workflow).toEqual({ requireApprovalForHandoff: true });
    });

    it.each([
      [{ requireApprovalForHandoff: true }],
      [{ workflow: { requireApprovalForHandoff: 'yes' } }],
      [{ workflow: { requireApprovalForHandoff: true, bypass: true } }],
      [{ workflow: { requireApprovalForHandoff: true, roles: ['admin'] } }],
      [{ workflow: { requireApprovalForPublishing: true } }],
      [{ workflow: {} }],
    ])('AHO1 the strict parser refuses %p', (content) => {
      expect(() => parse(content)).toThrow();
    });
  });
});
