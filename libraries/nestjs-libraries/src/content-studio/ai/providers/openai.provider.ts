import OpenAI, {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import {
  ContentStudioAICredential,
  ContentStudioAIProvider,
  getContentStudioAIModel,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.catalog';
import {
  ContentStudioAIProviderError,
  safeProviderRequestId,
  safeRetryAfterSeconds,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import {
  ContentStudioAIConnectionValidationResult,
  ContentStudioAIFinishReason,
  ContentStudioAIProviderAdapter,
  ContentStudioAIProviderErrorCode,
  ContentStudioAITextRequest,
  ContentStudioAITextResult,
  ContentStudioAITextUsage,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';

// Fixed, never configurable and never read from the environment
const OPENAI_BASE_URL = 'https://api.openai.com/v1';

// One attempt per request, at most 30 seconds
const OPENAI_TIMEOUT_MS = 30_000;

// The SDK class, replaceable in tests so no request leaves the process
export interface ContentStudioOpenAISdk {
  OpenAI: typeof OpenAI;
}
const SDK: ContentStudioOpenAISdk = { OpenAI };

// A new client for each call. Every option the SDK would otherwise read from
// the environment (OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_ORG_ID,
// OPENAI_PROJECT_ID, OPENAI_WEBHOOK_SECRET, OPENAI_LOG) is given here; the
// architecture guard holds every OpenAI client to this literal
const openAIClient = (
  credential: ContentStudioAICredential,
  sdk: ContentStudioOpenAISdk
) =>
  new sdk.OpenAI({
    apiKey: credential.apiKey,
    baseURL: OPENAI_BASE_URL,
    organization: null,
    project: null,
    webhookSecret: null,
    logLevel: 'off',
    maxRetries: 0,
    timeout: OPENAI_TIMEOUT_MS,
  });

const codeForStatus = (
  status: number | undefined,
  errorCode: unknown
): ContentStudioAIProviderErrorCode => {
  if (status === 401 || status === 403) {
    return 'AUTH_FAILED';
  }
  if (
    status === 402 ||
    (status === 429 && errorCode === 'insufficient_quota')
  ) {
    return 'QUOTA_EXCEEDED';
  }
  if (status === 429) {
    return 'RATE_LIMITED';
  }
  if (status === 408) {
    return 'TIMEOUT';
  }
  if (status === 404) {
    return 'MODEL_UNAVAILABLE';
  }
  if (status === 400 || status === 409 || status === 413 || status === 422) {
    return 'REQUEST_REJECTED';
  }
  // 5xx, no status (the connection failed) or anything unexpected
  return 'PROVIDER_UNAVAILABLE';
};

// Any failure of an OpenAI SDK call (OpenAI or OpenRouter) as a provider
// error: the status, the request id header and Retry-After are kept, the
// provider's message, body and the rest of the headers never are
export function toContentStudioAIProviderError(
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
      codeForStatus(err.status, err.code),
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

export const toValidationFailure = (
  err: unknown
): ContentStudioAIConnectionValidationResult => ({
  ok: false,
  code: toContentStudioAIProviderError(err).code,
});

const FINISH_REASONS: ContentStudioAIFinishReason[] = [
  'stop',
  'length',
  'content_filter',
];

export const toContentStudioAIFinishReason = (
  value: unknown
): ContentStudioAIFinishReason =>
  FINISH_REASONS.find((reason) => reason === value) || 'other';

const tokenCount = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;

// Chat Completions usage as the provider reported it. OpenRouter also
// reports a cost, in OpenRouter credits rather than a currency, so it is left
// out
export function toContentStudioAIUsage(
  usage: unknown
): ContentStudioAITextUsage | null {
  if (typeof usage !== 'object' || usage === null) {
    return null;
  }
  const value = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown } | null;
    completion_tokens_details?: { reasoning_tokens?: unknown } | null;
  };
  const counts: ContentStudioAITextUsage = {
    inputTokens: tokenCount(value.prompt_tokens),
    outputTokens: tokenCount(value.completion_tokens),
    cachedInputTokens: tokenCount(value.prompt_tokens_details?.cached_tokens),
    reasoningTokens: tokenCount(
      value.completion_tokens_details?.reasoning_tokens
    ),
    totalTokens: tokenCount(value.total_tokens),
  };
  const reported = Object.fromEntries(
    Object.entries(counts).filter(([, count]) => count !== undefined)
  );
  return Object.keys(reported).length ? reported : null;
}

// One Chat Completions call, the API both OpenAI and OpenRouter document for
// these models. Only a catalog model of this provider is sent, and JSON output
// only to a model that supports it; a refused request never makes a client
export async function createContentStudioChatCompletion(
  createClient: () => OpenAI,
  provider: ContentStudioAIProvider,
  request: ContentStudioAITextRequest
): Promise<ContentStudioAITextResult> {
  const model = getContentStudioAIModel(provider, request.model);
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

  const body: ChatCompletionCreateParamsNonStreaming = {
    model: model.id,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt },
    ],
    max_completion_tokens: request.maxOutputTokens,
  };
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.output.type === 'json') {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: request.output.schemaName,
        strict: true,
        schema: request.output.schema,
      },
    };
  }

  let completion: unknown;
  let requestId: unknown;
  try {
    const { data, request_id } = await createClient()
      .chat.completions.create(body)
      .withResponse();
    completion = data;
    requestId = request_id;
  } catch (err) {
    throw toContentStudioAIProviderError(err);
  }

  const choices = (completion as { choices?: unknown } | null)?.choices;
  const choice = Array.isArray(choices)
    ? (choices[0] as
        | {
            finish_reason?: unknown;
            message?: { content?: unknown; refusal?: unknown } | null;
          }
        | undefined)
    : undefined;
  const message = choice?.message;
  if (!message) {
    throw new ContentStudioAIProviderError('INVALID_RESPONSE');
  }
  if (typeof message.content !== 'string') {
    throw new ContentStudioAIProviderError(
      typeof message.refusal === 'string' ||
      choice.finish_reason === 'content_filter'
        ? 'CONTENT_REJECTED'
        : 'INVALID_RESPONSE'
    );
  }

  const providerRequestId = safeProviderRequestId(requestId);
  return {
    text: message.content,
    finishReason: toContentStudioAIFinishReason(choice.finish_reason),
    usage: toContentStudioAIUsage((completion as { usage?: unknown }).usage),
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
  };
}

// An OpenAI connection. The key stays in this closure; each call makes its
// own client and nothing is kept between calls
export function createOpenAIProviderAdapter(
  credential: ContentStudioAICredential,
  sdk: ContentStudioOpenAISdk = SDK
): ContentStudioAIProviderAdapter {
  return {
    provider: 'openai',
    // Listing models needs a valid key and generates nothing
    async validateConnection() {
      try {
        await openAIClient(credential, sdk).models.list();
        return { ok: true };
      } catch (err) {
        return toValidationFailure(err);
      }
    },
    async generateText(request) {
      return createContentStudioChatCompletion(
        () => openAIClient(credential, sdk),
        'openai',
        request
      );
    },
  };
}
