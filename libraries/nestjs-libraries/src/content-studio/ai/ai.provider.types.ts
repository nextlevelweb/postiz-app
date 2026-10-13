import { ContentStudioAIProvider } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';

// What Content Studio asks of an AI provider and gets back, whatever the
// vendor. Provider adapters translate to and from their SDK; no SDK type
// appears here

// Why a provider call did not succeed, normalized. A code never carries the
// provider's own message, body or headers
export type ContentStudioAIProviderErrorCode =
  | 'AUTH_FAILED'
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
}

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
  // connection works, and the answer is the normalized code
  validateConnection(): Promise<ContentStudioAIConnectionValidationResult>;
  // throws ContentStudioAIProviderError
  generateText(
    request: ContentStudioAITextRequest
  ): Promise<ContentStudioAITextResult>;
}
