import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ContentStudioRepository } from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.repository';
import {
  ContentStudioAIOperationRepository,
  ContentStudioAIUsageCreate,
} from '@gitroom/nestjs-libraries/database/prisma/content-studio/content-studio.ai-operation.repository';
import {
  ContentStudioAIProviderResolver,
  ContentStudioResolvedAIConnection,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.resolver';
import { getContentStudioAIModel } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';
import {
  ContentStudioAIExecutionError,
  ContentStudioAIProviderError,
  safeProviderRequestId,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import {
  AI_REQUEST_TIMEOUT_MAX_MS,
  ContentStudioAIFinishReason,
  ContentStudioAITextRequest,
  ContentStudioAITextResult,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';
import {
  AI_PROMPT_VERSION,
  ContentStudioAIDesignOperationKind,
  ContentStudioAIOperationContext,
  ContentStudioAIFirstPostOperationKind,
  ContentStudioAIOperationKind,
  ContentStudioAISetupOperationKind,
  isContentStudioAIFirstPostOperationKind,
  isContentStudioAIDesignOperationKind,
  isContentStudioAIOperationKind,
  isContentStudioAISetupOperationKind,
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
  kind: ContentStudioAIOperationKind | ContentStudioAIFirstPostOperationKind;
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

// The same for the organization itself (the guided setup): no package, no
// design and a context that names nothing but its version. The caller has
// checked the user's input; none of it is stored
export interface ContentStudioAIOrganizationExecutionInput {
  organizationId: string;
  userId: string;
  connectionId: string;
  kind: ContentStudioAISetupOperationKind;
  model: string;
  promptVersion: string;
  context: ContentStudioAIOperationContext;
  request: ContentStudioAITextRequest;
}

// What every kind of operation has
type ExecutionCommon = Omit<
  ContentStudioAIExecutionInput,
  'packageId' | 'baseDraftVersion' | 'kind'
> & { kind: string };

export interface ContentStudioAIExecutionOptions {
  // The caller's own check of the answer (that it parses as what was asked
  // for), run once before the operation is recorded as succeeded. It throws
  // to refuse the answer: a ContentStudioAIProviderError as it is, anything
  // else as INVALID_RESPONSE. It must not keep or record the answer itself
  validateResult?: (result: ContentStudioAITextResult) => unknown;
  // Records what validateResult returned (plain JSON of the checked answer)
  // as the operation's result, for an operation that runs on after its
  // request: the client that started it reads the answer back later
  keepResult?: boolean;
}

// A started operation: it exists (running) and its provider attempt is under
// way. done settles when the attempt is recorded, whatever became of the
// request that started it
export interface ContentStudioAIStartedOperation {
  operationId: string;
  done: Promise<ContentStudioAITextResult>;
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
    (request.timeoutMs === undefined ||
      (Number.isSafeInteger(request.timeoutMs) &&
        (request.timeoutMs as number) >= 1 &&
        (request.timeoutMs as number) <= AI_REQUEST_TIMEOUT_MAX_MS)) &&
    (request.webSearch === undefined ||
      typeof request.webSearch === 'boolean') &&
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
// stops during the provider call stays running; nothing sweeps it, and a
// reader treats one running longer than any provider call as interrupted.
// The start methods return once the operation exists: its provider attempt
// goes on without the request, which may end or be dropped meanwhile
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

  // The same package operation, started: it returns once the operation
  // exists and the provider attempt goes on without the request
  async startForPackage(
    input: ContentStudioAIExecutionInput,
    options: ContentStudioAIExecutionOptions = {}
  ): Promise<ContentStudioAIStartedOperation> {
    const context = this.checkInput(input);
    const contentPackage =
      await this._contentStudioRepository.getPackageForOrganization(
        input.organizationId,
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
    return this.start(
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

  // A setup operation for the organization (the guided setup): the same
  // single attempt and records, on no package and no design revision
  async executeForOrganization(
    input: ContentStudioAIOrganizationExecutionInput,
    options: ContentStudioAIExecutionOptions = {}
  ): Promise<{ operationId: string; result: ContentStudioAITextResult }> {
    const context = this.checkOrganizationInput(input);
    return this.run(input, { scope: 'organization' }, context, options);
  }

  // The same setup operation, started: it returns once the operation exists
  // and the provider attempt goes on without the request
  async startForOrganization(
    input: ContentStudioAIOrganizationExecutionInput,
    options: ContentStudioAIExecutionOptions = {}
  ): Promise<ContentStudioAIStartedOperation> {
    const context = this.checkOrganizationInput(input);
    return this.start(input, { scope: 'organization' }, context, options);
  }

  private async run(
    input: ExecutionCommon,
    target: ContentStudioAIRequestTarget,
    context: ContentStudioAIOperationContext,
    options: ContentStudioAIExecutionOptions
  ): Promise<{ operationId: string; result: ContentStudioAITextResult }> {
    const { operationId, done } = await this.start(
      input,
      target,
      context,
      options
    );
    return { operationId, result: await done };
  }

  // Everything up to the running operation, awaited; the provider attempt
  // and its record are done, which is not awaited here
  private async start(
    input: ExecutionCommon,
    target: ContentStudioAIRequestTarget,
    context: ContentStudioAIOperationContext,
    options: ContentStudioAIExecutionOptions
  ): Promise<ContentStudioAIStartedOperation> {
    const { organizationId } = input;

    // a connection that cannot be used ends here, with its own error
    const resolved = await this._contentStudioAIProviderResolver.resolve({
      organizationId,
      connectionId: input.connectionId,
    });
    const model = getContentStudioAIModel(resolved.provider, input.model);
    // web search only where the model has it
    if (!model || (input.request.webSearch && !model.capabilities.webSearch)) {
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
          : 'scope' in target
          ? { packageId: null, designRevisionId: null, baseDraftVersion: null }
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

    return {
      operationId,
      done: this.attempt(input, resolved, operationId, options),
    };
  }

  // The single provider attempt of a running operation, and its record
  private async attempt(
    input: ExecutionCommon,
    resolved: ContentStudioResolvedAIConnection,
    operationId: string,
    options: ContentStudioAIExecutionOptions
  ): Promise<ContentStudioAITextResult> {
    const { organizationId } = input;
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
    const { rejection, value } = this.check(result, options.validateResult);
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
        ...(options.keepResult && value !== undefined ? { result: value } : {}),
        usage: {
          ...usageBase,
          ...providerUsage(result.usage),
          outcome: 'succeeded',
          providerRequestId,
        },
      })
    );
    return result;
  }

  // The caller's check: what it returned, or the error that refuses the
  // answer
  private check(
    result: ContentStudioAITextResult,
    validateResult: ContentStudioAIExecutionOptions['validateResult']
  ): { rejection?: ContentStudioAIProviderError; value?: unknown } {
    if (!validateResult) {
      return {};
    }
    try {
      return { value: validateResult(result) };
    } catch (err) {
      return {
        rejection:
          err instanceof ContentStudioAIProviderError
            ? err
            : new ContentStudioAIProviderError('INVALID_RESPONSE'),
      };
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
      !(
        isContentStudioAIOperationKind(input.kind) ||
        isContentStudioAIFirstPostOperationKind(input.kind)
      ) ||
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

  // The same for a setup operation: a setup kind and a context that names
  // no item, profile, policy, source or design
  private checkOrganizationInput(
    input: ContentStudioAIOrganizationExecutionInput
  ) {
    const context = parseContentStudioAIOperationContext(input?.context);
    if (
      !isRecord(input) ||
      'packageId' in input ||
      'baseDraftVersion' in input ||
      'designRevisionId' in input ||
      !isId(input.organizationId) ||
      !isId(input.userId) ||
      !isId(input.connectionId) ||
      !isContentStudioAISetupOperationKind(input.kind) ||
      typeof input.model !== 'string' ||
      !input.model ||
      input.model.length > MODEL_ID_MAX ||
      typeof input.promptVersion !== 'string' ||
      !AI_PROMPT_VERSION.test(input.promptVersion) ||
      !context ||
      Object.keys(context).length !== 1 ||
      !isTextRequest(input.request) ||
      input.request.model !== input.model
    ) {
      throw new ContentStudioAIExecutionError('INVALID_INPUT');
    }
    return context;
  }
}
