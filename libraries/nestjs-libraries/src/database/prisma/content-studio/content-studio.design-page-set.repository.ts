import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

const PATTERN = {
  id: true,
  name: true,
  description: true,
  schemaVersion: true,
  content: true,
  contentHash: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

// A page set's pages as the service canonicalized and hashed them
interface StoredPageSet {
  schemaVersion: number;
  content: string;
  contentHash: string;
}

// Page sets of an organization: every query filters on organizationId
// itself, so a page set of another organization reads exactly like a
// missing one (null or count 0). A page set is a mutable recipe: its name,
// description and pages change in place while it is active; an archived one
// is read-only until it is restored. Nothing is deleted
@Injectable()
export class ContentStudioDesignPageSetRepository {
  constructor(
    private _pageSet: PrismaRepository<'contentStudioDesignPageSet'>
  ) {}

  listPageSetsForOrganization(input: {
    organizationId: string;
    archived: boolean;
    skip: number;
    take: number;
  }) {
    return this._pageSet.model.contentStudioDesignPageSet.findMany({
      where: {
        organizationId: input.organizationId,
        archivedAt: input.archived ? { not: null } : null,
      },
      // id breaks ties so pages never overlap
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: PATTERN,
      skip: input.skip,
      take: input.take,
    });
  }

  countPageSetsForOrganization(input: {
    organizationId: string;
    archived: boolean;
  }) {
    return this._pageSet.model.contentStudioDesignPageSet.count({
      where: {
        organizationId: input.organizationId,
        archivedAt: input.archived ? { not: null } : null,
      },
    });
  }

  getPageSetForOrganization(organizationId: string, id: string) {
    return this._pageSet.model.contentStudioDesignPageSet.findFirst({
      where: {
        id,
        organizationId,
      },
      select: PATTERN,
    });
  }

  createPageSet(input: {
    id: string;
    organizationId: string;
    name: string;
    description: string | null;
    createdById: string;
    pageSet: StoredPageSet;
  }) {
    return this._pageSet.model.contentStudioDesignPageSet.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        name: input.name,
        description: input.description,
        schemaVersion: input.pageSet.schemaVersion,
        content: input.pageSet.content,
        contentHash: input.pageSet.contentHash,
        createdById: input.createdById,
      },
      select: PATTERN,
    });
  }

  // Only an active page set of the organization
  updatePageSet(
    organizationId: string,
    id: string,
    details: {
      name?: string;
      description?: string | null;
      pageSet?: StoredPageSet;
    }
  ) {
    return this._pageSet.model.contentStudioDesignPageSet.updateMany({
      where: {
        id,
        organizationId,
        archivedAt: null,
      },
      data: {
        ...(details.name === undefined ? {} : { name: details.name }),
        ...(details.description === undefined
          ? {}
          : { description: details.description }),
        ...(details.pageSet
          ? {
              schemaVersion: details.pageSet.schemaVersion,
              content: details.pageSet.content,
              contentHash: details.pageSet.contentHash,
            }
          : {}),
      },
    });
  }

  archivePageSet(organizationId: string, id: string, archivedAt: Date) {
    return this._pageSet.model.contentStudioDesignPageSet.updateMany({
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

  restorePageSet(organizationId: string, id: string) {
    return this._pageSet.model.contentStudioDesignPageSet.updateMany({
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
}
