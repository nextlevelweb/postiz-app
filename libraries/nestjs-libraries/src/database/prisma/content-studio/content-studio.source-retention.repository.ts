import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ContentStudioSourceRetentionDryRunError } from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';

// A read that failed for the database itself: the snapshot timed out
// (P2028), or its connection or the engine failed. Never a write conflict:
// nothing here writes
const isSnapshotFailure = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError ||
  err instanceof Prisma.PrismaClientUnknownRequestError ||
  err instanceof Prisma.PrismaClientInitializationError ||
  err instanceof Prisma.PrismaClientRustPanicError;

const snapshotFailed = (err: unknown) =>
  isSnapshotFailure(err)
    ? new ContentStudioSourceRetentionDryRunError(
        'RETENTION_DRY_RUN_SNAPSHOT_FAILED'
      )
    : err;

// Every read source version protection (P8-R1A) and the retention dry run
// (P8-R1B) make, through the one transaction they are given: the
// organization's sources of every kind, archived or not, with what decides
// which of their versions they need; its package drafts and revisions
// (archived packages too) and reviews of revisions, in any state, with what
// names a version; its AI operations in any status with their context; and
// the versions of some of its sources, whole, with what tells a capture and
// its age, never their blocks. Pages are in id order after an id
const snapshotReads = (tx: Prisma.TransactionClient) => ({
  countVersions(organizationId: string) {
    return tx.contentStudioSourceVersion.count({
      where: { organizationId },
    });
  },

  listSources(input: {
    organizationId: string;
    afterId: string | null;
    take: number;
  }) {
    return tx.contentStudioSource.findMany({
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
        kind: true,
        latestVersionNumber: true,
        lastPageChangeAt: true,
        lastPageChangeVersionNumber: true,
        lastPageChangeKind: true,
        lastPageChangePreviousCaptureAt: true,
      },
      take: input.take,
    });
  },

  listPackageDrafts(input: {
    organizationId: string;
    afterId: string | null;
    take: number;
  }) {
    return tx.contentPackage.findMany({
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
  },

  // which revision each review reviews: its claims and approvals are that
  // revision's
  listPackageReviews(input: {
    organizationId: string;
    afterId: string | null;
    take: number;
  }) {
    return tx.contentStudioReview.findMany({
      where: {
        organizationId: input.organizationId,
        packageRevisionId: { not: null },
        ...(input.afterId ? { id: { gt: input.afterId } } : {}),
      },
      orderBy: {
        id: 'asc',
      },
      select: {
        id: true,
        organizationId: true,
        packageRevisionId: true,
      },
      take: input.take,
    });
  },

  listPackageRevisions(input: {
    organizationId: string;
    afterId: string | null;
    take: number;
  }) {
    return tx.contentPackageRevision.findMany({
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
  },

  listOperationContexts(input: {
    organizationId: string;
    afterId: string | null;
    take: number;
  }) {
    return tx.contentStudioAIOperation.findMany({
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
        context: true,
      },
      take: input.take,
    });
  },

  // every version of these sources, by source, oldest first
  listVersionsOfSources(input: {
    organizationId: string;
    sourceIds: string[];
  }) {
    return tx.contentStudioSourceVersion.findMany({
      where: {
        organizationId: input.organizationId,
        sourceId: { in: input.sourceIds },
      },
      orderBy: [{ sourceId: 'asc' }, { versionNumber: 'asc' }],
      select: {
        id: true,
        organizationId: true,
        sourceId: true,
        versionNumber: true,
        contentHash: true,
        title: true,
        extractionVersion: true,
        fetchedAt: true,
        createdAt: true,
      },
    });
  },

  // a version of the organization whose source is another organization's:
  // the only version the reads by source cannot reach
  findVersionOfOtherOrganizationSource(organizationId: string) {
    return tx.contentStudioSourceVersion.findFirst({
      where: {
        organizationId,
        source: { organizationId: { not: organizationId } },
      },
      orderBy: {
        id: 'asc',
      },
      select: {
        id: true,
      },
    });
  },
});

export type ContentStudioSourceRetentionSnapshotReads = ReturnType<
  typeof snapshotReads
>;

// The read model of source version protection and the retention dry run.
// It only reads: every read of an evaluation is in one RepeatableRead
// transaction, so the whole organization is read as it was at one moment,
// whatever is captured or saved meanwhile. That transaction only reads and
// holds no row lock; it may last up to two minutes. After it, only the
// blocks of the candidates are read, to be measured
@Injectable()
export class ContentStudioSourceRetentionRepository {
  constructor(
    private _version: PrismaRepository<'contentStudioSourceVersion'>,
    private _transaction: PrismaTransaction
  ) {}

  async readSnapshot<T>(
    work: (reads: ContentStudioSourceRetentionSnapshotReads) => Promise<T>
  ): Promise<T> {
    try {
      return await this._transaction.model.$transaction(
        (tx) => work(snapshotReads(tx)),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          maxWait: 5_000,
          timeout: 120_000,
        }
      );
    } catch (err) {
      throw snapshotFailed(err);
    }
  }

  // The blocks of these versions of the organization, to measure them
  async listVersionContents(input: { organizationId: string; ids: string[] }) {
    try {
      return await this._version.model.contentStudioSourceVersion.findMany({
        where: {
          organizationId: input.organizationId,
          id: { in: input.ids },
        },
        select: {
          id: true,
          content: true,
        },
      });
    } catch (err) {
      throw snapshotFailed(err);
    }
  }
}
