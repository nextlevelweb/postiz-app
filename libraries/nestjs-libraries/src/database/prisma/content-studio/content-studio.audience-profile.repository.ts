import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

const PROFILE_SUMMARY = {
  id: true,
  name: true,
  latestRevisionNumber: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
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

// Every query filters on organizationId itself, so a profile of another
// organization reads exactly like a missing one (null or count 0). An archived
// profile is read-only until it is restored; its history stays readable.
// Revisions are only ever created (with their profile, or by the
// compare-and-swap), never updated or deleted, and nothing is deleted at all
@Injectable()
export class ContentStudioAudienceProfileRepository {
  constructor(
    private _profile: PrismaRepository<'contentStudioAudienceProfile'>,
    private _revision: PrismaRepository<'contentStudioAudienceProfileRevision'>,
    private _transaction: PrismaTransaction
  ) {}

  listProfilesForOrganization(input: {
    organizationId: string;
    archived: boolean;
    skip: number;
    take: number;
  }) {
    return this._profile.model.contentStudioAudienceProfile.findMany({
      where: {
        organizationId: input.organizationId,
        archivedAt: input.archived ? { not: null } : null,
      },
      // id breaks ties so pages never overlap
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: PROFILE_SUMMARY,
      skip: input.skip,
      take: input.take,
    });
  }

  countProfilesForOrganization(input: {
    organizationId: string;
    archived: boolean;
  }) {
    return this._profile.model.contentStudioAudienceProfile.count({
      where: {
        organizationId: input.organizationId,
        archivedAt: input.archived ? { not: null } : null,
      },
    });
  }

  getProfileForOrganization(organizationId: string, id: string) {
    return this._profile.model.contentStudioAudienceProfile.findFirst({
      where: {
        id,
        organizationId,
      },
      select: PROFILE_SUMMARY,
    });
  }

  // The profile and its first revision, or neither
  createProfileWithFirstRevision(input: {
    profileId: string;
    revisionId: string;
    organizationId: string;
    name: string;
    createdById: string;
    revision: StoredRevision;
  }) {
    return this._transaction.model.$transaction(async (tx) => {
      const profile = await tx.contentStudioAudienceProfile.create({
        data: {
          id: input.profileId,
          organizationId: input.organizationId,
          name: input.name,
          latestRevisionNumber: 1,
          createdById: input.createdById,
        },
        select: PROFILE_SUMMARY,
      });
      const revision = await tx.contentStudioAudienceProfileRevision.create({
        data: {
          id: input.revisionId,
          organizationId: input.organizationId,
          profileId: input.profileId,
          revisionNumber: 1,
          schemaVersion: input.revision.schemaVersion,
          content: input.revision.content,
          contentHash: input.revision.contentHash,
          createdById: input.createdById,
        },
        select: REVISION_SUMMARY,
      });
      return { profile, revision };
    });
  }

  // The name is not audience content: renaming makes no revision
  updateProfileName(organizationId: string, id: string, name: string) {
    return this._profile.model.contentStudioAudienceProfile.updateMany({
      where: {
        id,
        organizationId,
        archivedAt: null,
      },
      data: {
        name,
      },
    });
  }

  archiveProfile(organizationId: string, id: string, archivedAt: Date) {
    return this._profile.model.contentStudioAudienceProfile.updateMany({
      where: {
        id,
        organizationId,
        archivedAt: null,
      },
      data: {
        archivedAt,
      },
    });
  }

  restoreProfile(organizationId: string, id: string) {
    return this._profile.model.contentStudioAudienceProfile.updateMany({
      where: {
        id,
        organizationId,
        archivedAt: { not: null },
      },
      data: {
        archivedAt: null,
      },
    });
  }

  // Saves new audience content over the revision the editor started from, in
  // one transaction: the profile must be live and still at that revision.
  // Content equal to that revision makes no new one. The update only matches
  // the expected revision number and holds the profile row until commit, so
  // two saves can never take the same number
  createRevisionWithCompareAndSwap(input: {
    organizationId: string;
    profileId: string;
    expectedLatestRevisionNumber: number;
    revisionId: string;
    revision: StoredRevision;
    createdById: string;
  }) {
    return this._transaction.model.$transaction(async (tx) => {
      const profile = await tx.contentStudioAudienceProfile.findFirst({
        where: {
          id: input.profileId,
          organizationId: input.organizationId,
        },
        select: {
          latestRevisionNumber: true,
          archivedAt: true,
        },
      });
      if (!profile) {
        return { status: 'not-found' as const };
      }
      if (profile.archivedAt) {
        return { status: 'archived' as const };
      }
      if (profile.latestRevisionNumber !== input.expectedLatestRevisionNumber) {
        return {
          status: 'conflict' as const,
          currentRevisionNumber: profile.latestRevisionNumber,
        };
      }

      const current = await tx.contentStudioAudienceProfileRevision.findFirst({
        where: {
          organizationId: input.organizationId,
          profileId: input.profileId,
          revisionNumber: input.expectedLatestRevisionNumber,
        },
        select: REVISION_DETAIL,
      });
      if (current && current.contentHash === input.revision.contentHash) {
        return { status: 'unchanged' as const, revision: current };
      }

      const { count } = await tx.contentStudioAudienceProfile.updateMany({
        where: {
          id: input.profileId,
          organizationId: input.organizationId,
          archivedAt: null,
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

      const revision = await tx.contentStudioAudienceProfileRevision.create({
        data: {
          id: input.revisionId,
          organizationId: input.organizationId,
          profileId: input.profileId,
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
  listRevisionsForProfile(input: {
    organizationId: string;
    profileId: string;
    skip: number;
    take: number;
  }) {
    return this._revision.model.contentStudioAudienceProfileRevision.findMany({
      where: {
        organizationId: input.organizationId,
        profileId: input.profileId,
      },
      orderBy: {
        revisionNumber: 'desc',
      },
      select: REVISION_SUMMARY,
      skip: input.skip,
      take: input.take,
    });
  }

  countRevisionsForProfile(organizationId: string, profileId: string) {
    return this._revision.model.contentStudioAudienceProfileRevision.count({
      where: {
        organizationId,
        profileId,
      },
    });
  }

  getRevisionForProfile(
    organizationId: string,
    profileId: string,
    revisionId: string
  ) {
    return this._revision.model.contentStudioAudienceProfileRevision.findFirst({
      where: {
        id: revisionId,
        profileId,
        organizationId,
      },
      select: REVISION_DETAIL,
    });
  }

  getRevisionByNumber(
    organizationId: string,
    profileId: string,
    revisionNumber: number
  ) {
    return this._revision.model.contentStudioAudienceProfileRevision.findFirst({
      where: {
        organizationId,
        profileId,
        revisionNumber,
      },
      select: REVISION_DETAIL,
    });
  }
}
