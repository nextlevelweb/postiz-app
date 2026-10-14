import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ContentStudioEditorialPolicyRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.editorial-policy.repository';
import {
  ContentStudioEditorialPolicyContentV1,
  ContentStudioEditorialPolicyError,
  parseContentStudioEditorialPolicyContent,
} from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy';
import {
  ContentStudioEditorialPolicyIntegrityError,
  parseVerifiedContentStudioEditorialPolicyRevision,
  storedContentStudioEditorialPolicyContent,
} from '@gitroom/nestjs-libraries/content-studio/editorial/editorial.policy.revision';

// Fixed messages only: never policy text, ids, zod or Prisma errors. The codes
// are the generic CS_PROFILE_* ones of the Writing Profiles. A policy cannot be
// archived, so there is no archived error
const notFound = () =>
  new HttpException(
    { msg: 'Editorial policy revision not found.', code: 'CS_NOT_FOUND' },
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
const policyInvalid = () =>
  new HttpException(
    { msg: 'The editorial policy is invalid.', code: 'CS_PROFILE_INVALID' },
    400
  );
const policyTooLarge = () =>
  new HttpException(
    {
      msg: 'The editorial policy is too large.',
      code: 'CS_PROFILE_TOO_LARGE',
    },
    400
  );
const revisionConflict = (currentRevisionNumber: number) =>
  new HttpException(
    {
      msg: 'The editorial policy changed. Reload it and try again.',
      code: 'CS_PROFILE_REVISION_CONFLICT',
      currentRevisionNumber,
    },
    409
  );
const integrityError = () =>
  new HttpException(
    {
      msg: 'Stored editorial policy data could not be verified.',
      code: 'CS_PROFILE_INTEGRITY_ERROR',
    },
    500
  );
const saveFailed = () =>
  new HttpException(
    {
      msg: 'The editorial policy could not be saved.',
      code: 'CS_PROFILE_SAVE_FAILED',
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
// number: the policy moved on, so it is the same conflict
const isUniqueConstraintError = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

interface RevisionRow {
  id: string;
  revisionNumber: number;
  schemaVersion: number;
  contentHash: string;
  createdAt: Date;
}

// Built field by field: no policy, organization, creator id or stored text
// leaves
const revisionSummary = (row: RevisionRow) => ({
  id: row.id,
  revisionNumber: row.revisionNumber,
  schemaVersion: row.schemaVersion,
  contentHash: row.contentHash,
  createdAt: row.createdAt,
});

// The one editorial policy of an organization. It does not exist until its
// first save, and is addressed by the organization alone. Every member may
// read and revise it: no role, plan or billing check. It is entered by hand
// and is context for later generation and review, not a compliance check;
// nothing here calls an AI provider
@Injectable()
export class ContentStudioEditorialPolicyService {
  constructor(
    private _contentStudioEditorialPolicyRepository: ContentStudioEditorialPolicyRepository
  ) {}

  // Before the first save there is no policy and nothing is created: revision
  // number 0 and no current revision
  async getPolicy(organizationId: string) {
    const policy =
      await this._contentStudioEditorialPolicyRepository.getPolicyForOrganization(
        organizationId
      );
    if (!policy) {
      return { latestRevisionNumber: 0, currentRevision: null };
    }
    const current =
      await this._contentStudioEditorialPolicyRepository.getRevisionByNumber(
        organizationId,
        policy.id,
        policy.latestRevisionNumber
      );
    if (!current) {
      throw integrityError();
    }
    return {
      latestRevisionNumber: policy.latestRevisionNumber,
      currentRevision: this.revisionDetail(current),
    };
  }

  // Saves the policy over the revision the editor started from: 0 for the
  // first save, which creates the policy with revision 1. Content equal to the
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
    const stored = storedContentStudioEditorialPolicyContent(content);

    if (baseRevisionNumber === 0) {
      return this.createFirstRevision(input, content, stored);
    }

    let result;
    try {
      result =
        await this._contentStudioEditorialPolicyRepository.createRevisionWithCompareAndSwap(
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
        // the policy moved on inside the transaction: tell where it is now
        throw revisionConflict(await this.currentRevisionNumber(input));
    }
  }

  // Newest first. Before the first save the history is empty
  async listRevisions(input: { organizationId: string; page: number }) {
    const policy =
      await this._contentStudioEditorialPolicyRepository.getPolicyForOrganization(
        input.organizationId
      );
    if (!policy) {
      return { pages: 0, results: [] };
    }
    const [rows, count] = await Promise.all([
      this._contentStudioEditorialPolicyRepository.listRevisionsForPolicy({
        organizationId: input.organizationId,
        policyId: policy.id,
        skip: (input.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this._contentStudioEditorialPolicyRepository.countRevisionsForPolicy(
        input.organizationId,
        policy.id
      ),
    ]);
    return {
      pages: Math.ceil(count / PAGE_SIZE),
      results: rows.map(revisionSummary),
    };
  }

  // A revision of this organization's policy only
  async getRevision(input: { organizationId: string; revisionId: string }) {
    if (typeof input.revisionId !== 'string' || !UUID.test(input.revisionId)) {
      throw notFound();
    }
    const policy =
      await this._contentStudioEditorialPolicyRepository.getPolicyForOrganization(
        input.organizationId
      );
    if (!policy) {
      throw notFound();
    }
    const row =
      await this._contentStudioEditorialPolicyRepository.getRevisionForPolicy(
        input.organizationId,
        policy.id,
        input.revisionId
      );
    if (!row) {
      throw notFound();
    }
    return this.revisionDetail(row);
  }

  // Only when the organization has no policy yet. Two first saves at once:
  // the unique organizationId lets one through, the other is a conflict with
  // the revision that won
  private async createFirstRevision(
    input: { organizationId: string; userId: string },
    content: ContentStudioEditorialPolicyContentV1,
    stored: ReturnType<typeof storedContentStudioEditorialPolicyContent>
  ) {
    const existing =
      await this._contentStudioEditorialPolicyRepository.getPolicyForOrganization(
        input.organizationId
      );
    if (existing) {
      throw revisionConflict(existing.latestRevisionNumber);
    }
    let created;
    try {
      created =
        await this._contentStudioEditorialPolicyRepository.createPolicyWithFirstRevision(
          {
            policyId: randomUUID(),
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
      latestRevisionNumber: created.policy.latestRevisionNumber,
    };
  }

  private async currentRevisionNumber(input: { organizationId: string }) {
    const policy =
      await this._contentStudioEditorialPolicyRepository.getPolicyForOrganization(
        input.organizationId
      );
    return policy ? policy.latestRevisionNumber : 0;
  }

  private parseContent(input: unknown) {
    try {
      return parseContentStudioEditorialPolicyContent(input);
    } catch (err) {
      if (err instanceof ContentStudioEditorialPolicyError) {
        throw err.code === 'TOO_LARGE' ? policyTooLarge() : policyInvalid();
      }
      throw err;
    }
  }

  // A revision must still be exactly what was stored; anything else is
  // reported, never repaired, and never quoted
  private revisionDetail(row: RevisionRow & { content: string }) {
    let content;
    try {
      content = parseVerifiedContentStudioEditorialPolicyRevision(row);
    } catch (err) {
      if (err instanceof ContentStudioEditorialPolicyIntegrityError) {
        throw integrityError();
      }
      throw err;
    }
    return { ...revisionSummary(row), content };
  }
}
