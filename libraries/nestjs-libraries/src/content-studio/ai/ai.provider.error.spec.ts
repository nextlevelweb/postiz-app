import { inspect } from 'util';
import {
  contentStudioAIErrorCodeForStatus,
  ContentStudioAIProviderError,
  ContentStudioAIResolutionError,
  safeProviderRequestId,
  safeRetryAfterSeconds,
} from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.error';
import { ContentStudioAIProviderErrorCode } from '@gitroom/nestjs-libraries/content-studio/ai/ai.provider.types';

const MARKER = 'sk-content-studio-test-secret-123';

// Every way an error could carry what it was built from
const rendered = (err: Error & { toJSON(): unknown }) =>
  [
    String(err),
    err.message,
    err.stack,
    JSON.stringify(err),
    JSON.stringify(err.toJSON()),
    inspect(err, { depth: 10, showHidden: true }),
  ].join('\n');

const CODES: ContentStudioAIProviderErrorCode[] = [
  'AUTH_FAILED',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'MODEL_UNAVAILABLE',
  'REQUEST_REJECTED',
  'CONTENT_REJECTED',
  'INVALID_RESPONSE',
];

describe('ContentStudioAIProviderError', () => {
  it.each(CODES.map((code) => [code]))(
    'has a fixed message, no cause and no marker for %s',
    (code) => {
      const err = new ContentStudioAIProviderError(code, {
        httpStatus: 401,
        providerRequestId: 'req_123',
        retryAfterSeconds: 3,
        ...({ cause: new Error(MARKER), body: MARKER } as object),
      });
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.name).toBe('ContentStudioAIProviderError');
      expect(err).not.toHaveProperty('cause');
      expect(err).not.toHaveProperty('body');
      expect(rendered(err)).not.toContain(MARKER);
      expect(Object.keys(err.toJSON())).toEqual([
        'name',
        'code',
        'message',
        'httpStatus',
        'providerRequestId',
        'retryAfterSeconds',
      ]);
    }
  );

  it('gives every code its own fixed message', () => {
    const messages = CODES.map(
      (code) => new ContentStudioAIProviderError(code).message
    );
    expect(new Set(messages).size).toBe(CODES.length);
  });

  it('keeps checked metadata only', () => {
    const err = new ContentStudioAIProviderError('RATE_LIMITED', {
      httpStatus: 429,
      providerRequestId: 'req_abc-123',
      retryAfterSeconds: 20,
    });
    expect(err.toJSON()).toEqual({
      name: 'ContentStudioAIProviderError',
      code: 'RATE_LIMITED',
      message: 'The AI provider is rate limiting this connection',
      httpStatus: 429,
      providerRequestId: 'req_abc-123',
      retryAfterSeconds: 20,
    });
  });

  it.each([
    [{ httpStatus: 99 }],
    [{ httpStatus: 600 }],
    [{ httpStatus: 401.5 }],
    [{ httpStatus: '401' }],
    [{ providerRequestId: MARKER.replace('sk-', 'sk -') }],
    [{ providerRequestId: 'x'.repeat(201) }],
    [{ providerRequestId: 'req\n1' }],
    [{ providerRequestId: 42 }],
    [{ retryAfterSeconds: -1 }],
    [{ retryAfterSeconds: 86_401 }],
    [{ retryAfterSeconds: '5' }],
  ])('drops malformed metadata %p', (metadata) => {
    const err = new ContentStudioAIProviderError('AUTH_FAILED', metadata);
    expect(err.httpStatus).toBeUndefined();
    expect(err.providerRequestId).toBeUndefined();
    expect(err.retryAfterSeconds).toBeUndefined();
    expect(JSON.parse(JSON.stringify(err))).toEqual({
      name: 'ContentStudioAIProviderError',
      code: 'AUTH_FAILED',
      message: 'The AI provider did not accept the credential',
    });
  });

  it('accepts a request id of up to 200 printable characters', () => {
    expect(safeProviderRequestId('r'.repeat(200))).toBe('r'.repeat(200));
    expect(safeProviderRequestId('r'.repeat(201))).toBeUndefined();
    expect(safeProviderRequestId('')).toBeUndefined();
    expect(safeProviderRequestId(null)).toBeUndefined();
  });

  it('reads Retry-After in whole seconds only', () => {
    expect(safeRetryAfterSeconds('30')).toBe(30);
    expect(safeRetryAfterSeconds('0')).toBe(0);
    expect(safeRetryAfterSeconds('86401')).toBeUndefined();
    expect(
      safeRetryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT')
    ).toBeUndefined();
    expect(safeRetryAfterSeconds('1.5')).toBeUndefined();
    expect(safeRetryAfterSeconds(null)).toBeUndefined();
  });
});

describe('ContentStudioAIResolutionError', () => {
  it.each([
    ['NOT_FOUND'],
    ['DISABLED'],
    ['CREDENTIAL_INVALID'],
    ['SECRET_STORE_UNAVAILABLE'],
    ['PROVIDER_UNSUPPORTED'],
  ] as const)('%s has a fixed message and nothing else', (code) => {
    const err = new ContentStudioAIResolutionError(code);
    expect(err.toJSON()).toEqual({
      name: 'ContentStudioAIResolutionError',
      code,
      message: err.message,
    });
    expect(err).not.toHaveProperty('cause');
    expect(rendered(err)).not.toContain(MARKER);
  });
});

describe('contentStudioAIErrorCodeForStatus', () => {
  it.each([
    [401, 'AUTH_FAILED'],
    [403, 'AUTH_FAILED'],
    [402, 'QUOTA_EXCEEDED'],
    [429, 'RATE_LIMITED'],
    [408, 'TIMEOUT'],
    [504, 'TIMEOUT'],
    [404, 'MODEL_UNAVAILABLE'],
    [400, 'REQUEST_REJECTED'],
    [409, 'REQUEST_REJECTED'],
    [413, 'REQUEST_REJECTED'],
    [422, 'REQUEST_REJECTED'],
    [500, 'PROVIDER_UNAVAILABLE'],
    [502, 'PROVIDER_UNAVAILABLE'],
    [503, 'PROVIDER_UNAVAILABLE'],
    [529, 'PROVIDER_UNAVAILABLE'],
    [418, 'PROVIDER_UNAVAILABLE'],
    [undefined, 'PROVIDER_UNAVAILABLE'],
  ])('maps HTTP %p to %s for every provider', (status, code) => {
    expect(contentStudioAIErrorCodeForStatus(status)).toBe(code);
  });
});
