import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const PERSON = {
  select: {
    id: true,
    name: true,
  },
} as const;

// A review with its exact target and its whole state history (a few events
// at most). The target is the revision itself, read through the relation:
// its number, its package or design (to check a resolving revision against,
// P5-02) and its stored hash, never its content
const REVIEW = {
  id: true,
  packageRevisionId: true,
  designRevisionId: true,
  targetContentHash: true,
  state: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  requestedBy: {
    select: {
      id: true,
      name: true,
    },
  },
  packageRevision: {
    select: {
      id: true,
      packageId: true,
      revisionNumber: true,
      contentHash: true,
    },
  },
  designRevision: {
    select: {
      id: true,
      designProjectId: true,
      revisionNumber: true,
      contentHash: true,
    },
  },
  stateEvents: {
    orderBy: {
      sequence: 'asc',
    },
    select: {
      sequence: true,
      fromState: true,
      toState: true,
      createdAt: true,
      actorUser: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  },
} as const;

const TARGET_REVISION = {
  id: true,
  revisionNumber: true,
  schemaVersion: true,
  content: true,
  contentHash: true,
} as const;

// A comment as shown: never its organization or review
const COMMENT = {
  id: true,
  body: true,
  createdAt: true,
  editedAt: true,
  author: PERSON,
} as const;

// The revision request with every resolution field as stored, and the
// resolving revision read through its relation (its number, package or
// design and stored hash, never its content), so the service can check that
// they all agree
const REVISION_REQUEST = {
  id: true,
  body: true,
  status: true,
  createdAt: true,
  resolvedByUserId: true,
  resolvedAt: true,
  resolvedByPackageRevisionId: true,
  resolvedByDesignRevisionId: true,
  resolvedByContentHash: true,
  requestedBy: PERSON,
  resolvedBy: PERSON,
  resolvedByPackageRevision: {
    select: {
      id: true,
      packageId: true,
      revisionNumber: true,
      contentHash: true,
    },
  },
  resolvedByDesignRevision: {
    select: {
      id: true,
      designProjectId: true,
      revisionNumber: true,
      contentHash: true,
    },
  },
} as const;

// Exactly one of the two is set: the service never passes both or neither
export interface ContentStudioReviewTargetFilter {
  packageRevisionId?: string | { not: null };
  designRevisionId?: string | { not: null };
}

// Reviews of an organization: every query filters on organizationId itself,
// so a review, a comment, a revision request or a revision of another
// organization reads exactly like a missing one (null or count 0). A review
// is created with its first state event and changes state only together with
// the next one, in one transaction and only from the state and version it
// was read at; IN_REVIEW -> CHANGES_REQUESTED also writes the revision
// request in that transaction. Its target never changes. Nothing is deleted
@Injectable()
export class ContentStudioReviewRepository {
  constructor(
    private _review: PrismaRepository<'contentStudioReview'>,
    private _packageRevision: PrismaRepository<'contentPackageRevision'>,
    private _designRevision: PrismaRepository<'contentStudioDesignRevision'>,
    private _comment: PrismaRepository<'contentStudioReviewComment'>,
    private _revisionRequest: PrismaRepository<'contentStudioReviewRevisionRequest'>,
    private _transaction: PrismaTransaction
  ) {}

  // The exact package revision, with its content so the service can prove it
  // is still what was stored, and its package
  getPackageRevisionForOrganization(organizationId: string, id: string) {
    return this._packageRevision.model.contentPackageRevision.findFirst({
      where: {
        id,
        organizationId,
      },
      select: {
        ...TARGET_REVISION,
        packageId: true,
      },
    });
  }

  getDesignRevisionForOrganization(organizationId: string, id: string) {
    return this._designRevision.model.contentStudioDesignRevision.findFirst({
      where: {
        id,
        organizationId,
      },
      select: {
        ...TARGET_REVISION,
        designProjectId: true,
      },
    });
  }

  listReviewsForOrganization(input: {
    organizationId: string;
    target: ContentStudioReviewTargetFilter;
    state?: string;
    skip: number;
    take: number;
  }) {
    return this._review.model.contentStudioReview.findMany({
      where: {
        organizationId: input.organizationId,
        ...input.target,
        state: input.state,
      },
      // id breaks ties so pages never overlap
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: REVIEW,
      skip: input.skip,
      take: input.take,
    });
  }

  countReviewsForOrganization(input: {
    organizationId: string;
    target: ContentStudioReviewTargetFilter;
    state?: string;
  }) {
    return this._review.model.contentStudioReview.count({
      where: {
        organizationId: input.organizationId,
        ...input.target,
        state: input.state,
      },
    });
  }

  getReviewForOrganization(organizationId: string, id: string) {
    return this._review.model.contentStudioReview.findFirst({
      where: {
        id,
        organizationId,
      },
      select: REVIEW,
    });
  }

  // The review in REQUESTED at version 1 and its first event, or neither. A
  // second review of the same revision fails on the unique target (P2002)
  createReview(input: {
    id: string;
    organizationId: string;
    packageRevisionId: string | null;
    designRevisionId: string | null;
    targetContentHash: string;
    requestedById: string;
  }) {
    return this._transaction.model.$transaction(async (tx) => {
      await tx.contentStudioReview.create({
        data: {
          id: input.id,
          organizationId: input.organizationId,
          packageRevisionId: input.packageRevisionId,
          designRevisionId: input.designRevisionId,
          targetContentHash: input.targetContentHash,
          state: 'REQUESTED',
          version: 1,
          requestedById: input.requestedById,
        },
        select: { id: true },
      });
      await tx.contentStudioReviewStateEvent.create({
        data: {
          organizationId: input.organizationId,
          reviewId: input.id,
          sequence: 1,
          fromState: null,
          toState: 'REQUESTED',
          actorUserId: input.requestedById,
        },
        select: { id: true },
      });
    });
  }

  // Moves the review from the state and version the service read to the
  // next state and appends that event, in one transaction, together with the
  // revision request when one is given (request changes). The update only
  // matches while both are still current and holds the review row until
  // commit, so of two concurrent transitions exactly one is written; the
  // other changes nothing and gets false. A revision request that cannot be
  // written (a second one for the review: P2002) takes the transition with it
  transitionReviewWithCompareAndSwap(input: {
    organizationId: string;
    reviewId: string;
    expectedState: string;
    expectedVersion: number;
    toState: string;
    actorUserId: string;
    revisionRequest?: { id: string; body: string };
  }) {
    return this._transaction.model.$transaction(async (tx) => {
      const { count } = await tx.contentStudioReview.updateMany({
        where: {
          id: input.reviewId,
          organizationId: input.organizationId,
          state: input.expectedState,
          version: input.expectedVersion,
        },
        data: {
          state: input.toState,
          version: {
            increment: 1,
          },
        },
      });
      if (count !== 1) {
        return false;
      }
      await tx.contentStudioReviewStateEvent.create({
        data: {
          organizationId: input.organizationId,
          reviewId: input.reviewId,
          sequence: input.expectedVersion + 1,
          fromState: input.expectedState,
          toState: input.toState,
          actorUserId: input.actorUserId,
        },
        select: { id: true },
      });
      if (input.revisionRequest) {
        await tx.contentStudioReviewRevisionRequest.create({
          data: {
            id: input.revisionRequest.id,
            organizationId: input.organizationId,
            reviewId: input.reviewId,
            requestedByUserId: input.actorUserId,
            body: input.revisionRequest.body,
            status: 'OPEN',
          },
          select: { id: true },
        });
      }
      return true;
    });
  }

  // --- the discussion (P5-02) ---

  // Oldest first, as a discussion reads; id breaks ties so pages never overlap
  listCommentsForReview(input: {
    organizationId: string;
    reviewId: string;
    skip: number;
    take: number;
  }) {
    return this._comment.model.contentStudioReviewComment.findMany({
      where: {
        organizationId: input.organizationId,
        reviewId: input.reviewId,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: COMMENT,
      skip: input.skip,
      take: input.take,
    });
  }

  countCommentsForReview(input: { organizationId: string; reviewId: string }) {
    return this._comment.model.contentStudioReviewComment.count({
      where: {
        organizationId: input.organizationId,
        reviewId: input.reviewId,
      },
    });
  }

  getCommentForReview(organizationId: string, reviewId: string, id: string) {
    return this._comment.model.contentStudioReviewComment.findFirst({
      where: {
        id,
        organizationId,
        reviewId,
      },
      select: COMMENT,
    });
  }

  // A comment and its edit hold the review row first, in the same
  // transaction, and only while it is not cancelled: a concurrent cancel
  // either comes after (the comment is part of the discussion it froze) or
  // before (nothing is written, false). The hold writes the review's own
  // version back unchanged, so only its updatedAt moves: never its state,
  // version, history or target
  private holdOpenReview(
    tx: Prisma.TransactionClient,
    organizationId: string,
    reviewId: string
  ) {
    return tx.contentStudioReview.updateMany({
      where: {
        id: reviewId,
        organizationId,
        state: { not: 'CANCELLED' },
      },
      data: {
        version: {
          increment: 0,
        },
      },
    });
  }

  createComment(input: {
    id: string;
    organizationId: string;
    reviewId: string;
    authorUserId: string;
    body: string;
  }) {
    return this._transaction.model.$transaction(async (tx) => {
      const { count } = await this.holdOpenReview(
        tx,
        input.organizationId,
        input.reviewId
      );
      if (count !== 1) {
        return false;
      }
      await tx.contentStudioReviewComment.create({
        data: {
          id: input.id,
          organizationId: input.organizationId,
          reviewId: input.reviewId,
          authorUserId: input.authorUserId,
          body: input.body,
        },
        select: { id: true },
      });
      return true;
    });
  }

  // Only the author's own comment matches. The body is replaced and editedAt
  // set; createdAt and the author never change. Two edits of one comment:
  // the later one wins (a comment has no version of its own)
  editCommentOfAuthor(input: {
    organizationId: string;
    reviewId: string;
    id: string;
    authorUserId: string;
    body: string;
    editedAt: Date;
  }) {
    return this._transaction.model.$transaction(async (tx) => {
      const held = await this.holdOpenReview(
        tx,
        input.organizationId,
        input.reviewId
      );
      if (held.count !== 1) {
        return false;
      }
      const { count } = await tx.contentStudioReviewComment.updateMany({
        where: {
          id: input.id,
          organizationId: input.organizationId,
          reviewId: input.reviewId,
          authorUserId: input.authorUserId,
        },
        data: {
          body: input.body,
          editedAt: input.editedAt,
        },
      });
      return count === 1;
    });
  }

  getRevisionRequestForReview(organizationId: string, reviewId: string) {
    return this._revisionRequest.model.contentStudioReviewRevisionRequest.findFirst(
      {
        where: {
          reviewId,
          organizationId,
        },
        select: REVISION_REQUEST,
      }
    );
  }

  // OPEN -> RESOLVED, once: the update only matches an OPEN request with no
  // resolution field set, so of two concurrent resolutions exactly one is
  // written and the other gets false. Every resolution field is written by
  // this one statement, never one at a time
  async resolveRevisionRequestWithCompareAndSwap(input: {
    organizationId: string;
    reviewId: string;
    id: string;
    resolvedByUserId: string;
    resolvedAt: Date;
    resolvedByPackageRevisionId: string | null;
    resolvedByDesignRevisionId: string | null;
    resolvedByContentHash: string;
  }) {
    const { count } =
      await this._revisionRequest.model.contentStudioReviewRevisionRequest.updateMany(
        {
          where: {
            id: input.id,
            organizationId: input.organizationId,
            reviewId: input.reviewId,
            status: 'OPEN',
            resolvedByUserId: null,
            resolvedAt: null,
            resolvedByPackageRevisionId: null,
            resolvedByDesignRevisionId: null,
            resolvedByContentHash: null,
          },
          data: {
            status: 'RESOLVED',
            resolvedByUserId: input.resolvedByUserId,
            resolvedAt: input.resolvedAt,
            resolvedByPackageRevisionId: input.resolvedByPackageRevisionId,
            resolvedByDesignRevisionId: input.resolvedByDesignRevisionId,
            resolvedByContentHash: input.resolvedByContentHash,
          },
        }
      );
    return count === 1;
  }
}
