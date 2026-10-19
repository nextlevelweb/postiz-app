import { HttpException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ContentStudioDesignBlockRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-block.repository';
import { ContentStudioDesignReferenceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-reference.service';
import {
  ContentStudioDesignBlockContentV1,
  ContentStudioDesignBlockError,
  DESIGN_BLOCK_DESCRIPTION_MAX,
  DESIGN_BLOCK_NAME_MAX,
  parseContentStudioDesignBlockContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.block';
import {
  ContentStudioDesignBlockIntegrityError,
  parseVerifiedContentStudioDesignBlock,
  storedContentStudioDesignBlock,
} from '@gitroom/nestjs-libraries/content-studio/design/design.block.stored';

// Fixed messages only: never block names, layers, ids, zod or Prisma
// errors. A block of another organization is a plain 404
const notFound = () =>
  new HttpException(
    { msg: 'Design block not found.', code: 'CS_NOT_FOUND' },
    404
  );
const invalidRequest = () =>
  new HttpException(
    {
      msg: 'The Content Studio request is invalid',
      code: 'CS_INVALID_REQUEST',
    },
    400
  );
const blockInvalid = () =>
  new HttpException(
    {
      msg: 'The design block is invalid.',
      code: 'CS_DESIGN_BLOCK_INVALID',
    },
    400
  );
const blockTooLarge = () =>
  new HttpException(
    {
      msg: 'The design block is too large.',
      code: 'CS_DESIGN_BLOCK_TOO_LARGE',
    },
    413
  );
const blockArchived = () =>
  new HttpException(
    {
      msg: 'This design block is archived.',
      code: 'CS_DESIGN_BLOCK_ARCHIVED',
    },
    409
  );
const mediaInvalid = () =>
  new HttpException(
    {
      msg: 'An image of this design block cannot be used.',
      code: 'CS_DESIGN_BLOCK_MEDIA_INVALID',
    },
    400
  );
const integrityError = () =>
  new HttpException(
    {
      msg: 'Stored design block data could not be read safely.',
      code: 'CS_DESIGN_BLOCK_INTEGRITY_ERROR',
    },
    500
  );

const errorCode = (err: unknown) => {
  if (!(err instanceof HttpException)) {
    return undefined;
  }
  const response = err.getResponse();
  return typeof response === 'object' && response !== null
    ? (response as { code?: unknown }).code
    : undefined;
};

// Block ids are Prisma uuid() values; anything else cannot exist
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// the editor lists a page of blocks at a time
const PAGE_SIZE = 50;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

interface BlockRow {
  id: string;
  name: string;
  description: string | null;
  schemaVersion: number;
  content: string;
  contentHash: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// Line endings normalized, trimmed, within a length, no NUL or unpaired
// surrogate
const plainText = (value: unknown, max: number, required: boolean) => {
  if (value === undefined && !required) {
    return undefined;
  }
  const trimmed =
    typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : null;
  if (
    trimmed === null ||
    (required && !trimmed) ||
    trimmed.length > max ||
    trimmed.includes('\u0000') ||
    UNPAIRED_SURROGATE.test(trimmed)
  ) {
    throw invalidRequest();
  }
  return trimmed;
};

// Design blocks: reusable creative assets, some styled layers of one page
// saved as they are, of one organization only (there are no built-ins).
// Every member may create, change, archive, restore and use the
// organization's blocks: no role, plan or billing check. A block is the
// shared layer snapshot of Layout Pattern v1, checked by its parser (which
// checks every layer as Design Document v1 does) and stored as canonical
// JSON with its hash; every image in it must be the organization's ready
// Media with exactly its stored bytes when it is written. The editor inserts
// a block by copying its layers into the draft under new ids; nothing here
// touches a design, a template, a Brand Kit or a render, and a change to a
// block reaches no design that used it before
@Injectable()
export class ContentStudioDesignBlockService {
  constructor(
    private _contentStudioDesignBlockRepository: ContentStudioDesignBlockRepository,
    private _contentStudioDesignReferenceService: ContentStudioDesignReferenceService
  ) {}

  // One page of the organization's blocks, active or archived
  async listBlocks(input: {
    organizationId: string;
    archived: boolean;
    page: number;
  }) {
    const filter = {
      organizationId: input.organizationId,
      archived: input.archived,
    };
    const [rows, count] = await Promise.all([
      this._contentStudioDesignBlockRepository.listBlocksForOrganization({
        ...filter,
        skip: (input.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this._contentStudioDesignBlockRepository.countBlocksForOrganization(
        filter
      ),
    ]);
    return {
      // there are no built-in blocks: every block is the organization's own
      system: [] as never[],
      pages: Math.ceil(count / PAGE_SIZE),
      results: rows.map((row) => this.blockDetail(row)),
    };
  }

  async createBlock(input: {
    organizationId: string;
    userId: string;
    name: unknown;
    description: unknown;
    content: unknown;
  }) {
    const name = plainText(input.name, DESIGN_BLOCK_NAME_MAX, true) as string;
    const description = this.description(input.description);
    const content = this.parseContent(input.content);
    await this.assertMedia(input.organizationId, content);
    const row = await this._contentStudioDesignBlockRepository.createBlock({
      id: randomUUID(),
      organizationId: input.organizationId,
      name,
      description,
      createdById: input.userId,
      block: storedContentStudioDesignBlock(content),
    });
    return this.blockDetail(row);
  }

  // The name, the description and the layers of an active block, in place.
  // Designs that used the block before keep their own copied layers
  async updateBlock(
    organizationId: string,
    id: string,
    input: { name: unknown; description: unknown; content: unknown }
  ) {
    const name = plainText(input.name, DESIGN_BLOCK_NAME_MAX, false);
    const description =
      input.description === undefined
        ? undefined
        : this.description(input.description);
    const content =
      input.content === undefined
        ? undefined
        : this.parseContent(input.content);
    if (
      name === undefined &&
      description === undefined &&
      content === undefined
    ) {
      throw invalidRequest();
    }
    const current = await this.getRow(organizationId, id);
    if (current.archivedAt) {
      throw blockArchived();
    }
    if (content) {
      await this.assertMedia(organizationId, content);
    }
    const { count } =
      await this._contentStudioDesignBlockRepository.updateBlock(
        organizationId,
        id,
        {
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
          ...(content
            ? { block: storedContentStudioDesignBlock(content) }
            : {}),
        }
      );
    const row = await this.getRow(organizationId, id);
    if (count === 0) {
      // archived meanwhile
      throw blockArchived();
    }
    return this.blockDetail(row);
  }

  // Archiving an archived block (or restoring an active one) changes
  // nothing and returns it as it is
  async archiveBlock(organizationId: string, id: string) {
    this.assertId(id);
    await this._contentStudioDesignBlockRepository.archiveBlock(
      organizationId,
      id,
      new Date()
    );
    return this.blockDetail(await this.getRow(organizationId, id));
  }

  async restoreBlock(organizationId: string, id: string) {
    this.assertId(id);
    await this._contentStudioDesignBlockRepository.restoreBlock(
      organizationId,
      id
    );
    return this.blockDetail(await this.getRow(organizationId, id));
  }

  private parseContent(input: unknown) {
    try {
      return parseContentStudioDesignBlockContent(input);
    } catch (err) {
      if (err instanceof ContentStudioDesignBlockError) {
        throw err.code === 'TOO_LARGE' ? blockTooLarge() : blockInvalid();
      }
      throw err;
    }
  }

  // Every image is exactly what the design reference service makes for
  // that Media item of the organization now: its id and the SHA-256 of its
  // stored bytes. Another organization's or a missing item, or other bytes,
  // is refused. Each distinct item is read once, one after the other
  private async assertMedia(
    organizationId: string,
    content: ContentStudioDesignBlockContentV1
  ) {
    const refs = new Map<string, Set<string>>();
    for (const layer of content.layers) {
      if (layer.type === 'image') {
        const hashes = refs.get(layer.imageRef.mediaId) ?? new Set<string>();
        hashes.add(layer.imageRef.sha256);
        refs.set(layer.imageRef.mediaId, hashes);
      }
    }
    for (const [mediaId, hashes] of Array.from(refs.entries())) {
      let reference;
      try {
        reference =
          await this._contentStudioDesignReferenceService.getMediaReference(
            organizationId,
            mediaId
          );
      } catch (err) {
        if (errorCode(err) === 'CS_NOT_FOUND') {
          throw mediaInvalid();
        }
        throw err;
      }
      if (
        reference.mediaId !== mediaId ||
        hashes.size !== 1 ||
        !hashes.has(reference.sha256)
      ) {
        throw mediaInvalid();
      }
    }
  }

  // Optional; empty is none
  private description(value: unknown) {
    if (value === undefined || value === null) {
      return null;
    }
    return plainText(value, DESIGN_BLOCK_DESCRIPTION_MAX, false) || null;
  }

  private assertId(id: unknown) {
    if (typeof id !== 'string' || !UUID.test(id)) {
      throw notFound();
    }
  }

  private async getRow(organizationId: string, id: string) {
    this.assertId(id);
    const row =
      await this._contentStudioDesignBlockRepository.getBlockForOrganization(
        organizationId,
        id
      );
    if (!row) {
      throw notFound();
    }
    return row;
  }

  // Built field by field: no organization or creator leaves. The stored
  // layers must still be exactly what was written
  private blockDetail(row: BlockRow) {
    let content;
    try {
      content = parseVerifiedContentStudioDesignBlock(row);
    } catch (err) {
      if (err instanceof ContentStudioDesignBlockIntegrityError) {
        throw integrityError();
      }
      throw err;
    }
    return {
      source: 'organization' as const,
      id: row.id,
      name: row.name,
      description: row.description,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      contentHash: row.contentHash,
      content,
    };
  }
}
