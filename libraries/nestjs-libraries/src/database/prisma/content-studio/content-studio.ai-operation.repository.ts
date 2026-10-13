import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { ContentStudioAIOperationContext } from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.types';

// A new operation, as the execution service checked and hashed it. There is
// no field for a prompt, an instruction or a generated text
export interface ContentStudioAIOperationCreate {
  id: string;
  organizationId: string;
  userId: string;
  connectionId: string;
  packageId: string;
  kind: string;
  provider: string;
  model: string;
  promptVersion: string;
  baseDraftVersion: number;
  context: ContentStudioAIOperationContext;
  requestHash: string;
  startedAt: Date;
}

// One provider attempt, as already sanitized by the caller: counts only the
// provider reported, a cost only with its currency
export interface ContentStudioAIUsageCreate {
  attempt: number;
  provider: string;
  model: string;
  outcome: 'succeeded' | 'failed';
  usageSource: 'provider' | 'none';
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  providerCostMicros: bigint | null;
  costCurrency: string | null;
  providerRequestId: string | null;
}

interface OperationCompletion {
  organizationId: string;
  operationId: string;
  completedAt: Date;
  usage: ContentStudioAIUsageCreate;
}

// Every query filters on organizationId itself. An operation is created
// running and completed once: the completion only matches a running
// operation and writes its usage row in the same transaction, so a completed
// operation is never rewritten and never has a usage row without its result.
// Usage rows are only ever created; nothing is updated or deleted afterwards
@Injectable()
export class ContentStudioAIOperationRepository {
  constructor(
    private _operation: PrismaRepository<'contentStudioAIOperation'>,
    private _transaction: PrismaTransaction
  ) {}

  createRunningOperation(input: ContentStudioAIOperationCreate) {
    return this._operation.model.contentStudioAIOperation.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        userId: input.userId,
        connectionId: input.connectionId,
        packageId: input.packageId,
        kind: input.kind,
        status: 'running',
        provider: input.provider,
        model: input.model,
        promptVersion: input.promptVersion,
        baseDraftVersion: input.baseDraftVersion,
        context: input.context,
        requestHash: input.requestHash,
        startedAt: input.startedAt,
      },
      select: {
        id: true,
      },
    });
  }

  getOperationForOrganization(organizationId: string, id: string) {
    return this._operation.model.contentStudioAIOperation.findFirst({
      where: {
        id,
        organizationId,
      },
      select: {
        id: true,
        userId: true,
        connectionId: true,
        packageId: true,
        kind: true,
        status: true,
        provider: true,
        model: true,
        promptVersion: true,
        baseDraftVersion: true,
        context: true,
        requestHash: true,
        resultHash: true,
        errorCode: true,
        startedAt: true,
        completedAt: true,
      },
    });
  }

  completeSucceededWithUsage(
    input: OperationCompletion & { resultHash: string }
  ) {
    return this.complete(input, {
      status: 'succeeded',
      resultHash: input.resultHash,
      errorCode: null,
    });
  }

  completeFailedWithUsage(input: OperationCompletion & { errorCode: string }) {
    return this.complete(input, {
      status: 'failed',
      resultHash: null,
      errorCode: input.errorCode,
    });
  }

  // The status change comes first: when the operation is no longer running
  // nothing is written. A usage row that cannot be written rolls the status
  // change back, so the operation stays running
  private complete(
    input: OperationCompletion,
    result: {
      status: 'succeeded' | 'failed';
      resultHash: string | null;
      errorCode: string | null;
    }
  ) {
    return this._transaction.model.$transaction(async (tx) => {
      const { count } = await tx.contentStudioAIOperation.updateMany({
        where: {
          id: input.operationId,
          organizationId: input.organizationId,
          status: 'running',
        },
        data: {
          status: result.status,
          resultHash: result.resultHash,
          errorCode: result.errorCode,
          completedAt: input.completedAt,
        },
      });
      if (count !== 1) {
        return { completed: false as const };
      }

      await tx.contentStudioAIUsage.create({
        data: {
          organizationId: input.organizationId,
          operationId: input.operationId,
          attempt: input.usage.attempt,
          provider: input.usage.provider,
          model: input.usage.model,
          outcome: input.usage.outcome,
          usageSource: input.usage.usageSource,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          cachedInputTokens: input.usage.cachedInputTokens,
          reasoningTokens: input.usage.reasoningTokens,
          totalTokens: input.usage.totalTokens,
          providerCostMicros: input.usage.providerCostMicros,
          costCurrency: input.usage.costCurrency,
          providerRequestId: input.usage.providerRequestId,
        },
        select: {
          id: true,
        },
      });
      return { completed: true as const };
    });
  }
}
