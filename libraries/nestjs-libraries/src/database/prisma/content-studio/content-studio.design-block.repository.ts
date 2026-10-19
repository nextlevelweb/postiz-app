import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

const BLOCK = {
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

// A block's layers as the service canonicalized and hashed them
interface StoredBlock {
  schemaVersion: number;
  content: string;
  contentHash: string;
}

// Design blocks of an organization: every query filters on organizationId
// itself, so a block of another organization reads exactly like a missing
// one (null or count 0). A block is a mutable recipe: its name,
// description and layers change in place while it is active; an archived one
// is read-only until it is restored. Nothing is deleted
@Injectable()
export class ContentStudioDesignBlockRepository {
  constructor(private _block: PrismaRepository<'contentStudioDesignBlock'>) {}

  listBlocksForOrganization(input: {
    organizationId: string;
    archived: boolean;
    skip: number;
    take: number;
  }) {
    return this._block.model.contentStudioDesignBlock.findMany({
      where: {
        organizationId: input.organizationId,
        archivedAt: input.archived ? { not: null } : null,
      },
      // id breaks ties so pages never overlap
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: BLOCK,
      skip: input.skip,
      take: input.take,
    });
  }

  countBlocksForOrganization(input: {
    organizationId: string;
    archived: boolean;
  }) {
    return this._block.model.contentStudioDesignBlock.count({
      where: {
        organizationId: input.organizationId,
        archivedAt: input.archived ? { not: null } : null,
      },
    });
  }

  getBlockForOrganization(organizationId: string, id: string) {
    return this._block.model.contentStudioDesignBlock.findFirst({
      where: {
        id,
        organizationId,
      },
      select: BLOCK,
    });
  }

  createBlock(input: {
    id: string;
    organizationId: string;
    name: string;
    description: string | null;
    createdById: string;
    block: StoredBlock;
  }) {
    return this._block.model.contentStudioDesignBlock.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        name: input.name,
        description: input.description,
        schemaVersion: input.block.schemaVersion,
        content: input.block.content,
        contentHash: input.block.contentHash,
        createdById: input.createdById,
      },
      select: BLOCK,
    });
  }

  // Only an active block of the organization
  updateBlock(
    organizationId: string,
    id: string,
    details: {
      name?: string;
      description?: string | null;
      block?: StoredBlock;
    }
  ) {
    return this._block.model.contentStudioDesignBlock.updateMany({
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
        ...(details.block
          ? {
              schemaVersion: details.block.schemaVersion,
              content: details.block.content,
              contentHash: details.block.contentHash,
            }
          : {}),
      },
    });
  }

  archiveBlock(organizationId: string, id: string, archivedAt: Date) {
    return this._block.model.contentStudioDesignBlock.updateMany({
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

  restoreBlock(organizationId: string, id: string) {
    return this._block.model.contentStudioDesignBlock.updateMany({
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
