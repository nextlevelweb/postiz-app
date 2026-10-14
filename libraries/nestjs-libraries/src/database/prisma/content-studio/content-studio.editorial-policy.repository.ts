import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

const POLICY_SUMMARY = {
  id: true,
  latestRevisionNumber: true,
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

// An organization has at most one editorial policy (organizationId is
// unique), found by the organization and never by an id from a request. Every
// query filters on organizationId itself. The policy row only ever changes its
// latest revision number; revisions are only ever created (with the policy, or
// by the compare-and-swap), never updated or deleted, and nothing is deleted
// at all
@Injectable()
export class ContentStudioEditorialPolicyRepository {
  constructor(
    private _policy: PrismaRepository<'contentStudioEditorialPolicy'>,
    private _revision: PrismaRepository<'contentStudioEditorialPolicyRevision'>,
    private _transaction: PrismaTransaction
  ) {}

  getPolicyForOrganization(organizationId: string) {
    return this._policy.model.contentStudioEditorialPolicy.findUnique({
      where: {
        organizationId,
      },
      select: POLICY_SUMMARY,
    });
  }

  // The first save: the policy and its revision 1, or neither. A second
  // policy for the organization fails on its unique organizationId
  createPolicyWithFirstRevision(input: {
    policyId: string;
    revisionId: string;
    organizationId: string;
    createdById: string;
    revision: StoredRevision;
  }) {
    return this._transaction.model.$transaction(async (tx) => {
      const policy = await tx.contentStudioEditorialPolicy.create({
        data: {
          id: input.policyId,
          organizationId: input.organizationId,
          latestRevisionNumber: 1,
          createdById: input.createdById,
        },
        select: POLICY_SUMMARY,
      });
      const revision = await tx.contentStudioEditorialPolicyRevision.create({
        data: {
          id: input.revisionId,
          organizationId: input.organizationId,
          policyId: input.policyId,
          revisionNumber: 1,
          schemaVersion: input.revision.schemaVersion,
          content: input.revision.content,
          contentHash: input.revision.contentHash,
          createdById: input.createdById,
        },
        select: REVISION_SUMMARY,
      });
      return { policy, revision };
    });
  }

  // Saves a new policy over the revision the editor started from, in one
  // transaction: the organization's policy must still be at that revision.
  // Content equal to that revision makes no new one. The update only matches
  // the expected revision number and holds the policy row until commit, so
  // two saves can never take the same number
  createRevisionWithCompareAndSwap(input: {
    organizationId: string;
    expectedLatestRevisionNumber: number;
    revisionId: string;
    revision: StoredRevision;
    createdById: string;
  }) {
    return this._transaction.model.$transaction(async (tx) => {
      const policy = await tx.contentStudioEditorialPolicy.findUnique({
        where: {
          organizationId: input.organizationId,
        },
        select: POLICY_SUMMARY,
      });
      if (!policy) {
        return { status: 'not-found' as const };
      }
      if (policy.latestRevisionNumber !== input.expectedLatestRevisionNumber) {
        return {
          status: 'conflict' as const,
          currentRevisionNumber: policy.latestRevisionNumber,
        };
      }

      const current = await tx.contentStudioEditorialPolicyRevision.findFirst({
        where: {
          organizationId: input.organizationId,
          policyId: policy.id,
          revisionNumber: input.expectedLatestRevisionNumber,
        },
        select: REVISION_DETAIL,
      });
      if (current && current.contentHash === input.revision.contentHash) {
        return { status: 'unchanged' as const, revision: current };
      }

      const { count } = await tx.contentStudioEditorialPolicy.updateMany({
        where: {
          id: policy.id,
          organizationId: input.organizationId,
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

      const revision = await tx.contentStudioEditorialPolicyRevision.create({
        data: {
          id: input.revisionId,
          organizationId: input.organizationId,
          policyId: policy.id,
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
  listRevisionsForPolicy(input: {
    organizationId: string;
    policyId: string;
    skip: number;
    take: number;
  }) {
    return this._revision.model.contentStudioEditorialPolicyRevision.findMany({
      where: {
        organizationId: input.organizationId,
        policyId: input.policyId,
      },
      orderBy: {
        revisionNumber: 'desc',
      },
      select: REVISION_SUMMARY,
      skip: input.skip,
      take: input.take,
    });
  }

  countRevisionsForPolicy(organizationId: string, policyId: string) {
    return this._revision.model.contentStudioEditorialPolicyRevision.count({
      where: {
        organizationId,
        policyId,
      },
    });
  }

  getRevisionForPolicy(
    organizationId: string,
    policyId: string,
    revisionId: string
  ) {
    return this._revision.model.contentStudioEditorialPolicyRevision.findFirst({
      where: {
        id: revisionId,
        policyId,
        organizationId,
      },
      select: REVISION_DETAIL,
    });
  }

  getRevisionByNumber(
    organizationId: string,
    policyId: string,
    revisionNumber: number
  ) {
    return this._revision.model.contentStudioEditorialPolicyRevision.findFirst({
      where: {
        organizationId,
        policyId,
        revisionNumber,
      },
      select: REVISION_DETAIL,
    });
  }
}
