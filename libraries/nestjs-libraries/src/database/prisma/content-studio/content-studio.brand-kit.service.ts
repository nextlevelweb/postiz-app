import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ContentStudioBrandKitRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.brand-kit.repository';
import {
  ContentStudioBrandKitContentV1,
  ContentStudioBrandKitError,
  ContentStudioBrandKitTooLargeError,
  parseContentStudioBrandKitContent,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit';
import {
  ContentStudioBrandKitIntegrityError,
  parseVerifiedContentStudioBrandKitRevision,
  storedContentStudioBrandKitContent,
} from '@gitroom/nestjs-libraries/content-studio/brand/brand.kit.revision';

// Fixed messages only: never Brand Kit text, ids, zod or Prisma errors. A kit
// cannot be archived, so there is no archived error
const notFound = () =>
  new HttpException(
    { msg: 'Brand Kit revision not found.', code: 'CS_NOT_FOUND' },
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
const brandKitInvalid = () =>
  new HttpException(
    { msg: 'The Brand Kit is invalid.', code: 'CS_BRAND_KIT_INVALID' },
    400
  );
const brandKitTooLarge = () =>
  new HttpException(
    { msg: 'The Brand Kit is too large.', code: 'CS_BRAND_KIT_TOO_LARGE' },
    400
  );
const revisionConflict = (currentRevisionNumber: number) =>
  new HttpException(
    {
      msg: 'The Brand Kit changed. Reload it and try again.',
      code: 'CS_BRAND_KIT_REVISION_CONFLICT',
      currentRevisionNumber,
    },
    409
  );
const integrityError = () =>
  new HttpException(
    {
      msg: 'Stored Brand Kit data could not be read safely.',
      code: 'CS_BRAND_KIT_INTEGRITY_ERROR',
    },
    500
  );
const saveFailed = () =>
  new HttpException(
    {
      msg: 'The Brand Kit could not be saved.',
      code: 'CS_BRAND_KIT_SAVE_FAILED',
    },
    500
  );

// Revision ids are Prisma uuid() values; anything else cannot exist
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// revision numbers are PostgreSQL integers
const INT4_MAX = 2_147_483_647;
// the page size of every Content Studio list
const PAGE_SIZE = 20;

// A second first save for the organization, or two saves taking the same
// number: the kit moved on, so it is the same conflict
const isUniqueConstraintError = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

interface RevisionRow {
  id: string;
  revisionNumber: number;
  schemaVersion: number;
  contentHash: string;
  createdAt: Date;
}

// Built field by field: no kit id, organization, creator id or stored text
// leaves
const revisionSummary = (row: RevisionRow) => ({
  id: row.id,
  revisionNumber: row.revisionNumber,
  schemaVersion: row.schemaVersion,
  contentHash: row.contentHash,
  createdAt: row.createdAt,
});

// The one Brand Kit of an organization. It does not exist until its first
// save, and is addressed by the organization alone. Every member may read and
// revise it: no role, plan or billing check. It is entered by hand: nothing
// here calls an AI provider, reads the organization's name, fetches anything
// or touches Media. Later design documents refer to an exact revision
@Injectable()
export class ContentStudioBrandKitService {
  constructor(
    private _contentStudioBrandKitRepository: ContentStudioBrandKitRepository
  ) {}

  // Before the first save there is no kit and nothing is created: revision
  // number 0 and no current revision
  async getBrandKit(organizationId: string) {
    const brandKit =
      await this._contentStudioBrandKitRepository.getBrandKitForOrganization(
        organizationId
      );
    if (!brandKit) {
      return { latestRevisionNumber: 0, currentRevision: null };
    }
    const current =
      await this._contentStudioBrandKitRepository.getRevisionByNumber(
        organizationId,
        brandKit.id,
        brandKit.latestRevisionNumber
      );
    if (!current) {
      throw integrityError();
    }
    return {
      latestRevisionNumber: brandKit.latestRevisionNumber,
      currentRevision: this.revisionDetail(current),
    };
  }

  // Saves the kit over the revision the editor started from: 0 for the first
  // save, which creates the kit with revision 1. Content equal to the
  // current revision returns it instead of a copy; a stale base is a conflict
  // even when the content is the same
  async createRevision(input: {
    organizationId: string;
    userId: string;
    baseRevisionNumber: unknown;
    content: unknown;
  }) {
    if (
      !Number.isSafeInteger(input.baseRevisionNumber) ||
      (input.baseRevisionNumber as number) < 0 ||
      (input.baseRevisionNumber as number) > INT4_MAX
    ) {
      throw invalidRequest();
    }
    const baseRevisionNumber = input.baseRevisionNumber as number;
    const content = this.parseContent(input.content);
    const stored = storedContentStudioBrandKitContent(content);

    if (baseRevisionNumber === 0) {
      return this.createFirstRevision(input, content, stored);
    }

    let result;
    try {
      result =
        await this._contentStudioBrandKitRepository.createRevisionWithCompareAndSwap(
          {
            organizationId: input.organizationId,
            expectedLatestRevisionNumber: baseRevisionNumber,
            revisionId: randomUUID(),
            revision: stored,
            createdById: input.userId,
          }
        );
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        throw err;
      }
      result = { status: 'changed' as const };
    }

    switch (result.status) {
      case 'created':
        return {
          created: true,
          revision: { ...revisionSummary(result.revision), content },
          latestRevisionNumber: result.revision.revisionNumber,
        };
      case 'unchanged': {
        // verified before it counts as unchanged: a corrupted current
        // revision is an integrity error, never created: false
        const revision = this.revisionDetail(result.revision);
        return {
          created: false,
          revision,
          latestRevisionNumber: revision.revisionNumber,
        };
      }
      case 'not-found':
        throw revisionConflict(0);
      case 'conflict':
        throw revisionConflict(result.currentRevisionNumber);
      default:
        // the kit moved on inside the transaction: tell where it is now
        throw revisionConflict(await this.currentRevisionNumber(input));
    }
  }

  // Newest first. Before the first save the history is empty
  async listRevisions(input: { organizationId: string; page: number }) {
    const brandKit =
      await this._contentStudioBrandKitRepository.getBrandKitForOrganization(
        input.organizationId
      );
    if (!brandKit) {
      return { pages: 0, results: [] };
    }
    const [rows, count] = await Promise.all([
      this._contentStudioBrandKitRepository.listRevisionsForBrandKit({
        organizationId: input.organizationId,
        brandKitId: brandKit.id,
        skip: (input.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this._contentStudioBrandKitRepository.countRevisionsForBrandKit(
        input.organizationId,
        brandKit.id
      ),
    ]);
    return {
      pages: Math.ceil(count / PAGE_SIZE),
      results: rows.map(revisionSummary),
    };
  }

  // A revision of this organization's kit only
  async getRevision(input: { organizationId: string; revisionId: string }) {
    if (typeof input.revisionId !== 'string' || !UUID.test(input.revisionId)) {
      throw notFound();
    }
    const brandKit =
      await this._contentStudioBrandKitRepository.getBrandKitForOrganization(
        input.organizationId
      );
    if (!brandKit) {
      throw notFound();
    }
    const row =
      await this._contentStudioBrandKitRepository.getRevisionForBrandKit(
        input.organizationId,
        brandKit.id,
        input.revisionId
      );
    if (!row) {
      throw notFound();
    }
    return this.revisionDetail(row);
  }

  // Only when the organization has no kit yet. Two first saves at once:
  // the unique organizationId lets one through, the other is a conflict with
  // the revision that won
  private async createFirstRevision(
    input: { organizationId: string; userId: string },
    content: ContentStudioBrandKitContentV1,
    stored: ReturnType<typeof storedContentStudioBrandKitContent>
  ) {
    const existing =
      await this._contentStudioBrandKitRepository.getBrandKitForOrganization(
        input.organizationId
      );
    if (existing) {
      throw revisionConflict(existing.latestRevisionNumber);
    }
    let created;
    try {
      created =
        await this._contentStudioBrandKitRepository.createBrandKitWithFirstRevision(
          {
            brandKitId: randomUUID(),
            revisionId: randomUUID(),
            organizationId: input.organizationId,
            createdById: input.userId,
            revision: stored,
          }
        );
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        throw err;
      }
      const current = await this.currentRevisionNumber(input);
      if (current === 0) {
        throw saveFailed();
      }
      throw revisionConflict(current);
    }
    return {
      created: true,
      revision: { ...revisionSummary(created.revision), content },
      latestRevisionNumber: created.brandKit.latestRevisionNumber,
    };
  }

  private async currentRevisionNumber(input: { organizationId: string }) {
    const brandKit =
      await this._contentStudioBrandKitRepository.getBrandKitForOrganization(
        input.organizationId
      );
    return brandKit ? brandKit.latestRevisionNumber : 0;
  }

  private parseContent(input: unknown) {
    try {
      return parseContentStudioBrandKitContent(input);
    } catch (err) {
      if (err instanceof ContentStudioBrandKitTooLargeError) {
        throw brandKitTooLarge();
      }
      if (err instanceof ContentStudioBrandKitError) {
        throw brandKitInvalid();
      }
      throw err;
    }
  }

  // A revision must still be exactly what was stored; anything else is
  // reported, never repaired, and never quoted
  private revisionDetail(row: RevisionRow & { content: string }) {
    let content;
    try {
      content = parseVerifiedContentStudioBrandKitRevision(row);
    } catch (err) {
      if (err instanceof ContentStudioBrandKitIntegrityError) {
        throw integrityError();
      }
      throw err;
    }
    return { ...revisionSummary(row), content };
  }
}
