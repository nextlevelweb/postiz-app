import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ContentStudioSourceRetentionExecutionItem,
  ContentStudioSourceRetentionExecutionRepository,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention-execution.repository';
import { ContentStudioSourceRetentionService } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.source-retention.service';
import {
  batchContentStudioSourceVersionRetentionCandidates,
  checkContentStudioSourceAfterRetention,
  CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
  CONTENT_STUDIO_SOURCE_VERSION_PICKER_WINDOW,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_FORMAT_VERSION,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_EXECUTION_FORMAT_VERSION,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_POLICY_VERSION,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_PROTECTION_VERSION,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_QUARANTINE_BATCH_SIZE,
  CONTENT_STUDIO_SOURCE_VERSION_RETENTION_QUARANTINE_WAIT_MS,
  ContentStudioSourceRetentionIntegrityError,
  ContentStudioSourceVersionQuarantineError,
  ContentStudioSourceVersionRetentionExecutionError,
  ContentStudioSourceVersionRetentionExecutionErrorCode,
  ContentStudioSourceVersionRetentionExecutionStatus,
  contentStudioSourceVersionRetainedRuns,
  contentStudioSourceVersionRetentionErrorCode,
  contentStudioSourceVersionRetentionReadyAt,
  isContentStudioSourceVersionRetentionExecutionTerminal,
  parseContentStudioSourceVersionRetentionPlan,
} from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A batch whose transaction was aborted by a concurrent write is tried
// again from its first step, this many times in all. Any other failure of
// the database leaves its outcome unknown: it is read back, never retried
const BATCH_TRANSACTION_ATTEMPTS = 3;

const isWriteConflict = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';

const refused = (
  code: ContentStudioSourceVersionRetentionExecutionErrorCode,
  detail: string | null = null
) => new ContentStudioSourceVersionRetentionExecutionError(code, detail);

// What a failure was, by code or model and id only: never content
const detailOf = (err: unknown) => {
  if (err instanceof ContentStudioSourceVersionRetentionExecutionError) {
    return err.detail ?? err.code;
  }
  if (err instanceof ContentStudioSourceRetentionIntegrityError) {
    return `RETENTION_INTEGRITY_ERROR ${err.reference.type} ${err.reference.id}`;
  }
  if (err instanceof ContentStudioSourceVersionQuarantineError) {
    return err.code;
  }
  return (
    contentStudioSourceVersionRetentionErrorCode(err) ??
    (err instanceof Prisma.PrismaClientKnownRequestError
      ? err.code
      : 'DATABASE_FAILED')
  );
};

// How a command of an execution ended
export type ContentStudioSourceVersionRetentionExecutionOutcome =
  | 'nothing_to_delete'
  | 'prepared'
  | 'not_ready'
  | 'completed'
  | 'cancelled'
  | 'aborted'
  | 'partial'
  // held versions could not be released: the execution and its lock stay
  | 'cleanup_required'
  // another command ended the execution while this one ran
  | 'interrupted';

// The exit code of a command for its outcome: 0 done, 1 nothing removed
// and nothing left to clean up, 2 an operator must look
export const contentStudioSourceVersionRetentionExecutionExitCode = (
  outcome: ContentStudioSourceVersionRetentionExecutionOutcome
) =>
  ['nothing_to_delete', 'prepared', 'completed', 'cancelled'].includes(outcome)
    ? 0
    : ['not_ready', 'aborted'].includes(outcome)
    ? 1
    : 2;

type Execution = NonNullable<
  Awaited<
    ReturnType<ContentStudioSourceRetentionExecutionRepository['getExecution']>
  >
>;

type Clock = () => Date;

// The retention execution (P8-R1C), for an operator's command only: no
// route, schedule or agent reaches it. prepare checks a reviewed dry-run
// plan, makes its dry run again at the time it was made for (the same hash,
// or nothing happens), records it with its items and the organization's
// lock, and holds its candidates; execute, once the wait after the last hold
// is over and while the plan is valid, checks every candidate again in one
// snapshot (at the plan's time and now) and removes them in batches, each
// with its held rows and its items in one transaction, checking each source
// once its candidates are gone and the whole organization at the end;
// cancel releases what is held and ends the execution. Nothing is resumed,
// retried after an unknown outcome, or removed beyond the plan: any failure
// stops, releases what is still held and records how far it went. The time
// is the operator's clock, read when each step needs it
@Injectable()
export class ContentStudioSourceRetentionExecutionService {
  constructor(
    private _contentStudioSourceRetentionExecutionRepository: ContentStudioSourceRetentionExecutionRepository,
    private _contentStudioSourceRetentionService: ContentStudioSourceRetentionService
  ) {}

  async prepare(input: { organizationId: string; plan: string; clock: Clock }) {
    const plan = parseContentStudioSourceVersionRetentionPlan(
      input.plan,
      input.organizationId
    );
    if (!plan.candidates.length) {
      // nothing is recorded, held or locked
      return {
        outcome: 'nothing_to_delete' as const,
        executionId: null,
        organizationId: plan.organizationId,
        planHash: plan.planHash,
        status: null,
        plannedCount: 0,
        sourceCount: 0,
        deletedCount: 0,
        batchCount: 0,
        errorCode: null,
        detail: null,
        integrityCheck: null,
        planEvaluationNow: plan.evaluationNow.toISOString(),
        validUntil: plan.validUntil.toISOString(),
        quarantinedAt: null,
        readyAt: null,
        backupConfirmedAt: null,
        executionStartedAt: null,
        finishedAt: null,
      };
    }
    const now = input.clock();
    if (plan.evaluationNow.getTime() > now.getTime()) {
      throw refused('RETENTION_EXECUTION_PLAN_INVALID');
    }
    if (
      !(
        now.getTime() +
          CONTENT_STUDIO_SOURCE_VERSION_RETENTION_QUARANTINE_WAIT_MS <
        plan.validUntil.getTime()
      )
    ) {
      throw refused('RETENTION_EXECUTION_PLAN_EXPIRED');
    }

    let created: { id: string };
    try {
      created =
        await this._contentStudioSourceRetentionExecutionRepository.createExecution(
          {
            organizationId: plan.organizationId,
            planHash: plan.planHash,
            policyMode: plan.policy.mode,
            policyOlderThan: plan.policy.olderThan,
            planEvaluationNow: plan.evaluationNow,
            planValidUntil: plan.validUntil,
            dryRunFormatVersion:
              CONTENT_STUDIO_SOURCE_VERSION_RETENTION_DRY_RUN_FORMAT_VERSION,
            protectionVersion:
              CONTENT_STUDIO_SOURCE_VERSION_RETENTION_PROTECTION_VERSION,
            policyVersion:
              CONTENT_STUDIO_SOURCE_VERSION_RETENTION_POLICY_VERSION,
            executionFormatVersion:
              CONTENT_STUDIO_SOURCE_VERSION_RETENTION_EXECUTION_FORMAT_VERSION,
            sourceCount: plan.sourceCount,
            items: plan.candidates.map((candidate) => ({
              sourceVersionId: candidate.id,
              sourceId: candidate.sourceId,
              versionNumber: candidate.versionNumber,
              contentHash: candidate.contentHash,
            })),
          }
        );
    } catch (err) {
      if (
        err instanceof ContentStudioSourceVersionRetentionExecutionError &&
        err.code === 'RETENTION_EXECUTION_ALREADY_ACTIVE'
      ) {
        // the execution to cancel, by id
        const active =
          await this._contentStudioSourceRetentionExecutionRepository.getActiveExecution(
            plan.organizationId
          );
        throw refused(
          'RETENTION_EXECUTION_ALREADY_ACTIVE',
          active ? `execution ${active.executionId}` : null
        );
      }
      throw err;
    }
    const execution = await this.load(created.id);

    // the reviewed dry run, made again at the time it was made for: the
    // same hash, or nothing is held
    let replayed: string | null = null;
    let replayFailure: string | null = null;
    try {
      replayed = (
        await this._contentStudioSourceRetentionService.evaluateRetentionPlan({
          organizationId: plan.organizationId,
          now: plan.evaluationNow,
          policy: plan.policy,
        })
      ).dryRunHash;
    } catch (err) {
      replayFailure = detailOf(err);
    }
    if (replayed !== plan.planHash) {
      return this.abort(
        execution,
        'RETENTION_EXECUTION_HASH_MISMATCH',
        replayFailure,
        input.clock
      );
    }

    // every candidate held, a batch at a time, each at the time it is held
    const ids = plan.candidates.map((candidate) => candidate.id);
    try {
      for (
        let i = 0;
        i < ids.length;
        i += CONTENT_STUDIO_SOURCE_VERSION_RETENTION_QUARANTINE_BATCH_SIZE
      ) {
        await this._contentStudioSourceRetentionService.quarantineSourceVersions(
          {
            organizationId: plan.organizationId,
            sourceVersionIds: ids.slice(
              i,
              i + CONTENT_STUDIO_SOURCE_VERSION_RETENTION_QUARANTINE_BATCH_SIZE
            ),
            planHash: plan.planHash,
            now: input.clock(),
          }
        );
      }
    } catch (err) {
      return this.abort(
        execution,
        'RETENTION_EXECUTION_QUARANTINE_FAILED',
        detailOf(err),
        input.clock
      );
    }

    // exactly the candidates, held for this plan, and nothing for another
    const held =
      await this._contentStudioSourceRetentionService.listSourceVersionQuarantine(
        { organizationId: plan.organizationId, planHash: plan.planHash }
      );
    const planned = new Set(ids);
    if (
      held.length !== planned.size ||
      held.some((row) => !planned.has(row.sourceVersionId)) ||
      (await this._contentStudioSourceRetentionExecutionRepository.countOtherPlanPending(
        { organizationId: plan.organizationId, planHash: plan.planHash }
      )) !== 0
    ) {
      return this.abort(
        execution,
        'RETENTION_EXECUTION_QUARANTINE_FAILED',
        'PENDING_MISMATCH',
        input.clock
      );
    }
    // the wait runs from the LAST hold: a writer that checked that version
    // just before it was held may still be writing until then
    const readyAt = contentStudioSourceVersionRetentionReadyAt(
      held.map((row) => row.pendingAt)
    );
    if (!(readyAt.getTime() < plan.validUntil.getTime())) {
      return this.abort(
        execution,
        'RETENTION_EXECUTION_PLAN_EXPIRED',
        null,
        input.clock
      );
    }
    const { count } =
      await this._contentStudioSourceRetentionExecutionRepository.markPrepared({
        id: execution.id,
        organizationId: execution.organizationId,
        quarantinedAt: input.clock(),
        readyAt,
      });
    if (count !== 1) {
      // cancelled meanwhile: what this command held after is released too
      await this.release(execution);
      return this.interrupted(execution.id);
    }
    return this.report(execution.id, 'prepared');
  }

  async execute(input: {
    executionId: string;
    clock: Clock;
    hostname: string | null;
  }) {
    const execution = await this.find(input.executionId);
    if (
      isContentStudioSourceVersionRetentionExecutionTerminal(execution.status)
    ) {
      throw refused('RETENTION_EXECUTION_ALREADY_RUN');
    }
    if (execution.status === 'preparing' || execution.status === 'executing') {
      throw refused('RETENTION_EXECUTION_ALREADY_ACTIVE');
    }
    if (
      execution.status !== 'prepared' ||
      execution.lock?.executionId !== execution.id ||
      !execution.readyAt
    ) {
      throw refused('RETENTION_EXECUTION_STATE_INVALID');
    }
    const now = input.clock();
    if (now.getTime() < execution.readyAt.getTime()) {
      return this.report(execution.id, 'not_ready', {
        errorCode: 'RETENTION_EXECUTION_NOT_READY',
      });
    }
    if (!(now.getTime() < execution.planValidUntil.getTime())) {
      return this.abort(
        execution,
        'RETENTION_EXECUTION_PLAN_EXPIRED',
        null,
        input.clock
      );
    }
    const { count } =
      await this._contentStudioSourceRetentionExecutionRepository.startExecuting(
        {
          id: execution.id,
          organizationId: execution.organizationId,
          now,
          hostname: input.hostname,
        }
      );
    if (count !== 1) {
      throw refused('RETENTION_EXECUTION_ALREADY_ACTIVE');
    }
    const executing = await this.load(execution.id);

    // the fresh check of every candidate, in one snapshot, before anything
    // is removed: any one that is not still a candidate ends the plan
    const items =
      await this._contentStudioSourceRetentionExecutionRepository.listItems({
        executionId: execution.id,
        organizationId: execution.organizationId,
        status: 'planned',
      });
    const recheckNow = input.clock();
    if (!(recheckNow.getTime() < execution.planValidUntil.getTime())) {
      return this.stop(
        executing,
        'RETENTION_EXECUTION_PLAN_EXPIRED',
        null,
        input.clock
      );
    }
    let kept: Awaited<
      ReturnType<ContentStudioSourceRetentionService['recheckRetentionPlan']>
    >;
    try {
      if (items.length !== execution.plannedCount) {
        throw refused('RETENTION_EXECUTION_RECHECK_FAILED', 'ITEMS_CHANGED');
      }
      kept =
        await this._contentStudioSourceRetentionService.recheckRetentionPlan({
          organizationId: execution.organizationId,
          planHash: execution.planHash,
          planEvaluationNow: execution.planEvaluationNow,
          now: recheckNow,
          policy: {
            mode: execution.policyMode,
            olderThan: execution.policyOlderThan,
          },
          candidates: items.map((item) => ({
            id: item.sourceVersionId,
            sourceId: item.sourceId,
            versionNumber: item.versionNumber,
            contentHash: item.contentHash,
          })),
        });
    } catch (err) {
      return this.stop(
        executing,
        'RETENTION_EXECUTION_RECHECK_FAILED',
        detailOf(err),
        input.clock
      );
    }

    const left = new Map<string, ContentStudioSourceRetentionExecutionItem[]>();
    for (const item of items) {
      const list = left.get(item.sourceId);
      if (list) {
        list.push(item);
      } else {
        left.set(item.sourceId, [item]);
      }
    }
    const remaining = new Map(
      [...left].map(([sourceId, list]) => [sourceId, list.length])
    );
    const batches = batchContentStudioSourceVersionRetentionCandidates(
      items.map((item) => ({ ...item, id: item.sourceVersionId }))
    );
    for (const [index, batch] of batches.entries()) {
      const removed = await this.removeBatch(
        executing,
        batch.map((item) => item.sourceVersionId),
        index + 1,
        input.clock
      );
      if (removed.failure) {
        return this.stop(
          executing,
          removed.failure.code,
          removed.failure.detail,
          input.clock
        );
      }
      // each source whose last candidates went in this batch
      for (const item of batch) {
        remaining.set(item.sourceId, remaining.get(item.sourceId)! - 1);
      }
      for (const sourceId of new Set(batch.map((item) => item.sourceId))) {
        if (remaining.get(sourceId) !== 0) {
          continue;
        }
        const failure = await this.checkSource(
          executing,
          sourceId,
          left.get(sourceId)!,
          kept.get(sourceId),
          input.clock()
        );
        if (failure) {
          return this.stop(
            executing,
            'RETENTION_EXECUTION_INTEGRITY_FAILED',
            failure,
            input.clock
          );
        }
      }
    }

    // every candidate gone, nothing held, and the whole organization intact
    const ids = items.map((item) => item.sourceVersionId);
    const state =
      await this._contentStudioSourceRetentionExecutionRepository.countState({
        executionId: execution.id,
        organizationId: execution.organizationId,
        planHash: execution.planHash,
        sourceVersionIds: ids,
      });
    const intact =
      state.deleted === ids.length &&
      state.versions === 0 &&
      state.held === 0 &&
      (await this.organizationIntact(executing, input.clock()));
    if (!intact) {
      return this.stop(
        executing,
        'RETENTION_EXECUTION_INTEGRITY_FAILED',
        'ORGANIZATION',
        input.clock
      );
    }
    const finished = await this.finish(executing, {
      status: 'completed',
      errorCode: null,
      integrityCheck: 'passed',
      deletedCount: ids.length,
      finishedAt: input.clock(),
    });
    return finished
      ? this.report(execution.id, 'completed')
      : this.interrupted(execution.id);
  }

  // Ends an execution that has not ended, wherever it stopped: everything
  // still held for its plan is released, and it is cancelled, or partial
  // when versions were removed already (then the organization is checked).
  // Removes no version. Again on an execution that ended is STATE_INVALID
  async cancel(input: { executionId: string; clock: Clock }) {
    const execution = await this.find(input.executionId);
    if (
      isContentStudioSourceVersionRetentionExecutionTerminal(
        execution.status
      ) ||
      execution.lock?.executionId !== execution.id
    ) {
      throw refused('RETENTION_EXECUTION_STATE_INVALID');
    }
    const held =
      await this._contentStudioSourceRetentionService.listSourceVersionQuarantine(
        {
          organizationId: execution.organizationId,
          planHash: execution.planHash,
        }
      );
    const cancelled = {
      previousStatus: execution.status,
      releasedCount: held.length,
      oldestPendingAt: held.length
        ? new Date(
            Math.min(...held.map((row) => row.pendingAt.getTime()))
          ).toISOString()
        : null,
    };
    if (!(await this.release(execution))) {
      return this.report(execution.id, 'cleanup_required', {
        ...cancelled,
        errorCode: 'RETENTION_EXECUTION_CLEANUP_REQUIRED',
      });
    }
    const deleted = execution.deletedCount;
    const integrity = deleted
      ? await this.integrity(execution, input.clock())
      : null;
    const finished = await this.finish(execution, {
      status: deleted ? 'partial' : 'cancelled',
      errorCode:
        integrity === 'failed' ? 'RETENTION_EXECUTION_INTEGRITY_FAILED' : null,
      integrityCheck: integrity,
      deletedCount: deleted,
      finishedAt: input.clock(),
    });
    return finished
      ? this.report(execution.id, deleted ? 'partial' : 'cancelled', cancelled)
      : this.interrupted(execution.id);
  }

  // One batch removed, or why not. A write conflict is tried again from the
  // start; any other failure of the database is read back, never tried
  // again: committed or not, the execution stops after it
  private async removeBatch(
    execution: Execution,
    sourceVersionIds: string[],
    batchNumber: number,
    clock: Clock
  ): Promise<{
    failure: {
      code: ContentStudioSourceVersionRetentionExecutionErrorCode;
      detail: string;
    } | null;
  }> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this._contentStudioSourceRetentionExecutionRepository.deleteQuarantinedSourceVersionsForRetention(
          {
            executionId: execution.id,
            organizationId: execution.organizationId,
            planHash: execution.planHash,
            batchNumber,
            sourceVersionIds,
            deletedAt: clock(),
          }
        );
        return { failure: null };
      } catch (err) {
        if (err instanceof ContentStudioSourceVersionRetentionExecutionError) {
          return {
            failure: {
              code: 'RETENTION_EXECUTION_BATCH_FAILED',
              detail: detailOf(err),
            },
          };
        }
        if (isWriteConflict(err) && attempt < BATCH_TRANSACTION_ATTEMPTS) {
          continue;
        }
        if (isWriteConflict(err)) {
          return {
            failure: {
              code: 'RETENTION_EXECUTION_BATCH_FAILED',
              detail: 'WRITE_CONFLICT',
            },
          };
        }
      }
      // the outcome is unknown: what the database holds says it
      const state =
        await this._contentStudioSourceRetentionExecutionRepository.countState({
          executionId: execution.id,
          organizationId: execution.organizationId,
          planHash: execution.planHash,
          sourceVersionIds,
        });
      const size = sourceVersionIds.length;
      if (state.deleted === size && state.versions === 0 && state.held === 0) {
        return {
          failure: {
            code: 'RETENTION_EXECUTION_BATCH_FAILED',
            detail: 'UNKNOWN_OUTCOME_COMMITTED',
          },
        };
      }
      if (
        state.deleted === 0 &&
        state.versions === size &&
        state.held === size
      ) {
        return {
          failure: {
            code: 'RETENTION_EXECUTION_BATCH_FAILED',
            detail: 'UNKNOWN_OUTCOME_NOT_COMMITTED',
          },
        };
      }
      return {
        failure: {
          code: 'RETENTION_EXECUTION_INTEGRITY_FAILED',
          detail: 'UNKNOWN_OUTCOME_INCONSISTENT',
        },
      };
    }
  }

  // Why a source whose candidates are all removed does not read as it
  // should, or null
  private async checkSource(
    execution: Execution,
    sourceId: string,
    items: readonly ContentStudioSourceRetentionExecutionItem[],
    expected:
      | ReturnType<typeof contentStudioSourceVersionRetainedRuns>
      | undefined,
    now: Date
  ) {
    try {
      const ids = items.map((item) => item.sourceVersionId);
      const read =
        await this._contentStudioSourceRetentionExecutionRepository.readSource({
          organizationId: execution.organizationId,
          sourceId,
          sourceVersionIds: ids,
        });
      if (!read.source || !expected) {
        return 'SOURCE_MISSING';
      }
      if (read.held !== 0) {
        return 'CANDIDATE_HELD';
      }
      return checkContentStudioSourceAfterRetention({
        source: read.source,
        versions: read.versions,
        removedIds: new Set(ids),
        expected,
        now,
        inFlightMs: CONTENT_STUDIO_SOURCE_VERSION_IN_FLIGHT_MS,
        pickerWindow: CONTENT_STUDIO_SOURCE_VERSION_PICKER_WINDOW,
      });
    } catch (err) {
      return detailOf(err);
    }
  }

  // Whether every protection of the whole organization still resolves:
  // every reference names a version that is there, every source its latest
  // version and page change
  private async organizationIntact(execution: Execution, now: Date) {
    try {
      await this._contentStudioSourceRetentionService.computeProtectionMap({
        organizationId: execution.organizationId,
        now,
      });
      return true;
    } catch {
      return false;
    }
  }

  // After versions were removed: the organization intact, no version of a
  // deleted item left, and nothing held for the plan
  private async integrity(execution: Execution, now: Date) {
    const deleted =
      await this._contentStudioSourceRetentionExecutionRepository.listItems({
        executionId: execution.id,
        organizationId: execution.organizationId,
        status: 'deleted',
      });
    const state =
      await this._contentStudioSourceRetentionExecutionRepository.countState({
        executionId: execution.id,
        organizationId: execution.organizationId,
        planHash: execution.planHash,
        sourceVersionIds: deleted.map((item) => item.sourceVersionId),
      });
    return state.versions === 0 &&
      (await this.organizationIntact(execution, now))
      ? ('passed' as const)
      : ('failed' as const);
  }

  // Everything held for the plan released, and none left
  private async release(execution: Execution) {
    const scope = {
      organizationId: execution.organizationId,
      planHash: execution.planHash,
    };
    try {
      await this._contentStudioSourceRetentionService.releaseSourceVersionQuarantine(
        scope
      );
      return (
        (
          await this._contentStudioSourceRetentionService.listSourceVersionQuarantine(
            scope
          )
        ).length === 0
      );
    } catch {
      return false;
    }
  }

  // Before anything was removed: everything held released, and the
  // execution aborted with its lock removed
  private async abort(
    execution: Execution,
    errorCode: ContentStudioSourceVersionRetentionExecutionErrorCode,
    detail: string | null,
    clock: Clock
  ) {
    if (!(await this.release(execution))) {
      return this.report(execution.id, 'cleanup_required', {
        errorCode: 'RETENTION_EXECUTION_CLEANUP_REQUIRED',
        detail: errorCode,
      });
    }
    const finished = await this.finish(execution, {
      status: 'aborted',
      errorCode,
      integrityCheck: null,
      deletedCount: 0,
      finishedAt: clock(),
    });
    return finished
      ? this.report(execution.id, 'aborted', { detail })
      : this.interrupted(execution.id);
  }

  // An execution that stops while executing: everything still held is
  // released, and it is aborted when nothing was removed, or partial, with
  // the organization checked, when anything was
  private async stop(
    executing: Execution,
    errorCode: ContentStudioSourceVersionRetentionExecutionErrorCode,
    detail: string | null,
    clock: Clock
  ) {
    if (!(await this.release(executing))) {
      return this.report(executing.id, 'cleanup_required', {
        errorCode: 'RETENTION_EXECUTION_CLEANUP_REQUIRED',
        detail: errorCode,
      });
    }
    const { deletedCount } = await this.load(executing.id);
    if (!deletedCount) {
      return this.abort(executing, errorCode, detail, clock);
    }
    // the organization is checked again, but a failed check stays failed
    const integrity = await this.integrity(executing, clock());
    const finished = await this.finish(executing, {
      status: 'partial',
      errorCode,
      integrityCheck:
        errorCode === 'RETENTION_EXECUTION_INTEGRITY_FAILED'
          ? 'failed'
          : integrity,
      deletedCount,
      finishedAt: clock(),
    });
    return finished
      ? this.report(executing.id, 'partial', { detail })
      : this.interrupted(executing.id);
  }

  private finish(
    execution: Execution,
    end: {
      status: 'completed' | 'cancelled' | 'aborted' | 'partial';
      errorCode: ContentStudioSourceVersionRetentionExecutionErrorCode | null;
      integrityCheck: 'passed' | 'failed' | null;
      deletedCount: number;
      finishedAt: Date;
    }
  ) {
    return this._contentStudioSourceRetentionExecutionRepository.finishExecution(
      {
        id: execution.id,
        organizationId: execution.organizationId,
        from: [
          execution.status as ContentStudioSourceVersionRetentionExecutionStatus,
        ],
        ...end,
      }
    );
  }

  private interrupted(id: string) {
    return this.report(id, 'interrupted', {
      errorCode: 'RETENTION_EXECUTION_STATE_INVALID',
    });
  }

  private async find(id: string) {
    const execution = UUID.test(id)
      ? await this._contentStudioSourceRetentionExecutionRepository.getExecution(
          id
        )
      : null;
    if (!execution) {
      throw refused('RETENTION_EXECUTION_STATE_INVALID');
    }
    return execution;
  }

  private async load(id: string) {
    const execution =
      await this._contentStudioSourceRetentionExecutionRepository.getExecution(
        id
      );
    if (!execution) {
      throw refused('RETENTION_EXECUTION_STATE_INVALID');
    }
    return execution;
  }

  // The execution as it is now, with the outcome of this command: ids,
  // counts, times and codes only
  private async report(
    id: string,
    outcome: ContentStudioSourceVersionRetentionExecutionOutcome,
    extra: {
      errorCode?: ContentStudioSourceVersionRetentionExecutionErrorCode;
      detail?: string | null;
      previousStatus?: string;
      releasedCount?: number;
      oldestPendingAt?: string | null;
    } = {}
  ) {
    const execution = await this.load(id);
    const time = (value: Date | null) => (value ? value.toISOString() : null);
    return {
      outcome,
      executionId: execution.id,
      organizationId: execution.organizationId,
      planHash: execution.planHash,
      status: execution.status,
      ...(extra.previousStatus === undefined
        ? {}
        : { previousStatus: extra.previousStatus }),
      plannedCount: execution.plannedCount,
      sourceCount: execution.sourceCount,
      deletedCount: execution.deletedCount,
      batchCount: execution.batchCount,
      ...(extra.releasedCount === undefined
        ? {}
        : {
            releasedCount: extra.releasedCount,
            oldestPendingAt: extra.oldestPendingAt ?? null,
          }),
      errorCode: extra.errorCode ?? execution.errorCode,
      detail: extra.detail ?? null,
      integrityCheck: execution.integrityCheck,
      planEvaluationNow: time(execution.planEvaluationNow),
      validUntil: time(execution.planValidUntil),
      quarantinedAt: time(execution.quarantinedAt),
      readyAt: time(execution.readyAt),
      backupConfirmedAt: time(execution.backupConfirmedAt),
      executionStartedAt: time(execution.executionStartedAt),
      finishedAt: time(execution.finishedAt),
    };
  }
}
