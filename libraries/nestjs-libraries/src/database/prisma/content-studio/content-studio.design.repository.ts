import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

const PROJECT_SUMMARY = {
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

// The detail of a design also says which saved package revision it was
// created from (P6-01), read through the relation of the same organization:
// the stored id and hash next to that revision's own
const PROJECT_DETAIL = {
  ...PROJECT_SUMMARY,
  sourcePackageRevisionId: true,
  sourcePackageContentHash: true,
  sourcePackageRevision: {
    select: {
      id: true,
      packageId: true,
      revisionNumber: true,
      contentHash: true,
      package: {
        select: {
          name: true,
        },
      },
    },
  },
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

// Design projects of an organization. Every query filters on organizationId
// itself, so a design of another organization reads exactly like a missing
// one (null or count 0). An archived design is read-only until it is
// restored; its history stays readable. The project row holds the name, the
// archive state and the latest revision number; the design documents are
// revisions, only ever created (with their project, or by the
// compare-and-swap), never updated or deleted, and nothing is deleted at all.
// The package revision a design came from (P6-01) is written with the
// project, by the same statement, and never changed: no method here updates
// it
@Injectable()
export class ContentStudioDesignRepository {
  constructor(
    private _project: PrismaRepository<'contentStudioDesignProject'>,
    private _revision: PrismaRepository<'contentStudioDesignRevision'>,
    private _transaction: PrismaTransaction
  ) {}

  listProjectsForOrganization(input: {
    organizationId: string;
    archived: boolean;
    skip: number;
    take: number;
  }) {
    return this._project.model.contentStudioDesignProject.findMany({
      where: {
        organizationId: input.organizationId,
        archivedAt: input.archived ? { not: null } : null,
      },
      // id breaks ties so pages never overlap
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: PROJECT_SUMMARY,
      skip: input.skip,
      take: input.take,
    });
  }

  countProjectsForOrganization(input: {
    organizationId: string;
    archived: boolean;
  }) {
    return this._project.model.contentStudioDesignProject.count({
      where: {
        organizationId: input.organizationId,
        archivedAt: input.archived ? { not: null } : null,
      },
    });
  }

  getProjectForOrganization(organizationId: string, id: string) {
    return this._project.model.contentStudioDesignProject.findFirst({
      where: {
        id,
        organizationId,
      },
      select: PROJECT_SUMMARY,
    });
  }

  // The design with where it came from: null when it has no such project
  getProjectDetailForOrganization(organizationId: string, id: string) {
    return this._project.model.contentStudioDesignProject.findFirst({
      where: {
        id,
        organizationId,
      },
      select: PROJECT_DETAIL,
    });
  }

  // The project and its first revision, or neither. The source is the exact
  // package revision the service read for it, or null for a design created
  // on its own
  createProjectWithFirstRevision(input: {
    designProjectId: string;
    revisionId: string;
    organizationId: string;
    name: string;
    createdById: string;
    revision: StoredRevision;
    source: { packageRevisionId: string; contentHash: string } | null;
  }) {
    return this._transaction.model.$transaction(async (tx) => {
      const project = await tx.contentStudioDesignProject.create({
        data: {
          id: input.designProjectId,
          organizationId: input.organizationId,
          name: input.name,
          latestRevisionNumber: 1,
          createdById: input.createdById,
          sourcePackageRevisionId: input.source?.packageRevisionId ?? null,
          sourcePackageContentHash: input.source?.contentHash ?? null,
        },
        select: PROJECT_SUMMARY,
      });
      const revision = await tx.contentStudioDesignRevision.create({
        data: {
          id: input.revisionId,
          organizationId: input.organizationId,
          designProjectId: input.designProjectId,
          revisionNumber: 1,
          schemaVersion: input.revision.schemaVersion,
          content: input.revision.content,
          contentHash: input.revision.contentHash,
          createdById: input.createdById,
        },
        select: REVISION_SUMMARY,
      });
      return { project, revision };
    });
  }

  // The name is not part of the design document: renaming makes no revision
  updateProjectName(organizationId: string, id: string, name: string) {
    return this._project.model.contentStudioDesignProject.updateMany({
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

  archiveProject(organizationId: string, id: string, archivedAt: Date) {
    return this._project.model.contentStudioDesignProject.updateMany({
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

  restoreProject(organizationId: string, id: string) {
    return this._project.model.contentStudioDesignProject.updateMany({
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

  // Saves a new design document over the revision the editor started from,
  // in one transaction: the project must be live and still at that revision.
  // Content equal to that revision makes no new one. The update only matches
  // the expected revision number and holds the project row until commit, so
  // two saves can never take the same number
  createRevisionWithCompareAndSwap(input: {
    organizationId: string;
    designProjectId: string;
    expectedLatestRevisionNumber: number;
    revisionId: string;
    revision: StoredRevision;
    createdById: string;
  }) {
    return this._transaction.model.$transaction(async (tx) => {
      const project = await tx.contentStudioDesignProject.findFirst({
        where: {
          id: input.designProjectId,
          organizationId: input.organizationId,
        },
        select: {
          latestRevisionNumber: true,
          archivedAt: true,
        },
      });
      if (!project) {
        return { status: 'not-found' as const };
      }
      if (project.archivedAt) {
        return { status: 'archived' as const };
      }
      if (project.latestRevisionNumber !== input.expectedLatestRevisionNumber) {
        return {
          status: 'conflict' as const,
          currentRevisionNumber: project.latestRevisionNumber,
        };
      }

      const current = await tx.contentStudioDesignRevision.findFirst({
        where: {
          organizationId: input.organizationId,
          designProjectId: input.designProjectId,
          revisionNumber: input.expectedLatestRevisionNumber,
        },
        select: REVISION_DETAIL,
      });
      if (current && current.contentHash === input.revision.contentHash) {
        return { status: 'unchanged' as const, revision: current };
      }

      const { count } = await tx.contentStudioDesignProject.updateMany({
        where: {
          id: input.designProjectId,
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

      const revision = await tx.contentStudioDesignRevision.create({
        data: {
          id: input.revisionId,
          organizationId: input.organizationId,
          designProjectId: input.designProjectId,
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
  listRevisionsForProject(input: {
    organizationId: string;
    designProjectId: string;
    skip: number;
    take: number;
  }) {
    return this._revision.model.contentStudioDesignRevision.findMany({
      where: {
        organizationId: input.organizationId,
        designProjectId: input.designProjectId,
      },
      orderBy: {
        revisionNumber: 'desc',
      },
      select: REVISION_SUMMARY,
      skip: input.skip,
      take: input.take,
    });
  }

  countRevisionsForProject(organizationId: string, designProjectId: string) {
    return this._revision.model.contentStudioDesignRevision.count({
      where: {
        organizationId,
        designProjectId,
      },
    });
  }

  getRevisionForProject(
    organizationId: string,
    designProjectId: string,
    revisionId: string
  ) {
    return this._revision.model.contentStudioDesignRevision.findFirst({
      where: {
        id: revisionId,
        designProjectId,
        organizationId,
      },
      select: REVISION_DETAIL,
    });
  }

  getRevisionByNumber(
    organizationId: string,
    designProjectId: string,
    revisionNumber: number
  ) {
    return this._revision.model.contentStudioDesignRevision.findFirst({
      where: {
        organizationId,
        designProjectId,
        revisionNumber,
      },
      select: REVISION_DETAIL,
    });
  }
}
