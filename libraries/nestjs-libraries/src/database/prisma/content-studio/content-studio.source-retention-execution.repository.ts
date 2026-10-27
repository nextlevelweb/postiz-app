import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  ContentStudioSourceVersionRetentionExecutionError,
  ContentStudioSourceVersionRetentionExecutionStatus,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';

// A unique key taken by another row
const isTaken = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// The items of an execution are written this many at a time
const ITEMS_PER_WRITE = 1_000;

// Every write of an execution ends within this, and waits this long at most
// for a connection: removing a batch of the largest versions included
const WRITE_TRANSACTION = { maxWait: 5_000, timeout: 30_000 };

const batchFailed = (detail: string) =>
  new ContentStudioSourceVersionRetentionExecutionError(
    'RETENTION_EXECUTION_BATCH_FAILED',
    detail
  );

const EXECUTION = {
  id: true,
  organizationId: true,
  planHash: true,
  policyMode: true,
  policyOlderThan: true,
  planEvaluationNow: true,
  planValidUntil: true,
  status: true,
  plannedCount: true,
  sourceCount: true,
  deletedCount: true,
  batchCount: true,
  errorCode: true,
  integrityCheck: true,
  backupConfirmedAt: true,
  quarantinedAt: true,
  readyAt: true,
  executionStartedAt: true,
  finishedAt: true,
} as const;

const ITEM = {
  sourceVersionId: true,
  sourceId: true,
  versionNumber: true,
  contentHash: true,
} as const;

// One version an execution planned to remove, as its plan named it
export interface ContentStudioSourceRetentionExecutionItem {
  sourceVersionId: string;
  sourceId: string;
  versionNumber: number;
  contentHash: string;
}

// The retention execution (P8-R1C): its ledger, its items and the lock of
// the organization's one active execution, and the one removal of source
// versions there is. Ids, hashes, counts, times and statuses only: no
// content, title or URL is read or written here but the removal itself.
// Statuses only move by compare-and-swap; an execution ends, and its lock
// goes, in one transaction. Nothing here decides what may be removed: the
// execution service does, from the retention engine
@Injectable()
export class ContentStudioSourceRetentionExecutionRepository {
  constructor(
    private _execution: PrismaRepository<'contentStudioSourceVersionRetentionExecution'>,
    private _item: PrismaRepository<'contentStudioSourceVersionRetentionExecutionItem'>,
    private _lock: PrismaRepository<'contentStudioSourceVersionRetentionExecutionLock'>,
    private _pending: PrismaRepository<'contentStudioSourceVersionRetentionPending'>,
    private _version: PrismaRepository<'contentStudioSourceVersion'>,
    private _transaction: PrismaTransaction
  ) {}

  // The execution of a plan with its items, preparing, and the
  // organization's lock, all or none. A plan prepared before, whatever its
  // end, is ALREADY_RUN; an organization with an execution that has not
  // ended is ALREADY_ACTIVE
  createExecution(input: {
    organizationId: string;
    planHash: string;
    policyMode: string;
    policyOlderThan: Date;
    planEvaluationNow: Date;
    planValidUntil: Date;
    dryRunFormatVersion: number;
    protectionVersion: number;
    policyVersion: number;
    executionFormatVersion: number;
    sourceCount: number;
    items: readonly ContentStudioSourceRetentionExecutionItem[];
  }) {
    return this._transaction.model.$transaction(async (tx) => {
      let execution: { id: string };
      try {
        execution =
          await tx.contentStudioSourceVersionRetentionExecution.create({
            data: {
              organizationId: input.organizationId,
              planHash: input.planHash,
              policyMode: input.policyMode,
              policyOlderThan: input.policyOlderThan,
              planEvaluationNow: input.planEvaluationNow,
              planValidUntil: input.planValidUntil,
              dryRunFormatVersion: input.dryRunFormatVersion,
              protectionVersion: input.protectionVersion,
              policyVersion: input.policyVersion,
              executionFormatVersion: input.executionFormatVersion,
              status: 'preparing',
              plannedCount: input.items.length,
              sourceCount: input.sourceCount,
            },
            select: {
              id: true,
            },
          });
      } catch (err) {
        if (isTaken(err)) {
          throw new ContentStudioSourceVersionRetentionExecutionError(
            'RETENTION_EXECUTION_ALREADY_RUN'
          );
        }
        throw err;
      }
      try {
        await tx.contentStudioSourceVersionRetentionExecutionLock.create({
          data: {
            organizationId: input.organizationId,
            executionId: execution.id,
          },
          select: {
            id: true,
          },
        });
      } catch (err) {
        if (isTaken(err)) {
          throw new ContentStudioSourceVersionRetentionExecutionError(
            'RETENTION_EXECUTION_ALREADY_ACTIVE'
          );
        }
        throw err;
      }
      for (let i = 0; i < input.items.length; i += ITEMS_PER_WRITE) {
        await tx.contentStudioSourceVersionRetentionExecutionItem.createMany({
          data: input.items.slice(i, i + ITEMS_PER_WRITE).map((item) => ({
            organizationId: input.organizationId,
            executionId: execution.id,
            sourceVersionId: item.sourceVersionId,
            sourceId: item.sourceId,
            versionNumber: item.versionNumber,
            contentHash: item.contentHash,
            status: 'planned',
          })),
        });
      }
      return execution;
    }, WRITE_TRANSACTION);
  }

  getExecution(id: string) {
    return this._execution.model.contentStudioSourceVersionRetentionExecution.findUnique(
      {
        where: {
          id,
        },
        select: {
          ...EXECUTION,
          lock: {
            select: {
              executionId: true,
            },
          },
        },
      }
    );
  }

  // The organization's active execution, by its lock
  getActiveExecution(organizationId: string) {
    return this._lock.model.contentStudioSourceVersionRetentionExecutionLock.findUnique(
      {
        where: {
          organizationId,
        },
        select: {
          executionId: true,
        },
      }
    );
  }

  // Every item of the execution, in canonical order
  listItems(input: {
    executionId: string;
    organizationId: string;
    status: 'planned' | 'deleted';
  }) {
    return this._item.model.contentStudioSourceVersionRetentionExecutionItem.findMany(
      {
        where: {
          executionId: input.executionId,
          organizationId: input.organizationId,
          status: input.status,
        },
        orderBy: [
          { sourceId: 'asc' },
          { versionNumber: 'asc' },
          { sourceVersionId: 'asc' },
        ],
        select: ITEM,
      }
    );
  }

  // How many of the organization's held versions are held for another plan
  countOtherPlanPending(input: { organizationId: string; planHash: string }) {
    return this._pending.model.contentStudioSourceVersionRetentionPending.count(
      {
        where: {
          organizationId: input.organizationId,
          planHash: { not: input.planHash },
        },
      }
    );
  }

  // preparing -> prepared, once every candidate is held
  markPrepared(input: {
    id: string;
    organizationId: string;
    quarantinedAt: Date;
    readyAt: Date;
  }) {
    return this._execution.model.contentStudioSourceVersionRetentionExecution.updateMany(
      {
        where: {
          id: input.id,
          organizationId: input.organizationId,
          status: 'preparing',
        },
        data: {
          status: 'prepared',
          quarantinedAt: input.quarantinedAt,
          readyAt: input.readyAt,
        },
      }
    );
  }

  // prepared -> executing: one execute wins, the operator's word that a
  // backup was made is recorded with it
  startExecuting(input: {
    id: string;
    organizationId: string;
    now: Date;
    hostname: string | null;
  }) {
    return this._execution.model.contentStudioSourceVersionRetentionExecution.updateMany(
      {
        where: {
          id: input.id,
          organizationId: input.organizationId,
          status: 'prepared',
        },
        data: {
          status: 'executing',
          backupConfirmedAt: input.now,
          executionStartedAt: input.now,
          hostname: input.hostname,
        },
      }
    );
  }

  // An execution ends: its terminal status, from one it still has with as
  // many versions removed as when it was read, and its lock removed, in one
  // transaction; false, and nothing written, when it moved meanwhile
  finishExecution(input: {
    id: string;
    organizationId: string;
    from: readonly ContentStudioSourceVersionRetentionExecutionStatus[];
    deletedCount: number;
    status: Extract<
      ContentStudioSourceVersionRetentionExecutionStatus,
      'completed' | 'cancelled' | 'aborted' | 'partial'
    >;
    errorCode: string | null;
    integrityCheck: 'passed' | 'failed' | null;
    finishedAt: Date;
  }) {
    return this._transaction.model
      .$transaction(async (tx) => {
        const { count } =
          await tx.contentStudioSourceVersionRetentionExecution.updateMany({
            where: {
              id: input.id,
              organizationId: input.organizationId,
              status: { in: [...input.from] },
              deletedCount: input.deletedCount,
            },
            data: {
              status: input.status,
              errorCode: input.errorCode,
              integrityCheck: input.integrityCheck,
              finishedAt: input.finishedAt,
            },
          });
        const unlocked =
          await tx.contentStudioSourceVersionRetentionExecutionLock.deleteMany({
            where: {
              organizationId: input.organizationId,
              executionId: input.id,
            },
          });
        if (count !== 1 || unlocked.count !== 1) {
          throw new ContentStudioSourceVersionRetentionExecutionError(
            'RETENTION_EXECUTION_STATE_INVALID'
          );
        }
        return true;
      }, WRITE_TRANSACTION)
      .catch((err: unknown) => {
        if (err instanceof ContentStudioSourceVersionRetentionExecutionError) {
          return false;
        }
        throw err;
      });
  }

  // Removes one batch of an execution's held versions: the only removal of
  // a source version there is. One transaction, every step checked against
  // the batch, or nothing at all:
  //  1. the execution is executing, and 2. holds the organization's lock
  //  3. every item is still planned, and 4. every version still held for
  //     the execution's plan
  //  5. every version is there exactly as its item names it (source,
  //     number, blocks hash), and 6. is not its source's latest
  //  7. its held rows are removed first (the key onto the version is
  //     Restrict), then 8. the versions, of the organization by id
  //  9. the items are marked deleted with the batch and time, and 10. the
  //     execution counts them
  // Any count that is not the batch's throws, and the batch is rolled back
  // whole: no state where a version is there but not held, or gone but not
  // recorded, is ever committed
  deleteQuarantinedSourceVersionsForRetention(input: {
    executionId: string;
    organizationId: string;
    planHash: string;
    batchNumber: number;
    sourceVersionIds: readonly string[];
    deletedAt: Date;
  }) {
    const ids = [...new Set(input.sourceVersionIds)];
    const size = ids.length;
    if (!size || size !== input.sourceVersionIds.length) {
      throw batchFailed('BATCH_INVALID');
    }
    return this._transaction.model.$transaction(async (tx) => {
      const execution =
        await tx.contentStudioSourceVersionRetentionExecution.findFirst({
          where: {
            id: input.executionId,
            organizationId: input.organizationId,
            status: 'executing',
          },
          select: {
            id: true,
          },
        });
      const lock =
        await tx.contentStudioSourceVersionRetentionExecutionLock.findFirst({
          where: {
            organizationId: input.organizationId,
            executionId: input.executionId,
          },
          select: {
            id: true,
          },
        });
      if (!execution || !lock) {
        throw batchFailed('NOT_EXECUTING');
      }

      const items =
        await tx.contentStudioSourceVersionRetentionExecutionItem.findMany({
          where: {
            executionId: input.executionId,
            organizationId: input.organizationId,
            sourceVersionId: { in: ids },
            status: 'planned',
          },
          select: ITEM,
        });
      if (items.length !== size) {
        throw batchFailed('ITEMS_CHANGED');
      }
      const held = await tx.contentStudioSourceVersionRetentionPending.count({
        where: {
          organizationId: input.organizationId,
          planHash: input.planHash,
          sourceVersionId: { in: ids },
        },
      });
      if (held !== size) {
        throw batchFailed('NOT_HELD');
      }

      const versions = await tx.contentStudioSourceVersion.findMany({
        where: {
          organizationId: input.organizationId,
          id: { in: ids },
        },
        select: {
          id: true,
          sourceId: true,
          versionNumber: true,
          contentHash: true,
        },
      });
      const byId = new Map(versions.map((version) => [version.id, version]));
      if (
        versions.length !== size ||
        items.some((item) => {
          const version = byId.get(item.sourceVersionId);
          return (
            !version ||
            version.sourceId !== item.sourceId ||
            version.versionNumber !== item.versionNumber ||
            version.contentHash !== item.contentHash
          );
        })
      ) {
        throw batchFailed('VERSION_CHANGED');
      }
      const sources = await tx.contentStudioSource.findMany({
        where: {
          organizationId: input.organizationId,
          id: { in: [...new Set(items.map((item) => item.sourceId))] },
        },
        select: {
          id: true,
          latestVersionNumber: true,
        },
      });
      const latest = new Map(
        sources.map((source) => [source.id, source.latestVersionNumber])
      );
      if (
        items.some(
          (item) => !(item.versionNumber < (latest.get(item.sourceId) ?? 0))
        )
      ) {
        throw batchFailed('LATEST');
      }

      const released =
        await tx.contentStudioSourceVersionRetentionPending.deleteMany({
          where: {
            organizationId: input.organizationId,
            planHash: input.planHash,
            sourceVersionId: { in: ids },
          },
        });
      if (released.count !== size) {
        throw batchFailed('NOT_HELD');
      }
      const removed = await tx.contentStudioSourceVersion.deleteMany({
        where: {
          organizationId: input.organizationId,
          id: { in: ids },
        },
      });
      if (removed.count !== size) {
        throw batchFailed('VERSION_CHANGED');
      }
      const recorded =
        await tx.contentStudioSourceVersionRetentionExecutionItem.updateMany({
          where: {
            executionId: input.executionId,
            organizationId: input.organizationId,
            sourceVersionId: { in: ids },
            status: 'planned',
          },
          data: {
            status: 'deleted',
            batchNumber: input.batchNumber,
            deletedAt: input.deletedAt,
          },
        });
      if (recorded.count !== size) {
        throw batchFailed('ITEMS_CHANGED');
      }
      const counted =
        await tx.contentStudioSourceVersionRetentionExecution.updateMany({
          where: {
            id: input.executionId,
            organizationId: input.organizationId,
            status: 'executing',
          },
          data: {
            deletedCount: { increment: size },
            batchCount: { increment: 1 },
          },
        });
      if (counted.count !== 1) {
        throw batchFailed('NOT_EXECUTING');
      }
      return { deleted: size };
    }, WRITE_TRANSACTION);
  }

  // What the database holds of some versions of an execution: how many of
  // their items are deleted, how many of the versions are there, and how
  // many are held for its plan. Reads only, after a batch whose outcome is
  // unknown or at the end
  async countState(input: {
    executionId: string;
    organizationId: string;
    planHash: string;
    sourceVersionIds: readonly string[];
  }) {
    const ids = [...input.sourceVersionIds];
    const [deleted, versions, held] = [
      await this._item.model.contentStudioSourceVersionRetentionExecutionItem.count(
        {
          where: {
            executionId: input.executionId,
            organizationId: input.organizationId,
            sourceVersionId: { in: ids },
            status: 'deleted',
          },
        }
      ),
      await this._version.model.contentStudioSourceVersion.count({
        where: {
          organizationId: input.organizationId,
          id: { in: ids },
        },
      }),
      await this._pending.model.contentStudioSourceVersionRetentionPending.count(
        {
          where: {
            organizationId: input.organizationId,
            planHash: input.planHash,
            sourceVersionId: { in: ids },
          },
        }
      ),
    ];
    return { deleted, versions, held };
  }

  // One source of the organization with all its versions, as protection
  // reads them, and how many of these versions are held, in one
  // RepeatableRead snapshot: a capture meanwhile is either all there or not
  readSource(input: {
    organizationId: string;
    sourceId: string;
    sourceVersionIds: readonly string[];
  }) {
    return this._transaction.model.$transaction(
      async (tx) => {
        const source = await tx.contentStudioSource.findFirst({
          where: {
            id: input.sourceId,
            organizationId: input.organizationId,
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
        });
        const versions = await tx.contentStudioSourceVersion.findMany({
          where: {
            organizationId: input.organizationId,
            sourceId: input.sourceId,
          },
          orderBy: {
            versionNumber: 'asc',
          },
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
        const held = await tx.contentStudioSourceVersionRetentionPending.count({
          where: {
            organizationId: input.organizationId,
            sourceVersionId: { in: [...input.sourceVersionIds] },
          },
        });
        return { source, versions, held };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 5_000,
        timeout: 30_000,
      }
    );
  }
}
