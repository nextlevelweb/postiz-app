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

// A pattern's layers as the service canonicalized and hashed them
interface StoredPattern {
  schemaVersion: number;
  content: string;
  contentHash: string;
}

// Layout patterns of an organization: every query filters on organizationId
// itself, so a pattern of another organization reads exactly like a missing
// one (null or count 0). A pattern is a mutable recipe: its name,
// description and layers change in place while it is active; an archived one
// is read-only until it is restored. Nothing is deleted
@Injectable()
export class ContentStudioDesignLayoutPatternRepository {
  constructor(
    private _pattern: PrismaRepository<'contentStudioDesignLayoutPattern'>
  ) {}

  listPatternsForOrganization(input: {
    organizationId: string;
    archived: boolean;
    skip: number;
    take: number;
  }) {
    return this._pattern.model.contentStudioDesignLayoutPattern.findMany({
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

  countPatternsForOrganization(input: {
    organizationId: string;
    archived: boolean;
  }) {
    return this._pattern.model.contentStudioDesignLayoutPattern.count({
      where: {
        organizationId: input.organizationId,
        archivedAt: input.archived ? { not: null } : null,
      },
    });
  }

  getPatternForOrganization(organizationId: string, id: string) {
    return this._pattern.model.contentStudioDesignLayoutPattern.findFirst({
      where: {
        id,
        organizationId,
      },
      select: PATTERN,
    });
  }

  createPattern(input: {
    id: string;
    organizationId: string;
    name: string;
    description: string | null;
    createdById: string;
    pattern: StoredPattern;
  }) {
    return this._pattern.model.contentStudioDesignLayoutPattern.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        name: input.name,
        description: input.description,
        schemaVersion: input.pattern.schemaVersion,
        content: input.pattern.content,
        contentHash: input.pattern.contentHash,
        createdById: input.createdById,
      },
      select: PATTERN,
    });
  }

  // Only an active pattern of the organization
  updatePattern(
    organizationId: string,
    id: string,
    details: {
      name?: string;
      description?: string | null;
      pattern?: StoredPattern;
    }
  ) {
    return this._pattern.model.contentStudioDesignLayoutPattern.updateMany({
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
        ...(details.pattern
          ? {
              schemaVersion: details.pattern.schemaVersion,
              content: details.pattern.content,
              contentHash: details.pattern.contentHash,
            }
          : {}),
      },
    });
  }

  archivePattern(organizationId: string, id: string, archivedAt: Date) {
    return this._pattern.model.contentStudioDesignLayoutPattern.updateMany({
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

  restorePattern(organizationId: string, id: string) {
    return this._pattern.model.contentStudioDesignLayoutPattern.updateMany({
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
