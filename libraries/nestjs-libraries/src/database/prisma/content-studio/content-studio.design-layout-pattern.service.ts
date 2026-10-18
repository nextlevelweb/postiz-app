import { HttpException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ContentStudioDesignLayoutPatternRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-layout-pattern.repository';
import { ContentStudioDesignReferenceService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.design-reference.service';
import {
  ContentStudioDesignLayoutPatternContentV1,
  ContentStudioDesignLayoutPatternError,
  DESIGN_LAYOUT_PATTERN_DESCRIPTION_MAX,
  DESIGN_LAYOUT_PATTERN_NAME_MAX,
  parseContentStudioDesignLayoutPatternContent,
} from '@gitroom/nestjs-libraries/content-studio/design/design.layout.pattern';
import {
  ContentStudioDesignLayoutPatternIntegrityError,
  parseVerifiedContentStudioDesignLayoutPattern,
  storedContentStudioDesignLayoutPattern,
} from '@gitroom/nestjs-libraries/content-studio/design/design.layout.pattern.stored';
import {
  ContentStudioSystemDesignLayoutPattern,
  listContentStudioSystemDesignLayoutPatterns,
} from '@gitroom/nestjs-libraries/content-studio/design/design.system.layout.patterns';

// Fixed messages only: never pattern names, layers, ids, zod or Prisma
// errors. A pattern of another organization is a plain 404
const notFound = () =>
  new HttpException(
    { msg: 'Layout pattern not found.', code: 'CS_NOT_FOUND' },
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
const patternInvalid = () =>
  new HttpException(
    {
      msg: 'The layout pattern is invalid.',
      code: 'CS_DESIGN_LAYOUT_PATTERN_INVALID',
    },
    400
  );
const patternTooLarge = () =>
  new HttpException(
    {
      msg: 'The layout pattern is too large.',
      code: 'CS_DESIGN_LAYOUT_PATTERN_TOO_LARGE',
    },
    413
  );
const patternArchived = () =>
  new HttpException(
    {
      msg: 'This layout pattern is archived.',
      code: 'CS_DESIGN_LAYOUT_PATTERN_ARCHIVED',
    },
    409
  );
const mediaInvalid = () =>
  new HttpException(
    {
      msg: 'An image of this layout pattern cannot be used.',
      code: 'CS_DESIGN_LAYOUT_PATTERN_MEDIA_INVALID',
    },
    400
  );
const integrityError = () =>
  new HttpException(
    {
      msg: 'Stored layout pattern data could not be read safely.',
      code: 'CS_DESIGN_LAYOUT_PATTERN_INTEGRITY_ERROR',
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

// Pattern ids are Prisma uuid() values; anything else cannot exist (a
// built-in id is "system:…" and is never a row)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// the editor lists a page of patterns at a time
const PAGE_SIZE = 50;
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

interface PatternRow {
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

// A built-in pattern as the catalog shows it: never archived or changed
const systemSummary = (pattern: ContentStudioSystemDesignLayoutPattern) => ({
  source: 'system' as const,
  id: pattern.id,
  name: pattern.name,
  description: pattern.description,
  archivedAt: null as Date | null,
  contentHash: pattern.contentHash,
  content: pattern.content,
});

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

// Design layout patterns: reusable arrangements of layers, of one
// organization (rows) or built in (code, the same everywhere, never changed
// by a route). Every member may create, change, archive, restore and use the
// organization's patterns: no role, plan or billing check. A pattern is
// Layout Pattern v1 only, checked by its parser (which checks every layer as
// Design Document v1 does) and stored as canonical JSON with its hash; every
// image in it must be the organization's ready Media with exactly its
// stored bytes when it is written. The editor inserts a pattern by copying
// its layers into the draft under new ids; nothing here touches a design, a
// template, a Brand Kit or a render, and a change to a pattern reaches no
// design that used it before
@Injectable()
export class ContentStudioDesignLayoutPatternService {
  constructor(
    private _contentStudioDesignLayoutPatternRepository: ContentStudioDesignLayoutPatternRepository,
    private _contentStudioDesignReferenceService: ContentStudioDesignReferenceService
  ) {}

  // The built-in patterns (not when archived ones are asked for) and one
  // page of the organization's
  async listPatterns(input: {
    organizationId: string;
    archived: boolean;
    page: number;
  }) {
    const filter = {
      organizationId: input.organizationId,
      archived: input.archived,
    };
    const [rows, count] = await Promise.all([
      this._contentStudioDesignLayoutPatternRepository.listPatternsForOrganization(
        {
          ...filter,
          skip: (input.page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
        }
      ),
      this._contentStudioDesignLayoutPatternRepository.countPatternsForOrganization(
        filter
      ),
    ]);
    return {
      system: input.archived
        ? []
        : listContentStudioSystemDesignLayoutPatterns().map(systemSummary),
      pages: Math.ceil(count / PAGE_SIZE),
      results: rows.map((row) => this.patternDetail(row)),
    };
  }

  async createPattern(input: {
    organizationId: string;
    userId: string;
    name: unknown;
    description: unknown;
    content: unknown;
  }) {
    const name = plainText(
      input.name,
      DESIGN_LAYOUT_PATTERN_NAME_MAX,
      true
    ) as string;
    const description = this.description(input.description);
    const content = this.parseContent(input.content);
    await this.assertMedia(input.organizationId, content);
    const row =
      await this._contentStudioDesignLayoutPatternRepository.createPattern({
        id: randomUUID(),
        organizationId: input.organizationId,
        name,
        description,
        createdById: input.userId,
        pattern: storedContentStudioDesignLayoutPattern(content),
      });
    return this.patternDetail(row);
  }

  // The name, the description and the layers of an active pattern, in
  // place. Designs that used the pattern before keep their own copied layers
  async updatePattern(
    organizationId: string,
    id: string,
    input: { name: unknown; description: unknown; content: unknown }
  ) {
    const name = plainText(input.name, DESIGN_LAYOUT_PATTERN_NAME_MAX, false);
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
      throw patternArchived();
    }
    if (content) {
      await this.assertMedia(organizationId, content);
    }
    const { count } =
      await this._contentStudioDesignLayoutPatternRepository.updatePattern(
        organizationId,
        id,
        {
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
          ...(content
            ? { pattern: storedContentStudioDesignLayoutPattern(content) }
            : {}),
        }
      );
    const row = await this.getRow(organizationId, id);
    if (count === 0) {
      // archived meanwhile
      throw patternArchived();
    }
    return this.patternDetail(row);
  }

  // Archiving an archived pattern (or restoring an active one) changes
  // nothing and returns it as it is
  async archivePattern(organizationId: string, id: string) {
    this.assertId(id);
    await this._contentStudioDesignLayoutPatternRepository.archivePattern(
      organizationId,
      id,
      new Date()
    );
    return this.patternDetail(await this.getRow(organizationId, id));
  }

  async restorePattern(organizationId: string, id: string) {
    this.assertId(id);
    await this._contentStudioDesignLayoutPatternRepository.restorePattern(
      organizationId,
      id
    );
    return this.patternDetail(await this.getRow(organizationId, id));
  }

  private parseContent(input: unknown) {
    try {
      return parseContentStudioDesignLayoutPatternContent(input);
    } catch (err) {
      if (err instanceof ContentStudioDesignLayoutPatternError) {
        throw err.code === 'TOO_LARGE' ? patternTooLarge() : patternInvalid();
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
    content: ContentStudioDesignLayoutPatternContentV1
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
    return (
      plainText(value, DESIGN_LAYOUT_PATTERN_DESCRIPTION_MAX, false) || null
    );
  }

  private assertId(id: unknown) {
    if (typeof id !== 'string' || !UUID.test(id)) {
      throw notFound();
    }
  }

  private async getRow(organizationId: string, id: string) {
    this.assertId(id);
    const row =
      await this._contentStudioDesignLayoutPatternRepository.getPatternForOrganization(
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
  private patternDetail(row: PatternRow) {
    let content;
    try {
      content = parseVerifiedContentStudioDesignLayoutPattern(row);
    } catch (err) {
      if (err instanceof ContentStudioDesignLayoutPatternIntegrityError) {
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
