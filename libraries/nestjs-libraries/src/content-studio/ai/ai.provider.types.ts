import { ContentStudioAIProvider } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';

// What Content Studio asks of an AI provider and gets back, whatever the
// vendor. Provider adapters translate to and from their SDK; no SDK type
// appears here

// Why a provider call did not succeed, normalized. A code never carries the
// provider's own message, body or headers
export type ContentStudioAIProviderErrorCode =
  | 'AUTH_FAILED'
  // the key is valid but must name a workspace (an Anthropic key that is not
  // scoped to one): the connection needs its workspace id
  | 'WORKSPACE_REQUIRED'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'TIMEOUT'
  | 'MODEL_UNAVAILABLE'
  | 'REQUEST_REJECTED'
  | 'CONTENT_REJECTED'
  | 'INVALID_RESPONSE';

export interface ContentStudioAITextRequest {
  // a model of the connection's provider catalog; anything else is refused
  // before a request is made
  model: string;
  system: string;
  prompt: string;
  output:
    | { type: 'text' }
    | {
        type: 'json';
        schemaName: string;
        schema: Record<string, unknown>;
      };
  maxOutputTokens: number;
  // sent only when given: not every model accepts it
  temperature?: number;
  // a longer wait than the adapter's default for a request known to produce
  // a long answer, at most AI_REQUEST_TIMEOUT_MAX_MS
  timeoutMs?: number;
}

export const AI_REQUEST_TIMEOUT_MAX_MS = 180_000;

// The adapter's own timeout unless the request asks for a longer one; never
// more than AI_REQUEST_TIMEOUT_MAX_MS
export const contentStudioAIRequestTimeout = (
  request: Pick<ContentStudioAITextRequest, 'timeoutMs'>,
  adapterDefault: number
) =>
  Number.isSafeInteger(request.timeoutMs) &&
  (request.timeoutMs as number) > adapterDefault
    ? Math.min(request.timeoutMs as number, AI_REQUEST_TIMEOUT_MAX_MS)
    : adapterDefault;

// Only what the provider reported; nothing is estimated
export interface ContentStudioAITextUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costMicros?: bigint;
  currency?: string;
}

export type ContentStudioAIFinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'other';

export interface ContentStudioAITextResult {
  text: string;
  finishReason: ContentStudioAIFinishReason;
  usage: ContentStudioAITextUsage | null;
  providerRequestId?: string;
}

export type ContentStudioAIConnectionValidationResult =
  | { ok: true }
  | { ok: false; code: ContentStudioAIProviderErrorCode };

// One resolved connection. The key lives only in the adapter's closure and a
// client is made for each call
export interface ContentStudioAIProviderAdapter {
  readonly provider: ContentStudioAIProvider;
  // never throws for a provider failure: an admin asks whether the
  // connection works, and the answer is the normalized code. Given a model,
  // the provider is asked about that model where it can answer for it
  // (MODEL_UNAVAILABLE when it cannot be used); nothing is generated
  validateConnection(
    model?: string
  ): Promise<ContentStudioAIConnectionValidationResult>;
  // throws ContentStudioAIProviderError
  generateText(
    request: ContentStudioAITextRequest
  ): Promise<ContentStudioAITextResult>;
}
