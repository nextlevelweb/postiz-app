import Anthropic, {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
import {
  ContentStudioAICredential,
  getContentStudioAIModel,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';
import {
  contentStudioAIErrorCodeForStatus,
  ContentStudioAIProviderError,
  safeProviderRequestId,
  safeRetryAfterSeconds,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import {
  ContentStudioAIFinishReason,
  ContentStudioAIProviderAdapter,
  ContentStudioAITextRequest,
  ContentStudioAITextResult,
  ContentStudioAITextUsage,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';

// The Claude API. Fixed, never configurable and never read from the
// environment
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
// One attempt per request, at most 30 seconds
const ANTHROPIC_TIMEOUT_MS = 30_000;

// The SDK class, replaceable in tests so no request leaves the process
export interface ContentStudioAnthropicSdk {
  Anthropic: typeof Anthropic;
}
const SDK: ContentStudioAnthropicSdk = { Anthropic };

// A new client for each call. Every option the SDK would otherwise read from
// the environment (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
// ANTHROPIC_BASE_URL, ANTHROPIC_LOG) is given here: authToken null keeps a
// bearer token from the environment off customer requests. The architecture
// guard holds every Anthropic client to this literal
const anthropicClient = (
  credential: ContentStudioAICredential,
  sdk: ContentStudioAnthropicSdk
) =>
  new sdk.Anthropic({
    apiKey: credential.apiKey,
    authToken: null,
    baseURL: ANTHROPIC_BASE_URL,
    logLevel: 'off',
    maxRetries: 0,
    timeout: ANTHROPIC_TIMEOUT_MS,
  });

// Any failure of an Anthropic SDK call as a provider error: the status, the
// request-id header and Retry-After are kept, the provider's message, body
// and the rest of the headers never are
export function toContentStudioAnthropicProviderError(
  err: unknown
): ContentStudioAIProviderError {
  if (err instanceof ContentStudioAIProviderError) {
    return err;
  }
  if (err instanceof APIConnectionTimeoutError) {
    return new ContentStudioAIProviderError('TIMEOUT');
  }
  if (err instanceof APIError && !(err instanceof APIUserAbortError)) {
    return new ContentStudioAIProviderError(
      contentStudioAIErrorCodeForStatus(err.status),
      {
        httpStatus: err.status,
        providerRequestId: err.requestID,
        retryAfterSeconds: safeRetryAfterSeconds(
          err.headers?.get('retry-after')
        ),
      }
    );
  }
  return new ContentStudioAIProviderError('PROVIDER_UNAVAILABLE');
}

// The documented stop reasons. refusal is a safety stop; a response cut by
// the context window is as cut as one cut by max_tokens
const STOP_REASONS: Record<string, ContentStudioAIFinishReason> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  refusal: 'content_filter',
};

export const toContentStudioAnthropicFinishReason = (
  value: unknown
): ContentStudioAIFinishReason =>
  (typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(STOP_REASONS, value) &&
    STOP_REASONS[value]) ||
  'other';

const tokenCount = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;

// Messages usage as the provider reported it. input_tokens leaves out the
// tokens read from or written to the prompt cache; cache reads are the cached
// input. The API reports no total and no reasoning tokens, and nothing is
// added up or estimated here
export function toContentStudioAnthropicUsage(
  usage: unknown
): ContentStudioAITextUsage | null {
  if (typeof usage !== 'object' || usage === null) {
    return null;
  }
  const value = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
  };
  const counts: ContentStudioAITextUsage = {
    inputTokens: tokenCount(value.input_tokens),
    outputTokens: tokenCount(value.output_tokens),
    cachedInputTokens: tokenCount(value.cache_read_input_tokens),
  };
  const reported = Object.fromEntries(
    Object.entries(counts).filter(([, count]) => count !== undefined)
  );
  return Object.keys(reported).length ? reported : null;
}

// One Messages API call. Only a catalog model of Anthropic is sent; JSON
// output is refused for models the catalog does not offer it for, and a
// refused request never makes a client. The answer is the text blocks only:
// thinking, tool use and any other block is left out
async function createAnthropicMessage(
  createClient: () => Anthropic,
  request: ContentStudioAITextRequest
): Promise<ContentStudioAITextResult> {
  const model = getContentStudioAIModel('anthropic', request.model);
  if (!model) {
    throw new ContentStudioAIProviderError('MODEL_UNAVAILABLE');
  }
  if (
    !Number.isSafeInteger(request.maxOutputTokens) ||
    request.maxOutputTokens < 1 ||
    (request.output.type === 'json' && !model.capabilities.structuredOutput)
  ) {
    throw new ContentStudioAIProviderError('REQUEST_REJECTED');
  }

  const body: MessageCreateParamsNonStreaming = {
    model: model.id,
    max_tokens: request.maxOutputTokens,
    system: request.system,
    messages: [{ role: 'user', content: request.prompt }],
  };
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }

  let message: unknown;
  let requestId: unknown;
  try {
    const { data, request_id } = await createClient()
      .messages.create(body)
      .withResponse();
    message = data;
    requestId = request_id;
  } catch (err) {
    throw toContentStudioAnthropicProviderError(err);
  }

  const { content, stop_reason, usage } = (message || {}) as {
    content?: unknown;
    stop_reason?: unknown;
    usage?: unknown;
  };
  if (!Array.isArray(content)) {
    throw new ContentStudioAIProviderError('INVALID_RESPONSE');
  }
  const texts = content.filter(
    (block): block is { type: 'text'; text: string } =>
      typeof block === 'object' &&
      block !== null &&
      block.type === 'text' &&
      typeof block.text === 'string'
  );
  if (!texts.length) {
    throw new ContentStudioAIProviderError(
      stop_reason === 'refusal' ? 'CONTENT_REJECTED' : 'INVALID_RESPONSE'
    );
  }

  const providerRequestId = safeProviderRequestId(requestId);
  return {
    text: texts.map((block) => block.text).join(''),
    finishReason: toContentStudioAnthropicFinishReason(stop_reason),
    usage: toContentStudioAnthropicUsage(usage),
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
  };
}

// An Anthropic connection. The key stays in this closure; each call makes its
// own client and nothing is kept between calls
export function createAnthropicProviderAdapter(
  credential: ContentStudioAICredential,
  sdk: ContentStudioAnthropicSdk = SDK
): ContentStudioAIProviderAdapter {
  return {
    provider: 'anthropic',
    // Listing models needs a valid key and generates nothing
    async validateConnection() {
      try {
        await anthropicClient(credential, sdk).models.list();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          code: toContentStudioAnthropicProviderError(err).code,
        };
      }
    },
    async generateText(request) {
      return createAnthropicMessage(
        () => anthropicClient(credential, sdk),
        request
      );
    },
  };
}
