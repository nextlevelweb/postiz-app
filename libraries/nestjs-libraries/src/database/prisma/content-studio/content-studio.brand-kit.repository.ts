import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

const BRAND_KIT_SUMMARY = {
  id: true,
  latestRevisionNumber: true,
} as const;

// Revision lists and the compare-and-swap never load the content
const REVISION_SUMMARY = {
  id: true,
  revisionNumber: true,
  schemaVersion: true,
  contentHash: true,
  createdAt: true,
} as const;

const REVISION_DETAIL = {
  ...REVISION_SUMMARY,
  content: true,
} as const;

// A revision as the service canonicalized and hashed it
interface StoredRevision {
  schemaVersion: number;
  content: string;
  contentHash: string;
}

// An organization has at most one Brand Kit (organizationId is unique), found
// by the organization and never by an id from a request. Every query filters
// on organizationId itself. The kit row only ever changes its latest revision
// number; revisions are only ever created (with the kit, or by the
// compare-and-swap), never updated or deleted, and nothing is deleted at all
@Injectable()
export class ContentStudioBrandKitRepository {
  constructor(
    private _brandKit: PrismaRepository<'contentStudioBrandKit'>,
    private _revision: PrismaRepository<'contentStudioBrandKitRevision'>,
    private _transaction: PrismaTransaction
  ) {}

  getBrandKitForOrganization(organizationId: string) {
    return this._brandKit.model.contentStudioBrandKit.findUnique({
      where: {
        organizationId,
      },
      select: BRAND_KIT_SUMMARY,
    });
  }

  // The first save: the kit and its revision 1, or neither. A second kit for
  // the organization fails on its unique organizationId
  createBrandKitWithFirstRevision(input: {
    brandKitId: string;
    revisionId: string;
    organizationId: string;
    createdById: string;
    revision: StoredRevision;
  }) {
    return this._transaction.model.$transaction(async (tx) => {
      const brandKit = await tx.contentStudioBrandKit.create({
        data: {
          id: input.brandKitId,
          organizationId: input.organizationId,
          latestRevisionNumber: 1,
          createdById: input.createdById,
        },
        select: BRAND_KIT_SUMMARY,
      });
      const revision = await tx.contentStudioBrandKitRevision.create({
        data: {
          id: input.revisionId,
          organizationId: input.organizationId,
          brandKitId: input.brandKitId,
          revisionNumber: 1,
          schemaVersion: input.revision.schemaVersion,
          content: input.revision.content,
          contentHash: input.revision.contentHash,
          createdById: input.createdById,
        },
        select: REVISION_SUMMARY,
      });
      return { brandKit, revision };
    });
  }

  // Saves a new kit over the revision the editor started from, in one
  // transaction: the organization's kit must still be at that revision.
  // Content equal to that revision makes no new one. The update only matches
  // the expected revision number and holds the kit row until commit, so two
  // saves can never take the same number
  createRevisionWithCompareAndSwap(input: {
    organizationId: string;
    expectedLatestRevisionNumber: number;
    revisionId: string;
    revision: StoredRevision;
    createdById: string;
  }) {
    return this._transaction.model.$transaction(async (tx) => {
      const brandKit = await tx.contentStudioBrandKit.findUnique({
        where: {
          organizationId: input.organizationId,
        },
        select: BRAND_KIT_SUMMARY,
      });
      if (!brandKit) {
        return { status: 'not-found' as const };
      }
      if (
        brandKit.latestRevisionNumber !== input.expectedLatestRevisionNumber
      ) {
        return {
          status: 'conflict' as const,
          currentRevisionNumber: brandKit.latestRevisionNumber,
        };
      }

      const current = await tx.contentStudioBrandKitRevision.findFirst({
        where: {
          organizationId: input.organizationId,
          brandKitId: brandKit.id,
          revisionNumber: input.expectedLatestRevisionNumber,
        },
        select: REVISION_DETAIL,
      });
      if (current && current.contentHash === input.revision.contentHash) {
        return { status: 'unchanged' as const, revision: current };
      }

      const { count } = await tx.contentStudioBrandKit.updateMany({
        where: {
          id: brandKit.id,
          organizationId: input.organizationId,
          latestRevisionNumber: input.expectedLatestRevisionNumber,
        },
        data: {
          latestRevisionNumber: {
            increment: 1,
          },
        },
      });
      if (count !== 1) {
        return { status: 'changed' as const };
      }

      const revision = await tx.contentStudioBrandKitRevision.create({
        data: {
          id: input.revisionId,
          organizationId: input.organizationId,
          brandKitId: brandKit.id,
          revisionNumber: input.expectedLatestRevisionNumber + 1,
          schemaVersion: input.revision.schemaVersion,
          content: input.revision.content,
          contentHash: input.revision.contentHash,
          createdById: input.createdById,
        },
        select: REVISION_SUMMARY,
      });
      return { status: 'created' as const, revision };
    });
  }

  // Summaries only, newest first: content is loaded one revision at a time
  listRevisionsForBrandKit(input: {
    organizationId: string;
    brandKitId: string;
    skip: number;
    take: number;
  }) {
    return this._revision.model.contentStudioBrandKitRevision.findMany({
      where: {
        organizationId: input.organizationId,
        brandKitId: input.brandKitId,
      },
      orderBy: {
        revisionNumber: 'desc',
      },
      select: REVISION_SUMMARY,
      skip: input.skip,
      take: input.take,
    });
  }

  countRevisionsForBrandKit(organizationId: string, brandKitId: string) {
    return this._revision.model.contentStudioBrandKitRevision.count({
      where: {
        organizationId,
        brandKitId,
      },
    });
  }

  getRevisionForBrandKit(
    organizationId: string,
    brandKitId: string,
    revisionId: string
  ) {
    return this._revision.model.contentStudioBrandKitRevision.findFirst({
      where: {
        id: revisionId,
        brandKitId,
        organizationId,
      },
      select: REVISION_DETAIL,
    });
  }

  getRevisionByNumber(
    organizationId: string,
    brandKitId: string,
    revisionNumber: number
  ) {
    return this._revision.model.contentStudioBrandKitRevision.findFirst({
      where: {
        organizationId,
        brandKitId,
        revisionNumber,
      },
      select: REVISION_DETAIL,
    });
  }
}
