import { HttpException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  ContentStudioReviewRepository,
  ContentStudioReviewTargetFilter,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.review.repository';
import {
  ContentPackageRevisionIntegrityError,
  parseVerifiedContentPackageRevision,
} from '@gitroom/nestjs-libraries/content-studio/content.package.revision';
import {
  ContentStudioDesignIntegrityError,
  parseVerifiedContentStudioDesignRevision,
} from '@gitroom/nestjs-libraries/content-studio/design/design.document.revision';
import {
  CONTENT_STUDIO_REVIEW_COMMENT_MAX,
  CONTENT_STUDIO_REVISION_REQUEST_MAX,
  ContentStudioReviewAction,
  ContentStudioReviewState,
  ContentStudioReviewTargetType,
  ContentStudioReviewTransitionError,
  isContentStudioReviewDiscussionOpen,
  isContentStudioReviewHistoryIntact,
  isContentStudioReviewState,
  isContentStudioReviewTargetType,
  isContentStudioReviewText,
  isContentStudioRevisionRequestStatus,
  transitionContentStudioReviewState,
} from '@gitroom/nestjs-libraries/content-studio/review/review.state';

// Fixed messages only: never ids, hashes, states of another request, content
// or Prisma errors. A review or a revision of another organization is a
// plain 404, exactly like a missing one
const notFound = () =>
  new HttpException({ msg: 'Review not found.', code: 'CS_NOT_FOUND' }, 404);
const targetNotFound = () =>
  new HttpException(
    {
      msg: 'The revision to review was not found.',
      code: 'CS_REVIEW_TARGET_NOT_FOUND',
    },
    404
  );
const invalidRequest = () =>
  new HttpException(
    {
      msg: 'The Content Studio request is invalid',
      code: 'CS_INVALID_REQUEST',
    },
    400
  );
const alreadyExists = () =>
  new HttpException(
    {
      msg: 'This revision already has a review.',
      code: 'CS_REVIEW_ALREADY_EXISTS',
    },
    409
  );
const invalidTransition = () =>
  new HttpException(
    {
      msg: 'This review cannot make that change in its current state.',
      code: 'CS_REVIEW_INVALID_TRANSITION',
    },
    409
  );
const conflict = () =>
  new HttpException(
    {
      msg: 'This review was changed by someone else.',
      code: 'CS_REVIEW_CONFLICT',
    },
    409
  );
const reviewCancelled = () =>
  new HttpException(
    {
      msg: 'This review was cancelled: its discussion is closed.',
      code: 'CS_REVIEW_CANCELLED',
    },
    409
  );
const commentInvalid = () =>
  new HttpException(
    {
      msg: 'A comment needs text and must stay within its length limit.',
      code: 'CS_REVIEW_COMMENT_INVALID',
    },
    400
  );
const commentNotFound = () =>
  new HttpException(
    { msg: 'Comment not found.', code: 'CS_REVIEW_COMMENT_NOT_FOUND' },
    404
  );
const commentForbidden = () =>
  new HttpException(
    {
      msg: 'Only its author can edit a comment.',
      code: 'CS_REVIEW_COMMENT_FORBIDDEN',
    },
    403
  );
const revisionRequestInvalid = () =>
  new HttpException(
    {
      msg: 'Requesting changes needs a description of what must change, within its length limit.',
      code: 'CS_REVIEW_REVISION_REQUEST_INVALID',
    },
    400
  );
const revisionRequestNotFound = () =>
  new HttpException(
    {
      msg: 'This review has no revision request.',
      code: 'CS_REVIEW_REVISION_REQUEST_NOT_FOUND',
    },
    404
  );
const revisionRequestExists = () =>
  new HttpException(
    {
      msg: 'This review already has a revision request.',
      code: 'CS_REVIEW_REVISION_REQUEST_ALREADY_EXISTS',
    },
    409
  );
const invalidResolution = () =>
  new HttpException(
    {
      msg: 'A revision request is resolved by a newer saved revision of the same package or design.',
      code: 'CS_REVIEW_REVISION_REQUEST_INVALID_RESOLUTION',
    },
    400
  );
const revisionRequestConflict = () =>
  new HttpException(
    {
      msg: 'This revision request was already resolved.',
      code: 'CS_REVIEW_REVISION_REQUEST_CONFLICT',
    },
    409
  );
const integrityError = () =>
  new HttpException(
    {
      msg: 'Stored review data could not be read safely.',
      code: 'CS_REVIEW_INTEGRITY_ERROR',
    },
    500
  );

// A second review of the same revision, or a second revision request of the
// same review: the unique constraint refuses it
const isUniqueConstraintError = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// Review and revision ids are Prisma uuid() values; anything else cannot exist
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// the same page size as the other Creative Studio lists
const PAGE_SIZE = 50;

interface Person {
  id: string;
  name: string | null;
}

interface TargetRevision {
  id: string;
  revisionNumber: number;
  contentHash: string;
}

interface PackageRevisionRef extends TargetRevision {
  packageId: string;
}

interface DesignRevisionRef extends TargetRevision {
  designProjectId: string;
}

interface ReviewRow {
  id: string;
  packageRevisionId: string | null;
  designRevisionId: string | null;
  targetContentHash: string;
  state: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  requestedBy: Person;
  packageRevision: PackageRevisionRef | null;
  designRevision: DesignRevisionRef | null;
  stateEvents: {
    sequence: number;
    fromState: string | null;
    toState: string;
    createdAt: Date;
    actorUser: Person;
  }[];
}

interface CommentRow {
  id: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  author: Person;
}

interface RevisionRequestRow {
  id: string;
  body: string;
  status: string;
  createdAt: Date;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
  resolvedByPackageRevisionId: string | null;
  resolvedByDesignRevisionId: string | null;
  resolvedByContentHash: string | null;
  requestedBy: Person;
  resolvedBy: Person | null;
  resolvedByPackageRevision: PackageRevisionRef | null;
  resolvedByDesignRevision: DesignRevisionRef | null;
}

// The exact revision a review is about, as the stored row binds it
interface ReviewTarget {
  targetType: ContentStudioReviewTargetType;
  revisionId: string;
}

// A revision with the package or design it belongs to, by one name
interface ParentedRevision extends TargetRevision {
  parentId: string;
}
const parented = (
  revision: PackageRevisionRef | DesignRevisionRef
): ParentedRevision => ({
  id: revision.id,
  revisionNumber: revision.revisionNumber,
  contentHash: revision.contentHash,
  parentId:
    'packageId' in revision ? revision.packageId : revision.designProjectId,
});

// Reviews (P5-01): the workflow of looking at exactly one immutable revision,
// a Content Package revision or a Design revision, before the approval stage.
// The target is the revision id the request names, resolved inside the
// organization, and the hash the server reads from that revision; a review
// never follows a newer revision, and a newer revision has no review until
// one is requested for it. At most one review per revision. Every member may
// request a review and move it on: no role, reviewer, plan or billing check.
// The states and their transitions are review.state.ts; every change of
// state appends its event in the same transaction, only from the state and
// version it was read at. A review is not an approval: READY_FOR_APPROVAL
// gates no handoff and no publishing, and nothing here touches a package, a
// design, a render, Media or AI.
//
// The discussion (P5-02) belongs to the review, and so to its exact
// revision: flat plain-text comments, each edited by its author only and
// never deleted, and the one formal revision request that IN_REVIEW ->
// CHANGES_REQUESTED always writes in the same transaction. The request is
// resolved by naming an exact newer saved revision of the same package or
// design; the server finds it inside the organization, verifies it and keeps
// its stored hash. The review stays CHANGES_REQUESTED and the resolving
// revision gets no review of its own until one is requested. A cancelled
// review is frozen. No comment changes a state
@Injectable()
export class ContentStudioReviewService {
  private readonly _logger = new Logger(ContentStudioReviewService.name);

  constructor(
    private _contentStudioReviewRepository: ContentStudioReviewRepository
  ) {}

  // One page of the organization's reviews, newest first. The revision id
  // only narrows the list together with its target type
  async listReviews(input: {
    organizationId: string;
    targetType?: string;
    targetRevisionId?: string;
    state?: string;
    page: number;
  }) {
    if (
      (input.targetType !== undefined &&
        !isContentStudioReviewTargetType(input.targetType)) ||
      (input.targetRevisionId !== undefined &&
        (input.targetType === undefined ||
          !UUID.test(input.targetRevisionId))) ||
      (input.state !== undefined && !isContentStudioReviewState(input.state))
    ) {
      throw invalidRequest();
    }
    const target: ContentStudioReviewTargetFilter =
      input.targetType === undefined
        ? {}
        : {
            [input.targetType === 'PACKAGE_REVISION'
              ? 'packageRevisionId'
              : 'designRevisionId']: input.targetRevisionId ?? { not: null },
          };
    const filter = {
      organizationId: input.organizationId,
      target,
      state: input.state,
    };
    const [rows, count] = await Promise.all([
      this._contentStudioReviewRepository.listReviewsForOrganization({
        ...filter,
        skip: (input.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this._contentStudioReviewRepository.countReviewsForOrganization(filter),
    ]);
    return {
      pages: Math.ceil(count / PAGE_SIZE),
      results: rows.map((row) => this.reviewDetail(row)),
    };
  }

  // A review in REQUESTED of exactly that revision of the organization, with
  // the hash the revision has stored (never one from the request). The
  // revision must still be exactly what was stored
  async requestReview(input: {
    organizationId: string;
    userId: string;
    targetType: unknown;
    targetRevisionId: unknown;
  }) {
    if (
      !isContentStudioReviewTargetType(input.targetType) ||
      typeof input.targetRevisionId !== 'string'
    ) {
      throw invalidRequest();
    }
    const target = {
      targetType: input.targetType,
      revisionId: input.targetRevisionId,
    };
    const { contentHash } = await this.verifiedRevision(
      input.organizationId,
      target,
      targetNotFound
    );
    const id = randomUUID();
    try {
      await this._contentStudioReviewRepository.createReview({
        id,
        organizationId: input.organizationId,
        packageRevisionId:
          target.targetType === 'PACKAGE_REVISION' ? target.revisionId : null,
        designRevisionId:
          target.targetType === 'DESIGN_REVISION' ? target.revisionId : null,
        targetContentHash: contentHash,
        requestedById: input.userId,
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw alreadyExists();
      }
      throw err;
    }
    return this.reviewDetail(await this.getRow(input.organizationId, id));
  }

  // One step of the state machine, by the request user, other than request
  // changes: that one always comes with its revision request
  // (requestChanges)
  async transitionReview(input: {
    organizationId: string;
    userId: string;
    id: string;
    action: ContentStudioReviewAction;
  }) {
    if (input.action === 'request-changes') {
      throw revisionRequestInvalid();
    }
    return this.changeState(input);
  }

  // IN_REVIEW -> CHANGES_REQUESTED and the formal revision request that says
  // what must change, by the request user: both or neither
  async requestChanges(input: {
    organizationId: string;
    userId: string;
    id: string;
    body: unknown;
  }) {
    if (
      !isContentStudioReviewText(
        input.body,
        CONTENT_STUDIO_REVISION_REQUEST_MAX
      )
    ) {
      throw revisionRequestInvalid();
    }
    return this.changeState(
      {
        organizationId: input.organizationId,
        userId: input.userId,
        id: input.id,
        action: 'request-changes',
      },
      input.body
    );
  }

  // The target must still be the revision with the hash the review was
  // requested for; a concurrent change wins or loses as a whole
  private async changeState(
    input: {
      organizationId: string;
      userId: string;
      id: string;
      action: ContentStudioReviewAction;
    },
    revisionRequestBody?: string
  ) {
    const row = await this.getRow(input.organizationId, input.id);
    const review = this.reviewDetail(row);
    let toState: ContentStudioReviewState;
    try {
      toState = transitionContentStudioReviewState(review.state, input.action);
    } catch (err) {
      if (err instanceof ContentStudioReviewTransitionError) {
        throw invalidTransition();
      }
      throw err;
    }
    await this.verifiedReviewedRevision(input.organizationId, review);
    let transitioned: boolean;
    try {
      transitioned =
        await this._contentStudioReviewRepository.transitionReviewWithCompareAndSwap(
          {
            organizationId: input.organizationId,
            reviewId: review.id,
            expectedState: review.state,
            expectedVersion: review.version,
            toState,
            actorUserId: input.userId,
            revisionRequest:
              revisionRequestBody === undefined
                ? undefined
                : { id: randomUUID(), body: revisionRequestBody },
          }
        );
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw revisionRequestExists();
      }
      throw err;
    }
    if (!transitioned) {
      throw conflict();
    }
    return this.reviewDetail(await this.getRow(input.organizationId, row.id));
  }

  // --- the discussion (P5-02) ---

  // One page of the review's comments, oldest first
  async listComments(input: {
    organizationId: string;
    reviewId: string;
    page: number;
  }) {
    const review = this.reviewDetail(
      await this.getRow(input.organizationId, input.reviewId)
    );
    const filter = {
      organizationId: input.organizationId,
      reviewId: review.id,
    };
    const [rows, count] = await Promise.all([
      this._contentStudioReviewRepository.listCommentsForReview({
        ...filter,
        skip: (input.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this._contentStudioReviewRepository.countCommentsForReview(filter),
    ]);
    return {
      pages: Math.ceil(count / PAGE_SIZE),
      results: rows.map((row) => this.commentDetail(row)),
    };
  }

  // A comment by the request user on a review that is not cancelled. It
  // never changes the review's state
  async addComment(input: {
    organizationId: string;
    userId: string;
    reviewId: string;
    body: unknown;
  }) {
    if (
      !isContentStudioReviewText(input.body, CONTENT_STUDIO_REVIEW_COMMENT_MAX)
    ) {
      throw commentInvalid();
    }
    const review = this.reviewDetail(
      await this.getRow(input.organizationId, input.reviewId)
    );
    if (!isContentStudioReviewDiscussionOpen(review.state)) {
      throw reviewCancelled();
    }
    const id = randomUUID();
    const created = await this._contentStudioReviewRepository.createComment({
      id,
      organizationId: input.organizationId,
      reviewId: review.id,
      authorUserId: input.userId,
      body: input.body,
    });
    if (!created) {
      throw reviewCancelled();
    }
    return this.commentDetail(
      await this.getCommentRow(input.organizationId, review.id, id)
    );
  }

  // Only the author edits a comment, and only while the review is not
  // cancelled: another member reads it but cannot change it
  async editComment(input: {
    organizationId: string;
    userId: string;
    reviewId: string;
    commentId: string;
    body: unknown;
  }) {
    if (
      !isContentStudioReviewText(input.body, CONTENT_STUDIO_REVIEW_COMMENT_MAX)
    ) {
      throw commentInvalid();
    }
    const review = this.reviewDetail(
      await this.getRow(input.organizationId, input.reviewId)
    );
    const comment = await this.getCommentRow(
      input.organizationId,
      review.id,
      input.commentId
    );
    if (comment.author.id !== input.userId) {
      throw commentForbidden();
    }
    if (!isContentStudioReviewDiscussionOpen(review.state)) {
      throw reviewCancelled();
    }
    const edited =
      await this._contentStudioReviewRepository.editCommentOfAuthor({
        organizationId: input.organizationId,
        reviewId: review.id,
        id: comment.id,
        authorUserId: input.userId,
        body: input.body,
        editedAt: new Date(),
      });
    if (!edited) {
      throw reviewCancelled();
    }
    return this.commentDetail(
      await this.getCommentRow(input.organizationId, review.id, comment.id)
    );
  }

  async getRevisionRequest(input: {
    organizationId: string;
    reviewId: string;
  }) {
    const row = await this.getRow(input.organizationId, input.reviewId);
    // a malformed review fails closed before its request is looked for
    this.reviewDetail(row);
    const request = await this.getRevisionRequestRow(input.organizationId, row);
    return this.revisionRequestDetail(request, row);
  }

  // OPEN -> RESOLVED by the request user, naming the exact newer saved
  // revision that made the changes: of the same package (package review) or
  // the same design (design review), found inside the organization by its
  // id alone (the type follows from the review), still exactly what was
  // stored. Its hash is the one it has stored, never one from the request.
  // The review itself does not change, and the resolving revision is not
  // reviewed by this
  async resolveRevisionRequest(input: {
    organizationId: string;
    userId: string;
    reviewId: string;
    resolutionRevisionId: unknown;
  }) {
    const row = await this.getRow(input.organizationId, input.reviewId);
    const review = this.reviewDetail(row);
    const request = this.revisionRequestDetail(
      await this.getRevisionRequestRow(input.organizationId, row),
      row
    );
    if (request.status !== 'OPEN') {
      throw revisionRequestConflict();
    }
    if (
      typeof input.resolutionRevisionId !== 'string' ||
      !UUID.test(input.resolutionRevisionId)
    ) {
      throw invalidResolution();
    }
    const reviewed = await this.verifiedReviewedRevision(
      input.organizationId,
      review
    );
    const resolution = await this.verifiedRevision(
      input.organizationId,
      {
        targetType: review.targetType,
        revisionId: input.resolutionRevisionId,
      },
      invalidResolution
    );
    if (
      resolution.parentId !== reviewed.parentId ||
      resolution.revisionNumber <= reviewed.revisionNumber
    ) {
      throw invalidResolution();
    }
    const resolved =
      await this._contentStudioReviewRepository.resolveRevisionRequestWithCompareAndSwap(
        {
          organizationId: input.organizationId,
          reviewId: review.id,
          id: request.id,
          resolvedByUserId: input.userId,
          resolvedAt: new Date(),
          resolvedByPackageRevisionId:
            review.targetType === 'PACKAGE_REVISION' ? resolution.id : null,
          resolvedByDesignRevisionId:
            review.targetType === 'DESIGN_REVISION' ? resolution.id : null,
          resolvedByContentHash: resolution.contentHash,
        }
      );
    if (!resolved) {
      throw revisionRequestConflict();
    }
    return this.revisionRequestDetail(
      await this.getRevisionRequestRow(input.organizationId, row),
      row
    );
  }

  // The reviewed revision, re-verified: still exactly what was stored, with
  // the hash the review was requested for
  private async verifiedReviewedRevision(
    organizationId: string,
    review: {
      id: string;
      targetType: ContentStudioReviewTargetType;
      targetRevisionId: string;
      targetContentHash: string;
    }
  ) {
    const revision = await this.verifiedRevision(
      organizationId,
      {
        targetType: review.targetType,
        revisionId: review.targetRevisionId,
      },
      integrityError
    );
    if (revision.contentHash !== review.targetContentHash) {
      this._logger.error(`Content Studio review target changed: ${review.id}`);
      throw integrityError();
    }
    return revision;
  }

  // The exact revision of the organization, with its package or design and
  // its stored hash, after proving the revision is still exactly what was
  // written. What a missing or foreign revision is depends on the caller: a
  // 404 when a review is requested, an invalid resolution when a revision
  // request is resolved; once a review exists, its revision must be there
  private async verifiedRevision(
    organizationId: string,
    target: ReviewTarget,
    missing: () => HttpException
  ): Promise<ParentedRevision> {
    if (!UUID.test(target.revisionId)) {
      throw missing();
    }
    const revision =
      target.targetType === 'PACKAGE_REVISION'
        ? await this._contentStudioReviewRepository.getPackageRevisionForOrganization(
            organizationId,
            target.revisionId
          )
        : await this._contentStudioReviewRepository.getDesignRevisionForOrganization(
            organizationId,
            target.revisionId
          );
    if (!revision || revision.id !== target.revisionId) {
      throw missing();
    }
    try {
      if (target.targetType === 'PACKAGE_REVISION') {
        parseVerifiedContentPackageRevision(revision);
      } else {
        parseVerifiedContentStudioDesignRevision(revision);
      }
    } catch (err) {
      if (
        err instanceof ContentPackageRevisionIntegrityError ||
        err instanceof ContentStudioDesignIntegrityError
      ) {
        this._logger.error(
          `Content Studio review target is invalid: ${revision.id}`
        );
        throw integrityError();
      }
      throw err;
    }
    return parented(revision);
  }

  private async getCommentRow(
    organizationId: string,
    reviewId: string,
    id: string
  ) {
    if (typeof id !== 'string' || !UUID.test(id)) {
      throw commentNotFound();
    }
    const row = await this._contentStudioReviewRepository.getCommentForReview(
      organizationId,
      reviewId,
      id
    );
    if (!row) {
      throw commentNotFound();
    }
    return row;
  }

  private async getRevisionRequestRow(
    organizationId: string,
    review: ReviewRow
  ) {
    const row =
      await this._contentStudioReviewRepository.getRevisionRequestForReview(
        organizationId,
        review.id
      );
    if (!row) {
      throw revisionRequestNotFound();
    }
    return row;
  }

  private async getRow(organizationId: string, id: string) {
    if (typeof id !== 'string' || !UUID.test(id)) {
      throw notFound();
    }
    const row =
      await this._contentStudioReviewRepository.getReviewForOrganization(
        organizationId,
        id
      );
    if (!row) {
      throw notFound();
    }
    return row;
  }

  // Built field by field: no organization leaves. The row must bind exactly
  // one revision, with the hash that revision still has stored, a known
  // state, and a state history that leads to exactly that state and version;
  // anything else is reported, never repaired
  private reviewDetail(row: ReviewRow) {
    const binding = this.binding(row);
    if (
      !binding ||
      !SHA256.test(row.targetContentHash) ||
      binding.revision.contentHash !== row.targetContentHash ||
      !isContentStudioReviewState(row.state) ||
      !isContentStudioReviewHistoryIntact(row, row.stateEvents)
    ) {
      this._logger.error(`Stored Content Studio review is invalid: ${row.id}`);
      throw integrityError();
    }
    return {
      id: row.id,
      targetType: binding.targetType,
      targetRevisionId: binding.revision.id,
      targetRevisionNumber: binding.revision.revisionNumber,
      targetContentHash: row.targetContentHash,
      state: row.state,
      version: row.version,
      requestedBy: { id: row.requestedBy.id, name: row.requestedBy.name },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      events: row.stateEvents.map((event) => ({
        sequence: event.sequence,
        fromState: event.fromState,
        toState: event.toState,
        actor: { id: event.actorUser.id, name: event.actorUser.name },
        createdAt: event.createdAt,
      })),
    };
  }

  // Plain text as stored, its author, and when it was written and last
  // edited: no organization or review id
  private commentDetail(row: CommentRow) {
    if (
      typeof row.body !== 'string' ||
      !row.author ||
      !(row.createdAt instanceof Date) ||
      (row.editedAt !== null && !(row.editedAt instanceof Date))
    ) {
      this._logger.error(
        `Stored Content Studio review comment is invalid: ${row.id}`
      );
      throw integrityError();
    }
    return {
      id: row.id,
      body: row.body,
      author: { id: row.author.id, name: row.author.name },
      createdAt: row.createdAt,
      editedAt: row.editedAt,
    };
  }

  // A revision request only exists for a review that reached
  // CHANGES_REQUESTED. OPEN has no resolution field at all; RESOLVED has
  // every one of them, and they agree: the user and time, exactly the one
  // revision field of the review's target type, that revision through its
  // relation in the organization, of the same package or design as the
  // reviewed revision, newer than it, with the stored hash the request kept.
  // Anything else is reported, never repaired
  private revisionRequestDetail(row: RevisionRequestRow, reviewRow: ReviewRow) {
    const review = this.reviewDetail(reviewRow);
    const reviewed = parented(this.binding(reviewRow)!.revision);
    const open =
      row.status === 'OPEN' &&
      row.resolvedByUserId === null &&
      row.resolvedBy === null &&
      row.resolvedAt === null &&
      row.resolvedByPackageRevisionId === null &&
      row.resolvedByDesignRevisionId === null &&
      row.resolvedByContentHash === null;
    const resolution =
      row.status === 'RESOLVED'
        ? this.resolution(row, review.targetType)
        : null;
    if (
      review.state !== 'CHANGES_REQUESTED' ||
      !isContentStudioRevisionRequestStatus(row.status) ||
      typeof row.body !== 'string' ||
      !(open || resolution) ||
      (resolution &&
        (resolution.revision.parentId !== reviewed.parentId ||
          resolution.revision.revisionNumber <= reviewed.revisionNumber))
    ) {
      this._logger.error(
        `Stored Content Studio revision request is invalid: ${row.id}`
      );
      throw integrityError();
    }
    return {
      id: row.id,
      body: row.body,
      status: row.status,
      requestedBy: { id: row.requestedBy.id, name: row.requestedBy.name },
      createdAt: row.createdAt,
      resolution: resolution && {
        revisionId: resolution.revision.id,
        revisionNumber: resolution.revision.revisionNumber,
        contentHash: resolution.revision.contentHash,
        resolvedBy: {
          id: resolution.resolvedBy.id,
          name: resolution.resolvedBy.name,
        },
        resolvedAt: resolution.resolvedAt,
      },
    };
  }

  // Every resolution field of a RESOLVED request, or null when one is
  // missing or disagrees
  private resolution(
    row: RevisionRequestRow,
    targetType: ContentStudioReviewTargetType
  ) {
    const reference =
      targetType === 'PACKAGE_REVISION'
        ? row.resolvedByDesignRevisionId === null &&
          row.resolvedByPackageRevision?.id === row.resolvedByPackageRevisionId
          ? row.resolvedByPackageRevision
          : null
        : row.resolvedByPackageRevisionId === null &&
          row.resolvedByDesignRevision?.id === row.resolvedByDesignRevisionId
        ? row.resolvedByDesignRevision
        : null;
    if (
      !reference ||
      !row.resolvedBy ||
      row.resolvedByUserId === null ||
      row.resolvedBy.id !== row.resolvedByUserId ||
      !(row.resolvedAt instanceof Date) ||
      row.resolvedByContentHash === null ||
      !SHA256.test(row.resolvedByContentHash) ||
      reference.contentHash !== row.resolvedByContentHash
    ) {
      return null;
    }
    return {
      revision: parented(reference),
      resolvedBy: row.resolvedBy,
      resolvedAt: row.resolvedAt,
    };
  }

  // The target type follows from the one revision the row binds, never from
  // a field of its own
  private binding(row: ReviewRow) {
    if (row.packageRevisionId !== null && row.designRevisionId === null) {
      return row.packageRevision?.id === row.packageRevisionId
        ? {
            targetType: 'PACKAGE_REVISION' as const,
            revision: row.packageRevision,
          }
        : null;
    }
    if (row.designRevisionId !== null && row.packageRevisionId === null) {
      return row.designRevision?.id === row.designRevisionId
        ? {
            targetType: 'DESIGN_REVISION' as const,
            revision: row.designRevision,
          }
        : null;
    }
    return null;
  }
}
