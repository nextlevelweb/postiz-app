import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

// A review with its exact target and its whole state history (a few events
// at most). The target is the revision itself, read through the relation:
// its number and stored hash, never its content
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
      revisionNumber: true,
      contentHash: true,
    },
  },
  designRevision: {
    select: {
      id: true,
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

// Exactly one of the two is set: the service never passes both or neither
export interface ContentStudioReviewTargetFilter {
  packageRevisionId?: string | { not: null };
  designRevisionId?: string | { not: null };
}

// Reviews of an organization: every query filters on organizationId itself,
// so a review or a revision of another organization reads exactly like a
// missing one (null or count 0). A review is created with its first state
// event and changes state only together with the next one, in one
// transaction and only from the state and version it was read at. Its
// target never changes. Nothing is deleted
@Injectable()
export class ContentStudioReviewRepository {
  constructor(
    private _review: PrismaRepository<'contentStudioReview'>,
    private _packageRevision: PrismaRepository<'contentPackageRevision'>,
    private _designRevision: PrismaRepository<'contentStudioDesignRevision'>,
    private _transaction: PrismaTransaction
  ) {}

  // The exact package revision, with its content so the service can prove it
  // is still what was stored
  getPackageRevisionForOrganization(organizationId: string, id: string) {
    return this._packageRevision.model.contentPackageRevision.findFirst({
      where: {
        id,
        organizationId,
      },
      select: TARGET_REVISION,
    });
  }

  getDesignRevisionForOrganization(organizationId: string, id: string) {
    return this._designRevision.model.contentStudioDesignRevision.findFirst({
      where: {
        id,
        organizationId,
      },
      select: TARGET_REVISION,
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
  // next state and appends that event, in one transaction. The update only
  // matches while both are still current and holds the review row until
  // commit, so of two concurrent transitions exactly one is written; the
  // other changes nothing and gets false
  transitionReviewWithCompareAndSwap(input: {
    organizationId: string;
    reviewId: string;
    expectedState: string;
    expectedVersion: number;
    toState: string;
    actorUserId: string;
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
      return true;
    });
  }
}
