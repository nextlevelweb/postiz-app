import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  ContentStudioSourceRetentionDryRunError,
  ContentStudioSourceVersionQuarantineError,
  ContentStudioSourceVersionRetentionPendingError,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';

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
  // whether any version of the organization is held for a retention plan
  // (P8-R1Q)
  findPending(organizationId: string) {
    return tx.contentStudioSourceVersionRetentionPending.findFirst({
      where: { organizationId },
      select: {
        id: true,
      },
    });
  },

  // every held version of the organization with its plan (P8-R1C: the
  // recheck of an execution, whose plan must hold exactly its candidates)
  listPending(organizationId: string) {
    return tx.contentStudioSourceVersionRetentionPending.findMany({
      where: { organizationId },
      select: {
        sourceVersionId: true,
        planHash: true,
      },
    });
  },

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

// The check every write of a new reference to source versions makes (a
// draft's or revision's evidence, an AI operation's sources), in the
// transaction of that write (P8-R1Q, P8-R1C): one statement counting the
// versions that are still there, of the organization and held for no
// retention plan, whatever their number; none for no version. The writer
// found its versions before its transaction, and a retention execution may
// have removed one since (its held row with it, in one transaction): such a
// version is refused exactly like a held one, so a reference to a removed
// version is never written. Held or gone, the same fixed error, never which
// version or why. Never two reads: a version found first and checked for its
// held row after could be removed in between
export const assertContentStudioSourceVersionsExistAndNotPending = async (
  tx: Pick<Prisma.TransactionClient, 'contentStudioSourceVersion'>,
  input: { organizationId: string; sourceVersionIds: readonly string[] }
) => {
  const ids = [...new Set(input.sourceVersionIds)];
  if (!ids.length) {
    return;
  }
  const available = await tx.contentStudioSourceVersion.count({
    where: {
      organizationId: input.organizationId,
      id: { in: ids },
      retentionPending: { is: null },
    },
  });
  if (available !== ids.length) {
    throw new ContentStudioSourceVersionRetentionPendingError();
  }
};

// Holding is one serializable transaction: two plans holding the same
// version, or the same organization, can never both commit. PostgreSQL
// aborts one (P2034, or the unique key, P2002) and it runs again from the
// start, this many times in all, then sees the other plan
const QUARANTINE_TRANSACTION_ATTEMPTS = 3;

const isQuarantineRace = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError &&
  (err.code === 'P2034' || err.code === 'P2002');

const PENDING = {
  sourceVersionId: true,
  planHash: true,
  pendingAt: true,
} as const;

// The read model of source version protection and the retention dry run,
// and the retention quarantine (P8-R1Q). An evaluation only reads: every
// read of it is in one RepeatableRead transaction, so the whole organization
// is read as it was at one moment, whatever is captured or saved meanwhile.
// That transaction only reads and holds no row lock; it may last up to two
// minutes. After it, only the blocks of the candidates are read, to be
// measured. The quarantine writes held rows only: it creates and removes
// them, never changes one, and never writes a version
@Injectable()
export class ContentStudioSourceRetentionRepository {
  constructor(
    private _version: PrismaRepository<'contentStudioSourceVersion'>,
    private _pending: PrismaRepository<'contentStudioSourceVersionRetentionPending'>,
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

  // The held versions of one plan of the organization, by version id
  listPendingForPlan(input: { organizationId: string; planHash: string }) {
    return this._pending.model.contentStudioSourceVersionRetentionPending.findMany(
      {
        where: {
          organizationId: input.organizationId,
          planHash: input.planHash,
        },
        orderBy: {
          sourceVersionId: 'asc',
        },
        select: PENDING,
      }
    );
  }

  // Whether one version of the organization is held, and by which plan
  getPendingForVersion(input: {
    organizationId: string;
    sourceVersionId: string;
  }) {
    return this._pending.model.contentStudioSourceVersionRetentionPending.findUnique(
      {
        where: {
          sourceVersionId_organizationId: {
            sourceVersionId: input.sourceVersionId,
            organizationId: input.organizationId,
          },
        },
        select: PENDING,
      }
    );
  }

  // Holds these versions of the organization for one plan, all or none.
  // Every version must be the organization's (one missing or of another
  // organization fails the call, like a missing one), and no version of the
  // organization may be held for another plan. A version already held for
  // this plan stays as it is, with its first pendingAt; only the others are
  // held, at `now`. Nothing of a version itself is written. The ids must be
  // distinct
  async quarantineVersions(input: {
    organizationId: string;
    sourceVersionIds: readonly string[];
    planHash: string;
    now: Date;
  }) {
    for (
      let attempt = 1;
      attempt <= QUARANTINE_TRANSACTION_ATTEMPTS;
      attempt++
    ) {
      try {
        return await this._transaction.model.$transaction(
          async (tx) => {
            const versions = await tx.contentStudioSourceVersion.findMany({
              where: {
                organizationId: input.organizationId,
                id: { in: [...input.sourceVersionIds] },
              },
              select: {
                id: true,
              },
            });
            if (versions.length !== input.sourceVersionIds.length) {
              throw new ContentStudioSourceVersionQuarantineError(
                'RETENTION_QUARANTINE_VERSION_NOT_FOUND'
              );
            }
            const other =
              await tx.contentStudioSourceVersionRetentionPending.findFirst({
                where: {
                  organizationId: input.organizationId,
                  planHash: { not: input.planHash },
                },
                select: {
                  id: true,
                },
              });
            if (other) {
              throw new ContentStudioSourceVersionQuarantineError(
                'RETENTION_QUARANTINE_PLAN_CONFLICT'
              );
            }
            const held = new Set(
              (
                await tx.contentStudioSourceVersionRetentionPending.findMany({
                  where: {
                    organizationId: input.organizationId,
                    sourceVersionId: { in: [...input.sourceVersionIds] },
                  },
                  select: {
                    sourceVersionId: true,
                  },
                })
              ).map((row) => row.sourceVersionId)
            );
            const { count } =
              await tx.contentStudioSourceVersionRetentionPending.createMany({
                data: input.sourceVersionIds
                  .filter((id) => !held.has(id))
                  .map((sourceVersionId) => ({
                    organizationId: input.organizationId,
                    sourceVersionId,
                    planHash: input.planHash,
                    pendingAt: input.now,
                  })),
              });
            return { created: count, alreadyPending: held.size };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          }
        );
      } catch (err) {
        if (!isQuarantineRace(err)) {
          throw err;
        }
      }
    }
    throw new ContentStudioSourceVersionQuarantineError(
      'RETENTION_QUARANTINE_CONFLICT'
    );
  }

  // Releases versions of the organization held for this plan: these ones,
  // or all of the plan's. Only held rows are removed, never a version, and
  // never a row of another plan or organization; a version not held for
  // the plan is no error
  releaseQuarantine(input: {
    organizationId: string;
    planHash: string;
    sourceVersionIds?: readonly string[];
  }) {
    return this._pending.model.contentStudioSourceVersionRetentionPending.deleteMany(
      {
        where: {
          organizationId: input.organizationId,
          planHash: input.planHash,
          ...(input.sourceVersionIds
            ? { sourceVersionId: { in: [...input.sourceVersionIds] } }
            : {}),
        },
      }
    );
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
