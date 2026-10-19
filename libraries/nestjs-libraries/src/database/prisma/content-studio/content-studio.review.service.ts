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
  ContentStudioReviewAction,
  ContentStudioReviewState,
  ContentStudioReviewTargetType,
  ContentStudioReviewTransitionError,
  isContentStudioReviewHistoryIntact,
  isContentStudioReviewState,
  isContentStudioReviewTargetType,
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
const integrityError = () =>
  new HttpException(
    {
      msg: 'Stored review data could not be read safely.',
      code: 'CS_REVIEW_INTEGRITY_ERROR',
    },
    500
  );

// A second review of the same revision: the unique target refuses it
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
  packageRevision: TargetRevision | null;
  designRevision: TargetRevision | null;
  stateEvents: {
    sequence: number;
    fromState: string | null;
    toState: string;
    createdAt: Date;
    actorUser: Person;
  }[];
}

// The exact revision a review is about, as the stored row binds it
interface ReviewTarget {
  targetType: ContentStudioReviewTargetType;
  revisionId: string;
}

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
// design, a render, Media or AI
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
    const contentHash = await this.verifiedTargetHash(
      input.organizationId,
      target
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

  // One step of the state machine, by the request user. The target must
  // still be the revision with the hash the review was requested for; a
  // concurrent change wins or loses as a whole
  async transitionReview(input: {
    organizationId: string;
    userId: string;
    id: string;
    action: ContentStudioReviewAction;
  }) {
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
    const contentHash = await this.verifiedTargetHash(
      input.organizationId,
      {
        targetType: review.targetType,
        revisionId: review.targetRevisionId,
      },
      true
    );
    if (contentHash !== review.targetContentHash) {
      this._logger.error(`Content Studio review target changed: ${review.id}`);
      throw integrityError();
    }
    const transitioned =
      await this._contentStudioReviewRepository.transitionReviewWithCompareAndSwap(
        {
          organizationId: input.organizationId,
          reviewId: review.id,
          expectedState: review.state,
          expectedVersion: review.version,
          toState,
          actorUserId: input.userId,
        }
      );
    if (!transitioned) {
      throw conflict();
    }
    return this.reviewDetail(await this.getRow(input.organizationId, row.id));
  }

  // The stored hash of the exact revision of the organization, after proving
  // the revision is still exactly what was written. A missing or foreign
  // revision is a 404 when a review is requested; once a review exists, its
  // revision must be there
  private async verifiedTargetHash(
    organizationId: string,
    target: ReviewTarget,
    reviewed = false
  ) {
    const missing = reviewed ? integrityError : targetNotFound;
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
    return revision.contentHash;
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
