import { ContentStudioAIProviderErrorCode } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';

const PROVIDER_MESSAGES: Record<ContentStudioAIProviderErrorCode, string> = {
  AUTH_FAILED: 'The AI provider did not accept the credential',
  QUOTA_EXCEEDED: 'The AI provider account has no quota or credit left',
  RATE_LIMITED: 'The AI provider is rate limiting this connection',
  PROVIDER_UNAVAILABLE: 'The AI provider is not available',
  TIMEOUT: 'The AI provider did not answer in time',
  MODEL_UNAVAILABLE: 'The AI model is not available',
  REQUEST_REJECTED: 'The AI provider rejected the request',
  CONTENT_REJECTED: 'The AI provider refused the content',
  INVALID_RESPONSE: 'The AI provider answered with an unexpected response',
};

const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;
const PROVIDER_REQUEST_ID_MAX = 200;
const RETRY_AFTER_MAX_SECONDS = 86_400;

// A provider request id as the provider's response headers give it, or
// undefined: printable ASCII without spaces, at most 200 characters
export const safeProviderRequestId = (value: unknown) =>
  typeof value === 'string' &&
  value.length <= PROVIDER_REQUEST_ID_MAX &&
  /^[\x21-\x7e]+$/.test(value)
    ? value
    : undefined;

// Retry-After in whole seconds only; an HTTP date or anything else is left out
export const safeRetryAfterSeconds = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  return seconds <= RETRY_AFTER_MAX_SECONDS ? seconds : undefined;
};

// The HTTP status of a failed provider call as a normalized code, the same
// for every provider. An adapter may refine it from a documented error code
export const contentStudioAIErrorCodeForStatus = (
  status: number | undefined
): ContentStudioAIProviderErrorCode => {
  if (status === 401 || status === 403) {
    return 'AUTH_FAILED';
  }
  if (status === 402) {
    return 'QUOTA_EXCEEDED';
  }
  if (status === 429) {
    return 'RATE_LIMITED';
  }
  if (status === 408 || status === 504) {
    return 'TIMEOUT';
  }
  if (status === 404) {
    return 'MODEL_UNAVAILABLE';
  }
  if (status === 400 || status === 409 || status === 413 || status === 422) {
    return 'REQUEST_REJECTED';
  }
  // other 5xx (529 overloaded included), no status (the connection failed)
  // or anything unexpected
  return 'PROVIDER_UNAVAILABLE';
};

interface ProviderErrorMetadata {
  httpStatus?: unknown;
  providerRequestId?: unknown;
  retryAfterSeconds?: unknown;
}

// A provider failure: a fixed message per code and checked metadata only. No
// `cause`, no provider message, body, headers or request options, so the key
// a request carried cannot travel with it
export class ContentStudioAIProviderError extends Error {
  readonly httpStatus?: number;
  readonly providerRequestId?: string;
  readonly retryAfterSeconds?: number;

  constructor(
    readonly code: ContentStudioAIProviderErrorCode,
    metadata: ProviderErrorMetadata = {}
  ) {
    super(PROVIDER_MESSAGES[code]);
    this.name = 'ContentStudioAIProviderError';
    const { httpStatus, providerRequestId, retryAfterSeconds } = metadata;
    if (
      Number.isInteger(httpStatus) &&
      (httpStatus as number) >= HTTP_STATUS_MIN &&
      (httpStatus as number) <= HTTP_STATUS_MAX
    ) {
      this.httpStatus = httpStatus as number;
    }
    const requestId = safeProviderRequestId(providerRequestId);
    if (requestId !== undefined) {
      this.providerRequestId = requestId;
    }
    if (
      Number.isInteger(retryAfterSeconds) &&
      (retryAfterSeconds as number) >= 0 &&
      (retryAfterSeconds as number) <= RETRY_AFTER_MAX_SECONDS
    ) {
      this.retryAfterSeconds = retryAfterSeconds as number;
    }
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      providerRequestId: this.providerRequestId,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
}

export type ContentStudioAIResolutionErrorCode =
  | 'NOT_FOUND'
  | 'DISABLED'
  | 'CREDENTIAL_INVALID'
  | 'SECRET_STORE_UNAVAILABLE'
  | 'PROVIDER_UNSUPPORTED';

const RESOLUTION_MESSAGES: Record<ContentStudioAIResolutionErrorCode, string> =
  {
    NOT_FOUND: 'The AI connection was not found',
    DISABLED: 'The AI connection is disabled',
    CREDENTIAL_INVALID: 'The AI connection credential cannot be read',
    SECRET_STORE_UNAVAILABLE: 'AI connection credentials are not available',
    PROVIDER_UNSUPPORTED: 'The AI connection provider is not supported',
  };

// Why a connection could not be turned into a provider adapter. The service
// maps it to HTTP; it never carries the envelope or the key
export class ContentStudioAIResolutionError extends Error {
  constructor(readonly code: ContentStudioAIResolutionErrorCode) {
    super(RESOLUTION_MESSAGES[code]);
    this.name = 'ContentStudioAIResolutionError';
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message };
  }
}

export type ContentStudioAIExecutionErrorCode =
  | 'INVALID_INPUT'
  | 'PACKAGE_NOT_FOUND'
  | 'PACKAGE_ARCHIVED'
  | 'DRAFT_VERSION_CONFLICT'
  | 'MODEL_UNSUPPORTED'
  | 'PERSISTENCE_FAILED'
  | 'SOURCE_VERSION_RETENTION_PENDING';

const EXECUTION_MESSAGES: Record<ContentStudioAIExecutionErrorCode, string> = {
  INVALID_INPUT: 'The AI operation request is invalid',
  PACKAGE_NOT_FOUND: 'The content package was not found',
  PACKAGE_ARCHIVED: 'The content package is archived',
  DRAFT_VERSION_CONFLICT: 'The content package changed since it was read',
  MODEL_UNSUPPORTED: 'The AI model is not supported for this connection',
  PERSISTENCE_FAILED: 'The AI operation could not be recorded',
  SOURCE_VERSION_RETENTION_PENDING:
    'A selected source version is temporarily unavailable for new references',
};

// Why an AI operation was not run or not recorded. A provider failure is a
// ContentStudioAIProviderError instead, and a connection that cannot be used
// a ContentStudioAIResolutionError. No cause, no underlying message
export class ContentStudioAIExecutionError extends Error {
  constructor(readonly code: ContentStudioAIExecutionErrorCode) {
    super(EXECUTION_MESSAGES[code]);
    this.name = 'ContentStudioAIExecutionError';
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message };
  }
}
