import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

// A handoff belongs to one user of one organization: every query filters on
// both, so another user's handoff reads exactly like a missing one. Rows are
// only created and stamped (openedAt, revokedAt), never deleted
@Injectable()
export class ContentStudioHandoffRepository {
  constructor(private _handoff: PrismaRepository<'contentStudioHandoff'>) {}

  // The package and revision must already be checked against the
  // organization by the caller
  createHandoff(input: {
    id: string;
    organizationId: string;
    userId: string;
    packageId: string;
    packageRevisionId: string;
    expiresAt: Date;
  }) {
    return this._handoff.model.contentStudioHandoff.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        userId: input.userId,
        packageId: input.packageId,
        packageRevisionId: input.packageRevisionId,
        expiresAt: input.expiresAt,
      },
      select: {
        id: true,
        expiresAt: true,
      },
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
