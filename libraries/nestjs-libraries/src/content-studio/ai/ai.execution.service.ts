import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import {
  ContentStudioAIOperationRepository,
  ContentStudioAIUsageCreate,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-operation.repository';
import { ContentStudioAIProviderResolver } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.resolver';
import { getContentStudioAIModel } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';
import {
  ContentStudioAIExecutionError,
  ContentStudioAIProviderError,
  safeProviderRequestId,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import {
  ContentStudioAIFinishReason,
  ContentStudioAITextRequest,
  ContentStudioAITextResult,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';
import {
  AI_PROMPT_VERSION,
  ContentStudioAIDesignOperationKind,
  ContentStudioAIOperationContext,
  ContentStudioAIOperationKind,
  isContentStudioAIDesignOperationKind,
  isContentStudioAIOperationKind,
  parseContentStudioAIOperationContext,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.types';
import {
  ContentStudioAIRequestTarget,
  hashContentStudioAIRequest,
  hashContentStudioAIResult,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.operation.hash';
import { ContentStudioSourceVersionRetentionPendingError } from '@gitroom/nestjs-libraries/content-studio/sources/source.retention';

// Ids of organizations, users, connections and packages are Prisma uuid()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Token counts and draft versions are PostgreSQL integers
const INT4_MAX = 2_147_483_647;
const MODEL_ID_MAX = 128;
const CURRENCY = /^[A-Z]{3}$/;
const FINISH_REASONS: ContentStudioAIFinishReason[] = [
  'stop',
  'length',
  'content_filter',
  'other',
];

// Each run makes exactly one provider attempt: no retry, no other model or
// connection. A retry would record attempt 2
const FIRST_ATTEMPT = 1;

// Built by the server (a later generation service) from authenticated data;
// it carries no credential
export interface ContentStudioAIExecutionInput {
  organizationId: string;
  userId: string;
  connectionId: string;
  packageId: string;
  kind: ContentStudioAIOperationKind;
  model: string;
  promptVersion: string;
  baseDraftVersion: number;
  context: ContentStudioAIOperationContext;
  request: ContentStudioAITextRequest;
}

// The same for one saved design revision (P6-02). The caller has read that
// revision in the organization; the operation names it, and its context
// names the same revision with its hash. There is no package or draft
export interface ContentStudioAIDesignExecutionInput {
  organizationId: string;
  userId: string;
  connectionId: string;
  designRevisionId: string;
  kind: ContentStudioAIDesignOperationKind;
  model: string;
  promptVersion: string;
  context: ContentStudioAIOperationContext;
  request: ContentStudioAITextRequest;
}

// What both kinds of operation have
type ExecutionCommon = Omit<
  ContentStudioAIExecutionInput,
  'packageId' | 'baseDraftVersion' | 'kind'
> & { kind: string };

export interface ContentStudioAIExecutionOptions {
  // The caller's own check of the answer (that it parses as what was asked
  // for), run once before the operation is recorded as succeeded. It throws
  // to refuse the answer: a ContentStudioAIProviderError as it is, anything
  // else as INVALID_RESPONSE. It must not keep or record the answer
  validateResult?: (result: ContentStudioAITextResult) => void;
}

const isId = (value: unknown) => typeof value === 'string' && UUID.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isTextRequest(
  request: unknown
): request is ContentStudioAITextRequest {
  if (!isRecord(request)) {
    return false;
  }
  const output = request.output;
  return (
    typeof request.model === 'string' &&
    typeof request.system === 'string' &&
    typeof request.prompt === 'string' &&
    Number.isSafeInteger(request.maxOutputTokens) &&
    (request.maxOutputTokens as number) >= 1 &&
    (request.temperature === undefined ||
      (typeof request.temperature === 'number' &&
        Number.isFinite(request.temperature))) &&
    isRecord(output) &&
    (output.type === 'text' ||
      (output.type === 'json' &&
        typeof output.schemaName === 'string' &&
        isRecord(output.schema)))
  );
}

// A count the provider reported, or null: never computed, never coerced
const tokenCount = (value: unknown) =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= INT4_MAX
    ? (value as number)
    : null;

// The provider's own usage of a successful call, checked once more before it
// is stored. A malformed field is left out; it never fails the operation
function providerUsage(
  usage: unknown
): Pick<
  ContentStudioAIUsageCreate,
  | 'usageSource'
  | 'inputTokens'
  | 'outputTokens'
  | 'cachedInputTokens'
  | 'reasoningTokens'
  | 'totalTokens'
  | 'providerCostMicros'
  | 'costCurrency'
> {
  if (!isRecord(usage)) {
    return {
      usageSource: 'none',
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      providerCostMicros: null,
      costCurrency: null,
    };
  }
  // a cost is stored only together with its currency
  const costed =
    typeof usage.costMicros === 'bigint' &&
    usage.costMicros >= BigInt(0) &&
    typeof usage.currency === 'string' &&
    CURRENCY.test(usage.currency);
  return {
    usageSource: 'provider',
    inputTokens: tokenCount(usage.inputTokens),
    outputTokens: tokenCount(usage.outputTokens),
    cachedInputTokens: tokenCount(usage.cachedInputTokens),
    reasoningTokens: tokenCount(usage.reasoningTokens),
    totalTokens: tokenCount(usage.totalTokens),
    providerCostMicros: costed ? (usage.costMicros as bigint) : null,
    costCurrency: costed ? (usage.currency as string) : null,
  };
}

// Runs one AI operation on a package (or, since P6-02, on one saved design
// revision) with an organization connection and records it: what was asked
// and answered as hashes only, and one usage row for the provider attempt.
// The generated text is returned, never stored. Everything that can be
// checked without the provider is checked before the operation exists, so a
// refused request leaves no row and costs nothing. An operation whose process
// stops during the provider call stays running; nothing sweeps it yet
@Injectable()
export class ContentStudioAIExecutionService {
  constructor(
    private _contentStudioRepository: ContentStudioRepository,
    private _contentStudioAIProviderResolver: ContentStudioAIProviderResolver,
    private _contentStudioAIOperationRepository: ContentStudioAIOperationRepository
  ) {}

  async execute(
    input: ContentStudioAIExecutionInput,
    options: ContentStudioAIExecutionOptions = {}
  ): Promise<{ operationId: string; result: ContentStudioAITextResult }> {
    const context = this.checkInput(input);
    const { organizationId } = input;

    const contentPackage =
      await this._contentStudioRepository.getPackageForOrganization(
        organizationId,
        input.packageId
      );
    if (!contentPackage) {
      throw new ContentStudioAIExecutionError('PACKAGE_NOT_FOUND');
    }
    if (contentPackage.archivedAt) {
      throw new ContentStudioAIExecutionError('PACKAGE_ARCHIVED');
    }
    if (contentPackage.draftVersion !== input.baseDraftVersion) {
      throw new ContentStudioAIExecutionError('DRAFT_VERSION_CONFLICT');
    }
    return this.run(
      input,
      { packageId: input.packageId, baseDraftVersion: input.baseDraftVersion },
      context,
      options
    );
  }

  // A Design Creative AI operation on exactly one saved design revision:
  // the same single attempt and records, with the revision instead of a
  // package. Nothing of the design is read or written here
  async executeForDesign(
    input: ContentStudioAIDesignExecutionInput,
    options: ContentStudioAIExecutionOptions = {}
  ): Promise<{ operationId: string; result: ContentStudioAITextResult }> {
    const context = this.checkDesignInput(input);
    return this.run(
      input,
      { designRevisionId: input.designRevisionId },
      context,
      options
    );
  }

  private async run(
    input: ExecutionCommon,
    target: ContentStudioAIRequestTarget,
    context: ContentStudioAIOperationContext,
    options: ContentStudioAIExecutionOptions
  ): Promise<{ operationId: string; result: ContentStudioAITextResult }> {
    const { organizationId } = input;

    // a connection that cannot be used ends here, with its own error
    const resolved = await this._contentStudioAIProviderResolver.resolve({
      organizationId,
      connectionId: input.connectionId,
    });
    if (!getContentStudioAIModel(resolved.provider, input.model)) {
      throw new ContentStudioAIExecutionError('MODEL_UNSUPPORTED');
    }

    let requestHash: string;
    try {
      requestHash = hashContentStudioAIRequest({
        kind: input.kind,
        provider: resolved.provider,
        model: input.model,
        promptVersion: input.promptVersion,
        ...target,
        context,
        request: input.request,
      });
    } catch {
      throw new ContentStudioAIExecutionError('INVALID_INPUT');
    }

    const operationId = randomUUID();
    try {
      await this._contentStudioAIOperationRepository.createRunningOperation({
        id: operationId,
        organizationId,
        userId: input.userId,
        connectionId: input.connectionId,
        ...('designRevisionId' in target
          ? {
              packageId: null,
              designRevisionId: target.designRevisionId,
              baseDraftVersion: null,
            }
          : {
              packageId: target.packageId,
              baseDraftVersion: target.baseDraftVersion,
            }),
        kind: input.kind,
        provider: resolved.provider,
        model: input.model,
        promptVersion: input.promptVersion,
        context,
        requestHash,
        startedAt: new Date(),
      });
    } catch (err) {
      // a source version the context names is held for retention (P8-R1Q):
      // no operation exists and the provider is never asked
      if (err instanceof ContentStudioSourceVersionRetentionPendingError) {
        throw new ContentStudioAIExecutionError(
          'SOURCE_VERSION_RETENTION_PENDING'
        );
      }
      throw new ContentStudioAIExecutionError('PERSISTENCE_FAILED');
    }

    const usageBase = {
      attempt: FIRST_ATTEMPT,
      provider: resolved.provider,
      model: input.model,
    };

    let result: ContentStudioAITextResult;
    try {
      result = await resolved.adapter.generateText(input.request);
      if (
        typeof result?.text !== 'string' ||
        !FINISH_REASONS.includes(result.finishReason)
      ) {
        throw new ContentStudioAIProviderError('INVALID_RESPONSE');
      }
    } catch (err) {
      // adapters normalize their errors; anything else is not passed on
      const failure =
        err instanceof ContentStudioAIProviderError
          ? err
          : new ContentStudioAIProviderError('PROVIDER_UNAVAILABLE');
      await this.record(() =>
        this._contentStudioAIOperationRepository.completeFailedWithUsage({
          organizationId,
          operationId,
          completedAt: new Date(),
          errorCode: failure.code,
          usage: {
            ...usageBase,
            ...providerUsage(null),
            outcome: 'failed',
            providerRequestId:
              safeProviderRequestId(failure.providerRequestId) ?? null,
          },
        })
      );
      throw failure;
    }

    const providerRequestId =
      safeProviderRequestId(result.providerRequestId) ?? null;

    // A refused answer is a failed attempt, with the usage the provider
    // reported for it. The provider is not asked again
    const rejection = this.rejection(result, options.validateResult);
    if (rejection) {
      await this.record(() =>
        this._contentStudioAIOperationRepository.completeFailedWithUsage({
          organizationId,
          operationId,
          completedAt: new Date(),
          errorCode: rejection.code,
          usage: {
            ...usageBase,
            ...providerUsage(result.usage),
            outcome: 'failed',
            providerRequestId,
          },
        })
      );
      throw rejection;
    }

    await this.record(() =>
      this._contentStudioAIOperationRepository.completeSucceededWithUsage({
        organizationId,
        operationId,
        completedAt: new Date(),
        resultHash: hashContentStudioAIResult({
          text: result.text,
          finishReason: result.finishReason,
          providerRequestId: providerRequestId ?? undefined,
        }),
        usage: {
          ...usageBase,
          ...providerUsage(result.usage),
          outcome: 'succeeded',
          providerRequestId,
        },
      })
    );
    return { operationId, result };
  }

  private rejection(
    result: ContentStudioAITextResult,
    validateResult: ContentStudioAIExecutionOptions['validateResult']
  ) {
    if (!validateResult) {
      return undefined;
    }
    try {
      validateResult(result);
      return undefined;
    } catch (err) {
      return err instanceof ContentStudioAIProviderError
        ? err
        : new ContentStudioAIProviderError('INVALID_RESPONSE');
    }
  }

  // The completion after the provider answered. It is never retried and the
  // provider is never asked again: a completion that fails or finds the
  // operation no longer running is a persistence failure
  private async record(write: () => Promise<{ completed: boolean }>) {
    let completed = false;
    try {
      ({ completed } = await write());
    } catch {
      completed = false;
    }
    if (!completed) {
      throw new ContentStudioAIExecutionError('PERSISTENCE_FAILED');
    }
  }

  // Everything checkable without a lookup; returns the context to store
  private checkInput(input: ContentStudioAIExecutionInput) {
    const context = parseContentStudioAIOperationContext(input?.context);
    if (
      !isRecord(input) ||
      !isId(input.organizationId) ||
      !isId(input.userId) ||
      !isId(input.connectionId) ||
      !isId(input.packageId) ||
      !isContentStudioAIOperationKind(input.kind) ||
      !!context?.design ||
      typeof input.model !== 'string' ||
      !input.model ||
      input.model.length > MODEL_ID_MAX ||
      typeof input.promptVersion !== 'string' ||
      !AI_PROMPT_VERSION.test(input.promptVersion) ||
      !Number.isSafeInteger(input.baseDraftVersion) ||
      input.baseDraftVersion < 1 ||
      input.baseDraftVersion > INT4_MAX ||
      !context ||
      !isTextRequest(input.request) ||
      input.request.model !== input.model
    ) {
      throw new ContentStudioAIExecutionError('INVALID_INPUT');
    }
    return context;
  }

  // The same for a design operation: a design kind, a context that names
  // this revision and nothing of a package (no item, no source)
  private checkDesignInput(input: ContentStudioAIDesignExecutionInput) {
    const context = parseContentStudioAIOperationContext(input?.context);
    if (
      !isRecord(input) ||
      'packageId' in input ||
      'baseDraftVersion' in input ||
      !isId(input.organizationId) ||
      !isId(input.userId) ||
      !isId(input.connectionId) ||
      !isId(input.designRevisionId) ||
      !isContentStudioAIDesignOperationKind(input.kind) ||
      typeof input.model !== 'string' ||
      !input.model ||
      input.model.length > MODEL_ID_MAX ||
      typeof input.promptVersion !== 'string' ||
      !AI_PROMPT_VERSION.test(input.promptVersion) ||
      !context ||
      context.design?.revisionId !== input.designRevisionId ||
      context.itemId !== undefined ||
      context.sources !== undefined ||
      !isTextRequest(input.request) ||
      input.request.model !== input.model
    ) {
      throw new ContentStudioAIExecutionError('INVALID_INPUT');
    }
    return context;
  }
}
