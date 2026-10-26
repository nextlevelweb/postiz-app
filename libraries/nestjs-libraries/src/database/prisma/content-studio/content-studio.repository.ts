import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

// Every query filters on organizationId itself, so a record of another
// organization reads exactly like a missing one (null or count 0). Archived
// projects and packages are read-only until they are restored. Revisions are
// only ever created, never updated or deleted
@Injectable()
export class ContentStudioRepository {
  constructor(
    private _project: PrismaRepository<'contentStudioProject'>,
    private _package: PrismaRepository<'contentPackage'>,
    private _revision: PrismaRepository<'contentPackageRevision'>,
    private _transaction: PrismaTransaction
  ) {}

  listProjectsForOrganization(organizationId: string, archived: boolean) {
    return this._project.model.contentStudioProject.findMany({
      where: {
        organizationId,
        archivedAt: archived ? { not: null } : null,
      },
      orderBy: {
        name: 'asc',
      },
      select: {
        id: true,
        name: true,
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  getProjectForOrganization(organizationId: string, id: string) {
    return this._project.model.contentStudioProject.findFirst({
      where: {
        id,
        organizationId,
      },
      select: {
        id: true,
        name: true,
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  createProject(input: {
    organizationId: string;
    name: string;
    createdById: string;
  }) {
    return this._project.model.contentStudioProject.create({
      data: {
        organizationId: input.organizationId,
        name: input.name,
        createdById: input.createdById,
      },
      select: {
        id: true,
        name: true,
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  updateProjectName(organizationId: string, id: string, name: string) {
    return this._project.model.contentStudioProject.updateMany({
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
    return this._project.model.contentStudioProject.updateMany({
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
    return this._project.model.contentStudioProject.updateMany({
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

  // Summaries only: the draft is loaded one package at a time
  listPackagesForOrganization(input: {
    organizationId: string;
    archived: boolean;
    projectId?: string;
    skip: number;
    take: number;
  }) {
    return this._package.model.contentPackage.findMany({
      where: {
        organizationId: input.organizationId,
        archivedAt: input.archived ? { not: null } : null,
        projectId: input.projectId,
      },
      // id breaks ties so pages never overlap
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        projectId: true,
        draftVersion: true,
        latestRevisionNumber: true,
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
      },
      skip: input.skip,
      take: input.take,
    });
  }

  countPackagesForOrganization(input: {
    organizationId: string;
    archived: boolean;
    projectId?: string;
  }) {
    return this._package.model.contentPackage.count({
      where: {
        organizationId: input.organizationId,
        archivedAt: input.archived ? { not: null } : null,
        projectId: input.projectId,
      },
    });
  }

  getPackageForOrganization(organizationId: string, id: string) {
    return this._package.model.contentPackage.findFirst({
      where: {
        id,
        organizationId,
      },
      select: {
        id: true,
        projectId: true,
        name: true,
        draft: true,
        draftVersion: true,
        latestRevisionNumber: true,
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  // projectId must already be checked against the organization by the caller
  createPackage(input: {
    organizationId: string;
    projectId: string | null;
    name: string;
    draft: string;
    createdById: string;
  }) {
    return this._package.model.contentPackage.create({
      data: {
        organizationId: input.organizationId,
        projectId: input.projectId,
        name: input.name,
        draft: input.draft,
        createdById: input.createdById,
      },
      select: {
        id: true,
        name: true,
        projectId: true,
        draftVersion: true,
        latestRevisionNumber: true,
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  // A field left undefined is left unchanged; projectId null removes the
  // project. projectId must already be checked against the organization
  updatePackageMetadata(input: {
    organizationId: string;
    packageId: string;
    name?: string;
    projectId?: string | null;
  }) {
    return this._package.model.contentPackage.updateMany({
      where: {
        id: input.packageId,
        organizationId: input.organizationId,
        archivedAt: null,
      },
      data: {
        name: input.name,
        projectId: input.projectId,
      },
    });
  }

  // Saves only over the version the editor started from: count 0 means the
  // package is missing, foreign, archived or was saved by someone else since
  saveDraftCompareAndSwap(input: {
    organizationId: string;
    packageId: string;
    baseDraftVersion: number;
    draft: string;
  }) {
    return this._package.model.contentPackage.updateMany({
      where: {
        id: input.packageId,
        organizationId: input.organizationId,
        archivedAt: null,
        draftVersion: input.baseDraftVersion,
      },
      data: {
        draft: input.draft,
        draftVersion: {
          increment: 1,
        },
      },
    });
  }

  // Tells the reasons for a failed compare-and-swap apart; null for a missing
  // or foreign package alike
  getPackageWriteStateForOrganization(organizationId: string, id: string) {
    return this._package.model.contentPackage.findFirst({
      where: {
        id,
        organizationId,
      },
      select: {
        draftVersion: true,
        archivedAt: true,
      },
    });
  }

  archivePackage(organizationId: string, id: string, archivedAt: Date) {
    return this._package.model.contentPackage.updateMany({
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

  restorePackage(organizationId: string, id: string) {
    return this._package.model.contentPackage.updateMany({
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

  // Summaries only: content is loaded one revision at a time
  listRevisionsForPackage(input: {
    organizationId: string;
    packageId: string;
    skip: number;
    take: number;
  }) {
    return this._revision.model.contentPackageRevision.findMany({
      where: {
        organizationId: input.organizationId,
        packageId: input.packageId,
      },
      orderBy: {
        revisionNumber: 'desc',
      },
      select: {
        id: true,
        revisionNumber: true,
        contentHash: true,
        origin: true,
        sourceDraftVersion: true,
        createdAt: true,
        createdBy: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      skip: input.skip,
      take: input.take,
    });
  }

  countRevisionsForPackage(organizationId: string, packageId: string) {
    return this._revision.model.contentPackageRevision.count({
      where: {
        organizationId,
        packageId,
      },
    });
  }

  getRevisionForPackage(
    organizationId: string,
    packageId: string,
    revisionId: string
  ) {
    return this._revision.model.contentPackageRevision.findFirst({
      where: {
        id: revisionId,
        packageId,
        organizationId,
      },
      select: {
        id: true,
        packageId: true,
        revisionNumber: true,
        schemaVersion: true,
        content: true,
        contentHash: true,
        origin: true,
        sourceDraftVersion: true,
        createdAt: true,
        createdBy: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
  }

  getLatestRevisionForPackage(organizationId: string, packageId: string) {
    return this._revision.model.contentPackageRevision.findFirst({
      where: {
        packageId,
        organizationId,
      },
      orderBy: {
        revisionNumber: 'desc',
      },
      select: {
        id: true,
        packageId: true,
        revisionNumber: true,
        schemaVersion: true,
        content: true,
        contentHash: true,
        origin: true,
        sourceDraftVersion: true,
        createdAt: true,
        createdBy: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
  }

  // Stores a revision of the draft the caller read, validated and hashed. The
  // package update only matches while that draft version and latest revision
  // number are still current (and the package is live), and it holds the
  // package row until commit, so two revisions can never take the same number
  createRevisionWithCompareAndSwap(input: {
    organizationId: string;
    packageId: string;
    expectedDraftVersion: number;
    expectedLatestRevisionNumber: number;
    schemaVersion: number;
    content: string;
    contentHash: string;
    origin: string;
    createdById: string;
  }) {
    return this._transaction.model.$transaction(async (tx) => {
      const { count } = await tx.contentPackage.updateMany({
        where: {
          id: input.packageId,
          organizationId: input.organizationId,
          archivedAt: null,
          draftVersion: input.expectedDraftVersion,
          latestRevisionNumber: input.expectedLatestRevisionNumber,
        },
        data: {
          latestRevisionNumber: {
            increment: 1,
          },
        },
      });

      if (count !== 1) {
        return {
          created: false as const,
          reason: 'compare-and-swap-failed' as const,
        };
      }

      const revision = await tx.contentPackageRevision.create({
        data: {
          organizationId: input.organizationId,
          packageId: input.packageId,
          revisionNumber: input.expectedLatestRevisionNumber + 1,
          schemaVersion: input.schemaVersion,
          content: input.content,
          contentHash: input.contentHash,
          origin: input.origin,
          sourceDraftVersion: input.expectedDraftVersion,
          createdById: input.createdById,
        },
        select: {
          id: true,
          packageId: true,
          revisionNumber: true,
          schemaVersion: true,
          contentHash: true,
          origin: true,
          sourceDraftVersion: true,
          createdAt: true,
        },
      });

      return { created: true as const, revision };
    });
  }

  // For source version protection (P8-R1A) only: one page of the
  // organization's packages, archived or not, after `afterId` in id order,
  // with their current draft
  listPackageDraftsForVersionProtection(input: {
    organizationId: string;
    afterId: string | null;
    take: number;
  }) {
    return this._package.model.contentPackage.findMany({
      where: {
        organizationId: input.organizationId,
        ...(input.afterId ? { id: { gt: input.afterId } } : {}),
      },
      orderBy: {
        id: 'asc',
      },
      select: {
        id: true,
        organizationId: true,
        draft: true,
      },
      take: input.take,
    });
  }

  // For source version protection (P8-R1A) only: one page of the
  // organization's revisions of every package, archived or not, after
  // `afterId` in id order, with what proves their content
  listPackageRevisionsForVersionProtection(input: {
    organizationId: string;
    afterId: string | null;
    take: number;
  }) {
    return this._revision.model.contentPackageRevision.findMany({
      where: {
        organizationId: input.organizationId,
        ...(input.afterId ? { id: { gt: input.afterId } } : {}),
      },
      orderBy: {
        id: 'asc',
      },
      select: {
        id: true,
        organizationId: true,
        packageId: true,
        schemaVersion: true,
        content: true,
        contentHash: true,
      },
      take: input.take,
    });
  }
}
