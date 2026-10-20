import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

interface NewHandoff {
  id: string;
  organizationId: string;
  userId: string;
  packageId: string;
  packageRevisionId: string;
  expiresAt: Date;
}

const handoffData = (input: NewHandoff) => ({
  id: input.id,
  organizationId: input.organizationId,
  userId: input.userId,
  packageId: input.packageId,
  packageRevisionId: input.packageRevisionId,
  expiresAt: input.expiresAt,
});

const HANDOFF_CREATED = {
  id: true,
  expiresAt: true,
} as const;

// A handoff belongs to one user of one organization: every query filters on
// both, so another user's handoff reads exactly like a missing one. Rows are
// only created and stamped (openedAt, revokedAt), never deleted
@Injectable()
export class ContentStudioHandoffRepository {
  constructor(
    private _handoff: PrismaRepository<'contentStudioHandoff'>,
    private _transaction: PrismaTransaction
  ) {}

  // The package and revision must already be checked against the
  // organization by the caller
  createHandoff(input: NewHandoff) {
    return this._handoff.model.contentStudioHandoff.create({
      data: handoffData(input),
      select: HANDOFF_CREATED,
    });
  }

  // The handoff of a revision that must be approved (P5-07), created only
  // while the revision's review is held, so no approval decision can come
  // between: decisions are appended holding that row (P5-04). The caller
  // judged the approval on a history of `approvalVersion` decisions; the
  // handoff is created only if the review is still ready for approval with
  // exactly that history once it is held, and null is returned otherwise
  // (nothing written). The hold changes nothing: it writes back the
  // updatedAt it matched, which every change of the review moves on. A
  // decision waiting on the hold is made after the handoff, on a history the
  // handoff never changed
  createHandoffWhileApproved(
    input: NewHandoff & { reviewId: string; approvalVersion: number }
  ) {
    return this._transaction.model.$transaction(async (tx) => {
      const review = {
        id: input.reviewId,
        organizationId: input.organizationId,
        packageRevisionId: input.packageRevisionId,
        state: 'READY_FOR_APPROVAL',
      };
      const read = await tx.contentStudioReview.findFirst({
        where: review,
        select: {
          updatedAt: true,
        },
      });
      if (!read) {
        return null;
      }
      const held = await tx.contentStudioReview.updateMany({
        where: {
          ...review,
          updatedAt: read.updatedAt,
        },
        data: {
          updatedAt: read.updatedAt,
        },
      });
      if (held.count !== 1) {
        return null;
      }
      const decisions = await tx.contentStudioApproval.count({
        where: {
          organizationId: input.organizationId,
          reviewId: input.reviewId,
        },
      });
      if (decisions !== input.approvalVersion) {
        return null;
      }
      return tx.contentStudioHandoff.create({
        data: handoffData(input),
        select: HANDOFF_CREATED,
      });
    });
  }

  getHandoffForOrganizationAndUser(input: {
    organizationId: string;
    userId: string;
    id: string;
  }) {
    return this._handoff.model.contentStudioHandoff.findFirst({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        userId: input.userId,
      },
      select: {
        id: true,
        packageId: true,
        packageRevisionId: true,
        expiresAt: true,
        openedAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });
  }

  // Records the first successful open only; later opens change nothing
  markOpenedIfNeeded(input: {
    organizationId: string;
    userId: string;
    id: string;
    openedAt: Date;
  }) {
    return this._handoff.model.contentStudioHandoff.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        userId: input.userId,
        openedAt: null,
        revokedAt: null,
      },
      data: {
        openedAt: input.openedAt,
      },
    });
  }

  // Count 0 means missing, foreign or already revoked
  revokeHandoff(input: {
    organizationId: string;
    userId: string;
    id: string;
    revokedAt: Date;
  }) {
    return this._handoff.model.contentStudioHandoff.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        userId: input.userId,
        revokedAt: null,
      },
      data: {
        revokedAt: input.revokedAt,
      },
    });
  }
}
